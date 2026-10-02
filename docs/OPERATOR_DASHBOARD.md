# The operator dashboard

`privanet-admin ui` opens the administrator's view of a Coordinator in a browser: **nodes**, **join requests** and **invites**. It is part of the post-3.5 contributor-experience milestone ([NODE_CONTROL_PANEL.md](NODE_CONTROL_PANEL.md) is the contributor's side), not a new phase.

```
export PRIVANET_COORDINATOR_URL=https://coordinator.example.org     # as for the other privanet-admin commands
export PRIVANET_ADMIN_SECRET=...                                    # from your own secret store; never put it on a command line
export PRIVANET_PUBLIC_URL=https://coordinator.example.org          # optional: shown in the instructions next to a new invite
privanet-admin ui [--port 4041]
```

It prints `http://127.0.0.1:4041/` and a sign-in link; open the link. Ctrl+C stops it. Run it on the machine you already administer from (usually the Coordinator host or your own computer, with the Coordinator reachable from there).

## What it does

| Section | Shows | Can do |
| --- | --- | --- |
| Nodes | Name, node ID, state, last heard from, what it may do, job slots in use, software and protocol compared with the Coordinator's, what it last reported about its own resources | Rename; revoke (asks for confirmation) |
| Join requests | The code, the node ID the machine will have (compare with what it printed), what it asked for, device-name hint, source address, expiry | Approve with the capabilities **you** tick and an optional name; deny; withdraw an approval not yet used |
| Invites | Active and locked invites with status, expiry, capabilities, name, wrong guesses | Create (1 to 60 minutes, capabilities you choose, optional name); revoke |

A new invite's code is shown **once**, in the answer to the create request; the Coordinator stores only a keyed hash and every later view omits it.

### States are only what is known

The Coordinator records a node's status, its last heartbeat, its software and protocol versions, and what the node last reported about itself, so those are the only things shown. "Online", "Not heard from for a little while", "Offline", "Enrolled, has never connected", "Draining", "Offline (it said it was stopping)" and "Revoked" come from the Coordinator's own status. The resource figures are **self-reported by the node and not verified** and say so. The dashboard cannot tell you why a node is idle or whether its owner paused it: only the owner's own control panel knows that.

Version information is a note, not a verdict: the protocol decides compatibility, and a node whose software is older or newer than the Coordinator but speaks the same protocol is shown as working. A different protocol is shown as incompatible.

### Storage summary (0.4.0-alpha.2)

The Nodes tab starts with a compact **Storage control plane** card: how many nodes offer storage, how many chunks are stored and pending, and how many transfers are open. It is aggregates only (counts and sizes): no chunk id, ticket, key, application name or inventory, and no action. From a shell, `privanet-admin storage status [--json]` shows the same plus one line per storage node (offered capacity, reported free space, bytes reserved, open transfers), and `privanet-admin storage rotate-key` rotates the ticket-signing key (the old key keeps verifying for 4.5 minutes, so no live ticket breaks). An application gets storage only if it was created with `privanet-admin application NAME --services storage.chunk.v1`; there is no command that marks a chunk stored or edits transfer state. Against an older Coordinator the card is simply absent.

## Security design

- **A client of the existing administrator API.** The dashboard is a separate process that holds the administrator secret and makes the same schema-checked requests as the CLI. The dashboard adds no write route to the Coordinator (since 0.4.0-alpha.2 it also reads the aggregate `/v1/admin/storage` summary); `/v1/admin/*` stays isolated exactly as before (loopback or private network only, never on the public proxy).
- **The browser never receives** the administrator secret, application credentials or enrollment tokens. Application credentials and enrollment tokens are deliberately **not** in the dashboard at all; use the CLI, which shows them once. Coordinator error messages (which can quote a request) are reduced to a code before they reach the page.
- The browser side is the shared local-UI guard (`packages/shared/src/local-ui.ts`): binds 127.0.0.1 only; Host allowlist; a 256-bit sign-in token generated **for each run** (in memory, printed once, exchanged for an HttpOnly SameSite=Strict cookie); every API route including reads needs the session; failed sign-ins limited to 5 per minute; POSTs need an allowed Origin, the session's CSRF token and `application/json`; bodies limited to 32 KB with strict schemas; node and request identifiers are validated before they become part of a URL; a nonce Content-Security-Policy; no CORS; GET and POST only.
- A fixed list of actions; there is no endpoint that fetches a URL, reads a file, runs a command or returns the environment.
- Every refused request is covered by `tests/admin-ui.test.ts`, which also checks that none of them changed anything on the Coordinator.

## Limits

Someone who can read the dashboard process's terminal output or its memory has the sign-in token (and, by being that user, the administrator secret). It does not change who may administer a Coordinator. It shows what the Coordinator stores: no per-node history, no accounting. A page was exercised in headless Chromium by hand; that is not part of CI.
