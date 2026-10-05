import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { generateHolderKey } from '@privanet/shared';
import { startAdminUi } from '@privanet/coordinator/admin-ui';
import { chunkIdOf } from './storage-rig.js';
import { httpRig, listen } from './storage-http.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const ADMIN = `${root}scripts/admin.mjs`;
function admin(rig: { url: string; adminSecret: string }, args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number; out: string; err: string }> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [ADMIN, ...args], { cwd: root, env: { PATH: process.env.PATH ?? '', PRIVANET_COORDINATOR_URL: rig.url, PRIVANET_ADMIN_SECRET: rig.adminSecret, PRIVANODE_ALLOW_INSECURE_LOOPBACK: 'true', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = ''; child.stdout.on('data', (c: Buffer) => { out += c.toString(); }); child.stderr.on('data', (c: Buffer) => { err += c.toString(); }); child.on('close', code => resolve({ code: code ?? -1, out, err }));
  });
}

test('privanet-admin application: no storage by default; --services grants exactly what is named; unknown services and job ids are refused before anything is sent', async t => {
  const rig = await httpRig(t);
  const plain = await admin(rig, ['application', 'plain']); assert.equal(plain.code, 0); const plainCredential = JSON.parse(plain.out) as { applicationId: string; token: string };
  assert.equal(rig.store.getApplication(plainCredential.applicationId)?.allowedServices, undefined);
  const withStorage = await admin(rig, ['application', 'drive', '--services', 'storage.chunk.v1']); assert.equal(withStorage.code, 0); const credential = JSON.parse(withStorage.out) as { applicationId: string; token: string };
  assert.deepEqual(rig.store.getApplication(credential.applicationId)?.allowedServices, ['storage.chunk.v1']); assert.deepEqual(rig.store.getApplication(credential.applicationId)?.allowedJobTypes, ['system.echo.v1']); // job permission is separate and unchanged
  for (const bad of ['storage.chunk.v2', 'system.echo.v1', '*', 'storage.chunk.v1,storage.chunk.v1', '']) { const result = await admin(rig, ['application', 'x', '--services', bad]); assert.equal(result.code, 1, bad); assert.equal(result.out, ''); }
  assert.equal(JSON.stringify([plain.out, withStorage.out]).includes(rig.adminSecret), false);
});
test('privanet-admin sends allowedServices only when asked, so an older Coordinator\'s strict schema is never given a field it would refuse', async t => {
  let received: unknown; const server = createServer((req, res) => { const chunks: Buffer[] = []; req.on('data', (c: Buffer) => chunks.push(c)); req.on('end', () => { received = JSON.parse(Buffer.concat(chunks).toString()); res.writeHead(201, { 'content-type': 'application/json', 'x-privanet-protocol': '1' }); res.end(JSON.stringify({ applicationId: randomUUID(), token: 'a'.repeat(64) })); }); });
  const url = await listen(server); t.after(async () => { await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); });
  const stub = { url, adminSecret: 'b'.repeat(64) };
  assert.equal((await admin(stub, ['application', 'old'])).code, 0); assert.equal('allowedServices' in (received as object), false);
  assert.equal((await admin(stub, ['application', 'new', '--services', 'storage.chunk.v1'])).code, 0); assert.deepEqual((received as { allowedServices?: string[] }).allowedServices, ['storage.chunk.v1']);
});
test('privanet-admin storage status: aggregates only, in text and JSON, with no id, ticket, key or application name', async t => {
  const rig = await httpRig(t); const empty = await admin(rig, ['storage', 'status']); assert.equal(empty.code, 0, empty.err); assert.match(empty.out, /No node is offering storage/); assert.match(empty.out, /Signing key:\s+[a-f0-9]{16}/);
  const privaNode = await rig.node(); const app = await rig.admin.app({ name: 'secret-app-name', allowedJobTypes: [], allowedServices: ['storage.chunk.v1'] }); const chunk = chunkIdOf('payload'); const holder = generateHolderKey();
  const placed = await rig.apiFor(app.token).place({ chunkId: chunk, size: 7, holderKey: holder.publicKey }); assert(placed.grant);
  const text = await admin(rig, ['storage', 'status']); assert.equal(text.code, 0, text.err); assert.match(text.out, /1 pending/); assert.match(text.out, /1 open/); assert.match(text.out, new RegExp(privaNode.status.nodeId?.slice(0, 13) ?? 'x'));
  const json = JSON.parse((await admin(rig, ['storage', 'status', '--json'])).out) as { chunks: { pending: number }; nodes: unknown[] }; assert.equal(json.chunks.pending, 1); assert.equal(json.nodes.length, 1);
  for (const forbidden of [placed.grant.ticket, chunk, holder.publicKey, 'secret-app-name', app.token, app.applicationId, rig.adminSecret, 'privateKey']) assert.equal(text.out.includes(forbidden) || JSON.stringify(json).includes(forbidden), false, forbidden);
});
test('privanet-admin storage rotate-key rotates, says when the old key stops verifying, and refuses a wrong credential', async t => {
  const rig = await httpRig(t); const result = await admin(rig, ['storage', 'rotate-key']); assert.equal(result.code, 0); assert.match(result.out, /New signing key [a-f0-9]{16}/); assert.match(result.out, /keeps verifying until/);
  assert.equal(rig.core.storage.summary().keyring.keys, 2); const json = JSON.parse((await admin(rig, ['storage', 'rotate-key', '--json'])).out) as { currentKid: string; previousKid: string }; assert.notEqual(json.currentKid, json.previousKid);
  const refused = await admin({ url: rig.url, adminSecret: 'c'.repeat(64) }, ['storage', 'status']); assert.equal(refused.code, 1); assert.match(refused.err, /Admin operation failed/); assert.equal(refused.out, '');
  assert.equal((await admin(rig, ['storage', 'mark-chunk-stored'])).code, 1); // there is no command that bypasses the state machine
  assert.equal((await admin(rig, ['storage'])).code, 1);
});
test('the operator dashboard shows a compact storage summary and nothing identifying: counts, sizes and a key id', async t => {
  const rig = await httpRig(t); await rig.node(); const app = await rig.admin.app({ name: 'drive', allowedJobTypes: [], allowedServices: ['storage.chunk.v1'] }); const chunk = chunkIdOf('dash');
  const placed = await rig.apiFor(app.token).place({ chunkId: chunk, size: 4, holderKey: generateHolderKey().publicKey }); assert(placed.grant);
  const ui = await startAdminUi({ coordinatorUrl: rig.url, adminSecret: rig.adminSecret, allowInsecureLoopback: true, port: 0 }); t.after(() => ui.close());
  const send = (method: string, path: string, headers: Record<string, string> = {}, body?: string) => new Promise<{ status: number; text: string; cookie?: string }>((resolve, reject) => { const req = request({ host: '127.0.0.1', port: ui.port, method, path, headers: { host: `127.0.0.1:${ui.port}`, ...headers } }, res => { let text = ''; res.on('data', (c: Buffer) => { text += c.toString(); }); res.on('end', () => resolve({ status: res.statusCode ?? 0, text, cookie: String(res.headers['set-cookie'] ?? '').split(';')[0] ?? '' })); }); req.on('error', reject); req.end(body); });
  const login = await send('POST', '/api/login', { origin: `http://127.0.0.1:${ui.port}`, 'content-type': 'application/json' }, JSON.stringify({ token: ui.token })); assert.equal(login.status, 200);
  const overview = await send('GET', '/api/overview', { cookie: login.cookie ?? '' }); assert.equal(overview.status, 200); const body = JSON.parse(overview.text) as { storage: { chunks: { pending: number }; transfers: { open: number }; nodes: unknown[] } | null };
  assert(body.storage); assert.equal(body.storage.chunks.pending, 1); assert.equal(body.storage.transfers.open, 1); assert.equal(body.storage.nodes.length, 1);
  for (const forbidden of [placed.grant.ticket, chunk, app.token, rig.adminSecret, 'privateKey']) assert.equal(overview.text.includes(forbidden), false, forbidden);
});


test('alpha.4 admin falls back to the strict alpha.3 storage summary when detail negotiation is unsupported', async t => {
  const rig = await httpRig(t); let refusedDetails = 0;
  const server = createServer((req, res) => {
    if (req.url === '/v1/admin/storage?details=1') { refusedDetails++; res.writeHead(404, { 'content-type': 'application/json', 'x-privanet-protocol': '1' }); res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'route not found' } })); return; }
    assert.equal(req.url, '/v1/admin/storage'); res.writeHead(200, { 'content-type': 'application/json', 'x-privanet-protocol': '1' }); res.end(JSON.stringify(rig.core.storage.summary()));
  }); const url = await listen(server); t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const result = await admin({ url, adminSecret: rig.adminSecret }, ['storage', 'status', '--json']); assert.equal(result.code, 0, result.err); assert.equal(JSON.parse(result.out).pool, undefined); assert.equal(refusedDetails, 1);
});
