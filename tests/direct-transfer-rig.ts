import { createServer } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { TestContext } from 'node:test';
import { PrivaNode } from '@privanet/node/daemon';
import { StorageService } from '@privanet/node/store/service';
import { TransferMeter } from '@privanet/node/transfer-meter';
import { ResourcePolicySchema } from '@privanet/node/resource-policy';
import { PrivaNetClient } from '@privanet/sdk';
import { generateHolderKey } from '@privanet/shared';
import { TEST_CERT, TEST_KEY } from './tls-fixture.js';
import { httpRig, until } from './storage-http.js';
import type { HttpRig } from './storage-http.js';
import type { ResourcePolicy } from '@privanet/node/resource-policy';
import type { TransferGrant } from '@privanet/protocol';
interface DirectRig {
  coordinator: HttpRig; dir: string; world: { policy: ResourcePolicy; blockers: string[] }; meter: TransferMeter;
  app: Awaited<ReturnType<HttpRig['admin']['app']>>; client: PrivaNetClient; node: PrivaNode; storage: StorageService;
  restart(): Promise<void>;
  placement(bytes: Buffer): Promise<{ holder: ReturnType<typeof generateHolderKey>; grant: TransferGrant; chunkId: string }>;
}

export async function freePort(): Promise<number> {
  const server = createServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error();
  await new Promise<void>(resolve => server.close(() => resolve())); return address.port;
}
export async function directRig(t: TestContext, options: { timeoutMs?: number; idleMs?: number } = {}): Promise<DirectRig> {
  const coordinator = await httpRig(t); const dir = await mkdtemp(join(tmpdir(), 'privanet-direct-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const certificateFile = join(dir, 'cert.pem'); const keyFile = join(dir, 'key.pem');
  await writeFile(certificateFile, TEST_CERT, { mode: 0o600 }); await writeFile(keyFile, TEST_KEY, { mode: 0o600 });
  const port = await freePort();
  const world = { policy: ResourcePolicySchema.parse({ maxBandwidthBytesPerSec: null, monthlyTransferBytes: null, storage: { enabled: true, maxBytes: 64 * 1024 * 1024, reserveFreeBytes: 0,
    transfer: { enabled: true, port, endpoint: `https://127.0.0.1:${port}`, certificateFile, keyFile } } }), blockers: [] as string[] };
  const meter = new TransferMeter({ stateDir: dir, ratePerSec: null, monthlyBytes: null });
  let storage: StorageService | undefined;
  const grant = await coordinator.admin.enrollment();
  const makeNode = (token?: string) => new PrivaNode({ url: coordinator.url, allowInsecureLoopback: true, stateDir: dir, capabilities: ['system.echo.v1'], heartbeatMs: 20,
    ...(token ? { enrollmentToken: token } : {}), services: () => { const offer = storage?.advertisement(); return offer ? { 'storage.chunk.v1': offer } : undefined; } });
  let node = makeNode(grant.token); await node.tick();
  const makeStorage = () => new StorageService({ stateDir: dir, policy: () => world.policy, inputs: { draining: () => node.isDraining, engine: { get state() { return { blockers: world.blockers }; }, report: { contribution: 'ADAPTIVE', diskIo: 'low' } } },
    direct: { node, meter, ...options }, storeOptions: { freeBytes: async () => 1024 ** 3 } });
  storage = makeStorage(); await storage.start(); t.after(async () => { await storage?.stop(); });
  await node.tick(); await until(() => node.transferKeys !== null, 'transfer keys');
  const app = await coordinator.admin.app({ name: 'direct-test', allowedJobTypes: [], allowedServices: ['storage.chunk.v1'] });
  const client = new PrivaNetClient({ url: coordinator.url, allowInsecureLoopback: true, token: app.token });
  const rig = { coordinator, dir, world, meter, app, client,
    get node() { return node; }, get storage() { return storage!; },
    async restart() { await storage?.stop(); node = makeNode(); await node.tick(); storage = makeStorage(); await storage.start(); await node.tick(); if (storage.status.transfer?.listener === "LISTENING") await until(() => node.transferKeys !== null); },
    async placement(bytes: Buffer) { const holder = generateHolderKey(); const chunkId = (await import('./storage-rig.js')).chunkIdOf(bytes); const placed = await coordinator.apiFor(app.token).place({ directTransfer: true, chunkId, size: bytes.length, holderKey: holder.publicKey }); return { holder, grant: placed.grant!, chunkId }; },
  };
  return rig;
}
