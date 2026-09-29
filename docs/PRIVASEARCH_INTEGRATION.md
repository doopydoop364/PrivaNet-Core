# PrivaSearch integration specification (Phase 3 preparation)

Status: **design only. Nothing in this document is implemented.** No `privasearch.*` job type exists in the registry, no crawl handler exists in the node, and the PrivaNet-Core changes listed in [section 14](#14-privanet-core-changes-required) have not been made. This document is the hand-off from PrivaNet-Core to a **separate PrivaSearch repository**. Current PrivaNet behaviour is described in [protocol](protocol.md), [security](security.md), [resources](RESOURCES.md) and the [architecture](architecture.md); this document names where they must change.

Verified against v0.2.1 (`main`): job input and results travel as bounded JSON (32 KiB request bodies, 512 KiB responses), one job slot per node, node-local checkpoints only, no job cancellation, 10 s default lease renewed automatically, applications scoped to allowed job types, results validated by the registered output schema.

## 1. Purpose and non-goals

The first real external consumer of PrivaNet is PrivaSearch, and its first workload is web crawling. The integration must use the real PrivaNet path even with everything on one machine:

```text
PrivaSearch (separate repo)  ->  PrivaNet SDK  ->  Coordinator  ->  authenticated PrivaNode
                                                                        |
                                                              privasearch.crawl.v1 handler
                                                                        |
                                                              validated crawl result  -> back through the same path
```

Non-goals for PrivaNet-Core: the crawler frontier, scheduling policy, index, ranking, metasearch, UI, storage (Phase 4), credits, market or treasury. PrivaNet-Core supplies only a **tightly constrained fetch capability** and the plumbing around it.

`privasearch.crawl.v1` is **a constrained HTTP GET for a crawler. It is not a proxy.** It has no methods other than GET, no caller-supplied headers, no request bodies, no tunnels, no CONNECT, no raw response passthrough, no access to localhost, private, link-local or metadata addresses, and no code supplied by anyone at runtime.

## 2. Who owns what

| Concern | PrivaSearch | PrivaNet-Core |
| --- | --- | --- |
| Which URLs to crawl, priority, recrawl timing, discovery, dedup, crawl budget, host politeness *policy* | Yes (frontier) | No |
| URL canonicalisation before submission | Yes | Re-validates only (strict syntax and policy) |
| Demand queue vs public queue | Yes (two application credentials, see section 8) | Quotas per application; payer attribution later (Treasury, Phase 9) |
| robots.txt *decision for scheduling* (cache, avoid wasted jobs) | Yes | No |
| robots.txt *enforcement at fetch time* | Consumes the verdict | **Yes, in the handler; cannot be disabled by the job** |
| Per-host rate limiting | Primary limiter (one in-flight request per host, crawl-delay, backoff) | Defence in depth on the node (section 6) |
| SSRF protection, redirect/size/time/decompression limits, allowed schemes, ports, content types | Sends only sane input | **Yes, in the handler** |
| Minimal page digest (title, text excerpt, links, canonical, robots signals) | Interprets it | Produces it (needed because no data plane exists yet, section 4) |
| Rich parsing, near-duplicate detection, language ID, ranking, index, storage of pages | Yes | No (later `privasearch.parse.v1` and Phase 4 storage) |
| Job identity, auth, leases, retries, preemption, resource budgets, retention | No | Yes |
| Trust in node results (poisoning defence) | Yes (cross-checks, sampling, later reputation) | Provides hashes and metadata that make cross-checks possible |

The security-critical fetcher lives in **PrivaNet-Core's node** because node owners are trusting PrivaNet's code, not an application's. PrivaSearch never ships executable code to a node. The job type is registered centrally, like every other job type ([ADR 001](architecture.md#decisions-adr-001), [ADR 004](architecture.md#adr-004-privasearchcrawlv1-is-a-constrained-fetch-job-not-a-proxy)).

## 3. `privasearch.crawl.v1` input

Strict Zod object (unknown fields rejected). Every field is validated by the Coordinator at submission **and** again by the node before any network access.

```typescript
// Recommended; lives in packages/protocol beside the other job schemas.
export const CrawlInputSchema = z.strictObject({
  /** Absolute http(s) URL, already canonicalised by PrivaSearch. Re-validated by the node (section 7). */
  url: z.string().min(8).max(2048),
  /** DIGEST: fetch the page and return the digest. PROBE: headers only (HEAD is never used; a GET is opened, headers read, body dropped). */
  mode: z.enum(['DIGEST', 'PROBE']).default('DIGEST'),
  /** Conditional-request validators from the last crawl, so unchanged pages cost almost nothing. */
  validators: z.strictObject({
    etag: z.string().max(200).regex(/^(?:W\/)?"[\x21\x23-\x7e]*"$/).optional(),
    lastModified: z.string().max(40).regex(/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/).optional(),
  }).optional(),
  /** Same-origin redirects only (section 7). 0-3. */
  maxRedirects: z.number().int().min(0).max(3).default(3),
  /** Whole-request deadline. The node also enforces its own hard cap. */
  timeoutMs: z.number().int().min(1000).max(30000).default(20000),
  /** Cap on decoded body bytes read (after decompression). */
  maxBodyBytes: z.number().int().min(4096).max(1048576).default(524288),
  maxTextBytes: z.number().int().min(0).max(10240).default(10240),
  maxLinks: z.number().int().min(0).max(100).default(100),
});
```

Deliberately **absent**: method, headers, cookies, body, proxy settings, port, IP address, resolver hints, "ignore robots", "allow private", "follow cross-origin redirects", TLS options, user agent. There is nothing in the input that can widen what the node will do; every knob only lowers a cap (each maximum is also enforced by the node's owner policy, and the smaller value wins).

**Correlation and idempotency.** PrivaSearch encodes its frontier entry in the existing `idempotencyKey` (for example `crawl:<sha256(url)[0:32]>:<generation>`, at most 128 characters). No extra correlation field is needed. Resubmitting the same key returns the same job; a new `generation` is a deliberate recrawl.

**Do not put in the input:** user identifiers, search queries, IP addresses, session data, or anything not needed to fetch the URL. See section 10.

## 4. `privasearch.crawl.v1` result

**Why a digest and not the page.** Results ride the JSON control plane (a completion body is at most 32 KiB), and there is no bulk data path until Phase 4/5. So the node returns a bounded **page digest**, not the page. The digest extractor is a small, deterministic, hardened, fixed piece of node code with no JavaScript, no external fetches and no DOM library. Richer parsing is PrivaSearch's job on the digest or, later, a separate `privasearch.parse.v1` job over stored content. The result carries a content hash and the exact byte counts so that a future `blobRef` (Phase 4) can be added additively.

Fetch problems are **results, not job failures**. The job is `COMPLETED` with an `outcome`; PrivaNet's own retry logic (attempt limit, lease expiry, release) covers only infrastructure loss. A handler `HANDLER_FAILED` means a bug or a violated internal limit, never "the site returned 500".

```typescript
const Url = z.string().min(8).max(2048);
export const CrawlOutcomeSchema = z.enum([
  'FETCHED',                   // 2xx body read (possibly truncated) and digested
  'NOT_MODIFIED',              // 304 for the supplied validators
  'PROBED',                    // mode PROBE: headers read, body dropped
  'REDIRECT',                  // 3xx to another origin (or beyond maxRedirects); redirectTarget is returned, NOT followed
  'ROBOTS_DISALLOWED',         // robots.txt forbids this URL for PrivaSearchBot; no page request was made
  'ROBOTS_UNAVAILABLE',        // robots.txt could not be fetched reliably (5xx/timeout); treated as disallow for this attempt
  'BLOCKED_TARGET',            // URL/host/redirect failed the SSRF or policy checks; nothing was requested
  'RATE_LIMITED',              // the node's own per-host or overall cap said "too soon"; retryAfterSec is set
  'UNSUPPORTED_CONTENT_TYPE',  // headers read, body dropped
  'TOO_LARGE',                 // over the body or compression-ratio cap; nothing beyond the cap was digested
  'HTTP_ERROR',                // 4xx/5xx from the site (httpStatus set; retryAfterSec if given)
  'FETCH_FAILED',              // DNS failure, connect/TLS error, timeout, reset (error.code says which)
]);
export const CrawlResultSchema = z.strictObject({
  outcome: CrawlOutcomeSchema,
  requestedUrl: Url,
  finalUrl: Url.optional(),                  // after same-origin redirects
  redirectTarget: Url.optional(),            // only with outcome REDIRECT
  redirects: z.array(z.strictObject({ url: Url, status: z.number().int().min(300).max(399) })).max(3),
  httpStatus: z.number().int().min(100).max(599).optional(),
  fetchedAtMs: TimeSchema, durationMs: z.number().int().min(0).max(120000),
  contentType: z.string().max(100).optional(), charset: z.string().max(40).optional(),
  bodyBytes: z.number().int().min(0).max(1048576).optional(),   // decoded bytes actually read
  bodyTruncated: z.boolean().optional(),
  contentSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(), // over the decoded bytes read; enables cross-node verification
  etag: z.string().max(200).optional(), lastModified: z.string().max(40).optional(),
  retryAfterSec: z.number().int().min(0).max(86400).optional(),
  robots: z.strictObject({
    verdict: z.enum(['ALLOWED', 'DISALLOWED', 'UNAVAILABLE']),
    fetchedAtMs: TimeSchema.optional(), sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),   // hash only, never the file
    crawlDelaySec: z.number().min(0).max(300).optional(),
  }),
  indexing: z.strictObject({ noindex: z.boolean(), nofollow: z.boolean(), noarchive: z.boolean() }).optional(), // from X-Robots-Tag and meta robots
  page: z.strictObject({
    title: z.string().max(300).optional(), description: z.string().max(500).optional(),
    canonicalUrl: Url.optional(), language: z.string().max(35).optional(),
    text: z.string().max(10240).optional(),             // cleaned visible-text excerpt; omitted when noindex
    textTruncated: z.boolean().optional(),
    links: z.array(z.strictObject({ url: Url, nofollow: z.boolean() })).max(100),
    linksTruncated: z.boolean(),
  }).optional(),
  error: z.strictObject({ code: z.enum(['DNS', 'CONNECT', 'TLS', 'TIMEOUT', 'RESET', 'PROTOCOL', 'DECODE', 'INTERNAL']), retryable: z.boolean() }).optional(),
}).refine(result => Buffer.byteLength(JSON.stringify(result)) <= 28000, 'result too large');   // stays under the 32 KiB body limit
```

Rules for the digest: only `http`/`https` links, resolved against the final URL (and `<base href>` if valid), fragment removed, at most 2048 characters, deduplicated, `rel=nofollow|ugc|sponsored` flagged; `<script>`, `<style>`, `<template>` and `<noscript>` content is dropped; whitespace collapsed; the handler trims links (longest first) and text until the whole result fits the 28,000-byte bound. If the page is `noindex` by header or meta tag, `page.text` is omitted (data minimisation: do not ship what the site asked not to index).

**Never in the result:** response headers other than the allowlisted fields above, cookies, the raw body, the robots.txt body, resolved IP addresses, TLS details.

## 5. Cancellation, lease renewal, preemption, checkpointing, retries

| Topic | Semantics |
| --- | --- |
| **Duration** | A crawl job is short and bounded: at most 30 s by input, and the node's hard cap is 60 s. It normally takes a second or two. |
| **Lease renewal** | Already implemented (v0.2.1): the node renews the lease while the handler runs, so the 10 s default lease does not limit a 30 s fetch. Nothing new is needed. |
| **Preemption** | Declared `preemptible: true`. Owner pressure or shutdown aborts the in-flight request (the handler honours the abort signal, closes the socket) and the job is released and requeued with the attempt refunded. A restart re-fetches from scratch. |
| **Checkpointing** | Declared `checkpointable: false`. A partial HTTP response is not worth resuming: ranges and validators are unreliable, and jobs are seconds long. Preemption costs one repeated GET. |
| **Retries: infrastructure** | PrivaNet attempts (lease expiry, revocation, release) are bounded as today (`PRIVANET_MAX_ATTEMPTS`, `PRIVANET_MAX_RELEASES`). |
| **Retries: the web** | Owned by PrivaSearch. Transient site failures come back as results (`FETCH_FAILED` with `retryable`, `HTTP_ERROR`, `RATE_LIMITED`, `ROBOTS_UNAVAILABLE`, `Retry-After`), and the frontier re-submits with a new idempotency `generation` and its own per-host backoff. PrivaNet never blindly retries a fetch. |
| **Cancellation** | **Not implemented** in PrivaNet (no job cancel exists). The MVP does not need it: jobs are bounded by their deadline, and the frontier can ignore a result it no longer wants. It is required **before** untrusted or public nodes and before a large queue can build up, because a `QUEUED` backlog with no node online otherwise cannot be withdrawn. Recommended design (section 14): `POST /v1/jobs/{id}/cancel`; a `QUEUED` job becomes `CANCELLED` immediately; a `LEASED` job is marked cancel-requested and the node learns it in the next renewal response and aborts. |
| **Duplicate execution** | At-least-once (as everywhere). A fetch is a GET and safe to repeat; the frontier must still deduplicate results by idempotency key. |

## 6. Resource estimates

Declared in the registry (`ResourceEstimate`), as upper bounds, to be calibrated against real measurements during Phase 3:

```typescript
const CRAWL_RESOURCES: ResourceEstimate = {
  cpu: 'low',                      // TLS, decompression and HTML tokenising; well under the 25 percent class
  memoryBytes: 48 * 1024 * 1024,   // 1 MiB compressed + 1 MiB decoded buffers, tokenizer state, robots cache slice
  diskBytes: 0, diskIo: 'none',    // nothing is written; robots cache is in memory only
  networkBytes: 2 * 1024 * 1024,   // 1 MiB compressed page + up to 500 KiB robots.txt + headers/TLS
  expectedDurationMs: 30000,       // worst case; typical is far lower
  preemptible: true, checkpointable: false,
};
```

Notes: `expectedDurationMs` of 30 s means schedule-aware placement keeps crawl jobs off nodes about to go `OFF`. Handlers must call `context.transfer(bytes)` before reading each chunk so the owner's bandwidth ceiling and monthly allowance apply to crawling. One job slot per node means a node fetches one page at a time; that is enough for the early milestones (see section 12) and multi-slot nodes are a measured, later change.

## 7. Bounds and SSRF protection (the handler's job)

All of this is enforced **on the node, in code that neither the job nor PrivaSearch can configure away.** Owner policy (a new `crawl` section in the node's policy file) can only make things stricter, with one explicit escape hatch described below.

**URL rules (checked before any network access, and again for every redirect):**

- Scheme `http` or `https` only. No userinfo, no fragment, length at most 2048, no control characters, no backslashes.
- Host must be a **DNS name**. IP literals (v4 in any decimal/octal/hex/short form, v6, bracketed, zone IDs) are rejected outright in v1. Reject `localhost`, `*.localhost`, `*.local`, `*.internal`, `*.lan`, `*.home.arpa`, single-label names, and names that end in a trailing dot after normalisation to something forbidden.
- Ports: 80 and 443 only (owner policy may narrow, not widen, in v1).
- Owner deny list of hosts/suffixes (`crawl.denyHosts`) always applies; an optional owner allow list (`crawl.allowHosts`) restricts further.

**Address rules (the SSRF core):**

- The node resolves the name itself, then checks **every resolved address** against a deny list, then **connects to the vetted address** (the connection uses a custom `lookup` that returns only validated addresses, with the original hostname kept for TLS SNI and the `Host` header). Checking the name and then letting the HTTP client re-resolve is forbidden: that is DNS rebinding.
- Deny list, IPv4: `0.0.0.0/8`, `10.0.0.0/8`, `100.64.0.0/10`, `127.0.0.0/8`, `169.254.0.0/16` (includes `169.254.169.254` cloud metadata), `172.16.0.0/12`, `192.0.0.0/24`, `192.0.2.0/24`, `192.88.99.0/24`, `192.168.0.0/16`, `198.18.0.0/15`, `198.51.100.0/24`, `203.0.113.0/24`, `224.0.0.0/4`, `240.0.0.0/4`, `255.255.255.255/32`.
- Deny list, IPv6: `::/128`, `::1/128`, `::ffff:0:0/96` (IPv4-mapped: **classify by the embedded IPv4**), `64:ff9b::/96` and `64:ff9b:1::/48` (NAT64: classify the embedded IPv4), `100::/64`, `2001::/23` (includes Teredo, benchmarking), `2001:db8::/32`, `2002::/16` (6to4: classify the embedded IPv4), `fc00::/7`, `fe80::/10`, `ff00::/8`, plus the AWS IPv6 metadata address `fd00:ec2::254` (covered by `fc00::/7`, tested explicitly).
- Re-check on **every redirect hop**, and on the connected socket's `remoteAddress` after connect.
- HTTP(S) proxy environment variables (`HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`) and system proxy settings are **ignored**; the handler uses its own direct client.
- **Owner-only escape hatch:** `crawl.allowedPrivateCidrs` (default empty) lets the *machine's owner* deliberately permit specific ranges, for example to test against a local server or crawl their own intranet. It is read only from the local policy file, never from a job, the Coordinator or the environment of a remote party. Tests use it for `127.0.0.0/8`. It must be logged at startup as a fixed event, and the documentation must say it disables SSRF protection for those ranges.

**Redirects:** at most `maxRedirects` (hard cap 3), `Location` re-validated as a URL each hop, and **same-origin only** (same scheme-and-host-and-port; an `http` to `https` upgrade of the same host on the default ports is allowed). A redirect to another origin is **not followed**: the result is `outcome: REDIRECT` with `redirectTarget`, and PrivaSearch's frontier decides whether to crawl it. This keeps robots.txt, per-host politeness and dedup where the policy lives, and stops a redirect chain from turning a job into a walk across the web.

**Time:** connect 10 s, time to response headers 15 s, idle time between body chunks 10 s, whole request the smaller of the input `timeoutMs` and the node's hard cap. A trickling ("slowloris") response therefore cannot hold the job.

**Size and decompression:** response header block at most 16 KiB. The compressed download is capped at `maxBodyBytes` (at most 1 MiB); the **decoded** body is capped at `maxBodyBytes` too; decoding is streamed and aborted the moment the cap is hit; and the decoded-to-compressed ratio is capped (abort if it exceeds 100:1 after the first 64 KiB) to defeat decompression bombs. Allowed `Content-Encoding`: `identity`, `gzip`, `deflate`, `br`, a single layer only. Anything else is `PROTOCOL` failure.

**Content types:** `text/html`, `application/xhtml+xml` and `text/plain` (a later, separate mechanism can add sitemaps). Anything else yields `UNSUPPORTED_CONTENT_TYPE` after the headers, and the body is never read. `Content-Type` is checked on the actual response, not the URL's extension. No content sniffing beyond that.

**Request the node sends (fixed, not caller-supplied):** `GET`, `Host`, `User-Agent: PrivaSearchBot/1.0 (+<owner-configured contact URL>)` (the node refuses to enable the capability without a contact URL in policy), `Accept: text/html,application/xhtml+xml;q=0.9,text/plain;q=0.5`, `Accept-Encoding: gzip, br`, and `If-None-Match` / `If-Modified-Since` **only** from the regex-validated `validators`. No `Cookie`, `Authorization`, `Referer`, `Origin`, custom or forwarded headers, ever. No cookie jar. HTTP/1.1 only. TLS certificate verification is mandatory and there is no option to disable it.

**robots.txt (enforced in the handler, RFC 9309):**

1. Before the page request, the handler determines the verdict for the URL's origin using the token `PrivaSearchBot`, falling back to `*`. It fetches `<origin>/robots.txt` through **the same guarded fetcher** (same SSRF, size, time and decompression bounds; the file is parsed only up to 500 KiB).
2. Results are cached **in memory only** per origin for at most 24 hours (shorter if `Cache-Control` says so), bounded to 1,000 origins (LRU).
3. `2xx`: parse and apply. `4xx` (including 404): no restrictions. `5xx`, timeout or network failure: `ROBOTS_UNAVAILABLE`, and the page is **not** fetched (RFC: assume complete disallow while unreachable). Redirects for robots.txt follow the same same-origin rule.
4. `Disallow` means `ROBOTS_DISALLOWED` and no page request is made. `Crawl-delay` is reported in the result and honoured by the node's own limiter up to a 30 s ceiling.
5. `X-Robots-Tag` and `<meta name="robots">` (`noindex`, `nofollow`, `noarchive`) are reported in `indexing`.
6. There is no way for a job to skip any of this.

**Per-host and overall rate limiting:** PrivaSearch's frontier is the **primary** limiter and should keep at most one in-flight request per host, honour `Crawl-delay`, and back off on 429/5xx. The node adds a **defence-in-depth** limiter in memory: a minimum delay per host (default 1 s, raised by `Crawl-delay`), and an owner-policy cap on total requests per minute (default 60). When either says "too soon" the handler returns `outcome: RATE_LIMITED` with `retryAfterSec` immediately instead of sleeping, so a slot is never held waiting. Because limiter state is in memory, a restart forgets it; that is why the frontier's own per-host control matters. With several nodes, only the frontier can bound the *aggregate* load on one host.

**Parser hardening:** the HTML tokenizer is streaming, bounded to `maxBodyBytes`, with maximum nesting depth and token counts, and no entity expansion beyond the standard named and numeric references. It executes nothing and follows nothing.

## 8. Application identity and permissions

- PrivaSearch authenticates as an ordinary **application**: `npm run admin -- application privasearch-demand` with `PRIVANET_JOB_TYPES=privasearch.crawl.v1`, giving a scoped bearer credential that is returned once, stored only as a hash by the Coordinator, and rotatable in place (`rotate-application`) or revocable.
- **Least privilege:** the credential's `allowedJobTypes` contains `privasearch.crawl.v1` and nothing else (not echo, not hashchain). The Coordinator rejects any other type with 403 `JOB_TYPE_FORBIDDEN`. It has no admin or node routes.
- **Two credentials from day one:** `privasearch-demand` and `privasearch-public`, one per queue. Both use the same job type, but separate identities give separate queue quotas (`PRIVANET_MAX_PENDING_PER_APP`), separate revocation, and a clean attachment point for the Phase 9 treasury (a public-good payer is an application identity with a budget). No treasury or credit logic is built now.
- **Node side:** an enrollment grant with capability `privasearch.crawl.v1`; the node owner must also enable it locally (`PRIVANODE_CAPABILITIES`) and supply the `crawl` policy including the contact URL. Nodes that do not enable it never receive crawl jobs.
- The credential is secret configuration for PrivaSearch (`PRIVANET_APP_TOKEN` in its private environment, never logged, never committed).

## 9. What the Coordinator sees

The Coordinator (and the operator who runs it) sees, for every crawl job: the **full target URL**, the idempotency key, timing, the node that ran it, and the whole result (final URL, status, content type, hashes, robots verdict, page digest with a text excerpt and outlinks). It does **not** see the raw page, cookies, request/response headers beyond the allowlisted fields, resolved IPs or the robots.txt body. Job rows live until the retention period ends (default 30 days).

Consequences to state plainly: a Coordinator operator can learn which URLs are being crawled and read the digests. For the demand queue, URLs derived from user searches could reveal user interest, so PrivaSearch must not put user identifiers or queries in job input, should decouple crawling from the moment of a search (queue, jitter and batch), and the deployment should set a short `PRIVANET_RETENTION_MS` (for example one hour) because PrivaSearch stores what it needs itself right after `waitForResult`. A per-application or per-type retention override is a recommended PrivaNet change (section 14).

## 10. What must not be persisted unnecessarily

| Data | Rule |
| --- | --- |
| Raw response bodies, full HTML | Never stored by the node, never returned. Only the bounded digest exists. |
| robots.txt body | Never returned; only its SHA-256 and parsed verdict. Node caches parsed rules in memory only. |
| Cookies, `Set-Cookie`, request/response headers | Never stored or returned (allowlisted fields excepted). |
| Resolved IP addresses, TLS certificates | Not returned, not logged. |
| URLs in node or Coordinator logs | **Never logged.** Logs keep fixed event names and codes only, as today. |
| User identifiers, search queries, session data | Must never enter a job. |
| Per-host limiter state, robots cache | Memory only; lost on restart by design. |
| Digest and results | Kept by the Coordinator only until retention ends; PrivaSearch should copy what it needs and let the rest expire. |

## 11. Preventing crawl nodes from becoming proxy or exit nodes

This is the central risk of putting a fetch capability on community machines. Layers, all of which must hold:

1. **The job type is not expressive enough to proxy.** Fixed method and headers, no body, no ports beyond 80/443, no IP literals, no private ranges, no cross-origin redirect following, allowlisted content types, and results that are a small digest, never the response. You cannot use it to reach a service, tunnel a protocol, or exfiltrate a response.
2. **Only the PrivaSearch application credentials may submit it.** No other application is granted the type. An attacker needs a stolen PrivaSearch credential, which the owner can revoke.
3. **The node owner opts in twice** (enrollment grant capability plus local capability plus a `crawl` policy with a contact URL), and can turn it off at once by removing the capability or draining.
4. **Volume limits on the node**: per-host delay and overall requests per minute in owner policy, plus bandwidth and monthly allowance through the existing transfer meter.
5. **robots.txt is enforced at the node**, which also gives site owners a working opt-out.
6. **Residual risk, stated honestly:** a compromised PrivaSearch credential or scheduler could still direct nodes to make GET requests, with a fixed identifiable user agent, to *public* URLs of its choosing at the allowed rate, from the node owner's IP address. That can be misused for low-volume scanning or annoyance, and node owners may face abuse complaints. Community-node deployment (Phase 10) must therefore add: Coordinator-side per-application and per-host request budgets, host-level concurrency limits in the scheduler, node-side audit counters (counts by hashed host, no URLs), an owner-visible disclosure that the node makes requests from their address, and possibly an owner allow-list mode. A malicious *node* is a different threat: it can fabricate or omit results (index poisoning); see section 13.
7. **Not a general proxy, ever.** Any proposal to add methods, custom headers, non-standard ports, IP targets or raw responses is a new job type with its own review, not a change to this one.

## 12. MVP: crawl with exactly one local PrivaNode

Sequence (the first two steps are PrivaNet-Core work; the rest are PrivaSearch):

1. **PrivaNet-Core: contract.** Add the `privasearch.crawl.v1` schemas and registry entry (section 3, 4, 6) with tests (size bound, strictness, every rejected field). Add a SSRF/URL-policy module and its exhaustive test corpus **before** any network code.
2. **PrivaNet-Core: fetcher and handler.** Guarded fetcher (DNS pinning, redirects, limits, decompression), robots, politeness, digest, `crawl` owner policy, handler wired into `defaultHandlers`, tested against local HTTP servers (allowed via `allowedPrivateCidrs: ['127.0.0.0/8']` in the test policy only). Real preemption test (abort mid-body). Release as a pre-release tag until PrivaSearch proves it.
3. **PrivaSearch repo skeleton**: Node 24, TypeScript, tests, its own docs; depends on `@privanet/sdk` only; no import of PrivaNet internals. Config: Coordinator URL and app token from the environment.
4. **Frontier**: SQLite, URL normalisation, per-host queues with one in-flight request per host, crawl-delay, backoff, dedup by canonical URL and content hash, seed list, two queues (demand/public) mapped to two application credentials.
5. **Crawl driver**: submit `privasearch.crawl.v1` through the SDK, poll (respecting the SDK's bounded polling), ingest results, handle every `outcome`, schedule recrawl with validators.
6. **Store and minimal index**: SQLite FTS5 over digests. A trivial search API. Measure.
7. **Milestones** with measurements, not assumptions: 1,000 pages, then 10,000, 100,000. At roughly one to three pages per second per node (one slot), 100,000 pages is on the order of a day on one node; that is enough to learn before optimising.
8. Only then: `privasearch.parse.v1`, metasearch fallback, ranking work, multi-node redundancy, and the PrivaNet changes below for scale.

## 13. Trust model for results

Nodes are untrusted. A malicious node can lie about page content, omit links, or serve poisoned text to distort the index. Design consequences:

- The MVP with one operator-owned local node is trusted by construction.
- Before third-party nodes crawl, PrivaSearch needs verification: redundant crawls of a sampled fraction through different nodes compared by `contentSha256` and digest, per-node disagreement statistics, and quarantine of nodes that disagree. PrivaNet may later provide node reputation and job affinity/exclusion hints; until then these are PrivaSearch-level controls.
- Treat all digest text as **untrusted data**: never interpret it as instructions or markup, escape on display, and apply your own limits.
- PrivaNet gives no execution attestation. Passing tests or schema validation proves shape, not honesty.

## 14. PrivaNet-Core changes required

Required for the MVP (steps 1 and 2 above):

1. **Registry entry and schemas** for `privasearch.crawl.v1` in `packages/protocol` (input, output, resource estimate), including the serialized-size refinement. SDK typing follows automatically from the registry. Version bump (`0.3.0` pre-releases until PrivaSearch validates it).
2. **Node crawl module and handler** (`apps/node`): URL policy, SSRF-safe DNS-pinned fetcher, redirect/time/size/decompression bounds, robots.txt, politeness limiter, digest extractor, owner `crawl` policy (`contactUrl` required, `denyHosts`, `allowHosts`, `minHostDelayMs`, `maxRequestsPerMinute`, `allowedPrivateCidrs`), handler using `context.transfer`. No new runtime dependency is required (Node's built-in `net`, `dns`, `http`, `https`, `zlib`); adding one would need a supply-chain review.
3. **Tests**: an SSRF corpus (every deny range, IPv4-mapped and NAT64/6to4 forms, numeric host tricks, DNS rebinding with a resolver that changes answers, redirects to private targets, redirect to another origin), decompression-bomb, slow-body, oversized-header, wrong content type, robots (allow, disallow, 404, 5xx, huge file, redirect), rate limiting, preemption mid-fetch, and an end-to-end SDK to Coordinator to node run against a local test server. Add the type to the release-readiness tests.
4. **Security documentation**: promote the section 11 residual-risk text into `docs/security.md` when implemented (the planned threat rows are already there).

Strongly recommended soon after, and **required before untrusted or public nodes**:

5. **Job cancellation** (`POST /v1/jobs/{id}/cancel`, `CANCELLED` state, cancel flag delivered through renewal, SDK method).
6. **Per-application or per-type retention** (short retention for crawl jobs) and optionally result scrubbing after acknowledgement.
7. **Scheduler host-concurrency hint** (a registry-level concurrency key so two jobs for one host are not leased at once) and Coordinator-side per-application request budgets.

Later, as measured need appears: multi-slot nodes (`jobSlots` is fixed at 1 today), batch job status polling, node reputation, a `blobRef` result field once Phase 4 storage exists, and `privasearch.parse.v1`.

No protocol hook is added now: adding the registry entry without its handler would advertise a capability that does not exist and would break the registry/handler lockstep test.

## 15. Open decisions (recommendation first)

- **Where the crawl handler lives.** Recommended: in PrivaNet-Core's node, registered centrally, because it is a security boundary that node owners must be able to review in one place. Alternative: an operator-installed handler-plugin mechanism so PrivaSearch could ship its own; that widens the trust boundary (third-party code in the node) and is not recommended before a review.
- **Digest extractor location.** Recommended: keep it minimal in the node until Phase 4 gives a data plane; then move rich parsing to PrivaSearch and use `privasearch.parse.v1`.
- **Sitemaps and feeds** are separate content types and a separate job or mode later, not part of `crawl.v1`.
- **`HEAD`** is deliberately not used; `PROBE` opens a GET and drops the body, so behaviour and robots handling stay identical.
- **JavaScript rendering** is out of scope and stays out unless a separate, sandboxed job type is designed and reviewed.

## 16. Ready-to-paste opening prompt for the PrivaSearch repository

```text
You are starting PrivaSearch, a NEW, separate repository. It is an independent web search engine and the first real external application consumer of PrivaNet. Do not modify PrivaNet-Core, PrivaDrive or Privaproxy (read-only references).

Read first, in the PrivaNet-Core repository (github.com/doopydoop364/PrivaNet-Core, branch main): docs/PRIVASEARCH_INTEGRATION.md (your specification), ROADMAP.md (Phase 3), docs/protocol.md, docs/security.md, docs/TREASURY.md (public vs demand crawl queues). PrivaNet-Core is v0.2.1: Phases 1 and 2 complete; the privasearch.crawl.v1 job type is specified but NOT yet implemented in PrivaNet-Core, so build against the specified schema and a local fake until the PrivaNet side ships.

Rules:
- PrivaSearch depends on @privanet/sdk only. Never import PrivaNet internals. Every crawl goes SDK -> Coordinator -> authenticated PrivaNode, even on one machine. No local fetch bypass.
- Node 24.4+, TypeScript strict ESM, Zod 4 strict schemas, node:test, ESLint, SQLite via node:sqlite. Keep dependencies minimal. Never commit secrets; never log credentials or URLs of users.
- Do NOT build metasearch, ranking, distributed storage, credits, market or treasury logic in the first milestones.
- Authenticate as an application with allowedJobTypes limited to privasearch.crawl.v1. Use two credentials: privasearch-demand and privasearch-public (two queues). Token comes from the environment.
- Never put user identifiers or search queries into a job input. Encode the frontier entry in the idempotency key, e.g. crawl:<sha256(url)[0:32]>:<generation>.
- Treat every crawl result as untrusted data from an untrusted node: validate with the SDK types, escape on display, never execute or interpret it.
- The frontier owns politeness: one in-flight request per host, honour crawl-delay and Retry-After, exponential backoff, robots caching; PrivaNode's limits are defence in depth only. Handle every result outcome (FETCHED, NOT_MODIFIED, REDIRECT, ROBOTS_DISALLOWED, ROBOTS_UNAVAILABLE, BLOCKED_TARGET, RATE_LIMITED, UNSUPPORTED_CONTENT_TYPE, TOO_LARGE, HTTP_ERROR, FETCH_FAILED). Cross-origin redirects come back as REDIRECT for the frontier to schedule, not followed by the node.

First tasks:
1. Repo skeleton, CI (Linux, macOS, Windows), README stating what is and is not implemented, docs/architecture.md.
2. A typed crawl client wrapping @privanet/sdk with a fake in-process PrivaNet (or a local test double implementing the specified schema) so the frontier can be developed and tested before the real job type exists.
3. URL normalisation and the SQLite frontier (per-host queues, dedup, seeds, two queues).
4. The crawl driver and result ingest, with tests for every outcome.
5. A minimal SQLite FTS5 index and search API over page digests.
Then measure against milestones of 1,000, 10,000 and 100,000 pages using exactly one local PrivaNode, and report throughput, error rates and what PrivaNet should change. Stop and ask before adding any dependency, any new job type, or anything that widens what a node may fetch.
```
