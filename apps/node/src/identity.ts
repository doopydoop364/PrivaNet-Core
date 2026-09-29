import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { NodeIdSchema, ProofMessageSchema } from '@privanet/protocol';
import type { Challenge } from '@privanet/protocol';
import { canonicalPublicKey, createPrivateFile, isMissing, privateDirectory, readPrivateFile } from '@privanet/shared';
const IdentitySchema = z.strictObject({ nodeId: NodeIdSchema, publicKey: z.string().max(256), privateKey: z.string().max(512) });
const BindingSchema = z.strictObject({ url: z.string().max(2048), coordinatorId: z.uuid() });
export type Identity = z.infer<typeof IdentitySchema>;
export async function loadIdentity(stateDir: string): Promise<Identity> {
  const directory = await privateDirectory(stateDir); const path = join(directory, 'identity.json');
  let identity: Identity;
  try { identity = IdentitySchema.parse(JSON.parse(await readPrivateFile(path))); }
  catch (error) {
    if (!isMissing(error)) throw error;
    const pair = generateKeyPairSync('ed25519');
    const publicKey = pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    identity = { ...canonicalPublicKey(publicKey), privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64') };
    await createPrivateFile(path, JSON.stringify(identity) + '\n');
  }
  const derived = canonicalPublicKey(identity.publicKey);
  const key = createPrivateKey({ key: Buffer.from(identity.privateKey, 'base64'), format: 'der', type: 'pkcs8' });
  if (key.asymmetricKeyType !== 'ed25519' || derived.nodeId !== identity.nodeId ||
      createPublicKey(key).export({ type: 'spki', format: 'der' }).toString('base64') !== identity.publicKey) throw new Error('Invalid identity key pair');
  return identity;
}
export async function bindCoordinator(stateDir: string, url: string, coordinatorId: string): Promise<void> {
  const path = join(await privateDirectory(stateDir), 'node-state.json');
  try {
    const value = BindingSchema.parse(JSON.parse(await readPrivateFile(path)));
    if (value.url !== url || value.coordinatorId !== coordinatorId) throw new Error('Coordinator binding changed; operator recovery required');
  } catch (error) {
    if (!isMissing(error)) throw error;
    await createPrivateFile(path, JSON.stringify(BindingSchema.parse({ url, coordinatorId })) + '\n');
  }
}
export function signProof(identity: Identity, challenge: Challenge, coordinatorId: string, purpose: 'enroll' | 'auth') {
  const proof = ProofMessageSchema.parse(JSON.parse(challenge.message));
  if (proof.coordinatorId !== coordinatorId || challenge.coordinatorId !== coordinatorId || proof.nodeId !== identity.nodeId || proof.purpose !== purpose) throw new Error('Invalid proof context');
  const key = createPrivateKey({ key: Buffer.from(identity.privateKey, 'base64'), format: 'der', type: 'pkcs8' });
  return { challengeId: challenge.challengeId, signature: sign(null, Buffer.from(challenge.message), key).toString('hex') };
}
