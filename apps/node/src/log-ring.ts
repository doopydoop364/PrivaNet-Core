/**
 * The most recent node log events, kept in memory for the local panel and the support bundle. Events are the fixed vocabulary the node already logs (an event name and, at most,
 * a failure code and reason), so nothing here can carry a message, an address or a credential; the ring is bounded and is gone when the node stops.
 */
export interface LogEntry { at: number; event: string; code?: string; reason?: string }
export class LogRing {
  private readonly entries: LogEntry[] = [];
  constructor(private readonly capacity = 200) {}
  push(entry: { event: string; code?: string; reason?: string }): void {
    const { event, code, reason } = entry;
    this.entries.push({ at: Date.now(), event: String(event).slice(0, 80), ...(code ? { code: String(code).slice(0, 80) } : {}), ...(reason ? { reason: String(reason).slice(0, 80) } : {}) });
    if (this.entries.length > this.capacity) this.entries.splice(0, this.entries.length - this.capacity);
  }
  recent(limit = 100): LogEntry[] { return this.entries.slice(-Math.max(1, Math.min(limit, this.capacity))); }
}
