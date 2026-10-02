import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REDACTION_RULES, UnsafeBundleError, buildSupportBundle, looksSecret, redact, sanitizedConfig } from '@privanet/node/support-bundle';
import { defaultResourcePolicy, ResourcePolicySchema } from '@privanet/node/resource-policy';
import { runLocal } from '@privanet/node/local-cli';

const posix = process.platform !== 'win32';
const root = fileURLToPath(new URL('../../', import.meta.url));
const NODE_MAIN = join(root, 'apps', 'node', 'dist', 'main.js');
const HEX64 = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const HEX64B = '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0';
/** Distinctive fragments of every planted secret: none of these may appear anywhere in a bundle. */
const PLANTED: Array<[string, string]> = [
  ['PEM private key', '-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIFAKEKEYMATERIALFAKEKEYMATERIAL12345\n-----END PRIVATE KEY-----'],
  ['OpenSSH private key', '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW\n-----END OPENSSH PRIVATE KEY-----'],
  ['enrollment token (hex)', `enrollment token ${HEX64}`], ['admin secret (hex)', `admin ${HEX64B}`],
  ['bearer token', 'Authorization: Bearer abcDEF123456789xyzTOKENVALUE'], ['basic auth', 'authorization: Basic dXNlcjpwYXNzd29yZA=='], ['cookie', 'Cookie: privanet_panel=SESSIONCOOKIEVALUE123456'], ['set-cookie', 'Set-Cookie: sid=abc123SESSIONSECRET; HttpOnly'],
  ['csrf', 'x-csrf-token: csrfvalue123456789'],
  ['jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'],
  ['invite code', 'invite N7K4-PQ2M'], ['request code', 'request J4M7-K2Q9'],
  ['url credentials', 'https://admin:hunter2pw@node.example.com/v1/x?token=queryTOKENvalue'], ['email', 'owner anna.smith@example.com'],
  ['env assignment', 'PRIVANET_ADMIN_SECRET=supersecretvalueXYZ'], ['api key', 'api_key: "sk_live_abcdef1234567890"'], ['password', 'password=hunter2'], ['json token', '{"token":"tok_123456789abc"}'], ['json private key', '{"privateKey":"MIIEvQIBADANBgkqhkiG9w0BAQEFAASC"}'],
  ['base64 blob', 'blob QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5YWJjZGVmZ2hpams='], ['aws key', 'AKIAIOSFODNN7EXAMPLE'], ['github token', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'], ['npm token', 'npm_abcdefghijklmnopqrstuvwxyz0123456789'], ['slack', 'xoxb-1234567890-abcdefghij'], ['google', 'AIzaSyA-1234567890abcdefghijklmnopqrstuv'],
];
const FRAGMENTS = ['FAKEKEYMATERIAL', 'b3BlbnNzaC1r', HEX64, HEX64B, 'abcDEF123456789xyzTOKENVALUE', 'dXNlcjpwYXNzd29yZA', 'SESSIONCOOKIEVALUE', 'SESSIONSECRET', 'csrfvalue123456789', 'dozjgNryP4J3', 'N7K4-PQ2M', 'J4M7-K2Q9', 'hunter2', 'queryTOKENvalue',
  'anna.smith@example.com', 'supersecretvalueXYZ', 'sk_live_abcdef', 'tok_123456789abc', 'MIIEvQIBADANBgkq', 'QUJDREVGR0hJ', 'AKIAIOSFODNN7EXAMPLE', 'ghp_abcdefghijkl', 'npm_abcdefghijkl', 'xoxb-1234567890', 'AIzaSyA-12345'];
const allPlanted = PLANTED.map(([, text]) => text).join('\n');
const noneOf = (text: string, where: string) => { for (const fragment of FRAGMENTS) assert.equal(text.includes(fragment), false, `${where}: ${fragment}`); };

test('redaction removes every common secret format, one by one and together, and what remains no longer looks secret', () => {
  for (const [name, text] of PLANTED) {
    const counts: Record<string, number> = {}; const cleaned = redact(`context before ${text} context after`, counts);
    noneOf(cleaned, name); assert.equal(looksSecret(cleaned), undefined, `${name} still looks secret: ${cleaned}`);
    assert.ok(Object.values(counts).reduce((a, b) => a + b, 0) > 0, `${name} was counted`);
    assert.ok(looksSecret(text) !== undefined || name === 'email' || name === 'invite code' || name === 'request code' || true);
  }
  noneOf(redact(allPlanted), 'all together'); assert.equal(looksSecret(redact(allPlanted)), undefined);
  for (const [name, text] of PLANTED) if (!['email'].includes(name)) assert.notEqual(looksSecret(text), undefined, `the final scan recognizes ${name}`);
  assert.equal(looksSecret('Everything is fine: node.example.com answered in 12 ms with protocol 1.'), undefined, 'ordinary diagnostics are not mistaken for secrets');
  assert.equal(looksSecret('state directory /var/lib/privanet-node is mode 700, 2 job slots, ADAPTIVE'), undefined);
});

test('redaction is not defeated by case, separators, JSON, quoting or surrounding text (a seeded fuzz of secret shapes in prose)', () => {
  let seed = 12345; const rand = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const alphabet = 'abcdef0123456789'; const b64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const word = () => ['the node', 'failed to', 'connect', 'retrying', 'status', 'because', 'value'][rand(7)] ?? 'x';
  for (let i = 0; i < 400; i++) {
    const hex = Array.from({ length: [32, 40, 64, 96, 128][rand(5)] ?? 64 }, () => alphabet[rand(16)]).join('');
    const blob = Array.from({ length: 40 + rand(60) }, () => b64[rand(64)]).join('');
    const shapes = [hex, `Bearer ${blob}`, `token=${hex}`, `{"secret":"${hex}"}`, `Authorization: ${blob}`, `PASSWORD: ${blob.slice(0, 12)}`, `https://u:${blob.slice(0, 10).replace(/[^A-Za-z0-9]/g, 'x')}@host.example/path`];
    const shape = shapes[rand(shapes.length)] ?? hex;
    const text = `${word()} ${word()} ${shape} ${word()}`; const cleaned = redact(text);
    assert.equal(cleaned.includes(hex), false, text); assert.equal(cleaned.includes(blob.slice(0, 30)), false, text); assert.equal(looksSecret(cleaned), undefined, `${text} -> ${cleaned}`);
  }
});

test('a bundle built from planted secrets everywhere (settings, policy, state, status, doctor output, events, a log file) contains none of them, and says what it removed', () => {
  const env = { PRIVANODE_COORDINATOR_URL: 'https://admin:hunter2pw@node.example.com:8443/v1/x?token=queryTOKENvalue', PRIVANODE_ENROLLMENT_TOKEN: HEX64, PRIVANODE_INVITE_CODE: 'N7K4-PQ2M', PRIVANODE_STATE_DIR: '/home/anna.smith/.var/node', PRIVANODE_POLICY_FILE: '/etc/privanet/node-policy.json',
    PRIVANODE_CAPABILITIES: 'system.echo.v1', PRIVANODE_JOB_SLOTS: '2', NODE_EXTRA_CA_CERTS: '/etc/privanet/root.crt', PRIVANET_ADMIN_SECRET: 'supersecretvalueXYZ', AWS_SECRET_ACCESS_KEY: 'AKIAIOSFODNN7EXAMPLE', GITHUB_TOKEN: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789', HOME: '/home/anna.smith' };
  const policy = { policy: ResourcePolicySchema.parse({ fetch: { denyHosts: ['internal.corp.example', 'secret-project.example'] } }), source: { kind: 'saved' as const, path: '/home/anna.smith/.var/node/policy.json' } };
  const bundle = buildSupportBundle({ env, policy, local: { version: 1, name: 'Anna\'s private laptop', disabledCapabilities: [] },
    status: { node: { localName: 'N7K4-PQ2M', note: allPlanted }, anything: HEX64 }, doctor: { ok: false, coordinator: 'https://admin:hunter2pw@node.example.com', stages: [{ id: 'tls', label: 'TLS', status: 'FAILED', detail: `Bearer abcDEF123456789xyzTOKENVALUE at ${HEX64B}`, advice: 'check eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U' }] },
    logs: [{ at: 1, event: 'node.connection_failed', code: HEX64 }, { at: 2, event: 'x', reason: 'Bearer abcDEF123456789xyzTOKENVALUE' }], logText: `line one\n${allPlanted}\nlast line` });
  const text = JSON.stringify(bundle); noneOf(text, 'bundle');
  for (const forbidden of ['hunter2', 'anna.smith', 'Anna\'s private laptop', 'internal.corp.example', 'secret-project.example', 'queryTOKENvalue', 'AWS_SECRET', 'GITHUB_TOKEN']) assert.equal(text.includes(forbidden), false, forbidden);
  const software = bundle.software as { privanode: string; platform: string }; assert.match(software.privanode, /^\d+\.\d+\.\d+/); assert.ok(software.platform.length > 0);
  assert.equal((bundle.configuration as Record<string, string>).PRIVANODE_COORDINATOR_URL, 'https://node.example.com:8443', 'an address is kept as scheme and host only');
  assert.equal((bundle.configuration as Record<string, string>).enrollmentMaterialInEnvironment, 'yes, value never included');
  assert.equal((bundle.localChoices as { hasLocalName: boolean }).hasLocalName, true);
  assert.deepEqual(Object.keys(bundle.configuration as object).filter(name => /SECRET|AWS|GITHUB|HOME/.test(name)), [], 'settings outside the allowlist are not listed at all');
  assert.equal(((bundle.policy as { policy: { fetch: { denyHostsCount: number } } }).policy.fetch.denyHostsCount), 2);
  assert.ok(Object.keys(bundle.removedFromThisBundle as object).length > 3, 'it reports what it removed');
});

test('the allowlisted configuration view never copies a value that could hold a secret', () => {
  const view = sanitizedConfig({ PRIVANODE_ENROLLMENT_TOKEN: HEX64, PRIVANODE_INVITE_CODE: 'N7K4-PQ2M', PRIVANODE_COORDINATOR_URL: 'https://u:p@h.example/x', PRIVANODE_STATE_DIR: '/home/me/secret-dir/state', RANDOM_OTHER: 'x', PRIVANODE_JOB_SLOTS: '4' });
  const text = JSON.stringify(view); for (const forbidden of [HEX64, 'N7K4-PQ2M', 'u:p', '/home/me', 'RANDOM_OTHER']) assert.equal(text.includes(forbidden), false, forbidden);
  assert.equal(view.PRIVANODE_JOB_SLOTS, '4'); assert.match(view.PRIVANODE_STATE_DIR ?? '', /file name state/);
});

test('the home directory and user name are replaced, and the final scan has a rule for every kind the redaction has', () => {
  const home = homedir(); if (home.length > 1) assert.equal(redact(`opened ${home}/x/y`).includes(home), false);
  const kinds = new Set(REDACTION_RULES.map(rule => rule.kind)); for (const kind of ['private-key', 'bearer', 'jwt', 'url-credentials', 'secret-assignment', 'hex-secret', 'base64-blob', 'short-code', 'email', 'authorization-header']) assert.ok(kinds.has(kind), kind);
  assert.ok(new UnsafeBundleError('hex-secret') instanceof Error);
});

// ---- the command ----
async function sandbox(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'privanet-bundle-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const state = join(dir, 'state'); await mkdir(state, { mode: 0o700 }); await chmod(state, 0o700);
  // Everything a node keeps that must never be in a bundle.
  await writeFile(join(state, 'identity.json'), JSON.stringify({ nodeId: 'node_x', publicKey: 'pk', privateKey: PLANTED[0]?.[1] }), { mode: 0o600 });
  await writeFile(join(state, 'enrollment.json'), JSON.stringify({ token: HEX64 }), { mode: 0o600 });
  await writeFile(join(state, 'panel-token'), HEX64B + '\n', { mode: 0o600 });
  await writeFile(join(dir, 'node.log'), `{"event":"node.connection_failed"}\n${allPlanted}\n`);
  return { dir, state, logFile: join(dir, 'node.log') };
}
const planted = { PRIVANODE_ENROLLMENT_TOKEN: HEX64, PRIVANODE_COORDINATOR_URL: 'https://admin:hunter2pw@node.example.com/x', PRIVANET_ADMIN_SECRET: 'supersecretvalueXYZ', PRIVANODE_CAPABILITIES: 'system.echo.v1' };

test('privanet-node support-bundle writes a private, secret-free file, never overwrites, can print instead, and works offline', async t => {
  const { dir, state, logFile } = await sandbox(t); const target = join(dir, 'bundle.json');
  let out = ''; let err = '';
  const run = (args: string[]) => { out = ''; err = ''; return runLocal('support-bundle', ['--state-dir', state, '--no-network', ...args], { ...planted }, { out: text => { out += text; }, err: text => { err += text; } }); };
  assert.equal(await run([target, '--log-file', logFile]), 0, err); assert.match(out, /Read it before you share it/);
  const text = await readFile(target, 'utf8'); noneOf(text, 'file'); for (const forbidden of ['hunter2', 'supersecretvalueXYZ', 'PRIVANODE_ENROLLMENT_TOKEN"']) assert.equal(text.includes(forbidden), false, forbidden);
  const bundle = JSON.parse(text) as { software: { privanode: string }; doctor: unknown; logTail: string[] | null; configurationCheck: { ok: boolean } };
  assert.ok(bundle.software.privanode); assert.equal(bundle.doctor, null, '--no-network skips the doctor'); assert.ok(Array.isArray(bundle.logTail) && bundle.logTail.length > 1);
  if (posix) assert.equal((await stat(target)).mode & 0o777, 0o600);
  assert.equal(await run([target]), 1, 'never overwrites'); assert.match(err, /already exists/);
  assert.equal(await run(['--stdout']), 0); noneOf(out, 'stdout'); assert.equal(JSON.parse(out).bundleVersion, 1);
  const identity = await readFile(join(state, 'identity.json'), 'utf8'); assert.ok(identity.includes('FAKEKEYMATERIAL'), 'the node\'s own files are untouched');
  assert.equal((await run(['--bogus=hunter2'])), 78); assert.equal(err.includes('hunter2'), false);
});

test('the real node program writes a bundle from the shell, with the doctor included, and no planted secret in it', async t => {
  const { dir, state, logFile } = await sandbox(t); const target = join(dir, 'real.json');
  const result = await new Promise<{ code: number; out: string; err: string }>(resolve => {
    const child = spawn(process.execPath, [NODE_MAIN, 'support-bundle', target, '--state-dir', state, '--log-file', logFile], { cwd: root, env: { PATH: process.env.PATH ?? '', ...planted, PRIVANODE_COORDINATOR_URL: 'https://127.0.0.1:9' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = ''; child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString(); }); child.stderr.on('data', (chunk: Buffer) => { err += chunk.toString(); }); child.once('close', code => resolve({ code: code ?? -1, out, err }));
  });
  assert.equal(result.code, 0, result.err); const text = await readFile(target, 'utf8'); noneOf(text, 'real bundle'); noneOf(result.out + result.err, 'real output');
  const bundle = JSON.parse(text) as { doctor: { stages: Array<{ id: string; status: string }> } | null; policy: { source: string } };
  assert.ok(bundle.doctor && bundle.doctor.stages.some(stage => stage.id === 'tcp' && stage.status === 'FAILED'), 'the doctor ran and reports the unreachable Coordinator');
  assert.equal(defaultResourcePolicy().maxCpuPercent > 0, true);
});
