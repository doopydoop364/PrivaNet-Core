import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createConnection, createServer as createNetServer } from 'node:net';
import { request as httpsRequest } from 'node:https';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import { hash, secret } from '@privanet/shared';
import { Coordinator } from '@privanet/coordinator/service';
import { SqliteStore } from '@privanet/coordinator/store';
import { createCoordinatorServer } from '@privanet/coordinator/server';

// The shipped public-proxy rules (deploy/caddy/public-routes.caddy), run by a REAL Caddy in front of a REAL Coordinator, and the exposure checker run against it from outside.
// Run with `npm run test:proxy` (needs the `caddy` binary; the CI `proxy` job installs it and sets PRIVANET_REQUIRE_CADDY=1 so a missing binary fails there instead of skipping).
const root = fileURLToPath(new URL('../../', import.meta.url));
const caddyMissing = (): string | undefined => {
  try { execFileSync('caddy', ['version'], { stdio: 'ignore' }); return undefined; } catch { /* below */ }
  if (process.env.PRIVANET_REQUIRE_CADDY === '1') throw new Error('the proxy tests are required (PRIVANET_REQUIRE_CADDY=1) but caddy is not installed');
  return 'caddy is not installed';
};
const skip = caddyMissing();
const freePort = async (): Promise<number> => { const server = createNetServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); assert(address && typeof address === 'object'); await new Promise<void>(resolve => server.close(() => resolve())); return address.port; };
interface Run { code: number; out: string; err: string }
const runNode = (args: string[], env: NodeJS.ProcessEnv, input = ''): Promise<Run> => new Promise(resolve => {
  const child = spawn(process.execPath, args, { cwd: root, env: { PATH: process.env.PATH ?? '', ...env }, stdio: ['pipe', 'pipe', 'pipe'] }); let out = ''; let err = '';
  child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString(); }); child.stderr.on('data', (chunk: Buffer) => { err += chunk.toString(); }); child.stdin.end(input); child.once('close', code => resolve({ code: code ?? -1, out, err }));
});
async function until(what: string, check: () => boolean | Promise<boolean>, ms = 20000) { const deadline = Date.now() + ms; while (!(await check())) { if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`); await new Promise(resolve => setTimeout(resolve, 50)); } }

async function stack(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'privanet-proxy-')); const adminSecret = secret(); const children: ChildProcess[] = [];
  const store = new SqliteStore(join(dir, 'c.sqlite')); const core = new Coordinator(store, { offlineMs: 60000, staleMs: 30000 }, Date.now, undefined, { inviteKey: Buffer.from(hash(`k${adminSecret}`), 'hex') });
  const seen: string[] = []; const inner: Server = createCoordinatorServer(core, { adminSecret, authRequestsPerMinute: 100000, log: entry => seen.push(JSON.stringify(entry)) });
  const requests: string[] = []; inner.prependListener('request', req => { requests.push(`${req.method} ${req.url}`); });
  await new Promise<void>(resolve => inner.listen(0, '127.0.0.1', resolve)); const address = inner.address(); assert(address && typeof address === 'object'); const upstream = `127.0.0.1:${address.port}`;
  t.after(async () => { for (const child of children) if (child.exitCode === null) { child.kill('SIGTERM'); await new Promise<void>(resolve => { const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 3000); child.once('close', () => { clearTimeout(timer); resolve(); }); }); } await new Promise<void>(resolve => { inner.close(() => resolve()); inner.closeAllConnections(); }); store.close(); await rm(dir, { recursive: true, force: true }); });
  /** A Caddy with its own local CA (so no public CA is needed in a test) serving `localhost:PORT` with the given site body. */
  async function caddy(name: string, siteBody: string) {
    const home = join(dir, name); await mkdir(home, { recursive: true }); const port = await freePort(); const caCert = join(home, 'data', 'caddy', 'pki', 'authorities', 'local', 'root.crt'); const file = join(home, 'Caddyfile');
    await writeFile(file, `{\n\tadmin off\n\tlocal_certs\n\tskip_install_trust\n}\nlocalhost:${port} {\n\ttls internal\n${siteBody}\n}\n`);
    const logs: string[] = []; const child = spawn('caddy', ['run', '--config', file, '--adapter', 'caddyfile'], { env: { PATH: process.env.PATH ?? '', HOME: home, XDG_DATA_HOME: join(home, 'data'), XDG_CONFIG_HOME: join(home, 'config'), PRIVANET_UPSTREAM: upstream }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk: Buffer) => logs.push(chunk.toString())); child.stderr.on('data', (chunk: Buffer) => logs.push(chunk.toString())); children.push(child);
    try { await until('caddy to listen', async () => existsSync(caCert) && await new Promise<boolean>(resolve => { const socket = createConnection({ port, host: '127.0.0.1' }, () => { socket.destroy(); resolve(true); }); socket.once('error', () => resolve(false)); })); } catch (error) { throw new Error(`${(error as Error).message}; caddy said: ${logs.join('').slice(-1500)}`, { cause: error }); }
    return { port, url: `https://localhost:${port}`, caCert, logs };
  }
  return { dir, core, seen, requests, adminSecret, upstream, caddy,
    shipped: (name = 'public') => caddy(name, `\timport ${join(root, 'deploy', 'caddy', 'public-routes.caddy')}`) };
}
/** An HTTPS request that trusts the test proxy's own CA (this process does not, only the child processes are given it). */
const https = (url: string, ca: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; text: string }> => readFile(ca, 'utf8').then(pem => new Promise((resolve, reject) => {
  const request = httpsRequest(url, { method: init.method ?? 'GET', headers: init.headers ?? {}, ca: pem }, response => { let text = ''; response.on('data', (chunk: Buffer) => { text += chunk.toString(); }); response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, text })); });
  request.on('error', reject); request.end(init.body);
}));
const checker = (url: string, caCert: string, ...extra: string[]) => runNode(['scripts/check-exposure.mjs', url, '--json', ...extra], { NODE_EXTRA_CA_CERTS: caCert });
const verdicts = (run: Run) => Object.fromEntries((JSON.parse(run.out) as { results: Array<{ id: string; status: string }> }).results.map(entry => [entry.id, entry.status]));

test('the shipped public routes pass the exposure check from outside, and the admin API is never reached', { skip, timeout: 120000 }, async t => {
  const s = await stack(t); const proxy = await s.shipped();
  const run = await checker(proxy.url, proxy.caCert); assert.equal(run.code, 0, run.out + run.err);
  const result = verdicts(run);
  for (const id of ['health', 'admin', 'applications', 'body', 'unknown', 'method', 'malformed', 'hsts']) assert.equal(result[id], 'PASS', `${id}: ${run.out}`);
  assert.equal(result.certificate, 'WARN', 'Caddy\'s test CA issues 12-hour certificates, which the checker rightly flags as close to expiry (a public certificate has weeks left)');
  assert.equal(result.http, 'INFO'); assert.equal(result.limits, 'INFO');
  // Nothing the checker sent at the administrator or application API got as far as the Coordinator.
  assert.deepEqual(s.requests.filter(line => /\/admin|\/jobs|\/capabilities/i.test(line)), [], `the Coordinator saw: ${s.requests.filter(line => /admin|jobs|capabilities/i.test(line)).join(' | ')}`);
  // The same, by hand, with real credentials: even the REAL admin secret does nothing through the public name.
  const probe = async (path: string, method = 'GET') => https(proxy.url + path, proxy.caCert, { method, headers: { authorization: `Bearer ${s.adminSecret}`, 'x-privanet-protocol': '1', 'content-type': 'application/json' }, ...(method === 'POST' ? { body: '{}' } : {}) });
  for (const [path, method] of [['/v1/admin/nodes', 'GET'], ['/v1/admin/enrollment-tokens', 'POST'], ['/v1/admin/invites', 'POST'], ['/V1/Admin/nodes', 'GET'], ['/v1/node/../admin/nodes', 'GET']] as const) {
    const response = await probe(path, method); assert.ok([403, 404].includes(response.status), `${method} ${path} -> ${response.status}`); assert.equal(response.text.includes('nodeId'), false);
  }
  assert.equal(s.core.listNodes().length, 0); assert.equal(s.core.listInvites().length, 0, 'no invite was created through the public name with the admin secret');
  const health = await https(`${proxy.url}/v1/health`, proxy.caCert, { headers: { 'x-privanet-protocol': '1' } }); assert.equal(health.status, 200); assert.match(String(health.headers['strict-transport-security'] ?? ''), /max-age/); assert.equal(health.headers.server, undefined);
  // Applications' routes are blocked on the public name; the node routes are served.
  assert.equal((await https(`${proxy.url}/v1/jobs`, proxy.caCert, { method: 'POST', headers: { 'x-privanet-protocol': '1', 'content-type': 'application/json' }, body: '{}' })).status, 404);
  assert.equal((await https(`${proxy.url}/v1/capabilities`, proxy.caCert, { headers: { 'x-privanet-protocol': '1' } })).status, 404);
  assert.equal((await https(`${proxy.url}/v1/node/heartbeat`, proxy.caCert, { method: 'POST', headers: { 'x-privanet-protocol': '1', 'content-type': 'application/json', authorization: `Bearer ${secret()}` }, body: '{}' })).status, 401, 'node routes reach the Coordinator');
});

test('the checker catches a naive proxy that forwards everything, and the limits probe sees the guessing limits through the proxy', { skip, timeout: 120000 }, async t => {
  const s = await stack(t); const naive = await s.caddy('naive', `\treverse_proxy ${s.upstream}`);
  const run = await checker(naive.url, naive.caCert); assert.equal(run.code, 1); const result = verdicts(run);
  assert.equal(result.admin, 'FAIL'); assert.equal(result.applications, 'WARN'); assert.match(run.out, /reached the Coordinator's administrator API/);
  const human = await runNode(['scripts/check-exposure.mjs', naive.url], { NODE_EXTRA_CA_CERTS: naive.caCert }); assert.equal(human.code, 1); assert.match(human.out, /FAIL\s+Administrator API unreachable/); assert.match(human.out, /FAILED: fix the lines marked FAIL/);
  const allowed = await checker(naive.url, naive.caCert, '--allow-application-api'); assert.equal(verdicts(allowed).applications, 'INFO');
  // Through the shipped routes, guessing is limited at the Coordinator.
  const proxy = await s.shipped(); const limits = await checker(proxy.url, proxy.caCert, '--probe-limits'); assert.equal(limits.code, 0, limits.out); const v = verdicts(limits);
  assert.equal(v['limit-token'], 'PASS'); assert.equal(v['limit-invite'], 'PASS');
});

test('the checker refuses plain http and cannot be told to skip certificate checks; an untrusted certificate fails the check', { skip, timeout: 60000 }, async t => {
  const s = await stack(t); const proxy = await s.shipped();
  assert.equal((await runNode(['scripts/check-exposure.mjs', 'http://example.com'], {})).code, 78);
  assert.equal((await runNode(['scripts/check-exposure.mjs', proxy.url, '--insecure'], {})).code, 78);
  assert.equal((await runNode(['scripts/check-exposure.mjs', 'https://user:pw@example.com'], {})).code, 78);
  const untrusted = await runNode(['scripts/check-exposure.mjs', proxy.url, '--json'], {}); assert.equal(untrusted.code, 1); assert.equal(verdicts(untrusted).health, 'FAIL'); assert.match(untrusted.out, /certificate is not accepted by this machine/);
});

test('a contributor can enroll across the public proxy over verified TLS: invite, doctor, restart, and revocation', { skip, timeout: 120000 }, async t => {
  const s = await stack(t); const proxy = await s.shipped(); const stateDir = join(s.dir, 'node-state'); const env = { NODE_EXTRA_CA_CERTS: proxy.caCert, PRIVANODE_STATE_DIR: stateDir };
  const invite = s.core.createInvite({ expiresInMs: 600000, capabilities: ['system.echo.v1'], label: 'Remote contributor' });
  const enrolled = await runNode(['apps/node/dist/main.js', 'enroll', '--coordinator', proxy.url, '--invite-stdin'], env, `${invite.code}\n`); assert.equal(enrolled.code, 0, enrolled.err); assert.match(enrolled.out, /Enrolled\./);
  const doctor = await runNode(['apps/node/dist/main.js', 'doctor', '--coordinator', proxy.url, '--json'], env); assert.equal(doctor.code, 0, doctor.out);
  const report = JSON.parse(doctor.out) as { stages: Array<{ id: string; status: string; detail: string }> }; assert.equal(report.stages.find(stage => stage.id === 'endpoints')?.status, 'OK'); assert.equal(report.stages.find(stage => stage.id === 'registered')?.status, 'OK');
  const policy = join(s.dir, 'policy.json'); await writeFile(policy, JSON.stringify({ reserveMemoryBytes: 0, safetyMarginBytes: 0, reserveCpuPercent: 0, maxCpuPercent: 100, maxMemoryBytes: 1024 ** 3 }));
  const daemon = spawn(process.execPath, ['apps/node/dist/main.js'], { cwd: root, env: { PATH: process.env.PATH ?? '', ...env, PRIVANODE_POLICY_FILE: policy, PRIVANODE_HEARTBEAT_MS: '100', PRIVANODE_POLL_MS: '50' }, stdio: ['ignore', 'pipe', 'pipe'] }); let log = ''; daemon.stdout.on('data', (chunk: Buffer) => { log += chunk.toString(); }); daemon.stderr.on('data', (chunk: Buffer) => { log += chunk.toString(); }); t.after(() => { daemon.kill('SIGKILL'); });
  await until('the node to authenticate through the proxy', () => log.includes('node.authenticated')); await until('the node to be ONLINE', () => s.core.listNodes()[0]?.status === 'ONLINE');
  s.core.revokeNode(s.core.listNodes()[0]?.nodeId ?? ''); await until('the revoked node to be refused', () => /UNAUTHORIZED_NODE/.test(log));
  assert.equal(log.includes(invite.code.replace('-', '')), false); assert.equal(s.seen.join('').includes(invite.code.replace('-', '')), false); assert.equal(proxy.logs.join('').includes(invite.code.replace('-', '')), false, "the proxy's own log does not carry the code (it travels in the body)");
  assert.equal(JSON.parse(await readFile(join(stateDir, 'enrollment.json'), 'utf8')).coordinatorUrl, proxy.url);
});

test('the public Caddyfile template is valid Caddy configuration', { skip }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'privanet-caddyfile-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const template = (await readFile(join(root, 'deploy', 'caddy', 'Caddyfile.public'), 'utf8')).replace('/opt/privanet/deploy/caddy/public-routes.caddy', join(root, 'deploy', 'caddy', 'public-routes.caddy'));
  const directives = template.split('\n').filter(line => !line.trim().startsWith('#')).join('\n');
  assert.match(template, /node\.example\.com/); assert.doesNotMatch(directives, /tls internal|local_certs|insecure|skip_verify/, 'a public site uses a publicly trusted certificate: no private CA, no skipped verification');
  const file = join(dir, 'Caddyfile'); await writeFile(file, template);
  execFileSync('caddy', ['validate', '--config', file, '--adapter', 'caddyfile'], { stdio: 'pipe', env: { PATH: process.env.PATH ?? '', HOME: dir, XDG_DATA_HOME: join(dir, 'd'), XDG_CONFIG_HOME: join(dir, 'c') } });
  // The routes file itself never mentions the administrator API as something to forward, and forwards only listed paths.
  const routes = await readFile(join(root, 'deploy', 'caddy', 'public-routes.caddy'), 'utf8'); assert.doesNotMatch(routes.split('\n').filter(line => !line.trim().startsWith('#')).join('\n'), /admin|\/v1\/jobs|\/v1\/capabilities/);
});
