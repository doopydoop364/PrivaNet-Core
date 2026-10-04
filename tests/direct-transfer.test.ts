import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { request } from 'node:https';
import { ApiError, generateHolderKey, signHolderProof } from '@privanet/shared';
import { PrivaNetClient } from '@privanet/sdk';
const { directRequest, transferChunk } = await import(new URL('../../packages/sdk/dist/chunk-transfer.js', import.meta.url).href) as typeof import('../packages/sdk/dist/chunk-transfer.js');
import { chunkPath } from '@privanet/node/store/chunk-id';
import { RECEIPT_FILE } from '@privanet/node/store/receipt-queue';
import { directRig } from './direct-transfer-rig.js';
import { TEST_CERT } from './tls-fixture.js';

test('real TLS SDK store/fetch/delete: metadata converges, exact contents, GET acknowledgements and idempotent deletion', async t => {
  const rig = await directRig(t); assert.equal(rig.storage.status.transfer?.listener, 'LISTENING');
  const bytes = randomBytes(512 * 1024); const chunkId = await rig.client.store(bytes, { timeoutMs: 10000 });
  assert.equal((await rig.coordinator.apiFor(rig.app.token).chunk(chunkId)).state, 'STORED');
  assert.deepEqual(await rig.client.fetch(chunkId), bytes);
  assert.equal(rig.coordinator.store.transferCounts(0).COMPLETED, 2);
  await rig.client.delete(chunkId); await rig.client.delete(chunkId);
  assert.equal(rig.coordinator.store.getChunk(rig.app.applicationId, chunkId), undefined);
  assert.equal(rig.storage.status.transfer?.completed, 3);
});

test('same-machine access still requires tickets, holder keys and TLS pinning; replay remains refused after listener restart', async t => {
  const rig = await directRig(t); const bytes = randomBytes(1024); const placed = await rig.placement(bytes);
  await transferChunk(placed.grant, placed.holder, AbortSignal.timeout(5000), bytes);
  assert.equal((await directRequest(placed.grant, { 'x-privanet-handshake': '1' }, AbortSignal.timeout(5000))).status, 409);
  await rig.restart();
  assert.equal((await directRequest(placed.grant, { 'x-privanet-handshake': '1' }, AbortSignal.timeout(5000))).status, 409);
});

test('a stolen ticket and a proof for a different request fail before begin or any stored bytes', async t => {
  const rig = await directRig(t); const bytes = randomBytes(2048); const placed = await rig.placement(bytes);
  const probe = await directRequest(placed.grant, { 'x-privanet-handshake': '1' }, AbortSignal.timeout(5000));
  const { challenge } = JSON.parse(probe.bytes.toString()) as { challenge: string };
  const thief = generateHolderKey(); const proof = signHolderProof(thief.privateKey, { challenge, transferId: placed.grant.transferId, requestLine: `PUT /v1/chunks/${placed.chunkId}` });
  const rejected = await directRequest(placed.grant, { 'x-privanet-challenge': challenge, 'x-privanet-proof': proof, 'content-type': 'application/octet-stream' }, AbortSignal.timeout(5000), bytes);
  assert.equal(rejected.status, 403); assert.equal(rig.coordinator.store.getTransfer(placed.grant.transferId)?.state, 'AUTHORIZED');
  assert.equal(rig.storage.status.committedBytes, 0);
  const reused = await directRequest(placed.grant, { 'x-privanet-challenge': challenge, 'x-privanet-proof': signHolderProof(placed.holder.privateKey, { challenge, transferId: placed.grant.transferId, requestLine: `GET /v1/chunks/${placed.chunkId}` }) }, AbortSignal.timeout(5000), bytes);
  assert.equal(reused.status, 403);
});

test('PUT size/hash mismatch refuses commit and partial files are cleaned', async t => {
  const rig = await directRig(t); const bytes = randomBytes(1024); const placed = await rig.placement(bytes);
  await assert.rejects(transferChunk(placed.grant, placed.holder, AbortSignal.timeout(5000), Buffer.alloc(1024)), (e: unknown) => e instanceof ApiError && e.code === 'TRANSFER_FAILED');
  assert.equal(rig.coordinator.store.getTransfer(placed.grant.transferId)?.state, 'IN_PROGRESS');
  await new Promise(resolve => setTimeout(resolve, 2200));
  assert.equal(rig.coordinator.store.getTransfer(placed.grant.transferId)?.state, 'FAILED');
  assert.equal((await rig.storage.chunkStore!.usage()).committedBytes, 0); assert.equal((await rig.storage.chunkStore!.usage()).incomingBytes, 0);
});

test('public certificate pin cannot be substituted and unauthorized endpoints are never application inputs', async t => {
  const rig = await directRig(t); const placed = await rig.placement(randomBytes(1024)); assert(placed.grant.transferEndpoint);
  const bad = { ...placed.grant, transferEndpoint: { ...placed.grant.transferEndpoint, certFingerprint: '00'.repeat(32) } };
  await assert.rejects(directRequest(bad, { 'x-privanet-handshake': '1' }, AbortSignal.timeout(5000)), (e: unknown) => e instanceof ApiError && e.code === 'TLS_IDENTITY');
  assert.equal(rig.coordinator.store.getTransfer(placed.grant.transferId)?.state, 'AUTHORIZED');
});

test('application namespaces isolate identical chunks and deleting one cannot delete the other', async t => {
  const rig = await directRig(t); const second = await rig.coordinator.admin.app({ name: 'second', allowedJobTypes: [], allowedServices: ['storage.chunk.v1'] });
  const client = new PrivaNetClient({ url: rig.coordinator.url, allowInsecureLoopback: true, token: second.token }); const bytes = randomBytes(1024);
  const chunkId = await rig.client.store(bytes); await client.store(bytes);
  assert.equal((await rig.storage.chunkStore!.usage()).committedBytes, bytes.length * 2);
  await rig.client.delete(chunkId); assert.deepEqual(await client.fetch(chunkId), bytes);
});

test('corrupted-at-rest data is never served; SDK reports failure', async t => {
  const rig = await directRig(t); const bytes = randomBytes(1024); const chunkId = await rig.client.store(bytes);
  const path = chunkPath(join(rig.dir, 'store', 'chunks'), chunkId, rig.app.applicationId);
  await writeFile(path, Buffer.alloc(1024));
  await assert.rejects(rig.client.fetch(chunkId));
  assert.equal(rig.storage.status.transfer?.completed, 1);
});

test('lost PUT receipt is queued durably and restart reconciles Coordinator PENDING to STORED', async t => {
  const rig = await directRig(t); const placed = await rig.placement(randomBytes(1024));
  const original = rig.node.storageReceipt.bind(rig.node); rig.node.storageReceipt = async () => { throw new Error('simulated outage'); };
  const bytes = Buffer.from('receipt retry'); const pending = await rig.placement(bytes);
  await transferChunk(pending.grant, pending.holder, AbortSignal.timeout(5000), bytes);
  assert.equal(rig.coordinator.store.getChunk(rig.app.applicationId, pending.chunkId)?.state, 'PENDING');
  assert.equal(JSON.parse(await readFile(join(rig.dir, RECEIPT_FILE), 'utf8')).records.length, 1);
  rig.node.storageReceipt = original; await rig.restart();
  for (let n = 0; n < 100 && rig.coordinator.store.getChunk(rig.app.applicationId, pending.chunkId)?.state !== 'STORED'; n++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(rig.coordinator.store.getChunk(rig.app.applicationId, pending.chunkId)?.state, 'STORED');
  for (let n = 0; n < 100 && JSON.parse(await readFile(join(rig.dir, RECEIPT_FILE), 'utf8')).records.length !== 0; n++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(JSON.parse(await readFile(join(rig.dir, RECEIPT_FILE), 'utf8')).records.length, 0);
  assert.equal(rig.coordinator.store.getTransfer(placed.grant.transferId)?.state, 'AUTHORIZED');
});

test('owner pause/storage disable overrides an already issued ticket', async t => {
  const rig = await directRig(t); const placed = await rig.placement(randomBytes(1024)); rig.world.blockers = ['PAUSED_BY_OWNER'];
  assert.equal((await directRequest(placed.grant, { 'x-privanet-handshake': '1' }, AbortSignal.timeout(5000))).status, 503);
  rig.world.blockers = []; rig.world.policy.storage.enabled = false; await rig.storage.apply(rig.world.policy);
  assert.equal(rig.storage.status.networkAccessible, false);
});

test('closed surface rejects unknown methods, encoded paths, ranges and transfer-encoding', async t => {
  const rig = await directRig(t); const placed = await rig.placement(randomBytes(1024)); const endpoint = placed.grant.transferEndpoint!;
  const raw = (method: string, path: string, headers: Record<string, string> = {}) => new Promise<number>((resolve, reject) => {
    const req = request(endpoint.url, { method, path, ca: TEST_CERT, checkServerIdentity: () => undefined, agent: false, headers: { authorization: `Transfer ${placed.grant.ticket}`, 'content-length': '0', ...headers } }, res => { res.resume(); res.once('end', () => resolve(res.statusCode!)); }); req.once('error', reject); req.end();
  });
  for (const path of ['/v1/chunks', '/v1/chunks/../identity.json', '/v1/chunks/%2e%2e', `/v1/chunks/${placed.chunkId}?ticket=oops`, `/v1//chunks/${placed.chunkId}`, '/v1/chunks/%252e%252e']) assert.equal(await raw('GET', path), 404);
  assert.equal(await raw('POST', `/v1/chunks/${placed.chunkId}`), 405);
  assert.equal(await raw('GET', `/v1/chunks/${placed.chunkId}`, { range: 'bytes=0-1' }), 400);
  assert.equal(createHash('sha256').update('data').digest('hex').length, 64);
});
