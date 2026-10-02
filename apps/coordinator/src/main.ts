import { join } from 'node:path';
import { hash, privateDirectory } from '@privanet/shared';
import { loadConfig } from './config.js';
import { Coordinator } from './service.js';
import { SqliteStore } from './store.js';
import { createCoordinatorServer } from './server.js';
import { KeyringError, TransferKeyring } from './transfer-keys.js';
import { ZodError } from 'zod';
/** Exit status for a configuration problem (BSD `EX_CONFIG`): a service manager should not restart-loop on it (`RestartPreventExitStatus=78`). */
const EXIT_CONFIG = 78;
async function main() {
  let config: ReturnType<typeof loadConfig>;
  try { config = loadConfig(); }
  catch (error) {
    // Names of the offending settings only, never their values (one of them is the admin secret).
    const settings = error instanceof ZodError ? [...new Set(error.issues.map(issue => String(issue.path[0] ?? '')))] : undefined;
    console.error(JSON.stringify({ event: 'coordinator.config_invalid', ...(settings ? { settings } : { hint: 'PRIVANET_HOST is not loopback: set PRIVANET_TLS_TERMINATED=true only when a TLS proxy is in front' }) }));
    process.exitCode = EXIT_CONFIG; return;
  }
  const directory = await privateDirectory(config.dataDir);
  const store = new SqliteStore(join(directory, 'coordinator.sqlite'));
  // Invite codes are short, so the hashes that protect them are keyed with something that is not in the database: derived from the administrator secret.
  const log = (entry: { event: string; code?: string }) => console.log(JSON.stringify(entry));
  // The ticket-signing keyring is its own private file next to (never inside) the database. An unusable one is reported by a fixed code and storage stays off; it is never silently replaced, and jobs are unaffected.
  let transferKeys: TransferKeyring | undefined;
  try { transferKeys = await TransferKeyring.open(directory); } catch (error) { log({ event: 'storage.keyring_unusable', code: error instanceof KeyringError ? error.code : 'KEYRING_IO' }); }
  const core = new Coordinator(store, config.policy, Date.now, undefined, { inviteKey: Buffer.from(hash(`privanet.invite-key.v1:${config.adminSecret}`), 'hex'), storageLimits: config.storageLimits, ...(transferKeys ? { transferKeys } : {}) });
  const server = createCoordinatorServer(core, { adminSecret: config.adminSecret, log, authRequestsPerMinute: config.authRequestsPerMinute, enrollmentFailuresPerMinute: config.enrollmentFailuresPerMinute, inviteFailuresPerMinute: config.inviteFailuresPerMinute, trustLoopbackProxy: config.trustLoopbackProxy });
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(config.port, config.host, resolve); });
  } catch (error) { store.close(); throw error; }
  core.maintain();
  const maintenance = setInterval(() => { try { core.maintain(); } catch { log({ event: 'maintenance.failed' }); } }, config.maintenanceMs);
  log({ event: 'coordinator.started' });
  let stopping = false;
  const stop = () => {
    if (stopping) return; stopping = true; clearInterval(maintenance);
    const deadline = setTimeout(() => server.closeAllConnections(), 5000);
    server.close(() => { clearTimeout(deadline); store.close(); log({ event: 'coordinator.stopped' }); });
    server.closeIdleConnections();
  };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}
main().catch(() => { console.error(JSON.stringify({ event: 'coordinator.startup_failed' })); process.exitCode = 1; });
