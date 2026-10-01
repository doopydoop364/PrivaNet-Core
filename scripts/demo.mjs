import { randomUUID } from 'node:crypto';
import { PrivaNetClient } from '@privanet/sdk';
// Submits one small job through the SDK and prints a short JSON summary.
//   Environment: PRIVANET_APP_TOKEN (required), PRIVANET_COORDINATOR_URL (default http://127.0.0.1:4010), NODE_EXTRA_CA_CERTS for a private CA.
//   Default job:  system.echo.v1 (the application credential and a node must both allow it).
//   Fetch job:    set PRIVANET_DEMO_FETCH_URL=https://example.com/ to submit web.fetch.v1 instead (needs an application credential with a fetch identity
//                 and a node enrolled for web.fetch.v1, which is what docs/FIRST_DEPLOYMENT.md sets up). Only a summary is printed, never the page text.
async function main() {
  const token = process.env.PRIVANET_APP_TOKEN;
  if (!token) throw new Error('Application credential required');
  const client = new PrivaNetClient({ url: process.env.PRIVANET_COORDINATOR_URL ?? 'http://127.0.0.1:4010', token, allowInsecureLoopback: process.env.PRIVANODE_ALLOW_INSECURE_LOOPBACK === 'true' });
  const fetchUrl = process.env.PRIVANET_DEMO_FETCH_URL;
  if (fetchUrl) {
    const job = await client.submit('web.fetch.v1', { url: fetchUrl, mode: 'DIGEST', maxTextBytes: 0, maxLinks: 0 }, randomUUID());
    const r = await client.waitForResult(job.id, { timeoutMs: 120000 });
    console.log(JSON.stringify({ jobId: job.id, outcome: r.outcome, httpStatus: r.httpStatus, finalUrl: r.finalUrl, contentType: r.contentType, bodyBytes: r.bodyBytes, robots: r.robots.verdict, durationMs: r.durationMs, error: r.error }));
    return;
  }
  const job = await client.submit('system.echo.v1', { message: 'Hello from PrivaNet SDK' }, randomUUID());
  const result = await client.waitForResult(job.id);
  console.log(JSON.stringify({ jobId: job.id, result }));
}
main().catch(error => {
  // Only a fixed-vocabulary error code is shown (for example JOB_TYPE_FORBIDDEN or FETCH_IDENTITY_REQUIRED), never a message, address or credential.
  const code = typeof error?.code === 'string' && /^[A-Z][A-Z_]{2,40}$/.test(error.code) ? ` (${error.code})` : '';
  console.error(`Demo failed${code}; check the application credential, the Coordinator and an enabled node.`);
  process.exitCode = 1;
});
