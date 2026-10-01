# Remote node onboarding

Status: implemented (unreleased, after `0.3.0-alpha.6`). This is the enrollment and registry part of [Phase 3.5](../ROADMAP.md#phase-35--remote-node-onboarding--contributor-experience--partly-implemented). It makes adding a trusted machine a two-command job and gives the administrator a registry to see, name and withdraw nodes. It does **not** make enrollment public: the network owner still decides, one token at a time. Installers, short invite codes, an approval flow and a public hostname with a public certificate are still planned and are not here.

Nothing about what a node may do changes. A node still runs only the registered, typed, versioned handlers it was enrolled for (`web.fetch.v1` with its SSRF guard, the diagnostic jobs), under its owner's policy. There is no remote shell, no arbitrary script or container, no tunnel and no exit-proxy behaviour, and enrollment adds none.

## How it works

PrivaNet already authenticated nodes with a key pair rather than a password, and onboarding builds on exactly that: it is not a second authentication system.

```
administrator (on the Coordinator host, loopback only)        new machine
  privanet-admin enrollment create ...                          privanet-node enroll --coordinator https://HOST --token T
        │  one-time token T (shown once)                               │ makes its own Ed25519 key (identity.json, 0600)
        ▼                                                              │ GET /v1/health ─────────────► pins the Coordinator ID
  Coordinator stores only SHA-256(T)                                   │ POST /v1/enrollment/challenge {T, public key, ...}
  + id, created, expires, label, capabilities                          │      ◄── a one-use, expiring challenge bound to the key
                                                                       │ POST /v1/enrollment/proof {signature of the challenge}
  in ONE transaction: the token is checked again,                      │
  the node is registered, the token is marked used ───────────────────►│ ◄── a short-lived session
                                                                       │ writes enrollment.json (0600): Coordinator, node ID, capabilities
                                                                       ▼
                                              later: `privanet-node` signs a fresh challenge with the same key; no token
```

The node's credential is its **private key**. It is generated on the node and never leaves it, so there is no long-lived secret for the Coordinator to hand back, and nothing to intercept, log or leak in transit. The Coordinator keeps only the public key. A session token is issued per login and expires (default five minutes); the node renews it by signing a new challenge.

### What is stored where

| Where | What | Protection |
| --- | --- | --- |
| Coordinator database, `grants` | SHA-256 of the token, expiry, capabilities, label, created, used-at, used-by node, revoked-at | the token itself is never stored; the file is `0600`; lists show an ID, never the token or its hash |
| Coordinator database, `nodes` | public key, node ID, name, capabilities, enrolled-at, revoked-at, last heartbeat | the same file; no secret |
| Node `identity.json` | the private key | `0600` in a `0700` directory the node owner owns; a link, a looser mode or another owner is refused |
| Node `node-state.json` | the Coordinator URL and ID the node is bound to | the same rules; a node never silently moves to another Coordinator |
| Node `enrollment.json` | Coordinator URL and ID, node ID, the capabilities it enrolled with, when | the same rules; no secret; never overwritten |

The enrollment token is written on the node nowhere at all.

## Administrator workflow

On the Coordinator host (the admin API is reachable only on loopback; on a standard install `privanet-admin` reads the secret from the Coordinator's environment file, so it never appears on a command line).

```sh
# 1. Issue a one-time token (default lifetime 10 minutes, at most 24 hours)
sudo privanet-admin enrollment create --expires 10m --capabilities web.fetch.v1 --label "Anna's desktop"

Enrollment token created.
Token:         3f0c…(64 hex characters)
Token ID:      enr_9a41c2d07be3158f
Expires:       2026-10-01T22:40:59Z (in 10m)
Capabilities:  web.fetch.v1
Name:          Anna's desktop

The token is single-use and is not shown again. On the machine that will join:
  privanet-node enroll --coordinator https://<coordinator-address> --token <the token above>
```

The token is shown **once**, here. `--capabilities` is the ceiling the node can enroll with (default `system.echo.v1`; the Coordinator rejects names it does not know), `--label` becomes the node's display name (letters, digits, space, `.`, `_`, `-`, at most 64), and `--json` prints machine-readable output. Set `PRIVANET_PUBLIC_URL` to have the printed command carry your Coordinator's address. At most 100 tokens can be redeemable at once.

```sh
sudo privanet-admin enrollment list           # active tokens: ID, status, created, expires, capabilities, name
sudo privanet-admin enrollment list --all     # plus used, expired and revoked ones (kept 30 days past expiry, so "who used it, and when" stays answerable)
sudo privanet-admin enrollment revoke enr_9a41c2d07be3158f   # withdraw a token nobody has used
```

`list` never shows a token or its hash, only its ID. A token that already enrolled a node cannot be "revoked" (it is spent); revoke the node instead.

```sh
sudo privanet-admin nodes list                # name, node, status, last seen, capabilities, job slots, protocol, enrolled
sudo privanet-admin nodes show "Anna's desktop"   # a node ID, a unique prefix of one (8+ characters) or an exact name
sudo privanet-admin nodes rename node_3a7f19c2 "Anna - study"      # or: nodes rename NODE --clear
sudo privanet-admin nodes revoke node_3a7f19c2
```

Revoking stops the node at once: its live session is deleted, no new session can be created, every request is refused, and its leased jobs go back to the queue. Renaming never changes an identity or a credential, and a revoked node stays revoked.

Everything above also exists as API calls for an administrator's own tooling (`docs/protocol.md`). The older forms (`privanet-admin enrollment`, `nodes`, `revoke-node ID`, `application NAME`) behave exactly as before and still print one line of JSON.

## Node workflow

On the new machine (Node.js 24.4 or newer and the release archive, as before):

```sh
privanet-node enroll --coordinator https://10.0.0.68 --token <token>
```

```
Enrolled.
  Node ID:       node_3a7f19c2…
  Name:          Anna's desktop
  Capabilities:  web.fetch.v1
  State:         /home/anna/var/node

Start the node with: privanet-node
```

Then start the node. It needs **no configuration and no token**: `privanet-node` finds `enrollment.json` in its state directory and reconnects (and keeps doing so after every restart). Anything you set in the environment still wins, so `PRIVANODE_COORDINATOR_URL` and `PRIVANODE_CAPABILITIES` override the remembered values, and `PRIVANODE_POLICY_FILE` and the other owner settings work as always.

Options: `--capabilities a,b` (enroll with fewer than the token grants; the default is everything it grants), `--state-dir DIR` (default `./var/node`, or `PRIVANODE_STATE_DIR`), `--allow-insecure-loopback` (development only). Exit status: 0 success, 1 refused or unreachable, 78 bad usage or configuration.

**Getting the token to the node.** `--token` is what you asked for and it works, but a command line is visible to other users of the machine while it runs. Prefer `--token-file PATH`, `--token-stdin` (`printf %s "$TOKEN" | privanet-node enroll --coordinator ... --token-stdin`) or `PRIVANODE_ENROLLMENT_TOKEN`. The token is single use and short lived, so a leaked one is only useful before its owner redeems it; send it over a channel you trust. `enroll` never prints it, and it is not stored.

**As a service (systemd).** Enroll once as the service's user, against the service's state directory, then start the service; the unit and `node.env` need no token:

```sh
sudo install -d -o privanet-node -g privanet-node -m 0700 /var/lib/privanet-node
printf %s "<token>" | sudo -u privanet-node env NODE_EXTRA_CA_CERTS=/etc/privanet/privanet-root.crt PRIVANODE_STATE_DIR=/var/lib/privanet-node \
  /opt/privanet/bin/privanet-node enroll --coordinator https://10.0.0.68 --token-stdin
sudo systemctl enable --now privanet-node        # node.env: no PRIVANODE_ENROLLMENT_TOKEN line; PRIVANODE_COORDINATOR_URL and PRIVANODE_CAPABILITIES are optional now
sudo journalctl -u privanet-node -n 5            # expect {"event":"node.authenticated"}
```

The service reads `enrollment.json` from the same `PRIVANODE_STATE_DIR`, so enroll and the service must use the same directory. Values in `node.env` (a Coordinator address or capabilities) still take precedence over it.

**TLS is not optional.** The address must be `https://`, and the node verifies the Coordinator's certificate. Plain `http` is accepted only for a literal loopback address with `--allow-insecure-loopback`, for development. If the Coordinator uses a private CA (the LAN setup), the node's machine must trust it, for example `NODE_EXTRA_CA_CERTS=/path/to/root.crt privanet-node enroll ...`; a certificate problem is reported as such and enrollment stops. Nothing disables verification.

**Running again** is harmless: if the node is already enrolled and usable, `enroll` says so and leaves the new token unspent. A node whose identity was revoked cannot be re-enrolled with a new token (the Coordinator still knows the key); delete its state directory to give it a new identity, then enroll again. A state directory belongs to one Coordinator: pointing it at another is refused.

**Failures say what to do** without echoing anything sensitive: a refused token ("wrong, already used, expired or revoked: ask for a new one"), a capability the token does not grant, too many refused attempts, an untrusted certificate, a name that does not resolve, a refused or timed-out connection, and a protocol mismatch.

## Security properties

| Property | How |
| --- | --- |
| High-entropy token | 256 random bits from the OS generator, 64 hex characters |
| Short-lived | expires after the chosen lifetime (1 second to 24 hours; default 10 minutes); an expired token is rejected |
| Single use, even under concurrency | the node is registered and the token marked used in one `BEGIN IMMEDIATE` transaction that re-checks the token first; of any number of simultaneous redemptions exactly one succeeds (tested with eight at once, at the HTTP level and past the challenge) |
| No replay | a challenge is one-use, expires after a minute and is bound to the Coordinator, the purpose, the node and a nonce; a spent token redeems nothing |
| Stored hashed | only SHA-256 of the token; a database copy cannot be used to enroll a node. The token is 256 random bits, so a fast hash is the right choice (a slow one protects low-entropy passwords) |
| Audited | created, expires, label, capabilities, used-at, used-by node and revoked-at are kept (30 days past expiry); the node records its own enrolled-at |
| Not logged | no log line carries a token, a name, an address or a key; events are fixed words (`enrollment.created`, `enrollment.revoked`, `node.enrolled`, `node.renamed`, `identity.revoked`). The node CLI never prints the token, including when it is wrong |
| Nothing to learn from a guess | an unknown, used, expired, revoked and one-character-off token all get the same status and the same body (`401 INVALID_ENROLLMENT`); tested byte for byte |
| Guessing is cut off | a second limiter on enrollment alone: after 10 refused attempts in a minute (`PRIVANET_ENROLLMENT_FAILURES_PER_MINUTE`) an address gets `429` for the rest of the minute, whatever it sends; on top of the existing per-address limit for all authentication traffic. A blocked address learns nothing about whether its last guess was right |
| Constant-time comparison | the admin secret is compared in constant time. A token is looked up by its hash, which an attacker cannot steer by guessing (finding a token whose hash starts with a chosen prefix is a preimage problem), so there is no useful timing signal |
| Protocol checked | the `X-PrivaNet-Protocol` header and the body's `protocolVersion` must be 1, else `426` |
| Inputs bounded | 32 KiB request bodies, `application/json` only, strict schemas (an unknown field is rejected), token 64 hex, names 64 safe characters, capabilities only from the registry |
| Revocation | checked on every authenticated request; deletes sessions and returns leased jobs |
| TLS | required by the node for every non-loopback address, with certificate verification, exactly as for normal operation |
| Admin API not exposed | the new admin routes live under `/v1/admin/` like the rest: the Coordinator listens on loopback and the reverse proxy refuses `/v1/admin/*` from the network (verified in the deployment validation); nothing was added to what the network can reach except the existing enrollment endpoints and an authenticated `GET /v1/node/self` |

What this does not give you, deliberately: the token is a bearer secret until it is redeemed (whoever redeems it first gets the node's seat, so keep lifetimes short and the channel private); an enrolled node is trusted by its owner and by you, not verified (there is still no execution attestation or reputation: see [security.md](security.md)); and a node can still only be as trustworthy as the machine it runs on.

## Protocol and compatibility

All additions are inside protocol 1 and optional, so nothing a node or application already does changes.

- `POST /v1/admin/enrollment-tokens`: new optional request field `label`; the answer keeps `token` and `expiresAt` and adds optional `id`, `createdAt`, `capabilities`, `label`.
- `GET /v1/admin/enrollment-tokens` (new): `{ tokens: [{ id, status: ACTIVE|USED|EXPIRED|REVOKED, createdAt, expiresAt, usedAt, revokedAt, capabilities, label, nodeId }] }`.
- `POST /v1/admin/enrollment-tokens/{id}/revoke` (new): `{}` in, `{ ok: true }` out; `404` unknown, `409 ENROLLMENT_ALREADY_USED`.
- `GET /v1/admin/nodes`: each node gains optional `displayName`, `enrolledAt`, `revokedAt`.
- `POST /v1/admin/nodes/{id}/rename` (new): `{ displayName: string | null }`.
- `POST /v1/enrollment/challenge`: `capabilities` is now optional; omitted means "every capability the token grants". A node that names capabilities (every node before this change) gets exactly those, and one the token does not grant is still refused (`403`).
- `GET /v1/node/self` (new, node session): the node's ID, name, enrolled time, capabilities and the capabilities it is allowed. Lets `enroll` learn what it was granted.
- New errors: `ENROLLMENT_LIMIT` (429, more than 100 redeemable tokens), `ENROLLMENT_ALREADY_USED` (409), and `RATE_LIMIT` (429) from the new limiter.

The schemas are in `@privanet/protocol` (`EnrollmentTokenInfoSchema`, `NodeRenameSchema`, `NodeSelfSchema`, `DisplayNameSchema`, …); there are no ad-hoc shapes.

## Upgrade notes

- **No database migration and no downtime.** Tokens and nodes are stored as JSON records, and every new field is optional, so the existing database opens unchanged and old records read as before. A token created before the upgrade still redeems; it is listed with an unknown creation time and no label. Used and expired tokens, which used to be deleted when they expired, are now kept 30 days past expiry.
- **Nodes already enrolled are unaffected.** Their `identity.json`, `node-state.json` and environment configuration keep working with no change and no new file (verified: a node enrolled the old way restarts and authenticates unchanged). `enrollment.json` appears only when `privanet-node enroll` is used, and is read only when the environment does not set the Coordinator address or capabilities.
- **The old enrollment flow still works**: `PRIVANODE_ENROLLMENT_TOKEN` in the environment, with `PRIVANODE_CAPABILITIES`, as in [FIRST_DEPLOYMENT.md](FIRST_DEPLOYMENT.md). `enroll` is an addition, not a replacement.
- **Upgrade the admin tool with the Coordinator** (they ship in the same release archive). The admin tool checks answers strictly, so an older `privanet-admin` against an upgraded Coordinator reports a failure when it sees the new optional fields; the Coordinator and nodes are unaffected.
- **An older Coordinator cannot take a nameless enrollment**: `privanet-node enroll` without `--capabilities` against a Coordinator that predates this change is refused (it requires the list). Pass `--capabilities` explicitly there, or upgrade the Coordinator first.
- New optional Coordinator setting: `PRIVANET_ENROLLMENT_FAILURES_PER_MINUTE` (default 10). Behind a reverse proxy on the same machine, `PRIVANET_TRUST_LOOPBACK_PROXY=true` makes the limits per real client address ([deployment.md](deployment.md)).

## Tests

`tests/onboarding.test.ts` (18 tests, in-process Coordinator over real HTTP) and `tests/onboarding-cli.test.ts` (3 tests that run the shipped admin and node entry points as separate processes, including a node daemon that restarts from stored state alone). They cover: token creation and hashed storage (including the database and its write-ahead log), successful enrollment and consumption, invalid, expired, reused, revoked and near-miss tokens with identical answers, concurrent redemption, the restart and reconnect, revocation of nodes and of unused tokens, nodes and tokens written before this change, malformed input and protocol mismatch, the failed-enrollment limiter, capability ceilings, renaming, token limits and audit retention, file permissions and refusal of unsafe state, and that no token or secret appears in any log or output.
