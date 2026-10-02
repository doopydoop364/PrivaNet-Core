import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AppCreateSchema, CapabilitiesSchema, ChunkIdSchema, EnrollmentTokenRequestSchema, HeartbeatSchema, JOB_TYPES, JOB_TYPE_IDS, JobTypeSchema, PlacementRequestSchema, SERVICES, SERVICE_IDS,
  STORAGE_MAX_CHUNK_BYTES, ServiceIdSchema, ServicesAdvertisementSchema, SubmitSchema, TicketRequestSchema, TransferGrantSchema, TransferKeysSchema, TransferReceiptSchema, capabilityKind,
} from '@privanet/protocol';
import { MAX_CHUNK_BYTES } from '@privanet/node/store/limits';

const heartbeat = { protocolVersion: 1, daemonVersion: '0.4.0-alpha.2', capabilities: ['system.echo.v1'], jobSlots: 1, currentJobs: 0 };
const advert = { capacityBytes: 1000, freeBytes: 400, maxChunkBytes: STORAGE_MAX_CHUNK_BYTES };

test('services have their own registry: every service is kind "service", every job is kind "job", and the two never overlap', () => {
  assert.deepEqual([...SERVICE_IDS], ['storage.chunk.v1']);
  for (const id of SERVICE_IDS) { assert.equal(SERVICES[id].kind, 'service'); assert.equal(SERVICES[id].capability, id); assert.equal(capabilityKind(id), 'service'); }
  for (const id of JOB_TYPE_IDS) { assert.equal(JOB_TYPES[id].kind, 'job'); assert.equal(capabilityKind(id), 'job'); assert.equal(Object.hasOwn(SERVICES, id), false); }
  for (const id of SERVICE_IDS) assert.equal(Object.hasOwn(JOB_TYPES, id), false);
  for (const unregistered of ['storage.chunk.v2', 'storage.drive.v1', 'toString', '__proto__', 'constructor', '', 'STORAGE.CHUNK.V1']) assert.equal(capabilityKind(unregistered), undefined);
});
test('a service can never be a job: every job-facing schema derived from JOB_TYPES refuses it, and every service-facing one refuses job ids', () => {
  assert.equal(JobTypeSchema.safeParse('storage.chunk.v1').success, false);
  assert.equal(CapabilitiesSchema.safeParse(['storage.chunk.v1']).success, false);
  assert.equal(SubmitSchema.safeParse({ type: 'storage.chunk.v1', input: {}, idempotencyKey: 'k' }).success, false);
  assert.equal(HeartbeatSchema.safeParse({ ...heartbeat, capabilities: ['storage.chunk.v1'] }).success, false);
  assert.equal(EnrollmentTokenRequestSchema.safeParse({ expiresInMs: 5000, capabilities: ['storage.chunk.v1'] }).success, false);
  assert.equal(AppCreateSchema.safeParse({ name: 'a', allowedJobTypes: ['storage.chunk.v1'] }).success, false);
  for (const id of JOB_TYPE_IDS) { assert.equal(ServiceIdSchema.safeParse(id).success, false); assert.equal(AppCreateSchema.safeParse({ name: 'a', allowedJobTypes: [], allowedServices: [id] }).success, false); }
  assert.equal(ServiceIdSchema.safeParse('storage.chunk.v1').success, true);
});
test('the heartbeat services member is optional, strict and bounded; old heartbeats stay valid', () => {
  assert.equal(HeartbeatSchema.safeParse(heartbeat).success, true);
  assert.equal(HeartbeatSchema.safeParse({ ...heartbeat, services: {} }).success, true);
  assert.equal(HeartbeatSchema.safeParse({ ...heartbeat, services: { 'storage.chunk.v1': advert } }).success, true);
  const bad: unknown[] = [
    { 'storage.chunk.v2': advert }, { 'system.echo.v1': advert }, { 'storage.chunk.v1': { ...advert, endpoint: 'https://x' } }, { 'storage.chunk.v1': { ...advert, path: '/srv' } },
    { 'storage.chunk.v1': { capacityBytes: 1000, freeBytes: 400 } }, { 'storage.chunk.v1': { ...advert, freeBytes: 1001 } }, { 'storage.chunk.v1': { ...advert, freeBytes: -1 } },
    { 'storage.chunk.v1': { ...advert, capacityBytes: Number.NaN } }, { 'storage.chunk.v1': { ...advert, capacityBytes: Number.POSITIVE_INFINITY } }, { 'storage.chunk.v1': { ...advert, capacityBytes: 1.5 } },
    { 'storage.chunk.v1': { ...advert, capacityBytes: Number.MAX_SAFE_INTEGER, freeBytes: 0 } }, { 'storage.chunk.v1': { ...advert, capacityBytes: '1000' } }, { 'storage.chunk.v1': { ...advert, maxChunkBytes: 0 } },
    { 'storage.chunk.v1': { ...advert, maxChunkBytes: STORAGE_MAX_CHUNK_BYTES + 1 } }, { 'storage.chunk.v1': null }, [], 'storage.chunk.v1',
  ];
  for (const services of bad) assert.equal(HeartbeatSchema.safeParse({ ...heartbeat, services }).success, false, JSON.stringify(services));
  assert.equal(ServicesAdvertisementSchema.safeParse({ 'storage.chunk.v1': { capacityBytes: 2 ** 50, freeBytes: 2 ** 50, maxChunkBytes: 1 } }).success, true);
  assert.equal(ServicesAdvertisementSchema.safeParse({ 'storage.chunk.v1': { capacityBytes: 2 ** 50 + 1, freeBytes: 0, maxChunkBytes: 1 } }).success, false);
});
test('allowedServices is optional and additive: an old create request is still valid, and the default is nothing', () => {
  assert.equal(AppCreateSchema.safeParse({ name: 'a', allowedJobTypes: ['web.fetch.v1'] }).success, true);
  assert.equal(AppCreateSchema.safeParse({ name: 'a', allowedJobTypes: [], allowedServices: ['storage.chunk.v1'] }).success, true);
  assert.equal(AppCreateSchema.safeParse({ name: 'a', allowedJobTypes: [], allowedServices: ['storage.chunk.v1', 'storage.chunk.v1'] }).success, false);
  assert.equal(AppCreateSchema.safeParse({ name: 'a', allowedJobTypes: [], allowedServices: ['*'] }).success, false);
});
test('the chunk limit is one constant shared by the store and the wire, and chunk ids are exactly chk_ plus 64 lowercase hex', () => {
  assert.equal(MAX_CHUNK_BYTES, STORAGE_MAX_CHUNK_BYTES); assert.equal(STORAGE_MAX_CHUNK_BYTES, 8388608);
  for (const ok of [`chk_${'a'.repeat(64)}`, `chk_${'0123456789abcdef'.repeat(4)}`]) assert.equal(ChunkIdSchema.safeParse(ok).success, true);
  for (const bad of [`chk_${'A'.repeat(64)}`, `chk_${'a'.repeat(63)}`, `chk_${'a'.repeat(65)}`, `chk_${'a'.repeat(63)}g`, `${'a'.repeat(64)}`, `chk_${'a'.repeat(64)}\n`, `chk_../${'a'.repeat(60)}`, 'chk_', '']) assert.equal(ChunkIdSchema.safeParse(bad).success, false);
});
test('placement and ticket requests take only bounded metadata: no path, node, address, endpoint, capability or bytes', () => {
  const holderKey = 'MCowBQYDK2VwAyEA6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iw='; const chunkId = `chk_${'ab'.repeat(32)}`;
  assert.equal(PlacementRequestSchema.safeParse({ chunkId, size: 1, holderKey }).success, true);
  assert.equal(PlacementRequestSchema.safeParse({ chunkId, size: STORAGE_MAX_CHUNK_BYTES, class: 'drive-chunk', holderKey }).success, true);
  for (const extra of [{ nodeId: `node_${'a'.repeat(64)}` }, { path: '/etc/passwd' }, { endpoint: 'https://x' }, { address: '10.0.0.1' }, { capability: 'storage.chunk.v1' }, { data: 'AAAA' }, { bytes: 'AAAA' }, { applicationId: 'x' }]) assert.equal(PlacementRequestSchema.safeParse({ chunkId, size: 1, holderKey, ...extra }).success, false);
  for (const size of [0, -1, 1.5, STORAGE_MAX_CHUNK_BYTES + 1, Number.NaN, '5']) assert.equal(PlacementRequestSchema.safeParse({ chunkId, size, holderKey }).success, false);
  for (const cls of ['', 'Drive', '1abc', 'a'.repeat(33), 'a b', '../x', 'a\n']) assert.equal(PlacementRequestSchema.safeParse({ chunkId, size: 1, class: cls, holderKey }).success, false);
  for (const operation of ['put', 'get', 'delete']) assert.equal(TicketRequestSchema.safeParse({ operation, chunkId, holderKey }).success, true);
  for (const operation of ['list', 'head', 'PUT', '']) assert.equal(TicketRequestSchema.safeParse({ operation, chunkId, holderKey }).success, false);
  assert.equal(TicketRequestSchema.safeParse({ operation: 'get', chunkId: 'chk_x', holderKey }).success, false);
  assert.equal(TicketRequestSchema.safeParse({ operation: 'get', chunkId, holderKey: holderKey.slice(0, 59) }).success, false);
});
test('a grant, a key list and a receipt are strict, and the grant has no endpoint field', () => {
  const grant = { transferId: 'ab'.repeat(16), operation: 'put', chunkId: `chk_${'ab'.repeat(32)}`, expiresAt: 1, ticket: 'A'.repeat(312) };
  assert.equal(TransferGrantSchema.safeParse(grant).success, true);
  assert.equal(TransferGrantSchema.safeParse({ ...grant, endpoint: 'https://x' }).success, false); assert.equal(TransferGrantSchema.safeParse({ ...grant, ticket: 'A'.repeat(311) }).success, false);
  const key = { kid: 'ab'.repeat(8), publicKey: 'MCowBQYDK2VwAyEA6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iw=', notAfter: null };
  assert.equal(TransferKeysSchema.safeParse({ coordinatorId: crypto.randomUUID(), keys: [key] }).success, true); assert.equal(TransferKeysSchema.safeParse({ coordinatorId: crypto.randomUUID(), keys: [] }).success, false);
  assert.equal(TransferKeysSchema.safeParse({ coordinatorId: crypto.randomUUID(), keys: Array(5).fill(key) }).success, false);
  const receipt = { transferId: 'ab'.repeat(16), operation: 'put', applicationId: crypto.randomUUID(), chunkId: `chk_${'ab'.repeat(32)}`, bytes: 5, sha256: 'ab'.repeat(32), nodeId: `node_${'cd'.repeat(32)}`, completedAt: 5 };
  assert.equal(TransferReceiptSchema.safeParse(receipt).success, true); assert.equal(TransferReceiptSchema.safeParse({ ...receipt, operation: 'get' }).success, false);
  assert.equal(TransferReceiptSchema.safeParse({ ...receipt, bytes: STORAGE_MAX_CHUNK_BYTES + 1 }).success, false); assert.equal(TransferReceiptSchema.safeParse({ ...receipt, extra: 1 }).success, false);
});
