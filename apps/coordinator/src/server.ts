import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ZodError } from 'zod';
import { AuthStartSchema, IdSchema, LeaseRequestSchema, MAX_BODY_BYTES, MAX_JOB_WAIT_MS, NodeIdSchema, PROTOCOL_VERSION } from '@privanet/protocol';
import { ApiError, equalSecret } from '@privanet/shared';
import type { Coordinator } from './service.js';

export interface LogEvent { event: string; code?: string }
export interface ServerOptions { adminSecret: string; log?: (entry: LogEvent) => void; authRequestsPerMinute?: number; maxLeaseWaiters?: number; maxJobWaiters?: number }
function body(req: IncomingMessage): Promise<unknown> {
  if (req.headers['content-type'] !== 'application/json') throw new ApiError(415, 'CONTENT_TYPE', 'expected application/json');
  return new Promise((resolve, reject) => {
    let size = 0; let stopped = false; const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      if (stopped) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { stopped = true; reject(new ApiError(413, 'BODY_TOO_LARGE', 'request body too large')); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (stopped) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new ApiError(400, 'INVALID_JSON', 'invalid json')); }
    });
    req.on('error', reject);
    req.on('aborted', () => reject(new ApiError(400, 'ABORTED', 'request aborted')));
  });
}
function bearer(req: IncomingMessage): string {
  const value = req.headers.authorization;
  const match = typeof value === 'string' ? /^Bearer ([a-f0-9]{64})$/.exec(value) : null;
  if (!match?.[1]) throw new ApiError(401, 'UNAUTHORIZED', 'authentication required');
  return match[1];
}
export function createCoordinatorServer(core: Coordinator, options: ServerOptions) {
  if (!/^[a-f0-9]{64}$/.test(options.adminSecret)) throw new Error('Admin secret must be 32 random bytes in hex');
  const log = options.log ?? (() => {});
  const limit = options.authRequestsPerMinute ?? 120;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid authentication rate limit');
  const buckets = new Map<string, { count: number; starts: number }>();
  // Requests currently held open waiting for work. Bounded so idle nodes cannot exhaust sockets or memory; over the bound a request is answered at once like a plain poll.
  const maxWaiters = options.maxLeaseWaiters ?? 512; let waiters = 0;
  // Same idea for applications waiting on a job's result (`GET /v1/jobs/{id}?waitMs=`).
  const maxJobWaiters = options.maxJobWaiters ?? 4096; let jobWaiters = 0;
  function rate(req: IncomingMessage) {
    const key = req.socket.remoteAddress ?? 'unknown'; const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || now - bucket.starts >= 60000) {
      if (buckets.size >= 1000) buckets.delete(buckets.keys().next().value ?? '');
      bucket = { count: 0, starts: now }; buckets.set(key, bucket);
    }
    bucket.count++;
    if (bucket.count > limit) throw new ApiError(429, 'RATE_LIMIT', 'authentication rate limit');
  }
  function send(res: ServerResponse, status: number, payload: unknown) {
    const serialized = JSON.stringify(payload);
    if (Buffer.byteLength(serialized) > 512 * 1024) throw new ApiError(500, 'RESPONSE_LIMIT', 'response limit exceeded');
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(serialized),
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-PrivaNet-Protocol': String(PROTOCOL_VERSION),
      ...(status === 413 ? { Connection: 'close' } : {}) });
    res.end(serialized);
  }
  const server = createServer((req, res) => {
    void (async () => {
      let preRated = false;
      try {
        if (req.headers['x-privanet-protocol'] !== String(PROTOCOL_VERSION)) throw new ApiError(426, 'PROTOCOL_MISMATCH', 'unsupported protocol version');
        const rawUrl = req.url ?? ''; const queryAt = rawUrl.indexOf('?');
        const path = queryAt < 0 ? rawUrl : rawUrl.slice(0, queryAt); const query = queryAt < 0 ? '' : rawUrl.slice(queryAt + 1);
        // The only query string the API accepts is `waitMs=<integer>` on a job read; anything else is an unknown route.
        const waitMatch = /^waitMs=(\d{1,5})$/.exec(query);
        if (query !== '' && !(waitMatch && req.method === 'GET' && /^\/v1\/jobs\/[^/]+$/.test(path))) throw new ApiError(404, 'NOT_FOUND', 'route not found');
        const jobWaitMs = waitMatch?.[1] === undefined ? 0 : Number(waitMatch[1]);
        if (jobWaitMs > MAX_JOB_WAIT_MS) throw new ApiError(400, 'INVALID_REQUEST', 'waitMs too large');
        if (!/^\/v1\/[a-zA-Z0-9/_-]+$/.test(path)) throw new ApiError(404, 'NOT_FOUND', 'route not found');
        if (req.method === 'GET' && path === '/v1/health') { send(res, 200, core.health()); return; }
        const publicPaths = ['/v1/enrollment/challenge', '/v1/enrollment/proof', '/v1/auth/challenge', '/v1/auth/proof'];
        if (req.method === 'POST' && publicPaths.includes(path)) {
          rate(req); preRated = true; const input = await body(req);
          const result = path === '/v1/enrollment/challenge' ? core.beginEnrollment(input)
            : path === '/v1/enrollment/proof' ? core.prove(input, 'enroll')
              : path === '/v1/auth/challenge' ? core.beginAuth(AuthStartSchema.parse(input).nodeId) : core.prove(input, 'auth');
          send(res, 200, result); return;
        }
        const token = bearer(req);
        if (path.startsWith('/v1/admin/')) {
          if (!equalSecret(token, options.adminSecret)) throw new ApiError(401, 'UNAUTHORIZED_ADMIN', 'administrator authentication required');
          if (req.method === 'GET' && path === '/v1/admin/nodes') { send(res, 200, { nodes: core.listNodes() }); return; }
          if (req.method === 'POST' && path === '/v1/admin/enrollment-tokens') { send(res, 201, core.createEnrollment(await body(req))); return; }
          if (req.method === 'POST' && path === '/v1/admin/applications') { send(res, 201, core.createApplication(await body(req))); return; }
          const rotate = /^\/v1\/admin\/applications\/([^/]+)\/rotate$/.exec(path);
          if (req.method === 'POST' && rotate) {
            await body(req); send(res, 200, core.rotateApplication(IdSchema.parse(rotate[1])));
            log({ event: 'application.rotated' }); return;
          }
          const revoke = /^\/v1\/admin\/(nodes|applications)\/([^/]+)\/revoke$/.exec(path);
          if (req.method === 'POST' && revoke) {
            const empty = await body(req);
            if (JSON.stringify(empty) !== '{}') throw new ApiError(400, 'INVALID_REQUEST', 'expected empty object');
            if (revoke[1] === 'nodes') core.revokeNode(NodeIdSchema.parse(revoke[2])); else core.revokeApplication(IdSchema.parse(revoke[2]));
            log({ event: 'identity.revoked' }); send(res, 200, { ok: true }); return;
          }
        } else if (path.startsWith('/v1/node/')) {
          const node = core.authenticateNode(token);
          if (req.method === 'POST' && path === '/v1/node/heartbeat') { const input = await body(req); core.authenticateNode(token); core.heartbeat(node.nodeId, input); send(res, 200, { ok: true }); return; }
          if (req.method === 'POST' && path === '/v1/node/jobs/lease') {
            const { waitMs = 0 } = LeaseRequestSchema.parse(await body(req));
            core.authenticateNode(token); let lease = core.lease(node.nodeId);
            if (!lease && waitMs > 0 && waiters < maxWaiters) {
              waiters++;
              try {
                // The response's 'close' fires when the node's connection ends before we answer (an IncomingMessage 'close' fires when the body is read, which is not a disconnect).
                const deadline = Date.now() + waitMs; let gone = false; res.once('close', () => { gone = true; });
                while (!lease && !gone && Date.now() < deadline) {
                  // Sleep until work appears, the deadline passes or the node disconnects; then re-check the credential (revocation) and try again.
                  await new Promise<void>(resolve => { const timer = setTimeout(finish, Math.max(1, deadline - Date.now())); const off = core.onWork(node.nodeId, node.capabilities, finish); res.once('close', finish);
                    function finish() { clearTimeout(timer); off(); res.off('close', finish); resolve(); } });
                  if (gone || res.destroyed) break;
                  core.authenticateNode(token); lease = core.lease(node.nodeId);
                }
              } finally { waiters--; }
            }
            if (!res.destroyed) send(res, 200, { lease }); return;
          }
          if (req.method === 'POST' && path === '/v1/node/goodbye') {
            const input = await body(req); core.authenticateNode(token); core.goodbye(node.nodeId, input);
            log({ event: 'node.departed' }); send(res, 200, { ok: true }); return;
          }
          const release = /^\/v1\/node\/jobs\/([^/]+)\/release$/.exec(path);
          if (req.method === 'POST' && release) {
            const id = IdSchema.parse(release[1]); const input = await body(req);
            core.authenticateNode(token); core.release(node.nodeId, id, input);
            log({ event: 'job.released' }); send(res, 200, { ok: true }); return;
          }
          const renew = /^\/v1\/node\/jobs\/([^/]+)\/renew$/.exec(path);
          if (req.method === 'POST' && renew) {
            const id = IdSchema.parse(renew[1]); const input = await body(req);
            core.authenticateNode(token); send(res, 200, core.renew(node.nodeId, id, input)); return;
          }
          const finish = /^\/v1\/node\/jobs\/([^/]+)\/(complete|fail)$/.exec(path);
          if (req.method === 'POST' && finish) {
            const id = IdSchema.parse(finish[1]); const input = await body(req);
            // Recheck the bearer after awaiting input, so revocation/refresh cannot race.
            core.authenticateNode(token);
            if (finish[2] === 'complete') core.complete(node.nodeId, id, input); else core.fail(node.nodeId, id, input);
            log({ event: finish[2] === 'complete' ? 'job.completed' : 'job.failed' }); send(res, 200, { ok: true }); return;
          }
        } else {
          const app = core.authenticateApplication(token);
          if (req.method === 'GET' && path === '/v1/capabilities') { send(res, 200, core.capabilities(app)); return; }
          if (req.method === 'POST' && path === '/v1/jobs') {
            const input = await body(req); const currentApp = core.authenticateApplication(token);
            const job = core.submit(currentApp, input); log({ event: 'job.submitted' }); send(res, 201, job); return;
          }
          const get = /^\/v1\/jobs\/([^/]+)$/.exec(path);
          if (req.method === 'GET' && get) {
            const id = IdSchema.parse(get[1]); let job = core.getJob(app, id); // ownership is checked before anything waits
            const done = () => job.status === 'COMPLETED' || job.status === 'FAILED';
            if (jobWaitMs > 0 && !done() && jobWaiters < maxJobWaiters) {
              jobWaiters++;
              try {
                const deadline = Date.now() + jobWaitMs; let gone = false; res.once('close', () => { gone = true; });
                while (!done() && !gone && Date.now() < deadline) {
                  await new Promise<void>(resolve => { const timer = setTimeout(finish, Math.max(1, deadline - Date.now())); const off = core.onJobFinished(id, finish); res.once('close', finish);
                    function finish() { clearTimeout(timer); off(); res.off('close', finish); resolve(); } });
                  if (gone || res.destroyed) break;
                  job = core.getJob(core.authenticateApplication(token), id); // the credential is re-checked on every wake
                }
              } finally { jobWaiters--; }
            }
            if (!res.destroyed) send(res, 200, job); return;
          }
        }
        throw new ApiError(404, 'NOT_FOUND', 'route not found');
      } catch (error) {
        let failure = error instanceof ApiError ? error : error instanceof ZodError
          ? error.issues.some(issue => issue.path.includes('protocolVersion'))
            ? new ApiError(426, 'PROTOCOL_MISMATCH', 'unsupported protocol version')
            : new ApiError(400, 'INVALID_REQUEST', 'request schema rejected')
          : new ApiError(500, 'INTERNAL_ERROR', 'internal coordinator error');
        if (failure.status === 401 && !preRated) {
          try { rate(req); } catch (rateError) { if (rateError instanceof ApiError) failure = rateError; }
        }
        log({ event: 'request.rejected', code: failure.code });
        if (!res.headersSent && !res.destroyed) send(res, failure.status, { error: { code: failure.code, message: failure.message } });
      }
    })();
  });
  server.requestTimeout = 10000; server.headersTimeout = 5000; server.keepAliveTimeout = 5000;
  return server;
}
