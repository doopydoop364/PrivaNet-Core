import { z } from 'zod';
import { IntensitySchema, JobTypeSchema } from '@privanet/protocol';

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
  /** Scratch disk PrivaNet may use, and free space always left to the owner on top of it. */
  maxDiskBytes: bytes.default(1 * GiB),
  reserveDiskBytes: bytes.default(5 * GiB),
  /** Highest disk-I/O intensity class ever offered; the offered class drops further while the owner is using the disk. */
  maxDiskIo: IntensitySchema.default('medium'),
  /** Metered transfer ceiling in bytes per second (null = unlimited). Enforced by the node's transfer meter. */
  maxBandwidthBytesPerSec: z.number().int().min(1).max(2 ** 40).nullable().default(1024 * 1024),
  /** Metered transfer allowance per calendar month, UTC (null = unlimited). */
  monthlyTransferBytes: z.number().int().min(0).max(2 ** 50).nullable().default(10 * GiB),
  /** Optional link speed; enables network-pressure awareness by comparing the host's traffic with it. */
  linkBytesPerSec: z.number().int().min(1).max(2 ** 40).optional(),
  /**
   * Limits for the constrained web-fetch capability (`web.fetch.v1`). These can only tighten what the capability
   * already enforces. `unsafeLocal` is an owner-only development escape hatch that DISABLES SSRF protection for the
   * ranges, ports and names it lists (for example to test against a local server); it can never come from a job,
   * the Coordinator or the environment, and the node logs a fixed event at startup when it is set.
   */
  fetch: z.strictObject({
    denyHosts: z.array(z.string().min(3).max(253)).max(200).default([]),
    allowHosts: z.array(z.string().min(3).max(253)).max(200).optional(),
    minHostDelayMs: z.number().int().min(0).max(60000).default(1000),
    maxRequestsPerMinute: z.number().int().min(1).max(6000).default(60),
    hardTimeoutMs: z.number().int().min(1000).max(60000).default(30000),
    unsafeLocal: z.strictObject({
      allowedCidrs: z.array(z.string().min(3).max(60)).max(16).default([]),
      allowedPorts: z.array(z.number().int().min(1).max(65535)).max(16).default([]),
      hostMap: z.record(z.string().min(3).max(253), z.string().min(2).max(60)).default({}),
    }).optional(),
  }).prefault({}),
  /**
   * The local chunk store (Phase 4.0-alpha.1): opaque, immutable, content-addressed chunks kept on this machine. **Off by default.** It opens no port and nothing can send a chunk to it yet; while it is
   * on and healthy the node offers the Coordinator its free room (0.4.0-alpha.2), and the Coordinator can place and authorize but not move data. `maxBytes` is the most the store may ever hold; `reserveFreeBytes` is the free space on its disk that it must
   * never eat into (the store stops accepting data before either limit is crossed). Lowering a limit never deletes data.
   */
  storage: z.strictObject({
    enabled: z.boolean().default(false),
    maxBytes: bytes.default(1 * GiB),
    reserveFreeBytes: bytes.default(10 * GiB),
  }).prefault({}),
  /** How long HIGH pressure must persist before running preemptible jobs are handed back. */
  preemptAfterMs: z.number().int().min(0).max(600000).default(10000),
});
export type ResourcePolicy = z.infer<typeof ResourcePolicySchema>;
export const defaultResourcePolicy = (): ResourcePolicy => ResourcePolicySchema.parse({});
