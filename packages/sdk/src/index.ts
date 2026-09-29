import { setTimeout as delay } from 'node:timers/promises';
import { CapabilitiesResponseSchema, HealthSchema, IdSchema, JobSchema, SubmitSchema } from '@privanet/protocol';
import type { Job, JobInputMap, JobType } from '@privanet/protocol';
import { Transport, ApiError } from '@privanet/shared';
import type { TransportOptions } from '@privanet/shared';
export { ApiError };
export type { Job, JobType, JobInputMap, JobOutputMap } from '@privanet/protocol';
export interface ClientOptions extends TransportOptions { token: string }
export class PrivaNetClient {
  private readonly transport: Transport;
  private readonly token: string;
  constructor(options: ClientOptions) {
    this.transport = new Transport(options); this.token = options.token;
    if (!/^[a-f0-9]{64}$/.test(this.token)) throw new Error('Invalid application credential');
  }
  health() { return this.transport.request('GET', '/v1/health', HealthSchema); }
  capabilities() { return this.transport.request('GET', '/v1/capabilities', CapabilitiesResponseSchema, undefined, this.token); }
  submit<T extends JobType>(type: T, input: JobInputMap[T], idempotencyKey: string): Promise<Job> {
    const request = SubmitSchema.parse({ type, input, idempotencyKey });
    return this.transport.request('POST', '/v1/jobs', JobSchema, request, this.token);
  }
  getJob(id: string, signal?: AbortSignal): Promise<Job> { return this.transport.request('GET', `/v1/jobs/${IdSchema.parse(id)}`, JobSchema, undefined, this.token, signal); }
  async waitForResult(id: string, options: { timeoutMs?: number; pollMs?: number; signal?: AbortSignal } = {}): Promise<JobInputMap['system.echo.v1']> {
    const timeoutMs = options.timeoutMs ?? 30000; const pollMs = options.pollMs ?? 100;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(pollMs) || pollMs < 1) throw new Error('Invalid polling policy');
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
    try {
      for (;;) {
        signal.throwIfAborted();
        const job = await this.getJob(id, signal);
        if (job.status === 'COMPLETED' && job.result) return job.result;
        if (job.status === 'FAILED') throw new ApiError(409, job.error?.code ?? 'JOB_FAILED', 'job failed');
        await delay(pollMs, undefined, { signal });
      }
    } catch (error) {
      options.signal?.throwIfAborted();
      if (timeout.aborted) throw new ApiError(408, 'WAIT_TIMEOUT', 'timed out waiting for job');
      throw error;
    }
  }
}
