import test from 'node:test';
import { randomBytes, createHash } from 'node:crypto';
import { cpus, totalmem, platform, release } from 'node:os';
import { performance } from 'node:perf_hooks';
import { writeFile } from 'node:fs/promises';
import { directRig } from './direct-transfer-rig.js';

test('measure authorized TLS direct transfer with hashing, receipts and SDK verification', { timeout: 120000 }, async t => {
  const rig = await directRig(t); rig.world.policy.storage.transfer.maxConcurrentPuts = 4; await rig.storage.apply(rig.world.policy); await rig.node.tick();
  const rows = [];
  for (const size of [1024, 64 * 1024, 8 * 1024 * 1024]) for (const concurrency of [1, 4]) {
    await new Promise(resolve => setTimeout(resolve, 1100));
    const chunks = Array.from({ length: concurrency }, () => randomBytes(size));
    const cpuBefore = process.cpuUsage(); let at = performance.now();
    const ids = await Promise.all(chunks.map(bytes => rig.client.store(bytes)));
    const putMs = performance.now() - at; at = performance.now();
    const got = await Promise.all(ids.map(id => rig.client.fetch(id)));
    const getMs = performance.now() - at; const cpu = process.cpuUsage(cpuBefore);
    if (got.some((bytes, index) => !bytes.equals(chunks[index]!))) throw new Error('benchmark integrity failure');
    await Promise.all(ids.map(id => rig.client.delete(id)));
    // Isolated SHA-256 reference, not a security-disabled data-plane comparison.
    at = performance.now(); for (let n = 0; n < 100; n++) createHash('sha256').update(chunks[0]!).digest();
    rows.push({ size, concurrency, tls: true, putMs, getMs, putMiBPerSec: size * concurrency / 1048576 / (putMs / 1000), getMiBPerSec: size * concurrency / 1048576 / (getMs / 1000), aggregateCpuMs: (cpu.user + cpu.system) / 1000, sha256MsPerChunk: (performance.now() - at) / 100 });
  }
  const result = { environment: { node: process.version, os: `${platform()} ${release()}`, cpu: cpus()[0]?.model, logicalCpus: cpus().length, ramGiB: totalmem() / 1024 ** 3 }, methodology: 'One measured batch per size/concurrency after warm startup; real Coordinator/node/SDK on loopback, TLS enabled; PUT includes placement, holder proof, replay fsync, chunk fsync and STORED receipt; GET includes full at-rest hashing, SDK hashing and signed acknowledgement. CPU is aggregate for all three components in one process. SHA-256 reference averages 100 independent hashes. No integrity checks disabled.', rows };
  if (process.env.PRIVANET_BENCH_OUTPUT) await writeFile(process.env.PRIVANET_BENCH_OUTPUT, JSON.stringify(result, null, 2) + '\n');
  t.diagnostic(JSON.stringify(result));
});
