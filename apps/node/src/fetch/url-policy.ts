import type { Cidr } from './address.js';
import { isIP } from 'node:net';

/**
 * URL admission for the fetch capability. This is the authoritative check, applied before any network access and
 * again to every redirect hop; an application's own filtering is a courtesy, not a boundary.
 */
export type UrlRejection = 'TOO_LONG' | 'CONTROL_CHARS' | 'MALFORMED' | 'SCHEME' | 'CREDENTIALS' | 'IP_LITERAL' | 'INTERNAL_HOST' | 'PORT' | 'DENIED_HOST' | 'NOT_ALLOWED_HOST';
export interface UrlPolicy {
  denyHosts: readonly string[]; allowHosts?: readonly string[] | undefined;
  /** Owner-local development escape hatch; empty in normal operation. */
  extraPorts: readonly number[];
}
export type Checked = { ok: true; url: URL; host: string; port: number } | { ok: false; reason: UrlRejection };
const INTERNAL_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home.arpa', '.localdomain', '.intranet', '.corp'];
const hostMatches = (host: string, entry: string): boolean => host === entry || host.endsWith(`.${entry}`);

export function checkUrl(raw: string, policy: UrlPolicy): Checked {
  if (raw.length > 2048) return { ok: false, reason: 'TOO_LONG' };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000- \u007f\\]/.test(raw)) return { ok: false, reason: 'CONTROL_CHARS' };
  let url: URL; try { url = new URL(raw); } catch { return { ok: false, reason: 'MALFORMED' }; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, reason: 'SCHEME' };
  if (url.username !== '' || url.password !== '') return { ok: false, reason: 'CREDENTIALS' };
  let host = url.hostname.toLowerCase(); if (host.endsWith('.')) host = host.slice(0, -1);
  // The WHATWG parser folds 0x7f.1, 2130706433 and octal forms into dotted decimal, so isIP plus the digits test cover all of them.
  if (host.startsWith('[') || host.includes(':') || isIP(host) !== 0 || /^[\d.]+$/.test(host) || /^0x[0-9a-f]+$/i.test(host)) return { ok: false, reason: 'IP_LITERAL' };
  if (!host.includes('.') || host === 'localhost' || INTERNAL_SUFFIXES.some(suffix => host.endsWith(suffix))) return { ok: false, reason: 'INTERNAL_HOST' };
  const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);
  // Only the scheme's own default port, plus any port the owner explicitly listed for local development.
  const defaultPort = url.protocol === 'https:' ? 443 : 80;
  if (port !== defaultPort && !policy.extraPorts.includes(port)) return { ok: false, reason: 'PORT' };
  if (policy.denyHosts.some(entry => hostMatches(host, entry.toLowerCase()))) return { ok: false, reason: 'DENIED_HOST' };
  if (policy.allowHosts && !policy.allowHosts.some(entry => hostMatches(host, entry.toLowerCase()))) return { ok: false, reason: 'NOT_ALLOWED_HOST' };
  url.hash = ''; url.hostname = host;
  return { ok: true, url, host, port };
}
export type { Cidr };
