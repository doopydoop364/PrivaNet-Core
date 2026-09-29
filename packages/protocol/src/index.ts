import { z } from 'zod';

export const PROTOCOL_VERSION = 1 as const;
export const SERVICE_VERSION = '0.2.1';
export const MAX_BODY_BYTES = 32 * 1024;
export const ProtocolSchema = z.literal(PROTOCOL_VERSION);
export const IdSchema = z.uuid();
export const NodeIdSchema = z.string().regex(/^node_[a-f0-9]{64}$/);
export const SecretSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const TimeSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const EchoSchema = z.strictObject({ message: z.string().max(1024) });
/** Coarse intensity classes shared by job estimates and node budgets. */
export const IntensitySchema = z.enum(['none', 'low', 'medium', 'high']);
/** Ordering of intensity classes, used to compare a job's disk-I/O need with a node's permitted level. */
export const INTENSITY_RANK = Object.freeze({ none: 0, low: 1, medium: 2, high: 3 } as const);
/** Minimum node CPU budget (percent of the machine) required to run a job of each CPU class. */
export const CPU_CLASS_MIN_PERCENT = Object.freeze({ none: 0, low: 5, medium: 25, high: 50 } as const);
const ByteCountSchema = z.number().int().min(0).max(2 ** 40);
/**
 * Scheduler hints and policy inputs, never permission to exceed a node's own limits. Every
 * registered job type must declare them so future job types cannot be scheduled blind.
 */
export const ResourceEstimateSchema = z.strictObject({
  cpu: IntensitySchema, memoryBytes: ByteCountSchema, diskBytes: ByteCountSchema, diskIo: IntensitySchema,
  networkBytes: ByteCountSchema, expectedDurationMs: z.number().int().min(1).max(86400000).nullable(),
  preemptible: z.boolean(), checkpointable: z.boolean(),
});
export type ResourceEstimate = z.infer<typeof ResourceEstimateSchema>;
const ECHO_RESOURCES: ResourceEstimate = Object.freeze({
  cpu: 'low', memoryBytes: 1024 * 1024, diskBytes: 0, diskIo: 'none', networkBytes: 4096,
  expectedDurationMs: 100, preemptible: true, checkpointable: false,
});
/** Longest hash chain a single job may request; sized so a job takes seconds to a few minutes on ordinary hardware. */
export const HASHCHAIN_MAX_ITERATIONS = 5_000_000;
export const HashChainInputSchema = z.strictObject({ seed: z.string().max(256), iterations: z.number().int().min(1).max(HASHCHAIN_MAX_ITERATIONS) });
export const HashChainOutputSchema = z.strictObject({ digest: z.string().regex(/^[a-f0-9]{64}$/), iterations: z.number().int().min(1).max(HASHCHAIN_MAX_ITERATIONS) });
/**
 * A deterministic, verifiable, CPU-bound, preemptible and checkpointable diagnostic workload. It exists
 * so preemption, checkpoint/resume and resource-aware placement are exercised by a real, slow job type
 * (not only by instantaneous echo), and to calibrate resource declarations. Not an application feature.
 */
const HASHCHAIN_RESOURCES: ResourceEstimate = Object.freeze({
  cpu: 'medium', memoryBytes: 16 * 1024 * 1024, diskBytes: 1024 * 1024, diskIo: 'low', networkBytes: 4096,
  expectedDurationMs: 30000, preemptible: true, checkpointable: true,
});
export const JOB_TYPES = Object.freeze({
  'system.echo.v1': Object.freeze({ version: 1, capability: 'system.echo.v1', input: EchoSchema, output: EchoSchema, resources: ECHO_RESOURCES }),
  'system.hashchain.v1': Object.freeze({ version: 1, capability: 'system.hashchain.v1', input: HashChainInputSchema, output: HashChainOutputSchema, resources: HASHCHAIN_RESOURCES }),
});
export type JobType = keyof typeof JOB_TYPES;
export type JobInputMap = { [T in JobType]: z.infer<(typeof JOB_TYPES)[T]['input']> };
export type JobOutputMap = { [T in JobType]: z.infer<(typeof JOB_TYPES)[T]['output']> };
// Every wire schema derives from the registry: adding a job type means adding one entry
// above (plus a node-side handler). Nothing else on the wire accepts unregistered types.
export const JOB_TYPE_IDS = Object.keys(JOB_TYPES) as [JobType, ...JobType[]];
export const JobTypeSchema = z.enum(JOB_TYPE_IDS);
export const CapabilitiesSchema = z.array(JobTypeSchema).max(JOB_TYPE_IDS.length)
  .refine(list => new Set(list).size === list.length, 'duplicate capability');
type Payload = { type: JobType; input?: unknown; result?: unknown };
/** Validates payload fields against the schema registered for `type`; never trusts the sender's shape. */
function registered<S extends z.ZodType<Payload>>(schema: S) {
  return schema.superRefine((value, ctx) => {
    const definition = JOB_TYPES[value.type];
    if ('input' in value && !definition.input.safeParse(value.input).success) ctx.addIssue({ code: 'custom', path: ['input'], message: 'invalid job input' });
    if (value.result != null && !definition.output.safeParse(value.result).success) ctx.addIssue({ code: 'custom', path: ['result'], message: 'invalid job result' });
  });
}
export const VersionSchema = z.string().regex(/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/).max(64);
export const HealthSchema = z.strictObject({
  protocolVersion: ProtocolSchema, serviceVersion: VersionSchema, coordinatorId: IdSchema, status: z.literal('ok'),
});
export const ErrorSchema = z.strictObject({ error: z.strictObject({ code: z.string().max(64), message: z.string().max(256) }) });
export const EnrollmentTokenRequestSchema = z.strictObject({
  expiresInMs: z.number().int().min(1000).max(86400000), capabilities: CapabilitiesSchema,
});
export const EnrollmentTokenSchema = z.strictObject({ token: SecretSchema, expiresAt: TimeSchema });
export const EnrollmentStartSchema = z.strictObject({
  token: SecretSchema, publicKey: z.string().min(40).max(256), protocolVersion: ProtocolSchema,
  daemonVersion: VersionSchema, capabilities: CapabilitiesSchema,
});
export const AuthStartSchema = z.strictObject({ nodeId: NodeIdSchema, protocolVersion: ProtocolSchema });
export const ProofMessageSchema = z.strictObject({
  domain: z.literal('privanet.node-proof.v1'), coordinatorId: IdSchema,
  purpose: z.enum(['enroll', 'auth']), nodeId: NodeIdSchema, nonce: SecretSchema,
});
export const ChallengeSchema = z.strictObject({
  challengeId: IdSchema, message: z.string().max(512), expiresAt: TimeSchema, coordinatorId: IdSchema,
});
export const ProofSchema = z.strictObject({ challengeId: IdSchema, signature: z.string().regex(/^[a-f0-9]{128}$/) });
export const SessionSchema = z.strictObject({ nodeId: NodeIdSchema, token: SecretSchema, expiresAt: TimeSchema, coordinatorId: IdSchema });
/** What the owner's policy currently lets PrivaNet use. PAUSED means: assign this node no new work. */
export const ContributionSchema = z.enum(['FULL', 'ADAPTIVE', 'MINIMAL', 'PAUSED']);
export const PressureSchema = z.enum(['NORMAL', 'ELEVATED', 'HIGH']);
export const PowerSchema = z.enum(['AC', 'BATTERY', 'UNKNOWN']);
/**
 * Deliberately minimal telemetry: the current permitted budget and coarse states, not raw host
 * measurements. `memoryBudgetBytes` is the additional memory a new job may use right now.
 */
const BudgetSchema = z.strictObject({ memoryBudgetBytes: ByteCountSchema, cpuBudgetPercent: z.number().int().min(0).max(100) });
export const ResourceReportSchema = z.strictObject({
  contribution: ContributionSchema, pressure: PressureSchema, power: PowerSchema,
  memoryBudgetBytes: ByteCountSchema, cpuBudgetPercent: z.number().int().min(0).max(100),
  /** Operator-set capability-specific limits; a capability listed here uses this budget instead of the general one. */
  perCapability: z.partialRecord(JobTypeSchema, BudgetSchema).optional(),
  // Additive within protocol 1 (v0.2.1): absent means "not reported", and the Coordinator then applies no limit of that kind.
  /** Scratch disk a new job may use right now (owner limit and free space, less the owner's reserve). */
  diskBudgetBytes: ByteCountSchema.optional(),
  /** Highest disk-I/O intensity class a new job may have right now (lower while the owner is using the disk). */
  diskIo: IntensitySchema.optional(),
  /** Network transfer a new job may use (remaining monthly allowance, bounded by the owner's limit). */
  networkBudgetBytes: ByteCountSchema.optional(),
  /** Milliseconds until the owner's schedule next turns contribution OFF; absent when it does not within a week. Placement hint only. */
  availableForMs: z.number().int().min(0).max(7 * 86400000).optional(),
});
export type ResourceReport = z.infer<typeof ResourceReportSchema>;
/** ACTIVE accepts work; DRAINING finishes/releases work and asks for none. Departure is a separate goodbye. */
export const LifecycleSchema = z.enum(['ACTIVE', 'DRAINING']);
// Additive within protocol 1: both fields are optional, so nodes that predate them keep working.
export const HeartbeatSchema = z.strictObject({
  protocolVersion: ProtocolSchema, daemonVersion: VersionSchema, capabilities: CapabilitiesSchema,
  jobSlots: z.literal(1), currentJobs: z.number().int().min(0).max(1),
  lifecycle: LifecycleSchema.optional(), resources: ResourceReportSchema.optional(),
});
export const ReleaseReasonSchema = z.enum(['DRAINING', 'PREEMPTED', 'SHUTDOWN']);
/** A node hands a leased job back without failing it; the job is requeued and the attempt is refunded. */
export const ReleaseSchema = z.strictObject({ leaseId: IdSchema, reason: ReleaseReasonSchema });
/** Planned departure: the node leaves on purpose, so this is not an unexplained disappearance. */
export const GoodbyeSchema = z.strictObject({ reason: z.literal('SHUTDOWN') });
export const AckSchema = z.strictObject({ ok: z.literal(true) });
export const NodeStatusSchema = z.enum(['ONLINE', 'STALE', 'OFFLINE', 'DRAINING', 'OFFLINE_EXPECTED', 'REVOKED']);
export const NodeViewSchema = z.strictObject({
  nodeId: NodeIdSchema, capabilities: CapabilitiesSchema, daemonVersion: VersionSchema,
  protocolVersion: ProtocolSchema, lastHeartbeatAt: TimeSchema.nullable(), status: NodeStatusSchema,
  currentJobs: z.number().int().min(0).max(1), jobSlots: z.literal(1), resources: ResourceReportSchema.optional(),
});
export const NodesSchema = z.strictObject({ nodes: z.array(NodeViewSchema).max(1000) });
export const AppCreateSchema = z.strictObject({ name: z.string().min(1).max(80), allowedJobTypes: z.array(JobTypeSchema).max(JOB_TYPE_IDS.length) });
export const AppCredentialSchema = z.strictObject({ applicationId: IdSchema, token: SecretSchema });
export const SubmitSchema = registered(z.strictObject({
  type: JobTypeSchema, input: z.unknown(), idempotencyKey: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_.:-]+$/),
}));
export const JobErrorSchema = z.strictObject({ code: z.enum(['HANDLER_FAILED', 'LEASE_EXPIRED', 'NODE_REVOKED', 'CAPABILITY_DISABLED', 'INVALID_RESULT', 'RELEASE_LIMIT']) });
export const JobStatusSchema = z.enum(['QUEUED', 'LEASED', 'COMPLETED', 'FAILED']);
export const JobSchema = registered(z.strictObject({
  id: IdSchema, type: JobTypeSchema, protocolVersion: ProtocolSchema, input: z.unknown(),
  status: JobStatusSchema, createdAt: TimeSchema, completedAt: TimeSchema.nullable(),
  attempts: z.number().int().nonnegative(), result: z.unknown().nullable(), error: JobErrorSchema.nullable(),
}));
export const LeaseSchema = registered(z.strictObject({
  jobId: IdSchema, type: JobTypeSchema, input: z.unknown(), protocolVersion: ProtocolSchema,
  leaseId: IdSchema, expiresAt: TimeSchema, attempt: z.number().int().positive(),
}));
export const LeaseResponseSchema = z.strictObject({ lease: LeaseSchema.nullable() });
/** The result is validated against the leased job's registered output schema by the Coordinator. */
export const CompleteSchema = z.strictObject({ leaseId: IdSchema, result: z.unknown() });
export const FailureSchema = z.strictObject({ leaseId: IdSchema, error: JobErrorSchema });
export const CapabilitiesResponseSchema = z.strictObject({ capabilities: z.array(z.strictObject({ capability: JobTypeSchema, onlineNodes: z.number().int().nonnegative() })).max(JOB_TYPE_IDS.length) });
export type NodeView = z.infer<typeof NodeViewSchema>;
export type Heartbeat = z.infer<typeof HeartbeatSchema>;
export type EnrollmentStart = z.infer<typeof EnrollmentStartSchema>;
export type Challenge = z.infer<typeof ChallengeSchema>;
export type Session = z.infer<typeof SessionSchema>;
export type Submit = z.infer<typeof SubmitSchema>;
export type Job = z.infer<typeof JobSchema>;
export type Lease = z.infer<typeof LeaseSchema>;
export type JobError = z.infer<typeof JobErrorSchema>;
