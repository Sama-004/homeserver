# 🎟️ IISM Booker

Books an IISM Gulmarg ski course **by itself** the moment a seat shows up, then pushes a
screenshot of the site's answer to ntfy so you can pay.

Built after 12 Nov 2026: the opening sold out within minutes, and seats from failed payments
came back later the same week without any announcement. They went within hours.

## How it works

**Seat checks, every 15 s, with a dummy mobile number.** The admission form keeps all its
state in the page (no cookies, no session). So after one course → level walk, the saved page
can ask for every batch's *Available Seats* at once, as parallel postbacks. A full check of
Gulmarg Basic, Kargil Basic and Snowboarding (about 14 batches) is **one round trip, about
1.5 s**. The walk is redone every 5 minutes (it picks up a course that gets listed, like
Kargil) and after any failed request.

**Booking, the moment a batch shows a seat.** Headless Chromium opens the form with your real
number (`IISM_MOBILE`), one tab per course + batch with seats (up to 4). It injects your own
autofill userscript, the same code you tested in Tampermonkey, which fills everything,
attaches all 6 documents and submits. The site's JavaScript and validators run as in a real
browser. The userscript recovers from 503 and viewstate errors itself. The booker reloads
Chrome's own network-error page, where no userscript runs.

**One application, never two.** Every Submit, from any tab, goes through one lock:

1. The booker sends the request itself (Playwright `route.fetch`, redirects not followed).
2. It judges the raw answer before any other tab may submit:
   - a redirect away from the form, or any other page, means **accepted**;
   - the form coming back means **rejected**, with the site's message;
   - a 503 or other error page means **unknown**, so it keeps trying.
3. It hands the answer to the page.

On "accepted", every waiting Submit is cancelled. Submits are at least 3 s apart, and a tab
closes once its batch shows 0 seats for 3 checks in a row.

**After a success** it writes `data/booked.json` and stops booking for good, so it never
makes a second application. It pushes **"IISM: application SUBMITTED, pay now"** (urgent,
with the screenshot and the page text) and keeps the accepted tab open. Delete
`data/booked.json` and restart to re-arm it.

## Pushes

| push | priority |
|---|---|
| IISM: application SUBMITTED, pay now (+ screenshot) | urgent |
| IISM seat open: booking now | high |
| IISM seat open (booker not armed): no `IISM_MOBILE` or userscript | urgent |
| checks failing for an hour | default |
| daily check-in at 9: armed/booked, checks OK, seats now | min |
| started | low |

## Setup (on the server)

```bash
# 1. your number (booking only; checks use the dummy number)
echo 'IISM_MOBILE=XXXXXXXXXX' >> ~/homeserver/trackers/.env
# 2. your built userscript (personal data + documents: never commit it)
scp ~/Downloads/iism-autofill-fixed.user.js hp:homeserver/trackers/iism-booker/data/autofill.user.js
# 3. run
cd ~/homeserver/trackers && docker compose up -d --build iism-booker
docker compose logs -f iism-booker
docker compose exec iism-booker node booker.mjs --check        # one seat check, printed
docker compose exec iism-booker node booker.mjs --test-notify  # ntfy works?
```

The userscript is read on every booking, so replacing it takes effect without a restart.

## Config (`config.json`)

| key | meaning |
|---|---|
| `targets` | course + level regexes to book, in priority order; every batch of each |
| `state` | your state's exact option text (seat quotas can depend on it) |
| `watch.everySeconds` | seconds between checks (`backoffSeconds` while the site fails) |
| `watch.rebuildMinutes` | how often to redo the course → level walk |
| `book.maxParallel` | booking tabs at once |
| `book.minSubmitGapSeconds` | minimum gap between any two submits |
| `book.closeAfterZeroChecks` | close a tab after its batch shows 0 seats this many checks in a row |
| `book.attemptMinutes` | give a tab up after this long |

## Testing without the real site

`test/fake-site.mjs` serves the real form page (`test/form.html`, fetched with the dummy
number) with ASP.NET-style postbacks, seat counts read from a JSON file on every request,
submit rejection (`REJECT_N`), random 503s (`ERR_RATE`), a payment-page redirect, and an ntfy
stand-in that records pushes. Point a copy of `config.json`'s `site.formUrl` at it,
set `NTFY_SERVER` to it, `IISM_MOBILE` to a fake number and `CHROMIUM_PATH` to a local
Chromium, then edit the seats file while the booker runs.

Scenarios checked this way:
- seats appear: booked once, with all 6 documents;
- two batches open, first submits rejected: exactly **one** application;
- the site keeps rejecting and the seat goes: paced submits, the tab closes, nothing booked;
- 25% of requests are 503s: still booked once.

**Not testable without really applying:** what the real site does after an accepted submit
(a payment page or an SMS link). The screenshot push is how you'll see it.
