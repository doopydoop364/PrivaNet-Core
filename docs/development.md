# Development and operations

## Local demonstration

Use three private terminals in the PrivaNet directory. Node 24.4+ and npm are
required. Environment variables are service-specific; `.env` is not auto-loaded.
`npm ci && npm run build` first. Do not point state directories at personal files.

In the Coordinator terminal, generate a fresh admin bootstrap secret without
printing it. This value must also reach the administrator terminal through a
private channel/environment; it is not a normal application credential.

```bash
export PRIVANET_ADMIN_SECRET=$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))")
npm run start:coordinator
```

The default listener is `127.0.0.1:4010`. The service logs fixed events, never the
secret. In an admin terminal with that same secret in its environment:

```bash
export PRIVANODE_ALLOW_INSECURE_LOOPBACK=true
npm run admin -- application demo
npm run admin -- enrollment
```

Issuance intentionally returns credentials once as JSON on the private admin
terminal. It is distinct from service logging. Do not capture this output in
shared logs/history. Enrollment expires in 60 seconds; create a new grant if it
expires. Deliver the enrollment value through `PRIVANODE_ENROLLMENT_TOKEN` in the
node's private environment. Deliver the app token through `PRIVANET_APP_TOKEN`
in the application's private environment, not a command argument or source file.

Node terminal:

```bash
export PRIVANODE_ALLOW_INSECURE_LOOPBACK=true
export PRIVANODE_CAPABILITIES=system.echo.v1
# PRIVANODE_ENROLLMENT_TOKEN is already provided privately.
npm run start:node
```

Application terminal:

```bash
export PRIVANODE_ALLOW_INSECURE_LOOPBACK=true
# PRIVANET_APP_TOKEN is already provided privately.
npm run demo
```

The app receives `{message: "Hello from PrivaNet SDK"}` and the job ID. Restart
the node with the same `var/node` directory **without** the enrollment token;
it proves possession of its persisted identity. The Coordinator may restart
with the same data directory/admin secret; jobs, node identity, grants, application
permissions and revocation survive. `npm run admin -- nodes` shows node state;
`revoke-node ID` or `revoke-application ID` disables that credential's role.
App revocation does not cancel already accepted jobs; cancellation is v0.2.
Ctrl+C/SIGTERM stop the services. Node finishes its current bounded request
before stopping; leases recover any lost work.

## Configuration

[.env.example](../.env.example) lists defaults. Coordinator policy uses positive
bounded integers; offline timeout must exceed stale timeout. Keep heartbeat
interval comfortably below stale timeout and poll interval below lease duration.
Current echo execution is synchronous/bounded, one slot, with no lease renewal.
Policy changes take effect on service restart; lowering the attempt limit also
marks exhausted queued retries FAILED. Max attempts counts actual leases,
not submission calls. Revocation/expiry retries are bounded; handler failures
are terminal. Heartbeat resources are operator hints, not verified contribution.

Node capabilities default to empty; each must be enabled locally and authorized
by the enrollment grant. Operator can remove echo from configuration and restart.
Coordinator cannot expand the immutable grant ceiling or install a handler.
Choose a separate node directory for each instance; never run two daemons using
one identity. State paths resolve from the working directory. Node binds persistently
to the exact Coordinator URL/ID; TLS certificates remain independently verified.

HTTPS is the default client requirement. Plain HTTP is accepted only for literal
`127.0.0.1`/`[::1]` with the explicit development flag. For remote operation,
configure a TLS reverse proxy, verified certificates, perimeter request limits
and no direct network path to the plain HTTP listener. A non-loopback Coordinator
bind requires `PRIVANET_TLS_TERMINATED=true`. This flag acknowledges deployment
configuration; it does not add TLS itself. Avoid forwarded-address trust by default.

Requests are ≤32 KiB and responses ≤512 KiB; transport timeout defaults to 10s,
redirects are refused. Challenges expire in 60s (service policy), node sessions
in 5min, and grants specify ≤24h validity. Challenge/invalid-auth attempts have
bounded per-address limits; the control plane supports at most 1000 registered
nodes/pending challenges in this initial implementation. Queues/results need
operator retention and quotas before broader deployment.

## State, migrations and recovery

Use one Coordinator process and a private operator-owned local state directory.
SQLite is a development adapter: WAL, FULL synchronization, foreign keys,
transactional migrations, checksummed immutable history. Migrations are numbered
in `apps/coordinator/src/migrations.ts`; append a migration for changes. The
adapter rejects edited history and newer unknown database schema. Never delete
real data to fix a migration error. Build outputs are reproducible and ignored.

Back up a consistent SQLite database using SQLite backup tooling or stop the
service and copy the entire Coordinator directory (including WAL sidecars).
Protect backups as sensitive job/node metadata. Back up node identity/binding
separately and securely; sessions are not stored on the node. Restore to the
same Coordinator identity/URL. Recovered leases retain deadlines and are requeued
once expired; old lease IDs cannot commit replacement results.

If an identity is corrupted or lost, the daemon fails closed. Revoke the old
node through administrator API and enroll a new private identity in a new state
directory. For a deliberate Coordinator URL/identity change, stop the daemon,
review the new TLS endpoint, back up its state, and explicitly provision a new
binding/enrollment as appropriate; no job can alter this binding. There is no
in-place key rotation wizard. Rotate app credentials in place with `npm run admin -- rotate-application ID` (same identity and jobs, old credential invalid immediately). Rotate
the admin bootstrap secret by replacing its environment value and restarting.

POSIX state directories/files require 0700/0600 and owner checks. On Windows,
use a private user-profile directory and restrict its ACLs to the node service
account/operator; file mode alone cannot guarantee ACL privacy. Node/OS support
needs CI validation; do not assume every platform was tested locally.
