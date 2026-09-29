# Security and privacy

## Implemented boundaries

Nodes and applications are untrusted. Strict allowlists and exact schemas bound
inputs. Node code contains one fixed echo handler, never a shell or interpreter.
Echo strings remain data even when they look like commands. Both Coordinator
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

## Coordinator knowledge

The Coordinator learns node public key/stable ID, daemon/protocol version,
capabilities, heartbeat receipt times, workload/slot counts, job payloads/results
and app ownership, plus (v0.2) the node's lifecycle and its resource report: coarse contribution/pressure/power states and the permitted memory/CPU budget. Network peers/reverse proxies inherently see addresses and
timing. SQLite grants/sessions contain hashes, not originals. No telemetry,
third-party analytics, host inventory or raw resource metrics. Raw memory/CPU samples are read locally to compute the budget and are never transmitted or stored. Power state is read from the OS power-supply files on Linux only.
Echo input/output is plaintext and retained with job state. Use synthetic data;
this milestone supplies neither job encryption nor retention automation.
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

## Limits and threats left open

A stolen grant can enroll the thief before the owner; restrict grant capability,
shorten expiry and transmit via a safe channel. A stolen node private key permits
authentication until revoked. A stolen session permits its node role until
expiry/revocation. A stolen app/admin secret permits its scope until revoked or
admin bootstrap rotated/restarted. This is not mTLS or per-message signatures.
Credential rotation uses session refresh, in-place app credential rotation, app revoke/reissue and node revoke/
new enrollment. There is no administrator account/SSO system or key recovery.

A node can lie about its budget or state (for example claim spare RAM it lacks, or claim `DRAINING`/goodbye to shed work); v0.2 does not verify or penalise this, and there is no reputation. The budget is a scheduling hint that protects honest owners, not a guarantee against a malicious node. Owner limits are enforced on the node, and a compromised node is not bound by them. Nothing forces a running handler to stop except its own cooperation with the abort signal; the echo handler is instantaneous and preemption is untested against real long-running work. A dishonest node can fabricate schema-valid echo output; no execution attestation
or reputation. At-least-once execution can repeat future side effects. SQLite
is a single-process prototype, not HA. Job queues/results persist without an
automatic retention quota; authorized apps can consume storage. Production needs
quotas, audit/retention policies, backup/recovery exercises and a security review.
No public/community enrollment, Sybil resistance, economic rewards, storage
integrity/durability, malicious-worker isolation, filesystem sandbox, arbitrary
compute or distributed trust guarantees are claimed. Future handlers require
individual threat review/resource bounds. Do not deploy community infrastructure
on the strength of this demo.
