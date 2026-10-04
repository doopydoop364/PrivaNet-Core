import { performance } from 'node:perf_hooks';
import { TransferKeysSchema, TICKET_MAX_LIFETIME_MS, TICKET_MAX_SKEW_MS } from '@privanet/protocol';
import type { TransferKeys } from '@privanet/protocol';
import { canonicalPublicKey, parseTicket, transferKeyId } from '@privanet/shared';

export const TRANSFER_KEY_REFRESH_MS = 30_000;
const UNKNOWN_KEY_REFRESH_MS = 5_000;
const MAX_BACKOFF_MS = 120_000;

/**
 * Keys come exclusively from the authenticated session of the bound Coordinator.
 * Successful lists replace the cache (including retirement deadlines); transient
 * failures preserve it. Refresh requests are single-flight and globally throttled,
 * with bounded exponential outage backoff independent of attacker-chosen kids.
 */
export class TransferKeyCache {
  private cached: TransferKeys['keys'] | null = null;
  private inFlight: Promise<void> | undefined;
  private nextPeriodic = 0;
  private nextUnknown = 0;
  private failures = 0;
  constructor(private readonly coordinatorId: string, private readonly fetchKeys: () => Promise<unknown>, private readonly monotonicNow: () => number = () => performance.now()) {}

  get keys(): TransferKeys['keys'] | null { return this.cached?.map(key => ({ ...key })) ?? null; }

  refresh(reason: 'periodic' | 'unknown' = 'periodic'): Promise<void> {
    if (this.inFlight) return this.inFlight;
    const now = this.monotonicNow();
    if (now < (reason === 'periodic' ? this.nextPeriodic : this.nextUnknown)) return Promise.resolve();
    // Reserve the refresh budget before starting a request. Failed requests and every
    // different unknown kid spend the same global budget.
    this.nextPeriodic = now + TRANSFER_KEY_REFRESH_MS;
    this.nextUnknown = now + UNKNOWN_KEY_REFRESH_MS;
    this.inFlight = this.fetch().finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }

  /** Structure/time checks only: an unknown key never becomes trusted by this method. */
  async refreshForTicket(wire: string, coordinatorNow: number): Promise<void> {
    const parsed = parseTicket(wire); if (!parsed) return;
    const claims = parsed.claims;
    if (!Number.isSafeInteger(coordinatorNow) || coordinatorNow < 0 || claims.expiresAt <= claims.issuedAt || claims.expiresAt - claims.issuedAt > TICKET_MAX_LIFETIME_MS ||
        claims.issuedAt - TICKET_MAX_SKEW_MS > coordinatorNow || coordinatorNow >= claims.expiresAt + TICKET_MAX_SKEW_MS) return;
    if (!this.cached?.some(key => key.kid === claims.kid)) await this.refresh('unknown');
  }

  private async fetch(): Promise<void> {
    try {
      const response = TransferKeysSchema.parse(await this.fetchKeys());
      if (response.coordinatorId !== this.coordinatorId) { this.cached = null; throw new Error(); }
      if (new Set(response.keys.map(key => key.kid)).size !== response.keys.length) throw new Error();
      for (const key of response.keys) { canonicalPublicKey(key.publicKey); if (transferKeyId(key.publicKey) !== key.kid) throw new Error(); }
      this.cached = response.keys; this.failures = 0;
    } catch {
      this.failures = Math.min(this.failures + 1, 6);
      const now = this.monotonicNow(); const backoff = Math.min(MAX_BACKOFF_MS, UNKNOWN_KEY_REFRESH_MS * 2 ** (this.failures - 1));
      this.nextUnknown = now + backoff; this.nextPeriodic = now + Math.max(TRANSFER_KEY_REFRESH_MS, backoff);
    }
  }
}
