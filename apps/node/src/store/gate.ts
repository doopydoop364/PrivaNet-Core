import type { GateVerdict } from './chunk-store.js';

/**
 * Whether the local store may begin a write right now, from the node's own state: the policy switch, a drain, the owner's pause, a schedule that turns contribution off, battery rules
 * and a disk the owner is busy using. It reuses the resource engine's verdicts (nothing here is a second resource-control system) and only ever answers with one of these words.
 * Reads, checks and deletes are never gated: they only reduce what is stored.
 */
export interface GateInputs {
  enabled: () => boolean; draining: () => boolean;
  engine: { state: { blockers: readonly string[] }; report: { diskIo?: string | undefined; contribution?: string | undefined } };
}
export function storageGate(inputs: GateInputs): () => GateVerdict {
  return () => {
    if (!inputs.enabled()) return { allowed: false, reason: 'DISABLED' };
    if (inputs.draining()) return { allowed: false, reason: 'DRAINING' };
    const { blockers } = inputs.engine.state;
    if (blockers.includes('PAUSED_BY_OWNER')) return { allowed: false, reason: 'PAUSED' };
    if (blockers.includes('SCHEDULE_OFF')) return { allowed: false, reason: 'SCHEDULE_OFF' };
    if (blockers.includes('ON_BATTERY')) return { allowed: false, reason: 'ON_BATTERY' };
    if (inputs.engine.report.diskIo === 'none') return { allowed: false, reason: 'DISK_BUSY' };
    return { allowed: true };
  };
}
