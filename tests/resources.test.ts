import test from 'node:test';
import assert from 'node:assert/strict';
import { CPU_CLASS_MIN_PERCENT, HeartbeatSchema, JOB_TYPES, ResourceEstimateSchema } from '@privanet/protocol';
import type { ResourceReport } from '@privanet/protocol';
import { Coordinator } from '@privanet/coordinator/service';
import { fitsBudget, LEGACY_BUDGET, ResourceAwareScheduler } from '@privanet/coordinator/scheduler';
import { ApiError } from '@privanet/shared';
import { fixture, heartbeat } from './helpers.js';

const report = (overrides: Partial<ResourceReport> = {}): ResourceReport => ({
  contribution: 'ADAPTIVE', pressure: 'NORMAL', power: 'AC', memoryBudgetBytes: 512 * 1024 * 1024, cpuBudgetPercent: 50, ...overrides });
const beat = (resources?: ResourceReport, lifecycle?: 'ACTIVE' | 'DRAINING') => ({ ...heartbeat(), ...(resources ? { resources } : {}), ...(lifecycle ? { lifecycle } : {}) });
const code = (expected: string) => (error: unknown) => error instanceof ApiError && error.code === expected;

test('every registered job type declares a valid resource estimate', () => {
  for (const definition of Object.values(JOB_TYPES)) assert.equal(ResourceEstimateSchema.safeParse(definition.resources).success, true);
  assert.equal(ResourceEstimateSchema.safeParse({ ...JOB_TYPES['system.echo.v1'].resources, memoryBytes: -1 }).success, false);
  assert.equal(ResourceEstimateSchema.safeParse({ ...JOB_TYPES['system.echo.v1'].resources, cpu: 'huge' }).success, false);
  assert.equal(ResourceEstimateSchema.safeParse({ ...JOB_TYPES['system.echo.v1'].resources, run: 'sh' }).success, false);
});

test('heartbeat resource and lifecycle fields are strict, bounded and optional', () => {
  assert.equal(HeartbeatSchema.safeParse(heartbeat()).success, true);
  assert.equal(HeartbeatSchema.safeParse(beat(report(), 'DRAINING')).success, true);
  for (const bad of [report({ cpuBudgetPercent: 101 }), report({ memoryBudgetBytes: -1 }), { ...report(), hostname: 'x' }, report({ contribution: 'ALL' as never })])
    assert.equal(HeartbeatSchema.safeParse({ ...heartbeat(), resources: bad }).success, false);
  assert.equal(HeartbeatSchema.safeParse({ ...heartbeat(), lifecycle: 'OFFLINE_EXPECTED' }).success, false);
});

test('budget fitting compares declared memory and CPU class with the permitted budget', () => {
  const estimate = { ...JOB_TYPES['system.echo.v1'].resources, memoryBytes: 100, cpu: 'medium' as const };
  assert.equal(fitsBudget(estimate, { memoryBudgetBytes: 100, cpuBudgetPercent: CPU_CLASS_MIN_PERCENT.medium }), true);
  assert.equal(fitsBudget(estimate, { memoryBudgetBytes: 99, cpuBudgetPercent: 100 }), false);
  assert.equal(fitsBudget(estimate, { memoryBudgetBytes: 100, cpuBudgetPercent: CPU_CLASS_MIN_PERCENT.medium - 1 }), false);
  assert.equal(fitsBudget(JOB_TYPES['system.echo.v1'].resources, LEGACY_BUDGET), true);
});

test('scheduler needs enough currently permitted resources, not only the capability', t => {
  const f = fixture(); t.after(() => f.store.close()); const a = f.enroll(); f.submit();
  f.core.heartbeat(a.session.nodeId, beat(report({ memoryBudgetBytes: 1024 })));
  assert.equal(f.core.lease(a.session.nodeId), null);
  f.core.heartbeat(a.session.nodeId, beat(report({ cpuBudgetPercent: 0 })));
  assert.equal(f.core.lease(a.session.nodeId), null);
  f.core.heartbeat(a.session.nodeId, beat(report({ contribution: 'PAUSED', memoryBudgetBytes: 2 ** 30 })));
  assert.equal(f.core.lease(a.session.nodeId), null);
  f.core.heartbeat(a.session.nodeId, beat(report()));
  assert.ok(f.core.lease(a.session.nodeId));
});

test('nodes that report no resources get only the small legacy budget, and stale budgets are dropped', t => {
  const f = fixture(); t.after(() => f.store.close()); const a = f.enroll(); f.submit();
  f.core.heartbeat(a.session.nodeId, beat(report({ contribution: 'PAUSED' })));
  f.core.heartbeat(a.session.nodeId, heartbeat());
  assert.equal(f.core.listNodes()[0]?.resources, undefined);
  assert.ok(f.core.lease(a.session.nodeId));
});

test('draining node keeps its status but is assigned nothing; returning to ACTIVE resumes', t => {
  const f = fixture(); t.after(() => f.store.close()); const a = f.enroll(); f.submit();
  f.core.heartbeat(a.session.nodeId, beat(report(), 'DRAINING'));
  assert.equal(f.core.listNodes()[0]?.status, 'DRAINING'); assert.equal(f.core.lease(a.session.nodeId), null);
  f.advance(100); assert.equal(f.core.listNodes()[0]?.status, 'STALE');
  f.advance(500); assert.equal(f.core.listNodes()[0]?.status, 'OFFLINE');
  f.core.heartbeat(a.session.nodeId, beat(report(), 'ACTIVE'));
  assert.equal(f.core.listNodes()[0]?.status, 'ONLINE'); assert.ok(f.core.lease(a.session.nodeId));
});

test('release requeues without failing, refunds the attempt and fences other nodes and stale leases', t => {
  const f = fixture(); t.after(() => f.store.close()); const a = f.enroll(); const b = f.enroll(); const job = f.submit();
  f.core.heartbeat(a.session.nodeId, heartbeat()); f.core.heartbeat(b.session.nodeId, heartbeat());
  const lease = f.core.lease(a.session.nodeId); assert(lease); assert.equal(lease.attempt, 1);
  assert.throws(() => f.core.release(b.session.nodeId, job.id, { leaseId: lease.leaseId, reason: 'PREEMPTED' }), code('LEASE_CONFLICT'));
  assert.throws(() => f.core.release(a.session.nodeId, job.id, { leaseId: lease.leaseId, reason: 'rm -rf' }));
  f.core.release(a.session.nodeId, job.id, { leaseId: lease.leaseId, reason: 'PREEMPTED' });
  assert.equal(f.core.getJob(f.app, job.id).status, 'QUEUED'); assert.equal(f.core.getJob(f.app, job.id).attempts, 0);
  assert.throws(() => f.core.release(a.session.nodeId, job.id, { leaseId: lease.leaseId, reason: 'PREEMPTED' }), code('LEASE_CONFLICT'));
  assert.throws(() => f.core.complete(a.session.nodeId, job.id, { leaseId: lease.leaseId, result: { message: 'hello' } }), code('LEASE_CONFLICT'));
  const again = f.core.lease(b.session.nodeId); assert(again); assert.equal(again.attempt, 1);
  f.advance(51); assert.throws(() => f.core.release(b.session.nodeId, job.id, { leaseId: again.leaseId, reason: 'DRAINING' }), code('LEASE_CONFLICT'));
});

test('releases are bounded so drain/preempt loops cannot keep a job alive forever', t => {
  const f = fixture(); t.after(() => f.store.close());
  const core = new Coordinator(f.store, { staleMs: 100, offlineMs: 500, leaseMs: 50, maxAttempts: 2, maxReleases: 2, sessionMs: 1000, challengeMs: 100 }, f.now);
  const a = f.enroll(); const job = f.submit(); core.heartbeat(a.session.nodeId, heartbeat());
  for (let i = 0; i < 3; i++) { const lease = core.lease(a.session.nodeId); assert(lease); core.release(a.session.nodeId, job.id, { leaseId: lease.leaseId, reason: 'PREEMPTED' }); }
  const final = core.getJob(f.app, job.id); assert.equal(final.status, 'FAILED'); assert.deepEqual(final.error, { code: 'RELEASE_LIMIT' });
});

test('goodbye returns leases without penalty and is OFFLINE_EXPECTED, not an unexplained loss', t => {
  const f = fixture(); t.after(() => f.store.close()); const a = f.enroll(); const job = f.submit();
  f.core.heartbeat(a.session.nodeId, heartbeat()); const lease = f.core.lease(a.session.nodeId); assert(lease);
  f.core.goodbye(a.session.nodeId, { reason: 'SHUTDOWN' });
  assert.equal(f.core.getJob(f.app, job.id).status, 'QUEUED'); assert.equal(f.core.getJob(f.app, job.id).attempts, 0);
  assert.equal(f.core.listNodes()[0]?.status, 'OFFLINE_EXPECTED'); f.advance(100000); assert.equal(f.core.listNodes()[0]?.status, 'OFFLINE_EXPECTED');
  assert.equal(f.core.lease(a.session.nodeId), null);
  assert.throws(() => f.core.goodbye(a.session.nodeId, { reason: 'crash' }));
  f.core.heartbeat(a.session.nodeId, heartbeat()); assert.equal(f.core.listNodes()[0]?.status, 'ONLINE');
  f.core.revokeNode(a.session.nodeId); assert.equal(f.core.listNodes()[0]?.status, 'REVOKED');
});

test('an application with a large backlog cannot starve another: the next job goes to the application with the fewest jobs running, oldest first within it', () => {
  const scheduler = new ResourceAwareScheduler();
  const node = { nodeId: 'node_x', capabilities: ['system.echo.v1'], allowedCapabilities: ['system.echo.v1'], jobSlots: 4, currentJobs: 0, lifecycle: 'ACTIVE', revoked: false } as never;
  const job = (id: string, applicationId: string, createdAt: number, over: Record<string, unknown> = {}) => ({ id, applicationId, type: 'system.echo.v1', status: 'QUEUED', createdAt, assignedNodeId: null, ...over }) as never;
  const backlog = Array.from({ length: 200 }, (_, i) => job(`a${i}`, 'app-a', i));
  const small = job('b0', 'app-b', 1000); // submitted long after the whole backlog
  assert.equal(scheduler.choose(node, [...backlog, small])?.id, 'a0', 'nothing is running: oldest first, as before');
  const running = [job('r1', 'app-a', 0, { status: 'LEASED', assignedNodeId: 'other' }), job('r2', 'app-a', 0, { status: 'LEASED', assignedNodeId: 'other' })];
  assert.equal(scheduler.choose(node, [...running, ...backlog, small])?.id, 'b0', 'app-a already has two jobs running and app-b none: app-b goes next, not after 200 older jobs');
  assert.equal(scheduler.choose(node, [...running, ...backlog])?.id, 'a0', 'a single application is served oldest first');
  const both = [job('r3', 'app-b', 0, { status: 'LEASED', assignedNodeId: 'other' }), job('r4', 'app-b', 0, { status: 'LEASED', assignedNodeId: 'other' }), job('r5', 'app-b', 0, { status: 'LEASED', assignedNodeId: 'other' })];
  assert.equal(scheduler.choose(node, [...running, ...both, ...backlog, small])?.id, 'a0', 'when the other application is ahead, this one is served');
});
