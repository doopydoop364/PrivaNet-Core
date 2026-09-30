import { spawn, execFile, execFileSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppCredentialSchema, EnrollmentTokenSchema, NodesSchema } from '@privanet/protocol';
import type { NodeView } from '@privanet/protocol';
import { secret } from '@privanet/shared';
import { eventually, sleep } from './cluster-rig.js';

const exec = promisify(execFile);
const repo = fileURLToPath(new URL('../../', import.meta.url));
export { eventually, sleep };

/** Why these tests cannot run here, or undefined when they can (root, network namespaces, iptables, Caddy). */
export function netnsUnavailable(): string | undefined {
  if (process.platform !== 'linux') return 'needs Linux network namespaces';
  if (process.getuid?.() !== 0) return 'needs root (ip netns, iptables)';
  for (const tool of ['ip', 'iptables', 'caddy']) { try { execFileSync('which', [tool], { stdio: 'ignore' }); } catch { return `needs ${tool} on PATH`; } }
  try { execFileSync('ip', ['netns', 'list'], { stdio: 'ignore' }); } catch { return 'network namespaces are not available'; }
  return undefined;
}

export interface Host {
  name: string; ns: string; ip: string;
  /** Start a long-running process inside this host's network namespace, exactly as it would run on a separate machine. */
  spawn(command: string, args: string[], env?: NodeJS.ProcessEnv, logs?: string[]): ChildProcess;
  /** Run a short command inside the namespace and return its output. */
  run(command: string, args: string[], env?: NodeJS.ProcessEnv, timeoutMs?: number): Promise<string>;
}
export interface Lan {
  dir: string; adminSecret: string; release: string; server: Host; desktop: Host; /** A third machine on the LAN that plays the public web. */ web: Host; url: string; caCert: string;
  /** Environment for a PrivaNode on the desktop: URL, CA trust, state directory. */
  nodeEnv(name: string, extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  coordinatorLogs: string[]; caddyLogs: string[];
  startCoordinator(): Promise<void>; stopCoordinator(signal?: NodeJS.Signals): Promise<void>;
  startCaddy(): Promise<void>; stopCaddy(): Promise<void>;
  /** Admin CLI on the server, talking to the Coordinator's loopback listener (the only place the admin API is reachable). */
  admin(args: string[], env?: NodeJS.ProcessEnv): Promise<unknown>;
  enrollment(capabilities: string): Promise<string>;
  nodeViews(): Promise<NodeView[]>;
  application(name: string, jobTypes: string, extra?: NodeJS.ProcessEnv): Promise<{ token: string; applicationId: string }>;
  /** A short node process on the given host that performs one HTTPS request and prints status and body. */
  httpsGet(host: Host, url: string, options?: { ca?: boolean; bearer?: string; timeoutMs?: number }): Promise<{ status: number; body: string } | { error: string }>;
  /** Run an application (the SDK) on a host and return its summary; see tests/lan-client.mjs. */
  client(host: Host, appToken: string, spec: unknown, timeoutMs?: number): Promise<{ results: unknown[]; errors: number; attempts: number[]; ms: number; p50: number | null; p95: number | null }>;
  /** A small website on the web host: pages /p/N after `delayMs`. */
  startSite(delayMs: number): Promise<void>;
  pids(): { coordinator: number | undefined; caddy: number | undefined };
  link(up: boolean): Promise<void>;
  children: ChildProcess[];
  stop(): Promise<void>;
}

const sh = (command: string, args: string[]) => execFileSync(command, args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
async function stopChild(child: ChildProcess | undefined, signal: NodeJS.Signals = 'SIGTERM') {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>(resolve => { const t = setTimeout(() => child.kill('SIGKILL'), 8000); child.once('close', () => { clearTimeout(t); resolve(); }); child.kill(signal); });
}
const occurrences = (logs: string[], event: string) => logs.join('').split(`"event":"${event}"`).length - 1;

/**
 * Two hosts on one machine that share nothing but a virtual Ethernet cable: separate network stacks, loopbacks and firewalls.
 *   server  10.77.0.1  Coordinator on its own loopback (127.0.0.1:4010), Caddy terminating TLS on 10.77.0.1:443, firewall admits only TCP 443
 *   desktop 10.77.0.2  PrivaNode(s); firewall admits nothing inbound but replies
 * The Coordinator, node, admin CLI and Caddy run exactly as shipped, from a staged release directory.
 */
export async function startLan(options: { release?: string; /** A different (older) release for the Coordinator and the admin tool. */ coordinatorRelease?: string; leaseMs?: number; staleMs?: number; offlineMs?: number; coordinatorEnv?: NodeJS.ProcessEnv } = {}): Promise<Lan> {
  const id = randomBytes(3).toString('hex'); const dir = await mkdtemp(join(tmpdir(), 'privanet-lan-'));
  const serverNs = `pns${id}`; const desktopNs = `pnd${id}`; const webNs = `pnw${id}`; const vs = `vs${id}`; const vd = `vd${id}`; const vw = `vw${id}`; const bridge = `pnb${id}`;
  const children: ChildProcess[] = []; const coordinatorLogs: string[] = []; const caddyLogs: string[] = [];
  let release = options.release ?? process.env.PRIVANET_RELEASE_DIR;
  if (!release) {
    const out = join(dir, 'release');
    release = (await exec(process.execPath, ['scripts/package-release.mjs', 'linux', out], { cwd: repo })).stdout.trim();
  }
  const rel = release; const coordinatorRel = options.coordinatorRelease ?? rel;
  const mkHost = (name: string, ns: string, ip: string): Host => ({
    name, ns, ip,
    spawn: (command, args, env, logs) => {
      const child = spawn('ip', ['netns', 'exec', ns, command, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
      if (logs) { child.stdout?.on('data', (c: Buffer) => logs.push(c.toString())); child.stderr?.on('data', (c: Buffer) => logs.push(c.toString())); }
      children.push(child); return child;
    },
    run: async (command, args, env, timeoutMs = 20000) => (await exec('ip', ['netns', 'exec', ns, command, ...args], { env: { ...process.env, ...env }, maxBuffer: 256 * 1024 * 1024, timeout: timeoutMs })).stdout,
  });
  const server = mkHost('server', serverNs, '10.77.0.1'); const desktop = mkHost('desktop', desktopNs, '10.77.0.2'); const web = mkHost('web', webNs, '10.77.0.3');
  const teardown = async () => {
    for (const child of children) await stopChild(child);
    for (const ns of [serverNs, desktopNs, webNs]) { try { sh('ip', ['netns', 'del', ns]); } catch { /* already gone */ } }
    try { sh('ip', ['link', 'del', bridge]); } catch { /* already gone */ }
    await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  };
  try {
    for (const ns of [serverNs, desktopNs, webNs]) sh('ip', ['netns', 'add', ns]);
    // One Ethernet segment, like a home LAN: every host's virtual cable plugs into a bridge.
    sh('ip', ['link', 'add', bridge, 'type', 'bridge']); sh('ip', ['link', 'set', bridge, 'up']);
    for (const [link, ns, ip] of [[vs, serverNs, server.ip], [vd, desktopNs, desktop.ip], [vw, webNs, web.ip]] as const) {
      const peer = `p${link}`;
      sh('ip', ['link', 'add', link, 'type', 'veth', 'peer', 'name', peer]);
      sh('ip', ['link', 'set', peer, 'master', bridge]); sh('ip', ['link', 'set', peer, 'up']);
      sh('ip', ['link', 'set', link, 'netns', ns]);
      for (const args of [['addr', 'add', `${ip}/24`, 'dev', link], ['link', 'set', link, 'up'], ['link', 'set', 'lo', 'up']]) sh('ip', ['netns', 'exec', ns, 'ip', ...args]);
    }
    const ipt = (ns: string, ...args: string[]) => sh('ip', ['netns', 'exec', ns, 'iptables', ...args]);
    // Server: a host firewall that admits loopback, replies and TCP 443 from the LAN, nothing else (the Coordinator's own port is not reachable from the LAN).
    for (const rule of [['-A', 'INPUT', '-i', 'lo', '-j', 'ACCEPT'], ['-A', 'INPUT', '-m', 'conntrack', '--ctstate', 'ESTABLISHED,RELATED', '-j', 'ACCEPT'],
      ['-A', 'INPUT', '-p', 'tcp', '--dport', '443', '-s', '10.77.0.0/24', '-j', 'ACCEPT'], ['-P', 'INPUT', 'DROP']]) ipt(serverNs, ...rule);
    // Desktop: nothing inbound at all except replies to connections it started.
    for (const rule of [['-A', 'INPUT', '-i', 'lo', '-j', 'ACCEPT'], ['-A', 'INPUT', '-m', 'conntrack', '--ctstate', 'ESTABLISHED,RELATED', '-j', 'ACCEPT'], ['-P', 'INPUT', 'DROP']]) ipt(desktopNs, ...rule);

    const adminSecret = secret(); const dataDir = join(dir, 'coordinator'); const caddyHome = join(dir, 'caddy');
    await mkdir(caddyHome, { recursive: true });
    const caCert = join(caddyHome, 'data', 'caddy', 'pki', 'authorities', 'local', 'root.crt');
    const caddyfile = join(dir, 'Caddyfile');
    await writeFile(caddyfile, (await readFile(join(repo, 'deploy', 'caddy', 'Caddyfile'), 'utf8')).replaceAll('10.0.0.68', server.ip));
    const url = `https://${server.ip}`;
    const coordEnv: NodeJS.ProcessEnv = { PRIVANET_ADMIN_SECRET: adminSecret, PRIVANET_HOST: '127.0.0.1', PRIVANET_PORT: '4010', PRIVANET_DATA_DIR: dataDir,
      PRIVANET_LEASE_MS: String(options.leaseMs ?? 3000), PRIVANET_STALE_MS: String(options.staleMs ?? 2000), PRIVANET_OFFLINE_MS: String(options.offlineMs ?? 6000),
      PRIVANET_MAINTENANCE_MS: '100', PRIVANET_MAX_PENDING_PER_APP: '100000', ...options.coordinatorEnv };
    let coordinator: ChildProcess | undefined; let caddy: ChildProcess | undefined;
    const waitFor = (logs: string[], event: string, before: number, ms = 20000) => eventually(event, () => occurrences(logs, event) > before || undefined, ms, 50);
    const lan: Lan = {
      dir, adminSecret, release: rel, server, desktop, web, url, caCert, coordinatorLogs, caddyLogs, children,
      nodeEnv: (name, extra) => ({ PRIVANODE_COORDINATOR_URL: url, NODE_EXTRA_CA_CERTS: caCert, PRIVANODE_STATE_DIR: join(dir, `node-${name}`),
        PRIVANODE_HEARTBEAT_MS: '500', PRIVANODE_POLL_MS: '100', ...extra }),
      startCoordinator: async () => {
        const before = occurrences(coordinatorLogs, 'coordinator.started');
        coordinator = server.spawn(join(coordinatorRel, 'bin', 'privanet-coordinator'), [], coordEnv, coordinatorLogs); await waitFor(coordinatorLogs, 'coordinator.started', before);
      },
      stopCoordinator: async signal => { await stopChild(coordinator, signal); coordinator = undefined; },
      startCaddy: async () => {
        caddy = server.spawn('caddy', ['run', '--config', caddyfile, '--adapter', 'caddyfile'], { HOME: caddyHome, XDG_DATA_HOME: join(caddyHome, 'data'), XDG_CONFIG_HOME: join(caddyHome, 'config') }, caddyLogs);
        await eventually('Caddy to serve TLS', async () => { if (!existsSync(caCert)) return undefined; const r = await lan.httpsGet(desktop, `${url}/v1/health`, { timeoutMs: 3000 }); return 'status' in r ? true : undefined; }, 30000, 250);
      },
      stopCaddy: async () => { await stopChild(caddy); caddy = undefined; },
      admin: async (args, env) => JSON.parse((await server.run(process.execPath, [join(coordinatorRel, 'tools', 'admin.mjs'), ...args],
        { PRIVANET_ADMIN_SECRET: adminSecret, PRIVANET_COORDINATOR_URL: 'http://127.0.0.1:4010', PRIVANODE_ALLOW_INSECURE_LOOPBACK: 'true', ...env })) as string) as unknown,
      enrollment: async capabilities => EnrollmentTokenSchema.parse(await lan.admin(['enrollment'], { PRIVANET_JOB_TYPES: capabilities, PRIVANET_ENROLLMENT_TTL_MS: '900000' })).token,
      nodeViews: async () => NodesSchema.parse(await lan.admin(['nodes'])).nodes,
      application: async (name, jobTypes, extra) => AppCredentialSchema.parse(await lan.admin(['application', name], { PRIVANET_JOB_TYPES: jobTypes, ...extra })),
      httpsGet: async (host, target, opts = {}) => {
        const script = `const r = await fetch(process.argv[1], { headers: { 'X-PrivaNet-Protocol': '1', ...(process.argv[2] ? { Authorization: 'Bearer ' + process.argv[2] } : {}) }, signal: AbortSignal.timeout(${opts.timeoutMs ?? 5000}) }).catch(e => ({ e })); ` +
          `if (r.e) { console.log(JSON.stringify({ error: String(r.e.cause?.code ?? r.e.name) })); } else { console.log(JSON.stringify({ status: r.status, body: (await r.text()).slice(0, 300) })); }`;
        try { return JSON.parse(await host.run(process.execPath, ['--input-type=module', '-e', script, target, opts.bearer ?? ''], opts.ca === false ? {} : { NODE_EXTRA_CA_CERTS: caCert }, (opts.timeoutMs ?? 5000) + 5000)) as { status: number; body: string } | { error: string }; }
        catch { return { error: 'PROCESS' }; }
      },
      client: async (host, appToken, spec, timeoutMs = 180000) => { const file = join(dir, `spec-${randomBytes(4).toString('hex')}.json`); await writeFile(file, JSON.stringify(spec)); return JSON.parse(await host.run(process.execPath, [join(repo, 'tests', 'lan-client.mjs'), `@${file}`],
        { PRIVANET_RELEASE_DIR: rel, PRIVANET_COORDINATOR_URL: url, PRIVANET_APP_TOKEN: appToken, NODE_EXTRA_CA_CERTS: caCert }, timeoutMs)) as { results: unknown[]; errors: number; attempts: number[]; ms: number; p50: number | null; p95: number | null }; },
      startSite: async delayMs => {
        const logs: string[] = []; web.spawn(process.execPath, [join(repo, 'tests', 'lan-site.mjs')], { SITE_DELAY_MS: String(delayMs) }, logs);
        await eventually('the site to start', () => logs.join('').includes('site.started') || undefined);
      },
      pids: () => ({ coordinator: coordinator?.pid, caddy: caddy?.pid }),
      link: async up => { sh('ip', ['netns', 'exec', desktopNs, 'ip', 'link', 'set', vd, up ? 'up' : 'down']); if (up) sh('ip', ['netns', 'exec', desktopNs, 'ip', 'addr', 'replace', `${desktop.ip}/24`, 'dev', vd]); },
      stop: teardown,
    };
    await lan.startCoordinator(); await lan.startCaddy();
    return lan;
  } catch (error) { await teardown(); throw error; }
}
