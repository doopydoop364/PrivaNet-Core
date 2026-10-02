import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { PROTOCOL_VERSION, SERVICE_VERSION } from '@privanet/protocol';
import type { JobType, ServiceId, ServicesAdvertisement, StorageAdvertisement } from '@privanet/protocol';
import { ApiError, generateHolderKey, verifyTicket } from '@privanet/shared';
import type { TicketClaims, TicketVerdict } from '@privanet/shared';
import { Coordinator } from '@privanet/coordinator/service';
import type { Policy } from '@privanet/coordinator/service';
import { SqliteStore } from '@privanet/coordinator/store';
import { TransferKeyring } from '@privanet/coordinator/transfer-keys';
import type { StorageLimits } from '@privanet/coordinator/storage';
import type { ApplicationRecord } from '@privanet/coordinator/model';
import { identity } from './helpers.js';

export const MIB = 1024 * 1024; export const GIB = 1024 * MIB;
/** A chunk id for some bytes, as an application would compute it. */
export const chunkIdOf = (bytes: Buffer | string): string => `chk_${createHash('sha256').update(bytes).digest('hex')}`;
export const sha256Of = (id: string): string => id.slice(4);
export const advert = (freeBytes = 10 * GIB, extra: Partial<StorageAdvertisement> = {}): StorageAdvertisement => ({ capacityBytes: Math.max(freeBytes, 10 * GIB), freeBytes, maxChunkBytes: 8 * MIB, ...extra });
/** Runs a service call and returns the ApiError it threw (or fails the test). */
export function refusal(operation: () => unknown): { status: number; code: string; message: string } {
  try { operation(); } catch (error) { if (error instanceof ApiError) return { status: error.status, code: error.code, message: error.message }; throw error; }
  throw new Error('expected a refusal');
}

export interface RigOptions { limits?: Partial<StorageLimits>; random?: () => number; policy?: Partial<Policy>; dbFile?: boolean; keyring?: boolean; dir?: string }
/** A Coordinator with storage on, a clock the test controls, a real keyring file and helpers to add applications and storage nodes. */
export async function storageRig(t: TestContext, options: RigOptions = {}) {
  const dir = options.dir ?? await mkdtemp(join(tmpdir(), 'privanet-storage-'));
  const clock = { t: 1_800_000_000_000 }; const now = () => clock.t;
  const dbPath = options.dbFile ? join(dir, 'coordinator.sqlite') : ':memory:';
  let store = new SqliteStore(dbPath);
  const keyring = options.keyring === false ? undefined : await TransferKeyring.open(dir, now);
  const policy: Partial<Policy> = { staleMs: 15000, offlineMs: 60000, sessionMs: 3_600_000, challengeMs: 60000, ...options.policy };
  const build = (s: SqliteStore, ring: TransferKeyring | undefined) => new Coordinator(s, policy, now, undefined, { ...(ring ? { transferKeys: ring } : {}), ...(options.limits ? { storageLimits: options.limits } : {}), ...(options.random ? { storageRandom: options.random } : {}) });
  let core = build(store, keyring);
  let closed = false; const safeClose = (s: SqliteStore) => { try { s.close(); } catch { /* already closed by the test */ } };
  const cleanup = async () => { if (!closed) { closed = true; safeClose(store); } if (!options.dir) await rm(dir, { recursive: true, force: true }); };
  t.after(cleanup);
  const rig = {
    dir, clock, get core() { return core; }, get store() { return store; }, keyring,
    advance(ms: number) { clock.t += ms; },
    /** Reopens the database file and builds a fresh Coordinator over it (a restart). Only for rigs created with `dbFile`. */
    async restart(ring: TransferKeyring | undefined = keyring) { safeClose(store); store = new SqliteStore(dbPath); core = build(store, ring); return core; },
    app(services: ServiceId[] = ['storage.chunk.v1'], jobTypes: JobType[] = ['web.fetch.v1']): { record: ApplicationRecord; token: string } {
      const created = core.createApplication({ name: `app-${randomUUID().slice(0, 8)}`, allowedJobTypes: jobTypes, ...(services.length > 0 ? { allowedServices: services } : {}), fetchIdentity: { product: 'TestBot', infoUrl: 'https://example.com/bot' } });
      return { record: core.authenticateApplication(created.token), token: created.token };
    },
    /** An enrolled node that reports `free` bytes of storage (or none, with `null`) and keeps heartbeating when asked. */
    node(free: number | null = 10 * GIB, extra: { advert?: Partial<StorageAdvertisement>; resources?: unknown } = {}) {
      const key = identity(); const grant = core.createEnrollment({ expiresInMs: 60000, capabilities: ['system.echo.v1'] });
      const challenge = core.beginEnrollment({ token: grant.token, publicKey: key.publicKey, protocolVersion: 1, daemonVersion: '0.4.0', capabilities: ['system.echo.v1'] });
      const session = core.prove(key.proof(challenge), 'enroll');
      const node = { nodeId: session.nodeId, token: session.token,
        heartbeat(services: ServicesAdvertisement | null | undefined | { free: number | null } = undefined, more: Record<string, unknown> = {}) {
          const advertised: ServicesAdvertisement | undefined = services === undefined ? (free === null ? undefined : { 'storage.chunk.v1': advert(free, extra.advert) }) : services === null ? undefined : 'free' in services ? (services.free === null ? undefined : { 'storage.chunk.v1': advert(services.free, extra.advert) }) : services;
          core.heartbeat(session.nodeId, { protocolVersion: PROTOCOL_VERSION, daemonVersion: SERVICE_VERSION, capabilities: ['system.echo.v1'], jobSlots: 1, currentJobs: 0, ...(extra.resources ? { resources: extra.resources } : {}), ...(advertised ? { services: advertised } : {}), ...more });
        } };
      node.heartbeat(); return node;
    },
    /** What a node would do with a grant: verify it offline against the keys the Coordinator publishes. */
    verify(ticket: string, nodeId: string, expect: Partial<{ operation: TicketClaims['operation']; chunkId: string; applicationId: string; size: number }> = {}, at = clock.t): TicketVerdict {
      return verifyTicket(ticket, { keys: core.storage.transferKeys(core.store.coordinatorId).keys, now: at, expect: { nodeId, ...expect } });
    },
    holder: generateHolderKey,
    /** A fresh chunk: some bytes, its id and size. */
    chunk(size = 1000) { const bytes = randomBytes(size); return { bytes, id: chunkIdOf(bytes), size }; },
    receipt(transferId: string, applicationId: string, chunkId: string, nodeId: string, extra: Record<string, unknown> = {}, operation: 'put' | 'delete' = 'put', bytes = 1000) {
      return { transferId, operation, applicationId, chunkId, bytes, sha256: sha256Of(chunkId), nodeId, completedAt: clock.t, ...extra };
    },
  };
  return rig;
}
export type StorageRig = Awaited<ReturnType<typeof storageRig>>;
