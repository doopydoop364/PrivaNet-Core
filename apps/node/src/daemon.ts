import { setTimeout as delay } from 'node:timers/promises';
import { AckSchema, JOB_TYPES, RenewResponseSchema, CapabilitiesSchema, ChallengeSchema, HealthSchema, LeaseResponseSchema, NodeSelfSchema, PROTOCOL_VERSION, SERVICE_VERSION, SessionSchema, MAX_JOB_SLOTS, TransferKeysSchema, TransferClockSchema } from '@privanet/protocol';
import type { JobType, ServicesAdvertisement, Session, TransferKeys, TransferBinding, TransferReceipt } from '@privanet/protocol';
import { ApiError, Transport } from '@privanet/shared';
import type { TransportOptions } from '@privanet/shared';
import { BindingChangedError, bindCoordinator, loadIdentity, signProof } from './identity.js';
import { connectionFailure } from './failure.js';
import type { Identity } from './identity.js';
import { defaultHandlers, executeLease } from './handlers.js';
import type { Handlers } from './handlers.js';
import type { ResourceEngine } from './resource-engine.js';
import type { CheckpointStore } from './checkpoint.js';
import type { TransferMeter } from './transfer-meter.js';
import { TransferKeyCache } from './store/key-cache.js';
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
  /**
   * The services this node offers right now (today only `storage.chunk.v1`), asked for at every heartbeat. Undefined or an empty answer means none, and nothing is sent. It is a function, not a
   * list, so a store that turns unhealthy or an owner who pauses the node withdraws the offer on the very next heartbeat.
   */
  services?: () => ServicesAdvertisement | undefined;
  checkpoints?: CheckpointStore; drainTimeoutMs?: number; preemptCheckMs?: number; log?: (entry: { event: string; code?: string; reason?: string }) => void;
}
/** A job this node is running right now, as the owner may see it: the type and what its definition declares, never the payload. */
export interface ActiveJob { jobId: string; type: JobType; startedAt: number; preemptible: boolean; checkpointable: boolean; expectedDurationMs: number | null; state: 'running'; estimate: { cpu: string; memoryBytes: number; diskBytes: number; networkBytes: number } }
export interface NodeCounters { completed: number; failed: number; preempted: number; handedBackOnShutdown: number; leaseLost: number }
export interface NodeSnapshot {
  startedAt: number; nodeId: string | null; connected: boolean; draining: boolean; lastContactAt: number | null;
  /** What the last lease request returned, or null before the first one. */
  lastLease: { at: number; result: 'job' | 'empty' } | null;
  /** The most recent failure to reach or sign in to the Coordinator, cleared by the next success. Codes only: no message, address or credential. */
  lastFailure: { at: number; code: string; reason?: string; status?: number } | null;
  coordinator: { serviceVersion: string; protocolVersion: number } | null;
  /** The label the Coordinator's owner gave this node (the Coordinator-side name); null until known. Distinct from the local display name and from the node ID. */
  coordinatorLabel: string | null;
  counters: NodeCounters; activeJobs: ActiveJob[]; slots: { configured: number; effective: number };
  enrolledCapabilities: JobType[]; advertisedCapabilities: JobType[];
}
export class PrivaNode {
  private readonly enrolledCapabilities: JobType[];
  private disabledCapabilities = new Set<JobType>();
  private readonly startedAt = Date.now();
  private lastContactAt: number | null = null;
  private lastLease: NodeSnapshot['lastLease'] = null;
  private lastFailure: NodeSnapshot['lastFailure'] = null;
  private coordinatorInfo: NodeSnapshot['coordinator'] = null;
  private coordinatorLabel: string | null = null;
  private readonly counters: NodeCounters = { completed: 0, failed: 0, preempted: 0, handedBackOnShutdown: 0, leaseLost: 0 };
  private readonly active = new Map<string, ActiveJob>();
  /** The capabilities this node advertises: what it enrolled with, minus anything the owner has switched off. */
  get capabilities(): JobType[] { return this.enrolledCapabilities.filter(capability => !this.disabledCapabilities.has(capability)); }
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
  /** Set when the Coordinator rejects the `services` member (an older Coordinator): the node then offers nothing and says so once, and tries again after an hour (the Coordinator may have been upgraded) without needing a restart. */
  private servicesBlockedUntil = 0;
  private servicesBlockedReason: 'UNSUPPORTED' | 'REJECTED' = 'UNSUPPORTED';
  /** Authenticated, identity-bound verification keys, refreshed while storage is offered. */
  private transferClockOffset = 0;
  get transferNow(): number { return Date.now() + this.transferClockOffset; }
  private ticketKeyCache: TransferKeyCache | undefined;
  private readonly wakeIdle = new AbortController();
  private readonly log: NonNullable<NodeOptions['log']>;
  private identity: Identity | undefined;
  private session: Session | undefined;
  private lastHeartbeat = 0;
  private registeredTransfer: { url: string; certFingerprint: string } | undefined;
  /** A recent accepted heartbeat registered this exact listener identity. */
  transferEndpointRegistered(endpoint: { url: string; certFingerprint: string }): boolean {
    return !this.draining && Date.now() - this.lastHeartbeat <= Math.max(15000, this.heartbeatMs * 3)
      && this.registeredTransfer?.url === endpoint.url && this.registeredTransfer.certFingerprint === endpoint.certFingerprint;
  }
  private advertisementFailure: 'REJECTED' | 'UNREACHABLE' | undefined;
  transferAdvertisementStatus(endpoint?: { url: string; certFingerprint: string }) {
    const accepted = endpoint !== undefined && this.transferEndpointRegistered(endpoint);
    const coordinatorAdvertisement = accepted ? 'ACCEPTED' as const : Date.now() < this.servicesBlockedUntil ? this.servicesBlockedReason : this.advertisementFailure ?? (this.lastFailure?.code === 'TRANSPORT_ERROR' ? 'UNREACHABLE' as const : undefined) ?? (endpoint ? 'PENDING' as const : 'WITHDRAWN' as const);
    return { coordinatorAdvertisement, acceptedAt: accepted ? this.lastHeartbeat : null };
  }
  private enrollmentToken: string | undefined;
  private busy = false;
  private currentJobs = 0;
  /** True when the last tick finished a job (completed or handler-failed), so the run loop may poll again at once. */
  private finishedJob = false;
  private draining = false;
  private readonly hardStop = new AbortController();
  constructor(private readonly options: NodeOptions) {
    this.transport = new Transport(options); this.enrolledCapabilities = CapabilitiesSchema.parse(options.capabilities);
    this.heartbeatMs = options.heartbeatMs ?? 5000; this.pollMs = options.pollMs ?? 1000;
    this.jobSlots = options.jobSlots ?? 1; this.effectiveSlots = this.jobSlots;
    if (!Number.isSafeInteger(this.jobSlots) || this.jobSlots < 1 || this.jobSlots > MAX_JOB_SLOTS) throw new Error('Invalid job slots');
    this.leaseWaitMs = Math.min(options.leaseWaitMs ?? 0, this.heartbeatMs);
    if (!Number.isSafeInteger(this.leaseWaitMs) || this.leaseWaitMs < 0 || this.leaseWaitMs > 8000) throw new Error('Invalid lease wait');
    for (const value of [this.heartbeatMs, this.pollMs]) if (!Number.isSafeInteger(value) || value < 1 || value > 60000) throw new Error('Invalid daemon interval');
    this.log = options.log ?? (() => {}); this.enrollmentToken = options.enrollmentToken;
  }
  /** Switches capabilities off (or back on) without a restart: the next heartbeat advertises the smaller set, so the Coordinator stops leasing the others. Only enrolled capabilities can be affected. */
  setDisabledCapabilities(disabled: readonly JobType[]): void {
    this.disabledCapabilities = new Set(disabled.filter(capability => this.enrolledCapabilities.includes(capability)));
    this.lastHeartbeat = 0;
  }
  /** Read-only view for the local panel and `status`: counters and state the node already tracks, with no payloads, keys or credentials. */
  get snapshot(): NodeSnapshot {
    return { startedAt: this.startedAt, nodeId: this.identity?.nodeId ?? null, connected: this.session !== undefined && this.session.expiresAt > Date.now(), draining: this.draining,
      lastContactAt: this.lastContactAt, lastLease: this.lastLease, lastFailure: this.lastFailure, coordinator: this.coordinatorInfo, coordinatorLabel: this.coordinatorLabel, counters: { ...this.counters },
      activeJobs: [...this.active.values()], slots: { configured: this.jobSlots, effective: this.effectiveSlots },
      enrolledCapabilities: [...this.enrolledCapabilities], advertisedCapabilities: this.capabilities };
  }
  /** Remembers (and logs) a failure to reach or sign in to the Coordinator: a fixed code and reason, never a message, an address or a credential. */
  private noteFailure(error: unknown): void {
    const failure = connectionFailure(error);
    this.lastFailure = { at: Date.now(), code: failure.code, ...(failure.reason ? { reason: failure.reason } : {}), ...(error instanceof ApiError ? { status: error.status } : {}) };
    this.log({ event: 'node.connection_failed', ...failure });
  }
  private contacted(): void { this.lastContactAt = Date.now(); this.lastFailure = null; }
  get status() { return { nodeId: this.identity?.nodeId ?? null, connected: this.session !== undefined && this.session.expiresAt > Date.now(), capabilities: [...this.capabilities], currentJobs: this.currentJobs }; }
  async connect(): Promise<void> {
    this.identity ??= await loadIdentity(this.options.stateDir);
    const identity = this.identity;
    const health = await this.transport.request('GET', '/v1/health', HealthSchema);
    await bindCoordinator(this.options.stateDir, this.transport.origin, health.coordinatorId);
    this.coordinatorInfo = { serviceVersion: health.serviceVersion, protocolVersion: health.protocolVersion };
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
    this.session = session; this.enrollmentToken = undefined; this.lastHeartbeat = 0; this.contacted(); void this.refreshLabel(session.token);
    this.ticketKeyCache ??= new TransferKeyCache(health.coordinatorId, async () => {
      const current = this.session;
      if (!current || current.expiresAt <= Date.now()) throw new Error('No node session');
      const keys = await this.transport.request('GET', '/v1/node/transfer-keys', TransferKeysSchema, undefined, current.token);
      const before = Date.now();
      try { const clock = await this.transport.request('GET', '/v1/node/transfer-clock', TransferClockSchema, undefined, current.token); const after = Date.now(); if (clock.coordinatorId === health.coordinatorId && after - before <= 5000) this.transferClockOffset = Math.round(clock.now - (before + after) / 2); } catch { /* alpha.2 has no clock route; retain the prior bounded estimate */ }
      return keys;
    }, undefined, () => this.log({ event: 'node.transfer_keys_rejected', code: 'COORDINATOR_MISMATCH' }));
    this.log({ event: purpose === 'enroll' ? 'node.enrolled' : 'node.authenticated' });
  }
  /** Best effort: the owner-side label of this node (an existing authenticated read of its own record). A failure just leaves it unknown. */
  private async refreshLabel(token: string): Promise<void> {
    try { this.coordinatorLabel = (await this.transport.request('GET', '/v1/node/self', NodeSelfSchema, undefined, token)).displayName ?? null; } catch { /* an older Coordinator, or a hiccup: leave it unknown */ }
  }
  /** The verification keys the Coordinator published to this node, or null (an older Coordinator, storage off at the Coordinator, or none fetched yet). */
  get transferKeys(): TransferKeys['keys'] | null { return this.ticketKeyCache?.keys ?? null; }
  /**
   * Best effort, and only for a node that offers a service: the public keys that verify tickets, from an authenticated route of its own Coordinator. A different Coordinator's keys are never
   * kept (the answer must name the Coordinator this node is bound to), an older Coordinator's 404 just means "no storage control plane here", and nothing here can fail the node.
   */
  async refreshTransferKeys(): Promise<void> { await this.ticketKeyCache?.refresh(); }
  async refreshTransferKeysForTicket(wire: string, coordinatorNow: number): Promise<void> { await this.ticketKeyCache?.refreshForTicket(wire, coordinatorNow); }
  /** Metadata-only calls over the existing node session; reconnects retain the persisted Coordinator binding. */
  async storageAction(id: string, action: 'begin' | 'check' | 'prepare' | 'fail', reason?: string, binding?: TransferBinding): Promise<void> {
    await this.ensureSession();
    try { await this.transport.request('POST', `/v1/node/storage/transfers/${id}/${action}`, AckSchema, action === 'fail' ? { reason } : action === 'begin' ? binding : {}, this.session?.token); }
    catch (error) { if (error instanceof ApiError && error.status === 401) this.session = undefined; throw error; }
  }
  async storageReceipt(receipt: TransferReceipt): Promise<void> {
    await this.ensureSession();
    try { await this.transport.request('POST', '/v1/node/storage/receipts', AckSchema, receipt, this.session?.token); }
    catch (error) { if (error instanceof ApiError && error.status === 401) this.session = undefined; throw error; }
  }
  private lastState = '';
  private heartbeat(force = false): Promise<void> {
    // Concurrent lanes and the per-job renewers all ask for heartbeats: share one in-flight request.
    this.heartbeating ??= this.sendHeartbeat(force).finally(() => { this.heartbeating = undefined; });
    return this.heartbeating;
  }
  private async sendHeartbeat(force = false): Promise<void> {
    // A change of contribution or pressure is reported at once so the Coordinator never schedules against a stale budget.
    const report = this.options.engine?.report;
    // Whether storage is offered is part of the state that triggers an immediate heartbeat, so a withdrawn offer (a store that went unhealthy, an owner pause) reaches the Coordinator at once; the amounts are only hints and ride the ordinary heartbeats.
    const offered = Date.now() >= this.servicesBlockedUntil ? this.options.services?.() : undefined; const services = offered && Object.keys(offered).length > 0 ? offered : undefined;
    const endpoint = services?.['storage.chunk.v1']?.transferEndpoint;
    const state = `${this.draining}/${report?.contribution}/${report?.pressure}/${this.capabilities.join(',')}/${services?.['storage.chunk.v1'] ? 'storage' : ''}/${endpoint?.url ?? ''}/${endpoint?.certFingerprint ?? ''}`;
    if (!this.session || (!force && state === this.lastState && Date.now() - this.lastHeartbeat < this.heartbeatMs)) return;
    this.lastState = state;
    try {
      await this.transport.request('POST', '/v1/node/heartbeat', AckSchema, {
        protocolVersion: PROTOCOL_VERSION, daemonVersion: SERVICE_VERSION, capabilities: this.capabilities,
        jobSlots: this.effectiveSlots, currentJobs: Math.min(this.currentJobs, this.effectiveSlots), lifecycle: this.draining ? 'DRAINING' : 'ACTIVE',
        ...(this.options.engine ? { resources: this.options.engine.report } : {}), ...(services ? { services } : {}),
      }, this.session.token);
      if (services) void this.ticketKeyCache?.refresh();
    } catch (error) {
      this.registeredTransfer = undefined;
      this.advertisementFailure = error instanceof ApiError && error.status < 500 ? 'REJECTED' : 'UNREACHABLE';
      // An older Coordinator rejects the `services` member (its heartbeat schema is strict). Tried first, before the slots fallback below: a node that merely offers storage must neither stop nor lose its slots.
      if (services && error instanceof ApiError && error.status === 400) {
        this.servicesBlockedReason = error.code === 'INVALID_TRANSFER_ENDPOINT' ? 'REJECTED' : 'UNSUPPORTED';
        this.servicesBlockedUntil = Date.now() + (this.servicesBlockedReason === 'REJECTED' ? 30000 : 3600000); this.log({ event: this.servicesBlockedReason === 'REJECTED' ? 'node.storage_offer_rejected' : 'node.services_unsupported' }); this.lastState = ''; return this.sendHeartbeat(true);
      }
      // An older Coordinator accepts exactly one slot and rejects the heartbeat: fall back to one slot and say so once.
      if (this.effectiveSlots > 1 && error instanceof ApiError && error.status === 400) {
        this.effectiveSlots = 1; this.log({ event: 'node.job_slots_unsupported' }); this.lastState = ''; return this.sendHeartbeat(true);
      }
      throw error;
    }
    this.advertisementFailure = undefined;
    this.registeredTransfer = endpoint ? { url: endpoint.url, certFingerprint: endpoint.certFingerprint } : undefined;
    this.lastHeartbeat = Date.now(); this.contacted();
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
    let counted = false; let activeId: string | undefined;
    try {
      await this.ensureSession();
      this.options.engine?.update();
      await this.heartbeat();
      const session = this.session;
      if (!session) throw new Error('Missing session');
      // Owner priority: no new work while draining or while the owner's policy/pressure pauses contribution.
      if (this.draining || this.options.engine?.report.contribution === 'PAUSED') return false;
      const lease = await this.requestLease(session.token);
      this.lastLease = { at: Date.now(), result: lease ? 'job' : 'empty' }; this.contacted();
      if (!lease) return false;
      if (lease.expiresAt <= Date.now()) { this.log({ event: 'job.lease_expired' }); return false; }
      this.currentJobs++; counted = true;
      const definition = JOB_TYPES[lease.type];
      activeId = lease.jobId;
      this.active.set(lease.jobId, { jobId: lease.jobId, type: lease.type, startedAt: Date.now(), preemptible: definition.resources.preemptible, checkpointable: definition.resources.checkpointable,
        expectedDurationMs: definition.resources.expectedDurationMs, state: 'running',
        estimate: { cpu: definition.resources.cpu, memoryBytes: definition.resources.memoryBytes, diskBytes: definition.resources.diskBytes, networkBytes: definition.resources.networkBytes } });
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
      try {
        // Only jobs declared preemptible are ever interrupted for resource pressure.
        const watcher = JOB_TYPES[lease.type].resources.preemptible && this.options.engine
          ? setInterval(() => { this.options.engine?.update(); if (this.options.engine?.shouldPreempt()) preempt.abort(); }, this.options.preemptCheckMs ?? 250) : undefined;
        try {
          result = await executeLease(lease, this.capabilities, stop, this.options.handlers ?? defaultHandlers, {
            ...(checkpoints ? { checkpoint: checkpoints.forJob(lease.jobId, lease.type) } : {}), ...(meter ? { transfer: (bytes: number) => meter.consume(bytes, stop) } : {}) });
        }
        catch {
          if (leaseLost) { this.counters.leaseLost++; this.log({ event: 'job.lease_lost' }); return false; }
          if (stop.aborted) {
            await this.transport.request('POST', `/v1/node/jobs/${lease.jobId}/release`, AckSchema,
              { leaseId: lease.leaseId, reason: this.hardStop.signal.aborted ? 'SHUTDOWN' : 'PREEMPTED' }, session.token);
            if (this.hardStop.signal.aborted) this.counters.handedBackOnShutdown++; else this.counters.preempted++;
            this.log({ event: 'job.released' }); return false; // the checkpoint is kept so this node can resume the job if it is handed back
          }
          checkpoints?.clear(lease.jobId);
          await this.transport.request('POST', `/v1/node/jobs/${lease.jobId}/fail`, AckSchema,
            { leaseId: lease.leaseId, error: { code: this.capabilities.includes(lease.type) ? 'HANDLER_FAILED' : 'CAPABILITY_DISABLED' } }, session.token);
          this.counters.failed++; this.log({ event: 'job.handler_failed' }); return true;
        } finally { if (watcher) clearInterval(watcher); }
        meter?.record(JSON.stringify(result).length);
        // The renewer keeps running until the result is delivered: during a brief Coordinator outage it extends the lease again as soon as the Coordinator is back.
        await this.deliver(lease.jobId, { leaseId: lease.leaseId, result }, session.token, () => leaseUntil);
        checkpoints?.clear(lease.jobId); this.counters.completed++; this.log({ event: 'job.completed' });
        return true;
      } finally { clearInterval(renewer); }
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) this.session = undefined;
      throw error;
    } finally {
      if (counted) this.currentJobs--;
      if (activeId !== undefined) this.active.delete(activeId);
      // The renewal timer also heartbeats while a job runs; otherwise availability is refreshed on the next cycle.
    }
  }
  /**
   * Reports a finished result. A result is expensive (the whole job ran), so a refused or dropped connection (the Coordinator restarting, a proxy error)
   * is retried with backoff for as long as the lease may still be valid, instead of throwing the result away and letting the job be run again after the
   * lease expires. Completion is idempotent at the Coordinator, so a retry after a lost answer is safe. A definite refusal (the lease was taken away) is
   * not retried, and neither is anything once the lease has run out or the node is being stopped.
   */
  private async deliver(jobId: string, body: { leaseId: string; result: unknown }, token: string, leaseUntil: () => number): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try { await this.transport.request('POST', `/v1/node/jobs/${jobId}/complete`, AckSchema, body, token); return; }
      catch (error) {
        const transient = !(error instanceof ApiError) || [502, 503, 504].includes(error.status);
        if (!transient || this.hardStop.signal.aborted || Date.now() >= leaseUntil()) throw error;
        try { await delay(Math.min(2000, 200 * 2 ** Math.min(attempt, 4), Math.max(1, leaseUntil() - Date.now())), undefined, { signal: this.hardStop.signal }); } catch { throw error; }
      }
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
        if (error instanceof BindingChangedError || (error instanceof ApiError && [400, 403, 426].includes(error.status))) throw error;
        failures++; this.noteFailure(error);
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
          if (error instanceof BindingChangedError || (error instanceof ApiError && [400, 403, 426].includes(error.status))) throw error;
          failures++; this.noteFailure(error);
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
