# 🥛 Amul Protein Stock Notifier

Watches [shop.amul.com](https://shop.amul.com/en/browse/protein) and sends an **ntfy push**
when Amul whey protein or the high-protein lassi / buttermilk comes back in stock at pincode
**700032**. Built because these sell out within the hour of a restock.

Watched by default (9 products):

- **Whey protein**, all six SKUs: plain and chocolate, 30 and 60 sachets, and both 10-sachet gift packs.
- **High Protein Plain Lassi**, 200 mL × 30.
- **High Protein Rose Lassi**, 200 mL × 30.
- **High Protein Buttermilk**, 200 mL × 30.

Part of the [trackers monorepo](../README.md): the `docker compose` commands below run from
`trackers/`, and the shared `.env` lives there too.

## How it works

The shop is a Vue SPA. The product grid isn't in the HTML; the page's JS fetches it from a
JSON API under `https://shop.amul.com/api/1/entity/`. Stock is per region: each pincode
maps to a **substore** (700032 is `west-bengal`), and the session's store preference decides
which substore's stock the product list reports.

Every API call needs the session cookie and a signed `tid` header, or it gets a 401. The
tracker does the same handshake the site's JS does, with plain `fetch` and `node:crypto`.
There is no browser, so the image stays tiny. Each check:

1. `GET /en/browse/protein` for the session cookies (`jsessionid`, `__cf_bm`, `_cfuvid`)
   and the page's `serverTimestamp`.
2. `GET /user/info.js` for the session's `tid`.
3. Signs each API request with
   `tid = ts:r:sha256(storeId:ts:r:sessionTid)`, where `ts` is the server timestamp advanced by
   the local clock and `r` is a random 0..999. `storeId` is a site constant kept in
   `config.json` (it comes from `/ms/store/amul/auto/EN/storeinfo.js`).
4. `GET pincode` to map the pincode to its substore. Only an exact match counts.
5. `PUT ms.settings/_/setPreferences` with `{"store": "<substore>"}`.
6. `GET ms.products` for the `protein` category: name, alias, price, `available`,
   `inventory_quantity`.

A product is **in stock exactly when `available` is 1**. That is the rule the site's own
template uses to print "SOLD OUT". `inventory_quantity` is logged but not trusted: sold-out
products sometimes carry a non-zero inventory (High Protein Milk showed 7 while sold out).

One check is about 20 KB of requests.

**Fail-safe:** any HTTP or parse error, or a pincode with no exact match, is retried once
after 4 s. If it still fails, the tracker logs it and leaves the stock baseline in
`data/state.json` **unchanged**. It never reads a broken response as "out of stock" or
"back in stock".

## What it pushes

One check sends at most **one** combined stock push.

| signal | priority | when |
|---|---|---|
| 🥛 **In stock** | urgent | a watched product goes from sold out to available. Lists every watched product in stock with price, inventory and product link (new ones marked 🆕). Tapping opens the first new one. Also fires on the very first run if something is already in stock |
| 🥛 **Still in stock** | high | while any watched product stays available, a reminder at most every `notify.remindEveryMinutes` (30) |
| 🥛 **Daily check-in** | min | once a day at `notify.dailyHour` (9, local time): ✅ / ❌ per watched product, plus a ⚠️ line for any match pattern that hits no product. This is the **heartbeat**: if it stops arriving, the tracker is dead |
| ⚠️ **Failing** | default | checks have failed for `notify.failureAlertHours` (6). One push, reset on the next good check |

Going out of stock is only logged. The stock alert's body reminds you to pick pincode 700032
on the site, because the site shows the stock of whatever pincode the browser has selected.

If the push itself fails (ntfy down), the baseline is not advanced, so the same restock
alerts again on the next check.

## Setup / verify

Uses the shared `NTFY_TOPIC` from `trackers/.env`. Needs **Node >= 20**, no `npm install`.

```bash
cd amul
node tracker.mjs --dump                            # every protein product, no push, no state
ENV_FILE=../.env node tracker.mjs --test-notify    # should buzz your phone
ENV_FILE=../.env node tracker.mjs --once           # one real check
```

`--dump` prints all protein products for the pincode with availability, inventory, price
and link, marks the watched ones 👀, and warns about match patterns that hit nothing. Use it
after the catalog changes or before editing `products.match`.

`--once` (also the default) runs one check, updates `state.json`, and writes `next-run`
next to it: one line, the unix time in seconds of the next check
(now + `watch.intervalMinutes` ± `watch.jitterSeconds`). It writes `next-run` even when
the check fails.

## Running it 24/7 (Docker)

The compose service is `amul-notifier`. The container's long-lived process is the shared
`run-loop.sh`. It runs `node tracker.mjs --once`, then sleeps until the time in
`data/next-run`. Everything the tracker remembers lives in `data/state.json`. From
`trackers/`:

```bash
docker compose run --rm amul-notifier node tracker.mjs --test-notify
docker compose up -d --build amul-notifier
docker compose logs -f amul-notifier
```

## Config reference (`config.json`)

| key | meaning |
|-----|---------|
| `site.baseUrl` / `site.browsePath` | the shop and the page loaded for the session (`/en/browse/protein`) |
| `site.category` | the product category to list (`protein`) |
| `site.storeId` | site constant used to sign requests, from `/ms/store/amul/auto/EN/storeinfo.js` (`"storeId"`). Not a secret |
| `site.timeoutMs` | per-request timeout |
| `location.pincode` | the delivery pincode whose stock is checked (`700032`) |
| `products.match` | case-insensitive substrings of the product name. A product is watched if any matches |
| `notify.remindEveryMinutes` | rate limit for "still in stock" reminders (default 30) |
| `notify.dailyHour` | hour (local) for the daily check-in / heartbeat. `-1` disables |
| `notify.failureAlertHours` | warn once after this many hours of failed checks (default 6) |
| `watch.intervalMinutes` / `watch.jitterSeconds` | check cadence (default every 5 min, ±60 s) |

`.env` holds only `NTFY_TOPIC` (required) and optionally `NTFY_SERVER`. Real environment
variables win over the file.

## Notes & gotchas

- **If every check fails with 401 or 503**, the session handshake changed. In Oct 2026 the
  server rejected a missing, malformed or stale `tid` with 401 but did not check the hash,
  so a changed `storeId` would not show up today. If Amul starts enforcing it, get the
  current `storeId` from `storeinfo.js` and put it in `config.json`.
- **Pincode not found** means the pincode lookup returned no exact match: Amul stopped
  delivering there or the lookup changed. It counts as a failed check, not as "sold out".
- **Product renamed:** matching is by name, so a rename can drop a product silently. The
  daily check-in lists every watched product by name and flags patterns that match nothing.
  Run `--dump` to see the current names.
- 5 minutes is a deliberate trade-off. Restocks sell out within the hour, and one check
  costs about 20 KB.
- `TZ=Asia/Kolkata` in compose makes `notify.dailyHour` 9 AM IST.
