import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrivaNode } from '@privanet/node/daemon';
import type { NodeSnapshot } from '@privanet/node/daemon';
import { ResourceEngine } from '@privanet/node/resource-engine';
import { ResourcePolicySchema, defaultResourcePolicy } from '@privanet/node/resource-policy';
import type { ResourcePolicy } from '@privanet/node/resource-policy';
import type { HostSample } from '@privanet/node/resource-sampler';
import { PRESETS, PRESET_FIELDS, PRESET_IDS, applyPreset, detectPreset } from '@privanet/node/presets';
import { POLICY_FILE, PolicyError, exportPolicyText, parsePolicyText, readPolicyFile, removePolicyFile, resolvePolicy, savePolicyFile } from '@privanet/node/policy-store';
import { LOCAL_STATE_FILE, activePause, makePause, nextLocalMidnight, readLocalState, updateLocalState } from '@privanet/node/local-state';
import { LocalControl } from '@privanet/node/local-control';
import { TransferMeter } from '@privanet/node/transfer-meter';
import { ResourceHistory } from '@privanet/node/history';
import { compatibility, explainIdle } from '@privanet/node/status';
import { buildStatus } from '@privanet/node/status-document';

const GiB = 1024 ** 3;
const posix = process.platform !== 'win32';
async function stateDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'privanet-local-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const state = join(dir, 'state'); await mkdir(state, { mode: 0o700 }); await chmod(state, 0o700); return state;
}

test('presets are ordinary policy values: each validates, balanced is the conservative default, and any single change turns it into custom', () => {
  for (const id of PRESET_IDS) {
    const policy = applyPreset(defaultResourcePolicy(), id);
    assert.equal(detectPreset(policy), id);
    assert.doesNotThrow(() => ResourcePolicySchema.parse(policy));
    assert.ok(PRESETS[id].label.length > 0);
  }
  const defaults = defaultResourcePolicy();
  for (const field of PRESET_FIELDS) assert.deepEqual(defaults[field], PRESETS.balanced.values[field], `balanced.${field} is the default`);
  assert.equal(detectPreset(defaults), 'balanced');
  const tweaked = { ...applyPreset(defaults, 'generous'), maxCpuPercent: 51 };
  assert.equal(detectPreset(tweaked), 'custom');
  // Defaults stay conservative: no preset below the defaults turns anything on that the defaults do not.
  assert.ok(PRESETS.minimal.values.maxCpuPercent < defaults.maxCpuPercent && PRESETS.minimal.values.maxMemoryBytes < defaults.maxMemoryBytes);
});

test('choosing a preset keeps the owner\'s schedule, capability limits and fetch limits', () => {
  const custom = ResourcePolicySchema.parse({ schedule: [{ days: [1, 2], from: '09:00', to: '17:00', level: 'OFF' }], capabilityLimits: { 'web.fetch.v1': { maxCpuPercent: 5 } }, fetch: { maxRequestsPerMinute: 7 }, preemptAfterMs: 1234 });
  const next = applyPreset(custom, 'maximum-idle');
  assert.deepEqual(next.schedule, custom.schedule); assert.deepEqual(next.capabilityLimits, custom.capabilityLimits);
  assert.equal(next.fetch.maxRequestsPerMinute, 7); assert.equal(next.preemptAfterMs, 1234);
  assert.equal(next.maxCpuPercent, PRESETS['maximum-idle'].values.maxCpuPercent); assert.equal(next.maxBandwidthBytesPerSec, null);
});

test('saved policy: versioned, private, atomic, with a backup of the previous one, and it wins over the installer\'s file', async t => {
  const dir = await stateDir(t); const policy = applyPreset(defaultResourcePolicy(), 'generous');
  assert.equal((await readPolicyFile(dir)).kind, 'absent');
  await savePolicyFile(dir, policy, 'generous', 1234);
  const read = await readPolicyFile(dir); assert.equal(read.kind, 'ok');
  if (posix) assert.equal((await stat(join(dir, POLICY_FILE))).mode & 0o777, 0o600);
  const onDisk = JSON.parse(await readFile(join(dir, POLICY_FILE), 'utf8')) as { version: number; preset: string; policy: { maxCpuPercent: number } };
  assert.equal(onDisk.version, 1); assert.equal(onDisk.preset, 'generous'); assert.equal(onDisk.policy.maxCpuPercent, 50);
  assert.equal((await readdir(dir)).some(name => name.endsWith('.tmp')), false, 'no temporary file is left behind');
  await savePolicyFile(dir, applyPreset(policy, 'minimal'), 'minimal');
  const backup = JSON.parse(await readFile(join(dir, `${POLICY_FILE}.bak`), 'utf8')) as { preset: string };
  assert.equal(backup.preset, 'generous', 'the previous saved policy is kept as .bak');
  const installerFile = join(dir, '..', 'installer-policy.json'); await writeFile(installerFile, JSON.stringify({ maxCpuPercent: 77 }), { mode: 0o600 });
  const resolved = await resolvePolicy(dir, installerFile);
  assert.equal(resolved.source.kind, 'saved'); assert.equal(resolved.policy.maxCpuPercent, 10);
  assert.equal(await removePolicyFile(dir), true);
  const after = await resolvePolicy(dir, installerFile); assert.equal(after.source.kind, 'env-file'); assert.equal(after.policy.maxCpuPercent, 77);
  assert.equal(await removePolicyFile(dir), false);
});

test('policy migration: a bare policy file (the installer\'s format) reads as version 0 and is upgraded when saved, with the old file kept', async t => {
  const dir = await stateDir(t);
  await writeFile(join(dir, POLICY_FILE), JSON.stringify({ maxCpuPercent: 33, schedule: [{ days: [0], from: '01:00', to: '02:00', level: 'FULL' }] }), { mode: 0o600 });
  const read = await readPolicyFile(dir); assert.equal(read.kind, 'ok'); if (read.kind === 'ok') { assert.equal(read.migratedFrom, 0); assert.equal(read.file.policy.maxCpuPercent, 33); assert.equal(read.file.policy.schedule.length, 1); }
  const resolved = await resolvePolicy(dir, undefined); await savePolicyFile(dir, resolved.policy);
  const upgraded = JSON.parse(await readFile(join(dir, POLICY_FILE), 'utf8')) as { version: number; policy: { maxCpuPercent: number } };
  assert.equal(upgraded.version, 1); assert.equal(upgraded.policy.maxCpuPercent, 33);
  assert.equal(JSON.parse(await readFile(join(dir, `${POLICY_FILE}.bak`), 'utf8')).maxCpuPercent, 33, 'the pre-migration file is preserved');
});

test('a newer-version, damaged or unsafe saved policy is never applied and never overwritten: the fallback applies and the problem is named', async t => {
  const dir = await stateDir(t); const path = join(dir, POLICY_FILE);
  const newer = JSON.stringify({ version: 2, savedAt: 1, policy: { maxCpuPercent: 99, futureThing: true } });
  await writeFile(path, newer, { mode: 0o600 });
  let resolved = await resolvePolicy(dir, undefined);
  assert.equal(resolved.problem?.code, 'POLICY_FILE_NEWER'); assert.equal(resolved.problem?.fellBackTo, 'defaults'); assert.equal(resolved.policy.maxCpuPercent, defaultResourcePolicy().maxCpuPercent);
  assert.equal(await readFile(path, 'utf8'), newer, 'untouched');
  await writeFile(path, '{not json', { mode: 0o600 }); resolved = await resolvePolicy(dir, undefined); assert.equal(resolved.problem?.code, 'POLICY_NOT_JSON');
  await writeFile(path, JSON.stringify({ maxCpuPercent: 'lots' }), { mode: 0o600 }); resolved = await resolvePolicy(dir, undefined);
  assert.equal(resolved.problem?.code, 'POLICY_FILE_INVALID'); assert.ok(resolved.problem?.issues.some(issue => issue.startsWith('maxCpuPercent')));
  if (posix) { await chmod(path, 0o644); resolved = await resolvePolicy(dir, undefined); assert.equal(resolved.problem?.code, 'POLICY_FILE_UNSAFE'); }
});

test('the SSRF escape hatch can never arrive through a save, an import or a saved file, and an export never carries it', async t => {
  const dir = await stateDir(t);
  const unsafe = ResourcePolicySchema.parse({ fetch: { unsafeLocal: { allowedCidrs: ['10.0.0.0/8'], allowedPorts: [8080] } } });
  await assert.rejects(savePolicyFile(dir, unsafe), (error: unknown) => error instanceof PolicyError && error.code === 'UNSAFE_LOCAL_NOT_ALLOWED');
  await writeFile(join(dir, POLICY_FILE), JSON.stringify({ version: 1, savedAt: 0, policy: unsafe }), { mode: 0o600 });
  const read = await readPolicyFile(dir); assert.equal(read.kind, 'error'); if (read.kind === 'error') assert.equal(read.code, 'UNSAFE_LOCAL_NOT_ALLOWED');
  const exported = exportPolicyText(unsafe, 'custom'); assert.doesNotMatch(exported, /unsafeLocal|10\.0\.0\.0/);
  assert.doesNotThrow(() => parsePolicyText(exported));
});

test('policy text from outside is bounded and strict, and an export holds preferences only', () => {
  assert.throws(() => parsePolicyText('x'.repeat(70000)), (error: unknown) => error instanceof PolicyError && error.code === 'POLICY_TOO_LARGE');
  assert.throws(() => parsePolicyText('[1,2]'), PolicyError);
  assert.throws(() => parsePolicyText(JSON.stringify({ version: 1, savedAt: 0, policy: defaultResourcePolicy(), extra: 1 })), PolicyError);
  const text = exportPolicyText(applyPreset(defaultResourcePolicy(), 'generous'), 'generous');
  for (const forbidden of ['identity', 'privateKey', 'publicKey', 'token', 'session', 'coordinatorUrl', 'enrollment', 'nodeId']) assert.equal(text.includes(forbidden), false, forbidden);
  assert.equal(parsePolicyText(text).preset, 'generous');
});

test('concurrent saves are atomic: every read sees one complete, valid policy', async t => {
  const dir = await stateDir(t); await savePolicyFile(dir, defaultResourcePolicy());
  const writers = Array.from({ length: 25 }, (_, i) => savePolicyFile(dir, ResourcePolicySchema.parse({ maxCpuPercent: 10 + i })));
  const readers = Array.from({ length: 60 }, async () => { const read = await readPolicyFile(dir); assert.equal(read.kind, 'ok'); });
  await Promise.all([...writers, ...readers]);
  assert.equal((await readdir(dir)).some(name => name.endsWith('.tmp')), false);
});

test('pauses: timed ones end by themselves, "until tomorrow" is the next local midnight, "until reboot" survives a node restart but not a reboot', () => {
  const now = new Date(2026, 5, 10, 21, 30).getTime();
  const quarter = makePause({ kind: '15m' }, now); assert.equal(activePause(quarter, now + 14 * 60000)?.kind, 'timed'); assert.equal(activePause(quarter, now + 15 * 60000), undefined);
  const hour = makePause({ kind: '1h' }, now); assert.ok(activePause(hour, now + 59 * 60000)); assert.equal(activePause(hour, now + 3600000), undefined);
  const tomorrow = makePause({ kind: 'tomorrow' }, now);
  assert.equal(tomorrow.kind === 'timed' && tomorrow.until, nextLocalMidnight(now)); assert.equal(new Date(nextLocalMidnight(now)).getHours(), 0); assert.equal(new Date(nextLocalMidnight(now)).getDate(), 11);
  assert.ok(activePause(tomorrow, now + 60000)); assert.equal(activePause(tomorrow, nextLocalMidnight(now)), undefined);
  const bootA = now - 5 * 3600000; const reboot = makePause({ kind: 'reboot' }, now, bootA);
  assert.ok(activePause(reboot, now + 600000, bootA + 1500), 'a restart of the program alone (same boot, a second of drift) keeps it');
  assert.equal(activePause(reboot, now + 7200000, now + 7000000 - 30000), undefined, 'a later boot ends it');
  assert.equal(activePause(makePause({ kind: 'indefinite' }, now), now + 10 * 86400000)?.kind, 'indefinite');
  assert.equal(activePause(undefined, now), undefined);
});

test('local state: private, validated, never overwritten when it cannot be understood', async t => {
  const dir = await stateDir(t);
  assert.equal((await readLocalState(dir)).kind, 'absent');
  const state = await updateLocalState(dir, current => ({ ...current, name: 'Anna\'s desktop', disabledCapabilities: ['web.fetch.v1'] }));
  assert.equal(state.name, 'Anna\'s desktop');
  if (posix) assert.equal((await stat(join(dir, LOCAL_STATE_FILE))).mode & 0o777, 0o600);
  await assert.rejects(updateLocalState(dir, current => ({ ...current, name: 'bad\nname' })));
  const newer = JSON.stringify({ version: 2, name: 'x' }); await writeFile(join(dir, LOCAL_STATE_FILE), newer, { mode: 0o600 });
  const read = await readLocalState(dir); assert.equal(read.kind, 'error'); if (read.kind === 'error') assert.equal(read.code, 'LOCAL_STATE_NEWER');
  await assert.rejects(updateLocalState(dir, current => current), /LOCAL_STATE_NEWER/);
  assert.equal(await readFile(join(dir, LOCAL_STATE_FILE), 'utf8'), newer);
});

// ---- the engine's reasons and the idle explanation ----
function rig(overrides: Record<string, unknown> = {}, initial: Partial<HostSample> = {}) {
  const policy: ResourcePolicy = ResourcePolicySchema.parse({ maxMemoryBytes: 8 * GiB, reserveMemoryBytes: 2 * GiB, safetyMarginBytes: GiB / 2, maxCpuPercent: 50, ...overrides });
  const host: HostSample = { availableMemoryBytes: 12 * GiB, ownerCpuPercent: 5, power: 'AC', freeDiskBytes: 100 * GiB, ...initial };
  let now = new Date(2026, 0, 7, 12, 0).getTime();
  const engine = new ResourceEngine(policy, { sample: () => ({ ...host }) }, () => now);
  return { engine, host, step(ms = 1000, times = 1) { for (let i = 0; i < times; i++) { now += ms; engine.update(); } return engine.report; } };
}
const snapshot = (overrides: Partial<NodeSnapshot> = {}): NodeSnapshot => ({ startedAt: 0, nodeId: 'node_abcdef0123456789', connected: true, draining: false, lastContactAt: 1000, lastLease: { at: 1000, result: 'empty' }, lastFailure: null,
  coordinator: { serviceVersion: '0.3.5', protocolVersion: 1 }, coordinatorLabel: null, counters: { completed: 0, failed: 0, preempted: 0, handedBackOnShutdown: 0, leaseLost: 0 }, activeJobs: [], slots: { configured: 1, effective: 1 },
  enrolledCapabilities: ['system.echo.v1'], advertisedCapabilities: ['system.echo.v1'], ...overrides });
const why = (r: ReturnType<typeof rig>, node: NodeSnapshot | null, pause?: Parameters<typeof explainIdle>[0]['pause']) => explainIdle({ now: 5000, node, report: r.engine.report, engine: r.engine.state, pause });
const codes = (explanation: ReturnType<typeof explainIdle>) => explanation.reasons.map(reason => reason.code);

test('why am I idle: "no compatible jobs" is said only when nothing blocks it and the Coordinator really had none', () => {
  const r = rig(); r.engine.update();
  assert.deepEqual(codes(why(r, snapshot())), ['NO_COMPATIBLE_JOBS']);
  assert.deepEqual(codes(why(r, snapshot({ lastLease: null }))), ['NOT_ASKED_YET'], 'never guessed before the first poll');
  const working = why(r, snapshot({ activeJobs: [{ jobId: 'j', type: 'system.echo.v1', startedAt: 1, preemptible: true, checkpointable: false, expectedDurationMs: 100, state: 'running', estimate: { cpu: 'low', memoryBytes: 1, diskBytes: 0, networkBytes: 0 } }] }));
  assert.equal(working.idle, false); assert.deepEqual(codes(working), ['ALL_SLOTS_BUSY']);
});

test('why am I idle: owner pause, schedule OFF, battery, memory and CPU pressure, zero limits are each named from the engine\'s own numbers', () => {
  const paused = rig(); paused.engine.setOwnerPause({ kind: 'timed', until: 9999999 }); paused.engine.update();
  assert.equal(paused.engine.report.contribution, 'PAUSED'); assert.ok(codes(why(paused, snapshot(), { kind: 'timed', until: 9999999 })).includes('PAUSED_BY_OWNER'));
  const night = rig({ defaultLevel: 'OFF' }); night.engine.update(); assert.ok(codes(why(night, snapshot())).includes('SCHEDULE_OFF'));
  const battery = rig({ onBattery: 'disable' }, { power: 'BATTERY' }); battery.engine.update(); assert.ok(codes(why(battery, snapshot())).includes('ON_BATTERY'));
  const memory = rig({}, { availableMemoryBytes: 2 * GiB }); memory.engine.update(); assert.ok(codes(why(memory, snapshot())).includes('MEMORY_PRESSURE'));
  const cpu = rig({}, { ownerCpuPercent: 99 }); cpu.engine.update(); assert.ok(codes(why(cpu, snapshot())).includes('CPU_PRESSURE'));
  const zero = rig({ maxCpuPercent: 0 }); zero.engine.update(); assert.ok(codes(why(zero, snapshot())).includes('POLICY_ZERO_LIMIT'));
  const fine = rig(); fine.engine.update(); fine.engine.setOwnerPause(undefined); fine.engine.update(); assert.equal(fine.engine.report.contribution, 'ADAPTIVE');
  assert.equal(why(night, snapshot()).idle, true);
});

test('why am I idle: exhausted disk and transfer budgets are limits, not a pause, and a reduced battery level is mentioned', () => {
  const disk = rig({ reserveDiskBytes: 200 * GiB }); disk.engine.update();
  const explained = why(disk, snapshot()); assert.ok(codes(explained).includes('DISK_BUDGET_EXHAUSTED')); assert.equal(disk.engine.report.contribution, 'ADAPTIVE');
  const reduced = rig({ onBattery: 'reduce' }, { power: 'BATTERY' }); reduced.engine.update(); assert.ok(codes(why(reduced, snapshot())).includes('BATTERY_REDUCED'));
  let remaining = 0;
  const metered = new ResourceEngine(ResourcePolicySchema.parse({ maxMemoryBytes: 8 * GiB }), { sample: () => ({ availableMemoryBytes: 12 * GiB, ownerCpuPercent: 5, power: 'AC' as const, freeDiskBytes: 100 * GiB }) }, Date.now, { remainingBytes: () => remaining });
  metered.update(); assert.ok(metered.state.constraints.includes('TRANSFER_ALLOWANCE_EXHAUSTED'));
  remaining = 5 * GiB; metered.update(); assert.equal(metered.state.constraints.includes('TRANSFER_ALLOWANCE_EXHAUSTED'), false);
});

test('why am I idle: connection state, revocation, protocol mismatch, draining, disabled capabilities and a stopped node', () => {
  const r = rig(); r.engine.update();
  const unreachable = why(r, snapshot({ connected: false, lastFailure: { at: 1, code: 'TRANSPORT_ERROR', reason: 'DNS' } })); assert.deepEqual(codes(unreachable).slice(0, 1), ['COORDINATOR_UNREACHABLE']); assert.match(unreachable.summary, /dns/i);
  assert.ok(codes(why(r, snapshot({ connected: false, lastFailure: { at: 1, code: 'UNAUTHORIZED_NODE', status: 401 } }))).includes('IDENTITY_REFUSED'));
  assert.ok(codes(why(r, snapshot({ connected: false, lastFailure: { at: 1, code: 'PROTOCOL_MISMATCH', status: 426 } }))).includes('PROTOCOL_INCOMPATIBLE'));
  assert.ok(codes(why(r, snapshot({ draining: true }))).includes('NODE_DRAINING'));
  assert.ok(codes(why(r, snapshot({ advertisedCapabilities: [] }))).includes('ALL_CAPABILITIES_DISABLED'));
  assert.ok(codes(why(r, snapshot({ connected: false, lastContactAt: null }))).includes('NOT_CONNECTED_YET'));
  const stopped = explainIdle({ now: 1, node: null, report: null, engine: null, pause: undefined }); assert.deepEqual(codes(stopped), ['NODE_NOT_RUNNING']);
  const held = explainIdle({ now: 1, node: snapshot(), report: null, engine: null, pause: { kind: 'indefinite' }, localStateProblem: 'LOCAL_STATE_INVALID' }); assert.ok(codes(held).includes('LOCAL_STATE_UNREADABLE'));
});

test('version compatibility: a different software version is not a failure, a different protocol is', () => {
  const node = { version: '0.3.5', protocol: 1 };
  assert.equal(compatibility(node, null).state, 'unknown');
  assert.equal(compatibility(node, { serviceVersion: '0.3.5', protocolVersion: 1 }).state, 'current');
  assert.equal(compatibility(node, { serviceVersion: '0.4.0', protocolVersion: 1 }).state, 'coordinator-newer');
  assert.equal(compatibility(node, { serviceVersion: '0.3.0-alpha.6', protocolVersion: 1 }).state, 'node-newer');
  assert.equal(compatibility(node, { serviceVersion: '0.3.5', protocolVersion: 2 }).state, 'incompatible');
  assert.match(compatibility(node, { serviceVersion: '0.4.0', protocolVersion: 1 }).message, /compatible/);
});

// ---- the control loop that applies saved choices to a running node ----
async function control(t: TestContext, options: { policy?: ResourcePolicy; clock?: () => number; boot?: () => number } = {}) {
  const dir = await stateDir(t);
  const host: HostSample = { availableMemoryBytes: 12 * GiB, ownerCpuPercent: 5, power: 'AC', freeDiskBytes: 100 * GiB };
  const policy = options.policy ?? ResourcePolicySchema.parse({ maxMemoryBytes: 8 * GiB, reserveMemoryBytes: 2 * GiB, maxCpuPercent: 50 });
  const clock = options.clock ?? Date.now;
  const engine = new ResourceEngine(policy, { sample: () => ({ ...host }) }, clock);
  const transfer = new TransferMeter({ stateDir: dir, ratePerSec: policy.maxBandwidthBytesPerSec, monthlyBytes: policy.monthlyTransferBytes });
  const node = new PrivaNode({ url: 'https://127.0.0.1:9', stateDir: dir, capabilities: ['system.echo.v1', 'web.fetch.v1'], engine, transfer });
  const changes: number[] = [];
  const make = () => new LocalControl({ stateDir: dir, node, engine, transfer, clock, ...(options.boot ? { bootTime: options.boot } : {}), history: new ResourceHistory(dir, clock), onChange: () => { changes.push(1); } });
  const controller = make(); await controller.init({ policy, source: { kind: 'defaults' } });
  t.after(() => controller.stop());
  return { dir, engine, node, transfer, controller, make, changes, policy, host };
}
const ctx = { jobSlots: 1, capabilities: ['system.echo.v1', 'web.fetch.v1'] as ('system.echo.v1' | 'web.fetch.v1')[] };

test('pause and resume apply at once, a timed pause ends by itself, and none of it touches enrollment or identity', async t => {
  let now = new Date(2026, 5, 10, 12, 0).getTime();
  const c = await control(t, { clock: () => now });
  c.engine.update(); assert.equal(c.engine.report.contribution, 'ADAPTIVE');
  await c.controller.pause({ kind: '15m' }); c.engine.update();
  assert.equal(c.engine.report.contribution, 'PAUSED'); assert.ok(c.engine.state.blockers.includes('PAUSED_BY_OWNER')); assert.equal(c.controller.view.pause?.kind, 'timed');
  now += 14 * 60000; await c.controller.sync(); c.engine.update(); assert.equal(c.engine.report.contribution, 'PAUSED');
  now += 2 * 60000; await c.controller.sync(); c.engine.update(); assert.equal(c.engine.report.contribution, 'ADAPTIVE', 'resumed by itself at expiry');
  await c.controller.pause({ kind: 'indefinite' }); c.engine.update(); assert.equal(c.engine.report.contribution, 'PAUSED');
  await c.controller.resume(); c.engine.update(); assert.equal(c.engine.report.contribution, 'ADAPTIVE'); assert.ok(c.changes.length >= 3);
  assert.equal(c.node.snapshot.draining, false);
  assert.deepEqual((await readdir(c.dir)).filter(name => /identity|enrollment|node-state/.test(name)), []);
});

test('a restart while paused keeps the pause (for a timed, an indefinite and an until-reboot pause), and a reboot ends only the last', async t => {
  let now = new Date(2026, 5, 10, 12, 0).getTime(); let boot = now - 3600000;
  const c = await control(t, { clock: () => now, boot: () => boot });
  await c.controller.pause({ kind: 'reboot' });
  const restarted = c.make(); await restarted.init({ policy: c.policy, source: { kind: 'defaults' } }); c.engine.update();
  assert.equal(c.engine.report.contribution, 'PAUSED', 'the program restarted on the same boot');
  boot = now + 60000; now += 120000; await restarted.sync(); c.engine.update();
  assert.equal(c.engine.report.contribution, 'ADAPTIVE', 'a new boot time ends an until-reboot pause');
  await restarted.pause({ kind: 'indefinite' }); const again = c.make(); boot += 99999999; await again.init({ policy: c.policy, source: { kind: 'defaults' } }); c.engine.update();
  assert.equal(c.engine.report.contribution, 'PAUSED', 'indefinite survives restarts and reboots');
  restarted.stop(); again.stop();
});

test('a saved policy applies live to the engine and the transfer meter; presets keep the schedule; reset returns to the installer policy', async t => {
  const c = await control(t);
  c.engine.update(); const before = c.engine.report.cpuBudgetPercent; assert.equal(before, 50);
  const result = await c.controller.choosePreset('minimal', ctx); assert.ok(Array.isArray(result.findings));
  c.engine.update(); assert.equal(c.engine.report.cpuBudgetPercent < before, true); assert.equal(c.controller.view.preset, 'minimal'); assert.equal(c.controller.view.source?.kind, 'saved');
  assert.equal(c.transfer.usage().monthlyBytes, PRESETS.minimal.values.monthlyTransferBytes);
  const custom = { ...applyPreset(defaultResourcePolicy(), 'generous'), maxCpuPercent: 61 };
  await c.controller.savePolicy(custom, ctx); assert.equal(c.controller.view.preset, 'custom'); c.engine.update(); assert.equal(c.engine.report.cpuBudgetPercent, 61, 'min(ceiling 61, 100 - owner 5 - reserve 15)');
  await c.controller.resetPolicy(); assert.equal(c.controller.view.source?.kind, 'defaults');
});

test('a policy that is rejected changes nothing; one that breaks while running leaves the last good policy in force and is reported', async t => {
  const c = await control(t);
  await assert.rejects(c.controller.savePolicy({ ...defaultResourcePolicy(), fetch: { ...defaultResourcePolicy().fetch, unsafeLocal: { allowedCidrs: ['10.0.0.0/8'], allowedPorts: [], hostMap: {} } } }, ctx), PolicyError);
  assert.equal((await readPolicyFile(c.dir)).kind, 'absent');
  await c.controller.choosePreset('generous', ctx); c.engine.update(); const good = c.engine.report.memoryBudgetBytes;
  await writeFile(join(c.dir, POLICY_FILE), '{broken', { mode: 0o600 }); await c.controller.sync(); c.engine.update();
  assert.equal(c.engine.report.memoryBudgetBytes, good, 'the last good policy is still in force');
  assert.equal(c.controller.view.policyProblem?.code, 'POLICY_NOT_JSON'); assert.equal(c.controller.view.source?.kind, 'saved');
  const document = buildStatus({ node: c.node, engine: c.engine, control: c.controller, transfer: c.transfer, coordinatorUrl: 'https://node.example.com', enrolledCapabilities: ['system.echo.v1', 'web.fetch.v1'] });
  assert.ok(document.contribution.problems.some(problem => problem.code === 'POLICY_NOT_JSON'));
});

test('web-fetch limits are built into the handler at start, so changing them is reported as needing a restart', async t => {
  const c = await control(t);
  assert.deepEqual(c.controller.view.restartRequired, []);
  await c.controller.savePolicy({ ...defaultResourcePolicy(), fetch: { ...defaultResourcePolicy().fetch, maxRequestsPerMinute: 5 } }, ctx);
  assert.deepEqual(c.controller.view.restartRequired, ['fetch']);
});

test('capability toggles change what the node advertises, only among what it enrolled with', async t => {
  const c = await control(t);
  assert.deepEqual(c.node.capabilities, ['system.echo.v1', 'web.fetch.v1']);
  await c.controller.setDisabledCapabilities(['web.fetch.v1']); assert.deepEqual(c.node.capabilities, ['system.echo.v1']);
  assert.deepEqual(c.node.snapshot.enrolledCapabilities, ['system.echo.v1', 'web.fetch.v1']);
  await c.controller.setDisabledCapabilities(['web.fetch.v1', 'system.hashchain.v1']); assert.deepEqual(c.node.capabilities, ['system.echo.v1'], 'not enrolled with hashchain: ignored');
  await c.controller.setDisabledCapabilities([]); assert.equal(c.node.capabilities.length, 2);
});

test('local state that cannot be read at start holds the node paused (never silently un-paused) and says why', async t => {
  const dir = await stateDir(t); await writeFile(join(dir, LOCAL_STATE_FILE), '{oops', { mode: 0o600 });
  const policy = defaultResourcePolicy(); const engine = new ResourceEngine(policy, { sample: () => ({ availableMemoryBytes: 12 * GiB, ownerCpuPercent: 1, power: 'AC', freeDiskBytes: 100 * GiB }) });
  const node = new PrivaNode({ url: 'https://127.0.0.1:9', stateDir: dir, capabilities: ['system.echo.v1'], engine });
  const events: string[] = []; const controller = new LocalControl({ stateDir: dir, node, engine, log: entry => events.push(entry.event) });
  await controller.init({ policy, source: { kind: 'defaults' } }); engine.update();
  assert.equal(engine.report.contribution, 'PAUSED'); assert.equal(controller.view.localProblem, 'LOCAL_STATE_INVALID'); assert.ok(events.includes('node.local_state_invalid'));
  assert.ok(codes(explainIdle({ now: 1, node: node.snapshot, report: engine.report, engine: engine.state, pause: controller.view.pause, localStateProblem: controller.view.localProblem })).includes('LOCAL_STATE_UNREADABLE'));
});

test('history is small, bounded, private and kept on this machine; it records permitted budgets and measured numbers, not payloads', async t => {
  let now = 1_000_000; const dir = await stateDir(t); const history = new ResourceHistory(dir, () => now);
  const point = { contribution: 'ADAPTIVE', pressure: 'NORMAL', permittedMemoryBytes: GiB, permittedCpuPercent: 25, measuredOwnerCpuPercent: 7, activeJobs: 0 };
  assert.equal(await history.record(point), true); assert.equal(await history.record(point), false, 'within the interval');
  for (let i = 0; i < 400; i++) { now += 5 * 60000; await history.record(point); }
  assert.equal(history.points().length, 288);
  const reloaded = new ResourceHistory(dir, () => now); await reloaded.load(); assert.equal(reloaded.points().length, 288);
  const text = await readFile(join(dir, 'history.json'), 'utf8'); assert.ok(text.length < 100000); assert.doesNotMatch(text, /payload|token|url/);
});

test('the status document names three different names and never carries a key, token or payload', async t => {
  const c = await control(t); await c.controller.setName('Garage PC');
  const document = buildStatus({ node: c.node, engine: c.engine, control: c.controller, transfer: c.transfer, coordinatorUrl: 'https://node.example.com:8443/x?secret=1', enrolledCapabilities: ['system.echo.v1', 'web.fetch.v1'] });
  assert.equal(document.node.localName, 'Garage PC'); assert.equal(document.node.coordinatorLabel, null); assert.equal(document.node.id, null);
  assert.equal(document.coordinator.host, 'node.example.com');
  const text = JSON.stringify(document); for (const forbidden of ['secret=1', 'privateKey', 'token', 'Bearer', 'authorization']) assert.equal(text.toLowerCase().includes(forbidden.toLowerCase()), false, forbidden);
  assert.match(document.limits.accounting, /does not exist yet/);
});
