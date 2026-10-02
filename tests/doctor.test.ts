import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer as createHttpsServer } from 'node:https';
import { createServer as createNetServer } from 'node:net';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { secret } from '@privanet/shared';
import { diagnose, formatReport } from '@privanet/node/doctor';
import type { DoctorReport, Stage } from '@privanet/node/doctor';
import { GOOD_CERT, GOOD_KEY, OTHER_CERT, OTHER_KEY } from './doctor-fixture.js';
import { listenAny, realCoordinator } from './tls-harness.js';

const root = fileURLToPath(new URL('../../', import.meta.url)); const NODE = join(root, 'apps', 'node', 'dist', 'main.js');
const stageOf = (report: DoctorReport, id: string): Stage => { const found = report.stages.find(item => item.id === id); assert.ok(found, `stage ${id}`); return found; };

/** Runs `privanet-node ...` as its own process, so what is checked is the shipped command with the environment a user would have. */
async function node(args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number; out: string; err: string; report?: DoctorReport }> {
  const child = spawn(process.execPath, [NODE, ...args], { cwd: root, env: { PATH: process.env.PATH ?? '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; let err = ''; child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString(); }); child.stderr.on('data', (chunk: Buffer) => { err += chunk.toString(); });
  const code = await new Promise<number>(resolve => child.once('close', value => resolve(value ?? -1)));
  let report: DoctorReport | undefined; if (args.includes('--json')) { try { report = JSON.parse(out) as DoctorReport; } catch { /* not json */ } }
  return { code, out, err, ...(report ? { report } : {}) };
}
async function sandbox(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'privanet-doctor-')); t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'good.crt'), GOOD_CERT); await writeFile(join(dir, 'other.crt'), OTHER_CERT);
  return { dir, goodCa: join(dir, 'good.crt'), otherCa: join(dir, 'other.crt') };
}
/** A TLS server with the given certificate; `answer` is what it says to HTTP requests (default: a healthy PrivaNet health answer). */
async function tlsServer(t: TestContext, cert: string, key: string, answer?: (path: string) => { status: number; body: unknown; protocol?: string }) {
  const requests: string[] = [];
  const server = createHttpsServer({ cert, key }, (req, res) => {
    requests.push(`${req.method} ${req.url}`);
    const healthy = { status: 200, body: { protocolVersion: 1, serviceVersion: '0.3.0-alpha.6', coordinatorId: '00000000-0000-4000-8000-000000000000', status: 'ok' } } as { status: number; body: unknown; protocol?: string };
    const reply = answer ? answer(req.url ?? '') : healthy;
    res.writeHead(reply.status, { 'content-type': 'application/json', 'x-privanet-protocol': reply.protocol ?? '1' }); res.end(JSON.stringify(reply.body));
  });
  const port = await listenAny(server); t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  return { port, requests };
}
const quietState = (dir: string) => join(dir, 'state-that-does-not-exist');

test('doctor: a name that does not resolve is named, and nothing after it is attempted', async t => {
  const { dir } = await sandbox(t);
  const report = await diagnose({ url: 'https://node.example.invalid', stateDir: quietState(dir), allowInsecureLoopback: false, timeoutMs: 1000, env: {}, resolveHost: async () => { throw new Error('ENOTFOUND'); } });
  assert.equal(report.ok, false); assert.equal(stageOf(report, 'dns').status, 'FAILED'); assert.match(stageOf(report, 'dns').advice ?? '', /DNS/);
  for (const id of ['tcp', 'tls', 'health', 'protocol', 'endpoints']) assert.equal(stageOf(report, id).status, 'SKIPPED', id);
  const real = await node(['doctor', '--coordinator', 'https://node.example.invalid', '--state-dir', quietState(dir), '--timeout', '4', '--json']);
  assert.equal(real.code, 1); assert.equal(stageOf(real.report as DoctorReport, 'dns').status, 'FAILED');
});

test('doctor: a refused connection, a silent port and a connect timeout are told apart', async t => {
  const { dir } = await sandbox(t);
  const closed = createNetServer(); const closedPort = await listenAny(closed); await new Promise<void>(resolve => closed.close(() => resolve()));
  const refused = await node(['doctor', '--coordinator', `https://127.0.0.1:${closedPort}`, '--state-dir', quietState(dir), '--json']);
  assert.equal(refused.code, 1); const tcp = stageOf(refused.report as DoctorReport, 'tcp'); assert.equal(tcp.status, 'FAILED'); assert.match(tcp.detail, /refused/); assert.match(tcp.advice ?? '', /listening/);
  assert.equal(stageOf(refused.report as DoctorReport, 'tls').status, 'SKIPPED');
  // A TCP timeout (an address that drops packets, as a firewall does): simulated through the seam, because a test cannot rely on a black-holed address.
  const timedOut = await diagnose({ url: 'https://203.0.113.9', stateDir: quietState(dir), allowInsecureLoopback: false, timeoutMs: 300, env: {}, tcp: async () => { throw Object.assign(new Error('x'), { code: 'ETIMEDOUT' }); } });
  assert.match(stageOf(timedOut, 'tcp').detail, /timeout/); assert.match(stageOf(timedOut, 'tcp').advice ?? '', /firewall|forward/);
  // A port that accepts and never speaks TLS.
  const mute = createNetServer(socket => { socket.on('error', () => undefined); }); const mutePort = await listenAny(mute); t.after(() => { mute.close(); });
  const silent = await diagnose({ url: `https://127.0.0.1:${mutePort}`, stateDir: quietState(dir), allowInsecureLoopback: false, timeoutMs: 400, env: {} });
  assert.equal(stageOf(silent, 'tcp').status, 'OK'); assert.equal(stageOf(silent, 'tls').status, 'FAILED'); assert.match(stageOf(silent, 'tls').detail, /timed out/);
  assert.equal(stageOf(silent, 'health').status, 'SKIPPED');
});

test('doctor: an untrusted certificate stops the diagnosis there, says what to do, and sends nothing over the unverified connection', async t => {
  const { dir } = await sandbox(t); const server = await tlsServer(t, GOOD_CERT, GOOD_KEY);
  const result = await node(['doctor', '--coordinator', `https://localhost:${server.port}`, '--state-dir', quietState(dir), '--json']);
  const report = result.report as DoctorReport; assert.equal(result.code, 1);
  assert.equal(stageOf(report, 'tcp').status, 'OK'); const tls = stageOf(report, 'tls'); assert.equal(tls.status, 'FAILED'); assert.match(tls.detail, /not trusted/);
  assert.match(tls.advice ?? '', /private LAN deployment.*CA/s); assert.match(tls.advice ?? '', /public deployment/);
  for (const id of ['health', 'protocol', 'endpoints']) assert.equal(stageOf(report, id).status, 'SKIPPED', id);
  assert.deepEqual(server.requests, [], 'not one HTTP request was made over the connection that was not verified');
  assert.match((await node(['doctor', '--coordinator', `https://localhost:${server.port}`, '--state-dir', quietState(dir)])).out, /FAILED\s+certificate is not trusted/);
});

test('doctor: a certificate for another name is reported as a name mismatch, not as distrust', async t => {
  const { dir, otherCa } = await sandbox(t); const server = await tlsServer(t, OTHER_CERT, OTHER_KEY);
  const result = await node(['doctor', '--coordinator', `https://localhost:${server.port}`, '--state-dir', quietState(dir), '--json'], { NODE_EXTRA_CA_CERTS: otherCa });
  const tls = stageOf(result.report as DoctorReport, 'tls'); assert.equal(result.code, 1); assert.equal(tls.status, 'FAILED'); assert.match(tls.detail, /certificate is for other\.example, not localhost/); assert.match(tls.advice ?? '', /exact host name/);
  assert.deepEqual(server.requests, []);
});

test('doctor: a Coordinator speaking another protocol is reported, with a way forward', async t => {
  const { dir, goodCa } = await sandbox(t);
  const server = await tlsServer(t, GOOD_CERT, GOOD_KEY, () => ({ status: 200, protocol: '2', body: { protocolVersion: 2, serviceVersion: '9.0.0', coordinatorId: '00000000-0000-4000-8000-000000000000', status: 'ok' } }));
  const result = await node(['doctor', '--coordinator', `https://localhost:${server.port}`, '--state-dir', quietState(dir), '--json'], { NODE_EXTRA_CA_CERTS: goodCa });
  const report = result.report as DoctorReport; assert.equal(result.code, 1); assert.equal(stageOf(report, 'tls').status, 'OK'); assert.equal(stageOf(report, 'health').status, 'FAILED');
  assert.equal(stageOf(report, 'protocol').status, 'FAILED'); assert.match(stageOf(report, 'protocol').advice ?? '', /Update whichever/);
});

test('doctor: a healthy Coordinator, then an enrolled node: every stage is reported, nothing is created or changed, and no secret appears', async t => {
  const { dir, goodCa } = await sandbox(t); const c = await realCoordinator(t); const stateDir = join(dir, 'state'); const env = { NODE_EXTRA_CA_CERTS: goodCa };
  const before = await node(['doctor', '--coordinator', c.url, '--state-dir', stateDir, '--json'], env); const report = before.report as DoctorReport;
  assert.equal(before.code, 0, before.out); assert.equal(report.ok, true);
  for (const id of ['config', 'url', 'dns', 'tcp', 'tls', 'health', 'protocol', 'endpoints']) assert.ok(['OK', 'INFO'].includes(stageOf(report, id).status), `${id}: ${stageOf(report, id).detail}`);
  assert.match(stageOf(report, 'health').detail, /healthy/); assert.match(stageOf(report, 'protocol').detail, /protocol 1, this node speaks 1/); assert.match(stageOf(report, 'endpoints').detail, /token, invite, join/);
  assert.equal(stageOf(report, 'identity').status, 'INFO'); assert.equal(stageOf(report, 'enrollment').status, 'INFO'); assert.equal(stageOf(report, 'state').status, 'INFO');
  await assert.rejects(stat(stateDir), 'the doctor did not create the state directory'); assert.equal(c.core.listNodes().length, 0); assert.equal(c.store.countChallenges(), 0, 'no challenge was made: it had no identity to ask about');
  assert.equal(c.core.listEnrollments().length + c.core.listInvites().length + c.core.listRequests().length, 0, 'nothing was created at the Coordinator');
  // Enroll with the real command, then diagnose again.
  const token = c.core.createEnrollment({ expiresInMs: 600000, capabilities: ['system.echo.v1'] }).token; const tokenFile = join(dir, 'token'); await writeFile(tokenFile, token, { mode: 0o600 });
  const enrolled = await node(['enroll', '--coordinator', c.url, '--token-file', tokenFile, '--state-dir', stateDir], env); assert.equal(enrolled.code, 0, enrolled.err);
  const nodesBefore = c.core.listNodes().length; const grantsBefore = JSON.stringify(c.core.listEnrollments());
  const after = await node(['doctor', '--coordinator', c.url, '--state-dir', stateDir], { ...env, PRIVANODE_ENROLLMENT_TOKEN: secret(), PRIVANODE_INVITE_CODE: 'N7K4-PQ2M' });
  assert.equal(after.code, 0, after.out); assert.match(after.out, /Local identity\s+OK\s+node_[a-f0-9]{64}/); assert.match(after.out, /Enrollment state\s+OK\s+enrolled as node_/); assert.match(after.out, /At the Coordinator\s+OK/); assert.match(after.out, /No problems found/);
  assert.equal(c.core.listNodes().length, nodesBefore); assert.equal(JSON.stringify(c.core.listEnrollments()), grantsBefore, 'enrollment state was not touched');
  // No credential of any kind is printed: not the token, not the (environment) token or code, not the private key.
  const privateKey = (JSON.parse(await readFile(join(stateDir, 'identity.json'), 'utf8')) as { privateKey: string }).privateKey;
  for (const text of [before.out, after.out, after.err]) { for (const value of [token, privateKey, 'N7K4-PQ2M', 'N7K4PQ2M']) assert.equal(text.includes(value), false); }
  assert.equal(formatReport(report).includes('privateKey'), false);
});

test('doctor: an older Coordinator without the invite and join endpoints is a warning with advice, not a failure', async t => {
  const { dir, goodCa } = await sandbox(t); const c = await realCoordinator(t, GOOD_CERT, GOOD_KEY, ['/v1/invites/', '/v1/join/']);
  const result = await node(['doctor', '--coordinator', c.url, '--state-dir', quietState(dir), '--json'], { NODE_EXTRA_CA_CERTS: goodCa }); const endpoints = stageOf(result.report as DoctorReport, 'endpoints');
  assert.equal(result.code, 0); assert.equal(endpoints.status, 'WARN'); assert.match(endpoints.detail, /available: token; not available: invite, join/); assert.match(endpoints.advice ?? '', /Enrollment tokens work on every version/);
});

test('doctor: a node the Coordinator does not know, or has revoked, is reported with what to do', async t => {
  const { dir, goodCa } = await sandbox(t); const c = await realCoordinator(t); const stateDir = join(dir, 'state'); const env = { NODE_EXTRA_CA_CERTS: goodCa };
  const tokenFile = join(dir, 'token'); await writeFile(tokenFile, c.core.createEnrollment({ expiresInMs: 600000, capabilities: ['system.echo.v1'] }).token, { mode: 0o600 });
  const enrolled = await node(['enroll', '--coordinator', c.url, '--token-file', tokenFile, '--state-dir', stateDir], env); assert.equal(enrolled.code, 0, enrolled.err);
  c.core.revokeNode(c.core.listNodes()[0]?.nodeId ?? '');
  const result = await node(['doctor', '--coordinator', c.url, '--state-dir', stateDir, '--json'], env); const registered = stageOf(result.report as DoctorReport, 'registered');
  assert.equal(registered.status, 'WARN'); assert.match(registered.detail, /not known to the Coordinator, or was revoked/); assert.match(registered.advice ?? '', /fresh state directory/); assert.equal(result.code, 0, 'a warning is not a failure');
});

test('doctor: damaged or unsafe local state is reported without printing what is in it', { skip: process.platform === 'win32' && 'POSIX permissions' }, async t => {
  const { dir, goodCa } = await sandbox(t); const c = await realCoordinator(t); const env = { NODE_EXTRA_CA_CERTS: goodCa };
  const bad = join(dir, 'bad'); await mkdir(bad, { mode: 0o700 }); await writeFile(join(bad, 'identity.json'), '{"nodeId":"HELLO-SECRET-GARBAGE"', { mode: 0o600 });
  const garbage = await node(['doctor', '--coordinator', c.url, '--state-dir', bad], env); assert.equal(garbage.code, 1); assert.match(garbage.out, /Local identity\s+FAILED\s+identity\.json is unsafe, unreadable or not a valid key pair/);
  assert.equal(garbage.out.includes('HELLO-SECRET-GARBAGE'), false); assert.match(garbage.out, /never copy an identity from another machine/);
  const open = join(dir, 'open'); await mkdir(open, { mode: 0o755 }); await chmod(open, 0o755);
  const wide = await node(['doctor', '--coordinator', c.url, '--state-dir', open, '--json'], env); const state = stageOf(wide.report as DoctorReport, 'state'); assert.equal(wide.code, 1);
  assert.equal(state.status, 'FAILED'); assert.match(state.detail, /mode 755/); assert.match(state.advice ?? '', /chmod 700/);
  // An enrollment record that disagrees with the identity next to it.
  const stateDir = join(dir, 'real'); const tokenFile = join(dir, 'token'); await writeFile(tokenFile, c.core.createEnrollment({ expiresInMs: 600000, capabilities: ['system.echo.v1'] }).token, { mode: 0o600 });
  assert.equal((await node(['enroll', '--coordinator', c.url, '--token-file', tokenFile, '--state-dir', stateDir], env)).code, 0);
  const record = JSON.parse(await readFile(join(stateDir, 'enrollment.json'), 'utf8')) as Record<string, unknown>;
  await rm(join(stateDir, 'enrollment.json')); await writeFile(join(stateDir, 'enrollment.json'), JSON.stringify({ ...record, nodeId: `node_${'a'.repeat(64)}` }), { mode: 0o600 });
  const mismatch = await node(['doctor', '--coordinator', c.url, '--state-dir', stateDir, '--json'], env); assert.equal(mismatch.code, 1); assert.match(stageOf(mismatch.report as DoctorReport, 'enrollment').detail, /different identity/);
  // A world-readable enrollment record is refused like the other private files.
  await rm(join(stateDir, 'enrollment.json')); await writeFile(join(stateDir, 'enrollment.json'), JSON.stringify(record), { mode: 0o644 }); await chmod(join(stateDir, 'enrollment.json'), 0o644);
  const loose = await node(['doctor', '--state-dir', stateDir], env); assert.equal(loose.code, 1); assert.match(loose.out, /Configuration\s+FAILED\s+enrollment\.json is unreadable, unsafe or malformed/);
});

test('doctor: configuration problems are named without their values; usage errors exit 78', async t => {
  const { dir } = await sandbox(t);
  const missing = await node(['doctor', '--state-dir', quietState(dir)]); assert.equal(missing.code, 1); assert.match(missing.out, /Configuration\s+FAILED\s+No Coordinator address given/);
  const plain = await node(['doctor', '--coordinator', 'http://example.com', '--state-dir', quietState(dir), '--json']); const report = plain.report as DoctorReport;
  assert.equal(plain.code, 1); assert.equal(stageOf(report, 'url').status, 'FAILED'); assert.equal(stageOf(report, 'dns').status, 'SKIPPED'); assert.equal(JSON.stringify(report).includes('example.com'), false, 'an address that was refused is not echoed');
  const credentials = await node(['doctor', '--coordinator', 'https://user:hunter2@example.com', '--state-dir', quietState(dir)]); assert.equal(credentials.out.includes('hunter2'), false); assert.equal(credentials.out.includes('user:'), false);
  const badPolicy = await node(['doctor', '--coordinator', 'https://example.com', '--state-dir', quietState(dir), '--json'], { PRIVANODE_JOB_SLOTS: '9999' });
  assert.match(stageOf(badPolicy.report as DoctorReport, 'config').detail, /PRIVANODE_JOB_SLOTS/);
  for (const args of [['doctor', '--bogus'], ['doctor', '--timeout', '0'], ['doctor', '--coordinator'], ['doctor', 'stray']]) assert.equal((await node(args)).code, 78, args.join(' '));
  assert.equal((await node(['doctor', '--help'])).code, 0);
});
