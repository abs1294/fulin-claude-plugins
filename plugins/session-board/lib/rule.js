'use strict';
// A schedule's own rule, for what the plain kinds (once, every day, the weekdays, the days of the month, every N hours)
// cannot say (asked 2026-11-20: "can it be set to any odd schedule?"). One rule:
//
//   cron        "minute hour day-of-month month day-of-week", as cron has it: lists 1,15  ranges 9-18  steps */2 9-18/2  *
//               and more, in day-of-month:  L the last day   L-3 three days before it   LW the last working day
//                                           FW the first working day
//               in day-of-week (0 or 7 = Sunday … 6):  1#1 the first Monday of the month   5L its last Friday
//               As in cron, when both day-of-month and day-of-week are given, a day that matches either one is in.
//   workday     'only' - only on working days, by the calendar of the country chosen in the settings (lib/workdays.js:
//                        its public holidays off; where the calendar says so, a weekend day worked)
//               'off'  - only on days off
//   everyWeeks  2 … 52: every so many weeks, the weeks counted from `from` (or from the day it was made)
//   everyMonths 2 … 24: every so many months, likewise
//   from, until "YYYY-MM-DD": the first and the last day it may run on
//   count       1 … 1000: after so many runs, no more
//   text        what you said it should be, in your words (shown in the list); explain: the same, as it was understood
//
// Times are this computer's. Nothing runs more often than every 5 minutes.
const Cal = require('./workdays');

// days looked through for the next or the last run: ten years. February 29th comes every four years (eight across
// 2100), and with "working days only" or "every 24 months" on top it can be further still - 800 days said such a rule
// would never run again (review 2026-11-20). A day is looked at in microseconds: ten years is a few milliseconds.
const DAY = 86400000, LOOK = 3660;
const FIELDS = [['分', 0, 59], ['時', 0, 23], ['日', 1, 31], ['月', 1, 12], ['星期', 0, 7]];

// One field -> {any, set: Set of numbers, special: [...]} or throws a sentence saying what is wrong
function field(src, [name, lo, hi], i) {
  const out = { any: false, set: new Set(), special: [] };
  for (const part of String(src).split(',')) {
    const p = part.trim(); if (!p) throw new Error(name + '欄有空的項目');
    if (i === 2 && /^(L|LW|FW|L-\d{1,2})$/i.test(p)) {
      // L-n: up to 27 days before the last (every month has a 28th); more is a day some months do not have (review 2026-11-20)
      if (p.includes('-') && (Number(p.slice(2)) < 1 || Number(p.slice(2)) > 27)) throw new Error(name + '欄的 L-n 要是 L-1～L-27（月底前幾天）');
      out.special.push(p.toUpperCase()); continue;
    }
    if (i === 4) {
      let m = /^([0-7])#([1-5])$/.exec(p); if (m) { out.special.push({ dow: Number(m[1]) % 7, nth: Number(m[2]) }); continue; }
      m = /^([0-7])L$/i.exec(p); if (m) { out.special.push({ dow: Number(m[1]) % 7, nth: -1 }); continue; }
    }
    const m = /^(\*|\d{1,2}(?:-\d{1,2})?)(?:\/(\d{1,2}))?$/.exec(p);
    if (!m) throw new Error(name + '欄看不懂：' + p);
    const step = m[2] ? Number(m[2]) : 1; if (step < 1) throw new Error(name + '欄的間隔要大於 0');
    let a = lo, b = hi;
    if (m[1] === '*') { if (!m[2]) out.any = true; }
    else { const r = m[1].split('-').map(Number); a = r[0]; b = r.length > 1 ? r[1] : (m[2] ? hi : r[0]); }
    if (a < lo || b > hi || a > b) throw new Error(name + '欄超出範圍（' + lo + '～' + hi + '）：' + p);
    for (let v = a; v <= b; v += step) out.set.add(i === 4 ? v % 7 : v);
  }
  if (out.any) { out.set = new Set(); for (let v = lo; v <= hi; v++) out.set.add(i === 4 ? v % 7 : v); }
  return out;
}

// a day that is: 2028-02-30 is not one (a Date would make it March 1st - review 2026-11-20)
const isoDay = (s) => { if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return ''; const [y, m, d] = s.split('-').map(Number), x = new Date(y, m - 1, d); return x.getFullYear() === y && x.getMonth() === m - 1 && x.getDate() === d ? s : ''; };
const dayStart = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
// the start of the day after t's, by the calendar (not t + 24 hours: a day where clocks change has 23 or 25)
const nextDay = (t) => { const d = new Date(t); return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime(); };
const prevDay = (t) => { const d = new Date(t); return new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1).getTime(); };

// What was sent -> {ok, rule} (the rule cleaned, as kept) or {ok: false, error}
function check(input) {
  const o = input || {};
  const cron = String(o.cron || '').trim().replace(/\s+/g, ' ');
  const parts = cron.split(' ');
  if (parts.length !== 5) return { ok: false, error: '規則要有 5 欄：分 時 日 月 星期（例如 0 9 * * 1-5）' };
  let f; try { f = parts.map((p, i) => field(p, FIELDS[i], i)); } catch (e) { return { ok: false, error: e.message }; }
  // not more often than every 5 minutes
  const mins = [...f[0].set].sort((a, b) => a - b);
  for (let i = 1; i < mins.length; i++) if (mins[i] - mins[i - 1] < 5) return { ok: false, error: '最密只能每 5 分鐘一次' };
  if (mins.length > 1 && mins[0] + 60 - mins[mins.length - 1] < 5) return { ok: false, error: '最密只能每 5 分鐘一次' };
  const r = { cron };
  if (o.workday === 'only' || o.workday === 'off') r.workday = o.workday;
  // (every 1 week or 1 month is no interval at all: left out)
  const n = (v, lo, hi, what, one) => { if (v == null || v === '' || v === 0 || (Number(v) === 1 && !one)) return 0; const x = Number(v); if (!Number.isInteger(x) || x < lo || x > hi) throw new Error(what + '要是 ' + lo + '～' + hi + ' 的整數'); return x; };
  try {
    const w = n(o.everyWeeks, 2, 52, '每幾週'), mo = n(o.everyMonths, 2, 24, '每幾個月'), c = n(o.count, 1, 1000, '執行次數', true);
    if (w && mo) return { ok: false, error: '每幾週和每幾個月只能選一個' };
    if (w) r.everyWeeks = w; if (mo) r.everyMonths = mo; if (c) r.count = c;
  } catch (e) { return { ok: false, error: e.message }; }
  if (o.from) { if (!isoDay(o.from)) return { ok: false, error: '開始日期格式要是 YYYY-MM-DD' }; r.from = o.from; }
  if (o.until) { if (!isoDay(o.until)) return { ok: false, error: '結束日期格式要是 YYYY-MM-DD' }; r.until = o.until; }
  if (r.from && r.until && r.until < r.from) return { ok: false, error: '結束日期在開始日期之前' };
  if (typeof o.text === 'string' && o.text.trim()) r.text = o.text.trim().slice(0, 200);
  if (typeof o.explain === 'string' && o.explain.trim()) r.explain = o.explain.trim().slice(0, 300);
  return { ok: true, rule: r };
}

// The rule made ready to be asked about days. made: when the schedule was made (where weeks and months, and the count, start)
function compile(rule, made) {
  const f = rule.cron.split(' ').map((p, i) => field(p, FIELDS[i], i));
  // without a first day: from the moment it was made, not that day's midnight (made at noon, a 09:00 that morning is not
  // one of its runs - review 2026-11-20: 「3 times」 ran twice). The weeks and months are counted from that day.
  const start = rule.from ? new Date(rule.from + 'T00:00:00').getTime() : (made || Date.now());
  // the end of the last day: the next day's midnight, by the calendar - a day is not always 24 hours where clocks change
  // (review 2026-11-20: in New York the 25-hour day lost its 23:30, the 23-hour one ran into the day after)
  const end = rule.until ? nextDay(new Date(rule.until + 'T00:00:00').getTime()) - 1 : Infinity;
  const times = [];
  for (const h of [...f[1].set].sort((a, b) => a - b)) for (const m of [...f[0].set].sort((a, b) => a - b)) times.push(h * 60 + m);
  return { rule, f, start, anchor: dayStart(start), end, times };
}

const lastDayOf = (d) => new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
function workdayOfMonth(d, last) {
  // the first (or last) working day of d's month
  const y = d.getFullYear(), m = d.getMonth(), n = lastDayOf(d);
  for (let i = 0; i < n; i++) { const x = new Date(y, m, last ? n - i : 1 + i); if (Cal.isWorkday(x)) return x.getDate(); }
  return 0;
}
function domMatch(c, d) {
  const dom = d.getDate();
  if (c.f[2].set.has(dom) && !c.f[2].any) return true;
  for (const s of c.f[2].special) {
    if (s === 'L' && dom === lastDayOf(d)) return true;
    if (/^L-\d+$/.test(s) && dom === lastDayOf(d) - Number(s.slice(2))) return true;
    if (s === 'LW' && dom === workdayOfMonth(d, true)) return true;
    if (s === 'FW' && dom === workdayOfMonth(d, false)) return true;
  }
  return false;
}
function dowMatch(c, d) {
  const w = d.getDay();
  if (c.f[4].set.has(w) && !c.f[4].any) return true;
  for (const s of c.f[4].special) {
    if (s.dow !== w) continue;
    if (s.nth > 0 && Math.ceil(d.getDate() / 7) === s.nth) return true;
    if (s.nth < 0 && d.getDate() + 7 > lastDayOf(d)) return true;
  }
  return false;
}
function dayIn(c, t) {
  const d = new Date(t);
  if (nextDay(t) - 1 < c.start || t > c.end) return false;
  if (!c.f[3].set.has(d.getMonth() + 1)) return false;
  const domGiven = !c.f[2].any, dowGiven = !c.f[4].any;
  const day = domGiven && dowGiven ? domMatch(c, d) || dowMatch(c, d) : domGiven ? domMatch(c, d) : dowGiven ? dowMatch(c, d) : true;
  if (!day) return false;
  if (c.rule.workday === 'only' && !Cal.isWorkday(d)) return false;
  if (c.rule.workday === 'off' && Cal.isWorkday(d)) return false;
  if (c.rule.everyWeeks) { const s = new Date(c.anchor); s.setDate(s.getDate() - s.getDay()); const wk = Math.floor(Math.round((dayStart(t) - s.getTime()) / DAY) / 7); if (wk < 0 || wk % c.rule.everyWeeks) return false; }
  if (c.rule.everyMonths) { const s = new Date(c.anchor); const k = (d.getFullYear() - s.getFullYear()) * 12 + d.getMonth() - s.getMonth(); if (k < 0 || k % c.rule.everyMonths) return false; }
  return true;
}
const at = (day, mins) => { const d = new Date(day); d.setHours(Math.floor(mins / 60), mins % 60, 0, 0); return d.getTime(); };
// the runs in [a, b), in order, at most max
function between(c, a, b, max) {
  const out = [];
  for (let day = dayStart(Math.max(a, c.start)); day < b && day <= c.end && out.length < max; day = nextDay(day)) {
    if (!dayIn(c, day)) continue;
    for (const m of c.times) { const t = at(day, m); if (t >= a && t < b && t >= c.start && t <= c.end) { out.push(t); if (out.length >= max) break; } }
  }
  return out;
}
// how many runs there were before t (for `count`)
const runsBefore = (c, t) => between(c, c.start, t, (c.rule.count || 0) + 1).length;

// The next run after now, 0 when there is none
function next(rule, now = Date.now(), made) {
  const c = compile(rule, made);
  const [t] = between(c, now + 1, now + LOOK * DAY, 1);
  if (!t) return 0;
  if (c.rule.count && runsBefore(c, t) >= c.rule.count) return 0;
  return t;
}
// The latest run not after now, 0 when there is none
function last(rule, now = Date.now(), made) {
  const c = compile(rule, made);
  for (let day = dayStart(now); day >= dayStart(now - LOOK * DAY) && day >= dayStart(c.start); day = prevDay(day)) {
    if (!dayIn(c, day)) continue;
    const ts = c.times.map((m) => at(day, m)).filter((t) => t <= now && t >= c.start && t <= c.end);
    if (!ts.length) continue;
    const t = ts[ts.length - 1];
    if (c.rule.count && runsBefore(c, t) >= c.rule.count) {
      // past its count: the last of the runs it had
      const all = between(c, c.start, now + 1, c.rule.count); return all.length ? all[all.length - 1] : 0;
    }
    return t;
  }
  return 0;
}
// The next `n` runs after now (for the preview), each with what the calendar says of its day
function upcoming(rule, now = Date.now(), made, n = 5) {
  const c = compile(rule, made);
  let ts = between(c, now + 1, now + LOOK * DAY, n);
  if (c.rule.count) { const before = runsBefore(c, now + 1); ts = ts.slice(0, Math.max(0, c.rule.count - before)); }
  return ts.map((t) => ({ at: t, note: Cal.note(new Date(t)) }));
}
// The years the rule looks at (the next runs, and a year on) that have no calendar: where working days are a guess
// (also the years of the runs shown, `ats`: a run years ahead is in a year whose calendar is not out - said, not hidden;
// review 2026-11-20, once the next run could be ten years off)
function guessedYears(rule, now = Date.now(), ats = []) {
  if (!rule.workday && !/LW|FW/.test(rule.cron)) return [];
  const y = new Date(now).getFullYear();
  return [...new Set([y, y + 1, ...ats.map((t) => new Date(t).getFullYear())])].sort((a, b) => a - b).filter((x) => !Cal.known(x));
}

module.exports = { check, next, last, upcoming, guessedYears };
