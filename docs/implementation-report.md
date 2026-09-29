# Implementation report (v0.1 delivery, updated for v0.2.1)

**Current status (v0.2.1):** Phase 1 (Core Foundation) and Phase 2 (Adaptive Resource Engine) are implemented and released; nothing later is. Two job types exist: `system.echo.v1` and `system.hashchain.v1`. The sections below describe the **original v0.1 delivery** and are kept as history; where they say "the only registered job is `system.echo.v1`" or describe one-slot echo-only behaviour, read them together with this note, [the changelog](../CHANGELOG.md), [resources](RESOURCES.md) and [security](security.md), which describe the current behaviour. The status matrix in the [README](../README.md#status-and-limits) lists what is implemented, tested, partially tested, planned and deliberately unsupported.

## Repository inspection

PrivaNet began with an empty tracked README in commit `92d5ee1` on `main` and
the configured remote `https://github.com/doopydoop364/PrivaNet-Core.git`.
There were no implementation files, repository instructions, ignore rules, or
development documentation. PrivaDrive and Privaproxy were inspected read-only.

PrivaDrive uses Node 24+, ESM, built-in tests, SQLite migrations, and separate
Drive/network concerns. Its architecture supports the decision that Drive must
eventually consume generic PrivaNet storage APIs while retaining file metadata,
sharing, and encryption semantics. Privaproxy uses Node/Express, application
routes, a product-specific password/session gate, and proxy credentials. Those
credentials and sessions are not suitable as PrivaNet node or application
identity. Neither reference repository was modified.

## Delivered foundation

The repository now contains:

- `packages/protocol`: strict Zod wire schemas, protocol version 1, capability
  and job registries, typed echo input/output, status, lease, and error models.
- `packages/shared`: Ed25519 identity helpers, hashing and constant-time secret
  comparison, private state-file checks, bounded HTTPS/loopback transport, and
  protocol response validation.
- `packages/sdk`: application client for health, capabilities, typed submission,
  idempotency, status polling, cancellation, and bounded result waiting.
- `apps/coordinator`: HTTP control plane, scoped admin/application/node roles,
  enrollment and challenge-response authentication, heartbeats, health states,
  capability-aware FIFO scheduling, lease fencing, retries, revocation, SQLite
  persistence, immutable checksummed migrations, and configuration validation.
- `apps/node`: persistent Ed25519 identity and Coordinator binding, enrollment,
  session authentication, heartbeats, polling, the fixed `system.echo.v1`
  handler, and bounded retry/backoff behavior.
- `scripts/admin.mjs` and `scripts/demo.mjs`: private local operator setup and
  end-to-end demonstration commands.
- `docs/architecture.md`, `docs/protocol.md`, `docs/security.md`,
  `docs/development.md`, and `docs/roadmap.md`.
- `.github/workflows/ci.yml`: Node 24/26 matrix on Linux, Windows, and macOS.

No PrivaSearch, PrivaDrive storage, replication, PrivaCredits, arbitrary
compute, shell execution, script execution, binary download, container
execution, or anonymous proxying was added.

## Protocol and security decisions

Every request and response carries protocol version 1. Incompatible versions
fail with `426 PROTOCOL_MISMATCH`. Strict schemas reject unknown fields and
unsupported job types/capabilities. The only registered job is
`system.echo.v1` (v0.1; `system.hashchain.v1` was added in v0.2.1); handlers are compiled into the node and accept only bounded, schema-validated input.

Nodes generate persistent Ed25519 keys locally. Their stable ID is derived from
the canonical public key. Enrollment requires an expiring one-use administrator
grant, a fresh Coordinator challenge, and a signature proving private-key
possession. Grants, sessions, and application credentials are stored as hashes;
raw private keys, tokens, and secrets are never logged. Node sessions, grants,
challenges, and application credentials are independently scoped and revocable.

Heartbeat state derives ONLINE, STALE, OFFLINE, and REVOKED from Coordinator
receipt time. The scheduler requires ONLINE status, a matching capability, and
an available slot. Jobs use `QUEUED → LEASED → COMPLETED | FAILED`; lease IDs,
expiration, attempt limits, and transaction boundaries fence late and duplicate
results. Expired work is requeued only within the configured retry limit.

The Coordinator is a control plane for bounded JSON. Future large data paths
can be authorized separately and need not pass through it. Local nodes use the
same SDK and authenticated protocol as remote nodes. SQLite is a development
adapter behind a persistence port; PostgreSQL remains a future adapter choice.

Known limitations at v0.1 (still true unless the current documents say otherwise): no mTLS or per-message signatures,
no key-recovery wizard, no execution attestation, no malicious-worker isolation,
no public enrollment, no Sybil/reputation/accounting system, and no production
HA or distributed storage guarantees.

## Verification

v0.1 was verified on Node `v26.10.0` (39 tests at the time). For v0.2.1 the release
gate is `npm ci`, `npm run lint`, `npm run typecheck` and `npm test` (build plus **94
tests**, including the release-readiness tests in `tests/release.test.ts`, the
seeded randomised lifecycle test in `tests/reliability.test.ts` and the
upgrade-compatibility checks), green on Linux, macOS and Windows with Node 24 and 26
in CI, and re-run by the release workflow before packaging. The final local run for
this documentation pass was on Node 22 in a Linux sandbox; the Node 24.4+ requirement
is enforced by CI, not by that local run.

What this does **not** show: real-hardware behaviour of the macOS and Windows battery
probes and Windows console signals, behaviour under real application workloads or
adversarial nodes, restore on other hosts, or any independent security review.

The process integration test starts the real Coordinator and PrivaNode, obtains
credentials through the admin command, runs the SDK demo, restarts both services,
verifies the same node identity and persisted application/job behaviour, and drains
the node through the portable `DRAIN` file (and SIGTERM on POSIX). A further test runs
the staged release distribution from outside the repository.

## Git handoff

The original implementation landed in commit `0e891ba`. A later audit
(branch `claude/admiring-noether-msb69g`) made job types registry-driven: wire
schemas, capability lists and result validation derive from `JOB_TYPES`, and a
test keeps node handlers in lockstep with the registry. Generated `dist/`,
SQLite state, logs, identities, and secrets are ignored.

## Open items carried out of v0.1

Update (v0.2.1): the reverse-proxy/TLS review is written up in [deployment](deployment.md) (it found that per-address authentication limits collapse onto the proxy's address, so the limit is now configurable and per-client limiting belongs at the proxy), `npm run backup` and a restore test exist, and job retention and a per-application queue quota were added. Node-key rotation (revoke and re-enroll works today) and the PostgreSQL adapter moved to later phases. An **independent** security review still needs people outside this project and is tracked in Phase 11.
