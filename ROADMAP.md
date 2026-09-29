# PrivaNet Roadmap

PrivaNet is the shared infrastructure layer for a family of self-hosted applications including PrivaSearch, PrivaDrive, Privaproxy, and future PrivaNet services.

The core design principle is simple:

> Applications should use the same PrivaNet interfaces whether resources are local or distributed across community machines.

A local machine is just another PrivaNode. Early versions may run every component on one computer, but the architecture should remain compatible with remote community nodes later.

## Status terminology

- **Current** — actively being implemented now.
- **Planned** — accepted direction, not yet implemented.
- **Research** — promising idea that still needs design/measurement before implementation.

## Phase 1 — Core Foundation — Current

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

Status (audited; CI matrix of Linux/macOS/Windows on Node 24 and 26 passing as of PR #1): the deliverables above are **implemented** in code and covered by automated tests, with `system.echo.v1` as the only job type. Job types are defined by a single versioned registry that drives wire schemas, capabilities and node handlers. Phase 1 stays **Current** until the items in `docs/implementation-report.md` under "Remaining v0.1 work" are done: TLS/reverse-proxy deployment review, backup/recovery exercise, and independent security review. Not yet implemented within Phase 1's scope: node-key rotation (application credentials rotate in place), and a PostgreSQL store adapter (SQLite only).

## Phase 2 — Adaptive Resource Engine — Current (core implemented in v0.2.0; remainder planned)

Goal: allow PrivaNode to use genuinely spare machine resources while keeping the computer owner in control.

Principle:

> User workloads always take priority over PrivaNet workloads.

Status: the memory/CPU core is **implemented** (operator policy, adaptive smoothed budgets with hysteresis, schedules, battery policy on Linux, heartbeat resource telemetry, job resource declarations, resource-aware scheduling, preemption and release of preemptible jobs, graceful draining with `DRAINING` and `OFFLINE_EXPECTED`). Still **planned** within this phase: disk-I/O and bandwidth/transfer limits, network-pressure awareness, checkpointing, schedule-aware placement of long jobs, battery detection beyond Linux, and tuning against real workloads. Details in `docs/RESOURCES.md`.

Planned features (see status above for what is done):

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

## Phase 3 — PrivaSearch — Planned

Goal: build the first major application on top of PrivaNet's real job architecture.

PrivaSearch should work with a single local node and improve as more nodes join.

Initial components:

- search UI/API
- metasearch fallback
- URL frontier
- polite crawler
- robots.txt handling
- per-host rate limiting
- HTML parsing and content extraction
- URL normalization
- duplicate and near-duplicate detection
- independent text index
- ranking
- recrawl scheduling
- index health/status metrics

PrivaSearch crawler/parser work should use typed PrivaNet jobs such as future `privasearch.crawl.v1` and `privasearch.parse.v1` capabilities.

Initial scaling targets should be measured milestones rather than attempts to crawl the entire web immediately:

1. 1,000 pages
2. 10,000 pages
3. 100,000 pages
4. 1 million pages
5. 10 million pages if earlier measurements justify it

Metasearch should fill gaps while PrivaSearch's own index grows. Searches may also help prioritize what the crawler indexes next.

## Phase 4 — Generic Storage Foundation — Planned

Goal: provide application-independent object/chunk storage through PrivaNet.

Planned primitives:

- put object
- get object
- delete object
- chunk integrity verification
- storage-node capabilities
- local-node storage using the same API as remote storage

PrivaNet owns physical resource infrastructure; applications own their own user-visible semantics.

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

Accounting rules:

- append-only auditable ledger; integer units; idempotent events; reason/reference IDs
- prefer a balanced (double-entry) design so credit conservation is checkable
- version every economic policy and preserve the version that produced historical entries
- **advertising capacity never creates credits**; credits mostly circulate from consumers to providers, with explicit, auditable, versioned issuance (bounded free-allowance/subsidy pool, administrative adjustment) and explicit sinks
- track macroeconomic metrics (issued, consumed, circulating, per-account, prices, supply and demand per class)

Potential ledger events include settlement (paired charge and reward), STORAGE/BANDWIDTH/COMPUTE reward and charge variants, FREE_ALLOWANCE, ADMIN_ADJUSTMENT and REVERSAL.

### Reliability

```text
reward = verified useful contribution x settlement price x bounded reliability adjustment
```

Reliability adjusts rewards for useful work from measurable behavior (successful and failed jobs, storage challenges, failed retrievals, corruption, unexpected disappearance, graceful draining). It is not a large passive source of credits, and graceful `DRAINING` to `OFFLINE_EXPECTED` shutdown must not be punished like an unexplained disappearance.

### Fixed demand multipliers, refined

Earlier plans used bounded fixed demand multipliers. **Scarcity should instead show up primarily in the market clearing price**: rising when supply is short, falling when supply is abundant. Bounded policy adjustments and emergency controls remain as secondary, versioned tools. Owners choose when to contribute using pricing conditions rather than PrivaNet inventing time-of-day bonuses.

A private single-operator deployment runs with the market off (fixed or zero reference price) and stays fully useful.

## Phase 9 — Community Network Hardening — Planned

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
- bandwidth farming
- storage corruption
- denial of service
- NAT/connectivity strategy
- operational monitoring
- coordinator recovery
- upgrade compatibility

Community deployment should happen only after the local/small-network architecture is stable.

## Phase 10 — Stable PrivaNet Protocol — Planned

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
