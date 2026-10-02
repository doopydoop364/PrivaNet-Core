# Phase 4 design: generic chunk storage and the first direct-transfer data plane

Status: **4.0-alpha.1 (the node-local chunk store, [section 15](#15-40-alpha1-as-built-and-what-changed-from-this-design)) and 4.0-alpha.2 (the storage control plane and transfer authorization, [section 16](#16-40-alpha2-as-built-and-what-changed-from-this-design)) are IMPLEMENTED**; everything else here (the transfer listener and direct transfer, the milestones after alpha.2) is still a PROPOSED design, not implemented. No chunk byte can move yet: alpha.2 authorizes and records transfers and never carries one. Written after v0.3.6 (the contributor and operator experience release). It turns [DATA_PLANE.md](DATA_PLANE.md) (ADR 006, which fixed the direction and left fourteen questions open) into a concrete, small, buildable plan, and records ADR 007 (below). Written as a proposal; sections 15 and 16 record what was built and where it differs. Related: [ROADMAP](../ROADMAP.md#phase-4--generic-storage--data-plane-foundation--in-progress), [security](security.md#data-plane-threats-planned), [RESOURCES](RESOURCES.md), [NODE_CONTROL_PANEL](NODE_CONTROL_PANEL.md), [APPLICATION_BOUNDARY](APPLICATION_BOUNDARY.md).

The one-line version: **PrivaNet stores opaque, immutable, content-addressed chunks on contributor machines, under each owner's limits; the Coordinator decides who may store or fetch which chunk where, and signs a short-lived ticket for it; the bytes then move directly between the application and the storage node and never through the Coordinator.** Everything application-shaped (files, folders, sharing, encryption, manifests) belongs to PrivaDrive and other applications, not to Core.

## 1. Scope and non-goals

In scope for Phase 4 (the "smallest secure generic primitive"):

- a **chunk store** on a node: put, get, has, delete of immutable chunks, with quotas and integrity;
- **Coordinator placement metadata** and **transfer tickets** (signed, short-lived, bound);
- **application-to-node direct transfer** over HTTPS, and the same mechanism for a node's own local store (no localhost bypass);
- owner controls (quota, reserve, bandwidth, schedule, pause, drain, capability on/off) in the existing panel, CLI and policy model;
- a threat-tested transfer state machine and aggregate metrics.

Out of scope (each has its own phase or is deliberately refused): node-to-node replication and repair (Phase 5), possession challenges (Phase 5/7), file and folder semantics, encryption, sharing and deduplication across applications (PrivaDrive, Phase 6), accounting, credits and markets (Phase 7+), NAT traversal and relays (a separate networking track, section 8), arbitrary filesystem access, any "run this" capability.

## 2. Object model

**The unit is the chunk.** A chunk is an immutable byte string of 1 to `MAX_CHUNK_BYTES` bytes (proposed 8 MiB hard limit, 4 MiB recommended default for applications; the limit is a protocol constant, raised only by a version bump). Core has no "object" with its own semantics: an application that wants a file makes chunks and keeps its own manifest (which can itself be stored as a chunk). This keeps PrivaDrive semantics out of Core and keeps Core's surface tiny.

- **Digest:** SHA-256 (the project's existing digest; it is already used for `web.fetch.v1` content digests, token hashing and release checksums). No new primitive.
- **Chunk ID:** `chk_<64 lowercase hex>` = SHA-256 of the **stored bytes** (for an encrypting application, the ciphertext). The ID is derived from the content, so an ID cannot be forged to name different bytes: a node verifies the hash while streaming and discards a mismatch.
- **Namespace:** chunks are scoped to the application that stored them: the Coordinator key is `(applicationId, chunkId)`. Two applications storing the same bytes get two logical entries (a node may physically share the file, never the permission). This avoids the confirmation-of-existence side channel of global deduplication; cross-application dedup is an explicit later decision, not a default.
- **Metadata (Coordinator):** `size`, `createdAt`, `applicationId`, `class` (an opaque application label such as `drive-chunk`, used only for quotas and metrics), optional `expiresAt` (a retention hint for garbage collection), and a per-application reference count only if applications ask for it (default: the application deletes explicitly).
- **Limits:** per-application quota (bytes and chunk count) enforced at placement; a maximum number of in-flight transfers per application and per node.
- **Chunk size strategy:** fixed upper bound, any smaller size allowed (the last chunk of a file is short). A fixed chunk size is not required by Core; applications choose (PrivaDrive will pick one for its own dedup and resumability). Resumability is at chunk granularity (re-send the chunk), not byte ranges (section 6).
- **Integrity:** verified at write (streaming SHA-256, constant memory), at read (the receiver verifies against the ID), and at rest by periodic scrubbing in Phase 5. A chunk is never visible to `get` until its hash has been verified and it has been atomically renamed into place.

## 3. Node-side store

```text
<state>/store/
    chunks/<aa>/<bb>/<64-hex>        committed chunks (0600, immutable, owner-only)
    incoming/<random-id>.part        partial uploads (exclusive create, 0600)
    index.json (or a small append-only log)   usage, count, scrub state; rebuildable from chunks/
```

- **Atomic writes:** stream to `incoming/` (exclusive create, no symlink following), hash while streaming, enforce the byte bound, `fsync`, then `rename` into `chunks/` (the same pattern as `replacePrivateFile`). A crash leaves only `incoming/` debris that start-up removes (anything older than one transfer lifetime).
- **No caller-influenced paths, ever.** The path is computed from the validated chunk ID only (`[0-9a-f]{64}`); nothing else from a request reaches the filesystem. Directories are created by the node, not by the caller; all opens use `O_NOFOLLOW`; the store root must be a private directory owned by the node (the same check as the state directory). This closes path traversal and symlink attacks by construction.
- **Quota:** `usedBytes` is tracked (rebuilt from a directory scan at start). A write is refused up front when `declaredSize > allowedFree` and again at the bound while streaming, so a "small ticket" cannot fill a disk. Disk exhaustion by partial uploads is bounded by `maxInFlight x maxChunkBytes` and counted against the quota while in `incoming/`.
- **Delete:** idempotent (`delete` of an absent chunk succeeds), authorized by a ticket like any other operation; deletion removes the file and updates usage. Secure erase is not promised (the filesystem and SSD wear leveling make it false); applications encrypt.
- **Same code path for a node's own local store and for remote storage.** A node that stores for itself goes through the same Coordinator authorization and the same transfer service (no localhost special case, as ADR 006 requires).

## 4. Capability and wire model

Storage is not a job: there is no lease, no handler run. But the project's rule stands: **typed, versioned, registry-defined, no arbitrary capability strings.** Proposed shape (to be fixed by an ADR in alpha.2, with a protocol-1 additive change only):

- a new capability id `storage.chunk.v1` in the existing capability registry, marked as a **service** (`kind: 'service'`) as opposed to a **job** type, so the scheduler never tries to lease it and `JOB_TYPES`-driven code keeps working unchanged;
- an optional, strict, additive heartbeat member `services: { 'storage.chunk.v1': { capacityBytes, freeBytes, maxChunkBytes, transferEndpoint?: { url, certFingerprint } } }`, absent from nodes that do not offer storage (old nodes and Coordinators are unaffected, exactly as the resource report was added);
- Coordinator-side routes (application API, scoped by application credential and allowed capability): `POST /v1/storage/placements` (request to store chunk X of size N), `POST /v1/storage/tickets` (get a ticket for get/delete), `POST /v1/storage/transfers/{id}/complete|abort`; node-side: `POST /v1/node/storage/receipts` (completion evidence). Request and response bodies stay within the existing 32 KiB / 512 KiB limits. No bytes.
- The application credential model already has `allowedJobTypes`; storage adds `allowedServices` (default none), so no existing application gains storage by accident.

## 5. Placement and Coordinator state

SQLite stays. The Coordinator already persists nodes, jobs, tokens and invites in SQLite (`node:sqlite`, single writer). Storage adds **metadata only**:

| Table | Holds | Notes |
| --- | --- | --- |
| `chunk` | `(application_id, chunk_id)`, size, class, state (`PENDING`, `STORED`, `DELETING`), createdAt, expiresAt | the logical entry |
| `replica` | `(application_id, chunk_id, node_id)`, state (`RESERVED`, `STORED`, `LOST`), verifiedAt | one row per copy; Phase 4 writes one replica per chunk, Phase 5 raises the desired count |
| `transfer` | transfer id, operation, application, chunk, node, holder key, `maxBytes`, state, issuedAt, expiresAt, completedAt, evidence | the state machine and the audit trail; the ticket itself is never stored |
| `node_service` | per-node advertised capacity, free bytes, endpoint, lastReportedAt | refreshed from heartbeats |

At 100-byte rows, ten million chunks is about a gigabyte of metadata: fine for SQLite as a first implementation, and the access pattern (point lookups by `(application, chunk)`, per-node counts) is index-friendly. **PostgreSQL is not needed for Phase 4**; the trigger to revisit is measured: write contention on the single writer under real placement load, or a metadata set that no longer fits comfortably in a backup window. Phase 8's market needs will be assessed on their own evidence.

**Placement policy (Phase 4, deliberately simple):** among nodes that are `ONLINE`, advertise the service, have free capacity for the chunk, are not draining, and are allowed for the application, pick by free-space-weighted random with a per-node concurrency cap. The application never chooses. Failure-domain awareness, replica counts and repair are Phase 5.

**Availability and capacity honesty:** a node's advertised `freeBytes` is whatever its owner's policy allows (section 9) and is re-checked by the node at transfer time; the Coordinator's view is a hint that can be stale, so every ticket is also bounded by what the node will accept when it sees it.

## 6. Transfer authorization (ticket)

Answers ADR 006 open questions 1, 2, 3, 4, 5, 12 and 13 with a concrete proposal.

**Signing.** The Coordinator gets an **Ed25519 transfer-signing key**, generated on first use and stored in its state (mode 0600, never exported, never logged, rotatable with an overlap window and a `kid`). Its public keys are delivered to nodes inside the authenticated session response (additive field), so a node verifies tickets offline and without trusting the network location of whoever presents them. Reuses the Ed25519 primitives and the node-session trust the project already has; no second trust system.

**Ticket content (signed, compact, not a bearer secret on its own):**

```text
v, kid, tid (transfer id), op (put | get | delete), app (application id),
chunk (chunk id), node (target node id), maxBytes, exp (<= 120 s after issue),
holder (the application's per-transfer Ed25519 public key), nonce
```

**Holder binding (grant theft).** The application generates a fresh Ed25519 key pair per transfer and sends only the public key when it asks for the ticket. The node, when the application connects, sends a random challenge; the application signs `challenge || tid || sha256(request line)` with the private key. A stolen ticket is useless without the holder key; a stolen holder key is useless without the ticket. The ticket never travels in a URL (it goes in a header or the body), and logs record `tid`, never the ticket.

**Single use and idempotency.** `tid` is consumed when the transfer begins; the node keeps a small persisted set of consumed `tid`s until `exp + skew` (bounded by the number of in-flight tickets), so a restart does not reopen a replay window. A retry after a failed attempt needs a **new ticket for the same logical chunk** (idempotent at the chunk level: storing chunk X again is a no-op once `STORED`, and an interrupted attempt leaves nothing visible). Resume is therefore **chunk restart**, not byte ranges: simpler and nothing for a malicious holder to abuse, at the price of re-sending up to one chunk (at most 8 MiB).

**Clock skew:** nodes allow a bounded skew (30 s) and use the Coordinator's time carried in the session (the node already tracks the Coordinator's clock offset through heartbeats), not just their own clock.

**Revocation and expiry mid-transfer:** tickets are short enough that revocation is mostly expiry. Revoking a node or an application causes the Coordinator to refuse new tickets and to mark open transfers `REVOKED`; a node that loses its session (it checks at the start and at completion) **fails fast and discards the partial data**; it never finishes and commits after permission was withdrawn.

**The ticket never overrides the owner.** A valid ticket on a paused node, a node that is draining, a node out of quota or bandwidth, or outside its schedule is refused with a fixed error code.

## 7. Transfer protocol and state machine

HTTPS (TLS 1.2+, HTTP/1.1; HTTP/2 or 3 later if measurements justify it). One endpoint family on the node's transfer listener:

```text
PUT  /v1/chunks/{chunkId}      headers: ticket, holder challenge response, Content-Length (must equal the ticket's declared size <= maxBytes)
GET  /v1/chunks/{chunkId}      headers: ticket, holder challenge response
DELETE /v1/chunks/{chunkId}    same
```

No other path, method or content type exists on that listener (no listing, no directory, no range, no redirect, no CORS). Request headers and bodies are size-bounded, slow clients are timed out, and concurrent transfers are capped.

```text
AUTHORIZED --(node accepts: ticket, holder proof, owner policy)--> IN_PROGRESS
IN_PROGRESS --(hash and size verified, renamed into place)--> COMPLETED
IN_PROGRESS --(hash/size mismatch, byte bound hit, disk full, timeout, node/app revoked)--> FAILED
AUTHORIZED --(expiry)--> EXPIRED          any state --(revocation)--> REVOKED
```

Completion is a **Coordinator state transition backed by evidence from the right party**: for a PUT, the node's signed receipt (`tid`, chunk id, bytes, verified hash) delivered over its authenticated session; the application's own report is advisory. Nothing is billable or rewardable on an issued ticket (Phase 7 rule). The Coordinator re-verifies nothing (it has no bytes), so Phase 5 possession challenges are what later turn "the node says it has it" into "it demonstrably has it".

## 8. Network topology: the contributor who accepts no inbound connections

Today a node needs no inbound port and a compute-only contributor must stay that way. Direct transfer needs *somebody to listen*. Options considered:

| Approach | Works when | Cost / risk | Verdict |
| --- | --- | --- | --- |
| **A. Storage node opts in to a transfer listener** (LAN, VPN/overlay such as WireGuard, a public IP, or a manual port forward) | the node (or its network) is reachable by the application | the node owner opens one TLS port; surface is the closed three-method service; needs the panel opt-in, a TLS key pinned in the node's registration | **Phase 4 default.** Simple, testable in the existing network-namespace rig, and honest about who can participate |
| **B. Node-initiated transfer to an application-run data endpoint** | the *application* side is reachable (a PrivaDrive server, a gateway) and the node can make outbound connections | the application must run a listener; browsers and phones as direct clients don't fit | **Design for it now, build after A.** The ticket and state machine are symmetric (initiator and listener are roles), so B is "the node dials the application's endpoint with the ticket" |
| **C. Coordinator-assisted rendezvous** (the Coordinator exchanges candidate addresses; no bytes) | NAT hole punching works (most home NATs, not CGNAT/symmetric) | STUN/ICE-like complexity, platform differences, abuse of the Coordinator as a signalling server | Later networking track, not Phase 4 |
| **D. Relay** (a separate bounded service forwards bytes) | everything else fails | costs bandwidth, needs its own limits, authorization and accounting; must never be the Coordinator's request path | Later, optional, its own service |
| **E. Reverse long-lived connection from the node to a relay/gateway** | NAT'd storage node, any client | needs a gateway (D) | Folded into D |

Consequences that are part of the design: (1) **compute-only contributors are unaffected**; the storage service is **off by default** and has no listener until the owner turns it on; (2) a node behind NAT without a forward simply does not advertise the service and is never placed on; (3) the Coordinator never relays bulk bytes at any stage, and the existing 32 KiB / 512 KiB limits stay; (4) the endpoint an application connects to comes **only from the Coordinator** and is bound to the node's identity by a **pinned certificate fingerprint** the node registered (key-pinned TLS: question 4), so DNS or endpoint substitution cannot redirect data; applications never supply endpoints (question 5); (5) the LAN is not trusted: the ticket and holder proof decide, not the address.

## 9. Owner controls (the same model as everything else)

Storage joins the resource policy as a new, versioned, **default-off** block, so it inherits presets, the saved-versus-environment precedence of v0.3.6, the policy lock, export/import, `config check` and the support bundle:

```text
storage: { enabled: false, maxBytes, reserveFreeDiskBytes, maxChunkBytes, maxInFlight,
           maxBytesPerSec (up/down), listener: { enabled: false, port, bindAddress } }
```

- **Advertised capacity can never exceed what the owner allows:** `freeBytes = min(maxBytes - used, diskFree - reserveFreeDiskBytes)`, recomputed at heartbeat and at transfer time.
- **Disk I/O pressure:** the existing disk-I/O class throttles the write path and the scrubber; transfers back off when the owner is busy.
- **Bandwidth and monthly transfer:** storage traffic is metered by the existing `TransferMeter`, so the monthly allowance and rate cap are shared with jobs.
- **Schedules, pause and drain:** the existing schedule and owner pause apply; a paused node refuses new transfers (an in-flight one is allowed to finish or fail fast, never both silently); drain finishes in-flight transfers within the drain timeout, then refuses new ones, and stops advertising.
- **Capability enable/disable:** `capability disable storage.chunk.v1` removes the advertisement and closes the listener without touching stored chunks; **quota changes are safe** (lowering below `used` stops new writes but never deletes data on its own).
- **Panel and CLI:** a "Storage" card (used, quota, listener on/off, in-flight transfers, last error codes) and `privanet-node storage status|enable|disable`; never an endpoint that browses chunks.
- **Uninstall and purge** must say what happens to stored chunks (they are the Coordinator's placement; a node that leaves is `LOST` and Phase 5 repairs).

## 10. Failure semantics

| Event | Outcome |
| --- | --- |
| Upload interrupted | Partial file in `incoming/` is deleted at once (and by the start-up sweep); transfer `FAILED`; nothing visible; the application asks for a new ticket and re-sends the chunk |
| Download interrupted | Nothing to clean on the node; the application re-requests a ticket; the receiver verifies the hash and discards a partial |
| Destination full / quota reached | Refused before reading the body when the declared size does not fit, or stopped at the byte bound; fixed error `STORAGE_FULL`; the Coordinator may place elsewhere |
| Hash or size mismatch | Discarded, `FAILED` with `INTEGRITY`; counted as a node-quality signal in Phase 5 |
| Source lost (a replica's node gone) | Phase 4: the chunk is unavailable and reported as such; Phase 5: repair from another replica |
| Node revoked | Tickets for it refused; open transfers `REVOKED`; its replicas become `LOST` |
| Coordinator restart during a transfer | Node-side transfer completes or fails on its own; the receipt is retried until acknowledged; transfers still `AUTHORIZED` or `IN_PROGRESS` past `exp` are reconciled to `EXPIRED`/`FAILED` at start-up; a committed chunk with no `STORED` record is adopted when its receipt arrives, or garbage-collected |
| Duplicate upload | Idempotent: an existing `STORED` chunk with the same ID and verified size is success; a concurrent second writer for the same `(app, chunk)` gets a deterministic `CONFLICT` and may retry |
| Repeated request / replayed ticket | `tid` already consumed: refused (`TICKET_USED`) |
| Stale placement metadata | The node refuses (it never held it) with `NOT_FOUND`; the Coordinator marks the replica `LOST` |
| Replica loss | Detected by failed transfers and (Phase 5) challenges; repair queue |

All operations are idempotent at the chunk level, and every response uses a **fixed error vocabulary** (no exception text), as everywhere in PrivaNet.

## 11. Threat model additions (on top of [security](security.md#data-plane-threats-planned))

| Threat | Direction |
| --- | --- |
| Forged chunk ID | ID is the hash of the stored bytes, verified while streaming; a node never trusts an ID without the bytes |
| Hash mismatch / substitution | Streaming SHA-256; mismatch discards the partial and fails the transfer |
| Oversized transfer / disk exhaustion | `Content-Length` must equal the ticket's size which is `<= maxBytes <= maxChunkBytes`; the node stops at the bound; quota checked up front; `incoming/` bounded and counted |
| Replayed / expired / stolen grant | Single-use `tid` with a persisted replay set; `exp <= 120 s`; holder-key proof of possession; ticket out of URLs and logs |
| Unauthorized read or write | Closed three-operation service; ticket bound to node, chunk, operation, application and size; no listing |
| Path traversal / symlinks | Paths derived only from a validated hex ID; `O_NOFOLLOW`; private, node-owned store root |
| Partial-upload abuse (slowloris, many half-open) | Per-connection timeouts, `maxInFlight`, bounded `incoming/`, bytes counted against the quota |
| Decompression bombs | **No compression in Core.** Chunks are opaque bytes; applications compress before encrypting if they want to |
| Malicious peer (node or application) | Node verifies everything it receives; applications verify what they fetch against the chunk ID; evidence-based completion |
| Revoked node | Refuses everything once its session ends; Coordinator refuses tickets for it |
| Coordinator restart | Transfer state is transactional in SQLite; reconciliation at start-up (section 10) |
| Node disappears mid-transfer | The application times out and asks for a new placement; the partial is swept |
| Endpoint substitution | Endpoint and certificate fingerprint come from the Coordinator and are pinned |
| Volunteer machine turned into a file server | Closed operation set, fixed storage area, no caller-supplied paths, off by default, owner-enabled, owner-limited |
| Information leakage | Chunks are opaque to Core; applications encrypt; logs carry `tid` and codes, never contents, keys or tickets |
| Signing-key compromise | Key stored 0600 in Coordinator state, `kid` rotation with overlap, nodes accept only listed `kid`s; compromise means rotate and expire outstanding tickets (they live minutes) |

Assumptions to review with an independent reviewer before 4.0 (none has been done): the holder-binding handshake, the persisted replay set, and the signing-key lifecycle.

## 12. ADR 007 (proposed): chunk store and ticketed direct transfer

**Decision.** Core's storage primitive is an immutable, application-namespaced, SHA-256-addressed **chunk**, stored by nodes that explicitly opt in, authorized per transfer by a **Coordinator-signed, holder-bound, single-use, short-lived ticket**, and moved **directly** over TLS with the Coordinator carrying only metadata. Metadata stays in SQLite until measurements say otherwise. The storage service is off by default, owner-limited like every other resource, and never a general file server. **Consequences:** Core stays free of file semantics; no second trust system (Ed25519 and the node session already exist); a node that cannot accept inbound connections can still do compute and simply does not offer storage until option B/D of section 8 exists; every part is additive to protocol 1; Phase 5 adds replicas and repair on top without changing the primitive.

**Amendments made while building 4.0-alpha.2** (the control-plane half of this ADR is implemented; the transfer half is still proposed): (a) verification keys travel on a dedicated authenticated node route, not in the session response, because the session schema is strict and older nodes would stop signing in; (b) the ticket is a fixed-length binary structure, not JSON; (c) services have their own registry and are never job types; (d) there is no `complete` route for applications and no receipt route until bytes can move, so a `STORED` chunk can only come from node evidence; (e) no endpoint is advertised until a listener exists. See section 16.

**Rejected:** routing bytes through the Coordinator (bandwidth and bottleneck); global deduplication by content ID (existence side channel); byte-range resume (abuse surface, little benefit at 8 MiB chunks); bearer-only tickets (theft); a general object API with listing (file-server risk); compression in Core (bombs); PostgreSQL now (no evidence).

## 13. Milestones

The roadmap puts node-to-node transfers in Phase 5, so Phase 4 ends at application-to-node. Each milestone is independently releasable, additive to protocol 1, and testable without the next one.

| Milestone | Delivers | Exit criteria |
| --- | --- | --- |
| **4.0-alpha.1: local chunk store** (node only, no network) | `apps/node/src/store/` library: layout, quota, atomic put/get/has/delete, streaming hash, start-up sweep, usage rebuild; policy block `storage` (default off) validated and shown in `config check`/panel (read-only); `privanet-node storage status` | property and fault-injection tests (crash between each step, concurrent put, symlink planted in the store, path-like IDs, oversized, quota edge, corrupt chunk on disk, directory perms); no listener, no Coordinator change; CI on Linux/macOS/Windows |
| **4.0-alpha.2: placement metadata and tickets** (control plane only) | Coordinator signing key and `kid` rotation; session response carries public keys; `storage.chunk.v1` service capability and the heartbeat `services` member; `chunk`/`replica`/`transfer`/`node_service` tables and migrations; placement and ticket routes with `allowedServices`; ticket issue/verify library with holder proof; node-side replay set | wire tests (old node/old Coordinator mixed-version both ways), ticket forgery/replay/expiry/wrong-node/wrong-op/wrong-size tests, migration test from a v0.3.6 database, no bytes anywhere |
| **4.0-alpha.3: direct application-to-node transfer** | node transfer listener (opt-in, panel and CLI), pinned certificate registration, PUT/GET/DELETE with the state machine and receipts; SDK client helpers (`store`, `fetch`, `delete`); local-store use through the same path | end-to-end test in the network-namespace rig (app on one host, node on another, Coordinator on a third, no bytes through the Coordinator, verified by counting its traffic), failure matrix of section 10, resource-limit tests (quota, bandwidth, pause, drain, schedule), measured throughput |
| **4.0-beta: hardening and measurements** | scrubber (read-verify) with I/O throttling, metrics, load and soak, `security.md` threat tests complete, docs; **independent review of the ticket protocol** | no open correctness/security findings; measured numbers published; PrivaDrive can build against it |
| **(Phase 5, not Phase 4)** | node-to-node authorized transfers, replica counts, repair, possession challenges, drain/retirement | per the roadmap |
| **(optional track after alpha.3)** option B (node dials an application endpoint), relay, NAT traversal | | separate design and threat review |

Why this order: alpha.1 proves the dangerous part (a node writing attacker-influenced bytes to disk under quotas) with no network at all; alpha.2 proves the authorization without moving a byte; alpha.3 joins them. Each stage can be abandoned or redone without stranding the others.

## 14. The first implementation task (4.0-alpha.1)

Create the node-local chunk store as a self-contained library with its tests, behind a default-off policy block, with no network and no Coordinator change:

1. `apps/node/src/store/chunk-id.ts`: `ChunkIdSchema` (`chk_` plus 64 lowercase hex), `chunkPath(root, id)` that is the **only** way to build a path (returns `<root>/chunks/<aa>/<bb>/<hex>`), with tests that reject anything else (uppercase, wrong length, `..`, separators, NUL, Unicode lookalikes).
2. `apps/node/src/store/chunk-store.ts`: `ChunkStore.open(rootDir, { maxBytes, reserveFreeBytes, maxChunkBytes, maxInFlight })` verifying the root is a private, node-owned, non-symlink directory; `put(id, stream, declaredSize)` (streaming SHA-256, exclusive `incoming/` file, byte bound, quota check before and during, `fsync`, atomic rename, idempotent when already present and verified), `get(id)` (returns a stream; verifies size), `has(id)`, `delete(id)` (idempotent), `usage()`, `sweepIncoming(olderThanMs)`, `rebuildUsage()`. Errors use a fixed vocabulary (`STORAGE_FULL`, `TOO_LARGE`, `INTEGRITY`, `NOT_FOUND`, `BUSY`, `STORE_UNSAFE`).
3. Add `storage: { enabled:false, maxBytes, reserveFreeBytes, maxChunkBytes, maxInFlight }` to `ResourcePolicySchema` (default disabled, strict, versioned with a migration test from a policy file without it), surface it in `config check` and the panel as read-only, and exclude it from presets until alpha.3.
4. Tests (Node `node:test`, cross-platform): put/get round trip; hash mismatch discards; crash simulation by killing a child process at each of the write steps (before rename, after rename before index) and asserting the store is consistent after `open`; concurrent identical puts; concurrent different puts at the quota edge; planted symlink in `chunks/` and in `incoming/`; non-private root refused; path-like IDs refused; 0-byte and over-limit chunks; `incoming/` debris swept; usage rebuilt after deleting the index; Windows-safe (no assumptions about modes where they do not exist).
5. Docs: `docs/RESOURCES.md` storage section marked "library only, not exposed"; changelog entry under Unreleased; no wire change.

Do not add a listener, a Coordinator route, a signing key or an SDK method in this task.

## 15. 4.0-alpha.1 as built, and what changed from this design

Implemented in `apps/node/src/store/` and released as **0.4.0-alpha.1** (protocol version unchanged, no wire change, no Coordinator change). The store is a library inside the node process: **no listener, no network or Coordinator interface, no SDK client**, so no application could use it in alpha.1. It is **off by default** and, when the owner turns it on, opens no port (and, until 0.4.0-alpha.2, advertised nothing; see [section 16](#16-40-alpha2-as-built-and-what-changed-from-this-design)). Tests: `store-chunk-id`, `store-chunk-store` (including a link/permission attack suite and failures injected at every step of a put), `store-crash` (a child process SIGKILLs itself at each step, then the store is reopened) and `storage-policy` (policy, gate, service, CLI, panel, config check, support bundle, a real node). Everything below that differs from sections 2, 3 and 9 is a deliberate change made while building it:

| Design said | As built | Why |
| --- | --- | --- |
| `index.json` (or a log) with usage, rebuildable | **No index file.** The chunk directories are the only source of truth; counters are rebuilt from a scan of names and sizes at open and kept in memory; `has` and `get` consult the filesystem, never the counters | An index can only ever disagree with the files, and every disagreement is a bug class (stale usage after a crash, a file removed behind its back). With no index there is nothing to reconcile, and the scan is cheap (no hashing). Revisit only if measured start-up time on very large stores demands it |
| Policy block with `maxChunkBytes`, `maxInFlight`, `maxBytesPerSec` and a `listener` | Three owner settings only: `storage.enabled` (default **false**), `storage.maxBytes` (default 1 GiB), `storage.reserveFreeBytes` (default 10 GiB). The chunk limit (8 MiB) and the in-flight limit (8) are constants in `store/limits.ts` | "Do not introduce more knobs than alpha.1 needs." Per-transfer bandwidth and any listener setting belong to alpha.3, which can add them additively |
| `get(id)` returns a stream | `get` **verifies the whole file's SHA-256 before returning any byte**, then streams from the same open descriptor. A file that fails is deleted (the right bytes can simply be stored again) and reported once as `INTEGRITY`, then `NOT_FOUND` | Correctness over a second read of at most 8 MiB. A chunk that does not hash to its name must never be served; deleting it keeps `has`, `get` and the counters mutually consistent. The periodic scrubber remains a 4.0-beta item |
| `has(id)` | A cheap **shape** check (regular file, never a link, size 1 to 8 MiB, owner-only and ours): no hashing | `has` must be cheap; a damaged-but-plausible file is caught by `get`/`put`/the scrubber, and then `has` agrees |
| Concurrency unspecified | Streaming is unlocked; the **commit** (existence check, rename, accounting), `delete` and `rescan` run in one short serialized section. In-flight puts reserve their declared size against the quota | The smallest mechanism that makes "exactly one writer commits" and "counters never underflow" provable, without locking the store while data streams |
| Quota check up front | Checked up front, **again every MiB while writing, and again at commit** (the free-space figure is re-read each time), and a duplicate of an already-stored chunk needs no quota (only disk room for its partial) | A stale free-space reading must never allow an unbounded write |
| Gate unspecified | `store/gate.ts` maps the resource engine's own verdicts (policy off, drain, owner pause, schedule off, battery, owner busy on the disk) to fixed reasons; **only `put` is gated**; reads and deletes only ever reduce what is stored | No second resource-control system |
| Version | `0.4.0-alpha.1` | A new minor for the first Phase 4 code; prerelease because nothing external can use it yet |

Limits stated plainly: one process owns a store at a time (the node); the counters are exact for that process and are recounted from the files at open and on demand (`usage({ fresh: true })`), so a file added or removed by someone else is reflected at the next recount, while `has`/`get` are always current; fsync of the partial and of the shard directory is requested but a filesystem that ignores it can still lose the last write in a power cut (the next start then finds either the whole chunk or none, never half, because the rename is atomic and the content is verified before it); the store never deletes what it does not understand (malformed names, odd files are counted as anomalies and left alone, and reported as DEGRADED).

Alpha.2 (placement metadata and tickets) can build directly on `ChunkStore` (`put`/`get`/`has`/`delete`, `usage`, `StoreError` codes, the gate, `StorageService.chunkStore`); none of it is exposed over the wire yet.

## 16. 4.0-alpha.2 as built, and what changed from this design

Implemented and released as **0.4.0-alpha.2**: the **control plane** for storage and nothing else. The Coordinator can now record which node offers storage, choose a node for a chunk, and sign a short-lived, holder-bound ticket for one transfer, and it tracks every authorization through an explicit state machine. **No chunk bytes pass through the Coordinator, and nothing anywhere accepts or sends them**: there is no `PUT`/`GET /v1/chunks/...`, no node listener, no endpoint field in any message, no replication, no application-to-node transfer (alpha.3), and no PrivaDrive semantics. The protocol version stays **1**: every new field is optional and additive, and a test compiles 0.4.0-alpha.1's real wire schemas from git and parses this Coordinator's answers with them (`tests/storage-compat.test.ts`).

**What exists**

| Part | Where | Notes |
| --- | --- | --- |
| Service registry | `packages/protocol` (`SERVICES`, `ServiceIdSchema`, `capabilityKind`) | `storage.chunk.v1` is `kind: 'service'`; jobs are `kind: 'job'`. Two registries that cannot overlap: a service id is not a `JobType`, so it can never reach `JobTypeSchema`, enrollment grants, heartbeat `capabilities`, `allowedJobTypes` or the scheduler |
| Heartbeat `services` | `HeartbeatSchema` (optional) | `{ 'storage.chunk.v1': { capacityBytes, freeBytes, maxChunkBytes } }`, integers 0 to 2^50, free not above capacity. Absent = nothing offered |
| Node offer | `StorageService.advertisement()` | From the real store and policy (below) |
| `allowedServices` | application record, `AppCreateSchema` (optional) | Absent means none. Stored only when non-empty. Separate from `allowedJobTypes`: neither implies the other |
| Tables (migration 2) | `chunk`, `replica`, `transfer`, `node_service` | SQLite; metadata only; migration 1 untouched |
| Placement and tickets | `apps/coordinator/src/storage.ts` | `StorageControl` |
| Signing keyring | `apps/coordinator/src/transfer-keys.ts` | Its own private file, never in the database |
| Ticket and holder proof | `packages/shared/src/transfer-ticket.ts` | The library alpha.3's node listener will call |
| Routes | see [protocol](protocol.md#storage-control-plane-040-alpha2-protocol-version-stays-1) | Application, node and administrator |
| Admin | `privanet-admin storage status|rotate-key`, `application --services`, dashboard card | Aggregates only |

**Differences from sections 4 to 7, and why (also recorded as amendments to ADR 007 below)**

| Design said | As built | Why |
| --- | --- | --- |
| Public keys delivered in the **session response** | A new authenticated node route, **`GET /v1/node/transfer-keys`**, fetched best effort after connecting (only by a node that offers storage) | `SessionSchema` is a strict object that every deployed node parses: one extra field and no older node could sign in. The route's answer names the Coordinator (`coordinatorId`) and a node keeps keys only when that is the Coordinator it is bound to. An older Coordinator answers 404 and the node treats storage as unavailable. Keys are held in memory and refetched at every connect; nothing needs them persisted until the listener exists |
| `services` carries `transferEndpoint?` | **No endpoint field** | An endpoint that nothing listens on would be a promise. alpha.3 adds it, additively, together with the listener |
| Placement returns a node/endpoint, tickets are a separate call | **`POST /v1/storage/placements` carries the holder key and returns the first `put` grant**; `POST /v1/storage/tickets` serves `get`, `delete` and a `put` retry | One round trip for the common case; the application still never names a node, and the response names no node (the target is inside the signed ticket, as it must be) |
| Ticket "compact, canonical" | **Fixed-length binary**, 170 payload bytes plus a 64-byte Ed25519 signature, 312 base64url characters, no JSON | A fixed layout has no field order, optional member or alternate encoding to disagree about. Exact signed bytes are below |
| A node whose heartbeat is refused by an older Coordinator | The new node **drops the `services` member after one 400, says so once, and carries on** (tried before the job-slots fallback) | The old Coordinator's strict heartbeat schema answers 400, and the daemon treats a 400 as fatal otherwise. Tested against a real old strict schema |
| `POST /v1/storage/transfers/{id}/complete` (application) and `POST /v1/node/storage/receipts` | **Neither route exists yet.** The evidence rules are implemented and tested as service methods (`begin`, `fail`, `complete`); **only application `abort` is a route** | With no bytes moving, a live receipt route would let a node create a `STORED` chunk from nothing, and an application's own "complete" was never authoritative. alpha.3 adds the node routes on top of rules that already have tests |
| Node-side replay set persisted | A bounded `ReplaySet` library (in memory); the Coordinator side is real (a transfer id `begin`s once) | There is no node consumer until alpha.3, which persists it |
| Retention hint (`expiresAt`) | A nullable column only; no route sets it | Nothing garbage-collects by it yet |

**What exactly is signed.** A ticket is `base64url(payload || signature)`, 234 bytes, no padding. The signature is Ed25519 over `"privanet.transfer-ticket.v1\0" || payload`. The payload (big-endian, fixed offsets):

```text
 0   1  version (1)
 1   8  kid: first 8 bytes of SHA-256 of the signing key's SPKI DER
 9  16  transfer id (random)
25   1  operation: 1 put, 2 get, 3 delete
26  16  application id (the UUID's 16 bytes)
42  32  chunk id (the 32-byte digest of chk_<hex>)
74  32  target node id (the 32-byte digest of node_<hex>)
106  4  maxBytes: put = the exact size, get = the chunk's size, delete = 0
110  6  issuedAt (ms)
116  6  expiresAt (ms): at most 120 000 ms after issuedAt
122 32  holder public key (raw Ed25519)
154 16  nonce (random)
```

Validity: `issuedAt - skew <= now < expiresAt + skew`; the upper bound is **exclusive** (with no skew a ticket is expired at exactly `expiresAt`); skew is at most 30 s; lifetime is checked from the signed claims, so a validly signed ticket with a longer window is still refused. The verifier (`verifyTicket`) checks, in a fixed order: size, strict base64url and exact length, version and operation code, the `kid` against the trusted list (the list entry's own `kid` must match the hash of its key, and a key past its `notAfter` is refused), the signature, lifetime, window, size rules for the operation, then node, operation, chunk, application and size expectations, and finally the consumer's replay set. It returns one of fourteen fixed error words and never library text. Test vectors (`tests/transfer-ticket.test.ts`) pin every byte; all 1872 single-bit flips of a valid ticket are refused.

**Holder binding.** The application makes a fresh Ed25519 pair per transfer and sends only the public key. When the node's listener exists, the node sends a 32-byte challenge and the holder signs `"privanet.holder-proof.v1\0" || challenge(32) || transfer id(16) || SHA-256(request line)(32)` (fixed length; the request line is, for example, `PUT /v1/chunks/chk_...`). `generateHolderKey`, `newHolderChallenge`, `signHolderProof` and `verifyHolderProof` exist now; the Coordinator never holds a holder private key and stores only the SHA-256 of the holder public key.

**Signing-key lifecycle.** A dedicated Ed25519 key, generated on first use (exclusively: concurrent first starts agree on one key), kept in `transfer-keys.json` in the Coordinator's data directory (owner-only, never in SQLite, so neither the database nor `npm run backup` carries it), never logged or returned. A file that is unsafe or damaged is a hard error with a fixed code; **it is never silently replaced** and storage stays off while jobs carry on. `privanet-admin storage rotate-key` makes a new key current; the old one keeps verifying for **270 s** (2 x the ticket lifetime plus the skew) and then leaves both the file and what nodes are told, so rotation never breaks a live ticket. At most four keys are live. Losing the file costs at most the tickets of the last two minutes: a new key is generated and nodes fetch it when they next connect. A restore of a database onto a new data directory therefore gets a new key, and tickets from before the backup cannot verify.

**Placement.** A request is `{ chunkId, size, class?, holderKey }`. Among nodes that are ONLINE (a recent heartbeat, so the advertisement is fresh), not draining, not revoked, not paused by their owner, advertising the service with a `maxChunkBytes` that fits and with `freeBytes` minus the bytes already reserved on them at least the chunk size, and under their open-transfer limits, the Coordinator picks by **free-space-weighted random**. No market, no reputation, no application preference. It records a PENDING chunk, a RESERVED replica and an AUTHORIZED transfer in one transaction (a single writer), so concurrent requests can never reserve more than the nodes reported. **A placement is permission to attempt, not a guarantee and never permission to exceed a node owner's own quota**: the node re-checks at every transfer (alpha.3). A retry for the same chunk gets a new ticket on the same node while it is eligible (another node otherwise) and revokes the older open ticket, so at most one `put` is open per chunk.

**State.** Chunk: `PENDING` (placed, not confirmed), `STORED` (only on a node's receipt), `DELETING` (a delete was authorized; the chunk is removed only on the node's receipt). Replica: `RESERVED`, `STORED`, `LOST`. Transfer: `AUTHORIZED` -> `IN_PROGRESS` -> `COMPLETED`, or `FAILED`, `EXPIRED` (only from `AUTHORIZED`), `REVOKED`; the transitions are one table (`TRANSFER_TRANSITIONS`) and anything else is refused with `INVALID_TRANSITION`. A lapsed unused ticket is expired the moment anyone looks at it. Completion evidence must come from the target node, authenticated as itself, and match the transfer, application, chunk, hash (the digest in the chunk id) and size; completing twice with the same evidence is a no-op and a finished transfer never changes again.

**Isolation, revocation, limits.** Chunks are keyed `(application, chunk)`; another application's chunk and a missing chunk produce identical answers (404), byte for byte, on every route. Revoking an application revokes its open transfers and deletes nothing. Revoking a node revokes its open transfers, makes its stored copies `LOST` (kept for audit and for Phase 5), releases its reservations and removes its offer; an owner turning storage off only removes the offer. A node that is merely offline is "unavailable" (503), a lost copy is "unavailable" (409): neither deletes metadata. Per application: logical bytes (default 256 GiB), chunk count (100 000), open transfers (256) and tickets per minute (120); per node: 8 open puts and 64 open transfers. Cleanup (throttled, never on the lease path): unused tickets expire, a begun transfer that never finishes fails after 10 minutes, an untouched PENDING chunk is withdrawn after 15 minutes, finished transfers are deleted after 7 days and advertisements older than the offline threshold are deleted.

**Compatibility and downgrade.** A new node against an older Coordinator works (it drops `services` after one refusal and never asks for keys); an older node against this Coordinator works (it never sends `services`); every response an older node, admin tool or SDK parses is unchanged (the session response, node list, capability list and credentials are asserted against 0.4.0-alpha.1's strict schemas). The database upgrades in place (migration 2 adds four tables and touches nothing), applications gain no service, and a failed migration leaves a usable version 1 database. **Downgrading is not supported**: an older Coordinator refuses a version 2 database ("schema is newer than service"); restore a pre-upgrade backup instead.

**Open questions for before alpha.3 (not solved here).** Any enrolled, non-revoked node may offer storage; whether an operator should be able to restrict which nodes may (a per-node `allowedServices` on enrollment grants) is undecided. A PENDING chunk whose put the node completed but whose receipt was lost leaves an orphan on the node until alpha.3's reconciliation. The holder-binding handshake, the persisted replay set and the key lifecycle still need the independent review the plan already requires.

**Plan for 4.0-alpha.3 (direct application-to-node transfer).** (1) The node's opt-in listener: TLS, a closed `PUT`/`GET`/`DELETE /v1/chunks/{id}` surface, `Content-Length` equal to the ticket's size, slow-client and in-flight limits, off by default and never started by the storage policy alone. (2) Certificate registration and pinning: the node registers a certificate fingerprint; the Coordinator returns a validated endpoint and fingerprint in the grant (additive); applications never supply endpoints. (3) Node verification: `verifyTicket` with the keys from `/v1/node/transfer-keys`, the Coordinator-clock offset for skew, the holder challenge, a persisted `ReplaySet`, the owner's gate and quota, then the ChunkStore. (4) Node routes: `begin` (before the first byte), `fail`, and the receipt route that calls `complete`, over the node's session, with retry until acknowledged; the Coordinator reconciles a missing receipt. (5) Application helpers in the SDK (`store`, `fetch`, `delete`) with chunk verification against the id. (6) Local-store use through the same path. (7) The end-to-end test in the namespace rig (application, node and Coordinator on three hosts, bytes counted to prove none touch the Coordinator) and the failure matrix of section 10.
