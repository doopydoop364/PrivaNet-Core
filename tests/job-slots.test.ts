import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrivaNode } from '@privanet/node/daemon';
import { Coordinator } from '@privanet/coordinator/service';
import { fixture } from './helpers.js';
import { ResourceEngine } from '@privanet/node/resource-engine';
import { defaultResourcePolicy } from '@privanet/node/resource-policy';
import { LocalControl } from '@privanet/node/local-control';
import { LOCAL_STATE_FILE, jobSlotsChoice } from '@privanet/node/local-state';
import { PolicyError } from '@privanet/node/policy-store';
import { runLocal } from '@privanet/node/local-cli';
import { STATUS_FILE } from '@privanet/node/status-file';

const GiB = 1024 ** 3; const posix = process.platform !== 'win32';
const NODE_MAIN = join(fileURLToPath(new URL('../../', import.meta.url)), 'apps', 'node', 'dist', 'main.js');
async function state(t: TestContext) { const dir = await mkdtemp(join(tmpdir(), 'privanet-slots-')); t.after(() => rm(dir, { recursive: true, force: true })); const s = join(dir, 'state'); await mkdir(s, { mode: 0o700 }); await chmod(s, 0o700); return s; }
function control(dir: string, jobSlots: { running: number; fromEnvironment: boolean }) {
  const policy = defaultResourcePolicy(); const engine = new ResourceEngine(policy, { sample: () => ({ availableMemoryBytes: 12 * GiB, ownerCpuPercent: 1, power: 'AC', freeDiskBytes: 100 * GiB }) });
  const node = new PrivaNode({ url: 'https://127.0.0.1:9', stateDir: dir, capabilities: ['system.echo.v1'], engine });
  return new LocalControl({ stateDir: dir, node, engine, jobSlots });
}

test('job slots: an explicit PRIVANODE_JOB_SLOTS wins, then the saved choice, then the default', () => {
  assert.deepEqual(jobSlotsChoice(2, true, 8), { value: 2, source: 'environment' });
  assert.deepEqual(jobSlotsChoice(1, false, 8), { value: 8, source: 'saved' });
  assert.deepEqual(jobSlotsChoice(1, false, undefined), { value: 1, source: 'default' });
});

test('job slots can be saved and cleared, are validated, apply at the next start, and cannot override the environment', async t => {
  const dir = await state(t); const c = control(dir, { running: 1, fromEnvironment: false }); await c.init({ policy: defaultResourcePolicy(), source: { kind: 'defaults' } }); t.after(() => c.stop());
  assert.deepEqual(c.view.jobSlots, { running: 1, saved: null, editable: true, source: 'default' }); assert.deepEqual(c.view.restartRequired, []);
  await c.setJobSlots(4); assert.equal(c.view.jobSlots.saved, 4); assert.equal(c.view.jobSlots.source, 'saved'); assert.deepEqual(c.view.restartRequired, ['job slots'], 'a saved number different from the running one needs a restart');
  if (posix) assert.equal((await stat(join(dir, LOCAL_STATE_FILE))).mode & 0o777, 0o600);
  await c.setJobSlots(1); assert.deepEqual(c.view.restartRequired, [], 'saving the number already running needs nothing');
  for (const bad of [0, 65, 1.5, -2, Number.NaN]) await assert.rejects(c.setJobSlots(bad), (error: unknown) => error instanceof PolicyError && error.code === 'POLICY_FILE_INVALID', String(bad));
  await c.setJobSlots(undefined); assert.equal(c.view.jobSlots.saved, null);
  const env = control(dir, { running: 3, fromEnvironment: true }); await env.init({ policy: defaultResourcePolicy(), source: { kind: 'defaults' } }); t.after(() => env.stop());
  assert.equal(env.view.jobSlots.editable, false); assert.equal(env.view.jobSlots.source, 'environment');
  await assert.rejects(env.setJobSlots(5), (error: unknown) => error instanceof PolicyError && error.code === 'JOB_SLOTS_SET_BY_ENVIRONMENT');
});

test('privanet-node slots: show, set, clear, usage errors, and a note when the environment takes priority', async t => {
  const dir = await state(t);
  const run = async (args: string[], env: NodeJS.ProcessEnv = {}) => { let out = ''; let err = ''; const code = await runLocal('slots', ['--state-dir', dir, ...args], env, { out: x => { out += x; }, err: x => { err += x; } }); return { code, out, err }; };
  assert.match((await run(['show'])).out, /Job slots: 1 \(the default\)/);
  const set = await run(['set', '6']); assert.equal(set.code, 0); assert.match(set.out, /Saved: 6 job slots\. It applies the next time the node starts\./); assert.doesNotMatch(set.out, /NOTE/);
  assert.match((await run(['show'])).out, /Job slots: 6 \(saved/); assert.equal(JSON.parse((await run(['show', '--json'])).out).saved, 6);
  assert.match((await run(['set', '2'], { PRIVANODE_JOB_SLOTS: '9' })).out, /NOTE: PRIVANODE_JOB_SLOTS is set/); assert.match((await run(['show'], { PRIVANODE_JOB_SLOTS: '9' })).out, /Job slots: 9 \(set by PRIVANODE_JOB_SLOTS/);
  assert.equal((await run(['clear'])).code, 0); assert.equal(JSON.parse((await run(['show', '--json'])).out).saved, null);
  for (const args of [[], ['set'], ['set', '0'], ['set', '65'], ['set', 'many'], ['set', '1.5'], ['show', 'extra'], ['bogus']]) assert.equal((await run(args)).code, 78, args.join(' '));
});

test('the real node starts with the saved job slots, and PRIVANODE_JOB_SLOTS overrides them', async t => {
  const dir = await state(t); await runLocal('slots', ['--state-dir', dir, 'set', '3'], {}, { out: () => undefined, err: () => undefined });
  const start = async (extra: NodeJS.ProcessEnv) => {
    const child = spawn(process.execPath, [NODE_MAIN], { env: { PATH: process.env.PATH ?? '', PRIVANODE_COORDINATOR_URL: 'https://127.0.0.1:9', PRIVANODE_CAPABILITIES: 'system.echo.v1', PRIVANODE_STATE_DIR: dir, PRIVANODE_PANEL: 'off', ...extra }, stdio: 'ignore' });
    t.after(() => { child.kill('SIGKILL'); });
    const until = Date.now() + 15000; let slots: unknown;
    while (Date.now() < until) { try { slots = (JSON.parse(await readFile(join(dir, STATUS_FILE), 'utf8')) as { status: { jobs: { slots: { configured: number } } } }).status.jobs.slots.configured; break; } catch { await new Promise(resolve => setTimeout(resolve, 100)); } }
    child.kill('SIGKILL'); await new Promise(resolve => child.once('close', resolve)); await rm(join(dir, STATUS_FILE), { force: true });
    return slots;
  };
  assert.equal(await start({}), 3, 'the saved choice applies at start');
  assert.equal(await start({ PRIVANODE_JOB_SLOTS: '2' }), 2, 'an explicit environment setting takes priority');
});


test('coordinator node control revisions are persisted, typed and exposed to the node', t => {
  const f = fixture(); t.after(() => f.store.close()); const enrolled = f.enroll();
  const id = enrolled.session.nodeId;
  assert.deepEqual(f.core.nodeControl(f.store.getNode(id)!), { revision: 0 });
  assert.deepEqual(f.core.setNodeSlots(id, { jobSlots: 6 }), { revision: 1, jobSlots: 6 });
  assert.deepEqual(f.core.setNodePreset(id, { preset: 'generous' }), { revision: 2, jobSlots: 6, preset: 'generous' });
  const view = f.core.listNodes()[0]; assert.equal(view?.control?.revision, 2); assert.equal(view?.control?.jobSlots, 6); assert.equal(view?.control?.preset, 'generous');
  assert.throws(() => f.core.setNodeSlots(id, { jobSlots: 65 }));
  assert.throws(() => f.core.setNodePreset(id, { preset: 'root' }));
});
