import { execFile } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { lstat } from 'node:fs/promises';
import { connect as tcpConnect, isIP } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { resolve } from 'node:path';
import { ZodError } from 'zod';
import { ChallengeSchema, HealthSchema, PROTOCOL_VERSION } from '@privanet/protocol';
import { ApiError, Transport } from '@privanet/shared';
import { loadConfig } from './config.js';
import { connectionFailure } from './failure.js';
import { readEnrollmentRecordSync } from './enrollment-record.js';
import { inspectBinding, inspectIdentity } from './identity.js';

export type StageStatus = 'OK' | 'FAILED' | 'WARN' | 'INFO' | 'SKIPPED';
export interface Stage { id: string; label: string; status: StageStatus; detail: string; advice?: string }
export interface DoctorReport { ok: boolean; coordinator: string | null; stages: Stage[] }
export interface DoctorOptions {
  /** `--coordinator`; otherwise the environment, then `enrollment.json`. */
  url?: string; stateDir: string; allowInsecureLoopback: boolean; timeoutMs: number; env: NodeJS.ProcessEnv;
  /** Test seams: how names are resolved and how a TCP connection is attempted. The defaults are the real network. */
  resolveHost?: (host: string) => Promise<string[]>; tcp?: (host: string, port: number, timeoutMs: number) => Promise<void>;
}
const TLS_ADVICE: Record<string, string> = {
  CERT_HAS_EXPIRED: 'The Coordinator\'s certificate has expired. The owner must renew it (a public deployment renews automatically through Caddy; check that it can reach the certificate authority).',
  CERT_NOT_YET_VALID: 'The certificate is not valid yet. Check this machine\'s clock first, then the Coordinator\'s.',
  ERR_TLS_CERT_ALTNAME_INVALID: 'The certificate is not for this name. Use the exact host name the certificate was issued for (not an IP address, unless the certificate lists it).',
  HOSTNAME_MISMATCH: 'The certificate is not for this name. Use the exact host name the certificate was issued for.',
};
const UNTRUSTED = new Set(['DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'CERT_UNTRUSTED']);
const stage = (id: string, label: string, status: StageStatus, detail: string, advice?: string): Stage => ({ id, label, status, detail, ...(advice ? { advice } : {}) });

const realResolve = async (host: string): Promise<string[]> => (await lookup(host, { all: true })).map(entry => entry.address);
const realTcp = (host: string, port: number, timeoutMs: number): Promise<void> => new Promise((done, fail) => {
  const socket = tcpConnect({ host, port, timeout: timeoutMs });
  socket.once('connect', () => { socket.destroy(); done(); });
  socket.once('timeout', () => { socket.destroy(); fail(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })); });
  socket.once('error', error => { socket.destroy(); fail(error); });
});
/**
 * A TLS handshake that only LOOKS: it asks the platform to verify the certificate and reports the verdict, then closes without sending a single byte of application data.
 * Whatever it finds, the requests that follow are made by the ordinary verifying client and are skipped if the certificate is not accepted: nothing here lets the diagnosis carry on over an unverified channel.
 */
function probeTls(host: string, port: number, timeoutMs: number): Promise<{ authorized: boolean; reason?: string; subject?: string; issuer?: string; validTo?: string; names?: string; protocol?: string; timedOut?: boolean; failure?: string }> {
  return new Promise(done => {
    let settled = false; const finish = (value: Parameters<typeof done>[0]) => { if (!settled) { settled = true; done(value); } };
    const socket = tlsConnect({ host, port, servername: isIP(host) ? '' : host, rejectUnauthorized: false, timeout: timeoutMs }, () => {
      const cert = socket.getPeerCertificate();
      finish({ authorized: socket.authorized, ...(socket.authorizationError ? { reason: String(socket.authorizationError) } : {}), ...(cert.subject?.CN ? { subject: String(cert.subject.CN) } : {}),
        ...(cert.issuer?.CN || cert.issuer?.O ? { issuer: String(cert.issuer.CN ?? cert.issuer.O) } : {}), ...(cert.valid_to ? { validTo: cert.valid_to } : {}), ...(cert.subjectaltname ? { names: cert.subjectaltname } : {}),
        ...(socket.getProtocol() ? { protocol: socket.getProtocol() as string } : {}) });
      socket.end(); socket.destroy();
    });
    socket.once('timeout', () => { finish({ authorized: false, timedOut: true }); socket.destroy(); });
    socket.once('error', error => { const code = (error as NodeJS.ErrnoException).code; finish({ authorized: false, failure: code ?? 'ERROR' }); socket.destroy(); });
  });
}
const run = (command: string, args: string[], timeoutMs: number): Promise<{ code: number | null; out: string } | undefined> => new Promise(done => {
  try { execFile(command, args, { timeout: timeoutMs, windowsHide: true }, (error, stdout) => done(error && (error as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : { code: error ? Number((error as { code?: number }).code ?? 1) : 0, out: String(stdout).trim() })); }
  catch { done(undefined); }
});
const modeText = (mode: number) => (mode & 0o777).toString(8).padStart(3, '0');

/**
 * Diagnoses a node's connection to its Coordinator one stage at a time, so the first thing that is wrong is named plainly and what depends on it is skipped, not guessed at.
 * It prints no secret (nothing it handles is one: no token, no code, no key), never creates or changes anything on disk, and its only requests to the Coordinator are the health check,
 * three requests that the Coordinator rejects as malformed (a protocol version and nothing else) before looking at them (proof that the endpoints answer, not an attempt to use them), and, when this machine has an identity,
 * the ordinary short-lived sign-in challenge to learn whether the Coordinator knows it. Enrollment state is never touched.
 */
export async function diagnose(options: DoctorOptions): Promise<DoctorReport> {
  const stages: Stage[] = []; const add = (item: Stage) => { stages.push(item); return item; };
  const resolveHost = options.resolveHost ?? realResolve; const tcp = options.tcp ?? realTcp; const stateDir = resolve(options.stateDir);

  // 1. Configuration: the same validation the node applies at start (so a setting it would reject is found here), plus where the address came from.
  let record: ReturnType<typeof readEnrollmentRecordSync>; let recordProblem: string | undefined;
  try { record = readEnrollmentRecordSync(stateDir); } catch { recordProblem = 'enrollment.json is unreadable, unsafe or malformed'; }
  const fromEnv = options.env.PRIVANODE_COORDINATOR_URL; const url = options.url ?? fromEnv ?? record?.coordinatorUrl;
  const source = options.url ? 'from --coordinator' : fromEnv ? 'from PRIVANODE_COORDINATOR_URL' : record ? 'from enrollment.json' : '';
  if (recordProblem) add(stage('config', 'Configuration', 'FAILED', recordProblem, 'Do not edit it by hand. If this node should be enrolled, restore the file from a backup; otherwise enroll again with a fresh state directory.'));
  else if (!url) add(stage('config', 'Configuration', 'FAILED', 'No Coordinator address given', 'Pass --coordinator https://HOST, set PRIVANODE_COORDINATOR_URL, or enroll this node first (privanet-node enroll or join).'));
  else {
    try {
      loadConfig({ ...options.env, PRIVANODE_STATE_DIR: stateDir, PRIVANODE_COORDINATOR_URL: url, PRIVANODE_ALLOW_INSECURE_LOOPBACK: options.allowInsecureLoopback ? 'true' : (options.env.PRIVANODE_ALLOW_INSECURE_LOOPBACK ?? 'false') });
      add(stage('config', 'Configuration', 'OK', `valid (address ${source})`));
    } catch (error) {
      const names = error instanceof ZodError ? [...new Set(error.issues.map(issue => String(issue.path[0] ?? '')))].join(', ') : 'a configuration file';
      add(stage('config', 'Configuration', 'FAILED', `the node would refuse to start: check ${names}`, 'Fix the setting named (values are not shown here, because one of them might be a secret).'));
    }
  }

  // 2. Address.
  let transport: Transport | undefined; let host = ''; let port = 443; let origin: string | null = null;
  if (url) {
    try {
      transport = new Transport({ url, allowInsecureLoopback: options.allowInsecureLoopback || options.env.PRIVANODE_ALLOW_INSECURE_LOOPBACK === 'true' });
      const parsed = new URL(transport.origin); host = parsed.hostname.replace(/^\[|\]$/g, ''); port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80)); origin = transport.origin;
      add(stage('url', 'Address', 'OK', `${transport.origin.startsWith('https:') ? 'https' : 'http (loopback only)'}://${host}:${port}`));
    } catch {
      add(stage('url', 'Address', 'FAILED', 'not an acceptable Coordinator address', 'Use https://host[:port] with no path or credentials. Plain http is accepted only for a literal loopback address, and only with --allow-insecure-loopback.'));
    }
  } else add(stage('url', 'Address', 'SKIPPED', 'no address'));

  // 3. DNS.
  let addresses: string[] = [];
  if (!transport) add(stage('dns', 'DNS', 'SKIPPED', 'no usable address'));
  else if (isIP(host)) { addresses = [host]; add(stage('dns', 'DNS', 'INFO', `${host} is an address, nothing to resolve`)); }
  else {
    try { addresses = await resolveHost(host); add(stage('dns', 'DNS', addresses.length ? 'OK' : 'FAILED', addresses.length ? `${host} -> ${addresses.slice(0, 3).join(', ')}` : `${host} has no address`)); }
    catch { add(stage('dns', 'DNS', 'FAILED', `${host} does not resolve`, 'Check the spelling of the name and this machine\'s DNS settings. For a new deployment, the owner\'s DNS record may not exist yet or may not have propagated.')); }
  }
  const dnsOk = addresses.length > 0;

  // 4. TCP.
  let tcpOk = false;
  if (!dnsOk) add(stage('tcp', `TCP ${port}`, 'SKIPPED', 'no address to connect to'));
  else {
    try { await tcp(addresses[0] ?? host, port, options.timeoutMs); tcpOk = true; add(stage('tcp', `TCP ${port}`, 'OK', `connected to ${addresses[0]}:${port}`)); }
    catch (error) {
      const failure = connectionFailure(Object.assign(new Error('x'), { cause: error }));
      const advice: Record<string, string> = { CONNECTION_REFUSED: 'Nothing is listening there. Check the port and that the Coordinator\'s reverse proxy is running.', TIMEOUT: 'No answer. A firewall, a router that does not forward the port, or a wrong address is the usual cause: the owner must open TCP ' + port + ' to the server.',
        UNREACHABLE: 'This machine has no route to that address. Check your own network connection.' };
      add(stage('tcp', `TCP ${port}`, 'FAILED', `${failure.reason ?? 'could not connect'}`.toLowerCase().replaceAll('_', ' '), advice[failure.reason ?? ''] ?? 'Check the address, your network and any firewall.'));
    }
  }

  // 5. TLS: handshake, certificate trust, certificate name. Required for everything that follows; there is no way past it except a certificate the platform accepts.
  let tlsOk = false; const https = transport?.origin.startsWith('https:') === true;
  if (!transport || !tcpOk) add(stage('tls', 'TLS', 'SKIPPED', 'no connection'));
  else if (!https) add(stage('tls', 'TLS', 'INFO', 'plain http to a loopback address (development only); no certificate to check'));
  else {
    // Connecting by name, exactly as the real client does, so the certificate is checked against the name the owner published.
    const result = await probeTls(host, port, options.timeoutMs);
    if (result.timedOut) add(stage('tls', 'TLS', 'FAILED', 'the handshake timed out', 'The port answers but not with TLS in time. Something other than the Coordinator\'s proxy may be listening, or a firewall is interfering.'));
    else if (result.failure) add(stage('tls', 'TLS', 'FAILED', `handshake failed (${result.failure.toLowerCase()})`, 'The server did not speak TLS here. Check that you are using https and the right port.'));
    else if (result.authorized) {
      tlsOk = true;
      add(stage('tls', 'TLS', 'OK', `certificate verified${result.issuer ? ` (issuer ${result.issuer})` : ''}${result.validTo ? `, valid until ${result.validTo}` : ''}${options.env.NODE_EXTRA_CA_CERTS ? '; an extra CA file is trusted on this machine (NODE_EXTRA_CA_CERTS)' : ''}`));
    } else {
      const reason = result.reason ?? 'UNKNOWN';
      const detail = TLS_ADVICE[reason] ? (reason.includes('ALTNAME') || reason === 'HOSTNAME_MISMATCH' ? `certificate is for ${result.subject ?? 'another name'}, not ${host}` : reason === 'CERT_HAS_EXPIRED' ? `certificate expired${result.validTo ? ` (${result.validTo})` : ''}` : 'certificate not valid yet')
        : UNTRUSTED.has(reason) ? `certificate is not trusted${result.issuer ? ` (issuer ${result.issuer})` : ''}` : `certificate rejected (${reason.toLowerCase()})`;
      add(stage('tls', 'TLS', 'FAILED', detail, TLS_ADVICE[reason] ?? (UNTRUSTED.has(reason)
        ? 'If this is a private LAN deployment, install the network\'s CA certificate on this machine (for example NODE_EXTRA_CA_CERTS=/path/to/root.crt). If it should be a public deployment, the owner must check the certificate chain: a public certificate is trusted without any extra file.'
        : 'The certificate was rejected by this machine. The owner should check it; nothing here continues over an unverified connection.')));
    }
  }

  // 6-8. The Coordinator itself, through the ordinary verifying client.
  let healthOk = false;
  if (!transport || !tlsOk && https || !tcpOk) { for (const [id, label] of [['health', 'Coordinator'], ['protocol', 'Protocol'], ['endpoints', 'Enrollment']] as const) add(stage(id, label, 'SKIPPED', 'no verified connection')); }
  else {
    let protocolVersion: unknown;
    try {
      const health = await transport.request('GET', '/v1/health', HealthSchema); healthOk = true; protocolVersion = health.protocolVersion;
      add(stage('health', 'Coordinator', 'OK', `healthy, software ${health.serviceVersion}`));
    } catch (error) {
      if (error instanceof ZodError) { protocolVersion = (error.issues.some(issue => issue.path.includes('protocolVersion')) ? 'other' : undefined); add(stage('health', 'Coordinator', 'FAILED', 'answered, but not as a PrivaNet Coordinator of this protocol')); }
      else if (error instanceof ApiError) { protocolVersion = error.status === 426 ? 'other' : undefined; add(stage('health', 'Coordinator', 'FAILED', `refused the health check (${error.code})`, error.status === 404 ? 'This address is not a PrivaNet Coordinator (or the proxy does not forward /v1/health).' : 'Check the Coordinator and its proxy.')); }
      else add(stage('health', 'Coordinator', 'FAILED', `could not complete a request (${(connectionFailure(error).reason ?? 'error').toLowerCase().replaceAll('_', ' ')})`, 'Run the doctor again; if it persists, ask the owner to check the Coordinator.'));
    }
    if (healthOk) add(stage('protocol', 'Protocol', protocolVersion === PROTOCOL_VERSION ? 'OK' : 'FAILED', `Coordinator speaks protocol ${String(protocolVersion)}, this node speaks ${PROTOCOL_VERSION}`, protocolVersion === PROTOCOL_VERSION ? undefined : 'Update whichever side is older.'));
    else add(stage('protocol', 'Protocol', protocolVersion === 'other' ? 'FAILED' : 'SKIPPED', protocolVersion === 'other' ? `the Coordinator speaks a protocol other than ${PROTOCOL_VERSION}` : 'no health answer', protocolVersion === 'other' ? 'This node and the Coordinator speak different protocol versions. Update whichever side is older.' : undefined));
    // The endpoints a joining node uses: probed with a body the Coordinator rejects as malformed before looking at anything (400), which proves they answer without using them.
    if (healthOk) {
      const present: string[] = []; const absent: string[] = [];
      for (const [name, path] of [['token', '/v1/enrollment/challenge'], ['invite', '/v1/invites/challenge'], ['join', '/v1/join/request']] as const) {
        try { await transport.request('POST', path, HealthSchema, { protocolVersion: PROTOCOL_VERSION }); present.push(name); } // valid version, nothing else: rejected as malformed (400) before it is looked at
        catch (error) { if (error instanceof ApiError && error.status === 400) present.push(name); else if (error instanceof ApiError && (error.status === 404 || error.status === 403)) absent.push(name); else absent.push(`${name}?`); }
      }
      add(stage('endpoints', 'Enrollment', present.length === 3 ? 'OK' : present.length ? 'WARN' : 'FAILED', `available: ${present.join(', ') || 'none'}${absent.length ? `; not available: ${absent.join(', ')}` : ''}`,
        absent.length ? 'An older Coordinator has no invite or join endpoints, or the reverse proxy does not forward them. Enrollment tokens work on every version; ask the owner which to use.' : undefined));
    } else add(stage('endpoints', 'Enrollment', 'SKIPPED', 'no healthy Coordinator'));
  }

  // 9-11. This machine.
  let identityId: string | undefined;
  try {
    const dir = await lstat(stateDir).catch(() => undefined);
    if (!dir) add(stage('state', 'State directory', 'INFO', `${stateDir} does not exist yet (created by enroll or join)`));
    else if (!dir.isDirectory() || dir.isSymbolicLink()) add(stage('state', 'State directory', 'FAILED', `${stateDir} is not a plain directory`, 'The node refuses a state directory that is a link or a file. Remove it or choose another with --state-dir.'));
    else if (process.platform !== 'win32' && ((dir.mode & 0o077) !== 0 || dir.uid !== process.getuid?.())) add(stage('state', 'State directory', 'FAILED', `${stateDir} is mode ${modeText(dir.mode)}${dir.uid !== process.getuid?.() ? ' and owned by another user' : ''}`, `It must be private and owned by the user running the node: chmod 700 ${stateDir} (as the owner of the files), and run this command as that user.`));
    else add(stage('state', 'State directory', 'OK', `${stateDir}${process.platform === 'win32' ? '' : ` (mode ${modeText(dir.mode)})`}`));
  } catch { add(stage('state', 'State directory', 'FAILED', 'could not be inspected')); }
  try {
    const identity = await inspectIdentity(stateDir); identityId = identity?.nodeId;
    add(identity ? stage('identity', 'Local identity', 'OK', `${identity.nodeId}`) : stage('identity', 'Local identity', 'INFO', 'none yet (made when this node enrolls)'));
  } catch { add(stage('identity', 'Local identity', 'FAILED', 'identity.json is unsafe, unreadable or not a valid key pair', 'The node will not start with it. Its files must be private (mode 600) and untouched. If it is damaged, this node must be enrolled again with a fresh state directory (the owner revokes the old one); never copy an identity from another machine.')); }
  try {
    const binding = await inspectBinding(stateDir);
    const problems: string[] = [];
    if (record && identityId && record.nodeId !== identityId) problems.push('enrollment.json belongs to a different identity than identity.json');
    if (record && binding && (record.coordinatorId !== binding.coordinatorId || record.coordinatorUrl !== binding.url)) problems.push('enrollment.json and node-state.json name different Coordinators');
    if (record && !identityId) problems.push('enrollment.json exists but identity.json does not');
    if (problems.length) add(stage('enrollment', 'Enrollment state', 'FAILED', problems.join('; '), 'The saved state is inconsistent; enrolling again from a fresh state directory is the clean fix (the owner revokes the old node).'));
    else if (origin && binding && binding.url !== origin) add(stage('enrollment', 'Enrollment state', 'WARN', 'this state directory is bound to a different Coordinator than the one you gave', 'The node would refuse to use this address. Use the bound address or a new state directory.'));
    else if (record) add(stage('enrollment', 'Enrollment state', 'OK', `enrolled as ${record.nodeId.slice(0, 13)}… with ${record.capabilities.join(', ') || 'no capabilities'}`));
    else add(stage('enrollment', 'Enrollment state', 'INFO', identityId ? 'no enrollment record (enrolled through the older environment-token flow, or not yet)' : 'not enrolled'));
  } catch { add(stage('enrollment', 'Enrollment state', 'FAILED', 'node-state.json or enrollment.json is unsafe or malformed')); }
  // Does the Coordinator know this identity? Only the ordinary sign-in challenge (short-lived, creates nothing that outlasts a minute): never an enrollment request.
  if (healthOk && transport && identityId) {
    try { await transport.request('POST', '/v1/auth/challenge', ChallengeSchema, { nodeId: identityId, protocolVersion: PROTOCOL_VERSION }); add(stage('registered', 'At the Coordinator', 'OK', 'this node is known and may sign in')); }
    catch (error) { add(error instanceof ApiError && error.status === 401 ? stage('registered', 'At the Coordinator', 'WARN', 'this identity is not known to the Coordinator, or was revoked', 'If you have not enrolled yet, run privanet-node enroll or join. If you were enrolled, the owner may have revoked this node: ask them, and enroll again with a fresh state directory.') : stage('registered', 'At the Coordinator', 'WARN', 'could not ask')); }
  }

  // 12. The service, where it can be asked.
  if (process.platform === 'linux') {
    const answer = await run('systemctl', ['is-active', 'privanet-node'], 3000);
    if (!answer || answer.out === '') add(stage('service', 'Service', 'INFO', 'systemd is not available here'));
    else if (answer.out === 'active') add(stage('service', 'Service', 'OK', 'privanet-node is active'));
    else {
      const installed = await run('systemctl', ['list-unit-files', 'privanet-node.service', '--no-legend'], 3000);
      add(installed?.out.includes('privanet-node.service') ? stage('service', 'Service', 'WARN', `privanet-node is ${answer.out}`, 'See: journalctl -u privanet-node -n 50') : stage('service', 'Service', 'INFO', 'privanet-node is not installed as a systemd service here'));
    }
  } else if (process.platform === 'win32') {
    const answer = await run('schtasks', ['/Query', '/TN', 'PrivaNetNode', '/FO', 'LIST'], 5000);
    add(!answer || answer.code !== 0 ? stage('service', 'Service', 'INFO', 'the PrivaNetNode scheduled task is not installed here') : stage('service', 'Service', 'OK', `PrivaNetNode task present${/Status:\s*(\w+)/.exec(answer.out) ? ` (${/Status:\s*(\w+)/.exec(answer.out)?.[1]})` : ''}`));
  } else add(stage('service', 'Service', 'INFO', 'service checks are available on Linux and Windows'));

  return { ok: !stages.some(item => item.status === 'FAILED'), coordinator: origin, stages };
}

const GLYPH: Record<StageStatus, string> = { OK: 'OK', FAILED: 'FAILED', WARN: 'WARN', INFO: 'info', SKIPPED: 'skipped' };
export function formatReport(report: DoctorReport): string {
  const width = Math.max(...report.stages.map(item => item.label.length)) + 2; const lines = [`PrivaNet node doctor${report.coordinator ? `: ${report.coordinator}` : ''}`, ''];
  for (const item of report.stages) {
    lines.push(`  ${item.label.padEnd(width)}${GLYPH[item.status].padEnd(9)}${item.detail}`);
    if (item.advice && (item.status === 'FAILED' || item.status === 'WARN')) lines.push(`  ${' '.repeat(width + 9)}${item.advice}`);
  }
  lines.push('', report.ok ? 'No problems found.' : 'Problems found: fix the first FAILED line above and run the doctor again; later lines may depend on it.', '');
  return lines.join('\n');
}

const USAGE = `Usage: privanet-node doctor [--coordinator https://HOST[:PORT]] [--state-dir DIR] [--json] [--timeout SECONDS] [--allow-insecure-loopback]

Checks, stage by stage, whether this machine can reach and trust the Coordinator and whether its local state is sound. It prints no secret, changes nothing,
and never continues past a certificate this machine does not accept. Exit status: 0 no problem found, 1 a problem found, 78 bad usage.
`;
/** Runs `privanet-node doctor`. */
export async function runDoctor(argv: string[], env: NodeJS.ProcessEnv, io: { out: (text: string) => void; err: (text: string) => void }): Promise<number> {
  let url: string | undefined; let stateDir: string | undefined; let json = false; let timeout = 8; let insecure = false;
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i] ?? ''; let inline: string | undefined; const equals = arg.startsWith('--') ? arg.indexOf('=') : -1;
    if (equals > 0) { inline = arg.slice(equals + 1); arg = arg.slice(0, equals); }
    const value = () => { const next = inline ?? argv[++i]; if (next === undefined || next.startsWith('--')) throw new Error(`${arg} needs a value`); return next; };
    try {
      if (arg === '--coordinator') url = value(); else if (arg === '--state-dir') stateDir = value(); else if (arg === '--json') json = true; else if (arg === '--allow-insecure-loopback') insecure = true;
      else if (arg === '--timeout') timeout = Number(value()); else if (arg === '--help' || arg === '-h') { io.out(USAGE); return 0; } else throw new Error(`unknown option ${arg.startsWith('--') ? arg : 'argument'}`);
    } catch (error) { io.err(`${(error as Error).message}\n\n${USAGE}`); return 78; }
  }
  if (!Number.isFinite(timeout) || timeout < 1 || timeout > 120) { io.err(`--timeout is a number of seconds between 1 and 120\n\n${USAGE}`); return 78; }
  const report = await diagnose({ ...(url ? { url } : {}), stateDir: stateDir ?? env.PRIVANODE_STATE_DIR ?? './var/node', allowInsecureLoopback: insecure || env.PRIVANODE_ALLOW_INSECURE_LOOPBACK === 'true', timeoutMs: timeout * 1000, env });
  io.out(json ? JSON.stringify(report) + '\n' : formatReport(report));
  return report.ok ? 0 : 1;
}
