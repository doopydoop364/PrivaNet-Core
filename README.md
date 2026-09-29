# PrivaNet Core Foundation

PrivaNet supplies shared infrastructure to separate self-hosted applications.
This v0.1 foundation runs a Coordinator and operator-controlled PrivaNode, with
an application SDK and **only** the harmless `system.echo.v1` job.

Every job, including on one machine, follows:

**Application → SDK → Coordinator → authenticated node → registered handler → result.**

No search engine, distributed storage, credits, generic compute or remote shell
is implemented. No application/local execution bypass exists.

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
- [Roadmap](docs/roadmap.md)
- [Resource market design (planned)](docs/RESOURCE_MARKET.md), [PrivaCredits (planned)](docs/CREDITS.md), [adaptive resources](docs/RESOURCES.md)
- [Implementation and verification report](docs/implementation-report.md)

Runtime state belongs in ignored `var/`, protected with private permissions.
Never commit identities, credentials, runtime databases or generated build output.
