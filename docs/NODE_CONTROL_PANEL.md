# The node control panel and local controls

A post-3.5 contributor-experience milestone (not a numbered phase; the roadmap numbering is unchanged). Goal: install PrivaNet, join a Coordinator, choose how much of the computer to contribute, see what the node is doing and why, and troubleshoot it, without editing configuration files.

Everything here is **local to the machine that runs the node**. The panel and the CLI read and write the same files the daemon reads (the resource policy and a small local-state file); they add no Coordinator route, no new protocol message and no way for the Coordinator, an application or the network to change a node's limits.

## Opening the panel

The node serves a panel on **`http://127.0.0.1:4040/`** (this machine only). The address is set by `PRIVANODE_PANEL_PORT`; `PRIVANODE_PANEL=off` disables it. If the port is taken the node logs `panel.unavailable` and keeps working.

The panel needs a sign-in secret that lives in `<state dir>/panel-token` (mode 0600, readable only by the node's account). Get a sign-in link with:

| Where | Command |
| --- | --- |
| Linux (installed) | `privanet-panel` (prints the link) or `privanet-panel --open` (opens your browser through a private 0600 redirect file, so the secret is not in a process list). The Linux installer also adds a desktop entry, "PrivaNode Control Panel". |
| Windows (installed) | Start Menu → "PrivaNode Control Panel" opens `http://127.0.0.1:4040/`; sign in with the link from `privanet-node panel` (run it in the account that owns the node's state). |
| Anywhere | `privanet-node panel` (prints the address and the link; `--url-only` prints only the address) |

The part of the link after `#` never goes to the server in the URL: the page posts it once to sign in and the node answers with an HttpOnly, SameSite=Strict cookie. Delete `panel-token` and restart the node to change the secret.

## What the panel shows and does

- **Status**: Connected / Offline / Paused / Draining / Revoked-style states taken from what the node actually knows, the contribution level in effect, and **"Why am I idle?"**: the single most relevant reason derived from live state (paused by you, outside the schedule, on battery, a resource limit, capability disabled, Coordinator unreachable, version incompatible, or genuinely no compatible job on the last lease). It never says "no jobs" unless the last lease really came back empty.
- **Contribution level**: OFF, MINIMAL, ADAPTIVE, FULL (the existing resource-engine levels).
- **Presets** (below), individual resource settings, a weekly schedule editor, and per-capability on/off toggles.
- **Pause** for 15 minutes, 1 hour, until tomorrow, until reboot, or indefinitely; **Resume**.
- **Names**: the friendly *local* name you choose (stored locally), the label the Coordinator operator gave the node (read from the Coordinator), and the node ID (a public identifier) are shown separately.
- **Jobs**: aggregate counts (running, completed, failed, last result code) and the type and age of any running job; **never payloads or URLs**.
- **History**: bounded local history (288 points, 5 minutes apart, about 24 hours) of the node's own resource measurements. It distinguishes what is *configured*, what is *permitted right now*, and what was *measured*. No accounting, credits or "earnings" exist (that is a later phase).
- **Diagnostics**: runs `doctor` (non-mutating, secret-safe); each check has a status word and text, never colour alone.
- **Actions** (a fixed allowlist): pause, resume, save policy, rename, toggle capabilities, run diagnostics, create a support bundle, check for updates (when configured), **Drain and stop** and **Restart** (each asks for confirmation).
- **Privacy**: what stays on the machine, what the Coordinator sees, and the outbound requests the node makes.

Job slots (how many jobs may run at once) are set under Contribute, or with `privanet-node slots show|set N|clear`; the choice is saved in `local-state.json` and applies **the next time the node starts** (the panel says so, and Restart is one click). An explicit `PRIVANODE_JOB_SLOTS` in the service environment takes priority and, while it is set, the panel shows the number read-only. More slots never raise your limits: the same CPU, memory and bandwidth budgets are shared between the jobs. Other things the panel cannot change: `fetch` policy changes take effect after a restart (the panel says so), and `fetch.unsafeLocal` (the SSRF escape hatch) can never be set from the panel, a preset, an import or a saved policy.

## Which setting wins

One rule everywhere: **what an administrator sets explicitly in the environment beats what the owner saved from the panel or the CLI, which beats the default.** The panel (Contribute, "Where each setting comes from") and `privanet-node settings [--json]` report the value in effect, where it came from, and what is locked; a locked value is shown but cannot be changed, and the panel and CLI say so instead of pretending.

| Setting | Order (first wins) | Changed by | Applies |
| --- | --- | --- | --- |
| Job slots | `PRIVANODE_JOB_SLOTS` > saved (`slots`, panel) > 1 | panel, `slots` (not while the environment sets it) | next start |
| Resource policy | `PRIVANODE_POLICY_LOCKED=true` (the policy file alone) > saved `policy.json` (panel, `policy`) > installer's `PRIVANODE_POLICY_FILE` > defaults | panel, `policy` (refused when locked) | at once (fetch limits: next start) |
| Capabilities | `PRIVANODE_CAPABILITIES` > what the node enrolled with; the owner can only switch some **off** (saved) | panel, `capability` | at once |
| Coordinator | `PRIVANODE_COORDINATOR_URL` > enrollment record > loopback default | environment or re-enrolling only | next start |
| Panel on/off and port | `PRIVANODE_PANEL`, `PRIVANODE_PANEL_PORT` > on, 4040 | environment only | next start |
| Local chunk store (`storage.enabled`, `maxBytes`, `reserveFreeBytes`) | the same as the resource policy: lock > saved > installer file > defaults (off) | panel (Contribute), `policy import` (refused when locked) | at once (opens/closes the store, applies limits) |
| Node display name | saved only (a label on this machine) | panel, `name` | at once |
| Pause | saved only; ends by itself or with Resume | panel, `pause`, `resume` | at once |
| Updates | never automatic; `update check` runs only when asked | | |

The installer always sets `PRIVANODE_POLICY_FILE`, so that file is the *starting point*: the owner's saved policy wins over it, which is why the table lists the policy lock separately. An administrator who wants the file to be the last word sets `PRIVANODE_POLICY_LOCKED=true`: the saved policy is then ignored (and left alone on disk), and `policy import|preset|reset`, the presets and every edit in the panel are refused with `POLICY_LOCKED_BY_ENVIRONMENT`. `config check` says when an environment setting hides a saved value.

A damaged `local-state.json` (for example a job-slot number outside 1 to 64) is never partly used: the node starts on the defaults, holds itself paused, and says so in `status`, `settings`, the panel and `config check`; every writing command refuses, changes nothing and tells you to run `privanet-node config check` and fix or move the file aside. State files are written atomically (a temporary file, flushed, renamed) and are mode 0600 inside the private state directory on Linux and macOS; on Windows the state directory's access control list is what protects them (not verified on a real machine).

## Local storage (0.4.0-alpha.1)

The Contribute tab has a **Local storage** section (off by default: an on/off box, the most to store and the disk to always leave free) and the Status tab a **Local storage** card (state, health, chunks and bytes used, your limits, room now). `privanet-node storage status [--json]` shows the same from a shell (read-only, creates nothing, works while the node is stopped). The settings are part of the resource policy, so they follow the same precedence, are shown as locked under `PRIVANODE_POLICY_LOCKED`, are included in `policy export`, `config check`, `settings` and the support bundle (counts and health only, never a path or a chunk list), and never make a preset "Custom".

Storage capacity alone opens no transfer port. Alpha.3 adds a separate **Direct TLS transfer** section: explicit listener enable, literal bind/port, reachable advertised HTTPS origin, local certificate/key file paths, and total/PUT concurrency. Environment-set fields and policy locks remain authoritative. The panel distinguishes capacity, listener/advertisement state, active PUT/GET/DELETE, aggregate bytes/completions/failures and queued receipts. Certificate/private-key contents, tickets and holder material are never exposed. There is no file browser or arbitrary upload/download API. See [DIRECT_TRANSFER.md](DIRECT_TRANSFER.md). Turning storage/listener off aborts direct activity and retains committed chunks; lowering limits never deletes data.

## Presets

A preset is a set of ordinary resource-policy values, not a second engine. Choosing one changes **only** the listed fields; your schedule, per-capability limits, fetch limits and preemption settings are kept. Changing any one of those fields afterwards shows "Custom". *Balanced* equals the shipped conservative default.

| Field | Minimal | Balanced (default) | Generous | Maximum while idle |
| --- | --- | --- | --- | --- |
| Default level | MINIMAL | ADAPTIVE | ADAPTIVE | ADAPTIVE |
| Max CPU | 10% | 25% | 50% | 90% |
| Keep free for you (CPU) | 30% | 20% | 15% | 10% |
| Max memory | 256 MiB | 1 GiB | 2 GiB | 4 GiB |
| Keep free for you (memory) | 3 GiB | 2 GiB | 2 GiB | 2 GiB |
| Disk contribution | 512 MiB | 1 GiB | 4 GiB | 10 GiB |
| Keep free (disk) | 10 GiB | 5 GiB | 5 GiB | 5 GiB |
| Disk I/O | low | medium | medium | high |
| Bandwidth | 256 KiB/s | 1 MiB/s | 4 MiB/s | no cap |
| Monthly transfer | 2 GiB | 10 GiB | 50 GiB | no cap |
| On battery | disable | reduce | reduce | disable |
| Minimal-level share | 10% | 10% | 10% | 10% |

All limits stay absolute: the Coordinator cannot raise them, and the resource engine still gives way when you use the machine. The values are in `apps/node/src/presets.ts` and unit-tested.

Install with a preset: `install-node.sh --preset generous` / `install-node.ps1 -Preset Generous`. From a shell: `privanet-node policy preset balanced`.

## Pausing

Pausing is an owner decision stored in `<state dir>/local-state.json`, separate from revocation (which is the Coordinator operator's decision and is shown as a different state). A pause survives a node restart and ends by itself: timed pauses by the clock, "until tomorrow" at the next local midnight, "until reboot" when the machine's boot time changes (with a 2 minute tolerance), "indefinitely" only when you resume. If the local-state file cannot be read at startup, the node stays **paused** rather than guessing.

`privanet-node pause 15m|1h|tomorrow|reboot|indefinite` and `privanet-node resume` do the same from a shell, offline or online.

## Where settings are stored

| File (in the state directory, all mode 0600) | Content |
| --- | --- |
| `policy.json` | `{version: 1, preset?, savedAt, policy}`: the saved owner policy. Takes precedence over the installer's `PRIVANODE_POLICY_FILE`, which remains the base. |
| `local-state.json` | `{version: 1, name?, pause?, disabledCapabilities, jobSlots?}` |
| `status.json` | Snapshot the node publishes every 10 s so `privanet-node status` works while it runs (stale after 35 s) |
| `history.json` | Bounded resource history |
| `panel-token` | Panel sign-in secret |

Writes are atomic (temporary file, flush, rename) and keep a `.bak` of the previous policy. **Migrations**: a bare policy file from before this milestone is read as version 0 and saved as version 1 on the next save. A file with a *newer* version than this node understands, or one that is invalid or unsafe, is **not applied and not overwritten**: the node falls back to the base policy and reports the problem in `config check`, the panel and the logs.

## CLI

```
privanet-node status [--json]                 what the node is doing now, and why it is idle
privanet-node pause 15m|1h|tomorrow|reboot|indefinite     privanet-node resume
privanet-node config check [--json]           validate policy, local state and environment offline (names settings, never values)
privanet-node policy show|export FILE|import FILE|reset|preset NAME
privanet-node name show|clear|set "My laptop"   the local friendly name
privanet-node capability enable|disable CAP   offer fewer capabilities (can only narrow what was enrolled)
privanet-node slots show|set N|clear          how many jobs may run at once (applies at the next start)
privanet-node settings [--json]               the effective value of every setting and where it came from
privanet-node panel [--url-only]              panel address and sign-in link
privanet-node support-bundle [FILE] [--no-network]   a secret-free diagnostic bundle
```

Exit codes: 0 success, 1 the checked thing has a problem, 78 usage or configuration error. `--json` output is stable and secret-free. `policy export` omits identity and `fetch.unsafeLocal`; `policy import` validates exactly as the panel does and refuses unsafe policies.

## Support bundle

`privanet-node support-bundle` (also a panel button) writes a JSON file of **allowlisted facts**: versions, platform, resource totals, the sanitized configuration (setting names and safe values), policy summary, status, doctor results and the last log lines. Every string is passed through redaction (private-key blocks, authorization and cookie headers, bearer and JWT tokens, URL credentials, secret-named assignments, known token prefixes, long hex and base64 runs, invite/request codes, e-mail addresses, your home directory and user name) and a fail-closed final scan refuses to write a bundle that still looks like it holds a secret. It never includes the private key, enrollment secrets, application credentials, auth headers or the administrator secret, which the node does not hold anyway. Tests plant secrets in every input and assert none reach the output. Review the file before you share it; this is a safeguard, not a promise about every possible free-text value.

## Security design

- Binds **127.0.0.1 only** (never configurable to another address).
- **Host** must be `127.0.0.1:PORT` or `localhost:PORT` (defeats DNS rebinding); POSTs need an allowed **Origin**, a CSRF header and `application/json`.
- Every `/api` route, reads included, needs the **session cookie**; the secret is 256-bit; sign-in failures are limited (5 per minute); sessions last 12 hours, at most 16.
- **CSP** with a per-response nonce (`default-src 'none'`), no inline style attributes, no `innerHTML`/`eval`; `X-Frame-Options`/`nosniff`; **no CORS** headers; only GET and POST.
- Bodies are limited to 32 KB (413) and parsed with strict schemas.
- **No endpoint** fetches a URL, reads or writes an arbitrary file, runs a command, evaluates code, or exposes the private key or the environment. Actions are a fixed allowlist; drain and restart require `{"confirm": true}`. Restart is the process exiting with status 75 so the service manager starts it again.
- State files are written atomically with mode 0600.

Tests: `tests/panel.test.ts` (including a real-process end-to-end run), `local-control.test.ts`, `local-cli.test.ts`, `support-bundle.test.ts`, and the installer tests. The panel's page was also exercised by hand in a headless Chromium; that check is not part of CI.

## Updates, rollback, completions and what is deferred

- **Update check.** `privanet-node update check` (or "Check for update" in the panel) makes one HTTPS request, only when you ask, to GitHub's latest-release address for this project (no redirects, a small validated answer, nothing about the node sent beyond a `privanet-node/VERSION` User-Agent). It says whether a newer release exists and where its notes are. **It never downloads or installs anything**, and the node never updates itself, so new code never runs without the owner deciding. An unreachable server, an unexpected answer or a foreign release address is reported as "could not check" and changes nothing. Automatic update (and any "update too large to apply silently" notification) is **not implemented**: there is no auto-update to be silent about.
- **Upgrading** is the installer: run the new release's `install-node.sh` / `install-node.ps1` (verified against `SHA256SUMS.txt`, see [INSTALLER.md](INSTALLER.md)). It keeps the identity and the state directory. **Rollback** is installing the previous release the same way: the installer keeps each release in its own directory and switches a `current` link, so the old files are still there until you remove them; `policy.json` and `local-state.json` are versioned, and an older node ignores them. An in-place "update now" and "roll back" button in the panel is **deferred**: it would make the panel a way to run downloaded code, which this milestone deliberately does not add.
- **Version compatibility** is shown on both sides: the node's status says whether the Coordinator is current, newer, older, incompatible or unknown (the protocol decides; software versions only inform), and the operator dashboard shows the same per node.
- **Shell completions** for `privanet-node`: `privanet-node completions bash|zsh|fish|powershell` prints a script made of command and option names only (no secrets, no node or network calls). bash: `source <(privanet-node completions bash)` or save it under `/etc/bash_completion.d/`; zsh: save as `_privanet-node` on your `$fpath`; fish: `privanet-node completions fish > ~/.config/fish/completions/privanet-node.fish`; PowerShell: add `privanet-node completions powershell | Out-String | Invoke-Expression` to `$PROFILE`. `privanet-admin completions bash|zsh|fish|powershell` works the same way (command and option names only; it needs neither the Coordinator nor the administrator secret).
- **Desktop convenience:** a Linux desktop entry and a Windows Start Menu shortcut open the panel in your browser. A **system tray icon is deferred** (it needs a native, per-platform component; no Electron or bundled browser is added).
- **Not done in this milestone:** per-job accounting or history beyond aggregate counts (a later phase), and any change to how the Coordinator schedules or admits nodes.

## Upgrading a 0.3.5 node

Install the new release over the old one (the installer keeps the identity and state), or replace the program files. Nothing needs editing: an existing `PRIVANODE_POLICY_FILE` keeps working as the base policy, the first save from the panel or CLI creates `policy.json`, and the panel starts on 127.0.0.1:4040 (set `PRIVANODE_PANEL=off` to disable it, or `PRIVANODE_PANEL_PORT` if 4040 is used). The Coordinator and the protocol are unchanged, so old and new nodes mix freely. Downgrading to a node without this milestone ignores `policy.json` and `local-state.json` (so presets and pauses stop applying); nothing is corrupted.

## Not covered here

Another user on the same machine who can read the node's state directory can read the panel secret (the state directory is private to the node's account by design). A browser extension with access to `127.0.0.1` pages is outside this model. Nothing here is an independent security review.

The operator's side is [OPERATOR_DASHBOARD.md](OPERATOR_DASHBOARD.md).

See also [RESOURCES.md](RESOURCES.md), [ONBOARDING.md](ONBOARDING.md), [INSTALLER.md](INSTALLER.md) and [security.md](security.md).
