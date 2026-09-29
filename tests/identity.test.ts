import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { bindCoordinator, loadIdentity, signProof } from '@privanet/node/identity';
import { fixture } from './helpers.js';

test('node identity survives restart, matches proof and stays in private files', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'privanet-identity-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const first = await loadIdentity(dir); const second = await loadIdentity(dir); assert.deepEqual(first, second);
  if (process.platform !== 'win32') assert.equal((await stat(join(dir, 'identity.json'))).mode & 0o777, 0o600);
  const f = fixture(); t.after(() => f.store.close());
  const grant = f.core.createEnrollment({ expiresInMs: 1000, capabilities: [] });
  const challenge = f.core.beginEnrollment({ token: grant.token, publicKey: first.publicKey, protocolVersion: 1, daemonVersion: '0.1.0', capabilities: [] });
  assert.equal(f.core.prove(signProof(first, challenge, f.store.coordinatorId, 'enroll'), 'enroll').nodeId, first.nodeId);
  assert.throws(() => signProof(first, challenge, randomUUID(), 'enroll'));
  assert.throws(() => signProof(first, challenge, f.store.coordinatorId, 'auth'));
});
test('corrupt or mismatched node identity is never silently regenerated', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'privanet-corrupt-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const first = await loadIdentity(dir); const path = join(dir, 'identity.json');
  await writeFile(path, JSON.stringify({ ...first, nodeId: 'node_' + '0'.repeat(64) }));
  await assert.rejects(loadIdentity(dir), /Invalid identity/);
  await writeFile(path, 'broken'); await assert.rejects(loadIdentity(dir)); assert.equal(await readFile(path, 'utf8'), 'broken');
});
test('POSIX unsafe identity/state permissions and symlinks fail closed', { skip: process.platform === 'win32' }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'privanet-mode-')); t.after(() => rm(dir, { recursive: true, force: true }));
  await loadIdentity(dir); const path = join(dir, 'identity.json');
  await chmod(path, 0o644); await assert.rejects(loadIdentity(dir), /Unsafe private/);
  await chmod(path, 0o600); await chmod(dir, 0o755); await assert.rejects(loadIdentity(dir), /State directory/); await chmod(dir, 0o700);
  const alias = join(dir, 'alias'); await symlink(dir, alias); await assert.rejects(loadIdentity(alias), /State directory/);
});
test('persisted Coordinator binding rejects URL and identity changes', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'privanet-binding-')); t.after(() => rm(dir, { recursive: true, force: true })); const id = randomUUID();
  await bindCoordinator(dir, 'https://example.org', id); await bindCoordinator(dir, 'https://example.org', id);
  await assert.rejects(bindCoordinator(dir, 'https://other.example.org', id), /binding changed/);
  await assert.rejects(bindCoordinator(dir, 'https://example.org', randomUUID()), /binding changed/);
});
