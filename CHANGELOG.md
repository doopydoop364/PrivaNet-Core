# Changelog

All notable changes to PrivaNet are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/) and versions follow the roadmap
phases (v0.1 = Phase 1 Core Foundation, v0.2 = Phase 2 Adaptive Resource Engine, ...).
Protocol compatibility notes are in [docs/protocol.md](docs/protocol.md).

## [Unreleased]

### Documentation
- Long-term design: an internal resource market for verified useful resources with PrivaCredits as the internal accounting unit (`docs/RESOURCE_MARKET.md`, rewritten `docs/CREDITS.md`, updated roadmap, resources, architecture ADR 002 and market threat model). Market-discovered clearing prices supersede fixed demand multipliers as the main scarcity mechanism. Roadmap Phase 7 is now Resource Measurement/Accounting and Phase 8 is Resource Market + PrivaCredits. No code or protocol changes; nothing described there is implemented.
- Long-term design: an internal Network Treasury funded primarily by a bounded, versioned, visible levy on existing credits, with separate budget buckets, treasury-paid public-good jobs (including a PrivaSearch public crawl queue), a contributor bootstrap program that matches verified contribution, and maintenance/emergency reserves (`docs/TREASURY.md`, ADR 003, treasury threat table). Roadmap gains Phase 9 Network Treasury and Public Goods; Community Hardening becomes Phase 10 and Stable Protocol Phase 11. Documentation only; not implemented, not an investment fund, credits remain non-tradable.

## [0.2.0] - 2026-09-29

Phase 2 — Adaptive Resource Engine (core). Protocol version 1; all wire changes are additive and optional, so v0.1 nodes still work.

### Added
- Owner resource policy for PrivaNode (`PRIVANODE_POLICY_FILE`, strict JSON): hard memory/CPU ceilings, owner RAM and CPU reserve, safety margin, per-capability ceilings, weekly schedules (`FULL`/`ADAPTIVE`/`MINIMAL`/`OFF`), battery behaviour, preemption delay.
- Adaptive budget engine: budget = min(hard limit, available − reserve − safety margin), fast-down/slow-up smoothing, enter/exit hysteresis for `NORMAL`/`ELEVATED`/`HIGH` pressure. Reads only OS memory/CPU counters (and Linux power-supply state).
- Minimal resource telemetry in heartbeats (contribution, pressure, power, permitted memory/CPU budget) plus a lifecycle field.
- Job resource declarations in the job-type registry (CPU class, memory, disk, disk I/O, network, duration, preemptible, checkpointable), required for every job type.
- Resource-aware scheduler: capability match **and** enough currently permitted budget; nodes that report nothing get a small legacy budget.
- Preemption: preemptible jobs are released after sustained high pressure; new work stops immediately.
- Graceful draining: `DRAINING` and `OFFLINE_EXPECTED` node states, `POST /v1/node/goodbye`, `POST /v1/node/jobs/{id}/release`; SIGTERM/SIGINT drain the node, with a timeout and a second-signal forced hand-back.
- Voluntary release refunds the attempt and is bounded per job (`PRIVANET_MAX_RELEASES`, error `RELEASE_LIMIT`).
- Release pipeline: tag- or dispatch-triggered GitHub releases with Linux, macOS and Windows archives, checksums and these notes.

### Changed
- Node handlers are asynchronous and receive an abort signal.
- Node heartbeats immediately when contribution or pressure changes.

### Known limits
- No disk-I/O, bandwidth or transfer limits, checkpointing, schedule-aware placement or non-Linux battery detection yet. Budgets are untrusted node-reported hints and are not verified; there is no reputation. See [docs/RESOURCES.md](docs/RESOURCES.md) and [docs/security.md](docs/security.md).

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
