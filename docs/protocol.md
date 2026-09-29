# Protocol v1

All routes use `/v1/`; clients send `X-PrivaNet-Protocol: 1`, and responses return
that header. Strict schemas reject extra fields, malformed identifiers,
unsupported capabilities/types and payloads. Version mismatch is HTTP 426 with
`PROTOCOL_MISMATCH`; no silent fallback. Health exchanges protocol/service version
and persisted coordinator ID; heartbeat/enrollment carry daemon version and
capabilities. Schema job version is in the identifier `system.echo.v1`.

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
| Node session bearer | POST node/heartbeat, node/jobs/lease, node/jobs/:id/complete, node/jobs/:id/fail |

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

Node sends only daemon/protocol version, enabled capabilities, one available
job slot and current job count. No hostname, disks, CPU identifiers, geolocation
or machine analytics. Enrollment capability ceiling is immutable; heartbeat
cannot escalate it. Unknown or locally disabled capabilities never run.
Coordinator reception time determines ONLINE, STALE, OFFLINE (configurable
thresholds); a never-heartbeaten node is OFFLINE, revocation always REVOKED.
Derived status survives restart because last receipt time and revocation persist.
Scheduling requires ONLINE. Expired/revoked leases are reconciled periodically
and on job reads/lease requests. Stale/offline nodes receive no new jobs.

## Typed jobs, idempotency and leases

Only `system.echo.v1` exists: input/output `{message: string}` (≤1024 characters).
Both sides validate; node checks locally enabled capability and fixed handler.
SDK submit requires a caller idempotency key. Same application/key/request
returns same job, changed request is 409. Keep the key when retrying a submission. Read requests retry one transient
connection failure within their existing timeout; mutations do not auto-retry.
Applications cannot select nodes or provide policy, retry counts or lease times.

`QUEUED → LEASED → COMPLETED | FAILED`.
Lease expiry or revocation returns work to QUEUED unless configured maximum
attempts is exhausted, then FAILED. Node-reported handler failure is terminal in
v0.1; errors use bounded fixed codes without arbitrary exception text.

Each assignment records node, attempt, random lease ID and expiry. Completion
must match authenticated node and lease ID and arrive strictly before expiry.
All mutation checks occur inside a transaction. Old or superseded leases cannot
commit results; repeated identical completion of the same successful lease is
accepted, changed completion is a conflict. Expired completion is rejected even
when nobody has yet acquired a replacement lease. There is no lease renewal in
v0.1: only bounded echo runs. Execution is at-least-once; future handlers need
idempotency by job ID and cannot infer exactly-once side effects from fencing.
Node restart may lose an unreported result; its lease expires and retries.
