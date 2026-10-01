import { CPU_CLASS_MIN_PERCENT, INTENSITY_RANK, JOB_TYPES } from '@privanet/protocol';
import type { ResourceEstimate, ResourceReport } from '@privanet/protocol';
import type { JobRecord, NodeRecord } from './model.js';
export interface Scheduler {
  choose(node: NodeRecord, pending: JobRecord[]): JobRecord | undefined;
}
/**
 * Budget assumed for nodes that predate resource reporting. Deliberately small: they may only run
 * jobs whose declared needs fit inside it, so an old node is never trusted with heavy work.
 */
export const LEGACY_BUDGET: Pick<ResourceReport, 'memoryBudgetBytes' | 'cpuBudgetPercent'> = Object.freeze({ memoryBudgetBytes: 64 * 1024 * 1024, cpuBudgetPercent: 10 });
type Budget = Pick<ResourceReport, 'memoryBudgetBytes' | 'cpuBudgetPercent'> & Partial<Pick<ResourceReport, 'diskBudgetBytes' | 'diskIo' | 'networkBudgetBytes'>>;
/**
 * True when the node's currently permitted budget covers the job's declared estimate. Disk and
 * network limits apply only when the node reports them; nodes that predate them are not blocked.
 */
export function fitsBudget(estimate: ResourceEstimate, budget: Budget): boolean {
  return estimate.memoryBytes <= budget.memoryBudgetBytes && CPU_CLASS_MIN_PERCENT[estimate.cpu] <= budget.cpuBudgetPercent
    && (budget.diskBudgetBytes === undefined || estimate.diskBytes <= budget.diskBudgetBytes)
    && (budget.diskIo === undefined || INTENSITY_RANK[estimate.diskIo] <= INTENSITY_RANK[budget.diskIo])
    && (budget.networkBudgetBytes === undefined || estimate.networkBytes <= budget.networkBudgetBytes);
}
/**
 * Schedule-aware placement: a job with a known expected duration is not placed on a node whose owner
 * schedule turns contribution OFF sooner than that. The node reports only a coarse hint; a job that
 * still overruns is handled by ordinary preemption/release.
 */
/**
 * A node may run several jobs at once (jobSlots above 1), and the budget it reports is a snapshot that cannot yet
 * include a job leased a moment ago. So before placing another job, the estimates of the jobs it is already running
 * are reserved against that budget: running jobs can never make the node exceed what its owner permitted.
 * With no running job this is the identity, so single-slot behaviour is unchanged.
 */
export function reserve(budget: Budget, running: ResourceEstimate[]): Budget {
  if (running.length === 0) return budget;
  const sum = (pick: (estimate: ResourceEstimate) => number) => running.reduce((total, estimate) => total + pick(estimate), 0);
  return { ...budget,
    memoryBudgetBytes: Math.max(0, budget.memoryBudgetBytes - sum(e => e.memoryBytes)),
    cpuBudgetPercent: Math.max(0, budget.cpuBudgetPercent - sum(e => CPU_CLASS_MIN_PERCENT[e.cpu])),
    ...(budget.diskBudgetBytes === undefined ? {} : { diskBudgetBytes: Math.max(0, budget.diskBudgetBytes - sum(e => e.diskBytes)) }),
    ...(budget.networkBudgetBytes === undefined ? {} : { networkBudgetBytes: Math.max(0, budget.networkBudgetBytes - sum(e => e.networkBytes)) }) };
}
export function outlastsAvailability(estimate: ResourceEstimate, availableForMs: number | undefined): boolean {
  return availableForMs !== undefined && estimate.expectedDurationMs !== null && estimate.expectedDurationMs > availableForMs;
}
/**
 * Fair across applications, oldest-first within one, among jobs the node may take now: capability, a free slot, an ACTIVE (not draining)
 * lifecycle, contribution not PAUSED by the owner's policy, and enough currently permitted budget.
 * Policy lives behind the Scheduler interface so reliability, geography or credits can join later.
 */
export class ResourceAwareScheduler implements Scheduler {
  choose(node: NodeRecord, pending: JobRecord[]): JobRecord | undefined {
    if ((node.lifecycle ?? 'ACTIVE') !== 'ACTIVE' || node.resources?.contribution === 'PAUSED') return undefined;
    const running = pending.filter(job => job.status === 'LEASED' && job.assignedNodeId === node.nodeId);
    if (running.length >= node.jobSlots || node.currentJobs >= node.jobSlots) return undefined;
    const runningEstimates = running.map(job => JOB_TYPES[job.type].resources);
    const general = node.resources ?? LEGACY_BUDGET;
    // Fair between applications: of the jobs this node may take, the next goes to the application with the fewest jobs running right now, and within an
    // application the oldest first. A plain oldest-first rule would make a job submitted behind another application's backlog wait for the whole backlog.
    // Work-conserving (a node is never left idle while an eligible job exists), and unchanged when only one application has work.
    const runningByApp = new Map<string, number>();
    for (const job of pending) if (job.status === 'LEASED') runningByApp.set(job.applicationId, (runningByApp.get(job.applicationId) ?? 0) + 1);
    let best: JobRecord | undefined; let bestLoad = Infinity;
    for (const job of pending) {
      if (job.status !== 'QUEUED') continue;
      const load = runningByApp.get(job.applicationId) ?? 0;
      if (load >= bestLoad) continue; // cannot beat what is already chosen (pending is oldest first, so ties keep the older job)
      const definition = JOB_TYPES[job.type];
      if (!node.capabilities.includes(definition.capability)) continue;
      if (outlastsAvailability(definition.resources, node.resources?.availableForMs)) continue;
      // Per-capability limits replace only memory/CPU; disk and network limits are node-wide.
      const specific = node.resources?.perCapability?.[job.type];
      if (!fitsBudget(definition.resources, reserve(specific ? { ...general, ...specific } : general, runningEstimates))) continue;
      best = job; bestLoad = load; if (load === 0) break;
    }
    return best;
  }
}
