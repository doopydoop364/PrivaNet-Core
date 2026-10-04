import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eventually, netnsUnavailable, startLan } from './netns-rig.js';
import { TEST_CERT, TEST_KEY } from './tls-fixture.js';

const repo = fileURLToPath(new URL('../../', import.meta.url));
test('three isolated hosts: direct TLS PUT/GET/DELETE and zero Coordinator chunk payload bytes', { skip: netnsUnavailable(), timeout: 120000 }, async t => {
  // A = web, B = desktop, C = server. The bridge is outside all three namespaces.
  const audit = join('/tmp', `privanet-transfer-audit-${process.pid}.json`);
  const lan = await startLan({ coordinatorEnv: { NODE_OPTIONS: `--import=${join(repo, 'tests', 'transfer-audit.mjs')}`, PRIVANET_TRANSFER_AUDIT: audit } });
  t.after(() => lan.stop()); t.after(() => rm(audit, { force: true }));
  const certificateFile = join(lan.dir, 'transfer.crt'); const keyFile = join(lan.dir, 'transfer.key');
  await writeFile(certificateFile, TEST_CERT, { mode: 0o600 }); await writeFile(keyFile, TEST_KEY, { mode: 0o600 });
  await lan.desktop.run('iptables', ['-I', 'INPUT', '1', '-p', 'tcp', '--dport', '4050', '-s', lan.web.ip, '-j', 'ACCEPT']);
  await lan.server.run('iptables', ['-I', 'INPUT', '1', '-p', 'tcp', '--dport', '4050', '-j', 'DROP']);
  const policy = join(lan.dir, 'direct-policy.json');
  await writeFile(policy, JSON.stringify({ reserveMemoryBytes: 0, safetyMarginBytes: 0, maxMemoryBytes: 2 * 1024 ** 3, maxCpuPercent: 100, reserveCpuPercent: 0, onBattery: 'normal', maxDiskIo: 'high', maxBandwidthBytesPerSec: null, monthlyTransferBytes: null,
    storage: { enabled: true, maxBytes: 64 * 1024 ** 2, reserveFreeBytes: 0, transfer: { enabled: true, bindAddress: lan.desktop.ip, port: 4050, endpoint: `https://${lan.desktop.ip}:4050`, certificateFile, keyFile } } }));
  const token = await lan.enrollment('system.echo.v1'); const logs: string[] = [];
  lan.desktop.spawn(join(lan.release, 'bin', 'privanet-node'), [], lan.nodeEnv('direct', { PRIVANODE_ENROLLMENT_TOKEN: token, PRIVANODE_CAPABILITIES: 'system.echo.v1', PRIVANODE_POLICY_FILE: policy, PRIVANODE_PANEL: 'off' }), logs);
  await eventually('the real transfer listener', () => logs.join('').includes('storage.transfer_listening') || undefined);
  await eventually('the node enrollment', () => logs.join('').includes('node.enrolled') || undefined);
  const app = await lan.admin(['application', 'direct-netns', '--services', 'storage.chunk.v1'], { PRIVANET_JOB_TYPES: 'system.echo.v1' }) as { token: string };
  // A deterministic canary embedded every 1 KiB of an otherwise random 8 MiB opaque chunk.
  const script = `import { PrivaNetClient } from ${JSON.stringify(join(lan.release, 'node_modules', '@privanet', 'sdk', 'dist', 'index.js'))};
    import { randomBytes, createHash } from 'node:crypto';
    const client = new PrivaNetClient({ url: process.env.PRIVANET_COORDINATOR_URL, token: process.env.PRIVANET_APP_TOKEN });
    const bytes = randomBytes(8 * 1024 ** 2); const marker = Buffer.from('PRIVANET_ALPHA3_PAYLOAD_CANARY_7db1');
    for (let i = 0; i < bytes.length - marker.length; i += 1024) marker.copy(bytes, i);
    const id = await client.store(bytes, { timeoutMs: 30000 }); const got = await client.fetch(id, { timeoutMs: 30000 });
    if (!got.equals(bytes)) throw new Error('bytes differ'); await client.delete(id, { timeoutMs: 30000 });
    console.log(JSON.stringify({ chunkId: id, bytes: got.length, sha256: createHash('sha256').update(got).digest('hex') }));`;
  const result = JSON.parse(await lan.web.run(process.execPath, ['--input-type=module', '-e', script], { PRIVANET_COORDINATOR_URL: lan.url, PRIVANET_APP_TOKEN: app.token, NODE_EXTRA_CA_CERTS: lan.caCert }, 90000)) as { bytes: number; chunkId: string; sha256: string };
  assert.equal(result.bytes, 8 * 1024 ** 2); assert.equal(result.chunkId, `chk_${result.sha256}`);
  const metadata = await lan.admin(['storage', 'status', '--json']) as { chunks: { stored: number; pending: number; deleting: number }; transfers: { last24h: { completed: number } } };
  assert.equal(metadata.transfers.last24h.completed, 3); assert.deepEqual([metadata.chunks.pending, metadata.chunks.stored, metadata.chunks.deleting], [0, 0, 0]);
  const traffic = JSON.parse(await readFile(audit, 'utf8')) as { payloadBytes: number; opaqueBodies: number; oversizedBodies: number; requestBytes: number; responseBytes: number; requests: number };
  assert.equal(traffic.payloadBytes, 0, 'no opaque payload canary reaches Host C in either direction');
  assert.equal(traffic.opaqueBodies, 0, 'every Coordinator request/response body is a bounded metadata JSON object, never opaque chunk bytes');
  assert.equal(traffic.oversizedBodies, 0, 'every Coordinator request remains bounded metadata');
  assert(traffic.requestBytes + traffic.responseBytes < result.bytes / 16, 'all Coordinator plaintext traffic is smaller than 1/16 of one chunk, even including enrollment/keys/receipts');
  const counters = await lan.server.run('iptables', ['-L', 'INPUT', '-v', '-n', '-x']);
  // With -n, iptables versions may print TCP's protocol number (6) rather than its name.
  assert.match(counters, /^\s*0\s+0\s+DROP\s+(?:tcp|6)\s[^\n]*dpt:4050\b/m, 'Host C receives no data-plane TCP packets');
  t.diagnostic(`Host A=${lan.web.ip}; B=${lan.desktop.ip}; C=${lan.server.ip}; PUT+GET payload=${result.bytes * 2}; Coordinator payloadBytes=${traffic.payloadBytes}; metadata=${traffic.requestBytes + traffic.responseBytes} bytes in ${traffic.requests} requests`);
});
