# Deployment: TLS, reverse proxy, backup and recovery

Status: operator guidance for the v0.2.1 Coordinator. The Coordinator is a single-process service with a SQLite store; this is a small-deployment runbook, not a high-availability design. The configuration examples are starting points that were reviewed against the code but **not** load-tested or exercised against a real internet-facing proxy in this repository's CI.

## What the Coordinator does and does not do

| Concern | Behaviour |
| --- | --- |
| TLS | None. It speaks plain HTTP. A non-loopback bind is refused unless `PRIVANET_TLS_TERMINATED=true`, which only acknowledges that a proxy terminates TLS. |
| Client verification | Nodes and SDKs require HTTPS (plain HTTP only for literal loopback with an explicit flag), refuse redirects, and a node pins the exact Coordinator URL and ID on first contact. |
| Limits | Bodies ≤ 32 KiB, responses ≤ 512 KiB, request timeout 10 s, header timeout 5 s, keep-alive 5 s. |
| Rate limiting | Only authentication attempts, per connecting address (default 120 per minute, `PRIVANET_AUTH_REQUESTS_PER_MINUTE`). |
| Forwarded headers | Ignored on purpose (`X-Forwarded-For` is never trusted). |
| Queue and retention | `PRIVANET_MAX_PENDING_PER_APP` (default 10000) rejects further submissions with 429 `QUEUE_LIMIT`; `PRIVANET_RETENTION_MS` (default 30 days, 0 = keep forever) deletes finished jobs and their results. After retention a duplicate submission with an old idempotency key creates a new job, so keep retention longer than your clients' retry window. |

## Reverse-proxy review findings

1. **All clients share the proxy's address.** Because forwarded headers are ignored, the per-address authentication limit sees every client as the proxy. One abusive client can exhaust the shared budget and lock everyone out of authentication. Do the real per-client limiting at the proxy, and raise `PRIVANET_AUTH_REQUESTS_PER_MINUTE` to a value the proxy's own limit keeps safe. Do not expose the Coordinator listener to anything except the proxy.
2. **The plain listener must be unreachable.** Bind to `127.0.0.1` behind a proxy on the same host, or to a private interface with a firewall rule that admits only the proxy. `PRIVANET_TLS_TERMINATED=true` is required only when binding off-loopback.
3. **Admin routes should not be public.** `/v1/admin/*` is protected by the admin secret, but there is no reason to expose it to the internet; restrict it at the proxy to an operator network or a VPN, or reach it over `127.0.0.1`.
4. **Keep the proxy's limits at or below the Coordinator's**: body 32 KiB, request timeout about 10 s. Do not buffer unbounded bodies, do not follow or issue redirects for `/v1`, and pass the `Host` header unchanged.
5. **Certificates.** Use a publicly trusted certificate (or a private CA that every node and SDK trusts through the normal OS/Node trust store). A node that saw a different Coordinator ID or URL refuses to run until the operator recovers it deliberately.
6. **Logs.** Proxy access logs record addresses and paths but must not record request or `Authorization` header bodies. Coordinator logs contain only event names and codes.

### Caddy example

```caddyfile
privanet.example.org {
    @admin path /v1/admin/*
    handle @admin {
        @operators remote_ip 203.0.113.0/24
        handle @operators { reverse_proxy 127.0.0.1:4010 }
        respond 403
    }
    request_body { max_size 32KB }
    reverse_proxy 127.0.0.1:4010 {
        transport http { response_header_timeout 15s }
    }
}
```

### nginx example

```nginx
limit_req_zone $binary_remote_addr zone=privanet:10m rate=20r/s;
server {
    listen 443 ssl;
    server_name privanet.example.org;
    client_max_body_size 32k;
    client_body_timeout 10s;
    location /v1/admin/ { allow 203.0.113.0/24; deny all; proxy_pass http://127.0.0.1:4010; }
    location / {
        limit_req zone=privanet burst=40 nodelay;
        proxy_pass http://127.0.0.1:4010;
        proxy_redirect off;
        proxy_read_timeout 15s;
    }
}
```

Set `PRIVANET_HOST=127.0.0.1` for both. If the proxy is on another host, bind a private interface and set `PRIVANET_TLS_TERMINATED=true`.

## Backup

`npm run backup -- <destination-file>` takes a consistent online backup of the Coordinator database (SQLite `VACUUM INTO`, safe while the Coordinator runs), refuses to overwrite an existing file, sets owner-only permissions, and verifies the copy with `PRAGMA integrity_check`. It reads `PRIVANET_DATA_DIR` (default `./var/coordinator`). The backup contains job data, node records and credential *hashes* (secrets are never stored in the clear), so protect it like the live database and encrypt it at rest and in transit.

Also back up separately and securely: the admin secret (kept in your secret store, not in the database), and each node's state directory (`identity.json` and `node-state.json`). Sessions are not stored on the node, and nodes hold no Coordinator secrets.

## Recovery

1. Stop the Coordinator.
2. Move the damaged `coordinator.sqlite` and any `-wal`/`-shm` files aside (do not delete them until the recovery is verified).
3. Copy the backup to `<PRIVANET_DATA_DIR>/coordinator.sqlite`, owner-only (mode `0600` on POSIX).
4. Start the Coordinator with the same URL and the same admin secret. It keeps the same Coordinator ID (stored in the database), so nodes accept it and re-authenticate with their existing keys.
5. Anything accepted after the backup is lost. Applications retry with their idempotency keys; nodes' expired leases are requeued, and old lease IDs cannot commit results.

The automated test `online backup restores into a working Coordinator with the same identity, results and pending work` exercises this path. **What has not been rehearsed:** restoring onto a different host, a torn or truncated backup file from a failed copy (the integrity check catches it at backup time, not at restore time), or recovery from a backup made by a different schema version (the store refuses a newer database and applies migrations to an older one). Run a restore rehearsal on your own hardware before relying on it.

## Node key rotation

Nodes have no in-place key rotation. To replace a node key: revoke the node with `npm run admin -- revoke-node NODE_ID`, delete its state directory, and enroll it again with a fresh enrollment grant. Application credentials rotate in place (`rotate-application`). In-place node-key rotation is tracked with credential rotation in Phase 10.

## Not covered

High availability, multiple Coordinators, PostgreSQL, and an independent security review are not part of this runbook. See the roadmap (Phases 8 and 10 for the storage backend, Phase 11 for the independent review).
