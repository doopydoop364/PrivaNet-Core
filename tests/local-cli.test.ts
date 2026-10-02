import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runLocal } from '@privanet/node/local-cli';
import { checkConfig, policyFindings } from '@privanet/node/config-check';
import { defaultResourcePolicy, ResourcePolicySchema } from '@privanet/node/resource-policy';
import { STATUS_FILE } from '@privanet/node/status-file';
import { POLICY_FILE, readPolicyFile } from '@privanet/node/policy-store';
import { LOCAL_STATE_FILE, readLocalState } from '@privanet/node/local-state';

const posix = process.platform !== 'win32';
async function sandbox(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'privanet-cli-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const state = join(dir, 'state'); await mkdir(state, { mode: 0o700 }); await chmod(state, 0o700);
  const run = async (command: string, args: string[] = [], env: NodeJS.ProcessEnv = {}) => {
    let out = ''; let err = '';
    const code = await runLocal(command, ['--state-dir', state, ...args], { ...env }, { out: text => { out += text; }, err: text => { err += text; } });
    return { code, out, err };
  };
  return { dir, state, run };
}

test('pause and resume work without a running node, say what they did, and the daemon-side file reflects it', async t => {
  const { state, run } = await sandbox(t);
  const paused = await run('pause', ['1h']); assert.equal(paused.code, 0); assert.match(paused.out, /paused until/);
  const local = await readLocalState(state); assert.equal(local.state.pause?.kind, 'timed');
  if (posix) assert.equal((await stat(join(state, LOCAL_STATE_FILE))).mode & 0o777, 0o600);
  const reboot = await run('pause', ['reboot']); assert.match(reboot.out, /restarts/);
  const resumed = await run('resume'); assert.equal(resumed.code, 0); assert.equal((await readLocalState(state)).state.pause, undefined);
  const json = await run('pause', ['tomorrow', '--json']); assert.deepEqual(Object.keys(JSON.parse(json.out)).sort(), ['ok', 'pause']);
  for (const bad of [[], ['soon'], ['15m', 'extra']]) { const result = await run('pause', bad); assert.equal(result.code, 78); assert.match(result.err, /usage/); }
});

test('usage errors exit 78 and never echo what was typed', async t => {
  const { run } = await sandbox(t);
  const result = await run('pause', ['15m', '--password=hunter2']);
  assert.equal(result.code, 78); assert.equal((result.out + result.err).includes('hunter2'), false); assert.match(result.err, /unknown option --password/);
  const unknown = await run('policy', ['frobnicate']); assert.equal(unknown.code, 78);
  const help = await run('status', ['--help']); assert.equal(help.code, 0); assert.match(help.out, /Usage: privanet-node/);
});

test('status: with no running node it says so (and exits 1) while still showing what the files say; with a fresh published snapshot it renders it', async t => {
  const { state, run } = await sandbox(t);
  await run('pause', ['indefinite']);
  const offline = await run('status'); assert.equal(offline.code, 1); assert.match(offline.out, /not running/); assert.match(offline.out, /pause: indefinite/);
  const offlineJson = JSON.parse((await run('status', ['--json'])).out) as { running: boolean; idle: { reasons: Array<{ code: string }> } }; assert.equal(offlineJson.running, false); assert.ok(offlineJson.idle.reasons.some(reason => reason.code === 'NODE_NOT_RUNNING'));
  const doc = { node: { localName: 'Garage', coordinatorLabel: 'Anna', id: 'node_3a7f19c2…', version: '0.3.5', protocolVersion: 1, uptimeMs: 1000 }, coordinator: { host: 'node.example.com', compatibility: { state: 'current', message: 'same version' } },
    connection: { state: 'online', lastContactAt: Date.now() - 3000 }, contribution: { mode: 'ADAPTIVE', pause: null, preset: 'balanced', policySource: { kind: 'defaults' }, pressure: 'NORMAL', problems: [], restartRequired: [] },
    jobs: { active: [], slots: { effective: 1 }, counters: { completed: 4, failed: 0, preempted: 1, leaseLost: 0 } }, capabilities: [{ id: 'system.echo.v1', enabled: true }, { id: 'web.fetch.v1', enabled: false }],
    limits: { permitted: { memoryBytes: 1024 ** 3, cpuPercent: 25 }, configured: { maxCpuPercent: 25, maxMemoryBytes: 1024 ** 3 } }, idle: { idle: true, summary: 'No compatible jobs are currently available.', reasons: [{ code: 'NO_COMPATIBLE_JOBS', message: 'No compatible jobs are currently available.' }] } };
  await writeFile(join(state, STATUS_FILE), JSON.stringify({ version: 1, publishedAt: Date.now(), status: doc }), { mode: 0o600 });
  const live = await run('status'); assert.equal(live.code, 0); assert.match(live.out, /Garage \/ Anna/); assert.match(live.out, /web\.fetch\.v1 \(off\)/); assert.match(live.out, /Idle: No compatible jobs/);
  assert.equal(JSON.parse((await run('status', ['--json'])).out).running, true);
  await writeFile(join(state, STATUS_FILE), JSON.stringify({ version: 1, publishedAt: Date.now() - 120000, status: doc }), { mode: 0o600 });
  assert.equal((await run('status')).code, 1, 'a stale snapshot means the node is not running');
});

test('policy: show, preset, export, import, reset; imports are validated before anything is replaced, with a backup', async t => {
  const { dir, state, run } = await sandbox(t);
  const show = await run('policy', ['show']); assert.match(show.out, /conservative defaults/); assert.match(show.out, /preset: balanced/);
  const preset = await run('policy', ['preset', 'generous']); assert.equal(preset.code, 0); assert.match(preset.out, /Generous/);
  const saved = await readPolicyFile(state); assert.equal(saved.kind, 'ok'); if (saved.kind === 'ok') assert.equal(saved.file.preset, 'generous');
  assert.equal((await run('policy', ['preset', 'turbo'])).code, 78);
  const exported = join(dir, 'prefs.json'); const exportResult = await run('policy', ['export', exported]); assert.equal(exportResult.code, 0);
  if (posix) assert.equal((await stat(exported)).mode & 0o777, 0o600);
  const again = await run('policy', ['export', exported]); assert.equal(again.code, 1, 'refuses to overwrite without --force'); assert.equal((await run('policy', ['export', exported, '--force'])).code, 0);
  const text = await readFile(exported, 'utf8'); for (const forbidden of ['identity', 'privateKey', 'token', 'enrollment']) assert.equal(text.includes(forbidden), false);
  await run('policy', ['preset', 'minimal']);
  const imported = await run('policy', ['import', exported]); assert.equal(imported.code, 0); assert.match(imported.out, /policy\.json\.bak/);
  const afterImport = await readPolicyFile(state); assert.equal(afterImport.kind === 'ok' && afterImport.file.policy.maxCpuPercent, 50);
  const bad = join(dir, 'bad.json'); await writeFile(bad, JSON.stringify({ maxCpuPercent: 'many' }));
  const rejected = await run('policy', ['import', bad]); assert.equal(rejected.code, 1); assert.match(rejected.err, /maxCpuPercent/);
  const hostile = join(dir, 'hostile.json'); await writeFile(hostile, JSON.stringify({ fetch: { unsafeLocal: { allowedCidrs: ['10.0.0.0/8'] } } }));
  const refused = await run('policy', ['import', hostile]); assert.equal(refused.code, 1); assert.match(refused.err, /UNSAFE_LOCAL|unsafeLocal/);
  const afterRefusals = await readPolicyFile(state); assert.equal(afterRefusals.kind === 'ok' && afterRefusals.file.policy.maxCpuPercent, 50, 'nothing was replaced');
  const huge = join(dir, 'huge.json'); await writeFile(huge, 'x'.repeat(100000)); assert.equal((await run('policy', ['import', huge])).code, 1);
  assert.equal((await run('policy', ['reset'])).code, 0); assert.equal((await readPolicyFile(state)).kind, 'absent');
  assert.ok(POLICY_FILE.length > 0);
});

test('name and capability commands change local choices only, within what the software knows', async t => {
  const { state, run } = await sandbox(t);
  assert.equal((await run('name', ['set', 'Anna\'s', 'desktop'])).code, 0); assert.equal((await readLocalState(state)).state.name, 'Anna\'s desktop');
  assert.match((await run('name', ['show'])).out, /Anna's desktop/);
  assert.equal((await run('name', ['set', 'bad;name'])).code, 78);
  assert.equal((await run('name', ['clear'])).code, 0); assert.equal((await readLocalState(state)).state.name, undefined);
  assert.equal((await run('capability', ['disable', 'web.fetch.v1'])).code, 0); assert.deepEqual((await readLocalState(state)).state.disabledCapabilities, ['web.fetch.v1']);
  assert.equal((await run('capability', ['enable', 'web.fetch.v1'])).code, 0); assert.deepEqual((await readLocalState(state)).state.disabledCapabilities, []);
  assert.equal((await run('capability', ['disable', 'rm -rf /'])).code, 78);
  assert.equal((await run('capability', ['toggle', 'web.fetch.v1'])).code, 78);
});

test('config check: offline, strict, names settings without values, and flags contradictions', async t => {
  const { state, run } = await sandbox(t);
  const clean = await run('config', ['check'], { PRIVANODE_COORDINATOR_URL: 'https://node.example.com', PRIVANODE_CAPABILITIES: 'system.echo.v1' }); assert.equal(clean.code, 0, clean.out + clean.err); assert.match(clean.out, /valid/);
  const secret = 'f'.repeat(64);
  const broken = await run('config', ['check'], { PRIVANODE_COORDINATOR_URL: 'http://user:pw@node.example.com', PRIVANODE_CAPABILITIES: 'nonsense.v1', PRIVANODE_ENROLLMENT_TOKEN: `${secret}zz`, PRIVANODE_JOB_SLOTS: '0' });
  assert.equal(broken.code, 1); for (const name of ['PRIVANODE_COORDINATOR_URL', 'PRIVANODE_CAPABILITIES', 'PRIVANODE_ENROLLMENT_TOKEN', 'PRIVANODE_JOB_SLOTS']) assert.match(broken.out, new RegExp(name));
  for (const leaked of ['pw@', 'nonsense', secret, 'user:']) assert.equal((broken.out + broken.err).includes(leaked), false, `value not shown: ${leaked}`);
  await writeFile(join(state, POLICY_FILE), JSON.stringify({ version: 1, savedAt: 0, policy: ResourcePolicySchema.parse({ maxCpuPercent: 90, reserveCpuPercent: 40, defaultLevel: 'OFF' }) }), { mode: 0o600 });
  const contradiction = await run('config', ['check', '--json'], { PRIVANODE_COORDINATOR_URL: 'https://node.example.com', PRIVANODE_CAPABILITIES: 'system.echo.v1' });
  const parsed = JSON.parse(contradiction.out) as { ok: boolean; findings: Array<{ id: string }>; policy: { source: string } };
  assert.ok(parsed.findings.some(finding => finding.id === 'CPU_CEILING_UNREACHABLE')); assert.ok(parsed.findings.some(finding => finding.id === 'ALWAYS_OFF')); assert.match(parsed.policy.source, /saved policy/);
  await writeFile(join(state, POLICY_FILE), '{"version": 9}', { mode: 0o600 });
  const newer = await run('config', ['check'], { PRIVANODE_COORDINATOR_URL: 'https://node.example.com', PRIVANODE_CAPABILITIES: 'system.echo.v1' }); assert.equal(newer.code, 1); assert.match(newer.out, /POLICY_FILE_NEWER/);
  await writeFile(join(state, POLICY_FILE), '{"version": 1', { mode: 0o600 });
  assert.equal((await run('config', ['check'], { PRIVANODE_COORDINATOR_URL: 'https://node.example.com', PRIVANODE_CAPABILITIES: 'system.echo.v1' })).code, 1);
  assert.equal((await run('config', [])).code, 78);
});

test('the policy checks are one implementation: the same findings come from the library the panel will call', () => {
  const findings = policyFindings(ResourcePolicySchema.parse({ maxCpuPercent: 95, reserveCpuPercent: 20 }));
  assert.ok(findings.some(finding => finding.id === 'CPU_CEILING_UNREACHABLE'));
  assert.deepEqual(policyFindings(defaultResourcePolicy()).filter(finding => finding.severity === 'error'), []);
  assert.ok(policyFindings({ maxCpuPercent: 'x' }).every(finding => finding.severity === 'error'));
  assert.ok(policyFindings(ResourcePolicySchema.parse({ maxMemoryBytes: 64 * 1024 ** 3 })).some(finding => finding.id === 'MEMORY_ABOVE_INSTALLED'));
  assert.ok(policyFindings(defaultResourcePolicy(), { jobSlots: 64 }).some(finding => finding.id === 'SLOTS_EXCEED_MEMORY'));
  assert.equal(typeof checkConfig, 'function');
});
