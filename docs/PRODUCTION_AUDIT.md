# Production validation audit (PrivaSearch 0.5.1 / Core 0.4.0-alpha.4)

**Status: code-level audit done; live production validation NOT performed.** The audit session had no SSH keys, no inventory, no PrivaNet/PrivaSearch services and no route to the deployed machines. Nothing below states what production runs. GitHub shows `privasearch v0.5.1` (2026-10-05) and `PrivaNet-Core v0.4.0-alpha.4` (prerelease, 2026-10-05) are *published*; that proves nothing about deployment.

## A. Which PrivaSearch is the live crawler? (read-only, run on the Search host)

Do not change anything until all of these agree. Disagreement is itself the finding.

```sh
systemctl show privasearch -p ExecStart -p MainPID -p ActiveEnterTimestamp   # executable/release link and start time
readlink -f /opt/privasearch; cat "$(readlink -f /opt/privasearch)/package.json" | grep '"version"'
tr '\0' ' ' < /proc/$(systemctl show -p MainPID --value privasearch)/cmdline; echo
ls -l /proc/$(systemctl show -p MainPID --value privasearch)/cwd /proc/$(systemctl show -p MainPID --value privasearch)/exe
journalctl -u privasearch --no-pager | grep '"event":"service.started"' | tail -3   # logs "version" at startup (0.5.x)
curl -s http://127.0.0.1:4020/health                       # version, schemaVersion (schemaVersion added by this change)
curl -s -H "Authorization: Bearer $PRIVASEARCH_TOKEN" http://127.0.0.1:4020/status | head -c 600
sqlite3 -readonly /var/lib/privasearch/*.db 'PRAGMA user_version; SELECT k,v FROM meta WHERE k LIKE "crawl_metrics%"; SELECT name FROM sqlite_master WHERE name IN ("crawl_health","crawl_outcomes","crawl_hours","crawl_retries");'
```

Interpretation: a service still *started before* the release timestamp, an `ExecStart` that resolves to a 0.5.0/0.4.1 directory, or `frontier.operational` absent from `/status` all mean 0.5.1 is **not** running (the package and `service.started` log carry the version; `/status` carries it only after this change; schema stays 4 across 0.5.0 and 0.5.1, so schema alone cannot discriminate). `crawl_health`/`crawl_outcomes` tables exist only after a 0.5.1 process opened the database. Updater logs: `journalctl -u privanet-update.service`; the updater only moves within the installed major/minor and needs the release's archive and `SHA256SUMS`.

If older than 0.5.1: the frontier numbers are not evidence about the new scheduler. Upgrade per `docs/AUTOMATIC_UPDATES.md` or manually: back up SQLite with `npm run frontier -- backup <file>` (or `sqlite3 .backup`), stop service, unpack beside the old release, `npm ci --omit=dev`, switch the `/opt/privasearch` link, start, verify the signals above. Schema v4 is additive; **rollback is link switch plus restart, restoring the backup only if you choose to discard post-upgrade crawl state**. Do not run an old and a new writer on the same database.

If already 0.5.1, separate the questions with counters, not row counts:

| Question | Source |
| --- | --- |
| Old preserved rows vs new admissions | `frontier.admission` (since process start), `urls.discovered_at` vs release time |
| Retained but suppressed | `frontier.operational.suppressed` (domains in cooldown, pending rows held, hosts in backoff), `zeroYieldTotals`, `lowYield` |
| Scheduler selections / real fetch attempts | `domains.leased` and `crawl_outcomes` deltas between two `/status` samples (leased counts selections; `FETCHED` counts successes) |
| Retries/failures | `outcomes` (queue/outcome/error), `queues[].retrying`, retry age buckets |

A large PENDING count on a domain in cooldown costs no worker capacity. Check that the *delta* in `leased` for the zero-yield domains over an hour is near zero after their cooldown starts; the 0.5.1 design permits at least 8 selections per domain before evidence exists and one serialized recovery probe per cooldown, so some residual attempts are expected.

## B. Robots diagnostics (end-to-end)

Path: node `robotsFor` -> `FetchOutput.error/httpStatus/retryAfterSec` (strict Zod schema, no messages or IPs) -> Coordinator validates against the same schema -> SDK -> PrivaSearch `Frontier.complete` -> `crawl_outcomes(queue,outcome,error)` -> `/status` `frontier.operational.outcomes` -> roundup `quality.operational` and `summary.failures`.

| Class | What survives |
| --- | --- |
| DNS | `FETCH_FAILED` / `DNS` |
| Refused/reset, TLS, timeout, decode | `ROBOTS_UNAVAILABLE` / `CONNECT` `RESET` `TLS` `TIMEOUT` `DECODE` |
| HTTP 5xx | `ROBOTS_UNAVAILABLE` + status, recorded `HTTP_5xx` |
| 429 | `RATE_LIMITED` + Retry-After (page not fetched) |
| Redirect refused (cross-origin, restricted, loop, bad Location) | `PROTOCOL` + 3xx status; **now recorded as `PROTOCOL_REDIRECT`** |
| Oversize / unsupported encoding | `PROTOCOL` without status |
| Policy rejection | `BLOCKED_TARGET` |
| Disallow | `ROBOTS_DISALLOWED` |
| Node/Coordinator failure | `TransportError` kinds, not robots outcomes |

The node tests already exercise 5xx/Retry-After/negative-cache/429/timeout/redirect/DNS/decode over real loopback HTTP servers. Boundary behavior was confirmed by reading `contract.ts`, the transport and `complete()`: fields are not dropped. Known limitation: parser failure cannot occur (the parser is total; invalid lines are ignored) and a challenge page served as HTTP 200 is parsed as an empty rule set (allow-all), so it is **not** reported as unavailable.

Candidate defect not changed here: robots.txt that redirects to a *different origin* (typical apex -> `www`) is refused by design (same-origin rule, SSRF defence) and the page is then never fetched, so the `REDIRECT` outcome that would teach PrivaSearch the canonical host is never produced; the URL retries until attempts are exhausted. RFC 9309 says crawlers should follow several redirects. Whether this explains `doi.org`, Instagram or any other live failure is **unverified**: it needs the real `error`/`httpStatus` rows (`PROTOCOL_REDIRECT` with 301/302/307/308 now identifies it). Changing the redirect policy is a security decision for the owner and was left alone.

## C. Core 0.4.0-alpha.4 on real machines

Not performed. Use `ALPHA4_UPGRADE.md` (upgrade and rollback) and the 20-row table in `ALPHA4_LAN_VALIDATION.md`; record per row: date, versions, node IDs, evidence, result. Pre-upgrade capture on each machine:

```sh
cat /opt/privanet/package.json | grep '"version"'; systemctl is-active privanet-coordinator privanet-node privanet-roundup privasearch
curl -s https://COORDINATOR/v1/health                          # serviceVersion, protocolVersion, coordinator id
privanet-admin nodes                                            # enrolled node IDs (store them; they must be identical after)
privanet-node storage status --json; privanet-node settings --json   # as the service account
stat -c '%a %U %n' /etc/privanet/* /var/lib/privanet*          # permissions under the service umask
ls /var/lib/privanet-updater/backups 2>/dev/null
```

Back up per the upgrade doc (Coordinator SQLite via its backup tool, `transfer-keys.json`, node state with the node stopped, `/etc/privanet`). Verify rollback path before switching: previous release directory retained and the link target recorded. Upgrade only through the documented updater or link switch; afterwards repeat the capture and diff node IDs, Coordinator ID and capacity. Rollback rehearsal: switch the link back, restart, confirm same IDs and that previously stored chunks still fetch. Do not implement Phase 5 replication.

## D. Roundup telemetry

`GET /crawling/api/status` now begins `schema_version`, `generated_at`, `summary`. `summary` contains only values forwarded from PrivaSearch's existing O(1)/cached sections (nothing is recounted) and is null per section for a legacy source. Fields: `generated_at`, `source_generated_at_ms`, `source_age_sec`, `versions{core,privasearch,schema}`, `totals`, `documents` (+duplicate rate), `queues` (PUBLIC/DEMAND), `throughput` (previous complete UTC hour), `failures.by_outcome/by_error`, `retries` age buckets, `zero_yield` (count/share), `suppressed` (cooldown domains/pending, backed-off hosts), `concentration` (top1/top5, effective domains, family), `search_quality` (indexing proxy only). Core version is read from the `package.json` beside `bin/`; PrivaSearch version/schema require 0.5.1+ with this change. Detailed `domains`/`recent`/`errors` rows are unchanged. Roundup and the dashboard must both be restarted/updated to carry new fields.
