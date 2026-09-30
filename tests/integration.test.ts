import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { createServer, request as httpRequest } from 'node:http';
import { AckSchema, AppCredentialSchema, CapabilitiesResponseSchema, ChallengeSchema, EnrollmentTokenSchema, HealthSchema, JobSchema, LeaseResponseSchema, NodesSchema, SessionSchema } from '@privanet/protocol';
import { ApiError, secret, Transport } from '@privanet/shared';
import { PrivaNetClient } from '@privanet/sdk';
import { Coordinator } from '@privanet/coordinator/service';
import type { Policy } from '@privanet/coordinator/service';
import { setTimeout as delay } from 'node:timers/promises';
import { SqliteStore } from '@privanet/coordinator/store';
import { createCoordinatorServer } from '@privanet/coordinator/server';
import { PrivaNode } from '@privanet/node/daemon';
import { ResourceEngine } from '@privanet/node/resource-engine';
import { ResourcePolicySchema } from '@privanet/node/resource-policy';
import type { HostSample } from '@privanet/node/resource-sampler';
import { defaultHandlers } from '@privanet/node/handlers';
import { CheckpointStore } from '@privanet/node/checkpoint';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { Handlers } from '@privanet/node/handlers';
import { identity, heartbeat } from './helpers.js';
async function listen(server: Server, port = 0): Promise<string> {
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const address = server.address(); assert(address && typeof address !== 'string'); return `http://127.0.0.1:${address.port}`;
}
async function close(server: Server) {
  await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); });
}
async function fixture(t: TestContext, authRequestsPerMinute = 120, policy: Partial<Policy> = {}, serverOptions: { maxLeaseWaiters?: number; maxJobWaiters?: number } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'privanet-http-')); const db = join(dir, 'coordinator.sqlite');
  const logs: unknown[] = []; const admin = secret(); let store = new SqliteStore(db); let core = new Coordinator(store, policy);
  let server = createCoordinatorServer(core, { adminSecret: admin, log: e => logs.push(e), authRequestsPerMinute, ...serverOptions });
  const url = await listen(server); const transport = new Transport({ url, allowInsecureLoopback: true });
  t.after(async () => { await close(server); store.close(); await rm(dir, { recursive: true, force: true }); });
  return { dir, db, url, transport, admin, logs, get core() { return core; },
    app: (types: string[] = ['system.echo.v1']) => transport.request('POST', '/v1/admin/applications', AppCredentialSchema, { name: 'integration', allowedJobTypes: types }, admin),
    grant: (capabilities: string[] = ['system.echo.v1']) => transport.request('POST', '/v1/admin/enrollment-tokens', EnrollmentTokenSchema, { expiresInMs: 60000, capabilities }, admin),
    async restart() { const port = Number(new URL(url).port); await close(server); store.close(); store = new SqliteStore(db); core = new Coordinator(store, policy); server = createCoordinatorServer(core, { adminSecret: admin, log: e => logs.push(e) }); await listen(server, port); },
  };
}
function errorCode(code: string) { return (e: unknown) => e instanceof ApiError && e.code === code; }

test('SDK → real authenticated local node → typed handler → validated SDK result', async t => {
  const f = await fixture(t); const app = await f.app(); const grant = await f.grant();
  const sdk = new PrivaNetClient({ url: f.url, allowInsecureLoopback: true, token: app.token });
  assert.equal((await sdk.health()).protocolVersion, 1);
  const node = new PrivaNode({ url: f.url, allowInsecureLoopback: true, stateDir: join(f.dir, 'node'), capabilities: ['system.echo.v1'], enrollmentToken: grant.token, log: e => f.logs.push(e) });
  const message = 'hello from application'; const job = await sdk.submit('system.echo.v1', { message }, 'sdk-e2e');
  assert.equal(job.status, 'QUEUED'); await node.tick();
  assert.deepEqual(await sdk.waitForResult(job.id), { message }); assert.equal((await sdk.getJob(job.id)).attempts, 1);
  assert.equal((await sdk.capabilities()).capabilities[0]?.onlineNodes, 1);
  const nodes = await f.transport.request('GET', '/v1/admin/nodes', NodesSchema, undefined, f.admin);
  assert.equal(nodes.nodes[0]?.nodeId, node.status.nodeId); assert.equal(nodes.nodes[0]?.status, 'ONLINE');
  assert.equal((await sdk.submit('system.echo.v1', { message }, 'sdk-e2e')).id, job.id);
  const identity = JSON.parse(await readFile(join(f.dir, 'node', 'identity.json'), 'utf8')) as { privateKey: string };
  const logText = JSON.stringify(f.logs);
  for (const value of [app.token, grant.token, f.admin, identity.privateKey, message]) assert.equal(logText.includes(value), false);
  assert.equal(node.status.currentJobs, 0);
});
test('Coordinator and node restart preserve identity, app scope, results and pending work', async t => {
  const f = await fixture(t); const app = await f.app(); const grant = await f.grant();
  const sdk = new PrivaNetClient({ url: f.url, allowInsecureLoopback: true, token: app.token }); const stateDir = join(f.dir, 'node');
  const node = new PrivaNode({ url: f.url, allowInsecureLoopback: true, stateDir, capabilities: ['system.echo.v1'], enrollmentToken: grant.token });
  const completed = await sdk.submit('system.echo.v1', { message: 'first' }, 'first'); await node.tick();
  const nodeId = node.status.nodeId; const coordinatorId = (await sdk.health()).coordinatorId;
  const pending = await sdk.submit('system.echo.v1', { message: 'after restart' }, 'second'); await f.restart();
  assert.equal((await sdk.health()).coordinatorId, coordinatorId); assert.equal((await sdk.getJob(completed.id)).status, 'COMPLETED');
  const restarted = new PrivaNode({ url: f.url, allowInsecureLoopback: true, stateDir, capabilities: ['system.echo.v1'] }); await restarted.tick();
  assert.equal(restarted.status.nodeId, nodeId); assert.deepEqual(await sdk.waitForResult(pending.id), { message: 'after restart' });
});
test('node with disabled capabilities cannot receive echo jobs or escalate grant', async t => {
  const f = await fixture(t); const app = await f.app(); const grant = await f.grant([]);
  const sdk = new PrivaNetClient({ url: f.url, allowInsecureLoopback: true, token: app.token }); const job = await sdk.submit('system.echo.v1', { message: 'remain queued' }, 'disabled');
  const node = new PrivaNode({ url: f.url, allowInsecureLoopback: true, stateDir: join(f.dir, 'node'), capabilities: [], enrollmentToken: grant.token });
  await node.tick(); assert.equal((await sdk.getJob(job.id)).status, 'QUEUED'); assert.equal((await sdk.capabilities()).capabilities[0]?.onlineNodes, 0);
});
test('HTTP roles, ownership, scoped types, revoked app and node are enforced', async t => {
  const f = await fixture(t); const app = await f.app(); const other = await f.app(); const restricted = await f.app([]);
  await assert.rejects(f.transport.request('GET', '/v1/admin/nodes', NodesSchema, undefined, app.token), errorCode('UNAUTHORIZED_ADMIN'));
  await assert.rejects(f.transport.request('POST', '/v1/node/jobs/lease', LeaseResponseSchema, {}, app.token), errorCode('UNAUTHORIZED_NODE'));
  await assert.rejects(f.transport.request('GET', '/v1/capabilities', CapabilitiesResponseSchema, undefined, f.admin), errorCode('UNAUTHORIZED_APPLICATION'));
  const sdk = new PrivaNetClient({ url: f.url, allowInsecureLoopback: true, token: app.token }); const job = await sdk.submit('system.echo.v1', { message: 'private' }, 'private');
  await assert.rejects(f.transport.request('GET', `/v1/jobs/${job.id}`, JobSchema, undefined, other.token), errorCode('NOT_FOUND'));
  await assert.rejects(f.transport.request('POST', '/v1/jobs', JobSchema, { type: 'system.echo.v1', input: { message: 'x' }, idempotencyKey: 'x' }, restricted.token), errorCode('JOB_TYPE_FORBIDDEN'));
  await f.transport.request('POST', `/v1/admin/applications/${app.applicationId}/revoke`, AckSchema, {}, f.admin);
  await assert.rejects(sdk.getJob(job.id), errorCode('UNAUTHORIZED_APPLICATION'));
  const grant = await f.grant(); const node = new PrivaNode({ url: f.url, allowInsecureLoopback: true, stateDir: join(f.dir, 'node'), capabilities: ['system.echo.v1'], enrollmentToken: grant.token });
  await node.tick(); assert(node.status.nodeId);
  await f.transport.request('POST', `/v1/admin/nodes/${node.status.nodeId}/revoke`, AckSchema, {}, f.admin);
  await assert.rejects(node.tick(), errorCode('UNAUTHORIZED_NODE'));
});
test('HTTP enrollment and authentication reject reused token and replayed proof', async t => {
  const f = await fixture(t); const grant = await f.grant(); const key = identity();
  const enrollment = { token: grant.token, publicKey: key.publicKey, protocolVersion: 1, daemonVersion: '0.1.0', capabilities: ['system.echo.v1'] };
  const challenge = await f.transport.request('POST', '/v1/enrollment/challenge', ChallengeSchema, enrollment);
  const session = await f.transport.request('POST', '/v1/enrollment/proof', SessionSchema, key.proof(challenge));
  await assert.rejects(f.transport.request('POST', '/v1/enrollment/proof', SessionSchema, key.proof(challenge)), errorCode('INVALID_PROOF'));
  await assert.rejects(f.transport.request('POST', '/v1/enrollment/challenge', ChallengeSchema, { ...enrollment, publicKey: identity().publicKey }), errorCode('INVALID_ENROLLMENT'));
  const auth = await f.transport.request('POST', '/v1/auth/challenge', ChallengeSchema, { nodeId: session.nodeId, protocolVersion: 1 });
  const refresh = await f.transport.request('POST', '/v1/auth/proof', SessionSchema, key.proof(auth));
  await assert.rejects(f.transport.request('POST', '/v1/node/heartbeat', AckSchema, heartbeat(), session.token), errorCode('UNAUTHORIZED_NODE'));
  await f.transport.request('POST', '/v1/node/heartbeat', AckSchema, heartbeat(), refresh.token);
  await assert.rejects(f.transport.request('POST', '/v1/jobs', JobSchema, { type: 'system.echo.v1', input: { message: 'no' }, idempotencyKey: 'no' }, refresh.token), errorCode('UNAUTHORIZED_APPLICATION'));
});
test('wire rejects version mismatch, unknown job, unknown fields, bad JSON and large body', async t => {
  const f = await fixture(t); const app = await f.app();
  let response = await fetch(f.url + '/v1/health', { headers: { 'X-PrivaNet-Protocol': '2' } }); assert.equal(response.status, 426);
  const headers = { 'X-PrivaNet-Protocol': '1', Authorization: `Bearer ${app.token}`, 'Content-Type': 'application/json' };
  for (const body of [JSON.stringify({ type: 'run.command.v1', input: { command: 'echo x' }, idempotencyKey: 'x' }), JSON.stringify({ type: 'system.echo.v1', input: { message: 'x' }, idempotencyKey: 'x', shell: true }), '{broken']) {
    response = await fetch(f.url + '/v1/jobs', { method: 'POST', headers, body }); assert.equal(response.status, 400);
  }
  response = await fetch(f.url + '/v1/jobs', { method: 'POST', headers, body: JSON.stringify({ message: 'x'.repeat(33000) }) }); assert.equal(response.status, 413);
  response = await fetch(f.url + '/v1/jobs', { method: 'POST', headers: { ...headers, 'Content-Type': 'text/plain' }, body: '{}' }); assert.equal(response.status, 415);
  const allLogs = JSON.stringify(f.logs); assert.equal(allLogs.includes(app.token), false); assert.equal(allLogs.includes('echo x'), false);
});
test('unauthorized enrollment challenges are rate limited', async t => {
  const f = await fixture(t, 2);
  const request = { token: secret(), publicKey: identity().publicKey, protocolVersion: 1, daemonVersion: '0.1.0', capabilities: [] };
  await assert.rejects(f.transport.request('POST', '/v1/enrollment/challenge', ChallengeSchema, request), errorCode('INVALID_ENROLLMENT'));
  await assert.rejects(f.transport.request('POST', '/v1/enrollment/challenge', ChallengeSchema, request), errorCode('INVALID_ENROLLMENT'));
  await assert.rejects(f.transport.request('POST', '/v1/enrollment/challenge', ChallengeSchema, request), errorCode('RATE_LIMIT'));
});
test('SDK polling supports timeout, cancellation and terminal job errors', async t => {
  const f = await fixture(t); const app = await f.app(); const sdk = new PrivaNetClient({ url: f.url, allowInsecureLoopback: true, token: app.token });
  const job = await sdk.submit('system.echo.v1', { message: 'queued' }, 'timeout');
  await assert.rejects(sdk.waitForResult(job.id, { timeoutMs: 10, pollMs: 2 }), errorCode('WAIT_TIMEOUT'));
  const abort = new AbortController(); abort.abort(); await assert.rejects(sdk.waitForResult(job.id, { signal: abort.signal }));
  const key = identity(); const grant = await f.grant(); const challenge = await f.transport.request('POST', '/v1/enrollment/challenge', ChallengeSchema, { token: grant.token, publicKey: key.publicKey, protocolVersion: 1, daemonVersion: '0.1.0', capabilities: ['system.echo.v1'] });
  const node = await f.transport.request('POST', '/v1/enrollment/proof', SessionSchema, key.proof(challenge));
  await f.transport.request('POST', '/v1/node/heartbeat', AckSchema, heartbeat(), node.token);
  const { lease } = await f.transport.request('POST', '/v1/node/jobs/lease', LeaseResponseSchema, {}, node.token); assert(lease);
  await f.transport.request('POST', `/v1/node/jobs/${lease.jobId}/fail`, AckSchema, { leaseId: lease.leaseId, error: { code: 'HANDLER_FAILED' } }, node.token);
  await assert.rejects(sdk.waitForResult(job.id), errorCode('HANDLER_FAILED'));
});
test('bearer is rechecked after body arrives so a revoked app cannot submit', async t => {
  const f = await fixture(t); const app = await f.app();
  const outcome = new Promise<number>((resolve, reject) => {
    const req = httpRequest(f.url + '/v1/jobs', { method: 'POST', headers: { 'X-PrivaNet-Protocol': '1', 'Content-Type': 'application/json', Authorization: `Bearer ${app.token}` } }, res => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on('error', reject); req.write('{');
    setTimeout(() => { f.core.revokeApplication(app.applicationId); req.end('"type":"system.echo.v1","input":{"message":"race"},"idempotencyKey":"race"}'); }, 10);
  });
  assert.equal(await outcome, 401);
});
test('transport refuses redirects and bounds response bytes and time', async t => {
  const server = createServer((req, res) => {
    if (req.url === '/v1/redirect') { res.writeHead(302, { Location: 'http://example.org' }); res.end(); }
    else if (req.url === '/v1/large') { res.writeHead(200, { 'X-PrivaNet-Protocol': '1' }); res.end('x'.repeat(600000)); }
    else if (req.url === '/v1/slow') { /* transport timeout cancels this request */ }
    else { res.writeHead(200, { 'X-PrivaNet-Protocol': '2' }); res.end('{}'); }
  });
  const url = await listen(server); t.after(() => close(server)); const transport = new Transport({ url, allowInsecureLoopback: true, timeoutMs: 100 });
  await assert.rejects(transport.request('GET', '/v1/redirect', HealthSchema));
  await assert.rejects(transport.request('GET', '/v1/large', HealthSchema), /Response too large/);
  await assert.rejects(transport.request('GET', '/v1/slow', HealthSchema));
  await assert.rejects(transport.request('GET', '/v1/wrong-version', HealthSchema), errorCode('PROTOCOL_MISMATCH'));
  await assert.rejects(transport.request('GET', '//example.org', HealthSchema), /Invalid API path/);
});

test('real HTTP leases survive restart, expire, fence old results and move to another node', async t => {
  const f = await fixture(t, 120, { leaseMs: 150, maxAttempts: 2 }); const app = await f.app();
  const sdk = new PrivaNetClient({ url: f.url, allowInsecureLoopback: true, token: app.token });
  const job = await sdk.submit('system.echo.v1', { message: 'retry safely' }, 'recovery');
  const grant = await f.grant(); const key = identity();
  const challenge = await f.transport.request('POST', '/v1/enrollment/challenge', ChallengeSchema, { token: grant.token, publicKey: key.publicKey, protocolVersion: 1, daemonVersion: '0.1.0', capabilities: ['system.echo.v1'] });
  const session = await f.transport.request('POST', '/v1/enrollment/proof', SessionSchema, key.proof(challenge));
  await f.transport.request('POST', '/v1/node/heartbeat', AckSchema, heartbeat(), session.token);
  const { lease } = await f.transport.request('POST', '/v1/node/jobs/lease', LeaseResponseSchema, {}, session.token); assert(lease);
  await f.restart();
  await delay(Math.max(0, lease.expiresAt - Date.now()) + 5);
  await assert.rejects(f.transport.request('POST', `/v1/node/jobs/${job.id}/complete`, AckSchema, { leaseId: lease.leaseId, result: { message: 'too late' } }, session.token), errorCode('LEASE_CONFLICT'));
  assert.equal((await sdk.getJob(job.id)).status, 'QUEUED');
  const replacement = await f.grant();
  const node = new PrivaNode({ url: f.url, allowInsecureLoopback: true, stateDir: join(f.dir, 'replacement'), capabilities: ['system.echo.v1'], enrollmentToken: replacement.token });
  await node.tick(); assert.notEqual(node.status.nodeId, session.nodeId);
  assert.deepEqual(await sdk.waitForResult(job.id), { message: 'retry safely' }); assert.equal((await sdk.getJob(job.id)).attempts, 2);
  await assert.rejects(f.transport.request('POST', `/v1/node/jobs/${job.id}/complete`, AckSchema, { leaseId: lease.leaseId, result: { message: 'too late' } }, session.token), errorCode('LEASE_CONFLICT'));
});
test('concurrent authenticated polls cannot lease the same job twice', async t => {
  const f = await fixture(t); const app = await f.app();
  const sdk = new PrivaNetClient({ url: f.url, allowInsecureLoopback: true, token: app.token });
  const tokens: string[] = [];
  for (let i = 0; i < 2; i++) {
    const grant = await f.grant(); const key = identity();
    const challenge = await f.transport.request('POST', '/v1/enrollment/challenge', ChallengeSchema, { token: grant.token, publicKey: key.publicKey, protocolVersion: 1, daemonVersion: '0.1.0', capabilities: ['system.echo.v1'] });
    const session = await f.transport.request('POST', '/v1/enrollment/proof', SessionSchema, key.proof(challenge));
    await f.transport.request('POST', '/v1/node/heartbeat', AckSchema, heartbeat(), session.token); tokens.push(session.token);
  }
  const job = await sdk.submit('system.echo.v1', { message: 'one owner' }, 'concurrent');
  const leases = await Promise.all(tokens.map(token => f.transport.request('POST', '/v1/node/jobs/lease', LeaseResponseSchema, {}, token)));
  assert.equal(leases.filter(response => response.lease?.jobId === job.id).length, 1);
  assert.equal(leases.filter(response => response.lease === null).length, 1);
  assert.equal((await sdk.getJob(job.id)).attempts, 1);
});
test('application credential rotation keeps identity and job ownership, kills the old credential, needs admin', async t => {
  const f = await fixture(t); const app = await f.app();
  const old = new PrivaNetClient({ url: f.url, allowInsecureLoopback: true, token: app.token });
  const job = await old.submit('system.echo.v1', { message: 'kept' }, 'rotation');
  await assert.rejects(f.transport.request('POST', `/v1/admin/applications/${app.applicationId}/rotate`, AppCredentialSchema, {}, app.token), errorCode('UNAUTHORIZED_ADMIN'));
  const rotated = await f.transport.request('POST', `/v1/admin/applications/${app.applicationId}/rotate`, AppCredentialSchema, {}, f.admin);
  assert.equal(rotated.applicationId, app.applicationId); assert.notEqual(rotated.token, app.token);
  await assert.rejects(old.getJob(job.id), errorCode('UNAUTHORIZED_APPLICATION'));
  const fresh = new PrivaNetClient({ url: f.url, allowInsecureLoopback: true, token: rotated.token });
  assert.equal((await fresh.getJob(job.id)).id, job.id);
  assert.equal((await fresh.submit('system.echo.v1', { message: 'kept' }, 'rotation')).id, job.id);
  await f.transport.request('POST', `/v1/admin/applications/${app.applicationId}/revoke`, AckSchema, {}, f.admin);
  await assert.rejects(f.transport.request('POST', `/v1/admin/applications/${app.applicationId}/rotate`, AppCredentialSchema, {}, f.admin), errorCode('NOT_FOUND'));
  assert.equal(JSON.stringify(f.logs).includes(rotated.token), false);
});

const GiB = 1024 ** 3;
function engineRig(overrides: Record<string, unknown> = {}) {
  const host: HostSample = { availableMemoryBytes: 12 * GiB, ownerCpuPercent: 5, power: 'AC' };
  let now = Date.now();
  // Each read moves the fake clock forward so smoothing settles within a couple of samples.
  const engine = new ResourceEngine(ResourcePolicySchema.parse({ maxMemoryBytes: 8 * GiB, preemptAfterMs: 0, ...overrides }), { sample: () => ({ ...host }) }, () => (now += 20000));
  return { engine, host };
}
async function enrolled(f: Awaited<ReturnType<typeof fixture>>, extra: Partial<ConstructorParameters<typeof PrivaNode>[0]> = {}, name = 'node') {
  const grant = await f.grant();
  return new PrivaNode({ url: f.url, allowInsecureLoopback: true, stateDir: join(f.dir, name), capabilities: ['system.echo.v1'], enrollmentToken: grant.token, log: e => f.logs.push(e), ...extra });
}

test('node reports its permitted budget; the owner pausing contribution stops new work, resuming restarts it', async t => {
  const f = await fixture(t); const app = await f.app(); const rig = engineRig({ onBattery: 'disable' });
  const sdk = new PrivaNetClient({ url: f.url, allowInsecureLoopback: true, token: app.token });
  const node = await enrolled(f, { engine: rig.engine }); const job = await sdk.submit('system.echo.v1', { message: 'owner first' }, 'owner');
  rig.host.power = 'BATTERY'; await node.tick();
  assert.equal((await sdk.getJob(job.id)).status, 'QUEUED');
  const paused = (await f.transport.request('GET', '/v1/admin/nodes', NodesSchema, undefined, f.admin)).nodes[0];
  assert.equal(paused?.resources?.contribution, 'PAUSED'); assert.equal(paused?.resources?.memoryBudgetBytes, 0); assert.equal(paused?.status, 'ONLINE');
  rig.host.power = 'AC'; await node.tick(); await node.tick();
  assert.deepEqual(await sdk.waitForResult(job.id), { message: 'owner first' });
  const running = (await f.transport.request('GET', '/v1/admin/nodes', NodesSchema, undefined, f.admin)).nodes[0];
  assert.equal(running?.resources?.contribution, 'ADAPTIVE'); assert.equal(running?.resources?.memoryBudgetBytes, 8 * GiB);
  assert.equal(JSON.stringify(f.logs).includes('owner first'), false);
});

test('draining node announces DRAINING and receives no work; graceful stop says goodbye (OFFLINE_EXPECTED)', async t => {
  const f = await fixture(t); const app = await f.app();
  const sdk = new PrivaNetClient({ url: f.url, allowInsecureLoopback: true, token: app.token });
  const node = await enrolled(f, { heartbeatMs: 1, pollMs: 5 }); await node.tick();
  node.drain(); const job = await sdk.submit('system.echo.v1', { message: 'later' }, 'drain');
  await node.tick(); assert.equal((await sdk.getJob(job.id)).status, 'QUEUED');
  assert.equal((await f.transport.request('GET', '/v1/admin/nodes', NodesSchema, undefined, f.admin)).nodes[0]?.status, 'DRAINING');
  assert.equal((await sdk.capabilities()).capabilities[0]?.onlineNodes, 0);
  const stopper = new AbortController(); const other = await enrolled(f, { heartbeatMs: 1, pollMs: 5 }, 'second');
  const running = other.run(stopper.signal); await delay(100); stopper.abort(); await running;
  const states = (await f.transport.request('GET', '/v1/admin/nodes', NodesSchema, undefined, f.admin)).nodes.map(n => n.status).sort();
  assert.deepEqual(states, ['DRAINING', 'OFFLINE_EXPECTED']);
  assert.equal(f.logs.some(e => (e as { event: string }).event === 'node.departed'), true);
});

test('sustained pressure preempts a preemptible job: it is released, not failed, and another node finishes it', async t => {
  const f = await fixture(t); const app = await f.app(); const rig = engineRig();
  const sdk = new PrivaNetClient({ url: f.url, allowInsecureLoopback: true, token: app.token });
  let started!: () => void; const begun = new Promise<void>(resolve => { started = resolve; });
  const blocking: Handlers = { ...defaultHandlers, 'system.echo.v1': (_input, { signal }) => new Promise((_resolve, reject) => { started(); signal.addEventListener('abort', () => reject(new Error('aborted'))); }) };
  const first = await enrolled(f, { engine: rig.engine, handlers: blocking, preemptCheckMs: 5 }, 'first');
  const job = await sdk.submit('system.echo.v1', { message: 'squeezed' }, 'preempt');
  const ticking = first.tick(); await begun;
  assert.equal((await sdk.getJob(job.id)).status, 'LEASED');
  rig.host.availableMemoryBytes = 1 * GiB; await ticking;
  const released = await sdk.getJob(job.id);
  assert.equal(released.status, 'QUEUED'); assert.equal(released.attempts, 0); assert.equal(released.error, null);
  assert.equal(f.logs.some(e => (e as { event: string }).event === 'job.released'), true);
  const second = await enrolled(f, {}, 'second'); await second.tick();
  assert.deepEqual(await sdk.waitForResult(job.id), { message: 'squeezed' });
});

test('forced shutdown hands the running job back with reason SHUTDOWN instead of failing it', async t => {
  const f = await fixture(t); const app = await f.app();
  const sdk = new PrivaNetClient({ url: f.url, allowInsecureLoopback: true, token: app.token });
  let started!: () => void; const begun = new Promise<void>(resolve => { started = resolve; });
  const blocking: Handlers = { ...defaultHandlers, 'system.echo.v1': (_input, { signal }) => new Promise((_resolve, reject) => { started(); signal.addEventListener('abort', () => reject(new Error('aborted'))); }) };
  const node = await enrolled(f, { handlers: blocking }); const job = await sdk.submit('system.echo.v1', { message: 'stop' }, 'shutdown');
  const ticking = node.tick(); await begun; node.abortNow(); await ticking;
  const after = await sdk.getJob(job.id); assert.equal(after.status, 'QUEUED'); assert.equal(after.attempts, 0);
});

test('node HTTP: release and goodbye need node credentials and reject malformed bodies', async t => {
  const f = await fixture(t); const app = await f.app();
  await assert.rejects(f.transport.request('POST', '/v1/node/goodbye', AckSchema, { reason: 'SHUTDOWN' }, app.token), errorCode('UNAUTHORIZED_NODE'));
  await assert.rejects(f.transport.request('POST', `/v1/node/jobs/${'0'.repeat(8)}-0000-4000-8000-000000000000/release`, AckSchema, { leaseId: 'x', reason: 'DRAINING' }, app.token), errorCode('UNAUTHORIZED_NODE'));
  await assert.rejects(f.transport.request('POST', '/v1/node/goodbye', AckSchema, { reason: 'SHUTDOWN' }, f.admin), errorCode('UNAUTHORIZED_NODE'));
});

test('a preempted checkpointable job is released, then resumed from its checkpoint by the same node and completes with the right digest', async t => {
  const f = await fixture(t); const app = await f.app(['system.hashchain.v1']); const rig = engineRig();
  rig.host.freeDiskBytes = 100 * GiB; // the hash-chain job declares scratch disk, so the node must report some
  const sdk = new PrivaNetClient({ url: f.url, allowInsecureLoopback: true, token: app.token });
  const checkpoints = new CheckpointStore(join(f.dir, 'checkpoints')); const iterations = 3_000_000;
  const grant = await f.grant(['system.hashchain.v1']);
  const node = new PrivaNode({ url: f.url, allowInsecureLoopback: true, stateDir: join(f.dir, 'node'), capabilities: ['system.hashchain.v1'], enrollmentToken: grant.token,
    log: e => f.logs.push(e), engine: rig.engine, checkpoints, preemptCheckMs: 5 });
  const job = await sdk.submit('system.hashchain.v1', { seed: 'resume me', iterations }, 'resume');
  const ticking = node.tick();
  const file = join(f.dir, 'checkpoints', `${job.id}.json`);
  for (let i = 0; i < 200 && !existsSync(file); i++) await delay(25); // the handler has made real progress once it has checkpointed
  assert.equal((await sdk.getJob(job.id)).status, 'LEASED');
  rig.host.availableMemoryBytes = 1 * GiB; await ticking; // sustained pressure: handed back, not failed
  const released = await sdk.getJob(job.id); assert.equal(released.status, 'QUEUED'); assert.equal(released.attempts, 0);
  const partial = (JSON.parse(await readFile(file, 'utf8')) as { state: { done: number } }).state.done;
  assert.ok(partial > 0 && partial < iterations, `checkpoint should hold partial progress, got ${partial}`);
  rig.host.availableMemoryBytes = 12 * GiB; await node.tick(); await node.tick();
  let h = createHash('sha256').update('resume me').digest(); for (let i = 0; i < iterations; i++) h = createHash('sha256').update(h).digest();
  assert.deepEqual(await sdk.waitForResult(job.id, { timeoutMs: 20000 }), { digest: h.toString('hex'), iterations });
  await assert.rejects(() => readFile(file, 'utf8')); // cleared once the result was accepted
});

test('a job that outlasts many leases finishes on its first attempt because the node renews the lease', async t => {
  const f = await fixture(t, 120, { leaseMs: 1000 }); const app = await f.app(['system.hashchain.v1']); const rig = engineRig();
  rig.host.freeDiskBytes = 100 * GiB;
  const sdk = new PrivaNetClient({ url: f.url, allowInsecureLoopback: true, token: app.token }); const iterations = 3_000_000;
  const grant = await f.grant(['system.hashchain.v1']);
  const node = new PrivaNode({ url: f.url, allowInsecureLoopback: true, stateDir: join(f.dir, 'node'), capabilities: ['system.hashchain.v1'], enrollmentToken: grant.token, log: e => f.logs.push(e), engine: rig.engine });
  const job = await sdk.submit('system.hashchain.v1', { seed: 'lease', iterations }, 'lease');
  const started = Date.now(); await node.tick(); const took = Date.now() - started;
  assert.ok(took > 1200, `the job must outlast a 1000 ms lease (took ${took} ms)`);
  const done = await sdk.getJob(job.id); assert.equal(done.status, 'COMPLETED'); assert.equal(done.attempts, 1);
  let h = createHash('sha256').update('lease').digest(); for (let i = 0; i < iterations; i++) h = createHash('sha256').update(h).digest();
  assert.deepEqual(done.result, { digest: h.toString('hex'), iterations });
});

test('a busy node polls again at once after finishing a job, so throughput is not capped at one job per poll interval', async t => {
  const f = await fixture(t); const app = await f.app();
  const sdk = new PrivaNetClient({ url: f.url, allowInsecureLoopback: true, token: app.token });
  const node = await enrolled(f, { pollMs: 3000, heartbeatMs: 1000 }); // a 3 s interval would need 60 s for 20 jobs if it slept after each one
  const jobs = []; for (let i = 0; i < 20; i++) jobs.push(await sdk.submit('system.echo.v1', { message: `m${i}` }, `busy-${i}`));
  const abort = new AbortController(); const running = node.run(abort.signal); const started = Date.now();
  try {
    await Promise.all(jobs.map(job => sdk.waitForResult(job.id, { timeoutMs: 10000, pollMs: 20 })));
    const took = Date.now() - started; assert.ok(took < 6000, `20 queued jobs took ${took} ms with a 3000 ms poll interval`);
  } finally { abort.abort(); await running; } // never leave the node polling if the assertion fails
});


test('a lease request can wait for work: the job is picked up the moment it is submitted, not at the next poll; an idle wait ends at its deadline', { timeout: 30000 }, async t => {
  const f = await fixture(t); const app = await f.app(); const sdk = new PrivaNetClient({ url: f.url, allowInsecureLoopback: true, token: app.token });
  const idle = await enrolled(f, { leaseWaitMs: 400, heartbeatMs: 5000 }, 'idle');
  const idleStart = Date.now(); await idle.tick(); const idleMs = Date.now() - idleStart;
  assert.ok(idleMs >= 350 && idleMs < 2500, `an idle wait ended after ${idleMs} ms, expected about 400`);
  const node = await enrolled(f, { leaseWaitMs: 4000, heartbeatMs: 5000 }, 'waiter'); await node.tick(); // enroll and connect; the queue is empty, so this waits out the deadline
  const waiting = node.tick(); await new Promise(resolve => setTimeout(resolve, 200));
  const started = Date.now(); const job = await sdk.submit('system.echo.v1', { message: 'now' }, 'wake');
  await waiting; const pickup = Date.now() - started;
  assert.ok(pickup < 1500, `the waiting node took ${pickup} ms to pick up a new job`); assert.equal((await sdk.getJob(job.id)).status, 'COMPLETED');
});

test('waitMs is strict and bounded; a plain empty body still works, so older nodes are unaffected', async t => {
  const f = await fixture(t); const grant = await f.grant();
  const node = new PrivaNode({ url: f.url, allowInsecureLoopback: true, stateDir: join(f.dir, 'strict'), capabilities: ['system.echo.v1'], enrollmentToken: grant.token }); await node.tick();
  // Authenticate as this node by hand to send raw lease bodies.
  const { session } = node as unknown as { session: { token: string } };
  for (const body of [{ waitMs: 8001 }, { waitMs: -1 }, { waitMs: 1.5 }, { waitMs: '5' }, { waitMs: 1, extra: true }, { extra: 1 }])
    await assert.rejects(f.transport.request('POST', '/v1/node/jobs/lease', LeaseResponseSchema, body, session.token), errorCode('INVALID_REQUEST'), JSON.stringify(body));
  assert.deepEqual(await f.transport.request('POST', '/v1/node/jobs/lease', LeaseResponseSchema, {}, session.token), { lease: null });
  assert.deepEqual(await f.transport.request('POST', '/v1/node/jobs/lease', LeaseResponseSchema, { waitMs: 0 }, session.token), { lease: null });
});

test('a waiting lease is never handed to a node that disconnected or was revoked, and a drain wakes an idle wait at once', { timeout: 30000 }, async t => {
  const f = await fixture(t); const app = await f.app(); const sdk = new PrivaNetClient({ url: f.url, allowInsecureLoopback: true, token: app.token });
  // Drain: the idle wait is aborted immediately; nothing is leased afterwards.
  const draining = await enrolled(f, { leaseWaitMs: 4000, heartbeatMs: 5000 }, 'draining'); await draining.tick();
  const idleWait = draining.tick(); await new Promise(resolve => setTimeout(resolve, 150)); const t0 = Date.now(); draining.drain(); await idleWait;
  assert.ok(Date.now() - t0 < 1000, 'a drain must not wait out the lease deadline');
  await new Promise(resolve => setTimeout(resolve, 100)); // let the Coordinator observe the closed connection (a job submitted in the same instant as a disconnect can be leased to the dead connection; the lease then simply expires)
  const job = await sdk.submit('system.echo.v1', { message: 'stay queued' }, 'after-drain'); await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal((await sdk.getJob(job.id)).status, 'QUEUED', 'a drained (disconnected) waiter must not take the job');
  // Revocation while waiting: the credential is re-checked on wake, so the revoked node gets 401, not the job.
  const doomed = await enrolled(f, { leaseWaitMs: 4000, heartbeatMs: 5000 }, 'doomed'); await doomed.tick();
  const nodeId = (doomed.status as { nodeId: string | null }).nodeId; assert.ok(nodeId);
  const pending = doomed.tick().then(() => 'ok' as const, (error: unknown) => error); await new Promise(resolve => setTimeout(resolve, 150));
  await f.transport.request('POST', `/v1/admin/nodes/${nodeId}/revoke`, AckSchema, {}, f.admin);
  await sdk.submit('system.echo.v1', { message: 'to the revoked node' }, 'after-revoke');
  const outcome = await pending; assert.ok(outcome !== 'ok' && errorCode('UNAUTHORIZED_NODE')(outcome), `a revoked waiter must fail with 401, got ${String(outcome)}`);
});

test('the number of held-open lease requests is bounded: over the bound a request is answered at once like a plain poll', async t => {
  const f = await fixture(t, 120, {}, { maxLeaseWaiters: 0 }); const grant = await f.grant();
  const node = new PrivaNode({ url: f.url, allowInsecureLoopback: true, stateDir: join(f.dir, 'cap'), capabilities: ['system.echo.v1'], enrollmentToken: grant.token, leaseWaitMs: 4000, heartbeatMs: 5000 });
  await node.tick(); const started = Date.now(); await node.tick(); assert.ok(Date.now() - started < 1500, 'with no waiter capacity the request returns at once');
});

test('against an older Coordinator that rejects waitMs, the node falls back to plain polling and keeps working', async t => {
  const f = await fixture(t); const app = await f.app(); const sdk = new PrivaNetClient({ url: f.url, allowInsecureLoopback: true, token: app.token });
  // A proxy that behaves like v0.3.0-alpha.2: a lease body other than {} is a 400.
  const proxy = createServer((req, res) => {
    const chunks: Buffer[] = []; req.on('data', (c: Buffer) => chunks.push(c)); req.on('end', () => { void (async () => {
      const body = Buffer.concat(chunks);
      if (req.url === '/v1/node/jobs/lease' && body.toString() !== '{}') { res.writeHead(400, { 'Content-Type': 'application/json', 'X-PrivaNet-Protocol': '1' }); res.end(JSON.stringify({ error: { code: 'INVALID_REQUEST', message: 'expected empty object' } })); return; }
      const upstream = await fetch(f.url + (req.url ?? ''), { method: req.method ?? 'GET', headers: Object.fromEntries(Object.entries(req.headers).filter(([k]) => ['content-type', 'authorization', 'x-privanet-protocol'].includes(k)).map(([k, v]) => [k, String(v)])), ...(req.method === 'POST' ? { body } : {}) });
      const text = await upstream.text(); res.writeHead(upstream.status, { 'Content-Type': 'application/json', 'X-PrivaNet-Protocol': '1' }); res.end(text);
    })(); });
  });
  const proxyUrl = await listen(proxy); t.after(() => close(proxy));
  const grant = await f.grant(); const events: string[] = [];
  const node = new PrivaNode({ url: proxyUrl, allowInsecureLoopback: true, stateDir: join(f.dir, 'old'), capabilities: ['system.echo.v1'], enrollmentToken: grant.token, leaseWaitMs: 300, heartbeatMs: 5000, log: e => events.push(e.event) });
  await node.tick(); assert.ok(events.includes('node.lease_wait_unsupported'), 'the node noticed and stopped asking');
  const job = await sdk.submit('system.echo.v1', { message: 'old coordinator' }, 'compat'); await node.tick();
  assert.equal((await sdk.getJob(job.id)).status, 'COMPLETED');
});

test('waiting for a job result: the read returns the moment the job finishes, and the SDK needs no polling to notice', { timeout: 30000 }, async t => {
  const f = await fixture(t); const app = await f.app(); const sdk = new PrivaNetClient({ url: f.url, allowInsecureLoopback: true, token: app.token });
  const node = await enrolled(f, { leaseWaitMs: 0 }); await node.tick();
  const job = await sdk.submit('system.echo.v1', { message: 'wait for me' }, 'job-wait');
  const started = Date.now(); const waiting = sdk.waitForResult(job.id, { timeoutMs: 20000, pollMs: 10000 }); // a poll interval this long would take 10 s if the SDK still polled
  await delay(300); await node.tick(); // completes the job while the read is held open
  assert.deepEqual(await waiting, { message: 'wait for me' }); const took = Date.now() - started;
  assert.ok(took < 3000, `the result arrived after ${took} ms with a 10 s poll interval`);
  // A finished job is answered at once even when a wait is requested.
  const before = Date.now(); assert.equal((await sdk.getJob(job.id, undefined, 5000)).status, 'COMPLETED'); assert.ok(Date.now() - before < 1000);
  // A wait that ends unfinished returns the job as it is, not an error.
  const idle = await sdk.submit('system.echo.v1', { message: 'nobody takes this' }, 'job-idle'); const t0 = Date.now();
  const still = await sdk.getJob(idle.id, undefined, 300); assert.equal(still.status, 'QUEUED'); assert.ok(Date.now() - t0 >= 250 && Date.now() - t0 < 2000);
});

test('the job wait query is strict, owner-only, bounded, re-authenticated on wake, and released when the client leaves', { timeout: 30000 }, async t => {
  const f = await fixture(t, 120, {}, { maxJobWaiters: 1 }); const app = await f.app(); const other = await f.app();
  const sdk = new PrivaNetClient({ url: f.url, allowInsecureLoopback: true, token: app.token }); const stranger = new PrivaNetClient({ url: f.url, allowInsecureLoopback: true, token: other.token });
  const job = await sdk.submit('system.echo.v1', { message: 'mine' }, 'strict-1');
  // Unknown or malformed query strings are unknown routes or bad requests, never silently ignored.
  await assert.rejects(f.transport.request('GET', `/v1/jobs/${job.id}?waitMs=9000` as `/v1/${string}`, JobSchema, undefined, app.token), errorCode('INVALID_REQUEST'));
  for (const bad of ['?wait=5', '?waitMs=abc', '?waitMs=', '?waitMs=5&x=1', '?x=1']) await assert.rejects(new Transport({ url: f.url, allowInsecureLoopback: true }).request('GET', `/v1/jobs/${job.id}${bad}` as `/v1/${string}`, JobSchema, undefined, app.token), (e: unknown) => e instanceof Error, bad);
  // Another application cannot wait on (or read) this job: ownership is checked before anything is held open.
  await assert.rejects(stranger.getJob(job.id, undefined, 2000), errorCode('NOT_FOUND'));
  // The waiter bound: with one slot taken, a second read is answered at once; the slot frees when the first client leaves.
  const abort = new AbortController(); const first = sdk.getJob(job.id, abort.signal, 4000).catch(() => 'aborted'); await delay(150);
  const t0 = Date.now(); assert.equal((await sdk.getJob(job.id, undefined, 4000)).status, 'QUEUED'); assert.ok(Date.now() - t0 < 1000, 'over the waiter bound the read is answered at once');
  abort.abort(); await first; await delay(150);
  const t1 = Date.now(); await sdk.getJob(job.id, undefined, 400); assert.ok(Date.now() - t1 >= 300, 'the slot was released when the first client disconnected, so this read waits');
  // Revocation while waiting: the credential is re-checked when the read wakes.
  const pending = sdk.getJob(job.id, undefined, 5000).then(() => 'ok' as const, (e: unknown) => e); await delay(150);
  await f.transport.request('POST', `/v1/admin/applications/${app.applicationId}/revoke`, AckSchema, {}, f.admin);
  const node = await enrolled(f); await node.tick(); await node.tick(); // completing the job wakes the held read
  const outcome = await pending; assert.ok(outcome !== 'ok', 'a revoked application must not receive the result');
});

test('against an older Coordinator that answers 404 to a waited job read, the SDK falls back to plain polling; a job that is really missing still fails', { timeout: 30000 }, async t => {
  const f = await fixture(t); const app = await f.app();
  const proxy = createServer((req, res) => { void (async () => {
    if ((req.url ?? '').includes('?')) { res.writeHead(404, { 'Content-Type': 'application/json', 'X-PrivaNet-Protocol': '1' }); res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'route not found' } })); return; }
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
    const upstream = await fetch(f.url + (req.url ?? ''), { method: req.method ?? 'GET', headers: Object.fromEntries(Object.entries(req.headers).filter(([k]) => ['content-type', 'authorization', 'x-privanet-protocol'].includes(k)).map(([k, v]) => [k, String(v)])), ...(req.method === 'POST' ? { body: Buffer.concat(chunks) } : {}) });
    const text = await upstream.text(); res.writeHead(upstream.status, { 'Content-Type': 'application/json', 'X-PrivaNet-Protocol': '1' }); res.end(text);
  })(); });
  const proxyUrl = await listen(proxy); t.after(() => close(proxy));
  const sdk = new PrivaNetClient({ url: proxyUrl, allowInsecureLoopback: true, token: app.token });
  const node = await enrolled(f); await node.tick();
  const job = await sdk.submit('system.echo.v1', { message: 'old server' }, 'compat-wait'); const waiting = sdk.waitForResult(job.id, { timeoutMs: 10000, pollMs: 50 });
  await delay(200); await node.tick(); assert.deepEqual(await waiting, { message: 'old server' });
  await assert.rejects(sdk.waitForResult('00000000-0000-4000-8000-000000000000', { timeoutMs: 3000, pollMs: 50 }), errorCode('NOT_FOUND'));
});
