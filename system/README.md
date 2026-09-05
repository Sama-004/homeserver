# 🖥️ system — host-level config for the homeserver

Everything here is applied *to the OS itself* (not to a container). It's the only part of
the repo that needs root, so it isn't pushed by the deploy workflow — run it by hand after
changing anything in this directory:

```bash
ssh -t hp 'sudo ~/homeserver/system/install.sh'
```

It's idempotent and prints `ok` / `updated` per file, then a dry run of what
unattended-upgrades would do.

## What it sets up

| Piece | Where it lands | Why |
|---|---|---|
| [`apt/20auto-upgrades`](apt/20auto-upgrades) | `/etc/apt/apt.conf.d/` | turns on the daily apt timers |
| [`apt/50unattended-upgrades`](apt/50unattended-upgrades) | `/etc/apt/apt.conf.d/` | **what** gets auto-installed: security + `-updates` + Docker + Tailscale; prune old kernels; **reboot at 22:30 UTC (04:00 IST)** if a reboot is pending |
| [`needrestart/50-autorestart.conf`](needrestart/50-autorestart.conf) | `/etc/needrestart/conf.d/` | restart services after library upgrades without prompting |
| [`docker/daemon.json`](docker/daemon.json) | `/etc/docker/daemon.json` (only if absent) | `live-restore`: containers keep running while `dockerd` restarts for a docker-ce upgrade |

Ubuntu ships unattended-upgrades enabled but **security-only**, so ordinary updates and
third-party repos silently pile up and kernel updates never take effect. This config closes
that gap. The trackers ride out the nightly reboot via `restart: unless-stopped`.

## Checking on it

```bash
ssh hp 'tail -n 30 /var/log/unattended-upgrades/unattended-upgrades.log'   # what ran, what got kept back
ssh hp 'apt list --upgradable 2>/dev/null | wc -l'                          # should hover near 0
ssh hp 'ls /var/run/reboot-required 2>/dev/null; uptime'                    # pending reboot? last reboot?
ssh hp 'systemctl list-timers apt-daily*'                                   # timers alive?
```

## Adding more host config

Drop the file under `system/<thing>/`, add a `put` line in [`install.sh`](install.sh), rerun
it. Keep it declarative and idempotent: copy files, enable units, never `apt upgrade` or
`rm` anything here.
