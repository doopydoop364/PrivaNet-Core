import {
  ChallengeSchema, EnrollmentStartSchema, HealthSchema, JOB_TYPE_IDS, NodeSelfSchema, PROTOCOL_VERSION, SERVICE_VERSION, SessionSchema,
} from '@privanet/protocol';
import type { JobType } from '@privanet/protocol';
import { ApiError, Transport } from '@privanet/shared';
import { ZodError } from 'zod';
import { BindingChangedError, bindCoordinator, loadIdentity, signProof } from './identity.js';
import { connectionFailure } from './failure.js';
import { readEnrollmentRecord, writeEnrollmentRecord } from './enrollment-record.js';

export interface EnrollOptions {
  /** Coordinator address: `https://host[:port]` (plain http only to a literal loopback address, and only with `allowInsecureLoopback`). */
  url: string; stateDir: string; allowInsecureLoopback?: boolean;
  /** The one-time enrollment token. It is sent to the Coordinator and kept nowhere. */
  token: string;
  /** Capabilities to enroll with; omitted means every capability the token grants. */
  capabilities?: JobType[];
}
export type EnrollFailure =
  /** The token is unknown, used, expired or revoked (the Coordinator deliberately does not say which). */
  | 'TOKEN_REFUSED'
  /** The token does not grant a capability that was asked for. */
  | 'CAPABILITY_FORBIDDEN'
  /** Too many refused attempts from this address; wait a minute. */
  | 'RATE_LIMITED'
  /** This node's identity is already registered at the Coordinator but is not usable (it was revoked); a new identity needs a fresh state directory. */
  | 'IDENTITY_UNUSABLE'
  /** This state directory was set up for a different Coordinator. */
  | 'COORDINATOR_CHANGED'
  | 'PROTOCOL_MISMATCH' | 'UNREACHABLE' | 'COORDINATOR_ERROR';
/** Carries a failure class and a fixed, plain-language reason; never the token, the address or a credential. */
export class EnrollError extends Error {
  constructor(readonly failure: EnrollFailure, message: string, readonly detail?: string) { super(message); }
}
export interface EnrollResult {
  /** ENROLLED: this call enrolled the node. ALREADY_ENROLLED: the node was already known and usable, and the token was not used. */
  outcome: 'ENROLLED' | 'ALREADY_ENROLLED'; nodeId: string; coordinatorId: string; capabilities: JobType[]; displayName?: string;
}

/**
 * Enrolls this machine with a Coordinator using the existing, proven flow: the node makes (or reuses) its own Ed25519 identity, presents the one-time token, and proves it
 * holds the private key. The private key never leaves the machine, so there is no long-lived secret for the Coordinator to hand back: the identity file IS the node's
 * credential, and every later session is obtained by signing a fresh challenge. On success the Coordinator address and the node's identity are recorded in
 * `enrollment.json`, which is what lets `privanet-node` start later with no configuration and no token.
 */
export async function enrollNode(options: EnrollOptions): Promise<EnrollResult> {
  const transport = new Transport({ url: options.url, ...(options.allowInsecureLoopback ? { allowInsecureLoopback: true } : {}) });
  const identity = await loadIdentity(options.stateDir);
  try {
    let health;
    try { health = await transport.request('GET', '/v1/health', HealthSchema); }
    catch (error) {
      if (error instanceof ZodError) throw new EnrollError('PROTOCOL_MISMATCH', 'This Coordinator speaks a protocol version this node does not support.');
      throw error;
    }
    await bindCoordinator(options.stateDir, transport.origin, health.coordinatorId);
    const existing = await readEnrollmentRecord(options.stateDir);
    // Already known and usable? Then there is nothing to do and the token is left untouched.
    try {
      await transport.request('POST', '/v1/auth/challenge', ChallengeSchema, { nodeId: identity.nodeId, protocolVersion: PROTOCOL_VERSION });
      return { outcome: 'ALREADY_ENROLLED', nodeId: identity.nodeId, coordinatorId: health.coordinatorId, capabilities: existing?.capabilities ?? [] };
    } catch (error) { if (!(error instanceof ApiError) || error.status !== 401) throw error; }

    const capabilities = options.capabilities;
    if (capabilities?.some(capability => !JOB_TYPE_IDS.includes(capability))) throw new EnrollError('CAPABILITY_FORBIDDEN', 'This node does not support one of the requested capabilities.');
    const challenge = await transport.request('POST', '/v1/enrollment/challenge', ChallengeSchema, EnrollmentStartSchema.parse({
      token: options.token, publicKey: identity.publicKey, protocolVersion: PROTOCOL_VERSION, daemonVersion: SERVICE_VERSION, ...(capabilities ? { capabilities } : {}),
    }));
    const session = await transport.request('POST', '/v1/enrollment/proof', SessionSchema, signProof(identity, challenge, health.coordinatorId, 'enroll'));
    if (session.nodeId !== identity.nodeId || session.coordinatorId !== health.coordinatorId) throw new EnrollError('COORDINATOR_ERROR', 'The Coordinator answered with a different identity than expected.');
    // Learn what was actually granted (it is the token's capabilities when none were named).
    const self = await transport.request('GET', '/v1/node/self', NodeSelfSchema, undefined, session.token);
    await writeEnrollmentRecord(options.stateDir, { version: 1, coordinatorUrl: transport.origin, coordinatorId: health.coordinatorId, nodeId: identity.nodeId, capabilities: self.capabilities, enrolledAt: self.enrolledAt });
    return { outcome: 'ENROLLED', nodeId: identity.nodeId, coordinatorId: health.coordinatorId, capabilities: self.capabilities, ...(self.displayName ? { displayName: self.displayName } : {}) };
  } catch (error) { throw classify(error); }
}

/** Turns anything that can go wrong into a failure class and a plain next step, without echoing a message that could contain an address or a credential. */
export function classify(error: unknown): EnrollError {
  if (error instanceof EnrollError) return error;
  if (error instanceof BindingChangedError) return new EnrollError('COORDINATOR_CHANGED', 'This state directory is already set up for a different Coordinator. Use a new state directory to enroll with another one.');
  if (error instanceof ApiError) {
    if (error.status === 426 || error.code === 'PROTOCOL_MISMATCH') return new EnrollError('PROTOCOL_MISMATCH', 'This node and the Coordinator speak different protocol versions. Update whichever is older.', error.code);
    if (error.status === 429) return new EnrollError('RATE_LIMITED', 'Too many refused attempts from this address. Wait a minute and try again.', error.code);
    if (error.code === 'INVALID_ENROLLMENT') return new EnrollError('TOKEN_REFUSED', 'The enrollment token was refused: it is wrong, already used, expired or revoked. Ask the administrator for a new one.', error.code);
    if (error.code === 'CAPABILITY_FORBIDDEN') return new EnrollError('CAPABILITY_FORBIDDEN', 'The token does not grant the capabilities that were asked for. Leave --capabilities out to take what the token grants.', error.code);
    if (error.code === 'NODE_ALREADY_REGISTERED') return new EnrollError('IDENTITY_UNUSABLE', 'This node identity is already registered with the Coordinator but cannot sign in (it may have been revoked). Enroll with a fresh state directory.', error.code);
    return new EnrollError('COORDINATOR_ERROR', `The Coordinator refused the request (${error.code}).`, error.code);
  }
  const failure = connectionFailure(error);
  const reasons: Record<string, string> = {
    TLS_CERTIFICATE: 'The Coordinator\'s TLS certificate is not trusted by this machine. Install the Coordinator\'s CA certificate (for example with NODE_EXTRA_CA_CERTS) and try again.',
    DNS: 'The Coordinator\'s name does not resolve. Check the address.', CONNECTION_REFUSED: 'The Coordinator refused the connection. Check the address and port, and that it is running.',
    TIMEOUT: 'The Coordinator did not answer in time. Check the address, your network and any firewall.', UNREACHABLE: 'The Coordinator is not reachable from this machine. Check your network and any firewall.',
    CONNECTION_RESET: 'The connection to the Coordinator was reset. Try again.', OTHER: 'The Coordinator could not be reached.' };
  return new EnrollError('UNREACHABLE', reasons[failure.reason ?? 'OTHER'] ?? 'The Coordinator could not be reached.', failure.reason);
}
