import { setTimeout as delay } from 'node:timers/promises';
import { AckSchema, CapabilitiesSchema, ChallengeSchema, HealthSchema, LeaseResponseSchema, PROTOCOL_VERSION, SERVICE_VERSION, SessionSchema } from '@privanet/protocol';
import type { JobType, Session } from '@privanet/protocol';
import { ApiError, Transport } from '@privanet/shared';
import type { TransportOptions } from '@privanet/shared';
import { bindCoordinator, loadIdentity, signProof } from './identity.js';
import type { Identity } from './identity.js';
import { executeLease } from './handlers.js';
export interface NodeOptions extends TransportOptions {
  stateDir: string; capabilities: JobType[]; enrollmentToken?: string;
  heartbeatMs?: number; pollMs?: number; log?: (entry: { event: string; code?: string }) => void;
}
export class PrivaNode {
  readonly capabilities: JobType[];
  private readonly transport: Transport;
  private readonly heartbeatMs: number;
  private readonly pollMs: number;
  private readonly log: NonNullable<NodeOptions['log']>;
  private identity: Identity | undefined;
  private session: Session | undefined;
  private lastHeartbeat = 0;
  private enrollmentToken: string | undefined;
  private busy = false;
  private currentJobs = 0;
  constructor(private readonly options: NodeOptions) {
    this.transport = new Transport(options); this.capabilities = CapabilitiesSchema.parse(options.capabilities);
    this.heartbeatMs = options.heartbeatMs ?? 5000; this.pollMs = options.pollMs ?? 1000;
    for (const value of [this.heartbeatMs, this.pollMs]) if (!Number.isSafeInteger(value) || value < 1 || value > 60000) throw new Error('Invalid daemon interval');
    this.log = options.log ?? (() => {}); this.enrollmentToken = options.enrollmentToken;
  }
  get status() { return { nodeId: this.identity?.nodeId ?? null, connected: this.session !== undefined && this.session.expiresAt > Date.now(), capabilities: [...this.capabilities], currentJobs: this.currentJobs }; }
  async connect(): Promise<void> {
    this.identity ??= await loadIdentity(this.options.stateDir);
    const identity = this.identity;
    const health = await this.transport.request('GET', '/v1/health', HealthSchema);
    await bindCoordinator(this.options.stateDir, this.transport.origin, health.coordinatorId);
    let purpose: 'auth' | 'enroll' = 'auth';
    let challenge;
    try {
      challenge = await this.transport.request('POST', '/v1/auth/challenge', ChallengeSchema, { nodeId: identity.nodeId, protocolVersion: PROTOCOL_VERSION });
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401 || !this.enrollmentToken) throw error;
      purpose = 'enroll';
      challenge = await this.transport.request('POST', '/v1/enrollment/challenge', ChallengeSchema, {
        token: this.enrollmentToken, publicKey: identity.publicKey, protocolVersion: PROTOCOL_VERSION,
        daemonVersion: SERVICE_VERSION, capabilities: this.capabilities,
      });
    }
    const session = await this.transport.request('POST', purpose === 'enroll' ? '/v1/enrollment/proof' : '/v1/auth/proof', SessionSchema,
      signProof(identity, challenge, health.coordinatorId, purpose));
    if (session.nodeId !== identity.nodeId || session.coordinatorId !== health.coordinatorId) throw new Error('Invalid node session binding');
    this.session = session; this.enrollmentToken = undefined; this.lastHeartbeat = 0;
    this.log({ event: purpose === 'enroll' ? 'node.enrolled' : 'node.authenticated' });
  }
  private async heartbeat(force = false) {
    if (!this.session || (!force && Date.now() - this.lastHeartbeat < this.heartbeatMs)) return;
    await this.transport.request('POST', '/v1/node/heartbeat', AckSchema, {
      protocolVersion: PROTOCOL_VERSION, daemonVersion: SERVICE_VERSION, capabilities: this.capabilities,
      jobSlots: 1, currentJobs: this.currentJobs,
    }, this.session.token);
    this.lastHeartbeat = Date.now();
  }
  async tick(): Promise<void> {
    if (this.busy) throw new Error('Daemon already polling');
    this.busy = true;
    try {
      if (!this.session || this.session.expiresAt <= Date.now() + 1000) await this.connect();
      await this.heartbeat();
      const session = this.session;
      if (!session) throw new Error('Missing session');
      const { lease } = await this.transport.request('POST', '/v1/node/jobs/lease', LeaseResponseSchema, {}, session.token);
      if (!lease) return;
      if (lease.expiresAt <= Date.now()) { this.log({ event: 'job.lease_expired' }); return; }
      this.currentJobs = 1;
      // Handler failure and result transport failure are separate: lost completion
      // acknowledgement must not be changed into a terminal handler failure.
      let result;
      try { result = executeLease(lease, this.capabilities); }
      catch {
        await this.transport.request('POST', `/v1/node/jobs/${lease.jobId}/fail`, AckSchema,
          { leaseId: lease.leaseId, error: { code: this.capabilities.includes(lease.type) ? 'HANDLER_FAILED' : 'CAPABILITY_DISABLED' } }, session.token);
        this.log({ event: 'job.handler_failed' }); return;
      }
      await this.transport.request('POST', `/v1/node/jobs/${lease.jobId}/complete`, AckSchema, { leaseId: lease.leaseId, result }, session.token);
      this.log({ event: 'job.completed' });
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) this.session = undefined;
      throw error;
    } finally {
      this.currentJobs = 0; this.busy = false;
      // Availability is refreshed next tick; no background heartbeat can race work.
    }
  }
  async run(signal: AbortSignal): Promise<void> {
    let failures = 0;
    while (!signal.aborted) {
      try { await this.tick(); failures = 0; }
      catch (error) {
        if (error instanceof ApiError && [400, 403, 426].includes(error.status)) throw error;
        failures++; this.log({ event: 'node.connection_failed', code: error instanceof ApiError ? error.code : 'TRANSPORT_ERROR' });
      }
      const backoff = failures ? Math.min(30000, this.pollMs * 2 ** Math.min(failures, 8)) : this.pollMs;
      try { await delay(backoff + (failures ? Math.floor(Math.random() * 250) : 0), undefined, { signal }); }
      catch { if (!signal.aborted) throw new Error('Daemon timer failed'); }
    }
    this.log({ event: 'node.stopped' });
  }
}
