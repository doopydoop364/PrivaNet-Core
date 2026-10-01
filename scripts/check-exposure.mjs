// Checks, from OUTSIDE, what a public Coordinator address exposes: `node tools/check-exposure.mjs https://node.example.com`
//
// Run it from a machine that is not the server (a laptop on mobile data is ideal), after setting up the public proxy (docs/PUBLIC_NODE.md). It sends only requests that carry no
// real credential (random bearer tokens, malformed bodies), verifies the certificate like any client (there is no option to skip that), and reports PASS / WARN / FAIL per check.
// Exit status: 0 nothing failed, 1 something failed, 78 bad usage.
//   --probe-limits   also guess random enrollment tokens and invite codes until the Coordinator answers 429, proving the guessing limits are on (this blocks YOUR address for about a minute)
//   --allow-application-api   do not warn that the application API (/v1/jobs, /v1/capabilities) is reachable (right for a LAN, wrong for a public name)
//   --json           machine-readable output        --timeout SECONDS (default 10)
import { connect } from 'node:tls';
import { randomBytes } from 'node:crypto';

const args = process.argv.slice(2); const flags = new Set(); let target; let timeoutSeconds = 10;
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--timeout') timeoutSeconds = Number(args[++i]);
  else if (['--probe-limits', '--allow-application-api', '--json'].includes(arg)) flags.add(arg);
  else if (!arg.startsWith('--') && target === undefined) target = arg;
  else { console.error(`unknown option ${arg.startsWith('--') ? arg.split('=')[0] : 'argument'}`); process.exit(78); }
}
let origin; let host; let port;
try {
  const url = new URL(target ?? ''); if (url.protocol !== 'https:' || url.username || url.password || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) throw new Error('no');
  origin = url.origin; host = url.hostname; port = Number(url.port || 443);
} catch { console.error('Usage: node check-exposure.mjs https://HOST[:PORT] [--probe-limits] [--allow-application-api] [--json] [--timeout SECONDS]\nThe address must be https: this tool never speaks plain http to the Coordinator, and never skips certificate verification.'); process.exit(78); }
if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 120) { console.error('--timeout is a number of seconds between 1 and 120'); process.exit(78); }

const results = []; const note = (id, label, status, detail) => results.push({ id, label, status, detail });
const randomToken = () => randomBytes(32).toString('hex'); const randomBearer = () => `Bearer ${randomToken()}`;
async function probe(method, path, { headers = {}, body, base = origin, redirect = 'manual' } = {}) {
  try {
    const response = await fetch(base + path, { method, redirect, headers: { 'x-privanet-protocol': '1', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body }), signal: AbortSignal.timeout(timeoutSeconds * 1000) });
    const text = (await response.text()).slice(0, 4096); let code;
    try { const parsed = JSON.parse(text); if (typeof parsed?.error?.code === 'string') code = parsed.error.code; } catch { /* not the Coordinator's JSON */ }
    return { status: response.status, code, location: response.headers.get('location') ?? '', hsts: response.headers.get('strict-transport-security') ?? '', text };
  } catch (error) { return { error: error?.cause?.code ?? error?.name ?? 'ERROR' }; }
}
const reachedAdmin = r => !r.error && (r.status >= 200 && r.status < 300 || r.code === 'UNAUTHORIZED_ADMIN');

// 1. Verified TLS and a healthy Coordinator.
const health = await probe('GET', '/v1/health');
if (health.error) { note('health', 'HTTPS health check', 'FAIL', `could not complete a verified request (${String(health.error).toLowerCase()}): ${/CERT|ISSUER|SIGNATURE|ALTNAME|TLS|SSL/.test(String(health.error)) ? 'the certificate is not accepted by this machine' : 'check DNS, the firewall and that the proxy is running'}`); }
else { let ok = false; try { ok = health.status === 200 && JSON.parse(health.text).status === 'ok'; } catch { /* not json */ } note('health', 'HTTPS health check', ok ? 'PASS' : 'FAIL', ok ? 'a verified TLS connection reached a healthy Coordinator' : `unexpected answer (${health.status})`); }
if (!health.error) note('hsts', 'Strict-Transport-Security', health.hsts ? 'PASS' : 'WARN', health.hsts ? health.hsts : 'the proxy does not send HSTS (public-routes.caddy does)');

// 2. Certificate expiry (verified handshake only).
await new Promise(done => {
  const socket = connect({ host, port, servername: /^[\d.:]+$/.test(host) ? '' : host, rejectUnauthorized: true, timeout: timeoutSeconds * 1000 }, () => {
    const cert = socket.getPeerCertificate(); const days = Math.floor((new Date(cert.valid_to).getTime() - Date.now()) / 86400000);
    note('certificate', 'Certificate', days < 0 ? 'FAIL' : days < 14 ? 'WARN' : 'PASS', `issued by ${cert.issuer?.CN ?? cert.issuer?.O ?? 'unknown'}, ${days} days left${days < 14 ? ' (automatic renewal should have happened by now: check Caddy\'s logs)' : ''}`); socket.destroy(); done();
  });
  socket.once('error', error => { note('certificate', 'Certificate', 'FAIL', `not accepted (${String(error.code ?? 'error').toLowerCase()})`); done(); });
  socket.once('timeout', () => { socket.destroy(); note('certificate', 'Certificate', 'FAIL', 'handshake timed out'); done(); });
});

// 3. Plain http must not serve the API (a redirect, or nothing listening, is right).
if (new URL(origin).port === '') {
  const plain = await probe('GET', '/v1/health', { base: `http://${host}` });
  if (plain.error) note('http', 'Plain http (port 80)', 'PASS', `not served (${String(plain.error).toLowerCase()})`);
  else if ([301, 302, 307, 308].includes(plain.status) && plain.location.startsWith('https://')) note('http', 'Plain http (port 80)', 'PASS', `redirects to https (${plain.status})`);
  else note('http', 'Plain http (port 80)', 'FAIL', `answered ${plain.status} over plain http; nothing should be served without TLS`);
} else note('http', 'Plain http (port 80)', 'INFO', 'not checked: the address names a port');

// 4. The administrator API must not be reachable, however the path is written.
const adminPaths = ['/v1/admin/nodes', '/v1/admin/enrollment-tokens', '/v1/admin/invites', '/v1/admin/requests', '/v1/admin/applications', '/v1/admin', '/v1/admin/'];
const variants = ['/V1/ADMIN/nodes', '//v1/admin/nodes', '/v1/node/../admin/nodes', '/v1/health/../admin/nodes', '/v1/./admin/nodes', '/v1/admin%2Fnodes', '/v1/%61dmin/nodes', '/v1/admin;x=1/nodes', '/v1/admin/nodes?x=1', '/v1/admin/nodes#x'];
const exposed = [];
for (const path of [...adminPaths, ...variants]) for (const method of ['GET', 'POST']) {
  for (const headers of [{ authorization: randomBearer() }, { authorization: randomBearer(), 'x-forwarded-for': '127.0.0.1', 'x-original-url': '/v1/admin/nodes', 'x-real-ip': '127.0.0.1' }]) {
    const r = await probe(method, path, { headers, ...(method === 'POST' ? { body: '{}' } : {}) });
    if (reachedAdmin(r)) exposed.push(`${method} ${path} -> ${r.status}${r.code ? ` ${r.code}` : ''}`);
  }
}
note('admin', 'Administrator API unreachable', exposed.length ? 'FAIL' : 'PASS', exposed.length ? `reached the Coordinator's administrator API: ${exposed.slice(0, 4).join('; ')}${exposed.length > 4 ? ` (+${exposed.length - 4} more)` : ''}. Fix the proxy before anything else.` : `${(adminPaths.length + variants.length)} paths (with traversal, case, encoding and forwarded-header tricks) never reached it`);

// 5. The application API belongs next to the Coordinator, not on the public name.
const apps = []; for (const path of ['/v1/jobs', '/v1/capabilities']) { const r = await probe(path === '/v1/jobs' ? 'POST' : 'GET', path, { headers: { authorization: randomBearer() }, ...(path === '/v1/jobs' ? { body: '{}' } : {}) }); if (!r.error && (r.code === 'UNAUTHORIZED_APPLICATION' || r.status >= 200 && r.status < 300)) apps.push(path); }
note('applications', 'Application API', apps.length === 0 ? 'PASS' : flags.has('--allow-application-api') ? 'INFO' : 'WARN', apps.length === 0 ? 'not reachable on this name' : `reachable (${apps.join(', ')}). Fine on a private LAN; on a public name applications should use the Coordinator's loopback address instead (public-routes.caddy blocks it)`);

// 6. Limits and shape.
const big = await probe('POST', '/v1/enrollment/challenge', { body: JSON.stringify({ junk: 'x'.repeat(100 * 1024) }) });
// Caddy 2.6 refuses an oversized body with 502, newer versions and the Coordinator itself with 413: either way it is refused, never accepted.
note('body', 'Oversized body', big.status === 413 || big.status === 502 ? 'PASS' : 'FAIL', big.error ? `no answer (${String(big.error).toLowerCase()})` : big.status === 413 || big.status === 502 ? `a 100 KiB body was refused (${big.status})` : `a 100 KiB body got ${big.status} (expected it to be refused with 413)`);
const unknown = await probe('GET', '/v1/definitely-not-a-route'); note('unknown', 'Unknown route', !unknown.error && unknown.status === 404 ? 'PASS' : 'FAIL', unknown.error ? String(unknown.error).toLowerCase() : `got ${unknown.status} (expected 404)`);
const wrongMethod = await probe('GET', '/v1/enrollment/challenge'); note('method', 'Wrong method on an enrollment route', !wrongMethod.error && wrongMethod.status >= 400 ? 'PASS' : 'FAIL', wrongMethod.error ? String(wrongMethod.error).toLowerCase() : `got ${wrongMethod.status}`);
const malformed = await probe('POST', '/v1/enrollment/challenge', { body: '{not json' }); note('malformed', 'Malformed enrollment request', !malformed.error && malformed.status >= 400 && malformed.status < 500 ? 'PASS' : 'FAIL', malformed.error ? String(malformed.error).toLowerCase() : `got ${malformed.status}`);

// 7. Guessing limits (opt-in: this deliberately gets this address refused).
if (flags.has('--probe-limits')) {
  const until = async (path, bodyFor, most) => { for (let i = 1; i <= most; i++) { const r = await probe('POST', path, { body: JSON.stringify(bodyFor()) }); if (!r.error && r.status === 429) return i; if (!r.error && r.status === 404) return 'absent'; } return 0; };
  const key = 'MCowBQYDK2VwAyEA' + randomBytes(32).toString('base64').slice(0, 43) + '=';
  const tokens = await until('/v1/enrollment/challenge', () => ({ token: randomToken(), publicKey: key, protocolVersion: 1, daemonVersion: '0.3.0', capabilities: [] }), 40);
  note('limit-token', 'Enrollment token guessing is limited', tokens === 0 ? 'FAIL' : 'PASS', tokens === 0 ? 'forty wrong tokens in a row were all answered normally' : `refused with 429 after ${tokens} wrong tokens`);
  const codes = await until('/v1/invites/challenge', () => ({ code: Array.from(randomBytes(8), b => 'ABCDEFGHJKMNPQRSTVWXYZ0123456789'[b % 32]).join(''), publicKey: key, protocolVersion: 1, daemonVersion: '0.3.0' }), 25);
  note('limit-invite', 'Invite code guessing is limited', codes === 'absent' ? 'INFO' : codes === 0 ? 'FAIL' : 'PASS', codes === 'absent' ? 'this Coordinator has no invites' : codes === 0 ? 'twenty-five wrong codes in a row were all answered normally' : `refused with 429 after ${codes} wrong codes`);
} else note('limits', 'Guessing limits', 'INFO', 'not probed (add --probe-limits)');

const failed = results.some(r => r.status === 'FAIL');
if (flags.has('--json')) console.log(JSON.stringify({ ok: !failed, target: origin, results }));
else {
  console.log(`Exposure check: ${origin}\n`); for (const r of results) console.log(`  ${r.status.padEnd(5)} ${r.label.padEnd(40)} ${r.detail}`);
  console.log(failed ? '\nFAILED: fix the lines marked FAIL (the first one that mentions the administrator API is the urgent one).' : '\nNothing failed.');
}
process.exitCode = failed ? 1 : 0;
