# 👕 Uniqlo Price Notifier

Watches the **men's section of [uniqlo.com/in](https://www.uniqlo.com/in/en/)** and sends an
**ntfy push** when a product's price drops, when a new product appears, and (quietly) when a
price goes up. Sale sizes sell out fast, so price drops are urgent. Every listing's price
and its full history live in a SQLite database.

Part of the [trackers monorepo](../README.md): the `docker compose` commands below run from
`trackers/`, and the shared `.env` lives there too.

## How it works

The website is behind Akamai and answers a plain `fetch` with 403. The JSON API that the
site itself calls does not:

```
GET https://www.uniqlo.com/in/api/commerce/v5/en/products?path=9672%2C%2C&limit=100&offset=<n>
x-fr-clientid: uq.in.web-spa      (without it: 400 "invalid or missing client id")
```

`path=9672,,` is the **MEN** category id (from `result.aggregations.tree.genders`). It
returns the MEN and UNISEX products, which is what the site's men section shows: about 650
listings, 7 pages of 100. The API ignores `genderId=men` and returns every gender.

Each item has `productId`, `priceGroup`, `name`, `genderCategory`, `prices.base.value`
(INR), `prices.promo` (`null`, or `{value}` on sale), the sale flag's
`effectiveTime.{start,end}`, the representative colour and its image.

**A listing is a product in one price group.** One `productId` can appear twice: `00` at
full price for some colours and `01` on sale for others, each with its own price and URL
(`https://www.uniqlo.com/in/en/products/<productId>/<priceGroup>`). So the key everywhere is
`(productId, priceGroup)`.

**Fail-safe:** a partial catalogue would read as "products removed", so the whole check
fails when:

- any page has an HTTP error, isn't JSON, or has `status` other than `"ok"`, no `items`, or
  no `pagination.total`;
- the total changes while paging, a page comes back empty early, or the distinct listings
  don't add up to the total;
- any item lacks `productId` / `priceGroup` / `name` or a numeric price;
- the catalogue is complete but **under 80%** of the listings the last good check had. If
  the catalogue really shrank that much, accept it once:
  `docker compose run --rm uniqlo-notifier node tracker.mjs --once --accept-shrink`.

The check is retried once after 5 s. If it still fails, the tracker logs it and leaves the
database **unchanged**.

## The database

`data/uniqlo.db`, written with Node's built-in `node:sqlite` (no npm dependencies). Each
check is one transaction.

| table | rows |
|---|---|
| `products` | one per listing: `product_id`, `price_group`, `name`, `gender`, `base`, `promo`, `price` (`promo ?? base`, what you pay), `sale_start` / `sale_end` (unix s), `first_seen`, `last_seen`, `removed_at` (set when it leaves a complete catalogue, cleared when it comes back) |
| `price_history` | `product_id`, `price_group`, `at`, `base`, `promo`, `price`: one row when a listing is first seen and one on every change |

`data/state.json` holds only the alert bookkeeping (`lastDailyDate`, `failure`), the same
as the other trackers. The 80% baseline comes from the database itself.

Query it from the container (Alpine has no `sqlite3`, Node does):

```bash
docker compose run --rm uniqlo-notifier node -e '
  const db = new (require("node:sqlite").DatabaseSync)("data/uniqlo.db");
  console.table(db.prepare("SELECT * FROM price_history WHERE product_id = ? ORDER BY at").all("E492171-000"))'
```

## What it pushes

One check sends at most **one** combined push. Entries are sorted, strongest kind first;
the title and priority come from the strongest kind present. The body lists as many entries
as fit in ntfy's 4 KB, then `…and N more`. Tapping opens the first entry's product page, and
its product photo is attached.

| signal | priority | when |
|---|---|---|
| 📉 **Price drop** | urgent | a listing's price went down. `Name (colour) ₹2,990 → ₹1,990 (-33%)` and the link, biggest % first. Title: the product and its % for one drop, `Uniqlo: N men's price drops` for several. Also a new or returning listing cheaper than a live listing of the same product: that is how a sale starts (a new `01` group for some colours) |
| 🆕 **New product** | high | a listing never seen before. `🆕 Name (colour) ₹price` and the link |
| ↩️ **Back** | default | a listing that was removed is in the catalogue again |
| 📈 **Price rise** | default | listed last, never raises the priority (a sale ending shows up here) |
| 👕 **Daily check-in** | min | once a day at `notify.dailyHour` (9, local time): listings tracked, how many on sale, and the last 24 h's drops, rises and new listings. This is the **heartbeat**: if it stops arriving, the tracker is dead |
| ⚠️ **Failing** | default | checks have failed for `notify.failureAlertHours` (6). One push, reset on the next good check |

A listing missing from a complete catalogue gets `removed_at` and a log line, no push.

The **first ever check** fills the database and sends nothing (650 "new products" would be
spam). It logs the counts.

If the push itself fails (ntfy down), the database is not advanced, so the same changes
alert again on the next check.

## Schedule: 02:01 every night

On 15 Oct 2026, every one of the 117 men's sale listings had a sale `effectiveTime.start`
of **Tuesday 02:00 IST** (13 Oct, 6 Oct, 29 Sep, and back to July). So besides the
regular check every `watch.intervalMinutes` (15, ±60 s jitter), the tracker wakes at each
`watch.wakeAt` local time (`02:01`): `next-run` is whichever comes first. For example, a
check at 01:50 schedules 02:01, one at 02:05 schedules 02:20, and one at 23:55 schedules
00:10.

To confirm when prices really change after a few weeks:

```bash
docker compose run --rm uniqlo-notifier node tracker.mjs --stats
```

It prints the changes and new listings in `price_history` per weekday and per hour of day
(local time), leaving out the first fill. A check finds a change up to 15 minutes after it
happens, so read the hour with that slack.

## Setup / verify

Uses the shared `NTFY_TOPIC` from `trackers/.env`. Needs **Node >= 22.13** (for
`node:sqlite` without a flag), no `npm install`.

```bash
cd uniqlo
node tracker.mjs --dump                            # the live catalogue, no push, no database
ENV_FILE=../.env node tracker.mjs --test-notify    # should buzz your phone
ENV_FILE=../.env node tracker.mjs --once           # one real check
node tracker.mjs --stats                           # changes per weekday / hour
```

`--dump` prints the listing count, how many are on sale, and one row per listing (key,
gender, price, base price when on sale, name and colour), sale items first.

`--once` (also the default) runs one check, updates `uniqlo.db` and `state.json`, and writes
`next-run` next to them: one line, the unix time in seconds of the next check. It writes
`next-run` even when the check fails.

## Running it 24/7 (Docker)

The compose service is `uniqlo-notifier`. The container's long-lived process is the shared
`run-loop.sh`. It runs `node tracker.mjs --once`, then sleeps until the time in
`data/next-run`. Everything the tracker remembers lives in `data/`. From `trackers/`:

```bash
docker compose run --rm uniqlo-notifier node tracker.mjs --test-notify
docker compose up -d --build uniqlo-notifier
docker compose logs -f uniqlo-notifier
```

## Config reference (`config.json`)

| key | meaning |
|-----|---------|
| `catalogue.path` | the API category id (`9672,,` is MEN) |
| `catalogue.label` | the word in push titles (`men's`) |
| `notify.dailyHour` | hour (local) for the daily check-in / heartbeat. `-1` disables |
| `notify.failureAlertHours` | warn once after this many hours of failed checks (default 6) |
| `watch.intervalMinutes` / `watch.jitterSeconds` | regular cadence (default every 15 min, ±60 s) |
| `watch.wakeAt` | local `HH:MM` times to always check at (default `["02:01"]`) |

`.env` holds only `NTFY_TOPIC` (required) and optionally `NTFY_SERVER`. Real environment
variables win over the file.

## Notes & gotchas

- **`node:sqlite` is experimental on Node 22** and prints an `ExperimentalWarning` on load.
  The tracker drops that one warning in code (run-loop.sh runs plain `node tracker.mjs`, so
  it can't pass `--disable-warning`). Every other warning still prints.
- Push links go to product pages, which load fine. The men's sale listing page
  (`/in/en/feature/sale/men`) couldn't be checked: Akamai answers a plain fetch with 403.
- A product that is only on sale in some colours shows the representative colour's name and
  photo. The link opens the product page with every colour.
- `TZ=Asia/Kolkata` in compose makes `notify.dailyHour`, `watch.wakeAt` and `--stats` IST.
