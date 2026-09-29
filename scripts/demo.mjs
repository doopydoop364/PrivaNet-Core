import { randomUUID } from 'node:crypto';
import { PrivaNetClient } from '@privanet/sdk';
async function main() {
  const token = process.env.PRIVANET_APP_TOKEN;
  if (!token) throw new Error('Application credential required');
  const client = new PrivaNetClient({ url: process.env.PRIVANET_COORDINATOR_URL ?? 'http://127.0.0.1:4010', token, allowInsecureLoopback: process.env.PRIVANODE_ALLOW_INSECURE_LOOPBACK === 'true' });
  const job = await client.submit('system.echo.v1', { message: 'Hello from PrivaNet SDK' }, randomUUID());
  const result = await client.waitForResult(job.id);
  console.log(JSON.stringify({ jobId: job.id, result }));
}
main().catch(() => { console.error('Demo failed; check application credential, Coordinator and enabled node.'); process.exitCode = 1; });
