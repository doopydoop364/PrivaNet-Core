import { lstatSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { CapabilitiesSchema, NodeIdSchema, TimeSchema } from '@privanet/protocol';
import { createPrivateFile, isMissing, privateDirectory, readPrivateFile } from '@privanet/shared';

/** The file in the node's private state directory that remembers where and as what this node enrolled, so a restart needs no configuration and no token. */
export const ENROLLMENT_FILE = 'enrollment.json';
/**
 * What `privanet-node enroll` leaves behind next to `identity.json` (the node's private key, which is its credential) and `node-state.json` (the Coordinator binding).
 * It holds no secret: the Coordinator address, its identity, this node's ID and the capabilities it enrolled with. The enrollment token is never written anywhere.
 */
export const EnrollmentRecordSchema = z.strictObject({
  version: z.literal(1), coordinatorUrl: z.string().max(2048), coordinatorId: z.uuid(), nodeId: NodeIdSchema,
  capabilities: CapabilitiesSchema, enrolledAt: TimeSchema,
});
export type EnrollmentRecord = z.infer<typeof EnrollmentRecordSchema>;

/** The record, or undefined when this node has not enrolled through `enroll`. A record that is unsafe (readable by others, a link, not ours) or malformed is an error, not "missing". */
export async function readEnrollmentRecord(stateDir: string): Promise<EnrollmentRecord | undefined> {
  const path = join(await privateDirectory(stateDir), ENROLLMENT_FILE);
  try { return EnrollmentRecordSchema.parse(JSON.parse(await readPrivateFile(path))); }
  catch (error) { if (isMissing(error)) return undefined; throw error; }
}
/** Never overwrites: a node that is already enrolled does not silently change who it is enrolled with. */
export async function writeEnrollmentRecord(stateDir: string, record: EnrollmentRecord): Promise<void> {
  await createPrivateFile(join(await privateDirectory(stateDir), ENROLLMENT_FILE), JSON.stringify(EnrollmentRecordSchema.parse(record)) + '\n');
}
/** Synchronous read for configuration loading. Same safety rules as `readPrivateFile`, and it never creates anything. */
export function readEnrollmentRecordSync(stateDir: string): EnrollmentRecord | undefined {
  const path = join(stateDir, ENROLLMENT_FILE);
  let stat;
  try { stat = lstatSync(path); } catch (error) { if (isMissing(error)) return undefined; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192 || (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))) throw new Error('Unsafe private state file');
  return EnrollmentRecordSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

/** A request to join that is waiting for the owner. Kept so that running `join` again (or restarting the machine) resumes the same request instead of making a second one. It names the request, which is not a secret on its own: completing it still needs this node's private key. */
export const JOIN_FILE = 'join-request.json';
export const JoinRecordSchema = z.strictObject({ version: z.literal(1), requestId: z.uuid(), code: z.string().max(16), coordinatorUrl: z.string().max(2048), coordinatorId: z.uuid(), expiresAt: TimeSchema });
export type JoinRecord = z.infer<typeof JoinRecordSchema>;
export async function readJoinRecord(stateDir: string): Promise<JoinRecord | undefined> {
  const path = join(await privateDirectory(stateDir), JOIN_FILE);
  try { return JoinRecordSchema.parse(JSON.parse(await readPrivateFile(path))); } catch (error) { if (isMissing(error)) return undefined; throw error; }
}
export async function writeJoinRecord(stateDir: string, record: JoinRecord): Promise<void> {
  await createPrivateFile(join(await privateDirectory(stateDir), JOIN_FILE), JSON.stringify(JoinRecordSchema.parse(record)) + '\n');
}
export function removeJoinRecord(stateDir: string): void { try { unlinkSync(join(stateDir, JOIN_FILE)); } catch { /* none */ } }
