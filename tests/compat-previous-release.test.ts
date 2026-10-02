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
const COMPAT_ALLOWED: string[] = ['apps/node/src/resource-policy.ts']; // 4.0-alpha.1 adds the default-off storage block (additive; tests/storage-policy.test.ts proves a v0.3.6 policy still loads)

test(`persistent state formats and the wire protocol are unchanged since ${BASE_TAG}, apart from the declared additions`, { skip }, () => {
  assert.equal(haveTag, true, `PRIVANET_REQUIRE_COMPAT_TAG=1 needs the ${BASE_TAG} tag (fetch with tags)`);
  for (const file of STATE_FILES.filter(name => !COMPAT_ALLOWED.includes(name))) assert.equal(git('diff', BASE_TAG, 'HEAD', '--', file), '', `${file} changed since ${BASE_TAG}: add a migration test and list it in COMPAT_ALLOWED`);
  const changed = git('diff', '-U0', BASE_TAG, 'HEAD', '--', WIRE_FILE).split('\n').filter(line => /^[+-]/.test(line) && !/^(\+\+\+|---)/.test(line));
  assert.deepEqual(changed.filter(line => !/SERVICE_VERSION/.test(line)), [], `${WIRE_FILE} may differ from ${BASE_TAG} only in SERVICE_VERSION (no protocol or schema change)`);
});
