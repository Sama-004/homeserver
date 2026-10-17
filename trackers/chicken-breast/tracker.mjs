#!/usr/bin/env node
// Blinkit stock tracker -> ntfy push when a product is back in stock.
// Usage:
//   node tracker.mjs [--once]        run one check, write next-run, exit (the default)
//   node tracker.mjs --test-notify   send a test ntfy push and exit
// In Docker, ../run-loop.sh runs the check and sleeps until the time in next-run.
//
// How it works: Blinkit's web app POSTs to /v1/layout/product/<prid> with `lat` / `lon`
// headers, and the API picks the serving "dark store" (merchant) from those. The product
// snippet in the JSON carries `inventory` (a count) and `is_sold_out` (bool). In stock ==
// inventory > 0 && !is_sold_out. Cloudflare in front of it blocks clients by their TLS/HTTP2
// fingerprint (Node's fetch, plain curl and headless Chromium all get 403), so the request
// goes through curl-impersonate, which sends Chrome's fingerprint.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
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
// The daily heartbeat calls the tracker unhealthy once the last good check is this old.
const STALE_HOURS = 3;

// Secrets (NTFY_TOPIC, LAT, LON) live in .env, not config.json. Auto-load it if present.
// systemd/Docker may instead inject these via EnvironmentFile/env_file — that's fine,
// existing process.env always wins over the file.
const ENV_FILE = process.env.ENV_FILE || join(HERE, '.env');
try {
  if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
} catch (e) {
  console.error('warning: could not load', ENV_FILE, '-', e.message);
}
const CURL = process.env.CURL_IMPERSONATE || 'curl-impersonate';

const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadConfig() {
  const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  // env overrides for containers / secrets
  if (process.env.NTFY_TOPIC) cfg.notify.topic = process.env.NTFY_TOPIC;
  if (process.env.NTFY_SERVER) cfg.notify.server = process.env.NTFY_SERVER;
  if (process.env.LAT) cfg.location.lat = Number(process.env.LAT);
  if (process.env.LON) cfg.location.lon = Number(process.env.LON);

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

// checkedAt is the time of the last SUCCESSFUL check; failure is the current run of failed
// checks ({since, alerted, lastError}), null while checks work.
const EMPTY_STATE = { inStock: null, lastAlertAt: 0, failure: null };
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

// --- the actual stock check -------------------------------------------------
// One POST through curl-impersonate. Resolves to {status, body}; rejects only when curl
// itself fails (DNS, connect, timeout).
function postLayout(cfg) {
  const { impersonate, timeoutSeconds } = cfg.api;
  const args = [
    '--impersonate', impersonate,
    '--compressed',
    '--silent', '--show-error',
    '--max-time', String(timeoutSeconds),
    '--request', 'POST',
    '--header', 'Content-Type: application/json',
    '--header', 'app_client: consumer_web',
    '--header', `lat: ${cfg.location.lat}`,
    '--header', `lon: ${cfg.location.lon}`,
    '--data', '{}',
    // The status goes last on stdout, after the body, on a line of its own.
    '--write-out', '\n%{http_code}',
    `https://blinkit.com/v1/layout/product/${cfg.product.prid}`,
  ];
  return new Promise((resolve, reject) => {
    execFile(
      CURL,
      args,
      { timeout: (timeoutSeconds + 5) * 1000, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          // Not err.message: it repeats the command line, lat/lon headers included.
          const why = err.killed ? 'killed after timeout' : stderr.trim() || `code ${err.code}`;
          return reject(new Error(`curl-impersonate failed: ${why}`));
        }
        const i = stdout.lastIndexOf('\n');
        resolve({ status: Number(stdout.slice(i + 1)), body: stdout.slice(0, i) });
      }
    );
  });
}

// Pure: the API response -> the product's stock, or an error saying why it can't be trusted.
function parseProduct(status, body, prid) {
  if (status === 403 && body.trimStart().startsWith('<')) throw new Error('blocked by Cloudflare (HTTP 403)');
  if (status !== 200) throw new Error(`API returned HTTP ${status}: ${body.slice(0, 200)}`);
  let json;
  try {
    json = JSON.parse(body);
  } catch {
    throw new Error(`API returned non-JSON: ${body.slice(0, 200)}`);
  }
  const snippets = json?.response?.snippets || [];
  const d = snippets.find((s) => Number(s?.data?.product_id) === prid && s.data.inventory !== undefined)?.data;
  if (!d) throw new Error(`no snippet for product ${prid} with inventory in the API response (layout changed?)`);
  // Without a serviceable location the API still returns the product, sold out, with no
  // merchant. That is "nobody delivers here", not "out of stock".
  const merchantId = d.meta?.merchant_id;
  if (!merchantId) throw new Error('no merchant for this location (unserviceable, or lat/lon not applied)');

  const inventory = Number(d.inventory);
  const isSoldOut = d.is_sold_out === true;
  return {
    inStock: inventory > 0 && !isSoldOut,
    inventory,
    isSoldOut,
    store: `merchant ${merchantId}`,
    price: d.normal_price?.text || null,
  };
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

const hoursSince = (t, now) => Math.round((now - t) / 3_600_000);

// --- daily heartbeat: prove the tracker is alive AND working -----------------
// One push per day, at/after notify.heartbeatHour (local time — set TZ in the container).
// If you ever STOP getting it, something died. It reports the last successful check, so a
// tracker whose checks all fail says so instead of "still watching".
async function maybeHeartbeat(cfg, state) {
  const hour = cfg.notify.heartbeatHour;
  if (hour === undefined || hour === null || hour < 0) return; // disabled
  const now = new Date();
  if (now.getHours() < hour) return; // not time yet today
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  if (state.lastHeartbeatDate === today) return; // already sent today

  const lastOk = state.checkedAt ? Date.parse(state.checkedAt) : null;
  const healthy = lastOk !== null && now - lastOk < STALE_HOURS * 3_600_000;
  const status =
    state.inStock === true
      ? `IN STOCK (inventory ${state.lastInventory})`
      : state.inStock === false
        ? 'out of stock'
        : 'unknown';
  const lines = healthy
    ? ['Daily check-in ✅', `Last result: ${status}`, ...(state.lastStore ? [`Store: ${state.lastStore}`] : []), `At: ${state.checkedAt}`]
    : [
        lastOk === null
          ? '❌ No check has ever succeeded.'
          : `❌ No successful check for ${hoursSince(lastOk, now)}h (last: ${state.checkedAt}, ${status}).`,
        ...(state.failure ? [`Last error: ${state.failure.lastError}`] : []),
        'Stock alerts will NOT arrive until this is fixed.',
      ];
  try {
    await notify(cfg, {
      title: healthy ? 'Chicken tracker - still watching' : 'Chicken tracker - checks FAILING',
      message: lines.join('\n'),
      priority: healthy ? 'low' : 'default',
      tags: healthy ? 'heartbeat' : 'heartbeat,warning',
    });
    state.lastHeartbeatDate = today;
  } catch (e) {
    log('heartbeat push failed:', e.message);
  }
}

// Silence is ambiguous (out of stock vs. tracker broken), so if checks keep failing for a
// while, say so once. Reset on the next good check.
async function trackFailure(cfg, state, err) {
  const now = Date.now();
  if (!err) {
    if (state.failure) log(`recovered after failing since ${new Date(state.failure.since).toISOString()}`);
    state.failure = null;
    return;
  }
  const f = (state.failure ??= { since: now, alerted: false });
  f.lastError = err;
  const hours = cfg.notify.failureAlertHours ?? 6;
  if (f.alerted || now - f.since < hours * 3_600_000) return;
  try {
    await notify(cfg, {
      title: '⚠️ Chicken tracker failing',
      message:
        `Checks have failed for ${hoursSince(f.since, now)}h.\nLast error: ${err}\n` +
        'Check Blinkit manually meanwhile.',
      priority: 'default',
      tags: 'warning',
      click: cfg.product.url,
    });
    f.alerted = true;
  } catch (e) {
    log('failure alert push failed:', e.message);
  }
}

// --- one full cycle: check, diff against state, alert -----------------------
async function runOnce(cfg, state) {
  let result;
  // small retry: Cloudflare / network can hiccup
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const { status, body } = await postLayout(cfg);
      result = parseProduct(status, body, Number(cfg.product.prid));
      break;
    } catch (e) {
      log(`check attempt ${attempt} failed:`, e.message);
      if (attempt === 2) {
        log('giving up this cycle (stock state unchanged, no alert)');
        process.exitCode = CHECK_FAILED;
        await trackFailure(cfg, state, e.message);
        return;
      }
      await sleep(4000);
    }
  }
  await trackFailure(cfg, state, null);

  const now = Date.now();
  log(
    `result: ${result.inStock ? 'IN STOCK' : 'out of stock'} ` +
      `(inventory=${result.inventory}, is_sold_out=${result.isSoldOut}) @ ${result.store}` +
      (result.price ? ` price=${result.price}` : '')
  );

  const wasInStock = state.inStock;
  const becameAvailable = result.inStock && wasInStock !== true;
  const remindDue =
    result.inStock &&
    cfg.notify.remindEveryMinutes > 0 &&
    now - (state.lastAlertAt || 0) > cfg.notify.remindEveryMinutes * 60_000;

  if (becameAvailable || remindDue) {
    try {
      await notify(cfg, {
        title: becameAvailable
          ? `🐔 ${cfg.product.name} is IN STOCK`
          : `🐔 Still in stock: ${cfg.product.name}`,
        message:
          `${result.inventory} available${result.price ? ` at ${result.price}` : ''}` +
          `\nStore: ${result.store}\nOrder now 👇`,
        priority: 'high',
        tags: 'meat_on_bone,muscle',
        click: cfg.product.url,
      });
      state.lastAlertAt = now;
    } catch (e) {
      // Don't advance the baseline — otherwise the restock is swallowed. Retry next cycle.
      log('alert push failed, keeping old baseline so it re-fires:', e.message);
      process.exitCode = CHECK_FAILED;
      return;
    }
  } else if (!result.inStock && wasInStock === true) {
    log('went out of stock (quiet — no alert)');
  }

  state.inStock = result.inStock;
  state.lastInventory = result.inventory;
  state.lastStore = result.store;
  state.checkedAt = new Date().toISOString();
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

  try {
    const state = loadState();
    await runOnce(cfg, state);
    await maybeHeartbeat(cfg, state);
    saveState(state);
  } finally {
    scheduleNext(cfg);
  }
}

// next-run holds one unix time in seconds: when run-loop.sh starts the next check.
function scheduleNext(cfg) {
  const jitterMs = (cfg.watch.jitterSeconds || 0) * 1000;
  const at = Date.now() + (cfg.watch.intervalMinutes || 12) * 60_000 + Math.floor((Math.random() * 2 - 1) * jitterMs);
  writeFileSync(NEXT_RUN_PATH, String(Math.ceil(at / 1000)));
}

main().catch((e) => {
  log('FATAL:', e.stack || e.message);
  process.exit(1);
});
