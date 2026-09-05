# 🏠 homeserver

Everything that runs on the homeserver (`hp` on the tailnet, Ubuntu 24.04 LTS), in one repo.
Each top-level directory is one independent thing; the only shared pieces are this README,
`.gitignore`, and the deploy workflow.

| Directory | What | How it gets onto the box |
|---|---|---|
| [`trackers/`](trackers/) 📟 | "watch a thing on the internet, ping my phone via ntfy" bots, one Docker container each | push to `main` → [`deploy.yml`](.github/workflows/deploy.yml) redeploys |
| [`system/`](system/) 🖥️ | host-level config: automatic OS updates + nightly reboot, needrestart, Docker daemon | by hand, needs root: `ssh -t hp 'sudo ~/homeserver/system/install.sh'` |

## Layout

```
.
├── .github/workflows/deploy.yml   # push to main -> ssh over Tailscale -> docker compose up
├── trackers/                      # one compose project; each tracker self-contained in a subdir
│   ├── docker-compose.yml
│   ├── .env                       # gitignored secrets (NTFY_TOPIC, LAT, LON)
│   ├── chicken-breast/
│   └── nimas/
└── system/                        # files copied into /etc by system/install.sh
    ├── install.sh
    ├── apt/
    ├── needrestart/
    └── docker/
```

The checkout on the homeserver is `~/homeserver`. Runtime state (`trackers/.env`,
`trackers/*/data/`) is untracked and survives deploys.

## Two kinds of change

- **App-level** (anything under `trackers/`, or a future `<stack>/` with its own compose
  file): commit, push, done. The workflow SSHes in as an unprivileged user and runs
  `docker compose up -d --build` per stack — add a `cd`/`up` block for any new stack.
- **Host-level** (anything under `system/`): commit, push, then run `install.sh` with sudo.
  It's idempotent, so re-running it is always safe.

## Adding a new stack

1. `mkdir <name>/` with a `docker-compose.yml` and a README. Keep secrets in a gitignored
   `<name>/.env` (add `<name>/.env.example`), state in gitignored `data/` dirs.
2. Add a block to [`deploy.yml`](.github/workflows/deploy.yml) that `cd`s in and runs
   `docker compose up -d --build`.
3. Push.
