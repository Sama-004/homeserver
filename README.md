# 📟 Trackers

A small fleet of "watch a thing on the internet and ping my phone via [ntfy](https://ntfy.sh)"
trackers, deployed together on the homeserver. Each tracker lives in its own directory and is
fully self-contained (its own script, config, Dockerfile, README); the root
`docker-compose.yml` is the only thing that knows about all of them.

| Tracker | Watches | Docs |
|---|---|---|
| [`chicken-breast/`](chicken-breast/) 🐔 | Blinkit stock for frozen chicken breast at my dark store | [README](chicken-breast/README.md) |
| [`nimas/`](nimas/) 🏔️ | Seat availability for the NIMAS Basic Mountaineering Course (BMC-64) | [README](nimas/README.md) |

## Layout

```
.
├── docker-compose.yml   # one service per tracker — the orchestrator
├── .env                 # shared secrets (gitignored): NTFY_TOPIC, LAT, LON
├── chicken-breast/      # each tracker: tracker.mjs + config.json + Dockerfile + README
│   └── data/            # per-tracker state (gitignored, survives restarts)
└── nimas/
    └── data/
```

All trackers push to the same `NTFY_TOPIC`, so one phone subscription gets everything —
titles/emoji tell them apart. Want separate topics? Give a service its own
`environment: NTFY_TOPIC=...` override in `docker-compose.yml`.

## Running (from the repo root)

```bash
cp .env.example .env                   # then fill it in (see each tracker's README)
docker compose up -d --build           # run ALL trackers
docker compose up -d --build nimas-notifier   # ...or just one service
docker compose logs -f                 # watch everything (add a service name to filter)
docker compose ps
docker compose restart chicken-tracker # apply config/.env changes to one tracker
docker compose down                    # stop everything
```

One-off checks / test pushes (see each tracker's README for its flags):

```bash
docker compose run --rm nimas-notifier node tracker.mjs --test-notify
docker compose run --rm chicken-tracker node tracker.mjs --once
```

Local dev without Docker: `cd` into the tracker's directory and run it there. Note each
tracker auto-loads `.env` from *its own* directory, not the repo root — so point it at the
shared one with `ENV_FILE=../.env node tracker.mjs --once` (or symlink:
`ln -s ../.env chicken-breast/.env`).

## Deploys

Push to `main` → GitHub Actions joins the tailnet and redeploys **all** trackers on the
homeserver in place (`.github/workflows/deploy.yml`). State in each `*/data/` and the root
`.env` are untracked and survive deploys.

## Adding a new tracker

1. Copy the shape of an existing one into a new directory: `tracker.mjs` (CLI:
   `--once` / `--watch` / `--test-notify`), `config.json` for non-secrets, state via
   `STATE_PATH`, secrets from the environment. `nimas/` is the minimal zero-dependency
   template (plain `fetch`); `chicken-breast/` is the "site needs a real browser" variant
   (Playwright).
2. Keep the conventions: fail **safe** on scrape/parse errors (log and leave state
   unchanged, never a false alert), a daily heartbeat push so silence means something is
   broken, and a wedge-watchdog that exits so Docker's restart policy self-heals.
3. Add a service block for it in `docker-compose.yml` (build context = its directory,
   mount its `config.json` read-only and its `data/` for state).
4. Push to `main` — the deploy workflow picks it up.
