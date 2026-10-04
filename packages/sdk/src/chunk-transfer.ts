import { request } from 'node:https';
import { createHash, X509Certificate } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { ApiError, parseTicket, signHolderProof, validateTransferEndpoint } from '@privanet/shared';
import type { TransferGrant } from '@privanet/protocol';

function error(code: string, status = 503): ApiError { return new ApiError(status, code, code.toLowerCase().replaceAll('_', ' ')); }
interface Response { status: number; bytes: Buffer; challenge?: string }

/** The sole direct transport. Explicit leaf trust plus an exact leaf pin; no insecure TLS mode, redirects, proxy, ambient CAs, or connection/session reuse. */
export async function directRequest(grant: TransferGrant, headers: Record<string, string>, signal: AbortSignal, bytes?: Uint8Array): Promise<Response> {
  const claims = parseTicket(grant.ticket)?.claims;
  if (!claims || claims.transferId !== grant.transferId || claims.operation !== grant.operation || claims.chunkId !== grant.chunkId || claims.expiresAt !== grant.expiresAt || !grant.transferEndpoint) throw error('TRANSFER_UNAVAILABLE');
  let endpoint;
  try { endpoint = validateTransferEndpoint(grant.transferEndpoint, Date.now(), claims.nodeId); } catch { throw error('TLS_IDENTITY'); }
  const cert = new X509Certificate(Buffer.from(endpoint.certificate, 'base64'));
  const url = new URL(`/v1/chunks/${grant.chunkId}`, endpoint.url);
  return new Promise<Response>((resolve, reject) => {
    const req = request(url, { method: grant.operation.toUpperCase(), agent: false, ca: cert.toString(), allowPartialTrustChain: true, minVersion: 'TLSv1.2', signal,
      checkServerIdentity: (_hostname, peer) => createHash('sha256').update(peer.raw).digest('hex') === endpoint.certFingerprint ? undefined : new Error('TLS_IDENTITY'),
      headers: { authorization: `Transfer ${grant.ticket}`, 'content-length': bytes?.byteLength ?? 0, ...headers }, maxHeaderSize: 4096 }, res => {
      const parts: Buffer[] = []; let size = 0; const limit = res.statusCode === 200 && grant.operation === 'get' && headers['x-privanet-ack'] !== '1' ? claims.maxBytes : 1024;
      res.on('data', (part: Buffer) => { size += part.length; if (size > limit) { res.destroy(); reject(error('TRANSFER_SIZE')); } else parts.push(part); });
      res.once('error', () => reject(error('TRANSFER_FAILED')));
      res.once('aborted', () => reject(error('TRANSFER_FAILED')));
      res.once('end', () => resolve({ status: res.statusCode ?? 0, bytes: Buffer.concat(parts), ...(typeof res.headers['x-privanet-receipt-challenge'] === 'string' ? { challenge: res.headers['x-privanet-receipt-challenge'] } : {}) }));
    });
    req.once('error', (cause: Error & { code?: string }) => reject(error(signal.aborted ? 'TRANSFER_TIMEOUT' : cause.code?.includes('CERT') || cause.code?.includes('TLS') || cause.message === 'TLS_IDENTITY' ? 'TLS_IDENTITY' : 'TRANSFER_UNAVAILABLE')));
    req.setTimeout(10000, () => req.destroy(new Error('TRANSFER_TIMEOUT')));
    req.end(bytes);
  });
}

export async function transferChunk(grant: TransferGrant, holder: { publicKey: string; privateKey: KeyObject }, signal: AbortSignal, bytes?: Uint8Array): Promise<Buffer> {
  const claims = parseTicket(grant.ticket)?.claims;
  if (!claims || claims.holderKey !== holder.publicKey || (grant.operation === 'put' && claims.maxBytes !== bytes?.byteLength)) throw error('TRANSFER_GRANT', 403);
  const initial = await directRequest(grant, { 'x-privanet-handshake': '1' }, signal);
  let challenge: string;
  try { const body = JSON.parse(initial.bytes.toString('utf8')) as { code: string; challenge: string }; if (initial.status !== 401 || body.code !== 'HOLDER_CHALLENGE' || !/^[a-f0-9]{64}$/.test(body.challenge)) throw new Error(); challenge = body.challenge; }
  catch { throw error('TRANSFER_AUTHORIZATION', 403); }
  const requestLine = `${grant.operation.toUpperCase()} /v1/chunks/${grant.chunkId}`;
  const headers = { 'x-privanet-challenge': challenge, 'x-privanet-proof': signHolderProof(holder.privateKey, { challenge, transferId: grant.transferId, requestLine }), ...(grant.operation === 'put' ? { 'content-type': 'application/octet-stream' } : {}) };
  const result = await directRequest(grant, headers, signal, bytes);
  if (result.status !== 200) throw error(result.status === 429 ? 'TRANSFER_BUSY' : 'TRANSFER_FAILED', result.status >= 400 && result.status <= 599 ? result.status : 503);
  if (grant.operation === 'get') {
    if (result.bytes.length !== claims.maxBytes || createHash('sha256').update(result.bytes).digest('hex') !== grant.chunkId.slice(4)) throw error('TRANSFER_INTEGRITY', 409);
    if (!result.challenge || !/^[a-f0-9]{64}$/.test(result.challenge)) throw error('TRANSFER_FAILED');
    const ack = await directRequest(grant, { 'x-privanet-ack': '1', 'x-privanet-challenge': result.challenge,
      'x-privanet-proof': signHolderProof(holder.privateKey, { challenge: result.challenge, transferId: grant.transferId, requestLine }) }, signal);
    if (ack.status !== 200) throw error('TRANSFER_FAILED');
  }
  return result.bytes;
}
