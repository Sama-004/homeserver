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
| `/Courses_By_IISM.html` | the per-course sections. `#snowski2026` is the snow-skiing schedule |
| `/Course_Schedule.html` | the same snow-skiing schedule + the "courses opening" table |

In Oct 2026 the site moved every page to a `.html` URL, and the old extensionless ones now
404. If a page 404s again, update `site.pages`.

IISM announces booking dates in **red blinking text** (`class="blink-text"`). In July it was
the popup's banner line ("📢 Bookings will open tomorrow i.e. 14/07/2026 at 10:00 AM"). For
the ski schedule it's in the ticker item, the popup and the section ("BOOKING DATE: 12TH
NOVEMBER 2026 AT 10:00 HRS"). The tracker treats all blink-text on the site together as
"the banner".

Each page becomes a list of *visible* text lines (one per table row / list item / heading /
paragraph). It keeps HTML comments and `d-none` blocks separately as *hidden* lines. Each
run is compared with the previous one in `data/state.json`.

**Fail-safe:** a page that fails to fetch, or doesn't look like the IISM site (error page,
maintenance stub, 404), is skipped. The other pages are still checked, and the failed page
keeps its last good snapshot, so it never reports "everything changed" because of a broken
response. Only if *every* page fails is the whole cycle given up (after one retry).

## What it pushes

| signal | priority | when |
|---|---|---|
| 🎿 **Ski news** | urgent | a new visible line mentions snow skiing / snowboarding / a ski course (water skiing is ignored) |
| 📢 **Banner changed** | high (urgent if it mentions skiing) | the popup's red "Bookings will open …" line changes |
| ⏰ **Booking reminders** | urgent | when the banner (or a new ski section) contains a date and time: pushes at T-60 min, T-10 min, and T-0 ("OPEN now"). The check before a reminder schedules the next one for that minute |
| 🔔 **Scheduled** | high | fixed local times from `notify.scheduled`, each sent once on the minute, even if the site is down. Set for 12 Nov 2026, hourly 11:00–21:00: unpaid applications from the 10:00 opening free their seats, and seat counts only show inside the OTP-gated admission portal |
| 👀 **Hint** | default | **hidden** ski content changed, e.g. someone edits the commented-out snow-skiing table to 2026-27 dates before publishing it |
| 🆕 **Site updated** | low | any other newly visible line (ticker items, course rows) |
| 🏔️ **Daily check-in** | min | once a day at `notify.dailyHour`: is a snow-skiing schedule up yet, the current banner, any pending reminders. This is the **heartbeat**: if it stops arriving, the tracker is dead |
| ⚠️ **Failing** | default | a page (or the whole check) has failed for `failureAlertHours`. One push per page, reset when it works again |

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

Each check is a fresh `node tracker.mjs --once`; compose runs it through
[`../run-loop.sh`](../run-loop.sh), which sleeps until the time the check wrote to
`data/next-run`: an hour out, or the next unsent booking reminder if that is sooner.

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
| `notify.failureAlertHours` | warn once per page after this many hours of failures |
| `notify.scheduled` | fixed-time pushes: `{date, times[], title, message, tags?, priority?}`. A failed push retries a minute later; one more than 20 min late is skipped |
| `watch.intervalMinutes` / `watch.jitterSeconds` | check cadence (default hourly, ±2 min) |

## Notes & gotchas

- **Booking time parsing:** handles `14/07/2026 at 10:00 AM`, `14.07.2026`,
  `08th JUNE 2026 AT 10:00 AM` and `12TH NOVEMBER 2026 AT 10:00 HRS`, read as DD/MM (India). If no time is given it assumes
  10:00 AM, which every IISM opening so far has used, and says so in the reminder.
  `TZ=Asia/Kolkata` in compose makes these IST.
- Reminders come from the **banner**, whatever course it's about. The banner doesn't always
  name courses, so a summer-course opening also gets reminders. Better a spare buzz than a missed
  window.
- The seats are first-come-first-served, and the form wants photo, DOB proof, qualification
  certificate and signature as jpg/png under 500 KB, plus OTP on your mobile. Have them
  ready before T-0.
- Also follow [@iism_.gulmarg](https://www.instagram.com/iism_.gulmarg/). The site itself
  says to watch both.
