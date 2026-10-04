# Alpha.3 implementation status

Status: **incomplete; not release-ready**. No direct transfer listener, pinned SDK transfer, authoritative receipt queue or reconciliation path has been delivered. Version remains `0.4.0-alpha.2` so the source does not advertise the requested milestone prematurely.

Starting checkout: `1d10348e172018917ef31d2c663c975a8468d6f6`, also the locally cached `origin/main`. Branch: `codex/phase4-alpha3-direct-transfer`. The uncommitted crawler-roundup changes in `CHANGELOG.md`, `deploy/bin/privanet-roundup-api`, `docs/PRIVASEARCH_INTEGRATION.md` and `tests/roundup-summary.py` predate this task and are preserved.

Implemented foundations:

- `apps/node/src/store/replay-state.ts`: bounded persisted transfer-ID consumption, checksum/strict format validation, private atomic snapshots, POSIX directory flush, expiry/skew cleanup, batching and refusal after persistence failure. The future listener must await consumption before an operation. Single-process ownership is required.
- `apps/node/src/store/key-cache.ts`: Coordinator identity binding, public-key/kid validation, periodic and unknown-key refresh, single-flight throttling, bounded outage backoff and retention of cached keys during temporary disconnection.
- `apps/node/src/daemon.ts`: cache integration into storage-offering heartbeats and an unknown-key refresh hook. Existing ticket and holder proof formats are unchanged.
- New tests cover concurrent replay consumption, restart, signed-ticket replay after reopening, bounds, expiry/skew, corrupt/unsafe state, I/O failure, abrupt process exit, refresh flooding, rotation overlap, disconnects and Coordinator/key substitution.

Environment: Linux, Node `v24.21.0`. GitHub fetch failed with `Could not resolve host: github.com`, so latest remote main cannot be verified. Real test server binds fail with `listen EPERM: operation not permitted 127.0.0.1`. A minimal child-process I/O probe also reports `EPERM`. The managed environment does not offer an allowed sandbox escalation. Network validation, isolated three-host E2E and throughput measurement cannot be certified here. Tests have not been weakened or skipped to conceal those failures.

Validation performed on the foundations:

| Command | Result |
| --- | --- |
| `npm run lint` | Pass |
| `npm run typecheck` | Pass |
| `npm run build` | Pass |
| `git diff --check` | Pass |
| `node --input-type=module -e 'await import("./tests/dist/transfer-key-cache.test.js"); await import("./tests/dist/transfer-replay-state.test.js"); await import("./tests/dist/transfer-ticket.test.js");'` | 35 tests: 34 pass, 1 fail, no skips. The failed abrupt-process test received no child output; subprocess I/O is restricted. |
| `npm test` | Failed: runner reports 49 files, 25 pass, 24 fail, no skips. Socket/subprocess permission errors and native runner assertions were observed; this is not a successful full-suite validation. |
| `npm run test:unit` | Runner reports 3 files pass. |
| `npm run test:integration` | Failed: both files fail. |
| `npm run test:installer` | Failed: installer test file fails. |

The ordinary runner exposes file-level outcomes in this environment rather than individual child-test counts. The targeted in-process run reports actual individual tests. There is no formatter script configured. Package and compatibility tests are part of `npm test`; no completed alpha.3 compatibility, package, E2E or benchmark result is claimed. No macOS/Windows CI run or two-clean-pass review of a complete transfer path has occurred. No release/version files have been changed, no branch has been pushed, and no PR or release has been created.

Before releasing alpha.3, complete every item in the original milestone: verified latest main, opt-in TLS listener and registration, pinning, live ticket/holder/replay checks, authenticated begin/fail/complete, durable receipt queue and reconciliation, streaming PUT/GET/DELETE, owner policy/panel/CLI/resource controls, SDK store/fetch/delete, mixed-version coverage, failure matrix, isolated three-host traffic measurement, throughput benchmarks, full validation on CI platforms, two consecutive clean reviews of the entire implemented transfer path, documentation and consistent release versioning. The Coordinator must continue to carry metadata only; local storage use must follow the same authorized path. Replication/repair and possession challenges remain Phase 5, application file semantics remain outside Core, and NAT traversal/relay is not included.
