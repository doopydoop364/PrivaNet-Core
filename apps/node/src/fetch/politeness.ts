/**
 * Defence-in-depth rate limiting on the node: a minimum delay between requests to one host and a cap on total requests
 * per minute. State is in memory only and is lost on restart; the application's own frontier is the primary limiter.
 * When the answer is "too soon" the handler returns immediately (RATE_LIMITED) rather than holding a job slot.
 */
export class Limiter {
  private readonly nextAllowed = new Map<string, number>(); private window: number[] = [];
  constructor(private readonly minHostDelayMs: number, private readonly maxPerMinute: number, private readonly clock: () => number = Date.now, private readonly maxHosts = 5000) {}
  /** Reserves a request slot for the host, or says how long to wait. `extraDelayMs` raises the host delay (robots Crawl-delay). */
  tryAcquire(host: string, extraDelayMs = 0): { ok: true } | { ok: false; retryAfterSec: number } {
    const now = this.clock(); this.window = this.window.filter(time => now - time < 60000);
    const hostWait = Math.max(0, (this.nextAllowed.get(host) ?? 0) - now);
    const windowWait = this.window.length >= this.maxPerMinute ? Math.max(0, 60000 - (now - (this.window[0] ?? now))) : 0;
    const wait = Math.max(hostWait, windowWait);
    if (wait > 0) return { ok: false, retryAfterSec: Math.max(1, Math.ceil(wait / 1000)) };
    this.window.push(now); this.nextAllowed.set(host, now + Math.max(this.minHostDelayMs, extraDelayMs));
    if (this.nextAllowed.size > this.maxHosts) { for (const [key, until] of this.nextAllowed) { if (until <= now) this.nextAllowed.delete(key); if (this.nextAllowed.size <= this.maxHosts) break; } }
    return { ok: true };
  }
  /** Applies a Crawl-delay learned after acquiring (from robots.txt). */
  raiseDelay(host: string, delayMs: number): void { this.nextAllowed.set(host, Math.max(this.nextAllowed.get(host) ?? 0, this.clock() + delayMs)); }
}
