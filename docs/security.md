# Security and privacy

## Implemented boundaries

Nodes and applications are untrusted. Strict allowlists and exact schemas bound
inputs. Node code contains fixed, compiled-in handlers for exactly two registered job types (`system.echo.v1` and the CPU-bound `system.hashchain.v1`), never a shell or interpreter.
Echo strings remain data even when they look like commands; the hash-chain handler only computes SHA-256 over bounded input. Both Coordinator
and worker validate input/output. Validation proves shape, not honest results.
Admin, app and node bearers have separate namespaces and role checks; job reads
check application ownership and submit checks allowed type. Unknown capability
and broader-than-enrollment advertisements fail closed. Operator disabled
capabilities are checked again immediately before execution.

Ed25519 possession is checked by built-in crypto over fresh coordinator-bound
one-use expiring challenges. Grants are consumed transactionally. Random bearer
secrets use 256 bits, DB holds SHA-256 hashes, admin comparison is constant-time.
Revocation is consulted on every operation. TLS verifies remote Coordinator
identity; clients refuse redirects and non-HTTPS destinations other than explicitly
allowed literal loopback HTTP. Local traffic still authenticates all roles.

Replay of a used proof fails; duplicate job submission/completion is explicitly
idempotent. Durable lease IDs fence late/duplicate results, including after
Coordinator restart. Sessions/challenges expire and are pruned. Pre-authentication
requests have bounded per-address rate limiting and a bounded bucket map;
challenge creation also has a global pending limit. Trusted proxy IP headers are
not used. Production reverse proxy must supply perimeter limits/TLS and prevent
direct access to the plain HTTP listener. Socket address limits can group all
proxy clients; they are not a complete Internet abuse defense.

Private runtime directories/identity files reject symlinks and unsafe POSIX
permissions; use 0700/0600. Windows needs operator-owned ACLs (POSIX mode checks
cannot prove Windows ACL safety). No private keys, grants, bearer values, request
bodies or headers are logged. Structured logs use fixed event/code fields.
Public errors contain fixed messages, never raw validation/database exceptions.

### Node-local state added in v0.2.1

The node keeps three more owner-private items in its state directory: `transfer.json` (a month's transferred byte count), `checkpoints/` (bounded, typed, age-limited partial state for checkpointable jobs, never sent anywhere; job input can appear in it, so treat the directory like the identity file) and an optional `DRAIN` request file that any local writer can use to drain the node, which is the owner's own trust boundary. The macOS and Windows battery probes run fixed, argument-free system commands and read only their output. The bandwidth and disk limits are enforced by the node for the owner's benefit; a compromised node is not bound by them, and the Coordinator only ever sees the resulting budget.

## Coordinator knowledge

The Coordinator learns node public key/stable ID, daemon/protocol version,
capabilities, heartbeat receipt times, workload/slot counts, job payloads/results
and app ownership, plus (v0.2) the node's lifecycle and its resource report: coarse contribution/pressure/power states and the permitted memory/CPU budget, and (v0.2.1) the permitted scratch-disk budget, disk-I/O class, remaining transfer allowance and `availableForMs`, which reveals roughly how long until the owner's schedule turns contribution off (a coarse hint about the owner's routine). Network peers/reverse proxies inherently see addresses and
timing. SQLite grants/sessions contain hashes, not originals. No telemetry,
third-party analytics, host inventory or raw resource metrics. Raw memory/CPU samples are read locally to compute the budget and are never transmitted or stored. Power state is read from the Linux power-supply files, or on macOS and Windows from a fixed OS command (see below); free disk space of the state directory's volume and, on Linux, disk and network activity counters are also read locally and only ever reduced to the budget.
Job input and output (echo messages, hash-chain seeds and digests) are plaintext and retained with job state. Use synthetic data;
there is no job encryption. Finished jobs are deleted after the configurable retention period (default 30 days; 0 keeps them), but there is no audit log or per-tenant storage quota.
Application and enrollment secrets are returned once to authorized operators;
the operator must deliver them securely and must not paste them into logs.

## Market-specific threats (planned)

Status: **planned.** No market, credits or rewards exist, so none of these attacks applies to the current code; they are recorded now so later interfaces do not make them easy. The governing rule: only Coordinator-authorised, policy-valid, verified resource consumption may generate contributor rewards, and advertising capacity must never create credits. See [RESOURCE_MARKET.md](RESOURCE_MARKET.md).

| Threat | Why it matters | Planned direction |
| --- | --- | --- |
| Fake demand / wash activity | Consuming your own resources to look busy or farm rewards | Circulation-based ledger makes it zero-sum (minus fees); bounded subsidies; reward only policy-valid consumption |
| Fake contribution | Claiming storage, bandwidth or compute not actually provided | Independent verification: challenges, spot checks, redundancy, two-ended accounting |
| Falsified resource telemetry | Nodes already report untrusted budgets (v0.2) | Never pay for self-reported figures; telemetry is a scheduling hint |
| Colluding nodes / clients | Two accounts exchange useless data to mint rewards | Rewardable traffic must be Coordinator-authorised for an application purpose; related-party limits; anomaly detection |
| Bandwidth farming | Cheap junk traffic priced per GiB | Count only valid application traffic; exclude repair and wash traffic |
| Deliberately useless compute jobs | Paying yourself through the job system | Typed registry, application pays, verified units only |
| Storage churn for rewards | Repeatedly storing and deleting to earn | Reward retained data over time; charge churn and repair; minimum terms |
| Sybil nodes and accounts | Many identities to gain influence, allowances or price power | Enrollment control; identity cost and reputation in Phase 10; identities never buy price influence alone |
| Clearing-price manipulation | Strategic asks or thin markets move the price | Uniform-price design to research, thin-market fallback, movement limits, circuit breakers |
| Withdrawing supply to create scarcity | Coordinated exits to raise the price | Withdrawal statistics, notice for stored data, guardrails; graceful/pressure exits must not be over-penalised |
| Free-allowance farming | Subsidy leaks to fake accounts | Bounded pool, per-account limits, account-gating |
| Credential theft | Stolen node or app credentials earn or spend credits | Revocation, per-account limits, reversal entries |
| Ledger replay or duplicates | Double settlement | Idempotent events keyed by job/lease/attempt |

Market data itself is a privacy risk: aggregate only, with minimum participant thresholds, and no per-node or per-user disclosure.

## Treasury-specific threats (planned)

Status: **planned.** There is no treasury, levy, public budget or bootstrap program, so none of these apply to the current code. They are recorded so the design and later interfaces do not make them easy. See [TREASURY.md](TREASURY.md). A treasury is a shared pot of internal credits, which makes it a higher-value target than any one account.

| Threat | Why it matters | Planned direction |
| --- | --- | --- |
| Draining public budgets with fake jobs | Attackers or a bug spend the shared fund | Per-bucket, per-period caps; per-job maximum price; only verified work is paid; anomaly alerts |
| Fake public-crawl demand | Bogus crawl targets or submitted URLs that exist only to earn | Public queue is created by PrivaSearch policy, not by arbitrary requesters; crawl output verification; per-host and per-domain caps |
| Fake contributor onboarding | Enrolling many nodes to claim bootstrap value | Bootstrap only matches verified useful contribution; bounded lifetime subsidy; delayed vesting; no gift for installing; no fragile KYC |
| Repeated node/account churn | Re-enrolling to reset onboarding eligibility | One bootstrap per account-to-node relationship, minimum reliability window, rate limits, anti-Sybil work in Phase 10 |
| Collusion and wash resource activity | Colluders exchange useless work to collect levy-funded matches or public spend | Treasury-paid work does not itself earn treasury match; related-party limits; the levy makes wash activity cost credits; anomaly detection |
| Manipulating prices before treasury purchases | Pump the price, then sell to the treasury | Maximum willingness to pay, reference-price ceilings, thin-market protection, circuit breakers, purchase throttling when scarce |
| Treasury overpaying under artificial scarcity | Coordinated supply withdrawal raises what the public budget pays | Withdrawal statistics, price-movement limits, pause non-urgent purchases when scarce |
| Public-job spam | Flooding the public queue to starve real work or drain budgets | Queue and rate limits, dedup, priority below private and owner work, budget caps |
| Compromised PrivaSearch scheduler | A trusted component spends its whole bucket | Isolated bucket caps and maximum prices bound the loss; spend is still verified; alerts on budget velocity |
| Compromised administrative treasury policy | Attacker or insider changes levy, caps or bucket transfers | Versioned policy, audit trail, bounded parameter ranges, review or delay for large changes, separate authority for emergency spending |
| Replaying treasury settlement events | Same settlement credits the treasury or a payout twice | Idempotency keyed by job/lease/attempt and reference ID |
| Duplicate treasury payouts | Retries or restarts pay twice | Idempotent events, one payout per reference ID, reconciliation checks |
| Budget overflow and race conditions | Concurrent spends exceed a cap or go negative | Transactional budget reservation and decrement, integer amounts, non-negative invariant, explicit limits |
| Hidden minting through treasury operations | Issuance disguised as levy income inflates credits | Issuance is a separate explicit event and metric; conservation checks on every settlement |

Requirements for any future treasury code: idempotency, transactional updates, explicit budget limits, policy versions and auditable reference IDs. Aggregate metrics only; no per-node or per-user disclosure.

## Fetch job threats (planned)

Status: **implemented in v0.3.0-alpha.1** (`apps/node/src/fetch/`; tests in `tests/fetch-*.test.ts`). These tests are not a security review; residual risks: TLS uses the system trust store, robots are advisory, a node's owner network is only as isolated as its policy. The generic `web.fetch.v1` capability described in [PRIVASEARCH_INTEGRATION.md](PRIVASEARCH_INTEGRATION.md), whose first consumer is the separate PrivaSearch application. The governing rule: the fetch job is a constrained GET for permissioned applications, never a general proxy, and it contains no application policy ([APPLICATION_BOUNDARY.md](APPLICATION_BOUNDARY.md)).

| Threat | Why it matters | Planned direction |
| --- | --- | --- |
| SSRF to localhost, LAN, link-local or cloud metadata | A fetch job could reach internal services from a node | Reject IP literals and internal names; resolve on the node, check every address (IPv4-mapped, NAT64 and 6to4 by embedded IPv4), connect to the vetted address; re-check every redirect and the connected socket; ignore proxy environment variables; only an owner-local, default-empty CIDR allow list can relax it |
| DNS rebinding | Name resolves to a public address at check time and a private one at connect time | Connect by the vetted address (pinned lookup), never re-resolve |
| Exit-node or proxy abuse | Community nodes fetch arbitrary URLs from their owners' addresses | Closed job type: fixed GET, no caller headers or body, ports 80/443, no IP targets, same-origin redirects, digest results only; only credentials granted the capability may submit; owner opt-in; per-host and overall rate limits; residual risk from a compromised credential stated in the spec |
| Compromised application credential (for example PrivaSearch's) or scheduler | Directs nodes at attacker-chosen public URLs | Revocation and rotation; per-application budgets and host concurrency before public nodes; robots enforcement; identifiable user agent |
| Malicious node poisons results | Fabricated or omitted page content distorts the index | Untrusted-data handling; content hashes; sampled redundant crawls and disagreement tracking in PrivaSearch; no execution attestation exists |
| Decompression bomb, huge or slow responses, oversized headers | Memory, CPU and slot exhaustion on the node | Streaming caps on compressed and decoded bytes, ratio cap, header cap, connect/header/idle/total timeouts, bounded hardened parser |
| robots.txt evasion | Crawling what sites forbid | Enforced in the handler with no job-level bypass; unreachable robots.txt means no fetch |
| Crawled-URL privacy | The Coordinator and its operator see every URL and digest; demand-queue URLs may reflect user interest | No user identifiers or queries in job input, decoupled and batched submission, short retention, no URL logging |
| Hostile page content | Text and links are attacker-controlled | Digests are untrusted data, escaped and length-bounded; no JavaScript, no external fetches by the node |
| Header injection through validators | Caller-supplied conditional headers | Strict regexes on `ETag` and `Last-Modified`; no other header is caller-controlled |

## Data-plane threats (planned)

Status: **planned; nothing implemented.** These apply to the future direct-transfer data plane ([DATA_PLANE.md](DATA_PLANE.md), ADR 006, Phase 4 and 5). Today no direct transfer exists and every payload transits the Coordinator within its 32 KiB and 512 KiB limits. The governing rule: a transfer is authorized by a narrow Coordinator-issued authorization and node identity, never by network location; LAN is not trusted.

| Threat | Why it matters | Planned direction |
| --- | --- | --- |
| Stolen transfer authorization | A leaked ticket lets someone else store or fetch | Short expiry, one operation, one resource, one node, byte bound, hash binding; the ticket is never a general node credential and is never logged |
| Replayed authorization | A captured ticket reused to store or fetch again or something else | Non-reusable or explicitly idempotent tickets, node-side replay state, Coordinator-recorded transfer state |
| Expired authorization | A late holder still transferring | Node-side expiry check with a bounded skew allowance; expiry mid-transfer has a defined outcome |
| Wrong-node use | A ticket presented to a node it was not issued for | Ticket bound to the target node identity; a node refuses tickets naming another node |
| Wrong-object use or object substitution | Different bytes stored under an authorized name | Ticket bound to resource ID and content hash; hash verified while streaming, mismatch discards |
| Byte-limit bypass | A "small" ticket used to fill a disk or the bandwidth allowance | Hard byte bound enforced by the node, owner disk and network limits still apply, transfer stops at the bound |
| Corrupted or incomplete transfer | Silent data loss, false completion | Integrity verification, explicit completion state, partial data never committed |
| Malicious sender or receiver | Garbage sent, or data accepted and discarded | Hash verification by the receiver, receipts from both ends where needed, later possession and integrity challenges |
| Application or node lying about completion | False evidence to gain quota, credit or a commit | Completion is a Coordinator state transition backed by evidence from the right party; nothing is billable or rewardable on an issued ticket alone |
| Endpoint spoofing, DNS or endpoint substitution | An application sends data to an attacker's endpoint | Endpoints come only from the Coordinator and are bound to node identity (open design questions 4 and 5); applications never supply endpoints |
| Authorization leakage through logs, referrers or URLs | Ticket exposure | Log the reference ID, not the ticket; keep tickets out of URLs where possible; short life limits damage |
| Concurrent duplicate upload | Two writers for one resource | Idempotency keys, single-writer transfer state, deterministic conflict outcome |
| Race between revocation or expiry and an in-progress transfer | Transfer completes after permission was withdrawn | Defined semantics for fail-fast versus bounded grace (open question 12), transactional transfer state |
| Accounting double counting | Retries or resumption counted twice | Idempotent evidence keyed by reference ID and bytes verified; only verified useful bytes count (open question 13) |
| Transfer resumption abuse | Resuming to bypass bounds or replay | Resumption bound by the same authorization, offsets validated against verified state (open question 3) |
| Node transfer service becoming a general server | A file server, proxy or socket forwarder on volunteers' machines | Dedicated restricted service, closed operation set, fixed storage area, no caller-influenced paths, off unless the owner enables the capability |
| Coordinator as accidental bulk relay | Bandwidth cost and a central bottleneck | Keep the 32 KiB and 512 KiB limits; any relay is a separate bounded data-plane service |
| Data privacy | Plaintext or keys reaching PrivaNet or its logs | Applications encrypt before transfer (PrivaDrive owns keys); never log contents, keys or raw private data |

## Remote onboarding threats (Phase 3.5, implemented)

Invites, approval requests, the installers and a public hostname add a Internet-facing surface. The review, with the test behind each finding, is [EXPOSURE_REVIEW.md](EXPOSURE_REVIEW.md); it is the project's own review and not an independent audit.

- **Invite codes** are 40 bits and therefore guessable by an unbounded attacker. They are introductions, not credentials: the Coordinator stores only a keyed HMAC (the key derives from the administrator secret and is not in the database), a wrong second half counts against that invite, which locks after five, an address gets five refused attempts a minute, and one hundred refusals in ten minutes pause invite redemption for everyone. Redeeming one runs the ordinary Ed25519 enrollment, so the node's key, not the code, is its credential. Cost: a determined distributed guesser can pause invite redemption (token enrollment and running nodes are unaffected).
- **Approval requests** are bound to the requesting machine's key; the request code is only an identifier and grants nothing. The owner's approval is a trust decision on a name and an address the requester supplied; approve only what you expect. Requests are bounded (50 pending, 5 per address) and expire.
- **Public hostname:** the shipped proxy rules are an allowlist, so the administrator and application APIs do not reach the Coordinator from the Internet; the Coordinator stays on loopback. Caddy provides no rate limiting; the Coordinator's limits need `PRIVANET_TRUST_LOOPBACK_PROXY=true` to see real client addresses.
- **Installers** are part of the trust chain: HTTPS only, pinned to a release, the archive's SHA-256 verified before it is unpacked, an optional out-of-band pin and GitHub attestation, no secret on a command line, in a file or in output. There is no code-signing key, so no GPG or Authenticode signature exists; the checksum list shares a location with the files it describes, which is why the pin and attestation matter.
- **No new trust in nodes.** A joined node is trusted by its owner, not verified (Phase 10), and can still only run the typed handlers it was enrolled for.

## Local chunk store (Phase 4.0-alpha.1, implemented; local only)

The first Phase 4 code is a store of opaque, immutable, SHA-256-addressed chunks inside the node process ([PHASE4_DESIGN section 15](PHASE4_DESIGN.md#15-40-alpha1-as-built-and-what-changed-from-this-design)). It has **no network surface, no Coordinator interface and no way for an application to reach it**, and it is off by default, so the threats that matter in alpha.1 are local: bad input reaching the filesystem, a damaged or tampered store, and the store exceeding what the owner allowed. The invariants and the test behind each:

| Invariant | Test |
| --- | --- |
| A path is built only from a validated `chk_` + 64 lowercase hex identifier; traversal, separators, encodings, lookalikes, case and length tricks are refused before any filesystem call | `store-chunk-id.test.ts` (fixed cases and a seeded fuzz) |
| Nothing is followed through a symbolic link; a store containing one (as a chunk, a shard directory, in `incoming/`, as `chunks/` or as the root) is refused, and nothing outside the store is read, written or deleted | `store-chunk-store.test.ts` (malicious filesystem state, with a before/after snapshot of everything outside) |
| The store, its directories and every file are owner-only; widened permissions make a chunk "not a chunk" and a directory refuse to open | permission tests (POSIX; on Windows the state directory's ACL protects the store, not verified on a real machine) |
| Bytes become visible only after they are complete, counted, SHA-256 verified and fsynced, by one atomic rename; a failed or cancelled put never leaves a committed chunk | failure injected at every step; real SIGKILL crashes at every step then a restart (`store-crash.test.ts`) |
| Usage never exceeds the owner's quota or the free-space reserve, including against a stale reading | quota and free-space tests (reading changes mid-write and at commit) |
| A damaged chunk is never served; it is removed and reported once | corrupt-at-rest tests (wrong digest, truncated, extended) |
| Errors are a fixed vocabulary; no path or system message reaches a caller | injected `ENOSPC`/`EIO`/`EACCES`/`ELOOP` tests |
| The store is not a network service | a real-node test that the process owns no listening socket with storage on; the policy has no network setting |

Not covered in alpha.1 (later milestones): transfer authorization, replay and theft of grants, endpoint substitution, remote disk-exhaustion by many clients, and possession challenges. A store on a filesystem that lies about fsync can lose the most recent write in a power cut (never half of it). No independent review has been done.

## Local control panel threats (post-3.5, implemented)

The node's panel ([NODE_CONTROL_PANEL.md](NODE_CONTROL_PANEL.md)) is a local web interface, so it is defended like one: loopback bind only; Host allowlist against DNS rebinding; a 256-bit secret exchanged for an HttpOnly SameSite=Strict cookie required on every API route, reads included; CSRF header, Origin allowlist and JSON content type on writes; nonce CSP and no CORS; bounded strict bodies; a fixed action allowlist with no URL fetch, file access, command, eval, key or environment endpoint. The panel secret is readable by whoever can read the node's state directory (the node's own account and administrators). Support bundles redact every string and fail closed, but are still to be reviewed before sharing. The operator dashboard ([OPERATOR_DASHBOARD.md](OPERATOR_DASHBOARD.md)) is a separate loopback process holding the administrator secret, guarded the same way, that only calls the existing administrator API. Policy changes can only be made by the machine's owner; `fetch.unsafeLocal` is rejected on every path.

## Limits and threats left open

A stolen grant can enroll the thief before the owner; restrict grant capability,
shorten expiry and transmit via a safe channel. Grants are stored only as hashes, are single use (enforced in the transaction that registers the node), are revocable while unused and are listed by ID, never by value; guessing is bounded by a per-address limit on refused enrollment attempts ([ONBOARDING.md](ONBOARDING.md)). A stolen node private key permits
authentication until revoked. A stolen session permits its node role until
expiry/revocation. A stolen app/admin secret permits its scope until revoked or
admin bootstrap rotated/restarted. This is not mTLS or per-message signatures.
Credential rotation uses session refresh, in-place app credential rotation, app revoke/reissue and node revoke/
new enrollment. There is no administrator account/SSO system or key recovery.

A node can lie about its budget or state (for example claim spare RAM it lacks, or claim `DRAINING`/goodbye to shed work); v0.2 does not verify or penalise this, and there is no reputation. The budget is a scheduling hint that protects honest owners, not a guarantee against a malicious node. Owner limits are enforced on the node, and a compromised node is not bound by them. Nothing forces a running handler to stop except its own cooperation with the abort signal; preemption and checkpoint/resume are exercised only with the cooperative `system.hashchain.v1` diagnostic job (tested in-process on Linux, macOS and Windows CI, not against real application workloads, not under memory-hungry or uncooperative handlers, and not on real hardware under owner load). A dishonest node can fabricate schema-valid results for any job type (a hash-chain digest is verifiable by recomputation, but the Coordinator does not recompute it); there is no execution attestation
or reputation. A holder of a live lease can also keep it alive by renewing until `PRIVANET_MAX_LEASE_MS` (default one hour) even if it is not doing the work, so a malicious node can stall a job for that long per attempt. At-least-once execution can repeat future side effects. SQLite
is a single-process prototype, not HA. Job queues are bounded per application and finished jobs are deleted after a configurable retention period (v0.2.1), but there is no per-application storage byte quota, audit log or per-tenant rate limit. Production still needs audit policies, a rehearsed restore on the operator's own infrastructure and an independent security review.
Passing the automated tests is evidence that specific behaviours work on the CI platforms; it is not a security review and does not make the system production-ready. No independent security review has been done. Checkpoints hold job-derived state on the node's disk in plaintext. The macOS and Windows battery probes and the Windows console-signal handlers have not been exercised on real hardware.
No public/community enrollment, Sybil resistance, economic rewards, storage
integrity/durability, malicious-worker isolation, filesystem sandbox, arbitrary
compute or distributed trust guarantees are claimed. Future handlers require
individual threat review/resource bounds. Do not deploy community infrastructure
on the strength of this demo.
