import { lstat, mkdir, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve } from 'node:path';

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
export function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
