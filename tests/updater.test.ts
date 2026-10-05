import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

test('Linux opt-in updater: channels, checksums, archive safety, private backups and rollback without replay restore', { skip: process.platform !== 'linux' }, () => {
  execFileSync('python3', [join(process.cwd(), 'tests/updater.py')], { stdio: 'pipe', timeout: 30000 });
});
