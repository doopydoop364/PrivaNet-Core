import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { ChallengeSchema, CODE_ALPHABET, SessionSchema, formatCode, normalizeCode } from '@privanet/protocol';
import { ApiError, hash, secret } from '@privanet/shared';
import { Coordinator, MAX_ACTIVE_INVITES, MAX_PENDING_REQUESTS_PER_SOURCE } from '@privanet/coordinator/service';
import { PrivaNode } from '@privanet/node/daemon';
import { EnrollError, enrollNode, joinNode } from '@privanet/node/enroll';
import { readEnrollmentRecord, readJoinRecord } from '@privanet/node/enrollment-record';
import { identity } from './helpers.js';
import { BOTH, ECHO, harness, refusal } from './onboarding-harness.js';

type Harness = Awaited<ReturnType<typeof harness>>;
const raw = (f: Harness, path: string, body: unknown, headers: Record<string, string> = {}) => fetch(f.url + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-privanet-protocol': '1', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const redeem = (f: Harness, code: string, key = identity(), extra: object = {}) => raw(f, '/v1/invites/challenge', { code, publicKey: key.publicKey, protocolVersion: 1, daemonVersion: '0.3.0', ...extra });
const wrongSecret = (code: string) => `${code.slice(0, 4)}-${code.slice(5, 8)}${code[8] === '0' ? '1' : '0'}`; // same first half, different second half
const failureOf = async (promise: Promise<unknown>): Promise<EnrollError> => { const error = await promise.then(() => undefined, (e: unknown) => e); assert.ok(error instanceof EnrollError); return error; };
const stateOf = (f: Harness, name: string) => join(f.dir, `state-${name}`);

test('codes: a friendly alphabet, tolerant typing, and nothing else is a code', () => {
  assert.equal(CODE_ALPHABET.length, 32); for (const ambiguous of 'ILOU') assert.equal(CODE_ALPHABET.includes(ambiguous), false);
  assert.equal(normalizeCode('n7k4-pq2m'), 'N7K4PQ2M'); assert.equal(normalizeCode(' N7K4 PQ2M '), 'N7K4PQ2M'); assert.equal(normalizeCode('N7K4PQ2M'), 'N7K4PQ2M');
  assert.equal(normalizeCode('O0I1-LlOo'), '00111100', 'look-alikes fold the way Crockford defines');
  for (const bad of ['', 'N7K4-PQ2', 'N7K4-PQ2MM', 'N7K4-PQ2U', 'N7K4-PQ2!', 'ÉÉÉÉ-ÉÉÉÉ']) assert.equal(normalizeCode(bad), null, bad);
  assert.equal(formatCode('N7K4PQ2M'), 'N7K4-PQ2M');
});

test('invite: created short, stored only as keyed hashes, listed without the code, never logged', async t => {
  const f = await harness(t);
  const created = await f.admin.createInvite({ expiresInMs: 600000, capabilities: ECHO, label: "Judah's PC" });
  assert.match(created.code, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/); assert.match(created.id, /^inv_[a-f0-9]{16}$/); assert.equal(created.expiresAt, f.clock.t + 600000);
  assert.notEqual((await f.admin.createInvite()).code, created.code);
  const plain = created.code.replace('-', ''); const first = plain.slice(0, 4); const second = plain.slice(4);
  // Neither the code, its halves, nor an unkeyed hash of them is in the database or its log.
  for (const file of [f.db, `${f.db}-wal`]) {
    const bytes = await readFile(file).catch(() => Buffer.alloc(0));
    for (const needle of [created.code, plain, plain.toLowerCase(), hash(plain), hash(first), hash(second), hash(created.code)]) assert.equal(bytes.includes(needle), false, `${file} must not hold the code or a plain hash of it`);
  }
  const listing = JSON.stringify(await f.admin.invites()); assert.equal(listing.includes(plain), false); assert.equal(listing.includes(hash(plain)), false);
  const info = (await f.admin.invites()).find(entry => entry.id === created.id);
  assert.deepEqual({ status: info?.status, label: info?.label, capabilities: info?.capabilities, usedAt: info?.usedAt, failedAttempts: info?.failedAttempts, nodeId: info?.nodeId }, { status: 'ACTIVE', label: "Judah's PC", capabilities: ECHO, usedAt: null, failedAttempts: 0, nodeId: null });
  assert.equal(f.text().includes(plain), false); assert.equal(f.text().includes(created.code), false);
  // Lifetimes are short and the request strict.
  for (const body of [{ expiresInMs: 3600001 }, { expiresInMs: 999 }, { label: 'x\ny' }, { capabilities: ['shell.exec'] }, { surprise: 1 }]) assert.equal((await refusal(f.admin.createInvite(body))).status, 400, JSON.stringify(body));
  // The database alone cannot be used to search the code space: a Coordinator with another key (a stolen copy without the administrator secret) cannot redeem it.
  const other = new Coordinator(f.store, {}, () => f.clock.t, undefined, { inviteKey: Buffer.from(hash('some other key'), 'hex') });
  assert.throws(() => other.beginInvite({ code: created.code, publicKey: identity().publicKey, protocolVersion: 1, daemonVersion: '0.3.0' }), (e: unknown) => e instanceof ApiError && e.code === 'INVALID_INVITE');
});

test('invites are off, and inert, on a Coordinator without the key', async t => {
  const f = await harness(t, { invites: false });
  assert.equal((await refusal(f.admin.createInvite())).status, 404); assert.equal((await refusal(f.admin.invites().then(() => undefined))).status, 404);
  assert.equal((await redeem(f, 'N7K4-PQ2M')).status, 404);
});

test('invite: redeemed over the ordinary proof, once, with the owner\'s name and ceiling; the node then reconnects with nothing', async t => {
  const f = await harness(t); const created = await f.admin.createInvite({ capabilities: BOTH, label: 'Judah PC' }); const stateDir = stateOf(f, 'a');
  f.clock.t += 1000;
  const result = await enrollNode({ url: f.url, invite: created.code.toLowerCase().replace('-', ' '), stateDir, allowInsecureLoopback: true }); // typed loosely
  assert.equal(result.outcome, 'ENROLLED'); assert.deepEqual(result.capabilities, BOTH); assert.equal(result.displayName, 'Judah PC');
  assert.equal((await readEnrollmentRecord(stateDir))?.nodeId, result.nodeId);
  const info = (await f.admin.invites())[0]; assert.deepEqual([info?.status, info?.nodeId, info?.usedAt], ['USED', result.nodeId, f.clock.t]);
  assert.equal((await f.admin.nodes())[0]?.displayName, 'Judah PC');
  // The code is spent: another machine, or the same one again with a new identity, is refused.
  assert.equal((await failureOf(enrollNode({ url: f.url, invite: created.code, stateDir: stateOf(f, 'b'), allowInsecureLoopback: true }))).failure, 'INVITE_REFUSED');
  // Restart from stored state alone, as a service would.
  const node = new PrivaNode({ url: f.url, allowInsecureLoopback: true, stateDir, capabilities: BOTH, heartbeatMs: 10 }); await node.tick(); assert.equal(node.status.connected, true);
  // Revoking the node ends it everywhere.
  await f.admin.revokeNode(result.nodeId);
  assert.equal((await refusal(new PrivaNode({ url: f.url, allowInsecureLoopback: true, stateDir, capabilities: BOTH }).tick())).status, 401);
  assert.equal(f.text().includes(created.code.replace('-', '')), false);
});

test('invite: the owner\'s capability ceiling holds, and a refused request does not use the invite up', async t => {
  const f = await harness(t); const created = await f.admin.createInvite({ capabilities: ECHO });
  assert.equal((await failureOf(enrollNode({ url: f.url, invite: created.code, capabilities: ['system.hashchain.v1'], stateDir: stateOf(f, 'a'), allowInsecureLoopback: true }))).failure, 'CAPABILITY_FORBIDDEN');
  assert.equal((await f.admin.invites())[0]?.status, 'ACTIVE');
  assert.deepEqual((await enrollNode({ url: f.url, invite: created.code, stateDir: stateOf(f, 'b'), allowInsecureLoopback: true })).capabilities, ECHO);
});

test('invite: every reason a code fails gets one answer; a near miss is not told apart from nothing', async t => {
  const f = await harness(t, { inviteFailures: 1000 });
  const live = await f.admin.createInvite(); const used = await f.admin.createInvite(); const revoked = await f.admin.createInvite(); const expired = await f.admin.createInvite({ expiresInMs: 1000 }); const locked = await f.admin.createInvite();
  await enrollNode({ url: f.url, invite: used.code, stateDir: stateOf(f, 'u'), allowInsecureLoopback: true }); await f.admin.revokeInvite(revoked.id);
  for (let i = 0; i < 5; i++) await redeem(f, wrongSecret(locked.code)); f.clock.t += 2000;
  const attempts = [used.code, revoked.code, expired.code, locked.code, wrongSecret(live.code), 'AAAA-AAAA', '0000-0000', live.code.slice(0, 5) + 'ZZZZ'];
  const bodies: string[] = [];
  for (const code of attempts) { const response = await redeem(f, code); assert.equal(response.status, 401, code); bodies.push(await response.text()); }
  assert.equal(new Set(bodies).size, 1, 'one status and one body for never-existed, wrong, used, revoked, expired and locked');
  assert.deepEqual(JSON.parse(bodies[0] ?? ''), { error: { code: 'INVALID_INVITE', message: 'invalid invite' } });
  assert.equal((await f.admin.invites()).find(entry => entry.id === live.id)?.status, 'ACTIVE', 'the real invite survived the guessing at its neighbours');
  // The wrong guesses at the live one were counted against it, not against others.
  assert.equal((await f.admin.invites()).find(entry => entry.id === live.id)?.failedAttempts, 2);
  const lockedInfo = (await f.admin.invites()).find(entry => entry.id === locked.id); assert.deepEqual([lockedInfo?.status, lockedInfo?.failedAttempts], ['LOCKED', 5]);
});

test('invite: five wrong guesses at one invite lock it for good, even against the right code', async t => {
  const f = await harness(t, { inviteFailures: 1000 }); const created = await f.admin.createInvite();
  for (let attempt = 0; attempt < 4; attempt++) assert.equal((await redeem(f, wrongSecret(created.code))).status, 401);
  assert.equal((await f.admin.invites())[0]?.status, 'ACTIVE'); assert.equal((await f.admin.invites())[0]?.failedAttempts, 4);
  assert.equal((await redeem(f, wrongSecret(created.code))).status, 401);
  assert.equal((await f.admin.invites())[0]?.status, 'LOCKED');
  assert.equal((await redeem(f, created.code)).status, 401, 'the right code no longer works: the owner issues a new invite');
  assert.equal((await failureOf(enrollNode({ url: f.url, invite: created.code, stateDir: stateOf(f, 'a'), allowInsecureLoopback: true }))).failure, 'INVITE_REFUSED');
  await f.admin.revokeInvite(created.id); assert.equal((await f.admin.invites())[0]?.status, 'REVOKED', 'a locked invite can still be withdrawn explicitly');
});

test('invite: one address is cut off after a few refusals, and says nothing more', async t => {
  const f = await harness(t, { inviteFailures: 3 }); const created = await f.admin.createInvite(); const token = await f.admin.create();
  for (let i = 0; i < 3; i++) assert.equal((await redeem(f, 'AAAA-AAAA')).status, 401);
  const blocked = await redeem(f, created.code); assert.equal(blocked.status, 429); assert.equal(((await blocked.json()) as { error: { code: string } }).error.code, 'RATE_LIMIT');
  assert.equal((await failureOf(enrollNode({ url: f.url, invite: created.code, stateDir: stateOf(f, 'a'), allowInsecureLoopback: true }))).failure, 'RATE_LIMITED');
  assert.equal((await f.admin.invites())[0]?.status, 'ACTIVE', 'the right code was not touched');
  // Other routes are not affected by the invite limit: strong tokens still enroll from the same address.
  assert.equal((await enrollNode({ url: f.url, token: token.token, stateDir: stateOf(f, 'b'), allowInsecureLoopback: true })).outcome, 'ENROLLED');
});

test('invite: the global budget pauses all redemption after too many refusals from anywhere, then recovers', async t => {
  const f = await harness(t, { inviteFailures: 1000, policy: { inviteGlobalFailures: 4, inviteGlobalWindowMs: 60000 } }); const created = await f.admin.createInvite({ expiresInMs: 3600000 });
  for (let i = 0; i < 4; i++) assert.equal((await redeem(f, 'AAAA-AAAA')).status, 401);
  assert.equal((await redeem(f, created.code)).status, 429, 'paused for everyone, even with the right code');
  f.clock.t += 61000;
  assert.equal((await enrollNode({ url: f.url, invite: created.code, stateDir: stateOf(f, 'a'), allowInsecureLoopback: true })).outcome, 'ENROLLED');
});

test('invite: expiry, revocation and a bounded number of live invites', async t => {
  const f = await harness(t); const a = await f.admin.createInvite({ expiresInMs: 5000 }); const b = await f.admin.createInvite();
  await f.admin.revokeInvite(b.id); await f.admin.revokeInvite(b.id); assert.equal((await failureOf(enrollNode({ url: f.url, invite: b.code, stateDir: stateOf(f, 'b'), allowInsecureLoopback: true }))).failure, 'INVITE_REFUSED');
  f.clock.t += 6000; assert.equal((await failureOf(enrollNode({ url: f.url, invite: a.code, stateDir: stateOf(f, 'a'), allowInsecureLoopback: true }))).failure, 'INVITE_REFUSED');
  assert.deepEqual((await f.admin.invites()).map(entry => entry.status).sort(), ['EXPIRED', 'REVOKED']);
  const c = await f.admin.createInvite(); await enrollNode({ url: f.url, invite: c.code, stateDir: stateOf(f, 'c'), allowInsecureLoopback: true });
  assert.equal((await refusal(f.admin.revokeInvite(c.id))).code, 'INVITE_ALREADY_USED'); assert.equal((await refusal(f.admin.revokeInvite('inv_0000000000000000'))).code, 'NOT_FOUND');
  for (let i = 0; i < MAX_ACTIVE_INVITES; i++) f.core.createInvite({ expiresInMs: 600000, capabilities: ECHO });
  assert.equal((await refusal(f.admin.createInvite())).code, 'INVITE_LIMIT');
});

test('invite: of many simultaneous redemptions of one code exactly one node is enrolled', async t => {
  // The per-address limit has its own test; this one is about single use.
  const f = await harness(t, { inviteFailures: 1000 }); const created = await f.admin.createInvite();
  const outcomes = await Promise.allSettled(Array.from({ length: 8 }, (_, index) => enrollNode({ url: f.url, invite: created.code, stateDir: stateOf(f, `n${index}`), allowInsecureLoopback: true })));
  assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1);
  for (const outcome of outcomes) if (outcome.status === 'rejected') { assert.ok(outcome.reason instanceof EnrollError); assert.equal(outcome.reason.failure, 'INVITE_REFUSED'); }
  assert.equal((await f.admin.nodes()).length, 1);
  // The same past the challenge: eight valid proofs from eight keys, all holding a challenge from the one code.
  const second = await f.admin.createInvite(); const keys = Array.from({ length: 8 }, () => identity());
  const challenges = await Promise.all(keys.map(async key => ChallengeSchema.parse(await (await redeem(f, second.code, key)).json())));
  const proofs = await Promise.allSettled(challenges.map((challenge, index) => f.transport.request('POST', '/v1/enrollment/proof', SessionSchema, keys[index]?.proof(challenge))));
  assert.equal(proofs.filter(proof => proof.status === 'fulfilled').length, 1); assert.equal((await f.admin.nodes()).length, 2);
});

test('invite: malformed requests are rejected before anything is looked up, and the code is never echoed', async t => {
  const f = await harness(t, { inviteFailures: 1000 }); const created = await f.admin.createInvite(); const key = identity();
  const good = { code: created.code, publicKey: key.publicKey, protocolVersion: 1, daemonVersion: '0.3.0' };
  const cases: Array<[string, Promise<Response>, number]> = [
    ['not json', raw(f, '/v1/invites/challenge', '{nope'), 400], ['wrong content type', raw(f, '/v1/invites/challenge', good, { 'content-type': 'text/plain' }), 415],
    ['short code', raw(f, '/v1/invites/challenge', { ...good, code: 'ABC' }), 400], ['long code', raw(f, '/v1/invites/challenge', { ...good, code: 'A'.repeat(40) }), 400],
    ['symbols in the code', raw(f, '/v1/invites/challenge', { ...good, code: "'; DROP--" }), 400], ['code of the wrong type', raw(f, '/v1/invites/challenge', { ...good, code: 12345678 }), 400],
    ['unknown field', raw(f, '/v1/invites/challenge', { ...good, admin: true }), 400], ['bad key', raw(f, '/v1/invites/challenge', { ...good, publicKey: 'x'.repeat(60) }), 400],
    ['other protocol (body)', raw(f, '/v1/invites/challenge', { ...good, protocolVersion: 2 }), 426], ['other protocol (header)', raw(f, '/v1/invites/challenge', good, { 'x-privanet-protocol': '2' }), 426],
    ['oversized', raw(f, '/v1/invites/challenge', JSON.stringify({ ...good, junk: 'x'.repeat(40000) })), 413], ['GET', fetch(`${f.url}/v1/invites/challenge`, { headers: { 'x-privanet-protocol': '1' } }), 401],
  ];
  for (const [name, request, status] of cases) { const response = await request; const body = await response.text(); assert.equal(response.status, status, name); assert.equal(body.includes(created.code), false, `${name}: not echoed`); assert.equal(body.includes(created.code.replace('-', '')), false); }
  assert.equal((await f.admin.invites())[0]?.status, 'ACTIVE'); assert.equal((await f.admin.invites())[0]?.failedAttempts, 0, 'malformed requests are not guesses');
  assert.equal(f.text().includes(created.code.replace('-', '')), false);
});

// ---- approval (device-code) flow ----------------------------------------------------------------------------------------------------------------------------------------------
const waitFor = async <T>(what: string, check: () => T | undefined | false | Promise<T | undefined | false>, ms = 8000): Promise<T> => {
  const deadline = Date.now() + ms; for (;;) { const value = await check(); if (value) return value; if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`); await new Promise(resolve => setTimeout(resolve, 20)); }
};
async function startJoin(f: Harness, name: string, extra: Partial<Parameters<typeof joinNode>[0]> = {}) {
  const stateDir = stateOf(f, name); const seen: Array<{ code: string; nodeId: string; resumed: boolean }> = [];
  const promise = joinNode({ url: f.url, stateDir, allowInsecureLoopback: true, pollMs: 25, onRequested: info => seen.push(info), ...extra });
  promise.catch(() => undefined);
  const info = await waitFor('the request to exist', () => seen[0]); return { stateDir, promise, info };
}

test('approval: the machine asks, the owner approves with a ceiling and a name, the machine finishes by itself', async t => {
  const f = await harness(t); const { promise, info, stateDir } = await startJoin(f, 'a', { deviceName: 'garage', capabilities: ECHO });
  assert.match(info.code, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  const [pending] = await f.admin.requests();
  assert.deepEqual([pending?.code, pending?.status, pending?.nodeId, pending?.deviceName, pending?.requestedCapabilities, pending?.approvedCapabilities], [info.code, 'PENDING', info.nodeId, 'garage', ECHO, null]);
  assert.match(pending?.source ?? '', /127\.0\.0\.1/);
  assert.equal((await f.admin.nodes()).length, 0, 'nothing is registered before approval');
  await f.admin.approve(info.code.toLowerCase(), { capabilities: ECHO, label: "Judah's PC" });
  const result = await promise;
  assert.equal(result.outcome, 'ENROLLED'); assert.deepEqual(result.capabilities, ECHO); assert.equal(result.displayName, "Judah's PC"); assert.equal(result.nodeId, info.nodeId);
  assert.equal((await readEnrollmentRecord(stateDir))?.nodeId, info.nodeId); assert.equal(await readJoinRecord(stateDir), undefined, 'the waiting request is cleaned up');
  const [done] = await f.admin.requests(); assert.deepEqual([done?.status, done?.nodeEnrolled, done?.approvedCapabilities, done?.label], ['COMPLETED', info.nodeId, ECHO, "Judah's PC"]);
  const node = new PrivaNode({ url: f.url, allowInsecureLoopback: true, stateDir, capabilities: ECHO, heartbeatMs: 10 }); await node.tick(); assert.equal(node.status.connected, true);
  for (const word of ['join.requested', 'join.approved']) assert.ok(f.logs.some(entry => (entry as { event: string }).event === word), word);
  assert.equal(f.text().includes(info.code.replace('-', '')), false, 'the code is not logged'); assert.equal(f.text().includes(info.nodeId), false);
});

test('approval: the owner chooses what is allowed, whatever the machine asked for', async t => {
  const f = await harness(t); const { promise, info } = await startJoin(f, 'a', { capabilities: BOTH });
  await f.admin.approve(info.code, { capabilities: ECHO }); assert.deepEqual((await promise).capabilities, ECHO);
  assert.deepEqual((await f.admin.nodes())[0]?.capabilities, ECHO);
});

test('approval: nothing completes before approval, and an unapproved request can never become a node', async t => {
  const f = await harness(t); const key = identity();
  const created = await (await raw(f, '/v1/join/request', { publicKey: key.publicKey, protocolVersion: 1, daemonVersion: '0.3.0' })).json() as { requestId: string; code: string; pollAfterMs: number };
  assert.ok(created.pollAfterMs >= 500);
  const status = async () => ((await (await raw(f, '/v1/join/status', { requestId: created.requestId, protocolVersion: 1 })).json()) as { status: string }).status;
  assert.equal(await status(), 'PENDING');
  const early = await raw(f, '/v1/join/challenge', { requestId: created.requestId, protocolVersion: 1 }); assert.equal(early.status, 401); assert.equal(((await early.json()) as { error: { code: string } }).error.code, 'INVALID_JOIN');
  // The code is a name, not a credential: it is no use as a request ID or as a bearer secret.
  assert.equal((await raw(f, '/v1/join/challenge', { requestId: created.code, protocolVersion: 1 })).status, 400);
  for (const header of [{ authorization: `Bearer ${created.requestId.replaceAll('-', '').repeat(2)}` }, { authorization: `Bearer ${hash(created.code)}` }]) assert.equal((await fetch(`${f.url}/v1/admin/requests`, { headers: { 'x-privanet-protocol': '1', ...header } })).status, 401);
  assert.equal((await raw(f, `/v1/admin/requests/${created.code}/approve`, { capabilities: ECHO })).status, 401, 'the public side cannot approve');
  assert.equal((await raw(f, `/v1/admin/requests/${created.code}/approve`, { capabilities: ECHO }, { authorization: `Bearer ${secret()}` })).status, 401);
  assert.equal(await status(), 'PENDING'); assert.equal((await f.admin.nodes()).length, 0);
  // Unknown and expired requests are the same answer.
  assert.equal(((await (await raw(f, '/v1/join/status', { requestId: '00000000-0000-4000-8000-000000000000', protocolVersion: 1 })).json()) as { status: string }).status, 'EXPIRED');
});

test('approval: a request is bound to its key, so knowing its ID is no use without the private key', async t => {
  const f = await harness(t); const owner = identity(); const attacker = identity();
  const created = await (await raw(f, '/v1/join/request', { publicKey: owner.publicKey, protocolVersion: 1, daemonVersion: '0.3.0' })).json() as { requestId: string; code: string };
  await f.admin.approve(created.code, { capabilities: ECHO });
  // Someone who learned the request ID gets the challenge for the OWNER's key and cannot sign it with another key.
  const stolen = ChallengeSchema.parse(await (await raw(f, '/v1/join/challenge', { requestId: created.requestId, protocolVersion: 1 })).json());
  assert.equal((await refusal(f.transport.request('POST', '/v1/enrollment/proof', SessionSchema, attacker.proof(stolen)))).code, 'INVALID_PROOF');
  assert.equal((await f.admin.nodes()).length, 0);
  // The real machine, holding its key, still completes with a fresh challenge.
  const fresh = ChallengeSchema.parse(await (await raw(f, '/v1/join/challenge', { requestId: created.requestId, protocolVersion: 1 })).json());
  assert.ok((await f.transport.request('POST', '/v1/enrollment/proof', SessionSchema, owner.proof(fresh))).token);
  assert.equal((await f.admin.nodes()).length, 1);
});

test('approval: denied, expired and withdrawn requests cannot complete', async t => {
  const f = await harness(t, { policy: { joinRequestMs: 5000 } });
  const denied = await startJoin(f, 'denied'); await f.admin.deny(denied.info.code);
  const failure = await failureOf(denied.promise); assert.equal(failure.failure, 'REQUEST_DENIED'); assert.equal(await readJoinRecord(denied.stateDir), undefined);
  const key = identity(); const made = await (await raw(f, '/v1/join/request', { publicKey: key.publicKey, protocolVersion: 1, daemonVersion: '0.3.0' })).json() as { requestId: string; code: string };
  await f.admin.deny(made.code); assert.equal((await raw(f, '/v1/join/challenge', { requestId: made.requestId, protocolVersion: 1 })).status, 401);
  // Approved but withdrawn before use.
  const other = identity(); const second = await (await raw(f, '/v1/join/request', { publicKey: other.publicKey, protocolVersion: 1, daemonVersion: '0.3.0' })).json() as { requestId: string; code: string };
  await f.admin.approve(second.code, { capabilities: ECHO }); await f.admin.deny(second.code); assert.equal((await raw(f, '/v1/join/challenge', { requestId: second.requestId, protocolVersion: 1 })).status, 401);
  // Expired: both for the machine and for the owner.
  const third = identity(); const late = await (await raw(f, '/v1/join/request', { publicKey: third.publicKey, protocolVersion: 1, daemonVersion: '0.3.0' })).json() as { requestId: string; code: string };
  f.clock.t += 6000;
  assert.equal(((await (await raw(f, '/v1/join/status', { requestId: late.requestId, protocolVersion: 1 })).json()) as { status: string }).status, 'EXPIRED');
  assert.equal((await refusal(f.admin.approve(late.code))).status, 404); assert.equal((await raw(f, '/v1/join/challenge', { requestId: late.requestId, protocolVersion: 1 })).status, 401);
  assert.equal((await f.admin.nodes()).length, 0);
  // A machine that waited out the request is told so and may ask again.
  const waiting = await startJoin(f, 'late'); f.clock.t += 6000;
  assert.equal((await failureOf(waiting.promise)).failure, 'REQUEST_EXPIRED');
  const again = await startJoin(f, 'late'); await f.admin.approve(again.info.code, { capabilities: ECHO }); assert.equal((await again.promise).outcome, 'ENROLLED');
});

test('approval: approving twice is refused, an unknown code is not found, and the request list shows decisions', async t => {
  const f = await harness(t); const { promise, info } = await startJoin(f, 'a');
  await f.admin.approve(info.code, { capabilities: ECHO }); assert.equal((await refusal(f.admin.approve(info.code))).code, 'REQUEST_NOT_PENDING');
  await promise; assert.equal((await refusal(f.admin.approve('AAAA-AAAA'))).code, 'NOT_FOUND'); assert.equal((await refusal(f.admin.approve('nope'))).status, 400);
  assert.equal((await refusal(f.admin.approve('AAAA-AAAU'))).status, 404, 'U is not in the alphabet: not a code');
  assert.equal((await refusal(f.admin.approve(info.code))).status, 404, 'a request that was used is gone for approval purposes');
});

test('approval: the machine polls politely, gives up cleanly and resumes the same request', async t => {
  const f = await harness(t); const stateDir = stateOf(f, 'a'); let polls = 0; const naps: number[] = [];
  const first = joinNode({ url: f.url, stateDir, allowInsecureLoopback: true, maxWaitMs: 150, sleep: async ms => { polls++; naps.push(ms); await new Promise(resolve => setTimeout(resolve, 40)); } });
  const failure = await first.then(() => undefined, (e: unknown) => e); assert.ok(failure instanceof EnrollError); assert.equal(failure.failure, 'GAVE_UP'); assert.ok(polls >= 2 && polls < 10, `bounded polling, saw ${polls}`);
  assert.ok(naps.every(ms => ms >= 1000), 'it asks no more often than the Coordinator suggests (at least a second), unless a test says otherwise');
  const saved = await readJoinRecord(stateDir); assert.ok(saved); assert.equal((await f.admin.requests()).length, 1, 'one request is waiting');
  // Running it again resumes the same request instead of making another.
  const seen: boolean[] = []; const resumed = joinNode({ url: f.url, stateDir, allowInsecureLoopback: true, pollMs: 25, onRequested: info => seen.push(info.resumed) }); resumed.catch(() => undefined);
  await waitFor('resume', () => seen.length > 0); assert.deepEqual(seen, [true]); assert.equal((await f.admin.requests()).length, 1);
  await f.admin.approve((await f.admin.requests())[0]?.code ?? '', { capabilities: ECHO }); assert.equal((await resumed).outcome, 'ENROLLED');
});

test('approval: completion is single use under concurrency and replay', async t => {
  const f = await harness(t); const key = identity();
  const made = await (await raw(f, '/v1/join/request', { publicKey: key.publicKey, protocolVersion: 1, daemonVersion: '0.3.0' })).json() as { requestId: string; code: string };
  await f.admin.approve(made.code, { capabilities: ECHO });
  const challenges = await Promise.all(Array.from({ length: 8 }, async () => ChallengeSchema.parse(await (await raw(f, '/v1/join/challenge', { requestId: made.requestId, protocolVersion: 1 })).json())));
  const proofs = await Promise.allSettled(challenges.map(challenge => f.transport.request('POST', '/v1/enrollment/proof', SessionSchema, key.proof(challenge))));
  assert.equal(proofs.filter(proof => proof.status === 'fulfilled').length, 1, 'exactly one completion'); assert.equal((await f.admin.nodes()).length, 1);
  const first = challenges[0]; assert.ok(first); assert.equal((await refusal(f.transport.request('POST', '/v1/enrollment/proof', SessionSchema, key.proof(first)))).status, 401, 'a replayed proof is refused');
  assert.equal((await raw(f, '/v1/join/challenge', { requestId: made.requestId, protocolVersion: 1 })).status, 401, 'a completed request cannot be completed again');
  assert.equal(((await (await raw(f, '/v1/join/status', { requestId: made.requestId, protocolVersion: 1 })).json()) as { status: string }).status, 'COMPLETED');
});

test('approval: requests are bounded, one per key, and a registered node cannot ask again', async t => {
  const f = await harness(t); const ask = (key = identity()) => raw(f, '/v1/join/request', { publicKey: key.publicKey, protocolVersion: 1, daemonVersion: '0.3.0' });
  const key = identity(); assert.equal((await ask(key)).status, 200); const duplicate = await ask(key); assert.equal(duplicate.status, 409); assert.equal(((await duplicate.json()) as { error: { code: string } }).error.code, 'REQUEST_PENDING');
  for (let i = 1; i < MAX_PENDING_REQUESTS_PER_SOURCE; i++) assert.equal((await ask()).status, 200);
  const limited = await ask(); assert.equal(limited.status, 429); assert.equal(((await limited.json()) as { error: { code: string } }).error.code, 'REQUEST_LIMIT');
  for (const body of [{ publicKey: 'x'.repeat(60), protocolVersion: 1, daemonVersion: '0.3.0' }, { publicKey: key.publicKey, protocolVersion: 2, daemonVersion: '0.3.0' }, { publicKey: key.publicKey, protocolVersion: 1, daemonVersion: '0.3.0', deviceName: '<b>' }, { publicKey: key.publicKey, protocolVersion: 1, daemonVersion: '0.3.0', extra: 1 }]) assert.ok([400, 426].includes((await raw(f, '/v1/join/request', body)).status));
  const done = await f.admin.create(); const registered = await enrollNode({ url: f.url, token: done.token, stateDir: stateOf(f, 'r'), allowInsecureLoopback: true });
  assert.equal(registered.outcome, 'ENROLLED');
  assert.equal((await joinNode({ url: f.url, stateDir: stateOf(f, 'r'), allowInsecureLoopback: true, pollMs: 25 })).outcome, 'ALREADY_ENROLLED', 'an enrolled node just reports that it is enrolled, and asks for nothing');
});
