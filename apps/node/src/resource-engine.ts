import type { JobType, ResourceReport } from '@privanet/protocol';
import { levelAt, nextOffMs } from './resource-schedule.js';
import type { TransferAllowance } from './transfer-meter.js';
import type { Level, ResourcePolicy } from './resource-policy.js';
import type { HostSampler } from './resource-sampler.js';

// Time constants: fall fast when the owner needs resources back, recover slowly to avoid churn.
const TAU_DOWN_MS = 2000; const TAU_UP_MS = 30000;
const CPU_ENTER = { ELEVATED: 75, HIGH: 90 } as const; const CPU_EXIT = { ELEVATED: 65, HIGH: 80 } as const;
// Disk and network load only ever make pressure ELEVATED (never HIGH): I/O contention should slow new work, not kill running work.
const IO_ENTER = 75; const IO_EXIT = 65;
/** Disk-I/O intensity class offered for a given owner disk utilisation: the busier the owner's disk, the lighter the work. */
const diskIoFor = (busyPercent: number): NonNullable<ResourceReport['diskIo']> => busyPercent >= 70 ? 'none' : busyPercent >= 40 ? 'low' : busyPercent >= 20 ? 'medium' : 'high';
const IO_ORDER = ['none', 'low', 'medium', 'high'] as const;
const smooth = (previous: number, sample: number, dtMs: number, fallingIsBad: boolean) => {
  const worse = fallingIsBad ? sample < previous : sample > previous;
  return previous + (sample - previous) * (1 - Math.exp(-dtMs / (worse ? TAU_DOWN_MS : TAU_UP_MS)));
};

/** Why contribution is stopped outright. Each is derived from the same numbers the budget is computed from; none is guessed. */
export type Blocker = 'PAUSED_BY_OWNER' | 'SCHEDULE_OFF' | 'ON_BATTERY' | 'MEMORY_PRESSURE' | 'CPU_PRESSURE' | 'POLICY_ZERO_LIMIT';
/** Why some work (not all) cannot be offered right now. */
export type Constraint = 'DISK_BUDGET_EXHAUSTED' | 'TRANSFER_ALLOWANCE_EXHAUSTED' | 'MEMORY_BUDGET_ZERO' | 'CPU_BUDGET_ZERO' | 'BATTERY_REDUCED' | 'PRESSURE_ELEVATED';
export interface EngineState {
  /** What the schedule alone says right now (before battery rules and an owner pause). */
  scheduleLevel: Level; blockers: Blocker[]; constraints: Constraint[]; pressure: ResourceReport['pressure'];
  /** Whole bytes of memory left after the owner's reserve and safety margin (can be negative). */
  memoryHeadroomBytes: number; ownerCpuPercent: number;
}
export interface OwnerPause { kind: 'timed' | 'reboot' | 'indefinite'; until?: number }

/**
 * Turns operator policy plus host samples into the budget PrivaNet may use *right now*.
 * Rules: hard limits and the owner's reserve are never exceeded; owner load lowers the budget
 * quickly and raises it slowly; pressure states use enter/exit thresholds (hysteresis) so a
 * momentary spike neither destroys work nor flaps the reported state.
 */
export class ResourceEngine {
  private memory: number | undefined;
  private cpu = 0;
  private disk = 0;
  private network = 0;
  private offCache: { minute: number; at: number; value: number | undefined } | undefined;
  private lastAt: number | undefined;
  private pressure: ResourceReport['pressure'] = 'NORMAL';
  private highSince: number | undefined;
  private current: ResourceReport = { contribution: 'PAUSED', pressure: 'NORMAL', power: 'UNKNOWN', memoryBudgetBytes: 0, cpuBudgetPercent: 0 };
  private ownerPause: OwnerPause | undefined;
  private explained: EngineState = { scheduleLevel: 'ADAPTIVE', blockers: [], constraints: [], pressure: 'NORMAL', memoryHeadroomBytes: 0, ownerCpuPercent: 0 };
  constructor(private policy: ResourcePolicy, private readonly sampler: HostSampler, private readonly clock: () => number = Date.now, private readonly transfer?: TransferAllowance) {}

  /** Replaces the owner's policy (a saved change from the panel or CLI). Takes effect at the next update; nothing else about the engine changes. */
  setPolicy(policy: ResourcePolicy): void { this.policy = policy; this.offCache = undefined; }
  /** The owner's pause: while set, contribution is OFF whatever the schedule says. Not a revocation: the node stays enrolled and connected. */
  setOwnerPause(pause: OwnerPause | undefined): void { this.ownerPause = pause; }
  get state(): EngineState { return this.explained; }
  /** Takes a sample and recomputes the budget. Call once per node tick. */
  update(): ResourceReport {
    const now = this.clock(); const sample = this.sampler.sample(); const p = this.policy;
    const first = this.lastAt === undefined; const dt = first ? 0 : Math.max(0, now - (this.lastAt ?? now)); this.lastAt = now;
    this.memory = this.memory === undefined ? sample.availableMemoryBytes : smooth(this.memory, sample.availableMemoryBytes, dt, true);
    this.cpu = first ? sample.ownerCpuPercent : smooth(this.cpu, sample.ownerCpuPercent, dt, false);
    const diskBusy = sample.diskBusyPercent ?? 0; // unknown counts as idle: the owner's disk cap and reserve still bound the budget
    const networkLoad = p.linkBytesPerSec && sample.networkBytesPerSec !== undefined ? Math.min(100, (100 * sample.networkBytesPerSec) / p.linkBytesPerSec) : 0;
    this.disk = first ? diskBusy : smooth(this.disk, diskBusy, dt, false);
    this.network = first ? networkLoad : smooth(this.network, networkLoad, dt, false);

    const margin = p.safetyMarginBytes;
    const headroom = this.memory - p.reserveMemoryBytes - p.safetyMarginBytes; // memory left after the owner's reserve
    this.pressure = this.nextPressure(headroom);
    if (this.pressure === 'HIGH') this.highSince ??= now; else this.highSince = undefined;

    const scheduleLevel = levelAt(p.schedule, p.defaultLevel, new Date(now));
    let level = scheduleLevel; let batteryReduced = false;
    if (sample.power === 'BATTERY') {
      if (p.onBattery === 'disable') level = 'OFF'; else if (p.onBattery === 'reduce' && level !== 'OFF') { level = 'MINIMAL'; batteryReduced = true; }
    }
    if (this.ownerPause) level = 'OFF';
    const paused = level === 'OFF' || this.pressure === 'HIGH' || p.maxMemoryBytes === 0 || p.maxCpuPercent === 0;
    // FULL uses the configured CPU ceiling as-is; ADAPTIVE/MINIMAL also give way to what the owner is using.
    const cpuFree = level === 'FULL' ? 100 - p.reserveCpuPercent : 100 - this.cpu - p.reserveCpuPercent;
    const scale = (level === 'MINIMAL' ? p.minimalFraction : 1) * (this.pressure === 'ELEVATED' ? 0.5 : 1);
    const budget = (memoryCap: number, cpuCap: number) => paused ? { memoryBudgetBytes: 0, cpuBudgetPercent: 0 } : {
      memoryBudgetBytes: Math.floor(Math.max(0, Math.min(headroom, memoryCap)) * scale),
      cpuBudgetPercent: Math.floor(Math.max(0, Math.min(cpuFree, cpuCap)) * scale) };
    const perCapability: NonNullable<ResourceReport['perCapability']> = {};
    for (const [type, limit] of Object.entries(p.capabilityLimits) as Array<[JobType, { maxMemoryBytes?: number; maxCpuPercent?: number }]>)
      perCapability[type] = budget(Math.min(p.maxMemoryBytes, limit.maxMemoryBytes ?? p.maxMemoryBytes), Math.min(p.maxCpuPercent, limit.maxCpuPercent ?? p.maxCpuPercent));
    const general = budget(p.maxMemoryBytes, p.maxCpuPercent);
    // Disk: what the owner allows, bounded by free space above their reserve; unknown free space offers none.
    const diskRoom = Math.max(0, Math.min(p.maxDiskBytes, (sample.freeDiskBytes ?? 0) - p.reserveDiskBytes));
    const offered = IO_ORDER[Math.min(IO_ORDER.indexOf(p.maxDiskIo), IO_ORDER.indexOf(diskIoFor(this.disk)))] ?? 'none';
    const diskFields = paused ? { diskBudgetBytes: 0, diskIo: 'none' as const } : { diskBudgetBytes: Math.floor(diskRoom * scale), diskIo: offered };
    const networkFields = this.transfer ? { networkBudgetBytes: paused ? 0 : this.transfer.remainingBytes() } : {};
    const minute = Math.floor(now / 60000);
    if (this.offCache?.minute !== minute) this.offCache = { minute, at: now, value: nextOffMs(p.schedule, p.defaultLevel, new Date(now)) };
    const untilOff = this.offCache.value === undefined ? undefined : Math.max(0, this.offCache.value - (now - this.offCache.at));
    const blockers: Blocker[] = []; const constraints: Constraint[] = []; const stopped = paused || level === 'OFF';
    if (this.ownerPause) blockers.push('PAUSED_BY_OWNER');
    if (scheduleLevel === 'OFF') blockers.push('SCHEDULE_OFF');
    if (sample.power === 'BATTERY' && p.onBattery === 'disable') blockers.push('ON_BATTERY');
    if (p.maxMemoryBytes === 0 || p.maxCpuPercent === 0) blockers.push('POLICY_ZERO_LIMIT');
    if (this.pressure === 'HIGH') blockers.push(headroom < margin ? 'MEMORY_PRESSURE' : 'CPU_PRESSURE');
    if (!stopped) {
      if (diskFields.diskBudgetBytes === 0) constraints.push('DISK_BUDGET_EXHAUSTED');
      if (this.transfer && networkFields.networkBudgetBytes === 0) constraints.push('TRANSFER_ALLOWANCE_EXHAUSTED');
      if (general.memoryBudgetBytes === 0) constraints.push('MEMORY_BUDGET_ZERO');
      if (general.cpuBudgetPercent === 0) constraints.push('CPU_BUDGET_ZERO');
      if (batteryReduced) constraints.push('BATTERY_REDUCED');
      if (this.pressure === 'ELEVATED') constraints.push('PRESSURE_ELEVATED');
    }
    this.explained = { scheduleLevel, blockers, constraints, pressure: this.pressure, memoryHeadroomBytes: Math.round(headroom), ownerCpuPercent: Math.round(this.cpu) };
    this.current = { contribution: paused || level === 'OFF' ? 'PAUSED' : level,
      pressure: this.pressure, power: sample.power, ...general, ...diskFields, ...networkFields,
      ...(untilOff === undefined ? {} : { availableForMs: untilOff }),
      ...(Object.keys(perCapability).length ? { perCapability } : {}) };
    return this.current;
  }
  get report(): ResourceReport { return this.current; }
  /** True once HIGH pressure has lasted long enough that preemptible running work should be handed back. */
  shouldPreempt(): boolean { return this.highSince !== undefined && this.clock() - this.highSince >= this.policy.preemptAfterMs; }
  private nextPressure(headroom: number): ResourceReport['pressure'] {
    const margin = this.policy.safetyMarginBytes; const cpu = this.cpu; const was = this.pressure;
    const io = Math.max(this.disk, this.network);
    const high = headroom < 0 || cpu >= CPU_ENTER.HIGH;
    const elevated = headroom < margin || cpu >= CPU_ENTER.ELEVATED || io >= IO_ENTER;
    const stillElevated = headroom < 2 * margin || cpu >= CPU_EXIT.ELEVATED || io >= IO_EXIT;
    if (was === 'HIGH') { if (headroom < margin || cpu >= CPU_EXIT.HIGH) return 'HIGH'; return stillElevated ? 'ELEVATED' : 'NORMAL'; }
    if (high) return 'HIGH';
    if (was === 'ELEVATED') return stillElevated ? 'ELEVATED' : 'NORMAL';
    return elevated ? 'ELEVATED' : 'NORMAL';
  }
}
