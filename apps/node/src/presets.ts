import { ResourcePolicySchema } from './resource-policy.js';
import type { ResourcePolicy } from './resource-policy.js';

const MiB = 1024 ** 2; const GiB = 1024 ** 3;
/**
 * Friendly presets are ordinary resource-policy values, not a second engine: choosing one sets exactly the fields in `PRESET_FIELDS` and nothing else, so an owner's schedule,
 * per-capability ceilings, fetch limits and preemption delay survive a change of preset. `balanced` is exactly the conservative default policy.
 */
export const PRESET_IDS = ['minimal', 'balanced', 'generous', 'maximum-idle'] as const;
export type PresetId = (typeof PRESET_IDS)[number];
export const PRESET_FIELDS = ['maxMemoryBytes', 'reserveMemoryBytes', 'safetyMarginBytes', 'maxCpuPercent', 'reserveCpuPercent', 'onBattery', 'minimalFraction', 'defaultLevel',
  'maxDiskBytes', 'reserveDiskBytes', 'maxDiskIo', 'maxBandwidthBytesPerSec', 'monthlyTransferBytes'] as const;
type PresetValues = Pick<ResourcePolicy, (typeof PRESET_FIELDS)[number]>;

export const PRESETS: Record<PresetId, { label: string; summary: string; values: PresetValues }> = {
  minimal: { label: 'Minimal', summary: 'A very small footprint that leaves most of the machine to you.', values: {
    maxMemoryBytes: 256 * MiB, reserveMemoryBytes: 3 * GiB, safetyMarginBytes: 512 * MiB, maxCpuPercent: 10, reserveCpuPercent: 30, onBattery: 'disable', minimalFraction: 0.1, defaultLevel: 'MINIMAL',
    maxDiskBytes: 512 * MiB, reserveDiskBytes: 10 * GiB, maxDiskIo: 'low', maxBandwidthBytesPerSec: 256 * 1024, monthlyTransferBytes: 2 * GiB } },
  balanced: { label: 'Balanced', summary: 'The default: modest limits that give way quickly when you use the machine.', values: {
    maxMemoryBytes: 1 * GiB, reserveMemoryBytes: 2 * GiB, safetyMarginBytes: 512 * MiB, maxCpuPercent: 25, reserveCpuPercent: 20, onBattery: 'reduce', minimalFraction: 0.1, defaultLevel: 'ADAPTIVE',
    maxDiskBytes: 1 * GiB, reserveDiskBytes: 5 * GiB, maxDiskIo: 'medium', maxBandwidthBytesPerSec: 1 * MiB, monthlyTransferBytes: 10 * GiB } },
  generous: { label: 'Generous', summary: 'More CPU, memory and bandwidth, still keeping a reserve and giving way to you.', values: {
    maxMemoryBytes: 2 * GiB, reserveMemoryBytes: 2 * GiB, safetyMarginBytes: 512 * MiB, maxCpuPercent: 50, reserveCpuPercent: 15, onBattery: 'reduce', minimalFraction: 0.1, defaultLevel: 'ADAPTIVE',
    maxDiskBytes: 4 * GiB, reserveDiskBytes: 5 * GiB, maxDiskIo: 'medium', maxBandwidthBytesPerSec: 4 * MiB, monthlyTransferBytes: 50 * GiB } },
  'maximum-idle': { label: 'Maximum while idle', summary: 'Large limits, offered only while you are not using the machine; no bandwidth or monthly cap.', values: {
    maxMemoryBytes: 4 * GiB, reserveMemoryBytes: 2 * GiB, safetyMarginBytes: 512 * MiB, maxCpuPercent: 90, reserveCpuPercent: 10, onBattery: 'disable', minimalFraction: 0.1, defaultLevel: 'ADAPTIVE',
    maxDiskBytes: 10 * GiB, reserveDiskBytes: 5 * GiB, maxDiskIo: 'high', maxBandwidthBytesPerSec: null, monthlyTransferBytes: null } },
};

/** The policy with a preset's values applied; everything else in the policy is kept, and the result is validated like any other policy. */
export function applyPreset(policy: ResourcePolicy, id: PresetId): ResourcePolicy {
  return ResourcePolicySchema.parse({ ...policy, ...PRESETS[id].values });
}
/** Which preset a policy currently matches exactly, or 'custom'. Changing any single preset field therefore switches to custom without any bookkeeping. */
export function detectPreset(policy: ResourcePolicy): PresetId | 'custom' {
  for (const id of PRESET_IDS) {
    const values = PRESETS[id].values;
    if (PRESET_FIELDS.every(field => policy[field] === values[field])) return id;
  }
  return 'custom';
}
