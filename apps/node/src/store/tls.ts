import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { X509Certificate, createPrivateKey } from 'node:crypto';
import type { ResourcePolicy } from '../resource-policy.js';
import { bindTransferEndpoint, transferEndpoint } from '@privanet/shared';

export class TransferTlsError extends Error { constructor(readonly code: string) { super(code); } }
/** Bounded no-follow read; verify the opened descriptor too, including after a concurrent path replacement. */
async function readTlsFile(path: string, key: boolean): Promise<string> {
  const prefix = key ? 'TRANSFER_KEY' : 'TRANSFER_CERT';
  try {
    const before = await lstat(path);
    if (before.isSymbolicLink()) throw new TransferTlsError(`${prefix}_SYMLINK`);
    if (!before.isFile() || before.size > 16384) throw new TransferTlsError(`${prefix}_UNREADABLE`);
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 16384 || before.dev !== stat.dev || before.ino !== stat.ino) throw new TransferTlsError(`${prefix}_UNREADABLE`);
      if (key && process.platform !== 'win32') {
        if (stat.uid !== process.getuid?.()) throw new TransferTlsError('TRANSFER_KEY_OWNERSHIP');
        if ((stat.mode & 0o077) !== 0) throw new TransferTlsError('TRANSFER_KEY_PERMISSIONS');
      }
      const data = Buffer.alloc(16385); let bytesRead = 0;
      while (bytesRead < data.length) { const part = await file.read(data, bytesRead, data.length - bytesRead, bytesRead); if (!part.bytesRead) break; bytesRead += part.bytesRead; }
      if (bytesRead > 16384) throw new TransferTlsError(`${prefix}_UNREADABLE`);
      return data.subarray(0, bytesRead).toString('utf8');
    } finally { await file.close(); }
  } catch (error) {
    if (error instanceof TransferTlsError) throw error;
    throw new TransferTlsError(`${prefix}_${error instanceof Error && 'code' in error && error.code === 'ENOENT' ? 'MISSING' : 'UNREADABLE'}`);
  }
}
export async function loadTransferTls(config: ResourcePolicy['storage']['transfer'], nodeId: string) {
  const cert = await readTlsFile(config.certificateFile, false); const key = await readTlsFile(config.keyFile, true);
  let certificate: X509Certificate;
  try { certificate = new X509Certificate(cert); } catch { throw new TransferTlsError('TRANSFER_CERT_INVALID'); }
  if (Date.parse(certificate.validFrom) > Date.now()) throw new TransferTlsError('TRANSFER_CERT_NOT_YET_VALID');
  if (Date.parse(certificate.validTo) <= Date.now()) throw new TransferTlsError('TRANSFER_CERT_EXPIRED');
  try { if (!certificate.checkPrivateKey(createPrivateKey(key))) throw new Error(); } catch { throw new TransferTlsError('TRANSFER_KEY_MISMATCH'); }
  try { return { cert, key, certificate, endpoint: bindTransferEndpoint(transferEndpoint(config.endpoint, cert), nodeId, key) }; }
  catch { throw new TransferTlsError('TRANSFER_TLS_INVALID'); }
}
