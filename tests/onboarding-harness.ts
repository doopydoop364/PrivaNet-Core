import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import {
  AckSchema, EnrollmentTokenSchema, EnrollmentTokensSchema, InviteCreatedSchema, InvitesSchema, JoinRequestsSchema, NodesSchema,
} from '@privanet/protocol';
import type { EnrollmentTokenInfo, JobType } from '@privanet/protocol';
import { ApiError, secret, Transport, hash } from '@privanet/shared';
import { Coordinator } from '@privanet/coordinator/service';
import type { Policy } from '@privanet/coordinator/service';
import { SqliteStore } from '@privanet/coordinator/store';
import { createCoordinatorServer } from '@privanet/coordinator/server';
import { enrollNode } from '@privanet/node/enroll';

export const ECHO: JobType[] = ['system.echo.v1']; export const BOTH: JobType[] = ['system.echo.v1', 'system.hashchain.v1'];
export async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); assert(address && typeof address !== 'string'); return `http://127.0.0.1:${address.port}`;
}
export async function close(server: Server) { await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); }

/** A real Coordinator on a loopback port with a clock the test controls (expiry) and every log line captured. */
export async function harness(t: TestContext, options: { failures?: number; inviteFailures?: number; policy?: Partial<Policy>; invites?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'privanet-onboarding-')); const db = join(dir, 'coordinator.sqlite');
  // The clock starts at the real time so a session's expiry is in the node's future too.
  const clock = { t: Date.now() }; const logs: unknown[] = []; const adminSecret = secret();
  const store = new SqliteStore(db); const inviteKey = options.invites === false ? undefined : Buffer.from(hash(`test-invite-key:${adminSecret}`), 'hex');
  const core = new Coordinator(store, { sessionMs: 600000, offlineMs: 600000, staleMs: 300000, ...options.policy }, () => clock.t, undefined, inviteKey ? { inviteKey } : {});
  const server = createCoordinatorServer(core, { adminSecret, log: entry => logs.push(entry), authRequestsPerMinute: 10000, ...(options.failures ? { enrollmentFailuresPerMinute: options.failures } : {}), ...(options.inviteFailures ? { inviteFailuresPerMinute: options.inviteFailures } : {}) });
  const url = await listen(server); const transport = new Transport({ url, allowInsecureLoopback: true });
  t.after(async () => { await close(server); store.close(); await rm(dir, { recursive: true, force: true }); });
  const admin = {
    create: (body: object = {}) => transport.request('POST', '/v1/admin/enrollment-tokens', EnrollmentTokenSchema, { expiresInMs: 600000, capabilities: ECHO, ...body }, adminSecret),
    list: async () => (await transport.request('GET', '/v1/admin/enrollment-tokens', EnrollmentTokensSchema, undefined, adminSecret)).tokens,
    revokeToken: (id: string) => transport.request('POST', `/v1/admin/enrollment-tokens/${id}/revoke`, AckSchema, {}, adminSecret),
    nodes: async () => (await transport.request('GET', '/v1/admin/nodes', NodesSchema, undefined, adminSecret)).nodes,
    revokeNode: (id: string) => transport.request('POST', `/v1/admin/nodes/${id}/revoke`, AckSchema, {}, adminSecret),
    createInvite: (body: object = {}) => transport.request('POST', '/v1/admin/invites', InviteCreatedSchema, { expiresInMs: 600000, capabilities: ECHO, ...body }, adminSecret),
    invites: async () => (await transport.request('GET', '/v1/admin/invites', InvitesSchema, undefined, adminSecret)).invites,
    revokeInvite: (id: string) => transport.request('POST', `/v1/admin/invites/${id}/revoke`, AckSchema, {}, adminSecret),
    requests: async () => (await transport.request('GET', '/v1/admin/requests', JoinRequestsSchema, undefined, adminSecret)).requests,
    approve: (code: string, body: object = {}) => transport.request('POST', `/v1/admin/requests/${code}/approve`, AckSchema, { capabilities: ECHO, ...body }, adminSecret),
    deny: (code: string) => transport.request('POST', `/v1/admin/requests/${code}/deny`, AckSchema, {}, adminSecret),
    rename: (id: string, displayName: string | null) => transport.request('POST', `/v1/admin/nodes/${id}/rename`, AckSchema, { displayName }, adminSecret),
  };
  const enroll = (token: string, extra: Partial<Parameters<typeof enrollNode>[0]> = {}) => enrollNode({ url, token, stateDir: join(dir, `node-${secret().slice(0, 8)}`), allowInsecureLoopback: true, ...extra });
  return { dir, db, url, clock, logs, adminSecret, store, core, transport, admin, enroll, text: () => JSON.stringify(logs) };
}
export async function refusal(promise: Promise<unknown>): Promise<ApiError> {
  try { await promise; } catch (error) { assert(error instanceof ApiError, 'expected an API refusal'); return error; }
  assert.fail('expected a refusal');
}
export const tokenInfo = async (f: Awaited<ReturnType<typeof harness>>, id: string): Promise<EnrollmentTokenInfo> => { const info = (await f.admin.list()).find(entry => entry.id === id); assert.ok(info); return info; };

