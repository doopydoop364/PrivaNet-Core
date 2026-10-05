# PrivaNet Roadmap

PrivaNet is the shared infrastructure layer for a family of self-hosted applications including PrivaSearch, PrivaDrive, Privaproxy, and future PrivaNet services.

The core design principle is simple:

> Applications should use the same PrivaNet interfaces whether resources are local or distributed across community machines.

A local machine is just another PrivaNode. Early versions may run every component on one computer, but the architecture should remain compatible with remote community nodes later.

## Architecture in one picture: control plane and data plane

PrivaNet has three layers ([docs/DATA_PLANE.md](docs/DATA_PLANE.md), ADR 006):

1. **Applications** (PrivaSearch, PrivaDrive, Privaproxy where relevant, future applications).
2. **Control plane**: the Coordinator. Authentication, node identity, capability registry, scheduler, job state, leases, placement decisions, transfer authorizations, and later accounting, the resource market and the Network Treasury.
3. **Resource/data plane**: PrivaNodes. Actual compute, storage and bandwidth, plus application-to-node and node-to-node transfers.

> The Coordinator is the control plane, not the bulk-data pipe. All work begins at the Coordinator; large payloads eventually move directly between authorized participants through narrowly scoped, Coordinator-authorized transfers. Small typed jobs keep returning bounded inline results through the Coordinator. The application-to-node direct storage data plane is implemented since alpha.3; alpha.4 adds operator hardening and diagnostics. Node replication/repair remains Phase 5.

## Status terminology

- **Current** — actively being implemented now.
- **Planned** — accepted direction, not yet implemented.
- **Research** — promising idea that still needs design/measurement before implementation.

## Phase 1 — Core Foundation — Complete (independent security review pending, tracked in Phase 11)

Goal: establish a small, secure, testable PrivaNet control plane.

Deliverables:

- PrivaNet Coordinator
- PrivaNode daemon
- shared protocol definitions
- PrivaNet SDK
- explicit protocol versioning
- node identity and enrollment
- node authentication
- application authentication foundation
- capability advertisement
- heartbeats and node status
- restricted typed jobs
- basic scheduler
- job leases, retries, and failure handling
- persistent coordinator state
- unit and integration tests
- architecture/security documentation

Initial success criterion:

A local application can submit a strictly typed job using the PrivaNet SDK, the Coordinator can securely schedule it to an authenticated local PrivaNode advertising the required capability, the node executes only its registered handler, and the result returns through the same application-facing interface that remote nodes will use later.

PrivaNet must not provide arbitrary remote shell, arbitrary script execution, unrestricted anonymous proxying, or generic download-and-execute functionality.

Status: **complete.** The deliverables above are implemented in code and covered by automated tests (CI matrix of Linux/macOS/Windows on Node 24 and 26), with a single versioned job registry driving wire schemas, capabilities and node handlers. The operational items originally left open were addressed in v0.2.1: the reverse-proxy/TLS deployment review and runbook ([docs/deployment.md](docs/deployment.md)), `npm run backup` with a restore test, and job retention plus a per-application queue quota. Explicitly **not** part of this phase and tracked later: in-place node-key rotation (revoke and re-enroll works; credential rotation is Phase 10), a PostgreSQL store adapter (a prerequisite for the Phase 8 ledger and for coordinator recovery work in Phase 10), and an **independent** security review, which needs people outside this project (Phase 11). A restore rehearsal on the operator's own infrastructure remains the operator's job.

## Phase 2 — Adaptive Resource Engine — Complete (v0.2.1)

Goal: allow PrivaNode to use genuinely spare machine resources while keeping the computer owner in control.

Principle:

> User workloads always take priority over PrivaNet workloads.

Status: **complete as of v0.2.1.** v0.2.0 delivered the memory/CPU core (operator policy, adaptive smoothed budgets with hysteresis, schedules, battery policy, heartbeat resource telemetry, job resource declarations, resource-aware scheduling, preemption and release, graceful draining with `DRAINING` and `OFFLINE_EXPECTED`). v0.2.1 added disk-space and disk-I/O limits, bandwidth and monthly-transfer limits with network-pressure awareness, node-local checkpoint/resume, schedule-aware placement of long jobs, battery detection on macOS and Windows, a portable graceful-drain request for Windows, and a real long-running checkpointable workload (`system.hashchain.v1`). Known limits (node-local checkpoints only, disk/network load sampled on Linux only, measured per-job use deferred to Phase 7, thermal signals not collected, calibration from a single development machine) are listed in `docs/RESOURCES.md`; none is a phase requirement. Later tuning against real PrivaSearch and storage workloads belongs to those phases.

Features (all implemented as of v0.2.1):

- adaptive CPU contribution
- adaptive RAM contribution
- memory-pressure awareness
- disk-I/O awareness where useful
- bandwidth limits and network-pressure awareness
- hard user-defined resource ceilings
- user-defined resource reserves
- capability-specific limits
- scheduled contribution profiles
- optional disable/reduce contribution on battery
- graceful job preemption
- checkpointable jobs where practical
- graceful draining before shutdown
- resource telemetry in heartbeats
- resource-aware scheduling

Example behavior:

A machine with 12 GiB of readily available RAM may accept substantially more memory-intensive PrivaNet work than the same machine while a game leaves only 3 GiB available.

PrivaNet should maintain a safety margin rather than consuming every technically free byte. Adaptive limits should be smoothed so temporary resource spikes do not cause unnecessary job churn.

Adaptive budgets are also the future *supply* side of the Phase 8 resource market: the market may only price and match capacity inside what the owner's limits allow, and capacity is never a promise that overrides them (see docs/RESOURCE_MARKET.md).

Future typed jobs should declare resource estimates such as CPU intensity, expected RAM, disk usage, network usage, whether the job can be preempted, and expected duration where known.

## Phase 3 — PrivaSearch on PrivaNet — Planned

Goal: prove PrivaNet's real job architecture with its first external application, **PrivaSearch, which is a separate repository and application** ([docs/APPLICATION_BOUNDARY.md](docs/APPLICATION_BOUNDARY.md)). PrivaSearch depends on `@privanet/sdk` and the wire protocol only; PrivaNet-Core never depends on PrivaSearch code, and the search application is never built inside this repository.

**Owned by PrivaSearch (its own repository, roadmap and releases):** search UI and API, queries, URL frontier, crawl prioritisation, robots and crawl policy, recrawl policy, HTML parsing and document-extraction policy, URL normalisation, duplicate and near-duplicate detection, independent text index, ranking, metasearch fallback, public-versus-demand crawl policy, index health metrics.

**Owned by PrivaNet-Core in this phase (generic platform work only):**

- a generic, security-reviewed **constrained web-fetch capability** (`web.fetch.v1`, a function-named capability, not `privasearch.*`), with its SSRF guard, robots enforcement, redirect, size, time and decompression bounds, owner policy and test corpus, specified in [docs/PRIVASEARCH_INTEGRATION.md](docs/PRIVASEARCH_INTEGRATION.md);
- generic extension points an application needs: application client identity in the lease, job cancellation, per-application or per-type retention, scheduler concurrency keys, per-application request budgets, batch status polling (see the boundary document, section 5);
- the integration contract and the rules for adding capabilities to Core's first-party registry (the generic-capability test).

PrivaSearch should work with a single local node and improve as more nodes join. Every crawl uses the real path: PrivaSearch, SDK, Coordinator, authenticated PrivaNode, fetch capability, validated result.

Initial PrivaSearch scaling targets are measured milestones rather than attempts to crawl the entire web immediately:

1. 1,000 pages
2. 10,000 pages
3. 100,000 pages
4. 1 million pages
5. 10 million pages if earlier measurements justify it

**Status:** the integration contract and the boundary decision (ADR 005, accepted) are written; the Core capability `web.fetch.v1` is **implemented in v0.3.0-alpha.1** (PrivaSearch's real-path proof is in its own repository) and no PrivaSearch code exists in this repository. The two crawl queues, a demand-driven queue paid by the requester and a public queue paid by the Network Treasury in Phase 9 ([docs/TREASURY.md](docs/TREASURY.md)), are PrivaSearch policy, modelled as two application credentials from the start; until the economy exists both run on operator-provided capacity and must obey robots.txt, per-host limits, politeness and resource limits. Phase 3 is complete when PrivaSearch crawls and searches through the real PrivaNet path at a measured milestone; storage (Phase 4) is not part of it.

**Data-plane stance in Phase 3:** keep the normal typed-job control path. Bounded `web.fetch.v1` results (digests of at most 28,000 bytes) stay inline through the Coordinator. Use real crawl measurements to decide whether larger-result transfer support is ever necessary; if it is, a future `web.fetch` version could return metadata, a content hash and a bounded result reference. Do not build a generic data plane speculatively ([docs/DATA_PLANE.md](docs/DATA_PLANE.md)).

**Measured so far (v0.3.0-alpha.1, PrivaSearch milestone 2):** one real public URL fetched through the guarded PrivaNode and found by search (CI), and 10, 100 and 1,000 pages crawled through the full real path on a synthetic local site (about 950 pages per minute on one single-slot node, zero invalid results). The measurements point at SDK polling cost on the Coordinator, not payload size, as the first bottleneck. See PrivaSearch `docs/measurements.md`.

**Multi-node validation (v0.3.0-alpha.4):** trusted, admin-enrolled nodes were validated as real processes (spread, crash failover, Coordinator restart, drain, restart, paused-then-resumed zombie, mixed owner limits, revocation, churn) with no correctness or security defect found, and measurement found and fixed a Coordinator scaling defect with many job slots. Details, numbers and limits: [docs/MULTI_NODE_VALIDATION.md](docs/MULTI_NODE_VALIDATION.md). Untrusted nodes stay in Phase 10.

**Deployment readiness (v0.3.0-alpha.5):** a server Coordinator behind TLS with a separate desktop worker was validated with real separate network stacks and firewalls (no inbound port on the worker, admin API unreachable from the LAN, outage recovery, mixed versions, a two-node workload), with the procedure in [docs/FIRST_DEPLOYMENT.md](docs/FIRST_DEPLOYMENT.md) and the verdict, unverified items and manual check in [docs/DEPLOYMENT_VALIDATION.md](docs/DEPLOYMENT_VALIDATION.md). It proves trusted, owner-run nodes only.

## Phase 3.5 — Remote Node Onboarding / Contributor Experience — Implemented

Goal: make it simple for a **trusted, invited** contributor outside the local network to join as a PrivaNode, without changing who decides who joins. This sits after the basic deployment and multi-node readiness work in Phase 3 (which proved the trusted, owner-run setup) and before community-scale participation. It is numbered 3.5 so the existing phase numbers and order stay as they are; it needs nothing from Phases 4 to 9 and can be scheduled alongside any of them.

**Why:** today's manual setup works but is too cumbersome for someone who is not the operator ([docs/FIRST_DEPLOYMENT.md](docs/FIRST_DEPLOYMENT.md), Part 2). A contributor must download the release, install files, copy a private CA root certificate when the Coordinator uses local TLS, edit `node.env`, receive a long enrollment token, install and start the service, and then remember to remove the token. The aim is close to "run the installer, enter a short code, done."

**Not in this phase:** anonymous or public open enrollment, Sybil resistance, node reputation, credits, economics, and verification of hostile or malicious nodes. Enrollment stays **explicitly controlled by the network owner** (invite or approval), exactly as today. Those protections remain in [Phase 10](#phase-10--community-network-hardening--planned), and invite-only onboarding does not make an invited node trusted beyond what the owner already decides to trust.

Goals:

1. **A public hostname and a normal, publicly trusted TLS certificate** for the Coordinator entrypoint, so a node outside the LAN does not install a private root CA. The reverse-proxy model stays (the Coordinator itself stays on loopback behind it), and a stable name removes today's "nodes pin an address" caveat. The LAN setup with a private CA remains valid.
2. **A one-command Linux installer**, conceptually `curl -fsSL https://<official-host>/install-node.sh | sh`, and an **equivalent Windows installer or PowerShell bootstrap**.
3. **Installer responsibilities:** detect the supported OS and architecture; download the matching PrivaNet release; verify hashes and signatures as the project supports them; install files in the right places; create the dedicated node service account where appropriate; install the default desktop or resource policy; configure the Coordinator URL; enroll the node; **remove the one-time enrollment credential after successful enrollment**; install, enable and start the service; report clear success or failure.
4. **Friendly short-lived invite codes** instead of handing end users the raw long enrollment token, for example `privanet-admin invite` printing a short code such as `N7K4-PQ2M` with its expiry and capabilities. A short code carries far less entropy than today's token, so it can only be an introduction, not a bearer credential: it must be single-use, expire quickly, be bound to the capabilities the owner chose, and be redeemable only over verified TLS with rate-limited, attempt-bounded redemption.
5. **An optional approval (device-code) flow:** the joining machine requests enrollment and shows a request code, and the owner approves it separately (for example `privanet-admin approve <code>`), so no enrollment secret is ever sent to the contributor.
6. **A clear reinstall, recovery and revocation flow** for contributors and owners (replace a machine, lose a machine, withdraw a node) building on today's `revoke-node` and re-enrollment.
7. **Good diagnostics for common remote-node failures:** DNS, TLS, port and firewall reachability, expired or already-used invite, rejected or revoked node, and an incompatible protocol or version, each with a plain-language message and a next step. The node already logs a fixed vocabulary of connection failure reasons; this makes them actionable for a non-operator.
8. **Keep enrollment owner-controlled.** Every path above ends with the owner's explicit decision.

Dependencies and guardrails (a milestone is not done without them):

- **Internet exposure is a new threat surface.** Before the first outside contributor, review what a public hostname exposes: the admin API must stay unreachable from the Internet (today it is loopback and proxy-restricted; see the exposure review in [docs/DEPLOYMENT_VALIDATION.md](docs/DEPLOYMENT_VALIDATION.md)), authentication and enrollment rate limits must hold against an Internet-scale guesser, and the reverse-proxy configuration must be the documented, tested one.
- **The installer is part of the trust chain.** Serve it over HTTPS from the official release, pin it to a release version and checksum, and never place a credential on a command line or in a log.
- **No new trust in the node.** Scheduling, resource limits and the SSRF guard behave exactly as for any node; a joined contributor's node is still a trusted-by-the-owner machine, not a verified one.

**Status: implemented (`0.3.5`, carried forward by `0.3.6`), with real-machine verification still owed (see [docs/MANUAL_VALIDATION.md](docs/MANUAL_VALIDATION.md); every item there stays NOT DONE until a person performs it).** Every goal above has working, tested code and documentation:

1. **Public hostname and publicly trusted TLS** (goal 1): `deploy/caddy/Caddyfile.public` and `public-routes.caddy` (an allowlist of exactly the routes a node needs; `/v1/admin/*` and the application API never reach the Coordinator; size and timeout limits; HSTS), run against a real Caddy in CI (`npm run test:proxy`), and `tools/check-exposure.mjs`, a verified-TLS checker to run from another machine. The private-CA LAN setup is unchanged. Buying a domain, DNS, port forwarding and NAT are operator actions, not software ([docs/PUBLIC_NODE.md](docs/PUBLIC_NODE.md)); a certificate from a real certificate authority has not been obtained in a test.
2. **Installers** (goals 2 and 3): `install-node.sh` for Linux and `install-node.ps1` for Windows, published next to each release and pinned to it, with checksum verification before anything is unpacked, an optional hash pin and GitHub attestation, a dedicated service account, a default policy, secrets only on standard input, a service, and a sign-in check ([docs/INSTALLER.md](docs/INSTALLER.md)). `curl | sh` is deliberately not offered. There is no code-signing key, so there are no GPG or Authenticode signatures; that is stated in the docs rather than hidden.
3. **Invite codes** (goal 4): `privanet-admin invite create|list|revoke`, `XXXX-XXXX`, single use, at most one hour, a capability ceiling, keyed-hash storage, per-address, per-invite and global limits, one generic failure, redeemed through the same Ed25519 enrollment ([docs/ONBOARDING.md](docs/ONBOARDING.md)).
4. **Approval flow** (goal 5): `privanet-node join` and `privanet-admin requests|approve|deny`, key-bound, owner-approved, expiring, bounded.
5. **Recovery, reinstall and revocation** (goal 6): [docs/RECOVERY.md](docs/RECOVERY.md), with `--upgrade`, `--new-identity --yes` and `--uninstall [--purge]` in both installers.
6. **Diagnostics** (goal 7): `privanet-node doctor` (staged, actionable, `--json`, no secrets, no enrollment-changing requests).
7. **Owner-controlled** (goal 8): every path ends with the owner's explicit decision; nothing here is public enrollment.
8. **Exposure review** (guardrail): [docs/EXPOSURE_REVIEW.md](docs/EXPOSURE_REVIEW.md), the project's own review with a test per finding. It is not an independent audit.

**Honest limits:** (a) the **Windows installer's service registration, access-control and reboot behaviour have not been run on a real Windows machine** by the project (its static checks and staged-install tests run on `windows-latest` in CI; the first run found and led to fixes for two PowerShell parse errors, and a green run after those fixes had not been seen when this was written); the manual check in [docs/INSTALLER.md](docs/INSTALLER.md#what-is-verified-and-what-is-not) is the verification that remains; (b) the Linux unit was verified as generated text and with a real service account, but not started under a real systemd in an automated test; (c) the release attestation step has not run yet (no release has been cut with it). None of these needs new design; they need a first run on real systems, and none changes who may join or what a node may do. Phase 10 (hostile nodes, public enrollment, reputation) is unchanged and is not started.


### Post-3.5 contributor experience: node control panel (implemented, unreleased)

Not a new phase and no renumbering. Local, owner-only tooling so a contributor can configure and understand a node without editing files: a loopback control panel, presets, pause, "why am I idle?", a safe job view, a support bundle, `config check`, policy export/import and installer first-run integration. It changes nothing in the Coordinator, the protocol or the trust model. See [docs/NODE_CONTROL_PANEL.md](docs/NODE_CONTROL_PANEL.md). The operator side is `privanet-admin ui` ([docs/OPERATOR_DASHBOARD.md](docs/OPERATOR_DASHBOARD.md)). Not done: system tray, in-place update and rollback.

## Phase 4 — Generic Storage + Data Plane Foundation — In progress

Goal: provide application-independent object/chunk storage through PrivaNet **and the first generic direct-transfer data plane**, so large payloads never transit the Coordinator ([docs/DATA_PLANE.md](docs/DATA_PLANE.md), ADR 006).

Planned primitives:

- put object, get object, delete object (bounded object and chunk PUT and GET)
- chunk integrity verification and object/chunk identity
- storage-node capabilities
- local-node storage using the same API and the same transfer mechanism as remote storage (no localhost bypass)

Planned data-plane foundation:

- Coordinator-issued, short-lived **transfer authorizations**, scoped to one operation, one resource, one node (or node pair), a byte bound and an expiry, non-reusable or explicitly idempotent, revocable where practical, auditable by reference ID and replay-safe
- a dedicated, restricted node-side transfer service (not a file server, proxy or generic endpoint) that verifies authorization, target node, operation, resource, size, expiry, replay state, integrity and owner policy; owner limits stay authoritative
- application-to-node direct transfer after Coordinator placement (the application never picks nodes)
- transfer completion and failure reporting, expiry and revocation, integrity and hash verification, safe retry and resume if justified
- an explicit transfer state machine, aggregate transfer metrics, and threat-tested behaviour for the [data-plane threats](docs/security.md#data-plane-threats)

Not part of Phase 4: NAT traversal, public node exposure and relay services (a separate networking problem, [DATA_PLANE.md](docs/DATA_PLANE.md#13-connectivity)); node-to-node transfer (Phase 5).

PrivaNet owns physical resource infrastructure; applications own their own user-visible semantics. **4.0-alpha.1, alpha.2 and alpha.3 are implemented.** Alpha.3 adds the opt-in TLS listener, direct application ↔ node PUT/GET/DELETE, pinned endpoint identity, persistent replay, live key refresh, owner limits, durable receipts/reconciliation and SDK helpers. The Coordinator never carries chunk bodies. The built behavior and deliberate changes are recorded in [PHASE4_DESIGN section 17](docs/PHASE4_DESIGN.md#17-40-alpha3-as-built-and-what-changed-from-this-design) and [DIRECT_TRANSFER.md](docs/DIRECT_TRANSFER.md). Replication, repair, possession challenges and economic layers remain later phases. No file/folder semantics, localhost trust bypass or NAT relay is introduced.

## Phase 5 — Distributed Storage — Planned

Goal: make PrivaNet storage resilient across multiple nodes.

Planned features:

- chunk placement
- configurable replication
- integrity checking
- failure detection
- repair queues
- automatic replica repair
- node draining
- graceful retirement
- physical-resource accounting
- failure-domain-aware placement
- **node-to-node authorized transfers**: the Coordinator authorizes a sender and a receiver for a specific chunk, the nodes transfer directly, and both report evidence ([docs/DATA_PLANE.md](docs/DATA_PLANE.md#8-node-to-node-flow-phase-5)); replication, repair, migration and rebalancing never relay bytes through the Coordinator
- storage possession/integrity challenges (also the verification input for Phase 7 storage measurement)

Storage placement is driven by durability and failure-domain constraints; a future market's price must never override them.

Research areas:

- erasure coding
- hot/cold storage policies
- smarter caching
- geographically aware placement

## Phase 6 — PrivaDrive Integration — Planned

Goal: run PrivaDrive on PrivaNet storage without requiring community adoption.

PrivaDrive should own:

- files and folders
- filenames and user-visible metadata
- trash
- sharing
- permissions
- Drive-specific encryption/key semantics
- sync behavior

PrivaNet should own:

- physical storage nodes
- object/chunk placement
- **transfer authorization** and the generic data plane (PrivaDrive uploads and downloads encrypted chunks directly to and from authorized nodes and never sends large payloads through the Coordinator)
- replication
- repair
- node health
- physical resource accounting

A one-node installation remains fully usable. Community nodes add capacity and resilience rather than being a prerequisite.

## Phase 7 — Resource Measurement and Accounting — Planned

Goal: accurately measure and verify useful resources supplied and consumed **before** any market or credits exist. We should not build a market around unverified resource claims.

Measure independently, per resource class and with explicit versioned units:

- storage actually used and storage duration (for example GiB-days)
- bandwidth actually served (valid application traffic only)
- verified compute/jobs completed
- crawler/indexing work
- repair traffic
- node availability, including graceful versus unexpected departures
- job success/failure, attributed to the right party
- integrity/possession challenge results

Deliverables to plan: append-only, idempotent usage records per attempt (job, lease, node, application, class, unit version, quantity, evidence); verification methods per class; a node-to-account link; measurement-only dashboards. Note that the current code does not keep per-attempt history or release reasons, so nothing before this phase is billable.

Phase 7 consumes **verified data-plane evidence**: authorized transfer, actual verified useful bytes, failed or partial bytes, storage duration, repair traffic, application traffic and duplicate or retry traffic are distinct. A node is never credited because a transfer authorization was issued ([docs/DATA_PLANE.md](docs/DATA_PLANE.md#10-accounting-implications-phase-7-and-later)).

Keep logical application usage separate from physical network cost. Do not reward nodes primarily for advertising unused capacity. Details: [docs/RESOURCE_MARKET.md](docs/RESOURCE_MARKET.md#prerequisites-before-any-market-is-activated).

## Phase 8 — Resource Market and PrivaCredits — Planned / Research

Goal: run an internal market for verified useful resources, with PrivaCredits as the internal accounting unit. **PrivaCredits are the accounting unit; resources are what get priced.**

PrivaCredits are not cryptocurrency, blockchain assets, mining rewards, speculative tokens, or an externally tradable currency. There is no buying or selling for money, no cash-out and no exchange rate. The market exists inside PrivaNet; the resources are what is bought and sold.

Market design (research first; see [docs/RESOURCE_MARKET.md](docs/RESOURCE_MARKET.md)):

- separate markets per resource class (storage, bandwidth, compute, crawl, indexing), each with an explicit, versioned, measurable unit
- node asks (minimum price per class) with automatic, competitive, premium and custom pricing modes, and pricing conditions/schedules
- application demand with maximum price and constraints; applications never pick nodes
- **market and scheduler stay separate**: the market decides economically eligible supply and the price; the scheduler chooses operationally (reliability, latency, pressure, limits, failure domains, planned availability, capability, storage placement). The cheapest node must not automatically win, and price never overrides durability
- a clearing-price or auction-like mechanism, to be researched and simulated before implementation; not a fixed choice
- terminology: reference price, ask, clearing (market) price, effective cost/score, settlement price
- adaptive supply: capacity is dynamic and never overrides hard operator limits
- price guardrails: reference prices, minimum/maximum asks, movement limits, circuit breakers, audited emergency controls; all configurable and versioned
- anti-manipulation: fake demand, fake contribution, collusion, bandwidth farming, useless compute jobs, storage churn, wash activity, Sybils, price manipulation, artificial scarcity, falsified telemetry. Only Coordinator-authorised, policy-valid, verified consumption may generate contributor rewards
- observability: aggregate market history without exposing private node or user data
- a settlement hook for the Phase 9 treasury: a bounded, versioned, explicit levy entry per settlement (the ledger design must leave room for it; the treasury itself is not part of this phase)

Accounting rules:

- append-only auditable ledger; integer units; idempotent events; reason/reference IDs
- prefer a balanced (double-entry) design so credit conservation is checkable
- version every economic policy and preserve the version that produced historical entries
- **advertising capacity never creates credits**; credits mostly circulate from consumers to providers, with explicit, auditable, versioned issuance (bounded free-allowance/subsidy pool, administrative adjustment) and explicit sinks
- track macroeconomic metrics (issued, consumed, circulating, per-account, prices, supply and demand per class)

Potential ledger events include settlement (paired charge and reward), STORAGE/BANDWIDTH/COMPUTE reward and charge variants, FREE_ALLOWANCE, ADMIN_ADJUSTMENT and REVERSAL. Treasury events (levy, deposits, public-good spending) come with Phase 9 ([docs/TREASURY.md](docs/TREASURY.md)).

### Reliability

```text
reward = verified useful contribution x settlement price x bounded reliability adjustment
```

Reliability adjusts rewards for useful work from measurable behavior (successful and failed jobs, storage challenges, failed retrievals, corruption, unexpected disappearance, graceful draining). It is not a large passive source of credits, and graceful `DRAINING` to `OFFLINE_EXPECTED` shutdown must not be punished like an unexplained disappearance.

### Fixed demand multipliers, refined

Earlier plans used bounded fixed demand multipliers. **Scarcity should instead show up primarily in the market clearing price**: rising when supply is short, falling when supply is abundant. Bounded policy adjustments and emergency controls remain as secondary, versioned tools. Owners choose when to contribute using pricing conditions rather than PrivaNet inventing time-of-day bonuses.

A private single-operator deployment runs with the market off (fixed or zero reference price) and stays fully useful.

## Phase 9 — Network Treasury and Public Goods — Planned / Research

Goal: give PrivaNet a transparent internal **Network Treasury** (also *PrivaNet Treasury* or *Public Resource Fund*) that pays for useful work with no single purchaser, using bounded redistribution of existing PrivaCredits. It is an internal resource-budgeting mechanism, **not** an investment fund: no external investment, speculation, yield, profit distribution, cash-backed token or external trading. Design source of truth: [docs/TREASURY.md](docs/TREASURY.md). Nothing here is implemented, and it must not be activated before Phases 7 and 8 exist and are trusted.

Planned scope (research first):

- a small configurable, bounded, versioned **market-settlement levy**, visible as explicit ledger events (`MARKET_LEVY`), no permanent rate chosen; the treasury primarily redistributes existing credits rather than minting
- other explicit funding sources: allocated subsidies (measured as issuance), unused public-service budgets, administrative or community grants, disclosed expiring promotional allocations. No confiscation of ordinary inactive balances
- separate **budget buckets** (General Reserve, PrivaSearch Public Goods, Contributor Bootstrap, Network Maintenance, Emergency Reserve) so one subsystem cannot drain another
- **public-good jobs**: ordinary typed jobs paid by the treasury through the same market, scheduler, verification and settlement path; no special execution path, no unlimited buyer, per-job maximum price and per-period budget caps, lower priority for non-urgent work, slowing when capacity is scarce
- **PrivaSearch public crawl queue** funded by the PrivaSearch Public Goods budget alongside the requester-funded demand queue (robots.txt, per-host limits and politeness still apply)
- **Contributor Bootstrap Program**: match or bonus verified useful contribution during a bounded onboarding period, with a research option for a delayed reliability portion; never a gift for installing a node; graceful draining is not punished
- bounded network-maintenance and emergency-reserve spending, explicitly authorised and separately auditable
- ledger events such as `TREASURY_DEPOSIT`, `PUBLIC_GOOD_SPEND`, `PUBLIC_CRAWL_SPEND`, `CONTRIBUTOR_MATCH`, `NETWORK_MAINTENANCE_SPEND`, `EMERGENCY_RESERVE_SPEND`, `TREASURY_ADJUSTMENT`, `TREASURY_REVERSAL` with amount, context, reason, reference ID, policy version, timestamp, authority and audit trail
- requirements: idempotency, transactional budget updates, explicit limits, policy versions, auditable reference IDs; treasury metrics (balance by bucket, levy income, spending by category, cost per useful public crawl/index unit, subsidy issuance)
- policy is versioned configuration controlled by administrators; no governance or token-voting system is designed

The economic stack stays modular: (1) resource measurement, (2) resource market, (3) PrivaCredits ledger, (4) Network Treasury, (5) public-good budgeting.

## Phase 10 — Community Network Hardening — Planned

Goal: safely support untrusted public/community nodes.

Areas to address:

- public enrollment strategy
- stronger abuse controls
- Sybil resistance
- node reputation
- credential rotation and revocation
- malicious or colluding nodes
- manipulated accounting
- resource-market manipulation (fake demand, wash activity, price manipulation, artificial scarcity; see docs/security.md and docs/RESOURCE_MARKET.md)
- treasury abuse (fake public jobs, onboarding farming, node/account churn; see docs/TREASURY.md)
- bandwidth farming
- storage corruption
- denial of service
- NAT/connectivity strategy, including whether a bounded data-plane relay is needed as a fallback (never the Coordinator as the normal relay; [docs/DATA_PLANE.md](docs/DATA_PLANE.md#13-connectivity))
- operational monitoring
- coordinator recovery
- upgrade compatibility

Community deployment should happen only after the local/small-network architecture is stable.

Invite-only onboarding of **trusted** remote contributors is a separate, earlier milestone ([Phase 3.5](#phase-35--remote-node-onboarding--contributor-experience--implemented)) and does not wait for this phase. What waits for this phase is anything that admits nodes the owner does not individually know and trust: anonymous or open enrollment, Sybil resistance, reputation and hostile-node verification.

## Phase 11 — Stable PrivaNet Protocol — Planned

Goal: provide a stable foundation other Priva applications can depend on.

Focus:

- protocol compatibility guarantees
- migrations
- SDK stability
- node upgrade strategy
- coordinator upgrade strategy
- recovery and backup tooling
- observability
- documentation
- security review

## Future applications — Research / Later

Possible applications that can remain useful with a single installation include:

- PrivaArchive — personal searchable web archive
- PrivaSend — temporary encrypted file sharing
- PrivaPages — static site hosting
- PrivaSync — cross-device ecosystem synchronization
- PrivaFeeds — RSS/Atom reader
- PrivaChat — centrally usable chat with optional future distributed resources
- additional PrivaSearch features such as images/news/local-private indexes

These applications should not distract from the Core Foundation, PrivaSearch, and storage milestones until the underlying infrastructure is proven.

## Cross-cutting architectural rules

1. Local resources use the same PrivaNet interfaces as remote resources.
2. The local server must not receive hidden architectural bypasses.
3. PrivaNode operators keep control over hard resource limits.
4. User workloads always outrank PrivaNet workloads.
5. Typed/versioned jobs replace arbitrary remote execution.
6. Economic parameters remain configurable and versioned.
7. PrivaNet should remain useful with one user and one machine.
8. Community participation should improve the system, not be required for basic usefulness.
9. Security-sensitive behavior must be documented and tested.
10. Planned features must never be presented as already implemented.
11. Advertising capacity never creates credits; only verified, Coordinator-authorised, policy-valid consumption is rewarded.
12. The resource market (economic eligibility and price) stays separate from the scheduler (operational choice); price never overrides owner limits, durability or safety.
13. Resource measurement and verification come before any market; no market is built around unverified claims.
14. PrivaCredits stay an internal accounting unit: no external trading, cash-out or speculation.
15. The Network Treasury is an internal budgeting and redistribution mechanism funded primarily by a bounded, visible levy on existing credits. It never invests, speculates, yields returns or is externally tradable, and it never hides minting.
16. Treasury-funded (public-good) work uses the same typed-job, market, scheduler, verification and settlement path as private work, inside explicit budgets and maximum prices; there is no privileged or unsafe path and no unlimited buyer.
17. Do not activate a real resource market or treasury before PrivaNet can accurately measure and verify useful resource consumption.
18. Applications (PrivaSearch, PrivaDrive, Privaproxy) live in their own repositories and depend on PrivaNet through the SDK and protocol only. PrivaNet-Core contains generic, function-named capabilities and never application code, policy or names in code paths.
19. **The Coordinator is the control plane, not the bulk-data pipe.** It authenticates, authorizes, schedules, places and issues narrowly scoped transfer authorizations; large payloads move directly between authorized participants. All work still begins at the Coordinator and applications never select or trust nodes on their own.
20. The data plane is never a bypass: no unrestricted node endpoints, general file serving, arbitrary proxying or socket forwarding, and no trust based on network location (LAN is not trusted). A transfer authorization never overrides owner resource limits.
21. Small typed jobs keep returning bounded inline results; introduce result-by-reference only when measurements require it, and additively.
22. Accounting rests on verified data-plane evidence, never on issued authorizations or requested capacity.
23. The Coordinator's server may also run an optional, conservatively limited PrivaNode, scheduled through the same authenticated path as any node; the Coordinator never depends on it.

## 4.0-alpha.4 operator hardening

Implemented: explicit live/offline listener status, storage diagnostics, effective-setting sources, safe capacity/reserve controls, node-local certificate generation/renewal, operator-side pinned TLS probe and negotiated pool reporting. [Validation status](docs/ALPHA4_IMPLEMENTATION_STATUS.md) records automated evidence and outstanding real-machine checks. Phase 5 remains separate.
