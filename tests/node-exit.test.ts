import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { harness } from './onboarding-harness.js';

const NODE_MAIN = join(fileURLToPath(new URL('../../', import.meta.url)), 'apps', 'node', 'dist', 'main.js');

// Regression: with the control panel listening, a node that refuses to continue (here a Coordinator that is not the one it enrolled with, exit status 78) must still exit, because the
// panel's listener and the status timers are stopped however the run ends. A service manager depends on the process ending.
test('a node that refuses to continue exits with status 78 even though its control panel is listening', async t => {
  const original = await harness(t); const token = await original.admin.create(); const stateDir = join(original.dir, 'node-exit'); await original.enroll(token.token, { stateDir });
  const other = await harness(t);
  const child = spawn(process.execPath, [NODE_MAIN], { env: { PATH: process.env.PATH ?? '', PRIVANODE_COORDINATOR_URL: other.url, PRIVANODE_ALLOW_INSECURE_LOOPBACK: 'true', PRIVANODE_STATE_DIR: stateDir, PRIVANODE_PANEL_PORT: '0', PRIVANODE_HEARTBEAT_MS: '100', PRIVANODE_POLL_MS: '50' }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { child.kill('SIGKILL'); }); let out = ''; child.stdout.on('data', (c: Buffer) => { out += c.toString(); }); child.stderr.on('data', (c: Buffer) => { out += c.toString(); });
  const code = await Promise.race([new Promise<number | null>(resolve => child.once('close', resolve)), new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), 20000))]);
  assert.equal(code, 78, out); assert.match(out, /panel\.listening/); assert.match(out, /node\.coordinator_binding_changed/);
});
