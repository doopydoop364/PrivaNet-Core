import { copyFile, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export async function privateDirectory(path: string): Promise<string> {
  const absolute = resolve(path);
  await mkdir(absolute, { recursive: true, mode: 0o700 });
  const stat = await lstat(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink() ||
      (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))) {
    throw new Error('State directory must be private and operator-owned');
  }
  return absolute;
}
export async function readPrivateFile(path: string): Promise<string> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192 ||
      (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))) {
    throw new Error('Unsafe private state file');
  }
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try { return await file.readFile('utf8'); } finally { await file.close(); }
}
export async function createPrivateFile(path: string, value: string): Promise<void> {
  // Exclusive creation: never overwrite an identity/binding or follow a symlink.
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try { await file.writeFile(value); await file.sync(); } finally { await file.close(); }
}
/**
 * Same safety rules as `readPrivateFile` (a regular file we own, not a link, not readable by others) with a caller-chosen size limit, for files that are
 * larger than a key or a record, such as the owner's resource policy.
 */
export async function readPrivateFileUpTo(path: string, maxBytes: number): Promise<string> {
  return busyRetry(async () => readPrivateFileOnce(path, maxBytes));
}
/**
 * Windows refuses to rename over, or open, a file that another handle is using at that instant (EPERM/EBUSY/EACCES), which a reader and a writer of the same small file will hit now and
 * then. The condition clears in milliseconds, so those operations are retried briefly there; everywhere else, and for every other error, nothing is retried.
 */
async function busyRetry<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); } catch (error) {
      const code = error instanceof Error && 'code' in error ? String(error.code) : '';
      if (process.platform !== 'win32' || attempt >= 40 || !['EPERM', 'EBUSY', 'EACCES'].includes(code)) throw error;
      await delay(5 + attempt * 2);
    }
  }
}
async function readPrivateFileOnce(path: string, maxBytes: number): Promise<string> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes ||
      (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))) {
    throw new Error('Unsafe private state file');
  }
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try { return await file.readFile('utf8'); } finally { await file.close(); }
}
/**
 * Replaces (or creates) a private file atomically: the new content is written to a sibling temporary file (exclusive, mode 0600, flushed to disk) and renamed over the
 * target, so a reader or a crash sees the old file or the new one, never half of one. With `keepBackup` the previous file is first copied to `<path>.bak` (also 0600).
 */
export async function replacePrivateFile(path: string, value: string, options: { keepBackup?: boolean } = {}): Promise<void> {
  const temporary = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try { await file.writeFile(value); await file.sync(); } catch (error) { await file.close(); await unlink(temporary).catch(() => undefined); throw error; }
  await file.close();
  try {
    if (options.keepBackup) {
      const existing = await lstat(path).catch(() => undefined);
      if (existing?.isFile() && !existing.isSymbolicLink()) { await copyFile(path, `${path}.bak`); }
    }
    await busyRetry(() => rename(temporary, path));
  } catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
}
export function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
