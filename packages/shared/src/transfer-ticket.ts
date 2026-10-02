import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { STORAGE_MAX_CHUNK_BYTES, TICKET_MAX_LIFETIME_MS, TICKET_MAX_SKEW_MS } from '@privanet/protocol';
import { canonicalPublicKey } from './crypto.js';

/**
 * Transfer tickets and the holder proof (Phase 4, 0.4.0-alpha.2). The Coordinator signs a ticket; a storage node verifies it offline; the application holding the ticket also proves it
 * holds the private half of the key the ticket names. Nothing here moves bytes or opens a socket: it is the pure cryptographic and parsing core that alpha.3's node listener will call.
 *
 * WIRE FORMAT. A ticket is `base64url(payload || signature)` with no padding: exactly 234 bytes, 312 characters.
 *
 *   payload (170 bytes, big-endian, fixed offsets, no lengths, no optional fields):
 *     0   1  version (1)
 *     1   8  kid: the first 8 bytes of SHA-256 of the signing key's SPKI DER
 *     9  16  transfer id (random)
 *    25   1  operation: 1 put, 2 get, 3 delete
 *    26  16  application id: the UUID's 16 bytes
 *    42  32  chunk id: the 32-byte SHA-256 digest (the hex of `chk_<hex>`)
 *    74  32  target node id: the 32-byte digest (the hex of `node_<hex>`)
 *   106   4  maxBytes (put: the exact size; get: the chunk's size; delete: 0)
 *   110   6  issuedAt, milliseconds since the epoch, unsigned
 *   116   6  expiresAt, the same; at most 120 s after issuedAt
 *   122  32  holder public key: the raw Ed25519 key
 *   154  16  nonce (random)
 *   signature (64 bytes): Ed25519 over `"privanet.transfer-ticket.v1\0" || payload`
 *
 * What is signed is therefore the domain string followed by those 170 bytes, exactly as laid out. There is no JSON, no field order to disagree about, and no encoding of any field that has
 * two forms: ids are raw bytes, integers are fixed width, and the base64url text must re-encode to itself. A ticket for another purpose cannot be replayed here because of the domain string.
 */
export const TICKET_VERSION = 1;
export const TICKET_PAYLOAD_BYTES = 170;
export const TICKET_WIRE_CHARS = 312;
const TICKET_DOMAIN = Buffer.from('privanet.transfer-ticket.v1\0', 'utf8');
const HOLDER_DOMAIN = Buffer.from('privanet.holder-proof.v1\0', 'utf8');
const OPERATIONS = ['put', 'get', 'delete'] as const;
export type TicketOperation = (typeof OPERATIONS)[number];

export interface TicketClaims {
  /** 16 hex characters. */ kid: string; /** 32 hex characters. */ transferId: string; operation: TicketOperation; applicationId: string;
  chunkId: string; nodeId: string; maxBytes: number; issuedAt: number; expiresAt: number;
  /** Canonical base64 SPKI of the holder's Ed25519 public key. */ holderKey: string; /** 32 hex characters. */ nonce: string;
}
const HEX = (length: number) => new RegExp(`^[a-f0-9]{${length}}$`);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const U48_MAX = 2 ** 48 - 1;
// An Ed25519 SubjectPublicKeyInfo is this prefix followed by the 32-byte key.
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const rawKey = (spkiBase64: string): Buffer => canonicalPublicKey(spkiBase64) && Buffer.from(spkiBase64, 'base64').subarray(SPKI_PREFIX.length);
const spkiOf = (raw: Buffer): string => Buffer.concat([SPKI_PREFIX, raw]).toString('base64');
/** The key identifier carried in tickets and key lists: 16 hex characters of the SHA-256 of the SPKI public key. */
export const transferKeyId = (spkiBase64: string): string => createHash('sha256').update(Buffer.from(spkiBase64, 'base64')).digest().subarray(0, 8).toString('hex');
export const base64url = (bytes: Buffer): string => bytes.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
/** Strict decoding: only the URL alphabet, no padding, and the text must be exactly what encoding the bytes gives back. */
function fromBase64url(text: string): Buffer | undefined {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return undefined;
  const bytes = Buffer.from(text.replaceAll('-', '+').replaceAll('_', '/'), 'base64');
  return base64url(bytes) === text ? bytes : undefined;
}

/** Lays claims out as the fixed 170 bytes. Throws on anything that is not canonical, so nothing ambiguous can ever be signed. */
export function encodeTicketPayload(claims: TicketClaims): Buffer {
  const { kid, transferId, operation, applicationId, chunkId, nodeId, maxBytes, issuedAt, expiresAt, holderKey, nonce } = claims;
  const op = OPERATIONS.indexOf(operation) + 1;
  if (!HEX(16).test(kid) || !HEX(32).test(transferId) || !HEX(32).test(nonce) || op === 0 || !UUID.test(applicationId) || !/^chk_[a-f0-9]{64}$/.test(chunkId) || !/^node_[a-f0-9]{64}$/.test(nodeId)) throw new Error('Invalid ticket claims');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > STORAGE_MAX_CHUNK_BYTES || !Number.isSafeInteger(issuedAt) || issuedAt < 0 || issuedAt > U48_MAX || !Number.isSafeInteger(expiresAt) || expiresAt < 0 || expiresAt > U48_MAX) throw new Error('Invalid ticket claims');
  const payload = Buffer.alloc(TICKET_PAYLOAD_BYTES);
  payload.writeUInt8(TICKET_VERSION, 0); Buffer.from(kid, 'hex').copy(payload, 1); Buffer.from(transferId, 'hex').copy(payload, 9); payload.writeUInt8(op, 25);
  Buffer.from(applicationId.replaceAll('-', ''), 'hex').copy(payload, 26); Buffer.from(chunkId.slice(4), 'hex').copy(payload, 42); Buffer.from(nodeId.slice(5), 'hex').copy(payload, 74);
  payload.writeUInt32BE(maxBytes, 106); payload.writeUIntBE(issuedAt, 110, 6); payload.writeUIntBE(expiresAt, 116, 6);
  rawKey(holderKey).copy(payload, 122); Buffer.from(nonce, 'hex').copy(payload, 154);
  return payload;
}
/** The reverse of `encodeTicketPayload`; undefined for a wrong length, a wrong version or an operation code that is not defined. */
export function decodeTicketPayload(payload: Buffer): TicketClaims | undefined {
  if (payload.length !== TICKET_PAYLOAD_BYTES || payload.readUInt8(0) !== TICKET_VERSION) return undefined;
  const operation = OPERATIONS[payload.readUInt8(25) - 1]; if (!operation) return undefined;
  const id = payload.subarray(26, 42).toString('hex');
  return { kid: payload.subarray(1, 9).toString('hex'), transferId: payload.subarray(9, 25).toString('hex'), operation,
    applicationId: `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`,
    chunkId: `chk_${payload.subarray(42, 74).toString('hex')}`, nodeId: `node_${payload.subarray(74, 106).toString('hex')}`,
    maxBytes: payload.readUInt32BE(106), issuedAt: payload.readUIntBE(110, 6), expiresAt: payload.readUIntBE(116, 6),
    holderKey: spkiOf(payload.subarray(122, 154)), nonce: payload.subarray(154, 170).toString('hex') };
}
/** The exact bytes the signature covers. */
export const ticketSigningBytes = (payload: Buffer): Buffer => Buffer.concat([TICKET_DOMAIN, payload]);
/** Signs claims (the `kid` must be the signing key's own identifier) and returns the wire text. */
export function signTicket(claims: TicketClaims, privateKey: KeyObject): string {
  const payload = encodeTicketPayload(claims);
  return base64url(Buffer.concat([payload, sign(null, ticketSigningBytes(payload), privateKey)]));
}
/** Structure only: strict size, alphabet, canonical text, fixed length, known version and operation. It says nothing about who signed it. */
export function parseTicket(wire: string): { claims: TicketClaims; payload: Buffer; signature: Buffer } | undefined {
  if (typeof wire !== 'string' || wire.length !== TICKET_WIRE_CHARS) return undefined;
  const bytes = fromBase64url(wire); if (!bytes || bytes.length !== TICKET_PAYLOAD_BYTES + 64) return undefined;
  const payload = bytes.subarray(0, TICKET_PAYLOAD_BYTES); const claims = decodeTicketPayload(payload); if (!claims) return undefined;
  return { claims, payload, signature: bytes.subarray(TICKET_PAYLOAD_BYTES) };
}

/** A public key the verifier trusts to sign tickets: `notAfter` (the Coordinator's clock) is set on a key that has been replaced and is only honoured for a short overlap. */
export interface TransferKeyInfo { kid: string; publicKey: string; notAfter: number | null }
/** The only reasons a verification can fail, in one fixed vocabulary that never carries library text. */
export const TICKET_ERRORS = ['MALFORMED', 'TOO_LARGE', 'VERSION', 'UNKNOWN_KID', 'BAD_SIGNATURE', 'LIFETIME', 'NOT_YET_VALID', 'EXPIRED', 'WRONG_NODE', 'WRONG_OPERATION', 'WRONG_CHUNK', 'WRONG_APPLICATION', 'BAD_SIZE', 'REPLAYED'] as const;
export type TicketError = (typeof TICKET_ERRORS)[number];
export type TicketVerdict = { ok: true; claims: TicketClaims } | { ok: false; error: TicketError };
export interface VerifyOptions {
  /** Trusted verification keys (an unknown `kid`, or a key whose `notAfter` has passed, is refused). */
  keys: readonly TransferKeyInfo[];
  /** The verifier's clock (milliseconds); the Coordinator's clock where the node knows its offset. */
  now: number;
  /** Tolerated clock difference, 0 to 30 s (default 30 s). */
  skewMs?: number;
  /** What this verifier is: the node that was named must be this one. */
  expect: { nodeId: string; operation?: TicketOperation; chunkId?: string; applicationId?: string; /** The size the transfer will actually be (put: must equal the ticket's; get: must not exceed it). */ size?: number };
  /** The consumer's replay state: a ticket whose transfer id it already holds is refused. Consuming the id is the consumer's job (see ReplaySet). */
  replay?: { has(transferId: string): boolean };
}
/**
 * Validity window: issuedAt - skew <= now < expiresAt + skew. The upper end is EXCLUSIVE: with zero skew, a ticket is expired at exactly `expiresAt`. A ticket must live 1 ms to 120 s
 * (`expiresAt - issuedAt`), however far in the future the signer says. The order of checks is fixed: shape, key, signature, then meaning, so nothing about a forged ticket's contents is
 * ever reflected in which error comes back beyond "it failed".
 */
export function verifyTicket(wire: string, options: VerifyOptions): TicketVerdict {
  if (typeof wire === 'string' && wire.length > 4 * TICKET_WIRE_CHARS) return { ok: false, error: 'TOO_LARGE' };
  const skew = options.skewMs ?? TICKET_MAX_SKEW_MS;
  if (!Number.isSafeInteger(skew) || skew < 0 || skew > TICKET_MAX_SKEW_MS || !Number.isSafeInteger(options.now) || options.now < 0) return { ok: false, error: 'MALFORMED' };
  const parsed = parseTicket(wire); if (!parsed) return { ok: false, error: 'MALFORMED' };
  const { claims, payload, signature } = parsed;
  const key = options.keys.find(candidate => candidate.kid === claims.kid && transferKeyId(candidate.publicKey) === candidate.kid);
  if (!key || (key.notAfter !== null && options.now >= key.notAfter + skew)) return { ok: false, error: 'UNKNOWN_KID' };
  let valid = false;
  try { valid = verify(null, ticketSigningBytes(payload), createPublicKey({ key: Buffer.from(key.publicKey, 'base64'), type: 'spki', format: 'der' }), signature); } catch { valid = false; }
  if (!valid) return { ok: false, error: 'BAD_SIGNATURE' };
  if (claims.expiresAt <= claims.issuedAt || claims.expiresAt - claims.issuedAt > TICKET_MAX_LIFETIME_MS) return { ok: false, error: 'LIFETIME' };
  if (claims.issuedAt - skew > options.now) return { ok: false, error: 'NOT_YET_VALID' };
  if (options.now >= claims.expiresAt + skew) return { ok: false, error: 'EXPIRED' };
  const sized = claims.operation === 'delete' ? claims.maxBytes === 0 : claims.maxBytes >= 1 && claims.maxBytes <= STORAGE_MAX_CHUNK_BYTES;
  if (!sized) return { ok: false, error: 'BAD_SIZE' };
  const { expect } = options;
  if (claims.nodeId !== expect.nodeId) return { ok: false, error: 'WRONG_NODE' };
  if (expect.operation !== undefined && claims.operation !== expect.operation) return { ok: false, error: 'WRONG_OPERATION' };
  if (expect.chunkId !== undefined && claims.chunkId !== expect.chunkId) return { ok: false, error: 'WRONG_CHUNK' };
  if (expect.applicationId !== undefined && claims.applicationId !== expect.applicationId) return { ok: false, error: 'WRONG_APPLICATION' };
  if (expect.size !== undefined && (claims.operation === 'put' ? expect.size !== claims.maxBytes : claims.operation === 'get' ? expect.size > claims.maxBytes : expect.size !== 0)) return { ok: false, error: 'BAD_SIZE' };
  if (options.replay?.has(claims.transferId)) return { ok: false, error: 'REPLAYED' };
  return { ok: true, claims };
}

/**
 * The consumed-transfer-id set a ticket consumer keeps (the node, in alpha.3): bounded, and forgetting an id only after its ticket can no longer verify (`expiresAt + skew`). In memory here;
 * alpha.3 persists it so a restart does not reopen a replay window. `consume` is the single-use gate: exactly one caller gets OK for an id.
 */
export class ReplaySet {
  private readonly seen = new Map<string, number>();
  constructor(private readonly maxEntries = 4096) { if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new Error('Invalid replay set size'); }
  has(transferId: string): boolean { return this.seen.has(transferId); }
  get size(): number { return this.seen.size; }
  consume(transferId: string, expiresAt: number, now: number): 'OK' | 'REPLAYED' | 'FULL' {
    for (const [id, until] of this.seen) if (until + TICKET_MAX_SKEW_MS <= now) this.seen.delete(id);
    if (this.seen.has(transferId)) return 'REPLAYED';
    if (this.seen.size >= this.maxEntries) return 'FULL';
    this.seen.set(transferId, expiresAt); return 'OK';
  }
}

// ---- Holder binding -----------------------------------------------------------------------------------------------------------------------------------------------------------------
/** A fresh Ed25519 pair for one transfer. The public half goes to the Coordinator; the private half never leaves the application. */
export function generateHolderKey(): { publicKey: string; privateKey: KeyObject } {
  const pair = generateKeyPairSync('ed25519');
  return { publicKey: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'), privateKey: pair.privateKey };
}
/** The challenge a node gives a connecting holder: 32 random bytes as 64 hex characters. */
export const newHolderChallenge = (): string => randomBytes(32).toString('hex');
export interface HolderProofInput {
  /** 64 hex characters. */ challenge: string; /** 32 hex characters. */ transferId: string;
  /** The request being authorized, for example `PUT /v1/chunks/chk_...`: bound so a proof for one request cannot authorize another. Printable ASCII, at most 512 characters. */ requestLine: string;
}
/** `domain || challenge(32) || transfer id(16) || SHA-256(request line)(32)`: fixed length, so the parts cannot be shifted into one another. Throws on an input that is not canonical. */
export function holderProofMessage(input: HolderProofInput): Buffer {
  if (!HEX(64).test(input.challenge) || !HEX(32).test(input.transferId) || typeof input.requestLine !== 'string' || input.requestLine.length < 1 || input.requestLine.length > 512 || !/^[\x20-\x7e]+$/.test(input.requestLine)) throw new Error('Invalid holder proof input');
  return Buffer.concat([HOLDER_DOMAIN, Buffer.from(input.challenge, 'hex'), Buffer.from(input.transferId, 'hex'), createHash('sha256').update(input.requestLine, 'utf8').digest()]);
}
export const signHolderProof = (privateKey: KeyObject, input: HolderProofInput): string => sign(null, holderProofMessage(input), privateKey).toString('hex');
/** True only for a signature, by the ticket's holder key, over exactly this challenge, transfer and request. Anything malformed is false, never an exception. */
export function verifyHolderProof(holderKey: string, input: HolderProofInput, signatureHex: string): boolean {
  try {
    if (!/^[a-f0-9]{128}$/.test(signatureHex)) return false;
    canonicalPublicKey(holderKey);
    return verify(null, holderProofMessage(input), createPublicKey({ key: Buffer.from(holderKey, 'base64'), type: 'spki', format: 'der' }), Buffer.from(signatureHex, 'hex'));
  } catch { return false; }
}
/** Reads a stored PKCS8 private key (base64 DER); used by the Coordinator's keyring. */
export const privateKeyFromBase64 = (pkcs8Base64: string): KeyObject => createPrivateKey({ key: Buffer.from(pkcs8Base64, 'base64'), type: 'pkcs8', format: 'der' });
