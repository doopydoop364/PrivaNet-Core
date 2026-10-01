# PrivaNet Core Foundation

PrivaNet supplies shared infrastructure to separate self-hosted applications.
PrivaNet (v0.3.0-alpha.6) runs a Coordinator and operator-controlled PrivaNodes, with an application SDK and three typed jobs:
two harmless diagnostics (`system.echo.v1`, the CPU-bound, checkpointable `system.hashchain.v1`) and the constrained, SSRF-guarded `web.fetch.v1`
that the separate PrivaSearch application uses.

Every job, including on one machine, follows:

**Application → SDK → Coordinator → authenticated node → registered handler → result.**

No search engine, distributed storage, credits, generic compute or remote shell
is implemented. No application/local execution bypass exists.

## Status and limits

Version **0.3.0-alpha.6**: Phase 1 (Core Foundation) and Phase 2 (Adaptive Resource Engine) are complete, and Phase 3's Core side (`web.fetch.v1`, multi-slot nodes, waiting leases) is implemented and measured; see the [roadmap](ROADMAP.md). Trusted multi-node operation and a separate-host LAN deployment are validated ([multi-node](docs/MULTI_NODE_VALIDATION.md), [deployment](docs/DEPLOYMENT_VALIDATION.md)); first-deployment steps: [FIRST_DEPLOYMENT.md](docs/FIRST_DEPLOYMENT.md). This is a small, operator-run control plane, **not** a production-ready or community-ready network.

| State | What |
| --- | --- |
| Implemented and tested (CI on Linux, macOS, Windows; Node 24 and 26) | Coordinator, PrivaNode, SDK, Ed25519 identity and enrollment, scoped applications, typed jobs (`system.echo.v1`, `system.hashchain.v1`, `web.fetch.v1`), scheduler with lease and job waits, multi-slot nodes, leases with fencing and renewal, retries, retention and queue quota, SQLite persistence, backup, owner resource policy, adaptive memory/CPU/disk/network budgets, schedules, preemption and release, node-local checkpoint/resume, graceful draining (`DRAINING` to `OFFLINE_EXPECTED`) |
| Partially tested | Disk and network load sampling (Linux only, parsers unit-tested); macOS and Windows battery probes (parsers unit-tested, not run on real portable devices); Windows console-signal drain (the `DRAIN` file path is tested on all three OSes, the signals are not); preemption and checkpointing (proven with the cooperative hash-chain job, not real application workloads); backup restore (tested on one host) |
| Planned, **not implemented** | PrivaSearch itself (a separate repository, never part of this one), storage (Phases 4-6), resource measurement (7), resource market and PrivaCredits (8), Network Treasury (9), community hardening (10), stable protocol (11) |
| Deliberately unsupported | Arbitrary code, shell or script execution, downloading and running code, unrestricted proxying, public enrollment |

Security caveats that remain: nodes and applications are untrusted and a node can fabricate schema-valid results (no execution attestation, no reputation); no public Sybil resistance; SQLite is a single-process prototype, not HA; no distributed-storage guarantees; no mTLS or per-message signatures; no independent security review; job data is plaintext. Details: [security](docs/security.md), [deployment](docs/deployment.md).

## License

PrivaNet-Core is licensed under the [Apache License, Version 2.0](LICENSE) (`Apache-2.0`). This covers the code in this repository, including the published `@privanet/protocol`, `@privanet/shared` and `@privanet/sdk` packages, which each ship the license text. Third-party dependencies keep their own licenses; nothing here relicenses them.

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
Install it from npm (`npm install @privanet/sdk@next` while PrivaNet-Core is a pre-release; pin the exact version in an application). The Coordinator and PrivaNode are not npm packages; they come from the release archives. See [package installation](docs/PACKAGES.md).
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
- [First deployment: server Coordinator, desktop worker (step by step)](docs/FIRST_DEPLOYMENT.md)
- [Deployment validation: separate-host evidence, security review, readiness verdict](docs/DEPLOYMENT_VALIDATION.md)
- [Remote node onboarding: enrollment tokens, `privanet-node enroll`, the node registry](docs/ONBOARDING.md)
- [Deployment: TLS, reverse proxy, backup and recovery](docs/deployment.md)
- [Trusted multi-node validation: scenarios, findings, measurements](docs/MULTI_NODE_VALIDATION.md)
- [Application boundary: what Core owns and what applications own (ADR 005, accepted)](docs/APPLICATION_BOUNDARY.md)
- [PrivaSearch integration contract](docs/PRIVASEARCH_INTEGRATION.md)
- [Control plane and data plane (ADR 006, design only)](docs/DATA_PLANE.md): the Coordinator authorizes and schedules; large payloads will move directly between authorized participants
- [Roadmap](docs/roadmap.md), [package installation and publishing](docs/PACKAGES.md)
- [Resource market design (planned)](docs/RESOURCE_MARKET.md), [PrivaCredits (planned)](docs/CREDITS.md), [Network Treasury (planned)](docs/TREASURY.md), [adaptive resources](docs/RESOURCES.md)
- [Implementation and verification report](docs/implementation-report.md)

Runtime state belongs in ignored `var/`, protected with private permissions.
Never commit identities, credentials, runtime databases or generated build output.
