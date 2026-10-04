import { DatabaseSync } from 'node:sqlite';
import type { StatementSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, openSync, closeSync, constants } from 'node:fs';
import { hash } from '@privanet/shared';
import { migrations } from './migrations.js';
import type { ServiceId, TransferState } from '@privanet/protocol';
import type { ApplicationRecord, ChallengeRecord, ChunkRecord, Grant, JobRecord, NodeRecord, NodeServiceRecord, NodeSession, ReplicaRecord, Store, TransferRecord } from './model.js';

type Row = Record<string, unknown>;
const num = (value: unknown): number => Number(value);
const numOrNull = (value: unknown): number | null => value === null || value === undefined ? null : Number(value);
const chunkOf = (row: Row): ChunkRecord => ({ applicationId: String(row.application_id), chunkId: String(row.chunk_id), size: num(row.size), class: row.class === null ? null : String(row.class), state: row.state as ChunkRecord['state'], createdAt: num(row.created_at), updatedAt: num(row.updated_at), expiresAt: numOrNull(row.expires_at) });
const replicaOf = (row: Row): ReplicaRecord => ({ applicationId: String(row.application_id), chunkId: String(row.chunk_id), nodeId: String(row.node_id), state: row.state as ReplicaRecord['state'], size: num(row.size), reservedAt: num(row.reserved_at), storedAt: numOrNull(row.stored_at), verifiedAt: numOrNull(row.verified_at) });
const transferOf = (row: Row): TransferRecord => ({ id: String(row.id), operation: row.operation as TransferRecord['operation'], applicationId: String(row.application_id), chunkId: String(row.chunk_id), nodeId: String(row.node_id), kid: String(row.kid),
  holderHash: String(row.holder_hash), maxBytes: num(row.max_bytes), state: row.state as TransferState, reason: row.reason === null ? null : String(row.reason), issuedAt: num(row.issued_at), expiresAt: num(row.expires_at), startedAt: numOrNull(row.started_at), completedAt: numOrNull(row.completed_at),
  evidence: row.evidence === null ? null : JSON.parse(String(row.evidence)) as Record<string, unknown> });
const serviceOf = (row: Row): NodeServiceRecord => ({ nodeId: String(row.node_id), service: row.service as ServiceId, capacityBytes: num(row.capacity_bytes), freeBytes: num(row.free_bytes), maxChunkBytes: num(row.max_chunk_bytes), reportedAt: num(row.reported_at), ...(row.transfer_endpoint ? { transferEndpoint: JSON.parse(String(row.transfer_endpoint)) as NodeServiceRecord['transferEndpoint'] } : {}) });
const OPEN = "state IN ('AUTHORIZED','IN_PROGRESS')";

/** How long a used, revoked or expired enrollment grant stays on record after its expiry time. */
export const GRANT_RETENTION_MS = 30 * 86400000;

export class SqliteStore implements Store {
  readonly coordinatorId: string;
  private readonly db: DatabaseSync;
  private inTransaction = false;
  constructor(path: string, migrationList: ReadonlyArray<{ version: number; sql: string }> = migrations) {
    if (path !== ':memory:') {
      try {
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink() || (process.platform !== 'win32' &&
            ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))) throw new Error('Unsafe database file');
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
        closeSync(openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600));
      }
    }
    this.db = new DatabaseSync(path);
    try {
      this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
      this.db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, checksum TEXT NOT NULL) STRICT;');
      this.transaction(() => {
        const applied = this.stmt('SELECT version, checksum FROM schema_migrations ORDER BY version').all();
        if (applied.length > migrationList.length) throw new Error('Database schema is newer than service');
        for (const [index, migration] of migrationList.entries()) {
          if (migration.version !== index + 1) throw new Error('Migrations must be sequential');
          const row = applied[index];
          if (row) {
            if (row.version !== migration.version || row.checksum !== hash(migration.sql)) throw new Error('Applied migration changed');
          } else {
            this.db.exec(migration.sql);
            this.stmt('INSERT INTO schema_migrations VALUES (?, ?)').run(migration.version, hash(migration.sql));
          }
        }
        this.stmt("INSERT OR IGNORE INTO metadata VALUES ('coordinator_id', ?)").run(randomUUID());
      });
      this.coordinatorId = String(this.stmt("SELECT value FROM metadata WHERE key='coordinator_id'").get()?.value);
      if (path !== ':memory:') chmodSync(path, 0o600);
    } catch (error) { this.db.close(); throw error; }
  }
  // Prepared statements are reused: parsing the same SQL on every lease attempt was a large share of the Coordinator's CPU at many waiting lanes.
  private readonly statements = new Map<string, StatementSync>();
  private stmt(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (!statement) { statement = this.db.prepare(sql); this.statements.set(sql, statement); }
    return statement;
  }
  transaction<T>(operation: () => T): T {
    if (this.inTransaction) return operation();
    this.db.exec('BEGIN IMMEDIATE');
    this.inTransaction = true;
    try { const result = operation(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
    finally { this.inTransaction = false; }
  }
  private one<T>(sql: string, ...args: string[]): T | undefined {
    const row = this.stmt(sql).get(...args);
    return row ? JSON.parse(String(row.record)) as T : undefined;
  }
  getNode(id: string): NodeRecord | undefined { return this.one('SELECT record FROM nodes WHERE id=?', id); }
  saveNode(node: NodeRecord): void { this.stmt('INSERT INTO nodes VALUES (?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record').run(node.nodeId, JSON.stringify(node)); }
  listNodes(): NodeRecord[] { return this.stmt('SELECT record FROM nodes ORDER BY id').all().map(row => JSON.parse(String(row.record)) as NodeRecord); }
  getApplication(id: string): ApplicationRecord | undefined { return this.one('SELECT record FROM applications WHERE id=?', id); }
  findApplication(tokenHash: string): ApplicationRecord | undefined { return this.one('SELECT record FROM applications WHERE token_hash=?', tokenHash); }
  saveApplication(app: ApplicationRecord): void { this.stmt('INSERT INTO applications VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET token_hash=excluded.token_hash, record=excluded.record').run(app.id, app.tokenHash, JSON.stringify(app)); }
  getGrant(tokenHash: string): Grant | undefined { return this.one('SELECT record FROM grants WHERE token_hash=?', tokenHash); }
  saveGrant(grant: Grant): void { this.stmt('INSERT INTO grants VALUES (?,?,?) ON CONFLICT(token_hash) DO UPDATE SET record=excluded.record').run(grant.tokenHash, grant.expiresAt, JSON.stringify(grant)); }
  listGrants(): Grant[] { return this.stmt('SELECT record FROM grants ORDER BY expires_at DESC, token_hash').all().map(row => JSON.parse(String(row.record)) as Grant); }
  getChallenge(id: string): ChallengeRecord | undefined { return this.one('SELECT record FROM challenges WHERE id=?', id); }
  saveChallenge(challenge: ChallengeRecord): void { this.stmt('INSERT INTO challenges VALUES (?,?,?)').run(challenge.challengeId, challenge.expiresAt, JSON.stringify(challenge)); }
  deleteChallenge(id: string): void { this.stmt('DELETE FROM challenges WHERE id=?').run(id); }
  countChallenges(): number { return Number(this.stmt('SELECT COUNT(*) AS count FROM challenges').get()?.count); }
  getSession(tokenHash: string): NodeSession | undefined { return this.one('SELECT record FROM sessions WHERE token_hash=?', tokenHash); }
  saveSession(session: NodeSession): void { this.stmt('INSERT INTO sessions VALUES (?,?,?,?)').run(session.tokenHash, session.nodeId, session.expiresAt, JSON.stringify(session)); }
  deleteNodeSessions(nodeId: string): void { this.stmt('DELETE FROM sessions WHERE node_id=?').run(nodeId); }
  getJob(id: string): JobRecord | undefined { return this.one('SELECT record FROM jobs WHERE id=?', id); }
  findSubmission(applicationId: string, key: string): JobRecord | undefined { return this.one('SELECT record FROM jobs WHERE application_id=? AND idempotency_key=?', applicationId, key); }
  saveJob(job: JobRecord): void {
    this.stmt('INSERT INTO jobs VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status, record=excluded.record').run(job.id, job.applicationId, job.idempotencyKey, job.status, job.createdAt, JSON.stringify(job));
  }
  listPendingJobs(): JobRecord[] { return this.stmt("SELECT record FROM jobs WHERE status IN ('QUEUED','LEASED') ORDER BY created_at,id").all().map(row => JSON.parse(String(row.record)) as JobRecord); }
  countPendingJobs(applicationId: string): number { return Number(this.stmt("SELECT COUNT(*) AS count FROM jobs WHERE application_id=? AND status IN ('QUEUED','LEASED')").get(applicationId)?.count); }
  deleteTerminalJobs(completedBefore: number): number {
    return Number(this.stmt("DELETE FROM jobs WHERE status IN ('COMPLETED','FAILED') AND json_extract(record,'$.completedAt') <= ?").run(completedBefore).changes);
  }
  prune(now: number): void {
    this.stmt('DELETE FROM challenges WHERE expires_at<=?').run(now);
    this.stmt('DELETE FROM sessions WHERE expires_at<=?').run(now);
    // A grant is kept after it expires, so that "was it used, by which node, and when" can still be answered; only an old record is dropped.
    this.stmt('DELETE FROM grants WHERE expires_at<=?').run(now - GRANT_RETENTION_MS);
  }
  // ---- Storage control plane (metadata only) ------------------------------------------------------------------------------------------------------------------------------------
  getChunk(applicationId: string, chunkId: string): ChunkRecord | undefined { const row = this.stmt('SELECT * FROM chunk WHERE application_id=? AND chunk_id=?').get(applicationId, chunkId); return row ? chunkOf(row) : undefined; }
  saveChunk(chunk: ChunkRecord): void {
    this.stmt('INSERT INTO chunk (application_id, chunk_id, size, class, state, created_at, updated_at, expires_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(application_id, chunk_id) DO UPDATE SET size=excluded.size, class=excluded.class, state=excluded.state, updated_at=excluded.updated_at, expires_at=excluded.expires_at')
      .run(chunk.applicationId, chunk.chunkId, chunk.size, chunk.class, chunk.state, chunk.createdAt, chunk.updatedAt, chunk.expiresAt);
  }
  deleteChunk(applicationId: string, chunkId: string): void {
    this.stmt('DELETE FROM replica WHERE application_id=? AND chunk_id=?').run(applicationId, chunkId);
    this.stmt('DELETE FROM chunk WHERE application_id=? AND chunk_id=?').run(applicationId, chunkId);
  }
  chunkUsage(applicationId: string): { count: number; bytes: number } { const row = this.stmt('SELECT COUNT(*) AS count, COALESCE(SUM(size),0) AS bytes FROM chunk WHERE application_id=?').get(applicationId); return { count: num(row?.count), bytes: num(row?.bytes) }; }
  getReplica(applicationId: string, chunkId: string, nodeId: string): ReplicaRecord | undefined { const row = this.stmt('SELECT * FROM replica WHERE application_id=? AND chunk_id=? AND node_id=?').get(applicationId, chunkId, nodeId); return row ? replicaOf(row) : undefined; }
  listReplicas(applicationId: string, chunkId: string): ReplicaRecord[] { return this.stmt('SELECT * FROM replica WHERE application_id=? AND chunk_id=? ORDER BY node_id').all(applicationId, chunkId).map(replicaOf); }
  saveReplica(replica: ReplicaRecord): void {
    this.stmt('INSERT INTO replica (application_id, chunk_id, node_id, state, size, reserved_at, stored_at, verified_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(application_id, chunk_id, node_id) DO UPDATE SET state=excluded.state, size=excluded.size, stored_at=excluded.stored_at, verified_at=excluded.verified_at')
      .run(replica.applicationId, replica.chunkId, replica.nodeId, replica.state, replica.size, replica.reservedAt, replica.storedAt, replica.verifiedAt);
  }
  deleteReplica(applicationId: string, chunkId: string, nodeId: string): void { this.stmt('DELETE FROM replica WHERE application_id=? AND chunk_id=? AND node_id=?').run(applicationId, chunkId, nodeId); }
  listNodeReplicas(nodeId: string, state?: ReplicaRecord['state']): ReplicaRecord[] {
    return (state ? this.stmt('SELECT * FROM replica WHERE node_id=? AND state=?').all(nodeId, state) : this.stmt('SELECT * FROM replica WHERE node_id=?').all(nodeId)).map(replicaOf);
  }
  reservedBytes(): Map<string, number> { return new Map(this.stmt("SELECT node_id, SUM(size) AS bytes FROM replica WHERE state='RESERVED' GROUP BY node_id").all().map(row => [String(row.node_id), num(row.bytes)])); }
  getTransfer(id: string): TransferRecord | undefined { const row = this.stmt('SELECT * FROM transfer WHERE id=?').get(id); return row ? transferOf(row) : undefined; }
  saveTransfer(t: TransferRecord): void {
    this.stmt(`INSERT INTO transfer (id, operation, application_id, chunk_id, node_id, kid, holder_hash, max_bytes, state, reason, issued_at, expires_at, started_at, completed_at, evidence) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET state=excluded.state, reason=excluded.reason, started_at=excluded.started_at, completed_at=excluded.completed_at, evidence=excluded.evidence`)
      .run(t.id, t.operation, t.applicationId, t.chunkId, t.nodeId, t.kid, t.holderHash, t.maxBytes, t.state, t.reason, t.issuedAt, t.expiresAt, t.startedAt, t.completedAt, t.evidence === null ? null : JSON.stringify(t.evidence));
  }
  listOpenTransfers(filter: { applicationId?: string; nodeId?: string; chunk?: { applicationId: string; chunkId: string } } = {}): TransferRecord[] {
    const clauses = [OPEN]; const args: string[] = [];
    if (filter.applicationId !== undefined) { clauses.push('application_id=?'); args.push(filter.applicationId); }
    if (filter.nodeId !== undefined) { clauses.push('node_id=?'); args.push(filter.nodeId); }
    if (filter.chunk) { clauses.push('application_id=? AND chunk_id=?'); args.push(filter.chunk.applicationId, filter.chunk.chunkId); }
    return this.stmt(`SELECT * FROM transfer WHERE ${clauses.join(' AND ')} ORDER BY issued_at, id`).all(...args).map(transferOf);
  }
  countOpenTransfers(filter: { applicationId?: string; nodeId?: string }): number {
    const clauses = [OPEN]; const args: string[] = [];
    if (filter.applicationId !== undefined) { clauses.push('application_id=?'); args.push(filter.applicationId); }
    if (filter.nodeId !== undefined) { clauses.push('node_id=?'); args.push(filter.nodeId); }
    return num(this.stmt(`SELECT COUNT(*) AS count FROM transfer WHERE ${clauses.join(' AND ')}`).get(...args)?.count);
  }
  openTransferCounts(): Map<string, { total: number; puts: number }> {
    return new Map(this.stmt(`SELECT node_id, COUNT(*) AS total, COALESCE(SUM(operation='put'),0) AS puts FROM transfer WHERE ${OPEN} GROUP BY node_id`).all().map(row => [String(row.node_id), { total: num(row.total), puts: num(row.puts) }]));
  }
  listOverdueTransfers(now: number, graceMs: number): TransferRecord[] {
    return this.stmt("SELECT * FROM transfer WHERE (state='AUTHORIZED' AND expires_at<=?) OR (state='IN_PROGRESS' AND expires_at+?<=?) ORDER BY expires_at, id LIMIT 1000").all(now, graceMs, now).map(transferOf);
  }
  deleteFinalTransfers(endedBefore: number): number { return Number(this.stmt("DELETE FROM transfer WHERE state IN ('COMPLETED','FAILED','EXPIRED','REVOKED') AND COALESCE(completed_at, expires_at) <= ?").run(endedBefore).changes); }
  transferCounts(since: number): Record<TransferState, number> {
    const counts: Record<TransferState, number> = { AUTHORIZED: 0, IN_PROGRESS: 0, COMPLETED: 0, FAILED: 0, EXPIRED: 0, REVOKED: 0 };
    for (const row of this.stmt('SELECT state, COUNT(*) AS count FROM transfer WHERE issued_at >= ? OR state IN (\'AUTHORIZED\',\'IN_PROGRESS\') GROUP BY state').all(since)) counts[row.state as TransferState] = num(row.count);
    return counts;
  }
  listAbandonedChunks(updatedBefore: number, limit: number): ChunkRecord[] {
    return this.stmt(`SELECT c.* FROM chunk c WHERE c.state='PENDING' AND c.updated_at<=? AND NOT EXISTS (SELECT 1 FROM transfer t WHERE t.application_id=c.application_id AND t.chunk_id=c.chunk_id AND t.state IN ('AUTHORIZED','IN_PROGRESS')) ORDER BY c.updated_at LIMIT ?`).all(updatedBefore, limit).map(chunkOf);
  }
  getNodeService(nodeId: string, service: ServiceId): NodeServiceRecord | undefined { const row = this.stmt('SELECT * FROM node_service WHERE node_id=? AND service=?').get(nodeId, service); return row ? serviceOf(row) : undefined; }
  saveNodeService(r: NodeServiceRecord): void {
    this.stmt('INSERT INTO node_service (node_id, service, capacity_bytes, free_bytes, max_chunk_bytes, reported_at, transfer_endpoint) VALUES (?,?,?,?,?,?,?) ON CONFLICT(node_id, service) DO UPDATE SET capacity_bytes=excluded.capacity_bytes, free_bytes=excluded.free_bytes, max_chunk_bytes=excluded.max_chunk_bytes, reported_at=excluded.reported_at, transfer_endpoint=excluded.transfer_endpoint')
      .run(r.nodeId, r.service, r.capacityBytes, r.freeBytes, r.maxChunkBytes, r.reportedAt, r.transferEndpoint ? JSON.stringify(r.transferEndpoint) : null);
  }
  deleteNodeServices(nodeId: string): void { this.stmt('DELETE FROM node_service WHERE node_id=?').run(nodeId); }
  listNodeServices(service: ServiceId): NodeServiceRecord[] { return this.stmt('SELECT * FROM node_service WHERE service=? ORDER BY node_id').all(service).map(serviceOf); }
  deleteStaleNodeServices(reportedBefore: number): number { return Number(this.stmt('DELETE FROM node_service WHERE reported_at <= ?').run(reportedBefore).changes); }
  storageTotals(): { pending: number; stored: number; deleting: number; storedBytes: number; reservedBytes: number } {
    const totals = { pending: 0, stored: 0, deleting: 0, storedBytes: 0, reservedBytes: 0 };
    for (const row of this.stmt('SELECT state, COUNT(*) AS count, COALESCE(SUM(size),0) AS bytes FROM chunk GROUP BY state').all()) {
      const count = num(row.count); const bytes = num(row.bytes);
      if (row.state === 'PENDING') { totals.pending = count; totals.reservedBytes = bytes; } else if (row.state === 'STORED') { totals.stored = count; totals.storedBytes = bytes; } else totals.deleting = count;
    }
    return totals;
  }
  close(): void { this.db.close(); }
}
