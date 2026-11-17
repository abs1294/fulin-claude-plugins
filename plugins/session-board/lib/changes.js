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

module.exports = { changeOf, scanFrom, summary, detail, gitChanges, gitFileDiff, transcriptsOf, CONTENT_LINES, ITEMS_PER_FILE };
