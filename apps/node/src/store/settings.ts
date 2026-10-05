import { ResourcePolicySchema } from '../resource-policy.js';
import type { ResourcePolicy } from '../resource-policy.js';
import { PolicyError } from '../policy-store.js';
import { TRANSFER_ENV, transferConfig, TransferConfigError } from './transfer-config.js';
import { storageFinding } from './diagnostics.js';
/** Exact integer bytes, including decimal fractions only if they result in whole bytes. No floating point rounding. */
export function parseStorageSize(text: string): number {
  const match = /^(0|[1-9][0-9]{0,15})(?:\.([0-9]{1,9}))?(B|KiB|MiB|GiB|TiB)?$/i.exec(text);
  if (!match) throw new PolicyError('POLICY_FILE_INVALID', ['storage size: use bytes or KiB/MiB/GiB/TiB']);
  const units: Record<string, bigint> = { b: 1n, kib: 1024n, mib: 1024n ** 2n, gib: 1024n ** 3n, tib: 1024n ** 4n };
  const fraction = match[2] ?? ''; const denominator = 10n ** BigInt(fraction.length);
  const scaled = BigInt(match[1]! + fraction) * units[(match[3] ?? 'B').toLowerCase()]!;
  if (scaled % denominator !== 0n || scaled / denominator > 2n ** 40n) throw new PolicyError('POLICY_FILE_INVALID', ['storage size: whole bytes from 0 through 1 TiB']);
  return Number(scaled / denominator);
}
export type StorageEdit = { setting: 'enabled' | 'maxBytes' | 'reserveFreeBytes' | 'transfer.enabled' | 'transfer.endpoint' | 'transfer.bindAddress' | 'transfer.port'; value: string; allowReserveReduction?: boolean };
export function editStoragePolicy(policy: ResourcePolicy, edit: StorageEdit, env: NodeJS.ProcessEnv): ResourcePolicy {
  if (env.PRIVANODE_POLICY_LOCKED === 'true') throw new PolicyError('POLICY_LOCKED_BY_ENVIRONMENT');
  const next = structuredClone(policy); const setting = edit.setting;
  if (setting.startsWith('transfer.')) {
    const key = setting.slice(9) as keyof typeof TRANSFER_ENV;
    if (env[TRANSFER_ENV[key]] !== undefined) throw new PolicyError('POLICY_LOCKED_BY_ENVIRONMENT', [TRANSFER_ENV[key]]);
    if (key === 'enabled') { if (!['true', 'false'].includes(edit.value)) throw new PolicyError('POLICY_FILE_INVALID'); next.storage.transfer.enabled = edit.value === 'true'; }
    else if (key === 'port') next.storage.transfer.port = Number(edit.value);
    else Object.assign(next.storage.transfer, { [key]: edit.value });
  } else if (setting === 'enabled') { if (!['true', 'false'].includes(edit.value)) throw new PolicyError('POLICY_FILE_INVALID'); next.storage.enabled = edit.value === 'true'; }
  else {
    const size = parseStorageSize(edit.value);
    if (setting === 'reserveFreeBytes' && size < policy.storage.reserveFreeBytes && !edit.allowReserveReduction) throw new PolicyError('POLICY_FILE_INVALID', ['Reducing the owner reserve requires --allow-reserve-reduction (or explicit panel confirmation).']);
    next.storage[setting as 'maxBytes' | 'reserveFreeBytes'] = size;
  }
  const parsed = ResourcePolicySchema.safeParse(next);
  if (!parsed.success) throw new PolicyError('POLICY_FILE_INVALID', parsed.error.issues.map(issue => `Invalid setting ${issue.path.join('.')}; use a value within its documented limits.`));
  const checked = parsed.data;
  if (!((setting === 'enabled' || setting === 'transfer.enabled') && edit.value === 'false')) {
    try { transferConfig(checked, env); } catch (error) { if (error instanceof TransferConfigError) throw new PolicyError('POLICY_FILE_INVALID', [`${error.code}: ${storageFinding(error.code).message}`]); throw error; }
  }
  return checked;
}
