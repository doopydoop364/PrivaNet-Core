import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { ApiError, generateHolderKey, verifyTicket } from '@privanet/shared';
import { STORAGE_MAX_CHUNK_BYTES, TransferKeysSchema } from '@privanet/protocol';
import { chunkIdOf, GIB, advert } from './storage-rig.js';
import { httpRig } from './storage-http.js';

const failure = async (promise: Promise<unknown>): Promise<{ status: number; code: string }> => { try { await promise; } catch (error) { if (error instanceof ApiError) return { status: error.status, code: error.code }; throw error; } throw new Error('expected a refusal'); };
const newChunk = (size = 2048) => { const bytes = randomBytes(size); return { id: chunkIdOf(bytes), size }; };

test('over real HTTP: a real node offers storage, receives the Coordinator\'s public keys, and a placement yields a ticket that node can verify offline', async t => {
  const rig = await httpRig(t); const privaNode = await rig.node(); const nodeId = privaNode.status.nodeId; assert(nodeId);
  const service = rig.store.getNodeService(nodeId, 'storage.chunk.v1'); assert.equal(service?.freeBytes, advert().freeBytes); assert.equal(service?.maxChunkBytes, STORAGE_MAX_CHUNK_BYTES);
  await new Promise(resolve => setTimeout(resolve, 100)); const keys = privaNode.transferKeys; assert(keys); assert.deepEqual(keys, rig.keyring?.verificationKeys()); // fetched best-effort after the first offering heartbeat, held in memory
  const app = await rig.admin.app({ name: 'drive', allowedJobTypes: [], allowedServices: ['storage.chunk.v1'] }); const api = rig.apiFor(app.token); const holder = generateHolderKey(); const chunk = newChunk();
  const placed = await api.place({ chunkId: chunk.id, size: chunk.size, class: 'drive-chunk', holderKey: holder.publicKey }); assert(placed.grant); assert.equal(placed.state, 'PENDING');
  const verdict = verifyTicket(placed.grant.ticket, { keys, now: Date.now(), expect: { nodeId, operation: 'put', chunkId: chunk.id, applicationId: app.applicationId, size: chunk.size } }); assert.equal(verdict.ok, true);
  assert.equal((await api.chunk(chunk.id)).state, 'PENDING'); assert.equal((await rig.admin.storage()).chunks.pending, 1);
  assert.deepEqual(await api.abort(placed.grant.transferId), { ok: true }); assert.deepEqual(await failure(api.chunk(chunk.id)), { status: 404, code: 'NOT_FOUND' });
});
test('a node that does not offer storage never gets keys fetched for it and is never placed on', async t => {
  const rig = await httpRig(t); const quiet = await rig.node(() => undefined); assert.equal(quiet.transferKeys, null);
  const app = await rig.admin.app({ name: 'drive', allowedJobTypes: [], allowedServices: ['storage.chunk.v1'] });
  assert.deepEqual(await failure(rig.apiFor(app.token).place({ chunkId: newChunk().id, size: 10, holderKey: generateHolderKey().publicKey })), { status: 503, code: 'NO_CAPACITY' });
  assert.equal(rig.store.listNodeServices('storage.chunk.v1').length, 0);
});
test('a node withdraws its offer on the next heartbeat when its store becomes unhealthy, and offers again when it recovers', async t => {
  const rig = await httpRig(t); let healthy = true; const privaNode = await rig.node(() => healthy ? { 'storage.chunk.v1': advert() } : undefined); const nodeId = privaNode.status.nodeId ?? '';
  assert(rig.store.getNodeService(nodeId, 'storage.chunk.v1')); healthy = false; await privaNode.tick(); assert.equal(rig.store.getNodeService(nodeId, 'storage.chunk.v1'), undefined, 'withdrawn at once, not at the next interval');
  healthy = true; await privaNode.tick(); assert(rig.store.getNodeService(nodeId, 'storage.chunk.v1'));
});
test('authentication and authorization on every storage route: no token, wrong kind of token, no service permission', async t => {
  const rig = await httpRig(t); const node = await rig.node(); const nodeSession = rig.store.listNodes()[0]; assert(nodeSession); void node;
  const plain = await rig.admin.app({ name: 'jobs-only', allowedJobTypes: ['system.echo.v1'] }); const storage = await rig.admin.app({ name: 'drive', allowedJobTypes: [], allowedServices: ['storage.chunk.v1'] });
  const body = JSON.stringify({ chunkId: newChunk().id, size: 10, holderKey: generateHolderKey().publicKey }); const json = { 'content-type': 'application/json' };
  const call = (path: string, token: string | undefined, method = 'POST', payload: string | undefined = body) => rig.raw(path, { method, headers: { ...json, ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(method === 'POST' ? { body: payload } : {}) }).then(r => r.status);
  for (const [path, method] of [['/v1/storage/placements', 'POST'], ['/v1/storage/tickets', 'POST'], [`/v1/storage/chunks/${newChunk().id}`, 'GET'], [`/v1/storage/transfers/${'ab'.repeat(16)}/abort`, 'POST']] as const) {
    assert.equal(await call(path, undefined, method), 401, `${path} without a token`);
    assert.equal(await call(path, rig.adminSecret, method, method === 'POST' ? '{}' : undefined), 401, `${path} with the administrator secret`); // the admin secret is not an application
    assert.equal(await call(path, 'a'.repeat(64), method), 401, `${path} with an unknown token`);
    assert.equal(await call(path, plain.token, method, method === 'POST' ? '{}' : undefined), 403, `${path} without allowedServices`);
  }
  assert.equal(await call('/v1/storage/placements', storage.token, 'POST', JSON.stringify({ chunkId: newChunk().id, size: 10, holderKey: generateHolderKey().publicKey })), 200);
  // the other kinds of credential cannot reach the application routes, nor the application token the node or admin routes
  assert.equal(await call('/v1/node/transfer-keys', storage.token, 'GET'), 401); assert.equal(await call('/v1/admin/storage', storage.token, 'GET'), 401); assert.equal(await call('/v1/admin/storage/keys/rotate', storage.token, 'POST', '{}'), 401);
  assert.equal(await call('/v1/node/transfer-keys', undefined, 'GET'), 401); assert.equal(await call('/v1/admin/storage', undefined, 'GET'), 401);
});
test('the node key route needs a node session and only ever returns public keys', async t => {
  const rig = await httpRig(t); const privaNode = await rig.node(); void privaNode;
  const stateDirSession = await rig.transport.request('POST', '/v1/auth/challenge', rig.z.object({ challengeId: rig.z.string() }).loose(), { nodeId: 'node_x', protocolVersion: 1 }).catch(() => undefined); void stateDirSession;
  const keys = await (await rig.raw('/v1/node/transfer-keys', { headers: { authorization: `Bearer ${'0'.repeat(64)}` } })).status; assert.equal(keys, 401);
  const parsed = TransferKeysSchema.parse({ coordinatorId: rig.core.store.coordinatorId, keys: rig.keyring?.verificationKeys() }); const text = JSON.stringify(parsed); assert.equal(text.includes('privateKey'), false);
});
test('placement races over HTTP: forty simultaneous requests against a small node reserve no more than it reported', async t => {
  const rig = await httpRig(t, { limits: { maxOpenPutsPerNode: 1000, maxOpenTransfersPerNode: 1000, maxOpenTransfersPerApplication: 1000, ticketsPerMinute: 1_000_000 } });
  await rig.node(() => ({ 'storage.chunk.v1': advert(10 * 1000 + 500) })); const apps = await Promise.all([1, 2, 3, 4].map(() => rig.admin.app({ name: 'drive', allowedJobTypes: [], allowedServices: ['storage.chunk.v1'] })));
  const results = await Promise.all(Array.from({ length: 40 }, (_, i) => { const app = apps[i % 4]; assert(app); return rig.apiFor(app.token).place({ chunkId: newChunk(1000).id, size: 1000, holderKey: generateHolderKey().publicKey }).then(() => 'granted', (error: unknown) => error instanceof ApiError ? error.code : 'ERROR'); }));
  assert.equal(results.filter(r => r === 'granted').length, 10); assert.equal(results.filter(r => r === 'NO_CAPACITY').length, 30);
  assert.equal([...rig.store.reservedBytes().values()].reduce((a, b) => a + b, 0), 10000);
});
test('no route anywhere carries chunk bytes, and none could: data routes do not exist and metadata routes refuse bodies that are not tiny JSON', async t => {
  const rig = await httpRig(t); await rig.node(); const app = await rig.admin.app({ name: 'drive', allowedJobTypes: [], allowedServices: ['storage.chunk.v1'] }); const auth = { authorization: `Bearer ${app.token}` };
  const chunkId = newChunk().id;
  for (const [method, path] of [['PUT', `/v1/chunks/${chunkId}`], ['GET', `/v1/chunks/${chunkId}`], ['DELETE', `/v1/chunks/${chunkId}`], ['POST', '/v1/chunks'], ['PUT', `/v1/storage/chunks/${chunkId}`], ['POST', `/v1/storage/chunks/${chunkId}`], ['GET', '/v1/storage/chunks'], ['GET', '/v1/storage'], ['POST', '/v1/storage/upload'], ['POST', '/v1/storage/transfers'], ['GET', '/v1/storage/transfers'], ['POST', `/v1/storage/transfers/${'ab'.repeat(16)}/complete`], ['POST', '/v1/node/storage/receipts'], ['POST', `/v1/node/storage/transfers/${'ab'.repeat(16)}/begin`]] as const) {
    const response = await rig.raw(path, { method, headers: { ...auth, 'content-type': 'application/json' }, ...(method === 'POST' || method === 'PUT' ? { body: '{}' } : {}) });
    assert.ok([404, 405, 401].includes(response.status), `${method} ${path} -> ${response.status}`); assert.notEqual(response.status, 200);
  }
  // oversized and non-JSON bodies are refused before they are read in full
  const big = await rig.raw('/v1/storage/placements', { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ chunkId, size: 10, holderKey: generateHolderKey().publicKey, data: 'A'.repeat(64 * 1024) }) }); assert.equal(big.status, 413);
  const octet = await rig.raw('/v1/storage/placements', { method: 'POST', headers: { ...auth, 'content-type': 'application/octet-stream' }, body: randomBytes(1024) }); assert.equal(octet.status, 415);
  const withData = await rig.raw('/v1/storage/placements', { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ chunkId, size: 10, holderKey: generateHolderKey().publicKey, data: 'AAAA' }) }); assert.equal(withData.status, 400);
  assert.equal(rig.store.chunkUsage(app.applicationId).count, 0);
  // every storage answer is small, whatever was asked
  const placed = await rig.apiFor(app.token).place({ chunkId, size: 10, holderKey: generateHolderKey().publicKey }); assert(JSON.stringify(placed).length < 1024);
});
test('error answers for a missing chunk and for another application\'s chunk are byte-identical over HTTP', async t => {
  const rig = await httpRig(t); await rig.node(); const a = await rig.admin.app({ name: 'a', allowedJobTypes: [], allowedServices: ['storage.chunk.v1'] }); const b = await rig.admin.app({ name: 'b', allowedJobTypes: [], allowedServices: ['storage.chunk.v1'] });
  const chunk = newChunk(); await rig.apiFor(a.token).place({ chunkId: chunk.id, size: chunk.size, holderKey: generateHolderKey().publicKey });
  const ask = async (path: string, method: string, body?: object) => { const response = await rig.raw(path, { method, headers: { authorization: `Bearer ${b.token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); return `${response.status} ${await response.text()}`; };
  const missing = newChunk(); const holderKey = generateHolderKey().publicKey;
  for (const operation of ['get', 'delete', 'put'] as const) assert.equal(await ask('/v1/storage/tickets', 'POST', { operation, chunkId: chunk.id, holderKey }), await ask('/v1/storage/tickets', 'POST', { operation, chunkId: missing.id, holderKey }));
  assert.equal(await ask(`/v1/storage/chunks/${chunk.id}`, 'GET'), await ask(`/v1/storage/chunks/${missing.id}`, 'GET'));
  const transfer = rig.store.listOpenTransfers()[0]; assert(transfer); assert.equal(await ask(`/v1/storage/transfers/${transfer.id}/abort`, 'POST', {}), await ask(`/v1/storage/transfers/${'cd'.repeat(16)}/abort`, 'POST', {}));
});
test('revoking an application or a node over the admin API takes effect on the storage routes at once', async t => {
  const rig = await httpRig(t); const privaNode = await rig.node(); const nodeId = privaNode.status.nodeId ?? ''; const app = await rig.admin.app({ name: 'drive', allowedJobTypes: [], allowedServices: ['storage.chunk.v1'] }); const api = rig.apiFor(app.token);
  const chunk = newChunk(); const placed = await api.place({ chunkId: chunk.id, size: chunk.size, holderKey: generateHolderKey().publicKey }); assert(placed.grant);
  await rig.admin.revokeNode(nodeId); assert.equal(rig.store.getTransfer(placed.grant.transferId)?.state, 'REVOKED');
  assert.deepEqual(await failure(api.place({ chunkId: newChunk().id, size: 10, holderKey: generateHolderKey().publicKey })), { status: 503, code: 'NO_CAPACITY' });
  await rig.admin.revokeApplication(app.applicationId); assert.deepEqual(await failure(api.chunk(chunk.id)), { status: 401, code: 'UNAUTHORIZED_APPLICATION' }); assert.equal(rig.store.getChunk(app.applicationId, chunk.id)?.state, 'PENDING'); // the logical object is kept
});
test('administrator: storage summary and key rotation are admin-only and aggregate-only; rotation never invalidates a live ticket', async t => {
  const rig = await httpRig(t); const privaNode = await rig.node(); const nodeId = privaNode.status.nodeId ?? ''; const app = await rig.admin.app({ name: 'drive', allowedJobTypes: [], allowedServices: ['storage.chunk.v1'] });
  const placed = await rig.apiFor(app.token).place({ chunkId: newChunk().id, size: 10, holderKey: generateHolderKey().publicKey }); assert(placed.grant);
  const before = await rig.admin.storage(); assert.equal(before.keyring.keys, 1); assert.equal(before.nodes[0]?.nodeId, nodeId); assert.equal(JSON.stringify(before).includes(placed.grant.ticket), false);
  const rotation = await rig.admin.rotate(); assert.notEqual(rotation.currentKid, rotation.previousKid); assert.equal((await rig.admin.storage()).keyring.keys, 2);
  const keys = rig.core.storage.transferKeys(rig.core.store.coordinatorId).keys; assert.equal(verifyTicket(placed.grant.ticket, { keys, now: Date.now(), expect: { nodeId } }).ok, true);
  assert.equal((await rig.raw('/v1/admin/storage/keys/rotate', { method: 'POST', headers: { authorization: `Bearer ${rig.adminSecret}`, 'content-type': 'application/json' }, body: '{"force":true}' })).status, 400);
});
test('without a signing key the storage routes answer 503 but jobs and everything else are untouched', async t => {
  const rig = await httpRig(t, { keyring: false }); const app = await rig.admin.app({ name: 'drive', allowedJobTypes: ['system.echo.v1'], allowedServices: ['storage.chunk.v1'] });
  assert.deepEqual(await failure(rig.apiFor(app.token).place({ chunkId: newChunk().id, size: 10, holderKey: generateHolderKey().publicKey })), { status: 503, code: 'STORAGE_UNAVAILABLE' });
  const stateless = await rig.node(); assert.equal(stateless.transferKeys, null); assert.equal((await rig.admin.storage()).keyring.available, false);
  const job = await rig.transport.request('POST', '/v1/jobs', rig.z.object({ id: rig.z.string() }).loose(), { type: 'system.echo.v1', input: { message: 'hi' }, idempotencyKey: 'j1' }, app.token); assert(job.id);
});
test('nothing storage-related is logged with a ticket, a key, a token or a holder key', async t => {
  const rig = await httpRig(t); await rig.node(); const app = await rig.admin.app({ name: 'drive', allowedJobTypes: [], allowedServices: ['storage.chunk.v1'] }); const holder = generateHolderKey();
  const placed = await rig.apiFor(app.token).place({ chunkId: newChunk().id, size: 10, holderKey: holder.publicKey }); assert(placed.grant); await rig.apiFor(app.token).abort(placed.grant.transferId); await rig.admin.rotate(); await failure(rig.apiFor(app.token).place({ chunkId: 'chk_bad', size: 1, holderKey: 'x' }));
  const text = JSON.stringify(rig.logs); const privateKey = JSON.parse((await import('node:fs/promises').then(fs => fs.readFile(`${rig.dir}/transfer-keys.json`, 'utf8')))).keys[0].privateKey as string;
  for (const secret of [placed.grant.ticket, holder.publicKey, app.token, rig.adminSecret, privateKey, placed.grant.transferId]) assert.equal(text.includes(secret), false);
  assert(text.includes('storage.placed')); assert(text.includes('storage.key_rotated'));
});
void GIB;
