import test from 'node:test';
import assert from 'node:assert/strict';
import { TICKET_MAX_LIFETIME_MS } from '@privanet/protocol';
import { parseTicket } from '@privanet/shared';
import { FINAL_TRANSFER_STATES, PENDING_CHUNK_TTL_MS, STORAGE_SWEEP_MS, TRANSFER_PROGRESS_GRACE_MS, TRANSFER_RETENTION_MS, TRANSFER_TRANSITIONS, canTransition, defaultStorageLimits } from '@privanet/coordinator/storage';
import type { TransferState } from '@privanet/protocol';
import { GIB, MIB, refusal, storageRig } from './storage-rig.js';
import type { StorageRig } from './storage-rig.js';

const STATES: TransferState[] = ['AUTHORIZED', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'EXPIRED', 'REVOKED'];
/** One app with storage and one storage node, ready to place on. */
async function one(t: Parameters<typeof storageRig>[0], options: Parameters<typeof storageRig>[1] = {}) {
  const rig = await storageRig(t, options); const app = rig.app(); const node = rig.node(); return { rig, app, node, holder: rig.holder() };
}
const place = (rig: StorageRig, app: { record: Parameters<StorageRig['core']['storage']['place']>[0] }, chunk: { id: string; size: number }, holderKey: string, extra: object = {}) =>
  rig.core.storage.place(app.record, { chunkId: chunk.id, size: chunk.size, holderKey, ...extra });

test('an application with no allowedServices has no storage authority at all, whatever job types it holds', async t => {
  const rig = await storageRig(t); rig.node(); const app = rig.app([], ['web.fetch.v1', 'system.echo.v1']); const holder = rig.holder(); const chunk = rig.chunk();
  assert.deepEqual(app.record.allowedServices, undefined);
  for (const call of [() => place(rig, app, chunk, holder.publicKey), () => rig.core.storage.ticket(app.record, { operation: 'get', chunkId: chunk.id, holderKey: holder.publicKey }), () => rig.core.storage.chunkStatus(app.record, chunk.id),
    () => rig.core.storage.abort(app.record, 'ab'.repeat(16))]) assert.deepEqual(refusal(call), { status: 403, code: 'SERVICE_FORBIDDEN', message: 'service forbidden' });
  assert.equal(rig.store.chunkUsage(app.record.id).count, 0);
});
test('storage permission grants no jobs, and job permission grants no storage', async t => {
  const rig = await storageRig(t); const storageOnly = rig.app(['storage.chunk.v1'], []);
  assert.equal(refusal(() => rig.core.submit(storageOnly.record, { type: 'system.echo.v1', input: { message: 'x' }, idempotencyKey: 'k1' })).code, 'JOB_TYPE_FORBIDDEN');
  assert.throws(() => rig.core.submit(storageOnly.record, { type: 'storage.chunk.v1', input: {}, idempotencyKey: 'k2' })); // not a job type at all: the schema refuses it before authorization is even asked
  assert.deepEqual(rig.core.capabilities(storageOnly.record), { capabilities: [] }); // the job capabilities listing never mentions a service
  assert.equal(rig.store.listPendingJobs().length, 0);
});
test('a record written before services existed (no field at all) keeps exactly its old authority: none', async t => {
  const rig = await storageRig(t); const legacy = rig.app([], ['system.echo.v1']);
  const raw = JSON.parse(JSON.stringify(legacy.record)) as Record<string, unknown>; delete raw.allowedServices; rig.store.saveApplication(raw as unknown as typeof legacy.record);
  const reread = rig.core.authenticateApplication(legacy.token); assert.equal('allowedServices' in reread, false);
  assert.equal(refusal(() => rig.core.storage.place(reread, { chunkId: rig.chunk().id, size: 5, holderKey: rig.holder().publicKey })).code, 'SERVICE_FORBIDDEN');
  // creating with an explicit empty list stores nothing extra either
  const empty = rig.core.createApplication({ name: 'x', allowedJobTypes: [], allowedServices: [] }); assert.equal('allowedServices' in rig.core.authenticateApplication(empty.token), false);
});
test('storage routes need the signing key: without it everything answers 503 and nothing else changes', async t => {
  const rig = await storageRig(t, { keyring: false }); const app = rig.app(['storage.chunk.v1'], ['system.echo.v1']); rig.node();
  assert.equal(refusal(() => rig.core.storage.place(app.record, { chunkId: rig.chunk().id, size: 5, holderKey: rig.holder().publicKey })).code, 'STORAGE_UNAVAILABLE');
  assert.equal(refusal(() => rig.core.storage.transferKeys(rig.core.store.coordinatorId)).code, 'STORAGE_UNAVAILABLE');
  assert.equal(rig.core.submit(app.record, { type: 'system.echo.v1', input: { message: 'hi' }, idempotencyKey: 'ok' }).status, 'QUEUED'); // jobs are unaffected
});

test('placement: the Coordinator picks the node, reserves, signs a verifiable put ticket, and stores no ticket', async t => {
  const { rig, app, node, holder } = await one(t); const chunk = rig.chunk(4096);
  const placed = place(rig, app, chunk, holder.publicKey, { class: 'drive-chunk' });
  assert.equal(placed.state, 'PENDING'); assert(placed.grant); assert.equal(placed.grant.operation, 'put'); assert.equal(placed.grant.expiresAt, rig.clock.t + TICKET_MAX_LIFETIME_MS);
  const verdict = rig.verify(placed.grant.ticket, node.nodeId, { operation: 'put', chunkId: chunk.id, applicationId: app.record.id, size: 4096 });
  assert.equal(verdict.ok, true); if (!verdict.ok) return;
  assert.deepEqual({ ...verdict.claims, nonce: '', kid: '' }, { kid: '', transferId: placed.grant.transferId, operation: 'put', applicationId: app.record.id, chunkId: chunk.id, nodeId: node.nodeId, maxBytes: 4096, issuedAt: rig.clock.t, expiresAt: rig.clock.t + TICKET_MAX_LIFETIME_MS, holderKey: holder.publicKey, nonce: '' });
  const stored = rig.store.getChunk(app.record.id, chunk.id); assert.equal(stored?.state, 'PENDING'); assert.equal(stored?.class, 'drive-chunk');
  assert.equal(rig.store.getReplica(app.record.id, chunk.id, node.nodeId)?.state, 'RESERVED');
  const transfer = rig.store.getTransfer(placed.grant.transferId); assert.equal(transfer?.state, 'AUTHORIZED'); assert.equal(transfer?.kid, verdict.claims.kid);
  assert.notEqual(transfer?.holderHash, holder.publicKey); // a hash of the key, not the key
  assert.equal(JSON.stringify(transfer).includes(placed.grant.ticket), false);
  assert.equal(parseTicket(placed.grant.ticket)?.claims.transferId, placed.grant.transferId);
});
test('placing makes the chunk PENDING only: neither a placement, a ticket nor the application saying so makes it STORED', async t => {
  const { rig, app, node, holder } = await one(t); const chunk = rig.chunk(); const placed = place(rig, app, chunk, holder.publicKey); assert(placed.grant);
  assert.equal(rig.core.storage.chunkStatus(app.record, chunk.id).state, 'PENDING'); assert.equal(rig.core.storage.chunkStatus(app.record, chunk.id).available, false);
  assert.equal(refusal(() => rig.core.storage.ticket(app.record, { operation: 'get', chunkId: chunk.id, holderKey: holder.publicKey })).code, 'CHUNK_NOT_STORED');
  rig.core.storage.abort(app.record, placed.grant.transferId); // the application's own report is only ever a withdrawal
  assert.equal(rig.store.getChunk(app.record.id, chunk.id), undefined); assert.equal(node.nodeId.startsWith('node_'), true);
});
test('placement refuses nothing it should accept and everything it should not: size, class, key and ids are validated before any state changes', async t => {
  const { rig, app, holder } = await one(t); const chunk = rig.chunk();
  const bad = [{ size: 0 }, { size: 8 * MIB + 1 }, { size: 1.5 }, { chunkId: 'chk_nothex' }, { class: 'Bad Class' }, { holderKey: 'AAAA' }, { nodeId: 'node_x' }, { path: '/etc' }];
  for (const extra of bad) assert.throws(() => rig.core.storage.place(app.record, { chunkId: chunk.id, size: 10, holderKey: holder.publicKey, ...extra }), /./, JSON.stringify(extra));
  const rsa = (await import('node:crypto')).generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'der', type: 'spki' }).toString('base64').slice(0, 60);
  assert.equal(refusal(() => rig.core.storage.place(app.record, { chunkId: chunk.id, size: 10, holderKey: rsa })).code, 'INVALID_HOLDER_KEY');
  assert.equal(rig.store.chunkUsage(app.record.id).count, 0);
  assert.equal(place(rig, app, { id: chunk.id, size: 8 * MIB }, holder.publicKey).state, 'PENDING'); // exactly 8 MiB is fine
});
test('eligibility: offline, stale, draining, paused, revoked, service-less, too-small and capacity-short nodes are never chosen', async t => {
  const rig = await storageRig(t); const app = rig.app(); const holder = rig.holder();
  const noService = rig.node(null);
  assert.equal(refusal(() => place(rig, app, rig.chunk(), holder.publicKey)).code, 'NO_CAPACITY'); assert.equal(noService.nodeId.length > 5, true);
  const small = rig.node(500); const smallChunk = rig.node(10 * GIB, { advert: { maxChunkBytes: 100 } });
  assert.equal(refusal(() => place(rig, app, rig.chunk(1000), holder.publicKey)).code, 'NO_CAPACITY'); // 500 free, 100 max chunk
  assert.equal(small.nodeId !== smallChunk.nodeId, true);
  const paused = rig.node(10 * GIB, { resources: { contribution: 'PAUSED', pressure: 'NORMAL', power: 'AC', memoryBudgetBytes: 0, cpuBudgetPercent: 0 } });
  assert.equal(refusal(() => place(rig, app, rig.chunk(), holder.publicKey)).code, 'NO_CAPACITY'); assert.equal(paused.nodeId.length > 5, true);
  const draining = rig.node(); draining.heartbeat(undefined, { lifecycle: 'DRAINING' });
  assert.equal(refusal(() => place(rig, app, rig.chunk(), holder.publicKey)).code, 'NO_CAPACITY');
  const revoked = rig.node(); rig.core.revokeNode(revoked.nodeId);
  assert.equal(refusal(() => place(rig, app, rig.chunk(), holder.publicKey)).code, 'NO_CAPACITY');
  const stale = rig.node(); rig.advance(20000); // the others are now stale too; only fresh heartbeats count
  assert.equal(refusal(() => place(rig, app, rig.chunk(), holder.publicKey)).code, 'NO_CAPACITY'); assert.equal(stale.nodeId.length > 5, true);
  const good = rig.node(); assert.equal(rig.verify(place(rig, app, rig.chunk(), holder.publicKey).grant?.ticket ?? '', good.nodeId).ok, true);
});
test('selection is free-space weighted, the application never chooses, and the policy is deterministic under an injected random', async t => {
  let r = 0; const rig = await storageRig(t, { random: () => r }); const app = rig.app(); const holder = rig.holder();
  const small = rig.node(1 * GIB); const big = rig.node(3 * GIB); const nodes = [small.nodeId, big.nodeId].sort(); // listNodeServices is ordered by node id
  const chosen = (point: number) => { r = point; const c = rig.chunk(); const placed = place(rig, app, c, holder.publicKey); return rig.store.listReplicas(app.record.id, c.id)[0]?.nodeId ?? (placed.grant ? '' : ''); };
  const weights = new Map([[small.nodeId, 1], [big.nodeId, 3]]); const first = nodes[0] ?? ''; const second = nodes[1] ?? '';
  const cut = (weights.get(first) ?? 0) / 4;
  assert.equal(chosen(0), first); assert.equal(chosen(cut - 0.0001), first); assert.equal(chosen(cut + 0.0001), second); assert.equal(chosen(0.999999), second);
  // over many draws with a real random the split follows the weights loosely (a statistical sanity check, not an exact one)
  const rig2 = await storageRig(t, { limits: { maxOpenPutsPerNode: 1000, maxOpenTransfersPerNode: 1000, maxOpenTransfersPerApplication: 1000, ticketsPerMinute: 100000 } }); const app2 = rig2.app(); const a = rig2.node(1 * GIB); const b = rig2.node(3 * GIB); let aCount = 0; let bCount = 0;
  for (let i = 0; i < 400; i++) { const c = rig2.chunk(1); place(rig2, app2, c, holder.publicKey); const n = rig2.store.listReplicas(app2.record.id, c.id)[0]?.nodeId; if (n === a.nodeId) aCount++; else if (n === b.nodeId) bCount++; }
  assert(aCount > 40 && bCount > 200 && aCount + bCount === 400, `${aCount}/${bCount}`);
});
test('reservations are bounded by what nodes reported: limited capacity cannot be over-reserved, however many placements arrive', async t => {
  const rig = await storageRig(t); const app = rig.app(); const holder = rig.holder(); rig.node(10 * 1000 + 500);
  let granted = 0; let refused = 0;
  for (let i = 0; i < 50; i++) { try { place(rig, app, rig.chunk(1000), holder.publicKey); granted++; } catch (error) { assert.equal((error as { code?: string }).code === 'NO_CAPACITY' || (error as { code?: string }).code === 'TRANSFER_LIMIT', true); refused++; } }
  const reserved = [...rig.store.reservedBytes().values()].reduce((a, b) => a + b, 0);
  assert(reserved <= 10500, `reserved ${reserved}`); assert.equal(granted + refused, 50); assert(granted <= 8); // and never more than the node's own in-flight put limit
});
test('placement retry: a second request for the same PENDING chunk issues a NEW ticket on the same node and revokes the older one', async t => {
  const { rig, app, node, holder } = await one(t); const chunk = rig.chunk(); const first = place(rig, app, chunk, holder.publicKey).grant; const second = place(rig, app, chunk, holder.publicKey).grant; assert(first && second);
  assert.notEqual(first.transferId, second.transferId); assert.notEqual(first.ticket, second.ticket);
  assert.equal(rig.store.getTransfer(first.transferId)?.state, 'REVOKED'); assert.equal(rig.store.getTransfer(first.transferId)?.reason, 'SUPERSEDED'); assert.equal(rig.store.getTransfer(second.transferId)?.state, 'AUTHORIZED');
  assert.equal(rig.store.listReplicas(app.record.id, chunk.id).length, 1); assert.equal(rig.store.listReplicas(app.record.id, chunk.id)[0]?.nodeId, node.nodeId);
  assert.equal(rig.store.chunkUsage(app.record.id).count, 1);
  // a ticket request for put does the same
  const third = rig.core.storage.ticket(app.record, { operation: 'put', chunkId: chunk.id, holderKey: holder.publicKey }).grant; assert(third); assert.equal(rig.store.getTransfer(second.transferId)?.state, 'REVOKED');
  assert.equal(rig.store.listOpenTransfers().length, 1);
});
test('a retry moves the reservation if the first node is no longer eligible', async t => {
  const rig = await storageRig(t); const app = rig.app(); const holder = rig.holder(); const a = rig.node(); const chunk = rig.chunk();
  const first = place(rig, app, chunk, holder.publicKey).grant; assert(first); const b = rig.node(); a.heartbeat({ free: null }); // a stops offering storage
  const second = place(rig, app, chunk, holder.publicKey).grant; assert(second);
  assert.deepEqual(rig.store.listReplicas(app.record.id, chunk.id).map(r => r.nodeId), [b.nodeId]); assert.equal(rig.verify(second.ticket, b.nodeId).ok, true); assert.equal(rig.verify(second.ticket, a.nodeId).ok, false);
});
test('a size that disagrees with an existing chunk, a deleting chunk and an already stored chunk each have one fixed outcome', async t => {
  const { rig, app, node, holder } = await one(t); const chunk = rig.chunk(); const grant = place(rig, app, chunk, holder.publicKey).grant; assert(grant);
  assert.equal(refusal(() => place(rig, app, { id: chunk.id, size: 999 }, holder.publicKey)).code, 'SIZE_CONFLICT');
  rig.core.storage.complete(node.nodeId, rig.receipt(grant.transferId, app.record.id, chunk.id, node.nodeId, {}, 'put', chunk.size));
  assert.deepEqual(place(rig, app, chunk, holder.publicKey), { chunkId: chunk.id, size: chunk.size, state: 'STORED', grant: null });
  assert.deepEqual(rig.core.storage.ticket(app.record, { operation: 'put', chunkId: chunk.id, holderKey: holder.publicKey }), { chunkId: chunk.id, state: 'STORED', grant: null });
  rig.core.storage.ticket(app.record, { operation: 'delete', chunkId: chunk.id, holderKey: holder.publicKey });
  assert.equal(refusal(() => place(rig, app, chunk, holder.publicKey)).code, 'CHUNK_DELETING');
  assert.equal(refusal(() => rig.core.storage.ticket(app.record, { operation: 'put', chunkId: chunk.id, holderKey: holder.publicKey })).code, 'CHUNK_DELETING');
});

test('application limits: chunk count, logical bytes, open transfers and ticket rate each stop an application before the Coordinator\'s metadata grows without bound', async t => {
  {
    const { rig, app, holder } = await one(t, { limits: { maxChunksPerApplication: 3 } });
    for (let i = 0; i < 3; i++) place(rig, app, rig.chunk(10), holder.publicKey);
    assert.equal(refusal(() => place(rig, app, rig.chunk(10), holder.publicKey)).code, 'APPLICATION_CHUNK_LIMIT'); assert.equal(rig.store.chunkUsage(app.record.id).count, 3);
    const existing = rig.store.listOpenTransfers()[0]; assert(existing); // a retry of an existing chunk is not a new chunk
    assert.equal(place(rig, app, { id: existing.chunkId, size: 10 }, holder.publicKey).state, 'PENDING');
  }
  {
    const { rig, app, holder } = await one(t, { limits: { maxBytesPerApplication: 2500 } });
    place(rig, app, rig.chunk(1000), holder.publicKey); place(rig, app, rig.chunk(1000), holder.publicKey);
    assert.equal(refusal(() => place(rig, app, rig.chunk(501), holder.publicKey)).code, 'APPLICATION_BYTE_LIMIT'); place(rig, app, rig.chunk(500), holder.publicKey);
  }
  {
    const { rig, app, holder } = await one(t, { limits: { maxOpenTransfersPerApplication: 2 } });
    place(rig, app, rig.chunk(10), holder.publicKey); place(rig, app, rig.chunk(10), holder.publicKey);
    assert.equal(refusal(() => place(rig, app, rig.chunk(10), holder.publicKey)).code, 'TRANSFER_LIMIT'); assert.equal(rig.store.chunkUsage(app.record.id).count, 2); // the refused placement left nothing behind
  }
  {
    const { rig, app, node, holder } = await one(t, { limits: { ticketsPerMinute: 3, maxOpenPutsPerNode: 100, maxOpenTransfersPerNode: 100 } });
    for (let i = 0; i < 3; i++) place(rig, app, rig.chunk(10), holder.publicKey);
    assert.equal(refusal(() => place(rig, app, rig.chunk(10), holder.publicKey)).code, 'TICKET_RATE_LIMIT'); rig.advance(60001); node.heartbeat(); place(rig, app, rig.chunk(10), holder.publicKey);
  }
  assert.deepEqual([defaultStorageLimits.maxOpenPutsPerNode, TICKET_MAX_LIFETIME_MS], [8, 120000]);
});
test('a node never holds more open puts than its own in-flight limit, and a refused attempt leaves no half-created chunk', async t => {
  const { rig, app, holder } = await one(t); for (let i = 0; i < 8; i++) place(rig, app, rig.chunk(10), holder.publicKey);
  const before = rig.store.chunkUsage(app.record.id); assert.equal(refusal(() => place(rig, app, rig.chunk(10), holder.publicKey)).code, 'NO_CAPACITY'); assert.deepEqual(rig.store.chunkUsage(app.record.id), before);
});

test('completion evidence: only the target node, for the right transfer, with matching hash and size, promotes a chunk to STORED', async t => {
  const { rig, app, node, holder } = await one(t); const other = rig.node(null); const chunk = rig.chunk(); const grant = place(rig, app, chunk, holder.publicKey).grant; assert(grant);
  const good = (extra: Record<string, unknown> = {}, nodeId = node.nodeId) => rig.receipt(grant.transferId, app.record.id, chunk.id, nodeId, extra, 'put', chunk.size);
  const state = () => rig.store.getChunk(app.record.id, chunk.id)?.state;
  assert.equal(refusal(() => rig.core.storage.complete(other.nodeId, good({}, other.nodeId))).code, 'WRONG_NODE'); // another node
  assert.equal(refusal(() => rig.core.storage.complete(other.nodeId, good())).code, 'WRONG_NODE'); // another node speaking for this one
  assert.equal(refusal(() => rig.core.storage.complete(node.nodeId, { ...good(), transferId: 'ee'.repeat(16) })).code, 'NOT_FOUND'); // another transfer
  assert.equal(refusal(() => rig.core.storage.complete(node.nodeId, good({ chunkId: rig.chunk().id }))).code, 'TRANSFER_MISMATCH');
  assert.equal(refusal(() => rig.core.storage.complete(node.nodeId, good({ applicationId: rig.app().record.id }))).code, 'TRANSFER_MISMATCH');
  assert.equal(refusal(() => rig.core.storage.complete(node.nodeId, good({ operation: 'delete' }))).code, 'TRANSFER_MISMATCH');
  assert.equal(refusal(() => rig.core.storage.complete(node.nodeId, good({ sha256: 'ab'.repeat(32) }))).code, 'HASH_MISMATCH');
  assert.equal(refusal(() => rig.core.storage.complete(node.nodeId, good({ bytes: chunk.size - 1 }))).code, 'SIZE_MISMATCH');
  assert.equal(refusal(() => rig.core.storage.complete(node.nodeId, good({ bytes: chunk.size + 1 }))).code, 'SIZE_MISMATCH');
  assert.throws(() => rig.core.storage.complete(node.nodeId, good({ extra: 1 })));
  assert.equal(state(), 'PENDING'); assert.equal(rig.store.getTransfer(grant.transferId)?.state, 'AUTHORIZED');
  const done = rig.core.storage.complete(node.nodeId, good()); assert.equal(done.state, 'COMPLETED'); assert.deepEqual(done.evidence?.bytes, chunk.size);
  assert.equal(state(), 'STORED'); assert.equal(rig.store.getReplica(app.record.id, chunk.id, node.nodeId)?.state, 'STORED'); assert.equal(rig.core.storage.chunkStatus(app.record, chunk.id).available, true);
  assert.equal(rig.core.storage.complete(node.nodeId, good()).state, 'COMPLETED'); // the same evidence again is a no-op
  assert.equal(refusal(() => rig.core.storage.fail(node.nodeId, grant.transferId, 'IO')).code, 'INVALID_TRANSITION'); // a completed transfer never fails afterwards
});
test('a revoked node cannot report anything, and a report after revocation or expiry is refused', async t => {
  const { rig, app, node, holder } = await one(t); const chunk = rig.chunk(); const grant = place(rig, app, chunk, holder.publicKey).grant; assert(grant);
  const receipt = rig.receipt(grant.transferId, app.record.id, chunk.id, node.nodeId, {}, 'put', chunk.size);
  rig.core.revokeNode(node.nodeId);
  assert.equal(refusal(() => rig.core.storage.complete(node.nodeId, receipt)).code, 'UNAUTHORIZED_NODE'); assert.equal(refusal(() => rig.core.storage.begin(node.nodeId, grant.transferId)).code, 'UNAUTHORIZED_NODE');
  assert.equal(rig.store.getChunk(app.record.id, chunk.id)?.state, 'PENDING');
});
test('begin consumes the transfer id: a second begin is TICKET_USED, from the right node only, and an expired ticket cannot begin', async t => {
  const { rig, app, node, holder } = await one(t); const other = rig.node(null); const grant = place(rig, app, rig.chunk(), holder.publicKey).grant; assert(grant);
  assert.equal(refusal(() => rig.core.storage.begin(other.nodeId, grant.transferId)).code, 'WRONG_NODE');
  assert.equal(rig.core.storage.begin(node.nodeId, grant.transferId).state, 'IN_PROGRESS'); assert.equal(refusal(() => rig.core.storage.begin(node.nodeId, grant.transferId)).code, 'TICKET_USED');
  assert.equal(refusal(() => rig.core.storage.begin(node.nodeId, 'cd'.repeat(16))).code, 'NOT_FOUND');
  const late = place(rig, app, rig.chunk(), holder.publicKey).grant; assert(late); rig.advance(TICKET_MAX_LIFETIME_MS); node.heartbeat();
  assert.equal(refusal(() => rig.core.storage.begin(node.nodeId, late.transferId)).code, 'TRANSFER_FINAL'); assert.equal(rig.store.getTransfer(late.transferId)?.state, 'EXPIRED');
});
test('state machine: exactly the listed transitions are legal, and the final states have none', () => {
  const legal: [TransferState, TransferState][] = [['AUTHORIZED', 'IN_PROGRESS'], ['AUTHORIZED', 'COMPLETED'], ['AUTHORIZED', 'FAILED'], ['AUTHORIZED', 'EXPIRED'], ['AUTHORIZED', 'REVOKED'], ['IN_PROGRESS', 'COMPLETED'], ['IN_PROGRESS', 'FAILED'], ['IN_PROGRESS', 'REVOKED']];
  for (const from of STATES) for (const to of STATES) assert.equal(canTransition(from, to), legal.some(([a, b]) => a === from && b === to), `${from} -> ${to}`);
  for (const state of FINAL_TRANSFER_STATES) assert.deepEqual(TRANSFER_TRANSITIONS[state], []);
  for (const [from, to] of [['COMPLETED', 'IN_PROGRESS'], ['EXPIRED', 'COMPLETED'], ['REVOKED', 'COMPLETED'], ['FAILED', 'COMPLETED'], ['COMPLETED', 'FAILED'], ['IN_PROGRESS', 'EXPIRED'], ['IN_PROGRESS', 'AUTHORIZED']] as const) assert.equal(canTransition(from, to), false);
  assert.deepEqual(Object.keys(TRANSFER_TRANSITIONS).sort(), [...STATES].sort());
});
test('state machine through the service: each illegal move is refused and changes nothing', async t => {
  const { rig, app, node, holder } = await one(t); const chunk = rig.chunk(); const grant = place(rig, app, chunk, holder.publicKey).grant; assert(grant);
  const receipt = rig.receipt(grant.transferId, app.record.id, chunk.id, node.nodeId, {}, 'put', chunk.size);
  // EXPIRED -> COMPLETED
  rig.advance(TICKET_MAX_LIFETIME_MS); node.heartbeat(); assert.equal(refusal(() => rig.core.storage.complete(node.nodeId, receipt)).code, 'TRANSFER_FINAL'); assert.equal(rig.store.getTransfer(grant.transferId)?.state, 'EXPIRED'); assert.equal(rig.store.getChunk(app.record.id, chunk.id)?.state, 'PENDING');
  // REVOKED -> COMPLETED
  const g2 = place(rig, app, chunk, holder.publicKey).grant; assert(g2); rig.core.revokeApplication(app.record.id);
  assert.equal(rig.store.getTransfer(g2.transferId)?.state, 'REVOKED'); node.heartbeat(); assert.equal(refusal(() => rig.core.storage.complete(node.nodeId, rig.receipt(g2.transferId, app.record.id, chunk.id, node.nodeId, {}, 'put', chunk.size))).code, 'TRANSFER_FINAL');
  assert.equal(rig.store.getChunk(app.record.id, chunk.id)?.state, 'PENDING');
  // COMPLETED -> IN_PROGRESS / FAILED
  const rig3 = await one(t); const c3 = rig3.rig.chunk(); const g3 = place(rig3.rig, rig3.app, c3, rig3.holder.publicKey).grant; assert(g3);
  rig3.rig.core.storage.complete(rig3.node.nodeId, rig3.rig.receipt(g3.transferId, rig3.app.record.id, c3.id, rig3.node.nodeId, {}, 'put', c3.size));
  assert.equal(refusal(() => rig3.rig.core.storage.begin(rig3.node.nodeId, g3.transferId)).code, 'TICKET_USED'); assert.equal(refusal(() => rig3.rig.core.storage.fail(rig3.node.nodeId, g3.transferId, 'IO')).code, 'INVALID_TRANSITION');
  assert.equal(rig3.rig.store.getTransfer(g3.transferId)?.state, 'COMPLETED');
});
test('the application can abort an unused authorization (releasing the reservation) but never one the node has begun', async t => {
  const { rig, app, node, holder } = await one(t); const other = rig.app(); const chunk = rig.chunk(); const grant = place(rig, app, chunk, holder.publicKey).grant; assert(grant);
  assert.equal(refusal(() => rig.core.storage.abort(other.record, grant.transferId)).code, 'NOT_FOUND'); // somebody else's transfer is indistinguishable from none
  const g2 = place(rig, app, chunk, holder.publicKey).grant; assert(g2); rig.core.storage.begin(node.nodeId, g2.transferId);
  assert.equal(refusal(() => rig.core.storage.abort(app.record, g2.transferId)).code, 'TRANSFER_IN_PROGRESS');
  const c2 = rig.chunk(); const g3 = place(rig, app, c2, holder.publicKey).grant; assert(g3); assert.deepEqual(rig.core.storage.abort(app.record, g3.transferId), { ok: true }); assert.deepEqual(rig.core.storage.abort(app.record, g3.transferId), { ok: true });
  assert.equal(rig.store.getChunk(app.record.id, c2.id), undefined); assert.equal(rig.store.getTransfer(g3.transferId)?.state, 'FAILED'); assert.equal(rig.store.getTransfer(g3.transferId)?.reason, 'ABORTED');
});

test('get tickets: only for a STORED chunk, on a reachable node; an offline node is unavailable, a lost copy is a different answer, and neither deletes anything', async t => {
  const { rig, app, node, holder } = await one(t); const chunk = rig.chunk(); const grant = place(rig, app, chunk, holder.publicKey).grant; assert(grant);
  rig.core.storage.complete(node.nodeId, rig.receipt(grant.transferId, app.record.id, chunk.id, node.nodeId, {}, 'put', chunk.size));
  const got = rig.core.storage.ticket(app.record, { operation: 'get', chunkId: chunk.id, holderKey: holder.publicKey }); assert(got.grant);
  assert.equal(rig.verify(got.grant.ticket, node.nodeId, { operation: 'get', chunkId: chunk.id, applicationId: app.record.id, size: chunk.size }).ok, true);
  // a get ticket is a different transfer, so a stored chunk can be fetched many times without disturbing earlier ones
  const again = rig.core.storage.ticket(app.record, { operation: 'get', chunkId: chunk.id, holderKey: holder.publicKey }); assert(again.grant); assert.notEqual(again.grant.transferId, got.grant.transferId); assert.equal(rig.store.getTransfer(got.grant.transferId)?.state, 'AUTHORIZED');
  rig.advance(61000); // the node stops heartbeating: offline, not lost
  assert.equal(refusal(() => rig.core.storage.ticket(app.record, { operation: 'get', chunkId: chunk.id, holderKey: holder.publicKey })).code, 'NODE_UNAVAILABLE');
  assert.equal(rig.store.getReplica(app.record.id, chunk.id, node.nodeId)?.state, 'STORED'); assert.equal(rig.core.storage.chunkStatus(app.record, chunk.id).available, false); assert.equal(rig.core.storage.chunkStatus(app.record, chunk.id).state, 'STORED');
  node.heartbeat(); assert.equal(rig.core.storage.ticket(app.record, { operation: 'get', chunkId: chunk.id, holderKey: holder.publicKey }).state, 'STORED'); // back online: reachable again
  rig.core.revokeNode(node.nodeId); assert.equal(rig.store.getReplica(app.record.id, chunk.id, node.nodeId)?.state, 'LOST');
  assert.equal(refusal(() => rig.core.storage.ticket(app.record, { operation: 'get', chunkId: chunk.id, holderKey: holder.publicKey })).code, 'CHUNK_UNAVAILABLE');
  assert.equal(rig.store.getChunk(app.record.id, chunk.id)?.state, 'STORED'); // the logical object is not silently deleted
});
test('delete: STORED becomes DELETING when authorized and disappears only on the node\'s evidence; a retry gets a new ticket; gets stop meanwhile', async t => {
  const { rig, app, node, holder } = await one(t); const chunk = rig.chunk(); const grant = place(rig, app, chunk, holder.publicKey).grant; assert(grant);
  rig.core.storage.complete(node.nodeId, rig.receipt(grant.transferId, app.record.id, chunk.id, node.nodeId, {}, 'put', chunk.size));
  const del = rig.core.storage.ticket(app.record, { operation: 'delete', chunkId: chunk.id, holderKey: holder.publicKey }); assert(del.grant); assert.equal(del.state, 'DELETING');
  const claims = rig.verify(del.grant.ticket, node.nodeId, { operation: 'delete', chunkId: chunk.id }); assert.equal(claims.ok, true); if (claims.ok) assert.equal(claims.claims.maxBytes, 0);
  assert.equal(rig.store.getChunk(app.record.id, chunk.id)?.state, 'DELETING'); // still there: nothing has been confirmed removed
  assert.equal(refusal(() => rig.core.storage.ticket(app.record, { operation: 'get', chunkId: chunk.id, holderKey: holder.publicKey })).code, 'CHUNK_DELETING');
  const retry = rig.core.storage.ticket(app.record, { operation: 'delete', chunkId: chunk.id, holderKey: holder.publicKey }); assert(retry.grant); assert.equal(rig.store.getTransfer(del.grant.transferId)?.state, 'REVOKED');
  assert.equal(refusal(() => rig.core.storage.complete(node.nodeId, rig.receipt(del.grant?.transferId ?? '', app.record.id, chunk.id, node.nodeId, {}, 'delete', chunk.size))).code, 'TRANSFER_FINAL'); // the superseded one is dead
  const done = rig.core.storage.complete(node.nodeId, rig.receipt(retry.grant.transferId, app.record.id, chunk.id, node.nodeId, {}, 'delete', chunk.size)); assert.equal(done.state, 'COMPLETED');
  assert.equal(rig.store.getChunk(app.record.id, chunk.id), undefined); assert.deepEqual(rig.store.listReplicas(app.record.id, chunk.id), []); assert.equal(rig.store.getTransfer(retry.grant.transferId)?.state, 'COMPLETED'); // the audit row stays
  assert.equal(refusal(() => rig.core.storage.chunkStatus(app.record, chunk.id)).code, 'NOT_FOUND');
});
test('delete of a chunk with nothing left to remove is logical and immediate, and delete of a PENDING chunk withdraws the intent unless the node has begun', async t => {
  const { rig, app, node, holder } = await one(t); const chunk = rig.chunk(); const grant = place(rig, app, chunk, holder.publicKey).grant; assert(grant);
  rig.core.storage.begin(node.nodeId, grant.transferId);
  assert.equal(refusal(() => rig.core.storage.ticket(app.record, { operation: 'delete', chunkId: chunk.id, holderKey: holder.publicKey })).code, 'TRANSFER_IN_PROGRESS');
  rig.core.storage.complete(node.nodeId, rig.receipt(grant.transferId, app.record.id, chunk.id, node.nodeId, {}, 'put', chunk.size)); rig.core.revokeNode(node.nodeId); // the only copy is now LOST
  assert.deepEqual(rig.core.storage.ticket(app.record, { operation: 'delete', chunkId: chunk.id, holderKey: holder.publicKey }), { chunkId: chunk.id, state: 'DELETED', grant: null }); assert.equal(rig.store.getChunk(app.record.id, chunk.id), undefined);
  const rig2 = await one(t); const c2 = rig2.rig.chunk(); const g2 = place(rig2.rig, rig2.app, c2, rig2.holder.publicKey).grant; assert(g2);
  assert.deepEqual(rig2.rig.core.storage.ticket(rig2.app.record, { operation: 'delete', chunkId: c2.id, holderKey: rig2.holder.publicKey }), { chunkId: c2.id, state: 'DELETED', grant: null });
  assert.equal(rig2.rig.store.getTransfer(g2.transferId)?.state, 'REVOKED'); assert.equal(rig2.rig.store.getChunk(rig2.app.record.id, c2.id), undefined);
});
test('an aborted delete that never began returns the chunk to STORED', async t => {
  const { rig, app, node, holder } = await one(t); const chunk = rig.chunk(); const grant = place(rig, app, chunk, holder.publicKey).grant; assert(grant);
  rig.core.storage.complete(node.nodeId, rig.receipt(grant.transferId, app.record.id, chunk.id, node.nodeId, {}, 'put', chunk.size));
  const del = rig.core.storage.ticket(app.record, { operation: 'delete', chunkId: chunk.id, holderKey: holder.publicKey }); assert(del.grant); rig.core.storage.abort(app.record, del.grant.transferId);
  assert.equal(rig.store.getChunk(app.record.id, chunk.id)?.state, 'STORED');
});

test('namespace isolation: the same bytes under two applications are two separate logical objects, and no route confirms another application\'s chunk', async t => {
  const rig = await storageRig(t); const a = rig.app(); const b = rig.app(); const node = rig.node(); const hA = rig.holder(); const hB = rig.holder(); const chunk = rig.chunk();
  const gA = place(rig, a, chunk, hA.publicKey).grant; assert(gA);
  rig.core.storage.complete(node.nodeId, rig.receipt(gA.transferId, a.record.id, chunk.id, node.nodeId, {}, 'put', chunk.size));
  // B never stored it: every way of asking gives the same answer as for a chunk that exists nowhere
  const nowhere = rig.chunk();
  for (const [operation] of [['get'], ['delete'], ['put']] as const) {
    const other = refusal(() => rig.core.storage.ticket(b.record, { operation, chunkId: chunk.id, holderKey: hB.publicKey })); const none = refusal(() => rig.core.storage.ticket(b.record, { operation, chunkId: nowhere.id, holderKey: hB.publicKey }));
    assert.deepEqual(other, none); assert.equal(other.status, 404);
  }
  assert.deepEqual(refusal(() => rig.core.storage.chunkStatus(b.record, chunk.id)), refusal(() => rig.core.storage.chunkStatus(b.record, nowhere.id)));
  assert.deepEqual(refusal(() => rig.core.storage.abort(b.record, gA.transferId)), refusal(() => rig.core.storage.abort(b.record, 'ab'.repeat(16))));
  assert.equal(rig.core.storage.chunkStatus(a.record, chunk.id).state, 'STORED');
  // B storing the same bytes is a new, separate placement: A's object is untouched, and B's PENDING chunk says nothing about A's
  const gB = place(rig, b, chunk, hB.publicKey); assert.equal(gB.state, 'PENDING'); assert.equal(rig.store.getChunk(a.record.id, chunk.id)?.state, 'STORED'); assert.equal(rig.store.getChunk(b.record.id, chunk.id)?.state, 'PENDING');
  assert.equal(parseTicket(gB.grant?.ticket ?? '')?.claims.applicationId, b.record.id);
  // A completion receipt for B's transfer that names A as the application is refused
  assert.equal(refusal(() => rig.core.storage.complete(node.nodeId, rig.receipt(gB.grant?.transferId ?? '', a.record.id, chunk.id, node.nodeId, {}, 'put', chunk.size))).code, 'TRANSFER_MISMATCH');
  // deleting B's does not touch A's
  rig.core.storage.ticket(b.record, { operation: 'delete', chunkId: chunk.id, holderKey: hB.publicKey }); assert.equal(rig.store.getChunk(a.record.id, chunk.id)?.state, 'STORED');
});
test('nothing in an application\'s answers reveals nodes, paths, owners, policies or other applications', async t => {
  const { rig, app, holder, node } = await one(t); const other = rig.app(); const chunk = rig.chunk(); const placed = place(rig, app, chunk, holder.publicKey); place(rig, other, rig.chunk(), rig.holder().publicKey);
  const text = JSON.stringify([placed, rig.core.storage.chunkStatus(app.record, chunk.id)]);
  for (const forbidden of [node.nodeId, '127.0.0.1', 'http', '/var', '/home', 'owner', 'policy', other.record.id, 'endpoint', 'address', 'displayName']) assert.equal(text.includes(forbidden), false, forbidden);
  assert.deepEqual(Object.keys(placed).sort(), ['chunkId', 'grant', 'size', 'state']); assert.deepEqual(Object.keys(placed.grant ?? {}).sort(), ['chunkId', 'expiresAt', 'operation', 'ticket', 'transferId']);
});

test('cleanup is bounded: unused tickets expire, a begun transfer times out, abandoned placements are withdrawn, old audit rows and stale advertisements are deleted', async t => {
  const rig = await storageRig(t); const app = rig.app(); const holder = rig.holder(); const node = rig.node();
  const c1 = rig.chunk(); const g1 = place(rig, app, c1, holder.publicKey).grant; assert(g1); const c2 = rig.chunk(); const g2 = place(rig, app, c2, holder.publicKey).grant; assert(g2); rig.core.storage.begin(node.nodeId, g2.transferId);
  rig.advance(TICKET_MAX_LIFETIME_MS + 1); node.heartbeat(); rig.core.maintain();
  assert.equal(rig.store.getTransfer(g1.transferId)?.state, 'EXPIRED'); assert.equal(rig.store.getTransfer(g2.transferId)?.state, 'IN_PROGRESS'); // began in time: allowed to finish
  rig.advance(TRANSFER_PROGRESS_GRACE_MS); node.heartbeat(); rig.core.maintain(); assert.equal(rig.store.getTransfer(g2.transferId)?.state, 'FAILED'); assert.equal(rig.store.getTransfer(g2.transferId)?.reason, 'TIMEOUT');
  assert.equal(rig.store.getChunk(app.record.id, c1.id)?.state, 'PENDING'); // still within its reservation window
  rig.advance(PENDING_CHUNK_TTL_MS); node.heartbeat(); rig.core.maintain();
  assert.equal(rig.store.getChunk(app.record.id, c1.id), undefined); assert.equal(rig.store.getChunk(app.record.id, c2.id), undefined); assert.equal(rig.store.reservedBytes().size, 0);
  assert(rig.store.getTransfer(g1.transferId)); // the audit rows are kept for a while
  rig.advance(TRANSFER_RETENTION_MS); node.heartbeat(); rig.core.maintain(); assert.equal(rig.store.getTransfer(g1.transferId), undefined); assert.equal(rig.store.getTransfer(g2.transferId), undefined);
  rig.advance(rig.core.policy.offlineMs + 1); rig.core.maintain(); assert.equal(rig.store.listNodeServices('storage.chunk.v1').length, 0); // the node stopped reporting: its advertisement is gone
});
test('the cleanup is throttled and not on the lease path', async t => {
  const rig = await storageRig(t); const app = rig.app(); const holder = rig.holder(); rig.node();
  const calls = { overdue: 0 }; const original = rig.store.listOverdueTransfers.bind(rig.store); rig.store.listOverdueTransfers = (now: number, grace: number) => { calls.overdue++; return original(now, grace); };
  for (let i = 0; i < 200; i++) rig.core.maintain(); assert.equal(calls.overdue, 1, 'two hundred maintenance calls inside one interval sweep once');
  rig.advance(STORAGE_SWEEP_MS); rig.core.maintain(); assert.equal(calls.overdue, 2);
  // leasing a job runs the job sweep but not the storage sweep (it is the hot path: every lease request)
  const g = place(rig, app, rig.chunk(), holder.publicKey).grant; assert(g); rig.advance(TICKET_MAX_LIFETIME_MS + 1); const before = calls.overdue; const idle = rig.node(null);
  assert.equal(rig.core.lease(idle.nodeId), null); assert.equal(calls.overdue, before); assert.equal(rig.store.getTransfer(g.transferId)?.state, 'AUTHORIZED');
  rig.core.maintain(); assert.equal(rig.store.getTransfer(g.transferId)?.state, 'EXPIRED');
});
test('a ticket abandoned over and over cannot grow the tables: reservations, chunks and audit rows are all bounded by the application limits and the retention window', async t => {
  const rig = await storageRig(t, { limits: { maxChunksPerApplication: 5, ticketsPerMinute: 1000 } }); const app = rig.app(); const holder = rig.holder(); const node = rig.node();
  for (let round = 0; round < 20; round++) {
    for (let i = 0; i < 5; i++) { try { place(rig, app, rig.chunk(10), holder.publicKey); } catch { /* limits hold */ } }
    rig.advance(PENDING_CHUNK_TTL_MS + STORAGE_SWEEP_MS); node.heartbeat(); rig.core.maintain(); assert(rig.store.chunkUsage(app.record.id).count <= 5);
  }
  assert.equal(rig.store.listOpenTransfers().length <= 5, true);
});

test('revoking an application makes its open transfers unusable and refuses new ones, but deletes none of its chunks', async t => {
  const { rig, app, node, holder } = await one(t); const chunk = rig.chunk(); const g = place(rig, app, chunk, holder.publicKey).grant; assert(g); const stored = rig.chunk(); const g2 = place(rig, app, stored, holder.publicKey).grant; assert(g2);
  rig.core.storage.complete(node.nodeId, rig.receipt(g2.transferId, app.record.id, stored.id, node.nodeId, {}, 'put', stored.size));
  const open = rig.core.storage.ticket(app.record, { operation: 'get', chunkId: stored.id, holderKey: holder.publicKey }).grant; assert(open);
  rig.core.revokeApplication(app.record.id);
  for (const id of [g.transferId, open.transferId]) assert.equal(rig.store.getTransfer(id)?.state, 'REVOKED');
  assert.equal(refusal(() => rig.core.authenticateApplication(app.token)).status, 401);
  assert.equal(rig.store.getChunk(app.record.id, stored.id)?.state, 'STORED'); assert.equal(rig.store.getChunk(app.record.id, chunk.id)?.state, 'PENDING'); assert.equal(rig.store.getReplica(app.record.id, stored.id, node.nodeId)?.state, 'STORED');
});
test('revoking a node: no new placement or ticket targets it, open transfers are revoked, stored copies become LOST (kept), reservations are released', async t => {
  const rig = await storageRig(t); const app = rig.app(); const holder = rig.holder(); const node = rig.node(); const keep = rig.chunk(); const gk = place(rig, app, keep, holder.publicKey).grant; assert(gk);
  rig.core.storage.complete(node.nodeId, rig.receipt(gk.transferId, app.record.id, keep.id, node.nodeId, {}, 'put', keep.size));
  const pending = rig.chunk(); const gp = place(rig, app, pending, holder.publicKey).grant; assert(gp); const gg = rig.core.storage.ticket(app.record, { operation: 'get', chunkId: keep.id, holderKey: holder.publicKey }).grant; assert(gg);
  rig.core.revokeNode(node.nodeId);
  assert.equal(rig.store.getTransfer(gp.transferId)?.state, 'REVOKED'); assert.equal(rig.store.getTransfer(gg.transferId)?.state, 'REVOKED'); assert.equal(rig.store.getTransfer(gp.transferId)?.reason, 'NODE_REVOKED');
  assert.equal(rig.store.getReplica(app.record.id, keep.id, node.nodeId)?.state, 'LOST'); assert.equal(rig.store.getReplica(app.record.id, pending.id, node.nodeId), undefined); assert.equal(rig.store.getChunk(app.record.id, keep.id)?.state, 'STORED');
  assert.equal(rig.store.listNodeServices('storage.chunk.v1').length, 0);
  assert.equal(refusal(() => place(rig, app, rig.chunk(), holder.publicKey)).code, 'NO_CAPACITY'); assert.equal(refusal(() => rig.core.storage.ticket(app.record, { operation: 'get', chunkId: keep.id, holderKey: holder.publicKey })).code, 'CHUNK_UNAVAILABLE');
  const other = rig.node(); const again = place(rig, app, pending, holder.publicKey).grant; assert(again); assert.equal(rig.verify(again.ticket, other.nodeId).ok, true); // the pending chunk can be placed anew elsewhere
});
test('an owner turning storage off removes the advertisement and blocks new placement, and keeps everything already recorded', async t => {
  const { rig, app, node, holder } = await one(t); const chunk = rig.chunk(); const g = place(rig, app, chunk, holder.publicKey).grant; assert(g);
  rig.core.storage.complete(node.nodeId, rig.receipt(g.transferId, app.record.id, chunk.id, node.nodeId, {}, 'put', chunk.size));
  node.heartbeat({ free: null }); assert.equal(rig.store.getNodeService(node.nodeId, 'storage.chunk.v1'), undefined);
  assert.equal(refusal(() => place(rig, app, rig.chunk(), holder.publicKey)).code, 'NO_CAPACITY'); assert.equal(rig.store.getReplica(app.record.id, chunk.id, node.nodeId)?.state, 'STORED'); assert.equal(rig.store.getChunk(app.record.id, chunk.id)?.state, 'STORED');
  node.heartbeat(); assert(place(rig, app, rig.chunk(), holder.publicKey).grant); // and back on
});
test('a stale advertisement is only a hint: shrinking free space on the next heartbeat is honoured at once, and a node that vanishes stops being placed on', async t => {
  const rig = await storageRig(t); const app = rig.app(); const holder = rig.holder(); const node = rig.node(5000);
  place(rig, app, rig.chunk(3000), holder.publicKey); assert.equal(refusal(() => place(rig, app, rig.chunk(3000), holder.publicKey)).code, 'NO_CAPACITY'); // 5000 free minus 3000 reserved
  node.heartbeat({ free: 100 }); assert.equal(refusal(() => place(rig, app, rig.chunk(500), holder.publicKey)).code, 'NO_CAPACITY');
  node.heartbeat({ free: 1 * GIB }); assert(place(rig, app, rig.chunk(500), holder.publicKey).grant);
  rig.advance(16000); assert.equal(refusal(() => place(rig, app, rig.chunk(500), holder.publicKey)).code, 'NO_CAPACITY'); // heartbeat is older than the stale limit
});
test('a heartbeat that omits services removes them, and an invalid advertisement is refused without touching state', async t => {
  const { rig, node } = await one(t); assert.equal(rig.store.listNodeServices('storage.chunk.v1').length, 1);
  assert.throws(() => rig.core.heartbeat(node.nodeId, { protocolVersion: 1, daemonVersion: '0.4.0', capabilities: ['system.echo.v1'], jobSlots: 1, currentJobs: 0, services: { 'storage.chunk.v1': { capacityBytes: 1, freeBytes: 2, maxChunkBytes: 5 } } }));
  assert.equal(rig.store.listNodeServices('storage.chunk.v1')[0]?.freeBytes, 10 * GIB); node.heartbeat({ free: null }); assert.equal(rig.store.listNodeServices('storage.chunk.v1').length, 0);
});
test('placement races: many applications racing for one small node can never reserve more than it reported', async t => {
  const rig = await storageRig(t); const holder = rig.holder(); rig.node(4000); const apps = Array.from({ length: 6 }, () => rig.app());
  const outcomes = await Promise.all(apps.flatMap(app => [1, 2].map(async () => { await Promise.resolve(); try { return place(rig, app, rig.chunk(1000), holder.publicKey).grant ? 'granted' : 'none'; } catch (error) { return (error as { code: string }).code; } })));
  const granted = outcomes.filter(o => o === 'granted').length; assert.equal(granted, 4); assert.equal(outcomes.filter(o => o === 'NO_CAPACITY').length, 8);
  assert.equal([...rig.store.reservedBytes().values()].reduce((a, b) => a + b, 0), 4000);
});
test('summary: aggregates only', async t => {
  const { rig, app, node, holder } = await one(t); const chunk = rig.chunk(); const g = place(rig, app, chunk, holder.publicKey).grant; assert(g);
  const summary = rig.core.storage.summary(); assert.equal(summary.chunks.pending, 1); assert.equal(summary.nodes[0]?.reservedBytes, chunk.size); assert.equal(summary.transfers.open, 1); assert.equal(summary.keyring.keys, 1);
  const text = JSON.stringify(summary); for (const secret of [g.ticket, chunk.id, holder.publicKey, app.token, app.record.id]) assert.equal(text.includes(secret), false);
  assert.equal(summary.nodes[0]?.nodeId, node.nodeId);
});
