import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { mkdtemp, chmod, rename, rm, open } from 'node:fs/promises';
import { privateDirectory } from '@privanet/shared';
import { loadTransferTls } from './tls.js';
import type { ResourcePolicy } from '../resource-policy.js';
import { PolicyError } from '../policy-store.js';
const run = promisify(execFile);
/** Node-local P-256 SAN certificate. Publish a whole versioned directory atomically, retaining all previous keys on renewal. */
export async function generateStorageCertificate(stateDir: string, ip: string, policy: ResourcePolicy, renew = false) {
  if (!isIP(ip)) throw new PolicyError('POLICY_FILE_INVALID', ['--ip needs a literal IPv4 or IPv6 address']);
  if ((policy.storage.transfer.keyFile || policy.storage.transfer.certificateFile) && !renew) throw new PolicyError('POLICY_FILE_INVALID', ['A key/certificate is configured; use --renew to create a new version. Existing files are retained.']);
  const directory = await privateDirectory(stateDir);
  const temporary = await mkdtemp(join(directory, '.transfer-tls-')); await chmod(temporary, 0o700);
  const target = join(directory, `transfer-tls-${temporary.split('-').at(-1)}`);
  let published = false;
  try {
    await run('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-sha256', '-days', '365', '-subj', '/CN=PrivaNode transfer', '-addext', `subjectAltName=IP:${ip}`, '-keyout', join(temporary, 'key.pem'), '-out', join(temporary, 'certificate.pem')], { timeout: 10000, maxBuffer: 16384, windowsHide: true });
    await chmod(join(temporary, 'key.pem'), 0o600); await chmod(join(temporary, 'certificate.pem'), 0o600);
    for (const name of ['key.pem', 'certificate.pem']) { const file = await open(join(temporary, name), 'r'); try { await file.sync(); } finally { await file.close(); } }
    if (process.platform !== 'win32') { const folder = await open(temporary, 'r'); try { await folder.sync(); } finally { await folder.close(); } }
    const endpoint = policy.storage.transfer.endpoint || `https://${isIP(ip) === 6 ? `[${ip}]` : ip}:${policy.storage.transfer.port}`;
    const checked = await loadTransferTls({ ...policy.storage.transfer, endpoint, certificateFile: join(temporary, 'certificate.pem'), keyFile: join(temporary, 'key.pem') }, `node_${'00'.repeat(32)}`);
    await rename(temporary, target); published = true;
    if (process.platform !== 'win32') { const folder = await open(directory, 'r'); try { await folder.sync(); } finally { await folder.close(); } }
    return { certificateFile: join(target, 'certificate.pem'), keyFile: join(target, 'key.pem'), expiresAt: new Date(checked.certificate.validTo).toISOString(), endpoint, algorithm: 'P-256' as const, directory: target };
  } catch { if (published) await rm(target, { recursive: true, force: true }); throw new PolicyError('POLICY_FILE_INVALID', ['Certificate generation failed; check OpenSSL availability and private state-directory permissions. No secret output is returned.']); }
  finally { await rm(temporary, { recursive: true, force: true }); }
}
