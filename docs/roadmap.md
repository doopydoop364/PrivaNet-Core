# Roadmap

| Version | Scope |
| --- | --- |
| v0.1 Core Foundation | Coordinator/node/protocol/SDK, identity/enrollment/auth, scoped apps, capabilities/health, echo typed jobs, scheduler, leases, SQLite, tests/docs |
| v0.2 Adaptive Resource Engine | Owner resource policy, adaptive memory/CPU/disk/network budgets, schedules, battery policy, resource-aware scheduling, preemption, checkpoint/resume, graceful draining (complete in v0.2.1) |
| v0.3 PrivaSearch Integration | Separate search project consumes crawl/parse/index typed workers with resource controls |
| v0.4 Storage Foundation | Generic object/chunk APIs; no Drive metadata |
| v0.5 Distributed Storage | Placement, replication, repair, verification, actual physical accounting, failures |
| v0.6 PrivaDrive Integration | Replace Drive physical storage adapter with PrivaNet SDK; Drive retains metadata/encryption/sharing |
| v0.7 Resource Measurement/Accounting | Measure and verify useful storage, served bandwidth and jobs with versioned units and per-attempt usage records; never reward just advertised resources; no market on unverified claims |
| v0.8 Resource Market + PrivaCredits | Per-class markets with asks, demand and clearing prices, separate from the scheduler; append-only balanced integer ledger, idempotent settlement, versioned policy, price guardrails, bounded free allowance; PrivaCredits stay internal (no cryptocurrency, no external trading). Research and simulation first: see RESOURCE_MARKET.md |
| v0.9 Network Treasury + Public Goods | Internal Network Treasury (not an investment fund) funded by a bounded, versioned, visible levy on settlements; budget buckets; treasury-paid public-good jobs such as PrivaSearch public crawling; contributor bootstrap matching verified contribution; maintenance and emergency reserve. Research and documentation first: see TREASURY.md |
| v0.10 Community Hardening | Public enrollment, abuse/Sybil resistance, reputation, security and tooling |
| v1.0 Stable PrivaNet | Compatibility guarantees, migrations, upgrade/recovery, operations, docs and independent security review |

Implemented here: v0.1 (Phase 1) and v0.2 (Phase 2, complete in v0.2.1). Nothing from v0.3 onward exists, and there are no speculative storage, credit, market or treasury interfaces. This is not a production or community-ready release: an independent security review has not been done (Phase 11), Windows ACL handling and some OS-specific behaviour have not been validated on real hardware, and a restore rehearsal on the operator's own infrastructure is still needed. See [deployment](deployment.md) and [security](security.md).
