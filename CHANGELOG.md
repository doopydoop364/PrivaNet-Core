# Changelog

All notable changes to PrivaNet are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/) and versions follow the roadmap
phases (v0.1 = Phase 1 Core Foundation, v0.2 = Phase 2 Adaptive Resource Engine, ...).
Protocol compatibility notes are in [docs/protocol.md](docs/protocol.md).

## [Unreleased]

### Added
- **Lease requests that wait for work.** `POST /v1/node/jobs/lease` takes an optional `waitMs` (0 to 8000): the Coordinator holds the request until a job is leasable for that node or the time is up. A job is picked up the moment it is submitted or requeued instead of at the node's next poll, and an idle node makes one request per wait instead of one per poll interval. Additive within protocol 1: old nodes send `{}` and work unchanged; a new node falls back to plain polling against an older Coordinator. Bounded (strict field, 8 s ceiling, at most 512 held-open requests by default, credential re-checked on every wake, no lease to a closed connection). New node setting `PRIVANODE_LEASE_WAIT_MS` (default 5000, capped by the heartbeat interval; 0 disables). See `docs/protocol.md`.

### Fixed
- **A busy PrivaNode is no longer capped at one job per poll interval.** The node's run loop slept the full `PRIVANODE_POLL_MS` after every tick, even right after finishing a job, so with the default 1000 ms a node could complete at most about one job per second however fast the work was. It now polls again immediately after a completed or handler-failed job and sleeps only when a poll finds nothing or fails, so an idle node is as quiet as before. Found by measurement (PrivaSearch crawl through the real path, 300 pages, single node): at the default poll interval throughput rose from 59 to 1,018 pages per minute (about 17 times) and Coordinator CPU fell from 21 s to 3.3 s; at a 50 ms interval it rose from 894 to 3,498 pages per minute (about 3.9 times). A regression test proves a 3000 ms interval no longer delays 20 queued jobs, and fails without the fix. No protocol or configuration change; a job released for preemption or shutdown still waits.

### Documentation
- Control plane and data plane (`docs/DATA_PLANE.md`, ADR 006, design only): the Coordinator is the control plane and never the bulk-data pipe. It authorizes, schedules, places and issues narrowly scoped, short-lived transfer authorizations; large payloads will move directly between applications and nodes (Phase 4) and between nodes (Phase 5). All work still begins at the Coordinator, applications never select nodes, and local nodes use the same mechanism as remote ones. Small typed jobs, including `web.fetch.v1` digests, keep returning bounded inline results. Records the transfer-authorization security properties, application-to-node and node-to-node flows, the node transfer service restrictions, connectivity as a separate future problem, the first deployment model (Coordinator plus an optional, conservatively limited local PrivaNode), accounting on verified evidence only, a data-plane threat table and 14 open design questions. Roadmap Phase 4 is renamed "Generic Storage + Data Plane Foundation" and Phases 3, 5, 6, 7 and 10 and the cross-cutting rules are updated. A compatibility review found no protocol change needed now. No code or behaviour changes.
- Application boundary (`docs/APPLICATION_BOUNDARY.md`, ADR 005 proposed): applications such as PrivaSearch are separate repositories that depend on the SDK only; Core never depends on application code and keeps a first-party registry of generic, function-named capabilities. Evaluates application-owned handlers, a published contract package and a Core registry, and recommends the Core registry (with a future sandboxed manifest mechanism for pure compute only). The crawl job is renamed the generic, provisional `web.fetch.v1`; ROADMAP Phase 3 now separates PrivaSearch-owned work from Core-owned generic work. No PrivaSearch code exists in Core.
- PrivaSearch integration contract (`docs/PRIVASEARCH_INTEGRATION.md`, ADR 004, fetch threat table, Phase 3 roadmap update): the constrained fetch job, SSRF and robots boundaries, digest results, permissions, retry/checkpoint semantics, resource estimates, required PrivaNet-Core changes, MVP sequence and a hand-off prompt for the separate PrivaSearch repository. Design only: no job type, handler or protocol change was made.
- Reconciled the documentation with the v0.2.1 implementation: security model (two handlers, lease renewal risk, plaintext job data and checkpoints, `availableForMs` disclosure, OS-specific and test-coverage caveats), architecture, protocol (rotate route, renew, no job cancellation), development guide (graceful node drain), resources (implemented telemetry), roadmap summary, deployment status, implementation report (marked as v0.1 history with a v0.2.1 status note and current verification), `.env.example` (four missing variables) and a README status matrix (implemented, tested, partially tested, planned, unsupported). No code or behaviour changes.

## [0.3.0-alpha.2] - 2026-09-30

Licensing and publishing release. Protocol version 1, no behaviour change: nodes and clients of `0.3.0-alpha.1` interoperate unchanged.

### Added
- **License: Apache-2.0.** The standard `LICENSE` file at the repository root and in each published package (`@privanet/protocol`, `@privanet/shared`, `@privanet/sdk`), and `"license": "Apache-2.0"` in every `package.json`. The license text also ships in every staged platform archive and inside each packed tarball. Third-party dependencies keep their own licenses; nothing is relicensed.
- **npm trusted publishing.** The Release workflow's `publish` job now publishes the three packages to public npm through GitHub OIDC with provenance and no long-lived token (npm 11.5.1 or newer), with an `NPM_TOKEN` fallback if that secret exists. It is opt-in through the repository variable `NPM_PUBLISH`, skips versions already on npm, and runs after, and independently of, the GitHub release. The GitHub release tarballs stay as release artifacts and a fallback installation source.
- Tests for license consistency (fields, identical `LICENSE` files, standard text, tarball and distribution contents) and for the shape of the publish job.

### Changed
- `docs/PACKAGES.md`: public npm as the registry, the one-time npm setup (organisation, bootstrap publish, trusted-publisher registration), tarballs documented as a permanent fallback.
- The `0.3.0-alpha.1` tarballs carry no license file; `0.3.0-alpha.2` is the first release that does.

## [0.3.0-alpha.1] - 2026-09-30

Phase 3 slice: the first real application capability, `web.fetch.v1`, plus installable consumer packages. Protocol version 1; all wire changes are additive and optional, so v0.2.x nodes and clients keep working (an old node simply lacks the capability).

### Added
- `web.fetch.v1` (ADR 005, accepted): a constrained GET returning a bounded digest (status, final URL, content type, title, description, canonical, robots meta, text, links). Twelve typed outcomes; fetch failures are results, not job failures. Not checkpointable; realistic resource estimate.
- SSRF defences: scheme and port allowlist, no credentials, DNS resolve then vet every address, connect to the vetted IP, re-check the remote address, IPv4-mapped/NAT64/6to4 handling, same-origin redirects only (max 3), no proxy or cookies, decompression bounds.
- robots.txt enforced at fetch time on the node, with a per-host rate limiter as defence in depth.
- Application fetch identity (`fetchIdentity` on the application record), stamped by the Coordinator into the lease; submissions without it fail with 403 `FETCH_IDENTITY_REQUIRED`. The User-Agent and robots token come from it; nothing is hard-coded.
- Owner-local node policy `fetch` section, including an `unsafeLocal` escape hatch that exists only in the node policy file.
- `@privanet/protocol`, `@privanet/shared` and `@privanet/sdk` publish metadata, release tarballs, an npm publish job gated on `NPM_TOKEN`, and `docs/PACKAGES.md` (install, compatibility, version mismatch, publishing).

### Changed
- `LeaseSchema.client` and `AppCreateSchema.fetchIdentity` (optional). Version `0.3.0-alpha.1`.

### Known limits
- Owner-network isolation depends on node policy; no third-party nodes yet. HTML digest is not a full parser. No job cancellation.

### Tests
- New unit, handler, TLS and end-to-end suites (`tests/fetch-*.test.ts`, `tests/packages.test.ts`) drive the real Coordinator, authenticated node and SDK against loopback servers.

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
