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
import { hash, secret } from '@privanet/shared';
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
  const store = new SqliteStore(join(dir, 'coordinator.sqlite')); const core = new Coordinator(store, { offlineMs: 60000, staleMs: 30000 }, Date.now, undefined, { inviteKey: Buffer.from(hash(`k:${adminSecret}`), 'hex') });
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
  /** A long-running node command whose output can be read as it appears (for `join`, which prints its request code and then waits). */
  const spawnNode = (args: string[], env: NodeJS.ProcessEnv = {}) => {
    const child = spawn(process.execPath, [NODE, ...args], { cwd: root, env: { PATH: process.env.PATH ?? '', PRIVANODE_ALLOW_INSECURE_LOOPBACK: 'true', ...env }, stdio: ['pipe', 'pipe', 'pipe'] }); children.push(child);
    const seen = { out: '', err: '' }; child.stdout.on('data', (chunk: Buffer) => { seen.out += chunk.toString(); }); child.stderr.on('data', (chunk: Buffer) => { seen.err += chunk.toString(); });
    const done = new Promise<number>(resolve => child.once('close', value => resolve(value ?? -1)));
    return { child, seen, done };
  };
  return { dir, url, adminSecret, coordinatorLogs, core, children, spawnNode,
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
    child.kill('SIGTERM'); await new Promise<void>(resolve => child.once('close', () => resolve())); daemons.push(log); if (process.platform !== 'win32') assert.equal(child.exitCode, 0);
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
    [['--coordinator', f.url], {}, /is required/],
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

test('invite flow from the shipped tools: create, hand over, enroll from stdin, reconnect, reuse refused, revoke', async t => {
  const f = await setup(t); const outputs: string[] = []; const stateDir = join(f.dir, 'state');
  const created = await f.admin(['invite', 'create', '--expires', '10m', '--capabilities', 'system.echo.v1', '--label', "Judah's PC"]); outputs.push(created.err); // (the creation output shows the code, once, by design; nothing else may)
  assert.equal(created.code, 0, created.err); assert.match(created.out, /^Invite created\.\n/); assert.match(created.out, /Expires:\s+\d{4}-.*\(in 10m\)/); assert.match(created.out, /Name:\s+Judah's PC/);
  const code = /Code:\s+([0-9A-Z]{4}-[0-9A-Z]{4})/.exec(created.out)?.[1] ?? ''; assert.ok(code); const id = /Invite ID:\s+(inv_[a-f0-9]{16})/.exec(created.out)?.[1] ?? '';
  const listed = await f.admin(['invite', 'list']); outputs.push(listed.out); assert.ok(listed.out.includes(id) && listed.out.includes('ACTIVE')); assert.equal(listed.out.includes(code), false); assert.equal(listed.out.includes(code.replace('-', '')), false);
  const json = await f.admin(['invite', 'list', '--json']); assert.equal(json.out.includes(code), false);
  // The contributor types it however it comes (lower case, a space), through stdin so it is not in the process list.
  const enrolled = await f.node(['--coordinator', f.url, '--invite-stdin', '--state-dir', stateDir], {}, `${code.toLowerCase().replace('-', ' ')}\n`); outputs.push(enrolled.out, enrolled.err);
  assert.equal(enrolled.code, 0, enrolled.err); assert.match(enrolled.out, /^Enrolled\./); assert.match(enrolled.out, /Name:\s+Judah's PC/); assert.equal(enrolled.err, '');
  assert.match((await f.admin(['invite', 'list', '--all'])).out, new RegExp(`${id}\\s+USED`));
  // The daemon needs nothing but its state directory, now and after a restart.
  const policy = join(f.dir, 'policy.json'); await writeFile(policy, JSON.stringify({ reserveMemoryBytes: 0, safetyMarginBytes: 0, reserveCpuPercent: 0, maxCpuPercent: 100, maxMemoryBytes: 1024 ** 3 }));
  for (let start = 0; start < 2; start++) {
    const daemon = f.spawnNode([], { PRIVANODE_STATE_DIR: stateDir, PRIVANODE_POLICY_FILE: policy, PRIVANODE_HEARTBEAT_MS: '50', PRIVANODE_POLL_MS: '20' }); const spawned = daemon.child;
    // (the daemon is started with no subcommand: spawnNode passes no `enroll`)
    const deadline = Date.now() + 15000; while (!daemon.seen.out.includes('node.authenticated') && Date.now() < deadline && spawned.exitCode === null) await new Promise(resolve => setTimeout(resolve, 25));
    assert.ok(daemon.seen.out.includes('node.authenticated'), daemon.seen.out + daemon.seen.err); assert.equal(daemon.seen.out.includes('node.enrolled'), false);
    spawned.kill('SIGTERM'); await daemon.done; outputs.push(daemon.seen.out, daemon.seen.err);
  }
  // Reuse from another machine, and a wrong code, are refused with the same plain sentence; neither prints the code.
  const reused = await f.node(['--coordinator', f.url, '--invite-stdin', '--state-dir', join(f.dir, 'other')], {}, `${code}\n`); outputs.push(reused.out, reused.err);
  assert.equal(reused.code, 1); assert.match(reused.err, /The invite code was refused/); assert.equal(reused.err.includes(code), false);
  const wrong = await f.node(['--coordinator', f.url, '--invite', 'AAAA-AAAA', '--state-dir', join(f.dir, 'other2')]); assert.equal(wrong.code, 1); assert.match(wrong.err, /The invite code was refused/);
  // Revocation reaches the enrolled node.
  const nodeId = /Node ID:\s+(node_[a-f0-9]{64})/.exec(enrolled.out)?.[1] ?? ''; assert.equal((await f.admin(['nodes', 'revoke', nodeId.slice(0, 16)])).code, 0);
  assert.match((await f.admin(['nodes', 'show', nodeId])).out, /REVOKED/);
  for (const text of outputs) { assert.equal(text.includes(code), false); assert.equal(text.includes(code.replace('-', '')), false); assert.equal(text.includes(f.adminSecret), false); }
  assert.equal(JSON.stringify(f.coordinatorLogs).includes(code.replace('-', '')), false);
  // Usage errors: not a code, both a token and an invite, a plain-http address.
  for (const [args, message] of [[['--coordinator', f.url, '--invite', 'N7K4-PQ2U'], /not in the expected form/], [['--coordinator', f.url, '--invite', 'N7K4-PQ2M', '--token', secret()], /not both/], [['--coordinator', 'http://example.com', '--invite', 'N7K4-PQ2M'], /https/]] as const) {
    const result = await f.node([...args], {}); assert.equal(result.code, 78, args.join(' ')); assert.match(result.err, message);
  }
  assert.equal((await f.admin(['invite', 'create', '--expires', '2h'])).code, 1, 'an invite is at most an hour');
  const revokedInvite = await f.admin(['invite', 'revoke', id]); assert.equal(revokedInvite.code, 1, 'a used invite cannot be revoked');
});

test('approval flow from the shipped tools: join shows a code, the owner lists and approves it, the machine finishes and runs', async t => {
  const f = await setup(t); const stateDir = join(f.dir, 'state'); const outputs: string[] = [];
  const join1 = f.spawnNode(['join', '--coordinator', f.url, '--state-dir', stateDir, '--name', 'garage pc']);
  const deadline = Date.now() + 15000; while (!/Request code:\s+[0-9A-Z]{4}-[0-9A-Z]{4}/.test(join1.seen.out) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
  const code = /Request code:\s+([0-9A-Z]{4}-[0-9A-Z]{4})/.exec(join1.seen.out)?.[1] ?? ''; assert.ok(code, join1.seen.out + join1.seen.err);
  const nodeId = /Node ID:\s+(node_[a-f0-9]{64})/.exec(join1.seen.out)?.[1] ?? ''; assert.match(join1.seen.out, /Waiting|Waiting for the owner|waits for them/);
  // The owner sees it, with the node ID to compare, and approves it with a ceiling and a name (typed loosely).
  const waiting = await f.admin(['requests', 'list']); outputs.push(waiting.out); assert.ok(waiting.out.includes(code) && waiting.out.includes('PENDING') && waiting.out.includes(nodeId.slice(0, 13)) && waiting.out.includes('garage pc'));
  assert.equal(join1.child.exitCode, null, 'the machine is still waiting, nothing is enrolled'); assert.match((await f.admin(['nodes', 'list'])).out, /No nodes enrolled/);
  const approved = await f.admin(['approve', code.toLowerCase().replace('-', ' '), '--capabilities', 'system.echo.v1', '--label', "Judah's PC"]); outputs.push(approved.out, approved.err);
  assert.equal(approved.code, 0, approved.err); assert.match(approved.out, new RegExp(`Approved ${code}`));
  assert.equal(await join1.done, 0, join1.seen.err); assert.match(join1.seen.out, /Enrolled\./); assert.match(join1.seen.out, /Name:\s+Judah's PC/);
  assert.match((await f.admin(['nodes', 'show', "Judah's PC"])).out, new RegExp(nodeId)); assert.match((await f.admin(['requests', 'list', '--all'])).out, /COMPLETED/);
  // It starts from its state directory alone.
  const daemon = f.spawnNode([], { PRIVANODE_STATE_DIR: stateDir, PRIVANODE_HEARTBEAT_MS: '50', PRIVANODE_POLL_MS: '20' });
  const until = Date.now() + 15000; while (!daemon.seen.out.includes('node.authenticated') && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 25));
  assert.ok(daemon.seen.out.includes('node.authenticated')); daemon.child.kill('SIGTERM'); await daemon.done;
  // A second machine is denied; its join command says so and exits non-zero.
  const second = f.spawnNode(['join', '--coordinator', f.url, '--state-dir', join(f.dir, 'state2')]);
  const again = Date.now() + 15000; while (!/Request code:/.test(second.seen.out) && Date.now() < again) await new Promise(resolve => setTimeout(resolve, 25));
  const secondCode = /Request code:\s+([0-9A-Z]{4}-[0-9A-Z]{4})/.exec(second.seen.out)?.[1] ?? ''; assert.ok(secondCode);
  const denied = await f.admin(['deny', ...secondCode.split('-')]); assert.equal(denied.code, 0, denied.err); assert.equal(await second.done, 1); assert.match(second.seen.err, /owner declined/);
  assert.match((await f.admin(['requests', 'list', '--all'])).out, /DENIED/);
  // Bad input to the admin side.
  for (const bad of [['approve', 'nope', '--capabilities', 'system.echo.v1'], ['approve', code], ['approve', 'AAAA-AAAA', '--capabilities', 'system.echo.v1'], ['deny']]) assert.equal((await f.admin(bad)).code, 1, bad.join(' '));
  for (const text of [join1.seen.out, join1.seen.err, second.seen.out, second.seen.err, daemon.seen.out, ...outputs]) assert.equal(text.includes(f.adminSecret), false);
  // `join --help` and bad flags.
  assert.equal((await f.node(['--help'])).code, 0); const badFlag = await f.spawnNode(['join', '--token', 'x']).done; assert.equal(badFlag, 78);
});
