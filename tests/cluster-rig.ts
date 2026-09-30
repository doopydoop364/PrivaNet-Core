import { spawn, execFile } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppCredentialSchema, EnrollmentTokenSchema, NodesSchema } from '@privanet/protocol';
import type { NodeView } from '@privanet/protocol';
import { PrivaNetClient } from '@privanet/sdk';
import { secret } from '@privanet/shared';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));

/** One trusted (admin-enrolled) node of a cluster: its own process, state directory, identity and owner policy. */
export interface ClusterNodeSpec {
  name: string; capabilities?: string; slots?: number;
  /** Owner policy overrides; the default leaves nothing reserved so a busy CI host never pauses the node. */
  policy?: Record<string, unknown>; env?: NodeJS.ProcessEnv;
}
export interface ClusterOptions {
  nodes: ClusterNodeSpec[]; /** Coordinator settings. */ leaseMs?: number; staleMs?: number; offlineMs?: number; authPerMinute?: number; maintenanceMs?: number; env?: NodeJS.ProcessEnv;
  /** How long each node may take to enrol (default 20 s) and whether all nodes start at once instead of one after another. */ startTimeoutMs?: number; parallelStart?: boolean;
}
export interface ClusterNode {
  spec: ClusterNodeSpec; stateDir: string; process: ChildProcess | undefined; logs: string[];
  /** Number of log lines with this event since the process was first started. */
  count(event: string): number;
}
export interface Cluster {
  url: string; dir: string; adminSecret: string; coordinatorLogs: string[]; nodes: ClusterNode[]; app: { token: string; applicationId: string };
  client(): PrivaNetClient;
  nodeViews(): Promise<NodeView[]>;
  /** Kill a node process with a signal (SIGKILL is a crash: no goodbye, no lease release). */
  kill(name: string, signal?: NodeJS.Signals): Promise<void>;
  startNode(name: string): Promise<void>;
  stopCoordinator(signal?: NodeJS.Signals): Promise<void>;
  startCoordinator(): Promise<void>;
  drainNode(name: string): Promise<void>;
  stop(): Promise<void>;
}

export async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('no port');
  await new Promise<void>(resolve => server.close(() => resolve())); return address.port;
}
export const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
export async function eventually<T>(what: string, check: () => T | undefined | false | Promise<T | undefined | false>, ms = 15000, every = 25): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check(); if (value !== undefined && value !== false) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(every);
  }
}
async function stopChild(child: ChildProcess | undefined, signal: NodeJS.Signals = 'SIGTERM') {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>(resolve => {
    const deadline = setTimeout(() => child.kill('SIGKILL'), 8000);
    child.once('close', () => { clearTimeout(deadline); resolve(); }); child.kill(signal);
  });
}
const occurrences = (logs: string[], event: string) => logs.join('').split(`"event":"${event}"`).length - 1;

/**
 * Real processes: one Coordinator and N enrolled PrivaNodes on loopback, each with its own state directory,
 * as an operator would run them. Everything is driven through the admin CLI and the SDK.
 */
export async function startCluster(options: ClusterOptions): Promise<Cluster> {
  const dir = await mkdtemp(join(tmpdir(), 'privanet-cluster-')); const port = await unusedPort(); const url = `http://127.0.0.1:${port}`;
  const admin = secret(); const coordinatorLogs: string[] = [];
  const env: NodeJS.ProcessEnv = { ...process.env, PRIVANET_ADMIN_SECRET: admin, PRIVANET_COORDINATOR_URL: url, PRIVANET_HOST: '127.0.0.1', PRIVANET_PORT: String(port),
    PRIVANET_DATA_DIR: join(dir, 'coordinator'), PRIVANET_LEASE_MS: String(options.leaseMs ?? 2000), PRIVANET_STALE_MS: String(options.staleMs ?? 1500),
    PRIVANET_OFFLINE_MS: String(options.offlineMs ?? 4000), PRIVANET_MAINTENANCE_MS: String(options.maintenanceMs ?? 100),
    PRIVANET_AUTH_REQUESTS_PER_MINUTE: String(options.authPerMinute ?? 120), PRIVANET_MAX_PENDING_PER_APP: '100000',
    PRIVANODE_COORDINATOR_URL: url, PRIVANODE_ALLOW_INSECURE_LOOPBACK: 'true', ...options.env };
  let coordinator: ChildProcess | undefined;
  const spawnService = (path: string, extra: NodeJS.ProcessEnv, logs: string[], event: string, minCount: number, ms = 20000) => {
    const child = spawn(process.execPath, [path], { cwd: root, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout?.on('data', (chunk: Buffer) => logs.push(chunk.toString())); child.stderr?.on('data', (chunk: Buffer) => logs.push(chunk.toString()));
    return new Promise<ChildProcess>((resolve, reject) => {
      const startCount = occurrences(logs, event);
      const deadline = setTimeout(() => { void stopChild(child); reject(new Error(`timeout waiting for ${event}; last output: ${logs.join('').split('\\n').slice(-4).join(' | ')}`)); }, ms);
      const check = () => { if (occurrences(logs, event) - startCount >= minCount) { clearTimeout(deadline); child.stdout?.off('data', check); resolve(child); } };
      child.once('exit', () => { clearTimeout(deadline); reject(new Error(`process exited before ${event}`)); });
      child.stdout?.on('data', check);
    });
  };
  const startCoordinator = async () => { coordinator = await spawnService('apps/coordinator/dist/main.js', {}, coordinatorLogs, 'coordinator.started', 1); };
  const tool = async (args: string[], extra: NodeJS.ProcessEnv = {}) => JSON.parse((await exec(process.execPath, ['scripts/admin.mjs', ...args], { cwd: root, env: { ...env, ...extra }, timeout: 15000 })).stdout) as unknown;
  const nodes: ClusterNode[] = [];
  const cluster: Cluster = {
    url, dir, adminSecret: admin, coordinatorLogs, nodes, app: { token: '', applicationId: '' },
    client: () => new PrivaNetClient({ url, token: cluster.app.token, allowInsecureLoopback: true }),
    nodeViews: async () => NodesSchema.parse(await tool(['nodes'])).nodes,
    startCoordinator, stopCoordinator: async signal => { await stopChild(coordinator, signal); coordinator = undefined; },
    kill: async (name, signal = 'SIGKILL') => { const node = nodes.find(n => n.spec.name === name); if (!node) throw new Error(`no node ${name}`); await stopChild(node.process, signal); },
    startNode: async name => {
      const node = nodes.find(n => n.spec.name === name); if (!node) throw new Error(`no node ${name}`);
      node.process = await spawnService('apps/node/dist/main.js', nodeEnv(node.spec, node.stateDir, undefined), node.logs, 'node.authenticated', 1);
    },
    drainNode: async name => {
      const node = nodes.find(n => n.spec.name === name); if (!node?.process) throw new Error(`no running node ${name}`);
      const exited = new Promise<void>(resolve => node.process?.once('close', () => resolve()));
      await writeFile(join(node.stateDir, 'DRAIN'), ''); await exited;
    },
    stop: async () => {
      for (const node of nodes) await stopChild(node.process); await stopChild(coordinator);
      await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    },
  };
  const nodeEnv = (spec: ClusterNodeSpec, stateDir: string, enrollmentToken: string | undefined): NodeJS.ProcessEnv => ({
    PRIVANODE_STATE_DIR: stateDir, PRIVANODE_CAPABILITIES: spec.capabilities ?? 'system.echo.v1,system.hashchain.v1', PRIVANODE_POLICY_FILE: join(stateDir, '..', `${spec.name}.policy.json`),
    PRIVANODE_HEARTBEAT_MS: '250', PRIVANODE_POLL_MS: '50', PRIVANODE_JOB_SLOTS: String(spec.slots ?? 1), ...spec.env, ...(enrollmentToken ? { PRIVANODE_ENROLLMENT_TOKEN: enrollmentToken } : {}) });
  try {
    await startCoordinator();
    cluster.app = AppCredentialSchema.parse(await tool(['application', 'cluster-app'], { PRIVANET_JOB_TYPES: 'system.echo.v1,system.hashchain.v1' }));
    const launch = async (spec: ClusterNodeSpec) => {
      const stateDir = join(dir, `node-${spec.name}`); const logs: string[] = [];
      await writeFile(join(dir, `${spec.name}.policy.json`), JSON.stringify({ reserveMemoryBytes: 0, safetyMarginBytes: 0, maxMemoryBytes: 2 * 1024 ** 3, maxCpuPercent: 100, reserveCpuPercent: 0, onBattery: 'normal', ...spec.policy }));
      const grant = EnrollmentTokenSchema.parse(await tool(['enrollment'], { PRIVANET_JOB_TYPES: spec.capabilities ?? 'system.echo.v1,system.hashchain.v1', PRIVANET_ENROLLMENT_TTL_MS: '900000' }));
      const node: ClusterNode = { spec, stateDir, process: undefined, logs, count: event => occurrences(logs, event) };
      nodes.push(node);
      node.process = await spawnService('apps/node/dist/main.js', nodeEnv(spec, stateDir, grant.token), logs, 'node.enrolled', 1, options.startTimeoutMs);
    };
    if (options.parallelStart) await Promise.all(options.nodes.map(launch)); else for (const spec of options.nodes) await launch(spec);
    return cluster;
  } catch (error) {
    if (process.env.CLUSTER_DEBUG) { const codes = new Map<string, number>(); for (const m of coordinatorLogs.join('').matchAll(/"code":"([A-Z_]+)"/g)) codes.set(m[1] ?? '', (codes.get(m[1] ?? '') ?? 0) + 1); console.error('coordinator rejections', JSON.stringify([...codes]), 'nodes enrolled', nodes.filter(n => n.count('node.enrolled') > 0).length); }
    await cluster.stop(); throw error;
  }
}
