import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, rename, statfs, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { join, dirname } from 'node:path';
import type { Readable } from 'node:stream';
import { isMissing, privateDirectory } from '@privanet/shared';
import { applicationChunksDir, chunkDigest, chunkPath, isDigestName, isShardName } from './chunk-id.js';
import { StoreError } from './errors.js';
import { DEFAULT_STALE_INCOMING_MS, MAX_CHUNK_BYTES, MAX_IN_FLIGHT_PUTS } from './limits.js';

/**
 * The node-local chunk store (Phase 4.0-alpha.1): immutable, opaque, SHA-256-addressed chunks on this machine's disk, under the owner's limits. It has no network surface and no
 * Coordinator interface, and nothing here knows what a file, a folder or an application is. See docs/PHASE4_DESIGN.md.
 *
 *   <root>/chunks/<aa>/<bb>/<64-hex>     committed chunks (owner-only, never modified after the commit)
 *   <root>/incoming/<32-hex>.part        a put in progress (exclusive create, owner-only)
 *
 * The committed-chunk directories are the **only source of truth**: there is no index file to disagree with them. Usage counters are rebuilt from a directory scan at open (file
 * names and sizes only, no hashing) and kept in memory afterwards; `has` and `get` always consult the filesystem, never the counters.
 *
 * Invariants: (1) a path is built only from a validated chunk identifier; (2) nothing is ever followed through a symbolic link, and a store that contains one is refused;
 * (3) bytes become visible only after they are complete, counted, hashed and fsynced, by one atomic rename; (4) the store never consumes more than the owner's quota or goes
 * below the owner's free-space reserve, re-checked while writing and again at commit; (5) every failure is one of a fixed set of codes, never a path or a system message.
 *
 * One process owns a store at a time (the node). Streaming a put is unlocked; only the short commit step (rename and accounting), delete and rescan are serialized.
 */
export type PutStep = 'reserved' | 'partial-created' | 'first-write' | 'mid-write' | 'stream-complete' | 'verified' | 'synced' | 'shard-ready' | 'renamed' | 'accounted';
export interface StoreHooks { /** Called at each step of a put: tests inject failures or crashes here. Production passes nothing. */ step?: (step: PutStep) => void | Promise<void> }
export type GateVerdict = { allowed: true } | { allowed: false; reason: string };
export interface StoreLimits { maxBytes: number; reserveFreeBytes: number }
export interface StoreOptions {
  limits: StoreLimits;
  /** Whether a put may begin right now (the node's pause, schedule, drain and policy state). Reads and deletes are never gated: they only ever reduce what is stored. */
  gate?: () => GateVerdict;
  /** Free bytes on the volume the store lives on; undefined = unknown, which refuses writes (the reserve cannot be honoured blind). Default: the filesystem's own figure. */
  freeBytes?: () => Promise<number | undefined>;
  staleIncomingMs?: number; maxChunkBytes?: number; maxInFlight?: number; hooks?: StoreHooks; clock?: () => number;
}
export interface StoreUsage {
  committedBytes: number; chunkCount: number;
  /** Bytes reserved by puts in progress plus leftover partial files not yet swept. */
  incomingBytes: number;
  maxBytes: number; reserveFreeBytes: number;
  /** How many more bytes could be accepted right now: the smaller of the quota room and the free space above the reserve. */
  allowedBytes: number; freeBytes: number | null;
  /** Entries found that are not valid chunks (malformed names, wrong sizes or permissions). They are never counted, served or deleted. */
  anomalies: number; integrityFailures: number;
  health: 'OK' | 'DEGRADED'; flags: string[];
}
export interface ScanResult { committedBytes: number; chunkCount: number; incomingBytes: number; anomalies: number; unsafe: boolean; stale: string[]; present: boolean }

const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const posix = process.platform !== 'win32';
const uid = (): number | undefined => process.getuid?.();
/** Can this file be a committed chunk? A regular file (never a link), the right size range, ours and owner-only. Cheap: no content is read. */
function sound(stat: Stats, max: number): boolean {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > max) return false;
  return !posix || ((stat.mode & 0o077) === 0 && stat.uid === uid());
}
function mapError(error: unknown): StoreError {
  if (error instanceof StoreError) return error;
  const code = error instanceof Error && 'code' in error ? String((error as { code?: unknown }).code) : '';
  if (code === 'ENOSPC' || code === 'EDQUOT' || code === 'EFBIG') return new StoreError('STORAGE_FULL');
  if (code === 'ELOOP' || code === 'EMLINK') return new StoreError('STORE_UNSAFE');
  if (error instanceof Error && error.name === 'AbortError') return new StoreError('ABORTED');
  return new StoreError('IO');
}
const ensureDirectory = async (path: string): Promise<void> => { try { await privateDirectory(path); } catch (error) { throw error instanceof StoreError ? error : new StoreError('STORE_UNSAFE'); } };

/** Walks the store's files and counts what is there. Reads names and sizes only; never follows a link, never changes anything. */
export async function scanStore(root: string, options: { maxChunkBytes?: number; staleMs?: number; clock?: () => number; skipPartials?: ReadonlySet<string> } = {}): Promise<ScanResult> {
  const max = options.maxChunkBytes ?? MAX_CHUNK_BYTES; const now = (options.clock ?? Date.now)(); const staleMs = options.staleMs ?? DEFAULT_STALE_INCOMING_MS;
  const result: ScanResult = { committedBytes: 0, chunkCount: 0, incomingBytes: 0, anomalies: 0, unsafe: false, stale: [], present: false };
  const dir = async (path: string): Promise<'dir' | 'absent' | 'bad'> => {
    let stat: Stats; try { stat = await lstat(path); } catch (error) { if (isMissing(error)) return 'absent'; throw new StoreError('IO'); }
    if (stat.isSymbolicLink()) { result.unsafe = true; return 'bad'; }
    if (!stat.isDirectory()) return 'bad';
    if (posix && ((stat.mode & 0o077) !== 0 || stat.uid !== uid())) { result.unsafe = true; return 'bad'; }
    return 'dir';
  };
  const names = async (path: string): Promise<string[]> => { try { return await readdir(path); } catch { throw new StoreError('IO'); } };
  const chunks = join(root, 'chunks'); const incoming = join(root, 'incoming');
  if ((await dir(root)) === 'absent') return result;
  result.present = true;
  const top = await dir(chunks);
  if (top === 'bad') { result.unsafe = true; } else if (top === 'dir') {
    const roots = [chunks];
    for (const name of await names(chunks)) if (/^app_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(name)) {
      const path = join(chunks, name); if (await dir(path) === 'dir') roots.push(path); else result.unsafe = true;
    }
    for (const namespace of roots) for (const a of await names(namespace)) {
      if (namespace === chunks && a.startsWith('app_') && roots.includes(join(chunks, a))) continue;
      const pa = join(namespace, a);
      if (!isShardName(a)) { result.anomalies++; if ((await lstat(pa).catch(() => undefined))?.isSymbolicLink()) result.unsafe = true; continue; }
      const da = await dir(pa); if (da === 'bad') { if (!result.unsafe) result.anomalies++; continue; } if (da === 'absent') continue;
      for (const b of await names(pa)) {
        const pb = join(pa, b);
        if (!isShardName(b)) { result.anomalies++; if ((await lstat(pb).catch(() => undefined))?.isSymbolicLink()) result.unsafe = true; continue; }
        const db = await dir(pb); if (db === 'bad') { if (!result.unsafe) result.anomalies++; continue; } if (db === 'absent') continue;
        for (const name of await names(pb)) {
          let stat: Stats; try { stat = await lstat(join(pb, name)); } catch { continue; }
          if (stat.isSymbolicLink()) { result.unsafe = true; continue; }
          if (!isDigestName(name) || !name.startsWith(a + b) || !sound(stat, max)) { result.anomalies++; continue; }
          result.committedBytes += stat.size; result.chunkCount++;
        }
      }
    }
  }
  const inc = await dir(incoming);
  if (inc === 'bad') { result.unsafe = true; } else if (inc === 'dir') {
    for (const name of await names(incoming)) {
      let stat: Stats; try { stat = await lstat(join(incoming, name)); } catch { continue; }
      if (stat.isSymbolicLink()) { result.unsafe = true; continue; }
      if (!stat.isFile() || !/^[0-9a-f]{32}\.part$/.test(name)) { result.anomalies++; continue; }
      if (options.skipPartials?.has(name)) continue;
      result.incomingBytes += stat.size;
      if (now - stat.mtimeMs > staleMs) result.stale.push(name);
    }
  }
  return result;
}

export class ChunkStore {
  private committedBytes = 0; private chunkCount = 0; private orphanBytes = 0; private anomalies = 0; private integrityFailures = 0;
  private reserved = 0; private writtenInFlight = 0; private inFlight = 0; private closedFlag = false;
  private readonly active = new Set<string>(); private readonly idle: Array<() => void> = [];
  private tail: Promise<void> = Promise.resolve();
  private readonly chunksDir: string; private readonly incomingDir: string; private readonly max: number; private readonly maxPuts: number; private readonly staleMs: number;
  private limits: StoreLimits; private gate: (() => GateVerdict) | undefined; private readonly freeFn: () => Promise<number | undefined>; private readonly hooks: StoreHooks | undefined; private readonly clock: () => number;
  private constructor(private readonly root: string, options: StoreOptions) {
    this.chunksDir = join(root, 'chunks'); this.incomingDir = join(root, 'incoming'); this.limits = { ...options.limits }; this.gate = options.gate; this.hooks = options.hooks; this.clock = options.clock ?? Date.now;
    this.max = Math.min(options.maxChunkBytes ?? MAX_CHUNK_BYTES, MAX_CHUNK_BYTES); this.maxPuts = options.maxInFlight ?? MAX_IN_FLIGHT_PUTS; this.staleMs = options.staleIncomingMs ?? DEFAULT_STALE_INCOMING_MS;
    this.freeFn = options.freeBytes ?? (async () => { try { const s = await statfs(this.chunksDir); return Number(s.bavail) * Number(s.bsize); } catch { return undefined; } });
  }

  /** Opens (creating, if needed) the store at `root`: verifies every directory is private and link-free, rebuilds the counters from the files, and sweeps stale partial uploads. */
  static async open(root: string, options: StoreOptions): Promise<ChunkStore> {
    const store = new ChunkStore(root, options);
    await ensureDirectory(root); await ensureDirectory(store.chunksDir); await ensureDirectory(store.incomingDir);
    await store.rescan(); await store.sweepIncoming();
    return store;
  }
  /** Read-only look at a store directory for `status` and `config check`: counts and condition, never creating, sweeping or changing anything. */
  static async inspect(root: string, options: { maxChunkBytes?: number } = {}): Promise<ScanResult> { return scanStore(root, options); }

  setLimits(limits: StoreLimits): void { this.limits = { ...limits }; }
  setGate(gate: (() => GateVerdict) | undefined): void { this.gate = gate; }
  get closed(): boolean { return this.closedFlag; }
  /** Stops accepting puts and waits for the ones in progress to finish. Stored chunks are left exactly as they are. */
  async close(): Promise<void> { this.closedFlag = true; if (this.inFlight > 0) await new Promise<void>(resolve => { this.idle.push(resolve); }); }

  // ---- serialized sections: commit, delete, rescan ----
  private critical<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn); this.tail = run.then(() => undefined, () => undefined); return run;
  }
  private async step(step: PutStep): Promise<void> { await this.hooks?.step?.(step); }
  private async free(): Promise<number | null> { const value = await this.freeFn(); return value === undefined || !Number.isFinite(value) ? null : Math.max(0, value); }

  /** Recounts the committed chunks and leftover partials from the filesystem. The directories are the truth; this is what makes a stale counter harmless. */
  async rescan(): Promise<ScanResult> {
    return this.critical(async () => {
      const scan = await scanStore(this.root, { maxChunkBytes: this.max, staleMs: this.staleMs, clock: this.clock, skipPartials: this.active });
      if (scan.unsafe) throw new StoreError('STORE_UNSAFE');
      this.committedBytes = scan.committedBytes; this.chunkCount = scan.chunkCount; this.orphanBytes = scan.incomingBytes; this.anomalies = scan.anomalies;
      return scan;
    });
  }
  /** Removes partial uploads older than the stale threshold (a crash left them). A put that is running right now is never touched, and a recent file is left alone. */
  async sweepIncoming(olderThanMs: number = this.staleMs): Promise<number> {
    return this.critical(async () => {
      const scan = await scanStore(this.root, { maxChunkBytes: this.max, staleMs: olderThanMs, clock: this.clock, skipPartials: this.active });
      if (scan.unsafe) throw new StoreError('STORE_UNSAFE');
      let removed = 0;
      for (const name of scan.stale) { try { await unlink(join(this.incomingDir, name)); removed++; } catch (error) { if (!isMissing(error)) throw new StoreError('IO'); } }
      const after = await scanStore(this.root, { maxChunkBytes: this.max, staleMs: olderThanMs, clock: this.clock, skipPartials: this.active }); this.orphanBytes = after.incomingBytes;
      return removed;
    });
  }

  async usage(options: { fresh?: boolean } = {}): Promise<StoreUsage> {
    if (options.fresh) await this.rescan();
    const free = await this.free(); const room = this.room(free);
    const flags: string[] = []; if (this.anomalies > 0) flags.push('ANOMALIES'); if (this.integrityFailures > 0) flags.push('INTEGRITY_FAILURES'); if (free === null) flags.push('FREE_SPACE_UNKNOWN'); if (this.closedFlag) flags.push('CLOSED');
    return { committedBytes: this.committedBytes, chunkCount: this.chunkCount, incomingBytes: this.reserved + this.orphanBytes, maxBytes: this.limits.maxBytes, reserveFreeBytes: this.limits.reserveFreeBytes,
      allowedBytes: room, freeBytes: free, anomalies: this.anomalies, integrityFailures: this.integrityFailures, health: flags.length === 0 ? 'OK' : 'DEGRADED', flags };
  }
  /** What can still be accepted: quota room (committed, reserved and leftover partials all count against it) and free disk above the owner's reserve (writes already made are already out of `free`). */
  private parts(free: number | null): { quotaRoom: number; diskRoom: number } {
    const quotaRoom = Math.max(0, this.limits.maxBytes - this.committedBytes - this.reserved - this.orphanBytes);
    if (free === null) return { quotaRoom, diskRoom: 0 };
    const unwritten = Math.max(0, this.reserved - this.writtenInFlight);
    return { quotaRoom, diskRoom: Math.max(0, free - this.limits.reserveFreeBytes - unwritten) };
  }
  private room(free: number | null): number { const { quotaRoom, diskRoom } = this.parts(free); return Math.min(quotaRoom, diskRoom); }

  // ---- put ----
  /**
   * Stores `source` as chunk `id`. Streams (never holds a chunk in memory), counts, hashes and bounds the bytes while writing to an exclusive partial file, verifies the size and the
   * SHA-256, fsyncs, and commits by one atomic rename. Returns `stored: false` when an identical, valid chunk was already there (the retry case): nothing is rewritten or recounted.
   * On any failure the partial file is removed and nothing is committed.
   */
  async put(id: string, source: AsyncIterable<Uint8Array>, declaredSize: number, options: { signal?: AbortSignal; applicationId?: string; beforeCommit?: () => Promise<void>; commitGate?: () => void; onCommitted?: () => void } = {}): Promise<{ stored: boolean; bytes: number }> {
    const hex = chunkDigest(id);
    if (!Number.isSafeInteger(declaredSize) || declaredSize < 1) throw new StoreError('INVALID_SIZE');
    if (declaredSize > this.max) throw new StoreError('TOO_LARGE');
    if (this.closedFlag) throw new StoreError('UNAVAILABLE', 'CLOSED');
    const verdict = this.gate?.(); if (verdict && !verdict.allowed) throw new StoreError('UNAVAILABLE', verdict.reason);
    if (this.inFlight >= this.maxPuts) throw new StoreError('BUSY');
    // Quota and disk, before any byte is read. A chunk that is already stored needs no quota (it adds nothing), but it still needs the disk room for the partial.
    const namespace = applicationChunksDir(this.chunksDir, options.applicationId);
    const final = chunkPath(this.chunksDir, id, options.applicationId);
    const existing = await lstat(final).then(stat => stat, () => undefined);
    const already = existing !== undefined && sound(existing, this.max);
    const free = await this.free();
    // Reserve synchronously after the final asynchronous query: parallel calls must see one another's quota, disk reservation and concurrency usage.
    if (this.closedFlag) throw new StoreError('UNAVAILABLE', 'CLOSED');
    if (this.inFlight >= this.maxPuts) throw new StoreError('BUSY');
    const { quotaRoom, diskRoom } = this.parts(free);
    if ((!already && declaredSize > quotaRoom) || declaredSize > diskRoom) throw new StoreError('STORAGE_FULL');
    this.reserved += declaredSize; this.inFlight++;
    const partialName = `${randomBytes(16).toString('hex')}.part`; const partial = join(this.incomingDir, partialName); this.active.add(partialName);
    let handle: FileHandle | undefined; let written = 0; let committed = false; let lastFreeCheck = 0;
    try {
      await this.step('reserved');
      handle = await open(partial, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW, 0o600);
      await this.step('partial-created');
      const hash = createHash('sha256'); let writes = 0;
      for await (const piece of source) {
        const currentGate = this.gate?.(); if (currentGate && !currentGate.allowed) throw new StoreError('UNAVAILABLE', currentGate.reason);
        if (options.signal?.aborted) throw new StoreError('ABORTED');
        const buf = piece instanceof Buffer ? piece : Buffer.from(piece.buffer, piece.byteOffset, piece.byteLength);
        if (written + buf.length > declaredSize) throw new StoreError('SIZE_MISMATCH');
        hash.update(buf);
        let offset = 0; while (offset < buf.length) { const { bytesWritten } = await handle.write(buf, offset, buf.length - offset); offset += bytesWritten; }
        written += buf.length; this.writtenInFlight += buf.length;
        writes++; await this.step(writes === 1 ? 'first-write' : 'mid-write');
        // The free-space figure is looked at again while writing, not just before: a stale reading must never allow an unbounded write.
        if (written - lastFreeCheck >= 1024 * 1024) { lastFreeCheck = written; const now = await this.free(); if (now === null || now < this.limits.reserveFreeBytes) throw new StoreError('STORAGE_FULL'); }
      }
      if (options.signal?.aborted) throw new StoreError('ABORTED');
      if (written !== declaredSize) throw new StoreError('SIZE_MISMATCH');
      await this.step('stream-complete');
      if (hash.digest('hex') !== hex) throw new StoreError('INTEGRITY');
      await this.step('verified');
      await handle.sync(); await handle.close(); handle = undefined;
      await this.step('synced');
      const outcome = await this.critical(async () => {
        await options.beforeCommit?.();
        const currentGate = this.gate?.(); if (currentGate && !currentGate.allowed) throw new StoreError('UNAVAILABLE', currentGate.reason);
        if (options.signal?.aborted || this.closedFlag) throw new StoreError('ABORTED');
        // Commit: re-check the disk (the partial now really occupies it) and the quota, then one atomic rename.
        const nowFree = await this.free();
        const current = await lstat(final).then(stat => stat, () => undefined);
        if (current !== undefined && (current.isSymbolicLink() || !current.isFile())) throw new StoreError('STORE_UNSAFE');
        const counted = current !== undefined && sound(current, this.max);
        if (nowFree === null || nowFree < this.limits.reserveFreeBytes) throw new StoreError('STORAGE_FULL');
        if (counted && current !== undefined && current.size === declaredSize && await this.matches(final, hex, declaredSize)) {
          options.commitGate?.(); const duplicateGate = this.gate?.();
          if (duplicateGate && !duplicateGate.allowed) throw new StoreError('UNAVAILABLE', duplicateGate.reason);
          if (options.signal?.aborted || this.closedFlag) throw new StoreError('ABORTED');
          return { stored: false };
        }
        const replaced = counted && current !== undefined ? current.size : 0;
        if (this.committedBytes - replaced + this.orphanBytes + this.reserved > this.limits.maxBytes) throw new StoreError('STORAGE_FULL');
        await ensureDirectory(namespace); await ensureDirectory(join(namespace, hex.slice(0, 2))); await ensureDirectory(join(namespace, hex.slice(0, 2), hex.slice(2, 4)));
        await this.syncDirectory(this.chunksDir); await this.syncDirectory(namespace); await this.syncDirectory(join(namespace, hex.slice(0, 2)));
        await this.step('shard-ready');
        options.commitGate?.(); const finalGate = this.gate?.();
        if (finalGate && !finalGate.allowed) throw new StoreError('UNAVAILABLE', finalGate.reason);
        if (options.signal?.aborted || this.closedFlag) throw new StoreError('ABORTED');
        await rename(partial, final); committed = true; options.onCommitted?.();
        // From here the chunk is committed and correct. The counters are updated before anything else can fail, so a failure injected after the rename cannot leave them wrong.
        if (counted && current !== undefined) { this.committedBytes -= current.size; this.chunkCount--; }
        this.committedBytes += declaredSize; this.chunkCount++;
        await this.syncDirectory(join(namespace, hex.slice(0, 2), hex.slice(2, 4)));
        return { stored: true };
      });
      if (outcome.stored) { await this.step('renamed'); await this.step('accounted'); }
      return { stored: outcome.stored, bytes: declaredSize };
    } catch (error) {
      throw mapError(error);
    } finally {
      if (handle) await handle.close().catch(() => undefined);
      if (!committed) await unlink(partial).catch(() => undefined);
      this.active.delete(partialName); this.reserved -= declaredSize; this.writtenInFlight -= written; this.inFlight--;
      if (this.inFlight === 0) for (const resolve of this.idle.splice(0)) resolve();
    }
  }
  async putBuffer(id: string, bytes: Uint8Array): Promise<{ stored: boolean; bytes: number }> { return this.put(id, (async function* () { yield bytes; })(), bytes.length); }

  /** Reads `size` bytes of a committed file and compares its SHA-256 with `hex`. Used to decide whether an existing file is really the chunk it is named. */
  private async matches(path: string, hex: string, size: number): Promise<boolean> {
    let handle: FileHandle | undefined;
    try {
      handle = await open(path, constants.O_RDONLY | O_NOFOLLOW); const stat = await handle.stat(); if (!stat.isFile() || stat.size !== size) return false;
      const hash = createHash('sha256'); const buf = Buffer.allocUnsafe(Math.min(size, 1024 * 1024)); let offset = 0;
      while (offset < size) { const { bytesRead } = await handle.read(buf, 0, Math.min(buf.length, size - offset), offset); if (bytesRead === 0) return false; hash.update(buf.subarray(0, bytesRead)); offset += bytesRead; }
      return hash.digest('hex') === hex;
    } catch { return false; } finally { await handle?.close().catch(() => undefined); }
  }
  /** Flush commit-directory ancestry before recovering a write-ahead transfer intent. */
  async confirmDurability(id: string, applicationId?: string): Promise<void> {
    const hex = chunkDigest(id); const namespace = applicationChunksDir(this.chunksDir, applicationId);
    for (const path of [this.chunksDir, namespace, join(namespace, hex.slice(0, 2)), join(namespace, hex.slice(0, 2), hex.slice(2, 4))]) {
      try { await this.syncDirectory(path); } catch (error) { if (!isMissing(error)) throw error; }
    }
  }
  private async syncDirectory(path: string): Promise<void> {
    if (!posix) return;
    try { const dir = await open(path, constants.O_RDONLY); try { await dir.sync(); } finally { await dir.close(); } } catch (error) { if (isMissing(error)) throw error; throw mapError(error); }
  }

  // ---- get, has, delete ----
  /** True when a sound committed chunk file exists: a regular file (not a link), a plausible size, owner-only. Cheap and filesystem-based; it does not hash (that is `get` and, later, the scrubber). */
  async has(id: string): Promise<boolean> {
    const path = chunkPath(this.chunksDir, id);
    try { const stat = await lstat(path); return sound(stat, this.max); } catch (error) { if (isMissing(error) || (error instanceof Error && 'code' in error && (error as { code?: string }).code === 'ENOTDIR')) return false; throw new StoreError('IO'); }
  }
  /**
   * Opens a committed chunk for reading. The whole file is verified against its identifier **before** any byte is returned: a chunk that does not hash to its name is never served.
   * A file that fails is removed (it is not what its name says; the correct bytes can simply be stored again) and reported once as INTEGRITY, after which it is NOT_FOUND.
   */
  async get(id: string, applicationId?: string): Promise<{ size: number; stream: Readable }> {
    const hex = chunkDigest(id); const path = chunkPath(this.chunksDir, id, applicationId);
    let stat: Stats; try { stat = await lstat(path); } catch (error) { if (isMissing(error)) throw new StoreError('NOT_FOUND'); throw new StoreError('IO'); }
    if (stat.isSymbolicLink() || !stat.isFile()) throw new StoreError('STORE_UNSAFE');
    if (posix && ((stat.mode & 0o077) !== 0 || stat.uid !== uid())) throw new StoreError('STORE_UNSAFE');
    if (stat.size < 1 || stat.size > this.max) throw new StoreError('INTEGRITY');
    let handle: FileHandle | undefined;
    try {
      handle = await open(path, constants.O_RDONLY | O_NOFOLLOW); const opened = await handle.stat();
      if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev) throw new StoreError('STORE_UNSAFE');
      const hash = createHash('sha256'); const buf = Buffer.allocUnsafe(Math.min(opened.size, 1024 * 1024)); let offset = 0;
      while (offset < opened.size) { const { bytesRead } = await handle.read(buf, 0, Math.min(buf.length, opened.size - offset), offset); if (bytesRead === 0) break; hash.update(buf.subarray(0, bytesRead)); offset += bytesRead; }
      if (offset !== opened.size || hash.digest('hex') !== hex) {
        await handle.close().catch(() => undefined); handle = undefined;
        this.integrityFailures++; await this.removeCommitted(path);
        throw new StoreError('INTEGRITY');
      }
      const stream = handle.createReadStream({ start: 0, autoClose: true }); handle = undefined;
      return { size: opened.size, stream };
    } catch (error) { throw mapError(error); } finally { await handle?.close().catch(() => undefined); }
  }
  async getBuffer(id: string): Promise<Buffer> {
    const { stream } = await this.get(id); const parts: Buffer[] = [];
    for await (const part of stream) parts.push(part as Buffer);
    return Buffer.concat(parts);
  }
  /** Removes a committed chunk. Idempotent: an absent chunk is success. Never touches a link or anything that is not a regular file. */
  async delete(id: string, applicationId?: string, options: { beforeCommit?: () => Promise<void>; commitGate?: () => void; onCommitted?: () => void } = {}): Promise<{ deleted: boolean }> {
    chunkDigest(id); const path = chunkPath(this.chunksDir, id, applicationId);
    return this.critical(async () => {
      await options.beforeCommit?.();
      let stat: Stats; try { stat = await lstat(path); } catch (error) { if (isMissing(error)) { options.commitGate?.(); return { deleted: false }; } throw new StoreError('IO'); }
      if (stat.isSymbolicLink() || !stat.isFile()) throw new StoreError('STORE_UNSAFE');
      const counted = sound(stat, this.max);
      options.commitGate?.();
      try { await unlink(path); } catch (error) { if (isMissing(error)) { options.commitGate?.(); return { deleted: false }; } throw mapError(error); }
      options.onCommitted?.();
      if (counted) { this.committedBytes = Math.max(0, this.committedBytes - stat.size); this.chunkCount = Math.max(0, this.chunkCount - 1); }
      await this.syncDirectory(dirname(path));
      return { deleted: true };
    });
  }
  private async removeCommitted(path: string): Promise<void> {
    await this.critical(async () => {
      let stat: Stats; try { stat = await lstat(path); } catch { return; }
      if (stat.isSymbolicLink() || !stat.isFile()) return;
      const counted = sound(stat, this.max);
      try { await unlink(path); } catch { return; }
      if (counted) { this.committedBytes = Math.max(0, this.committedBytes - stat.size); this.chunkCount = Math.max(0, this.chunkCount - 1); }
    });
  }
}
