import { readFileSync, renameSync, openSync, writeSync, fsyncSync, closeSync, unlinkSync, lstatSync, constants } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

/** What the resource engine needs to know: how much metered transfer is left this month. */
export interface TransferAllowance { remainingBytes(): number }
export class TransferLimitError extends Error { constructor() { super('Monthly transfer allowance exhausted'); this.name = 'TransferLimitError'; } }
export interface TransferMeterOptions {
  stateDir: string;
  /** Bytes per second; null = unlimited. */
  ratePerSec: number | null;
  /** Bytes per calendar month (UTC); null = unlimited. */
  monthlyBytes: number | null;
  clock?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}
const period = (at: number) => new Date(at).toISOString().slice(0, 7);
/**
 * The node's enforcement point for the owner's bandwidth limits: a token bucket for the rate and a
 * persisted monthly counter for the allowance. Handlers that move data must call `consume` first;
 * the daemon separately `record`s the control-plane bytes of each job. The counter is a plain owner-
 * private file, so the owner (not the Coordinator) controls it; a compromised node is not bound by it.
 */
export class TransferMeter implements TransferAllowance {
  private readonly file: string;
  private readonly clock: () => number;
  private readonly sleep: NonNullable<TransferMeterOptions['sleep']>;
  private used = 0; private month: string;
  private unsafe = false;
  private tokens: number; private refilledAt: number; private rateRevision = 0;
  constructor(private options: TransferMeterOptions) {
    this.file = join(options.stateDir, 'transfer.json'); this.clock = options.clock ?? Date.now;
    this.sleep = options.sleep ?? (async (ms, signal) => { await delay(ms, undefined, signal ? { signal } : {}); });
    this.month = period(this.clock()); this.refilledAt = this.clock(); this.tokens = options.ratePerSec ?? 0;
    this.load();
  }
  private load(): void {
    try {
      let stat;
      try { stat = lstatSync(this.file); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192 || (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))) throw new Error();
      const value = JSON.parse(readFileSync(this.file, 'utf8')) as { period?: unknown; bytes?: unknown };
      if (typeof value.period !== 'string' || !/^\d{4}-\d{2}$/.test(value.period) || typeof value.bytes !== 'number' || !Number.isSafeInteger(value.bytes) || value.bytes < 0) throw new Error();
      if (value.period === this.month) this.used = value.bytes;
    } catch { this.unsafe = true; }
  }
  private roll(): void { const now = period(this.clock()); if (now !== this.month) { this.month = now; this.used = 0; } }
  private persist(): void {
    if (this.unsafe) return;
    const tmp = `${this.file}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      const handle = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
      try { const bytes = Buffer.from(JSON.stringify({ period: this.month, bytes: this.used })); let offset = 0; while (offset < bytes.length) offset += writeSync(handle, bytes, offset); fsyncSync(handle); } finally { closeSync(handle); }
      renameSync(tmp, this.file);
      if (process.platform !== "win32") { const dir = openSync(this.options.stateDir, constants.O_RDONLY); try { fsyncSync(dir); } finally { closeSync(dir); } }
    } catch { this.unsafe = true; try { unlinkSync(tmp); } catch { /* absent */ } }
  }
  /** Applies new owner limits without a restart (the saved policy changed). The month's usage so far is kept. */
  setLimits(limits: { ratePerSec: number | null; monthlyBytes: number | null }): void {
    if (limits.ratePerSec !== this.options.ratePerSec) { this.rateRevision++; this.tokens = limits.ratePerSec ?? 0; this.refilledAt = this.clock(); }
    this.options = { ...this.options, ratePerSec: limits.ratePerSec, monthlyBytes: limits.monthlyBytes };
  }
  /** Existing reservations remain bounded by the current owner policy. */
  allowsReservedTransfers(): boolean { this.roll(); return !this.unsafe && (this.options.monthlyBytes === null || this.used <= this.options.monthlyBytes); }
  /** Metered bytes this calendar month (UTC), and the month they belong to. */
  usage(): { month: string; usedBytes: number; monthlyBytes: number | null } { this.roll(); return { month: this.month, usedBytes: this.used, monthlyBytes: this.options.monthlyBytes }; }
  remainingBytes(): number {
    this.roll();
    if (this.unsafe) return 0;
    return this.options.monthlyBytes === null ? 2 ** 40 : Math.max(0, this.options.monthlyBytes - this.used);
  }
  /** Accounts bytes without throttling or refusing (already-spent control-plane traffic). */
  record(bytes: number): void { this.roll(); this.used += Math.max(0, Math.floor(bytes)); this.persist(); }
  /** Reserves `bytes` before moving them: refuses past the monthly allowance and waits to honour the rate. */
  async consume(bytes: number, signal?: AbortSignal): Promise<void> {
    this.reserve(bytes);
    await this.throttle(bytes, signal);
  }
  /** Reserve a bounded transfer once, durably, before streaming (partial attempts are conservatively charged). */
  reserve(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('Invalid transfer size');
    if (bytes > this.remainingBytes()) throw new TransferLimitError();
    this.used += bytes; this.persist();
    if (this.unsafe) throw new TransferLimitError();
  }
  /** Shared streaming rate gate; accounting was reserved before the operation. */
  async throttle(bytes: number, signal?: AbortSignal): Promise<void> {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || !this.allowsReservedTransfers()) throw new TransferLimitError();
    const rate = this.options.ratePerSec; if (rate === null) return;
    const now = this.clock();
    this.tokens = Math.min(rate, this.tokens + (now - this.refilledAt) / 1000 * rate); this.refilledAt = now;
    this.tokens -= bytes; // may go negative: the deficit is the time the caller must wait
    const revision = this.rateRevision;
    let wait = Math.max(0, Math.ceil(-this.tokens / rate * 1000));
    // Node timers overflow above 2^31-1 ms. Short slices also observe owner changes promptly.
    while (wait > 0) {
      signal?.throwIfAborted(); const slice = Math.min(wait, 1000); await this.sleep(slice, signal); wait -= slice;
      if (!this.allowsReservedTransfers()) throw new TransferLimitError();
      if (revision !== this.rateRevision) { await this.throttle(bytes, signal); return; }
    }
    if (!this.allowsReservedTransfers()) throw new TransferLimitError();
  }
}
