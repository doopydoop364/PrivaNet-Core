import test from 'node:test';
import assert from 'node:assert/strict';
import { TICKET_MAX_LIFETIME_MS } from '@privanet/protocol';
import { verifyTicket } from '@privanet/shared';
import { TRANSFER_PROGRESS_GRACE_MS } from '@privanet/coordinator/storage';
import type { TransferState } from '@privanet/protocol';
import { refusal, storageRig } from './storage-rig.js';

/** Builds a transfer in each state, restarts the Coordinator (same database file, same keyring), and checks nothing changed in the direction of more authority. */
async function transferIn(state: TransferState, rig: Awaited<ReturnType<typeof storageRig>>, app: ReturnType<Awaited<ReturnType<typeof storageRig>>['app']>, node: ReturnType<Awaited<ReturnType<typeof storageRig>>['node']>, holderKey: string) {
  const chunk = rig.chunk(); const grant = rig.core.storage.place(app.record, { chunkId: chunk.id, size: chunk.size, holderKey }).grant; assert(grant);
  switch (state) {
    case 'AUTHORIZED': break;
    case 'IN_PROGRESS': rig.core.storage.begin(node.nodeId, grant.transferId); break;
    case 'COMPLETED': rig.core.storage.complete(node.nodeId, rig.receipt(grant.transferId, app.record.id, chunk.id, node.nodeId, {}, 'put', chunk.size)); break;
    case 'FAILED': rig.core.storage.fail(node.nodeId, grant.transferId, 'IO'); break;
    case 'EXPIRED': break;
    case 'REVOKED': rig.core.storage.place(app.record, { chunkId: chunk.id, size: chunk.size, holderKey }); break; // a retry supersedes (revokes) the first
  }
  return { chunk, grant };
}
test('restart in every transfer state: the key and kid persist, every record persists exactly, nothing completes by itself and no authorization broadens', async t => {
  const rig = await storageRig(t, { dbFile: true }); const app = rig.app(); const node = rig.node(); const holder = rig.holder(); const kid = rig.keyring?.currentKid;
  const made = new Map<TransferState, Awaited<ReturnType<typeof transferIn>>>();
  for (const state of ['AUTHORIZED', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'REVOKED'] as const) made.set(state, await transferIn(state, rig, app, node, holder.publicKey));
  const before = new Map([...made].map(([state, { grant }]) => [state, JSON.stringify(rig.store.getTransfer(grant.transferId))]));
  const chunkStates = new Map([...made].map(([state, { chunk }]) => [state, rig.store.getChunk(app.record.id, chunk.id)?.state]));
  const keyBefore = JSON.stringify(rig.core.storage.transferKeys(rig.core.store.coordinatorId)); const live = made.get('AUTHORIZED')?.grant; assert(live);
  await rig.restart();
  for (const [state, { grant, chunk }] of made) {
    const after = rig.store.getTransfer(grant.transferId);
    if (state === 'REVOKED') { assert.equal(after?.state, 'REVOKED'); continue; }
    assert.equal(JSON.stringify(after), before.get(state), state); assert.equal(rig.store.getChunk(app.record.id, chunk.id)?.state, chunkStates.get(state), state);
  }
  assert.equal(rig.keyring?.currentKid, kid); assert.equal(JSON.stringify(rig.core.storage.transferKeys(rig.core.store.coordinatorId)), keyBefore);
  // a ticket issued before the restart still verifies after it (same key), and for exactly the same node and chunk: no broader
  assert.equal(verifyTicket(live.ticket, { keys: rig.core.storage.transferKeys(rig.core.store.coordinatorId).keys, now: rig.clock.t, expect: { nodeId: node.nodeId, operation: 'put' } }).ok, true);
  rig.core.maintain(); assert.equal(rig.store.getTransfer(made.get('IN_PROGRESS')?.grant.transferId ?? '')?.state, 'IN_PROGRESS'); // nothing completed or failed on its own
  assert.equal(rig.store.getChunk(app.record.id, made.get('AUTHORIZED')?.chunk.id ?? '')?.state, 'PENDING');
});
test('restart after downtime: transfers whose time ran out expire at the first sweep, a begun one times out after its grace, and none is ever completed by the restart', async t => {
  const rig = await storageRig(t, { dbFile: true }); const app = rig.app(); const node = rig.node(); const holder = rig.holder();
  const a = await transferIn('AUTHORIZED', rig, app, node, holder.publicKey); const b = await transferIn('IN_PROGRESS', rig, app, node, holder.publicKey);
  rig.advance(TICKET_MAX_LIFETIME_MS + 5000); await rig.restart(); rig.core.maintain();
  assert.equal(rig.store.getTransfer(a.grant.transferId)?.state, 'EXPIRED'); assert.equal(rig.store.getTransfer(b.grant.transferId)?.state, 'IN_PROGRESS');
  assert.equal(refusal(() => rig.core.storage.complete(node.nodeId, rig.receipt(a.grant.transferId, app.record.id, a.chunk.id, node.nodeId, {}, 'put', a.chunk.size))).code, 'TRANSFER_FINAL');
  rig.advance(TRANSFER_PROGRESS_GRACE_MS); await rig.restart(); rig.core.maintain(); assert.equal(rig.store.getTransfer(b.grant.transferId)?.state, 'FAILED');
  assert.equal(rig.store.getChunk(app.record.id, a.chunk.id)?.state, 'PENDING'); assert.equal(rig.store.getChunk(app.record.id, b.chunk.id)?.state, 'PENDING');
});
test('after a restart advertisements are stale until a fresh heartbeat: nothing is placed on a node that has not reported since', async t => {
  const rig = await storageRig(t, { dbFile: true }); const app = rig.app(); const node = rig.node(); const holder = rig.holder(); assert(rig.core.storage.place(app.record, { chunkId: rig.chunk().id, size: 10, holderKey: holder.publicKey }).grant);
  rig.advance(20000); await rig.restart(); assert.equal(rig.store.listNodeServices('storage.chunk.v1').length, 1); // the row survives, but is not trusted
  assert.equal(refusal(() => rig.core.storage.place(app.record, { chunkId: rig.chunk().id, size: 10, holderKey: holder.publicKey })).code, 'NO_CAPACITY');
  node.heartbeat(); assert(rig.core.storage.place(app.record, { chunkId: rig.chunk().id, size: 10, holderKey: holder.publicKey }).grant);
});
test('stored chunk metadata, replicas and the audit trail survive a restart, and a restart does not turn an offline node\'s copies into lost ones', async t => {
  const rig = await storageRig(t, { dbFile: true }); const app = rig.app(); const node = rig.node(); const holder = rig.holder(); const done = await transferIn('COMPLETED', rig, app, node, holder.publicKey);
  rig.advance(120000); await rig.restart(); rig.core.maintain();
  assert.equal(rig.store.getChunk(app.record.id, done.chunk.id)?.state, 'STORED'); assert.equal(rig.store.getReplica(app.record.id, done.chunk.id, node.nodeId)?.state, 'STORED'); assert.equal(rig.store.getTransfer(done.grant.transferId)?.state, 'COMPLETED');
  assert.equal(refusal(() => rig.core.storage.ticket(app.record, { operation: 'get', chunkId: done.chunk.id, holderKey: holder.publicKey })).code, 'NODE_UNAVAILABLE'); // offline, not lost
  node.heartbeat(); assert.equal(rig.core.storage.ticket(app.record, { operation: 'get', chunkId: done.chunk.id, holderKey: holder.publicKey }).state, 'STORED');
});
