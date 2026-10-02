import { totalmem } from 'node:os';
import { existsSync, lstatSync } from 'node:fs';
import { ZodError } from 'zod';
import { CapabilitiesSchema, JOB_TYPES } from '@privanet/protocol';
import type { JobType } from '@privanet/protocol';
import { loadConfig } from './config.js';
import { ResourcePolicySchema } from './resource-policy.js';
import type { ResourcePolicy } from './resource-policy.js';
import { PolicyError, assertNoUnsafeLocal, resolvePolicy } from './policy-store.js';
import { readLocalState } from './local-state.js';

export type FindingSeverity = 'error' | 'warning' | 'info';
export interface Finding { severity: FindingSeverity; id: string; message: string; /** The setting concerned, by name. Never a value. */ setting?: string }
const GiB = 1024 ** 3;

/**
 * Judgement about a policy beyond its schema: settings that are valid but contradict each other or can never have an effect. One implementation, used by
 * `privanet-node config check`, `policy import` and the control panel, so a policy that passes in one place passes in all of them.
 */
export function policyFindings(policy: unknown, context: { jobSlots?: number; capabilities?: readonly JobType[] } = {}): Finding[] {
  const out: Finding[] = [];
  const parsed = ResourcePolicySchema.safeParse(policy);
  if (!parsed.success) {
    for (const issue of parsed.error.issues.slice(0, 30)) out.push({ severity: 'error', id: 'POLICY_INVALID', setting: issue.path.join('.') || '(policy)', message: `${issue.path.join('.') || '(policy)'}: ${issue.message}`.slice(0, 220) });
    return out;
  }
  const p: ResourcePolicy = parsed.data;
  try { assertNoUnsafeLocal(p); } catch (error) { if (error instanceof PolicyError) out.push({ severity: 'error', id: 'UNSAFE_LOCAL_NOT_ALLOWED', setting: 'fetch.unsafeLocal', message: 'fetch.unsafeLocal switches SSRF protection off and can only be set by editing a policy file by hand, never through the panel, an import or a preset.' }); }
  if (p.maxCpuPercent + p.reserveCpuPercent > 100) out.push({ severity: 'warning', id: 'CPU_CEILING_UNREACHABLE', setting: 'maxCpuPercent', message: `maxCpuPercent (${p.maxCpuPercent}) plus reserveCpuPercent (${p.reserveCpuPercent}) is over 100: the reserve will always cap contribution below the ceiling.` });
  if (p.maxMemoryBytes > totalmem()) out.push({ severity: 'warning', id: 'MEMORY_ABOVE_INSTALLED', setting: 'maxMemoryBytes', message: 'maxMemoryBytes is more than the memory installed in this machine; the memory reserve will always cap it.' });
  if (p.reserveMemoryBytes + p.safetyMarginBytes > totalmem()) out.push({ severity: 'warning', id: 'RESERVE_ABOVE_INSTALLED', setting: 'reserveMemoryBytes', message: 'The memory reserve plus safety margin is more than the installed memory, so no work will ever be accepted.' });
  if (p.maxMemoryBytes === 0 || p.maxCpuPercent === 0) out.push({ severity: 'warning', id: 'CONTRIBUTION_NEVER', setting: p.maxMemoryBytes === 0 ? 'maxMemoryBytes' : 'maxCpuPercent', message: 'A zero memory or CPU ceiling means no work is ever accepted.' });
  if (p.defaultLevel === 'OFF' && !p.schedule.some(rule => rule.level !== 'OFF')) out.push({ severity: 'warning', id: 'ALWAYS_OFF', setting: 'defaultLevel', message: 'The default level is OFF and no schedule rule turns contribution on, so the node never works.' });
  if (p.schedule.length > 1) out.push({ severity: 'info', id: 'SCHEDULE_FIRST_MATCH', setting: 'schedule', message: 'Schedule rules are checked in order and the first match wins; later overlapping rules never apply where an earlier one does.' });
  if (p.linkBytesPerSec !== undefined && p.maxBandwidthBytesPerSec !== null && p.maxBandwidthBytesPerSec > p.linkBytesPerSec) out.push({ severity: 'warning', id: 'BANDWIDTH_ABOVE_LINK', setting: 'maxBandwidthBytesPerSec', message: 'The bandwidth ceiling is above the declared link speed.' });
  for (const [type, limit] of Object.entries(p.capabilityLimits)) {
    if (limit.maxMemoryBytes !== undefined && limit.maxMemoryBytes > p.maxMemoryBytes) out.push({ severity: 'info', id: 'CAPABILITY_LIMIT_ABOVE_GENERAL', setting: `capabilityLimits.${type}`, message: `${type}: a per-capability limit can only lower the general budget, so its memory value above the general ceiling has no effect.` });
  }
  const slots = context.jobSlots ?? 1;
  const biggest = Math.max(0, ...(context.capabilities ?? (Object.keys(JOB_TYPES) as JobType[])).map(type => JOB_TYPES[type].resources.memoryBytes));
  if (slots > 1 && biggest * slots > p.maxMemoryBytes) out.push({ severity: 'warning', id: 'SLOTS_EXCEED_MEMORY', setting: 'PRIVANODE_JOB_SLOTS', message: `${slots} job slots at the largest declared per-job memory (${Math.round(biggest / (1024 * 1024))} MiB each) exceed maxMemoryBytes, so not every slot can be used at once.` });
  if (p.reserveDiskBytes < 1 * GiB && p.maxDiskBytes > 0) out.push({ severity: 'info', id: 'LOW_DISK_RESERVE', setting: 'reserveDiskBytes', message: 'Less than 1 GiB of free disk space is reserved for you; a full disk can hurt other programs.' });
  return out;
}

export interface ConfigCheck { ok: boolean; findings: Finding[]; policy?: { source: string; preset?: string } }
/**
 * Offline check of everything the node reads at start-up, without contacting the Coordinator and without printing any value that could be a secret: the environment
 * settings (by name), the policy in force and where it comes from, the saved local choices, the state directory and the paths named. Safe to run at any time.
 */
export async function checkConfig(env: NodeJS.ProcessEnv): Promise<ConfigCheck> {
  const findings: Finding[] = []; let jobSlots: number | undefined; let capabilities: JobType[] | undefined;
  try {
    const config = loadConfig({ ...env, PRIVANODE_POLICY_FILE: undefined as unknown as string });
    jobSlots = config.jobSlots; capabilities = config.capabilities;
    if (config.capabilities.length === 0) findings.push({ severity: 'warning', id: 'NO_CAPABILITIES', setting: 'PRIVANODE_CAPABILITIES', message: 'No capabilities are configured and none were remembered from enrollment, so no job type can be sent to this node.' });
  } catch (error) {
    if (error instanceof ZodError) for (const name of new Set(error.issues.map(issue => String(issue.path[0] ?? '(setting)')))) findings.push({ severity: 'error', id: 'SETTING_INVALID', setting: name, message: `${name} is missing or not acceptable (its value is not shown).` });
    else findings.push({ severity: 'error', id: 'STATE_UNSAFE', message: 'The enrollment record in the state directory is unreadable or unsafe (not private, not a regular file, or not ours).' });
  }
  // The environment schema stops at its first failure; the capability list is checked on its own so every problem is reported in one pass.
  if (env.PRIVANODE_CAPABILITIES && !CapabilitiesSchema.safeParse(env.PRIVANODE_CAPABILITIES.split(',')).success && !findings.some(finding => finding.setting === 'PRIVANODE_CAPABILITIES'))
    findings.push({ severity: 'error', id: 'SETTING_INVALID', setting: 'PRIVANODE_CAPABILITIES', message: 'PRIVANODE_CAPABILITIES names a capability this software does not know, or lists one twice (its value is not shown).' });
  const stateDir = env.PRIVANODE_STATE_DIR ?? './var/node';
  if (!existsSync(stateDir)) findings.push({ severity: 'info', id: 'STATE_DIR_MISSING', setting: 'PRIVANODE_STATE_DIR', message: 'The state directory does not exist yet; it is created (private) when the node enrolls.' });
  else if (process.platform !== 'win32') { const stat = lstatSync(stateDir); if ((stat.mode & 0o077) !== 0) findings.push({ severity: 'error', id: 'STATE_DIR_NOT_PRIVATE', setting: 'PRIVANODE_STATE_DIR', message: 'The state directory is accessible to other users; it must be mode 700.' }); }
  if (env.PRIVANODE_POLICY_FILE !== undefined && !existsSync(env.PRIVANODE_POLICY_FILE)) findings.push({ severity: 'error', id: 'POLICY_FILE_MISSING', setting: 'PRIVANODE_POLICY_FILE', message: 'The policy file named by PRIVANODE_POLICY_FILE does not exist.' });
  let source = 'defaults'; let preset: string | undefined;
  try {
    const resolved = await resolvePolicy(stateDir, env.PRIVANODE_POLICY_FILE);
    source = resolved.source.kind === 'defaults' ? 'defaults' : `${resolved.source.kind === 'saved' ? 'saved policy' : 'policy file'} (${resolved.source.path})`;
    if (resolved.source.kind === 'saved' && resolved.source.preset) preset = resolved.source.preset;
    if (resolved.problem) findings.push({ severity: 'error', id: resolved.problem.code, message: `The saved policy was not applied (${resolved.problem.code}); the ${resolved.problem.fellBackTo === 'env-file' ? 'installer policy file' : 'conservative defaults'} apply instead. ${resolved.problem.issues.join('; ')}`.trim() });
    findings.push(...policyFindings(resolved.policy, { ...(jobSlots !== undefined ? { jobSlots } : {}), ...(capabilities ? { capabilities } : {}) }));
  } catch (error) {
    findings.push({ severity: 'error', id: 'POLICY_UNREADABLE', setting: 'PRIVANODE_POLICY_FILE', message: error instanceof PolicyError ? `The policy file is not acceptable (${error.code}). ${error.issues.join('; ')}`.trim() : 'The policy file could not be read or parsed.' });
  }
  const local = await readLocalState(stateDir);
  if (local.kind === 'error') findings.push({ severity: 'error', id: local.code, message: 'The saved local choices (local-state.json) cannot be read; the node holds itself paused until they are fixed or the file is removed.' });
  return { ok: !findings.some(finding => finding.severity === 'error'), findings, policy: { source, ...(preset ? { preset } : {}) } };
}
