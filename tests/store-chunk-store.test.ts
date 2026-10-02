import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, truncate, utimes, writeFile, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChunkStore, scanStore } from '@privanet/node/store/chunk-store';
import type { PutStep, StoreOptions } from '@privanet/node/store/chunk-store';
import { chunkIdOf, chunkPath } from '@privanet/node/store/chunk-id';
import { isStoreError } from '@privanet/node/store/errors';
import type { StoreErrorCode } from '@privanet/node/store/errors';
import { MAX_CHUNK_BYTES } from '@privanet/node/store/limits';

const posix = process.platform !== 'win32'; const isRoot = posix && process.getuid?.() === 0;
const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const idOf = (bytes: Uint8Array): string => chunkIdOf(sha(bytes));
const bytesOf = (seed: number, size: number): Buffer => { const out = Buffer.alloc(size); let x = (seed * 2654435761) >>> 0 || 1; for (let i = 0; i < size; i++) { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; out[i] = x & 0xff; } return out; };
const GiB = 1024 ** 3;
const rejects = async (promise: Promise<unknown>, code: StoreErrorCode, label = ''): Promise<void> => { await assert.rejects(promise, (error: unknown) => { assert.ok(isStoreError(error, code), `${label} expected ${code}, got ${String((error as Error)?.message)}`); return true; }); };

interface Rig { parent: string; root: string; incoming: string; chunks: string; open: (extra?: Partial<StoreOptions>) => Promise<ChunkStore>; free: { value: number | undefined } }
async function rig(t: TestContext): Promise<Rig> {
  const parent = await mkdtemp(join(tmpdir(), 'privanet-store-')); t.after(() => rm(parent, { recursive: true, force: true }));
  await chmod(parent, 0o700); const root = join(parent, 'store'); const free: { value: number | undefined } = { value: 100 * GiB };
  const stores: ChunkStore[] = [];
  const open = async (extra: Partial<StoreOptions> = {}) => { const store = await ChunkStore.open(root, { limits: { maxBytes: 10 * GiB, reserveFreeBytes: 1 * GiB }, freeBytes: async () => free.value, ...extra }); stores.push(store); return store; };
  t.after(async () => { for (const store of stores) await store.close().catch(() => undefined); });
  return { parent, root, incoming: join(root, 'incoming'), chunks: join(root, 'chunks'), open, free };
}
/** Everything under a directory: relative path, kind, size and (for files) a digest, so that "nothing outside the store changed" is a strict comparison. */
async function snapshot(dir: string, skip: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (path: string): Promise<void> => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const full = join(path, entry.name); if (full === skip) continue;
      const info = await lstat(full); const rel = full.slice(dir.length);
      if (info.isDirectory()) { out.push(`d ${rel}`); await walk(full); } else if (info.isSymbolicLink()) out.push(`l ${rel}`); else out.push(`f ${rel} ${info.size} ${sha(await readFile(full))}`);
    }
  };
  await walk(dir); return out.sort();
}
const files = async (dir: string): Promise<string[]> => (await readdir(dir).catch(() => [])).sort();

test('a chunk round-trips, lands at <chunks>/<aa>/<bb>/<hex> with owner-only permissions, and leaves nothing behind', async t => {
  const r = await rig(t); const store = await r.open(); const data = bytesOf(1, 5000); const id = idOf(data);
  assert.deepEqual(await store.putBuffer(id, data), { stored: true, bytes: 5000 }); assert.equal(await store.has(id), true); assert.deepEqual(await store.getBuffer(id), data);
  const path = chunkPath(r.chunks, id); const info = await stat(path); assert.equal(info.size, 5000);
  if (posix) { assert.equal(info.mode & 0o777, 0o600); for (const dir of [r.root, r.chunks, r.incoming, join(r.chunks, sha(data).slice(0, 2))]) assert.equal((await stat(dir)).mode & 0o777, 0o700, dir); }
  assert.deepEqual(await files(r.incoming), [], 'no partial file is left after a normal commit');
  const usage = await store.usage(); assert.deepEqual([usage.committedBytes, usage.chunkCount, usage.incomingBytes, usage.health], [5000, 1, 0, 'OK']);
});

test('property: for random bytes of random sizes, put, has, get, a repeated put and delete behave exactly as specified', async t => {
  const r = await rig(t); const store = await r.open(); let seed = 99; const next = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed; };
  for (let i = 0; i < 60; i++) {
    const size = 1 + (i < 10 ? i : next() % 70000); const data = bytesOf(i + 1, size); const id = idOf(data);
    assert.equal(await store.has(id), false);
    assert.equal((await store.putBuffer(id, data)).stored, true); assert.equal(await store.has(id), true); assert.deepEqual(await store.getBuffer(id), data);
    const before = await store.usage(); assert.equal((await store.putBuffer(id, data)).stored, false, 'a repeat is a no-op'); assert.deepEqual((await store.usage()).committedBytes, before.committedBytes); assert.equal((await store.usage()).chunkCount, before.chunkCount);
    assert.equal((await store.delete(id)).deleted, true); assert.equal(await store.has(id), false); assert.equal((await store.delete(id)).deleted, false); await rejects(store.get(id), 'NOT_FOUND');
    assert.equal((await store.usage()).committedBytes, 0); assert.equal((await store.usage()).chunkCount, 0);
  }
  assert.deepEqual(await files(r.incoming), []);
});

test('the largest chunk is exactly 8 MiB; one byte more, an empty chunk and nonsense sizes are refused before anything is written', async t => {
  assert.equal(MAX_CHUNK_BYTES, 8 * 1024 * 1024);
  const r = await rig(t); const store = await r.open(); const big = bytesOf(5, MAX_CHUNK_BYTES);
  assert.equal((await store.putBuffer(idOf(big), big)).stored, true); assert.equal((await store.getBuffer(idOf(big))).length, MAX_CHUNK_BYTES);
  const over = bytesOf(6, MAX_CHUNK_BYTES + 1); await rejects(store.putBuffer(idOf(over), over), 'TOO_LARGE'); await rejects(store.putBuffer(idOf(Buffer.alloc(0)), Buffer.alloc(0)), 'INVALID_SIZE');
  for (const size of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60]) await rejects(store.put(idOf(Buffer.from('a')), (async function* () { yield Buffer.from('a'); })(), size), size === 2 ** 60 ? 'INVALID_SIZE' : 'INVALID_SIZE', String(size));
  await rejects(store.put(idOf(Buffer.from('a')), (async function* () { yield Buffer.from('a'); })(), MAX_CHUNK_BYTES + 1), 'TOO_LARGE');
  assert.deepEqual(await files(r.incoming), []);
});

test('a wrong hash, a short stream and an over-long stream are rejected without committing anything, and an over-long stream is cut off at once', async t => {
  const r = await rig(t); const store = await r.open(); const data = bytesOf(2, 4096); const id = idOf(data); const other = bytesOf(3, 4096);
  await rejects(store.putBuffer(id, other), 'INTEGRITY'); assert.equal(await store.has(id), false);
  await rejects(store.put(id, (async function* () { yield data.subarray(0, 100); })(), 4096), 'SIZE_MISMATCH', 'short');
  let pulled = 0; const long = (async function* () { for (let i = 0; i < 1000; i++) { pulled++; yield Buffer.alloc(1024, 1); } })();
  await rejects(store.put(id, long, 4096), 'SIZE_MISMATCH', 'long'); assert.ok(pulled <= 6, `the stream was abandoned after ${pulled} pieces, not read to the end`);
  assert.equal(await store.has(id), false); assert.deepEqual(await files(r.incoming), []); const usage = await store.usage(); assert.deepEqual([usage.committedBytes, usage.chunkCount, usage.incomingBytes], [0, 0, 0]);
  // After the failures, the right bytes still work.
  assert.equal((await store.putBuffer(id, data)).stored, true);
});

test('a stream that fails, or is cancelled, part-way leaves no partial file and no reservation', async t => {
  const r = await rig(t); const store = await r.open(); const data = bytesOf(4, 3000); const id = idOf(data);
  const failing = (async function* () { yield data.subarray(0, 1000); throw new Error('network went away'); })();
  await assert.rejects(store.put(id, failing, 3000), (error: unknown) => isStoreError(error, 'IO') && !/network/.test((error as Error).message));
  const controller = new AbortController(); const aborted = (async function* () { yield data.subarray(0, 1000); controller.abort(); yield data.subarray(1000); })();
  await rejects(store.put(id, aborted, 3000, { signal: controller.signal }), 'ABORTED');
  assert.deepEqual(await files(r.incoming), []); assert.equal((await store.usage()).incomingBytes, 0); assert.equal(await store.has(id), false);
});

test('quota: committed, reserved and leftover bytes all count; a duplicate of what is stored needs no room; delete gives the room back', async t => {
  const r = await rig(t); const store = await r.open({ limits: { maxBytes: 100, reserveFreeBytes: 0 } });
  const a = bytesOf(10, 60); const b = bytesOf(11, 60); const c = bytesOf(12, 40);
  await store.putBuffer(idOf(a), a); assert.equal((await store.usage()).allowedBytes, 40);
  await rejects(store.putBuffer(idOf(b), b), 'STORAGE_FULL'); assert.equal(await store.has(idOf(b)), false); assert.deepEqual(await files(r.incoming), []);
  assert.equal((await store.putBuffer(idOf(a), a)).stored, false, 'a retry of a stored chunk succeeds even when the store is otherwise too full');
  await store.putBuffer(idOf(c), c); assert.equal((await store.usage()).allowedBytes, 0); await rejects(store.putBuffer(idOf(bytesOf(13, 1)), bytesOf(13, 1)), 'STORAGE_FULL');
  await store.delete(idOf(a)); assert.equal((await store.usage()).allowedBytes, 60); assert.equal((await store.putBuffer(idOf(b), b)).stored, true);
  // Lowering the quota below what is stored stops new writes and never deletes anything.
  store.setLimits({ maxBytes: 10, reserveFreeBytes: 0 }); assert.equal((await store.usage()).allowedBytes, 0); assert.equal(await store.has(idOf(b)), true);
});

test('free space: the owner\'s reserve is honoured, an unknown reading refuses writes, and a stale reading cannot allow an unbounded write', async t => {
  const r = await rig(t); const store = await r.open({ limits: { maxBytes: 10 * GiB, reserveFreeBytes: 900 } });
  r.free.value = 1000; assert.equal((await store.usage()).allowedBytes, 100);
  const big = bytesOf(20, 200); await rejects(store.putBuffer(idOf(big), big), 'STORAGE_FULL'); const ok = bytesOf(21, 100); assert.equal((await store.putBuffer(idOf(ok), ok)).stored, true);
  r.free.value = undefined; const u = await store.usage(); assert.equal(u.allowedBytes, 0); assert.ok(u.flags.includes('FREE_SPACE_UNKNOWN')); assert.equal(u.health, 'DEGRADED'); await rejects(store.putBuffer(idOf(bytesOf(22, 5)), bytesOf(22, 5)), 'STORAGE_FULL');
  // The reading was fine before the write and the disk filled while it ran: caught while writing (every MiB) ...
  r.free.value = 100 * GiB; const fat = bytesOf(23, 3 * 1024 * 1024); const pieces = (async function* () { for (let o = 0; o < fat.length; o += 1024 * 1024) yield fat.subarray(o, o + 1024 * 1024); })();
  const mid = await r.open({ limits: { maxBytes: 10 * GiB, reserveFreeBytes: 1 * GiB }, hooks: { step: step => { if (step === 'first-write') r.free.value = 10; } } });
  await rejects(mid.put(idOf(fat), pieces, fat.length), 'STORAGE_FULL', 'mid-write'); assert.equal(await mid.has(idOf(fat)), false);
  // ... and again at the commit, after the partial really occupies the disk.
  r.free.value = 100 * GiB; const late = await r.open({ limits: { maxBytes: 10 * GiB, reserveFreeBytes: 1 * GiB }, hooks: { step: step => { if (step === 'synced') r.free.value = 10; } } });
  const small = bytesOf(24, 500); await rejects(late.putBuffer(idOf(small), small), 'STORAGE_FULL', 'commit'); assert.equal(await late.has(idOf(small)), false); assert.deepEqual(await files(r.incoming), []);
});

test('the gate stops new puts (paused, disabled, draining, schedule) with a fixed reason; reads, checks and deletes still work', async t => {
  const r = await rig(t); let verdict: { allowed: true } | { allowed: false; reason: string } = { allowed: true }; const store = await r.open({ gate: () => verdict });
  const data = bytesOf(30, 100); await store.putBuffer(idOf(data), data);
  verdict = { allowed: false, reason: 'PAUSED' }; await assert.rejects(store.putBuffer(idOf(bytesOf(31, 5)), bytesOf(31, 5)), (error: unknown) => isStoreError(error, 'UNAVAILABLE') && (error as { reason?: string }).reason === 'PAUSED');
  assert.equal(await store.has(idOf(data)), true); assert.deepEqual(await store.getBuffer(idOf(data)), data); assert.equal((await store.delete(idOf(data))).deleted, true);
  verdict = { allowed: true }; assert.equal((await store.putBuffer(idOf(data), data)).stored, true);
  await store.close(); await rejects(store.putBuffer(idOf(bytesOf(32, 5)), bytesOf(32, 5)), 'UNAVAILABLE'); assert.equal(await store.has(idOf(data)), true, 'closing leaves the chunks exactly as they are');
});

test('concurrency: many puts of one chunk give one stored chunk and one count; many deletes never underflow; mixed work keeps the counters equal to the files', async t => {
  const r = await rig(t); const store = await r.open(); const data = bytesOf(40, 20000); const id = idOf(data);
  const results = await Promise.all(Array.from({ length: 12 }, () => store.put(id, (async function* () { yield data.subarray(0, 7000); yield data.subarray(7000); })(), data.length)));
  assert.equal(results.filter(x => x.stored).length, 1, 'exactly one writer committed'); assert.deepEqual(await store.getBuffer(id), data); assert.deepEqual(await files(r.incoming), []);
  let usage = await store.usage(); assert.deepEqual([usage.committedBytes, usage.chunkCount, usage.incomingBytes], [20000, 1, 0]);
  const deletes = await Promise.all(Array.from({ length: 10 }, () => store.delete(id))); assert.equal(deletes.filter(x => x.deleted).length, 1); usage = await store.usage(); assert.deepEqual([usage.committedBytes, usage.chunkCount], [0, 0]);
  const chunks = Array.from({ length: 30 }, (_, i) => bytesOf(100 + i, 100 + i * 37));
  await Promise.all(chunks.flatMap((c, i) => [store.putBuffer(idOf(c), c), store.putBuffer(idOf(c), c), ...(i % 3 === 0 ? [store.delete(idOf(c))] : [])].map(p => p.catch(() => undefined))));
  const live = await store.usage(); const fresh = await store.usage({ fresh: true });
  assert.deepEqual([live.committedBytes, live.chunkCount], [fresh.committedBytes, fresh.chunkCount], 'the in-memory counters agree with a recount of the files'); assert.deepEqual(await files(r.incoming), []);
});

test('too many puts at once are refused as BUSY, and a put that is running is not disturbed by a sweep or a rescan', async t => {
  const r = await rig(t); const store = await r.open({ maxInFlight: 1 }); const data = bytesOf(50, 2000); let release: () => void = () => undefined; const gate = new Promise<void>(resolve => { release = resolve; });
  const slow = store.put(idOf(data), (async function* () { yield data.subarray(0, 1000); await gate; yield data.subarray(1000); })(), 2000);
  await new Promise(resolve => setTimeout(resolve, 50)); const other = bytesOf(51, 10); await rejects(store.putBuffer(idOf(other), other), 'BUSY');
  assert.equal(await store.sweepIncoming(-1), 0, 'a partial that belongs to a running put is never swept'); await store.rescan(); release(); assert.equal((await slow).stored, true); assert.deepEqual(await store.getBuffer(idOf(data)), data);
});

test('corrupt at rest: a wrong digest, a truncated file and an emptied file are never served; the bad file is removed, counted once, and the chunk can be stored again', async t => {
  const r = await rig(t); const store = await r.open();
  for (const [name, damage] of [['same size, different bytes', async (p: string, d: Buffer) => { const x = Buffer.from(d); x.writeUInt8(x.readUInt8(0) ^ 0xff, 0); await writeFile(p, x, { mode: 0o600 }); }], ['truncated', async (p: string, d: Buffer) => { await truncate(p, d.length - 10); }], ['extended', async (p: string, d: Buffer) => { await writeFile(p, Buffer.concat([d, Buffer.from('x')]), { mode: 0o600 }); }]] as const) {
    const data = bytesOf(60 + name.length, 3000); const id = idOf(data); await store.putBuffer(id, data); await damage(chunkPath(r.chunks, id), data);
    const before = await store.usage(); await rejects(store.get(id), 'INTEGRITY', name);
    assert.equal(await store.has(id), false, `${name}: has agrees with get after the failure`); await rejects(store.get(id), 'NOT_FOUND', name); assert.equal((await store.usage()).chunkCount, before.chunkCount - 1, name);
    assert.equal((await store.putBuffer(id, data)).stored, true, `${name}: storing it again repairs it`); assert.deepEqual(await store.getBuffer(id), data);
  }
  assert.equal((await store.usage()).integrityFailures, 3); assert.ok((await store.usage()).flags.includes('INTEGRITY_FAILURES'));
  // A damaged chunk is replaced by a put of the right bytes even without a get first (the duplicate check hashes the existing file).
  const d = bytesOf(70, 2000); const id = idOf(d); await store.putBuffer(id, d); await writeFile(chunkPath(r.chunks, id), Buffer.alloc(2000, 9), { mode: 0o600 });
  assert.equal((await store.putBuffer(id, d)).stored, true); assert.deepEqual(await store.getBuffer(id), d); assert.equal((await store.usage({ fresh: true })).chunkCount, 4, 'three repaired chunks and this one');
});

test('a file removed behind the store\'s back: has and get tell the truth at once; the counters follow at the next recount', async t => {
  const r = await rig(t); const store = await r.open(); const data = bytesOf(80, 1234); const id = idOf(data); await store.putBuffer(id, data);
  await rm(chunkPath(r.chunks, id)); assert.equal(await store.has(id), false); await rejects(store.get(id), 'NOT_FOUND'); assert.equal((await store.delete(id)).deleted, false);
  assert.equal((await store.usage()).chunkCount, 1, 'the cached counter is stale (and safely high)'); assert.equal((await store.usage({ fresh: true })).chunkCount, 0);
  assert.equal((await store.putBuffer(id, data)).stored, true);
});

test('a chunk whose permissions were widened, or whose owner changed, is not a valid chunk: not counted, not served, not deleted by the store', { skip: posix ? undefined : 'POSIX permission bits' }, async t => {
  const r = await rig(t); const store = await r.open(); const data = bytesOf(90, 800); const id = idOf(data); await store.putBuffer(id, data); const path = chunkPath(r.chunks, id);
  await chmod(path, 0o644); assert.equal(await store.has(id), false); await rejects(store.get(id), 'STORE_UNSAFE'); const u = await store.usage({ fresh: true }); assert.deepEqual([u.chunkCount, u.anomalies], [0, 1]); assert.ok(u.flags.includes('ANOMALIES'));
  assert.equal(await readFile(path).then(b => b.length), 800, 'the file itself was left alone');
  // A put of the same chunk replaces the odd file with a sound one.
  assert.equal((await store.putBuffer(id, data)).stored, true); assert.equal((await stat(path)).mode & 0o777, 0o600); assert.equal(await store.has(id), true);
});

test('malicious filesystem state: a link where a chunk belongs, in a shard directory, in incoming, as the store root or as chunks/ is refused and nothing outside the store is read, written or deleted', { skip: posix ? undefined : 'symbolic links need privileges on Windows' }, async t => {
  const r = await rig(t); const outside = join(r.parent, 'outside'); await mkdir(outside, { mode: 0o700 }); const secret = join(outside, 'secret.txt'); await writeFile(secret, 'do not touch', { mode: 0o600 });
  const store = await r.open(); const data = bytesOf(100, 500); const id = idOf(data); const hex = sha(data); const path = chunkPath(r.chunks, id);
  await store.putBuffer(id, data); await rm(path); await mkdir(join(r.chunks, hex.slice(0, 2), hex.slice(2, 4)), { recursive: true });
  const before = await snapshot(outside, ''); const dirBefore = await snapshot(r.parent, r.root);
  // A link planted exactly where the final chunk goes.
  await symlink(secret, path); assert.equal(await store.has(id), false); await rejects(store.get(id), 'STORE_UNSAFE'); await rejects(store.delete(id), 'STORE_UNSAFE'); await rejects(store.putBuffer(id, data), 'STORE_UNSAFE', 'link at the final path');
  assert.equal(await readFile(secret, 'utf8'), 'do not touch'); assert.equal((await lstat(path)).isSymbolicLink(), true, 'the planted link was not followed or removed'); assert.deepEqual(await files(r.incoming), []);
  // A link as the second shard directory: a put into it must not write through it.
  const other = bytesOf(101, 500); const oh = sha(other); await mkdir(join(r.chunks, oh.slice(0, 2)), { recursive: true }); await symlink(outside, join(r.chunks, oh.slice(0, 2), oh.slice(2, 4)));
  await rejects(store.putBuffer(idOf(other), other), 'STORE_UNSAFE', 'link as shard directory'); assert.deepEqual(await files(outside), ['secret.txt']);
  // A regular file where a shard directory belongs.
  const third = bytesOf(102, 500); const th = sha(third); await writeFile(join(r.chunks, th.slice(0, 2)), 'not a directory', { mode: 0o600 }); await rejects(store.putBuffer(idOf(third), third), 'STORE_UNSAFE', 'file as shard directory');
  assert.equal(await readFile(join(r.chunks, th.slice(0, 2)), 'utf8'), 'not a directory');
  assert.deepEqual(await snapshot(outside, ''), before); await store.close();
  // Opening a store that contains a link anywhere is refused outright.
  await rejects(ChunkStore.open(r.root, { limits: { maxBytes: 1, reserveFreeBytes: 0 }, freeBytes: async () => 2 ** 40 }), 'STORE_UNSAFE', 'link inside chunks');
  await rm(path); await rm(join(r.chunks, oh.slice(0, 2)), { recursive: true }); await rm(join(r.chunks, th.slice(0, 2)));
  await symlink(secret, join(r.incoming, `${'a'.repeat(32)}.part`)); await rejects(ChunkStore.open(r.root, { limits: { maxBytes: 1, reserveFreeBytes: 0 }, freeBytes: async () => 2 ** 40 }), 'STORE_UNSAFE', 'link inside incoming'); await rm(join(r.incoming, `${'a'.repeat(32)}.part`));
  await rm(r.incoming, { recursive: true }); await symlink(outside, r.incoming); await rejects(ChunkStore.open(r.root, { limits: { maxBytes: 1, reserveFreeBytes: 0 }, freeBytes: async () => 2 ** 40 }), 'STORE_UNSAFE', 'incoming is a link'); await rm(r.incoming);
  await rm(r.chunks, { recursive: true }); await symlink(outside, r.chunks); await rejects(ChunkStore.open(r.root, { limits: { maxBytes: 1, reserveFreeBytes: 0 }, freeBytes: async () => 2 ** 40 }), 'STORE_UNSAFE', 'chunks is a link'); await rm(r.chunks);
  const moved = join(r.parent, 'real-store'); await mkdir(moved, { mode: 0o700 }); await rm(r.root, { recursive: true }); await symlink(moved, r.root); await rejects(ChunkStore.open(r.root, { limits: { maxBytes: 1, reserveFreeBytes: 0 }, freeBytes: async () => 2 ** 40 }), 'STORE_UNSAFE', 'root is a link');
  assert.equal(await readFile(secret, 'utf8'), 'do not touch'); assert.deepEqual(await snapshot(outside, ''), before); void dirBefore;
});

test('unsafe permissions on a store directory are refused, and a regular file where the store must be is refused', { skip: posix ? undefined : 'POSIX permission bits' }, async t => {
  const r = await rig(t); const store = await r.open(); await store.close();
  for (const dir of [r.root, r.chunks, r.incoming]) { await chmod(dir, 0o755); await rejects(ChunkStore.open(r.root, { limits: { maxBytes: 1, reserveFreeBytes: 0 }, freeBytes: async () => 2 ** 40 }), 'STORE_UNSAFE', dir); await chmod(dir, 0o700); }
  await chmod(r.chunks, 0o770); await rejects(ChunkStore.open(r.root, { limits: { maxBytes: 1, reserveFreeBytes: 0 }, freeBytes: async () => 2 ** 40 }), 'STORE_UNSAFE', 'group-writable'); await chmod(r.chunks, 0o700);
  const file = join(r.parent, 'afile'); await writeFile(file, 'x'); await rejects(ChunkStore.open(join(file, 'store'), { limits: { maxBytes: 1, reserveFreeBytes: 0 }, freeBytes: async () => 2 ** 40 }), 'STORE_UNSAFE', 'a file in the path');
  const again = await r.open(); assert.equal((await again.usage()).health, 'OK');
});

test('a read-only store and a failing disk surface as fixed errors and leave no partial file', { skip: !posix || isRoot ? 'needs a non-root POSIX user (root ignores directory permissions)' : undefined }, async t => {
  const r = await rig(t); const store = await r.open(); const data = bytesOf(110, 100);
  await chmod(r.incoming, 0o500); await assert.rejects(store.putBuffer(idOf(data), data), (error: unknown) => isStoreError(error, 'IO')); await chmod(r.incoming, 0o700); assert.deepEqual(await files(r.incoming), []);
  assert.equal((await store.putBuffer(idOf(data), data)).stored, true);
});

test('failures injected at every step of a put: nothing invalid is committed, the counters stay right, nothing is left behind, and a restart agrees', async t => {
  const steps: PutStep[] = ['reserved', 'partial-created', 'first-write', 'mid-write', 'stream-complete', 'verified', 'synced', 'shard-ready', 'renamed', 'accounted'];
  for (const failAt of steps) {
    const r = await rig(t); const data = bytesOf(120, 3 * 1024 * 1024); const id = idOf(data); const sentinel = join(r.parent, 'sentinel.txt'); await writeFile(sentinel, 'untouched');
    const store = await r.open({ hooks: { step: step => { if (step === failAt) throw Object.assign(new Error(`injected failure at ${failAt}`), { code: 'EIO' }); } } });
    const outsideBefore = await snapshot(r.parent, r.root);
    const pieces = (async function* () { for (let o = 0; o < data.length; o += 1024 * 1024) yield data.subarray(o, o + 1024 * 1024); })();
    await assert.rejects(store.put(id, pieces, data.length), (error: unknown) => { assert.ok(isStoreError(error), failAt); assert.doesNotMatch((error as Error).message, /injected|EIO/, 'no system message leaks'); return true; }, failAt);
    const committed = failAt === 'renamed' || failAt === 'accounted';   // after the atomic rename the chunk is complete and correct, and counted
    assert.equal(await store.has(id), committed, `${failAt}: has`); const usage = await store.usage(); assert.deepEqual([usage.committedBytes, usage.chunkCount, usage.incomingBytes], committed ? [data.length, 1, 0] : [0, 0, 0], `${failAt}: counters`);
    if (committed) assert.deepEqual(await store.getBuffer(id), data); assert.deepEqual(await files(r.incoming), [], `${failAt}: no partial file left`);
    await store.close(); const reopened = await r.open(); const again = await reopened.usage(); assert.deepEqual([again.committedBytes, again.chunkCount, again.anomalies], committed ? [data.length, 1, 0] : [0, 0, 0], `${failAt}: after a restart`);
    assert.deepEqual(await snapshot(r.parent, r.root), outsideBefore, `${failAt}: nothing outside the store changed`); assert.equal(await readFile(sentinel, 'utf8'), 'untouched');
    // And the same put with no failure succeeds from this state.
    assert.equal(committed ? (await reopened.putBuffer(id, data)).stored === false : (await reopened.putBuffer(id, data)).stored === true, true, `${failAt}: a clean retry`);
  }
});

test('disk-full and I/O errors from the filesystem map to fixed codes', async t => {
  const r = await rig(t); const data = bytesOf(130, 100); const id = idOf(data);
  for (const [code, expected] of [['ENOSPC', 'STORAGE_FULL'], ['EDQUOT', 'STORAGE_FULL'], ['EIO', 'IO'], ['EACCES', 'IO'], ['ELOOP', 'STORE_UNSAFE']] as const) {
    const store = await r.open({ hooks: { step: step => { if (step === 'mid-write' || step === 'first-write') throw Object.assign(new Error('/secret/host/path failed'), { code }); } } });
    await assert.rejects(store.putBuffer(id, data), (error: unknown) => { assert.ok(isStoreError(error, expected), `${code} -> ${expected}`); assert.doesNotMatch((error as Error).message, /secret|path/); return true; }); assert.deepEqual(await files(r.incoming), []);
    await store.close();
  }
});

test('start-up recovery: stale partials are removed, recent ones are kept and counted, oddities are counted and left alone, the chunk files decide the usage', async t => {
  const r = await rig(t); const store = await r.open(); const kept = [bytesOf(140, 1000), bytesOf(141, 2500), bytesOf(142, 77)]; for (const d of kept) await store.putBuffer(idOf(d), d); await store.close();
  const stale = join(r.incoming, `${'1'.repeat(32)}.part`); const recent = join(r.incoming, `${'2'.repeat(32)}.part`); const odd = join(r.incoming, 'notes.txt');
  await writeFile(stale, Buffer.alloc(500), { mode: 0o600 }); await writeFile(recent, Buffer.alloc(300), { mode: 0o600 }); await writeFile(odd, 'x', { mode: 0o600 }); const old = new Date(Date.now() - 3600_000); await utimes(stale, old, old);
  const hex = sha(kept[0] as Buffer); const dirA = join(r.chunks, hex.slice(0, 2), hex.slice(2, 4)); const strayFile = join(dirA, 'README'); await writeFile(strayFile, 'x', { mode: 0o600 });
  const wrongName = join(dirA, 'f'.repeat(64)); await writeFile(wrongName, 'x', { mode: 0o600 }); const emptyFile = join(dirA, hex.slice(0, 4) + '0'.repeat(60)); await writeFile(emptyFile, '', { mode: 0o600 });
  const reopened = await r.open({ staleIncomingMs: 10 * 60 * 1000 }); const usage = await reopened.usage();
  assert.deepEqual(await files(r.incoming), [`${'2'.repeat(32)}.part`, 'notes.txt'], 'the stale partial is gone; the recent one and the unknown file stay');
  assert.deepEqual([usage.committedBytes, usage.chunkCount], [1000 + 2500 + 77, 3]); assert.equal(usage.incomingBytes, 300, 'a recent leftover partial counts against the quota'); assert.equal(usage.anomalies, 4); assert.equal(usage.health, 'DEGRADED');
  for (const path of [strayFile, wrongName, emptyFile, odd]) assert.ok(await stat(path), 'files the store does not understand are never deleted');
  for (const d of kept) assert.deepEqual(await reopened.getBuffer(idOf(d)), d);
  // The recent partial becomes stale later and is swept by the next sweep.
  assert.equal(await reopened.sweepIncoming(-1), 1); assert.equal((await reopened.usage()).incomingBytes, 0);
});

test('inspect: a read-only look that creates nothing and reports an absent, a healthy and an unsafe store', async t => {
  const r = await rig(t); assert.deepEqual(await scanStore(r.root), { committedBytes: 0, chunkCount: 0, incomingBytes: 0, anomalies: 0, unsafe: false, stale: [], present: false }); assert.deepEqual(await files(r.parent), [], 'inspecting an absent store creates nothing');
  const store = await r.open(); const d = bytesOf(150, 321); await store.putBuffer(idOf(d), d); await store.close();
  const seen = await ChunkStore.inspect(r.root); assert.deepEqual([seen.present, seen.chunkCount, seen.committedBytes, seen.unsafe], [true, 1, 321, false]);
  if (posix) { await chmod(r.chunks, 0o755); assert.equal((await ChunkStore.inspect(r.root)).unsafe, true); await chmod(r.chunks, 0o700); }
});

test('chunks are opaque and application-neutral: the store holds only the bytes, with no name, metadata file or index beside them', async t => {
  const r = await rig(t); const store = await r.open(); const d = bytesOf(160, 1000); await store.putBuffer(idOf(d), d);
  assert.deepEqual(await files(r.root), ['chunks', 'incoming']); assert.deepEqual(await files(join(r.chunks, sha(d).slice(0, 2), sha(d).slice(2, 4))), [sha(d)]);
});
