import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { DisplayNameSchema, JobTypeSchema, PROTOCOL_VERSION, SERVICE_VERSION } from '@privanet/protocol';
import type { JobType } from '@privanet/protocol';
import { equalSecret } from '@privanet/shared';
import { loadOrCreatePanelToken } from './panel-token.js';
import type { PrivaNode } from './daemon.js';
import type { ResourceEngine } from './resource-engine.js';
import type { TransferMeter } from './transfer-meter.js';
import type { LocalControl } from './local-control.js';
import type { LogRing } from './log-ring.js';
import type { ResourceHistory } from './history.js';
import { PolicyError } from './policy-store.js';
import { PRESETS, PRESET_IDS } from './presets.js';
import { policyFindings } from './config-check.js';
import { ResourcePolicySchema } from './resource-policy.js';
import { buildStatus } from './status-document.js';
import { diagnose } from './doctor.js';
import { renderPage } from './panel-page.js';
import { PRIVACY_STATEMENT } from './privacy.js';

/**
 * The local control panel. It is a privileged control surface, so it is built around what it refuses: it listens on 127.0.0.1 only; every /api route (reads too) needs a session
 * cookie obtained by presenting the panel token, which lives in the state directory (mode 0600) so only someone who can already read the node's private files can log in;
 * every state change needs the session's CSRF token, a JSON content type and an Origin that is this panel; the Host must be this panel (defeating DNS rebinding); bodies are
 * small, strict-schema JSON; and the actions it can trigger are a fixed list of named operations. There is no route that runs a command, reads or writes a file by name, fetches a
 * URL, returns the environment, a key, an enrollment secret or a credential. Anything else is 404.
 */
export const PANEL_BODY_LIMIT = 32768;
const SESSION_TTL_MS = 12 * 3600000; const MAX_SESSIONS = 16; const LOGIN_FAILURES_PER_MINUTE = 5;
const COOKIE = 'privanet_panel';

export interface PanelOptions {
  stateDir: string; /** 0 picks a free port (tests). */ port: number;
  node: PrivaNode; engine: ResourceEngine; control: LocalControl; transfer?: TransferMeter | undefined; history?: ResourceHistory | undefined; logs: LogRing;
  coordinatorUrl: string; enrolledCapabilities: JobType[]; jobSlots: number; env: NodeJS.ProcessEnv;
  actions: { drainAndStop: () => void; restart: () => void };
  /** Optional operations supplied by the host: a support bundle and an update check (each only runs when the owner asks). */
  supportBundle?: () => Promise<unknown>; updateCheck?: () => Promise<unknown>;
  clock?: () => number;
}
export interface PanelHandle { port: number; /** The address actually bound: always 127.0.0.1. */ address: string; token: string; close: () => Promise<void> }


const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void => {
  const text = JSON.stringify(body); res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-length': Buffer.byteLength(text), ...headers }); res.end(text);
};
const fail = (res: ServerResponse, status: number, code: string, extra: Record<string, unknown> = {}): void => json(res, status, { error: { code, ...extra } });

const PauseBody = z.strictObject({ kind: z.enum(['15m', '1h', 'tomorrow', 'reboot', 'indefinite']) });
const PolicyBody = z.union([z.strictObject({ preset: z.enum(PRESET_IDS) }), z.strictObject({ reset: z.literal(true) }), z.strictObject({ policy: z.record(z.string(), z.unknown()) })]);
const NameBody = z.strictObject({ name: DisplayNameSchema.nullable() });
const CapabilitiesBody = z.strictObject({ disabled: z.array(JobTypeSchema).max(32) });
const ConfirmBody = z.strictObject({ confirm: z.literal(true) });
const LoginBody = z.strictObject({ token: z.string().length(64) });
const EmptyBody = z.strictObject({});

export async function startPanel(options: PanelOptions): Promise<PanelHandle> {
  const token = await loadOrCreatePanelToken(options.stateDir); const clock = options.clock ?? Date.now;
  const sessions = new Map<string, { csrf: string; expires: number }>(); let failures: number[] = []; let doctorRunning = false;
  let allowedHosts = new Set<string>(); let allowedOrigins = new Set<string>();

  const readBody = (req: IncomingMessage): Promise<unknown> => new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let size = 0;
    req.on('data', (chunk: Buffer) => { size += chunk.length; if (size > PANEL_BODY_LIMIT) { if (size - chunk.length <= PANEL_BODY_LIMIT) reject(Object.assign(new Error('too large'), { status: 413 })); chunks.length = 0; return; } chunks.push(chunk); });
    req.on('end', () => { try { resolve(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(Object.assign(new Error('bad json'), { status: 400 })); } });
    req.on('error', () => reject(Object.assign(new Error('read failed'), { status: 400 })));
  });
  const cookieOf = (req: IncomingMessage): string | undefined => {
    for (const part of (req.headers.cookie ?? '').split(';')) { const [name, ...rest] = part.trim().split('='); if (name === COOKIE) return rest.join('='); }
    return undefined;
  };
  const sessionOf = (req: IncomingMessage) => {
    const id = cookieOf(req); if (!id || !/^[a-f0-9]{64}$/.test(id)) return undefined;
    const session = sessions.get(id); if (!session) return undefined;
    if (session.expires <= clock()) { sessions.delete(id); return undefined; }
    return { id, ...session };
  };
  const context = () => ({ node: options.node, engine: options.engine, control: options.control, transfer: options.transfer, coordinatorUrl: options.coordinatorUrl, enrolledCapabilities: options.enrolledCapabilities });
  const policyDocument = () => {
    const view = options.control.view; const policy = view.policy;
    return { source: view.source ?? null, preset: view.preset, problem: view.policyProblem ?? null, restartRequired: view.restartRequired, policy: policy ?? null,
      findings: policy ? policyFindings(policy, { jobSlots: options.jobSlots, capabilities: options.enrolledCapabilities }) : [], jobSlots: { value: options.jobSlots, note: 'Set by PRIVANODE_JOB_SLOTS in the service environment; changing it needs a restart.' },
      presets: PRESET_IDS.map(id => ({ id, label: PRESETS[id].label, summary: PRESETS[id].summary, values: PRESETS[id].values })) };
  };

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch(() => { if (!res.headersSent) fail(res, 500, 'INTERNAL'); else res.end(); });
  });
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method = req.method ?? ''; const host = (req.headers.host ?? '').toLowerCase();
    if (!allowedHosts.has(host)) return fail(res, 421, 'HOST_NOT_ALLOWED');
    if (method !== 'GET' && method !== 'POST') { res.setHeader('allow', 'GET, POST'); return fail(res, 405, 'METHOD_NOT_ALLOWED'); }
    if (typeof req.url !== 'string' || !req.url.startsWith('/') || req.url.startsWith('//') || req.url.length > 2048) return fail(res, 400, 'BAD_REQUEST');
    let url: URL; try { url = new URL(req.url, `http://${host}`); } catch { return fail(res, 400, 'BAD_REQUEST'); }
    const path = url.pathname;
    if (method === 'GET' && (path === '/' || path === '/login')) {
      const nonce = randomBytes(16).toString('base64');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY', 'cross-origin-resource-policy': 'same-origin',
        'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` });
      res.end(renderPage(nonce)); return;
    }
    if (!path.startsWith('/api/')) return fail(res, 404, 'NOT_FOUND');
    // Login: the only API route that works without a session.
    if (method === 'POST' && path === '/api/login') {
      const now = clock(); failures = failures.filter(at => now - at < 60000);
      if (failures.length >= LOGIN_FAILURES_PER_MINUTE) return fail(res, 429, 'TOO_MANY_ATTEMPTS');
      if (!allowedOrigins.has((req.headers.origin ?? '').toLowerCase())) return fail(res, 403, 'ORIGIN_NOT_ALLOWED');
      if (!/^application\/json(;|$)/i.test(req.headers['content-type'] ?? '')) return fail(res, 415, 'JSON_REQUIRED');
      let parsed; try { parsed = LoginBody.safeParse(await readBody(req)); } catch (error) { return fail(res, (error as { status?: number }).status ?? 400, 'BAD_REQUEST'); }
      if (!parsed.success || !equalSecret(parsed.data.token, token)) { failures.push(now); return fail(res, 401, 'LOGIN_REFUSED'); }
      if (sessions.size >= MAX_SESSIONS) { const oldest = [...sessions.entries()].sort((a, b) => a[1].expires - b[1].expires)[0]; if (oldest) sessions.delete(oldest[0]); }
      const id = randomBytes(32).toString('hex'); const csrf = randomBytes(24).toString('hex'); sessions.set(id, { csrf, expires: now + SESSION_TTL_MS });
      return json(res, 200, { ok: true }, { 'set-cookie': `${COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}` });
    }
    const session = sessionOf(req);
    if (!session) return fail(res, 401, 'LOGIN_REQUIRED');
    if (method === 'GET') {
      switch (path) {
        case '/api/session': return json(res, 200, { csrf: session.csrf, version: SERVICE_VERSION, protocolVersion: PROTOCOL_VERSION, features: { supportBundle: options.supportBundle !== undefined, updateCheck: options.updateCheck !== undefined } });
        case '/api/status': return json(res, 200, buildStatus(context(), { fullId: url.searchParams.get('fullId') === '1' }));
        case '/api/policy': return json(res, 200, policyDocument());
        case '/api/jobs': { const snapshot = options.node.snapshot; return json(res, 200, { active: snapshot.activeJobs, counters: snapshot.counters, slots: snapshot.slots, note: 'Job payloads are never shown or stored here.' }); }
        case '/api/history': return json(res, 200, { points: options.history?.points() ?? [], note: 'Permitted budgets and measured host numbers only; not per-job accounting. Kept on this machine for 24 hours.' });
        case '/api/logs': return json(res, 200, { entries: options.logs.recent(100) });
        case '/api/privacy': return json(res, 200, PRIVACY_STATEMENT);
        default: return fail(res, 404, 'NOT_FOUND');
      }
    }
    // ---- everything below changes something: JSON, this panel's Origin, and the session's CSRF token ----
    if (!allowedOrigins.has((req.headers.origin ?? '').toLowerCase())) return fail(res, 403, 'ORIGIN_NOT_ALLOWED');
    if (!/^application\/json(;|$)/i.test(req.headers['content-type'] ?? '')) return fail(res, 415, 'JSON_REQUIRED');
    const supplied = req.headers['x-csrf-token']; if (typeof supplied !== 'string' || supplied.length !== session.csrf.length || !equalSecret(supplied, session.csrf)) return fail(res, 403, 'CSRF_TOKEN_INVALID');
    let body: unknown; try { body = await readBody(req); } catch (error) {
      const tooLarge = (error as { status?: number }).status === 413;
      // Answer first, then drop the connection (so the client gets a clean 413 and the rest of an oversized upload is never read).
      if (tooLarge) { res.setHeader('connection', 'close'); res.once('finish', () => { req.socket.destroy(); }); }
      return fail(res, tooLarge ? 413 : 400, tooLarge ? 'BODY_TOO_LARGE' : 'BAD_JSON');
    }
    const schema = (candidate: z.ZodType) => { const result = candidate.safeParse(body); return result.success ? result.data : undefined; };
    const invalid = () => fail(res, 400, 'INVALID_REQUEST');
    try {
      switch (path) {
        case '/api/logout': sessions.delete(session.id); return json(res, 200, { ok: true }, { 'set-cookie': `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` });
        case '/api/pause': { const data = schema(PauseBody) as z.infer<typeof PauseBody> | undefined; if (!data) return invalid(); await options.control.pause({ kind: data.kind }); return json(res, 200, { ok: true, pause: options.control.view.pause ?? null }); }
        case '/api/resume': { if (!schema(EmptyBody)) return invalid(); await options.control.resume(); return json(res, 200, { ok: true }); }
        case '/api/policy': {
          const data = schema(PolicyBody) as z.infer<typeof PolicyBody> | undefined; if (!data) return invalid();
          const ctx = { jobSlots: options.jobSlots, capabilities: options.enrolledCapabilities };
          if ('preset' in data) { const result = await options.control.choosePreset(data.preset, ctx); return json(res, 200, { ok: true, findings: result.findings, restartRequired: options.control.view.restartRequired }); }
          if ('reset' in data) { await options.control.resetPolicy(); return json(res, 200, { ok: true }); }
          const parsed = ResourcePolicySchema.safeParse(data.policy);
          if (!parsed.success) return fail(res, 422, 'POLICY_INVALID', { issues: parsed.error.issues.slice(0, 20).map(issue => `${issue.path.join('.') || '(policy)'}: ${issue.message}`.slice(0, 200)) });
          const result = await options.control.savePolicy(parsed.data, ctx); return json(res, 200, { ok: true, findings: result.findings, restartRequired: options.control.view.restartRequired });
        }
        case '/api/name': { const data = schema(NameBody) as z.infer<typeof NameBody> | undefined; if (!data) return invalid(); await options.control.setName(data.name ?? undefined); return json(res, 200, { ok: true }); }
        case '/api/capabilities': { const data = schema(CapabilitiesBody) as z.infer<typeof CapabilitiesBody> | undefined; if (!data) return invalid(); await options.control.setDisabledCapabilities(data.disabled.filter(type => options.enrolledCapabilities.includes(type))); return json(res, 200, { ok: true }); }
        case '/api/doctor': {
          if (!schema(EmptyBody)) return invalid(); if (doctorRunning) return fail(res, 429, 'DOCTOR_BUSY'); doctorRunning = true;
          try { return json(res, 200, await diagnose({ url: options.coordinatorUrl, stateDir: options.stateDir, allowInsecureLoopback: options.env.PRIVANODE_ALLOW_INSECURE_LOOPBACK === 'true', timeoutMs: 8000, env: options.env })); } finally { doctorRunning = false; }
        }
        case '/api/support-bundle': { if (!schema(EmptyBody)) return invalid(); if (!options.supportBundle) return fail(res, 404, 'NOT_FOUND'); return json(res, 200, await options.supportBundle(), { 'content-disposition': 'attachment; filename="privanet-support-bundle.json"' }); }
        case '/api/update/check': { if (!schema(EmptyBody)) return invalid(); if (!options.updateCheck) return fail(res, 404, 'NOT_FOUND'); return json(res, 200, await options.updateCheck()); }
        case '/api/drain': { if (!schema(ConfirmBody)) return invalid(); json(res, 200, { ok: true, message: 'Draining: no new work is accepted, running jobs finish or are handed back, then the node stops. This page stops responding when it has.' }); setImmediate(options.actions.drainAndStop); return; }
        case '/api/restart': { if (!schema(ConfirmBody)) return invalid(); json(res, 200, { ok: true, message: 'Draining, then restarting. A service manager brings the node back; run by hand, the node only stops.' }); setImmediate(options.actions.restart); return; }
        default: return fail(res, 404, 'NOT_FOUND');
      }
    } catch (error) {
      if (error instanceof PolicyError) return fail(res, 422, error.code, { issues: error.issues });
      return fail(res, 500, 'INTERNAL');
    }
  };

  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
  const address = server.address(); const port = typeof address === 'object' && address ? address.port : options.port;
  allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]); allowedOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  const bound = typeof address === 'object' && address ? address.address : '';
  return { port, address: bound, token, close: () => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }) };
}
