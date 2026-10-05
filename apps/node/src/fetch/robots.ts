import { createHash } from 'node:crypto';

/**
 * A small, deterministic, bounded robots.txt implementation of RFC 9309: user-agent groups, Allow and Disallow with
 * `*` and `$`, longest-match wins with Allow beating Disallow on a tie, and Crawl-delay as a hint. It is not a policy
 * engine: it answers only "may this URL be fetched by this product token". The file is parsed only up to a size cap.
 */
export const ROBOTS_MAX_BYTES = 500 * 1024;
export interface Rule { allow: boolean; pattern: string }
export interface Group { agents: string[]; rules: Rule[]; crawlDelay?: number }
export interface RobotsRules { groups: Group[]; sha256: string }

export function parseRobots(text: string): RobotsRules {
  const groups: Group[] = []; let current: Group | undefined; let lastWasAgent = false;
  const lines = text.slice(0, ROBOTS_MAX_BYTES).split(/\r\n|\r|\n/).slice(0, 10000);
  for (const raw of lines) {
    const line = raw.slice(0, 4096).replace(/#.*$/, '').trim(); if (!line) continue;
    const colon = line.indexOf(':'); if (colon < 1) continue;
    const key = line.slice(0, colon).trim().toLowerCase(); const value = line.slice(colon + 1).trim();
    if (key === 'user-agent') {
      if (!current || !lastWasAgent) { current = { agents: [], rules: [] }; groups.push(current); }
      current.agents.push(value.toLowerCase()); lastWasAgent = true; continue;
    }
    lastWasAgent = false; if (!current) continue;
    if (key === 'allow' || key === 'disallow') { if (value !== '') current.rules.push({ allow: key === 'allow', pattern: value }); else if (key === 'allow') continue; }
    else if (key === 'crawl-delay') { const delay = Number(value); if (Number.isFinite(delay) && delay >= 0) current.crawlDelay = Math.min(delay, 300); }
  }
  return { groups, sha256: createHash('sha256').update(text.slice(0, ROBOTS_MAX_BYTES)).digest('hex') };
}
/** The most specific group for the product token, else the `*` group, else no group (everything allowed). */
function groupFor(rules: RobotsRules, product: string): Group | undefined {
  const token = product.toLowerCase(); const matching = rules.groups.filter(group => group.agents.some(agent => agent !== '*' && (token === agent || token.startsWith(agent))));
  const exact = matching.length ? matching : rules.groups.filter(group => group.agents.includes('*'));
  if (exact.length === 0) return undefined;
  return { agents: [], rules: exact.flatMap(group => group.rules), ...(exact.some(g => g.crawlDelay !== undefined) ? { crawlDelay: Math.max(...exact.map(g => g.crawlDelay ?? 0)) } : {}) };
}
function matches(pattern: string, path: string): number {
  // Returns the match length (specificity) or -1. `*` matches any run of characters, a trailing `$` anchors the end.
  const anchored = pattern.endsWith('$'); const body = anchored ? pattern.slice(0, -1) : pattern;
  const parts = body.split('*'); let position = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] ?? '';
    if (i === 0) { if (!path.startsWith(part)) return -1; position = part.length; continue; }
    const found = path.indexOf(part, position); if (found < 0) return -1; position = found + part.length;
  }
  if (anchored && position !== path.length && !(parts.length === 1 && path === body)) {
    // With an anchor the last literal part must end the path.
    const last = parts[parts.length - 1] ?? ''; if (!path.endsWith(last)) return -1;
  }
  return body.length;
}
export interface Decision { allowed: boolean; crawlDelaySec?: number }
export function evaluate(rules: RobotsRules, product: string, pathAndQuery: string): Decision {
  const group = groupFor(rules, product); if (!group) return { allowed: true };
  let best: { length: number; allow: boolean } | undefined;
  for (const rule of group.rules) {
    const length = matches(rule.pattern, pathAndQuery); if (length < 0) continue;
    if (!best || length > best.length || (length === best.length && rule.allow && !best.allow)) best = { length, allow: rule.allow };
  }
  return { allowed: best ? best.allow : true, ...(group.crawlDelay === undefined ? {} : { crawlDelaySec: group.crawlDelay }) };
}

export type RobotsEntry = { kind: 'RULES'; rules: RobotsRules; fetchedAt: number } | { kind: 'ALLOW_ALL'; fetchedAt: number; sha256?: string } | { kind: 'UNAVAILABLE'; fetchedAt: number; httpStatus?: number; retryAfterSec?: number; error?: { code: 'CONNECT' | 'TLS' | 'TIMEOUT' | 'RESET' | 'PROTOCOL' | 'DECODE'; retryable: boolean } };
/** In-memory, bounded (LRU by insertion order), time-limited. Nothing is written to disk. */
export class RobotsCache {
  private readonly map = new Map<string, RobotsEntry>();
  constructor(private readonly clock: () => number = Date.now, private readonly maxEntries = 1000, private readonly ttlMs = 24 * 3600 * 1000, private readonly unavailableTtlMs = 60 * 1000) {}
  get(origin: string): RobotsEntry | undefined {
    const entry = this.map.get(origin); if (!entry) return undefined;
    const ttl = entry.kind === 'UNAVAILABLE' ? this.unavailableTtlMs : this.ttlMs;
    if (this.clock() - entry.fetchedAt > ttl) { this.map.delete(origin); return undefined; }
    this.map.delete(origin); this.map.set(origin, entry); return entry; // refresh recency
  }
  set(origin: string, entry: RobotsEntry): void {
    this.map.delete(origin); this.map.set(origin, entry);
    while (this.map.size > this.maxEntries) { const oldest = this.map.keys().next().value; if (oldest === undefined) break; this.map.delete(oldest); }
  }
  get size(): number { return this.map.size; }
}
