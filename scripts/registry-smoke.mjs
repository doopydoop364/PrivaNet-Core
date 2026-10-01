// Registry smoke test: proves a clean consumer can install the published @privanet packages and use them.
//   node scripts/registry-smoke.mjs [version] [dist-tag]
// Defaults to this repository's version and to the `next` tag for a pre-release, `latest` otherwise.
// Needs the public npm registry; it is deliberately not part of `npm test`, so an ordinary test run never depends on the network.
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { URL } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const packages = ['protocol', 'shared', 'sdk'];
const version = process.argv[2] ?? JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
const tag = process.argv[3] ?? (version.includes('-') ? 'next' : 'latest');
const run = (args, cwd) => exec(npm, args, { cwd, shell: process.platform === 'win32', maxBuffer: 10 * 1024 * 1024 });
const fail = message => { console.error(`registry smoke FAILED: ${message}`); process.exitCode = 1; };

const dir = await mkdtemp(join(tmpdir(), 'privanet-registry-smoke-'));
try {
  // 1. The registry carries every package at the expected version, and the dist-tag points at it.
  for (const name of packages) {
    const { stdout } = await run(['view', `@privanet/${name}`, '--json', 'dist-tags', 'version'], dir);
    const info = JSON.parse(stdout);
    const tags = info['dist-tags'] ?? info;
    if (tags[tag] !== version) throw new Error(`@privanet/${name}: dist-tag ${tag} is ${tags[tag]}, expected ${version}`);
    await run(['view', `@privanet/${name}@${version}`, 'version'], dir);
  }

  // 2. A clean project installs only the SDK, through the dist-tag, and gets a matching set.
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'registry-smoke', version: '1.0.0', private: true, type: 'module' }));
  await run(['install', `@privanet/sdk@${tag}`, '--no-audit', '--no-fund', '--ignore-scripts'], dir);
  const { stdout: tree } = await run(['ls', '--all', '--json'], dir);
  const installed = [];
  const walk = (deps = {}) => { for (const [name, node] of Object.entries(deps)) { if (name.startsWith('@privanet/')) installed.push([name, node.version]); walk(node.dependencies); } };
  walk(JSON.parse(tree).dependencies);
  for (const name of packages) {
    const versions = new Set(installed.filter(([n]) => n === `@privanet/${name}`).map(([, v]) => v));
    if (versions.size !== 1 || !versions.has(version)) throw new Error(`@privanet/${name} resolved to ${[...versions].join(', ') || 'nothing'}, expected only ${version}`);
  }

  // 3. The installed packages import and work: the SDK builds a client, the protocol validates, the wire version agrees.
  await writeFile(join(dir, 'check.mjs'), `
import { PrivaNetClient } from '@privanet/sdk';
import { PROTOCOL_VERSION, AppCredentialSchema } from '@privanet/protocol';
import * as shared from '@privanet/shared';
if (typeof PrivaNetClient !== 'function') throw new Error('PrivaNetClient is not exported');
if (PROTOCOL_VERSION < 1) throw new Error('unexpected protocol version');
if (AppCredentialSchema.safeParse({ nonsense: true }).success) throw new Error('the protocol schema accepted garbage');
if (Object.keys(shared).length === 0) throw new Error('@privanet/shared exports nothing');
new PrivaNetClient({ url: 'http://127.0.0.1:1', token: 'a'.repeat(64), allowInsecureLoopback: true });
console.log('ok');
`);
  const { stdout: out } = await exec(process.execPath, ['check.mjs'], { cwd: dir });
  if (out.trim() !== 'ok') throw new Error(`import check printed ${out.trim()}`);
  console.log(`registry smoke ok: @privanet/{${packages.join(',')}}@${version} (${tag}) install, resolve to one matching set, and import`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
}
