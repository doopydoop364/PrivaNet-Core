import { statfs } from 'node:fs/promises';
import { join } from 'node:path';
import type { ResourcePolicy } from '../resource-policy.js';
import { ChunkStore } from './chunk-store.js';
import type { ScanResult } from './chunk-store.js';
import { StoreError } from './errors.js';
import type { TransferStatus } from './transfer-service.js';

/** The directory of the local chunk store inside a node's state directory. */
export const storeRoot = (stateDir: string): string => join(stateDir, 'store');

/**
 * What the owner, `config check`, the panel and the support bundle may be told about the store: switches, limits, counts and a health word. Never a path, never an inventory of chunk
 * IDs, never any content. `networkAccessible` is always false in this version: there is no storage listener and no remote API.
 */
export interface StorageStatus {
  enabled: boolean;
  /** DISABLED, READY (a put would be accepted), UNAVAILABLE (enabled but a node state forbids writes right now: see `reasons`), or ERROR (the store could not be opened safely). */
  state: 'DISABLED' | 'READY' | 'UNAVAILABLE' | 'ERROR';
  reasons: string[]; error: string | null;
  maxBytes: number; reserveFreeBytes: number;
  committedBytes: number; chunkCount: number; incomingBytes: number; allowedBytes: number; freeBytes: number | null;
  anomalies: number; integrityFailures: number; health: 'OK' | 'DEGRADED' | 'UNSAFE' | 'DISABLED'; flags: string[];
  networkAccessible: boolean; maxChunkBytes: number; transfer?: TransferStatus;
}
export const emptyStorageStatus = (policy: ResourcePolicy['storage']): StorageStatus => ({ enabled: policy.enabled, state: policy.enabled ? 'READY' : 'DISABLED', reasons: [], error: null, maxBytes: policy.maxBytes, reserveFreeBytes: policy.reserveFreeBytes,
  committedBytes: 0, chunkCount: 0, incomingBytes: 0, allowedBytes: 0, freeBytes: null, anomalies: 0, integrityFailures: 0, health: policy.enabled ? 'OK' : 'DISABLED', flags: [], networkAccessible: false, maxChunkBytes: 8 * 1024 * 1024 });

/** A read-only look at the store on disk for a process that does not own it (`privanet-node storage status`, `config check`, the bundle). Creates and changes nothing. */
export async function inspectStorage(stateDir: string, policy: ResourcePolicy['storage']): Promise<StorageStatus> {
  const base = emptyStorageStatus(policy); const root = storeRoot(stateDir);
  let scan: ScanResult;
  try { scan = await ChunkStore.inspect(root); } catch (error) { return { ...base, state: 'ERROR', error: error instanceof StoreError ? error.code : 'IO', health: 'UNSAFE', flags: ['UNREADABLE'] }; }
  let freeBytes: number | null = null; try { const s = await statfs(stateDir); freeBytes = Number(s.bavail) * Number(s.bsize); } catch { /* unknown */ }
  const flags: string[] = []; if (scan.unsafe) flags.push('UNSAFE'); if (scan.anomalies > 0) flags.push('ANOMALIES'); if (policy.enabled && freeBytes === null) flags.push('FREE_SPACE_UNKNOWN');
  const quotaRoom = Math.max(0, policy.maxBytes - scan.committedBytes - scan.incomingBytes); const diskRoom = freeBytes === null ? 0 : Math.max(0, freeBytes - policy.reserveFreeBytes);
  const health = scan.unsafe ? 'UNSAFE' : !policy.enabled ? 'DISABLED' : flags.length > 0 ? 'DEGRADED' : 'OK';
  return { ...base, state: scan.unsafe ? 'ERROR' : base.state, error: scan.unsafe ? 'STORE_UNSAFE' : null, committedBytes: scan.committedBytes, chunkCount: scan.chunkCount, incomingBytes: scan.incomingBytes,
    allowedBytes: policy.enabled && !scan.unsafe ? Math.min(quotaRoom, diskRoom) : 0, freeBytes, anomalies: scan.anomalies, health, flags };
}
