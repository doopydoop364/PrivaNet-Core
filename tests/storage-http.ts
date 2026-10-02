import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import type { Server } from 'node:http';
import { z } from 'zod';
import { AckSchema, AppCredentialSchema, EnrollmentTokenSchema, PlacementResponseSchema, TicketResponseSchema, ChunkStatusSchema, StorageSummarySchema, TransferKeysSchema, KeyRotationSchema } from '@privanet/protocol';
import type { ServicesAdvertisement } from '@privanet/protocol';
import { Transport, secret } from '@privanet/shared';
import { Coordinator } from '@privanet/coordinator/service';
import type { Policy } from '@privanet/coordinator/service';
import { SqliteStore } from '@privanet/coordinator/store';
import { createCoordinatorServer } from '@privanet/coordinator/server';
import { TransferKeyring } from '@privanet/coordinator/transfer-keys';
import type { StorageLimits } from '@privanet/coordinator/storage';
import { PrivaNode } from '@privanet/node/daemon';
import { enrollNode } from '@privanet/node/enroll';
import { advert } from './storage-rig.js';

export async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('no address'); return `http://127.0.0.1:${address.port}`;
}
/** A real Coordinator over HTTP with storage on, plus helpers for administrator, application and node calls. */
export async function httpRig(t: TestContext, options: { limits?: Partial<StorageLimits>; policy?: Partial<Policy>; keyring?: boolean; serverOptions?: Record<string, unknown> } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'privanet-http-')); const adminSecret = secret(); const logs: unknown[] = [];
  const store = new SqliteStore(join(dir, 'coordinator.sqlite')); const keyring = options.keyring === false ? undefined : await TransferKeyring.open(dir);
  const core = new Coordinator(store, { sessionMs: 600000, staleMs: 300000, offlineMs: 600000, ...options.policy }, Date.now, undefined, { ...(keyring ? { transferKeys: keyring } : {}), ...(options.limits ? { storageLimits: options.limits } : {}) });
  const server = createCoordinatorServer(core, { adminSecret, log: entry => logs.push(entry), authRequestsPerMinute: 1_000_000, ...options.serverOptions });
  const url = await listen(server); const transport = new Transport({ url, allowInsecureLoopback: true });
  t.after(async () => { await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); store.close(); await rm(dir, { recursive: true, force: true }); });
  const admin = {
    app: (body: object) => transport.request('POST', '/v1/admin/applications', AppCredentialSchema, body, adminSecret),
    enrollment: () => transport.request('POST', '/v1/admin/enrollment-tokens', EnrollmentTokenSchema, { expiresInMs: 600000, capabilities: ['system.echo.v1'] }, adminSecret),
    storage: () => transport.request('GET', '/v1/admin/storage', StorageSummarySchema, undefined, adminSecret),
    rotate: () => transport.request('POST', '/v1/admin/storage/keys/rotate', KeyRotationSchema, {}, adminSecret),
    revokeApplication: (id: string) => transport.request('POST', `/v1/admin/applications/${id}/revoke`, AckSchema, {}, adminSecret),
    revokeNode: (id: string) => transport.request('POST', `/v1/admin/nodes/${id}/revoke`, AckSchema, {}, adminSecret),
  };
  const apiFor = (token: string) => ({
    place: (body: object) => transport.request('POST', '/v1/storage/placements', PlacementResponseSchema, body, token),
    ticket: (body: object) => transport.request('POST', '/v1/storage/tickets', TicketResponseSchema, body, token),
    chunk: (id: string) => transport.request('GET', `/v1/storage/chunks/${id}`, ChunkStatusSchema, undefined, token),
    abort: (id: string) => transport.request('POST', `/v1/storage/transfers/${id}/abort`, AckSchema, {}, token),
  });
  /** A real PrivaNode (the production class) enrolled at this Coordinator, offering the given storage. */
  async function node(offer: () => ServicesAdvertisement | undefined = () => ({ 'storage.chunk.v1': advert() }), extra: Record<string, unknown> = {}, via: string = url) {
    const stateDir = await mkdtemp(join(tmpdir(), 'privanet-http-node-')); t.after(() => rm(stateDir, { recursive: true, force: true }));
    const grant = await admin.enrollment(); await enrollNode({ url: via, token: grant.token, stateDir, allowInsecureLoopback: true });
    const privaNode = new PrivaNode({ url: via, stateDir, capabilities: ['system.echo.v1'], allowInsecureLoopback: true, heartbeatMs: 1000, pollMs: 50, services: offer, log: entry => logs.push(entry), ...extra });
    await privaNode.tick(); // connects, heartbeats (with the offer) and polls once
    return privaNode;
  }
  return { dir, url, adminSecret, logs, store, core, keyring, transport, admin, apiFor, node, raw: (path: string, init: RequestInit = {}) => fetch(url + path, { ...init, headers: { 'X-PrivaNet-Protocol': '1', ...(init.headers ?? {}) } }), z };
}
export type HttpRig = Awaited<ReturnType<typeof httpRig>>;
/** Polls until the condition holds (every 50 ms, up to 5 s): the node's key fetch is deliberately fire-and-forget, and slower runners must not turn that into a flaky fixed sleep. */
export async function until(condition: () => boolean, what = 'condition'): Promise<void> {
  for (const deadline = Date.now() + 5000; Date.now() < deadline; await new Promise(resolve => setTimeout(resolve, 50))) if (condition()) return;
  throw new Error(`timed out waiting for ${what}`);
}
export { TransferKeysSchema };
