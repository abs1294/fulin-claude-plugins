'use strict';
// Files mentioned in a conversation: which of them exist, what kind they are,
// and how to show them in the page.
//
// Kinds:
//   image, pdf, text  - the browser shows these itself
//   office            - converted to PDF by the installed Office, then shown
//   other             - cannot be previewed; can still be revealed in Explorer
//   dir               - a folder; can be opened in Explorer
//
// Nothing here writes to the files themselves. Converted PDFs go to a cache
// under ~/.claude/session-board/preview-cache, named after the source path,
// size and modification time, so an edited file is converted again.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const CACHE_DIR = path.join(os.homedir(), '.claude', 'session-board', 'preview-cache');
const CACHE_MAX_AGE_MS = 7 * 86400000;
const TEXT_LIMIT = 2 * 1024 * 1024;   // a text preview shows at most this many bytes

const IMAGE = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const OFFICE = new Set(['.doc', '.docx', '.docm', '.rtf', '.xls', '.xlsx', '.xlsm', '.ppt', '.pptx', '.pptm']);
const TEXT = new Set(['.txt', '.md', '.markdown', '.log', '.json', '.jsonl', '.csv', '.tsv', '.xml', '.yml', '.yaml', '.toml', '.ini', '.conf', '.env',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.vue', '.css', '.scss', '.less', '.html', '.htm', '.py', '.cs', '.csproj', '.sln', '.java', '.go', '.rs',
  '.php', '.rb', '.sh', '.ps1', '.psm1', '.bat', '.cmd', '.sql', '.c', '.h', '.cpp', '.hpp', '.kt', '.swift', '.gitignore', '.editorconfig', '.razor', '.cshtml', '.props', '.targets', '.config', '.http', '.diff', '.patch']);
// What "open with the default program" is allowed for. Scripts and programs are
// left out on purpose: a path in a conversation is text an AI wrote, and one
// click should never be enough to run it.
// Also left out: what runs something when opened - a page (.html, .svg: scripts, in the browser) and Office files that carry macros.
const RUNS = new Set(['.svg', '.html', '.htm', '.docm', '.xlsm', '.pptm']);
const OPENABLE = new Set([...Object.keys(IMAGE), ...OFFICE, '.pdf', '.txt', '.md', '.markdown', '.log', '.json', '.csv', '.tsv', '.xml', '.yml', '.yaml'].filter((x) => !RUNS.has(x)));

function kindOf(file) {
  const ext = path.extname(file).toLowerCase();
  if (IMAGE[ext]) return 'image';
  if (ext === '.pdf') return 'pdf';
  if (OFFICE.has(ext)) return 'office';
  if (TEXT.has(ext) || (!ext && /^(readme|license|dockerfile|makefile|changelog)$/i.test(path.basename(file)))) return 'text';
  return 'other';
}

const canOpen = (file) => OPENABLE.has(path.extname(file).toLowerCase());
const mimeOf = (file) => IMAGE[path.extname(file).toLowerCase()] || (kindOf(file) === 'pdf' ? 'application/pdf' : 'text/plain; charset=utf-8');

// A path as written in a message -> absolute path. Drops a trailing :line or
// :line-line (file.js:12), and resolves a relative path against the session's folder.
// A network path: it begins with two separators, each a backslash (character 92) or a slash (47) - \\host\share,
// //host/share, or a mix. Never touched: merely asking whether such a file exists makes Windows sign in to
// that host, and the path is text an AI wrote. Written with character codes so that it reads the same everywhere.
// The one place this is decided; resolve(), realFile() and the server's "show in Explorer" all ask here.
const SEP = (code) => code === 92 || code === 47;
function isNetworkPath(p) {
  const s = String(p == null ? '' : p).trim();
  return s.length >= 2 && SEP(s.charCodeAt(0)) && SEP(s.charCodeAt(1));
}

function resolve(raw, cwd) {
  let p = String(raw || '').trim().replace(/^["'`]+|["'`]+$/g, '');
  if (!p || p.length > 400 || /[\0<>|?*\n\r]/.test(p)) return null;
  // Not a network path: merely looking at \\host\share\file makes Windows sign in to that host, and the path is text an AI wrote.
  if (isNetworkPath(p)) return null;
  p = p.replace(/:(\d+)(-\d+)?(:\d+)?$/, '');
  p = p.replace(/^~(?=[\\/])/, os.homedir());
  if (!path.isAbsolute(p)) {
    if (!cwd || !path.isAbsolute(cwd)) return null;
    p = path.join(cwd, p);
  }
  return path.normalize(p);
}

// ── Finding a file that was mentioned by name only ──
// Replies often give just a file name ("report.pptx") for something that sits a
// few folders below the session's folder (hit 2026-11-12: the session ran in
// ...\ppt, the file was in ...\ppt\claire\<client>\). So when the path as
// written does not exist, the session's folder is searched for that name.
//
// The search never leaves the session's folder and is bounded on every axis:
// depth, entry count and time. It refuses a drive root or the home folder
// outright, because a walk from there is the runaway full-disk scan this
// machine has been burned by. Build-output and dependency folders are skipped.
const SKIP_DIRS = new Set(['node_modules', '.git', 'bin', 'obj', 'dist', 'build', 'target', '.venv', 'venv', '__pycache__', '.next', '.cache', '.gradle', '.idea', '.vs']);
const INDEX_TTL_MS = 60000;
const INDEX_MAX_ENTRIES = 40000;
const INDEX_MAX_DEPTH = 7;
const INDEX_BUDGET_MS = 1500;
const indexes = new Map();

function searchableRoot(cwd) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return null;
  const root = path.normalize(cwd).replace(/[\\/]+$/, '');
  const parts = root.split(/[\\/]/).filter(Boolean);
  if (parts.length < 3) return null;                                   // C:\ or C:\Users
  if (root.toLowerCase() === os.homedir().toLowerCase()) return null;  // the home folder itself
  return root;
}

function nameIndex(cwd, now = Date.now()) {
  const root = searchableRoot(cwd);
  if (!root) return null;
  const hit = indexes.get(root);
  if (hit && now - hit.at < INDEX_TTL_MS) return hit.byName;
  const byName = new Map();
  const started = Date.now();
  let count = 0;
  let queue = [[root, 0]];
  while (queue.length && count < INDEX_MAX_ENTRIES && Date.now() - started < INDEX_BUDGET_MS) {
    const next = [];
    for (const [dir, depth] of queue) {
      let ents = [];
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { continue; }
      for (const e of ents) {
        if (++count > INDEX_MAX_ENTRIES) break;
        if (e.isDirectory()) {
          if (depth + 1 <= INDEX_MAX_DEPTH && !SKIP_DIRS.has(e.name.toLowerCase())) next.push([path.join(dir, e.name), depth + 1]);
        } else if (e.isFile()) {
          const k = e.name.toLowerCase();
          if (!byName.has(k)) byName.set(k, []);
          byName.get(k).push(path.join(dir, e.name));
        }
      }
      if (count > INDEX_MAX_ENTRIES || Date.now() - started >= INDEX_BUDGET_MS) break;
    }
    queue = next;   // breadth-first: if the budget runs out, the shallow files are the ones indexed
  }
  indexes.set(root, { at: now, byName });
  if (indexes.size > 12) indexes.delete(indexes.keys().next().value);
  return byName;
}

// A relative path as written -> the file under cwd whose path ends with it.
// Several matches: the most recently modified one, since a reply talks about what was just produced.
function findByName(raw, cwd) {
  let rel = String(raw || '').trim().replace(/^["'`]+|["'`]+$/g, '').replace(/:(\d+)(-\d+)?(:\d+)?$/, '');
  if (!rel || rel.length > 300 || path.isAbsolute(rel) || /[\0<>|?*\n\r]/.test(rel) || /(^|[\\/])\.\.([\\/]|$)/.test(rel)) return null;
  rel = rel.replace(/^\.[\\/]/, '').split(/[\\/]+/).filter(Boolean).join(path.sep).toLowerCase();
  if (!rel) return null;
  const byName = nameIndex(cwd);
  if (!byName) return null;
  const tail = path.sep + rel;
  const matches = (byName.get(path.basename(rel)) || []).filter((abs) => abs.toLowerCase().endsWith(tail));
  if (!matches.length) return null;
  let best = null, bestTime = -1;
  for (const abs of matches) {
    try { const t = fs.statSync(abs).mtimeMs; if (t > bestTime) { best = abs; bestTime = t; } } catch (e) {}
  }
  return best ? { abs: best, others: matches.length - 1 } : null;
}

// Which of these written paths are real. Returns one entry per input, null for those that are not.
function check(paths, cwd) {
  const out = [];
  for (const raw of (Array.isArray(paths) ? paths : []).slice(0, 80)) {
    let hit = null;
    const describe = (abs, extra) => {
      try {
        const st = fs.statSync(abs);
        return st.isDirectory() ? { abs, kind: 'dir', name: path.basename(abs) || abs }
          : st.isFile() ? Object.assign({ abs, kind: kindOf(abs), name: path.basename(abs), size: st.size, canOpen: canOpen(abs) }, extra) : null;
      } catch (e) { return null; }
    };
    const abs = resolve(raw, cwd);
    if (abs) hit = describe(abs);
    if (!hit) {
      // Not where it was written: look for it by name inside the session's folder.
      const found = findByName(raw, cwd);
      if (found) hit = describe(found.abs, { searched: true, others: found.others });
    }
    out.push(hit);
  }
  return out;
}

// An absolute path to an existing regular file, or null.
function realFile(p) {
  try {
    if (typeof p !== 'string' || isNetworkPath(p) || !path.isAbsolute(p)) return null;
    const abs = path.normalize(p);
    if (isNetworkPath(abs)) return null;   // and not one after normalizing either
    return fs.statSync(abs).isFile() ? abs : null;
  } catch (e) { return null; }
}

function cachePathFor(abs) {
  const st = fs.statSync(abs);
  const key = crypto.createHash('sha1').update(abs.toLowerCase() + '|' + st.size + '|' + st.mtimeMs).digest('hex');
  return path.join(CACHE_DIR, key + '.pdf');
}

function pruneCache(now = Date.now()) {
  try {
    for (const f of fs.readdirSync(CACHE_DIR)) {
      const p = path.join(CACHE_DIR, f);
      try { if (now - fs.statSync(p).mtimeMs > CACHE_MAX_AGE_MS) fs.unlinkSync(p); } catch (e) {}
    }
  } catch (e) {}
}

// PDF of an Office file: from the cache, or converted now. convert(src, dst)
// is supplied by the server (it runs the PowerShell script) and resolves to
// {ok, error}. Two requests for the same file share one conversion.
const converting = new Map();
async function officePdf(abs, convert) {
  const out = cachePathFor(abs);
  if (fs.existsSync(out)) return { ok: true, file: out, cached: true };
  if (converting.has(out)) return converting.get(out);
  const job = (async () => {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    pruneCache();
    const tmp = out + '.' + process.pid + '.tmp.pdf';
    const r = await convert(abs, tmp);
    if (!r || !r.ok || !fs.existsSync(tmp)) { try { fs.unlinkSync(tmp); } catch (e) {} return { ok: false, error: (r && r.error) || 'conversion failed' }; }
    fs.renameSync(tmp, out);
    return { ok: true, file: out, cached: false };
  })().finally(() => converting.delete(out));
  converting.set(out, job);
  return job;
}

module.exports = { isNetworkPath, kindOf, canOpen, mimeOf, resolve, check, realFile, findByName, searchableRoot, cachePathFor, officePdf, pruneCache, CACHE_DIR, TEXT_LIMIT };
