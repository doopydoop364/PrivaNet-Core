import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { CapabilitiesSchema } from '@privanet/protocol';
import { ResourcePolicySchema } from './resource-policy.js';
import type { ResourcePolicy } from './resource-policy.js';
const interval = (fallback: number) => z.coerce.number().int().min(1).max(60000).default(fallback);
const schema = z.object({
  PRIVANODE_COORDINATOR_URL: z.string().default('http://127.0.0.1:4010'),
  PRIVANODE_ALLOW_INSECURE_LOOPBACK: z.enum(['true', 'false']).default('false'),
  PRIVANODE_STATE_DIR: z.string().min(1).default('./var/node'),
  PRIVANODE_CAPABILITIES: z.string().default(''),
  PRIVANODE_ENROLLMENT_TOKEN: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  PRIVANODE_POLICY_FILE: z.string().min(1).optional(),
  PRIVANODE_DRAIN_TIMEOUT_MS: z.coerce.number().int().min(0).max(600000).default(30000),
  PRIVANODE_HEARTBEAT_MS: interval(5000), PRIVANODE_POLL_MS: interval(1000),
});
/** Reads the owner's resource policy (strict JSON); missing file path means conservative defaults. */
export function loadResourcePolicy(path: string | undefined): ResourcePolicy {
  return ResourcePolicySchema.parse(path === undefined ? {} : JSON.parse(readFileSync(path, 'utf8')));
}
export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const c = schema.parse(env);
  const capabilities = CapabilitiesSchema.parse(c.PRIVANODE_CAPABILITIES === '' ? [] : c.PRIVANODE_CAPABILITIES.split(','));
  return { url: c.PRIVANODE_COORDINATOR_URL, allowInsecureLoopback: c.PRIVANODE_ALLOW_INSECURE_LOOPBACK === 'true',
    stateDir: c.PRIVANODE_STATE_DIR, policy: loadResourcePolicy(c.PRIVANODE_POLICY_FILE), drainTimeoutMs: c.PRIVANODE_DRAIN_TIMEOUT_MS, capabilities, heartbeatMs: c.PRIVANODE_HEARTBEAT_MS, pollMs: c.PRIVANODE_POLL_MS,
    ...(c.PRIVANODE_ENROLLMENT_TOKEN ? { enrollmentToken: c.PRIVANODE_ENROLLMENT_TOKEN } : {}) };
}
