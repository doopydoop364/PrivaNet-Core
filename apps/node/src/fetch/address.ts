import { isIP } from 'node:net';

/**
 * Decides whether a resolved IP address may be connected to. The default is deny: IPv4 must not fall in any
 * special-use range, and IPv6 must be global unicast (2000::/3) outside the special ranges. IPv4-mapped,
 * NAT64 and 6to4 addresses are classified by the IPv4 address they embed, so they cannot smuggle a private
 * target past the check. Only an owner-local CIDR list (never a job, the Coordinator or the environment)
 * can relax this.
 */
export interface Cidr { family: 4 | 6; base: bigint; bits: number }
const V4_DENY = ['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24', '192.0.2.0/24',
  '192.88.99.0/24', '192.168.0.0/16', '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24', '224.0.0.0/4', '240.0.0.0/4'];
const V6_DENY = ['2001::/23', '2001:db8::/32', '3fff::/20', '64:ff9b:1::/48', '100::/64'];

export function parseIpv4(text: string): bigint | undefined {
  const parts = text.split('.'); if (parts.length !== 4) return undefined;
  let value = 0n;
  for (const part of parts) { if (!/^\d{1,3}$/.test(part)) return undefined; const n = Number(part); if (n > 255) return undefined; value = (value << 8n) | BigInt(n); }
  return value;
}
export function parseIpv6(text: string): bigint | undefined {
  let address = text; const zone = address.indexOf('%'); if (zone >= 0) return undefined; // zone IDs are never valid targets
  // A trailing dotted quad (::ffff:1.2.3.4) becomes two hex groups.
  const dotted = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address);
  if (dotted) { const v4 = parseIpv4(dotted[2] ?? ''); if (v4 === undefined) return undefined; address = `${dotted[1] ?? ''}${(v4 >> 16n).toString(16)}:${(v4 & 0xffffn).toString(16)}`; }
  const halves = address.split('::'); if (halves.length > 2) return undefined;
  const head = halves[0] ? halves[0].split(':') : []; const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = 8 - head.length - tail.length; if (halves.length === 2 ? fill < 1 : fill !== 0) return undefined;
  const groups = [...head, ...Array<string>(halves.length === 2 ? fill : 0).fill('0'), ...tail]; if (groups.length !== 8) return undefined;
  let value = 0n;
  for (const group of groups) { if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return undefined; value = (value << 16n) | BigInt(parseInt(group, 16)); }
  return value;
}
export function parseCidr(text: string): Cidr | undefined {
  const [address, bitsText, extra] = text.split('/'); if (!address || extra !== undefined) return undefined;
  const family = isIP(address); if (family !== 4 && family !== 6) return undefined;
  const base = family === 4 ? parseIpv4(address) : parseIpv6(address); if (base === undefined) return undefined;
  const max = family === 4 ? 32 : 128; const bits = bitsText === undefined ? max : Number(bitsText);
  if (!Number.isInteger(bits) || bits < 0 || bits > max || (bitsText !== undefined && !/^\d+$/.test(bitsText))) return undefined;
  return { family, base, bits };
}
const within = (value: bigint, cidr: Cidr): boolean => { const total = cidr.family === 4 ? 32 : 128; const shift = BigInt(total - cidr.bits); return (value >> shift) === (cidr.base >> shift); };
const v4Deny = V4_DENY.map(entry => parseCidr(entry) as Cidr); const v6Deny = V6_DENY.map(entry => parseCidr(entry) as Cidr);

export interface Verdict { allowed: boolean; reason?: 'PRIVATE_OR_RESERVED' | 'INVALID' }
/** Classifies one address; `allowedCidrs` is the owner-local exception list (empty in normal operation). */
export function classifyAddress(ip: string, allowedCidrs: readonly Cidr[] = []): Verdict {
  const family = isIP(ip);
  if (family === 4) {
    const value = parseIpv4(ip); if (value === undefined) return { allowed: false, reason: 'INVALID' };
    if (allowedCidrs.some(cidr => cidr.family === 4 && within(value, cidr))) return { allowed: true };
    return v4Deny.some(cidr => within(value, cidr)) ? { allowed: false, reason: 'PRIVATE_OR_RESERVED' } : { allowed: true };
  }
  if (family === 6) {
    const value = parseIpv6(ip); if (value === undefined) return { allowed: false, reason: 'INVALID' };
    if (allowedCidrs.some(cidr => cidr.family === 6 && within(value, cidr))) return { allowed: true };
    const embedded = (v4: bigint): Verdict => classifyAddress(`${(v4 >> 24n) & 255n}.${(v4 >> 16n) & 255n}.${(v4 >> 8n) & 255n}.${v4 & 255n}`, allowedCidrs);
    if ((value >> 32n) === 0xffffn) return embedded(value & 0xffffffffn);                    // ::ffff:0:0/96 IPv4-mapped
    if ((value >> 32n) === 0x0064ff9b0000000000000000n) return embedded(value & 0xffffffffn); // 64:ff9b::/96 NAT64
    if ((value >> 112n) === 0x2002n) return embedded((value >> 80n) & 0xffffffffn);         // 2002::/16 6to4
    if ((value >> 125n) !== 1n) return { allowed: false, reason: 'PRIVATE_OR_RESERVED' };     // everything outside global unicast 2000::/3
    return v6Deny.some(cidr => within(value, cidr)) ? { allowed: false, reason: 'PRIVATE_OR_RESERVED' } : { allowed: true };
  }
  return { allowed: false, reason: 'INVALID' };
}
