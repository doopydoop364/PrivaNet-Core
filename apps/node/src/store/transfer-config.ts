import { isIP } from 'node:net';
import { ResourcePolicySchema } from '../resource-policy.js';
import type { ResourcePolicy } from '../resource-policy.js';
export const TRANSFER_ENV = {
  enabled: 'PRIVANODE_TRANSFER_ENABLED', bindAddress: 'PRIVANODE_TRANSFER_BIND', port: 'PRIVANODE_TRANSFER_PORT', endpoint: 'PRIVANODE_TRANSFER_ENDPOINT',
  certificateFile: 'PRIVANODE_TRANSFER_CERT_FILE', keyFile: 'PRIVANODE_TRANSFER_KEY_FILE', maxConcurrent: 'PRIVANODE_TRANSFER_CONCURRENCY', maxConcurrentPuts: 'PRIVANODE_TRANSFER_PUTS',
} as const;
export function transferConfig(policy: ResourcePolicy, env: NodeJS.ProcessEnv = {}): ResourcePolicy['storage']['transfer'] {
  const value = { ...policy.storage.transfer };
  for (const [key, name] of Object.entries(TRANSFER_ENV)) {
    const setting = env[name]; if (setting === undefined) continue;
    if (key === 'enabled') { if (!['true', 'false'].includes(setting)) throw new Error('TRANSFER_CONFIG'); value.enabled = setting === 'true'; }
    else if (['port', 'maxConcurrent', 'maxConcurrentPuts'].includes(key)) Object.assign(value, { [key]: Number(setting) });
    else Object.assign(value, { [key]: setting });
  }
  const result = ResourcePolicySchema.parse({ storage: { transfer: value } }).storage.transfer;
  if (!isIP(result.bindAddress) || result.maxConcurrentPuts > result.maxConcurrent) throw new Error('TRANSFER_CONFIG');
  if (result.endpoint) {
    const url = new URL(result.endpoint);
    if (url.protocol !== 'https:' || url.origin !== result.endpoint || url.username || url.password || url.search || url.hash || /[\\\s%]/.test(result.endpoint)) throw new Error('TRANSFER_CONFIG');
  }
  if (result.enabled && (!result.endpoint || !result.certificateFile || !result.keyFile)) throw new Error('TRANSFER_CONFIG');
  return result;
}
