// Stages a portable, dependency-complete PrivaNet distribution directory from a built checkout.
// Usage: node scripts/package-release.mjs <windows|linux|macos> <outDir>
// The archive itself is created by the release workflow (tar/zip). Node.js >=24.4 is required at runtime.
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [platform, outDir] = process.argv.slice(2);
if (!['windows', 'linux', 'macos'].includes(platform ?? '') || !outDir) throw new Error('Usage: package-release.mjs <windows|linux|macos> <outDir>');
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
const stage = join(outDir, `privanet-${version}-${platform}`);
rmSync(stage, { recursive: true, force: true });
const modules = join(stage, 'node_modules');
mkdirSync(join(stage, 'bin'), { recursive: true }); mkdirSync(join(stage, 'tools'), { recursive: true });

const workspaces = { protocol: 'packages/protocol', shared: 'packages/shared', sdk: 'packages/sdk', coordinator: 'apps/coordinator', node: 'apps/node' };
for (const [name, source] of Object.entries(workspaces)) {
  if (!existsSync(join(source, 'dist'))) throw new Error(`Build first: ${source}/dist is missing`);
  const target = join(modules, '@privanet', name);
  mkdirSync(target, { recursive: true });
  cpSync(join(source, 'package.json'), join(target, 'package.json'));
  cpSync('LICENSE', join(target, 'LICENSE')); // Apache-2.0 travels with every package it covers
  cpSync(join(source, 'dist'), join(target, 'dist'), { recursive: true, filter: path => !path.endsWith('.tsbuildinfo') && !path.endsWith('.map') });
}
cpSync('node_modules/zod', join(modules, 'zod'), { recursive: true });
for (const script of ['admin.mjs', 'demo.mjs', 'backup.mjs']) cpSync(join('scripts', script), join(stage, 'tools', script));
for (const file of ['LICENSE', 'README.md', 'ROADMAP.md', 'CHANGELOG.md']) cpSync(file, join(stage, file));
cpSync('docs', join(stage, 'docs'), { recursive: true });
cpSync('.env.example', join(stage, '.env.example'));

const entries = { 'privanet-coordinator': 'coordinator', 'privanet-node': 'node' };
for (const [command, name] of Object.entries(entries)) {
  const target = `node_modules/@privanet/${name}/dist/main.js`;
  if (platform === 'windows') writeFileSync(join(stage, 'bin', `${command}.cmd`), `@echo off\r\nnode "%~dp0..\\${target.replaceAll('/', '\\')}" %*\r\n`);
  else {
    const file = join(stage, 'bin', command);
    writeFileSync(file, `#!/bin/sh\nexec node "$(dirname "$0")/../${target}" "$@"\n`); chmodSync(file, 0o755);
  }
}
writeFileSync(join(stage, 'RUNNING.txt'), [
  `PrivaNet ${version} (${platform})`, '',
  'Requires Node.js >= 24.4 on PATH. No install step: this directory is self-contained.',
  `Coordinator: bin/privanet-coordinator${platform === 'windows' ? '.cmd' : ''}`,
  `PrivaNode:   bin/privanet-node${platform === 'windows' ? '.cmd' : ''}`,
  'Admin/demo:  node tools/admin.mjs ... / node tools/demo.mjs',
  'Backup:      node tools/backup.mjs <destination-file>   (see docs/deployment.md)',
  'Configuration and first-run steps: docs/development.md. Configure through environment variables; never commit secrets.', ''].join('\n'));
console.log(stage);
