import type { Challenge, EnrollmentStart, Job, JobType, NodeView } from '@privanet/protocol';
export interface NodeRecord extends Omit<NodeView, 'status'> {
  publicKey: string; allowedCapabilities: JobType[]; enrolledAt: number; revoked: boolean;
}
export interface ApplicationRecord { id: string; tokenHash: string; name: string; allowedJobTypes: JobType[]; revoked: boolean }
export interface Grant { tokenHash: string; expiresAt: number; capabilities: JobType[]; used: boolean }
export interface ChallengeRecord extends Challenge {
  purpose: 'enroll' | 'auth'; nodeId: string; publicKey: string;
  enrollment: Omit<EnrollmentStart, 'token'> | null; grantHash: string | null;
}
export interface NodeSession { tokenHash: string; nodeId: string; expiresAt: number }
export interface JobRecord extends Job {
  applicationId: string; idempotencyKey: string;
  assignedNodeId: string | null; leaseId: string | null; leaseExpiresAt: number | null;
}
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
  prune(now: number): void;
  close(): void;
}
