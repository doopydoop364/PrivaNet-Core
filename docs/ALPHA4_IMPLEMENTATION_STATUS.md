# Alpha.4 implementation and validation record

Source **0.4.0-alpha.4**, protocol **1**. Started on clean `main` at `29ad9037a856fbc3b12d611a6528c84c223f26d0`; candidate branch `codex/phase4-alpha4-storage-hardening`. Final commit IDs and command results are recorded in the final release report. Merged `origin/main` at `3b0c31b` (alpha.3.1), retaining its Core crawler diagnostics, tests, roundup adapter and observability documentation. No PrivaSearch repository files were changed. No package publishing, GitHub release, main merge or production deployment was performed.

## Implemented

Explicit local store and listener lifecycle, recent exact endpoint/certificate Coordinator acceptance, offline UNKNOWN semantics and deprecated null networkAccessible; capacity planning accounting for unwritten reservations; fixed actionable TLS/key/bind/security-state/owner/Coordinator diagnostics; per-storage-field effective sources/locks/overrides; exact human-size controls and explicit reserve-reduction confirmation; private versioned P-256 IP-SAN certificate generation/renewal; operator-initiated ticket-free pinned TLS probe; negotiated detailed Coordinator pool view including retained offline holders; no-crash compute startup on optional transfer configuration failure; private atomic policy backups that cannot follow a backup symlink; documentation, upgrade/rollback and real-machine validation script/checklist.

## State and compatibility

No migrations or durable format changes. Coordinator migration history, node identity/enrollment, chunk layout, policy wrapper, replay, receipts and monthly meter remain intact. Protocol remains 1. Alpha.3 SDK ticket/grant flow unchanged; shared TLS options used by SDK and probe preserve exact leaf trust/pin and no redirects/proxy. Original strict storage summary remains default; new CLI opts into `?details=1`. Local status boolean consumers must adapt to explicit states and null networkAccessible. New status fields are local, not extra compute/session wire fields.

## Validated automatically

Combined-source lint, typecheck, build, unit, integration, multinode, direct-transfer, benchmark, installer and packaging checks passed. Full suite: 580 passed, 2 environment-dependent failures, 7 skipped; the focused combined/upgrade/release run: 55 passed, 1 skipped. See [final report](ALPHA4_RELEASE_REPORT.md) for exact commands, blocked facilities and review evidence. The automated upgrade scenario builds actual alpha.3 and alpha.3.1 source and writes a committed chunk with its ChunkStore, then reads it with alpha.4. This proves that store format property; it does not alone prove service-manager or physical hardware upgrade behavior. Existing adversarial and compatibility tests are retained.

## Validated manually

No real physical-machine or human browser validation was performed. No Windows/macOS portable-device, systemd service or power-loss validation is claimed. The available environment is one Linux host; separate process tests are automated.

## Not validated and known limitations

Real A/B/C LAN deployment, public/NAT reachability, cross-platform hosted CI and independent external security review remain outstanding. Namespace and privileged installer isolation require capabilities this environment may not provide; exact failures/skips are reported with final commands. A probe proves one TLS handshake from the operator machine, not successful authorization or reachability from every application; it is not a continuously persisted reachability claim. Recent status may lag a stopped daemon by at most the existing 35-second snapshot window. Certificate generation requires OpenSSL and a private node-owned state directory; Windows secrecy relies on installed ACLs. Maximum owner storage policy remains 1 TiB. No arbitrary store-directory control is added. Multi-process ownership of one node state directory remains unsupported.

Disabling storage/listener aborts network activity and keeps committed data. Overcommit refuses new writes and keeps chunks; no automatic eviction or quota repair. Lost/definitively rejected receipts may retain quota-charged orphan data under alpha.3 semantics. Lifetime local throughput counters reset with the process; Coordinator retained metadata and durable receipts remain authoritative for recovery. The single SQLite Coordinator and node assertions are not high availability or malicious-node possession evidence.

## Deferred Phase 5

Replication, node-to-node authorized transfer, repair queues, possession challenges, failure-domain placement, rebalancing, graceful storage retirement, scrubbing policy/soak hardening and garbage collection. PrivaDrive semantics/encryption, credits/market/treasury, general relay and automatic public certificate issuance are also excluded.

## Internal review

Three consecutive internal reviews of the changed storage/data-plane paths found no new actionable defect after the earlier fixes: operator/compatibility semantics, adversarial/durability behavior, and lifecycle/release interactions. These were performed by the implementing agent, not an independent reviewer. The final report records scope and regression evidence. Passing tests and clean internal review do not prove absence of vulnerabilities and are not an independent security review.
