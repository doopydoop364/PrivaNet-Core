import type { JobType } from '@privanet/protocol';
import { activePause, jobSlotsChoice, readLocalState } from './local-state.js';
import type { LocalState } from './local-state.js';
import { detectPreset } from './presets.js';
import { policyFilePath, readPolicyFile, resolvePolicy } from './policy-store.js';
import type { ResolvedPolicy } from './policy-store.js';
import { readEnrollmentRecordSync } from './enrollment-record.js';
import { existsSync } from 'node:fs';
import { DEFAULT_PANEL_PORT } from './panel-token.js';

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
  storage: { enabled: boolean; maxBytes: number; reserveFreeBytes: number; source: 'saved' | 'installer-file' | 'default'; locked: boolean; networkAccessible: false };
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
  return {
    jobSlots: { value: input.runningJobSlots ?? choice.value, source: choice.source, saved: local.jobSlots ?? null, locked: slotsFromEnv, appliesAtStart: true,
      restartRequired: input.runningJobSlots !== undefined && !slotsFromEnv && local.jobSlots !== undefined && local.jobSlots !== input.runningJobSlots },
    policy: { source: input.policy.source.kind === 'saved' ? 'saved' : input.policy.source.kind === 'env-file' ? 'installer-file' : 'default', locked: policyLocked, lockedBy: policyLocked ? 'PRIVANODE_POLICY_LOCKED' : null,
      savedFileIgnored: policyLocked && input.savedPolicyPresent === true, preset: detectPreset(input.policy.policy) },
    capabilities: { source: envCaps !== undefined ? 'environment' : enrolledCaps.length ? 'enrollment' : 'none', configured, disabledByOwner: disabled, advertised: configured.filter(type => !disabled.includes(type)) },
    coordinator: { source: env.PRIVANODE_COORDINATOR_URL !== undefined ? 'environment' : input.enrolled ? 'enrollment' : 'default', host: hostOf(url ?? 'http://127.0.0.1:4010'), editableHere: false },
    panel: { enabled: env.PRIVANODE_PANEL !== 'off', port: Number.isInteger(panelPort) ? panelPort : DEFAULT_PANEL_PORT, source: env.PRIVANODE_PANEL !== undefined || env.PRIVANODE_PANEL_PORT !== undefined ? 'environment' : 'default', editableHere: false },
    storage: { enabled: input.policy.policy.storage.enabled, maxBytes: input.policy.policy.storage.maxBytes, reserveFreeBytes: input.policy.policy.storage.reserveFreeBytes,
      source: input.policy.source.kind === 'saved' ? 'saved' : input.policy.source.kind === 'env-file' ? 'installer-file' : 'default', locked: policyLocked, networkAccessible: false },
    name: { value: local.name ?? null, source: local.name === undefined ? 'none' : 'saved' },
    pause: { active: pause !== undefined, kind: pause?.kind ?? null, until: pause?.until ?? null },
    updates: { automatic: false },
  };
}

/** A few plain lines for `privanet-node settings`. */
const gib = (n: number): string => `${n % (1024 ** 3) === 0 ? n / 1024 ** 3 : (n / 1024 ** 3).toFixed(1)} GiB`;
export function renderSettings(s: EffectiveSettings): string {
  const by = (source: string, locked = false): string => locked ? ` (set by the environment; this cannot be changed from the panel or the CLI)` : source === 'saved' ? ' (saved by you)' : source === 'enrollment' ? ' (from enrollment)' : source === 'installer-file' ? ' (the installer\'s policy file)' : source === 'environment' ? ' (set by the environment)' : ' (default)';
  return [
    `Job slots      ${s.jobSlots.value}${by(s.jobSlots.source, s.jobSlots.locked)}${s.jobSlots.restartRequired ? `; saved ${s.jobSlots.saved}, applies at the next start` : ''}`,
    `Policy         ${s.policy.preset}${by(s.policy.source)}${s.policy.locked ? `; LOCKED by ${s.policy.lockedBy}: edits from the panel and the CLI are refused${s.policy.savedFileIgnored ? ', and the saved policy file is ignored' : ''}` : ''}`,
    `Capabilities   ${s.capabilities.advertised.join(', ') || 'none'}${by(s.capabilities.source)}${s.capabilities.disabledByOwner.length ? `; switched off by you: ${s.capabilities.disabledByOwner.join(', ')}` : ''}`,
    `Storage        ${s.storage.enabled ? `ON: up to ${gib(s.storage.maxBytes)}, keeping ${gib(s.storage.reserveFreeBytes)} of disk free` : 'off'}${by(s.storage.source)}${s.policy.locked ? '; locked with the policy' : ''}; local only (no network access)`,
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
