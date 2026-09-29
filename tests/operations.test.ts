import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Coordinator } from '@privanet/coordinator/service';
import { SqliteStore } from '@privanet/coordinator/store';
import { ApiError } from '@privanet/shared';
import { fixture, heartbeat, identity } from './helpers.js';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));
const code = (expected: string, status: number) => (error: unknown) => error instanceof ApiError && error.code === expected && error.status === status;

test('per-application queue quota rejects new work with 429 but still replays existing idempotent submissions', t => {
  const f = fixture(); t.after(() => f.store.close());
  const limited = new Coordinator(f.store, { staleMs: 100, offlineMs: 500, leaseMs: 50, maxAttempts: 2, sessionMs: 1000, challengeMs: 100, maxPendingPerApplication: 2 }, f.now);
  const submit = (key: string) => limited.submit(f.app, { type: 'system.echo.v1', input: { message: key }, idempotencyKey: key });
  const first = submit('a'); submit('b');
  assert.throws(() => submit('c'), code('QUEUE_LIMIT', 429));
  assert.equal(submit('a').id, first.id); // a retry of an accepted submission is not a new job
  const a = f.enroll(); f.core.heartbeat(a.session.nodeId, heartbeat());
  const lease = limited.lease(a.session.nodeId); assert.ok(lease); // leased jobs still count as pending
  assert.throws(() => submit('d'), code('QUEUE_LIMIT', 429));
  limited.complete(a.session.nodeId, lease.jobId, { leaseId: lease.leaseId, result: { message: 'a' } });
  assert.doesNotThrow(() => submit('d')); // finishing work frees quota
});

test('retention deletes finished jobs after the configured age and never touches pending work', t => {
  const f = fixture(); t.after(() => f.store.close());
  const core = new Coordinator(f.store, { staleMs: 100000, offlineMs: 500000, leaseMs: 5000, maxAttempts: 2, sessionMs: 100000, challengeMs: 100, retentionMs: 60000 }, f.now);
  const a = f.enroll(); core.heartbeat(a.session.nodeId, heartbeat());
  const done = core.submit(f.app, { type: 'system.echo.v1', input: { message: 'done' }, idempotencyKey: 'done' });
  const lease = core.lease(a.session.nodeId); assert.ok(lease);
  core.complete(a.session.nodeId, lease.jobId, { leaseId: lease.leaseId, result: { message: 'done' } });
  const pending = core.submit(f.app, { type: 'system.echo.v1', input: { message: 'pending' }, idempotencyKey: 'pending' });
  f.advance(30000); core.maintain(); assert.equal(core.getJob(f.app, done.id).status, 'COMPLETED'); // younger than the retention age
  f.advance(31000); core.maintain();
  assert.throws(() => core.getJob(f.app, done.id), code('NOT_FOUND', 404));
  assert.equal(core.getJob(f.app, pending.id).status, 'QUEUED');
  const keep = new Coordinator(f.store, { retentionMs: 0 }, f.now); f.advance(10 * 86400000);
  assert.equal(keep.getJob(f.app, pending.id).status, 'QUEUED'); // retention 0 keeps everything forever
});

test('online backup restores into a working Coordinator with the same identity, results and pending work', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'privanet-backup-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const dataDir = join(dir, 'data'); await mkdir(dataDir, { mode: 0o700 });
  const live = new SqliteStore(join(dataDir, 'coordinator.sqlite')); let now = 5_000_000; const core = new Coordinator(live, { staleMs: 1e9, offlineMs: 2e9, leaseMs: 1e6 }, () => now);
  const credential = core.createApplication({ name: 'backup', allowedJobTypes: ['system.echo.v1'] }); const app = core.authenticateApplication(credential.token);
  const finished = core.submit(app, { type: 'system.echo.v1', input: { message: 'finished' }, idempotencyKey: 'f' });
  const key = identity(); const grant = core.createEnrollment({ expiresInMs: 1e6, capabilities: ['system.echo.v1'] });
  const session = core.prove(key.proof(core.beginEnrollment({ token: grant.token, publicKey: key.publicKey, protocolVersion: 1, daemonVersion: '0.2.1', capabilities: ['system.echo.v1'] })), 'enroll');
  core.heartbeat(session.nodeId, heartbeat()); const lease = core.lease(session.nodeId); assert.ok(lease);
  core.complete(session.nodeId, lease.jobId, { leaseId: lease.leaseId, result: { message: 'finished' } });
  const pending = core.submit(app, { type: 'system.echo.v1', input: { message: 'pending' }, idempotencyKey: 'p' });
  // The Coordinator is still running (store open) while the backup is taken.
  const backup = join(dir, 'backup.sqlite'); const env = { ...process.env, PRIVANET_DATA_DIR: dataDir };
  const out = await exec(process.execPath, ['scripts/backup.mjs', backup], { cwd: root, env });
  assert.match(out.stdout, /backup\.created/);
  if (process.platform !== 'win32') assert.equal((await stat(backup)).mode & 0o077, 0);
  await assert.rejects(exec(process.execPath, ['scripts/backup.mjs', backup], { cwd: root, env })); // never overwrites
  await assert.rejects(exec(process.execPath, ['scripts/backup.mjs'], { cwd: root, env })); // needs a destination
  const coordinatorId = live.coordinatorId; live.close();
  const restored = new SqliteStore(backup); t.after(() => restored.close());
  const recovered = new Coordinator(restored, { staleMs: 1e9, offlineMs: 2e9, leaseMs: 1e6 }, () => now);
  assert.equal(restored.coordinatorId, coordinatorId);
  const again = recovered.authenticateApplication(credential.token); assert.equal(again.id, app.id); // credential hashes survive
  assert.deepEqual(recovered.getJob(again, finished.id).result, { message: 'finished' });
  assert.equal(recovered.getJob(again, pending.id).status, 'QUEUED');
  assert.equal(recovered.listNodes()[0]?.nodeId, session.nodeId);
  now += 10; const retry = recovered.submit(again, { type: 'system.echo.v1', input: { message: 'pending' }, idempotencyKey: 'p' }); assert.equal(retry.id, pending.id); // idempotency survives
  // A corrupt destination location or missing source fails closed.
  await writeFile(join(dir, 'file'), 'x');
  await assert.rejects(exec(process.execPath, ['scripts/backup.mjs', join(dir, 'x', 'y.sqlite')], { cwd: root, env }));
  await assert.rejects(exec(process.execPath, ['scripts/backup.mjs', join(dir, 'z.sqlite')], { cwd: root, env: { ...env, PRIVANET_DATA_DIR: join(dir, 'missing') } }));
});

test('lease renewal is fenced to the assigned node and lease, extends only a live lease, and is bounded in total', t => {
  const f = fixture(); t.after(() => f.store.close());
  const core = new Coordinator(f.store, { staleMs: 1e5, offlineMs: 5e5, leaseMs: 100, maxAttempts: 2, sessionMs: 1e5, challengeMs: 100, maxLeaseMs: 250 }, f.now);
  const a = f.enroll(); const b = f.enroll(); core.heartbeat(a.session.nodeId, heartbeat()); core.heartbeat(b.session.nodeId, heartbeat());
  const job = core.submit(f.app, { type: 'system.echo.v1', input: { message: 'long' }, idempotencyKey: 'long' });
  const lease = core.lease(a.session.nodeId); assert.ok(lease); const first = lease.expiresAt;
  const renew = (node: string, leaseId = lease.leaseId) => core.renew(node, job.id, { leaseId });
  assert.throws(() => renew(b.session.nodeId), code('LEASE_CONFLICT', 409)); // another node cannot extend it
  assert.throws(() => renew(a.session.nodeId, '99999999-9999-4999-8999-999999999999'), code('LEASE_CONFLICT', 409));
  assert.throws(() => core.renew(a.session.nodeId, job.id, { leaseId: lease.leaseId, expiresAt: 1 }), /./); // the node never chooses the deadline
  f.advance(60); assert.equal(renew(a.session.nodeId).expiresAt, first + 60); // now + leaseMs
  f.advance(90); assert.equal(renew(a.session.nodeId).expiresAt, first + 150); // capped at leasedAt + maxLeaseMs (250 ms), not now + 100
  f.advance(60); assert.equal(renew(a.session.nodeId).expiresAt, first + 150); // at the ceiling: no further extension
  f.advance(60); assert.throws(() => renew(a.session.nodeId), code('LEASE_CONFLICT', 409)); // expired leases cannot be revived
  core.maintain(); assert.equal(core.getJob(f.app, job.id).status, 'QUEUED');
});
