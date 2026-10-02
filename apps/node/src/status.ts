import type { ResourceReport } from '@privanet/protocol';
import type { NodeSnapshot } from './daemon.js';
import type { Blocker, Constraint, EngineState } from './resource-engine.js';
import type { ActivePause } from './local-state.js';

export type ReasonSeverity = 'blocking' | 'limiting' | 'info';
export interface IdleReason { code: string; severity: ReasonSeverity; message: string }
export interface IdleExplanation { idle: boolean; summary: string; reasons: IdleReason[] }

/** Everything the explanation is derived from. Nothing here is a guess: each field is something the node or its resource engine actually measured or was told. */
export interface ExplainInput {
  now: number; node: NodeSnapshot | null; report: ResourceReport | null; engine: EngineState | null; pause: ActivePause | undefined;
  /** A problem reading the owner's saved choices (the node is then held paused until fixed). */
  localStateProblem?: string | undefined;
}

const clock = (at: number): string => new Date(at).toLocaleString();
const BLOCKERS: Record<Blocker, (input: ExplainInput) => string> = {
  PAUSED_BY_OWNER: input => input.pause?.kind === 'timed' && input.pause.until ? `Node is paused by you until ${clock(input.pause.until)}.` : input.pause?.kind === 'reboot' ? 'Node is paused by you until this machine restarts.' : 'Node is paused by you.',
  SCHEDULE_OFF: () => 'Your contribution schedule is OFF at this time.',
  ON_BATTERY: () => 'The machine is on battery and your settings disable contribution on battery.',
  MEMORY_PRESSURE: () => 'Memory is too tight: your reserve of free memory is not available, so no work is accepted.',
  CPU_PRESSURE: () => 'CPU pressure is too high: you are using the machine heavily, so no work is accepted.',
  POLICY_ZERO_LIMIT: () => 'Your limits allow no CPU or no memory, so no work can be accepted.',
};
const CONSTRAINTS: Record<Constraint, string> = {
  DISK_BUDGET_EXHAUSTED: 'The scratch-disk budget is exhausted (the disk limit or your free-space reserve leaves nothing), so jobs that need disk are not offered.',
  TRANSFER_ALLOWANCE_EXHAUSTED: 'The monthly transfer allowance is used up, so jobs that move data are not offered until next month.',
  MEMORY_BUDGET_ZERO: 'The memory reserve leaves nothing to offer right now.',
  CPU_BUDGET_ZERO: 'You are using enough CPU that nothing is offered right now.',
  BATTERY_REDUCED: 'On battery: contribution is reduced to the minimal level.',
  PRESSURE_ELEVATED: 'The machine is moderately busy, so the offered budget is halved.',
};

/** Why this node is (or is not) doing work, from actual state. When nothing stops it and it has asked for work and been told there is none, the answer is exactly that. */
export function explainIdle(input: ExplainInput): IdleExplanation {
  const reasons: IdleReason[] = []; const { node, engine } = input;
  const add = (code: string, severity: ReasonSeverity, message: string) => reasons.push({ code, severity, message });
  if (input.localStateProblem) add('LOCAL_STATE_UNREADABLE', 'blocking', 'Your saved local choices (pause, name, capabilities) cannot be read, so the node is held paused until that is fixed: run `privanet-node status` or the config check.');
  if (node?.draining) add('NODE_DRAINING', 'blocking', 'The node is draining: it accepts no new work and will stop.');
  const failure = node?.lastFailure;
  if (failure && !node?.connected) {
    if (failure.status === 401) add('IDENTITY_REFUSED', 'blocking', 'The Coordinator refused this node\'s identity (it was revoked or is unknown there). Ask the owner; this node needs a new invite.');
    else if (failure.status === 426 || failure.code === 'PROTOCOL_MISMATCH') add('PROTOCOL_INCOMPATIBLE', 'blocking', 'The node and the Coordinator speak different protocol versions. Update the node (or ask the owner to update the Coordinator).');
    else if (failure.code === 'TRANSPORT_ERROR') add('COORDINATOR_UNREACHABLE', 'blocking', `The Coordinator cannot be reached (${(failure.reason ?? 'error').toLowerCase().replaceAll('_', ' ')}). Run the doctor for the failing stage.`);
    else add('COORDINATOR_REFUSED', 'blocking', `The Coordinator answered with an error (${failure.code}). Run the doctor.`);
  } else if (node && !node.connected && node.lastContactAt === null) add('NOT_CONNECTED_YET', 'blocking', 'The node has not connected to the Coordinator yet.');
  if (engine) for (const blocker of engine.blockers) add(blocker, 'blocking', BLOCKERS[blocker](input));
  if (node && node.advertisedCapabilities.length === 0) add('ALL_CAPABILITIES_DISABLED', 'blocking', node.enrolledCapabilities.length === 0 ? 'This node has no capabilities, so no job type can be sent to it.' : 'Every capability is switched off, so no job type can be sent to it.');
  if (engine && !engine.blockers.length) for (const constraint of engine.constraints) add(constraint, 'limiting', CONSTRAINTS[constraint]);
  const blocked = reasons.some(reason => reason.severity === 'blocking');
  if (!blocked && node) {
    if (node.activeJobs.length >= node.slots.effective) add('ALL_SLOTS_BUSY', 'info', `All ${node.slots.effective} job slot${node.slots.effective === 1 ? ' is' : 's are'} busy.`);
    else if (node.activeJobs.length > 0) add('WORKING', 'info', `Working on ${node.activeJobs.length} job${node.activeJobs.length === 1 ? '' : 's'}.`);
    else if (node.lastLease?.result === 'empty') add('NO_COMPATIBLE_JOBS', 'info', 'No compatible jobs are currently available: the Coordinator was asked for work and had none for this node.');
    else if (node.lastLease === null) add('NOT_ASKED_YET', 'info', 'Connected; the node has not asked for work yet.');
  }
  if (!node) add('NODE_NOT_RUNNING', 'blocking', 'The node program is not running, so there is no live state to explain. Start the service, then check again.');
  const idle = blocked || !reasons.some(reason => reason.code === 'WORKING' || reason.code === 'ALL_SLOTS_BUSY');
  const first = reasons.find(reason => reason.severity === 'blocking') ?? reasons[0];
  return { idle, summary: first?.message ?? 'Idle.', reasons };
}

export type CompatibilityState = 'current' | 'coordinator-newer' | 'node-newer' | 'incompatible' | 'unknown';
const parts = (version: string): number[] => (/^(\d+)\.(\d+)\.(\d+)/.exec(version)?.slice(1, 4).map(Number)) ?? [0, 0, 0];
export function compareVersions(a: string, b: string): number {
  const x = parts(a); const y = parts(b);
  for (let i = 0; i < 3; i++) { const d = (x[i] ?? 0) - (y[i] ?? 0); if (d !== 0) return d < 0 ? -1 : 1; }
  return 0;
}
/** Software version and protocol version are separate things: a different software version is not a failure; a different protocol is. */
export function compatibility(node: { version: string; protocol: number }, coordinator: { serviceVersion: string; protocolVersion: number } | null): { state: CompatibilityState; message: string } {
  if (!coordinator) return { state: 'unknown', message: 'Not connected to the Coordinator yet, so compatibility is not known.' };
  if (coordinator.protocolVersion !== node.protocol) return { state: 'incompatible', message: `Protocol mismatch: this node speaks protocol ${node.protocol}, the Coordinator ${coordinator.protocolVersion}. Update whichever is older.` };
  const order = compareVersions(node.version, coordinator.serviceVersion);
  if (order === 0) return { state: 'current', message: `Node and Coordinator run the same version (${node.version}); protocol ${node.protocol}.` };
  if (order < 0) return { state: 'coordinator-newer', message: `The Coordinator is newer (${coordinator.serviceVersion}, this node ${node.version}) but compatible: protocol ${node.protocol} on both. Updating this node is optional.` };
  return { state: 'node-newer', message: `This node is newer (${node.version}, the Coordinator ${coordinator.serviceVersion}) but compatible: protocol ${node.protocol} on both.` };
}
