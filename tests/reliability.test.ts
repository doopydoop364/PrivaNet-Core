import test from 'node:test';
import assert from 'node:assert/strict';
import { HeartbeatSchema, JOB_TYPES } from '@privanet/protocol';
import type { Lease } from '@privanet/protocol';
import { Coordinator } from '@privanet/coordinator/service';
import type { JobRecord } from '@privanet/coordinator/model';
import { ApiError } from '@privanet/shared';
import { fixture, heartbeat } from './helpers.js';

// Small deterministic PRNG so a failing seed can be replayed exactly.
function random(seed: number) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const threw = (operation: () => unknown) => { try { operation(); return false; } catch (error) { assert.ok(error instanceof ApiError, `unexpected error type: ${String(error)}`); return true; } };

for (const seed of [1, 2, 3, 4, 5]) {
  test(`randomised lifecycle (seed ${seed}): leases are exclusive and fenced, results are never corrupted, terminal jobs never revive, and everything eventually settles`, t => {
    const rnd = random(seed); const pick = <T>(list: T[]) => list[Math.floor(rnd() * list.length)] as T;
    const f = fixture(); t.after(() => f.store.close());
    const core = new Coordinator(f.store, { staleMs: 1e9, offlineMs: 2e9, leaseMs: 100, maxAttempts: 3, maxReleases: 5, sessionMs: 1e6, challengeMs: 100 }, f.now);
    const nodes = Array.from({ length: 5 }, () => f.enroll().session.nodeId); for (const id of nodes) core.heartbeat(id, heartbeat());
    const expected = new Map<string, string>(); const seen = new Map<string, JobRecord['status']>(); const held = new Map<string, Lease>(); const stale: Array<[string, Lease]> = [];
    const submit = (n: number) => { const job = core.submit(f.app, { type: 'system.echo.v1', input: { message: `m${n}` }, idempotencyKey: `k${n}` }); expected.set(job.id, `m${n}`); };
    for (let n = 0; n < 40; n++) submit(n);
    let revoked = 0; const dead = new Set<string>();
    const check = () => {
      const perNode = new Map<string, number>();
      for (const id of expected.keys()) {
        const job = f.store.getJob(id); assert.ok(job);
        if (seen.get(id) === 'COMPLETED' || seen.get(id) === 'FAILED') assert.equal(job.status, seen.get(id), 'a terminal job never changes state');
        seen.set(id, job.status); assert.ok(job.attempts >= 0 && job.attempts <= 3, `attempts ${job.attempts}`);
        if (job.status === 'LEASED') { assert.ok(job.assignedNodeId && job.leaseId && job.leaseExpiresAt !== null); perNode.set(job.assignedNodeId, (perNode.get(job.assignedNodeId) ?? 0) + 1); }
        else assert.ok(job.assignedNodeId === null || job.status === 'COMPLETED' || job.status === 'FAILED');
        if (job.status === 'COMPLETED') assert.deepEqual(job.result, { message: expected.get(id) }, 'a completed job holds exactly its own result');
        if (job.status === 'FAILED') assert.ok(['LEASE_EXPIRED', 'RELEASE_LIMIT', 'NODE_REVOKED', 'HANDLER_FAILED'].includes(job.error?.code ?? ''), `failure code ${job.error?.code}`);
      }
      for (const [node, count] of perNode) assert.ok(count <= 1, `node ${node} holds ${count} leases`);
    };
    // Oracle: what the store says right now decides whether an operation with a held lease is legitimate.
    const legit = (nodeId: string, lease: Lease) => { const job = f.store.getJob(lease.jobId); return !!job && job.status === 'LEASED' && job.leaseId === lease.leaseId && job.assignedNodeId === nodeId && (job.leaseExpiresAt ?? 0) > f.now() && !dead.has(nodeId); };
    let submitted = 40;
    for (let step = 0; step < 1500; step++) {
      const nodeId = pick(nodes); const lease = held.get(nodeId); const roll = rnd();
      if (roll < 0.28 && (!lease || rnd() < 0.3)) { if (!dead.has(nodeId)) { core.heartbeat(nodeId, heartbeat()); const next = core.lease(nodeId); if (next) { if (lease) stale.push([nodeId, lease]); held.set(nodeId, next); } } else assert.equal(threw(() => core.lease(nodeId)), true); }
      else if (roll < 0.5 && lease) {
        // A holder of a live lease may report any schema-valid result (the Coordinator cannot judge content; see docs/security.md),
        // so a legitimate completion always carries the correct message here. An illegitimate one carries a tampered message and must change nothing.
        const good = legit(nodeId, lease); const message = good ? expected.get(lease.jobId) ?? '' : 'tampered';
        const before = f.store.getJob(lease.jobId); const failed = threw(() => core.complete(nodeId, lease.jobId, { leaseId: lease.leaseId, result: { message } }));
        if (good) assert.equal(failed, false, 'a legitimate completion is accepted');
        else if (before?.status !== 'COMPLETED') assert.equal(failed, true, 'a stale or foreign completion is rejected');
        const after = f.store.getJob(lease.jobId); assert.notDeepEqual(after?.result, { message: 'tampered' }, 'a tampered result is never stored');
        held.delete(nodeId);
      } else if (roll < 0.6 && lease) { const good = legit(nodeId, lease); const failed = threw(() => core.release(nodeId, lease.jobId, { leaseId: lease.leaseId, reason: 'PREEMPTED' })); assert.equal(failed, !good); held.delete(nodeId); }
      else if (roll < 0.68 && lease) { const good = legit(nodeId, lease); let ok = true; try { const r = core.renew(nodeId, lease.jobId, { leaseId: lease.leaseId }); lease.expiresAt = r.expiresAt; } catch { ok = false; } assert.equal(ok, good, 'renewal succeeds exactly when the lease is legitimate'); }
      else if (roll < 0.72 && lease) { if (!dead.has(nodeId)) { const good = legit(nodeId, lease); assert.equal(threw(() => core.fail(nodeId, lease.jobId, { leaseId: lease.leaseId, error: { code: 'HANDLER_FAILED' } })), !good); } held.delete(nodeId); }
      else if (roll < 0.76 && stale.length > 0) {
        // A node that kept an old lease around (lost response, restart) tries it again: it may only succeed if the store still says it is current.
        const [owner, old] = pick(stale); const good = legit(owner, old); const before = f.store.getJob(old.jobId);
        const failed = threw(() => core.complete(owner, old.jobId, { leaseId: old.leaseId, result: { message: good ? expected.get(old.jobId) ?? '' : 'tampered' } }));
        if (good) assert.equal(failed, false); else if (before?.status !== 'COMPLETED') assert.equal(failed, true, 'an old lease can never complete a re-leased or requeued job');
        assert.notDeepEqual(f.store.getJob(old.jobId)?.result, { message: 'tampered' });
      }
      else if (roll < 0.9) { f.advance(Math.floor(rnd() * 130)); core.maintain(); }
      else if (roll < 0.93 && submitted < 60) submit(submitted++);
      else if (roll < 0.95 && revoked < 1 && nodes.length - dead.size > 2) { core.revokeNode(nodeId); dead.add(nodeId); revoked++; }
      else if (roll < 0.97 && !dead.has(nodeId)) { core.goodbye(nodeId, { reason: 'SHUTDOWN' }); held.delete(nodeId); }
      check();
    }
    // Settling: a healthy node drains whatever is left; orphaned leases expire and are retried or failed.
    const healthy = f.enroll().session.nodeId;
    for (let round = 0; round < 500; round++) {
      f.advance(120); core.maintain(); core.heartbeat(healthy, heartbeat());
      const lease = core.lease(healthy); if (lease) core.complete(healthy, lease.jobId, { leaseId: lease.leaseId, result: { message: expected.get(lease.jobId) ?? '' } });
      check(); if ([...expected.keys()].every(id => ['COMPLETED', 'FAILED'].includes(f.store.getJob(id)?.status ?? ''))) break;
    }
    const finals = [...expected.keys()].map(id => f.store.getJob(id)?.status);
    assert.ok(finals.every(status => status === 'COMPLETED' || status === 'FAILED'), 'every job settles');
    assert.ok(finals.filter(status => status === 'COMPLETED').length >= submitted * 0.5, 'most work still completes despite the chaos');
  });
}

test('compatibility: old nodes and old stored records keep working after the upgrade', t => {
  const f = fixture(); t.after(() => f.store.close());
  // v0.1 heartbeat: no lifecycle, no resources.
  assert.equal(HeartbeatSchema.safeParse(heartbeat()).success, true);
  // v0.2.0 report: memory and CPU only; none of the v0.2.1 fields.
  const v020 = { ...heartbeat(), lifecycle: 'ACTIVE', resources: { contribution: 'ADAPTIVE', pressure: 'NORMAL', power: 'AC', memoryBudgetBytes: 512 * 1024 * 1024, cpuBudgetPercent: 50 } };
  assert.equal(HeartbeatSchema.safeParse(v020).success, true);
  const node = f.enroll(); const job = f.submit('old'); f.core.heartbeat(node.session.nodeId, v020);
  const lease = f.core.lease(node.session.nodeId); assert.ok(lease && lease.jobId === job.id, 'a v0.2.0 node still receives work');
  // A record written before v0.2.1 has no leasedAt and no releases field: it must still renew, complete and retire.
  const stored = f.store.getJob(job.id); assert.ok(stored); const legacy: JobRecord = { ...stored }; delete legacy.leasedAt; delete legacy.releases; f.store.saveJob(legacy);
  assert.ok(f.core.renew(node.session.nodeId, job.id, { leaseId: lease.leaseId }).expiresAt >= lease.expiresAt);
  f.core.complete(node.session.nodeId, job.id, { leaseId: lease.leaseId, result: { message: 'old' } });
  assert.equal(f.core.getJob(f.app, job.id).status, 'COMPLETED');
  // The registry still carries the original job type unchanged; new types are additions only.
  assert.deepEqual(Object.keys(JOB_TYPES).sort(), ['system.echo.v1', 'system.hashchain.v1']);
  assert.equal(JOB_TYPES['system.echo.v1'].version, 1);
});
