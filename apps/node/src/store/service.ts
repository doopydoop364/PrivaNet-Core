import type { StorageAdvertisement } from '@privanet/protocol';
import { defaultResourcePolicy } from '../resource-policy.js';
import type { ResourcePolicy } from '../resource-policy.js';
import { ChunkStore } from './chunk-store.js';
import type { StoreOptions } from './chunk-store.js';
import { storageGate } from './gate.js';
import type { GateInputs } from './gate.js';
import { StoreError } from './errors.js';
import { MAX_CHUNK_BYTES } from './limits.js';
import { emptyStorageStatus, storeRoot } from './status.js';
import type { StorageStatus } from './status.js';

/**
 * Owns the node's local chunk store while the node runs: opens it when the owner's policy enables storage (verifying the directory, recovering from a crash), applies quota and reserve
 * changes live, closes it when storage is disabled or the node stops, and keeps a cached status for the panel, `status` and the support bundle. The store has no network interface: enabling it opens no port, and
 * nothing can send it a chunk yet. What the node tells the Coordinator about it is `advertisement()` below (room only, never a path or an inventory).
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

  /**
   * What this node offers the Coordinator right now (the heartbeat's `services['storage.chunk.v1']`), or undefined, which means "not offered". It is computed from the real store and the real
   * policy, not copied from a switch: a node advertises only while the owner has enabled storage, the store opened safely, the node's own state would accept a write this instant (the same gate
   * as `put`: not draining, not paused by the owner or by pressure, inside its schedule, no battery or disk-busy rule) and the store is healthy enough to take one (free space is known, nothing
   * unsafe). Capacity is what the owner allows, free space is what a put would be allowed right now (quota and reserve already subtracted), and both are hints that the node re-checks at every
   * transfer. The moment any condition fails the next heartbeat omits the service and the Coordinator stops placing on this node.
   */
  advertisement(): StorageAdvertisement | undefined {
    const policy = this.options.policy().storage; const status = this.cached;
    if (!policy.enabled || !this.store || status.state === 'ERROR' || status.health === 'UNSAFE') return undefined;
    const { engine } = this.options.inputs;
    if (engine.report.contribution === 'PAUSED') return undefined;
    if (!storageGate({ ...this.options.inputs, enabled: () => policy.enabled })().allowed) return undefined;
    if (status.flags.includes('FREE_SPACE_UNKNOWN') || status.flags.includes('UNREADABLE') || status.flags.includes('CLOSED') || status.freeBytes === null) return undefined;
    const freeBytes = Math.min(status.allowedBytes, policy.maxBytes); if (!(freeBytes >= 1)) return undefined;
    return { capacityBytes: Math.min(policy.maxBytes, 2 ** 50), freeBytes: Math.min(Math.floor(freeBytes), 2 ** 50), maxChunkBytes: MAX_CHUNK_BYTES };
  }
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
