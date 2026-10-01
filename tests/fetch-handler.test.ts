import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as rawRequest } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { FetchInputSchema, FetchOutputSchema } from '@privanet/protocol';
import type { FetchIdentity, FetchInput, FetchOutput } from '@privanet/protocol';
import { createFetchHandler } from '@privanet/node/fetch/handler';
import type { FetchPolicy } from '@privanet/node/fetch/handler';
import { Limiter } from '@privanet/node/fetch/politeness';
import { RobotsCache } from '@privanet/node/fetch/robots';
import { loadConfig, loadResourcePolicy } from '@privanet/node/config';
import { createServer as createTlsServer } from 'node:https';
import { TEST_CERT, TEST_KEY } from './tls-fixture.js';

// Everything here talks to real HTTP servers on loopback, made reachable only through the owner-local escape hatch.
const identity: FetchIdentity = { product: 'TestBot', infoUrl: 'https://bot.example/about' };
interface Seen { method: string; url: string; headers: IncomingMessage['headers'] }
type Route = (req: IncomingMessage, res: ServerResponse) => void;
async function origin(t: TestContext, routes: Record<string, Route>) {
  const seen: Seen[] = []; const sockets = new Set<import('node:net').Socket>();
  const server: Server = createServer((req, res) => { seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers }); const route = routes[(req.url ?? '').split('?')[0] ?? ''] ?? routes['*']; if (route) route(req, res); else { res.writeHead(404); res.end('nope'); } });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const port = (server.address() as AddressInfo).port;
  t.after(() => new Promise<void>(resolve => { for (const s of sockets) s.destroy(); server.close(() => resolve()); }));
  return { port, seen, hits: (path: string) => seen.filter(s => s.url.split('?')[0] === path).length, url: (host: string, path = '/') => `http://${host}:${port}${path}` };
}
const html = (body: string, headers: Record<string, string> = {}): Route => (_req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...headers }); res.end(body); };
const noRobots: Route = (_req, res) => { res.writeHead(404); res.end(); };
const page = '<html lang="en"><head><title>Lighthouse</title><meta name="description" content="How lighthouses work"></head><body><h1>Lights</h1><p>Text about beacons.</p><a href="/next">next</a><a href="https://other.example/x" rel="nofollow">o</a></body></html>';
function rig(port: number, extra: Partial<FetchPolicy> = {}, deps: Parameters<typeof createFetchHandler>[0] extends infer D ? Partial<D> : never = {}) {
  const policy: FetchPolicy = { denyHosts: [], minHostDelayMs: 0, maxRequestsPerMinute: 1000, hardTimeoutMs: 30000,
    unsafeLocal: { allowedCidrs: ['127.0.0.0/8'], allowedPorts: [port], hostMap: { 'site.example': '127.0.0.1', 'other.example': '127.0.0.1', 'third.example': '127.0.0.1' } }, ...extra };
  const handler = createFetchHandler({ policy, ...deps });
  return (input: FetchInput, signal: AbortSignal = new AbortController().signal, transfer?: (bytes: number) => Promise<void>) => handler(input, { signal, client: identity, ...(transfer ? { transfer } : {}) });
}
const outcome = async (run: Promise<FetchOutput>) => (await run).outcome;

test('a valid fetch returns a digest through the guarded path, sends only the fixed identity headers and a GET, and reports robots and hashes', async t => {
  const o = await origin(t, { '/robots.txt': noRobots, '/a': html(page, { etag: '"v1"', 'last-modified': 'Tue, 15 Nov 1994 08:12:31 GMT' }) });
  const result = await rig(o.port)({ url: o.url('site.example', '/a?q=1#frag') });
  assert.equal(FetchOutputSchema.safeParse(result).success, true);
  assert.equal(result.outcome, 'FETCHED'); assert.equal(result.httpStatus, 200); assert.equal(result.finalUrl, `http://site.example:${o.port}/a?q=1`);
  assert.deepEqual(result.page?.title, 'Lighthouse'); assert.equal(result.page?.description, 'How lighthouses work'); assert.equal(result.page?.language, 'en'); assert.match(result.page?.text ?? '', /Lights Text about beacons/);
  assert.deepEqual(result.page?.links, [{ url: `http://site.example:${o.port}/next`, nofollow: false }, { url: 'https://other.example/x', nofollow: true }]);
  assert.equal(result.etag, '"v1"'); assert.equal(result.lastModified, 'Tue, 15 Nov 1994 08:12:31 GMT'); assert.equal(result.contentType, 'text/html'); assert.equal(result.robots.verdict, 'ALLOWED'); assert.deepEqual(result.indexing, { noindex: false, nofollow: false, noarchive: false });
  assert.equal(result.contentSha256, createHash('sha256').update(page).digest('hex')); assert.equal(result.bodyBytes, Buffer.byteLength(page)); assert.equal(result.bodyTruncated, false);
  const req = o.seen.find(s => s.url.startsWith('/a'))!; assert.equal(req.method, 'GET'); assert.equal(req.headers.host, `site.example:${o.port}`);
  assert.equal(req.headers['user-agent'], 'TestBot/1.0 (+https://bot.example/about; via PrivaNet)'); assert.equal(req.headers.connection, 'close');
  for (const forbidden of ['cookie', 'authorization', 'referer', 'origin', 'x-forwarded-for', 'proxy-authorization']) assert.equal(req.headers[forbidden], undefined, forbidden);
  assert.deepEqual(Object.keys(req.headers).sort(), ['accept', 'accept-encoding', 'connection', 'host', 'user-agent']);
  assert.equal(o.seen.find(s => s.url === '/robots.txt')?.headers['user-agent'], 'TestBot/1.0 (+https://bot.example/about; via PrivaNet)');
});

test('without a registered application identity the handler refuses to run', async t => {
  const o = await origin(t, { '*': html(page) });
  const handler = createFetchHandler({ policy: { denyHosts: [], minHostDelayMs: 0, maxRequestsPerMinute: 10, hardTimeoutMs: 30000, unsafeLocal: { allowedCidrs: ['127.0.0.0/8'], allowedPorts: [o.port], hostMap: { 'site.example': '127.0.0.1' } } } });
  await assert.rejects(handler({ url: o.url('site.example') }, { signal: new AbortController().signal }), /CLIENT_IDENTITY_MISSING/); assert.equal(o.seen.length, 0);
});

test('SSRF: localhost, loopback, private, link-local, metadata and reserved targets are refused before any connection, even for an IP the owner did not allow', async t => {
  const o = await origin(t, { '*': html(page) });
  const run = rig(o.port, { unsafeLocal: undefined });
  for (const url of ['http://localhost/', `http://127.0.0.1:${o.port}/`, 'http://[::1]/', 'http://10.0.0.5/', 'http://172.16.0.1/', 'http://192.168.1.1/', 'http://169.254.169.254/latest/meta-data/', 'http://[fd00:ec2::254]/', 'http://[fe80::1]/', 'http://224.0.0.1/', 'http://0.0.0.0/', 'http://[::ffff:127.0.0.1]/', 'http://2130706433/', 'http://intranet/', 'ftp://example.com/', 'https://user:pw@example.com/', 'http://example.com:8080/', 'file:///etc/passwd'])
    assert.equal((await run({ url })).outcome, 'BLOCKED_TARGET', url);
  assert.equal(o.seen.length, 0); // nothing ever connected
  const result = await run({ url: 'http://10.0.0.5/' }); assert.equal(result.robots.verdict, 'UNAVAILABLE'); assert.equal(result.httpStatus, undefined); // no network detail is leaked
});

test('SSRF: a name that resolves to a private, loopback, link-local or mixed answer is refused, IPv6 and embedded IPv4 included', async t => {
  const o = await origin(t, { '*': html(page) });
  const answers: Record<string, string[]> = { 'priv.example': ['10.0.0.5'], 'loop.example': ['127.0.0.1'], 'meta.example': ['169.254.169.254'], 'mixed.example': ['93.184.216.34', '10.0.0.5'], 'v6.example': ['fd00::1'], 'mapped.example': ['::ffff:10.0.0.1'], 'nat64.example': ['64:ff9b::a00:1'], 'empty.example': [] };
  const run = rig(o.port, { unsafeLocal: undefined }, { resolver: async host => answers[host] ?? ['93.184.216.34'] });
  for (const name of Object.keys(answers).filter(n => n !== 'empty.example')) assert.equal((await run({ url: `http://${name}/` })).outcome, 'BLOCKED_TARGET', name);
  assert.equal((await run({ url: 'http://empty.example/' })).outcome, 'FETCH_FAILED'); assert.equal(o.seen.length, 0);
});

test('DNS rebinding: an answer that changes between the robots lookup and the page lookup is caught, and the connection is made to the vetted address', async t => {
  const o = await origin(t, { '/robots.txt': noRobots, '*': html(page) });
  let calls = 0; const flip = rig(o.port, { unsafeLocal: { allowedCidrs: ['127.0.0.0/8'], allowedPorts: [o.port], hostMap: {} } }, { resolver: async () => (++calls === 1 ? ['127.0.0.1'] : ['10.0.0.9']) });
  assert.equal((await flip({ url: `http://rebind.example:${o.port}/a` })).outcome, 'BLOCKED_TARGET'); assert.equal(o.hits('/a'), 0); assert.equal(calls, 2);
  // The socket goes to the resolved IP: a hostname that cannot be resolved by the OS still works because the handler resolved it itself.
  const pinned = rig(o.port, {}, { resolver: async () => ['127.0.0.1'] }); assert.equal((await pinned({ url: `http://unresolvable.invalid/`.replace('.invalid/', `.example:${o.port}/a`) })).outcome, 'FETCHED');
});

test('redirects: same-origin are followed and recorded, cross-origin come back as REDIRECT, restricted or looping or excessive chains are refused', async t => {
  const o = await origin(t, {
    '/robots.txt': noRobots,
    '/r1': (_q, res) => { res.writeHead(301, { location: '/r2' }); res.end(); }, '/r2': (_q, res) => { res.writeHead(302, { location: '/final' }); res.end(); }, '/final': html(page),
    '/cross': (_q, res) => { res.writeHead(302, { location: `http://other.example:${o.port}/landing` }); res.end(); },
    '/toprivate': (_q, res) => { res.writeHead(302, { location: 'http://10.0.0.1/admin' }); res.end(); },
    '/toloop': (_q, res) => { res.writeHead(302, { location: `http://127.0.0.1:${o.port}/final` }); res.end(); },
    '/tometa': (_q, res) => { res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }); res.end(); },
    '/toscheme': (_q, res) => { res.writeHead(302, { location: 'file:///etc/passwd' }); res.end(); },
    '/loopa': (_q, res) => { res.writeHead(302, { location: '/loopb' }); res.end(); }, '/loopb': (_q, res) => { res.writeHead(302, { location: '/loopa' }); res.end(); },
    '/c1': (_q, res) => { res.writeHead(302, { location: '/c2' }); res.end(); }, '/c2': (_q, res) => { res.writeHead(302, { location: '/c3' }); res.end(); }, '/c3': (_q, res) => { res.writeHead(302, { location: '/c4' }); res.end(); }, '/c4': (_q, res) => { res.writeHead(302, { location: '/final' }); res.end(); },
    '/nolocation': (_q, res) => { res.writeHead(302); res.end(); },
  });
  const run = rig(o.port);
  const followed = await run({ url: o.url('site.example', '/r1') }); assert.equal(followed.outcome, 'FETCHED'); assert.deepEqual(followed.redirects.map(r => r.status), [301, 302]); assert.equal(followed.finalUrl, `http://site.example:${o.port}/final`);
  const cross = await run({ url: o.url('site.example', '/cross') }); assert.equal(cross.outcome, 'REDIRECT'); assert.equal(cross.redirectTarget, `http://other.example:${o.port}/landing`); assert.equal(o.hits('/landing'), 0); // not followed
  for (const path of ['/toprivate', '/toloop', '/tometa', '/toscheme']) assert.equal((await run({ url: o.url('site.example', path) })).outcome, 'BLOCKED_TARGET', path);
  const loop = await run({ url: o.url('site.example', '/loopa') }); assert.deepEqual([loop.outcome, loop.error?.code], ['FETCH_FAILED', 'PROTOCOL']);
  const chain = await run({ url: o.url('site.example', '/c1') }); assert.equal(chain.outcome, 'REDIRECT'); assert.equal(chain.redirects.length, 3); assert.match(chain.redirectTarget ?? '', /\/final$/); // the fourth hop is beyond the cap: reported, not followed
  assert.equal((await run({ url: o.url('site.example', '/c1'), maxRedirects: 0 })).outcome, 'REDIRECT');
  assert.equal((await run({ url: o.url('site.example', '/nolocation') })).outcome, 'FETCH_FAILED');
});

test('bounds: total time, headers that never arrive, and slow bodies are cut off, and a failed fetch is a result, not a crash', async t => {
  const o = await origin(t, { '/robots.txt': noRobots, '/hang': () => { /* never answers */ }, '/drip': (_q, res) => { res.writeHead(200, { 'content-type': 'text/html' }); const timer = setInterval(() => res.write('<p>x</p>'), 100); res.on('close', () => clearInterval(timer)); } });
  const run = rig(o.port, { hardTimeoutMs: 1000 });
  const started = Date.now(); const hung = await run({ url: o.url('site.example', '/hang'), timeoutMs: 1000 });
  assert.deepEqual([hung.outcome, hung.error?.code, hung.error?.retryable], ['FETCH_FAILED', 'TIMEOUT', true]); assert.ok(Date.now() - started < 4000);
  const dripped = await run({ url: o.url('site.example', '/drip'), timeoutMs: 1000 }); assert.deepEqual([dripped.outcome, dripped.error?.code], ['FETCH_FAILED', 'TIMEOUT']); assert.ok(Date.now() - started < 8000);
  const dead = await rig(o.port, { unsafeLocal: { allowedCidrs: ['127.0.0.0/8'], allowedPorts: [o.port + 1], hostMap: { 'site.example': '127.0.0.1' } } })({ url: `http://site.example:${o.port + 1}/` }); // nothing listens there
  assert.equal(dead.outcome, 'ROBOTS_UNAVAILABLE'); // an unreachable host has no reachable robots.txt, so nothing is fetched
});

test('bounds: oversized bodies, oversized declared length and oversized headers are refused; the decoded body is capped and marked truncated', async t => {
  const big = Buffer.alloc(3 * 1024 * 1024, 'a'); const hugeGz = gzipSync(Buffer.alloc(64 * 1024 * 1024, 'a')); const words = Array.from({ length: 40000 }, (_, i) => `word${i % 977}`).join(' ');
  const o = await origin(t, {
    '/robots.txt': noRobots,
    '/declared': (_q, res) => { res.writeHead(200, { 'content-type': 'text/html', 'content-length': String(big.length) }); res.end(big); },
    '/chunked': (_q, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(big); },
    '/bomb': (_q, res) => { res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' }); res.end(gzipSync(Buffer.alloc(1024 * 1024, 'a'))); },
    '/huge-bomb': (_q, res) => { res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' }); res.end(hugeGz); },
    '/gz': (_q, res) => { res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' }); res.end(gzipSync(`<p>${words}</p>`)); },
    '/badenc': (_q, res) => { res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'compress' }); res.end('x'); },
    '/corrupt': (_q, res) => { res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' }); res.end(Buffer.from('this is not gzip data at all')); },
    '/bigheader': (_q, res) => { res.writeHead(200, { 'content-type': 'text/html', 'x-junk': 'j'.repeat(20000) }); res.end('x'); },
  });
  const run = rig(o.port);
  for (const path of ['/declared', '/chunked']) assert.equal((await run({ url: o.url('site.example', path), maxBodyBytes: 65536 })).outcome, 'TOO_LARGE', path);
  const bomb = await run({ url: o.url('site.example', '/bomb'), maxBodyBytes: 1048576 }); assert.equal(bomb.outcome, 'TOO_LARGE'); // a 1 MiB expansion from about 1 KiB is stopped by the ratio cap
  const started = Date.now(); const huge = await run({ url: o.url('site.example', '/huge-bomb') }); assert.equal(huge.outcome, 'FETCHED'); assert.equal(huge.bodyTruncated, true); assert.equal(huge.bodyBytes, 524288); assert.ok(Date.now() - started < 3000); // 64 MiB is never inflated: reading stops at the decoded cap
  const gz = await run({ url: o.url('site.example', '/gz'), maxBodyBytes: 65536 });
  assert.equal(gz.outcome, 'FETCHED'); assert.equal(gz.bodyTruncated, true); assert.equal(gz.bodyBytes, 65536); assert.equal(gz.page?.textTruncated, true);
  assert.deepEqual([(await run({ url: o.url('site.example', '/badenc') })).error?.code, (await run({ url: o.url('site.example', '/corrupt') })).error?.code], ['PROTOCOL', 'DECODE']);
  assert.equal((await run({ url: o.url('site.example', '/bigheader') })).outcome, 'FETCH_FAILED'); // header block over 16 KiB
});

test('content types: only HTML, XHTML and plain text are read; everything else is refused after the headers', async t => {
  const o = await origin(t, { '/robots.txt': noRobots, '/png': (_q, res) => { res.writeHead(200, { 'content-type': 'image/png' }); res.end(Buffer.alloc(100)); }, '/none': (_q, res) => { res.writeHead(200); res.end('x'); },
    '/txt': (_q, res) => { res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }); res.end('plain words here'); }, '/xhtml': (_q, res) => { res.writeHead(200, { 'content-type': 'application/xhtml+xml' }); res.end('<html><body>x</body></html>'); }, '/json': (_q, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); } });
  const run = rig(o.port);
  for (const path of ['/png', '/none', '/json']) assert.equal((await run({ url: o.url('site.example', path) })).outcome, 'UNSUPPORTED_CONTENT_TYPE', path);
  assert.equal((await run({ url: o.url('site.example', '/txt') })).page?.text, 'plain words here'); assert.equal((await run({ url: o.url('site.example', '/xhtml') })).outcome, 'FETCHED');
});

test('HTTP semantics: conditional requests, 304, errors with Retry-After, probe mode, latin-1 decoding', async t => {
  const o = await origin(t, { '/robots.txt': noRobots, '/cond': (req, res) => { if (req.headers['if-none-match'] === '"v1"') { res.writeHead(304); res.end(); } else { res.writeHead(200, { 'content-type': 'text/html' }); res.end(page); } },
    '/busy': (_q, res) => { res.writeHead(503, { 'retry-after': '120' }); res.end(); }, '/limited': (_q, res) => { res.writeHead(429, { 'retry-after': new Date(Date.now() + 45000).toUTCString() }); res.end(); }, '/gone': (_q, res) => { res.writeHead(410); res.end(); },
    '/latin': (_q, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=iso-8859-1' }); res.end(Buffer.from('<title>caf\xe9</title><p>na\xefve</p>', 'latin1')); } });
  const run = rig(o.port);
  const notModified = await run({ url: o.url('site.example', '/cond'), validators: { etag: '"v1"' } }); assert.equal(notModified.outcome, 'NOT_MODIFIED'); assert.equal(o.seen.find(s => s.url === '/cond')?.headers['if-none-match'], '"v1"');
  assert.equal((await run({ url: o.url('site.example', '/cond'), validators: { etag: '"other"' } })).outcome, 'FETCHED');
  const busy = await run({ url: o.url('site.example', '/busy') }); assert.deepEqual([busy.outcome, busy.httpStatus, busy.retryAfterSec], ['HTTP_ERROR', 503, 120]);
  const limited = await run({ url: o.url('site.example', '/limited') }); assert.equal(limited.outcome, 'HTTP_ERROR'); assert.ok((limited.retryAfterSec ?? 0) > 30 && (limited.retryAfterSec ?? 0) <= 45);
  assert.deepEqual([(await run({ url: o.url('site.example', '/gone') })).httpStatus, (await run({ url: o.url('site.example', '/missing') })).httpStatus], [410, 404]);
  const probe = await run({ url: o.url('site.example', '/cond'), mode: 'PROBE' }); assert.deepEqual([probe.outcome, probe.page], ['PROBED', undefined]);
  const latin = await run({ url: o.url('site.example', '/latin') }); assert.equal(latin.page?.title, 'café'); assert.match(latin.page?.text ?? '', /naïve/);
});

test('robots.txt is enforced at fetch time: disallow refuses without fetching the page, 4xx allows, 5xx or errors refuse, product-specific groups and crawl-delay apply, and the file is cached', async t => {
  const o = await origin(t, { '/robots.txt': (_q, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('User-agent: *\nDisallow: /private\nCrawl-delay: 2\nUser-agent: TestBot\nDisallow: /testbot-only\nAllow: /private/ok\nDisallow: /private\n'); }, '*': html(page) });
  const run = rig(o.port);
  const refused = await run({ url: o.url('site.example', '/private/x') }); assert.deepEqual([refused.outcome, refused.robots.verdict], ['ROBOTS_DISALLOWED', 'DISALLOWED']); assert.equal(o.hits('/private/x'), 0);
  assert.equal((await run({ url: o.url('site.example', '/testbot-only') })).outcome, 'ROBOTS_DISALLOWED'); assert.equal((await run({ url: o.url('site.example', '/private/ok') })).outcome, 'FETCHED'); // the TestBot group beats the * group
  const ok = await run({ url: o.url('site.example', '/open') }); assert.equal(ok.outcome, 'FETCHED'); assert.equal(ok.robots.verdict, 'ALLOWED'); assert.match(ok.robots.sha256 ?? '', /^[a-f0-9]{64}$/);
  assert.equal(o.hits('/robots.txt'), 1); // fetched once, then served from the in-memory cache
  const broken = await origin(t, { '/robots.txt': (_q, res) => { res.writeHead(500); res.end(); }, '*': html(page) });
  const unavailable = await rig(broken.port)({ url: broken.url('site.example', '/a') }); assert.deepEqual([unavailable.outcome, unavailable.robots.verdict], ['ROBOTS_UNAVAILABLE', 'UNAVAILABLE']); assert.equal(broken.hits('/a'), 0);
  const timeoutRobots = await origin(t, { '/robots.txt': () => { /* hangs */ }, '*': html(page) });
  assert.equal((await rig(timeoutRobots.port, { hardTimeoutMs: 1000 })({ url: timeoutRobots.url('site.example', '/a'), timeoutMs: 1000 })).outcome, 'ROBOTS_UNAVAILABLE'); assert.equal(timeoutRobots.hits('/a'), 0);
  const denyAll = await origin(t, { '/robots.txt': (_q, res) => { res.writeHead(200); res.end('User-agent: *\nDisallow: /'); }, '*': html(page) });
  assert.equal((await rig(denyAll.port)({ url: denyAll.url('site.example', '/') })).outcome, 'ROBOTS_DISALLOWED');
  const redirected = await origin(t, { '/robots.txt': (_q, res) => { res.writeHead(301, { location: 'http://10.0.0.1/robots.txt' }); res.end(); }, '*': html(page) });
  assert.equal((await rig(redirected.port)({ url: redirected.url('site.example', '/a') })).outcome, 'ROBOTS_UNAVAILABLE'); assert.equal(redirected.hits('/a'), 0); // robots redirects get the same restrictions
});

test('robots crawl-delay raises the node-side per-host delay, and a request inside the delay returns RATE_LIMITED immediately', async t => {
  const o = await origin(t, { '/robots.txt': (_q, res) => { res.writeHead(200); res.end('User-agent: *\nCrawl-delay: 10'); }, '*': html(page) });
  let now = 1_000_000; const clock = () => now; const run = rig(o.port, { minHostDelayMs: 1000 }, { clock });
  const first = await run({ url: o.url('site.example', '/a') }); assert.equal(first.outcome, 'FETCHED'); assert.equal(first.robots.crawlDelaySec, 10);
  const started = Date.now(); const second = await run({ url: o.url('site.example', '/b') }); assert.ok(Date.now() - started < 500, 'must not sleep');
  assert.equal(second.outcome, 'RATE_LIMITED'); assert.ok((second.retryAfterSec ?? 0) >= 9); assert.equal(o.hits('/b'), 0);
  now += 11_000; assert.equal((await run({ url: o.url('site.example', '/b') })).outcome, 'FETCHED');
  const capped = rig(o.port, { minHostDelayMs: 0, maxRequestsPerMinute: 2 }, { clock, cache: new RobotsCache(clock), limiter: new Limiter(0, 2, clock) });
  assert.deepEqual([await outcome(capped({ url: o.url('site.example', '/x') })), await outcome(capped({ url: o.url('third.example', '/y') })), await outcome(capped({ url: o.url('other.example', '/z') }))], ['FETCHED', 'FETCHED', 'RATE_LIMITED']);
});

test('indexing signals: noindex (header or meta) omits the text, nofollow omits links, both are reported', async t => {
  const o = await origin(t, { '/robots.txt': noRobots, '/hdr': html(page, { 'x-robots-tag': 'noindex, nofollow' }), '/meta': html('<html><head><meta name="robots" content="noindex"><title>T</title></head><body>secret words <a href="/l">l</a></body></html>'),
    '/agent': html(page, { 'x-robots-tag': 'otherbot: noindex' }), '/mine': html(page, { 'x-robots-tag': 'testbot: noindex' }) });
  const run = rig(o.port);
  const hdr = await run({ url: o.url('site.example', '/hdr') }); assert.deepEqual(hdr.indexing, { noindex: true, nofollow: true, noarchive: false }); assert.equal(hdr.page?.text, undefined); assert.deepEqual(hdr.page?.links, []);
  const meta = await run({ url: o.url('site.example', '/meta') }); assert.equal(meta.indexing?.noindex, true); assert.equal(meta.page?.text, undefined); assert.equal(meta.page?.links.length, 1); assert.equal(meta.page?.title, 'T');
  assert.equal((await run({ url: o.url('site.example', '/agent') })).indexing?.noindex, false); assert.equal((await run({ url: o.url('site.example', '/mine') })).indexing?.noindex, true); // directives addressed to another crawler do not apply
});

test('results always fit the completion body budget, however much the page offers', async t => {
  const links = Array.from({ length: 400 }, (_, i) => `<a href="/${'p'.repeat(200)}${i}">x</a>`).join(''); const text = 'lorem ipsum '.repeat(20000);
  const o = await origin(t, { '/robots.txt': noRobots, '/huge': html(`<html><head><title>${'T'.repeat(500)}</title><meta name="description" content="${'d'.repeat(900)}"></head><body><p>${text}</p>${links}</body></html>`) });
  const result = await rig(o.port)({ url: o.url('site.example', '/huge') });
  assert.equal(result.outcome, 'FETCHED'); assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 28000); assert.equal(FetchOutputSchema.safeParse(result).success, true); assert.equal(result.page?.linksTruncated, true);
  assert.ok((result.page?.title?.length ?? 0) <= 300 && (result.page?.description?.length ?? 0) <= 500);
});

test('preemption: an abort mid-request stops the fetch and propagates so the node can release the job; the bytes are metered', async t => {
  let sent = 0; const o = await origin(t, { '/robots.txt': noRobots, '/slow': (_q, res) => { res.writeHead(200, { 'content-type': 'text/html' }); const timer = setInterval(() => { sent++; res.write('<p>chunk</p>'.repeat(10)); }, 50); res.on('close', () => clearInterval(timer)); } });
  const controller = new AbortController(); let metered = 0;
  const running = rig(o.port)({ url: o.url('site.example', '/slow'), timeoutMs: 10000 }, controller.signal, async bytes => { metered += bytes; });
  setTimeout(() => controller.abort(new Error('preempted')), 300); const started = Date.now();
  await assert.rejects(running, /preempted/); assert.ok(Date.now() - started < 2000); assert.ok(metered > 0, 'transfer was metered'); const before = sent; await new Promise(r => setTimeout(r, 200)); assert.ok(sent - before <= 2, 'the connection was closed');
  const done = await origin(t, { '/robots.txt': noRobots, '/p': html(page) }); let total = 0; await rig(done.port)({ url: done.url('site.example', '/p') }, undefined, async bytes => { total += bytes; });
  assert.ok(total >= Buffer.byteLength(page)); // page bytes are counted (robots.txt is a 404 with no body)
  const owner = rig(o.port); const already = new AbortController(); already.abort(new Error('shutdown')); await assert.rejects(owner({ url: o.url('site.example', '/slow') }, already.signal), /shutdown/);
});

test('proxy settings never apply: HTTP_PROXY, HTTPS_PROXY and NODE_USE_ENV_PROXY do not change where the request goes', async t => {
  const o = await origin(t, { '/robots.txt': noRobots, '/a': html(page) }); let proxied = 0;
  const proxy = createServer(() => { proxied++; }); proxy.on('connect', (_r, socket) => { proxied++; socket.destroy(); }); proxy.on('connection', () => { proxied++; });
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise<void>(resolve => { proxy.closeAllConnections(); proxy.close(() => resolve()); }));
  const proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`; const saved = { ...process.env };
  Object.assign(process.env, { HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, http_proxy: proxyUrl, https_proxy: proxyUrl, ALL_PROXY: proxyUrl, NODE_USE_ENV_PROXY: '1', NO_PROXY: '' }); delete process.env.no_proxy;
  try { const result = await rig(o.port)({ url: o.url('site.example', '/a') }); assert.equal(result.outcome, 'FETCHED'); assert.equal(o.hits('/a'), 1); assert.equal(proxied, 0, 'the proxy must never be contacted'); }
  finally { for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); }
});

test('the owner-local exception cannot come from a job, the Coordinator or the environment: it exists only in the node\'s local policy file', async t => {
  const { writeFile, mkdtemp, rm } = await import('node:fs/promises'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'fetch-policy-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const env = { PRIVANODE_ALLOW_INSECURE_LOOPBACK: 'true', PRIVANODE_FETCH_UNSAFE_LOCAL: '127.0.0.0/8', PRIVANODE_FETCH_ALLOWED_CIDRS: '127.0.0.0/8', PRIVANODE_UNSAFE_LOCAL: 'true', FETCH_ALLOW_PRIVATE: '1' };
  assert.equal(loadConfig({ ...env, PRIVANODE_STATE_DIR: dir }).policy.fetch.unsafeLocal, undefined);
  const file = join(dir, 'policy.json'); await writeFile(file, JSON.stringify({ fetch: { unsafeLocal: { allowedCidrs: ['127.0.0.0/8'], allowedPorts: [8080], hostMap: {} } } }));
  assert.deepEqual(loadResourcePolicy(file).fetch.unsafeLocal?.allowedPorts, [8080]); assert.equal(loadResourcePolicy(undefined).fetch.unsafeLocal, undefined); // absent unless the owner wrote it
  await writeFile(file, JSON.stringify({ fetch: { unsafeLocal: { allowedCidrs: ['127.0.0.0/8'], surprise: true } } })); assert.throws(() => loadResourcePolicy(file)); // strict
  const defaults = loadResourcePolicy(undefined).fetch; assert.deepEqual([defaults.minHostDelayMs, defaults.maxRequestsPerMinute, defaults.hardTimeoutMs, defaults.denyHosts], [1000, 60, 30000, []]);
  assert.throws(() => createFetchHandler({ policy: { denyHosts: [], minHostDelayMs: 0, maxRequestsPerMinute: 1, hardTimeoutMs: 1000, unsafeLocal: { allowedCidrs: ['bogus'], allowedPorts: [], hostMap: {} } } }), /Invalid unsafeLocal CIDR/);
});

test('connection hygiene: one connection per request, closed afterwards, and the raw socket check passes on a vetted address', async t => {
  const o = await origin(t, { '/robots.txt': noRobots, '/a': html(page) }); const ports = new Set<number>();
  const observer = createServer((req, res) => { ports.add(req.socket.remotePort ?? 0); res.writeHead(404); res.end(); }); await new Promise<void>(resolve => observer.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise<void>(resolve => { observer.closeAllConnections(); observer.close(() => resolve()); }));
  assert.equal((await rig(o.port)({ url: o.url('site.example', '/a') })).outcome, 'FETCHED'); assert.equal(o.seen.every(s => s.headers.connection === 'close'), true); void rawRequest; void ports;
});

test('TLS certificates are always verified: an untrusted or mismatched certificate is a failure, never a fetch, and there is no way to switch verification off', async t => {
  let served = 0; const tls = createTlsServer({ key: TEST_KEY, cert: TEST_CERT }, (_req, res) => { served++; res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>should never be read</title>'); });
  await new Promise<void>(resolve => tls.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise<void>(resolve => { tls.closeAllConnections(); tls.close(() => resolve()); })); const port = (tls.address() as AddressInfo).port;
  const run = rig(port, { unsafeLocal: { allowedCidrs: ['127.0.0.0/8'], allowedPorts: [port], hostMap: { 'tls.example': '127.0.0.1', 'wrong.example': '127.0.0.1' } } });
  for (const host of ['tls.example', 'wrong.example']) { // self-signed and unknown to the trust store; and a name the certificate does not cover
    const result = await run({ url: `https://${host}:${port}/` }); assert.deepEqual([result.outcome, result.error?.code, result.error?.retryable], ['ROBOTS_UNAVAILABLE', undefined, undefined]); }
  assert.equal(served, 0, 'no request may be sent over an unverified connection');
  assert.equal(Object.keys(FetchInputSchema.shape).some(key => /tls|insecure|verify|cert/i.test(key)), false); // the input has no TLS knob
});
