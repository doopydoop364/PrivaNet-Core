#!/bin/sh
# Root installer validation on a disposable overlay, never the host deployment.
# Run from the repository root. Requires Linux, unshare, overlayfs and mount privileges.
set -eu
if [ "$(id -u)" -ne 0 ] || [ ! -f package.json ] || [ ! -f tests/installer.test.ts ]; then
  echo 'Run as root from the PrivaNet-Core checkout.' >&2
  exit 1
fi
repository=$(pwd -P)
for tool in unshare mount chroot ip getent userdel groupdel shellcheck; do command -v "$tool" >/dev/null; done
installer_sandbox=$(mktemp -d /tmp/privanet-installer-isolated.XXXXXX)
chmod 700 "$installer_sandbox"
# All mounts, process visibility, loopback traffic, account and service mutations
# below exist only inside these namespaces. Remove the overlay after they exit.
trap 'rm -rf "$installer_sandbox"' EXIT HUP INT TERM
unshare --mount --pid --net --fork /bin/sh -eu -c '
  mount --make-rprivate /
  mkdir "$1/upper" "$1/work" "$1/root"
  mount -t overlay overlay -o "lowerdir=/,upperdir=$1/upper,workdir=$1/work" "$1/root"
  mount -t tmpfs tmpfs "$1/root/run"
  mount -t tmpfs tmpfs "$1/root/tmp"
  mount -t proc proc "$1/root/proc"
  chroot "$1/root" /bin/sh -eu -c '\''
    ip link set lo up
    rm -rf /opt/privanet-node /var/lib/privanet-node
    rm -f /etc/privanet/node.env /etc/privanet/node-policy.json /etc/systemd/system/privanet-node.service
    if getent passwd privanet-node >/dev/null; then userdel privanet-node; fi
    if getent group privanet-node >/dev/null; then groupdel privanet-node; fi
    cd "$1"
    PRIVANET_REQUIRE_SHELLCHECK=1 PRIVANET_INSTALLER_SYSTEM=1 PRIVANET_REQUIRE_INSTALLER_SYSTEM=1 npm run test:installer
  '\'' isolated-installer "$2"
' isolated-installer "$installer_sandbox" "$repository"
