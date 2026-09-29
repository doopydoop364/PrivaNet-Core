import { z } from 'zod';

export const PROTOCOL_VERSION = 1 as const;
export const SERVICE_VERSION = '0.1.0';
export const MAX_BODY_BYTES = 32 * 1024;
export const ProtocolSchema = z.literal(PROTOCOL_VERSION);
export const IdSchema = z.uuid();
export const NodeIdSchema = z.string().regex(/^node_[a-f0-9]{64}$/);
export const SecretSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const TimeSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const EchoSchema = z.strictObject({ message: z.string().max(1024) });
export const JOB_TYPES = Object.freeze({
  'system.echo.v1': Object.freeze({ version: 1, capability: 'system.echo.v1', input: EchoSchema, output: EchoSchema }),
});
export type JobType = keyof typeof JOB_TYPES;
export type JobInputMap = { 'system.echo.v1': z.infer<typeof EchoSchema> };
export type JobOutputMap = JobInputMap;
export const JobTypeSchema = z.literal('system.echo.v1');
export const CapabilitiesSchema = z.array(JobTypeSchema).max(1);
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
export const HeartbeatSchema = z.strictObject({
  protocolVersion: ProtocolSchema, daemonVersion: VersionSchema, capabilities: CapabilitiesSchema,
  jobSlots: z.literal(1), currentJobs: z.number().int().min(0).max(1),
});
export const AckSchema = z.strictObject({ ok: z.literal(true) });
export const NodeStatusSchema = z.enum(['ONLINE', 'STALE', 'OFFLINE', 'REVOKED']);
export const NodeViewSchema = z.strictObject({
  nodeId: NodeIdSchema, capabilities: CapabilitiesSchema, daemonVersion: VersionSchema,
  protocolVersion: ProtocolSchema, lastHeartbeatAt: TimeSchema.nullable(), status: NodeStatusSchema,
  currentJobs: z.number().int().min(0).max(1), jobSlots: z.literal(1),
});
export const NodesSchema = z.strictObject({ nodes: z.array(NodeViewSchema).max(1000) });
export const AppCreateSchema = z.strictObject({ name: z.string().min(1).max(80), allowedJobTypes: z.array(JobTypeSchema).max(1) });
export const AppCredentialSchema = z.strictObject({ applicationId: IdSchema, token: SecretSchema });
export const SubmitSchema = z.strictObject({
  type: JobTypeSchema, input: EchoSchema, idempotencyKey: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_.:-]+$/),
});
export const JobErrorSchema = z.strictObject({ code: z.enum(['HANDLER_FAILED', 'LEASE_EXPIRED', 'NODE_REVOKED', 'CAPABILITY_DISABLED', 'INVALID_RESULT']) });
export const JobStatusSchema = z.enum(['QUEUED', 'LEASED', 'COMPLETED', 'FAILED']);
export const JobSchema = z.strictObject({
  id: IdSchema, type: JobTypeSchema, protocolVersion: ProtocolSchema, input: EchoSchema,
  status: JobStatusSchema, createdAt: TimeSchema, completedAt: TimeSchema.nullable(),
  attempts: z.number().int().nonnegative(), result: EchoSchema.nullable(), error: JobErrorSchema.nullable(),
});
export const LeaseSchema = z.strictObject({
  jobId: IdSchema, type: JobTypeSchema, input: EchoSchema, protocolVersion: ProtocolSchema,
  leaseId: IdSchema, expiresAt: TimeSchema, attempt: z.number().int().positive(),
});
export const LeaseResponseSchema = z.strictObject({ lease: LeaseSchema.nullable() });
export const CompleteSchema = z.strictObject({ leaseId: IdSchema, result: EchoSchema });
export const FailureSchema = z.strictObject({ leaseId: IdSchema, error: JobErrorSchema });
export const CapabilitiesResponseSchema = z.strictObject({ capabilities: z.array(z.strictObject({ capability: JobTypeSchema, onlineNodes: z.number().int().nonnegative() })).max(1) });
export type NodeView = z.infer<typeof NodeViewSchema>;
export type Heartbeat = z.infer<typeof HeartbeatSchema>;
export type EnrollmentStart = z.infer<typeof EnrollmentStartSchema>;
export type Challenge = z.infer<typeof ChallengeSchema>;
export type Session = z.infer<typeof SessionSchema>;
export type Submit = z.infer<typeof SubmitSchema>;
export type Job = z.infer<typeof JobSchema>;
export type Lease = z.infer<typeof LeaseSchema>;
export type JobError = z.infer<typeof JobErrorSchema>;
