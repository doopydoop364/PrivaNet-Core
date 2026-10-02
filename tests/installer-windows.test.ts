import test, { after, before } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer as createHttpsServer } from 'node:https';
import { promisify } from 'node:util';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GOOD_CERT, GOOD_KEY } from './doctor-fixture.js';
import { listenAny, realCoordinator } from './tls-harness.js';

// The Windows installer (deploy/install/install-node.ps1). The static checks run everywhere. The runs of the script itself need Windows PowerShell and run only on Windows (the `foundation`
// matrix job on windows-latest, where PRIVANET_REQUIRE_WINDOWS_INSTALLER=1 turns a skip into a failure). They use -Root (a staged tree: no service, no ACL changes) and a real HTTPS release server
// and Coordinator. Registering the scheduled task and the ACLs need an elevated machine and are exercised by the manual checklist in docs/INSTALLER.md, not by these tests.
const exec = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));
const version = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }).version;
const ARCHIVE = `privanet-${version}-windows.zip`;
const required = process.env.PRIVANET_REQUIRE_WINDOWS_INSTALLER === '1';
const skip = process.platform === 'win32' ? undefined : required ? undefined : 'the Windows installer runs on Windows';
interface Run { code: number; out: string; err: string }

const template = readFileSync(join(root, 'deploy', 'install', 'install-node.ps1'), 'utf8');

test('the Windows installer template has one version stamp, never takes a secret as a parameter, and keeps no history of one', () => {
  assert.equal((template.match(/^\$VersionStamp = '@PRIVANET_VERSION@'$/gm) ?? []).length, 1);
  // Parameters: none of them carries a secret value.
  const params = /\[CmdletBinding\(\)\]\s*param\(([\s\S]*?)\n\)/.exec(template)?.[1] ?? '';
  assert.ok(params.length > 100, 'the param block was found');
  assert.doesNotMatch(params, /\$(Invite|Token|Secret|Password)\b/i, 'no parameter holds an invite or token itself (only a FILE)');
  assert.match(params, /\$InviteFile/); assert.match(params, /\$TokenFile/);
  assert.doesNotMatch(template, /Start-Transcript|Invoke-Expression|\biex\b|Set-PSDebug|Write-Host\s+\$secret|Say\s+\$secret|DownloadString/i);
  assert.doesNotMatch(template, /-ExecutionPolicy\s+Unrestricted/i);
  assert.doesNotMatch(template, /ServerCertificateValidationCallback\s*=\s*\{\s*\$true\s*\}/, 'certificate verification is never switched off');
  // The only place the certificate callback is installed is the test-only helper, which is reachable only with -Root.
  assert.equal((template.match(/ServerCertificateValidationCallback\s*=/g) ?? []).length, 1);
  assert.match(template, /if \(-not \$stage -and \(\$DownloadCa\)\) \{ Fail 2/);
  // The secret only reaches the node through its standard input.
  for (const line of template.split('\n').filter(candidate => /\$secret\b/.test(candidate) && /Invoke-Node/.test(candidate))) assert.match(line, /Invoke-Node \$nodeCmd \(.*\) \$secret$/, line.trim());
  assert.match(template, /--invite-stdin/); assert.match(template, /--token-stdin/);
  // Access control is by well-known SIDs, not by account names that differ per language.
  for (const sid of ['S-1-5-18', 'S-1-5-32-544', 'S-1-5-19']) assert.ok(template.includes(sid), sid);
});

test('packaging stamps the Windows installer next to the archive and changes only the stamp line', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'privanet-win-stamp-')); t.after(() => rm(dir, { recursive: true, force: true }));
  await exec(process.execPath, ['scripts/package-release.mjs', 'windows', dir], { cwd: root });
  const stamped = readFileSync(join(dir, 'install-node.ps1'), 'utf8');
  assert.match(stamped, new RegExp(`^\\$VersionStamp = '${version.replaceAll('.', '\\.')}'$`, 'm'));
  assert.equal(stamped.replace(`$VersionStamp = '${version}'`, "$VersionStamp = '@PRIVANET_VERSION@'"), template);
  assert.ok(existsSync(join(dir, `privanet-${version}-windows`, 'bin', 'privanet-node.cmd')));
  assert.ok(existsSync(join(dir, `privanet-${version}-windows`, 'deploy', 'install', 'install-node.ps1')), 'the unstamped template travels in the archive too');
});

let releaseDir = ''; let workDir = '';
const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');
before(async () => {
  if (skip) return;
  workDir = await mkdtemp(join(tmpdir(), 'privanet-win-installer-')); releaseDir = join(workDir, 'release'); await mkdir(releaseDir);
  await exec(process.execPath, ['scripts/package-release.mjs', 'windows', releaseDir], { cwd: root });
  await exec('tar', ['-a', '-cf', join(releaseDir, ARCHIVE), '-C', releaseDir, `privanet-${version}-windows`]);
  await rm(join(releaseDir, `privanet-${version}-windows`), { recursive: true, force: true });
  const lines = ['install-node.ps1', ARCHIVE].map(name => `${sha(readFileSync(join(releaseDir, name)))}  ${name}`);
  await writeFile(join(releaseDir, 'SHA256SUMS.txt'), lines.join('\n') + '\n');
  await writeFile(join(workDir, 'good.crt'), GOOD_CERT);
});
after(async () => { if (workDir) await rm(workDir, { recursive: true, force: true }); });

async function releaseServer(t: TestContext, mutate: Record<string, (data: Buffer) => Buffer> = {}) {
  const server = createHttpsServer({ cert: GOOD_CERT, key: GOOD_KEY }, (req, res) => {
    const name = (req.url ?? '').split('/').pop() ?? ''; const file = join(releaseDir, name);
    if (!(req.url ?? '').startsWith(`/releases/v${version}/`) || !existsSync(file)) { res.writeHead(404); res.end('no'); return; }
    const hook = mutate[name]; const body = hook ? hook(readFileSync(file)) : readFileSync(file); res.writeHead(200); res.end(body);
  });
  const port = await listenAny(server); t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  return `https://localhost:${port}/releases/v${version}`;
}
function installer(rootDir: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<Run> {
  // PSModulePath is dropped: a PowerShell 7 parent (as on the CI runner) sets one that Windows PowerShell 5.1 cannot load its own modules from (Get-FileHash would not be found).
  const inherited = { ...process.env }; delete inherited.PSModulePath;
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(releaseDir, 'install-node.ps1'), ...args],
    { env: { ...inherited, PRIVANET_NODE_BIN: process.execPath, PRIVANET_NODE_MIN: '22.0.0', ...env, PRIVANET_INVITE_CODE: '' }, cwd: rootDir, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; let err = ''; child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString(); }); child.stderr.on('data', (chunk: Buffer) => { err += chunk.toString(); });
  return new Promise(resolve => child.once('close', code => resolve({ code: code ?? -1, out, err })));
}
const staged = async (t: TestContext) => { const dir = await mkdtemp(join(tmpdir(), 'privanet-win-root-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; };
const leftovers = () => readdirSync(tmpdir()).filter(name => name.startsWith('privanet-install-'));

test('windows: verification failures are refused before anything is installed', { skip }, async t => {
  const dir = await staged(t); const good = await releaseServer(t);
  const base = (url: string, extra: string[] = []) => ['-Root', dir, '-DownloadCa', join(workDir, 'good.crt'), '-ReleaseBaseUrl', url, '-Coordinator', 'https://x.example', '-InstallOnly', '-NoService', ...extra];
  const flip = (data: Buffer) => { const copy = Buffer.from(data); copy[copy.length - 20] = (copy[copy.length - 20] ?? 0) ^ 0xff; return copy; };
  const tampered = await installer(dir, base(await releaseServer(t, { [ARCHIVE]: flip }))); assert.equal(tampered.code, 3, tampered.err); assert.match(tampered.err, /does not match its published checksum/);
  const wrongPin = await installer(dir, base(good, ['-Sha256', 'f'.repeat(64)])); assert.equal(wrongPin.code, 3, wrongPin.err);
  const unpinned = await installer(dir, base(good, ['-Version', 'not-a-version'])); assert.equal(unpinned.code, 2);
  const http = await installer(dir, base('http://localhost/releases')); assert.equal(http.code, 2);
  assert.equal(existsSync(join(dir, 'ProgramFiles')), false, 'nothing was installed'); assert.deepEqual(leftovers(), []);
});

test('windows: an invite installs and enrolls a node with no secret left anywhere, and the installed node signs in', { skip }, async t => {
  const dir = await staged(t); const base = await releaseServer(t); const c = await realCoordinator(t);
  const made = c.core.createInvite({ expiresInMs: 600000, capabilities: ['system.echo.v1'], label: 'Windows PC' });
  const inviteFile = join(dir, 'invite.txt'); await writeFile(inviteFile, `${made.code}\r\n`);
  const run = await installer(dir, ['-Root', dir, '-DownloadCa', join(workDir, 'good.crt'), '-ReleaseBaseUrl', base, '-Coordinator', c.url, '-CaFile', join(workDir, 'good.crt'), '-InviteFile', inviteFile, '-NoService']);
  assert.equal(run.code, 0, run.err + run.out); assert.match(run.out, /Enrolled\./);
  assert.equal(c.core.listInvites()[0]?.status, 'USED'); assert.equal(c.core.listNodes()[0]?.displayName, 'Windows PC');
  const plain = made.code.replace('-', '');
  const walk = (path: string): string[] => readdirSync(path, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(join(path, entry.name)) : entry.isFile() ? [join(path, entry.name)] : []);
  for (const file of walk(dir)) { if (file === inviteFile) continue; const bytes = readFileSync(file); for (const needle of [made.code, plain]) assert.equal(bytes.includes(needle), false, `${file} must not hold the invite`); }
  for (const text of [run.out, run.err]) assert.equal(text.includes(plain), false);
  const launcher = readFileSync(join(dir, 'ProgramFiles', 'PrivaNet', 'node', version, 'run-node.cmd'), 'utf8'); assert.match(launcher, /PRIVANODE_STATE_DIR=/); assert.doesNotMatch(launcher, /INVITE|TOKEN/i);
  assert.ok(existsSync(join(dir, 'ProgramData', 'PrivaNet', 'node', 'state', 'identity.json')));
  assert.deepEqual(leftovers(), [], 'the temporary directory was removed');
  const again = await installer(dir, ['-Root', dir, '-DownloadCa', join(workDir, 'good.crt'), '-ReleaseBaseUrl', base, '-Coordinator', c.url, '-NoService']); assert.equal(again.code, 6, 'an existing installation is not silently replaced');
  const gone = await installer(dir, ['-Root', dir, '-Uninstall', '-Purge']); assert.equal(gone.code, 0, gone.err); assert.equal(existsSync(join(dir, 'ProgramData', 'PrivaNet')), false);
});

test('windows (staged): upgrading keeps the identity, the enrollment and the administrator\'s files byte for byte, adds nothing the owner did not ask for, and uninstall keeps the identity unless purged', { skip }, async t => {
  const dir = await staged(t); const base = await releaseServer(t); const c = await realCoordinator(t);
  const made = c.core.createInvite({ expiresInMs: 600000, capabilities: ['system.echo.v1'], label: 'Upgrade PC' }); const inviteFile = join(dir, 'invite.txt'); await writeFile(inviteFile, `${made.code}\r\n`);
  const common = ['-Root', dir, '-DownloadCa', join(workDir, 'good.crt'), '-ReleaseBaseUrl', base, '-Coordinator', c.url, '-CaFile', join(workDir, 'good.crt'), '-NoService'];
  const first = await installer(dir, [...common, '-InviteFile', inviteFile]); assert.equal(first.code, 0, first.err + first.out);
  const state = join(dir, 'ProgramData', 'PrivaNet', 'node', 'state'); const hash = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
  const watched = ['identity.json', 'enrollment.json'].map(name => join(state, name)); const before = watched.map(hash);
  for (const name of ['policy.json', 'local-state.json', 'panel-token', 'status.json']) assert.equal(existsSync(join(state, name)), false, `a v0.3.5 install has no ${name}`);
  for (let i = 0; i < 2; i++) { const upgraded = await installer(dir, [...common, '-Upgrade']); assert.equal(upgraded.code, 0, upgraded.err + upgraded.out); }
  assert.deepEqual(watched.map(hash), before, 'identity and enrollment are untouched'); assert.equal(c.core.listNodes().length, 1);
  for (const name of ['policy.json', 'local-state.json', 'panel-token']) assert.equal(existsSync(join(state, name)), false, `the upgrade does not create ${name}`);
  const kept = await installer(dir, ['-Root', dir, '-Uninstall']); assert.equal(kept.code, 0, kept.err); assert.ok(existsSync(join(state, 'identity.json')), 'uninstall keeps the identity');
  const purged = await installer(dir, ['-Root', dir, '-Uninstall', '-Purge']); assert.equal(purged.code, 0, purged.err); assert.equal(existsSync(join(dir, 'ProgramData', 'PrivaNet')), false);
});
