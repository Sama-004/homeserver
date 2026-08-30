# 🐔 Chicken Breast Tracker

Polls a **Blinkit** product at *your* dark store and sends an **ntfy push** the moment it's
back in stock. Built because Blinkit's own "Notify me" doesn't fire. Default target is
[Haringhata Boneless Frozen Chicken Breast](https://blinkit.com/prn/haringhata-boneless-frozen-chicken-breast/prid/480046).

Part of the [trackers monorepo](../README.md): the `docker compose` commands below run from
the **repo root**, and the shared `.env` lives there too.

## How it works (the important part: location)

Blinkit does **not** use your pincode directly and **ignores** the browser geolocation API.
It picks your serving **dark store** from a **lat/lon pair stored in the cookies
`gr_1_lat` / `gr_1_lon`**, which it forwards as `lat`/`lon` headers to its internal API.

So the tracker:

1. Sets `gr_1_lat` / `gr_1_lon` cookies to **your** coordinates.
2. Loads the product page in headless Chromium (a real browser — this clears Cloudflare,
   which plain `curl` cannot).
3. Reads the JSON the page itself fetches from `/v1/layout/product/<prid>`. The product
   snippet carries `inventory` (a count) and `is_sold_out` (bool).
4. **In stock** = `inventory > 0 && !is_sold_out`.
5. On the **out-of-stock → in-stock** transition, it pushes an ntfy alert. It stays quiet
   otherwise (no spam), and won't re-alert while it's still in stock unless you set
   `notify.remindEveryMinutes`.

## Setup

Secrets — your **ntfy topic** and your **lat/lon** (which reveal your home) — live in a
gitignored **`.env`** file, never in `config.json`.

### 1. Create your `.env` (repo root, shared by all trackers)
```bash
cd ..                     # repo root
cp .env.example .env
```
Then fill it in:
- `LAT` / `LON` — your coordinates. Google Maps: right-click your home → click the
  `lat, lon` at the top to copy.
- `NTFY_TOPIC` — a long, random, hard-to-guess string (it's your only password on free
  ntfy.sh — anyone who knows it can read your alerts).

### 2. Set up the ntfy app
- Install the **ntfy** app (Android/iOS) or use the web app.
- Subscribe to the **same** topic string you put in `NTFY_TOPIC`.

### 3. Verify it's hitting the right store
From this directory (the tracker looks for `.env` next to itself, so point it at the shared
root one):
```bash
npm install          # installs Playwright + its Chromium
ENV_FILE=../.env node tracker.mjs --once
```
You'll see a line like:
```
result: out of stock (inventory=0) @ Super Store Kolkata New Bara Bazar ES79
```
Confirm the store name matches your area. If it's the wrong store, nudge your lat/lon.

Then test the push:
```bash
ENV_FILE=../.env node tracker.mjs --test-notify   # should buzz your phone
```

## Running it 24/7 on your homeserver (Docker)

Deploys ride the monorepo's push-to-`main` workflow (see the [root README](../README.md)) —
the shared `.env` already lives at the homeserver repo root. Needs ~2.5 GB free disk for the
Playwright image.

From the repo root:
```bash
docker compose run --rm chicken-tracker node tracker.mjs --test-notify   # confirm push works
docker compose up -d --build chicken-tracker                             # run 24/7
docker compose logs -f chicken-tracker                                   # watch it
```

Runs in `--watch` mode, checking every `watch.intervalMinutes` (default 12). `config.json`,
`state.json`, and `.env` are wired in, so it remembers stock state across restarts and
restarts itself on reboot (`restart: unless-stopped`).

Day-to-day:
```bash
docker compose ps                               # what's running?
docker compose logs --tail=50 chicken-tracker   # recent checks
docker compose restart chicken-tracker          # apply config.json / .env changes
docker compose stop chicken-tracker             # stop just this tracker
```

> Running locally for development (no Docker)? `npm install` then
> `ENV_FILE=../.env CHROMIUM_PATH=/usr/bin/chromium node tracker.mjs --once`.

## Config reference (`config.json`)
Secrets live in **`.env`** (gitignored), everything else in `config.json`.

`.env`:
| key | meaning |
|-----|---------|
| `NTFY_TOPIC` | ntfy topic — **required**, secret (your only password on free ntfy.sh) |
| `LAT` / `LON` | **your** coordinates — **required**, private (picks the dark store) |
| `NTFY_SERVER` | optional, defaults to `https://ntfy.sh` |
| `CHROMIUM_PATH` | optional, e.g. `/usr/bin/chromium` (also settable in config) |

`config.json` (non-secret):
| key | meaning |
|-----|---------|
| `product.prid` | the number at the end of the Blinkit URL — change to track a different item |
| `location.locality` | non-sensitive hint only (lat/lon come from `.env`) |
| `notify.priority` | ntfy priority for the in-stock alert |
| `notify.remindEveryMinutes` | keep nagging while still in stock, at most every N min (0 = only on transition; <10 ≈ every check) |
| `watch.intervalMinutes` | check frequency in `--watch` mode |
| `browser.chromiumPath` | leave empty to use Playwright's Chromium; set to e.g. `/usr/bin/chromium` if bundled is missing |

The tracker auto-loads `.env` from the project dir (override with `ENV_FILE`); Docker also
injects it via `env_file:`. Real environment variables always win over the file. It refuses
to start if `NTFY_TOPIC`, `LAT`, or `LON` are missing.

## Tracking a different / additional product
Change `product.prid` and `product.url` to the new item. To track several at once, copy this
directory to a new one and add a service block for it in the root `docker-compose.yml`
(see ["Adding a new tracker"](../README.md#adding-a-new-tracker)).

## Notes & gotchas
- **Be polite.** A 12-minute interval is plenty and stays well under the radar. Don't hammer
  it every few seconds.
- If checks start failing with Cloudflare blocks, bump the interval and make sure your
  homeserver IP isn't on a VPN/datacenter range.
- The internal API shape can change; the parser fails *safe* — on any parse error it logs and
  leaves state unchanged rather than firing a false alert.
- Eat your protein. 💪
