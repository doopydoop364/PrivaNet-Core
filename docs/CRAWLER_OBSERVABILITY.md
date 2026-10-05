# Robots diagnostics and crawler roundup

The fetch contract and protocol version are unchanged. When robots checks are unavailable, nodes now preserve bounded diagnostic codes in the **existing** optional result fields: `error`, `httpStatus`, `retryAfterSec`. No exception messages, resolved IPs or credentials are returned.

| Robots-fetch path | Result |
|---|---|
| Guarded DNS lookup fails | FETCH_FAILED / DNS |
| Target refused by URL/address policy | BLOCKED_TARGET |
| Remote 5xx | ROBOTS_UNAVAILABLE plus HTTP status and Retry-After, if supplied |
| Connect, TLS, timeout, reset or decompression failure | ROBOTS_UNAVAILABLE plus CONNECT/TLS/TIMEOUT/RESET/DECODE |
| Unsupported encoding, invalid/restricted/exhausted redirects, declared oversize body | ROBOTS_UNAVAILABLE / PROTOCOL (the existing schema has no more specific robots error field) |
| Robots 429 | RATE_LIMITED with Retry-After or a 60-second default; page is not fetched |
| Other robots 4xx | Existing ALLOW_ALL behavior |
| Parsed disallow | ROBOTS_DISALLOWED |
| Abort/preemption | Propagates; node releases or fails the job rather than inventing a remote failure |

The bounded, 60-second negative robots cache retains diagnostics. The existing 24-hour rules cache, parser bounds, same-origin redirect policy, connection vetting, TLS verification and owner-only unsafe-local testing policy remain. Invalid directive text is ignored by the parser; a challenge returned as 200 text is not specifically detected. Network causes observed on one node do not prove a whole site's global unavailability.

PrivaSearch's companion implementation supplies `frontier.concentration` for full-domain/family accounting and `frontier.operational` for queue health, outcomes, yield and throughput. `deploy/bin/privanet-roundup-api` passes those summaries through to `quality`, together with `source_generated_at_ms`. It keeps snapshot schema 1 and old fields. A legacy source yields null new summaries. The legacy top-host share remains explicitly a sampled-host metric and must not be presented as whole-frontier diversity.

Upgrade the node binary for detailed causes, and upgrade/restart the roundup adapter for forwarding. Ensure the dashboard's `/api/dashboard` status includes new PrivaSearch `/status` fields. No mirror-workflow or npm protocol/SDK upgrade is necessary. Snapshot freshness requires checking mirror `generated_at`, dashboard `last_success`/age, and the new source/operational sample timestamps together.

Validation uses local real HTTP servers for remote status, cache replay, timeout, DNS, redirect policy, compression failure, TLS and rate-limit cases, plus a mocked Python roundup source. PrivaSearch compatibility is exercised through the real Coordinator/node/SDK path. See the companion PrivaSearch `docs/crawler-health-audit.md` for baseline measurements, rollout and validation limitations. No production deployment was performed.
