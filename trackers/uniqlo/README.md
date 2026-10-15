# 👕 Uniqlo Price Notifier

Watches the **men's section of [uniqlo.com/in](https://www.uniqlo.com/in/en/)** and sends an
**ntfy push** only for things you can buy in **your sizes** (`sizes`, default S, M, L): a
colour on sale or just cheaper that is in stock in one of them, or a new product in stock in
one of them. Sale sizes sell out fast, so deals are urgent. A sale or price drop with none of
your sizes in stock, a price rise, a product leaving or coming back: logged, never pushed.
Every listing's price and its full history live in a SQLite database.

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

**Stock comes from a second call per listing**, the one the product page makes:

```
GET https://www.uniqlo.com/in/api/commerce/v5/en/products/<productId>/price-groups/<group>/l2s?withPrices=true&withStocks=true&includePreviousPrice=false&httpFailure=true
```

`result.l2s[]` is one SKU per colour × size (`l2Id`, `color.code`, `size.code`),
`result.stocks[l2Id].statusCode` is `IN_STOCK`, `LOW_STOCK` or `STOCK_OUT` (with a
`quantity`), and `result.prices[l2Id]` is that SKU's base and promo price. A size counts when
it is `IN_STOCK` or `LOW_STOCK` with a quantity above 0. Size and colour codes mean the same
thing on every product (`SMA004` is M, `COL38` is dark brown); their names come from the
catalogue's `aggregations` and items. An item's own `sizes` / `colors` list only what is in
stock and sometimes lags the stock call (on 15 Oct, 3 of 128 sale listings disagreed, one with
an in-stock M missing from the list), so the tracker never reads stock from them.

Every check makes this call for each sale listing (about 130), each listing that dropped in
price, and each new product: 4 at a time, about 35 s in all (each call takes about 1 s at
Uniqlo's end). A listing whose call fails is skipped this check and tried again on the next.
If more than half fail, the check fails like a bad catalogue: no push, database unchanged.

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
| `deal_alerts` | `product_id`, `price_group`, `color_code`, `price`, `alerted_at`: one per deal already pushed (or summed up on the baseline check). A colour that sells out and comes back at the same price is not pushed again |

`PRAGMA user_version` is 1 once `deal_alerts` has been filled by a baseline check (see below).

`data/state.json` holds only the alert bookkeeping (`lastDailyDate`, `failure`), the same
as the other trackers. The 80% baseline comes from the database itself.

Query it from the container (Alpine has no `sqlite3`, Node does):

```bash
docker compose run --rm uniqlo-notifier node -e '
  const db = new (require("node:sqlite").DatabaseSync)("data/uniqlo.db");
  console.table(db.prepare("SELECT * FROM price_history WHERE product_id = ? ORDER BY at").all("E492171-000"))'
```

## What it pushes

One check sends at most **one** combined push, one entry per colour. Entries are sorted,
strongest kind first, then biggest discount first; the title and priority come from the
strongest kind present. The body lists as many entries as fit in ntfy's 4 KB, then
`…and N more`. Tapping opens the first entry's product page on its colour
(`?colorDisplayCode=38`, which the site honours), and that colour's photo is attached.

A **deal** is a listing that is on sale (`promo` set) or whose price dropped this check (also a
new or returning listing cheaper than a live listing of the same product: that is how a sale
starts, a new `01` group for some colours). For each deal, every colour in stock in one of
your sizes is keyed by `(productId, priceGroup, colour, price)`, and a key is pushed once.

| signal | priority | when |
|---|---|---|
| 📉 **Deal** | urgent | a deal key never pushed before. `Washable Milano Ribbed Knitted T-Shirt (dark brown) ₹2,490 → ₹1,490 (-40%) · S M L`: the colour's base price (or the old price, for a drop off-sale), its price, and your sizes in stock. A sale that started over 2 days ago adds `· on sale since Tue 6 Oct`, so a restock of an old sale doesn't read as a fresh markdown. This covers a fresh markdown and a sale colour coming back in your size. A further price cut is a new key and pushes again |
| 🆕 **New product** | high | a product ID never seen in any price group, in stock in one of your sizes. `🆕 Name (colour) ₹price · M L`. A new product with none of your sizes in stock is stored and never pushed |
| 🏷️ **Sale summary** | default | once, on the baseline check (below) |
| 👕 **Daily check-in** | min | once a day at `notify.dailyHour` (9, local time): listings tracked, how many on sale and how many of those are in stock in your sizes, and the last 24 h's deals pushed, drops, rises and new listings. This is the **heartbeat**: if it stops arriving, the tracker is dead |
| ⚠️ **Failing** | default | checks have failed for `notify.failureAlertHours` (6). One push, reset on the next good check |

Logged only: price rises, drops and sales with none of your sizes in stock, a listing leaving
a complete catalogue (it gets `removed_at`), a listing coming back (`back`), and a known
product moving to another price group at the same or a higher price (`regroup`, as when the
Oxford Shirt moved from `/00` to `/01` at ₹2,490).

**Baseline check.** The first check with an empty `deal_alerts` (the first ever, or the first
after deal tracking was added) would otherwise push every current sale colour as urgent. It
records all of them silently and sends one default push instead: `Uniqlo: N men's sale items
in S/M/L right now`, biggest discount first. New products found on that check are stored
without a push. After that, `user_version` is 1 and it never happens again.

If the push itself fails (ntfy down), neither the database nor `deal_alerts` is advanced, so
the same entries push again on the next check.

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
node tracker.mjs --deals                           # sale colours in your sizes right now
ENV_FILE=../.env node tracker.mjs --test-notify    # should buzz your phone
ENV_FILE=../.env node tracker.mjs --once           # one real check
node tracker.mjs --stats                           # changes per weekday / hour
```

`--dump` prints the listing count, how many are on sale, and one row per listing (key,
gender, price, base price when on sale, name and colour), sale items first. Under each sale
listing, one line per colour in stock in your sizes (`dark brown ₹1,490: M`), or
`no S/M/L in stock`.

`--deals` prints every sale colour in stock in your sizes right now, as it would read in a
push, biggest discount first. Like `--dump`, it touches neither the database nor ntfy.

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
| `sizes` | size names that make a push (default `["S", "M", "L"]`), matched by the name the site shows. Products without them, like waist-sized trousers, never push |
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
- A price group's colours can have different base prices (2 of 128 sale listings on 15 Oct),
  so each push line uses its colour's own prices from the stock call.
- `TZ=Asia/Kolkata` in compose makes `notify.dailyHour`, `watch.wakeAt` and `--stats` IST.
