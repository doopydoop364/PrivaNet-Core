// Consistent online backup of the Coordinator database: `npm run backup -- <destination-file>`.
// Uses SQLite's VACUUM INTO, which is safe while the Coordinator is running (WAL), refuses to
// overwrite an existing file, verifies the copy and leaves it owner-readable only. The backup holds
// job/node metadata and credential hashes: store it as sensitive. Node identities are separate.
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const destination = process.argv[2];
if (!destination) { console.error('Usage: npm run backup -- <destination-file>'); process.exit(2); }
const source = join(resolve(process.env.PRIVANET_DATA_DIR ?? './var/coordinator'), 'coordinator.sqlite');
const target = resolve(destination);
try {
  if (!existsSync(source)) throw new Error('source missing');
  if (existsSync(target)) throw new Error('destination exists');
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
  console.error(JSON.stringify({ event: 'backup.failed', reason: error instanceof Error ? error.message : 'unknown' }));
  process.exitCode = 1;
}
