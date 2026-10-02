import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { CapabilitiesSchema } from '@privanet/protocol';
import { Transport } from '@privanet/shared';
import { ResourcePolicySchema } from './resource-policy.js';
import { readEnrollmentRecordSync } from './enrollment-record.js';
import type { ResourcePolicy } from './resource-policy.js';
const interval = (fallback: number) => z.coerce.number().int().min(1).max(60000).default(fallback);
const schema = z.object({
  PRIVANODE_COORDINATOR_URL: z.string().default('http://127.0.0.1:4010'),
  PRIVANODE_ALLOW_INSECURE_LOOPBACK: z.enum(['true', 'false']).default('false'),
  PRIVANODE_STATE_DIR: z.string().min(1).default('./var/node'),
  PRIVANODE_CAPABILITIES: z.string().default(''),
  PRIVANODE_ENROLLMENT_TOKEN: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  PRIVANODE_POLICY_FILE: z.string().min(1).optional(),
  // true: the policy file is authoritative, so a policy saved from the panel or the CLI is ignored and cannot be changed there.
  PRIVANODE_POLICY_LOCKED: z.enum(['true', 'false']).default('false'),
  PRIVANODE_DRAIN_TIMEOUT_MS: z.coerce.number().int().min(0).max(600000).default(30000),
  PRIVANODE_HEARTBEAT_MS: interval(5000), PRIVANODE_POLL_MS: interval(1000),
  // How long an idle poll may wait at the Coordinator for work (0 = plain polling). Falls back to plain polling against a Coordinator that does not support it.
  // Concurrent jobs this node runs (1 to 64). Each running job is still counted against the owner's memory, CPU, disk and network limits.
  PRIVANODE_JOB_SLOTS: z.coerce.number().int().min(1).max(64).default(1),
  PRIVANODE_LEASE_WAIT_MS: z.coerce.number().int().min(0).max(8000).default(5000),
}).superRefine((c, ctx) => {
  // An address the transport would refuse (plain http off loopback, a path, credentials, no scheme) is a configuration error reported by NAME (exit status 78, no
  // restart loop), not an unexplained `node.startup_failed` that a service manager restarts. The address is never echoed: it may carry credentials.
  try { new Transport({ url: c.PRIVANODE_COORDINATOR_URL, allowInsecureLoopback: c.PRIVANODE_ALLOW_INSECURE_LOOPBACK === 'true' }); }
  catch { ctx.addIssue({ code: 'custom', path: ['PRIVANODE_COORDINATOR_URL'], message: 'not an acceptable Coordinator address (https://host, or literal loopback http with PRIVANODE_ALLOW_INSECURE_LOOPBACK=true)' }); }
});
/** Reads the owner's resource policy (strict JSON); missing file path means conservative defaults. */
export function loadResourcePolicy(path: string | undefined): ResourcePolicy {
  return ResourcePolicySchema.parse(path === undefined ? {} : JSON.parse(readFileSync(path, 'utf8')));
}
export function loadConfig(rawEnv: NodeJS.ProcessEnv = process.env) {
  // A node enrolled with `privanet-node enroll` remembers its Coordinator and capabilities in its state directory; anything set explicitly in the environment wins,
  // and a node that was never enrolled that way (no enrollment.json) is configured exactly as before.
  const enrolled = rawEnv.PRIVANODE_COORDINATOR_URL === undefined || rawEnv.PRIVANODE_CAPABILITIES === undefined ? readEnrollmentRecordSync(rawEnv.PRIVANODE_STATE_DIR ?? './var/node') : undefined;
  const env: NodeJS.ProcessEnv = { ...rawEnv,
    ...(enrolled && rawEnv.PRIVANODE_COORDINATOR_URL === undefined ? { PRIVANODE_COORDINATOR_URL: enrolled.coordinatorUrl } : {}),
    ...(enrolled && rawEnv.PRIVANODE_CAPABILITIES === undefined ? { PRIVANODE_CAPABILITIES: enrolled.capabilities.join(',') } : {}) };
  const c = schema.parse(env);
  const capabilities = CapabilitiesSchema.parse(c.PRIVANODE_CAPABILITIES === '' ? [] : c.PRIVANODE_CAPABILITIES.split(','));
  return { url: c.PRIVANODE_COORDINATOR_URL, allowInsecureLoopback: c.PRIVANODE_ALLOW_INSECURE_LOOPBACK === 'true',
    stateDir: c.PRIVANODE_STATE_DIR, policy: loadResourcePolicy(c.PRIVANODE_POLICY_FILE), drainTimeoutMs: c.PRIVANODE_DRAIN_TIMEOUT_MS, capabilities, heartbeatMs: c.PRIVANODE_HEARTBEAT_MS, pollMs: c.PRIVANODE_POLL_MS, leaseWaitMs: c.PRIVANODE_LEASE_WAIT_MS, jobSlots: c.PRIVANODE_JOB_SLOTS,
    ...(c.PRIVANODE_ENROLLMENT_TOKEN ? { enrollmentToken: c.PRIVANODE_ENROLLMENT_TOKEN } : {}) };
}
