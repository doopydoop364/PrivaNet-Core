import { ApiError } from '@privanet/shared';
import { BindingChangedError } from './identity.js';

const TLS_CODES = new Set(['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_UNTRUSTED', 'HOSTNAME_MISMATCH']);
const REASONS: Record<string, string> = { ECONNREFUSED: 'CONNECTION_REFUSED', ENOTFOUND: 'DNS', EAI_AGAIN: 'DNS', ETIMEDOUT: 'TIMEOUT', UND_ERR_CONNECT_TIMEOUT: 'TIMEOUT',
  EHOSTUNREACH: 'UNREACHABLE', ENETUNREACH: 'UNREACHABLE', ECONNRESET: 'CONNECTION_RESET', UND_ERR_SOCKET: 'CONNECTION_RESET', EPIPE: 'CONNECTION_RESET' };

/**
 * What the operator's log says about a failed Coordinator connection: the API error code, or TRANSPORT_ERROR with a reason from a fixed vocabulary
 * (TLS_CERTIFICATE, DNS, CONNECTION_REFUSED, TIMEOUT, UNREACHABLE, CONNECTION_RESET, OTHER). Never a message, address, URL or credential, so a log line is safe to paste.
 */
export function connectionFailure(error: unknown): { code: string; reason?: string } {
  if (error instanceof ApiError) return { code: error.code };
  if (error instanceof BindingChangedError) return { code: 'COORDINATOR_BINDING_CHANGED' };
  const cause: unknown = error instanceof Error ? error.cause : undefined;
  const causeCode = cause instanceof Error && 'code' in cause ? String(cause.code) : '';
  if (TLS_CODES.has(causeCode) || causeCode.startsWith('ERR_SSL_') || causeCode.startsWith('ERR_TLS_')) return { code: 'TRANSPORT_ERROR', reason: 'TLS_CERTIFICATE' };
  if (REASONS[causeCode]) return { code: 'TRANSPORT_ERROR', reason: REASONS[causeCode] };
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) return { code: 'TRANSPORT_ERROR', reason: 'TIMEOUT' };
  return { code: 'TRANSPORT_ERROR', reason: 'OTHER' };
}
