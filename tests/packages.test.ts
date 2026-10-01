import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const publishable = ['protocol', 'shared', 'sdk'];

test('publishable packages are consumer-ready: metadata, exports, file lists, aligned versions and dependencies', () => {
  const version = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }).version;
  for (const name of publishable) {
    const pkg = JSON.parse(readFileSync(join(root, 'packages', name, 'package.json'), 'utf8')) as Record<string, unknown> & { dependencies: Record<string, string>; files: string[]; exports: Record<string, unknown> };
    assert.equal(pkg.name, `@privanet/${name}`); assert.equal(pkg.version, version); assert.equal(pkg.private, undefined, 'a published package cannot be private');
    assert.deepEqual((pkg.publishConfig as { access: string }).access, 'public'); assert.equal((pkg.engines as { node: string }).node, '>=24.4'); assert.ok(typeof pkg.description === 'string' && pkg.description.length > 20);
    assert.ok(pkg.files.includes('dist')); assert.ok(pkg.files.some(f => f.startsWith('!dist/**/*.map'))); assert.deepEqual(Object.keys(pkg.exports), ['.']); // one public entry point
    for (const [dep, wanted] of Object.entries(pkg.dependencies)) if (dep.startsWith('@privanet/')) { assert.equal(wanted, version, `${name} -> ${dep}`); assert.ok(publishable.includes(dep.slice('@privanet/'.length)), `${dep} must itself be publishable`); }
  }
  for (const app of ['coordinator', 'node']) assert.equal(JSON.parse(readFileSync(join(root, 'apps', app, 'package.json'), 'utf8')).private, true, `${app} is not a consumer package`);
});

test('licensing: Apache-2.0 everywhere it applies, the standard text, one identical LICENSE per publishable package, and no relicensing of third-party code', () => {
  const text = readFileSync(join(root, 'LICENSE'), 'utf8');
  assert.match(text, /^\s+Apache License\r?\n\s+Version 2\.0, January 2004/); assert.match(text, /END OF TERMS AND CONDITIONS/); assert.match(text, /Copyright \[yyyy\] \[name of copyright owner\]/, 'the standard appendix stays unfilled: the license text is not edited');
  for (const path of ['package.json', 'apps/coordinator/package.json', 'apps/node/package.json', ...publishable.map(name => `packages/${name}/package.json`)])
    assert.equal((JSON.parse(readFileSync(join(root, path), 'utf8')) as { license?: string }).license, 'Apache-2.0', path);
  for (const name of publishable) assert.equal(readFileSync(join(root, 'packages', name, 'LICENSE'), 'utf8'), text, `packages/${name}/LICENSE must equal the root LICENSE`);
  assert.match(readFileSync(join(root, 'README.md'), 'utf8'), /Apache License, Version 2\.0/); // stated in the README
  assert.equal(existsSync(join(root, 'node_modules', 'zod', 'LICENSE')), true); // third-party licenses are left in place, untouched by us
});

test('the npm publish job uses trusted publishing (OIDC) with an optional token fallback, is opt-in, and never blocks the GitHub release', () => {
  const workflow = readFileSync(join(root, '.github', 'workflows', 'release.yml'), 'utf8'); const publish = workflow.slice(workflow.indexOf('\n  publish:'));
  assert.match(publish, /id-token: write/); assert.match(publish, /--provenance/); assert.match(publish, /vars\.NPM_PUBLISH == 'true'/); assert.match(publish, /needs: release/);
  assert.match(publish, /npm@\^11\.5\.1/, 'trusted publishing needs npm 11.5.1 or newer'); assert.match(publish, /already on npm: skipping/, 'a re-run must be idempotent');
  assert.doesNotMatch(publish, /registry-url/, 'no placeholder token file that could shadow OIDC');
  assert.match(publish, /for pkg in protocol shared sdk;/, 'dependency order: protocol, then shared, then sdk'); assert.match(publish, /tag=latest; case "\$RELEASE_TAG" in \*-\*\) tag=next;;/, 'pre-releases publish under next, stable releases under latest');
  assert.doesNotMatch(publish, /\sNPM_TOKEN:/, 'the token is only ever an optional secret read, never a required one'); assert.match(publish, /registry-smoke:[\s\S]*needs: publish[\s\S]*scripts\/registry-smoke\.mjs/, 'a consumer smoke test runs after the publish');
  assert.match(workflow, /gh release view "\$RELEASE_TAG"[^\n]*already exists/, 're-running a tag must not fail on the existing release, so the npm publish can still be completed');
  assert.match(workflow, /gh release create/); assert.ok(workflow.indexOf('gh release create') < workflow.indexOf('\n  publish:'), 'the GitHub release (with the tarballs) is created before, and independent of, the npm publish');
});

test('the packed tarballs install into a fresh project, contain only built output, resolve with types, and enforce the contract at compile time', { timeout: 240000 }, async t => {
  const work = await mkdtemp(join(tmpdir(), 'privanet-pack-')); t.after(() => rm(work, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }));
  const packs = join(work, 'packs'); await mkdir(packs); const tarballs: string[] = [];
  for (const name of publishable) {
    const out = await exec(npm, ['pack', '--json', '--pack-destination', packs, '--workspace', `@privanet/${name}`], { cwd: root, shell: process.platform === 'win32', maxBuffer: 10 * 1024 * 1024 });
    const info = (JSON.parse(out.stdout) as Array<{ filename: string; files: Array<{ path: string }> }>)[0]!; tarballs.push(join(packs, info.filename));
    const paths = info.files.map(f => f.path);
    assert.ok(paths.includes('package.json') && paths.includes('dist/index.js') && paths.includes('dist/index.d.ts') && paths.includes('LICENSE'), `${name}: ${paths.join(',')}`);
    for (const p of paths) { assert.doesNotMatch(p, /\.map$|\.tsbuildinfo$|(^|\/)(src|tests?)\//, `${name} ships ${p}`); assert.ok(p === 'package.json' || p === 'README.md' || p === 'LICENSE' || p.startsWith('dist/'), `${name} ships unexpected ${p}`); }
  }
  const project = join(work, 'consumer'); await mkdir(project); await writeFile(join(project, 'package.json'), JSON.stringify({ name: 'consumer', private: true, type: 'module' }));
  await exec(npm, ['install', ...tarballs, '--no-audit', '--no-fund', '--ignore-scripts', '--prefer-offline'], { cwd: project, shell: process.platform === 'win32', maxBuffer: 10 * 1024 * 1024 });
  for (const name of publishable) assert.ok(existsSync(join(project, 'node_modules', '@privanet', name, 'dist', 'index.js')), name);
  // Runtime: import through the package exports, and the wire contract is the authoritative one.
  await writeFile(join(project, 'check.mjs'), `import { PrivaNetClient } from '@privanet/sdk'; import { FetchInputSchema, FetchOutputSchema, JOB_TYPES, PROTOCOL_VERSION } from '@privanet/protocol';
    if (typeof PrivaNetClient !== 'function' || PROTOCOL_VERSION !== 1 || !JOB_TYPES['web.fetch.v1']) process.exit(2);
    if (FetchInputSchema.safeParse({ url: 'https://example.com/', method: 'POST' }).success) process.exit(3);
    if (!FetchInputSchema.safeParse({ url: 'https://example.com/' }).success || FetchOutputSchema.safeParse({}).success) process.exit(4);
    console.log('ok');`);
  assert.match((await exec(process.execPath, ['check.mjs'], { cwd: project })).stdout, /ok/);
  // Types: a consumer gets the registry-derived input type and a wrong field is a compile error.
  await writeFile(join(project, 'good.ts'), `import { PrivaNetClient } from '@privanet/sdk'; import type { FetchOutput } from '@privanet/protocol';
    const client = new PrivaNetClient({ url: 'https://c.example', token: 'a'.repeat(64) });
    export const run = async (): Promise<FetchOutput> => { const job = await client.submit('web.fetch.v1', { url: 'https://example.com/', mode: 'DIGEST', maxRedirects: 2 }, 'crawl:k:0'); return client.waitForResult<'web.fetch.v1'>(job.id); };`);
  await writeFile(join(project, 'bad.ts'), `import { PrivaNetClient } from '@privanet/sdk';
    const client = new PrivaNetClient({ url: 'https://c.example', token: 'a'.repeat(64) });
    void client.submit('web.fetch.v1', { url: 'https://example.com/', method: 'POST' }, 'k');`);
  await writeFile(join(project, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, noEmit: true, skipLibCheck: true, types: [] }, files: ['good.ts'] }));
  const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
  await exec(process.execPath, [tsc, '-p', 'tsconfig.json'], { cwd: project }); // the good consumer compiles against the installed packages
  await writeFile(join(project, 'tsconfig.bad.json'), JSON.stringify({ compilerOptions: { target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, noEmit: true, skipLibCheck: true, types: [] }, files: ['bad.ts'] }));
  await assert.rejects(exec(process.execPath, [tsc, '-p', 'tsconfig.bad.json'], { cwd: project }), (error: { stdout?: string }) => /TS2353|method/.test(error.stdout ?? '')); // a field outside the contract does not compile
  assert.ok(readdirSync(join(project, 'node_modules', '@privanet')).length === 3);
});
