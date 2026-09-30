# Application boundary: what PrivaNet-Core owns and what applications own

Status: **architecture decision (ADR 005): ACCEPTED.** The Core-owned registry of generic, function-named first-party capabilities is confirmed, and `web.fetch.v1` is its first application-facing entry (implemented in v0.3.0-alpha.1). Extension point E1 (application fetch identity) is implemented; E2 to E9 are still planned. It settles where application-specific work lives, and evaluates the open question of where first-party job definitions live. Related: [ADR 001](architecture.md#decisions-adr-001), [ADR 005](architecture.md#adr-005-applications-are-external-core-owns-generic-capabilities), [PrivaSearch integration contract](PRIVASEARCH_INTEGRATION.md).

## 1. The repositories

| Repository | Role |
| --- | --- |
| **PrivaNet-Core** (this repo) | Shared infrastructure and platform |
| **PrivaSearch** | Separate application that consumes PrivaNet |
| **PrivaDrive** | Separate application (later consumes PrivaNet storage) |
| **Privaproxy** | Separate application (no PrivaNet dependency today) |

Dependency direction, and the only permitted one:

```text
Applications (PrivaSearch, PrivaDrive, ...)
        |   depend on
        v
@privanet/sdk  (and the documented HTTP API and protocol version)
        |
        v
PrivaNet-Core: Coordinator  <-  authenticated PrivaNodes
```

**PrivaNet-Core never depends on application code**: no application package is imported, bundled, loaded, named in a code path, or required to build or test Core. Applications never import Core internals (Coordinator, node, store, scheduler); they use the SDK and wire protocol only.

## 2. Who owns what

**PrivaNet-Core owns** (generic; any application benefits, none is special): protocol and versioning; SDK; authentication and scoped application credentials; node identity and enrollment; the Coordinator; the PrivaNode runtime; generic typed-job transport (submit, lease, renew, release, complete, retry, idempotency); scheduling; leases; generic resource management and owner policy; generic resource measurement and accounting later; generic storage infrastructure later; the security-critical execution primitives that touch the network or disk on a node owner's machine.

**PrivaSearch owns:** search UI and API; queries; URL frontier; crawl prioritisation; robots and crawl *policy* (what, when, how politely, how often); recrawl policy; document parsing policy; indexing; ranking; deduplication and search semantics; metasearch fallback; public-versus-demand crawl policy; its own datastore; its own tests and releases.

**Rule of thumb:** if removing PrivaSearch from the world would make a Core feature pointless, that feature does not belong in Core. If a feature only makes sense with a search engine's semantics (relevance, freshness of an index, a crawl frontier), it belongs in PrivaSearch.

## 3. The integration contract

What PrivaNet-Core promises to applications (versioned, stable within protocol 1, additive-only changes):

| Surface | Contract |
| --- | --- |
| Wire protocol | `X-PrivaNet-Protocol: 1`; additive optional changes only; mismatch is `426` ([protocol](protocol.md)) |
| SDK | `@privanet/sdk`: `submit(type, input, idempotencyKey)`, `getJob`, `waitForResult`, `capabilities`, `health`; input and output types derived from the registered job type |
| Authentication | Application credential (bearer), returned once, stored hashed, rotatable and revocable; scoped to `allowedJobTypes`; applications see only their own jobs |
| Job semantics | At-least-once execution; idempotency key per application; result validated against the job type's output schema; typed failures; bounded retries; `QUEUED`, `LEASED`, `COMPLETED`, `FAILED` |
| Limits | 32 KiB request bodies, 512 KiB responses, per-application queue quota, retention period |
| Capabilities | `GET /v1/capabilities` reports which job types have online nodes |
| Errors | Fixed codes (`JOB_TYPE_FORBIDDEN`, `QUEUE_LIMIT`, `IDEMPOTENCY_CONFLICT`, ...) |
| Compatibility | Job type ids are versioned (`x.y.vN`); a changed contract is a new id, never a silent change |

What an application must do: authenticate with a least-privilege credential; keep the idempotency key across retries; treat every result as untrusted data from an untrusted node; keep user identifiers and secrets out of job input; own its retry, backoff and politeness policy; never assume PrivaNet keeps data past the retention period.

## 4. The open question: where do first-party job definitions live?

A "job definition" bundles four things: (1) the **contract** (id, version, input and output schema, resource estimate); (2) the **validation** that the Coordinator performs with that contract; (3) the **handler** code that executes on a node; (4) the **typed client** an application uses. Today all four are compiled into Core through the single frozen registry `JOB_TYPES` (the registry drives wire schemas, capability lists, the Coordinator's result validation, scheduling estimates, and SDK types, and a test keeps node handlers in lockstep).

The constraints that matter, all from the current design:

- The Coordinator is every application's and node's shared control plane: code it loads runs with its authority.
- A node runs handlers with its **owner's** authority, on the owner's machine and network. Handlers that perform I/O (fetching URLs, touching disk) are the security boundary. ADR 001 replaced "arbitrary remote execution" with a closed set of reviewed typed jobs on purpose.
- Registry-derived static typing (`JobType` union, `z.enum`) is a real safety and ergonomics property.
- Core must stay generic and must not depend on applications.

### Option A: the application owns the schema and handler package; PrivaNet loads it through an extension mechanism

| Criterion | Assessment |
| --- | --- |
| Dependency direction | Clean at build time; but Core now executes application code at runtime |
| Core stays generic | Yes |
| Trust boundary | **Weakest.** Application code runs inside the Coordinator (schemas) and inside every opted-in node (handlers) with the owner's authority. A fetch handler's SSRF guard would be written and updated by the application, not reviewed by Core |
| Node-owner control | Owners must install and trust each application's package (supply chain, version skew, hash pinning) |
| Typing and registry | Registry becomes dynamic; the compile-time `JobType` union and lockstep test are lost or rebuilt |
| Coupling cost | Lowest per new application |
| Verdict | Reintroduces third-party code execution on community nodes. Acceptable only under strict conditions (see the future mechanism below), not as the general path and **not for handlers that do I/O** |

### Option B: a separate shared contract package published from the PrivaSearch repo (for example `@privanet/privasearch-protocol`)

| Criterion | Assessment |
| --- | --- |
| Dependency direction | To register the type, Core would have to import or load a package that lives in PrivaSearch: **the forbidden direction**, or a dynamic load (which is Option A) |
| Value if only used client-side | Fine and encouraged: PrivaSearch can publish typed wrappers and its own schemas for *its* use, built on the SDK. That is application code, not registration |
| Version skew | Three moving parts (Core, contract package, handler) that must agree |
| Verdict | **Rejected as a registration mechanism.** Acceptable as PrivaSearch's private client library |

### Option C: PrivaNet-Core keeps a first-party capability registry; application logic stays external

| Criterion | Assessment |
| --- | --- |
| Dependency direction | Clean: Core knows capabilities, not applications, if capabilities are named and designed by **function** |
| Core stays generic | Yes, provided the generic-capability rules below hold; it fails if Core accumulates `appname.*` types with application policy inside |
| Trust boundary | **Strongest.** Every handler that executes on a node is reviewed Core code, in one place, one supply chain |
| Node-owner control | One trusted package (`@privanet/node`); owners enable capabilities individually |
| Typing and registry | Unchanged: static, lockstep-tested |
| Coupling cost | A Core change and release per new capability. Acceptable because new *capabilities* are rare; new *applications* mostly reuse existing ones |
| Verdict | **Recommended for anything that performs I/O or otherwise needs owner-level trust** |

### Decision (accepted)

1. **Now (Phase 3): Option C, applied strictly.** Core keeps the closed, reviewed capability registry. A job type qualifies only if it is a **generic capability named for what it does, not who calls it**. So the constrained web fetch is `web.fetch.v1` (provisional id), **not** `privasearch.crawl.v1`. PrivaSearch is its first consumer, and PrivaSearch-specific behaviour (frontier, crawl policy, recrawl policy, priorities, robots *policy*, parsing policy) stays in PrivaSearch. Other applications (an archive, a feed reader) can use the same capability under their own scoped credentials.
2. **Never Option B for registration**, and **never Option A for I/O-performing handlers.** Networking and storage primitives are always first-party Core code.
3. **Later, for application-specific pure compute only (research, not scheduled):** a narrowly scoped extension mechanism in the spirit of Option A. Its minimum requirements: the contract is a **declarative manifest** (data: id, version, restricted JSON Schema for input and output, resource estimate), so the **Coordinator never loads application code** and validates with a bounded declarative validator; the handler is a **node-owner-installed, hash-pinned artifact** enabled explicitly per node; it runs **isolated** (no network, no filesystem, no child processes, hard memory and time limits, for example a worker with the Node permission model or a WASM runtime) and is a **pure function of its bounded input**; there is a documented review and revocation path. This could host something like a PrivaSearch parse or extraction step over bytes it is handed. It needs its own threat model before any code.

### The generic-capability test (what may be added to Core's registry)

A capability may be added only if **all** hold:

1. **Named by function** (`web.fetch.v1`, `storage.put.v1`), never by application (`privasearch.*`).
2. **Plausibly useful to more than one application**, or a platform security primitive that must be central for review.
3. **Contains no application policy**: no notion of what to fetch or when, priorities, ranking, indexing, crawl frontier, recrawl schedule, or search semantics. Input can only *narrow* platform safety limits, never widen them.
4. **Security-reviewed** with its own threat table, test corpus (including abuse cases) and resource estimate before merging.
5. **Permissioned, not privileged**: which application may submit it is runtime configuration (`allowedJobTypes`), never code that names an application.
6. **Owner-controlled**: nodes must be enabled per capability by their owner and have owner policy limits.

## 5. Generic extension points Core should provide (planned, none implemented)

These are the platform features an application like PrivaSearch legitimately needs. Each is generic and additive.

| # | Extension point | Why it is generic |
| --- | --- | --- |
| E1 | **Implemented (v0.3.0-alpha.1).** **Application client identity in the lease**: an admin-registered, bounded identity on the application record (a product token and an information URL) that the Coordinator stamps into the lease, so a fetch capability can build a truthful `User-Agent` and robots token without the job choosing it | Any application performing outbound requests needs an accountable identity; the job cannot spoof another application's |
| E2 | **Job cancellation** (`POST /v1/jobs/{id}/cancel`, delivered to a running node through lease renewal) | Any application with a backlog needs it |
| E3 | **Per-application or per-type retention** and optional result scrubbing after acknowledgement | Data-minimisation for every application |
| E4 | **Scheduler concurrency keys** (do not lease two jobs with the same key at once) | Politeness for fetches, but equally useful for per-resource serialisation |
| E5 | **Per-application request budgets** in the Coordinator | Abuse control; later the attachment point for treasury budgets |
| E6 | **Batch job status polling** (or long-poll) | Any application with many in-flight jobs |
| E7 | **Implemented (unreleased).** **Multi-slot nodes** (`jobSlots` up to 64, opt-in through `PRIVANODE_JOB_SLOTS`): measured first (a one-slot node handles one job per network round trip, so about 260 pages a minute at 200 ms per request, and running several one-slot processes costs about 80 MiB each) | Throughput for any workload; the scheduler reserves running jobs' estimates against the owner's reported budget |
| E8 | **Blob references in results** once Phase 4 storage and the direct-transfer data plane exist ([DATA_PLANE.md](DATA_PLANE.md#12-job-result-evolution-is-the-current-model-compatible)); added to a type additively or via a new versioned id, and only when measurements require it | Any application returning bulk data |
| E9 | **Manifest-declared, sandboxed pure-compute jobs** (research, section 4 point 3) | Lets applications ship compute without touching Core |

## 6. Migration and review of the current state

**Is there any PrivaSearch-specific code in PrivaNet-Core?** No. A search of the source, tests, scripts, workflows and configuration finds no `privasearch` or crawler code. The only mentions are in documentation, listed and corrected below. The two job types that exist (`system.echo.v1`, `system.hashchain.v1`) are generic diagnostics. Nothing was deleted or moved.

**Documentation that implied PrivaSearch belonged in, or was named in, Core** (corrected in the same change): the ROADMAP Phase 3 (which listed the search application's components as Core deliverables), the roadmap table row, the PrivaSearch integration document (which specified `privasearch.crawl.v1` registered in Core and a `PrivaSearchBot` user agent), ADR 004, the crawl threat table, the Treasury document's example job ids, and the README status row.
