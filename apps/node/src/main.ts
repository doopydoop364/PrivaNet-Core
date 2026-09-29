import { PrivaNode } from './daemon.js';
import { loadConfig } from './config.js';
async function main() {
  const config = loadConfig(); delete process.env.PRIVANODE_ENROLLMENT_TOKEN;
  const node = new PrivaNode({ ...config, log: entry => console.log(JSON.stringify(entry)) });
  const abort = new AbortController();
  process.once('SIGINT', () => abort.abort()); process.once('SIGTERM', () => abort.abort());
  await node.run(abort.signal);
}
main().catch(() => { console.error(JSON.stringify({ event: 'node.startup_failed' })); process.exitCode = 1; });
