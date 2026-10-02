import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CapabilitiesSchema, DisplayNameSchema, SecretSchema, normalizeCode } from '@privanet/protocol';
import { Transport } from '@privanet/shared';
import { classify, EnrollError, enrollNode, joinNode } from './enroll.js';
import type { EnrollResult } from './enroll.js';

export const EXIT_OK = 0, EXIT_FAILED = 1, EXIT_USAGE = 78;
const COMMON = `  --coordinator URL        the Coordinator (https; plain http only to loopback with --allow-insecure-loopback). Or PRIVANODE_COORDINATOR_URL
  --capabilities a,b       capabilities to enroll with (default: everything that is granted). Or PRIVANODE_CAPABILITIES
  --state-dir DIR          where the node keeps its identity (default ./var/node). Or PRIVANODE_STATE_DIR
  --allow-insecure-loopback  allow http to a literal loopback address (development only)
  --json                   print the result as one JSON line (node ID, outcome, capabilities, state directory; never a secret)`;
const ENROLL_USAGE = `Usage: privanet-node enroll --coordinator https://HOST[:PORT] (--token TOKEN | --invite CODE) [options]

Enrolls this machine with a Coordinator using a one-time token or a short invite code from its owner, then exits.
Start the node afterwards with plain \`privanet-node\`: it remembers the Coordinator and needs no token.

${COMMON}
  --token TOKEN            the one-time enrollment token (64 hex characters). Visible to other users of this machine in the process list: prefer --token-file, --token-stdin or PRIVANODE_ENROLLMENT_TOKEN
  --token-file PATH        read the token from a file             --token-stdin  read it from standard input
  --invite CODE            a short invite code such as N7K4-PQ2M (same cautions: prefer the next three)
  --invite-file PATH       read the invite from a file            --invite-stdin  read it from standard input. Or PRIVANODE_INVITE_CODE
`;
const JOIN_USAGE = `Usage: privanet-node join --coordinator https://HOST[:PORT] [options]

Asks to join without any secret: shows a request code, and waits for the owner to approve it (privanet-admin approve CODE). Nothing is
enrolled until they do. Run it again to resume a request that is still open.

${COMMON}
  --name NAME              a name shown to the owner with the request (they choose the node's real name)
  --wait MINUTES           stop waiting after this long (default 30; the request itself expires sooner)
`;
export interface Io { out: (text: string) => void; err: (text: string) => void; readStdin: () => string }
interface Parsed {
  url?: string; token?: string; tokenFile?: string; tokenStdin: boolean; invite?: string; inviteFile?: string; inviteStdin: boolean; capabilities?: string; stateDir?: string;
  insecure: boolean; help: boolean; json: boolean; name?: string; wait?: string;
}
class UsageError extends Error {}
const VALUE: Record<string, keyof Parsed> = { '--coordinator': 'url', '--token': 'token', '--token-file': 'tokenFile', '--invite': 'invite', '--invite-file': 'inviteFile', '--capabilities': 'capabilities',
  '--state-dir': 'stateDir', '--name': 'name', '--wait': 'wait' };
const FLAG: Record<string, keyof Parsed> = { '--token-stdin': 'tokenStdin', '--invite-stdin': 'inviteStdin', '--allow-insecure-loopback': 'insecure', '--json': 'json', '--help': 'help', '-h': 'help' };

function parse(input: string[], allowed: Set<string>): Parsed {
  let argv = input; const parsed: Parsed = { tokenStdin: false, inviteStdin: false, insecure: false, help: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i] ?? '';
    // `--name=value` is the same as `--name value`.
    const equals = arg.startsWith('--') ? arg.indexOf('=') : -1;
    if (equals > 0) { argv = [...argv.slice(0, i), arg.slice(0, equals), arg.slice(equals + 1), ...argv.slice(i + 1)]; arg = argv[i] ?? ''; }
    // Never echo what was given: it could be a token or a code.
    if (!allowed.has(arg)) throw new UsageError(`unknown option ${arg.startsWith('--') ? arg : 'argument'}`);
    const value = VALUE[arg]; const flag = FLAG[arg];
    if (value) { const next = argv[i + 1]; if (next === undefined || next.startsWith('--')) throw new UsageError(`${arg} needs a value`); (parsed as unknown as Record<string, string>)[value] = next; i++; }
    else if (flag) (parsed as unknown as Record<string, boolean>)[flag] = true;
  }
  return parsed;
}
const ENROLL_FLAGS = new Set(['--coordinator', '--token', '--token-file', '--token-stdin', '--invite', '--invite-file', '--invite-stdin', '--capabilities', '--state-dir', '--allow-insecure-loopback', '--json', '--help', '-h']);
const JOIN_FLAGS = new Set(['--coordinator', '--capabilities', '--state-dir', '--allow-insecure-loopback', '--name', '--wait', '--json', '--help', '-h']);

function target(parsed: Parsed, env: NodeJS.ProcessEnv) {
  const url = parsed.url ?? env.PRIVANODE_COORDINATOR_URL;
  if (!url) throw new UsageError('--coordinator is required');
  const insecure = parsed.insecure || env.PRIVANODE_ALLOW_INSECURE_LOOPBACK === 'true';
  try { new Transport({ url, allowInsecureLoopback: insecure }); } catch { throw new UsageError('the Coordinator address must be https://host[:port] (plain http only to a literal loopback address with --allow-insecure-loopback)'); }
  const named = parsed.capabilities ?? env.PRIVANODE_CAPABILITIES; let capabilities;
  if (named !== undefined && named !== '') {
    const result = CapabilitiesSchema.safeParse(named.split(',').map(item => item.trim()));
    if (!result.success) throw new UsageError('--capabilities must be a comma-separated list of capability names this node supports');
    capabilities = result.data;
  }
  return { url, insecure, capabilities, stateDir: resolve(parsed.stateDir ?? env.PRIVANODE_STATE_DIR ?? './var/node') };
}
const report = (result: EnrollResult, stateDir: string): string => [result.outcome === 'ENROLLED' ? 'Enrolled.' : 'This node is already enrolled with this Coordinator; nothing was used.',
  `  Node ID:       ${result.nodeId}`, ...(result.displayName ? [`  Name:          ${result.displayName}`] : []),
  ...(result.outcome === 'ENROLLED' ? [`  Capabilities:  ${result.capabilities.length ? result.capabilities.join(', ') : '(none)'}`] : []), `  State:         ${stateDir}`, '',
  'Start the node with: privanet-node',
  ...(result.outcome === 'ENROLLED' && result.capabilities.length ? ['It will offer exactly the capabilities above. To offer fewer, set PRIVANODE_CAPABILITIES; the owner policy file still bounds what it does.'] : []), ''].join('\n');
/** The result as one JSON line (for scripts and the installer): the node ID, the outcome, the capabilities and the state directory, never a token or a code. */
const reportJson = (result: EnrollResult, stateDir: string): string => JSON.stringify({ ok: true, outcome: result.outcome === 'ENROLLED' ? 'ENROLLED' : 'ALREADY_ENROLLED', nodeId: result.nodeId, displayName: result.displayName ?? null, capabilities: result.outcome === 'ENROLLED' ? result.capabilities : null, stateDir }) + '\n';
const fail = (error: unknown, io: Io): number => {
  if (error instanceof UsageError) { io.err(`${error.message}\n`); return EXIT_USAGE; }
  io.err(`Enrollment failed: ${(error instanceof EnrollError ? error : classify(error)).message}\n`); return EXIT_FAILED;
};

/** Runs `privanet-node enroll`. Returns the process exit status; prints only fixed text, the node ID, the capabilities and the state directory, never the token or the code. */
export async function runEnroll(argv: string[], env: NodeJS.ProcessEnv, io: Io): Promise<number> {
  let parsed: Parsed;
  try { parsed = parse(argv, ENROLL_FLAGS); } catch (error) { io.err(`${error instanceof UsageError ? error.message : 'invalid arguments'}\n\n${ENROLL_USAGE}`); return EXIT_USAGE; }
  if (parsed.help) { io.out(ENROLL_USAGE); return EXIT_OK; }
  try {
    const tokenSources = [parsed.token !== undefined, parsed.tokenFile !== undefined, parsed.tokenStdin].filter(Boolean).length;
    const inviteSources = [parsed.invite !== undefined, parsed.inviteFile !== undefined, parsed.inviteStdin].filter(Boolean).length;
    if (tokenSources > 1 || inviteSources > 1) throw new UsageError('give the token or invite one way only');
    if (tokenSources > 0 && inviteSources > 0) throw new UsageError('give a token or an invite, not both');
    let rawToken = parsed.token; let rawInvite = parsed.invite;
    if (parsed.tokenFile !== undefined) rawToken = readFileSync(resolve(parsed.tokenFile), 'utf8').slice(0, 1024);
    if (parsed.tokenStdin) rawToken = io.readStdin().slice(0, 1024);
    if (parsed.inviteFile !== undefined) rawInvite = readFileSync(resolve(parsed.inviteFile), 'utf8').slice(0, 1024);
    if (parsed.inviteStdin) rawInvite = io.readStdin().slice(0, 1024);
    if (rawToken === undefined && rawInvite === undefined) { rawInvite = env.PRIVANODE_INVITE_CODE; rawToken = rawInvite === undefined ? env.PRIVANODE_ENROLLMENT_TOKEN : undefined; }
    if (rawToken === undefined && rawInvite === undefined) throw new UsageError('an enrollment token or an invite code is required (--token, --invite, a file or stdin option, PRIVANODE_ENROLLMENT_TOKEN or PRIVANODE_INVITE_CODE)');
    const { url, insecure, capabilities, stateDir } = target(parsed, env);
    const common = { url, stateDir, allowInsecureLoopback: insecure, ...(capabilities ? { capabilities } : {}) };
    let result: EnrollResult;
    if (rawInvite !== undefined) {
      const code = normalizeCode(rawInvite.trim());
      if (code === null) throw new UsageError('the invite code is not in the expected form (8 letters and digits, for example N7K4-PQ2M)');
      result = await enrollNode({ ...common, invite: code });
    } else {
      const token = SecretSchema.safeParse((rawToken ?? '').trim());
      if (!token.success) throw new UsageError('the enrollment token is not in the expected form (64 lowercase hexadecimal characters)');
      result = await enrollNode({ ...common, token: token.data });
    }
    io.out(parsed.json ? reportJson(result, stateDir) : report(result, stateDir)); return EXIT_OK;
  } catch (error) { return fail(error, io); }
}

/** Runs `privanet-node join`: ask to join, show the request code, wait for the owner's approval. */
export async function runJoin(argv: string[], env: NodeJS.ProcessEnv, io: Io, hooks: { pollMs?: number; sleep?: (ms: number) => Promise<void> } = {}): Promise<number> {
  let parsed: Parsed;
  try { parsed = parse(argv, JOIN_FLAGS); } catch (error) { io.err(`${error instanceof UsageError ? error.message : 'invalid arguments'}\n\n${JOIN_USAGE}`); return EXIT_USAGE; }
  if (parsed.help) { io.out(JOIN_USAGE); return EXIT_OK; }
  try {
    const { url, insecure, capabilities, stateDir } = target(parsed, env);
    const name = parsed.name === undefined ? undefined : DisplayNameSchema.safeParse(parsed.name);
    if (name && !name.success) throw new UsageError('--name may use letters, digits, spaces, dots, underscores and hyphens (64 characters at most)');
    const wait = parsed.wait === undefined ? 30 : Number(parsed.wait);
    if (!Number.isFinite(wait) || wait <= 0 || wait > 120) throw new UsageError('--wait is a number of minutes between 1 and 120');
    const result = await joinNode({ url, stateDir, allowInsecureLoopback: insecure, ...(capabilities ? { capabilities } : {}), ...(name?.success ? { deviceName: name.data } : {}), maxWaitMs: wait * 60000,
      ...(hooks.pollMs ? { pollMs: hooks.pollMs } : {}), ...(hooks.sleep ? { sleep: hooks.sleep } : {}),
      onRequested: info => (parsed.json ? io.err : io.out)(['', info.resumed ? 'Resuming your request to join.' : 'Request sent. Waiting for the owner to approve it.', `  Request code:  ${info.code}`, `  Node ID:       ${info.nodeId}`,
        `  Expires:       ${new Date(info.expiresAt).toISOString().replace(/\.\d{3}Z$/, 'Z')}`, '',
        'Tell the owner the request code (they approve it with `privanet-admin approve CODE`); the Node ID is what they can compare if they want to be sure it is you.',
        'Nothing is enrolled until they approve. This waits for them; leave it running, or run it again later to resume.', ''].join('\n')) });
    io.out(parsed.json ? reportJson(result, stateDir) : report(result, stateDir)); return EXIT_OK;
  } catch (error) { return fail(error, io); }
}
