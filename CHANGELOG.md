# Changelog

All notable changes to PrivaNet are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/) and versions follow the roadmap
phases (v0.1 = Phase 1 Core Foundation, v0.2 = Phase 2 Adaptive Resource Engine, ...).
Protocol compatibility notes are in [docs/protocol.md](docs/protocol.md).

## [Unreleased]

### Documentation
- **Roadmap: a planned Phase 3.5, Remote Node Onboarding / Contributor Experience** (`ROADMAP.md`, `docs/roadmap.md` as v0.3.5). Trusted, invite-only remote contributors: a public hostname with a publicly trusted certificate, one-command Linux and Windows installers, short-lived invite codes, an optional owner-approval flow, reinstall and revocation, and remote-node diagnostics, with the guardrails it needs (Internet exposure review, installer trust chain). Enrollment stays owner-controlled; anonymous or public enrollment, Sybil resistance, reputation, credits and hostile-node verification stay in Phase 10. Existing phase numbers and order are unchanged, and the Phase 10 text now says invite-only onboarding does not wait for it. The first-deployment, deployment and validation documents point to it as a planned simplification. Nothing is implemented.

### Fixed
- **A timing guard that was calibrated for fast machines.** The "busy node polls again at once" test allowed 6 s for 20 jobs; the regression it guards against (one poll-interval sleep per job) takes about 57 s, and a loaded Windows runner needed 8 s. The bound is now 20 s, still well below the regression.
- **A multinode test race.** The spread test counted `job.completed` log lines the moment the client had every result, but a node logs that line after it reports the result, so the last line could still be in flight (39 of 40 on a loaded runner). It now waits for the lines to arrive, then still requires exactly one completion per job.
- **Re-running the Release workflow for an existing tag no longer fails at the GitHub release step.** It now leaves the existing release and its assets untouched and carries on, so the `publish` and `registry-smoke` jobs can be completed afterwards (for example after setting `NPM_PUBLISH`, which a first run would have skipped). The npm side was already safe to re-run.

## [0.3.0-alpha.6] - 2026-10-01

First release published to npm through trusted publishing (GitHub OIDC with provenance, no long-lived token). Protocol version 1, no wire change and no change to what the three packages contain: `0.3.0-alpha.5` (the manual bootstrap publish) and `0.3.0-alpha.6` interoperate, and the Coordinator and PrivaNode behave identically. The release exists to prove the publish path end to end and to carry the npm-first documentation and the registry smoke test.

### Added
- **`scripts/registry-smoke.mjs`** (`npm run smoke:registry`): a live-registry check. In a clean project it confirms `@privanet/protocol`, `shared` and `sdk` exist at the expected version with the dist-tag pointing at it, installs `@privanet/sdk@<tag>`, verifies one matching protocol/shared/sdk set, and imports them. The Release workflow runs it after each publish (`registry-smoke` job, same `NPM_PUBLISH` gate). It is not part of `npm test`, so ordinary test runs never need the network.
- The publish-job test also pins dependency order, `--tag next` for pre-releases and the smoke job.

### Changed
- **npm is now the primary install path.** `@privanet/protocol`, `shared` and `sdk` are published at `0.3.0-alpha.5` (trusted publishing configured). `docs/PACKAGES.md` and the README say so: `npm install @privanet/sdk@next`, pin exact versions while pre-1.0, no permanent `file:` links or release-asset URLs, the GitHub tarballs are a fallback and verifiable artifact, and the Coordinator and PrivaNode remain platform release archives. No package contents changed, so no new package version.

## [0.3.0-alpha.5] - 2026-09-30

Deployment-readiness release: a server Coordinator with a separate desktop worker on a LAN, proven with real separate network stacks. Protocol version 1, no wire change: `0.3.0-alpha.4` and `0.3.0-alpha.2` nodes, clients and Coordinators interoperate (checked with real binaries).

### Fixed
- **A reverse proxy's error page was a parse error.** An empty or HTML 502/503/504 from a proxy in front of a stopped Coordinator made the shared transport throw a bare `SyntaxError`; it is now an `ApiError` (`INVALID_RESPONSE`).
- **`waitForResult` lost its wait across a Coordinator restart.** It now retries transient failures (connection refused or reset, a request timeout, 502/503/504) with backoff until its own deadline, and still fails fast on real refusals. The exported `isTransientFailure` is the rule.
- **Node connection failures carry a reason.** `node.connection_failed` adds `reason` from a fixed vocabulary (`TLS_CERTIFICATE`, `DNS`, `CONNECTION_REFUSED`, `TIMEOUT`, `UNREACHABLE`, `CONNECTION_RESET`, `OTHER`); never an address, URL or message.
- **Configuration errors no longer crash-loop.** The Coordinator and the node log `config_invalid` with the names (never the values) of the offending settings and exit with status 78; a node that meets a different Coordinator than the one it first bound to logs `node.coordinator_binding_changed` and exits 78 rather than retrying forever. The shipped units set `RestartPreventExitStatus=78`.
- The README described v0.2.1; it now describes this release.

### Added
- **`docs/FIRST_DEPLOYMENT.md`:** the exact procedure for a server Coordinator (TLS through Caddy, systemd, backup, upgrade) with an optional conservative server node and a separately enrolled desktop node, using only commands that exist.
- **`docs/DEPLOYMENT_VALIDATION.md`:** separate-host evidence, the network-model audit from the code, the admin and security exposure review, what is unverified, a manual two-machine check, and the readiness verdict (B: ready with manual precautions).
- **`deploy/`** (shipped in every release archive): `caddy/Caddyfile`, `systemd/privanet-coordinator.service` and `privanet-node.service`, `env/*.env.example`, `policy/server-node.json` (conservative, always-on host) and `policy/desktop-node.json` (larger, adaptive), and the operator wrappers `bin/privanet-admin` and `bin/privanet-backup`.
- **Network-namespace LAN tests** (`npm run test:lan`, Linux and root, own CI job): a desktop on another host enrols over TLS with no inbound port; the admin API, the Coordinator's own port and plain HTTP are unreachable from the LAN; TLS failures are reported and never enrol; Coordinator and proxy outages (idle, mid-job, node started during one) recover with no action; identity persistence, revocation and a rebuilt Coordinator; mixed versions against the real v0.3.0-alpha.2 binaries; and a two-node workload (conservative server node, larger desktop node, cable pulled and restored: limits respected exactly, no duplicate or lost result).
- `tests/deploy.test.ts` in the default suite checks the shipped deployment files against the code.

## [0.3.0-alpha.4] - 2026-09-30

Trusted multi-node validation release. Protocol version 1, no wire change: `0.3.0-alpha.3` nodes, clients and Coordinators interoperate. Highlights: the Coordinator no longer gets slower as nodes add job slots, and there is now a repeatable real-process multi-node test and measurement suite ([docs/MULTI_NODE_VALIDATION.md](docs/MULTI_NODE_VALIDATION.md)).

### Fixed
- **Coordinator cost grew with the number of waiting lease requests.** Every submitted job woke every held-open lease request and each ran a full transaction plus two scans and JSON parses of the pending jobs. With many job slots the Coordinator saturated (measured: 4 nodes x 32 slots halved throughput, and 8 nodes x 64 slots timed out the client). A work event now wakes at most one waiting request per capable node, prepared SQL statements are cached, and `lease()` reuses the pending-job list its own expiry sweep read. An idle lease attempt fell from 60 to 13 microseconds; indicative throughput on one 4-CPU machine rose from 8,711 to 10,849 (1 node), 13,036 to 16,718 (4 nodes), 5,680 to 13,141 (4 nodes x 32 slots) and from a timeout to 8,687 jobs per minute (8 nodes x 64 slots). Behaviour is otherwise unchanged.

### Added
- Real-process multi-node harness and scenarios: work spread, crash failover, Coordinator restart, drain, node restart with the same identity, a paused-then-resumed zombie node, mixed owner limits and capabilities, and revocation mid-job. Run with `npm run test:multinode` (not part of `npm test`). Measurement driver `tests/cluster-measure.ts` (throughput, failover, restart, churn).
- `PRIVANET_ENROLLMENT_TTL_MS` for the admin CLI's enrollment tokens (default unchanged, 60 s; up to 24 h), so a fleet held back by the per-address authentication limit does not outlive its tokens.
- Tests that a work event wakes at most one waiter per capable node (fails if every waiter is woken) and that empty lease attempts change nothing.

### Documentation
- `docs/MULTI_NODE_VALIDATION.md`: scenario matrix and pass criteria, findings (no correctness or security defect found across the cross-process scenarios), measured failover (lease TTL plus about 50 ms), restart recovery (all nodes back in about 6.5 s), a 60 s churn run (35 `SIGKILL`s, 2,618 of 2,618 jobs correct, 2 retried), authentication-limit behaviour, throughput before and after, and what is not covered.

## [0.3.0-alpha.3] - 2026-09-30

Throughput and scaling release, driven by measurements of a real PrivaSearch crawl through the Coordinator and PrivaNode. Protocol version 1; every wire change is additive and optional, so `0.3.0-alpha.2` nodes, clients and Coordinators interoperate with this release (new features fall back to the old behaviour). Highlights: a node no longer sleeps after every job (59 to 1,018 pages per minute on default settings), leases and job reads can wait instead of poll, and a node can run up to 64 jobs at once inside the owner's limits.

### Added
- **Multi-slot nodes** (extension point E7). A node may run up to 64 jobs at once in one process (`PRIVANODE_JOB_SLOTS`, default 1, opt-in). One identity, session, heartbeat and set of owner limits are shared; each lane polls, runs one job and reports independently, and preemption, drain and lease renewal apply per job. **Owner limits stay a hard ceiling:** the scheduler reserves the declared estimates of a node's running jobs against the budget it reported before placing another. Protocol: the heartbeat's `jobSlots` and `currentJobs` accept 1 to 64 (they were fixed at 1); a node falls back to one slot against an older Coordinator, which answers 400. Motivation (measured): one slot handles one job per network round trip, so at 200 ms per request a node did about 260 pages a minute, and the workaround of one process per slot cost about 80 MiB each. See `docs/protocol.md` and `docs/RESOURCES.md`.
- **Job reads that wait for the result.** `GET /v1/jobs/{id}?waitMs=N` (0 to 8000) holds the read until the job finishes or the time is up. `waitForResult` in `@privanet/sdk` uses it, so an application no longer polls the Coordinator every poll interval per job (measured: with 128 jobs waiting on one busy node, Coordinator CPU was 35 s over a 139 s run, almost all of it status polls). Additive within protocol 1 and bounded (ownership checked first, credential re-checked on wake, no work for closed connections, at most 4096 held-open reads by default); the SDK falls back to plain polling against an older Coordinator. See `docs/protocol.md`.
- **Lease requests that wait for work.** `POST /v1/node/jobs/lease` takes an optional `waitMs` (0 to 8000): the Coordinator holds the request until a job is leasable for that node or the time is up. A job is picked up the moment it is submitted or requeued instead of at the node's next poll, and an idle node makes one request per wait instead of one per poll interval. Additive within protocol 1: old nodes send `{}` and work unchanged; a new node falls back to plain polling against an older Coordinator. Bounded (strict field, 8 s ceiling, at most 512 held-open requests by default, credential re-checked on every wake, no lease to a closed connection). New node setting `PRIVANODE_LEASE_WAIT_MS` (default 5000, capped by the heartbeat interval; 0 disables). See `docs/protocol.md`.

### Fixed
- **A busy PrivaNode is no longer capped at one job per poll interval.** The node's run loop slept the full `PRIVANODE_POLL_MS` after every tick, even right after finishing a job, so with the default 1000 ms a node could complete at most about one job per second however fast the work was. It now polls again immediately after a completed or handler-failed job and sleeps only when a poll finds nothing or fails, so an idle node is as quiet as before. Found by measurement (PrivaSearch crawl through the real path, 300 pages, single node): at the default poll interval throughput rose from 59 to 1,018 pages per minute (about 17 times) and Coordinator CPU fell from 21 s to 3.3 s; at a 50 ms interval it rose from 894 to 3,498 pages per minute (about 3.9 times). A regression test proves a 3000 ms interval no longer delays 20 queued jobs, and fails without the fix. No protocol or configuration change; a job released for preemption or shutdown still waits.

### Documentation
- Control plane and data plane (`docs/DATA_PLANE.md`, ADR 006, design only): the Coordinator is the control plane and never the bulk-data pipe. It authorizes, schedules, places and issues narrowly scoped, short-lived transfer authorizations; large payloads will move directly between applications and nodes (Phase 4) and between nodes (Phase 5). All work still begins at the Coordinator, applications never select nodes, and local nodes use the same mechanism as remote ones. Small typed jobs, including `web.fetch.v1` digests, keep returning bounded inline results. Records the transfer-authorization security properties, application-to-node and node-to-node flows, the node transfer service restrictions, connectivity as a separate future problem, the first deployment model (Coordinator plus an optional, conservatively limited local PrivaNode), accounting on verified evidence only, a data-plane threat table and 14 open design questions. Roadmap Phase 4 is renamed "Generic Storage + Data Plane Foundation" and Phases 3, 5, 6, 7 and 10 and the cross-cutting rules are updated. A compatibility review found no protocol change needed now. No code or behaviour changes.

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

### Documentation
- Application boundary (`docs/APPLICATION_BOUNDARY.md`, ADR 005, since accepted): applications such as PrivaSearch are separate repositories that depend on the SDK only; Core never depends on application code and keeps a first-party registry of generic, function-named capabilities. Evaluates application-owned handlers, a published contract package and a Core registry, and recommends the Core registry (with a future sandboxed manifest mechanism for pure compute only). The crawl job is renamed the generic, provisional `web.fetch.v1`; ROADMAP Phase 3 now separates PrivaSearch-owned work from Core-owned generic work. No PrivaSearch code exists in Core.
- PrivaSearch integration contract (`docs/PRIVASEARCH_INTEGRATION.md`, ADR 004, fetch threat table, Phase 3 roadmap update): the constrained fetch job, SSRF and robots boundaries, digest results, permissions, retry/checkpoint semantics, resource estimates, required PrivaNet-Core changes, MVP sequence and a hand-off prompt for the separate PrivaSearch repository. Design only: no job type, handler or protocol change was made.

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
- Reconciled the documentation with the v0.2.1 implementation: security model (two handlers, lease renewal risk, plaintext job data and checkpoints, `availableForMs` disclosure, OS-specific and test-coverage caveats), architecture, protocol (rotate route, renew, no job cancellation), development guide (graceful node drain), resources (implemented telemetry), roadmap summary, deployment status, implementation report (marked as v0.1 history with a v0.2.1 status note and current verification), `.env.example` (four missing variables) and a README status matrix (implemented, tested, partially tested, planned, unsupported). No code or behaviour changes.

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
