import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readdir, readFile, rm, chmod, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChunkStore } from '@privanet/node/store/chunk-store';
import type { PutStep } from '@privanet/node/store/chunk-store';
import { chunkIdOf, chunkPath } from '@privanet/node/store/chunk-id';

// A real crash, not a simulated one: a child process starts a put and SIGKILLs itself at a chosen step (no cleanup code runs, nothing is flushed that was not already). The parent then
// opens the store as the node would after a power cut or a kill, and checks that nothing invalid is visible, valid chunks are intact, and the counters are rebuilt from the files.
const CHILD = join(fileURLToPath(new URL('.', import.meta.url)), 'store-crash-child.js');
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const STEPS: PutStep[] = ['reserved', 'partial-created', 'first-write', 'mid-write', 'stream-complete', 'verified', 'synced', 'shard-ready', 'renamed'];

for (const crashAt of STEPS) {
  test(`crash at "${crashAt}": after a restart no invalid chunk is visible, earlier chunks are intact, usage is right, and the stale partial is cleaned`, async t => {
    const parent = await mkdtemp(join(tmpdir(), 'privanet-crash-')); t.after(() => rm(parent, { recursive: true, force: true })); await chmod(parent, 0o700); const root = join(parent, 'store'); await writeFile(join(parent, 'sentinel'), 'untouched');
    // An earlier, healthy chunk written by this same code path (it must survive the crash of a later put).
    const early = Buffer.alloc(4096, 3); const earlyId = chunkIdOf(sha(early)); const first = await ChunkStore.open(root, { limits: { maxBytes: 2 ** 30, reserveFreeBytes: 0 }, freeBytes: async () => 2 ** 40 }); await first.putBuffer(earlyId, early); await first.close();
    const parentBefore = (await readdir(parent)).sort();
    const child = spawn(process.execPath, [CHILD], { env: { PATH: process.env.PATH ?? '', STORE_ROOT: root, CRASH_STEP: crashAt, DATA_SEED: '42' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; child.stdout.on('data', (c: Buffer) => { out += c.toString(); });
    const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>(resolve => child.once('close', (c, s) => resolve([c, s])));
    assert.ok(signal === 'SIGKILL' || code !== 0, `the child died at ${crashAt} (exit ${String(code)}, signal ${String(signal)})`); assert.doesNotMatch(out, /finished without crashing/);
    const id = (JSON.parse(out.split('\n')[0] ?? '{}') as { id: string }).id; assert.match(id, /^chk_[0-9a-f]{64}$/);
    // Restart: every leftover partial is treated as stale (a crash cannot be waited out in a test).
    const store = await ChunkStore.open(root, { limits: { maxBytes: 2 ** 30, reserveFreeBytes: 0 }, freeBytes: async () => 2 ** 40, staleIncomingMs: -1 });
    const committed = crashAt === 'renamed'; const usage = await store.usage();
    assert.equal(await store.has(id), committed, `${crashAt}: the interrupted chunk is ${committed ? 'complete and committed' : 'not visible'}`);
    if (committed) { const data = await store.getBuffer(id); assert.equal(chunkIdOf(sha(data)), id, 'a committed chunk is exactly the bytes its name says'); assert.equal(usage.chunkCount, 2); assert.equal(usage.committedBytes, 4096 + data.length); }
    else assert.deepEqual([usage.chunkCount, usage.committedBytes], [1, 4096]);
    assert.deepEqual(await readdir(join(root, 'incoming')), [], 'stale partials were cleaned'); assert.equal(usage.incomingBytes, 0); assert.equal(usage.anomalies, 0);
    assert.deepEqual(await store.getBuffer(earlyId), early, 'the earlier chunk is intact'); assert.equal((await lstat(chunkPath(join(root, 'chunks'), earlyId))).isFile(), true);
    assert.deepEqual((await readdir(parent)).sort(), parentBefore); assert.equal(await readFile(join(parent, 'sentinel'), 'utf8'), 'untouched');
    // The same put, uninterrupted, completes from whatever state the crash left.
    const data = Buffer.alloc(3 * 1024 * 1024, 7); data.writeUInt32BE(42, 0); const done = await store.put(id, (async function* () { for (let o = 0; o < data.length; o += 1024 * 1024) yield data.subarray(o, o + 1024 * 1024); })(), data.length);
    assert.equal(done.stored, !committed); assert.deepEqual(await store.getBuffer(id), data); await store.close();
  });
}
