import { z } from 'zod';
const positive = (fallback: number, max = 86400000) => z.coerce.number().int().min(1).max(max).default(fallback);
const boolean = z.enum(['true', 'false']).default('false').transform(value => value === 'true');
const schema = z.object({
  PRIVANET_ADMIN_SECRET: z.string().regex(/^[a-f0-9]{64}$/),
  PRIVANET_HOST: z.string().default('127.0.0.1'), PRIVANET_PORT: positive(4010, 65535),
  PRIVANET_DATA_DIR: z.string().min(1).default('./var/coordinator'),
  PRIVANET_STALE_MS: positive(15000), PRIVANET_OFFLINE_MS: positive(60000),
  PRIVANET_LEASE_MS: positive(10000), PRIVANET_MAX_ATTEMPTS: positive(3, 100),
  PRIVANET_SESSION_MS: positive(300000), PRIVANET_MAINTENANCE_MS: positive(1000, 60000),
  PRIVANET_TLS_TERMINATED: boolean,
});
export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const c = schema.parse(env);
  if (!['127.0.0.1', '::1'].includes(c.PRIVANET_HOST) && !c.PRIVANET_TLS_TERMINATED) throw new Error('Non-loopback bind requires explicit TLS termination');
  return { adminSecret: c.PRIVANET_ADMIN_SECRET, host: c.PRIVANET_HOST, port: c.PRIVANET_PORT,
    dataDir: c.PRIVANET_DATA_DIR, maintenanceMs: c.PRIVANET_MAINTENANCE_MS,
    policy: { staleMs: c.PRIVANET_STALE_MS, offlineMs: c.PRIVANET_OFFLINE_MS, leaseMs: c.PRIVANET_LEASE_MS,
      maxAttempts: c.PRIVANET_MAX_ATTEMPTS, sessionMs: c.PRIVANET_SESSION_MS } };
}
