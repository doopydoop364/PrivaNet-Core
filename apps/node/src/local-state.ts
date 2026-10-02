import { join } from 'node:path';
import { uptime } from 'node:os';
import { statSync } from 'node:fs';
import { z } from 'zod';
import { DisplayNameSchema, JobTypeSchema } from '@privanet/protocol';
import { isMissing, privateDirectory, readPrivateFileUpTo, replacePrivateFile } from '@privanet/shared';

/**
 * Choices the owner makes on this machine that are not resource limits: a pause, a local display name, and capabilities switched off. They live next to the identity in
 * the private state directory, never leave the machine, and are not part of the policy (so exporting a policy never carries them). A pause is not revocation and not
 * an enrollment state: the node stays enrolled and keeps its identity throughout.
 */
export const LOCAL_STATE_FILE = 'local-state.json';
export const LOCAL_STATE_VERSION = 1;
const PauseSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('timed'), until: z.number().int().min(0), setAt: z.number().int().min(0) }),
  /** Until the machine next restarts: remembered as the boot time, so restarting the node program alone does not clear it. */
  z.strictObject({ kind: z.literal('reboot'), bootTime: z.number().int().min(0), setAt: z.number().int().min(0) }),
  z.strictObject({ kind: z.literal('indefinite'), setAt: z.number().int().min(0) }),
]);
export type Pause = z.infer<typeof PauseSchema>;
export const LocalStateSchema = z.strictObject({
  version: z.literal(LOCAL_STATE_VERSION),
  /** What this machine calls itself in the panel: purely local, never sent anywhere. */
  name: DisplayNameSchema.optional(),
  pause: PauseSchema.optional(),
  /** Capabilities the owner has switched off (the node then does not advertise them); only ever a subset of what the node enrolled with. */
  disabledCapabilities: z.array(JobTypeSchema).max(32).default([]),
});
export type LocalState = z.infer<typeof LocalStateSchema>;
export const emptyLocalState = (): LocalState => ({ version: LOCAL_STATE_VERSION, disabledCapabilities: [] });
export const localStatePath = (stateDir: string): string => join(stateDir, LOCAL_STATE_FILE);

export type PauseRequest = { kind: '15m' | '1h' | 'tomorrow' | 'reboot' | 'indefinite' };
/** The machine's boot time, from its uptime (to within a couple of seconds). */
export const bootTimeMs = (now: number): number => now - Math.round(uptime() * 1000);
/** The next local midnight strictly after `now`: what "until tomorrow" means. */
export function nextLocalMidnight(now: number): number { const date = new Date(now); date.setHours(24, 0, 0, 0); return date.getTime(); }
export function makePause(request: PauseRequest, now: number, boot: number = bootTimeMs(now)): Pause {
  switch (request.kind) {
    case '15m': return { kind: 'timed', until: now + 15 * 60000, setAt: now };
    case '1h': return { kind: 'timed', until: now + 3600000, setAt: now };
    case 'tomorrow': return { kind: 'timed', until: nextLocalMidnight(now), setAt: now };
    case 'reboot': return { kind: 'reboot', bootTime: boot, setAt: now };
    case 'indefinite': return { kind: 'indefinite', setAt: now };
  }
}
/** Seconds of drift tolerated when deciding that the machine has not rebooted (uptime-derived boot times wobble by a second or two). */
const BOOT_TOLERANCE_MS = 120000;
export interface ActivePause { kind: Pause['kind']; until?: number }
/** The pause in force at `now`, or undefined when there is none or it has run out (a timed pause ends by itself; a reboot pause ends after a reboot). */
export function activePause(pause: Pause | undefined, now: number, boot: number = bootTimeMs(now)): ActivePause | undefined {
  if (!pause) return undefined;
  if (pause.kind === 'timed') return pause.until > now ? { kind: 'timed', until: pause.until } : undefined;
  if (pause.kind === 'reboot') return Math.abs(boot - pause.bootTime) <= BOOT_TOLERANCE_MS ? { kind: 'reboot' } : undefined;
  return { kind: 'indefinite' };
}

export type LocalStateRead = { kind: 'ok'; state: LocalState } | { kind: 'absent'; state: LocalState } | { kind: 'error'; code: 'LOCAL_STATE_INVALID' | 'LOCAL_STATE_NEWER' | 'LOCAL_STATE_UNSAFE'; state: LocalState };
/** Never throws. A file that cannot be understood is reported (and left untouched) rather than treated as "no choices". */
export async function readLocalState(stateDir: string): Promise<LocalStateRead> {
  try {
    const raw: unknown = JSON.parse(await readPrivateFileUpTo(localStatePath(stateDir), 16384));
    if (typeof raw === 'object' && raw !== null && typeof (raw as { version?: unknown }).version === 'number' && (raw as { version: number }).version > LOCAL_STATE_VERSION) return { kind: 'error', code: 'LOCAL_STATE_NEWER', state: emptyLocalState() };
    const parsed = LocalStateSchema.safeParse(raw);
    return parsed.success ? { kind: 'ok', state: parsed.data } : { kind: 'error', code: 'LOCAL_STATE_INVALID', state: emptyLocalState() };
  } catch (error) {
    if (isMissing(error)) return { kind: 'absent', state: emptyLocalState() };
    return { kind: 'error', code: error instanceof SyntaxError ? 'LOCAL_STATE_INVALID' : 'LOCAL_STATE_UNSAFE', state: emptyLocalState() };
  }
}
/** Read-modify-write, atomic. Refuses to overwrite a file it cannot understand (so a newer version's choices are never destroyed). */
export async function updateLocalState(stateDir: string, change: (state: LocalState) => LocalState): Promise<LocalState> {
  const current = await readLocalState(stateDir);
  if (current.kind === 'error') throw new Error(current.code);
  const next = LocalStateSchema.parse(change(structuredClone(current.state)));
  await replacePrivateFile(localStatePath(await privateDirectory(stateDir)), JSON.stringify(next, null, 2) + '\n');
  return next;
}
/** Cheap change detector for the daemon's poll: the modification time and size of the file (or 'none'). */
export function localStateStamp(stateDir: string): string {
  try { const stat = statSync(localStatePath(stateDir)); return `${stat.mtimeMs}:${stat.size}`; } catch { return 'none'; }
}
