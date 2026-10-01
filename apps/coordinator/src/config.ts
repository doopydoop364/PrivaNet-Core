import { z } from 'zod';
const positive = (fallback: number, max = 86400000) => z.coerce.number().int().min(1).max(max).default(fallback);
const boolean = z.enum(['true', 'false']).default('false').transform(value => value === 'true');
const schema = z.object({
  PRIVANET_ADMIN_SECRET: z.string().regex(/^[a-f0-9]{64}$/),
  PRIVANET_HOST: z.string().default('127.0.0.1'), PRIVANET_PORT: positive(4010, 65535),
  PRIVANET_DATA_DIR: z.string().min(1).default('./var/coordinator'),
  PRIVANET_STALE_MS: positive(15000), PRIVANET_OFFLINE_MS: positive(60000),
  PRIVANET_LEASE_MS: positive(10000), PRIVANET_MAX_ATTEMPTS: positive(3, 100), PRIVANET_MAX_RELEASES: positive(20, 1000),
  PRIVANET_SESSION_MS: positive(300000), PRIVANET_MAINTENANCE_MS: positive(1000, 60000),
  PRIVANET_RETENTION_MS: z.coerce.number().int().min(0).max(3650 * 86400000).default(30 * 86400000),
  PRIVANET_MAX_PENDING_PER_APP: positive(10000, 1000000),
  PRIVANET_MAX_LEASE_MS: positive(3600000, 86400000),
  PRIVANET_AUTH_REQUESTS_PER_MINUTE: positive(120, 1000000),
  PRIVANET_TLS_TERMINATED: boolean, PRIVANET_TRUST_LOOPBACK_PROXY: boolean,
});
export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const c = schema.parse(env);
  if (!['127.0.0.1', '::1'].includes(c.PRIVANET_HOST) && !c.PRIVANET_TLS_TERMINATED) throw new Error('Non-loopback bind requires explicit TLS termination');
  return { adminSecret: c.PRIVANET_ADMIN_SECRET, host: c.PRIVANET_HOST, port: c.PRIVANET_PORT,
    dataDir: c.PRIVANET_DATA_DIR, maintenanceMs: c.PRIVANET_MAINTENANCE_MS, authRequestsPerMinute: c.PRIVANET_AUTH_REQUESTS_PER_MINUTE, trustLoopbackProxy: c.PRIVANET_TRUST_LOOPBACK_PROXY,
    policy: { staleMs: c.PRIVANET_STALE_MS, offlineMs: c.PRIVANET_OFFLINE_MS, leaseMs: c.PRIVANET_LEASE_MS,
      maxAttempts: c.PRIVANET_MAX_ATTEMPTS, maxReleases: c.PRIVANET_MAX_RELEASES, sessionMs: c.PRIVANET_SESSION_MS,
      retentionMs: c.PRIVANET_RETENTION_MS, maxLeaseMs: c.PRIVANET_MAX_LEASE_MS, maxPendingPerApplication: c.PRIVANET_MAX_PENDING_PER_APP } };
}
