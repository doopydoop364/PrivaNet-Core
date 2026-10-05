import { isIP } from 'node:net';
import { TransferEndpointSchema } from '@privanet/protocol';
import { ResourcePolicySchema } from '../resource-policy.js';
import type { ResourcePolicy } from '../resource-policy.js';
export const TRANSFER_ENV = {
  enabled: 'PRIVANODE_TRANSFER_ENABLED', bindAddress: 'PRIVANODE_TRANSFER_BIND', port: 'PRIVANODE_TRANSFER_PORT', endpoint: 'PRIVANODE_TRANSFER_ENDPOINT',
  certificateFile: 'PRIVANODE_TRANSFER_CERT_FILE', keyFile: 'PRIVANODE_TRANSFER_KEY_FILE', maxConcurrent: 'PRIVANODE_TRANSFER_CONCURRENCY', maxConcurrentPuts: 'PRIVANODE_TRANSFER_PUTS',
} as const;
export class TransferConfigError extends Error { constructor(readonly code: string) { super(code); } }
/** Invalid origins may contain credentials or query secrets; never echo them in status/settings. */
export function reportedTransferEndpoint(value: string): string { return !value || TransferEndpointSchema.shape.url.safeParse(value).success ? value : '[INVALID_ENDPOINT]'; }
export function transferConfig(policy: ResourcePolicy, env: NodeJS.ProcessEnv = {}): ResourcePolicy['storage']['transfer'] {
  const value = { ...policy.storage.transfer };
  for (const [key, name] of Object.entries(TRANSFER_ENV)) {
    const setting = env[name]; if (setting === undefined) continue;
    if (key === 'enabled') { if (!['true', 'false'].includes(setting)) throw new TransferConfigError('TRANSFER_CONFIG_INVALID'); value.enabled = setting === 'true'; }
    else if (['port', 'maxConcurrent', 'maxConcurrentPuts'].includes(key)) Object.assign(value, { [key]: Number(setting) });
    else Object.assign(value, { [key]: setting });
  }
  const parsed = ResourcePolicySchema.safeParse({ storage: { transfer: value } });
  if (!parsed.success) throw new TransferConfigError('TRANSFER_CONFIG_INVALID');
  const result = parsed.data.storage.transfer;
  if (!isIP(result.bindAddress)) throw new TransferConfigError('TRANSFER_BIND_INVALID');
  if (result.maxConcurrentPuts > result.maxConcurrent) throw new TransferConfigError('TRANSFER_CONFIG_INVALID');
  if (result.endpoint) {
    let url: URL; try { url = new URL(result.endpoint); } catch { throw new TransferConfigError('TRANSFER_ENDPOINT_INVALID'); }
    if (url.protocol !== 'https:' || url.origin !== result.endpoint || url.username || url.password || url.search || url.hash || /[\\\s%]/.test(result.endpoint)) throw new TransferConfigError('TRANSFER_ENDPOINT_INVALID');
  }
  if (result.enabled && !result.endpoint) throw new TransferConfigError('TRANSFER_ENDPOINT_MISSING');
  if (result.enabled && !result.certificateFile) throw new TransferConfigError('TRANSFER_CERT_MISSING');
  if (result.enabled && !result.keyFile) throw new TransferConfigError('TRANSFER_KEY_MISSING');
  return result;
}
