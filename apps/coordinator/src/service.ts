import { createHmac, createPublicKey, randomBytes, randomUUID, timingSafeEqual, verify } from 'node:crypto';
import {
  AppCreateSchema, CompleteSchema, EnrollmentStartSchema, EnrollmentTokenRequestSchema,
  FailureSchema, GoodbyeSchema, HeartbeatSchema, InviteChallengeRequestSchema, InviteRequestSchema, JOB_TYPES, JoinApprovalSchema, JoinChallengeRequestSchema, JoinRequestSchema,
  JoinStatusRequestSchema, JobSchema, NodeRenameSchema, PROTOCOL_VERSION, ProofSchema, ReleaseSchema, RenewSchema, SERVICE_VERSION, SubmitSchema, CODE_ALPHABET, CODE_LENGTH,
  formatCode, normalizeCode, requiresClientIdentity,
} from '@privanet/protocol';
import type { Challenge, EnrollmentTokenInfo, EnrollmentTokenStatus, InviteInfo, InviteStatus, Job, JobError, JobType, JoinRequestInfo, Lease, NodeView, Session } from '@privanet/protocol';
import { ApiError, canonicalPublicKey, hash, secret } from '@privanet/shared';
import type { ApplicationRecord, ChallengeRecord, Grant, JobRecord, NodeRecord, Store } from './model.js';
import { ResourceAwareScheduler } from './scheduler.js';
import { StorageControl } from './storage.js';
import type { StorageLimits } from './storage.js';
import type { TransferKeyring } from './transfer-keys.js';
import type { Scheduler } from './scheduler.js';

export interface Policy { staleMs: number; offlineMs: number; leaseMs: number; maxAttempts: number; maxReleases: number; sessionMs: number; challengeMs: number;
  /** Finished jobs (and their results) are deleted this long after completion; 0 keeps them forever. Duplicate-submission replays stop working after this. */
  retentionMs: number;
  /** Longest a single lease may be kept alive by renewals. */
  maxLeaseMs: number;
  /** Most QUEUED + LEASED jobs one application may hold; further submissions get 429 QUEUE_LIMIT. */
  maxPendingPerApplication: number;
  /** How long an approval request stays open for the owner to decide (at most 30 minutes). */
  joinRequestMs: number;
  /** Wrong guesses at one invite before it is locked, and refused invite redemptions (from anywhere) in `inviteGlobalWindowMs` before every redemption is paused. */
  inviteMaxAttempts: number; inviteGlobalFailures: number; inviteGlobalWindowMs: number }
export const defaultPolicy: Policy = { staleMs: 15000, offlineMs: 60000, leaseMs: 10000, maxAttempts: 3, maxReleases: 20, sessionMs: 300000, challengeMs: 60000, retentionMs: 30 * 86400000, maxLeaseMs: 3600000, maxPendingPerApplication: 10000, joinRequestMs: 600000, inviteMaxAttempts: 5, inviteGlobalFailures: 100, inviteGlobalWindowMs: 600000 };
function reject(status: number, code: string): never { throw new ApiError(status, code, code.replaceAll('_', ' ').toLowerCase()); }
/** Most enrollment tokens that may be redeemable at the same time; an administrator who needs more has forgotten to revoke some. */
export const MAX_ACTIVE_ENROLLMENTS = 100;
/** Most invites redeemable at once, and most approval requests waiting at once (in all, and from one address). */
export const MAX_ACTIVE_INVITES = 100; export const MAX_PENDING_REQUESTS = 50; export const MAX_PENDING_REQUESTS_PER_SOURCE = 5;
export const inviteId = (handleHash: string): string => `inv_${handleHash.slice(0, 16)}`;
const randomCode = (): string => Array.from(randomBytes(CODE_LENGTH), byte => CODE_ALPHABET[byte & 31]).join(''); // 32 symbols: a masked byte is uniform
const sameHex = (a: string, b: string): boolean => a.length === b.length && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
/** The public identifier of a token, derived from its hash: it names the token in lists and revocations without being able to redeem it. */
export const enrollmentId = (tokenHash: string): string => `enr_${tokenHash.slice(0, 16)}`;

export class Coordinator {
  readonly policy: Policy;
  /** Refused invite redemptions (their times), from anywhere: the global circuit breaker on guessing short codes. */
  private inviteFailures: number[] = [];
  /**
   * `inviteKey` keys the hashes that protect invite codes. It must come from a secret that is not in the database (the server derives it from the administrator secret), so a copy of
   * the database cannot be used to search the small code space offline. Without it invites are switched off.
   */
  /**
   * `transferKeys` is the signing keyring for storage tickets (loaded by the server from its own private file, never from the database); without it every storage route answers 503 and nothing else
   * changes. `storageLimits` and `storageRandom` exist for tests and operators who need to lower the per-application limits.
   */
  readonly storage: StorageControl;
  constructor(readonly store: Store, policy: Partial<Policy> = {}, private readonly now: () => number = Date.now, private readonly scheduler: Scheduler = new ResourceAwareScheduler(),
    private readonly options: { inviteKey?: Buffer; transferKeys?: TransferKeyring; storageLimits?: Partial<StorageLimits>; storageRandom?: () => number } = {}) {
    this.policy = { ...defaultPolicy, ...policy };
    for (const [key, value] of Object.entries(this.policy)) if (!Number.isSafeInteger(value) || value < (key === 'retentionMs' ? 0 : 1)) throw new Error('Invalid policy');
    if (this.policy.offlineMs <= this.policy.staleMs || this.policy.maxAttempts > 100 || this.policy.sessionMs > 86400000 || this.policy.challengeMs > 300000 || this.policy.joinRequestMs > 1800000) throw new Error('Invalid policy boundaries');
    this.storage = new StorageControl(store, { now, status: node => this.status(node), offlineMs: this.policy.offlineMs, keyring: options.transferKeys, limits: options.storageLimits, random: options.storageRandom });
  }
  health() { return { protocolVersion: PROTOCOL_VERSION, serviceVersion: SERVICE_VERSION, coordinatorId: this.store.coordinatorId, status: 'ok' as const }; }
  private grantStatus(grant: Grant): EnrollmentTokenStatus {
    if (grant.revokedAt !== undefined) return 'REVOKED';
    if (grant.used) return 'USED';
    return grant.expiresAt <= this.now() ? 'EXPIRED' : 'ACTIVE';
  }
  /**
   * Issues a one-time enrollment token. Only its SHA-256 is stored, so the raw value exists in this response and nowhere else: not in the database, a log or a later listing.
   * The token is 256 random bits, which is why a plain hash (not a slow one) is enough and why a guess is not worth rate-limiting by anything but cost.
   */
  createEnrollment(input: unknown) {
    const request = EnrollmentTokenRequestSchema.parse(input);
    return this.store.transaction(() => {
      if (this.store.listGrants().filter(grant => grant.kind === undefined && this.grantStatus(grant) === 'ACTIVE').length >= MAX_ACTIVE_ENROLLMENTS) reject(429, 'ENROLLMENT_LIMIT');
      const token = secret(); const tokenHash = hash(token); const createdAt = this.now(); const expiresAt = createdAt + request.expiresInMs;
      this.store.saveGrant({ tokenHash, expiresAt, capabilities: request.capabilities, used: false, createdAt, ...(request.label ? { label: request.label } : {}) });
      return { token, expiresAt, id: enrollmentId(tokenHash), createdAt, capabilities: request.capabilities, ...(request.label ? { label: request.label } : {}) };
    });
  }
  /** Tokens on record (never the token or its hash): active ones, and used, expired and revoked ones for the audit window. */
  listEnrollments(): EnrollmentTokenInfo[] {
    return this.store.listGrants().filter(grant => grant.kind === undefined).map(grant => ({ id: enrollmentId(grant.tokenHash), status: this.grantStatus(grant), createdAt: grant.createdAt ?? null, expiresAt: grant.expiresAt,
      usedAt: grant.usedAt ?? null, revokedAt: grant.revokedAt ?? null, capabilities: grant.capabilities, label: grant.label ?? null, nodeId: grant.usedBy ?? null }))
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0) || (a.id < b.id ? -1 : 1)).slice(0, 5000);
  }
  /** Withdraws a token that has not been used. A token that already enrolled a node cannot be revoked (revoke the node instead); revoking twice is harmless. */
  revokeEnrollment(id: string): void {
    this.store.transaction(() => {
      const grant = this.store.listGrants().find(candidate => candidate.kind === undefined && enrollmentId(candidate.tokenHash) === id); if (!grant) reject(404, 'NOT_FOUND');
      if (grant.used) reject(409, 'ENROLLMENT_ALREADY_USED');
      if (grant.revokedAt === undefined) this.store.saveGrant({ ...grant, revokedAt: this.now() });
    });
  }
  /** One answer for every reason a token cannot be redeemed (unknown, used, expired, revoked): the caller learns nothing about which, or how close a guess was. */
  private grant(tokenHash: string) {
    const grant = this.store.getGrant(tokenHash);
    if (!grant || grant.kind !== undefined || grant.used || grant.revokedAt !== undefined || grant.expiresAt <= this.now()) reject(401, 'INVALID_ENROLLMENT');
    return grant;
  }
  /** The grant an enrollment may still consume, by what it was issued as; one generic refusal per kind. Called again inside the transaction that consumes it. */
  private redeemable(tokenHash: string, kind: 'token' | 'invite' | 'request'): Grant {
    if (kind === 'token') return this.grant(tokenHash);
    const grant = this.store.getGrant(tokenHash); const code = kind === 'invite' ? 'INVALID_INVITE' : 'INVALID_JOIN';
    if (!grant || grant.kind !== kind || grant.used || grant.revokedAt !== undefined || grant.expiresAt <= this.now()) reject(401, code);
    if (kind === 'invite' && grant.lockedAt !== undefined) reject(401, code);
    if (kind === 'request' && grant.status !== 'APPROVED') reject(401, code);
    return grant;
  }
  /** Checks the key and the capabilities against what the grant allows and issues the ordinary enrollment challenge: every route into enrollment ends in the same proof of key possession. */
  private startEnrollment(grant: Grant, kind: 'token' | 'invite' | 'request', request: { publicKey: string; protocolVersion: 1; daemonVersion: string; capabilities?: JobType[] | undefined }): Challenge {
    // Omitted means "everything this grant allows"; named capabilities must all be allowed.
    const capabilities = request.capabilities ?? grant.capabilities;
    if (capabilities.some(capability => !grant.capabilities.includes(capability))) reject(403, 'CAPABILITY_FORBIDDEN');
    let key: { publicKey: string; nodeId: string };
    try { key = canonicalPublicKey(request.publicKey); } catch { reject(400, 'INVALID_PUBLIC_KEY'); }
    if (this.store.getNode(key.nodeId)) reject(409, 'NODE_ALREADY_REGISTERED');
    // Do not retain the raw enrollment token (or code) in challenge persistence: only the grant's lookup hash.
    return this.challenge('enroll', key.nodeId, key.publicKey, { publicKey: request.publicKey, protocolVersion: request.protocolVersion, daemonVersion: request.daemonVersion, capabilities },
      grant.tokenHash, kind === 'token' ? undefined : kind);
  }
  beginEnrollment(input: unknown): Challenge {
    const request = EnrollmentStartSchema.parse(input);
    return this.store.transaction(() => this.startEnrollment(this.grant(hash(request.token)), 'token', request));
  }

  // ---- Invites: short, owner-created introductions --------------------------------------------------------------------------------------------------------------------------
  private inviteKey(): Buffer { if (!this.options.inviteKey) reject(404, 'NOT_FOUND'); return this.options.inviteKey; }
  private inviteHash(part: 'handle' | 'secret', value: string): string { return createHmac('sha256', this.inviteKey()).update(`privanet.invite.${part}.v1\0${value}`).digest('hex'); }
  private inviteStatus(grant: Grant): InviteStatus {
    if (grant.revokedAt !== undefined) return 'REVOKED';
    if (grant.used) return 'USED';
    if (grant.lockedAt !== undefined) return 'LOCKED';
    return grant.expiresAt <= this.now() ? 'EXPIRED' : 'ACTIVE';
  }
  /**
   * Creates a short code (`N7K4-PQ2M`: 40 bits) as an introduction, not a credential. Only keyed hashes are stored, so neither the code nor anything that searches for it offline is
   * kept; the code is in this answer and nowhere else. The first half finds the invite, the second half is checked; five wrong second halves lock the invite.
   */
  createInvite(input: unknown) {
    this.inviteKey(); const request = InviteRequestSchema.parse(input);
    return this.store.transaction(() => {
      if (this.store.listGrants().filter(grant => grant.kind === 'invite' && this.inviteStatus(grant) === 'ACTIVE').length >= MAX_ACTIVE_INVITES) reject(429, 'INVITE_LIMIT');
      let code = randomCode(); let handleHash = this.inviteHash('handle', code.slice(0, 4));
      for (let attempt = 0; this.store.getGrant(handleHash) && attempt < 100; attempt++) { code = randomCode(); handleHash = this.inviteHash('handle', code.slice(0, 4)); }
      if (this.store.getGrant(handleHash)) reject(429, 'INVITE_LIMIT');
      const createdAt = this.now(); const expiresAt = createdAt + request.expiresInMs;
      this.store.saveGrant({ tokenHash: handleHash, kind: 'invite', secretHash: this.inviteHash('secret', code), failedAttempts: 0, expiresAt, capabilities: request.capabilities, used: false, createdAt,
        ...(request.label ? { label: request.label } : {}) });
      return { code: formatCode(code), id: inviteId(handleHash), createdAt, expiresAt, capabilities: request.capabilities, ...(request.label ? { label: request.label } : {}) };
    });
  }
  /** Invites on record: ID, status, audit times and how many wrong guesses were made at each; never the code. */
  listInvites(): InviteInfo[] {
    this.inviteKey();
    return this.store.listGrants().filter(grant => grant.kind === 'invite').map(grant => ({ id: inviteId(grant.tokenHash), status: this.inviteStatus(grant), createdAt: grant.createdAt ?? 0, expiresAt: grant.expiresAt,
      usedAt: grant.usedAt ?? null, revokedAt: grant.revokedAt ?? null, capabilities: grant.capabilities, label: grant.label ?? null, nodeId: grant.usedBy ?? null, failedAttempts: grant.failedAttempts ?? 0 }))
      .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? -1 : 1)).slice(0, 5000);
  }
  revokeInvite(id: string): void {
    this.inviteKey();
    this.store.transaction(() => {
      const grant = this.store.listGrants().find(candidate => candidate.kind === 'invite' && inviteId(candidate.tokenHash) === id); if (!grant) reject(404, 'NOT_FOUND');
      if (grant.used) reject(409, 'INVITE_ALREADY_USED');
      if (grant.revokedAt === undefined) this.store.saveGrant({ ...grant, revokedAt: this.now() });
    });
  }
  /**
   * Presents a code with the node's own public key and gets the ordinary enrollment challenge back; the ordinary proof of key possession then consumes the invite and registers the node, so
   * a short code never becomes a bearer credential. Every reason a code does not work (never existed, used, expired, revoked, locked, wrong) is one answer. A wrong second half counts against
   * the invite it was aimed at (locking it after `inviteMaxAttempts`), every refusal counts against a global budget (`inviteGlobalFailures` per window) beyond which all redemption pauses, and
   * the server adds a per-address limit: guessing 40 bits online under all three is not practical.
   */
  beginInvite(input: unknown): Challenge {
    this.inviteKey(); const request = InviteChallengeRequestSchema.parse(input); const now = this.now();
    this.inviteFailures = this.inviteFailures.filter(at => now - at < this.policy.inviteGlobalWindowMs);
    if (this.inviteFailures.length >= this.policy.inviteGlobalFailures) reject(429, 'RATE_LIMIT');
    const code = normalizeCode(request.code);
    // The same hashing work is done for any input, so the time taken does not say whether the first half named a real invite.
    const handleHash = this.inviteHash('handle', code?.slice(0, 4) ?? '????'); const secretHash = this.inviteHash('secret', code ?? '????????');
    const outcome = this.store.transaction((): { challenge: Challenge } | { refused: true } => {
      const grant = code === null ? undefined : this.store.getGrant(handleHash);
      if (!grant || grant.kind !== 'invite' || grant.used || grant.revokedAt !== undefined || grant.lockedAt !== undefined || grant.expiresAt <= now) return { refused: true };
      if (!sameHex(grant.secretHash ?? '', secretHash)) {
        const failedAttempts = (grant.failedAttempts ?? 0) + 1;
        this.store.saveGrant({ ...grant, failedAttempts, ...(failedAttempts >= this.policy.inviteMaxAttempts ? { lockedAt: now } : {}) });
        return { refused: true };
      }
      return { challenge: this.startEnrollment(grant, 'invite', request) };
    });
    if ('refused' in outcome) { this.inviteFailures.push(now); reject(401, 'INVALID_INVITE'); }
    return outcome.challenge;
  }

  // ---- Approval requests: the machine asks, the owner decides ----------------------------------------------------------------------------------------------------------------
  private joinKey(requestId: string): string { return hash(`privanet.join.v1:${requestId}`); }
  private joinLive(grant: Grant): boolean { return grant.kind === 'request' && !grant.used && grant.expiresAt > this.now() && grant.status !== 'DENIED'; }
  private joinStatus(grant: Grant): 'PENDING' | 'APPROVED' | 'DENIED' | 'EXPIRED' | 'COMPLETED' {
    if (grant.used) return 'COMPLETED';
    if (grant.expiresAt <= this.now()) return 'EXPIRED';
    return grant.status ?? 'PENDING';
  }
  /**
   * A machine asks to join. The request is bound to its public key and carries no secret: the confirmation code only lets the owner name the request, and the machine proves the key
   * again (the ordinary signed challenge) before anything is registered. Bounded in number, in total and per source address, and short lived.
   */
  createJoinRequest(input: unknown, source: string) {
    const request = JoinRequestSchema.parse(input);
    let key: { publicKey: string; nodeId: string };
    try { key = canonicalPublicKey(request.publicKey); } catch { reject(400, 'INVALID_PUBLIC_KEY'); }
    return this.store.transaction(() => {
      const now = this.now(); const all = this.store.listGrants().filter(grant => grant.kind === 'request'); const live = all.filter(grant => this.joinLive(grant));
      if (this.store.getNode(key.nodeId)) reject(409, 'NODE_ALREADY_REGISTERED');
      if (live.some(grant => grant.nodeId === key.nodeId)) reject(409, 'REQUEST_PENDING');
      if (live.length >= MAX_PENDING_REQUESTS || live.filter(grant => grant.source === source).length >= MAX_PENDING_REQUESTS_PER_SOURCE) reject(429, 'REQUEST_LIMIT');
      let code = randomCode(); for (let attempt = 0; attempt < 100 && live.some(grant => grant.code === code); attempt++) code = randomCode();
      const requestId = randomUUID(); const expiresAt = now + this.policy.joinRequestMs;
      this.store.saveGrant({ tokenHash: this.joinKey(requestId), kind: 'request', expiresAt, capabilities: [], used: false, createdAt: now, status: 'PENDING', publicKey: key.publicKey, nodeId: key.nodeId, code,
        requestedCapabilities: request.capabilities ?? [], ...(request.deviceName ? { deviceName: request.deviceName } : {}), source: source.slice(0, 64), daemonVersion: request.daemonVersion });
      return { requestId, code: formatCode(code), expiresAt, pollAfterMs: 2000 };
    });
  }
  /** What the machine polls. An unknown request is `EXPIRED`, the same as one that ran out, so the answer is no oracle for request IDs (which are random 122-bit values anyway). */
  joinStatusOf(input: unknown) {
    const request = JoinStatusRequestSchema.parse(input); const grant = this.store.getGrant(this.joinKey(request.requestId));
    if (!grant || grant.kind !== 'request') return { status: 'EXPIRED' as const, expiresAt: null, pollAfterMs: 5000 };
    return { status: this.joinStatus(grant), expiresAt: grant.expiresAt, pollAfterMs: 2000 };
  }
  /** Once approved, the machine gets the ordinary challenge for the key it asked with; only a signature from that key (the ordinary proof) completes it. */
  beginJoin(input: unknown): Challenge {
    const request = JoinChallengeRequestSchema.parse(input);
    return this.store.transaction(() => {
      const grant = this.redeemable(this.joinKey(request.requestId), 'request');
      return this.startEnrollment(grant, 'request', { publicKey: grant.publicKey ?? '', protocolVersion: PROTOCOL_VERSION, daemonVersion: grant.daemonVersion ?? '0.0.0' });
    });
  }
  private requestByCode(code: string): Grant {
    const normalized = normalizeCode(code); const grant = normalized === null ? undefined : this.store.listGrants().find(candidate => candidate.kind === 'request' && candidate.code === normalized && this.joinLive(candidate));
    if (!grant) reject(404, 'NOT_FOUND');
    return grant;
  }
  listRequests(): JoinRequestInfo[] {
    return this.store.listGrants().filter(grant => grant.kind === 'request').map(grant => ({ code: formatCode(grant.code ?? '00000000'), status: this.joinStatus(grant), createdAt: grant.createdAt ?? 0, expiresAt: grant.expiresAt,
      nodeId: grant.nodeId ?? '', requestedCapabilities: grant.requestedCapabilities ?? [], deviceName: grant.deviceName ?? null, daemonVersion: grant.daemonVersion ?? '0.0.0', source: grant.source ?? '',
      approvedCapabilities: grant.status === 'APPROVED' || grant.used ? grant.capabilities : null, label: grant.label ?? null, nodeEnrolled: grant.usedBy ?? null }) as JoinRequestInfo)
      .sort((a, b) => b.createdAt - a.createdAt || (a.code < b.code ? -1 : 1)).slice(0, 5000);
  }
  /** The owner's decision: sets the capability ceiling (and a name). Only a pending request can be approved, and only once. */
  approveRequest(code: string, input: unknown): void {
    const approval = JoinApprovalSchema.parse(input);
    this.store.transaction(() => {
      const grant = this.requestByCode(code); if (grant.status !== 'PENDING') reject(409, 'REQUEST_NOT_PENDING');
      this.store.saveGrant({ ...grant, status: 'APPROVED', capabilities: approval.capabilities, approvedAt: this.now(), ...(approval.label ? { label: approval.label } : {}) });
    });
  }
  /** Refuses a request, or withdraws an approval the machine has not yet used. */
  denyRequest(code: string): void {
    this.store.transaction(() => { const grant = this.requestByCode(code); this.store.saveGrant({ ...grant, status: 'DENIED', deniedAt: this.now() }); });
  }
  beginAuth(nodeId: string): Challenge {
    const node = this.store.getNode(nodeId);
    if (!node || node.revoked) reject(401, 'UNAUTHORIZED_NODE');
    return this.store.transaction(() => this.challenge('auth', node.nodeId, node.publicKey, null, null));
  }
  private challenge(purpose: 'enroll' | 'auth', nodeId: string, publicKey: string, enrollment: ChallengeRecord['enrollment'], grantHash: string | null, grantKind?: 'invite' | 'request'): Challenge {
    this.store.prune(this.now());
    if (this.store.countChallenges() >= 1000) reject(429, 'CHALLENGE_LIMIT');
    const message = JSON.stringify({ domain: 'privanet.node-proof.v1', coordinatorId: this.store.coordinatorId, purpose, nodeId, nonce: secret() });
    const result = { challengeId: randomUUID(), message, expiresAt: this.now() + this.policy.challengeMs, coordinatorId: this.store.coordinatorId };
    this.store.saveChallenge({ ...result, purpose, nodeId, publicKey, enrollment, grantHash, ...(grantKind ? { grantKind } : {}) });
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
        const grant = this.redeemable(challenge.grantHash, challenge.grantKind ?? 'token');
        if (this.store.getNode(challenge.nodeId)) reject(409, 'NODE_ALREADY_REGISTERED');
        if (this.store.listNodes().length >= 1000) reject(429, 'NODE_LIMIT');
        this.store.saveNode({ nodeId: challenge.nodeId, publicKey: challenge.publicKey,
          capabilities: challenge.enrollment.capabilities, allowedCapabilities: grant.capabilities,
          protocolVersion: PROTOCOL_VERSION, daemonVersion: challenge.enrollment.daemonVersion,
          enrolledAt: this.now(), lastHeartbeatAt: null, revoked: false, currentJobs: 0, jobSlots: 1,
          ...(grant.label ? { displayName: grant.label } : {}) });
        // The grant is re-read and consumed in the same transaction that creates the node, so of any number of concurrent redemptions exactly one can pass `this.grant` above.
        this.store.saveGrant({ ...grant, used: true, usedAt: this.now(), usedBy: challenge.nodeId });
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
    const { fetchIdentity, allowedServices, ...rest } = request;
    // `allowedServices` is stored only when given and non-empty, so an application created without one is byte-for-byte what it was before services existed.
    this.store.saveApplication({ id: applicationId, tokenHash: hash(token), ...rest, ...(fetchIdentity ? { fetchIdentity } : {}), ...(allowedServices && allowedServices.length > 0 ? { allowedServices } : {}), revoked: false });
    return { applicationId, token };
  }
  authenticateApplication(token: string): ApplicationRecord {
    const app = this.store.findApplication(hash(token));
    if (!app || app.revoked) reject(401, 'UNAUTHORIZED_APPLICATION');
    return app;
  }
  revokeApplication(id: string): void {
    this.store.transaction(() => {
      const app = this.store.getApplication(id); if (!app) reject(404, 'NOT_FOUND');
      this.store.saveApplication({ ...app, revoked: true }); this.storage.onApplicationRevoked(id); // its open storage transfers become unusable; its chunks stay
    });
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
      this.store.saveNode({ ...node, revoked: true, revokedAt: node.revokedAt ?? this.now() }); this.store.deleteNodeSessions(id); this.storage.onNodeRevoked(id);
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
      ...(node.resources ? { resources: node.resources } : {}),
      ...(node.displayName ? { displayName: node.displayName } : {}), enrolledAt: node.enrolledAt, ...(node.revokedAt !== undefined ? { revokedAt: node.revokedAt } : {}) }));
  }
  /** Names a node for the administrator's lists (`null` removes the name). A renamed node keeps its identity and credentials; a revoked one can still be renamed. */
  renameNode(id: string, input: unknown): void {
    const request = NodeRenameSchema.parse(input);
    this.store.transaction(() => {
      const node = this.store.getNode(id); if (!node) reject(404, 'NOT_FOUND');
      const renamed: NodeRecord = { ...node }; delete renamed.displayName;
      this.store.saveNode(request.displayName === null ? renamed : { ...renamed, displayName: request.displayName });
    });
  }
  /** What a node may learn about itself with its own session. */
  nodeSelf(node: NodeRecord) {
    return { nodeId: node.nodeId, ...(node.displayName ? { displayName: node.displayName } : {}), enrolledAt: node.enrolledAt, capabilities: node.capabilities,
      allowedCapabilities: node.allowedCapabilities, protocolVersion: node.protocolVersion };
  }
  heartbeat(nodeId: string, input: unknown): void {
    const request = HeartbeatSchema.parse(input);
    const node = this.store.getNode(nodeId); if (!node || node.revoked) reject(401, 'UNAUTHORIZED_NODE');
    if (request.capabilities.some(capability => !node.allowedCapabilities.includes(capability))) reject(403, 'CAPABILITY_FORBIDDEN');
    const { lifecycle = 'ACTIVE', resources, services, ...rest } = request;
    // Absent resources means the node no longer reports them: never keep a stale, more generous budget. The same goes for services: the advertisement is replaced (or removed) with every heartbeat.
    const kept: NodeRecord = { ...node }; delete kept.resources;
    this.store.transaction(() => {
      this.store.saveNode({ ...kept, ...rest, lifecycle, ...(resources ? { resources } : {}), lastHeartbeatAt: this.now() });
      this.storage.recordServices(nodeId, services);
    });
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
    // Fail at submission, not on a node: an application that acts on the outside world must have a registered identity.
    if (requiresClientIdentity(request.type) && !app.fetchIdentity) reject(403, 'FETCH_IDENTITY_REQUIRED');
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
      this.store.saveJob(job); this.notifyWork(job.type); return this.view(job);
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
    if (!exhausted) this.notifyWork(job.type); else this.notifyJobFinished(job.id);
  }
  private readonly workListeners = new Map<string, Set<{ capabilities: readonly string[]; wake: () => void }>>();
  /**
   * Calls `wake` (asynchronously, never inside a transaction) when a job this node could run becomes leasable: submitted, released or requeued.
   * Returns the unsubscribe function. Each work event wakes at most one waiter per capable node: every lane of a node asks the same
   * scheduler question about the same node, so waking the others only repeats the work (measured: waking every waiting request on each
   * submission made the cost of a job grow with the number of waiting lanes and halved throughput at 128 of them).
   */
  onWork(nodeId: string, capabilities: readonly string[], wake: () => void): () => void {
    const waiter = { capabilities, wake }; let set = this.workListeners.get(nodeId);
    if (!set) { set = new Set(); this.workListeners.set(nodeId, set); }
    set.add(waiter);
    return () => { const current = this.workListeners.get(nodeId); current?.delete(waiter); if (current?.size === 0) this.workListeners.delete(nodeId); };
  }
  private readonly jobListeners = new Map<string, Set<() => void>>();
  /** Calls `listener` (asynchronously) when the job reaches a final state. Returns the unsubscribe function. */
  onJobFinished(id: string, listener: () => void): () => void {
    let set = this.jobListeners.get(id); if (!set) { set = new Set(); this.jobListeners.set(id, set); }
    set.add(listener); return () => { const current = this.jobListeners.get(id); current?.delete(listener); if (current?.size === 0) this.jobListeners.delete(id); };
  }
  private notifyJobFinished(id: string): void { for (const listener of [...(this.jobListeners.get(id) ?? [])]) queueMicrotask(listener); }
  private notifyWork(type: JobType): void {
    const capability = JOB_TYPES[type].capability;
    for (const [nodeId, set] of this.workListeners) {
      for (const waiter of set) if (waiter.capabilities.includes(capability)) { set.delete(waiter); if (set.size === 0) this.workListeners.delete(nodeId); queueMicrotask(waiter.wake); break; }
    }
  }
  private lastRetentionAt = 0;
  maintain(): void { this.sweep(); this.storage.maintain(); }
  /** Housekeeping and expiry; returns the pending jobs as they stand afterwards so a caller that needs them does not read and parse them again. */
  private sweep(): JobRecord[] {
    return this.store.transaction(() => {
      this.store.prune(this.now());
      // The retention sweep scans finished jobs, so it runs at most once a minute.
      if (this.policy.retentionMs > 0 && this.now() - this.lastRetentionAt >= 60000) { this.lastRetentionAt = this.now(); this.store.deleteTerminalJobs(this.now() - this.policy.retentionMs); }
      const pending = this.store.listPendingJobs(); let changed = false;
      for (const job of pending) {
        if (job.status === 'LEASED' && job.leaseExpiresAt !== null && job.leaseExpiresAt <= this.now()) { this.retry(job, 'LEASE_EXPIRED'); changed = true; }
        else if (job.status === 'QUEUED' && job.attempts >= this.policy.maxAttempts) { this.retry(job, job.error?.code ?? 'LEASE_EXPIRED'); changed = true; }
      }
      return changed ? this.store.listPendingJobs() : pending;
    });
  }
  lease(nodeId: string): Lease | null {
    return this.store.transaction(() => {
      const pending = this.sweep();
      const node = this.store.getNode(nodeId);
      if (!node || node.revoked) reject(401, 'UNAUTHORIZED_NODE');
      if (this.status(node) !== 'ONLINE') return null;
      const job = this.scheduler.choose(node, pending);
      if (!job) return null;
      const leaseId = randomUUID(); const expiresAt = this.now() + this.policy.leaseMs;
      const next: JobRecord = { ...job, status: 'LEASED', attempts: job.attempts + 1,
        assignedNodeId: nodeId, leaseId, leaseExpiresAt: expiresAt, leasedAt: this.now(), error: null };
      this.store.saveJob(next);
      // The identity comes from the application record, never from the job, and is sent only for capabilities that need it,
      // so v0.2 nodes (which parse leases strictly and cannot advertise such a capability) never see the extra field.
      const identity = requiresClientIdentity(job.type) ? this.store.getApplication(job.applicationId)?.fetchIdentity : undefined;
      if (requiresClientIdentity(job.type) && !identity) reject(409, 'FETCH_IDENTITY_REQUIRED');
      return { jobId: job.id, type: job.type, input: job.input, protocolVersion: PROTOCOL_VERSION, leaseId, expiresAt, attempt: next.attempts, ...(identity ? { client: identity } : {}) };
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
    if (!exhausted) this.notifyWork(job.type); else this.notifyJobFinished(job.id);
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
      this.store.saveJob({ ...job, ...outcome, status, completedAt: this.now() }); this.notifyJobFinished(id);
    });
  }
}
