import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { z } from 'zod';
import { isMissing, privateDirectory, readPrivateFileUpTo, replacePrivateFile } from '@privanet/shared';
import { ResourcePolicySchema } from './resource-policy.js';
import type { ResourcePolicy } from './resource-policy.js';

/**
 * The policy the owner saved through the control panel or `privanet-node policy import|preset`. It uses the same `ResourcePolicySchema` as the file the installer
 * writes, inside a small versioned wrapper. While it exists it takes precedence over the file named by PRIVANODE_POLICY_FILE (which is usually root-owned and not
 * writable by the node's account); `privanet-node policy reset` removes it and the earlier file applies again. Every surface names which one is in force.
 */
export const POLICY_FILE = 'policy.json';
export const POLICY_FILE_VERSION = 1;
export const MAX_POLICY_BYTES = 65536;
const PresetLabel = z.enum(['minimal', 'balanced', 'generous', 'maximum-idle']);
export const PolicyFileSchema = z.strictObject({ version: z.literal(POLICY_FILE_VERSION), preset: PresetLabel.optional(), savedAt: z.number().int().min(0), policy: ResourcePolicySchema });
export type PolicyFile = z.infer<typeof PolicyFileSchema>;

export type PolicyProblemCode = 'POLICY_FILE_INVALID' | 'POLICY_FILE_NEWER' | 'POLICY_FILE_UNSAFE' | 'UNSAFE_LOCAL_NOT_ALLOWED' | 'POLICY_TOO_LARGE' | 'POLICY_NOT_JSON' | 'JOB_SLOTS_SET_BY_ENVIRONMENT' | 'POLICY_LOCKED_BY_ENVIRONMENT';
/** A policy that cannot be accepted. `issues` name the settings (paths) that are wrong, never a file's raw contents. */
export class PolicyError extends Error {
  constructor(readonly code: PolicyProblemCode, readonly issues: string[] = []) { super(code); this.name = 'PolicyError'; }
}
const issuesOf = (error: z.ZodError): string[] => error.issues.slice(0, 20).map(issue => `${issue.path.join('.') || '(policy)'}: ${issue.message}`.slice(0, 200));

/** `fetch.unsafeLocal` switches SSRF protection off. It can only be set by editing a policy file by hand: never by the panel, an import or a preset. */
export function assertNoUnsafeLocal(policy: ResourcePolicy): void { if (policy.fetch.unsafeLocal !== undefined) throw new PolicyError('UNSAFE_LOCAL_NOT_ALLOWED', ['fetch.unsafeLocal']); }

/**
 * Parses policy text from a file or an import. Accepts the versioned wrapper (version 1) or a bare policy (the older file format, "version 0"), and refuses a wrapper
 * with a newer version than this software understands. Returns the policy and any preset label the wrapper carried.
 */
export function parsePolicyText(text: string): { policy: ResourcePolicy; preset?: z.infer<typeof PresetLabel>; migratedFrom?: 0 } {
  if (text.length > MAX_POLICY_BYTES) throw new PolicyError('POLICY_TOO_LARGE');
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new PolicyError('POLICY_NOT_JSON'); }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new PolicyError('POLICY_FILE_INVALID', ['(policy): expected an object']);
  const version = (raw as { version?: unknown }).version;
  if (version !== undefined) {
    if (typeof version === 'number' && version > POLICY_FILE_VERSION) throw new PolicyError('POLICY_FILE_NEWER');
    const parsed = PolicyFileSchema.safeParse(raw);
    if (!parsed.success) throw new PolicyError('POLICY_FILE_INVALID', issuesOf(parsed.error));
    return { policy: parsed.data.policy, ...(parsed.data.preset ? { preset: parsed.data.preset } : {}) };
  }
  const bare = ResourcePolicySchema.safeParse(raw);
  if (!bare.success) throw new PolicyError('POLICY_FILE_INVALID', issuesOf(bare.error));
  return { policy: bare.data, migratedFrom: 0 };
}

export const policyFilePath = (stateDir: string): string => join(stateDir, POLICY_FILE);
export type PolicyFileRead = { kind: 'absent' } | { kind: 'ok'; file: PolicyFile; migratedFrom?: 0 } | { kind: 'error'; code: PolicyProblemCode; issues: string[] };
/** Reads the saved policy. Never throws: a damaged, unsafe or newer file is reported so the caller can keep the last good policy and say so. */
export async function readPolicyFile(stateDir: string): Promise<PolicyFileRead> {
  try {
    const text = await readPrivateFileUpTo(policyFilePath(stateDir), MAX_POLICY_BYTES);
    const parsed = parsePolicyText(text);
    assertNoUnsafeLocal(parsed.policy);
    return { kind: 'ok', file: { version: 1, ...(parsed.preset ? { preset: parsed.preset } : {}), savedAt: 0, policy: parsed.policy }, ...(parsed.migratedFrom === 0 ? { migratedFrom: 0 as const } : {}) };
  } catch (error) {
    if (isMissing(error)) return { kind: 'absent' };
    if (error instanceof PolicyError) return { kind: 'error', code: error.code, issues: error.issues };
    return { kind: 'error', code: 'POLICY_FILE_UNSAFE', issues: [] };
  }
}
/** Validates and atomically saves a policy (mode 0600, previous file kept as policy.json.bak). */
export async function savePolicyFile(stateDir: string, policy: ResourcePolicy, preset?: z.infer<typeof PresetLabel> | 'custom', now: number = Date.now()): Promise<void> {
  const checked = ResourcePolicySchema.safeParse(policy);
  if (!checked.success) throw new PolicyError('POLICY_FILE_INVALID', issuesOf(checked.error));
  assertNoUnsafeLocal(checked.data);
  const file: PolicyFile = { version: POLICY_FILE_VERSION, ...(preset && preset !== 'custom' ? { preset } : {}), savedAt: now, policy: checked.data };
  await replacePrivateFile(policyFilePath(await privateDirectory(stateDir)), JSON.stringify(file, null, 2) + '\n', { keepBackup: true });
  // Persist both renames (policy and backup) before reporting success on POSIX.
  if (process.platform !== 'win32') { const directory = await open(stateDir, 'r'); try { await directory.sync(); } finally { await directory.close(); } }
}
export async function removePolicyFile(stateDir: string): Promise<boolean> {
  const { unlink } = await import('node:fs/promises');
  try { await unlink(policyFilePath(stateDir)); return true; } catch (error) { if (isMissing(error)) return false; throw error; }
}

export type PolicySource = { kind: 'defaults' } | { kind: 'env-file'; path: string } | { kind: 'saved'; path: string; preset?: string };
export interface ResolvedPolicy { policy: ResourcePolicy; source: PolicySource; /** True when PRIVANODE_POLICY_LOCKED made the policy file authoritative (a saved policy is ignored and cannot be changed). */ locked?: boolean; problem?: { code: PolicyProblemCode; issues: string[]; fellBackTo: 'env-file' | 'defaults' } }
/** The file the installer wrote (or nothing), strictly as before. */
export function readBasePolicy(envFile: string | undefined): { policy: ResourcePolicy; source: PolicySource } {
  if (envFile === undefined) return { policy: ResourcePolicySchema.parse({}), source: { kind: 'defaults' } };
  return { policy: parsePolicyText(readFileSync(envFile, 'utf8')).policy, source: { kind: 'env-file', path: envFile } };
}
/**
 * The policy in force: the owner's saved policy when there is a good one, otherwise the installer's file, otherwise the conservative defaults. A saved policy that is
 * damaged or from a newer version is not applied and not overwritten: the fallback is used and `problem` says why, so nothing is silently discarded or silently trusted.
 */
export async function resolvePolicy(stateDir: string, envFile: string | undefined, options: { locked?: boolean } = {}): Promise<ResolvedPolicy> {
  // Locked by the administrator: the installer's file (or the defaults) is the policy; a saved policy is neither read nor changed.
  if (options.locked) return { ...readBasePolicy(envFile), locked: true };
  const saved = await readPolicyFile(stateDir);
  const base = readBasePolicy(envFile);
  if (saved.kind === 'ok') return { policy: saved.file.policy, source: { kind: 'saved', path: policyFilePath(stateDir), ...(saved.file.preset ? { preset: saved.file.preset } : {}) } };
  if (saved.kind === 'error') return { ...base, problem: { code: saved.code, issues: saved.issues, fellBackTo: base.source.kind === 'env-file' ? 'env-file' : 'defaults' } };
  return base;
}

/** Text for `policy export`: the policy only (never an identity, an enrollment record, a session or a secret), without the SSRF escape hatch. */
export function exportPolicyText(policy: ResourcePolicy, preset?: string): string {
  const { unsafeLocal: _omitted, ...fetch } = policy.fetch;
  const safe = ResourcePolicySchema.parse({ ...policy, fetch });
  void _omitted;
  return JSON.stringify({ version: POLICY_FILE_VERSION, ...(preset && preset !== 'custom' ? { preset } : {}), savedAt: 0, policy: safe }, null, 2) + '\n';
}
