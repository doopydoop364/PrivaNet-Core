# Protocol v1

All routes use `/v1/`; clients send `X-PrivaNet-Protocol: 1`, and responses return
that header. Strict schemas reject extra fields, malformed identifiers,
unsupported capabilities/types and payloads. Version mismatch is HTTP 426 with
`PROTOCOL_MISMATCH`; no silent fallback. Health exchanges protocol/service version
and persisted coordinator ID; heartbeat/enrollment carry daemon version and
capabilities. Schema job version is in the identifier `system.echo.v1`.

Compatibility policy: within protocol 1, wire changes are **additive and optional** (v0.2 added optional heartbeat `lifecycle`/`resources`, the `release` and `goodbye` routes, and new node statuses). Older nodes keep working against a newer Coordinator; a newer node's extra fields are rejected by an older Coordinator's strict schema with a clear 400, and anything non-additive bumps the protocol number and fails with 426.

HTTPS is required except explicit opt-in HTTP to literal loopback addresses for
local development. No credential URLs, redirects, caller-supplied paths or
inbound node listener. Request and response size/time are bounded. Browser
cookies/CORS are not part of this machine-client API.

## Roles and routes

| Role | Routes |
| --- | --- |
| Public | GET health; POST enrollment challenge/proof, node auth challenge/proof |
| Admin bearer | POST admin/enrollment-tokens, admin/applications; GET admin/nodes; POST admin/nodes/:id/revoke, admin/applications/:id/revoke |
| Scoped application bearer | GET capabilities; POST jobs; GET jobs/:id (own jobs only) |
| Node session bearer | POST node/heartbeat, node/goodbye, node/jobs/lease, node/jobs/:id/complete, node/jobs/:id/fail, node/jobs/:id/release, node/jobs/:id/renew |

Admin bootstrap is a high-entropy environment secret. Application secrets are
random and returned once, hash-only in the DB; allowed job types and revocation
are persisted. Applications see their own jobs and aggregate availability, not
node identities. Nodes cannot use app/admin APIs and vice versa.

## Identity and enrollment

1. Administrator creates a bounded-expiry, one-use token with capability ceiling.
2. Node generates an Ed25519 key with Node crypto; private key remains local in
   owner-only state. Stable ID is `node_` plus SHA-256 of canonical public SPKI DER.
3. Enrollment challenge presents token, SPKI public key, protocol/service version
   and operator-enabled capabilities. Coordinator validates the grant and creates
   a random expiring proof message bound to coordinator, purpose, node and nonce.
4. Node signs exactly the returned proof message; Coordinator verifies Ed25519
   possession and transactionally consumes grant and challenge, registers node,
   and issues a random short-lived bearer session (hashed in DB).
5. Later authentication uses a new one-use challenge bound to registered public
   key; the enrollment token is no longer needed. New sessions replace previous
   sessions. Proof replay, expiry and revoked nodes are rejected.

This is challenge-response login over authenticated TLS, not a custom HTTP
message-signature implementation. Transport protects each subsequent bearer
request; credentials never authenticate by IP/name/localhost. Node state pins
Coordinator ID and URL. Recovery after lost binding is an operator action.
Invalid proof burns that challenge; an unused grant can create another challenge.
Revocation is checked on each authenticated operation, invalidates sessions and
requeues active leases subject to attempt limits. A key compromised/lost is
revoked and replaced by new identity/enrollment. In-place key rotation/recovery
is future administration work; do not silently reset identity on errors.

## Heartbeats

Node sends daemon/protocol version, enabled capabilities, one available
job slot, current job count, a lifecycle (`ACTIVE` or `DRAINING`) and an optional
resource report (below). No hostname, disks, CPU identifiers, geolocation
or machine analytics. Enrollment capability ceiling is immutable; heartbeat
cannot escalate it. Unknown or locally disabled capabilities never run.
Coordinator reception time determines ONLINE, STALE, OFFLINE (configurable
thresholds); a never-heartbeaten node is OFFLINE, revocation always REVOKED.
Derived status survives restart because last receipt time and revocation persist.
Scheduling requires ONLINE. Expired/revoked leases are reconciled periodically
and on job reads/lease requests. Stale/offline nodes receive no new jobs.

### Resource report (v0.2)

`resources` carries only the owner's *currently permitted* budget and coarse states: `contribution` (`FULL`, `ADAPTIVE`, `MINIMAL`, `PAUSED`), `pressure` (`NORMAL`, `ELEVATED`, `HIGH`), `power` (`AC`, `BATTERY`, `UNKNOWN`), `memoryBudgetBytes` (additional memory a new job may use now), `cpuBudgetPercent`, and optional per-capability budgets from operator limits. Raw memory, CPU or process measurements never leave the node. The Coordinator treats the report as an untrusted hint that can only *restrict* scheduling relative to what jobs declare; it cannot make a node do more than the owner's policy allows because the owner's limits are enforced on the node. A node that reports nothing gets a small fixed legacy budget (64 MiB, 10% CPU).

v0.2.1 adds four optional fields, additive within protocol 1 (v0.2.0 nodes remain valid and are simply not limited by them): `diskBudgetBytes` (scratch disk a new job may use), `diskIo` (highest disk-I/O class a new job may have), `networkBudgetBytes` (remaining transfer allowance) and `availableForMs` (milliseconds until the owner's schedule next turns contribution off, at most 7 days, omitted if none). The scheduler requires a job's declared estimate to fit each reported limit, and does not place a job whose `expectedDurationMs` exceeds `availableForMs`. These are still untrusted node hints and never accounting evidence.

### Lifecycle and node states

`ONLINE`, `STALE`, `OFFLINE` and `REVOKED` are as before. `DRAINING` is a node that reports `lifecycle: DRAINING` with fresh heartbeats: it is assigned nothing while it finishes work. `POST node/goodbye` (planned shutdown) returns the node's leased jobs to the queue without penalty and marks it `OFFLINE_EXPECTED` until it heartbeats again, so an announced exit is distinguishable from an unexplained disappearance (`OFFLINE`). A drain that goes silent becomes `OFFLINE`. Nothing here computes reputation yet; the states are recorded so a later reliability system can treat them differently.

## Typed jobs, idempotency and leases

Two job types exist. `system.echo.v1`: input/output `{message: string}` (≤1024 characters). `system.hashchain.v1` (v0.2.1): input `{seed: string ≤256, iterations: 1..5,000,000}`, output `{digest, iterations}` where the digest is SHA-256 applied `iterations` times to SHA-256(seed); a deterministic, verifiable, preemptible, checkpointable diagnostic workload, not an application feature. Job types live in one registry (`JOB_TYPES` in `packages/protocol`); submit, lease, job and capability schemas derive from it, the Coordinator validates each result against the leased job's own registered output schema, and a test requires every registered type to have a node handler.
Both sides validate; node checks locally enabled capability and fixed handler.
SDK submit requires a caller idempotency key. Same application/key/request
returns same job, changed request is 409. Keep the key when retrying a submission. Read requests retry one transient
connection failure within their existing timeout; mutations do not auto-retry.
Applications cannot select nodes or provide policy, retry counts or lease times.

`QUEUED → LEASED → COMPLETED | FAILED`, plus `LEASED → QUEUED` on lease expiry, revocation or a voluntary release.
Lease expiry or revocation returns work to QUEUED unless configured maximum
attempts is exhausted, then FAILED. Node-reported handler failure is terminal in
v0.1; errors use bounded fixed codes without arbitrary exception text.

Each job type declares a resource estimate in the registry (CPU class, memory, disk, disk I/O, network, expected duration, preemptible, checkpointable). The scheduler assigns a job only to an ACTIVE, non-PAUSED node whose permitted budget (or that capability's budget) covers the estimate. Estimates are scheduler hints, not permission to exceed node limits. `release` (reason `DRAINING`, `PREEMPTED` or `SHUTDOWN`) hands a leased job back: it is requeued, the attempt is refunded, and a per-job release counter (`PRIVANET_MAX_RELEASES`, default 20) fails the job with `RELEASE_LIMIT` so drain/preempt loops cannot run forever. Checkpointing is node-local (v0.2.1): a released checkpointable job keeps its checkpoint on the node, and only that same node resumes it; if the Coordinator gives the job to another node it restarts from the beginning.

Each assignment records node, attempt, random lease ID and expiry. Completion
must match authenticated node and lease ID and arrive strictly before expiry.
All mutation checks occur inside a transaction. Old or superseded leases cannot
commit results; repeated identical completion of the same successful lease is
accepted, changed completion is a conflict. Expired completion is rejected even
when nobody has yet acquired a replacement lease. Since v0.2.1 a node running a long job renews its lease with `POST node/jobs/:id/renew` `{leaseId}` (response `{expiresAt}`), roughly every third of a lease period. Renewal is fenced exactly like completion (authenticated, assigned node, matching lease ID, lease not yet expired; otherwise 409 `LEASE_CONFLICT`), the Coordinator chooses the new expiry (`now` plus the lease period), and a single lease can be kept alive at most `PRIVANET_MAX_LEASE_MS` (default one hour; 409 `LEASE_LIMIT`), so a stuck node cannot hold a job forever. A node that loses its lease stops the handler and does not hand the job back. Handlers must yield to the event loop (as hash-chain does) so renewals and heartbeats run. Execution is at-least-once; future handlers need
idempotency by job ID and cannot infer exactly-once side effects from fencing.
Node restart may lose an unreported result; its lease expires and retries.
