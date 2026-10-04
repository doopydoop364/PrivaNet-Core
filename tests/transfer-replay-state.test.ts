import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersistentReplaySet, REPLAY_STATE_FILE, ReplayStateError } from '@privanet/node/store/replay-state';
import { TICKET_MAX_SKEW_MS } from '@privanet/protocol';
import { generateHolderKey, signTicket, transferKeyId, verifyTicket } from '@privanet/shared';
import { randomUUID } from 'node:crypto';

const now = 1_000_000;
const id = (n: number) => n.toString(16).padStart(32, '0');
async function directory(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await mkdtemp(join(tmpdir(), 'privanet-replay-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir;
}
const errorCode = (code: ReplayStateError['code']) => (error: unknown) => error instanceof ReplayStateError && error.code === code;

test('durable replay gate permits exactly one concurrent consumer and restart keeps every consumed id', async t => {
  const dir = await directory(t); const set = await PersistentReplaySet.open(dir);
  const duplicates = await Promise.all(Array.from({ length: 100 }, () => set.consume(id(1), now + 120000, now)));
  assert.equal(duplicates.filter(value => value === 'OK').length, 1);
  assert.equal(duplicates.filter(value => value === 'REPLAYED').length, 99);
  const distinct = await Promise.all(Array.from({ length: 100 }, (_, i) => set.consume(id(i + 2), now + 120000, now)));
  assert(distinct.every(value => value === 'OK'));
  const reopened = await PersistentReplaySet.open(dir); assert.equal(reopened.size, 101);
  for (let i = 1; i <= 101; i++) assert.equal(await reopened.consume(id(i), now + 120000, now), 'REPLAYED');
});

test('consumption is bounded and cleanup forgets only ids outside the complete expiry/skew window', async t => {
  const dir = await directory(t); const set = await PersistentReplaySet.open(dir, { maxEntries: 2 });
  assert.equal(await set.consume(id(1), now + 1, now), 'OK');
  assert.equal(await set.consume(id(2), now + 120000, now), 'OK');
  assert.equal(await set.consume(id(3), now + 120000, now), 'FULL');
  assert.equal(await set.consume(id(1), now + 1, now + TICKET_MAX_SKEW_MS), 'REPLAYED');
  const later = now + TICKET_MAX_SKEW_MS + 1;
  assert.equal(await set.consume(id(3), later + 120000, later), 'OK');
  const reopened = await PersistentReplaySet.open(dir, { maxEntries: 2 });
  assert.equal(reopened.has(id(1)), false); assert.equal(reopened.has(id(2)), true); assert.equal(reopened.has(id(3)), true);
});

test('the existing signed-ticket verifier refuses a consumed ticket after the replay state is reopened', async t => {
  const dir = await directory(t); const signer = generateHolderKey(); const holder = generateHolderKey(); const kid = transferKeyId(signer.publicKey);
  const nodeId = `node_${'ab'.repeat(32)}`;
  const wire = signTicket({ kid, transferId: id(1), operation: 'put', applicationId: randomUUID(), chunkId: `chk_${'cd'.repeat(32)}`, nodeId,
    maxBytes: 1024, issuedAt: now, expiresAt: now + 120000, holderKey: holder.publicKey, nonce: 'ef'.repeat(16) }, signer.privateKey);
  const options = { keys: [{ kid, publicKey: signer.publicKey, notAfter: null }], now, expect: { nodeId } };
  const set = await PersistentReplaySet.open(dir);
  assert.equal(verifyTicket(wire, { ...options, replay: set }).ok, true);
  assert.equal(await set.consume(id(1), now + 120000, now), 'OK');
  const restarted = await PersistentReplaySet.open(dir);
  assert.deepEqual(verifyTicket(wire, { ...options, replay: restarted }), { ok: false, error: 'REPLAYED' });
});

test('invalid inputs cannot add an unbounded expiry or caller-supplied identifiers to disk', async t => {
  const dir = await directory(t); const set = await PersistentReplaySet.open(dir);
  for (const [transferId, expiresAt, at] of [[id(1), now + 150001, now], [id(1), now - TICKET_MAX_SKEW_MS, now], ['../escape', now + 1000, now], [id(1), NaN, now], [id(1), now + 1000, -1], [id(1), now + 1000, 1.5]] as const) {
    await assert.rejects(set.consume(transferId, expiresAt, at), errorCode('REPLAY_INPUT_INVALID'));
  }
  assert.equal(set.size, 0); assert.equal((await PersistentReplaySet.open(dir)).size, 0);
  await assert.rejects(PersistentReplaySet.open(dir, { maxEntries: 4097 }), errorCode('REPLAY_INPUT_INVALID'));
});

test('corrupt, tampered, oversized and nonprivate replay state is refused and preserved verbatim', async t => {
  const dir = await directory(t); const set = await PersistentReplaySet.open(dir); await set.consume(id(1), now + 1000, now);
  const file = join(dir, REPLAY_STATE_FILE); const valid = await readFile(file, 'utf8');
  const parsed = JSON.parse(valid) as { entries: Array<[string, number]> };
  for (const damaged of ['', '{', 'null', '[]', valid.replace('"version":1', '"version":2'), JSON.stringify({ ...JSON.parse(valid), extra: true }), JSON.stringify({ ...JSON.parse(valid), entries: [...parsed.entries, ...parsed.entries] }), valid.replace(id(1), id(2)), 'x'.repeat(512 * 1024 + 1)]) {
    await writeFile(file, damaged, { mode: 0o600 });
    await assert.rejects(PersistentReplaySet.open(dir), errorCode('REPLAY_STATE_INVALID'));
    assert.equal(await readFile(file, 'utf8'), damaged);
  }
  await writeFile(file, valid, { mode: 0o600 });
  if (process.platform !== 'win32') { await chmod(file, 0o644); await assert.rejects(PersistentReplaySet.open(dir), errorCode('REPLAY_STATE_INVALID')); }
});

test('replay state symlinks are never followed', async t => {
  const dir = await directory(t); const other = await directory(t); const target = join(other, 'unrelated');
  await writeFile(target, 'leave intact', { mode: 0o600 });
  try { await symlink(target, join(dir, REPLAY_STATE_FILE)); } catch (error) { if (process.platform === 'win32') { t.skip('symlink privilege unavailable'); return; } throw error; }
  await assert.rejects(PersistentReplaySet.open(dir), errorCode('REPLAY_STATE_INVALID'));
  assert.equal(await readFile(target, 'utf8'), 'leave intact');
});

test('an I/O failure poisons the gate, rejects waiting consumers and never grants a later transfer', async t => {
  const dir = await directory(t); const set = await PersistentReplaySet.open(dir);
  await rm(dir, { recursive: true });
  const results = await Promise.allSettled([set.consume(id(1), now + 1000, now), set.consume(id(2), now + 1000, now)]);
  assert(results.every(result => result.status === 'rejected' && errorCode('REPLAY_STATE_IO')(result.reason)));
  await assert.rejects(set.consume(id(3), now + 1000, now), errorCode('REPLAY_STATE_IO'));
});

test('after abrupt process termination a durably acknowledged consumption cannot reopen', async t => {
  const dir = await directory(t);
  const script = `import { PersistentReplaySet } from '@privanet/node/store/replay-state';
    const set = await PersistentReplaySet.open(process.argv[1]);
    const result = await set.consume('${id(1)}', ${now + 120000}, ${now});
    process.stdout.write(result + '\\n', () => process.kill(process.pid, 'SIGKILL'));`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, dir], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = ''; child.stdout.on('data', bytes => { stdout += String(bytes); }); child.stderr.on('data', bytes => { stderr += String(bytes); });
  const outcome = await new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
  assert.equal(stdout, 'OK\n', stderr); assert(outcome.signal === 'SIGKILL' || process.platform === 'win32');
  const restarted = await PersistentReplaySet.open(dir); assert.equal(await restarted.consume(id(1), now + 120000, now), 'REPLAYED');
});
