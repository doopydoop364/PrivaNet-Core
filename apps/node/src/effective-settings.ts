import { z } from 'zod';
import { join } from 'node:path';
import { readPrivateFileUpTo } from '@privanet/shared';
import { StatusFileSchema, STATUS_FILE, STATUS_STALE_MS } from './status-file.js';
import type { JobType } from '@privanet/protocol';
import { activePause, jobSlotsChoice, readLocalState } from './local-state.js';
import type { LocalState } from './local-state.js';
import { detectPreset } from './presets.js';
import { policyFilePath, readPolicyFile, resolvePolicy } from './policy-store.js';
import type { ResolvedPolicy } from './policy-store.js';
import { readEnrollmentRecordSync } from './enrollment-record.js';
import { existsSync } from 'node:fs';
import { DEFAULT_PANEL_PORT } from './panel-token.js';
import { transferConfig, TRANSFER_ENV, reportedTransferEndpoint } from './store/transfer-config.js';

/**
 * One place that answers "what is this node actually using, and where did that come from?", for the panel, the CLI, the support bundle and `config check`.
 *
 * Precedence, the same everywhere (an administrator's explicit environment setting beats the owner's saved convenience setting, which beats the default):
 *   - job slots:        PRIVANODE_JOB_SLOTS  >  saved (panel / `slots`)  >  1.  Applies at start.
 *   - resource policy:  PRIVANODE_POLICY_LOCKED=true (the policy file alone)  >  saved policy.json (panel / `policy`)  >  the installer's PRIVANODE_POLICY_FILE  >  built-in defaults.
 *                       The installer always sets PRIVANODE_POLICY_FILE, so that file is the starting point rather than a lock: the owner's saved policy wins until the administrator
 *                       locks it.
 *   - capabilities:     PRIVANODE_CAPABILITIES  >  what the node enrolled with; the owner can then only switch off some of them (saved), never add one.
 *   - Coordinator:      PRIVANODE_COORDINATOR_URL  >  the enrollment record  >  the loopback default. Never editable from the panel.
 *   - panel:            PRIVANODE_PANEL / PRIVANODE_PANEL_PORT  >  on, port 4040. Environment only.
 *   - name and pause:   saved only (local state); there is no environment equivalent.
 *   - updates:          nothing automatic; `update check` runs only when asked.
 * A value that the environment sets is reported as locked, and the panel and CLI refuse to pretend they can change it.
 */
export type Source = 'environment' | 'saved' | 'enrollment' | 'installer-file' | 'default';
export interface EffectiveSettings {
  jobSlots: { value: number; source: 'environment' | 'saved' | 'default'; saved: number | null; locked: boolean; appliesAtStart: true; restartRequired: boolean };
  policy: { source: 'saved' | 'installer-file' | 'default'; locked: boolean; lockedBy: string | null; savedFileIgnored: boolean; preset: string };
  capabilities: { source: 'environment' | 'enrollment' | 'none'; configured: JobType[]; disabledByOwner: JobType[]; advertised: JobType[] };
  coordinator: { source: 'environment' | 'enrollment' | 'default'; host: string | null; editableHere: false };
  panel: { enabled: boolean; port: number; source: 'environment' | 'default'; editableHere: false };
  /** The local chunk store's switches (the store itself is reported by `storage status`). Governed by the same policy source and lock as every other limit. */
  storage: { enabled: boolean; maxBytes: number; reserveFreeBytes: number; source: 'saved' | 'installer-file' | 'default'; locked: boolean; networkAccessible: null };
  directTransfer: { enabled: boolean; bindAddress: string; port: number; endpoint: string; maxConcurrent: number; maxConcurrentPuts: number; certificateConfigured: boolean; keyConfigured: boolean; environmentLocks: string[]; configurationError: string | null };
  storageFields: Record<string, { value: unknown; source: Source; saved: unknown; override: string | null; locked: boolean }>;
  name: { value: string | null; source: 'saved' | 'none' };
  pause: { active: boolean; kind: string | null; until: number | null };
  updates: { automatic: false };
}
export interface SettingsInputs {
  env: NodeJS.ProcessEnv; local: LocalState; policy: ResolvedPolicy;
  /** What the node enrolled with, if it did (the enrollment record). */
  enrolled?: { coordinatorUrl: string; capabilities: JobType[] } | undefined;
  /** The job slots this process started with (absent when no node is running: then the value that would apply at the next start is reported). */
  runningJobSlots?: number | undefined;
  /** The configured default when PRIVANODE_JOB_SLOTS is unset (1). */
  now: number; bootTime?: number | undefined;
  /** Whether a saved policy file exists but is being ignored because the policy is locked. */
  savedPolicyPresent?: boolean | undefined;
}
const hostOf = (url: string | undefined): string | null => { try { return url ? new URL(url).host : null; } catch { return null; } };

export function computeEffectiveSettings(input: SettingsInputs): EffectiveSettings {
  const { env, local } = input;
  const slotsFromEnv = env.PRIVANODE_JOB_SLOTS !== undefined; const configuredSlots = Number(env.PRIVANODE_JOB_SLOTS ?? 1);
  const choice = jobSlotsChoice(Number.isInteger(configuredSlots) && configuredSlots >= 1 && configuredSlots <= 64 ? configuredSlots : 1, slotsFromEnv, local.jobSlots);
  const policyLocked = env.PRIVANODE_POLICY_LOCKED === 'true';
  const envCaps = env.PRIVANODE_CAPABILITIES; const enrolledCaps = input.enrolled?.capabilities ?? [];
  const configured = (envCaps !== undefined ? (envCaps === '' ? [] : envCaps.split(',')) : enrolledCaps) as JobType[];
  const disabled = local.disabledCapabilities.filter(type => configured.includes(type));
  const url = env.PRIVANODE_COORDINATOR_URL ?? input.enrolled?.coordinatorUrl;
  const panelPort = Number(env.PRIVANODE_PANEL_PORT ?? DEFAULT_PANEL_PORT);
  const pause = activePause(local.pause, input.now, input.bootTime);
  let direct; let configurationError: string | null = null;
  try { direct = transferConfig(input.policy.policy, env); } catch (error) { direct = input.policy.policy.storage.transfer; configurationError = error instanceof Error ? error.message : 'TRANSFER_CONFIG_INVALID'; }
  const policySource = input.policy.source.kind === 'saved' ? 'saved' as const : input.policy.source.kind === 'env-file' ? 'installer-file' as const : 'default' as const;
  const storageFields: EffectiveSettings['storageFields'] = {};
  for (const key of ['enabled', 'maxBytes', 'reserveFreeBytes'] as const) storageFields[key] = { value: input.policy.policy.storage[key], source: policySource, saved: policySource === 'saved' ? input.policy.policy.storage[key] : null, override: null, locked: policyLocked };
  for (const [key, name] of Object.entries(TRANSFER_ENV)) {
    const k = key as keyof typeof TRANSFER_ENV; const overridden = env[name] !== undefined;
    const secretPath = k === 'keyFile' || k === 'certificateFile';
    const savedValue = secretPath ? !!input.policy.policy.storage.transfer[k] : k === 'endpoint' ? reportedTransferEndpoint(input.policy.policy.storage.transfer.endpoint) : input.policy.policy.storage.transfer[k];
    storageFields[`transfer.${key}`] = { value: configurationError ? null : secretPath ? !!direct[k] : direct[k], source: overridden ? 'environment' : policySource, saved: policySource === 'saved' ? savedValue : null, override: overridden ? name : null, locked: policyLocked || overridden };
  }
  return {
    jobSlots: { value: input.runningJobSlots ?? choice.value, source: choice.source, saved: local.jobSlots ?? null, locked: slotsFromEnv, appliesAtStart: true,
      restartRequired: input.runningJobSlots !== undefined && !slotsFromEnv && local.jobSlots !== undefined && local.jobSlots !== input.runningJobSlots },
    policy: { source: input.policy.source.kind === 'saved' ? 'saved' : input.policy.source.kind === 'env-file' ? 'installer-file' : 'default', locked: policyLocked, lockedBy: policyLocked ? 'PRIVANODE_POLICY_LOCKED' : null,
      savedFileIgnored: policyLocked && input.savedPolicyPresent === true, preset: detectPreset(input.policy.policy) },
    capabilities: { source: envCaps !== undefined ? 'environment' : enrolledCaps.length ? 'enrollment' : 'none', configured, disabledByOwner: disabled, advertised: configured.filter(type => !disabled.includes(type)) },
    coordinator: { source: env.PRIVANODE_COORDINATOR_URL !== undefined ? 'environment' : input.enrolled ? 'enrollment' : 'default', host: hostOf(url ?? 'http://127.0.0.1:4010'), editableHere: false },
    panel: { enabled: env.PRIVANODE_PANEL !== 'off', port: Number.isInteger(panelPort) ? panelPort : DEFAULT_PANEL_PORT, source: env.PRIVANODE_PANEL !== undefined || env.PRIVANODE_PANEL_PORT !== undefined ? 'environment' : 'default', editableHere: false },
    storage: { enabled: input.policy.policy.storage.enabled, maxBytes: input.policy.policy.storage.maxBytes, reserveFreeBytes: input.policy.policy.storage.reserveFreeBytes,
      source: input.policy.source.kind === 'saved' ? 'saved' : input.policy.source.kind === 'env-file' ? 'installer-file' : 'default', locked: policyLocked, networkAccessible: null },
    storageFields,
    directTransfer: { configurationError, enabled: configurationError ? false : direct.enabled, bindAddress: direct.bindAddress, port: direct.port, endpoint: reportedTransferEndpoint(direct.endpoint), maxConcurrent: direct.maxConcurrent, maxConcurrentPuts: direct.maxConcurrentPuts,
      certificateConfigured: direct.certificateFile !== '', keyConfigured: direct.keyFile !== '', environmentLocks: Object.entries(TRANSFER_ENV).filter(([, name]) => env[name] !== undefined).map(([key]) => key) },
    name: { value: local.name ?? null, source: local.name === undefined ? 'none' : 'saved' },
    pause: { active: pause !== undefined, kind: pause?.kind ?? null, until: pause?.until ?? null },
    updates: { automatic: false },
  };
}

/** A running node retains its last good policy when a file becomes corrupt; disk fallback is not its effective policy. */
export function withRunningStorageSettings(base: EffectiveSettings, policy: ResolvedPolicy, env: NodeJS.ProcessEnv): EffectiveSettings {
  const live = computeEffectiveSettings({ env, policy, local: { version: 1, disabledCapabilities: [] }, now: Date.now() });
  return { ...base, policy: { ...base.policy, source: live.policy.source, preset: live.policy.preset }, storage: live.storage, directTransfer: live.directTransfer, storageFields: live.storageFields };
}

/** A few plain lines for `privanet-node settings`. */
const gib = (n: number): string => `${n % (1024 ** 3) === 0 ? n / 1024 ** 3 : (n / 1024 ** 3).toFixed(1)} GiB`;
export function renderSettings(s: EffectiveSettings): string {
  const by = (source: string, locked = false): string => locked ? ` (set by the environment; this cannot be changed from the panel or the CLI)` : source === 'saved' ? ' (saved by you)' : source === 'enrollment' ? ' (from enrollment)' : source === 'installer-file' ? ' (the installer\'s policy file)' : source === 'environment' ? ' (set by the environment)' : ' (default)';
  return [
    `Job slots      ${s.jobSlots.value}${by(s.jobSlots.source, s.jobSlots.locked)}${s.jobSlots.restartRequired ? `; saved ${s.jobSlots.saved}, applies at the next start` : ''}`,
    `Policy         ${s.policy.preset}${by(s.policy.source)}${s.policy.locked ? `; LOCKED by ${s.policy.lockedBy}: edits from the panel and the CLI are refused${s.policy.savedFileIgnored ? ', and the saved policy file is ignored' : ''}` : ''}`,
    `Capabilities   ${s.capabilities.advertised.join(', ') || 'none'}${by(s.capabilities.source)}${s.capabilities.disabledByOwner.length ? `; switched off by you: ${s.capabilities.disabledByOwner.join(', ')}` : ''}`,
    `Storage        ${s.storage.enabled ? `ON: up to ${gib(s.storage.maxBytes)}, keeping ${gib(s.storage.reserveFreeBytes)} of disk free` : 'off'}${by(s.storage.source)}${s.policy.locked ? '; locked with the policy' : ''}; opaque chunks`,
    `Transfer       ${s.directTransfer.enabled ? `TLS listener configured on ${s.directTransfer.bindAddress}:${s.directTransfer.port}; endpoint ${s.directTransfer.endpoint}` : 'off (no network access)'}; concurrent ${s.directTransfer.maxConcurrent}, PUTs ${s.directTransfer.maxConcurrentPuts}${s.directTransfer.environmentLocks.length ? `; environment locks: ${s.directTransfer.environmentLocks.join(', ')}` : ''}`,
    ...Object.entries(s.storageFields).map(([key, field]) => `Storage ${key.padEnd(22)} ${typeof field.value === 'number' && ['maxBytes', 'reserveFreeBytes'].includes(key) ? gib(field.value) : String(field.value)} [${field.source}]${field.override ? `; saved ${JSON.stringify(field.saved)}; override ${field.override}` : ''}${field.locked ? '; locked' : ''}`),
    ...(s.directTransfer.configurationError ? [`Transfer configuration: ${s.directTransfer.configurationError}`] : []),
    `Coordinator    ${s.coordinator.host ?? 'unknown'}${by(s.coordinator.source)}; not editable here`,
    `Panel          ${s.panel.enabled ? `on, port ${s.panel.port}` : 'off'}${by(s.panel.source)}; set in the environment`,
    `Name           ${s.name.value ?? '(none)'}${s.name.source === 'saved' ? ' (saved by you; stays on this machine)' : ''}`,
    `Pause          ${s.pause.active ? `${s.pause.kind}${s.pause.until ? ` until ${new Date(s.pause.until).toLocaleString()}` : ''}` : 'not paused'}`,
    `Updates        never automatic; "update check" asks only when you run it`,
  ].join('\n');
}

/** Reads the files and builds the settings for a state directory, with nothing running (the CLI, `config check`) or with the running process's job slots. */
export async function gatherSettings(env: NodeJS.ProcessEnv, stateDir: string, now: number, runningJobSlots?: number): Promise<{ settings: EffectiveSettings; localProblem?: string; policyProblem?: string }> {
  const local = await readLocalState(stateDir);
  const locked = env.PRIVANODE_POLICY_LOCKED === 'true';
  const policy = await resolvePolicy(stateDir, env.PRIVANODE_POLICY_FILE, { locked });
  const enrolled = (() => { try { return readEnrollmentRecordSync(stateDir); } catch { return undefined; } })();
  const savedPolicyPresent = locked && existsSync(policyFilePath(stateDir)) && (await readPolicyFile(stateDir)).kind !== 'absent';
  const settings = computeEffectiveSettings({ env, local: local.state, policy, enrolled: enrolled ? { coordinatorUrl: enrolled.coordinatorUrl, capabilities: enrolled.capabilities } : undefined, runningJobSlots, now, savedPolicyPresent });
  return { settings, ...(local.kind === 'error' ? { localProblem: local.code } : {}), ...(policy.problem ? { policyProblem: policy.problem.code } : {}) };
}

const sourceSchema = z.enum(['environment', 'saved', 'enrollment', 'installer-file', 'default']);
const scalar = z.union([z.boolean(), z.number().finite(), z.string().max(512), z.null()]);
const daemonStorageSettings = z.object({
  storage: z.object({ enabled: z.boolean(), maxBytes: z.number().int().min(0), reserveFreeBytes: z.number().int().min(0), source: z.enum(['saved', 'installer-file', 'default']), locked: z.boolean(), networkAccessible: z.null() }),
  directTransfer: z.object({ enabled: z.boolean(), bindAddress: z.string().max(64), port: z.number().int(), endpoint: z.string().max(512), maxConcurrent: z.number().int(), maxConcurrentPuts: z.number().int(), certificateConfigured: z.boolean(), keyConfigured: z.boolean(), environmentLocks: z.array(z.string().max(64)).max(16), configurationError: z.string().max(64).nullable() }),
  storageFields: z.record(z.string().max(64), z.object({ value: scalar, source: sourceSchema, saved: scalar, override: z.string().max(64).nullable(), locked: z.boolean() })),
});
/** Prefer the daemon's effective storage environment; a login shell may have different overrides. */
export async function preferDaemonStorageSettings(stateDir: string, settings: EffectiveSettings, now = Date.now()): Promise<{ settings: EffectiveSettings; observation: 'daemon' | 'command-environment' }> {
  try {
    const file = StatusFileSchema.parse(JSON.parse(await readPrivateFileUpTo(join(stateDir, STATUS_FILE), 262144)));
    if (file.publishedAt <= now && now - file.publishedAt <= STATUS_STALE_MS) {
      const live = daemonStorageSettings.parse(file.status.storageSettings);
      return { settings: { ...settings, ...live }, observation: 'daemon' };
    }
  } catch { /* absence, invalid or stale snapshots cannot establish running configuration */ }
  return { settings, observation: 'command-environment' };
}
