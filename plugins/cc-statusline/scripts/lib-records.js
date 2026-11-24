// The usage records: one line for every API message on this machine, counted
// once, priced, kept for good. THE place token usage is collected from the
// transcripts; everything that adds figures up (our own all-usage-refresh.js,
// session-board's monthly page, harness's health check) reads these and never
// the transcripts (docs/data-boundary.md).
//
// Public, under ~/.claude/usage-data/records/ :
//   meta.json                  { v: 1, at, prices, modelIds, projects, months, records }
//       at        ms, when every transcript was last looked at (a conversation a hook named is in sooner)
//       prices    { key: { in, out, cw, cw1h, cr, exact } } USD per million tokens
//       modelIds  { model id as written by Claude Code: key }
//       projects  { project folder name: { path } } the real folder, when it could be told
//       months    ["2026-11", ...] the folders there are
//       unread    how many transcripts and folders could not be read the last time every one was looked at
//   <yyyy-mm>/<project>.jsonl  one record a line; the month is that of ts in UTC, the
//                              project is the folder name under ~/.claude/projects
//       id      message id
//       ts      ms
//       sid     session id
//       agent   '' the conversation itself, else the subagent's id
//       role    the subagent's role; for a conversation the role it was started as
//       team    1: a team member
//       file    transcript, relative to the project folder (left out: <sid>.jsonl)
//       line    its line there, from 1
//       model   id as written by Claude Code;  key: its price-table key ('' not a Claude model)
//       in out cw5 cw1 rd think   tokens: input, output, 5-minute and 1-hour cache write, cache read, thinking (part of out)
//       cost    USD at list price
//       flag    'approx' priced at a stand-in rate, 'unpriced' no price (cost 0); left out: exact
//       entry   Claude Code's entrypoint (cli, sdk-cli ...), when written
//       a number that is 0 and a text that is '' are left out
//   No conversation text. Fields are added, never changed. Lines are in the order they were collected.
// Our own (may change): .own/ -- how far each transcript was read (files.json), which messages are
// in (ids.txt), the prices the records were priced at (priced.json), and dirty, there from the first
// record written until all of it is noted: a run that ended in between is mended by the next one.
//
// A transcript is read from where the last reading stopped. A message stands in it
// several times (once per content block), again in the parent when a subagent
// produced it, again in every copy of the conversation: the first one collected is
// kept. Subagents before conversations, older files before younger ones; and what a
// copy says was another conversation's request is left to that one while it is there.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const priceLib = require('./lib-price');

const CLAUDE = path.join(os.homedir(), '.claude');
const ROOT = path.join(CLAUDE, 'projects');
const DIR = path.join(CLAUDE, 'usage-data', 'records');
const OWN = path.join(DIR, '.own');
const FILES = path.join(OWN, 'files.json'), IDS = path.join(OWN, 'ids.txt'), PRICED = path.join(OWN, 'priced.json'), DIRTY = path.join(OWN, 'dirty'), LOCK = path.join(OWN, 'lock'), META = path.join(DIR, 'meta.json');
const LOCK_STALE_MS = 10 * 60000, LOCK_TOUCH_MS = 30000;   // a run that is at work says so this often
const FULL_EVERY_MS = 10 * 60000;   // every transcript is looked at this often; the one a hook names at once
const FLUSH = 20000;                // records held before they are written
const num = priceLib.num;
const readJson = (f) => { try { const j = JSON.parse(fs.readFileSync(f, 'utf8')); return j && typeof j === 'object' && !Array.isArray(j) ? j : null; } catch (e) { return null; } };
const sleep = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (e) {} };
// Whole or not at all. On Windows a file someone is reading cannot be replaced: tried again for a moment.
const writeWhole = (f, text) => {
  const tmp = f + '.' + process.pid + '.tmp';
  try {
    fs.writeFileSync(tmp, text);
    for (let n = 0; ; n++) { try { fs.renameSync(tmp, f); return; } catch (e) { if (n >= 20 || !/^(EPERM|EBUSY|EACCES)$/.test(e.code)) throw e; sleep(50); } }
  } catch (e) { try { fs.unlinkSync(tmp); } catch (_) {} throw e; }
};
const hash = (id) => crypto.createHash('md5').update(id).digest('base64').slice(0, 12);
// What tells a message from another: its id; one written without an id, by all that is known of it.
const keyOf = (r) => hash(r.id || [r.ts, r.model || '', r.in || 0, r.out || 0, r.cw5 || 0, r.cw1 || 0, r.rd || 0].join('|'));
const safeName = (p) => (p.length > 180 ? p.slice(0, 170) + '-' + crypto.createHash('md5').update(p).digest('hex').slice(0, 8) : p);
const monthOf = (ts) => new Date(ts).toISOString().slice(0, 7);

// Every transcript there is: [{p, rel: [project, ...], size, mtime, birth}]
function transcripts() {
  const out = []; out.partial = 0;
  (function walk(d, rel) {
    let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { if (e.code !== 'ENOENT') out.partial++; return; }
    for (const e of es) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, rel.concat(e.name));
      else if (e.name.endsWith('.jsonl')) { const t = one(p, rel.concat(e.name)); if (t) out.push(t); else if (fs.existsSync(p)) out.partial++; }
    }
  })(ROOT, []);
  return out;
}
function one(p, rel) {
  try { const st = fs.statSync(p); return st.isFile() ? { p, rel, size: st.size, mtime: st.mtimeMs, birth: st.birthtimeMs } : null; } catch (e) { return null; }
}
// One conversation's: its transcript and everything beside it.
function ofSession(transcript) {
  let rel = path.relative(ROOT, transcript).split(path.sep);
  if (rel.length === 2 && (process.platform === 'win32' || process.platform === 'darwin')) {   // a hook may spell the names otherwise than the disk does
    const as = (d, n) => { try { const es = fs.readdirSync(d); return es.includes(n) ? n : es.find((x) => x.toLowerCase() === n.toLowerCase()) || n; } catch (e) { return n; } };
    const pr = as(ROOT, rel[0]); rel = [pr, as(path.join(ROOT, pr), rel[1])]; transcript = path.join(ROOT, ...rel);
  }
  if (rel[0] === '..' || path.isAbsolute(rel.join(path.sep)) || !rel[rel.length - 1].endsWith('.jsonl')) return [];
  const out = []; const main = one(transcript, rel); if (main) out.push(main);
  (function walk(d, r) {
    let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of es) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, r.concat(e.name));
      else if (e.name.endsWith('.jsonl')) { const t = one(p, r.concat(e.name)); if (t) out.push(t); }
    }
  })(transcript.replace(/\.jsonl$/, ''), rel.slice(0, -1).concat(path.basename(transcript, '.jsonl')));
  return out;
}

// Whose record a transcript is: <project>/<sid>.jsonl a conversation, deeper ones a subagent's
// (the role is beside it, in <name>.meta.json; a team member's own name is in agentType and its role in customAgentType).
function whose(t) {
  const [project, ...rest] = t.rel;
  if (!rest.length) return { project: '（專案目錄外）', folder: '', sid: project.replace(/\.jsonl$/, ''), agent: '', role: '', team: 0, file: project };
  const sid = rest[0].replace(/\.jsonl$/, ''), sub = rest.length > 1;
  const w = { project: safeName(project), folder: project, sid, agent: sub ? path.basename(rest[rest.length - 1], '.jsonl') : '', role: '', team: 0, file: rest.join('/') };
  if (sub) { const j = readJson(t.p.replace(/\.jsonl$/, '.meta.json')); w.role = j ? String(j.customAgentType || j.agentType || '?').slice(0, 80) : '?'; w.team = j && j.teamName ? 1 : 0; }
  return w;
}

const CHUNK = 1 << 20;
const USAGE = Buffer.from('"usage"'), AS = Buffer.from('"agentSetting"');
const MARK = 256;   // bytes before where the last reading stopped, kept as a hash: a file rewritten since is read again from the start
function markOf(fd, off) {
  const n = Math.min(MARK, off); if (!n) return '';
  const b = Buffer.alloc(n); fs.readSync(fd, b, 0, n, off - n);
  return crypto.createHash('md5').update(b).digest('base64').slice(0, 12);
}
// Reads what was added to t since st = {off, line, mark}, whole lines only; on(line object, number).
function readNew(t, st, on) {
  let fd; try { fd = fs.openSync(t.p, 'r'); } catch (e) { return false; }
  try { if (st.off > t.size || (st.off && st.mark !== markOf(fd, st.off))) { st.off = 0; st.line = 0; delete st.as; } } catch (e) { try { fs.closeSync(fd); } catch (_) {} return false; }
  const buf = Buffer.allocUnsafe(CHUNK);
  let carry = [], pos = st.off;
  try {
    while (pos < t.size) {
      const n = fs.readSync(fd, buf, 0, Math.min(CHUNK, t.size - pos), pos);
      if (n <= 0) break;
      let from = 0;
      for (let i = buf.indexOf(10, 0); i >= 0 && i < n; i = buf.indexOf(10, from)) {
        const piece = buf.subarray(from, i), l = carry.length ? Buffer.concat([...carry, piece]) : piece;
        carry = []; from = i + 1; st.line++;
        st.off = pos + from;
        if (l.indexOf(USAGE) >= 0 || l.indexOf(AS) >= 0) { let j = null; try { j = JSON.parse(l.toString('utf8')); } catch (e) {} if (j && typeof j === 'object') on(j, st.line); }
        if (from >= n) break;
      }
      if (from < n) carry.push(Buffer.from(buf.subarray(from, n)));
      pos += n;
    }
    st.mark = markOf(fd, st.off);
  } catch (e) { return false; } finally { try { fs.closeSync(fd); } catch (e) {} }
  return true;
}

// The real folder of a project not known yet, from the head of one of its conversations.
function pathsOf(list, projects) {
  const tried = new Map();   // project -> how many of its conversations were looked into (its folder cannot always be told)
  for (const t of list) {
    if (t.rel.length !== 2) continue;
    const name = safeName(t.rel[0]);
    if (projects[name] || (tried.get(name) || 0) >= 3) continue;
    tried.set(name, (tried.get(name) || 0) + 1);
    let fd;
    try {
      fd = fs.openSync(t.p, 'r');
      const b = Buffer.alloc(65536), n = fs.readSync(fd, b, 0, b.length, 0);
      for (const m of b.toString('utf8', 0, n).matchAll(/"cwd":("(?:[^"\\]|\\.)*")/g)) { let c = ''; try { c = JSON.parse(m[1]); } catch (e) {} if (c && c.replace(/[^a-zA-Z0-9]/g, '-') === t.rel[0]) { projects[name] = { path: c }; break; } }
    } catch (e) {} finally { if (fd !== undefined) try { fs.closeSync(fd); } catch (e) {} }
  }
}

// Every record file: [{month, project, p}]
function recordFiles(months) {
  const out = [];
  let ms; try { ms = fs.readdirSync(DIR).filter((m) => /^\d{4}-\d{2}$/.test(m)).sort(); } catch (e) { return out; }
  for (const m of ms) {
    if (months && !months.includes(m)) continue;
    let fs2; try { fs2 = fs.readdirSync(path.join(DIR, m)); } catch (e) { continue; }
    for (const f of fs2) if (f.endsWith('.jsonl')) out.push({ month: m, project: f.slice(0, -6), p: path.join(DIR, m, f) });
  }
  return out;
}
// Reads one record file; a line that cannot be read (being written) is passed over.
function eachRecord(p, on) {
  let text; try { text = fs.readFileSync(p, 'utf8'); } catch (e) { return; }
  let from = 0;
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', from)) {
    const l = text.slice(from, i); from = i + 1;
    if (!l) continue;
    let r; try { r = JSON.parse(l); } catch (e) { continue; }
    if (r && typeof r === 'object') on(r);
  }
}

// After a run that did not finish: the part of a line at the end of a file goes, and which messages are in, how many,
// and which models, are read from the records. What cannot be read now is a reason to try again later, not to go on.
function repair(modelIds, mine) {
  const ids = new Set();
  let count = 0;
  for (const f of recordFiles()) {
    mine();
    const text = fs.readFileSync(f.p, 'utf8');
    if (text && !text.endsWith('\n')) writeWhole(f.p, text.slice(0, text.lastIndexOf('\n') + 1));
    eachRecord(f.p, (r) => { ids.add(keyOf(r)); count++; if (r.model && r.key) modelIds[r.model] = r.key; });
  }
  writeWhole(IDS, [...ids].join('\n') + (ids.size ? '\n' : ''));
  return { ids, count };
}

// Records of a model whose price changed are priced again. -> whether every file could be written
function reprice(changed, resolve, mine) {
  let ok = true;
  const set = new Set(changed);
  for (const f of recordFiles()) {
    mine();
    let text; try { text = fs.readFileSync(f.p, 'utf8'); } catch (e) { ok = false; continue; }
    if (!changed.some((k) => text.includes('"key":"' + k + '"'))) continue;
    const out = text.split('\n').map((l) => {
      if (!l) return l;
      let r; try { r = JSON.parse(l); } catch (e) { return l; }
      return set.has(r.key) ? JSON.stringify(priced(r, resolve(r.model))) : l;
    });
    mine();
    try { writeWhole(f.p, out.join('\n')); } catch (e) { ok = false; }
  }
  return ok;
}
function priced(r, res) {
  const pr = res.pr, n = (x) => x || 0;
  const cost = pr ? (n(r.in) * pr.in + n(r.out) * pr.out + n(r.cw5) * pr.cw + n(r.cw1) * pr.cw1h + n(r.rd) * pr.cr) / 1e6 : 0;
  delete r.cost; delete r.flag;
  if (cost) r.cost = Math.round(cost * 1e9) / 1e9;
  if (!pr) r.flag = 'unpriced'; else if (!res.exact) r.flag = 'approx';
  return r;
}

// Brings the records up to date. o.transcript: only that conversation (and everything, when that is due); else everything.
// -> {added, everything, missing: price keys to look up, stale: keys whose records could not be priced again yet} or null: another run is at it.
function collect(o = {}) {
  fs.mkdirSync(OWN, { recursive: true });
  if (!priceLib.acquireRunLock(LOCK, LOCK_STALE_MS)) return null;
  let touched = Date.now();
  // Still ours? (a machine that slept may have lost it) Nothing is written once it is not.
  const mine = () => {
    if (!priceLib.ownsRunLock(LOCK)) throw new Error('the lock was taken over');
    const now = Date.now();
    if (now - touched > LOCK_TOUCH_MS) { touched = now; try { const d = new Date(now); fs.utimesSync(LOCK, d, d); } catch (e) {} }
  };
  try {
    mine();
    const { table } = priceLib.loadTable(), resolve = priceLib.makeResolver(table);
    const own = readJson(FILES) || {}, state = own.files && typeof own.files === 'object' ? own.files : {}, kept = readJson(META), meta = kept || {};
    if (!kept) own.full = undefined;   // gone, or cannot be read: made again, and everything is looked at
    const now = Date.now();
    const everything = !o.transcript || !(Number.isFinite(own.full) && own.full <= now && now - own.full < FULL_EVERY_MS);
    const modelIds = meta.modelIds && typeof meta.modelIds === 'object' ? meta.modelIds : {}, projects = meta.projects && typeof meta.projects === 'object' ? meta.projects : {};
    let count = Number.isFinite(meta.records) ? meta.records : 0, at = Number.isFinite(meta.at) ? meta.at : 0, unreadN = Number.isFinite(meta.unread) ? meta.unread : 0, ids = null;

    const mend = () => { const r = repair(modelIds, mine); ids = r.ids; count = r.count; };
    if (fs.existsSync(DIRTY) || (!kept && (fs.existsSync(IDS) || recordFiles().length))) mend();
    const known = () => {
      if (!ids) { if (!fs.existsSync(IDS)) mend(); else ids = new Set(fs.readFileSync(IDS, 'utf8').split('\n').filter(Boolean)); }
      return ids;
    };

    // ── prices: the records are brought to today's before any is added ──
    const pricedAt = readJson(PRICED) || {};
    const priceNow = (key) => { const id = Object.keys(modelIds).find((m) => modelIds[m] === key), r = id ? resolve(id) : null; return r && r.pr ? ['in', 'out', 'cw', 'cw1h', 'cr'].map((x) => r.pr[x]).join(',') + (r.exact ? '' : '~') : ''; };
    let stale = new Set();   // priced otherwise than today, and it could not be put right now: tried again next time
    const changed = [...new Set(Object.values(modelIds))].filter((k) => (pricedAt[k] === undefined ? null : pricedAt[k]) !== priceNow(k));
    const notePriced = () => { for (const k of new Set(Object.values(modelIds))) if (!stale.has(k)) pricedAt[k] = priceNow(k); writeWhole(PRICED, JSON.stringify(pricedAt)); };
    if (changed.length) { if (reprice(changed, resolve, mine)) notePriced(); else stale = new Set(changed); }

    const writeMeta = () => {
      const prices = {};
      for (const [model, key] of Object.entries(modelIds)) { const r = resolve(model); if (r.pr) prices[key] = Object.assign({}, r.pr, { exact: r.exact }); }
      writeWhole(META, JSON.stringify({ v: 1, at, prices, modelIds, projects, months: [...new Set(recordFiles().map((f) => f.month))], records: count, unread: unreadN }));
    };

    let held = new Map(), heldIds = [], n = 0, added = 0;
    const missing = new Set();
    // Everything that belongs to the records held is written, and noted, before dirty goes.
    const flush = () => {
      mine();
      if (n) {
        fs.writeFileSync(DIRTY, String(process.pid));
        for (const [f, lines] of held) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.appendFileSync(f, lines.join('')); }
        fs.appendFileSync(IDS, heldIds.join('\n') + '\n');
        count += n;
      }
      notePriced();
      writeMeta();
      writeWhole(FILES, JSON.stringify({ full: own.full, files: state }));
      try { fs.unlinkSync(DIRTY); } catch (e) {}
      held = new Map(); heldIds = []; n = 0;
    };

    const list = everything ? transcripts() : ofSession(o.transcript);
    list.sort((a, b) => (a.rel.length > 2 ? 0 : 1) - (b.rel.length > 2 ? 0 : 1) || a.birth - b.birth || (a.p < b.p ? -1 : 1));
    const known0 = new Set(Object.keys(state).filter((k) => k.split('/').length === 2).map((k) => k.slice(k.indexOf('/') + 1, -6)));   // seen before, also when its folder cannot be read now
    const there = new Set(list.filter((t) => t.rel.length === 2).map((t) => t.rel[1].slice(0, -6)));
    const conversations = there;
    const isThere = (sid, t) => conversations.has(sid) || known0.has(sid) || fs.existsSync(path.join(path.dirname(t.p), sid + '.jsonl'));

    const put = (w, r, h) => {
      const res = resolve(r.model || '');
      if (res.key) { modelIds[r.model] = res.key; if (!res.exact) missing.add(res.key); }
      const ts = r.ts;
      for (const x of Object.keys(r)) if (r[x] === 0 || r[x] === '') delete r[x];
      priced(r, res);
      const f = path.join(DIR, monthOf(ts), w.project + '.jsonl');
      if (!held.has(f)) held.set(f, []);
      held.get(f).push(JSON.stringify(r) + '\n'); heldIds.push(h); n++; added++;
    };
    // Carried over by a copy, and left to the conversation it says it was said in: the copy's after all when that one,
    // once everything was read, does not have it. Until that is settled the copy is marked to be read again (again),
    // so a run that ends before loses nothing.
    const left = [], unread = new Set();

    for (const t of list) {
      const k = t.rel.join('/');
      let st = state[k];
      const again = everything && st && st.again;
      if (st && !again && st.size === t.size && st.mtime === t.mtime) continue;
      mine();
      const leftBefore = left.length;
      st = st && !again ? { again: st.again,  off: st.off, line: st.line, mark: st.mark, as: st.as } : { off: 0, line: 0 };
      const w = whose(t), seen = known();
      const ok = readNew(t, st, (j, line) => {
        if (j.type === 'agent-setting' && typeof j.agentSetting === 'string') { st.as = j.agentSetting.slice(0, 80); return; }
        const m = j.message, u = m && typeof m === 'object' ? m.usage : null;
        if (!u || typeof u !== 'object') return;
        const model = typeof m.model === 'string' ? m.model : '';
        if (model === '<synthetic>') return;   // written by the program: nothing was called
        const ts = Date.parse(j.timestamp);
        if (!(ts >= 1e12 && ts < 4102444800000)) return;   // not a time (2001 to 2100)
        let carried = '';
        const id = typeof m.id === 'string' ? m.id : '';
        if (id && seen.has(hash(id))) return;   // most lines: told before anything else is worked out
        if (!w.agent && typeof j.requestSessionId === 'string' && j.requestSessionId && j.requestSessionId !== w.sid && /^[\w-]+$/.test(j.requestSessionId) && isThere(j.requestSessionId, t)) carried = j.requestSessionId;
        if (typeof j.cwd === 'string' && w.folder && !projects[w.project] && j.cwd.replace(/[^a-zA-Z0-9]/g, '-') === w.folder) projects[w.project] = { path: j.cwd };
        const res = resolve(model), cwAll = num(u.cache_creation_input_tokens), cw1 = Math.min(cwAll, num(u.cache_creation && u.cache_creation.ephemeral_1h_input_tokens));
        const r = { id, ts, sid: w.sid, agent: w.agent, role: w.role || st.as || '', team: w.team, file: w.file === w.sid + '.jsonl' ? '' : w.file, line, model, key: res.key,
          in: num(u.input_tokens), out: num(u.output_tokens), cw5: cwAll - cw1, cw1, rd: num(u.cache_read_input_tokens), think: num(u.output_tokens_details && u.output_tokens_details.thinking_tokens), entry: typeof j.entrypoint === 'string' ? j.entrypoint.slice(0, 20) : '' };
        const h = keyOf(r);
        if (seen.has(h)) return;
        if (carried) { left.push({ w, r, h, of: carried, st }); return; }
        seen.add(h);
        put(w, r, h);
      });
      if (!ok) { unread.add(w.agent ? k : w.sid); left.length = leftBefore; continue; }   // could not be read now: tried again next time
      st.size = t.size; st.mtime = t.mtime; if (!st.as) delete st.as;
      if (left.length > leftBefore) st.again = 1; else if (again || !st.again) delete st.again;
      state[k] = st;
      if (n >= FLUSH) flush();
    }
    if (everything) {
      const open = new Set();
      for (const x of left) {
        if (known().has(x.h)) continue;
        if (unread.has(x.of) || (list.partial && !there.has(x.of))) { open.add(x.st); continue; }   // the original could not be read this time: not settled
        known().add(x.h); put(x.w, x.r, x.h);
      }
      for (const x of left) if (!open.has(x.st)) delete x.st.again;
    }
    if (everything) {
      pathsOf(list, projects);
      const names = new Set(list.map((t) => t.rel.join('/')));
      if (!list.partial) for (const k of Object.keys(state)) if (!names.has(k)) delete state[k];   // cleared away by Claude Code; its records stay
      own.full = now; at = now; unreadN = list.partial + unread.size;
    }
    flush();
    return { added, everything, missing: [...missing], stale: [...stale] };
  } finally { priceLib.releaseRunLock(LOCK); }
}

module.exports = { collect, recordFiles, eachRecord, DIR, META, safeName, monthOf };
