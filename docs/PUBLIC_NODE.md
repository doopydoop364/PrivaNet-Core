# A public Coordinator address (public hostname, publicly trusted TLS)

Status: implemented (`0.3.5`); part of [Phase 3.5](../ROADMAP.md#phase-35--remote-node-onboarding--contributor-experience--implemented). The configuration and checker are tested against a real Caddy; **buying a domain, pointing DNS at your server and opening the ports are your steps** (this project cannot do them for you), and a certificate from a real certificate authority was not obtained in the tests (Caddy's own local CA stood in for it).

This lets a contributor outside your LAN use `https://node.example.com` with no private root certificate to install. It changes nothing about the LAN setup in [FIRST_DEPLOYMENT.md](FIRST_DEPLOYMENT.md): that (private CA, an address or `.lan` name) stays valid and supported, and the same node, installer and doctor work with either.

```
contributor's node  --TLS-->  Caddy (public name, public certificate)  --127.0.0.1:4010-->  Coordinator
                                │ forwards ONLY the routes a node needs
                                └ everything else, including /v1/admin/*, is answered by Caddy and never reaches the Coordinator
```

## What you need

1. A domain name you control and an `A`/`AAAA` record for a host name (for example `node.example.com`) pointing at your server's public address.
2. Ports **443** and **80** reachable from the Internet to that server (80 is used by the certificate authority's challenge and to redirect to https). On a home network: a router port forward and, if your ISP uses carrier-grade NAT, a different arrangement (a small VPS in front, or another way to reach the server); a Coordinator that is not reachable from outside cannot serve outside contributors, whatever the certificate.
3. A server host firewall that allows 443 and 80 in, and **nothing else** to the Coordinator: it listens on `127.0.0.1:4010` and must keep doing so.
4. Caddy 2 (`apt install caddy`), which obtains and renews the certificate itself (Let's Encrypt or ZeroSSL).

## Set up

On the server, with the release unpacked at `/opt/privanet` (the shipped files are in `/opt/privanet/deploy/caddy/`):

```sh
sudo cp /opt/privanet/deploy/caddy/Caddyfile.public /etc/caddy/Caddyfile
sudo sed -i 's/node.example.com/YOUR-NAME/' /etc/caddy/Caddyfile        # also set the email line if you like
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Then in the Coordinator's environment file: keep `PRIVANET_HOST=127.0.0.1`, and set `PRIVANET_TRUST_LOOPBACK_PROXY=true` so the per-address rate limits (including the strict invite and enrollment limits) apply to the real client address from `X-Forwarded-For` and not to Caddy ([deployment.md](deployment.md)). Where you run `privanet-admin`, set `PRIVANET_PUBLIC_URL=https://YOUR-NAME` so it prints the right address in the commands it shows.

`Caddyfile.public` is five lines of site block importing `public-routes.caddy`, which is the whole policy:

- an **allowlist**: only `/v1/health`, `/v1/enrollment/{challenge,proof}`, `/v1/invites/challenge`, `/v1/join/{request,status,challenge}`, `/v1/auth/{challenge,proof}` and `/v1/node/*` are forwarded; everything else gets `404` from Caddy itself. That includes **the whole administrator API (`/v1/admin/*`)** and the application API (`/v1/jobs`, `/v1/capabilities`), which belong on the loopback address next to the Coordinator (PrivaSearch and other applications run there);
- matching is exact and case-insensitive, so `/V1/Admin/...`, dot-segments and encoded variants are not on the list either (tested);
- request bodies are limited to 32 KB (the Coordinator limits them too), with header, body, write and idle timeouts;
- `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`, and no `Server` header;
- plain `http` on port 80 redirects to https.

Caddy has no built-in rate limiter, and none is claimed: guessing limits are enforced by the Coordinator (10 refused enrollment attempts a minute and **5 refused invite attempts a minute per address**, a per-invite lock after 5 wrong guesses, and a global invite budget; see [ONBOARDING.md](ONBOARDING.md#invite-codes-short-for-people)) and need `PRIVANET_TRUST_LOOPBACK_PROXY=true` to see real addresses. For a public name, a connection-level limit at your firewall or in front of Caddy is a sensible extra layer; it is not required for the properties above.

## Verify it from another machine

Run the checker **from a machine that is not the server** (a laptop on mobile data is ideal). It is in the release as `tools/check-exposure.mjs`:

```sh
node tools/check-exposure.mjs https://node.example.com
node tools/check-exposure.mjs https://node.example.com --probe-limits      # also proves the guessing limits (this blocks your address for about a minute)
```

It sends only requests that carry no real credential and verifies the certificate like any client (there is no option to skip that). It reports PASS, WARN or FAIL for: a verified TLS health check, the certificate (issuer, days left), HSTS, plain-http behaviour, that the **administrator API is not reachable** (a set of paths and encodings), that the application API is not reachable (a WARN, since a LAN deployment may want it: `--allow-application-api`), oversized and malformed requests, unknown routes and wrong methods, and with `--probe-limits` that wrong enrollment tokens and invite codes reach a `429`. Exit status 0 means nothing failed. `--json` is machine-readable. A node can then run `privanet-node doctor --coordinator https://node.example.com` for the contributor's side of the same questions.

What the checker cannot tell you: that the machine's firewall exposes nothing else (run `nmap` from outside), or that DNS is what you intended. If a check fails, the line names what was reached.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Caddy cannot get a certificate | DNS does not point at this server yet, port 80/443 is blocked, or the CA's rate limit; `journalctl -u caddy` says which |
| Works on the LAN, not from outside | router port forward, CGNAT, or the host firewall |
| `doctor` says the certificate is for another name | the node was given an address (an IP) or a name that is not the certificate's name |
| A node's address works but rate limits seem shared | `PRIVANET_TRUST_LOOPBACK_PROXY=true` is missing, so every client looks like Caddy |
| Redeeming an invite says "refused" for the right code | the invite is spent, expired or locked, or the invite budget is paused after many wrong guesses; see [RECOVERY.md](RECOVERY.md#invites-and-approvals-that-did-not-work) |
| `/v1/admin/...` answers something other than 404 from outside | the proxy is not using `public-routes.caddy`; the checker FAILs this |

## What this does and does not give you

It gives a normal certificate, a stable name, and a small surface (the routes above). It does not make enrollment public: every node still needs an owner-issued invite, token or approval. It does not hide the Coordinator's existence or protect against a determined flood (a reverse proxy and a firewall are not DDoS protection). The review of what this exposes, and what was and was not tested, is [EXPOSURE_REVIEW.md](EXPOSURE_REVIEW.md).
