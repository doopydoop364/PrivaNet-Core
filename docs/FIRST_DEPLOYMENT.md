# First deployment: a home server as the control plane, a desktop as a worker

This is the exact procedure for one topology: an always-on server runs the PrivaNet **Coordinator** (and, optionally, a conservative PrivaNode), and a separate desktop on the same LAN runs an independently enrolled PrivaNode that comes and goes. It uses only commands, files and variables that exist in this repository, and every file referenced below ships in the release archive under `deploy/`.

What was and was not proven, the firewall model, the security review and the readiness verdict are in [DEPLOYMENT_VALIDATION.md](DEPLOYMENT_VALIDATION.md). Read its "What this does not prove" section once.

Addresses below use `10.0.0.68` for the server. Replace it everywhere (Caddyfile, `node.env`) with your server's real, **stable** address: give it a DHCP reservation, or use a host name every machine resolves to it. A node remembers the exact Coordinator URL it first connected to and refuses a different one (see "Changing the Coordinator URL").

## The shape

```text
desktop (PrivaNode)  ---- HTTPS, TCP 443, node-initiated ---->  server 10.0.0.68
server  (PrivaNode)  ---- HTTPS, via the same proxy --------->     Caddy :443  (TLS, local CA)
application (PrivaSearch, anywhere) --- HTTPS -------------->        |
                                                                     v
                                                          Coordinator 127.0.0.1:4010 (plain HTTP, loopback only)
```

- Everything is initiated by the node or the application. The Coordinator never opens a connection, and a node opens no listening port.
- The Coordinator speaks plain HTTP and refuses a non-loopback bind unless you acknowledge TLS termination. TLS is a reverse proxy's job (Caddy here), and nodes and the SDK refuse plain HTTP to anything but literal loopback.
- The Coordinator does not depend on the server's PrivaNode. Stop, crash or remove that node and the Coordinator is untouched.

## Part 1. The server

Linux with systemd (Debian, Ubuntu, or a Proxmox LXC or VM). If this is your Proxmox host, a small LXC or VM with its own address keeps the hypervisor clean; every step is the same. Use the address that machine has.

### 1. Install Node.js and PrivaNet

PrivaNet needs **Node.js 24.4 or newer**, which Debian 12 and Ubuntu 22.04 do not package. Download the Linux tarball of Node 24 from <https://nodejs.org/en/download>, extract it to `/opt/node`, and check `/opt/node/bin/node --version`.

```sh
VERSION=0.3.0-alpha.6     # the release you are installing
cd /tmp
curl -fsSLO https://github.com/doopydoop364/PrivaNet-Core/releases/download/v$VERSION/privanet-$VERSION-linux.tar.gz
curl -fsSLO https://github.com/doopydoop364/PrivaNet-Core/releases/download/v$VERSION/SHA256SUMS.txt
sha256sum -c --ignore-missing SHA256SUMS.txt
sudo tar xzf privanet-$VERSION-linux.tar.gz -C /opt
sudo ln -sfn /opt/privanet-$VERSION-linux /opt/privanet          # upgrades flip this link
sudo install -m 0755 /opt/privanet/deploy/bin/privanet-admin /opt/privanet/deploy/bin/privanet-backup /usr/local/bin/
```

The archive is self-contained (no `npm install`). To build from source instead, see [development.md](development.md) and `node scripts/package-release.mjs linux <dir>`.

### 2. Users, state and configuration

```sh
sudo useradd --system --home-dir /var/lib/privanet --shell /usr/sbin/nologin privanet
sudo install -d -m 0755 /etc/privanet
sudo install -m 0600 /opt/privanet/deploy/env/coordinator.env.example /etc/privanet/coordinator.env
openssl rand -hex 32        # paste the output as PRIVANET_ADMIN_SECRET in /etc/privanet/coordinator.env
sudo editor /etc/privanet/coordinator.env
```

Keep a copy of the admin secret in a password manager: it is not stored in the database, and without it you cannot issue enrollment tokens or application credentials. The defaults in the example are right for this topology (`PRIVANET_HOST=127.0.0.1`, `PRIVANET_PORT=4010`, data in `/var/lib/privanet/coordinator`).

The persistent state is `/var/lib/privanet/coordinator/coordinator.sqlite` (plus `-wal` and `-shm` while it runs). There is no separate initialisation step: the first start creates the database, the Coordinator's random ID and the owner-only permissions.

### 3. TLS with Caddy

The simplest setup that keeps the project's rules: Caddy terminates TLS on the server's address with a certificate from its own local certificate authority, and proxies to the Coordinator's loopback port. Nothing is added to PrivaNet, and there is no "insecure LAN mode".

```sh
sudo apt install caddy                                   # Ubuntu 24.04 ships Caddy 2.6.2, the version the tests used
sudo cp /opt/privanet/deploy/caddy/Caddyfile /etc/caddy/Caddyfile
sudo sed -i 's/10\.0\.0\.68/YOUR-SERVER-ADDRESS/' /etc/caddy/Caddyfile     # skip if it is 10.0.0.68
sudo systemctl restart caddy          # restart, not reload: the Caddyfile turns Caddy's own admin endpoint off
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile     # optional: checks the file (other Caddy versions read the same syntax)
```

The Caddyfile listens on 443 only (no port 80), limits request bodies to 32 KB like the Coordinator does, answers **403 for every `/v1/admin/*` request** so the admin API is unreachable through the proxy, and uses `tls internal`, which issues a certificate whose subject alternative names include the IP address, so `https://10.0.0.68` verifies. Caddy renews its certificates on its own.

Find the certificate authority's root certificate (the file every node must trust):

```sh
sudo find /var/lib/caddy -name root.crt
```

Copy that one file to each machine that will run a node or an application. It is public; it is not a secret, but anyone who can replace it on a node can impersonate your Coordinator to that node, so copy it over a channel you trust.

### 4. Start the Coordinator

```sh
sudo cp /opt/privanet/deploy/systemd/privanet-coordinator.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now privanet-coordinator
sudo journalctl -u privanet-coordinator -n 20        # expect {"event":"coordinator.started"}
```

Check health from any machine that has the root certificate (the protocol header is required):

```sh
curl --cacert root.crt -H 'X-PrivaNet-Protocol: 1' https://10.0.0.68/v1/health
# {"protocolVersion":1,"serviceVersion":"0.3.0-alpha.6","coordinatorId":"...","status":"ok"}
```

If the Coordinator exits with status 78, the log names the invalid setting (never its value) and systemd will not restart-loop it.

### 5. Credentials for PrivaSearch (and any application)

`privanet-admin` reads `/etc/privanet/coordinator.env` (so the secret is never on a command line) and talks to the Coordinator's loopback listener, the only place the admin API is reachable.

```sh
sudo PRIVANET_JOB_TYPES=web.fetch.v1 \
     PRIVANET_FETCH_PRODUCT=PrivaSearchBot PRIVANET_FETCH_INFO_URL=https://your-site.example/bot \
     privanet-admin application privasearch-demand
sudo PRIVANET_JOB_TYPES=web.fetch.v1 \
     PRIVANET_FETCH_PRODUCT=PrivaSearchBot PRIVANET_FETCH_INFO_URL=https://your-site.example/bot \
     privanet-admin application privasearch-public
```

Each prints `{"applicationId":...,"token":...}` **once**. Store the tokens as the two PrivaSearch credentials (its documentation describes the demand and public queues). The fetch identity (product token and an `https` information URL) is what the Coordinator stamps into every fetch lease; use a URL you control, because it ends up in the `User-Agent` that websites see. Applications need no other setup: they reach the Coordinator through `@privanet/sdk` at `https://10.0.0.68` and must trust the same root certificate (`NODE_EXTRA_CA_CERTS=/path/root.crt`).

### 6. The server's own PrivaNode (optional)

```sh
sudo useradd --system --home-dir /var/lib/privanet-node --shell /usr/sbin/nologin privanet-node
sudo install -m 0600 /opt/privanet/deploy/env/node.env.example /etc/privanet/node.env
sudo install -m 0644 /opt/privanet/deploy/policy/server-node.json /etc/privanet/node-policy.json
sudo cp "$(sudo find /var/lib/caddy -name root.crt | head -1)" /etc/privanet/privanet-root.crt
sudo PRIVANET_JOB_TYPES=web.fetch.v1 PRIVANET_ENROLLMENT_TTL_MS=600000 privanet-admin enrollment     # prints a one-time token
sudo editor /etc/privanet/node.env          # set PRIVANODE_ENROLLMENT_TOKEN=<token>; PRIVANODE_COORDINATOR_URL=https://10.0.0.68
sudo cp /opt/privanet/deploy/systemd/privanet-node.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now privanet-node
sudo journalctl -u privanet-node -n 20               # expect {"event":"node.enrolled"}
sudo editor /etc/privanet/node.env          # now delete the PRIVANODE_ENROLLMENT_TOKEN line (single use; it was consumed)
```

The server node connects through the proxy like any other node. It is scheduled exactly like the desktop's node: the Coordinator gives it no special treatment for being on the same machine, and it does not balance load between nodes (a job goes to whichever capable node asks first), so while your desktop can absorb the work this node may receive little or none. The policy is deliberately conservative, see "Resource policies". Turn it off at any time with `sudo systemctl disable --now privanet-node`; nothing else changes.

### 7. Look at it

```sh
sudo privanet-admin nodes
# {"nodes":[{"nodeId":"...","status":"ONLINE","currentJobs":0,"jobSlots":1,"daemonVersion":"0.3.0-alpha.6","lastHeartbeatAt":...}]}
```

Statuses: `ONLINE`, `STALE` (heartbeat late), `OFFLINE`, `DRAINING`, `OFFLINE_EXPECTED` (said goodbye), and revoked nodes are refused. Service logs are structured event names and codes only (no job data, no addresses, no secrets): `journalctl -u privanet-coordinator`, `journalctl -u privanet-node`.

### 8. Back up, restart, upgrade

```sh
sudo privanet-backup                       # /var/backups/privanet/coordinator-<time>.sqlite, consistent, safe while running
sudo systemctl restart privanet-coordinator
```

Also keep, separately and securely: the admin secret, and each node's state directory (`identity.json`, `node-state.json`). Schedule `privanet-backup` from cron or a systemd timer. Recovery and the limits of what has been rehearsed are in [deployment.md](deployment.md).

A Coordinator restart needs nothing from nodes or applications: nodes retry with backoff and reauthenticate (seconds), applications waiting on a result keep waiting, jobs and credentials are in the database, and a job whose node vanished is retried after the lease (`PRIVANET_LEASE_MS`).

**Upgrade** (protocol version 1 is additive: old nodes work with a new Coordinator, and a new node falls back against an old one, both checked with real binaries):

1. Read the release's CHANGELOG for schema or configuration changes.
2. `sudo privanet-backup`.
3. `sudo systemctl stop privanet-node` on the server (graceful drain of its job).
4. Unpack the new archive next to the old one and flip the link: `sudo ln -sfn /opt/privanet-$NEW-linux /opt/privanet`; `sudo systemctl restart privanet-coordinator`; check `coordinator.started` and the `serviceVersion` from the health call.
5. Start the server node; upgrade the desktop node (Part 2); `sudo privanet-admin nodes` shows each `daemonVersion`.
6. **Rollback:** stop the services, flip the link back, start. If the new version ran a database migration, the old binary refuses the database ("schema is newer than service"): restore the backup from step 2 (you lose what happened since) and start the old version.

## Part 2. The desktop

> **Planned simplification (not available yet).** The steps below are the manual procedure, and they are more work than a trusted contributor outside your network should have to do (download the release, copy a CA root, edit `node.env`, handle a long enrollment token, install the service, remove the token). A future milestone, [Remote Node Onboarding / Contributor Experience](../ROADMAP.md#phase-35--remote-node-onboarding--contributor-experience--planned), aims at "run an installer, enter a short code, done" for **trusted, invited** contributors: a public hostname with a publicly trusted certificate, one-command Linux and Windows installers, short-lived invite codes and an optional owner-approval flow. It does not exist yet: there is no installer and no invite or approval command, so use the procedure below. Enrollment will stay controlled by you, the network owner.

### Linux

Same as the server, minus the Coordinator, Caddy and admin steps:

1. Install Node.js 24.4+ and the release archive (step 1 above, without the wrapper scripts).
2. Copy `root.crt` from the server to `/etc/privanet/privanet-root.crt`.
3. Users and files: create the `privanet-node` user; install `deploy/env/node.env.example` as `/etc/privanet/node.env` and `deploy/policy/desktop-node.json` as `/etc/privanet/node-policy.json`.
4. On the server, issue an enrollment token for this node: `sudo PRIVANET_JOB_TYPES=web.fetch.v1 PRIVANET_ENROLLMENT_TTL_MS=600000 privanet-admin enrollment`. The token is single-use and expires (default 60 s; the variable above makes it 10 minutes).
5. Put the token in `node.env` as `PRIVANODE_ENROLLMENT_TOKEN`, set `PRIVANODE_COORDINATOR_URL=https://10.0.0.68`, `PRIVANODE_JOB_SLOTS` (start at 4 and raise it only if the node sits idle while work waits), and install and start `privanet-node.service`. After `node.enrolled` appears, delete the token line.
6. Verify from the server: `sudo privanet-admin nodes` lists the desktop `ONLINE`.

A desktop node that is not a headless box may prefer a *user* service (`systemctl --user`) so it runs only while you are logged in; the same unit works there with `User=`, `StateDirectory=` and `NoNewPrivileges` removed and paths under your home.

### Windows

Not exercised in these tests (the Windows archive and the `DRAIN` file are covered by the ordinary test suite; the LAN test is Linux only). Use the `privanet-<version>-windows.zip` archive and Node.js 24.4+; `bin\privanet-node.cmd` starts the node. Set the same `PRIVANODE_*` variables (and `NODE_EXTRA_CA_CERTS` pointing at `root.crt`, or import the certificate into Windows and use the same variable) as user or system environment variables, run it at logon with Task Scheduler, and drain it by creating an empty file named `DRAIN` in `PRIVANODE_STATE_DIR` (Windows never delivers SIGTERM, so this is the portable graceful stop). Validate it with the manual procedure in DEPLOYMENT_VALIDATION.md before relying on it.

### Day to day

- **Start / restart:** `sudo systemctl restart privanet-node`. The node keeps its identity (`identity.json` in its state directory) and reauthenticates; it does not enrol again.
- **Drain gracefully** (before a shutdown or reboot): `sudo systemctl stop privanet-node` sends SIGTERM, which stops taking work, finishes or hands back what it runs, says goodbye and exits (up to `PRIVANODE_DRAIN_TIMEOUT_MS`, default 30 s; the unit waits 60 s). Or create an empty file named `DRAIN` in the node's state directory. The Coordinator then shows `OFFLINE_EXPECTED`, and its unfinished work is handed back and retried elsewhere without counting against the job.
- **Verify it is connected:** `sudo privanet-admin nodes` on the server, and `{"event":"node.authenticated"}` in the node's log.
- **Coordinator outage:** nothing to do. The node logs `node.connection_failed` with a `code` or `reason` (for example `CONNECTION_REFUSED`, `TIMEOUT`, `DNS`, `TLS_CERTIFICATE`, or `INVALID_RESPONSE` when the proxy answers for a stopped Coordinator), backs off, and reconnects by itself. A job it was running keeps its lease while it can renew it; otherwise the job is retried elsewhere and the node is told it lost the lease.
- **Desktop shuts down or vanishes:** its leases expire and the work moves to another node. Nothing is lost or duplicated.
- **Revoke a node** (lost machine, retired): `sudo privanet-admin revoke-node <nodeId>` (ids from `privanet-admin nodes`). It is refused from then on, including after a Coordinator restart. To bring the machine back, delete its state directory and enrol it again with a new token.

### Changing the Coordinator URL

A node stores the exact URL and Coordinator ID of its first connection (`node-state.json`). If either differs, it logs `node.coordinator_binding_changed` and exits with status 78 instead of retrying. Two cases:

- *Same Coordinator, new address or name:* stop the node, delete `node-state.json` from its state directory (the identity stays), update `PRIVANODE_COORDINATOR_URL`, start it. The Coordinator ID is checked again.
- *Coordinator rebuilt from nothing (new ID):* the old node identities mean nothing to it. Delete each node's whole state directory and enrol again.

## Resource policies

Both nodes use the existing resource engine, configured by a policy file (`PRIVANODE_POLICY_FILE`). The Coordinator can never raise any of these limits: it sees only the resulting budget. Full field reference: [RESOURCES.md](RESOURCES.md).

**Server node** (`deploy/policy/server-node.json`): priorities are the Coordinator first, the operating system and other services second, spare work last. It caps itself at 512 MiB and 15% CPU, insists on 40% CPU and 3 GiB of memory staying free for everything else, keeps 20 GiB of disk free, offers only low disk I/O, limits transfer to 1 MiB/s and 20 GiB a month, hands preemptible work back after 5 s of pressure, never runs free (`ADAPTIVE` always), and is disabled on battery. The systemd unit adds `Nice=15`, `CPUWeight=20`, `MemoryHigh=768M` and `MemoryMax=1G` as defence in depth. Those numbers are an example for a small always-on machine, not a default; the code's defaults are separately conservative. Re-read them against your machine's actual memory and what else it runs (a Proxmox host with virtual machines needs a larger memory reserve).

**Desktop node** (`deploy/policy/desktop-node.json`): up to 4 GiB and 60% CPU, but `ADAPTIVE` (it backs off as the machine gets busy) with a 25% CPU and 4 GiB memory reserve for you, a `FULL` window from 00:00 to 07:00 when you are asleep, reduced contribution on battery, 10 GiB of scratch disk with 20 GiB kept free, 10 MiB/s and 200 GiB a month, and a longer 8 s grace before it hands work back. Graceful drain before a shutdown is the drain procedure above.

Set `fetch.minHostDelayMs` and `fetch.maxRequestsPerMinute` per your politeness policy; the examples keep one request per host per second. The node's fetch guard also refuses every private, loopback and link-local address, so a node on your LAN cannot be used to reach your other devices (only a policy file's `unsafeLocal`, which no shipped policy sets, can change that).

## Firewall

| Machine | Allow | Everything else |
| --- | --- | --- |
| Server | TCP **443** from your LAN or VPN (nodes, applications) | deny (SSH as you already allow it) |
| Desktop | nothing inbound | deny |

- The Coordinator's port 4010 is on the loopback interface and must not be opened. Caddy's configuration opens no port 80.
- A desktop node needs only outbound TCP 443 to the server, plus whatever the fetch jobs reach (DNS and HTTP/HTTPS to the web).
- Application and node traffic share the one listener (443). The admin API is refused at the proxy; use `privanet-admin` on the server.
- The enrollment endpoints are always present on that listener but inert without a valid, unexpired, unused token (one-time, at most 24 hours), and rate-limited per address. Do not expose the server to the public Internet yet; if you ever need remote nodes, put them on a WireGuard-style private network and keep the rule above.
- **Proxmox:** if you use its firewall, allow 443 to the guest or host that runs Caddy and leave 8006 as you already have it.

This model was checked in a test with real separate network stacks and real firewalls: [DEPLOYMENT_VALIDATION.md](DEPLOYMENT_VALIDATION.md).

## Certificates

- **Trust:** a node or application trusts the Caddy root through `NODE_EXTRA_CA_CERTS=/path/root.crt`, which Node reads at process start (restart the node after changing it).
- **Names:** the URL is an IP address, and Caddy's certificate carries that IP as a subject alternative name, so verification works and nothing needs DNS. A host name works the same way if you put it in the Caddyfile and in every `PRIVANODE_COORDINATOR_URL`.
- **Rotation:** by default Caddy's local CA issues short-lived certificates and renews them automatically. Nodes trust the root, so renewals are invisible. Only replacing the root itself (rare) means copying the new `root.crt` to every machine.
- **Failure looks like:** `node.connection_failed` with `"reason":"TLS_CERTIFICATE"` (wrong or missing root certificate, or a URL that is not in the certificate). The node keeps retrying and never enrols or sends a credential to a server it cannot verify.

Alternatives considered: native TLS in the Coordinator (not implemented; the proxy is the project's documented model and avoids certificate handling in the control plane), and a WireGuard overlay (good for reaching nodes away from home, but the nodes would still need TLS or the loopback exception, so it adds a layer rather than removing one). A private overlay plus this TLS is the right shape when you later add remote machines.

## Service management

`deploy/systemd/` has two separate units. Each restarts on failure with a 5 to 10 s delay and a start limit, reads its settings from an environment file (no secrets in a unit), stops on SIGTERM, keeps state in its own `StateDirectory` owned by its own user, and uses `RestartPreventExitStatus=78` so a configuration error is reported once instead of looping. The node unit is ordered after the Coordinator unit but has no `Requires=`: the Coordinator unit knows nothing about the node, so the Coordinator starts first and independently, and a failing node never restarts or affects it.

## Where PrivaSearch runs

PrivaSearch is a separate application in its own repository; it never installs into PrivaNet-Core. Wherever it runs, it uses the same SDK and the same `https://10.0.0.68` interface.

- **A. On the desktop** (PrivaSearch 0.3.2 or newer, which backs off briefly instead of waiting a minute per URL when the Coordinator restarts) talking to the server's Coordinator: set `PRIVANET_COORDINATOR_URL`-style configuration to `https://10.0.0.68` and `NODE_EXTRA_CA_CERTS` to the root certificate. The desktop can then both work for the network and submit to it. (Tested: [DEPLOYMENT_VALIDATION.md](DEPLOYMENT_VALIDATION.md).)
- **B. Later, as its own service on the server**: the same settings, its own user and unit; only a deployment choice.
- **C. On another machine entirely**: the same.

If the application is offline, nodes simply find no work. If the Coordinator restarts, applications waiting on results keep waiting (the SDK retries transient failures until its own deadline).

## Not for this setup yet

Arbitrary public nodes, public enrollment, hostile workers, credits, rewards and reputation are out of scope for this deployment and are not implemented. Easier onboarding for trusted contributors outside the LAN (installer, invite codes, a publicly trusted certificate) is planned separately and is also not implemented: see [the roadmap](../ROADMAP.md#phase-35--remote-node-onboarding--contributor-experience--planned).
