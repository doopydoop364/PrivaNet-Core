import { JOB_TYPES } from '@privanet/protocol';
import type { JobInputMap, JobOutputMap, JobType, Lease } from '@privanet/protocol';
// Installed local code only: neither the protocol nor Coordinator supplies code.
const handlers: { [T in JobType]: (input: JobInputMap[T]) => JobOutputMap[T] } = {
  'system.echo.v1': input => ({ message: input.message }),
};
export function executeLease(lease: Lease, enabled: readonly JobType[]) {
  if (!enabled.includes(lease.type)) throw new Error('Capability disabled');
  const definition = JOB_TYPES[lease.type];
  const input = definition.input.parse(lease.input);
  return definition.output.parse(handlers[lease.type](input));
}
/** Job types this build can execute; used to keep the registry and handlers in lockstep. */
export function registeredHandlerTypes(): JobType[] { return Object.keys(handlers) as JobType[]; }
