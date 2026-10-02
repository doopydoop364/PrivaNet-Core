import type { JobType } from '@privanet/protocol';
import { PROTOCOL_VERSION, SERVICE_VERSION } from '@privanet/protocol';
import type { PrivaNode } from './daemon.js';
import type { ResourceEngine } from './resource-engine.js';
import type { TransferMeter } from './transfer-meter.js';
import type { LocalControl } from './local-control.js';
import { compatibility, explainIdle } from './status.js';
import type { StorageStatus } from './store/status.js';

export interface StatusContext {
  node: PrivaNode; engine: ResourceEngine; control: LocalControl; transfer?: TransferMeter | undefined;
  coordinatorUrl: string; enrolledCapabilities: JobType[]; now?: () => number;
  /** The local chunk store's cached status (absent where there is no store service, as in tests and in `status` of a stopped node). */
  storage?: StorageStatus | undefined;
}
const abbreviate = (nodeId: string | null): string | null => nodeId === null ? null : `${nodeId.slice(0, 13)}…`;
const hostOf = (url: string): string => { try { return new URL(url).hostname; } catch { return ''; } };

/**
 * One document describing the node, used by the control panel and by `privanet-node status --json`. Every field is something the node or its resource engine already
 * holds. It never contains a key, a token, a credential, an environment value or a job payload; the node ID is abbreviated unless `fullId` is asked for.
 * "Configured" limits are what the owner set; "permitted" is the coarse budget the engine derived from them right now; "measured" is what the engine sampled from
 * the host. Verified per-job accounting does not exist yet and is not implied here.
 */
export function buildStatus(context: StatusContext, options: { fullId?: boolean } = {}) {
  const now = (context.now ?? Date.now)(); const snapshot = context.node.snapshot; const report = context.engine.report; const engine = context.engine.state; const view = context.control.view;
  const idle = explainIdle({ now, node: snapshot, report, engine, pause: view.pause, localStateProblem: view.localProblem });
  const refused = idle.reasons.some(reason => reason.code === 'IDENTITY_REFUSED');
  const connection = snapshot.draining ? 'draining' : refused ? 'refused' : snapshot.connected ? 'online' : snapshot.lastFailure ? 'offline' : 'connecting';
  const usage = context.transfer?.usage();
  const policy = view.policy;
  return {
    generatedAt: now,
    node: { localName: view.local.name ?? null, coordinatorLabel: snapshot.coordinatorLabel, id: options.fullId ? snapshot.nodeId : abbreviate(snapshot.nodeId), version: SERVICE_VERSION, protocolVersion: PROTOCOL_VERSION, uptimeMs: now - snapshot.startedAt },
    coordinator: { host: hostOf(context.coordinatorUrl), serviceVersion: snapshot.coordinator?.serviceVersion ?? null, protocolVersion: snapshot.coordinator?.protocolVersion ?? null,
      compatibility: compatibility({ version: SERVICE_VERSION, protocol: PROTOCOL_VERSION }, snapshot.coordinator) },
    connection: { state: connection, lastContactAt: snapshot.lastContactAt, lastFailure: snapshot.lastFailure },
    contribution: { mode: report.contribution, scheduleLevel: engine.scheduleLevel, pressure: report.pressure, pause: view.pause ?? null, preset: view.preset, policySource: view.source ?? null,
      restartRequired: view.restartRequired, problems: [...(view.policyProblem ? [{ code: view.policyProblem.code, issues: view.policyProblem.issues }] : []), ...(view.localProblem ? [{ code: view.localProblem, issues: [] }] : [])] },
    jobs: { active: snapshot.activeJobs, slots: snapshot.slots, counters: snapshot.counters },
    capabilities: context.enrolledCapabilities.map(id => ({ id, enabled: snapshot.advertisedCapabilities.includes(id) })),
    limits: {
      configured: policy ? { maxCpuPercent: policy.maxCpuPercent, reserveCpuPercent: policy.reserveCpuPercent, maxMemoryBytes: policy.maxMemoryBytes, reserveMemoryBytes: policy.reserveMemoryBytes, safetyMarginBytes: policy.safetyMarginBytes,
        maxDiskBytes: policy.maxDiskBytes, reserveDiskBytes: policy.reserveDiskBytes, maxDiskIo: policy.maxDiskIo, maxBandwidthBytesPerSec: policy.maxBandwidthBytesPerSec, monthlyTransferBytes: policy.monthlyTransferBytes, onBattery: policy.onBattery, jobSlots: snapshot.slots.configured } : null,
      permitted: { memoryBytes: report.memoryBudgetBytes, cpuPercent: report.cpuBudgetPercent, diskBytes: report.diskBudgetBytes ?? null, diskIo: report.diskIo ?? null, networkBytes: report.networkBudgetBytes ?? null },
      measured: { ownerCpuPercent: engine.ownerCpuPercent, memoryHeadroomBytes: engine.memoryHeadroomBytes, power: report.power },
      transfer: usage ? { month: usage.month, usedBytes: usage.usedBytes, monthlyBytes: usage.monthlyBytes, remainingBytes: context.transfer?.remainingBytes() ?? null } : null,
      accounting: 'Per-job verified resource accounting does not exist yet: these figures are configured limits, coarse permitted budgets and host samples only.' },
    storage: context.storage ?? null,
    idle,
  };
}
export type StatusDocument = ReturnType<typeof buildStatus>;
