# Deployment validation: server Coordinator, separate desktop worker

Status: v0.3.5. Scope: **trusted** machines you control, on a LAN or private network. The step-by-step procedure is [FIRST_DEPLOYMENT.md](FIRST_DEPLOYMENT.md); this document is the evidence, the security review, what is still unverified, and the verdict.

## Verdict

**B. Ready with a few manual precautions.** Everything that can be proven without your two physical machines was proven with real processes, real TLS, real firewalls and separate network stacks, and the bugs that surfaced were fixed. What remains is what only real hardware can show (your systemd, your network, your desktop's operating system), and it is a 30-minute checklist below, not missing work. There is no known blocker.

Precautions, in order:

1. **Run the manual two-machine check** below on the real server and desktop before relying on it. The service units were validated for syntax with `systemd-analyze verify` but never started under a real systemd in these tests.
2. **Node.js 24.4 or newer on both machines.** Debian and Ubuntu LTS do not package it; install the nodejs.org tarball.
3. **Give the server a stable address** (DHCP reservation or a host name) before enrolling anything: a node pins the exact Coordinator URL.
4. **Copy the Caddy root certificate to the desktop and keep a copy of the admin secret** (password manager). The admin secret is not stored in the database.
5. **Stay on the LAN or a private overlay.** Do not port-forward 443 to the Internet yet.
6. **If the desktop is Windows,** treat that path as untested on a real LAN (the Windows archive and `DRAIN` file are tested in the ordinary suite; nothing in the LAN tests ran on Windows).
7. **Bring up the Coordinator and the desktop node first;** enable the server's own node after you have watched the Coordinator's CPU and memory for a day. It is optional and removable at any time.
8. **Run one small real crawl** through the nodes before a large one: the nodes have fetched only a local test site and (in CI) `example.com`, not the open web from your network.

## What was tested and how

A network-namespace test (`npm run test:lan`, Linux and root; its own CI job) builds three hosts on one simulated Ethernet segment, each with its own network stack, loopback and firewall:

```text
server  10.77.0.1   Coordinator on its own loopback 127.0.0.1:4010; Caddy 2.6.2 terminates TLS on :443 with its own local CA; the firewall admits only TCP 443
desktop 10.77.0.2   PrivaNode(s); the firewall admits nothing inbound except replies
web     10.77.0.3   a stand-in website, and the application for the workload test
```

The Coordinator, PrivaNode and admin tool are the **shipped release binaries** (`bin/privanet-coordinator`, `bin/privanet-node`, `tools/admin.mjs` from a staged release archive), configured through the same environment variables and files as in production, with no special test code paths. Caddy is the real program with the shipped `deploy/caddy/Caddyfile`. Limits of this: one kernel, a virtual cable instead of a real switch, Node 22 in the sandbox (the project targets 24.4+, CI runs 24 and 26), iptables instead of Proxmox's firewall, and no systemd.

### Scenarios (all pass)

| Claim | Proof in `tests/lan.netns.ts` |
| --- | --- |
| A desktop on another host enrols over TLS at the IP address, authenticates, runs a job from an application on the same host, and the worker host has **no listening TCP socket reachable from the network** (since the control panel, the node listens on one loopback-only socket, `127.0.0.1:4040`; the test asserts there is no other) | test 1 |
| Certificate verification is real: without the CA the certificate is rejected; the admin API is 403 at the proxy **even with the correct admin secret**; the Coordinator's own port 4010 and plain 80/8080 do not answer from the LAN; a node refuses `http://` to a LAN address even with the loopback exception switched on | test 2 |
| A node without the CA never enrols, logs `reason: TLS_CERTIFICATE`, keeps retrying, and leaves the enrollment token unused for a correctly configured node | test 3 |
| Coordinator killed while a node idles: the node logs, stays up (same process) and reconnects. Caddy down: `CONNECTION_REFUSED`, then recovery. Coordinator `SIGKILL`ed **mid-job** for 4 s: the application, waiting through the outage, gets one correct result and no error | test 4 |
| Persistent identity: a restarted node keeps `identity.json` byte for byte and reauthenticates (no re-enrolment, no duplicate record); a revoked node is refused, also after a Coordinator restart; a Coordinator rebuilt from nothing is refused by nodes, which exit with status 78 | test 5 |
| A node that starts while the Coordinator is down backs off (no spin), does not crash, and connects when it returns | test 6 |
| The shipped `privanet-admin` and `privanet-backup` work against the shipped example `coordinator.env`, and never print the secret | test 7 |
| Remote onboarding over TLS ([ONBOARDING.md](ONBOARDING.md)): `privanet-admin enrollment create` on the server; `privanet-node enroll` from the desktop host without the CA is refused with a plain "certificate is not trusted" and leaves the token unused, and with the CA enrols (token then `USED`, never printed); the shipped node then starts from its state directory alone, reauthenticates after a restart, shows with its name in the registry, runs a job, and `nodes revoke` makes the running node `REVOKED` and refused | the `remote onboarding over TLS` test |
| Mixed versions with the **real binaries of v0.3.0-alpha.2** (before lease waits and job slots): a new Coordinator serves an old node; an old Coordinator serves a new node (which falls back and says so) and a new SDK | test 8 |

The default suite also checks the shipped files against the code (`tests/deploy.test.ts`): both resource policies parse and the server one is stricter on every host-protecting axis; the environment examples use only variables the programs read and parse; the units restart on failure, keep secrets out, use separate users, and leave the node with no `Requires=` on the Coordinator; `systemd-analyze verify` and `caddy validate` accept the files.

### Two-node workload

The shipped policies (memory and CPU reserves zeroed so a busy CI machine never pauses a node; politeness off for the synthetic site), a conservative **server node** and a larger **desktop node** on separate hosts, a `web.fetch.v1` workload of 4,000 pages from a third machine (400 ms per page, 64 in flight). Mid-run the desktop's network cable was pulled for 35 s and then restored. `tests/lan-workload.netns.ts`; one run on a 4-CPU machine that also runs everything else, Node 22:

| Phase | Window | Server node pages/min | Desktop node pages/min | Total pages/min |
| --- | --- | --- | --- | --- |
| Both nodes | 25 s | 420 | 1,147 | 1,567 |
| Desktop cable pulled (first 10 s skipped for lease expiry) | 25 s | 432 | 0 | 432 |
| Desktop back | 112 s | 432 | 1,174 | 1,606 |

- **Both nodes received work; different limits were respected exactly.** The server node's 15% CPU policy admits at most 3 concurrent fetches and its peak was 3; the desktop's 60% admits at most 12 and its peak was 12. The desktop contributed 2.7 times the capacity.
- **The desktop can disappear and the server node keeps the work moving** at its unchanged rate, and **the desktop took work again 2.4 s after the cable was back.**
- **Correctness:** all 4,000 pages fetched, each result belongs to its own job, no application-visible error, and exactly 4,000 completions (1,271 by the server node, 2,729 by the desktop): no duplicate, no loss. 9 jobs needed a retry; the desktop was told it had lost 8 leases and its stale work was refused.
- **Cost of the control plane** over the 177 s run: Coordinator 41 s CPU and 132 MiB resident; Caddy 19 s CPU, 50 MiB; server node 15 s CPU, 123 MiB; desktop node 29 s CPU, 132 MiB. The Coordinator used about 23% of one core at roughly 1,600 pages a minute with TLS in front of it. Latency p50 2.4 s, p95 8.8 s (queueing behind the concurrency limits, inflated by the outage).

### PrivaSearch on the desktop (Option A), through a Coordinator restart

PrivaSearch's real crawl command ran on the **desktop** host against the server's Coordinator over TLS (nodes: the conservative server node and the larger desktop node; site: eight names on a third host). Twenty seconds in, the Coordinator was killed and restarted six seconds later (PrivaSearch `tests/lan-crawl.mjs`, experiment 9 in its `docs/measurements.md`):

- The platform recovered in seconds: nodes reconnected, the SDK's waits survived, sessions and jobs persisted.
- **PrivaSearch 0.3.1 took 54 s to index its next page**, because it made every URL wait a flat 60 s after a transport failure. That is an application policy, not a platform fault, and was fixed in PrivaSearch 0.3.2 with a pipeline-level backoff: **1.0 s** to the next page, 856 pages fetched, 0 invalid results, 15 submissions retried, and a dead Coordinator is no longer hammered. **Use PrivaSearch 0.3.2 or newer.**
- **All of the work went to the desktop node; the server node received none.** The Coordinator hands a job to whichever capable node asks first and does not balance load, so when the desktop can absorb the whole workload the conservative server node stays idle. For a control-plane host that is the desirable outcome, but do not expect an even split; the server node contributes when the desktop is busy or away (as in the workload above, where the pulled cable moved all the work to it).

This measured the deployment, not the platform: it is not a throughput benchmark and found no bottleneck.

## Network model (from the code)

| Question | Answer |
| --- | --- |
| Default bind | `PRIVANET_HOST=127.0.0.1`, `PRIVANET_PORT=4010`, plain HTTP. Anything but loopback is refused unless `PRIVANET_TLS_TERMINATED=true` acknowledges a TLS terminator in front (`apps/coordinator/src/config.ts`). |
| Bind to a LAN address safely? | Only behind a TLS proxy, as an acknowledgement; the flag does not add TLS. The shipped setup keeps the Coordinator on loopback and exposes only the proxy. |
| Ports | One listener (4010 by default) for nodes, applications and the admin API. With Caddy: TCP 443 on the LAN. |
| Native TLS | No. TLS is the reverse proxy's job. |
| Does a node need inbound connectivity? | **No.** The node's work path (heartbeat, leases, results) only makes outbound requests; the LAN test ran the desktop with an inbound-drop firewall and no socket listening on the network. (Since the control panel the node also listens on `127.0.0.1:4040`, reachable from that machine only; `PRIVANODE_PANEL=off` removes it. This was true as validated at 0.3.0-alpha.5: then there was no listener at all.) |
| Does the Coordinator connect out? | **No.** `apps/coordinator` contains no outbound request code. |
| What is node-initiated? | Everything: enrollment, authentication, heartbeats, lease polls and waits, renewals, completions, releases, goodbye. Applications likewise. |
| DNS and IP assumptions | None beyond the URL you configure (IP or name). A node pins the exact origin and the Coordinator ID on first contact. |
| Loopback assumptions left in production paths | Only defaults (`127.0.0.1:4010` for the Coordinator bind, the node's and tools' default URL) and the transport rule that plain HTTP is allowed only to literal loopback with an explicit flag. None blocks separate-host use, and none was weakened: a LAN is not trusted, TLS is verified, and there is no insecure LAN mode. |

## Security and admin exposure review

| Surface | Protection | Where it should be reachable |
| --- | --- | --- |
| `GET /v1/health` | none beyond the protocol header; returns protocol and service version and the Coordinator ID | LAN, through the proxy (a node reads it before authenticating) |
| `/v1/enrollment/*`, `/v1/auth/*` | a valid, unexpired, unused one-time token (enrollment) or an Ed25519 proof of the enrolled key (auth); rate-limited per connecting address; challenges are one-use and expire; at most 1,000 outstanding | LAN, through the proxy; inert without a token |
| `/v1/admin/*` (enrollment tokens, applications, revocation, node list, rotation) | the 256-bit admin secret, compared in constant time | **Loopback only**: refused with 403 at the proxy (verified, even with the right secret); use `privanet-admin` on the server |
| `/v1/node/*` | per-node session bearer (random, stored as a hash, 5 min by default), and every lease, renewal and result is fenced to the node and lease | LAN, through the proxy |
| `/v1/jobs*`, `/v1/capabilities` | per-application bearer, job types scoped per application, a job readable only by its owner, fetch jobs need the administrator-registered identity | LAN, through the proxy |

Findings: **nothing is unsafe for a LAN deployment and no admin-plane redesign is needed.** Notes: the admin secret has no rotate command (edit `coordinator.env` and restart; nodes and applications are unaffected); the per-address rate limit treats everything behind one proxy as one address (measured: 45 nodes enrolling at once still converge, see [MULTI_NODE_VALIDATION.md](MULTI_NODE_VALIDATION.md)); setting `PRIVANET_TLS_TERMINATED=true` while binding a LAN address with no proxy would expose the admin API over plain HTTP, which is why the shipped configuration binds loopback. The node's fetch guard stops fetch jobs reaching private addresses, so a node on the home network cannot be pointed at other devices.

## Bugs found and fixed in this pass

1. **A proxy's error page became a parse error.** With a TLS proxy in front, a stopped Coordinator produces an empty 502; the shared transport tried to parse it as JSON and threw a bare `SyntaxError`. It is now an API error (`INVALID_RESPONSE`, status 502), which the node logs by name.
2. **Applications lost their wait across a Coordinator restart.** `waitForResult` threw on the first connection failure or 502 even though the job was durable. It now retries transient failures with backoff until its own deadline, and does not retry real refusals (401, 403, 404, 409, 429 and other 4xx). Submissions should still be retried by the caller with the same idempotency key.
3. **Connection failures gave the operator nothing to act on.** The node logged `TRANSPORT_ERROR` for a bad certificate, a wrong address, a refused connection and a timeout alike. It now adds `reason` from a fixed vocabulary (`TLS_CERTIFICATE`, `DNS`, `CONNECTION_REFUSED`, `TIMEOUT`, `UNREACHABLE`, `CONNECTION_RESET`, `OTHER`) that never contains an address, URL or message.
4. **Configuration errors crash-looped opaquely.** A bad setting printed `startup_failed` and exited 1, which a service manager retries forever. The Coordinator and node now print `config_invalid` with the **names** (never values) of the offending settings and exit **78**, which the shipped units treat as "do not restart". A node pointed at a different Coordinator than it first met now logs `node.coordinator_binding_changed` and exits 78 instead of retrying silently forever.
5. **The shipped README described v0.2.1** (two diagnostic jobs only, no web fetch). Corrected.

## Not verified

- **Real systemd.** The units were never started under systemd here; they passed `systemd-analyze verify` and are checked against the code. The hardening options (`ProtectSystem=strict`, `PrivateDevices`, `RestrictAddressFamilies`) are the likeliest thing to need adjusting on a real machine; the manual check below finds out in minutes.
- **Real network equipment:** a physical switch, Wi-Fi, MTU, sleep and wake of a desktop, router DNS and DHCP behaviour. A desktop that sleeps behaves like the pulled cable, which was tested.
- **Windows and macOS on a LAN.** Only Linux hosts were used.
- **Caddy other than 2.6.2, and a Proxmox host or LXC specifically.** The Caddyfile uses ordinary directives, but only 2.6.2 was run.
- **The open web from your network.** The nodes fetched a local site; the public-URL proof is in PrivaSearch's CI.
- **Long duration.** The longest run here was minutes. Nothing was observed over days (memory growth, the SQLite file, log volume).
- **Restore onto a different host.** Backup and restore are tested on one host ([deployment.md](deployment.md)).

## Manual two-machine check (about 30 minutes)

Follow FIRST_DEPLOYMENT.md, then confirm each line. Anything that differs is a finding to report.

1. Server: `systemctl status privanet-coordinator caddy` both `active (running)`; `journalctl -u privanet-coordinator` shows `coordinator.started`. If a unit fails at once, read `journalctl -xe`; a sandboxing option blocking something is the expected cause.
2. Server: `ss -ltn` shows `127.0.0.1:4010` and `:443`, and nothing else from PrivaNet.
3. Desktop: `curl --cacert root.crt -H 'X-PrivaNet-Protocol: 1' https://10.0.0.68/v1/health` returns `"status":"ok"`. Without `--cacert` it must fail on the certificate.
4. Desktop: `curl --cacert root.crt -H 'X-PrivaNet-Protocol: 1' -H 'Authorization: Bearer x' https://10.0.0.68/v1/admin/nodes` returns 403.
5. Desktop: `ss -ltn` shows no PrivaNet listener; enrol the node; `sudo privanet-admin nodes` on the server lists it `ONLINE` with the desktop's `daemonVersion`.
6. `sudo systemctl stop privanet-coordinator`; on the desktop the log shows `node.connection_failed` with a `reason` or `INVALID_RESPONSE` and the process stays up; start it again; `node.authenticated` appears within about a minute with no action from you.
7. `sudo systemctl stop privanet-node` on the desktop: log shows a clean drain and `node.departed`; `privanet-admin nodes` shows `OFFLINE_EXPECTED`. Start it again: `ONLINE`, same node ID.
8. Submit one small job (the first-task step in FIRST_DEPLOYMENT.md, `PRIVANET_DEMO_FETCH_URL=https://example.com/ node tools/demo.mjs`) or a short PrivaSearch crawl from the desktop (`NODE_EXTRA_CA_CERTS` set) and confirm it completes; pull the desktop's network for a minute mid-crawl and confirm pages keep completing on the server node.
9. Reboot the server: the Coordinator, Caddy and (if enabled) the server node come back by themselves and the desktop reconnects.

## What this deployment proves, and what it does not

**It proves:** trusted nodes you control; LAN or private-overlay operation; independent physical-style hosts with separate network stacks and firewalls; a real Coordinator and worker separation in which the worker needs no inbound port and the Coordinator never calls out; TLS with verified certificates; recovery from Coordinator, proxy and network outages; and mixed-version upgrades with real binaries.

**It does not prove:** arbitrary public nodes; hostile or malicious workers (a node can still fabricate a schema-valid result, and nothing attests execution); Sybil resistance; public enrollment; economic rewards; or community reputation. None of that is implemented here, and none of it should be inferred from this deployment working. Those are Phase 10 and later ([ROADMAP.md](../ROADMAP.md)). It also says nothing about a Coordinator exposed to the Internet or a contributor outside the LAN: the exposure review below is for a LAN. That has its own, separate review ([EXPOSURE_REVIEW.md](EXPOSURE_REVIEW.md), written for [Phase 3.5](../ROADMAP.md#phase-35--remote-node-onboarding--contributor-experience--implemented)) and its own tests (`npm run test:proxy` in CI against a real Caddy, and `tools/check-exposure.mjs` to run from another machine; [PUBLIC_NODE.md](PUBLIC_NODE.md)). That review is the project's own, not an independent audit, and nothing in it was run against a real Internet client or a real certificate authority.
