// Consistent online backup of the Coordinator database: `npm run backup -- <destination-file>`.
// Uses SQLite's VACUUM INTO, which is safe while the Coordinator is running (WAL), refuses to
// overwrite an existing file, verifies the copy and leaves it owner-readable only. The backup holds
// job/node metadata and credential hashes: store it as sensitive. Node identities are separate.
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, closeSync, constants, existsSync, openSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';

const destination = process.argv[2];
if (!destination) { console.error('Usage: npm run backup -- <destination-file>'); process.exit(2); }
const source = join(resolve(process.env.PRIVANET_DATA_DIR ?? './var/coordinator'), 'coordinator.sqlite');
const target = resolve(destination); let created = false;
try {
  if (!existsSync(source)) throw new Error('source missing');
  // The file is created owner-only before anything is written to it: VACUUM INTO would create it with the process umask (typically 0644), leaving the
  // credential hashes readable by other users until a later chmod, or for good if this process died in between. SQLite accepts an empty existing file.
  try { closeSync(openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)); } catch (error) { throw new Error(error?.code === 'EEXIST' ? 'destination exists' : 'cannot create destination', { cause: error }); }
  created = true;
  const db = new DatabaseSync(source);
  try { db.prepare('VACUUM INTO ?').run(target); } finally { db.close(); }
  chmodSync(target, 0o600);
  const copy = new DatabaseSync(target, { readOnly: true });
  try {
    if (copy.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok') throw new Error('integrity check failed');
    const migrations = Number(copy.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()?.n);
    console.log(JSON.stringify({ event: 'backup.created', migrations }));
  } finally { copy.close(); }
} catch (error) {
  if (created) try { unlinkSync(target); } catch { /* nothing to remove */ } // never leave a partial or unverified backup that looks like a good one
  console.error(JSON.stringify({ event: 'backup.failed', reason: error instanceof Error ? error.message : 'unknown' }));
  process.exitCode = 1;
}
