// A fake admission_form.aspx for testing the booker without touching the real site.
// The real page's HTML (test/form.html, fetched with the dummy number) with ASP.NET
// full-postback behaviour: posted values come back, course -> level -> batch cascade,
// "Available Seats" per batch read from SEATS_FILE on every request, and a recorded submit.
// Static assets (WebResource.axd, ScriptResource.axd, js/, css/) are fetched once from the
// real site and cached in test/.cache, so the page's own JavaScript and validators run.
// Also records ntfy pushes (POST/PUT anything else) to PUSH_LOG.
//
// Env: PORT (8790), SEATS_FILE (JSON {batchId: seats}), REJECT_N (reject the first n submits),
//      ERR_RATE (0..1: share of POSTs answered with an IIS 503 page), PUSH_LOG, SUBMIT_LOG.
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const HERE = new URL('.', import.meta.url).pathname;
const FORM = readFileSync(HERE + 'form.html', 'utf8');
const CACHE = HERE + '.cache/';
mkdirSync(CACHE, { recursive: true });
const env = process.env;
let submits = 0;

// Today's real layout (17 Nov 2026), Kargil included.
const COURSES = [['21', 'Snow Skiing Courses at Gulmarg'], ['22', 'Snow Skiing Courses at Kargil'], ['23', 'MOI Courses at Gulmarg']];
const LEVELS = { 21: [['1', 'Basic SSC'], ['2', 'Intermediate SSC'], ['3', 'Advance SSC'], ['4', 'Snow Boarding']], 22: [['5', 'Basic skiing course'], ['6', 'Intermediate skiing course']], 23: [['7', 'MOI']] };
const G = [['20 Dec 2026 to 02 Jan 2027', '1st'], ['03rd Jan to 16 Jan 2027', '2nd'], ['17 Jan to 30 Jan 2027', '3rd'], ['31 Jan to 13 Feb 2027', '4th'], ['14 Feb to 27 Feb 2027', '5th'], ['28 Feb to 13 Mar 2027', '6th']];
const BATCHES = {
  '21/1': G.map(([d, n], i) => [`1${i}`, `${n} course from ${d}`]),
  '21/2': G.map(([d, n], i) => [`2${i}`, `${n} course from ${d}`]),
  '21/4': G.map(([d, n], i) => [`4${i}`, `${n} course from ${d}`]),
  '22/5': [['50', '1st course from 8th Feb to 21 Feb 2027'], ['51', '2nd course from 22 Feb to 07 Mar 2027']],
  '22/6': [['60', '1st course from 8th Feb to 21 Feb 2027']],
  '23/7': [['70', 'MOI 1']],
};
const seatsOf = (id) => {
  try {
    return Number(JSON.parse(readFileSync(env.SEATS_FILE, 'utf8'))[id] || 0);
  } catch {
    return 0;
  }
};

const opts = (ph, list, sel) => `<option value="0">${ph}</option>` + list.map(([v, t]) => `<option${v === sel ? ' selected="selected"' : ''} value="${v}">${t}</option>`).join('');
const setSelect = (h, id, inner) => h.replace(new RegExp(`(<select name="${id}"[^>]*>)[\\s\\S]*?(</select>)`), `$1${inner}$2`);
const setText = (h, id, v) => h.replace(new RegExp(`<input name="${id}" type="text"( value="[^"]*")?`), `<input name="${id}" type="text" value="${String(v).replace(/"/g, '&quot;')}"`);
const selectState = (h, v) => h.replace(/(<select name="ddlState"[\s\S]*?<\/select>)/, (s) => s.replace(/ selected="selected"/g, '').replace(`value="${v}"`, `selected="selected" value="${v}"`));

function render(f, say = '', mobile = '123456789') {
  // the real site renders the number the page was opened with (form action + txtMobileNo)
  let h = FORM.replaceAll('123456789', mobile);
  const course = COURSES.some(([v]) => v === f.ddlCourse) ? f.ddlCourse : '0';
  const level = (LEVELS[course] || []).some(([v]) => v === f.ddlCourseLevel) ? f.ddlCourseLevel : '0';
  const batches = BATCHES[`${course}/${level}`] || [];
  const batch = batches.find((b) => b[0] === f.ddlScheduleCourse);
  h = setSelect(h, 'ddlCourse', opts('Select Course', COURSES, course));
  h = setSelect(h, 'ddlCourseLevel', opts('Select Course Level', LEVELS[course] || [], level));
  h = setSelect(h, 'ddlScheduleCourse', opts('Select Schedule Course', batches, batch?.[0]));
  if (f.ddlState) h = selectState(h, f.ddlState);
  h = setText(h, 'txtAvailableSeat', batch ? seatsOf(batch[0]) : 0);
  h = setText(h, 'txtCourseFee', batch ? 10000 : 0);
  for (const [k, v] of Object.entries(f)) if (/^txt/.test(k) && !/AvailableSeat|CourseFee/.test(k)) h = setText(h, k, v);
  for (const k of ['ddlEduationQualification', 'ddlVegetarianOrNon']) if (f[k]) h = h.replace(new RegExp(`(<select name="${k}"[\\s\\S]*?)value="${f[k]}"`), `$1selected="selected" value="${f[k]}"`);
  if (say) h = h.replace('<span id="lblMsg">', `<span id="lblMsg">${say}`);
  return h;
}

async function asset(path) {
  const file = CACHE + createHash('sha1').update(path).digest('hex');
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  const r = await fetch('https://admission.iismgulmarg.in' + path);
  const out = { status: r.status, type: r.headers.get('content-type') || 'text/plain', body: Buffer.from(await r.arrayBuffer()).toString('base64') };
  writeFileSync(file, JSON.stringify(out));
  return out;
}

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (/^\/admission_form\.aspx$/i.test(url.pathname)) {
    const f = {};
    if (req.method === 'POST') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const fd = await new Response(Buffer.concat(chunks), { headers: { 'content-type': req.headers['content-type'] } }).formData();
      const files = {};
      for (const [k, v] of fd) if (typeof v === 'string') f[k] = v; else if (v.size) files[k] = { name: v.name, size: v.size };
      if (env.ERR_RATE && Math.random() < Number(env.ERR_RATE)) {
        res.writeHead(503, { 'content-type': 'text/html' });
        return res.end('<html><head><title>Service Unavailable</title></head><body><h3>HTTP Error 503.2 - Service Unavailable</h3></body></html>');
      }
      const target = f.__EVENTTARGET;
      if (target === 'ddlCourse') { delete f.ddlCourseLevel; delete f.ddlScheduleCourse; }
      if (target === 'ddlCourseLevel') delete f.ddlScheduleCourse;
      if (!target && f.btnSubmit) {
        submits++;
        const entry = { n: submits, mobile: url.searchParams.get('mobile'), txtMobileNo: f.txtMobileNo, course: f.ddlCourse, level: f.ddlCourseLevel, batch: f.ddlScheduleCourse, name: f.txtName, dob: f.txtDateOfBirth, files: Object.keys(files).length };
        const seats = seatsOf(f.ddlScheduleCourse);
        if (submits <= Number(env.REJECT_N || 0) || seats <= 0) {
          if (env.SUBMIT_LOG) appendFileSync(env.SUBMIT_LOG, JSON.stringify({ ...entry, result: 'rejected' }) + '\n');
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          return res.end(render(f, 'Seat Not Available', url.searchParams.get('mobile') || ''));
        }
        if (env.SUBMIT_LOG) appendFileSync(env.SUBMIT_LOG, JSON.stringify({ ...entry, result: 'accepted' }) + '\n');
        res.writeHead(302, { location: '/PaymentPage.aspx?app=12345' });
        return res.end();
      }
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(render(f, '', url.searchParams.get('mobile') || ''));
  }
  if (/^\/PaymentPage\.aspx$/i.test(url.pathname)) {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end('<html><head><title>Payment</title></head><body><h2>Application submitted successfully. Application No 12345.</h2><p>Pay the course fee to confirm your seat.</p></body></html>');
  }
  if (req.method === 'POST' || req.method === 'PUT') {
    // ntfy stand-in: record title/message/priority and whether a file came with it
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const q = url.searchParams;
    const rec = { title: q.get('title') || req.headers.title, priority: q.get('priority') || req.headers.priority, message: q.get('message') || (q.get('filename') ? '' : body.toString()), file: q.get('filename') ? `${q.get('filename')} (${body.length} bytes)` : null };
    if (env.PUSH_LOG) appendFileSync(env.PUSH_LOG, JSON.stringify(rec) + '\n');
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end('{}');
  }
  if (/translate\.google|fontawesome/.test(req.url)) { res.writeHead(404); return res.end(); }
  try {
    const a = await asset(req.url);
    res.writeHead(a.status, { 'content-type': a.type });
    res.end(Buffer.from(a.body, 'base64'));
  } catch {
    res.writeHead(502);
    res.end();
  }
}).listen(Number(env.PORT || 8790), () => console.log('fake site on', env.PORT || 8790));
