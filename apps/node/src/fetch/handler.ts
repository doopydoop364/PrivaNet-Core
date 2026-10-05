import { createHash } from 'node:crypto';
import { FetchOutputSchema } from '@privanet/protocol';
import type { FetchInput, FetchOutput } from '@privanet/protocol';
import type { HandlerContext } from '../handlers.js';
import { parseCidr } from './address.js';
import type { Cidr } from './address.js';
import { digestHtml, digestPlain } from './digest.js';
import type { Digest } from './digest.js';
import { FetchProblem, guardedGet, systemResolver } from './http-client.js';
import type { GetResult, Resolver } from './http-client.js';
import { Limiter } from './politeness.js';
import { evaluate, parseRobots, ROBOTS_MAX_BYTES, RobotsCache } from './robots.js';
import type { RobotsRules, RobotsEntry } from './robots.js';
import { checkUrl } from './url-policy.js';

/** Owner-controlled limits for the fetch capability. A job can only lower these, never raise them. */
export interface FetchPolicy {
  denyHosts: readonly string[]; allowHosts?: readonly string[] | undefined;
  minHostDelayMs: number; maxRequestsPerMinute: number; hardTimeoutMs: number;
  /** Owner-local development escape hatch. Disables SSRF protection for the listed ranges, ports and names. Never set from a job. */
  unsafeLocal?: { allowedCidrs: readonly string[]; allowedPorts: readonly number[]; hostMap: Readonly<Record<string, string>> } | undefined;
}
export interface FetchDeps { policy: FetchPolicy; resolver?: Resolver; clock?: () => number; cache?: RobotsCache; limiter?: Limiter }

const ACCEPT_TYPES = ['text/html', 'application/xhtml+xml', 'text/plain'];
const HARD_MAX_REDIRECTS = 3; const DEFAULT_TIMEOUT = 20000; const HEADER_LIMIT = 16 * 1024; const RESULT_BUDGET = 28000;
const CHARSETS = new Set(['utf-8', 'iso-8859-1', 'windows-1252', 'us-ascii', 'utf-16le', 'utf-16be']);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const contentTypeOf = (value: string | undefined): { type: string; charset?: string } | undefined => {
  if (!value) return undefined; const [type, ...params] = value.split(';'); const charset = params.map(p => p.trim()).find(p => /^charset=/i.test(p))?.slice(8).replace(/^"|"$/g, '').toLowerCase();
  return { type: (type ?? '').trim().toLowerCase(), ...(charset ? { charset } : {}) };
};
const printable = (value: string | undefined, max: number): string | undefined => (value && value.length <= max && /^[\x20-\x7e]+$/.test(value) ? value : undefined);
function decode(body: Buffer, declared: string | undefined): string {
  let label = declared && CHARSETS.has(declared) ? declared : undefined;
  if (!label) { const head = body.subarray(0, 1024).toString('latin1'); const meta = /<meta[^>]+charset\s*=\s*["']?\s*([A-Za-z0-9_-]+)/i.exec(head)?.[1]?.toLowerCase(); label = meta && CHARSETS.has(meta) ? meta : 'utf-8'; }
  return new TextDecoder(label === 'us-ascii' ? 'windows-1252' : label, { fatal: false }).decode(body);
}
const retryAfterSec = (value: string | undefined, now: number): number | undefined => {
  if (!value) return undefined; if (/^\d{1,7}$/.test(value)) return Math.min(86400, Number(value));
  const date = Date.parse(value); return Number.isNaN(date) ? undefined : Math.min(86400, Math.max(0, Math.ceil((date - now) / 1000)));
};
const sameOrigin = (a: URL, b: URL): boolean => a.hostname === b.hostname && ((a.protocol === b.protocol && (a.port || '') === (b.port || '')) || (a.protocol === 'http:' && b.protocol === 'https:' && a.port === '' && b.port === ''));
const originOf = (url: URL): string => `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ''}`;
const robotsDirectives = (header: string | undefined, product: string): { noindex: boolean; nofollow: boolean; noarchive: boolean } => {
  const out = { noindex: false, nofollow: false, noarchive: false }; if (!header) return out;
  for (const part of header.toLowerCase().split(',')) {
    const [maybeAgent, ...rest] = part.split(':'); const agentScoped = rest.length > 0 && /^\s*[a-z0-9_-]+\s*$/.test(maybeAgent ?? '') && !/^\s*(noindex|nofollow|none|noarchive|all)\s*$/.test(maybeAgent ?? '');
    if (agentScoped && (maybeAgent ?? '').trim() !== product.toLowerCase()) continue;
    for (const token of (agentScoped ? rest.join(':') : part).split(/\s+/)) { if (token === 'noindex' || token === 'none') out.noindex = true; if (token === 'nofollow' || token === 'none') out.nofollow = true; if (token === 'noarchive') out.noarchive = true; }
  }
  return out;
};
const problemToResult = (problem: FetchProblem): { outcome: FetchOutput['outcome']; error?: NonNullable<FetchOutput['error']> } => {
  switch (problem.code) {
    case 'BLOCKED': return { outcome: 'BLOCKED_TARGET' };
    case 'TOO_LARGE': return { outcome: 'TOO_LARGE' };
    case 'DNS': return { outcome: 'FETCH_FAILED', error: { code: 'DNS', retryable: true } };
    case 'CONNECT': return { outcome: 'FETCH_FAILED', error: { code: 'CONNECT', retryable: true } };
    case 'TLS': return { outcome: 'FETCH_FAILED', error: { code: 'TLS', retryable: false } };
    case 'TIMEOUT': return { outcome: 'FETCH_FAILED', error: { code: 'TIMEOUT', retryable: true } };
    case 'RESET': return { outcome: 'FETCH_FAILED', error: { code: 'RESET', retryable: true } };
    case 'DECODE': return { outcome: 'FETCH_FAILED', error: { code: 'DECODE', retryable: false } };
    default: return { outcome: 'FETCH_FAILED', error: { code: 'PROTOCOL', retryable: false } };
  }
};

export function createFetchHandler(deps: FetchDeps): (input: FetchInput, context: HandlerContext) => Promise<FetchOutput> {
  const clock = deps.clock ?? Date.now; const policy = deps.policy;
  const allowedCidrs: Cidr[] = (policy.unsafeLocal?.allowedCidrs ?? []).map(text => { const cidr = parseCidr(text); if (!cidr) throw new Error('Invalid unsafeLocal CIDR'); return cidr; });
  const hostMap = policy.unsafeLocal?.hostMap ?? {}; const base = deps.resolver ?? systemResolver;
  const resolver: Resolver = async host => { const mapped = hostMap[host]; return mapped ? [mapped] : base(host); };
  const urlPolicy = { denyHosts: policy.denyHosts, allowHosts: policy.allowHosts, extraPorts: policy.unsafeLocal?.allowedPorts ?? [] };
  const cache = deps.cache ?? new RobotsCache(clock); const limiter = deps.limiter ?? new Limiter(policy.minHostDelayMs, policy.maxRequestsPerMinute, clock);

  return async (input, context) => {
    const startedAt = clock(); const identity = context.client;
    if (!identity) throw new Error('CLIENT_IDENTITY_MISSING'); // the Coordinator refuses to submit or lease without one; this is a second lock
    const userAgent = `${identity.product}/1.0 (+${identity.infoUrl}; via PrivaNet)`;
    const mode = input.mode ?? 'DIGEST'; const totalMs = Math.min(input.timeoutMs ?? DEFAULT_TIMEOUT, policy.hardTimeoutMs);
    const maxRedirects = Math.min(input.maxRedirects ?? HARD_MAX_REDIRECTS, HARD_MAX_REDIRECTS);
    const maxBody = Math.min(input.maxBodyBytes ?? 524288, 1048576); const maxText = Math.min(input.maxTextBytes ?? 10240, 10240); const maxLinks = Math.min(input.maxLinks ?? 100, 100);
    const deadline = startedAt + totalMs; const left = () => Math.max(1, deadline - clock());
    const redirects: Array<{ url: string; status: number }> = []; let robots: FetchOutput['robots'] = { verdict: 'UNAVAILABLE' };
    const finish = (outcome: FetchOutput['outcome'], extra: Partial<FetchOutput> = {}): FetchOutput =>
      fit({ outcome, requestedUrl: input.url, redirects, fetchedAtMs: startedAt, durationMs: Math.min(120000, Math.max(0, clock() - startedAt)), robots, ...extra });
    const timeouts = () => ({ connectMs: Math.min(10000, left()), headersMs: Math.min(15000, left()), idleMs: 10000, totalMs: left() });
    const get = (url: URL, headers: Record<string, string>, wantBody: (h: { status: number; headers: Record<string, string | undefined> }) => boolean, maxBodyBytes: number): Promise<GetResult> =>
      guardedGet({ url, headers, resolver, allowedCidrs, timeouts: timeouts(), maxBodyBytes, maxHeaderBytes: HEADER_LIMIT, signal: context.signal, onBytes: context.transfer, wantBody });

    const first = checkUrl(input.url, urlPolicy); if (!first.ok) return finish('BLOCKED_TARGET');
    const acquired = limiter.tryAcquire(first.host); if (!acquired.ok) return finish('RATE_LIMITED', { retryAfterSec: acquired.retryAfterSec });

    // robots.txt for one origin, cached in memory, fetched through the same guarded client.
    const robotsFor = async (target: URL): Promise<{ rules?: RobotsRules; problem?: FetchProblem; unavailable?: boolean; httpStatus?: number; retryAfterSec?: number; error?: FetchOutput['error'] }> => {
      const origin = originOf(target); const hit = cache.get(origin);
      if (hit) return hit.kind === 'RULES' ? { rules: hit.rules } : hit.kind === 'UNAVAILABLE' ? { unavailable: true, ...(hit.httpStatus === undefined ? {} : { httpStatus: hit.httpStatus }), ...(hit.retryAfterSec === undefined ? {} : { retryAfterSec: hit.retryAfterSec }), ...(hit.error ? { error: hit.error } : {}) } : {};
      const robotsUrl = new URL('/robots.txt', origin); let current = robotsUrl;
      const failure: Extract<RobotsEntry, { kind: 'UNAVAILABLE' }> = { kind: 'UNAVAILABLE', fetchedAt: clock() };
      try {
        for (let hop = 0; hop <= HARD_MAX_REDIRECTS; hop++) {
          const res = await get(current, { 'User-Agent': userAgent, Accept: 'text/plain,*/*;q=0.1', 'Accept-Encoding': 'gzip, br' }, h => h.status >= 200 && h.status < 300, ROBOTS_MAX_BYTES);
          failure.httpStatus = res.status;
          const after = retryAfterSec(res.headers['retry-after'], clock()); if (after !== undefined) failure.retryAfterSec = after;
          if (REDIRECT_STATUSES.has(res.status) && res.headers.location) {
            let next: URL; try { next = new URL(res.headers.location, current); } catch { failure.error = { code: 'PROTOCOL', retryable: false }; break; }
            const checked = checkUrl(next.toString(), urlPolicy); if (!checked.ok || !sameOrigin(current, checked.url)) { failure.error = { code: 'PROTOCOL', retryable: false }; break; } current = checked.url; continue;
          }
          if (res.status >= 200 && res.status < 300) { const rules = parseRobots(decode(res.body, undefined)); cache.set(origin, { kind: 'RULES', rules, fetchedAt: clock() }); return { rules }; }
          if (res.status === 429) break; // a rate limit is a request to wait, never permission to fetch the page
          if (res.status >= 400 && res.status < 500) { cache.set(origin, { kind: 'ALLOW_ALL', fetchedAt: clock() }); return {}; } // RFC 9309: unavailable client error means no restrictions
          if (res.status < 500) failure.error = { code: 'PROTOCOL', retryable: false };
          break; // 5xx and anything else: unreachable
        }
      } catch (error) {
        if (error instanceof FetchProblem) {
          if (error.code === 'BLOCKED' || error.code === 'DNS') return { problem: error };
          failure.error = { code: error.code === 'TOO_LARGE' ? 'PROTOCOL' : error.code, retryable: !['TLS', 'DECODE', 'PROTOCOL', 'TOO_LARGE'].includes(error.code) };
        } else throw error; // an abort is rethrown so the job is released
      }
      if (!failure.error && (failure.httpStatus ?? 0) < 500) failure.error = { code: 'PROTOCOL', retryable: false };
      failure.fetchedAt = clock(); cache.set(origin, failure);
      return { unavailable: true, ...(failure.httpStatus === undefined ? {} : { httpStatus: failure.httpStatus }), ...(failure.retryAfterSec === undefined ? {} : { retryAfterSec: failure.retryAfterSec }), ...(failure.error ? { error: failure.error } : {}) };
    };
    const consult = async (target: URL): Promise<FetchOutput | undefined> => {
      const found = await robotsFor(target);
      if (found.problem) { if (found.problem.code === 'DNS') return finish('FETCH_FAILED', { error: { code: 'DNS', retryable: true } }); return finish('BLOCKED_TARGET'); }
      if (found.unavailable && found.httpStatus === 429) return finish('RATE_LIMITED', { retryAfterSec: found.retryAfterSec ?? 60 });
      if (found.unavailable) { robots = { verdict: 'UNAVAILABLE' }; return finish('ROBOTS_UNAVAILABLE', { ...(found.httpStatus === undefined ? {} : { httpStatus: found.httpStatus }), ...(found.retryAfterSec === undefined ? {} : { retryAfterSec: found.retryAfterSec }), ...(found.error ? { error: found.error } : {}) }); }
      const entry = cache.get(originOf(target)); const sha = entry?.kind === 'RULES' ? entry.rules.sha256 : undefined;
      const decision = found.rules ? evaluate(found.rules, identity.product, `${target.pathname}${target.search}`) : { allowed: true };
      robots = { verdict: decision.allowed ? 'ALLOWED' : 'DISALLOWED', ...(entry ? { fetchedAtMs: entry.fetchedAt } : {}), ...(sha ? { sha256: sha } : {}), ...('crawlDelaySec' in decision && decision.crawlDelaySec !== undefined ? { crawlDelaySec: decision.crawlDelaySec } : {}) };
      if ('crawlDelaySec' in decision && decision.crawlDelaySec) limiter.raiseDelay(target.hostname, Math.min(30, decision.crawlDelaySec) * 1000);
      return decision.allowed ? undefined : finish('ROBOTS_DISALLOWED');
    };

    try {
      let current = first.url; const visited = new Set<string>([current.toString()]);
      let consulted = ''; let response: GetResult | undefined;
      for (let hop = 0; hop <= maxRedirects; hop++) {
        const origin = originOf(current);
        if (origin !== consulted) { const refused = await consult(current); if (refused) return refused; consulted = origin; }
        const headers: Record<string, string> = { 'User-Agent': userAgent, Accept: 'text/html,application/xhtml+xml;q=0.9,text/plain;q=0.5', 'Accept-Encoding': 'gzip, br' };
        if (hop === 0 && input.validators?.etag) headers['If-None-Match'] = input.validators.etag;
        if (hop === 0 && input.validators?.lastModified) headers['If-Modified-Since'] = input.validators.lastModified;
        response = await get(current, headers, h => mode === 'DIGEST' && h.status >= 200 && h.status < 300 && ACCEPT_TYPES.includes(contentTypeOf(h.headers['content-type'])?.type ?? ''), maxBody);
        if (!REDIRECT_STATUSES.has(response.status) || !response.headers.location) break;
        let target: URL; try { target = new URL(response.headers.location, current); } catch { return finish('FETCH_FAILED', { httpStatus: response.status, error: { code: 'PROTOCOL', retryable: false } }); }
        const checked = checkUrl(target.toString(), urlPolicy); if (!checked.ok) return finish('BLOCKED_TARGET', { httpStatus: response.status });
        if (!sameOrigin(current, checked.url)) return finish('REDIRECT', { httpStatus: response.status, redirectTarget: checked.url.toString() }); // the application decides whether to follow
        if (visited.has(checked.url.toString())) return finish('FETCH_FAILED', { httpStatus: response.status, error: { code: 'PROTOCOL', retryable: false } }); // redirect loop
        if (hop === maxRedirects) return finish('REDIRECT', { httpStatus: response.status, redirectTarget: checked.url.toString() });
        redirects.push({ url: checked.url.toString(), status: response.status }); visited.add(checked.url.toString()); current = checked.url; response = undefined;
      }
      if (!response) return finish('FETCH_FAILED', { error: { code: 'PROTOCOL', retryable: false } });
      const head = { httpStatus: response.status, finalUrl: current.toString() };
      const type = contentTypeOf(response.headers['content-type']);
      const validators = { ...(printable(response.headers.etag, 200) ? { etag: printable(response.headers.etag, 200) as string } : {}), ...(printable(response.headers['last-modified'], 40) ? { lastModified: printable(response.headers['last-modified'], 40) as string } : {}) };
      if (response.status === 304) return finish('NOT_MODIFIED', { ...head, ...validators });
      if (response.status >= 400) { const after = retryAfterSec(response.headers['retry-after'], clock()); return finish('HTTP_ERROR', { ...head, ...(after === undefined ? {} : { retryAfterSec: after }) }); }
      if (response.status < 200 || response.status >= 300) return finish('FETCH_FAILED', { ...head, error: { code: 'PROTOCOL', retryable: false } });
      if (mode === 'PROBE') return finish('PROBED', { ...head, ...validators, ...(type ? { contentType: type.type } : {}) });
      if (!type || !ACCEPT_TYPES.includes(type.type)) return finish('UNSUPPORTED_CONTENT_TYPE', { ...head, ...(type ? { contentType: type.type.slice(0, 100) } : {}) });
      const text = decode(response.body, type.charset);
      const digest: Digest = type.type === 'text/plain' ? digestPlain(text, { maxTextBytes: maxText }) : digestHtml(text, current.toString(), { maxTextBytes: maxText, maxLinks });
      const header = robotsDirectives(response.headers['x-robots-tag'], identity.product);
      const indexing = { noindex: digest.noindex || header.noindex, nofollow: digest.nofollow || header.nofollow, noarchive: digest.noarchive || header.noarchive };
      const language = digest.language ?? printable(response.headers['content-language']?.split(',')[0]?.trim(), 35);
      return finish('FETCHED', {
        ...head, ...validators, contentType: type.type, ...(type.charset && CHARSETS.has(type.charset) ? { charset: type.charset } : {}), bodyBytes: response.body.length, bodyTruncated: response.bodyTruncated,
        contentSha256: response.bodySha256 ?? createHash('sha256').update(response.body).digest('hex'), indexing,
        page: { ...(digest.title ? { title: digest.title } : {}), ...(digest.description ? { description: digest.description } : {}), ...(digest.canonicalUrl ? { canonicalUrl: digest.canonicalUrl } : {}), ...(language ? { language } : {}),
          ...(indexing.noindex ? {} : { text: digest.text, textTruncated: digest.textTruncated }), links: indexing.nofollow ? [] : digest.links, linksTruncated: digest.linksTruncated },
      });
    } catch (error) {
      if (error instanceof FetchProblem) { const mapped = problemToResult(error); return finish(mapped.outcome, mapped.error ? { error: mapped.error } : {}); }
      throw error; // aborts (preemption, shutdown) and bugs propagate: the node releases or fails the job
    }
  };
}

/** Trims links (last first) and then text until the serialized result fits the completion-body budget, then validates it. */
function fit(result: FetchOutput): FetchOutput {
  const page = result.page ? { ...result.page, links: [...result.page.links] } : undefined; const out: FetchOutput = page ? { ...result, page } : result;
  const size = () => Buffer.byteLength(JSON.stringify(out));
  while (page && size() > RESULT_BUDGET && page.links.length > 0) { page.links.pop(); page.linksTruncated = true; }
  while (page?.text && size() > RESULT_BUDGET && page.text.length > 0) { page.text = page.text.slice(0, Math.floor(page.text.length * 0.9)); page.textTruncated = true; }
  return FetchOutputSchema.parse(out);
}
