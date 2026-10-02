import test, { after, before } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer as createHttpsServer } from 'node:https';
import { createServer as createHttpServer } from 'node:http';
import { promisify } from 'node:util';
import { existsSync, readFileSync, readdirSync, statSync, lstatSync, readlinkSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GOOD_CERT, GOOD_KEY } from './doctor-fixture.js';
import { listenAny, realCoordinator } from './tls-harness.js';

// The Linux installer (deploy/install/install-node.sh), as packaged and stamped by scripts/package-release.mjs, run as a user against a staged root (--root: no account, no service, no sudo),
// downloading from a real HTTPS server and enrolling with a real Coordinator behind TLS. The real-account and real-systemd run is tests/installer-system.test.ts.
const exec = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));
const skip = process.platform === 'linux' ? undefined : 'the Linux installer runs on Linux';
const version = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }).version;
const ARCHIVE = `privanet-${version}-linux.tar.gz`;
interface Run { code: number; out: string; err: string }

let releaseDir = ''; let workDir = '';
before(async () => {
  if (skip) return;
  workDir = await mkdtemp(join(tmpdir(), 'privanet-installer-test-')); releaseDir = join(workDir, 'release'); await mkdir(releaseDir);
  await exec(process.execPath, ['scripts/package-release.mjs', 'linux', releaseDir], { cwd: root });
  await exec('tar', ['-czf', join(releaseDir, ARCHIVE), '-C', releaseDir, `privanet-${version}-linux`]);
  await rm(join(releaseDir, `privanet-${version}-linux`), { recursive: true, force: true });
  await writeSums(releaseDir);
  await writeFile(join(workDir, 'good.crt'), GOOD_CERT);
});
after(async () => { if (workDir) await rm(workDir, { recursive: true, force: true }); });
const sha = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
async function writeSums(dir: string, mutate: (lines: string[]) => string[] = lines => lines) {
  const lines = ['install-node.sh', ARCHIVE].map(name => `${sha(readFileSync(join(dir, name)))}  ${name}`);
  await writeFile(join(dir, 'SHA256SUMS.txt'), mutate(lines).join('\n') + '\n');
}

type Override = (original: Buffer) => Buffer | { status: number; headers?: Record<string, string> };
/** An HTTPS release server (a real certificate the installer is told to trust), recording what was asked for. Over `files` (a directory), `override` can change any file's answer. */
async function releaseServer(t: TestContext, dir: string, override: Record<string, Override> = {}) {
  const requests: string[] = [];
  const server = createHttpsServer({ cert: GOOD_CERT, key: GOOD_KEY }, (req, res) => {
    requests.push(req.url ?? ''); const name = (req.url ?? '').split('/').pop() ?? ''; const file = join(dir, name);
    if (!(req.url ?? '').startsWith(`/releases/v${version}/`) || !existsSync(file)) { res.writeHead(404); res.end('no'); return; }
    let body: Buffer | { status: number; headers?: Record<string, string> } = readFileSync(file); const hook = override[name]; if (hook) body = hook(body);
    if (Buffer.isBuffer(body)) { res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.end(body); } else { res.writeHead(body.status, body.headers ?? {}); res.end(); }
  });
  const port = await listenAny(server); t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  return { url: `https://localhost:${port}/releases/v${version}`, requests, port };
}
/** Runs the installer with `sh`, in a sandbox: its own TMPDIR (so leftovers are visible), root and environment. */
function installer(sandbox: { tmp: string; root: string }, args: string[], env: NodeJS.ProcessEnv = {}, input?: string, script = join(releaseDir, 'install-node.sh')): { done: Promise<Run>; child: ReturnType<typeof spawn>; seen: { out: string; err: string } } {
  const child = spawn('/bin/sh', [script, ...args], { cwd: sandbox.root, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: sandbox.root, TMPDIR: sandbox.tmp, PRIVANET_DOWNLOAD_CA: join(workDir, 'good.crt'), PRIVANET_NODE_MIN: '22.0.0', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const seen = { out: '', err: '' }; child.stdout.on('data', (chunk: Buffer) => { seen.out += chunk.toString(); }); child.stderr.on('data', (chunk: Buffer) => { seen.err += chunk.toString(); });
  child.stdin.on('error', () => undefined); child.stdin.end(input ?? '');
  return { child, seen, done: new Promise<Run>(resolve => child.once('close', code => resolve({ code: code ?? -1, out: seen.out, err: seen.err }))) };
}
async function sandbox(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'privanet-installer-sandbox-')); const tmp = join(dir, 'tmp'); const rootDir = join(dir, 'root'); await mkdir(tmp); await mkdir(rootDir); t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, tmp, root: rootDir, leftovers: () => readdirSync(tmp), files: (): string[] => { const out: string[] = []; const walk = (p: string) => { for (const entry of readdirSync(p, { withFileTypes: true })) { const full = join(p, entry.name); if (entry.isDirectory()) walk(full); else if (entry.isFile()) out.push(full); } }; walk(rootDir); return out; } };
}
const common = (base: string, extra: string[] = []) => ['--root', '', '--release-base-url', base, ...extra];
const withRoot = (sb: { root: string }, args: string[]) => args.map((arg, index) => (args[index - 1] === '--root' ? sb.root : arg));

test('the installer is stamped with its release, passes shell syntax checks, and never takes a secret as an argument', { skip }, async () => {
  const stamped = readFileSync(join(releaseDir, 'install-node.sh'), 'utf8'); const template = readFileSync(join(root, 'deploy', 'install', 'install-node.sh'), 'utf8');
  assert.match(stamped, new RegExp(`^VERSION_STAMP='${version.replaceAll('.', '\\.')}'$`, 'm')); assert.match(template, /^VERSION_STAMP='@PRIVANET_VERSION@'$/m); assert.equal(stamped.replace(`VERSION_STAMP='${version}'`, "VERSION_STAMP='@PRIVANET_VERSION@'"), template, 'stamping changes only the version');
  assert.equal((statSyncMode(join(releaseDir, 'install-node.sh')) & 0o111) !== 0, true);
  for (const shell of ['sh', 'dash', 'bash']) { try { execFileSync(shell, ['-n', join(releaseDir, 'install-node.sh')], { stdio: 'pipe' }); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; } }
  // No option takes a secret value, and no command line is built from one.
  assert.doesNotMatch(template, /--invite\)|--invite |--token\)|--token /, 'there is no --invite VALUE or --token VALUE'); assert.doesNotMatch(template, /set -x|set -o xtrace/);
  for (const line of template.split('\n').filter(candidate => /SECRET/.test(candidate) && /\$NODE_CMD/.test(candidate))) assert.match(line, /printf '%s\\n' "\$SECRET" \|/, `the secret only ever goes through a pipe: ${line.trim()}`);
  try { execFileSync('shellcheck', ['--shell=sh', '--severity=warning', join(releaseDir, 'install-node.sh')], { stdio: 'pipe' }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { if (process.env.PRIVANET_REQUIRE_SHELLCHECK === '1') assert.fail('shellcheck is required here (PRIVANET_REQUIRE_SHELLCHECK=1) but is not installed'); } else throw new Error(`shellcheck: ${String((error as { stdout?: Buffer }).stdout)}`, { cause: error }); }
});
function statSyncMode(path: string): number { return statSync(path).mode; }

test('pinning: the installer asks for its own release, and refuses to run unpinned or against anything but https', { skip }, async t => {
  const sb = await sandbox(t); const server = await releaseServer(t, releaseDir);
  const unpinned = await installer(sb, ['--coordinator', 'https://x.example', '--dry-run'], {}, undefined, join(root, 'deploy', 'install', 'install-node.sh')).done;
  assert.equal(unpinned.code, 2); assert.match(unpinned.err, /not pinned to a release/);
  const dry = await installer(sb, withRoot(sb, [...common(server.url), '--coordinator', 'https://x.example', '--dry-run'])).done; assert.equal(dry.code, 0, dry.err);
  assert.deepEqual(server.requests.map(path => path.split('/releases/')[1]), [`v${version}/SHA256SUMS.txt`, `v${version}/${ARCHIVE}`], 'it asked for exactly its own release, checksums first');
  assert.match(dry.out, new RegExp(`verified: SHA-256 [0-9a-f]{64}`)); assert.match(dry.out, /Dry run: nothing was installed/); assert.deepEqual(sb.files(), [], 'a dry run changes nothing'); assert.deepEqual(sb.leftovers(), []);
  // Another release is asked for by name, and pinned the same way.
  const other = await installer(sb, withRoot(sb, ['--root', '', '--release-base-url', `https://localhost:${server.port}/releases/v9.9.9`, '--version', '9.9.9', '--coordinator', 'https://x.example', '--dry-run'])).done; assert.equal(other.code, 5);
  assert.ok(server.requests.some(path => path.includes('/v9.9.9/')));
  for (const [args, message] of [[['--coordinator', 'https://x.example', '--version', 'latest'], /not a release version/], [['--coordinator', 'https://x.example', '--version', '1.2'], /not a release version/], [['--coordinator', 'http://x.example'], /https/], [['--coordinator', 'https://user:pw@x.example'], /no credentials/],
    [['--coordinator', 'https://x.example', '--release-base-url', 'http://mirror.example/r'], /https/], [['--coordinator', 'https://x.example', '--sha256', 'abc'], /64 hexadecimal/], [['--coordinator', 'https://x.example', '--slots', 'many'], /number/], [[], /--coordinator is required/],
    [['--coordinator', 'https://x.example', '--bogus=hunter2'], /unknown option/], [['--coordinator', 'https://x.example', '--invite-file', '/nonexistent'], /cannot read the invite file/], [['--coordinator', 'https://x.example', '--join', '--invite-stdin'], /one way to enroll/]] as const) {
    const result = await installer(sb, withRoot(sb, ['--root', '', ...args])).done; assert.equal(result.code, 2, args.join(' ')); assert.match(result.err, message); assert.equal((result.out + result.err).includes('hunter2'), false, 'an option that was not understood is never echoed');
  }
  assert.deepEqual(sb.leftovers(), []);
});

test('platform: only Linux on x86-64 or arm64 with a new enough Node.js, and clear messages otherwise', { skip }, async t => {
  const sb = await sandbox(t); const server = await releaseServer(t, releaseDir); const run = (env: NodeJS.ProcessEnv, extra: string[] = []) => installer(sb, withRoot(sb, [...common(server.url), '--coordinator', 'https://x.example', '--dry-run', ...extra]), env).done;
  for (const arch of ['x86_64', 'amd64', 'aarch64', 'arm64']) assert.equal((await run({ PRIVANET_FAKE_ARCH: arch })).code, 0, arch);
  for (const arch of ['armv7l', 'i686', 'riscv64', 's390x']) { const result = await run({ PRIVANET_FAKE_ARCH: arch }); assert.equal(result.code, 4, arch); assert.match(result.err, /unsupported CPU architecture/); }
  for (const os of ['Darwin', 'FreeBSD', 'Windows_NT']) { const result = await run({ PRIVANET_FAKE_OS: os }); assert.equal(result.code, 4, os); assert.match(result.err, /for Linux/); }
  const old = join(sb.dir, 'node-old'); await writeFile(old, '#!/bin/sh\necho v20.1.0\n', { mode: 0o755 });
  const tooOld = await run({ PRIVANET_NODE_BIN: old, PRIVANET_NODE_MIN: '24.4.0' }); assert.equal(tooOld.code, 4); assert.match(tooOld.err, /too old.*24\.4\.0/);
  const missing = await run({ PRIVANET_NODE_BIN: join(sb.dir, 'no-node') }); assert.equal(missing.code, 4); assert.match(missing.err, /Node\.js .* is required/);
  const bare = join(sb.dir, 'no-curl-bin'); await mkdir(bare);
  for (const tool of ['uname', 'id', 'dirname', 'basename', 'sed', 'grep', 'awk', 'tar', 'mktemp', 'install', 'head', 'tr', 'cat', 'date', 'sha256sum', 'rm', 'mkdir', 'chmod', 'cp', 'ln', 'mv', 'printf', 'env', 'sleep', 'readlink', 'find']) { const found = ['/usr/bin', '/bin'].map(dir => join(dir, tool)).find(candidate => existsSync(candidate)); if (found) await symlink(found, join(bare, tool)); }
  const noCurl = await run({ PATH: bare }); assert.equal(noCurl.code, 4); assert.match(noCurl.err, /missing required command/);
  assert.deepEqual(sb.files(), []); assert.deepEqual(sb.leftovers(), []);
});

test('verification: anything that does not match what was published is refused before anything is unpacked or installed', { skip }, async t => {
  const sb = await sandbox(t); const clean = async (what: string, code: number, run: Run) => { assert.equal(run.code, code, `${what}: ${run.err}`); assert.deepEqual(sb.files(), [], `${what}: nothing installed`); assert.deepEqual(sb.leftovers(), [], `${what}: no temporary files left`); };
  const args = (server: { url: string }, extra: string[] = []) => withRoot(sb, [...common(server.url), '--coordinator', 'https://x.example', '--install-only', ...extra]);
  const flip = (data: Buffer) => { const copy = Buffer.from(data); copy[copy.length - 20] = (copy[copy.length - 20] ?? 0) ^ 0xff; return copy; };
  const tampered = await installer(sb, args(await releaseServer(t, releaseDir, { [ARCHIVE]: flip }))).done; await clean('a tampered archive', 3, tampered); assert.match(tampered.err, /does not match its published checksum/);
  const truncated = await installer(sb, args(await releaseServer(t, releaseDir, { [ARCHIVE]: data => data.subarray(0, data.length - 1000) }))).done; await clean('a truncated archive', 3, truncated);
  const swapped = await installer(sb, args(await releaseServer(t, releaseDir, { 'SHA256SUMS.txt': () => Buffer.from(`${'0'.repeat(64)}  ${ARCHIVE}\n`) }))).done; await clean('a wrong published checksum', 3, swapped);
  const missingLine = await installer(sb, args(await releaseServer(t, releaseDir, { 'SHA256SUMS.txt': () => Buffer.from(`${'1'.repeat(64)}  something-else.tar.gz\n`) }))).done; await clean('no entry', 3, missingLine); assert.match(missingLine.err, /does not list .* exactly once/);
  const twice = await installer(sb, args(await releaseServer(t, releaseDir, { 'SHA256SUMS.txt': original => Buffer.concat([original, original]) }))).done; await clean('two entries', 3, twice);
  const garbled = await installer(sb, args(await releaseServer(t, releaseDir, { 'SHA256SUMS.txt': () => Buffer.from(`not-a-hash  ${ARCHIVE}\n`) }))).done; await clean('a malformed hash', 3, garbled); assert.match(garbled.err, /malformed/);
  const good = await releaseServer(t, releaseDir);
  const wrongPin = await installer(sb, args(good, ['--sha256', 'f'.repeat(64)])).done; await clean('a wrong --sha256 pin', 3, wrongPin); assert.match(wrongPin.err, /--sha256 you gave/);
  // The right pin passes (and is shown to have been matched), in either letter case; the archive is genuine.
  const archiveSha = sha(readFileSync(join(releaseDir, ARCHIVE)));
  for (const pin of [archiveSha, archiveSha.toUpperCase()]) { const ok = await installer(sb, withRoot(sb, [...common(good.url), '--coordinator', 'https://x.example', '--dry-run', '--sha256', pin])).done; assert.equal(ok.code, 0, ok.err); assert.match(ok.out, /matches your pin/); }
  // A genuine checksum for a hostile archive (published by someone who controls the release location) still cannot escape or omit what a node needs: every path must be inside the release directory.
  const evilDir = join(sb.dir, 'evil'); await mkdir(evilDir); await writeFile(join(evilDir, 'install-node.sh'), 'x');
  for (const [name, python] of [['traversal', `import tarfile,io\nt=tarfile.open('${join(evilDir, ARCHIVE)}','w:gz')\nfor n in ['privanet-${version}-linux/bin/privanet-node','../evil']:\n  i=tarfile.TarInfo(n); i.size=1; t.addfile(i, io.BytesIO(b'x'))\nt.close()`],
    ['absolute', `import tarfile,io\nt=tarfile.open('${join(evilDir, ARCHIVE)}','w:gz')\ni=tarfile.TarInfo('/etc/evil'); i.size=1; t.addfile(i, io.BytesIO(b'x'))\nt.close()`],
    ['incomplete', `import tarfile,io\nt=tarfile.open('${join(evilDir, ARCHIVE)}','w:gz')\ni=tarfile.TarInfo('privanet-${version}-linux/README.md'); i.size=1; t.addfile(i, io.BytesIO(b'x'))\nt.close()`]] as const) {
    try { execFileSync('python3', ['-c', python]); } catch { continue; } // python3 builds the hostile archive; without it this case is skipped
    await writeSums(evilDir); const hostile = await installer(sb, args(await releaseServer(t, evilDir))).done; await clean(`a ${name} archive`, 3, hostile); assert.match(hostile.err, /unexpected paths|missing/);
    await rm(join(evilDir, ARCHIVE), { force: true });
  }
  // Dry runs verify just as strictly.
  const dryTampered = await installer(sb, withRoot(sb, [...common((await releaseServer(t, releaseDir, { [ARCHIVE]: flip })).url), '--coordinator', 'https://x.example', '--dry-run'])).done; await clean('a tampered archive in a dry run', 3, dryTampered);
});

test('downloads: a missing file, an unreachable server, an untrusted certificate and a redirect to plain http all fail closed', { skip }, async t => {
  const sb = await sandbox(t); const args = (url: string) => withRoot(sb, [...common(url), '--coordinator', 'https://x.example', '--install-only']);
  const absent = await installer(sb, args(`https://localhost:${(await releaseServer(t, releaseDir)).port}/releases/v0.0.1`)).done; assert.equal(absent.code, 5);
  const closed = await mkdtemp(join(tmpdir(), 'x')); await rm(closed, { recursive: true }); const dead = await installer(sb, args('https://127.0.0.1:1/releases/v1')).done; assert.equal(dead.code, 5); assert.match(dead.err, /could not download/);
  const trusted = await releaseServer(t, releaseDir); const untrusted = await installer(sb, args(trusted.url), { PRIVANET_DOWNLOAD_CA: '' }).done; assert.equal(untrusted.code, 5, 'a certificate that is not trusted is a failed download, never a downgrade');
  // A server that redirects to plain http: curl is told it may not follow it.
  const plain = createHttpServer((_req, res) => { res.writeHead(200); res.end('x'); }); const plainPort = await listenAny(plain); t.after(() => { plain.close(); });
  const redirect = await releaseServer(t, releaseDir, { 'SHA256SUMS.txt': () => ({ status: 302, headers: { location: `http://127.0.0.1:${plainPort}/SHA256SUMS.txt` } }) });
  const downgraded = await installer(sb, args(redirect.url)).done; assert.equal(downgraded.code, 5);
  assert.deepEqual(sb.files(), []); assert.deepEqual(sb.leftovers(), []);
});

const reserve = async (t: TestContext, caps: 'system.echo.v1'[] = ['system.echo.v1']) => {
  const sb = await sandbox(t); const server = await releaseServer(t, releaseDir); const c = await realCoordinator(t);
  const base = (extra: string[]) => withRoot(sb, [...common(server.url), '--coordinator', c.url, '--ca-file', join(workDir, 'good.crt'), ...extra]);
  const invite = (label = 'Contributor PC') => c.core.createInvite({ expiresInMs: 600000, capabilities: caps, label });
  return { sb, server, c, base, invite };
};
const nodeIdOf = (sb: { root: string }) => (JSON.parse(readFileSync(join(sb.root, 'var', 'lib', 'privanet-node', 'identity.json'), 'utf8')) as { nodeId: string }).nodeId;

test('an invite installs and enrolls a node: layout, permissions, configuration, no secret anywhere, node signs in from the installed files', { skip }, async t => {
  const { sb, base, invite, c } = await reserve(t); const made = invite(); const code = made.code; const plain = code.replace('-', '');
  const run = await installer(sb, base(['--invite-stdin']), {}, `${code.toLowerCase()}\n`).done; assert.equal(run.code, 0, run.err + run.out); assert.match(run.out, /Enrolled\./); assert.match(run.out, /Name:\s+Contributor PC/);
  const opt = join(sb.root, 'opt', 'privanet-node'); assert.equal(readlinkSync(join(opt, 'current')), version); assert.ok(existsSync(join(opt, version, 'bin', 'privanet-node'))); assert.ok(existsSync(join(opt, version, 'node_modules', '@privanet', 'node', 'dist', 'main.js')));
  const etc = join(sb.root, 'etc', 'privanet'); const state = join(sb.root, 'var', 'lib', 'privanet-node');
  assert.equal(statSync(join(etc, 'node.env')).mode & 0o777, 0o600); assert.equal(statSync(state).mode & 0o777, 0o700); assert.equal(statSync(join(state, 'identity.json')).mode & 0o777, 0o600); assert.equal(statSync(join(state, 'enrollment.json')).mode & 0o777, 0o600);
  const env = readFileSync(join(etc, 'node.env'), 'utf8'); assert.match(env, new RegExp(`PRIVANODE_COORDINATOR_URL=${c.url.replaceAll('.', '\\.')}`)); assert.match(env, /PRIVANODE_STATE_DIR=\/var\/lib\/privanet-node/); assert.match(env, /NODE_EXTRA_CA_CERTS=\/etc\/privanet\/privanet-root\.crt/);
  assert.doesNotMatch(env, /TOKEN|INVITE|[0-9a-f]{64}/); assert.equal(readFileSync(join(etc, 'node-policy.json'), 'utf8'), readFileSync(join(root, 'deploy', 'policy', 'desktop-node.json'), 'utf8'), 'the shipped desktop policy');
  const unit = readFileSync(join(sb.root, 'etc', 'systemd', 'system', 'privanet-node.service'), 'utf8');
  for (const line of ['User=privanet-node', 'EnvironmentFile=/etc/privanet/node.env', 'ExecStart=/opt/privanet-node/current/bin/privanet-node', 'StateDirectory=privanet-node', 'StateDirectoryMode=0700', 'NoNewPrivileges=yes', 'ProtectSystem=strict', 'RestartPreventExitStatus=78']) assert.ok(unit.includes(line), line);
  assert.match(unit, /^Environment=PATH=.*:\/usr\/bin:\/bin$/m);
  // The invite: spent, labelled; nothing anywhere holds it.
  assert.equal(c.core.listInvites()[0]?.status, 'USED'); assert.equal(c.core.listNodes()[0]?.displayName, 'Contributor PC');
  assert.deepEqual(sb.leftovers(), [], 'no temporary files left behind');
  for (const file of sb.files()) { const bytes = readFileSync(file); for (const needle of [code, plain, plain.toLowerCase()]) assert.equal(bytes.includes(needle), false, `${file} must not hold the invite`); }
  for (const text of [run.out, run.err]) for (const needle of [code, plain]) assert.equal(text.includes(needle), false);
  // The installed program signs in, from nothing but its state directory (as the service would).
  const daemon = spawn(join(opt, 'current', 'bin', 'privanet-node'), [], { env: { PATH: process.env.PATH ?? '', PRIVANODE_STATE_DIR: state, NODE_EXTRA_CA_CERTS: join(etc, 'privanet-root.crt'), PRIVANODE_HEARTBEAT_MS: '100', PRIVANODE_POLL_MS: '50' }, stdio: ['ignore', 'pipe', 'pipe'] }); t.after(() => { daemon.kill('SIGKILL'); });
  let log = ''; daemon.stdout.on('data', (chunk: Buffer) => { log += chunk.toString(); }); daemon.stderr.on('data', (chunk: Buffer) => { log += chunk.toString(); });
  const deadline = Date.now() + 15000; while (!log.includes('node.authenticated') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50)); assert.ok(log.includes('node.authenticated'), log);
});

test('every way of giving the secret works and none is an argument: file, environment, standard input, token file and token', { skip }, async t => {
  const { sb, base, invite, c } = await reserve(t); const secretsSeen: string[] = [];
  const inviteFile = join(sb.dir, 'invite'); const first = invite('A'); await writeFile(inviteFile, `${first.code}\n`, { mode: 0o600 }); secretsSeen.push(first.code.replace('-', ''));
  const a = await installer(sb, base(['--invite-file', inviteFile])).done; assert.equal(a.code, 0, a.err + a.out); assert.ok(existsSync(inviteFile), "the user's own file is left alone");
  await installer(sb, ['--root', sb.root, '--uninstall', '--purge']).done;
  const second = invite('B'); secretsSeen.push(second.code.replace('-', '')); const b = await installer(sb, base([]), { PRIVANET_INVITE_CODE: second.code }).done; assert.equal(b.code, 0, b.err + b.out); assert.match(b.out, /Name:\s+B/);
  await installer(sb, ['--root', sb.root, '--uninstall', '--purge']).done;
  const token = c.core.createEnrollment({ expiresInMs: 600000, capabilities: ['system.echo.v1'] }).token; secretsSeen.push(token);
  const viaStdin = await installer(sb, base(['--token-stdin']), {}, `${token}\n`).done; assert.equal(viaStdin.code, 0, viaStdin.err + viaStdin.out);
  await installer(sb, ['--root', sb.root, '--uninstall', '--purge']).done;
  const tokenFile = join(sb.dir, 'token'); const next = c.core.createEnrollment({ expiresInMs: 600000, capabilities: ['system.echo.v1'] }).token; await writeFile(tokenFile, next, { mode: 0o600 }); secretsSeen.push(next);
  const viaFile = await installer(sb, base(['--token-file', tokenFile])).done; assert.equal(viaFile.code, 0, viaFile.err + viaFile.out);
  for (const text of [a, b, viaStdin, viaFile].flatMap(run => [run.out, run.err])) for (const secretValue of secretsSeen) assert.equal(text.includes(secretValue), false);
  for (const file of sb.files()) for (const secretValue of secretsSeen) assert.equal(readFileSync(file).includes(secretValue), false, file);
  // A secret in the wrong form is refused before anything is downloaded or changed.
  await installer(sb, ['--root', sb.root, '--uninstall', '--purge']).done;
  for (const [value, message] of [['hello', /does not look like an invite/], ['N7K4-PQ2!', /does not look like an invite/], ['', /empty|invite/]] as const) { const bad = await installer(sb, base(['--invite-stdin']), {}, `${value}\n`).done; assert.equal(bad.code, 2, value); assert.match(bad.err, message); }
  assert.deepEqual(sb.leftovers(), []);
});

test('a wrong invite fails cleanly: nothing secret stored, temporary files gone, and the same installation can be finished with a good one', { skip }, async t => {
  const { sb, base, invite } = await reserve(t); const bad = await installer(sb, base(['--invite-stdin']), {}, 'AAAA-AAAA\n').done;
  assert.equal(bad.code, 7); assert.match(bad.err + bad.out, /The invite code was refused/); assert.deepEqual(sb.leftovers(), []); assert.equal(existsSync(join(sb.root, 'var', 'lib', 'privanet-node', 'enrollment.json')), false);
  const again = await installer(sb, base(['--upgrade', '--invite-stdin']), {}, `${invite().code}\n`).done; assert.equal(again.code, 0, again.err + again.out); assert.match(again.out, /Enrolled\./);
});

test('joining by approval installs the node and waits for the owner, with no secret involved', { skip }, async t => {
  const { sb, base, c } = await reserve(t); const run = installer(sb, base(['--join', '--name', 'garage pc']));
  const deadline = Date.now() + 20000; while (!/Request code:\s+[0-9A-Z]{4}-[0-9A-Z]{4}/.test(run.seen.out) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  const code = /Request code:\s+([0-9A-Z]{4}-[0-9A-Z]{4})/.exec(run.seen.out)?.[1] ?? ''; assert.ok(code, run.seen.out + run.seen.err);
  assert.equal(c.core.listRequests()[0]?.deviceName, 'garage pc'); assert.equal(c.core.listNodes().length, 0, 'nothing is enrolled before approval');
  c.core.approveRequest(code, { capabilities: ['system.echo.v1'], label: 'Approved PC' }); const done = await run.done; assert.equal(done.code, 0, done.err + done.out); assert.match(done.out, /Name:\s+Approved PC/);
  assert.equal(c.core.listNodes()[0]?.displayName, 'Approved PC'); assert.deepEqual(sb.leftovers(), []);
});

test('an existing installation is never silently replaced: upgrade keeps the identity, a new identity needs --yes and keeps the old state aside, uninstall keeps or purges', { skip }, async t => {
  const { sb, base, invite, c } = await reserve(t); const first = await installer(sb, base(['--invite-stdin']), {}, `${invite('One').code}\n`).done; assert.equal(first.code, 0, first.err); const id = nodeIdOf(sb);
  const refused = await installer(sb, base([])).done; assert.equal(refused.code, 6); assert.match(refused.err, /already installed.*--upgrade/s);
  // Upgrade: program files replaced, identity and enrollment untouched, no secret needed, no second node.
  const marker = join(sb.root, 'opt', 'privanet-node', version, 'marker'); await writeFile(marker, 'x');
  const upgraded = await installer(sb, base(['--upgrade'])).done; assert.equal(upgraded.code, 0, upgraded.err + upgraded.out); assert.match(upgraded.out, /keeping this machine's identity/); assert.equal(nodeIdOf(sb), id); assert.equal(existsSync(marker), false, 'the program files were replaced'); assert.equal(c.core.listNodes().length, 1);
  // A new identity: refused without --yes; with it, the old state is set aside, not deleted, and a new node enrolls.
  const unconfirmed = await installer(sb, base(['--new-identity'])).done; assert.equal(unconfirmed.code, 2); assert.match(unconfirmed.err, /--yes/);
  const fresh = await installer(sb, base(['--new-identity', '--yes', '--invite-stdin']), {}, `${invite('Two').code}\n`).done; assert.equal(fresh.code, 0, fresh.err + fresh.out); assert.notEqual(nodeIdOf(sb), id); assert.equal(c.core.listNodes().length, 2);
  const aside = readdirSync(join(sb.root, 'var', 'lib')).filter(name => name.startsWith('privanet-node.old-')); assert.equal(aside.length, 1, 'the old state is kept'); assert.equal((JSON.parse(readFileSync(join(sb.root, 'var', 'lib', aside[0] ?? '', 'identity.json'), 'utf8')) as { nodeId: string }).nodeId, id);
  assert.match(fresh.out, /ask the owner to revoke that node/);
  // Uninstall keeps the identity unless purged; running it twice is harmless.
  const removed = await installer(sb, ['--root', sb.root, '--uninstall']).done; assert.equal(removed.code, 0); assert.equal(existsSync(join(sb.root, 'opt', 'privanet-node')), false); assert.equal(existsSync(join(sb.root, 'etc', 'privanet', 'node.env')), false); assert.ok(existsSync(join(sb.root, 'var', 'lib', 'privanet-node', 'identity.json')));
  assert.equal((await installer(sb, ['--root', sb.root, '--uninstall']).done).code, 0);
  const purged = await installer(sb, ['--root', sb.root, '--uninstall', '--purge']).done; assert.equal(purged.code, 0); assert.match(purged.out, /revoke this node/); assert.equal(existsSync(join(sb.root, 'var', 'lib', 'privanet-node')), false);
});

test('--install-only installs without enrolling, and an interrupted run leaves no temporary files', { skip }, async t => {
  const { sb, base } = await reserve(t); const only = await installer(sb, base(['--install-only'])).done; assert.equal(only.code, 0, only.err); assert.match(only.out, /without enrolling/); assert.equal(existsSync(join(sb.root, 'var', 'lib', 'privanet-node', 'identity.json')), false);
  assert.ok(lstatSync(join(sb.root, 'opt', 'privanet-node', 'current')).isSymbolicLink());
  // Killed while waiting (a join that nobody approves): the trap removes the temporary directory.
  const sb2 = await sandbox(t); const server = await releaseServer(t, releaseDir); const c = await realCoordinator(t);
  const run = installer(sb2, withRoot(sb2, [...common(server.url), '--coordinator', c.url, '--ca-file', join(workDir, 'good.crt'), '--join'])); const until = Date.now() + 20000; while (!/Request code/.test(run.seen.out) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 50));
  run.child.kill('SIGTERM'); await run.done; await new Promise(resolve => setTimeout(resolve, 200)); assert.deepEqual(sb2.leftovers(), [], 'the temporary directory is removed even when the installer is killed');
});

test('--preset: an unknown preset is refused, a known one is saved as the node\'s own policy before it starts, and the first steps name the panel without any secret', { skip }, async t => {
  const bad = await sandbox(t); const refused = await installer(bad, withRoot(bad, [...common('https://127.0.0.1:1'), '--coordinator', 'https://127.0.0.1:1', '--preset', 'bogus', '--install-only'])).done; assert.equal(refused.code, 2); assert.match(refused.err, /--preset is one of/);
  const { sb, base, invite } = await reserve(t); const code = invite().code;
  const run = await installer(sb, base(['--invite-stdin', '--preset', 'generous']), {}, `${code}\n`).done; assert.equal(run.code, 0, run.err + run.out);
  const state = join(sb.root, 'var', 'lib', 'privanet-node'); const saved = JSON.parse(readFileSync(join(state, 'policy.json'), 'utf8')) as { version: number; preset?: string; policy: { fetch?: { unsafeLocal?: unknown } } };
  assert.equal(saved.version, 1); assert.equal(saved.preset, 'generous'); assert.equal(statSync(join(state, 'policy.json')).mode & 0o777, 0o600); assert.equal(saved.policy.fetch?.unsafeLocal, undefined);
  assert.match(run.out, /open its control panel \(this machine only\) with: .*privanet-node panel/);
  for (const text of [run.out, run.err]) { assert.doesNotMatch(text, /panel-token|#token=/); assert.equal(text.includes(code), false); }
});

test('the privanet-panel helper opens the panel without the sign-in secret ever being an argument, through a private redirect file', { skip }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'privanet-panel-helper-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const secret = 'S3CRET-sign-in-value-0123456789abcdef'; const argvLog = join(dir, 'argv.log'); const copy = join(dir, 'opened.html'); const runtime = join(dir, 'run'); await mkdir(runtime, { mode: 0o700 });
  const fakeNode = join(dir, 'privanet-node'); await writeFile(fakeNode, `#!/bin/sh\necho "$@" >> '${argvLog}'\nif [ "$1" = panel ]; then echo "Control panel: http://127.0.0.1:4040/ (this machine only)"; case "$*" in *--url-only*) ;; *) echo "Sign-in link: http://127.0.0.1:4040/#token=${secret}" ;; esac; fi\n`, { mode: 0o755 });
  const bin = join(dir, 'bin'); await mkdir(bin); const fakeOpen = join(bin, 'xdg-open'); await writeFile(fakeOpen, `#!/bin/sh\necho "$@" >> '${argvLog}'\ncp "$1" '${copy}'\nstat -c %a "$1" > '${copy}.mode'\n`, { mode: 0o755 });
  const me = (await exec('id', ['-un'])).stdout.trim(); const helper = join(root, 'deploy', 'bin', 'privanet-panel');
  const env = { PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`, PRIVANET_NODE_CMD: fakeNode, PRIVANET_SVC_USER: me, XDG_RUNTIME_DIR: runtime, HOME: dir };
  const opened = await exec('/bin/sh', [helper, '--open'], { env }); assert.match(opened.stdout, /Control panel: http:\/\/127\.0\.0\.1:4040\//); assert.equal(opened.stdout.includes(secret), false, 'the secret is not printed when a browser was started');
  const until = Date.now() + 5000; while (!existsSync(`${copy}.mode`) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(readFileSync(`${copy}.mode`, 'utf8').trim(), '600'); assert.ok(readFileSync(copy, 'utf8').includes(secret)); assert.equal(readFileSync(argvLog, 'utf8').includes(secret), false, 'no command line carries the secret');
  const plain = await exec('/bin/sh', [helper, '--url-only'], { env }); assert.equal(plain.stdout.includes(secret), false);
  const noDesktop = await exec('/bin/sh', [helper], { env: { ...env, XDG_RUNTIME_DIR: '' } }); assert.ok(noDesktop.stdout.includes(secret), 'without --open the link is printed for the person who asked');
  await assert.rejects(exec('/bin/sh', [helper, '--bogus'], { env }), (error: { code?: number }) => error.code === 2);
});

test('the desktop entry and the installers wire up the control panel (Linux entry, Start Menu shortcut), all of it loopback-only', { skip }, () => {
  const entry = readFileSync(join(root, 'deploy', 'desktop', 'privanet-panel.desktop'), 'utf8'); assert.match(entry, /^\[Desktop Entry\]$/m); assert.match(entry, /^Exec=\/opt\/privanet-node\/current\/deploy\/bin\/privanet-panel --open$/m); assert.match(entry, /^Type=Application$/m);
  const sh = readFileSync(join(root, 'deploy', 'install', 'install-node.sh'), 'utf8'); const ps = readFileSync(join(root, 'deploy', 'install', 'install-node.ps1'), 'utf8');
  assert.match(sh, /privanet-panel\.desktop/); assert.match(ps, /\[string\]\$Preset/); assert.match(ps, /http:\/\/127\.0\.0\.1:4040\//); assert.doesNotMatch(ps, /http:\/\/0\.0\.0\.0|http:\/\/\[::\]/);
});

// The whole life of a contributor's node, for both ways in: install, enroll, run the INSTALLED node (the service is not systemd in a test, but it is the same program with the same
// files and the installed state), see it ONLINE, stop and start it again with no invite, show the original invite cannot be used again, revoke it and watch it stop.
const nodeProcess = (sb: { root: string }, c: { url: string }) => {
  const installed = join(sb.root, 'opt', 'privanet-node', 'current', 'bin', 'privanet-node'); const state = join(sb.root, 'var', 'lib', 'privanet-node');
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: sb.root, PRIVANODE_STATE_DIR: state, NODE_EXTRA_CA_CERTS: join(workDir, 'good.crt'), PRIVANODE_POLICY_FILE: join(sb.root, 'etc', 'privanet', 'node-policy.json') };
  const start = () => { const child = spawn('/bin/sh', [installed], { env, stdio: ['ignore', 'pipe', 'pipe'] }); let log = ''; child.stdout.on('data', (chunk: Buffer) => { log += chunk.toString(); }); child.stderr.on('data', (chunk: Buffer) => { log += chunk.toString(); }); const exited = new Promise<number>(resolve => child.once('close', code => resolve(code ?? -1))); return { child, exited, log: () => log }; };
  const doctor = () => exec('/bin/sh', [installed, 'doctor', '--coordinator', c.url, '--json'], { env }).then(result => ({ code: 0, out: result.stdout }), (error: { code?: number; stdout?: string }) => ({ code: error.code ?? -1, out: error.stdout ?? '' }));
  return { start, doctor, state };
};
const until = async (what: string, check: () => boolean, ms = 40000) => { const deadline = Date.now() + ms; while (!check()) { if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`); await new Promise(resolve => setTimeout(resolve, 100)); } };

for (const way of ['invite', 'approval'] as const) {
  test(`end to end (${way}): install, enroll, online, restart without the ${way === 'invite' ? 'invite' : 'approval'}, ${way === 'invite' ? 'the invite cannot be reused, ' : ''}revocation stops the node`, { skip, timeout: 180000 }, async t => {
    const { sb, base, c, invite } = await reserve(t); let spent = '';
    if (way === 'invite') {
      const made = invite('Lifecycle PC'); spent = made.code;
      const run = await installer(sb, base(['--invite-stdin']), {}, `${made.code}\n`).done; assert.equal(run.code, 0, run.err + run.out);
    } else {
      const run = installer(sb, base(['--join', '--name', 'Lifecycle PC'])); await until('the request code', () => /Request code:\s+[0-9A-Z]{4}-[0-9A-Z]{4}/.test(run.seen.out), 20000);
      c.core.approveRequest(/Request code:\s+([0-9A-Z]{4}-[0-9A-Z]{4})/.exec(run.seen.out)?.[1] ?? '', { capabilities: ['system.echo.v1'], label: 'Lifecycle PC' });
      const done = await run.done; assert.equal(done.code, 0, done.err + done.out);
    }
    const node = nodeProcess(sb, c); const nodeId = c.core.listNodes()[0]?.nodeId ?? ''; assert.ok(nodeId);
    // The installed node comes ONLINE by itself, from the state the installer made.
    const first = node.start(); await until('the node to be ONLINE', () => c.core.listNodes()[0]?.status === 'ONLINE'); assert.match(first.log(), /node\.authenticated/);
    // Stopped, then started again: it reconnects with no invite and no approval.
    first.child.kill('SIGTERM'); await first.exited;
    const second = node.start(); await until('the node to reconnect', () => /node\.authenticated/.test(second.log())); await until('ONLINE again', () => c.core.listNodes()[0]?.status === 'ONLINE');
    const healthy = await node.doctor(); assert.equal(healthy.code, 0, healthy.out); assert.match(healthy.out, /"id":"registered","label":"At the Coordinator","status":"OK"/);
    // The original invite cannot be used again, from this machine or any other.
    if (way === 'invite') {
      const other = await sandbox(t); const again = await installer(other, withRoot(other, [...common((await releaseServer(t, releaseDir)).url), '--coordinator', c.url, '--ca-file', join(workDir, 'good.crt'), '--invite-stdin']), {}, `${spent}\n`).done;
      assert.equal(again.code, 7, again.err + again.out); assert.match(again.err + again.out, /refused|invite/i); assert.equal(c.core.listNodes().length, 1, 'no second node was created'); assert.deepEqual(other.leftovers(), []);
    }
    // Revoked by the owner: the running node loses its session and cannot get another; the doctor says so.
    c.core.revokeNode(nodeId);
    await until('the revoked node to stop being ONLINE', () => c.core.listNodes()[0]?.status !== 'ONLINE', 70000);
    const revoked = await node.doctor(); assert.doesNotMatch(revoked.out, /"id":"registered","label":"At the Coordinator","status":"OK"/, 'the doctor no longer sees it as registered'); assert.match(revoked.out, /not known to the Coordinator, or was revoked/);
    second.child.kill('SIGTERM'); await second.exited;
    const third = node.start(); await new Promise(resolve => setTimeout(resolve, 4000)); assert.notEqual(c.core.listNodes()[0]?.status, 'ONLINE', 'a restarted revoked node does not come back'); third.child.kill('SIGTERM'); await third.exited;
  });
}

// The real thing, without --root: a service account, real ownership and modes. It changes the machine it runs on (creates the privanet-node user and /opt/privanet-node, /etc/privanet,
// /var/lib/privanet-node), so it only runs where that is expected: as root, with PRIVANET_INSTALLER_SYSTEM=1 (CI sets it, and then a skip is a failure).
const system = process.platform === 'linux' && process.getuid?.() === 0 && process.env.PRIVANET_INSTALLER_SYSTEM === '1';
const systemSkip = !system && (process.env.PRIVANET_REQUIRE_INSTALLER_SYSTEM === '1' ? false : 'set PRIVANET_INSTALLER_SYSTEM=1 and run as root to exercise a real installation');
test('a real installation: service account, ownership and modes, enrollment as that account, uninstall', { skip: systemSkip }, async t => {
  assert.equal(system, true, 'PRIVANET_REQUIRE_INSTALLER_SYSTEM=1 needs root on Linux with PRIVANET_INSTALLER_SYSTEM=1');
  const { sb, server, c, invite } = await reserve(t); const made = invite('System test');
  const args = ['--release-base-url', server.url, '--coordinator', c.url, '--ca-file', join(workDir, 'good.crt'), '--no-service'];
  t.after(() => { try { execFileSync('/bin/sh', [join(releaseDir, 'install-node.sh'), '--uninstall', '--purge'], { cwd: '/', stdio: 'ignore', env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } }); } catch { /* nothing was installed */ } try { execFileSync('userdel', ['privanet-node'], { stdio: 'ignore' }); } catch { /* it was never created */ } });
  const run = await installer(sb, [...args, '--invite-stdin'], {}, `${made.code}\n`).done; assert.equal(run.code, 0, run.err + run.out);
  const id = (flag: string) => execFileSync('id', [flag, 'privanet-node']).toString().trim();
  const owner = (path: string) => { const info = statSync(path); return { uid: String(info.uid), mode: info.mode & 0o777 }; };
  const state = '/var/lib/privanet-node';
  assert.deepEqual(owner(state), { uid: id('-u'), mode: 0o700 }, 'the state directory belongs to the service account and nobody else');
  assert.deepEqual(owner(join(state, 'identity.json')), { uid: id('-u'), mode: 0o600 }, 'the identity was created by the service account');
  assert.deepEqual(owner('/etc/privanet/node.env'), { uid: '0', mode: 0o600 });
  for (const path of ['/opt/privanet-node', '/opt/privanet-node/' + version, '/opt/privanet-node/' + version + '/bin/privanet-node']) { const info = statSync(path); assert.equal(info.uid, 0, path); assert.equal(info.mode & 0o022, 0, `${path} is not writable by the service account or anyone else`); }
  assert.match(execFileSync('getent', ['passwd', 'privanet-node']).toString(), /(nologin|false)$/m, 'no login shell');
  assert.equal(c.core.listInvites()[0]?.status, 'USED');
  // The same installation can be removed again, keeping or deleting the identity.
  const kept = await installer(sb, ['--uninstall']).done; assert.equal(kept.code, 0, kept.err); assert.equal(existsSync(join(state, 'identity.json')), true); assert.equal(existsSync('/opt/privanet-node'), false);
  const purged = await installer(sb, ['--uninstall', '--purge']).done; assert.equal(purged.code, 0, purged.err); assert.equal(existsSync(state), false);
});
