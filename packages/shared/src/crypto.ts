import { createHash, createPublicKey, randomBytes, timingSafeEqual } from 'node:crypto';
export const secret = (): string => randomBytes(32).toString('hex');
export const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
export function equalSecret(a: string, b: string): boolean {
  return timingSafeEqual(Buffer.from(hash(a), 'hex'), Buffer.from(hash(b), 'hex'));
}
export function canonicalPublicKey(base64: string): { publicKey: string; nodeId: string } {
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.toString('base64') !== base64) throw new Error('Non-canonical public key');
  const key = createPublicKey({ key: bytes, format: 'der', type: 'spki' });
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Expected Ed25519');
  const canonical = key.export({ format: 'der', type: 'spki' });
  if (!bytes.equals(canonical)) throw new Error('Non-canonical public key');
  return { publicKey: canonical.toString('base64'), nodeId: `node_${hash(canonical)}` };
}
