import { createHash, randomBytes } from 'node:crypto';
import {
  PlacementRequestSchema, SERVICES, TICKET_MAX_LIFETIME_MS, TICKET_MAX_SKEW_MS, TicketRequestSchema, TransferReceiptSchema,
} from '@privanet/protocol';
import type { ChunkStatus, NodeView, PlacementResponse, ServicesAdvertisement, StorageSummary, TicketResponse, TransferGrant, TransferState } from '@privanet/protocol';
import { ApiError, canonicalPublicKey, signTicket } from '@privanet/shared';
import type { ApplicationRecord, ChunkRecord, NodeRecord, ReplicaRecord, Store, TransferRecord } from './model.js';
import type { TransferKeyring } from './transfer-keys.js';

/**
 * The Coordinator's storage control plane (Phase 4.0-alpha.2). It decides who may store, fetch or delete which chunk on which node, signs a short-lived, holder-bound ticket for it, and records
 * the state of every authorization. It never sees, stores or relays chunk bytes, has no endpoint to send them to, and does not know whether a byte was ever sent: a chunk becomes STORED only on
 * a node's receipt (see `complete`), never on an application's say-so, and a ticket is permission to ATTEMPT a transfer, never permission to override the node owner's own quota and policy.
 *
 * State lives in SQLite (migration 2). Every public method that changes state runs in one store transaction, which is a single writer: concurrent placements are serialized, so reservations
 * can never over-commit what the nodes reported.
 */
export interface StorageLimits {
  /** Logical bytes (PENDING + STORED + DELETING) one application may hold in this Coordinator's metadata. */
  maxBytesPerApplication: number; maxChunksPerApplication: number;
  /** Open (AUTHORIZED or IN_PROGRESS) transfers one application may hold, and per node (puts are bounded separately by the node's own in-flight limit). */
  maxOpenTransfersPerApplication: number; maxOpenTransfersPerNode: number; maxOpenPutsPerNode: number;
  /** Tickets one application may be issued per minute. */
  ticketsPerMinute: number;
}
export const defaultStorageLimits: StorageLimits = { maxBytesPerApplication: 256 * 1024 ** 3, maxChunksPerApplication: 100_000, maxOpenTransfersPerApplication: 256, maxOpenTransfersPerNode: 64, maxOpenPutsPerNode: 8, ticketsPerMinute: 120 };
/** An IN_PROGRESS transfer may outlive its ticket (it began in time); it is failed this long after the ticket's expiry if the node has not finished. */
export const TRANSFER_PROGRESS_GRACE_MS = 10 * 60 * 1000;
/** A PENDING chunk that nothing has touched for this long, with no open transfer, is withdrawn (its reservation released). */
export const PENDING_CHUNK_TTL_MS = 15 * 60 * 1000;
/** Finished transfers are kept this long as the audit trail, then deleted: an application cannot grow this table without bound. */
export const TRANSFER_RETENTION_MS = 7 * 24 * 3600 * 1000;
export const STORAGE_SWEEP_MS = 10_000;
const SERVICE = 'storage.chunk.v1' as const;
function reject(status: number, code: string): never { throw new ApiError(status, code, code.replaceAll('_', ' ').toLowerCase()); }

/** The only legal moves of a transfer. Everything else is refused (never coerced). EXPIRED is reachable only from AUTHORIZED: a transfer the node had accepted fails or completes, it does not "expire". */
export const TRANSFER_TRANSITIONS: Readonly<Record<TransferState, readonly TransferState[]>> = Object.freeze({
  AUTHORIZED: ['IN_PROGRESS', 'COMPLETED', 'FAILED', 'EXPIRED', 'REVOKED'], IN_PROGRESS: ['COMPLETED', 'FAILED', 'REVOKED'],
  COMPLETED: [], FAILED: [], EXPIRED: [], REVOKED: [],
});
export const FINAL_TRANSFER_STATES: readonly TransferState[] = ['COMPLETED', 'FAILED', 'EXPIRED', 'REVOKED'];
export const canTransition = (from: TransferState, to: TransferState): boolean => TRANSFER_TRANSITIONS[from].includes(to);
export const FAILURE_REASONS = ['ABORTED', 'TIMEOUT', 'INTEGRITY', 'SIZE_MISMATCH', 'STORAGE_FULL', 'UNAVAILABLE', 'IO'] as const;
export type FailureReason = (typeof FAILURE_REASONS)[number];
const sha256hex = (value: string): string => createHash('sha256').update(Buffer.from(value, 'base64')).digest('hex');

export interface StorageDeps { now: () => number; status: (node: NodeRecord) => NodeView['status']; offlineMs: number; keyring?: TransferKeyring | undefined; limits?: Partial<StorageLimits> | undefined; random?: (() => number) | undefined }
export class StorageControl {
  readonly limits: StorageLimits;
  private readonly random: () => number; private lastSweep = 0;
  private readonly issued = new Map<string, { count: number; starts: number }>();
  constructor(private readonly store: Store, private readonly deps: StorageDeps) {
    this.limits = { ...defaultStorageLimits, ...(deps.limits ?? {}) };
    for (const value of Object.values(this.limits)) if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid storage limits');
    this.random = deps.random ?? (() => randomBytes(4).readUInt32BE(0) / 2 ** 32);
  }
  private get now(): number { return this.deps.now(); }
  get available(): boolean { return this.deps.keyring !== undefined; }

  // ---- Authorization ------------------------------------------------------------------------------------------------------------------------------------------------------------
  /** An application gets nothing by default: it needs `storage.chunk.v1` in `allowedServices` (absent means none), and the signing key must exist. */
  private authorize(app: ApplicationRecord): TransferKeyring {
    if (!(app.allowedServices ?? []).includes(SERVICE)) reject(403, 'SERVICE_FORBIDDEN');
    if (!this.deps.keyring) reject(503, 'STORAGE_UNAVAILABLE');
    return this.deps.keyring;
  }
  private rate(applicationId: string): void {
    const now = this.now; let bucket = this.issued.get(applicationId);
    if (!bucket || now - bucket.starts >= 60000) { if (this.issued.size >= 1000) this.issued.delete(this.issued.keys().next().value ?? ''); bucket = { count: 0, starts: now }; this.issued.set(applicationId, bucket); }
    if (++bucket.count > this.limits.ticketsPerMinute) reject(429, 'TICKET_RATE_LIMIT');
  }

  // ---- Node side: what nodes offer -------------------------------------------------------------------------------------------------------------------------------------------
  /** Called with every heartbeat (inside its transaction). An absent service deletes the row, like absent resources: a stale, more generous advertisement is never kept. */
  recordServices(nodeId: string, services: ServicesAdvertisement | undefined): void {
    const advertisement = services?.[SERVICE];
    if (advertisement) this.store.saveNodeService({ nodeId, service: SERVICE, ...advertisement, reportedAt: this.now }); else this.store.deleteNodeServices(nodeId);
  }
  /** A revoked node: its open transfers are revoked, its stored copies become LOST (kept for audit and Phase 5 repair, never silently dropped), its reservations are released, it offers nothing. */
  onNodeRevoked(nodeId: string): void {
    for (const transfer of this.store.listOpenTransfers({ nodeId })) this.move(transfer, 'REVOKED', 'NODE_REVOKED');
    for (const replica of this.store.listNodeReplicas(nodeId)) {
      if (replica.state === 'STORED') this.store.saveReplica({ ...replica, state: 'LOST' }); else if (replica.state === 'RESERVED') this.store.deleteReplica(replica.applicationId, replica.chunkId, nodeId);
    }
    this.store.deleteNodeServices(nodeId);
  }
  /** A revoked application: its open transfers become unusable. Its chunks are NOT deleted. */
  onApplicationRevoked(applicationId: string): void { for (const transfer of this.store.listOpenTransfers({ applicationId })) this.move(transfer, 'REVOKED', 'APPLICATION_REVOKED'); }

  // ---- Transfer state machine ---------------------------------------------------------------------------------------------------------------------------------------------------
  private move(transfer: TransferRecord, to: TransferState, reason: string | null, extra: Partial<Pick<TransferRecord, 'startedAt' | 'completedAt' | 'evidence'>> = {}): TransferRecord {
    if (!canTransition(transfer.state, to)) reject(409, 'INVALID_TRANSITION');
    const next: TransferRecord = { ...transfer, ...extra, state: to, reason, ...(FINAL_TRANSFER_STATES.includes(to) && extra.completedAt === undefined ? { completedAt: this.now } : {}) };
    this.store.saveTransfer(next); return next;
  }
  /** A transfer whose ticket ran out while nobody had begun it is EXPIRED the moment anyone looks at it, so a late report can never revive it. */
  /**
   * Persists the expiry of a lapsed, unused ticket in its own committed transaction BEFORE the caller's transaction starts: the caller usually goes on to refuse the request, and a refusal rolls its
   * transaction back, which would otherwise undo the expiry it had just noticed.
   */
  private settle(id: string): void {
    this.store.transaction(() => { const transfer = this.store.getTransfer(id); if (transfer && transfer.state === 'AUTHORIZED' && this.now >= transfer.expiresAt) this.move(transfer, 'EXPIRED', null); });
  }
  private live(id: string): TransferRecord | undefined {
    const transfer = this.store.getTransfer(id);
    return transfer && transfer.state === 'AUTHORIZED' && this.now >= transfer.expiresAt ? this.move(transfer, 'EXPIRED', null) : transfer;
  }

  // ---- Placement: choose a node and authorize an attempt --------------------------------------------------------------------------------------------------------------------------
  private eligible(size: number, exclude?: string): { node: NodeRecord; room: number }[] {
    const reserved = this.store.reservedBytes(); const out: { node: NodeRecord; room: number }[] = [];
    for (const advertisement of this.store.listNodeServices(SERVICE)) {
      if (advertisement.nodeId === exclude) continue;
      const node = this.store.getNode(advertisement.nodeId);
      // Online (a recent heartbeat, so the advertisement is fresh), not draining, not revoked, not paused by its owner, and able to take a chunk this size.
      if (!node || node.revoked || this.deps.status(node) !== 'ONLINE' || node.resources?.contribution === 'PAUSED' || advertisement.maxChunkBytes < size) continue;
      const room = advertisement.freeBytes - (reserved.get(node.nodeId) ?? 0);
      if (room < size) continue;
      const open = this.store.listOpenTransfers({ nodeId: node.nodeId });
      if (open.length >= this.limits.maxOpenTransfersPerNode || open.filter(transfer => transfer.operation === 'put').length >= this.limits.maxOpenPutsPerNode) continue;
      out.push({ node, room });
    }
    return out;
  }
  /** Free-space-weighted random: a node with twice the room is twice as likely. The application never chooses; there is no market, no reputation, no preference. */
  private choose(candidates: { node: NodeRecord; room: number }[]): NodeRecord | undefined {
    const total = candidates.reduce((sum, candidate) => sum + candidate.room, 0); if (total <= 0) return undefined;
    let point = this.random() * total;
    for (const candidate of candidates) { point -= candidate.room; if (point < 0) return candidate.node; }
    return candidates.at(-1)?.node;
  }
  private holder(key: string): { hash: string } {
    try { canonicalPublicKey(key); } catch { reject(400, 'INVALID_HOLDER_KEY'); }
    return { hash: sha256hex(key) };
  }
  private issue(app: ApplicationRecord, keyring: TransferKeyring, chunk: ChunkRecord, node: NodeRecord, operation: TransferGrant['operation'], holderKey: string): TransferGrant {
    this.rate(app.id);
    if (this.store.countOpenTransfers({ applicationId: app.id }) >= this.limits.maxOpenTransfersPerApplication) reject(429, 'TRANSFER_LIMIT');
    const now = this.now; const { kid, privateKey } = keyring.current(); const id = randomBytes(16).toString('hex');
    const expiresAt = now + TICKET_MAX_LIFETIME_MS; const maxBytes = operation === 'delete' ? 0 : chunk.size;
    const ticket = signTicket({ kid, transferId: id, operation, applicationId: app.id, chunkId: chunk.chunkId, nodeId: node.nodeId, maxBytes, issuedAt: now, expiresAt, holderKey, nonce: randomBytes(16).toString('hex') }, privateKey);
    // The ticket itself is returned and not kept; the row records what was authorized and for which key.
    this.store.saveTransfer({ id, operation, applicationId: app.id, chunkId: chunk.chunkId, nodeId: node.nodeId, kid, holderHash: sha256hex(holderKey), maxBytes, state: 'AUTHORIZED', reason: null, issuedAt: now, expiresAt, startedAt: null, completedAt: null, evidence: null });
    return { transferId: id, operation, chunkId: chunk.chunkId, expiresAt, ticket };
  }
  /** A retry (a new ticket for the same chunk) supersedes any earlier open transfer of the same operation, so at most one is ever open per chunk and operation. */
  private supersede(applicationId: string, chunkId: string, operation: TransferGrant['operation']): void {
    for (const transfer of this.store.listOpenTransfers({ chunk: { applicationId, chunkId } })) if (transfer.operation === operation && transfer.state === 'AUTHORIZED') this.move(transfer, 'REVOKED', 'SUPERSEDED');
  }
  /** Places a chunk (or confirms it already is) and authorizes the first attempt. A reservation, not a guarantee: the node enforces its own quota again when the bytes arrive. */
  place(app: ApplicationRecord, input: unknown): PlacementResponse {
    const request = PlacementRequestSchema.parse(input); const keyring = this.authorize(app); this.holder(request.holderKey);
    return this.store.transaction(() => {
      this.expireOverdue();
      const existing = this.store.getChunk(app.id, request.chunkId);
      if (existing) {
        if (existing.size !== request.size) reject(409, 'SIZE_CONFLICT');
        if (existing.state === 'STORED') return { chunkId: existing.chunkId, size: existing.size, state: 'STORED' as const, grant: null };
        if (existing.state === 'DELETING') reject(409, 'CHUNK_DELETING');
      } else {
        const usage = this.store.chunkUsage(app.id);
        if (usage.count + 1 > this.limits.maxChunksPerApplication) reject(429, 'APPLICATION_CHUNK_LIMIT');
        if (usage.bytes + request.size > this.limits.maxBytesPerApplication) reject(429, 'APPLICATION_BYTE_LIMIT');
      }
      const grant = this.reserveAndIssue(app, keyring, existing ?? undefined, { chunkId: request.chunkId, size: request.size, class: request.class ?? null }, request.holderKey);
      return { chunkId: request.chunkId, size: request.size, state: 'PENDING' as const, grant };
    });
  }
  private reserveAndIssue(app: ApplicationRecord, keyring: TransferKeyring, existing: ChunkRecord | undefined, wanted: { chunkId: string; size: number; class: string | null }, holderKey: string): TransferGrant {
    const now = this.now; const replicas = existing ? this.store.listReplicas(app.id, wanted.chunkId) : [];
    // Keep the node this chunk is already reserved on while it is still eligible; otherwise choose again and drop the stale reservation.
    let node: NodeRecord | undefined; const kept = replicas.find(replica => replica.state === 'RESERVED');
    if (kept) {
      const current = this.store.getNode(kept.nodeId); const advertisement = current && this.store.getNodeService(current.nodeId, SERVICE);
      if (current && advertisement && !current.revoked && this.deps.status(current) === 'ONLINE' && current.resources?.contribution !== 'PAUSED' && advertisement.maxChunkBytes >= wanted.size) node = current;
    }
    if (!node) {
      node = this.choose(this.eligible(wanted.size));
      if (!node) reject(503, 'NO_CAPACITY');
      for (const replica of replicas) if (replica.state === 'RESERVED') this.store.deleteReplica(app.id, wanted.chunkId, replica.nodeId);
    }
    this.supersede(app.id, wanted.chunkId, 'put');
    const chunk: ChunkRecord = existing ? { ...existing, updatedAt: now } : { applicationId: app.id, chunkId: wanted.chunkId, size: wanted.size, class: wanted.class, state: 'PENDING', createdAt: now, updatedAt: now, expiresAt: null };
    this.store.saveChunk(chunk);
    if (!this.store.getReplica(app.id, wanted.chunkId, node.nodeId)) this.store.saveReplica({ applicationId: app.id, chunkId: wanted.chunkId, nodeId: node.nodeId, state: 'RESERVED', size: wanted.size, reservedAt: now, storedAt: null, verifiedAt: null });
    return this.issue(app, keyring, chunk, node, 'put', holderKey);
  }

  // ---- Tickets for an existing chunk -----------------------------------------------------------------------------------------------------------------------------------------------
  /** A chunk that does not exist and one that belongs to another application are the same answer, byte for byte. */
  private ownChunk(app: ApplicationRecord, chunkId: string): ChunkRecord { return this.store.getChunk(app.id, chunkId) ?? reject(404, 'NOT_FOUND'); }
  ticket(app: ApplicationRecord, input: unknown): TicketResponse {
    const request = TicketRequestSchema.parse(input); const keyring = this.authorize(app); this.holder(request.holderKey);
    return this.store.transaction((): TicketResponse => {
      this.expireOverdue();
      const chunk = this.ownChunk(app, request.chunkId);
      if (request.operation === 'put') {
        if (chunk.state === 'STORED') return { chunkId: chunk.chunkId, state: 'STORED', grant: null };
        if (chunk.state === 'DELETING') reject(409, 'CHUNK_DELETING');
        return { chunkId: chunk.chunkId, state: 'PENDING', grant: this.reserveAndIssue(app, keyring, chunk, { chunkId: chunk.chunkId, size: chunk.size, class: chunk.class }, request.holderKey) };
      }
      const stored = this.store.listReplicas(app.id, chunk.chunkId).filter(replica => replica.state === 'STORED');
      if (request.operation === 'get') {
        if (chunk.state === 'DELETING') reject(409, 'CHUNK_DELETING');
        if (chunk.state !== 'STORED') reject(409, 'CHUNK_NOT_STORED');
        return { chunkId: chunk.chunkId, state: 'STORED', grant: this.issue(app, keyring, chunk, this.reachable(stored), 'get', request.holderKey) };
      }
      // delete
      if (chunk.state === 'PENDING') {
        // Nothing was ever confirmed stored. A transfer the node has begun might still commit, so deleting is refused while one is running; otherwise the intent is withdrawn.
        if (this.store.listOpenTransfers({ chunk: { applicationId: app.id, chunkId: chunk.chunkId } }).some(transfer => transfer.state === 'IN_PROGRESS')) reject(409, 'TRANSFER_IN_PROGRESS');
        for (const transfer of this.store.listOpenTransfers({ chunk: { applicationId: app.id, chunkId: chunk.chunkId } })) this.move(transfer, 'REVOKED', 'CHUNK_DELETED');
        this.store.deleteChunk(app.id, chunk.chunkId); return { chunkId: chunk.chunkId, state: 'DELETED', grant: null };
      }
      if (stored.length === 0) { this.store.deleteChunk(app.id, chunk.chunkId); return { chunkId: chunk.chunkId, state: 'DELETED', grant: null }; } // every copy is LOST: there is nothing left to remove
      const node = this.reachable(stored);
      this.supersede(app.id, chunk.chunkId, 'delete');
      const deleting: ChunkRecord = { ...chunk, state: 'DELETING', updatedAt: this.now }; this.store.saveChunk(deleting);
      return { chunkId: chunk.chunkId, state: 'DELETING', grant: this.issue(app, keyring, deleting, node, 'delete', request.holderKey) };
    });
  }
  /** The node holding a stored copy, if it can be reached now. A copy on a node that is merely offline is unavailable, not lost. */
  private reachable(stored: ReplicaRecord[]): NodeRecord {
    if (stored.length === 0) reject(409, 'CHUNK_UNAVAILABLE');
    for (const replica of stored) { const node = this.store.getNode(replica.nodeId); if (node && !node.revoked && this.deps.status(node) === 'ONLINE') return node; }
    return reject(503, 'NODE_UNAVAILABLE');
  }
  chunkStatus(app: ApplicationRecord, chunkId: string): ChunkStatus {
    this.authorize(app); const chunk = this.ownChunk(app, ChunkIdParse(chunkId));
    const available = chunk.state === 'STORED' && this.store.listReplicas(app.id, chunk.chunkId).some(replica => { const node = replica.state === 'STORED' ? this.store.getNode(replica.nodeId) : undefined; return node !== undefined && !node.revoked && this.deps.status(node) === 'ONLINE'; });
    return { chunkId: chunk.chunkId, size: chunk.size, class: chunk.class, state: chunk.state, createdAt: chunk.createdAt, available };
  }
  /** The application withdraws an authorization it has not used: a reservation is released, a delete that never began is undone. A transfer the node has begun cannot be aborted from here. */
  abort(app: ApplicationRecord, transferId: string): { ok: true } {
    this.authorize(app); this.settle(transferId);
    return this.store.transaction(() => {
      const found = this.live(transferId); if (!found || found.applicationId !== app.id) reject(404, 'NOT_FOUND');
      if (found.state === 'IN_PROGRESS') reject(409, 'TRANSFER_IN_PROGRESS');
      if (found.state !== 'AUTHORIZED') return { ok: true as const }; // already over: aborting again is harmless
      this.move(found, 'FAILED', 'ABORTED'); this.release(found); return { ok: true as const };
    });
  }
  /** Undoes the control-plane intent of a transfer that will not happen. */
  private release(transfer: TransferRecord): void {
    const others = this.store.listOpenTransfers({ chunk: { applicationId: transfer.applicationId, chunkId: transfer.chunkId } }).filter(other => other.id !== transfer.id && other.operation === transfer.operation);
    const chunk = this.store.getChunk(transfer.applicationId, transfer.chunkId); if (!chunk || others.length > 0) return;
    if (transfer.operation === 'put' && chunk.state === 'PENDING') this.store.deleteChunk(chunk.applicationId, chunk.chunkId);
    else if (transfer.operation === 'delete' && chunk.state === 'DELETING') this.store.saveChunk({ ...chunk, state: 'STORED', updatedAt: this.now });
  }

  // ---- Node evidence (internal in alpha.2: no route accepts these until bytes can move) -------------------------------------------------------------------------------------------
  private nodeFor(nodeId: string): NodeRecord { const node = this.store.getNode(nodeId); if (!node || node.revoked) reject(401, 'UNAUTHORIZED_NODE'); return node; }
  /** The target node accepted the ticket. A transfer id begins at most once: a second begin is refused, which is the control plane's half of single-use. */
  begin(nodeId: string, transferId: string): TransferRecord {
    this.nodeFor(nodeId); this.settle(transferId);
    return this.store.transaction(() => {
      const found = this.live(transferId); if (!found) reject(404, 'NOT_FOUND');
      if (found.nodeId !== nodeId) reject(403, 'WRONG_NODE');
      if (found.state === 'IN_PROGRESS' || found.state === 'COMPLETED') reject(409, 'TICKET_USED');
      if (found.state !== 'AUTHORIZED') reject(409, 'TRANSFER_FINAL');
      return this.move(found, 'IN_PROGRESS', null, { startedAt: this.now });
    });
  }
  /** The node reports failure of a transfer it had accepted or was authorized for. */
  fail(nodeId: string, transferId: string, reason: FailureReason): TransferRecord {
    this.nodeFor(nodeId); this.settle(transferId);
    return this.store.transaction(() => {
      const found = this.live(transferId); if (!found) reject(404, 'NOT_FOUND');
      if (found.nodeId !== nodeId) reject(403, 'WRONG_NODE');
      if (!(FAILURE_REASONS as readonly string[]).includes(reason)) reject(400, 'INVALID_REQUEST');
      return this.move(found, 'FAILED', reason);
    });
  }
  /**
   * The authoritative completion of a put or a delete: only the target node, authenticated as itself, can send it, and only evidence that matches what was authorized promotes a chunk to
   * STORED (or removes it). Completing twice with the same evidence is a no-op; anything else about a finished transfer is refused.
   */
  complete(nodeId: string, input: unknown): TransferRecord {
    const receipt = TransferReceiptSchema.parse(input); this.nodeFor(nodeId); this.settle(receipt.transferId);
    return this.store.transaction(() => {
      const found = this.live(receipt.transferId); if (!found) reject(404, 'NOT_FOUND');
      if (found.nodeId !== nodeId || receipt.nodeId !== nodeId) reject(403, 'WRONG_NODE');
      if (found.operation !== receipt.operation || found.applicationId !== receipt.applicationId || found.chunkId !== receipt.chunkId) reject(409, 'TRANSFER_MISMATCH');
      if (found.state === 'COMPLETED') return found;
      if (found.state !== 'AUTHORIZED' && found.state !== 'IN_PROGRESS') reject(409, 'TRANSFER_FINAL');
      const chunk = this.store.getChunk(found.applicationId, found.chunkId); if (!chunk) reject(409, 'TRANSFER_FINAL');
      if (receipt.sha256 !== found.chunkId.slice(4)) reject(409, 'HASH_MISMATCH');
      const evidence = { bytes: receipt.bytes, sha256: receipt.sha256, nodeCompletedAt: receipt.completedAt };
      if (found.operation === 'put') {
        if (chunk.state !== 'PENDING') reject(409, 'TRANSFER_FINAL');
        if (receipt.bytes !== chunk.size || receipt.bytes !== found.maxBytes) reject(409, 'SIZE_MISMATCH');
        const done = this.move(found, 'COMPLETED', null, { completedAt: this.now, evidence });
        const replica = this.store.getReplica(found.applicationId, found.chunkId, nodeId); if (!replica) reject(409, 'TRANSFER_FINAL');
        this.store.saveReplica({ ...replica, state: 'STORED', storedAt: this.now, verifiedAt: this.now }); this.store.saveChunk({ ...chunk, state: 'STORED', updatedAt: this.now });
        for (const other of this.store.listOpenTransfers({ chunk: { applicationId: found.applicationId, chunkId: found.chunkId } })) if (other.operation === 'put') this.move(other, 'REVOKED', 'SUPERSEDED');
        return done;
      }
      if (receipt.bytes !== 0 && receipt.bytes !== chunk.size) reject(409, 'SIZE_MISMATCH');
      const done = this.move(found, 'COMPLETED', null, { completedAt: this.now, evidence });
      this.store.deleteChunk(found.applicationId, found.chunkId); return done;
    });
  }

  // ---- Cleanup, bounded and throttled (never on the lease path) -------------------------------------------------------------------------------------------------------------------
  /** Moves transfers whose time ran out: an unused ticket expires, one the node began but never finished fails after the grace period. Returns how many changed. */
  expireOverdue(): number {
    let changed = 0;
    for (const transfer of this.store.listOverdueTransfers(this.now, TRANSFER_PROGRESS_GRACE_MS)) { this.move(transfer, transfer.state === 'AUTHORIZED' ? 'EXPIRED' : 'FAILED', transfer.state === 'AUTHORIZED' ? null : 'TIMEOUT'); changed++; }
    return changed;
  }
  /** Runs at most once per `STORAGE_SWEEP_MS`: expiry, withdrawal of abandoned placements, deletion of old finished transfers and of stale advertisements. */
  maintain(): void {
    const now = this.now; if (now - this.lastSweep < STORAGE_SWEEP_MS && this.lastSweep !== 0) return; this.lastSweep = now;
    this.store.transaction(() => {
      this.expireOverdue();
      for (const chunk of this.store.listAbandonedChunks(now - PENDING_CHUNK_TTL_MS, 500)) this.store.deleteChunk(chunk.applicationId, chunk.chunkId);
      this.store.deleteFinalTransfers(now - TRANSFER_RETENTION_MS);
      this.store.deleteStaleNodeServices(now - this.deps.offlineMs);
    });
  }

  // ---- Operator view: aggregates only ---------------------------------------------------------------------------------------------------------------------------------------------------
  summary(): StorageSummary {
    const reserved = this.store.reservedBytes(); const totals = this.store.storageTotals(); const counts = this.store.transferCounts(this.now - 86400000);
    const keyring = this.deps.keyring;
    const nodes = this.store.listNodeServices(SERVICE).map(advertisement => {
      const node = this.store.getNode(advertisement.nodeId);
      return { nodeId: advertisement.nodeId, status: node ? this.deps.status(node) : 'OFFLINE' as const, capacityBytes: advertisement.capacityBytes, freeBytes: advertisement.freeBytes, reservedBytes: reserved.get(advertisement.nodeId) ?? 0, openTransfers: this.store.countOpenTransfers({ nodeId: advertisement.nodeId }) };
    });
    return { keyring: { available: keyring !== undefined, currentKid: keyring ? keyring.currentKid : null, keys: keyring?.size ?? 0 }, nodes,
      chunks: totals, transfers: { open: counts.AUTHORIZED + counts.IN_PROGRESS, last24h: { completed: counts.COMPLETED, failed: counts.FAILED, expired: counts.EXPIRED, revoked: counts.REVOKED } } };
  }
  /** The public verification keys for a node. Only an authenticated node may ask (the route), only public halves are returned. */
  transferKeys(coordinatorId: string) { const keyring = this.deps.keyring ?? reject(503, 'STORAGE_UNAVAILABLE'); return { coordinatorId, keys: keyring.verificationKeys() }; }
  rotateKeys() { return (this.deps.keyring ?? reject(503, 'STORAGE_UNAVAILABLE')).rotate(); }
}
/** The service registry is consulted at load so that a typo in the service id above is a start-up failure, not a silent no-op. */
if (!(SERVICE in SERVICES)) throw new Error('storage service is not registered');
function ChunkIdParse(value: string): string { if (!/^chk_[a-f0-9]{64}$/.test(value)) reject(400, 'INVALID_REQUEST'); return value; }
export { TICKET_MAX_SKEW_MS };
