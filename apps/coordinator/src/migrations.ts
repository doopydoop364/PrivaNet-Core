// Applied migrations are immutable. Add entries; never edit an applied SQL body.
// Version 2 (0.4.0-alpha.2) adds only the storage control-plane tables (metadata, never bytes). It touches no existing table, so a version 1 database upgrades in place and every node, job and credential
// record is untouched; applications gain no service (their JSON records have no `allowedServices`, which means none). An 0.4.0-alpha.1 or older Coordinator refuses a version 2 database ("schema is newer").
export const migrations = [{ version: 1, sql: `
CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE nodes (id TEXT PRIMARY KEY, record TEXT NOT NULL CHECK(json_valid(record))) STRICT;
CREATE TABLE applications (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, record TEXT NOT NULL CHECK(json_valid(record))) STRICT;
CREATE TABLE grants (token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, record TEXT NOT NULL CHECK(json_valid(record))) STRICT;
CREATE TABLE challenges (id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, record TEXT NOT NULL CHECK(json_valid(record))) STRICT;
CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, node_id TEXT NOT NULL REFERENCES nodes(id), expires_at INTEGER NOT NULL, record TEXT NOT NULL CHECK(json_valid(record))) STRICT;
CREATE INDEX sessions_node ON sessions(node_id);
CREATE TABLE jobs (id TEXT PRIMARY KEY, application_id TEXT NOT NULL REFERENCES applications(id), idempotency_key TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('QUEUED','LEASED','COMPLETED','FAILED')), created_at INTEGER NOT NULL, record TEXT NOT NULL CHECK(json_valid(record)), UNIQUE(application_id, idempotency_key)) STRICT;
CREATE INDEX jobs_pending ON jobs(status, created_at);
` }, { version: 2, sql: `
CREATE TABLE chunk (
  application_id TEXT NOT NULL REFERENCES applications(id), chunk_id TEXT NOT NULL CHECK(length(chunk_id)=68), size INTEGER NOT NULL CHECK(size BETWEEN 1 AND 8388608), class TEXT,
  state TEXT NOT NULL CHECK(state IN ('PENDING','STORED','DELETING')), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, expires_at INTEGER,
  PRIMARY KEY(application_id, chunk_id)) STRICT, WITHOUT ROWID;
CREATE TABLE replica (
  application_id TEXT NOT NULL, chunk_id TEXT NOT NULL, node_id TEXT NOT NULL REFERENCES nodes(id), state TEXT NOT NULL CHECK(state IN ('RESERVED','STORED','LOST')),
  size INTEGER NOT NULL CHECK(size BETWEEN 1 AND 8388608), reserved_at INTEGER NOT NULL, stored_at INTEGER, verified_at INTEGER,
  PRIMARY KEY(application_id, chunk_id, node_id), FOREIGN KEY(application_id, chunk_id) REFERENCES chunk(application_id, chunk_id)) STRICT, WITHOUT ROWID;
CREATE INDEX replica_node_state ON replica(node_id, state);
CREATE TABLE transfer (
  id TEXT PRIMARY KEY CHECK(length(id)=32), operation TEXT NOT NULL CHECK(operation IN ('put','get','delete')), application_id TEXT NOT NULL REFERENCES applications(id), chunk_id TEXT NOT NULL,
  node_id TEXT NOT NULL REFERENCES nodes(id), kid TEXT NOT NULL, holder_hash TEXT NOT NULL, max_bytes INTEGER NOT NULL CHECK(max_bytes BETWEEN 0 AND 8388608),
  state TEXT NOT NULL CHECK(state IN ('AUTHORIZED','IN_PROGRESS','COMPLETED','FAILED','EXPIRED','REVOKED')), reason TEXT, issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  started_at INTEGER, completed_at INTEGER, evidence TEXT CHECK(evidence IS NULL OR json_valid(evidence))) STRICT;
CREATE INDEX transfer_state_expiry ON transfer(state, expires_at);
CREATE INDEX transfer_chunk ON transfer(application_id, chunk_id, state);
CREATE INDEX transfer_node ON transfer(node_id, state);
CREATE INDEX transfer_app ON transfer(application_id, state);
CREATE TABLE node_service (
  node_id TEXT NOT NULL REFERENCES nodes(id), service TEXT NOT NULL CHECK(service IN ('storage.chunk.v1')), capacity_bytes INTEGER NOT NULL CHECK(capacity_bytes >= 0), free_bytes INTEGER NOT NULL CHECK(free_bytes >= 0),
  max_chunk_bytes INTEGER NOT NULL CHECK(max_chunk_bytes BETWEEN 1 AND 8388608), reported_at INTEGER NOT NULL, PRIMARY KEY(node_id, service)) STRICT, WITHOUT ROWID;
` }] as const;
