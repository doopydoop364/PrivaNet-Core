import { ApiError, Transport } from '@privanet/shared';
import {
  AckSchema, AppCredentialSchema, CapabilitiesSchema, DisplayNameSchema, EnrollmentTokenIdSchema, EnrollmentTokenSchema, EnrollmentTokensSchema, IdSchema, NodeIdSchema, NodesSchema,
} from '@privanet/protocol';

const USAGE = `Usage:
  privanet-admin enrollment create [--expires 10m] [--capabilities web.fetch.v1[,..]] [--label NAME] [--json]
  privanet-admin enrollment list [--all] [--json]          active tokens (--all adds used, expired and revoked ones)
  privanet-admin enrollment revoke TOKEN_ID                withdraw a token that has not been used
  privanet-admin nodes list [--json]
  privanet-admin nodes show NODE [--json]                  NODE is a node ID, a unique prefix of one (8+ characters) or an exact name
  privanet-admin nodes revoke NODE
  privanet-admin nodes rename NODE NAME... | nodes rename NODE --clear
  privanet-admin application [NAME] | revoke-application ID | rotate-application ID
Older forms still work and print JSON: enrollment | nodes | revoke-node ID | application NAME
Durations: 30s, 10m, 2h, 1d (1 second to 24 hours).`;

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
