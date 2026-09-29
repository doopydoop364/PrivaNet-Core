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
import { identity, heartbeat } from './helpers.js';
async function listen(server: Server, port = 0): Promise<string> {
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const address = server.address(); assert(address && typeof address !== 'string'); return `http://127.0.0.1:${address.port}`;
}
async function close(server: Server) {
  await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); });
}
async function fixture(t: TestContext, authRequestsPerMinute = 120, policy: Partial<Policy> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'privanet-http-')); const db = join(dir, 'coordinator.sqlite');
  const logs: unknown[] = []; const admin = secret(); let store = new SqliteStore(db); let core = new Coordinator(store, policy);
  let server = createCoordinatorServer(core, { adminSecret: admin, log: e => logs.push(e), authRequestsPerMinute });
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
