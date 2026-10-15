#!/usr/bin/env node
// Uniqlo India price watcher -> ntfy push when something in the men's section is on sale (or
// just dropped in price) in a colour you can buy in your sizes (urgent: sale sizes sell out
// fast), or when a new product is in stock in your sizes. Everything else is only logged.
// Every listing's price and its history live in a SQLite database next to the state file.
// Usage:
//   node tracker.mjs [--once]        run a single check, write the next-run file, exit
//   node tracker.mjs --once --accept-shrink   accept a catalogue < 80% of the last one
//   node tracker.mjs --test-notify   send a test ntfy push and exit
//   node tracker.mjs --dump          print the live catalogue (no database, no push)
//   node tracker.mjs --deals         print the sale colours buyable in your sizes right now
//   node tracker.mjs --stats         price changes per weekday and hour, from the database
//
// How the data works: the website is behind Akamai and 403s a plain fetch, but the JSON API
// the site itself calls does not. It only needs the web client id header. One category
// (config catalogue.path) is ~650 listings, paged 100 at a time.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { setDefaultAutoSelectFamilyAttemptTimeout } from 'node:net';

// Node 22 prints "SQLite is an experimental feature" on every run. run-loop.sh can't pass
// --disable-warning, so drop just that warning here, before node:sqlite loads.
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w.name !== 'ExperimentalWarning' || !/SQLite/.test(w.message)) console.warn(w);
});
const { DatabaseSync } = await import('node:sqlite');

// Node's happy-eyeballs connect gives each address family only 250ms by default,
// which is tighter than the real-world RTT to ntfy.sh from behind Docker NAT — the
// push then dies as a bare "fetch failed" (ETIMEDOUT) even though the network is fine.
try {
  setDefaultAutoSelectFamilyAttemptTimeout(2000);
} catch {}

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.CONFIG_PATH || join(HERE, 'config.json');
const STATE_PATH = process.env.STATE_PATH || join(HERE, 'state.json');
const NEXT_RUN_PATH = join(dirname(STATE_PATH), 'next-run');
// Exit code of a check that failed without crashing (a crash exits 1). run-loop.sh pings the
// healthchecks.io dead-man's switch only after exit 0, so a tracker that keeps failing is reported.
const CHECK_FAILED = 3;
const DB_PATH = join(dirname(STATE_PATH), 'uniqlo.db');

// The one secret (NTFY_TOPIC) lives in .env, not config.json. Auto-load it if present.
// systemd/Docker may instead inject it via EnvironmentFile/env_file — that's fine,
// existing process.env always wins over the file.
const ENV_FILE = process.env.ENV_FILE || join(HERE, '.env');
try {
  if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
} catch (e) {
  console.error('warning: could not load', ENV_FILE, '-', e.message);
}
const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const TIMEOUT_MS = 30_000;
const API = 'https://www.uniqlo.com/in/api/commerce/v5/en/products';
const PAGE_SIZE = 100;
// A complete catalogue this much smaller than the last one is more likely an API change
// (a filter silently dropped) than a real clear-out, and reading it as real would mark
// hundreds of products removed and then push them all as "back".
const MIN_SHARE = 0.8;
// ntfy turns a body over 4096 bytes into a file attachment; stay under it.
const BODY_LIMIT = 4000;
// Every sale listing gets one stock call per check (~130). A few at a time keeps a check under
// a minute without hammering the API.
const STOCK_CONCURRENCY = 4;
// A sale that started longer ago than this is a restock, not a fresh markdown; the push says so.
const OLD_SALE_S = 2 * 86_400;

const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rupees = (n) => `₹${n.toLocaleString('en-IN')}`;

function loadConfig({ needTopic = true } = {}) {
  const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  // env overrides for containers / secrets
  if (process.env.NTFY_TOPIC) cfg.notify.topic = process.env.NTFY_TOPIC;
  if (process.env.NTFY_SERVER) cfg.notify.server = process.env.NTFY_SERVER;

  if (!cfg.catalogue?.path || !cfg.catalogue?.label) throw new Error('config.json: catalogue needs path and label');
  if (!Array.isArray(cfg.sizes) || !cfg.sizes.length || !cfg.sizes.every((s) => typeof s === 'string'))
    throw new Error('config.json: sizes must be a list of size names, like ["S", "M", "L"]');
  for (const t of cfg.watch.wakeAt || [])
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) throw new Error(`config.json: watch.wakeAt entry "${t}" is not HH:MM`);

  // This must come from .env (or the environment); it is deliberately blank in config.json.
  if (needTopic && !cfg.notify.topic) {
    throw new Error(
      `Missing required secret: NTFY_TOPIC. ` +
        `Set it in ${ENV_FILE} (copy .env.example) or export it in the environment.`
    );
  }
  return cfg;
}

// Alert bookkeeping only. The catalogue itself is in the database.
const EMPTY_STATE = { lastDailyDate: null, failure: null };
function loadState() {
  if (!existsSync(STATE_PATH)) return { ...EMPTY_STATE };
  try {
    return { ...EMPTY_STATE, ...JSON.parse(readFileSync(STATE_PATH, 'utf8')) };
  } catch {
    return { ...EMPTY_STATE };
  }
}
function saveState(s) {
  writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));
}

// Unix seconds of the next check: the regular interval (± jitter), or the next watch.wakeAt
// local time if that comes first. Uniqlo starts sales at 02:00 IST, so a check always lands
// just after it instead of up to intervalMinutes later.
function scheduleNext(nowMs, watch) {
  const jitter = (Math.random() * 2 - 1) * (watch.jitterSeconds || 0);
  let at = nowMs + (watch.intervalMinutes || 15) * 60_000 + jitter * 1000;
  for (const hhmm of watch.wakeAt || []) {
    const [h, m] = hhmm.split(':').map(Number);
    const wake = new Date(nowMs);
    wake.setHours(h, m, 0, 0);
    if (wake.getTime() <= nowMs) wake.setDate(wake.getDate() + 1);
    at = Math.min(at, wake.getTime());
  }
  return Math.round(at / 1000);
}

function writeNextRun(cfg) {
  const at = scheduleNext(Date.now(), cfg.watch);
  writeFileSync(NEXT_RUN_PATH, `${at}\n`);
  log(`next run at ${new Date(at * 1000).toISOString()}`);
}

// --- Uniqlo API ---------------------------------------------------------------
// The `result` of one API call, or a throw. `what` names the call in the error.
async function getResult(url, what) {
  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json', 'x-fr-clientid': 'uq.in.web-spa' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    if (e.name === 'TimeoutError') throw new Error(`${what} timed out after ${TIMEOUT_MS}ms`);
    throw e;
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`${what}: HTTP ${res.status}: ${text.slice(0, 200)}`);
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    throw new Error(`${what} is not JSON: ${text.slice(0, 200)}`);
  }
  if (j?.status !== 'ok' || !j.result) throw new Error(`${what}: unexpected response: ${text.slice(0, 200)}`);
  return j.result;
}

async function fetchPage(cfg, offset) {
  const what = `page at offset ${offset}`;
  const r = await getResult(`${API}?path=${encodeURIComponent(cfg.catalogue.path)}&limit=${PAGE_SIZE}&offset=${offset}`, what);
  if (!Array.isArray(r.items) || !Number.isInteger(r.pagination?.total))
    throw new Error(`${what}: unexpected response: ${JSON.stringify(r).slice(0, 200)}`);
  return r;
}

// One API item -> a listing. A listing is a product in one price group: the same productId
// shows up twice when some colours are on sale ("00" full price, "01" the sale colours), each
// with its own price and URL, so (productId, priceGroup) is the key everywhere.
function parseListing(it) {
  const base = it?.prices?.base?.value;
  const promo = it?.prices?.promo?.value ?? null;
  if (typeof it?.productId !== 'string' || typeof it?.priceGroup !== 'string' || typeof it?.name !== 'string')
    throw new Error(`item without productId/priceGroup/name: ${JSON.stringify(it).slice(0, 200)}`);
  if (!Number.isFinite(base) || (promo !== null && !Number.isFinite(promo)))
    throw new Error(`${it.productId}/${it.priceGroup}: price is not a number: ${JSON.stringify(it.prices)}`);
  const sale = it.representative?.flags?.priceFlags?.find((f) => f.code === 'discount')?.effectiveTime;
  const images = it.images?.main || {};
  return {
    key: `${it.productId}/${it.priceGroup}`,
    id: it.productId,
    group: it.priceGroup,
    name: it.name,
    gender: it.genderCategory ?? null,
    colour: it.representative?.color?.name?.toLowerCase() ?? null,
    base,
    promo,
    price: promo ?? base,
    saleStart: sale?.start || null,
    saleEnd: sale?.end || null,
    images: Object.fromEntries(Object.entries(images).map(([dc, img]) => [dc, img?.image])),
    image: (images[it.representativeColorDisplayCode] || Object.values(images)[0])?.image ?? null,
    url: `https://www.uniqlo.com/in/en/products/${it.productId}/${it.priceGroup}`,
  };
}

// Size and colour codes are the same across products (SMA004 is always M, COL38 always dark
// brown). An item's own sizes/colors list only what is in stock right now, and sometimes lags
// the stock API, so names come from every code the catalogue mentions instead.
function addNames(map, list) {
  for (const x of list || []) if (typeof x?.code === 'string' && typeof x?.name === 'string') map.set(x.code, x.name);
}

// The whole category, or an error. A partial catalogue would read as removed products,
// so every page must parse and the distinct listings must add up to the API's total.
async function fetchCatalogue(cfg) {
  const byKey = new Map();
  const names = { sizes: new Map(), colours: new Map() };
  let total = null;
  let offset = 0;
  for (let page = 0; total === null || offset < total; page++) {
    if (page >= 50) throw new Error(`still paging after 50 pages (offset ${offset}, total ${total})`);
    const r = await fetchPage(cfg, offset);
    if (total !== null && r.pagination.total !== total)
      throw new Error(`catalogue changed while paging (total ${total} -> ${r.pagination.total})`);
    total = r.pagination.total;
    if (!r.items.length && offset < total) throw new Error(`page at offset ${offset} is empty but total is ${total}`);
    addNames(names.sizes, r.aggregations?.sizes);
    addNames(names.colours, r.aggregations?.colors);
    for (const it of r.items) {
      const l = parseListing(it);
      byKey.set(l.key, l);
      addNames(names.sizes, it.sizes);
      addNames(names.colours, it.colors);
    }
    offset += r.items.length;
  }
  if (byKey.size !== total) throw new Error(`got ${byKey.size} distinct listings, API says ${total}`);
  return { listings: [...byKey.values()], names };
}

// One listing's SKUs (colour x size), each with its stock and price.
async function fetchSkus(l) {
  const what = `stock of ${l.key}`;
  const r = await getResult(
    `${API}/${l.id}/price-groups/${l.group}/l2s?withPrices=true&withStocks=true&includePreviousPrice=false&httpFailure=true`,
    what
  );
  if (!Array.isArray(r.l2s) || !r.stocks || !r.prices) throw new Error(`${what}: unexpected response: ${JSON.stringify(r).slice(0, 200)}`);
  return r.l2s.map((s) => {
    const p = r.prices[s?.l2Id];
    const stock = r.stocks[s?.l2Id];
    const sku = {
      colour: s?.color?.code,
      dc: s?.color?.displayCode,
      size: s?.size?.code,
      inStock: (stock?.statusCode === 'IN_STOCK' || stock?.statusCode === 'LOW_STOCK') && stock.quantity > 0,
      base: p?.base?.value,
      price: p?.promo ? p.promo.value : p?.base?.value,
    };
    if (typeof sku.colour !== 'string' || typeof sku.size !== 'string' || !Number.isFinite(sku.base) || !Number.isFinite(sku.price))
      throw new Error(`${what}: SKU without colour/size/price: ${JSON.stringify(s).slice(0, 200)}`);
    return sku;
  });
}

// The colours of one listing that are in stock in a wanted size: which sizes, and the price.
function buyableColours(skus, names, wanted) {
  const byColour = new Map();
  for (const s of skus) {
    const size = names.sizes.get(s.size);
    if (!s.inStock || !wanted.includes(size)) continue;
    let c = byColour.get(s.colour);
    if (!c) {
      const name = names.colours.get(s.colour)?.toLowerCase() ?? `colour ${s.dc}`;
      byColour.set(s.colour, (c = { code: s.colour, dc: s.dc, name, sizes: [], base: s.base, price: s.price }));
    }
    c.sizes.push(size);
    if (s.price < c.price) Object.assign(c, { base: s.base, price: s.price });
  }
  for (const c of byColour.values()) c.sizes.sort((a, b) => wanted.indexOf(a) - wanted.indexOf(b));
  return [...byColour.values()];
}

// buyable: listing key -> its buyable colours. A listing whose stock call failed is in `failed`
// instead, so the caller can leave it alone this check.
async function fetchStocks(listings, names, wanted) {
  const buyable = new Map();
  const failed = new Set();
  let next = 0;
  const worker = async () => {
    while (next < listings.length) {
      const l = listings[next++];
      try {
        buyable.set(l.key, buyableColours(await fetchSkus(l), names, wanted));
      } catch (e) {
        failed.add(l.key);
        log(`stock call failed for ${l.key}:`, e.message);
      }
    }
  };
  await Promise.all(Array.from({ length: STOCK_CONCURRENCY }, worker));
  return { buyable, failed };
}

// --- database -------------------------------------------------------------------
function openDb() {
  const db = new DatabaseSync(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS products (
      product_id TEXT NOT NULL,
      price_group TEXT NOT NULL,
      name TEXT NOT NULL,
      gender TEXT,
      base INTEGER NOT NULL,
      promo INTEGER,
      price INTEGER NOT NULL, -- promo ?? base: what you pay
      sale_start INTEGER,
      sale_end INTEGER,
      first_seen INTEGER NOT NULL,
      last_seen INTEGER NOT NULL,
      removed_at INTEGER,
      PRIMARY KEY (product_id, price_group)
    );
    CREATE TABLE IF NOT EXISTS price_history (
      product_id TEXT NOT NULL,
      price_group TEXT NOT NULL,
      at INTEGER NOT NULL,
      base INTEGER NOT NULL,
      promo INTEGER,
      price INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS price_history_at ON price_history (at);
    -- every (listing, colour, price) deal that was pushed: a colour going in and out of stock
    -- at the same price pushes once, a further price cut is a new row
    CREATE TABLE IF NOT EXISTS deal_alerts (
      product_id TEXT NOT NULL,
      price_group TEXT NOT NULL,
      color_code TEXT NOT NULL,
      price INTEGER NOT NULL,
      alerted_at INTEGER NOT NULL,
      PRIMARY KEY (product_id, price_group, color_code, price)
    );
  `);
  return db;
}

const keyOf = (r) => `${r.product_id}/${r.price_group}`;
const dealKey = (productId, group, colour, price) => `${productId}/${group}/${colour}/${price}`;
// user_version 0: deal_alerts has never been filled, so the next check records every current
// deal silently (one summary push) instead of pushing each one as urgent.
const DEALS_BASELINED = 1;

// Price events of a complete catalogue against the database. They only decide which listings
// count as deals and new products; the push itself needs stock (see dealEntries).
// A listing not live in the database that is cheaper than a live listing of the same product
// is a drop against that one: it is how a sale starts (a new "01" group for some colours).
// "new" is a product never seen in any price group; a known product in a new group is "regroup".
function diffCatalogue(rows, listings) {
  const byKey = new Map(rows.map((r) => [keyOf(r), r]));
  const knownIds = new Set(rows.map((r) => r.product_id));
  const liveFloor = new Map();
  for (const r of rows)
    if (r.removed_at === null) liveFloor.set(r.product_id, Math.min(r.price, liveFloor.get(r.product_id) ?? Infinity));

  const events = [];
  const pct = (old, now) => Math.round(((now - old) / old) * 100);
  for (const l of listings) {
    const row = byKey.get(l.key);
    if (row && row.removed_at === null) {
      if (l.price !== row.price) events.push({ kind: l.price < row.price ? 'drop' : 'rise', l, old: row.price, pct: pct(row.price, l.price) });
      continue;
    }
    const floor = liveFloor.get(l.id);
    if (floor !== undefined && l.price < floor) events.push({ kind: 'drop', l, old: floor, pct: pct(floor, l.price) });
    else events.push({ kind: row ? 'back' : knownIds.has(l.id) ? 'regroup' : 'new', l });
  }
  const seen = new Set(listings.map((l) => l.key));
  const removed = rows.filter((r) => r.removed_at === null && !seen.has(keyOf(r)));
  return { events, removed };
}

// One push line: listing `l` in buyable colour `c`, discounted against `from`.
const entry = (kind, l, c, from = c.price) => ({
  kind,
  l,
  c,
  from,
  pct: Math.round(((c.price - from) / from) * 100),
  key: dealKey(l.id, l.group, c.code, c.price),
});

// One entry per (listing, colour) buyable in a wanted size, for a listing that is on sale or
// dropped in price this check. `from` is the colour's base price on sale, or the old price for
// a drop off-sale.
function dealEntries(listings, events, buyable) {
  const dropFrom = new Map(events.filter((e) => e.kind === 'drop').map((e) => [e.l.key, e.old]));
  return listings
    .filter((l) => l.promo !== null || dropFrom.has(l.key))
    .flatMap((l) => (buyable.get(l.key) ?? []).map((c) => entry('deal', l, c, l.promo !== null ? c.base : dropFrom.get(l.key))));
}

// Upserts every listing, adds a price_history row for each new or changed price, marks the
// missing ones removed, and records the deals that were pushed. One transaction, so a crash
// leaves the previous check intact.
function saveCatalogue(db, rows, listings, removed, deals, at) {
  const byKey = new Map(rows.map((r) => [keyOf(r), r]));
  const upsert = db.prepare(`
    INSERT INTO products (product_id, price_group, name, gender, base, promo, price, sale_start, sale_end, first_seen, last_seen, removed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    ON CONFLICT (product_id, price_group) DO UPDATE SET
      name = excluded.name, gender = excluded.gender, base = excluded.base, promo = excluded.promo,
      price = excluded.price, sale_start = excluded.sale_start, sale_end = excluded.sale_end,
      last_seen = excluded.last_seen, removed_at = NULL`);
  const history = db.prepare('INSERT INTO price_history (product_id, price_group, at, base, promo, price) VALUES (?, ?, ?, ?, ?, ?)');
  const remove = db.prepare('UPDATE products SET removed_at = ? WHERE product_id = ? AND price_group = ?');
  const alerted = db.prepare('INSERT OR IGNORE INTO deal_alerts (product_id, price_group, color_code, price, alerted_at) VALUES (?, ?, ?, ?, ?)');
  db.exec('BEGIN');
  try {
    for (const l of listings) {
      upsert.run(l.id, l.group, l.name, l.gender, l.base, l.promo, l.price, l.saleStart, l.saleEnd, at, at);
      const row = byKey.get(l.key);
      if (!row || row.base !== l.base || row.promo !== l.promo || row.price !== l.price)
        history.run(l.id, l.group, at, l.base, l.promo, l.price);
    }
    for (const r of removed) remove.run(at, r.product_id, r.price_group);
    for (const e of deals) alerted.run(e.l.id, e.l.group, e.c.code, e.c.price, at);
    db.exec(`PRAGMA user_version = ${DEALS_BASELINED}`);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// Every price_history row after the first fill is a change or a new listing.
const CHANGES_SQL = `
  SELECT at, price - LAG(price) OVER (PARTITION BY product_id, price_group ORDER BY at, rowid) AS delta
  FROM price_history`;
const firstFill = (db) => db.prepare('SELECT MIN(at) AS at FROM price_history').get().at;

// --- the push -----------------------------------------------------------------------
const name = (l) => `${l.name}${l.colour ? ` (${l.colour})` : ''}`;
const day = (unixS) => new Date(unixS * 1000).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
const priceText = (e) => (e.from !== e.c.price ? `${rupees(e.from)} → ${rupees(e.c.price)} (${e.pct}%)` : rupees(e.c.price));
const saleSince = (l) =>
  l.promo !== null && l.saleStart && Date.now() / 1000 - l.saleStart > OLD_SALE_S ? ` · on sale since ${day(l.saleStart)}` : '';
const dealLine = (e) => `${e.l.name} (${e.c.name}) ${priceText(e)} · ${e.c.sizes.join(' ')}${saleSince(e.l)}`;

// Strongest first: the first kind present sets the title and priority. `sale` is only the
// one-time summary of the deals that already existed when deal tracking started.
const KINDS = {
  deal: {
    priority: 'urgent',
    tags: 'chart_with_downwards_trend,rotating_light',
    title: (n, e, c) => (n === 1 ? `Uniqlo: ${e.l.name} ${e.pct}%` : `Uniqlo: ${n} ${c.label} deals in ${c.sizes}`),
    line: (e) => `📉 ${dealLine(e)}`,
  },
  new: {
    priority: 'high',
    tags: 'new',
    title: (n, e, c) => (n === 1 ? `Uniqlo new: ${e.l.name}` : `Uniqlo: ${n} new ${c.label} items in ${c.sizes}`),
    line: (e) => `🆕 ${e.l.name} (${e.c.name}) ${rupees(e.c.price)} · ${e.c.sizes.join(' ')}`,
  },
  sale: {
    priority: 'default',
    tags: 'label',
    title: (n, e, c) => `Uniqlo: ${n} ${c.label} sale items in ${c.sizes} right now`,
    line: (e) => `🏷️ ${dealLine(e)}`,
  },
};
const KIND_ORDER = Object.keys(KINDS);
const byStrength = (a, b) =>
  KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
  (a.kind === 'new' ? 0 : a.pct - b.pct) ||
  a.l.name.localeCompare(b.l.name);

const entryUrl = (e) => `${e.l.url}?colorDisplayCode=${e.c.dc}`;

// The combined push for sorted entries: every entry that fits in ntfy's body limit, then
// "…and N more". Tapping opens the lead entry's colour; its photo is attached.
function buildAlert(entries, cfg) {
  const lead = entries[0];
  const kind = KINDS[lead.kind];
  const texts = entries.map((e) => `${KINDS[e.kind].line(e)}\n${entryUrl(e)}`);
  let message = '';
  let shown = 0;
  for (const text of texts) {
    const next = message ? `${message}\n\n${text}` : text;
    const rest = texts.length - shown - 1;
    if (Buffer.byteLength(next + (rest ? `\n\n…and ${rest} more` : '')) > BODY_LIMIT) break;
    message = next;
    shown++;
  }
  if (shown < texts.length) message += `\n\n…and ${texts.length - shown} more`;
  const context = { label: cfg.catalogue.label, sizes: cfg.sizes.join('/') };
  return {
    title: kind.title(entries.filter((e) => e.kind === lead.kind).length, lead, context),
    message,
    priority: kind.priority,
    tags: kind.tags,
    click: entryUrl(lead),
    attach: lead.l.images[lead.c.dc] ?? lead.l.image,
  };
}

// --- ntfy notification ------------------------------------------------------
async function notify(cfg, { title, message, priority, tags, click, attach }) {
  if (cfg.notify.type !== 'ntfy') {
    log('NOTIFY (no channel):', title, '-', message);
    return;
  }
  const url = `${cfg.notify.server.replace(/\/$/, '')}/${cfg.notify.topic}`;
  // HTTP header values must be Latin-1; strip non-ASCII (e.g. emoji) from the title.
  // Emoji still render fine via the message body and the Tags header (emoji shortcodes).
  const asciiTitle = String(title).replace(/[^\x00-\xFF]/g, '').trim() || 'Uniqlo notifier';
  const headers = {
    Title: asciiTitle,
    Priority: priority || cfg.notify.priority || 'default',
  };
  if (tags) headers.Tags = tags;
  if (click) headers.Click = click;
  if (attach) headers.Attach = attach;
  const res = await fetch(url, { method: 'POST', headers, body: message });
  if (!res.ok) throw new Error(`ntfy push failed: HTTP ${res.status} ${await res.text()}`);
  log('ntfy push sent ->', cfg.notify.topic);
}

// --- daily check-in: the once-a-day status AND the proof-of-life -------------
// Sends exactly one push per day, at/after notify.dailyHour (local time — set TZ in
// the container). If you ever STOP getting it, the tracker is dead.
async function maybeDailySummary(cfg, db, state, now, buyableSale) {
  const hour = cfg.notify.dailyHour;
  if (hour === undefined || hour === null || hour < 0) return; // disabled
  const d = new Date(now);
  if (d.getHours() < hour) return; // not time yet today
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  if (state.lastDailyDate === today) return; // already sent today

  const since = Math.floor(now / 1000) - 86_400;
  const live = db.prepare('SELECT COUNT(*) AS n, COUNT(promo) AS sale FROM products WHERE removed_at IS NULL').get();
  const moves = db.prepare(`SELECT SUM(delta < 0) AS drops, SUM(delta > 0) AS rises FROM (${CHANGES_SQL}) WHERE at >= ?`).get(since);
  const fresh = db.prepare('SELECT COUNT(*) AS n FROM products WHERE first_seen >= ? AND first_seen > ?').get(since, firstFill(db));
  const deals = db.prepare('SELECT COUNT(*) AS n FROM deal_alerts WHERE alerted_at >= ?').get(since);
  try {
    await notify(cfg, {
      title: '👕 Uniqlo daily check-in',
      message:
        `${live.n} ${cfg.catalogue.label} listings tracked, ${live.sale} on sale, ${buyableSale} of them in stock in ${cfg.sizes.join('/')}.\n` +
        `Last 24 h: deals pushed ${deals.n}, price drops ${moves.drops ?? 0}, rises ${moves.rises ?? 0}, new listings ${fresh.n}.`,
      priority: 'min',
      tags: 'shirt,calendar',
    });
    state.lastDailyDate = today; // caller persists state at the end of the cycle
  } catch (e) {
    log('daily summary push failed:', e.message);
  }
}

// Silence is ambiguous (no price changes vs. tracker broken), so if checks keep failing
// for a while, say so once. Reset on the next good check.
async function trackFailure(cfg, state, err) {
  const now = Date.now();
  if (!err) {
    if (state.failure) log(`recovered after failing since ${new Date(state.failure.since).toISOString()}`);
    state.failure = null;
    return;
  }
  const f = (state.failure ??= { since: now, alerted: false });
  const hours = cfg.notify.failureAlertHours ?? 6;
  if (f.alerted || now - f.since < hours * 3_600_000) return;
  try {
    await notify(cfg, {
      title: '⚠️ Uniqlo tracker failing',
      message:
        `Checks have failed for ${Math.round((now - f.since) / 3_600_000)}h.\nLast error: ${err}\n` +
        'Prices are not being watched meanwhile.',
      priority: 'default',
      tags: 'warning',
    });
    f.alerted = true;
  } catch (e) {
    log('failure alert push failed:', e.message);
  }
}

// --- one full cycle: check, diff against the database, stock, alert, save ----------
// The complete catalogue, or a throw. `known` is how many listings the last good check had.
async function check(cfg, known, acceptShrink) {
  const t0 = Date.now();
  const catalogue = await fetchCatalogue(cfg);
  const { listings } = catalogue;
  log(
    `catalogue: ${listings.length} ${cfg.catalogue.label} listings, ${listings.filter((l) => l.promo !== null).length} on sale ` +
      `(${((Date.now() - t0) / 1000).toFixed(1)}s)`
  );
  if (known && listings.length < known * MIN_SHARE && !acceptShrink)
    throw new Error(
      `catalogue has ${listings.length} listings, the last good check had ${known} (< ${MIN_SHARE * 100}%). ` +
        'If it really shrank, run once with --accept-shrink'
    );
  return catalogue;
}

async function runOnce(cfg, db, acceptShrink) {
  const state = loadState();
  const rows = db.prepare('SELECT * FROM products').all();
  const known = rows.filter((r) => r.removed_at === null).length;
  const baseline = db.prepare('PRAGMA user_version').get().user_version < DEALS_BASELINED;
  let catalogue;
  // small retry: a page timing out or the catalogue changing mid-paging clears on a re-read
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      catalogue = await check(cfg, known, acceptShrink);
      break;
    } catch (e) {
      log(`check attempt ${attempt} failed:`, e.message);
      if (attempt === 2) {
        log('giving up this cycle (database unchanged, no alert)');
        process.exitCode = CHECK_FAILED;
        await trackFailure(cfg, state, e.message);
        saveState(state);
        return;
      }
      await sleep(5000);
    }
  }
  const { listings, names } = catalogue;

  const now = Date.now();
  const { events, removed } = diffCatalogue(rows, listings);
  if (!rows.length) {
    log(`first check: storing ${listings.length} listings`);
  } else {
    for (const e of events)
      log(`${e.kind}: ${e.l.key} ${name(e.l)} ${e.old !== undefined ? `${e.old} -> ` : ''}${e.l.price}${e.pct !== undefined ? ` (${e.pct}%)` : ''}`);
    for (const r of removed) log(`removed: ${keyOf(r)} ${r.name} ${r.price}`);
    if (!events.length && !removed.length) log('no changes');
  }

  // Only stock in a wanted size makes a push: sale and dropped listings can be deals, and new
  // products are pushed if they are in stock (except on the baseline check, which pushes
  // nothing but the summary).
  const flagged = new Set(events.filter((e) => e.kind === 'drop' || (e.kind === 'new' && !baseline)).map((e) => e.l.key));
  const targets = listings.filter((l) => l.promo !== null || flagged.has(l.key));
  const t0 = Date.now();
  const { buyable, failed } = await fetchStocks(targets, names, cfg.sizes);
  log(`stock: ${targets.length} listings checked, ${failed.size} failed (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  if (failed.size > targets.length / 2) {
    const msg = `${failed.size} of ${targets.length} stock calls failed`;
    log(`${msg}, giving up this cycle (database unchanged, no alert)`);
    process.exitCode = CHECK_FAILED;
    await trackFailure(cfg, state, msg);
    saveState(state);
    return;
  }
  await trackFailure(cfg, state, null);

  const deals = dealEntries(listings, events, buyable);
  let push;
  let record;
  if (baseline) {
    log(`deal tracking starts: recording the ${deals.length} deals in stock now, one summary push`);
    push = deals.map((e) => ({ ...e, kind: 'sale' }));
    record = deals;
  } else {
    const alerted = new Set(
      db.prepare('SELECT * FROM deal_alerts').all().map((r) => dealKey(r.product_id, r.price_group, r.color_code, r.price))
    );
    record = deals.filter((e) => !alerted.has(e.key));
    const fresh = events
      .filter((e) => e.kind === 'new' && e.l.promo === null)
      .flatMap((e) => (buyable.get(e.l.key) ?? []).map((c) => entry('new', e.l, c)));
    push = [...record, ...fresh];
  }
  push.sort(byStrength);
  if (push.length) {
    if (!baseline) for (const e of push) log(`push ${KINDS[e.kind].line(e)}`);
    try {
      await notify(cfg, buildAlert(push, cfg));
    } catch (e) {
      // Don't advance the database or record the deals, otherwise they are swallowed. Retry next cycle.
      log('alert push failed, keeping old baseline so it re-fires:', e.message);
      process.exitCode = CHECK_FAILED;
      saveState(state);
      return;
    }
  }

  // A listing whose stock call failed keeps its old row, so a drop or a new product is seen
  // again next check instead of being stored without a look at its stock.
  saveCatalogue(db, rows, listings.filter((l) => !failed.has(l.key)), removed, record, Math.floor(now / 1000));
  const buyableSale = listings.filter((l) => l.promo !== null && buyable.get(l.key)?.length).length;
  await maybeDailySummary(cfg, db, state, now, buyableSale);
  state.checkedAt = new Date().toISOString();
  saveState(state);
}

// Changes per local weekday and hour, to confirm when Uniqlo updates prices.
function printStats(db) {
  const first = firstFill(db);
  const ats = db.prepare(`SELECT at FROM price_history WHERE at > ?`).all(first ?? 0).map((r) => r.at);
  const span = first ? `${new Date(first * 1000).toString()} to now` : 'nothing yet';
  console.log(`${ats.length} price changes and new listings since the first check (${span})\n`);
  if (!ats.length) return;
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const byDay = new Array(7).fill(0);
  const byHour = new Array(24).fill(0);
  for (const at of ats) {
    const d = new Date(at * 1000);
    byDay[d.getDay()]++;
    byHour[d.getHours()]++;
  }
  const max = Math.max(...byDay, ...byHour);
  const bar = (n) => '#'.repeat(Math.ceil((n / max) * 40));
  console.log(`by weekday (${Intl.DateTimeFormat().resolvedOptions().timeZone}):`);
  byDay.forEach((n, i) => console.log(`  ${days[i]}  ${String(n).padStart(5)} ${bar(n)}`));
  console.log('\nby hour of day:');
  byHour.forEach((n, h) => console.log(`  ${String(h).padStart(2, '0')}:00 ${String(n).padStart(5)} ${bar(n)}`));
}

// The live catalogue and the wanted-size stock of every sale listing, for --dump and --deals.
async function liveSale(cfg) {
  const { listings, names } = await fetchCatalogue(cfg);
  const sale = listings.filter((l) => l.promo !== null);
  const t0 = Date.now();
  const { buyable, failed } = await fetchStocks(sale, names, cfg.sizes);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`${listings.length} ${cfg.catalogue.label} listings, ${sale.length} on sale (${sale.length} stock calls in ${secs}s, ${failed.size} failed)`);
  return { listings, buyable, failed };
}

// --- entrypoints ------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2);
  const readOnly = ['--dump', '--deals', '--stats'].some((a) => args.includes(a));
  const cfg = loadConfig({ needTopic: !readOnly });
  const sizes = cfg.sizes.join('/');

  if (args.includes('--dump')) {
    const { listings, buyable, failed } = await liveSale(cfg);
    console.log('listing          gender   price    base     name (colour)');
    for (const l of listings.sort((a, b) => (b.promo !== null) - (a.promo !== null) || a.name.localeCompare(b.name))) {
      console.log(
        `${l.key.padEnd(16)} ${String(l.gender).padEnd(8)} ${String(l.price).padEnd(8)} ${l.promo !== null ? String(l.base).padEnd(8) : '-       '} ${name(l)}`
      );
      if (l.promo === null) continue;
      const pad = ' '.repeat(17);
      if (failed.has(l.key)) console.log(`${pad}stock call failed`);
      else if (!buyable.get(l.key).length) console.log(`${pad}no ${sizes} in stock`);
      else for (const c of buyable.get(l.key)) console.log(`${pad}${c.name} ${rupees(c.price)}: ${c.sizes.join(' ')}`);
    }
    return;
  }

  if (args.includes('--deals')) {
    const { listings, buyable } = await liveSale(cfg);
    const deals = dealEntries(listings, [], buyable).sort(byStrength);
    console.log(`${deals.length} sale colours in stock in ${sizes}, biggest discount first:\n`);
    for (const e of deals) console.log(`${KINDS.deal.line(e)}\n  ${entryUrl(e)}`);
    return;
  }

  if (args.includes('--stats')) {
    const db = openDb();
    try {
      printStats(db);
    } finally {
      db.close();
    }
    return;
  }

  if (args.includes('--test-notify')) {
    await notify(cfg, {
      title: '✅ Uniqlo notifier test',
      message: `If you see this on your phone, ntfy is wired up correctly.\nWatching Uniqlo India ${cfg.catalogue.label} prices.`,
      priority: 'default',
      tags: 'test_tube,shirt',
    });
    return;
  }

  // default / --once: a single check. run-loop.sh sleeps until the time in next-run,
  // which is written even when the check throws so the loop never spins.
  try {
    const db = openDb();
    try {
      await runOnce(cfg, db, args.includes('--accept-shrink'));
    } finally {
      db.close();
    }
  } finally {
    writeNextRun(cfg);
  }
}

main().catch((e) => {
  log('FATAL:', e.stack || e.message);
  process.exit(1);
});
