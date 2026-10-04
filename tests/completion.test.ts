import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, readFile, writeFile, utimes, symlink, lstat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HeartbeatSchema, JOB_TYPES, HASHCHAIN_MAX_ITERATIONS } from '@privanet/protocol';
import type { Lease, ResourceReport } from '@privanet/protocol';
import { fitsBudget, outlastsAvailability } from '@privanet/coordinator/scheduler';
import { ResourceEngine } from '@privanet/node/resource-engine';
import { ResourcePolicySchema } from '@privanet/node/resource-policy';
import type { HostSample } from '@privanet/node/resource-sampler';
import { parseDiskstats, parseNetDev, parsePmset, parseWindowsBattery } from '@privanet/node/resource-sampler';
import { nextOffMs } from '@privanet/node/resource-schedule';
import { TransferLimitError, TransferMeter } from '@privanet/node/transfer-meter';
import { CheckpointStore } from '@privanet/node/checkpoint';
import { defaultHandlers, executeLease } from '@privanet/node/handlers';
import { fixture, heartbeat } from './helpers.js';

const GiB = 1024 ** 3;
const report = (overrides: Partial<ResourceReport> = {}): ResourceReport => ({
  contribution: 'ADAPTIVE', pressure: 'NORMAL', power: 'AC', memoryBudgetBytes: 512 * 1024 * 1024, cpuBudgetPercent: 50, ...overrides });
const tmp = async (t: { after(fn: () => Promise<void>): void }) => { const dir = await mkdtemp(join(tmpdir(), 'privanet-c-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; };
const chain = (seed: string, iterations: number) => { let h = createHash('sha256').update(seed).digest(); for (let i = 0; i < iterations; i++) h = createHash('sha256').update(h).digest(); return h.toString('hex'); };
function rig(overrides: Record<string, unknown> = {}, initial: Partial<HostSample> = {}, transfer?: { remainingBytes(): number }) {
  const policy = ResourcePolicySchema.parse({ maxMemoryBytes: 8 * GiB, reserveMemoryBytes: 2 * GiB, safetyMarginBytes: GiB / 2, maxCpuPercent: 50, ...overrides });
  const host: HostSample = { availableMemoryBytes: 12 * GiB, ownerCpuPercent: 5, power: 'AC', freeDiskBytes: 50 * GiB, ...initial };
  let now = new Date(2026, 0, 7, 12, 0).getTime();
  const engine = new ResourceEngine(policy, { sample: () => ({ ...host }) }, () => now, transfer);
  return { engine, host, step(ms = 1000, times = 1) { let r = engine.report; for (let i = 0; i < times; i++) { now += ms; r = engine.update(); } return r; }, get now() { return now; }, set now(v: number) { now = v; } };
}

test('OS output parsers: pmset, Windows battery status, disk and network counters', () => {
  assert.equal(parsePmset("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t80%; discharging"), 'BATTERY');
  assert.equal(parsePmset("Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t80%; charging"), 'AC');
  assert.equal(parsePmset("Now drawing from 'UPS Power'"), 'AC');
  assert.equal(parsePmset('garbage'), 'UNKNOWN');
  assert.equal(parseWindowsBattery(''), 'AC'); // a desktop has no battery
  assert.equal(parseWindowsBattery('1'), 'BATTERY'); assert.equal(parseWindowsBattery('5'), 'BATTERY');
  assert.equal(parseWindowsBattery('2'), 'AC'); assert.equal(parseWindowsBattery('6'), 'AC');
  assert.equal(parseWindowsBattery('x'), 'UNKNOWN'); assert.equal(parseWindowsBattery('99'), 'UNKNOWN');
  const disks = parseDiskstats([
    '   8       0 sda 100 0 800 50 200 0 1600 80 0 4321 130 0 0 0 0',
    '   8       1 sda1 50 0 400 20 100 0 800 40 0 999 60 0 0 0 0',
    ' 259       0 nvme0n1 1 0 8 1 1 0 8 1 0 77 2 0 0 0 0', '   7       0 loop0 1 0 2 0 0 0 0 0 0 5 0 0 0 0 0'].join('\n'));
  assert.deepEqual([...disks.entries()], [['sda', 4321], ['nvme0n1', 77]]); // partitions and loop devices excluded
  assert.equal(parseNetDev(['Inter-|   Receive |  Transmit', ' face |bytes packets errs drop fifo frame compressed multicast|bytes packets',
    '    lo: 5000 10 0 0 0 0 0 0 5000 10 0 0 0 0 0 0', '  eth0: 1000 10 0 0 0 0 0 0 250 5 0 0 0 0 0 0'].join('\n')), 1250);
});

test('nextOffMs finds the next OFF window, is zero inside one and undefined when none exists', () => {
  const rules = [{ days: [0, 1, 2, 3, 4, 5, 6], from: '23:00', to: '07:00', level: 'OFF' as const }];
  const noon = new Date(2026, 0, 7, 12, 0, 30);
  assert.equal(nextOffMs(rules, 'ADAPTIVE', noon), 11 * 3600000 - 30000);
  assert.equal(nextOffMs(rules, 'ADAPTIVE', new Date(2026, 0, 7, 2, 0)), 0);
  assert.equal(nextOffMs([], 'ADAPTIVE', noon), undefined);
  assert.equal(nextOffMs([{ days: [3], from: '00:00', to: '00:00', level: 'OFF' }], 'ADAPTIVE', new Date(2026, 0, 8, 12, 0)), 6 * 86400000 - 12 * 3600000); // next Wednesday
  assert.equal(nextOffMs(rules, 'ADAPTIVE', noon, 3600000), undefined); // beyond the horizon
});

test('disk budget is the owner cap bounded by free space above their reserve; unknown free space offers none', () => {
  const idle = rig({ maxDiskBytes: 4 * GiB, reserveDiskBytes: 10 * GiB }).engine.update();
  assert.equal(idle.diskBudgetBytes, 4 * GiB); assert.equal(idle.diskIo, 'medium'); // maxDiskIo default caps 'high'
  assert.equal(rig({ maxDiskBytes: 4 * GiB, reserveDiskBytes: 10 * GiB }, { freeDiskBytes: 12 * GiB }).engine.update().diskBudgetBytes, 2 * GiB);
  assert.equal(rig({ reserveDiskBytes: 10 * GiB }, { freeDiskBytes: 9 * GiB }).engine.update().diskBudgetBytes, 0);
  const unknown = rig(); delete unknown.host.freeDiskBytes; assert.equal(unknown.engine.update().diskBudgetBytes, 0);
  assert.equal(rig({ maxDiskIo: 'high' }).engine.update().diskIo, 'high');
  const paused = rig({ maxCpuPercent: 0 }).engine.update(); assert.equal(paused.diskBudgetBytes, 0); assert.equal(paused.diskIo, 'none');
});

test('a busy owner disk lowers the offered disk-I/O class and, sustained, raises pressure to ELEVATED (never HIGH) with hysteresis', () => {
  const r = rig({ maxDiskIo: 'high' }); assert.equal(r.engine.update().diskIo, 'high');
  r.host.diskBusyPercent = 45; assert.equal(r.step(1000, 20).diskIo, 'low');
  r.host.diskBusyPercent = 95; let report = r.step(1000, 20);
  assert.equal(report.diskIo, 'none'); assert.equal(report.pressure, 'ELEVATED'); assert.notEqual(report.contribution, 'PAUSED');
  assert.equal(report.cpuBudgetPercent < 50, true); // elevated pressure halves the budget
  r.host.diskBusyPercent = 68; report = r.step(1000, 3); assert.equal(report.pressure, 'ELEVATED'); // between exit and enter thresholds: stays
  r.host.diskBusyPercent = 5; report = r.step(1000, 200); assert.equal(report.pressure, 'NORMAL'); assert.equal(report.diskIo, 'high');
});

test('network pressure needs a configured link speed; the transfer allowance becomes the network budget', () => {
  const noLink = rig({}, { networkBytesPerSec: 10_000_000 }); assert.equal(noLink.engine.update().pressure, 'NORMAL');
  const r = rig({ linkBytesPerSec: 1_000_000 }, { networkBytesPerSec: 900_000 }); assert.equal(r.engine.update().pressure, 'ELEVATED');
  let remaining = 5_000_000; const metered = rig({}, {}, { remainingBytes: () => remaining });
  assert.equal(metered.engine.update().networkBudgetBytes, 5_000_000); remaining = 0; assert.equal(metered.step().networkBudgetBytes, 0);
  assert.equal(rig().engine.update().networkBudgetBytes, undefined); // no meter: not reported
});

test('availableForMs counts down to the next scheduled OFF and is omitted without one', () => {
  const r = rig({ schedule: [{ days: [0, 1, 2, 3, 4, 5, 6], from: '13:00', to: '14:00', level: 'OFF' }] });
  assert.equal(r.engine.update().availableForMs, 3600000);
  assert.equal(r.step(60000, 5).availableForMs, 3600000 - 5 * 60000);
  assert.equal(rig().engine.update().availableForMs, undefined);
});

test('protocol accepts the new optional resource fields and bounds them', () => {
  const ok = (resources: unknown) => HeartbeatSchema.safeParse({ ...heartbeat(), resources }).success;
  assert.equal(ok(report({ diskBudgetBytes: 1, diskIo: 'low', networkBudgetBytes: 2, availableForMs: 3 })), true);
  assert.equal(ok(report({ diskIo: 'extreme' as never })), false); assert.equal(ok(report({ availableForMs: -1 })), false);
  assert.equal(ok(report({ availableForMs: 8 * 86400000 })), false); assert.equal(ok(report({ diskBudgetBytes: -1 })), false);
});

test('scheduler honours disk, disk-I/O, network and schedule limits only when the node reports them', () => {
  const hash = JOB_TYPES['system.hashchain.v1'].resources; const base = { memoryBudgetBytes: 1 * GiB, cpuBudgetPercent: 100 };
  assert.equal(fitsBudget(hash, base), true); // old nodes are not blocked by fields they cannot report
  assert.equal(fitsBudget(hash, { ...base, diskBudgetBytes: hash.diskBytes }), true);
  assert.equal(fitsBudget(hash, { ...base, diskBudgetBytes: hash.diskBytes - 1 }), false);
  assert.equal(fitsBudget(hash, { ...base, diskIo: 'low' }), true); assert.equal(fitsBudget(hash, { ...base, diskIo: 'none' }), false);
  assert.equal(fitsBudget(hash, { ...base, networkBudgetBytes: hash.networkBytes - 1 }), false);
  assert.equal(outlastsAvailability(hash, undefined), false); assert.equal(outlastsAvailability(hash, 30000), false); assert.equal(outlastsAvailability(hash, 29999), true);
  assert.equal(outlastsAvailability({ ...hash, expectedDurationMs: null }, 0), false);
});

test('Coordinator does not place a long job on a node whose schedule ends soon, nor a disk-heavy job on a full disk', t => {
  const f = fixture(); t.after(() => f.store.close());
  const application = f.core.createApplication({ name: 'chain', allowedJobTypes: ['system.hashchain.v1'] }); const app = f.core.authenticateApplication(application.token);
  const node = f.enroll(['system.hashchain.v1']); const nodeId = node.session.nodeId;
  const job = f.core.submit(app, { type: 'system.hashchain.v1', input: { seed: 's', iterations: 10 }, idempotencyKey: 'k1' });
  const beat = (resources: ResourceReport) => f.core.heartbeat(nodeId, { ...heartbeat(['system.hashchain.v1']), resources });
  const roomy = { memoryBudgetBytes: GiB, cpuBudgetPercent: 50, diskBudgetBytes: GiB, diskIo: 'medium' as const, networkBudgetBytes: GiB };
  beat(report({ ...roomy, availableForMs: 20000 })); assert.equal(f.core.lease(nodeId), null);
  beat(report({ ...roomy, diskBudgetBytes: 0 })); assert.equal(f.core.lease(nodeId), null);
  beat(report({ ...roomy, diskIo: 'none' })); assert.equal(f.core.lease(nodeId), null);
  beat(report({ ...roomy, availableForMs: 3600000 })); assert.equal(f.core.lease(nodeId)?.jobId, job.id);
});

test('transfer meter: token-bucket rate, persisted monthly allowance, refusal when exhausted, month rollover', async t => {
  const dir = await tmp(t); let now = Date.UTC(2026, 0, 31, 23, 59, 0); const waits: number[] = [];
  const make = () => new TransferMeter({ stateDir: dir, ratePerSec: 1000, monthlyBytes: 5000, clock: () => now, sleep: async ms => { waits.push(ms); now += ms; } });
  const meter = make();
  await meter.consume(1000); assert.deepEqual(waits, []); // the first second's worth is a free burst
  await meter.consume(1000); assert.deepEqual(waits, [1000]); // the deficit is waited out at the configured rate
  assert.equal(meter.remainingBytes(), 3000);
  assert.equal(make().remainingBytes(), 3000); // survives a restart
  meter.record(500); assert.equal(meter.remainingBytes(), 2500);
  await assert.rejects(() => meter.consume(3000), TransferLimitError);
  assert.equal(meter.remainingBytes(), 2500); // a refused request costs nothing
  await assert.rejects(() => meter.consume(-1)); await assert.rejects(() => meter.consume(1.5));
  now = Date.UTC(2026, 1, 1, 0, 0, 1); assert.equal(meter.remainingBytes(), 5000); // a new UTC month starts over
  const unlimited = new TransferMeter({ stateDir: dir, ratePerSec: null, monthlyBytes: null, clock: () => now });
  await unlimited.consume(2 ** 30); assert.equal(unlimited.remainingBytes() > 0, true);
  assert.equal(JSON.parse(await readFile(join(dir, 'transfer.json'), 'utf8')).period, '2026-02');
});

test('transfer meter waiting is abortable', async t => {
  const dir = await tmp(t); const controller = new AbortController();
  const meter = new TransferMeter({ stateDir: dir, ratePerSec: 10, monthlyBytes: null });
  await meter.consume(10); const pending = meter.consume(1000, controller.signal); controller.abort();
  await assert.rejects(pending);
});

test('a lower owner allowance cancels an already reserved transfer even while it is waiting for bandwidth', async t => {
  const dir = await tmp(t); let resume = () => {}; const waiting = new Promise<void>(resolve => { resume = resolve; });
  const meter = new TransferMeter({ stateDir: dir, ratePerSec: 1, monthlyBytes: 1000, sleep: () => waiting });
  meter.reserve(1000); const pending = meter.throttle(1000);
  meter.setLimits({ ratePerSec: 1, monthlyBytes: 500 }); resume();
  await assert.rejects(pending, TransferLimitError); assert.equal(meter.allowsReservedTransfers(), false);
  assert.equal(meter.usage().usedBytes, 1000, 'already spent/reserved accounting is never silently reduced');
});

test('checkpoints are bounded, typed, expire, and reject unsafe ids; prune removes abandoned files', async t => {
  const dir = await tmp(t); let now = 1_000_000; const store = new CheckpointStore(join(dir, 'cp'), { maxBytes: 200, maxAgeMs: 1000, clock: () => now });
  const id = '11111111-1111-4111-8111-111111111111'; const cp = store.forJob(id, 'system.hashchain.v1');
  assert.equal(cp.load(), undefined); cp.save({ done: 5 }); assert.deepEqual(cp.load(), { done: 5 });
  assert.equal(store.forJob(id, 'system.echo.v1').load(), undefined); // another type never reads it
  assert.throws(() => cp.save({ blob: 'x'.repeat(500) }), /too large/);
  assert.deepEqual(cp.load(), { done: 5 }); // a rejected save leaves the previous checkpoint intact
  now += 2000; assert.equal(cp.load(), undefined); // too old to trust
  cp.save({ done: 6 }); await utimes(join(dir, 'cp', `${id}.json`), new Date(0), new Date(0)); assert.equal(store.prune(), 1); assert.equal(existsSync(join(dir, 'cp', `${id}.json`)), false);
  for (const bad of ['../evil', 'a/b', '', 'x'.repeat(65)]) assert.throws(() => store.forJob(bad, 'system.echo.v1'));
  cp.save({ done: 7 }); store.clear(id); assert.equal(cp.load(), undefined); store.clear(id);
  await writeFile(join(dir, 'cp', `${id}.json`), '{not json'); assert.equal(cp.load(), undefined); // corrupt: start over
});

const lease = (iterations: number, seed = 'seed'): Lease => ({ jobId: '22222222-2222-4222-8222-222222222222', type: 'system.hashchain.v1', input: { seed, iterations },
  protocolVersion: 1, leaseId: '33333333-3333-4333-8333-333333333333', expiresAt: Date.now() + 60000, attempt: 1 });

test('hashchain handler computes the documented chain and validates its input and output', async () => {
  const result = await executeLease(lease(1000), ['system.hashchain.v1']);
  assert.deepEqual(result, { digest: chain('seed', 1000), iterations: 1000 });
  await assert.rejects(() => executeLease(lease(0), ['system.hashchain.v1'])); await assert.rejects(() => executeLease(lease(HASHCHAIN_MAX_ITERATIONS + 1), ['system.hashchain.v1']));
  await assert.rejects(() => executeLease(lease(10), ['system.echo.v1']), /Capability disabled/);
});

test('hashchain resumes from a checkpoint after an abort and produces the same digest; foreign checkpoints are ignored', async t => {
  const dir = await tmp(t); const store = new CheckpointStore(dir); const l = lease(200_000); const controller = new AbortController();
  setTimeout(() => controller.abort(new Error('preempted')), 30);
  await assert.rejects(() => executeLease(l, ['system.hashchain.v1'], controller.signal, defaultHandlers, { checkpoint: store.forJob(l.jobId, l.type) }), /preempted/);
  const saved = store.forJob(l.jobId, l.type).load() as { done: number } | undefined;
  assert.ok(saved && saved.done > 0 && saved.done < 200_000, 'abort must leave a partial checkpoint');
  const resumed = await executeLease(l, ['system.hashchain.v1'], undefined, defaultHandlers, { checkpoint: store.forJob(l.jobId, l.type) });
  assert.deepEqual(resumed, { digest: chain('seed', 200_000), iterations: 200_000 });
  // A checkpoint for different input must not be trusted.
  store.forJob(l.jobId, l.type).save({ seed: 'other', iterations: 200_000, done: 100, hash: 'a'.repeat(64) });
  assert.deepEqual(await executeLease(lease(1000), ['system.hashchain.v1'], undefined, defaultHandlers, { checkpoint: store.forJob(l.jobId, l.type) }), { digest: chain('seed', 1000), iterations: 1000 });
});

test('checkpoint context is offered only to job types registered checkpointable', async () => {
  let seen: unknown = 'unset'; const handlers = { ...defaultHandlers, 'system.echo.v1': (input: { message: string }, context: { checkpoint?: unknown }) => { seen = context.checkpoint; return { message: input.message }; } };
  const checkpoint = { load: () => undefined, save: () => {} };
  await executeLease({ ...lease(1), type: 'system.echo.v1', input: { message: 'm' } }, ['system.echo.v1'], undefined, handlers, { checkpoint });
  assert.equal(seen, undefined);
});


test('very low bandwidth with concurrent debt uses bounded cancellable timers rather than overflow', async t => {
  const dir = await tmp(t); const controller = new AbortController(); const waits: number[] = [];
  const meter = new TransferMeter({ stateDir: dir, ratePerSec: 1, monthlyBytes: null, sleep: async ms => { waits.push(ms); controller.abort(); } });
  await assert.rejects(meter.throttle(4 * 1024 * 1024, controller.signal));
  assert.deepEqual(waits, [1000]);
});

test('lowering the owner rate re-gates an already waiting stream at the new rate without double accounting', async t => {
  const dir = await tmp(t); let now = 0; const waits: number[] = []; let changed = false;
  const meter = new TransferMeter({ stateDir: dir, ratePerSec: 1000, monthlyBytes: null, clock: () => now, sleep: async ms => {
    waits.push(ms); now += ms; if (!changed) { changed = true; meter.setLimits({ ratePerSec: 100, monthlyBytes: null }); }
  } });
  await meter.consume(2000);
  assert.equal(waits.reduce((a, b) => a + b, 0), 20000); assert(waits.every(ms => ms <= 1000)); assert.equal(meter.usage().usedBytes, 2000);
});


test('corrupt monthly accounting is preserved and a dangling state symlink never reopens the allowance', async t => {
  const dir = await tmp(t); const path = join(dir, 'transfer.json'); await writeFile(path, '{corrupt', { mode: 0o600 });
  const meter = new TransferMeter({ stateDir: dir, ratePerSec: null, monthlyBytes: null }); assert.equal(meter.remainingBytes(), 0); assert.throws(() => meter.reserve(1), TransferLimitError); assert.equal(await readFile(path, 'utf8'), '{corrupt');
  if (process.platform !== 'win32') {
    await rm(path); await symlink(join(dir, 'missing-counter'), path);
    const linked = new TransferMeter({ stateDir: dir, ratePerSec: null, monthlyBytes: null }); assert.equal(linked.remainingBytes(), 0); assert.throws(() => linked.reserve(1), TransferLimitError); assert((await lstat(path)).isSymbolicLink());
  }
});
