import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { PrivaNode } from './daemon.js';
import { loadConfig } from './config.js';
import { ResourceEngine } from './resource-engine.js';
import { OsSampler } from './resource-sampler.js';
import { TransferMeter } from './transfer-meter.js';
import { CheckpointStore } from './checkpoint.js';
/** Creating this file in the node's state directory asks the running node to drain (any platform; the way to do it on Windows). */
export const DRAIN_FILE = 'DRAIN';
async function main() {
  const { policy, drainTimeoutMs, ...config } = loadConfig(); delete process.env.PRIVANODE_ENROLLMENT_TOKEN;
  const log = (entry: { event: string; code?: string }) => console.log(JSON.stringify(entry));
  const transfer = new TransferMeter({ stateDir: config.stateDir, ratePerSec: policy.maxBandwidthBytesPerSec, monthlyBytes: policy.monthlyTransferBytes });
  const checkpoints = new CheckpointStore(join(config.stateDir, 'checkpoints'));
  const node = new PrivaNode({ ...config, engine: new ResourceEngine(policy, new OsSampler(config.stateDir), Date.now, transfer), transfer, checkpoints, log });
  const abort = new AbortController();
  // First request: drain (finish the current job, say goodbye). After the timeout, or on a second request, hand the job back.
  let forced: NodeJS.Timeout | undefined;
  const stop = () => {
    if (abort.signal.aborted) { node.abortNow(); return; }
    log({ event: 'node.draining' }); abort.abort(); forced = setTimeout(() => node.abortNow(), drainTimeoutMs); forced.unref();
  };
  // POSIX: SIGTERM/SIGINT. Windows never delivers SIGTERM: Ctrl+C is SIGINT, Ctrl+Break is SIGBREAK, closing the console is SIGHUP.
  for (const signal of ['SIGINT', 'SIGTERM', ...(process.platform === 'win32' ? ['SIGBREAK', 'SIGHUP'] : [])] as const) process.on(signal, stop);
  // Portable request for a service manager or script that cannot send a signal. A stale file from while the node was down is ignored.
  const drainFile = join(config.stateDir, DRAIN_FILE);
  try { unlinkSync(drainFile); } catch { /* none */ }
  const watcher = setInterval(() => { if (existsSync(drainFile)) { try { unlinkSync(drainFile); } catch { /* removal is best effort */ } stop(); } }, 500);
  watcher.unref();
  await node.run(abort.signal); clearTimeout(forced); clearInterval(watcher);
}
main().catch(() => { console.error(JSON.stringify({ event: 'node.startup_failed' })); process.exitCode = 1; });
