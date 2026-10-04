# Installing a PrivaNode (Linux and Windows)

Status: implemented (`0.3.6`); part of [Phase 3.5](../ROADMAP.md#phase-35--remote-node-onboarding--contributor-experience--implemented). The Linux installer is covered by automated tests, including a real service account; the Windows installer is covered by static checks and by staged-install tests that run on Windows in CI, but **its service registration and access-control steps have not been run by the project on a real machine yet** (see [What is verified, and what is not](#what-is-verified-and-what-is-not)).

The installer is the contributor's half of onboarding. The owner's half is one command (`privanet-admin invite create`, see [ONBOARDING.md](ONBOARDING.md)); the contributor needs the Coordinator's address and the short code. It installs a PrivaNode that runs as a service, enrolls it, and checks that it signed in. It installs nothing else: the node runs only the typed, registered handlers it always did, under the owner's resource policy. There is no remote shell, no script supplied by the Coordinator, no container, no tunnel.

## Linux

Requirements: x86-64 or arm64, systemd, `curl`, `tar`, `sudo` (or run as root), and **Node.js 24.4 or newer** installed already (the release is architecture-neutral JavaScript and does not bundle a runtime). Run it as an ordinary user; it asks for `sudo` only for the install and service steps.

The installer is a small file published next to each release and **pinned to that release**. Do not pipe it to a shell: download it, check it, then run it.

```sh
V=0.3.6      # the release the owner told you to install
BASE=https://github.com/doopydoop364/PrivaNet-Core/releases/download/v$V
curl -fsSLO $BASE/install-node.sh
curl -fsSLO $BASE/SHA256SUMS.txt
sha256sum --check --ignore-missing SHA256SUMS.txt     # the installer itself is on the list: expect "install-node.sh: OK"

printf '%s\n' 'N7K4-PQ2M' > invite.txt && chmod 600 invite.txt      # the code the owner gave you
sh install-node.sh --coordinator https://node.example.com --invite-file invite.txt
rm invite.txt
```

Or let it ask: omit the invite option and type the code at the hidden prompt. Or approve by the owner, with nothing secret at all:

```sh
sh install-node.sh --coordinator https://node.example.com --join --name "Anna's desktop"
# it shows a request code; tell the owner, who runs: privanet-admin approve J4M7-K2Q9 --capabilities web.fetch.v1
```

Success looks like:

```
Downloading PrivaNet 0.3.6 for Linux...
  verified: SHA-256 3b1f...
Installing...
Enrolled.
  Node ID:       node_3a7f19c2...
  Name:          Anna's desktop
  Capabilities:  web.fetch.v1
Waiting for the node to sign in...

Done. This node is installed, enrolled and signed in.
  status:     systemctl status privanet-node          logs: journalctl -u privanet-node -n 50
  diagnose:   sudo -u privanet-node env PRIVANODE_STATE_DIR=/var/lib/privanet-node /opt/privanet-node/current/bin/privanet-node doctor
  uninstall:  sh install-node.sh --uninstall [--purge]
```

### What it does, in order

1. **Everything before the install is unprivileged and changes nothing on the machine.** It reads its options, validates the Coordinator address (https, no credentials), checks the platform (Linux; `x86_64`/`amd64` or `aarch64`/`arm64`; systemd; Node.js ≥ 24.4 on `PATH` or `PRIVANET_NODE_BIN`), reads the invite or token **now**, so a typing mistake costs nothing, and refuses an existing installation unless you said what to do with it.
2. **Downloads `SHA256SUMS.txt` and the archive over HTTPS** with certificate verification always on, TLS 1.2 or newer, and redirects restricted to HTTPS (`--proto-redir =https`), into a private (`0700`) temporary directory removed on exit, on error and on `Ctrl-C`/`SIGTERM`.
3. **Verifies the archive against the published list before anything is unpacked.** The list must name the archive exactly once with a well-formed hash, and the hash must match. With `--sha256 HEX` (a value the owner sent you over another channel) it must also match that: this is the strongest check available, because it does not depend on the download location at all. With `--verify-attestation` it also runs `gh attestation verify` for GitHub's build provenance. Any mismatch stops with status 3 and nothing is installed.
4. **Unpacks safely**: the archive's listing is checked first (every path inside one top directory, no `..`, no absolute paths), it is extracted without the archive's owners or permissions, and the files it must contain are checked.
5. **Only now uses privileges** (`sudo`, or you are root): creates the `privanet-node` system account (no login shell, no password), installs the program under `/opt/privanet-node/<version>` (owned by root, not writable by anyone else) and points `/opt/privanet-node/current` at it, creates `/var/lib/privanet-node` (`0700`, owned by the service account), writes `/etc/privanet/node.env` (`0600`, **no secret**), installs the default desktop policy `/etc/privanet/node-policy.json` if there is none, and installs and enables the systemd unit (hardened: `NoNewPrivileges`, `ProtectSystem=strict`, private tmp, no inbound ports, restart on failure).
6. **Enrolls as the service account**, so the node's private key is created by, and belongs to, the account the service runs as. The secret reaches `privanet-node enroll` on **standard input** through a pipe: never as an argument (so not in `ps`, shell history or `/proc/*/cmdline`), never in a file the installer writes, never in the environment of anything it starts, and never printed. The one-time material is forgotten as soon as it has been used. `--join` shows the request code and waits for approval instead.
7. **Starts the service and verifies sign-in**: it runs the node's own [doctor](ONBOARDING.md#diagnosing-a-node-privanet-node-doctor) until the Coordinator reports this node registered and the service is active (up to a minute), and prints either the success summary or the exact command to find out why not.

Exit statuses: `0` done; `2` usage; `3` verification failed (nothing installed); `4` unsupported platform or missing prerequisite; `5` download failed; `6` install failed; `7` enrollment failed (the installation is kept, and running the installer again with a good invite finishes it); `8` installed, but the node could not be confirmed online.

### First run

Pass `--preset minimal|balanced|generous|maximum-idle` to choose how much of the computer to contribute (the default is the shipped conservative policy); it is saved by the node itself before the service starts. The installer links `privanet-panel`, installs a "PrivaNode Control Panel" desktop entry and prints the first steps; the panel is at `http://127.0.0.1:4040/` (see [NODE_CONTROL_PANEL.md](NODE_CONTROL_PANEL.md)). On Windows the equivalent is `-Preset` and a Start Menu shortcut (not yet verified on a real Windows machine; the installer's static checks run in CI).

### Options

| Option | Meaning |
| --- | --- |
| `--coordinator URL` | required; `https://HOST[:PORT]` only |
| `--invite-file FILE`, `--invite-stdin`, `PRIVANET_INVITE_CODE`, hidden prompt | the short invite code (never an argument) |
| `--token-file FILE`, `--token-stdin`, `PRIVANET_ENROLLMENT_TOKEN` | a long enrollment token instead |
| `--join [--name NAME]` | ask to join and wait for the owner's approval |
| `--install-only` | install without enrolling (enroll later with `privanet-node enroll` or `join`) |
| `--capabilities a,b` | enroll with less than the invite grants |
| `--ca-file FILE` | trust a private CA for the Coordinator (a LAN deployment); a public deployment needs none |
| `--version X.Y.Z` | a different release than this installer belongs to (an installer is pinned to its own) |
| `--sha256 HEX`, `--verify-attestation` | additional verification, above |
| `--release-base-url URL` | download from an HTTPS mirror (verification is unchanged) |
| `--slots N`, `--no-service` | concurrent jobs; install files only |
| `--upgrade`, `--reinstall`, `--repair` | replace the program files of an existing installation; its identity and enrollment are kept |
| `--new-identity --yes` | start over as a **new** node: the old state is moved aside, never deleted ([RECOVERY.md](RECOVERY.md)) |
| `--uninstall [--purge]` | remove the service and program files; `--purge` also deletes the identity and state |
| `--dry-run` | download and verify, say what would be done, change nothing |

An existing installation is **never silently replaced**: without one of the options above the installer stops with a message. Re-running with an invite after a failed first attempt completes it; re-running with `--upgrade` and nothing else changes only the program files.

## Windows

Supported: Windows 10 and Windows Server 2019 or newer, x64 or ARM64, Windows PowerShell 5.1 or PowerShell 7, **Node.js 24.4 or newer installed for all users** (the MSI from nodejs.org; a per-user Node.js under a profile directory cannot be run by the service account, and the installer refuses it). Run from an **elevated** PowerShell (Run as administrator).

```powershell
$V = '0.3.6'
$Base = "https://github.com/doopydoop364/PrivaNet-Core/releases/download/v$V"
Invoke-WebRequest "$Base/install-node.ps1" -OutFile install-node.ps1
Invoke-WebRequest "$Base/SHA256SUMS.txt" -OutFile SHA256SUMS.txt
# Compare the two values: they must be identical.
(Get-FileHash .\install-node.ps1 -Algorithm SHA256).Hash.ToLower()
(Select-String -Path SHA256SUMS.txt -Pattern ' install-node.ps1$').Line
Unblock-File .\install-node.ps1

Set-Content -Path .\invite.txt -Value 'N7K4-PQ2M'        # the code the owner gave you
powershell -NoProfile -ExecutionPolicy Bypass -File .\install-node.ps1 -Coordinator https://node.example.com -InviteFile .\invite.txt
Remove-Item .\invite.txt
```

Without `-InviteFile` it asks at a hidden prompt (`Read-Host -AsSecureString`, which does not enter the history); `-Join` asks the owner to approve instead. The parameters mirror the Linux options: `-Version`, `-CaFile`, `-Sha256`, `-VerifyAttestation`, `-ReleaseBaseUrl`, `-Capabilities`, `-Name`, `-Slots`, `-NoService`, `-InstallOnly`, `-Upgrade`/`-Reinstall`/`-Repair`, `-NewIdentity -Yes`, `-Uninstall [-Purge]`, `-DryRun`. The exit statuses are the same.

What it does: the same verified-download steps (HTTPS only, SHA-256 of the archive against the published list, optional `-Sha256` pin and attestation, a zip unpacked entry by entry with path checks); installs under `C:\Program Files\PrivaNet\node\<version>` (with a `current` junction) and keeps state in `C:\ProgramData\PrivaNet\node` with access limited to SYSTEM, Administrators and the **LOCAL SERVICE** account, set by well-known SIDs so it does not depend on the display language; enrolls with the secret on the node's standard input; registers a **scheduled task** named `PrivaNet Node` that starts at boot as LOCAL SERVICE (no password, no login right), restarts the node every minute if it stops, and has no time limit; starts it; and confirms sign-in with the doctor. The launcher the task runs (`run-node.cmd`) contains no secret and lives where only administrators can write.

A scheduled task is used instead of a Windows service because the node is a Node.js program, not a Service Control Manager binary, and wrapping it would add a third-party service host to the trust chain. The difference users see is that there is no entry in `services.msc`; use `Get-ScheduledTask -TaskName 'PrivaNet Node'`, `Start-ScheduledTask`, `Stop-ScheduledTask` and the doctor (`& 'C:\Program Files\PrivaNet\node\current\run-node.cmd' doctor --coordinator https://...`).

Uninstall and recovery: `-Uninstall` removes the task and program files and keeps the identity; `-Uninstall -Purge` deletes the identity and state too. Reinstalling over an existing installation needs `-Upgrade`; a new identity needs `-NewIdentity -Yes` (the old state is moved aside). See [RECOVERY.md](RECOVERY.md).

Nothing secret appears in the command line (there is no secret parameter), in PowerShell history (the invite is read from a file or a hidden prompt), in transcripts or logs (the script writes none and never echoes the secret), or in any file the installer writes. The invite file you created is yours to delete.

## Trust chain, honestly

- **What protects the download.** HTTPS with certificate verification to the GitHub release; a SHA-256 list that names the archive and the installer; an optional hash pin you obtain from the owner over another channel (this removes the download location from the trust chain); and an optional GitHub build attestation for the archives (a signed statement that the release workflow built them from this repository), verified with the `gh` command.
- **What does not exist.** The project has **no code-signing key**, so the artifacts are not GPG-signed, and the Windows script and archive are not Authenticode-signed. The checksum list is published in the same place as the files, so by itself it detects corruption and a partial compromise of a mirror, not a compromise of the release itself; the `--sha256` pin and the attestation are what cover that. The attestation step is part of the release workflow but has not run yet (no release has been cut with it), so treat it as unproven until the first release that includes it.
- **Why not `curl | sh`.** The installer is a file you can read, hash and keep, pinned to one release, and nothing release-specific is fetched or run until the archive's checksum has been verified. A mutable "latest" script would put a different, unauthenticated program on the machine each time. The instructions above never ask for it, and the installer refuses to run unpinned.
- **Do not paste a code into a stranger's command.** The installer only ever contacts the Coordinator you name and the release location; it will not run anything that Coordinator sends.

## What is verified, and what is not

| Behaviour | How it is checked |
| --- | --- |
| Linux: stamping and syntax (`sh`, `dash`, `bash`), `shellcheck`, no secret parameter | `tests/installer.test.ts`; `shellcheck` runs in CI (the job fails if it is missing) |
| Linux: pinning, https-only, architecture mapping, unsupported platform and Node.js, missing tools | the same file, against fake `uname` results and a fake Node.js |
| Linux: bad, truncated, swapped, duplicated or malformed checksums, a wrong pin, a hostile archive; 404, unreachable server, untrusted certificate, redirect to plain http | the same file; nothing is installed and no temporary file is left |
| Linux: an invite, a token (file, stdin, environment) and an approval install and enroll a node; nothing secret in any file or output; the installed node signs in | the same file, with a real Coordinator behind TLS and the installed files |
| Linux: upgrade keeps the identity, a new identity needs `--yes`, uninstall keeps or purges, interrupted runs clean up | the same file |
| Linux: a **real** installation: the service account exists with no login, ownership and modes, enrollment as that account, uninstall | the same file as root in CI (`PRIVANET_INSTALLER_SYSTEM=1`; a skip is a failure there) |
| Linux: the whole life of a node, for an invite and for an approval: install, enroll, the installed node comes ONLINE, stop and start with no invite, the original invite refused on another machine, revocation stops the node and a restarted revoked node stays off | the same file (`end to end`), running the installed program with the installed state against a real Coordinator behind TLS |
| Linux: the systemd unit **running** under systemd | the unit text is generated and checked, and `systemd-analyze verify` was not run in CI; **starting it under a real systemd was not automated** (the CI container has no usable systemd for it). The manual check below covers it |
| Windows: stamping, no secret parameter, no transcript or history, certificate checks never disabled, SID-based ACLs | static checks that run on every platform |
| Windows: a staged install, verification failures, an invite end to end, nothing secret on disk, uninstall | `tests/installer-windows.test.ts` on `windows-latest` in CI (`-Root` mode: no service, no ACL change). The first run on `windows-latest` found two PowerShell parse errors in the script (fixed); a run that passes after those fixes had not been seen when this was written, so treat these tests as not yet confirmed green |
| Windows: the scheduled task, LOCAL SERVICE, ACLs, junction, reboot start | **not automated and not yet verified on a real machine**; the manual check below is the procedure |

Manual check on a real machine (Linux with systemd, and Windows), about five minutes: install with an invite; confirm `Done. This node is installed, enrolled and signed in`; reboot; confirm the owner's `privanet-admin nodes list` shows the node ONLINE again with **no** invite used; run the installer again with the old invite and confirm it is refused; have the owner `privanet-admin nodes revoke` the node and confirm the node stops authenticating (`doctor` says so); run `--uninstall --purge`.

## Optional alpha.3 direct storage listener

Installations and contribution presets remain compute-only/storage-off by default. Enabling storage capacity alone opens no transfer listener. To opt in after installation, provision a valid TLS certificate and matching owner-private key readable by the installed service account, choose a literal bind address and canonical reachable HTTPS origin, then import the `storage.transfer` policy or set explicit administrator environment overrides. The panel/CLI can edit only permitted owner settings. `privanet-node config check` validates configuration/key safety and `status` reports live listener/receipt activity. No private key is generated, uploaded or included in support bundles by the installer. Firewall forwarding and certificate renewal are explicit operator responsibilities. Setup/reference: [DIRECT_TRANSFER.md](DIRECT_TRANSFER.md).

Root installer validation must use a disposable host. From a privileged Linux checkout, `scripts/test-installer-isolated.sh` runs the existing real installer/account tests inside disposable filesystem, PID and network namespaces. The tests refuse a pre-existing deployment before registering purge cleanup. Do not run the root installation test directly on an installed contributor host.
