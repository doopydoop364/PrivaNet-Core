import { z } from 'zod';
import { JobTypeSchema } from '@privanet/protocol';

const GiB = 1024 ** 3;
const bytes = z.number().int().min(0).max(2 ** 40);
const percent = z.number().int().min(0).max(100);
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const LevelSchema = z.enum(['FULL', 'ADAPTIVE', 'MINIMAL', 'OFF']);
export type Level = z.infer<typeof LevelSchema>;
export const ScheduleRuleSchema = z.strictObject({
  /** 0 = Sunday ... 6 = Saturday, in the node machine's local time. */
  days: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  /** Local HH:MM, `from` inclusive, `to` exclusive. `to` <= `from` wraps past midnight. */
  from: clock, to: clock, level: LevelSchema,
});
export type ScheduleRule = z.infer<typeof ScheduleRuleSchema>;
/**
 * Operator-owned limits. The Coordinator can never raise any of these: it only sees the
 * resulting budget. Defaults are conservative: a small footprint that leaves the owner room.
 */
export const ResourcePolicySchema = z.strictObject({
  maxMemoryBytes: bytes.default(1 * GiB),
  reserveMemoryBytes: bytes.default(2 * GiB),
  safetyMarginBytes: bytes.default(512 * 1024 * 1024),
  maxCpuPercent: percent.default(25),
  /** CPU percent always left to the owner and the OS on top of what they currently use. */
  reserveCpuPercent: percent.default(20),
  onBattery: z.enum(['normal', 'reduce', 'disable']).default('reduce'),
  /** Fraction of the adaptive budget offered at the MINIMAL level. */
  minimalFraction: z.number().min(0).max(1).default(0.1),
  /** Level when no schedule rule matches. */
  defaultLevel: LevelSchema.default('ADAPTIVE'),
  schedule: z.array(ScheduleRuleSchema).max(64).default([]),
  /** Per-capability ceilings; they can only lower, never raise, the general budget. */
  capabilityLimits: z.partialRecord(JobTypeSchema, z.strictObject({ maxMemoryBytes: bytes.optional(), maxCpuPercent: percent.optional() })).default({}),
  /** How long HIGH pressure must persist before running preemptible jobs are handed back. */
  preemptAfterMs: z.number().int().min(0).max(600000).default(10000),
});
export type ResourcePolicy = z.infer<typeof ResourcePolicySchema>;
export const defaultResourcePolicy = (): ResourcePolicy => ResourcePolicySchema.parse({});
