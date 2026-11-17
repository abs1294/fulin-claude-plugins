#!/usr/bin/env node
'use strict';
// Token usage and API-equivalent cost for one calendar month, across EVERY
// session on this machine (open or long closed, main conversations and
// subagents). Prints one JSON object on stdout.
//
//   node usage-scan.js 2026-11
//
// Run as its own process by lib/monthly.js: a scan reads gigabytes and would
// freeze the board's server for seconds if done inline.
//
// How it counts (the same rules as cc-statusline's all-usage-refresh.js, plus
// the month):
//   - every transcript under ~/.claude/projects whose file was modified on or
//     after the first of the month (an older file cannot hold this month's turns);
//   - a turn belongs to the month its own timestamp falls in, local time;
//   - one API message is written to disk several times (once per content
//     block, again in the parent when a subagent produced it, again in every
//     fork of the session), so it is counted once, by message id. Measured
//     2026-11-13: 32,131 duplicates against 29,438 real records; without this
//     the month would read about double;
//   - priced per model with cc-statusline's price table (five rates: input,
//     output, 5-minute cache write, 1-hour cache write, cache read).
// Memory: files are read in 1 MB pieces, never whole (the largest transcript
// here is 400 MB). Measured: 2.2 GB scanned in 5 seconds using 83 MB.
// The month in progress is not read from the start each time: see "reading" below.
const fs = require('fs');
const os = require('os');
const path = require('path');
const baseName = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || '';   // either kind of slash (a path written on Windows, read on a Mac)

const ym = process.argv[2] || '';
const m = /^(\d{4})-(\d{2})$/.exec(ym);
if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) { process.stdout.write(JSON.stringify({ ok: false, error: 'month must be YYYY-MM' })); process.exit(0); }
const from = new Date(Number(m[1]), Number(m[2]) - 1, 1).getTime();
const to = new Date(Number(m[1]), Number(m[2]), 1).getTime();

// The price table lives in cc-statusline, which keeps it current (it looks up
// prices of models it has not seen). Found, in order: where the status line
// configured in settings.json runs from; beside this plugin in the same
// repository; among the installed plugins. Without it there are tokens but no cost.
function findPriceLib() {
  const tries = [];
  try {
    const s = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8'));
    const cmd = s && s.statusLine && typeof s.statusLine.command === 'string' ? s.statusLine.command : '';
    const hit = /([A-Za-z]:[\\/][^"']*?|\/[^"'\s]*?)[\\/]statusline\.js/.exec(cmd);
    if (hit) tries.push(path.join(hit[1], 'scripts', 'lib-price.js'));
  } catch (e) {}
  tries.push(path.join(__dirname, '..', '..', 'cc-statusline', 'scripts', 'lib-price.js'));
  try {
    const cache = path.join(os.homedir(), '.claude', 'plugins', 'cache');
    for (const market of fs.readdirSync(cache)) {
      const dir = path.join(cache, market, 'cc-statusline');
      let versions = [];
      try { versions = fs.readdirSync(dir).sort().reverse(); } catch (e) { continue; }
      for (const v of versions) tries.push(path.join(dir, v, 'scripts', 'lib-price.js'));
    }
  } catch (e) {}
  for (const p of tries) { try { if (fs.existsSync(p)) return { lib: require(p), file: p }; } catch (e) {} }
  return null;
}
const price = findPriceLib();
let resolvePrice = () => ({ key: '', pr: null, exact: true });
let sig = '';
if (price) { const t = price.lib.loadTable(); resolvePrice = price.lib.makeResolver(t.table); sig = t.sig; }
const num = (x) => (Number.isFinite(x) ? Math.max(0, x) : 0);
const costOf = (u, pr) => {
  const cwAll = num(u.cache_creation_input_tokens);
  const cw1h = Math.min(cwAll, num(u.cache_creation && u.cache_creation.ephemeral_1h_input_tokens));
  return (num(u.input_tokens) * pr.in + num(u.output_tokens) * pr.out + (cwAll - cw1h) * pr.cw + cw1h * pr.cw1h + num(u.cache_read_input_tokens) * pr.cr) / 1e6;
};

const root = path.join(os.homedir(), '.claude', 'projects');
const files = [];
(function walk(d) {
  let ents;
  try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
  for (const e of ents) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.jsonl')) { try { const st = fs.statSync(p); if (st.mtimeMs >= from) files.push({ p, size: st.size, mtimeMs: st.mtimeMs }); } catch (x) {} }
  }
})(root);

// A "project" is the folder a session was started in: the first folder level
// under ~/.claude/projects, which Claude Code names after that folder with
// every non-alphanumeric character turned into '-'. Grouping by the working
// directory of each turn instead split one project across every worktree and
// subfolder Claude happened to cd into (measured: 40+ rows for a handful of
// projects). The real path is recovered from any turn whose working directory
// encodes to the folder's name.
const projPath = new Map();
const projOf = (file) => path.relative(root, file).split(path.sep)[0];

// n: how many API messages (calls to the model) went into the bucket.
const zero = () => ({ in: 0, out: 0, cw: 0, cr: 0, tok: 0, cost: 0, n: 0 });
const total = zero();
const days = new Map(), models = new Map(), projects = new Map(), sessions = new Map(), titles = new Map(), roles = new Map();
// Who did the work a transcript holds: '' for a conversation itself, else the role of the subagent (or team member)
// whose own record it is. Claude Code keeps those under <session>/subagents/agent-<id>.jsonl, with the role beside
// it in agent-<id>.meta.json (agentType; a team member's own name is in agentType and its role in customAgentType).
const roleOf = (p) => {
  if (!path.relative(root, p).split(path.sep).includes('subagents')) return { role: '', team: false };
  try { const j = JSON.parse(fs.readFileSync(p.replace(/.jsonl$/, '.meta.json'), 'utf8')); return { role: String(j.customAgentType || j.agentType || '?').slice(0, 80), team: !!j.teamName }; }
  catch (e) { return { role: '?', team: false }; }
};
const seen = new Set();
let records = 0, duplicates = 0, unpricedTok = 0, approxTok = 0, bytes = 0, reused = 0, readBytes = 0;
const add = (map, key, extra) => { let v = map.get(key); if (!v) { v = Object.assign(zero(), extra); map.set(key, v); } return v; };

// ── reading: what one file holds ──
// A transcript only ever grows at the end. So what a file held the last time is
// kept (in the board's database, table scan_file), and the next scan reads only
// what was added since: a file of the same size and time is not opened at all,
// a longer one is read from where the last scan stopped. Used for the month in
// progress, which is scanned again and again; a finished month is scanned once.
//
// Kept per file:
//   recs    one entry per API message in the month, each message once:
//           [id, time, model, input, output, cacheWrite, cacheWrite1h, cacheRead, sessionId]
//   dups    how many repeats of those messages the file held
//   titles  {sessionId: [title, isCustom]}
//   cwd     a working directory that encodes to the project folder's name
//   role    whose record the file is: '' a conversation's own, else the subagent's role (roleOf); team: a team member's
//   as      for a conversation's own record: the role it was started as, when it was
// Prices are applied afterwards, from the entries: the price table can change.
const USAGE = Buffer.from('"usage"'), AI = Buffer.from('"aiTitle"'), CUSTOM = Buffer.from('"customTitle"'), AS = Buffer.from('"agentSetting"');
function onLine(st, ids, line) {
  const hasUsage = line.indexOf(USAGE) >= 0;
  if (!hasUsage && line.indexOf(AI) < 0 && line.indexOf(CUSTOM) < 0 && line.indexOf(AS) < 0) return;
  let j;
  try { j = JSON.parse(line.toString('utf8')); } catch (e) { return; }
  // A conversation started as a role (claude --agent, which is how the board starts one) says so in its own record.
  if (j.type === 'agent-setting' && typeof j.agentSetting === 'string') { st.as = j.agentSetting.slice(0, 80); return; }
  // What a session was about, for the list of the month's costliest sessions.
  if (j.type === 'custom-title' && typeof j.customTitle === 'string' && j.sessionId) { st.titles[j.sessionId] = [j.customTitle, 1]; return; }
  if (j.type === 'ai-title' && typeof j.aiTitle === 'string' && j.sessionId) { const cur = st.titles[j.sessionId]; if (!cur || !cur[1]) st.titles[j.sessionId] = [j.aiTitle, 0]; return; }
  const msg = j.message;
  if (!msg || !msg.usage) return;
  const ts = Date.parse(j.timestamp);
  if (!ts || ts < from || ts >= to) return;
  if (msg.id) { if (ids.has(msg.id)) { st.dups++; return; } ids.add(msg.id); }
  const u = msg.usage;
  const cwAll = num(u.cache_creation_input_tokens);
  st.recs.push([msg.id || '', ts, typeof msg.model === 'string' ? msg.model : '', num(u.input_tokens), num(u.output_tokens), cwAll,
    Math.min(cwAll, num(u.cache_creation && u.cache_creation.ephemeral_1h_input_tokens)), num(u.cache_read_input_tokens), j.sessionId || '']);
  if (!st.cwd && typeof j.cwd === 'string' && j.cwd.replace(/[^a-zA-Z0-9]/g, '-') === st.proj) st.cwd = j.cwd;
}

const CHUNK = 1 << 20;
const buf = Buffer.allocUnsafe(CHUNK);
// Reads f from st.offset to the last complete line. The exception is a file
// whose last line has no line break and that is being read to its end for the
// first time in this run: that line is taken too, but the offset stays before
// it, so a later scan reads it again once it is complete (its message id makes
// the second reading a repeat, not a second count).
function readFrom(f, st) {
  const ids = new Set(st.recs.map((r) => r[0]).filter(Boolean));
  let fd;
  try { fd = fs.openSync(f.p, 'r'); } catch (e) { return; }
  let carry = null, pos = st.offset, lineStart = st.offset;
  try {
    for (;;) {
      const n = fs.readSync(fd, buf, 0, CHUNK, pos);
      if (n <= 0) break;
      let start = 0;
      for (let i = buf.indexOf(10, 0); i >= 0 && i < n; i = buf.indexOf(10, start)) {
        const piece = buf.subarray(start, i);
        onLine(st, ids, carry ? Buffer.concat([carry, piece]) : piece);
        carry = null;
        start = i + 1;
        lineStart = pos + start;
        if (start >= n) break;
      }
      if (start < n) { const rest = Buffer.from(buf.subarray(start, n)); carry = carry ? Buffer.concat([carry, rest]) : rest; }
      pos += n;
    }
    if (carry && carry.length) { const before = st.recs.length, dupsBefore = st.dups; onLine(st, ids, carry); st.tail = st.recs.length - before; st.tailDups = st.dups - dupsBefore; } else { st.tail = 0; st.tailDups = 0; }
  } catch (e) {
  } finally { try { fs.closeSync(fd); } catch (e) {} }
  readBytes += pos - st.offset;
  st.offset = lineStart;
}

// The scans kept from last time, when this month is the one to keep them for.
const nowYm = (() => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); })();
const useCache = process.env.SESSION_BOARD_SCAN_CACHE === '1' || (process.env.SESSION_BOARD_SCAN_CACHE !== '0' && ym === nowYm);
let db = null;
const kept = new Map();
if (useCache) {
  try {
    db = require(path.join(__dirname, '..', 'lib', 'db.js')).open();
    db.exec('CREATE TABLE IF NOT EXISTS scan_file (path TEXT PRIMARY KEY, month TEXT NOT NULL, size INTEGER NOT NULL, mtime REAL NOT NULL, data TEXT NOT NULL)');
    db.prepare('DELETE FROM scan_file WHERE month <> ?').run(ym);
    for (const r of db.prepare('SELECT path, size, mtime, data FROM scan_file').all()) { try { kept.set(r.path, { size: r.size, mtime: r.mtime, st: JSON.parse(r.data) }); } catch (e) {} }
  } catch (e) { db = null; }
}

const started = Date.now();
const states = [], changed = [];
for (const f of files) {
  const proj = projOf(f.p);
  const old = kept.get(f.p);
  kept.delete(f.p);
  let st;
  if (old && old.st.proj === proj && old.size === f.size && old.mtime === f.mtimeMs) { st = old.st; reused++; if (typeof st.role !== 'string') { Object.assign(st, roleOf(f.p)); changed.push({ f, st }); } }
  else {
    if (old && old.st.proj === proj && f.size >= old.st.offset) {
      st = old.st;
      // The unfinished last line counted last time is read again now: take its entries back first.
      if (st.tail) st.recs.length -= st.tail;
      if (st.tailDups) st.dups -= st.tailDups;
    } else st = { proj, offset: 0, recs: [], dups: 0, titles: {}, cwd: '' };
    if (typeof st.role !== 'string') Object.assign(st, roleOf(f.p));
    readFrom(f, st);
    changed.push({ f, st });
  }
  bytes += f.size;
  states.push(st);
}
if (db) {
  try {
    db.exec('BEGIN');
    const put = db.prepare('INSERT INTO scan_file (path, month, size, mtime, data) VALUES (?, ?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET month = excluded.month, size = excluded.size, mtime = excluded.mtime, data = excluded.data');
    for (const { f, st } of changed) put.run(f.p, ym, f.size, f.mtimeMs, JSON.stringify(st));
    const gone = db.prepare('DELETE FROM scan_file WHERE path = ?');
    for (const p of kept.keys()) gone.run(p);   // files that no longer exist
    db.exec('COMMIT');
  } catch (e) { try { db.exec('ROLLBACK'); } catch (x) {} }
}

// ── adding up ──
// Subagents' own records first: should a message ever stand in both a conversation and a subagent's record, it is the subagent's.
states.sort((a, b) => (a.role === '' ? 1 : 0) - (b.role === '' ? 1 : 0));
for (const st of states) {
  let counted = false;
  duplicates += st.dups;
  if (st.cwd && !projPath.has(st.proj)) projPath.set(st.proj, st.cwd);
  for (const [sid, [t, custom]] of Object.entries(st.titles)) { const cur = titles.get(sid); if (custom || !cur || !cur.custom) titles.set(sid, { t, custom: !!custom }); }
  for (const [id, ts, model, inTok, outTok, cwAll, cw1h, crTok, sid] of st.recs) {
    if (id) { if (seen.has(id)) { duplicates++; continue; } seen.add(id); }
    const r = resolvePrice(model);
    if (!r.key) continue;   // not a model ('<synthetic>'): nothing was billed
    const part = { in: inTok, out: outTok, cw: cwAll, cr: crTok };
    part.tok = part.in + part.out + part.cw + part.cr;
    part.cost = r.pr ? (inTok * r.pr.in + outTok * r.pr.out + (cwAll - cw1h) * r.pr.cw + cw1h * r.pr.cw1h + crTok * r.pr.cr) / 1e6 : 0;
    if (!r.pr) unpricedTok += part.tok; else if (!r.exact) approxTok += part.tok;
    records++;
    for (const bucket of [total, add(days, new Date(ts).getDate()), add(models, r.key, { exact: r.exact, priced: !!r.pr }), add(projects, st.proj),
      add(sessions, sid, { project: st.proj, first: ts, last: ts })]) {
      bucket.in += part.in; bucket.out += part.out; bucket.cw += part.cw; bucket.cr += part.cr; bucket.tok += part.tok; bucket.cost += part.cost; bucket.n += 1;
    }
    const s = sessions.get(sid);
    if (ts < s.first) s.first = ts;
    if (ts > s.last) s.last = ts;
    const who = add(roles, st.role || st.as || '', { runs: 0, team: 0, models: {}, projects: {} });
    who.in += part.in; who.out += part.out; who.cw += part.cw; who.cr += part.cr; who.tok += part.tok; who.cost += part.cost; who.n += 1;
    who.models[r.key] = (who.models[r.key] || 0) + part.cost;
    who.projects[st.proj] = (who.projects[st.proj] || 0) + part.cost;
    counted = true;
  }
  // runs: how many records (one conversation, or one subagent sent out) had usage in the month; team: how many of them were team members.
  if (counted) { const who = roles.get(st.role || st.as || ''); who.runs++; if (st.team) who.team++; }
}

const list = (map, name, limit) => [...map.entries()].map(([k, v]) => Object.assign({ [name]: k }, v)).sort((a, b) => b.cost - a.cost || b.tok - a.tok).slice(0, limit || 1000);
const daysInMonth = new Date(Number(m[1]), Number(m[2]), 0).getDate();
process.stdout.write(JSON.stringify({
  ok: true, month: ym, from, to, daysInMonth, computedAt: Date.now(), tookMs: Date.now() - started,
  priced: !!price, priceSig: sig, files: files.length, bytes, records, duplicates, unpricedTok, approxTok,
  // reused: files not opened because nothing was added to them; readBytes: what was actually read this time.
  cached: !!db, reused, readBytes,
  total,
  days: Array.from({ length: daysInMonth }, (_, i) => Object.assign({ day: i + 1 }, days.get(i + 1) || zero())),
  models: list(models, 'model'),
  // path: the real folder when it could be recovered; name: its last part, or the encoded name when not.
  projects: list(projects, 'id').map((p) => Object.assign(p, { path: projPath.get(p.id) || '', name: projPath.has(p.id) ? baseName(projPath.get(p.id)) : p.id })),
  sessions: list(sessions, 'sessionId', 500).map((s) => Object.assign(s, { title: (titles.get(s.sessionId) || {}).t || '', projectName: projPath.has(s.project) ? baseName(projPath.get(s.project)) : s.project })),
  // role: '' is the conversations themselves. models / projects: where that role's cost went, largest first.
  roles: list(roles, 'role').map((r) => Object.assign(r, {
    models: Object.entries(r.models).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([model, cost]) => ({ model, cost })),
    projects: Object.entries(r.projects).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id, cost]) => ({ name: projPath.has(id) ? baseName(projPath.get(id)) : id, cost })) })),
  sessionCount: sessions.size,
}));
