#!/usr/bin/env bash
# Apply the host-level config in this directory to the homeserver. Idempotent — safe to
# re-run any time something under system/ changes. Needs root:
#
#   sudo ~/homeserver/system/install.sh
#
# (The push-to-deploy workflow can't run this: it SSHes in as an unprivileged user.)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ "$(id -u)" -eq 0 ] || { echo "run with sudo" >&2; exit 1; }
export DEBIAN_FRONTEND=noninteractive

# copy src -> dst only if it differs, and say which
put() {
  if cmp -s "$1" "$2"; then echo "ok       $2"; else install -m 0644 "$1" "$2"; echo "updated  $2"; fi
}

echo "== packages"
apt-get install -y -qq unattended-upgrades needrestart >/dev/null
echo "ok       unattended-upgrades needrestart"

echo "== apt: automatic updates + nightly reboot"
put "$HERE/apt/20auto-upgrades"       /etc/apt/apt.conf.d/20auto-upgrades
put "$HERE/apt/50unattended-upgrades" /etc/apt/apt.conf.d/50unattended-upgrades
install -d /etc/needrestart/conf.d
put "$HERE/needrestart/50-autorestart.conf" /etc/needrestart/conf.d/50-autorestart.conf
systemctl enable -q --now apt-daily.timer apt-daily-upgrade.timer

echo "== docker: keep containers up while dockerd restarts for an upgrade (live-restore)"
if [ ! -e /etc/docker/daemon.json ]; then
  install -d /etc/docker
  put "$HERE/docker/daemon.json" /etc/docker/daemon.json
  systemctl reload docker 2>/dev/null && echo "reloaded docker" || true   # SIGHUP: no container restart
elif grep -q '"live-restore"' /etc/docker/daemon.json; then
  echo "ok       /etc/docker/daemon.json (live-restore already set)"
else
  echo "NOTE     /etc/docker/daemon.json exists without live-restore — merge system/docker/daemon.json by hand"
fi

echo "== check: what unattended-upgrades would do right now (dry run)"
unattended-upgrade --dry-run -v 2>&1 | grep -E 'Allowed origins|Packages that will be upgraded|No packages found' || true
[ -e /var/run/reboot-required ] && echo "reboot pending: will happen at $(apt-config dump | sed -n 's/.*Automatic-Reboot-Time "\(.*\)";/\1/p') UTC" || true
echo "== done"
