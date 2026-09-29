import { Transport } from '@privanet/shared';
import { AckSchema, AppCredentialSchema, EnrollmentTokenSchema, IdSchema, NodeIdSchema, NodesSchema } from '@privanet/protocol';

async function main() {
  const transport = new Transport({ url: process.env.PRIVANET_COORDINATOR_URL ?? 'http://127.0.0.1:4010', allowInsecureLoopback: process.env.PRIVANODE_ALLOW_INSECURE_LOOPBACK === 'true' });
  const token = process.env.PRIVANET_ADMIN_SECRET;
  if (!token || !/^[a-f0-9]{64}$/.test(token)) throw new Error('Admin credential required');
  const [operation, value] = process.argv.slice(2);
  let result;
  if (operation === 'enrollment') result = await transport.request('POST', '/v1/admin/enrollment-tokens', EnrollmentTokenSchema, { expiresInMs: 60000, capabilities: ['system.echo.v1'] }, token);
  else if (operation === 'application') result = await transport.request('POST', '/v1/admin/applications', AppCredentialSchema, { name: value ?? 'demo', allowedJobTypes: ['system.echo.v1'] }, token);
  else if (operation === 'nodes') result = await transport.request('GET', '/v1/admin/nodes', NodesSchema, undefined, token);
  else if (operation === 'revoke-node') result = await transport.request('POST', `/v1/admin/nodes/${NodeIdSchema.parse(value)}/revoke`, AckSchema, {}, token);
  else if (operation === 'revoke-application') result = await transport.request('POST', `/v1/admin/applications/${IdSchema.parse(value)}/revoke`, AckSchema, {}, token);
  else if (operation === 'rotate-application') result = await transport.request('POST', `/v1/admin/applications/${IdSchema.parse(value)}/rotate`, AppCredentialSchema, {}, token);
  else throw new Error('Usage: npm run admin -- enrollment|application [name]|nodes|revoke-node ID|revoke-application ID|rotate-application ID');
  // Explicit administrator issuance output, not a service log. Do not capture
  // enrollment/application output into a shared log or shell history.
  console.log(JSON.stringify(result));
}
main().catch(() => { console.error('Admin operation failed; check operation, credentials and Coordinator status.'); process.exitCode = 1; });
