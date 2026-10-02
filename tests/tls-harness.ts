import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpsServer } from 'node:https';
import type { Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hash, secret } from '@privanet/shared';
import { Coordinator } from '@privanet/coordinator/service';
import { SqliteStore } from '@privanet/coordinator/store';
import { createCoordinatorServer } from '@privanet/coordinator/server';
import { GOOD_CERT, GOOD_KEY } from './doctor-fixture.js';

export async function listenAny(server: { listen: (port: number, host: string, cb: () => void) => unknown; address: () => unknown; once: (event: string, cb: (e: Error) => void) => unknown }): Promise<number> {
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); assert(address && typeof address === 'object' && 'port' in address); return Number(address.port);
}

export /** A real Coordinator behind TLS, so the healthy path is the real one. */
async function realCoordinator(t: TestContext, cert = GOOD_CERT, key = GOOD_KEY, hide: string[] = []) {
  const dir = await mkdtemp(join(tmpdir(), 'privanet-doctor-coordinator-')); const adminSecret = secret();
  const store = new SqliteStore(join(dir, 'c.sqlite')); const core = new Coordinator(store, { offlineMs: 60000, staleMs: 30000 }, Date.now, undefined, { inviteKey: Buffer.from(hash(`k${adminSecret}`), 'hex') });
  const inner: Server = createCoordinatorServer(core, { adminSecret, authRequestsPerMinute: 10000 });
  const server = createHttpsServer({ cert, key }, (req, res) => { if (hide.some(prefix => (req.url ?? '').startsWith(prefix))) { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{}'); return; } inner.emit('request', req, res); });
  const port = await listenAny(server);
  t.after(async () => { await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); store.close(); await rm(dir, { recursive: true, force: true }); });
  return { port, core, store, url: `https://localhost:${port}` };
}

