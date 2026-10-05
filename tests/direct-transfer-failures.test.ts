import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { connect } from 'node:tls';
import { connect as tcpConnect } from 'node:net';
import { request } from 'node:https';
import { readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ApiError, parseTicket, signTicket, signHolderProof, generateHolderKey, bindTransferEndpoint, transferEndpoint, validateTransferEndpoint } from '@privanet/shared';
import type { TicketClaims } from '@privanet/shared';
import { ResourcePolicySchema } from '@privanet/node/resource-policy';
import { transferConfig } from '@privanet/node/store/transfer-config';
import { RECEIPT_FILE } from '@privanet/node/store/receipt-queue';
import { REPLAY_STATE_FILE } from '@privanet/node/store/replay-state';
import { directRig } from './direct-transfer-rig.js';
import { TEST_CERT, TEST_KEY } from './tls-fixture.js';
const { directRequest, transferChunk } = await import(new URL('../../packages/sdk/dist/chunk-transfer.js', import.meta.url).href) as typeof import('../packages/sdk/dist/chunk-transfer.js');

test('signed tickets cannot substitute node, chunk, method, application, transfer or authorized size; forged/expired/future/unknown tickets fail closed', async t => {
  const rig = await directRig(t); const bytes = randomBytes(1024); const placed = await rig.placement(bytes); const claims = parseTicket(placed.grant.ticket)!.claims;
  const signing = rig.coordinator.keyring!.current();
  const variations: [string, Partial<TicketClaims>][] = [
    ['node', { nodeId: `node_${'11'.repeat(32)}` }], ['chunk', { chunkId: `chk_${'22'.repeat(32)}` }], ['method', { operation: 'get' }],
    ['expired', { issuedAt: Date.now() - 240000, expiresAt: Date.now() - 120000 }], ['future', { issuedAt: Date.now() + 120000, expiresAt: Date.now() + 180000 }],
    ['unknown key', { kid: '33'.repeat(8) }],
  ];
  for (const [name, patch] of variations) await t.test(name, async () => {
    const altered = { ...claims, ...patch }; const ticket = signTicket(altered, signing.privateKey);
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(placed.grant.transferEndpoint!.url, { method: 'PUT', path: `/v1/chunks/${placed.chunkId}`, agent: false, ca: TEST_CERT, checkServerIdentity: () => undefined, headers: { authorization: `Transfer ${ticket}`, 'content-length': '0', 'x-privanet-handshake': '1' } }, res => { res.resume(); res.once('end', () => resolve(res.statusCode!)); }); req.once('error', reject); req.end();
    });
    assert.equal(status, 403);
  });
  for (const [name, patch] of [['application', { applicationId: randomUUID() }], ['transfer', { transferId: '44'.repeat(16) }], ['size', { maxBytes: 512 }]] as [string, Partial<TicketClaims>][]) await t.test(name, async () => {
    const fresh = await rig.placement(randomBytes(1024)); const original = parseTicket(fresh.grant.ticket)!.claims;
    const altered = { ...original, ...patch }; const grant = { ...fresh.grant, transferId: altered.transferId, ticket: signTicket(altered, signing.privateKey) };
    // Coordinator begin must bind every signed fact, not merely the transfer id.
    await assert.rejects(transferChunk(grant, fresh.holder, AbortSignal.timeout(5000), bytes.subarray(0, altered.maxBytes)));
  });
  assert.equal(rig.storage.status.committedBytes, 0);
  const modified = Buffer.from(placed.grant.ticket, 'base64url'); modified[modified.length - 1] = modified[modified.length - 1]! ^ 1;
  assert.equal((await directRequest({ ...placed.grant, ticket: modified.toString('base64url') }, { 'x-privanet-handshake': '1' }, AbortSignal.timeout(5000))).status, 403);
});

test('key rotation: cached old key works inside overlap; new kid refresh is bounded and eventually enables a live transfer', { timeout: 15000 }, async t => {
  const rig = await directRig(t); const oldBytes = randomBytes(1024); const old = await rig.placement(oldBytes);
  await rig.coordinator.admin.rotate(); await transferChunk(old.grant, old.holder, AbortSignal.timeout(5000), oldBytes);
  // Initial periodic fetch spends the global unknown-key budget for five seconds.
  await new Promise(resolve => setTimeout(resolve, 5100));
  await rig.client.store(randomBytes(1024), { timeoutMs: 5000 });
  assert.equal(rig.storage.status.transfer?.completed, 2);
});

test('revoked authorization and node/app revocation cannot begin a transfer', async t => {
  for (const kind of ['abort', 'app', 'node']) await t.test(kind, async t => {
    const rig = await directRig(t); const bytes = randomBytes(1024); const placed = await rig.placement(bytes);
    if (kind === 'abort') await rig.coordinator.apiFor(rig.app.token).abort(placed.grant.transferId);
    else if (kind === 'app') await rig.coordinator.admin.revokeApplication(rig.app.applicationId);
    else await rig.coordinator.admin.revokeNode(rig.node.status.nodeId!);
    await assert.rejects(transferChunk(placed.grant, placed.holder, AbortSignal.timeout(5000), bytes)); assert.equal((await rig.storage.chunkStore!.usage()).committedBytes, 0);
  });
});

test('pause, drain and schedule forbid new direct requests; storage capacity alone starts no listener', async t => {
  const rig = await directRig(t); const placed = await rig.placement(randomBytes(1024));
  for (const blocker of ['PAUSED_BY_OWNER', 'SCHEDULE_OFF', 'ON_BATTERY']) { rig.world.blockers = [blocker]; assert.equal((await directRequest(placed.grant, { 'x-privanet-handshake': '1' }, AbortSignal.timeout(5000))).status, 503); }
  rig.world.blockers = []; rig.node.drain(); assert.equal((await directRequest(placed.grant, { 'x-privanet-handshake': '1' }, AbortSignal.timeout(5000))).status, 503);
  rig.world.policy.storage.transfer.enabled = false; await rig.storage.apply(rig.world.policy); assert.equal(rig.storage.status.transfer?.listener, 'DISABLED'); assert(rig.storage.chunkStore);
});

test('short, disconnected, stalled PUTs clean partial files and never complete', async t => {
  for (const kind of ['short', 'disconnect', 'stall']) await t.test(kind, async t => {
    const rig = await directRig(t, { timeoutMs: 400, idleMs: 200 }); const placed = await rig.placement(randomBytes(4096));
    const probe = await directRequest(placed.grant, { 'x-privanet-handshake': '1' }, AbortSignal.timeout(5000)); const challenge = JSON.parse(probe.bytes.toString()).challenge as string;
    const proof = signHolderProof(placed.holder.privateKey, { challenge, transferId: placed.grant.transferId, requestLine: `PUT /v1/chunks/${placed.chunkId}` });
    await new Promise<void>(resolve => {
      const req = request(placed.grant.transferEndpoint!.url, { method: 'PUT', path: `/v1/chunks/${placed.chunkId}`, agent: false, ca: TEST_CERT, checkServerIdentity: () => undefined,
        headers: { authorization: `Transfer ${placed.grant.ticket}`, 'content-length': '4096', 'content-type': 'application/octet-stream', 'x-privanet-challenge': challenge, 'x-privanet-proof': proof } }, res => { res.resume(); res.on('end', resolve); });
      req.on('error', () => resolve()); req.setTimeout(1500, () => req.destroy()); req.write(Buffer.alloc(128));
      if (kind === 'short') req.end(); if (kind === 'disconnect') setTimeout(() => req.destroy(), 60);
    });
    await new Promise(resolve => setTimeout(resolve, 450)); const usage = await rig.storage.chunkStore!.usage(); assert.equal(usage.committedBytes, 0); assert.equal(usage.incomingBytes, 0); assert.notEqual(rig.coordinator.store.getTransfer(placed.grant.transferId)?.state, 'COMPLETED');
  });
});

test('corrupt replay, receipt or TLS key refuses the listener and never erases state', async t => {
  for (const file of [REPLAY_STATE_FILE, RECEIPT_FILE, 'key.pem']) await t.test(file, async t => {
    const rig = await directRig(t); await rig.storage.stop(); const path = join(rig.dir, file); await writeFile(path, '{invalid security state', { mode: 0o600 });
    await rig.restart(); assert.equal(rig.storage.status.transfer?.listener, 'FAILED'); assert.equal(await readFile(path, 'utf8'), '{invalid security state');
  });
});

test('malformed HTTP/TLS, duplicate lengths, request smuggling and oversized headers never reach begin', async t => {
  const rig = await directRig(t); const placed = await rig.placement(randomBytes(1024)); const url = new URL(placed.grant.transferEndpoint!.url);
  for (const request of ['BOGUS\r\n\r\n', 'PUT /v1/chunks/x HTTP/1.1\r\nHost: x\r\nContent-Length: 1\r\nContent-Length: 2\r\n\r\nx', 'PUT /v1/chunks/x HTTP/1.1\r\nHost: x\r\nContent-Length: 1\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n', `GET / HTTP/1.1\r\nHost: x\r\nX-Large: ${'A'.repeat(8192)}\r\n\r\n`]) {
    await new Promise<void>(resolve => { const socket = connect({ host: url.hostname, port: Number(url.port), ca: TEST_CERT, checkServerIdentity: () => undefined }, () => socket.write(request)); socket.on('data', () => {}); socket.on('error', () => resolve()); socket.on('close', resolve); socket.setTimeout(1500, () => socket.destroy()); });
  }
  await new Promise<void>(resolve => { const socket = tcpConnect({ host: url.hostname, port: Number(url.port) }, () => socket.write('GET / HTTP/1.1\r\nHost: x\r\n\r\n')); socket.on('error', () => resolve()); socket.on('close', resolve); socket.setTimeout(1500, () => socket.destroy()); });
  assert.equal(rig.coordinator.store.getTransfer(placed.grant.transferId)?.state, 'AUTHORIZED');
});

test('endpoint private-key proof prevents public certificate copying, node substitution and URL substitution; configuration precedence is explicit', () => {
  const nodeId = `node_${'ab'.repeat(32)}`; const endpoint = bindTransferEndpoint(transferEndpoint('https://127.0.0.1:4050', TEST_CERT), nodeId, TEST_KEY);
  assert.equal(validateTransferEndpoint(endpoint, Date.now(), nodeId).url, endpoint.url);
  for (const patch of [{ keyProof: undefined }, { url: 'https://127.0.0.1:4010' }, { certFingerprint: '00'.repeat(32) }]) assert.throws(() => validateTransferEndpoint({ ...endpoint, ...patch }, Date.now(), nodeId));
  assert.throws(() => validateTransferEndpoint(endpoint, Date.now(), `node_${'cd'.repeat(32)}`));
  const policy = ResourcePolicySchema.parse({ storage: { transfer: { enabled: false, port: 9999 } } });
  assert.equal(transferConfig(policy, { PRIVANODE_TRANSFER_PORT: '8888' }).port, 8888); assert.equal(transferConfig(policy).enabled, false);
  for (const env of [{ PRIVANODE_TRANSFER_BIND: 'example.com' }, { PRIVANODE_TRANSFER_ENABLED: 'yes' }, { PRIVANODE_TRANSFER_ENABLED: 'true', PRIVANODE_TRANSFER_ENDPOINT: 'http://127.0.0.1' }, { PRIVANODE_TRANSFER_PUTS: '8', PRIVANODE_TRANSFER_CONCURRENCY: '2' }]) assert.throws(() => transferConfig(policy, env));
  assert.throws(() => transferConfig(ResourcePolicySchema.parse({ storage: { transfer: { enabled: true, endpoint: 'https://user:secret@127.0.0.1', certificateFile: 'cert', keyFile: 'key' } } })));
  assert.throws(() => transferConfig(ResourcePolicySchema.parse({ storage: { transfer: { enabled: false, endpoint: 'https://user:secret@127.0.0.1' } } })));
  assert(ApiError); assert(generateHolderKey);
});

test('owner bandwidth/monthly caps and concurrent transfer limits apply to actual TLS bytes', { timeout: 15000 }, async t => {
  const rig = await directRig(t); rig.meter.setLimits({ ratePerSec: 4096, monthlyBytes: null });
  const before = Date.now(); await rig.client.store(randomBytes(16384), { timeoutMs: 10000 });
  assert(Date.now() - before >= 2600, 'streaming PUT respects one-second burst plus owner rate');
  rig.meter.setLimits({ ratePerSec: null, monthlyBytes: rig.meter.usage().usedBytes });
  await assert.rejects(rig.client.store(randomBytes(1024))); assert.equal(rig.storage.status.transfer?.completed, 1);
  rig.meter.setLimits({ ratePerSec: null, monthlyBytes: null });
  rig.world.policy.storage.transfer.maxConcurrent = 1; rig.world.policy.storage.transfer.maxConcurrentPuts = 1; await rig.storage.apply(rig.world.policy); await rig.node.tick();
  const placed = await rig.placement(randomBytes(4096)); const probe = await directRequest(placed.grant, { 'x-privanet-handshake': '1' }, AbortSignal.timeout(5000)); const challenge = JSON.parse(probe.bytes.toString()).challenge as string;
  const proof = signHolderProof(placed.holder.privateKey, { challenge, transferId: placed.grant.transferId, requestLine: `PUT /v1/chunks/${placed.chunkId}` });
  const req = request(placed.grant.transferEndpoint!.url, { method: 'PUT', path: `/v1/chunks/${placed.chunkId}`, agent: false, ca: TEST_CERT, checkServerIdentity: () => undefined,
    headers: { authorization: `Transfer ${placed.grant.ticket}`, 'content-length': '4096', 'content-type': 'application/octet-stream', 'x-privanet-challenge': challenge, 'x-privanet-proof': proof } });
  req.on('error', () => {}); req.write(Buffer.alloc(128));
  for (let n = 0; n < 100 && !rig.storage.status.transfer?.active.put; n++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(rig.storage.status.transfer?.active.put, 1);
  await assert.rejects(rig.client.store(randomBytes(1024)), (e: unknown) => e instanceof ApiError && e.code === 'TRANSFER_BUSY');
  rig.world.policy.storage.enabled = false; await rig.storage.apply(rig.world.policy); req.destroy();
  assert.equal(rig.storage.status.transfer?.active.put, 0); assert.equal(rig.storage.status.transfer?.listener, 'DISABLED');
});

test('a complete GET body without holder acknowledgement is not marked completed; a partial read cannot acknowledge', async t => {
  const rig = await directRig(t); const bytes = randomBytes(1024); const id = await rig.client.store(bytes);
  const holder = generateHolderKey(); const response = await rig.coordinator.apiFor(rig.app.token).ticket({ directTransfer: true, operation: 'get', chunkId: id, holderKey: holder.publicKey }); const grant = response.grant!;
  const first = await directRequest(grant, { 'x-privanet-handshake': '1' }, AbortSignal.timeout(5000)); const challenge = JSON.parse(first.bytes.toString()).challenge as string; const requestLine = `GET /v1/chunks/${id}`;
  const result = await directRequest(grant, { 'x-privanet-challenge': challenge, 'x-privanet-proof': signHolderProof(holder.privateKey, { challenge, transferId: grant.transferId, requestLine }) }, AbortSignal.timeout(5000));
  assert.deepEqual(result.bytes, bytes);
  await new Promise(resolve => setTimeout(resolve, 2200)); // receipt worker must not recover a live acknowledgement waiter as a crashed GET
  assert.equal(rig.coordinator.store.getTransfer(grant.transferId)?.state, 'IN_PROGRESS');
  const bad = await directRequest(grant, { 'x-privanet-ack': '1', 'x-privanet-challenge': result.challenge!, 'x-privanet-proof': signHolderProof(generateHolderKey().privateKey, { challenge: result.challenge!, transferId: grant.transferId, requestLine }) }, AbortSignal.timeout(5000));
  assert.equal(bad.status, 403); assert.equal(rig.coordinator.store.getTransfer(grant.transferId)?.state, 'IN_PROGRESS');
  await rig.storage.stop(); assert.equal(JSON.parse(await readFile(join(rig.dir, RECEIPT_FILE), 'utf8')).records.find((r: { receipt: { transferId: string } }) => r.receipt.transferId === grant.transferId).state, 'FAILED');
});


test('a verified in-progress GET may acknowledge after ticket expiry/key retirement, but a substituted ticket cannot', async t => {
  const rig = await directRig(t); const bytes = randomBytes(1024); const id = await rig.client.store(bytes); const holder = generateHolderKey();
  const grant = (await rig.coordinator.apiFor(rig.app.token).ticket({ directTransfer: true, operation: 'get', chunkId: id, holderKey: holder.publicKey })).grant!;
  const probe = await directRequest(grant, { 'x-privanet-handshake': '1' }, AbortSignal.timeout(5000)); const challenge = JSON.parse(probe.bytes.toString()).challenge as string; const requestLine = `GET /v1/chunks/${id}`;
  const result = await directRequest(grant, { 'x-privanet-challenge': challenge, 'x-privanet-proof': signHolderProof(holder.privateKey, { challenge, transferId: grant.transferId, requestLine }) }, AbortSignal.timeout(5000)); assert.deepEqual(result.bytes, bytes);
  Object.defineProperty(rig.node, 'transferKeys', { get: () => [] }); // key cache no longer contains the original verifier
  const headers = { 'x-privanet-ack': '1', 'x-privanet-challenge': result.challenge!, 'x-privanet-proof': signHolderProof(holder.privateKey, { challenge: result.challenge!, transferId: grant.transferId, requestLine }) };
  const altered = Buffer.from(grant.ticket, 'base64url'); altered[altered.length - 1] = altered[altered.length - 1]! ^ 1;
  assert.equal((await directRequest({ ...grant, ticket: altered.toString('base64url') }, headers, AbortSignal.timeout(5000))).status, 403);
  assert.equal((await directRequest(grant, headers, AbortSignal.timeout(5000))).status, 200); assert.equal(rig.coordinator.store.getTransfer(grant.transferId)?.state, 'COMPLETED');
  assert.equal((await directRequest(grant, headers, AbortSignal.timeout(5000))).status, 200);
});


test('missing, malformed, oversized and understated PUT lengths fail before begin', async t => {
  for (const length of [undefined, 'invalid', '99999999', '1023', '1025']) await t.test(String(length), async t => {
    const rig = await directRig(t); const placed = await rig.placement(randomBytes(1024));
    const first = await directRequest(placed.grant, { 'x-privanet-handshake': '1' }, AbortSignal.timeout(5000)); const challenge = JSON.parse(first.bytes.toString()).challenge as string;
    const proof = signHolderProof(placed.holder.privateKey, { challenge, transferId: placed.grant.transferId, requestLine: `PUT /v1/chunks/${placed.chunkId}` });
    const url = new URL(placed.grant.transferEndpoint!.url);
    const text = `PUT /v1/chunks/${placed.chunkId} HTTP/1.1\r\nHost: x\r\nAuthorization: Transfer ${placed.grant.ticket}\r\nContent-Type: application/octet-stream\r\nX-PrivaNet-Challenge: ${challenge}\r\nX-PrivaNet-Proof: ${proof}\r\n${length === undefined ? '' : `Content-Length: ${length}\r\n`}\r\n`;
    await new Promise<void>(resolve => { const socket = connect({ host: url.hostname, port: Number(url.port), ca: TEST_CERT, checkServerIdentity: () => undefined }, () => socket.write(text)); socket.on('data', () => {}); socket.on('error', () => resolve()); socket.on('close', resolve); socket.setTimeout(1500, () => socket.destroy()); });
    assert.equal(rig.coordinator.store.getTransfer(placed.grant.transferId)?.state, 'AUTHORIZED'); assert.equal((await rig.storage.chunkStore!.usage()).committedBytes, 0);
  });
});

test('a receiver disconnecting mid-GET never completes the transfer', async t => {
  const rig = await directRig(t); const id = await rig.client.store(randomBytes(1024 * 1024)); rig.meter.setLimits({ ratePerSec: 65536, monthlyBytes: null });
  const holder = generateHolderKey(); const grant = (await rig.coordinator.apiFor(rig.app.token).ticket({ directTransfer: true, operation: 'get', chunkId: id, holderKey: holder.publicKey })).grant!;
  const first = await directRequest(grant, { 'x-privanet-handshake': '1' }, AbortSignal.timeout(5000)); const challenge = JSON.parse(first.bytes.toString()).challenge as string;
  await new Promise<void>(resolve => {
    const req = request(grant.transferEndpoint!.url, { method: 'GET', path: `/v1/chunks/${id}`, agent: false, ca: TEST_CERT, checkServerIdentity: () => undefined,
      headers: { authorization: `Transfer ${grant.ticket}`, 'content-length': '0', 'x-privanet-challenge': challenge, 'x-privanet-proof': signHolderProof(holder.privateKey, { challenge, transferId: grant.transferId, requestLine: `GET /v1/chunks/${id}` }) } }, res => { res.once('data', () => { res.destroy(); resolve(); }); });
    req.on('error', () => resolve()); req.setTimeout(1500, () => { req.destroy(); resolve(); }); req.end();
  });
  await new Promise(resolve => setTimeout(resolve, 200)); await rig.storage.stop();
  const record = JSON.parse(await readFile(join(rig.dir, RECEIPT_FILE), 'utf8')).records.find((r: { receipt: { transferId: string } }) => r.receipt.transferId === grant.transferId);
  assert.notEqual(record?.state, 'COMPLETED'); assert.notEqual(rig.coordinator.store.getTransfer(grant.transferId)?.state, 'COMPLETED');
});

test('endpoint status requires a recent accepted heartbeat for this exact certificate and URL', async t => {
  const rig = await directRig(t); assert.equal(rig.storage.status.transfer?.advertised, true);
  const endpoint = rig.storage.advertisement()!.transferEndpoint!;
  assert.equal(rig.node.transferEndpointRegistered({ ...endpoint, certFingerprint: '00'.repeat(32) }), false);
  rig.world.blockers = ['PAUSED_BY_OWNER']; await rig.node.tick(); assert.equal(rig.storage.status.transfer?.advertised, false);
});


test('receipt persistence failure during shutdown still closes the listener and store', async t => {
  const rig = await directRig(t); const bytes = randomBytes(1024); const id = await rig.client.store(bytes); const holder = generateHolderKey();
  const grant = (await rig.coordinator.apiFor(rig.app.token).ticket({ directTransfer: true, operation: 'get', chunkId: id, holderKey: holder.publicKey })).grant!;
  const first = await directRequest(grant, { 'x-privanet-handshake': '1' }, AbortSignal.timeout(5000)); const challenge = JSON.parse(first.bytes.toString()).challenge as string;
  await directRequest(grant, { 'x-privanet-challenge': challenge, 'x-privanet-proof': signHolderProof(holder.privateKey, { challenge, transferId: grant.transferId, requestLine: `GET /v1/chunks/${id}` }) }, AbortSignal.timeout(5000));
  const path = join(rig.dir, RECEIPT_FILE); await rm(path); await mkdir(path, { mode: 0o700 });
  await rig.storage.stop(); assert.equal(rig.storage.status.transfer?.listener, 'STOPPED'); assert.equal(rig.storage.chunkStore, undefined);
  assert.notEqual(rig.coordinator.store.getTransfer(grant.transferId)?.state, 'COMPLETED');
});
