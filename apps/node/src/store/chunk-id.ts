import { join } from 'node:path';
import { StoreError } from './errors.js';

/**
 * A chunk's identity: `chk_` followed by the 64 lowercase hexadecimal characters of the SHA-256 of the exact stored bytes. Nothing else names a chunk, and **a path is only ever
 * built from an identifier that has passed this check** (`chunkPath`): no other string from any caller can reach the filesystem. Lowercase only, exact length, no whitespace,
 * no trailing characters, no separators: anything else is refused before a single filesystem call.
 */
const CHUNK_ID = /^chk_([0-9a-f]{64})$/;
export const CHUNK_ID_PREFIX = 'chk_';
export const isChunkId = (value: unknown): value is string => typeof value === 'string' && value.length === 68 && CHUNK_ID.test(value);
/** The 64-hex digest of a valid chunk identifier; throws `INVALID_ID` for anything else. */
export function chunkDigest(id: unknown): string {
  if (!isChunkId(id)) throw new StoreError('INVALID_ID');
  return id.slice(CHUNK_ID_PREFIX.length);
}
export const chunkIdOf = (digestHex: string): string => `${CHUNK_ID_PREFIX}${digestHex}`;
/** `<chunks>/<aa>/<bb>/<64-hex>`: two shard levels keep any one directory small. The only way to turn an identifier into a path. */
export function applicationChunksDir(chunksDir: string, applicationId?: string): string {
  if (applicationId === undefined) return chunksDir;
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(applicationId)) throw new StoreError('INVALID_ID');
  return join(chunksDir, `app_${applicationId}`);
}
export function chunkPath(chunksDir: string, id: unknown, applicationId?: string): string {
  const hex = chunkDigest(id);
  return join(applicationChunksDir(chunksDir, applicationId), hex.slice(0, 2), hex.slice(2, 4), hex);
}
/** The names a committed-chunk file and its two shard directories may have. */
export const isDigestName = (name: string): boolean => /^[0-9a-f]{64}$/.test(name);
export const isShardName = (name: string): boolean => /^[0-9a-f]{2}$/.test(name);
