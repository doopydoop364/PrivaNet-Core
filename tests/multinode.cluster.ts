import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Cluster, ClusterNode } from './cluster-rig.js';
import { eventually, sleep, startCluster } from './cluster-rig.js';

// Trusted multi-node validation (docs/MULTI_NODE_VALIDATION.md): real Coordinator and PrivaNode processes, one state directory and
// identity per node, driven only through the admin CLI and the SDK. Run with `npm run test:multinode`.

const chain = (seed: string, iterations: number) => { let hash = createHash('sha256').update(seed).digest(); for (let i = 0; i < iterations; i++) hash = createHash('sha256').update(hash).digest(); return hash.toString('hex'); };
async function withCluster(t: test.TestContext, options: Parameters<typeof startCluster>[0]): Promise<Cluster> {
  const cluster = await startCluster(options); t.after(() => cluster.stop()); return cluster;
}
const submitChain = (cluster: Cluster, seed: string, iterations: number) => cluster.client().submit('system.hashchain.v1', { seed, iterations }, `k-${seed}`);
const nodeIdOf = async (node: ClusterNode) => (JSON.parse(await readFile(join(node.stateDir, 'identity.json'), 'utf8')) as { nodeId: string }).nodeId;
const busyNode = async (cluster: Cluster) => (await cluster.nodeViews()).find(node => node.currentJobs > 0);

test('work spreads over every enrolled node and every result is exactly the deterministic answer', async t => {
  const cluster = await withCluster(t, { nodes: ['a', 'b', 'c', 'd'].map(name => ({ name })) });
  const client = cluster.client(); const jobs = [];
  for (let i = 0; i < 40; i++) jobs.push(await client.submit('system.hashchain.v1', { seed: `spread-${i}`, iterations: 150000 }, `spread-${i}`));
  for (const [i, job] of jobs.entries()) assert.deepEqual(await client.waitForResult(job.id, { timeoutMs: 60000 }), { digest: chain(`spread-${i}`, 150000), iterations: 150000 });
  const done = cluster.nodes.map(node => node.count('job.completed'));
  assert.equal(done.reduce((a, b) => a + b, 0), 40, 'each job completed once');
  assert.ok(done.every(n => n > 0), `every node should get work, got ${done.join(',')}`);
});

test('a crashed node (SIGKILL mid-job) loses its lease and the job finishes on another node with a single, correct result', async t => {
  const cluster = await withCluster(t, { nodes: ['a', 'b', 'c'].map(name => ({ name })), leaseMs: 1500 });
  const client = cluster.client(); const job = await submitChain(cluster, 'crash', 2_500_000);
  const victim = await eventually('a node to lease the job', async () => busyNode(cluster));
  const killedAt = Date.now();
  const holders = await Promise.all(cluster.nodes.map(async node => ({ node, id: JSON.parse(await readFile(join(node.stateDir, 'identity.json'), 'utf8')) as { nodeId: string } })));
  const holder = holders.find(h => h.id.nodeId === victim.nodeId); assert.ok(holder);
  await cluster.kill(holder.node.spec.name, 'SIGKILL');
  assert.deepEqual(await client.waitForResult(job.id, { timeoutMs: 60000 }), { digest: chain('crash', 2_500_000), iterations: 2_500_000 });
  const final = await client.getJob(job.id);
  assert.equal(final.status, 'COMPLETED'); assert.ok(final.attempts >= 2, 'the job was retried');
  assert.ok(Date.now() - killedAt < 30000);
  assert.equal(cluster.nodes.reduce((sum, node) => sum + node.count('job.completed'), 0), 1, 'exactly one node reported a result');
  await eventually('the crashed node to be marked not online', async () => (await cluster.nodeViews()).find(n => n.nodeId === victim.nodeId)?.status !== 'ONLINE');
});

test('a Coordinator restart with nodes waiting and jobs running loses no job and needs no operator action', async t => {
  const cluster = await withCluster(t, { nodes: ['a', 'b', 'c'].map(name => ({ name })), leaseMs: 3000 });
  const client = cluster.client(); const jobs = [];
  for (let i = 0; i < 6; i++) jobs.push(await submitChain(cluster, `restart-${i}`, 1_200_000));
  await eventually('jobs to be running', async () => (await cluster.nodeViews()).some(n => n.currentJobs > 0));
  await cluster.stopCoordinator('SIGTERM'); await sleep(500); await cluster.startCoordinator();
  for (const [i, job] of jobs.entries()) assert.deepEqual(await client.waitForResult(job.id, { timeoutMs: 90000 }), { digest: chain(`restart-${i}`, 1_200_000), iterations: 1_200_000 });
  await eventually('all nodes back online', async () => (await cluster.nodeViews()).filter(n => n.status === 'ONLINE').length === 3);
});

test('draining one node lets the others carry on and hands its work back', async t => {
  const cluster = await withCluster(t, { nodes: ['a', 'b', 'c'].map(name => ({ name })) });
  const client = cluster.client(); const jobs = [];
  for (let i = 0; i < 12; i++) jobs.push(await submitChain(cluster, `drain-${i}`, 800_000));
  await eventually('work to start', async () => (await cluster.nodeViews()).some(n => n.currentJobs > 0));
  await cluster.drainNode('a');
  for (const [i, job] of jobs.entries()) assert.deepEqual(await client.waitForResult(job.id, { timeoutMs: 90000 }), { digest: chain(`drain-${i}`, 800_000), iterations: 800_000 });
  const views = await cluster.nodeViews();
  assert.equal(views.filter(n => n.status === 'ONLINE').length, 2);
  assert.equal(cluster.nodes.reduce((sum, node) => sum + node.count('job.completed'), 0), 12);
});

test('a restarted node keeps its identity, comes back online and takes work again', async t => {
  const cluster = await withCluster(t, { nodes: [{ name: 'a' }] });
  const idFile = join(cluster.nodes[0]?.stateDir ?? '', 'identity.json');
  const before = await readFile(idFile, 'utf8'); const nodeId = (JSON.parse(before) as { nodeId: string }).nodeId;
  await cluster.kill('a', 'SIGKILL'); await cluster.startNode('a');
  assert.equal(await readFile(idFile, 'utf8'), before);
  await eventually('the node to be online again', async () => (await cluster.nodeViews()).find(n => n.nodeId === nodeId)?.status === 'ONLINE');
  assert.equal((await cluster.nodeViews()).length, 1, 'no duplicate node record');
  const client = cluster.client(); const job = await client.submit('system.echo.v1', { message: 'again' }, 'again');
  assert.deepEqual(await client.waitForResult(job.id, { timeoutMs: 10000 }), { message: 'again' });
});

test('a zombie node (paused, then resumed after its lease expired and the job moved) cannot corrupt or duplicate the result', { skip: process.platform === 'win32' && 'SIGSTOP does not exist on Windows' }, async t => {
  const cluster = await withCluster(t, { nodes: ['a', 'b'].map(name => ({ name })), leaseMs: 1200 });
  const client = cluster.client(); const job = await submitChain(cluster, 'zombie', 2_000_000);
  const victim = await eventually('a node to lease the job', async () => busyNode(cluster));
  const pairs = await Promise.all(cluster.nodes.map(async node => ({ node, id: await nodeIdOf(node) })));
  const zombie = pairs.find(pair => pair.id === victim.nodeId)?.node; assert.ok(zombie);
  const pid = zombie.process?.pid; assert.ok(pid);
  process.kill(pid, 'SIGSTOP');
  try {
    assert.deepEqual(await client.waitForResult(job.id, { timeoutMs: 60000 }), { digest: chain('zombie', 2_000_000), iterations: 2_000_000 });
  } finally { process.kill(pid, 'SIGCONT'); }
  // The resumed node still believes it holds the lease. Give it time to try to renew and to report; the Coordinator must refuse both.
  const before = await client.getJob(job.id);
  await sleep(4000);
  const after = await client.getJob(job.id);
  assert.deepEqual(after.result, before.result); assert.equal(after.attempts, before.attempts); assert.equal(after.status, 'COMPLETED');
  assert.equal(cluster.nodes.reduce((sum, node) => sum + node.count('job.completed'), 0), 1, 'the zombie\'s late report was not accepted');
  assert.ok(zombie.count('job.lease_lost') + zombie.count('node.connection_failed') >= 1, 'the resumed node was told it no longer holds the lease');
});

test('owner limits and capabilities hold per node in a mixed cluster', async t => {
  const cluster = await withCluster(t, { nodes: [
    { name: 'small', slots: 4, policy: { maxMemoryBytes: 20 * 1024 * 1024 } },
    { name: 'big', slots: 6, policy: { maxMemoryBytes: 1024 ** 3 } },
    { name: 'echo-only', capabilities: 'system.echo.v1', slots: 2 },
  ] });
  const client = cluster.client(); const jobs = [];
  for (let i = 0; i < 24; i++) jobs.push(await submitChain(cluster, `mixed-${i}`, 600_000));
  const peak = new Map<string, number>(); let sampling = true;
  const sampler = (async () => { while (sampling) { for (const view of await cluster.nodeViews()) peak.set(view.nodeId, Math.max(peak.get(view.nodeId) ?? 0, view.currentJobs)); await sleep(50); } })();
  try { for (const [i, job] of jobs.entries()) assert.deepEqual(await client.waitForResult(job.id, { timeoutMs: 120000 }), { digest: chain(`mixed-${i}`, 600_000), iterations: 600_000 }); }
  finally { sampling = false; await sampler; }
  const [small, big, echoOnly] = cluster.nodes; assert.ok(small && big && echoOnly);
  assert.equal(echoOnly.count('job.completed'), 0, 'a node without the capability never receives the job');
  assert.ok((peak.get(await nodeIdOf(small)) ?? 0) <= 1, `the 20 MiB node held ${peak.get(await nodeIdOf(small))} 16 MiB jobs at once`);
  assert.ok((peak.get(await nodeIdOf(big)) ?? 0) <= 6);
  assert.equal(small.count('job.completed') + big.count('job.completed'), 24);
});

test('revoking a node mid-job stops it, and its work finishes elsewhere', async t => {
  const cluster = await withCluster(t, { nodes: ['a', 'b'].map(name => ({ name })), leaseMs: 1500 });
  const client = cluster.client(); const job = await submitChain(cluster, 'revoked', 2_500_000);
  const victim = await eventually('a node to lease the job', async () => busyNode(cluster));
  const { execFile } = await import('node:child_process'); const { promisify } = await import('node:util');
  await promisify(execFile)(process.execPath, ['scripts/admin.mjs', 'revoke-node', victim.nodeId], { cwd: join(import.meta.dirname, '..', '..'), env: { ...process.env, PRIVANET_ADMIN_SECRET: cluster.adminSecret, PRIVANET_COORDINATOR_URL: cluster.url, PRIVANODE_ALLOW_INSECURE_LOOPBACK: 'true' } });
  assert.deepEqual(await client.waitForResult(job.id, { timeoutMs: 60000 }), { digest: chain('revoked', 2_500_000), iterations: 2_500_000 });
  const revoked = (await cluster.nodeViews()).find(n => n.nodeId === victim.nodeId); assert.ok(revoked); assert.notEqual(revoked.status, 'ONLINE');
  assert.equal(cluster.nodes.reduce((sum, node) => sum + node.count('job.completed'), 0), 1);
  const revokedNode = (await Promise.all(cluster.nodes.map(async node => ({ node, id: await nodeIdOf(node) })))).find(pair => pair.id === victim.nodeId)?.node; assert.ok(revokedNode);
  assert.equal(revokedNode.count('job.completed'), 0);
  await eventually('the revoked node to be refused', () => revokedNode.logs.join('').includes('UNAUTHORIZED_NODE'));
});
