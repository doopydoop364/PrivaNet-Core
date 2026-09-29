import { z } from 'zod';
import { CapabilitiesSchema } from '@privanet/protocol';
const interval = (fallback: number) => z.coerce.number().int().min(1).max(60000).default(fallback);
const schema = z.object({
  PRIVANODE_COORDINATOR_URL: z.string().default('http://127.0.0.1:4010'),
  PRIVANODE_ALLOW_INSECURE_LOOPBACK: z.enum(['true', 'false']).default('false'),
  PRIVANODE_STATE_DIR: z.string().min(1).default('./var/node'),
  PRIVANODE_CAPABILITIES: z.string().default(''),
  PRIVANODE_ENROLLMENT_TOKEN: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  PRIVANODE_HEARTBEAT_MS: interval(5000), PRIVANODE_POLL_MS: interval(1000),
});
export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const c = schema.parse(env);
  const capabilities = CapabilitiesSchema.parse(c.PRIVANODE_CAPABILITIES === '' ? [] : c.PRIVANODE_CAPABILITIES.split(','));
  return { url: c.PRIVANODE_COORDINATOR_URL, allowInsecureLoopback: c.PRIVANODE_ALLOW_INSECURE_LOOPBACK === 'true',
    stateDir: c.PRIVANODE_STATE_DIR, capabilities, heartbeatMs: c.PRIVANODE_HEARTBEAT_MS, pollMs: c.PRIVANODE_POLL_MS,
    ...(c.PRIVANODE_ENROLLMENT_TOKEN ? { enrollmentToken: c.PRIVANODE_ENROLLMENT_TOKEN } : {}) };
}
