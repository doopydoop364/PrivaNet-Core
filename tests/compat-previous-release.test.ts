import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// A tripwire for upgrades. The files that define what a node keeps on disk and what goes over the wire must not change under an upgrade unless the change is deliberate and has a migration: this
// compares them with the previous release's tag. When one of them changes on purpose, say so here (in COMPAT_ALLOWED) and write the migration test; do not just delete the failing assertion.
// The tag is only present in a full clone: CI fetches tags for this (PRIVANET_REQUIRE_COMPAT_TAG=1), and a local shallow clone without it skips.
const BASE_TAG = 'v0.3.6';
const root = fileURLToPath(new URL('../../', import.meta.url));
const git = (...args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const haveTag = (() => { try { git('rev-parse', '--verify', '--quiet', `refs/tags/${BASE_TAG}`); return true; } catch { return false; } })();
const required = process.env.PRIVANET_REQUIRE_COMPAT_TAG === '1';
const skip = haveTag ? undefined : required ? undefined : `the ${BASE_TAG} tag is not in this clone (git fetch --tags)`;

/** Persistent formats: identity, enrollment, checkpoints, the owner's resource policy, the Coordinator's stored records and the wire schemas (index.ts: only the version constant may differ). */
const STATE_FILES = ['apps/node/src/identity.ts', 'apps/node/src/enrollment-record.ts', 'apps/node/src/checkpoint.ts', 'apps/node/src/resource-policy.ts', 'apps/coordinator/src/store.ts', 'apps/coordinator/src/migrations.ts', 'packages/shared/src/crypto.ts'];
const WIRE_FILE = 'packages/protocol/src/index.ts';
// Declared changes since the base release. node/resource-policy.ts: the default-off storage block of 0.4.0-alpha.1 (tests/storage-policy.test.ts proves a v0.3.6 policy still loads).
// coordinator/store.ts and coordinator/migrations.ts: the 0.4.0-alpha.2 storage tables (migration 2). They are held to a stricter rule below (additions only, migration 1 byte-identical), and
// tests/storage-migration.test.ts proves a version 1 database upgrades in place.
const COMPAT_ALLOWED: string[] = ['apps/node/src/resource-policy.ts', 'apps/coordinator/src/store.ts', 'apps/coordinator/src/migrations.ts'];
/** Lines the wire file may REMOVE (everything else it may only add): the version string, `kind: 'job'` added to the three registered jobs, and the application-create schema that gained one optional member (the heartbeat gained its member by addition only). */
const WIRE_REMOVALS = [/SERVICE_VERSION/, /^-\s+'(system\.echo\.v1|system\.hashchain\.v1|web\.fetch\.v1)': Object\.freeze\(\{ version: 1,/, /^-export const AppCreateSchema = /];

test(`persistent state formats and the wire protocol are unchanged since ${BASE_TAG}, apart from the declared additions`, { skip }, () => {
  assert.equal(haveTag, true, `PRIVANET_REQUIRE_COMPAT_TAG=1 needs the ${BASE_TAG} tag (fetch with tags)`);
  for (const file of STATE_FILES.filter(name => !COMPAT_ALLOWED.includes(name))) assert.equal(git('diff', BASE_TAG, 'HEAD', '--', file), '', `${file} changed since ${BASE_TAG}: add a migration test and list it in COMPAT_ALLOWED`);
  const changed = git('diff', '-U0', BASE_TAG, 'HEAD', '--', WIRE_FILE).split('\n').filter(line => /^[+-]/.test(line) && !/^(\+\+\+|---)/.test(line));
  const removed = changed.filter(line => line.startsWith('-')).filter(line => !WIRE_REMOVALS.some(pattern => pattern.test(line)));
  assert.deepEqual(removed, [], `${WIRE_FILE} may only ADD to ${BASE_TAG}'s schemas (plus the declared one-line edits): a removed or changed line is a breaking wire change`);
  // The migrations: migration 1 untouched (its checksum is in every upgraded database), later ones only appended; the store only gains methods.
  const migrationRemovals = git('diff', '-U0', BASE_TAG, 'HEAD', '--', 'apps/coordinator/src/migrations.ts').split('\n').filter(line => line.startsWith('-') && !line.startsWith('---'));
  assert.deepEqual(migrationRemovals.filter(line => !/^-` \}\] as const;$/.test(line)), [], 'migration 1 must stay byte-identical; only new migrations may be appended');
  const storeRemovals = git('diff', '-U0', BASE_TAG, 'HEAD', '--', 'apps/coordinator/src/store.ts').split('\n').filter(line => line.startsWith('-') && !line.startsWith('---'));
  assert.deepEqual(storeRemovals.filter(line => !/^-import type \{ ApplicationRecord, ChallengeRecord, Grant, JobRecord, NodeRecord, NodeSession, Store \} from/.test(line) && !/^- {2}close\(\): void \{ this\.db\.close\(\); \}$/.test(line)), [], 'the Coordinator store may only gain storage methods (no existing query changes)');
});
