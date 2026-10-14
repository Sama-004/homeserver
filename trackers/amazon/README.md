# 📚 Amazon Stock Notifier

Watches Amazon.in and sends an **ntfy push** the moment a watched product comes back in
stock. Today it watches one product, the **Kobo Clara BW** eReader (ASIN `B0CZXYV8GT`).
It sells in small batches that go quickly, so the restock alert is urgent and the check
runs every 5 minutes.

Part of the [trackers monorepo](../README.md): the `docker compose` commands below run from
`trackers/`, and the shared `.env` lives there too.

## How it works

The product page (`/dp/B0CZXYV8GT`) can't be used. While the Clara BW has no offer, Amazon
serves a different product at that URL (its SleepCover, canonical `/dp/B0D1KT1B6G`), so a
scrape of it reads the wrong item.

Kobo's Amazon **brand store page** for the Clara BW is server-rendered and embeds one JSON
record per product:

```json
{"asin":"B0CZXYV8GT","buyingOptions":[{"price":"/marketplaces/…/price",
  "availability":{"primaryMessage":"Currently unavailable.","type":"OUT_OF_STOCK"}, …}],
 "detailPageLinkURL":"/Kobo-BW-Glare-Free-Touchscreen-ComfortLight/dp/B0CZXYV8GT", …}
```

Each check is one plain `GET` of the store page (desktop Chrome user agent,
`Accept-Language: en-IN`), with no cookies and no browser. The tracker finds
`"asin":"<asin>","buyingOptions"`, takes the JSON object that starts there, and reads:

- `buyingOptions[].availability.type`. A product is **in stock exactly when any buying
  option is `IN_STOCK`**. `OUT_OF_STOCK` is out of stock. Any other type (a pre-order, or a
  value Amazon adds later) is not in stock, but it gets a push of its own.
- `availability.primaryMessage`, the text the site shows ("In stock", "Currently unavailable.").
- `price.priceToPay.moneyValueOrRange.value.displayString` (`₹20,899.00`). It only exists
  when the item is in stock; out of stock, `price` is a string, not an object.
- `detailPageLinkURL`, the product link in the push.

Products that share a store page cost one request. One check is one page, about 120 KB on
the wire (gzip) and 350 KB decoded.

**Fail-safe:** each of these is an error, never "out of stock":

- an HTTP 503, or a page without the record that looks like a robot check (`captcha`,
  `Robot Check`, `api-services-support@amazon.com`): `Amazon served a robot check`;
- a page without the record otherwise: `record for B0CZXYV8GT missing`, meaning Kobo
  rearranged its store, so find the product's store page and update `storePage`;
- a record with no availability type, or any other HTTP or parse error.

The check is retried once after 5 s. If it still fails, the tracker logs it and leaves the
baseline in `data/state.json` **unchanged**.

## What it pushes

One check sends at most **one** combined stock push.

| signal | priority | when |
|---|---|---|
| 📚 **In stock** | urgent | a watched product goes to `IN_STOCK`. Title `Kobo Clara BW in stock on Amazon`; body: price, Amazon's stock message, product link, "Limited stock: buy now." Tapping opens the product. Also fires on the very first run if it is already in stock |
| 📚 **Still in stock** | high | while it stays in stock, a reminder at most every `notify.remindEveryMinutes` (15) |
| 📚 **Unusual availability** | high | the availability type changes to something other than `IN_STOCK` / `OUT_OF_STOCK` (e.g. a pre-order). Body: Amazon's message and the raw type. Fires once per change |
| 📚 **Daily check-in** | min | once a day at `notify.dailyHour` (9, local time): ✅ / ❌ per watched product with Amazon's message. This is the **heartbeat**: if it stops arriving, the tracker is dead |
| ⚠️ **Failing** | default | checks have failed for `notify.failureAlertHours` (6). One push, reset on the next good check |

Going out of stock is only logged. Every check logs each product's raw availability type,
so a new type shows up in `docker compose logs`.

If the push itself fails (ntfy down), the baseline is not advanced, so the same restock
alerts again on the next check.

## Setup / verify

Uses the shared `NTFY_TOPIC` from `trackers/.env`. Needs **Node >= 20**, no `npm install`.

```bash
cd amazon
node tracker.mjs --dump                            # every product record on the store page, no push, no state
ENV_FILE=../.env node tracker.mjs --test-notify    # should buzz your phone
ENV_FILE=../.env node tracker.mjs --once           # one real check
```

`--dump` prints every product record on each watched store page with its availability
type, price, message and link, and marks the watched ones 👀. Use it to check a store page
before adding its product to `config.json`.

`--once` (also the default) runs one check, updates `state.json`, and writes `next-run`
next to it: one line, the unix time in seconds of the next check
(now + `watch.intervalMinutes` ± `watch.jitterSeconds`). It writes `next-run` even when
the check fails.

## Running it 24/7 (Docker)

The compose service is `amazon-notifier`. The container's long-lived process is the shared
`run-loop.sh`. It runs `node tracker.mjs --once`, then sleeps until the time in
`data/next-run`. Everything the tracker remembers lives in `data/state.json`. From
`trackers/`:

```bash
docker compose run --rm amazon-notifier node tracker.mjs --test-notify
docker compose up -d --build amazon-notifier
docker compose logs -f amazon-notifier
```

## Config reference (`config.json`)

| key | meaning |
|-----|---------|
| `products[].asin` | the Amazon.in ASIN (`B0CZXYV8GT`) |
| `products[].name` | short name used in pushes and logs (`Kobo Clara BW`) |
| `products[].storePage` | the brand store page whose HTML carries the product's record. Not the `/dp/` page |
| `notify.remindEveryMinutes` | rate limit for "still in stock" reminders (default 15) |
| `notify.dailyHour` | hour (local) for the daily check-in / heartbeat. `-1` disables |
| `notify.failureAlertHours` | warn once after this many hours of failed checks (default 6) |
| `watch.intervalMinutes` / `watch.jitterSeconds` | check cadence (default every 5 min, ±90 s) |

`.env` holds only `NTFY_TOPIC` (required) and optionally `NTFY_SERVER`. Real environment
variables win over the file.

## Adding a product

1. Find an Amazon store page (`https://www.amazon.in/stores/...`) that lists the product.
2. Run `node tracker.mjs --dump` with that page as a product's `storePage` and confirm the
   ASIN's record shows up with a type.
3. Add `{ "asin", "name", "storePage" }` to `products`.

## Notes & gotchas

- **Robot check.** None showed up in testing (Oct 2026, a handful of plain GETs from a home
  connection). If Amazon starts serving one on every check, the failing push says so after
  6 hours.
- **Record missing** means the store page no longer lists the product. It counts as a failed
  check, not as "out of stock".
- `TZ=Asia/Kolkata` in compose makes `notify.dailyHour` 9 AM IST.
