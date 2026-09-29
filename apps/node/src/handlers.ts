import { JOB_TYPES } from '@privanet/protocol';
import type { JobInputMap, JobOutputMap, JobType, Lease } from '@privanet/protocol';
/** `signal` aborts when the node must hand the job back (preemption or shutdown). Long handlers must honour it. */
export interface HandlerContext { signal: AbortSignal }
export type Handlers = { [T in JobType]: (input: JobInputMap[T], context: HandlerContext) => JobOutputMap[T] | Promise<JobOutputMap[T]> };
// Installed local code only: neither the protocol nor Coordinator supplies code.
export const defaultHandlers: Handlers = {
  'system.echo.v1': input => ({ message: input.message }),
};
export async function executeLease(lease: Lease, enabled: readonly JobType[], signal: AbortSignal = new AbortController().signal, handlers: Handlers = defaultHandlers) {
  if (!enabled.includes(lease.type)) throw new Error('Capability disabled');
  const definition = JOB_TYPES[lease.type];
  const input = definition.input.parse(lease.input);
  return definition.output.parse(await handlers[lease.type](input, { signal }));
}
/** Job types this build can execute; used to keep the registry and handlers in lockstep. */
export function registeredHandlerTypes(): JobType[] { return Object.keys(defaultHandlers) as JobType[]; }
