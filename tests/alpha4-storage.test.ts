import { httpRig } from './storage-http.js';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';
import { mkdirSync, symlinkSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, chmod, symlink, stat, chown, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { createServer as httpsServer } from 'node:https';
import { X509Certificate, generateKeyPairSync } from 'node:crypto';
import { execFileSync, execFile, spawn } from 'node:child_process';
import type { TestContext } from 'node:test';
import { ResourcePolicySchema, defaultResourcePolicy } from '@privanet/node/resource-policy';
import { parseStorageSize, editStoragePolicy } from '@privanet/node/store/settings';
import { storageConfigFindings, liveStorageFindings } from '@privanet/node/store/diagnostics';
import { generateStorageCertificate } from '@privanet/node/store/certificate';
import { runLocal } from '@privanet/node/local-cli';
import { savePolicyFile, resolvePolicy } from '@privanet/node/policy-store';
import { gatherSettings, preferDaemonStorageSettings, withRunningStorageSettings } from '@privanet/node/effective-settings';
import { observedStorage } from '@privanet/node/store/observed-status';
import { StorageSummarySchema, StorageDetailsSchema, PROTOCOL_VERSION } from '@privanet/protocol';
import { probeTransferEndpoint, readPrivateFileUpTo, ApiError } from '@privanet/shared';
import { directRig, freePort } from './direct-transfer-rig.js';
import { oldProtocol } from './old-protocol.js';
import { PrivaNetClient } from '@privanet/sdk';
import { PersistentReplaySet } from '@privanet/node/store/replay-state';
import { loadIdentity } from '@privanet/node/identity';
import { SqliteStore } from '@privanet/coordinator/store';
import { ChunkStore } from '@privanet/node/store/chunk-store';
import { chunkIdOf } from './storage-rig.js';
const root = process.cwd();
async function directory(t: TestContext) { const dir = await mkdtemp(join(tmpdir(), 'alpha4-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }
async function local(dir: string, args: string[], env: NodeJS.ProcessEnv = {}) { let out = ''; let err = ''; const code = await runLocal('storage', args, { PRIVANODE_STATE_DIR: dir, ...env }, { out: s => { out += s; }, err: s => { err += s; } }); return { code, out, err }; }

test('alpha.3 status regression: live store, exact advertisement and listener are distinct from untested reachability; stale/future snapshots are not live', async t => {
  const rig = await directRig(t); const status = rig.storage.status;
  assert.equal(status.state, 'READY'); assert.equal(status.transfer?.listener, 'LISTENING'); assert.equal(status.transfer?.coordinatorAdvertisement, 'ACCEPTED'); assert.equal(status.transfer?.remoteReachability, 'UNKNOWN'); assert.equal(status.networkAccessible, null);
  await savePolicyFile(rig.dir, rig.world.policy);
  for (const at of [Date.now(), Date.now() - 60000, Date.now() + 60000]) {
    await writeFile(join(rig.dir, 'status.json'), JSON.stringify({ version: 1, publishedAt: at, status: { storage: status } }), { mode: 0o600 });
    const result = await local(rig.dir, ['status', '--json']); assert.equal(result.code, 0, result.err); const body = JSON.parse(result.out);
    assert.equal(body.transfer.listener, Math.abs(Date.now() - at) < 1000 ? 'LISTENING' : 'UNKNOWN'); assert.equal(body.transfer.remoteReachability, 'UNKNOWN');
  }
  const offline = await observedStorage(rig.dir, rig.world.policy, {}); assert.equal(offline.observation?.source, 'offline');
});

test('large storage controls validate exact bytes, preserve unrelated policy and backup, refuse locks and require explicit reserve reduction', async t => {
  const dir = await directory(t); const policy = ResourcePolicySchema.parse({ maxCpuPercent: 43, storage: { reserveFreeBytes: 100 * 1024 ** 3 } }); await savePolicyFile(dir, policy);
  for (const [text, expected] of [['500GiB', 500 * 1024 ** 3], ['0.5TiB', 512 * 1024 ** 3], ['3MiB', 3 * 1024 ** 2], ['1KiB', 1024]] as const) assert.equal(parseStorageSize(text), expected);
  for (const invalid of ['1.1B', '2TiB', '-1GiB', 'Infinity', '1e9', '1GB', '1GiB;rm']) assert.throws(() => parseStorageSize(invalid));
  const result = await local(dir, ['capacity', '500GiB', '--json']); assert.equal(result.code, 0); assert.equal(JSON.parse(result.out).storage.maxBytes, 536870912000);
  assert.equal((await resolvePolicy(dir, undefined)).policy.maxCpuPercent, 43); assert.equal(JSON.parse(await readFile(join(dir, 'policy.json.bak'), 'utf8')).policy.storage.maxBytes, policy.storage.maxBytes);
  const before = await readFile(join(dir, 'policy.json'), 'utf8'); assert.equal((await local(dir, ['reserve', '1GiB'])).code, 1); assert.equal(await readFile(join(dir, 'policy.json'), 'utf8'), before);
  assert.equal((await local(dir, ['reserve', '1GiB', '--allow-reserve-reduction'])).code, 0);
  assert.equal((await local(dir, ['enable'], { PRIVANODE_POLICY_LOCKED: 'true' })).code, 1);
  assert.throws(() => editStoragePolicy(policy, { setting: 'transfer.enabled', value: 'true' }, { PRIVANODE_TRANSFER_ENABLED: 'false' }));
  await writeFile(join(dir, 'policy.json'), '{corrupt'); assert.equal((await local(dir, ['capacity', '400GiB'])).code, 1); assert.equal(await readFile(join(dir, 'policy.json'), 'utf8'), '{corrupt');
});

test('defaults < installer < saved < environment and policy lock report per-setting sources without key contents', async t => {
  const dir = await directory(t); const base = join(dir, 'base.json'); await writeFile(base, JSON.stringify({ storage: { maxBytes: 12, transfer: { port: 4100 } } }));
  assert.equal((await gatherSettings({}, dir, Date.now())).settings.storageFields.maxBytes?.source, 'default');
  const env = { PRIVANODE_POLICY_FILE: base };
  assert.equal((await gatherSettings(env, dir, Date.now())).settings.storageFields.maxBytes?.value, 12);
  assert.equal((await gatherSettings(env, dir, Date.now())).settings.storageFields['transfer.port']?.source, 'installer-file');
  await savePolicyFile(dir, ResourcePolicySchema.parse({ storage: { maxBytes: 100, transfer: { port: 4200 } } }));
  const settings = (await gatherSettings({ ...env, PRIVANODE_TRANSFER_PORT: '4300' }, dir, Date.now())).settings;
  assert.deepEqual(settings.storageFields['transfer.port'], { value: 4300, source: 'environment', saved: 4200, override: 'PRIVANODE_TRANSFER_PORT', locked: true });
  assert.equal(settings.storageFields.maxBytes?.source, 'saved');
  const locked = (await gatherSettings({ ...env, PRIVANODE_POLICY_LOCKED: 'true', PRIVANODE_TRANSFER_PORT: '4400' }, dir, Date.now())).settings;
  assert.equal(locked.storageFields.maxBytes?.value, 12); assert.equal(locked.storageFields['transfer.port']?.value, 4400); assert.equal(locked.policy.savedFileIgnored, true);
  assert.equal((await gatherSettings({ ...env, PRIVANODE_TRANSFER_ENABLED: 'wrong' }, dir, Date.now())).settings.storageFields['transfer.enabled']?.value, null);
});

test('TLS setup identifies missing key/certificate, unsafe key, mismatch, bind/endpoint errors and corrupt security state without reading content into findings', async t => {
  const rig = await directRig(t); const p = rig.world.policy; const config = p.storage.transfer;
  const codes = async () => (await storageConfigFindings(rig.dir, p, {})).map(f => f.id);
  config.keyFile = join(rig.dir, 'missing.key'); assert((await codes()).includes('TRANSFER_KEY_MISSING'));
  config.keyFile = join(rig.dir, 'key.pem'); const key = await readFile(config.keyFile, 'utf8');
  if (process.platform !== 'win32') { await chmod(config.keyFile, 0o644); assert((await codes()).includes('TRANSFER_KEY_PERMISSIONS')); await chmod(config.keyFile, 0o600);
    const link = join(rig.dir, 'link.key'); await symlink(config.keyFile, link); config.keyFile = link; assert((await codes()).includes('TRANSFER_KEY_SYMLINK')); config.keyFile = join(rig.dir, 'key.pem'); }
  await writeFile(config.keyFile, generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' })); assert((await codes()).includes('TRANSFER_KEY_MISMATCH')); await writeFile(config.keyFile, key);
  const cert = config.certificateFile; config.certificateFile = join(rig.dir, 'missing.crt'); assert((await codes()).includes('TRANSFER_CERT_MISSING')); config.certificateFile = cert;
  config.endpoint = ''; assert((await codes()).includes('TRANSFER_ENDPOINT_MISSING')); config.endpoint = 'http://127.0.0.1'; assert((await codes()).includes('TRANSFER_ENDPOINT_INVALID')); config.endpoint = `https://127.0.0.1:${config.port}`;
  config.bindAddress = 'localhost'; assert((await codes()).includes('TRANSFER_BIND_INVALID')); config.bindAddress = '127.0.0.1';
  for (const [file, code] of [['transfer-replay.json', 'REPLAY_STATE_INVALID'], ['transfer-receipts.json', 'RECEIPT_STATE_INVALID']]) { await writeFile(join(rig.dir, file!), '{damaged state'); assert((await codes()).includes(code!)); }
  const output = JSON.stringify(await storageConfigFindings(rig.dir, p, {})); assert(!output.includes(key)); assert(!output.includes('{damaged state'));
});

test('occupied port reports TRANSFER_PORT_IN_USE while compute still completes, then recovery starts listener', async t => {
  const rig = await directRig(t); await rig.storage.stop(); const blocker = createServer(); await new Promise<void>(resolve => blocker.listen(rig.world.policy.storage.transfer.port, '127.0.0.1', resolve)); t.after(() => blocker.close());
  await rig.restart(); assert.equal(rig.storage.status.transfer?.listener, 'FAILED'); assert.equal(rig.storage.status.transfer?.error, 'TRANSFER_PORT_IN_USE');
  const app = await rig.coordinator.admin.app({ name: 'compute', allowedJobTypes: ['system.echo.v1'] }); const client = new PrivaNetClient({ url: rig.coordinator.url, allowInsecureLoopback: true, token: app.token });
  const job = await client.submit('system.echo.v1', { message: 'compute survives' }, 'alpha4-bind'); await rig.node.tick(); assert.equal((await client.getJob(job.id)).status, 'COMPLETED');
  await new Promise<void>(resolve => blocker.close(() => resolve())); await rig.storage.apply(rig.world.policy); assert.equal(rig.storage.status.transfer?.listener, 'LISTENING');
});

test('capacity changes retain committed chunks, respect reserve and external disk use, and survive storage disable/re-enable and restart', async t => {
  const dir = await directory(t); let free = 1000; const data = Buffer.alloc(100, 1); const id = chunkIdOf(data);
  let store = await ChunkStore.open(join(dir, 'store'), { limits: { maxBytes: 500, reserveFreeBytes: 100 }, freeBytes: async () => free }); t.after(() => store.close());
  await store.put(id, Readable.from([data]), data.length); store.setLimits({ maxBytes: 50, reserveFreeBytes: 100 }); assert.equal((await store.usage()).allowedBytes, 0); assert(await store.has(id));
  await assert.rejects(store.put(chunkIdOf('new'), Readable.from([Buffer.from('new')]), 3), { code: 'STORAGE_FULL' });
  store.setLimits({ maxBytes: 200, reserveFreeBytes: 100 }); assert.equal((await store.usage()).allowedBytes, 100);
  store.setLimits({ maxBytes: 1000, reserveFreeBytes: 950 }); assert.equal((await store.usage()).allowedBytes, 50); free = 940; assert.equal((await store.usage()).allowedBytes, 0); assert(await store.has(id));
  await store.close(); store = await ChunkStore.open(join(dir, 'store'), { limits: { maxBytes: 50, reserveFreeBytes: 100 }, freeBytes: async () => free }); assert(await store.has(id)); assert.equal((await store.usage()).committedBytes, 100);
  const rig = await directRig(t); const chunk = await rig.client.store(data); await rig.storage.refresh(); rig.world.policy.storage.maxBytes = 50; await rig.storage.apply(rig.world.policy); assert.equal(rig.storage.status.planning?.overcommittedBytes, 50); assert.deepEqual(await rig.client.fetch(chunk), data);
  rig.world.policy.storage.enabled = false; await rig.storage.apply(rig.world.policy); assert.equal(rig.storage.status.committedBytes, 100); assert.equal(rig.storage.status.transfer?.listener, 'DISABLED');
  rig.world.policy.storage.enabled = true; await rig.storage.apply(rig.world.policy); await rig.node.tick(); assert.deepEqual(await rig.client.fetch(chunk), data); await rig.restart(); assert.deepEqual(await rig.client.fetch(chunk), data);
});

test('certificate generation creates a private matching P-256 IP SAN pair, refuses overwrite and renews without replacing old key', async t => {
  try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); } catch { t.skip('OpenSSL unavailable'); return; }
  const dir = await directory(t); const policy = defaultResourcePolicy(); const generated = await generateStorageCertificate(dir, '127.0.0.1', policy);
  const cert = new X509Certificate(await readFile(generated.certificateFile)); assert.equal(cert.checkIP('127.0.0.1'), '127.0.0.1'); assert.equal(cert.publicKey.asymmetricKeyDetails?.namedCurve, 'prime256v1');
  if (process.platform !== 'win32') assert.equal((await stat(generated.keyFile)).mode & 0o777, 0o600);
  Object.assign(policy.storage.transfer, generated); const before = await readFile(generated.keyFile);
  await assert.rejects(generateStorageCertificate(dir, '127.0.0.1', policy)); const renewal = await generateStorageCertificate(dir, '127.0.0.1', policy, true);
  assert.notEqual(renewal.keyFile, generated.keyFile); assert.deepEqual(await readFile(generated.keyFile), before);
  const cliDir = await directory(t); assert.equal((await local(cliDir, ['cert', 'generate', '--ip', '127.0.0.1', '--json'])).code, 0); assert.equal((await local(cliDir, ['transfer', 'enable'])).code, 0);
});

test('explicit operator probe uses exact registered pin, sends no credentials/payload and refuses mismatch/TCP failure; summary stays compatible', async t => {
  const rig = await directRig(t); const target = rig.coordinator.core.storage.probeTarget(rig.node.status.nodeId!);
  assert.equal((await probeTransferEndpoint(target.endpoint, target.nodeId)).code, 'TLS_LISTENER_REACHABLE');
  const old = await oldProtocol('29ad9037a856fbc3b12d611a6528c84c223f26d0'); assert(old); assert(old.StorageSummarySchema!.safeParse(rig.coordinator.core.storage.summary()).success);
  assert(StorageSummarySchema.safeParse(rig.coordinator.core.storage.summary()).success);
  const details = rig.coordinator.core.storage.summary(true); assert.equal(details.pool?.onlineStorageNodes, 1); assert.equal(details.nodes[0]?.endpointRegistration, 'REGISTERED');
  const alternate = await generateStorageCertificate(rig.dir, '127.0.0.1', defaultResourcePolicy());
  await rig.storage.stop(); let calls = 0; const server = httpsServer({ cert: await readFile(alternate.certificateFile), key: await readFile(alternate.keyFile) }, (_req, res) => { calls++; res.end(); });
  await new Promise<void>(resolve => server.listen(rig.world.policy.storage.transfer.port, '127.0.0.1', resolve)); t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  assert.equal((await probeTransferEndpoint(target.endpoint, target.nodeId)).code, 'TLS_IDENTITY_FAILED'); assert.equal(calls, 0);
  const port = await freePort(); const changed = { ...target.endpoint, url: `https://127.0.0.1:${port}` }; assert.equal((await probeTransferEndpoint(changed, target.nodeId)).code, 'ENDPOINT_INVALID');
  await new Promise<void>(resolve => server.close(() => resolve())); assert.equal((await probeTransferEndpoint(target.endpoint, target.nodeId)).code, 'TCP_FAILED');
});

for (const [previousVersion, previousCommit] of [['alpha.3', '29ad9037a856fbc3b12d611a6528c84c223f26d0'], ['alpha.3.1', '3b0c31b']] as const) test(`actual ${previousVersion} binary writes a committed chunk; alpha.4 opens the same store and identity without migration or reenrollment`, async t => {
  const dir = await directory(t); const sourceDir = await mkdtemp(join(root, 'node_modules', '.alpha3-upgrade-')); t.after(() => rm(sourceDir, { recursive: true, force: true }));
  // Build the unmodified starting checkout, with its own source and the already installed exact dependency tree.
  mkdirSync(sourceDir, { recursive: true }); execFileSync('git', ['archive', previousCommit, '-o', join(dir, 'alpha3.tar')]); execFileSync('tar', ['xf', join(dir, 'alpha3.tar'), '-C', sourceDir]);
  mkdirSync(join(sourceDir, 'node_modules', '@privanet'), { recursive: true });
  for (const [name, path] of Object.entries({ protocol: 'packages/protocol', shared: 'packages/shared', sdk: 'packages/sdk', node: 'apps/node', coordinator: 'apps/coordinator' })) symlinkSync(join(sourceDir, path), join(sourceDir, 'node_modules', '@privanet', name), 'junction');
  // Workspace links point to alpha.3 sources; unchanged external dependencies resolve from the enclosing installed tree.
  execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-b'], { cwd: sourceDir, stdio: 'pipe' });
  const oldStore = join(sourceDir, 'apps/node/dist/store/chunk-store.js'); const bytes = Buffer.from('retained alpha3 chunk'); const chunk = chunkIdOf(bytes);
  execFileSync(process.execPath, ['--input-type=module', '-e', `import { Readable } from 'node:stream'; import { loadIdentity } from '@privanet/node/identity';
import { SqliteStore } from '@privanet/coordinator/store';
import { ChunkStore } from ${JSON.stringify(pathToFileURL(oldStore).href)}; const s = await ChunkStore.open(${JSON.stringify(join(dir, 'store'))},{limits:{maxBytes:1000,reserveFreeBytes:0},freeBytes:async()=>10000}); await s.put(${JSON.stringify(chunk)},Readable.from([Buffer.from('retained alpha3 chunk')]),21); await s.close();`], { cwd: sourceDir, stdio: 'pipe' });
  const legacy = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
    import { loadIdentity } from ${JSON.stringify(pathToFileURL(join(sourceDir, 'apps/node/dist/identity.js')).href)};
    import { SqliteStore } from ${JSON.stringify(pathToFileURL(join(sourceDir, 'apps/coordinator/dist/store.js')).href)};
    import { PersistentReplaySet } from ${JSON.stringify(pathToFileURL(join(sourceDir, 'apps/node/dist/store/replay-state.js')).href)};
    const replay = await PersistentReplaySet.open(${JSON.stringify(dir)}); await replay.consume('b'.repeat(32), Date.now() + 120000, Date.now());
    const identity = await loadIdentity(${JSON.stringify(dir)}); const db = new SqliteStore(${JSON.stringify(join(dir, 'coordinator.sqlite'))});
    const applicationId = '11111111-1111-4111-8111-111111111111'; db.saveApplication({id:applicationId,tokenHash:'a'.repeat(64),name:'upgrade-test',allowedJobTypes:['system.echo.v1'],allowedServices:['storage.chunk.v1'],revoked:false});
    db.saveChunk({applicationId,chunkId:${JSON.stringify(chunk)},size:21,class:null,state:'STORED',createdAt:Date.now(),updatedAt:Date.now(),expiresAt:null});
    console.log(JSON.stringify({nodeId:identity.nodeId,coordinatorId:db.coordinatorId,applicationId})); db.close();
  `], { cwd: sourceDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  const replay = await PersistentReplaySet.open(dir); assert.equal(await replay.consume('b'.repeat(32), Date.now() + 120000, Date.now()), 'REPLAYED');
  const identityBefore = await readFile(join(dir, 'identity.json'), 'utf8'); assert.equal((await loadIdentity(dir)).nodeId, legacy.nodeId); assert.equal(await readFile(join(dir, 'identity.json'), 'utf8'), identityBefore);
  const db = new SqliteStore(join(dir, 'coordinator.sqlite')); try { assert.equal(db.coordinatorId, legacy.coordinatorId); assert.equal(db.getApplication(legacy.applicationId)?.tokenHash, 'a'.repeat(64)); assert.equal(db.getChunk(legacy.applicationId, chunk)?.state, 'STORED'); } finally { db.close(); }
  const store = await ChunkStore.open(join(dir, 'store'), { limits: { maxBytes: 1000, reserveFreeBytes: 0 }, freeBytes: async () => 10000 }); t.after(() => store.close()); assert(await store.has(chunk)); assert.equal((await store.usage()).committedBytes, bytes.length); assert.equal(PROTOCOL_VERSION, 1);
  const rig = await directRig(t); const run = promisify(execFile);
  const legacySdk = await run(process.execPath, ['--input-type=module', '-e', `
    import { PrivaNetClient } from ${JSON.stringify(pathToFileURL(join(sourceDir, 'packages/sdk/dist/index.js')).href)};
    const client = new PrivaNetClient({url:process.env.PRIVANET_COORDINATOR_URL,token:process.env.PRIVANET_APP_TOKEN,allowInsecureLoopback:true});
    const bytes = Buffer.alloc(65536, 42); const id = await client.store(bytes); const fetched = await client.fetch(id); if (!bytes.equals(fetched)) throw new Error('integrity'); await client.delete(id); console.log('legacy-sdk-roundtrip-ok');
  `], { cwd: sourceDir, env: { PATH: process.env.PATH, PRIVANET_COORDINATOR_URL: rig.coordinator.url, PRIVANET_APP_TOKEN: rig.app.token }, timeout: 15000 });
  assert.equal(legacySdk.stdout.trim(), 'legacy-sdk-roundtrip-ok');
});

test('saved policy backup replaces a hostile backup symlink without overwriting or exposing the outside target', async t => {
  if (process.platform === 'win32') { t.skip('POSIX symlink scenario'); return; }
  const dir = await directory(t); const policy = defaultResourcePolicy(); await savePolicyFile(dir, policy);
  const outside = join(dir, 'outside'); await writeFile(outside, 'untouched', { mode: 0o600 }); await symlink(outside, join(dir, 'policy.json.bak'));
  policy.storage.maxBytes = 500 * 1024 ** 3; await savePolicyFile(dir, policy); assert.equal(await readFile(outside, 'utf8'), 'untouched');
  assert.equal((await stat(join(dir, 'policy.json.bak'))).mode & 0o777, 0o600); assert.equal(JSON.parse(await readFile(join(dir, 'policy.json.bak'), 'utf8')).policy.storage.maxBytes, 1024 ** 3);
});

test('invalid optional transfer configuration can always be disabled without clearing unrelated settings', () => {
  const policy = ResourcePolicySchema.parse({ storage: { enabled: true, transfer: { enabled: true } } });
  assert.equal(editStoragePolicy(policy, { setting: 'enabled', value: 'false' }, {}).storage.enabled, false);
  assert.equal(editStoragePolicy(policy, { setting: 'transfer.enabled', value: 'false' }, {}).storage.transfer.enabled, false);
});


test('a daemon storage-settings snapshot preserves service overrides when the CLI shell has a different environment', async t => {
  const dir = await directory(t); const configured = (await gatherSettings({}, dir, Date.now())).settings;
  const service = (await gatherSettings({ PRIVANODE_TRANSFER_PORT: '4200' }, dir, Date.now())).settings;
  await writeFile(join(dir, 'status.json'), JSON.stringify({ version: 1, publishedAt: Date.now(), status: { storageSettings: { storage: service.storage, directTransfer: service.directTransfer, storageFields: service.storageFields } } }), { mode: 0o600 });
  const live = await preferDaemonStorageSettings(dir, configured); assert.equal(live.observation, 'daemon'); assert.equal(live.settings.directTransfer.port, 4200); assert.equal(live.settings.storageFields['transfer.port']?.override, 'PRIVANODE_TRANSFER_PORT');
  await writeFile(join(dir, 'status.json'), JSON.stringify({ version: 1, publishedAt: Date.now() + 60000, status: { storageSettings: service } }));
  assert.equal((await preferDaemonStorageSettings(dir, configured)).observation, 'command-environment');
});

test('bounded private-state reads enforce descriptor permissions, no-follow and exact size limits', async t => {
  const dir = await directory(t); const path = join(dir, 'private'); await writeFile(path, '1234', { mode: 0o600 });
  assert.equal(await readPrivateFileUpTo(path, 4), '1234'); await assert.rejects(readPrivateFileUpTo(path, 3)); await assert.rejects(readPrivateFileUpTo(path, -1));
  if (process.platform !== 'win32') { await chmod(path, 0o644); await assert.rejects(readPrivateFileUpTo(path, 4)); await chmod(path, 0o600); const link = join(dir, 'link'); await symlink(path, link); await assert.rejects(readPrivateFileUpTo(link, 4)); }
});

test('a Coordinator endpoint rejection is distinct from an unsupported control plane; compute fallback remains usable', async t => {
  const rig = await directRig(t); const endpoint = rig.coordinator.core.storage.probeTarget(rig.node.status.nodeId!).endpoint;
  const wrong = endpoint;
  const node = await rig.coordinator.node(() => ({ 'storage.chunk.v1': { capacityBytes: 1024, freeBytes: 1024, maxChunkBytes: 8388608, transferEndpoint: wrong } }));
  assert.equal(node.snapshot.connected, true); assert.equal(node.transferAdvertisementStatus(wrong).coordinatorAdvertisement, 'REJECTED');
  const app = await rig.coordinator.admin.app({ name: 'rejection-compute', allowedJobTypes: ['system.echo.v1'] }); const client = new PrivaNetClient({ url: rig.coordinator.url, token: app.token, allowInsecureLoopback: true });
  const job = await client.submit('system.echo.v1', { message: 'compute survives rejection' }, 'alpha4-rejection'); await node.tick(); assert.equal((await client.getJob(job.id)).status, 'COMPLETED');
});


test('the LAN validator runs SDK roundtrip in a separate application process and cleans up if restart-state creation fails', async t => {
  const rig = await directRig(t); const run = promisify(execFile); const script = join(root, 'scripts/validate-storage.mjs');
  const env = { PATH: process.env.PATH, PRIVANET_COORDINATOR_URL: rig.coordinator.url, PRIVANET_APP_TOKEN: rig.app.token, PRIVANODE_ALLOW_INSECURE_LOOPBACK: 'true' };
  const result = await run(process.execPath, [script, 'roundtrip'], { env, timeout: 15000 }); assert.equal(JSON.parse(result.stdout).identicalBytes, true); assert.equal(rig.coordinator.core.storage.summary().chunks.stored, 0);
  const state = join(rig.dir, 'validation.json'); await writeFile(state, 'keep', { mode: 0o600 });
  await assert.rejects(run(process.execPath, [script, 'prepare-restart', state], { env, timeout: 15000 }));
  assert.equal(await readFile(state, 'utf8'), 'keep'); assert.equal(rig.coordinator.core.storage.summary().chunks.stored, 0); assert.equal((await rig.storage.refresh()).committedBytes, 0);
});

test('disabled capacity still reports configured listener address, and invalid updates clear stale address metadata', async t => {
  const rig = await directRig(t); const port = rig.world.policy.storage.transfer.port; rig.world.policy.storage.enabled = false;
  await rig.storage.apply(rig.world.policy); assert.equal(rig.storage.status.transfer?.listener, 'DISABLED'); assert.equal(rig.storage.status.transfer?.configured, true); assert.equal(rig.storage.status.transfer?.port, port);
  rig.world.policy.storage.enabled = true; rig.world.policy.storage.transfer.bindAddress = 'invalid'; await rig.storage.apply(rig.world.policy);
  assert.equal(rig.storage.status.transfer?.listener, 'FAILED'); assert.equal(rig.storage.status.transfer?.bindAddress, null); assert.equal(rig.storage.status.transfer?.endpoint, null);
});


test('invalid optional settings expose a fixed code and redact endpoint credentials, including the saved override value', async t => {
  const dir = await directory(t); await savePolicyFile(dir, ResourcePolicySchema.parse({ storage: { transfer: { endpoint: 'https://operator:never-print-this@127.0.0.1:4050' } } }));
  const settings = (await gatherSettings({ PRIVANODE_TRANSFER_PORT: 'bad-port' }, dir, Date.now())).settings;
  assert.equal(settings.directTransfer.configurationError, 'TRANSFER_CONFIG_INVALID'); assert.equal(JSON.stringify(settings).includes('never-print-this'), false);
  const result = await local(dir, ['status', '--json']); assert.equal(result.code, 1); assert.equal(result.out.includes('never-print-this'), false);
});


test('certificate validity and unreadable certificate diagnostics are explicit and non-secret', async t => {
  const dir = await directory(t); const policy = defaultResourcePolicy(); const generated = await generateStorageCertificate(dir, '127.0.0.1', policy);
  Object.assign(policy.storage.transfer, { certificateFile: generated.certificateFile, keyFile: generated.keyFile, endpoint: generated.endpoint, enabled: true }); const certificate = new X509Certificate(await readFile(generated.certificateFile)); const now = Date.now;
  try {
    Date.now = () => Date.parse(certificate.validFrom) - 1000; assert((await storageConfigFindings(dir, policy, {})).some(f => f.id === 'TRANSFER_CERT_NOT_YET_VALID'));
    Date.now = () => Date.parse(certificate.validTo) + 1000; assert((await storageConfigFindings(dir, policy, {})).some(f => f.id === 'TRANSFER_CERT_EXPIRED'));
  } finally { Date.now = now; }
  policy.storage.transfer.certificateFile = dir; assert((await storageConfigFindings(dir, policy, {})).some(f => f.id === 'TRANSFER_CERT_UNREADABLE'));
});


test('foreign-owned private keys are refused', async t => {
  if (process.platform === 'win32' || process.getuid?.() !== 0) { t.skip('requires POSIX ownership fixture privileges'); return; }
  const dir = await directory(t); const policy = defaultResourcePolicy(); const generated = await generateStorageCertificate(dir, '127.0.0.1', policy);
  Object.assign(policy.storage.transfer, { certificateFile: generated.certificateFile, keyFile: generated.keyFile, endpoint: generated.endpoint, enabled: true });
  try { await chown(generated.keyFile, 65534, 65534); } catch (error) { if (error instanceof Error && 'code' in error && ['EINVAL', 'EPERM'].includes(String(error.code))) { t.skip('sandbox cannot create a foreign-owned key (only uid 0 is mapped)'); return; } throw error; }
  try { assert((await storageConfigFindings(dir, policy, {})).some(f => f.id === 'TRANSFER_KEY_OWNERSHIP')); } finally { await chown(generated.keyFile, 0, 0); }
});

test('a certificate FIFO is diagnosed without blocking optional storage startup', { skip: process.platform !== 'linux', timeout: 3000 }, async t => {
  const dir = await directory(t); const policy = defaultResourcePolicy(); const generated = await generateStorageCertificate(dir, '127.0.0.1', policy); const fifo = join(dir, 'fifo'); execFileSync('mkfifo', [fifo]);
  Object.assign(policy.storage.transfer, { certificateFile: fifo, keyFile: generated.keyFile, endpoint: generated.endpoint, enabled: true });
  assert((await storageConfigFindings(dir, policy, {})).some(f => f.id === 'TRANSFER_CERT_UNREADABLE'));
});


test('admin probe is an explicit authenticated operator-side action with no storage transfer or chunk payload', async t => {
  const rig = await directRig(t); const nodeId = rig.node.status.nodeId!; const run = promisify(execFile);
  const result = await run(process.execPath, [join(root, 'scripts/admin.mjs'), 'storage', 'probe', nodeId, '--json'], { env: { PATH: process.env.PATH, PRIVANET_COORDINATOR_URL: rig.coordinator.url, PRIVANET_ADMIN_SECRET: rig.coordinator.adminSecret, PRIVANODE_ALLOW_INSECURE_LOOPBACK: 'true' }, timeout: 15000 });
  const body = JSON.parse(result.stdout); assert.equal(body.code, 'TLS_LISTENER_REACHABLE'); assert.equal(body.remoteReachability, 'REACHABLE_FROM_OPERATOR'); assert.equal(body.payloadBytes, 0); assert.equal(rig.coordinator.core.storage.summary().transfers.open, 0); assert.equal(rig.storage.status.transfer?.completed, 0);
  const path = `/v1/admin/storage/nodes/${nodeId}/endpoint`; const refused = await rig.coordinator.raw(path, { headers: { authorization: `Bearer ${rig.app.token}` } }); assert.equal(refused.status, 401); assert.equal((await refused.text()).includes('certificate'), false);
});

test('pool details retain offline holders and exclude stale offers while legacy summaries keep their exact shape', async t => {
  const rig = await directRig(t); const bytes = Buffer.from('offline holder data'); const chunk = await rig.client.store(bytes); const nodeId = rig.node.status.nodeId!;
  let summary = rig.coordinator.core.storage.summary(true); assert.equal(summary.pool?.committedBytes, bytes.length); assert.equal(summary.pool?.onlineStorageNodes, 1);
  const offer = rig.coordinator.store.getNodeService(nodeId, 'storage.chunk.v1')!; rig.coordinator.store.saveNodeService({ ...offer, reportedAt: 0 });
  assert.equal(rig.coordinator.core.storage.summary(true).pool?.onlineStorageNodes, 0);
  rig.coordinator.store.deleteNodeServices(nodeId); const node = rig.coordinator.store.getNode(nodeId)!; rig.coordinator.store.saveNode({ ...node, lastHeartbeatAt: 0 });
  summary = rig.coordinator.core.storage.summary(true); assert.equal(summary.pool?.offlineNodesHoldingChunks, 1); assert.equal(summary.pool?.committedBytes, bytes.length); assert.equal(summary.nodes[0]?.committedBytes, bytes.length); assert.equal(JSON.stringify(summary).includes(chunk), false);
  assert.equal(rig.coordinator.core.storage.summary().nodes.length, 0); assert(StorageSummarySchema.safeParse(rig.coordinator.core.storage.summary()).success);
});


test('certificate policy-save failure retains generated material because a post-rename outcome may be uncertain', async t => {
  const dir = await directory(t); await savePolicyFile(dir, defaultResourcePolicy()); await mkdir(join(dir, 'policy.json.bak'), { mode: 0o700 });
  const result = await local(dir, ['cert', 'generate', '--ip', '127.0.0.1', '--json']); assert.equal(result.code, 1); assert.equal(JSON.parse(result.out).code, 'STORAGE_CERT_POLICY_SAVE_FAILED');
  const folders = (await readdir(dir)).filter(name => name.startsWith('transfer-tls-')); assert.equal(folders.length, 1); assert(new X509Certificate(await readFile(join(dir, folders[0]!, 'certificate.pem')))); if (process.platform !== 'win32') assert.equal((await stat(join(dir, folders[0]!, 'key.pem'))).mode & 0o777, 0o600);
});

test('invalid persisted endpoint metadata is refused as an operator diagnostic rather than an internal server error', async t => {
  const rig = await directRig(t); const nodeId = rig.node.status.nodeId!; const offer = rig.coordinator.store.getNodeService(nodeId, 'storage.chunk.v1')!;
  rig.coordinator.store.saveNodeService({ ...offer, transferEndpoint: { ...offer.transferEndpoint!, certFingerprint: '0'.repeat(64) } });
  assert.throws(() => rig.coordinator.core.storage.probeTarget(nodeId), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'INVALID_TRANSFER_ENDPOINT');
});


test('running storage settings report retained last-good policy while the broken saved file is diagnosed separately', async t => {
  const dir = await directory(t); const policy = ResourcePolicySchema.parse({ storage: { enabled: true, maxBytes: 500 * 1024 ** 3 } }); await savePolicyFile(dir, policy); const actual = await resolvePolicy(dir, undefined);
  await writeFile(join(dir, 'policy.json'), '{corrupt'); const offline = await gatherSettings({}, dir, Date.now()); assert.equal(offline.settings.storage.enabled, false); assert(offline.policyProblem);
  const live = withRunningStorageSettings(offline.settings, actual, {}); assert.equal(live.storage.maxBytes, 500 * 1024 ** 3); assert.equal(live.storage.enabled, true); assert.equal(live.storageFields.maxBytes?.source, 'saved');
});


test('the production daemon remains alive and executes compute when optional storage listener startup fails', { timeout: 60000 }, async t => {
  const coordinator = await httpRig(t); const dir = await directory(t); const cert = await generateStorageCertificate(dir, '127.0.0.1', defaultResourcePolicy());
  const busy = createServer(); await new Promise<void>(resolve => busy.listen(0, '127.0.0.1', resolve)); const address = busy.address(); assert(address && typeof address !== 'string'); t.after(() => new Promise<void>(resolve => busy.close(() => resolve())));
  await savePolicyFile(dir, ResourcePolicySchema.parse({ reserveMemoryBytes: 0, safetyMarginBytes: 0, reserveDiskBytes: 0, defaultLevel: 'FULL', storage: { enabled: true, reserveFreeBytes: 0, transfer: { enabled: true, bindAddress: '127.0.0.1', port: address.port, endpoint: `https://127.0.0.1:${address.port}`, certificateFile: cert.certificateFile, keyFile: cert.keyFile } } }));
  const enrollment = await coordinator.admin.enrollment(); const app = await coordinator.admin.app({ name: 'main-storage-failure', allowedJobTypes: ['system.echo.v1'] }); const client = new PrivaNetClient({ url: coordinator.url, token: app.token, allowInsecureLoopback: true }); const job = await client.submit('system.echo.v1', { message: 'main still computes' }, 'alpha4-main-compute');
  const child = spawn(process.execPath, [join(root, 'apps/node/dist/main.js')], { env: { ...process.env, PRIVANODE_HEARTBEAT_MS: '100', PRIVANODE_POLL_MS: '100', PRIVANODE_COORDINATOR_URL: coordinator.url, PRIVANODE_ALLOW_INSECURE_LOOPBACK: 'true', PRIVANODE_CAPABILITIES: 'system.echo.v1', PRIVANODE_STATE_DIR: dir, PRIVANODE_PANEL: 'off', PRIVANODE_ENROLLMENT_TOKEN: enrollment.token }, stdio: 'ignore' });
  t.after(async () => { if (child.exitCode === null) { child.kill('SIGKILL'); await new Promise<void>(resolve => child.once('close', () => resolve())); } });
  let completed = false; for (const end = Date.now() + 45000; Date.now() < end && !completed; await new Promise(resolve => setTimeout(resolve, 50))) completed = (await client.getJob(job.id)).status === 'COMPLETED'; assert(completed, 'compute job completes despite listener failure'); assert.equal(child.exitCode, null);
  const snapshot = JSON.parse(await readFile(join(dir, 'status.json'), 'utf8')); assert.equal(snapshot.status.storage.transfer.listener, 'FAILED'); assert.equal(snapshot.status.storage.transfer.error, 'TRANSFER_PORT_IN_USE');
});


test('large pool sums remain exact and schema-valid beyond JSON safe-integer range', async t => {
  const coordinator = await httpRig(t);
  for (let n = 0; n < 9; n++) await coordinator.node(() => ({ 'storage.chunk.v1': { capacityBytes: 2 ** 50, freeBytes: 2 ** 50, maxChunkBytes: 8388608 } }));
  const summary = coordinator.core.storage.summary(true); assert.equal(summary.pool?.rawAdvertisedCapacityBytes, (9n * (2n ** 50n)).toString()); assert(StorageDetailsSchema.safeParse(summary).success);
});


test('Coordinator gateway/service failure is reported as unreachable rather than a rejected endpoint', async t => {
  const rig = await directRig(t); const original = rig.coordinator.core.heartbeat;
  rig.coordinator.core.heartbeat = () => { throw new ApiError(503, 'COORDINATOR_UNAVAILABLE', 'unavailable'); };
  try { await new Promise(resolve => setTimeout(resolve, 30)); await assert.rejects(rig.node.tick()); assert.equal(rig.storage.status.transfer?.coordinatorAdvertisement, 'UNREACHABLE'); }
  finally { rig.coordinator.core.heartbeat = original; }
});


test('unknown filesystem capacity and corrupt-store observations produce actionable stable diagnostics', async t => {
  const rig = await directRig(t); const findings = liveStorageFindings({ ...rig.storage.status, freeBytes: null, error: 'STORE_UNSAFE', anomalies: 1, integrityFailures: 1 });
  for (const code of ['STORAGE_FILESYSTEM_UNKNOWN', 'STORE_UNSAFE', 'STORAGE_ANOMALIES', 'STORAGE_INTEGRITY_FAILURES']) assert(findings.some(f => f.id === code && !f.message.includes('Storage diagnostic')));
});


test('storage edit validation identifies the offending setting without reporting an unrelated filesystem error or writing policy', async t => {
  const dir = await directory(t); await savePolicyFile(dir, defaultResourcePolicy()); const before = await readFile(join(dir, 'policy.json'), 'utf8');
  const port = await local(dir, ['transfer', 'port', 'invalid']); assert.equal(port.code, 1); assert.match(port.err, /POLICY_FILE_INVALID/); assert.match(port.err, /storage.transfer.port/);
  const bind = await local(dir, ['transfer', 'bind', 'not-an-address']); assert.equal(bind.code, 1); assert.match(bind.err, /TRANSFER_BIND_INVALID/); assert.match(bind.err, /literal IPv4 or IPv6/); assert.equal(await readFile(join(dir, 'policy.json'), 'utf8'), before);
});
