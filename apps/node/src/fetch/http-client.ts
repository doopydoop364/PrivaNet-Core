import { Agent as HttpAgent, request as httpRequest } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import type { IncomingMessage } from 'node:http';
import { lookup } from 'node:dns/promises';
import { Transform } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { createHash } from 'node:crypto';
import { classifyAddress } from './address.js';
import type { Cidr } from './address.js';

/**
 * A bounded, single-purpose HTTP GET. It is not a general client: no methods but GET, only a fixed header set,
 * no cookies, no proxy support, no keep-alive, no redirects (the caller decides), and every limit is a hard cap.
 *
 * The connection goes to an address this module resolved and vetted itself (the request is made to the IP with
 * the hostname kept only for the Host header and TLS server name), so a name that later resolves elsewhere
 * (DNS rebinding) cannot redirect the socket. The connected socket's remote address is checked again. Dedicated
 * agents are used so HTTP_PROXY, HTTPS_PROXY and NODE_USE_ENV_PROXY never apply.
 */
export type ProblemCode = 'BLOCKED' | 'DNS' | 'CONNECT' | 'TLS' | 'TIMEOUT' | 'RESET' | 'PROTOCOL' | 'DECODE' | 'TOO_LARGE';
export class FetchProblem extends Error { constructor(readonly code: ProblemCode, readonly detail = '') { super(code); this.name = 'FetchProblem'; } }
export type Resolver = (host: string) => Promise<string[]>;
export const systemResolver: Resolver = async host => (await lookup(host, { all: true, verbatim: true })).map(entry => entry.address);

export interface Timeouts { connectMs: number; headersMs: number; idleMs: number; totalMs: number }
export interface GetOptions {
  url: URL; headers: Record<string, string>; resolver: Resolver; allowedCidrs: readonly Cidr[];
  timeouts: Timeouts; maxBodyBytes: number; maxHeaderBytes: number; signal?: AbortSignal | undefined;
  /** Called with the size of every compressed chunk before it is processed (the node's transfer meter). */
  onBytes?: ((bytes: number) => Promise<void>) | undefined;
  /** Decides from the response head whether the body should be read at all. */
  wantBody: (head: { status: number; headers: Record<string, string | undefined> }) => boolean;
}
export interface GetResult {
  status: number; headers: Record<string, string | undefined>;
  body: Buffer; bodyTruncated: boolean; bodySha256: string | undefined; compressedBytes: number;
}
const SUPPORTED = new Set(['identity', 'gzip', 'deflate', 'br']);
const RATIO_CHECK_AFTER = 64 * 1024; const MAX_RATIO = 100;
const httpAgent = new HttpAgent({ keepAlive: false, maxSockets: 8 });
const httpsAgent = new HttpsAgent({ keepAlive: false, maxSockets: 8 });

const header = (message: IncomingMessage, name: string): string | undefined => { const value = message.headers[name]; return Array.isArray(value) ? value[0] : value; };

export async function guardedGet(options: GetOptions): Promise<GetResult> {
  const started = Date.now(); const { url, timeouts } = options; const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  const remaining = () => Math.max(1, timeouts.totalMs - (Date.now() - started));
  options.signal?.throwIfAborted();
  // 1. Resolve and vet every address before any socket exists.
  let addresses: string[];
  try { addresses = await withTimeout(options.resolver(hostname), Math.min(timeouts.connectMs, remaining()), options.signal, 'DNS'); }
  catch (error) { if (error instanceof FetchProblem) throw error; throw new FetchProblem('DNS'); }
  if (addresses.length === 0) throw new FetchProblem('DNS');
  if (addresses.some(address => !classifyAddress(address, options.allowedCidrs).allowed)) throw new FetchProblem('BLOCKED', 'address');
  // 2. Try the vetted addresses in order; a connection failure moves on, anything after the head does not.
  let lastError: FetchProblem | undefined;
  for (const address of addresses.slice(0, 3)) {
    try { return await attempt(options, address, hostname, remaining); }
    catch (error) {
      if (error instanceof FetchProblem && (error.code === 'CONNECT' || (error.code === 'TIMEOUT' && error.detail === 'connect'))) { lastError = error; if (remaining() <= 1) break; continue; }
      throw error;
    }
  }
  throw lastError ?? new FetchProblem('CONNECT');
}

function withTimeout<T>(promise: Promise<T>, ms: number, signal: AbortSignal | undefined, code: ProblemCode): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new FetchProblem(code === 'DNS' ? 'DNS' : 'TIMEOUT', 'resolve')), ms);
    const abort = () => { clearTimeout(timer); reject(signal?.reason ?? new Error('aborted')); };
    signal?.addEventListener('abort', abort, { once: true });
    promise.then(value => { clearTimeout(timer); signal?.removeEventListener('abort', abort); resolve(value); }, error => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(error); });
  });
}

function attempt(options: GetOptions, address: string, hostname: string, remaining: () => number): Promise<GetResult> {
  const { url, timeouts } = options; const secure = url.protocol === 'https:';
  const port = url.port === '' ? (secure ? 443 : 80) : Number(url.port);
  return new Promise<GetResult>((resolve, reject) => {
    let settled = false; const active: { request?: ReturnType<typeof httpRequest> } = {}; const timers = new Set<NodeJS.Timeout>();
    const cleanup = () => { for (const timer of timers) clearTimeout(timer); timers.clear(); options.signal?.removeEventListener('abort', onAbort); };
    const fail = (error: unknown) => { if (settled) return; settled = true; cleanup(); active.request?.destroy(); reject(error); };
    const succeed = (result: GetResult) => { if (settled) return; settled = true; cleanup(); resolve(result); };
    const onAbort = () => fail(options.signal?.reason ?? new Error('aborted'));
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const arm = (ms: number, detail: string) => { const timer = setTimeout(() => fail(new FetchProblem('TIMEOUT', detail)), Math.max(1, Math.min(ms, remaining()))); timers.add(timer); return timer; };
    const total = arm(timeouts.totalMs, 'total'); void total;
    const connectTimer = arm(timeouts.connectMs, 'connect');
    const hostHeader = url.port === '' ? hostname : `${hostname}:${url.port}`;
    const make = secure ? httpsRequest : httpRequest;
    const created = make({
      host: address, port, method: 'GET', path: `${url.pathname}${url.search}`, agent: secure ? httpsAgent : httpAgent, maxHeaderSize: options.maxHeaderBytes,
      headers: { ...options.headers, Host: hostHeader, Connection: 'close' }, setHost: false,
      ...(secure ? { servername: hostname, minVersion: 'TLSv1.2' as const } : {}),
    });
    active.request = created;
    created.on('socket', socket => {
      const connectedEvent = secure ? 'secureConnect' : 'connect';
      socket.once(connectedEvent, () => {
        clearTimeout(connectTimer); timers.delete(connectTimer);
        // Defence in depth: the socket really is connected to the address we vetted.
        if (socket.remoteAddress !== undefined && normalise(socket.remoteAddress) !== normalise(address)) fail(new FetchProblem('BLOCKED', 'remote-address'));
        headerTimer = arm(timeouts.headersMs, 'headers');
      });
    });
    let headerTimer: NodeJS.Timeout | undefined;
    created.on('error', (error: NodeJS.ErrnoException) => {
      const code = error.code ?? '';
      if (/^(CERT_|ERR_TLS|UNABLE_TO_|DEPTH_ZERO|SELF_SIGNED|HOSTNAME_MISMATCH|ERR_SSL)/.test(code) || /certificate|tls|ssl/i.test(error.message)) fail(new FetchProblem('TLS'));
      else if (code === 'ECONNRESET' || code === 'EPIPE') fail(new FetchProblem('RESET'));
      else if (code === 'HPE_HEADER_OVERFLOW' || code === 'HPE_INVALID_HEADER_TOKEN' || code.startsWith('HPE_') || code === 'ERR_HTTP_HEADERS_SENT') fail(new FetchProblem('PROTOCOL'));
      else fail(new FetchProblem('CONNECT'));
    });
    created.on('response', response => {
      if (headerTimer) { clearTimeout(headerTimer); timers.delete(headerTimer); }
      readBody(response, options, fail, succeed, arm);
    });
    created.end();
  });
}
const normalise = (address: string): string => address.replace(/^::ffff:/i, '').toLowerCase();

function readBody(response: IncomingMessage, options: GetOptions, fail: (e: unknown) => void, succeed: (r: GetResult) => void, arm: (ms: number, detail: string) => NodeJS.Timeout): void {
  const status = response.statusCode ?? 0;
  const headers: Record<string, string | undefined> = {};
  for (const name of ['content-type', 'content-encoding', 'content-length', 'content-language', 'location', 'etag', 'last-modified', 'retry-after', 'x-robots-tag'])
    headers[name] = header(response, name);
  const empty = (): GetResult => ({ status, headers, body: Buffer.alloc(0), bodyTruncated: false, bodySha256: undefined, compressedBytes: 0 });
  if (!options.wantBody({ status, headers }) || status === 204 || status === 304) { response.destroy(); succeed(empty()); return; }
  const encoding = (headers['content-encoding'] ?? 'identity').trim().toLowerCase();
  if (!SUPPORTED.has(encoding)) { fail(new FetchProblem('PROTOCOL', 'content-encoding')); return; }
  const declared = headers['content-length'] === undefined ? undefined : Number(headers['content-length']);
  if (declared !== undefined && Number.isFinite(declared) && declared > options.maxBodyBytes) { fail(new FetchProblem('TOO_LARGE', 'content-length')); return; }
  let compressed = 0; let decoded = 0; let truncated = false; const chunks: Buffer[] = []; const hash = createHash('sha256');
  let idle: NodeJS.Timeout | undefined; const resetIdle = () => { if (idle) clearTimeout(idle); idle = arm(options.timeouts.idleMs, 'idle'); }; resetIdle();
  // Counts and meters the compressed bytes and enforces the compressed cap.
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      compressed += chunk.length; resetIdle();
      if (compressed > options.maxBodyBytes) { callback(new FetchProblem('TOO_LARGE', 'compressed')); return; }
      (options.onBytes ? options.onBytes(chunk.length) : Promise.resolve()).then(() => callback(null, chunk), (error: unknown) => callback(error instanceof Error ? error : new Error('meter')));
    },
  });
  const decoder = encoding === 'gzip' ? createGunzip() : encoding === 'deflate' ? createInflate() : encoding === 'br' ? createBrotliDecompress() : undefined;
  let finished = false;
  const complete = () => {
    if (finished) return; finished = true;
    if (idle) clearTimeout(idle);
    const body = Buffer.concat(chunks);
    succeed({ status, headers, body, bodyTruncated: truncated, bodySha256: hash.digest('hex'), compressedBytes: compressed });
  };
  const sink = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      if (finished) { callback(); return; } // already complete (the source is being torn down): ignore late chunks
      decoded += chunk.length;
      if (decoded > RATIO_CHECK_AFTER && compressed > 0 && decoded / compressed > MAX_RATIO) { callback(new FetchProblem('TOO_LARGE', 'ratio')); return; }
      const room = options.maxBodyBytes - (decoded - chunk.length);
      const slice = chunk.length > room ? chunk.subarray(0, Math.max(0, room)) : chunk;
      if (slice.length > 0) { chunks.push(slice); hash.update(slice); }
      if (slice.length < chunk.length) { // more decoded data than the cap: keep the first cap bytes and stop reading
        truncated = true; complete(); response.destroy(); callback(); return;
      }
      callback();
    },
  });
  const onError = (error: unknown) => fail(error instanceof FetchProblem ? error : new FetchProblem(decoder ? 'DECODE' : 'RESET'));
  response.on('error', onError); counter.on('error', onError); sink.on('error', onError); decoder?.on('error', () => fail(new FetchProblem('DECODE')));
  response.on('aborted', () => fail(new FetchProblem('RESET')));
  sink.on('finish', complete);
  const source = response.pipe(counter); if (decoder) source.pipe(decoder).pipe(sink); else source.pipe(sink);
}
