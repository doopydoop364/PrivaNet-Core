import { arch, homedir, platform, release, userInfo } from 'node:os';
import { basename } from 'node:path';
import { PROTOCOL_VERSION, SERVICE_VERSION } from '@privanet/protocol';
import { DEFAULT_PANEL_PORT } from './panel-token.js';
import type { ResolvedPolicy } from './policy-store.js';
import type { LocalState } from './local-state.js';
import { activePause } from './local-state.js';
import type { DoctorReport } from './doctor.js';
import type { LogEntry } from './log-ring.js';
import { detectPreset } from './presets.js';

/**
 * A troubleshooting bundle the owner creates on purpose and reads before sharing. It is built from an allowlist of structured facts, never from the raw environment or whole files, and then
 * every string in it goes through `redact`. As a last line of defence a final scan refuses to produce a bundle if anything secret-shaped is still in it. Secret shapes covered: private keys
 * (PEM), bearer tokens and authorization/cookie headers, 64-character hexadecimal values (enrollment tokens, admin and panel secrets, session ids), long base64 blobs (keys), JWTs, short
 * invite and request codes, URLs with credentials, e-mail addresses, and `name=value` pairs whose name says token, secret, password, key or credential.
 */
export const REDACTION_RULES: Array<{ kind: string; pattern: RegExp; replace: string | ((match: string, ...groups: string[]) => string) }> = [
  { kind: 'private-key', pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, replace: '[REDACTED:PRIVATE-KEY]' },
  { kind: 'pem-block', pattern: /-----BEGIN [A-Z0-9 ]+-----[\s\S]*?(?:-----END [A-Z0-9 ]+-----|$)/g, replace: '[REDACTED:PEM]' },
  { kind: 'authorization-header', pattern: /\b(authorization|proxy-authorization|cookie|set-cookie|x-csrf-token|x-api-key|x-auth-token)\b(["']?\s*[:=]\s*["']?)[^\n\r"']+/gi, replace: (_m, name: string, sep: string) => `${name}${sep}[REDACTED]` },
  { kind: 'bearer', pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, replace: 'Bearer [REDACTED]' },
  { kind: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, replace: '[REDACTED:JWT]' },
  { kind: 'url-credentials', pattern: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]*@/gi, replace: (_m, scheme: string) => `${scheme}[REDACTED]@` },
  { kind: 'secret-assignment', pattern: /\b([A-Za-z0-9_.-]*(?:token|secret|password|passwd|passphrase|credential|apikey|api_key|private_?key|session)[A-Za-z0-9_.-]*)(["']?\s*[:=]\s*\\?["']?)(?!\[REDACTED)[^\s,;"'}\\]{1,}/gi, replace: (_m, name: string, sep: string) => `${name}${sep}[REDACTED]` },
  { kind: 'known-token-prefix', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b|\bnpm_[A-Za-z0-9]{20,}\b|\bxox[abprs]-[A-Za-z0-9-]{10,}\b|\b[sr]k_(?:live|test)_[A-Za-z0-9]{10,}\b|\bAIza[0-9A-Za-z_-]{30,}\b/g, replace: '[REDACTED:TOKEN]' },
  { kind: 'hex-secret', pattern: /\b[a-fA-F0-9]{32,}\b/g, replace: '[REDACTED:HEX]' },
  { kind: 'base64-blob', pattern: /(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/_-]{40,}={0,2}(?![A-Za-z0-9+/_-])/g, replace: '[REDACTED:BLOB]' },
  { kind: 'short-code', pattern: /\b[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}\b/g, replace: '[REDACTED:CODE]' },
  { kind: 'email', pattern: /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, replace: '[REDACTED:EMAIL]' },
];
export interface RedactionCounts { [kind: string]: number }
/** Applies every rule to a string (and replaces this machine's home directory and user name), counting what it removed. */
export function redact(text: string, counts: RedactionCounts = {}): string {
  let out = text;
  for (const rule of REDACTION_RULES) {
    out = out.replace(rule.pattern, (...args: unknown[]) => { counts[rule.kind] = (counts[rule.kind] ?? 0) + 1; const groups = args.slice(0, -2) as string[]; return typeof rule.replace === 'string' ? rule.replace : rule.replace(groups[0] ?? '', ...groups.slice(1)); });
  }
  const home = (() => { try { return homedir(); } catch { return ''; } })(); const user = (() => { try { return userInfo().username; } catch { return ''; } })();
  if (home.length > 1) out = out.split(home).join('~');
  if (user.length > 2) out = out.replace(new RegExp(`(?<![A-Za-z0-9_])${user.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_])`, 'g'), '<user>');
  return out;
}
/** True if something secret-shaped is still present. The bundle refuses to be produced if so (the redaction rules have a gap, and that must be fixed, not shipped). */
export function looksSecret(text: string): string | undefined {
  for (const rule of REDACTION_RULES) { rule.pattern.lastIndex = 0; const match = rule.pattern.exec(text); rule.pattern.lastIndex = 0; if (match && !/^\[REDACTED/.test(match[0]) && !/\[REDACTED/.test(match[0])) return rule.kind; }
  return undefined;
}
const SECRET_KEY = /(token|secret|password|passwd|passphrase|credential|api_?key|private_?key|authorization|cookie|csrf)/i;
/** Redacts every string in a JSON-safe value (so the structure stays valid), and any string under a key whose name says it is a secret. */
export function redactDeep(value: unknown, counts: RedactionCounts, key = ''): unknown {
  if (typeof value === 'string') { if (key && SECRET_KEY.test(key)) { counts['secret-key-name'] = (counts['secret-key-name'] ?? 0) + 1; return '[REDACTED]'; } return redact(value, counts); }
  if (Array.isArray(value)) return value.map(item => redactDeep(item, counts, key));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([name, item]) => [redact(name, counts), redactDeep(item, counts, name)]));
  return value;
}
export class UnsafeBundleError extends Error { constructor(readonly kind: string) { super(`secret-shaped content (${kind}) survived redaction`); this.name = 'UnsafeBundleError'; } }

const SAFE_PLAIN = ['PRIVANODE_ALLOW_INSECURE_LOOPBACK', 'PRIVANODE_JOB_SLOTS', 'PRIVANODE_HEARTBEAT_MS', 'PRIVANODE_POLL_MS', 'PRIVANODE_DRAIN_TIMEOUT_MS', 'PRIVANODE_LEASE_WAIT_MS', 'PRIVANODE_CAPABILITIES', 'PRIVANODE_PANEL', 'PRIVANODE_PANEL_PORT'] as const;
/** Sanitized view of the node's settings: plain values only for settings that cannot hold a secret; an address as scheme and host only; paths as file names; secrets as "set" or "not set". */
export function sanitizedConfig(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of SAFE_PLAIN) if (env[name] !== undefined) out[name] = String(env[name]).slice(0, 120);
  if (env.PRIVANODE_COORDINATOR_URL !== undefined) { try { const url = new URL(env.PRIVANODE_COORDINATOR_URL); out.PRIVANODE_COORDINATOR_URL = `${url.protocol}//${url.host}`; } catch { out.PRIVANODE_COORDINATOR_URL = '(set, not a valid address)'; } }
  for (const name of ['PRIVANODE_STATE_DIR', 'PRIVANODE_POLICY_FILE', 'NODE_EXTRA_CA_CERTS'] as const) if (env[name] !== undefined) out[name] = `(set; file name ${basename(String(env[name]))})`;
  // Whether enrollment material is sitting in the environment is worth knowing; its value never is. (Labelled without the words the redaction rules look for.)
  out.enrollmentMaterialInEnvironment = env.PRIVANODE_ENROLLMENT_TOKEN || env.PRIVANODE_INVITE_CODE ? 'yes, value never included' : 'no';
  return out;
}
export function sanitizedPolicy(resolved: ResolvedPolicy) {
  const { fetch, ...rest } = resolved.policy;
  return { source: resolved.source.kind === 'defaults' ? 'defaults' : `${resolved.source.kind}`, preset: detectPreset(resolved.policy), problem: resolved.problem ? { code: resolved.problem.code } : null,
    policy: { ...rest, fetch: { denyHostsCount: fetch.denyHosts.length, allowHostsCount: fetch.allowHosts?.length ?? null, minHostDelayMs: fetch.minHostDelayMs, maxRequestsPerMinute: fetch.maxRequestsPerMinute, hardTimeoutMs: fetch.hardTimeoutMs, unsafeLocal: fetch.unsafeLocal ? 'PRESENT (SSRF protection relaxed by the owner)' : 'absent' } } };
}

export interface BundleInput {
  env: NodeJS.ProcessEnv; now?: number;
  policy: ResolvedPolicy; local: LocalState; localProblem?: string | undefined;
  /** The status document (already sanitized at its source) from the running node, if there is one. */
  status?: Record<string, unknown> | undefined; doctor?: DoctorReport | undefined;
  logs?: LogEntry[] | undefined; logText?: string | undefined;
}
/** The bundle as a JSON-safe object, redacted and checked. Throws `UnsafeBundleError` instead of returning anything that still looks secret. */
export function buildSupportBundle(input: BundleInput): Record<string, unknown> {
  const now = input.now ?? Date.now(); const counts: RedactionCounts = {};
  const raw = {
    bundleVersion: 1, generatedAt: new Date(now).toISOString(),
    readMeFirst: 'This file was created because you asked for it. It contains no private key, token, authorization header or secret, but read it before you share it. Nothing in it is sent anywhere by PrivaNet.',
    software: { privanode: SERVICE_VERSION, protocol: PROTOCOL_VERSION, node: process.version, platform: platform(), arch: arch(), osRelease: release() },
    configuration: sanitizedConfig(input.env), panel: { defaultPort: DEFAULT_PANEL_PORT, enabled: input.env.PRIVANODE_PANEL !== 'off' },
    policy: sanitizedPolicy(input.policy),
    localChoices: { hasLocalName: input.local.name !== undefined, pause: activePause(input.local.pause, now)?.kind ?? null, disabledCapabilities: input.local.disabledCapabilities, problem: input.localProblem ?? null },
    status: input.status ?? null, doctor: input.doctor ?? null,
    recentEvents: (input.logs ?? []).slice(-200).map(entry => ({ at: new Date(entry.at).toISOString(), event: entry.event, ...(entry.code ? { code: entry.code } : {}), ...(entry.reason ? { reason: entry.reason } : {}) })),
    logTail: input.logText === undefined ? null : input.logText.slice(-120000).split('\n').slice(-400),
  };
  const cleaned = redactDeep(JSON.parse(JSON.stringify(raw)), counts) as Record<string, unknown>;
  const verdict = looksSecret(JSON.stringify(cleaned));
  if (verdict) throw new UnsafeBundleError(verdict);
  cleaned.removedFromThisBundle = counts;
  return cleaned;
}
