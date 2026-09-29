import { cpus, freemem, totalmem } from 'node:os';
import { execFile } from 'node:child_process';
import { readFileSync, readdirSync, statfsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { ResourceReport } from '@privanet/protocol';

/** The only host facts PrivaNet reads: coarse memory, CPU, disk and network load, free space and power source. */
export interface HostSample {
  availableMemoryBytes: number;
  /** System-wide CPU busy percent excluding this process. */
  ownerCpuPercent: number;
  power: ResourceReport['power'];
  /** Free space on the volume holding PrivaNode's state; undefined when it cannot be determined (treated as none). */
  freeDiskBytes?: number;
  /** Busiest physical disk's utilisation percent (Linux only; includes PrivaNet's own I/O, so it is conservative). Undefined = unknown. */
  diskBusyPercent?: number;
  /** Total non-loopback network throughput in bytes per second (Linux only; includes PrivaNet's own traffic). Undefined = unknown. */
  networkBytesPerSec?: number;
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
/** `pmset -g batt` on macOS: the first line names the current power source. */
export function parsePmset(output: string): ResourceReport['power'] {
  const match = /Now drawing from '([^']+)'/.exec(output);
  if (!match) return 'UNKNOWN';
  return /battery/i.test(match[1] ?? '') ? 'BATTERY' : /(ac|ups)/i.test(match[1] ?? '') ? 'AC' : 'UNKNOWN';
}
/**
 * Windows `Win32_Battery.BatteryStatus` values joined by commas; empty output means no battery
 * (a desktop). 1 discharging, 4 low and 5 critical mean running on battery; 2, 3, 6-9, 11 mean mains.
 */
export function parseWindowsBattery(output: string): ResourceReport['power'] {
  const codes = output.trim() === '' ? [] : output.trim().split(',').map(part => Number(part.trim()));
  if (codes.some(code => !Number.isInteger(code))) return 'UNKNOWN';
  if (codes.length === 0) return 'AC';
  if (codes.some(code => [1, 4, 5].includes(code))) return 'BATTERY';
  return codes.every(code => [2, 3, 6, 7, 8, 9, 11].includes(code)) ? 'AC' : 'UNKNOWN';
}
/**
 * Asks the OS for the power source with a fixed, argument-free command, in the background and at
 * most once a minute, so a slow query never blocks the resource loop. Until the first answer, and
 * whenever the query fails, the source is UNKNOWN (treated as mains).
 */
class PowerProbe {
  private value: ResourceReport['power'] = 'UNKNOWN'; private at = 0; private running = false;
  constructor(private readonly command: string, private readonly args: string[], private readonly parse: (output: string) => ResourceReport['power'], private readonly ttlMs = 60000) {}
  read(): ResourceReport['power'] {
    if (!this.running && Date.now() - this.at >= this.ttlMs) {
      this.running = true; this.at = Date.now();
      execFile(this.command, this.args, { timeout: 5000, windowsHide: true }, (error, stdout) => {
        this.running = false; this.value = error ? 'UNKNOWN' : this.parse(String(stdout));
      }).unref();
    }
    return this.value;
  }
}
const probes = new Map<string, PowerProbe>();
function osPowerProbe(): PowerProbe | undefined {
  const key = process.platform; const known = probes.get(key); if (known) return known;
  const probe = key === 'darwin' ? new PowerProbe('pmset', ['-g', 'batt'], parsePmset)
    : key === 'win32' ? new PowerProbe('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '@(Get-CimInstance -ClassName Win32_Battery | ForEach-Object { $_.BatteryStatus }) -join \',\''], parseWindowsBattery) : undefined;
  if (probe) probes.set(key, probe);
  return probe;
}
/** Sums `io_ticks` (ms spent doing I/O) per whole physical disk from /proc/diskstats; partitions and virtual devices are skipped. */
export function parseDiskstats(text: string): Map<string, number> {
  const disks = new Map<string, number>();
  for (const line of text.split('\n')) {
    const fields = line.trim().split(/\s+/); const name = fields[2]; const ticks = Number(fields[12]);
    if (name && /^(sd[a-z]+|vd[a-z]+|xvd[a-z]+|nvme\d+n\d+|mmcblk\d+)$/.test(name) && Number.isFinite(ticks)) disks.set(name, ticks);
  }
  return disks;
}
/** Total received plus transmitted bytes over non-loopback interfaces from /proc/net/dev. */
export function parseNetDev(text: string): number {
  let total = 0;
  for (const line of text.split('\n')) {
    const [name, rest] = line.split(':'); if (rest === undefined || name?.trim() === 'lo') continue;
    const fields = rest.trim().split(/\s+/).map(Number); total += (fields[0] ?? 0) + (fields[8] ?? 0);
  }
  return total;
}
function freeDisk(path: string): number | undefined {
  // The state directory may not exist yet: measure the nearest existing ancestor, which is on the same volume.
  for (let dir = resolve(path); ; dir = dirname(dir)) {
    try { const stats = statfsSync(dir); return Number(stats.bavail) * Number(stats.bsize); } catch { if (dirname(dir) === dir) return undefined; }
  }
}
function powerSource(): ResourceReport['power'] {
  if (process.platform !== 'linux') return osPowerProbe()?.read() ?? 'UNKNOWN';
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
  private lastIo: { disks: Map<string, number>; net: number; at: number } | undefined;
  constructor(private readonly statePath: string = '.') {}
  /** Linux-only disk utilisation and network throughput since the previous sample. */
  private io(): Pick<HostSample, 'diskBusyPercent' | 'networkBytesPerSec'> {
    if (process.platform !== 'linux') return {};
    try {
      const at = performance.now(); const disks = parseDiskstats(readFileSync('/proc/diskstats', 'utf8')); const net = parseNetDev(readFileSync('/proc/net/dev', 'utf8'));
      const previous = this.lastIo; this.lastIo = { disks, net, at };
      if (!previous || at <= previous.at) return {};
      let busy = 0; for (const [name, ticks] of disks) busy = Math.max(busy, ((ticks - (previous.disks.get(name) ?? ticks)) / (at - previous.at)) * 100);
      return { diskBusyPercent: Math.min(100, Math.max(0, busy)), networkBytesPerSec: Math.max(0, (net - previous.net) / ((at - previous.at) / 1000)) };
    } catch { return {}; }
  }
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
    const free = freeDisk(this.statePath);
    return { availableMemoryBytes: Math.min(availableMemory(), totalmem()), ownerCpuPercent, power: powerSource(), ...(free === undefined ? {} : { freeDiskBytes: free }), ...this.io() };
  }
}
