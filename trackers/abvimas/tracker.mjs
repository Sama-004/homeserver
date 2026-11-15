#!/usr/bin/env node
// ABVIMAS Manali watcher -> ntfy push when a snow-skiing booking is announced or opens.
// Usage:
//   node tracker.mjs [--once]        run one check, write next-run, exit (the default)
//   node tracker.mjs --test-notify   send a test ntfy push and exit
//   node tracker.mjs --dump          print what the parser sees and exit (no push, no state)
// In Docker, ../run-loop.sh runs the check and sleeps until the time in next-run.
//
// abvimas.org is server-rendered PHP. Four things are watched, strongest signal first:
//   1. SLOTS   — the Apply Online step-2 booking table for Skiing/Snowboarding, per session.
//                A skiing row appearing means booking is LIVE; it carries Available Seats.
//   2. NOTICES — the Notice Board. ABVIMAS announces each skiing batch's booking there
//                1-6 days ahead ("... Will be open on 24th January, 2026 at 11:00 AM").
//                The date+time becomes exact-time reminders.
//   3. SESSION — a new session (e.g. "2027") in the Apply Online step-1 dropdown.
//   4. CHART   — the Basic Snow Skiing course page's seat chart (activity codes + dates).

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { setDefaultAutoSelectFamilyAttemptTimeout } from 'node:net';

// Node's happy-eyeballs connect gives each address family only 250ms by default, too tight
// from behind Docker NAT: pushes died as a bare "fetch failed" with the network fine.
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
  if (process.env.NTFY_TOPIC) cfg.notify.topic = process.env.NTFY_TOPIC;
  if (process.env.NTFY_SERVER) cfg.notify.server = process.env.NTFY_SERVER;
  if (needTopic && !cfg.notify.topic) {
    throw new Error(`Missing required secret: NTFY_TOPIC. Set it in ${ENV_FILE} or export it in the environment.`);
  }
  cfg.skiRe = new RegExp(cfg.match.skiPattern, 'i');
  cfg.targetRe = new RegExp(cfg.match.targetPattern, 'i');
  return cfg;
}

const EMPTY_STATE = { notices: null, sessions: null, slots: null, chart: null, reminders: [], lowAlerted: [] };
function loadState() {
  if (!existsSync(STATE_PATH)) return structuredClone(EMPTY_STATE);
  try {
    return { ...structuredClone(EMPTY_STATE), ...JSON.parse(readFileSync(STATE_PATH, 'utf8')) };
  } catch {
    return structuredClone(EMPTY_STATE);
  }
}
const saveState = (s) => writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));

// --- HTML helpers ---------------------------------------------------------------
function decodeEntities(s) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', times: '×', rsquo: '’', lsquo: '‘', ndash: '–', mdash: '—', hellip: '…' };
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => named[n.toLowerCase()] ?? m);
}
const text = (html) => decodeEntities(html.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
function toLines(html) {
  const t = html
    .replace(/<(script|style|head|noscript)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/\s+/g, ' ')
    .replace(/<\/t[dh]>/gi, ' | ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(p|li|tr|div|h[1-6]|table|thead|tbody|ul|ol|section)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(t)
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').replace(/(\s*\|\s*)+$/, '').replace(/^(\s*\|\s*)+/, '').trim())
    .filter((l) => l.length > 1);
}
const cellsOf = (rowHtml) => [...rowHtml.matchAll(/<t([dh])\b[^>]*>([\s\S]*?)<\/t\1>/gi)].map((m) => ({ text: text(m[2]), html: m[2] }));
const norm = (l) => String(l).toLowerCase().replace(/\s+/g, ' ').trim();
const int = (s) => {
  const m = /-?\d+/.exec(String(s ?? '').replace(/,/g, ''));
  return m ? Number(m[0]) : null;
};

// --- fetching -------------------------------------------------------------------
async function fetchPage(cfg, url) {
  const timeoutMs = cfg.site.timeoutMs || 30000;
  const ac = new AbortController();
  const killer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html' }, signal: ac.signal });
    if (!res.ok) throw new Error(`${url} returned HTTP ${res.status}`);
    const html = await res.text();
    // Fail SAFE: an error page / maintenance stub must not look like "everything was removed".
    if (html.length < 5000 || !/ABVIMAS/.test(html)) throw new Error(`${url} does not look like the ABVIMAS site (${html.length} bytes)`);
    return html;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`${url} timed out after ${timeoutMs}ms`);
    throw e;
  } finally {
    clearTimeout(killer);
  }
}

// --- parsers (each throws if the page isn't shaped as expected: fail safe) ------
// Notice Board: rows of  # | Notice Title | Publish Date | <a href=".../notice-detail/ID">
function parseNotices(html) {
  const out = [];
  for (const row of html.match(/<tr\b[\s\S]*?<\/tr>/gi) || []) {
    const id = /notice-detail\/(\d+)/.exec(row)?.[1];
    if (!id) continue;
    const c = cellsOf(row);
    if (c.length < 3) continue;
    out.push({ id: Number(id), title: c[1].text, date: c[2].text });
  }
  if (!out.length) throw new Error('notice board: no notices parsed (page layout changed?)');
  return out;
}

// One notice's page: its text and any attachment (PDF / image on admin.abvimas.org).
function parseNoticeDetail(html) {
  const lines = toLines(html);
  const from = lines.findIndex((l) => /^Notice Detail\s*:-/i.test(l) || /^Notice Title\s*:-/i.test(l));
  const to = lines.findIndex((l, i) => i > from && /^Quick Links$/i.test(l));
  const body = from >= 0 ? lines.slice(from, to > from ? to : from + 30) : [];
  const attachments = [...new Set([...html.matchAll(/https?:\/\/admin\.abvimas\.org\/uploads\/[^"'\s)]+/gi)].map((m) => m[0]))];
  return { text: body.filter((l) => !/^Notice (Title|Publish Date)\s*:-/i.test(l) && !/^Download Notice/i.test(l)).join('\n').replace(/^Notice Detail\s*:-\s*/i, ''), attachments };
}

// Apply Online step 1: <select id="session"> options.
function parseSessions(html) {
  const sel = /<select\b[^>]*id="session"[^>]*>([\s\S]*?)<\/select>/i.exec(html);
  if (!sel) throw new Error('apply step 1: no session dropdown (page layout changed?)');
  const out = [...sel[1].matchAll(/<option\b[^>]*value="(\d+)"[^>]*>([^<]*)/gi)].map((m) => ({ id: Number(m[1]), name: text(m[2]) }));
  if (!out.length) throw new Error('apply step 1: session dropdown is empty');
  return out;
}

// Apply Online step 2 for one session: the booking table (or "Slots are Not Available").
// Rows are read by the table's own column headers, so a reordered table still parses.
function parseSlots(html) {
  if (!/Selected Session\s*:-/i.test(html)) throw new Error('apply step 2: not the booking page (layout changed?)');
  if (/Slots are Not Available/i.test(html)) return [];
  const table = /<table\b[\s\S]*?<\/table>/i.exec(html.slice(html.search(/Selected Activity/i)))?.[0];
  if (!table) return [];
  const head = (/<thead\b[\s\S]*?<\/thead>/i.exec(table)?.[0] || table.match(/<tr\b[\s\S]*?<\/tr>/i)?.[0] || '');
  const headers = cellsOf(head).map((c) => norm(c.text));
  const col = (re) => headers.findIndex((h) => re.test(h));
  const idx = {
    location: col(/location/), code: col(/code/), course: col(/course name/), slot: col(/slot/), age: col(/age/),
    fee: col(/indian/), total: col(/total/), available: col(/available/),
  };
  if (idx.course < 0 || idx.available < 0) throw new Error(`apply step 2: unexpected table headers: ${headers.join(' | ')}`);
  const body = /<tbody\b[\s\S]*?<\/tbody>/i.exec(table)?.[0] ?? table.replace(head, '');
  const rows = [];
  for (const tr of body.match(/<tr\b[\s\S]*?<\/tr>/gi) || []) {
    const c = cellsOf(tr);
    if (c.length <= idx.available) continue;
    const get = (k) => (idx[k] >= 0 ? c[idx[k]]?.text ?? '' : '');
    rows.push({
      location: get('location'), code: get('code'), course: get('course'), slot: get('slot'), age: get('age'), fee: get('fee'),
      total: int(get('total')), available: int(get('available')),
      link: /href="([^"]+)"/.exec(tr)?.[1] || null,
    });
  }
  return rows;
}

// Course page seat chart: the "Seats Chart" table (activity code | duration | venue).
function parseChart(html) {
  const lines = toLines(html);
  const from = lines.findIndex((l) => /^Seats? Chart$/i.test(l));
  const to = lines.findIndex((l, i) => i > from && /^Quick Links$/i.test(l));
  if (from < 0 || to < 0) throw new Error('course page: seat chart not found (layout changed?)');
  return lines.slice(from + 1, to).filter((l) => !/^Note\s*:-/i.test(l) && !/^Activity Code/i.test(l));
}

// --- booking time parsing ---------------------------------------------------------
// Only the text after "open(s) on / from" counts: notice titles also carry the COURSE
// dates ("[27-01-2026 to 09-02-2026]"), which must not be mistaken for the opening.
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
function parseBookingTime(textIn) {
  const open = /\b(?:will\s+be\s+)?open(?:s|ed|ing)?\b(?:\s+(?:on|from|at))?\s*/i.exec(textIn);
  if (!open) return null;
  const s = textIn.slice(open.index + open[0].length);
  let d, mo, y, m;
  if ((m = /^\D{0,20}?(\d{1,2})\s*(?:st|nd|rd|th)?\s+([a-z]{3})[a-z]*\.?,?\s+(\d{4})\b/i.exec(s))) {
    [d, mo, y] = [+m[1], MONTHS.indexOf(m[2].toLowerCase()) + 1, +m[3]];
  } else if ((m = /^\D{0,20}?(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})\b/.exec(s))) {
    [d, mo, y] = [+m[1], +m[2], +m[3]];
  } else return null;
  if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return null;
  // ABVIMAS has opened at 11:00 AM and 12:30 PM; with no time stated, assume 10:00 AM (early is safe).
  let hh = 10, mm = 0, assumed = true, t;
  const rest = s.slice(m.index + m[0].length, m.index + m[0].length + 40);
  if ((t = /\b(\d{1,2})(?:[:.](\d{2}))?\s*([ap])\.?\s*m\b/i.exec(rest))) {
    [hh, mm, assumed] = [(+t[1] % 12) + (t[3].toLowerCase() === 'p' ? 12 : 0), +(t[2] || 0), false];
  } else if ((t = /\b([01]?\d|2[0-3])[:.]([0-5]\d)\b/.exec(rest))) {
    [hh, mm, assumed] = [+t[1], +t[2], false];
  }
  return { at: new Date(y, mo - 1, d, hh, mm).getTime(), assumed };
}
const fmtWhen = (ms) =>
  new Date(ms).toLocaleString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true });

// --- scrape ---------------------------------------------------------------------
const stepTwoUrl = (cfg, s) =>
  `${cfg.site.base}/course/apply-second-step/${s.id}/${cfg.site.activityId}/${encodeURIComponent(s.name)}/${cfg.site.activitySlug}`;

// Each part fails on its own: a broken part keeps its last good state (no false alerts).
async function scrape(cfg) {
  const r = { failed: {} };
  const part = async (name, fn) => {
    try {
      r[name] = await fn();
    } catch (e) {
      r.failed[name] = e.message;
    }
  };
  await part('notices', async () => parseNotices(await fetchPage(cfg, cfg.site.noticesUrl)));
  await part('sessions', async () => parseSessions(await fetchPage(cfg, cfg.site.applyFirstUrl)));
  await part('chart', async () => parseChart(await fetchPage(cfg, cfg.site.courseUrl)));
  // The booking table of every listed session, plus the next session id before it is listed
  // (the step-2 URL answers by id, so a new session's slots can show before the dropdown does).
  await part('slots', async () => {
    const sessions = [...(r.sessions || [])];
    if (sessions.length) {
      const top = sessions.reduce((a, b) => (a.id > b.id ? a : b));
      sessions.push({ id: top.id + 1, name: String((int(top.name) ?? 0) + 1), probe: true });
    }
    const slots = [];
    for (const s of sessions) {
      const rows = parseSlots(await fetchPage(cfg, stepTwoUrl(cfg, s)));
      for (const row of rows) slots.push({ ...row, session: s.name, sessionId: s.id, url: stepTwoUrl(cfg, s) });
    }
    return slots;
  });
  if (Object.keys(r.failed).length === 4) throw new Error(Object.values(r.failed).join('; '));
  return r;
}

// --- ntfy -----------------------------------------------------------------------
async function notify(cfg, { title, message, priority, tags, click, actions }) {
  if (cfg.notify.type !== 'ntfy') {
    log('NOTIFY (no channel):', title, '-', message);
    return;
  }
  const url = `${cfg.notify.server.replace(/\/$/, '')}/${cfg.notify.topic}`;
  // Header values must be Latin-1: strip emoji from the title (they render via Tags).
  const headers = { Title: String(title).replace(/[^\x00-\xFF]/g, '').trim() || 'ABVIMAS notifier', Priority: priority || cfg.notify.priority || 'default' };
  if (tags) headers.Tags = tags;
  if (click) headers.Click = click;
  if (actions) headers.Actions = actions;
  const body = message.length > 3800 ? message.slice(0, 3800) + '\n…(truncated)' : message;
  const res = await fetch(url, { method: 'POST', headers, body });
  if (!res.ok) throw new Error(`ntfy push failed: HTTP ${res.status} ${await res.text()}`);
  log('ntfy push sent');
}
const links = (cfg, applyUrl) =>
  `view, Apply, ${applyUrl || cfg.site.applyFirstUrl}; view, Notices, ${cfg.site.noticesUrl}; view, Course, ${cfg.site.courseUrl}`;

// --- booking-time reminders -------------------------------------------------------
function scheduleReminders(cfg, state, parsed, source, now) {
  if (!parsed || parsed.at <= now) return false;
  if (state.reminders.some((r) => r.at === parsed.at)) return false;
  for (const before of cfg.notify.reminderMinutesBefore) {
    const fireAt = parsed.at - before * 60_000;
    if (fireAt > now) state.reminders.push({ at: parsed.at, fireAt, before, source, assumed: parsed.assumed, sent: false });
  }
  log(`scheduled reminders for booking opening ${fmtWhen(parsed.at)} (from: ${source})`);
  return true;
}

async function sendDueReminders(cfg, state, now) {
  for (const r of state.reminders) {
    if (r.sent || now < r.fireAt) continue;
    // Way overdue (box was off) is useless — except "open now", which stays useful for hours.
    if (now - r.fireAt > (r.before === 0 ? 3 * 3_600_000 : 15 * 60_000)) {
      r.sent = true;
      continue;
    }
    const mins = Math.round((r.at - now) / 60_000);
    const open = mins <= 0;
    const left = mins >= 120 ? `${Math.round(mins / 60)} h` : `${mins} min`;
    try {
      await notify(cfg, {
        title: open ? '🎿 ABVIMAS booking opens NOW' : `⏰ ABVIMAS booking opens in ${left}`,
        message:
          `${open ? 'Opened' : 'Opens'} ${fmtWhen(r.at)}${r.assumed ? ' (time not stated: assumed 10:00 AM, check the notice)' : ''}.\n` +
          `Notice: ${r.source}\n` +
          'Documents as JPG/JPEG only (no PDF): photo, 10th certificate, Aadhaar front + back, risk certificate, medical certificate (under 3 months old).',
        priority: 'urgent',
        tags: open ? 'skier,rotating_light' : 'alarm_clock,skier',
        click: cfg.site.applyFirstUrl,
        actions: links(cfg),
      });
      r.sent = true;
    } catch (e) {
      log('reminder push failed (will retry next wake):', e.message);
      process.exitCode = CHECK_FAILED;
    }
  }
  state.reminders = state.reminders.filter((r) => now - r.at < 86_400_000);
}

// --- daily check-in: the heartbeat ----------------------------------------------
async function maybeDaily(cfg, result, state, now) {
  const hour = cfg.notify.dailyHour;
  if (hour == null || hour < 0) return;
  const d = new Date(now);
  if (d.getHours() < hour) return;
  const today = d.toLocaleDateString('en-CA');
  if (state.lastDailyDate === today) return;
  const ski = (state.notices || []).filter((n) => cfg.skiRe.test(n.title)).sort((a, b) => b.id - a.id);
  const slots = (state.slots || []).filter((s) => cfg.skiRe.test(s.course));
  const pending = state.reminders.filter((r) => !r.sent && r.before === 0);
  const lines = [
    slots.length
      ? `Skiing slots bookable now:\n${slots.map((s) => `• ${s.course} ${s.slot}: ${s.available}/${s.total} seats`).join('\n')}`
      : 'No skiing slots open for booking.',
    `Sessions: ${(state.sessions || []).map((s) => s.name).join(', ') || '?'}`,
    `Latest skiing notice: ${ski[0] ? `${ski[0].title} (${ski[0].date})` : 'none'}`,
  ];
  if (pending.length) lines.push(`Booking reminder set for: ${pending.map((r) => fmtWhen(r.at)).join(', ')}`);
  if (Object.keys(result.failed).length) lines.push(`Failing now: ${Object.keys(result.failed).join(', ')}`);
  try {
    await notify(cfg, { title: '🏔️ ABVIMAS daily check-in', message: lines.join('\n'), priority: 'min', tags: 'mountain_snow,calendar', click: cfg.site.noticesUrl });
    state.lastDailyDate = today;
  } catch (e) {
    log('daily check-in push failed:', e.message);
  }
}

// --- one cycle ------------------------------------------------------------------
const slotKey = (s) => `${s.sessionId}|${s.code}|${norm(s.course)}|${norm(s.slot)}`;

async function runOnce(cfg) {
  const state = loadState();
  let now = Date.now();
  await sendDueReminders(cfg, state, now);
  saveState(state);

  let result;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      result = await scrape(cfg);
      break;
    } catch (e) {
      log(`check attempt ${attempt} failed:`, e.message);
      if (attempt === 2) {
        process.exitCode = CHECK_FAILED;
        await trackFailures(cfg, state, { all: e.message });
        saveState(state);
        return;
      }
      await sleep(4000);
    }
  }
  now = Date.now();
  await trackFailures(cfg, state, result.failed);
  if (Object.keys(result.failed).length) log(`partial check, failed: ${JSON.stringify(result.failed)}`);

  const sections = [];
  let level = 0; // 0 low, 1 default, 2 high, 3 urgent
  let title = '🆕 ABVIMAS site updated';
  let applyUrl = null;
  const bump = (l, t) => {
    if (l > level) [level, title] = [l, t];
  };

  // 1. SLOTS
  if (result.slots) {
    if (state.slots) {
      const prev = new Map(state.slots.map((s) => [slotKey(s), s]));
      const cur = new Map(result.slots.map((s) => [slotKey(s), s]));
      const added = result.slots.filter((s) => !prev.has(slotKey(s)));
      const addedSki = added.filter((s) => cfg.skiRe.test(s.course));
      if (addedSki.length) {
        const target = addedSki.filter((s) => cfg.targetRe.test(s.course));
        sections.push(`🎿 BOOKING IS LIVE (session ${addedSki[0].session}):\n${addedSki.map((s) => `• ${s.course} | ${s.slot} | ${s.available}/${s.total} seats left | code ${s.code}`).join('\n')}`);
        applyUrl = (target[0] || addedSki[0]).url;
        bump(3, target.length ? '🎿 ABVIMAS Basic Skiing booking is LIVE' : '🎿 ABVIMAS skiing booking is LIVE');
      }
      const otherAdded = added.filter((s) => !cfg.skiRe.test(s.course));
      if (otherAdded.length) {
        sections.push(`New bookable courses:\n${otherAdded.map((s) => `• ${s.course} | ${s.slot} | ${s.available}/${s.total}`).join('\n')}`);
        bump(0, '🆕 ABVIMAS: new courses bookable');
      }
      // Seat changes on your course's rows: back from 0, gone to 0, or running low (once).
      for (const s of result.slots.filter((s) => cfg.targetRe.test(s.course) && prev.has(slotKey(s)))) {
        const p = prev.get(slotKey(s));
        const k = slotKey(s);
        if ((p.available ?? 0) <= 0 && s.available > 0) {
          sections.push(`🎿 Seats back: ${s.course} ${s.slot}: ${s.available}/${s.total}`);
          applyUrl ??= s.url;
          bump(3, '🎿 ABVIMAS Basic Skiing: seats available');
        } else if ((p.available ?? 0) > 0 && s.available <= 0) {
          sections.push(`Full now: ${s.course} ${s.slot} (0/${s.total})`);
          bump(1, 'ABVIMAS: a skiing slot is full');
        } else if (s.available > 0 && s.available < cfg.notify.lowSeats && !state.lowAlerted.includes(k)) {
          sections.push(`⚠️ Only ${s.available} seats left: ${s.course} ${s.slot}`);
          state.lowAlerted.push(k);
          applyUrl ??= s.url;
          bump(2, '⚠️ ABVIMAS Basic Skiing: seats running out');
        }
      }
      const removed = state.slots.filter((s) => !cur.has(slotKey(s)) && cfg.skiRe.test(s.course));
      if (removed.length) sections.push(`No longer listed: ${removed.map((s) => `${s.course} ${s.slot}`).join('; ')}`);
      state.lowAlerted = state.lowAlerted.filter((k) => cur.has(k));
    }
  }

  // 2. NOTICES
  if (result.notices) {
    if (state.notices) {
      const seen = new Set(state.notices.map((n) => n.id));
      const fresh = result.notices.filter((n) => !seen.has(n.id)).sort((a, b) => a.id - b.id);
      for (const n of fresh) {
        const ski = cfg.skiRe.test(n.title);
        let detail = { text: '', attachments: [] };
        try {
          detail = parseNoticeDetail(await fetchPage(cfg, `${cfg.site.base}/notice-detail/${n.id}`));
        } catch (e) {
          log(`notice ${n.id} detail failed:`, e.message);
        }
        const body = detail.text && norm(detail.text) !== norm(n.title) ? `\n${detail.text.slice(0, 600)}` : '';
        const files = detail.attachments.length ? `\nAttachment: ${detail.attachments.join(' ')}` : '';
        // Title or body, whichever names a future opening (a reposted notice can keep an old date in one of them).
        const times = [parseBookingTime(n.title), parseBookingTime(detail.text)].filter(Boolean);
        const when = times.find((t) => t.at > now) || times[0];
        const scheduled = when && scheduleReminders(cfg, state, when, `"${n.title}"`, now);
        sections.push(
          `${ski ? '🎿' : '📌'} New notice (${n.date}): ${n.title}${body}${files}` +
            (when ? `\n⏰ Booking opens ${fmtWhen(when.at)}${when.assumed ? ' (time not stated)' : ''}${scheduled ? ': reminders set' : ''}` : '')
        );
        bump(ski ? 3 : 1, ski ? '🎿 ABVIMAS: new skiing notice' : '📌 ABVIMAS: new notice');
      }
    } else {
      // first run: still pick up an upcoming opening from the existing skiing notices
      for (const n of result.notices.filter((n) => cfg.skiRe.test(n.title))) scheduleReminders(cfg, state, parseBookingTime(n.title), `"${n.title}"`, now);
    }
  }

  // 3. SESSIONS
  if (result.sessions && state.sessions) {
    const seen = new Set(state.sessions.map((s) => s.id));
    const added = result.sessions.filter((s) => !seen.has(s.id));
    if (added.length) {
      sections.push(`📅 New booking session on Apply Online: ${added.map((s) => s.name).join(', ')}. Skiing slots usually follow.`);
      bump(2, `📅 ABVIMAS: session ${added.map((s) => s.name).join(', ')} added`);
    }
  }

  // 4. SEAT CHART on the course page
  if (result.chart && state.chart) {
    const prev = new Set(state.chart.map(norm));
    const cur = new Set(result.chart.map(norm));
    const add = result.chart.filter((l) => !prev.has(norm(l)));
    const del = state.chart.filter((l) => !cur.has(norm(l)));
    if (add.length || del.length) {
      sections.push(`Basic Skiing seat chart changed:\n${[...add.map((l) => `+ ${l}`), ...del.map((l) => `− ${l}`)].join('\n')}`);
      bump(1, 'ABVIMAS: skiing course dates changed');
    }
  }

  const firstEver = !state.notices && !state.slots && !state.sessions && !state.chart;
  log(
    `notices=${result.notices?.length ?? 'FAILED'} sessions=${result.sessions?.map((s) => s.name).join(',') ?? 'FAILED'} ` +
      `slots=${result.slots?.length ?? 'FAILED'} (ski ${result.slots?.filter((s) => cfg.skiRe.test(s.course)).length ?? '-'}) ` +
      `chart=${result.chart?.length ?? 'FAILED'}${firstEver ? ' (first check: baseline, no alerts)' : ''}`
  );

  if (sections.length) {
    const upcoming = state.reminders.filter((r) => !r.sent && r.before === 0);
    if (upcoming.length && level < 3) sections.push(`⏰ Booking opening on: ${upcoming.map((r) => fmtWhen(r.at)).join(', ')}`);
    try {
      await notify(cfg, {
        title,
        message: sections.join('\n\n'),
        priority: ['low', 'default', 'high', 'urgent'][level],
        tags: level === 3 ? 'skier,rotating_light' : 'mountain_snow',
        click: applyUrl || cfg.site.noticesUrl,
        actions: links(cfg, applyUrl),
      });
    } catch (e) {
      // Don't advance the baseline, or the change is swallowed. Re-fires next cycle.
      log('alert push failed, keeping old baseline so it re-fires:', e.message);
      process.exitCode = CHECK_FAILED;
      saveState(state);
      return;
    }
  }

  for (const k of ['notices', 'sessions', 'slots', 'chart']) if (result[k]) state[k] = result[k];
  await maybeDaily(cfg, result, state, now);
  state.checkedAt = new Date().toISOString();
  saveState(state);
}

// Silence is ambiguous (nothing new vs. broken): if a part keeps failing, say so once.
async function trackFailures(cfg, state, failed) {
  const now = Date.now();
  const prev = state.failures || {};
  state.failures = {};
  for (const [name, err] of Object.entries(failed)) {
    const f = (state.failures[name] = prev[name] || { since: now, alerted: false });
    if (f.alerted || now - f.since < (cfg.notify.failureAlertHours ?? 6) * 3_600_000) continue;
    try {
      await notify(cfg, {
        title: name === 'all' ? '⚠️ ABVIMAS tracker failing' : `⚠️ ABVIMAS tracker: ${name} failing`,
        message: `Failing for ${Math.round((now - f.since) / 3_600_000)}h.\nLast error: ${err}\nCheck the notice board by hand meanwhile.`,
        priority: 'default',
        tags: 'warning',
        click: cfg.site.noticesUrl,
      });
      f.alerted = true;
    } catch (e) {
      log('failure alert push failed:', e.message);
    }
  }
}

// --- entrypoints ----------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2);
  const cfg = loadConfig({ needTopic: !args.includes('--dump') });

  if (args.includes('--dump')) {
    const r = await scrape(cfg);
    console.log('=== notices (newest 12) ===');
    for (const n of (r.notices || []).slice(0, 12)) {
      const p = parseBookingTime(n.title);
      console.log(`${cfg.skiRe.test(n.title) ? '🎿' : '  '} #${n.id} ${n.date}: ${n.title}${p ? `  ⏰ ${fmtWhen(p.at)}${p.assumed ? ' (assumed time)' : ''}` : ''}`);
    }
    console.log(`\n=== sessions ===\n${(r.sessions || []).map((s) => `${s.id} = ${s.name}`).join('\n')}`);
    console.log(`\n=== skiing booking table (all sessions + next id) ===\n${(r.slots || []).map((s) => `${s.session}: ${s.course} | ${s.slot} | ${s.available}/${s.total} | ${s.code}`).join('\n') || '(no slots listed)'}`);
    console.log(`\n=== seat chart ===\n${(r.chart || []).join('\n')}`);
    if (Object.keys(r.failed).length) console.log(`\n=== FAILED ===\n${JSON.stringify(r.failed, null, 2)}`);
    return;
  }

  if (args.includes('--test-notify')) {
    await notify(cfg, {
      title: '✅ ABVIMAS notifier test',
      message: 'If you see this, ntfy works.\nWatching abvimas.org for skiing booking notices, openings and seats.',
      priority: 'default',
      tags: 'test_tube,skier',
      click: cfg.site.noticesUrl,
      actions: links(cfg),
    });
    return;
  }

  try {
    await runOnce(cfg);
  } finally {
    scheduleNext(cfg);
  }
}

// next-run: unix seconds of the next check. A due reminder pulls it forward to the minute,
// and around a known opening it checks every fastIntervalSeconds.
function scheduleNext(cfg) {
  const w = cfg.watch;
  const now = Date.now();
  const state = loadState();
  const jitter = Math.floor((Math.random() * 2 - 1) * (w.jitterSeconds || 0) * 1000);
  let next = now + (w.intervalMinutes || 10) * 60_000 + jitter;
  const openings = [...new Set(state.reminders.map((r) => r.at))];
  if (openings.some((at) => now >= at - w.fastBeforeMinutes * 60_000 && now <= at + w.fastAfterMinutes * 60_000)) {
    next = Math.min(next, now + (w.fastIntervalSeconds || 60) * 1000);
  }
  const pending = state.reminders.filter((r) => !r.sent).map((r) => r.fireAt);
  // the fast window's start counts as a wake-up too
  pending.push(...openings.map((at) => at - w.fastBeforeMinutes * 60_000).filter((t) => t > now));
  if (pending.length) next = Math.min(next, Math.max(now + 1000, Math.min(...pending)));
  if (next - now < (w.intervalMinutes || 10) * 60_000 - 120_000) log(`next check at ${fmtWhen(next)}`);
  writeFileSync(NEXT_RUN_PATH, String(Math.ceil(next / 1000)));
}

main().catch((e) => {
  log('FATAL:', e.stack || e.message);
  process.exit(1);
});
