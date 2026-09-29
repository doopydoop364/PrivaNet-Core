# Changelog

All notable changes to PrivaNet are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/) and versions follow the roadmap
phases (v0.1 = Phase 1 Core Foundation, v0.2 = Phase 2 Adaptive Resource Engine, ...).
Protocol compatibility notes are in [docs/protocol.md](docs/protocol.md).

## [0.1.0] - 2026-09-29

Phase 1 — Core Foundation. Protocol version 1.

### Added
- Coordinator control plane (HTTP, bounded JSON) with SQLite persistence, checksummed immutable migrations and strict configuration validation.
- PrivaNode daemon with a persistent local Ed25519 identity, Coordinator binding, enrollment, session authentication, heartbeats and lease polling.
- Shared protocol package (strict Zod schemas, explicit protocol version 1, `426 PROTOCOL_MISMATCH` on incompatible versions).
- SDK (`@privanet/sdk`): health, capabilities, typed submit with idempotency keys, status, cancellable polling wait.
- Expiring one-use enrollment tokens; challenge-response node authentication; hashed session, grant and application credentials; node and application revocation.
- Scoped application credentials (allowed job types) with in-place rotation (`POST /v1/admin/applications/{id}/rotate`).
- Node health states ONLINE / STALE / OFFLINE / REVOKED derived from heartbeat receipt time.
- Restricted typed jobs driven by a single versioned registry (`JOB_TYPES`); the only job is `system.echo.v1`. Unknown types and malformed payloads are rejected; results are validated against the leased job's registered output schema.
- Capability-aware FIFO scheduler behind a `Scheduler` interface; job leases with fencing, bounded retries and duplicate/late-completion protection.
- Admin CLI (`scripts/admin.mjs`) and end-to-end demo (`scripts/demo.mjs`).
- Cross-platform CI (Linux, macOS, Windows × Node 24 and 26).

### Security
- No arbitrary command, script, binary or container execution exists. Known Phase 1 limits (no mTLS, no per-message signing, no execution attestation, no public enrollment) are documented in [docs/security.md](docs/security.md).

### Not included
- Node key rotation, PostgreSQL adapter, adaptive resources, storage, credits, search.
