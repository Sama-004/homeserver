# 📟 Trackers

A small fleet of "watch a thing on the internet and ping my phone via [ntfy](https://ntfy.sh)"
trackers, deployed together on the homeserver as one compose project (`trackers/` in the [homeserver repo](../)). Each tracker lives in its own directory and is
fully self-contained (its own script, config, Dockerfile, README); the root
`docker-compose.yml` is the only thing that knows about all of them.

| Tracker | Watches | Docs |
|---|---|---|
| [`chicken-breast/`](chicken-breast/) 🐔 | Blinkit stock for frozen chicken breast at my dark store | [README](chicken-breast/README.md) |
| [`nimas/`](nimas/) 🏔️ | Seat availability for the NIMAS Basic Mountaineering Course (BMC-64) | [README](nimas/README.md) |
| [`iism/`](iism/) 🎿 | IISM Gulmarg site for the snow-skiing course schedule + booking date (with exact-time booking reminders) | [README](iism/README.md) |
| [`amul/`](amul/) 🥛 | Amul whey protein + protein lassi/buttermilk stock at pincode 700032 | [README](amul/README.md) |
| [`amazon/`](amazon/) 📚 | Amazon.in stock for the Kobo Clara BW eReader (a product list, via Kobo's brand store page). **Paused** (`profiles: [paused]` in compose) | [README](amazon/README.md) |
| [`uniqlo/`](uniqlo/) 👕 | Uniqlo India men's section: sales and price drops in stock in S/M/L (urgent), new products in stock in S/M/L, every price kept in SQLite | [README](uniqlo/README.md) |

## Layout

```
trackers/
├── docker-compose.yml   # one service per tracker — the orchestrator
├── run-loop.sh          # every container's long-lived process: run a check, sleep, repeat
├── healthchecks-setup.sh  # one-time: create the healthchecks.io check for each service
├── .env                 # shared secrets (gitignored): NTFY_TOPIC, LAT, LON, HC_PING_KEY
├── chicken-breast/      # each tracker: tracker.mjs + config.json + Dockerfile + README
│   └── data/            # per-tracker state + next-run (gitignored, survive restarts)
├── nimas/
│   └── data/
├── iism/
│   └── data/
├── amul/
│   └── data/
├── amazon/
│   └── data/
└── uniqlo/
    └── data/            # also uniqlo.db, the SQLite price history
```

Node only runs during a check. Each container's process is `sh run-loop.sh`, which runs
`node tracker.mjs --once`, reads the unix time the check wrote to `data/next-run`, and sleeps
until then. An idle tracker is `sh` + `sleep`, well under 1 MiB, instead of a 20-40 MiB Node
process. A check that runs past `CYCLE_TIMEOUT` seconds (default 300) is killed; a check that
exits without writing `next-run` is retried after `FALLBACK_SLEEP` seconds (default 300).

All trackers push to the same `NTFY_TOPIC`, so one phone subscription gets everything —
titles/emoji tell them apart. Want separate topics? Give a service its own
`environment: NTFY_TOPIC=...` override in `docker-compose.yml`.

## Running (from this directory)

```bash
cp .env.example .env                   # then fill it in (see each tracker's README)
docker compose up -d --build           # run ALL trackers
docker compose up -d --build nimas-notifier   # ...or just one service
docker compose logs -f                 # watch everything (add a service name to filter)
docker compose ps
docker compose restart chicken-tracker # apply config/.env changes to one tracker
docker compose down                    # stop everything
```

One-off checks / test pushes (see each tracker's README for its flags). Name the command:
without one, `run` starts the loop.

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
homeserver in place (`../.github/workflows/deploy.yml`). State in each `*/data/` and the root
`.env` are untracked and survive deploys.

Deploys recreate every tracker container (`--force-recreate`). A running container keeps
seeing the old copy of a mounted single file (`run-loop.sh`, each `config.json`) after
`git reset` replaces it, so recreating is what makes those changes apply. Each tracker runs
one check right after a deploy, then goes back to its schedule.

## Watchdog (healthchecks.io)

A tracker's own pushes can't tell you it's dead: a box that lost power sends nothing, and
chicken-breast's daily heartbeat kept arriving while every check failed. So every container
also pings a [healthchecks.io](https://healthchecks.io) check after each **successful**
check, and healthchecks.io alerts you (email, ntfy, whatever the project has set up) when the pings
stop for longer than the tracker's interval plus a 2 h grace. One failed check is normal and
alerts nobody; a tracker that keeps failing, or a box that is off, does.

`run-loop.sh` sends the ping when `node tracker.mjs --once` exits 0, to
`https://hc-ping.com/$HC_PING_KEY/$HC_SLUG`. `HC_SLUG` is the compose service name, set per
service in `docker-compose.yml`. Without `HC_PING_KEY` in `.env` nothing is pinged. A ping
that fails is logged and never delays the next check.

To turn it on:

1. In the healthchecks.io project's **Settings**, create a ping key and a read-write API key,
   and connect the integrations you want alerts on (all of them get every tracker's alerts).
2. On the server, add both to `trackers/.env`: `HC_PING_KEY=...` and `HC_API_KEY=...`.
3. Run `./healthchecks-setup.sh` there once. It creates or updates one check per service
   (timeout = the tracker's `watch.intervalMinutes`, grace 2 h) and prints a table. It also
   pings each new check once: a never-pinged check stays "new" and never alerts, so without
   that a tracker that is already failing would never be reported. It is safe to re-run,
   for example after changing an interval or adding a tracker.
4. `docker compose up -d --force-recreate` so the containers pick up `HC_PING_KEY`.
   Remove `HC_API_KEY` from `.env` afterwards if you like; only the setup script uses it.

## Adding a new tracker

1. Copy the shape of an existing one into a new directory: `tracker.mjs`, `config.json`
   for non-secrets, state via `STATE_PATH`, secrets from the environment. The contract with
   `run-loop.sh`: `node tracker.mjs --once` (also the default with no flag) does one check,
   writes the unix time in seconds of the next check to `next-run` next to the state file,
   and exits. Write it in a `finally` so a failed check still schedules the next one
   (`scheduleNext` in each tracker). `--test-notify` sends a test push and doesn't touch it.
   Exit 0 only when the check worked and every alert it had to push went out. A check that
   fails without crashing (retries exhausted, an alert push that didn't go out) sets
   `process.exitCode = CHECK_FAILED` (3) and still writes `next-run`; a crash exits 1. Only
   exit 0 pings the watchdog, so a tracker that exits 0 on failure is never reported.
   `nimas/` is the minimal zero-dependency template (plain `fetch`); `chicken-breast/` is
   the "site is behind Cloudflare bot checks" variant: Cloudflare 403s Node's `fetch` by its
   TLS fingerprint, so it calls the API through curl-impersonate (Chrome's fingerprint).
2. Keep the conventions: fail **safe** on scrape/parse errors (log and leave state
   unchanged, never a false alert) and a daily heartbeat push so silence means something is
   broken. A wedged check needs no watchdog of its own: `run-loop.sh` kills it after
   `CYCLE_TIMEOUT`.
3. Add a service block for it in `docker-compose.yml`: `<<: *tracker`, build context = its
   directory, and `volumes:` with the `run-loop.sh` mount, its `config.json` read-only, and
   its `data/` for state, and an `environment:` that starts with `<<: *tracker-env` and sets
   `HC_SLUG` to the service name. If a check can take longer than 5 minutes, set
   `CYCLE_TIMEOUT` there too.
4. Push to `main` — the deploy workflow picks it up (it runs `docker compose up` in this directory).
5. Once deployed, re-run `./healthchecks-setup.sh` on the server to create its watchdog check.
