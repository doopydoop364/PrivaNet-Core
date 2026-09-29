import test from 'node:test';
import assert from 'node:assert/strict';
import { ResourceEngine } from '@privanet/node/resource-engine';
import { ResourcePolicySchema, defaultResourcePolicy } from '@privanet/node/resource-policy';
import type { ResourcePolicy } from '@privanet/node/resource-policy';
import { levelAt } from '@privanet/node/resource-schedule';
import type { HostSample } from '@privanet/node/resource-sampler';
import { loadResourcePolicy } from '@privanet/node/config';

const GiB = 1024 ** 3;
function rig(overrides: Record<string, unknown> = {}, initial: Partial<HostSample> = {}) {
  const policy: ResourcePolicy = ResourcePolicySchema.parse({ maxMemoryBytes: 8 * GiB, reserveMemoryBytes: 2 * GiB, safetyMarginBytes: GiB / 2, maxCpuPercent: 50, ...overrides });
  const host: HostSample = { availableMemoryBytes: 12 * GiB, ownerCpuPercent: 5, power: 'AC', ...initial };
  let now = new Date(2026, 0, 7, 12, 0).getTime(); // a Wednesday, midday local time
  const engine = new ResourceEngine(policy, { sample: () => ({ ...host }) }, () => now);
  return { engine, host, step(ms = 1000, times = 1) { let report = engine.report; for (let i = 0; i < times; i++) { now += ms; report = engine.update(); } return report; }, set now(value: number) { now = value; }, get now() { return now; } };
}

test('spare RAM sets the budget: 12 GiB available contributes more than 3 GiB, always under the hard limit and reserve', () => {
  const idle = rig(); assert.equal(idle.engine.update().memoryBudgetBytes, 8 * GiB); // min(12-2-0.5 GiB, 8 GiB hard limit)
  const gaming = rig({}, { availableMemoryBytes: 3 * GiB }); const report = gaming.engine.update();
  assert.equal(report.memoryBudgetBytes, GiB / 2); // 3 - 2 reserve - 0.5 safety
  assert.equal(report.contribution, 'ADAPTIVE');
  const starved = rig({}, { availableMemoryBytes: 2 * GiB }).engine.update();
  assert.equal(starved.contribution, 'PAUSED'); assert.equal(starved.memoryBudgetBytes, 0); assert.equal(starved.pressure, 'HIGH');
});

test('CPU budget follows what the owner is using, capped by the ceiling and the reserve', () => {
  assert.equal(rig().engine.update().cpuBudgetPercent, 50);
  assert.equal(rig({}, { ownerCpuPercent: 50 }).engine.update().cpuBudgetPercent, 30);
  assert.equal(rig({ maxCpuPercent: 100 }, { ownerCpuPercent: 0 }).engine.update().cpuBudgetPercent, 80); // reserveCpuPercent stays free
  assert.equal(rig({ maxCpuPercent: 0 }).engine.update().contribution, 'PAUSED');
});

test('owner load is taken back quickly and given back slowly, with hysteresis on pressure', () => {
  const r = rig(); r.engine.update();
  r.host.availableMemoryBytes = 2.4 * GiB; // owner needs memory: headroom -0.1 GiB
  let report = r.step(1000, 20); assert.equal(report.pressure, 'HIGH'); assert.equal(report.contribution, 'PAUSED');
  r.host.availableMemoryBytes = 3.2 * GiB; // recovered a little: headroom 0.7 GiB, above the margin only after smoothing
  report = r.step(1000, 1); assert.equal(report.pressure, 'HIGH'); // slow recovery: still HIGH after one second
  report = r.step(1000, 120); assert.equal(report.pressure, 'ELEVATED'); assert.ok(report.memoryBudgetBytes > 0); // 0.7 GiB headroom is below 2x margin
  r.host.availableMemoryBytes = 12 * GiB; report = r.step(1000, 400); assert.equal(report.pressure, 'NORMAL');
});

test('a momentary spike does not pause contribution; sustained pressure does and then preempts', () => {
  const r = rig({ preemptAfterMs: 5000 }); r.engine.update();
  r.host.availableMemoryBytes = 1 * GiB; r.step(200, 1);
  assert.notEqual(r.engine.report.contribution, 'PAUSED'); // smoothed: one 200 ms dip is not a crisis
  r.host.availableMemoryBytes = 12 * GiB; r.step(1000, 30); assert.equal(r.engine.report.pressure, 'NORMAL');
  r.host.availableMemoryBytes = 1 * GiB; r.step(1000, 8);
  assert.equal(r.engine.report.contribution, 'PAUSED'); assert.equal(r.engine.shouldPreempt(), false);
  r.step(1000, 6); assert.equal(r.engine.shouldPreempt(), true);
  r.host.availableMemoryBytes = 12 * GiB; r.step(1000, 200); assert.equal(r.engine.shouldPreempt(), false);
});

test('battery policy: reduce lowers to MINIMAL, disable pauses, unknown power counts as AC', () => {
  const reduced = rig({ minimalFraction: 0.1 }, { power: 'BATTERY' }).engine.update();
  assert.equal(reduced.contribution, 'MINIMAL'); assert.equal(reduced.memoryBudgetBytes, Math.floor(8 * GiB * 0.1));
  assert.equal(rig({ onBattery: 'disable' }, { power: 'BATTERY' }).engine.update().contribution, 'PAUSED');
  assert.equal(rig({ onBattery: 'normal' }, { power: 'BATTERY' }).engine.update().contribution, 'ADAPTIVE');
  assert.equal(rig({ onBattery: 'disable' }, { power: 'UNKNOWN' }).engine.update().contribution, 'ADAPTIVE');
});

test('schedule rules choose the level; OFF pauses, MINIMAL scales, wrap-past-midnight and weekends work', () => {
  const at = (day: number, hour: number, minute = 0) => new Date(2026, 0, 4 + day, hour, minute); // 2026-01-04 is a Sunday
  const rules = [
    { days: [1, 2, 3, 4, 5], from: '00:00', to: '07:00', level: 'FULL' as const },
    { days: [1, 2, 3, 4, 5], from: '07:00', to: '16:00', level: 'ADAPTIVE' as const },
    { days: [1, 2, 3, 4, 5], from: '16:00', to: '23:00', level: 'MINIMAL' as const },
    { days: [1, 2, 3, 4, 5], from: '23:00', to: '00:00', level: 'OFF' as const },
    { days: [0, 6], from: '00:00', to: '00:00', level: 'ADAPTIVE' as const },
  ];
  assert.equal(levelAt(rules, 'OFF', at(1, 3)), 'FULL'); assert.equal(levelAt(rules, 'OFF', at(1, 6, 59)), 'FULL');
  assert.equal(levelAt(rules, 'OFF', at(1, 7)), 'ADAPTIVE'); assert.equal(levelAt(rules, 'OFF', at(3, 18)), 'MINIMAL');
  assert.equal(levelAt(rules, 'FULL', at(2, 23, 30)), 'OFF'); assert.equal(levelAt(rules, 'FULL', at(0, 12)), 'ADAPTIVE');
  assert.equal(levelAt(rules, 'FULL', at(6, 23, 59)), 'ADAPTIVE'); assert.equal(levelAt([], 'MINIMAL', at(2, 12)), 'MINIMAL');
  // Friday evening rule that wraps into Saturday morning
  const overnight = [{ days: [5], from: '22:00', to: '06:00', level: 'OFF' as const }];
  assert.equal(levelAt(overnight, 'FULL', at(5, 23)), 'OFF'); assert.equal(levelAt(overnight, 'FULL', at(6, 5)), 'OFF');
  assert.equal(levelAt(overnight, 'FULL', at(6, 7)), 'FULL'); assert.equal(levelAt(overnight, 'FULL', at(5, 5)), 'FULL');
  const off = rig({ schedule: [{ days: [3], from: '11:00', to: '13:00', level: 'OFF' }] }).engine.update();
  assert.equal(off.contribution, 'PAUSED');
  const minimal = rig({ schedule: [{ days: [3], from: '11:00', to: '13:00', level: 'MINIMAL' }], minimalFraction: 0.25 }).engine.update();
  assert.equal(minimal.contribution, 'MINIMAL'); assert.equal(minimal.memoryBudgetBytes, 2 * GiB);
});

test('capability limits can only lower the budget for that capability', () => {
  const report = rig({ capabilityLimits: { 'system.echo.v1': { maxMemoryBytes: 1024, maxCpuPercent: 0 } } }).engine.update();
  assert.deepEqual(report.perCapability, { 'system.echo.v1': { memoryBudgetBytes: 1024, cpuBudgetPercent: 0 } });
  assert.equal(report.memoryBudgetBytes, 8 * GiB);
  const raised = rig({ capabilityLimits: { 'system.echo.v1': { maxMemoryBytes: 64 * GiB } } }).engine.update();
  assert.equal(raised.perCapability?.['system.echo.v1']?.memoryBudgetBytes, 8 * GiB);
  const paused = rig({ onBattery: 'disable' }, { power: 'BATTERY', }).engine.update(); assert.equal(paused.perCapability, undefined);
});

test('policy files are strict, bounded and default to conservative limits', () => {
  assert.equal(defaultResourcePolicy().onBattery, 'reduce');
  for (const bad of [{ maxCpuPercent: 101 }, { maxMemoryBytes: -1 }, { shell: 'sh' }, { schedule: [{ days: [7], from: '00:00', to: '01:00', level: 'FULL' }] },
    { schedule: [{ days: [1], from: '25:00', to: '01:00', level: 'FULL' }] }, { capabilityLimits: { 'compute.anything': {} } }, { minimalFraction: 2 }])
    assert.equal(ResourcePolicySchema.safeParse(bad).success, false);
  assert.throws(() => loadResourcePolicy('/nonexistent/policy.json'));
});
