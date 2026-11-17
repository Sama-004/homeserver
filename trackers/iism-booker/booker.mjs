#!/usr/bin/env node
// IISM Gulmarg booker: watches every allowed batch's "Available Seats" and, the moment one
// shows a seat, books it with headless Chromium running the user's own autofill userscript.
// Pushes the result (with a screenshot) to ntfy.
//
//   node booker.mjs              run forever (the container's process)
//   node booker.mjs --check      one seat check, print it, exit (no booking, no push)
//   node booker.mjs --test-notify
//
// Detection is plain HTTP with a DUMMY mobile number. The form keeps all its state in the
// page (no cookies, no session), so after one course -> level walk the saved page can ask
// for every batch's seats at once, in parallel: a full check is one round trip.
// Booking uses the user's real number in a fresh browser tab per (course, batch) with
// seats, so the site's own JavaScript and validators run exactly as in a real browser.
// It stops for good after the first submit that the site accepts (data/booked.json).

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { setDefaultAutoSelectFamilyAttemptTimeout } from 'node:net';

try {
  setDefaultAutoSelectFamilyAttemptTimeout(2000);
} catch {}

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.CONFIG_PATH || join(HERE, 'config.json');
const DATA = process.env.DATA_DIR || join(HERE, 'data');
const ENV_FILE = process.env.ENV_FILE || join(HERE, '.env');
try {
  if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
} catch {}
mkdirSync(join(DATA, 'shots'), { recursive: true });

const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
const NTFY = { server: (process.env.NTFY_SERVER || cfg.notify.server).replace(/\/$/, ''), topic: process.env.NTFY_TOPIC };
const MOBILE = process.env.IISM_MOBILE;
const FORM = cfg.site.formUrl;
const DUMMY_URL = `${FORM}?mobile=${cfg.site.dummyMobile}`;
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const TARGETS = cfg.targets.map((t) => ({ ...t, courseRe: new RegExp(t.course, 'i'), levelRe: new RegExp(t.level, 'i') }));

const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (f, d) => {
  try {
    return JSON.parse(readFileSync(join(DATA, f), 'utf8'));
  } catch {
    return d;
  }
};
const writeJson = (f, v) => writeFileSync(join(DATA, f), JSON.stringify(v, null, 2));

// --- ntfy -----------------------------------------------------------------------
// Everything goes in the query string (UTF-8 safe); a screenshot goes as the body.
async function push({ title, message, priority = 'high', tags = 'skier', click, file, filename }) {
  if (!NTFY.topic) return log('PUSH (no NTFY_TOPIC):', title, '|', message);
  const q = new URLSearchParams({ title, priority, tags });
  if (click) q.set('click', click);
  if (file) q.set('message', message.slice(0, 3500)), q.set('filename', filename || 'page.png');
  const res = await fetch(`${NTFY.server}/${NTFY.topic}?${q}`, { method: file ? 'PUT' : 'POST', body: file || message.slice(0, 3800) });
  if (!res.ok) throw new Error(`ntfy HTTP ${res.status}`);
}
const pushSafe = (p) => push(p).catch((e) => log('push failed:', e.message));

// --- detection: HTTP with the dummy number -----------------------------------------------
const decode = (s) => s.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');
const norm = (s) => decode(String(s)).replace(/\s+/g, ' ').trim();
function options(html, name) {
  const m = new RegExp(`<select name="${name}"[\\s\\S]*?</select>`).exec(html);
  if (!m) return [];
  return [...m[0].matchAll(/<option[^>]*value="([^"]*)"[^>]*>([^<]*)/g)].filter(([, v]) => v && v !== '0').map(([, value, text]) => ({ value, text: norm(text) }));
}
function fields(html) {
  const f = {};
  for (const tag of html.match(/<input\b[^>]*>/g) || []) {
    if (!/type="hidden"/.test(tag)) continue;
    const name = /name="([^"]+)"/.exec(tag)?.[1];
    if (name) f[name] = decode(/value="([^"]*)"/.exec(tag)?.[1] ?? '');
  }
  for (const [, name, body] of html.matchAll(/<select name="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) {
    f[name] = /<option selected="selected" value="([^"]*)"/.exec(body)?.[1] ?? '0';
  }
  return f;
}
const seatsOf = (html) => Number(/name="txtAvailableSeat"[^>]*value="([^"]*)"/.exec(html)?.[1] ?? NaN);

async function http(body) {
  const ac = new AbortController();
  const killer = setTimeout(() => ac.abort(), cfg.watch.timeoutSeconds * 1000);
  try {
    const res = await fetch(DUMMY_URL, {
      method: body ? 'POST' : 'GET',
      headers: { 'User-Agent': UA, ...(body && { 'Content-Type': 'application/x-www-form-urlencoded' }) },
      body: body && new URLSearchParams(body).toString(),
      signal: ac.signal,
    });
    const html = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (!html.includes('ddlCourse')) throw new Error(/viewstate/i.test(html) ? 'viewstate rejected' : 'not the form page');
    return html;
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? 'timed out' : e.message);
  } finally {
    clearTimeout(killer);
  }
}
const postback = (page, target, value, extra) => http({ ...fields(page), ...extra, __EVENTTARGET: target, __EVENTARGUMENT: '', [target]: value });

// The course -> level walk, once per target, saved for the parallel batch checks.
let saved = null;
const staticAlerts = new Set(); // alert('...') texts that are part of the blank form's own code (e.g. the 1 MB check)
const alertsIn = (html) => [...html.matchAll(/alert\((['"])(.*?)\1\)/g)].map((m) => m[2]); // [{ti, course, level, page, batches}] — targets not listed are left out
let savedAt = 0;
async function build() {
  const base = await http(null);
  for (const t of alertsIn(base)) staticAlerts.add(t);
  const state = options(base, 'ddlState').find((o) => o.text.toUpperCase() === cfg.state.toUpperCase());
  const extra = state ? { ddlState: state.value } : {};
  const out = [];
  const afterCourse = {};
  for (const [ti, t] of TARGETS.entries()) {
    const course = options(base, 'ddlCourse').find((o) => t.courseRe.test(o.text));
    if (!course) continue;
    afterCourse[course.value] ??= await postback(base, 'ddlCourse', course.value, extra);
    const level = options(afterCourse[course.value], 'ddlCourseLevel').find((o) => t.levelRe.test(o.text));
    if (!level) continue;
    const page = await postback(afterCourse[course.value], 'ddlCourseLevel', level.value, { ...extra, ddlCourse: course.value });
    out.push({ ti, course, level, page, extra, batches: options(page, 'ddlScheduleCourse') });
  }
  saved = out;
  savedAt = Date.now();
  return out;
}

// Every batch of every listed target, all at once. Returns [{ti, batch, seats}].
async function check() {
  if (!saved || Date.now() - savedAt > cfg.watch.rebuildMinutes * 60_000) await build();
  const jobs = saved.flatMap((s) => s.batches.map((b) => ({ s, b })));
  const res = await Promise.allSettled(
    jobs.map(({ s, b }) =>
      postback(s.page, 'ddlScheduleCourse', b.value, { ...s.extra, ddlCourse: s.course.value, ddlCourseLevel: s.level.value }).then(seatsOf)
    )
  );
  const failed = res.filter((r) => r.status === 'rejected');
  if (failed.length) saved = null; // a stale page or a hiccup: walk again next time
  if (failed.length === res.length && res.length) throw new Error(failed[0].reason.message);
  return jobs.map(({ s, b }, i) => ({ ti: s.ti, target: TARGETS[s.ti].name, course: s.course.text, batch: b, seats: res[i].status === 'fulfilled' ? res[i].value : null }));
}

// --- booking: headless Chromium + the user's userscript --------------------------
const SCRIPT_PATH = join(DATA, 'autofill.user.js');
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function scriptFor(ti, batchText) {
  const src = readFileSync(SCRIPT_PATH, 'utf8');
  const m = /^const PROFILE = (\{.*\});$/m.exec(src);
  if (!m) throw new Error(`${SCRIPT_PATH}: no "const PROFILE = {...};" line`);
  const p = JSON.parse(m[1]);
  const t = TARGETS[ti];
  // This tab goes for exactly this course/level/batch, and keeps submitting it through
  // the site's errors until it is accepted (or the booker closes the tab).
  p.targets = [{ course: t.course, level: t.level }];
  p.course = { ...p.course, schedules: [`^${escapeRe(norm(batchText))}$`], anyBatch: false, state: cfg.state };
  Object.assign(p, { keepTrying: true, autoSubmit: true, waitForOpening: true });
  return src.slice(0, m.index) + `const PROFILE = ${JSON.stringify(p)};` + src.slice(m.index + m[0].length);
}

let browser = null;
// One Submit in flight across ALL tabs: the next tab may submit only after the previous answer
// was loaded and judged, and a success cancels every waiting Submit. Without this, two tabs
// can submit in the same second and both get accepted (two applications).
let submitChain = Promise.resolve();
let lastSubmitAt = 0;
function withSubmitLock(fn) {
  const run = submitChain.then(fn, fn);
  submitChain = run.catch(() => {});
  return run;
}
let browserIdleSince = Date.now();
const attempts = new Map(); // `${ti}|${batch.value}` -> attempt
let booked = readJson('booked.json', null);

async function getBrowser() {
  if (browser?.isConnected()) return browser;
  const { chromium } = await import('playwright-core');
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined });
  log('browser started');
  return browser;
}

// The site's answer to a Submit: moved on (redirect / any page that isn't the form or an error)
// = success; the form again = rejected (with its message); an error page = unknown, keep trying.
const SUCCESS = /success|submitted|thank|payment|pay now|already|registered|application (no|number|id)|reference (no|number)|confirmed/i;
function verdict(status, location, html) {
  if (status >= 300 && status < 400) {
    return /admission_form\.aspx/i.test(location) ? { success: false, why: `redirected back to the form` } : { success: true, why: `the site moved on to ${location}` };
  }
  const said = [
    ...alertsIn(html).filter((t) => !staticAlerts.has(t)),
    /<span id="lblMsg"[^>]*>([\s\S]*?)<\/span>/.exec(html)?.[1],
    /<span id="lblCheckError"[^>]*>([\s\S]*?)<\/span>/.exec(html)?.[1],
  ].map((x) => norm(String(x || '').replace(/<[^>]+>/g, ' '))).filter(Boolean).join(' · ');
  // The form itself carries a hidden __VIEWSTATE, so check "is it the form" before "is it an error page".
  if (status < 400 && html.includes('txtName')) return SUCCESS.test(said) ? { success: true, why: `the site said "${said}"` } : { success: false, why: said ? `rejected: "${said}"` : 'the form came back with no message' };
  const visible = norm(html.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ')).slice(0, 3000);
  if (status >= 400 || ERROR_PAGE.test(visible)) return { success: false, why: `site error (HTTP ${status}): ${visible.slice(0, 100)}` };
  return { success: true, why: `the site answered with another page (${norm(/<title>([\s\S]*?)<\/title>/i.exec(html)?.[1] || 'no title')})` };
}

const ERROR_PAGE = /HTTP Error 5\d\d|Service Unavailable|Server Error in|Runtime Error|viewstate|Bad Gateway|Gateway Time-?out|Server Too Busy|Internal Server Error|Request Timeout/i;

async function startAttempt(hit) {
  const key = `${hit.ti}|${hit.batch.value}`;
  if (attempts.has(key) || booked || attempts.size >= cfg.book.maxParallel || !MOBILE) return;
  const a = { key, hit, started: Date.now(), zeroStreak: 0, submits: 0, closed: false };
  attempts.set(key, a);
  log(`BOOKING ${hit.target} | ${hit.batch.text} (${hit.seats} seats)`);
  try {
    const b = await getBrowser();
    a.ctx = await b.newContext({ viewport: { width: 1280, height: 1000 } });
    a.page = await a.ctx.newPage();
    a.page.on('dialog', (d) => d.dismiss().catch(() => {}));
    await a.page.addInitScript(scriptFor(hit.ti, hit.batch.text));
    await a.page.route(/admission_form\.aspx/i, (route) => {
      const req = route.request();
      if (process.env.DEBUG) log(`route ${a.key} ${req.method()} ${(req.postData() || '').length}b submit=${/name="btnSubmit"|(^|&)btnSubmit=/.test(req.postData() || '')}`);
      if (req.method() !== 'POST' || !/name="btnSubmit"|(^|&)btnSubmit=/.test(req.postData() || '')) return route.continue().catch(() => {});
      return withSubmitLock(async () => {
        if (booked || a.closed || a.closing) {
          if (a.closing) closeAttempt(a, 'the seat is gone');
          return route.abort().catch(() => {});
        }
        // pace: at least minSubmitGapSeconds between any two submits, across all tabs
        const gap = cfg.book.minSubmitGapSeconds * 1000 - (Date.now() - lastSubmitAt);
        if (gap > 0) await sleep(gap);
        if (booked || a.closed) return route.abort().catch(() => {});
        lastSubmitAt = Date.now();
        a.submitting = true;
        try {
          // Send the Submit ourselves (no redirect following) and judge the raw answer before any
          // other tab may submit; then hand the answer to the page as if nothing happened.
          let resp = null;
          try {
            resp = await route.fetch({ maxRedirects: 0, timeout: 150_000 });
          } catch (e) {
            log(`${a.key}: submit request failed: ${e.message}`);
            return route.abort().catch(() => {});
          }
          const body = await resp.body().catch(() => Buffer.alloc(0));
          const v = verdict(resp.status(), resp.headers().location || '', body.toString('utf8'));
          log(`${a.key}: submit answered ${resp.status()}: ${v.why}`);
          await route.fulfill({ response: resp, body }).catch(() => {});
          if (v.success) {
            await a.page.waitForLoadState('load', { timeout: 30_000 }).catch(() => {});
            await sleep(2000);
            const text = await a.page.evaluate(() => document.body?.innerText || '').catch(() => '');
            await finish(a, v.why, a.page.url(), text);
          }
        } finally {
          a.submitting = false;
        }
      });
    });
    a.page.goto(`${FORM}?mobile=${MOBILE}`, { timeout: 120_000 }).catch(() => {});
    a.timer = setInterval(() => watchAttempt(a).catch((e) => log(`attempt ${key}:`, e.message)), 1000);
  } catch (e) {
    log(`could not start attempt ${key}:`, e.message);
    await closeAttempt(a, 'start failed');
  }
}

async function closeAttempt(a, why) {
  if (a.closed) return;
  a.closed = true;
  clearInterval(a.timer);
  attempts.delete(a.key);
  log(`closed ${a.hit.target} | ${a.hit.batch.text}: ${why} (${a.submits} submits)`);
  await a.ctx?.close().catch(() => {});
  if (!attempts.size) browserIdleSince = Date.now();
}

async function watchAttempt(a) {
  if (a.closed || a.busy || a.submitting) return;
  a.busy = true;
  try {
    await judge(a);
  } finally {
    a.busy = false;
  }
}

async function judge(a) {
  if (a.closed) return;
  {
    const url = a.page.url();
    if (url.startsWith('chrome-error://')) {
      // Chrome's own network-error page: no userscript runs there, so reload from here.
      log(`${a.key}: network error page, reloading the form`);
      await a.page.goto(`${FORM}?mobile=${MOBILE}`, { timeout: 120_000 }).catch(() => {});
      return;
    }
    const st = await a.page
      .evaluate(() => {
        const g = (k) => sessionStorage.getItem(`iism-autofill:${k}`);
        return { done: g('done'), last: g('lastResult'), tried: g('tried'), title: document.title, text: (document.body?.innerText || '').slice(0, 3000), onForm: !!document.getElementById('txtName') };
      })
      .catch(() => null); // mid-navigation
    if (!st) return;
    const tried = Object.values(JSON.parse(st.tried || '{}')).reduce((x, y) => x + y, 0);
    if (tried > a.submits) {
      a.submits = tried;
      log(`${a.key}: submit #${tried}${st.last ? ` (last answer: ${JSON.parse(st.last)})` : ''}`);
    }
    const done = st.done && JSON.parse(st.done);
    const onIism = /admission\.iismgulmarg\.in/i.test(url);
    if (st.onForm) a.sawForm = true;
    // Anything that is neither the form nor an error page, once the form has loaded, means the site moved on
    // (a payment gateway can come faster than this 1 s poll sees the submit count).
    const leftForm = a.sawForm && !st.onForm && !ERROR_PAGE.test(`${st.title} ${st.text}`) && !(onIism && /admission_form\.aspx/i.test(url));
    if (done || leftForm) return finish(a, done || `the site moved on to ${url}`, url, st.text);
    if (Date.now() - a.started > cfg.book.attemptMinutes * 60_000) return closeAttempt(a, `no success in ${cfg.book.attemptMinutes} min`);
  }
}

async function finish(a, why, url, text) {
  if (booked) return;
  booked = { at: new Date().toISOString(), target: a.hit.target, batch: a.hit.batch.text, why, url };
  writeJson('booked.json', booked);
  const shot = join(DATA, 'shots', `submitted-${Date.now()}.png`);
  let png = null;
  try {
    png = await a.page.screenshot({ path: shot, fullPage: true });
    writeFileSync(shot.replace(/\.png$/, '.html'), await a.page.content());
  } catch (e) {
    log('screenshot failed:', e.message);
  }
  log(`SUBMITTED? ${why} | ${url}`);
  const message =
    `${a.hit.target}: ${a.hit.batch.text}\n${why}\n\nPage: ${url}\n\n${String(text || '').replace(/\s+\n/g, '\n').slice(0, 1200)}\n\n` +
    'Check your SMS/email for the payment link and pay now. The booker has stopped: delete data/booked.json to re-arm it.';
  const p = { title: 'IISM: application SUBMITTED, pay now', message, priority: 'urgent', tags: 'skier,rotating_light,white_check_mark', click: url };
  await push(png ? { ...p, file: png, filename: 'iism-submitted.png' } : p).catch(() => pushSafe(p));
  // Every other tab stops at once: one application is the goal, two would be a mess.
  for (const other of [...attempts.values()]) if (other !== a) await closeAttempt(other, 'another tab got through');
  clearInterval(a.timer);
  a.closed = true;
  attempts.delete(a.key);
  // the accepted tab stays open (its session may be needed for payment) until the process restarts
}

// --- main loop ------------------------------------------------------------------
const stats = { checks: 0, ok: 0, day: null, lastSeats: null, failingSince: null, failAlerted: false };
let lastPing = 0;
let lastUnarmed = '';
const hitsKey = (hits) => hits.map((h) => `${h.ti}|${h.batch.value}`).join(',');

async function healthPing() {
  const { HC_PING_KEY: key, HC_SLUG: slug } = process.env;
  if (!key || !slug || Date.now() - lastPing < 60_000) return;
  lastPing = Date.now();
  fetch(`${process.env.HC_PING_URL || 'https://hc-ping.com'}/${key}/${slug}`).catch(() => {});
}

async function daily(results) {
  const now = new Date();
  const today = now.toLocaleDateString('en-CA');
  if (now.getHours() < cfg.notify.dailyHour || stats.day === today) return;
  stats.day = today;
  const open = (results || []).filter((r) => r.seats > 0);
  await pushSafe({
    title: '🏔️ IISM booker check-in',
    message:
      `${booked ? `BOOKED: ${booked.target} ${booked.batch} (${booked.at}). Not booking any more.` : 'Armed: books the first seat that shows.'}\n` +
      `Checks since yesterday: ${stats.ok}/${stats.checks} OK, every ${cfg.watch.everySeconds}s.\n` +
      `Watching: ${(saved || []).map((s) => `${TARGETS[s.ti].name} (${s.batches.length})`).join(', ') || '(nothing listed)'}\n` +
      (open.length ? `Seats now: ${open.map((r) => `${r.target} ${r.batch.text} = ${r.seats}`).join('; ')}` : 'All batches at 0 seats.'),
    priority: 'min',
    tags: 'mountain_snow',
  });
  stats.checks = stats.ok = 0;
}

async function loop() {
  if (!MOBILE) log('WARNING: IISM_MOBILE is not set: watching only, no booking');
  if (!existsSync(SCRIPT_PATH)) log(`WARNING: ${SCRIPT_PATH} is missing: watching only, no booking`);
  log(`watching every ${cfg.watch.everySeconds}s: ${TARGETS.map((t) => t.name).join(', ')}${booked ? ` (already booked ${booked.at}: not booking)` : ''}`);
  let prev = '';
  let lastSummary = Date.now();
  for (;;) {
    let results = null;
    stats.checks++;
    try {
      results = await check();
      stats.ok++;
      stats.failingSince = null;
      stats.failAlerted = false;
      healthPing();
      const now = results.map((r) => `${r.target} ${r.batch.text}=${r.seats}`).join('; ');
      if (now !== prev) log(`seats: ${results.filter((r) => r.seats).map((r) => `${r.target} ${r.batch.text}=${r.seats}`).join('; ') || `all 0 (${results.length} batches)`}`);
      prev = now;
      const hits = results.filter((r) => r.seats > 0).sort((x, y) => x.ti - y.ti);
      for (const a of attempts.values()) {
        const r = results.find((x) => x.ti === a.hit.ti && x.batch.value === a.hit.batch.value);
        a.zeroStreak = r && r.seats === 0 ? a.zeroStreak + 1 : 0;
        if (a.zeroStreak >= cfg.book.closeAfterZeroChecks) {
          // mid-submit: let that answer land, the lock closes the tab before its next submit
          if (a.submitting) a.closing = true;
          else await closeAttempt(a, 'the seat is gone');
        }
      }
      if (!booked && existsSync(SCRIPT_PATH) && MOBILE) {
        if (hits.length && !attempts.size)
          pushSafe({ title: '🎿 IISM seat open: booking now', message: hits.map((h) => `${h.target}: ${h.batch.text} = ${h.seats} seats`).join('\n'), priority: 'high' });
        for (const h of hits) await startAttempt(h);
      } else if (hits.length && !booked && hitsKey(hits) !== lastUnarmed) {
        lastUnarmed = hitsKey(hits);
        pushSafe({ title: '🎿 IISM seat open (booker not armed)', message: hits.map((h) => `${h.target}: ${h.batch.text} = ${h.seats}`).join('\n'), priority: 'urgent' });
      }
    } catch (e) {
      log('check failed:', e.message);
      stats.failingSince ??= Date.now();
      if (!stats.failAlerted && Date.now() - stats.failingSince > cfg.notify.failureAlertMinutes * 60_000) {
        stats.failAlerted = true;
        pushSafe({ title: '⚠️ IISM booker: checks failing', message: `Failing for ${cfg.notify.failureAlertMinutes}+ min. Last error: ${e.message}`, priority: 'default', tags: 'warning' });
      }
    }
    await daily(results);
    if (Date.now() - lastSummary > 30 * 60_000) {
      lastSummary = Date.now();
      log(`alive: ${stats.ok}/${stats.checks} checks OK today, ${attempts.size} booking tabs open`);
    }
    if (browser && !attempts.size && Date.now() - browserIdleSince > 10 * 60_000 && !booked) {
      await browser.close().catch(() => {});
      browser = null;
      log('browser closed (idle)');
    }
    const wait = (stats.failingSince ? cfg.watch.backoffSeconds : cfg.watch.everySeconds) * 1000;
    await sleep(wait + Math.round((Math.random() * 2 - 1) * cfg.watch.jitterSeconds * 1000));
  }
}

const args = process.argv.slice(2);
if (args.includes('--check')) {
  const r = await check();
  for (const x of r) console.log(`${x.target.padEnd(22)} ${x.batch.text.padEnd(42)} ${x.seats}`);
  process.exit(0);
} else if (args.includes('--test-notify')) {
  await push({ title: '✅ IISM booker test', message: 'ntfy works. The booker pushes here when it books.', priority: 'default' });
} else {
  process.on('SIGTERM', async () => {
    await browser?.close().catch(() => {});
    process.exit(0);
  });
  pushSafe({ title: 'IISM booker started', message: `Watching ${TARGETS.map((t) => t.name).join(', ')} every ${cfg.watch.everySeconds}s.${booked ? ' Already booked: not booking.' : ''}`, priority: 'low', tags: 'skier' });
  await loop();
}
