import { transferConfig } from './store/transfer-config.js';
/* eslint-disable @typescript-eslint/no-explicit-any -- the status document is rendered from a published JSON snapshot whose shape is checked where it is produced (status-document.ts) */
import { openSync, closeSync, writeSync, readFileSync, constants as fsConstants } from 'node:fs';
import { JobTypeSchema, MAX_JOB_SLOTS } from '@privanet/protocol';
import type { JobType } from '@privanet/protocol';
import { isMissing, readPrivateFileUpTo } from '@privanet/shared';
import { checkConfig, policyFindings } from './config-check.js';
import type { Finding } from './config-check.js';
import { activePause, jobSlotsChoice, readLocalState, updateLocalState, makePause } from './local-state.js';
import type { PauseRequest } from './local-state.js';
import { PolicyError, MAX_POLICY_BYTES, exportPolicyText, parsePolicyText, removePolicyFile, resolvePolicy, savePolicyFile } from './policy-store.js';
import { PRESET_IDS, PRESETS, applyPreset, detectPreset } from './presets.js';
import type { PresetId } from './presets.js';
import { readEnrollmentRecordSync } from './enrollment-record.js';
import { DisplayNameSchema } from '@privanet/protocol';
import { StatusFileSchema } from './status-file.js';
import type { StatusFile } from './status-file.js';
import { STATUS_STALE_MS, STATUS_FILE } from './status-file.js';
import { join } from 'node:path';
import { DEFAULT_PANEL_PORT, loadOrCreatePanelToken, panelUrl } from './panel-token.js';
import { explainIdle } from './status.js';
import { diagnose } from './doctor.js';
import { gatherSettings, renderSettings } from './effective-settings.js';
import { inspectStorage } from './store/status.js';
import { UnsafeBundleError, buildSupportBundle } from './support-bundle.js';
import { checkForUpdate } from './update-check.js';
import { SHELLS, completionScript } from './completions.js';
import type { Shell } from './completions.js';

export interface CliIo { out: (text: string) => void; err: (text: string) => void }
export const EXIT_USAGE = 78;
class UsageError extends Error {}
interface Parsed { positional: string[]; flags: Set<string>; values: Map<string, string> }
/** Minimal strict parser: unknown options are refused by name only (never echoing a value that might be a secret). */
function parse(argv: string[], allowed: { flags?: string[]; values?: string[] }): Parsed {
  const flags = new Set<string>(); const values = new Map<string, string>(); const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? ''; if (!arg.startsWith('--')) { positional.push(arg); continue; }
    const equals = arg.indexOf('='); const name = equals > 0 ? arg.slice(0, equals) : arg;
    if (allowed.flags?.includes(name)) flags.add(name);
    else if (allowed.values?.includes(name)) { const value = equals > 0 ? arg.slice(equals + 1) : argv[++i]; if (value === undefined || (equals < 0 && value.startsWith('--'))) throw new UsageError(`${name} needs a value`); values.set(name, value); }
    else throw new UsageError(`unknown option ${name}`);
  }
  return { positional, flags, values };
}
const stateDirOf = (parsed: Parsed, env: NodeJS.ProcessEnv): string => parsed.values.get('--state-dir') ?? env.PRIVANODE_STATE_DIR ?? './var/node';
const COMMON = { flags: ['--json', '--help'], values: ['--state-dir'] };
const label: Record<Finding['severity'], string> = { error: 'ERROR  ', warning: 'WARNING', info: 'INFO   ' };
const renderFindings = (findings: Finding[]): string => findings.map(finding => `  ${label[finding.severity]} ${finding.message}`).join('\n');
const done = (io: CliIo, parsed: Parsed, data: unknown, human: string): void => io.out(parsed.flags.has('--json') ? JSON.stringify(data) + '\n' : human.endsWith('\n') ? human : human + '\n');
const bytes = (n: number | null | undefined): string => n === null || n === undefined ? 'unlimited' : n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(n % 1024 ** 3 === 0 ? 0 : 1)} GiB` : n >= 1024 ** 2 ? `${Math.round(n / 1024 ** 2)} MiB` : `${Math.round(n / 1024)} KiB`;
const ago = (at: number | null, now: number): string => at === null ? 'never' : `${Math.max(0, Math.round((now - at) / 1000))}s ago`;

export const LOCAL_COMMANDS = ['status', 'pause', 'resume', 'config', 'policy', 'name', 'capability', 'slots', 'settings', 'storage', 'panel', 'support-bundle', 'update', 'completions'] as const;

/** `status`: the live document the running node publishes, or an offline view built from the files when it is not running. Never contacts the Coordinator. */
async function statusCommand(argv: string[], env: NodeJS.ProcessEnv, io: CliIo): Promise<number> {
  const parsed = parse(argv, COMMON); const stateDir = stateDirOf(parsed, env); const now = Date.now();
  let file: StatusFile | undefined;
  try { file = StatusFileSchema.parse(JSON.parse(await readPrivateFileUpTo(join(stateDir, STATUS_FILE), 262144))); } catch (error) { if (!isMissing(error)) file = undefined; }
  if (file && now - file.publishedAt <= STATUS_STALE_MS) {
    const doc = file.status as Record<string, any>;
    done(io, parsed, { running: true, ...doc }, renderStatus(doc, now));
    return 0;
  }
  // Not running (or the snapshot is stale): say so, and still show what the files say.
  const local = await readLocalState(stateDir); const pause = activePause(local.state.pause, now);
  const resolved = await resolvePolicy(stateDir, env.PRIVANODE_POLICY_FILE, { locked: env.PRIVANODE_POLICY_LOCKED === 'true' }).catch(() => undefined);
  const idle = explainIdle({ now, node: null, report: null, engine: null, pause, localStateProblem: local.kind === 'error' ? local.code : undefined });
  const offline = { running: false, lastSeenAt: file?.publishedAt ?? null, localName: local.state.name ?? null, pause: pause ?? null, preset: resolved ? detectPreset(resolved.policy) : null,
    policySource: resolved?.source ?? null, disabledCapabilities: local.state.disabledCapabilities, idle };
  done(io, parsed, offline, ['The node is not running (no recent status from it).', file ? `  last seen ${ago(file.publishedAt, now)}` : '  it has not published a status in this state directory',
    `  pause: ${pause ? pause.kind + (pause.until ? ` until ${new Date(pause.until).toLocaleString()}` : '') : 'none'}`, `  preset: ${offline.preset ?? 'unknown'}; policy: ${offline.policySource?.kind ?? 'unknown'}`, '  Start it (for example `sudo systemctl start privanet-node`), then run this again.'].join('\n'));
  return 1;
}
function renderStatus(doc: Record<string, any>, now: number): string {
  const node = doc.node; const coordinator = doc.coordinator; const contribution = doc.contribution; const jobs = doc.jobs; const idle = doc.idle;
  const names = [node.localName, node.coordinatorLabel].filter(Boolean).join(' / ') || '(unnamed)';
  const pause = contribution.pause ? `PAUSED (${contribution.pause.kind}${contribution.pause.until ? ` until ${new Date(contribution.pause.until).toLocaleString()}` : ''})` : contribution.mode;
  const lines = [
    `Node           ${names}  (${node.id ?? 'not connected yet'})  version ${node.version}, protocol ${node.protocolVersion}`,
    `Coordinator    ${coordinator.host || '(unknown)'}  ${doc.connection.state.toUpperCase()}, last contact ${ago(doc.connection.lastContactAt, now)}`,
    `Compatibility  ${coordinator.compatibility.state}: ${coordinator.compatibility.message}`,
    `Contribution   ${pause}  (preset ${contribution.preset}; policy ${contribution.policySource?.kind ?? 'unknown'}; pressure ${contribution.pressure})`,
    `Jobs           ${jobs.active.length} active, ${jobs.slots.effective} slot${jobs.slots.effective === 1 ? '' : 's'}; completed ${jobs.counters.completed}, failed ${jobs.counters.failed}, preempted ${jobs.counters.preempted}, lease lost ${jobs.counters.leaseLost}`,
    `Capabilities   ${doc.capabilities.map((c: any) => `${c.id}${c.enabled ? '' : ' (off)'}`).join(', ') || 'none'}`,
    `Budget now     ${bytes(doc.limits.permitted.memoryBytes)} memory, ${doc.limits.permitted.cpuPercent}% CPU (permitted; your limits: ${doc.limits.configured ? `${doc.limits.configured.maxCpuPercent}% CPU, ${bytes(doc.limits.configured.maxMemoryBytes)} memory` : 'unknown'})`,
    '', `${idle.idle ? 'Idle' : 'Active'}: ${idle.summary}`,
    ...idle.reasons.filter((r: any) => r.message !== idle.summary).map((r: any) => `  - ${r.message}`),
  ];
  for (const problem of contribution.problems) lines.push(`PROBLEM ${problem.code}${problem.issues.length ? ': ' + problem.issues.join('; ') : ''}`);
  if (contribution.restartRequired.length) lines.push(`Restart needed for: ${contribution.restartRequired.join(', ')}`);
  return lines.join('\n');
}

const PAUSES: Record<string, PauseRequest['kind']> = { '15m': '15m', '1h': '1h', tomorrow: 'tomorrow', reboot: 'reboot', indefinitely: 'indefinite', indefinite: 'indefinite' };
async function pauseCommand(argv: string[], env: NodeJS.ProcessEnv, io: CliIo): Promise<number> {
  const parsed = parse(argv, COMMON); const kind = PAUSES[parsed.positional[0] ?? ''];
  if (!kind || parsed.positional.length !== 1) throw new UsageError('usage: privanet-node pause 15m|1h|tomorrow|reboot|indefinite');
  const stateDir = stateDirOf(parsed, env); const now = Date.now(); const pause = makePause({ kind }, now);
  await updateLocalState(stateDir, state => ({ ...state, pause }));
  const until = pause.kind === 'timed' ? ` until ${new Date(pause.until).toLocaleString()}` : pause.kind === 'reboot' ? ' until this machine restarts' : ' until you resume';
  done(io, parsed, { ok: true, pause }, `Contribution paused${until}. A running node picks this up within a few seconds; \`privanet-node resume\` ends it.`);
  return 0;
}
async function resumeCommand(argv: string[], env: NodeJS.ProcessEnv, io: CliIo): Promise<number> {
  const parsed = parse(argv, COMMON);
  await updateLocalState(stateDirOf(parsed, env), state => { const { pause: _pause, ...rest } = state; void _pause; return rest; });
  done(io, parsed, { ok: true }, 'Contribution resumed (subject to your schedule and limits).');
  return 0;
}
async function configCommand(argv: string[], env: NodeJS.ProcessEnv, io: CliIo): Promise<number> {
  const parsed = parse(argv, COMMON);
  if (parsed.positional[0] !== 'check' || parsed.positional.length !== 1) throw new UsageError('usage: privanet-node config check [--json] [--state-dir DIR]');
  const result = await checkConfig({ ...env, PRIVANODE_STATE_DIR: stateDirOf(parsed, env) });
  const human = [`Configuration ${result.ok ? 'is valid' : 'has problems'} (policy: ${result.policy?.source ?? 'defaults'}${result.policy?.preset ? `, preset ${result.policy.preset}` : ''}).`, result.findings.length ? renderFindings(result.findings) : '  No problems found.'].join('\n');
  done(io, parsed, result, human);
  return result.ok ? 0 : 1;
}
async function readPolicyArg(path: string): Promise<string> {
  const { statSync } = await import('node:fs');
  const stat = statSync(path); if (!stat.isFile()) throw new Error('not a regular file'); if (stat.size > MAX_POLICY_BYTES) throw new PolicyError('POLICY_TOO_LARGE');
  return readFileSync(path, 'utf8');
}
async function policyCommand(argv: string[], env: NodeJS.ProcessEnv, io: CliIo): Promise<number> {
  const parsed = parse(argv, { flags: [...COMMON.flags, '--force'], values: COMMON.values }); const stateDir = stateDirOf(parsed, env); const [action, arg] = parsed.positional;
  const context = () => { const enrolled = (() => { try { return readEnrollmentRecordSync(stateDir)?.capabilities; } catch { return undefined; } })(); return { transferEnv: env, jobSlots: Number(env.PRIVANODE_JOB_SLOTS ?? 1) || 1, ...(enrolled ? { capabilities: enrolled } : {}) }; };
  if ((action === 'import' || action === 'reset' || action === 'preset') && env.PRIVANODE_POLICY_LOCKED === 'true') throw new PolicyError('POLICY_LOCKED_BY_ENVIRONMENT', ['PRIVANODE_POLICY_LOCKED=true: the policy file is authoritative here; change that file (or unset the lock) instead']);
  switch (action) {
    case 'show': {
      const resolved = await resolvePolicy(stateDir, env.PRIVANODE_POLICY_FILE, { locked: env.PRIVANODE_POLICY_LOCKED === 'true' });
      done(io, parsed, { source: resolved.source, preset: detectPreset(resolved.policy), problem: resolved.problem ?? null, policy: resolved.policy }, [`Policy in force: ${resolved.source.kind === 'defaults' ? 'conservative defaults' : resolved.source.kind === 'saved' ? `saved policy (${resolved.source.path})` : `policy file (${resolved.source.path})`}; preset: ${detectPreset(resolved.policy)}.`, JSON.stringify(resolved.policy, null, 2)].join('\n'));
      return 0;
    }
    case 'export': {
      if (!arg || parsed.positional.length !== 2) throw new UsageError('usage: privanet-node policy export FILE [--force]');
      const resolved = await resolvePolicy(stateDir, env.PRIVANODE_POLICY_FILE, { locked: env.PRIVANODE_POLICY_LOCKED === 'true' });
      let fd: number;
      try { fd = openSync(arg, fsConstants.O_WRONLY | fsConstants.O_CREAT | (parsed.flags.has('--force') ? fsConstants.O_TRUNC : fsConstants.O_EXCL) | (fsConstants.O_NOFOLLOW ?? 0), 0o600); }
      catch { io.err(`Cannot create ${arg} (it exists? add --force to overwrite).\n`); return 1; }
      try { writeSync(fd, exportPolicyText(resolved.policy, detectPreset(resolved.policy))); } finally { closeSync(fd); }
      done(io, parsed, { ok: true, file: arg }, `Policy exported to ${arg}. It holds resource preferences only: no identity, enrollment, session or secret.`);
      return 0;
    }
    case 'import': {
      if (!arg || parsed.positional.length !== 2) throw new UsageError('usage: privanet-node policy import FILE');
      const incoming = parsePolicyText(await readPolicyArg(arg)); const findings = policyFindings(incoming.policy, context());
      if (findings.some(finding => finding.severity === 'error')) { io.err(`Not imported: the policy is not acceptable.\n${renderFindings(findings.filter(finding => finding.severity === 'error'))}\n`); return 1; }
      await savePolicyFile(stateDir, incoming.policy, incoming.preset ?? detectPreset(incoming.policy));
      done(io, parsed, { ok: true, findings }, ['Policy imported (the previous saved policy, if any, is kept as policy.json.bak). A running node applies it within a few seconds.', findings.length ? renderFindings(findings) : ''].filter(Boolean).join('\n'));
      return 0;
    }
    case 'reset': { const removed = await removePolicyFile(stateDir); done(io, parsed, { ok: true, removed }, removed ? 'Saved policy removed: the installer policy file (or the conservative defaults) applies again.' : 'There was no saved policy.'); return 0; }
    case 'preset': {
      const id = arg as PresetId | undefined;
      if (!id || !PRESET_IDS.includes(id) || parsed.positional.length !== 2) throw new UsageError(`usage: privanet-node policy preset ${PRESET_IDS.join('|')}`);
      const resolved = await resolvePolicy(stateDir, env.PRIVANODE_POLICY_FILE, { locked: env.PRIVANODE_POLICY_LOCKED === 'true' }); const next = applyPreset(resolved.policy, id);
      await savePolicyFile(stateDir, next, id);
      done(io, parsed, { ok: true, preset: id }, `Preset "${PRESETS[id].label}" applied: ${PRESETS[id].summary} Your schedule and per-capability limits were kept.`);
      return 0;
    }
    default: throw new UsageError('usage: privanet-node policy show|export FILE|import FILE|reset|preset NAME');
  }
}
async function nameCommand(argv: string[], env: NodeJS.ProcessEnv, io: CliIo): Promise<number> {
  const parsed = parse(argv, COMMON); const stateDir = stateDirOf(parsed, env); const [action, ...rest] = parsed.positional;
  if (action === 'show') { const local = await readLocalState(stateDir); done(io, parsed, { name: local.state.name ?? null }, local.state.name ? `Local name: ${local.state.name}` : 'No local name set.'); return 0; }
  if (action === 'clear') { await updateLocalState(stateDir, state => { const { name: _name, ...others } = state; void _name; return others; }); done(io, parsed, { ok: true }, 'Local name cleared.'); return 0; }
  if (action === 'set' && rest.length >= 1) {
    const name = DisplayNameSchema.safeParse(rest.join(' ')); if (!name.success) throw new UsageError('a name is letters, digits, spaces and . _ \' - (at most 64 characters)');
    await updateLocalState(stateDir, state => ({ ...state, name: name.data }));
    done(io, parsed, { ok: true, name: name.data }, `Local name set to "${name.data}". It stays on this machine; the Coordinator's label for this node is separate.`);
    return 0;
  }
  throw new UsageError('usage: privanet-node name show|clear|set NAME');
}
/** `storage status`: the local chunk store's switches, limits, usage and health, read from disk without changing anything. There is deliberately no command here that adds, lists or fetches chunks. */
async function storageCommand(argv: string[], env: NodeJS.ProcessEnv, io: CliIo): Promise<number> {
  const parsed = parse(argv, COMMON); const stateDir = stateDirOf(parsed, env);
  if (parsed.positional[0] !== 'status' || parsed.positional.length !== 1) throw new UsageError('usage: privanet-node storage status [--json]');
  const locked = env.PRIVANODE_POLICY_LOCKED === 'true'; const resolved = await resolvePolicy(stateDir, env.PRIVANODE_POLICY_FILE, { locked });
  const status = await inspectStorage(stateDir, resolved.policy.storage); const source = resolved.source.kind === 'saved' ? 'saved' : resolved.source.kind === 'env-file' ? 'installer-file' : 'default';
  const direct = transferConfig(resolved.policy, env);
  const gib = (n: number | null): string => n === null ? 'unknown' : bytes(n);
  done(io, parsed, { ...status, directTransfer: { enabled: direct.enabled, bindAddress: direct.bindAddress, port: direct.port, endpoint: direct.endpoint, maxConcurrent: direct.maxConcurrent, maxConcurrentPuts: direct.maxConcurrentPuts }, policySource: source, locked }, [
    `Storage        ${status.enabled ? 'ENABLED' : 'DISABLED'}   health: ${status.health}${status.error ? `   (${status.error})` : ''}${status.flags.length ? `   flags: ${status.flags.join(', ')}` : ''}`,
    `Policy         ${source}${locked ? '; LOCKED (PRIVANODE_POLICY_LOCKED): the panel and the CLI cannot change it' : ''}`,
    `Quota          ${gib(status.maxBytes)} at most; ${gib(status.reserveFreeBytes)} of the disk always left free`,
    `Stored         ${status.chunkCount} chunk${status.chunkCount === 1 ? '' : 's'}, ${gib(status.committedBytes)}${status.incomingBytes ? `; ${gib(status.incomingBytes)} of unfinished writes` : ''}${status.anomalies ? `; ${status.anomalies} unrecognised entr${status.anomalies === 1 ? 'y' : 'ies'} (left alone)` : ''}`,
    `Room now       ${status.enabled ? gib(status.allowedBytes) : 'none (storage is off)'}${status.freeBytes === null ? '' : `   (disk free: ${gib(status.freeBytes)})`}`,
    `Direct TLS     ${direct.enabled ? 'ENABLED' : 'DISABLED'}; bind ${direct.bindAddress}:${direct.port}; endpoint ${direct.endpoint || 'not configured'}; concurrency ${direct.maxConcurrent} (${direct.maxConcurrentPuts} PUTs)`,
    'Capacity alone opens no transfer listener. Applications use authorized direct TLS transfers. Lowering a limit never deletes data.'].join('\n'));
  return status.health === 'UNSAFE' ? 1 : 0;
}
/** `settings`: what the node is using and where each value comes from (environment, saved, enrollment, installer file, default), and what the panel and CLI cannot change because the environment sets it. */
async function settingsCommand(argv: string[], env: NodeJS.ProcessEnv, io: CliIo): Promise<number> {
  const parsed = parse(argv, COMMON); const stateDir = stateDirOf(parsed, env);
  if (parsed.positional.length > 1 || (parsed.positional[0] !== undefined && parsed.positional[0] !== 'show')) throw new UsageError('usage: privanet-node settings [show] [--json]');
  let running: number | undefined;
  try { const file = StatusFileSchema.parse(JSON.parse(await readPrivateFileUpTo(join(stateDir, STATUS_FILE), 262144))); if (Date.now() - file.publishedAt <= STATUS_STALE_MS) running = (file.status as { jobs?: { slots?: { configured?: number } } }).jobs?.slots?.configured; } catch { /* not running */ }
  const { settings, localProblem, policyProblem } = await gatherSettings(env, stateDir, Date.now(), running);
  done(io, parsed, { ...settings, ...(localProblem ? { localStateProblem: localProblem } : {}), ...(policyProblem ? { policyProblem } : {}) },
    [renderSettings(settings), localProblem ? `PROBLEM ${localProblem}: local-state.json cannot be read; run "privanet-node config check", then fix or remove that file (the node stays paused until then).` : '', policyProblem ? `PROBLEM ${policyProblem}: the saved policy was not applied; run "privanet-node config check".` : ''].filter(Boolean).join('\n'));
  return localProblem || policyProblem ? 1 : 0;
}
/** `slots`: how many jobs may run at once. Saved in the local state; it applies the next time the node starts, and an explicit PRIVANODE_JOB_SLOTS (when set) takes priority. */
async function slotsCommand(argv: string[], env: NodeJS.ProcessEnv, io: CliIo): Promise<number> {
  const parsed = parse(argv, COMMON); const stateDir = stateDirOf(parsed, env); const [action, value] = parsed.positional;
  const fromEnvironment = env.PRIVANODE_JOB_SLOTS !== undefined;
  if (action === 'show' && parsed.positional.length === 1) {
    const local = await readLocalState(stateDir); const configured = Number(env.PRIVANODE_JOB_SLOTS ?? 1) || 1; const choice = jobSlotsChoice(configured, fromEnvironment, local.state.jobSlots);
    done(io, parsed, { slots: choice.value, source: choice.source, saved: local.state.jobSlots ?? null }, `Job slots: ${choice.value} (${choice.source === 'environment' ? 'set by PRIVANODE_JOB_SLOTS, which takes priority' : choice.source === 'saved' ? 'saved with this command or the panel' : 'the default'}).`);
    return 0;
  }
  if (action === 'clear' && parsed.positional.length === 1) { await updateLocalState(stateDir, state => { const { jobSlots: _slots, ...others } = state; void _slots; return others; }); done(io, parsed, { ok: true }, 'Saved job slots cleared; the default applies at the next start.'); return 0; }
  if (action === 'set' && value !== undefined && parsed.positional.length === 2) {
    const slots = /^\d{1,2}$/.test(value) ? Number(value) : NaN;
    if (!(slots >= 1 && slots <= MAX_JOB_SLOTS)) throw new UsageError(`job slots are a whole number from 1 to ${MAX_JOB_SLOTS}`);
    await updateLocalState(stateDir, state => ({ ...state, jobSlots: slots }));
    done(io, parsed, { ok: true, slots, appliesAtNextStart: true, overriddenByEnvironment: fromEnvironment }, `Saved: ${slots} job slot${slots === 1 ? '' : 's'}. It applies the next time the node starts.${fromEnvironment ? ' NOTE: PRIVANODE_JOB_SLOTS is set in this environment and takes priority over it.' : ''}`);
    return 0;
  }
  throw new UsageError('usage: privanet-node slots show|clear|set N');
}
async function capabilityCommand(argv: string[], env: NodeJS.ProcessEnv, io: CliIo): Promise<number> {
  const parsed = parse(argv, COMMON); const stateDir = stateDirOf(parsed, env); const [action, type] = parsed.positional;
  if ((action !== 'enable' && action !== 'disable') || !type || parsed.positional.length !== 2) throw new UsageError('usage: privanet-node capability enable|disable CAPABILITY');
  const capability = JobTypeSchema.safeParse(type); if (!capability.success) throw new UsageError('not a capability this software knows');
  let enrolled: JobType[] | undefined; try { enrolled = readEnrollmentRecordSync(stateDir)?.capabilities; } catch { enrolled = undefined; }
  if (enrolled && !enrolled.includes(capability.data)) { io.err('This node did not enroll with that capability, so there is nothing to switch.\n'); return 1; }
  await updateLocalState(stateDir, state => ({ ...state, disabledCapabilities: action === 'disable' ? [...new Set([...state.disabledCapabilities, capability.data])] : state.disabledCapabilities.filter(item => item !== capability.data) }));
  done(io, parsed, { ok: true, capability: capability.data, enabled: action === 'enable' }, `${capability.data} ${action === 'enable' ? 'enabled' : 'disabled'}. A running node advertises the change within a few seconds.`);
  return 0;
}

async function panelCommand(argv: string[], env: NodeJS.ProcessEnv, io: CliIo): Promise<number> {
  const parsed = parse(argv, { flags: [...COMMON.flags, '--url-only'], values: COMMON.values });
  const port = Number(env.PRIVANODE_PANEL_PORT ?? DEFAULT_PANEL_PORT); if (!Number.isInteger(port) || port < 0 || port > 65535) throw new UsageError('PRIVANODE_PANEL_PORT is not a port number');
  const token = await loadOrCreatePanelToken(stateDirOf(parsed, env));
  if (parsed.flags.has('--url-only')) { io.out(panelUrl(port) + '\n'); return 0; }
  const link = `${panelUrl(port)}#${token}`;
  done(io, parsed, { url: panelUrl(port), signInLink: link }, [`Control panel: ${panelUrl(port)}   (this machine only; it never listens on any other address)`,
    `Sign-in link:  ${link}`, '  The link signs a browser in; the part after # is a secret that never leaves your browser or this terminal. Keep it private.', `  It lives in ${join(stateDirOf(parsed, env), 'panel-token')}; delete that file and restart the node to change it.`, env.PRIVANODE_PANEL === 'off' ? '  NOTE: PRIVANODE_PANEL=off, so the panel is disabled in this environment.' : ''].filter(Boolean).join('\n'));
  return 0;
}

/** `support-bundle`: writes a sanitized troubleshooting file (see support-bundle.ts). It makes no change to the node and sends nothing anywhere; the doctor part contacts only the Coordinator, and `--no-network` skips even that. */
async function supportBundleCommand(argv: string[], env: NodeJS.ProcessEnv, io: CliIo): Promise<number> {
  const parsed = parse(argv, { flags: [...COMMON.flags, '--no-network', '--stdout'], values: [...COMMON.values, '--log-file'] });
  const stateDir = stateDirOf(parsed, env); const now = Date.now();
  const resolved = await resolvePolicy(stateDir, env.PRIVANODE_POLICY_FILE, { locked: env.PRIVANODE_POLICY_LOCKED === 'true' }).catch(() => undefined);
  if (!resolved) { io.err('The policy could not be read; run `privanet-node config check`.\n'); return 1; }
  const local = await readLocalState(stateDir);
  let status: Record<string, unknown> | undefined;
  try { const file = StatusFileSchema.parse(JSON.parse(await readPrivateFileUpTo(join(stateDir, STATUS_FILE), 262144))); if (now - file.publishedAt <= STATUS_STALE_MS) status = file.status; } catch { /* the node is not running */ }
  const config = await checkConfig({ ...env, PRIVANODE_STATE_DIR: stateDir }).catch(() => undefined);
  const storageFacts = await inspectStorage(stateDir, resolved.policy.storage).catch(() => undefined);
  const gathered = await gatherSettings(env, stateDir, now, (status as { jobs?: { slots?: { configured?: number } } } | undefined)?.jobs?.slots?.configured).catch(() => undefined);
  const doctor = parsed.flags.has('--no-network') ? undefined : await diagnose({ stateDir, allowInsecureLoopback: env.PRIVANODE_ALLOW_INSECURE_LOOPBACK === 'true', timeoutMs: 8000, env }).catch(() => undefined);
  let logText: string | undefined;
  const logFile = parsed.values.get('--log-file');
  if (logFile) { try { const { readFileSync, statSync } = await import('node:fs'); const size = statSync(logFile).size; logText = readFileSync(logFile, 'utf8').slice(-Math.min(size, 120000)); } catch { io.err('The log file could not be read; continuing without it.\n'); } }
  let bundle: Record<string, unknown>;
  try { bundle = buildSupportBundle({ env, now, policy: resolved, local: local.state, ...(local.kind === 'error' ? { localProblem: local.code } : {}), status, doctor, logText, settings: gathered?.settings, storage: storageFacts }); }
  catch (error) { if (error instanceof UnsafeBundleError) { io.err(`No bundle was written: something that looks like a secret (${error.kind}) survived redaction. This is a bug in the redaction rules; please report it without attaching anything.\n`); return 1; } throw error; }
  if (config) bundle.configurationCheck = { ok: config.ok, findings: config.findings.map(finding => ({ severity: finding.severity, id: finding.id, ...(finding.setting ? { setting: finding.setting } : {}) })) };
  const text = JSON.stringify(bundle, null, 2) + '\n';
  if (parsed.flags.has('--stdout')) { io.out(text); return 0; }
  const target = parsed.positional[0] ?? `privanet-support-bundle-${new Date(now).toISOString().replace(/[:.]/g, '-')}.json`;
  let fd: number;
  try { fd = openSync(target, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), 0o600); } catch { io.err(`Cannot create ${target} (it already exists?).\n`); return 1; }
  try { writeSync(fd, text); } finally { closeSync(fd); }
  io.out(`Support bundle written to ${target} (readable only by you).\nRead it before you share it: it holds versions, a sanitized configuration and policy, the doctor's output and recent events. Private keys, tokens, authorization headers and secrets are removed or never included.\n`);
  return 0;
}

/** `update check`: a user-initiated, read-only question to the project's release address (see update-check.ts). */
async function updateCommand(argv: string[], io: CliIo): Promise<number> {
  const parsed = parse(argv, COMMON);
  if (parsed.positional[0] !== 'check' || parsed.positional.length !== 1) throw new UsageError('usage: privanet-node update check [--json]');
  const result = await checkForUpdate();
  done(io, parsed, result, [result.message, result.releaseUrl ? `  release notes: ${result.releaseUrl}` : '', result.howToUpgrade ? `  ${result.howToUpgrade}` : ''].filter(Boolean).join('\n'));
  return result.state === 'failed' ? 1 : 0;
}
function completionsCommand(argv: string[], io: CliIo): number {
  const parsed = parse(argv, { flags: ['--help'] }); const shell = parsed.positional[0] as Shell | undefined;
  if (!shell || !SHELLS.includes(shell) || parsed.positional.length !== 1) throw new UsageError(`usage: privanet-node completions ${SHELLS.join('|')}`);
  io.out(completionScript(shell)); return 0;
}

const USAGE = `Usage: privanet-node COMMAND [options]
  status [--json]                      what the node is doing, and why it is idle if it is
  pause 15m|1h|tomorrow|reboot|indefinite     stop contributing for a while (resume ends it)
  resume
  config check [--json]                validate the configuration offline
  policy show|export FILE|import FILE|reset|preset ${PRESET_IDS.join('|')}
  name show|set NAME|clear             this machine's local display name
  capability enable|disable NAME       switch an enrolled capability on or off
  slots show|set N|clear               how many jobs may run at once (applies at the next start)
  storage status [--json]             the local chunk store: switches, limits, usage and health (local only; no file access commands)
  settings [--json]                    what the node is using and where each value comes from; what the environment locks
  panel                                how to open the local control panel
  support-bundle [FILE] [--no-network] [--log-file F]    a sanitized troubleshooting file you can share
  update check [--json]                ask GitHub (only now) whether a newer release exists; nothing is downloaded or installed
  completions bash|zsh|fish|powershell   print a shell completion script (no secrets, no network)
  doctor | enroll | join                 (see each command's --help)
Common options: --state-dir DIR (default: PRIVANODE_STATE_DIR or ./var/node), --json. Exit status: 0 ok, 1 a problem was found, 78 bad usage.`;

/** Dispatches the local-control commands. Returns the exit status; usage errors name the problem without echoing values. */
export async function runLocal(command: string, argv: string[], env: NodeJS.ProcessEnv, io: CliIo): Promise<number> {
  try {
    if (argv.includes('--help') || argv.includes('-h')) { io.out(USAGE + '\n'); return 0; }
    switch (command) {
      case 'status': return await statusCommand(argv, env, io);
      case 'pause': return await pauseCommand(argv, env, io);
      case 'resume': return await resumeCommand(argv, env, io);
      case 'config': return await configCommand(argv, env, io);
      case 'policy': return await policyCommand(argv, env, io);
      case 'name': return await nameCommand(argv, env, io);
      case 'storage': return await storageCommand(argv, env, io);
      case 'settings': return await settingsCommand(argv, env, io);
      case 'slots': return await slotsCommand(argv, env, io);
      case 'capability': return await capabilityCommand(argv, env, io);
      case 'panel': return await panelCommand(argv, env, io);
      case 'support-bundle': return await supportBundleCommand(argv, env, io);
      case 'update': return await updateCommand(argv, io);
      case 'completions': return completionsCommand(argv, io);
      default: io.err(USAGE + '\n'); return EXIT_USAGE;
    }
  } catch (error) {
    if (error instanceof UsageError) { io.err(`${error.message}\n`); return EXIT_USAGE; }
    if (error instanceof PolicyError) { io.err(`Not accepted: ${error.code}${error.issues.length ? '\n  ' + error.issues.join('\n  ') : ''}\n`); return 1; }
    if (error instanceof Error && /^LOCAL_STATE_/.test(error.message)) { io.err(`${command} failed: ${error.message}. The saved local choices (local-state.json in the state directory) cannot be read, so nothing was changed. Run "privanet-node config check"; then fix that file or move it aside (the node stays paused until you do).\n`); return 1; }
    io.err(`${command} failed${error instanceof Error && /^(LOCAL_STATE_|Unsafe|State directory)/.test(error.message) ? `: ${error.message}` : ' (check the state directory exists and is private)'}\n`); return 1;
  }
}
export { USAGE as LOCAL_USAGE };
