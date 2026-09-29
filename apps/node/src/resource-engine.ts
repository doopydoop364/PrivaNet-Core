import type { JobType, ResourceReport } from '@privanet/protocol';
import { levelAt } from './resource-schedule.js';
import type { ResourcePolicy } from './resource-policy.js';
import type { HostSampler } from './resource-sampler.js';

// Time constants: fall fast when the owner needs resources back, recover slowly to avoid churn.
const TAU_DOWN_MS = 2000; const TAU_UP_MS = 30000;
const CPU_ENTER = { ELEVATED: 75, HIGH: 90 } as const; const CPU_EXIT = { ELEVATED: 65, HIGH: 80 } as const;
const smooth = (previous: number, sample: number, dtMs: number, fallingIsBad: boolean) => {
  const worse = fallingIsBad ? sample < previous : sample > previous;
  return previous + (sample - previous) * (1 - Math.exp(-dtMs / (worse ? TAU_DOWN_MS : TAU_UP_MS)));
};

/**
 * Turns operator policy plus host samples into the budget PrivaNet may use *right now*.
 * Rules: hard limits and the owner's reserve are never exceeded; owner load lowers the budget
 * quickly and raises it slowly; pressure states use enter/exit thresholds (hysteresis) so a
 * momentary spike neither destroys work nor flaps the reported state.
 */
export class ResourceEngine {
  private memory: number | undefined;
  private cpu = 0;
  private lastAt: number | undefined;
  private pressure: ResourceReport['pressure'] = 'NORMAL';
  private highSince: number | undefined;
  private current: ResourceReport = { contribution: 'PAUSED', pressure: 'NORMAL', power: 'UNKNOWN', memoryBudgetBytes: 0, cpuBudgetPercent: 0 };
  constructor(private readonly policy: ResourcePolicy, private readonly sampler: HostSampler, private readonly clock: () => number = Date.now) {}

  /** Takes a sample and recomputes the budget. Call once per node tick. */
  update(): ResourceReport {
    const now = this.clock(); const sample = this.sampler.sample(); const p = this.policy;
    const first = this.lastAt === undefined; const dt = first ? 0 : Math.max(0, now - (this.lastAt ?? now)); this.lastAt = now;
    this.memory = this.memory === undefined ? sample.availableMemoryBytes : smooth(this.memory, sample.availableMemoryBytes, dt, true);
    this.cpu = first ? sample.ownerCpuPercent : smooth(this.cpu, sample.ownerCpuPercent, dt, false);

    const headroom = this.memory - p.reserveMemoryBytes - p.safetyMarginBytes; // memory left after the owner's reserve
    this.pressure = this.nextPressure(headroom);
    if (this.pressure === 'HIGH') this.highSince ??= now; else this.highSince = undefined;

    let level = levelAt(p.schedule, p.defaultLevel, new Date(now));
    if (sample.power === 'BATTERY') {
      if (p.onBattery === 'disable') level = 'OFF'; else if (p.onBattery === 'reduce' && level !== 'OFF') level = 'MINIMAL';
    }
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
    this.current = { contribution: paused || level === 'OFF' ? 'PAUSED' : level,
      pressure: this.pressure, power: sample.power, ...general, ...(Object.keys(perCapability).length ? { perCapability } : {}) };
    return this.current;
  }
  get report(): ResourceReport { return this.current; }
  /** True once HIGH pressure has lasted long enough that preemptible running work should be handed back. */
  shouldPreempt(): boolean { return this.highSince !== undefined && this.clock() - this.highSince >= this.policy.preemptAfterMs; }
  private nextPressure(headroom: number): ResourceReport['pressure'] {
    const margin = this.policy.safetyMarginBytes; const cpu = this.cpu; const was = this.pressure;
    const high = headroom < 0 || cpu >= CPU_ENTER.HIGH;
    const elevated = headroom < margin || cpu >= CPU_ENTER.ELEVATED;
    if (was === 'HIGH') { if (headroom < margin || cpu >= CPU_EXIT.HIGH) return 'HIGH'; return headroom < 2 * margin || cpu >= CPU_EXIT.ELEVATED ? 'ELEVATED' : 'NORMAL'; }
    if (high) return 'HIGH';
    if (was === 'ELEVATED') return headroom < 2 * margin || cpu >= CPU_EXIT.ELEVATED ? 'ELEVATED' : 'NORMAL';
    return elevated ? 'ELEVATED' : 'NORMAL';
  }
}
