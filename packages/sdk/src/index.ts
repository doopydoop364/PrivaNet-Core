import { setTimeout as delay } from 'node:timers/promises';
import { CapabilitiesResponseSchema, HealthSchema, IdSchema, JobSchema, SubmitSchema, ChunkIdSchema, PlacementResponseSchema, TicketResponseSchema, ChunkStatusSchema, STORAGE_MAX_CHUNK_BYTES } from '@privanet/protocol';
import type { Job, JobInputMap, JobOutputMap, JobType } from '@privanet/protocol';
import { Transport, ApiError, generateHolderKey } from '@privanet/shared';
import { createHash } from 'node:crypto';
import { transferChunk } from './chunk-transfer.js';
import type { TransportOptions } from '@privanet/shared';
export { ApiError };
export type { Job, JobType, JobInputMap, JobOutputMap } from '@privanet/protocol';
export interface ClientOptions extends TransportOptions { token: string }
export interface ChunkOptions { signal?: AbortSignal; timeoutMs?: number }
/**
 * A failure that says nothing about the job: the Coordinator or the path to it was briefly unavailable (connection refused or reset, a proxy's 502/503/504,
 * a per-request timeout). A read may safely be repeated; the overall deadline still applies.
 */
export function isTransientFailure(error: unknown): boolean {
  if (error instanceof ApiError) return [502, 503, 504].includes(error.status);
  if (error instanceof Error && error.name === 'TimeoutError') return true; // this request's own timeout (the caller's overall deadline is checked separately)
  return error instanceof TypeError && error.cause !== undefined; // undici's "fetch failed": refused, reset, unreachable, DNS, TLS
}
export class PrivaNetClient {
  private readonly transport: Transport;
  private readonly token: string;
  constructor(options: ClientOptions) {
    this.transport = new Transport(options); this.token = options.token;
    if (!/^[a-f0-9]{64}$/.test(this.token)) throw new Error('Invalid application credential');
  }
  health() { return this.transport.request('GET', '/v1/health', HealthSchema); }
  capabilities() { return this.transport.request('GET', '/v1/capabilities', CapabilitiesResponseSchema, undefined, this.token); }
  /** Stores opaque bytes directly at the Coordinator-selected node and waits for authoritative STORED metadata. */
  store(bytes: Uint8Array, options: ChunkOptions & { chunkId?: string; class?: string } = {}): Promise<string> { return this.chunkAction(() => this.storeChunk(bytes, options)); }
  private async storeChunk(bytes: Uint8Array, options: ChunkOptions & { chunkId?: string; class?: string } = {}): Promise<string> {
    if (bytes.byteLength < 1 || bytes.byteLength > STORAGE_MAX_CHUNK_BYTES) throw new ApiError(400, 'INVALID_CHUNK_SIZE', 'invalid chunk size');
    const chunkId = `chk_${createHash('sha256').update(bytes).digest('hex')}`;
    if (options.chunkId !== undefined && options.chunkId !== chunkId) throw new ApiError(400, 'CHUNK_MISMATCH', 'chunk mismatch');
    const signal = this.chunkSignal(options); const holder = generateHolderKey();
    const placed = await this.transport.request('POST', '/v1/storage/placements', PlacementResponseSchema, { directTransfer: true, chunkId, size: bytes.byteLength, holderKey: holder.publicKey, ...(options.class ? { class: options.class } : {}) }, this.token, signal);
    if (placed.chunkId !== chunkId || placed.size !== bytes.byteLength || (placed.grant && (placed.grant.chunkId !== chunkId || placed.grant.operation !== "put"))) throw new ApiError(403, "TRANSFER_GRANT", "transfer grant mismatch");
    if (placed.grant) await transferChunk(placed.grant, holder, signal, bytes);
    await this.waitForChunk(chunkId, false, signal); return chunkId;
  }
  /** Returns bytes only after independently checking their SHA-256 and acknowledging the complete read with the holder key. */
  fetch(chunkId: string, options: ChunkOptions = {}): Promise<Buffer> { return this.chunkAction(() => this.fetchChunk(chunkId, options)); }
  private async fetchChunk(chunkId: string, options: ChunkOptions = {}): Promise<Buffer> {
    if (!ChunkIdSchema.safeParse(chunkId).success) throw new ApiError(400, 'INVALID_CHUNK_ID', 'invalid chunk id'); const signal = this.chunkSignal(options); const holder = generateHolderKey();
    const response = await this.transport.request('POST', '/v1/storage/tickets', TicketResponseSchema, { directTransfer: true, operation: 'get', chunkId, holderKey: holder.publicKey }, this.token, signal);
    if (response.chunkId !== chunkId) throw new ApiError(403, 'TRANSFER_GRANT', 'transfer grant mismatch');
    if (!response.grant) throw new ApiError(503, 'TRANSFER_UNAVAILABLE', 'transfer unavailable');
    if (response.grant.chunkId !== chunkId || response.grant.operation !== "get") throw new ApiError(403, "TRANSFER_GRANT", "transfer grant mismatch");
    return transferChunk(response.grant, holder, signal);
  }
  delete(chunkId: string, options: ChunkOptions = {}): Promise<void> { return this.chunkAction(() => this.deleteChunk(chunkId, options)); }
  private async deleteChunk(chunkId: string, options: ChunkOptions = {}): Promise<void> {
    if (!ChunkIdSchema.safeParse(chunkId).success) throw new ApiError(400, 'INVALID_CHUNK_ID', 'invalid chunk id'); const signal = this.chunkSignal(options); const holder = generateHolderKey();
    let response;
    try { response = await this.transport.request('POST', '/v1/storage/tickets', TicketResponseSchema, { directTransfer: true, operation: 'delete', chunkId, holderKey: holder.publicKey }, this.token, signal); }
    catch (error) { if (error instanceof ApiError && error.status === 404) return; throw error; }
    if (response.chunkId !== chunkId) throw new ApiError(403, 'TRANSFER_GRANT', 'transfer grant mismatch');
    if (response.grant && (response.grant.chunkId !== chunkId || response.grant.operation !== "delete")) throw new ApiError(403, "TRANSFER_GRANT", "transfer grant mismatch");
    if (response.grant) await transferChunk(response.grant, holder, signal);
    await this.waitForChunk(chunkId, true, signal);
  }
  private async chunkAction<T>(run: () => Promise<T>): Promise<T> {
    try { return await run(); } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name)) throw new ApiError(408, 'TRANSFER_TIMEOUT', 'transfer timed out');
      throw new ApiError(503, 'TRANSFER_UNAVAILABLE', 'transfer unavailable');
    }
  }
  private chunkSignal(options: ChunkOptions): AbortSignal {
    const timeoutMs = options.timeoutMs ?? 300000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000) throw new ApiError(400, 'INVALID_TRANSFER_TIMEOUT', 'invalid transfer timeout');
    return options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  }
  private async waitForChunk(chunkId: string, deleted: boolean, signal: AbortSignal): Promise<void> {
    try { for (;;) {
      try { const status = await this.transport.request('GET', `/v1/storage/chunks/${chunkId}`, ChunkStatusSchema, undefined, this.token, signal); if (!deleted && status.state === 'STORED') return; }
      catch (error) { if (deleted && error instanceof ApiError && error.status === 404) return; if (!isTransientFailure(error)) throw error; }
      await delay(100, undefined, { signal });
    } } catch (error) { if (signal.aborted) throw new ApiError(408, 'COMPLETION_PENDING', 'completion acknowledgement pending'); throw error; }
  }
  submit<T extends JobType>(type: T, input: JobInputMap[T], idempotencyKey: string): Promise<Job> {
    const request = SubmitSchema.parse({ type, input, idempotencyKey });
    return this.transport.request('POST', '/v1/jobs', JobSchema, request, this.token);
  }
  /** With `waitMs` (0 to 8000) the Coordinator holds the request until the job finishes or the time is up, then answers with the job as it is. Needs a Coordinator that supports it (see `waitForResult`, which falls back on its own). */
  getJob(id: string, signal?: AbortSignal, waitMs?: number): Promise<Job> { return this.transport.request('GET', `/v1/jobs/${IdSchema.parse(id)}${waitMs ? `?waitMs=${Math.min(8000, Math.max(0, Math.floor(waitMs)))}` : ''}`, JobSchema, undefined, this.token, signal); }
  /** False once a Coordinator has answered a waited job read with 404 while the same read without a wait succeeded: it predates job waits, so poll plainly. */
  private jobWaitSupported = true;
  async waitForResult<T extends JobType = JobType>(id: string, options: { timeoutMs?: number; pollMs?: number; signal?: AbortSignal } = {}): Promise<JobOutputMap[T]> {
    const timeoutMs = options.timeoutMs ?? 30000; const pollMs = options.pollMs ?? 100;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(pollMs) || pollMs < 1) throw new Error('Invalid polling policy');
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
    const started = Date.now(); let failures = 0;
    try {
      for (;;) {
        signal.throwIfAborted();
        // Ask the Coordinator to hold the read until the job finishes (one request instead of a poll every pollMs); never longer than the time left.
        const waitMs = this.jobWaitSupported ? Math.min(5000, Math.max(0, timeoutMs - (Date.now() - started) - 250)) : 0;
        const asked = Date.now(); let job: Job;
        try { job = await this.getJob(id, signal, waitMs > 100 ? waitMs : undefined); failures = 0; }
        catch (error) {
          // The job is durable at the Coordinator: a restart or a proxy error must not cost the caller the wait. Back off and read again until the deadline.
          if (isTransientFailure(error) && !signal.aborted) { failures++; await delay(Math.min(5000, 250 * 2 ** Math.min(failures, 5)), undefined, { signal }); continue; }
          // An older Coordinator answers 404 to a read with a query string. If the same read without a wait works, remember and poll plainly; if it also 404s the job really is not there.
          if (waitMs > 100 && error instanceof ApiError && error.status === 404) { this.jobWaitSupported = false; continue; }
          throw error;
        }
        if (job.status === 'COMPLETED' && job.result) return job.result as JobOutputMap[T];
        if (job.status === 'FAILED') throw new ApiError(409, job.error?.code ?? 'JOB_FAILED', 'job failed');
        // A waited read already spent its time at the Coordinator; an immediate answer (no wait, or the Coordinator was at its waiter limit) is throttled to the poll interval.
        const spent = Date.now() - asked; if (spent < pollMs) await delay(pollMs - spent, undefined, { signal });
      }
    } catch (error) {
      options.signal?.throwIfAborted();
      if (timeout.aborted) throw new ApiError(408, 'WAIT_TIMEOUT', 'timed out waiting for job');
      throw error;
    }
  }
}
