import test from 'node:test';
import assert from 'node:assert/strict';
import { EchoSchema, EnrollmentStartSchema, HeartbeatSchema, LeaseSchema, SubmitSchema } from '@privanet/protocol';
import { Transport } from '@privanet/shared';
import { executeLease } from '@privanet/node/handlers';
import { loadConfig as coordinatorConfig } from '@privanet/coordinator/config';
import { loadConfig as nodeConfig } from '@privanet/node/config';
import { randomUUID } from 'node:crypto';

test('strict typed schema accepts echo data including shell-looking strings', () => {
  const message = '$(touch /tmp/do-not-execute); rm -rf /';
  const lease = LeaseSchema.parse({ jobId: randomUUID(), leaseId: randomUUID(), type: 'system.echo.v1', input: { message }, protocolVersion: 1, expiresAt: Date.now() + 10000, attempt: 1 });
  assert.deepEqual(executeLease(lease, ['system.echo.v1']), { message });
  assert.throws(() => executeLease(lease, []));
});
test('unknown type, unknown fields, malformed input and oversized values fail closed', () => {
  const valid = { type: 'system.echo.v1', input: { message: 'ok' }, idempotencyKey: 'request-1' };
  assert(SubmitSchema.safeParse(valid).success);
  for (const input of [
    { ...valid, type: 'run.command.v1' }, { ...valid, command: 'echo hi' },
    { ...valid, input: { message: 1 } }, { ...valid, input: { message: 'ok', shell: true } },
    { ...valid, input: { message: 'x'.repeat(1025) } }, { ...valid, idempotencyKey: '../../bad' },
  ]) assert.equal(SubmitSchema.safeParse(input).success, false);
  assert.equal(EchoSchema.safeParse({}).success, false);
});
test('unsupported protocol, capability and excessive resource claims rejected', () => {
  const heartbeat = { protocolVersion: 1, daemonVersion: '0.1.0', capabilities: ['system.echo.v1'], jobSlots: 1, currentJobs: 0 };
  for (const input of [{ ...heartbeat, protocolVersion: 2 }, { ...heartbeat, capabilities: ['compute.anything'] }, { ...heartbeat, jobSlots: 2 }, { ...heartbeat, hostname: 'private' }]) assert.equal(HeartbeatSchema.safeParse(input).success, false);
  assert.equal(EnrollmentStartSchema.safeParse({ token: 'not-a-token' }).success, false);
});
test('transport refuses insecure remote destinations, localhost DNS, URL secrets and unsafe paths', () => {
  for (const url of ['http://example.org', 'http://localhost:4010', 'https://user:pass@example.org', 'https://example.org/path', 'https://example.org?token=secret']) assert.throws(() => new Transport({ url, allowInsecureLoopback: true }));
  assert.throws(() => new Transport({ url: 'http://127.0.0.1:4010' }));
  assert.equal(new Transport({ url: 'http://127.0.0.1:4010', allowInsecureLoopback: true }).origin, 'http://127.0.0.1:4010');
  assert.equal(new Transport({ url: 'http://[::1]:4010', allowInsecureLoopback: true }).origin, 'http://[::1]:4010');
  assert.equal(new Transport({ url: 'https://example.org' }).origin, 'https://example.org');
});
test('configuration keeps roles separate, operator defaults disabled and remote binding explicit', () => {
  const admin = 'a'.repeat(64);
  assert.equal(coordinatorConfig({ PRIVANET_ADMIN_SECRET: admin, PORT: '22' }).port, 4010);
  assert.throws(() => coordinatorConfig({ PRIVANET_ADMIN_SECRET: admin, PRIVANET_HOST: '0.0.0.0' }));
  assert.equal(coordinatorConfig({ PRIVANET_ADMIN_SECRET: admin, PRIVANET_HOST: '0.0.0.0', PRIVANET_TLS_TERMINATED: 'true' }).host, '0.0.0.0');
  assert.deepEqual(nodeConfig({}).capabilities, []);
  assert.throws(() => nodeConfig({ PRIVANODE_CAPABILITIES: 'compute.anything' }));
});
