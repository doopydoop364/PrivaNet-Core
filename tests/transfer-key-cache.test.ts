import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { TransferKeyCache, TRANSFER_KEY_REFRESH_MS } from '@privanet/node/store/key-cache';
import { generateHolderKey, signTicket, transferKeyId, verifyTicket } from '@privanet/shared';
import type { TransferKeys } from '@privanet/protocol';

const key = () => { const holder = generateHolderKey(); return { ...holder, kid: transferKeyId(holder.publicKey) }; };
const coordinatorId = randomUUID(); const nodeId = `node_${'12'.repeat(32)}`; const now = 1000000;
const ticket = (signer: ReturnType<typeof key>, extra = {}) => signTicket({ kid: signer.kid, transferId: '34'.repeat(16), operation: 'put', applicationId: randomUUID(), chunkId: `chk_${'56'.repeat(32)}`, nodeId,
  maxBytes: 1024, issuedAt: now, expiresAt: now + 120000, holderKey: generateHolderKey().publicKey, nonce: '78'.repeat(16), ...extra }, signer.privateKey);
const response = (...keys: Array<{ kid: string; publicKey: string; notAfter?: number | null }>): TransferKeys => ({ coordinatorId, keys: keys.map(k => ({ kid: k.kid, publicKey: k.publicKey, notAfter: k.notAfter ?? null })) });

test('key refresh is single-flight, periodic and retains known keys during temporary disconnection', async () => {
  let clock = 0; let calls = 0; let disconnected = false; const signer = key();
  const cache = new TransferKeyCache(coordinatorId, async () => { calls++; if (disconnected) throw new Error('private transport text'); return response(signer); }, () => clock);
  await Promise.all(Array.from({ length: 100 }, () => cache.refresh())); assert.equal(calls, 1); assert.deepEqual(cache.keys, response(signer).keys);
  clock = TRANSFER_KEY_REFRESH_MS - 1; await cache.refresh(); assert.equal(calls, 1);
  clock++; await cache.refresh(); assert.equal(calls, 2);
  disconnected = true; clock += TRANSFER_KEY_REFRESH_MS; await cache.refresh(); assert.equal(calls, 3); assert.deepEqual(cache.keys, response(signer).keys);
  assert.equal(verifyTicket(ticket(signer), { keys: cache.keys ?? [], now, expect: { nodeId } }).ok, true);
  const copy = cache.keys; assert(copy?.[0]); copy[0].kid = 'ff'.repeat(8); assert.equal(cache.keys?.[0]?.kid, signer.kid);
});

test('unknown-kid attacks share a global budget, cannot trust strangers, and back off on failed refresh', async () => {
  let clock = 0; let calls = 0; const known = key(); const unknown = key(); let unavailable = false;
  const cache = new TransferKeyCache(coordinatorId, async () => { calls++; if (unavailable) throw new Error(); return response(known); }, () => clock);
  await cache.refresh(); const wire = ticket(unknown);
  await Promise.all(Array.from({ length: 1000 }, () => cache.refreshForTicket(wire, now))); assert.equal(calls, 1);
  clock = 5000; await Promise.all(Array.from({ length: 1000 }, () => cache.refreshForTicket(wire, now))); assert.equal(calls, 2);
  assert.equal(verifyTicket(wire, { keys: cache.keys ?? [], now, expect: { nodeId } }).ok, false);
  unavailable = true;
  for (const at of [10000, 15000, 25000, 45000, 85000, 165000]) { clock = at; await cache.refreshForTicket(wire, now); }
  assert.equal(calls, 8);
  clock = 284999; await Promise.all(Array.from({ length: 1000 }, () => cache.refreshForTicket(wire, now))); assert.equal(calls, 8);
  clock = 285000; await cache.refreshForTicket(wire, now); assert.equal(calls, 9);
  assert.equal(cache.keys?.[0]?.kid, known.kid);
});

test('unknown-key refresh learns rotation and preserves the exact old-key overlap deadline', async () => {
  let clock = 0; const old = key(); const current = key(); let rotated = false;
  const cache = new TransferKeyCache(coordinatorId, async () => rotated ? response(current, { ...old, notAfter: now + 1000 }) : response(old), () => clock);
  await cache.refresh(); rotated = true; clock = 5000;
  await cache.refreshForTicket(ticket(current), now);
  const keys = cache.keys ?? [];
  assert.equal(verifyTicket(ticket(current), { keys, now, expect: { nodeId } }).ok, true);
  assert.equal(verifyTicket(ticket(old), { keys, now, expect: { nodeId } }).ok, true);
  assert.deepEqual(verifyTicket(ticket(old), { keys, now: now + 31000, expect: { nodeId } }), { ok: false, error: 'UNKNOWN_KID' });
});

test('invalid ticket structure or lifetime never causes an unknown-key request', async () => {
  let calls = 0; const unknown = key();
  const cache = new TransferKeyCache(coordinatorId, async () => { calls++; return response(unknown); }, () => 0);
  for (const wire of ['', 'x'.repeat(312), ticket(unknown, { expiresAt: now }), ticket(unknown, { expiresAt: now + 120001 }), ticket(unknown, { issuedAt: now + 31000, expiresAt: now + 100000 }), ticket(unknown, { issuedAt: 0, expiresAt: 1000 })]) await cache.refreshForTicket(wire, now);
  await cache.refreshForTicket(ticket(unknown), NaN); assert.equal(calls, 0);
});

test('Coordinator substitution clears trust; malformed public keys and duplicate kids never replace a valid cache', async () => {
  let clock = 0; const signer = key(); let value: unknown = response(signer);
  const cache = new TransferKeyCache(coordinatorId, async () => value, () => clock);
  await cache.refresh();
  for (const bad of [response(signer, signer), response({ ...signer, kid: 'ff'.repeat(8) }), response({ ...signer, publicKey: 'x'.repeat(60) }), { ...response(signer), extra: true }]) {
    clock += 120000; value = bad; await cache.refresh(); assert.deepEqual(cache.keys, response(signer).keys);
  }
  clock += 120000; value = { ...response(signer), coordinatorId: randomUUID() }; await cache.refresh(); assert.equal(cache.keys, null);
});
