// An application on another host: submits jobs through the SDK from the staged release directory and prints a JSON summary.
// Usage: node lan-client.mjs '<spec>'   spec = { type, inputs: [], inflight, keyPrefix, timeoutMs }
// Environment: PRIVANET_RELEASE_DIR, PRIVANET_COORDINATOR_URL, PRIVANET_APP_TOKEN (and NODE_EXTRA_CA_CERTS for a private CA).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const { PrivaNetClient } = await import(pathToFileURL(join(process.env.PRIVANET_RELEASE_DIR, 'node_modules', '@privanet', 'sdk', 'dist', 'index.js')).href);
const spec = JSON.parse(process.argv[2].startsWith('@') ? readFileSync(process.argv[2].slice(1), 'utf8') : process.argv[2]); // '@path' for a spec too large for argv
const client = new PrivaNetClient({ url: process.env.PRIVANET_COORDINATOR_URL, token: process.env.PRIVANET_APP_TOKEN });
const started = Date.now(); const results = new Array(spec.inputs.length); let next = 0; let errors = 0; const times = []; const attempts = [];
async function lane() {
  for (;;) {
    const i = next++; if (i >= spec.inputs.length) return;
    const t0 = Date.now();
    try {
      const job = await client.submit(spec.type, spec.inputs[i], `${spec.keyPrefix}-${i}`);
      results[i] = await client.waitForResult(job.id, { timeoutMs: spec.timeoutMs ?? 120000 });
      times.push(Date.now() - t0);
      if (spec.attempts) attempts.push((await client.getJob(job.id)).attempts);
    } catch (error) { errors++; results[i] = { error: String(error?.code ?? error?.name ?? 'ERROR') }; }
  }
}
await Promise.all(Array.from({ length: spec.inflight ?? 8 }, lane));
times.sort((a, b) => a - b);
console.log(JSON.stringify({ results, errors, attempts, ms: Date.now() - started, p50: times[Math.floor(times.length / 2)] ?? null, p95: times[Math.floor(times.length * 0.95)] ?? null }));
