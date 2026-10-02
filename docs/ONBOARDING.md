# Remote node onboarding

Status: implemented (`0.3.5`). This is [Phase 3.5](../ROADMAP.md#phase-35--remote-node-onboarding--contributor-experience--implemented): how a trusted contributor's machine joins, and how the owner sees, names and withdraws nodes. There are four ways in, from most to least manual, and every one ends with the **owner's explicit decision**: the owner issues each token, invite or approval one at a time. Enrollment is never public.

| Way in | The contributor needs | The owner does | Doc |
| --- | --- | --- | --- |
| One command (Linux or Windows) | the installer and a short **invite code** | `privanet-admin invite create` | [INSTALLER.md](INSTALLER.md) |
| Approval ("device code") | the installer and nothing secret | `privanet-admin approve CODE` | [Approval](#approval-flow-no-secret-at-all) below |
| `privanet-node enroll` | the release and a long one-time **token** | `privanet-admin enrollment create` | [Node workflow](#node-workflow) below |
| Manual (`node.env`) | the release and a token in the environment | the same | [FIRST_DEPLOYMENT.md](FIRST_DEPLOYMENT.md) |

Related: [PUBLIC_NODE.md](PUBLIC_NODE.md) (a public hostname with a normal certificate), [RECOVERY.md](RECOVERY.md) (reinstall, lost machine, revoke), [EXPOSURE_REVIEW.md](EXPOSURE_REVIEW.md) (what the Internet can reach), and `privanet-node doctor` ([below](#diagnosing-a-node-privanet-node-doctor)).

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

## Invite codes (short, for people)

A token is 64 characters, which is fine for a script and miserable for a person. An **invite** is a short code the owner can read over the phone:

```sh
sudo privanet-admin invite create --expires 30m --capabilities web.fetch.v1 --label "Anna's desktop"

Invite created.
Code:          N7K4-PQ2M
Invite ID:     inv_5d0c1f7e2a91b3c4
Expires:       2026-10-01T22:40:59Z (in 30m)
Capabilities:  web.fetch.v1
Name:          Anna's desktop

The code works once, from a machine that reaches this Coordinator over verified TLS, and is not shown again. Give it to the contributor over a private channel:
  privanet-node enroll --coordinator https://node.example.com --invite-stdin      (then type or paste the code)
```

`sudo privanet-admin invite list [--all]` and `invite revoke INVITE_ID` work like their token counterparts. On the machine, the installer (or `privanet-node enroll --coordinator URL --invite-file FILE`, `--invite-stdin` or `PRIVANODE_INVITE_CODE`) redeems it; the code is typed or pasted case-insensitively, with or without the hyphen, and the installers never put it on a command line (`privanet-node enroll --invite CODE` exists like `--token`, and is visible to other users of the machine while it runs: prefer the file, stdin or environment forms).

**An invite is an introduction, not a credential.** Eight characters of an unambiguous alphabet (Crockford base 32: no `I L O U`; typed `O`, `I` and `L` are read as `0`, `1`, `1`) carry 40 bits, which a patient guesser could cover if nothing stopped them, so the design assumes it is guessable and bounds what a guess can do:

| Property | How |
| --- | --- |
| Not the token | the code is unrelated to the 256-bit token; redeeming it runs the **same** Ed25519 challenge-and-proof enrollment as a token, so the node's key, not the code, is its credential |
| Short life, single use | at most 1 hour (default 10 minutes); one redemption, decided in one `BEGIN IMMEDIATE` transaction, so of any number of simultaneous attempts exactly one wins (tested) |
| Capability ceiling | the owner sets the most the node can get; the contributor can only ask for less |
| Not stored | the Coordinator keeps a keyed HMAC of the code (the key derives from the administrator secret and is not in the database), so a copy of the database cannot be used to guess codes offline. The code appears in no log, no audit field and no error |
| Guessing cut off three ways | the **handle** (first four characters) finds the invite, and a wrong **second half** counts against *that invite*, which locks after 5 wrong guesses; an address gets 5 refused invite attempts per minute (stricter than the 10 for tokens); and 100 refusals in ten minutes across all addresses switches invite redemption off for everyone until it clears. Together a guesser cannot get through the 2^20 second halves of one invite, let alone find one |
| One generic answer | an unknown, used, expired, revoked, locked, wrong or malformed code all get `401 INVALID_INVITE`, the same body |
| Verified TLS only | the node refuses a non-HTTPS address (loopback excepted for development) and an untrusted certificate, and a redirect cannot move redemption to another origin |
| Audited without the code | invite ID, created, expiry, label, capabilities, used-by, revoked, wrong-guess count; kept 30 days past expiry |

If a code is lost, revoke the invite and issue another. If many invites are being guessed, `invite list --all` shows the locked ones.

## Approval flow (no secret at all)

When there is no safe channel for a code, the contributor asks and the owner approves. Nothing secret is ever sent to the contributor:

```sh
# on the contributor's machine (or: install-node.sh --join / install-node.ps1 -Join)
privanet-node join --coordinator https://node.example.com --name "Anna's desktop"

Request sent. Waiting for the owner to approve it.
  Request code:  J4M7-K2Q9
  Node ID:       node_3a7f19c2...
Tell the owner the request code ...

# on the Coordinator host
sudo privanet-admin requests list                     # CODE  STATUS  NODE  NAME HINT  ASKED FOR  FROM  EXPIRES
sudo privanet-admin approve J4M7-K2Q9 --capabilities web.fetch.v1 --label "Anna's desktop"
sudo privanet-admin deny J4M7-K2Q9
```

The machine makes its own key first and the request is **bound to that key**; the request code is only a label for the owner to read out, and knowing it grants nothing (the node polls with a separate 122-bit request ID). The owner compares the Node ID the machine printed, approves with a capability ceiling and a name, and the machine finishes enrolling with the same signed proof as any other way in. A request expires (10 minutes by default), can be denied or cancelled, is answered once, and survives a restart of `join` (it resumes from `join-request.json` in the state directory). At most 50 requests are pending (5 per address), polling is bounded, and `requests list` never shows a secret because there is none. The admin API stays loopback-only.

## Diagnosing a node: `privanet-node doctor`

```sh
privanet-node doctor --coordinator https://node.example.com [--json] [--state-dir DIR]
```

Stages, each OK, WARN, FAILED, INFO or SKIPPED, with a plain-language next step: configuration, address, DNS, TCP, TLS (handshake, trust, host name, expiry), Coordinator health and protocol, enrollment and invite endpoints, state directory (exists, owner, mode), identity (valid, bound to this Coordinator), enrollment consistency, whether this node is registered and signs in, and the service. A failure in the network stages skips what depends on it. It sends **no** enrollment-changing request (the endpoint probes carry a deliberately invalid body), prints no key, token or code, and never relaxes certificate verification. Exit status: 0 no problems, 1 a problem, 78 bad usage; `--json` is stable for scripts. The installers run it to confirm sign-in.

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

- `tests/onboarding.test.ts` (18 tests, in-process Coordinator over real HTTP) and `tests/onboarding-cli.test.ts` (5 tests that run the shipped admin and node entry points as separate processes: token enrollment, a node daemon restarting from stored state alone, and the invite and approval flows). They cover: token creation and hashed storage (including the database and its write-ahead log), successful enrollment and consumption, invalid, expired, reused, revoked and near-miss tokens with identical answers, concurrent redemption, the restart and reconnect, revocation of nodes and of unused tokens, nodes and tokens written before this change, malformed input and protocol mismatch, the failed-enrollment limiter, capability ceilings, renaming, token limits and audit retention, file permissions and refusal of unsafe state, and that no token or secret appears in any log or output.
- `tests/invites.test.ts` (22 tests): the code alphabet and tolerant typing, keyed-hash storage, one generic refusal, the per-invite lock, the per-address and global limits and their recovery, expiry, revocation, the live-invite bound, exactly one winner among many simultaneous redemptions, malformed input, redirects, and the whole approval flow (key binding, ceilings, denial, expiry, polling, replay, concurrency, bounds).
- `tests/doctor.test.ts` (10 tests): every stage and failure class against real and fake servers, with no secret in any output and nothing created or changed.
- `tests/public-proxy.proxy.ts` (`npm run test:proxy`, a real Caddy): the shipped routes, the exposure checker (including against a deliberately naive proxy), and enrollment, doctor, restart and revocation across the proxy.
- `tests/installer.test.ts` (`npm run test:installer`) and `tests/installer-windows.test.ts`: the installers ([INSTALLER.md](INSTALLER.md#what-is-verified-and-what-is-not)), including the whole life of a node for an invite and for an approval.
