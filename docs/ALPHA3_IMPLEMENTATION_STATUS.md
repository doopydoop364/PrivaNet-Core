# Alpha.3 implementation and validation record

Implemented source: **v0.4.0-alpha.3**, protocol **1**. Direct TLS PUT/GET/DELETE and SDK `store`/`fetch`/`delete` work through the same authorized path locally and remotely. The Coordinator handles bounded control metadata and node receipts; chunk bodies travel application ↔ node. Capacity and the listener are separate opt-ins, both disabled by default. Operator and exact wire reference: [DIRECT_TRANSFER.md](DIRECT_TRANSFER.md); design decisions: [PHASE4_DESIGN.md](PHASE4_DESIGN.md#17-40-alpha3-as-built-and-what-changed-from-this-design).

Starting commit: `1d10348e172018917ef31d2c663c975a8468d6f6`. Local branch: `codex/phase4-alpha3-direct-transfer`. Foundation commit: `53758e90d85b8b7fe360a0373e8b466d92b3fee8`; the completion commit follows it on this branch (use `git log` for its hash). No push, PR, npm publication, tag or GitHub release was performed. The supplied checkout's crawler history and pre-existing uncommitted crawler summary changes remain intact and are excluded from the alpha.3 implementation commit.

## Components and decisions

- Existing ChunkStore extended with physical application UUID namespaces and shared quota/capacity accounting; legacy library paths remain readable. No parallel filesystem/control system.
- Closed HTTPS HTTP/1.1 listener, configured literal bind address, TLS 1.2 minimum, canonical endpoint plus certificate DER/fingerprint/private-key possession proof bound to node ID and origin. SDK trusts that exact leaf with normal TLS certificate verification and an exact peer-leaf check; no insecure flag, redirect, ambient proxy or application-selected endpoint.
- Alpha.2 ticket and domain-separated holder messages unchanged. Fresh per-transfer holder keys, random short-lived challenges, persistent write-ahead replay consumption before authenticated begin, current owner/application/node checks and exact declared length/hash enforcement.
- Authenticated begin/check/prepare/fail/receipt routes reuse node sessions. Durable PREPARED intents close the local-commit/receipt crash gap; bounded retries reconcile lost receipts after restart. COMMIT_PREPARED retains reservations for seven days. Completion evidence is idempotent and node authoritative; the application cannot complete PUT.
- GET performs full at-rest verification and independent SDK SHA-256 verification, followed by a signed response-challenge acknowledgement. Kernel write completion alone never completes a GET. The exact already-verified ticket/holder binding can acknowledge an in-progress read after ticket/key retirement; it cannot authorize another transfer.
- Explicit `directTransfer: true` negotiation preserves old strict grant shapes. Migration 3 only adds nullable endpoint JSON; migrations 1/2 and compute session/job response shapes remain unchanged.
- Owner environment overrides saved settings then defaults; policy locks, panel, CLI, config checking, support redaction and aggregate activity/receipt status integrated. Listener status distinguishes local listening from recent Coordinator acceptance of the exact endpoint identity; reachability is not probed.
- Streaming resource limits, bounded cancellable bandwidth waits, live owner changes, private conservative monthly accounting, connection/header/challenge/concurrency bounds and operation/idle timeouts. Restart or malformed state never silently clears replay/accounting/receipt security state.

Supporting fixes discovered during implementation/review: simultaneous initial ChunkStore reservations; final owner checks including idempotent PUT/DELETE; commit-directory durability; live GET acknowledgement/recovery races; signing-key retirement during GET completion; effective environment precedence after loading saved policy; low-bandwidth timer overflow and mid-wait rate changes; dangling monthly-counter links; shutdown after receipt persistence failure; installer cleanup guarding existing deployments; LAN workload sampler cleanup after failure.

## Validation

Linux environment: Node `v24.21.0`, kernel `7.0.2-6-pve`, Intel i5-4590 @ 3.30 GHz, four logical CPUs, 23.38 GiB RAM. Commands below were actually run. Counts count nested tests where the runner does so; separate rows overlap and must not be added together.

| Command | Result |
| --- | --- |
| `npm run lint` | Pass |
| `npm run typecheck` | Pass |
| `npm run build` | Pass |
| `git diff --check` | Pass; no separate formatter script exists |
| `npm test` | 556 tests: 551 pass, 0 failures, 5 expected skips; 196.3 seconds |
| `npm run test:transfer` | 67/67 pass; 0 failures, 0 skipped |
| `node --test tests/dist/completion.test.js` | 19/19 pass; 0 failures, 0 skipped |
| `node --test tests/dist/store-chunk-store.test.js` | 22 pass, 0 failures, 1 root-permission skip |
| `npm run test:unit` | 29/29 pass; 0 failures, 0 skipped |
| `npm run test:integration` | 38/38 pass; 0 failures, 0 skipped |
| `npm run test:multinode` | 8/8 pass; 0 failures, 0 skipped |
| `npm run test:lan` | 10/10 pass; 0 failures, 0 skipped; 4,000-page workload completes after desktop disconnect/reconnect |
| `PRIVANET_REQUIRE_CADDY=1 npm run test:proxy` | 5/5 pass; 0 failures, 0 skipped |
| `scripts/test-installer-isolated.sh` | 18/18 pass; 0 failures, 0 skipped; 32.1 seconds, in a disposable overlay/mount/PID/network namespace |
| `PRIVANET_REQUIRE_LAN=1 npm run test:transfer:lan` | 1/1 pass; 0 failures, 0 skipped; evidence below |
| `PRIVANET_BENCH_OUTPUT=/tmp/alpha3-throughput-final.json npm run test:transfer:bench` | 1/1 pass; 0 failures, 0 skipped; all returned bytes checked |
| `node scripts/package-release.mjs <platform> /tmp/alpha3-release-assets` | All three staged distributions generated; the full suite checks their contents and runs the independent Linux distribution |
| `npm pack --workspace @privanet/protocol --workspace @privanet/shared --workspace @privanet/sdk --pack-destination /tmp/alpha3-release-assets` | All three alpha.3 packages generated |
| `npm publish --workspace @privanet/<package> --access public --tag next --dry-run` | All three metadata dry runs pass; no publication |
| `shellcheck --shell=sh --severity=warning scripts/test-installer-isolated.sh` | Pass |

The normal Linux suite's five expected skips are three Windows-only installer cases, the separately opted-in real-system installer case (run in isolation above), and a filesystem permission denial that root cannot reproduce. Cross-platform CI remains configured for Linux/macOS/Windows on Node 24/26, with mandatory compatibility history and Windows installer checks. Its new mandatory namespace transfer check refuses missing tools/privileges rather than passing by skip. macOS/Windows and hosted CI were **not executed in this local Linux workspace**; no claim of green remote CI is made.

An initial overloaded multi-node/LAN run timed out; rerunning those complete suites without competing workload passed their existing assertions. A documentation anchor regression was repaired and the full suite rerun. No test assertions were weakened to conceal failures.

## Isolated application/node/Coordinator evidence

Host A application `10.77.0.3`; Host B storage node `10.77.0.2`; Host C Coordinator `10.77.0.1`. Three distinct network namespaces/loopbacks/firewalls, shipped staged binaries, node enrollment, storage-authorized application credential, verified Coordinator TLS and pinned direct-node TLS.

The application stores a random 8 MiB chunk with a repeated canary, waits for authoritative STORED metadata, fetches exact bytes/digest, then deletes. Coordinator metadata ends with zero pending/stored/deleting chunks and three completed transfers. PUT+GET directly move **16,777,216 payload bytes**. Test-only instrumentation observes **all Coordinator plaintext HTTP request and response body bytes**, verifies each nonempty body is bounded metadata JSON, and asserts aggregate traffic is less than 1/16 of one chunk; raw/encoded relay of this incompressible chunk would fail that bound. A Host C data-plane packet counter is also checked.

Measured: **Coordinator chunk payload bytes 0**, payload canaries 0, opaque bodies 0, oversized bodies 0; **16,781 metadata bytes in 29 requests**; Host C port-4050 data-plane packet counter 0. The test fails if payload starts passing through the Coordinator. This is measured protocol/body evidence, not a claim that total TLS/IP control traffic is zero.

## Failure and compatibility coverage

| Boundary | Evidence |
| --- | --- |
| Ticket/holder | Existing `transfer-ticket.test.ts` bit-flip, format, size, skew/expiry, rotated-key overlap/retirement and holder substitution tests; direct failure tests exercise forged/modified/unknown/future/expired/node/chunk/operation/application/size grants, stolen tickets, bad proofs and reused challenges |
| TLS/endpoints | Direct SDK pin refusal; canonical endpoint and node/origin/private-key proof substitution; malformed TLS; corrupt key startup refusal; Coordinator certificate registration and safe old-Coordinator fallback |
| Transport | Short/disconnected/stalled PUT, missing/malformed/under/over lengths, partial GET disconnect, missing/bad/early GET acknowledgement, raw malformed HTTP, conflicting lengths, encoding smuggling, oversized headers, closed methods/paths/encodings/ranges; platform parser and configured TLS/header/idle/operation/connection bounds |
| Storage | Alpha.1 property/fault/crash tests retained: max size, quota/reserve edge and mid-stream changes, disk/write failures, integrity, safe paths/links, duplicate and simultaneous writers, abrupt termination; new shared-reservation and final idempotency-owner gate regressions |
| State/recovery | Existing storage-control/HTTP tests for duplicate/reordered/final receipts and begins, abort races and revocation; real transfer lost-receipt/restart reconciliation, GET incomplete delivery, durable replay restart/SIGKILL, corrupt/private/unsafe replay and receipt state, key outages/rotation and persistence failure during shutdown |
| Owner/resources | Disabled capacity/listener, pause/drain/schedule/battery, actual streaming bandwidth/monthly caps/concurrency, active-upload storage disable, changed allowance/rate during waits, low-rate timer overflow, saved/environment precedence, panel/CLI/support controls |
| Compatibility | Existing v0.3.x/alpha.1/alpha.2 tripwires remain; `transfer-compat.test.ts` compiles actual starting alpha.2 schemas and proves strict legacy grants/keys remain readable, direct endpoints require negotiation, and alpha.3 against strict alpha.2 controls executes compute while storage is unavailable |

Host header and DNS are not storage authorization inputs. Endpoint-key proof plus exact peer pin prevents credential-bearing substitution to a host lacking the registered private key; a malicious enrolled node can still cause a bounded unsuccessful TLS connection attempt. Certificate rotation requires fresh registration/grants. Phase 5 possession proof against a malicious node is deliberately absent.

## Throughput

Raw measured artifact: [ALPHA3_THROUGHPUT.json](ALPHA3_THROUGHPUT.json). One measured batch per size/concurrency after warm startup on the shared Linux host described above; real Coordinator/node/SDK in one process on loopback; TLS enabled. PUT includes placement, holder exchange, replay/chunk fsync and authoritative STORED receipt. GET includes complete at-rest hashing, SDK hashing and signed acknowledgement. CPU is aggregate PUT+GET CPU for all three components, not storage-node-only CPU. Independent SHA-256 cost averages 100 hashes; no security-disabled comparison was used. Other host activity and single-batch variability limit generalization; these are observations, not a throughput guarantee.

| Chunk | Concurrency | PUT MiB/s | GET MiB/s | Aggregate CPU ms | SHA-256 ms/chunk |
| --- | --- | --- | --- | --- | --- |
| 1 KiB | 1 | 0.0220 | 0.0303 | 86.3 | 0.0064 |
| 1 KiB | 4 | 0.0442 | 0.0385 | 251.2 | 0.0055 |
| 64 KiB | 1 | 3.0019 | 2.5927 | 48.5 | 0.1435 |
| 64 KiB | 4 | 2.9733 | 2.5088 | 245.6 | 0.1419 |
| 8192 KiB | 1 | 69.2282 | 52.4841 | 396.2 | 18.0673 |
| 8192 KiB | 4 | 72.3085 | 66.5904 | 1357.0 | 17.9979 |

Small chunks are dominated by authorization/TLS/durability round trips. At 8 MiB, one SHA-256 pass costs about 18 ms on this host; GET deliberately performs both node and application integrity checks. The measured end-to-end numbers include those costs and are not an isolated estimate of their effect on network throughput.

## Final adversarial review

After the fixes listed above, two complete internal review passes trace application credential → placement/ticket → endpoint identity → TLS → key lookup/ticket → holder challenge → durable replay → authenticated begin → owner gates/ChunkStore → durable receipt → Coordinator completion. The first checks each authority, scope, parser, pin, path and byte bound; the second repeats the trace emphasizing TOCTOU, abort/revocation, key retirement, partial reads, restart/commit gaps, queue bounds/backoff, corruption, shutdown and secret exposure. Both final passes found no new actionable correctness, reliability or security defect. Regression tests and namespace measurements support specific properties. This is **not** independent external review or proof of vulnerability-free software.

## Limits and validation incident

No replication/repair/possession challenge, PrivaDrive file/folder/sharing/encryption semantics, arbitrary filesystem API, general relay/NAT traversal, market/payment/accounting or automatic certificate management. A node state directory has one process owner. Definitively rejected or seven-day-expired receipts retain local data charged against quota; garbage collection/repair is later work. Certificate renewal requires owner action, and old grants fail safely. Owner limits can refuse an otherwise valid ticket. A completion timeout can mean committed local data awaiting metadata acknowledgement. Database downgrade requires an older backup. Cross-platform hosted CI and independent external security review remain outstanding.

During validation, the pre-existing real-system installer test's failure cleanup purged an existing alpha.2 installation on this host. Its original identity, enrollment, program version and configuration were restored from the pre-upgrade backup, and the node was verified running and completing jobs. Recent local usage/history may have reverted to that backup. This was disclosed during the task. The test now checks for existing deployment/account **before registering purge cleanup**; subsequent real-system tests run inside the disposable overlay/PID/network wrapper. Alpha.3 was not deployed to that existing installation.

## Exact source/version changes

Authoritative versions set consistently to `0.4.0-alpha.3`: root `package.json` and `package-lock.json`; `apps/coordinator/package.json`, `apps/node/package.json`; `packages/protocol/package.json`, `packages/shared/package.json`, `packages/sdk/package.json`; `SERVICE_VERSION` in `packages/protocol/src/index.ts`. Internal workspace dependency pins and lockfile entries match. `PROTOCOL_VERSION` stays 1.

Changed or added alpha.3 files across the foundation and completion work (unrelated owner crawler changes excluded; only the alpha.3 section of CHANGELOG is included):

- `.env.example`
- `.github/workflows/ci.yml`
- `CHANGELOG.md`
- `README.md`
- `ROADMAP.md`
- `apps/coordinator/package.json`
- `apps/coordinator/src/migrations.ts`
- `apps/coordinator/src/server.ts`
- `apps/coordinator/src/storage.ts`
- `apps/coordinator/src/store.ts`
- `apps/node/package.json`
- `apps/node/src/config-check.ts`
- `apps/node/src/daemon.ts`
- `apps/node/src/effective-settings.ts`
- `apps/node/src/local-cli.ts`
- `apps/node/src/local-control.ts`
- `apps/node/src/main.ts`
- `apps/node/src/panel-page.ts`
- `apps/node/src/panel.ts`
- `apps/node/src/privacy.ts`
- `apps/node/src/resource-policy.ts`
- `apps/node/src/store/chunk-id.ts`
- `apps/node/src/store/chunk-store.ts`
- `apps/node/src/store/key-cache.ts`
- `apps/node/src/store/receipt-queue.ts`
- `apps/node/src/store/replay-state.ts`
- `apps/node/src/store/service.ts`
- `apps/node/src/store/status.ts`
- `apps/node/src/store/transfer-config.ts`
- `apps/node/src/store/transfer-service.ts`
- `apps/node/src/support-bundle.ts`
- `apps/node/src/transfer-meter.ts`
- `deploy/env/node.env.example`
- `docs/ALPHA3_IMPLEMENTATION_STATUS.md`
- `docs/ALPHA3_THROUGHPUT.json`
- `docs/APPLICATION_BOUNDARY.md`
- `docs/DATA_PLANE.md`
- `docs/DIRECT_TRANSFER.md`
- `docs/INSTALLER.md`
- `docs/NODE_CONTROL_PANEL.md`
- `docs/PHASE4_DESIGN.md`
- `docs/RESOURCES.md`
- `docs/architecture.md`
- `docs/deployment.md`
- `docs/protocol.md`
- `docs/security.md`
- `package-lock.json`
- `package.json`
- `packages/protocol/package.json`
- `packages/protocol/src/index.ts`
- `packages/sdk/package.json`
- `packages/sdk/src/chunk-transfer.ts`
- `packages/sdk/src/index.ts`
- `packages/shared/package.json`
- `packages/shared/src/index.ts`
- `packages/shared/src/transfer-endpoint.ts`
- `scripts/test-installer-isolated.sh`
- `tests/completion.test.ts`
- `tests/core.test.ts`
- `tests/direct-transfer-failures.test.ts`
- `tests/direct-transfer-rig.ts`
- `tests/direct-transfer.bench.ts`
- `tests/direct-transfer.netns.ts`
- `tests/direct-transfer.test.ts`
- `tests/installer.test.ts`
- `tests/lan-workload.netns.ts`
- `tests/panel.test.ts`
- `tests/services-protocol.test.ts`
- `tests/storage-migration.test.ts`
- `tests/storage-policy.test.ts`
- `tests/store-chunk-store.test.ts`
- `tests/transfer-audit.mjs`
- `tests/transfer-compat.test.ts`
- `tests/transfer-key-cache.test.ts`
- `tests/transfer-receipt-queue.test.ts`
- `tests/transfer-replay-state.test.ts`
