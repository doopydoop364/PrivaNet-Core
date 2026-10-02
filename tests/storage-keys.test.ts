import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPublicKey } from 'node:crypto';
import { TICKET_MAX_LIFETIME_MS, TICKET_MAX_SKEW_MS } from '@privanet/protocol';
import { signTicket, transferKeyId, verifyTicket } from '@privanet/shared';
import { KEYRING_FILE, KEY_OVERLAP_MS, KeyringError, TransferKeyring } from '@privanet/coordinator/transfer-keys';
import { storageRig } from './storage-rig.js';

const posix = process.platform !== 'win32';
async function tmp(t: { after: (fn: () => Promise<void>) => void }) { const dir = await mkdtemp(join(tmpdir(), 'privanet-keys-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }
const codeOf = async (promise: Promise<unknown>) => { try { await promise; } catch (error) { if (error instanceof KeyringError) return error.code; throw error; } return 'NO_ERROR'; };

test('the keyring is created on first use as a private file, with a kid derived from its public key, and reopening finds the same key', async t => {
  const dir = await tmp(t); const ring = await TransferKeyring.open(dir); const first = ring.current();
  assert.equal(first.kid, transferKeyId(first.publicKey)); assert.match(first.kid, /^[a-f0-9]{16}$/);
  assert.deepEqual(createPublicKey(first.privateKey).export({ format: 'der', type: 'spki' }).toString('base64'), first.publicKey);
  if (posix) { const stat = await lstat(join(dir, KEYRING_FILE)); assert.equal(stat.mode & 0o777, 0o600); }
  assert.deepEqual((await readdir(dir)).filter(name => name.endsWith('.tmp')), []); // no temporary file is left behind
  const again = await TransferKeyring.open(dir); assert.equal(again.current().kid, first.kid); assert.equal(again.size, 1);
});
test('concurrent first starts agree on exactly one key', async t => {
  const dir = await tmp(t); const rings = await Promise.all(Array.from({ length: 12 }, () => TransferKeyring.open(dir)));
  assert.equal(new Set(rings.map(ring => ring.current().kid)).size, 1); assert.deepEqual((await readdir(dir)).sort(), [KEYRING_FILE]);
  assert.equal((await TransferKeyring.open(dir)).current().kid, rings[0]?.current().kid);
});
test('the private key never leaves: it is not in the SQLite database, a backup of it, a verification-key list, a summary or any API shape', async t => {
  const rig = await storageRig(t, { dbFile: true }); const ring = rig.keyring; assert(ring);
  const privateKey = JSON.parse(await readFile(join(rig.dir, KEYRING_FILE), 'utf8')).keys[0].privateKey as string; assert(privateKey.length > 40);
  const app = rig.app(); rig.node(); rig.core.storage.place(app.record, { chunkId: rig.chunk().id, size: 10, holderKey: rig.holder().publicKey });
  for (const name of await readdir(rig.dir)) { if (name === KEYRING_FILE) continue; assert.equal((await readFile(join(rig.dir, name))).includes(privateKey), false, name); }
  for (const value of [rig.core.storage.transferKeys(rig.core.store.coordinatorId), rig.core.storage.summary()]) { assert.equal(JSON.stringify(value).includes(privateKey), false); assert.equal(JSON.stringify(value).includes('privateKey'), false); }
  // the real backup script copies only the database
  const { execFileSync } = await import('node:child_process'); const target = join(rig.dir, 'backup.sqlite');
  rig.store.close(); execFileSync(process.execPath, ['scripts/backup.mjs', target], { env: { ...process.env, PRIVANET_DATA_DIR: rig.dir }, stdio: 'pipe' });
  assert.equal((await readFile(target)).includes(privateKey), false); await rig.restart();
});
test('rotation: a new key signs, the old key keeps verifying only for the overlap, then disappears from what nodes are told', async t => {
  const rig = await storageRig(t); const app = rig.app(); const node = rig.node(); const holder = rig.holder();
  const first = rig.core.storage.place(app.record, { chunkId: rig.chunk().id, size: 10, holderKey: holder.publicKey }).grant; assert(first);
  const rotation = await rig.core.storage.rotateKeys(); assert.notEqual(rotation.currentKid, rotation.previousKid); assert.equal(rotation.previousValidUntil, rig.clock.t + KEY_OVERLAP_MS);
  const second = rig.core.storage.place(app.record, { chunkId: rig.chunk().id, size: 10, holderKey: holder.publicKey }).grant; assert(second);
  const kidOf = (ticket: string) => ticket && rig.core.storage.transferKeys(rig.core.store.coordinatorId).keys.find(key => verifyTicket(ticket, { keys: [key], now: rig.clock.t, expect: { nodeId: node.nodeId } }).ok)?.kid;
  assert.equal(kidOf(second.ticket), rotation.currentKid); assert.equal(kidOf(first.ticket), rotation.previousKid); // both verify during the overlap
  const keys = rig.core.storage.transferKeys(rig.core.store.coordinatorId).keys; assert.deepEqual(keys.map(key => key.kid), [rotation.currentKid, rotation.previousKid]); assert.equal(keys[0]?.notAfter, null); assert.equal(keys[1]?.notAfter, rotation.previousValidUntil);
  rig.advance(KEY_OVERLAP_MS - 1); assert.equal(rig.core.storage.transferKeys(rig.core.store.coordinatorId).keys.length, 2);
  rig.advance(1); const after = rig.core.storage.transferKeys(rig.core.store.coordinatorId).keys; assert.deepEqual(after.map(key => key.kid), [rotation.currentKid]);
  assert.deepEqual(verifyTicket(first.ticket, { keys: after, now: rig.clock.t, expect: { nodeId: node.nodeId } }), { ok: false, error: 'UNKNOWN_KID' }); // removed key
  // a node holding the old list still refuses the old key once its own notAfter passes
  assert.deepEqual(verifyTicket(first.ticket, { keys, now: rig.clock.t + TICKET_MAX_SKEW_MS, expect: { nodeId: node.nodeId } }), { ok: false, error: 'UNKNOWN_KID' });
  assert.equal(TICKET_MAX_LIFETIME_MS * 2 + TICKET_MAX_SKEW_MS, KEY_OVERLAP_MS);
});
test('the overlap is long enough that a ticket signed just before rotation is still verifiable until it expires', () => {
  assert(KEY_OVERLAP_MS >= TICKET_MAX_LIFETIME_MS + TICKET_MAX_SKEW_MS);
});
test('rotation persists across restarts, drops expired keys on open, and refuses to pile up live keys', async t => {
  const dir = await tmp(t); const clock = { t: 5_000_000 }; const ring = await TransferKeyring.open(dir, () => clock.t); const original = ring.current().kid;
  const r1 = await ring.rotate(); const reopened = await TransferKeyring.open(dir, () => clock.t); assert.equal(reopened.current().kid, r1.currentKid); assert.deepEqual(reopened.verificationKeys().map(key => key.kid), [r1.currentKid, original]);
  clock.t += KEY_OVERLAP_MS; const later = await TransferKeyring.open(dir, () => clock.t); assert.deepEqual(later.verificationKeys().map(key => key.kid), [r1.currentKid]); assert.equal(later.size, 1);
  assert.equal(JSON.parse(await readFile(join(dir, KEYRING_FILE), 'utf8')).keys.length, 1); // pruned on disk too
  const spam = await TransferKeyring.open(await tmp(t), () => clock.t); await spam.rotate(); await spam.rotate(); await spam.rotate();
  assert.equal(await codeOf(spam.rotate()), 'KEYRING_LIMIT'); assert.equal(spam.size, 4); clock.t += KEY_OVERLAP_MS; await spam.rotate(); assert.equal(spam.size, 2);
});
test('concurrent rotations are serialized: every one succeeds or is refused, and the file always agrees with memory', async t => {
  const dir = await tmp(t); const ring = await TransferKeyring.open(dir); const results = await Promise.allSettled([ring.rotate(), ring.rotate(), ring.rotate(), ring.rotate(), ring.rotate()]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 3); const onDisk = JSON.parse(await readFile(join(dir, KEYRING_FILE), 'utf8')) as { keys: { kid: string; retireAt: number | null }[] };
  assert.equal(onDisk.keys.length, ring.size); assert.equal(onDisk.keys.filter(key => key.retireAt === null).length, 1); assert.equal(onDisk.keys.find(key => key.retireAt === null)?.kid, ring.currentKid);
});
test('a damaged keyring is a hard error with a fixed code, is never silently replaced, and leaves the file as it was', async t => {
  const make = async () => { const dir = await tmp(t); await TransferKeyring.open(dir); return dir; };
  const good = async (dir: string) => JSON.parse(await readFile(join(dir, KEYRING_FILE), 'utf8')) as { version: number; keys: Record<string, unknown>[] };
  const cases: [string, (g: Awaited<ReturnType<typeof good>>) => string][] = [
    ['empty', () => ''], ['not json', () => '{nope'], ['array', () => '[]'], ['truncated', () => JSON.stringify({ version: 1, keys: [] })], ['wrong version', g => JSON.stringify({ ...g, version: 2 })],
    ['extra property', g => JSON.stringify({ ...g, extra: 1 })], ['extra key property', g => JSON.stringify({ ...g, keys: [{ ...g.keys[0], extra: 1 }] })],
    ['kid does not match key', g => JSON.stringify({ ...g, keys: [{ ...g.keys[0], kid: 'ffffffffffffffff' }] })], ['public key does not match private', g => JSON.stringify({ ...g, keys: [{ ...g.keys[0], publicKey: 'MCowBQYDK2VwAyEA6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iw=' }] })],
    ['garbage private key', g => JSON.stringify({ ...g, keys: [{ ...g.keys[0], privateKey: 'A'.repeat(80) }] })], ['no current key', g => JSON.stringify({ ...g, keys: [{ ...g.keys[0], retireAt: 5 }] })],
    ['two current keys', g => JSON.stringify({ ...g, keys: [g.keys[0], g.keys[0]] })],
  ];
  for (const [name, mutate] of cases) {
    const dir = await make(); const original = await good(dir); const text = mutate(original); await writeFile(join(dir, KEYRING_FILE), text, { mode: 0o600 });
    const code = await codeOf(TransferKeyring.open(dir)); assert.ok(code === 'KEYRING_INVALID' || code === 'KEYRING_UNSAFE', `${name}: ${code}`);
    assert.equal(await readFile(join(dir, KEYRING_FILE), 'utf8'), text, `${name}: the file was changed`);
  }
  // an RSA private key in the right place is not an Ed25519 key
  const { generateKeyPairSync } = await import('node:crypto'); const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }); const dir = await make(); const g = await good(dir);
  await writeFile(join(dir, KEYRING_FILE), JSON.stringify({ ...g, keys: [{ ...g.keys[0], privateKey: rsa.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64') }] }), { mode: 0o600 }); assert.equal(await codeOf(TransferKeyring.open(dir)), 'KEYRING_INVALID');
});
test('an unsafe keyring file (a link, readable by others, oversized) is refused, never read through and never replaced', async t => {
  const big = await tmp(t); await TransferKeyring.open(big); await writeFile(join(big, KEYRING_FILE), 'x'.repeat(20000), { mode: 0o600 }); assert.equal(await codeOf(TransferKeyring.open(big)), 'KEYRING_UNSAFE');
  const linked = await tmp(t); const real = await tmp(t); await TransferKeyring.open(real); await symlink(join(real, KEYRING_FILE), join(linked, KEYRING_FILE)).catch(() => undefined);
  if ((await lstat(join(linked, KEYRING_FILE)).catch(() => undefined))?.isSymbolicLink()) assert.equal(await codeOf(TransferKeyring.open(linked)), 'KEYRING_UNSAFE');
  if (posix && process.getuid?.() !== 0) { const open = await tmp(t); await TransferKeyring.open(open); await chmod(join(open, KEYRING_FILE), 0o644); assert.equal(await codeOf(TransferKeyring.open(open)), 'KEYRING_UNSAFE'); }
  else if (posix) { const open = await tmp(t); await TransferKeyring.open(open); await chmod(join(open, KEYRING_FILE), 0o644); assert.equal(await codeOf(TransferKeyring.open(open)), 'KEYRING_UNSAFE'); }
});
test('losing the keyring is survivable: a new key is generated, and tickets signed by the lost key stop verifying (they lived two minutes anyway)', async t => {
  const rig = await storageRig(t); const app = rig.app(); const node = rig.node(); const ticket = rig.core.storage.place(app.record, { chunkId: rig.chunk().id, size: 5, holderKey: rig.holder().publicKey }).grant?.ticket ?? '';
  const fresh = await TransferKeyring.open(await tmp(t), () => rig.clock.t);
  assert.deepEqual(verifyTicket(ticket, { keys: fresh.verificationKeys(), now: rig.clock.t, expect: { nodeId: node.nodeId } }), { ok: false, error: 'UNKNOWN_KID' });
});
test('a ticket signed with a key that is not the keyring\'s current key never verifies, even with a self-consistent key entry', async t => {
  const rig = await storageRig(t); const node = rig.node(); const stranger = await TransferKeyring.open(await tmp(t)); const { privateKey, kid, publicKey } = stranger.current();
  const ticket = signTicket({ kid, transferId: 'ab'.repeat(16), operation: 'get', applicationId: crypto.randomUUID(), chunkId: `chk_${'ab'.repeat(32)}`, nodeId: node.nodeId, maxBytes: 5, issuedAt: rig.clock.t, expiresAt: rig.clock.t + 1000, holderKey: rig.holder().publicKey, nonce: 'cd'.repeat(16) }, privateKey);
  assert.equal(rig.verify(ticket, node.nodeId).ok, false); assert.equal(verifyTicket(ticket, { keys: [{ kid, publicKey, notAfter: null }], now: rig.clock.t, expect: { nodeId: node.nodeId } }).ok, true); // only the key list decides
});
