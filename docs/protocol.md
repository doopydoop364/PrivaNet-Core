# Protocol v1

All routes use `/v1/`; clients send `X-PrivaNet-Protocol: 1`, and responses return
that header. Strict schemas reject extra fields, malformed identifiers,
unsupported capabilities/types and payloads. Version mismatch is HTTP 426 with
`PROTOCOL_MISMATCH`; no silent fallback. Health exchanges protocol/service version
and persisted coordinator ID; heartbeat/enrollment carry daemon version and
capabilities. Schema job version is in the identifier (for example `system.echo.v1`).

Compatibility policy: within protocol 1, wire changes are **additive and optional** (v0.2 added optional heartbeat `lifecycle`/`resources`, the `release` and `goodbye` routes, and new node statuses; v0.2.1 added optional resource-report fields, the `renew` route and the `system.hashchain.v1` job type). Older nodes keep working against a newer Coordinator; a newer node's extra fields are rejected by an older Coordinator's strict schema with a clear 400, and anything non-additive bumps the protocol number and fails with 426.

HTTPS is required except explicit opt-in HTTP to literal loopback addresses for
local development. No credential URLs, redirects, caller-supplied paths or
inbound node listener. Request and response size/time are bounded. Browser
cookies/CORS are not part of this machine-client API.

## Roles and routes

| Role | Routes |
| --- | --- |
| Public | GET health; POST enrollment challenge/proof, node auth challenge/proof |
| Admin bearer | POST admin/enrollment-tokens, admin/applications; GET admin/nodes; POST admin/nodes/:id/revoke, admin/applications/:id/revoke, admin/applications/:id/rotate |
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
attempts is exhausted, then FAILED. Node-reported handler failure is terminal
(since v0.1); there is no job cancellation. Errors use bounded fixed codes without arbitrary exception text.

Each job type declares a resource estimate in the registry (CPU class, memory, disk, disk I/O, network, expected duration, preemptible, checkpointable). The scheduler assigns a job only to an ACTIVE, non-PAUSED node whose permitted budget (or that capability's budget) covers the estimate. Estimates are scheduler hints, not permission to exceed node limits. `release` (reason `DRAINING`, `PREEMPTED` or `SHUTDOWN`) hands a leased job back: it is requeued, the attempt is refunded, and a per-job release counter (`PRIVANET_MAX_RELEASES`, default 20) fails the job with `RELEASE_LIMIT` so drain/preempt loops cannot run forever. Checkpointing is node-local (v0.2.1): a released checkpointable job keeps its checkpoint on the node, and only that same node resumes it; if the Coordinator gives the job to another node it restarts from the beginning.

Each assignment records node, attempt, random lease ID and expiry. Completion
must match authenticated node and lease ID and arrive strictly before expiry.
All mutation checks occur inside a transaction. Old or superseded leases cannot
commit results; repeated identical completion of the same successful lease is
accepted, changed completion is a conflict. Expired completion is rejected even
when nobody has yet acquired a replacement lease. Since v0.2.1 a node running a long job renews its lease with `POST node/jobs/:id/renew` `{leaseId}` (response `{expiresAt}`), roughly every third of a lease period. Renewal is fenced exactly like completion (authenticated, assigned node, matching lease ID, lease not yet expired; otherwise 409 `LEASE_CONFLICT`), the Coordinator chooses the new expiry (`now` plus the lease period), and a single lease can be kept alive at most `PRIVANET_MAX_LEASE_MS` (default one hour; 409 `LEASE_LIMIT`), so a stuck node cannot hold a job forever. A node that loses its lease stops the handler and does not hand the job back. Handlers must yield to the event loop (as hash-chain does) so renewals and heartbeats run. Execution is at-least-once; future handlers need
idempotency by job ID and cannot infer exactly-once side effects from fencing.
Node restart may lose an unreported result; its lease expires and retries.

## Control plane and the future data plane

This protocol is the **control plane**. It carries bounded JSON: submissions, leases, heartbeats, results within the per-type output schema, and later placement and transfer authorizations. It is deliberately not a bulk-data channel (32 KiB request bodies, 512 KiB responses). Future large payloads move directly between authorized participants (application to node, node to node) under short-lived, narrowly scoped Coordinator-issued transfer authorizations; the Coordinator remains the authority and never relays the bytes. This is a design direction ([DATA_PLANE.md](DATA_PLANE.md), ADR 006) and adds nothing to protocol 1 today.

Compatibility posture for that future: a job's `result` is `unknown` on the wire and validated against the per-type output schema, so a result may later be inline or carry an optional bounded reference, added to a type additively or through a new versioned type id; new optional lease, heartbeat and capability fields follow the same additive rule. Unresolved: the Coordinator has no signing key today, so the form of a transfer authorization is an open Phase 4 design question.

## Lease requests that wait for work (unreleased, protocol version stays 1)

`POST /v1/node/jobs/lease` accepts an optional `waitMs` (integer 0 to 8000): `{}` is a plain poll exactly as before; `{"waitMs": 5000}` asks the Coordinator to hold the request until a job is leasable for this node or the time is up, then answer `{lease}` (null on timeout). Effect: a job is picked up the moment it is submitted or requeued instead of at the node's next poll, and an idle node makes one request per wait instead of one per poll interval. Bounds and safety:
- the field is strict and bounded (`waitMs` above 8000, negative, fractional or an unknown field is 400 `INVALID_REQUEST`); 8000 ms is below the Coordinator's 10 s request timeout;
- the node's credential is re-checked every time the request wakes, so a node revoked while waiting gets 401, not a job;
- a request whose connection closed is never leased to (a job submitted in the very instant of a disconnect can still be leased to the dead connection; that lease simply expires and the job is retried);
- the number of held-open requests is bounded (default 512, `maxLeaseWaiters`); over the bound a request is answered at once like a plain poll;
- wake-ups come from job submission, release and requeue. Each event wakes at most one waiting request per node that advertises the capability (every lane of a node asks the scheduler the same question, so waking more only repeats it); the woken request re-runs the normal scheduler decision, so eligibility (capabilities, budgets, schedule) is unchanged. A woken request that cannot take the job leaves it queued for the next event or the end of the wait; a lane that finishes a job polls again at once.

Compatibility: an old node sends `{}` and works unchanged. A new node against an older Coordinator gets 400 for `waitMs`, logs `node.lease_wait_unsupported`, and polls plainly from then on. The node's library default is no waiting; the daemon defaults `PRIVANODE_LEASE_WAIT_MS` to 5000, capped by the heartbeat interval so availability stays fresh, and a drain wakes an idle wait at once.

## Multi-slot nodes (unreleased, protocol version stays 1)

A node may advertise `jobSlots` from 1 to 64 in its heartbeat (with `currentJobs` up to that), where earlier versions required exactly 1. The node opts in with `PRIVANODE_JOB_SLOTS` (default 1) and then runs that many independent lanes in one process, sharing one identity, session, heartbeat and set of owner limits. **Owner limits still bound concurrency:** before placing another job on a node the scheduler subtracts the declared estimates (memory, CPU class, disk, network) of the jobs the node is already running from the budget the node reported, so a node never runs more than its owner's limits allow, however many slots it advertises. A node that reports no budget (no resource engine) is still held to the small legacy budget, so it runs about two small jobs at once. Preemption, drain and lease renewal apply to each running job independently; a graceful drain lets every lane finish, and `goodbye` returns any job still leased. Compatibility: a Coordinator from before this change accepts only one slot and answers 400 to a heartbeat advertising more; the node then logs `node.job_slots_unsupported`, falls back to one slot and keeps working. Job reads and leases are unchanged.

## Job reads that wait for the result (unreleased, protocol version stays 1)

`GET /v1/jobs/{id}?waitMs=N` (integer 0 to 8000) holds the read until the job is `COMPLETED` or `FAILED` or the time is up, then answers with the job as it is (still `QUEUED` or `LEASED` if the time ran out). It replaces client polling: one request per wait instead of one per poll interval, and the result arrives the moment the node completes it. `waitMs` is the only query string the API accepts and only on a job read; any other query is 404, and a value above 8000 is 400. Safety mirrors lease waits: ownership is checked before anything is held open, the application credential is re-checked whenever the read wakes (a revoked application gets 401, not the result), a read whose connection closed is dropped, and held-open reads are bounded (default 4096, `maxJobWaiters`), over which a read is answered at once. The SDK's `waitForResult` uses it automatically (never longer than 5 s per read and never past its own timeout) and falls back to plain polling against an older Coordinator that answers 404 to the query; `getJob(id, signal, waitMs)` exposes it directly.

## Additions in 0.3.0-alpha.1 (protocol version stays 1)

- `POST /v1/admin/applications` accepts an optional `fetchIdentity` (`product`, `infoUrl`).
- The lease may carry an optional `client` object, present only for job types that require an application identity (`web.fetch.v1`). Old nodes never receive it for types they do not run.
- New job type `web.fetch.v1` (see [PRIVASEARCH_INTEGRATION.md](PRIVASEARCH_INTEGRATION.md)); submission by an application with no registered identity fails with 403 `FETCH_IDENTITY_REQUIRED`.
- Package compatibility and version-mismatch handling: [PACKAGES.md](PACKAGES.md).
