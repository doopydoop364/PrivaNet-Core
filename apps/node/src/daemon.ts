import { setTimeout as delay } from 'node:timers/promises';
import { AckSchema, JOB_TYPES, RenewResponseSchema, CapabilitiesSchema, ChallengeSchema, HealthSchema, LeaseResponseSchema, PROTOCOL_VERSION, SERVICE_VERSION, SessionSchema, MAX_JOB_SLOTS } from '@privanet/protocol';
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
  /** How long an idle lease request may wait at the Coordinator for work; 0 disables (plain polling). Library default 0 (plain polling, so a bare `tick()` never blocks); the daemon's configuration defaults it to 5000. Never more than the heartbeat interval so availability stays fresh. */
  leaseWaitMs?: number;
  /** Concurrent jobs this node runs (default 1, at most 64). More than one runs that many independent lanes in this process. */
  jobSlots?: number;
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
  private readonly leaseWaitMs: number;
  private readonly jobSlots: number;
  /** Slots actually advertised: falls to 1 if the Coordinator turns out not to accept more (an older Coordinator). */
  private effectiveSlots: number;
  private connecting: Promise<void> | undefined;
  private heartbeating: Promise<void> | undefined;
  /** Cleared when the Coordinator rejects the `waitMs` field (an older Coordinator): the node then polls plainly. */
  private leaseWaitSupported = true;
  private readonly wakeIdle = new AbortController();
  private readonly log: NonNullable<NodeOptions['log']>;
  private identity: Identity | undefined;
  private session: Session | undefined;
  private lastHeartbeat = 0;
  private enrollmentToken: string | undefined;
  private busy = false;
  private currentJobs = 0;
  /** True when the last tick finished a job (completed or handler-failed), so the run loop may poll again at once. */
  private finishedJob = false;
  private draining = false;
  private readonly hardStop = new AbortController();
  constructor(private readonly options: NodeOptions) {
    this.transport = new Transport(options); this.capabilities = CapabilitiesSchema.parse(options.capabilities);
    this.heartbeatMs = options.heartbeatMs ?? 5000; this.pollMs = options.pollMs ?? 1000;
    this.jobSlots = options.jobSlots ?? 1; this.effectiveSlots = this.jobSlots;
    if (!Number.isSafeInteger(this.jobSlots) || this.jobSlots < 1 || this.jobSlots > MAX_JOB_SLOTS) throw new Error('Invalid job slots');
    this.leaseWaitMs = Math.min(options.leaseWaitMs ?? 0, this.heartbeatMs);
    if (!Number.isSafeInteger(this.leaseWaitMs) || this.leaseWaitMs < 0 || this.leaseWaitMs > 8000) throw new Error('Invalid lease wait');
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
  private heartbeat(force = false): Promise<void> {
    // Concurrent lanes and the per-job renewers all ask for heartbeats: share one in-flight request.
    this.heartbeating ??= this.sendHeartbeat(force).finally(() => { this.heartbeating = undefined; });
    return this.heartbeating;
  }
  private async sendHeartbeat(force = false): Promise<void> {
    // A change of contribution or pressure is reported at once so the Coordinator never schedules against a stale budget.
    const report = this.options.engine?.report; const state = `${this.draining}/${report?.contribution}/${report?.pressure}`;
    if (!this.session || (!force && state === this.lastState && Date.now() - this.lastHeartbeat < this.heartbeatMs)) return;
    this.lastState = state;
    try {
      await this.transport.request('POST', '/v1/node/heartbeat', AckSchema, {
        protocolVersion: PROTOCOL_VERSION, daemonVersion: SERVICE_VERSION, capabilities: this.capabilities,
        jobSlots: this.effectiveSlots, currentJobs: Math.min(this.currentJobs, this.effectiveSlots), lifecycle: this.draining ? 'DRAINING' : 'ACTIVE',
        ...(this.options.engine ? { resources: this.options.engine.report } : {}),
      }, this.session.token);
    } catch (error) {
      // An older Coordinator accepts exactly one slot and rejects the heartbeat: fall back to one slot and say so once.
      if (this.effectiveSlots > 1 && error instanceof ApiError && error.status === 400) {
        this.effectiveSlots = 1; this.log({ event: 'node.job_slots_unsupported' }); this.lastState = ''; return this.sendHeartbeat(true);
      }
      throw error;
    }
    this.lastHeartbeat = Date.now();
  }
  /** Stop asking for work; the next heartbeat tells the Coordinator this node is draining. */
  drain(): void { this.draining = true; this.lastHeartbeat = 0; this.wakeIdle.abort(); }
  /** Abort whatever is running and hand it back; used when a graceful drain runs out of time. */
  abortNow(): void { this.hardStop.abort(); }
  get isDraining() { return this.draining; }
  /** One poll-and-run cycle on the calling lane (the whole node when it runs one slot). */
  async tick(): Promise<void> {
    if (this.busy) throw new Error('Daemon already polling');
    this.busy = true; this.finishedJob = false;
    try { this.finishedJob = await this.cycle(); } finally { this.busy = false; }
  }
  /** Connects once even when several lanes notice an expired session at the same moment. */
  private async ensureSession(): Promise<void> {
    if (this.session && this.session.expiresAt > Date.now() + 1000) return;
    this.connecting ??= this.connect().finally(() => { this.connecting = undefined; });
    await this.connecting;
  }
  /** Returns true when it finished a job (completed or handler-failed), so the caller may poll again at once. */
  private async cycle(): Promise<boolean> {
    let counted = false;
    try {
      await this.ensureSession();
      this.options.engine?.update();
      await this.heartbeat();
      const session = this.session;
      if (!session) throw new Error('Missing session');
      // Owner priority: no new work while draining or while the owner's policy/pressure pauses contribution.
      if (this.draining || this.options.engine?.report.contribution === 'PAUSED') return false;
      const lease = await this.requestLease(session.token);
      if (!lease) return false;
      if (lease.expiresAt <= Date.now()) { this.log({ event: 'job.lease_expired' }); return false; }
      this.currentJobs++; counted = true;
      const meter = this.options.transfer; const checkpoints = this.options.checkpoints;
      meter?.record(JSON.stringify(lease.input).length);
      checkpoints?.prune();
      // Handler failure and result transport failure are separate: lost completion
      // acknowledgement must not be changed into a terminal handler failure.
      let result;
      // Keep the lease alive while a long handler runs; losing it (revoked, expired, superseded) stops the handler without a hand-back.
      let leaseLost = false; let leaseUntil = lease.expiresAt; let renewing = false;
      const preempt = new AbortController();
      const renewer = setInterval(() => {
        // A long job must not make the node look stale: heartbeats (self-throttled) continue while it runs.
        void this.heartbeat().catch(() => { /* the next tick reconnects if the session is gone */ });
        if (renewing) return; renewing = true;
        void this.transport.request('POST', `/v1/node/jobs/${lease.jobId}/renew`, RenewResponseSchema, { leaseId: lease.leaseId }, session.token)
          .then(response => { leaseUntil = response.expiresAt; })
          .catch((error: unknown) => {
            // A definite refusal, or a transient failure that outlasts the lease we last knew about, ends the job.
            if ((error instanceof ApiError && [401, 409].includes(error.status)) || Date.now() >= leaseUntil) { leaseLost = true; preempt.abort(); }
          }).finally(() => { renewing = false; });
      }, Math.max(20, Math.floor((lease.expiresAt - Date.now()) / 3))); const stop = AbortSignal.any([preempt.signal, this.hardStop.signal]);
      // Only jobs declared preemptible are ever interrupted for resource pressure.
      const watcher = JOB_TYPES[lease.type].resources.preemptible && this.options.engine
        ? setInterval(() => { this.options.engine?.update(); if (this.options.engine?.shouldPreempt()) preempt.abort(); }, this.options.preemptCheckMs ?? 250) : undefined;
      try {
        result = await executeLease(lease, this.capabilities, stop, this.options.handlers ?? defaultHandlers, {
          ...(checkpoints ? { checkpoint: checkpoints.forJob(lease.jobId, lease.type) } : {}), ...(meter ? { transfer: (bytes: number) => meter.consume(bytes, stop) } : {}) });
      }
      catch {
        if (leaseLost) { this.log({ event: 'job.lease_lost' }); return false; }
        if (stop.aborted) {
          await this.transport.request('POST', `/v1/node/jobs/${lease.jobId}/release`, AckSchema,
            { leaseId: lease.leaseId, reason: this.hardStop.signal.aborted ? 'SHUTDOWN' : 'PREEMPTED' }, session.token);
          this.log({ event: 'job.released' }); return false; // the checkpoint is kept so this node can resume the job if it is handed back
        }
        checkpoints?.clear(lease.jobId);
        await this.transport.request('POST', `/v1/node/jobs/${lease.jobId}/fail`, AckSchema,
          { leaseId: lease.leaseId, error: { code: this.capabilities.includes(lease.type) ? 'HANDLER_FAILED' : 'CAPABILITY_DISABLED' } }, session.token);
        this.log({ event: 'job.handler_failed' }); return true;
      } finally { clearInterval(renewer); if (watcher) clearInterval(watcher); }
      meter?.record(JSON.stringify(result).length);
      await this.transport.request('POST', `/v1/node/jobs/${lease.jobId}/complete`, AckSchema, { leaseId: lease.leaseId, result }, session.token);
      checkpoints?.clear(lease.jobId); this.log({ event: 'job.completed' });
      return true;
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) this.session = undefined;
      throw error;
    } finally {
      if (counted) this.currentJobs--;
      // The renewal timer also heartbeats while a job runs; otherwise availability is refreshed on the next cycle.
    }
  }
  /** One lease request. Waits at the Coordinator for work when it supports that, so a job is picked up the moment it exists instead of at the next poll. */
  private async requestLease(token: string) {
    const wait = this.leaseWaitSupported ? this.leaseWaitMs : 0;
    try {
      return (await this.transport.request('POST', '/v1/node/jobs/lease', LeaseResponseSchema, wait > 0 ? { waitMs: wait } : {}, token, wait > 0 ? this.wakeIdle.signal : undefined)).lease;
    } catch (error) {
      if (this.draining && !(error instanceof ApiError)) return null; // the drain woke an idle wait: no work was taken
      if (wait > 0 && error instanceof ApiError && error.status === 400) { // an older Coordinator rejects `waitMs`: remember, and poll plainly from now on
        this.leaseWaitSupported = false; this.log({ event: 'node.lease_wait_unsupported' });
        return (await this.transport.request('POST', '/v1/node/jobs/lease', LeaseResponseSchema, {}, token)).lease;
      }
      throw error;
    }
  }
  async run(signal: AbortSignal): Promise<void> {
    if (this.jobSlots > 1) await this.runLanes(signal); else await this.runSingle(signal);
    await this.shutdown();
    this.log({ event: 'node.stopped' });
  }
  private async runSingle(signal: AbortSignal): Promise<void> {
    let failures = 0;
    while (!signal.aborted) {
      try { await this.tick(); failures = 0; }
      catch (error) {
        if (error instanceof ApiError && [400, 403, 426].includes(error.status)) throw error;
        failures++; this.log({ event: 'node.connection_failed', code: error instanceof ApiError ? error.code : 'TRANSPORT_ERROR' });
      }
      // After a finished job there is probably more queued: poll again immediately instead of idling for a full interval.
      // Sleeping only when a poll finds nothing (or fails) keeps an idle node quiet without capping a busy node at one job per interval.
      if (this.finishedJob && !failures) { await new Promise<void>(resolve => setImmediate(resolve)); continue; }
      const backoff = failures ? Math.min(30000, this.pollMs * 2 ** Math.min(failures, 8)) : this.pollMs;
      try { await delay(backoff + (failures ? Math.floor(Math.random() * 250) : 0), undefined, { signal }); }
      catch { if (!signal.aborted) throw new Error('Daemon timer failed'); }
    }
  }
  /** Several independent lanes in one process: each polls, runs one job at a time and reports; session, heartbeat and owner limits are shared. */
  private async runLanes(signal: AbortSignal): Promise<void> {
    const inner = new AbortController(); const stop = AbortSignal.any([signal, inner.signal]);
    const lane = async (index: number): Promise<void> => {
      let failures = 0;
      // A lane beyond the slots the Coordinator accepted (an older Coordinator allows one) simply stops.
      while (!stop.aborted && index < this.effectiveSlots) {
        let finished = false;
        try { finished = await this.cycle(); failures = 0; }
        catch (error) {
          if (error instanceof ApiError && [400, 403, 426].includes(error.status)) throw error;
          failures++; this.log({ event: 'node.connection_failed', code: error instanceof ApiError ? error.code : 'TRANSPORT_ERROR' });
        }
        if (finished && !failures) { await new Promise<void>(resolve => setImmediate(resolve)); continue; }
        const backoff = failures ? Math.min(30000, this.pollMs * 2 ** Math.min(failures, 8)) : this.pollMs;
        try { await delay(backoff + (failures ? Math.floor(Math.random() * 250) : 0), undefined, { signal: stop }); }
        catch { if (!stop.aborted) throw new Error('Daemon timer failed'); }
      }
    };
    // One fatal refusal (revoked credential, protocol mismatch) stops every lane, and the first error is reported.
    const results = await Promise.allSettled(Array.from({ length: this.jobSlots }, (_, index) => lane(index).catch((error: unknown) => { inner.abort(); throw error; })));
    const failed = results.find(result => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
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
