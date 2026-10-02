import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrations } from '@privanet/coordinator/migrations';
import { Coordinator } from '@privanet/coordinator/service';
import { SqliteStore } from '@privanet/coordinator/store';
import { TransferKeyring } from '@privanet/coordinator/transfer-keys';
import { hash } from '@privanet/shared';
import { identity } from './helpers.js';
import { refusal } from './storage-rig.js';

const V1 = migrations.slice(0, 1);
async function tmp(t: { after: (fn: () => Promise<void>) => void }) { const dir = await mkdtemp(join(tmpdir(), 'privanet-migrate-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }
const tables = (db: DatabaseSync) => db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => String(row.name));

/** A database exactly as an 0.4.0-alpha.1 (or v0.3.6) Coordinator leaves it: migration 1 only, with nodes, an application, jobs, grants and sessions in it. */
function populateV1(path: string) {
  const store = new SqliteStore(path, V1); let now = 1_800_000_000_000;
  const core = new Coordinator(store, { staleMs: 15000, offlineMs: 60000, sessionMs: 3_600_000 }, () => now);
  const key = identity(); const grant = core.createEnrollment({ expiresInMs: 60000, capabilities: ['system.echo.v1'] });
  const challenge = core.beginEnrollment({ token: grant.token, publicKey: key.publicKey, protocolVersion: 1, daemonVersion: '0.4.0-alpha.1', capabilities: ['system.echo.v1'] });
  const session = core.prove(key.proof(challenge), 'enroll');
  // (an 0.4.0-alpha.1 node's heartbeat, written the way that release wrote it: this code's heartbeat would touch the storage tables a version 1 database does not have)
  const record = store.getNode(session.nodeId); assert(record); store.saveNode({ ...record, jobSlots: 2, daemonVersion: '0.4.0-alpha.1', lastHeartbeatAt: now });
  const withFetch = core.createApplication({ name: 'crawler', allowedJobTypes: ['web.fetch.v1', 'system.echo.v1'], fetchIdentity: { product: 'TestBot', infoUrl: 'https://example.com/bot' } });
  const plain = core.createApplication({ name: 'plain', allowedJobTypes: ['system.echo.v1'] });
  const app = core.authenticateApplication(plain.token); const job = core.submit(app, { type: 'system.echo.v1', input: { message: 'queued before the upgrade' }, idempotencyKey: 'old-1' });
  const invite = core.createEnrollment({ expiresInMs: 600000, capabilities: ['system.echo.v1'] });
  now += 1000; const info = { nodeId: session.nodeId, withFetch, plain, jobId: job.id, inviteToken: invite.token, sessionToken: session.token, coordinatorId: store.coordinatorId, now };
  store.close(); return info;
}

test('a version 1 database upgrades in place to version 2: nothing existing changes, nothing gains storage rights, and the new tables are empty', async t => {
  const path = join(await tmp(t), 'coordinator.sqlite'); const old = populateV1(path);
  const before = new DatabaseSync(path, { readOnly: true }); const snapshot = Object.fromEntries(['nodes', 'applications', 'jobs', 'grants', 'sessions'].map(name => [name, before.prepare(`SELECT * FROM ${name} ORDER BY 1`).all()])); const ids = before.prepare("SELECT value FROM metadata WHERE key='coordinator_id'").get(); before.close();
  const store = new SqliteStore(path); // the full migration list
  assert.equal(store.coordinatorId, old.coordinatorId);
  const db = new DatabaseSync(path, { readOnly: true });
  assert.deepEqual(db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map(row => Number(row.version)), [1, 2]);
  for (const name of ['chunk', 'replica', 'transfer', 'node_service']) { assert(tables(db).includes(name), name); assert.equal(Number(db.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get()?.n), 0); }
  for (const [name, rows] of Object.entries(snapshot)) assert.deepEqual(db.prepare(`SELECT * FROM ${name} ORDER BY 1`).all(), rows, `${name} changed`);
  assert.deepEqual(db.prepare("SELECT value FROM metadata WHERE key='coordinator_id'").get(), ids); db.close();
  const core = new Coordinator(store, { staleMs: 15000, offlineMs: 60000, sessionMs: 3_600_000 }, () => old.now);
  assert.equal(core.listNodes().length, 1); assert.equal(core.listNodes()[0]?.nodeId, old.nodeId); assert.equal(core.getJob(core.authenticateApplication(old.plain.token), old.jobId).status, 'QUEUED'); // jobs intact
  assert.equal(core.authenticateNode(old.sessionToken).nodeId, old.nodeId); // the node's session still works
  assert.equal(core.authenticateApplication(old.withFetch.token).allowedJobTypes.length, 2);
  for (const token of [old.plain.token, old.withFetch.token]) { const app = core.authenticateApplication(token); assert.equal(app.allowedServices, undefined); assert.equal(refusal(() => core.storage.place(app, { chunkId: `chk_${'ab'.repeat(32)}`, size: 5, holderKey: 'MCowBQYDK2VwAyEA6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iw=' })).code, 'SERVICE_FORBIDDEN'); }
  assert.equal(core.createEnrollment({ expiresInMs: 1000, capabilities: ['system.echo.v1'] }).token.length, 64); store.close();
});
test('the upgraded database keeps working for jobs: the node leases and completes a job queued before the upgrade', async t => {
  const path = join(await tmp(t), 'coordinator.sqlite'); const old = populateV1(path); const store = new SqliteStore(path); let now = old.now;
  const core = new Coordinator(store, { staleMs: 15000, offlineMs: 60000, sessionMs: 3_600_000, leaseMs: 5000 }, () => now);
  core.heartbeat(old.nodeId, { protocolVersion: 1, daemonVersion: '0.4.0-alpha.2', capabilities: ['system.echo.v1'], jobSlots: 1, currentJobs: 0 });
  const lease = core.lease(old.nodeId); assert(lease); assert.equal(lease.jobId, old.jobId); now += 10;
  core.complete(old.nodeId, lease.jobId, { leaseId: lease.leaseId, result: { message: 'queued before the upgrade' } });
  assert.equal(core.getJob(core.authenticateApplication(old.plain.token), old.jobId).status, 'COMPLETED'); store.close();
});
test('migrations are applied once, in order, inside a transaction: a failing version 2 leaves a usable version 1 database and no half-created tables', async t => {
  const path = join(await tmp(t), 'coordinator.sqlite'); const old = populateV1(path);
  const broken = [...V1, { version: 2, sql: `CREATE TABLE chunk (application_id TEXT PRIMARY KEY) STRICT;\nCREATE TABLE transfer (id TEXT PRIMARY KEY) STRICT;\nTHIS IS NOT SQL;` }];
  assert.throws(() => new SqliteStore(path, broken));
  const db = new DatabaseSync(path, { readOnly: true }); assert.deepEqual(db.prepare('SELECT version FROM schema_migrations').all().map(row => Number(row.version)), [1]); for (const name of ['chunk', 'transfer', 'replica', 'node_service']) assert.equal(tables(db).includes(name), false, name); db.close();
  const reopened = new SqliteStore(path, V1); const core = new Coordinator(reopened, { staleMs: 15000, offlineMs: 60000 }, () => old.now); assert.equal(core.listNodes().length, 1); reopened.close();
  const again = new SqliteStore(path); assert.equal(new DatabaseSync(path, { readOnly: true }).prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()?.n, 2); again.close(); // and the real migration applies afterwards
});
test('downgrade is refused honestly: an older Coordinator will not open a version 2 database, and an edited applied migration is detected', async t => {
  const path = join(await tmp(t), 'coordinator.sqlite'); new SqliteStore(path).close();
  assert.throws(() => new SqliteStore(path, V1), /schema is newer than service/);
  const edited = [{ version: 1, sql: migrations[0].sql }, { version: 2, sql: `${migrations[1].sql}\n-- edited` }]; assert.throws(() => new SqliteStore(path, edited), /Applied migration changed/);
  const editedFirst = [{ version: 1, sql: `${migrations[0].sql}\n-- edited` }, { version: 2, sql: migrations[1].sql }]; assert.throws(() => new SqliteStore(path, editedFirst), /Applied migration changed/);
  assert.throws(() => new SqliteStore(path, [migrations[0], { version: 3, sql: 'SELECT 1' }]));
  assert.equal(hash(migrations[0]?.sql ?? '').length, 64); assert.equal(migrations.length, 2);
  new SqliteStore(path).close(); // the right list still opens it
});
test('version 1 migration text is byte-identical to the previous release (its checksum is what an upgraded database holds)', t => {
  let base: string; try { base = execFileSync('git', ['show', 'v0.3.6:apps/coordinator/src/migrations.ts'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { if (process.env.PRIVANET_REQUIRE_COMPAT_TAG === '1') throw new Error('the v0.3.6 tag is required'); t.skip('the v0.3.6 tag is not in this clone (git fetch --tags)'); return; }
  const sql = /version: 1, sql: `([\s\S]*?)` \}/.exec(base)?.[1]; assert(sql); assert.equal(hash(sql), hash(migrations[0]?.sql ?? ''));
});
test('the schema enforces its own invariants: states, sizes, foreign keys and single-row keys', async t => {
  const path = join(await tmp(t), 'coordinator.sqlite'); const old = populateV1(path); const store = new SqliteStore(path); store.close();
  const db = new DatabaseSync(path); db.exec('PRAGMA foreign_keys=ON');
  const appId = String(db.prepare('SELECT id FROM applications LIMIT 1').get()?.id); const chunkId = `chk_${'ab'.repeat(32)}`;
  const insertChunk = (state: string, size: number, id = chunkId) => db.prepare('INSERT INTO chunk (application_id, chunk_id, size, class, state, created_at, updated_at, expires_at) VALUES (?,?,?,?,?,?,?,?)').run(appId, id, size, null, state, 1, 1, null);
  assert.throws(() => insertChunk('STORING', 5)); assert.throws(() => insertChunk('PENDING', 0)); assert.throws(() => insertChunk('PENDING', 8 * 1024 * 1024 + 1)); assert.throws(() => insertChunk('PENDING', 5, 'chk_short'));
  assert.throws(() => db.prepare('INSERT INTO chunk (application_id, chunk_id, size, class, state, created_at, updated_at, expires_at) VALUES (?,?,?,?,?,?,?,?)').run('no-such-application', chunkId, 5, null, 'PENDING', 1, 1, null));
  insertChunk('PENDING', 5); assert.throws(() => insertChunk('PENDING', 5)); // one logical entry per (application, chunk)
  assert.throws(() => db.prepare("INSERT INTO replica (application_id, chunk_id, node_id, state, size, reserved_at) VALUES (?,?,?,?,?,?)").run(appId, `chk_${'cd'.repeat(32)}`, old.nodeId, 'RESERVED', 5, 1)); // a replica needs its chunk
  assert.throws(() => db.prepare("INSERT INTO replica (application_id, chunk_id, node_id, state, size, reserved_at) VALUES (?,?,?,?,?,?)").run(appId, chunkId, old.nodeId, 'GONE', 5, 1));
  db.prepare("INSERT INTO replica (application_id, chunk_id, node_id, state, size, reserved_at) VALUES (?,?,?,?,?,?)").run(appId, chunkId, old.nodeId, 'RESERVED', 5, 1);
  assert.throws(() => db.prepare("INSERT INTO node_service (node_id, service, capacity_bytes, free_bytes, max_chunk_bytes, reported_at) VALUES (?,?,?,?,?,?)").run(old.nodeId, 'storage.other.v1', 1, 1, 1, 1));
  assert.throws(() => db.prepare("INSERT INTO node_service (node_id, service, capacity_bytes, free_bytes, max_chunk_bytes, reported_at) VALUES (?,?,?,?,?,?)").run(old.nodeId, 'storage.chunk.v1', -1, 1, 1, 1));
  assert.throws(() => db.prepare("INSERT INTO transfer (id, operation, application_id, chunk_id, node_id, kid, holder_hash, max_bytes, state, issued_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)").run('ab'.repeat(16), 'list', appId, chunkId, old.nodeId, 'k', 'h', 5, 'AUTHORIZED', 1, 2));
  assert.throws(() => db.prepare("INSERT INTO transfer (id, operation, application_id, chunk_id, node_id, kid, holder_hash, max_bytes, state, issued_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)").run('ab'.repeat(16), 'put', appId, chunkId, old.nodeId, 'k', 'h', 5, 'DONE', 1, 2));
  db.close();
});
test('indexes exist for the access patterns the control plane actually uses', async t => {
  const path = join(await tmp(t), 'coordinator.sqlite'); new SqliteStore(path).close(); const db = new DatabaseSync(path, { readOnly: true });
  const names = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map(row => String(row.name)));
  for (const name of ['transfer_state_expiry', 'transfer_chunk', 'transfer_node', 'transfer_app', 'replica_node_state']) assert(names.has(name), name);
  const plan = (sql: string) => db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map(row => String(row.detail)).join(' | ');
  assert.match(plan("SELECT * FROM transfer WHERE state IN ('AUTHORIZED','IN_PROGRESS') AND node_id='x'"), /USING (COVERING )?INDEX/);
  assert.match(plan("SELECT * FROM chunk WHERE application_id='a' AND chunk_id='b'"), /PRIMARY KEY|USING/); assert.match(plan("SELECT * FROM replica WHERE node_id='n' AND state='RESERVED'"), /replica_node_state/);
  assert.match(plan("SELECT * FROM transfer WHERE state='AUTHORIZED' AND expires_at<=5"), /transfer_state_expiry/); db.close();
});
test('backup and restore carry the storage metadata, but never the signing key: open transfers cannot be completed under a new key, and overdue ones expire at the first sweep', async t => {
  const dir = await tmp(t); const path = join(dir, 'coordinator.sqlite'); let now = 1_800_000_000_000;
  const store = new SqliteStore(path); const ring = await TransferKeyring.open(dir, () => now); const core = new Coordinator(store, { staleMs: 15000, offlineMs: 60000, sessionMs: 3_600_000 }, () => now, undefined, { transferKeys: ring });
  const key = identity(); const grant = core.createEnrollment({ expiresInMs: 60000, capabilities: ['system.echo.v1'] }); const session = core.prove(key.proof(core.beginEnrollment({ token: grant.token, publicKey: key.publicKey, protocolVersion: 1, daemonVersion: '0.4.0', capabilities: ['system.echo.v1'] })), 'enroll');
  core.heartbeat(session.nodeId, { protocolVersion: 1, daemonVersion: '0.4.0', capabilities: ['system.echo.v1'], jobSlots: 1, currentJobs: 0, services: { 'storage.chunk.v1': { capacityBytes: 1e9, freeBytes: 1e9, maxChunkBytes: 8388608 } } });
  const created = core.createApplication({ name: 'drive', allowedJobTypes: [], allowedServices: ['storage.chunk.v1'] }); const app = core.authenticateApplication(created.token); const { generateHolderKey } = await import('@privanet/shared'); const holder = generateHolderKey();
  const stored = `chk_${'01'.repeat(32)}`; const pending = `chk_${'02'.repeat(32)}`;
  const g1 = core.storage.place(app, { chunkId: stored, size: 100, holderKey: holder.publicKey }).grant; assert(g1);
  core.storage.complete(session.nodeId, { transferId: g1.transferId, operation: 'put', applicationId: app.id, chunkId: stored, bytes: 100, sha256: '01'.repeat(32), nodeId: session.nodeId, completedAt: now });
  const g2 = core.storage.place(app, { chunkId: pending, size: 50, holderKey: holder.publicKey }).grant; assert(g2);
  store.close(); const backup = join(dir, 'backup.sqlite'); execFileSync(process.execPath, ['scripts/backup.mjs', backup], { env: { ...process.env, PRIVANET_DATA_DIR: dir }, stdio: 'pipe' });
  // restore onto a "new machine": the database file only, so a NEW keyring is generated
  const restored = await tmp(t); await copyFile(backup, join(restored, 'coordinator.sqlite')); const store2 = new SqliteStore(join(restored, 'coordinator.sqlite')); const ring2 = await TransferKeyring.open(restored, () => now);
  assert.notEqual(ring2.currentKid, ring.currentKid);
  const core2 = new Coordinator(store2, { staleMs: 15000, offlineMs: 60000, sessionMs: 3_600_000 }, () => now, undefined, { transferKeys: ring2 });
  assert.equal(store2.getChunk(app.id, stored)?.state, 'STORED'); assert.equal(store2.getChunk(app.id, pending)?.state, 'PENDING'); assert.equal(store2.getReplica(app.id, stored, session.nodeId)?.state, 'STORED'); assert.equal(store2.getTransfer(g2.transferId)?.state, 'AUTHORIZED');
  assert.equal(JSON.stringify(store2.getTransfer(g2.transferId)).includes(g2.ticket), false); // the ticket was never in the database, so it cannot come back with a restore
  assert.equal((await import('@privanet/shared')).verifyTicket(g2.ticket, { keys: core2.storage.transferKeys(core2.store.coordinatorId).keys, now, expect: { nodeId: session.nodeId } }).ok, false); // and the old ticket means nothing to the new key
  now += 130_000; core2.maintain(); assert.equal(store2.getTransfer(g2.transferId)?.state, 'EXPIRED'); assert.equal(store2.getChunk(app.id, stored)?.state, 'STORED'); // overdue transfers expire; stored metadata is untouched
  // nodes reconnect on their own heartbeat: until then the restored advertisement is stale and nothing is placed on it
  assert.equal(refusal(() => core2.storage.place(app, { chunkId: `chk_${'03'.repeat(32)}`, size: 10, holderKey: holder.publicKey })).code, 'NO_CAPACITY'); store2.close();
  const raw = await readFile(backup); assert.equal(raw.includes(Buffer.from(JSON.parse(await readFile(join(dir, 'transfer-keys.json'), 'utf8')).keys[0].privateKey)), false);
});
