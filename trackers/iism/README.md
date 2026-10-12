# 🎿 IISM Gulmarg Ski-Course Notifier

Watches [iismgulmarg.in](https://www.iismgulmarg.in/) (Indian Institute of Skiing &
Mountaineering, Gulmarg) and sends an **ntfy push** when the **snow-skiing course** schedule
or its booking date shows up, then sends **exact-time reminders** when bookings open.
Built because the Basic Skiing Course seats go fast, and the site and Instagram are the
only places they announce it.

Part of the [trackers monorepo](../README.md): the `docker compose` commands below run from
`trackers/`, and the shared `.env` lives there too.

## How it works

The site is plain server-rendered HTML (no API, no JS rendering), so this is a zero-dependency
`fetch` + diff, like [`nimas/`](../nimas/). Every hour it fetches three pages:

| page | why |
|---|---|
| `/` (home) | the **"Latest updates"** ticker, plus the site-wide popup |
| `/Courses_By_IISM` | the per-course sections. Last season's snow-skiing table is **commented out** in the HTML here |
| `/course_Schedule` | the "courses calendar" page |

All three carry the same **popup** that opens on page load: a red banner line ("📢 Bookings
will open tomorrow i.e. 14/07/2026 at 10:00 AM") above a "Courses opening" table.

Each page becomes a list of *visible* text lines (one per table row / list item / heading /
paragraph). It keeps HTML comments and `d-none` blocks separately as *hidden* lines. Each
run is compared with the previous one in `data/state.json`.

**Fail-safe:** if a fetch fails, or a page doesn't look like the IISM site (error page,
maintenance stub), it retries once and then leaves state **unchanged** without alerting. It
never reports "everything changed" because of a broken response.

## What it pushes

| signal | priority | when |
|---|---|---|
| 🎿 **Ski news** | urgent | a new visible line mentions snow skiing / snowboarding / a ski course (water skiing is ignored) |
| 📢 **Banner changed** | high (urgent if it mentions skiing) | the popup's red "Bookings will open …" line changes |
| ⏰ **Booking reminders** | urgent | when the banner (or a new ski section) contains a date and time: pushes at T-60 min, T-10 min, and T-0 ("OPEN now"). The watch loop wakes up for these on the minute |
| 👀 **Hint** | default | **hidden** ski content changed, e.g. someone edits the commented-out snow-skiing table to 2026-27 dates before publishing it |
| 🆕 **Site updated** | low | any other newly visible line (ticker items, course rows) |
| 🏔️ **Daily check-in** | min | once a day at `notify.dailyHour`: is a snow-skiing schedule up yet, the current banner, any pending reminders. This is the **heartbeat**: if it stops arriving, the tracker is dead |
| ⚠️ **Failing** | default | every check has failed for `failureAlertHours` (one push, reset on the next good check) |

One cycle sends **one** combined push, titled by its strongest signal. Pushes have
**Apply page** / **Courses** buttons. The apply portal needs mobile OTP, so log in there
yourself.

The first ever run only records a baseline and sends no alerts.

## Setup / verify

Uses the shared `NTFY_TOPIC` from `trackers/.env`. Needs **Node >= 20**, no `npm install`.

```bash
cd iism
node tracker.mjs --dump                                # what the parser sees (no push, no state)
ENV_FILE=../.env node tracker.mjs --test-notify        # should buzz your phone
ENV_FILE=../.env node tracker.mjs --once               # one real check
```

`--dump` prints every visible line (🎿 marks ski matches), the banner, the booking time
parsed from it, and the hidden ski lines. Use it to sanity-check after the site changes.

## Running it 24/7 (Docker)

Deploys ride the push-to-`main` workflow. By hand, from `trackers/`:

```bash
docker compose run --rm iism-notifier node tracker.mjs --test-notify
docker compose up -d --build iism-notifier
docker compose logs -f iism-notifier
```

## Config reference (`config.json`)

| key | meaning |
|-----|---------|
| `site.pages` | the pages to fetch (`name` + `url`) |
| `site.coursesUrl` / `site.applyUrl` | click targets for pushes |
| `site.timeoutMs` | per-request timeout |
| `match.skiPattern` | regex (case-insensitive): a line matching this is ski news. It deliberately does **not** match "Institute of Skiing & Mountaineering" |
| `match.ignorePattern` | blanked out before matching (default: water skiing) |
| `notify.dailyHour` | hour (local) for the daily check-in / heartbeat. `-1` disables |
| `notify.reminderMinutesBefore` | booking reminder offsets, default `[60, 10, 0]` |
| `notify.failureAlertHours` | warn once after this many hours of failed checks |
| `watch.intervalMinutes` / `watch.jitterSeconds` | check cadence (default hourly, ±2 min) |

## Notes & gotchas

- **Booking time parsing:** handles `14/07/2026 at 10:00 AM`, `14.07.2026` and
  `08th JUNE 2026 AT 10:00 AM`, read as DD/MM (India). If no time is given it assumes
  10:00 AM, which every IISM opening so far has used, and says so in the reminder.
  `TZ=Asia/Kolkata` in compose makes these IST.
- Reminders come from the **banner**, whatever course it's about. The banner doesn't name
  courses, so a summer-course opening also gets reminders. Better a spare buzz than a missed
  window.
- The seats are first-come-first-served, and the form wants photo, DOB proof, qualification
  certificate and signature as jpg/png under 500 KB, plus OTP on your mobile. Have them
  ready before T-0.
- Also follow [@iism_.gulmarg](https://www.instagram.com/iism_.gulmarg/). The site itself
  says to watch both.
