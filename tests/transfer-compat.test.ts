import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { generateHolderKey, bindTransferEndpoint, transferEndpoint } from '@privanet/shared';
import { PrivaNetClient } from '@privanet/sdk';
import { oldProtocol } from './old-protocol.js';
import { httpRig, listen } from './storage-http.js';
import { directRig } from './direct-transfer-rig.js';
import { TEST_CERT, TEST_KEY } from './tls-fixture.js';
const ALPHA2 = '1d10348e172018917ef31d2c663c975a8468d6f6';

test('alpha.2 strict consumers retain legacy grant/key/session shapes; endpoints require explicit direct-transfer negotiation', async t => {
  const old = await oldProtocol(ALPHA2); if (!old) { t.skip('alpha.2 base history unavailable'); return; }
  const rig = await directRig(t); const holder = generateHolderKey();
  const request = { chunkId: `chk_${'11'.repeat(32)}`, size: 1024, holderKey: holder.publicKey };
  const legacy = await rig.coordinator.apiFor(rig.app.token).place(request);
  assert(old.PlacementResponseSchema!.safeParse(legacy).success); assert.equal(legacy.grant?.transferEndpoint, undefined);
  const direct = await rig.coordinator.apiFor(rig.app.token).place({ ...request, directTransfer: true }); assert(direct.grant?.transferEndpoint);
  assert.equal(old.PlacementResponseSchema!.safeParse(direct).success, false, 'strict old grants must never receive the opt-in extension');
  assert(old.TransferKeysSchema!.safeParse(rig.coordinator.core.storage.transferKeys(rig.coordinator.store.coordinatorId)).success);
});

test('alpha.3 node against alpha.2 strict heartbeat and absent transfer controls falls back safely and still executes compute jobs', async t => {
  const old = await oldProtocol(ALPHA2); if (!old) { t.skip('alpha.2 base history unavailable'); return; }
  const rig = await httpRig(t); let rejected = 0;
  const proxy = createServer((req, res) => {
    const parts: Buffer[] = []; req.on('data', (part: Buffer) => parts.push(part)); req.on('end', () => {
      void (async () => {
        const bytes = Buffer.concat(parts); const path = req.url ?? '';
        if (path.startsWith('/v1/node/storage/') || path === '/v1/node/transfer-clock') { res.writeHead(404); res.end(); return; }
        if (path === '/v1/node/heartbeat' && !old.HeartbeatSchema!.safeParse(JSON.parse(bytes.toString())).success) {
          rejected++; res.writeHead(400, { 'content-type': 'application/json', 'x-privanet-protocol': '1' }); res.end(JSON.stringify({ error: { code: 'INVALID_REQUEST', message: 'invalid request' } })); return;
        }
        const response = await fetch(rig.url + path, { method: req.method ?? 'GET', headers: { 'x-privanet-protocol': '1', ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}), ...(bytes.length ? { 'content-type': 'application/json' } : {}) }, ...(bytes.length ? { body: bytes } : {}) });
        res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()));
      })().catch(() => { res.writeHead(503); res.end(); });
    });
  });
  const url = await listen(proxy); t.after(async () => { proxy.closeAllConnections(); await new Promise<void>(resolve => proxy.close(() => resolve())); });
  const endpoint = bindTransferEndpoint(transferEndpoint('https://127.0.0.1:4050', TEST_CERT), `node_${'ab'.repeat(32)}`, TEST_KEY);
  const node = await rig.node(() => ({ 'storage.chunk.v1': { capacityBytes: 1024 ** 3, freeBytes: 1024 ** 3, maxChunkBytes: 8388608, transferEndpoint: endpoint } }), {}, url);
  assert.equal(rejected, 1); assert.equal(rig.store.getNodeService(node.status.nodeId!, 'storage.chunk.v1'), undefined);
  const app = await rig.admin.app({ name: 'old-compute', allowedJobTypes: ['system.echo.v1'] }); const client = new PrivaNetClient({ url, token: app.token, allowInsecureLoopback: true });
  const job = await client.submit('system.echo.v1', { message: 'still computes' }, 'alpha3-compat'); await node.tick();
  assert.equal((await client.getJob(job.id)).status, 'COMPLETED');
  await assert.rejects(client.store(Buffer.from('no implicit storage')));
});
