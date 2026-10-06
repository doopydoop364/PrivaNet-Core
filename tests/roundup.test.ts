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

test('roundup summary is a compact top-level view built only from forwarded source fields, with generated_at first and nulls for a legacy source', t => {
  if (spawnSync('python3', ['--version']).status !== 0) { t.skip('roundup requires Python 3'); return; }
  const result = spawnSync('python3', ['-c', `
import runpy, json
m = runpy.run_path('deploy/bin/privanet-roundup-api')
f = m['build_roundup']
g = f.__globals__
operational = {
  'metricsSinceMs': 5,
  'queues': [{'queue': 'PUBLIC', 'pending': 90, 'inFlight': 1, 'failed': 2, 'urlDue': 50, 'retrying': 4, 'retryUnderHour': 1, 'retryHourToDay': 2, 'retryOverDay': 1, 'retryAgeUnknown': 0, 'oldestPendingMs': 9},
             {'queue': 'DEMAND', 'pending': 10, 'inFlight': 0, 'failed': 0, 'urlDue': 10, 'retrying': 1, 'retryUnderHour': 1, 'retryHourToDay': 0, 'retryOverDay': 0, 'retryAgeUnknown': 0, 'oldestPendingMs': 3}],
  'outcomes': [{'queue': 'PUBLIC', 'outcome': 'FETCHED', 'error': '', 'n': 6}, {'queue': 'PUBLIC', 'outcome': 'ROBOTS_UNAVAILABLE', 'error': 'PROTOCOL_REDIRECT', 'n': 3},
               {'queue': 'DEMAND', 'outcome': 'ROBOTS_UNAVAILABLE', 'error': 'PROTOCOL_REDIRECT', 'n': 1}],
  'throughput': {'window': 'previous_complete_utc_hour', 'rows': [{'queue': 'PUBLIC', 'answers': 20, 'fetched': 12, 'fetchedPerMinute': 0.2}]},
  'zeroYieldTotals': {'domains': 2, 'pending': 25}, 'lowYieldTotals': {'domains': 3, 'pending': 40},
  'suppressed': {'cooldownDomains': 2, 'cooldownPending': 25, 'backedOffHosts': 1},
  'quality': {'fetched': 10, 'useful': 5, 'duplicates': 1, 'lowValue': 1, 'errors': 3}}
concentration = {'pending': {'top1': 0.4, 'top5': 0.8, 'effectiveDomains': 3.5}, 'families': {'pending': {'top1': 0.6, 'effectiveDomains': 2.0}}, 'warnings': ['w']}
source = {'generatedAtMs': 1234, 'version': '0.5.1', 'schemaVersion': 4, 'frontier': {'PENDING': 100, 'DONE': 7, 'FAILED': 2, 'IN_FLIGHT': 1, 'concentration': concentration, 'operational': operational}, 'documents': {'documents': 20, 'indexed': 15, 'duplicates': 4}}
g['get_json'] = lambda *args: {'status': source}
g['details'] = lambda *args: {'rows': [], 'total': 0}
p = f(); s = p['summary']
assert list(p)[:3] == ['schema_version', 'generated_at', 'summary'] and s['generated_at'] == p['generated_at']
assert s['versions']['privasearch'] == '0.5.1' and s['versions']['schema'] == 4 and s['versions']['core'] is None
assert s['totals'] == {'pending': 100, 'done': 7, 'failed': 2, 'in_flight': 1, 'blocked': 0}
assert s['documents']['indexed'] == 15 and abs(s['documents']['duplicate_rate'] - 0.2) < 1e-9
assert s['queues']['DEMAND']['pending'] == 10 and s['queues']['PUBLIC']['in_flight'] == 1
assert s['throughput']['fetched'] == 12 and abs(s['throughput']['fetched_per_minute'] - 0.2) < 1e-9
assert s['failures']['by_outcome'] == {'FETCHED': 6, 'ROBOTS_UNAVAILABLE': 4} and s['failures']['by_error'] == {'ROBOTS_UNAVAILABLE/PROTOCOL_REDIRECT': 4}
assert abs(s['failures']['fetched_rate'] - 0.6) < 1e-9
assert s['retries'] == {'pending_retrying': 5, 'under_1h': 2, '1h_to_1d': 2, 'over_1d': 1, 'age_unknown': 0}
assert s['zero_yield']['pending'] == 25 and s['zero_yield']['pending_share'] == 0.25
assert s['suppressed'] == {'cooldown_domains': 2, 'cooldown_pending': 25, 'backed_off_hosts': 1}
assert s['concentration']['effective_domains'] == 3.5 and s['concentration']['family_top1'] == 0.6
assert s['search_quality']['useful_rate'] == 0.5 and s['source_age_sec'] is not None
assert json.dumps(s)
g['get_json'] = lambda *args: {'status': {'frontier': {}}}
legacy = f()['summary']
assert legacy['versions'] == {'core': None, 'privasearch': None, 'schema': None}
assert legacy['failures'] is None and legacy['throughput'] is None and legacy['suppressed'] is None and legacy['source_age_sec'] is None
`], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});
