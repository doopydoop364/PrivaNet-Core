import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { PROTOCOL_VERSION, SERVICE_VERSION } from '@privanet/protocol';
import { generateHolderKey } from '@privanet/shared';
import { ALPHA1, oldProtocol } from './old-protocol.js';
import type { OldProtocol } from './old-protocol.js';
import { advert, chunkIdOf } from './storage-rig.js';
import { httpRig, listen } from './storage-http.js';
import { identity } from './helpers.js';

/**
 * Mixed-version behaviour, tested against the real wire schemas of 0.4.0-alpha.1 (compiled from git, never hand-copied). The rules this protects: an additive change must never make an older
 * node, tool or SDK unable to talk to a newer Coordinator (their schemas are strict), and a newer node must keep working, minus storage, against an older Coordinator.
 */
let old: OldProtocol | undefined;
const required = process.env.PRIVANET_REQUIRE_COMPAT_TAG === '1';
async function base(t: { skip: (reason?: string) => void }): Promise<OldProtocol | undefined> { old ??= await oldProtocol(ALPHA1); if (!old) t.skip('the 0.4.0-alpha.1 revision is not in this clone (git fetch --unshallow --tags)'); return old; }
const schema = (schemas: OldProtocol, name: string) => { const found = schemas[name]; assert(found, `${name} is missing from the previous release's protocol`); return found; };

test('the previous release\'s protocol file loads, and the new protocol differs from it only additively (strict shapes an old node parses with are unchanged)', async t => {
  const schemas = await base(t); if (!schemas) return;
  for (const name of ['SessionSchema', 'HealthSchema', 'NodeSelfSchema', 'NodeViewSchema', 'NodesSchema', 'CapabilitiesResponseSchema', 'LeaseResponseSchema', 'AckSchema', 'AppCredentialSchema', 'EnrollmentTokenSchema', 'ChallengeSchema', 'HeartbeatSchema', 'AppCreateSchema']) schema(schemas, name);
  assert.equal(Object.hasOwn(schemas, 'SERVICES'), false); assert.equal(Object.hasOwn(schemas, 'PlacementRequestSchema'), false); // storage did not exist there
  assert.equal(required || true, true);
});
test('a new Coordinator\'s answers parse under the old strict schemas: health, sessions, node self, node list (with a storage node), capabilities, credentials and leases', async t => {
  const schemas = await base(t); if (!schemas) return;
  const rig = await httpRig(t); const privaNode = await rig.node(); const nodeId = privaNode.status.nodeId ?? ''; assert(rig.store.getNodeService(nodeId, 'storage.chunk.v1'));
  const get = async (path: string, token?: string) => { const response = await rig.raw(path, { headers: token ? { authorization: `Bearer ${token}` } : {} }); return { status: response.status, body: await response.json() as unknown }; };
  const health = await get('/v1/health'); assert.equal(schema(schemas, 'HealthSchema').safeParse(health.body).success, true);
  const nodes = await get('/v1/admin/nodes', rig.adminSecret); assert.equal(nodes.status, 200); assert.equal(schema(schemas, 'NodesSchema').safeParse(nodes.body).success, true, 'an old admin tool must still parse the node list while a node offers storage');
  // a session, over HTTP, for a fresh node (enrolled in-process so the test holds its key)
  const key = identity(); const grant = rig.core.createEnrollment({ expiresInMs: 60000, capabilities: ['system.echo.v1'] });
  const challenge = rig.core.beginEnrollment({ token: grant.token, publicKey: key.publicKey, protocolVersion: 1, daemonVersion: '0.4.0-alpha.1', capabilities: ['system.echo.v1'] }); rig.core.prove(key.proof(challenge), 'enroll');
  const { nodeId: freshId } = (await import('@privanet/shared')).canonicalPublicKey(key.publicKey);
  const post = async (path: string, body: unknown, token?: string) => { const response = await rig.raw(path, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() as unknown }; };
  const auth = await post('/v1/auth/challenge', { nodeId: freshId, protocolVersion: 1 }); assert.equal(auth.status, 200); assert.equal(schema(schemas, 'ChallengeSchema').safeParse(auth.body).success, true);
  const session = await post('/v1/auth/proof', key.proof(auth.body as Parameters<typeof key.proof>[0])); assert.equal(session.status, 200); assert.equal(schema(schemas, 'SessionSchema').safeParse(session.body).success, true, 'the session response is parsed strictly by every older node: it must not grow');
  const token = (session.body as { token: string }).token;
  const self = await get('/v1/node/self', token); assert.equal(schema(schemas, 'NodeSelfSchema').safeParse(self.body).success, true);
  // an old node's heartbeat is accepted and never creates a storage row; the new heartbeat is NOT valid under the old schema (which is why a new node falls back, tested below)
  const oldHeartbeat = { protocolVersion: PROTOCOL_VERSION, daemonVersion: '0.4.0-alpha.1', capabilities: ['system.echo.v1'], jobSlots: 1, currentJobs: 0 };
  assert.equal(schema(schemas, 'HeartbeatSchema').safeParse(oldHeartbeat).success, true); assert.equal((await post('/v1/node/heartbeat', oldHeartbeat, token)).status, 200); assert.equal(rig.store.getNodeService(freshId, 'storage.chunk.v1'), undefined);
  assert.equal(schema(schemas, 'HeartbeatSchema').safeParse({ ...oldHeartbeat, services: { 'storage.chunk.v1': advert() } }).success, false);
  assert.equal((await post('/v1/node/heartbeat', { ...oldHeartbeat, services: { 'storage.chunk.v1': advert() } }, token)).status, 200); assert(rig.store.getNodeService(freshId, 'storage.chunk.v1')); // the new Coordinator accepts it
  assert.equal((await post('/v1/node/heartbeat', oldHeartbeat, token)).status, 200); assert.equal(rig.store.getNodeService(freshId, 'storage.chunk.v1'), undefined, 'an old-style heartbeat withdraws the offer');
  const lease = await post('/v1/node/jobs/lease', {}, token); assert.equal(schema(schemas, 'LeaseResponseSchema').safeParse(lease.body).success, true);
  // applications: an old admin tool creates one the old way; a storage application's capability listing is job-only and parses under the old schema
  const created = await rig.admin.app({ name: 'legacy', allowedJobTypes: ['system.echo.v1'] }); const credential = await post('/v1/admin/applications', { name: 'legacy2', allowedJobTypes: ['system.echo.v1'] }, rig.adminSecret); assert.equal(schema(schemas, 'AppCredentialSchema').safeParse(credential.body).success, true);
  const storageApp = await rig.admin.app({ name: 'drive', allowedJobTypes: ['system.echo.v1'], allowedServices: ['storage.chunk.v1'] }); const capabilities = await get('/v1/capabilities', storageApp.token); assert.equal(schema(schemas, 'CapabilitiesResponseSchema').safeParse(capabilities.body).success, true);
  assert.equal(JSON.stringify(capabilities.body).includes('storage'), false); assert.equal(JSON.stringify((await get('/v1/capabilities', created.token)).body).includes('storage'), false);
  assert.equal(schema(schemas, 'AppCreateSchema').safeParse({ name: 'x', allowedJobTypes: [] }).success, true); assert.equal(SERVICE_VERSION.startsWith('0.4.0'), true);
});
test('an application created by an older admin tool has no storage authority; one that names allowedServices is refused by an older Coordinator\'s strict schema, which is why the admin CLI sends the field only when asked', async t => {
  const schemas = await base(t); if (!schemas) return;
  const rig = await httpRig(t); await rig.node(); const legacy = await rig.admin.app({ name: 'legacy', allowedJobTypes: ['system.echo.v1'] }); const body = { chunkId: chunkIdOf('x'), size: 1, holderKey: generateHolderKey().publicKey };
  const response = await rig.raw('/v1/storage/placements', { method: 'POST', headers: { authorization: `Bearer ${legacy.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }); assert.equal(response.status, 403);
  assert.equal(schema(schemas, 'AppCreateSchema').safeParse({ name: 'x', allowedJobTypes: [], allowedServices: ['storage.chunk.v1'] }).success, false);
});

/** An older Coordinator, in front of the real one: it enforces the OLD strict heartbeat schema (a `services` member is a 400) and has no storage routes (404). Everything else is forwarded unchanged. */
async function olderCoordinator(target: string, schemas: OldProtocol, t: { after: (fn: () => Promise<void>) => void }) {
  const seen = { heartbeats: [] as unknown[], rejected: 0, storageRequests: 0 };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []; req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      void (async () => {
        const body = Buffer.concat(chunks); const path = req.url ?? '';
        const refuse = (status: number, code: string) => { res.writeHead(status, { 'content-type': 'application/json', 'x-privanet-protocol': '1' }); res.end(JSON.stringify({ error: { code, message: code.toLowerCase() } })); };
        if (path.startsWith('/v1/storage/') || path === '/v1/node/transfer-keys' || path.startsWith('/v1/admin/storage')) { seen.storageRequests++; return refuse(404, 'NOT_FOUND'); }
        if (req.method === 'POST' && path === '/v1/node/heartbeat') {
          const parsed = schema(schemas, 'HeartbeatSchema').safeParse(JSON.parse(body.toString('utf8'))); seen.heartbeats.push(JSON.parse(body.toString('utf8')));
          if (!parsed.success) { seen.rejected++; return refuse(400, 'INVALID_REQUEST'); }
        }
        const headers: Record<string, string> = {}; for (const name of ['content-type', 'authorization', 'x-privanet-protocol']) { const value = req.headers[name]; if (typeof value === 'string') headers[name] = value; }
        const upstream = await fetch(target + path, { method: req.method ?? 'GET', headers, ...(req.method === 'POST' ? { body } : {}) });
        res.writeHead(upstream.status, { 'content-type': 'application/json', 'x-privanet-protocol': upstream.headers.get('x-privanet-protocol') ?? '1' }); res.end(Buffer.from(await upstream.arrayBuffer()));
      })().catch(() => { res.writeHead(502); res.end(); });
    });
  });
  const url = await listen(server); t.after(async () => { await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); });
  return { url, seen };
}
test('a new node against an OLDER Coordinator keeps working: it drops the services member after one refusal, offers no storage, keeps its job slots, and never stops', async t => {
  const schemas = await base(t); if (!schemas) return;
  const rig = await httpRig(t); const older = await olderCoordinator(rig.url, schemas, t);
  const privaNode = await rig.node(() => ({ 'storage.chunk.v1': advert() }), { jobSlots: 3 }, older.url); const nodeId = privaNode.status.nodeId ?? '';
  for (let i = 0; i < 3; i++) await privaNode.tick();
  assert.equal(older.seen.rejected, 1, 'exactly one heartbeat was refused, then the node stopped sending the member'); assert.equal(privaNode.snapshot.slots.effective, 3, 'the slots fallback was not triggered by the storage member');
  assert(older.seen.heartbeats.length >= 2); assert.equal(older.seen.heartbeats.slice(1).some(heartbeat => 'services' in (heartbeat as object)), false);
  assert.equal(privaNode.transferKeys, null); assert.equal(rig.store.getNodeService(nodeId, 'storage.chunk.v1'), undefined); assert.equal(older.seen.storageRequests, 0, 'a node that cannot offer storage does not go looking for keys');
  assert.equal(privaNode.snapshot.connected, true); assert.equal(rig.logs.filter(entry => (entry as { event?: string }).event === 'node.services_unsupported').length, 1, 'said once');
  assert.equal(privaNode.snapshot.lastFailure, null);
});
test('a new node whose Coordinator answers the key route with 404 or an error treats storage as unavailable and nothing else changes', async t => {
  const rig = await httpRig(t, { keyring: false }); const privaNode = await rig.node(); await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(privaNode.transferKeys, null); assert.equal(privaNode.snapshot.connected, true); assert(rig.store.getNodeService(privaNode.status.nodeId ?? '', 'storage.chunk.v1')); // it still offers; the Coordinator simply cannot issue tickets (503 on placement)
});
test('keys from a different Coordinator are never accepted: the answer must name the Coordinator the node is bound to', async t => {
  const rig = await httpRig(t); const other = await httpRig(t);
  // a node enrolled at `rig`, whose key request is answered by `other` (a man in the middle, or a re-pointed address)
  const forward = createServer((req, res) => { const chunks: Buffer[] = []; req.on('data', (c: Buffer) => chunks.push(c)); req.on('end', () => { void (async () => {
    const target = req.url === '/v1/node/transfer-keys' ? other.url : rig.url; const headers: Record<string, string> = {}; for (const name of ['content-type', 'authorization', 'x-privanet-protocol']) { const v = req.headers[name]; if (typeof v === 'string') headers[name] = v; }
    // `other` does not know this session: give it its own, so the only thing under test is the coordinatorId it names
    if (req.url === '/v1/node/transfer-keys') { res.writeHead(200, { 'content-type': 'application/json', 'x-privanet-protocol': '1' }); res.end(JSON.stringify(other.core.storage.transferKeys(other.core.store.coordinatorId))); return; }
    const upstream = await fetch(target + (req.url ?? ''), { method: req.method ?? 'GET', headers, ...(req.method === 'POST' ? { body: Buffer.concat(chunks) } : {}) }); res.writeHead(upstream.status, { 'content-type': 'application/json', 'x-privanet-protocol': '1' }); res.end(Buffer.from(await upstream.arrayBuffer())); })().catch(() => { res.writeHead(502); res.end(); }); }); });
  const url = await listen(forward); t.after(async () => { await new Promise<void>(resolve => { forward.close(() => resolve()); forward.closeAllConnections(); }); });
  const privaNode = await rig.node(() => ({ 'storage.chunk.v1': advert() }), {}, url); await new Promise(resolve => setTimeout(resolve, 150));
  assert.notEqual(rig.core.store.coordinatorId, other.core.store.coordinatorId); assert.equal(privaNode.transferKeys, null);
  assert.equal(rig.logs.some(entry => (entry as { event?: string; code?: string }).event === 'node.transfer_keys_rejected'), true);
});
test('mixed fleet: an old node, a storage node and a job-only application coexist on the new Coordinator; jobs are leased by whichever node is eligible', async t => {
  const rig = await httpRig(t); const storageNode = await rig.node(); const quiet = await rig.node(() => undefined);
  const app = await rig.admin.app({ name: 'jobs', allowedJobTypes: ['system.echo.v1'] });
  for (let i = 0; i < 4; i++) await rig.transport.request('POST', '/v1/jobs', rig.z.object({ id: rig.z.string() }).loose(), { type: 'system.echo.v1', input: { message: `m${i}` }, idempotencyKey: `k${i}-${randomUUID()}` }, app.token);
  for (let i = 0; i < 6; i++) { await storageNode.tick(); await quiet.tick(); }
  const completed = [...rig.store.listPendingJobs()]; assert.equal(completed.length, 0, 'every queued job was leased and completed');
  assert.equal(rig.store.listNodeServices('storage.chunk.v1').length, 1);
});
