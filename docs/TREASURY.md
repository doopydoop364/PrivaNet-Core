# PrivaNet Network Treasury

Status: **planned / research.** Nothing in this document exists in the code. The
treasury is scheduled for Phase 9 and depends on Phase 7 (verified resource
measurement) and Phase 8 (resource market and PrivaCredits ledger). This is the
long-term design direction and the source of truth for future implementation.
Parameters, percentages and names are illustrative unless stated otherwise.
Related: [resource market](RESOURCE_MARKET.md), [PrivaCredits](CREDITS.md),
[resources](RESOURCES.md), [architecture](architecture.md),
[security](security.md#treasury-specific-threats-planned).

## In one paragraph

Some useful work has no single purchaser: crawling a site nobody has searched
for yet, refreshing stale index pages, repairing shared infrastructure,
bootstrapping trustworthy new contributors. The **Network Treasury** (also
*PrivaNet Treasury*, *Public Resource Fund*) is an internal accounting
mechanism that acts as the payer for this *public-good demand*. It is funded
primarily by **redistributing existing PrivaCredits** through a small, bounded,
visible protocol levy on market settlements, plus explicit and separately
measured allocations. It buys resources **through the same market, scheduler,
verification and settlement path as everyone else**, inside explicit budgets, and
never with special execution rights or unlimited spending authority.

## Goals

1. Fund network-wide useful work that no single user pays for, without hidden
   subsidies or hidden minting.
2. Fund it by moving credits that already exist, so the treasury is not an
   inflation engine.
3. Keep every flow (levy in, spend out) an explicit, auditable ledger event with a
   reason, reference and policy version.
4. Give each subsystem its own budget so a bug in one cannot drain another.
5. Bootstrap new contributors through verified useful contribution, not gifts.
6. Preserve market signals: the treasury is a price-bounded buyer, not a
   privileged one, and it backs off when capacity is scarce.
7. Stay modular: measurement, market, ledger, treasury and public-good budgeting
   are separate components.

## Non-goals

The treasury is an internal resource-budgeting and redistribution mechanism. It
is **not**, and must never become:

- an investment fund: it does not invest credits externally, hold stocks, bonds
  or crypto, buy securities, speculate, or generate yield or returns;
- a profit-distribution mechanism (nothing is paid out as profit or dividends);
- a cash-backed token, or a way to make PrivaCredits externally tradable,
  redeemable for money, or subject to an exchange rate;
- a sovereign-wealth-fund-style asset pool;
- a governance token system. Treasury policy is versioned PrivaNet configuration
  controlled by administrators; community governance is research only, not
  designed here;
- a route for silently confiscating ordinary balances. Inactivity alone never
  makes normally earned credits disappear (see
  [inactive balances](#inactive-balances)).

## Relationship to the economic stack

The stack has five separate layers. They are deliberately not one component.

| Layer | Responsibility | Phase | Doc |
| --- | --- | --- | --- |
| 1. Resource measurement | Measure and verify useful storage, bandwidth, compute, crawl work | 7 | [market](RESOURCE_MARKET.md#prerequisites-before-any-market-is-activated) |
| 2. Resource market | Asks, demand, clearing price, eligibility | 8 | [market](RESOURCE_MARKET.md) |
| 3. PrivaCredits ledger | Append-only internal accounting of charges, rewards, adjustments | 8 | [credits](CREDITS.md) |
| 4. Network Treasury | Receives the levy and explicit allocations; holds budget buckets; funds public-good spending | 9 | this document |
| 5. Public-good budgeting | Decides which network-benefit jobs are worth buying, within bucket budgets | 9 | this document |

Each layer talks to the next through explicit interfaces (usage records into the
ledger, ledger events into treasury accounting, budget-limited demand into the
market). The treasury **may not run before layers 1 to 3 exist and are trusted**:
paying from a shared fund for unverified work is the most exploitable design
available.

```text
private demand:      user/application  --pays-->  resource request --+
                                                                     v
                                                              Resource market --> Scheduler --> PrivaNode
                                                                     ^                              |
public-good demand:  Treasury bucket (budget, max price) ---------- -+            verified completion v
                                                                                            settlement
settlement:  consumer/bucket pays 100  ->  provider 97  +  treasury 3  (all explicit ledger events)
```

## Funding

### Market-settlement levy (primary)

A small configurable protocol levy on **successful** settlements:

```text
Consumer pays:      100 credits
Provider receives:   97 credits
Treasury receives:    3 credits
```

The numbers are illustrative. **No permanent percentage is chosen.** The levy
must be:

- **configurable** and **bounded** (a policy-defined minimum and maximum, so a
  bad configuration cannot make the levy 100%);
- **versioned**: each settlement records the policy version that produced it, and
  a change never reinterprets past entries;
- **auditable** and **visible**: a `MARKET_LEVY` is a separate ledger entry, not
  arithmetic hidden inside the provider's reward, so a consumer or operator can
  see how a payment split between provider and treasury;
- integer arithmetic with a documented rounding rule (which side absorbs the
  remainder), plus a minimum billable size so tiny settlements do not round to
  zero or to absurd relative levies;
- conservation-checkable: the settlement balances (consumer debit = provider
  credit + levy), which the double-entry design makes a testable invariant.

Failed, disputed or reversed work does not pay a levy; a reversal reverses the
levy too (`TREASURY_REVERSAL`). A levy on a wash transaction (one actor on both
sides) costs that actor the levy, which is a small extra disincentive.

Levy design questions (open): flat or per-class rate; whether settlements between
private-deployment nodes and the treasury itself are exempt (treasury-to-provider
payments normally also pay the levy, else the treasury could be used to route
levy-free transfers); interaction with the free allowance.

### Other funding sources (all explicit)

1. **Market-settlement levy** (above).
2. **Explicitly allocated protocol subsidies**: issuance recorded as issuance and
   measured separately from redistribution (see [inflation](#inflation-implications)).
3. **Unused portions of application or public-service budgets**, where an
   application's documented terms return them to the public fund.
4. **Administrative or community grants** recorded with a reason and authority.
5. **Intentionally expired promotional or subsidy allocations**, where the policy
   that created them said they expire and said so up front.

Every source is a named, versioned ledger event (`TREASURY_DEPOSIT` or
`MARKET_LEVY`). Nothing arrives by silent rounding, dust collection or
unexplained adjustment.

### Inactive balances

Ordinary earned or purchased credits are **not** confiscated for inactivity, and
inactivity alone never makes them disappear. Only allocations that were
explicitly created as expiring promotional or subsidy credits, under a policy
that disclosed the expiry when they were issued, may expire. A general
inactivity policy would need a separate, explicit, disclosed design and is not
part of this one.

## Ledger events (future, names may change)

Treasury flows use the same append-only, integer, idempotent, balanced
accounting rules as PrivaCredits ([credits](CREDITS.md#accounting-model)).

| Event | Meaning |
| --- | --- |
| `MARKET_LEVY` | Levy taken from a settlement (paired with that settlement) |
| `TREASURY_DEPOSIT` | Credits added to a bucket from a named source (grant, allocation, expired promotion, subsidy) |
| `PUBLIC_GOOD_SPEND` | Generic spend for a network-benefit job |
| `PUBLIC_CRAWL_SPEND` | Spend from the PrivaSearch public budget for crawl/index work |
| `CONTRIBUTOR_MATCH` | Bootstrap match or bonus for verified contribution (may be pending, see below) |
| `NETWORK_MAINTENANCE_SPEND` | Integrity checks, repair, verification, coordinator maintenance |
| `EMERGENCY_RESERVE_SPEND` | Explicitly authorised emergency spend |
| `TREASURY_ADJUSTMENT` | Administrative correction, always with a reason and authority |
| `TREASURY_REVERSAL` | Compensating entry for a disputed or failed settlement; nothing is edited in place |

Every event eventually preserves: amount (integer), bucket, resource class and
application context where applicable, reason, reference ID (job/lease/attempt or
policy reference), policy version, timestamp, the initiating authority or system
component, and an audit trail. Events are idempotent by reference ID so a replay
or retry cannot pay twice. Balances are derived from events (or cached from them
transactionally). The ledger is not implemented and this table is not a schema.

## Budget buckets

The treasury is one internal accounting entity with **separate logical buckets**,
not separate currencies and not one unlimited pool:

| Bucket | Purpose |
| --- | --- |
| General Reserve | Unallocated funds; the source for explicit, policy-approved reallocations |
| PrivaSearch Public Goods | Public crawl queue and index maintenance |
| Contributor Bootstrap | Onboarding match and bonuses |
| Network Maintenance | Integrity verification, storage challenges, repair and metadata replication |
| Emergency Reserve | Bounded, explicitly authorised emergency spending; never the everyday funding source |

The point is isolation: a runaway crawler cannot consume the contributor
bootstrap budget, and a bootstrap bug cannot drain the emergency reserve. Rules:

- each bucket has an explicit balance, an allocation policy and a spending policy;
- moving funds between buckets is an explicit, versioned, logged event with an
  authority and reason, never implicit;
- every spending path has a **per-period cap** (for example a daily allocation)
  and, where useful, sub-budgets, so a single bug or compromised scheduler is
  bounded to a fraction of one bucket;
- spends are transactional: budget check and spend commit together, so
  concurrent requests cannot overshoot;
- the bucket list and all percentages are open questions, not decisions.

## Public-good jobs

Two kinds of demand use the same machinery:

```text
Private demand:      application/user pays
Public-good demand:  Network Treasury (a bucket) pays
```

A public-good job is an ordinary typed job: typed registry entry, resource
request, market matching, scheduler, verification, settlement, accounting. The
only difference is the **payer**. There is **no special, unsafe or privileged
execution path** for treasury-funded work: the same job-type restrictions, node
limits, capability checks, verification and security review apply, and a
treasury-funded job never gets extra trust or looser limits.

A rule of thumb for eligibility: *if the network itself is the primary
beneficiary rather than one user, the Network Treasury may be the payer.* That
does not make every internal task subsidy-worthy. Each category needs an explicit
budget and policy, and a public-good job type should say what verified output it
produces and how its cost per useful unit is measured.

### Guarding the buyer

The treasury takes part in the market like any other buyer and gets no special
price power:

- a **maximum willingness to pay** per class and job type, from policy and bucket
  budget, not "whatever it takes";
- **no blind outbidding**: it does not automatically beat private demand;
- **lower scheduler priority** for non-urgent public work, so normal users are
  served first (roadmap rule: user workloads outrank PrivaNet workloads);
- **pause or slow down** non-urgent public spending when the relevant class is
  scarce or expensive (severe shortage), and speed up when it is cheap;
- **separate emergency priority** only for genuine repair events, funded from the
  emergency bucket under explicit authorisation;
- resistance to **price manipulation before treasury purchases**: buying against a
  market someone just pushed up is the treasury overpaying due to artificial
  scarcity, so buying uses reference-price ceilings, thin-market protection and
  the circuit breakers described in [the market](RESOURCE_MARKET.md#price-guardrails).

This gives a natural market cycle without a hardcoded bonus: at night, compute
supply is high and the price low, so the crawl budget buys more; at peak the
price rises, and background crawling slows. The same happens across weekdays,
seasons or events, because it comes from prices and budgets rather than a
"night bonus" constant.

## PrivaSearch public crawling

Note on transfers: treasury-funded storage or repair traffic, like any paid traffic, is accounted from verified data-plane evidence and never from issued transfer authorizations ([DATA_PLANE.md](DATA_PLANE.md#10-accounting-implications-phase-7-and-later)).

The strongest expected use. PrivaSearch (Phase 3) will have two queues, both
using generic capabilities such as the constrained fetch job (`web.fetch.v1`; see [APPLICATION_BOUNDARY.md](APPLICATION_BOUNDARY.md)), and
both obeying `robots.txt`, per-host rate limits, crawl politeness,
bandwidth/resource limits, typed-job restrictions and verification/accounting
rules.

```text
PrivaSearch scheduler
      |
      +-- Demand queue  -- funded by the requester
      |       user searches, weak coverage, explicitly requested refreshes
      |
      +-- Public queue  -- funded by the Network Treasury (PrivaSearch Public Goods bucket)
              new-domain discovery, important-page recrawl, stale-page refresh,
              weak topic/domain coverage, reference/documentation sites,
              index diversity, periodic health checks
```

Before the market and treasury exist (Phase 3), the public queue simply runs on
operator-provided capacity with local limits and there is no payer. The queue
split should still be modelled in PrivaSearch from the start so the payer can be
attached later without redesign.

### Public crawl budgets

Public crawling has **no unlimited spending authority**. It draws from a budget:

```text
Public crawl budget
  Daily allocation:  configurable
  Spent today:       measured
  Remaining:         measured
  Possible sub-budgets: freshness, discovery, coverage gaps, emergency recrawl
```

The examples are not decisions and no percentages are fixed. The budget policy
is configurable, bounded, versioned, observable and auditable. A crawler bug,
runaway frontier, or compromised PrivaSearch scheduler must be unable to drain
the treasury: it can spend at most its bucket's cap for the period, at or below
the maximum price, on jobs that still have to pass verification.

Cost-effectiveness metrics (cost per useful crawled or indexed unit) feed back
into budget tuning.

## Contributor Bootstrap Program

The treasury may eventually help new contributors. It must not simply hand out
credits to anyone who installs a node; that would be farmed immediately through
account and node churn.

Preferred direction: **match or bonus verified useful contribution during a
bounded onboarding period.**

```text
Example only:  new contributor, first 30 days
  verified contribution reward:  100 credits
  treasury match:                 25 credits
  total:                         125 credits
```

Nothing here locks in numbers or durations. Candidate mechanisms:

- a percentage match on verified contribution;
- a bonus on the first N verified jobs;
- a bonus on the first N GiB-days of reliable storage;
- a bonus on useful bandwidth served;
- a bonus after completing a reliability period;
- a bounded first-period contribution multiplier.

All of them depend on **actual, verified, useful contribution** (Phase 7
verification), never on installing, enrolling or advertising capacity.

### Delayed reliability portion (research)

Part of a bootstrap reward may become available only after a bounded reliability
period:

```text
Earned bootstrap bonus:        100
Immediately available:          50
Pending reliability portion:    50
After the reliability window:  good behaviour -> release
                               severe abuse/failure -> reduce or cancel the pending part
```

Exact percentages and durations are open. Design constraints:

- a pending portion is an explicit ledger state (`CONTRIBUTOR_MATCH` pending, then
  release or cancellation), never an invisible number;
- ordinary expected shutdowns must **not** be punished: graceful `DRAINING` to
  `OFFLINE_EXPECTED` and owner-scheduled offline time (see
  [resources](RESOURCES.md)) count differently from unexplained disappearance;
- cancellation is for severe abuse or repeated failure, not for a laptop that was
  closed overnight;
- the rule and the version it was earned under are disclosed to the contributor.

### Onboarding abuse

Threats: many fake accounts; repeated reinstall or re-enrollment; node identity
cycling; contributing briefly just to claim a bonus; fake jobs between colluding
accounts; Sybil nodes; self-dealing resource requests.

Possible mitigations (research, none implemented): one bootstrap program per
verified account-to-node relationship; delayed vesting; a minimum reliability
period; contribution verification and rate limits; a bounded lifetime onboarding
subsidy per account and globally per period; and anti-Sybil controls during
public rollout (Phase 10). The bootstrap budget bucket is finite, so even
successful farming is bounded by that bucket. **Do not build a fragile
identity/KYC system just for this**; prefer economic bounds and verified
contribution over identity claims. Bonuses matched against consumer-paid
settlements are safer than bonuses matched against treasury-funded jobs, since
the latter could let colluders convert public spend into bootstrap matches (rule:
treasury-paid work should not itself trigger treasury match).

## Network maintenance and emergency reserve

The treasury may pay for work that keeps PrivaNet healthy rather than serving one
user: integrity verification, storage challenge jobs, index maintenance, emergency
storage repair, metadata repair and replication, coordinator maintenance jobs,
future shared-service health tasks. Each needs its own budget and policy inside
the Network Maintenance bucket, and each is a normal typed job.

The **Emergency Reserve** covers temporary storage-repair shortages, temporary
bandwidth shortages during recovery, urgent index recovery and infrastructure
restoration. Emergency spending is bounded, explicitly authorised by policy,
separately auditable (`EMERGENCY_RESERVE_SPEND`) and not a normal funding source.
No emergency governance process is designed here; until one exists it is an
administrator action under versioned configuration, logged with reason and
authority.

## Inflation implications

Levy-funded treasury flows are redistribution:

```text
consumer credits  ->  provider + treasury      (no credit is created)
```

So a treasury funded by the levy does not inherently inflate the credit supply.
Inflation risk comes from **issuance**: a free tier, an emergency subsidy or a
protocol subsidy. Therefore:

- any issuance is explicit, bounded, versioned, separately measured and visible in
  macroeconomic metrics;
- **minting is never hidden inside treasury operations**: `TREASURY_DEPOSIT` from a
  subsidy is issuance and is reported as such, not as levy income;
- a levy that is too high is not inflation but a *tax on providers and consumers*
  and a friction on the market, which is why it is bounded;
- a treasury that accumulates without spending is a sign that the levy is too high
  or budgets too tight; a treasury that depletes and needs subsidies is a sign of
  the opposite, and both should be visible early;
- an economy that keeps issuing credits without matching verified consumption is
  an architecture bug (same rule as [credits](CREDITS.md#credit-issuance-circulation-and-sinks)).

## Observability

Future macroeconomic metrics, aggregate-only and consistent with the market
[privacy rules](RESOURCE_MARKET.md#observability-and-history):

- treasury total balance and balance by bucket;
- levy income; public-good, contributor-bootstrap, maintenance and emergency
  spending; subsidy/minted credits, if any;
- treasury spending as a share of network resource volume;
- PrivaSearch public crawl cost and cost per useful public crawl/index unit;
- budget utilisation (spent versus cap), throttling events and circuit-breaker
  activations;
- pending and released bootstrap portions.

The purpose is to answer whether the treasury is sustainable and effective, not
to publish per-node or per-user information.

## Governance and policy

No political, token-voting or complicated governance system is designed. For the
foreseeable architecture treasury policy is **versioned PrivaNet configuration
controlled by administrators**. Important parameters (levy bounds, bucket caps,
maximum prices, bootstrap rules, emergency authorisation) are documented,
versioned and auditable, and changes never reinterpret past events. A compromised
administrative policy is a named threat (see [security](security.md#treasury-specific-threats-planned)):
policy changes need audit trails and, later, review or delay for large moves.
Community governance stays research only.

## Requirements for future implementation

Not implemented and not done yet, but required:

- ledger with **idempotent**, **transactional**, balanced entries and explicit
  budget limits (likely PostgreSQL-class transactions rather than the SQLite
  prototype);
- **policy versions** on every event and **auditable reference IDs** that tie a
  spend to its job, lease, attempt and verification;
- atomic budget reservation/decrement so races and duplicates cannot overspend or
  double pay;
- verified usage records (Phase 7) as the only trigger for any spend or match;
- a simulation harness that includes adversarial strategies against the treasury
  (fake public jobs, price pumping before purchase, onboarding farming);
- an enforced ordering rule: **no real market or treasury before PrivaNet can
  measure and verify useful resource consumption.**

## Unresolved research questions

- What levy rate range is workable, and is it flat, per class or graduated?
  Should treasury-paid settlements pay it?
- Which buckets and sub-budgets are right, and how are allocations between them
  set and rebalanced without a governance process?
- Who is the payer authority for public-good jobs: the application that submits
  them (for example a PrivaSearch service credential with a bucket) or the
  Coordinator? How are public-good jobs distinguished on the wire?
- How is a public job's maximum willingness to pay derived, and how does it relate
  to the reference price and thin-market fallbacks?
- What should scarcity throttling look like (a price ceiling, a budget slope, both)?
- How is the value of public crawl/index work measured (coverage, freshness,
  diversity, cost per useful unit)?
- What is the right bootstrap shape (match, first-N-jobs bonus, multiplier), how
  long is the onboarding window, and how much vests later? How is a contributor
  bounded against churn without a fragile identity system?
- How is a genuine emergency defined and authorised without a governance system?
- How large should the emergency reserve be relative to network volume?
- Where is the line between ordinary expiry of disclosed promotional credits and
  unacceptable confiscation?
- What minimum network size makes a treasury meaningful, and what happens below it
  (probably: off, operator-funded public work)?
