import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { equalSecret } from './crypto.js';

/**
 * The guard for a local, privileged web interface (the operator dashboard; the node's control panel carries an equivalent of its own). It owns everything that makes such a page safe to
 * run on a desktop and leaves the application only two small hooks, one for reads and one for changes:
 *
 *  - it listens on 127.0.0.1 only; the Host must be this server (defeating DNS rebinding);
 *  - every /api route, reads included, needs a session cookie obtained by presenting the secret (HttpOnly, SameSite=Strict); failed attempts are limited;
 *  - a change needs the session's CSRF token, a JSON content type and an Origin that is this server; bodies are small JSON;
 *  - only GET and POST exist; there is no CORS; the page is served with a nonce-based Content-Security-Policy and no inline anything else.
 *
 * Whatever the hooks return is JSON; a hook that throws answers 500 without a message, so an error from the layer behind (which may quote a request) never reaches the browser.
 */
export const LOCAL_UI_BODY_LIMIT = 32768;
const SESSION_TTL_MS = 12 * 3600000; const MAX_SESSIONS = 16; const LOGIN_FAILURES_PER_MINUTE = 5;

export interface LocalUiReply { status: number; body: unknown; headers?: Record<string, string> }
export interface LocalUiRequest { path: string; searchParams: URLSearchParams }
export interface LocalUiOptions {
  /** 0 picks a free port. */ port: number; cookieName: string; /** The sign-in secret: 64 lowercase hex characters. */ secret: string;
  page: (nonce: string) => string;
  /** An authenticated GET /api/... (other than /api/session). Return undefined for "no such route". */
  get: (request: LocalUiRequest) => Promise<LocalUiReply | undefined> | LocalUiReply | undefined;
  /** An authenticated, CSRF-checked POST /api/... (other than /api/login and /api/logout), with its parsed JSON body. */
  post: (request: LocalUiRequest, body: unknown) => Promise<LocalUiReply | undefined> | LocalUiReply | undefined;
  /** Extra fields for GET /api/session. */ sessionInfo?: () => Record<string, unknown>;
  bodyLimit?: number; clock?: () => number;
}
export interface LocalUiHandle { port: number; /** Always 127.0.0.1. */ address: string; close: () => Promise<void> }

const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void => {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-length': Buffer.byteLength(text), ...headers }); res.end(text);
};
const refuse = (res: ServerResponse, status: number, code: string): void => send(res, status, { error: { code } });

export async function startLocalUi(options: LocalUiOptions): Promise<LocalUiHandle> {
  if (!/^[a-f0-9]{64}$/.test(options.secret)) throw new Error('The sign-in secret must be 64 hex characters');
  const clock = options.clock ?? Date.now; const limit = options.bodyLimit ?? LOCAL_UI_BODY_LIMIT; const cookieName = options.cookieName;
  const sessions = new Map<string, { csrf: string; expires: number }>(); let failures: number[] = [];
  let allowedHosts = new Set<string>(); let allowedOrigins = new Set<string>();

  const readBody = (req: IncomingMessage): Promise<unknown> => new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let size = 0;
    req.on('data', (chunk: Buffer) => { size += chunk.length; if (size > limit) { if (size - chunk.length <= limit) reject(Object.assign(new Error('too large'), { status: 413 })); chunks.length = 0; return; } chunks.push(chunk); });
    req.on('end', () => { try { resolve(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(Object.assign(new Error('bad json'), { status: 400 })); } });
    req.on('error', () => reject(Object.assign(new Error('read failed'), { status: 400 })));
  });
  const cookieOf = (req: IncomingMessage): string | undefined => {
    for (const part of (req.headers.cookie ?? '').split(';')) { const [name, ...rest] = part.trim().split('='); if (name === cookieName) return rest.join('='); }
    return undefined;
  };
  const sessionOf = (req: IncomingMessage) => {
    const id = cookieOf(req); if (!id || !/^[a-f0-9]{64}$/.test(id)) return undefined;
    const session = sessions.get(id); if (!session) return undefined;
    if (session.expires <= clock()) { sessions.delete(id); return undefined; }
    return { id, ...session };
  };
  const jsonWrite = (req: IncomingMessage, res: ServerResponse): boolean => {
    if (!allowedOrigins.has((req.headers.origin ?? '').toLowerCase())) { refuse(res, 403, 'ORIGIN_NOT_ALLOWED'); return false; }
    if (!/^application\/json(;|$)/i.test(req.headers['content-type'] ?? '')) { refuse(res, 415, 'JSON_REQUIRED'); return false; }
    return true;
  };
  const readOrRefuse = async (req: IncomingMessage, res: ServerResponse): Promise<{ body: unknown } | undefined> => {
    try { return { body: await readBody(req) }; } catch (error) {
      const tooLarge = (error as { status?: number }).status === 413;
      // Answer first, then drop the connection, so the client gets a clean 413 and the rest of an oversized upload is never read.
      if (tooLarge) { res.setHeader('connection', 'close'); res.once('finish', () => { req.socket.destroy(); }); }
      refuse(res, tooLarge ? 413 : 400, tooLarge ? 'BODY_TOO_LARGE' : 'BAD_JSON'); return undefined;
    }
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method = req.method ?? ''; const host = (req.headers.host ?? '').toLowerCase();
    if (!allowedHosts.has(host)) return refuse(res, 421, 'HOST_NOT_ALLOWED');
    if (method !== 'GET' && method !== 'POST') { res.setHeader('allow', 'GET, POST'); return refuse(res, 405, 'METHOD_NOT_ALLOWED'); }
    if (typeof req.url !== 'string' || !req.url.startsWith('/') || req.url.startsWith('//') || req.url.length > 2048) return refuse(res, 400, 'BAD_REQUEST');
    let url: URL; try { url = new URL(req.url, `http://${host}`); } catch { return refuse(res, 400, 'BAD_REQUEST'); }
    const path = url.pathname; const request = { path, searchParams: url.searchParams };
    if (method === 'GET' && (path === '/' || path === '/login')) {
      const nonce = randomBytes(16).toString('base64');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY', 'cross-origin-resource-policy': 'same-origin',
        'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` });
      res.end(options.page(nonce)); return;
    }
    if (!path.startsWith('/api/')) return refuse(res, 404, 'NOT_FOUND');
    if (method === 'POST' && path === '/api/login') {
      const now = clock(); failures = failures.filter(at => now - at < 60000);
      if (failures.length >= LOGIN_FAILURES_PER_MINUTE) return refuse(res, 429, 'TOO_MANY_ATTEMPTS');
      if (!jsonWrite(req, res)) return;
      const read = await readOrRefuse(req, res); if (!read) return;
      const supplied = typeof read.body === 'object' && read.body !== null && !Array.isArray(read.body) && Object.keys(read.body).length === 1 ? (read.body as { token?: unknown }).token : undefined;
      if (typeof supplied !== 'string' || supplied.length !== 64 || !equalSecret(supplied, options.secret)) { failures.push(now); return refuse(res, 401, 'LOGIN_REFUSED'); }
      if (sessions.size >= MAX_SESSIONS) { const oldest = [...sessions.entries()].sort((a, b) => a[1].expires - b[1].expires)[0]; if (oldest) sessions.delete(oldest[0]); }
      const id = randomBytes(32).toString('hex'); sessions.set(id, { csrf: randomBytes(24).toString('hex'), expires: now + SESSION_TTL_MS });
      return send(res, 200, { ok: true }, { 'set-cookie': `${cookieName}=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}` });
    }
    const session = sessionOf(req);
    if (!session) return refuse(res, 401, 'LOGIN_REQUIRED');
    if (method === 'GET') {
      if (path === '/api/session') return send(res, 200, { csrf: session.csrf, ...(options.sessionInfo?.() ?? {}) });
      const reply = await options.get(request); if (!reply) return refuse(res, 404, 'NOT_FOUND');
      return send(res, reply.status, reply.body, reply.headers);
    }
    if (!jsonWrite(req, res)) return;
    const supplied = req.headers['x-csrf-token']; if (typeof supplied !== 'string' || supplied.length !== session.csrf.length || !equalSecret(supplied, session.csrf)) return refuse(res, 403, 'CSRF_TOKEN_INVALID');
    const read = await readOrRefuse(req, res); if (!read) return;
    if (path === '/api/logout') { sessions.delete(session.id); return send(res, 200, { ok: true }, { 'set-cookie': `${cookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` }); }
    const reply = await options.post(request, read.body); if (!reply) return refuse(res, 404, 'NOT_FOUND');
    return send(res, reply.status, reply.body, reply.headers);
  };
  const server: Server = createServer((req, res) => { void handle(req, res).catch(() => { if (!res.headersSent) refuse(res, 500, 'INTERNAL'); else res.end(); }); });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
  const address = server.address(); const port = typeof address === 'object' && address ? address.port : options.port;
  allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]); allowedOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  return { port, address: typeof address === 'object' && address ? address.address : '', close: () => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }) };
}
