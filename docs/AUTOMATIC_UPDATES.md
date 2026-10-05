# Opt-in Linux systemd updates

Alpha.4 bundles `deploy/bin/privanet-update`, `privanet-update.service`, `privanet-update.timer`, a private config example and `deploy/install/install-updater.sh`. Python 3, systemd, Node/npm (for Search dependencies) and HTTPS access to GitHub/npm are required. Nothing is enabled by the normal node installer or by unpacking a release.

From a checksum-verified unpacked Core distribution, as root:

```sh
sh deploy/install/install-updater.sh
# Preview managed installations and available published releases:
/usr/local/bin/privanet-update --check
# Edit /etc/privanet/updater.json; keep it root-owned, mode 0600.
# To receive Core alpha releases, set "channel": "prerelease".
systemctl enable --now privanet-update.timer
systemctl start privanet-update.service
journalctl -u privanet-update.service --no-pager
systemctl list-timers privanet-update.timer
```

`install-updater.sh --enable` combines install and timer enable. The default channel is stable; prereleases require explicit config. Daily checks run at 04:00 local machine time plus up to 30 minutes random delay; Persistent=true catches a missed run after boot. Disable with `systemctl disable --now privanet-update.timer`. Running `--check` takes the updater lock and may create its private bookkeeping directory, but never downloads a package, stops a service or installs an update.

## What is managed

| Installation | Detected services | Release source |
| --- | --- | --- |
| Root-owned `/opt/privanet` symlink | coordinator, node using that link, roundup wrapper | Core Linux archive + SHA256SUMS |
| Root-owned `/opt/privanet-node/current` symlink | separately installed node | Core Linux archive + SHA256SUMS |
| Root-owned `/opt/privasearch` symlink | `privasearch.service` using that link | Search archive + SHA256SUMS; locked production dependencies with scripts disabled |
| `/opt/privaproxy`, `/opt/privadrive` | corresponding registered service | Checked when present; require published compatible verified release assets |

Services are matched to the actual ExecStart release link, not just a similarly named directory. A node installed separately is not restarted a second time by the Core group. Disabled/inactive services stay inactive. Nodes on another computer need that computer's own timer.

The current PrivaProxy repository has no published-release workflow and PrivaDrive has no implementation. No universal updater can manufacture those packages. Their unmanaged/source installations are reported, not reset or rebuilt in place. The updater does not modify npm-global, git working-tree or home-directory installations. `UNMANAGED_INSTALLATION`, `EXTERNAL_STATE_CONFIG_REQUIRED`, `NO_PUBLISHED_RELEASES` and `VERIFIED_RELEASE_ASSETS_UNAVAILABLE` identify those cases. It neither silently ignores local code changes nor invents an install command. Migrating an existing directory to an immutable root-owned release symlink is an explicit operator step; keep configuration/data outside the release directory.

For non-default service/path layouts, set an explicit `apps` array (this replaces automatic defaults):

```json
{
  "version": 1,
  "channel": "prerelease",
  "backupRoot": "/var/lib/privanet-updater/backups",
  "apps": [
    {"id":"core","kind":"core","link":"/opt/privanet","services":["privanet-coordinator.service","privanet-roundup.service"],"backupPaths":["/var/lib/privanet","/etc/privanet"]},
    {"id":"node","kind":"core","link":"/opt/privanet-node/current","services":["privanet-node.service"],"backupPaths":["/var/lib/privanet-node","/etc/privanet"]},
    {"id":"search","kind":"search","channel":"stable","link":"/opt/privasearch","services":["privasearch.service"],"backupPaths":["/var/lib/privasearch","/etc/privasearch"]}
  ]
}
```

`kind` fixes the upstream to the owner's Core/Search/Proxy/Drive repository; no arbitrary remote install/shell command is accepted. Links/releases must be root-owned, non-writable by other users and under `/opt`; backup sources must be explicit external `/etc` or `/var/lib` paths. Include **all actual state/config paths** if you changed deployment defaults. A custom backupRoot under `/var/lib` also needs a systemd ReadWritePaths drop-in. Never register the backup directory itself as a backup source.

## Update transaction and limits

Updates remain within the installed major/minor series and never downgrade. Stable/prerelease versions are compared numerically (including alpha.3.1 and alpha.10). Core is checked before Search. This does not replace cross-application compatibility testing; application release lockfiles retain their own SDK dependencies.

The updater fetches published GitHub release metadata, validates exact archive and checksum names, downloads through verified HTTPS with no ambient proxy, rejects non-HTTPS/unapproved redirects, bounds download/extraction and rejects traversal, symlinks/hardlinks/devices/setuid archive entries. SHA-256 checks prove agreement with the same trusted repository's release manifest, not independent signing or review. Extracted package version/layout must match the selected release. No downloaded lifecycle scripts execute as root.

Before switching, it stops the affected services in reverse order, makes a complete private state/config tar backup, retains the previous program directory, atomically replaces the program symlink and starts previously active services in dependency order. The installer, service units, environment, enrollment, credentials, policy and state are not overwritten. A systemd startup failure switches program files back and attempts to restart the prior services. **It never automatically restores a historical database, replay or receipt snapshot.** A release with incompatible migrations can require manual recovery from the retained backup; binary rollback is not a guarantee of data-format rollback.

The post-start check is three systemd-active samples over six seconds, not proof of application health, storage endpoint reachability or successful requests. Check daemon health/status and logs after updates. No real host/systemd deployment of the updater was performed in the implementation environment; automated tests exercise parsing, checksums, extraction, private backups, atomic links and failure rollback with service commands mocked.

Full storage backups include chunks: a large storage contribution needs enough backup space. The updater refuses if estimated uncompressed backup bytes plus at least 1 GiB and the largest declared Core storage reserve will not fit. It also requires staging headroom. Use a separate backup volume when practical; backups/old programs are retained and never automatically pruned, so monitor disk use and retire old backups deliberately. The same-service-owner can change state outside service operation; filesystem snapshots are preferable when stronger consistency is needed. The existing single-process state ownership requirement remains.

The timer is not active on this machine or the owner's server merely because it is bundled. Updating the updater's own installed script/units remains an explicit re-run of its installer from a verified newer Core distribution, keeping existing config.
