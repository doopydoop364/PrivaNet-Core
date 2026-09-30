import { createHash } from 'node:crypto';
import { cpus } from 'node:os';
import { readFile } from 'node:fs/promises';
import { eventually, sleep, startCluster } from './cluster-rig.js';
import type { Cluster } from './cluster-rig.js';

// Manual measurement driver for docs/MULTI_NODE_VALIDATION.md (not part of any test run):
//   node tests/dist/cluster-measure.js throughput|failover|restart
// Real processes on one machine; numbers are indicative, single runs, and depend on the host.

const mode = process.argv[2] ?? 'throughput';
const names = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `n${i}` }));
const chain = (seed: string, iterations: number) => { let hash = createHash('sha256').update(seed).digest(); for (let i = 0; i < iterations; i++) hash = createHash('sha256').update(hash).digest(); return hash.toString('hex'); };

async function throughput(): Promise<void> {
  const total = Number(process.env.MEASURE_JOBS ?? 3000); const inflight = Number(process.env.MEASURE_INFLIGHT ?? 64);
  const slots = Number(process.env.MEASURE_SLOTS ?? 1);
  console.log(`| nodes | slots | jobs | in flight | seconds | jobs/min | per-node completions |\n| --- | --- | --- | --- | --- | --- | --- |`);
  for (const n of (process.env.MEASURE_NODES ?? '1,2,4,8').split(',').map(Number)) {
    const cluster = await startCluster({ nodes: names(n).map(spec => ({ ...spec, slots })), env: { PRIVANET_LEASE_MS: '30000', ...(process.env.MEASURE_PROFILE ? { NODE_OPTIONS: `--cpu-prof --cpu-prof-dir=${process.env.MEASURE_PROFILE}` } : {}) } });
    try {
      const client = cluster.client(); const started = Date.now(); let next = 0; let done = 0;
      const lane = async () => { for (;;) { const i = next++; if (i >= total) return; const job = await client.submit('system.echo.v1', { message: `m${i}` }, `t${i}`); await client.waitForResult(job.id, { timeoutMs: 120000 }); done++; } };
      await Promise.all(Array.from({ length: inflight }, lane));
      const seconds = (Date.now() - started) / 1000;
      console.log(`| ${n} | ${slots} | ${done} | ${inflight} | ${seconds.toFixed(1)} | ${Math.round(done / seconds * 60)} | ${cluster.nodes.map(node => node.count('job.completed')).join('/')}${cluster.nodes.some(node => node.count('node.connection_failed') > 0) ? ` (connection failures: ${cluster.nodes.reduce((sum, node) => sum + node.count('node.connection_failed'), 0)})` : ''} |`);
    } finally { await cluster.stop(); }
  }
}

async function failover(): Promise<void> {
  console.log('| lease ms | crash to re-lease (ms) | crash to completion (s) |\n| --- | --- | --- |');
  for (const leaseMs of (process.env.MEASURE_LEASES ?? '1500,5000,15000').split(',').map(Number)) {
    const cluster = await startCluster({ nodes: names(3), leaseMs, staleMs: leaseMs, offlineMs: leaseMs * 3 });
    try {
      const client = cluster.client(); const job = await client.submit('system.hashchain.v1', { seed: 'f', iterations: 3_000_000 }, 'f');
      const busy = await eventually('lease', async () => (await cluster.nodeViews()).find(v => v.currentJobs > 0), 30000, 50);
      const ids = await Promise.all(cluster.nodes.map(async n => ({ n, id: (JSON.parse(await readFile(`${n.stateDir}/identity.json`, 'utf8')) as { nodeId: string }).nodeId })));
      const crashedAt = Date.now(); await cluster.kill(ids.find(p => p.id === busy.nodeId)?.n.spec.name ?? '', 'SIGKILL');
      let relet = 0; for (;;) { const state = await client.getJob(job.id); if (state.attempts >= 2) { relet = Date.now() - crashedAt; break; } await sleep(25); }
      const result = await client.waitForResult(job.id, { timeoutMs: 120000 });
      if ((result as { digest: string }).digest !== chain('f', 3_000_000)) throw new Error('wrong digest');
      console.log(`| ${leaseMs} | ${relet} | ${((Date.now() - crashedAt) / 1000).toFixed(1)} |`);
    } finally { await cluster.stop(); }
  }
}

async function restart(): Promise<void> {
  const cluster: Cluster = await startCluster({ nodes: names(Number(process.env.MEASURE_NODES ?? 8)) });
  try {
    const client = cluster.client(); await sleep(1000);
    const down = 2000; await cluster.stopCoordinator('SIGTERM'); const stoppedAt = Date.now(); await sleep(down); await cluster.startCoordinator(); const upAt = Date.now();
    const probe = await client.submit('system.echo.v1', { message: 'after' }, 'after'); await client.waitForResult(probe.id, { timeoutMs: 120000 });
    const firstResult = Date.now();
    await eventually('every node online', async () => (await cluster.nodeViews()).filter(v => v.status === 'ONLINE').length === cluster.nodes.length, 120000);
    console.log(`restart with ${cluster.nodes.length} nodes: down ${(down / 1000).toFixed(1)} s, first job done ${((firstResult - upAt) / 1000).toFixed(1)} s after the Coordinator was back, all nodes online ${((Date.now() - upAt) / 1000).toFixed(1)} s after (total outage ${((Date.now() - stoppedAt) / 1000).toFixed(1)} s)`);
  } finally { await cluster.stop(); }
}

async function churn(): Promise<void> {
  const seconds = Number(process.env.MEASURE_SECONDS ?? 60); const nodesN = Number(process.env.MEASURE_NODES ?? 4);
  const cluster = await startCluster({ nodes: names(nodesN), leaseMs: 1500, staleMs: 1000, offlineMs: 3000 });
  try {
    const client = cluster.client(); const end = Date.now() + seconds * 1000; let kills = 0; let submitted = 0; const jobs: { id: string; message: string }[] = [];
    const chaos = (async () => { let turn = 0; while (Date.now() < end) { await sleep(1500); const node = cluster.nodes[turn++ % nodesN]; if (!node) continue; await cluster.kill(node.spec.name, 'SIGKILL'); kills++; await cluster.startNode(node.spec.name); } })();
    const feeder = (async () => { while (Date.now() < end) { const message = `c${submitted}`; const job = await client.submit('system.echo.v1', { message }, `churn-${submitted++}`); jobs.push({ id: job.id, message }); await sleep(20); } })();
    await Promise.all([chaos, feeder]);
    let wrong = 0; let retried = 0; let attempts = 0;
    for (const job of jobs) {
      const result = await client.waitForResult(job.id, { timeoutMs: 120000 }) as { message: string }; if (result.message !== job.message) wrong++;
      const view = await client.getJob(job.id); attempts += view.attempts; if (view.attempts > 1) retried++;
    }
    console.log(`churn ${seconds} s, ${nodesN} nodes, ${kills} SIGKILLs: submitted ${submitted}, completed ${jobs.length - wrong}, wrong results ${wrong}, jobs that needed a retry ${retried}, total attempts ${attempts}`);
  } finally { await cluster.stop(); }
}

console.log(`host: ${cpus().length} CPUs, Node ${process.version}, ${process.platform}`);
await ({ throughput, failover, restart, churn }[mode as 'throughput'] ?? throughput)();
