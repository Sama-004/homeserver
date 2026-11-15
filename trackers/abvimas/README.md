# ⛷️ ABVIMAS Ski-Course Notifier

Watches [abvimas.org](https://www.abvimas.org/) (Atal Bihari Vajpayee Institute of
Mountaineering and Allied Sports, Manali) and sends an **ntfy push** when a **snow-skiing**
booking is announced, when it goes live, and when Basic Skiing seats move. It also sends
**exact-time reminders** before a booking opens.

Part of the [trackers monorepo](../README.md): the `docker compose` commands below run from
`trackers/`, and the shared `.env` lives there too.

## How ABVIMAS runs skiing bookings

Learned from the notice board's history (2025-26 season):

- Each skiing batch's booking is announced **on its own**, on the
  [Notice Board](https://www.abvimas.org/notices/), only **1–6 days ahead**. For example
  "Booking for Basic & Advance Skiing Course [27-01-2026 to 09-02-2026] Will be open on 24th
  January, 2026 at 11:00 AM on our website" was posted on 23 Jan at 12:11. Openings so far
  were at 11:00 AM or 12:30 PM.
- Booking is on the site itself, first come first served: **Apply Online** → step 1 picks a
  **session** (e.g. "2026") and the activity → step 2 is a table of slots with **Available
  Seats** → the form. Documents are **JPG/JPEG only**.
- The [Basic Snow Skiing page](https://www.abvimas.org/course/basic-skiing-course/) lists the
  season's batches (activity codes 12–16, 11 Jan – 27 Mar) without years.

## What it watches

The site is server-rendered PHP, so this is a zero-dependency `fetch` + diff, like
[`iism/`](../iism/). Every check fetches:

| page | signal |
|---|---|
| `/notices/` | new notices. A new one is fetched for its text and attachment (PDF/image) |
| `/course/apply-first-step` | the **Session** dropdown: a new session (e.g. "2027") |
| `/course/apply-second-step/<session>/2/<name>/Skiing--Snowboarding` | the **booking table**, for every listed session **plus the next session id** (that URL works by id, so slots can show before the dropdown lists the session) |
| `/course/basic-skiing-course/` | the seat chart (batch dates) |

Each part fails on its own: a page that errors or doesn't look like ABVIMAS keeps its last
good snapshot, so a broken response never looks like "everything changed".

## What it pushes

| signal | priority | when |
|---|---|---|
| 🎿 **Booking is LIVE** | urgent | a skiing row appears in a booking table (seat counts + a link straight to it) |
| 🎿 **Seats back** | urgent | a Basic Skiing slot goes from 0 to more than 0 seats |
| 🎿 **New skiing notice** | urgent | a new notice mentions skiing/snowboarding. Its "open on <date> at <time>" becomes reminders |
| ⏰ **Booking reminders** | urgent | 3 h, 1 h, 10 min before the opening, and at the opening. With no time stated, 10:00 AM is assumed (and said) |
| 📅 **New session** | high | a session is added on Apply Online step 1 |
| ⚠️ **Seats running out** | high | a Basic Skiing slot drops below `notify.lowSeats` (once per slot) |
| 📌 **New notice** | default | any other new notice |
| **Slot full / chart changed** | default | a Basic Skiing slot hits 0; the course page's batch list changes |
| 🏔️ **Daily check-in** | min | once a day at `notify.dailyHour`: open slots, sessions, latest skiing notice, pending reminders. The **heartbeat** |
| ⚠️ **Failing** | default | a part has failed for `failureAlertHours` |

One check sends **one** combined push, titled by its strongest signal. The first ever run
only records a baseline (it still sets reminders from an existing skiing notice).

**Timing:** a check every 10 minutes, since a notice can come under a day ahead. From 15
minutes before a known opening to an hour after, it checks **every minute**, so "booking is
LIVE" lands right away.

## Setup / verify

Uses the shared `NTFY_TOPIC` from `trackers/.env`. Needs **Node >= 20**, no `npm install`.

```bash
cd abvimas
node tracker.mjs --dump                              # what the parser sees (no push, no state)
ENV_FILE=../.env node tracker.mjs --test-notify      # should buzz your phone
```

`--dump` prints the newest notices (🎿 = skiing, ⏰ = parsed opening time), the sessions, the
skiing booking table and the seat chart.

## Running it 24/7 (Docker)

Deploys ride the push-to-`main` workflow. By hand, from `trackers/`:

```bash
docker compose run --rm abvimas-notifier node tracker.mjs --test-notify
docker compose up -d --build abvimas-notifier
docker compose logs -f abvimas-notifier
```

## Config (`config.json`)

| key | meaning |
|---|---|
| `site.*` | the page URLs; `activityId` 2 = Skiing/Snowboarding |
| `match.skiPattern` | what counts as skiing (word-bounded, so "skill" doesn't) |
| `match.targetPattern` | your course (Basic Snow Skiing): seat-change alerts are for these rows |
| `notify.reminderMinutesBefore` | reminder offsets before an announced opening |
| `notify.lowSeats` | "running out" threshold |
| `notify.dailyHour` | daily check-in hour (IST), -1 disables |
| `watch.intervalMinutes` | minutes between regular checks (also the healthchecks.io timeout) |
| `watch.fastIntervalSeconds`, `fastBeforeMinutes`, `fastAfterMinutes` | the fast window around a known opening |

## Notes

- The step-2 table's rows were never seen populated while building this (no booking was
  open). It reads them by the table's own headers (Course Name, Slot Name, Total Seats,
  Available Seats), as in ABVIMAS's booking tutorial. If a live booking ever shows no slots
  here, run `--dump` and compare with the page.
- Office: 01902-255313 (Director), 01902-255316 (Training), abvimasmanali@gmail.com.
