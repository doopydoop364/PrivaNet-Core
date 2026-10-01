import { ApiError, Transport } from '@privanet/shared';
import {
  AckSchema, AppCredentialSchema, CapabilitiesSchema, DisplayNameSchema, EnrollmentTokenIdSchema, EnrollmentTokenSchema, EnrollmentTokensSchema, IdSchema, InviteCreatedSchema, InviteIdSchema,
  InvitesSchema, JoinRequestsSchema, NodeIdSchema, NodesSchema, TypedCodeSchema, formatCode, normalizeCode,
} from '@privanet/protocol';

const USAGE = `Usage:
  privanet-admin enrollment create [--expires 10m] [--capabilities web.fetch.v1[,..]] [--label NAME] [--json]
  privanet-admin enrollment list [--all] [--json]          active tokens (--all adds used, expired and revoked ones)
  privanet-admin enrollment revoke TOKEN_ID                withdraw a token that has not been used
  privanet-admin invite create [--expires 10m] [--capabilities web.fetch.v1[,..]] [--label NAME] [--json]      a short code for a contributor (at most 1 hour)
  privanet-admin invite list [--all] [--json]              active invites (--all adds used, expired, revoked and locked ones)
  privanet-admin invite revoke INVITE_ID
  privanet-admin requests list [--all] [--json]            machines asking to join (privanet-node join), waiting for you
  privanet-admin approve CODE --capabilities web.fetch.v1[,..] [--label NAME]       let that machine join, with at most these capabilities
  privanet-admin deny CODE                                 refuse a request (or withdraw an approval it has not used yet)
  privanet-admin nodes list [--json]
  privanet-admin nodes show NODE [--json]                  NODE is a node ID, a unique prefix of one (8+ characters) or an exact name
  privanet-admin nodes revoke NODE
  privanet-admin nodes rename NODE NAME... | nodes rename NODE --clear
  privanet-admin application [NAME] | revoke-application ID | rotate-application ID
Older forms still work and print JSON: enrollment | nodes | revoke-node ID | application NAME
Durations: 30s, 10m, 2h, 1d (1 second to 24 hours; an invite at most 1 hour).`;

class UsageError extends Error {}
const VALUE_FLAGS = new Set(['--expires', '--capabilities', '--label']);
const BOOLEAN_FLAGS = new Set(['--json', '--all', '--clear']);
function parseArgs(argv) {
  const flags = {}; const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (VALUE_FLAGS.has(arg)) { const value = argv[++i]; if (value === undefined || value.startsWith('--')) throw new UsageError(`${arg} needs a value`); flags[arg.slice(2)] = value; }
    else if (BOOLEAN_FLAGS.has(arg)) flags[arg.slice(2)] = true;
    else if (arg.startsWith('--')) throw new UsageError(`unknown option ${arg.split('=')[0]}`);
    else positional.push(arg);
  }
  return { flags, positional };
}
function parseDuration(text) {
  const match = /^(\d{1,9})(s|m|h|d)$/.exec(text);
  if (!match) throw new UsageError('a duration looks like 30s, 10m, 2h or 1d');
  const ms = Number(match[1]) * { s: 1000, m: 60000, h: 3600000, d: 86400000 }[match[2]];
  if (ms < 1000 || ms > 86400000) throw new UsageError('the lifetime must be between 1 second and 24 hours');
  return ms;
}
const iso = (ms) => ms === null || ms === undefined ? '-' : new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const ago = (ms, now = Date.now()) => {
  if (ms === null || ms === undefined) return 'never';
  const seconds = Math.max(0, Math.round((now - ms) / 1000));
  if (seconds < 90) return `${seconds}s ago`; if (seconds < 5400) return `${Math.round(seconds / 60)}m ago`; if (seconds < 129600) return `${Math.round(seconds / 3600)}h ago`; return `${Math.round(seconds / 86400)}d ago`;
};
const inFuture = (ms, now = Date.now()) => { const seconds = Math.round((ms - now) / 1000); return seconds <= 0 ? 'expired' : seconds < 90 ? `in ${seconds}s` : seconds < 5400 ? `in ${Math.round(seconds / 60)}m` : `in ${Math.round(seconds / 3600)}h`; };
function table(rows) {
  const widths = rows[0].map((_, column) => Math.max(...rows.map(row => String(row[column]).length)));
  return rows.map(row => row.map((cell, column) => String(cell).padEnd(widths[column])).join('  ').trimEnd()).join('\n');
}
const printJson = (value) => console.log(JSON.stringify(value));
/** A request code as a person types it ("j4m7 k2q9", "J4M7-K2Q9"): checked, then sent in its canonical form so nothing odd travels in a URL. */
function requestCode(parts) {
  const typed = TypedCodeSchema.safeParse(parts.filter(part => part !== undefined).join(' '));
  const normalized = typed.success ? normalizeCode(typed.data) : null;
  if (normalized === null) throw new UsageError('that is not a request code (8 letters and digits, for example J4M7-K2Q9)');
  return formatCode(normalized);
}

async function main() {
  const transport = new Transport({ url: process.env.PRIVANET_COORDINATOR_URL ?? 'http://127.0.0.1:4010', allowInsecureLoopback: process.env.PRIVANODE_ALLOW_INSECURE_LOOPBACK === 'true' });
  const token = process.env.PRIVANET_ADMIN_SECRET;
  if (!token || !/^[a-f0-9]{64}$/.test(token)) throw new Error('Admin credential required');
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const [operation, subcommand, ...rest] = positional;
  // Least privilege by default; PRIVANET_JOB_TYPES=system.echo.v1,system.hashchain.v1 grants more (the Coordinator validates every id).
  const envTypes = process.env.PRIVANET_JOB_TYPES ? process.env.PRIVANET_JOB_TYPES.split(',') : ['system.echo.v1'];
  const request = (method, path, schema, body) => transport.request(method, path, schema, body, token);
  const nodes = async () => (await request('GET', '/v1/admin/nodes', NodesSchema)).nodes;
  /** A node ID, a unique prefix of one, or an exact name; never a guess between several. */
  const resolveNode = async (reference) => {
    if (!reference) throw new UsageError('which node? give a node ID, a unique prefix of one (8+ characters) or an exact name');
    const all = await nodes();
    const exact = all.filter(node => node.nodeId === reference || node.displayName === reference);
    const matches = exact.length ? exact : reference.length >= 8 ? all.filter(node => node.nodeId.startsWith(reference)) : [];
    if (matches.length === 0) throw new UsageError('no such node');
    if (matches.length > 1) throw new UsageError('that matches more than one node; give more of the ID');
    return matches[0];
  };

  if (operation === 'enrollment' && subcommand === 'create') {
    const expiresInMs = flags.expires ? parseDuration(flags.expires) : Number(process.env.PRIVANET_ENROLLMENT_TTL_MS ?? 600000);
    const capabilities = flags.capabilities ? CapabilitiesSchema.parse(flags.capabilities.split(',')) : envTypes;
    const label = flags.label === undefined ? undefined : DisplayNameSchema.parse(flags.label);
    const created = await request('POST', '/v1/admin/enrollment-tokens', EnrollmentTokenSchema, { expiresInMs, capabilities, ...(label ? { label } : {}) });
    if (flags.json) { printJson(created); return; }
    // Explicit administrator issuance output, not a service log: the token is shown here once and is not stored anywhere in recoverable form.
    const where = process.env.PRIVANET_PUBLIC_URL ?? 'https://<coordinator-address>';
    console.log(['Enrollment token created.', `Token:         ${created.token}`, `Token ID:      ${created.id ?? '-'}`, `Expires:       ${iso(created.expiresAt)} (${inFuture(created.expiresAt)})`,
      `Capabilities:  ${(created.capabilities ?? capabilities).join(', ') || '(none)'}`, ...(created.label ? [`Name:          ${created.label}`] : []), '',
      'The token is single-use and is not shown again. On the machine that will join:', `  privanet-node enroll --coordinator ${where} --token <the token above>`, ''].join('\n'));
  } else if (operation === 'enrollment' && subcommand === undefined) {
    // Legacy form (JSON on one line), kept for scripts: expiry and capabilities from the environment.
    printJson(await request('POST', '/v1/admin/enrollment-tokens', EnrollmentTokenSchema, { expiresInMs: Number(process.env.PRIVANET_ENROLLMENT_TTL_MS ?? 60000), capabilities: envTypes }));
  } else if (operation === 'enrollment' && subcommand === 'list') {
    const { tokens } = await request('GET', '/v1/admin/enrollment-tokens', EnrollmentTokensSchema);
    const shown = flags.all ? tokens : tokens.filter(entry => entry.status === 'ACTIVE');
    if (flags.json) { printJson({ tokens: shown }); return; }
    if (shown.length === 0) console.log(flags.all ? 'No enrollment tokens on record.' : 'No active enrollment tokens.');
    else console.log(table([['ID', 'STATUS', 'CREATED', 'EXPIRES', 'CAPABILITIES', 'NAME', 'USED BY'],
      ...shown.map(entry => [entry.id, entry.status, iso(entry.createdAt), iso(entry.expiresAt), entry.capabilities.join(',') || '-', entry.label ?? '-', entry.nodeId ? `${entry.nodeId.slice(0, 13)}…` : '-'])]));
    if (!flags.all && tokens.length > shown.length) console.log(`(${tokens.length - shown.length} used, expired or revoked tokens not shown; --all lists them)`);
  } else if (operation === 'enrollment' && subcommand === 'revoke') {
    const id = EnrollmentTokenIdSchema.parse(rest[0]);
    await request('POST', `/v1/admin/enrollment-tokens/${id}/revoke`, AckSchema, {});
    if (flags.json) printJson({ ok: true }); else console.log(`Enrollment token ${id} revoked.`);
  } else if (operation === 'invite' && subcommand === 'create') {
    const expiresInMs = flags.expires ? parseDuration(flags.expires) : 600000;
    if (expiresInMs > 3600000) throw new UsageError('an invite is a short introduction: at most 1 hour (use an enrollment token for longer)');
    const capabilities = flags.capabilities ? CapabilitiesSchema.parse(flags.capabilities.split(',')) : envTypes;
    const label = flags.label === undefined ? undefined : DisplayNameSchema.parse(flags.label);
    const created = await request('POST', '/v1/admin/invites', InviteCreatedSchema, { expiresInMs, capabilities, ...(label ? { label } : {}) });
    if (flags.json) { printJson(created); return; }
    // Explicit administrator issuance output, not a service log: the code is shown here once and is not stored in recoverable form.
    console.log(['Invite created.', `Code:          ${created.code}`, `Invite ID:     ${created.id}`, `Expires:       ${iso(created.expiresAt)} (${inFuture(created.expiresAt)})`,
      `Capabilities:  ${created.capabilities.join(', ') || '(none)'}`, ...(created.label ? [`Name:          ${created.label}`] : []), '',
      'The code works once, from a machine that reaches this Coordinator over verified TLS, and is not shown again. Give it to the contributor over a private channel:',
      `  privanet-node enroll --coordinator ${process.env.PRIVANET_PUBLIC_URL ?? 'https://<coordinator-address>'} --invite-stdin      (then type or paste the code)`, ''].join('\n'));
  } else if (operation === 'invite' && subcommand === 'list') {
    const { invites } = await request('GET', '/v1/admin/invites', InvitesSchema);
    const shown = flags.all ? invites : invites.filter(entry => entry.status === 'ACTIVE');
    if (flags.json) { printJson({ invites: shown }); return; }
    if (shown.length === 0) console.log(flags.all ? 'No invites on record.' : 'No active invites.');
    else console.log(table([['ID', 'STATUS', 'CREATED', 'EXPIRES', 'CAPABILITIES', 'NAME', 'WRONG GUESSES', 'USED BY'],
      ...shown.map(entry => [entry.id, entry.status, iso(entry.createdAt), iso(entry.expiresAt), entry.capabilities.join(',') || '-', entry.label ?? '-', entry.failedAttempts, entry.nodeId ? `${entry.nodeId.slice(0, 13)}…` : '-'])]));
    if (!flags.all && invites.length > shown.length) console.log(`(${invites.length - shown.length} used, expired, revoked or locked invites not shown; --all lists them)`);
  } else if (operation === 'invite' && subcommand === 'revoke') {
    const id = InviteIdSchema.parse(rest[0]);
    await request('POST', `/v1/admin/invites/${id}/revoke`, AckSchema, {});
    if (flags.json) printJson({ ok: true }); else console.log(`Invite ${id} revoked.`);
  } else if (operation === 'requests' && (subcommand === 'list' || subcommand === undefined)) {
    const { requests } = await request('GET', '/v1/admin/requests', JoinRequestsSchema);
    const shown = flags.all ? requests : requests.filter(entry => entry.status === 'PENDING' || entry.status === 'APPROVED');
    if (flags.json) { printJson({ requests: shown }); return; }
    if (shown.length === 0) console.log(flags.all ? 'No requests on record.' : 'No requests waiting.');
    else console.log(table([['CODE', 'STATUS', 'NODE', 'NAME HINT', 'ASKED FOR', 'FROM', 'EXPIRES'],
      ...shown.map(entry => [entry.code, entry.status, `${entry.nodeId.slice(0, 13)}…`, entry.deviceName ?? '-', entry.requestedCapabilities.join(',') || '-', entry.source, iso(entry.expiresAt)])]));
    if (shown.some(entry => entry.status === 'PENDING')) console.log('Approve one with: privanet-admin approve CODE --capabilities web.fetch.v1   (compare the NODE with what the machine printed)');
  } else if (operation === 'approve') {
    const code = requestCode([subcommand, ...rest]);
    if (!flags.capabilities) throw new UsageError('say what this machine may do: --capabilities web.fetch.v1 (you choose; what it asked for is shown by `requests list`)');
    const label = flags.label === undefined ? undefined : DisplayNameSchema.parse(flags.label);
    await request('POST', `/v1/admin/requests/${code}/approve`, AckSchema, { capabilities: CapabilitiesSchema.parse(flags.capabilities.split(',')), ...(label ? { label } : {}) });
    if (flags.json) printJson({ ok: true }); else console.log(`Approved ${code}. The machine finishes enrolling by itself within a few seconds.`);
  } else if (operation === 'deny') {
    const code = requestCode([subcommand, ...rest]);
    await request('POST', `/v1/admin/requests/${code}/deny`, AckSchema, {});
    if (flags.json) printJson({ ok: true }); else console.log(`Declined ${code}.`);
  } else if (operation === 'nodes' && subcommand === undefined) {
    printJson({ nodes: await nodes() }); // legacy form
  } else if (operation === 'nodes' && subcommand === 'list') {
    const all = await nodes();
    if (flags.json) { printJson({ nodes: all }); return; }
    if (all.length === 0) { console.log('No nodes enrolled.'); return; }
    console.log(table([['NAME', 'NODE', 'STATUS', 'LAST SEEN', 'CAPABILITIES', 'SLOTS', 'PROTOCOL', 'ENROLLED'],
      ...all.map(node => [node.displayName ?? '-', `${node.nodeId.slice(0, 13)}…`, node.status, ago(node.lastHeartbeatAt), node.capabilities.join(',') || '-', `${node.currentJobs}/${node.jobSlots}`, node.protocolVersion, iso(node.enrolledAt)])]));
  } else if (operation === 'nodes' && subcommand === 'show') {
    const node = await resolveNode(rest[0]);
    if (flags.json) { printJson(node); return; }
    console.log([`Node ID:        ${node.nodeId}`, `Name:           ${node.displayName ?? '-'}`, `Status:         ${node.status}${node.status === 'REVOKED' ? ` (since ${iso(node.revokedAt)})` : ''}`,
      `Last seen:      ${node.lastHeartbeatAt === null ? 'never' : `${iso(node.lastHeartbeatAt)} (${ago(node.lastHeartbeatAt)})`}`, `Enrolled:       ${iso(node.enrolledAt)}`,
      `Capabilities:   ${node.capabilities.join(', ') || '(none)'}`, `Protocol:       ${node.protocolVersion}`, `Software:       ${node.daemonVersion}`, `Job slots:      ${node.currentJobs} running of ${node.jobSlots}`].join('\n'));
  } else if (operation === 'nodes' && subcommand === 'revoke') {
    const node = await resolveNode(rest[0]);
    await request('POST', `/v1/admin/nodes/${NodeIdSchema.parse(node.nodeId)}/revoke`, AckSchema, {});
    if (flags.json) printJson({ ok: true }); else console.log(`Node ${node.nodeId} revoked. It can no longer authenticate, and its leased jobs were handed back.`);
  } else if (operation === 'nodes' && subcommand === 'rename') {
    const node = await resolveNode(rest[0]);
    const name = rest.slice(1).join(' ');
    if (!flags.clear && !name) throw new UsageError('give the new name, or --clear to remove it');
    await request('POST', `/v1/admin/nodes/${NodeIdSchema.parse(node.nodeId)}/rename`, AckSchema, { displayName: flags.clear ? null : DisplayNameSchema.parse(name) });
    if (flags.json) printJson({ ok: true }); else console.log(flags.clear ? `Node ${node.nodeId} no longer has a name.` : `Node ${node.nodeId} is now named "${name}".`);
  } else if (operation === 'application') {
    // An application that uses a fetch capability registers its identity here (product token for the User-Agent and robots.txt, plus an information URL); the Coordinator stamps it into leases.
    const identity = process.env.PRIVANET_FETCH_PRODUCT ? { fetchIdentity: { product: process.env.PRIVANET_FETCH_PRODUCT, infoUrl: process.env.PRIVANET_FETCH_INFO_URL ?? '' } } : {};
    printJson(await request('POST', '/v1/admin/applications', AppCredentialSchema, { name: subcommand ?? 'demo', allowedJobTypes: envTypes, ...identity }));
  } else if (operation === 'revoke-node') printJson(await request('POST', `/v1/admin/nodes/${NodeIdSchema.parse(subcommand)}/revoke`, AckSchema, {}));
  else if (operation === 'revoke-application') printJson(await request('POST', `/v1/admin/applications/${IdSchema.parse(subcommand)}/revoke`, AckSchema, {}));
  else if (operation === 'rotate-application') printJson(await request('POST', `/v1/admin/applications/${IdSchema.parse(subcommand)}/rotate`, AppCredentialSchema, {}));
  else throw new UsageError('unknown command');
}
main().catch((error) => {
  // Never print a message from a library error (it can quote a request); a usage problem and a Coordinator refusal are the only things worth saying.
  if (error instanceof UsageError) console.error(`${error.message}\n\n${USAGE}`);
  else if (error?.name === 'ZodError') console.error(`An argument is not in the expected form.\n\n${USAGE}`);
  else if (error instanceof ApiError) console.error(`Admin operation failed (${error.code}).`);
  else console.error('Admin operation failed; check operation, credentials and Coordinator status.');
  process.exitCode = 1;
});
