'use strict';
// What a session changed.
//
// Two different questions, answered from two different places:
//
//   "What did THIS session change?"  - from its transcript. Claude Code writes down, with each Edit and Write, the file
//       and the exact lines taken out and put in (toolUseResult.structuredPatch; a new file: type "create" with its
//       content). That is this session's work and nobody else's, also when several sessions share a folder - and it
//       includes what its subagents changed (their transcripts lie beside it).
//       What it does NOT hold: a file changed by a command the session ran (a script, sed, git checkout, a build).
//       Nothing in the transcript says which files a command touched.
//
//   "What is uncommitted in this folder now?"  - from git. Everything, whoever changed it and however: all sessions
//       working there, and you. That is where a change made by a command shows up.
//
// Transcripts reach hundreds of megabytes. One is read as a stream, line by line (measured 2026-11-16: 63 MB with
// 680 changes in 0.3 s), only lines that can hold a change are parsed, and after the first look only what has been
// added to the file is read.
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { execFile } = require('child_process');

const MARK = '"structuredPatch"';
const CONTENT_LINES = 400;       // of a new file's content, this many lines are kept
const LINE_CHARS = 2000;         // a line longer than this is cut (a minified file)
const ITEMS_PER_FILE = 200;      // changes kept for one file (the newest)
const GIT_DIFF_MAX = 400 * 1024;

const cutLine = (s) => (s.length > LINE_CHARS ? s.slice(0, LINE_CHARS) + ' …（這一行太長，只顯示開頭）' : s);

// One transcript entry -> the change it records, or null.
function changeOf(e) {
  const r = e && e.toolUseResult;
  if (!r || typeof r !== 'object' || typeof r.filePath !== 'string' || !r.filePath) return null;
  const at = Date.parse(e.timestamp) || 0;
  const hunks = Array.isArray(r.structuredPatch) ? r.structuredPatch.filter((h) => h && Array.isArray(h.lines)) : [];
  if (r.type === 'create' || (!hunks.length && typeof r.content === 'string' && r.originalFile == null)) {
    const all = String(r.content || '').split('\n');
    const lines = all.slice(0, CONTENT_LINES).map(cutLine);
    return { path: r.filePath, at, uuid: e.uuid || '', kind: 'create', adds: all.length, dels: 0, lines, more: Math.max(0, all.length - lines.length) };
  }
  if (!hunks.length) return null;
  let adds = 0, dels = 0;
  const out = hunks.map((h) => {
    const lines = h.lines.map((l) => { const s = String(l); if (s[0] === '+') adds++; else if (s[0] === '-') dels++; return cutLine(s); });
    return { oldStart: Number(h.oldStart) || 0, oldLines: Number(h.oldLines) || 0, newStart: Number(h.newStart) || 0, newLines: Number(h.newLines) || 0, lines };
  });
  return { path: r.filePath, at, uuid: e.uuid || '', kind: 'edit', adds, dels, hunks: out };
}

// Reads `file` from byte `from` to its end, calling onChange for each change found. -> bytes read up to the last whole line
function scanFrom(file, from, onChange) {
  return new Promise((resolve) => {
    let size = 0; try { size = fs.statSync(file).size; } catch (e) { return resolve(from); }
    if (size <= from) return resolve(from);
    let seen = from, tail = '';
    const stream = fs.createReadStream(file, { start: from, end: size - 1, highWaterMark: 1 << 20 });
    stream.on('error', () => resolve(seen));
    // Bytes are counted on the raw chunks; a line is only taken once its newline has been seen, so a line still being
    // written is left for the next look.
    let pending = [];
    stream.on('data', (chunk) => {
      let start = 0;
      for (;;) {
        const nl = chunk.indexOf(10, start);
        if (nl < 0) break;
        const piece = chunk.subarray(start, nl);
        const line = pending.length ? Buffer.concat(pending.concat([piece])) : piece;
        pending = [];
        seen += line.length + 1;
        if (line.includes(MARK)) { try { const c = changeOf(JSON.parse(line.toString('utf8'))); if (c) onChange(c); } catch (e) {} }
        start = nl + 1;
      }
      if (start < chunk.length) pending.push(Buffer.from(chunk.subarray(start)));
      void tail;
    });
    stream.on('end', () => resolve(seen));
  });
}

const cache = new Map();   // transcript file -> {read: bytes, changes: [..]}
async function changesIn(file, by) {
  let c = cache.get(file);
  let size = 0; try { size = fs.statSync(file).size; } catch (e) { return []; }
  if (!c || size < c.read) { c = { read: 0, changes: [] }; cache.set(file, c); }
  if (size > c.read) {
    if (c.busy) await c.busy;
    else { c.busy = scanFrom(file, c.read, (x) => c.changes.push(Object.assign(x, { by }))).then((n) => { c.read = n; c.busy = null; }); await c.busy; }
  }
  return c.changes;
}

// The transcripts that make up one session: its own, and those of the subagents it started.
function transcriptsOf(file) {
  const out = [{ file, by: 'main' }];
  const dir = path.join(file.replace(/\.jsonl$/i, ''), 'subagents');
  let names = []; try { names = fs.readdirSync(dir); } catch (e) {}
  for (const n of names) if (/\.jsonl$/i.test(n)) out.push({ file: path.join(dir, n), by: 'subagent' });
  return out;
}

const keyOf = (p) => path.normalize(String(p)).toLowerCase();

// Every change of a session, gathered by file. -> Map key -> {path, changes: [...] oldest first}
async function gather(file) {
  const files = new Map();
  for (const t of transcriptsOf(file)) {
    for (const c of await changesIn(t.file, t.by)) {
      const k = keyOf(c.path);
      if (!files.has(k)) files.set(k, { path: path.normalize(c.path), changes: [] });
      files.get(k).changes.push(c);
    }
  }
  for (const f of files.values()) f.changes.sort((a, b) => a.at - b.at);
  return files;
}

// -> {files: [{path, name, adds, dels, changes, created, bySubagent, firstAt, lastAt, exists}], adds, dels}   newest first
async function summary(file, cwd) {
  const files = await gather(file);
  const out = [];
  for (const f of files.values()) {
    let adds = 0, dels = 0, sub = 0;
    for (const c of f.changes) { adds += c.adds; dels += c.dels; if (c.by === 'subagent') sub++; }
    let exists = false; try { exists = fs.statSync(f.path).isFile(); } catch (e) {}
    let rel = f.path;
    if (cwd) { const r = path.relative(cwd, f.path); if (r && !r.startsWith('..') && !path.isAbsolute(r)) rel = r; }
    out.push({ path: f.path, rel, name: path.basename(f.path), adds, dels, changes: f.changes.length, created: f.changes[0].kind === 'create', bySubagent: sub,
      firstAt: f.changes[0].at, lastAt: f.changes[f.changes.length - 1].at, exists });
  }
  out.sort((a, b) => b.lastAt - a.lastAt);
  return { files: out, adds: out.reduce((n, f) => n + f.adds, 0), dels: out.reduce((n, f) => n + f.dels, 0) };
}

// ── what a command changed: the folder's files whose time falls in the session ──
// A file made or changed by a command the session ran (a script writing a Word file) is in no transcript, and a folder
// that is not in git has no "uncommitted" either (asked 2026-11-20: two Word files made by a script showed nowhere).
// The folder is looked at instead: every file in it last written between the session's start and its last activity.
// It cannot tell who wrote one - another session or you, at that time, too - and says so.
const SKIP_DIR = /^(\.|node_modules$|__pycache__$|\.?venv$|bin$|obj$|dist$|build$|target$|out$|coverage$)/i;
const SKIP_FILE = /^(~\$|\.~lock|\.DS_Store$|Thumbs\.db$|desktop\.ini$)|\.(tmp|swp|lock)$/i;
const SCAN_MAX = 20000, SCAN_MS = 1500, FOUND_MAX = 200;
// Read without blocking: the board answers other requests while a big folder is looked through (it read synchronously
// at first, and a folder as big as the home folder held every other request for up to 1.5 s - review 2026-11-20).
async function touchedIn(cwd, since, until) {
  const fsp = fs.promises, out = [], t0 = Date.now(); let seen = 0;
  const over = () => seen > SCAN_MAX || Date.now() - t0 > SCAN_MS;
  const walk = async (dir, depth) => {
    if (depth > 6 || over()) return;
    let ents = []; try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const d of ents) {
      if (++seen > SCAN_MAX || Date.now() - t0 > SCAN_MS) return;
      const p = path.join(dir, d.name);
      if (d.isDirectory()) { if (!SKIP_DIR.test(d.name)) await walk(p, depth + 1); continue; }
      if (!d.isFile() || SKIP_FILE.test(d.name)) continue;
      let st; try { st = await fsp.stat(p); } catch (e) { continue; }
      if (st.mtimeMs >= since && st.mtimeMs <= until) out.push({ path: p, rel: path.relative(cwd, p), name: d.name, at: st.mtimeMs, size: st.size });
    }
  };
  await walk(cwd, 0);
  out.sort((a, b) => b.at - a.at);
  return { files: out.slice(0, FOUND_MAX), partial: over() };
}
// When the session was at work: its transcript's entries put into stretches (two entries less than GAP apart are one
// stretch), each widened by PAD. A session resumed over months is not "at work" all that time - only then. Read as a
// stream and remembered like the changes (only what was added since is read again).
// (30 minutes: a long command - a script making a Word file - leaves nothing in the transcript until it ends)
const GAP = 30 * 60000, PAD = 2 * 60000, TS = /"timestamp":"([^"]{10,40})"/;
const spansCache = new Map();   // transcript -> {read, spans: [[from, to]]}
function spansOf(file) {
  return new Promise((resolve) => {
    let c = spansCache.get(file); let size = 0; try { size = fs.statSync(file).size; } catch (e) { return resolve([]); }
    if (!c || size < c.read) { c = { read: 0, spans: [] }; spansCache.set(file, c); }
    if (size <= c.read) return resolve(c.spans);
    let seen = c.read, pending = '';
    const add = (t) => { const s = c.spans[c.spans.length - 1]; if (s && t - s[1] < GAP && t >= s[0]) s[1] = Math.max(s[1], t); else c.spans.push([t, t]); };
    const stream = fs.createReadStream(file, { start: c.read, end: size - 1, highWaterMark: 1 << 20, encoding: 'utf8' });
    stream.on('data', (chunk) => {
      const text = pending + chunk; const lines = text.split('\n'); pending = lines.pop();
      for (const l of lines) { seen += Buffer.byteLength(l) + 1; const m = TS.exec(l); const t = m && Date.parse(m[1]); if (t) add(t); }
    });
    const end = () => { c.read = seen; resolve(c.spans); };
    stream.on('end', end); stream.on('error', end);
  });
}
// When the session started: the time of the first entry in its transcript
function startOf(file) {
  try {
    const fd = fs.openSync(file, 'r'); const buf = Buffer.alloc(65536); const n = fs.readSync(fd, buf, 0, buf.length, 0); fs.closeSync(fd);
    for (const line of buf.subarray(0, n).toString('utf8').split('\n')) { try { const t = Date.parse(JSON.parse(line).timestamp); if (t) return t; } catch (e) {} }
  } catch (e) {}
  return 0;
}
// -> {files: [...], partial, since, until} - the folder's files written while the session (or one of its subagents) was
// at work, not already among its edits
async function touched(file, cwd, o = {}) {
  if (!cwd) return { files: [], since: 0, until: 0 };
  let spans = [];
  for (const t of transcriptsOf(file)) spans = spans.concat(await spansOf(t.file));
  spans = spans.map(([a, b]) => [a - PAD, b + PAD]).sort((x, y) => x[0] - y[0]);
  if (!spans.length) return { files: [], since: 0, until: 0 };
  const known = new Set([...(await gather(file)).keys()]);
  const since = spans[0][0], until = Math.max(...spans.map((s) => s[1]));
  const r = await touchedIn(cwd, since, until);
  const inSpan = (t) => spans.some(([a, b]) => t >= a && t <= b);
  return { files: r.files.filter((x) => !known.has(keyOf(x.path)) && inSpan(x.at)), partial: r.partial, since, until };
}

// ── what the session handed you: the files and links named in its replies ──
// (asked 2026-11-20: "the files and links in what it finally answers me are what I look at; the ones in between are
// not") Read from the replies of the session itself (not its subagents': those answer it, not you), in the ways a
// reply names a file - in `code`, a path in the running text, a line of a code block that is a path and nothing else -
// and web links. Which of the paths are real is the caller's to check (lib/files.js check, as the file cards do).
const EXT = /\.[A-Za-z0-9]{1,8}(:\d+(-\d+)?(:\d+)?)?$/;
const looksLikePath = (t) => !!t && t.length <= 400 && !/[\n<>|*?]/.test(t) && !/^(https?:|\/\/)/i.test(t) && (/^[A-Za-z]:[\\/]/.test(t) || /^~[\\/]/.test(t) || (EXT.test(t) && !/\s{2,}/.test(t) && !/^[-.]/.test(t)));
// A path in running text: C:\... - or, on macOS and Linux, /Users/x/report.pdf (review 2026-11-20: only Windows paths
// were known). That one needs two levels and a file's extension, and nothing of a word, a ':' or '/' just before it - so
// "and/or", "A/B" and the path of a web address are not taken for one.
const BARE = /[A-Za-z]:\\[^\s"'`<>|*?　-〿＀-￯]+|(?<![\w:/.~-])\/(?:[^\s"'`<>|*?/　-〿＀-￯]+\/)+[^\s"'`<>|*?/　-〿＀-￯]*\.[A-Za-z0-9]{1,8}(?![\w])/g;
const URL_RE = /https?:\/\/[^\s<>"'`)\]　-〿＀-￯]+/g;
function namedIn(text) {
  const paths = [], links = [];
  const fences = String(text).split(/^```[^\n]*$/m);
  fences.forEach((part, i) => {
    if (i % 2) { for (const l of part.split('\n')) { const t = l.trim(); if (/^([A-Za-z]:[\\/]|~[\\/]|\/[^\s/]+\/)/.test(t) && looksLikePath(t)) paths.push(t); } return; }
    for (const m of part.matchAll(/`([^`\n]+)`/g)) { const t = m[1].trim(); if (looksLikePath(t)) paths.push(t); }
    const plain = part.replace(/`[^`\n]+`/g, ' ');
    for (const m of plain.matchAll(BARE)) paths.push(m[0].replace(/[.,;:)\]]+$/, ''));
    for (const m of part.matchAll(URL_RE)) links.push(m[0].replace(/[.,;:]+$/, ''));
  });
  return { paths, links };
}
// Each with where it was last named: `id` is that reply as the conversation shows it (lib/history.js itemsOf: the
// entry's uuid and the block's place in it), so the page can take you there (asked 2026-11-20).
const namedCache = new Map();   // transcript -> {read, items: Map raw -> {at, id}, links: Map url -> {at, id}}
function named(file) {
  return new Promise((resolve) => {
    let c = namedCache.get(file); let size = 0; try { size = fs.statSync(file).size; } catch (e) { return resolve({ paths: [], links: [] }); }
    if (!c || size < c.read) { c = { read: 0, items: new Map(), links: new Map() }; namedCache.set(file, c); }
    const done = () => resolve({ paths: [...c.items.entries()].map(([raw, w]) => ({ raw, at: w.at, id: w.id })), links: [...c.links.entries()].map(([url, w]) => ({ url, at: w.at, id: w.id })) });
    if (size <= c.read) return done();
    let seen = c.read, pending = '';
    const stream = fs.createReadStream(file, { start: c.read, end: size - 1, highWaterMark: 1 << 20, encoding: 'utf8' });
    stream.on('data', (chunk) => {
      const lines = (pending + chunk).split('\n'); pending = lines.pop();
      for (const l of lines) {
        seen += Buffer.byteLength(l) + 1;
        if (!l.includes('"assistant"') || !l.includes('"text"')) continue;
        let e; try { e = JSON.parse(l); } catch (x) { continue; }
        if (!e || e.type !== 'assistant' || e.isSidechain || !e.message || !Array.isArray(e.message.content)) continue;
        const at = Date.parse(e.timestamp) || 0;
        e.message.content.forEach((b, i) => {
          if (!b || b.type !== 'text' || typeof b.text !== 'string') return;
          const n = namedIn(b.text), w = { at, id: (typeof e.uuid === 'string' ? e.uuid : '') + ':' + i };
          for (const p of n.paths) c.items.set(p, w);
          for (const u of n.links) c.links.set(u, w);
        });
      }
    });
    const end = () => { c.read = seen; done(); };
    stream.on('end', end); stream.on('error', end);
  });
}

// The changes of one file, oldest first (the newest ITEMS_PER_FILE). -> {path, items, skipped} or null
async function detail(file, filePath) {
  const f = (await gather(file)).get(keyOf(filePath));
  if (!f) return null;
  const items = f.changes.slice(-ITEMS_PER_FILE);
  return { path: f.path, items, skipped: f.changes.length - items.length };
}

// ── git: what is uncommitted in a folder ──
function git(cwd, args, run) {
  return new Promise((resolve) => {
    (run || execFile)('git', ['-c', 'core.quotepath=false', '-C', cwd].concat(args), { windowsHide: true, timeout: 20000, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || ''), err: String(stderr || (err && err.message) || '') }));
  });
}

const STATUS = { M: '修改', A: '新增', D: '刪除', R: '改名', C: '複製', U: '衝突', '?': '新檔（未加入 git）' };

// -> {repo: false} or {repo: true, root, branch, files: [{path, status, code, adds, dels, untracked}], adds, dels}
async function gitChanges(cwd, run) {
  const top = await git(cwd, ['rev-parse', '--show-toplevel'], run);
  if (!top.ok) return { repo: false, reason: /not a git repository/i.test(top.err) ? '這個資料夾不在 git 裡' : (/ENOENT|not recognized|找不到/i.test(top.err) ? '這台電腦找不到 git' : top.err.trim().slice(0, 200)) };
  const root = path.normalize(top.out.trim());
  const [st, num, br] = await Promise.all([git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], run), git(cwd, ['diff', '--numstat', '-z', 'HEAD'], run), git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'], run)]);
  const counts = new Map();
  // numstat -z: "adds\tdels\tpath\0", and for a rename "adds\tdels\t\0old\0new\0"
  { const parts = num.out.split('\0'); for (let i = 0; i < parts.length; i++) { const m = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(parts[i]); if (!m) continue; let p = m[3]; if (!p) { p = parts[i + 2] || ''; i += 2; } counts.set(p, { adds: m[1] === '-' ? 0 : Number(m[1]), dels: m[2] === '-' ? 0 : Number(m[2]), binary: m[1] === '-' }); } }
  const files = [];
  { const parts = st.out.split('\0'); for (let i = 0; i < parts.length; i++) { const e = parts[i]; if (e.length < 4) continue; const code = e.slice(0, 2), p = e.slice(3); if (code[0] === 'R' || code[0] === 'C') i++;   // the old name follows
      const letter = code === '??' ? '?' : (code[0] !== ' ' ? code[0] : code[1]);
      const c = counts.get(p) || { adds: 0, dels: 0 };
      files.push({ path: p, abs: path.join(root, p), status: STATUS[letter] || code.trim(), code, adds: c.adds, dels: c.dels, binary: !!c.binary, untracked: code === '??' }); } }
  return { repo: true, root, branch: br.ok ? br.out.trim() : '', files, adds: files.reduce((n, f) => n + f.adds, 0), dels: files.reduce((n, f) => n + f.dels, 0) };
}

// The uncommitted change of one file, as git prints it. The path must be one that gitChanges() listed: it is not
// taken on trust from the request.
async function gitFileDiff(cwd, rel, run) {
  const all = await gitChanges(cwd, run);
  if (!all.repo) return { ok: false, error: all.reason };
  const f = all.files.find((x) => x.path === rel);
  if (!f) return { ok: false, error: '這個檔案現在沒有未提交的變更' };
  if (f.untracked) return { ok: true, untracked: true, text: '', abs: f.abs };
  const d = await git(all.root, ['diff', 'HEAD', '--', rel], run);
  if (!d.ok) return { ok: false, error: d.err.trim().slice(0, 200) || 'git diff 沒有成功' };
  const cut = d.out.length > GIT_DIFF_MAX;
  return { ok: true, text: cut ? d.out.slice(0, GIT_DIFF_MAX) : d.out, cut, abs: f.abs, binary: f.binary };
}

module.exports = { changeOf, scanFrom, summary, detail, gitChanges, gitFileDiff, transcriptsOf, touched, touchedIn, startOf, named, namedIn, CONTENT_LINES, ITEMS_PER_FILE };
