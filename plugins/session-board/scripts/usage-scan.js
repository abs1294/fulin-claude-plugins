#!/usr/bin/env node
'use strict';
// Token usage and API-equivalent cost for one calendar month, across EVERY
// session on this machine (open or long closed, main conversations and
// subagents). Prints one JSON object on stdout.
//
//   node usage-scan.js 2026-11
//
// Nothing is collected here: cc-statusline does that (its docs/data-boundary.md).
// This adds up its usage records - one line for every API message, counted once
// and priced, kept after Claude Code clears the conversation away:
//
//   ~/.claude/usage-data/records/meta.json, <yyyy-mm>/<project>.jsonl
//
// A record belongs to the month its own time falls in, local time (the folders
// are months in UTC, so one or two of them are read). Only the titles of the
// sessions are read from the conversations themselves, and kept while a
// conversation does not change. Run as its own process by lib/monthly.js: a
// month is tens of megabytes to read.
const fs = require('fs');
const os = require('os');
const path = require('path');
const baseName = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || '';   // either kind of slash (a path written on Windows, read on a Mac)

const ym = process.argv[2] || '';
const m = /^(\d{4})-(\d{2})$/.exec(ym);
const done = (o) => { process.stdout.write(JSON.stringify(o)); process.exit(0); };
if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) done({ ok: false, error: 'month must be YYYY-MM' });
const from = new Date(Number(m[1]), Number(m[2]) - 1, 1).getTime();
const to = new Date(Number(m[1]), Number(m[2]), 1).getTime();
const started = Date.now();

const ROOT = path.join(os.homedir(), '.claude', 'projects'), DIR = path.join(os.homedir(), '.claude', 'usage-data', 'records');
let meta = null;
// Read, with a little patience: cc-statusline replaces its files whole, and on Windows one is out of reach for that moment.
const BUSY = { ok: false, error: 'cc-statusline 的用量紀錄一時讀不到，稍後再看' };
function read(p, listed) {   // listed: it was just there, so not being there is a moment too
  for (let n = 0; ; n++) {
    try { return fs.readFileSync(p, 'utf8'); }
    catch (e) { if (e.code === 'ENOENT' && !listed) return null; if (n >= 10) done(BUSY); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100); }
  }
}
{ const t = read(path.join(DIR, 'meta.json')); if (t !== null) { try { meta = JSON.parse(t); } catch (e) { done(BUSY); } } }
if (!meta || !(meta.v >= 1)) done({ ok: false, error: '沒有 cc-statusline 的用量紀錄。請安裝或更新 cc-statusline 到 1.10.0 以上；第一次會在背景把全部對話整理一遍，約一兩分鐘' });
if (!(meta.at > 0)) done({ ok: false, error: 'cc-statusline 正在把全部對話整理成用量紀錄（第一次約一兩分鐘），好了再看' });   // part of it is not a figure
const prices = meta.prices && typeof meta.prices === 'object' ? meta.prices : {}, projects0 = meta.projects && typeof meta.projects === 'object' ? meta.projects : {};
const pathOf = (proj) => (projects0[proj] && typeof projects0[proj].path === 'string' ? projects0[proj].path : '');
const num = (x) => (Number.isFinite(x) ? Math.max(0, x) : 0);

// n: how many API messages (calls to the model) went into the bucket.
const zero = () => ({ in: 0, out: 0, cw: 0, cr: 0, tok: 0, cost: 0, n: 0 });
const total = zero();
const days = new Map(), models = new Map(), projects = new Map(), sessions = new Map(), titles = new Map(), roles = new Map(), runs = new Map();
let records = 0, unpricedTok = 0, approxTok = 0, bytes = 0, files = 0;
const add = (map, key, extra) => { let v = map.get(key); if (!v) { v = Object.assign(zero(), extra); map.set(key, v); } return v; };

// Each day's part of every figure, so the page can add up any days of the month by itself (asked 2026-11-23: pick a start and
// an end on the bars). One cell per day, record, model and session; the names are in the tables, once each.
// cells: [day, run, model, session, in, out, cw, cr, cost, n]; runs: [project, role, 1 for a team member, 1 for a subagent's]
const slice = { models: [], projects: [], roles: [], runs: [], sessions: [], cells: [] };
const at = (table, index, key, row) => { let i = index.get(key); if (i === undefined) { i = table.length; index.set(key, i); table.push(row); } return i; };
const ix = { m: new Map(), p: new Map(), r: new Map(), s: new Map(), c: new Map() };
// ── adding up ──
const all = [], startedAs = new Map();
const monthIn = (ts) => new Date(ts).toISOString().slice(0, 7);
for (const mo of new Set([monthIn(from), monthIn(to - 1)])) {
  let names = [];
  for (let n = 0; ; n++) {
    try { names = fs.readdirSync(path.join(DIR, mo), { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith('.jsonl')).map((e) => e.name).sort(); break; }
    catch (e) { if (e.code === 'ENOENT') break; if (n >= 10) done(BUSY); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100); }   // a part left out would be taken for the whole
  }
  for (const f of names) {
    const proj = f.slice(0, -6);
    const text = read(path.join(DIR, mo, f), true);
    files++; bytes += text.length;
    for (let at0 = 0, i = text.indexOf('\n'); i >= 0; at0 = i + 1, i = text.indexOf('\n', at0)) {
      let r; try { r = JSON.parse(text.slice(at0, i)); } catch (e) { continue; }   // being written, or not one
      if (!r || typeof r !== 'object' || !(r.ts >= from && r.ts < to) || typeof r.sid !== 'string') continue;
      if (!r.key) continue;   // not a Claude model
      all.push([proj, r]);
      // a conversation started as a role is that role's all through, also what came before it was noted
      if (!r.agent && r.role && !startedAs.has(proj + '/' + r.sid)) startedAs.set(proj + '/' + r.sid, r.role);
    }
  }
}
for (const [proj, r] of all) one(proj, r);
function one(proj, r) {
  const part = { in: num(r.in), out: num(r.out), cw: num(r.cw5) + num(r.cw1), cr: num(r.rd), cost: num(r.cost) }, sub = !!r.agent, role = !sub ? startedAs.get(proj + '/' + r.sid) || '' : typeof r.role === 'string' ? r.role : '';
  part.tok = part.in + part.out + part.cw + part.cr;
  const exact = r.flag === undefined, priced = r.flag !== 'unpriced';
  if (!priced) unpricedTok += part.tok; else if (!exact) approxTok += part.tok;
  records++;
  const day = new Date(r.ts).getDate();
  for (const bucket of [total, add(days, day), add(models, r.key, { exact, priced }), add(projects, proj), add(sessions, r.sid, { project: proj, first: r.ts, last: r.ts })]) {
    bucket.in += part.in; bucket.out += part.out; bucket.cw += part.cw; bucket.cr += part.cr; bucket.tok += part.tok; bucket.cost += part.cost; bucket.n += 1;
  }
  const s = sessions.get(r.sid);
  if (r.ts < s.first) s.first = r.ts;
  if (r.ts > s.last) s.last = r.ts;
  const who = add(roles, role, { runs: 0, team: 0, models: {}, projects: {} });
  who.in += part.in; who.out += part.out; who.cw += part.cw; who.cr += part.cr; who.tok += part.tok; who.cost += part.cost; who.n += 1;
  who.models[r.key] = (who.models[r.key] || 0) + part.cost;
  who.projects[proj] = (who.projects[proj] || 0) + part.cost;
  // runs: how many records (one conversation, or one subagent sent out) had usage in the month; team: how many of them were team members.
  const rk = proj + '/' + r.sid + '/' + (r.file || '') + '/' + role;
  let run = runs.get(rk);
  if (run === undefined) { run = slice.runs.length; runs.set(rk, run); slice.runs.push([at(slice.projects, ix.p, proj, proj), at(slice.roles, ix.r, role, role), r.team ? 1 : 0, sub ? 1 : 0]); who.runs++; if (r.team) who.team++; }
  const mi = at(slice.models, ix.m, r.key, [r.key, exact ? 1 : 0, priced ? 1 : 0]), si = at(slice.sessions, ix.s, r.sid, r.sid), key = day + ',' + run + ',' + mi + ',' + si;
  let c = ix.c.get(key); if (!c) { c = [day, run, mi, si, 0, 0, 0, 0, 0, 0]; ix.c.set(key, c); slice.cells.push(c); }
  c[4] += part.in; c[5] += part.out; c[6] += part.cw; c[7] += part.cr; c[8] += part.cost; c[9] += 1;
}

// What each session was about: its title, from its conversation (cleared away: none). Kept in the board's database while the file does not change.
{
  const { lastTitles } = require(path.join(__dirname, '..', 'lib', 'sessions.js'));
  let ignore = new Set(); if (fs.existsSync(path.join(os.homedir(), '.claude', 'session-board', 'board.db'))) try { ignore = require(path.join(__dirname, '..', 'lib', 'codes.js')).known(require(path.join(__dirname, '..', 'lib', 'config.js')).value); } catch (e) {}   // fixed names are not titles
  let db = null, get = null;
  if (process.env.SESSION_BOARD_SCAN_CACHE !== '0') {
    try {
      db = require(path.join(__dirname, '..', 'lib', 'db.js')).open();
      db.exec('CREATE TABLE IF NOT EXISTS usage_titles (path TEXT PRIMARY KEY, size INTEGER NOT NULL, mtime REAL NOT NULL, title TEXT NOT NULL, own INTEGER NOT NULL)');
      db.exec('DROP TABLE IF EXISTS scan_file'); db.exec('DROP TABLE IF EXISTS usage_title');   // how far each conversation was read, when they were read here (until 0.21.0)
      get = db.prepare('SELECT size, mtime, title, own FROM usage_titles WHERE path = ?');
    } catch (e) { db = null; get = null; }
  }
  const put = [], keptOf = (p) => { try { const k = get ? get.get(p) : null; return k && ignore.has(k.title) ? null : k; } catch (e) { return null; } };   // kept under a fixed name: read again
  // The record files of a folder with a very long name are named after its first 170 characters and a hash.
  const long = new Map(), folderOf = (proj) => {
    if (proj.length !== 179) return proj;
    if (!long.has(proj)) { let es = []; try { es = fs.readdirSync(ROOT); } catch (e) {} long.set(proj, es.find((d) => d.length > 180 && d.startsWith(proj.slice(0, 170))) || proj); }
    return long.get(proj);
  };
  for (const [sid, s] of sessions) {
    const p = path.join(ROOT, folderOf(s.project), sid + '.jsonl');
    let st; try { st = fs.statSync(p); } catch (e) { const k = keptOf(p); if (k) titles.set(sid, k.title); continue; }
    const k = keptOf(p);
    if (k && k.size === st.size && k.mtime === st.mtimeMs) { titles.set(sid, k.title); continue; }
    // Seen before: only what was added (and a little before it). own: 1 a name you gave it, which no made-up one replaces.
    const added = k && st.size >= k.size ? st.size - k.size + 4 * 1024 * 1024 : Infinity, x = lastTitles(p, { ignore, cap: added, chunk: Math.min(2 * 1024 * 1024, added) });
    const t = x.custom || (k && k.own ? k.title : '') || x.ai || (k ? k.title : ''), own = x.custom || (k && k.own && t === k.title) ? 1 : 0;
    titles.set(sid, t);
    if (x.scanned >= Math.min(st.size, added) || (x.custom && x.ai)) put.push([p, st.size, st.mtimeMs, t, own]);   // could not be read through: again next time
  }
  if (db && put.length) {
    try { db.exec('BEGIN'); const q = db.prepare('INSERT INTO usage_titles (path, size, mtime, title, own) VALUES (?, ?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET size = excluded.size, mtime = excluded.mtime, title = excluded.title, own = excluded.own'); for (const x of put) q.run(...x); db.exec('COMMIT'); } catch (e) { try { db.exec('ROLLBACK'); } catch (x) {} }
  }
}

const list = (map, name, limit) => [...map.entries()].map(([k, v]) => Object.assign({ [name]: k }, v)).sort((a, b) => b.cost - a.cost || b.tok - a.tok).slice(0, limit || 1000);
const daysInMonth = new Date(Number(m[1]), Number(m[2]), 0).getDate();
process.stdout.write(JSON.stringify({
  ok: true, month: ym, from, to, daysInMonth, computedAt: Date.now(), tookMs: Date.now() - started,
  // dataAt: when cc-statusline last brought its records up to date.
  priced: records === 0 || Object.keys(prices).length > 0, files, bytes, records, unpricedTok, approxTok, dataAt: Number.isFinite(meta.at) ? meta.at : null,
  total,
  days: Array.from({ length: daysInMonth }, (_, i) => Object.assign({ day: i + 1 }, days.get(i + 1) || zero())),
  models: list(models, 'model'),
  // path: the real folder when it could be recovered; name: its last part, or the encoded name when not.
  projects: list(projects, 'id').map((p) => Object.assign(p, { path: pathOf(p.id), name: pathOf(p.id) ? baseName(pathOf(p.id)) : p.id })),
  sessions: list(sessions, 'sessionId', 500).map((s) => Object.assign(s, { title: titles.get(s.sessionId) || '', projectName: pathOf(s.project) ? baseName(pathOf(s.project)) : s.project })),
  // role: '' is the conversations themselves. models / projects: where that role's cost went, largest first.
  roles: list(roles, 'role').map((r) => Object.assign(r, {
    models: Object.entries(r.models).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([model, cost]) => ({ model, cost })),
    projects: Object.entries(r.projects).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id, cost]) => ({ name: pathOf(id) ? baseName(pathOf(id)) : id, cost })) })),
  sessionCount: sessions.size,
  slice: { models: slice.models, roles: slice.roles, runs: slice.runs, cells: slice.cells.map((c) => { c[8] = Math.round(c[8] * 1e8) / 1e8; return c; }),
    projects: slice.projects.map((id) => [id, pathOf(id) ? baseName(pathOf(id)) : id, pathOf(id)]),
    sessions: slice.sessions.map((sid) => [sid, ix.p.get(sessions.get(sid).project), titles.get(sid) || '']) },
}));
