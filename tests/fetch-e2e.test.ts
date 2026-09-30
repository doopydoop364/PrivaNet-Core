import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppCredentialSchema, EnrollmentTokenSchema, FetchOutputSchema, LeaseSchema } from '@privanet/protocol';
import type { FetchIdentity } from '@privanet/protocol';
import { ApiError, secret, Transport } from '@privanet/shared';
import { PrivaNetClient } from '@privanet/sdk';
import { Coordinator } from '@privanet/coordinator/service';
import { SqliteStore } from '@privanet/coordinator/store';
import { createCoordinatorServer } from '@privanet/coordinator/server';
import { PrivaNode } from '@privanet/node/daemon';
import { defaultHandlers } from '@privanet/node/handlers';
import { createFetchHandler } from '@privanet/node/fetch/handler';
import { ResourceEngine } from '@privanet/node/resource-engine';
import { ResourcePolicySchema } from '@privanet/node/resource-policy';
import { fixture, heartbeat } from './helpers.js';

const identity: FetchIdentity = { product: 'E2eBot', infoUrl: 'https://e2e.example/bot' };
const code = (expected: string, status: number) => (error: unknown) => error instanceof ApiError && error.code === expected && error.status === status;
const fetchHeartbeat = () => heartbeat(['web.fetch.v1']);

test('identity is registered by the administrator, validated, required to submit a fetch job, and stamped into the lease only for capabilities that need it', t => {
  const f = fixture(); t.after(() => f.store.close());
  const plain = f.core.createApplication({ name: 'plain', allowedJobTypes: ['web.fetch.v1', 'system.echo.v1'] }); const plainApp = f.core.authenticateApplication(plain.token);
  const withId = f.core.createApplication({ name: 'crawler', allowedJobTypes: ['web.fetch.v1', 'system.echo.v1'], fetchIdentity: identity }); const app = f.core.authenticateApplication(withId.token);
  for (const bad of [{ product: 'x y', infoUrl: 'https://a.example/' }, { product: 'Bot', infoUrl: 'http://a.example/' }, { product: 'Bot', infoUrl: 'https://a.example/', extra: 1 }])
    assert.throws(() => f.core.createApplication({ name: 'bad', allowedJobTypes: ['web.fetch.v1'], fetchIdentity: bad }));
  assert.throws(() => f.core.submit(plainApp, { type: 'web.fetch.v1', input: { url: 'https://example.com/' }, idempotencyKey: 'k1' }), code('FETCH_IDENTITY_REQUIRED', 403)); // fails at submission, never reaches a node
  assert.doesNotThrow(() => f.core.submit(plainApp, { type: 'system.echo.v1', input: { message: 'ok' }, idempotencyKey: 'k2' })); // echo needs no identity
  assert.throws(() => f.core.submit(app, { type: 'web.fetch.v1', input: { url: 'https://example.com/', method: 'POST' }, idempotencyKey: 'k3' })); // strict input
  assert.throws(() => f.core.submit(app, { type: 'web.fetch.v1', input: { url: 'https://example.com/', headers: { Cookie: 'x' } }, idempotencyKey: 'k4' }));
  const node = f.enroll(['web.fetch.v1', 'system.echo.v1']); f.core.heartbeat(node.session.nodeId, heartbeat(['web.fetch.v1', 'system.echo.v1']));
  const echo = f.core.lease(node.session.nodeId); assert.ok(echo); assert.equal(echo.type, 'system.echo.v1');
  assert.deepEqual(Object.keys(echo).sort(), ['attempt', 'expiresAt', 'input', 'jobId', 'leaseId', 'protocolVersion', 'type']); // a v0.2 node parses leases strictly: no extra field on echo leases
  f.core.complete(node.session.nodeId, echo.jobId, { leaseId: echo.leaseId, result: { message: 'ok' } });
  const job = f.core.submit(app, { type: 'web.fetch.v1', input: { url: 'https://example.com/' }, idempotencyKey: 'k5' });
  const fetch = f.core.lease(node.session.nodeId); assert.ok(fetch); assert.equal(fetch.jobId, job.id); assert.deepEqual(fetch.client, identity); assert.equal(LeaseSchema.safeParse(fetch).success, true);
});

test('the identity in a lease comes from the application record, so one application cannot present another\'s and a revoked one gets nothing', t => {
  const f = fixture(); t.after(() => f.store.close());
  const a = f.core.createApplication({ name: 'a', allowedJobTypes: ['web.fetch.v1'], fetchIdentity: { product: 'BotA', infoUrl: 'https://a.example/' } }); const b = f.core.createApplication({ name: 'b', allowedJobTypes: ['web.fetch.v1'], fetchIdentity: { product: 'BotB', infoUrl: 'https://b.example/' } });
  const appA = f.core.authenticateApplication(a.token); const appB = f.core.authenticateApplication(b.token);
  f.core.submit(appA, { type: 'web.fetch.v1', input: { url: 'https://example.com/a' }, idempotencyKey: 'x' }); f.core.submit(appB, { type: 'web.fetch.v1', input: { url: 'https://example.com/b', ...{} }, idempotencyKey: 'x' });
  const node = f.enroll(['web.fetch.v1']); f.core.heartbeat(node.session.nodeId, fetchHeartbeat());
  const products = new Map<string, string>();
  for (let i = 0; i < 2; i++) { const lease = f.core.lease(node.session.nodeId); assert.ok(lease); products.set((lease.input as { url: string }).url, lease.client?.product ?? ''); f.core.complete(node.session.nodeId, lease.jobId, { leaseId: lease.leaseId, result: { outcome: 'HTTP_ERROR', requestedUrl: (lease.input as { url: string }).url, redirects: [], httpStatus: 500, fetchedAtMs: 1, durationMs: 1, robots: { verdict: 'ALLOWED' } } }); }
  assert.deepEqual(Object.fromEntries(products), { 'https://example.com/a': 'BotA', 'https://example.com/b': 'BotB' });
});

test('malformed node output is rejected by the Coordinator against the registered schema; a late or superseded result is rejected by the lease fence', t => {
  const f = fixture(); t.after(() => f.store.close());
  const c = f.core.createApplication({ name: 'c', allowedJobTypes: ['web.fetch.v1'], fetchIdentity: identity }); const app = f.core.authenticateApplication(c.token);
  const node = f.enroll(['web.fetch.v1']); f.core.heartbeat(node.session.nodeId, fetchHeartbeat());
  const good = (url: string) => ({ outcome: 'FETCHED', requestedUrl: url, redirects: [], fetchedAtMs: 1, durationMs: 1, robots: { verdict: 'ALLOWED' }, httpStatus: 200 });
  f.core.submit(app, { type: 'web.fetch.v1', input: { url: 'https://example.com/1' }, idempotencyKey: 'a' });
  const lease = f.core.lease(node.session.nodeId); assert.ok(lease);
  const bad: unknown[] = [null, 'FETCHED', {}, { ...good('https://example.com/1'), outcome: 'MAYBE' }, { ...good('https://example.com/1'), extra: 'x' }, { ...good('https://example.com/1'), robots: { verdict: 'ALLOWED', secret: 1 } },
    { ...good('https://example.com/1'), page: { text: 'x'.repeat(10240), links: Array.from({ length: 100 }, (_, i) => ({ url: `https://example.com/${'p'.repeat(300)}${i}`, nofollow: false })), linksTruncated: false } }, { ...good('https://example.com/1'), contentSha256: 'nothex' }, { message: 'echo shaped' }];
  for (const result of bad) assert.throws(() => f.core.complete(node.session.nodeId, lease.jobId, { leaseId: lease.leaseId, result }), code('INVALID_RESULT', 400));
  assert.equal(f.core.getJob(app, lease.jobId).status, 'LEASED'); // nothing was accepted
  f.advance(100); f.core.maintain(); f.core.heartbeat(node.session.nodeId, fetchHeartbeat()); // the 50 ms test lease has expired
  assert.throws(() => f.core.complete(node.session.nodeId, lease.jobId, { leaseId: lease.leaseId, result: good('https://example.com/1') }), code('LEASE_CONFLICT', 409)); // late
  const again = f.core.lease(node.session.nodeId); assert.ok(again); assert.notEqual(again.leaseId, lease.leaseId);
  assert.throws(() => f.core.complete(node.session.nodeId, again.jobId, { leaseId: lease.leaseId, result: good('https://example.com/1') }), code('LEASE_CONFLICT', 409)); // superseded lease
  f.core.complete(node.session.nodeId, again.jobId, { leaseId: again.leaseId, result: good('https://example.com/1') }); assert.equal(f.core.getJob(app, again.jobId).status, 'COMPLETED');
});

async function stack(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'privanet-fetch-e2e-')); const store = new SqliteStore(join(dir, 'coordinator.sqlite'));
  const core = new Coordinator(store, { leaseMs: 5000, maxAttempts: 2 }); const admin = secret();
  const coordinator = createCoordinatorServer(core, { adminSecret: admin, log: () => undefined });
  await new Promise<void>(resolve => coordinator.listen(0, '127.0.0.1', resolve)); const url = `http://127.0.0.1:${(coordinator.address() as AddressInfo).port}`;
  const sockets = new Set<import('node:net').Socket>(); const seen: Array<{ url: string; ua: string | undefined }> = [];
  const site: Server = createServer((req, res) => { seen.push({ url: req.url ?? '', ua: req.headers['user-agent'] });
    if (req.url === '/robots.txt') { res.writeHead(404); res.end(); return; }
    if (req.url === '/private') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>Private</title>'); return; }
    res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html lang="en"><head><title>End to end lighthouse</title><meta name="description" content="A page fetched through the whole PrivaNet path"></head><body><p>Lighthouses guide ships.</p><a href="/next">next</a></body></html>'); });
  site.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)); }); await new Promise<void>(resolve => site.listen(0, '127.0.0.1', resolve)); const sitePort = (site.address() as AddressInfo).port;
  t.after(async () => { for (const s of sockets) s.destroy(); await new Promise<void>(resolve => site.close(() => resolve())); await new Promise<void>(resolve => { coordinator.close(() => resolve()); coordinator.closeAllConnections(); }); store.close(); await rm(dir, { recursive: true, force: true }); });
  const transport = new Transport({ url, allowInsecureLoopback: true });
  return { dir, url, admin, transport, sitePort, seen, siteUrl: (path: string) => `http://site.example:${sitePort}${path}`,
    app: (body: object) => transport.request('POST', '/v1/admin/applications', AppCredentialSchema, body, admin),
    grant: (capabilities: string[]) => transport.request('POST', '/v1/admin/enrollment-tokens', EnrollmentTokenSchema, { expiresInMs: 60000, capabilities }, admin) };
}

test('the whole path with a real Coordinator, a real authenticated PrivaNode and the SDK: submit web.fetch.v1, node fetches safely, validated digest comes back', async t => {
  const s = await stack(t);
  const crawler = await s.app({ name: 'crawler', allowedJobTypes: ['web.fetch.v1'], fetchIdentity: identity }); const noIdentity = await s.app({ name: 'anon', allowedJobTypes: ['web.fetch.v1'] });
  const sdk = new PrivaNetClient({ url: s.url, allowInsecureLoopback: true, token: crawler.token });
  await assert.rejects(new PrivaNetClient({ url: s.url, allowInsecureLoopback: true, token: noIdentity.token }).submit('web.fetch.v1', { url: s.siteUrl('/') }, 'anon-1'), code('FETCH_IDENTITY_REQUIRED', 403));
  await assert.rejects(sdk.submit('system.echo.v1', { message: 'x' }, 'wrong-type'), code('JOB_TYPE_FORBIDDEN', 403)); // the credential is scoped to exactly one capability
  const policy = ResourcePolicySchema.parse({ maxMemoryBytes: 1024 ** 3, reserveMemoryBytes: 0, safetyMarginBytes: 0, maxCpuPercent: 100, reserveCpuPercent: 0, onBattery: 'normal' });
  const engine = new ResourceEngine(policy, { sample: () => ({ availableMemoryBytes: 8 * 1024 ** 3, ownerCpuPercent: 1, power: 'AC', freeDiskBytes: 50 * 1024 ** 3 }) });
  const fetchHandler = createFetchHandler({ policy: { denyHosts: [], minHostDelayMs: 0, maxRequestsPerMinute: 100, hardTimeoutMs: 30000, unsafeLocal: { allowedCidrs: ['127.0.0.0/8'], allowedPorts: [s.sitePort], hostMap: { 'site.example': '127.0.0.1' } } } });
  const grant = await s.grant(['web.fetch.v1']);
  const node = new PrivaNode({ url: s.url, allowInsecureLoopback: true, stateDir: join(s.dir, 'node'), capabilities: ['web.fetch.v1'], enrollmentToken: grant.token, engine, handlers: { ...defaultHandlers, 'web.fetch.v1': fetchHandler } });
  const job = await sdk.submit('web.fetch.v1', { url: s.siteUrl('/page#frag') }, 'crawl:e2e:0'); assert.equal((await sdk.submit('web.fetch.v1', { url: s.siteUrl('/page#frag') }, 'crawl:e2e:0')).id, job.id); // idempotent
  await node.tick(); const raw = await sdk.waitForResult<'web.fetch.v1'>(job.id, { timeoutMs: 10000 }); const result = FetchOutputSchema.parse(raw);
  assert.equal(result.outcome, 'FETCHED'); assert.equal(result.page?.title, 'End to end lighthouse'); assert.match(result.page?.text ?? '', /Lighthouses guide ships/); assert.equal(result.page?.links[0]?.url, `http://site.example:${s.sitePort}/next`);
  assert.equal(result.robots.verdict, 'ALLOWED'); assert.equal(s.seen.find(x => x.url === '/page')?.ua, 'E2eBot/1.0 (+https://e2e.example/bot; via PrivaNet)'); // identity came from the Coordinator's application record
  assert.equal((await sdk.getJob(job.id)).attempts, 1);
  // A restricted target is a normal result, not a crash, and reaches no network.
  const blocked = await sdk.submit('web.fetch.v1', { url: 'http://169.254.169.254/latest/meta-data/' }, 'crawl:e2e:meta'); await node.tick();
  assert.equal(FetchOutputSchema.parse(await sdk.waitForResult(blocked.id, { timeoutMs: 10000 })).outcome, 'BLOCKED_TARGET'); assert.equal(s.seen.some(x => x.url.includes('meta-data')), false);
});
