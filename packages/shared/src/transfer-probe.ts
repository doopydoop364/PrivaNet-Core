import { connect } from 'node:tls';
import { X509Certificate, createHash } from 'node:crypto';
import { validateTransferEndpoint } from './transfer-endpoint.js';
import type { TransferEndpoint } from '@privanet/protocol';
/** Exactly the same TLS identity rules for SDK transfers and an explicit ticket-free operator probe. */
export function pinnedTransferTls(endpoint: TransferEndpoint) {
  const cert = new X509Certificate(Buffer.from(endpoint.certificate, 'base64'));
  return { ca: cert.toString(), allowPartialTrustChain: true, minVersion: 'TLSv1.2' as const, rejectUnauthorized: true,
    checkServerIdentity: (_hostname: string, peer: { raw: Buffer }) => createHash('sha256').update(peer.raw).digest('hex') === endpoint.certFingerprint ? undefined : new Error('TLS_IDENTITY') };
}
export type ProbeCode = 'TLS_LISTENER_REACHABLE' | 'ADDRESS_FAILED' | 'TCP_FAILED' | 'TLS_IDENTITY_FAILED' | 'ENDPOINT_INVALID';
export interface ProbeResult { code: ProbeCode; reachable: boolean; testedAt: number; durationMs: number; scope: 'operator-to-endpoint-tls'; payloadBytes: 0 }
/** One bounded TLS handshake; no HTTP request, credentials, ticket, upload, redirects or ambient proxy/CA. */
export async function probeTransferEndpoint(input: TransferEndpoint, nodeId: string, timeoutMs = 5000): Promise<ProbeResult> {
  const at = Date.now(); const result = (code: ProbeCode): ProbeResult => ({ code, reachable: code === 'TLS_LISTENER_REACHABLE', testedAt: at, durationMs: Date.now() - at, scope: 'operator-to-endpoint-tls', payloadBytes: 0 });
  let endpoint: TransferEndpoint;
  try { endpoint = validateTransferEndpoint(input, at, nodeId); } catch { return result('ENDPOINT_INVALID'); }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) return result('ENDPOINT_INVALID');
  const url = new URL(endpoint.url); const host = url.hostname.replace(/^\[|\]$/g, '');
  return new Promise(resolve => {
    let settled = false;
    const socket = connect({ host, port: Number(url.port || 443), servername: host.includes(':') || /^\d+\.\d+\.\d+\.\d+$/.test(host) ? '' : host, ...pinnedTransferTls(endpoint) });
    const finish = (code: ProbeCode) => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); resolve(result(code)); };
    const timer = setTimeout(() => finish('TCP_FAILED'), timeoutMs);
    socket.once('secureConnect', () => {
      const peer = socket.getPeerCertificate();
      finish(socket.authorized && peer.raw && createHash('sha256').update(peer.raw).digest('hex') === endpoint.certFingerprint ? 'TLS_LISTENER_REACHABLE' : 'TLS_IDENTITY_FAILED');
    });
    socket.once('error', (error: Error & { code?: string }) => finish(['ENOTFOUND', 'EAI_AGAIN', 'EINVAL'].includes(error.code ?? '') ? 'ADDRESS_FAILED' : error.code?.includes('CERT') || error.code?.includes('TLS') || error.code?.includes('SSL') || error.message === 'TLS_IDENTITY' ? 'TLS_IDENTITY_FAILED' : 'TCP_FAILED'));
  });
}
