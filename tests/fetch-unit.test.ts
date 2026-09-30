import test from 'node:test';
import assert from 'node:assert/strict';
import { FETCH_OUTCOMES, FetchIdentitySchema, FetchInputSchema, FetchOutputSchema, JOB_TYPES, requiresClientIdentity } from '@privanet/protocol';
import { classifyAddress, parseCidr } from '@privanet/node/fetch/address';
import { checkUrl } from '@privanet/node/fetch/url-policy';
import { evaluate, parseRobots, RobotsCache, ROBOTS_MAX_BYTES } from '@privanet/node/fetch/robots';
import { Limiter } from '@privanet/node/fetch/politeness';
import { decodeEntities, digestHtml, digestPlain, truncateUtf8 } from '@privanet/node/fetch/digest';

const allowed = (ip: string, cidrs: string[] = []) => classifyAddress(ip, cidrs.map(c => parseCidr(c)!)).allowed;

test('address classification: every special-use IPv4 range is denied, public addresses pass', () => {
  for (const ip of ['0.0.0.0', '0.1.2.3', '10.0.0.1', '10.255.255.255', '100.64.0.1', '100.127.255.255', '127.0.0.1', '127.255.255.254', '169.254.169.254', '169.254.0.1', '172.16.0.1', '172.31.255.255', '192.0.0.1', '192.0.2.5', '192.88.99.1', '192.168.0.1', '192.168.255.255', '198.18.0.1', '198.19.255.255', '198.51.100.7', '203.0.113.9', '224.0.0.1', '239.255.255.250', '240.0.0.1', '255.255.255.255'])
    assert.equal(allowed(ip), false, ip);
  for (const ip of ['1.1.1.1', '8.8.8.8', '93.184.216.34', '172.15.255.255', '172.32.0.1', '100.63.255.255', '100.128.0.1', '11.0.0.1', '192.169.0.1', '198.17.255.255', '198.20.0.1']) assert.equal(allowed(ip), true, ip);
});

test('address classification: IPv6 is deny-by-default, only global unicast passes, and embedded IPv4 is classified by the IPv4', () => {
  for (const ip of ['::', '::1', 'fe80::1', 'fe80::1234:5678', 'fc00::1', 'fd00:ec2::254', 'fdff::1', 'ff02::1', 'ff00::', '100::1', '2001::1', '2001:1::1', '2001:db8::1', '3fff::1', '64:ff9b:1::1', '::2', '2002:7f00:1::1', '2002:0a00:0001::', '2002:c0a8:0101::1', '::ffff:127.0.0.1', '::ffff:10.1.2.3', '::ffff:7f00:1', '::ffff:169.254.169.254', '64:ff9b::7f00:1', '64:ff9b::a9fe:a9fe', '64:ff9b::192.168.1.1', '0:0:0:0:0:ffff:c0a8:1', 'fec0::1', '5f00::1', '4000::1', '1::1'])
    assert.equal(allowed(ip), false, ip);
  for (const ip of ['2606:4700:4700::1111', '2a00:1450:4001:81b::200e', '2001:4860:4860::8888', '::ffff:8.8.8.8', '64:ff9b::808:808', '2002:0808:0808::1']) assert.equal(allowed(ip), true, ip);
  for (const bad of ['', 'not-an-ip', '1.2.3', '1.2.3.4.5', '256.1.1.1', '01.2.3.4x', '::g', 'fe80::1%eth0', '1:2:3:4:5:6:7:8:9']) assert.equal(allowed(bad), false, JSON.stringify(bad));
});

test('the owner-local exception list relaxes exactly the ranges it names, including embedded forms', () => {
  assert.equal(allowed('127.0.0.1', ['127.0.0.0/8']), true); assert.equal(allowed('10.0.0.1', ['127.0.0.0/8']), false); assert.equal(allowed('::ffff:127.0.0.1', ['127.0.0.0/8']), true);
  assert.equal(allowed('::1', ['::1/128']), true); assert.equal(allowed('::2', ['::1/128']), false); assert.equal(allowed('169.254.169.254', ['127.0.0.0/8']), false);
  assert.equal(parseCidr('300.0.0.0/8'), undefined); assert.equal(parseCidr('10.0.0.0/33'), undefined); assert.equal(parseCidr('10.0.0.0/8/1'), undefined); assert.equal(parseCidr('nonsense'), undefined); assert.notEqual(parseCidr('10.0.0.0/8'), undefined);
});

import type { UrlPolicy } from '@privanet/node/fetch/url-policy';
const policy: UrlPolicy = { denyHosts: [], extraPorts: [] };
const reject = (raw: string, reason: string, p = policy) => { const r = checkUrl(raw, p); assert.equal(r.ok, false, raw); assert.equal(r.ok ? '' : r.reason, reason, raw); };
test('URL policy: schemes, credentials, IP literals in every form, internal names, ports, deny and allow lists, length and control characters', () => {
  for (const u of ['ftp://example.com/', 'file:///etc/passwd', 'gopher://example.com/', 'javascript:alert(1)', 'data:text/html,x', 'ws://example.com/', 'wss://example.com/']) reject(u, 'SCHEME');
  reject('https://user:pw@example.com/', 'CREDENTIALS'); reject('https://user@example.com/', 'CREDENTIALS'); reject('https://:pw@example.com/', 'CREDENTIALS');
  for (const u of ['http://127.0.0.1/', 'http://10.1.2.3/', 'http://169.254.169.254/latest/meta-data/', 'http://192.168.0.1/', 'http://0x7f.0.0.1/', 'http://0177.0.0.1/', 'http://2130706433/', 'http://127.1/', 'http://0/', 'http://[::1]/', 'http://[fd00:ec2::254]/', 'http://[::ffff:127.0.0.1]/', 'http://8.8.8.8/', 'http://0x7f000001/']) reject(u, 'IP_LITERAL');
  for (const u of ['http://localhost/', 'http://LOCALHOST/', 'http://a.localhost/', 'http://printer.local/', 'http://db.internal/', 'http://nas.lan/', 'http://x.home.arpa/', 'http://intranet/', 'http://host.localdomain/', 'http://wiki.corp/']) reject(u, 'INTERNAL_HOST');
  for (const u of ['http://example.com:8080/', 'https://example.com:8443/', 'http://example.com:22/', 'https://example.com:80/', 'http://example.com:443/', 'http://example.com:6379/']) reject(u, 'PORT');
  reject('https://example.com/a b', 'CONTROL_CHARS'); reject('https://example.com/\u0000', 'CONTROL_CHARS'); reject('https://example.com\\@evil.com/', 'CONTROL_CHARS'); reject('https://example.com/\n', 'CONTROL_CHARS');
  reject(`https://example.com/${'a'.repeat(2100)}`, 'TOO_LONG'); reject('not a url', 'CONTROL_CHARS'); reject('https://', 'MALFORMED'); reject('', 'MALFORMED');
  reject('https://ads.example.com/', 'DENIED_HOST', { denyHosts: ['example.com'], extraPorts: [] }); reject('https://example.com/', 'DENIED_HOST', { denyHosts: ['EXAMPLE.com'], extraPorts: [] });
  reject('https://other.org/', 'NOT_ALLOWED_HOST', { denyHosts: [], allowHosts: ['example.com'], extraPorts: [] });
  const ok = checkUrl('HTTPS://Example.COM./a/b?x=1#frag', policy); assert.equal(ok.ok, true); if (ok.ok) { assert.equal(ok.url.toString(), 'https://example.com./a/b?x=1'.replace('com.', 'com')); assert.equal(ok.port, 443); }
  assert.equal(checkUrl('http://example.com/', policy).ok, true); assert.equal(checkUrl('https://example.com:443/', policy).ok, true); assert.equal(checkUrl('http://example.com:8080/', { ...policy, extraPorts: [8080] }).ok, true);
  assert.equal(checkUrl('https://sub.example.com/', { denyHosts: [], allowHosts: ['example.com'], extraPorts: [] }).ok, true);
});

test('robots.txt: groups, product-token matching, longest match, Allow beats Disallow on a tie, wildcards, anchors, crawl-delay', () => {
  const rules = parseRobots(['User-agent: *', 'Disallow: /private/', 'Allow: /private/public/', 'Disallow: /*.pdf$', 'Crawl-delay: 5', '',
    'User-agent: TestBot', 'User-agent: OtherBot', 'Disallow: /', 'Allow: /open', '', '# comment', 'User-agent: badbot', 'Disallow:'].join('\n'));
  assert.deepEqual(evaluate(rules, 'Somebot', '/private/x'), { allowed: false, crawlDelaySec: 5 });
  assert.equal(evaluate(rules, 'Somebot', '/private/public/page').allowed, true); assert.equal(evaluate(rules, 'Somebot', '/a/b.pdf').allowed, false); assert.equal(evaluate(rules, 'Somebot', '/a/b.pdf?x=1').allowed, true); assert.equal(evaluate(rules, 'Somebot', '/index.html').allowed, true);
  assert.equal(evaluate(rules, 'testbot', '/anything').allowed, false); assert.equal(evaluate(rules, 'TestBot', '/open/page').allowed, true); assert.equal(evaluate(rules, 'OtherBot', '/x').allowed, false);
  assert.equal(evaluate(rules, 'badbot', '/anything').allowed, true); // an empty Disallow allows everything
  assert.equal(evaluate(parseRobots('User-agent: *\nDisallow: /'), 'x', '/a').allowed, false); assert.equal(evaluate(parseRobots(''), 'x', '/a').allowed, true); assert.equal(evaluate(parseRobots('Disallow: /'), 'x', '/a').allowed, true); // rules before any group are ignored
  assert.equal(evaluate(parseRobots('User-agent: *\nAllow: /a\nDisallow: /a'), 'x', '/a').allowed, true); // tie: Allow wins
  assert.equal(evaluate(parseRobots('User-agent: *\nDisallow: /a*/c'), 'x', '/abc/c').allowed, false); assert.equal(evaluate(parseRobots('User-agent: *\nDisallow: /a*/c'), 'x', '/abc/d').allowed, true);
  assert.equal(evaluate(parseRobots('User-agent: *\nDisallow: /exact$'), 'x', '/exact').allowed, false); assert.equal(evaluate(parseRobots('User-agent: *\nDisallow: /exact$'), 'x', '/exactly').allowed, true);
  assert.equal(parseRobots('a').groups.length, 0); assert.match(parseRobots('User-agent: *').sha256, /^[a-f0-9]{64}$/);
  assert.equal(evaluate(parseRobots('User-agent: *\r\nDisallow: /crlf\r\n'), 'x', '/crlf').allowed, false);
  assert.equal(evaluate(parseRobots('User-agent: *\nCrawl-delay: 9999'), 'x', '/').crawlDelaySec, 300); // bounded
});

test('robots.txt is parsed only up to its cap and cannot be made huge or pathological', () => {
  const padding = 'x'.repeat(ROBOTS_MAX_BYTES + 10); const rules = parseRobots(`User-agent: *\nDisallow: /early\n#${padding}\nDisallow: /late`);
  assert.equal(evaluate(rules, 'x', '/early').allowed, false); assert.equal(evaluate(rules, 'x', '/late').allowed, true); // beyond the cap is ignored
  const many = parseRobots(`User-agent: *\n${Array.from({ length: 20000 }, (_, i) => `Disallow: /p${i}`).join('\n')}`); assert.ok((many.groups[0]?.rules.length ?? 0) <= 10000);
  const started = Date.now(); evaluate(parseRobots(`User-agent: *\nDisallow: ${'*a'.repeat(200)}b`), 'x', `/${'a'.repeat(3000)}`); assert.ok(Date.now() - started < 1000, 'wildcard matching is not catastrophic');
});

test('robots cache: in memory, bounded, expires, refreshes recency', () => {
  let now = 0; const cache = new RobotsCache(() => now, 3, 1000, 100);
  for (const o of ['a', 'b', 'c']) cache.set(`https://${o}.example`, { kind: 'ALLOW_ALL', fetchedAt: now });
  cache.get('https://a.example'); cache.set('https://d.example', { kind: 'ALLOW_ALL', fetchedAt: now });
  assert.equal(cache.size, 3); assert.equal(cache.get('https://b.example'), undefined); assert.notEqual(cache.get('https://a.example'), undefined); // b was least recently used
  cache.set('https://u.example', { kind: 'UNAVAILABLE', fetchedAt: now }); now = 101; assert.equal(cache.get('https://u.example'), undefined); // unavailable is remembered only briefly
  now = 1001; assert.equal(cache.get('https://a.example'), undefined);
});

test('limiter: per-host delay, per-minute cap, Crawl-delay, in-memory only', () => {
  let now = 1000; const limiter = new Limiter(1000, 3, () => now);
  assert.deepEqual(limiter.tryAcquire('a.example'), { ok: true }); assert.deepEqual(limiter.tryAcquire('a.example'), { ok: false, retryAfterSec: 1 });
  assert.deepEqual(limiter.tryAcquire('b.example'), { ok: true }); now += 1000; assert.deepEqual(limiter.tryAcquire('a.example'), { ok: true });
  assert.deepEqual(limiter.tryAcquire('c.example'), { ok: false, retryAfterSec: 59 }); // three requests inside the minute
  now += 60000; limiter.raiseDelay('a.example', 5000); assert.deepEqual(limiter.tryAcquire('a.example'), { ok: false, retryAfterSec: 5 });
});

test('digest: title, description, canonical, language, robots meta, links, text; scripts and styles dropped; entities decoded; bounded', () => {
  const html = `<!doctype html><html lang="en-GB"><head><title> Hello &amp; welcome </title><meta name="description" content="A  short   description"><meta name="robots" content="noindex, nofollow"><link rel="canonical" href="/canon#x"><base href="https://base.example/dir/"><style>p{color:red}</style><script>var x="<a href='https://evil.example'>";</script></head>
    <body><h1>Heading</h1><p>Some <b>bold</b> text &lt;here&gt; &#65;&#x42;<script>alert(1)</script>after</p><a href="page1?x=1#frag">one</a><a href="https://other.example/2" rel="nofollow">two</a><a href="mailto:a@b.c">m</a><a href="javascript:alert(1)">j</a><a href="ftp://x.example/f">f</a><a href="page1?x=1">dup</a><a href="http://u:p@cred.example/">c</a><noscript><a href="/hidden">h</a></noscript><!-- <a href="/comment"> --></body></html>`;
  const d = digestHtml(html, 'https://site.example/a/b', { maxTextBytes: 10240, maxLinks: 100 });
  assert.equal(d.title, 'Hello & welcome'); assert.equal(d.description, 'A short description'); assert.equal(d.language, 'en-GB'); assert.equal(d.canonicalUrl, 'https://base.example/canon');
  assert.deepEqual([d.noindex, d.nofollow, d.noarchive], [true, true, false]);
  assert.deepEqual(d.links, [{ url: 'https://base.example/dir/page1?x=1', nofollow: false }, { url: 'https://other.example/2', nofollow: true }]); // resolved against <base>, fragments removed, deduplicated, unsafe schemes and credentials dropped
  assert.match(d.text, /Heading Some bold text <here> ABafter/); assert.doesNotMatch(d.text, /alert|color:red|hidden|comment|evil/);
});

test('digest is bounded: text bytes, link count, tag count, unterminated markup, and plain text', () => {
  const big = `<html><body>${'<p>word </p>'.repeat(5000)}${'<a href="/l">x</a>'.repeat(3)}${Array.from({ length: 300 }, (_, i) => `<a href="/p${i}">x</a>`).join('')}</body></html>`;
  const d = digestHtml(big, 'https://x.example/', { maxTextBytes: 1000, maxLinks: 50 }); assert.ok(Buffer.byteLength(d.text) <= 1000); assert.equal(d.textTruncated, true); assert.equal(d.links.length, 50); assert.equal(d.linksTruncated, true);
  assert.equal(digestHtml('<p>a</p>', 'https://x.example/', { maxTextBytes: 0, maxLinks: 0 }).text, '');
  for (const evil of ['<', '<a', '<a href="', '<!--', '<script>', '<title>x', '<<<<>>>>', `<a ${'x=1 '.repeat(5000)}>`, '<a href="https://x.example/" '.repeat(1000)]) assert.doesNotThrow(() => digestHtml(evil, 'https://x.example/', { maxTextBytes: 100, maxLinks: 10 }), evil.slice(0, 20));
  const started = Date.now(); digestHtml('<div>'.repeat(200000), 'https://x.example/', { maxTextBytes: 1000, maxLinks: 10 }); assert.ok(Date.now() - started < 3000);
  const p = digestPlain('  line one\n\nline   two  '.repeat(1000), { maxTextBytes: 100 }); assert.ok(Buffer.byteLength(p.text) <= 100); assert.equal(p.textTruncated, true); assert.deepEqual(p.links, []);
  assert.equal(decodeEntities('&amp;&lt;&#0;&#xD800;&bogus;&#65;'), '&<  &bogus;A'); // invalid code points become a space, unknown names are left alone
});

test('contract: fetch input is strict, lowering-only and cannot express a proxy; the result is bounded; identity is validated', () => {
  assert.equal(FetchInputSchema.safeParse({ url: 'https://example.com/' }).success, true);
  for (const extra of [{ method: 'POST' }, { headers: { Cookie: 'a' } }, { proxy: 'http://p' }, { port: 8080 }, { ignoreRobots: true }, { allowPrivate: true }, { followCrossOrigin: true }, { body: 'x' }, { userAgent: 'x' }, { resolve: '1.2.3.4' }, { tls: { rejectUnauthorized: false } }])
    assert.equal(FetchInputSchema.safeParse({ url: 'https://example.com/', ...extra }).success, false, JSON.stringify(extra));
  for (const over of [{ maxRedirects: 4 }, { timeoutMs: 30001 }, { maxBodyBytes: 1048577 }, { maxLinks: 101 }, { maxTextBytes: 10241 }, { mode: 'HEAD' }, { mode: 'POST' }, { url: 'x' }])
    assert.equal(FetchInputSchema.safeParse({ url: 'https://example.com/', ...over }).success, false, JSON.stringify(over));
  for (const evil of [{ etag: 'a\r\nX: 1' }, { etag: '"a"\r\n' }, { lastModified: 'yesterday' }, { lastModified: 'Tue, 15 Nov 1994 08:12:31 GMT\r\nX: y' }]) assert.equal(FetchInputSchema.safeParse({ url: 'https://example.com/', validators: evil }).success, false);
  assert.equal(FETCH_OUTCOMES.length, 12);
  const ok = { outcome: 'FETCHED', requestedUrl: 'https://example.com/', redirects: [], fetchedAtMs: 1, durationMs: 1, robots: { verdict: 'ALLOWED' } };
  assert.equal(FetchOutputSchema.safeParse(ok).success, true); assert.equal(FetchOutputSchema.safeParse({ ...ok, extra: 1 }).success, false); assert.equal(FetchOutputSchema.safeParse({ ...ok, outcome: 'MAYBE' }).success, false);
  assert.equal(FetchOutputSchema.safeParse({ ...ok, page: { text: 'x'.repeat(10240), links: Array.from({ length: 100 }, (_, i) => ({ url: `https://example.com/${'p'.repeat(300)}${i}`, nofollow: false })), linksTruncated: false } }).success, false); // over the 28,000-byte budget
  assert.equal(FetchIdentitySchema.safeParse({ product: 'PrivaSearchBot', infoUrl: 'https://search.example/bot' }).success, true);
  for (const bad of [{ product: '1bot', infoUrl: 'https://a.example/' }, { product: 'bad bot', infoUrl: 'https://a.example/' }, { product: 'x'.repeat(33), infoUrl: 'https://a.example/' }, { product: 'Bot', infoUrl: 'http://a.example/' }, { product: 'Bot', infoUrl: 'https://u:p@a.example/' }, { product: 'Bot', infoUrl: 'not a url' }, { product: 'Bot', infoUrl: 'https://localhost/' }, { product: 'Bot', infoUrl: 'https://a.example/#x' }, { product: 'Bot', infoUrl: 'https://a.example/', extra: 1 }])
    assert.equal(FetchIdentitySchema.safeParse(bad).success, false, JSON.stringify(bad));
});

test('the fetch capability is registered with an honest estimate: short, stateless, preemptible, not checkpointable, identity required', () => {
  const d = JOB_TYPES['web.fetch.v1']; assert.equal(d.version, 1); assert.equal(requiresClientIdentity('web.fetch.v1'), true); assert.equal(requiresClientIdentity('system.echo.v1'), false);
  assert.deepEqual([d.resources.preemptible, d.resources.checkpointable, d.resources.diskBytes, d.resources.diskIo, d.resources.cpu], [true, false, 0, 'none', 'low']);
  assert.ok(d.resources.expectedDurationMs !== null && d.resources.expectedDurationMs <= 30000); assert.ok(d.resources.memoryBytes <= 64 * 1024 * 1024); // fits a legacy budget
});

test('truncation is linear-time and never splits a UTF-8 character (a large single text node must not stall the node)', () => {
  assert.equal(truncateUtf8('héllo wörld', 100), 'héllo wörld'); assert.equal(truncateUtf8('aé', 2), 'a'); assert.equal(truncateUtf8('a€b', 3), 'a'); assert.equal(truncateUtf8('a€b', 4), 'a€'); assert.equal(truncateUtf8('😀😀', 5), '😀'); assert.equal(truncateUtf8('abc', 0), '');
  const huge = 'word '.repeat(1_000_000); const started = Date.now();
  const d = digestHtml(huge, 'https://x.example/', { maxTextBytes: 10240, maxLinks: 10 }); const p = digestPlain(huge, { maxTextBytes: 10240 });
  assert.ok(Date.now() - started < 1500, `took ${Date.now() - started} ms`); assert.ok(Buffer.byteLength(d.text) <= 10240 && Buffer.byteLength(p.text) <= 10240); assert.equal(d.textTruncated && p.textTruncated, true);
  const multi = digestHtml(`<p>${'日本語のテキスト'.repeat(5000)}</p>`, 'https://x.example/', { maxTextBytes: 1000, maxLinks: 0 }); assert.ok(Buffer.byteLength(multi.text) <= 1000); assert.doesNotMatch(multi.text, /\ufffd/);
});
