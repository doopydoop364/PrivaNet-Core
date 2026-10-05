# Direct opaque chunk transfer — v0.4.0-alpha.4

Alpha.3 moves chunk bytes directly between an authorized application and a storage node. The Coordinator issues placement/tickets and receives metadata/receipts; it never proxies, buffers, inspects or relays chunk bodies. Storage capacity and the TLS listener are separate opt-ins, both off by default. Local applications use this same path. Core stores opaque chunks, not files or folders. Replication, repair and possession challenges belong to Phase 5; PrivaDrive manifests, encryption and sharing remain application concerns. No NAT traversal, hole punching or relay is included.

## Operator setup

Configure the existing owner policy through `privanet-node policy export/import` or the local panel. Administrator environment overrides saved settings, then defaults; `PRIVANODE_POLICY_LOCKED` retains its existing meaning. Presets preserve storage settings and never enable transfer implicitly.

```json
{
  "storage": {
    "enabled": true,
    "maxBytes": 1073741824,
    "reserveFreeBytes": 10737418240,
    "transfer": {
      "enabled": true,
      "bindAddress": "127.0.0.1",
      "port": 4050,
      "endpoint": "https://127.0.0.1:4050",
      "certificateFile": "/absolute/path/node.crt",
      "keyFile": "/absolute/path/node.key",
      "maxConcurrent": 8,
      "maxConcurrentPuts": 2
    }
  }
}
```

This is a policy fragment; merge it into your exported policy. The private key must be an owner-private regular file, without a symlink. The certificate may be self-signed or privately issued, must be currently valid, and must match the private key. Alpha.4 can generate a node-local LAN certificate; distribution, public issuance and renewal scheduling remain operator responsibilities. Keep certificate files outside the generic chunk store. Use `privanet-node config check`, `settings --json`, `storage status --json` and the running node's `status`/panel to inspect configuration and live listener/activity/receipt state. No secret contents are read through the panel or bundled for support.

Environment overrides: `PRIVANODE_TRANSFER_ENABLED` (`true`/`false`), `PRIVANODE_TRANSFER_BIND` (literal IPv4/IPv6), `PRIVANODE_TRANSFER_PORT`, `PRIVANODE_TRANSFER_ENDPOINT` (canonical HTTPS origin, no credentials/path/query/fragment), `PRIVANODE_TRANSFER_CERT_FILE`, `PRIVANODE_TRANSFER_KEY_FILE`, `PRIVANODE_TRANSFER_CONCURRENCY` (1–64), `PRIVANODE_TRANSFER_PUTS` (1–8, no greater than total concurrency). Bandwidth and monthly allowance reuse `maxBandwidthBytesPerSec` and `monthlyTransferBytes`; there is no competing transfer budget. Full attempted sizes are reserved durably before streaming, so failed attempts are conservatively charged. Corrupt allowance state refuses further transfer and is never silently reset.

The listener binds only the configured address. Advertise the origin applications can actually reach, with an explicit firewall/port forward if needed. A valid advertisement proves certificate-key possession and validates URL syntax, not Internet reachability; the Coordinator never probes arbitrary advertised hosts. Disabling storage/listener withdraws the endpoint, aborts direct activity and retains committed data. Pause, drain, schedule-off, disabled battery and busy-disk policy refuse **all network operations**, unlike the local ChunkStore library's write-only gate. Running transfers recheck the owner gate on each streamed piece and through a one-second watcher.

To renew a certificate, install a valid certificate/key, then restart the node (or change the configured paths and apply policy). The next successful heartbeat registers the new leaf fingerprint/proof. Existing grants retain their original pin and fail safely after rotation; request a fresh grant. A stale heartbeat or changed endpoint never authorizes an application-selected substitute. No automatic certificate management or fallback to Web PKI identity is provided.

## Application use

An administrator grants only the application credential it needs:

```sh
privanet-admin application my-application --services storage.chunk.v1
```

Existing applications receive no storage authority automatically. Use the application credential, never an administrator credential:

```js
const client = new PrivaNetClient({ url: coordinatorUrl, token: applicationToken });
const chunkId = await client.store(bytes); // Uint8Array, 1 byte through 8 MiB
const identicalBytes = await client.fetch(chunkId); // Buffer, independently SHA-256 verified
await client.delete(chunkId); // absent chunk is success
```

Each helper creates a fresh Ed25519 holder key, requests `directTransfer: true`, obtains the Coordinator-selected endpoint/certificate, completes the holder exchange, transfers over pinned TLS and checks the outcome. `store` waits for authoritative STORED metadata; `delete` waits for metadata removal. `signal` and `timeoutMs` bound the whole helper (default 300 seconds, maximum 600 seconds). `store` optionally accepts `chunkId` for validation and an opaque `class` label. Fixed errors include `TRANSFER_UNAVAILABLE`, `TLS_IDENTITY`, `TRANSFER_AUTHORIZATION`, `TRANSFER_GRANT`, `TRANSFER_BUSY`, `TRANSFER_FAILED`, `TRANSFER_SIZE`, `TRANSFER_INTEGRITY`, `TRANSFER_TIMEOUT`, and `COMPLETION_PENDING`. A completion timeout is uncertain delivery; read metadata and retry authorization rather than replaying a consumed ticket.

## Final wire exchange

The entire node surface is HTTP/1.1 over TLS 1.2 or newer:

```text
PUT    /v1/chunks/chk_<64 lowercase SHA-256 hex>
GET    /v1/chunks/chk_<64 lowercase SHA-256 hex>
DELETE /v1/chunks/chk_<64 lowercase SHA-256 hex>
```

No listing, generic file server, arbitrary path, redirect, range, multipart, CORS or administrative API exists. A literal anchored path is checked without decoding; encoded/double-encoded paths, queries, alternate slashes and Unicode forms are refused. The platform TLS/HTTP parser rejects malformed requests and conflicting length/encoding; duplicate security headers, Transfer-Encoding and Range are refused explicitly. Host is never an authorization input.

1. Send the intended method and path with `Authorization: Transfer <alpha.2 binary ticket as base64url>`, `Content-Length: 0`, and `X-PrivaNet-Handshake: 1`. Tickets never occur in URLs. The node verifies structure/signature/kid/time/operation/chunk/target and the owner gate. It replies 401 with bounded JSON `{ "code": "HOLDER_CHALLENGE", "challenge": "<32 random bytes in hex>" }`. An existing unexpired challenge for the same transfer/request is returned; at most 1024 are retained for 10 seconds.
2. Repeat that **same** method/path and ticket with `X-PrivaNet-Challenge` and `X-PrivaNet-Proof`. The proof uses alpha.2's unchanged domain-separated challenge + transfer ID + request-line SHA-256 message (`METHOD /v1/chunks/chk_…`). The challenge is removed even on a bad proof. PUT requires `Content-Type: application/octet-stream` and an exact authorized Content-Length; GET/DELETE require length 0.
3. The node reserves concurrency, persists single-use replay consumption, obtains authenticated Coordinator begin approval for all verified ticket facts, reserves the owner network allowance, and durably records a write-ahead receipt intent before any protected operation. Coordinator refusal/disconnection permits no new operation. Before local commit it rechecks current application/node authorization with a metadata-only prepare call.
4. PUT streams with backpressure into the existing ChunkStore, counts bytes, verifies SHA-256, fsyncs and atomically commits in the application's UUID namespace. DELETE uses ChunkStore.delete and is idempotent when absent. Both return bounded 200 JSON after queueing completion and trying the receipt. Receipt delivery failure retains local data and retries durably. GET uses ChunkStore.get's complete at-rest integrity check before returning bytes and an `X-PrivaNet-Receipt-Challenge` header.
5. GET completion requires a signed acknowledgement after the SDK checks exact length and SHA-256: a zero-body GET to the same path/ticket with `X-PrivaNet-Ack: 1`, the response challenge and a holder proof over that same request line/transfer. The challenge is fresh and usable only once for completion, with idempotent repeat acknowledgements for 30 seconds after the response finishes. A verified in-progress read keeps its exact ticket hash and holder binding: ticket expiry or signing-key retirement does not reopen authorization or invalidate completion of that same read. Active streams retain their waiter through the operation deadline; new transfers still require a currently valid ticket/key. It is a separate domain instance because it uses a different unpredictable challenge. Early acknowledgements fail until every response byte has been queued. A disconnected or unacknowledged read fails; writing to the kernel alone never completes a GET.

The SDK uses the grant's exact leaf certificate as an explicit trust anchor (`allowPartialTrustChain`), ordinary TLS validity/signature checks, and a custom exact SHA-256 peer-leaf check. It never sets `rejectUnauthorized: false`, follows redirects, consults proxy settings or trusts ambient CAs to select storage identity. The endpoint includes the certificate DER, fingerprint and a certificate-private-key signature bound to node ID, canonical origin and fingerprint (`privanet.transfer-endpoint.v1` domain). This prevents an enrolled malicious node copying another service's public certificate to induce credential-bearing SSRF. DNS substitution cannot complete pinned TLS without that private key. A malicious advertisement can still induce an unsuccessful TLS connection attempt; it cannot authorize HTTP or chunk delivery to a host lacking the pinned key.

## Durable state and reconciliation

`transfer-replay.json` holds consumed transfer IDs through expiry plus the 30-second skew window, at most 4096 entries. Concurrent consumption is batched; the caller awaits atomic private snapshot fsync/rename (and POSIX parent fsync) before beginning. Expired IDs are removed during subsequent consumption. Checksummed/strict/corrupt/unsafe state or persistence failure refuses transfers without clearing history. The node is the sole owner of its state directory; concurrent processes must not share it.

`transfer-receipts.json` holds at most 4096 checksummed private PREPARED/COMPLETED/FAILED records. The PREPARED intent closes the crash gap before a local commit. Startup and bounded retries reconcile inactive intents by full ChunkStore integrity verification/presence: verified PUT becomes completed; absent DELETE becomes completed; unacknowledged GET fails. Commit directory ancestry is flushed before recovered evidence is acknowledged. Exact duplicate completion is idempotent; conflicting/reordered/final receipts cannot revive a transfer. A failed receipt cannot overwrite completion.

Authenticated node routes are `POST /v1/node/storage/transfers/{id}/begin|check|prepare|fail` and `POST /v1/node/storage/receipts`. Begin carries bounded ticket facts (not the raw ticket), checked against persisted authorization; check/prepare carry `{}`; fail carries one fixed reason. Receipts bind transfer/application/chunk/operation/node/verified bytes/digest and node completion time. Node sessions are the existing authentication system. Applications cannot supply completion evidence. A COMMIT_PREPARED transfer retains its reservation for a maximum seven-day reconciliation window rather than expiring after the normal ten-minute progress grace. The receipt worker uses 2–120-second bounded backoff, survives restart and never deletes chunk data on lost acknowledgement. Definitive rejection or seven-day exhaustion drops queued evidence and emits a fixed diagnostic; revoked/abandoned data remains charged to the owner's quota. There is no garbage collection, possession challenge or repair in this milestone.

Keys refresh at most every 30 seconds during direct listener activity/offer heartbeats, and valid-looking unknown kids trigger a best-effort refresh with one global five-second budget and exponential outage backoff to 120 seconds. Refresh is single-flight. Valid cached overlap keys survive temporary outages; successful lists replace them and retired keys remain constrained by `notAfter`. Unknown keys never authorize when refresh fails. A separate authenticated `GET /v1/node/transfer-clock` supplies a Coordinator-bound midpoint clock estimate (accepted only with round trip <=5 seconds); ticket/replay/receipt time uses that estimate and alpha.2's 30-second permitted skew. Old Coordinator key/session responses remain unchanged.

## Bounds and evidence

Per listener: 128 connections; 4 KiB headers; 32 retained headers; five-second TLS/headers timeout; ten-second socket idle timeout; 300-second operation timeout; 200 requests/second globally and 100 per IP across a bounded 256-IP map. Owner limits further bound active transfers and PUTs. GET acknowledgement waiters count against concurrency, expire after 30 seconds, and use bounded state. Streaming rate limiting uses bounded one-second cancellable waits, observes live rate changes, and uses backpressure; no event-loop sleep or full upload buffer is introduced. SDK GET buffering is bounded to one authorized chunk (maximum 8 MiB).

Aggregate status reports listener state and recent Coordinator acceptance of the exact advertised endpoint/certificate (not a reachability probe), fixed errors, active operation counts, completion/failure totals, bytes/lifetime average throughput, queued receipts and last acknowledgement. No chunk/application/transfer ID is a metric label. Private keys, holder keys/proofs/challenges, raw tickets and headers are never logged or included in panel/support data.

Protocol stays 1. Only requests explicitly opting into direct transfer receive endpoint fields; alpha.2 strict consumers retain their grant shapes. Older compute nodes keep existing sessions/heartbeats/jobs. A newer node against a Coordinator refusing the new storage offer withdraws services and continues compute; absent control capability never opens a trust bypass. Migration 3 adds a nullable endpoint JSON column without modifying migrations 1/2. Downgrade requires restoring an older database backup.

Validation: [ALPHA3_IMPLEMENTATION_STATUS.md](ALPHA3_IMPLEMENTATION_STATUS.md) records actual results, limitations and throughput. The required three-host namespace test instruments all Coordinator plaintext request/response bodies and namespace packet counters; it asserts zero payload canaries, bounded metadata bodies and total traffic far below a single chunk. Tests establish particular behavior, not absence of vulnerabilities. An independent external security review remains outstanding.

## Alpha.4 storage operations

Run local commands as the **same account** and with the **same state directory** as the service. Installed Linux example: `sudo -u privanet-node env PRIVANODE_STATE_DIR=/var/lib/privanet-node /opt/privanet-node/current/bin/privanet-node ...`. Environment overrides used by systemd are not automatically inherited by a terminal; the recent daemon snapshot is authoritative for live storage state. `settings`/`policy show` describe the command's environment, so use the service environment when inspecting overrides.

```sh
privanet-node storage capacity 500GiB
privanet-node storage reserve 100GiB
privanet-node storage cert generate --ip 10.0.0.201
privanet-node storage transfer bind 10.0.0.201
privanet-node storage transfer endpoint https://10.0.0.201:4050
privanet-node storage enable
privanet-node storage transfer enable
privanet-node storage status --json
privanet-node settings --json
privanet-node config check --json
# From the application/operator machine, against its trusted Coordinator:
privanet-admin storage probe NODE --json
privanet-admin storage status --json
```

Size input accepts B, KiB, MiB, GiB and TiB (case insensitive), including decimal fractions that produce exact whole bytes, from zero through 1 TiB (the existing policy ceiling). JSON reports exact bytes. No rounding, silent unit conversion or reserve reduction. To intentionally reduce the free-space safety reserve use `storage reserve SIZE --allow-reserve-reduction`; the panel asks explicitly. CLI edits preserve unrelated policy and retain `policy.json.bak`. Invalid saved policy is not overwritten by storage commands. A policy lock or explicit environment override cannot be changed through these commands. Capacity/transfer settings apply live within the existing polling interval; no restart is needed for these controls. Certificate file contents changed in place still require a restart; generated renewal uses fresh paths and applies live.

`storage disable` and `storage transfer disable` always retain committed chunks. Increasing/decreasing capacity or raising the reserve never deletes data. Below-usage capacity reports overcommit and refuses new writes; existing authorized reads/deletes work when other owner gates permit. Re-enabling opens the same store. Unfinished transfers may fail safely on disabling.

The panel Contribute form provides equivalent storage quota/reserve and transfer controls; Status shows planning, listener lifecycle, exact advertisement acceptance and fixed diagnostics. Neither has a chunk browser or arbitrary filesystem-edit API. `settings`/`policy show`/`config check` expose per-setting sources: defaults, installer-file, saved policy, environment. Transfer overrides show the saved value and overriding variable; key/certificate fields report presence, never contents.

### Status semantics

| Field | Meaning |
| --- | --- |
| `enabled`, `state`, `health` | Owner storage switch and local store condition; not network reachability |
| `observation.source`, `publishedAt` | Recent daemon snapshot, or read-only offline inspection; no future/stale snapshot is accepted |
| `transfer.configured`, `bindAddress`, `port`, `endpoint` | Transfer configuration in the observing daemon; offline uses the command environment |
| `transfer.listener` | DISABLED / STARTING / LISTENING / STOPPED / FAILED; UNKNOWN offline when configured |
| `transfer.coordinatorAdvertisement`, `acceptedAt` | Recent acceptance of the exact origin/leaf identity, pending, withdrawn, rejected, unsupported or unreachable |
| `transfer.remoteReachability` | UNKNOWN: neither bind nor metadata acceptance proves a route from another machine |
| `networkAccessible` | Deprecated and always null; use the explicit fields |
| `planning.overcommittedBytes` | Existing/incoming bytes over quota, retained rather than deleted |

CLI snapshots are refreshed every 10 seconds and accepted for at most 35 seconds; a daemon that just stopped can briefly leave a recent snapshot. The command labels the observation and timestamp. Offline counters for live transfers are unavailable, represented by a listener UNKNOWN and no daemon claim. Live lifetime transfer counters reset with the listener process; durable receipt and Coordinator counts survive.

Capacity planning uses:

```text
quota remaining = max(0, maxBytes - committedBytes - incomingBytes)
disk headroom = max(0, filesystem free - reserveFreeBytes - unwritten reserved bytes)
usable = min(quota remaining, disk headroom)
```

Incoming includes whole reserved writes and leftover partials. Already-written bytes are already absent from filesystem free; only **unwritten** active reservations are additionally subtracted. Owner pause/drain/schedule/battery/disk gates can reduce usable to zero. Reserve-constrained capacity is informational. Filesystem free is for the volume holding the state/store; no alternate arbitrary storage-directory setting is added.

### Certificates and diagnostics

`storage cert generate --ip IP [--renew]` requires OpenSSL on PATH. It creates a matching P-256 private key and one-year self-signed certificate with the IP SAN in a new versioned directory under private node state, flushes files, atomically publishes the directory, and saves certificate/key paths. It never prints secret contents. Existing configured keys require explicit `--renew`; old keys are retained, never overwritten. Windows privacy depends on the installed private state-directory ACL (real Windows service validation remains outstanding). Renewals require fresh endpoint registration and new grants; existing grants retain the old pin and fail safely. No public certificate issuance is provided.

Stable diagnostic `id` codes include `STORAGE_DISABLED`, `TRANSFER_POLICY_DISABLED`, `TRANSFER_ENDPOINT_MISSING/INVALID`, `TRANSFER_CERT_MISSING/UNREADABLE/SYMLINK/INVALID/EXPIRED/NOT_YET_VALID`, `TRANSFER_KEY_MISSING/UNREADABLE/SYMLINK/PERMISSIONS/OWNERSHIP/MISMATCH`, `TRANSFER_BIND_INVALID/FAILED`, `TRANSFER_PORT_IN_USE`, `REPLAY_STATE_INVALID`, `RECEIPT_STATE_INVALID`, `STORAGE_QUOTA_EXHAUSTED`, `STORAGE_OVERCOMMITTED`, `STORAGE_RESERVE_EXHAUSTED/CONSTRAINED`, owner-blocker codes and Coordinator REJECTED/UNREACHABLE/UNSUPPORTED codes. Fixed text gives the next action. No key, ticket, holder material, challenge, token or file contents enter findings. Port conflicts are diagnosed from actual daemon bind failure; an offline command does not temporarily occupy a port to guess.

`TRANSFER_ENDPOINT_BIND_DIFFERENT` is informational because a wildcard bind, DNS name or explicitly forwarded origin may legitimately differ. `TRANSFER_CERT_SAN_DIFFERENT` is informational because SDK identity is exact leaf pinning plus normal TLS validity/chain verification, not hostname discovery. Generated LAN certificates have the correct IP SAN for other operator tooling.

### Explicit probe and pool summary

`privanet-admin storage probe NODE` resolves a node by exact name/ID or unique prefix using the ordinary admin node registry. It requests the current online, fresh registered origin/leaf/proof, validates that node binding, performs one bounded TLS handshake with the **same shared TLS options as the SDK**, and rereads registration to detect changes. It sends no ticket, HTTP request or upload. Results distinguish `ADDRESS_FAILED`, `TCP_FAILED`, `TLS_IDENTITY_FAILED`, `ENDPOINT_INVALID`, `ENDPOINT_CHANGED` and `TLS_LISTENER_REACHABLE`. TLS success is scoped to this operator machine at that time; it is not a completed storage operation or a continuously persisted global reachability assertion. A disappeared registration refuses rather than substituting an endpoint. The Coordinator never probes origins itself.

The current admin CLI opts into `/v1/admin/storage?details=1`: online storage nodes, offline nodes holding recorded chunks, raw advertised bytes, currently usable reported room minus reservations, reserved/committed bytes, per-node recorded committed/lost bytes and endpoint-registration presence. Reported room minus Coordinator reservations is conservative: in-progress local reservations may already be reflected in the reported room. Reports are hints/metadata, not possession verification. Historical offers are removed by normal cleanup; retained replica metadata still exposes offline holders. Default `/v1/admin/storage` keeps the exact alpha.3 strict summary shape for old CLI/dashboard consumers. Aggregate output has no chunk/application ID or private data. Pool byte totals use JSON numbers within the safe-integer range and exact decimal strings above it; clients should accept the exported AggregateBytesSchema union. Per-node and local-policy byte limits remain numbers.
