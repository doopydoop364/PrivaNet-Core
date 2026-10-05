import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('roundup forwards full-frontier health and source age rather than inventing diversity from a host sample', t => {
  if (spawnSync('python3', ['--version']).status !== 0) { t.skip('roundup requires Python 3'); return; }
  const result = spawnSync('python3', ['-c', `
import runpy
m = runpy.run_path('deploy/bin/privanet-roundup-api')
f = m['build_roundup']
g = f.__globals__
concentration = {'pending': {'top1': 0.6}, 'families': {'pending': {'top1': 0.9}}}
operational = {'outcomes': [{'outcome': 'ROBOTS_UNAVAILABLE', 'n': 7}]}
g['get_json'] = lambda *args: {'status': {'generatedAtMs': 1234, 'frontier': {'PENDING': 100, 'concentration': concentration, 'operational': operational}}}
g['details'] = lambda *args: {'rows': [], 'total': 0}
p = f()
assert p['schema_version'] == 1
assert p['status']['pending'] == 100
assert p['quality']['concentration'] == concentration
assert p['quality']['operational'] == operational
assert p['quality']['source_generated_at_ms'] == 1234
assert p['quality']['top_host_frontier_share'] is None
g['get_json'] = lambda *args: {'status': {'frontier': {}}}
assert f()['quality']['operational'] is None
`], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});
