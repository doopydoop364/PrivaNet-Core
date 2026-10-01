import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import { EnrollmentTokenSchema, NodesSchema } from '@privanet/protocol';
import { secret } from '@privanet/shared';
import { Coordinator } from '@privanet/coordinator/service';
import { SqliteStore } from '@privanet/coordinator/store';
import { createCoordinatorServer } from '@privanet/coordinator/server';

const root = fileURLToPath(new URL('../../', import.meta.url));
const ADMIN = join(root, 'scripts', 'admin.mjs'); const NODE = join(root, 'apps', 'node', 'dist', 'main.js');
interface Result { code: number; out: string; err: string }

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); assert(address && typeof address !== 'string'); return `http://127.0.0.1:${address.port}`;
}
/** A Coordinator in this process, and the shipped admin and node entry points run against it as separate processes. */
async function setup(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'privanet-cli-')); const adminSecret = secret(); const coordinatorLogs: unknown[] = [];
  const store = new SqliteStore(join(dir, 'coordinator.sqlite')); const core = new Coordinator(store, { offlineMs: 60000, staleMs: 30000 });
  const server = createCoordinatorServer(core, { adminSecret, log: entry => coordinatorLogs.push(entry), authRequestsPerMinute: 10000 });
  const url = await listen(server); const children: ChildProcess[] = [];
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); }
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); store.close(); await rm(dir, { recursive: true, force: true });
  });
  const run = async (file: string, args: string[], env: NodeJS.ProcessEnv, input?: string): Promise<Result> => {
    const child = spawn(process.execPath, [file, ...args], { cwd: root, env: { PATH: process.env.PATH ?? '', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = ''; let err = ''; child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString(); }); child.stderr.on('data', (chunk: Buffer) => { err += chunk.toString(); });
    child.stdin.end(input ?? '');
    const code = await new Promise<number>(resolve => child.once('close', value => resolve(value ?? -1)));
    return { code, out, err };
  };
  const adminEnv = { PRIVANET_ADMIN_SECRET: adminSecret, PRIVANET_COORDINATOR_URL: url, PRIVANODE_ALLOW_INSECURE_LOOPBACK: 'true' };
  return { dir, url, adminSecret, coordinatorLogs, core, children,
    admin: (args: string[], extra: NodeJS.ProcessEnv = {}) => run(ADMIN, args, { ...adminEnv, ...extra }),
    node: (args: string[], extra: NodeJS.ProcessEnv = {}, input?: string) => run(NODE, ['enroll', ...args], { PRIVANODE_ALLOW_INSECURE_LOOPBACK: 'true', ...extra }, input) };
}
const tokenOf = (output: string): string => { const match = /Token:\s+([a-f0-9]{64})/.exec(output); assert.ok(match?.[1], 'the token is printed on creation'); return match[1]; };
const idOf = (output: string): string => { const match = /Token ID:\s+(enr_[a-f0-9]{16})/.exec(output); assert.ok(match?.[1]); return match[1]; };

test('admin CLI: create a token, list without revealing it, revoke it, and the older JSON forms still work', async t => {
  const f = await setup(t); const seen: string[] = [];
  const created = await f.admin(['enrollment', 'create', '--expires', '10m', '--capabilities', 'system.echo.v1,system.hashchain.v1', '--label', 'Lab box']); seen.push(created.out, created.err);
  assert.equal(created.code, 0, created.err); assert.match(created.out, /^Enrollment token created\.\n/); assert.match(created.out, /Expires:\s+\d{4}-\d\d-\d\dT[\d:]+Z \(in 10m\)/);
  assert.match(created.out, /Capabilities:\s+system\.echo\.v1, system\.hashchain\.v1/); assert.match(created.out, /Name:\s+Lab box/); assert.match(created.out, /privanet-node enroll --coordinator/);
  const token = tokenOf(created.out); const id = idOf(created.out);
  const listed = await f.admin(['enrollment', 'list']); seen.push(listed.out, listed.err);
  assert.equal(listed.code, 0); assert.ok(listed.out.includes(id)); assert.ok(listed.out.includes('ACTIVE')); assert.ok(listed.out.includes('Lab box'));
  assert.equal(listed.out.includes(token), false, 'a listing never shows the token');
  const json = await f.admin(['enrollment', 'list', '--json']); const parsed = JSON.parse(json.out) as { tokens: Array<{ id: string; status: string }> }; assert.equal(parsed.tokens[0]?.id, id); assert.equal(json.out.includes(token), false);
  const revoked = await f.admin(['enrollment', 'revoke', id]); seen.push(revoked.out, revoked.err); assert.equal(revoked.code, 0); assert.match(revoked.out, /revoked/);
  assert.match((await f.admin(['enrollment', 'list'])).out, /No active enrollment tokens/);
  const all = await f.admin(['enrollment', 'list', '--all']); assert.ok(all.out.includes('REVOKED') && all.out.includes(id));
  // Older invocations print one line of JSON, exactly as scripts expect.
  const legacy = await f.admin(['enrollment'], { PRIVANET_JOB_TYPES: 'system.echo.v1', PRIVANET_ENROLLMENT_TTL_MS: '60000' }); seen.push(legacy.err);
  const legacyToken = EnrollmentTokenSchema.parse(JSON.parse(legacy.out)); assert.equal(legacy.out.trim().split('\n').length, 1); assert.equal(legacyToken.expiresAt - (legacyToken.createdAt ?? 0), 60000);
  assert.deepEqual(NodesSchema.parse(JSON.parse((await f.admin(['nodes'])).out)).nodes, []);
  assert.equal((await f.admin(['nodes', 'list'])).out.trim(), 'No nodes enrolled.');
  // Bad input says what is wrong, exits non-zero, and never prints the credential.
  for (const bad of [['enrollment', 'create', '--expires', '99d'], ['enrollment', 'create', '--expires', 'soon'], ['enrollment', 'create', '--label', 'bad<name>'], ['enrollment', 'create', '--capabilities', 'shell.exec'],
    ['enrollment', 'create', '--wat'], ['enrollment', 'revoke', 'nope'], ['enrollment', 'revoke', 'enr_0000000000000000'], ['nodes', 'show', 'node_nothing'], ['frobnicate']]) {
    const result = await f.admin(bad); seen.push(result.out, result.err); assert.equal(result.code, 1, bad.join(' ')); assert.ok(result.err.length > 0);
  }
  assert.match((await f.admin(['enrollment', 'create', '--expires', '99d'])).err, /between 1 second and 24 hours/);
  assert.equal((await f.admin(['enrollment', 'list'], { PRIVANET_ADMIN_SECRET: 'f'.repeat(64) })).code, 1);
  for (const text of seen) { assert.equal(text.includes(f.adminSecret), false); }
  assert.equal(JSON.stringify(f.coordinatorLogs).includes(token), false);
});

test('node CLI: enroll with a token, then a plain start reconnects with no token; admin sees, names and revokes the node', async t => {
  const f = await setup(t); const stateDir = join(f.dir, 'state'); const outputs: string[] = [];
  const created = await f.admin(['enrollment', 'create', '--capabilities', 'system.echo.v1', '--label', 'Desk PC']); const token = tokenOf(created.out); const tokenId = idOf(created.out);
  const tokenFile = join(f.dir, 'token'); await writeFile(tokenFile, `${token}\n`, { mode: 0o600 });
  const enrolled = await f.node(['--coordinator', f.url, '--token-file', tokenFile, '--state-dir', stateDir]); outputs.push(enrolled.out, enrolled.err);
  assert.equal(enrolled.code, 0, enrolled.err); assert.match(enrolled.out, /^Enrolled\./); assert.match(enrolled.out, /Node ID:\s+node_[a-f0-9]{64}/); assert.match(enrolled.out, /Name:\s+Desk PC/); assert.match(enrolled.out, /Capabilities:\s+system\.echo\.v1/);
  const nodeId = /Node ID:\s+(node_[a-f0-9]{64})/.exec(enrolled.out)?.[1] ?? ''; assert.equal(enrolled.err, '');
  const files = (await readdir(stateDir)).sort(); assert.deepEqual(files, ['enrollment.json', 'identity.json', 'node-state.json']);
  for (const name of files) assert.equal((await readFile(join(stateDir, name), 'utf8')).includes(token), false, `${name} does not hold the token`);
  assert.match((await f.admin(['enrollment', 'list', '--all'])).out, new RegExp(`${tokenId}\\s+USED`));
  // A start with nothing but the state directory: no URL, no capabilities, no token.
  const policy = join(f.dir, 'policy.json'); await writeFile(policy, JSON.stringify({ reserveMemoryBytes: 0, safetyMarginBytes: 0, reserveCpuPercent: 0, maxCpuPercent: 100, maxMemoryBytes: 1024 ** 3 }));
  const daemons: string[] = [];
  for (let start = 0; start < 2; start++) {
    const child = spawn(process.execPath, [NODE], { cwd: root, env: { PATH: process.env.PATH ?? '', PRIVANODE_STATE_DIR: stateDir, PRIVANODE_ALLOW_INSECURE_LOOPBACK: 'true', PRIVANODE_POLICY_FILE: policy, PRIVANODE_HEARTBEAT_MS: '50', PRIVANODE_POLL_MS: '20' }, stdio: ['ignore', 'pipe', 'pipe'] });
    f.children.push(child); let log = '';
    child.stdout.on('data', (chunk: Buffer) => { log += chunk.toString(); }); child.stderr.on('data', (chunk: Buffer) => { log += chunk.toString(); });
    const deadline = Date.now() + 15000; while (!log.includes('"event":"node.authenticated"') && Date.now() < deadline && child.exitCode === null) await new Promise(resolve => setTimeout(resolve, 25));
    assert.ok(log.includes('"event":"node.authenticated"'), `the node reconnected from its stored identity (start ${start + 1}): ${log.slice(0, 300)}`); assert.equal(log.includes('node.enrolled'), false, 'it did not enroll again');
    const online = Date.now() + 10000; let status = ''; while (Date.now() < online) { status = (NodesSchema.parse(JSON.parse((await f.admin(['nodes'])).out)).nodes[0]?.status) ?? ''; if (status === 'ONLINE') break; await new Promise(resolve => setTimeout(resolve, 50)); }
    assert.equal(status, 'ONLINE');
    child.kill('SIGTERM'); await new Promise<void>(resolve => child.once('close', () => resolve())); daemons.push(log); assert.equal(child.exitCode, 0);
  }
  outputs.push(...daemons);
  // The administrator's view, by name and by ID prefix.
  const list = await f.admin(['nodes', 'list']); assert.match(list.out, /Desk PC\s+node_[a-f0-9]{8}…\s+(ONLINE|OFFLINE_EXPECTED|OFFLINE)\s/); assert.ok(list.out.includes('system.echo.v1'));
  const shown = await f.admin(['nodes', 'show', 'Desk PC']); assert.ok(shown.out.includes(nodeId)); assert.match(shown.out, /Protocol:\s+1/); assert.match(shown.out, /Enrolled:\s+\d{4}/);
  assert.equal((await f.admin(['nodes', 'show', nodeId.slice(0, 12)])).code, 0); assert.equal((await f.admin(['nodes', 'show', 'node_'])).code, 1, 'a prefix too short to mean anything is refused');
  assert.equal((await f.admin(['nodes', 'rename', 'Desk PC', 'Study', 'PC'])).code, 0); assert.match((await f.admin(['nodes', 'show', 'Study PC'])).out, /Name:\s+Study PC/);
  assert.equal((await f.admin(['nodes', 'rename', 'Study PC', '--clear'])).code, 0); assert.match((await f.admin(['nodes', 'show', nodeId])).out, /Name:\s+-/);
  const revoked = await f.admin(['nodes', 'revoke', nodeId.slice(0, 16)]); assert.equal(revoked.code, 0); assert.match(revoked.out, /revoked/);
  assert.match((await f.admin(['nodes', 'show', nodeId])).out, /Status:\s+REVOKED \(since \d{4}/);
  // The revoked node cannot start again: it is refused and keeps retrying quietly, never reported as enrolled.
  const again = spawn(process.execPath, [NODE], { cwd: root, env: { PATH: process.env.PATH ?? '', PRIVANODE_STATE_DIR: stateDir, PRIVANODE_ALLOW_INSECURE_LOOPBACK: 'true', PRIVANODE_HEARTBEAT_MS: '50', PRIVANODE_POLL_MS: '20' }, stdio: ['ignore', 'pipe', 'pipe'] });
  f.children.push(again); let refusedLog = ''; again.stdout.on('data', (chunk: Buffer) => { refusedLog += chunk.toString(); }); again.stderr.on('data', (chunk: Buffer) => { refusedLog += chunk.toString(); });
  const refusedBy = Date.now() + 15000; while (!/UNAUTHORIZED_NODE|startup_failed/.test(refusedLog) && Date.now() < refusedBy && again.exitCode === null) await new Promise(resolve => setTimeout(resolve, 25));
  assert.match(refusedLog, /UNAUTHORIZED_NODE|startup_failed/); assert.equal(refusedLog.includes('node.authenticated'), false); again.kill('SIGKILL'); outputs.push(refusedLog);
  for (const text of outputs) { assert.equal(text.includes(token), false); assert.equal(text.includes(f.adminSecret), false); }
  assert.equal(JSON.stringify(f.coordinatorLogs).includes(token), false);
  assert.ok(f.coordinatorLogs.some(entry => (entry as { event: string }).event === 'node.enrolled'));
});

test('node CLI: other ways to give the token, safe refusals, exit codes and a token that is never echoed', async t => {
  const f = await setup(t); const outputs: string[] = []; const state = (name: string) => join(f.dir, name);
  const fresh = async (extra: string[] = []) => tokenOf((await f.admin(['enrollment', 'create', '--capabilities', 'system.echo.v1', ...extra])).out);
  // Standard input, environment and the flag all work; the tokens are different so each success is its own.
  const viaStdin = await fresh(); const a = await f.node(['--coordinator', f.url, '--token-stdin', '--state-dir', state('a')], {}, `${viaStdin}\n`); outputs.push(a.out, a.err); assert.equal(a.code, 0, a.err);
  const viaEnv = await fresh(); const b = await f.node(['--coordinator', f.url, '--state-dir', state('b')], { PRIVANODE_ENROLLMENT_TOKEN: viaEnv }); outputs.push(b.out, b.err); assert.equal(b.code, 0, b.err);
  const viaFlag = await fresh(); const c = await f.node([`--coordinator=${f.url}`, `--token=${viaFlag}`, `--state-dir=${state('c')}`]); /* the --name=value form */ outputs.push(c.out, c.err); assert.equal(c.code, 0, c.err);
  // Enrolling again from an enrolled state directory does nothing and leaves the new token unspent.
  const spare = await fresh(); const again = await f.node(['--coordinator', f.url, '--token', spare, '--state-dir', state('a')]); outputs.push(again.out, again.err);
  assert.equal(again.code, 0); assert.match(again.out, /already enrolled/); assert.match((await f.admin(['enrollment', 'list'])).out, /ACTIVE/);
  // A wrong token: the node says it was refused, says nothing about why, and does not print it.
  const wrong = secret(); const refused = await f.node(['--coordinator', f.url, '--token', wrong, '--state-dir', state('d')]); outputs.push(refused.out, refused.err, wrong);
  assert.equal(refused.code, 1); assert.match(refused.err, /Enrollment failed: The enrollment token was refused/); assert.equal(refused.err.includes(wrong), false); assert.equal(refused.out, '');
  // Usage and configuration problems exit 78 (a service manager does not restart-loop on it) and quote nothing.
  const cases: Array<[string[], NodeJS.ProcessEnv, RegExp]> = [
    [['--coordinator', f.url], {}, /token is required/],
    [['--coordinator', f.url, '--token', 'abc'], {}, /expected form/],
    [['--token', secret()], {}, /--coordinator is required/],
    [['--coordinator', 'http://example.com', '--token', secret()], {}, /https/],
    [['--coordinator', 'https://user:pw@host', '--token', secret()], {}, /https/],
    [['--coordinator', f.url, '--token', secret(), '--capabilities', 'shell.exec'], {}, /capability names/],
    [['--coordinator', f.url, '--token', secret(), '--token-stdin'], {}, /one way only/],
    [['--coordinator', f.url, '--bogus', 'x'], {}, /unknown option --bogus/],
    [['--coordinator', f.url, `--bogus=${secret()}`], {}, /unknown option --bogus\b(?!=)/], // a value after = is never echoed
    [['--coordinator'], {}, /needs a value/],
  ];
  for (const [args, env, message] of cases) {
    const result = await f.node(args, env); outputs.push(result.out, result.err); assert.equal(result.code, 78, args.join(' ')); assert.match(result.err, message);
    assert.equal(result.err.includes('user:pw'), false, 'a credential in an address is never echoed');
  }
  const help = await f.node(['--help']); assert.equal(help.code, 0); assert.match(help.out, /Usage: privanet-node enroll/);
  const unreachable = await f.node(['--coordinator', 'http://127.0.0.1:9', '--token', secret(), '--state-dir', state('e')]); outputs.push(unreachable.err); assert.equal(unreachable.code, 1); assert.match(unreachable.err, /refused the connection|not reachable|could not be reached/);
  const refusedTls = await f.node(['--coordinator', 'https://127.0.0.1:1', '--token', secret(), '--state-dir', state('f')], { PRIVANODE_ALLOW_INSECURE_LOOPBACK: 'false' }); outputs.push(refusedTls.err); assert.equal(refusedTls.code, 1);
  for (const text of outputs) assert.equal(text.includes(f.adminSecret), false);
  for (const token of [viaStdin, viaEnv, viaFlag]) for (const text of outputs) assert.equal(text.includes(token), false, 'no output ever contains an enrollment token');
  assert.equal(JSON.stringify(f.coordinatorLogs).includes(viaFlag), false);
  assert.equal((await f.admin(['nodes', 'list'])).out.split('\n').filter(line => line.includes('node_')).length, 3);
});
