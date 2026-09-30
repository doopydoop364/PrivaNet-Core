import { z } from 'zod';

export const PROTOCOL_VERSION = 1 as const;
export const SERVICE_VERSION = '0.3.0-alpha.2';
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
/**
 * The identity an application presents when it makes outbound requests through a node (a fetch capability).
 * It is registered by an administrator on the application record and stamped into the lease by the
 * Coordinator; a job can never choose or override it, so one application cannot impersonate another.
 */
export const FetchIdentitySchema = z.strictObject({
  /** Product token used in the User-Agent and matched against robots.txt groups, for example a crawler name. */
  product: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,31}$/),
  /** Where a site owner can learn about the crawler and reach its operator. HTTPS, no credentials. */
  infoUrl: z.string().max(200).refine(value => {
    try { const url = new URL(value); return url.protocol === 'https:' && url.username === '' && url.password === '' && url.hostname.includes('.') && url.hash === ''; } catch { return false; }
  }, 'infoUrl must be an https URL without credentials'),
});
export type FetchIdentity = z.infer<typeof FetchIdentitySchema>;

/** Results must fit one 32 KiB completion body; the fetch result is bounded well inside that. */
export const FETCH_MAX_RESULT_BYTES = 28000;
/**
 * Input of the constrained web-fetch capability. Deliberately absent: method, headers, cookies, body, proxy,
 * port, IP address, resolver hints, TLS options, user agent, robots switches. Every field only lowers a cap;
 * the node applies defaults and enforces its own hard maxima (the smaller value wins). Fields have no schema
 * defaults so typed callers may omit them.
 */
export const FetchInputSchema = z.strictObject({
  url: z.string().min(8).max(2048),
  mode: z.enum(['DIGEST', 'PROBE']).optional(),
  validators: z.strictObject({
    etag: z.string().max(200).regex(/^(?:W\/)?"[\x21\x23-\x7e]*"$/).optional(),
    lastModified: z.string().max(40).regex(/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/).optional(),
  }).optional(),
  maxRedirects: z.number().int().min(0).max(3).optional(),
  timeoutMs: z.number().int().min(1000).max(30000).optional(),
  maxBodyBytes: z.number().int().min(4096).max(1048576).optional(),
  maxTextBytes: z.number().int().min(0).max(10240).optional(),
  maxLinks: z.number().int().min(0).max(100).optional(),
});
export const FETCH_OUTCOMES = [
  'FETCHED', 'NOT_MODIFIED', 'PROBED', 'REDIRECT', 'ROBOTS_DISALLOWED', 'ROBOTS_UNAVAILABLE', 'BLOCKED_TARGET',
  'RATE_LIMITED', 'UNSUPPORTED_CONTENT_TYPE', 'TOO_LARGE', 'HTTP_ERROR', 'FETCH_FAILED',
] as const;
const FetchUrl = z.string().min(8).max(2048);
const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);
export const FetchOutputSchema = z.strictObject({
  outcome: z.enum(FETCH_OUTCOMES),
  requestedUrl: FetchUrl, finalUrl: FetchUrl.optional(), redirectTarget: FetchUrl.optional(),
  redirects: z.array(z.strictObject({ url: FetchUrl, status: z.number().int().min(300).max(399) })).max(3),
  httpStatus: z.number().int().min(100).max(599).optional(),
  fetchedAtMs: TimeSchema, durationMs: z.number().int().min(0).max(120000),
  contentType: z.string().max(100).optional(), charset: z.string().max(40).optional(),
  bodyBytes: z.number().int().min(0).max(1048576).optional(), bodyTruncated: z.boolean().optional(),
  contentSha256: Sha256.optional(),
  etag: z.string().max(200).optional(), lastModified: z.string().max(40).optional(),
  retryAfterSec: z.number().int().min(0).max(86400).optional(),
  robots: z.strictObject({
    verdict: z.enum(['ALLOWED', 'DISALLOWED', 'UNAVAILABLE']),
    fetchedAtMs: TimeSchema.optional(), sha256: Sha256.optional(), crawlDelaySec: z.number().min(0).max(300).optional(),
  }),
  indexing: z.strictObject({ noindex: z.boolean(), nofollow: z.boolean(), noarchive: z.boolean() }).optional(),
  page: z.strictObject({
    title: z.string().max(300).optional(), description: z.string().max(500).optional(),
    canonicalUrl: FetchUrl.optional(), language: z.string().max(35).optional(),
    text: z.string().max(10240).optional(), textTruncated: z.boolean().optional(),
    links: z.array(z.strictObject({ url: FetchUrl, nofollow: z.boolean() })).max(100), linksTruncated: z.boolean(),
  }).optional(),
  error: z.strictObject({ code: z.enum(['DNS', 'CONNECT', 'TLS', 'TIMEOUT', 'RESET', 'PROTOCOL', 'DECODE', 'INTERNAL']), retryable: z.boolean() }).optional(),
}).refine(result => Buffer.byteLength(JSON.stringify(result)) <= FETCH_MAX_RESULT_BYTES, 'result too large');
export type FetchInput = z.infer<typeof FetchInputSchema>;
export type FetchOutput = z.infer<typeof FetchOutputSchema>;
/**
 * A short, stateless, preemptible HTTP GET. Not checkpointable: a partial HTTP response is not safely resumable, so
 * a retry restarts from a clean state. Bounds mirror the node's hard limits; the declared duration is the worst case.
 */
const FETCH_RESOURCES: ResourceEstimate = Object.freeze({
  cpu: 'low', memoryBytes: 48 * 1024 * 1024, diskBytes: 0, diskIo: 'none', networkBytes: 2 * 1024 * 1024,
  expectedDurationMs: 30000, preemptible: true, checkpointable: false,
});
export const JOB_TYPES = Object.freeze({
  'system.echo.v1': Object.freeze({ version: 1, capability: 'system.echo.v1', input: EchoSchema, output: EchoSchema, resources: ECHO_RESOURCES }),
  'system.hashchain.v1': Object.freeze({ version: 1, capability: 'system.hashchain.v1', input: HashChainInputSchema, output: HashChainOutputSchema, resources: HASHCHAIN_RESOURCES }),
  // A generic, function-named capability (ADR 005). `requiresClientIdentity`: only applications with a registered fetch identity may submit it.
  'web.fetch.v1': Object.freeze({ version: 1, capability: 'web.fetch.v1', input: FetchInputSchema, output: FetchOutputSchema, resources: FETCH_RESOURCES, requiresClientIdentity: true }),
});
export type JobType = keyof typeof JOB_TYPES;
/** True for capabilities that act on the outside world on an application's behalf and so need its registered identity. */
export const requiresClientIdentity = (type: JobType): boolean => { const definition = JOB_TYPES[type]; return 'requiresClientIdentity' in definition && definition.requiresClientIdentity === true; };
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
/** Most concurrent jobs one node may run. A node advertises how many it will run; owner limits still bound them (the scheduler reserves the estimates of running jobs against the reported budget). */
export const MAX_JOB_SLOTS = 64;
export const HeartbeatSchema = z.strictObject({
  protocolVersion: ProtocolSchema, daemonVersion: VersionSchema, capabilities: CapabilitiesSchema,
  jobSlots: z.number().int().min(1).max(MAX_JOB_SLOTS), currentJobs: z.number().int().min(0).max(MAX_JOB_SLOTS),
  lifecycle: LifecycleSchema.optional(), resources: ResourceReportSchema.optional(),
});
export const ReleaseReasonSchema = z.enum(['DRAINING', 'PREEMPTED', 'SHUTDOWN']);
/** A node hands a leased job back without failing it; the job is requeued and the attempt is refunded. */
export const ReleaseSchema = z.strictObject({ leaseId: IdSchema, reason: ReleaseReasonSchema });
/** Planned departure: the node leaves on purpose, so this is not an unexplained disappearance. */
/** Extends a still-valid lease of a running job (v0.2.1, additive). The Coordinator picks the new expiry, never the node. */
export const RenewSchema = z.strictObject({ leaseId: IdSchema });
export const RenewResponseSchema = z.strictObject({ expiresAt: TimeSchema });
export const GoodbyeSchema = z.strictObject({ reason: z.literal('SHUTDOWN') });
export const AckSchema = z.strictObject({ ok: z.literal(true) });
export const NodeStatusSchema = z.enum(['ONLINE', 'STALE', 'OFFLINE', 'DRAINING', 'OFFLINE_EXPECTED', 'REVOKED']);
export const NodeViewSchema = z.strictObject({
  nodeId: NodeIdSchema, capabilities: CapabilitiesSchema, daemonVersion: VersionSchema,
  protocolVersion: ProtocolSchema, lastHeartbeatAt: TimeSchema.nullable(), status: NodeStatusSchema,
  currentJobs: z.number().int().min(0).max(MAX_JOB_SLOTS), jobSlots: z.number().int().min(1).max(MAX_JOB_SLOTS), resources: ResourceReportSchema.optional(),
});
export const NodesSchema = z.strictObject({ nodes: z.array(NodeViewSchema).max(1000) });
export const AppCreateSchema = z.strictObject({ name: z.string().min(1).max(80), allowedJobTypes: z.array(JobTypeSchema).max(JOB_TYPE_IDS.length), fetchIdentity: FetchIdentitySchema.optional() });
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
  /** Present only on leases of capabilities that require an application identity (v0.3); older nodes never receive such a lease. */
  client: FetchIdentitySchema.optional(),
}));
/** Longest `GET /v1/jobs/{id}?waitMs=` may wait for the job to finish (same ceiling as a lease wait). */
export const MAX_JOB_WAIT_MS = 8000;
/** Longest a lease request may wait for work. Kept below the Coordinator's request timeout so a waiting request is never cut off. */
export const MAX_LEASE_WAIT_MS = 8000;
/** Body of `POST /v1/node/jobs/lease`. `{}` (as v0.1 to v0.3.0-alpha.2 nodes send) is a plain poll; `waitMs` (additive, optional) asks the Coordinator to hold the request until work exists or the time is up. */
export const LeaseRequestSchema = z.strictObject({ waitMs: z.number().int().min(0).max(MAX_LEASE_WAIT_MS).optional() });
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
