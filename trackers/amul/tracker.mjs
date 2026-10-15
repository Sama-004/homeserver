#!/usr/bin/env node
// Amul protein stock watcher -> ntfy push when whey protein / high-protein drinks come back
// in stock on shop.amul.com for one pincode.
// Usage:
//   node tracker.mjs [--once]        run a single check, write the next-run file, exit
//   node tracker.mjs --test-notify   send a test ntfy push and exit
//   node tracker.mjs --dump          print every protein product and which ones are watched
//
// How the data works: shop.amul.com is a Vue SPA over a JSON API (/api/1/entity/...).
// Stock is per pincode: each pincode maps to a "substore" (700032 -> west-bengal), and the
// session's store preference decides which substore's `available` flag the product list
// carries. Every API call needs the session cookie from the HTML page plus a `tid` header
// signed with sha256(storeId:ts:random:sessionTid), the same thing the site's own JS
// computes. All of that is plain fetch + node:crypto, so there is no browser here.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
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
// Exit code of a check that failed without crashing (a crash exits 1). run-loop.sh pings the
// healthchecks.io dead-man's switch only after exit 0, so a tracker that keeps failing is reported.
const CHECK_FAILED = 3;

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

const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadConfig({ needTopic = true } = {}) {
  const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  // env overrides for containers / secrets
  if (process.env.NTFY_TOPIC) cfg.notify.topic = process.env.NTFY_TOPIC;
  if (process.env.NTFY_SERVER) cfg.notify.server = process.env.NTFY_SERVER;

  // This must come from .env (or the environment); it is deliberately blank in config.json.
  if (needTopic && !cfg.notify.topic) {
    throw new Error(
      `Missing required secret: NTFY_TOPIC. ` +
        `Set it in ${ENV_FILE} (copy .env.example) or export it in the environment.`
    );
  }
  return cfg;
}

// products: alias -> { name, available } for the watched products as last seen.
// null until the first successful check.
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

// --- the Amul API ------------------------------------------------------------
const PRODUCT_FIELDS = ['name', 'alias', 'sku', 'price', 'available', 'inventory_quantity', 'net_quantity'];

async function fetchProducts(cfg) {
  const { baseUrl, browsePath, storeId, category } = cfg.site;
  const timeoutMs = cfg.site.timeoutMs || 30000;
  const pageUrl = baseUrl + browsePath;
  const jar = new Map();

  async function request(path, { method = 'GET', headers = {}, body } = {}) {
    let res;
    try {
      res = await fetch(baseUrl + path, {
        method,
        headers: {
          'User-Agent': UA,
          Referer: pageUrl,
          Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
          ...headers,
        },
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      if (e.name === 'TimeoutError') throw new Error(`${path} timed out after ${timeoutMs}ms`);
      throw e;
    }
    for (const c of res.headers.getSetCookie()) {
      const kv = c.split(';')[0];
      const i = kv.indexOf('=');
      if (i > 0) jar.set(kv.slice(0, i).trim(), kv.slice(i + 1));
    }
    const text = await res.text();
    if (res.ok) return text;
    // In Oct 2026 a missing/malformed/stale tid got 401 and the hash itself was not checked,
    // so either code can mean the signing scheme or storeId changed.
    const hint =
      path.startsWith('/api/') && (res.status === 401 || res.status === 503)
        ? ` (session cookie or signed tid header refused; if it persists, the signing scheme or` +
          ` site.storeId may have changed: find "storeId" in ${baseUrl}/ms/store/amul/auto/EN/storeinfo.js)`
        : '';
    throw new Error(`${method} ${path.split('?')[0]} returned HTTP ${res.status}${hint}: ${text.slice(0, 200)}`);
  }

  const html = await request(browsePath);
  const ts0 = /serverTimestamp\s*=\s*"(\d+)"/.exec(html);
  if (!ts0) throw new Error(`${pageUrl} has no serverTimestamp (${html.length} bytes): the site changed`);
  const serverTs = Number(ts0[1]);
  const t0 = Date.now();

  const info = await request(`/user/info.js?_v=${serverTs}`);
  const sessionTid = /"tid":"([^"]+)"/.exec(info)?.[1];
  if (!sessionTid) throw new Error(`/user/info.js has no session tid: ${info.slice(0, 200)}`);

  const sign = () => {
    const ts = serverTs + (Date.now() - t0);
    const r = Math.floor(Math.random() * 1000);
    const hash = createHash('sha256').update(`${storeId}:${ts}:${r}:${sessionTid}`).digest('hex');
    return `${ts}:${r}:${hash}`;
  };
  // Every /api/1 response is {data, messages}; return data.
  const api = async (path, { headers = {}, ...opts } = {}) => {
    const text = await request(`/api/1/entity/${path}`, {
      ...opts,
      headers: { Accept: 'application/json', frontend: '1', base_url: pageUrl, tid: sign(), ...headers },
    });
    try {
      return JSON.parse(text).data;
    } catch {
      throw new Error(`/api/1/entity/${path.split('?')[0]} returned non-JSON: ${text.slice(0, 200)}`);
    }
  };

  const pincode = String(cfg.location.pincode);
  const pinQuery = new URLSearchParams({
    limit: '50',
    filters: JSON.stringify([{ field: 'pincode', value: pincode, operator: 'regex', use_autocomplete: 1 }]),
    new_search: '1',
  });
  const pins = await api(`pincode?${pinQuery}`);
  if (!Array.isArray(pins)) throw new Error(`unexpected pincode response: ${JSON.stringify(pins)?.slice(0, 200)}`);
  // The lookup is a prefix regex, so 70003 would also return 700031..700039.
  const substore = pins.find((p) => String(p.pincode) === pincode)?.substore;
  // Fail SAFE: an unknown pincode means the lookup broke or Amul stopped delivering there,
  // not that everything is out of stock.
  if (!substore) throw new Error(`pincode ${pincode} not found among ${pins.length} pincode records`);

  const prefs = await api('ms.settings/_/setPreferences', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: { store: substore } }),
  });
  if (!/updated successfully/i.test(String(prefs)))
    throw new Error(`setPreferences(${substore}) said: ${JSON.stringify(prefs)?.slice(0, 200)}`);

  const q = new URLSearchParams({ q: '{}', limit: '100', start: '0', total: '1' });
  q.append('filters[0][field]', 'categories');
  q.append('filters[0][value][0]', category);
  q.append('filters[0][operator]', 'in');
  for (const f of PRODUCT_FIELDS) q.append(`fields[${f}]`, '1');
  const list = await api(`ms.products?${q}`);
  if (!Array.isArray(list) || !list.length)
    throw new Error(`unexpected products response: ${JSON.stringify(list)?.slice(0, 200)}`);

  return {
    substore,
    // The site shows SOLD OUT exactly when !product.available; inventory_quantity can be
    // non-zero on a sold-out product, so it is informational only.
    products: list.map((p) => ({
      name: String(p.name),
      alias: String(p.alias),
      price: p.price ?? null,
      inventory: p.inventory_quantity ?? null,
      available: Boolean(p.available),
      url: `${baseUrl}/en/product/${p.alias}`,
    })),
  };
}

// Which products the config's name patterns pick out, and which patterns hit nothing.
function selectWatched(cfg, products) {
  const patterns = cfg.products.match.map((m) => m.toLowerCase());
  const watched = products.filter((p) => patterns.some((m) => p.name.toLowerCase().includes(m)));
  const unmatched = patterns.filter((m) => !products.some((p) => p.name.toLowerCase().includes(m)));
  return { watched, unmatched };
}

// "Amul Chocolate Whey Protein, 34 g | Pack of 30 sachets" -> "Chocolate Whey Protein (30)"
function shortName(name) {
  const base = name.replace(/^Amul\s+/i, '').split(/[,|]/)[0].trim();
  const pack = /pack of (\d+)/i.exec(name)?.[1];
  return pack ? `${base} (${pack})` : base;
}

const fmtPrice = (p) => (p === null ? '?' : `₹${Number(p).toLocaleString('en-IN')}`);
const describe = (p) => `${p.name}\n  ${fmtPrice(p.price)}, inventory ${p.inventory ?? '?'}\n  ${p.url}`;

// --- ntfy notification ------------------------------------------------------
async function notify(cfg, { title, message, priority, tags, click }) {
  if (cfg.notify.type !== 'ntfy') {
    log('NOTIFY (no channel):', title, '-', message);
    return;
  }
  const url = `${cfg.notify.server.replace(/\/$/, '')}/${cfg.notify.topic}`;
  // HTTP header values must be Latin-1; strip non-ASCII (e.g. emoji) from the title.
  // Emoji still render fine via the message body and the Tags header (emoji shortcodes).
  const asciiTitle = String(title).replace(/[^\x00-\xFF]/g, '').trim() || 'Amul notifier';
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
async function maybeDailySummary(cfg, result, watched, unmatched, state, now) {
  const hour = cfg.notify.dailyHour;
  if (hour === undefined || hour === null || hour < 0) return; // disabled
  const d = new Date(now);
  if (d.getHours() < hour) return; // not time yet today
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  if (state.lastDailyDate === today) return; // already sent today

  const lines = [
    `Pincode ${cfg.location.pincode} (${result.substore}):`,
    ...watched.map((p) => `${p.available ? '✅' : '❌'} ${shortName(p.name)}${p.available ? ` ${fmtPrice(p.price)}` : ''}`),
    ...unmatched.map((m) => `⚠️ "${m}" matches no product: the catalog changed, update products.match`),
  ];
  try {
    await notify(cfg, {
      title: '🥛 Amul daily check-in',
      message: lines.join('\n'),
      priority: 'min',
      tags: 'glass_of_milk,calendar',
      click: cfg.site.baseUrl + cfg.site.browsePath,
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
      title: '⚠️ Amul tracker failing',
      message:
        `Checks have failed for ${Math.round((now - f.since) / 3_600_000)}h.\nLast error: ${err}\n` +
        'Check shop.amul.com manually meanwhile.',
      priority: 'default',
      tags: 'warning',
      click: cfg.site.baseUrl + cfg.site.browsePath,
    });
    f.alerted = true;
  } catch (e) {
    log('failure alert push failed:', e.message);
  }
}

// --- one full cycle: check, diff against state, alert -----------------------
async function runOnce(cfg) {
  const state = loadState();
  let result;
  // small retry: the API / network can hiccup
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      result = await fetchProducts(cfg);
      break;
    } catch (e) {
      log(`check attempt ${attempt} failed:`, e.message);
      if (attempt === 2) {
        log('giving up this cycle (state unchanged, no alert)');
        process.exitCode = CHECK_FAILED;
        await trackFailure(cfg, state, e.message);
        saveState(state);
        return;
      }
      await sleep(4000);
    }
  }
  await trackFailure(cfg, state, null);

  const now = Date.now();
  const { watched, unmatched } = selectWatched(cfg, result.products);
  const firstEver = !state.products;
  const prev = state.products || {};
  const inStock = watched.filter((p) => p.available);
  const back = inStock.filter((p) => !prev[p.alias]?.available);
  const gone = watched.filter((p) => !p.available && prev[p.alias]?.available);

  log(
    `${result.substore}: ${result.products.length} protein products, ${inStock.length}/${watched.length} watched in stock` +
      (firstEver ? ' (first check)' : '')
  );
  for (const m of unmatched) log(`warning: "${m}" matches no product (catalog changed? update products.match)`);
  for (const p of inStock) log(`  in stock: ${p.name} ${fmtPrice(p.price)} inventory=${p.inventory}${back.includes(p) ? ' (NEW)' : ''}`);
  for (const p of gone) log(`  went out of stock: ${p.name}`);

  const remindMs = (cfg.notify.remindEveryMinutes ?? 30) * 60_000;
  const remindDue = !back.length && inStock.length && now - (state.lastAlertAt || 0) >= remindMs;
  if (back.length || remindDue) {
    const title =
      inStock.length === 1
        ? `🥛 Amul: ${shortName(inStock[0].name)} ${back.length ? 'in stock' : 'still in stock'}`
        : `🥛 Amul: ${inStock.length} watched items ${back.length ? 'in stock' : 'still in stock'}`;
    const message =
      `In stock at pincode ${cfg.location.pincode} (${result.substore}):\n\n` +
      inStock.map((p) => `${back.includes(p) ? '🆕 ' : ''}${describe(p)}`).join('\n\n') +
      `\n\nSelect pincode ${cfg.location.pincode} on the site, or it shows another region's stock.`;
    try {
      await notify(cfg, {
        title,
        message,
        priority: back.length ? 'urgent' : 'high',
        tags: back.length ? 'glass_of_milk,rotating_light' : 'glass_of_milk',
        click: (back[0] || inStock[0]).url,
      });
      state.lastAlertAt = now;
    } catch (e) {
      // Don't advance the baseline — otherwise the restock is swallowed. Retry next cycle.
      log('alert push failed, keeping old baseline so it re-fires:', e.message);
      process.exitCode = CHECK_FAILED;
      saveState(state);
      return;
    }
  }

  await maybeDailySummary(cfg, result, watched, unmatched, state, now);

  state.products = Object.fromEntries(watched.map((p) => [p.alias, { name: p.name, available: p.available }]));
  state.substore = result.substore;
  state.checkedAt = new Date().toISOString();
  saveState(state);
}

// --- entrypoints ------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2);
  const cfg = loadConfig({ needTopic: !args.includes('--dump') });

  if (args.includes('--dump')) {
    const r = await fetchProducts(cfg);
    const { watched, unmatched } = selectWatched(cfg, r.products);
    console.log(`pincode ${cfg.location.pincode} -> substore ${r.substore}, ${r.products.length} products`);
    console.log('watched  avail  inventory  price    name');
    for (const p of r.products)
      console.log(
        `${watched.includes(p) ? '  👀   ' : '       '}  ${p.available ? '✅' : '❌'}    ${String(p.inventory).padStart(6)}     ` +
          `${fmtPrice(p.price).padEnd(8)} ${p.name}\n${' '.repeat(43)}${p.url}`
      );
    for (const m of unmatched) console.log(`warning: "${m}" matches no product`);
    return;
  }

  if (args.includes('--test-notify')) {
    await notify(cfg, {
      title: '✅ Amul notifier test',
      message:
        `If you see this on your phone, ntfy is wired up correctly.\n` +
        `Watching ${cfg.products.match.map((m) => `"${m}"`).join(', ')} at pincode ${cfg.location.pincode}.`,
      priority: 'default',
      tags: 'test_tube,glass_of_milk',
      click: cfg.site.baseUrl + cfg.site.browsePath,
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
