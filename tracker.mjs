#!/usr/bin/env node
// Blinkit stock tracker -> ntfy push when a product is back in stock.
// Usage:
//   node tracker.mjs --once     run a single check (use this from cron/systemd)
//   node tracker.mjs --watch    run forever, checking every config.watch.intervalMinutes
//   node tracker.mjs --test-notify   send a test ntfy push and exit
//
// How location works: Blinkit picks the serving "dark store" from lat/lon, which the
// web app stores in the cookies gr_1_lat / gr_1_lon. We set those cookies, load the
// product page (this passes Cloudflare as a real browser), and read the structured
// JSON the page fetches from /v1/layout/product/<prid>. The product snippet carries
// `inventory` (a count) and `is_sold_out` (bool). In stock == inventory > 0 && !is_sold_out.

import { chromium } from 'playwright';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.CONFIG_PATH || join(HERE, 'config.json');
const STATE_PATH = process.env.STATE_PATH || join(HERE, 'state.json');

// Secrets (NTFY_TOPIC, LAT, LON) live in .env, not config.json. Auto-load it if present.
// systemd/Docker may instead inject these via EnvironmentFile/env_file — that's fine,
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

function loadConfig() {
  const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  // env overrides for containers / secrets
  if (process.env.NTFY_TOPIC) cfg.notify.topic = process.env.NTFY_TOPIC;
  if (process.env.NTFY_SERVER) cfg.notify.server = process.env.NTFY_SERVER;
  if (process.env.LAT) cfg.location.lat = Number(process.env.LAT);
  if (process.env.LON) cfg.location.lon = Number(process.env.LON);
  if (process.env.CHROMIUM_PATH) cfg.browser.chromiumPath = process.env.CHROMIUM_PATH;

  // These must come from .env (or the environment); they are deliberately blank in config.json.
  const missing = [];
  if (!cfg.notify.topic) missing.push('NTFY_TOPIC');
  if (!Number.isFinite(cfg.location.lat)) missing.push('LAT');
  if (!Number.isFinite(cfg.location.lon)) missing.push('LON');
  if (missing.length) {
    throw new Error(
      `Missing required secret(s): ${missing.join(', ')}. ` +
        `Set them in ${ENV_FILE} (copy .env.example) or export them in the environment.`
    );
  }
  return cfg;
}

function loadState() {
  if (!existsSync(STATE_PATH)) return { inStock: null, lastAlertAt: 0 };
  try {
    return JSON.parse(readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return { inStock: null, lastAlertAt: 0 };
  }
}
function saveState(s) {
  writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));
}

// --- the actual stock check -------------------------------------------------
async function checkStock(cfg) {
  const { prid } = cfg.product;
  const launchOpts = { headless: cfg.browser.headless !== false };
  if (cfg.browser.chromiumPath) launchOpts.executablePath = cfg.browser.chromiumPath;

  const browser = await chromium.launch(launchOpts);
  try {
    const ctx = await browser.newContext({ locale: 'en-IN', userAgent: UA });
    await ctx.addCookies([
      { name: 'gr_1_lat', value: String(cfg.location.lat), domain: 'blinkit.com', path: '/' },
      { name: 'gr_1_lon', value: String(cfg.location.lon), domain: 'blinkit.com', path: '/' },
      { name: 'gr_1_locality', value: String(cfg.location.locality ?? ''), domain: 'blinkit.com', path: '/' },
    ]);
    const page = await ctx.newPage();
    // block images/fonts/media to make checks fast & light
    await page.route('**/*', (route) => {
      const t = route.request().resourceType();
      if (t === 'image' || t === 'media' || t === 'font') return route.abort();
      return route.continue();
    });

    const url = cfg.product.url || `https://blinkit.com/prn/x/prid/${prid}`;
    const wantApi = (r) => r.url().includes(`/v1/layout/product/${prid}`);
    const apiPromise = page
      .waitForResponse(wantApi, { timeout: cfg.browser.navTimeoutMs || 45000 })
      .catch(() => null);

    const nav = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: cfg.browser.navTimeoutMs || 45000,
    });
    if (nav && nav.status() >= 400) throw new Error(`page returned HTTP ${nav.status()} (Cloudflare block?)`);

    const apiResp = await apiPromise;
    if (!apiResp) throw new Error('did not observe the product API response (layout changed or blocked)');
    const json = await apiResp.json();

    // find the product strip snippet for THIS product id
    const snippets = json?.response?.snippets || [];
    const snip = snippets.find((s) => s?.data && Number(s.data.product_id) === Number(prid) && s.data.inventory !== undefined);
    if (!snip) throw new Error('could not find product snippet with inventory in API response');
    const d = snip.data;

    const inventory = Number(d.inventory);
    const isSoldOut = d.is_sold_out === true;
    const inStock = inventory > 0 && !isSoldOut;

    // best-effort store + price for nicer alerts (let the page hydrate first)
    await page.waitForTimeout(1500);
    let store = null;
    try {
      const m = JSON.parse(await page.evaluate(() => localStorage.getItem('merchant') || 'null'));
      store = m && m.name;
    } catch {}
    const price =
      d?.normal_price?.offer_price?.text ||
      d?.normal_price?.mrp?.text ||
      (d?.offer && d.offer?.offer_price?.text) ||
      null;

    return { ok: true, inStock, inventory, isSoldOut, store, price, prid };
  } finally {
    await browser.close();
  }
}

// --- ntfy notification ------------------------------------------------------
async function notify(cfg, { title, message, priority, tags, click }) {
  if (cfg.notify.type !== 'ntfy') {
    log('NOTIFY (no channel):', title, '-', message);
    return;
  }
  const url = `${cfg.notify.server.replace(/\/$/, '')}/${cfg.notify.topic}`;
  // HTTP header values must be Latin-1; strip non-ASCII (e.g. emoji) from the title.
  // Emoji still render fine via the message body and the Tags header (emoji shortcodes).
  const asciiTitle = String(title).replace(/[^\x00-\xFF]/g, '').trim() || 'Chicken tracker';
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

// --- daily heartbeat: prove the tracker is alive ----------------------------
// Sends one low-priority "still watching" push per day, at/after notify.heartbeatHour
// (local time — set TZ in the container). If you ever STOP getting it, something died.
async function maybeHeartbeat(cfg) {
  const hour = cfg.notify.heartbeatHour;
  if (hour === undefined || hour === null || hour < 0) return; // disabled
  const now = new Date();
  if (now.getHours() < hour) return; // not time yet today
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const state = loadState();
  if (state.lastHeartbeatDate === today) return; // already sent today

  const status =
    state.inStock === true
      ? `IN STOCK (inventory ${state.lastInventory})`
      : state.inStock === false
        ? 'out of stock'
        : 'unknown (no successful check yet)';
  try {
    await notify(cfg, {
      title: 'Chicken tracker - still watching',
      message:
        `Daily check-in ✅\nLast result: ${status}` +
        `${state.lastStore ? `\nStore: ${state.lastStore}` : ''}` +
        `${state.checkedAt ? `\nAt: ${state.checkedAt}` : ''}`,
      priority: 'low',
      tags: 'heartbeat',
    });
    state.lastHeartbeatDate = today;
    saveState(state);
  } catch (e) {
    log('heartbeat push failed:', e.message);
  }
}

// --- one full cycle: check, diff against state, alert -----------------------
async function runOnce(cfg) {
  let result;
  // small retry: Cloudflare / network can hiccup
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      result = await checkStock(cfg);
      break;
    } catch (e) {
      log(`check attempt ${attempt} failed:`, e.message);
      if (attempt === 2) {
        log('giving up this cycle (state unchanged, no alert)');
        return;
      }
      await sleep(4000);
    }
  }

  const state = loadState();
  const now = Date.now();
  log(
    `result: ${result.inStock ? 'IN STOCK' : 'out of stock'} ` +
      `(inventory=${result.inventory}) @ ${result.store || 'unknown store'}` +
      (result.price ? ` price=${result.price}` : '')
  );

  const wasInStock = state.inStock;
  const becameAvailable = result.inStock && wasInStock !== true;
  const remindDue =
    result.inStock &&
    cfg.notify.remindEveryHours > 0 &&
    now - (state.lastAlertAt || 0) > cfg.notify.remindEveryHours * 3600_000;

  if (becameAvailable || remindDue) {
    await notify(cfg, {
      title: `🐔 ${cfg.product.name} is IN STOCK`,
      message:
        `${result.inventory} available${result.price ? ` at ${result.price}` : ''}` +
        `${result.store ? `\nStore: ${result.store}` : ''}\nOrder now 👇`,
      priority: 'high',
      tags: 'meat_on_bone,muscle',
      click: cfg.product.url,
    });
    state.lastAlertAt = now;
  } else if (!result.inStock && wasInStock === true) {
    log('went out of stock (quiet — no alert)');
  }

  state.inStock = result.inStock;
  state.lastInventory = result.inventory;
  state.lastStore = result.store;
  state.checkedAt = new Date().toISOString();
  saveState(state);
}

// --- entrypoints ------------------------------------------------------------
async function main() {
  const cfg = loadConfig();
  const args = process.argv.slice(2);

  if (args.includes('--test-notify')) {
    await notify(cfg, {
      title: '✅ Chicken tracker test',
      message: 'If you see this on your phone, ntfy is wired up correctly.',
      priority: 'default',
      tags: 'test_tube',
      click: cfg.product.url,
    });
    return;
  }

  if (args.includes('--watch')) {
    const everyMs = (cfg.watch.intervalMinutes || 12) * 60_000;
    const jitterMs = (cfg.watch.jitterSeconds || 0) * 1000;
    // Watchdog: a single cycle should never take long. If one wedges (e.g. a hung
    // headless browser that never returns and isn't covered by a Playwright timeout),
    // exit so the container's restart policy hands us a clean process. This turns a
    // silent multi-hour freeze into a ~minutes-long self-heal.
    const cycleHardLimitMs = Math.max(120_000, (cfg.browser.navTimeoutMs || 45000) * 3);
    log(`watch mode: every ~${cfg.watch.intervalMinutes}min (+/- ${cfg.watch.jitterSeconds}s); cycle hard-limit ${Math.round(cycleHardLimitMs / 1000)}s`);
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const watchdog = setTimeout(() => {
        log(`FATAL: check cycle exceeded ${Math.round(cycleHardLimitMs / 1000)}s — wedged; exiting for a clean restart`);
        process.exit(1);
      }, cycleHardLimitMs);
      try {
        await runOnce(cfg);
        await maybeHeartbeat(cfg);
      } finally {
        clearTimeout(watchdog);
      }
      const wait = everyMs + Math.floor((Math.random() * 2 - 1) * jitterMs);
      log(`next check in ${Math.round(wait / 1000)}s`);
      await sleep(Math.max(30_000, wait));
    }
  }

  // default: single check (for cron / systemd timer)
  await runOnce(cfg);
  await maybeHeartbeat(cfg);
}

main().catch((e) => {
  log('FATAL:', e.stack || e.message);
  process.exit(1);
});
