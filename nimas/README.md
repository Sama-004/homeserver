# 🏔️ NIMAS Seat Notifier

Watches the **BMC-64** row of the
[NIMAS Mountaineering courses page](https://www.nimasdirang.com/Mountaineering-courses)
and sends an **ntfy push** when seats move. Built because the page has no "notify me" and
a Basic Mountaineering Course fills quietly over weeks.

Default target: **BMC-64** — 20-Mar-2027 → 16-Apr-2027, ₹29,800, capacity 80, age 17–40, Mixed.

Part of the [trackers monorepo](../README.md): the `docker compose` commands below run from
the **repo root**, and the shared `.env` lives there too.

## How it works (the important part: there's no HTML to scrape)

The courses page is a **React SPA** — the course table isn't in the HTML at all. The browser
fetches it from the site's own backend:

```
POST https://apierp.azurewebsites.net/api/api/getTemplateDataList
     Authorization-Token: <the site's public token, shipped in its JS bundle>
     templateID: 3, filters: {"Category Name": "Mountaineering"}
```

So the tracker just **calls that JSON API directly with native `fetch`** — no browser, no
Playwright, no Cloudflare dance. It then:

1. Finds the record whose `"Serial No"` equals `course.serialNo` (`BMC-64` by default).
2. Reads `"Available Seats"` off it.
3. Compares against the last seen count in `state.json` and decides what to push.

**Fail-safe:** on any API or parse error it retries once (2 attempts per cycle), then logs
and leaves state **unchanged** rather than firing a false alert.

## What it pushes

| when | what |
|------|------|
| **Daily summary** | once per day at/after `notify.dailyHour` (default 9, local time) — seats / capacity / fee / dates. This is also the **heartbeat**: if it stops arriving, the notifier is dead. |
| **Urgent mode** | while `0 < seats < notify.urgentThreshold` (default 20), a **high-priority** push at most every `notify.urgentRemindMinutes` (default 55 min — i.e. effectively every hourly check). |
| **Seat change** | any time the count changes; high priority when it **drops**. |
| **Course full** | a one-time push when seats hit **0**. |

## Setup

The only secret — your **ntfy topic** — lives in a gitignored **`.env`**, never in
`config.json`.

### 1. Create your `.env` (repo root, shared by all trackers)
```bash
cd ..                     # repo root
cp .env.example .env
```
Then fill in:
- `NTFY_TOPIC` — a long, random, hard-to-guess string (it's your only password on free
  ntfy.sh — anyone who knows it can read your alerts).

### 2. Set up the ntfy app
- Install the **ntfy** app (Android/iOS) or use the web app.
- Subscribe to the **same** topic string you put in `NTFY_TOPIC`.

### 3. Verify
No `npm install` — **zero dependencies**, just **Node >= 20** (for native `fetch`).

From this directory (the tracker looks for `.env` next to itself, so point it at the shared
root one):
```bash
ENV_FILE=../.env node tracker.mjs --once
```
You'll see a line like:
```
BMC-64: 35/80 seats
```

Then test the push:
```bash
ENV_FILE=../.env node tracker.mjs --test-notify   # should buzz your phone
```

## Running it 24/7 on your homeserver (Docker)

Deploys ride the monorepo's push-to-`main` workflow (see the [root README](../README.md)) —
the shared `.env` already lives at the homeserver repo root. The image is **tiny** —
`node:22-alpine` with no dependencies, a few tens of MB, versus the ~2.5 GB Playwright image
the Blinkit sibling needs.

From the repo root:
```bash
docker compose run --rm nimas-notifier node tracker.mjs --test-notify   # confirm push works
docker compose up -d --build nimas-notifier                             # run 24/7
docker compose logs -f nimas-notifier                                   # watch it
```

Runs in `--watch` mode, checking every `watch.intervalMinutes` (default 60). `config.json`,
`state.json`, and `.env` are wired in, so it remembers the seat count across restarts and
restarts itself on reboot (`restart: unless-stopped`).

Day-to-day:
```bash
docker compose ps                              # what's running?
docker compose logs --tail=50 nimas-notifier   # recent checks
docker compose restart nimas-notifier          # apply config.json / .env changes
docker compose stop nimas-notifier             # stop just this tracker
```

## Config reference (`config.json`)
Secrets live in **`.env`** (gitignored), everything else in `config.json`.

`.env`:
| key | meaning |
|-----|---------|
| `NTFY_TOPIC` | ntfy topic — **required**, secret (your only password on free ntfy.sh) |
| `NTFY_SERVER` | optional, defaults to `https://ntfy.sh` |

`config.json` (non-secret):
| key | meaning |
|-----|---------|
| `course.serialNo` | the course code to track (`BMC-64`) — change it to watch a different slot, e.g. `BMC-65` |
| `api.url` | the ERP endpoint the site's own frontend calls |
| `api.authToken` | the site's **public** bundle constant, not a user secret — only needs changing if NIMAS rotates it |
| `api.templateID` | `3` — the courses template |
| `api.categoryName` | `"Mountaineering"` — the filter sent with the request |
| `api.timeoutMs` | per-request timeout |
| `notify.dailyHour` | hour (local) for the daily summary / heartbeat |
| `notify.urgentThreshold` | seats below which every check pushes a high-priority nag |
| `notify.urgentRemindMinutes` | rate limit for those urgent pushes (default 55) |
| `notify.priority` | ntfy priority for normal pushes |
| `watch.intervalMinutes` | check frequency in `--watch` mode (default 60) |
| `watch.jitterSeconds` | randomizes timing a little so it doesn't look robotic |

The tracker auto-loads `.env` from the project dir; Docker also injects it via `env_file:`.
Real environment variables always win over the file. It refuses to start without
`NTFY_TOPIC`.

## Tracking a different / additional slot
Change `course.serialNo` to the new course code. To watch several at once, copy this
directory to a new one and add a service block for it in the root `docker-compose.yml`
(see ["Adding a new tracker"](../README.md#adding-a-new-tracker)).

## Notes & gotchas
- **Be polite.** Hourly is plenty for a course that fills over *weeks*. Don't hammer a
  government institute's ERP every few seconds.
- The ERP API shape can change (it's an internal endpoint, not a documented one); the parser
  fails *safe* — on any error it logs and leaves state unchanged rather than firing a false
  alert.
- `TZ=Asia/Kolkata` is set in `docker-compose.yml` so `notify.dailyHour` means 9 AM IST, not
  9 AM UTC.
- Train your legs before the seat opens. 🥾
