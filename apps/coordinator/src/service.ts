import { createPublicKey, randomUUID, verify } from 'node:crypto';
import {
  AppCreateSchema, CompleteSchema, EnrollmentStartSchema, EnrollmentTokenRequestSchema,
  FailureSchema, GoodbyeSchema, HeartbeatSchema, JOB_TYPES, JobSchema, PROTOCOL_VERSION, ProofSchema,
  ReleaseSchema, RenewSchema, SERVICE_VERSION, SubmitSchema,
} from '@privanet/protocol';
import type { Challenge, Job, JobError, Lease, NodeView, Session } from '@privanet/protocol';
import { ApiError, canonicalPublicKey, hash, secret } from '@privanet/shared';
import type { ApplicationRecord, ChallengeRecord, JobRecord, NodeRecord, Store } from './model.js';
import { ResourceAwareScheduler } from './scheduler.js';
import type { Scheduler } from './scheduler.js';

export interface Policy { staleMs: number; offlineMs: number; leaseMs: number; maxAttempts: number; maxReleases: number; sessionMs: number; challengeMs: number;
  /** Finished jobs (and their results) are deleted this long after completion; 0 keeps them forever. Duplicate-submission replays stop working after this. */
  retentionMs: number;
  /** Longest a single lease may be kept alive by renewals. */
  maxLeaseMs: number;
  /** Most QUEUED + LEASED jobs one application may hold; further submissions get 429 QUEUE_LIMIT. */
  maxPendingPerApplication: number }
export const defaultPolicy: Policy = { staleMs: 15000, offlineMs: 60000, leaseMs: 10000, maxAttempts: 3, maxReleases: 20, sessionMs: 300000, challengeMs: 60000, retentionMs: 30 * 86400000, maxLeaseMs: 3600000, maxPendingPerApplication: 10000 };
function reject(status: number, code: string): never { throw new ApiError(status, code, code.replaceAll('_', ' ').toLowerCase()); }

export class Coordinator {
  readonly policy: Policy;
  constructor(readonly store: Store, policy: Partial<Policy> = {}, private readonly now: () => number = Date.now, private readonly scheduler: Scheduler = new ResourceAwareScheduler()) {
    this.policy = { ...defaultPolicy, ...policy };
    for (const [key, value] of Object.entries(this.policy)) if (!Number.isSafeInteger(value) || value < (key === 'retentionMs' ? 0 : 1)) throw new Error('Invalid policy');
    if (this.policy.offlineMs <= this.policy.staleMs || this.policy.maxAttempts > 100 || this.policy.sessionMs > 86400000 || this.policy.challengeMs > 300000) throw new Error('Invalid policy boundaries');
  }
  health() { return { protocolVersion: PROTOCOL_VERSION, serviceVersion: SERVICE_VERSION, coordinatorId: this.store.coordinatorId, status: 'ok' as const }; }
  createEnrollment(input: unknown) {
    const request = EnrollmentTokenRequestSchema.parse(input);
    const token = secret(); const expiresAt = this.now() + request.expiresInMs;
    this.store.saveGrant({ tokenHash: hash(token), expiresAt, capabilities: request.capabilities, used: false });
    return { token, expiresAt };
  }
  private grant(tokenHash: string) {
    const grant = this.store.getGrant(tokenHash);
    if (!grant || grant.used || grant.expiresAt <= this.now()) reject(401, 'INVALID_ENROLLMENT');
    return grant;
  }
  beginEnrollment(input: unknown): Challenge {
    const request = EnrollmentStartSchema.parse(input);
    return this.store.transaction(() => {
      const grant = this.grant(hash(request.token));
      if (request.capabilities.some(capability => !grant.capabilities.includes(capability))) reject(403, 'CAPABILITY_FORBIDDEN');
      let key: { publicKey: string; nodeId: string };
      try { key = canonicalPublicKey(request.publicKey); } catch { reject(400, 'INVALID_PUBLIC_KEY'); }
      if (this.store.getNode(key.nodeId)) reject(409, 'NODE_ALREADY_REGISTERED');
      // Do not retain the raw enrollment token in challenge persistence.
      return this.challenge('enroll', key.nodeId, key.publicKey, { publicKey: request.publicKey, protocolVersion: request.protocolVersion, daemonVersion: request.daemonVersion, capabilities: request.capabilities }, hash(request.token));
    });
  }
  beginAuth(nodeId: string): Challenge {
    const node = this.store.getNode(nodeId);
    if (!node || node.revoked) reject(401, 'UNAUTHORIZED_NODE');
    return this.store.transaction(() => this.challenge('auth', node.nodeId, node.publicKey, null, null));
  }
  private challenge(purpose: 'enroll' | 'auth', nodeId: string, publicKey: string, enrollment: ChallengeRecord['enrollment'], grantHash: string | null): Challenge {
    this.store.prune(this.now());
    if (this.store.countChallenges() >= 1000) reject(429, 'CHALLENGE_LIMIT');
    const message = JSON.stringify({ domain: 'privanet.node-proof.v1', coordinatorId: this.store.coordinatorId, purpose, nodeId, nonce: secret() });
    const result = { challengeId: randomUUID(), message, expiresAt: this.now() + this.policy.challengeMs, coordinatorId: this.store.coordinatorId };
    this.store.saveChallenge({ ...result, purpose, nodeId, publicKey, enrollment, grantHash });
    return result;
  }
  prove(input: unknown, purpose: 'enroll' | 'auth'): Session {
    const proof = ProofSchema.parse(input);
    // Consume even invalid proofs, outside rollback of enrollment/session creation.
    const challenge = this.store.transaction(() => {
      const value = this.store.getChallenge(proof.challengeId);
      if (value) this.store.deleteChallenge(proof.challengeId);
      return value;
    });
    if (!challenge || challenge.purpose !== purpose || challenge.expiresAt <= this.now()) reject(401, 'INVALID_PROOF');
    const key = createPublicKey({ key: Buffer.from(challenge.publicKey, 'base64'), type: 'spki', format: 'der' });
    if (!verify(null, Buffer.from(challenge.message), key, Buffer.from(proof.signature, 'hex'))) reject(401, 'INVALID_PROOF');
    return this.store.transaction(() => {
      if (purpose === 'enroll') {
        if (!challenge.enrollment || !challenge.grantHash) reject(401, 'INVALID_PROOF');
        const grant = this.grant(challenge.grantHash);
        if (this.store.getNode(challenge.nodeId)) reject(409, 'NODE_ALREADY_REGISTERED');
        if (this.store.listNodes().length >= 1000) reject(429, 'NODE_LIMIT');
        this.store.saveNode({ nodeId: challenge.nodeId, publicKey: challenge.publicKey,
          capabilities: challenge.enrollment.capabilities, allowedCapabilities: grant.capabilities,
          protocolVersion: PROTOCOL_VERSION, daemonVersion: challenge.enrollment.daemonVersion,
          enrolledAt: this.now(), lastHeartbeatAt: null, revoked: false, currentJobs: 0, jobSlots: 1 });
        this.store.saveGrant({ ...grant, used: true });
      }
      const node = this.store.getNode(challenge.nodeId);
      if (!node || node.revoked) reject(401, 'UNAUTHORIZED_NODE');
      const token = secret(); const expiresAt = this.now() + this.policy.sessionMs;
      this.store.deleteNodeSessions(node.nodeId);
      this.store.saveSession({ tokenHash: hash(token), nodeId: node.nodeId, expiresAt });
      return { nodeId: node.nodeId, token, expiresAt, coordinatorId: this.store.coordinatorId };
    });
  }
  authenticateNode(token: string): NodeRecord {
    const session = this.store.getSession(hash(token));
    if (!session || session.expiresAt <= this.now()) reject(401, 'UNAUTHORIZED_NODE');
    const node = this.store.getNode(session.nodeId);
    if (!node || node.revoked) reject(401, 'UNAUTHORIZED_NODE');
    return node;
  }
  createApplication(input: unknown) {
    const request = AppCreateSchema.parse(input); const token = secret(); const applicationId = randomUUID();
    this.store.saveApplication({ id: applicationId, tokenHash: hash(token), ...request, revoked: false });
    return { applicationId, token };
  }
  authenticateApplication(token: string): ApplicationRecord {
    const app = this.store.findApplication(hash(token));
    if (!app || app.revoked) reject(401, 'UNAUTHORIZED_APPLICATION');
    return app;
  }
  revokeApplication(id: string): void {
    const app = this.store.getApplication(id); if (!app) reject(404, 'NOT_FOUND');
    this.store.saveApplication({ ...app, revoked: true });
  }
  /** Issues a new credential for the same application identity; the old credential stops working at once. */
  rotateApplication(id: string) {
    return this.store.transaction(() => {
      const app = this.store.getApplication(id); if (!app || app.revoked) reject(404, 'NOT_FOUND');
      const token = secret(); this.store.saveApplication({ ...app, tokenHash: hash(token) });
      return { applicationId: app.id, token };
    });
  }
  revokeNode(id: string): void {
    this.store.transaction(() => {
      const node = this.store.getNode(id); if (!node) reject(404, 'NOT_FOUND');
      this.store.saveNode({ ...node, revoked: true }); this.store.deleteNodeSessions(id);
      for (const job of this.store.listPendingJobs()) if (job.status === 'LEASED' && job.assignedNodeId === id) this.retry(job, 'NODE_REVOKED');
    });
  }
  status(node: NodeRecord): NodeView['status'] {
    if (node.revoked) return 'REVOKED';
    // A node that said goodbye left on purpose until it heartbeats again; it is not an unexplained loss.
    if (node.lifecycle === 'DEPARTED') return 'OFFLINE_EXPECTED';
    if (node.lastHeartbeatAt === null || this.now() - node.lastHeartbeatAt >= this.policy.offlineMs) return 'OFFLINE';
    if (this.now() - node.lastHeartbeatAt >= this.policy.staleMs) return 'STALE';
    return node.lifecycle === 'DRAINING' ? 'DRAINING' : 'ONLINE';
  }
  listNodes(): NodeView[] {
    return this.store.listNodes().map(node => ({ nodeId: node.nodeId, protocolVersion: node.protocolVersion,
      daemonVersion: node.daemonVersion, capabilities: node.capabilities, lastHeartbeatAt: node.lastHeartbeatAt,
      currentJobs: node.currentJobs, jobSlots: node.jobSlots, status: this.status(node),
      ...(node.resources ? { resources: node.resources } : {}) }));
  }
  heartbeat(nodeId: string, input: unknown): void {
    const request = HeartbeatSchema.parse(input);
    const node = this.store.getNode(nodeId); if (!node || node.revoked) reject(401, 'UNAUTHORIZED_NODE');
    if (request.capabilities.some(capability => !node.allowedCapabilities.includes(capability))) reject(403, 'CAPABILITY_FORBIDDEN');
    const { lifecycle = 'ACTIVE', resources, ...rest } = request;
    // Absent resources means the node no longer reports them: never keep a stale, more generous budget.
    const kept: NodeRecord = { ...node }; delete kept.resources;
    this.store.saveNode({ ...kept, ...rest, lifecycle, ...(resources ? { resources } : {}), lastHeartbeatAt: this.now() });
  }
  capabilities(app: ApplicationRecord) {
    return { capabilities: app.allowedJobTypes.map(capability => ({ capability,
      onlineNodes: this.store.listNodes().filter(node => this.status(node) === 'ONLINE' && node.capabilities.includes(capability)).length })) };
  }
  private view(job: JobRecord): Job {
    return JobSchema.parse({ id: job.id, type: job.type, input: job.input, protocolVersion: job.protocolVersion,
      status: job.status, createdAt: job.createdAt, completedAt: job.completedAt, attempts: job.attempts, result: job.result, error: job.error });
  }
  submit(app: ApplicationRecord, input: unknown): Job {
    const request = SubmitSchema.parse(input);
    if (!app.allowedJobTypes.includes(request.type)) reject(403, 'JOB_TYPE_FORBIDDEN');
    return this.store.transaction(() => {
      const previous = this.store.findSubmission(app.id, request.idempotencyKey);
      if (previous) {
        if (previous.type !== request.type || JSON.stringify(previous.input) !== JSON.stringify(request.input)) reject(409, 'IDEMPOTENCY_CONFLICT');
        return this.view(previous);
      }
      if (this.store.countPendingJobs(app.id) >= this.policy.maxPendingPerApplication) reject(429, 'QUEUE_LIMIT');
      const job: JobRecord = { id: randomUUID(), ...request, applicationId: app.id, protocolVersion: PROTOCOL_VERSION,
        createdAt: this.now(), completedAt: null, status: 'QUEUED', attempts: 0, result: null, error: null,
        assignedNodeId: null, leaseId: null, leaseExpiresAt: null };
      this.store.saveJob(job); return this.view(job);
    });
  }
  getJob(app: ApplicationRecord, id: string): Job {
    this.maintain();
    const job = this.store.getJob(id);
    if (!job || job.applicationId !== app.id) reject(404, 'NOT_FOUND');
    return this.view(job);
  }
  private retry(job: JobRecord, code: JobError['code']): void {
    const exhausted = job.attempts >= this.policy.maxAttempts;
    this.store.saveJob({ ...job, status: exhausted ? 'FAILED' : 'QUEUED', completedAt: exhausted ? this.now() : null,
      assignedNodeId: null, leaseId: null, leaseExpiresAt: null, error: { code } });
  }
  private lastRetentionAt = 0;
  maintain(): void {
    this.store.transaction(() => {
      this.store.prune(this.now());
      // The retention sweep scans finished jobs, so it runs at most once a minute.
      if (this.policy.retentionMs > 0 && this.now() - this.lastRetentionAt >= 60000) { this.lastRetentionAt = this.now(); this.store.deleteTerminalJobs(this.now() - this.policy.retentionMs); }
      for (const job of this.store.listPendingJobs()) {
        if (job.status === 'LEASED' && job.leaseExpiresAt !== null && job.leaseExpiresAt <= this.now()) this.retry(job, 'LEASE_EXPIRED');
        else if (job.status === 'QUEUED' && job.attempts >= this.policy.maxAttempts) this.retry(job, job.error?.code ?? 'LEASE_EXPIRED');
      }
    });
  }
  lease(nodeId: string): Lease | null {
    return this.store.transaction(() => {
      this.maintain();
      const node = this.store.getNode(nodeId);
      if (!node || node.revoked) reject(401, 'UNAUTHORIZED_NODE');
      if (this.status(node) !== 'ONLINE') return null;
      const job = this.scheduler.choose(node, this.store.listPendingJobs());
      if (!job) return null;
      const leaseId = randomUUID(); const expiresAt = this.now() + this.policy.leaseMs;
      const next: JobRecord = { ...job, status: 'LEASED', attempts: job.attempts + 1,
        assignedNodeId: nodeId, leaseId, leaseExpiresAt: expiresAt, leasedAt: this.now(), error: null };
      this.store.saveJob(next);
      return { jobId: job.id, type: job.type, input: job.input, protocolVersion: PROTOCOL_VERSION, leaseId, expiresAt, attempt: next.attempts };
    });
  }
  complete(nodeId: string, id: string, input: unknown): void {
    const request = CompleteSchema.parse(input);
    const node = this.store.getNode(nodeId); if (!node || node.revoked) reject(401, 'UNAUTHORIZED_NODE');
    const job = this.store.getJob(id);
    // Result shape is checked against the schema registered for the job's own type, never the node's claim.
    if (!job || job.assignedNodeId !== nodeId) reject(409, 'LEASE_CONFLICT');
    const parsed = JOB_TYPES[job.type].output.safeParse(request.result);
    if (!parsed.success) reject(400, 'INVALID_RESULT');
    this.finish(nodeId, id, request.leaseId, { result: parsed.data, error: null }, 'COMPLETED');
  }
  fail(nodeId: string, id: string, input: unknown): void {
    const request = FailureSchema.parse(input);
    this.finish(nodeId, id, request.leaseId, { result: null, error: request.error }, 'FAILED');
  }
  /**
   * A node running a long job extends its lease. Fenced like completion: authenticated, assigned node,
   * matching lease ID, and the lease must still be valid; total lease time is bounded by `maxLeaseMs`.
   * The Coordinator chooses the new expiry, so a node cannot claim an arbitrary deadline.
   */
  renew(nodeId: string, id: string, input: unknown): { expiresAt: number } {
    const request = RenewSchema.parse(input);
    return this.store.transaction(() => {
      const node = this.store.getNode(nodeId); if (!node || node.revoked) reject(401, 'UNAUTHORIZED_NODE');
      const job = this.store.getJob(id); const now = this.now();
      if (!job || job.status !== 'LEASED' || job.assignedNodeId !== nodeId || job.leaseId !== request.leaseId
        || job.leaseExpiresAt === null || job.leaseExpiresAt <= now) reject(409, 'LEASE_CONFLICT');
      const ceiling = (job.leasedAt ?? now) + this.policy.maxLeaseMs;
      if (ceiling <= now) reject(409, 'LEASE_LIMIT');
      const expiresAt = Math.max(job.leaseExpiresAt, Math.min(now + this.policy.leaseMs, ceiling));
      this.store.saveJob({ ...job, leaseExpiresAt: expiresAt }); return { expiresAt };
    });
  }
  /** Node hands a leased job back (drain, preemption, shutdown). Not a failure: the attempt is refunded. */
  release(nodeId: string, id: string, input: unknown): void {
    const request = ReleaseSchema.parse(input);
    this.store.transaction(() => {
      const node = this.store.getNode(nodeId); if (!node || node.revoked) reject(401, 'UNAUTHORIZED_NODE');
      const job = this.store.getJob(id);
      if (!job || job.status !== 'LEASED' || job.assignedNodeId !== nodeId || job.leaseId !== request.leaseId
        || job.leaseExpiresAt === null || job.leaseExpiresAt <= this.now()) reject(409, 'LEASE_CONFLICT');
      this.giveBack(job);
    });
  }
  private giveBack(job: JobRecord): void {
    const releases = (job.releases ?? 0) + 1;
    // Bounded: endless drain/preempt cycles must not keep a job alive forever.
    const exhausted = releases > this.policy.maxReleases;
    this.store.saveJob({ ...job, status: exhausted ? 'FAILED' : 'QUEUED', completedAt: exhausted ? this.now() : null,
      attempts: Math.max(0, job.attempts - 1), releases, assignedNodeId: null, leaseId: null, leaseExpiresAt: null,
      error: exhausted ? { code: 'RELEASE_LIMIT' } : null });
  }
  /** Planned departure: return the node's leases without penalty and record that it left on purpose. */
  goodbye(nodeId: string, input: unknown): void {
    GoodbyeSchema.parse(input);
    this.store.transaction(() => {
      const node = this.store.getNode(nodeId); if (!node || node.revoked) reject(401, 'UNAUTHORIZED_NODE');
      for (const job of this.store.listPendingJobs()) if (job.status === 'LEASED' && job.assignedNodeId === nodeId) this.giveBack(job);
      this.store.saveNode({ ...node, lifecycle: 'DEPARTED', currentJobs: 0 });
    });
  }
  private finish(nodeId: string, id: string, leaseId: string, outcome: Pick<Job, 'result' | 'error'>, status: 'COMPLETED' | 'FAILED'): void {
    this.store.transaction(() => {
      const node = this.store.getNode(nodeId); if (!node || node.revoked) reject(401, 'UNAUTHORIZED_NODE');
      const job = this.store.getJob(id);
      if (!job || job.assignedNodeId !== nodeId || job.leaseId !== leaseId) reject(409, 'LEASE_CONFLICT');
      if (job.status === status && JSON.stringify(job.result) === JSON.stringify(outcome.result) && JSON.stringify(job.error) === JSON.stringify(outcome.error)) return;
      if (job.status !== 'LEASED' || job.leaseExpiresAt === null || job.leaseExpiresAt <= this.now()) reject(409, 'LEASE_CONFLICT');
      this.store.saveJob({ ...job, ...outcome, status, completedAt: this.now() });
    });
  }
}
