import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { CHUNK_ID_PREFIX, chunkDigest, chunkIdOf, chunkPath, isChunkId } from '@privanet/node/store/chunk-id';
import { isStoreError } from '@privanet/node/store/errors';

const hex = createHash('sha256').update('x').digest('hex'); const id = chunkIdOf(hex);

test('a chunk ID is chk_ and exactly 64 lowercase hex characters, and nothing else is accepted', () => {
  assert.equal(isChunkId(id), true); assert.equal(CHUNK_ID_PREFIX, 'chk_'); assert.equal(chunkDigest(id), hex);
  const bad: unknown[] = [
    '../../etc/passwd', '/etc/passwd', 'C:\\Windows\\System32', `chk_..\\..\\${'a'.repeat(50)}`, `chk_${'a'.repeat(30)}/${'a'.repeat(33)}`, `chk_${'a'.repeat(30)}\\${'a'.repeat(33)}`,
    `chk_%2e%2e%2f${'a'.repeat(52)}`, `chk_${'a'.repeat(63)}%`, `chk_${'а'.repeat(64)}` /* Cyrillic a */, `chk_${'ａ'.repeat(64)}` /* fullwidth a */, `chk_${hex.toUpperCase()}`, `chk_${'A'.repeat(64)}`,
    `chk_${'a'.repeat(63)}`, `chk_${'a'.repeat(65)}`, `chk_`, 'chk', hex, `CHK_${hex}`, ` chk_${hex}`, `chk_${hex} `, `chk_${hex}\n`, `chk_${hex}\0`, `chk_${hex.slice(0, 63)}\0`, `chk_${hex}.part`, `chk_${hex}/`, `chk_${hex}/../x`,
    `chk_${'g'.repeat(64)}`, `chk_${hex.slice(0, 32)} ${hex.slice(33)}`, '', 'chk_0x' + 'a'.repeat(62), undefined, null, 5, {}, [], [id], { toString: () => id }, String.raw`chk_\u0061${'a'.repeat(63)}`,
  ];
  for (const value of bad) { assert.equal(isChunkId(value), false, JSON.stringify(value)); assert.throws(() => chunkDigest(value), (error: unknown) => isStoreError(error, 'INVALID_ID')); assert.throws(() => chunkPath('/store/chunks', value), (error: unknown) => isStoreError(error, 'INVALID_ID')); }
});

test('the only path a chunk ID can produce is <chunks>/<aa>/<bb>/<64-hex>, inside the chunks directory', () => {
  const root = join('/store', 'chunks'); const path = chunkPath(root, id);
  assert.equal(path, join(root, hex.slice(0, 2), hex.slice(2, 4), hex));
  // A deterministic fuzz: random strings that are not valid identifiers never produce a path; random valid ones always stay inside the root.
  let seed = 12345; const next = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed; };
  const alphabet = '0123456789abcdefABCDEF./\\%_ \0:~-g';
  for (let i = 0; i < 2000; i++) {
    let text = 'chk_'; const length = 60 + (next() % 10); for (let j = 0; j < length; j++) text += alphabet[next() % alphabet.length];
    if (isChunkId(text)) { const p = chunkPath(root, text); assert.ok(p.startsWith(root + '/') || p.startsWith(root + '\\')); assert.doesNotMatch(p.slice(root.length), /\.\./); }
    else assert.throws(() => chunkPath(root, text));
  }
  for (let i = 0; i < 200; i++) { const h = createHash('sha256').update(String(i)).digest('hex'); assert.equal(chunkPath(root, chunkIdOf(h)).startsWith(root), true); }
});
