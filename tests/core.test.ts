import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiError, hash } from '@privanet/shared';
import { fixture, heartbeat, identity } from './helpers.js';
import { SqliteStore } from '@privanet/coordinator/store';
import { Coordinator } from '@privanet/coordinator/service';
import { migrations } from '@privanet/coordinator/migrations';
function code(expected: string) { return (error: unknown) => error instanceof ApiError && error.code === expected; }

test('enrollment proves identity, consumes token, keeps only hashed credentials', t => {
  const f = fixture(); t.after(() => f.store.close());
  const n = f.enroll();
  assert.equal(f.core.authenticateNode(n.session.token).nodeId, n.session.nodeId);
  assert.equal(f.store.getGrant(hash(n.grant.token))?.used, true);
  assert.equal(f.store.getSession(n.session.token), undefined);
  assert.equal(f.store.getChallenge(n.challenge.challengeId), undefined);
  assert.equal(f.core.listNodes()[0]?.status, 'OFFLINE');
  const other = identity();
  assert.throws(() => f.core.beginEnrollment({ token: n.grant.token, publicKey: other.publicKey, protocolVersion: 1, daemonVersion: '0.1.0', capabilities: ['system.echo.v1'] }), code('INVALID_ENROLLMENT'));
  assert.throws(() => f.core.prove(n.key.proof(n.challenge), 'enroll'), code('INVALID_PROOF'));
});
test('invalid/expired grants, malformed key, wrong key type and capabilities rejected', t => {
  const f = fixture(); t.after(() => f.store.close()); const key = identity();
  const request = { token: 'f'.repeat(64), publicKey: key.publicKey, protocolVersion: 1, daemonVersion: '0.1.0', capabilities: ['system.echo.v1'] };
  assert.throws(() => f.core.beginEnrollment(request), code('INVALID_ENROLLMENT'));
  const grant = f.core.createEnrollment({ expiresInMs: 1000, capabilities: ['system.echo.v1'] });
  assert.throws(() => f.core.beginEnrollment({ ...request, token: grant.token, publicKey: 'bad'.repeat(20) }), code('INVALID_PUBLIC_KEY'));
  const rsa = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  assert.throws(() => f.core.beginEnrollment({ ...request, token: grant.token, publicKey: rsa }), code('INVALID_PUBLIC_KEY'));
  const restricted = f.core.createEnrollment({ expiresInMs: 1000, capabilities: [] });
  assert.throws(() => f.core.beginEnrollment({ ...request, token: restricted.token }), code('CAPABILITY_FORBIDDEN'));
  f.advance(1000);
  assert.throws(() => f.core.beginEnrollment({ ...request, token: grant.token }), code('INVALID_ENROLLMENT'));
});
test('challenge expiry, wrong proof and purpose are one-use; unused token can try again', t => {
  const f = fixture(); t.after(() => f.store.close()); const n = f.enroll();
  const challenge = f.core.beginAuth(n.session.nodeId);
  assert.throws(() => f.core.prove(identity().proof(challenge), 'auth'), code('INVALID_PROOF'));
  assert.throws(() => f.core.prove(n.key.proof(challenge), 'auth'), code('INVALID_PROOF'));
  const expired = f.core.beginAuth(n.session.nodeId); f.advance(100);
  assert.throws(() => f.core.prove(n.key.proof(expired), 'auth'), code('INVALID_PROOF'));
  const wrongPurpose = f.core.beginAuth(n.session.nodeId);
  assert.throws(() => f.core.prove(n.key.proof(wrongPurpose), 'enroll'), code('INVALID_PROOF'));
  const key = identity(); const grant = f.core.createEnrollment({ expiresInMs: 1000, capabilities: [] });
  const begin = () => f.core.beginEnrollment({ token: grant.token, publicKey: key.publicKey, protocolVersion: 1, daemonVersion: '0.1.0', capabilities: [] });
  assert.throws(() => f.core.prove(identity().proof(begin()), 'enroll'), code('INVALID_PROOF'));
  assert(f.core.prove(key.proof(begin()), 'enroll').nodeId);
});
test('two challenges cannot consume one enrollment grant twice', t => {
  const f = fixture(); t.after(() => f.store.close());
  const grant = f.core.createEnrollment({ expiresInMs: 1000, capabilities: [] });
  const keyA = identity(); const keyB = identity();
  const begin = (publicKey: string) => f.core.beginEnrollment({ token: grant.token, publicKey, protocolVersion: 1, daemonVersion: '0.1.0', capabilities: [] });
  const a = begin(keyA.publicKey); const b = begin(keyB.publicKey);
  f.core.prove(keyA.proof(a), 'enroll');
  assert.throws(() => f.core.prove(keyB.proof(b), 'enroll'), code('INVALID_ENROLLMENT'));
  assert.equal(f.core.listNodes().length, 1);
});
test('session refresh invalidates previous bearer; expiry and revocation reject node', t => {
  const f = fixture(); t.after(() => f.store.close()); const n = f.enroll();
  assert.throws(() => f.core.authenticateNode('e'.repeat(64)), code('UNAUTHORIZED_NODE'));
  const challenge = f.core.beginAuth(n.session.nodeId);
  const refreshed = f.core.prove(n.key.proof(challenge), 'auth');
  assert.throws(() => f.core.authenticateNode(n.session.token), code('UNAUTHORIZED_NODE'));
  assert.equal(f.core.authenticateNode(refreshed.token).nodeId, n.session.nodeId);
  f.advance(1000); assert.throws(() => f.core.authenticateNode(refreshed.token), code('UNAUTHORIZED_NODE'));
  f.core.revokeNode(n.session.nodeId);
  assert.equal(f.core.listNodes()[0]?.status, 'REVOKED');
  assert.throws(() => f.core.beginAuth(n.session.nodeId), code('UNAUTHORIZED_NODE'));
  assert.throws(() => f.core.heartbeat(n.session.nodeId, heartbeat()), code('UNAUTHORIZED_NODE'));
});
test('heartbeat reception time produces ONLINE, STALE, OFFLINE and returns online', t => {
  const f = fixture(); t.after(() => f.store.close()); const n = f.enroll();
  f.core.heartbeat(n.session.nodeId, heartbeat()); assert.equal(f.core.listNodes()[0]?.status, 'ONLINE');
  f.advance(100); assert.equal(f.core.listNodes()[0]?.status, 'STALE');
  f.advance(400); assert.equal(f.core.listNodes()[0]?.status, 'OFFLINE');
  f.core.heartbeat(n.session.nodeId, heartbeat()); assert.equal(f.core.listNodes()[0]?.status, 'ONLINE');
  const disabled = f.enroll([]);
  assert.throws(() => f.core.heartbeat(disabled.session.nodeId, heartbeat()), code('CAPABILITY_FORBIDDEN'));
});
test('malformed/unknown jobs rejected; app scope, ownership and revocation enforced', t => {
  const f = fixture(); t.after(() => f.store.close());
  for (const request of [{ type: 'run.v1', input: {}, idempotencyKey: 'a' }, { type: 'system.echo.v1', input: { message: 2 }, idempotencyKey: 'a' }]) assert.throws(() => f.core.submit(f.app, request));
  const limited = f.core.createApplication({ name: 'limited', allowedJobTypes: [] }); const app = f.core.authenticateApplication(limited.token);
  assert.throws(() => f.core.submit(app, { type: 'system.echo.v1', input: { message: 'test' }, idempotencyKey: 'a' }), code('JOB_TYPE_FORBIDDEN'));
  const job = f.submit(); assert.throws(() => f.core.getJob(app, job.id), code('NOT_FOUND'));
  assert.throws(() => f.core.authenticateApplication('d'.repeat(64)), code('UNAUTHORIZED_APPLICATION'));
  f.core.revokeApplication(limited.applicationId);
  assert.throws(() => f.core.authenticateApplication(limited.token), code('UNAUTHORIZED_APPLICATION'));
});
test('submission is idempotent per app and rejects key reuse with changed input', t => {
  const f = fixture(); t.after(() => f.store.close()); const key = 'request-1';
  const first = f.submit('a', key); assert.equal(f.submit('a', key).id, first.id);
  assert.throws(() => f.submit('b', key), code('IDEMPOTENCY_CONFLICT'));
  const otherCredential = f.core.createApplication({ name: 'other', allowedJobTypes: ['system.echo.v1'] });
  const other = f.core.authenticateApplication(otherCredential.token);
  assert.notEqual(f.core.submit(other, { type: 'system.echo.v1', input: { message: 'a' }, idempotencyKey: key }).id, first.id);
});
test('scheduler requires heartbeat, matches capabilities and respects workload', t => {
  const f = fixture(); t.after(() => f.store.close()); const job = f.submit();
  const n = f.enroll(); const empty = f.enroll([]);
  assert.equal(f.core.lease(n.session.nodeId), null);
  f.core.heartbeat(empty.session.nodeId, heartbeat([])); assert.equal(f.core.lease(empty.session.nodeId), null);
  f.core.heartbeat(n.session.nodeId, { ...heartbeat(), currentJobs: 1 }); assert.equal(f.core.lease(n.session.nodeId), null);
  f.core.heartbeat(n.session.nodeId, heartbeat()); const lease = f.core.lease(n.session.nodeId); assert.equal(lease?.jobId, job.id);
  f.submit('next'); assert.equal(f.core.lease(n.session.nodeId), null);
  assert.equal(f.core.capabilities(f.app).capabilities[0]?.onlineNodes, 1);
});
test('stale/offline/revoked nodes never receive new work', t => {
  const f = fixture(); t.after(() => f.store.close()); const n = f.enroll(); f.submit();
  f.core.heartbeat(n.session.nodeId, heartbeat()); f.advance(100);
  assert.equal(f.core.lease(n.session.nodeId), null); f.advance(400); assert.equal(f.core.lease(n.session.nodeId), null);
  f.core.revokeNode(n.session.nodeId); assert.throws(() => f.core.lease(n.session.nodeId), code('UNAUTHORIZED_NODE'));
});
test('successful completion, duplicate completion idempotency and changed result conflict', t => {
  const f = fixture(); t.after(() => f.store.close()); const n = f.enroll(); const job = f.submit(); f.core.heartbeat(n.session.nodeId, heartbeat());
  const lease = f.core.lease(n.session.nodeId); assert(lease);
  const completion = { leaseId: lease.leaseId, result: { message: 'hello' } };
  f.core.complete(n.session.nodeId, job.id, completion);
  f.advance(100); f.core.complete(n.session.nodeId, job.id, completion);
  assert.throws(() => f.core.complete(n.session.nodeId, job.id, { ...completion, result: { message: 'different' } }), code('LEASE_CONFLICT'));
  const complete = f.core.getJob(f.app, job.id); assert.equal(complete.status, 'COMPLETED'); assert.deepEqual(complete.result, { message: 'hello' }); assert.equal(complete.attempts, 1);
});
test('lease expiry rejects late result even before reconciliation; retries and caps attempts', t => {
  const f = fixture(); t.after(() => f.store.close()); const n = f.enroll(); const job = f.submit(); f.core.heartbeat(n.session.nodeId, heartbeat());
  const first = f.core.lease(n.session.nodeId); assert(first); f.advance(50);
  assert.throws(() => f.core.complete(n.session.nodeId, job.id, { leaseId: first.leaseId, result: { message: 'hello' } }), code('LEASE_CONFLICT'));
  assert.equal(f.core.getJob(f.app, job.id).status, 'QUEUED');
  const second = f.core.lease(n.session.nodeId); assert(second); assert.notEqual(second.leaseId, first.leaseId); assert.equal(second.attempt, 2);
  assert.throws(() => f.core.complete(n.session.nodeId, job.id, { leaseId: first.leaseId, result: { message: 'hello' } }), code('LEASE_CONFLICT'));
  f.advance(50); const failed = f.core.getJob(f.app, job.id); assert.equal(failed.status, 'FAILED'); assert.equal(failed.error?.code, 'LEASE_EXPIRED');
  assert.equal(f.core.lease(n.session.nodeId), null);
});
test('lease fencing checks node, arbitrary lease IDs, malformed results and terminal failure', t => {
  const f = fixture(); t.after(() => f.store.close()); const a = f.enroll(); const b = f.enroll(); const job = f.submit(); f.core.heartbeat(a.session.nodeId, heartbeat());
  const lease = f.core.lease(a.session.nodeId); assert(lease);
  assert.throws(() => f.core.complete(b.session.nodeId, job.id, { leaseId: lease.leaseId, result: { message: 'x' } }), code('LEASE_CONFLICT'));
  assert.throws(() => f.core.complete(a.session.nodeId, job.id, { leaseId: randomUUID(), result: { message: 'x' } }), code('LEASE_CONFLICT'));
  assert.throws(() => f.core.complete(a.session.nodeId, job.id, { leaseId: lease.leaseId, result: { message: 2 } }));
  const failure = { leaseId: lease.leaseId, error: { code: 'HANDLER_FAILED' } };
  f.core.fail(a.session.nodeId, job.id, failure); f.core.fail(a.session.nodeId, job.id, failure);
  assert.equal(f.core.getJob(f.app, job.id).status, 'FAILED');
  assert.throws(() => f.core.complete(a.session.nodeId, job.id, { leaseId: lease.leaseId, result: { message: 'x' } }), code('LEASE_CONFLICT'));
});
test('revocation requeues live work with a new lease to another node', t => {
  const f = fixture(); t.after(() => f.store.close()); const a = f.enroll(); const b = f.enroll(); const job = f.submit();
  f.core.heartbeat(a.session.nodeId, heartbeat()); f.core.heartbeat(b.session.nodeId, heartbeat()); const first = f.core.lease(a.session.nodeId); assert(first);
  f.core.revokeNode(a.session.nodeId); assert.equal(f.core.getJob(f.app, job.id).status, 'QUEUED');
  const second = f.core.lease(b.session.nodeId); assert(second); assert.equal(second.attempt, 2);
  assert.throws(() => f.core.complete(a.session.nodeId, job.id, { leaseId: first.leaseId, result: { message: 'hello' } }), code('UNAUTHORIZED_NODE'));
  f.core.complete(b.session.nodeId, job.id, { leaseId: second.leaseId, result: { message: 'hello' } });
});
test('Coordinator restart preserves credentials, queued/leased/completed jobs and revocation', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'privanet-persistence-'));
  const path = join(directory, 'state.sqlite'); const f = fixture(new SqliteStore(path));
  const node = f.enroll(); const revoked = f.enroll(); f.core.revokeNode(revoked.session.nodeId);
  f.core.heartbeat(node.session.nodeId, heartbeat());
  const completed = f.submit('completed');
  const completion = f.core.lease(node.session.nodeId); assert(completion);
  f.core.complete(node.session.nodeId, completed.id, { leaseId: completion.leaseId, result: { message: 'completed' } });
  f.advance(1);
  const leased = f.submit('leased'); const active = f.core.lease(node.session.nodeId); assert(active);
  f.advance(1); const queued = f.submit('queued');
  const coordinatorId = f.store.coordinatorId; f.store.close();
  const store = new SqliteStore(path);
  // Windows cannot unlink an open SQLite file, and after-hooks run in registration order: close, then remove.
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const core = new Coordinator(store, { leaseMs: 50 }, f.now);
  const app = core.authenticateApplication(f.appCredential.token);
  assert.equal(store.coordinatorId, coordinatorId); assert.equal(core.authenticateNode(node.session.token).nodeId, node.session.nodeId);
  assert.equal(core.getJob(app, queued.id).status, 'QUEUED'); assert.equal(core.getJob(app, leased.id).status, 'LEASED');
  assert.deepEqual(core.getJob(app, completed.id).result, { message: 'completed' });
  core.complete(node.session.nodeId, completed.id, { leaseId: completion.leaseId, result: { message: 'completed' } });
  assert.equal(core.listNodes().find(n => n.nodeId === revoked.session.nodeId)?.status, 'REVOKED');
  f.advance(50); assert.equal(core.getJob(app, leased.id).status, 'QUEUED');
  assert.equal(core.submit(app, { type: 'system.echo.v1', input: { message: 'queued' }, idempotencyKey: store.getJob(queued.id)?.idempotencyKey }).id, queued.id);
});
test('checksummed migrations reject modified history and transactions roll back', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'privanet-migrations-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'db.sqlite'); const store = new SqliteStore(path);
  assert.throws(() => store.transaction(() => { store.saveGrant({ tokenHash: 'test', expiresAt: 1, capabilities: [], used: false }); throw new Error('rollback'); }));
  assert.equal(store.getGrant('test'), undefined); store.close();
  assert.throws(() => new SqliteStore(path, [{ version: 1, sql: migrations[0].sql + '\n-- changed' }]), /Applied migration changed/);
});

test('lowered retry policy after restart cannot issue an excess attempt', t => {
  const f = fixture(); t.after(() => f.store.close()); const node = f.enroll(); const job = f.submit();
  f.core.heartbeat(node.session.nodeId, heartbeat()); assert(f.core.lease(node.session.nodeId));
  f.advance(50); assert.equal(f.core.getJob(f.app, job.id).status, 'QUEUED');
  const restarted = new Coordinator(f.store, { ...f.core.policy, maxAttempts: 1 }, f.now);
  assert.equal(restarted.lease(node.session.nodeId), null);
  assert.equal(restarted.getJob(f.app, job.id).status, 'FAILED');
  assert.equal(restarted.getJob(f.app, job.id).attempts, 1);
});

test('a work event wakes at most one waiter per capable node, never one that cannot run the job, and unsubscribing is safe', async t => {
  const f = fixture(); t.after(() => f.store.close());
  const a = f.enroll(); const b = f.enroll(); const c = f.enroll(['system.hashchain.v1']);
  const woken = new Map<string, number>(); const off: (() => void)[] = [];
  const wait = (nodeId: string, capabilities: string[], lanes: number) => { for (let i = 0; i < lanes; i++) off.push(f.core.onWork(nodeId, capabilities, () => woken.set(nodeId, (woken.get(nodeId) ?? 0) + 1))); };
  wait(a.session.nodeId, ['system.echo.v1'], 3); wait(b.session.nodeId, ['system.echo.v1'], 2); wait(c.session.nodeId, ['system.hashchain.v1'], 2);
  const settle = () => new Promise<void>(resolve => setImmediate(resolve));
  f.submit('one'); await settle();
  assert.deepEqual([woken.get(a.session.nodeId), woken.get(b.session.nodeId), woken.get(c.session.nodeId)], [1, 1, undefined], 'one lane of each capable node, none of the incapable one');
  f.submit('two'); await settle();
  assert.deepEqual([woken.get(a.session.nodeId), woken.get(b.session.nodeId)], [2, 2]);
  f.submit('three'); await settle();
  assert.deepEqual([woken.get(a.session.nodeId), woken.get(b.session.nodeId)], [3, 2], 'a node with no waiting lane left is skipped');
  f.submit('four'); await settle();
  assert.equal(woken.get(a.session.nodeId), 3, 'woken waiters are gone; nothing wakes twice');
  for (const unsubscribe of off) unsubscribe(); // already-woken waiters unsubscribe again without harm
  f.submit('five'); await settle();
  assert.equal(woken.get(a.session.nodeId), 3);
});

test('lease attempts that find nothing are cheap: they neither write nor change any job', t => {
  const f = fixture(); t.after(() => f.store.close()); const n = f.enroll(); f.core.heartbeat(n.session.nodeId, heartbeat());
  for (let i = 0; i < 50; i++) assert.equal(f.core.lease(n.session.nodeId), null);
  const job = f.submit(); const lease = f.core.lease(n.session.nodeId); assert(lease); assert.equal(lease.jobId, job.id);
  assert.equal(f.core.lease(n.session.nodeId), null, 'a leased job is not handed out twice');
  f.advance(200); // the lease (50 ms) expired: the same call that sweeps it also re-offers it
  const again = f.core.lease(n.session.nodeId); assert(again); assert.equal(again.jobId, job.id); assert.equal(again.attempt, 2);
});
