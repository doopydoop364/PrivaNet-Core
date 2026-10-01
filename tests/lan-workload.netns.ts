import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cpus } from 'node:os';
import type { ChildProcess } from 'node:child_process';
import type { Lan } from './netns-rig.js';
import { eventually, netnsUnavailable, sleep, startLan } from './netns-rig.js';

// Two nodes on two hosts with different owner limits, a web-fetch workload from a third machine, and the desktop's cable pulled and restored.
// The policies are the shipped examples (deploy/policy/*.json) with the memory and CPU reserves zeroed so a busy CI machine never pauses a node,
// and politeness switched off because the site is a synthetic fixture on our own LAN. Run with `sudo -E npm run test:lan`.
const skip = netnsUnavailable();
const policyFor = async (name: 'server-node' | 'desktop-node') => {
  const policy = JSON.parse(await readFile(join(import.meta.dirname, '..', '..', 'deploy', 'policy', `${name}.json`), 'utf8')) as Record<string, unknown>;
  return { ...policy, reserveMemoryBytes: 0, safetyMarginBytes: 0, reserveCpuPercent: 0, reserveDiskBytes: 0,
    fetch: { minHostDelayMs: 0, maxRequestsPerMinute: 6000, unsafeLocal: { allowedCidrs: ['10.77.0.0/24'], allowedPorts: [8080], hostMap: { 'crawl.example': '10.77.0.3' } } } };
};
/** CPU seconds and resident memory of a process, from /proc. */
async function proc(pid: number | undefined): Promise<{ cpuSeconds: number; rssMiB: number } | undefined> {
  if (!pid) return undefined;
  try {
    const stat = (await readFile(`/proc/${pid}/stat`, 'utf8')).split(') ')[1]?.split(' ') ?? []; const status = await readFile(`/proc/${pid}/status`, 'utf8');
    return { cpuSeconds: (Number(stat[11]) + Number(stat[12])) / 100, rssMiB: Math.round(Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] ?? 0) / 1024) };
  } catch { return undefined; }
}
function startNode(lan: Lan, name: string, host: 'server' | 'desktop', policy: object, slots: number, token: string) {
  const logs: string[] = []; const completions: number[] = [];
  const policyFile = join(lan.dir, `${name}.policy.json`);
  const child: ChildProcess = (host === 'server' ? lan.server : lan.desktop).spawn(join(lan.release, 'bin', 'privanet-node'), [],
    lan.nodeEnv(name, { PRIVANODE_CAPABILITIES: 'web.fetch.v1', PRIVANODE_POLICY_FILE: policyFile, PRIVANODE_JOB_SLOTS: String(slots), PRIVANODE_ENROLLMENT_TOKEN: token }), logs);
  // Count whole lines: a pipe may split a line across two chunks, and a count per chunk would miss an event at the boundary.
  let partial = '';
  child.stdout?.on('data', (chunk: Buffer) => { const lines = (partial + chunk.toString()).split('\n'); partial = lines.pop() ?? ''; for (const line of lines) if (line.includes('"event":"job.completed"')) completions.push(Date.now()); });
  return { child, logs, completions, stateDir: join(lan.dir, `node-${name}`), policyFile, policy, count: (event: string) => logs.join('').split(`"event":"${event}"`).length - 1 };
}
const between = (times: number[], from: number, to: number) => times.filter(t => t >= from && t < to).length;

test('server node (conservative) and desktop node (larger): both work, limits differ, the desktop can vanish and return, and nothing is duplicated or lost', { skip, timeout: 420000 }, async t => {
  const lan = await startLan({ leaseMs: 5000, staleMs: 2500, offlineMs: 8000 }); t.after(() => lan.stop());
  await lan.startSite(400);
  const app = await lan.application('crawler', 'web.fetch.v1', { PRIVANET_FETCH_PRODUCT: 'LanBot', PRIVANET_FETCH_INFO_URL: 'https://lan.example/bot' });
  const specs = [{ name: 'srv', host: 'server' as const, policy: await policyFor('server-node'), slots: 8 }, { name: 'dsk', host: 'desktop' as const, policy: await policyFor('desktop-node'), slots: 24 }];
  const nodes = [];
  for (const spec of specs) {
    await writeFile(join(lan.dir, `${spec.name}.policy.json`), JSON.stringify(spec.policy));
    const node = startNode(lan, spec.name, spec.host, spec.policy, spec.slots, await lan.enrollment('web.fetch.v1'));
    await eventually(`${spec.name} to enrol`, () => node.count('node.enrolled') > 0 || undefined); nodes.push(node);
  }
  const [srv, dsk] = nodes; assert.ok(srv && dsk);
  const ids = await Promise.all(nodes.map(async n => (JSON.parse(await readFile(join(n.stateDir, 'identity.json'), 'utf8')) as { nodeId: string }).nodeId));
  await eventually('both nodes online', async () => (await lan.nodeViews()).filter(v => v.status === 'ONLINE').length === 2 || undefined);

  const total = 4000; const inputs = Array.from({ length: total }, (_, i) => ({ url: `http://crawl.example:8080/p/${i}` }));
  const cpuBefore = { coordinator: await proc(lan.pids().coordinator), caddy: await proc(lan.pids().caddy), srv: await proc(srv.child.pid), dsk: await proc(dsk.child.pid) };
  const peaks = [0, 0]; let sampling = true;
  const sampler = (async () => { while (sampling) { try { for (const view of await lan.nodeViews()) { const i = ids.indexOf(view.nodeId); if (i >= 0) peaks[i] = Math.max(peaks[i] ?? 0, view.currentJobs); } } catch { /* sampling only */ } await sleep(300); } })();
  const started = Date.now();
  const work = lan.client(lan.web, app.token, { type: 'web.fetch.v1', inputs, inflight: 64, keyPrefix: 'wl', attempts: true, timeoutMs: 300000 }, 400000);
  let finished = false; void work.then(() => { finished = true; }, () => { finished = true; });

  await sleep(25000); const tLeave = Date.now(); await lan.link(false);            // the desktop's cable is pulled
  await sleep(35000); const tReturn = Date.now(); if (finished) { const early = await work.catch((error: unknown) => ({ failed: String(error) })); assert.fail(`the workload ended before the outage did: ${JSON.stringify(early).slice(0, 600)}`); } await lan.link(true);
  const summary = await work; const tEnd = Date.now(); sampling = false; await sampler;
  const cpuAfter = { coordinator: await proc(lan.pids().coordinator), caddy: await proc(lan.pids().caddy), srv: await proc(srv.child.pid), dsk: await proc(dsk.child.pid) };

  // Correctness: every page exactly once, every result the right page, no application-visible error, no duplicate completion.
  assert.equal(summary.errors, 0);
  const results = summary.results as { outcome: string; requestedUrl: string }[];
  const outcomes: Record<string, number> = {}; for (const r of results) outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1;
  assert.ok(results.every((r, i) => r.requestedUrl === inputs[i]?.url), 'each result belongs to its own job');
  assert.equal(outcomes.FETCHED, total, `every page fetched, outcomes ${JSON.stringify(outcomes)}`);
  await sleep(1500);
  const completedSrv = srv.completions.length; const completedDsk = dsk.completions.length;
  // A node logs job.completed only after the Coordinator's acknowledgement reaches it. When the desktop's cable is pulled while it reports a result,
  // the Coordinator has the result (and the application got it, checked above) but the node never sees the acknowledgement, so its log is short by
  // at most the jobs the desktop had in flight. What must never happen is a job completed twice.
  const logged = completedSrv + completedDsk; const desktopSlots = specs[1]?.slots ?? 0;
  assert.ok(logged <= total, `no job was completed twice (${logged} completions logged for ${total} jobs)`);
  assert.ok(total - logged <= desktopSlots, `at most the desktop's in-flight jobs can lack a logged completion, got ${total - logged}`);
  const retried = summary.attempts.filter(a => a > 1).length;

  const windows = { A: [started, tLeave], B: [tLeave + 10000, tReturn], C: [tReturn + 5000, tEnd] } as const; // B skips the first 10 s (lease expiry, offline detection)
  const rate = (times: number[], [from, to]: readonly [number, number]) => Math.round(between(times, from, to) / ((to - from) / 60000));
  const afterReturn = dsk.completions.find(c => c > tReturn);
  const table = [
    '| Phase | Window | Server node pages/min | Desktop node pages/min | Total pages/min |', '| --- | --- | --- | --- | --- |',
    ...(Object.entries(windows) as [string, readonly [number, number]][]).map(([name, w]) => `| ${name} | ${((w[1] - w[0]) / 1000).toFixed(0)} s | ${rate(srv.completions, w)} | ${rate(dsk.completions, w)} | ${rate(srv.completions, w) + rate(dsk.completions, w)} |`),
  ].join('\n');
  const cpu = (name: 'coordinator' | 'caddy' | 'srv' | 'dsk') => `${((cpuAfter[name]?.cpuSeconds ?? 0) - (cpuBefore[name]?.cpuSeconds ?? 0)).toFixed(1)} s CPU, ${cpuAfter[name]?.rssMiB ?? '?'} MiB RSS`;
  console.log(`\nLAN workload (${cpus().length} CPUs, Node ${process.version}): ${total} pages, ${((tEnd - started) / 1000).toFixed(0)} s, p50 ${summary.p50} ms, p95 ${summary.p95} ms\n${table}\n` +
    `completed: server node ${completedSrv}, desktop node ${completedDsk}; jobs retried ${retried}; peak concurrent jobs: server ${peaks[0]}, desktop ${peaks[1]}; desktop first result ${afterReturn ? ((afterReturn - tReturn) / 1000).toFixed(1) : 'never'} s after the cable was back\n` +
    `lease_lost on desktop: ${dsk.count('job.lease_lost')}, connection failures: server ${srv.count('node.connection_failed')}, desktop ${dsk.count('node.connection_failed')}\n` +
    `Coordinator: ${cpu('coordinator')}; Caddy: ${cpu('caddy')}; server node: ${cpu('srv')}; desktop node: ${cpu('dsk')}`);

  // Limits: the server node's 15 % CPU policy admits at most 3 concurrent fetches (5 % each); the desktop's 60 % at most 12.
  assert.ok((peaks[0] ?? 99) <= 3, `server node peaked at ${peaks[0]} concurrent jobs`); assert.ok((peaks[1] ?? 99) <= 12, `desktop node peaked at ${peaks[1]}`);
  assert.ok(between(dsk.completions, windows.A[0], windows.A[1]) > 1.5 * between(srv.completions, windows.A[0], windows.A[1]), 'the desktop contributes clearly more capacity than the conservative server node');
  assert.ok(between(srv.completions, windows.B[0], windows.B[1]) > 50, 'the server node keeps the work progressing while the desktop is gone');
  assert.ok(afterReturn !== undefined && afterReturn - tReturn < 60000, 'the desktop takes work again after it returns');
  void ids;
});
