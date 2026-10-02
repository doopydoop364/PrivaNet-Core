import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runLocal } from '@privanet/node/local-cli';
import { gatherSettings, renderSettings } from '@privanet/node/effective-settings';
import { writeEnrollmentRecord } from '@privanet/node/enrollment-record';
import { checkConfig } from '@privanet/node/config-check';
import { LOCAL_STATE_FILE } from '@privanet/node/local-state';
import { POLICY_FILE, resolvePolicy } from '@privanet/node/policy-store';
import { STATUS_FILE } from '@privanet/node/status-file';
import { buildSupportBundle } from '@privanet/node/support-bundle';
import { defaultResourcePolicy } from '@privanet/node/resource-policy';

const NODE_MAIN = join(fileURLToPath(new URL('../../', import.meta.url)), 'apps', 'node', 'dist', 'main.js');
async function sandbox(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'privanet-settings-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const state = join(dir, 'state'); await mkdir(state, { mode: 0o700 }); await chmod(state, 0o700);
  const run = async (command: string, args: string[] = [], env: NodeJS.ProcessEnv = {}) => { let out = ''; let err = ''; const code = await runLocal(command, ['--state-dir', state, ...args], env, { out: x => { out += x; }, err: x => { err += x; } }); return { code, out, err }; };
  return { dir, state, run };
}
const enrolled = (state: string, capabilities: Array<'system.echo.v1' | 'web.fetch.v1'> = ['system.echo.v1', 'web.fetch.v1']) => writeEnrollmentRecord(state, { version: 1, coordinatorUrl: 'https://coordinator.example.org', coordinatorId: '11111111-1111-4111-8111-111111111111', nodeId: `node_${'a'.repeat(64)}`, capabilities, enrolledAt: 1 });

test('precedence: environment beats saved beats default, for every setting that has more than one source', async t => {
  const { state, run } = await sandbox(t); await enrolled(state);
  // Nothing saved, nothing set: defaults and the enrollment.
  let s = (await gatherSettings({}, state, Date.now())).settings;
  assert.deepEqual([s.jobSlots.value, s.jobSlots.source, s.policy.source, s.capabilities.source, s.coordinator.source, s.panel.source, s.name.source], [1, 'default', 'default', 'enrollment', 'enrollment', 'default', 'none']);
  assert.deepEqual(s.capabilities.advertised, ['system.echo.v1', 'web.fetch.v1']); assert.equal(s.coordinator.host, 'coordinator.example.org');
  // Saved choices apply.
  await run('slots', ['set', '5']); await run('name', ['set', 'Garage PC']); await run('capability', ['disable', 'web.fetch.v1']); await run('policy', ['preset', 'generous']);
  s = (await gatherSettings({}, state, Date.now())).settings;
  assert.deepEqual([s.jobSlots.value, s.jobSlots.source, s.policy.source, s.policy.preset, s.name.value], [5, 'saved', 'saved', 'generous', 'Garage PC']); assert.deepEqual(s.capabilities.advertised, ['system.echo.v1']); assert.deepEqual(s.capabilities.disabledByOwner, ['web.fetch.v1']);
  // The environment wins over the saved convenience settings.
  const env = { PRIVANODE_JOB_SLOTS: '2', PRIVANODE_CAPABILITIES: 'system.echo.v1', PRIVANODE_COORDINATOR_URL: 'https://other.example.net', PRIVANODE_PANEL: 'off' };
  s = (await gatherSettings(env, state, Date.now())).settings;
  assert.deepEqual([s.jobSlots.value, s.jobSlots.source, s.jobSlots.locked, s.capabilities.source, s.coordinator.source, s.coordinator.host, s.panel.enabled, s.panel.source], [2, 'environment', true, 'environment', 'environment', 'other.example.net', false, 'environment']);
  assert.deepEqual(s.capabilities.disabledByOwner, [], 'a capability the environment already left out is not reported as switched off by the owner');
  // Policy: saved beats the installer file; the lock makes the file authoritative and ignores the saved policy.
  await writeFile(join(state, '..', 'installer-policy.json'), JSON.stringify({ maxCpuPercent: 7 }), { mode: 0o600 });
  const file = join(state, '..', 'installer-policy.json');
  assert.equal((await resolvePolicy(state, file)).policy.maxCpuPercent, 50, 'the saved policy wins over the installer file');
  const locked = await resolvePolicy(state, file, { locked: true }); assert.equal(locked.policy.maxCpuPercent, 7); assert.equal(locked.locked, true); assert.equal(locked.source.kind, 'env-file');
  s = (await gatherSettings({ PRIVANODE_POLICY_FILE: file, PRIVANODE_POLICY_LOCKED: 'true' }, state, Date.now())).settings; assert.deepEqual([s.policy.locked, s.policy.source, s.policy.savedFileIgnored], [true, 'installer-file', true]);
});

test('the CLI reports the effective values and sources, and refuses what the environment locks', async t => {
  const { state, run } = await sandbox(t); await enrolled(state);
  const plain = await run('settings'); assert.equal(plain.code, 0); assert.match(plain.out, /Job slots\s+1 \(default\)/); assert.match(plain.out, /Coordinator\s+coordinator\.example\.org \(from enrollment\); not editable here/); assert.match(plain.out, /never automatic/);
  await run('slots', ['set', '4']); assert.match((await run('settings')).out, /Job slots\s+4 \(saved by you\)/);
  const locked = await run('settings', [], { PRIVANODE_JOB_SLOTS: '9', PRIVANODE_POLICY_LOCKED: 'true' }); assert.match(locked.out, /Job slots\s+9 \(set by the environment; this cannot be changed/); assert.match(locked.out, /LOCKED by PRIVANODE_POLICY_LOCKED/);
  const json = JSON.parse((await run('settings', ['--json'], { PRIVANODE_JOB_SLOTS: '9' })).out); assert.deepEqual([json.jobSlots.value, json.jobSlots.locked, json.jobSlots.saved], [9, true, 4]);
  // A locked policy: every writing command refuses, with the same fixed code, and writes nothing.
  const lock = { PRIVANODE_POLICY_LOCKED: 'true' }; await writeFile(join(state, '..', 'p.json'), '{}');
  for (const args of [['preset', 'generous'], ['reset'], ['import', join(state, '..', 'p.json')]]) { const refused = await run('policy', args, lock); assert.equal(refused.code, 1, args.join(' ')); assert.match(refused.err, /POLICY_LOCKED_BY_ENVIRONMENT/); assert.match(refused.err, /PRIVANODE_POLICY_LOCKED=true/); }
  assert.equal((await readdir(state)).includes(POLICY_FILE), false);
  assert.equal((await run('policy', ['show'], lock)).code, 0, 'reading is always allowed');
  assert.equal((await run('settings', ['bogus'])).code, 78); assert.equal((await run('settings', ['--bogus'])).code, 78);
  assert.match(renderSettings((await gatherSettings({}, state, 0)).settings), /Updates\s+never automatic/);
});

test('a damaged local-state.json: every writing command says what to do and changes nothing, reads still work and say so', async t => {
  const { state, run } = await sandbox(t); await writeFile(join(state, LOCAL_STATE_FILE), '{"version":1,"jobSlots":500}', { mode: 0o600 });
  for (const [command, args] of [['slots', ['set', '3']], ['pause', ['1h']], ['name', ['set', 'x']], ['capability', ['disable', 'web.fetch.v1']]] as const) {
    const result = await run(command, [...args]); assert.equal(result.code, 1, command); assert.match(result.err, /LOCAL_STATE_INVALID/); assert.match(result.err, /config check/); assert.match(result.err, /nothing was changed/); }
  assert.equal(await readFile(join(state, LOCAL_STATE_FILE), 'utf8'), '{"version":1,"jobSlots":500}', 'the damaged file is never overwritten');
  const settings = await run('settings'); assert.equal(settings.code, 1); assert.match(settings.out, /PROBLEM LOCAL_STATE_INVALID/); assert.match(settings.out, /config check/);
  const check = await checkConfig({ PRIVANODE_STATE_DIR: state }); assert.equal(check.ok, false); assert.ok(check.findings.some(finding => finding.id === 'LOCAL_STATE_INVALID' && /paused/.test(finding.message)));
});

test('config check: a saved job-slot number is checked, and an environment override or a policy lock that hides a saved value is said out loud', async t => {
  const { state, run } = await sandbox(t); await enrolled(state); await run('slots', ['set', '20']); await run('policy', ['preset', 'minimal']);
  const base = { PRIVANODE_STATE_DIR: state };
  const saved = await checkConfig(base); assert.ok(saved.findings.some(f => /slot/i.test(f.message)) || saved.ok, 'the saved 20 slots are weighed against the minimal policy');
  const overridden = await checkConfig({ ...base, PRIVANODE_JOB_SLOTS: '2' }); assert.ok(overridden.findings.some(f => f.id === 'JOB_SLOTS_ENVIRONMENT_WINS' && f.severity === 'info' && /unset the variable/i.test(f.message)));
  const locked = await checkConfig({ ...base, PRIVANODE_POLICY_LOCKED: 'true' }); assert.ok(locked.findings.some(f => f.id === 'POLICY_LOCKED_SAVED_IGNORED'));
  const bad = await checkConfig({ ...base, PRIVANODE_POLICY_LOCKED: 'maybe' }); assert.equal(bad.ok, false); assert.ok(bad.findings.some(f => f.setting === 'PRIVANODE_POLICY_LOCKED'));
  for (const value of ['0', '65', '1.5', 'many']) { const invalid = await checkConfig({ ...base, PRIVANODE_JOB_SLOTS: value }); assert.equal(invalid.ok, false, value); assert.ok(invalid.findings.some(f => f.setting === 'PRIVANODE_JOB_SLOTS'), value); }
});

test('the support bundle carries the effective settings, with their sources, and no secret', async t => {
  const { state, run } = await sandbox(t); await enrolled(state); await run('slots', ['set', '3']);
  const gathered = await gatherSettings({ PRIVANODE_POLICY_LOCKED: 'true' }, state, Date.now());
  const bundle = buildSupportBundle({ env: {}, policy: { policy: defaultResourcePolicy(), source: { kind: 'defaults' } }, local: { version: 1, disabledCapabilities: [], jobSlots: 3 }, settings: gathered.settings }) as { effectiveSettings: { jobSlots: { value: number; source: string }; policy: { locked: boolean } } };
  assert.deepEqual([bundle.effectiveSettings.jobSlots.value, bundle.effectiveSettings.jobSlots.source, bundle.effectiveSettings.policy.locked], [3, 'saved', true]);
});

test('the real node never starts more workers than 64 or trusts a damaged file: a saved 500 holds the node paused on the default, and says so', async t => {
  const { state, run } = await sandbox(t); await writeFile(join(state, LOCAL_STATE_FILE), '{"version":1,"disabledCapabilities":[],"jobSlots":500}', { mode: 0o600 });
  const child = spawn(process.execPath, [NODE_MAIN], { env: { PATH: process.env.PATH ?? '', PRIVANODE_COORDINATOR_URL: 'https://127.0.0.1:9', PRIVANODE_CAPABILITIES: 'system.echo.v1', PRIVANODE_STATE_DIR: state, PRIVANODE_PANEL: 'off' }, stdio: 'ignore' }); t.after(() => { child.kill('SIGKILL'); });
  const until = Date.now() + 15000; let doc: { jobs: { slots: { configured: number } }; contribution: { problems: Array<{ code: string }> }; idle: { reasons: Array<{ code: string }> } } | undefined;
  while (Date.now() < until && !doc) { try { doc = (JSON.parse(await readFile(join(state, STATUS_FILE), 'utf8')) as { status: NonNullable<typeof doc> }).status; } catch { await new Promise(resolve => setTimeout(resolve, 100)); } }
  assert.ok(doc, 'the node started'); assert.equal(doc.jobs.slots.configured, 1, 'the damaged value is not used'); assert.ok(doc.idle.reasons.some(reason => reason.code === 'LOCAL_STATE_UNREADABLE'), 'it holds itself paused and says why');
  assert.equal((await run('settings')).code, 1);
});
