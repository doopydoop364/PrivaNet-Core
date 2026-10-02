import { defaultResourcePolicy } from '../resource-policy.js';
import type { ResourcePolicy } from '../resource-policy.js';
import { ChunkStore } from './chunk-store.js';
import type { StoreOptions } from './chunk-store.js';
import { storageGate } from './gate.js';
import type { GateInputs } from './gate.js';
import { StoreError } from './errors.js';
import { emptyStorageStatus, storeRoot } from './status.js';
import type { StorageStatus } from './status.js';

/**
 * Owns the node's local chunk store while the node runs: opens it when the owner's policy enables storage (verifying the directory, recovering from a crash), applies quota and reserve
 * changes live, closes it when storage is disabled or the node stops, and keeps a cached status for the panel, `status` and the support bundle. In this version nothing calls the
 * store: there is no network or Coordinator interface, so the store can only be used by code inside this process, and enabling it opens no port and advertises nothing.
 */
export interface StorageServiceOptions {
  stateDir: string; policy: () => ResourcePolicy; inputs: Omit<GateInputs, 'enabled'>;
  log?: ((entry: { event: string; code?: string; reason?: string }) => void) | undefined; refreshMs?: number; storeOptions?: Partial<StoreOptions>;
}
export class StorageService {
  private store: ChunkStore | undefined; private cached: StorageStatus; private timer: NodeJS.Timeout | undefined; private openError: string | null = null; private busy: Promise<void> = Promise.resolve();
  constructor(private readonly options: StorageServiceOptions) { this.cached = emptyStorageStatus(defaultResourcePolicy().storage); }

  /** Opens the store if storage is enabled. A store that cannot be opened safely is reported (and logged by code), never repaired by guesswork, and never stops the node. */
  async start(): Promise<void> { await this.apply(this.options.policy()); this.timer = setInterval(() => { void this.refresh().catch(() => undefined); }, this.options.refreshMs ?? 10000); this.timer.unref(); }
  async stop(): Promise<void> { if (this.timer) clearInterval(this.timer); await this.serialized(async () => { await this.store?.close().catch(() => undefined); this.store = undefined; }); }
  /** The status as of the last refresh (cheap, synchronous). */
  get status(): StorageStatus { return this.cached; }
  /** The open store, for in-process callers (none yet); undefined while storage is disabled or the store could not be opened. */
  get chunkStore(): ChunkStore | undefined { return this.store; }

  private serialized(fn: () => Promise<void>): Promise<void> { const run = this.busy.then(fn, fn); this.busy = run.then(() => undefined, () => undefined); return run; }
  /** Applies the owner's current policy: opens, closes or re-limits the store. Safe to call on every policy change. */
  apply(policy: ResourcePolicy): Promise<void> {
    return this.serialized(async () => {
      const wanted = policy.storage;
      if (!wanted.enabled) { if (this.store) { await this.store.close().catch(() => undefined); this.store = undefined; this.options.log?.({ event: 'storage.closed' }); } this.openError = null; }
      else if (!this.store) {
        try {
          this.store = await ChunkStore.open(storeRoot(this.options.stateDir), { limits: { maxBytes: wanted.maxBytes, reserveFreeBytes: wanted.reserveFreeBytes }, gate: storageGate({ ...this.options.inputs, enabled: () => this.options.policy().storage.enabled }), ...this.options.storeOptions });
          this.openError = null; this.options.log?.({ event: 'storage.opened' });
        } catch (error) { this.openError = error instanceof StoreError ? error.code : 'IO'; this.options.log?.({ event: 'storage.unavailable', code: this.openError }); }
      } else this.store.setLimits({ maxBytes: wanted.maxBytes, reserveFreeBytes: wanted.reserveFreeBytes });
      await this.refreshNow(policy);
    });
  }
  async refresh(): Promise<StorageStatus> { await this.serialized(() => this.refreshNow(this.options.policy())); return this.cached; }
  private async refreshNow(policy: ResourcePolicy): Promise<void> {
    const wanted = policy.storage; const base = emptyStorageStatus(wanted);
    if (!wanted.enabled) { this.cached = base; return; }
    if (!this.store) { this.cached = { ...base, state: 'ERROR', error: this.openError ?? 'IO', health: 'UNSAFE', flags: ['UNAVAILABLE'] }; return; }
    try {
      const usage = await this.store.usage(); const gate = storageGate({ ...this.options.inputs, enabled: () => true })();
      this.cached = { ...base, state: gate.allowed ? 'READY' : 'UNAVAILABLE', reasons: gate.allowed ? [] : [gate.reason], committedBytes: usage.committedBytes, chunkCount: usage.chunkCount, incomingBytes: usage.incomingBytes,
        allowedBytes: usage.allowedBytes, freeBytes: usage.freeBytes, anomalies: usage.anomalies, integrityFailures: usage.integrityFailures, health: usage.health, flags: usage.flags };
    } catch (error) { this.cached = { ...base, state: 'ERROR', error: error instanceof StoreError ? error.code : 'IO', health: 'UNSAFE', flags: ['UNREADABLE'] }; }
  }
}
