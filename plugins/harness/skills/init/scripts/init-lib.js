'use strict';
// init-flow.js、init-verify.js、check-flow-diagram.js 共用：狀態檔／答案檔路徑、答案檔的 schema 驗證（零相依的小驗證器）、
// 必答題規則、形狀目錄列數、Phase 0 快照（路徑、檔案雜湊、讀取）、.claude/rules/ 規則檔清單與 origin 核對。不是 CLI。

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const SKILL_DIR = path.resolve(__dirname, '..');
const PLUGIN_ROOT = path.resolve(SKILL_DIR, '..', '..');
const SCHEMA_PATH = path.join(SKILL_DIR, 'references', 'init-answers.schema.json');
const CATALOG_PATH = path.join(SKILL_DIR, 'references', 'hook-catalog.md');

// 進 Phase 4 前一定要有答案或跳過理由的題目
const REQUIRED = ['U1', 'U2', 'U3', 'Q1', 'Q2', 'Q4', 'Q5', 'Q7', 'Q10', 'Q11', 'Q12'];
// 有答案（沒跳過）時，data 一定要有的欄位與型別（給 init-verify 機械驗收用）
const DATA_REQUIRED = {
  U3: { confirmedTerms: 'array', removedTerms: 'array', originalCount: 'integer' },
  Q1: { agents: 'array' },
  Q4: { team: 'boolean' },
  Q10: { import: 'boolean' },
  Q11: { choice: ['build', 'reuse', 'none'] },
};

function today() {
  const o = process.env.HARNESS_TODAY;
  if (o && /^\d{4}-\d{2}-\d{2}$/.test(o)) return o;
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const statePath = (target) => path.join(target, '.claude', 'harness', '.init-state.json');
const answersPath = (landing) => path.join(landing, '.claude', 'harness', 'init-answers.json');

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function writeJsonAtomic(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = path.join(path.dirname(p), `.${path.basename(p)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, p);
}

// ── 小驗證器：只支援本 plugin 的 schema 用到的關鍵字 ──
function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}
function typeOk(want, v) {
  const t = typeOf(v);
  return want === t || (want === 'number' && t === 'integer');
}
function validate(schema, value, root, where = '$') {
  root = root || schema;
  const errs = [];
  if (schema.$ref) {
    const m = schema.$ref.match(/^#\/\$defs\/(.+)$/);
    if (!m || !root.$defs || !root.$defs[m[1]]) return [`${where}: 不認得的 $ref ${schema.$ref}`];
    return validate(root.$defs[m[1]], value, root, where);
  }
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeOk(t, value))) return [`${where}: 型別應為 ${types.join('|')}，實際 ${typeOf(value)}`];
  }
  if (value === null) return errs;
  if (schema.enum && !schema.enum.some((e) => e === value)) errs.push(`${where}: 值 ${JSON.stringify(value)} 不在 ${JSON.stringify(schema.enum)}`);
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errs.push(`${where}: 長度至少 ${schema.minLength}`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errs.push(`${where}: 不符樣式 ${schema.pattern}`);
  }
  if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum) errs.push(`${where}: 至少 ${schema.minimum}`);
  if (typeOf(value) === 'object') {
    for (const k of schema.required || []) if (!(k in value)) errs.push(`${where}: 缺必填欄位 ${k}`);
    const props = schema.properties || {};
    const pats = Object.entries(schema.patternProperties || {}).map(([p, s]) => [new RegExp(p), s]);
    for (const [k, v] of Object.entries(value)) {
      if (props[k]) { errs.push(...validate(props[k], v, root, `${where}.${k}`)); continue; }
      const pm = pats.find(([re]) => re.test(k));
      if (pm) { errs.push(...validate(pm[1], v, root, `${where}.${k}`)); continue; }
      if (schema.additionalProperties === false) errs.push(`${where}: 不認得的欄位 ${k}`);
    }
  }
  if (Array.isArray(value) && schema.items) value.forEach((v, i) => errs.push(...validate(schema.items, v, root, `${where}[${i}]`)));
  return errs;
}

function loadSchema() { return readJson(SCHEMA_PATH); }

// 形狀目錄的目錄表：`## 目錄` 之後、下一個 `## ` 之前，以「| 數字 |」開頭的列。
// 預設跳過類別欄（第 5 欄）寫「不帶」的列——hook-catalog.md 維護節規定這些列 init 不記進答案檔，
// init-flow.js catalog 與 init-verify V16 都用這份列數對帳；列號照目錄表、不重編。`{ all: true }` 回全部列（連續性檢查用），
// 每列另帶 cls（類別欄原文）。儲存格裡的 `\|` 是跳脫的直線，不是欄位分隔。
function catalogRows(file = CATALOG_PATH, { all = false } = {}) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const start = lines.findIndex((l) => /^## 目錄\s*$/.test(l));
  if (start < 0) return [];
  const rows = [];
  for (let i = start + 1; i < lines.length && !/^## /.test(lines[i]); i++) {
    const m = lines[i].match(/^\|\s*(\d+)\s*\|\s*([^|]+?)\s*\|/);
    if (!m) continue;
    const cells = lines[i].replace(/^\|/, '').split(/(?<!\\)\|/).map((c) => c.trim());
    const cls = cells[4] || '';
    const skip = /^不帶/.test(cls);
    if (skip && !all) continue;
    rows.push({ row: Number(m[1]), name: m[2], cls, skip });
  }
  return rows;
}

// 答案檔的完整檢查：schema＋必答題＋data 必填欄位。回傳問題清單（空＝合格）
function checkAnswers(ans, { requireAll = true } = {}) {
  const problems = validate(loadSchema(), ans).map((e) => 'schema ' + e);
  const a = (ans && ans.answers) || {};
  if (requireAll) {
    for (const id of REQUIRED) {
      if (!a[id]) { problems.push(`必答題 ${id} 沒有紀錄（要有答案，或 skipped 寫跳過理由）`); continue; }
      if (a[id].skipped == null && !('answer' in a[id])) problems.push(`必答題 ${id} 沒有 answer 也沒有 skipped`);
    }
  }
  for (const [id, spec] of Object.entries(DATA_REQUIRED)) {
    const x = a[id];
    if (!x || x.skipped) continue;
    const d = x.data || {};
    for (const [k, t] of Object.entries(spec)) {
      if (Array.isArray(t)) { if (!t.includes(d[k])) problems.push(`${id}.data.${k} 要是 ${t.join('／')} 其一`); }
      else if (!typeOk(t, d[k])) problems.push(`${id}.data.${k} 要是 ${t}`);
    }
  }
  return problems;
}

// 與 check-flow-diagram.js 同一個算法：快照放在系統暫存目錄，以落點路徑的雜湊區分
function snapshotPath(root) {
  const r = path.resolve(root);
  const key = process.platform === 'win32' ? r.toLowerCase() : r;
  return path.join(os.tmpdir(), 'harness-init-snapshots', crypto.createHash('sha1').update(key).digest('hex').slice(0, 16) + '.json');
}

// p 是不是檔案系統根（磁碟根 C:\、UNC 分享根 \\server\share、/）。check-flow-diagram.js 不跟指向這類位置的連結。
// pm 給 path.win32／path.posix 可在任何平台用字串測；\\?\ 長路徑前綴先換回一般寫法再比。
function isFsRoot(p, pm = path) {
  let s = String(p || '');
  if (pm.sep === '\\') s = s.replace(/^\\\\[?.]\\UNC\\/i, '\\\\').replace(/^\\\\[?.]\\(?=[A-Za-z]:)/, '');
  if (!s) return false;
  const trim = (x) => x.replace(/[\\/]+$/, '');
  return trim(pm.parse(s).root) === trim(s);
}

// 檔案內容的 sha1（快照記的就是這個；check-flow-diagram.js 拍快照與 init-verify.js 比對沿用檔都用這一支）
function fileSha1(p) { return crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex'); }

// 讀 Phase 0 的快照（check-flow-diagram.js snapshot 寫的
// { root, takenAt, files: { 相對路徑: sha1 }, unreadable, ruleLinks: { 相對路徑: sha1 }, ruleLinkUnreadable }）。
// files／unreadable 是整棵走訪（跟指向專案外的符號連結、不跟指向專案內的；check 拿它跟現況比）；ruleLinks／ruleLinkUnreadable
// 是 .claude/rules/ 底下經符號連結走到的規則檔（依連結路徑記、內容是連結讀到的；專案外的連結 files 也有），只給 rulesSplit 的 origin 核對用。
// 先找 root 自己的快照；找不到且給了 target（Q4 把落點改到 target 底下的子目錄時，快照是對 target 拍的），
// 再找 target 的快照，只取落點底下的項目、路徑換成相對落點。都沒有回 null（舊版 init 的實例、或暫存目錄被清過）。
// 前綴比對：Windows 路徑不分大小寫，落點字面（例 Sub）跟快照記的實際檔名（例 sub/）大小寫可能不同，所以不分大小寫比；
// 其他平台照字面比。切掉前綴後留下的部分照快照原樣（實際檔名的大小寫）。
function readSnapshot(root, target) {
  const tries = [[path.resolve(root), '']];
  if (target && path.resolve(target) !== path.resolve(root)) {
    const pre = path.relative(path.resolve(target), path.resolve(root)).split(path.sep).join('/');
    if (pre && pre !== '..' && !pre.startsWith('../') && !path.isAbsolute(pre)) tries.push([path.resolve(target), pre + '/']);
  }
  const fold = process.platform === 'win32' ? (x) => x.toLowerCase() : (x) => x;
  for (const [r, prefix] of tries) {
    const p = snapshotPath(r);
    let snap;
    try { snap = readJson(p); } catch { continue; }
    if (!snap || !snap.files || typeof snap.files !== 'object') continue;
    const pf = fold(prefix);
    const under = (k) => fold(k).startsWith(pf);
    const pickMap = (m) => {
      const out = Object.create(null);
      if (m && typeof m === 'object') for (const [k, v] of Object.entries(m)) if (under(k)) out[k.slice(prefix.length)] = v;
      return out;
    };
    const pickList = (a) => (Array.isArray(a) ? a : []).filter(under).map((u) => u.slice(prefix.length));
    return { path: p, root: snap.root, takenAt: snap.takenAt, files: pickMap(snap.files), unreadable: pickList(snap.unreadable),
      ruleLinks: pickMap(snap.ruleLinks), ruleLinkUnreadable: pickList(snap.ruleLinkUnreadable) };
  }
  return null;
}

// 落點 .claude/rules/ 底下（含子目錄）的每份 .md，回傳相對落點、以 / 分隔的路徑，依字典序排好。
// init-flow.js rules 與 init-verify.js V20／V21 都用這一支，兩邊列出的檔與路徑寫法才會一致。
// - 副檔名與路徑的大小寫照實際檔名、比對時要完全相符（不做大小寫摺疊）。
// - 符號連結跟著走（statSync）：連到檔案的當成規則檔、連到目錄的往下走。理由：官方文件
//   （https://code.claude.com/docs/en/memory.md「Share rules across projects with symlinks」）寫
//   「The .claude/rules/ directory supports symlinks … Circular symlinks are detected and handled gracefully」，
//   連結進來的規則檔一樣會載入，所以一樣要在處置表有一筆；不跟的話它會躲過 V21。
//   以 realpath 記走過的目錄，連結繞回上層不會無限遞迴（對應文件說的循環連結）。
function listRuleFiles(root) {
  const base = path.join(root, '.claude', 'rules');
  const out = [];
  const seenDirs = new Set();
  (function walk(dir, rel) {
    let real;
    try { real = fs.realpathSync(dir); } catch { return; }
    if (seenDirs.has(real)) return;
    seenDirs.add(real);
    let names;
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const name of names) {
      const full = path.join(dir, name);
      const r = rel ? `${rel}/${name}` : name;
      let st;
      try { st = fs.statSync(full); } catch { continue; }   // 斷掉的連結：Claude Code 也載入不了，不列
      if (st.isDirectory()) walk(full, r);
      else if (st.isFile() && /\.md$/.test(name)) out.push(`.claude/rules/${r}`);
    }
  })(base, '');
  return out.sort();
}

// 處置表（rulesSplit）裡記的路徑：反斜線換成 /，與 listRuleFiles 同一種寫法
const normRulePath = (f) => String(f).replace(/\\/g, '/');

// 處置表的 origin 對 Phase 0 快照核對。init-flow.js rules（寫入時）與 init-verify.js V21（驗收時）用同一支，判準只有一份。
// root＝落點；target＝目標（落點在 target 底下時，快照是對 target 拍的）；list＝rulesSplit（file 已是 / 分隔）。
// 規則檔在快照裡的雜湊：ruleLinks 有的算經符號連結進來（依連結路徑記、內容是連結讀到的），用 ruleLinks；其餘查 files。
// - kept：快照裡要有這份、內容雜湊要沒變；不在快照＝init 之後才出現，不能記成沿用；雜湊變了＝init 期間改寫過，要記 new
// - new（或沒寫）：快照裡有、雜湊也沒變＝沒動過的既有檔，要記 kept；快照裡有、雜湊變了＝改寫既有檔，合法，照新建檔檢查
// - 找不到快照（舊版 init 的實例、暫存目錄被清過）：kept 照舊放行，證據寫明未核對
// 回傳 { snapshot, hits: 不合的項目, notes: 證據說明, keptOk: 核對過（或無快照可核對）的沿用檔 }
function checkRuleOrigins(root, target, list) {
  const snapshot = readSnapshot(root, target);
  const hits = [];
  const notes = [];
  const keptOk = new Set();
  const rewritten = [];
  let keptChecked = 0;
  let keptViaLink = 0;
  const has = (m, k) => Object.prototype.hasOwnProperty.call(m, k);
  for (const e of list) {
    const full = path.join(root, ...e.file.split('/'));
    if (!fs.existsSync(full)) { if (e.origin === 'kept' && !snapshot) keptOk.add(e.file); continue; }   // 檔不在由呼叫端另報
    const viaLink = snapshot ? has(snapshot.ruleLinks, e.file) : false;
    const inSnap = snapshot ? has(snapshot.files, e.file) || viaLink : false;
    const want = inSnap ? (viaLink ? snapshot.ruleLinks[e.file] : snapshot.files[e.file]) : null;
    const unreadable = snapshot ? snapshot.unreadable.includes(e.file) || snapshot.ruleLinkUnreadable.includes(e.file) : false;
    let same = null;
    if (inSnap) { try { same = fileSha1(full) === want; } catch { same = null; } }
    if (e.origin === 'kept') {
      if (!snapshot) { keptOk.add(e.file); continue; }
      if (unreadable) { keptOk.add(e.file); notes.push(`${e.file} 在快照裡讀不到內容，只核對了存在`); continue; }
      if (!inSnap) { hits.push(`${e.file} 記成沿用（origin: kept），但 Phase 0 快照裡沒有這份：這份是 init 之後才出現的，不能記成沿用；是這次建的就拿掉 origin（或寫 "new"），並在 CLAUDE.changelog.md 補建立那一行`); continue; }
      if (same === false) { hits.push(`${e.file} 記成沿用（origin: kept），但內容跟 Phase 0 快照不同（init 期間改寫過）：改寫過的既有檔記 "new"，CLAUDE.changelog.md 寫一行說改了什麼`); continue; }
      keptOk.add(e.file); keptChecked++; if (viaLink) keptViaLink++;
    } else if (inSnap && same === true) {
      hits.push(`${e.file} 記成新建（origin 沒寫或寫 new），但 Phase 0 之前就在、內容也沒變：沒動過的既有檔記 "origin":"kept"`);
    } else if (inSnap || unreadable) rewritten.push(e.file);
  }
  if (!snapshot) notes.push(`無快照（${snapshotPath(root)}），kept 未核對`);
  else {
    if (keptChecked) notes.push(`沿用 ${keptChecked} 份對過 Phase 0 快照（${snapshot.takenAt}）：存在且內容未變${keptViaLink ? `（其中 ${keptViaLink} 份是符號連結，比的是連結在 Phase 0 讀到的內容）` : ''}`);
    if (rewritten.length) notes.push(`${rewritten.join('、')} 在 Phase 0 之前就在、這次改寫過，記 new 照新建檔檢查`);
  }
  return { snapshot, hits, notes, keptOk };
}

function pluginVersion() {
  try { return readJson(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json')).version; } catch { return '0.0.0'; }
}

module.exports = {
  SKILL_DIR, PLUGIN_ROOT, SCHEMA_PATH, CATALOG_PATH, REQUIRED, DATA_REQUIRED,
  today, statePath, answersPath, readJson, writeJsonAtomic, validate, loadSchema, catalogRows, checkAnswers, snapshotPath, pluginVersion,
  fileSha1, isFsRoot, readSnapshot, listRuleFiles, normRulePath, checkRuleOrigins,
};
