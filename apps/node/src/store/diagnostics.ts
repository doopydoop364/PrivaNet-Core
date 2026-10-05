import { isIP } from 'node:net';
import type { ResourcePolicy } from '../resource-policy.js';
import type { Finding } from '../config-check.js';
import { transferConfig, TransferConfigError } from './transfer-config.js';
import { loadTransferTls, TransferTlsError } from './tls.js';
import { inspectReplayState } from './replay-state.js';
import { inspectReceiptState } from './receipt-queue.js';
import type { StorageStatus } from './status.js';

const messages: Record<string, string> = {
  STORE_UNSAFE: 'The local store has unsafe file/directory types, ownership or permissions. Restore trusted private state; do not clear replay or receipts to force startup.',
  IO: 'The local store could not complete filesystem I/O. Check the state volume, service-account permissions and filesystem/disk errors; committed data is not evicted to fix quota.',
  STORAGE_FILESYSTEM_UNKNOWN: 'Filesystem free space could not be measured. New writes are refused; check the mounted state volume and service-account access.',
  STORAGE_ANOMALIES: 'Unexpected or unusable store entries were detected and retained. Inspect trusted local state and backups; there is no automatic cleanup or repair.',
  STORAGE_INTEGRITY_FAILURES: 'At-rest chunk integrity failures were detected and affected reads were refused. Restore through authorized application operations; automatic replication/repair is deferred.',
  STORAGE_DISABLED: 'Storage contribution is disabled. Enable it explicitly; existing chunks are retained.',
  TRANSFER_POLICY_DISABLED: 'The direct-transfer listener is disabled. Capacity alone opens no listener.',
  TRANSFER_ENDPOINT_MISSING: 'Set storage.transfer.endpoint to the canonical HTTPS origin applications will reach.',
  TRANSFER_ENDPOINT_INVALID: 'Use a canonical HTTPS origin with no credentials, path, query or fragment.',
  TRANSFER_CERT_MISSING: 'Configure a readable transfer certificate; storage cert generate --ip ADDRESS creates a LAN certificate.',
  TRANSFER_KEY_MISSING: 'Configure the matching private key, readable only by the node service account.',
  TRANSFER_CERT_INVALID: 'The transfer certificate is not a valid X.509 certificate.',
  TRANSFER_CERT_EXPIRED: 'Renew the expired certificate and register its new identity before requesting fresh grants.',
  TRANSFER_CERT_NOT_YET_VALID: 'Check the machine clock and certificate validity period.',
  TRANSFER_CERT_UNREADABLE: 'The certificate must be a readable, bounded regular file.',
  TRANSFER_CERT_SYMLINK: 'Use a regular certificate file rather than a symbolic link.',
  TRANSFER_KEY_UNREADABLE: 'The key must be a readable, bounded regular file owned by the node service account.',
  TRANSFER_KEY_SYMLINK: 'Replace the key symlink with a private regular file.',
  TRANSFER_KEY_PERMISSIONS: 'Set private key permissions to 0600 (or stricter).',
  TRANSFER_KEY_OWNERSHIP: 'Set private key ownership to the account running PrivaNode.',
  TRANSFER_KEY_MISMATCH: 'Install a certificate and private key that belong to the same key pair.',
  TRANSFER_BIND_INVALID: 'Set the bind address to a literal IPv4 or IPv6 address.',
  TRANSFER_BIND_FAILED: 'The listener could not bind. Check that the address belongs to this host and the account may bind the port.',
  TRANSFER_PORT_IN_USE: 'Another listener occupies the transfer port. Stop it or choose another port and update the endpoint.',
  REPLAY_STATE_INVALID: 'Replay state is corrupt or unsafe. Restore trusted state; never clear it to bypass replay protection.',
  RECEIPT_STATE_INVALID: 'Receipt state is corrupt or unsafe. Restore trusted state to preserve reconciliation.',
  STORAGE_RESERVE_EXHAUSTED: 'Filesystem free space is at or below the owner reserve. Free space or explicitly change the reserve.',
  STORAGE_QUOTA_EXHAUSTED: 'Capacity is exhausted. Existing chunks are retained; new writes are refused.',
  STORAGE_OVERCOMMITTED: 'Existing and incoming bytes exceed the configured capacity. Data is retained; new writes are refused.',
  STORAGE_RESERVE_CONSTRAINED: 'The free-space reserve currently limits usable storage below the remaining configured capacity.',
  TRANSFER_ENDPOINT_BIND_DIFFERENT: 'The advertised origin differs from the bind address or port. Verify the intended LAN address, firewall or explicit forwarding; this may be intentional.',
  TRANSFER_CERT_SAN_DIFFERENT: 'The certificate SAN does not match the advertised host. Exact leaf pinning is the client identity rule; generate a matching SAN for operator tooling.',
  TRANSFER_CONFIG_INVALID: 'Check transfer port/concurrency and environment overrides with settings --json.',
};
export function storageFinding(code: string, severity: Finding['severity'] = 'error'): Finding {
  return { id: code, severity, setting: 'storage', message: messages[code] ?? `Storage diagnostic ${code}. Check storage status and the node service configuration.` };
}
export function liveStorageFindings(status: StorageStatus): Finding[] {
  const findings: Finding[] = [];
  if (!status.enabled) findings.push(storageFinding('STORAGE_DISABLED', 'info'));
  if (status.error) findings.push(storageFinding(status.error));
  if (status.enabled && status.freeBytes === null) findings.push(storageFinding('STORAGE_FILESYSTEM_UNKNOWN', 'warning'));
  if (status.anomalies) findings.push(storageFinding('STORAGE_ANOMALIES', 'warning'));
  if (status.integrityFailures) findings.push(storageFinding('STORAGE_INTEGRITY_FAILURES', 'warning'));
  for (const reason of status.reasons) findings.push({ id: `STORAGE_${reason}`, severity: 'warning', setting: 'storage', message: `Storage operations are blocked by owner state: ${reason}. Review pause, schedule, battery and contribution settings.` });
  if (status.enabled && status.freeBytes !== null && status.freeBytes <= status.reserveFreeBytes) findings.push(storageFinding('STORAGE_RESERVE_EXHAUSTED', 'warning'));
  if (status.enabled && status.committedBytes + status.incomingBytes >= status.maxBytes) findings.push(storageFinding('STORAGE_QUOTA_EXHAUSTED', 'warning'));
  if (status.planning?.overcommittedBytes) findings.push(storageFinding('STORAGE_OVERCOMMITTED', 'warning'));
  if (status.planning?.reserveConstrained) findings.push(storageFinding('STORAGE_RESERVE_CONSTRAINED', 'info'));
  if (status.transfer?.error) findings.push(storageFinding(status.transfer.error, status.transfer.listener === 'DISABLED' ? 'info' : 'error'));
  const ad = status.transfer?.coordinatorAdvertisement;
  if (ad && ['REJECTED', 'UNSUPPORTED', 'UNREACHABLE'].includes(ad)) findings.push({ id: `STORAGE_COORDINATOR_${ad}`, severity: 'warning', setting: 'storage', message: ad === 'UNSUPPORTED' ? 'Coordinator rejected storage control-plane fields. Upgrade the Coordinator; compute continues.' : ad === 'UNREACHABLE' ? 'Coordinator could not be reached. Check its service, TLS trust and network; retry is automatic.' : 'Coordinator rejected the storage offer. Check endpoint identity, certificate validity and node authorization.' });
  return findings;
}
export async function storageConfigFindings(stateDir: string, policy: ResourcePolicy, env: NodeJS.ProcessEnv): Promise<Finding[]> {
  const out: Finding[] = [];
  if (!policy.storage.enabled) out.push(storageFinding('STORAGE_DISABLED', 'info'));
  try {
    const config = transferConfig(policy, env);
    if (!config.enabled) out.push(storageFinding('TRANSFER_POLICY_DISABLED', 'info'));
    else {
      const { certificate } = await loadTransferTls(config, `node_${'00'.repeat(32)}`);
      const url = new URL(config.endpoint); const host = url.hostname.replace(/^\[|\]$/g, '');
      if (!(isIP(host) ? certificate.checkIP(host) : certificate.checkHost(host))) out.push(storageFinding('TRANSFER_CERT_SAN_DIFFERENT', 'info'));
      if (host !== config.bindAddress || Number(url.port || 443) !== config.port) out.push(storageFinding('TRANSFER_ENDPOINT_BIND_DIFFERENT', 'info'));
      out.push({ id: 'TRANSFER_CERT_VALID', severity: 'info', setting: 'storage.transfer', message: `Certificate expires ${new Date(certificate.validTo).toISOString()}. Listener startup and Coordinator acceptance do not prove remote reachability.` });
    }
  } catch (error) { out.push(storageFinding(error instanceof TransferTlsError || error instanceof TransferConfigError ? error.code : 'TRANSFER_CONFIG_INVALID')); }
  for (const [inspect, code] of [[inspectReplayState, 'REPLAY_STATE_INVALID'], [inspectReceiptState, 'RECEIPT_STATE_INVALID']] as const) {
    try { await inspect(stateDir); } catch { out.push(storageFinding(code)); }
  }
  return out;
}
