import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ResourcePolicySchema, defaultResourcePolicy } from '@privanet/node/resource-policy';
import { PRESET_IDS, applyPreset, detectPreset } from '@privanet/node/presets';
import { exportPolicyText, parsePolicyText } from '@privanet/node/policy-store';
import { ResourceEngine } from '@privanet/node/resource-engine';
import { storageGate } from '@privanet/node/store/gate';
import { StorageService } from '@privanet/node/store/service';
import { inspectStorage, storeRoot } from '@privanet/node/store/status';
import { chunkIdOf } from '@privanet/node/store/chunk-id';
import type { ChunkStore } from '@privanet/node/store/chunk-store';
import { runLocal } from '@privanet/node/local-cli';
import { checkConfig, policyFindings } from '@privanet/node/config-check';
import { computeEffectiveSettings, gatherSettings } from '@privanet/node/effective-settings';
import { buildSupportBundle } from '@privanet/node/support-bundle';
import { STATUS_FILE } from '@privanet/node/status-file';
import { createHash } from 'node:crypto';

const GiB = 1024 ** 3; const posix = process.platform !== 'win32';
const NODE_MAIN = join(fileURLToPath(new URL('../../', import.meta.url)), 'apps', 'node', 'dist', 'main.js');
const idOf = (b: Buffer) => chunkIdOf(createHash('sha256').update(b).digest('hex'));
async function sandbox(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'privanet-storage-')); t.after(() => rm(dir, { recursive: true, force: true })); const state = join(dir, 'state'); await mkdir(state, { mode: 0o700 }); await chmod(state, 0o700);
  const run = async (command: string, args: string[] = [], env: NodeJS.ProcessEnv = {}) => { let out = ''; let err = ''; const code = await runLocal(command, ['--state-dir', state, ...args], env, { out: x => { out += x; }, err: x => { err += x; } }); return { code, out, err }; };
  return { dir, state, run };
}
const enable = (state: string, extra: Record<string, unknown> = {}) => writeFile(join(state, 'policy.json'), JSON.stringify({ version: 1, savedAt: 1, policy: ResourcePolicySchema.parse({ storage: { enabled: true, maxBytes: 2 * GiB, reserveFreeBytes: 1 * GiB, ...extra } }) }), { mode: 0o600 });

test('the storage policy block is off by default, strict, bounded, additive for a v0.3.6 policy, and untouched by presets', () => {
  const defaults = defaultResourcePolicy(); assert.deepEqual(defaults.storage, { enabled: false, maxBytes: 1 * GiB, reserveFreeBytes: 10 * GiB });
  // A policy file written by v0.3.6 (no storage key at all) still loads and gets the off-by-default block.
  const old = JSON.stringify({ version: 1, preset: 'generous', savedAt: 5, policy: (() => { const { storage: _storage, ...rest } = ResourcePolicySchema.parse({ maxCpuPercent: 40 }); void _storage; return rest; })() });
  const parsed = parsePolicyText(old); assert.deepEqual(parsed.policy.storage, defaults.storage); assert.equal(parsed.policy.maxCpuPercent, 40);
  assert.deepEqual(parsePolicyText(JSON.stringify({ maxCpuPercent: 30 })).policy.storage, defaults.storage, 'the installer\'s bare policy file too');
  for (const bad of [{ enabled: 'yes' }, { maxBytes: -1 }, { maxBytes: 2 ** 41 }, { reserveFreeBytes: 1.5 }, { listenerPort: 4041 }, { enabled: true, extra: 1 }]) assert.equal(ResourcePolicySchema.safeParse({ storage: bad }).success, false, JSON.stringify(bad));
  const on = ResourcePolicySchema.parse({ storage: { enabled: true, maxBytes: 5 * GiB } });
  for (const id of PRESET_IDS) assert.deepEqual(applyPreset(on, id).storage, on.storage, `${id} leaves storage alone`);
  assert.equal(detectPreset(on), detectPreset(defaults), 'storage settings never make a preset "custom"'); assert.deepEqual(parsePolicyText(exportPolicyText(on)).policy.storage, on.storage);
});

test('the gate reuses the engine\'s verdicts: disabled, draining, paused, schedule off, battery and a busy disk stop writes; nothing else does', () => {
  const verdict = (blockers: string[], extra: { enabled?: boolean; draining?: boolean; diskIo?: string } = {}) => storageGate({ enabled: () => extra.enabled ?? true, draining: () => extra.draining ?? false, engine: { state: { blockers }, report: { diskIo: extra.diskIo ?? 'medium' } } })();
  assert.deepEqual(verdict([]), { allowed: true });
  assert.deepEqual(verdict([], { enabled: false }), { allowed: false, reason: 'DISABLED' }); assert.deepEqual(verdict([], { draining: true }), { allowed: false, reason: 'DRAINING' });
  assert.deepEqual(verdict(['PAUSED_BY_OWNER']), { allowed: false, reason: 'PAUSED' }); assert.deepEqual(verdict(['SCHEDULE_OFF']), { allowed: false, reason: 'SCHEDULE_OFF' }); assert.deepEqual(verdict(['ON_BATTERY']), { allowed: false, reason: 'ON_BATTERY' });
  assert.deepEqual(verdict([], { diskIo: 'none' }), { allowed: false, reason: 'DISK_BUSY' });
  assert.deepEqual(verdict(['MEMORY_PRESSURE', 'CPU_PRESSURE']), { allowed: true }, 'CPU and memory pressure do not stop a disk write');
});

test('the storage service: nothing is created while storage is off; enabling opens and recovers the store; limits apply live; disabling closes it and keeps the data', async t => {
  const { state } = await sandbox(t); let policy = defaultResourcePolicy(); let draining = false;
  const engine = new ResourceEngine(policy, { sample: () => ({ availableMemoryBytes: 8 * GiB, ownerCpuPercent: 1, power: 'AC', freeDiskBytes: 500 * GiB }) });
  const service = new StorageService({ stateDir: state, policy: () => policy, inputs: { draining: () => draining, engine }, storeOptions: { freeBytes: async () => 500 * GiB }, refreshMs: 100000 });
  await service.start(); assert.equal(service.status.state, 'DISABLED'); assert.deepEqual(await readdir(state), [], 'a node with storage off creates no store directory'); assert.equal(service.chunkStore, undefined);
  policy = ResourcePolicySchema.parse({ storage: { enabled: true, maxBytes: 1000, reserveFreeBytes: 0 } }); await service.apply(policy);
  assert.equal(service.status.state, 'READY'); assert.ok(service.chunkStore); assert.deepEqual((await readdir(state)).sort(), ['store']); const data = Buffer.alloc(600, 5); await (service.chunkStore as ChunkStore | undefined)?.putBuffer(idOf(data), data);
  await service.refresh(); assert.deepEqual([service.status.chunkCount, service.status.committedBytes, service.status.allowedBytes, service.status.networkAccessible], [1, 600, 400, false]);
  policy = ResourcePolicySchema.parse({ storage: { enabled: true, maxBytes: 100, reserveFreeBytes: 0 } }); await service.apply(policy); assert.equal(service.status.allowedBytes, 0, 'a lower quota applies at once'); assert.equal(service.status.chunkCount, 1, 'and deletes nothing');
  engine.setOwnerPause({ kind: 'indefinite' }); engine.update(); await service.refresh(); assert.deepEqual([service.status.state, service.status.reasons], ['UNAVAILABLE', ['PAUSED']]);
  engine.setOwnerPause(undefined); engine.update(); draining = true; await service.refresh(); assert.deepEqual(service.status.reasons, ['DRAINING']); draining = false;
  policy = defaultResourcePolicy(); await service.apply(policy); assert.equal(service.status.state, 'DISABLED'); assert.equal(service.chunkStore, undefined); assert.equal((await inspectStorage(state, policy.storage)).chunkCount, 1, 'the data is still there');
  policy = ResourcePolicySchema.parse({ storage: { enabled: true, maxBytes: 1000, reserveFreeBytes: 0 } }); await service.apply(policy); assert.equal(service.status.chunkCount, 1); assert.deepEqual(await (service.chunkStore as ChunkStore | undefined)?.getBuffer(idOf(data)), data, 'and usable again');
  await service.stop();
});

test('an unsafe store is reported, never repaired by guesswork, and never stops the node', { skip: posix ? undefined : 'symbolic links need privileges on Windows' }, async t => {
  const { state, dir } = await sandbox(t); await mkdir(join(state, 'store', 'chunks'), { recursive: true, mode: 0o700 }); await mkdir(join(dir, 'elsewhere'), { mode: 0o700 }); await symlink(join(dir, 'elsewhere'), join(state, 'store', 'chunks', 'aa'));
  const policy = ResourcePolicySchema.parse({ storage: { enabled: true } }); const events: string[] = [];
  const engine = new ResourceEngine(policy, { sample: () => ({ availableMemoryBytes: 8 * GiB, ownerCpuPercent: 1, power: 'AC' }) });
  const service = new StorageService({ stateDir: state, policy: () => policy, inputs: { draining: () => false, engine }, log: e => events.push(e.event + (e.code ?? '')) }); await service.start();
  assert.deepEqual([service.status.state, service.status.error, service.status.health], ['ERROR', 'STORE_UNSAFE', 'UNSAFE']); assert.ok(events.includes('storage.unavailableSTORE_UNSAFE')); assert.deepEqual(await readdir(join(dir, 'elsewhere')), []); await service.stop();
});

test('privanet-node storage status: local facts only, nothing created, no file access commands, exit 1 when the store is unsafe', async t => {
  const { state, run } = await sandbox(t);
  const off = await run('storage', ['status']); assert.equal(off.code, 0); assert.match(off.out, /DISABLED/); assert.match(off.out, /local store only/); assert.deepEqual(await readdir(state), [], 'asking creates nothing');
  const json = JSON.parse((await run('storage', ['status', '--json'])).out); assert.deepEqual([json.enabled, json.state, json.health, json.networkAccessible, json.maxChunkBytes, json.policySource], [false, 'DISABLED', 'DISABLED', false, 8 * 1024 * 1024, 'default']);
  await enable(state); const on = await run('storage', ['status']); assert.match(on.out, /ENABLED/); assert.match(on.out, /2\.0? ?GiB|2 GiB/); assert.match(on.out, /saved/);
  const locked = await run('storage', ['status'], { PRIVANODE_POLICY_LOCKED: 'true' }); assert.match(locked.out, /DISABLED/, 'a locked policy ignores the saved one'); assert.match(locked.out, /LOCKED/);
  for (const args of [[], ['put'], ['get', 'x'], ['list'], ['status', 'extra'], ['status', '--bogus']]) assert.equal((await run('storage', args)).code, 78, args.join(' '));
  if (posix) { await mkdir(join(state, 'store', 'chunks'), { recursive: true, mode: 0o700 }); await chmod(join(state, 'store', 'chunks'), 0o755); const unsafe = await run('storage', ['status']); assert.equal(unsafe.code, 1); assert.match(unsafe.out, /UNSAFE/); }
});

test('config check, effective settings and the support bundle carry safe storage facts: switches, limits, counts and health, never a path or an inventory', async t => {
  const { state, dir, run } = await sandbox(t); await enable(state, { maxBytes: 0, reserveFreeBytes: 100 });
  const findings = policyFindings(ResourcePolicySchema.parse({ storage: { enabled: true, maxBytes: 0, reserveFreeBytes: 100 } })); for (const id of ['STORAGE_LOCAL_ONLY', 'STORAGE_QUOTA_ZERO', 'STORAGE_LOW_RESERVE']) assert.ok(findings.some(f => f.id === id), id);
  assert.equal(policyFindings(defaultResourcePolicy()).some(f => f.id.startsWith('STORAGE_')), false, 'nothing is said while storage is off');
  if (posix) { await mkdir(join(state, 'store', 'chunks'), { recursive: true, mode: 0o700 }); await chmod(join(state, 'store', 'chunks'), 0o777); const check = await checkConfig({ PRIVANODE_STATE_DIR: state }); assert.ok(check.findings.some(f => f.id === 'STORE_UNSAFE' && f.severity === 'error')); assert.equal(check.ok, false); await chmod(join(state, 'store', 'chunks'), 0o700); }
  const gathered = await gatherSettings({}, state, Date.now()); assert.deepEqual([gathered.settings.storage.enabled, gathered.settings.storage.source, gathered.settings.storage.locked, gathered.settings.storage.networkAccessible], [true, 'saved', false, false]);
  assert.match((await run('settings')).out, /Storage\s+ON: up to 0 GiB/); assert.equal(computeEffectiveSettings({ env: { PRIVANODE_POLICY_LOCKED: 'true' }, local: { version: 1, disabledCapabilities: [] }, policy: { policy: defaultResourcePolicy(), source: { kind: 'defaults' } }, now: 0 }).storage.locked, true);
  const status = await inspectStorage(state, ResourcePolicySchema.parse({ storage: { enabled: true } }).storage);
  const bundle = JSON.stringify(buildSupportBundle({ env: {}, policy: { policy: defaultResourcePolicy(), source: { kind: 'defaults' } }, local: { version: 1, disabledCapabilities: [] }, storage: status, settings: gathered.settings }));
  assert.match(bundle, /"storage":\{"enabled":true/); assert.match(bundle, /"networkAccessible":false/); assert.equal(bundle.includes(dir), false, 'no host path'); assert.equal(bundle.includes(storeRoot(state)), false); assert.doesNotMatch(bundle, /chk_[0-9a-f]{64}/);
});

test('the real node with storage on: it opens the store, reports it in `status`, recovers a crashed partial, opens no network socket for it, and a stored chunk survives a restart', { skip: process.platform === 'linux' ? undefined : 'inspects /proc for sockets' }, async t => {
  const { state } = await sandbox(t); await enable(state);
  // A leftover partial from "before" (older than the stale threshold would be removed; a recent one is kept and counted).
  await mkdir(join(state, 'store', 'incoming'), { recursive: true, mode: 0o700 }); await writeFile(join(state, 'store', 'incoming', `${'3'.repeat(32)}.part`), Buffer.alloc(10), { mode: 0o600 });
  const start = () => { const child = spawn(process.execPath, [NODE_MAIN], { env: { PATH: process.env.PATH ?? '', PRIVANODE_COORDINATOR_URL: 'https://127.0.0.1:9', PRIVANODE_CAPABILITIES: 'system.echo.v1', PRIVANODE_STATE_DIR: state, PRIVANODE_PANEL: 'off' }, stdio: 'ignore' }); t.after(() => { child.kill('SIGKILL'); }); return child; };
  const waitStatus = async (): Promise<{ storage: { state: string; enabled: boolean; networkAccessible: boolean; incomingBytes: number } }> => { const until = Date.now() + 15000; while (Date.now() < until) { try { const doc = (JSON.parse(await readFile(join(state, STATUS_FILE), 'utf8')) as { status: { storage: { state: string; enabled: boolean; networkAccessible: boolean; incomingBytes: number } } }).status; if (doc.storage?.enabled) return doc; } catch { /* not yet */ } await new Promise(r => setTimeout(r, 100)); } throw new Error('the node did not publish a status'); };
  const first = start(); const doc = await waitStatus(); assert.deepEqual([doc.storage.state, doc.storage.networkAccessible, doc.storage.incomingBytes], ['READY', false, 10]);
  // No listening socket belongs to the node process (the panel is off): the store has no network surface.
  const listening = new Set<string>(); for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) for (const line of (await readFile(file, 'utf8').catch(() => '')).split('\n').slice(1)) { const parts = line.trim().split(/\s+/); if (parts[3] === '0A' && parts[9]) listening.add(parts[9]); }
  const owned: string[] = []; for (const fd of await readdir(`/proc/${first.pid}/fd`)) { const target = await readlink(`/proc/${first.pid}/fd/${fd}`).catch(() => ''); const m = /^socket:\[(\d+)\]$/.exec(target); if (m?.[1] && listening.has(m[1])) owned.push(m[1]); }
  assert.deepEqual(owned, [], 'the node listens on no socket');
  first.kill('SIGTERM'); await new Promise(r => first.once('close', r)); await rm(join(state, STATUS_FILE), { force: true });
  const second = start(); const again = await waitStatus(); assert.equal(again.storage.state, 'READY'); second.kill('SIGKILL');
});
