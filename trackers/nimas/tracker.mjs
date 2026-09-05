#!/usr/bin/env node
// NIMAS course seat tracker -> ntfy push when seats for a course change / run low.
// Usage:
//   node tracker.mjs --once     run a single check (use this from cron/systemd)
//   node tracker.mjs --watch    run forever, checking every config.watch.intervalMinutes
//   node tracker.mjs --test-notify   send a test ntfy push and exit
//
// How the data works: nimasdirang.com is a React front-end with no server-rendered
// seat numbers — the course table is filled in by one POST to the ERP backend
// (apierp.azurewebsites.net .../getTemplateDataList) with templateID 3 and a
// "Category Name" filter. No Cloudflare, no cookies, no browser: plain fetch works.
// The response is column-oriented: response.records is an array of rows, and each row
// is an ARRAY of {name, value} pairs which we fold into a normal object. We pick the
// row whose "Serial No" is our course (e.g. BMC-64) and read "Available Seats".

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

function loadConfig() {
  const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  // env overrides for containers / secrets
  if (process.env.NTFY_TOPIC) cfg.notify.topic = process.env.NTFY_TOPIC;
  if (process.env.NTFY_SERVER) cfg.notify.server = process.env.NTFY_SERVER;

  // This must come from .env (or the environment); it is deliberately blank in config.json.
  if (!cfg.notify.topic) {
    throw new Error(
      `Missing required secret: NTFY_TOPIC. ` +
        `Set it in ${ENV_FILE} (copy .env.example) or export it in the environment.`
    );
  }
  return cfg;
}

function loadState() {
  if (!existsSync(STATE_PATH)) return { availableSeats: null, lastAlertAt: 0 };
  try {
    return JSON.parse(readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return { availableSeats: null, lastAlertAt: 0 };
  }
}
function saveState(s) {
  writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));
}

// --- the actual seat check --------------------------------------------------
async function checkSeats(cfg) {
  const timeoutMs = cfg.api.timeoutMs || 30000;
  // fetch has no built-in timeout; without this a hung socket would stall the cycle.
  const ac = new AbortController();
  const killer = setTimeout(() => ac.abort(), timeoutMs);

  let json;
  try {
    const res = await fetch(cfg.api.url, {
      method: 'POST',
      headers: {
        'Authorization-Token': cfg.api.authToken,
        Accept: 'application/json, text/plain',
        'Content-Type': 'application/json;charset=UTF-8',
        'User-Agent': UA,
        Origin: 'https://www.nimasdirang.com',
        Referer: 'https://www.nimasdirang.com/',
      },
      body: JSON.stringify({
        NumberOfFieldsView: 50,
        filters: { 'Category Name': cfg.api.categoryName },
        isDownload: false,
        index: 1,
        pgSize: 100,
        templateID: cfg.api.templateID,
      }),
      signal: ac.signal,
    });
    if (!res.ok) throw new Error(`API returned HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    json = await res.json();
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`API request timed out after ${timeoutMs}ms`);
    throw e;
  } finally {
    clearTimeout(killer);
  }

  const records = json?.response?.records;
  if (!Array.isArray(records) || !records.length)
    throw new Error('unexpected API response: response.records is missing or empty');

  // Each record is an array of {name, value} pairs -> fold into a plain object.
  const rows = records.map((rec) => Object.fromEntries(rec.map((f) => [f.name, f.value])));
  const row = rows.find((r) => String(r['Serial No']).trim() === cfg.course.serialNo);
  // Fail SAFE: a missing row means the API/schema changed, NOT that the course sold out.
  if (!row) throw new Error(`course ${cfg.course.serialNo} not found among ${rows.length} records`);

  const availableSeats = Number(row['Available Seats']);
  if (!Number.isFinite(availableSeats))
    throw new Error(`"Available Seats" is not a number for ${cfg.course.serialNo}: ${row['Available Seats']}`);

  return {
    ok: true,
    serialNo: cfg.course.serialNo,
    courseName: row['Course Name'] || cfg.course.name,
    availableSeats,
    capacity: Number(row.Capacity) || null,
    fee: Number(row['Course Fees']) || null,
    from: row['Course Dates From'] || null,
    to: row['Course Dates To'] || null,
    age: row.Age || null,
    type: row.Type || null,
  };
}

// One-line human summary reused by every push body.
function describe(r) {
  const dates = r.from && r.to ? ` (${r.from} → ${r.to})` : '';
  const cap = r.capacity ? ` of ${r.capacity}` : '';
  const fee = r.fee ? ` Fee ₹${r.fee}.` : '';
  return `${r.serialNo}${dates}: ${r.availableSeats}${cap} seats left.${fee}`;
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
  const asciiTitle = String(title).replace(/[^\x00-\xFF]/g, '').trim() || 'NIMAS notifier';
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

// --- daily summary: the once-a-day reminder AND the proof-of-life ------------
// Sends exactly one push per day, at/after notify.dailyHour (local time — set TZ in
// the container), no matter what the seat count is doing. If you ever STOP getting
// it, the tracker is dead.
async function maybeDailySummary(cfg, result, state, now) {
  const hour = cfg.notify.dailyHour;
  if (hour === undefined || hour === null || hour < 0) return; // disabled
  const d = new Date(now);
  if (d.getHours() < hour) return; // not time yet today
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  if (state.lastDailyDate === today) return; // already sent today

  try {
    await notify(cfg, {
      title: `⛰️ ${result.serialNo} daily update`,
      message:
        `${describe(result)}\n` +
        `${result.courseName}` +
        `${result.age ? `\nAge: ${result.age}` : ''}` +
        `${result.type ? ` | ${result.type}` : ''}`,
      priority: 'default',
      tags: 'mountain,calendar',
      click: cfg.course.url,
    });
    state.lastDailyDate = today; // caller persists state at the end of the cycle
  } catch (e) {
    log('daily summary push failed:', e.message);
  }
}

// --- one full cycle: check, diff against state, alert -----------------------
async function runOnce(cfg) {
  let result;
  // small retry: the ERP backend / network can hiccup
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      result = await checkSeats(cfg);
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
  const seats = result.availableSeats;
  const prev = state.availableSeats; // null on the very first ever check
  log(
    `${result.serialNo}: ${seats}/${result.capacity ?? '?'} seats available` +
      (prev === null || prev === undefined ? ' (first check)' : ` (was ${prev})`)
  );

  const firstEver = prev === null || prev === undefined;
  const changed = !firstEver && seats !== prev;
  const dropped = changed && seats < prev;
  const soldOut = changed && seats === 0; // the 0-seat transition, alerted exactly once
  // Urgent mode nags while seats are low. remindMinutes defaults to 55 — deliberately
  // just UNDER the 60-minute check interval, so every hourly check while we're in
  // urgent mode actually alerts instead of being swallowed by the rate limit.
  const remindMs = (cfg.notify.urgentRemindMinutes ?? 55) * 60_000;
  const urgentDue =
    seats > 0 && // never "urgent" at 0 seats — that's the sold-out case, then silence
    seats < (cfg.notify.urgentThreshold ?? 20) &&
    now - (state.lastAlertAt || 0) >= remindMs;

  if (soldOut) {
    await notify(cfg, {
      title: `🚫 ${result.serialNo} is FULL`,
      message: `Sold out — 0 seats left (was ${prev}).\n${result.courseName}\nGoing quiet until seats reappear.`,
      priority: 'urgent',
      tags: 'no_entry,mountain',
      click: cfg.course.url,
    });
    state.lastAlertAt = now;
  } else if (changed || urgentDue) {
    // ONE combined push — a change that also lands us in urgent territory must not
    // fire two notifications in the same cycle.
    const lines = [];
    if (changed) lines.push(`Seats: ${prev} → ${seats}`);
    if (urgentDue) lines.push(`Only ${seats} seat${seats === 1 ? '' : 's'} left!`);
    lines.push(describe(result));
    await notify(cfg, {
      title: urgentDue
        ? `🔥 Only ${seats} seats left — ${result.serialNo}`
        : `⛰️ ${result.serialNo}: ${prev} → ${seats} seats`,
      message: lines.join('\n'),
      priority: urgentDue || dropped ? 'high' : 'default',
      tags: urgentDue ? 'fire,mountain' : 'mountain,mount_fuji',
      click: cfg.course.url,
    });
    state.lastAlertAt = now;
  } else if (firstEver) {
    log('first ever check — recording the baseline, no change alert');
  }

  await maybeDailySummary(cfg, result, state, now);

  state.availableSeats = seats;
  state.capacity = result.capacity;
  state.courseName = result.courseName;
  state.checkedAt = new Date().toISOString();
  saveState(state);
}

// --- entrypoints ------------------------------------------------------------
async function main() {
  const cfg = loadConfig();
  const args = process.argv.slice(2);

  if (args.includes('--test-notify')) {
    await notify(cfg, {
      title: '✅ NIMAS notifier test',
      message: `If you see this on your phone, ntfy is wired up correctly.\nWatching ${cfg.course.serialNo} — ${cfg.course.name}.`,
      priority: 'default',
      tags: 'test_tube',
      click: cfg.course.url,
    });
    return;
  }

  if (args.includes('--watch')) {
    const everyMs = (cfg.watch.intervalMinutes || 60) * 60_000;
    const jitterMs = (cfg.watch.jitterSeconds || 0) * 1000;
    // Watchdog: a single cycle should never take long. If one wedges (e.g. a socket that
    // never returns and somehow slips past the AbortController), exit so the container's
    // restart policy hands us a clean process. This turns a silent multi-hour freeze into
    // a ~minutes-long self-heal.
    const cycleHardLimitMs = Math.max(120_000, (cfg.api.timeoutMs || 30000) * 3);
    log(`watch mode: every ~${cfg.watch.intervalMinutes}min (+/- ${cfg.watch.jitterSeconds}s); cycle hard-limit ${Math.round(cycleHardLimitMs / 1000)}s`);
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const watchdog = setTimeout(() => {
        log(`FATAL: check cycle exceeded ${Math.round(cycleHardLimitMs / 1000)}s — wedged; exiting for a clean restart`);
        process.exit(1);
      }, cycleHardLimitMs);
      try {
        await runOnce(cfg);
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
}

main().catch((e) => {
  log('FATAL:', e.stack || e.message);
  process.exit(1);
});
