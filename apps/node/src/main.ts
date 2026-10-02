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
import { runEnroll, runJoin } from './enroll-cli.js';
import { runDoctor } from './doctor.js';
import { LOCAL_COMMANDS, runLocal } from './local-cli.js';
import { LocalControl } from './local-control.js';
import { ResourceHistory } from './history.js';
import { LogRing } from './log-ring.js';
import { resolvePolicy } from './policy-store.js';
import { buildStatus } from './status-document.js';
import { StorageService } from './store/service.js';
import { startPanel } from './panel.js';
import { buildSupportBundle } from './support-bundle.js';
import { diagnose } from './doctor.js';
import type { PanelHandle } from './panel.js';
import { DEFAULT_PANEL_PORT } from './panel-token.js';
import { jobSlotsChoice, readLocalState } from './local-state.js';
import { gatherSettings } from './effective-settings.js';
import { checkForUpdate } from './update-check.js';
import { STATUS_FILE, STATUS_PUBLISH_MS } from './status-file.js';
import { privateDirectory, replacePrivateFile } from '@privanet/shared';
/** Exit status for a configuration problem (BSD `EX_CONFIG`): a service manager should not restart-loop on it (`RestartPreventExitStatus=78`). */
export const EXIT_CONFIG = 78;
/** Creating this file in the node's state directory asks the running node to drain (any platform; the way to do it on Windows). */
export const DRAIN_FILE = 'DRAIN';
/** Exit status when the owner asked (through the panel) for a restart: non-zero so a service manager that restarts on failure brings the node back; run by hand, it simply stops. */
export const EXIT_RESTART = 75;
async function main() {
  // `privanet-node enroll ...` enrolls this machine and exits; anything else starts the node.
  if (process.argv[2] === 'doctor') {
    process.exitCode = await runDoctor(process.argv.slice(3), process.env, { out: text => process.stdout.write(text), err: text => process.stderr.write(text) });
    return;
  }
  if ((LOCAL_COMMANDS as readonly string[]).includes(process.argv[2] ?? '')) {
    process.exitCode = await runLocal(process.argv[2] ?? '', process.argv.slice(3), process.env, { out: text => process.stdout.write(text), err: text => process.stderr.write(text) });
    return;
  }
  if (process.argv[2] === 'enroll' || process.argv[2] === 'join') {
    const io = { out: (text: string) => process.stdout.write(text), err: (text: string) => process.stderr.write(text), readStdin: () => readFileSync(0, 'utf8') };
    process.exitCode = await (process.argv[2] === 'enroll' ? runEnroll : runJoin)(process.argv.slice(3), process.env, io);
    return;
  }
  let loaded: ReturnType<typeof loadConfig>;
  try { loaded = loadConfig(); } catch (error) {
    // Names of the offending settings only, never their values (one of them is the enrollment token).
    const settings = error instanceof ZodError ? [...new Set(error.issues.map(issue => String(issue.path[0] ?? '')))] : undefined;
    console.error(JSON.stringify({ event: 'node.config_invalid', ...(settings ? { settings } : {}) })); process.exitCode = EXIT_CONFIG; return;
  }
  const { policy: installedPolicy, drainTimeoutMs, ...config } = loaded; delete process.env.PRIVANODE_ENROLLMENT_TOKEN;
  const logs = new LogRing();
  const log = (entry: { event: string; code?: string; reason?: string }) => { logs.push(entry); console.log(JSON.stringify(entry)); };
  // The owner's saved policy (from the panel or `policy import`) wins over the installer's file while it is good; a damaged or newer one is not applied and not overwritten.
  const resolved = await resolvePolicy(config.stateDir, process.env.PRIVANODE_POLICY_FILE, { locked: process.env.PRIVANODE_POLICY_LOCKED === 'true' }).catch(() => ({ policy: installedPolicy, source: { kind: 'defaults' } as const }));
  const policy = resolved.policy;
  if ('problem' in resolved && resolved.problem) log({ event: 'node.policy_invalid', code: resolved.problem.code });
  const transfer = new TransferMeter({ stateDir: config.stateDir, ratePerSec: policy.maxBandwidthBytesPerSec, monthlyBytes: policy.monthlyTransferBytes });
  const checkpoints = new CheckpointStore(join(config.stateDir, 'checkpoints'));
  // The fetch capability is only usable through this wiring, with the owner's policy applied.
  if (policy.fetch.unsafeLocal) log({ event: 'fetch.unsafe_local_enabled' });
  const handlers = { ...defaultHandlers, 'web.fetch.v1': createFetchHandler({ policy: policy.fetch }) };
  const engine = new ResourceEngine(policy, new OsSampler(config.stateDir), Date.now, transfer);
  // Job slots: an explicit PRIVANODE_JOB_SLOTS wins; otherwise the owner's saved choice (panel or `privanet-node slots`); they apply at start, so this is read before the node is built.
  const earlyLocal = await readLocalState(config.stateDir);
  const slots = jobSlotsChoice(config.jobSlots, process.env.PRIVANODE_JOB_SLOTS !== undefined, earlyLocal.kind === 'error' ? undefined : earlyLocal.state.jobSlots);
  const node = new PrivaNode({ ...config, jobSlots: slots.value, handlers, engine, transfer, checkpoints, log });
  const history = new ResourceHistory(config.stateDir);
  // The local chunk store (off unless the owner enables it): a library inside this process, with no network or Coordinator interface in this version.
  const storage = new StorageService({ stateDir: config.stateDir, policy: () => control.view.policy ?? resolved.policy, inputs: { draining: () => node.snapshot.draining, engine }, log });
  const control = new LocalControl({ stateDir: config.stateDir, envPolicyFile: process.env.PRIVANODE_POLICY_FILE, node, engine, transfer, history, log, jobSlots: { running: slots.value, fromEnvironment: slots.source === 'environment' }, policyLocked: process.env.PRIVANODE_POLICY_LOCKED === 'true', onPolicy: policy => { void storage.apply(policy); }, onChange: () => { void publish(); } });
  // The snapshot `privanet-node status` reads: private, replaced atomically, no secrets (see status-document.ts).
  const publish = async () => {
    try { await replacePrivateFile(join(await privateDirectory(config.stateDir), STATUS_FILE), JSON.stringify({ version: 1, publishedAt: Date.now(), status: buildStatus({ node, engine, control, transfer, coordinatorUrl: config.url, enrolledCapabilities: config.capabilities, storage: storage.status }) })); } catch { /* status is a convenience */ }
  };
  await control.init(resolved); control.start(); await storage.start();
  const publisher = setInterval(() => { void publish(); }, STATUS_PUBLISH_MS); publisher.unref(); void publish();
  let restartRequested = false;
  const abort = new AbortController();
  // First request: drain (finish the current job, say goodbye). After the timeout, or on a second request, hand the job back.
  let forced: NodeJS.Timeout | undefined;
  const stop = () => {
    if (abort.signal.aborted) { node.abortNow(); return; }
    log({ event: 'node.draining' }); abort.abort(); forced = setTimeout(() => node.abortNow(), drainTimeoutMs); forced.unref();
  };
  /** The only privileged actions the local panel may trigger (named operations, never commands). */
  const actions = { drainAndStop: () => stop(), restart: () => { restartRequested = true; stop(); } };
  // The local control panel: loopback only, signed in with the token in the state directory (see panel.ts). A port that is taken never stops the node.
  let panel: PanelHandle | undefined;
  if (process.env.PRIVANODE_PANEL !== 'off') {
    const port = Number(process.env.PRIVANODE_PANEL_PORT ?? DEFAULT_PANEL_PORT);
    try {
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('bad port');
      panel = await startPanel({ stateDir: config.stateDir, port, storage, node, engine, control, transfer, history, logs, coordinatorUrl: config.url, enrolledCapabilities: config.capabilities, jobSlots: slots.value, env: process.env, actions,
        supportBundle: async () => buildSupportBundle({ env: process.env, settings: (await gatherSettings(process.env, config.stateDir, Date.now(), slots.value)).settings, storage: await storage.refresh(), policy: resolved, local: control.view.local, localProblem: control.view.localProblem, status: JSON.parse(JSON.stringify(buildStatus({ node, engine, control, transfer, coordinatorUrl: config.url, enrolledCapabilities: config.capabilities, storage: storage.status }))) as Record<string, unknown>,
          doctor: await diagnose({ url: config.url, stateDir: config.stateDir, allowInsecureLoopback: process.env.PRIVANODE_ALLOW_INSECURE_LOOPBACK === 'true', timeoutMs: 8000, env: process.env }).catch(() => undefined), logs: logs.recent(200) }), updateCheck: () => checkForUpdate() });
      log({ event: 'panel.listening', code: String(panel.port) });
    } catch { log({ event: 'panel.unavailable', code: 'LISTEN_FAILED' }); }
  }
  // POSIX: SIGTERM/SIGINT. Windows never delivers SIGTERM: Ctrl+C is SIGINT, Ctrl+Break is SIGBREAK, closing the console is SIGHUP.
  for (const signal of ['SIGINT', 'SIGTERM', ...(process.platform === 'win32' ? ['SIGBREAK', 'SIGHUP'] : [])] as const) process.on(signal, stop);
  // Portable request for a service manager or script that cannot send a signal. A stale file from while the node was down is ignored.
  const drainFile = join(config.stateDir, DRAIN_FILE);
  try { unlinkSync(drainFile); } catch { /* none */ }
  const watcher = setInterval(() => { if (existsSync(drainFile)) { try { unlinkSync(drainFile); } catch { /* removal is best effort */ } stop(); } }, 500);
  watcher.unref();
  // However the run ends (a drain, or a refusal such as a changed Coordinator binding), everything this process started must be stopped, or the panel's listener and the timers would keep it alive.
  try { await node.run(abort.signal); } finally {
    clearTimeout(forced); clearInterval(watcher); clearInterval(publisher); control.stop(); await storage.stop(); await panel?.close().catch(() => undefined);
    try { unlinkSync(join(config.stateDir, STATUS_FILE)); } catch { /* none */ }
  }
  if (restartRequested) process.exitCode = EXIT_RESTART;
}
main().catch((error: unknown) => {
  if (error instanceof BindingChangedError) { console.error(JSON.stringify({ event: 'node.coordinator_binding_changed' })); process.exitCode = EXIT_CONFIG; return; }
  console.error(JSON.stringify({ event: 'node.startup_failed' })); process.exitCode = 1;
});
