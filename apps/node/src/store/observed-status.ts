import { join } from 'node:path';
import { z } from 'zod';
import { readPrivateFileUpTo } from '@privanet/shared';
import { STATUS_FILE, STATUS_STALE_MS, StatusFileSchema } from '../status-file.js';
import type { ResourcePolicy } from '../resource-policy.js';
import { inspectStorage } from './status.js';
import type { StorageStatus } from './status.js';
import { transferConfig } from './transfer-config.js';
const n = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const TransferSnapshot = z.object({ listener: z.enum(['DISABLED', 'STARTING', 'LISTENING', 'STOPPED', 'FAILED', 'UNKNOWN']), advertised: z.boolean(), error: z.string().max(64).nullable(), configured: z.boolean(), bindAddress: z.string().max(64).nullable(), port: n.nullable(), endpoint: z.string().max(512).nullable(),
  coordinatorAdvertisement: z.enum(['ACCEPTED', 'PENDING', 'REJECTED', 'UNSUPPORTED', 'UNREACHABLE', 'UNKNOWN', 'WITHDRAWN']), acceptedAt: n.nullable(), remoteReachability: z.literal('UNKNOWN'),
  active: z.object({ put: n, get: n, delete: n }), completed: n, failed: n, bytes: n, failures: z.record(z.string().max(64), n), queuedReceipts: n, lastReceiptAckAt: n.nullable(), throughputBytesPerSec: z.number().min(0) });
const StorageSnapshot = z.object({ enabled: z.boolean(), state: z.enum(['DISABLED', 'READY', 'UNAVAILABLE', 'ERROR']), reasons: z.array(z.string().max(64)).max(64), error: z.string().max(64).nullable(), maxBytes: n, reserveFreeBytes: n, unwrittenReservedBytes: n.optional(), committedBytes: n, chunkCount: n, incomingBytes: n, allowedBytes: n, freeBytes: n.nullable(), anomalies: n, integrityFailures: n, health: z.enum(['OK', 'DEGRADED', 'UNSAFE', 'DISABLED']), flags: z.array(z.string().max(64)).max(64), networkAccessible: z.null(), maxChunkBytes: n, transfer: TransferSnapshot.optional() });
/** A recent daemon snapshot is the authority for live state and its service environment. Offline inspection cannot infer a listener. */
export async function observedStorage(stateDir: string, policy: ResourcePolicy, env: NodeJS.ProcessEnv, now = Date.now()): Promise<StorageStatus> {
  try {
    const file = StatusFileSchema.parse(JSON.parse(await readPrivateFileUpTo(join(stateDir, STATUS_FILE), 262144)));
    if (file.publishedAt <= now && now - file.publishedAt <= STATUS_STALE_MS) {
      const parsed = StorageSnapshot.parse(file.status.storage);
      const { unwrittenReservedBytes, ...rest } = parsed;
      const storage = { ...rest, ...(unwrittenReservedBytes !== undefined ? { unwrittenReservedBytes } : {}) };
      return { ...storage, observation: { source: 'daemon', publishedAt: file.publishedAt } };
    }
  } catch { /* absence, old alpha.3 shape or invalid status is never evidence of live listener state */ }
  const status = await inspectStorage(stateDir, policy.storage);
  let config; try { config = transferConfig(policy, env); } catch { /* reported separately by configuration diagnostics */ }
  return { ...status, observation: { source: 'offline', publishedAt: null }, transfer: { listener: config?.enabled && policy.storage.enabled ? 'UNKNOWN' : 'DISABLED', configured: config?.enabled ?? false,
    bindAddress: config?.bindAddress ?? null, port: config?.port ?? null, endpoint: config?.endpoint || null, advertised: false, coordinatorAdvertisement: 'UNKNOWN', acceptedAt: null, remoteReachability: 'UNKNOWN', error: null,
    active: { put: 0, get: 0, delete: 0 }, completed: 0, failed: 0, bytes: 0, failures: {}, queuedReceipts: 0, lastReceiptAckAt: null, throughputBytesPerSec: 0 } };
}
