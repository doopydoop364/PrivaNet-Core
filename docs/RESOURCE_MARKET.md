# PrivaNet Resource Market

Status: **planned / research.** No part of the market exists in the code. It
is scheduled for Phase 8 and must not start before Phase 7 (verified resource
measurement) is done. This document is the long-term design direction; the
current implementation is described in [architecture](architecture.md),
[protocol](protocol.md) and [resources](RESOURCES.md). Everything below is a
plan or an open research question unless it explicitly says otherwise.

## In one paragraph

PrivaNet should eventually operate an **internal market for verified, useful
resources** (storage, bandwidth, compute, crawler and indexing capacity, and
other explicitly supported classes). **PrivaCredits are the accounting unit;
resources are what get priced.** Nodes offer capacity at an *ask*; applications
request resources with a maximum acceptable price and constraints; the market
decides which supply is economically eligible and at what *clearing price*; a
separate *scheduler* decides which eligible node is operationally appropriate;
and only Coordinator-authorised, policy-valid, *verified* consumption is
settled into the ledger. Advertising capacity never creates credits.

## Goals

1. Let scarcity and abundance show up as price, so nobody has to hand-tune
   bonuses or manually pick nodes.
2. Keep ordinary owners out of the market's complexity: sensible automatic
   pricing by default, manual asks only for advanced users.
3. Keep the owner's own workload first. Supply is dynamic and never a promise
   that overrides hard operator limits.
4. Tie credits to verified useful resource consumption, so the economy cannot
   inflate by itself.
5. Keep the market auditable, versioned and bounded (guardrails), and resistant
   to the manipulation attacks a market invites.
6. Stay useful with one user and one machine: the market must be optional and
   collapse to "free / fixed reference price" for private deployments.

## Non-goals

PrivaCredits are **not** cryptocurrency, a blockchain asset, a mining reward, a
speculative token, an externally tradable currency, or anything with a cash
exchange rate. There is no design for buying or selling credits for money,
exchange listing, cash-out, transfer markets between unrelated parties, or
investment. The market lives inside PrivaNet; the resources are what is bought
and sold. Any feature that would let credits leave the system or be traded for
outside value is out of scope and would need a deliberate change to this
document.

## Terminology

Use these terms consistently in code, docs and UI.

| Term | Meaning |
| --- | --- |
| **Resource class** | A separately priced kind of resource: storage, bandwidth, compute, crawl, indexing, and later others. Each class is its own market. |
| **Resource unit** | The explicit, measurable, versioned unit a class is priced in (see below). |
| **Supply** | The amount of a class a node is *currently* willing and able to provide. Dynamic; derived from the adaptive resource budget and the node's policy. |
| **Demand** | A request by an application for an amount of a class, with constraints and a maximum acceptable price. |
| **Reference price** | Policy-defined baseline price per unit for a class (versioned, set by the network operator). Anchors automatic pricing and guardrails; it is not the price anyone necessarily pays. |
| **Ask** | The minimum price per unit a node will accept to provide a class. |
| **Clearing price** (also *market price*) | The price that emerges from current supply and demand for a class in a clearing round. |
| **Effective cost / score** | The scheduler's evaluation of an eligible node for a specific request, combining price with non-price factors (reliability, latency, pressure, and so on). Never paid to anyone. |
| **Settlement price** | The final per-unit rate used to compute what the consumer is charged and the provider is credited for a verified unit of consumption. |
| **Verified consumption** | Resource use that the Coordinator authorised in advance, that met policy, and that was independently measured or checked. The only thing that can generate contributor credits. |
| **Policy version** | The immutable set of economic parameters in force when an event was created. |

## Resource classes and units

Each market uses an explicit, versioned, measurable unit. **The units below are
examples to evaluate, not commitments:**

| Class | Candidate unit | Measured how (research) |
| --- | --- | --- |
| Storage | credits per GiB-day (or another versioned storage-time unit) | bytes actually stored and verified over time, via placement records and integrity/possession challenges |
| Bandwidth | credits per GiB of *valid application traffic* | bytes actually served for authorised transfers, counted from both ends where possible; repair and wash traffic excluded |
| Compute | credits per normalised compute unit | needs a definition (CPU-seconds normalised by a benchmark? per job type?); verification is hard and is an open question |
| Crawl | credits per verified crawl unit | pages fetched and validated by the application/Coordinator, not claimed by the node |
| Indexing | credits per verified indexing unit | documents indexed and spot-checked |

Rules for every unit: it has an identifier and version (`storage.gib-day.v1`
style), an integer resolution for accounting, a rule for what counts, a
rule for what is excluded, and a way to verify it. Changing a unit's definition
creates a new version; old ledger events keep the version they were created
under. Classes are separate because their economics differ: storage is a
long-lived obligation with durability requirements, bandwidth is instantaneous,
compute is ephemeral and hard to verify, and specialised work depends on what
applications need. Do not assume one formula fits all.

## Supply and asks

A node's supply of each class is *dynamic*, derived from the adaptive resource
engine ([resources](RESOURCES.md)). The same node may offer 8 GiB of RAM-backed
compute budget and 50 % CPU while idle, and 0.5 GiB and 5 % while its owner is
gaming. Supply is re-derived continuously and is never a standing promise.

```text
Node A
  storage    available 500 GiB     ask 0.8 credits / GiB-day
  compute    adaptive capacity     ask 1.2 credits / compute-unit
  bandwidth  max 20 Mbps           ask 1.4 credits / GiB
```

(Numbers are illustrative.)

**Advertised capacity is an offer, not an entitlement and not income.**
Declaring 10 TB earns nothing. A node is never required to honour advertised
capacity if doing so would break its hard operator limits or resource-safety
rules; the Coordinator must treat withdrawals under those rules as expected
behaviour rather than failure (see reliability below). The exception is an
already accepted obligation, chiefly stored data: leaving with data still held
is handled by draining, repair and notice periods, not by silently vanishing.

### Owner-facing pricing modes (planned UX)

Normal users must not be forced to tune a market. Planned modes:

- **Automatic** — follow the clearing/reference price.
- **Competitive** — slightly below market/reference to win more work.
- **Premium** — above market/reference, contributing mainly during shortages.
- **Custom** — advanced manual ask per class.

These are UX concepts, not protocol commitments.

### Pricing conditions and schedules (planned)

Owners will be able to express when they contribute and at what price, building
on the availability schedule already in the node policy:

```text
Night:    contribute at any market price
Day:      contribute if price >= reference price
Evening:  contribute only if price >= 1.4 x reference price
```

A condition evaluates locally to an effective ask (or "unavailable") at a given
time. This lets owners supply resources when the network needs them without
PrivaNet inventing time-of-day bonuses. Planned availability schedules also
feed the scheduler, so long jobs are not placed just before a node intends to
leave.

## Demand

Applications ask PrivaNet for resources instead of picking nodes:

```text
PrivaSearch  needs 500 crawl units, max acceptable price X
PrivaDrive   needs physical storage, min reliability Y, max acceptable price Z
```

A request carries the class and amount, a maximum price (or a budget), and
constraints (minimum reliability, capability, placement or failure-domain
requirements, deadline). Applications never choose nodes and never see node
identities, consistent with the current API. In a private deployment an
application's price limit may simply be "unlimited" and the price zero.

## Market and scheduler are separate

```text
Resource request
      |
      v
Resource market      determines economically eligible supply and the price
      |
      v
Scheduler            chooses operationally appropriate nodes among them
      |
      v
PrivaNodes
```

The **cheapest node must not automatically win.** The market answers "which
supply is willing to serve this at an acceptable price, and what is the price?".
The scheduler answers "of those, who should actually get the work?", and may
weigh:

- reliability and completion history
- latency and geography where relevant
- current resource pressure and permitted budget
- operator limits and node workload
- planned availability (avoid long jobs before a planned exit)
- failure-domain diversity
- capability support and storage placement constraints

For **storage in particular, price must never override durability**: replica
count, failure-domain spread and placement rules are constraints the market
cannot trade away. The scheduler's *effective cost/score* is an internal
ranking; it is not a payment. Keeping the two separate means either can change
without rewriting the other, and lets a single-node deployment run the scheduler
with no market at all (which is exactly how v0.2 works).

## Clearing price (preferred direction to research)

Rather than paying every accepted node its own arbitrary ask, research a
**market-clearing or auction-like mechanism**. Illustration:

```text
A offers 20 units at 0.70      cumulative 20
B offers 30 units at 0.80      cumulative 50
C offers 30 units at 0.90      cumulative 80
D offers 40 units at 1.00      cumulative 120
E offers 50 units at 1.30

Demand: 100 units
```

Accepting the cheapest offers fills A, B, C and 20 of D's 40 units. A natural
uniform clearing price is the marginal accepted offer (1.00) or the lowest
rejected offer (1.30); every accepted node is then settled at that one price,
instead of at 0.70/0.80/0.90/1.00. Uniform pricing removes much of the incentive
for a node to guess and shade its ask, because its own ask mostly determines
*whether* it is accepted, not *what it is paid*. It is not a full guarantee:
nodes with a lot of supply can still influence the price, so truthfulness is
not automatic for multi-unit sellers.

**No algorithm is chosen.** Candidates to simulate include uniform-price reverse
auctions (marginal-accepted versus first-rejected price), pay-as-ask, posted
price with automatic adjustment, and periodic batch clearing versus continuous
matching. Requirements to evaluate any candidate: resistance to price
manipulation and collusion, behaviour in thin markets (one or two nodes),
stability, low complexity for a small deployment, and easy explanation to
owners. **Simulate before implementing.**

## Settlement

Settlement turns verified consumption into ledger entries at the *settlement
price*: the consumer is charged and the provider credited (see
[credits](CREDITS.md)). Open design points: whether the price is fixed when work
is accepted or when it completes; whether long-lived storage is priced by term
contract or repriced each epoch; partial completion; failed or disputed work;
refunds and reversals; and minimum billable units. Settlement must be
idempotent, reference the job/lease/attempt, node, application, resource class,
unit version, quantity, price and policy version, and be reversible only by an
explicit compensating entry.

## Treasury as a buyer (planned, Phase 9)

Some demand has no single payer (public crawling, maintenance, contributor bootstrap). The planned [Network Treasury](TREASURY.md) is funded mainly by a small, bounded, versioned levy on the settlements described above and pays for that work **as an ordinary market participant**: a budgeted demand with a maximum willingness to pay, not a privileged unlimited buyer. It goes through the same request, market, scheduler, verification and settlement path, and it slows or pauses non-urgent purchases when a class is scarce or expensive. The settlement design must therefore leave room for an explicit, visible levy entry; the treasury itself is not part of the market phase.

## Reliability

Reliability stays **separate from price**. It informs the scheduler (who gets
work) and gives useful contribution a *bounded* adjustment; it is not a passive
income:

```text
reward = verified useful contribution
         x settlement price
         x bounded reliability adjustment
```

The exact formula and multiplier range are configurable, versioned and set from
measurements later. Candidate inputs: successful and failed jobs (attributing
failure correctly), storage challenge results, retrieval success, corruption,
unexpected disappearance, graceful draining/shutdown, and completion history.
A node with high reliability and no useful work earns nothing meaningful.

Planned departures should be far better than vanishing:

```text
ONLINE -> DRAINING -> OFFLINE_EXPECTED
```

These states already exist in the protocol (v0.2). A graceful exit should carry
little or no reliability penalty compared with an unexplained disappearance
while holding work. Pressure-driven releases (the owner needed the machine) are
likewise expected behaviour, not failure; a node that constantly releases work
simply receives less of it.

## Adaptive supply

The market must treat capacity as dynamic and never bind a node beyond its owner's
rules:

```text
Idle:    available RAM 12 GiB -> PrivaNet budget 8 GiB, CPU budget 50 %
Gaming:  available RAM  3 GiB -> PrivaNet budget 0.5 GiB, CPU budget 5 %
```

The per-node budget and pressure that v0.2 already reports are the raw material
for supply. Consequences for the design: clearing is repeated frequently enough
to follow supply; committed but unstarted work can be re-placed when supply
vanishes; supply reports are hints that will need verification (below); and
price signals may never be used to push a node beyond its hard limits.

## Scarcity: market pricing supersedes fixed demand multipliers

Earlier design notes proposed bounded, versioned *demand multipliers* applied to
rewards when a resource was scarce (for example an "evening bonus"). The
underlying insight is kept: **scarcity should be rewarded, using real supply and
demand.** The mechanism changes:

- Preferred: scarcity shows up **in the clearing price**. If compute supply is
  low and compute demand high, the compute clearing price rises; if storage
  supply greatly exceeds demand, the storage price falls. No one configures a
  time-of-day bonus; owners choose when to contribute using pricing conditions.
- Retained as secondary tools only: bounded policy adjustments and emergency
  controls (see guardrails), all versioned and audited.
- A fixed multiplier applied to a settled price would double-count scarcity and
  is not part of the design.

## Credit issuance and circulation

**Advertising capacity must not create credits.**

```text
Bad:   node says it has 10 TB   -> credits issued
Good:  verified resources used  -> contribution measured
                                -> valid settlement -> provider credited
```

Preferred structure: most of the economy is credits **moving** from consumers
to providers, not new minting.

```text
Consumer  --charged-->  accounting / market  --credited-->  Provider
```

New credits enter only through explicit, auditable, versioned mechanisms such as
a bounded free allowance / subsidy pool or an administrative adjustment; credits
leave through explicit sinks (for example a small fee). Research a double-entry
ledger so that "every settlement balances" is a checkable invariant. A useful
consequence: when consumer and provider are the same actor, a wash transaction
nets to zero (minus any fee), so fake demand costs the faker rather than minting
rewards; the residual risk is *subsidy* leakage through many fake accounts.

### Free allowance

A free allowance creates a real network cost, so it cannot be funded by
unlimited creation. Design direction (not implemented): a **bounded subsidy /
free-tier pool** with explicit per-period issuance, per-account limits tied to
some cost of creating accounts, and full visibility in the ledger and metrics.
Alternatives to research: allowance funded from fees, or from operator-provided
capacity in a private deployment.

### Macroeconomic metrics to track eventually

total credits issued, consumed and circulating; credits per active account;
per-class clearing prices; total supply and demand per class; storage used versus
offered; compute and bandwidth demand versus supply; subsidy pool balance and burn
rate. Continuous credit creation without matching resource consumption is an
architecture bug.

## Price guardrails

An uncontrolled market can produce absurd or unsafe prices. Research bounded
guardrails; **do not hard-code values now**:

- versioned reference prices per class
- minimum and maximum allowed asks
- maximum automatic price movement per period
- circuit breakers for abnormal conditions (fall back to the reference price,
  pause clearing, or freeze settlement)
- administrative emergency controls, time-limited and logged

Every parameter is configurable, versioned and auditable, and a change never
reinterprets past events.

## Anti-manipulation

The market creates attack surface. The threat model in
[security](security.md#market-specific-threats-planned) lists these; the
design consequences are:

| Threat | Direction (all future work) |
| --- | --- |
| Fake demand; wash activity | Circulation ledger makes it zero-sum; subsidies bounded and account-gated; reward only for policy-valid consumption |
| Fake contribution; falsified telemetry | Never reward self-reported figures; independent measurement (both ends, challenges, spot checks, redundancy) |
| Colluding nodes/clients; bandwidth farming | Rewardable traffic must be Coordinator-authorised for an application purpose and evidenced by verified data-plane transfers rather than issued authorizations (see [DATA_PLANE.md](DATA_PLANE.md#10-accounting-implications-phase-7-and-later)); cap or exclude traffic between related parties; anomaly detection |
| Useless compute jobs | Job types come from the typed registry, applications pay for them, and verification defines rewardable work |
| Storage churn only to earn | Reward stored-and-retained data over time, charge for churn and repair, discount short-lived storage |
| Sybil nodes | Enrollment control now; identity cost and reputation in Phase 10; never let identity count alone buy influence over the clearing price |
| Clearing-price manipulation; artificial scarcity by withdrawing supply | Uniform-price design, thin-market protections, movement limits, circuit breakers, statistics on withdrawals |
| Manipulating price before treasury purchases; treasury overpaying under artificial scarcity | Treasury maximum willingness to pay, reference-price ceilings, thin-market protection, throttling when scarce, circuit breakers (see [TREASURY.md](TREASURY.md)) |
| Credential theft | Per-account limits, revocation, reversal entries |

The critical rule: **only Coordinator-authorised, policy-valid, verified
resource consumption may generate contributor rewards.** Two cooperating accounts
repeatedly moving useless data must not be able to mint bandwidth rewards.

## Observability and history

Dashboards may eventually show, per class, the current clearing price, a 24 h
low/high, available supply, current demand, and used versus offered storage.
Publish aggregates only, avoid exposing individual nodes or users (apply minimum
participant thresholds and delays), and keep the underlying history for
transparency and debugging. Market data is not third-party telemetry and stays
inside the deployment.

## What the current code already provides

The Phase 1 and 2 design leaves extension points; no marketplace code was added
for this document. A review of the current interfaces:

| Need | Current state | Verdict |
| --- | --- | --- |
| Stable job identities | Registry ids like `system.echo.v1`; wire schemas derive from one registry | Ready |
| Job resource requirements | Every registered job type declares a `ResourceEstimate` | Ready. A future versioned *billing unit* per job type is an additive registry field |
| Dynamic node availability | v0.2 heartbeat reports permitted memory/CPU budget, contribution, pressure, power and lifecycle | Ready for compute-like supply. Per-class supply (storage, bandwidth) and asks would be additive optional fields |
| Replaceable scheduler policy | `Scheduler` interface, `ResourceAwareScheduler` | Ready. The interface is node-pull (`choose(node, pending)`); a market eligibility filter can compose in front, and placement decisions (storage, batch clearing) may need a job-centric ranking interface added internally, not on the wire |
| Resource classes | Estimates are per-dimension; there is no class for pricing | Deliberate: classes and units are defined in Phase 7/8 |
| Accounting events referencing jobs/resources/nodes | Jobs keep application and (once leased) node/lease IDs, but retries overwrite the previous assignee and release reasons are not stored | Gap, by design: the measurement phase must add append-only per-attempt usage records. **Nothing before that exists is billable.** |
| Node ownership by an account | Nodes are not bound to an account; applications are scoped credentials | Gap: Phase 8 needs a node-to-account link, likely via the enrollment grant |
| Explicit protocol versions | Protocol 1, additive-only policy, explicit 426 on mismatch | Ready |
| Versioned economic policy | Coordinator `Policy` is operational and unversioned | Expected: economic policy versioning arrives with the ledger |

No Phase 1 or Phase 2 code change was necessary.

## Prerequisites before any market is activated

1. **Phase 7 measurement**: append-only, idempotent usage records per attempt
   (job, lease, node, application, class, unit version, quantity, evidence).
2. Verification methods per class (storage possession challenges, compute spot
   checks or redundancy, crawl validation, two-ended bandwidth accounting) with
   a written threat analysis. *We should not build a market around unverified
   claims.*
3. Node-to-account and application-to-account identity, and per-account limits.
4. Versioned economic policy storage and a ledger with idempotent, balanced
   entries (likely PostgreSQL rather than SQLite).
5. A simulation harness for clearing mechanisms and adversarial strategies.
6. Per-class supply and ask reporting in the protocol (additive fields) and the
   pricing-condition evaluation on the node.
7. A private-deployment mode with the market off.

## Unresolved research questions

- Which clearing mechanism, and how often does it clear (continuous, per-epoch, per-job)?
- Uniform price at the marginal accepted ask or the lowest rejected ask? How to handle thin markets?
- How is compute normalised into a unit that is fair across hardware and job types, and how is it verified?
- How is long-lived storage priced: term contracts, or repricing each epoch, and who bears repair cost when a node leaves?
- What exactly counts as "valid application traffic" for bandwidth, and how are related-party transfers treated?
- Can reliability be measured without punishing ordinary owners who switch machines off, and what multiplier range is justified?
- How are new-account subsidies bounded against Sybil farming while still letting real newcomers use the network?
- What are sensible reference prices, price-movement limits and circuit-breaker triggers, and who sets them?
- How do price-driven supply changes interact with the adaptive engine so that price never pushes a node past its limits?
- What is the minimum participation needed before a market is meaningful, and what is the fallback below it?
- What visibility is acceptable without exposing individual nodes?
- How does the settlement leave room for a levy entry, and are treasury-paid settlements levied? See [TREASURY.md](TREASURY.md#unresolved-research-questions).
