import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { spawn } from 'node:child_process';
import { createServer, connect } from 'node:net';
import { Script } from 'node:vm';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
/* eslint-disable @typescript-eslint/no-explicit-any -- replies are inspected as loose JSON */
import { PrivaNode } from '@privanet/node/daemon';
import { ResourceEngine } from '@privanet/node/resource-engine';
import { ResourcePolicySchema, defaultResourcePolicy } from '@privanet/node/resource-policy';
import type { HostSample } from '@privanet/node/resource-sampler';
import { LocalControl } from '@privanet/node/local-control';
import { LogRing } from '@privanet/node/log-ring';
import { ResourceHistory } from '@privanet/node/history';
import { startPanel, PANEL_BODY_LIMIT } from '@privanet/node/panel';
import type { PanelHandle } from '@privanet/node/panel';
import { PANEL_TOKEN_FILE, loadOrCreatePanelToken } from '@privanet/node/panel-token';
import { renderPage } from '@privanet/node/panel-page';
import { POLICY_FILE } from '@privanet/node/policy-store';

const GiB = 1024 ** 3; const posix = process.platform !== 'win32';
const root = fileURLToPath(new URL('../../', import.meta.url));
const NODE_MAIN = join(root, 'apps', 'node', 'dist', 'main.js');
interface Reply { status: number; headers: Record<string, string | string[] | undefined>; text: string; json: () => Record<string, any> }
function call(port: number, method: string, path: string, options: { headers?: Record<string, string>; body?: string | Buffer; host?: string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers: { host: options.host ?? `127.0.0.1:${port}`, ...(options.headers ?? {}) } }, res => {
      let text = ''; res.on('data', (chunk: Buffer) => { text += chunk.toString(); });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json: () => JSON.parse(text) }));
    });
    req.on('error', reject); req.end(options.body);
  });
}
async function rig(t: TestContext, options: { clock?: () => number; actions?: { drainAndStop: () => void; restart: () => void }; policyLocked?: boolean; slotsFromEnvironment?: boolean; env?: NodeJS.ProcessEnv } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'privanet-panel-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const state = join(dir, 'state'); await mkdir(state, { mode: 0o700 }); await chmod(state, 0o700);
  const host: HostSample = { availableMemoryBytes: 12 * GiB, ownerCpuPercent: 3, power: 'AC', freeDiskBytes: 100 * GiB };
  const policy = ResourcePolicySchema.parse({ maxMemoryBytes: 8 * GiB });
  const engine = new ResourceEngine(policy, { sample: () => ({ ...host }) });
  const node = new PrivaNode({ url: 'https://127.0.0.1:9', stateDir: state, capabilities: ['system.echo.v1', 'web.fetch.v1'], engine });
  const history = new ResourceHistory(state); const control = new LocalControl({ stateDir: state, node, engine, history, jobSlots: { running: 1, fromEnvironment: options.slotsFromEnvironment === true }, ...(options.policyLocked ? { policyLocked: true } : {}) });
  await control.init({ policy, source: { kind: 'defaults' } }); engine.update();
  const calls = { drain: 0, restart: 0 }; const actions = options.actions ?? { drainAndStop: () => { calls.drain++; }, restart: () => { calls.restart++; } };
  const logs = new LogRing(); logs.push({ event: 'node.authenticated' });
  const panel = await startPanel({ stateDir: state, port: 0, node, engine, control, history, logs, coordinatorUrl: 'http://127.0.0.1:1', enrolledCapabilities: ['system.echo.v1', 'web.fetch.v1'], jobSlots: 1,
    env: { PRIVANODE_ALLOW_INSECURE_LOOPBACK: 'true', ...(options.env ?? {}) }, actions, ...(options.clock ? { clock: options.clock } : {}),
    supportBundle: async () => ({ ok: true }), updateCheck: async () => ({ message: 'up to date' }) });
  t.after(() => panel.close());
  const origin = `http://127.0.0.1:${panel.port}`;
  const login = async (): Promise<{ cookie: string; csrf: string }> => {
    const response = await call(panel.port, 'POST', '/api/login', { headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ token: panel.token }) });
    assert.equal(response.status, 200, response.text);
    const cookie = String(response.headers['set-cookie']).split(';')[0] ?? '';
    const session = await call(panel.port, 'GET', '/api/session', { headers: { cookie } }); assert.equal(session.status, 200);
    return { cookie, csrf: session.json().csrf as string };
  };
  const post = (session: { cookie: string; csrf: string }, path: string, body: unknown, extra: Record<string, string> = {}) =>
    call(panel.port, 'POST', path, { headers: { cookie: session.cookie, 'x-csrf-token': session.csrf, 'content-type': 'application/json', origin, ...extra }, body: JSON.stringify(body) });
  const get = (session: { cookie: string }, path: string) => call(panel.port, 'GET', path, { headers: { cookie: session.cookie } });
  return { dir, state, panel, origin, login, post, get, calls, control, engine, node, history, logs };
}
const API_GETS = ['/api/session', '/api/status', '/api/policy', '/api/settings', '/api/storage', '/api/jobs', '/api/history', '/api/logs', '/api/privacy'];

test('the panel listens on loopback only, on a numeric loopback address, and not on any other interface', async t => {
  const r = await rig(t);
  assert.equal(r.panel.address, '127.0.0.1');
  for (const list of Object.values(networkInterfaces())) for (const iface of list ?? []) {
    if (iface.internal || iface.family !== 'IPv4') continue;
    const reachable = await new Promise<boolean>(resolve => { const socket = connect({ host: iface.address, port: r.panel.port }, () => { socket.destroy(); resolve(true); }); socket.once('error', () => resolve(false)); });
    assert.equal(reachable, false, `must not be reachable on ${iface.address}`);
  }
});

test('Host header abuse (DNS rebinding) is refused; the loopback names are accepted', async t => {
  const r = await rig(t);
  for (const host of ['evil.example', `evil.example:${r.panel.port}`, `127.0.0.1.evil.example:${r.panel.port}`, '127.0.0.1', `127.0.0.1:${r.panel.port + 1}`, `[::1]:${r.panel.port}`]) {
    const response = await call(r.panel.port, 'GET', '/', { host }); assert.equal(response.status, 421, `Host ${host}`);
  }
  assert.equal((await call(r.panel.port, 'GET', '/', { host: `localhost:${r.panel.port}` })).status, 200);
  assert.equal((await call(r.panel.port, 'GET', '/')).status, 200);
});

test('every API route needs a signed-in session, reads included; the page itself carries no data', async t => {
  const r = await rig(t);
  for (const path of API_GETS) { const response = await call(r.panel.port, 'GET', path); assert.equal(response.status, 401, path); assert.equal(response.json().error.code, 'LOGIN_REQUIRED'); }
  const forged = `privanet_panel=${'a'.repeat(64)}`;
  for (const path of API_GETS) assert.equal((await call(r.panel.port, 'GET', path, { headers: { cookie: forged } })).status, 401);
  assert.equal((await call(r.panel.port, 'GET', '/api/status', { headers: { cookie: 'privanet_panel=not-hex' } })).status, 401);
  const page = await call(r.panel.port, 'GET', '/'); assert.equal(page.status, 200);
  for (const leaked of [r.panel.token, 'node_', 'Garage', 'privateKey', 'canary']) assert.equal(page.text.includes(leaked), false, leaked);
  const session = await r.login();
  for (const path of API_GETS) assert.equal((await r.get(session, path)).status, 200, path);
});

test('login: constant-form refusals, a per-minute failure limit that also stops the right token, an HttpOnly SameSite cookie, and JSON plus Origin required', async t => {
  let now = 1_000_000; const r = await rig(t, { clock: () => now });
  const body = (token: string) => JSON.stringify({ token });
  const attempt = (token: string, headers: Record<string, string> = {}) => call(r.panel.port, 'POST', '/api/login', { headers: { 'content-type': 'application/json', origin: r.origin, ...headers }, body: body(token) });
  assert.equal((await attempt('0'.repeat(64))).status, 401);
  assert.equal((await attempt('short')).status, 401, 'a malformed token is just refused');
  assert.equal((await attempt(r.panel.token, { origin: 'http://evil.example' })).status, 403);
  const text = await call(r.panel.port, 'POST', '/api/login', { headers: { 'content-type': 'text/plain', origin: r.origin }, body: body(r.panel.token) }); assert.equal(text.status, 415);
  for (let i = 0; i < 3; i++) await attempt('1'.repeat(64));
  const limited = await attempt(r.panel.token); assert.equal(limited.status, 429, 'five failures in a minute: even the right token waits');
  now += 61000;
  const good = await attempt(r.panel.token); assert.equal(good.status, 200);
  const cookie = String(good.headers['set-cookie']); assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/); assert.match(cookie, /Path=\//);
  assert.equal(good.text.includes(r.panel.token), false);
});

test('state changes need the CSRF token, this panel\'s Origin, a JSON content type and a small strict body', async t => {
  const r = await rig(t); const s = await r.login();
  const bare = (headers: Record<string, string>, body = JSON.stringify({ kind: '15m' })) => call(r.panel.port, 'POST', '/api/pause', { headers: { cookie: s.cookie, ...headers }, body });
  assert.equal((await bare({ 'content-type': 'application/json', origin: r.origin })).status, 403, 'no CSRF token');
  assert.equal((await bare({ 'content-type': 'application/json', origin: r.origin, 'x-csrf-token': 'wrong' })).status, 403);
  assert.equal((await bare({ 'content-type': 'application/json', 'x-csrf-token': s.csrf })).status, 403, 'no Origin');
  for (const origin of ['http://evil.example', `http://127.0.0.1:${r.panel.port + 1}`, 'null', `https://127.0.0.1:${r.panel.port}`]) assert.equal((await bare({ 'content-type': 'application/json', origin, 'x-csrf-token': s.csrf })).status, 403, `Origin ${origin}`);
  assert.equal((await bare({ 'content-type': 'text/plain', origin: r.origin, 'x-csrf-token': s.csrf })).status, 415, 'a form-style type is refused');
  assert.equal((await bare({ 'content-type': 'application/x-www-form-urlencoded', origin: r.origin, 'x-csrf-token': s.csrf }, 'kind=15m')).status, 415);
  assert.equal((await bare({ 'content-type': 'application/json', origin: r.origin, 'x-csrf-token': s.csrf }, '{not json')).status, 400);
  assert.equal((await bare({ 'content-type': 'application/json', origin: r.origin, 'x-csrf-token': s.csrf }, JSON.stringify({ kind: '15m', extra: 1 }))).status, 400, 'strict schema');
  assert.equal((await bare({ 'content-type': 'application/json', origin: r.origin, 'x-csrf-token': s.csrf }, JSON.stringify({ kind: 'rm -rf /' }))).status, 400);
  const huge = await bare({ 'content-type': 'application/json', origin: r.origin, 'x-csrf-token': s.csrf }, JSON.stringify({ kind: '15m', pad: 'x'.repeat(PANEL_BODY_LIMIT + 1000) }));
  assert.equal(huge.status, 413); assert.equal(r.control.view.pause, undefined, 'nothing changed');
  assert.equal((await r.post(s, '/api/pause', { kind: '15m' })).status, 200);
  const other = await r.login(); assert.equal((await call(r.panel.port, 'POST', '/api/pause', { headers: { cookie: s.cookie, 'x-csrf-token': other.csrf, 'content-type': 'application/json', origin: r.origin }, body: '{"kind":"1h"}' })).status, 403, 'a token from another session does not work');
});

test('no response carries a CORS header, and only GET and POST are accepted', async t => {
  const r = await rig(t); const s = await r.login();
  for (const method of ['PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD', 'TRACE', 'CONNECT']) { const response = await call(r.panel.port, method, '/api/status', { headers: { cookie: s.cookie, origin: 'http://evil.example' } }).catch(() => ({ status: 0, headers: {}, text: '', json: () => ({}) })); assert.ok([405, 0].includes(response.status), `${method} -> ${response.status}`); }
  for (const path of ['/', ...API_GETS]) {
    const response = await call(r.panel.port, 'GET', path, { headers: { cookie: s.cookie, origin: 'http://evil.example' } });
    for (const name of Object.keys(response.headers)) assert.equal(name.startsWith('access-control-'), false, `${path}: ${name}`);
  }
  const preflight = await call(r.panel.port, 'OPTIONS', '/api/pause', { headers: { origin: 'http://evil.example', 'access-control-request-method': 'POST' } }); assert.equal(preflight.status, 405);
});

test('the page is served with a strict CSP and nothing that could run arbitrary code or load anything remote', async t => {
  const r = await rig(t);
  const a = await call(r.panel.port, 'GET', '/'); const b = await call(r.panel.port, 'GET', '/login');
  const csp = String(a.headers['content-security-policy']);
  for (const directive of ["default-src 'none'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'none'", "connect-src 'self'"]) assert.ok(csp.includes(directive), directive);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|\*/);
  const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1] ?? ''; assert.ok(nonce.length >= 16); assert.ok(a.text.includes(`nonce="${nonce}"`));
  assert.notEqual(nonce, /script-src 'nonce-([^']+)'/.exec(String(b.headers['content-security-policy']))?.[1], 'a fresh nonce for every response');
  assert.equal(a.headers['x-content-type-options'], 'nosniff'); assert.equal(a.headers['x-frame-options'], 'DENY'); assert.match(String(a.headers['cache-control']), /no-store/); assert.equal(a.headers['referrer-policy'], 'no-referrer');
  const page = renderPage('NONCE');
  for (const forbidden of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function', 'setTimeout("', 'setInterval("']) assert.equal(page.includes(forbidden), false, forbidden);
  assert.doesNotMatch(page, /(?:src|href)=["']?https?:/i, 'no remote resources'); assert.doesNotMatch(page, /<script[^>]+src=/i); assert.doesNotMatch(page, /\son[a-z]+=/i, 'no inline event handlers');
});

test('the page\'s script compiles, and it uses no inline style (which the CSP would block)', () => {
  const page = renderPage('NONCE');
  const script = /<script nonce="NONCE">([\s\S]*)<\/script>/.exec(page)?.[1] ?? '';
  assert.ok(script.length > 1000);
  assert.doesNotThrow(() => new Script(script, { filename: 'panel-page.js' }), 'a syntax error would leave the panel blank');
  assert.doesNotMatch(script, /style:\s*['"]|setAttribute\(['"]style['"]/, 'an inline style attribute is blocked by style-src');
  assert.doesNotMatch(page.replace(/<style[\s\S]*?<\/style>/, ''), /\sstyle=/);
});

test('there is no way to run a command, read or write a file, fetch a URL, or see the environment, a key or a credential', async t => {
  const r = await rig(t); const s = await r.login();
  process.env.PANEL_CANARY_SECRET = 'canary-env-secret-123'; t.after(() => { delete process.env.PANEL_CANARY_SECRET; });
  await writeFile(join(r.state, 'identity.json'), JSON.stringify({ privateKey: 'CANARY-PRIVATE-KEY-MATERIAL', publicKey: 'x' }), { mode: 0o600 });
  await writeFile(join(r.state, 'enrollment.json'), JSON.stringify({ token: 'CANARY-ENROLLMENT-TOKEN' }), { mode: 0o600 });
  for (const path of ['/api/env', '/api/environment', '/api/file?path=/etc/passwd', '/api/read?file=identity.json', '/api/exec', '/api/shell', '/api/command', '/api/fetch?url=http://127.0.0.1:1/', '/api/proxy', '/api/identity', '/api/key', '/api/keys', '/api/config', '/api/token', '/api/enrollment', '/api/secrets', '/api/admin', '/api/state', '/api/files', '/api/log-file', '/api/download?file=identity.json']) {
    const response = await r.get(s, path); assert.equal(response.status, 404, path);
  }
  for (const path of ['/api/exec', '/api/shell', '/api/run', '/api/command', '/api/service', '/api/file', '/api/write', '/api/install', '/api/update/install', '/api/eval']) {
    assert.equal((await r.post(s, path, { command: 'id', file: '/etc/passwd', path: '/tmp/x', url: 'http://x' })).status, 404, path);
  }
  for (const path of ['/api/../../etc/passwd', '/%2e%2e/%2e%2e/etc/passwd', '//etc/passwd', '/api/%2e%2e/identity.json', '/api/status/../../../etc/hosts', '/..%2f..%2fetc/passwd', '/static/../identity.json']) {
    const response = await call(r.panel.port, 'GET', path, { headers: { cookie: s.cookie } }); assert.ok([400, 404].includes(response.status), `${path} -> ${response.status}`); assert.equal(/root:|CANARY/.test(response.text), false);
  }
  const everything = [] as string[];
  for (const path of API_GETS) everything.push((await r.get(s, path)).text);
  everything.push((await r.get(s, '/api/status?fullId=1')).text);
  everything.push((await r.post(s, '/api/doctor', {})).text); everything.push((await r.post(s, '/api/support-bundle', {})).text);
  const joined = everything.join('\n');
  for (const secret of ['CANARY-PRIVATE-KEY-MATERIAL', 'CANARY-ENROLLMENT-TOKEN', 'canary-env-secret-123', r.panel.token, s.cookie.split('=')[1] ?? 'x', 'privateKey', 'authorization', 'Bearer ']) assert.equal(joined.includes(secret), false, `leaked: ${secret}`);
});

test('the actions are a short fixed list; drain and restart need explicit confirmation and call only their own named operation', async t => {
  const r = await rig(t); const s = await r.login();
  assert.equal((await r.post(s, '/api/drain', {})).status, 400); assert.equal((await r.post(s, '/api/drain', { confirm: false })).status, 400); assert.equal((await r.post(s, '/api/restart', { confirm: 'yes' })).status, 400);
  assert.equal(r.calls.drain + r.calls.restart, 0);
  assert.equal((await r.post(s, '/api/drain', { confirm: true })).status, 200); await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(r.calls, { drain: 1, restart: 0 });
  assert.equal((await r.post(s, '/api/restart', { confirm: true })).status, 200); await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(r.calls, { drain: 1, restart: 1 });
});

test('pause, resume, presets, saved policy, name and capabilities work through the panel and use the same files as the CLI', async t => {
  const r = await rig(t); const s = await r.login();
  assert.equal((await r.post(s, '/api/pause', { kind: '1h' })).status, 200); r.engine.update();
  assert.equal(r.engine.report.contribution, 'PAUSED'); assert.equal((await r.get(s, '/api/status')).json().contribution.pause.kind, 'timed');
  assert.equal((await r.post(s, '/api/resume', {})).status, 200); r.engine.update(); assert.equal(r.engine.report.contribution, 'ADAPTIVE');
  const preset = await r.post(s, '/api/policy', { preset: 'generous' }); assert.equal(preset.status, 200);
  const policy = (await r.get(s, '/api/policy')).json(); assert.equal(policy.preset, 'generous'); assert.equal(policy.source.kind, 'saved'); assert.ok(Array.isArray(policy.presets) && policy.presets.length === 4);
  assert.equal((await readFile(join(r.state, POLICY_FILE), 'utf8')).includes('"preset": "generous"'), true);
  const edited = { ...policy.policy, maxCpuPercent: 42 }; const saved = await r.post(s, '/api/policy', { policy: edited }); assert.equal(saved.status, 200);
  assert.equal((await r.get(s, '/api/policy')).json().preset, 'custom', 'one changed value is Custom');
  const invalid = await r.post(s, '/api/policy', { policy: { ...policy.policy, maxCpuPercent: 500 } }); assert.equal(invalid.status, 422); assert.ok(invalid.json().error.issues.some((issue: string) => issue.startsWith('maxCpuPercent')));
  const unsafe = await r.post(s, '/api/policy', { policy: { ...policy.policy, fetch: { ...policy.policy.fetch, unsafeLocal: { allowedCidrs: ['10.0.0.0/8'] } } } }); assert.equal(unsafe.status, 422);
  assert.equal((await r.get(s, '/api/policy')).json().policy.maxCpuPercent, 42, 'rejected changes changed nothing');
  assert.equal((await readdir(r.state)).some(name => name.endsWith('.tmp')), false);
  assert.equal((await r.post(s, '/api/policy', { preset: 'turbo' })).status, 400); assert.equal((await r.post(s, '/api/policy', { policy: 'x' })).status, 400); assert.equal((await r.post(s, '/api/policy', { reset: true })).status, 200);
  assert.equal((await r.post(s, '/api/name', { name: 'Garage PC' })).status, 200); assert.equal((await r.get(s, '/api/status')).json().node.localName, 'Garage PC');
  assert.equal((await r.post(s, '/api/name', { name: 'bad\nname' })).status, 400); assert.equal((await r.post(s, '/api/name', { name: null })).status, 200);
  const slots = await r.get(s, '/api/policy'); assert.deepEqual([slots.json().jobSlots.editable, slots.json().jobSlots.source, slots.json().jobSlots.max], [true, 'default', 64]);
  const saved4 = await r.post(s, '/api/jobslots', { slots: 4 }); assert.equal(saved4.status, 200); assert.deepEqual(saved4.json().restartRequired, ['job slots']); assert.equal((await r.get(s, '/api/policy')).json().jobSlots.saved, 4);
  for (const bad of [0, 65, 1.5, 'x', undefined]) assert.equal((await r.post(s, '/api/jobslots', { slots: bad })).status, 400, String(bad)); assert.equal((await r.post(s, '/api/jobslots', { slots: 2, extra: 1 })).status, 400);
  assert.equal((await r.post(s, '/api/jobslots', { slots: null })).status, 200); assert.equal((await r.get(s, '/api/policy')).json().jobSlots.saved, null);
  assert.equal((await r.post(s, '/api/capabilities', { disabled: ['web.fetch.v1'] })).status, 200); assert.deepEqual(r.node.capabilities, ['system.echo.v1']);
  assert.deepEqual((await r.get(s, '/api/status')).json().capabilities, [{ id: 'system.echo.v1', enabled: true }, { id: 'web.fetch.v1', enabled: false }]);
  assert.equal((await r.post(s, '/api/capabilities', { disabled: ['system.rm.v1'] })).status, 400);
  assert.equal((await r.post(s, '/api/capabilities', { disabled: [] })).status, 200);
});

test('the doctor runs from the panel, changes nothing and shows a failing stage with a next step; the status shows the three names separately', async t => {
  const r = await rig(t); const s = await r.login();
  const before = (await readdir(r.state)).sort();
  const response = await r.post(s, '/api/doctor', {}); assert.equal(response.status, 200); const report = response.json();
  assert.equal(report.ok, false); const tcp = report.stages.find((stage: { id: string }) => stage.id === 'tcp'); assert.equal(tcp.status, 'FAILED'); assert.ok(tcp.advice.length > 10);
  assert.deepEqual((await readdir(r.state)).filter(name => !before.includes(name) && !/\.tmp$/.test(name)), [], 'the doctor created nothing');
  const status = (await r.get(s, '/api/status')).json(); assert.ok('localName' in status.node && 'coordinatorLabel' in status.node && 'id' in status.node);
});

test('sessions end: sign-out removes the cookie\'s power, and a session expires after twelve hours', async t => {
  let now = 5_000_000; const r = await rig(t, { clock: () => now }); const s = await r.login();
  assert.equal((await r.get(s, '/api/status')).status, 200);
  now += 11 * 3600000; assert.equal((await r.get(s, '/api/status')).status, 200);
  now += 2 * 3600000; assert.equal((await r.get(s, '/api/status')).status, 401, 'expired');
  const again = await r.login(); assert.equal((await r.post(again, '/api/logout', {})).status, 200); assert.equal((await r.get(again, '/api/status')).status, 401);
});

test('the panel token is private, persistent and 256 bits; a taken port is an error the node can survive', async t => {
  const r = await rig(t);
  const token = await loadOrCreatePanelToken(r.state); assert.match(token, /^[a-f0-9]{64}$/); assert.equal(token, r.panel.token); assert.equal(await loadOrCreatePanelToken(r.state), token);
  if (posix) assert.equal((await stat(join(r.state, PANEL_TOKEN_FILE))).mode & 0o777, 0o600);
  const blocker = createServer(); await new Promise<void>(resolve => blocker.listen(0, '127.0.0.1', resolve)); t.after(() => { blocker.close(); });
  const taken = (blocker.address() as { port: number }).port;
  let second: PanelHandle | undefined;
  await assert.rejects((async () => { second = await startPanel({ stateDir: r.state, port: taken, node: r.node, engine: r.engine, control: r.control, logs: r.logs, coordinatorUrl: 'http://127.0.0.1:1', enrolledCapabilities: [], jobSlots: 1, env: {}, actions: { drainAndStop: () => undefined, restart: () => undefined } }); })(), /EADDRINUSE/);
  assert.equal(second, undefined);
});

test('defaults: the policy a fresh node serves is the conservative one', async t => {
  const r = await rig(t); const s = await r.login(); const policy = (await r.get(s, '/api/policy')).json();
  assert.equal(policy.policy.maxCpuPercent, defaultResourcePolicy().maxCpuPercent);
});

// ---- the real program ----
async function freePort(): Promise<number> { const server = createServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const port = (server.address() as { port: number }).port; await new Promise<void>(resolve => server.close(() => resolve())); return port; }
const cliRun = (args: string[], env: NodeJS.ProcessEnv) => new Promise<{ code: number; out: string; err: string }>(resolve => {
  const child = spawn(process.execPath, [NODE_MAIN, ...args], { cwd: root, env: { PATH: process.env.PATH ?? '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] }); let out = ''; let err = '';
  child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString(); }); child.stderr.on('data', (chunk: Buffer) => { err += chunk.toString(); }); child.once('close', code => resolve({ code: code ?? -1, out, err }));
});
async function until(what: string, check: () => boolean | Promise<boolean>, ms = 20000) { const deadline = Date.now() + ms; while (!(await check())) { if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`); await new Promise(resolve => setTimeout(resolve, 100)); } }

test('the real node program serves the panel on loopback, `status` and `pause` work from the shell and reach the running node, a taken port does not stop a node, and "drain and stop" ends the process', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'privanet-panel-proc-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const state = join(dir, 'state'); await mkdir(state, { mode: 0o700 }); await chmod(state, 0o700);
  const port = await freePort(); const env = { PRIVANODE_COORDINATOR_URL: 'https://127.0.0.1:9', PRIVANODE_CAPABILITIES: 'system.echo.v1', PRIVANODE_STATE_DIR: state, PRIVANODE_PANEL_PORT: String(port), PRIVANODE_POLL_MS: '200', PRIVANODE_HEARTBEAT_MS: '200' };
  const child = spawn(process.execPath, [NODE_MAIN], { cwd: root, env: { PATH: process.env.PATH ?? '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] }); let out = ''; let err = '';
  child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString(); }); child.stderr.on('data', (chunk: Buffer) => { err += chunk.toString(); });
  const exited = new Promise<number>(resolve => child.once('close', code => resolve(code ?? -1))); t.after(() => { child.kill('SIGKILL'); });
  await until('the panel', () => out.includes('panel.listening'));
  const url = (await cliRun(['panel', '--url-only', '--state-dir', state], env)).out.trim(); assert.equal(url, `http://127.0.0.1:${port}/`);
  const link = (await cliRun(['panel', '--state-dir', state], env)).out; const token = /#([a-f0-9]{64})/.exec(link)?.[1] ?? ''; assert.ok(token);
  assert.equal(out.includes(token) || err.includes(token), false, 'the token is never in the node\'s logs');
  const origin = `http://127.0.0.1:${port}`;
  const login = await call(port, 'POST', '/api/login', { headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ token }) }); assert.equal(login.status, 200);
  const cookie = String(login.headers['set-cookie']).split(';')[0] ?? '';
  const status = (await call(port, 'GET', '/api/status', { headers: { cookie } })).json(); assert.ok(['connecting', 'offline'].includes(status.connection.state)); assert.ok(status.idle.reasons.length > 0);
  await until('the shell status', async () => (await cliRun(['status', '--json', '--state-dir', state], env)).code === 0, 30000);
  const shell = JSON.parse((await cliRun(['status', '--json', '--state-dir', state], env)).out); assert.equal(shell.running, true); assert.equal(shell.contribution.mode.length > 0, true);
  assert.equal((await cliRun(['pause', 'indefinite', '--state-dir', state], env)).code, 0);
  await until('the pause to reach the running node', async () => (await call(port, 'GET', '/api/status', { headers: { cookie } })).json().contribution.pause?.kind === 'indefinite');
  assert.equal((await cliRun(['resume', '--state-dir', state], env)).code, 0);
  await until('the resume', async () => (await call(port, 'GET', '/api/status', { headers: { cookie } })).json().contribution.pause === null);
  // A second node on the same port keeps running without a panel.
  const state2 = join(dir, 'state2'); await mkdir(state2, { mode: 0o700 }); await chmod(state2, 0o700);
  const second = spawn(process.execPath, [NODE_MAIN], { cwd: root, env: { PATH: process.env.PATH ?? '', ...env, PRIVANODE_STATE_DIR: state2 }, stdio: ['ignore', 'pipe', 'pipe'] }); let out2 = ''; second.stdout.on('data', (chunk: Buffer) => { out2 += chunk.toString(); });
  const second1 = new Promise<number>(resolve => second.once('close', code => resolve(code ?? -1))); t.after(() => { second.kill('SIGKILL'); });
  await until('the second node to report no panel', () => out2.includes('panel.unavailable')); assert.equal(second.exitCode, null, 'it keeps running');
  second.kill('SIGTERM'); await second1;
  const session = (await call(port, 'GET', '/api/session', { headers: { cookie } })).json();
  const bundle = await call(port, 'POST', '/api/support-bundle', { headers: { cookie, 'x-csrf-token': session.csrf, 'content-type': 'application/json', origin }, body: '{}' });
  assert.equal(bundle.status, 200); assert.match(String(bundle.headers['content-disposition']), /attachment/);
  const bundleBody = bundle.json(); assert.ok(bundleBody.software); assert.ok(Array.isArray(bundleBody.recentEvents) && bundleBody.recentEvents.length > 0);
  for (const secretLike of [token, cookie.split('=')[1] ?? 'x', session.csrf as string, 'privateKey']) assert.equal(bundle.text.includes(secretLike), false, 'no secret in the panel\'s bundle');
  const drain = await call(port, 'POST', '/api/drain', { headers: { cookie, 'x-csrf-token': session.csrf, 'content-type': 'application/json', origin }, body: JSON.stringify({ confirm: true }) }); assert.equal(drain.status, 200);
  const code = await exited; assert.equal(code, 0, `the node stopped cleanly after "drain and stop" (${err.slice(0, 200)})`);
});

test('settings: the panel reports where each value comes from, and says plainly what the environment locks', async t => {
  const r = await rig(t, { slotsFromEnvironment: true, env: { PRIVANODE_JOB_SLOTS: '1', PRIVANODE_COORDINATOR_URL: 'https://coordinator.example.org', PRIVANODE_PANEL_PORT: '4999' } }); const s = await r.login();
  const settings = (await r.get(s, '/api/settings')).json();
  assert.deepEqual([settings.jobSlots.source, settings.jobSlots.locked, settings.coordinator.source, settings.coordinator.host, settings.coordinator.editableHere, settings.panel.source, settings.panel.port, settings.updates.automatic], ['environment', true, 'environment', 'coordinator.example.org', false, 'environment', 4999, false]);
  assert.equal((await r.post(s, '/api/jobslots', { slots: 5 })).status, 409, 'the panel does not pretend it can change a locked value'); assert.equal((await r.post(s, '/api/jobslots', { slots: 5 })).json().error.code, 'JOB_SLOTS_SET_BY_ENVIRONMENT');
  assert.equal((await r.get(s, '/api/policy')).json().jobSlots.editable, false);
  assert.doesNotMatch(JSON.stringify(settings), /token|secret|password/i);
});

test('a locked policy: shown, not editable from the panel, nothing written, and the saved file is not used', async t => {
  const r = await rig(t, { policyLocked: true, env: { PRIVANODE_POLICY_LOCKED: 'true' } }); const s = await r.login();
  assert.equal((await r.get(s, '/api/policy')).json().locked, true);
  for (const body of [{ preset: 'generous' }, { reset: true }, { policy: (await r.get(s, '/api/policy')).json().policy }]) { const reply = await r.post(s, '/api/policy', body); assert.equal(reply.status, 409, JSON.stringify(body)); assert.equal(reply.json().error.code, 'POLICY_LOCKED_BY_ENVIRONMENT'); }
  assert.equal((await readdir(r.state)).includes('policy.json'), false, 'nothing was saved');
  assert.equal((await r.get(s, '/api/settings')).json().policy.locked, true);
});

test('a damaged local-state.json is reported with a fixed code and a next step, nothing is changed, and the page shows it', async t => {
  const r = await rig(t); const s = await r.login(); await writeFile(join(r.state, 'local-state.json'), '{broken', { mode: 0o600 });
  for (const [path, body] of [['/api/name', { name: 'x' }], ['/api/pause', { kind: '1h' }], ['/api/jobslots', { slots: 2 }]] as const) {
    const reply = await r.post(s, path, body); assert.equal(reply.status, 409, path); assert.equal(reply.json().error.code, 'LOCAL_STATE_UNREADABLE'); assert.match(reply.json().error.hint, /config check/); }
  assert.equal(await readFile(join(r.state, 'local-state.json'), 'utf8'), '{broken', 'the damaged file was not overwritten');
  assert.match(renderPage('n'), /error\.hint/);
});

test('storage in the panel: a status card with no path or chunk list, edits through the same policy path as everything else, refused when the policy is locked', async t => {
  const r = await rig(t); const s = await r.login(); const status = await r.get(s, '/api/storage'); assert.equal(status.status, 200);
  const body = status.json(); assert.deepEqual([body.enabled, body.state, body.networkAccessible, body.maxChunkBytes], [false, 'DISABLED', false, 8 * 1024 * 1024]); assert.doesNotMatch(status.text, new RegExp(r.state.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'no host path'); assert.doesNotMatch(status.text, /chk_[0-9a-f]{64}/);
  const doc = (await r.get(s, '/api/policy')).json(); assert.deepEqual(doc.policy.storage, { enabled: false, maxBytes: 1024 ** 3, reserveFreeBytes: 10 * 1024 ** 3, transfer: defaultResourcePolicy().storage.transfer });
  const saved = await r.post(s, '/api/policy', { policy: { ...doc.policy, storage: { enabled: true, maxBytes: 2 * 1024 ** 3, reserveFreeBytes: 5 * 1024 ** 3 } } }); assert.equal(saved.status, 200, saved.text);
  assert.deepEqual((await r.get(s, '/api/policy')).json().policy.storage, { enabled: true, maxBytes: 2 * 1024 ** 3, reserveFreeBytes: 5 * 1024 ** 3, transfer: defaultResourcePolicy().storage.transfer }); assert.equal((await r.get(s, '/api/policy')).json().preset, doc.preset, 'storage never changes which preset the policy matches');
  assert.equal((await r.post(s, '/api/policy', { policy: { ...doc.policy, storage: { enabled: true, maxBytes: -5, reserveFreeBytes: 0 } } })).status, 422);
  assert.equal((await r.post(s, '/api/policy', { policy: { ...doc.policy, storage: { enabled: true, listenerPort: 4041 } } })).status, 422, 'there is no network setting to change');
  for (const path of ['/api/storage/list', '/api/storage/chunks', '/api/storage/get', '/api/storage/put']) { assert.equal((await r.get(s, path)).status, 404, path); assert.equal((await r.post(s, path, {})).status, 404, path); }
  const locked = await rig(t, { policyLocked: true, env: { PRIVANODE_POLICY_LOCKED: 'true' } }); const ls = await locked.login(); const reply = await locked.post(ls, '/api/policy', { policy: { ...(await locked.get(ls, '/api/policy')).json().policy, storage: { enabled: true, maxBytes: 1, reserveFreeBytes: 0 } } });
  assert.equal(reply.status, 409); assert.equal(reply.json().error.code, 'POLICY_LOCKED_BY_ENVIRONMENT'); assert.equal((await locked.get(ls, '/api/settings')).json().storage.locked, true);
});
