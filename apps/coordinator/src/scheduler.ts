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
export function outlastsAvailability(estimate: ResourceEstimate, availableForMs: number | undefined): boolean {
  return availableForMs !== undefined && estimate.expectedDurationMs !== null && estimate.expectedDurationMs > availableForMs;
}
/**
 * Oldest-first among jobs the node may take now: capability, a free slot, an ACTIVE (not draining)
 * lifecycle, contribution not PAUSED by the owner's policy, and enough currently permitted budget.
 * Policy lives behind the Scheduler interface so reliability, geography or credits can join later.
 */
export class ResourceAwareScheduler implements Scheduler {
  choose(node: NodeRecord, pending: JobRecord[]): JobRecord | undefined {
    if ((node.lifecycle ?? 'ACTIVE') !== 'ACTIVE' || node.resources?.contribution === 'PAUSED') return undefined;
    const active = pending.filter(job => job.status === 'LEASED' && job.assignedNodeId === node.nodeId).length;
    if (active >= node.jobSlots || node.currentJobs >= node.jobSlots) return undefined;
    const general = node.resources ?? LEGACY_BUDGET;
    return pending.find(job => {
      const definition = JOB_TYPES[job.type];
      if (job.status !== 'QUEUED' || !node.capabilities.includes(definition.capability)) return false;
      if (outlastsAvailability(definition.resources, node.resources?.availableForMs)) return false;
      // Per-capability limits replace only memory/CPU; disk and network limits are node-wide.
      const specific = node.resources?.perCapability?.[job.type];
      return fitsBudget(definition.resources, specific ? { ...general, ...specific } : general);
    });
  }
}
