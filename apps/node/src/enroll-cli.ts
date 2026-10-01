import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CapabilitiesSchema, SecretSchema } from '@privanet/protocol';
import { Transport } from '@privanet/shared';
import { enrollNode, EnrollError, classify } from './enroll.js';

export const EXIT_OK = 0, EXIT_FAILED = 1, EXIT_USAGE = 78;
const USAGE = `Usage: privanet-node enroll --coordinator https://HOST[:PORT] --token TOKEN [--capabilities a,b] [--state-dir DIR]

Enrolls this machine with a Coordinator using a one-time token from its administrator, then exits.
Start the node afterwards with plain \`privanet-node\`: it remembers the Coordinator and needs no token.

  --coordinator URL        the Coordinator (https; plain http only to loopback with --allow-insecure-loopback). Or PRIVANODE_COORDINATOR_URL
  --token TOKEN            the one-time enrollment token. Visible to other users of this machine in the process list: prefer --token-file, --token-stdin or PRIVANODE_ENROLLMENT_TOKEN
  --token-file PATH        read the token from a file
  --token-stdin            read the token from standard input
  --capabilities a,b       capabilities to enroll with (default: everything the token grants). Or PRIVANODE_CAPABILITIES
  --state-dir DIR          where the node keeps its identity (default ./var/node). Or PRIVANODE_STATE_DIR
  --allow-insecure-loopback  allow http to a literal loopback address (development only)
`;
export interface Io { out: (text: string) => void; err: (text: string) => void; readStdin: () => string }
interface Parsed { url?: string; token?: string; tokenFile?: string; tokenStdin: boolean; capabilities?: string; stateDir?: string; insecure: boolean; help: boolean }

function parse(input: string[]): Parsed {
  let argv = input;
  const parsed: Parsed = { tokenStdin: false, insecure: false, help: false };
  const value = (index: number, name: string) => { const next = argv[index + 1]; if (next === undefined || next.startsWith('--')) throw new UsageError(`${name} needs a value`); return next; };
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i] ?? '';
    // `--name=value` is the same as `--name value`.
    const equals = arg.startsWith('--') ? arg.indexOf('=') : -1;
    if (equals > 0) { argv = [...argv.slice(0, i), arg.slice(0, equals), arg.slice(equals + 1), ...argv.slice(i + 1)]; arg = argv[i] ?? ''; }
    switch (arg) {
      case '--coordinator': parsed.url = value(i, arg); i++; break;
      case '--token': parsed.token = value(i, arg); i++; break;
      case '--token-file': parsed.tokenFile = value(i, arg); i++; break;
      case '--token-stdin': parsed.tokenStdin = true; break;
      case '--capabilities': parsed.capabilities = value(i, arg); i++; break;
      case '--state-dir': parsed.stateDir = value(i, arg); i++; break;
      case '--allow-insecure-loopback': parsed.insecure = true; break;
      case '--help': case '-h': parsed.help = true; break;
      default: throw new UsageError(`unknown option ${arg.startsWith('--') ? arg.split('=')[0] : 'argument'}`); // never echo a value: it could be a token
    }
  }
  return parsed;
}
class UsageError extends Error {}

/** Runs `privanet-node enroll`. Returns the process exit status; prints only fixed text, the node ID, the capabilities and the state directory, never the token. */
export async function runEnroll(argv: string[], env: NodeJS.ProcessEnv, io: Io): Promise<number> {
  let parsed: Parsed;
  try { parsed = parse(argv); } catch (error) { io.err(`${error instanceof UsageError ? error.message : 'invalid arguments'}\n\n${USAGE}`); return EXIT_USAGE; }
  if (parsed.help) { io.out(USAGE); return EXIT_OK; }
  try {
    const sources = [parsed.token !== undefined, parsed.tokenFile !== undefined, parsed.tokenStdin].filter(Boolean).length;
    if (sources > 1) throw new UsageError('give the token one way only: --token, --token-file or --token-stdin');
    let rawToken = parsed.token ?? env.PRIVANODE_ENROLLMENT_TOKEN;
    if (parsed.tokenFile !== undefined) rawToken = readFileSync(resolve(parsed.tokenFile), 'utf8').slice(0, 1024);
    if (parsed.tokenStdin) rawToken = io.readStdin().slice(0, 1024);
    if (rawToken === undefined) throw new UsageError('an enrollment token is required (--token, --token-file, --token-stdin or PRIVANODE_ENROLLMENT_TOKEN)');
    const token = SecretSchema.safeParse(rawToken.trim());
    if (!token.success) throw new UsageError('the enrollment token is not in the expected form (64 lowercase hexadecimal characters)');
    const url = parsed.url ?? env.PRIVANODE_COORDINATOR_URL;
    if (!url) throw new UsageError('--coordinator is required');
    const insecure = parsed.insecure || env.PRIVANODE_ALLOW_INSECURE_LOOPBACK === 'true';
    try { new Transport({ url, allowInsecureLoopback: insecure }); } catch { throw new UsageError('the Coordinator address must be https://host[:port] (plain http only to a literal loopback address with --allow-insecure-loopback)'); }
    const named = parsed.capabilities ?? env.PRIVANODE_CAPABILITIES;
    let capabilities;
    if (named !== undefined && named !== '') {
      const result = CapabilitiesSchema.safeParse(named.split(',').map(item => item.trim()));
      if (!result.success) throw new UsageError('--capabilities must be a comma-separated list of capability names this node supports');
      capabilities = result.data;
    }
    const stateDir = resolve(parsed.stateDir ?? env.PRIVANODE_STATE_DIR ?? './var/node');
    const result = await enrollNode({ url, token: token.data, stateDir, allowInsecureLoopback: insecure, ...(capabilities ? { capabilities } : {}) });
    const lines = [result.outcome === 'ENROLLED' ? 'Enrolled.' : 'This node is already enrolled with this Coordinator; the token was not used.',
      `  Node ID:       ${result.nodeId}`, ...(result.displayName ? [`  Name:          ${result.displayName}`] : []),
      ...(result.outcome === 'ENROLLED' ? [`  Capabilities:  ${result.capabilities.length ? result.capabilities.join(', ') : '(none)'}`] : []),
      `  State:         ${stateDir}`, '',
      'Start the node with: privanet-node',
      ...(result.outcome === 'ENROLLED' && result.capabilities.length ? ['It will offer exactly the capabilities above. To offer fewer, set PRIVANODE_CAPABILITIES; the owner policy file still bounds what it does.'] : []), ''];
    io.out(lines.join('\n'));
    return EXIT_OK;
  } catch (error) {
    if (error instanceof UsageError) { io.err(`${error.message}\n`); return EXIT_USAGE; }
    const failure = error instanceof EnrollError ? error : classify(error);
    io.err(`Enrollment failed: ${failure.message}\n`);
    return EXIT_FAILED;
  }
}
