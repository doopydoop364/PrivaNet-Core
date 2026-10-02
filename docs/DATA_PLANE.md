# Control plane and data plane

Status: **architecture decision (ADR 006): ACCEPTED as direction. Design only: nothing in this document is implemented.** As of 0.4.0-alpha.2 the **authorization half** exists (placement metadata and Coordinator-signed transfer tickets with their state machine, [PHASE4_DESIGN section 16](PHASE4_DESIGN.md#16-40-alpha2-as-built-and-what-changed-from-this-design)); **no transfer service, node endpoint or byte-moving code exists**, and the rest is scheduled for 4.0-alpha.3. A concrete proposal that answers most of the open questions at the end of this document is in [PHASE4_DESIGN.md](PHASE4_DESIGN.md) (proposed ADR 007). Related: [architecture](architecture.md#adr-006-control-plane-and-data-plane-are-separate), [protocol](protocol.md), [security](security.md#data-plane-threats-planned), [RESOURCES](RESOURCES.md), [APPLICATION_BOUNDARY](APPLICATION_BOUNDARY.md), [RESOURCE_MARKET](RESOURCE_MARKET.md), [CREDITS](CREDITS.md), [TREASURY](TREASURY.md), [roadmap](../ROADMAP.md).

> **Decision.** PrivaNet separates control and data planes. The Coordinator authorizes and schedules resource use; large payloads move directly between authorized participants through narrowly scoped data-plane operations. **The Coordinator is the control plane, not the bulk-data pipe.**

## 1. The three layers

```text
Applications        PrivaSearch, PrivaDrive, Privaproxy (where relevant), future applications
      |  SDK / wire protocol only (control plane)
      v
Control plane       PrivaNet Coordinator
                    application auth, node identity / enrollment / auth, capability registry, scheduler,
                    job state, leases, placement decisions, transfer authorizations,
                    (later) accounting, resource market, Network Treasury
      ^
      |  control messages (authenticated, bounded)
      v
Resource / data plane   PrivaNodes
                    actual compute, actual storage, actual bandwidth,
                    application <-> node transfers, node <-> node transfers
```

The Coordinator decides **what** should happen and **who** is authorized to do it. The data plane carries the large payloads. The Coordinator stays authoritative even when it does not carry the bytes.

```text
CONTROL PLANE:  Application <-> Coordinator        PrivaNode <-> Coordinator
DATA PLANE:     Application <-> PrivaNode          PrivaNode <-> PrivaNode
```

## 2. The invariant: all work begins at the Coordinator

There is no bypass. An application never selects or trusts a node on its own, and a node never accepts data because a caller asked. The only valid pattern is:

```text
Application -> Coordinator -> authorization / placement / lease -> direct data path where appropriate
```

Every direct transfer is preceded by a Coordinator decision and referenced by a Coordinator-issued identifier, so placement, permission, state and (later) accounting have one authority. A node that receives bytes with no matching authorization refuses them.

## 3. What exists today, and what stays as it is

Today's typed-job path carries everything through the Coordinator:

```text
Application -> SDK -> Coordinator -> authenticated PrivaNode -> result -> Coordinator -> Application
```

This is correct and stays for small typed work: `system.echo.v1`, `system.hashchain.v1`, bounded metadata, small typed inputs and results, and the initial `web.fetch.v1` crawling (results are digests of at most 28,000 bytes). The Coordinator's own limits (32 KiB request bodies, 512 KiB responses, a bounded result per job type) already make it impossible to use as a bulk pipe by accident; keep them. The direct data plane becomes necessary when payload size makes relaying through the Coordinator inefficient, and not before.

**Rejected shape:** `PrivaDrive -> 8 GiB -> Coordinator -> 8 GiB -> storage node`. It doubles the Coordinator's bandwidth burden and makes the control plane the bottleneck.

**Intended shape:**

```text
PrivaDrive -> Coordinator : request placement for encrypted chunks
Coordinator                : choose eligible storage nodes, create short-lived transfer authorizations
PrivaDrive => storage nodes: upload encrypted bytes directly
nodes / application -> Coordinator : completion or failure evidence
Coordinator -> PrivaDrive  : committed / failed
```

The Coordinator carries metadata, authorization and state transitions, never the file.

## 4. Where this lands in the roadmap

| Phase | Data-plane stance |
| --- | --- |
| 3 PrivaSearch on PrivaNet | Normal typed-job control path. Bounded `web.fetch.v1` results stay inline. Use real crawl measurements to decide whether larger-result transfer is ever necessary. **Build no generic data plane speculatively.** |
| 4 Generic Storage + Data Plane Foundation | The first generic direct-transfer system: application to node, bounded object/chunk PUT and GET, Coordinator-issued short-lived transfer authorization, integrity verification, completion and failure reporting, expiry and revocation, scope and byte limits, object/chunk identity, safe retry and resume if justified. **Local-node transfers use the same mechanism as remote nodes.** |
| 5 Distributed Storage | Node to node authorized transfers: replication, repair, migration, rebalancing, graceful retirement, possession and integrity verification, failure-domain-aware placement. |
| 6 PrivaDrive Integration | PrivaDrive uses the generic data plane. PrivaDrive owns files, folders, metadata, sharing and encryption semantics; PrivaNet owns physical chunk storage, placement, transfer authorization and repair. |
| 7 Measurement and Accounting | Consumes verified data-plane evidence (section 10). |

Phase 4 implementation does not begin while Phase 3 is still being proven. The only permitted earlier change is a minimal interface adjustment that avoids a future breaking redesign; the review in section 12 found none.

## 5. Transfer authorization (the concept, not a wire format)

A **transfer authorization** (working name: transfer ticket) is the Coordinator's statement: *"You may upload exactly this bounded object to this authorized node during this short window."* The exact wire format is deliberately not fixed. Its **security properties** are:

| Property | Meaning |
| --- | --- |
| Coordinator-authorized | Issued, or cryptographically authorized, by the Coordinator; nothing else can create one |
| Short-lived | Expires in seconds to minutes; the node checks expiry against its own clock with a bounded skew allowance |
| One operation | PUT or GET (or a node-to-node send or receive), never "any" |
| One resource | One specific object, chunk or job; a different object is refused even from the same holder |
| One intended node, or one node pair | Bound to the target node's identity; useless against any other node |
| Byte-bounded | A maximum size; the node stops reading at the bound |
| Integrity-bound | Carries the expected content hash (or hash commitment) where known, so substitution and corruption are detected |
| Non-reusable or explicitly idempotent | A ticket is consumed once, or its retry semantics are defined; a duplicate never double-stores or double-counts |
| Revocable where practical | The Coordinator can withdraw it; revocation and in-flight transfers have defined semantics (open question 12) |
| Auditable | Carries a Coordinator-issued reference ID that ties it to a recorded transfer state |
| Replay-safe | A captured ticket cannot be replayed to store or fetch anything else |
| Incapable of general access | It is never a bearer credential for the node, its filesystem, its network or its other transfers |

Illustrative fields only (not a schema): `transferId`, `operation`, `resourceId`, `targetNodeId`, `maxBytes`, `contentHash`, `expiresAt`, `authorizationVersion`.

A ticket **never overrides owner limits**. A valid ticket on a node whose policy is paused, out of disk, over its bandwidth allowance or outside its schedule is refused; the owner's limits stay authoritative exactly as they are for jobs.

## 6. The node-side transfer service

Future PrivaNode direct-data functionality is a **dedicated, restricted transfer service**. It is not, and must never become: a general file server, an arbitrary filesystem API, a shell, an HTTP proxy, a socket forwarder, or a generic upload endpoint. It accepts only Coordinator-authorized operations and, for each request, verifies:

- authorization validity (signature, MAC or token form, once chosen);
- that the target node identity is this node;
- the operation, resource ID and maximum size;
- expiry, and replay or idempotency state;
- the integrity requirement (content hash, verified while streaming);
- the current owner resource policy.

It is operationally separate from the job runner, has its own limits and its own log events, and is off unless the owner enables the storage capability. Data it stores lands only in the node's dedicated scratch/storage area under the disk limits of [RESOURCES](RESOURCES.md), never at a path the caller influences.

## 7. Application to node flow (Phase 4)

```text
Application  -> Coordinator : request storage / data operation (idempotency key, size, class, hash)
Coordinator  -> Coordinator : authenticate, authorize (allowed capability, quota), place (eligible node(s))
Coordinator  -> Application : node endpoint(s) + transfer authorization(s)
Application  => Node        : direct, opaque or encrypted bytes (bounded, hash-verified)
Node         -> Coordinator : completion or failure (with evidence)
Coordinator  -> Application : committed / failed
```

**The application must not choose arbitrary nodes.** The Coordinator is the authority for placement and transfer permission; an endpoint received from the Coordinator is bound to a node identity the application can verify (open questions 4 and 5).

## 8. Node to node flow (Phase 5)

```text
Node A -> Coordinator : state (holds chunk X, health, drain or repair need)
Coordinator           : decides repair / replication / migration / rebalance
Coordinator -> Node A : authorized to SEND chunk X to Node B
Coordinator -> Node B : authorized to RECEIVE chunk X from Node A
Node A => Node B      : direct chunk transfer
both nodes -> Coordinator : completion and evidence
```

Supports replication, repair, migration, node drain and rebalancing. Large storage traffic never transits the Coordinator. Repair authorization differs from application upload authorization in who initiates (the Coordinator, not an application), in the required receipts (both ends) and in what the receiver verifies (a known chunk hash from durable state), which is open question 11.

## 9. Coordinator responsibilities after the split

The Coordinator primarily processes: job submissions, authentication, node heartbeats, leases, scheduling, placement, transfer authorization, completion state, and accounting metadata (and, later, market and treasury data). The scaling model is:

```text
more nodes / more stored data  ->  more control messages at the Coordinator
NOT: more nodes / more stored data  ->  all application bytes through the Coordinator
```

This keeps the Coordinator light enough for a modest always-on machine. Its bandwidth and CPU scale with the number of operations and nodes, not with bytes stored.

## 10. Accounting implications (Phase 7 and later)

Direct transfers happen outside the Coordinator, so accounting must rest on **verified evidence**, not on what was authorized. Later accounting distinguishes: authorized transfer, actual verified useful bytes, failed or partial bytes, storage duration, repair traffic, application traffic, and duplicate or retry traffic. **A node is never rewarded because a ticket was issued.** Only verified useful consumption becomes billable or rewardable; a future market, credits or treasury logic uses actual verified data-plane usage, never requested capacity (see [RESOURCE_MARKET](RESOURCE_MARKET.md), [CREDITS](CREDITS.md), [TREASURY](TREASURY.md)). What counts as sufficient evidence, and how to avoid double counting across retries, are open questions 10 and 13.

## 11. Deployment model

First deployment:

```text
Always-on server
  |- Coordinator          HIGH priority, always available
  |    state/database, auth and node registry, scheduler and leases,
  |    (later) accounting, market, treasury
  `- PrivaNode (optional) LOW / adaptive priority, spare resources only
```

The server's PrivaNode is optional and operationally separate from the Coordinator (separate process, separate state directory, separate credential). It runs with conservative limits so control-plane availability wins over contributed work, the Coordinator must not depend on it being up, and it is scheduled **through the same authenticated path as any remote node**. There is no localhost special case, in jobs or in transfers.

Applications may live anywhere and always use the SDK and control plane regardless of where they run:

```text
Development:  Server: Coordinator + PrivaNode      Desktop: PrivaSearch + PrivaNode
Later:        Server A: Coordinator   Server B: PrivaSearch   Server C: PrivaDrive backend
              desktops, laptops and community machines: PrivaNodes
```

Running an application on the Coordinator's server is a deployment choice, not an architectural requirement.

## 12. Job result evolution: is the current model compatible?

We may eventually need both a small inline result and a result by reference through the data plane (`JobResult = InlineResult | DataReference`). **This abstraction is not introduced now.** Review of the current design:

- **The wire result is already open.** A job's `result` is `z.unknown()` on the wire and is validated by the Coordinator against the **per-job-type output schema** in the registry. A type can therefore gain an optional reference field additively, or a new version id (`x.y.v2`) can define reference results, without touching the wire envelope. Existing types and old clients are unaffected because the registry is versioned by job id and protocol 1 allows only additive optional changes.
- **Lease and heartbeat extensions are additive.** New optional lease fields (already done once for `client`) and optional heartbeat or capability fields (for a future node data endpoint or `storage.*` capability) fit the additive rule; nodes and clients that do not know them still parse, because strict schemas gain only optional members and the Coordinator emits them only for types that require them.
- **The size limits are a feature.** The 32 KiB request and 512 KiB response caps prevent accidental bulk relaying; they should not be raised to make room for data.
- **Node identity is reusable.** Nodes already have an Ed25519 identity and a node ID derived from the public key, which is a natural anchor for endpoint binding.
- **Gap, recorded and not fixed now:** the Coordinator has an identifier but **no signing key**. Transfer authorizations will need either a Coordinator signing key that nodes can verify or per-node MACs (open question 1). Adding a key now would be speculative and would lock a form prematurely, so it waits for Phase 4 design.
- **Nothing found that would force a protocol-breaking rewrite.** No code or protocol change is made for this decision.

For PrivaSearch, `web.fetch.v1` keeps returning bounded inline digests. If measurements later show that pages or extracted documents are large enough to matter, a future version could return metadata inline plus a content hash and a bounded result reference, with the application fetching the content directly from the node under a transfer authorization. That change is evidence-driven, not anticipated.

## 13. Connectivity

Direct node connectivity is a separate future networking problem and is **not solved here**. Environments to expect: same LAN, a WireGuard or private overlay, a publicly reachable node endpoint, and later NAT traversal or a relay if needed. The architecture must not require every node to be publicly exposed. If relaying becomes necessary it is its **own bounded data-plane service** with its own limits, authorization and accounting, never the Coordinator's normal request path. **LAN is not trusted:** a transfer is authorized by ticket and identity, never by network location.

## 14. Threats (summary; the full table is in [security](security.md#data-plane-threats-planned))

Stolen, replayed, expired, wrong-node, wrong-object, byte-limit-bypass, substituted, corrupted or incomplete transfers; malicious sender or receiver; an application or node lying about completion; endpoint spoofing and DNS or endpoint substitution; authorization leakage; concurrent duplicate uploads; races around revocation and expiry; accounting double counting; resumption abuse.

Planned defenses: narrow scope, short expiry, cryptographic binding, hashes, idempotency keys, Coordinator-issued reference IDs, transactionally recorded transfer state, receipts from both ends where needed, integrity verification, an explicit transfer state machine (conceptually `AUTHORIZED -> IN_PROGRESS -> COMPLETED | FAILED | EXPIRED | REVOKED`), and no implicit trust based on network location.

## 15. Observability

Future data-plane metrics are aggregate: transfer count, authorized bytes, completed bytes, failed bytes, retry count, latency, throughput, authorization expiry and replay failures, and per-resource-class usage. They avoid user and content disclosure. **Never logged:** file contents, encryption keys, raw private data, or the ticket itself (log the reference ID).

## 16. What PrivaDrive and PrivaSearch should assume

- **PrivaDrive** is the first strong requirement for the data plane. It should never need to send large encrypted payloads through the Coordinator. It owns encryption and keys; PrivaNet stores opaque encrypted chunks and never needs plaintext. How opaque chunks are verified without plaintext is open question 14.
- **PrivaSearch** keeps using typed jobs with inline bounded results. It should not adopt the data plane speculatively.

## 17. Open design questions (recorded, not answered)

These need measurements or implementation experience and are deliberately left open.

1. What cryptographic form should transfer authorizations use (Coordinator-signed token, per-node MAC, macaroon-style attenuable token, mTLS-bound)? Note the Coordinator currently has no signing key.
2. Single-use or idempotently reusable tickets?
3. How does transfer resumption work (range requests, chunk-level restart), and how is resumption abuse bounded?
4. How is an endpoint bound to a node identity (key-pinned TLS, signed endpoint records)?
5. How are direct endpoints discovered safely (Coordinator-provided only, never application-supplied)?
6. How do NAT or private nodes participate?
7. When is a relay fallback necessary, and what bounds it?
8. Initial data-plane transport: HTTPS, HTTP/2, HTTP/3 or something else?
9. How do large result references integrate with typed jobs (new versions, optional fields, a shared reference type)?
10. What evidence is sufficient to account a completed transfer (receiver hash receipt, sender receipt, Coordinator-side challenge)?
11. How should node-to-node repair authorization differ from application-to-node upload?
12. How should revocation interact with an in-progress transfer (fail fast, finish and discard, bounded grace)?
13. How do we avoid duplicate accounting after retries and resumption?
14. How can encrypted PrivaDrive chunks be verified without exposing plaintext (ciphertext hashes, possession challenges)?
