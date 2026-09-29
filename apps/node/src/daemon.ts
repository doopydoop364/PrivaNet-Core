import { setTimeout as delay } from 'node:timers/promises';
import { AckSchema, JOB_TYPES, CapabilitiesSchema, ChallengeSchema, HealthSchema, LeaseResponseSchema, PROTOCOL_VERSION, SERVICE_VERSION, SessionSchema } from '@privanet/protocol';
import type { JobType, Session } from '@privanet/protocol';
import { ApiError, Transport } from '@privanet/shared';
import type { TransportOptions } from '@privanet/shared';
import { bindCoordinator, loadIdentity, signProof } from './identity.js';
import type { Identity } from './identity.js';
import { defaultHandlers, executeLease } from './handlers.js';
import type { Handlers } from './handlers.js';
import type { ResourceEngine } from './resource-engine.js';
import type { CheckpointStore } from './checkpoint.js';
import type { TransferMeter } from './transfer-meter.js';
export interface NodeOptions extends TransportOptions {
  stateDir: string; capabilities: JobType[]; enrollmentToken?: string;
  heartbeatMs?: number; pollMs?: number;
  /** Owner-policy resource engine. Without one the node reports no resources and gets only the Coordinator's small legacy budget. */
  engine?: ResourceEngine; handlers?: Handlers;
  /** Enforce the owner's bandwidth limit and monthly allowance for handlers, and account control-plane bytes. */
  transfer?: TransferMeter;
  /** Node-local resume state for checkpointable job types. */
  checkpoints?: CheckpointStore; drainTimeoutMs?: number; preemptCheckMs?: number; log?: (entry: { event: string; code?: string }) => void;
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
  private draining = false;
  private readonly hardStop = new AbortController();
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
  private lastState = '';
  private async heartbeat(force = false) {
    // A change of contribution or pressure is reported at once so the Coordinator never schedules against a stale budget.
    const report = this.options.engine?.report; const state = `${this.draining}/${report?.contribution}/${report?.pressure}`;
    if (!this.session || (!force && state === this.lastState && Date.now() - this.lastHeartbeat < this.heartbeatMs)) return;
    this.lastState = state;
    await this.transport.request('POST', '/v1/node/heartbeat', AckSchema, {
      protocolVersion: PROTOCOL_VERSION, daemonVersion: SERVICE_VERSION, capabilities: this.capabilities,
      jobSlots: 1, currentJobs: this.currentJobs, lifecycle: this.draining ? 'DRAINING' : 'ACTIVE',
      ...(this.options.engine ? { resources: this.options.engine.report } : {}),
    }, this.session.token);
    this.lastHeartbeat = Date.now();
  }
  /** Stop asking for work; the next heartbeat tells the Coordinator this node is draining. */
  drain(): void { this.draining = true; this.lastHeartbeat = 0; }
  /** Abort whatever is running and hand it back; used when a graceful drain runs out of time. */
  abortNow(): void { this.hardStop.abort(); }
  get isDraining() { return this.draining; }
  async tick(): Promise<void> {
    if (this.busy) throw new Error('Daemon already polling');
    this.busy = true;
    try {
      if (!this.session || this.session.expiresAt <= Date.now() + 1000) await this.connect();
      this.options.engine?.update();
      await this.heartbeat();
      const session = this.session;
      if (!session) throw new Error('Missing session');
      // Owner priority: no new work while draining or while the owner's policy/pressure pauses contribution.
      if (this.draining || this.options.engine?.report.contribution === 'PAUSED') return;
      const { lease } = await this.transport.request('POST', '/v1/node/jobs/lease', LeaseResponseSchema, {}, session.token);
      if (!lease) return;
      if (lease.expiresAt <= Date.now()) { this.log({ event: 'job.lease_expired' }); return; }
      this.currentJobs = 1;
      const meter = this.options.transfer; const checkpoints = this.options.checkpoints;
      meter?.record(JSON.stringify(lease.input).length);
      checkpoints?.prune();
      // Handler failure and result transport failure are separate: lost completion
      // acknowledgement must not be changed into a terminal handler failure.
      let result;
      const preempt = new AbortController(); const stop = AbortSignal.any([preempt.signal, this.hardStop.signal]);
      // Only jobs declared preemptible are ever interrupted for resource pressure.
      const watcher = JOB_TYPES[lease.type].resources.preemptible && this.options.engine
        ? setInterval(() => { this.options.engine?.update(); if (this.options.engine?.shouldPreempt()) preempt.abort(); }, this.options.preemptCheckMs ?? 250) : undefined;
      try {
        result = await executeLease(lease, this.capabilities, stop, this.options.handlers ?? defaultHandlers, {
          ...(checkpoints ? { checkpoint: checkpoints.forJob(lease.jobId, lease.type) } : {}), ...(meter ? { transfer: (bytes: number) => meter.consume(bytes, stop) } : {}) });
      }
      catch {
        if (stop.aborted) {
          await this.transport.request('POST', `/v1/node/jobs/${lease.jobId}/release`, AckSchema,
            { leaseId: lease.leaseId, reason: this.hardStop.signal.aborted ? 'SHUTDOWN' : 'PREEMPTED' }, session.token);
          this.log({ event: 'job.released' }); return; // the checkpoint is kept so this node can resume the job if it is handed back
        }
        checkpoints?.clear(lease.jobId);
        await this.transport.request('POST', `/v1/node/jobs/${lease.jobId}/fail`, AckSchema,
          { leaseId: lease.leaseId, error: { code: this.capabilities.includes(lease.type) ? 'HANDLER_FAILED' : 'CAPABILITY_DISABLED' } }, session.token);
        this.log({ event: 'job.handler_failed' }); return;
      } finally { if (watcher) clearInterval(watcher); }
      meter?.record(JSON.stringify(result).length);
      await this.transport.request('POST', `/v1/node/jobs/${lease.jobId}/complete`, AckSchema, { leaseId: lease.leaseId, result }, session.token);
      checkpoints?.clear(lease.jobId); this.log({ event: 'job.completed' });
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
    await this.shutdown();
    this.log({ event: 'node.stopped' });
  }
  /** Planned departure: announce DRAINING, then say goodbye so the Coordinator records an expected exit. */
  private async shutdown(): Promise<void> {
    this.drain();
    if (!this.session) return; // never connected: nothing to announce
    try {
      if (this.session.expiresAt <= Date.now()) await this.connect();
      await this.heartbeat(true);
      await this.transport.request('POST', '/v1/node/goodbye', AckSchema, { reason: 'SHUTDOWN' }, this.session?.token);
      this.log({ event: 'node.departed' });
    } catch { this.log({ event: 'node.goodbye_failed' }); }
  }
}
