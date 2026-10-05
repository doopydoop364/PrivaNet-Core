#!/bin/sh
set -eu
# Opt-in only. Run from an unpacked, checksum-verified Core distribution.
[ "$(id -u)" -eq 0 ] || { echo 'Run as root.' >&2; exit 1; }
case "${1:-}" in ''|--enable) ;; *) echo 'Usage: install-updater.sh [--enable]' >&2; exit 2 ;; esac
command -v python3 >/dev/null
command -v systemctl >/dev/null
source_dir=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd -P)
install -d -m 0700 /var/lib/privanet-updater /var/lib/privanet-updater/backups
install -d -m 0755 /etc/privanet
install -m 0755 "$source_dir/bin/privanet-update" /usr/local/bin/privanet-update
install -m 0644 "$source_dir/systemd/privanet-update.service" "$source_dir/systemd/privanet-update.timer" /etc/systemd/system/
if [ ! -e /etc/privanet/updater.json ]; then
  install -m 0600 "$source_dir/env/updater.json.example" /etc/privanet/updater.json
fi
systemctl daemon-reload
if [ "${1:-}" = --enable ]; then systemctl enable --now privanet-update.timer; fi
printf '%s\n' 'Updater installed. Review /etc/privanet/updater.json; privanet-update --check previews updates.' 'Stable releases only by default. Core alpha updates require channel "prerelease".' 'Enable with: systemctl enable --now privanet-update.timer'
