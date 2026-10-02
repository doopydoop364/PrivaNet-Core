# Internet-exposure review (public Coordinator address)

Status: written for [Phase 3.5](../ROADMAP.md#phase-35--remote-node-onboarding--contributor-experience--implemented). This is the project's **own** review of what a public hostname (docs: [PUBLIC_NODE.md](PUBLIC_NODE.md)) exposes, with the test that backs each conclusion. **It is not an independent security audit.** It was done by the people who wrote the code, against the code and a real Caddy, and it cannot find what its authors did not think of. Before inviting people you do not personally know, have someone else look; and remember that Phase 3.5 admits only people the owner chose.

Scope: the Coordinator behind the shipped Caddy rules, the enrollment paths (token, invite, approval), the node's connection, and the installers. Out of scope: the host operating system, the router and ISP, a compromised owner machine, hostile nodes (Phase 10), and denial of service by volume.

## Attack surface

From the Internet, with the shipped `public-routes.caddy`, exactly these paths are forwarded to the Coordinator, and nothing else is:

| Route | Who may call it | Why it is public |
| --- | --- | --- |
| `GET /v1/health` | anyone | node reachability and Coordinator identity; returns a fixed small document |
| `POST /v1/enrollment/challenge`, `/proof` | someone holding an unspent enrollment token | token enrollment |
| `POST /v1/invites/challenge` | someone holding an unspent invite | invite enrollment |
| `POST /v1/join/request`, `/status`, `/challenge` | anyone may ask; only the owner's approval lets it finish | approval flow |
| `POST /v1/auth/challenge`, `/proof` | an enrolled node's key | sign-in |
| `/v1/node/*` | an enrolled, unrevoked node's session | heartbeats, leases, results |

Not reachable, by design: `/v1/admin/*` (loopback only, administrator secret), `/v1/jobs` and `/v1/capabilities` (applications run next to the Coordinator on loopback), and everything else (`404` from the proxy).

## Findings

Each row is a question from the review checklist, the answer, and where it is shown. "Test" names a file in `tests/`.

| # | Question | Answer | Evidence |
| --- | --- | --- | --- |
| 1 | Is the admin API reachable through the public proxy? | No: not by path, case, dot-segments, encoding, or wrong method. A naive proxy that forwards everything **is** detected and fails the check | `public-proxy.proxy.ts` (real Caddy; the checker is run against the shipped rules and against a deliberately wrong proxy) |
| 2 | Is the Coordinator itself loopback-only? | Yes by default (`PRIVANET_HOST=127.0.0.1`); a non-loopback bind is refused unless TLS termination is declared | `config.ts`; the LAN tests (`lan.netns.ts`) show the admin port unreachable from another host |
| 3 | Is token guessing limited? | Yes: 10 refused attempts per address per minute then `429` for the rest of the minute; tokens are 256 bits | `onboarding.test.ts`; the checker's `--probe-limits` through a real proxy |
| 4 | Is invite guessing limited more strictly, and bounded per invite? | Yes: 5 per address per minute; 5 wrong second halves lock *that invite* for good; 100 refusals in ten minutes anywhere pause all invite redemption | `invites.test.ts` (per-invite lock, per-address cut-off, global budget and recovery) |
| 5 | Can a request code grant access? | No: it is only an identifier; the request is bound to the machine's key, and completion needs the owner's approval and a signature by that key | `invites.test.ts` ("approval: a request is bound to its key", "nothing completes before approval") |
| 6 | Are oversized, malformed and unsupported-protocol requests rejected before anything is looked up? | Yes: 32 KB bodies, strict schemas, `application/json` only, protocol 1 else `426`; the code is never echoed | `invites.test.ts` (malformed), `onboarding.test.ts`, the checker's oversize/malformed checks |
| 7 | Replay of a challenge, proof, invite or approval? | A challenge is single-use, expires in a minute and is bound to the key, purpose and Coordinator; spent invites and tokens are refused; completion of a request is single use | `onboarding.test.ts`, `invites.test.ts` (replay and concurrency) |
| 8 | Can one invite or token be redeemed twice, even at once? | No: of any number of simultaneous redemptions exactly one succeeds (one `BEGIN IMMEDIATE` transaction re-checks the grant) | `invites.test.ts` ("of many simultaneous redemptions of one code exactly one node is enrolled"), `onboarding.test.ts` |
| 9 | Do expired or revoked invites, and denied or expired requests, fail? | Yes, with the same generic answer for invites | `invites.test.ts` |
| 10 | Can the public node API rename, revoke or list other nodes? | No: those are `/v1/admin/*`, which the proxy does not forward, and the Coordinator requires the administrator secret for them. A node can only read its own record (`GET /v1/node/self`) | `onboarding.test.ts`, `public-proxy.proxy.ts` |
| 11 | Do revoked sessions and nodes stop at once? | Yes: sessions are deleted, every later request is refused, leased jobs return to the queue; it is also checked across the proxy | `onboarding.test.ts`, `public-proxy.proxy.ts` ("...invite, doctor, restart, and revocation") |
| 12 | Do logs hide credentials? | Yes: events are fixed words; no token, code, address, name or key is logged by the Coordinator; the node CLI never prints them; the doctor prints none. Tests scan outputs and files for the secrets | `invites.test.ts`, `onboarding-cli.test.ts`, `doctor.test.ts`, `installer.test.ts` |
| 13 | Does the installer ever print or store a secret? | No: the secret is read from a file, a hidden prompt or the environment, goes to the node on standard input, is not in `argv`, not written to any file, and not in any output; temporary files are removed on every exit path | `installer.test.ts` (scans every file and all output; interrupted runs) |
| 14 | Can TLS be downgraded? | Not by the node (HTTPS or literal loopback only; no option to skip verification), not by the installer (HTTPS only, redirects restricted), not by the checker or doctor. A redirect cannot move redemption to another origin: the node's transport refuses redirects | `invites.test.ts` ("a redirect can never move redemption..."), `installer.test.ts` (redirect to http), `doctor.test.ts` (an untrusted certificate stops the diagnosis and nothing is sent), `public-proxy.proxy.ts` (the checker refuses http) |
| 15 | Are SSRF protection and handler restrictions unaffected? | Yes: onboarding changes who may join, not what a node does; the guarded fetch handler, its address policy and the resource policy are untouched, and the full suite including `fetch-*.test.ts` passes | the full test run |
| 16 | Is plain HTTP served? | No: Caddy redirects port 80 to https; the checker fails a deployment that answers over plain http | `public-proxy.proxy.ts` |
| 17 | Does the invite database leak codes? | No: the Coordinator stores an HMAC keyed from the administrator secret (not in the database); a database copy cannot be used to guess codes | `invites.test.ts` ("stored only as keyed hashes, listed without the code, never logged") |

## Residual risks and limits (read these)

- **An invite is 40 bits.** The design assumes it can be guessed by someone who is not stopped, and stops them (items 3 and 4): per-address and global limits and a per-invite lock. An attacker with very many distinct addresses can still make the global budget trip, which pauses invite redemption for everyone for a short time (a deliberate denial-of-invites-by-guessing trade-off; token enrollment is unaffected). The owner sees locked invites in `invite list --all`.
- **Rate limits depend on seeing real client addresses.** Behind a proxy that does not set `PRIVANET_TRUST_LOOPBACK_PROXY=true`, every client looks like the proxy and shares one budget, which both weakens attribution and lets one abuser lock out the rest. The docs say to set it; nothing can set it for you.
- **Caddy provides no rate limiting here.** Volume attacks are not handled; use a firewall or a CDN if you expect them.
- **A bearer secret is a bearer secret until redeemed.** Whoever gets an unspent invite or token first can enroll with it. Short lives, single use and the capability ceiling bound the damage; the approval flow removes the secret entirely.
- **Approval trusts the owner's eyes.** The owner sees a request code, a Node ID, a name hint and an address, none of which prove who is asking. Approve only requests you were told to expect (the name hint is the contributor's claim). A pending request ties up one of 50 slots, 5 per address, until it expires.
- **Installers are not signed.** There are no code-signing keys: see the trust chain in [INSTALLER.md](INSTALLER.md#trust-chain-honestly). The pin and the attestation are the strong checks.
- **An enrolled node is trusted by the owner, not verified.** A hostile or compromised node can return wrong results; applications must not trust one node ([Phase 10](../ROADMAP.md)).
- **Not independently audited**, and **not tested against a real certificate authority or a real Internet client**: the proxy tests use Caddy's local CA and loopback. The checker is the tool to run from the real outside.
- **Windows service steps** are unverified on a real machine ([INSTALLER.md](INSTALLER.md#what-is-verified-and-what-is-not)).

## Defects found and fixed during the review

- A first design let the checker's body-size probe treat Caddy's `502` as a failure; Caddy 2.6 answers `502`, not `413`, for an oversized body, so both are accepted (still never forwarded to the Coordinator).
- The first draft of the installer would have skipped enrollment when a previous attempt had already created the identity but not enrolled; it now enrolls whenever a way to enroll is given.
- A killed `--join` left the waiting node process running after the installer received a signal; the installer now runs it as a child it can stop, and the interruption test covers it.
