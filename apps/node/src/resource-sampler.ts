import { cpus, freemem, totalmem } from 'node:os';
import { readFileSync, readdirSync } from 'node:fs';
import type { ResourceReport } from '@privanet/protocol';

/** The only host facts PrivaNet reads: coarse memory, CPU pressure and power source. */
export interface HostSample {
  availableMemoryBytes: number;
  /** System-wide CPU busy percent excluding this process. */
  ownerCpuPercent: number;
  power: ResourceReport['power'];
}
export interface HostSampler { sample(): HostSample }

function availableMemory(): number {
  if (process.platform === 'linux') {
    // MemAvailable counts reclaimable cache; os.freemem() would understate what is safe to use.
    try {
      const match = /^MemAvailable:\s+(\d+) kB/m.exec(readFileSync('/proc/meminfo', 'utf8'));
      if (match?.[1]) return Number(match[1]) * 1024;
    } catch { /* fall through */ }
  }
  return freemem();
}
function powerSource(): ResourceReport['power'] {
  if (process.platform !== 'linux') return 'UNKNOWN';
  try {
    const root = '/sys/class/power_supply'; let battery = false; let mains: boolean | undefined;
    for (const name of readdirSync(root)) {
      const type = readFileSync(`${root}/${name}/type`, 'utf8').trim();
      if (type === 'Battery') battery = true;
      if (type === 'Mains' || type === 'USB') mains = (mains ?? false) || readFileSync(`${root}/${name}/online`, 'utf8').trim() === '1';
    }
    if (!battery) return 'AC';
    return mains === undefined ? 'UNKNOWN' : mains ? 'AC' : 'BATTERY';
  } catch { return 'UNKNOWN'; }
}
/** Real host sampler: OS-provided counters only, no process lists, files or identifiers. */
export class OsSampler implements HostSampler {
  private last: { idle: number; total: number; own: number; at: number } | undefined;
  sample(): HostSample {
    let idle = 0; let total = 0;
    for (const { times } of cpus()) { idle += times.idle; total += times.user + times.nice + times.sys + times.idle + times.irq; }
    const usage = process.cpuUsage(); const own = usage.user + usage.system; const at = performance.now();
    let ownerCpuPercent = 0;
    if (this.last && total > this.last.total && at > this.last.at) {
      const busy = 100 * (1 - (idle - this.last.idle) / (total - this.last.total));
      const ownShare = (own - this.last.own) / 1000 / ((at - this.last.at) * cpus().length) * 100;
      ownerCpuPercent = Math.min(100, Math.max(0, busy - ownShare));
    }
    this.last = { idle, total, own, at };
    return { availableMemoryBytes: Math.min(availableMemory(), totalmem()), ownerCpuPercent, power: powerSource() };
  }
}
