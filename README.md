# 🐔 Chicken Breast Tracker

Polls a **Blinkit** product at *your* dark store and sends an **ntfy push** the moment it's
back in stock. Built because Blinkit's own "Notify me" doesn't fire. Default target is
[Haringhata Boneless Frozen Chicken Breast](https://blinkit.com/prn/haringhata-boneless-frozen-chicken-breast/prid/480046).

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
   `notify.remindEveryHours`.

## Setup

Secrets — your **ntfy topic** and your **lat/lon** (which reveal your home) — live in a
gitignored **`.env`** file, never in `config.json`.

### 1. Create your `.env`
```bash
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
```bash
npm install          # installs Playwright + its Chromium
node tracker.mjs --once
```
You'll see a line like:
```
result: out of stock (inventory=0) @ Super Store Kolkata New Bara Bazar ES79
```
Confirm the store name matches your area. If it's the wrong store, nudge your lat/lon.

Then test the push:
```bash
node tracker.mjs --test-notify   # should buzz your phone
```

## Running it 24/7 on your homeserver

### Option A — Docker (recommended)
```bash
docker compose up -d --build
docker compose logs -f
```
Runs in `--watch` mode, checking every `watch.intervalMinutes` (default 12). `config.json`
and `state.json` are mounted, so it remembers stock state across restarts.

### Option B — systemd timer (native)
```bash
npm install
sudo cp systemd/chicken-tracker.* /etc/systemd/system/
# edit User / WorkingDirectory / paths in the .service first
sudo systemctl daemon-reload
sudo systemctl enable --now chicken-tracker.timer
journalctl -u chicken-tracker.service -f
```

### Option C — cron
```cron
*/12 * * * * cd /home/sama/projects/chicken-breast-tracker && /usr/bin/node tracker.mjs --once >> tracker.log 2>&1
```

### Option D — just leave it watching in a terminal/tmux
```bash
npm install
node tracker.mjs --watch
```

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
| `notify.remindEveryHours` | re-ping while still in stock (0 = only on transition) |
| `watch.intervalMinutes` | check frequency in `--watch` mode |
| `browser.chromiumPath` | leave empty to use Playwright's Chromium; set to e.g. `/usr/bin/chromium` if bundled is missing |

The tracker auto-loads `.env` from the project dir (override with `ENV_FILE`). systemd reads
it via `EnvironmentFile=`; Docker via `env_file:`. Real environment variables always win over
the file. It refuses to start if `NTFY_TOPIC`, `LAT`, or `LON` are missing.

## Tracking a different / additional product
Change `product.prid` and `product.url` to the new item. To track several at once, copy the
folder (or run multiple Docker services) each with its own `config.json` + `state.json` and a
different ntfy topic.

## Notes & gotchas
- **Be polite.** A 12-minute interval is plenty and stays well under the radar. Don't hammer
  it every few seconds.
- If checks start failing with Cloudflare blocks, bump the interval and make sure your
  homeserver IP isn't on a VPN/datacenter range.
- The internal API shape can change; the parser fails *safe* — on any parse error it logs and
  leaves state unchanged rather than firing a false alert.
- Eat your protein. 💪
