import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { ChildProcess } from 'node:child_process';
import { EnrollmentTokenSchema, NodesSchema } from '@privanet/protocol';
import type { Lan } from './netns-rig.js';
import { eventually, netnsUnavailable, sleep, startLan } from './netns-rig.js';

// Separate-host deployment validation (docs/FIRST_DEPLOYMENT.md, docs/DEPLOYMENT_VALIDATION.md): the server and the desktop are two network
// namespaces joined by a virtual cable, each with its own loopback and firewall. The Coordinator, Caddy (real TLS termination with its own CA),
// the PrivaNode and the admin CLI run exactly as shipped, from a staged release directory. Run with `sudo -E npm run test:lan` (Linux, root).
const skip = netnsUnavailable();
const chain = (seed: string, iterations: number) => { let hash = createHash('sha256').update(seed).digest(); for (let i = 0; i < iterations; i++) hash = createHash('sha256').update(hash).digest(); return hash.toString('hex'); };
const serverPolicy = { reserveMemoryBytes: 0, safetyMarginBytes: 0, maxMemoryBytes: 2 * 1024 ** 3, maxCpuPercent: 100, reserveCpuPercent: 0, onBattery: 'normal' };

async function withLan(t: test.TestContext, options: Parameters<typeof startLan>[0] = {}): Promise<Lan> {
  const lan = await startLan(options); t.after(() => lan.stop()); return lan;
}
async function startNode(lan: Lan, name: string, options: { capabilities?: string; policy?: object; enroll?: boolean; slots?: number; env?: NodeJS.ProcessEnv; host?: 'desktop' | 'server'; release?: string } = {}) {
  const host = options.host === 'server' ? lan.server : lan.desktop; const logs: string[] = [];
  const stateDir = join(lan.dir, `node-${name}`); await mkdir(lan.dir, { recursive: true });
  await writeFile(join(lan.dir, `${name}.policy.json`), JSON.stringify(options.policy ?? serverPolicy));
  const capabilities = options.capabilities ?? 'system.echo.v1,system.hashchain.v1';
  const token = options.enroll === false ? undefined : await lan.enrollment(capabilities);
  const env = lan.nodeEnv(name, { PRIVANODE_CAPABILITIES: capabilities, PRIVANODE_POLICY_FILE: join(lan.dir, `${name}.policy.json`), PRIVANODE_JOB_SLOTS: String(options.slots ?? 1),
    ...(token ? { PRIVANODE_ENROLLMENT_TOKEN: token } : {}), ...(options.host === 'server' ? { PRIVANODE_COORDINATOR_URL: lan.url } : {}), ...options.env });
  const child = host.spawn(join(options.release ?? lan.release, 'bin', 'privanet-node'), [], env, logs);
  return { child, logs, stateDir, env, host, count: (event: string) => logs.join('').split(`"event":"${event}"`).length - 1 };
}
const nodeIdOf = async (stateDir: string) => (JSON.parse(await readFile(join(stateDir, 'identity.json'), 'utf8')) as { nodeId: string }).nodeId;
const online = async (lan: Lan, nodeId: string) => (await lan.nodeViews()).find(n => n.nodeId === nodeId)?.status === 'ONLINE' || undefined;
const stopChild = (child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM') => new Promise<void>(resolve => { if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; } child.once('close', () => resolve()); child.kill(signal); });

test('a desktop on another host enrolls over TLS, runs a job, and needs no inbound port', { skip }, async t => {
  const lan = await withLan(t);
  const app = await lan.application('lan-app', 'system.echo.v1,system.hashchain.v1');
  const node = await startNode(lan, 'desk');
  await eventually('the desktop node to enrol', () => node.count('node.enrolled') > 0 || undefined);
  const nodeId = await nodeIdOf(node.stateDir);
  await eventually('the node to be ONLINE', () => online(lan, nodeId));
  const summary = await lan.client(lan.desktop, app.token, { type: 'system.hashchain.v1', inputs: [{ seed: 'lan', iterations: 200000 }], inflight: 1, keyPrefix: 'one' });
  assert.deepEqual(summary.results[0], { digest: chain('lan', 200000), iterations: 200000 });
  // The desktop's firewall admits nothing inbound but replies: the node never needed a listening port. The only socket it listens on is the local control panel, on loopback.
  const listeners = (await lan.desktop.run('sh', ['-c', 'cat /proc/net/tcp /proc/net/tcp6 | awk \'$4=="0A" { print $2 }\''])).split('\n').map(line => line.trim()).filter(Boolean);
  const loopback = (address: string) => address.startsWith('0100007F:') || address.startsWith('00000000000000000000000001000000:');
  assert.deepEqual(listeners.filter(address => !loopback(address)), [], 'the worker host has no listening TCP socket reachable from the network');
  assert.ok(listeners.length <= 1, 'at most the node\'s own loopback-only control panel is listening');
  assert.ok(lan.server.ip !== lan.desktop.ip);
});

test('the LAN is not trusted: TLS is verified, the admin API and the Coordinator\'s own port are unreachable from it, and plain HTTP is refused by the node', { skip }, async t => {
  const lan = await withLan(t);
  const health = await lan.httpsGet(lan.desktop, `${lan.url}/v1/health`);
  assert.ok('status' in health && health.status === 200, `with the local CA the desktop reaches the Coordinator over TLS at the IP address, got ${JSON.stringify(health)}`);
  const unverified = await lan.httpsGet(lan.desktop, `${lan.url}/v1/health`, { ca: false });
  assert.ok('error' in unverified && /CERT|SELF_SIGNED|UNABLE_TO_VERIFY/.test(unverified.error), `without the CA the certificate is rejected, got ${JSON.stringify(unverified)}`);
  const admin = await lan.httpsGet(lan.desktop, `${lan.url}/v1/admin/nodes`, { bearer: lan.adminSecret });
  assert.ok('status' in admin && admin.status === 403, `the admin API is refused at the proxy even with the right secret, got ${JSON.stringify(admin)}`);
  for (const target of ['http://10.77.0.1:4010/v1/health', 'http://10.77.0.1/v1/health', 'http://10.77.0.1:8080/']) {
    const direct = await lan.httpsGet(lan.desktop, target, { timeoutMs: 1500 });
    assert.ok('error' in direct, `${target} must not answer from the LAN, got ${JSON.stringify(direct)}`);
  }
  // A node refuses plain HTTP to a LAN address even when the loopback exception is switched on.
  const plain = await startNode(lan, 'plain', { enroll: false, env: { PRIVANODE_COORDINATOR_URL: 'http://10.77.0.1', PRIVANODE_ALLOW_INSECURE_LOOPBACK: 'true' } });
  await new Promise<void>(resolve => plain.child.once('close', () => resolve()));
  // Refused while the configuration is read: it names the setting and exits 78, which the shipped unit does not restart (no silent restart loop), and never echoes the address.
  assert.equal(plain.count('node.config_invalid'), 1); assert.equal(plain.count('node.startup_failed'), 0); assert.equal(plain.child.exitCode, 78);
  assert.match(plain.logs.join(''), /PRIVANODE_COORDINATOR_URL/); assert.equal(plain.logs.join('').includes('10.77.0.1'), false);
});

test('a node that does not trust the CA never enrols, says why, and leaves the enrollment token unused', { skip }, async t => {
  const lan = await withLan(t);
  const capabilities = 'system.echo.v1'; const token = await lan.enrollment(capabilities);
  const untrusting = await startNode(lan, 'notrust', { enroll: false, capabilities, env: { NODE_EXTRA_CA_CERTS: '', PRIVANODE_ENROLLMENT_TOKEN: token } });
  await eventually('a logged TLS failure', () => untrusting.logs.join('').includes('"reason":"TLS_CERTIFICATE"') || undefined);
  assert.equal(untrusting.child.exitCode, null, 'it keeps retrying instead of crashing'); assert.equal(untrusting.count('node.enrolled'), 0);
  await stopChild(untrusting.child);
  // The same token still works for a node that does trust the CA.
  const trusting = await startNode(lan, 'trust', { enroll: false, capabilities, env: { PRIVANODE_ENROLLMENT_TOKEN: token } });
  await eventually('enrolment with the CA', () => trusting.count('node.enrolled') > 0 || undefined);
});

test('Coordinator outages: a node that starts during one, loses the Coordinator idle or mid-job, and an application all recover with no operator action', { skip, timeout: 240000 }, async t => {
  const lan = await withLan(t, { leaseMs: 3000 });
  const app = await lan.application('outage-app', 'system.echo.v1,system.hashchain.v1');
  const node = await startNode(lan, 'desk'); await eventually('enrolment', () => node.count('node.enrolled') > 0 || undefined);
  const nodeId = await nodeIdOf(node.stateDir); await eventually('online', () => online(lan, nodeId));
  const pid = node.child.pid;
  // Lost while idle (the node is holding a lease request open): it logs, backs off, stays up, and reconnects by itself.
  await lan.stopCoordinator('SIGTERM');
  await eventually('a logged connection failure', () => node.count('node.connection_failed') > 0 || undefined);
  assert.match(node.logs.join(''), /"code":"INVALID_RESPONSE"/, 'a proxy 502 is reported as such, not as a parse error');
  await sleep(1500); assert.equal(node.child.exitCode, null); assert.equal(node.child.pid, pid);
  await lan.startCoordinator();
  await eventually('reconnect', () => online(lan, nodeId), 30000);
  assert.equal(node.child.pid, pid, 'the same process reconnected; nothing restarted it');
  assert.equal(await nodeIdOf(node.stateDir), nodeId, 'same identity');
  // Lost while Caddy (the TLS front) is down: connection refused, reported as such.
  await lan.stopCaddy(); await eventually('a refused connection', () => node.logs.join('').includes('"reason":"CONNECTION_REFUSED"') || undefined, 20000);
  await lan.startCaddy(); await eventually('reconnect after Caddy', async () => Object.hasOwn(await lan.httpsGet(lan.desktop, `${lan.url}/v1/health`), 'status') || undefined);
  await eventually('online again', () => online(lan, nodeId), 30000);
  // Lost in the middle of a job, with an application waiting through the outage on another call: one correct result, no error for the application.
  const work = lan.client(lan.desktop, app.token, { type: 'system.hashchain.v1', inputs: [{ seed: 'outage', iterations: 3_000_000 }], inflight: 1, keyPrefix: 'outage', timeoutMs: 150000 }, 200000);
  await eventually('the job to be running', async () => (await lan.nodeViews()).find(n => n.nodeId === nodeId)?.currentJobs === 1 || undefined, 30000);
  await lan.stopCoordinator('SIGKILL'); await sleep(4000); await lan.startCoordinator();
  const summary = await work;
  assert.equal(summary.errors, 0); assert.deepEqual(summary.results[0], { digest: chain('outage', 3_000_000), iterations: 3_000_000 });
  assert.equal(node.child.pid, pid);
  assert.ok(node.count('job.completed') >= 1);
});

test('identity and state: a node keeps its identity across restarts, a rebuilt Coordinator is refused with exit status 78, and a revoked node stays out', { skip, timeout: 240000 }, async t => {
  const lan = await withLan(t);
  const node = await startNode(lan, 'desk', { capabilities: 'system.echo.v1' }); await eventually('enrolment', () => node.count('node.enrolled') > 0 || undefined);
  const nodeId = await nodeIdOf(node.stateDir); const identity = await readFile(join(node.stateDir, 'identity.json'), 'utf8');
  await stopChild(node.child);
  const again = await startNode(lan, 'desk', { capabilities: 'system.echo.v1', enroll: false });
  await eventually('re-authentication, not re-enrolment', () => again.count('node.authenticated') > 0 || undefined);
  assert.equal(again.count('node.enrolled'), 0); assert.equal(await readFile(join(again.stateDir, 'identity.json'), 'utf8'), identity);
  assert.equal((await lan.nodeViews()).length, 1, 'no second node record');
  // Revoked: refused now and after a Coordinator restart.
  await lan.admin(['revoke-node', nodeId]);
  await eventually('the revoked node to be refused', () => again.logs.join('').includes('UNAUTHORIZED_NODE') || undefined);
  await lan.stopCoordinator(); await lan.startCoordinator(); await sleep(3000);
  assert.notEqual((await lan.nodeViews()).find(n => n.nodeId === nodeId)?.status, 'ONLINE');
  await stopChild(again.child);
  // A Coordinator rebuilt from nothing has a different ID: the node refuses it, stops, and exits with the configuration status.
  const fresh = await startNode(lan, 'fresh', { capabilities: 'system.echo.v1' }); await eventually('enrolment', () => fresh.count('node.enrolled') > 0 || undefined);
  await stopChild(fresh.child); await lan.stopCoordinator(); await rm(join(lan.dir, 'coordinator'), { recursive: true, force: true }); await lan.startCoordinator();
  const rebuilt = await startNode(lan, 'fresh', { capabilities: 'system.echo.v1', enroll: false });
  await new Promise<void>(resolve => rebuilt.child.once('close', () => resolve()));
  assert.equal(rebuilt.child.exitCode, 78); assert.equal(rebuilt.count('node.coordinator_binding_changed'), 1);
});

test('a node that starts while the Coordinator is down waits with backoff, never crashes, and connects when it returns', { skip, timeout: 120000 }, async t => {
  const lan = await withLan(t);
  const first = await startNode(lan, 'desk', { capabilities: 'system.echo.v1' }); await eventually('enrolment', () => first.count('node.enrolled') > 0 || undefined);
  const nodeId = await nodeIdOf(first.stateDir); await stopChild(first.child); await lan.stopCoordinator();
  const node = await startNode(lan, 'desk', { capabilities: 'system.echo.v1', enroll: false });
  await eventually('failures to be logged', () => node.count('node.connection_failed') >= 2 || undefined, 30000);
  const failuresAt = node.count('node.connection_failed'); await sleep(6000);
  assert.equal(node.child.exitCode, null, 'still running'); assert.ok(node.count('node.connection_failed') - failuresAt <= 6, 'backing off, not spinning');
  await lan.startCoordinator(); await eventually('the node to connect', () => node.count('node.authenticated') > 0 || undefined, 60000);
  await eventually('online', () => online(lan, nodeId));
});

test('the shipped operator wrappers work against the shipped example configuration', { skip, timeout: 120000 }, async t => {
  const lan = await withLan(t);
  const envFile = join(lan.dir, 'coordinator.env');
  const example = (await readFile(join(lan.release, 'deploy', 'env', 'coordinator.env.example'), 'utf8')).replace('PRIVANET_ADMIN_SECRET=', `PRIVANET_ADMIN_SECRET=${lan.adminSecret}`)
    .replace('/var/lib/privanet/coordinator', join(lan.dir, 'coordinator'));
  await writeFile(envFile, example);
  const wrapperEnv = { PRIVANET_ENV_FILE: envFile, PRIVANET_HOME: lan.release, PRIVANET_NODE_BIN: process.execPath };
  const nodes = JSON.parse(await lan.server.run(join(lan.release, 'deploy', 'bin', 'privanet-admin'), ['nodes'], wrapperEnv)) as { nodes: unknown[] };
  assert.deepEqual(nodes, { nodes: [] });
  const token = JSON.parse(await lan.server.run(join(lan.release, 'deploy', 'bin', 'privanet-admin'), ['enrollment'], { ...wrapperEnv, PRIVANET_JOB_TYPES: 'system.echo.v1' })) as { token: string };
  assert.match(token.token, /^[a-f0-9]{64}$/);
  const backup = join(lan.dir, 'backups', 'c.sqlite');
  const out = await lan.server.run(join(lan.release, 'deploy', 'bin', 'privanet-backup'), [backup], wrapperEnv);
  assert.match(out, /backup\.created/); assert.ok(existsSync(backup));
  assert.equal(out.includes(lan.adminSecret), false, 'the wrappers never print the secret');
});

test('remote onboarding over TLS: a token from the admin tool, `privanet-node enroll` from another host, a restart with no token, then revocation', { skip, timeout: 180000 }, async t => {
  const lan = await withLan(t); const nodeBin = join(lan.release, 'bin', 'privanet-node'); const app = await lan.application('onboard-app', 'system.echo.v1');
  const created = EnrollmentTokenSchema.parse(await lan.admin(['enrollment', 'create', '--json', '--expires', '10m', '--capabilities', 'system.echo.v1', '--label', 'Remote desk']));
  const tokenFile = join(lan.dir, 'remote.token'); await writeFile(tokenFile, created.token, { mode: 0o600 }); const stateDir = join(lan.dir, 'node-remote');
  const attempt = async (env: NodeJS.ProcessEnv) => {
    try { return { ok: true, out: await lan.desktop.run(nodeBin, ['enroll', '--coordinator', lan.url, '--token-file', tokenFile, '--state-dir', stateDir], env) }; }
    catch (error) { const failure = error as { stdout?: string; stderr?: string }; return { ok: false, out: `${failure.stdout ?? ''}${failure.stderr ?? ''}` }; }
  };
  const status = async () => ((await lan.admin(['enrollment', 'list', '--all', '--json'])) as { tokens: Array<{ status: string }> }).tokens[0]?.status;
  // A machine that does not trust the Coordinator's CA is told so, and the token is left unused.
  const untrusted = await attempt({}); assert.equal(untrusted.ok, false); assert.match(untrusted.out, /TLS certificate is not trusted/); assert.equal(untrusted.out.includes(created.token), false); assert.equal(await status(), 'ACTIVE');
  const enrolled = await attempt({ NODE_EXTRA_CA_CERTS: lan.caCert }); assert.equal(enrolled.ok, true, enrolled.out); assert.match(enrolled.out, /^Enrolled\./); assert.equal(enrolled.out.includes(created.token), false);
  assert.equal(await status(), 'USED'); const nodeId = await nodeIdOf(stateDir);
  // The shipped node starts from nothing but its state directory (and the CA, which a public certificate would not need), and again after a restart.
  for (const start of [1, 2]) {
    const logs: string[] = []; const child = lan.desktop.spawn(nodeBin, [], { NODE_EXTRA_CA_CERTS: lan.caCert, PRIVANODE_STATE_DIR: stateDir, PRIVANODE_HEARTBEAT_MS: '500', PRIVANODE_POLL_MS: '100' }, logs); lan.children.push(child);
    await eventually(`the node to authenticate (start ${start})`, () => logs.join('').includes('"event":"node.authenticated"') || undefined); assert.equal(logs.join('').includes('node.enrolled'), false);
    await eventually('the node to be ONLINE', () => online(lan, nodeId));
    const view = (await lan.nodeViews()).find(node => node.nodeId === nodeId); assert.equal(view?.displayName, 'Remote desk'); assert.deepEqual(view?.capabilities, ['system.echo.v1']);
    const summary = await lan.client(lan.desktop, app.token, { type: 'system.echo.v1', inputs: [{ message: `hello ${start}` }], inflight: 1, keyPrefix: `onboard-${start}` }); assert.deepEqual(summary.results[0], { message: `hello ${start}` });
    if (start === 1) await stopChild(child); else {
      // Revocation reaches a running node at once.
      const revoked = await lan.admin(['nodes', 'revoke', 'Remote desk', '--json']); assert.deepEqual(revoked, { ok: true });
      await eventually('the node to be REVOKED', async () => (await lan.nodeViews()).find(node => node.nodeId === nodeId)?.status === 'REVOKED' || undefined);
      await eventually('the revoked node to be refused', () => /UNAUTHORIZED_NODE/.test(logs.join('')) || undefined);
      const listing = NodesSchema.parse(await lan.admin(['nodes', 'list', '--json'])).nodes[0]; assert.equal(listing?.status, 'REVOKED'); assert.equal(typeof listing?.revokedAt, 'number');
    }
  }
});

// Mixed versions, with the real binaries of an older release (v0.3.0-alpha.2, before lease waits and job slots): the upgrade path in docs/FIRST_DEPLOYMENT.md.
async function oldRelease(): Promise<string | undefined> {
  const fixed = process.env.PRIVANET_OLD_RELEASE_DIR; if (fixed) return fixed;
  const base = join(tmpdir(), 'privanet-old-release'); const dir = join(base, 'privanet-0.3.0-alpha.2-linux');
  if (existsSync(join(dir, 'bin', 'privanet-node'))) return dir;
  try {
    const run = promisify(execFile); await mkdir(base, { recursive: true });
    await run('curl', ['-fsSL', '-o', join(base, 'old.tgz'), 'https://github.com/doopydoop364/PrivaNet-Core/releases/download/v0.3.0-alpha.2/privanet-0.3.0-alpha.2-linux.tar.gz'], { timeout: 120000 });
    await run('tar', ['xzf', join(base, 'old.tgz'), '-C', base]); return existsSync(dir) ? dir : undefined;
  } catch { return undefined; }
}
const old = skip ? undefined : await oldRelease();
const mixedSkip = skip ?? (old ? undefined : 'the older release could not be downloaded (set PRIVANET_OLD_RELEASE_DIR)');

test('mixed versions: a new Coordinator serves an old node, and an old Coordinator serves a new node and a new application', { skip: mixedSkip, timeout: 240000 }, async t => {
  assert.ok(old);
  // New Coordinator, old node: the old node sends plain lease requests and one-slot heartbeats and works unchanged.
  const a = await withLan(t);
  const appA = await a.application('mixed-a', 'system.echo.v1,system.hashchain.v1');
  const oldNode = await startNode(a, 'old', { release: old }); await eventually('old node enrols', () => oldNode.count('node.enrolled') > 0 || undefined);
  const idOld = await nodeIdOf(oldNode.stateDir); await eventually('old node online', () => online(a, idOld));
  const fromOld = await a.client(a.desktop, appA.token, { type: 'system.hashchain.v1', inputs: Array.from({ length: 6 }, (_, i) => ({ seed: `m${i}`, iterations: 50000 })), inflight: 3, keyPrefix: 'mixed-a' });
  assert.equal(fromOld.errors, 0); assert.deepEqual(fromOld.results[5], { digest: chain('m5', 50000), iterations: 50000 }); assert.ok(oldNode.count('job.completed') >= 1);
  await a.stop();
  // Old Coordinator, new node and new SDK: the node falls back to plain polling and one slot, the SDK to plain job reads.
  const b = await withLan(t, { coordinatorRelease: old });
  const appB = await b.application('mixed-b', 'system.echo.v1,system.hashchain.v1');
  const newNode = await startNode(b, 'new', { slots: 4 }); await eventually('new node enrols', () => newNode.count('node.enrolled') > 0 || undefined);
  const idNew = await nodeIdOf(newNode.stateDir); await eventually('new node online', () => online(b, idNew));
  const fromNew = await b.client(b.desktop, appB.token, { type: 'system.hashchain.v1', inputs: Array.from({ length: 6 }, (_, i) => ({ seed: `n${i}`, iterations: 50000 })), inflight: 3, keyPrefix: 'mixed-b' });
  assert.equal(fromNew.errors, 0); assert.deepEqual(fromNew.results[5], { digest: chain('n5', 50000), iterations: 50000 });
  assert.match(newNode.logs.join(''), /node\.(lease_wait_unsupported|job_slots_unsupported)/, 'the new node noticed the old Coordinator and fell back');
  assert.equal(newNode.child.exitCode, null);
});
