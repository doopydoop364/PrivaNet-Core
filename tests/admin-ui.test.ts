import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { Script } from 'node:vm';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
/* eslint-disable @typescript-eslint/no-explicit-any -- replies are inspected as loose JSON */
import { joinNode } from '@privanet/node/enroll';
import { startAdminUi, describeNode, versionNote } from '@privanet/coordinator/admin-ui';
import { renderAdminPage } from '@privanet/coordinator/admin-page';
import { LOCAL_UI_BODY_LIMIT } from '@privanet/shared';
import { ECHO, harness } from './onboarding-harness.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
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
async function rig(t: TestContext, options: { adminSecret?: string; coordinatorUrl?: string } = {}) {
  const f = await harness(t);
  const ui = await startAdminUi({ coordinatorUrl: options.coordinatorUrl ?? f.url, adminSecret: options.adminSecret ?? f.adminSecret, allowInsecureLoopback: true, port: 0, publicUrl: 'https://coordinator.example.org' });
  t.after(() => ui.close());
  const login = await call(ui.port, 'POST', '/api/login', { headers: { origin: `http://127.0.0.1:${ui.port}`, 'content-type': 'application/json' }, body: JSON.stringify({ token: ui.token }) });
  assert.equal(login.status, 200); const cookie = String(login.headers['set-cookie']).split(';')[0]!;
  const session = (await call(ui.port, 'GET', '/api/session', { headers: { cookie } })).json(); const csrf = session.csrf as string;
  const get = (path: string) => call(ui.port, 'GET', path, { headers: { cookie } });
  const post = (path: string, body: unknown) => call(ui.port, 'POST', path, { headers: { cookie, origin: `http://127.0.0.1:${ui.port}`, 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify(body) });
  return { f, ui, cookie, csrf, get, post };
}

test('the dashboard shows nodes, invites and requests, and every action goes through the existing administrator API', async t => {
  const r = await rig(t);
  const empty = (await r.get('/api/overview')).json(); assert.equal(empty.coordinator.reachable, true); assert.equal(empty.coordinator.adminCredential, 'accepted'); assert.deepEqual(empty.nodes, []);
  // An invite is created through the dashboard; the code is in that one answer and nowhere afterwards.
  const made = await r.post('/api/invites/create', { minutes: 10, capabilities: ECHO, label: 'Judah PC' }); assert.equal(made.status, 200);
  const invite = made.json().invite; assert.match(invite.code, /^[0-9A-Z]{4}-[0-9A-Z]{4}$/); assert.match(made.json().enroll, /privanet-node enroll --coordinator https:\/\/coordinator\.example\.org --invite-stdin/);
  const later = await r.get('/api/overview'); assert.equal(later.text.includes(invite.code), false, 'the code is shown once');
  assert.equal(later.json().invites[0].status, 'ACTIVE'); assert.equal(later.json().invites[0].label, 'Judah PC');
  assert.equal((await r.f.admin.invites())[0]?.id, invite.id);
  await r.post('/api/invites/revoke', { id: invite.id }); assert.equal((await r.f.admin.invites())[0]?.status, 'REVOKED');
  // An approval request is approved with the operator's choice of capabilities, and the node joins.
  const seen: Array<{ code: string; nodeId: string }> = []; const stateDir = await mkdtemp(join(tmpdir(), 'privanet-admin-ui-node-')); t.after(() => rm(stateDir, { recursive: true, force: true }));
  const joined = joinNode({ url: r.f.url, stateDir, allowInsecureLoopback: true, pollMs: 25, deviceName: 'garage', capabilities: ECHO, onRequested: info => seen.push(info) }); joined.catch(() => undefined);
  const deadline = Date.now() + 8000; while (!seen[0] && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20)); assert.ok(seen[0]);
  const waiting = (await r.get('/api/overview')).json().requests[0]; assert.equal(waiting.code, seen[0].code); assert.equal(waiting.nodeId, seen[0].nodeId, 'the operator sees the node ID the machine printed');
  const approved = await r.post('/api/requests/approve', { code: seen[0].code.toLowerCase().replace('-', ' '), capabilities: ECHO, label: 'Garage PC' }); assert.equal(approved.status, 200);
  await joined; const node = (await r.get('/api/overview')).json().nodes[0]; assert.equal(node.name, 'Garage PC'); assert.equal(node.status, 'OFFLINE'); assert.equal(node.state, 'Enrolled, has never connected'); assert.equal(node.lastSeenAt, null);
  assert.deepEqual(node.capabilities, ECHO); assert.equal(node.version.state, 'current');
  // Rename and revoke (revoking needs the explicit confirmation).
  assert.equal((await r.post('/api/nodes/rename', { nodeId: node.nodeId, name: 'Renamed' })).status, 200); assert.equal((await r.f.admin.nodes())[0]?.displayName, 'Renamed');
  assert.equal((await r.post('/api/nodes/revoke', { nodeId: node.nodeId })).status, 400); assert.equal((await r.f.admin.nodes())[0]?.status, 'OFFLINE');
  assert.equal((await r.post('/api/nodes/revoke', { nodeId: node.nodeId, confirm: true })).status, 200); assert.equal((await r.get('/api/overview')).json().nodes[0].state, 'Revoked: it can no longer sign in');
  // A refusal from the Coordinator reaches the browser as a code only.
  const unknown = await r.post('/api/requests/deny', { code: 'ZZZZ-ZZZZ' }); assert.ok(unknown.status >= 400 && unknown.status < 600); assert.deepEqual(Object.keys(unknown.json().error), ['code']);
});

test('the administrator secret, application credentials and enrollment tokens never reach the browser, and a wrong credential is reported without echoing it', async t => {
  const r = await rig(t);
  const everything = [(await call(r.ui.port, 'GET', '/', {})).text, (await r.get('/api/overview')).text, (await r.get('/api/session')).text, (await r.post('/api/invites/create', { minutes: 5, capabilities: ECHO })).text, renderAdminPage('abc')].join('\n');
  assert.equal(everything.includes(r.f.adminSecret), false);
  for (const path of ['/api/enrollment-tokens', '/api/applications', '/api/admin/nodes', '/v1/admin/nodes']) assert.equal((await r.get(path)).status, 404, path);
  for (const path of ['/api/applications/create', '/api/enrollment-tokens/create', '/api/applications/rotate']) assert.equal((await r.post(path, {})).status, 404, path);
  const wrong = await rig(t, { adminSecret: 'a'.repeat(64) }); const view = (await wrong.get('/api/overview')).json();
  assert.equal(view.coordinator.adminCredential, 'refused'); assert.equal(view.coordinator.reachable, true); assert.equal(view.nodes, null); assert.equal(JSON.stringify(view).includes('a'.repeat(64)), false);
  const down = await rig(t, { coordinatorUrl: 'http://127.0.0.1:1' }); const unreachable = (await down.get('/api/overview')).json(); assert.equal(unreachable.coordinator.reachable, false); assert.equal(unreachable.nodes, null);
  assert.equal((await down.post('/api/invites/create', { minutes: 5, capabilities: ECHO })).json().error.code, 'COORDINATOR_UNREACHABLE');
});

test('the dashboard is a local web UI and is guarded like one: loopback, Host, sign-in for every route, Origin, CSRF, JSON, bounded strict bodies, CSP, no CORS', async t => {
  const r = await rig(t); const { port } = r.ui; const good = { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' };
  assert.equal(r.ui.address, '127.0.0.1');
  assert.equal((await call(port, 'GET', '/', { host: 'evil.example' })).status, 421); assert.equal((await call(port, 'GET', '/', { host: `127.0.0.1.evil.example:${port}` })).status, 421);
  const page = await call(port, 'GET', '/'); assert.equal(page.status, 200); const csp = String(page.headers['content-security-policy']); assert.match(csp, /default-src 'none'/); assert.match(csp, /script-src 'nonce-[A-Za-z0-9+/=]+'/); assert.doesNotMatch(csp, /unsafe-|\*/);
  assert.equal(page.headers['access-control-allow-origin'], undefined); assert.equal(page.headers['x-frame-options'], 'DENY');
  assert.equal((await call(port, 'GET', '/api/overview')).status, 401, 'even reads need the session'); assert.equal((await call(port, 'GET', '/api/overview', { headers: { cookie: `privanet_admin=${'0'.repeat(64)}` } })).status, 401);
  assert.equal((await call(port, 'PUT', '/api/overview', { headers: { cookie: r.cookie } })).status, 405); assert.equal((await call(port, 'OPTIONS', '/api/overview')).status, 405);
  const base = { cookie: r.cookie }; const body = JSON.stringify({ minutes: 5, capabilities: ECHO });
  assert.equal((await call(port, 'POST', '/api/invites/create', { headers: { ...base, 'content-type': 'application/json', 'x-csrf-token': r.csrf }, body })).status, 403, 'no Origin');
  assert.equal((await call(port, 'POST', '/api/invites/create', { headers: { ...base, ...good, origin: 'http://evil.example', 'x-csrf-token': r.csrf }, body })).status, 403, 'foreign Origin');
  assert.equal((await call(port, 'POST', '/api/invites/create', { headers: { ...base, ...good }, body })).status, 403, 'no CSRF token');
  assert.equal((await call(port, 'POST', '/api/invites/create', { headers: { ...base, ...good, 'x-csrf-token': 'x'.repeat(48) }, body })).status, 403, 'wrong CSRF token');
  assert.equal((await call(port, 'POST', '/api/invites/create', { headers: { ...base, ...good, 'content-type': 'text/plain', 'x-csrf-token': r.csrf }, body })).status, 415);
  assert.equal((await r.f.admin.invites()).length, 0, 'none of the refused requests did anything');
  assert.equal((await r.post('/api/invites/create', { minutes: 61, capabilities: ECHO })).status, 400, 'an invite is at most an hour');
  assert.equal((await r.post('/api/invites/create', { minutes: 5, capabilities: ECHO, extra: 1 })).status, 400, 'strict schemas');
  assert.equal((await r.post('/api/invites/create', { minutes: 5, capabilities: ['rm -rf'] })).status, 400);
  assert.equal((await r.post('/api/nodes/rename', { nodeId: '../../v1/admin', name: 'x' })).status, 400, 'IDs are checked before they reach a URL');
  const huge = await call(port, 'POST', '/api/invites/create', { headers: { ...base, ...good, 'x-csrf-token': r.csrf }, body: Buffer.alloc(LOCAL_UI_BODY_LIMIT + 1024, 0x61) }).catch(() => undefined); assert.ok(!huge || huge.status === 413);
  assert.equal((await r.post('/api/invites/create', { minutes: 5, capabilities: ECHO })).status, 200, 'still serving');
  // Sign-in: wrong tokens are refused and counted.
  for (let i = 0; i < 5; i++) assert.equal((await call(port, 'POST', '/api/login', { headers: good, body: JSON.stringify({ token: 'b'.repeat(64) }) })).status, 401);
  assert.equal((await call(port, 'POST', '/api/login', { headers: good, body: JSON.stringify({ token: r.ui.token }) })).status, 429, 'locked out after repeated failures, even with the right token');
  assert.equal((await r.post('/api/logout', {})).status, 200); assert.equal((await r.get('/api/overview')).status, 401);
});

test('node states say only what the Coordinator knows, and software versions are compared by protocol first', () => {
  const base = { nodeId: `node_${'a'.repeat(64)}`, capabilities: ['system.echo.v1' as const], daemonVersion: '0.3.5', protocolVersion: 1 as const, lastHeartbeatAt: null, currentJobs: 0, jobSlots: 1, status: 'OFFLINE' as const };
  assert.equal(describeNode(base, { serviceVersion: '0.3.5', protocolVersion: 1 }, 1000).state, 'Enrolled, has never connected');
  assert.equal(describeNode({ ...base, lastHeartbeatAt: 500, status: 'ONLINE' }, undefined, 1000).ageMs, 500); assert.equal(describeNode({ ...base, status: 'DRAINING', lastHeartbeatAt: 1 }, undefined, 2).state.startsWith('Draining'), true);
  assert.equal(describeNode(base, undefined, 1).reported, null, 'no report, no invented numbers');
  const c = { serviceVersion: '0.4.0', protocolVersion: 1 };
  assert.equal(versionNote({ daemonVersion: '0.4.0', protocolVersion: 1 }, c).state, 'current'); assert.equal(versionNote({ daemonVersion: '0.3.5', protocolVersion: 1 }, c).state, 'node-older'); assert.equal(versionNote({ daemonVersion: '0.4.1', protocolVersion: 1 }, c).state, 'node-newer');
  assert.equal(versionNote({ daemonVersion: '0.4.0', protocolVersion: 2 }, c).state, 'protocol-mismatch'); assert.equal(versionNote({ daemonVersion: '0.4.0', protocolVersion: 1 }, undefined).state, 'unknown');
});

test('the dashboard page script is valid, builds text with textContent only, and has no inline handler, eval or foreign host', () => {
  const html = renderAdminPage('NONCE'); const script = /<script nonce="NONCE">([\s\S]*)<\/script>/.exec(html)?.[1] ?? ''; assert.ok(script.length > 1000); assert.doesNotThrow(() => new Script(script));
  assert.doesNotMatch(script, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function|setTimeout\(\s*['"]/); assert.doesNotMatch(html, /\son[a-z]+=|style="|https?:\/\/(?!127\.0\.0\.1)/);
});

test('`privanet-admin ui` runs as a separate process, prints a sign-in link instead of the secret, and serves the dashboard until stopped', async t => {
  const f = await harness(t); const child = spawn(process.execPath, [join(root, 'scripts', 'admin.mjs'), 'ui', '--port', '0'], { cwd: root, env: { PATH: process.env.PATH ?? '', PRIVANET_COORDINATOR_URL: f.url, PRIVANODE_ALLOW_INSECURE_LOOPBACK: 'true', PRIVANET_ADMIN_SECRET: f.adminSecret }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { child.kill('SIGKILL'); }); let out = ''; let err = ''; child.stdout.on('data', (c: Buffer) => { out += c.toString(); }); child.stderr.on('data', (c: Buffer) => { err += c.toString(); });
  // --port 0 is refused (a dashboard has a fixed, documented port); use a free one instead.
  await new Promise(resolve => child.once('close', resolve)); assert.match(err, /--port is a port number/);
  const probe = await rig(t); const free = probe.ui.port; await probe.ui.close();
  const run = spawn(process.execPath, [join(root, 'scripts', 'admin.mjs'), 'ui', '--port', String(free)], { cwd: root, env: { PATH: process.env.PATH ?? '', PRIVANET_COORDINATOR_URL: f.url, PRIVANODE_ALLOW_INSECURE_LOOPBACK: 'true', PRIVANET_ADMIN_SECRET: f.adminSecret }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { run.kill('SIGKILL'); }); out = ''; run.stdout.on('data', (c: Buffer) => { out += c.toString(); });
  const until = Date.now() + 15000; while (!/Sign-in link/.test(out) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 50));
  const link = /Sign-in link:\s+(\S+)/.exec(out)?.[1] ?? ''; assert.match(link, new RegExp(`^http://127\\.0\\.0\\.1:${free}/#[a-f0-9]{64}$`)); assert.equal(out.includes(f.adminSecret), false);
  const token = link.split('#')[1]!; const login = await call(free, 'POST', '/api/login', { headers: { origin: `http://127.0.0.1:${free}`, 'content-type': 'application/json' }, body: JSON.stringify({ token }) }); assert.equal(login.status, 200);
  const view = await call(free, 'GET', '/api/overview', { headers: { cookie: String(login.headers['set-cookie']).split(';')[0]! } }); assert.equal(view.json().coordinator.reachable, true); assert.equal(view.text.includes(f.adminSecret), false);
  run.kill('SIGINT'); const code = await new Promise<number | null>(resolve => run.once('close', resolve)); assert.equal(code, 0, 'Ctrl+C stops it cleanly');
});
