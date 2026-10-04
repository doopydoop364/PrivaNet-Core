import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { TICKET_MAX_LIFETIME_MS, TICKET_MAX_SKEW_MS } from '@privanet/protocol';
import { createPrivateFile, isMissing, privateDirectory, readPrivateFileUpTo, replacePrivateFile } from '@privanet/shared';

export const REPLAY_STATE_FILE = 'transfer-replay.json';
const MAX_ENTRIES = 4096;
const MAX_STATE_BYTES = 512 * 1024;
const EntrySchema = z.tuple([z.string().regex(/^[a-f0-9]{32}$/), z.number().int().min(0).max(2 ** 48 - 1)]);
const StateSchema = z.strictObject({ version: z.literal(1), entries: z.array(EntrySchema).max(MAX_ENTRIES), checksum: z.string().regex(/^[a-f0-9]{64}$/) });
type Entry = z.infer<typeof EntrySchema>;
type Result = 'OK' | 'REPLAYED' | 'FULL';
export class ReplayStateError extends Error {
  constructor(readonly code: 'REPLAY_STATE_INVALID' | 'REPLAY_STATE_IO' | 'REPLAY_INPUT_INVALID') { super(code); this.name = 'ReplayStateError'; }
}
const checksum = (entries: Entry[]) => createHash('sha256').update(JSON.stringify({ version: 1, entries })).digest('hex');

/**
 * Single-process, write-ahead replay protection. Consume resolves OK only after the whole
 * snapshot and its directory entry are durable. Concurrent consumes share one flush; none
 * may begin an operation until that flush succeeds. A write failure poisons this instance:
 * even if rename succeeded, its callers never assume that durability was achieved.
 * The file contains ids and expiry only, never tickets or holder keys.
 */
export class PersistentReplaySet {
  private seen = new Map<string, number>();
  private pending: Array<{ resolve: (result: Result) => void; reject: (error: ReplayStateError) => void }> = [];
  private flushing = false;
  private poisoned = false;
  private outstanding = 0;
  private constructor(private readonly directory: string, private readonly maxEntries: number) {}

  static async open(stateDir: string, options: { maxEntries?: number } = {}): Promise<PersistentReplaySet> {
    const max = options.maxEntries ?? MAX_ENTRIES;
    if (!Number.isSafeInteger(max) || max < 1 || max > MAX_ENTRIES) throw new ReplayStateError('REPLAY_INPUT_INVALID');
    let directory: string;
    try { directory = await privateDirectory(stateDir); } catch { throw new ReplayStateError('REPLAY_STATE_IO'); }
    const set = new PersistentReplaySet(directory, max);
    let text: string;
    try { text = await readPrivateFileUpTo(join(directory, REPLAY_STATE_FILE), MAX_STATE_BYTES); }
    catch (error) {
      if (!isMissing(error)) throw new ReplayStateError('REPLAY_STATE_INVALID');
      try {
        await createPrivateFile(join(directory, REPLAY_STATE_FILE), JSON.stringify({ version: 1, entries: [], checksum: checksum([]) }));
        await set.syncDirectory();
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw new ReplayStateError('REPLAY_STATE_IO');
      }
      try { text = await readPrivateFileUpTo(join(directory, REPLAY_STATE_FILE), MAX_STATE_BYTES); }
      catch { throw new ReplayStateError('REPLAY_STATE_INVALID'); }
    }
    try {
      const state = StateSchema.parse(JSON.parse(text));
      if (checksum(state.entries) !== state.checksum || state.entries.length > max || new Set(state.entries.map(([id]) => id)).size !== state.entries.length) throw new Error();
      set.seen = new Map(state.entries);
    } catch { throw new ReplayStateError('REPLAY_STATE_INVALID'); }
    // Do not erase or prune security state on open. Cleanup is included in the next
    // successful durable consume, using the same Coordinator clock as ticket verification.
    return set;
  }

  has(transferId: string): boolean { return this.seen.has(transferId); }
  get size(): number { return this.seen.size; }

  consume(transferId: string, expiresAt: number, now: number): Promise<Result> {
    if (this.poisoned) return Promise.reject(new ReplayStateError('REPLAY_STATE_IO'));
    if (!/^[a-f0-9]{32}$/.test(transferId) || !Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(expiresAt) || expiresAt < 0 || expiresAt > 2 ** 48 - 1 ||
        expiresAt + TICKET_MAX_SKEW_MS <= now || expiresAt > now + TICKET_MAX_LIFETIME_MS + TICKET_MAX_SKEW_MS) return Promise.reject(new ReplayStateError('REPLAY_INPUT_INVALID'));
    for (const [id, until] of this.seen) if (until + TICKET_MAX_SKEW_MS <= now) this.seen.delete(id);
    if (this.seen.has(transferId)) return Promise.resolve('REPLAYED');
    if (this.seen.size >= this.maxEntries || this.outstanding >= this.maxEntries) return Promise.resolve('FULL');
    this.seen.set(transferId, expiresAt); // Reserve synchronously, before any await.
    this.outstanding++;
    const promise = new Promise<Result>((resolve, reject) => { this.pending.push({ resolve, reject }); });
    if (!this.flushing) { this.flushing = true; queueMicrotask(() => { void this.flush(); }); }
    return promise;
  }

  private async persist(entries: Entry[]): Promise<void> {
    await replacePrivateFile(join(this.directory, REPLAY_STATE_FILE), JSON.stringify({ version: 1, entries, checksum: checksum(entries) }));
    await this.syncDirectory();
  }

  private async syncDirectory(): Promise<void> {
    // Flush the rename as well as the file. Windows does not permit directory handles;
    // replacePrivateFile already flushes the file before its platform-specific rename.
    if (process.platform !== 'win32') {
      const directory = await open(this.directory, 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    }
  }

  private async flush(): Promise<void> {
    while (this.pending.length > 0) {
      const batch = this.pending; this.pending = [];
      const snapshot = [...this.seen.entries()];
      try { await this.persist(snapshot); }
      catch {
        this.poisoned = true;
        for (const request of [...batch, ...this.pending]) request.reject(new ReplayStateError('REPLAY_STATE_IO'));
        this.pending = []; this.outstanding = 0; break;
      }
      for (const request of batch) request.resolve('OK');
      this.outstanding -= batch.length;
    }
    this.flushing = false;
  }
}
