import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkForUpdate, RELEASES_API } from '@privanet/node/update-check';
import { COMPLETION_TREE, SHELLS, completionScript } from '@privanet/node/completions';
import { runLocal, LOCAL_COMMANDS } from '@privanet/node/local-cli';

const release = (extra: Record<string, unknown> = {}) => ({ tag_name: 'v0.4.0', html_url: 'https://github.com/doopydoop364/PrivaNet-Core/releases/tag/v0.4.0', prerelease: false, draft: false, ...extra });
const answer = (body: unknown, init: ResponseInit = {}): typeof fetch => async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200, ...init });

test('update check: one fixed HTTPS request that sends nothing about the node, and a message that installs nothing', async () => {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const result = await checkForUpdate({ currentVersion: '0.3.5', fetchImpl: async (url, init) => { seen.push({ url: String(url), init: init ?? {} }); return new Response(JSON.stringify(release())); } });
  assert.equal(seen.length, 1); assert.equal(seen[0]?.url, RELEASES_API); assert.match(RELEASES_API, /^https:\/\/api\.github\.com\/repos\/doopydoop364\/PrivaNet-Core\/releases\/latest$/);
  assert.equal(seen[0]?.init.redirect, 'error'); assert.equal(seen[0]?.init.method, 'GET'); assert.equal(seen[0]?.init.body, undefined);
  assert.deepEqual(Object.keys(seen[0]?.init.headers as object).sort(), ['accept', 'user-agent']); assert.equal((seen[0]?.init.headers as Record<string, string>)['user-agent'], 'privanet-node/0.3.5');
  assert.equal(result.state, 'update-available'); assert.equal(result.latest, '0.4.0'); assert.match(result.message, /0\.4\.0 is available/); assert.match(result.howToUpgrade ?? '', /SHA256SUMS\.txt/); assert.match(result.howToUpgrade ?? '', /Nothing was downloaded/);
});

test('update check: up to date, newer than the release, and every kind of failure is a calm message and never an exception', async () => {
  assert.equal((await checkForUpdate({ currentVersion: '0.4.0', fetchImpl: answer(release()) })).state, 'up-to-date');
  assert.equal((await checkForUpdate({ currentVersion: '0.4.1', fetchImpl: answer(release()) })).state, 'ahead-of-release');
  assert.equal((await checkForUpdate({ currentVersion: '0.3.5', fetchImpl: answer(release({ tag_name: 'v0.10.0', html_url: 'https://github.com/doopydoop364/PrivaNet-Core/releases/tag/v0.10.0' })) })).state, 'update-available', 'versions compare numerically');
  const failures: Array<[string, typeof fetch]> = [
    ['network', async () => { throw new Error('ECONNREFUSED secret-host.internal'); }], ['server error', answer('x', { status: 500 })], ['not json', answer('<html>')], ['wrong shape', answer({ tag_name: 7 })],
    ['bad tag', answer(release({ tag_name: 'latest' }))], ['draft', answer(release({ draft: true }))], ['prerelease', answer(release({ prerelease: true }))],
    ['foreign release address', answer(release({ html_url: 'https://evil.example/releases/tag/v9.9.9' }))], ['markup in the address', answer(release({ html_url: 'https://github.com/doopydoop364/PrivaNet-Core/releases/"><script>' }))],
    ['too large', answer('x'.repeat(300000))], ['redirect', async () => { throw new TypeError('fetch failed: redirect'); }],
  ];
  for (const [name, fetchImpl] of failures) { const result = await checkForUpdate({ currentVersion: '0.3.5', fetchImpl }); assert.equal(result.state, 'failed', name); assert.match(result.message, /Your node is unaffected/); assert.equal(result.message.includes('secret-host'), false, `${name}: no error text is repeated`); assert.equal(result.releaseUrl, null); }
});

test('completions: every shell has a script that names every command, contains nothing but words, and the bash one parses', () => {
  for (const shell of SHELLS) {
    const script = completionScript(shell);
    for (const command of Object.keys(COMPLETION_TREE)) assert.ok(script.includes(command), `${shell}: ${command}`);
    assert.doesNotMatch(script, /curl|wget|fetch|Invoke-WebRequest|\beval\b|https?:|\$\(privanet-node|--invite[ "']|--token[ "']/i, shell);
  }
  for (const command of LOCAL_COMMANDS) assert.ok(command in COMPLETION_TREE, `${command} is completed`);
  const dir = mkdtempSync(join(tmpdir(), 'privanet-completions-')); try {
    const file = join(dir, 'c.bash').replaceAll('\\', '/'); writeFileSync(file, completionScript('bash')); execFileSync('bash', ['-n', file]);
    // Drive the real bash completion function.
    const out = execFileSync('bash', ['-c', `source ${file}; COMP_WORDS=(privanet-node po); COMP_CWORD=1; _privanet_node; echo "\${COMPREPLY[@]}"; COMP_WORDS=(privanet-node policy pre); COMP_CWORD=2; _privanet_node; echo "\${COMPREPLY[@]}"; COMP_WORDS=(privanet-node pause ""); COMP_CWORD=2; _privanet_node; echo "\${COMPREPLY[@]}"`]).toString().trim().split('\n');
    assert.equal(out[0], 'policy'); assert.equal(out[1], 'preset'); assert.match(out[2] ?? '', /15m 1h tomorrow reboot indefinite/);
    for (const shell of ['zsh', 'fish']) { const probe = spawnSync(shell, ['-n', '-c', 'true']); if (probe.error) continue; const f = join(dir, `c.${shell}`); writeFileSync(f, completionScript(shell as 'zsh')); assert.equal(spawnSync(shell, ['-n', f]).status, 0, shell); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the CLI prints completions, refuses unknown shells and unknown update subcommands, and update check needs the explicit word "check"', async () => {
  const run = async (command: string, args: string[]) => { let out = ''; let err = ''; const code = await runLocal(command, args, {}, { out: t => { out += t; }, err: t => { err += t; } }); return { code, out, err }; };
  const bash = await run('completions', ['bash']); assert.equal(bash.code, 0); assert.equal(bash.out, completionScript('bash'));
  assert.equal((await run('completions', ['tcsh'])).code, 78); assert.equal((await run('completions', [])).code, 78);
  assert.equal((await run('update', [])).code, 78); assert.equal((await run('update', ['install'])).code, 78); assert.match((await run('update', ['install'])).err, /usage: privanet-node update check/);
});

test('privanet-admin completions: every shell, no credential needed, no secret or network word, unknown shell refused', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const run = (args: string[]) => spawnSync(process.execPath, [join(root, 'scripts', 'admin.mjs'), ...args], { cwd: root, env: { PATH: process.env.PATH ?? '' }, encoding: 'utf8' });
  for (const shell of SHELLS) {
    const result = run(['completions', shell]); assert.equal(result.status, 0, shell); assert.equal(result.stderr, '');
    for (const word of ['enrollment', 'invite', 'requests', 'approve', 'deny', 'nodes', 'revoke-application', 'rotate-application', 'ui', 'completions', '--capabilities']) assert.ok(result.stdout.includes(word), `${shell}: ${word}`);
    assert.doesNotMatch(result.stdout, /curl|wget|https?:|\beval\b|ADMIN_SECRET/i, shell);
  }
  const bash = run(['completions', 'bash']).stdout; const dir = mkdtempSync(join(tmpdir(), 'privanet-admin-completions-'));
  try { const file = join(dir, 'a.bash').replaceAll('\\', '/'); writeFileSync(file, bash); execFileSync('bash', ['-n', file]);
    assert.equal(execFileSync('bash', ['-c', `source ${file}; COMP_WORDS=(privanet-admin nodes re); COMP_CWORD=2; _privanet_admin; echo "\${COMPREPLY[@]}"`]).toString().trim(), 'revoke rename'); } finally { rmSync(dir, { recursive: true, force: true }); }
  assert.equal(run(['completions', 'tcsh']).status, 1); assert.equal(run(['completions']).status, 1);
});
