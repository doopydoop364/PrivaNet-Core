import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat, chmod, writeFile, symlink, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import {
  AckSchema, ChallengeSchema, EnrollmentTokenSchema, EnrollmentTokensSchema, HealthSchema, NodeSelfSchema, NodesSchema, SessionSchema,
} from '@privanet/protocol';
import type { EnrollmentTokenInfo, JobType } from '@privanet/protocol';
import { ApiError, hash, secret, Transport } from '@privanet/shared';
import { Coordinator, MAX_ACTIVE_ENROLLMENTS } from '@privanet/coordinator/service';
import type { Policy } from '@privanet/coordinator/service';
import { GRANT_RETENTION_MS, SqliteStore } from '@privanet/coordinator/store';
import { createCoordinatorServer } from '@privanet/coordinator/server';
import { PrivaNode } from '@privanet/node/daemon';
import { loadConfig } from '@privanet/node/config';
import { enrollNode, EnrollError } from '@privanet/node/enroll';
import { ENROLLMENT_FILE, readEnrollmentRecord, writeEnrollmentRecord } from '@privanet/node/enrollment-record';
import { signProof, loadIdentity } from '@privanet/node/identity';
import { heartbeat, identity } from './helpers.js';

const ECHO: JobType[] = ['system.echo.v1']; const BOTH: JobType[] = ['system.echo.v1', 'system.hashchain.v1'];
async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); assert(address && typeof address !== 'string'); return `http://127.0.0.1:${address.port}`;
}
async function close(server: Server) { await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); }

/** A real Coordinator on a loopback port with a clock the test controls (expiry) and every log line captured. */
async function harness(t: TestContext, options: { failures?: number; policy?: Partial<Policy> } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'privanet-onboarding-')); const db = join(dir, 'coordinator.sqlite');
  // The clock starts at the real time so a session's expiry is in the node's future too.
  const clock = { t: Date.now() }; const logs: unknown[] = []; const adminSecret = secret();
  const store = new SqliteStore(db); const core = new Coordinator(store, { sessionMs: 600000, offlineMs: 600000, staleMs: 300000, ...options.policy }, () => clock.t);
  const server = createCoordinatorServer(core, { adminSecret, log: entry => logs.push(entry), authRequestsPerMinute: 10000, ...(options.failures ? { enrollmentFailuresPerMinute: options.failures } : {}) });
  const url = await listen(server); const transport = new Transport({ url, allowInsecureLoopback: true });
  t.after(async () => { await close(server); store.close(); await rm(dir, { recursive: true, force: true }); });
  const admin = {
    create: (body: object = {}) => transport.request('POST', '/v1/admin/enrollment-tokens', EnrollmentTokenSchema, { expiresInMs: 600000, capabilities: ECHO, ...body }, adminSecret),
    list: async () => (await transport.request('GET', '/v1/admin/enrollment-tokens', EnrollmentTokensSchema, undefined, adminSecret)).tokens,
    revokeToken: (id: string) => transport.request('POST', `/v1/admin/enrollment-tokens/${id}/revoke`, AckSchema, {}, adminSecret),
    nodes: async () => (await transport.request('GET', '/v1/admin/nodes', NodesSchema, undefined, adminSecret)).nodes,
    revokeNode: (id: string) => transport.request('POST', `/v1/admin/nodes/${id}/revoke`, AckSchema, {}, adminSecret),
    rename: (id: string, displayName: string | null) => transport.request('POST', `/v1/admin/nodes/${id}/rename`, AckSchema, { displayName }, adminSecret),
  };
  const enroll = (token: string, extra: Partial<Parameters<typeof enrollNode>[0]> = {}) => enrollNode({ url, token, stateDir: join(dir, `node-${secret().slice(0, 8)}`), allowInsecureLoopback: true, ...extra });
  return { dir, db, url, clock, logs, adminSecret, store, core, transport, admin, enroll, text: () => JSON.stringify(logs) };
}
async function refusal(promise: Promise<unknown>): Promise<ApiError> {
  try { await promise; } catch (error) { assert(error instanceof ApiError, 'expected an API refusal'); return error; }
  assert.fail('expected a refusal');
}
const tokenInfo = async (f: Awaited<ReturnType<typeof harness>>, id: string): Promise<EnrollmentTokenInfo> => { const info = (await f.admin.list()).find(entry => entry.id === id); assert.ok(info); return info; };

test('creating a token: random, short-lived, stored only as a hash, audited and never logged', async t => {
  const f = await harness(t);
  const created = await f.admin.create({ expiresInMs: 600000, capabilities: ECHO, label: 'Lab box' });
  assert.match(created.token, /^[a-f0-9]{64}$/); assert.match(created.id ?? '', /^enr_[a-f0-9]{16}$/);
  assert.equal(created.expiresAt, f.clock.t + 600000); assert.equal(created.createdAt, f.clock.t); assert.equal(created.label, 'Lab box');
  const other = await f.admin.create(); assert.notEqual(other.token, created.token); assert.notEqual(other.id, created.id); // 256 random bits each
  // What is stored is the hash. Neither the database, its write-ahead log nor any listing contains the token.
  const raw = new DatabaseSync(f.db, { readOnly: true });
  const rows = raw.prepare('SELECT token_hash, record FROM grants').all() as Array<{ token_hash: string; record: string }>; raw.close();
  assert.ok(rows.some(row => row.token_hash === hash(created.token)));
  for (const file of [f.db, `${f.db}-wal`]) { const bytes = await readFile(file).catch(() => Buffer.alloc(0)); assert.equal(bytes.includes(created.token), false, `${file} must not hold the token`); }
  const listing = JSON.stringify(await f.admin.list());
  assert.equal(listing.includes(created.token), false); assert.equal(listing.includes(hash(created.token)), false, 'not even the hash is listed');
  const info = await tokenInfo(f, created.id ?? '');
  assert.deepEqual({ status: info.status, createdAt: info.createdAt, expiresAt: info.expiresAt, usedAt: info.usedAt, revokedAt: info.revokedAt, label: info.label, nodeId: info.nodeId, capabilities: info.capabilities },
    { status: 'ACTIVE', createdAt: f.clock.t, expiresAt: f.clock.t + 600000, usedAt: null, revokedAt: null, label: 'Lab box', nodeId: null, capabilities: ECHO });
  assert.equal(f.text().includes(created.token), false); assert.equal(f.text().includes(f.adminSecret), false);
  // The lifetime is bounded and the request strict.
  for (const body of [{ expiresInMs: 999 }, { expiresInMs: 86400001 }, { label: 'bad\nname' }, { label: 'x'.repeat(65) }, { capabilities: ['rm -rf'] }, { surprise: true }]) assert.equal((await refusal(f.admin.create(body))).status, 400);
});

test('enrolling: the node proves its own key, the token is consumed, state is private and the registry records everything', async t => {
  const f = await harness(t); const created = await f.admin.create({ capabilities: BOTH, label: 'Home server' });
  const stateDir = join(f.dir, 'node'); f.clock.t += 5000;
  const result = await f.enroll(created.token, { stateDir });
  assert.equal(result.outcome, 'ENROLLED'); assert.deepEqual(result.capabilities, BOTH, 'omitted capabilities means everything the token grants'); assert.equal(result.displayName, 'Home server');
  const identityFile = JSON.parse(await readFile(join(stateDir, 'identity.json'), 'utf8')) as { nodeId: string; privateKey: string };
  assert.equal(result.nodeId, identityFile.nodeId);
  // The credential is the node's own private key; it never travelled, and the token is written nowhere on the node.
  for (const name of ['identity.json', 'node-state.json', ENROLLMENT_FILE]) assert.equal((await readFile(join(stateDir, name), 'utf8')).includes(created.token), false);
  assert.deepEqual(await readEnrollmentRecord(stateDir), { version: 1, coordinatorUrl: f.url, coordinatorId: (await f.transport.request('GET', '/v1/health', HealthSchema)).coordinatorId, nodeId: result.nodeId, capabilities: BOTH, enrolledAt: f.clock.t });
  assert.equal(f.text().includes(identityFile.privateKey), false); assert.equal(f.text().includes(created.token), false);
  // The token is spent, and says by whom and when.
  const info = await tokenInfo(f, created.id ?? ''); assert.deepEqual([info.status, info.nodeId, info.usedAt], ['USED', result.nodeId, f.clock.t]);
  assert.equal((await refusal(f.enroll(created.token).catch((error: unknown) => { throw error instanceof EnrollError ? new ApiError(401, error.failure, error.message) : error; }))).code, 'TOKEN_REFUSED');
  const [node] = await f.admin.nodes();
  assert.equal(node?.nodeId, result.nodeId); assert.equal(node?.displayName, 'Home server'); assert.equal(node?.enrolledAt, f.clock.t); assert.equal(node?.protocolVersion, 1);
  assert.deepEqual(node?.capabilities, BOTH); assert.equal(node?.status, 'OFFLINE'); assert.equal(node?.lastHeartbeatAt, null); assert.equal(node?.revokedAt, undefined);
  // The node can ask who it is with its own session, and no one else can.
  const key = await loadIdentity(stateDir); const health = await f.transport.request('GET', '/v1/health', HealthSchema);
  const challenge = await f.transport.request('POST', '/v1/auth/challenge', ChallengeSchema, { nodeId: key.nodeId, protocolVersion: 1 });
  const session = await f.transport.request('POST', '/v1/auth/proof', SessionSchema, signProof(key, challenge, health.coordinatorId, 'auth'));
  const self = await f.transport.request('GET', '/v1/node/self', NodeSelfSchema, undefined, session.token);
  assert.deepEqual([self.nodeId, self.displayName, self.capabilities, self.allowedCapabilities], [result.nodeId, 'Home server', BOTH, BOTH]);
  assert.equal((await refusal(f.transport.request('GET', '/v1/node/self', NodeSelfSchema, undefined, secret()))).status, 401);
});

test('a restarted node reconnects from its stored identity, with no token and no environment', async t => {
  const f = await harness(t); const created = await f.admin.create({ capabilities: ECHO }); const stateDir = join(f.dir, 'node');
  await f.enroll(created.token, { stateDir });
  // `privanet-node` with nothing but its state directory: the Coordinator and capabilities come from enrollment.json.
  const config = loadConfig({ PRIVANODE_STATE_DIR: stateDir, PRIVANODE_ALLOW_INSECURE_LOOPBACK: 'true' });
  assert.equal(config.url, f.url); assert.deepEqual(config.capabilities, ECHO); assert.equal(config.enrollmentToken, undefined);
  const explicit = loadConfig({ PRIVANODE_STATE_DIR: stateDir, PRIVANODE_ALLOW_INSECURE_LOOPBACK: 'true', PRIVANODE_COORDINATOR_URL: 'http://127.0.0.1:9', PRIVANODE_CAPABILITIES: '' });
  assert.equal(explicit.url, 'http://127.0.0.1:9'); assert.deepEqual(explicit.capabilities, [], 'what the environment says wins');
  let nodeId: string | null = null;
  for (let restart = 0; restart < 2; restart++) {
    const node = new PrivaNode({ url: config.url, allowInsecureLoopback: true, stateDir, capabilities: config.capabilities, heartbeatMs: 10 });
    await node.tick(); assert.equal(node.status.connected, true); nodeId ??= node.status.nodeId; assert.equal(node.status.nodeId, nodeId);
  }
  assert.equal((await f.admin.nodes())[0]?.status, 'ONLINE'); assert.equal((await f.admin.nodes())[0]?.nodeId, nodeId);
  // A node that was never enrolled this way is configured exactly as before.
  assert.equal(loadConfig({ PRIVANODE_STATE_DIR: join(f.dir, 'nothing-here'), PRIVANODE_ALLOW_INSECURE_LOOPBACK: 'true' }).url, 'http://127.0.0.1:4010');
});

test('a token that cannot be redeemed gets one answer, whatever is wrong with it', async t => {
  const f = await harness(t, { failures: 1000 }); // this test makes many refused attempts on purpose; the limit has its own test
  const used = await f.admin.create(); await f.enroll(used.token);
  const revoked = await f.admin.create(); await f.admin.revokeToken(revoked.id ?? '');
  const expired = await f.admin.create({ expiresInMs: 1000 }); f.clock.t += 2000;
  const live = await f.admin.create(); const nearMiss = live.token.slice(0, 63) + (live.token.endsWith('0') ? '1' : '0');
  const attempts = [used.token, revoked.token, expired.token, nearMiss, secret(), '0'.repeat(64)];
  const bodies: string[] = [];
  for (const token of attempts) {
    const key = identity();
    const response = await fetch(`${f.url}/v1/enrollment/challenge`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-privanet-protocol': '1' },
      body: JSON.stringify({ token, publicKey: key.publicKey, protocolVersion: 1, daemonVersion: '0.3.0', capabilities: ECHO }) });
    assert.equal(response.status, 401); bodies.push(await response.text());
    const failure = await f.enroll(token).catch((error: unknown) => error); assert.ok(failure instanceof EnrollError); assert.equal(failure.failure, 'TOKEN_REFUSED');
    assert.equal(failure.message.includes(token), false);
  }
  assert.equal(new Set(bodies).size, 1, 'the same body for unknown, used, revoked, expired and near-miss tokens');
  assert.deepEqual(JSON.parse(bodies[0] ?? ''), { error: { code: 'INVALID_ENROLLMENT', message: 'invalid enrollment' } });
  assert.equal((await tokenInfo(f, live.id ?? '')).status, 'ACTIVE', 'a near miss does not touch the real token');
});

test('single use holds under concurrency: of many simultaneous redemptions of one token, exactly one wins', async t => {
  const f = await harness(t); const created = await f.admin.create({ capabilities: ECHO });
  const outcomes = await Promise.allSettled(Array.from({ length: 8 }, () => f.enroll(created.token)));
  const won = outcomes.filter(outcome => outcome.status === 'fulfilled'); const lost = outcomes.filter(outcome => outcome.status === 'rejected');
  assert.equal(won.length, 1); assert.equal(lost.length, 7);
  for (const outcome of lost) { assert.ok(outcome.reason instanceof EnrollError); assert.equal(outcome.reason.failure, 'TOKEN_REFUSED'); }
  assert.equal((await f.admin.nodes()).length, 1); assert.equal((await tokenInfo(f, created.id ?? '')).status, 'USED');
  // The same at the protocol level, past the challenge: eight valid proofs of eight different keys for one token.
  const second = await f.admin.create({ capabilities: ECHO }); const health = await f.transport.request('GET', '/v1/health', HealthSchema);
  const keys = Array.from({ length: 8 }, () => identity());
  const challenges = await Promise.all(keys.map(key => f.transport.request('POST', '/v1/enrollment/challenge', ChallengeSchema, { token: second.token, publicKey: key.publicKey, protocolVersion: 1, daemonVersion: '0.3.0', capabilities: ECHO })));
  const proofs = await Promise.allSettled(challenges.map((challenge, index) => f.transport.request('POST', '/v1/enrollment/proof', SessionSchema, keys[index]?.proof(challenge))));
  assert.equal(proofs.filter(proof => proof.status === 'fulfilled').length, 1); assert.equal((await f.admin.nodes()).length, 2);
  void health;
});

test('an unused token can be revoked and then redeems nothing; a used one cannot be revoked; listings tell them apart', async t => {
  const f = await harness(t); const a = await f.admin.create(); const b = await f.admin.create(); const c = await f.admin.create({ expiresInMs: 1000 });
  await f.admin.revokeToken(a.id ?? ''); await f.admin.revokeToken(a.id ?? ''); // twice is harmless
  assert.equal((await refusal(f.enroll(a.token).then(() => undefined, (error: unknown) => { throw error instanceof EnrollError ? new ApiError(401, error.failure, '') : error; }))).code, 'TOKEN_REFUSED');
  await f.enroll(b.token);
  assert.equal((await refusal(f.admin.revokeToken(b.id ?? ''))).code, 'ENROLLMENT_ALREADY_USED');
  assert.equal((await refusal(f.admin.revokeToken('enr_0000000000000000'))).code, 'NOT_FOUND');
  assert.equal((await refusal(f.admin.revokeToken('not-an-id'))).status, 400);
  f.clock.t += 2000;
  const states = Object.fromEntries((await f.admin.list()).map(entry => [entry.id, entry.status]));
  assert.deepEqual(states, { [a.id ?? '']: 'REVOKED', [b.id ?? '']: 'USED', [c.id ?? '']: 'EXPIRED' });
  // Revoking mid-enrollment also works: the challenge is already out, but the proof redeems nothing.
  const d = await f.admin.create(); const key = identity();
  const challenge = await f.transport.request('POST', '/v1/enrollment/challenge', ChallengeSchema, { token: d.token, publicKey: key.publicKey, protocolVersion: 1, daemonVersion: '0.3.0', capabilities: ECHO });
  await f.admin.revokeToken(d.id ?? '');
  assert.equal((await refusal(f.transport.request('POST', '/v1/enrollment/proof', SessionSchema, key.proof(challenge)))).code, 'INVALID_ENROLLMENT');
});

test('a revoked node is refused everywhere, and cannot be re-enrolled by accident', async t => {
  const f = await harness(t); const created = await f.admin.create(); const stateDir = join(f.dir, 'node');
  const enrolled = await f.enroll(created.token, { stateDir });
  const key = await loadIdentity(stateDir); const health = await f.transport.request('GET', '/v1/health', HealthSchema);
  const session = await f.transport.request('POST', '/v1/auth/proof', SessionSchema, signProof(key, await f.transport.request('POST', '/v1/auth/challenge', ChallengeSchema, { nodeId: key.nodeId, protocolVersion: 1 }), health.coordinatorId, 'auth'));
  await f.transport.request('POST', '/v1/node/heartbeat', AckSchema, heartbeat(ECHO), session.token);
  await f.admin.revokeNode(enrolled.nodeId);
  assert.equal((await refusal(f.transport.request('POST', '/v1/node/heartbeat', AckSchema, heartbeat(ECHO), session.token))).status, 401, 'the live session stops working at once');
  assert.equal((await refusal(f.transport.request('GET', '/v1/node/self', NodeSelfSchema, undefined, session.token))).status, 401);
  assert.equal((await refusal(f.transport.request('POST', '/v1/auth/challenge', ChallengeSchema, { nodeId: key.nodeId, protocolVersion: 1 }))).status, 401, 'no new session');
  assert.equal((await refusal(new PrivaNode({ url: f.url, allowInsecureLoopback: true, stateDir, capabilities: ECHO }).tick())).status, 401);
  const [node] = await f.admin.nodes(); assert.equal(node?.status, 'REVOKED'); assert.equal(node?.revokedAt, f.clock.t);
  // A fresh token does not resurrect it: the identity stays registered-and-revoked, and the token is left unused.
  const fresh = await f.admin.create();
  const failure = await f.enroll(fresh.token, { stateDir }).catch((error: unknown) => error); assert.ok(failure instanceof EnrollError); assert.equal(failure.failure, 'IDENTITY_UNUSABLE');
  assert.equal((await tokenInfo(f, fresh.id ?? '')).status, 'ACTIVE');
});

test('nodes already enrolled before this change, and tokens written before it, keep working unchanged', async t => {
  const f = await harness(t);
  // A token as an older Coordinator stored it: no id, creation time, label or audit fields.
  const legacyToken = secret(); f.store.saveGrant({ tokenHash: hash(legacyToken), expiresAt: f.clock.t + 60000, capabilities: ECHO, used: false });
  const legacy = (await f.admin.list()).find(entry => entry.createdAt === null); assert.ok(legacy); assert.equal(legacy.status, 'ACTIVE'); assert.equal(legacy.label, null);
  // It enrols a node exactly the way a v0.3.0-alpha.6 node does: capabilities named, the existing two-step flow, the daemon's own code path.
  const stateDir = join(f.dir, 'old-node');
  const node = new PrivaNode({ url: f.url, allowInsecureLoopback: true, stateDir, capabilities: ECHO, enrollmentToken: legacyToken, heartbeatMs: 10 });
  await node.tick(); assert.equal(node.status.connected, true);
  const [view] = await f.admin.nodes(); assert.equal(view?.status, 'ONLINE'); assert.equal(view?.displayName, undefined);
  assert.equal((await tokenInfo(f, legacy.id)).status, 'USED');
  // A node record as an older Coordinator stored it (no name, no revocation time) still lists, renames and revokes.
  const stored = f.store.getNode(node.status.nodeId ?? ''); assert.ok(stored);
  const bare = { ...stored }; delete bare.displayName; delete bare.revokedAt; f.store.saveNode(bare);
  await f.admin.rename(bare.nodeId, 'Kept'); assert.equal((await f.admin.nodes())[0]?.displayName, 'Kept');
  // The same node restarts with its old environment configuration and no enrollment.json, and is not disturbed.
  const again = new PrivaNode({ url: f.url, allowInsecureLoopback: true, stateDir, capabilities: ECHO }); await again.tick(); assert.equal(again.status.nodeId, node.status.nodeId);
  assert.equal((await refusal(f.transport.request('POST', '/v1/admin/enrollment-tokens', EnrollmentTokenSchema, { expiresInMs: 1000, capabilities: ECHO, label: 'x' }, 'f'.repeat(64)))).status, 401);
});

test('malformed requests are rejected generically and cost nothing', async t => {
  const f = await harness(t); const created = await f.admin.create(); const key = identity();
  const good = { token: created.token, publicKey: key.publicKey, protocolVersion: 1, daemonVersion: '0.3.0', capabilities: ECHO };
  const post = (path: string, body: unknown, headers: Record<string, string> = {}, raw = false) => fetch(f.url + path, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-privanet-protocol': '1', ...headers }, body: raw ? String(body) : JSON.stringify(body) });
  const cases: Array<[string, Promise<Response>, number, string]> = [
    ['wrong content type', post('/v1/enrollment/challenge', good, { 'content-type': 'text/plain' }), 415, 'CONTENT_TYPE'],
    ['not json', post('/v1/enrollment/challenge', '{nope', {}, true), 400, 'INVALID_JSON'],
    ['unknown field', post('/v1/enrollment/challenge', { ...good, admin: true }), 400, 'INVALID_REQUEST'],
    ['short token', post('/v1/enrollment/challenge', { ...good, token: 'abc' }), 400, 'INVALID_REQUEST'],
    ['token with the wrong characters', post('/v1/enrollment/challenge', { ...good, token: 'G'.repeat(64) }), 400, 'INVALID_REQUEST'],
    ['token of the wrong type', post('/v1/enrollment/challenge', { ...good, token: 12 }), 400, 'INVALID_REQUEST'],
    ['bad public key', post('/v1/enrollment/challenge', { ...good, publicKey: 'x'.repeat(60) }), 400, 'INVALID_PUBLIC_KEY'],
    ['oversized body', post('/v1/enrollment/challenge', JSON.stringify({ ...good, junk: 'x'.repeat(40000) }), {}, true), 413, 'BODY_TOO_LARGE'],
    ['no protocol header', post('/v1/enrollment/challenge', good, { 'x-privanet-protocol': '' }), 426, 'PROTOCOL_MISMATCH'],
    ['other protocol header', post('/v1/enrollment/challenge', good, { 'x-privanet-protocol': '2' }), 426, 'PROTOCOL_MISMATCH'],
    ['other protocol in the body', post('/v1/enrollment/challenge', { ...good, protocolVersion: 2 }), 426, 'PROTOCOL_MISMATCH'],
    ['unknown capability', post('/v1/enrollment/challenge', { ...good, capabilities: ['shell.exec'] }), 400, 'INVALID_REQUEST'],
    ['proof for nothing', post('/v1/enrollment/proof', { challengeId: '00000000-0000-4000-8000-000000000000', signature: 'a'.repeat(128) }), 401, 'INVALID_PROOF'],
    ['proof that is not one', post('/v1/enrollment/proof', { challengeId: 'x', signature: 'y' }), 400, 'INVALID_REQUEST'],
    ['wrong method', fetch(`${f.url}/v1/enrollment/challenge`, { headers: { 'x-privanet-protocol': '1' } }), 401, 'UNAUTHORIZED'],
    ['admin without a credential', fetch(`${f.url}/v1/admin/enrollment-tokens`, { headers: { 'x-privanet-protocol': '1' } }), 401, 'UNAUTHORIZED'],
    ['admin with the wrong credential', fetch(`${f.url}/v1/admin/enrollment-tokens`, { headers: { 'x-privanet-protocol': '1', authorization: `Bearer ${'a'.repeat(64)}` } }), 401, 'UNAUTHORIZED_ADMIN'],
    ['a node session is not an admin credential', fetch(`${f.url}/v1/admin/enrollment-tokens`, { headers: { 'x-privanet-protocol': '1', authorization: `Bearer ${secret()}` } }), 401, 'UNAUTHORIZED_ADMIN'],
    ['rename with a bad name', post(`/v1/admin/nodes/node_${'a'.repeat(64)}/rename`, { displayName: '<script>' }, { authorization: `Bearer ${f.adminSecret}` }), 400, 'INVALID_REQUEST'],
    ['rename of nothing', post(`/v1/admin/nodes/node_${'a'.repeat(64)}/rename`, { displayName: 'ok' }, { authorization: `Bearer ${f.adminSecret}` }), 404, 'NOT_FOUND'],
    ['revoke with a body', post(`/v1/admin/enrollment-tokens/${created.id}/revoke`, { extra: 1 }, { authorization: `Bearer ${f.adminSecret}` }), 400, 'INVALID_REQUEST'],
  ];
  for (const [name, request, status, code] of cases) {
    const response = await request; const body = await response.text();
    assert.equal(response.status, status, name); assert.equal((JSON.parse(body) as { error: { code: string } }).error.code, code, name);
    assert.equal(body.includes(created.token), false, `${name}: the token is never echoed`);
  }
  assert.equal((await tokenInfo(f, created.id ?? '')).status, 'ACTIVE', 'none of it consumed the token');
  assert.equal(f.text().includes(created.token), false);
});

test('a Coordinator with another protocol version is reported as such, and nothing is stored', async t => {
  const stub = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'application/json', 'x-privanet-protocol': '2' }); response.end(JSON.stringify({ protocolVersion: 2, serviceVersion: '9.0.0', coordinatorId: '00000000-0000-4000-8000-000000000000', status: 'ok' })); });
  const url = await listen(stub); const dir = await mkdtemp(join(tmpdir(), 'privanet-onboarding-')); t.after(async () => { await close(stub); await rm(dir, { recursive: true, force: true }); });
  const failure = await enrollNode({ url, token: secret(), stateDir: join(dir, 'n'), allowInsecureLoopback: true }).catch((error: unknown) => error);
  assert.ok(failure instanceof EnrollError); assert.equal(failure.failure, 'PROTOCOL_MISMATCH'); assert.match(failure.message, /protocol/);
  await assert.rejects(readFile(join(dir, 'n', ENROLLMENT_FILE)));
});

test('guessing is cut off: a few refused enrollments from one address stop being answered, and ordinary authentication is not affected', async t => {
  const f = await harness(t, { failures: 3 }); const created = await f.admin.create(); const outsider = join(f.dir, 'outsider');
  const guess = () => f.transport.request('POST', '/v1/enrollment/challenge', ChallengeSchema, { token: secret(), publicKey: identity().publicKey, protocolVersion: 1, daemonVersion: '0.3.0', capabilities: ECHO });
  for (let attempt = 0; attempt < 3; attempt++) assert.equal((await refusal(guess())).code, 'INVALID_ENROLLMENT');
  const blocked = await refusal(guess()); assert.equal(blocked.status, 429); assert.equal(blocked.code, 'RATE_LIMIT');
  // Even the right token gets the same answer from a blocked address, so the limit says nothing about guesses.
  assert.equal((await refusal(f.transport.request('POST', '/v1/enrollment/challenge', ChallengeSchema, { token: created.token, publicKey: identity().publicKey, protocolVersion: 1, daemonVersion: '0.3.0', capabilities: ECHO }))).code, 'RATE_LIMIT');
  const failure = await f.enroll(created.token, { stateDir: outsider }).catch((error: unknown) => error); assert.ok(failure instanceof EnrollError); assert.equal(failure.failure, 'RATE_LIMITED');
  assert.equal((await tokenInfo(f, created.id ?? '')).status, 'ACTIVE', 'the real token is untouched');
  // An enrolled node authenticates as usual from the same address.
  const other = await harness(t); const token = await other.admin.create(); const dir = join(other.dir, 'node'); await other.enroll(token.token, { stateDir: dir });
  const key = await loadIdentity(dir); assert.ok(await other.transport.request('POST', '/v1/auth/challenge', ChallengeSchema, { nodeId: key.nodeId, protocolVersion: 1 }));
  // Auth challenges on the limited server are still answered for a node that exists there.
  const enrolled = await f.core.createEnrollment({ expiresInMs: 1000, capabilities: ECHO }); assert.ok(enrolled.token);
  assert.equal((await refusal(f.transport.request('POST', '/v1/auth/challenge', ChallengeSchema, { nodeId: key.nodeId, protocolVersion: 1 }))).status, 401, 'unknown node: the ordinary generic refusal, not the enrollment limit');
});

test('capabilities: a named subset is honoured, one the token does not grant is refused and leaves the token unused', async t => {
  const f = await harness(t);
  const narrow = await f.admin.create({ capabilities: ECHO });
  const refused = await f.enroll(narrow.token, { capabilities: ['system.hashchain.v1'] }).catch((error: unknown) => error);
  assert.ok(refused instanceof EnrollError); assert.equal(refused.failure, 'CAPABILITY_FORBIDDEN'); assert.equal((await tokenInfo(f, narrow.id ?? '')).status, 'ACTIVE');
  const wide = await f.admin.create({ capabilities: BOTH }); const stateDir = join(f.dir, 'subset');
  assert.deepEqual((await f.enroll(wide.token, { capabilities: ECHO, stateDir })).capabilities, ECHO);
  assert.deepEqual((await readEnrollmentRecord(stateDir))?.capabilities, ECHO);
  assert.deepEqual((await f.admin.nodes())[0]?.capabilities, ECHO);
  // Nothing here lets a node run anything but registered, typed handlers: the Coordinator refuses unknown capability names outright.
  assert.equal((await refusal(f.transport.request('POST', '/v1/enrollment/challenge', ChallengeSchema, { token: secret(), publicKey: identity().publicKey, protocolVersion: 1, daemonVersion: '0.3.0', capabilities: ['shell.exec'] }))).status, 400);
});

test('administration: names, details, renaming, clearing and revoking', async t => {
  const f = await harness(t); const created = await f.admin.create({ label: 'First name' }); const stateDir = join(f.dir, 'node');
  const { nodeId } = await f.enroll(created.token, { stateDir });
  await new PrivaNode({ url: f.url, allowInsecureLoopback: true, stateDir, capabilities: ECHO, heartbeatMs: 10 }).tick();
  let [node] = await f.admin.nodes();
  assert.deepEqual([node?.nodeId, node?.displayName, node?.status, node?.protocolVersion, node?.jobSlots, node?.currentJobs, node?.capabilities], [nodeId, 'First name', 'ONLINE', 1, 1, 0, ECHO]);
  assert.equal(typeof node?.lastHeartbeatAt, 'number'); assert.equal(node?.enrolledAt, f.clock.t);
  await f.admin.rename(nodeId, 'Garage-2'); assert.equal((await f.admin.nodes())[0]?.displayName, 'Garage-2');
  await f.admin.rename(nodeId, null); assert.equal((await f.admin.nodes())[0]?.displayName, undefined);
  assert.equal((await refusal(f.admin.rename(nodeId, ' padded '))).status, 400);
  f.clock.t += 1000; await f.admin.revokeNode(nodeId); await f.admin.revokeNode(nodeId);
  [node] = await f.admin.nodes(); assert.deepEqual([node?.status, node?.revokedAt], ['REVOKED', f.clock.t - 0]);
  await f.admin.rename(nodeId, 'Retired'); assert.equal((await f.admin.nodes())[0]?.displayName, 'Retired');
  assert.equal((await f.admin.nodes())[0]?.status, 'REVOKED', 'renaming does not reinstate a node');
  assert.equal(f.text().includes('Retired'), false, 'names are not logged');
});

test('the number of redeemable tokens is bounded, and freed by revoking', async t => {
  const f = await harness(t); const created: string[] = [];
  for (let i = 0; i < MAX_ACTIVE_ENROLLMENTS; i++) created.push(f.core.createEnrollment({ expiresInMs: 600000, capabilities: ECHO }).id);
  assert.equal((await refusal(f.admin.create())).code, 'ENROLLMENT_LIMIT');
  await f.admin.revokeToken(created[0] ?? ''); assert.ok(await f.admin.create());
});

test('a spent token stays on record for audit after it expires, and is eventually dropped', async t => {
  const f = await harness(t); const created = await f.admin.create({ expiresInMs: 60000 }); const unused = await f.admin.create({ expiresInMs: 60000 });
  const { nodeId } = await f.enroll(created.token);
  f.clock.t += 3600000; f.core.maintain();
  const info = await tokenInfo(f, created.id ?? ''); assert.deepEqual([info.status, info.nodeId], ['USED', nodeId], 'still answers "was it used, by whom"');
  assert.equal((await tokenInfo(f, unused.id ?? '')).status, 'EXPIRED');
  f.clock.t += GRANT_RETENTION_MS; f.core.maintain(); assert.deepEqual(await f.admin.list(), []);
});

test('the node-side files are private, never overwritten and refused when unsafe', { skip: process.platform === 'win32' && 'POSIX permissions' }, async t => {
  const f = await harness(t); const created = await f.admin.create(); const stateDir = join(f.dir, 'node');
  await f.enroll(created.token, { stateDir });
  assert.equal((await stat(stateDir)).mode & 0o777, 0o700);
  for (const name of ['identity.json', 'node-state.json', ENROLLMENT_FILE]) assert.equal((await stat(join(stateDir, name))).mode & 0o777, 0o600, name);
  const record = await readEnrollmentRecord(stateDir); assert.ok(record);
  await assert.rejects(writeEnrollmentRecord(stateDir, record), /EEXIST/, 'an enrolled node does not silently change who it is enrolled with');
  const file = join(stateDir, ENROLLMENT_FILE);
  await chmod(file, 0o644);
  await assert.rejects(readEnrollmentRecord(stateDir), /Unsafe/); assert.throws(() => loadConfig({ PRIVANODE_STATE_DIR: stateDir }), /Unsafe/);
  await chmod(file, 0o600); await rm(file); await writeFile(join(f.dir, 'elsewhere.json'), JSON.stringify(record), { mode: 0o600 }); await symlink(join(f.dir, 'elsewhere.json'), file);
  assert.ok((await lstat(file)).isSymbolicLink()); await assert.rejects(readEnrollmentRecord(stateDir), /Unsafe/); assert.throws(() => loadConfig({ PRIVANODE_STATE_DIR: stateDir }), /Unsafe/);
  await rm(file); await writeFile(file, JSON.stringify({ ...record, surprise: 1 }), { mode: 0o600 });
  await assert.rejects(readEnrollmentRecord(stateDir)); // strict: nothing unexpected is accepted
});

test('a state directory set up for one Coordinator is not silently used for another', async t => {
  const a = await harness(t); const b = await harness(t); const stateDir = join(a.dir, 'node');
  await a.enroll((await a.admin.create()).token, { stateDir });
  const failure = await enrollNode({ url: b.url, token: (await b.admin.create()).token, stateDir, allowInsecureLoopback: true }).catch((error: unknown) => error);
  assert.ok(failure instanceof EnrollError); assert.equal(failure.failure, 'COORDINATOR_CHANGED');
  assert.equal((await b.admin.list())[0]?.status, 'ACTIVE'); assert.deepEqual(await b.admin.nodes(), []);
});

test('enrolling again with a node that is already known does nothing and does not spend the token', async t => {
  const f = await harness(t); const stateDir = join(f.dir, 'node'); await f.enroll((await f.admin.create()).token, { stateDir });
  const spare = await f.admin.create(); const again = await f.enroll(spare.token, { stateDir });
  assert.equal(again.outcome, 'ALREADY_ENROLLED'); assert.equal((await tokenInfo(f, spare.id ?? '')).status, 'ACTIVE'); assert.equal((await f.admin.nodes()).length, 1);
});
