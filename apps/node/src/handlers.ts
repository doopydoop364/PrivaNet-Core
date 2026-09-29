import { createHash } from 'node:crypto';
import { setImmediate as yieldToLoop } from 'node:timers/promises';
import { z } from 'zod';
import { JOB_TYPES } from '@privanet/protocol';
import type { JobInputMap, JobOutputMap, JobType, Lease } from '@privanet/protocol';
import type { Checkpoint } from './checkpoint.js';
/**
 * `signal` aborts when the node must hand the job back (preemption or shutdown). Long handlers must honour it.
 * `checkpoint` exists only for job types registered `checkpointable`. `transfer` must be awaited before a
 * handler moves data over the network: it enforces the owner's bandwidth limit and monthly allowance.
 */
export interface HandlerContext { signal: AbortSignal; checkpoint?: Checkpoint; transfer?: (bytes: number) => Promise<void> }
export type Handlers = { [T in JobType]: (input: JobInputMap[T], context: HandlerContext) => JobOutputMap[T] | Promise<JobOutputMap[T]> };

const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest();
const ResumeSchema = z.strictObject({ seed: z.string(), iterations: z.number().int(), done: z.number().int().min(0), hash: z.string().regex(/^[a-f0-9]{64}$/) });
// Small slices keep the event loop responsive on slow machines, so lease renewals and heartbeats are never starved.
const SLICE = 5_000; const SAVE_EVERY_MS = 200;
/** h0 = sha256(seed); h(i+1) = sha256(h(i)); the digest is h(iterations). Slices yield to the event loop, checkpoint and honour `signal`. */
async function hashChain(input: JobInputMap['system.hashchain.v1'], { signal, checkpoint }: HandlerContext): Promise<JobOutputMap['system.hashchain.v1']> {
  let done = 0; let hash = sha256(input.seed);
  const saved = ResumeSchema.safeParse(checkpoint?.load());
  // Resume only from a checkpoint for exactly this input; anything else is ignored and the job restarts.
  if (saved.success && saved.data.seed === input.seed && saved.data.iterations === input.iterations && saved.data.done <= input.iterations) { done = saved.data.done; hash = Buffer.from(saved.data.hash, 'hex'); }
  const save = () => { try { checkpoint?.save({ seed: input.seed, iterations: input.iterations, done, hash: hash.toString('hex') }); } catch { /* checkpointing is best effort */ } };
  let savedAt = Date.now();
  while (done < input.iterations) {
    if (signal.aborted) { save(); throw signal.reason ?? new Error('Aborted'); }
    for (const end = Math.min(input.iterations, done + SLICE); done < end; done++) hash = sha256(hash);
    if (Date.now() - savedAt >= SAVE_EVERY_MS) { save(); savedAt = Date.now(); }
    await yieldToLoop();
  }
  return { digest: hash.toString('hex'), iterations: input.iterations };
}
// Installed local code only: neither the protocol nor Coordinator supplies code.
export const defaultHandlers: Handlers = {
  'system.echo.v1': input => ({ message: input.message }),
  'system.hashchain.v1': hashChain,
};
export interface HandlerServices { checkpoint?: Checkpoint; transfer?: (bytes: number) => Promise<void> }
export async function executeLease(lease: Lease, enabled: readonly JobType[], signal: AbortSignal = new AbortController().signal, handlers: Handlers = defaultHandlers, services: HandlerServices = {}) {
  if (!enabled.includes(lease.type)) throw new Error('Capability disabled');
  const definition = JOB_TYPES[lease.type];
  const input = definition.input.parse(lease.input);
  const context: HandlerContext = { signal, ...(services.checkpoint && definition.resources.checkpointable ? { checkpoint: services.checkpoint } : {}), ...(services.transfer ? { transfer: services.transfer } : {}) };
  return definition.output.parse(await (handlers[lease.type] as (input: unknown, context: HandlerContext) => unknown)(input, context));
}
/** Job types this build can execute; used to keep the registry and handlers in lockstep. */
export function registeredHandlerTypes(): JobType[] { return Object.keys(defaultHandlers) as JobType[]; }
