import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ResourcePolicySchema } from '@privanet/node/resource-policy';
import { loadConfig as loadCoordinatorConfig } from '@privanet/coordinator/config';
import { loadConfig as loadNodeConfig } from '@privanet/node/config';

// The deployment files shipped in deploy/ (docs/FIRST_DEPLOYMENT.md) must stay true to the code they configure.
const root = join(import.meta.dirname, '..', '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');
const envKeys = (text: string) => text.split('\n').filter(line => /^[A-Z_]+=/.test(line)).map(line => line.split('=')[0] ?? '');
const envOf = (text: string, fill: Record<string, string>) => Object.fromEntries(text.split('\n').filter(l => /^[A-Z_]+=/.test(l)).map(l => { const i = l.indexOf('='); return [l.slice(0, i), fill[l.slice(0, i)] ?? l.slice(i + 1)]; }));
const hex = 'ab'.repeat(32);
const tool = (command: string, args: string[]) => { try { return { ok: true, output: execFileSync(command, args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString() }; } catch (error) { return { ok: false, output: String((error as { stderr?: Buffer }).stderr ?? error) }; } };
const has = (command: string) => tool('which', [command]).ok;

test('the example resource policies are valid, and the server node is stricter than the desktop on every axis that protects the host', () => {
  const server = ResourcePolicySchema.parse(JSON.parse(read('deploy/policy/server-node.json')));
  const desktop = ResourcePolicySchema.parse(JSON.parse(read('deploy/policy/desktop-node.json')));
  assert.ok(server.maxCpuPercent < desktop.maxCpuPercent && server.reserveCpuPercent > desktop.reserveCpuPercent);
  assert.ok(server.maxMemoryBytes < desktop.maxMemoryBytes && server.reserveMemoryBytes >= 3 * 1024 ** 3, 'a small footprint, and memory always left for the Coordinator and the rest of the server');
  assert.ok(server.reserveDiskBytes >= desktop.reserveDiskBytes && (server.maxBandwidthBytesPerSec ?? 0) < (desktop.maxBandwidthBytesPerSec ?? 0));
  assert.equal(server.onBattery, 'disable'); assert.equal(server.defaultLevel, 'ADAPTIVE'); assert.equal(server.schedule.length, 0, 'the server node has no free-running windows');
  assert.equal(desktop.schedule.some(rule => rule.level === 'FULL'), true); assert.equal(desktop.defaultLevel, 'ADAPTIVE', 'outside its windows the desktop adapts to the user');
  for (const policy of [server, desktop]) assert.equal(policy.fetch.unsafeLocal, undefined, 'no shipped policy switches SSRF protection off');
});

test('the environment examples use only names the programs read, and parse once the secrets are filled in', () => {
  const coordinator = read('deploy/env/coordinator.env.example'); const node = read('deploy/env/node.env.example');
  const coordinatorSource = read('apps/coordinator/src/config.ts'); const nodeSource = read('apps/node/src/config.ts');
  for (const key of envKeys(coordinator)) assert.ok(coordinatorSource.includes(key), `${key} is not read by the Coordinator`);
  for (const key of envKeys(node)) assert.ok(key === 'NODE_EXTRA_CA_CERTS' || nodeSource.includes(key), `${key} is not read by the PrivaNode`);
  const config = loadCoordinatorConfig(envOf(coordinator, { PRIVANET_ADMIN_SECRET: hex }));
  assert.equal(config.host, '127.0.0.1', 'the Coordinator listens on loopback behind the proxy'); assert.equal(config.port, 4010);
  const nodeConfig = loadNodeConfig(envOf(node, { PRIVANODE_ENROLLMENT_TOKEN: hex, PRIVANODE_POLICY_FILE: join(root, 'deploy', 'policy', 'server-node.json') }));
  assert.equal(nodeConfig.url, 'https://10.0.0.68'); assert.equal(nodeConfig.allowInsecureLoopback, false);
  assert.throws(() => loadCoordinatorConfig({ PRIVANET_ADMIN_SECRET: hex, PRIVANET_HOST: '10.0.0.68' }), /TLS termination/);
  assert.doesNotThrow(() => loadCoordinatorConfig({ PRIVANET_ADMIN_SECRET: hex, PRIVANET_HOST: '10.0.0.68', PRIVANET_TLS_TERMINATED: 'true' }));
  for (const text of [coordinator, node]) assert.equal(/=[a-f0-9]{64}\s*$/m.test(text), false, 'no secret is committed in an example');
});

test('the systemd units restart sanely, keep secrets out, and keep the Coordinator independent of the node', () => {
  const coordinator = read('deploy/systemd/privanet-coordinator.service'); const node = read('deploy/systemd/privanet-node.service');
  for (const unit of [coordinator, node]) {
    assert.match(unit, /^Restart=on-failure$/m); assert.match(unit, /^RestartSec=\d+$/m); assert.match(unit, /^RestartPreventExitStatus=78$/m);
    assert.match(unit, /^KillSignal=SIGTERM$/m); assert.match(unit, /^EnvironmentFile=\/etc\/privanet\/[a-z]+\.env$/m); assert.match(unit, /^NoNewPrivileges=yes$/m);
    assert.equal(/SECRET|TOKEN|[a-f0-9]{64}/.test(unit.replace(/PRIVANET_ADMIN_SECRET/g, '')), false, 'no secret in a unit');
  }
  assert.doesNotMatch(coordinator, /privanet-node/, 'the Coordinator knows nothing about the node');
  assert.doesNotMatch(node, /^(Requires|BindsTo|PartOf|Requisite)=.*privanet-coordinator/m, 'the node may start after the Coordinator but never depends on it');
  assert.match(node, /^After=.*privanet-coordinator\.service/m); assert.match(node, /^Nice=\d+$/m); assert.match(node, /^MemoryMax=/m);
  assert.match(coordinator, /^User=privanet$/m); assert.match(node, /^User=privanet-node$/m, 'separate users: one cannot read the other\'s state');
  const timeoutStop = Number(/^TimeoutStopSec=(\d+)$/m.exec(node)?.[1]); assert.ok(timeoutStop > 30, 'longer than the node\'s 30 s default drain');
});

test('systemd accepts the units', { skip: has('systemd-analyze') ? false : 'systemd-analyze is not installed' }, () => {
  for (const unit of ['privanet-coordinator.service', 'privanet-node.service']) {
    const result = tool('systemd-analyze', ['verify', '--man=no', join(root, 'deploy', 'systemd', unit)]);
    // Only syntax problems count: the release directory, users and env files do not exist on a build machine.
    assert.equal(/Unknown (key|section)|Invalid|bad setting|Failed to parse/i.test(result.output), false, result.output);
  }
});

test('the Caddyfile terminates TLS with its own CA, blocks the admin API, limits bodies, and Caddy accepts it', { skip: has('caddy') ? false : 'caddy is not installed' }, () => {
  const file = read('deploy/caddy/Caddyfile');
  assert.match(file, /tls internal/); assert.match(file, /handle \/v1\/admin\/\*\s*\{\s*respond 403/); assert.match(file, /max_size 32KB/); assert.match(file, /reverse_proxy 127\.0\.0\.1:4010/);
  assert.doesNotMatch(file, /insecure|skip_verify|tls_insecure/);
  const result = tool('caddy', ['validate', '--config', join(root, 'deploy', 'caddy', 'Caddyfile'), '--adapter', 'caddyfile']);
  assert.ok(result.ok, result.output);
});
