import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import type { Lan } from './netns-rig.js';
import { eventually, netnsUnavailable, sleep, startLan } from './netns-rig.js';

// Separate-host deployment validation (docs/FIRST_DEPLOYMENT.md, docs/DEPLOYMENT_VALIDATION.md): the server and the desktop are two network
// namespaces joined by a virtual cable, each with its own loopback and firewall. The Coordinator, Caddy (real TLS termination with its own CA),
// the PrivaNode and the admin CLI run exactly as shipped, from a staged release directory. Run with `sudo -E npm run test:lan` (Linux, root).
const skip = netnsUnavailable();
const chain = (seed: string, iterations: number) => { let hash = createHash('sha256').update(seed).digest(); for (let i = 0; i < iterations; i++) hash = createHash('sha256').update(hash).digest(); return hash.toString('hex'); };
const serverPolicy = { reserveMemoryBytes: 0, safetyMarginBytes: 0, maxMemoryBytes: 2 * 1024 ** 3, maxCpuPercent: 100, reserveCpuPercent: 0, onBattery: 'normal' };

async function withLan(t: test.TestContext, options: Parameters<typeof startLan>[0] = {}): Promise<Lan> {
  const lan = await startLan(options); t.after(() => lan.stop()); return lan;
}
async function startNode(lan: Lan, name: string, options: { capabilities?: string; policy?: object; enroll?: boolean; slots?: number; env?: NodeJS.ProcessEnv; host?: 'desktop' | 'server' } = {}) {
  const host = options.host === 'server' ? lan.server : lan.desktop; const logs: string[] = [];
  const stateDir = join(lan.dir, `node-${name}`); await mkdir(lan.dir, { recursive: true });
  await writeFile(join(lan.dir, `${name}.policy.json`), JSON.stringify(options.policy ?? serverPolicy));
  const capabilities = options.capabilities ?? 'system.echo.v1,system.hashchain.v1';
  const token = options.enroll === false ? undefined : await lan.enrollment(capabilities);
  const env = lan.nodeEnv(name, { PRIVANODE_CAPABILITIES: capabilities, PRIVANODE_POLICY_FILE: join(lan.dir, `${name}.policy.json`), PRIVANODE_JOB_SLOTS: String(options.slots ?? 1),
    ...(token ? { PRIVANODE_ENROLLMENT_TOKEN: token } : {}), ...(options.host === 'server' ? { PRIVANODE_COORDINATOR_URL: lan.url } : {}), ...options.env });
  const child = host.spawn(join(lan.release, 'bin', 'privanet-node'), [], env, logs);
  return { child, logs, stateDir, env, host, count: (event: string) => logs.join('').split(`"event":"${event}"`).length - 1 };
}
const nodeIdOf = async (stateDir: string) => (JSON.parse(await readFile(join(stateDir, 'identity.json'), 'utf8')) as { nodeId: string }).nodeId;
const online = async (lan: Lan, nodeId: string) => (await lan.nodeViews()).find(n => n.nodeId === nodeId)?.status === 'ONLINE' || undefined;
const stopChild = (child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM') => new Promise<void>(resolve => { if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; } child.once('close', () => resolve()); child.kill(signal); });

test('a desktop on another host enrolls over TLS, runs a job, and needs no inbound port', { skip }, async t => {
  const lan = await withLan(t);
  const app = await lan.application('lan-app', 'system.echo.v1,system.hashchain.v1');
  const node = await startNode(lan, 'desk');
  await eventually('the desktop node to enrol', () => node.count('node.enrolled') > 0 || undefined);
  const nodeId = await nodeIdOf(node.stateDir);
  await eventually('the node to be ONLINE', () => online(lan, nodeId));
  const summary = await lan.client(lan.desktop, app.token, { type: 'system.hashchain.v1', inputs: [{ seed: 'lan', iterations: 200000 }], inflight: 1, keyPrefix: 'one' });
  assert.deepEqual(summary.results[0], { digest: chain('lan', 200000), iterations: 200000 });
  // The desktop's firewall admits nothing inbound but replies: the node never needed a listening port.
  const listeners = await lan.desktop.run('sh', ['-c', 'cat /proc/net/tcp /proc/net/tcp6 | awk \'$4=="0A"\' | wc -l']);
  assert.equal(Number(listeners.trim()), 0, 'the worker host has no listening TCP socket');
  assert.ok(lan.server.ip !== lan.desktop.ip);
});
