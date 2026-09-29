import { JOB_TYPES } from '@privanet/protocol';
import type { JobRecord, NodeRecord } from './model.js';
export interface Scheduler {
  choose(node: NodeRecord, pending: JobRecord[]): JobRecord | undefined;
}
export class FifoScheduler implements Scheduler {
  choose(node: NodeRecord, pending: JobRecord[]): JobRecord | undefined {
    const active = pending.filter(job => job.status === 'LEASED' && job.assignedNodeId === node.nodeId).length;
    if (active >= node.jobSlots || node.currentJobs >= node.jobSlots) return undefined;
    return pending.find(job => job.status === 'QUEUED' && node.capabilities.includes(JOB_TYPES[job.type].capability));
  }
}
