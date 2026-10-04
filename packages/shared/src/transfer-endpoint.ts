import { X509Certificate, createHash, sign, verify, createPrivateKey } from 'node:crypto';
import { TransferEndpointSchema } from '@privanet/protocol';
import type { TransferEndpoint } from '@privanet/protocol';

const proofMessage = (endpoint: TransferEndpoint, nodeId: string) => Buffer.from(`privanet.transfer-endpoint.v1\0${nodeId}\0${endpoint.url}\0${endpoint.certFingerprint}`);
export function validateTransferEndpoint(input: unknown, now = Date.now(), nodeId?: string): TransferEndpoint {
  const endpoint = TransferEndpointSchema.parse(input);
  const der = Buffer.from(endpoint.certificate, 'base64');
  const cert = new X509Certificate(der);
  if (der.toString('base64') !== endpoint.certificate || !cert.raw.equals(der) || createHash('sha256').update(der).digest('hex') !== endpoint.certFingerprint ||
      Date.parse(cert.validFrom) > now || Date.parse(cert.validTo) <= now) throw new Error('Invalid transfer certificate');
  if (nodeId && (!endpoint.keyProof || !verify(cert.publicKey.asymmetricKeyType === 'ed25519' ? null : 'sha256', proofMessage(endpoint, nodeId), cert.publicKey, Buffer.from(endpoint.keyProof, 'base64')))) throw new Error('Invalid endpoint binding');
  return endpoint;
}
export function bindTransferEndpoint(endpoint: TransferEndpoint, nodeId: string, key: string): TransferEndpoint {
  const privateKey = createPrivateKey(key);
  const keyProof = sign(privateKey.asymmetricKeyType === 'ed25519' ? null : 'sha256', proofMessage(endpoint, nodeId), privateKey).toString('base64');
  return validateTransferEndpoint({ ...endpoint, keyProof }, Date.now(), nodeId);
}

export function transferEndpoint(url: string, certificate: string | Buffer): TransferEndpoint {
  const cert = new X509Certificate(certificate);
  return validateTransferEndpoint({ url, certificate: cert.raw.toString('base64'), certFingerprint: createHash('sha256').update(cert.raw).digest('hex') });
}
