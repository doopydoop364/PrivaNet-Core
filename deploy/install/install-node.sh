#!/bin/sh
# PrivaNet node installer for Linux. Installs, upgrades, repairs or removes a PrivaNode on a machine whose owner was invited by a PrivaNet Coordinator's owner.
# Documentation: docs/INSTALLER.md. This file is published as a release asset next to SHA256SUMS.txt and is pinned to ONE release: the version below is stamped in
# when the release is built, and nothing release-specific is downloaded or run until its checksum has been verified.
#
#   curl -fsSLO https://github.com/doopydoop364/PrivaNet-Core/releases/download/vVERSION/install-node.sh
#   curl -fsSLO https://github.com/doopydoop364/PrivaNet-Core/releases/download/vVERSION/SHA256SUMS.txt
#   sha256sum --check --ignore-missing SHA256SUMS.txt          # the installer itself is in the list
#   sh install-node.sh --coordinator https://node.example.com --invite-file ./invite
#
# Run it as an ordinary user: it downloads and verifies without privileges and uses sudo only for the install and service steps.
set -eu
umask 077

VERSION_STAMP='@PRIVANET_VERSION@'
DEFAULT_RELEASES='https://github.com/doopydoop364/PrivaNet-Core/releases/download'
REPO='doopydoop364/PrivaNet-Core'
SVC_USER='privanet-node'
NODE_MIN="${PRIVANET_NODE_MIN:-24.4.0}"

# Exit statuses: 0 done, 2 usage, 3 verification failed (nothing was installed), 4 unsupported platform or missing prerequisite, 5 download failed,
# 6 installation failed, 7 enrollment failed, 8 installed but the node could not be confirmed online.
die() { code=$1; shift; printf 'privanet-install: %s\n' "$*" >&2; exit "$code"; }
say() { printf '%s\n' "$*"; }
usage() {
  cat <<'USAGE'
Usage: install-node.sh --coordinator https://HOST[:PORT] [how to enroll] [options]
       install-node.sh --uninstall [--purge]

How to enroll (one of; none of them is ever placed on a command line or written to disk):
  --invite-file FILE     a short invite code from the Coordinator's owner (N7K4-PQ2M), read from FILE
  --invite-stdin         read the invite from standard input (not available when piping this script to sh)
  (or set PRIVANET_INVITE_CODE, or answer the hidden prompt if you give none of these and a terminal is available)
  --join                 ask to join and wait for the owner to approve (shows a request code; no secret involved)
  --token-file FILE | --token-stdin    the long one-time enrollment token instead (or PRIVANET_ENROLLMENT_TOKEN)
  --install-only         install the node without enrolling it (enroll later with `privanet-node enroll` or `join`)

Options:
  --version X.Y.Z[-pre]  the release to install (default: the release this installer belongs to)
  --ca-file FILE         trust this CA certificate for the Coordinator (a private/LAN deployment; a public one needs none)
  --sha256 HEX           also require the archive to have exactly this SHA-256 (from the owner, over another channel)
  --verify-attestation   also verify GitHub's build provenance for the archive (needs the `gh` command)
  --release-base-url URL download from this https location instead of GitHub (it must serve privanet-VERSION-linux.tar.gz and SHA256SUMS.txt)
  --capabilities a,b     enroll with fewer capabilities than the invite grants     --name NAME   a name hint shown to the owner with --join
  --slots N              concurrent jobs (default 1)
  --no-service           do not install or start a systemd service
  --upgrade | --reinstall | --repair   replace the program files of an existing installation (its identity and enrollment are kept)
  --new-identity --yes   give an existing installation a NEW identity (the old state is set aside, not deleted; ask the owner to revoke the old node)
  --uninstall [--purge]  stop and remove the service and program files (--purge also deletes the node's identity and state)
  --dry-run              download and verify, show what would be done, change nothing
  --help
USAGE
}

# ---- arguments ----------------------------------------------------------------------------------------------------------------------------------------------------
VERSION=''; COORDINATOR=''; INVITE_FILE=''; INVITE_STDIN=0; JOIN=0; TOKEN_FILE=''; TOKEN_STDIN=0; INSTALL_ONLY=0; CA_FILE=''; PIN_SHA=''; ATTEST=0; BASE_URL=''
CAPS=''; NAME_HINT=''; SLOTS='1'; NO_SERVICE=0; REINSTALL=0; NEW_IDENTITY=0; YES=0; UNINSTALL=0; PURGE=0; DRY=0; ROOT=''
while [ $# -gt 0 ]; do
  case $1 in
    --version) [ $# -ge 2 ] || die 2 '--version needs a value'; VERSION=$2; shift 2 ;;
    --coordinator) [ $# -ge 2 ] || die 2 '--coordinator needs a value'; COORDINATOR=$2; shift 2 ;;
    --invite-file) [ $# -ge 2 ] || die 2 '--invite-file needs a value'; INVITE_FILE=$2; shift 2 ;;
    --invite-stdin) INVITE_STDIN=1; shift ;;
    --join) JOIN=1; shift ;;
    --token-file) [ $# -ge 2 ] || die 2 '--token-file needs a value'; TOKEN_FILE=$2; shift 2 ;;
    --token-stdin) TOKEN_STDIN=1; shift ;;
    --install-only) INSTALL_ONLY=1; shift ;;
    --ca-file) [ $# -ge 2 ] || die 2 '--ca-file needs a value'; CA_FILE=$2; shift 2 ;;
    --sha256) [ $# -ge 2 ] || die 2 '--sha256 needs a value'; PIN_SHA=$2; shift 2 ;;
    --verify-attestation) ATTEST=1; shift ;;
    --release-base-url) [ $# -ge 2 ] || die 2 '--release-base-url needs a value'; BASE_URL=$2; shift 2 ;;
    --capabilities) [ $# -ge 2 ] || die 2 '--capabilities needs a value'; CAPS=$2; shift 2 ;;
    --name) [ $# -ge 2 ] || die 2 '--name needs a value'; NAME_HINT=$2; shift 2 ;;
    --slots) [ $# -ge 2 ] || die 2 '--slots needs a value'; SLOTS=$2; shift 2 ;;
    --no-service) NO_SERVICE=1; shift ;;
    --upgrade|--reinstall|--repair) REINSTALL=1; shift ;;
    --new-identity) NEW_IDENTITY=1; shift ;;
    --yes) YES=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    --purge) PURGE=1; shift ;;
    --dry-run) DRY=1; shift ;;
    --root) [ $# -ge 2 ] || die 2 '--root needs a value'; ROOT=$2; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    # Never echo an argument that was not understood: it might be a secret given the wrong way.
    *) die 2 'unknown option (see --help). Secrets are never given as arguments: use a file, the environment, standard input or the prompt.' ;;
  esac
done

# --root DIR installs under DIR as the current user, with no service and no account: for tests, packaging and a trial run. It never needs privileges.
STAGE=0; if [ -n "$ROOT" ]; then STAGE=1; NO_SERVICE=1; case $ROOT in /*) ;; *) die 2 '--root must be an absolute path' ;; esac; case $ROOT in *' '*) die 2 '--root must not contain spaces' ;; esac; fi
R=$ROOT; OPT_ROOT="$R/opt/privanet-node"; ETC="$R/etc/privanet"; STATE="$R/var/lib/privanet-node"; UNIT="$R/etc/systemd/system/privanet-node.service"
REAL_OPT=/opt/privanet-node; REAL_STATE=/var/lib/privanet-node

as_root() { if [ "$STAGE" = 1 ] || [ "$(id -u)" = 0 ]; then "$@"; else sudo "$@"; fi; }
run_as_svc() {
  if [ "$STAGE" = 1 ]; then "$@"
  elif [ "$(id -u)" = 0 ]; then runuser -u "$SVC_USER" -- "$@"
  else sudo -u "$SVC_USER" -- "$@"; fi
}
# For a command that is run in the background: the subshell becomes the command itself, so that killing it (on a signal) stops the command and not just a wrapper around it.
spawn_as_svc() {
  if [ "$STAGE" = 1 ]; then exec "$@"
  elif [ "$(id -u)" = 0 ]; then exec runuser -u "$SVC_USER" -- "$@"
  else exec sudo -u "$SVC_USER" -- "$@"; fi
}
have() { command -v "$1" >/dev/null 2>&1; }

# ---- platform ---------------------------------------------------------------------------------------------------------------------------------------------------
# PRIVANET_FAKE_OS / PRIVANET_FAKE_ARCH exist for the tests of this script and are honoured only with --root.
OS=$(uname -s); ARCH=$(uname -m)
if [ "$STAGE" = 1 ]; then OS=${PRIVANET_FAKE_OS:-$OS}; ARCH=${PRIVANET_FAKE_ARCH:-$ARCH}; fi
[ "$OS" = Linux ] || die 4 "this installer is for Linux (this is $OS). Windows has install-node.ps1; for macOS see docs/FIRST_DEPLOYMENT.md."
case $ARCH in x86_64|amd64) ARCH_NAME=x64 ;; aarch64|arm64) ARCH_NAME=arm64 ;; *) die 4 "unsupported CPU architecture $ARCH (supported: x86_64, aarch64)." ;; esac

# ---- uninstall (needs no download) --------------------------------------------------------------------------------------------------------------------------------
if [ "$UNINSTALL" = 1 ]; then
  say 'Removing the PrivaNet node service and program files...'
  if [ "$NO_SERVICE" = 0 ] && have systemctl; then as_root systemctl disable --now privanet-node >/dev/null 2>&1 || true; fi
  as_root rm -f "$UNIT"; [ "$NO_SERVICE" = 0 ] && have systemctl && as_root systemctl daemon-reload >/dev/null 2>&1 || true
  as_root rm -rf "$OPT_ROOT"; as_root rm -f "$ETC/node.env" "$ETC/node-policy.json"; as_root rmdir "$ETC" 2>/dev/null || true
  if [ "$PURGE" = 1 ]; then
    as_root rm -rf "$STATE"
    if [ "$STAGE" = 0 ] && have userdel && id "$SVC_USER" >/dev/null 2>&1; then as_root userdel "$SVC_USER" >/dev/null 2>&1 || true; fi
    say 'Purged: the node identity and state are deleted. Ask the owner of the Coordinator to revoke this node (privanet-admin nodes revoke NAME).'
  else
    say "Kept the node's identity and state in $REAL_STATE so a reinstall can continue as the same node. To delete them too: install-node.sh --uninstall --purge"
  fi
  say 'Done.'; exit 0
fi

# ---- validate -----------------------------------------------------------------------------------------------------------------------------------------------------
[ -n "$COORDINATOR" ] || die 2 '--coordinator is required (the https address the owner gave you)'
case $COORDINATOR in https://*) ;; *) die 2 'the Coordinator address must start with https://' ;; esac
case $COORDINATOR in *@*|*' '*|*'?'*|*'#'*) die 2 'the Coordinator address must be https://host[:port] with no credentials, query or fragment' ;; esac
case $SLOTS in ''|*[!0-9]*) die 2 '--slots must be a number' ;; esac
if [ -z "$VERSION" ]; then
  case $VERSION_STAMP in '@PRIVANET_VERSION@') die 2 'this copy of the installer is not pinned to a release: give --version X.Y.Z (the installer published with a release is pinned to it)' ;; esac
  VERSION=$VERSION_STAMP
fi
case $VERSION in v*) VERSION=${VERSION#v} ;; esac
printf '%s' "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.]+)?$' || die 2 "not a release version: $VERSION"
[ -z "$PIN_SHA" ] || printf '%s' "$PIN_SHA" | grep -Eq '^[0-9a-fA-F]{64}$' || die 2 '--sha256 must be 64 hexadecimal characters'
if [ -z "$BASE_URL" ]; then BASE_URL="$DEFAULT_RELEASES/v$VERSION"; fi
case $BASE_URL in https://*) ;; *) die 2 'the release location must be https' ;; esac
modes=0; [ -n "$INVITE_FILE" ] || [ "$INVITE_STDIN" = 1 ] && modes=$((modes + 1)); [ "$JOIN" = 1 ] && modes=$((modes + 1)); [ -n "$TOKEN_FILE" ] || [ "$TOKEN_STDIN" = 1 ] && modes=$((modes + 1))
[ "$modes" -le 1 ] || die 2 'choose one way to enroll: an invite, --join, or a token'
WANT_ENROLL=0; if [ "$modes" -gt 0 ] || [ -n "${PRIVANET_INVITE_CODE:-}" ] || [ -n "${PRIVANET_ENROLLMENT_TOKEN:-}" ]; then WANT_ENROLL=1; fi
[ -z "$INVITE_FILE" ] || [ -r "$INVITE_FILE" ] || die 2 'cannot read the invite file'
[ -z "$TOKEN_FILE" ] || [ -r "$TOKEN_FILE" ] || die 2 'cannot read the token file'
[ -z "$CA_FILE" ] || [ -r "$CA_FILE" ] || die 2 'cannot read the CA file'
[ -z "${PRIVANET_DOWNLOAD_CA:-}" ] || [ -r "${PRIVANET_DOWNLOAD_CA}" ] || die 2 'cannot read PRIVANET_DOWNLOAD_CA'
if [ "$NEW_IDENTITY" = 1 ] && [ "$YES" = 0 ]; then die 2 '--new-identity discards this machine'\''s identity (the old state is kept aside); add --yes to confirm'; fi

# ---- prerequisites ------------------------------------------------------------------------------------------------------------------------------------------------
for tool in curl tar awk grep mktemp install; do have "$tool" || die 4 "missing required command: $tool"; done
have sha256sum || have shasum || die 4 'missing required command: sha256sum (or shasum)'
NODE=${PRIVANET_NODE_BIN:-$(command -v node || true)}
[ -n "$NODE" ] && [ -x "$NODE" ] || die 4 "Node.js $NODE_MIN or newer is required and was not found. Install it (https://nodejs.org) and run this again."
NODE_V=$("$NODE" --version 2>/dev/null | sed 's/^v//') || NODE_V=''
printf '%s' "$NODE_V" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+' || die 4 'could not read the Node.js version'
version_ge() { awk -v a="$1" -v b="$2" 'BEGIN { split(a, x, /[.-]/); split(b, y, "."); for (i = 1; i <= 3; i++) { if (x[i] + 0 > y[i] + 0) exit 0; if (x[i] + 0 < y[i] + 0) exit 1 } exit 0 }'; }
version_ge "$NODE_V" "$NODE_MIN" || die 4 "Node.js $NODE_V is too old: PrivaNet needs $NODE_MIN or newer."
NODE_DIR=$(dirname "$NODE")
if [ "$NO_SERVICE" = 0 ] && [ ! -d /run/systemd/system ]; then die 4 'systemd is not running here, so the service cannot be installed. Use --no-service to install the files only.'; fi
if [ "$STAGE" = 0 ] && [ "$(id -u)" != 0 ] && ! have sudo; then die 4 'sudo is needed for the install and service steps (or run this as root)'; fi
if [ "$ATTEST" = 1 ] && ! have gh; then die 4 '--verify-attestation needs the GitHub CLI (gh)'; fi
if [ "$STAGE" = 0 ] && [ "$(id -u)" = 0 ] && ! have runuser; then die 4 'missing required command: runuser'; fi

# ---- existing installation -----------------------------------------------------------------------------------------------------------------------------------------
EXISTING=0; for path in "$ETC/node.env" "$UNIT" "$OPT_ROOT/current" "$STATE/identity.json"; do [ -e "$path" ] || [ -L "$path" ] && EXISTING=1; done
if [ "$EXISTING" = 1 ] && [ "$REINSTALL" = 0 ] && [ "$NEW_IDENTITY" = 0 ]; then
  die 6 "a PrivaNet node is already installed here. Choose one: --upgrade (replace the program files, keep this node's identity), --new-identity --yes (start over as a new node), or --uninstall."
fi
# An existing, unchanged node is left as it is. If the user gives a way to enroll, `enroll`/`join` run anyway: they are safe on a node that is already enrolled (it just says so and spends nothing),
# and it is what finishes an installation whose first enrollment attempt failed after the identity was made.
KEEP_IDENTITY=0; [ "$EXISTING" = 1 ] && [ -e "$STATE/identity.json" ] && [ "$NEW_IDENTITY" = 0 ] && [ "$WANT_ENROLL" = 0 ] && [ "$INSTALL_ONLY" = 0 ] && KEEP_IDENTITY=1

# ---- the secret, read now (before anything is changed) so a mistake costs nothing ----------------------------------------------------------------------------------
SECRET=''; SECRET_KIND=''
read_secret_prompt() {
  [ -r /dev/tty ] || die 2 'no way to receive the secret: give --invite-file, --invite-stdin or PRIVANET_INVITE_CODE (no terminal is available for a prompt)'
  printf '%s' "$1" >/dev/tty; trap 'stty echo </dev/tty 2>/dev/null || true' EXIT INT TERM
  stty -echo </dev/tty 2>/dev/null || true; IFS= read -r SECRET </dev/tty || true; stty echo </dev/tty 2>/dev/null || true; printf '\n' >/dev/tty; trap - EXIT INT TERM
}
if [ "$INSTALL_ONLY" = 0 ] && [ "$JOIN" = 0 ] && [ "$KEEP_IDENTITY" = 0 ] && [ "$DRY" = 0 ]; then
  if [ -n "$INVITE_FILE" ]; then SECRET=$(head -c 256 "$INVITE_FILE" | tr -d '[:space:]'); SECRET_KIND=invite
  elif [ "$INVITE_STDIN" = 1 ]; then IFS= read -r SECRET || true; SECRET_KIND=invite
  elif [ -n "$TOKEN_FILE" ]; then SECRET=$(head -c 256 "$TOKEN_FILE" | tr -d '[:space:]'); SECRET_KIND=token
  elif [ "$TOKEN_STDIN" = 1 ]; then IFS= read -r SECRET || true; SECRET_KIND=token
  elif [ -n "${PRIVANET_INVITE_CODE:-}" ]; then SECRET=$PRIVANET_INVITE_CODE; SECRET_KIND=invite
  elif [ -n "${PRIVANET_ENROLLMENT_TOKEN:-}" ]; then SECRET=$PRIVANET_ENROLLMENT_TOKEN; SECRET_KIND=token
  else read_secret_prompt 'Invite code: '; SECRET_KIND=invite; fi
  SECRET=$(printf '%s' "$SECRET" | tr -d '[:space:]')
  [ -n "$SECRET" ] || die 2 'the invite or token is empty'
  unset PRIVANET_INVITE_CODE PRIVANET_ENROLLMENT_TOKEN
  if [ "$SECRET_KIND" = invite ]; then printf '%s' "$SECRET" | grep -Eq '^[0-9A-Za-z -]{8,24}$' || die 2 'that does not look like an invite code (8 letters and digits, for example N7K4-PQ2M)'
  else printf '%s' "$SECRET" | grep -Eq '^[0-9a-f]{64}$' || die 2 'that does not look like an enrollment token (64 lowercase hexadecimal characters)'; fi
fi

# ---- download and verify, entirely without privileges ---------------------------------------------------------------------------------------------------------------
TMP=$(mktemp -d "${TMPDIR:-/tmp}/privanet-install.XXXXXX") || die 6 'could not create a temporary directory'
chmod 700 "$TMP"
CHILD=''
# shellcheck disable=SC2329  # run by the traps below
cleanup() { SECRET=''; [ -z "$CHILD" ] || kill "$CHILD" 2>/dev/null || true; rm -rf "$TMP"; }
trap cleanup EXIT; trap 'cleanup; exit 130' INT; trap 'cleanup; exit 143' TERM HUP
ARCHIVE="privanet-$VERSION-linux.tar.gz"; TOP="privanet-$VERSION-linux"
fetch() { # fetch URL DEST: https only, no downgrade through redirects, certificate verification always on
  if [ -n "${PRIVANET_DOWNLOAD_CA:-}" ]; then
    curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --tlsv1.2 --max-redirs 5 --connect-timeout 20 --max-time 900 --cacert "$PRIVANET_DOWNLOAD_CA" --output "$2" "$1"
  else
    curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --tlsv1.2 --max-redirs 5 --connect-timeout 20 --max-time 900 --output "$2" "$1"
  fi
}
sha256_of() { if have sha256sum; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
say "PrivaNet node $VERSION for Linux ($ARCH_NAME): downloading and verifying..."
fetch "$BASE_URL/SHA256SUMS.txt" "$TMP/SHA256SUMS.txt" || die 5 "could not download SHA256SUMS.txt from the release location"
fetch "$BASE_URL/$ARCHIVE" "$TMP/$ARCHIVE" || die 5 "could not download $ARCHIVE from the release location"
EXPECTED=$(awk -v f="$ARCHIVE" '($2 == f || $2 == "*" f) { print $1 }' "$TMP/SHA256SUMS.txt")
[ "$(printf '%s\n' "$EXPECTED" | grep -c .)" = 1 ] || die 3 "SHA256SUMS.txt does not list $ARCHIVE exactly once: refusing to install."
printf '%s' "$EXPECTED" | grep -Eq '^[0-9a-f]{64}$' || die 3 'SHA256SUMS.txt is malformed: refusing to install.'
ACTUAL=$(sha256_of "$TMP/$ARCHIVE")
[ "$ACTUAL" = "$EXPECTED" ] || die 3 "the downloaded archive does not match its published checksum: refusing to install. Nothing was changed."
if [ -n "$PIN_SHA" ]; then
  PIN_LOWER=$(printf '%s' "$PIN_SHA" | tr 'A-F' 'a-f'); [ "$ACTUAL" = "$PIN_LOWER" ] || die 3 'the archive does not match the --sha256 you gave: refusing to install. Nothing was changed.'
fi
if [ "$ATTEST" = 1 ]; then gh attestation verify "$TMP/$ARCHIVE" --repo "$REPO" >/dev/null 2>&1 || die 3 'GitHub could not verify the build provenance of this archive: refusing to install.'; fi
say "  verified: SHA-256 $ACTUAL$( [ -n "$PIN_SHA" ] && printf ' (matches your pin)')$( [ "$ATTEST" = 1 ] && printf ' (build provenance verified)')"
# Only now is anything from the archive looked at, and first only its list of names.
tar -tzf "$TMP/$ARCHIVE" >"$TMP/list" 2>/dev/null || die 3 'the archive is not a readable tar.gz: refusing to install.'
awk -v top="$TOP/" 'index($0, top) != 1 || /(^|\/)\.\.(\/|$)/ || /^\// { bad = 1 } END { exit bad }' "$TMP/list" || die 3 'the archive contains unexpected paths: refusing to install.'
mkdir "$TMP/x"; tar -xzf "$TMP/$ARCHIVE" -C "$TMP/x" --no-same-owner --no-same-permissions || die 6 'could not unpack the archive'
SRC="$TMP/x/$TOP"
for must in bin/privanet-node deploy/systemd/privanet-node.service deploy/policy/desktop-node.json node_modules/@privanet/node/dist/main.js; do [ -e "$SRC/$must" ] || die 3 "the archive is missing $must: refusing to install."; done

if [ "$DRY" = 1 ]; then
  say ''; say 'Dry run: nothing was installed. It would:'
  say "  - install the program files in $REAL_OPT/$VERSION (and point $REAL_OPT/current at them)"
  [ "$STAGE" = 1 ] || say "  - create the service account $SVC_USER and the state directory $REAL_STATE (mode 700)"
  say "  - write $ETC/node.env (mode 600, no secret) and the default desktop policy $ETC/node-policy.json"
  [ "$NO_SERVICE" = 1 ] || say '  - install, enable and start the privanet-node systemd service'
  if [ "$KEEP_IDENTITY" = 1 ]; then say '  - keep this machine'\''s existing identity and enrollment'; elif [ "$INSTALL_ONLY" = 1 ]; then say '  - not enroll (--install-only)'; elif [ "$JOIN" = 1 ]; then say "  - ask $COORDINATOR to let this machine join and wait for approval"; else say "  - enroll with $COORDINATOR using your $SECRET_KIND"; fi
  exit 0
fi

# ---- install (the only part that needs privileges) ------------------------------------------------------------------------------------------------------------------
say 'Installing...'
if [ "$STAGE" = 0 ]; then
  if ! id "$SVC_USER" >/dev/null 2>&1; then
    NOLOGIN=/usr/sbin/nologin; [ -x "$NOLOGIN" ] || NOLOGIN=/sbin/nologin; [ -x "$NOLOGIN" ] || NOLOGIN=/bin/false
    as_root useradd --system --user-group --home-dir "$REAL_STATE" --no-create-home --shell "$NOLOGIN" "$SVC_USER" || die 6 "could not create the service account $SVC_USER"
  fi
  SVC_OWNER="$SVC_USER:$SVC_USER"
else SVC_OWNER=''; fi
if [ "$NO_SERVICE" = 0 ] && [ -e "$UNIT" ]; then as_root systemctl stop privanet-node >/dev/null 2>&1 || true; fi
as_root install -d -m 755 "$OPT_ROOT" "$ETC" || die 6 "could not create $OPT_ROOT"
as_root rm -rf "$OPT_ROOT/$VERSION"; as_root cp -R "$SRC" "$OPT_ROOT/$VERSION" || die 6 'could not copy the program files'
as_root chmod -R go-w "$OPT_ROOT/$VERSION"; as_root chmod -R a+rX "$OPT_ROOT/$VERSION"
as_root ln -sfn "$VERSION" "$OPT_ROOT/current" || die 6 'could not select the new version'
as_root chmod 755 "$OPT_ROOT/$VERSION/bin/privanet-node"

# The state directory and its owner. A new identity sets the old state aside (never deletes it) so the owner can still see and revoke what it was.
if [ "$NEW_IDENTITY" = 1 ] && [ -e "$STATE" ]; then
  ASIDE="$STATE.old-$(date +%Y%m%d%H%M%S)"; as_root mv "$STATE" "$ASIDE" || die 6 'could not set the old state aside'
  say "  the old identity was moved to $ASIDE: ask the owner to revoke that node, then you may delete it"
fi
if [ -n "$SVC_OWNER" ]; then as_root install -d -m 700 -o "$SVC_USER" -g "$SVC_USER" "$STATE" || die 6 'could not create the state directory'
else as_root install -d -m 700 "$STATE" || die 6 'could not create the state directory'; fi

# Configuration: no secret, ever. An existing configuration is kept on --upgrade.
if [ "$KEEP_IDENTITY" = 0 ] || [ ! -e "$ETC/node.env" ]; then
  {
    printf '# Written by install-node.sh %s. Contains no secret. The node remembers its Coordinator in its state directory (enrollment.json) after it enrolls.\n' "$VERSION"
    printf 'PRIVANODE_COORDINATOR_URL=%s\n' "$COORDINATOR"
    printf 'PRIVANODE_STATE_DIR=%s\n' "$REAL_STATE"
    printf 'PRIVANODE_POLICY_FILE=/etc/privanet/node-policy.json\n'
    printf 'PRIVANODE_JOB_SLOTS=%s\n' "$SLOTS"
    if [ -n "$CA_FILE" ]; then printf 'NODE_EXTRA_CA_CERTS=/etc/privanet/privanet-root.crt\n'; fi
  } >"$TMP/node.env"
  as_root install -m 600 "$TMP/node.env" "$ETC/node.env"
fi
if [ -n "$CA_FILE" ]; then as_root install -m 644 "$CA_FILE" "$ETC/privanet-root.crt"; fi
[ -e "$ETC/node-policy.json" ] || as_root install -m 644 "$SRC/deploy/policy/desktop-node.json" "$ETC/node-policy.json"

# The service unit: the shipped one, pointed at this installation and at the Node.js that was found.
sed -e "s#^ExecStart=.*#ExecStart=$REAL_OPT/current/bin/privanet-node#" -e "s#^Environment=PATH=.*#Environment=PATH=$NODE_DIR:/usr/local/bin:/usr/bin:/bin#" "$SRC/deploy/systemd/privanet-node.service" >"$TMP/privanet-node.service"
as_root install -d -m 755 "$(dirname "$UNIT")"; as_root install -m 644 "$TMP/privanet-node.service" "$UNIT"

# ---- enroll, as the service account, with the secret on standard input ----------------------------------------------------------------------------------------------
NODE_CMD="$OPT_ROOT/current/bin/privanet-node"
ENVIRON="PRIVANODE_STATE_DIR=$STATE PATH=$NODE_DIR:/usr/local/bin:/usr/bin:/bin"
[ -z "$CA_FILE" ] || ENVIRON="$ENVIRON NODE_EXTRA_CA_CERTS=$ETC/privanet-root.crt"
CAP_ARGS=''; [ -z "$CAPS" ] || CAP_ARGS="--capabilities $CAPS"
if [ "$KEEP_IDENTITY" = 1 ]; then say '  keeping this machine'\''s identity and enrollment'
elif [ "$INSTALL_ONLY" = 1 ]; then say '  installed without enrolling (--install-only)'
elif [ "$JOIN" = 1 ]; then
  say ''; say "Asking $COORDINATOR to let this machine join. Give the owner the request code shown below; this waits for their approval."
  # Run in the background and wait, so that a signal reaches the traps (and the waiting node is stopped) instead of being deferred until the owner decides.
  # shellcheck disable=SC2086
  spawn_as_svc env $ENVIRON "$NODE_CMD" join --coordinator "$COORDINATOR" $CAP_ARGS ${NAME_HINT:+--name "$NAME_HINT"} </dev/null & CHILD=$!
  wait "$CHILD" || { CHILD=''; die 7 'joining failed (see the message above)'; }
  CHILD=''
else
  FLAG=--invite-stdin; [ "$SECRET_KIND" = token ] && FLAG=--token-stdin
  # shellcheck disable=SC2086
  printf '%s\n' "$SECRET" | run_as_svc env $ENVIRON "$NODE_CMD" enroll --coordinator "$COORDINATOR" $FLAG $CAP_ARGS || die 7 'enrollment failed (see the message above). The invite or token is not stored anywhere.'
fi
SECRET=''

# ---- start and confirm ---------------------------------------------------------------------------------------------------------------------------------------------
if [ "$NO_SERVICE" = 1 ]; then
  say ''; say "Installed in $OPT_ROOT. No service was installed (--no-service/--root). Start the node with: $NODE_CMD"
  exit 0
fi
as_root systemctl daemon-reload; as_root systemctl enable privanet-node >/dev/null 2>&1 || die 6 'could not enable the service'
if [ "$INSTALL_ONLY" = 1 ]; then say ''; say 'Installed. Enroll it, then start it: sudo systemctl enable --now privanet-node'; exit 0; fi
# shellcheck disable=SC2016  # the backticks are text for the user, not a command
as_root systemctl restart privanet-node || die 8 'the service did not start: see `journalctl -u privanet-node -n 50`'
say 'Waiting for the node to sign in...'; tries=0; ok=0
while [ "$tries" -lt 30 ]; do
  # shellcheck disable=SC2086
  if run_as_svc env $ENVIRON "$NODE_CMD" doctor --coordinator "$COORDINATOR" --json 2>/dev/null | grep -q '"id":"registered","label":"At the Coordinator","status":"OK"'; then
    if as_root systemctl is-active --quiet privanet-node; then ok=1; break; fi
  fi
  tries=$((tries + 1)); sleep 2
done
if [ "$ok" = 1 ]; then
  say ''; say 'Done. This node is installed, enrolled and signed in.'
  say '  status:     systemctl status privanet-node          logs: journalctl -u privanet-node -n 50'
  say "  diagnose:   sudo -u $SVC_USER env PRIVANODE_STATE_DIR=$REAL_STATE $REAL_OPT/current/bin/privanet-node doctor"
  say '  uninstall:  sh install-node.sh --uninstall [--purge]'
  exit 0
fi
say ''; say 'The node was installed but could not be confirmed signed in. Run the doctor to see which stage fails:'
say "  sudo -u $SVC_USER env PRIVANODE_STATE_DIR=$REAL_STATE ${CA_FILE:+NODE_EXTRA_CA_CERTS=/etc/privanet/privanet-root.crt }$REAL_OPT/current/bin/privanet-node doctor --coordinator $COORDINATOR"
say '  and see: journalctl -u privanet-node -n 50'
exit 8
