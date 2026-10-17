# 🐔 Chicken Breast Tracker

Polls a **Blinkit** product at *your* dark store and sends an **ntfy push** the moment it's
back in stock. Built because Blinkit's own "Notify me" doesn't fire. Default target is
[Haringhata Boneless Frozen Chicken Breast](https://blinkit.com/prn/haringhata-boneless-frozen-chicken-breast/prid/480046).

Part of the [trackers monorepo](../README.md): the `docker compose` commands below run from
`trackers/`, and the shared `.env` lives there too.

## How it works

Blinkit does **not** use your pincode and ignores the browser geolocation API. Its web app
sends your coordinates as `lat` / `lon` **headers** to its internal API, and the API picks
your serving **dark store** (a merchant id) from them. So each check is one request:

```
POST https://blinkit.com/v1/layout/product/<prid>
lat: <LAT>    lon: <LON>    app_client: consumer_web    body: {}
```

1. In the JSON, the snippet whose `data.product_id` is the prid carries `inventory` (a
   count), `is_sold_out` (bool), `meta.merchant_id` (the dark store) and
   `normal_price.text` (e.g. `₹160`).
2. **In stock** = `inventory > 0 && !is_sold_out`.
3. On the **out-of-stock → in-stock** transition, it pushes an ntfy alert, then re-pings
   every `notify.remindEveryMinutes` while it stays in stock. It stays quiet otherwise.
4. A check that fails (Cloudflare block, no merchant for your location, unexpected JSON,
   network) is retried once, then logged and exits 3 with stock state unchanged. It is never
   read as "out of stock".

### Why curl-impersonate

Blinkit sits behind Cloudflare, which since late September 2026 answers 403 to clients by
their TLS / HTTP2 fingerprint, not by IP. From the homeserver, Node's `fetch`, curl 8.5 and
Playwright's headless Chromium all got 403, while
[curl-impersonate](https://github.com/lexiforest/curl-impersonate) (curl built to send real
Chrome's TLS and HTTP/2 fingerprint) got 200 from the same IP. So `tracker.mjs` runs
`curl-impersonate --impersonate chrome150 ...` as a child process (no shell) and parses its
output. There is no browser any more: the image is `node:22-alpine` plus the one
curl-impersonate binary, ~280 MB instead of 3.6 GB.

The binary comes from `lexiforest/curl-impersonate:v2.2.3-alpine`, pinned by digest in the
`Dockerfile`. It is the musl build, which runs on `node:22-alpine` as is (it links only
musl, libstdc++ and libgcc, which Node needs too).

## Setup

Secrets (your **ntfy topic** and your **lat/lon**, which reveal your home) live in the
gitignored **`.env`** in `trackers/`, never in `config.json`.

### 1. Create your `.env` (`trackers/`, shared by all trackers)
```bash
cd ..                     # trackers/
cp .env.example .env
```
Then fill it in:
- `LAT` / `LON`: your coordinates. Google Maps: right-click your home → click the
  `lat, lon` at the top to copy.
- `NTFY_TOPIC`: a long, random, hard-to-guess string (it's your only password on free
  ntfy.sh; anyone who knows it can read your alerts).

### 2. Set up the ntfy app
- Install the **ntfy** app (Android/iOS) or use the web app.
- Subscribe to the **same** topic string you put in `NTFY_TOPIC`.

### 3. Verify it's hitting a store
```bash
docker compose run --rm chicken-tracker node tracker.mjs --once
```
You'll see a line like:
```
result: out of stock (inventory=0, is_sold_out=true) @ merchant 41262 price=₹160
```
A merchant id means Blinkit delivers to your coordinates. The API does not name the store.
The id can change on its own: on 2026-10-17 the same coordinates got merchant 41262 at
05:48 IST and 31166 at 05:52 IST. The tracker reads whichever store Blinkit serves at
that moment, which is the one the app would order from.

Then test the push:
```bash
docker compose run --rm chicken-tracker node tracker.mjs --test-notify   # should buzz your phone
```

## Running it 24/7 on your homeserver (Docker)

Deploys ride the monorepo's push-to-`main` workflow (see the [root README](../README.md));
the shared `.env` already lives in `trackers/` on the homeserver.

From `trackers/`:
```bash
docker compose up -d --build chicken-tracker    # run 24/7
docker compose logs -f chicken-tracker          # watch it
```

Each check is a fresh `node tracker.mjs --once` that exits when it's done; compose runs it
through [`../run-loop.sh`](../run-loop.sh), which sleeps until the time the check wrote to
`data/next-run` (every `watch.intervalMinutes`, default 12). Between checks the container
is just `sh` + `sleep`. `config.json` and `data/state.json` are mounted, so it remembers
stock state across restarts and restarts itself on reboot (`restart: unless-stopped`).

Day-to-day:
```bash
docker compose ps                               # what's running?
docker compose logs --tail=50 chicken-tracker   # recent checks
docker compose restart chicken-tracker          # apply config.json / .env changes
docker compose stop chicken-tracker             # stop just this tracker
```

> Running it without Docker needs curl-impersonate on your machine. Get a release binary
> from the curl-impersonate releases page, then
> `ENV_FILE=../.env CURL_IMPERSONATE=/path/to/curl-impersonate node tracker.mjs --once`.

## Is it working?

- **Daily heartbeat** (at `notify.heartbeatHour`): "still watching" with the last result
  while checks succeed. When the last successful check is over 3 hours old it says
  "checks FAILING" instead, with the time of the last good check and the last error.
- **Failure alert:** after `notify.failureAlertHours` (default 6) of nothing but failed
  checks, one push says so. It resets on the next good check.
- **healthchecks.io** (see the [root README](../README.md#watchdog-healthchecksio)): every
  check that exits 0 pings `chicken-tracker`'s check.

## Config reference (`config.json`)
Secrets live in **`.env`** (gitignored), everything else in `config.json`.

`.env`:
| key | meaning |
|-----|---------|
| `NTFY_TOPIC` | ntfy topic: **required**, secret (your only password on free ntfy.sh) |
| `LAT` / `LON` | **your** coordinates: **required**, private (picks the dark store) |
| `NTFY_SERVER` | optional, defaults to `https://ntfy.sh` |
| `CURL_IMPERSONATE` | optional path to the curl-impersonate binary (default: `curl-impersonate` on `PATH`) |

`config.json` (non-secret):
| key | meaning |
|-----|---------|
| `product.prid` | the number at the end of the Blinkit URL; change to track a different item |
| `notify.priority` | ntfy priority for the in-stock alert |
| `notify.remindEveryMinutes` | keep nagging while still in stock, at most every N min (0 = only on transition; <10 ≈ every check) |
| `notify.heartbeatHour` | hour (local) of the daily heartbeat, -1 disables |
| `notify.failureAlertHours` | push one warning after this many hours of failed checks |
| `watch.intervalMinutes` | minutes between checks |
| `api.impersonate` | the curl-impersonate browser target, e.g. `chrome150` |
| `api.timeoutSeconds` | bound on one API request |

The tracker auto-loads `.env` from its own directory (override with `ENV_FILE`); Docker
injects it via `env_file:`. Real environment variables always win over the file. It refuses
to start if `NTFY_TOPIC`, `LAT`, or `LON` are missing.

## Tracking a different / additional product
Change `product.prid` and `product.url` to the new item. To track several at once, copy this
directory to a new one and add a service block for it in `docker-compose.yml`
(see ["Adding a new tracker"](../README.md#adding-a-new-tracker)).

## Notes & gotchas
- **Cloudflare 403 again?** The log says `blocked by Cloudflare (HTTP 403)`. Cloudflare
  has learned the fingerprint. Bump the pinned image in the `Dockerfile` to a newer
  curl-impersonate release and set `api.impersonate` to the newest Chrome target it ships
  (`ls /usr/local/bin/curl_chrome*` inside that image lists them).
- **No merchant for this location** means the API returned the product with no dark store:
  `LAT` / `LON` are missing from the request or Blinkit doesn't deliver there. The API
  ignores the `gr_1_lat` / `gr_1_lon` cookies the website also sets; only the headers count.
- **Be polite.** A 12-minute interval is plenty. Don't hammer it every few seconds.
- The internal API shape can change; the parser fails *safe*: on any parse error it logs
  and leaves state unchanged rather than firing a false alert.
- Eat your protein. 💪
