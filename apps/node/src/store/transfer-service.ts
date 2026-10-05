import { loadTransferTls, TransferTlsError } from './tls.js';
import { TransferConfigError } from './transfer-config.js';
import { ReplayStateError } from './replay-state.js';
import { ReceiptQueueError } from './receipt-queue.js';
import { createHash } from 'node:crypto';
import { createServer } from 'node:https';
import type { Server } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { once } from 'node:events';
import { ApiError, newHolderChallenge, parseTicket, verifyHolderProof, verifyTicket } from '@privanet/shared';
import type { TicketClaims, TicketOperation } from '@privanet/shared';
import type { TransferEndpoint, TransferReceipt } from '@privanet/protocol';
import type { PrivaNode } from '../daemon.js';
import { loadIdentity } from '../identity.js';
import type { ResourcePolicy } from '../resource-policy.js';
import type { TransferMeter } from '../transfer-meter.js';
import { TransferLimitError } from '../transfer-meter.js';
import type { ChunkStore, GateVerdict } from './chunk-store.js';
import { StoreError } from './errors.js';
import { PersistentReplaySet } from './replay-state.js';
import { ReceiptQueue, RECEIPT_LIMIT } from './receipt-queue.js';

export interface TransferStatus {
  listener: 'DISABLED' | 'STARTING' | 'LISTENING' | 'STOPPED' | 'FAILED' | 'UNKNOWN'; advertised: boolean; error: string | null;
  configured: boolean; bindAddress: string | null; port: number | null; endpoint: string | null;
  coordinatorAdvertisement: 'ACCEPTED' | 'PENDING' | 'REJECTED' | 'UNSUPPORTED' | 'UNREACHABLE' | 'UNKNOWN' | 'WITHDRAWN';
  acceptedAt: number | null; remoteReachability: 'UNKNOWN';
  active: { put: number; get: number; delete: number }; completed: number; failed: number; bytes: number;
  failures: Record<string, number>; queuedReceipts: number; lastReceiptAckAt: number | null; throughputBytesPerSec: number;
}
export interface TransferServiceOptions {
  stateDir: string; node: PrivaNode; meter: TransferMeter;
  store: () => ChunkStore | undefined; gate: () => GateVerdict;
  config: () => ResourcePolicy['storage']['transfer']; log?: (entry: { event: string; code?: string }) => void;
  /** Lower bounded timeouts for failure tests. */ timeoutMs?: number; idleMs?: number;
}
interface Challenge { challenge: string; until: number; line: string }
interface ReadAck extends Challenge { ticketHash: string; claims: TicketClaims; done: boolean; ready: boolean }
const failureReason = (error: unknown): 'ABORTED' | 'TIMEOUT' | 'INTEGRITY' | 'SIZE_MISMATCH' | 'STORAGE_FULL' | 'UNAVAILABLE' | 'IO' => {
  if (error instanceof StoreError && ['ABORTED', 'INTEGRITY', 'SIZE_MISMATCH', 'STORAGE_FULL', 'UNAVAILABLE', 'IO'].includes(error.code)) return error.code as ReturnType<typeof failureReason>;
  if (error instanceof Error && error.name === 'TimeoutError') return 'TIMEOUT';
  if (error instanceof TransferLimitError) return 'UNAVAILABLE';
  return error instanceof ApiError ? 'UNAVAILABLE' : 'IO';
};
function refuse(code: string, status = 403): never { throw new ApiError(status, code, code.toLowerCase().replaceAll('_', ' ')); }

/** Closed HTTP/1.1 data surface. All Coordinator calls contain bounded metadata only. */
export class TransferService {
  private server: Server | undefined; private endpoint: TransferEndpoint | undefined;
  private replay: PersistentReplaySet | undefined; private queue: ReceiptQueue | undefined;
  private readonly sockets = new Set<Duplex>(); private readonly running = new Set<AbortController>(); private readonly handlers = new Set<Promise<void>>(); private readonly activeIds = new Set<string>();
  private readonly challenges = new Map<string, Challenge>(); private readonly reads = new Map<string, ReadAck>();
  private retryTimer: NodeJS.Timeout | undefined; private retrying: Promise<void> | undefined; private failures = 0; private stopping = false;
  private sweep: NodeJS.Timeout | undefined; private stamp = ''; private startedAt = Date.now();
  private budget = { at: Date.now(), count: 0 }; private readonly ips = new Map<string, { at: number; count: number }>();
  private cached: TransferStatus = { listener: 'DISABLED', advertised: false, error: null, configured: false, bindAddress: null, port: null, endpoint: null, coordinatorAdvertisement: 'UNKNOWN', acceptedAt: null, remoteReachability: 'UNKNOWN', active: { put: 0, get: 0, delete: 0 }, completed: 0, failed: 0, bytes: 0, failures: {}, queuedReceipts: 0, lastReceiptAckAt: null, throughputBytesPerSec: 0 };
  constructor(private readonly options: TransferServiceOptions) {}
  get status(): TransferStatus { return { ...this.cached, advertised: !!this.endpoint && this.options.node.transferEndpointRegistered(this.endpoint), ...this.options.node.transferAdvertisementStatus(this.endpoint), active: { ...this.cached.active }, failures: { ...this.cached.failures }, queuedReceipts: this.queue?.size ?? 0,
    throughputBytesPerSec: this.cached.bytes / Math.max(1, (Date.now() - this.startedAt) / 1000) }; }
  get advertisement(): TransferEndpoint | undefined { return this.server && this.endpoint ? { ...this.endpoint } : undefined; }

  async apply(enabled: boolean): Promise<void> {
    let config: ReturnType<TransferServiceOptions["config"]>;
    try { config = this.options.config(); } catch (error) {
      await this.closeListener(); this.stamp = '';
      this.cached.configured = false; this.cached.bindAddress = null; this.cached.port = null; this.cached.endpoint = null;
      this.cached.listener = enabled ? 'FAILED' : 'DISABLED'; this.cached.error = error instanceof TransferConfigError ? error.code : 'TRANSFER_CONFIG_INVALID'; return;
    }
    this.cached.configured = config.enabled; this.cached.bindAddress = config.bindAddress; this.cached.port = config.port; this.cached.endpoint = config.endpoint || null;
    const stamp = JSON.stringify(config);
    if (!enabled || !config.enabled) { await this.closeListener(); this.stamp = ''; this.cached.listener = 'DISABLED'; this.cached.error = config.enabled ? 'STORAGE_DISABLED' : 'TRANSFER_POLICY_DISABLED'; return; }
    if (this.server && this.stamp === stamp) return;
    await this.closeListener(); this.stopping = false; this.cached.listener = 'STARTING';
    try {
      const identity = await loadIdentity(this.options.stateDir);
      const { cert, key, endpoint } = await loadTransferTls(config, identity.nodeId);
      this.replay ??= await PersistentReplaySet.open(this.options.stateDir);
      if (!this.queue) { this.queue = await ReceiptQueue.open(this.options.stateDir); await this.recover(); this.scheduleRetry(0); }
      const server = createServer({ cert, key, minVersion: 'TLSv1.2', maxHeaderSize: 4096, handshakeTimeout: 5000, requestTimeout: this.options.timeoutMs ?? 300000,
        headersTimeout: Math.min(5000, this.options.timeoutMs ?? 300000), keepAliveTimeout: 1 }, (req, res) => { this.dispatch(req, res); });
      server.maxHeadersCount = 32; server.maxConnections = 128; server.maxRequestsPerSocket = 1;
      server.setTimeout(this.options.idleMs ?? 10000, socket => socket.destroy());
      server.on('checkContinue', (req, res) => { this.dispatch(req, res); });
      server.on('checkExpectation', (_req, res) => { res.writeHead(417, { connection: 'close' }); res.end(); });
      server.on('connection', socket => { this.sockets.add(socket); socket.once('close', () => this.sockets.delete(socket)); });
      server.on('clientError', (_error, socket) => socket.destroy()); server.on('tlsClientError', () => {});
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(config.port, config.bindAddress, () => { server.off('error', reject); resolve(); }); });
      server.on('error', () => { void this.closeListener().finally(() => { this.cached.listener = 'FAILED'; this.cached.error = 'TRANSFER_BIND_FAILED'; }); });
      this.server = server; this.endpoint = endpoint; this.stamp = stamp;
      this.cached.listener = 'LISTENING'; this.cached.advertised = true; this.cached.error = null;
      this.sweep = setInterval(() => { void this.cleanup().catch(() => { this.cached.error = 'RECEIPT_STATE_IO'; }); }, 1000); this.sweep.unref();
      this.options.log?.({ event: 'storage.transfer_listening' });
    } catch (error) {
      await this.closeListener(); this.cached.listener = 'FAILED';
      this.cached.error = error instanceof TransferTlsError || error instanceof ReplayStateError || error instanceof ReceiptQueueError ? error.code : error instanceof Error && 'code' in error && ['EADDRINUSE', 'EADDRNOTAVAIL', 'EACCES'].includes(String(error.code)) ? (error.code === 'EADDRINUSE' ? 'TRANSFER_PORT_IN_USE' : 'TRANSFER_BIND_FAILED') : 'TRANSFER_START_FAILED';
      this.options.log?.({ event: 'storage.transfer_unavailable', code: this.cached.error });
    }
  }
  private async recover(): Promise<void> {
    const store = this.options.store(); if (!store || !this.queue) return;
    for (const record of this.queue.snapshot()) {
      if (record.state !== 'PREPARED' || this.activeIds.has(record.receipt.transferId) || this.reads.has(record.receipt.transferId)) continue;
      const receipt = record.receipt;
      if (receipt.operation === 'get') { await this.queue.fail(receipt.transferId, 'ABORTED'); continue; }
      let exists = false;
      try { const chunk = await store.get(receipt.chunkId, receipt.applicationId); exists = receipt.operation === 'delete' || chunk.size === receipt.bytes; chunk.stream.destroy(); }
      catch (error) { if (!(error instanceof StoreError && ['NOT_FOUND', 'INTEGRITY'].includes(error.code))) throw error; }
      if (receipt.operation === 'put' ? exists : !exists) { await store.confirmDurability(receipt.chunkId, receipt.applicationId); await this.queue.complete(receipt.transferId, this.options.node.transferNow); }
      else await this.queue.fail(receipt.transferId, 'ABORTED');
    }
  }
  private scheduleRetry(ms: number): void {
    if (this.stopping || this.retryTimer) return;
    this.retryTimer = setTimeout(() => { this.retryTimer = undefined; void this.retryReceipts(); }, ms); this.retryTimer.unref();
  }
  async retryReceipts(): Promise<void> {
    if (this.retrying) return this.retrying;
    this.retrying = (async () => {
      await this.recover();
      let unavailable = false;
      for (const record of this.queue?.snapshot() ?? []) {
        if (this.options.node.transferNow - record.receipt.completedAt > 7 * 24 * 3600000) { await this.queue?.acknowledge(record.receipt.transferId); this.options.log?.({ event: 'storage.receipt_refused', code: 'RECONCILIATION_EXPIRED' }); continue; }
        if (record.state === 'PREPARED') continue;
        try {
          if (record.state === 'COMPLETED') await this.options.node.storageReceipt(record.receipt);
          else await this.options.node.storageAction(record.receipt.transferId, 'fail', record.failure ?? 'IO');
          await this.queue?.acknowledge(record.receipt.transferId); this.cached.lastReceiptAckAt = Date.now();
        } catch (error) {
          if (error instanceof ApiError && [403, 404, 409].includes(error.status)) { await this.queue?.acknowledge(record.receipt.transferId); this.options.log?.({ event: 'storage.receipt_refused', code: 'TRANSFER_FINAL' }); }
          else { unavailable = true; break; }
        }
      }
      this.failures = unavailable ? Math.min(7, this.failures + 1) : 0;
      this.scheduleRetry(unavailable ? Math.min(120000, 1000 * 2 ** this.failures) : 2000);
    })().catch(() => { this.cached.error = 'RECEIPT_STATE_IO'; this.scheduleRetry(120000); }).finally(() => { this.retrying = undefined; });
    return this.retrying;
  }
  private dispatch(req: IncomingMessage, res: ServerResponse): void {
    const run = this.handle(req, res); this.handlers.add(run); void run.finally(() => this.handlers.delete(run));
  }
  private send(res: ServerResponse, status: number, code: string, extra: object = {}): void {
    if (res.destroyed || res.headersSent) return;
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', connection: 'close' });
    res.end(JSON.stringify({ code, ...extra }));
  }
  private rate(req: IncomingMessage): void {
    const now = Date.now(); if (now - this.budget.at >= 1000) this.budget = { at: now, count: 0 };
    if (++this.budget.count > 200) refuse('BUSY', 429);
    const ip = req.socket.remoteAddress ?? ''; let bucket = this.ips.get(ip);
    if (!bucket || now - bucket.at >= 1000) { if (this.ips.size >= 256) this.ips.delete(this.ips.keys().next().value ?? ''); bucket = { at: now, count: 0 }; this.ips.set(ip, bucket); }
    if (++bucket.count > 100) refuse('BUSY', 429);
  }
  private gate(): void { if (!this.options.meter.allowsReservedTransfers() || !this.options.gate().allowed || !this.options.store() || !this.options.config().enabled || this.cached.listener !== 'LISTENING') refuse('UNAVAILABLE', 503); }
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let claims: TicketClaims | undefined; let controller: AbortController | undefined; let begun = false; let prepared = false; let committed = false; let operationTimer: NodeJS.Timeout | undefined;
    try {
      this.rate(req);
      const path = req.url ?? ''; const method = req.method ?? '';
      if (!/^\/v1\/chunks\/chk_[a-f0-9]{64}$/.test(path)) refuse('NOT_FOUND', 404);
      if (!['PUT', 'GET', 'DELETE'].includes(method)) refuse('METHOD_NOT_ALLOWED', 405);
      const critical = new Set(['authorization', 'content-length', 'transfer-encoding', 'x-privanet-challenge', 'x-privanet-proof', 'x-privanet-handshake', 'x-privanet-ack', 'range', 'expect']);
      const headers = new Set<string>();
      for (let i = 0; i < req.rawHeaders.length; i += 2) { const name = req.rawHeaders[i]!.toLowerCase(); if (critical.has(name) && headers.has(name)) refuse('INVALID_REQUEST', 400); headers.add(name); }
      if (req.headers['transfer-encoding'] || req.headers.range || req.headers.expect || req.httpVersion !== '1.1') refuse('INVALID_REQUEST', 400);
      const auth = req.headers.authorization; if (typeof auth !== 'string' || !/^Transfer [A-Za-z0-9_-]{312}$/.test(auth)) refuse('UNAUTHORIZED', 401);
      const wire = auth.slice(9); const nodeId = this.options.node.status.nodeId; if (!nodeId) refuse('UNAVAILABLE', 503);
      const operation = method.toLowerCase() as TicketOperation;
      const line = `${method} ${path}`;
      if (req.headers['x-privanet-ack'] === '1') {
        const parsed = parseTicket(wire); const ack = parsed && this.reads.get(parsed.claims.transferId);
        // The exact ticket was verified before begin. Its expiry/old-key retirement cannot invalidate completion of that same in-progress read.
        if (method !== 'GET' || !ack?.ready || ack.until <= Date.now() || ack.line !== line || ack.ticketHash !== createHash('sha256').update(wire).digest('hex') || req.headers['content-length'] !== '0' || req.headers['x-privanet-challenge'] !== ack.challenge ||
            !verifyHolderProof(ack.claims.holderKey, { challenge: ack.challenge, transferId: ack.claims.transferId, requestLine: line }, String(req.headers['x-privanet-proof'] ?? ''))) refuse('UNAUTHORIZED');
        claims = ack.claims;
        if (!ack.done) { await this.options.node.storageAction(claims.transferId, 'prepare'); await this.queue!.complete(claims.transferId, this.options.node.transferNow); ack.done = true; this.cached.completed++; }
        await this.retryReceipts(); this.send(res, 200, 'ACKNOWLEDGED'); return;
      }
      await this.options.node.refreshTransferKeysForTicket(wire, this.options.node.transferNow);
      const verdict = verifyTicket(wire, { keys: this.options.node.transferKeys ?? [], now: this.options.node.transferNow, expect: { nodeId, operation, chunkId: path.slice(11) } });
      if (!verdict.ok) refuse('UNAUTHORIZED', 403); claims = verdict.claims;
      this.gate();
      if (this.replay?.has(claims.transferId)) refuse('REPLAYED', 409);
      if (req.headers['x-privanet-handshake'] === '1') {
        if (req.headers['content-length'] !== '0' || req.headers['x-privanet-proof']) refuse('INVALID_REQUEST', 400);
        if (this.challenges.size >= 1024) refuse('BUSY', 429);
        let challenge = this.challenges.get(claims.transferId);
        if (!challenge || challenge.until <= Date.now()) { challenge = { challenge: newHolderChallenge(), until: Date.now() + 10000, line }; this.challenges.set(claims.transferId, challenge); }
        this.send(res, 401, 'HOLDER_CHALLENGE', { challenge: challenge.challenge }); return;
      }
      const challenge = this.challenges.get(claims.transferId); this.challenges.delete(claims.transferId);
      if (!challenge || challenge.until <= Date.now() || challenge.line !== line || req.headers['x-privanet-challenge'] !== challenge.challenge ||
          !verifyHolderProof(claims.holderKey, { challenge: challenge.challenge, transferId: claims.transferId, requestLine: line }, String(req.headers['x-privanet-proof'] ?? ''))) refuse('UNAUTHORIZED');
      const length = req.headers['content-length'];
      if (typeof length !== 'string' || !/^(0|[1-9][0-9]{0,7})$/.test(length) || Number(length) !== (operation === 'put' ? claims.maxBytes : 0)) refuse('SIZE_MISMATCH', 400);
      if (operation === 'put' && req.headers['content-type'] !== 'application/octet-stream') refuse('INVALID_REQUEST', 415);
      const config = this.options.config(); const active = Object.values(this.cached.active).reduce((a, b) => a + b, 0);
      if (active + [...this.reads.values()].filter(r => !r.done).length >= config.maxConcurrent || (operation === 'put' && this.cached.active.put >= config.maxConcurrentPuts) || (this.queue?.size ?? RECEIPT_LIMIT) >= RECEIPT_LIMIT) refuse('BUSY', 429);
      this.cached.active[operation]++; controller = new AbortController(); this.running.add(controller); this.activeIds.add(claims.transferId);
      operationTimer = setTimeout(() => controller?.abort(new DOMException('Transfer timeout', 'TimeoutError')), this.options.timeoutMs ?? 300000); operationTimer.unref();
      const signal = controller.signal;
      const abort = () => controller?.abort(); req.once('aborted', () => { if (!req.complete) abort(); }); res.once('close', () => { if (!res.writableFinished && !this.reads.get(claims!.transferId)?.ready) abort(); });
      if (operation !== 'put') req.resume();
      signal.addEventListener('abort', () => req.destroy(), { once: true });
      if (await this.replay!.consume(claims.transferId, claims.expiresAt, this.options.node.transferNow) !== 'OK') refuse('REPLAYED', 409);
      signal.throwIfAborted(); this.gate();
      await this.options.node.storageAction(claims.transferId, 'begin', undefined, { applicationId: claims.applicationId, chunkId: claims.chunkId, operation: claims.operation, kid: claims.kid, maxBytes: claims.maxBytes, issuedAt: claims.issuedAt, expiresAt: claims.expiresAt, holderHash: createHash('sha256').update(Buffer.from(claims.holderKey, 'base64')).digest('hex') }); begun = true; signal.throwIfAborted(); this.gate();
      const store = this.options.store(); if (!store) refuse('UNAVAILABLE', 503);
      this.options.meter.reserve(operation === 'delete' ? 0 : claims.maxBytes);
      const receipt: TransferReceipt = { transferId: claims.transferId, applicationId: claims.applicationId, chunkId: claims.chunkId, nodeId, operation,
        bytes: operation === 'delete' ? 0 : claims.maxBytes, sha256: claims.chunkId.slice(4), completedAt: this.options.node.transferNow };
      await this.queue!.prepare(receipt); prepared = true;
      let checking = false;
      const watcher = setInterval(() => {
        try { this.gate(); } catch { controller?.abort(); }
        if (!checking) { checking = true; void this.options.node.storageAction(receipt.transferId, 'check').catch(() => controller?.abort()).finally(() => { checking = false; }); }
      }, 1000); watcher.unref();
      try {
        const beforeCommit = async () => { signal.throwIfAborted(); this.gate(); await this.options.node.storageAction(receipt.transferId, 'prepare'); signal.throwIfAborted(); this.gate(); };
        if (operation === 'put') {
          const meter = this.options.meter; const gate = () => this.gate(); const stats = this.cached;
          const source = async function* () { for await (const bytes of req) { signal.throwIfAborted(); gate(); const buffer = bytes as Buffer; await meter.throttle(buffer.length, signal); stats.bytes += buffer.length; yield buffer; } };
          await store.put(claims.chunkId, source(), claims.maxBytes, { signal, applicationId: claims.applicationId, beforeCommit, commitGate: () => { signal.throwIfAborted(); this.gate(); }, onCommitted: () => { committed = true; } }); committed = true;
        } else if (operation === 'delete') {
          await store.delete(claims.chunkId, claims.applicationId, { beforeCommit, commitGate: () => { signal.throwIfAborted(); this.gate(); }, onCommitted: () => { committed = true; } }); committed = true;
        } else {
          const chunk = await store.get(claims.chunkId, claims.applicationId);
          if (chunk.size !== claims.maxBytes) { chunk.stream.destroy(); refuse('INTEGRITY', 409); }
          const ack: ReadAck = { ticketHash: createHash('sha256').update(wire).digest('hex'), challenge: newHolderChallenge(), line, claims, until: Date.now() + (this.options.timeoutMs ?? 300000) + 30000, ready: false, done: false };
          this.reads.set(claims.transferId, ack);
          signal.addEventListener('abort', () => { chunk.stream.destroy(); res.destroy(); }, { once: true });
          res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': chunk.size, 'cache-control': 'no-store', 'content-disposition': 'attachment', 'x-content-type-options': 'nosniff',
            'x-privanet-receipt-challenge': ack.challenge, connection: 'close' });
          let sent = 0;
          for await (const bytes of chunk.stream) { signal.throwIfAborted(); this.gate(); const buffer = bytes as Buffer; await this.options.meter.throttle(buffer.length, signal); this.cached.bytes += buffer.length; sent += buffer.length; ack.ready = sent === chunk.size; if (!res.write(buffer) && !ack.ready) await once(res, 'drain', { signal }); }
          // Content-Length clients can close as soon as the final byte arrives. Only the signed acknowledgement establishes successful delivery.
          res.end();
          ack.until = Date.now() + 30000; return;
        }
        await this.queue!.complete(claims.transferId, this.options.node.transferNow); this.cached.completed++;
        await this.retryReceipts(); this.send(res, 200, 'COMPLETED');
      } finally { clearInterval(watcher); }
    } catch (error) {
      const reason = failureReason(error); this.cached.failed++; this.cached.failures[reason] = (this.cached.failures[reason] ?? 0) + 1;
      // A committed chunk and its write-ahead intent are never removed on an acknowledgement failure.
      if (claims && begun && !committed) {
        this.reads.delete(claims.transferId);
        if (prepared) await this.queue?.fail(claims.transferId, reason).catch(() => { this.cached.error = 'RECEIPT_STATE_IO'; });
        else await this.options.node.storageAction(claims.transferId, 'fail', reason).catch(() => undefined);
      }
      if (res.headersSent) res.destroy(); else this.send(res, error instanceof ApiError ? error.status : 503, error instanceof ApiError ? error.code : reason);
    } finally {
      clearTimeout(operationTimer);
      if (controller && claims) { this.running.delete(controller); this.activeIds.delete(claims.transferId); this.cached.active[claims.operation]--; }
    }
  }
  private async cleanup(): Promise<void> {
    void this.options.node.refreshTransferKeys();
    const now = Date.now(); for (const [id, value] of this.challenges) if (value.until <= now) this.challenges.delete(id);
    for (const [id, value] of this.reads) if (value.until <= now) { this.reads.delete(id); if (!value.done) await this.queue?.fail(id, 'TIMEOUT'); }
  }
  private async closeListener(): Promise<void> {
    if (this.sweep) clearInterval(this.sweep); this.sweep = undefined;
    this.endpoint = undefined; this.cached.listener = 'STOPPED'; this.cached.advertised = false;
    for (const controller of this.running) controller.abort();
    for (const socket of this.sockets) socket.destroy();
    const server = this.server; this.server = undefined;
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    await Promise.allSettled([...this.handlers]);
    this.challenges.clear();
    const failures = await Promise.allSettled([...this.reads].filter(([, value]) => !value.done).map(([id]) => this.queue?.fail(id, 'ABORTED')));
    this.reads.clear();
    if (failures.some(result => result.status === 'rejected')) this.cached.error = 'RECEIPT_STATE_IO';
  }
  async stop(): Promise<void> { this.stopping = true; if (this.retryTimer) clearTimeout(this.retryTimer); this.retryTimer = undefined; await this.closeListener(); await this.retrying; await this.queue?.flush(); }
}
