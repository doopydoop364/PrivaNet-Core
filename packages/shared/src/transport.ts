import { setTimeout as delay } from 'node:timers/promises';
import { ErrorSchema, MAX_BODY_BYTES, PROTOCOL_VERSION } from '@privanet/protocol';
import type { z } from 'zod';

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message); }
}
export interface TransportOptions { url: string; allowInsecureLoopback?: boolean; timeoutMs?: number }
export class Transport {
  readonly origin: string;
  readonly timeoutMs: number;
  constructor(options: TransportOptions) {
    const url = new URL(options.url);
    const loopback = url.hostname === '127.0.0.1' || url.hostname === '[::1]';
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
        (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback && options.allowInsecureLoopback))) {
      throw new Error('Coordinator URL requires HTTPS or explicitly allowed literal loopback HTTP');
    }
    this.origin = url.origin;
    this.timeoutMs = options.timeoutMs ?? 10000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 60000) throw new Error('Invalid request timeout');
  }
  async request<T>(method: 'GET' | 'POST', path: string, schema: z.ZodType<T>, body?: unknown, token?: string, signal?: AbortSignal): Promise<T> {
    if (!/^\/v1\/[a-zA-Z0-9/_-]+(\?waitMs=\d{1,5})?$/.test(path)) throw new Error('Invalid API path');
    const serialized = body === undefined ? undefined : JSON.stringify(body);
    if (serialized !== undefined && Buffer.byteLength(serialized) > MAX_BODY_BYTES) throw new Error('Request too large');
    const headers: Record<string, string> = { 'X-PrivaNet-Protocol': String(PROTOCOL_VERSION), Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (serialized !== undefined) headers['Content-Type'] = 'application/json';
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([timeout, signal]) : timeout;
    const init = { method, headers, ...(serialized === undefined ? {} : { body: serialized }), redirect: 'error' as const, signal: combined };
    let response: Response;
    try { response = await fetch(this.origin + path, init); }
    catch (error) {
      const cause = error instanceof Error ? error.cause : undefined;
      const recoverable = cause instanceof Error && 'code' in cause && ['UND_ERR_SOCKET', 'ECONNRESET', 'ECONNREFUSED'].includes(String(cause.code));
      if (method !== 'GET' || !recoverable || combined.aborted) throw error;
      // Only read operations retry a transient connection failure. Mutation
      // retries require the caller's submission/lease idempotency context.
      await delay(25, undefined, { signal: combined });
      response = await fetch(this.origin + path, init);
    }
    const reader = response.body?.getReader();
    let size = 0;
    const chunks: Uint8Array[] = [];
    if (reader) {
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 512 * 1024) throw new Error('Response too large');
          chunks.push(part.value);
        }
      } finally { await reader.cancel(); }
    }
    let payload: unknown;
    try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    // A reverse proxy answers an unreachable Coordinator with its own (usually empty or HTML) 502/503/504: that is an API-level refusal, not a parse error.
    catch { if (!response.ok) throw new ApiError(response.status, 'INVALID_RESPONSE', 'Coordinator rejected request'); throw new ApiError(502, 'INVALID_RESPONSE', 'Coordinator answered with something that is not JSON'); }
    if (!response.ok) {
      const parsed = ErrorSchema.safeParse(payload);
      if (parsed.success) throw new ApiError(response.status, parsed.data.error.code, parsed.data.error.message);
      throw new ApiError(response.status, 'INVALID_RESPONSE', 'Coordinator rejected request');
    }
    if (response.headers.get('x-privanet-protocol') !== String(PROTOCOL_VERSION)) throw new ApiError(426, 'PROTOCOL_MISMATCH', 'Incompatible Coordinator protocol');
    return schema.parse(payload);
  }
}
