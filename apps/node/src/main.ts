import { PrivaNode } from './daemon.js';
import { loadConfig } from './config.js';
import { ResourceEngine } from './resource-engine.js';
import { OsSampler } from './resource-sampler.js';
async function main() {
  const { policy, drainTimeoutMs, ...config } = loadConfig(); delete process.env.PRIVANODE_ENROLLMENT_TOKEN;
  const log = (entry: { event: string; code?: string }) => console.log(JSON.stringify(entry));
  const node = new PrivaNode({ ...config, engine: new ResourceEngine(policy, new OsSampler()), log });
  const abort = new AbortController();
  // First signal: drain (finish the current job, say goodbye). After the timeout, or on a second signal, hand the job back.
  let forced: NodeJS.Timeout | undefined;
  const stop = () => {
    if (abort.signal.aborted) { node.abortNow(); return; }
    log({ event: 'node.draining' }); abort.abort(); forced = setTimeout(() => node.abortNow(), drainTimeoutMs); forced.unref();
  };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  await node.run(abort.signal); clearTimeout(forced);
}
main().catch(() => { console.error(JSON.stringify({ event: 'node.startup_failed' })); process.exitCode = 1; });
