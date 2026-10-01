import {
  ChallengeSchema, EnrollmentStartSchema, HealthSchema, InviteChallengeRequestSchema, JOB_TYPE_IDS, JoinCreatedSchema, JoinStatusResponseSchema, NodeSelfSchema, PROTOCOL_VERSION,
  SERVICE_VERSION, SessionSchema,
} from '@privanet/protocol';
import type { Challenge, JobType } from '@privanet/protocol';
import { ApiError, Transport } from '@privanet/shared';
import { setTimeout as delay } from 'node:timers/promises';
import { ZodError } from 'zod';
import { BindingChangedError, bindCoordinator, loadIdentity, signProof } from './identity.js';
import type { Identity } from './identity.js';
import { connectionFailure } from './failure.js';
import { readEnrollmentRecord, readJoinRecord, removeJoinRecord, writeEnrollmentRecord, writeJoinRecord } from './enrollment-record.js';

export interface EnrollOptions {
  /** Coordinator address: `https://host[:port]` (plain http only to a literal loopback address, and only with `allowInsecureLoopback`). */
  url: string; stateDir: string; allowInsecureLoopback?: boolean;
  /** Exactly one of these: the one-time enrollment token, or a short invite code. Each is sent to the Coordinator and kept nowhere. */
  token?: string; invite?: string;
  /** Capabilities to enroll with; omitted means everything the token or invite grants. */
  capabilities?: JobType[];
}
export type EnrollFailure =
  /** The token is unknown, used, expired or revoked (the Coordinator deliberately does not say which). */
  | 'TOKEN_REFUSED'
  /** The same for an invite code, which is also refused once it has been guessed at too often. */
  | 'INVITE_REFUSED'
  /** The token or invite does not grant a capability that was asked for. */
  | 'CAPABILITY_FORBIDDEN'
  /** Too many refused attempts from this address; wait a minute. */
  | 'RATE_LIMITED'
  /** This node's identity is already registered at the Coordinator but is not usable (it was revoked); a new identity needs a fresh state directory. */
  | 'IDENTITY_UNUSABLE'
  /** This state directory was set up for a different Coordinator. */
  | 'COORDINATOR_CHANGED'
  /** An approval request was refused by the owner, ran out before it was decided, or this machine stopped waiting. */
  | 'REQUEST_DENIED' | 'REQUEST_EXPIRED' | 'REQUEST_PENDING' | 'REQUEST_LIMIT' | 'GAVE_UP'
  | 'PROTOCOL_MISMATCH' | 'UNREACHABLE' | 'COORDINATOR_ERROR';
/** Carries a failure class and a fixed, plain-language reason; never the token, the code, the address or a credential. */
export class EnrollError extends Error {
  constructor(readonly failure: EnrollFailure, message: string, readonly detail?: string) { super(message); }
}
export interface EnrollResult {
  /** ENROLLED: this call enrolled the node. ALREADY_ENROLLED: the node was already known and usable, and nothing was used up. */
  outcome: 'ENROLLED' | 'ALREADY_ENROLLED'; nodeId: string; coordinatorId: string; capabilities: JobType[]; displayName?: string;
}
const connect = async (transport: Transport) => {
  try { return await transport.request('GET', '/v1/health', HealthSchema); }
  catch (error) {
    if (error instanceof ZodError) throw new EnrollError('PROTOCOL_MISMATCH', 'This Coordinator speaks a protocol version this node does not support.');
    throw error;
  }
};
/** Already known and usable? Then there is nothing to do, and nothing is spent. */
async function alreadyKnown(transport: Transport, identity: Identity): Promise<boolean> {
  try { await transport.request('POST', '/v1/auth/challenge', ChallengeSchema, { nodeId: identity.nodeId, protocolVersion: PROTOCOL_VERSION }); return true; }
  catch (error) { if (error instanceof ApiError && error.status === 401) return false; throw error; }
}
/** Signs the challenge, registers the node, learns what it was granted and writes the enrollment record. The same last steps for a token, an invite and an approved request. */
async function complete(transport: Transport, identity: Identity, coordinatorId: string, stateDir: string, challenge: Challenge): Promise<EnrollResult> {
  const session = await transport.request('POST', '/v1/enrollment/proof', SessionSchema, signProof(identity, challenge, coordinatorId, 'enroll'));
  if (session.nodeId !== identity.nodeId || session.coordinatorId !== coordinatorId) throw new EnrollError('COORDINATOR_ERROR', 'The Coordinator answered with a different identity than expected.');
  const self = await transport.request('GET', '/v1/node/self', NodeSelfSchema, undefined, session.token);
  await writeEnrollmentRecord(stateDir, { version: 1, coordinatorUrl: transport.origin, coordinatorId, nodeId: identity.nodeId, capabilities: self.capabilities, enrolledAt: self.enrolledAt });
  removeJoinRecord(stateDir);
  return { outcome: 'ENROLLED', nodeId: identity.nodeId, coordinatorId, capabilities: self.capabilities, ...(self.displayName ? { displayName: self.displayName } : {}) };
}

/**
 * Enrolls this machine with a Coordinator using the existing, proven flow: the node makes (or reuses) its own Ed25519 identity, presents the one-time token (or a short invite code), and
 * proves it holds the private key. The private key never leaves the machine, so there is no long-lived secret for the Coordinator to hand back: the identity file IS the node's credential,
 * and every later session is obtained by signing a fresh challenge. On success the Coordinator address and the node's identity are recorded in `enrollment.json`, which is what lets
 * `privanet-node` start later with no configuration and no token.
 */
export async function enrollNode(options: EnrollOptions): Promise<EnrollResult> {
  if ((options.token === undefined) === (options.invite === undefined)) throw new Error('Give exactly one of a token and an invite');
  const transport = new Transport({ url: options.url, ...(options.allowInsecureLoopback ? { allowInsecureLoopback: true } : {}) });
  const identity = await loadIdentity(options.stateDir);
  try {
    const health = await connect(transport);
    await bindCoordinator(options.stateDir, transport.origin, health.coordinatorId);
    const existing = await readEnrollmentRecord(options.stateDir);
    if (await alreadyKnown(transport, identity)) return { outcome: 'ALREADY_ENROLLED', nodeId: identity.nodeId, coordinatorId: health.coordinatorId, capabilities: existing?.capabilities ?? [] };
    const capabilities = options.capabilities;
    if (capabilities?.some(capability => !JOB_TYPE_IDS.includes(capability))) throw new EnrollError('CAPABILITY_FORBIDDEN', 'This node does not support one of the requested capabilities.');
    const challenge = options.invite !== undefined
      ? await transport.request('POST', '/v1/invites/challenge', ChallengeSchema, InviteChallengeRequestSchema.parse({ code: options.invite, publicKey: identity.publicKey, protocolVersion: PROTOCOL_VERSION, daemonVersion: SERVICE_VERSION, ...(capabilities ? { capabilities } : {}) }))
      : await transport.request('POST', '/v1/enrollment/challenge', ChallengeSchema, EnrollmentStartSchema.parse({ token: options.token, publicKey: identity.publicKey, protocolVersion: PROTOCOL_VERSION, daemonVersion: SERVICE_VERSION, ...(capabilities ? { capabilities } : {}) }));
    return await complete(transport, identity, health.coordinatorId, options.stateDir, challenge);
  } catch (error) { throw classify(error); }
}

export interface JoinOptions {
  url: string; stateDir: string; allowInsecureLoopback?: boolean;
  /** A name the owner will see with the request (a hint; the owner chooses the node's real name). */
  deviceName?: string; capabilities?: JobType[];
  /** The longest this machine keeps waiting for a decision (default 30 minutes, and never past the request's own expiry). */
  maxWaitMs?: number;
  /** Called once the request exists (and again if it is resumed): tell the person the code and the node ID to compare with what the owner sees. */
  onRequested?: (info: { code: string; nodeId: string; expiresAt: number; resumed: boolean }) => void;
  /** Test hooks: how often to ask (the Coordinator suggests 2 s) and how to wait. */
  pollMs?: number; sleep?: (ms: number) => Promise<void>;
}
/**
 * Joins without any enrollment secret: asks the Coordinator, shows a confirmation code, and waits (politely, bounded) for the owner to approve it. The request is bound to this node's public
 * key and the code is only a name for it; nothing is registered until the owner approves AND this node signs the ordinary challenge with its private key. A request that was already made is
 * resumed, so running this again does not pile up requests.
 */
export async function joinNode(options: JoinOptions): Promise<EnrollResult> {
  const transport = new Transport({ url: options.url, ...(options.allowInsecureLoopback ? { allowInsecureLoopback: true } : {}) });
  const identity = await loadIdentity(options.stateDir); const sleep = options.sleep ?? ((ms: number) => delay(ms)); const maxWait = options.maxWaitMs ?? 1800000;
  try {
    const health = await connect(transport);
    await bindCoordinator(options.stateDir, transport.origin, health.coordinatorId);
    const existing = await readEnrollmentRecord(options.stateDir);
    if (await alreadyKnown(transport, identity)) return { outcome: 'ALREADY_ENROLLED', nodeId: identity.nodeId, coordinatorId: health.coordinatorId, capabilities: existing?.capabilities ?? [] };
    let saved = await readJoinRecord(options.stateDir); let resumed = saved !== undefined && saved.coordinatorId === health.coordinatorId && saved.expiresAt > Date.now();
    if (saved && !resumed) { removeJoinRecord(options.stateDir); saved = undefined; }
    if (!saved) {
      const created = await transport.request('POST', '/v1/join/request', JoinCreatedSchema, { publicKey: identity.publicKey, protocolVersion: PROTOCOL_VERSION, daemonVersion: SERVICE_VERSION,
        ...(options.capabilities ? { capabilities: options.capabilities } : {}), ...(options.deviceName ? { deviceName: options.deviceName } : {}) });
      saved = { version: 1, requestId: created.requestId, code: created.code, coordinatorUrl: transport.origin, coordinatorId: health.coordinatorId, expiresAt: created.expiresAt };
      await writeJoinRecord(options.stateDir, saved); resumed = false;
    }
    options.onRequested?.({ code: saved.code, nodeId: identity.nodeId, expiresAt: saved.expiresAt, resumed });
    const deadline = Math.min(saved.expiresAt + 5000, Date.now() + maxWait); let failures = 0;
    for (;;) {
      let status;
      try { status = await transport.request('POST', '/v1/join/status', JoinStatusResponseSchema, { requestId: saved.requestId, protocolVersion: PROTOCOL_VERSION }); failures = 0; }
      catch (error) {
        // An outage while waiting is ridden out (a few times); a certificate problem or a refusal is not.
        if (error instanceof ApiError || connectionFailure(error).reason === 'TLS_CERTIFICATE' || ++failures > 8) throw error;
        await sleep(Math.min(30000, 1000 * 2 ** failures)); continue;
      }
      if (status.status === 'APPROVED') break;
      if (status.status === 'DENIED') { removeJoinRecord(options.stateDir); throw new EnrollError('REQUEST_DENIED', 'The owner declined this request.'); }
      if (status.status === 'EXPIRED' || status.status === 'COMPLETED') {
        removeJoinRecord(options.stateDir);
        if (status.status === 'COMPLETED' && await alreadyKnown(transport, identity)) return { outcome: 'ALREADY_ENROLLED', nodeId: identity.nodeId, coordinatorId: health.coordinatorId, capabilities: [] };
        throw new EnrollError('REQUEST_EXPIRED', 'The request ran out before the owner approved it. Run the command again to ask again.');
      }
      if (Date.now() >= deadline) throw new EnrollError('GAVE_UP', 'Stopped waiting for approval. The request stays open until it expires; run the command again to keep waiting.');
      await sleep(options.pollMs ?? Math.max(1000, Math.min(30000, status.pollAfterMs)));
    }
    const challenge = await transport.request('POST', '/v1/join/challenge', ChallengeSchema, { requestId: saved.requestId, protocolVersion: PROTOCOL_VERSION });
    return await complete(transport, identity, health.coordinatorId, options.stateDir, challenge);
  } catch (error) { throw classify(error); }
}

/** Turns anything that can go wrong into a failure class and a plain next step, without echoing a message that could contain an address or a credential. */
export function classify(error: unknown): EnrollError {
  if (error instanceof EnrollError) return error;
  if (error instanceof BindingChangedError) return new EnrollError('COORDINATOR_CHANGED', 'This state directory is already set up for a different Coordinator. Use a new state directory to enroll with another one.');
  if (error instanceof ApiError) {
    if (error.status === 426 || error.code === 'PROTOCOL_MISMATCH') return new EnrollError('PROTOCOL_MISMATCH', 'This node and the Coordinator speak different protocol versions. Update whichever is older.', error.code);
    if (error.status === 429 && error.code === 'REQUEST_LIMIT') return new EnrollError('REQUEST_LIMIT', 'The Coordinator has too many open requests from this address or in total. Try again later or ask the owner for an invite.', error.code);
    if (error.status === 429) return new EnrollError('RATE_LIMITED', 'Too many refused attempts from this address. Wait a minute and try again.', error.code);
    if (error.code === 'INVALID_ENROLLMENT') return new EnrollError('TOKEN_REFUSED', 'The enrollment token was refused: it is wrong, already used, expired or revoked. Ask the administrator for a new one.', error.code);
    if (error.code === 'INVALID_INVITE') return new EnrollError('INVITE_REFUSED', 'The invite code was refused: it is wrong, already used, expired, revoked, or was locked after too many wrong guesses. Ask the owner for a new one.', error.code);
    if (error.code === 'INVALID_JOIN') return new EnrollError('REQUEST_DENIED', 'The request is not approved (it may have been declined, withdrawn or expired).', error.code);
    if (error.code === 'REQUEST_PENDING') return new EnrollError('REQUEST_PENDING', 'A request from this identity is already waiting at the Coordinator. Run the command again to resume it, or wait for it to expire.', error.code);
    if (error.code === 'CAPABILITY_FORBIDDEN') return new EnrollError('CAPABILITY_FORBIDDEN', 'The token or invite does not grant the capabilities that were asked for. Leave --capabilities out to take what it grants.', error.code);
    if (error.code === 'NODE_ALREADY_REGISTERED') return new EnrollError('IDENTITY_UNUSABLE', 'This node identity is already registered with the Coordinator but cannot sign in (it may have been revoked). Enroll with a fresh state directory.', error.code);
    return new EnrollError('COORDINATOR_ERROR', `The Coordinator refused the request (${error.code}).`, error.code);
  }
  const failure = connectionFailure(error);
  const reasons: Record<string, string> = {
    TLS_CERTIFICATE: 'The Coordinator\'s TLS certificate is not trusted by this machine. For a public deployment, ask the owner to check the certificate; for a private LAN deployment install the network\'s CA (for example with NODE_EXTRA_CA_CERTS). Run `privanet-node doctor` for details.',
    DNS: 'The Coordinator\'s name does not resolve. Check the address.', CONNECTION_REFUSED: 'The Coordinator refused the connection. Check the address and port, and that it is running.',
    TIMEOUT: 'The Coordinator did not answer in time. Check the address, your network and any firewall.', UNREACHABLE: 'The Coordinator is not reachable from this machine. Check your network and any firewall.',
    CONNECTION_RESET: 'The connection to the Coordinator was reset. Try again.', OTHER: 'The Coordinator could not be reached.' };
  return new EnrollError('UNREACHABLE', reasons[failure.reason ?? 'OTHER'] ?? 'The Coordinator could not be reached.', failure.reason);
}
