import { createHash } from 'node:crypto';
import { ChunkStore } from '@privanet/node/store/chunk-store';
import type { PutStep } from '@privanet/node/store/chunk-store';
import { chunkIdOf } from '@privanet/node/store/chunk-id';

// A child process for tests/store-crash.test.ts: it starts a put and kills ITSELF (no cleanup, no exit handlers: a real crash) when the put reaches the step named in CRASH_STEP.
const root = process.env.STORE_ROOT ?? ''; const crashAt = process.env.CRASH_STEP as PutStep; const size = Number(process.env.DATA_BYTES ?? 3 * 1024 * 1024);
const data = Buffer.alloc(size, 7); data.writeUInt32BE(Number(process.env.DATA_SEED ?? 1), 0);
const id = chunkIdOf(createHash('sha256').update(data).digest('hex'));
const store = await ChunkStore.open(root, { limits: { maxBytes: 2 ** 30, reserveFreeBytes: 0 }, freeBytes: async () => 2 ** 40, hooks: { step: step => { if (step === crashAt) process.kill(process.pid, 'SIGKILL'); } } });
const pieces = (async function* () { for (let offset = 0; offset < data.length; offset += 1024 * 1024) yield data.subarray(offset, Math.min(data.length, offset + 1024 * 1024)); })();
console.log(JSON.stringify({ id }));
await store.put(id, pieces, data.length);
console.log('finished without crashing');
