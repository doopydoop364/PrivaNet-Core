// Applied migrations are immutable. Add entries; never edit an applied SQL body.
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
` }] as const;
