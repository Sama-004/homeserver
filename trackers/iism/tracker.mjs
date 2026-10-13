#!/usr/bin/env node
// IISM Gulmarg course watcher -> ntfy push when a snow-skiing course (or a booking date)
// shows up on iismgulmarg.in.
// Usage:
//   node tracker.mjs --once          run a single check (use this from cron/systemd)
//   node tracker.mjs --watch         run forever, checking every config.watch.intervalMinutes
//   node tracker.mjs --test-notify   send a test ntfy push and exit
//   node tracker.mjs --dump          print what the parser sees on each page and exit
//
// How the data works: iismgulmarg.in is plain server-rendered HTML (no API, no JS
// rendering), so we fetch the pages and turn each into a list of *visible* text lines:
// one line per table row / list item / paragraph / heading. Then we diff against the
// last run. Three signals, strongest first:
//   1. SKI     — a new visible line mentions snow skiing / snowboarding / a ski course.
//   2. BANNER  — the red "Bookings will open ..." line in the site-wide popup changed.
//                Any date+time in it becomes exact-time reminders (T-60, T-10, T-0).
//   3. HINT    — content the site has but HIDES (HTML comments, `d-none` blocks) that
//                mentions skiing changed. The last-season snow-skiing table lives in a
//                comment; editing it is usually the step before publishing it.
// Plus anything else newly posted (ticker items, course rows) as a low-key "site updated".

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
  cfg.skiRe = new RegExp(cfg.match.skiPattern, 'i');
  cfg.ignoreRe = new RegExp(cfg.match.ignorePattern, 'gi');
  return cfg;
}

const EMPTY_STATE = { pages: null, hiddenSki: [], announcement: null, reminders: [], lastAlertAt: 0 };
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

// --- HTML -> visible text lines ---------------------------------------------
// Regex "parsing" is fine here: it's a hand-written static site and we only need
// line-level text, not a DOM. Everything fails safe (see runOnce) if it goes weird.

function decodeEntities(s) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', times: '×', rsquo: '’', lsquo: '‘', ndash: '–', mdash: '—', hellip: '…' };
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => named[n.toLowerCase()] ?? m);
}

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

// Cut out every element whose class list contains `cls` (balancing nested same-name
// tags), returning [htmlWithoutThem, removedChunks].
function cutByClass(html, cls) {
  const removed = [];
  const openRe = new RegExp(`<([a-z][a-z0-9]*)\\b[^>]*\\bclass="[^"]*\\b${cls}\\b[^"]*"[^>]*>`, 'i');
  let m;
  while ((m = openRe.exec(html))) {
    const tag = m[1].toLowerCase();
    // void elements (<hr class="d-none">) have no closing tag — drop just the tag itself
    if (VOID_TAGS.has(tag) || m[0].endsWith('/>')) {
      html = html.slice(0, m.index) + html.slice(m.index + m[0].length);
      continue;
    }
    const tagRe = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi');
    tagRe.lastIndex = m.index + m[0].length;
    let depth = 1;
    let end = html.length; // unbalanced -> drop the rest; better than looping forever
    let t;
    while ((t = tagRe.exec(html))) {
      depth += t[1] ? -1 : 1;
      if (depth === 0) {
        end = t.index + t[0].length;
        break;
      }
    }
    removed.push(html.slice(m.index, end));
    html = html.slice(0, m.index) + html.slice(end);
  }
  return [html, removed];
}

function toLines(html) {
  const text = html
    .replace(/<(script|style|head|noscript)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/\s+/g, ' ')
    .replace(/<\/?(sup|sub)\b[^>]*>/gi, '') // "08<sup>th</sup>" -> "08th"
    .replace(/<\/t[dh]>/gi, ' | ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/?(p|li|tr|div|h[1-6]|table|thead|tbody|ul|ol|section|marquee|form|header|footer|nav)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(text)
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').replace(/(\s*\|\s*)+$/, '').replace(/^(\s*\|\s*)+/, '').trim())
    .filter((l) => l.length > 1);
}

function parsePage(html) {
  // Hidden = HTML comments + bootstrap `d-none` blocks. Visible = everything else.
  const hidden = [];
  let visible = html.replace(/<!--([\s\S]*?)-->/g, (_, c) => {
    hidden.push(c);
    return ' ';
  });
  let cut;
  [visible, cut] = cutByClass(visible, 'd-none');
  hidden.push(...cut);

  // The red blinking text is how IISM announces booking dates: the popup's <p> in July,
  // a <b> inside the ticker item for the Oct 2026 ski schedule. Take every one of them.
  const blinkRe = /<([a-z][a-z0-9]*)\b[^>]*class="[^"]*\bblink-text\b[^"]*"[^>]*>([\s\S]*?)<\/\1>/gi;
  const banners = [...visible.matchAll(blinkRe)].map((m) => toLines(m[2]).join(' ')).filter(Boolean);
  return {
    lines: toLines(visible),
    hiddenLines: hidden.flatMap(toLines),
    banners,
  };
}

const norm = (l) => l.toLowerCase().replace(/\s+/g, ' ').trim();
const isSki = (cfg, line) => cfg.skiRe.test(line.replace(cfg.ignoreRe, ' '));
const uniq = (arr) => [...new Map(arr.map((l) => [norm(l), l])).values()];

// --- booking date parsing -----------------------------------------------------
// IISM writes these as "14/07/2026 at 10:00 AM" or "08th JUNE 2026 AT 10:00 AM".
// Dates are DD/MM (India). Returns a Date in local time (TZ=Asia/Kolkata in Docker).
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
function parseBookingTime(text) {
  let d, mo, y;
  let m = /\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})\b/.exec(text);
  if (m) [d, mo, y] = [+m[1], +m[2], +m[3]];
  else if ((m = /\b(\d{1,2})\s*(?:st|nd|rd|th)?\s+([a-z]{3})[a-z]*\.?,?\s+(\d{4})\b/i.exec(text))) {
    mo = MONTHS.indexOf(m[2].toLowerCase()) + 1;
    [d, y] = [+m[1], +m[3]];
  } else return null;
  if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return null;

  let hh = 10, mm = 0, assumed = true; // every IISM opening so far has been 10:00 AM
  const rest = text.slice(m.index + m[0].length);
  let t;
  if ((t = /\b(\d{1,2})(?:[:.](\d{2}))?\s*([ap])\.?\s*m\b/i.exec(rest))) {
    hh = (+t[1] % 12) + (t[3].toLowerCase() === 'p' ? 12 : 0);
    mm = +(t[2] || 0);
    assumed = false;
  } else if ((t = /\b([01]?\d|2[0-3])[:.]([0-5]\d)\b/.exec(rest))) {
    // "10:00 HRS" (how the ski schedule writes it) or plain 24h
    [hh, mm] = [+t[1], +t[2]];
    assumed = false;
  }
  return { at: new Date(y, mo - 1, d, hh, mm).getTime(), assumed };
}

const fmtWhen = (ms) =>
  new Date(ms).toLocaleString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true });

// --- fetching -------------------------------------------------------------------
async function fetchPage(cfg, url) {
  const timeoutMs = cfg.site.timeoutMs || 30000;
  // fetch has no built-in timeout; without this a hung socket would stall the cycle.
  const ac = new AbortController();
  const killer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html' }, signal: ac.signal });
    if (!res.ok) throw new Error(`${url} returned HTTP ${res.status}`);
    const html = await res.text();
    // Fail SAFE: an error page / maintenance stub must not look like "everything was removed".
    if (html.length < 5000 || !/Skiing\s*&(amp;)?\s*Mountaineering/i.test(html))
      throw new Error(`${url} does not look like the IISM site (${html.length} bytes)`);
    return html;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`${url} timed out after ${timeoutMs}ms`);
    throw e;
  } finally {
    clearTimeout(killer);
  }
}

// One page 404ing (the site renamed its URLs in Oct 2026) must not blind the tracker to
// the others: failed pages come back in `failed`, and only an all-pages failure throws.
async function scrape(cfg) {
  const pages = {};
  const failed = {};
  for (const p of cfg.site.pages) {
    try {
      pages[p.name] = parsePage(await fetchPage(cfg, p.url));
    } catch (e) {
      failed[p.name] = e.message;
    }
  }
  if (!Object.keys(pages).length) throw new Error(Object.values(failed).join('; '));
  const all = Object.values(pages);
  const banners = uniq(all.flatMap((p) => p.banners));
  return {
    pages,
    failed,
    announcement: banners.length ? banners.join(' / ') : null,
    skiVisible: uniq(all.flatMap((p) => p.lines).filter((l) => isSki(cfg, l))),
    hiddenSki: uniq(all.flatMap((p) => p.hiddenLines).filter((l) => isSki(cfg, l))),
  };
}

// --- ntfy notification ------------------------------------------------------
async function notify(cfg, { title, message, priority, tags, click, actions }) {
  if (cfg.notify.type !== 'ntfy') {
    log('NOTIFY (no channel):', title, '-', message);
    return;
  }
  const url = `${cfg.notify.server.replace(/\/$/, '')}/${cfg.notify.topic}`;
  // HTTP header values must be Latin-1; strip non-ASCII (e.g. emoji) from the title.
  // Emoji still render fine via the message body and the Tags header (emoji shortcodes).
  const asciiTitle = String(title).replace(/[^\x00-\xFF]/g, '').trim() || 'IISM notifier';
  const headers = {
    Title: asciiTitle,
    Priority: priority || cfg.notify.priority || 'default',
  };
  if (tags) headers.Tags = tags;
  if (click) headers.Click = click;
  if (actions) headers.Actions = actions;
  // ntfy caps message bodies at 4096 bytes; trim instead of failing the push.
  const body = message.length > 3800 ? message.slice(0, 3800) + '\n…(truncated)' : message;
  const res = await fetch(url, { method: 'POST', headers, body });
  if (!res.ok) throw new Error(`ntfy push failed: HTTP ${res.status} ${await res.text()}`);
  log('ntfy push sent ->', cfg.notify.topic);
}

const applyAction = (cfg) => `view, Apply page, ${cfg.site.applyUrl}; view, Courses, ${cfg.site.coursesUrl}`;

// --- booking-time reminders -------------------------------------------------
function scheduleReminders(cfg, state, parsed, source, now) {
  if (!parsed || parsed.at <= now) return;
  if (state.reminders.some((r) => r.at === parsed.at)) return;
  for (const before of cfg.notify.reminderMinutesBefore) {
    const fireAt = parsed.at - before * 60_000;
    if (fireAt > now) state.reminders.push({ at: parsed.at, fireAt, before, source, assumed: parsed.assumed, sent: false });
  }
  log(`scheduled reminders for booking opening ${fmtWhen(parsed.at)} (from: ${source})`);
}

async function sendDueReminders(cfg, state, now) {
  // A reminder that is way overdue (box was off) is useless — skip it, but still let
  // the "it's open now" one through for a few hours: late is better than never.
  for (const r of state.reminders) {
    if (r.sent || now < r.fireAt) continue;
    const lateLimit = r.before === 0 ? 3 * 3_600_000 : 15 * 60_000;
    if (now - r.fireAt > lateLimit) {
      r.sent = true;
      continue;
    }
    const mins = Math.round((r.at - now) / 60_000);
    const open = mins <= 0;
    try {
      await notify(cfg, {
        title: open ? '🎿 IISM bookings are OPEN now' : `⏰ IISM bookings open in ${mins} min`,
        message:
          `${open ? 'Opened' : 'Opens'} ${fmtWhen(r.at)}${r.assumed ? ' (time not stated — assumed 10:00 AM)' : ''}.\n` +
          `Source: ${r.source}\n` +
          `Have your photo, DOB proof, qualification certificate and signature ready (jpg/png, under 500 KB) — ` +
          `the form needs OTP on your mobile.`,
        priority: 'urgent',
        tags: open ? 'skier,rotating_light' : 'alarm_clock,skier',
        click: cfg.site.applyUrl,
        actions: applyAction(cfg),
      });
      r.sent = true;
    } catch (e) {
      log('reminder push failed (will retry next wake):', e.message);
    }
  }
  // forget reminders for openings more than a day old
  state.reminders = state.reminders.filter((r) => now - r.at < 86_400_000);
}

function nextReminderAt(state) {
  const pending = state.reminders.filter((r) => !r.sent).map((r) => r.fireAt);
  return pending.length ? Math.min(...pending) : Infinity;
}

// --- daily summary: the once-a-day reminder AND the proof-of-life ------------
// Sends exactly one push per day, at/after notify.dailyHour (local time — set TZ in
// the container). If you ever STOP getting it, the tracker is dead.
async function maybeDailySummary(cfg, result, state, now) {
  const hour = cfg.notify.dailyHour;
  if (hour === undefined || hour === null || hour < 0) return; // disabled
  const d = new Date(now);
  if (d.getHours() < hour) return; // not time yet today
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  if (state.lastDailyDate === today) return; // already sent today

  const pending = state.reminders.filter((r) => !r.sent && r.before === 0);
  // Only ski lines carrying a year are a schedule; the rest is static boilerplate
  // ("Snow Skiing Course by IISM at Gulmarg." in the ticker, the about-us blurb, ...).
  const dated = result.skiVisible.filter((l) => /\b20\d\d\b|\b\d{1,2}\s*(st|nd|rd|th)?\s+[a-z]{3}/i.test(l));
  const lines = [
    dated.length
      ? `Snow-skiing schedule on the site:\n${dated.map((l) => `• ${l}`).join('\n')}`
      : 'No snow-skiing schedule published yet.',
    `Popup banner: ${result.announcement ?? '(none)'}`,
    `Hidden ski lines (comments): ${result.hiddenSki.length}`,
  ];
  if (pending.length) lines.push(`Booking reminder set for: ${pending.map((r) => fmtWhen(r.at)).join(', ')}`);
  try {
    await notify(cfg, {
      title: '🏔️ IISM daily check-in',
      message: lines.join('\n'),
      priority: 'min',
      tags: 'mountain_snow,calendar',
      click: cfg.site.coursesUrl,
    });
    state.lastDailyDate = today; // caller persists state at the end of the cycle
  } catch (e) {
    log('daily summary push failed:', e.message);
  }
}

// --- one full cycle: check, diff against state, alert -----------------------
async function runOnce(cfg) {
  const state = loadState();
  let now = Date.now();
  // Reminders don't depend on the site being up — send them before scraping.
  await sendDueReminders(cfg, state, now);
  saveState(state);

  let result;
  // small retry: the site / network can hiccup
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      result = await scrape(cfg);
      break;
    } catch (e) {
      log(`check attempt ${attempt} failed:`, e.message);
      if (attempt === 2) {
        log('giving up this cycle (state unchanged, no alert)');
        await trackFailures(cfg, state, { all: e.message });
        saveState(state);
        return;
      }
      await sleep(4000);
    }
  }
  now = Date.now();
  await trackFailures(cfg, state, result.failed);
  const partial = Object.keys(result.failed).length > 0;
  if (partial) {
    // A missing page's banner / hidden lines would look "removed" — keep the old ones.
    log(`partial check, failed: ${JSON.stringify(result.failed)}`);
    result.announcement ??= state.announcement;
    result.hiddenSki = state.hiddenSki;
  }

  const firstEver = !state.pages;
  const prevVisible = new Set(Object.values(state.pages || {}).flat().map(norm));
  const newLines = uniq(
    Object.values(result.pages).flatMap((p) => p.lines).filter((l) => !prevVisible.has(norm(l)))
  );
  const newSki = firstEver ? [] : newLines.filter((l) => isSki(cfg, l));
  const newOther = firstEver ? [] : newLines.filter((l) => !isSki(cfg, l));

  const prevHidden = new Set(state.hiddenSki.map(norm));
  const curHidden = new Set(result.hiddenSki.map(norm));
  const hiddenAdded = firstEver ? [] : result.hiddenSki.filter((l) => !prevHidden.has(norm(l)));
  const hiddenRemoved = firstEver ? [] : state.hiddenSki.filter((l) => !curHidden.has(norm(l)));

  const bannerChanged = !firstEver && norm(result.announcement ?? '') !== norm(state.announcement ?? '');

  log(
    `checked ${Object.keys(result.pages).length} pages: ski-visible=${result.skiVisible.length} ` +
      `hidden-ski=${result.hiddenSki.length} new-lines=${newLines.length}` +
      (firstEver ? ' (first check — recording baseline, no alerts)' : '')
  );
  log(`banner: ${result.announcement ?? '(none)'}`);

  // Booking reminders: from the banner always (it's the site-wide "bookings open"
  // notice), and from booking lines that appear in a cycle where ski content appeared.
  const BOOKING = /book|registr|admission|apply/i;
  if (result.announcement) scheduleReminders(cfg, state, parseBookingTime(result.announcement), `popup: "${result.announcement}"`, now);
  if (newSki.length)
    for (const l of newLines.filter((l) => BOOKING.test(l)))
      scheduleReminders(cfg, state, parseBookingTime(l), `"${l}"`, now);

  // ONE combined push per cycle, titled by the strongest signal.
  const sections = [];
  if (newSki.length) sections.push(`🎿 NEW ski-related on the site:\n${newSki.map((l) => `• ${l}`).join('\n')}`);
  if (bannerChanged) sections.push(`📢 Popup banner changed:\n${state.announcement ?? '(none)'}\n→ ${result.announcement ?? '(removed)'}`);
  if (hiddenAdded.length || hiddenRemoved.length) {
    const parts = [];
    if (hiddenAdded.length) parts.push(...hiddenAdded.map((l) => `+ ${l}`));
    if (hiddenRemoved.length) parts.push(...hiddenRemoved.map((l) => `− ${l}`));
    sections.push(`👀 Hint — hidden (not yet published) ski content changed:\n${parts.join('\n')}`);
  }
  if (newOther.length) sections.push(`🆕 Other new lines:\n${newOther.slice(0, 15).map((l) => `• ${l}`).join('\n')}${newOther.length > 15 ? `\n…and ${newOther.length - 15} more` : ''}`);
  const upcoming = state.reminders.filter((r) => !r.sent && r.before === 0);
  if (sections.length && upcoming.length)
    sections.push(`⏰ Reminders set for booking opening: ${upcoming.map((r) => fmtWhen(r.at)).join(', ')}`);

  if (sections.length) {
    const bannerSki = bannerChanged && isSki(cfg, result.announcement ?? '');
    let title, priority, tags;
    if (newSki.length || bannerSki) [title, priority, tags] = ['🎿 IISM: skiing course news!', 'urgent', 'skier,rotating_light'];
    else if (bannerChanged) [title, priority, tags] = ['📢 IISM popup banner changed', 'high', 'loudspeaker'];
    else if (hiddenAdded.length || hiddenRemoved.length) [title, priority, tags] = ['👀 IISM ski schedule being edited', 'default', 'eyes,skier'];
    else [title, priority, tags] = ['🆕 IISM site updated', 'low', 'mountain_snow'];
    try {
      await notify(cfg, {
        title,
        message: sections.join('\n\n'),
        priority,
        tags,
        click: cfg.site.coursesUrl,
        actions: applyAction(cfg),
      });
      state.lastAlertAt = now;
    } catch (e) {
      // Don't advance the baseline — otherwise the change is swallowed. Retry next cycle.
      log('alert push failed, keeping old baseline so it re-fires:', e.message);
      saveState(state);
      return;
    }
  }

  await maybeDailySummary(cfg, result, state, now);

  // keep the last good lines of any page that failed this time, so it doesn't re-alert on recovery
  state.pages = { ...state.pages, ...Object.fromEntries(Object.entries(result.pages).map(([k, p]) => [k, p.lines])) };
  state.hiddenSki = result.hiddenSki;
  state.announcement = result.announcement;
  delete state.failingSince; // pre-per-page-failures state fields
  delete state.failureAlerted;
  state.checkedAt = new Date().toISOString();
  saveState(state);
}

// Silence is ambiguous (nothing new vs. tracker broken), so if a page (or everything)
// keeps failing for a while, say so once per page. Reset when that page works again.
async function trackFailures(cfg, state, failed) {
  const now = Date.now();
  const prev = state.failures || {};
  state.failures = {};
  for (const [name, err] of Object.entries(failed)) {
    const f = (state.failures[name] = prev[name] || { since: now, alerted: false });
    const hours = cfg.notify.failureAlertHours ?? 6;
    if (f.alerted || now - f.since < hours * 3_600_000) continue;
    const url = cfg.site.pages.find((p) => p.name === name)?.url;
    try {
      await notify(cfg, {
        title: name === 'all' ? '⚠️ IISM tracker failing' : `⚠️ IISM tracker: ${name} page failing`,
        message:
          `Failing for ${Math.round((now - f.since) / 3_600_000)}h${url ? ` (${url})` : ''}.\nLast error: ${err}\n` +
          (/HTTP 404/.test(err) ? 'A 404 usually means the site renamed the page — update site.pages in config.json.\n' : '') +
          'Check the site / Instagram manually meanwhile.',
        priority: 'default',
        tags: 'warning',
        click: url || cfg.site.coursesUrl,
      });
      f.alerted = true;
    } catch (e) {
      log('failure alert push failed:', e.message);
    }
  }
}

// --- entrypoints ------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2);
  const cfg = loadConfig({ needTopic: !args.includes('--dump') });

  if (args.includes('--dump')) {
    const r = await scrape(cfg);
    for (const [name, p] of Object.entries(r.pages)) {
      console.log(`\n=== ${name}: ${p.lines.length} visible lines, ${p.hiddenLines.length} hidden ===`);
      p.lines.forEach((l) => console.log(`${isSki(cfg, l) ? '🎿' : '  '} ${l}`));
    }
    if (Object.keys(r.failed).length) console.log(`\n=== FAILED ===\n${JSON.stringify(r.failed, null, 2)}`);
    console.log(`\n=== banner ===\n${r.announcement}`);
    const parsed = r.announcement && parseBookingTime(r.announcement);
    console.log(`parsed booking time: ${parsed ? fmtWhen(parsed.at) + (parsed.assumed ? ' (time assumed)' : '') : '-'}`);
    console.log(`\n=== hidden ski lines ===\n${r.hiddenSki.join('\n')}`);
    return;
  }

  if (args.includes('--test-notify')) {
    await notify(cfg, {
      title: '✅ IISM notifier test',
      message: 'If you see this on your phone, ntfy is wired up correctly.\nWatching iismgulmarg.in for snow-skiing courses.',
      priority: 'default',
      tags: 'test_tube,skier',
      click: cfg.site.coursesUrl,
      actions: applyAction(cfg),
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
    const cycleHardLimitMs = Math.max(180_000, (cfg.site.timeoutMs || 30000) * cfg.site.pages.length * 3);
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
      // Wake early for a booking reminder — those need to land on the minute, not "within the hour".
      const regular = everyMs + Math.floor((Math.random() * 2 - 1) * jitterMs);
      const untilReminder = nextReminderAt(loadState()) - Date.now();
      const wait = Math.max(30_000, Math.min(regular, untilReminder));
      log(`next check in ${Math.round(wait / 1000)}s${untilReminder < regular ? ' (booking reminder)' : ''}`);
      await sleep(wait);
    }
  }

  // default: single check (for cron / systemd timer)
  await runOnce(cfg);
}

main().catch((e) => {
  log('FATAL:', e.stack || e.message);
  process.exit(1);
});
