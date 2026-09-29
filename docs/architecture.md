# Core Foundation architecture (v0.1)

PrivaNet is application-neutral infrastructure. Every application submits work
through SDK → Coordinator → authenticated PrivaNode, including on one machine.
A local node is an ordinary, low-latency node; there is no filesystem/handler
bypass in the SDK or Coordinator.

```mermaid
flowchart TD
  App[Separate applications] --> SDK[PrivaNet SDK]
  SDK --> C[Coordinator control plane]
  C --> DB[(SQLite development persistence)]
  N[PrivaNode: operator-owned handlers] -->|outbound authenticated polling| C
```

The Coordinator is one modular service, with transport, domain service,
scheduler policy and persistence adapter separated. It manages enrollment,
node sessions, capabilities, health, scoped applications and leased jobs.
PrivaNode has no listener. It persists a private Ed25519 identity and coordinator
binding, polls for work, and invokes only locally installed registered handlers.
`system.echo.v1` returns a bounded string unchanged. No shell, fetched executable,
script, container or arbitrary network request operation exists.

## Inspection and boundaries

The first sandbox view showed only empty read-only `.git`, `.agents` and `.codex`
placeholders; Git inspection failed there. Git became readable later in the
session: initial commit `92d5ee1` on `main`, remote
`https://github.com/doopydoop364/PrivaNet-Core.git`, with only an empty tracked
README. There were no existing implementations, development docs, ignore rules
or repository instructions. The empty README is the only tracked file modified.
PrivaDrive had uncommitted foundation work; Privaproxy was clean. Both were read
only throughout this task. Their instructions apply to those repositories.

PrivaDrive uses Node 24+, ESM, built-in tests, transactional checksum-tracked
SQLite migrations, and distinct Drive/network schemas. Its encrypted chunk and
integer accounting designs inform future boundaries, not this implementation.
Its planned in-process network composition and direct local chunk adapter must
eventually change: Drive keeps file/folder/permission/encryption semantics and
calls the PrivaNet SDK for generic storage. Document-only integration proposal:
replace physical storage access with the future PrivaNet object API when v0.4–6
exists, migrate network-owned metadata with explicit versioning, and keep Drive
vault keys out of PrivaNet. No current storage API is promised.

Privaproxy uses Node/Express, modular application routes, built-in tests,
loopback defaults, an optional password gate, cookies, in-memory sessions and
separate proxy transport credentials. These are not reusable user identities
or node credentials. A future integration uses a scoped SDK application token;
proxy sessions, cookies and browsing/media engines stay in Privaproxy.

## Structure and dependencies

- `apps/coordinator`: HTTP service, domain lifecycle, scheduler, SQLite adapter,
  append-only migrations and environment configuration.
- `apps/node`: identity files, operator configuration, daemon, fixed handlers.
- `packages/protocol`: wire schemas, versions, typed job registry; no app imports.
- `packages/shared`: bounded transport, crypto and private-file utilities.
- `packages/sdk`: small application client; imports protocol/shared only.
- `tests`: protocol/domain, HTTP integration, persistence and node identity tests.
- `docs`: architecture, protocol, security, operation and roadmap.

npm workspaces and TypeScript project references produce per-package `dist/`
outputs and declarations. Dependencies flow apps/SDK → shared → protocol.
The protocol depends only on Zod; the Coordinator never imports node handlers.
The SDK has no dependency on either service or SQLite. No empty future services,
container orchestrator, browser framework, distributed storage or ledger.

## Decisions (ADR 001)

**Problem:** establish a portable, typed, small control plane with real local
trust boundaries and durable work. **Decision:** Node 24.4+, TypeScript strict
ESM, built-in HTTP/crypto/test/SQLite, Zod strict schemas, npm workspaces.
TypeScript is justified by shared wire types; Zod supplies runtime validation
and inferred types ([official schemas](https://zod.dev/api)). TypeScript project
references preserve package build boundaries
([official documentation](https://www.typescriptlang.org/docs/handbook/project-references)).
ESLint/typescript-eslint are development-only static checks. No HTTP framework,
ORM, crypto dependency or message broker is needed. Node's synchronous SQLite
API is confined to a single-process development adapter
([Node 24 SQLite](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html)).

**Alternatives:** plain JS loses useful protocol typing; Rust/Go complicate the
shared JS SDK; PostgreSQL adds setup requirements before concurrency needs;
WebSockets/queues add recovery machinery for a small pull-based demo.
**Consequences:** pin/verify Node versions for releases; synchronous DB methods
limit throughput. PostgreSQL requires another Store adapter and asynchronous
transaction implementation, without changing the wire API. Single Coordinator
process per database is the supported topology. No production scale claim.

## Persistence and scheduling

Store is a domain persistence port, separate from transport and scheduling.
SQLite uses transactions, foreign keys, WAL, FULL synchronization and checksummed
migrations. Registered nodes, revocations, grants, one-use challenges, hashed
sessions, scoped app identities, jobs/results/leases and coordinator ID survive
restart. Runtime state is private and ignored. Small validated echo payloads
are retained; future bulk objects belong in a data plane, never job rows.

An injectable scheduler policy filters for authenticated ONLINE non-revoked
nodes, permitted capabilities and coordinator-counted active leases below the
operator's advertised slot limit (v0.1: one slot). It chooses the oldest eligible
queued job when that node polls. Multiple nodes compete transactionally; no
special preference/bypass for localhost. Advertised resources are untrusted
hints, not accounting evidence. Job lifecycle/fencing is in [protocol](protocol.md).

## Future control/data plane

This API carries bounded JSON control messages only. Future direct node data
transfers need separately scoped authorization, transfer integrity and SSRF
review. Applications will still use the same SDK API. This release makes no
assumption that future files/index/media transit the Coordinator.
