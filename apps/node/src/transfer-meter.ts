import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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
  private tokens: number; private refilledAt: number;
  constructor(private options: TransferMeterOptions) {
    this.file = join(options.stateDir, 'transfer.json'); this.clock = options.clock ?? Date.now;
    this.sleep = options.sleep ?? (async (ms, signal) => { await delay(ms, undefined, signal ? { signal } : {}); });
    this.month = period(this.clock()); this.refilledAt = this.clock(); this.tokens = options.ratePerSec ?? 0;
    this.load();
  }
  private load(): void {
    try {
      if (!existsSync(this.file)) return;
      const value = JSON.parse(readFileSync(this.file, 'utf8')) as { period?: unknown; bytes?: unknown };
      if (value.period === this.month && typeof value.bytes === 'number' && Number.isSafeInteger(value.bytes) && value.bytes >= 0) this.used = value.bytes;
    } catch { /* corrupt counter: start the month over rather than blocking the owner's node */ }
  }
  private roll(): void { const now = period(this.clock()); if (now !== this.month) { this.month = now; this.used = 0; } }
  private persist(): void {
    try { const tmp = `${this.file}.tmp`; writeFileSync(tmp, JSON.stringify({ period: this.month, bytes: this.used }), { mode: 0o600 }); renameSync(tmp, this.file); }
    catch { /* accounting stays correct in memory; persistence is best effort */ }
  }
  /** Applies new owner limits without a restart (the saved policy changed). The month's usage so far is kept. */
  setLimits(limits: { ratePerSec: number | null; monthlyBytes: number | null }): void {
    this.options = { ...this.options, ratePerSec: limits.ratePerSec, monthlyBytes: limits.monthlyBytes };
    this.tokens = limits.ratePerSec ?? 0; this.refilledAt = this.clock();
  }
  /** Metered bytes this calendar month (UTC), and the month they belong to. */
  usage(): { month: string; usedBytes: number; monthlyBytes: number | null } { this.roll(); return { month: this.month, usedBytes: this.used, monthlyBytes: this.options.monthlyBytes }; }
  remainingBytes(): number {
    this.roll();
    return this.options.monthlyBytes === null ? 2 ** 40 : Math.max(0, this.options.monthlyBytes - this.used);
  }
  /** Accounts bytes without throttling or refusing (already-spent control-plane traffic). */
  record(bytes: number): void { this.roll(); this.used += Math.max(0, Math.floor(bytes)); this.persist(); }
  /** Reserves `bytes` before moving them: refuses past the monthly allowance and waits to honour the rate. */
  async consume(bytes: number, signal?: AbortSignal): Promise<void> {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('Invalid transfer size');
    if (bytes > this.remainingBytes()) throw new TransferLimitError();
    this.used += bytes; this.persist();
    const rate = this.options.ratePerSec; if (rate === null) return;
    const now = this.clock();
    this.tokens = Math.min(rate, this.tokens + (now - this.refilledAt) / 1000 * rate); this.refilledAt = now;
    this.tokens -= bytes; // may go negative: the deficit is the time the caller must wait
    if (this.tokens < 0) await this.sleep(Math.ceil(-this.tokens / rate * 1000), signal);
  }
}
