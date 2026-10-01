import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { PrivaNode } from './daemon.js';
import { loadConfig } from './config.js';
import { ResourceEngine } from './resource-engine.js';
import { OsSampler } from './resource-sampler.js';
import { TransferMeter } from './transfer-meter.js';
import { CheckpointStore } from './checkpoint.js';
import { defaultHandlers } from './handlers.js';
import { createFetchHandler } from './fetch/handler.js';
import { BindingChangedError } from './identity.js';
import { ZodError } from 'zod';
import { readFileSync } from 'node:fs';
import { runEnroll } from './enroll-cli.js';
/** Exit status for a configuration problem (BSD `EX_CONFIG`): a service manager should not restart-loop on it (`RestartPreventExitStatus=78`). */
export const EXIT_CONFIG = 78;
/** Creating this file in the node's state directory asks the running node to drain (any platform; the way to do it on Windows). */
export const DRAIN_FILE = 'DRAIN';
async function main() {
  // `privanet-node enroll ...` enrolls this machine and exits; anything else starts the node.
  if (process.argv[2] === 'enroll') {
    process.exitCode = await runEnroll(process.argv.slice(3), process.env, { out: text => process.stdout.write(text), err: text => process.stderr.write(text), readStdin: () => readFileSync(0, 'utf8') });
    return;
  }
  let loaded: ReturnType<typeof loadConfig>;
  try { loaded = loadConfig(); } catch (error) {
    // Names of the offending settings only, never their values (one of them is the enrollment token).
    const settings = error instanceof ZodError ? [...new Set(error.issues.map(issue => String(issue.path[0] ?? '')))] : undefined;
    console.error(JSON.stringify({ event: 'node.config_invalid', ...(settings ? { settings } : {}) })); process.exitCode = EXIT_CONFIG; return;
  }
  const { policy, drainTimeoutMs, ...config } = loaded; delete process.env.PRIVANODE_ENROLLMENT_TOKEN;
  const log = (entry: { event: string; code?: string }) => console.log(JSON.stringify(entry));
  const transfer = new TransferMeter({ stateDir: config.stateDir, ratePerSec: policy.maxBandwidthBytesPerSec, monthlyBytes: policy.monthlyTransferBytes });
  const checkpoints = new CheckpointStore(join(config.stateDir, 'checkpoints'));
  // The fetch capability is only usable through this wiring, with the owner's policy applied.
  if (policy.fetch.unsafeLocal) log({ event: 'fetch.unsafe_local_enabled' });
  const handlers = { ...defaultHandlers, 'web.fetch.v1': createFetchHandler({ policy: policy.fetch }) };
  const node = new PrivaNode({ ...config, handlers, engine: new ResourceEngine(policy, new OsSampler(config.stateDir), Date.now, transfer), transfer, checkpoints, log });
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
main().catch((error: unknown) => {
  if (error instanceof BindingChangedError) { console.error(JSON.stringify({ event: 'node.coordinator_binding_changed' })); process.exitCode = EXIT_CONFIG; return; }
  console.error(JSON.stringify({ event: 'node.startup_failed' })); process.exitCode = 1;
});
