import { CPU_CLASS_MIN_PERCENT, JOB_TYPES } from '@privanet/protocol';
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
/** True when the node's currently permitted budget covers the job's declared estimate. */
export function fitsBudget(estimate: ResourceEstimate, budget: Pick<ResourceReport, 'memoryBudgetBytes' | 'cpuBudgetPercent'>): boolean {
  return estimate.memoryBytes <= budget.memoryBudgetBytes && CPU_CLASS_MIN_PERCENT[estimate.cpu] <= budget.cpuBudgetPercent;
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
      return fitsBudget(definition.resources, node.resources?.perCapability?.[job.type] ?? general);
    });
  }
}
