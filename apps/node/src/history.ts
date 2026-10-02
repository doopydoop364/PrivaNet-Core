import { join } from 'node:path';
import { z } from 'zod';
import { isMissing, privateDirectory, readPrivateFileUpTo, replacePrivateFile } from '@privanet/shared';

/**
 * A small local history of numbers the node already has: the budget it was permitted to offer, the pressure it measured, how many jobs it ran, and metered transfer.
 * One point every five minutes for 24 hours (288 points), kept in a private file on this machine and never sent anywhere. It is NOT per-job accounting (that is a later phase):
 * "permitted" values are the coarse budgets the engine derived from the owner's limits, and "measured" values are the host numbers the engine sampled.
 */
export const HISTORY_FILE = 'history.json';
export const HISTORY_INTERVAL_MS = 5 * 60000;
export const HISTORY_MAX_POINTS = 288;
export const HistoryPointSchema = z.strictObject({
  t: z.number().int().min(0), contribution: z.string().max(16), pressure: z.string().max(16),
  permittedMemoryBytes: z.number().min(0), permittedCpuPercent: z.number().min(0).max(100), permittedDiskBytes: z.number().min(0).optional(),
  measuredOwnerCpuPercent: z.number().min(0).max(100), activeJobs: z.number().int().min(0),
  transferUsedBytes: z.number().min(0).optional(), transferRemainingBytes: z.number().min(0).optional(),
});
export type HistoryPoint = z.infer<typeof HistoryPointSchema>;
const FileSchema = z.strictObject({ version: z.literal(1), points: z.array(HistoryPointSchema).max(HISTORY_MAX_POINTS) });

export class ResourceHistory {
  private list: HistoryPoint[] = [];
  private lastAt = 0;
  constructor(private readonly stateDir: string, private readonly clock: () => number = Date.now) {}
  async load(): Promise<void> {
    try {
      const parsed = FileSchema.safeParse(JSON.parse(await readPrivateFileUpTo(join(this.stateDir, HISTORY_FILE), 262144)));
      if (parsed.success) { this.list = parsed.data.points.slice(-HISTORY_MAX_POINTS); this.lastAt = this.list.at(-1)?.t ?? 0; }
    } catch (error) { if (!isMissing(error)) this.list = []; /* unreadable history is only a convenience: start again */ }
  }
  /** Records a point if the interval has passed; returns whether it did. Persistence is best effort. */
  async record(point: Omit<HistoryPoint, 't'>, force = false): Promise<boolean> {
    const now = this.clock();
    if (!force && now - this.lastAt < HISTORY_INTERVAL_MS) return false;
    this.list.push({ t: now, ...point }); if (this.list.length > HISTORY_MAX_POINTS) this.list.splice(0, this.list.length - HISTORY_MAX_POINTS);
    this.lastAt = now;
    try { await replacePrivateFile(join(await privateDirectory(this.stateDir), HISTORY_FILE), JSON.stringify({ version: 1, points: this.list })); } catch { /* the in-memory history still serves the panel */ }
    return true;
  }
  points(): HistoryPoint[] { return [...this.list]; }
}
