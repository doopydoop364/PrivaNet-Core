import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppCredentialSchema, EnrollmentTokenSchema } from '@privanet/protocol';
import { secret } from '@privanet/shared';
const exec = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));
async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); assert(address && typeof address !== 'string');
  await new Promise<void>(resolve => server.close(() => resolve())); return address.port;
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>(resolve => {
    const deadline = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.once('close', () => { clearTimeout(deadline); resolve(); }); child.kill('SIGTERM');
  });
}
async function start(path: string, env: NodeJS.ProcessEnv, event: string, logs: string[]): Promise<ChildProcess> {
  const child = spawn(process.execPath, [path], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await new Promise<void>((resolve, reject) => {
      let output = '';
      const deadline = setTimeout(() => reject(new Error('Service startup timeout')), 5000);
      child.once('error', error => { clearTimeout(deadline); reject(error); });
      child.once('exit', () => { clearTimeout(deadline); reject(new Error('Service exited during startup')); });
      child.stdout?.on('data', (chunk: Buffer) => {
        output += chunk.toString(); logs.push(chunk.toString());
        if (output.includes(`"event":"${event}"`)) { clearTimeout(deadline); resolve(); }
      });
      child.stderr?.on('data', (chunk: Buffer) => logs.push(chunk.toString()));
    });
    return child;
  } catch (error) { await stop(child); throw error; }
}

test('actual Coordinator, admin CLI, node daemon and SDK demo work across process restarts', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'privanet-process-')); const port = await unusedPort(); const logs: string[] = [];
  let coordinator: ChildProcess | undefined; let node: ChildProcess | undefined;
  t.after(async () => { if (node) await stop(node); if (coordinator) await stop(coordinator); await rm(dir, { recursive: true, force: true }); });
  const admin = secret(); const url = `http://127.0.0.1:${port}`;
  const env = { ...process.env, PRIVANET_ADMIN_SECRET: admin, PRIVANET_COORDINATOR_URL: url,
    PRIVANET_HOST: '127.0.0.1', PRIVANET_PORT: String(port), PRIVANET_DATA_DIR: join(dir, 'coordinator'),
    PRIVANET_STALE_MS: '500', PRIVANET_OFFLINE_MS: '2000', PRIVANET_LEASE_MS: '1000', PRIVANET_MAINTENANCE_MS: '50',
    PRIVANODE_COORDINATOR_URL: url, PRIVANODE_STATE_DIR: join(dir, 'node'), PRIVANODE_ALLOW_INSECURE_LOOPBACK: 'true',
    PRIVANODE_CAPABILITIES: 'system.echo.v1', PRIVANODE_HEARTBEAT_MS: '50', PRIVANODE_POLL_MS: '10' };
  coordinator = await start('apps/coordinator/dist/main.js', env, 'coordinator.started', logs);
  const application = AppCredentialSchema.parse(JSON.parse((await exec(process.execPath, ['scripts/admin.mjs', 'application', 'process-test'], { cwd: root, env, timeout: 5000 })).stdout));
  const grant = EnrollmentTokenSchema.parse(JSON.parse((await exec(process.execPath, ['scripts/admin.mjs', 'enrollment'], { cwd: root, env, timeout: 5000 })).stdout));
  node = await start('apps/node/dist/main.js', { ...env, PRIVANODE_ENROLLMENT_TOKEN: grant.token }, 'node.enrolled', logs);
  const result = JSON.parse((await exec(process.execPath, ['scripts/demo.mjs'], { cwd: root, env: { ...env, PRIVANET_APP_TOKEN: application.token }, timeout: 5000 })).stdout) as { jobId: string; result: { message: string } };
  assert.equal(result.result.message, 'Hello from PrivaNet SDK');
  const identityBefore = await readFile(join(dir, 'node', 'identity.json'), 'utf8');
  await stop(node); await stop(coordinator);
  coordinator = await start('apps/coordinator/dist/main.js', env, 'coordinator.started', logs);
  node = await start('apps/node/dist/main.js', { ...env, PRIVANODE_ENROLLMENT_TOKEN: undefined }, 'node.authenticated', logs);
  const after = JSON.parse((await exec(process.execPath, ['scripts/demo.mjs'], { cwd: root, env: { ...env, PRIVANET_APP_TOKEN: application.token }, timeout: 5000 })).stdout) as { jobId: string; result: { message: string } };
  assert.equal(after.result.message, result.result.message); assert.notEqual(after.jobId, result.jobId);
  assert.equal(await readFile(join(dir, 'node', 'identity.json'), 'utf8'), identityBefore);
  const privateKey = (JSON.parse(identityBefore) as { privateKey: string }).privateKey;
  for (const value of [admin, application.token, grant.token, privateKey, result.result.message]) assert.equal(logs.join('').includes(value), false);
});
