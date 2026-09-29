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

## Phase 2 — Adaptive Resource Engine — Planned

Goal: allow PrivaNode to use genuinely spare machine resources while keeping the computer owner in control.

Principle:

> User workloads always take priority over PrivaNet workloads.

Planned features:

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
- storage possession/integrity challenges

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

## Phase 7 — Resource Accounting — Planned

Goal: accurately measure useful resources supplied and consumed before creating an economic incentive system.

Measure independently:

- storage actually used
- storage duration (for example GiB-days)
- bandwidth actually served
- verified compute/jobs completed
- crawler/indexing work
- repair traffic
- node availability
- job success/failure
- integrity challenge results

Keep logical application usage separate from physical network cost.

Do not reward nodes primarily for advertising unused capacity.

## Phase 8 — PrivaCredits — Planned

Goal: reward useful contribution and charge for resource consumption using an internal non-cryptocurrency accounting system.

PrivaCredits are not cryptocurrency, blockchain assets, mining rewards, or speculative tokens.

Core rules:

- use an append-only auditable ledger
- use integer accounting units
- require idempotent ledger events
- preserve reason/reference IDs
- version all economic policies
- preserve the policy version that generated historical entries
- separate storage, bandwidth, compute, and specialized-work measurements
- avoid unlimited rewards simply for remaining connected while idle

Potential ledger events include:

- STORAGE_REWARD
- BANDWIDTH_REWARD
- COMPUTE_REWARD
- STORAGE_CHARGE
- BANDWIDTH_CHARGE
- FREE_ALLOWANCE
- ADMIN_ADJUSTMENT
- REVERSAL

### Reliability incentives

Useful work may receive a bounded reliability multiplier based on measurable behavior such as:

- successful jobs
- successful storage challenges
- uptime/availability
- failed retrievals
- corruption
- unexpected disappearance
- graceful shutdown behavior

Reliability should primarily modify rewards for useful contribution rather than become a large passive source of credits.

### Demand multipliers

PrivaNet may eventually offer bounded, versioned demand multipliers when a useful resource is genuinely scarce.

For example, compute or bandwidth supplied during a network shortage may earn more than the same resource supplied during a period of excess capacity.

Demand multipliers must be based on actual network supply/demand and remain bounded/configurable. They must not turn PrivaCredits into a speculative market.

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
