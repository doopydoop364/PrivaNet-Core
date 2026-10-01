import { DatabaseSync } from 'node:sqlite';
import type { StatementSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, openSync, closeSync, constants } from 'node:fs';
import { hash } from '@privanet/shared';
import { migrations } from './migrations.js';
import type { ApplicationRecord, ChallengeRecord, Grant, JobRecord, NodeRecord, NodeSession, Store } from './model.js';

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
  close(): void { this.db.close(); }
}
