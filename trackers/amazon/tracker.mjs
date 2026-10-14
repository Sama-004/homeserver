#!/usr/bin/env node
// Amazon.in stock watcher -> ntfy push the moment a watched product (the Kobo Clara BW
// eReader) comes back in stock. It sells in small batches, so the alert is urgent.
// Usage:
//   node tracker.mjs [--once]        run a single check, write the next-run file, exit
//   node tracker.mjs --test-notify   send a test ntfy push and exit
//   node tracker.mjs --dump          print every product record on the watched store pages
//
// How the data works: the product page (/dp/<asin>) is useless while an item has no offer,
// because Amazon then serves a different product there (for the Clara BW, its SleepCover).
// The brand's Amazon store page instead embeds one JSON record per product,
// {"asin":"…","buyingOptions":[{"availability":{"type":"OUT_OF_STOCK",…},"price":…}],…},
// in the server-rendered HTML. One plain GET per store page, no cookies, no browser.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { setDefaultAutoSelectFamilyAttemptTimeout } from 'node:net';

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

const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadConfig({ needTopic = true } = {}) {
  const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  // env overrides for containers / secrets
  if (process.env.NTFY_TOPIC) cfg.notify.topic = process.env.NTFY_TOPIC;
  if (process.env.NTFY_SERVER) cfg.notify.server = process.env.NTFY_SERVER;

  if (!cfg.products?.length) throw new Error('config.json: products is empty');
  for (const p of cfg.products)
    if (!p.asin || !p.name || !p.storePage) throw new Error(`config.json: product needs asin, name, storePage: ${JSON.stringify(p)}`);

  // This must come from .env (or the environment); it is deliberately blank in config.json.
  if (needTopic && !cfg.notify.topic) {
    throw new Error(
      `Missing required secret: NTFY_TOPIC. ` +
        `Set it in ${ENV_FILE} (copy .env.example) or export it in the environment.`
    );
  }
  return cfg;
}

// products: asin -> { name, type } as last seen, where type is Amazon's raw availability
// type (IN_STOCK, OUT_OF_STOCK, ...). null until the first successful check.
const EMPTY_STATE = { products: null, lastAlertAt: 0, lastDailyDate: null, failure: null };
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

function writeNextRun(cfg) {
  const jitter = (Math.random() * 2 - 1) * (cfg.watch.jitterSeconds || 0);
  const at = Math.round(Date.now() / 1000 + (cfg.watch.intervalMinutes || 5) * 60 + jitter);
  writeFileSync(NEXT_RUN_PATH, `${at}\n`);
  log(`next run at ${new Date(at * 1000).toISOString()}`);
}

// --- Amazon store pages -------------------------------------------------------
const ROBOT_CHECK = /captcha|Robot Check|api-services-support@amazon\.com/i;
const ROBOT_ERROR = 'Amazon served a robot check';

async function fetchPage(url) {
  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'en-IN,en;q=0.9', Accept: 'text/html' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    if (e.name === 'TimeoutError') throw new Error(`${url} timed out after ${TIMEOUT_MS}ms`);
    throw e;
  }
  const html = await res.text();
  if (res.status === 503) throw new Error(`${ROBOT_ERROR} (HTTP 503)`);
  if (!res.ok) throw new Error(`${url} returned HTTP ${res.status}: ${html.slice(0, 200)}`);
  return html;
}

// Index just past the `}` that closes the JSON object opening at html[start].
function objectEnd(html, start) {
  let depth = 0;
  let inString = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i + 1;
  }
  return -1;
}

// The product's record on a store page -> { type, message, price, url }.
// Throws rather than guess: a missing record never means "out of stock".
function parseOffer(html, asin, pageUrl) {
  const key = `"asin":"${asin}","buyingOptions"`;
  const at = html.indexOf(key);
  if (at < 0) {
    // Only a page without the record is checked for a robot check, so a stray "captcha"
    // in a normal page's scripts can't break a working check.
    if (ROBOT_CHECK.test(html)) throw new Error(ROBOT_ERROR);
    throw new Error(
      `record for ${asin} missing (${html.length} bytes): Kobo may have rearranged the store page; ` +
        `find the product's store page and update storePage`
    );
  }
  const start = html.lastIndexOf('{', at);
  const end = objectEnd(html, start);
  let rec;
  try {
    rec = JSON.parse(html.slice(start, end));
  } catch {}
  if (rec?.asin !== asin) throw new Error(`record for ${asin} isn't a JSON object starting at "asin": the page format changed`);

  // In stock if any buying option is. Out of stock, `price` is a string (an API path), not an object.
  const options = (rec.buyingOptions || []).filter((o) => typeof o?.availability?.type === 'string');
  const opt = options.find((o) => o.availability.type === 'IN_STOCK') || options[0];
  if (!opt) throw new Error(`record for ${asin} has no availability: the record format changed`);
  const price = typeof opt.price === 'object' ? opt.price?.priceToPay?.moneyValueOrRange?.value?.displayString : null;
  return {
    type: opt.availability.type,
    message: opt.availability.primaryMessage || '',
    price: price || null,
    url: new URL(rec.detailPageLinkURL || `/dp/${asin}`, pageUrl).href,
  };
}

// Every watched product with its current offer. Products sharing a store page share one fetch.
async function fetchOffers(cfg) {
  const pages = new Map();
  for (const p of cfg.products) pages.set(p.storePage, [...(pages.get(p.storePage) || []), p]);
  const offers = [];
  for (const [page, products] of pages) {
    const html = await fetchPage(page);
    for (const p of products) offers.push({ ...p, ...parseOffer(html, p.asin, page) });
  }
  return offers;
}

const inStock = (o) => o.type === 'IN_STOCK';
// Not in stock but not plainly out of stock either: a pre-order or a type Amazon added since.
const unusual = (o) => o.type !== 'IN_STOCK' && o.type !== 'OUT_OF_STOCK';

const describe = (o) =>
  `${o.name}\n  ${inStock(o) ? [o.price, o.message].filter(Boolean).join(', ') : `${o.message} (${o.type})`}\n  ${o.url}`;

// --- ntfy notification ------------------------------------------------------
async function notify(cfg, { title, message, priority, tags, click }) {
  if (cfg.notify.type !== 'ntfy') {
    log('NOTIFY (no channel):', title, '-', message);
    return;
  }
  const url = `${cfg.notify.server.replace(/\/$/, '')}/${cfg.notify.topic}`;
  // HTTP header values must be Latin-1; strip non-ASCII (e.g. emoji) from the title.
  // Emoji still render fine via the message body and the Tags header (emoji shortcodes).
  const asciiTitle = String(title).replace(/[^\x00-\xFF]/g, '').trim() || 'Amazon notifier';
  const headers = {
    Title: asciiTitle,
    Priority: priority || cfg.notify.priority || 'default',
  };
  if (tags) headers.Tags = tags;
  if (click) headers.Click = click;
  const res = await fetch(url, { method: 'POST', headers, body: message });
  if (!res.ok) throw new Error(`ntfy push failed: HTTP ${res.status} ${await res.text()}`);
  log('ntfy push sent ->', cfg.notify.topic);
}

// --- daily check-in: the once-a-day status AND the proof-of-life -------------
// Sends exactly one push per day, at/after notify.dailyHour (local time — set TZ in
// the container). If you ever STOP getting it, the tracker is dead.
async function maybeDailySummary(cfg, offers, state, now) {
  const hour = cfg.notify.dailyHour;
  if (hour === undefined || hour === null || hour < 0) return; // disabled
  const d = new Date(now);
  if (d.getHours() < hour) return; // not time yet today
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  if (state.lastDailyDate === today) return; // already sent today

  const lines = offers.map((o) => `${inStock(o) ? '✅' : '❌'} ${o.name}: ${o.message}${o.price ? ` ${o.price}` : ''}`);
  try {
    await notify(cfg, {
      title: '📚 Amazon daily check-in',
      message: lines.join('\n'),
      priority: 'min',
      tags: 'books,calendar',
      click: cfg.products[0].storePage,
    });
    state.lastDailyDate = today; // caller persists state at the end of the cycle
  } catch (e) {
    log('daily summary push failed:', e.message);
  }
}

// Silence is ambiguous (nothing in stock vs. tracker broken), so if checks keep failing
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
      title: '⚠️ Amazon tracker failing',
      message:
        `Checks have failed for ${Math.round((now - f.since) / 3_600_000)}h.\nLast error: ${err}\n` +
        'Check the Amazon store page manually meanwhile.',
      priority: 'default',
      tags: 'warning',
      click: cfg.products[0].storePage,
    });
    f.alerted = true;
  } catch (e) {
    log('failure alert push failed:', e.message);
  }
}

// --- one full cycle: check, diff against state, alert -----------------------
async function runOnce(cfg) {
  const state = loadState();
  let offers;
  // small retry: a one-off robot check or network hiccup often clears on the next request
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      offers = await fetchOffers(cfg);
      break;
    } catch (e) {
      log(`check attempt ${attempt} failed:`, e.message);
      if (attempt === 2) {
        log('giving up this cycle (state unchanged, no alert)');
        await trackFailure(cfg, state, e.message);
        saveState(state);
        return;
      }
      await sleep(5000);
    }
  }
  await trackFailure(cfg, state, null);

  const now = Date.now();
  const firstEver = !state.products;
  const prev = state.products || {};
  const stocked = offers.filter(inStock);
  const back = stocked.filter((o) => prev[o.asin]?.type !== 'IN_STOCK');
  const changedUnusual = offers.filter((o) => unusual(o) && prev[o.asin]?.type !== o.type);
  const gone = offers.filter((o) => !inStock(o) && prev[o.asin]?.type === 'IN_STOCK');

  for (const o of offers)
    log(
      `${o.name} (${o.asin}): ${o.type} "${o.message}"${o.price ? ` ${o.price}` : ''}` +
        `${back.includes(o) || changedUnusual.includes(o) ? ' (NEW)' : ''}${firstEver ? ' (first check)' : ''}`
    );
  for (const o of gone) log(`  went out of stock: ${o.name}`);

  const remindMs = (cfg.notify.remindEveryMinutes ?? 15) * 60_000;
  const remindDue = !back.length && stocked.length && now - (state.lastAlertAt || 0) >= remindMs;
  if (back.length || changedUnusual.length || remindDue) {
    const shown = [...stocked, ...changedUnusual];
    const lead = back[0] || changedUnusual[0] || stocked[0];
    const subject = shown.length > 1 ? `${shown.length} watched items` : lead.name;
    const title = back.length
      ? `${subject} in stock on Amazon`
      : stocked.length
        ? `${subject} still in stock on Amazon`
        : `${subject} on Amazon: ${lead.message || lead.type}`;
    const message =
      shown.map((o) => `${back.includes(o) || changedUnusual.includes(o) ? '🆕 ' : ''}${describe(o)}`).join('\n\n') +
      (stocked.length ? '\n\nLimited stock: buy now.' : '');
    try {
      await notify(cfg, {
        title,
        message,
        priority: back.length ? 'urgent' : 'high',
        tags: back.length ? 'books,rotating_light' : 'books',
        click: lead.url,
      });
      state.lastAlertAt = now;
    } catch (e) {
      // Don't advance the baseline — otherwise the restock is swallowed. Retry next cycle.
      log('alert push failed, keeping old baseline so it re-fires:', e.message);
      saveState(state);
      return;
    }
  }

  await maybeDailySummary(cfg, offers, state, now);

  state.products = Object.fromEntries(offers.map((o) => [o.asin, { name: o.name, type: o.type }]));
  state.checkedAt = new Date().toISOString();
  saveState(state);
}

// --- entrypoints ------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2);
  const cfg = loadConfig({ needTopic: !args.includes('--dump') });

  if (args.includes('--dump')) {
    const watched = new Set(cfg.products.map((p) => p.asin));
    for (const page of new Set(cfg.products.map((p) => p.storePage))) {
      const html = await fetchPage(page);
      const asins = [...new Set([...html.matchAll(/"asin":"([A-Z0-9]{10})","buyingOptions"/g)].map((m) => m[1]))];
      console.log(`${page}\n  ${html.length} bytes, ${asins.length} product records`);
      console.log('  watched  asin        type           price         message');
      for (const asin of [...new Set([...asins, ...cfg.products.filter((p) => p.storePage === page).map((p) => p.asin)])]) {
        let line;
        try {
          const o = parseOffer(html, asin, page);
          line = `${o.type.padEnd(14)} ${String(o.price ?? '-').padEnd(13)} ${o.message}\n${' '.repeat(23)}${o.url}`;
        } catch (e) {
          line = `error: ${e.message}`;
        }
        console.log(`  ${watched.has(asin) ? ' 👀    ' : '       '}  ${asin}  ${line}`);
      }
    }
    return;
  }

  if (args.includes('--test-notify')) {
    await notify(cfg, {
      title: '✅ Amazon notifier test',
      message:
        `If you see this on your phone, ntfy is wired up correctly.\n` +
        `Watching ${cfg.products.map((p) => `${p.name} (${p.asin})`).join(', ')} on Amazon.in.`,
      priority: 'default',
      tags: 'test_tube,books',
      click: cfg.products[0].storePage,
    });
    return;
  }

  // default / --once: a single check. run-loop.sh sleeps until the time in next-run,
  // which is written even when the check throws so the loop never spins.
  try {
    await runOnce(cfg);
  } finally {
    writeNextRun(cfg);
  }
}

main().catch((e) => {
  log('FATAL:', e.stack || e.message);
  process.exit(1);
});
