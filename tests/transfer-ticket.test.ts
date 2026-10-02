import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { STORAGE_MAX_CHUNK_BYTES, TICKET_MAX_LIFETIME_MS, TICKET_MAX_SKEW_MS } from '@privanet/protocol';
import {
  ReplaySet, TICKET_ERRORS, TICKET_PAYLOAD_BYTES, TICKET_WIRE_CHARS, base64url, decodeTicketPayload, encodeTicketPayload, generateHolderKey, holderProofMessage, newHolderChallenge,
  parseTicket, signHolderProof, signTicket, ticketSigningBytes, transferKeyId, verifyHolderProof, verifyTicket,
} from '@privanet/shared';
import type { TicketClaims, TransferKeyInfo, VerifyOptions } from '@privanet/shared';

// Fixed keys so that every byte below is reproducible: Ed25519 signatures are deterministic.
const PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex');
const seedKey = (seed: Buffer) => createPrivateKey({ key: Buffer.concat([PKCS8, seed]), format: 'der', type: 'pkcs8' });
const spki = (key: ReturnType<typeof seedKey>) => createPublicKey(key).export({ format: 'der', type: 'spki' }).toString('base64');
const signer = seedKey(Buffer.from('0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20', 'hex'));
const holder = seedKey(Buffer.alloc(32, 7));
const SIGNER_PUB = spki(signer); const HOLDER_PUB = spki(holder); const KID = transferKeyId(SIGNER_PUB);
const NODE = `node_${'cd'.repeat(32)}`; const CHUNK = `chk_${'ab'.repeat(32)}`; const APP = '123e4567-e89b-42d3-a456-426614174000';
const claims: TicketClaims = { kid: KID, transferId: '00112233445566778899aabbccddeeff', operation: 'put', applicationId: APP, chunkId: CHUNK, nodeId: NODE, maxBytes: 4096,
  issuedAt: 1700000000000, expiresAt: 1700000090000, holderKey: HOLDER_PUB, nonce: 'ffeeddccbbaa99887766554433221100' };
const keys: TransferKeyInfo[] = [{ kid: KID, publicKey: SIGNER_PUB, notAfter: null }];
const NOW = claims.issuedAt + 1000;
const options = (extra: Partial<VerifyOptions> = {}): VerifyOptions => ({ keys, now: NOW, expect: { nodeId: NODE }, ...extra });
const wireOf = (overrides: Partial<TicketClaims> = {}) => signTicket({ ...claims, ...overrides }, signer);

const VECTOR_PAYLOAD = '01646d6be49d9f004800112233445566778899aabbccddeeff01123e4567e89b42d3a456426614174000ababababababababababababababababababababababababababababababababcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd00001000018bcfe56800018bcfe6c790ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22cffeeddccbbaa99887766554433221100';
const VECTOR_WIRE = 'AWRta-SdnwBIABEiM0RVZneImaq7zN3u_wESPkVn6JtC06RWQmYUF0AAq6urq6urq6urq6urq6urq6urq6urq6urq6urq6urq6vNzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3NzQAAEAABi8_laAABi8_mx5DqSmxj4pxSCr71UHsTLsX5lUd2rr6-e5JCHuppFEbSLP_u3cy7qpmId2ZVRDMiEQD7K1ZY3yh-dHYyMa0X6PZXBFX0rcxLgf1x6sZjXWk9GLNloUs129fgOUEuUZdHndlqoNicKkgUw_XWBad1TWIE';

test('test vectors: the signed bytes and the ticket are exactly these, and are deterministic', () => {
  assert.equal(KID, '646d6be49d9f0048');
  const payload = encodeTicketPayload(claims);
  assert.equal(payload.length, TICKET_PAYLOAD_BYTES);
  assert.equal(payload.toString('hex'), VECTOR_PAYLOAD);
  assert.equal(ticketSigningBytes(payload).toString('hex'), Buffer.concat([Buffer.from('privanet.transfer-ticket.v1\0'), Buffer.from(VECTOR_PAYLOAD, 'hex')]).toString('hex'));
  assert.equal(wireOf(), VECTOR_WIRE); assert.equal(wireOf(), wireOf());
  assert.equal(VECTOR_WIRE.length, TICKET_WIRE_CHARS);
  assert.deepEqual(decodeTicketPayload(payload), claims);
  assert.deepEqual(verifyTicket(VECTOR_WIRE, options()), { ok: true, claims });
});
test('field layout: each field sits at its documented offset and width', () => {
  const p = encodeTicketPayload(claims);
  assert.equal(p[0], 1); assert.equal(p.subarray(1, 9).toString('hex'), KID); assert.equal(p.subarray(9, 25).toString('hex'), claims.transferId); assert.equal(p[25], 1);
  assert.equal(p.subarray(26, 42).toString('hex'), APP.replaceAll('-', '')); assert.equal(p.subarray(42, 74).toString('hex'), 'ab'.repeat(32)); assert.equal(p.subarray(74, 106).toString('hex'), 'cd'.repeat(32));
  assert.equal(p.readUInt32BE(106), 4096); assert.equal(p.readUIntBE(110, 6), claims.issuedAt); assert.equal(p.readUIntBE(116, 6), claims.expiresAt);
  assert.equal(p.subarray(122, 154).toString('hex'), Buffer.from(HOLDER_PUB, 'base64').subarray(12).toString('hex')); assert.equal(p.subarray(154, 170).toString('hex'), claims.nonce);
  for (const [operation, code] of [['put', 1], ['get', 2], ['delete', 3]] as const) assert.equal(encodeTicketPayload({ ...claims, operation, maxBytes: operation === 'delete' ? 0 : 1 })[25], code);
});
test('a ticket is compact and bounded: 234 bytes, 312 characters, URL alphabet, no padding', () => {
  assert.equal(TICKET_WIRE_CHARS, 312); assert.equal(Buffer.from(VECTOR_WIRE, 'base64url').length, TICKET_PAYLOAD_BYTES + 64); assert.match(VECTOR_WIRE, /^[A-Za-z0-9_-]{312}$/);
});
test('every one-bit change of a valid ticket is refused (all 1872 bits)', () => {
  const bytes = Buffer.from(VECTOR_WIRE, 'base64url'); let refused = 0;
  for (let bit = 0; bit < bytes.length * 8; bit++) {
    const mutated = Buffer.from(bytes); mutated[bit >> 3] = (mutated[bit >> 3] ?? 0) ^ (1 << (bit & 7));
    const verdict = verifyTicket(base64url(mutated), options()); assert.equal(verdict.ok, false, `bit ${bit} was accepted`); refused++;
  }
  assert.equal(refused, 1872);
});
test('every single-character change of the text is refused, including ones that decode to the same bytes', () => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  for (let at = 0; at < VECTOR_WIRE.length; at++) for (const replacement of [alphabet[(alphabet.indexOf(VECTOR_WIRE[at] ?? 'A') + 1) % 64] ?? 'A', '=', '+', '/', ' ']) {
    if (replacement === VECTOR_WIRE[at]) continue;
    assert.equal(verifyTicket(VECTOR_WIRE.slice(0, at) + replacement + VECTOR_WIRE.slice(at + 1), options()).ok, false);
  }
});
test('non-canonical encodings are malformed: padding, standard alphabet, whitespace, a different length', () => {
  for (const text of [VECTOR_WIRE + '=', VECTOR_WIRE.replaceAll('-', '+').replaceAll('_', '/'), ` ${VECTOR_WIRE}`, `${VECTOR_WIRE}\n`, VECTOR_WIRE.slice(1), VECTOR_WIRE + 'A', '', 'A'.repeat(312), '\0'.repeat(312)]) {
    const verdict = verifyTicket(text, options());
    assert.equal(verdict.ok, false); if (!verdict.ok) assert.ok(['MALFORMED', 'BAD_SIGNATURE', 'UNKNOWN_KID'].includes(verdict.error), verdict.error);
  }
  assert.deepEqual(verifyTicket(VECTOR_WIRE.repeat(5), options()), { ok: false, error: 'TOO_LARGE' });
  assert.deepEqual(verifyTicket('x'.repeat(100000), options()), { ok: false, error: 'TOO_LARGE' });
});
test('truncated or extended signatures and random garbage are refused with fixed errors only', () => {
  const bytes = Buffer.from(VECTOR_WIRE, 'base64url');
  for (const cut of [1, 8, 32, 63, 64]) assert.equal(verifyTicket(base64url(bytes.subarray(0, bytes.length - cut)), options()).ok, false);
  assert.equal(verifyTicket(base64url(Buffer.concat([bytes, Buffer.from([0])])), options()).ok, false);
  for (let i = 0; i < 300; i++) {
    const verdict = verifyTicket(base64url(randomBytes(i % 2 === 0 ? 234 : 1 + (i % 400))), options());
    assert.equal(verdict.ok, false); if (!verdict.ok) assert.ok((TICKET_ERRORS as readonly string[]).includes(verdict.error));
  }
  for (const garbage of [undefined, null, 5, {}, [], Buffer.from('x')] as unknown[]) assert.equal(verifyTicket(garbage as string, options()).ok, false);
});
test('a signature from the wrong key, and an unknown or wrong kid, are refused', () => {
  const stranger = generateKeyPairSync('ed25519').privateKey;
  assert.deepEqual(verifyTicket(signTicket(claims, stranger), options()), { ok: false, error: 'BAD_SIGNATURE' });
  assert.deepEqual(verifyTicket(wireOf({ kid: '0000000000000000' }), options()), { ok: false, error: 'UNKNOWN_KID' });
  assert.deepEqual(verifyTicket(VECTOR_WIRE, options({ keys: [] })), { ok: false, error: 'UNKNOWN_KID' });
  // a key list whose entry claims a kid that is not the hash of its key is not trusted
  assert.deepEqual(verifyTicket(VECTOR_WIRE, options({ keys: [{ kid: KID, publicKey: spki(seedKey(Buffer.alloc(32, 9))), notAfter: null }] })), { ok: false, error: 'UNKNOWN_KID' });
  // two keys: the ticket's own kid selects the key
  const other = seedKey(Buffer.alloc(32, 3)); const both = [{ kid: transferKeyId(spki(other)), publicKey: spki(other), notAfter: null }, ...keys];
  assert.equal(verifyTicket(VECTOR_WIRE, options({ keys: both })).ok, true);
  assert.deepEqual(verifyTicket(signTicket({ ...claims, kid: transferKeyId(spki(other)) }, signer), options({ keys: both })), { ok: false, error: 'BAD_SIGNATURE' });
});
test('expiry is exclusive and skew applies to both ends; the boundaries are exact', () => {
  const strict = (now: number, skewMs = 0) => verifyTicket(VECTOR_WIRE, options({ now, skewMs }));
  assert.equal(strict(claims.expiresAt - 1).ok, true);
  assert.deepEqual(strict(claims.expiresAt), { ok: false, error: 'EXPIRED' });
  assert.deepEqual(strict(claims.expiresAt + 1), { ok: false, error: 'EXPIRED' });
  assert.equal(strict(claims.issuedAt).ok, true);
  assert.deepEqual(strict(claims.issuedAt - 1), { ok: false, error: 'NOT_YET_VALID' });
  // with the full 30 s skew
  assert.equal(strict(claims.expiresAt + TICKET_MAX_SKEW_MS - 1, TICKET_MAX_SKEW_MS).ok, true);
  assert.deepEqual(strict(claims.expiresAt + TICKET_MAX_SKEW_MS, TICKET_MAX_SKEW_MS), { ok: false, error: 'EXPIRED' });
  assert.equal(strict(claims.issuedAt - TICKET_MAX_SKEW_MS, TICKET_MAX_SKEW_MS).ok, true);
  assert.deepEqual(strict(claims.issuedAt - TICKET_MAX_SKEW_MS - 1, TICKET_MAX_SKEW_MS), { ok: false, error: 'NOT_YET_VALID' });
  // the default skew is the maximum, and a larger one is refused rather than honoured
  assert.equal(verifyTicket(VECTOR_WIRE, options({ now: claims.expiresAt + TICKET_MAX_SKEW_MS - 1 })).ok, true);
  assert.deepEqual(verifyTicket(VECTOR_WIRE, options({ skewMs: TICKET_MAX_SKEW_MS + 1 })), { ok: false, error: 'MALFORMED' });
  assert.deepEqual(verifyTicket(VECTOR_WIRE, options({ skewMs: -1 })), { ok: false, error: 'MALFORMED' });
  assert.deepEqual(verifyTicket(VECTOR_WIRE, options({ now: Number.NaN })), { ok: false, error: 'MALFORMED' });
});
test('lifetime is bounded by the signer\'s own claim: more than 120 s, zero or negative is refused even with a valid signature', () => {
  assert.equal(verifyTicket(wireOf({ expiresAt: claims.issuedAt + TICKET_MAX_LIFETIME_MS }), options()).ok, true);
  assert.deepEqual(verifyTicket(wireOf({ expiresAt: claims.issuedAt + TICKET_MAX_LIFETIME_MS + 1 }), options()), { ok: false, error: 'LIFETIME' });
  assert.deepEqual(verifyTicket(wireOf({ expiresAt: claims.issuedAt }), options()), { ok: false, error: 'LIFETIME' });
  assert.deepEqual(verifyTicket(wireOf({ expiresAt: claims.issuedAt - 1 }), options()), { ok: false, error: 'LIFETIME' });
  assert.deepEqual(verifyTicket(wireOf({ expiresAt: 2 ** 48 - 1 }), options()), { ok: false, error: 'LIFETIME' });
  assert.equal(TICKET_MAX_LIFETIME_MS, 120000);
});
test('a ticket issued in the future beyond the skew is refused', () => {
  assert.deepEqual(verifyTicket(wireOf({ issuedAt: NOW + TICKET_MAX_SKEW_MS + 1, expiresAt: NOW + TICKET_MAX_SKEW_MS + 60001 }), options()), { ok: false, error: 'NOT_YET_VALID' });
  assert.equal(verifyTicket(wireOf({ issuedAt: NOW + TICKET_MAX_SKEW_MS, expiresAt: NOW + TICKET_MAX_SKEW_MS + 60000 }), options()).ok, true);
});
test('wrong node, operation, chunk, application and size are each refused', () => {
  assert.deepEqual(verifyTicket(VECTOR_WIRE, options({ expect: { nodeId: `node_${'ee'.repeat(32)}` } })), { ok: false, error: 'WRONG_NODE' });
  assert.deepEqual(verifyTicket(VECTOR_WIRE, options({ expect: { nodeId: NODE, operation: 'get' } })), { ok: false, error: 'WRONG_OPERATION' });
  assert.deepEqual(verifyTicket(VECTOR_WIRE, options({ expect: { nodeId: NODE, chunkId: `chk_${'01'.repeat(32)}` } })), { ok: false, error: 'WRONG_CHUNK' });
  assert.deepEqual(verifyTicket(VECTOR_WIRE, options({ expect: { nodeId: NODE, applicationId: '123e4567-e89b-42d3-a456-426614174001' } })), { ok: false, error: 'WRONG_APPLICATION' });
  assert.deepEqual(verifyTicket(VECTOR_WIRE, options({ expect: { nodeId: NODE, operation: 'put', chunkId: CHUNK, applicationId: APP, size: 4096 } })), { ok: true, claims });
  assert.deepEqual(verifyTicket(VECTOR_WIRE, options({ expect: { nodeId: NODE, size: 4097 } })), { ok: false, error: 'BAD_SIZE' });
  assert.deepEqual(verifyTicket(VECTOR_WIRE, options({ expect: { nodeId: NODE, size: 4095 } })), { ok: false, error: 'BAD_SIZE' }); // a put must be exactly the declared size
  const get = wireOf({ operation: 'get', maxBytes: 4096 });
  assert.equal(verifyTicket(get, options({ expect: { nodeId: NODE, size: 4096 } })).ok, true); assert.equal(verifyTicket(get, options({ expect: { nodeId: NODE, size: 100 } })).ok, true);
  assert.deepEqual(verifyTicket(get, options({ expect: { nodeId: NODE, size: 4097 } })), { ok: false, error: 'BAD_SIZE' });
});
test('sizes: maxBytes 0 is invalid for put and get and required for delete; 8 MiB is the ceiling', () => {
  assert.deepEqual(verifyTicket(wireOf({ maxBytes: 0 }), options()), { ok: false, error: 'BAD_SIZE' });
  assert.deepEqual(verifyTicket(wireOf({ operation: 'get', maxBytes: 0 }), options()), { ok: false, error: 'BAD_SIZE' });
  assert.deepEqual(verifyTicket(wireOf({ operation: 'delete', maxBytes: 1 }), options()), { ok: false, error: 'BAD_SIZE' });
  assert.equal(verifyTicket(wireOf({ operation: 'delete', maxBytes: 0 }), options()).ok, true);
  assert.equal(verifyTicket(wireOf({ maxBytes: 1 }), options()).ok, true);
  assert.equal(verifyTicket(wireOf({ maxBytes: STORAGE_MAX_CHUNK_BYTES }), options()).ok, true);
  assert.throws(() => wireOf({ maxBytes: STORAGE_MAX_CHUNK_BYTES + 1 })); assert.throws(() => wireOf({ maxBytes: -1 })); assert.throws(() => wireOf({ maxBytes: 1.5 }));
  assert.equal(STORAGE_MAX_CHUNK_BYTES, 8 * 1024 * 1024);
  // a hand-built payload with an oversize maxBytes and a good signature is still refused by the verifier
  const payload = encodeTicketPayload({ ...claims, maxBytes: 1 }); payload.writeUInt32BE(STORAGE_MAX_CHUNK_BYTES + 1, 106);
  const forged = base64url(Buffer.concat([payload, sign(null, ticketSigningBytes(payload), signer)]));
  assert.deepEqual(verifyTicket(forged, options()), { ok: false, error: 'BAD_SIZE' });
});
test('the ticket refuses malformed ids and keys when it is built (nothing ambiguous is ever signed)', () => {
  for (const bad of [{ chunkId: `chk_${'AB'.repeat(32)}` }, { chunkId: `chk_${'ab'.repeat(31)}` }, { chunkId: `chk_${'ab'.repeat(32)}\n` }, { chunkId: `CHK_${'ab'.repeat(32)}` }, { nodeId: `node_${'cd'.repeat(31)}` }, { nodeId: `Node_${'cd'.repeat(32)}` },
    { transferId: 'ab'.repeat(15) }, { transferId: 'AB'.repeat(16) }, { nonce: 'ab' }, { applicationId: APP.toUpperCase() }, { applicationId: APP.replaceAll('-', '') }, { kid: 'xyz' }, { holderKey: 'AAAA' }, { holderKey: `${HOLDER_PUB}=` },
    { operation: 'list' as never }, { issuedAt: -1 }, { issuedAt: 2 ** 48 }, { expiresAt: 1.5 }, { issuedAt: Number.NaN }]) assert.throws(() => wireOf(bad), Error, JSON.stringify(bad));
  // a holder key that is not Ed25519 is refused too
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  assert.throws(() => wireOf({ holderKey: rsa }));
});
test('an unknown version or operation code is malformed', () => {
  const bytes = Buffer.from(VECTOR_WIRE, 'base64url');
  for (const [offset, value] of [[0, 2], [0, 0], [25, 0], [25, 4], [25, 255]] as const) { const m = Buffer.from(bytes); m[offset] = value; assert.equal(parseTicket(base64url(m)), undefined, `${offset}:${value}`); }
});
test('canonical form: the same claims in a different property order or with extra properties sign to the same ticket', () => {
  const shuffled = Object.fromEntries(Object.entries(claims).reverse()) as unknown as TicketClaims;
  assert.equal(signTicket(shuffled, signer), VECTOR_WIRE);
  assert.equal(signTicket({ ...claims, extra: 'ignored', operation: 'put' } as TicketClaims, signer), VECTOR_WIRE);
  assert.deepEqual(parseTicket(VECTOR_WIRE)?.claims, claims); // and parsing yields exactly the schema, nothing else
});
test('replay: a transfer id the consumer already holds is refused, consumption is single-use, bounded and forgets only after the ticket can no longer verify', () => {
  const set = new ReplaySet(3);
  assert.equal(verifyTicket(VECTOR_WIRE, options({ replay: set })).ok, true);
  assert.equal(set.consume(claims.transferId, claims.expiresAt, NOW), 'OK');
  assert.deepEqual(verifyTicket(VECTOR_WIRE, options({ replay: set })), { ok: false, error: 'REPLAYED' });
  assert.equal(set.consume(claims.transferId, claims.expiresAt, NOW), 'REPLAYED');
  // still remembered while the ticket could still verify (expiry plus skew), forgotten after
  assert.equal(set.consume(claims.transferId, claims.expiresAt, claims.expiresAt + TICKET_MAX_SKEW_MS - 1), 'REPLAYED');
  assert.equal(set.consume('11'.repeat(16), claims.expiresAt + 100000, claims.expiresAt + TICKET_MAX_SKEW_MS), 'OK'); assert.equal(set.has(claims.transferId), false);
  // bounded: a full set refuses rather than growing or evicting a live id
  const later = claims.expiresAt + TICKET_MAX_SKEW_MS; const live = later + 100000;
  assert.equal(set.consume('22'.repeat(16), live, later), 'OK'); assert.equal(set.consume('33'.repeat(16), live, later), 'OK');
  assert.equal(set.consume('44'.repeat(16), live, later), 'FULL'); assert.equal(set.size, 3);
  assert.throws(() => new ReplaySet(0));
});
test('a key past its notAfter (plus skew) is refused; a current key has no end', () => {
  const retiring = [{ kid: KID, publicKey: SIGNER_PUB, notAfter: NOW + 5000 }];
  assert.equal(verifyTicket(VECTOR_WIRE, options({ keys: retiring, now: NOW + 5000 + TICKET_MAX_SKEW_MS - 1 })).ok, true);
  assert.deepEqual(verifyTicket(VECTOR_WIRE, options({ keys: retiring, now: NOW + 5000 + TICKET_MAX_SKEW_MS })), { ok: false, error: 'UNKNOWN_KID' });
});
test('property: random valid claims round-trip, verify, and stop verifying when any signed field changes', () => {
  for (let i = 0; i < 200; i++) {
    const operation = (['put', 'get', 'delete'] as const)[i % 3] ?? 'put'; const issuedAt = 1_000_000 + Math.floor(Math.random() * 1e12);
    const random: TicketClaims = { kid: KID, transferId: randomBytes(16).toString('hex'), operation, applicationId: crypto.randomUUID(), chunkId: `chk_${randomBytes(32).toString('hex')}`, nodeId: `node_${randomBytes(32).toString('hex')}`,
      maxBytes: operation === 'delete' ? 0 : 1 + Math.floor(Math.random() * (STORAGE_MAX_CHUNK_BYTES - 1)), issuedAt, expiresAt: issuedAt + 1 + Math.floor(Math.random() * (TICKET_MAX_LIFETIME_MS - 1)), holderKey: generateHolderKey().publicKey, nonce: randomBytes(16).toString('hex') };
    const wire = signTicket(random, signer); assert.deepEqual(parseTicket(wire)?.claims, random);
    const ok = verifyTicket(wire, { keys, now: issuedAt, expect: { nodeId: random.nodeId, operation, chunkId: random.chunkId, applicationId: random.applicationId } }); assert.deepEqual(ok, { ok: true, claims: random });
    const other = signTicket({ ...random, nonce: randomBytes(16).toString('hex') }, signer); assert.notEqual(other, wire);
    assert.equal(verifyTicket(wire, { keys, now: issuedAt, expect: { nodeId: random.nodeId, chunkId: `chk_${randomBytes(32).toString('hex')}` } }).ok, false);
  }
});

// ---- Holder binding --------------------------------------------------------------------------------------------------------------------------------------------------------------
const proofInput = { challenge: '11'.repeat(32), transferId: claims.transferId, requestLine: `PUT /v1/chunks/${CHUNK}` };
test('holder proof test vector, and it verifies only for the holder key, challenge, transfer and request line', () => {
  assert.equal(holderProofMessage(proofInput).toString('hex'), '70726976616e65742e686f6c6465722d70726f6f662e763100111111111111111111111111111111111111111111111111111111111111111100112233445566778899aabbccddeeffce7499646247ef04f5c4efc732df90ed2ba8221271b2be0d681f308ab67ebc9c');
  const signature = signHolderProof(holder, proofInput);
  assert.equal(signature, 'fce6934b9a99f263d65ad4895749adc7a7d9b3fdc5a52ff92c5c5b82e1adda73c38c568c20ecf07745cc39110c09cbea705e402fe90d1ea2fb83381e6ded6e09');
  assert.equal(verifyHolderProof(HOLDER_PUB, proofInput, signature), true);
  assert.equal(verifyHolderProof(SIGNER_PUB, proofInput, signature), false); // not the holder key: a stolen ticket is useless
  assert.equal(verifyHolderProof(HOLDER_PUB, { ...proofInput, challenge: '22'.repeat(32) }, signature), false);
  assert.equal(verifyHolderProof(HOLDER_PUB, { ...proofInput, transferId: 'ab'.repeat(16) }, signature), false);
  assert.equal(verifyHolderProof(HOLDER_PUB, { ...proofInput, requestLine: `GET /v1/chunks/${CHUNK}` }, signature), false);
  assert.equal(verifyHolderProof(HOLDER_PUB, { ...proofInput, requestLine: `PUT /v1/chunks/${CHUNK} ` }, signature), false);
});
test('holder proof never throws on bad input and never accepts a malformed signature or key', () => {
  const signature = signHolderProof(holder, proofInput);
  for (const bad of ['', 'zz', signature.slice(1), `${signature}0`, signature.toUpperCase(), signature.replace(/.$/, c => (c === '0' ? '1' : '0'))]) assert.equal(verifyHolderProof(HOLDER_PUB, proofInput, bad), false);
  for (const key of ['', 'AAAA', `${HOLDER_PUB}=`, HOLDER_PUB.slice(0, -2)]) assert.equal(verifyHolderProof(key, proofInput, signature), false);
  for (const input of [{ ...proofInput, challenge: 'xyz' }, { ...proofInput, requestLine: '' }, { ...proofInput, requestLine: 'GET /\n' }, { ...proofInput, requestLine: 'x'.repeat(513) }, { ...proofInput, transferId: 'g'.repeat(32) }]) {
    assert.throws(() => holderProofMessage(input)); assert.equal(verifyHolderProof(HOLDER_PUB, input, signature), false);
  }
  // the ticket and the holder proof can never stand in for one another: different domain strings
  assert.equal(holderProofMessage(proofInput).subarray(0, 25).toString(), 'privanet.holder-proof.v1\0');
});
test('holder key generation and challenges: fresh, canonical, and the private half is never in the public form', () => {
  const a = generateHolderKey(); const b = generateHolderKey(); assert.notEqual(a.publicKey, b.publicKey); assert.equal(a.publicKey.length, 60);
  const challenge = newHolderChallenge(); assert.match(challenge, /^[a-f0-9]{64}$/); assert.notEqual(challenge, newHolderChallenge());
  const input = { ...proofInput, challenge }; assert.equal(verifyHolderProof(a.publicKey, input, signHolderProof(a.privateKey, input)), true); assert.equal(verifyHolderProof(b.publicKey, input, signHolderProof(a.privateKey, input)), false);
  assert.equal(signTicket({ ...claims, holderKey: a.publicKey }, signer).includes(a.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url')), false);
});
