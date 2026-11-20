'use strict';
// Working days, by the calendar of the country chosen in the settings (asked 2026-11-20 for the schedules: "only on
// working days", "the last working day of the month", holidays counted - and then: "foreigners may use this too; do not
// take Taiwan's holidays for granted").
//
// Where a country's calendar comes from:
//   TW   the calendar the Directorate-General of Personnel Administration publishes each year (行政院人事行政總處「政府
//        行政機關辦公日曆表」), as gathered into one JSON file a year by github.com/ruyut/TaiwanCalendar (through jsDelivr):
//        every day, with its holidays and the Saturdays worked to make up for a bridge holiday. (Nager.Date has no TW.)
//   other the public holidays of date.nager.at (Nager.Date, free; its list has 200-odd countries and regions): the nationwide public ones; Saturday
//        and Sunday are taken to be off (countries with another weekend are not told apart).
//   ''   none chosen: Monday to Friday.
// Kept in this computer's board folder, one file per country and year ({off: {yyyymmdd: name}, on: {yyyymmdd: name}} -
// only the days that differ from "Monday to Friday"), looked for again at most once a day for this year and the next.
// A year without its calendar (not published yet, or the fetch failed): Monday to Friday, and known() says so.
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = () => path.join(os.homedir(), '.claude', 'session-board', 'calendar');
const TW_URL = (y) => 'https://cdn.jsdelivr.net/gh/ruyut/TaiwanCalendar/data/' + y + '.json';
const NAGER_URL = (y, cc) => 'https://date.nager.at/api/v3/PublicHolidays/' + y + '/' + cc;
const NAGER_LIST = 'https://date.nager.at/api/v3/AvailableCountries';
const ymd = (d) => d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
const okCountry = (c) => c === '' || /^[A-Z]{2}$/.test(String(c));

// The country to go by when none was chosen: Taiwan where this computer keeps Taipei's time, else the region of its
// language setting (en-US -> US), else none.
function guessCountry() {
  try {
    const o = Intl.DateTimeFormat().resolvedOptions();
    if (o.timeZone === 'Asia/Taipei') return 'TW';
    const m = /-([A-Z]{2})\b/.exec(o.locale || ''); if (m) return m[1];
  } catch (e) {}
  return '';
}

let current = '';
function setCountry(c) { current = okCountry(c) ? String(c) : ''; }
function country() { return current; }

const years = new Map();   // "CC-yyyy" -> {off, on} | null
const fileOf = (cc, y, dir) => path.join(dir, cc + '-' + y + '.json');
function load(cc, y, dir = DIR()) {
  const k = cc + '-' + y; if (years.has(k)) return years.get(k);
  let v = null;
  try { const j = JSON.parse(fs.readFileSync(fileOf(cc, y, dir), 'utf8')); if (j && j.off && typeof j.off === 'object') v = { off: j.off, on: j.on || {} }; } catch (e) {}
  years.set(k, v); return v;
}
// Whether day d (a Date, local time) is a working day, by the chosen country
function isWorkday(d, dir) {
  const w = d.getDay(), weekday = w >= 1 && w <= 5;
  if (!current) return weekday;
  const c = load(current, d.getFullYear(), dir), k = String(ymd(d));
  if (c && c.off[k] != null) return false;
  if (c && c.on[k] != null) return true;
  return weekday;
}
// What the calendar says of day d: a holiday's name, or the name given to a weekend day worked, or ''
function note(d, dir) {
  if (!current) return '';
  const c = load(current, d.getFullYear(), dir), k = String(ymd(d));
  return (c && (c.off[k] || c.on[k])) || '';
}
// Whether year y of the chosen country's calendar is on this computer (none chosen: nothing to know)
function known(y, dir) { return !current || !!load(current, y, dir); }

// One year of a country's calendar, fetched and made {off, on}. -> that, or null
async function fetchYear(cc, y, get) {
  const ask = async (u) => { const r = await get(u, { signal: AbortSignal.timeout(20000) }); if (!r.ok || r.status === 204) return null; return r.json(); };
  if (cc === 'TW') {
    const arr = await ask(TW_URL(y));
    if (!Array.isArray(arr) || arr.length < 365 || !arr.every((x) => x && /^\d{8}$/.test(String(x.date)) && typeof x.isHoliday === 'boolean')) return null;
    const off = {}, on = {};
    for (const x of arr) {
      const k = String(x.date);   // (written as a number in some years' files: a string either way - review 2026-11-20)
      const d = new Date(Number(k.slice(0, 4)), Number(k.slice(4, 6)) - 1, Number(k.slice(6))), wk = d.getDay() >= 1 && d.getDay() <= 5;
      if (x.isHoliday && wk) off[k] = String(x.description || '放假');
      else if (!x.isHoliday && !wk) on[k] = String(x.description || '補班');
      else if (x.isHoliday && x.description) off[k] = String(x.description);   // a holiday on a weekend: named all the same
    }
    return { off, on };
  }
  const arr = await ask(NAGER_URL(y, cc));
  if (!Array.isArray(arr) || !arr.every((x) => x && /^\d{4}-\d{2}-\d{2}$/.test(String(x.date)))) return null;
  const off = {};
  for (const x of arr) if (x.global !== false && (!Array.isArray(x.types) || x.types.includes('Public'))) off[x.date.replace(/-/g, '')] = String(x.localName || x.name || '');
  return { off, on: {} };
}
// Fetch this year's and next year's calendar of the chosen country when missing (or a day old). -> {got: [years], failed: [years]}
async function refresh(o = {}) {
  const dir = o.dir || DIR(), get = o.fetch || fetch, now = o.now || Date.now(), cc = o.country != null ? o.country : current;
  const got = [], failed = [];
  if (!cc) return { got, failed };
  const y0 = new Date(now).getFullYear();
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  for (const y of [y0, y0 + 1]) {
    const f = fileOf(cc, y, dir);
    let age = Infinity; try { age = now - fs.statSync(f).mtimeMs; } catch (e) {}
    if (age < 86400000 && load(cc, y, dir)) continue;
    let v = null; try { v = await fetchYear(cc, y, get); } catch (e) {}
    if (!v) { failed.push(y); continue; }
    // a year that cannot be written is that year failed, not the whole fetch (review 2026-11-20)
    try { const tmp = f + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(Object.assign({ country: cc, year: y }, v))); fs.renameSync(tmp, f); } catch (e) { failed.push(y); continue; }
    years.delete(cc + '-' + y); got.push(y);
  }
  return { got, failed };
}
// The countries there are calendars for: Nager.Date's list (kept 30 days) and Taiwan. -> [{code, name}]
async function countries(o = {}) {
  const dir = o.dir || DIR(), get = o.fetch || fetch, now = o.now || Date.now(), f = path.join(dir, 'countries.json');
  let list = null;
  try { if (now - fs.statSync(f).mtimeMs < 30 * 86400000) list = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) {}
  if (!Array.isArray(list)) {
    try {
      const r = await get(NAGER_LIST, { signal: AbortSignal.timeout(20000) });
      const j = r.ok ? await r.json() : null;
      if (Array.isArray(j) && j.length) { list = j.filter((x) => x && /^[A-Z]{2}$/.test(x.countryCode)).map((x) => ({ code: x.countryCode, name: String(x.name || x.countryCode) })); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(f, JSON.stringify(list)); }
    } catch (e) {}
    if (!Array.isArray(list)) { try { list = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { list = []; } }
  }
  if (!list.some((x) => x.code === 'TW')) list = list.concat([{ code: 'TW', name: 'Taiwan' }]);
  return list.sort((a, b) => a.name.localeCompare(b.name));
}
function forget() { years.clear(); }

module.exports = { isWorkday, note, known, refresh, countries, setCountry, country, guessCountry, okCountry, forget, DIR, TW_URL, NAGER_URL };
