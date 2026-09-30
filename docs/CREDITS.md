# PrivaCredits Design

Status: **planned / research.** Nothing here is implemented. PrivaCredits should be implemented only after PrivaNet can accurately measure useful resource contribution and consumption (Phase 7), and they arrive together with the resource market (Phase 8).

**Direction update:** PrivaCredits are the accounting unit of an internal [resource market](RESOURCE_MARKET.md). *Resources* are what get priced; credits are how the accounting is kept. Where this document earlier described fixed conversion rates and demand multipliers, the market design refines or supersedes them; the affected sections say so and keep the original reasoning.

## Purpose

PrivaCredits provide internal accounting for resources supplied to and consumed from PrivaNet.

They are not intended to be:

- cryptocurrency
- blockchain assets
- mining rewards
- speculative tokens
- proof-of-work
- externally tradable currency, or anything with a cash exchange rate

## No external token market

PrivaCredits are not meant to support buying or selling for dollars, exchange or crypto trading, speculative transfer markets, cash-out, or investment. Credits move between accounts *inside* PrivaNet as the internal accounting mechanism for resources consumed and supplied. The market exists inside PrivaNet; the resources are what is bought and sold. Features that would let credits leave the system or be traded for outside value are out of scope.

## Core principle

Rewards should follow useful contribution, not merely advertised capacity or idle connection time. **Advertising capacity must not create credits.**

Conceptually (market model, planned):

```text
reward = verified useful contribution × settlement price × bounded reliability adjustment
```

The settlement price comes from the resource market. The earlier conceptual form, `measured_useful_contribution × applicable_policy_multipliers`, is retained only as the fallback used by a deployment that runs a fixed reference price with the market disabled (for example a private single-operator installation).

Only Coordinator-authorised, policy-valid, verified resource consumption may generate contributor rewards.

Different resource classes should remain independently measurable before conversion into credits.

Examples:

- storage actually occupied over time
- bandwidth actually served (verified useful bytes from data-plane transfers, not issued transfer authorizations; see [DATA_PLANE.md](DATA_PLANE.md#10-accounting-implications-phase-7-and-later))
- verified compute/jobs completed
- crawler/indexing work
- repair traffic

## Accounting model

Use an append-only ledger rather than a mutable balance as the source of truth.

Every ledger entry should eventually contain enough information to audit why it exists, including:

- event ID
- account/node/application as appropriate
- integer credit amount
- event type/reason
- reference/idempotency key
- timestamp
- economic policy version

Balances are derived from ledger events or safely cached from them.

Research direction: record each settlement as a **balanced pair of entries** (consumer debit, provider credit, plus any explicit fee or sink) so that conservation of credits is a checkable invariant. Under the market model a settlement is one paired transfer rather than two independent `REWARD` and `CHARGE` events.

Use integer accounting units. Do not use floating-point arithmetic for balances.

## Example event types

- `STORAGE_REWARD`
- `BANDWIDTH_REWARD`
- `COMPUTE_REWARD`
- `STORAGE_CHARGE`
- `BANDWIDTH_CHARGE`
- `FREE_ALLOWANCE`
- `ADMIN_ADJUSTMENT`
- `REVERSAL`

Treasury events (`MARKET_LEVY`, `TREASURY_DEPOSIT`, `PUBLIC_GOOD_SPEND`, `PUBLIC_CRAWL_SPEND`, `CONTRIBUTOR_MATCH`, `NETWORK_MAINTENANCE_SPEND`, `EMERGENCY_RESERVE_SPEND`, `TREASURY_ADJUSTMENT`, `TREASURY_REVERSAL`) are planned for Phase 9 and described in [TREASURY.md](TREASURY.md). Under the market model a paired `SETTLEMENT` event (charge and reward together) and explicit issuance/sink events (subsidy-pool issuance, fees) are likely; the reward/charge names above remain candidates. The exact event vocabulary may evolve with protocol versions. Every event references the job, lease/attempt, node, application, resource class, unit version, quantity, price and policy version it settles.

## Reliability multiplier

PrivaNet may apply a bounded multiplier to useful contribution based on measured reliability.

Possible signals include:

- successful job completion
- job failures attributable to the node
- successful storage integrity challenges
- retrieval success
- corruption
- unexpected disconnects
- expected/graceful shutdowns
- availability over suitable measurement windows

Reliability should not become an unlimited passive credit generator. A highly reliable node with no useful contribution should not earn large rewards simply for being online.

Illustrative only:

```text
useful contribution × reliability multiplier
```

Actual multiplier ranges must be determined after measurements and must remain bounded/configurable.

## Expected vs unexpected downtime

A node that requests graceful draining should be treated differently from a node that unexpectedly vanishes while holding active work.

Planned availability schedules may also help distinguish expected absence from unreliable behavior.

Reliability scoring should avoid punishing ordinary computer owners simply for turning their machines off normally.

## Scarcity: demand multipliers refined by market pricing

**Superseded in direction, insight retained.** An earlier version of this design proposed bounded, versioned *demand multipliers* applied to rewards when a resource was scarce. The insight stays: scarcity of a resource should be rewarded, using real network conditions and not arbitrary choices. The mechanism changes: **resource scarcity should primarily be reflected in the market clearing price**, not in manually configured multipliers or time-of-day bonuses.

- If compute supply is low while compute demand is high, the compute clearing price rises.
- If storage supply greatly exceeds demand, the storage price falls.
- Bounded policy adjustments and emergency controls may still exist (see price guardrails in [the market design](RESOURCE_MARKET.md#price-guardrails)), but they are secondary, versioned and audited.
- A fixed multiplier on top of a market-discovered settlement price would double-count scarcity and is not planned.

For reference, the original reasoning:

<details>
<summary>Original fixed demand-multiplier design (superseded)</summary>

PrivaNet may eventually use bounded demand multipliers when a particular resource is scarce relative to current demand.

Potential resource classes:

- storage
- bandwidth
- general compute
- crawling
- indexing
- specialized capabilities

Conceptually:

```text
final reward = base useful contribution × reliability factor × demand factor
```

This formula is intentionally conceptual. Final policy should be versioned and based on real measurements.

A demand factor should be derived from actual network conditions rather than manually chosen to promote particular nodes.

Examples of conditions that might increase a resource's multiplier:

- insufficient eligible compute for queued jobs
- insufficient available bandwidth for active demand
- shortage of storage replicas meeting placement requirements

Examples of conditions that should not automatically earn a bonus:

- merely advertising large capacity
- remaining connected without completing useful work
- artificially generating self-demand

#### Time-of-day availability (original wording)

Demand may naturally vary by time of day. If the network genuinely has a shortage during a certain period, nodes performing useful work during that period may receive a higher bounded demand multiplier.

This should be dynamic rather than a permanently hardcoded "evening bonus" because network usage patterns may differ by deployment, geography, and time.


</details>

Examples of what should **not** earn extra under either model: merely advertising large capacity, remaining connected without completing useful work, artificially generating self-demand.

### Time-of-day availability

Demand varies by time of day, and a shortage during some period should raise the price of the resource in that period. Under the market model this happens through the clearing price. Owners who want to contribute mostly when the network needs it express that with pricing conditions (for example "evening: only if price is at least 1.4 × reference"; see [pricing conditions](RESOURCE_MARKET.md#pricing-conditions-and-schedules-planned)), instead of PrivaNet paying a hardcoded "evening bonus" that may not fit a deployment, geography or time.

## Availability consistency

Consistent availability can be useful because it makes scheduling and storage placement more predictable.

Rather than paying large passive uptime rewards, PrivaNet should primarily represent consistency through:

- reliability multipliers on useful work
- scheduler preference when appropriate
- placement decisions
- lower expected failure/repair cost

A small explicitly bounded availability incentive could be researched later if measurements show that reliability multipliers alone do not provide enough incentive, but it should not be assumed necessary.

## Policy versioning

Economic constants must not be scattered through source code.

A policy version should define parameters such as:

- reference prices and the resource units (with versions) for each class
- price guardrails: minimum and maximum asks, maximum movement per period, circuit-breaker rules
- clearing/settlement rules
- base conversion rates (fixed-rate deployments)
- free allowance
- multiplier bounds
- measurement windows
- rounding rules
- minimum billable/rewardable units
- anti-abuse thresholds

Historical ledger events retain the policy version used when they were created. Changing policy must not silently reinterpret old transactions.

## Credit issuance, circulation and sinks

Preferred structure: much of the economy is credits **moving** from consumers to providers, not new minting.

```text
Resource consumer --credits charged--> PrivaNet accounting/market --credits rewarded--> Resource provider
```

Credits may be **created** only by explicit, auditable, versioned mechanisms such as a configured free allowance or subsidy pool, or an administrative adjustment. Credits may be **removed** only by explicit sinks (for example a small settlement fee). Nothing may create credits from advertised capacity or idle connection time, and the design must not continuously create credits without corresponding useful resource consumption. A settlement that does not balance is a bug.

### Network Treasury (planned, Phase 9)

A small, bounded, versioned levy on successful settlements may route a visible share to an internal **Network Treasury** that pays for public-good work (public crawling, maintenance, contributor bootstrap, emergency repair):

```text
Consumer pays 100  ->  Provider receives 97  +  Treasury receives 3   (illustrative; no rate chosen)
```

This is redistribution of existing credits, not issuance; the levy is an explicit ledger entry, never hidden in the reward. Issuance (free allowance, subsidies) stays separately measured and is never hidden inside treasury operations. Ordinary balances are not confiscated for inactivity. The treasury is not an investment fund and credits stay non-tradable. See [TREASURY.md](TREASURY.md).

Track eventually: total credits issued and consumed, credits circulating, credits per active account, clearing prices per class, total supply and demand per class, storage used versus offered, and compute and bandwidth demand versus supply.

## Free allowance

PrivaNet may provide users with a configurable free allowance so the ecosystem remains usable without requiring immediate contribution or payment.

Free allowance should be represented explicitly in accounting rather than hidden as special-case arithmetic. **It creates real network cost** (someone supplies those resources), so it must not be assumed fundable by unlimited credit creation. Future concept, not implemented: a **bounded subsidy / free-tier pool** with explicit per-period issuance, per-account limits, and full ledger and metric visibility; alternatives include funding from fees, or from operator-provided capacity in a private deployment. Sybil accounts farming the allowance are a named risk.

## Anti-abuse requirements

Before PrivaCredits become meaningful, the design must address:

- duplicate reward events
- replay attacks
- fake job completion
- fake bandwidth
- fake storage claims
- Sybil nodes
- colluding nodes
- self-generated demand and wash activity
- intentional job failure/retry farming
- market manipulation: clearing-price manipulation, artificial scarcity by withdrawing supply, colluding nodes/clients, bandwidth farming, useless compute jobs, storage churn for rewards
- allowance farming through many accounts
- treasury abuse: fake public jobs, onboarding/bootstrap farming through node or account churn, duplicate or replayed treasury payouts, budget races (see [TREASURY.md](TREASURY.md))
- manipulated telemetry
- compromised node credentials

No single node's self-reported resource usage should be blindly accepted as sufficient proof for valuable rewards.

## Implementation order

1. measure physical resources accurately (Phase 7);
2. record auditable usage events per attempt;
3. validate measurements and anti-abuse assumptions;
4. introduce a ledger (with a fixed reference price and the market off, which is also the private-deployment mode);
5. simulate clearing mechanisms and adversarial strategies;
6. introduce per-class supply, asks and demand, then the market with price guardrails;
7. add reliability policy after enough data exists;
8. add bounded policy adjustments only where measurements show the market alone is insufficient;
9. only then add the Network Treasury (levy, budget buckets, public-good jobs, contributor bootstrap), Phase 9.

This keeps the economy downstream of real infrastructure rather than forcing the infrastructure to fit an untested reward model. We should not attempt to build a market around unverified resource claims.
