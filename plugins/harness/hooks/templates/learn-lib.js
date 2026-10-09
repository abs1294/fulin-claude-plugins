// harness-kind: module（學習迴路共用模組，被 learn-*.js 與兩支規則引擎 require；不是 hook、不接線）
/**
 * 學習迴路共用：路徑、鎖、原子寫、ledger、usage、帳密／注入／外洩／破壞性樣式、transcript 抽取、
 * 待處理清單（pending.json）的核可／駁回／還原動作、淘汰候選計算。
 *
 * 【範本】由 /harness:init 複製到目標專案 `.claude/hooks/`，之後歸該專案自治（可自改；plugin 更新不會自動同步）。
 * 本檔不是 hook，不必接線；同目錄的 learn-*.js、guard-risky-command.js、guard-test-preconditions.js 會 require 它。
 *
 * 落點（專案根）＝本檔所在的 `.claude/hooks/` 往上兩層；學習資料放 `<根>/.claude/harness/learning/`。
 * memory 目錄不寫死：執行時由專案根推算（Claude Code 慣例 `~/.claude/projects/<根路徑非英數字元換成 ->/memory`），
 * 測試可用環境變數 HARNESS_MEMORY_DIR 覆寫——團隊模式 hook 進版控，寫死的是安裝者機器的路徑。
 *
 * 鎖：`learning/<檔名>.lock` 以 `wx` 建立；取不到每 25ms 重試、最多 LOCK_WAIT_MS；鎖檔超過 LOCK_STALE_MS 視為殘留並移除。
 * 取鎖失敗丟出 code='ELOCKED' 的例外：hook 端吞掉（本次不計，fail-open），CLI 端 exit 1 請重跑。
 * 寫入一律「同目錄暫存檔＋rename」；Windows 上 rename 遇到別的程序正開著目標檔（EPERM／EBUSY）會短暫重試。
 *
 * 自行決定的細節（設計稿沒寫到，選風險最小的做法）：
 * - 暫存檔名是 `.<檔名>.<pid>.<亂數>.tmp`（設計稿寫 `.<檔名>.<pid>.tmp`；多加亂數防同一程序連寫兩次撞名）。
 * - 「今天」可用 HARNESS_TODAY（YYYY-MM-DD）覆寫，同 health-check-reminder.js 的測試慣例；只影響日期字串，不影響時間戳。
 * - 帳密樣式的「值」至少 4 個字元才算（`token: x` 這類太短的不算值）；值是環境變數引用或 <…>／*** 佔位不算。
 * - 還原時 MEMORY.md 與知識筆記變更紀錄不整檔還原備份，而是只移除當次加上的那一行
 *   （整檔還原會連之後別次寫入的索引行一起刪掉）；主檔照設計稿以 afterHash 比對後還原備份。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// ── init 填空區 ──────────────────────────────────────────────────────────────
// 知識筆記路徑（相對於專案根）。詞彙表檔名依 init-answers.json 的 glossaryFile，沒有就依序找下列檔名。
const GLOSSARY_CANDIDATES = ['CONTEXT.md', 'GLOSSARY.md'];
const FLOWS_PATH = 'FLOWS.md';
const QA_KNOWLEDGE_PATH = 'tests/Project_Detail/PROJECT.md';
// MEMORY.md 字元數上限（05 §3 第 1 條）；超過、或超過 80% 時在 run 帳本 notes 記一句，開場回報帶出。
const MEMORY_INDEX_LIMIT = 20000;
// 鎖：最多等多久（毫秒）、鎖檔多舊算殘留（毫秒）。
const LOCK_WAIT_MS = 2000;
const LOCK_STALE_MS = 10000;
// learning/ 底下 runs、backups、session 檔的保留天數（開場回報 hook 清理）。
const RETENTION_DAYS = 90;
// ────────────────────────────────────────────────────────────────────────────

// ── 路徑 ──
function rootOf(hookDir) { return path.resolve(hookDir, '..', '..'); }
function memoryDir(root) {
  if (process.env.HARNESS_MEMORY_DIR) return path.resolve(process.env.HARNESS_MEMORY_DIR);
  const slug = path.resolve(root).replace(/[^A-Za-z0-9]/g, '-');
  return path.join(os.homedir(), '.claude', 'projects', slug, 'memory');
}
function paths(root) {
  const harness = path.join(root, '.claude', 'harness');
  const learn = path.join(harness, 'learning');
  return {
    root, harness, learn,
    hooks: path.join(root, '.claude', 'hooks'),
    memoryDir: memoryDir(root),
    ledger: path.join(learn, 'ledger.jsonl'),
    pending: path.join(learn, 'pending.json'),
    usage: path.join(learn, 'usage.json'),
    watermarks: path.join(learn, 'watermarks.json'),
    lastRun: path.join(learn, 'last-run.json'),
    pause: path.join(learn, 'pause.json'),
    daily: path.join(learn, 'daily.json'),
    candidates: path.join(learn, 'candidates.json'),
    runs: path.join(learn, 'runs'),
    backups: path.join(learn, 'backups'),
    answers: path.join(harness, 'init-answers.json'),
  };
}
const IS_WIN = process.platform === 'win32';
// 路徑比對用的正規形：正斜線、Windows 不分大小寫
function normPath(p) { const s = path.resolve(p).replace(/\\/g, '/'); return IS_WIN ? s.toLowerCase() : s; }
function isInside(child, parent) {
  const c = normPath(child), p = normPath(parent).replace(/\/+$/, '');
  return c === p || c.startsWith(p + '/');
}
// 解開 symlink／junction 後的實際路徑是否落在任一 root 底下（root 也取實際路徑）；檔案不存在時看它的上層目錄
function realPathOf(p) {
  try { return fs.realpathSync(p); } catch { try { return path.join(fs.realpathSync(path.dirname(p)), path.basename(p)); } catch { return null; } }
}
function realInside(p, roots) {
  const r = realPathOf(p);
  if (!r) return false;
  return roots.map(realPathOf).filter(Boolean).some((x) => isInside(r, x));
}
// 讀專案或 memory 目錄裡的檔；實際路徑跑到外面（被做成 symlink 指出去）就當不存在
function readTextInside(P, p) {
  return realInside(p, [P.root, P.memoryDir]) ? readText(p) : null;
}

// ── 時間 ──
function pad(n, w = 2) { return String(n).padStart(w, '0'); }
function localDate(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function today() {
  const o = process.env.HARNESS_TODAY;
  return o && /^\d{4}-\d{2}-\d{2}$/.test(o) ? o : localDate(new Date());
}
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00'); d.setDate(d.getDate() + n); return localDate(d);
}
function nowIso() { return new Date().toISOString(); }
function newRunId() {
  const d = new Date();
  return 'r-' + today().replace(/-/g, '') + '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds())
    + '-' + crypto.randomBytes(2).toString('hex');
}

// ── 檔案 ──
function sleepMs(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); }
function readText(p) { try { return fs.readFileSync(p, 'utf8'); } catch (e) { if (e && e.code === 'ENOENT') return null; throw e; } }
// 不存在回預設值（複本）；存在但壞掉照樣丟例外——壞檔不能被當成空檔覆寫掉
function readJson(p, dflt) {
  const t = readText(p);
  if (t === null) return dflt === undefined ? null : JSON.parse(JSON.stringify(dflt));
  return JSON.parse(t.replace(/^\uFEFF/, ''));
}
function writeAtomic(p, text) {
  ensureDir(path.dirname(p));
  const tmp = path.join(path.dirname(p), '.' + path.basename(p) + '.' + process.pid + '.' + crypto.randomBytes(3).toString('hex') + '.tmp');
  fs.writeFileSync(tmp, text, 'utf8');
  for (let i = 0; ; i++) {
    try { fs.renameSync(tmp, p); return; } catch (e) {
      if (i < 40 && e && (e.code === 'EPERM' || e.code === 'EBUSY' || e.code === 'EACCES')) { sleepMs(25); continue; }
      try { fs.unlinkSync(tmp); } catch {}
      throw e;
    }
  }
}
function writeJson(p, obj) { writeAtomic(p, JSON.stringify(obj, null, 2) + '\n'); }
function sha1(text) { return crypto.createHash('sha1').update(text === null ? '' : text, 'utf8').digest('hex'); }
function fileHash(p) { const t = readText(p); return t === null ? null : sha1(t); }

// ── 鎖 ──
function acquire(lockPath, waitMs, staleMs) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      try { fs.writeSync(fd, String(process.pid)); } finally { fs.closeSync(fd); }
      return true;
    } catch (e) {
      if (!e || (e.code !== 'EEXIST' && e.code !== 'EPERM' && e.code !== 'EBUSY' && e.code !== 'EACCES')) throw e;
      try {
        const st = fs.statSync(lockPath);
        if (Date.now() - st.mtimeMs > staleMs) { try { fs.unlinkSync(lockPath); } catch {} continue; }
      } catch (e2) { if (e2 && e2.code === 'ENOENT') continue; }
      if (Date.now() >= deadline) return false;
      sleepMs(25);
    }
  }
}
function release(lockPath) { try { fs.unlinkSync(lockPath); } catch {} }
// fn 在持有 learning/<name>.lock 時執行；取不到鎖丟 code='ELOCKED'
function withLock(learnDir, name, fn, opts) {
  ensureDir(learnDir);
  const o = opts || {};
  const lockPath = path.join(learnDir, name + '.lock');
  if (!acquire(lockPath, o.waitMs === undefined ? LOCK_WAIT_MS : o.waitMs, o.staleMs === undefined ? LOCK_STALE_MS : o.staleMs)) {
    const e = new Error('取不到鎖 ' + name + '.lock（另一個程序正在改 ' + name + '）'); e.code = 'ELOCKED'; throw e;
  }
  try { return fn(); } finally { release(lockPath); }
}
// 讀改寫一份 learning/ 底下的 JSON：mut(obj) 直接改 obj，回傳值原樣傳回
function updateJson(learnDir, file, dflt, mut) {
  return withLock(learnDir, file, () => {
    const p = path.join(learnDir, file);
    const obj = readJson(p, dflt);
    const ret = mut(obj);
    writeJson(p, obj);
    return ret;
  });
}

// ── ledger ──
function appendLedger(P, rec) {
  const line = JSON.stringify(Object.assign({ ts: nowIso() }, rec)) + '\n';
  withLock(P.learn, 'ledger.jsonl', () => fs.appendFileSync(P.ledger, line, 'utf8'));
}
function readLedger(P) {
  const t = readText(P.ledger);
  if (!t) return [];
  const out = [];
  for (const l of t.split('\n')) { if (!l.trim()) continue; try { out.push(JSON.parse(l)); } catch {} }
  return out;
}

// ── usage ──
function emptyUsage() { return { version: 1, since: today(), requests: 0, items: {}, rules: {} }; }
function bumpUsage(root, mut) {
  const P = paths(root);
  return updateJson(P.learn, 'usage.json', emptyUsage(), (u) => {
    u.items = u.items || {}; u.rules = u.rules || {}; u.requests = u.requests || 0;
    return mut(u);
  });
}
function touchItem(u, key, kind, field) {
  let it = u.items[key];
  if (!it) it = u.items[key] = { kind, view: 0, use: 0, registeredAt: today(), registeredAtRequest: u.requests || 0, lastAt: null };
  if (field) { it[field] = (it[field] || 0) + 1; it.lastAt = nowIso(); }
  return it;
}
// 兩支規則引擎擋下時呼叫：每個規則 id 的 hits +1。只記數，不輸出任何東西；呼叫端包在 try/catch 裡。
function recordRuleHits(hook, ids, root) {
  const r = root || rootOf(__dirname);
  const list = (Array.isArray(ids) ? ids : [ids]).map((x) => String(x || '未命名'));
  if (!list.length) return;
  bumpUsage(r, (u) => {
    for (const id of list) {
      const key = hook + ':' + id;
      const it = u.rules[key] || (u.rules[key] = { hits: 0, registeredAtRequest: u.requests || 0, lastAt: null });
      it.hits = (it.hits || 0) + 1; it.lastAt = nowIso();
    }
  });
}

// ── 知識筆記與團隊模式 ──
function readAnswers(P) { try { return readJson(P.answers, null); } catch { return null; } }
function glossaryRel(P) {
  const a = readAnswers(P);
  if (a && typeof a.glossaryFile === 'string' && /^[\w.-]+\.md$/.test(a.glossaryFile)) return a.glossaryFile;
  for (const n of GLOSSARY_CANDIDATES) if (fs.existsSync(path.join(P.root, n))) return n;
  return 'GLOSSARY.md';
}
function knowledgeRel(P, kind) {
  if (kind === 'glossary') return glossaryRel(P);
  if (kind === 'flows') return FLOWS_PATH;
  if (kind === 'qa-knowledge') return QA_KNOWLEDGE_PATH;
  return null;
}
// 知識筆記的變更紀錄檔與節（qa-knowledge 的變更紀錄是同目錄 CHANGELOG.md 的 `## <檔名>` 節）
function changelogOf(P, kind) {
  const rel = knowledgeRel(P, kind);
  if (!rel) return null;
  if (kind === 'qa-knowledge') return { rel: path.posix.join(path.posix.dirname(rel), 'CHANGELOG.md'), section: path.posix.basename(rel) };
  return { rel: rel.replace(/\.md$/i, '') + '.changelog.md', section: null };
}
// 讀不到 init-answers.json 或沒寫 Q4.data.team 當團隊（保守方向：多一層「待你看」）
function isTeam(P) {
  const a = readAnswers(P);
  try { return a.answers.Q4.data.team !== false; } catch { return true; }
}

// ── 樣式掃描 ──
const VALUE_IS_PLACEHOLDER = /^(?:\$\{?[A-Za-z_][\w]*\}?|%[A-Za-z_]\w*%|\$env:[A-Za-z_]\w*|<[^>]*>|\*{3,}|x{3,}|\.{3,}|…+)$/i;
function realValue(v) {
  const s = String(v || '').replace(/^["'`]+|["'`,;。，；]+$/g, '');
  return s.length >= 4 && !VALUE_IS_PLACEHOLDER.test(s);
}
const SECRET_FIXED = [
  /AKIA[0-9A-Z]{16}/i, /(?<![A-Za-z0-9])sk-[A-Za-z0-9]{20,}/i, /(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{20,}/i, /(?<![A-Za-z0-9])xox[abpr]-/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY/i, /Bearer\s+[A-Za-z0-9._-]{20,}/i,
];
// 回傳命中的樣式說明陣列（不回傳值本身——不輸出原文）
function scanSecrets(text) {
  const s = String(text || '');
  const hits = [];
  for (const re of SECRET_FIXED) if (re.test(s)) hits.push(re.source.slice(0, 24));
  // 值到空白或中文標點為止（「password = $DB_PASSWORD，值取自環境變數」的值是 $DB_PASSWORD）
  const kv = /(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key)[A-Za-z_]*\s*[=:]\s*([^\s，。；、！？（）「」『』]+)/gi;
  for (const m of s.matchAll(kv)) if (realValue(m[2])) { hits.push('key=value'); break; }
  const zh = /(密碼|口令|金鑰|權杖)\s*(?:是|為|=|:|：)\s*([^\s，。；、！？（）「」『』]+)/g;
  for (const m of s.matchAll(zh)) if (realValue(m[2])) { hits.push('中文帳密'); break; }
  const url = /:\/\/([^/\s:@]+):([^/\s@]+)@/g;
  for (const m of s.matchAll(url)) if (realValue(m[2])) { hits.push('://帳號:密碼@'); break; }
  return hits;
}
const INJECTION = [/忽略(?:之前|以上|先前)的?(?:指示|規則)/, /ignore\s+(?:all\s+)?(?:previous|prior)\s+instructions/i, /你現在是/, /system\s+prompt/i];
const EXFIL = [
  /\b(?:curl|wget|Invoke-WebRequest|iwr|Invoke-RestMethod)\b[^\n]*\s(?:-d|--data[\w-]*|-Body|-T|--upload-file|-F)(?=[\s=]|$)/i,
  /\|\s*(?:nc|ncat)\b/i,
  /\bbase64\b[^\n]*\|\s*(?:curl|wget|nc|ncat|Invoke-WebRequest|iwr|Invoke-RestMethod)\b/i,
];
const DESTRUCTIVE = [
  /\brm\s+-(?:[a-z]*r[a-z]*f|[a-z]*f[a-z]*r)[a-z]*\b/i, /\bRemove-Item\b[^\n]*-Recurse/i,
  /\bgit\s+push\b[^\n]*\s(?:-f|--force)\b/i, /\bgit\s+reset\s+--hard\b/i, /\bgit\s+clean\s+-[a-z]*f/i,
  /\bDROP\s+(?:TABLE|DATABASE)\b/i, /\bTRUNCATE\b/i, /\bmkfs\b/i, /\bformat\s+[a-z]:/i, /\bdel\s+\/s\b/i,
  /\bcurl\b[^\n|]*\|\s*(?:ba)?sh\b/i,
];
const anyHit = (list, text) => list.some((re) => re.test(String(text || '')));
function scanInjection(t) { return anyHit(INJECTION, t); }
function scanExfil(t) { return anyHit(EXFIL, t); }
function scanDestructive(t) { return anyHit(DESTRUCTIVE, t); }

// ── transcript 抽取 ──
function blockText(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('\n');
  return '';
}
function summarizeInput(inp) {
  if (!inp || typeof inp !== 'object') return '';
  const s = JSON.stringify(inp);
  return s.length > 300 ? s.slice(0, 300) + '…' : s;
}
// lines：一行一筆 JSONL 原文；firstLine：第一行的行號（1 起算）。
// 回傳 [{ line, kind: 'user'|'asst'|'tool'|'error', text }]：只取使用者文字、助理文字、工具呼叫名稱與參數摘要、工具錯誤結果
function extractEntries(lines, firstLine) {
  const out = [];
  lines.forEach((l, i) => {
    const ln = firstLine + i;
    let e;
    try { e = JSON.parse(l); } catch { return; }
    if (!e || typeof e !== 'object' || e.isMeta) return;
    const c = e.message && e.message.content;
    if (e.type === 'user') {
      if (typeof c === 'string') { if (c.trim()) out.push({ line: ln, kind: 'user', text: c }); return; }
      if (!Array.isArray(c)) return;
      for (const b of c) {
        if (!b) continue;
        if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) out.push({ line: ln, kind: 'user', text: b.text });
        else if (b.type === 'tool_result' && b.is_error) out.push({ line: ln, kind: 'error', text: blockText(b.content) || '(空的錯誤結果)' });
      }
    } else if (e.type === 'assistant' && Array.isArray(c)) {
      for (const b of c) {
        if (!b) continue;
        if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) out.push({ line: ln, kind: 'asst', text: b.text });
        else if (b.type === 'tool_use') out.push({ line: ln, kind: 'tool', text: String(b.name || '?') + ' ' + summarizeInput(b.input) });
      }
    }
  });
  return out;
}
const KIND_LABEL = { user: '使用者', asst: '助理', tool: '工具呼叫', error: '工具錯誤' };
// 合併空白；比對「不抄原文」用
function normalizeText(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
// 把 transcript 片段做成可快速查「連續 n 字相同」的集合
function shingles(text, n) {
  const chars = [...normalizeText(text)];
  const set = new Set();
  for (let i = 0; i + n <= chars.length; i++) set.add(chars.slice(i, i + n).join(''));
  return set;
}
// 候選文字去掉反引號包住的識別字與路徑後，有沒有連續 n 字出現在片段裡
function hasVerbatim(candidate, set, n) {
  const chars = [...normalizeText(String(candidate || '').replace(/`[^`\n]*`/g, ' '))];
  for (let i = 0; i + n <= chars.length; i++) if (set.has(chars.slice(i, i + n).join(''))) return true;
  return false;
}

// ── 待處理清單 ──
function emptyPending() { return { version: 1, items: [] }; }
function nextPendingId(items) {
  const pre = 'p-' + today().replace(/-/g, '') + '-';
  let max = 0;
  for (const it of items) if (it.id && it.id.startsWith(pre)) { const n = parseInt(it.id.slice(pre.length), 10); if (n > max) max = n; }
  return pre + pad(max + 1);
}
// 移除檔案裡第一個與 line 完全相同的行；回傳有沒有移除
function removeLine(p, line) {
  const t = readText(p);
  if (t === null) return false;
  const arr = t.split('\n');
  const i = arr.indexOf(line);
  if (i < 0) return false;
  arr.splice(i, 1);
  writeAtomic(p, arr.join('\n'));
  return true;
}
// 還原一筆已寫入的項目（黃區或綠區）；回傳 { ok, text }
function revertItem(P, it) {
  // targetPath 正常是絕對路徑；相對路徑以專案根解析（cases 造狀態時用）
  if (!it.targetPath) return { ok: false, text: '這一筆沒有記錄寫入的檔案路徑，無法還原。' };
  const target = path.resolve(P.root, it.targetPath);
  // pending.json 是一般檔、可能被手改：還原只動學習迴路本來會寫的地方（專案內、memory 目錄），備份只從 learning/backups 取
  // 比對用實際路徑：專案內的 symlink／junction 指到外面時，字串比對會被騙過
  const real = (p) => { try { return fs.realpathSync(p); } catch { try { return path.join(fs.realpathSync(path.dirname(p)), path.basename(p)); } catch { return null; } } };
  const roots = [P.root, P.memoryDir].map(real).filter(Boolean);
  const writable = (p) => { const r = real(p); return !!r && roots.some((x) => isInside(r, x)); };
  const backupAbs = it.backup ? path.resolve(P.learn, it.backup) : null;
  const backupsReal = real(P.backups);
  const badLine = (it.addedLines || []).find((x) => !x || !x.path || !writable(path.resolve(P.root, x.path)));
  if (!writable(target) || (backupAbs && !(backupsReal && real(backupAbs) && isInside(real(backupAbs), backupsReal))) || badLine) {
    return { ok: false, text: '這一筆記錄的路徑不在專案或 memory 目錄內（或備份不在 learning/backups 內），不動檔；請人工檢查 learning/pending.json。' };
  }
  const cur = fileHash(target);
  if (cur !== it.afterHash) {
    return { ok: false, text: '目標檔 ' + it.target + ' 在寫入之後又被改過（hash 不符），不動檔；請人工比對備份 learning/' + (it.backup || '(新建，無備份)') + ' 後處理。' };
  }
  if (backupAbs) fs.copyFileSync(backupAbs, target);
  else fs.unlinkSync(target);
  const extra = [];
  for (const x of it.addedLines || []) {
    if (removeLine(path.resolve(P.root, x.path), x.line)) extra.push(path.basename(x.path));
  }
  return { ok: true, text: (it.backup ? '已還原 ' + it.target + '（備份 learning/' + it.backup + '）' : '已刪除新建的 ' + it.target)
    + (extra.length ? '，並移除 ' + extra.join('、') + ' 裡當次加上的那一行' : '') + '。' };
}
const LEVEL_TEXT = { green: '綠區', yellow: '黃區', red: '紅區' };
// action: approve | reject | revert；回傳 { code, text, item }。code 0 成功、1 找不到／狀態不允許／hash 不符
function pendingAction(root, action, id, by) {
  const P = paths(root);
  const res = updateJson(P.learn, 'pending.json', emptyPending(), (pd) => {
    const it = (pd.items || []).find((x) => x.id === id);
    if (!it) return { code: 1, text: '找不到待處理項目 ' + id + '（用 node .claude/hooks/learn-pending.js list --all 看全部）。' };
    const isWrite = it.type === 'write' || it.type === 'write-review';
    const isRed = it.type === 'proposal' || it.type === 'promotion';
    let out;
    if (action === 'approve') {
      if (it.type === 'write-review' && it.status === 'pending') {
        it.status = 'accepted'; out = { code: 0, text: id + ' 已核可：保留寫入（' + it.target + '）。' };
      } else if (isRed && it.status === 'pending') {
        it.status = 'approved';
        out = { code: 0, text: '使用者已核可 ' + id + '：請 Claude 依 05 §1 執行：' + it.summary + '（建議內容見 .claude/harness/learning/pending.json 的 ' + id + '）'
          + (it.content ? '\n建議內容：\n' + it.content : '') };
      } else out = { code: 1, text: id + ' 目前狀態是 ' + it.status + '（' + (LEVEL_TEXT[it.level] || it.level) + '），不能核可。' };
    } else if (action === 'reject' || action === 'revert') {
      if (isWrite && (it.status === 'pending' || it.status === 'accepted')) {
        const r = revertItem(P, it);
        if (!r.ok) out = { code: 1, text: r.text };
        else { it.status = 'reverted'; out = { code: 0, text: id + ' 已' + (action === 'reject' ? '駁回並還原' : '還原') + '：' + r.text }; }
      } else if (action === 'reject' && isRed && it.status === 'pending') {
        it.status = 'rejected'; out = { code: 0, text: id + ' 已駁回（紅區提案，沒有改任何檔）。' };
      } else out = { code: 1, text: id + ' 目前狀態是 ' + it.status + '（' + (it.type) + '），不能' + (action === 'revert' ? '還原' : '駁回') + '。' };
    } else out = { code: 2, text: '不認得的動作：' + action };
    if (out.code === 0) { it.decidedAt = nowIso(); it.decisionNote = (by || 'cli') + ':' + action; }
    out.item = it;
    return out;
  });
  if (res.code === 0) {
    const it = res.item;
    appendLedger(P, { run: it.run, action: action === 'approve' ? 'approve' : (action === 'reject' && (it.type === 'proposal' || it.type === 'promotion') ? 'user-reject' : 'revert'),
      target: it.target, level: it.level, result: 'ok', reason: 'by ' + (by || 'cli'), reasonClass: '-', evidence: it.evidence || [], topic: it.topic, item: it.id });
  }
  return res;
}

// ── 規則 id、淘汰候選、清理 ──
// 只從 `const RULES = [`／`const CHECKS = [` 到對應 `];` 之間、非註解行的 `id:` 撈（檔頭註解的示範規則不算）
function ruleIdsOf(file, arrayName) {
  const t = readText(file);
  if (!t) return [];
  const lines = t.split('\n');
  const marker = 'const ' + arrayName + ' = [';
  const start = lines.findIndex((l) => l.includes(marker) && !l.trim().startsWith('//'));
  if (start < 0) return [];
  const first = lines[start].slice(lines[start].indexOf(marker) + marker.length);
  if (/^\s*\]/.test(first)) return []; // `const RULES = [];`
  const ids = [];
  for (const l of [first].concat(lines.slice(start + 1))) {
    if (/^\s*\];/.test(l)) break;
    const code = l.trim();
    if (code.startsWith('//') || code.startsWith('*')) continue;
    for (const m of l.matchAll(/\bid:\s*['"]([^'"]+)['"]/g)) ids.push(m[1]);
  }
  return ids;
}
const RULE_ENGINES = [['guard-risky-command', 'RULES'], ['guard-test-preconditions', 'CHECKS']];
function memoryStars(memDir, file) {
  const t = readText(path.join(memDir, 'MEMORY.md'));
  if (!t) return 0;
  for (const l of t.split('\n')) if (l.includes('](' + file + ')')) return (l.match(/⭐/g) || []).length;
  return 0;
}
// 登記沒登記過的 memory、專案 skill、規則 id（registeredAtRequest＝當下 request 數），回傳更新後的 usage
function registerAll(root) {
  const P = paths(root);
  let mem = [];
  try { mem = fs.readdirSync(P.memoryDir).filter((f) => /\.md$/i.test(f) && f.toLowerCase() !== 'memory.md'); } catch {}
  let skills = [];
  try { skills = fs.readdirSync(path.join(root, '.claude', 'skills'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch {}
  const rules = [];
  for (const [hook, arr] of RULE_ENGINES) for (const id of ruleIdsOf(path.join(P.hooks, hook + '.js'), arr)) rules.push(hook + ':' + id);
  return bumpUsage(root, (u) => {
    for (const f of mem) touchItem(u, 'memory:' + f, 'memory', null);
    for (const s of skills) touchItem(u, 'skill:' + s, 'skill', null);
    for (const k of rules) if (!u.rules[k]) u.rules[k] = { hits: 0, registeredAtRequest: u.requests || 0, lastAt: null };
    return JSON.parse(JSON.stringify(u));
  });
}
// 試用期過了且 view+use=0 的 memory／專案 skill（⭐⭐ 以上的 memory 排除）、hits=0 的規則（候選降級）
function computeCandidates(root, usage, trial) {
  const P = paths(root);
  const req = usage.requests || 0;
  const items = [], rules = [];
  for (const [key, it] of Object.entries(usage.items || {})) {
    if (it.kind !== 'memory' && it.kind !== 'skill') continue;
    if (req - (it.registeredAtRequest || 0) < trial) continue;
    if ((it.view || 0) + (it.use || 0) > 0) continue;
    if (it.kind === 'memory') {
      const f = key.slice('memory:'.length);
      if (!fs.existsSync(path.join(P.memoryDir, f))) continue;
      if (memoryStars(P.memoryDir, f) >= 2) continue;
    } else if (!fs.existsSync(path.join(root, '.claude', 'skills', key.slice('skill:'.length)))) continue;
    items.push(key);
  }
  for (const [key, r] of Object.entries(usage.rules || {})) {
    if (req - (r.registeredAtRequest || 0) >= trial && !(r.hits > 0)) rules.push(key);
  }
  return { items, rules };
}
// 清理 RETENTION_DAYS 天前的 runs、backups、session 檔；pending 引用中（pending／accepted）的備份不刪
function cleanup(root) {
  const P = paths(root);
  const cutoff = Date.now() - RETENTION_DAYS * 86400000;
  let keep = new Set();
  try {
    const pd = readJson(P.pending, emptyPending());
    for (const it of pd.items || []) if (it.backup && (it.status === 'pending' || it.status === 'accepted')) keep.add(it.backup.split('/')[1]);
  } catch { return; } // pending.json 壞了就不清 backups，免得刪到還要用的備份
  const old = (p) => { try { return fs.statSync(p).mtimeMs < cutoff; } catch { return false; } };
  const ls = (d) => { try { return fs.readdirSync(d); } catch { return []; } };
  for (const f of ls(P.runs)) if (old(path.join(P.runs, f))) try { fs.rmSync(path.join(P.runs, f), { force: true }); } catch {}
  for (const d of ls(P.backups)) if (!keep.has(d) && old(path.join(P.backups, d))) try { fs.rmSync(path.join(P.backups, d), { recursive: true, force: true }); } catch {}
  for (const f of ls(P.learn)) if (/^session-.*\.json$/.test(f) && old(path.join(P.learn, f))) try { fs.rmSync(path.join(P.learn, f), { force: true }); } catch {}
}

function isChildEnv() { return !!(process.env.HARNESS_LEARN_CHILD || process.env.COMPACT_HANDOFF_CHILD); }

module.exports = {
  GLOSSARY_CANDIDATES, FLOWS_PATH, QA_KNOWLEDGE_PATH, MEMORY_INDEX_LIMIT,
  rootOf, memoryDir, paths, normPath, isInside, realPathOf, realInside, readTextInside, IS_WIN,
  today, addDays, nowIso, newRunId, localDate, pad,
  sleepMs, ensureDir, readText, readJson, writeAtomic, writeJson, sha1, fileHash,
  withLock, updateJson, acquire, release,
  appendLedger, readLedger,
  emptyUsage, bumpUsage, touchItem, recordRuleHits,
  readAnswers, knowledgeRel, changelogOf, isTeam,
  scanSecrets, scanInjection, scanExfil, scanDestructive,
  extractEntries, KIND_LABEL, normalizeText, shingles, hasVerbatim,
  emptyPending, nextPendingId, removeLine, revertItem, pendingAction, LEVEL_TEXT,
  ruleIdsOf, registerAll, computeCandidates, memoryStars, cleanup, isChildEnv,
};
