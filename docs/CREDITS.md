# PrivaCredits Design

Status: **planned**. PrivaCredits should be implemented only after PrivaNet can accurately measure useful resource contribution and consumption.

## Purpose

PrivaCredits provide internal accounting for resources supplied to and consumed from PrivaNet.

They are not intended to be:

- cryptocurrency
- blockchain assets
- mining rewards
- speculative tokens
- proof-of-work

## Core principle

Rewards should follow useful contribution, not merely advertised capacity or idle connection time.

Conceptually:

```text
reward = measured_useful_contribution × applicable_policy_multipliers
```

Different resource classes should remain independently measurable before conversion into credits.

Examples:

- storage actually occupied over time
- bandwidth actually served
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

The exact event vocabulary may evolve with protocol versions.

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

## Demand multipliers

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

## Time-of-day availability

Demand may naturally vary by time of day. If the network genuinely has a shortage during a certain period, nodes performing useful work during that period may receive a higher bounded demand multiplier.

This should be dynamic rather than a permanently hardcoded "evening bonus" because network usage patterns may differ by deployment, geography, and time.

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

- base conversion rates
- free allowance
- multiplier bounds
- measurement windows
- rounding rules
- minimum billable/rewardable units
- anti-abuse thresholds

Historical ledger events retain the policy version used when they were created. Changing policy must not silently reinterpret old transactions.

## Free allowance

PrivaNet may provide users with a configurable free allowance so the ecosystem remains usable without requiring immediate contribution or payment.

Free allowance should be represented explicitly in accounting rather than hidden as special-case arithmetic.

## Anti-abuse requirements

Before PrivaCredits become meaningful, the design must address:

- duplicate reward events
- replay attacks
- fake job completion
- fake bandwidth
- fake storage claims
- Sybil nodes
- colluding nodes
- self-generated demand
- intentional job failure/retry farming
- manipulated telemetry
- compromised node credentials

No single node's self-reported resource usage should be blindly accepted as sufficient proof for valuable rewards.

## Implementation order

1. measure physical resources accurately;
2. record auditable usage events;
3. validate measurements and anti-abuse assumptions;
4. introduce a ledger;
5. introduce simple configurable conversion rates;
6. add reliability policy after enough data exists;
7. add demand multipliers only after supply/demand behavior can be measured safely.

This keeps the economy downstream of real infrastructure rather than forcing the infrastructure to fit an untested reward model.
