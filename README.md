# PrivaNet Core Foundation

PrivaNet supplies shared infrastructure to separate self-hosted applications.
This foundation (v0.2.1) runs a Coordinator and operator-controlled PrivaNode, with
an application SDK and **only** two harmless diagnostic jobs: `system.echo.v1` and the CPU-bound, checkpointable `system.hashchain.v1`.

Every job, including on one machine, follows:

**Application → SDK → Coordinator → authenticated node → registered handler → result.**

No search engine, distributed storage, credits, generic compute or remote shell
is implemented. No application/local execution bypass exists.

## Status and limits

Version **0.2.1**: Phase 1 (Core Foundation) and Phase 2 (Adaptive Resource Engine) are complete; see the [roadmap](ROADMAP.md). This is a small, operator-run control plane, **not** a production-ready or community-ready network.

| State | What |
| --- | --- |
| Implemented and tested (CI on Linux, macOS, Windows; Node 24 and 26) | Coordinator, PrivaNode, SDK, Ed25519 identity and enrollment, scoped applications, typed jobs (`system.echo.v1`, `system.hashchain.v1`), scheduler, leases with fencing and renewal, retries, retention and queue quota, SQLite persistence, backup, owner resource policy, adaptive memory/CPU/disk/network budgets, schedules, preemption and release, node-local checkpoint/resume, graceful draining (`DRAINING` to `OFFLINE_EXPECTED`) |
| Partially tested | Disk and network load sampling (Linux only, parsers unit-tested); macOS and Windows battery probes (parsers unit-tested, not run on real portable devices); Windows console-signal drain (the `DRAIN` file path is tested on all three OSes, the signals are not); preemption and checkpointing (proven with the cooperative hash-chain job, not real application workloads); backup restore (tested on one host) |
| Planned, **not implemented** | PrivaSearch (Phase 3; a separate repository, not part of this one) and Core's generic web-fetch capability for it, storage (Phases 4-6), resource measurement (7), resource market and PrivaCredits (8), Network Treasury (9), community hardening (10), stable protocol (11) |
| Deliberately unsupported | Arbitrary code, shell or script execution, downloading and running code, unrestricted proxying, public enrollment |

Security caveats that remain: nodes and applications are untrusted and a node can fabricate schema-valid results (no execution attestation, no reputation); no public Sybil resistance; SQLite is a single-process prototype, not HA; no distributed-storage guarantees; no mTLS or per-message signatures; no independent security review; job data is plaintext. Details: [security](docs/security.md), [deployment](docs/deployment.md).

## Development

Node **24.4+**, npm. Current validation environment is recorded in
[the completion report](docs/implementation-report.md). No database server needed.

```bash
npm ci
npm run build
npm test
npm run test:integration
npm run lint
npm run typecheck
```

For a running demo, see [local development and operations](docs/development.md).
The SDK entry point is `@privanet/sdk`, with exported types and runtime validation.
It targets Node clients initially; browser packaging is future work.

```typescript
import { PrivaNetClient } from '@privanet/sdk';

const client = new PrivaNetClient({
  url: 'https://coordinator.example.org',
  token: process.env.PRIVANET_APP_TOKEN!,
});
const job = await client.submit('system.echo.v1', { message: 'Hello' }, 'example-request-1');
const result = await client.waitForResult(job.id);
```

Keep the idempotency key across submission retries. Each application has its own
credential and allowed job types; applications receive no admin/node privileges.

- [Architecture, repository boundaries and ADR](docs/architecture.md)
- [Protocol, node lifecycle, jobs and leases](docs/protocol.md)
- [Threat model, privacy and security limits](docs/security.md)
- [Development, configuration and recovery](docs/development.md)
- [Deployment: TLS, reverse proxy, backup and recovery](docs/deployment.md)
- [Application boundary: what Core owns and what applications own (ADR 005, accepted)](docs/APPLICATION_BOUNDARY.md)
- [PrivaSearch integration contract](docs/PRIVASEARCH_INTEGRATION.md)
- [Control plane and data plane (ADR 006, design only)](docs/DATA_PLANE.md): the Coordinator authorizes and schedules; large payloads will move directly between authorized participants
- [Roadmap](docs/roadmap.md), [package installation and publishing](docs/PACKAGES.md)
- [Resource market design (planned)](docs/RESOURCE_MARKET.md), [PrivaCredits (planned)](docs/CREDITS.md), [Network Treasury (planned)](docs/TREASURY.md), [adaptive resources](docs/RESOURCES.md)
- [Implementation and verification report](docs/implementation-report.md)

Runtime state belongs in ignored `var/`, protected with private permissions.
Never commit identities, credentials, runtime databases or generated build output.
