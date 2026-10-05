# PrivaNet Core 0.4.0-alpha.4 release-candidate report

Prepared 2026-10-05 UTC. Candidate only: no packages published, GitHub release created, merge to main or production deployment performed. Phase 5 remains deferred. PrivaSearch repository was not edited.

## Source and integration

Started on clean `main` at `29ad9037a856fbc3b12d611a6528c84c223f26d0` (alpha.3). Final candidate branch: `codex/phase4-alpha4-storage-hardening`.

Implementation commits: `358f771` (operations and observability), `965d12b` (lifecycle/durability fixes), `35dfd03` (docs and regressions), merge `b38000f` (alpha.3.1), `507cd15a2aa024662f8e5b4c5dc76a40cdcb8305` (alpha.3.1 upgrade coverage). A final documentation commit records this report. Alpha.3.1 `main` at `3b0c31b` is an ancestor of the candidate. Its fetch handler, robots code, roundup adapter, regression tests and crawler-observability document match that main commit exactly. Conflict resolution retained both changelog entries and alpha.4 version metadata.

## Features and defects fixed

- Explicit store, listener lifecycle, bind/port/endpoint, recent exact Coordinator endpoint/certificate acceptance and UNKNOWN remote reachability. CLI uses a recent private daemon snapshot; offline status reports UNKNOWN instead of falsely reporting network failure. Future/stale snapshots are refused. Deprecated `networkAccessible` is null, requiring boolean consumers to adapt.
- Stable actionable TLS, key, bind, replay/receipt, quota/reserve, owner-state and Coordinator diagnostic codes. Missing/unsafe/foreign-owned/symlinked/mismatched keys, invalid/expired/future certificates and unreadable special files fail safely. SAN mismatch is informational under the existing exact-leaf-pinning identity rule.
- Removed optional transfer configuration's early process exit, so compute continues after storage listener failure. Real daemon regression completes compute with an occupied transfer port. Failed optional storage offers are withheld.
- Per-field effective policy sources, saved values, environment overrides and locks. Running settings/support use the daemon's actual retained policy and environment rather than a shell's overrides or a corrupt-file fallback. Invalid origins are redacted in settings.
- Safe storage enable/disable, exact KiB/MiB/GiB/TiB capacity/reserve and transfer controls; policy validation precedes writes, unrelated settings/backups are preserved, environment locks respected. Reserve reduction needs explicit CLI flag/panel confirmation. Existing owner-policy ceiling is 1 TiB. Live policy changes need no restart; changes to existing certificate file contents require restart, while generated renewal changes paths and is applied live.
- Capacity planning exposes quota room, filesystem headroom, incoming/unwritten reservations, usable bytes, reserve constraints and overcommit. Reducing quota or disabling storage retains chunks and refuses inappropriate new writes; re-enable/restart restores existing data.
- Versioned node-local OpenSSL P-256 IP-SAN certificate generation/renewal with private atomic publication, expiry and fresh-registration/grant guidance. Existing material is retained. An uncertain policy-save outcome retains generated key material rather than deleting possibly referenced files.
- Explicit admin-side ticket-free bounded TLS endpoint probe with the SDK's shared exact pinning, registered node binding, before/after registration check, DNS/TCP/TLS error classes and zero HTTP/chunk payload. Coordinator returns metadata only and never probes arbitrary endpoints itself.
- Negotiated detailed pool reporting preserves strict legacy summary shapes, retains offline holder counts, excludes stale usable offers, exposes reserved/committed/open/recent transfer totals and exact large aggregate sums (decimal strings beyond JSON safe integer range).
- Private-state readers enforce bounded descriptor reads, descriptor ownership/permissions, file identity and no-follow/nonblocking behavior. Policy backups atomically replace a hostile `.bak` symlink instead of following it, normalize permissions and persist policy/backup directory entries.
- Listener shutdown closes sockets/store even when receipt persistence fails; invalid config clears stale endpoint/bind metadata while disabled valid config retains useful configured fields. Endpoint rejection differs from unsupported Coordinator fields and service/gateway failure.
- LAN SDK validation helper cleans up its temporary authorized chunk if restart-state publication fails; persisted invalid endpoint metadata becomes a stable operator error instead of an internal error.
- Alpha.3.1 fixes retained: robots negative-cache HTTP/transport/Retry-After diagnostics, conservative robots-429 handling, and Search operational health/concentration forwarding through the roundup adapter.

## State, security and compatibility

All packages/internal pins/lockfile/service constants use `0.4.0-alpha.4`; `PROTOCOL_VERSION = 1`. No new Coordinator migrations or durable store/policy/replay/receipt formats. Existing identities, enrollment and application credentials are retained. No contributor re-enrollment required.

Automated upgrade builds actual alpha.3 and alpha.3.1 source, writes chunks/state with those implementations, then opens them with alpha.4. Tests verify committed chunks, identity, Coordinator/application/chunk metadata and replay protection, plus each previous SDK's direct store/fetch/delete roundtrip. Legacy strict storage summaries and older compute compatibility tests remain passing. This does not establish service-manager or real-hardware upgrade safety.

Coordinator placement, endpoint possession proof, exact TLS pinning, scoped tickets/holder proof/replay protection, hash/size verification, quota/free-space checks and durable reconciliation remain in force. No generic file browser/server, arbitrary path API, redirects, proxy environment, unrestricted CORS or bulk-data relay was added.

## Commands and results

`npm run lint`, `npm run typecheck` and `npm run build`: PASS. `git diff --check`: PASS. `git merge-base --is-ancestor origin/main HEAD`: PASS. `git diff origin/main --` the alpha.3.1 code/tests/docs/adapter paths: empty.

`npm test`: 589 tests, 580 passed, 2 failed, 7 skipped, about 205.7 seconds. This run began before the additional alpha.3.1 fixture was added; the final focused run separately validates that extra fixture.

| Command | Result | Details |
| --- | --- | --- |
| `npm run build` | PASS | exit 0 |
| `npm run test:unit` | PASS | 29 tests, 29 pass, 0 fail, 0 skipped |
| `npm run test:integration` | PASS | 38 tests, 38 pass, 0 fail, 0 skipped |
| `npm run test:multinode` | PASS | 8 tests, 8 pass, 0 fail, 0 skipped |
| `npm run test:lan` | SKIPPED; not validated | 10 tests, 0 pass, 0 fail, 10 skipped |
| `npm run test:transfer` | PASS | 67 tests, 67 pass, 0 fail, 0 skipped |
| `npm run test:transfer:lan` | SKIPPED; not validated | 1 tests, 0 pass, 0 fail, 1 skipped |
| `npm run test:transfer:bench` | PASS | 1 tests, 1 pass, 0 fail, 0 skipped |
| `npm run test:proxy` | SKIPPED; not validated | 5 tests, 0 pass, 0 fail, 5 skipped |
| `npm run test:installer` | PASS | 18 tests, 17 pass, 0 fail, 1 skipped |
| `sh scripts/test-installer-isolated.sh` | BLOCKED | missing shellcheck; namespace capability denied separately |

Final combined focused command:

```sh
node --test --test-concurrency=1 tests/dist/alpha4-storage.test.js tests/dist/fetch-handler.test.js tests/dist/roundup.test.js tests/dist/release.test.js
```

55 passed, 0 failed, 1 skipped (foreign ownership cannot be created in this sandbox). Includes both actual previous-release upgrades, retained crawler tests and all-platform package isolation.

Adversarial/durability review command:

```sh
node --test --test-concurrency=1 tests/dist/direct-transfer-failures.test.js tests/dist/transfer-replay-state.test.js tests/dist/transfer-receipt-queue.test.js tests/dist/transfer-key-cache.test.js tests/dist/support-bundle.test.js tests/dist/storage-policy.test.js tests/dist/storage-admin.test.js
```

74 passed, 1 environment-dependent `/proc` failure. Assertions were not weakened. Final command `node --test --test-concurrency=1 tests/dist/alpha4-storage.test.js tests/dist/storage-admin.test.js tests/dist/direct-transfer.test.js`: 46 passed, 0 failed, 1 skipped. Final `node --test tests/dist/release.test.js`: 4 passed, 0 failed.

Packaging: `node scripts/package-release.mjs PLATFORM OUT` for linux, macos and windows; tar.gz/zip archives plus version-stamped installers and SHA256SUMS. `npm pack --dry-run --json --workspace PATH` for protocol/shared/sdk/coordinator/node: all five passed. The release regression stages all platforms and exercises the portable distribution without repository module resolution. Windows/macOS native execution is not validated here.

### Environment failures/skips

1. Panel non-loopback-interface test: `os.networkInterfaces()` raises ERR_SYSTEM_ERROR (`uv_interface_addresses`, error 1). Independently reproduced by a standalone Node invocation.
2. Node no-storage-socket test: reading `/proc/<live-child>/fd` raises ENOENT. Independently reproduced while the child is alive.
3. LAN suites: 10 and 1 tests skipped because `iptables` is absent. `unshare --mount --pid --net --fork true` independently fails with Operation not permitted.
4. Proxy suite: 5 tests skipped because Caddy is absent.
5. Installer suite skips its real service-account/system mutation test unless PRIVANET_INSTALLER_SYSTEM=1. The safe isolation wrapper stops at missing shellcheck; namespace denial would also prevent isolated execution. Earlier isolation attempts also recorded namespace denial. No host installation was performed to bypass isolation.
6. Root directory-permission and foreign-ownership fixtures cannot exercise all native permission cases here. Exact skipped cases are in logs.

## Internal review record

After earlier implementation/fix rounds, three consecutive internal changed-path reviews found no new actionable correctness, security, durability or reliability defect. Each checked store/quota/reserve, listener apply/stop and owner gates, ticket/holder/replay/receipt paths, endpoint/TLS/client invariants, policy/backup/secret handling, daemon/CLI/panel/support reporting, Coordinator metadata, compatibility and validation/release code.

- Pass 1: integrated-source/operator/compatibility review; alpha.3.1 preservation and combined tests.
- Pass 2: adversarial/durability review; bounded no-follow file handling, backup publication, replay/receipt fail-closed behavior, endpoint pinning/probe authentication, retained chunks and shutdown failure paths; adversarial tests above.
- Pass 3: lifecycle/release review; runtime versus offline authority, stale offers/snapshots, disabled/failed listener metadata, restart/capacity behavior, old SDK/state, smoke-helper cleanup, package/docs/version consistency; final focused rerun.

These reviews are by the implementing agent. They are not independent security review and do not prove absence of vulnerabilities. Blocked tests remain blocked; clean review does not turn a skipped validation into a pass.

## Performance

Combined-source loopback TLS benchmark, Node v24.19.0/Linux on shared AMD EPYC environment: 8 MiB chunks, concurrency 1, approximately 90.0 MiB/s PUT and 90.8 MiB/s GET; concurrency 4, approximately 133.4 MiB/s PUT and 103.8 MiB/s GET. Full rows/methodology are in benchmark log. One measured batch after warmup; includes hashing, durable replay/chunk operations, authorization and receipts. No matched alpha.3 baseline was measured, so no improvement/regression claim. These are not LAN or deployed server measurements.

## Manual validation and readiness

No actual three-machine LAN, human browser, service-manager, physical power-loss, public/NAT or native Windows/macOS validation was performed. Separate-process SDK/daemon tests are automated. Use ALPHA4_LAN_VALIDATION.md for the 20-step A/B/C checklist, including independently measuring Coordinator no-payload-relay behavior. Successful loopback tests alone do not prove actual LAN reachability.

Candidate is ready for hosted CI and real-deployment review; it is not declared fully deployment-validated or unconditionally ready to publish. Run blocked tests on a suitable host/CI and perform the requested actual LAN checklist before making that claim.

## Upgrade and rollback

See ALPHA4_UPGRADE.md. Back up Coordinator database/keyring/config and the stopped node's complete state including chunks, identity, replay/receipts and TLS keys. Keep old binaries; switch only the program link and restart Coordinator then node with existing config/state. Verify protocol/version/identity, live status, exact advertisement, explicit probe and SDK roundtrip. No re-enrollment. Generated certificate renewal needs fresh registration/grants.

Rollback: stop activity gracefully, retain a fresh complete backup, restore previous alpha.3/alpha.3.1 binaries with current state/config. No new migration to undo. Retain valid TLS paths. Never replace newer replay/receipt state with historical snapshots casually. Do not downgrade below alpha.3 without the older release's migration backup procedure.

## Known limitations and deferred work

Snapshot status can lag a stopped daemon up to 35 seconds. Probe establishes one operator-to-endpoint TLS handshake, not universal reachability or authorization. OpenSSL and private service-owned state required for generation; Windows key secrecy relies on installed ACLs. Shared multi-process node-state ownership is unsupported. Capacity ceiling stays 1 TiB. Lifetime local transfer counters reset at process restart. Lost/definitively rejected receipts can retain quota-charged orphan chunks under existing alpha.3 semantics; no automatic garbage collection was added.

Phase 5 replication, repair, node-to-node transfer, possession challenges, placement failure domains, rebalancing, graceful storage retirement, scrubbing/soak hardening and garbage collection remain deferred. No automatic public certificate issuance, NAT traversal, relay, PrivaDrive encryption/semantics or resource-credit market.

## Release publication follow-up

The first hosted run passed Linux Node 24/26, multi-node, privileged LAN/direct-transfer, Caddy proxy and real Linux installer jobs. macOS exposed a compute fixture depending on busy-runner default resource reserves; its policy now explicitly permits the fixture workload and allows a bounded 45-second completion window. Windows exposed dependence on the machine OpenSSL configuration; certificate generation now supplies its own minimal configuration. Hosted revalidation is required before merging.

The owner additionally requested a bundled systemd automatic updater. The opt-in daily timer checks all supported detected or explicitly registered installations, verifies immutable release archives and checksums, backs up state/configuration while services are stopped, and rolls back program symlinks on restart failure without restoring stale replay state. Eight Python security/rollback tests cover this path. Apps without compatible published assets are reported and retained. See AUTOMATIC_UPDATES.md.

A package.json version change merged into main now invokes the existing validated release workflow, deriving the tag from the checked-out version and publishing at the exact built commit. Tag and manual triggers remain supported.
