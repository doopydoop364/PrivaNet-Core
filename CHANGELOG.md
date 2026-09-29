# Changelog

All notable changes to PrivaNet are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/) and versions follow the roadmap
phases (v0.1 = Phase 1 Core Foundation, v0.2 = Phase 2 Adaptive Resource Engine, ...).
Protocol compatibility notes are in [docs/protocol.md](docs/protocol.md).

## [Unreleased]

## [0.2.1] - 2026-09-29

Completes Phase 2 (Adaptive Resource Engine) and closes the operational items left open in Phase 1. Protocol version 1; all wire changes are additive and optional, so v0.2.0 nodes still work.

### Added
- Disk limits: scratch-disk ceiling and owner free-space reserve (`maxDiskBytes`, `reserveDiskBytes`), an offered disk-I/O class (`maxDiskIo`) that drops while the owner's disk is busy (Linux), reported as `diskBudgetBytes`/`diskIo`.
- Network limits: a transfer meter with a bandwidth ceiling (`maxBandwidthBytesPerSec`) and persisted monthly allowance (`monthlyTransferBytes`), reported as `networkBudgetBytes`; optional link speed (`linkBytesPerSec`) for network-pressure awareness on Linux. Disk/network load only raises pressure to `ELEVATED`.
- Scheduler honours disk, disk-I/O, network and schedule limits; schedule-aware placement via `availableForMs` keeps long jobs off nodes about to go `OFF`.
- Node-local checkpoint/resume for `checkpointable` job types.
- Battery detection on macOS (`pmset`) and Windows (WMI battery status).
- Windows graceful stop: `SIGBREAK`/`SIGHUP`, plus a portable `DRAIN` file in the state directory that drains a running node on any platform.
- `system.hashchain.v1`: deterministic, CPU-bound, preemptible, checkpointable diagnostic job (real long-running workload for preemption/resume tests and calibration).
- `npm run backup -- <file>`: consistent online Coordinator backup with integrity check; restore test.
- Per-application queue quota (`PRIVANET_MAX_PENDING_PER_APP`, 429 `QUEUE_LIMIT`) and finished-job retention (`PRIVANET_RETENTION_MS`, default 30 days).
- Lease renewal: `POST /v1/node/jobs/{id}/renew` (fenced like completion, Coordinator-chosen expiry, total bounded by `PRIVANET_MAX_LEASE_MS`), used automatically by the node while a job runs, so jobs longer than one lease period finish on their first attempt. The node also heartbeats during long jobs.
- `PRIVANET_AUTH_REQUESTS_PER_MINUTE`, and `PRIVANET_JOB_TYPES` for the admin script.
- `docs/deployment.md`: TLS/reverse-proxy review, backup and recovery runbook.

### Changed
- Node handlers may receive `checkpoint` and `transfer` services in their context; `executeLease` takes an optional services argument.
- Roadmap: Phase 1 and Phase 2 are complete; deferred items (portable checkpoints, measured per-job use, thermal signals, node-key rotation, PostgreSQL, independent review) are assigned to later phases.

### Documentation
- Long-term design: an internal resource market for verified useful resources with PrivaCredits as the internal accounting unit (`docs/RESOURCE_MARKET.md`, rewritten `docs/CREDITS.md`, updated roadmap, resources, architecture ADR 002 and market threat model). Market-discovered clearing prices supersede fixed demand multipliers as the main scarcity mechanism. Roadmap Phase 7 is now Resource Measurement/Accounting and Phase 8 is Resource Market + PrivaCredits. No code or protocol changes; nothing described there is implemented.
- Long-term design: an internal Network Treasury funded primarily by a bounded, versioned, visible levy on existing credits, with separate budget buckets, treasury-paid public-good jobs (including a PrivaSearch public crawl queue), a contributor bootstrap program that matches verified contribution, and maintenance/emergency reserves (`docs/TREASURY.md`, ADR 003, treasury threat table). Roadmap gains Phase 9 Network Treasury and Public Goods; Community Hardening becomes Phase 10 and Stable Protocol Phase 11. Documentation only; not implemented, not an investment fund, credits remain non-tradable.

### Tests
- Release-readiness tests: version, lockfile and changelog consistency; relative Markdown links and anchors; staged distribution contents and secret hygiene for all three platforms; a run of the packaged Coordinator, node, admin, demo, long checkpointable job, backup and drain from outside the repository.
- Randomised lifecycle test (seeded, five seeds) checking lease exclusivity, fencing of stale and foreign leases, result integrity and terminal-state stability; upgrade-compatibility checks for v0.1/v0.2.0 nodes and pre-v0.2.1 job records.
- The release archives now include `tools/backup.mjs`.

### Known limits
- Checkpoints resume only on the same node. Disk and network load are sampled on Linux only. macOS/Windows battery commands and Windows console signals were not exercised on real hardware. Resource declarations were calibrated on one development machine.

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
