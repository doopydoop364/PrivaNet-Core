import type { Challenge, EnrollmentStart, FetchIdentity, Job, JobType, NodeView, ServiceId, StorageAdvertisement, StorageOperation, TransferState } from '@privanet/protocol';
export interface NodeRecord extends Omit<NodeView, 'status'> {
  publicKey: string; allowedCapabilities: JobType[]; enrolledAt: number; revoked: boolean;
  /** Absent in records written before Phase 2; treated as ACTIVE. DEPARTED = announced planned departure. */
  lifecycle?: 'ACTIVE' | 'DRAINING' | 'DEPARTED';
}
export interface ApplicationRecord { id: string; tokenHash: string; name: string; allowedJobTypes: JobType[]; revoked: boolean; fetchIdentity?: FetchIdentity;
  /** Added in 0.4.0-alpha.2. Absent (every record written before it) means none: an application never gains a service it was not explicitly given. */
  allowedServices?: ServiceId[] }
export interface Grant {
  tokenHash: string; expiresAt: number; capabilities: JobType[]; used: boolean;
  /** Added by Remote Node Onboarding; absent on a grant written before it (such a grant still redeems exactly as before and is listed with unknown creation time). */
  createdAt?: number; label?: string; usedAt?: number; usedBy?: string; revokedAt?: number;
  /** Absent for a plain enrollment token. `invite`: a short code, stored only as keyed hashes. `request`: a machine's approval request (it is redeemable once approved). Both live in the grants table as JSON records, so they need no migration. */
  kind?: 'invite' | 'request';
  /** invite: the keyed hash of the whole code, wrong guesses at this invite so far, and when it was locked for too many of them. (`tokenHash` is the keyed hash of the code's first half, which finds the invite.) */
  secretHash?: string; failedAttempts?: number; lockedAt?: number;
  /** request: the key the request is bound to, the node ID it implies, its confirmation code (an identifier, not a secret), the decision, and what the machine asked for. */
  publicKey?: string; nodeId?: string; code?: string; status?: 'PENDING' | 'APPROVED' | 'DENIED'; requestedCapabilities?: JobType[]; deviceName?: string; source?: string;
  daemonVersion?: string; approvedAt?: number; deniedAt?: number;
}
export interface ChallengeRecord extends Challenge {
  purpose: 'enroll' | 'auth'; nodeId: string; publicKey: string;
  /** What `grantHash` names: an enrollment token (absent), an invite or an approved request. */
  grantKind?: 'invite' | 'request';
  enrollment: (Omit<EnrollmentStart, 'token' | 'capabilities'> & { capabilities: JobType[] }) | null; grantHash: string | null;
}
export interface NodeSession { tokenHash: string; nodeId: string; expiresAt: number }
export interface JobRecord extends Job {
  applicationId: string; idempotencyKey: string;
  assignedNodeId: string | null; leaseId: string | null; leaseExpiresAt: number | null;
  /** Graceful hand-backs (drain/preemption); absent in older records. Bounded by policy.maxReleases. */
  releases?: number;
  /** When the current lease was first granted; renewals may not extend a lease past this plus policy.maxLeaseMs. */
  leasedAt?: number;
}
// ---- Storage control plane (0.4.0-alpha.2): metadata only ----
export interface ChunkRecord { applicationId: string; chunkId: string; size: number; class: string | null; state: 'PENDING' | 'STORED' | 'DELETING'; createdAt: number; updatedAt: number; expiresAt: number | null }
export interface ReplicaRecord { applicationId: string; chunkId: string; nodeId: string; state: 'RESERVED' | 'STORED' | 'LOST'; size: number; reservedAt: number; storedAt: number | null; verifiedAt: number | null }
export interface TransferRecord {
  id: string; operation: StorageOperation; applicationId: string; chunkId: string; nodeId: string; kid: string;
  /** SHA-256 of the holder's public key: enough to audit which key a ticket named, without keeping the key. The ticket itself is never stored. */
  holderHash: string; maxBytes: number; state: TransferState; reason: string | null; issuedAt: number; expiresAt: number; startedAt: number | null; completedAt: number | null; evidence: Record<string, unknown> | null;
}
export interface NodeServiceRecord extends StorageAdvertisement { nodeId: string; service: ServiceId; reportedAt: number }
export interface Store {
  readonly coordinatorId: string;
  transaction<T>(operation: () => T): T;
  getNode(id: string): NodeRecord | undefined;
  saveNode(node: NodeRecord): void;
  listNodes(): NodeRecord[];
  getApplication(id: string): ApplicationRecord | undefined;
  findApplication(tokenHash: string): ApplicationRecord | undefined;
  saveApplication(app: ApplicationRecord): void;
  getGrant(hash: string): Grant | undefined;
  saveGrant(grant: Grant): void;
  /** Every retained grant, newest expiry first (used and expired ones are kept for an audit window: see `prune`). */
  listGrants(): Grant[];
  getChallenge(id: string): ChallengeRecord | undefined;
  saveChallenge(challenge: ChallengeRecord): void;
  deleteChallenge(id: string): void;
  countChallenges(): number;
  getSession(hash: string): NodeSession | undefined;
  saveSession(session: NodeSession): void;
  deleteNodeSessions(nodeId: string): void;
  getJob(id: string): JobRecord | undefined;
  findSubmission(applicationId: string, key: string): JobRecord | undefined;
  saveJob(job: JobRecord): void;
  listPendingJobs(): JobRecord[];
  /** QUEUED plus LEASED jobs of one application (used for its queue quota). */
  countPendingJobs(applicationId: string): number;
  /** Deletes COMPLETED/FAILED jobs finished at or before the cutoff and returns how many were removed. */
  deleteTerminalJobs(completedBefore: number): number;
  prune(now: number): void;
  // -- storage control plane
  getChunk(applicationId: string, chunkId: string): ChunkRecord | undefined;
  saveChunk(chunk: ChunkRecord): void;
  /** Removes the chunk and its replicas (the transfer rows stay, as the audit trail). */
  deleteChunk(applicationId: string, chunkId: string): void;
  /** Chunks of one application that count against its limits (PENDING, STORED and DELETING). */
  chunkUsage(applicationId: string): { count: number; bytes: number };
  getReplica(applicationId: string, chunkId: string, nodeId: string): ReplicaRecord | undefined;
  listReplicas(applicationId: string, chunkId: string): ReplicaRecord[];
  saveReplica(replica: ReplicaRecord): void;
  deleteReplica(applicationId: string, chunkId: string, nodeId: string): void;
  listNodeReplicas(nodeId: string, state?: ReplicaRecord['state']): ReplicaRecord[];
  /** Bytes reserved (RESERVED replicas) on a node, per node. */
  reservedBytes(): Map<string, number>;
  getTransfer(id: string): TransferRecord | undefined;
  saveTransfer(transfer: TransferRecord): void;
  /** Transfers in AUTHORIZED or IN_PROGRESS, filtered; the filters combine. */
  listOpenTransfers(filter?: { applicationId?: string; nodeId?: string; chunk?: { applicationId: string; chunkId: string } }): TransferRecord[];
  countOpenTransfers(filter: { applicationId?: string; nodeId?: string }): number;
  /** Open transfers per node (all operations, and puts alone) in one grouped query. */
  openTransferCounts(): Map<string, { total: number; puts: number }>;
  /** Open transfers whose time has run out: AUTHORIZED past `expiresAt`, IN_PROGRESS past `expiresAt` plus `graceMs`. */
  listOverdueTransfers(now: number, graceMs: number): TransferRecord[];
  /** Deletes final transfers that ended at or before the cutoff; returns how many. */
  deleteFinalTransfers(endedBefore: number): number;
  transferCounts(since: number): Record<TransferState, number>;
  /** PENDING chunks nobody has touched since the cutoff, and that have no open transfer. */
  listAbandonedChunks(updatedBefore: number, limit: number): ChunkRecord[];
  getNodeService(nodeId: string, service: ServiceId): NodeServiceRecord | undefined;
  saveNodeService(record: NodeServiceRecord): void;
  deleteNodeServices(nodeId: string): void;
  listNodeServices(service: ServiceId): NodeServiceRecord[];
  /** Deletes advertisements last reported at or before the cutoff; returns how many. */
  deleteStaleNodeServices(reportedBefore: number): number;
  storedReplicaTotals(): Map<string, { committedBytes: number; lostBytes: number }>;
  storageTotals(): { pending: number; stored: number; deleting: number; storedBytes: number; reservedBytes: number };
  close(): void;
}
