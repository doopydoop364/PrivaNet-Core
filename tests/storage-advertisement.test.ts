import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StorageAdvertisementSchema, STORAGE_MAX_CHUNK_BYTES } from '@privanet/protocol';
import { ResourcePolicySchema, defaultResourcePolicy } from '@privanet/node/resource-policy';
import { StorageService } from '@privanet/node/store/service';
import { chunkIdOf } from '@privanet/node/store/chunk-id';
import type { ChunkStore } from '@privanet/node/store/chunk-store';

const GiB = 1024 ** 3;
const idOf = (bytes: Buffer) => chunkIdOf(createHash('sha256').update(bytes).digest('hex'));
async function rig(t: TestContext, free: number | null = 500 * GiB) {
  const dir = await mkdtemp(join(tmpdir(), 'privanet-advert-')); t.after(() => rm(dir, { recursive: true, force: true })); const state = join(dir, 'state'); await mkdir(state, { mode: 0o700 }); await chmod(state, 0o700);
  const world = { policy: defaultResourcePolicy(), draining: false, blockers: [] as string[], diskIo: 'high' as string | undefined, contribution: 'FULL', free };
  const engine = { get state() { return { blockers: world.blockers }; }, get report() { return { diskIo: world.diskIo, contribution: world.contribution }; } };
  const service = new StorageService({ stateDir: state, policy: () => world.policy, inputs: { draining: () => world.draining, engine }, storeOptions: { freeBytes: async () => world.free ?? undefined }, refreshMs: 1_000_000 });
  const enable = async (maxBytes = 1000, reserveFreeBytes = 0) => { world.policy = ResourcePolicySchema.parse({ storage: { enabled: true, maxBytes, reserveFreeBytes } }); await service.apply(world.policy); };
  t.after(() => service.stop());
  return { service, world, state, enable };
}

test('storage is offered only when the owner enabled it and the store opened: off by default, and never from a bare switch', async t => {
  const { service, world, enable } = await rig(t); await service.start(); assert.equal(service.advertisement(), undefined); // default policy: off
  await enable(); assert.deepEqual(service.advertisement(), { capacityBytes: 1000, freeBytes: 1000, maxChunkBytes: STORAGE_MAX_CHUNK_BYTES });
  world.policy = defaultResourcePolicy(); assert.equal(service.advertisement(), undefined, 'switching the policy off withdraws the offer before the next refresh');
});
test('capacity and free space come from the real store and policy: quota and reserve are subtracted, stored data reduces free, and a full store offers nothing', async t => {
  const { service, enable } = await rig(t, 2000); await service.start(); await enable(1000, 1500); // disk 2000 free, reserve 1500: only 500 usable
  assert.deepEqual(service.advertisement(), { capacityBytes: 1000, freeBytes: 500, maxChunkBytes: STORAGE_MAX_CHUNK_BYTES });
  await enable(1000, 0); const data = Buffer.alloc(600, 7); await (service.chunkStore as ChunkStore | undefined)?.putBuffer(idOf(data), data); await service.refresh();
  assert.deepEqual(service.advertisement(), { capacityBytes: 1000, freeBytes: 400, maxChunkBytes: STORAGE_MAX_CHUNK_BYTES });
  await enable(500, 0); await service.refresh(); assert.equal(service.advertisement(), undefined, 'a quota below what is stored leaves no room, so nothing is offered (and nothing is deleted)');
  assert.equal(service.status.chunkCount, 1);
});
test('the offer is withdrawn the moment the node would refuse a write: owner pause, drain, schedule, battery, busy disk and pressure pause', async t => {
  const { service, world, enable } = await rig(t); await service.start(); await enable(); assert(service.advertisement());
  for (const [name, set, clear] of [
    ['owner pause', () => { world.blockers = ['PAUSED_BY_OWNER']; }, () => { world.blockers = []; }], ['schedule', () => { world.blockers = ['SCHEDULE_OFF']; }, () => { world.blockers = []; }],
    ['battery', () => { world.blockers = ['ON_BATTERY']; }, () => { world.blockers = []; }], ['drain', () => { world.draining = true; }, () => { world.draining = false; }],
    ['disk busy', () => { world.diskIo = 'none'; }, () => { world.diskIo = 'high'; }], ['pressure pause', () => { world.contribution = 'PAUSED'; }, () => { world.contribution = 'FULL'; }],
  ] as const) { set(); assert.equal(service.advertisement(), undefined, name); clear(); assert(service.advertisement(), `${name}: offered again when it clears`); }
  // CPU and memory pressure alone do not stop a disk write, so they do not withdraw the offer (same rule as the gate)
  world.blockers = ['MEMORY_PRESSURE', 'CPU_PRESSURE']; assert(service.advertisement());
});
test('an unsafe or unreadable store, or unknown free space, offers nothing (healthy enough to accept a transfer, or silent)', async t => {
  const unknown = await rig(t, null); await unknown.service.start(); await unknown.enable(); assert.equal(unknown.service.advertisement(), undefined, 'free space unknown: a put would be refused, so it is not offered');
  const broken = await rig(t); await writeFile(join(broken.state, 'store'), 'not a directory'); await broken.service.start(); await broken.enable(); assert.equal(broken.service.status.state, 'ERROR'); assert.equal(broken.service.advertisement(), undefined);
});
test('every offer is a valid advertisement: bounded integers, free never above capacity, whatever the policy', async t => {
  const { service, world, enable } = await rig(t, 8 * 1024 ** 5); await service.start();
  for (const [maxBytes, reserve] of [[1, 0], [1000, 0], [2 ** 40, 0], [2 ** 50, 0], [2 ** 40, 2 ** 39], [1_000_000_000_000, 10 * GiB]] as const) {
    try { await enable(maxBytes, reserve); } catch { continue; } // a value the policy schema itself refuses is not an offer either
    const offer = service.advertisement(); if (offer === undefined) continue; assert.equal(StorageAdvertisementSchema.safeParse(offer).success, true, JSON.stringify([maxBytes, reserve, offer])); assert(offer.freeBytes <= offer.capacityBytes);
  }
  assert.equal(world.policy.storage.enabled, true);
});
