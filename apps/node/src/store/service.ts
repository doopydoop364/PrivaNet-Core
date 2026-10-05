import type { StorageAdvertisement } from '@privanet/protocol';
import { defaultResourcePolicy } from '../resource-policy.js';
import type { ResourcePolicy } from '../resource-policy.js';
import { ChunkStore } from './chunk-store.js';
import type { StoreOptions } from './chunk-store.js';
import { storageGate } from './gate.js';
import type { GateInputs } from './gate.js';
import { StoreError } from './errors.js';
import { MAX_CHUNK_BYTES } from './limits.js';
import { emptyStorageStatus, storeRoot, withCapacityPlan, inspectStorage } from './status.js';
import type { StorageStatus } from './status.js';
import type { PrivaNode } from '../daemon.js';
import type { TransferMeter } from '../transfer-meter.js';
import { TransferService } from './transfer-service.js';
import { transferConfig } from './transfer-config.js';

/**
 * Owns the node's local chunk store while the node runs: opens it when the owner's policy enables storage (verifying the directory, recovering from a crash), applies quota and reserve
 * changes live, closes it when storage is disabled or the node stops, and keeps cached owner status. Storage capacity alone opens no port; an explicitly enabled TLS transfer service uses this same store. Advertisements contain capacity and the live transfer identity, never a filesystem path or inventory.
 */
export interface StorageServiceOptions {
  stateDir: string; policy: () => ResourcePolicy; inputs: Omit<GateInputs, 'enabled'>;
  log?: ((entry: { event: string; code?: string; reason?: string }) => void) | undefined; refreshMs?: number; storeOptions?: Partial<StoreOptions>;
  direct?: { node: PrivaNode; meter: TransferMeter; env?: NodeJS.ProcessEnv; timeoutMs?: number; idleMs?: number };
}
export class StorageService {
  private store: ChunkStore | undefined; private cached: StorageStatus; private timer: NodeJS.Timeout | undefined; private openError: string | null = null; private busy: Promise<void> = Promise.resolve();
  private readonly direct: TransferService | undefined;
  constructor(private readonly options: StorageServiceOptions) {
    this.cached = emptyStorageStatus(defaultResourcePolicy().storage);
    if (options.direct) this.direct = new TransferService({ stateDir: options.stateDir, node: options.direct.node, meter: options.direct.meter,
      ...(options.direct.timeoutMs ? { timeoutMs: options.direct.timeoutMs } : {}), ...(options.direct.idleMs ? { idleMs: options.direct.idleMs } : {}),
      store: () => this.store, gate: () => storageGate({ ...options.inputs, enabled: () => options.policy().storage.enabled })(),
      config: () => transferConfig(options.policy(), options.direct?.env), ...(options.log ? { log: options.log } : {}) });
  }

  /** Opens the store if storage is enabled. A store that cannot be opened safely is reported (and logged by code), never repaired by guesswork, and never stops the node. */
  async start(): Promise<void> { await this.apply(this.options.policy()); this.timer = setInterval(() => { void this.refresh().catch(() => undefined); }, this.options.refreshMs ?? 10000); this.timer.unref(); }
  async stop(): Promise<void> { if (this.timer) clearInterval(this.timer); await this.serialized(async () => { try { await this.direct?.stop(); } finally { await this.store?.close().catch(() => undefined); this.store = undefined; } }); }
  /** The status as of the last refresh (cheap, synchronous). */
  get status(): StorageStatus { return withCapacityPlan({ ...this.cached, networkAccessible: null, observation: { source: 'daemon', publishedAt: Date.now() }, ...(this.direct ? { transfer: this.direct.status } : {}) }); }
  /** The open store, used by the authorized transfer service; undefined while storage is disabled or the store could not be opened. */
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
    if (this.direct?.status.listener === 'FAILED') return undefined;
    const endpoint = this.direct?.advertisement;
    const freeBytes = Math.min(status.allowedBytes, policy.maxBytes); if (!(freeBytes >= 1) && !endpoint) return undefined;
    return { capacityBytes: Math.min(policy.maxBytes, 2 ** 50), freeBytes: Math.min(Math.floor(freeBytes), 2 ** 50), maxChunkBytes: MAX_CHUNK_BYTES, ...(endpoint ? { transferEndpoint: endpoint } : {}) };
  }
  private serialized(fn: () => Promise<void>): Promise<void> { const run = this.busy.then(fn, fn); this.busy = run.then(() => undefined, () => undefined); return run; }
  /** Applies the owner's current policy: opens, closes or re-limits the store. Safe to call on every policy change. */
  apply(policy: ResourcePolicy): Promise<void> {
    return this.serialized(async () => {
      const wanted = policy.storage;
      if (!wanted.enabled) await this.direct?.apply(false);
      if (!wanted.enabled) { if (this.store) { await this.store.close().catch(() => undefined); this.store = undefined; this.options.log?.({ event: 'storage.closed' }); } this.openError = null; }
      else if (!this.store) {
        try {
          this.store = await ChunkStore.open(storeRoot(this.options.stateDir), { limits: { maxBytes: wanted.maxBytes, reserveFreeBytes: wanted.reserveFreeBytes }, gate: storageGate({ ...this.options.inputs, enabled: () => this.options.policy().storage.enabled }), ...this.options.storeOptions });
          this.openError = null; this.options.log?.({ event: 'storage.opened' });
        } catch (error) { this.openError = error instanceof StoreError ? error.code : 'IO'; this.options.log?.({ event: 'storage.unavailable', code: this.openError }); }
      } else this.store.setLimits({ maxBytes: wanted.maxBytes, reserveFreeBytes: wanted.reserveFreeBytes });
      await this.refreshNow(policy);
      if (wanted.enabled) await this.direct?.apply(this.store !== undefined);
    });
  }
  async refresh(): Promise<StorageStatus> { await this.serialized(() => this.refreshNow(this.options.policy())); return this.status; }
  private async refreshNow(policy: ResourcePolicy): Promise<void> {
    const wanted = policy.storage; const base = emptyStorageStatus(wanted);
    if (!wanted.enabled) { this.cached = await inspectStorage(this.options.stateDir, wanted); return; }
    if (!this.store) { this.cached = { ...base, state: 'ERROR', error: this.openError ?? 'IO', health: 'UNSAFE', flags: ['UNAVAILABLE'] }; return; }
    try {
      const usage = await this.store.usage(); const gate = storageGate({ ...this.options.inputs, enabled: () => true })();
      this.cached = { ...base, state: gate.allowed ? 'READY' : 'UNAVAILABLE', reasons: gate.allowed ? [] : [gate.reason], committedBytes: usage.committedBytes, chunkCount: usage.chunkCount, incomingBytes: usage.incomingBytes,
        allowedBytes: gate.allowed ? usage.allowedBytes : 0, unwrittenReservedBytes: usage.unwrittenReservedBytes, freeBytes: usage.freeBytes, anomalies: usage.anomalies, integrityFailures: usage.integrityFailures, health: usage.health, flags: usage.flags };
    } catch (error) { this.cached = { ...base, state: 'ERROR', error: error instanceof StoreError ? error.code : 'IO', health: 'UNSAFE', flags: ['UNREADABLE'] }; }
  }
}
