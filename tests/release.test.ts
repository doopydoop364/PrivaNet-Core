import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, normalize, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppCredentialSchema, EnrollmentTokenSchema, NodesSchema, SERVICE_VERSION } from '@privanet/protocol';
import { secret } from '@privanet/shared';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));
const json = (path: string) => JSON.parse(readFileSync(join(root, path), 'utf8')) as Record<string, unknown> & { version: string };
const packages = ['package.json', ...['apps/coordinator', 'apps/node', 'packages/protocol', 'packages/sdk', 'packages/shared'].map(dir => `${dir}/package.json`)];

test('release metadata: every package, the wire version constant, the lockfile and the changelog agree on one version', async () => {
  const version = json('package.json').version;
  assert.match(version, /^\d+\.\d+\.\d+(-[a-z]+\.\d+)?$/);
  for (const path of packages) {
    const manifest = json(path); assert.equal(manifest.version, version, path);
    for (const [name, wanted] of Object.entries((manifest.dependencies ?? {}) as Record<string, string>)) if (name.startsWith('@privanet/')) assert.equal(wanted, version, `${path} -> ${name}`);
  }
  assert.equal(SERVICE_VERSION, version);
  const lock = json('package-lock.json') as unknown as { version: string; packages: Record<string, { version?: string; dependencies?: Record<string, string> }> };
  assert.equal(lock.version, version);
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (key === '' || ['apps/coordinator', 'apps/node', 'packages/protocol', 'packages/sdk', 'packages/shared'].includes(key)) {
      assert.equal(entry.version ?? version, version, `lockfile ${key || 'root'}`);
      for (const [name, wanted] of Object.entries(entry.dependencies ?? {})) if (name.startsWith('@privanet/')) assert.equal(wanted, version, `lockfile ${key} -> ${name}`);
    }
  }
  const notes = (await exec(process.execPath, ['scripts/changelog-section.mjs', version], { cwd: root })).stdout;
  assert.ok(notes.trim().length > 200, 'release notes must not be empty'); assert.doesNotMatch(notes, /\bTODO\b/i);
  await assert.rejects(exec(process.execPath, ['scripts/changelog-section.mjs', '9.9.9'], { cwd: root })); // a missing section blocks a release
  const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
  assert.ok(changelog.indexOf(`## [${version}]`) < changelog.indexOf('## [0.2.0]'), 'newest release comes first');
});

test('documentation: every relative link and anchor in the shipped Markdown resolves', () => {
  const files = ['README.md', 'ROADMAP.md', 'CHANGELOG.md', ...readdirSync(join(root, 'docs')).filter(name => name.endsWith('.md')).map(name => `docs/${name}`)];
  const slug = (heading: string) => heading.trim().toLowerCase().replaceAll('`', '').replace(/[^\w\- ]/g, '').replaceAll(' ', '-');
  const anchors = new Map(files.map(file => [file, new Set([...readFileSync(join(root, file), 'utf8').matchAll(/^#+\s+(.*)$/gm)].map(match => slug(match[1] ?? '')))]));
  const problems: string[] = [];
  for (const file of files) {
    for (const match of readFileSync(join(root, file), 'utf8').matchAll(/\]\(([^)#\s]*)(?:#([^)]*))?\)/g)) {
      const [, target = '', anchor] = match; if (/^(https?:|mailto:)/.test(target)) continue;
      const path = target ? normalize(join(dirname(file), target)).replaceAll('\\', '/') : file; // forward slashes on every OS
      if (!existsSync(join(root, path))) { problems.push(`${file}: missing ${target}`); continue; }
      if (anchor && path.endsWith('.md') && !anchors.get(path)?.has(anchor)) problems.push(`${file}: no anchor #${anchor} in ${path}`);
    }
  }
  assert.deepEqual(problems, []);
});

async function unusedPort(): Promise<number> {
  const server = createServer(); await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); assert(address && typeof address !== 'string'); await new Promise<void>(resolve => server.close(() => resolve())); return address.port;
}
function walk(dir: string): string[] { return readdirSync(dir).flatMap(name => { const path = join(dir, name); return statSync(path).isDirectory() ? walk(path) : [path]; }); }
async function until(logs: string[], event: string, child: ChildProcess) {
  for (let i = 0; i < 200; i++) { if (logs.join('').includes(`"event":"${event}"`)) return; if (child.exitCode !== null) throw new Error(`exited before ${event}: ${logs.join('')}`); await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error(`timeout waiting for ${event}: ${logs.join('')}`);
}

test('staged distributions contain what they should and nothing they should not (all three platforms)', async t => {
  const out = await mkdtemp(join(tmpdir(), 'privanet-stage-')); t.after(() => rm(out, { recursive: true, force: true }));
  const version = json('package.json').version;
  for (const platform of ['linux', 'macos', 'windows']) {
    const stage = (await exec(process.execPath, ['scripts/package-release.mjs', platform, out], { cwd: root })).stdout.trim();
    assert.equal(stage, join(out, `privanet-${version}-${platform}`));
    const files = walk(stage).map(path => relative(stage, path).replaceAll('\\', '/'));
    for (const required of ['RUNNING.txt', 'README.md', 'ROADMAP.md', 'CHANGELOG.md', '.env.example', 'docs/deployment.md', 'docs/TREASURY.md',
      'tools/admin.mjs', 'tools/demo.mjs', 'tools/backup.mjs', 'node_modules/zod/package.json', ...['protocol', 'sdk', 'shared'].map(name => `node_modules/@privanet/${name}/dist/index.js`)])
      assert.ok(files.includes(required), `${platform} is missing ${required}`);
    assert.ok(files.includes(`bin/privanet-coordinator${platform === 'windows' ? '.cmd' : ''}`)); assert.ok(files.includes(`bin/privanet-node${platform === 'windows' ? '.cmd' : ''}`));
    assert.ok(files.includes('node_modules/@privanet/coordinator/dist/main.js')); assert.ok(files.includes('node_modules/@privanet/node/dist/main.js'));
    // Nothing that is not meant to ship: source maps, build caches, tests, local state, identities, databases, real env files.
    for (const file of files.filter(path => !path.startsWith('node_modules/zod/'))) { // third-party contents are theirs
      assert.doesNotMatch(file, /\.(map|tsbuildinfo|sqlite|sqlite-wal|sqlite-shm|pem|key)$/, file);
      assert.doesNotMatch(file, /(^|\/)(tests?|var|\.git|\.github)(\/|$)/, file); assert.notEqual(file, '.env'); assert.doesNotMatch(file, /identity\.json|node-state\.json|transfer\.json/, file);
    }
    const example = readFileSync(join(stage, '.env.example'), 'utf8'); assert.doesNotMatch(example, /[a-f0-9]{64}/, '.env.example must hold no real secret');
    const bin = readFileSync(join(stage, 'bin', `privanet-node${platform === 'windows' ? '.cmd' : ''}`), 'utf8');
    if (platform === 'windows') assert.match(bin, /^@echo off\r\nnode "%~dp0\.\.\\node_modules\\@privanet\\node\\dist\\main\.js" %\*\r\n$/); else assert.match(bin, /^#!\/bin\/sh\nexec node "\$\(dirname "\$0"\)\/\.\.\/node_modules\/@privanet\/node\/dist\/main\.js" "\$@"\n$/);
    if (platform !== 'windows' && process.platform !== 'win32') assert.ok((statSync(join(stage, 'bin', 'privanet-node')).mode & 0o111) !== 0, 'launcher must be executable');
    assert.match(readFileSync(join(stage, 'RUNNING.txt'), 'utf8'), new RegExp(`PrivaNet ${version.replaceAll('.', '\\.')} \\(${platform}\\)`));
  }
});

test('the packaged distribution runs on its own: Coordinator, node, admin, demo, a long checkpointable job, drain and backup, with no repository on the module path', async t => {
  const out = await mkdtemp(join(tmpdir(), 'privanet-dist-')); const logs: string[] = []; const children: ChildProcess[] = [];
  t.after(async () => { for (const child of children) if (child.exitCode === null) { child.kill('SIGKILL'); await new Promise(resolve => child.once('close', resolve)); } await rm(out, { recursive: true, force: true }); });
  const platform = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
  const stage = (await exec(process.execPath, ['scripts/package-release.mjs', platform, out], { cwd: root })).stdout.trim();
  assert.equal(stage.startsWith(root), false, 'the staged copy must live outside the repository so it cannot borrow its node_modules');
  const port = await unusedPort(); const admin = secret(); const url = `http://127.0.0.1:${port}`;
  const policy = join(out, 'policy.json');
  await writeFile(policy, JSON.stringify({ reserveMemoryBytes: 0, safetyMarginBytes: 0, maxMemoryBytes: 1024 ** 3, maxCpuPercent: 100, reserveCpuPercent: 0, onBattery: 'normal', reserveDiskBytes: 0, maxDiskIo: 'high' }));
  const env = { ...process.env, NODE_PATH: '', PRIVANET_ADMIN_SECRET: admin, PRIVANET_COORDINATOR_URL: url, PRIVANET_HOST: '127.0.0.1', PRIVANET_PORT: String(port), PRIVANET_DATA_DIR: join(out, 'coordinator'),
    PRIVANET_JOB_TYPES: 'system.echo.v1,system.hashchain.v1', PRIVANODE_COORDINATOR_URL: url, PRIVANODE_STATE_DIR: join(out, 'node'), PRIVANODE_ALLOW_INSECURE_LOOPBACK: 'true',
    PRIVANODE_CAPABILITIES: 'system.echo.v1,system.hashchain.v1', PRIVANODE_POLICY_FILE: policy, PRIVANODE_HEARTBEAT_MS: '50', PRIVANODE_POLL_MS: '10' };
  const start = async (entry: string, extra: NodeJS.ProcessEnv, event: string) => {
    const child = spawn(process.execPath, [join(stage, 'node_modules', '@privanet', entry, 'dist', 'main.js')], { cwd: stage, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child); child.stdout?.on('data', (chunk: Buffer) => logs.push(chunk.toString())); child.stderr?.on('data', (chunk: Buffer) => logs.push(chunk.toString()));
    await until(logs, event, child); return child;
  };
  const tool = async (script: string, args: string[] = [], extra: NodeJS.ProcessEnv = {}) => (await exec(process.execPath, [join(stage, 'tools', script), ...args], { cwd: stage, env: { ...env, ...extra }, timeout: 20000 })).stdout;
  await start('coordinator', {}, 'coordinator.started');
  const application = AppCredentialSchema.parse(JSON.parse(await tool('admin.mjs', ['application', 'dist-test'])));
  const grant = EnrollmentTokenSchema.parse(JSON.parse(await tool('admin.mjs', ['enrollment'])));
  const node = await start('node', { PRIVANODE_ENROLLMENT_TOKEN: grant.token }, 'node.enrolled');
  const echo = JSON.parse(await tool('demo.mjs', [], { PRIVANET_APP_TOKEN: application.token })) as { result: { message: string } };
  assert.equal(echo.result.message, 'Hello from PrivaNet SDK');
  // A long checkpointable job through the packaged SDK, verified against an independent computation.
  const script = `import { PrivaNetClient } from '@privanet/sdk'; import { createHash } from 'node:crypto';
    const sdk = new PrivaNetClient({ url: process.env.PRIVANET_COORDINATOR_URL, allowInsecureLoopback: true, token: process.env.PRIVANET_APP_TOKEN });
    const job = await sdk.submit('system.hashchain.v1', { seed: 'dist', iterations: 200000 }, 'dist-chain');
    const result = await sdk.waitForResult(job.id, { timeoutMs: 30000 });
    let h = createHash('sha256').update('dist').digest(); for (let i = 0; i < 200000; i++) h = createHash('sha256').update(h).digest();
    console.log(JSON.stringify({ ok: result.digest === h.toString('hex') }));`;
  const chain = (await exec(process.execPath, ['--input-type=module', '-e', script], { cwd: stage, env: { ...env, PRIVANET_APP_TOKEN: application.token }, timeout: 40000 })).stdout;
  assert.deepEqual(JSON.parse(chain), { ok: true });
  // Consistent online backup from the packaged tool, then a graceful drain through the portable DRAIN file.
  const backup = join(out, 'backup.sqlite'); assert.match(await tool('backup.mjs', [backup]), /backup\.created/); assert.ok(existsSync(backup));
  const exited = new Promise<void>(resolve => node.once('close', () => resolve()));
  await writeFile(join(out, 'node', 'DRAIN'), ''); await exited;
  const nodes = NodesSchema.parse(JSON.parse(await tool('admin.mjs', ['nodes']))); assert.equal(nodes.nodes[0]?.status, 'OFFLINE_EXPECTED');
  const text = logs.join('');
  for (const value of [admin, application.token, grant.token]) assert.equal(text.includes(value), false, 'no credential may reach the logs');
});
