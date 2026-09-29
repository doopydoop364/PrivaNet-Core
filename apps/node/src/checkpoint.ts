import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { JobType } from '@privanet/protocol';

/** What a checkpointable handler sees: its own saved state, if any, and a way to save progress. */
export interface Checkpoint { load(): unknown; save(state: unknown): void }
const SAFE_ID = /^[A-Za-z0-9-]{1,64}$/;
export interface CheckpointOptions { maxBytes?: number; maxAgeMs?: number; clock?: () => number }
/**
 * Node-local checkpoints for jobs whose type is registered `checkpointable`. A checkpoint lets the
 * *same node* resume after preemption, shutdown or restart when the Coordinator hands it the job
 * again; it is never sent to the Coordinator or another node (portable checkpoints would need a
 * data plane and integrity design, and are out of scope). Bounded in size and age, owner-private,
 * and deleted when the job completes or fails. The handler decides what to trust when it resumes.
 */
export class CheckpointStore {
  private readonly maxBytes: number; private readonly maxAgeMs: number; private readonly clock: () => number;
  constructor(private readonly dir: string, options: CheckpointOptions = {}) {
    this.maxBytes = options.maxBytes ?? 1024 * 1024; this.maxAgeMs = options.maxAgeMs ?? 24 * 3600 * 1000; this.clock = options.clock ?? Date.now;
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }
  private path(jobId: string): string { if (!SAFE_ID.test(jobId)) throw new Error('Invalid job id'); return join(this.dir, `${jobId}.json`); }
  forJob(jobId: string, type: JobType): Checkpoint {
    const path = this.path(jobId);
    return {
      load: () => {
        try {
          const value = JSON.parse(readFileSync(path, 'utf8')) as { type?: unknown; savedAt?: unknown; state?: unknown };
          if (value.type === type && typeof value.savedAt === 'number' && this.clock() - value.savedAt <= this.maxAgeMs) return value.state;
        } catch { /* missing or corrupt: start from scratch */ }
        return undefined;
      },
      save: state => {
        const text = JSON.stringify({ type, savedAt: this.clock(), state });
        if (Buffer.byteLength(text) > this.maxBytes) throw new Error('Checkpoint too large');
        const tmp = `${path}.tmp`; writeFileSync(tmp, text, { mode: 0o600 }); renameSync(tmp, path);
      },
    };
  }
  clear(jobId: string): void { try { unlinkSync(this.path(jobId)); } catch { /* already gone */ } }
  /** Deletes checkpoints older than the age limit (abandoned jobs); returns how many were removed. */
  prune(): number {
    let removed = 0;
    try {
      for (const name of readdirSync(this.dir)) {
        const file = join(this.dir, name);
        try { if (this.clock() - statSync(file).mtimeMs > this.maxAgeMs) { unlinkSync(file); removed++; } } catch { /* raced with a delete */ }
      }
    } catch { /* directory unreadable: nothing to prune */ }
    return removed;
  }
}
