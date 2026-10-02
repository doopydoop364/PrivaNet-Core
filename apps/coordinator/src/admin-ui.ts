import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import {
  AckSchema, CapabilitiesSchema, DisplayNameSchema, HealthSchema, INVITE_MAX_MS, InviteCreatedSchema, InviteIdSchema, InvitesSchema, JOB_TYPE_IDS, JoinRequestsSchema, NodeIdSchema, NodesSchema,
  PROTOCOL_VERSION, SERVICE_VERSION, StorageSummarySchema, TypedCodeSchema, formatCode, normalizeCode,
} from '@privanet/protocol';
import type { NodeViewSchema } from '@privanet/protocol';
import { ApiError, Transport, startLocalUi } from '@privanet/shared';
import type { LocalUiReply } from '@privanet/shared';
import { renderAdminPage } from './admin-page.js';

/**
 * The operator dashboard (`privanet-admin ui`): the administrator's view of nodes, invites and join requests in a browser, on this machine only.
 *
 * It is a client of the Coordinator's existing administrator API, not a new surface on the Coordinator: this separate process holds the administrator secret, speaks the same
 * schema-checked requests the CLI does, and never returns the secret, an application credential or an enrollment token to the browser. The Coordinator's `/v1/admin/*`
 * isolation is untouched (and still must not be exposed through a public proxy). The browser is guarded by `startLocalUi`: loopback bind, Host and Origin checks, a one-run
 * sign-in secret exchanged for a session cookie, CSRF and a nonce CSP. What it can do is the fixed list below; application credentials and enrollment tokens are deliberately
 * not on it (the CLI shows them once, and a browser page is a worse place for them).
 */
export const DEFAULT_ADMIN_UI_PORT = 4041;
export interface AdminUiOptions {
  coordinatorUrl: string; adminSecret: string; allowInsecureLoopback?: boolean; port: number;
  /** The address contributors use (shown in the instructions next to a new invite). */ publicUrl?: string;
  clock?: () => number;
}
export interface AdminUiHandle { port: number; address: string; token: string; close: () => Promise<void> }

type NodeView = z.infer<typeof NodeViewSchema>;
const CreateInviteBody = z.strictObject({ minutes: z.number().int().min(1).max(INVITE_MAX_MS / 60000), capabilities: CapabilitiesSchema, label: DisplayNameSchema.optional() });
const RevokeInviteBody = z.strictObject({ id: InviteIdSchema });
const ApproveBody = z.strictObject({ code: TypedCodeSchema, capabilities: CapabilitiesSchema, label: DisplayNameSchema.optional() });
const DenyBody = z.strictObject({ code: TypedCodeSchema });
const RenameBody = z.strictObject({ nodeId: NodeIdSchema, name: DisplayNameSchema.nullable() });
const RevokeNodeBody = z.strictObject({ nodeId: NodeIdSchema, confirm: z.literal(true) });

const parseVersion = (text: string): [number, number, number] => { const [a = 0, b = 0, c = 0] = text.split('-')[0]!.split('.').map(Number); return [a, b, c]; };
/** Compares a node's software with the Coordinator's; protocol is what decides compatibility, the software version is information. */
export function versionNote(node: { daemonVersion: string; protocolVersion: number }, coordinator: { serviceVersion: string; protocolVersion: number } | undefined): { state: 'current' | 'node-older' | 'node-newer' | 'protocol-mismatch' | 'unknown'; text: string } {
  if (!coordinator) return { state: 'unknown', text: 'The Coordinator\'s own version could not be read.' };
  if (node.protocolVersion !== coordinator.protocolVersion) return { state: 'protocol-mismatch', text: `Speaks protocol ${node.protocolVersion}; this Coordinator speaks ${coordinator.protocolVersion}. It cannot work with this Coordinator until one is upgraded.` };
  const a = parseVersion(node.daemonVersion); const b = parseVersion(coordinator.serviceVersion);
  for (let i = 0; i < 3; i++) { if (a[i]! < b[i]!) return { state: 'node-older', text: `Software ${node.daemonVersion} is older than the Coordinator (${coordinator.serviceVersion}); same protocol, so it still works.` }; if (a[i]! > b[i]!) return { state: 'node-newer', text: `Software ${node.daemonVersion} is newer than the Coordinator (${coordinator.serviceVersion}); same protocol, so it still works.` }; }
  return { state: 'current', text: `Software ${node.daemonVersion}, same as the Coordinator.` };
}
/** What the Coordinator can honestly say about a node: only what it stores (its status, its last heartbeat, what the node last reported about itself), worded as such. */
export function describeNode(node: NodeView, coordinator: { serviceVersion: string; protocolVersion: number } | undefined, now: number) {
  const never = node.lastHeartbeatAt === null;
  const state = { ONLINE: 'Online', STALE: 'Not heard from for a little while', OFFLINE: never ? 'Enrolled, has never connected' : 'Offline', DRAINING: 'Draining: finishing its jobs, taking no new ones', OFFLINE_EXPECTED: 'Offline (it said it was stopping)', REVOKED: 'Revoked: it can no longer sign in' }[node.status];
  const report = node.resources;
  return {
    nodeId: node.nodeId, name: node.displayName ?? null, status: node.status, state, lastSeenAt: node.lastHeartbeatAt, ageMs: node.lastHeartbeatAt === null ? null : Math.max(0, now - node.lastHeartbeatAt),
    enrolledAt: node.enrolledAt ?? null, revokedAt: node.revokedAt ?? null, capabilities: node.capabilities, jobs: { running: node.currentJobs, slots: node.jobSlots },
    software: node.daemonVersion, protocolVersion: node.protocolVersion, version: versionNote(node, coordinator),
    // Self-reported by the node and not verified; the owner's own limits decide what is really offered.
    reported: report ? { contribution: report.contribution, pressure: report.pressure, power: report.power, memoryBudgetBytes: report.memoryBudgetBytes, cpuBudgetPercent: report.cpuBudgetPercent } : null,
  };
}

export async function startAdminUi(options: AdminUiOptions): Promise<AdminUiHandle> {
  if (!/^[a-f0-9]{64}$/.test(options.adminSecret)) throw new Error('Admin credential required');
  const transport = new Transport({ url: options.coordinatorUrl, allowInsecureLoopback: options.allowInsecureLoopback === true, timeoutMs: 8000 });
  const secret = options.adminSecret; const clock = options.clock ?? Date.now; const token = randomBytes(32).toString('hex');
  const call = <T>(method: 'GET' | 'POST', path: string, schema: z.ZodType<T>, body?: unknown) => transport.request(method, path, schema, body, secret);
  const done = (body: unknown = { ok: true }): LocalUiReply => ({ status: 200, body });
  const bad = (code = 'INVALID_REQUEST', status = 400): LocalUiReply => ({ status, body: { error: { code } } });
  /** Only the status code of a Coordinator refusal reaches the browser, never its message (which may quote a request). */
  const refused = (error: unknown): LocalUiReply => {
    if (error instanceof ApiError) return { status: error.status >= 400 && error.status < 500 ? error.status : 502, body: { error: { code: error.code } } };
    return { status: 502, body: { error: { code: 'COORDINATOR_UNREACHABLE' } } };
  };

  const overview = async (): Promise<LocalUiReply> => {
    const [health, nodes, invites, requests, storage] = await Promise.allSettled([call('GET', '/v1/health', HealthSchema), call('GET', '/v1/admin/nodes', NodesSchema), call('GET', '/v1/admin/invites', InvitesSchema), call('GET', '/v1/admin/requests', JoinRequestsSchema), call('GET', '/v1/admin/storage', StorageSummarySchema)]);
    const coordinator = health.status === 'fulfilled' ? { serviceVersion: health.value.serviceVersion, protocolVersion: health.value.protocolVersion } : undefined;
    const adminRefused = [nodes, invites, requests].some(result => result.status === 'rejected' && result.reason instanceof ApiError && (result.reason.status === 401 || result.reason.status === 403));
    const now = clock();
    return done({
      coordinator: { origin: transport.origin, reachable: health.status === 'fulfilled', ...(coordinator ?? {}), adminCredential: adminRefused ? 'refused' : nodes.status === 'fulfilled' ? 'accepted' : 'unknown' },
      dashboardVersion: SERVICE_VERSION, dashboardProtocol: PROTOCOL_VERSION, now, publicUrl: options.publicUrl ?? null, capabilities: JOB_TYPE_IDS,
      nodes: nodes.status === 'fulfilled' ? nodes.value.nodes.map(node => describeNode(node, coordinator, now)) : null,
      invites: invites.status === 'fulfilled' ? invites.value.invites : null, requests: requests.status === 'fulfilled' ? requests.value.requests : null,
      // Aggregates only (counts and sizes): null from an older Coordinator, which has no storage control plane.
      storage: storage.status === 'fulfilled' ? storage.value : null,
    });
  };
  const parse = <S extends z.ZodType>(schema: S, body: unknown): z.infer<S> | undefined => { const result = schema.safeParse(body); return result.success ? result.data : undefined; };

  const handle = await startLocalUi({
    port: options.port, cookieName: 'privanet_admin', secret: token, page: renderAdminPage, ...(options.clock ? { clock: options.clock } : {}),
    sessionInfo: () => ({ version: SERVICE_VERSION, protocolVersion: PROTOCOL_VERSION }),
    get: request => request.path === '/api/overview' ? overview() : undefined,
    post: async (request, body) => {
      try {
        switch (request.path) {
          case '/api/invites/create': {
            const data = parse(CreateInviteBody, body); if (!data) return bad();
            const created = await call('POST', '/v1/admin/invites', InviteCreatedSchema, { expiresInMs: data.minutes * 60000, capabilities: data.capabilities, ...(data.label ? { label: data.label } : {}) });
            // The one place the code is shown: this answer. The Coordinator keeps only a keyed hash.
            return done({ ok: true, invite: created, enroll: `privanet-node enroll --coordinator ${options.publicUrl ?? 'https://<coordinator-address>'} --invite-stdin` });
          }
          case '/api/invites/revoke': { const data = parse(RevokeInviteBody, body); if (!data) return bad(); await call('POST', `/v1/admin/invites/${data.id}/revoke`, AckSchema, {}); return done(); }
          case '/api/requests/approve': {
            const data = parse(ApproveBody, body); const normalized = data ? normalizeCode(data.code) : null; if (!data || normalized === null) return bad();
            await call('POST', `/v1/admin/requests/${formatCode(normalized)}/approve`, AckSchema, { capabilities: data.capabilities, ...(data.label ? { label: data.label } : {}) }); return done();
          }
          case '/api/requests/deny': { const data = parse(DenyBody, body); const normalized = data ? normalizeCode(data.code) : null; if (!data || normalized === null) return bad(); await call('POST', `/v1/admin/requests/${formatCode(normalized)}/deny`, AckSchema, {}); return done(); }
          case '/api/nodes/rename': { const data = parse(RenameBody, body); if (!data) return bad(); await call('POST', `/v1/admin/nodes/${data.nodeId}/rename`, AckSchema, { displayName: data.name }); return done(); }
          case '/api/nodes/revoke': { const data = parse(RevokeNodeBody, body); if (!data) return bad(); await call('POST', `/v1/admin/nodes/${data.nodeId}/revoke`, AckSchema, {}); return done(); }
          default: return undefined;
        }
      } catch (error) { return refused(error); }
    },
  });
  return { port: handle.port, address: handle.address, token, close: handle.close };
}
