# Roadmap

| Version | Scope |
| --- | --- |
| v0.1 Core Foundation | Coordinator/node/protocol/SDK, identity/enrollment/auth, scoped apps, capabilities/health, echo typed jobs, scheduler, leases, SQLite, tests/docs |
| v0.2 Job Infrastructure | Scheduling, limits, queues, observability, backoff/retries, cancellation, operator config and administration |
| v0.3 PrivaSearch Integration | Separate search project consumes crawl/parse/index typed workers with resource controls |
| v0.4 Storage Foundation | Generic object/chunk APIs; no Drive metadata |
| v0.5 Distributed Storage | Placement, replication, repair, verification, actual physical accounting, failures |
| v0.6 PrivaDrive Integration | Replace Drive physical storage adapter with PrivaNet SDK; Drive retains metadata/encryption/sharing |
| v0.7 Resource Measurement/Accounting | Measure and verify useful storage, served bandwidth and jobs with versioned units and per-attempt usage records; never reward just advertised resources; no market on unverified claims |
| v0.8 Resource Market + PrivaCredits | Per-class markets with asks, demand and clearing prices, separate from the scheduler; append-only balanced integer ledger, idempotent settlement, versioned policy, price guardrails, bounded free allowance; PrivaCredits stay internal (no cryptocurrency, no external trading). Research and simulation first: see RESOURCE_MARKET.md |
| v0.9 Community Hardening | Public enrollment, abuse/Sybil resistance, reputation, security and tooling |
| v1.0 Stable PrivaNet | Compatibility guarantees, migrations, upgrade/recovery, operations, docs and independent security review |

Only v0.1 is implemented here. No speculative storage/credits interfaces. Before
production release of v0.1: review TLS deployment and
Windows ACL handling, exercise backup/recovery, review security independently.
