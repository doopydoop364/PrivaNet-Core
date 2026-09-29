# Roadmap

| Version | Scope |
| --- | --- |
| v0.1 Core Foundation | Coordinator/node/protocol/SDK, identity/enrollment/auth, scoped apps, capabilities/health, echo typed jobs, scheduler, leases, SQLite, tests/docs |
| v0.2 Job Infrastructure | Scheduling, limits, queues, observability, backoff/retries, cancellation, operator config and administration |
| v0.3 PrivaSearch Integration | Separate search project consumes crawl/parse/index typed workers with resource controls |
| v0.4 Storage Foundation | Generic object/chunk APIs; no Drive metadata |
| v0.5 Distributed Storage | Placement, replication, repair, verification, actual physical accounting, failures |
| v0.6 PrivaDrive Integration | Replace Drive physical storage adapter with PrivaNet SDK; Drive retains metadata/encryption/sharing |
| v0.7 Resource Accounting | Measure useful storage, served bandwidth and verified jobs; never reward just advertised resources |
| v0.8 PrivaCredits | Append-only integer ledger, idempotent transactions, versioned policy, reference/reason, rewards/charges/allowance/dashboard; no cryptocurrency |
| v0.9 Community Hardening | Public enrollment, abuse/Sybil resistance, reputation, security and tooling |
| v1.0 Stable PrivaNet | Compatibility guarantees, migrations, upgrade/recovery, operations, docs and independent security review |

Only v0.1 is implemented here. No speculative storage/credits interfaces. Before
production release of v0.1: test target Node/OS matrix, review TLS deployment and
Windows ACL handling, exercise backup/recovery, review security independently.
