# What is still unproven: manual validation checklist

CI proves a lot and this page is honest about what it does **not** prove. Every item below stays **NOT DONE** until a person has actually performed it on the real thing and written down the result (date, machine, version, who). Nothing here is a claim that it works; a green CI run is not a substitute. Where a test exists, it is named so nobody mistakes a staged or simulated run for the real one.

Status key: `NOT DONE` (default), `DONE <date> <who> <notes>`.

## What CI covers, and what it only simulates

| Area | CI actually runs | It does **not** prove |
| --- | --- | --- |
| Linux installer | Staged root (`--root`, no account, no service) on `ubuntu-latest`; one real installation **as root on the runner** (creates the `privanet-node` account and files, `--no-service`: no systemd unit is started); shellcheck | A real systemd service under that account, reboot persistence, SELinux/AppArmor, distributions other than the runner's |
| Windows installer | PowerShell parse/static checks; staged `-Root` runs on `windows-latest` (download, verify, unpack, enroll, launcher, uninstall, upgrade) with `-NoService` | Scheduled-task creation, the LOCAL SERVICE account, ACLs on the state directory, reboot persistence, Windows Defender/SmartScreen, a physical machine, battery detection on laptops |
| Local control panel | Unit and real-process tests on Linux/macOS/Windows (loopback bind, auth, CSRF/Origin/Host, CSP); hand-checked in headless Chromium on Linux | Real desktop browsers, a real tray/launcher, the Windows Start Menu shortcut, other users on the same machine |
| Upgrade from v0.3.5 | A v0.3.5-**shaped** install (identity, enrollment, administrator-edited env and policy) upgraded in a staged root on Linux and Windows; a tripwire that the state formats and wire schemas are unchanged since the v0.3.5 tag | Upgrading a node that was **installed by the real v0.3.5 installer** and is running as a real service; downgrade by running the v0.3.5 program on a v0.3.6 state directory |
| Public deployment | A real Caddy in front of a real Coordinator on loopback (`npm run test:proxy`), the exposure checker against it, network-namespace LAN rig with real TLS | Real public DNS, a publicly trusted certificate (ACME), a contributor on another network, ISP/NAT/firewall behaviour |

## 1. Real Windows machine (physical or a full VM, not a CI runner)

- [ ] `NOT DONE` Install with `install-node.ps1` from the **published release** (verify `SHA256SUMS.txt` first), using an invite and again using approval.
- [ ] `NOT DONE` The scheduled task is created, runs under the intended account (LOCAL SERVICE), and the node signs in.
- [ ] `NOT DONE` The state directory ACL is private to that account and administrators (inspect with `icacls`); the panel token file is not readable by another standard user.
- [ ] `NOT DONE` Reboot: the node comes back by itself, with the same identity, and an "until reboot" pause has ended.
- [ ] `NOT DONE` Local panel: open from the Start Menu shortcut, sign in with the link, pause/resume, change a preset, change job slots and restart, run diagnostics, create a support bundle and read it for secrets, check for updates.
- [ ] `NOT DONE` A real job (`system.echo.v1`, then `web.fetch.v1`) runs and the idle explanation is correct while paused, off-schedule and on battery (a laptop).
- [ ] `NOT DONE` Upgrade from a node installed by the real **v0.3.5** installer: same identity, enrollment, name and policy; service restarts.
- [ ] `NOT DONE` Uninstall (keep identity) and `-Purge`; nothing left behind; the old node is revoked by the owner.

## 2. Real systemd machine

- [ ] `NOT DONE` `install-node.sh` on a real host (not `--root`/`--no-service`): the unit is installed, enabled and running as `privanet-node`; `systemctl status`, `journalctl` show sensible, secret-free logs.
- [ ] `NOT DONE` Reboot persistence; `RestartPreventExitStatus=78` behaves (a changed Coordinator binding does not restart-loop).
- [ ] `NOT DONE` Permissions: `/var/lib/privanet-node` 0700 owned by the service account, `/etc/privanet/node.env` 0600, the unit's sandboxing options work on the target distribution.
- [ ] `NOT DONE` Panel through `privanet-panel --open` and over SSH port-forwarding; confirm it is unreachable from another machine.
- [ ] `NOT DONE` Upgrade from a real v0.3.5 installation; `--new-identity --yes`; uninstall and `--purge`.

## 3. Real public deployment

- [ ] `NOT DONE` Real DNS name pointing at the Coordinator host; Caddy with a publicly trusted certificate obtained by ACME (not a test certificate).
- [ ] `NOT DONE` `scripts/check-exposure.mjs` run **from another network**: every admin and application route is refused, only the node routes are reachable, certificate and timing checks pass.
- [ ] `NOT DONE` A contributor outside the LAN installs with an invite, then with owner approval; `privanet-node doctor` run from their machine is useful when something is deliberately broken (wrong name, blocked port, clock skew).
- [ ] `NOT DONE` `/v1/admin/*` is inaccessible from the Internet (and `privanet-admin ui` is not exposed).
- [ ] `NOT DONE` A revoked node is blocked and cannot return; invites cannot be reused or guessed (rate limits observed).
- [ ] `NOT DONE` A restore rehearsal of the Coordinator backup on separate hardware.

## 3b. The local chunk store (0.4.0-alpha.1) on real filesystems

- [ ] `NOT DONE` NTFS (a real Windows machine): rename-over-existing, directory and file permissions inside the store, behaviour when antivirus holds a file open, long paths, the Windows safe-by-ACL claim in `docs/security.md`.
- [ ] `NOT DONE` macOS APFS and a real Linux ext4/xfs: `fsync` behaviour, case sensitivity, a genuine power-cut test (pull the plug during a put, then start the node and run `privanet-node storage status`).
- [ ] `NOT DONE` A removable or network filesystem as the state directory: confirm the node refuses or degrades safely (it checks permissions and links, not the filesystem type).
- [ ] `NOT DONE` A full-disk drill: fill the volume to the reserve with another process while a large put runs.

## 4. Control panel and CLI on real desktops

- [ ] `NOT DONE` Firefox, Chrome/Edge and Safari: sign-in link, every tab, no console errors, keyboard and screen-reader pass (state is shown as words, but this was not tested with assistive technology).
- [ ] `NOT DONE` `privanet-node completions` for bash, zsh, fish and PowerShell loaded in real shells (CI parses bash only and checks the text of the others).
- [ ] `NOT DONE` Linux desktop entry and `privanet-panel --open` with a real `xdg-open` and session.

## 5. Independent review

- [ ] `NOT DONE` No independent security review has been performed on any part of PrivaNet. Before Phase 4's ticket protocol (see [PHASE4_DESIGN](PHASE4_DESIGN.md)) and before any public enrollment, commission one.

When an item is performed, change its status line to `DONE <date> <who>: <what was observed>` in the same commit as any fix it prompted, and update the Phase 3.5 status in the [ROADMAP](../ROADMAP.md).
