#!/usr/bin/env node
// /harness:review 的收集腳本：從現場留下的紀錄，機械地抽出「harness 有沒有起作用」的數字與證據出處。
// 判讀交給模型；這支只負責「抽」，不下結論——抽取不靠模型讀逐字紀錄時的印象。
//
// 用法：
//   node review-collect.js <落點> [--since YYYY-MM-DD] [--transcripts <目錄>] [--out <檔.json>] [--probe]
//   <落點>：裝了 harness 的專案根目錄（有 .claude/harness/README.md）
//   --since：只看這天以後的 session（預設取安裝日：CLAUDE.md changelog 裡「建立」那一筆；0.10.0 起
//            changelog 拆出指令檔，找不到時再看 CLAUDE.changelog.md 與 .claude/harness/CHANGELOG.md，見 changelogEntries）
//   --transcripts：逐字紀錄目錄（預設 ~/.claude/projects/<落點換算的名稱>）
//   --include-install：連跑 /harness:init 的 session 與安裝時的冷啟探針 session 一起算（預設略過，探針會故意觸發擋下）
//   --probe：另外在實例的 .claude/hooks 跑 probe-hooks.js（兩條路徑）。這會執行專案裡的程式，所以要明確加才跑；
//            不加時腳本只讀檔，不執行專案的任何程式。
//
// 輸出：JSON（--out 寫檔，否則印到 stdout），每個數字都附出處（逐字紀錄檔名:行號）。
// exit 0 正常；exit 2 參數或落點錯誤。

'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// ── 參數 ──
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const root = args[0] && !args[0].startsWith('--') ? path.resolve(args[0]) : null;
if (!root || !fs.existsSync(path.join(root, '.claude', 'harness', 'README.md'))) {
  console.error('用法：node review-collect.js <落點> [--since YYYY-MM-DD] [--transcripts <目錄>] [--out <檔>] [--probe] [--include-install]');
  console.error('落點要是裝了 harness 的專案根目錄（找不到 .claude/harness/README.md）：' + (root || '（沒給）'));
  process.exit(2);
}
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
const rel = (p) => path.relative(root, p).split(path.sep).join('/');

// Claude Code 把專案路徑換算成逐字紀錄目錄名：英數字以外的字元一律換成 -
const slug = root.replace(/[^A-Za-z0-9]/g, '-');
const tdir = opt('--transcripts') || path.join(os.homedir(), '.claude', 'projects', slug);
const claudeMd = read(path.join(root, 'CLAUDE.md')) || '';

// ── changelog 讀取（harness 0.10.0 起 changelog 從指令檔與知識容器拆出去）──
// 一份檔的異動紀錄可能在三個地方，三處都讀、合併（同一個出處不重複）：
//   ① 舊格式：檔案本體的 `## Changelog` 節（到下一個 `## ` 標題或檔尾）——0.9.x 以前安裝的實例
//   ② 同目錄的 `<主檔名>.changelog.md`（根目錄知識容器：GLOSSARY.changelog.md（舊檔名 CONTEXT.changelog.md）、FLOWS.changelog.md…）——整份的日期行都算
//   ③ 同目錄的 `CHANGELOG.md` 裡 `## <檔名>` 那一節（.claude/harness/CHANGELOG.md 的 `## 05-knowledge-protocol.md`、
//      .claude/agents/CHANGELOG.md 的 `## qa-engineer.md`；來源專案的 tests/Project_Detail/CHANGELOG.md 也是這個形狀）
// 只認 `- YYYY-MM-DD` 開頭的行；輸出只記日期與出處（檔名:行號），不抄內容（筆記可能寫了帳密）。
const DATED = /^- (\d{4}-\d{2}-\d{2})/;
function sectionLines(text, title) {   // 回 [{ l, i }]（i＝0 起算的行號）；title 為 null 時取 `## Changelog`
  const all = text.split('\n');
  const isHead = title == null ? (l) => /^## Changelog\s*$/.test(l) : (l) => l.replace(/\s+$/, '') === '## ' + title;
  const start = all.findIndex(isHead);
  if (start < 0) return [];
  const out = [];
  for (let i = start + 1; i < all.length; i++) { if (/^## /.test(all[i])) break; out.push({ l: all[i].replace(/\r$/, ''), i }); }
  return out;
}
function changelogEntries(relFile) {
  const dir = path.posix.dirname(relFile), base = path.posix.basename(relFile), stem = base.replace(/\.md$/i, '');
  const relOf = (n) => (dir === '.' ? n : dir + '/' + n);
  const found = [];
  const push = (file, rows) => { for (const { l, i } of rows) { const m = l.match(DATED); if (m) found.push({ date: m[1], at: file + ':' + (i + 1), line: l }); } };
  const own = read(path.join(root, relFile));
  if (own != null) push(relFile, sectionLines(own, null));
  const split = relOf(stem + '.changelog.md');
  const splitText = read(path.join(root, split));
  if (splitText != null) push(split, splitText.split('\n').map((l, i) => ({ l: l.replace(/\r$/, ''), i })));
  const shared = relOf('CHANGELOG.md');
  const sharedText = shared === relFile ? null : read(path.join(root, shared));
  if (sharedText != null) push(shared, sectionLines(sharedText, base));
  const seen = new Set();
  return found.filter((e) => (seen.has(e.at) ? false : (seen.add(e.at), true)));
}
const INIT_LINE = /建立（harness plugin|\/harness:init 實例化/;
// 安裝日：① CLAUDE.md 的變更紀錄（changelogEntries 合併本體的 Changelog 節與 CLAUDE.changelog.md）裡「建立／init」那幾行的最早日期；
// ② 沒有就退到 .claude/harness/CHANGELOG.md 任一節裡 init 建檔那一行的最早日期（實例化時每份制度檔都記一行
// 「建立（harness plugin /harness:init 實例化…）」）。
// 不對 CLAUDE.md 全文比對：新實例的本體已經沒有 changelog，專案概要裡「- 2026-01-05 建立訂單模組」這種進度行會被誤認成安裝日。
const installDate = (() => {
  const fromSplit = changelogEntries('CLAUDE.md').filter((e) => /建立|init/.test(e.line)).map((e) => e.date).sort()[0];
  if (fromSplit) return fromSplit;   // changelogEntries 也讀本體的 Changelog 節，舊實例在這裡就找得到
  const h = read(path.join(root, '.claude', 'harness', 'CHANGELOG.md')) || '';
  return h.split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => DATED.test(l) && INIT_LINE.test(l))
    .map((l) => l.slice(2, 12)).sort()[0] || null;
})();
const since = opt('--since') || installDate;
// 逐字紀錄的時間是 UTC；--since 與安裝日是當地日期，比較前先換成當地日期（台北清晨的 session 在 UTC 還是前一天）
const localDay = (ts) => {
  const d = new Date(ts); if (isNaN(d)) return String(ts || '').slice(0, 10);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
};
if (opt('--since') && !/^\d{4}-\d{2}-\d{2}$/.test(opt('--since'))) {
  console.error('--since 要寫成 YYYY-MM-DD：' + opt('--since'));
  process.exit(2);
}

const out = {
  root, transcriptsDir: tdir, installDate, since, generatedAt: new Date().toISOString(),
  sessions: [], A: {}, B: {}, C: {}, D: {}, E: {}, F: {}, G: {}, H: {}, I: {}, J: {}, notes: [],
};

// ── 規則來源：實例的派工檢查表（沒有必讀規則時，用 harness 0.5.1 的標準當對照）──
// 只用文字解析讀表，不執行專案裡的程式（本腳本必須只讀；eval 會讓表裡的運算式在收集時被執行）
function jsString(lit) {   // 單引號 JS 字串字面量 → 值（只處理本表會出現的跳脫）
  return lit.slice(1, -1).replace(/\\(.)/g, (_, c) => ({ n: '\n', t: '\t' }[c] || c));
}
function loadMarkers() {
  const src = read(path.join(root, '.claude', 'hooks', 'check-review-discipline.js'));
  if (!src) return null;
  const m = src.match(/const REQUIRED_MARKERS = \{([\s\S]*?)\n\};/);
  if (!m) return null;
  const table = {};
  const keyRe = /^\s{2}'([^']+)':\s*\[([\s\S]*?)^\s{2}\],?\s*$/gm;
  let k;
  while ((k = keyRe.exec(m[1]))) {
    const rules = [];
    const ruleRe = /name:\s*('(?:[^'\\]|\\.)*')[\s\S]*?pattern:\s*('(?:[^'\\]|\\.)*')/g;
    let r;
    while ((r = ruleRe.exec(k[2]))) rules.push({ name: jsString(r[1]), pattern: jsString(r[2]) });
    table[k[1]] = rules;
  }
  return Object.keys(table).length ? table : null;
}
const markers = loadMarkers();
const managed = markers ? Object.keys(markers).filter((k) => k !== '*') : [];
// 角色名、模型名只收已知清單（取自工具輸入，可以是任何字；名稱樣態擋不住長得像名稱的值——審查者實測）
let instanceAgents = [];
try { instanceAgents = fs.readdirSync(path.join(root, '.claude', 'agents')).filter((x) => x.endsWith('.md')).map((x) => x.slice(0, -3)); } catch {}
const BUILTIN_AGENTS = ['general-purpose', 'Explore', 'Plan', 'claude', 'statusline-setup', 'claude-code-guide', 'codex-rescue', 'code-reviewer', 'backend-architect', 'backend-engineer', 'frontend-engineer', 'qa-engineer'];
const agentName = (t) => (!t || managed.includes(t) || instanceAgents.includes(t) || BUILTIN_AGENTS.includes(t)) ? t : '（其他角色）';
// 模型：別名，或「claude-家族-純數字版本」（版本段只准數字，帶不進任意字）
const modelName = (m) => m ? (/^(?:sonnet|opus|haiku|fable|inherit|claude-(?:opus|sonnet|haiku|fable)-\d{1,2}(?:-\d{1,2})?(?:-\d{8})?)(?:\[1m\])?$/i.test(m) ? m : '（其他模型）') : null;
// 必讀檔：實例的表有「必讀：…」規則就照實例（連專案自加的必讀一起查）；沒有才用 harness 0.5.1 的標準對照
// 專案詞彙表新舊兩個檔名都認：GLOSSARY.md（新）或 CONTEXT.md（舊）；讀過或列過任一個都算
const GLOSSARY_LABEL = 'GLOSSARY.md/CONTEXT.md';
const GLOSSARY_RE = /GLOSSARY\.md|CONTEXT\.md/i;
const STANDARD_READS = {
  '*': [['CLAUDE.md', /CLAUDE\.md/i], [GLOSSARY_LABEL, GLOSSARY_RE]],
  'backend-architect': [['FLOWS.md', /FLOWS\.md/i]],
  'backend-engineer': [['FLOWS.md', /FLOWS\.md/i]],
  'frontend-engineer': [['FLOWS.md', /FLOWS\.md/i]],
  'code-reviewer': [['FLOWS.md', /FLOWS\.md/i]],
  'qa-engineer': [['PROJECT.md', /tests[\\/]Project_Detail[\\/]PROJECT\.md/i]],
};
const hookHasMustRead = !!(markers && Object.values(markers).some((rs) => rs.some((r) => /^必讀：/.test(r.name))));
function requiredReadsFor(type) {
  if (!hookHasMustRead) return [...(STANDARD_READS['*'] || []), ...(STANDARD_READS[type] || [])];
  const rs = [...(markers['*'] || []), ...(markers[type] || [])].filter((r) => /^必讀：/.test(r.name));
  const outRs = [];
  // 輸出的名稱用標準檔名（拿樣本路徑測這條規則的正則），對不上就寫第幾條——不抄規則名與正則原文
  const samples = [['CLAUDE.md', 'CLAUDE.md'], [GLOSSARY_LABEL, 'GLOSSARY.md'], [GLOSSARY_LABEL, 'CONTEXT.md'], ['FLOWS.md', 'FLOWS.md'], ['PROJECT.md', path.join('tests', 'Project_Detail', 'PROJECT.md')]];
  rs.forEach((r, i) => { try {
    const re = new RegExp(r.pattern, 'i');
    let label = (samples.find(([, p]) => re.test(path.join(root, p))) || [])[0] || ((type || '*') + ' 適用的第 ' + (i + 1) + ' 條必讀規則');
    while (outRs.some(([k]) => k === label)) label += '＊';
    // 詞彙表規則：實例的表若只認舊檔名 CONTEXT.md，專案改名後讀 GLOSSARY.md 也要算讀到
    outRs.push([label, label === GLOSSARY_LABEL ? new RegExp(re.source + '|' + GLOSSARY_RE.source, 'i') : re]); } catch { out.notes.push('實例的必讀規則正則寫壞了，略過：' + (type || '*') + ' 的第 ' + (i + 1) + ' 條必讀規則（內容回派工檢查表看）'); } });
  return outRs;
}
out.D.mustReadSource = hookHasMustRead ? '實例的派工檢查表（含專案自加的必讀規則）' : 'harness 0.5.1 標準（實例的派工檢查表沒有必讀檔名規則——版本落後）';

// 遮值規則（輸出前一律套用）：值整段遮掉，不論長短、有沒有標點
const SECRET_NAME = String.raw`[\w-]*(?:api[_-]?key|apikey|key|token|secret|pass|pwd|credential)[\w-]*`;
const REDACT_RULES = [
  // 名稱=值、名稱: 值（含 ERP_KEY=、x-api-key: 、$env:X_TOKEN='…'）
  [new RegExp('(\\b' + SECRET_NAME + '\\s*[=:]\\s*[\'"]?)(?![\'"]?\\$(?!env:)|\\{|<|\\*\\*\\*)[^\\s\'"&;|,}\\\\]+', 'gi'), '$1***'],
  // JSON 欄位（含跳脫成 \"apikeyid\":\"…\"）
  [new RegExp('(\\\\?["\']' + SECRET_NAME + '\\\\?["\']\\s*:\\s*\\\\?["\'])(?!\\$|\\{|<|\\*\\*\\*)[^"\'\\\\]+', 'gi'), '$1***'],
  // --password 值、--token=值
  [/(--?(?:password|passwd|pwd|token|secret|api-?key|apikey)(?:\s+|=))(?!-|\$|\*\*\*)[^\s'"]+/gi, '$1***'],
  // Authorization: Bearer／Basic／token 值；單獨的 Bearer 值
  [/(\bAuthorization\s*:\s*(?:Bearer|Basic|token)?\s*)(?!\$|\*\*\*)[^\s'"]+/gi, '$1***'],
  [/(\b(?:Bearer|Basic)\s+)(?!\$|\*\*\*)[^\s'"]{6,}/gi, '$1***'],
  // 網址帳密、mysql -p密碼
  [/(:\/\/[^\s:@\/]+:)[^\s@\/]+@/g, '$1***@'],
  [/(\bmysql\b[^\n]*\s-p)(?!\s|\$|\*\*\*)\S+/gi, '$1***'],
  // curl -u／--user 帳號:密碼、sshpass -p 密碼、ConvertTo-SecureString "密碼"、Cookie 標頭整段
  [/((?:\s-u|--user)\s*['"]?[^\s:'"]+:)(?!\$|\*\*\*)[^\s'"@]+/gi, '$1***'],
  [/(\bsshpass\s+-p\s*)(?!\$|\*\*\*)\S+/gi, '$1***'],
  [/(\bConvertTo-SecureString\s+(?:-String\s+)?['"]?)(?!\$|\*\*\*)[^'"\s]+/gi, '$1***'],
  [/(\bCookie\s*:\s*)(?!\*\*\*)[^'"\n]+/gi, '$1***'],
];
function redactSoft(t) { let x = String(t); for (const [re, r] of REDACT_RULES) x = x.replace(re, r); return x; }
// 摘錄（指令、對話、訊息）另把 UUID 也遮掉：UUID 常被拿來當金鑰；出處欄位的 session 編號不經過這裡
function redact(t) { return redactSoft(t).replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<UUID>'); }
// 輸出前的總清掃：所有字串都過一般遮值（出處、檔名、路徑裡的 session 編號保留，才能對回原文）
function redactDeep(v) {
  if (typeof v === 'string') return redactSoft(v);
  if (Array.isArray(v)) return v.map(redactDeep);
  if (v && typeof v === 'object') { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = redactDeep(x); return o; }
  return v;
}

// 標籤只收實例 .claude/hooks 程式碼裡出現過的「[標籤]」；其他換成固定字樣（標籤取自工具結果原文，任何字都可能出現）
let hookSrc = ''; let reviewSrc = '';
// 實例的 hook、plugin 範本、plugin 自己常駐的 hook（wordlist-sweep 等）
for (const d of [path.join(root, '.claude', 'hooks'), path.resolve(__dirname, '..', '..', '..', 'hooks', 'templates'), path.resolve(__dirname, '..', '..', '..', 'hooks')]) {
  try { for (const n of fs.readdirSync(d).filter((x) => x.endsWith('.js'))) { const t = read(path.join(d, n)) || ''; hookSrc += t; if (n === 'check-review-discipline.js') reviewSrc += t; } } catch {}
}
// 標籤清單：hook 程式碼裡緊接在引號後面的「[標籤]」（hook 輸出訊息的寫法）；陣列、索引這類方括號不算
// 另有兩種動態寫法：規則引擎用 '[' + LABEL + ']'（const LABEL = '危險指令守門'）、派工檢查用 `[${rule.name}]`，
// 所以 LABEL 常數與規則的 name 字面量也收。規則的 id／kind 只出現在訊息中間，不收（收了會把開頭剛好是 [id] 的一般錯誤算成擋下）
const KNOWN_TAGS = new Set([
  // 「[標籤]」後面要接空白或引號（訊息開頭的寫法）；含正則符號的（[A-Za-z_]、[\s\S]）不收
  ...[...hookSrc.matchAll(/['"`]\[([^\]'"`\n,\\^$*+?(){}|]{2,40})\](?=[\s'"`])/g)].map((m) => m[1]).filter((t) => !/^\s|\s$|^-/.test(t)),
  ...[...hookSrc.matchAll(/\bLABEL\s*=\s*['"]([^'"\n]{2,40})['"]/g)].map((m) => m[1]),
  // name 只從派工檢查收（只有它用 `[${rule.name}]` 當標籤；shell-model 之類的 name 不是標籤）
  ...[...reviewSrc.matchAll(/\bname:\s*['"]([^'"\n]{2,40})['"]/g)].map((m) => m[1]),
].filter((t) => !/^\d+$/.test(t) && !t.includes('${')));
const isKnownTag = (t) => !!t && KNOWN_TAGS.has(t);
const knownTag = (t) => isKnownTag(t) ? t : '（不是本專案 hook 的標籤，回原文看）';
// 擋下的判定：帶「PreToolUse:… hook error:」前綴的一定是 hook；只有「[…]」開頭的，標籤要是已知的 hook 標籤才算
// （審查者實測：WebFetch 之類的錯誤訊息也可能以 [ 開頭，原本會被算成擋下）
function hookDenialTag(b) {
  if (!(b.type === 'tool_result' && b.is_error === true)) return null;
  // 工具名可能帶 -（MCP 工具 mcp__服務__some-tool），取到「 hook error:」為止
  const m = textOf(b).match(/^(PreToolUse:\S+? hook error:\s*)?\[([^\]]+)\]/);
  if (!m || !(m[1] || isKnownTag(m[2]))) return null;
  return knownTag(m[2]);
}
// 名稱類欄位（角色、模型、hook 檔名）只收名稱樣態，其他換成固定字樣
// 試跑失敗行只收實例裡真的有的 hook 檔名，與固定的結果值
let hookFiles = [];
try { hookFiles = fs.readdirSync(path.join(root, '.claude', 'hooks')).filter((x) => x.endsWith('.js')); } catch {}
const OUTCOMES = ['BLOCK', 'ALLOW', 'NOTE', 'CRASH'];
// 沉澱回答的值只收固定樣態（無、已補2詞、已正名2處…），其他換成固定字樣
// 固定清單（hook 範例的寫法）：無、已補N詞／條／鏈／處、已正名N處——不再用「已＋任意中文」的樣態（帶得進少量任意字）
const sedimentValue = (v) => /^(?:無|已補\d{1,3}(?:詞|條|鏈|處|個)|已正名\d{1,3}處)$/.test(v) ? v : '（非標準值，回原文看）';

// ── 逐字紀錄 ──
const badLines = {};   // 解析失敗的行數（含開頭 BOM），寫進 notes，不默默丟掉
const rows = (f) => (read(f) || '').replace(/^﻿/, '').split('\n').map((l, i) => {
  if (!l.trim()) return null;
  try { const o = JSON.parse(l); o.__line = i + 1; return o; } catch { badLines[path.basename(f)] = (badLines[path.basename(f)] || 0) + 1; return null; }
}).filter(Boolean);
const blocks = (o) => { const c = o.message && o.message.content; return typeof c === 'string' ? [{ type: 'text', text: c }] : (Array.isArray(c) ? c : []); };
const textOf = (b) => typeof b.content === 'string' ? b.content : (Array.isArray(b.content) ? b.content.map((x) => x.text || '').join('') : '');
const where = (f, o) => path.basename(f) + ':' + o.__line;
const norm = (x) => path.resolve(x).toLowerCase();
const isMine = (c) => norm(c) === norm(root) || norm(c).startsWith(norm(root) + path.sep);
// 每列標上 __mine；回傳不是這個專案的列數
function markRows(R) {
  let cur = (R.find((o) => o.cwd) || {}).cwd || null; let n = 0;
  for (const o of R) { if (o.cwd) cur = o.cwd; o.__mine = !cur || isMine(cur); if (!o.__mine) n++; }
  return n;
}
// 指令只記指令名與連到的主機，不抄原文（原文可能帶金鑰、密碼；遮值規則永遠追不完所有寫法）
const RISKY_PROG = /\b(ssh|scp|rsync|sftp|curl|wget|iwr|irm|Invoke-WebRequest|Invoke-RestMethod|psql|mysql|sqlcmd|mongosh|kubectl|helm|terraform|alembic|docker\s+push|git\s+push|git\s+commit|flow\.sh|deploy)\b/gi;
function cmdShape(c) {
  const programs = [...new Set((c.match(RISKY_PROG) || []).map((x) => x.toLowerCase().replace(/\s+/g, ' ')))];
  const hosts = new Set(); let unknownHosts = 0;
  // 主機名只輸出「專案自己的文件裡寫過的」（見 knownHost）；其他只計數，判讀時照出處回原文看。
  // 抽取本身不求完美：斷詞器怎麼改都有新漏法（審查者連兩輪實測：密碼含 @、多行指令、'\'' 引號都曾讓金鑰被當成主機），
  // 所以不靠抽取的準確度擋外洩，靠「只輸出已知值」。
  const seen = new Set();
  const addHost = (h) => {
    h = String(h || '').toLowerCase().replace(/:\d+$/, '');
    // 標籤允許底線（ssh prod_db、ssh config 別名常見；原本被整條丟掉、連計數都沒有——審查者實測）
    if (!/^[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?(?:\.[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?)*$/.test(h) || seen.has(h)) return;
    seen.add(h);
    if (knownHost(h)) hosts.add(h); else unknownHosts++;
  };
  // 網址：帳密段取最後一個 @ 之後；主機名碰到第一個非主機字元就停（; ? # / : 等）
  for (const m of c.matchAll(/\b[a-z][\w+.-]*:\/\/([^\s\/'"?#]+)/gi)) addHost((m[1].split('@').pop().match(/^[a-z0-9_.-]+/i) || [])[0]);
  // ssh 類：斷詞後跳過選項與選項的值，只看第一個位置參數（引號包住的內層指令是一整個詞，不會被掃）
  const toks = shellWords(c);
  const takesValue = { ssh: 'BbcDEeFIiJLlmOoPpQRSWw', scp: 'cFiJloPS', sftp: 'BbcDFiJloPRs', rsync: 'eBfT' };
  const SEP = /^(?:;|&|&&|\|\||\|)$/;
  for (let i = 0; i < toks.length; i++) {
    // 只在指令開頭認（前一個詞是分隔符或 sudo 之類的前綴）；$(ssh …)、`ssh …` 去掉前面的符號
    const prev = i ? toks[i - 1] : ';';
    const sub = /^(?:[A-Za-z_]\w*=)?(?:\$\(|`|\()+/.test(toks[i]);   // $(ssh …)、`ssh …`、OUT=`ssh …`
    const wrapped = toks.slice(Math.max(0, i - 3), i).some((w) => /^(?:sudo|sshpass|timeout)$/.test(w));   // sshpass -p X ssh …
    if (!(sub || wrapped || SEP.test(prev) || /^(?:exec|nohup|time|env|&)$/.test(prev))) continue;
    const prog = path.basename(toks[i].replace(/^(?:[A-Za-z_]\w*=)?(?:\$\(|`|\()+/, '')).toLowerCase().replace(/\.exe$/, '');
    if (!takesValue[prog]) continue;
    for (let k = i + 1; k < toks.length; k++) {
      const t = toks[k];
      if (SEP.test(t)) break;
      if (t.startsWith('--')) { if (!t.includes('=') && /^--(?:rsh|port|password-file)$/.test(t)) k++; continue; }
      if (t.startsWith('-')) { if (takesValue[prog].includes(t[t.length - 1])) k++; continue; }   // 合併寫的 -vp 2222：看最後一個字母
      if (prog === 'ssh' || prog === 'sftp') { addHost(t.split(':')[0].split('@').pop()); break; }
      if (t.includes(':')) addHost(t.split(':')[0].split('@').pop());   // scp／rsync 的遠端寫法 user@host:path
    }
  }
  // 資料庫用戶端的 -h／--host／-S
  for (const m of c.matchAll(/\b(?:mysql|psql|mongosh|sqlcmd)\b[^\n;|&]*?\s(?:-h|-S|--host)[\s=]*['"]?([\w.-]+)/g)) addHost(m[1]);
  return { programs, hosts: [...hosts], unknownHosts };
}
// 已知主機：本機位址，或在專案知識文件（CLAUDE.md、GLOSSARY.md／CONTEXT.md、FLOWS.md、PROJECT.md、.claude/harness/*.md）裡以完整詞出現過的主機名
let docText = '';
for (const p of ['CLAUDE.md', 'GLOSSARY.md', 'CONTEXT.md', 'FLOWS.md', path.join('tests', 'Project_Detail', 'PROJECT.md')]) docText += '\n' + (read(path.join(root, p)) || '');
try { for (const n of fs.readdirSync(path.join(root, '.claude', 'harness')).filter((x) => x.endsWith('.md'))) docText += '\n' + (read(path.join(root, '.claude', 'harness', n)) || ''); } catch {}
docText = docText.toLowerCase();
function knownHost(h) {
  if (h === 'localhost' || h === '127.0.0.1') return true;
  if (!h.includes('.')) return false;
  const e = h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // 兩側邊界對稱：後面也不能接「.英數字」（否則文件寫 api.example.com 會放行 api.example）；句尾的句點可以
  return new RegExp('(?:^|[^a-z0-9._-])' + e + '(?![a-z0-9_-]|\\.[a-z0-9])').test(docText);
}
// 簡易 shell 斷詞（只為了計數與找主機，不求完整）：空白分詞，單雙引號內視為同一個詞；
// 反斜線跳脫、雙引號裡的 \"、反斜線換行（續行）；換行與 ; & && || | 各自成分隔詞
function shellWords(c) {
  const out = []; let cur = ''; let q = null; let has = false;
  const push = () => { if (has) out.push(cur); cur = ''; has = false; };
  for (let i = 0; i < c.length; i++) {
    const ch = c[i];
    if (q === "'") { if (ch === q) q = null; else cur += ch; continue; }
    if (ch === '\\') {
      const nx = c[i + 1];
      if (nx === '\n' || (nx === '\r' && c[i + 2] === '\n')) { i += nx === '\r' ? 2 : 1; continue; }   // 續行
      // 後面接英數字時保留反斜線（Windows 路徑 C:\…\ssh.exe）
      if (nx !== undefined && !/[A-Za-z0-9]/.test(nx) && (!q || nx === '"' || nx === '\\' || nx === '$' || nx === '`')) { cur += nx; has = true; i++; continue; }
    }
    if (q) { if (ch === q) q = null; else cur += ch; continue; }
    if (ch === '"' || ch === "'") { q = ch; has = true; continue; }
    if (ch === '\n' || ch === '\r') { push(); if (out[out.length - 1] !== ';') out.push(';'); continue; }
    if (/\s/.test(ch)) { push(); continue; }
    if (ch === ';' || ch === '|' || ch === '&') { push(); const two = c.slice(i, i + 2); if (two === '&&' || two === '||') { out.push(two); i++; } else out.push(ch); continue; }
    cur += ch; has = true;
  }
  push();
  return out;
}

let files = [];
try { files = fs.readdirSync(tdir).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(tdir, f)); } catch { out.notes.push('找不到逐字紀錄目錄：' + tdir); }

const CORRECTION = /不對|錯了|不是這樣|你漏|漏了|怎麼又|為什麼沒|為什麼不|沒有照|不要這樣|重做|搞錯/;
// 金鑰寫法：key=／token=／password=／secret= 後面接一段非變數的值、Bearer 權杖、或整段 UUID 當值（實測：K='<UUID>'）
// 每一種各自比對，一條指令可以記多種；只記種類與出處，不抄值
const PLACEHOLDER = '(?:dummy|fake|test|sample|placeholder|changeme|example|redacted|masked|xxx+)(?:[-_]?(?:key|id|token|secret))?[\'"]?(?![\\w-])';
// 偵測用的名稱比遮值嚴：金鑰字要在名稱結尾（可再接 _id），排除 KEYCLOAK_URL、MAX_TOKENS、KEYBOARD_LAYOUT、--token-file 這類（審查者實測誤判）
const SECRET_NAME_STRICT = String.raw`[\w-]*(?:api[_-]?key|apikey|key|token|secret|pass(?:word|wd)?|pwd|credentials?)(?:[_-]?id)?`;
// 值是在引用別的東西，不是金鑰本身：sed 的 .*、os.environ[…]、env.X、/run/secrets/…
const VALUE_REF = String.raw`\.\*|os\.environ|(?:process\.)?env\.|\/run\/secrets`;
const SECRET_KINDS = [
  // 排除佔位字（dummy、fake…）與函式呼叫（實測：Python 的 credentials=XxxCredentials(…)、token=c.get_token() 被當成值）；
  // 值用 (?=(…))\1 一次吃滿，避免回溯縮短後躲過 (?!\()
  ['名稱=值', new RegExp('\\b' + SECRET_NAME_STRICT + '\\s*[=:]\\s*[\'"]?(?![\'"]?\\$(?!env:)|\\{|<|' + VALUE_REF + '|' + PLACEHOLDER + ')(?=([^\\s\'"&;|,}\\\\()]{4,}))\\1(?!\\()', 'i')],
  ['JSON 欄位', new RegExp('\\\\?["\']' + SECRET_NAME_STRICT + '\\\\?["\']\\s*:\\s*\\\\?["\'](?!\\$|\\{|<)[^"\'\\\\]{4,}', 'i')],
  // PowerShell 變數直接給字串：$pw = "…"、$apiKey = '…'
  ['變數=字串', new RegExp('\\$' + SECRET_NAME_STRICT.replace('(?:api', '(?:pw|api') + '\\s*=\\s*["\'](?!\\$)[^"\']{4,}["\']', 'i')],
  ['帳號與密碼連寫', /\bsqlplus\s+\w+\/(?!\$)[^\s@\/]{3,}@|\blftp\b[^\n]*\s-u\s*['"]?[^\s,'"]+,(?!\$)[^\s'"]{3,}|\bsmbclient\b[^\n]*\s-U\s*['"]?[^\s%'"]+%(?!\$)[^\s'"]{3,}/i],
  ['密碼旗標 2', /\bldapsearch\b[^\n]*\s-w\s*['"]?(?!\$|-)[^\s'"]{3,}|\baz\s+login\b[^\n]*\s(?:-p|--password)\s*['"]?(?!\$|-)[^\s'"]{3,}|\becho\s+['"]?(?!\$)[^\s'"|]{6,}['"]?\s*\|\s*docker\s+login\b/i],
  ['網址裡的權杖', /api\.telegram\.org\/bot\d+:[\w-]{20,}|hooks\.slack\.com\/services\/[\w\/]{20,}/i],
  // 名稱與值用空白隔開：rclone … secret_access_key 值、aws configure set … 已在上面
  ['名稱 值', /\b(?:secret_access_key|access_key_id|client_secret|api_key)\s+(?!\$|-)[^\s'"]{6,}/i],
  ['密碼參數', /--?(?:password|passwd|pwd|token|secret|api-?key|apikey)(?:\s+|=)['"]?(?!-|\$)[^\s'"]{3,}/i],
  // 值不可以是 $變數，也不可以只是 Bearer／Basic／token 這個字本身（實測：Bearer $TOKEN 曾被當成值）
  ['Authorization', /\bAuthorization['"]?\s*[:=]\s*['"]?(?:(?:Bearer|Basic|token)\s+)?(?!\$|(?:Bearer|Basic|token)\b)[^\s'"]{6,}|\b(?:Bearer|Basic)\s+(?!\$)[^\s'"]{12,}/i],
  ['變數=UUID', /\b[A-Za-z_]\w*=['"]?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i],
  // PowerShell hashtable、鍵加引號：@{'X-Api-Key'='值'}、@{"password"="值"}
  ['hashtable 鍵', new RegExp('["\']' + SECRET_NAME_STRICT + '["\']\\s*=\\s*["\'](?!\\$)[^"\']{4,}', 'i')],
  ['網址參數', /[?&](?:pw|pwd|sig|access_token|api_key|apikey|token|key|secret|password)=(?!\$)[^\s&'"]{4,}/i],
  ['mysql 密碼參數', /\bmysql\w*\b[^\n]*\s-p(?!\s|\$)\S{3,}/i],
  ['密碼旗標', /\b(?:sqlcmd\b[^\n]*\s-P|redis-cli\b[^\n]*\s-a|docker\s+login\b[^\n]*\s(?:-p|--password))\s*(?!\$|-)\S{3,}|\s-Password\s+['"]?(?!\$)[^\s'"$]{3,}|\baws\s+configure\s+set\s+aws_secret_access_key\s+(?!\$)\S{3,}|\bnet\s+use\b[^\n]*\/user:\S+\s+(?!\$|\*)\S{3,}/i],
  // 帳號:密碼：排除 -u 1000:1000 這種 uid:gid
  ['帳號:密碼參數', /(?:\s-u|--user)\s*['"]?(?!\d+:\d+\b)[^\s:'"]+:(?!\$)[^\s'"@]{3,}/i],
  ['sshpass', /\bsshpass\s+-p\s*(?!\$)\S{3,}/i],
  // 參數順序不固定（-AsPlainText -Force -String "…" 也常見）
  ['SecureString 明文', /\bConvertTo-SecureString\b(?=[^\n;|]*-AsPlainText)[^\n;|]*?['"](?!\$)[^'"]{3,}['"]/i],
  ['網址權杖', /:\/\/(?!\$)[^\s:@\/'"]{16,}@/],
  ['私鑰', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['Cookie 標頭', /\bCookie\s*:\s*[^'"\n]*=[^'"\n;]{6,}/i],
  ['網址帳密', /:\/\/[^\s:@\/]+:(?!\$)[^\s@\/]{3,}@/],
];
const RISKY_CMD =/\b(ssh|scp|rsync|sftp|curl|wget|iwr|irm|Invoke-WebRequest|Invoke-RestMethod|psql|mysql|sqlcmd|mongosh|kubectl|helm|terraform|alembic|docker\s+push|git\s+push|deploy)\b/i;

const agg = {
  sessions: 0, userTurns: 0, reminderSessions: 0, dispatch: [], denials: [], stopFeedback: [], sediment: [],
  corrections: [], interrupts: 0, askUser: 0, riskyCmds: [], secretCmds: [], commitCmds: [], firstDispatchAligned: [], editTurns: [],
};

for (const f of files) {
  const R = rows(f);
  // 主對話或任一 subagent 在範圍內有活動就看（23:59 派出、午夜後才跑完的 subagent，主對話可能沒有範圍內的列）
  const inRangeRow = (o) => o.timestamp && (!since || localDay(o.timestamp) >= since);
  let inRange = R.some(inRangeRow);
  // 範圍內還有活動的 subagent（檔名 agent-<agentId>.jsonl）
  const lateAgents = new Set();
  try {
    const sd = path.join(tdir, path.basename(f, '.jsonl'), 'subagents');
    for (const x of fs.readdirSync(sd).filter((n) => n.endsWith('.jsonl'))) if (rows(path.join(sd, x)).some(inRangeRow)) lateAgents.add(x.replace(/^agent-|\.jsonl$/g, ''));
  } catch {}
  if (!inRange && !lateAgents.size) continue;
  const sid = path.basename(f, '.jsonl');
  const cwds = [...new Set(R.map((o) => o.cwd).filter(Boolean))];
  if (cwds.length && !cwds.some(isMine)) {
    out.notes.push('略過別的專案的 session（逐字紀錄目錄名撞名，cwd 不是這個專案）：' + sid);
    continue;
  }
  // 逐列篩：session 中途 cd 到別的專案時，那幾列不算（沒有 cwd 的列沿用前一列；開頭沒有 cwd 的列沿用第一個出現的 cwd）
  const otherRows = markRows(R);
  if (otherRows) out.notes.push(sid + ' 有 ' + otherRows + ' 列的 cwd 不是這個專案，已略過');
  // 跑 /harness:init 的 session：裡面的冷啟探針會故意派不帶 model 的 agent、故意觸發擋下，算進使用數字會失真
  const isInstall = R.some((o) => o.type === 'user' && blocks(o).some((b) => b.type === 'text' && /^Base directory for this skill:[^\n]*harness[\\/][^\n]*skills[\\/]init/.test(b.text || '')));
  if (isInstall && !args.includes('--include-install')) { out.notes.push('略過安裝 session（冷啟探針會故意觸發擋下）：' + sid + '；要算進來加 --include-install'); continue; }
  // 冷啟探針開的子程序（claude -p）：第一個提問是探針 prompt（PROBE-OK、問 [harness] 提醒、git commit --dry-run 試擋）
  const firstUser = R.find((o) => o.type === 'user' && o.message);
  const firstText = firstUser ? blocks(firstUser).filter((b) => b.type === 'text').map((b) => b.text || '').join('') : '';
  if (/PROBE-OK|開頭的提醒？|harness-probe|--dry-run --allow-empty/.test(firstText) && !args.includes('--include-install')) {
    out.notes.push('略過安裝時的冷啟探針 session：' + sid + '（探針會故意觸發擋下）');
    continue;
  }
  agg.sessions++;
  const sess = { id: sid, lines: R.length, first: (R.find((o) => o.timestamp) || {}).timestamp || null, dispatches: 0, subagents: [] };
  const raw = read(f) || '';
  if (/\[harness\] 本專案有制度層/.test(raw)) agg.reminderSessions++;
  // 先找出被 hook 擋下的工具呼叫：被擋的提問不算對齊，被擋的派工不算真的派出去
  const deniedIds = new Set();
  const failedIds = new Set();   // 任何失敗的工具呼叫（含被擋下、改檔工具自己失敗）
  const lateDispatch = new Set();   // 派出的 subagent 在範圍內還有活動的派工：派工本身在範圍前也算（跨午夜）
  // 只認 Agent／Task 的回傳（Bash、grep 查逐字紀錄時，輸出裡也可能出現「agentId: …」——審查者實測）
  const agentCallIds = new Set();
  for (const o of R) for (const b of blocks(o)) if (o.type === 'assistant' && b.type === 'tool_use' && (b.name === 'Agent' || b.name === 'Task')) agentCallIds.add(b.id);
  for (const o of R) for (const b of blocks(o)) {
    if (o.type !== 'user' || b.type !== 'tool_result') continue;
    if (hookDenialTag(b)) deniedIds.add(b.tool_use_id);
    if (b.is_error === true) failedIds.add(b.tool_use_id);
    if (!agentCallIds.has(b.tool_use_id)) continue;
    // 回傳結果帶 agentId（toolUseResult.agentId，或文字裡的「agentId: …」；實測兩處都有）
    const aid = (o.toolUseResult && typeof o.toolUseResult === 'object' && o.toolUseResult.agentId) || (textOf(b).match(/agentId:\s*([\w-]+)/) || [])[1];
    if (aid && lateAgents.has(String(aid))) lateDispatch.add(b.tool_use_id);
  }
  let sawAlign = false; let sawDispatch = false; let approvalBefore = null; let turnEdited = false; let turnStart = null;
  const closeTurn = () => { if (turnEdited) agg.editTurns.push(turnStart); turnEdited = false; };
  let curTs = null;
  for (const o of R) {
    if (o.timestamp) curTs = localDay(o.timestamp);
    const early = since && (!curTs || curTs < since);
    const isLate = (b) => b.type === 'tool_use' && lateDispatch.has(b.id);
    if (early && !blocks(o).some(isLate)) continue;
    if (!o.__mine) continue;
    for (const b of blocks(o)) {
      if (early && !isLate(b)) continue;   // 範圍前的列只看那次跨午夜的派工
      if (o.type === 'user' && b.type === 'text') {
        const t = b.text || '';
        if (/^\[Request interrupted by user/.test(t)) agg.interrupts++;
        else if (/Stop hook feedback/.test(t)) agg.stopFeedback.push({ tag: knownTag((t.match(/\[([^\]]+)\]/) || [])[1]), at: where(f, o) });
        else if (!/^<|^\[|Base directory for this skill|^Caveat:|^Your response above was stopped by a safety classifier/.test(t)) {
          closeTurn(); turnStart = where(f, o);
          agg.userTurns++;
          // 只記出處與命中的詞，不抄使用者原話（原話可能貼了金鑰）；判讀時回原文看
          const cm = t.match(CORRECTION);
          if (cm) agg.corrections.push({ at: where(f, o), keyword: cm[0] });
          // 用一般文字徵求同意也算對齊的線索（實測：「計畫 OK」之後才派工，沒有用選項工具提問）
          if (!sawDispatch && /\bOK\b|同意|沒問題|照做|就這樣|點頭|簽收|就照這個/i.test(t)) approvalBefore = where(f, o);
        }
      }
      if (o.type === 'assistant' && b.type === 'tool_use') {
        const inp = b.input || {};
        if (b.name === 'AskUserQuestion' && !deniedIds.has(b.id)) { agg.askUser++; if (!sawDispatch) sawAlign = true; }
        // 失敗的改檔不算（被 hook 擋下、或工具自己失敗如「String to replace not found」）；還沒有使用者發言時，出處記這次改檔
        if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(b.name) && !failedIds.has(b.id)) { turnEdited = true; if (!turnStart) turnStart = where(f, o); }
        if (b.name === 'Agent' || b.name === 'Task') {
          const type = agentName(String(inp.subagent_type || '').split(':').pop());
          const p = String(inp.prompt || '');
          const d = {
            at: where(f, o), id: b.id, type, model: modelName(inp.model), managed: managed.includes(type),
            hasMustRead: /【開工前必讀】/.test(p),
            mentions: { 'CLAUDE.md': /CLAUDE\.md/.test(p), [GLOSSARY_LABEL]: /GLOSSARY\.md|CONTEXT\.md/.test(p), 'FLOWS.md': /FLOWS\.md/.test(p), 'PROJECT.md': /Project_Detail[\\/]PROJECT\.md/i.test(p) },
            alignedBefore: sawAlign, blocked: deniedIds.has(b.id),
          };
          agg.dispatch.push(d); if (!d.blocked) sess.dispatches++;
          if (!sawDispatch && !d.blocked) {
            // 跨午夜的派工：它之前的對齊線索在範圍前、沒被看過，判斷不了，不可記成沒對齊
            const aligned = early ? '無法判斷（派工在範圍前、對齊線索沒看，回原文確認）'
              : sawAlign ? true : (approvalBefore ? '可能（使用者表示同意：' + approvalBefore + '，回原文確認）' : false);
            agg.firstDispatchAligned.push({ session: sid, aligned, at: d.at });
            sawDispatch = true;
          }
        }
        if (b.name === 'Bash' || b.name === 'PowerShell') {
          const c = String(inp.command || '');
          if (RISKY_CMD.test(c)) agg.riskyCmds.push({ at: where(f, o), tool: b.name, ...cmdShape(c) });
          // 指令裡直接寫了金鑰、密碼、權杖（會跟著指令留在逐字紀錄）；只記出處與種類，不把值抄進報告
          const kinds = SECRET_KINDS.filter(([, re]) => re.test(c)).map(([k]) => k);
          if (kinds.length) agg.secretCmds.push({ at: where(f, o), tool: b.name, kinds });
          if (/flow\.sh[^\n]*\bship\b|\bgit\s+commit\b/.test(c)) agg.commitCmds.push({ at: where(f, o), tool: b.name, via: /flow\.sh/.test(c) ? 'flow.sh ship' : 'git commit' });
        }
      }
      if (o.type === 'assistant' && b.type === 'text') {
        // 只抽固定四欄（詞／鏈／QA／代號），不抄整行
        const s = (b.text || '').match(/--sediment[^\n]*/g);
        if (s) for (const x of s) { const v = {}; for (const m of x.matchAll(/(詞|鏈|QA|代號)=(\S{1,20})/g)) v[m[1]] = sedimentValue(m[2]); agg.sediment.push({ at: where(f, o), ...v }); }
        if (!sawDispatch && /無分岔|已對齊|分流例外/.test(b.text || '')) sawAlign = true;
      }
      if (o.type === 'user') {
        // hook 擋下時：is_error=true，內文以「[標籤]」或「PreToolUse:<工具> hook error: [標籤]」開頭（實測逐字紀錄）
        const tag = hookDenialTag(b);
        if (tag) agg.denials.push({ at: where(f, o), tag, toolUseId: b.tool_use_id });   // 不抄訊息內容（會引用被擋的指令原文）
      }
    }
  }
  closeTurn();
  // subagent：角色、實際 Read 的檔、回報有沒有已讀清單
  const subDir = path.join(tdir, sid, 'subagents');
  let subs = [];
  try { subs = fs.readdirSync(subDir).filter((x) => x.endsWith('.jsonl')); } catch {}
  for (const s of subs) {
    const sf = path.join(subDir, s);
    const SR = rows(sf);
    // 看最後一筆時間：範圍內還有活動的就算（午夜前開、午夜後才讀檔回報的不能被丟掉）；它範圍前的讀檔也算讀了
    const lastTs = ([...SR].reverse().find((o) => o.timestamp) || {}).timestamp || '';
    if (since && lastTs && localDay(lastTs) < since) continue;   // 整段都在範圍前的 subagent 不算
    const subCwds = [...new Set(SR.map((o) => o.cwd).filter(Boolean))];
    if (subCwds.length && !subCwds.some(isMine)) { out.notes.push('略過 cwd 不是這個專案的 subagent：' + sid + '/subagents/' + s); continue; }
    // subagent 紀錄完全沒有 cwd：主對話中途切過別的專案時分不出是誰派的，保守略過
    if (!subCwds.length && otherRows) { out.notes.push('略過沒有 cwd、而主對話切過別的專案的 subagent（分不出屬於哪個專案）：' + sid + '/subagents/' + s); continue; }
    markRows(SR);
    let meta = {}; try { meta = JSON.parse(read(sf.replace(/\.jsonl$/, '.meta.json')) || '{}'); } catch {}
    const type = agentName(String(meta.agentType || '').split(':').pop());
    // Read 要對到成功的結果才算讀了（檔案不存在、權限不足時 tool_result 是 is_error=true）
    const readReq = new Map(); const reads = []; let failedReads = 0; let lastText = '';
    for (const o of SR) {
      if (!o.__mine) continue;
      for (const b of blocks(o)) {
        if (o.type === 'assistant' && b.type === 'tool_use' && b.name === 'Read') readReq.set(b.id, String((b.input || {}).file_path || ''));
        if (o.type === 'user' && b.type === 'tool_result' && readReq.has(b.tool_use_id)) {
          if (b.is_error === true) failedReads++; else reads.push(readReq.get(b.tool_use_id));
        }
        if (o.type === 'assistant' && b.type === 'text') lastText = b.text || lastText;
      }
    }
    const need = requiredReadsFor(type);
    const check = {};
    for (const [name, re] of need) check[name] = reads.some((r) => re.test(r));
    // Claude Code 會把專案 CLAUDE.md 自動載入給 subagent（逐字紀錄裡有「Contents of <專案>\CLAUDE.md」，實測確認），不必另外 Read
    // 只看本專案的列，比對完整路徑（不分大小寫、斜線方向）
    const slash = (x) => x.replace(/[\\/]+/g, '/').toLowerCase();
    const want = 'contents of ' + slash(path.join(root, 'CLAUDE.md'));
    // 路徑後面要是結尾（空白、括號、冒號、換行），CLAUDE.md.backup 之類不算
    const wantRe = new RegExp(want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?=[\\s(:]|$)');
    const strs = (v, acc) => { if (typeof v === 'string') acc.push(v); else if (v && typeof v === 'object') for (const x of Object.values(v)) strs(x, acc); return acc; };
    // 只認 attachment 列：派工 prompt、Grep 結果裡剛好出現這句話不算（審查者實測會誤判）
    // 實測內容在 attachment 列的 rendered[].content；attachment 欄位一併看
    const injected = SR.some((o) => o.__mine && o.type === 'attachment' && strs([o.rendered, o.attachment], []).some((x) => x.length > 20 && wantRe.test(slash(x))));
    for (const [name, re] of need) if (!check[name] && re.test(path.join(root, 'CLAUDE.md')) && injected) check[name] = '自動載入';
    sess.subagents.push({
      file: sid + '/subagents/' + s, type, model: modelName(meta.model), managed: managed.includes(type) || (!hookHasMustRead && !!STANDARD_READS[type]),
      readCount: reads.length, failedReads, requiredReads: check, reportHasReadList: /已讀清單|已讀：|已讀\s*[:：]/.test(lastText),
    });
  }
  out.sessions.push(sess);
}

for (const [f, n] of Object.entries(badLines)) out.notes.push(f + ' 有 ' + n + ' 行解析失敗，已略過（檔案可能還在寫入，或被截斷）');
if (since && since > localDay(new Date())) out.notes.push('--since ' + since + ' 在未來，所以看不到任何 session');
if (!agg.sessions) out.notes.push('範圍內沒有可看的 session：數字全為 0 不代表流程沒起作用，而是沒有資料');

// ── A 自動檢查還活著 ──
out.A.sessionsInRange = agg.sessions;
out.A.sessionsWithHarnessReminder = agg.reminderSessions;
function settingsWiring() {
  const res = [];
  for (const n of ['settings.json', 'settings.local.json']) {
    const t = read(path.join(root, '.claude', n)); if (!t) continue;
    let j; try { j = JSON.parse(t); } catch { res.push({ file: n, error: 'JSON 解析失敗' }); continue; }
    for (const [ev, arr] of Object.entries(j.hooks || {})) for (const g of arr || []) for (const h of g.hooks || []) {
      const cmd = String(h.command || '');
      const m = cmd.match(/"([^"]+\.js)"|'([^']+\.js)'|([^"'\s]+\.js)/);
      const p = m ? (m[1] || m[2] || m[3]).replace('$CLAUDE_PROJECT_DIR', root).replace('${CLAUDE_PROJECT_DIR}', root) : null;
      res.push({ file: n, event: ev, matcher: g.matcher || '', script: p ? rel(path.resolve(root, p)) : '（不是 .js 腳本，原文見 ' + n + '）', exists: p ? fs.existsSync(path.resolve(root, p)) : null });
    }
  }
  return res;
}
out.A.wiring = settingsWiring();
out.A.wiringMissing = out.A.wiring.filter((w) => w.exists === false);
// 規則引擎實際走哪條判定路徑（對應成固定值，不抄原文）：解析器沒完整載入時兩次試跑都會走正則，數字看起來一樣全綠
function parserMode(lines) {
  // 只看狀態行（開頭的「規則引擎判定路徑：」與結尾的 ⚠ 提醒），不看 FAIL 案例的說明文字
  const t = lines.filter((l) => /^(?:規則引擎判定路徑：|⚠ 語法解析器)/.test(l)).join('\n');
  if (/沒有完整載入/.test(t)) return '⚠ 語法解析器沒有完整載入，實際走正則路徑（在實例 .claude/hooks 跑 npm ci 補裝）';
  if (/正則路徑（--parser=off）/.test(t)) return '正則路徑（刻意關掉解析器）';
  if (/語法樹路徑（Bash 與 PowerShell 解析器都已載入）/.test(t)) return '語法樹路徑';
  return '（沒有規則引擎，或 probe 沒印判定路徑）';
}
// 合計行只取數字重組，不抄原文
function probeTotals(l) {
  if (!l) return '（沒有合計行）';
  const n = (k) => (l.match(new RegExp(k + '\\s*(\\d+)')) || [])[1];
  return `PASS ${n('PASS') ?? '?'} / FAIL ${n('FAIL') ?? '?'} / 缺 cases ${n('缺 cases') ?? '?'}` + (n('略過') ? ` / 略過 ${n('略過')}` : '');
}
if (args.includes('--probe')) {
  const hd = path.join(root, '.claude', 'hooks');
  if (fs.existsSync(path.join(hd, 'probe-hooks.js'))) {
    for (const [k, extra] of [['ast', []], ['regex', ['--parser=off']]]) {
      const r = spawnSync(process.execPath, ['probe-hooks.js', ...extra], { cwd: hd, encoding: 'utf8', timeout: 300000 });
      const lines = (r.stdout || '').split('\n');
      out.A['probe_' + k] = { summary: probeTotals(lines.filter((l) => /合計/.test(l)).pop()), parserMode: parserMode(lines), // 只記 hook 名與期望／實得，不抄案例說明（案例裡本來就有假帳密指令）
        fails: lines.filter((l) => /^FAIL/.test(l)).slice(0, 20).map((l) => { const x = l.split(' | '); const m = (x[2] || '').match(/期望 (\S+) 實得 (\S+)/); return { hook: hookFiles.includes(x[1]) ? x[1] : '（不是實例裡的 hook 檔）', expected: m && OUTCOMES.includes(m[1]) ? m[1] : null, got: m && OUTCOMES.includes(m[2]) ? m[2] : null }; }), exit: r.status };
    }
  } else out.A.probe = '實例沒有 probe-hooks.js';
} else out.A.probe = '沒跑：要實際試跑自動檢查加 --probe（會執行實例 .claude/hooks/probe-hooks.js 與它測的 hook）';

// ── B 流程有照走 ──
out.B.dispatchSequenceBySession = out.sessions.map((s) => ({ session: s.id, sequence: agg.dispatch.filter((d) => d.at.startsWith(s.id) && !d.blocked).map((d) => d.type) }));
out.B.firstDispatchAligned = agg.firstDispatchAligned;
out.B.askUserQuestions = agg.askUser;   // 不含被 hook 擋下的提問
out.B.commitCommands = agg.commitCmds;  // 0 筆＝commit 前的審查沒被觸發過，報告寫「沒機會驗證」

// ── C 派工品質 ──
const sent = agg.dispatch.filter((d) => !d.blocked);
const managedDispatch = sent.filter((d) => d.managed);
out.C.dispatchTotal = sent.length;
out.C.dispatchBlockedAttempts = agg.dispatch.filter((d) => d.blocked).map((d) => ({ at: d.at, type: d.type }));
out.C.managedDispatch = managedDispatch.length;
out.C.withoutModel = sent.filter((d) => !d.model).map((d) => d.at);
out.C.managedWithoutMustRead = managedDispatch.filter((d) => !d.hasMustRead).map((d) => ({ at: d.at, type: d.type }));
out.C.denials = agg.denials;
out.C.denialsByTag = agg.denials.reduce((a, d) => (a[d.tag] = (a[d.tag] || 0) + 1, a), {});
out.C.dispatches = agg.dispatch;

// ── D 必讀真的有讀 ──
const allSubs = out.sessions.flatMap((s) => s.subagents);
out.D.subagents = allSubs;
out.D.missingReads = allSubs.filter((s) => Object.values(s.requiredReads).some((v) => !v))
  .map((s) => ({ file: s.file, type: s.type, missing: Object.entries(s.requiredReads).filter(([, v]) => !v).map(([k]) => k) }));
out.D.reportsWithoutReadList = allSubs.filter((s) => s.managed && !s.reportHasReadList).map((s) => ({ file: s.file, type: s.type }));
out.D.note = 'CLAUDE.md 標「自動載入」＝Claude Code 已把專案 CLAUDE.md 放進 subagent 的開頭（逐字紀錄裡有 Contents of …CLAUDE.md），不必另外 Read；其他檔只認實際的 Read。';

// ── E 知識有長出來 ──
out.E.turnsWithEdits = agg.editTurns;   // 主對話用 Edit／Write 改過檔的回合（以使用者發言起算，值是那次發言的出處）
out.E.stopFeedback = agg.stopFeedback;
out.E.sedimentAnswers = agg.sediment;
function knowledge(file) {
  const t = read(path.join(root, file));
  if (t == null) return { file, exists: false };
  const cl = changelogEntries(file);
  return {
    file, exists: true, demoEntriesLeft: (t.match(/（示範）/g) || []).length,
    // 實際讀到紀錄的位置（本體 Changelog 節／<檔名>.changelog.md／同目錄 CHANGELOG.md 的分節），判讀時知道去哪看
    changelogSources: [...new Set(cl.map((e) => e.at.replace(/:\d+$/, '')))],
    // 不算 init 建檔那一行（實測：安裝當天的「建立（harness plugin /harness:init 實例化…）」會被誤算成一筆新知識）
    // 只記日期與行號，不抄內容（筆記可能寫了帳密）；要看內容回原檔
    changelogSince: cl.filter((e) => (!since || e.date >= since) && !INIT_LINE.test(e.line)).map((e) => ({ date: e.date, at: e.at })),
  };
}
// 詞彙表：GLOSSARY.md 優先，沒有才看舊檔名 CONTEXT.md；兩個都沒有時記 GLOSSARY.md（exists: false）
const glossaryFile = ['GLOSSARY.md', 'CONTEXT.md'].find((f) => read(path.join(root, f)) != null) || 'GLOSSARY.md';
out.E.knowledge = [glossaryFile, 'FLOWS.md', 'tests/Project_Detail/PROJECT.md'].map(knowledge);
// 上次健檢：05 的紀錄裡帶【健檢執行】標記、日期最大的一筆，讀法與 health-check-reminder.js 一致——
// .claude/harness/CHANGELOG.md 有 05 那一節就只讀那一節，沒有才讀 05 本體（兩處都讀的話，升級到一半的實例
// 會跟提醒 hook 算出不同的「上次健檢」）
{
  const RAN = /^- \d{4}-\d{2}-\d{2}\s+【健檢執行】/;
  const sharedRel = '.claude/harness/CHANGELOG.md';
  const sharedText = read(path.join(root, sharedRel));
  const sec = sharedText == null ? [] : sectionLines(sharedText, '05-knowledge-protocol.md');
  const hasSection = sharedText != null && sharedText.split('\n').some((l) => l.replace(/\s+$/, '') === '## 05-knowledge-protocol.md');
  const pool = hasSection
    ? sec.filter(({ l }) => DATED.test(l)).map(({ l, i }) => ({ date: l.slice(2, 12), at: sharedRel + ':' + (i + 1), line: l }))
    : changelogEntries('.claude/harness/05-knowledge-protocol.md');
  const runs = pool.filter((e) => RAN.test(e.line));
  const last = runs.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))[0];
  out.E.lastHealthCheck = last ? { date: last.date, at: last.at } : null;
}

// ── F 危險動作 ──
// 危險指令檢查＝guard-risky-command 的 LABEL（交付路徑守門、測試前置條件守門是別的檢查，不算）
const riskyLabel = ((read(path.join(root, '.claude', 'hooks', 'guard-risky-command.js')) || read(path.resolve(__dirname, '..', '..', '..', 'hooks', 'templates', 'guard-risky-command.js')) || '').match(/\bLABEL\s*=\s*['"]([^'"\n]+)['"]/) || [])[1] || '危險指令守門';
out.F.guardDenials = agg.denials.filter((d) => d.tag === riskyLabel);
out.F.riskyLookingCommands = agg.riskyCmds;
out.F.secretsInCommands = agg.secretCmds;
out.F.note = 'riskyLookingCommands 的 hosts 只列專案文件（CLAUDE.md、GLOSSARY.md／CONTEXT.md、FLOWS.md、PROJECT.md、.claude/harness）裡寫過的主機；unknownHosts 是文件沒寫過的主機數，不列名稱（避免把指令裡的值當主機抄出來），逐條照出處回原文看是連到哪裡、該不該擋。';

// ── G 使用者介入 ──
out.G.userTurns = agg.userTurns;
out.G.interrupts = agg.interrupts;
out.G.corrections = agg.corrections;

// ── H 專案概要 ──
const sec0 = claudeMd.match(/^## 0\. 專案概要[\s\S]*?(?=^## |(?![\s\S]))/m);
out.H.hasProjectSummary = !!sec0;
if (sec0) {
  const d = (sec0[0].match(/目前進度[^\n]*?(\d{4}-\d{2}-\d{2})/) || [])[1] || null;
  out.H.progressDate = d;
  out.H.daysSinceProgress = d ? Math.floor((Date.now() - new Date(d + 'T00:00:00')) / 86400000) : null;
  out.H.unconfirmed = /未經使用者確認/.test(sec0[0]);
}

// ── I 版本差距 ──
const pluginRoot = path.resolve(__dirname, '..', '..', '..');
let pluginVersion = null; try { pluginVersion = JSON.parse(read(path.join(pluginRoot, '.claude-plugin', 'plugin.json'))).version; } catch {}
out.I.pluginVersion = pluginVersion;
out.I.features = {
  '專案概要（CLAUDE.md §0，0.5.0）': !!sec0,
  'install-report.md（0.4.0）': fs.existsSync(path.join(root, '.claude', 'harness', 'install-report.md')),
  '流程圖 flow.html（0.4.0）': fs.existsSync(path.join(root, '.claude', 'harness', 'flow.html')),
  '派工檢查擋漏寫必讀檔名（0.5.1）': hookHasMustRead,
  'backend-architect 納管（0.5.1）': !!(markers && (markers['backend-architect'] || !fs.existsSync(path.join(root, '.claude', 'agents', 'backend-architect.md')))),
  // 學習迴路：檔在、而且 settings 有接上觸發 hook 才算有（只複製沒接線等於沒裝）
  '學習迴路（0.16.0）': fs.existsSync(path.join(root, '.claude', 'hooks', 'learn-trigger.js'))
    && ['settings.json', 'settings.local.json'].some((f) => /learn-trigger\.js/.test(read(path.join(root, '.claude', f)) || '')),
  'init 答案檔 init-answers.json（0.16.0）': fs.existsSync(path.join(root, '.claude', 'harness', 'init-answers.json')),
  '健檢提醒看 request 數（0.16.0）': /REQUEST_THRESHOLD/.test(read(path.join(root, '.claude', 'hooks', 'health-check-reminder.js')) || ''),
};
const tplDir = path.join(pluginRoot, 'hooks', 'templates');
const hookDiff = [];
try {
  for (const n of fs.readdirSync(path.join(root, '.claude', 'hooks')).filter((x) => x.endsWith('.js'))) {
    const tp = path.join(tplDir, n); if (!fs.existsSync(tp)) continue;
    // 比較時拿掉 init 填空區（那一段本來就會跟範本不同）
    const strip = (s) => s.replace(/\r\n/g, '\n').replace(/\/\/ ── init 填空區[\s\S]*?\/\/ ─{20,}/, '');
    if (strip(read(tp)) !== strip(read(path.join(root, '.claude', 'hooks', n)))) hookDiff.push(n);
  }
} catch {}
out.I.hooksDifferentFromCurrentTemplate = hookDiff;

// ── J 學習迴路（0.16.0 起）：待核提案、淘汰候選、用量統計、反思有沒有在跑 ──
// 只讀 .claude/harness/learning/ 底下的帳本，不執行學習迴路的任何程式；提案只列主題與出處，不列內容
{
  const ld = path.join(root, '.claude', 'harness', 'learning');
  const rj = (p) => { try { return JSON.parse(read(p)); } catch { return null; } };
  out.J.installed = out.I.features['學習迴路（0.16.0）'];
  if (!fs.existsSync(ld)) out.J.note = out.J.installed ? '學習迴路裝了，但還沒有任何紀錄（learning/ 不存在：還沒觸發過）' : '沒有裝學習迴路';
  else {
    const pending = (rj(path.join(ld, 'pending.json')) || {}).items || [];
    const open = pending.filter((x) => x.status === 'pending');
    out.J.pendingReview = open.filter((x) => x.level === 'yellow').map((x) => ({ id: x.id, topic: x.topic, target: x.target, createdAt: x.createdAt }));
    out.J.pendingApproval = open.filter((x) => x.level === 'red').map((x) => ({ id: x.id, type: x.type, topic: x.topic, target: x.target, evidence: x.evidence, createdAt: x.createdAt }));
    out.J.promotions = out.J.pendingApproval.filter((x) => x.type === 'promotion');
    const runsDir = path.join(ld, 'runs');
    const runs = (fs.existsSync(runsDir) ? fs.readdirSync(runsDir).filter((f) => f.endsWith('.json')) : []).map((f) => rj(path.join(runsDir, f))).filter(Boolean);
    const inRange = runs.filter((r) => !since || String(r.startedAt || '').slice(0, 10) >= since);
    out.J.runs = {
      total: inRange.length,
      calledModel: inRange.filter((r) => !r.skipped).length,
      childFailed: inRange.filter((r) => r.child && r.child.ok === false).length,
      parseFailed: inRange.filter((r) => r.parse && r.parse.ok === false).length,
      landingFailed: inRange.filter((r) => r.landing && r.landing.ok === false).length,
      skipped: inRange.filter((r) => r.skipped).reduce((m, r) => { m[r.skipped] = (m[r.skipped] || 0) + 1; return m; }, {}),
      costUsd: +inRange.reduce((s, r) => s + ((r.child && r.child.costUsd) || 0), 0).toFixed(4),
      written: inRange.reduce((s, r) => s + ((r.results && r.results.written) || 0), 0),
      rejected: inRange.reduce((s, r) => s + ((r.results && r.results.rejected) || 0), 0),
    };
    const usage = rj(path.join(ld, 'usage.json'));
    if (usage) {
      const trialM = (read(path.join(root, '.claude', 'hooks', 'learn-session-report.js')) || '').match(/TRIAL_REQUESTS\s*=\s*(\d+)/);
      const trial = trialM ? Number(trialM[1]) : 200;
      const items = Object.entries(usage.items || {}).map(([k, v]) => ({ key: k, kind: v.kind, view: v.view || 0, use: v.use || 0, since: v.registeredAtRequest || 0 }));
      // ⭐⭐ 以上的 memory 靠自動載入的索引行起作用、不會有 Read，不列淘汰候選
      const memIndex = read(path.join(tdir, 'memory', 'MEMORY.md')) || '';
      const starred = (k) => { const f = k.replace(/^memory:/, ''); return memIndex.split('\n').some((l) => l.includes('(' + f + ')') && /⭐⭐/.test(l)); };
      out.J.usage = {
        requests: usage.requests || 0, trialRequests: trial,
        top: items.sort((a, b) => (b.view + b.use) - (a.view + a.use)).slice(0, 10),
        retireCandidates: items.filter((x) => (x.kind === 'memory' || x.kind === 'skill') && x.view + x.use === 0 && (usage.requests || 0) - x.since >= trial && !(x.kind === 'memory' && starred(x.key))).map((x) => x.key),
        rulesNeverHit: Object.entries(usage.rules || {}).filter(([, v]) => !(v.hits > 0) && (usage.requests || 0) - (v.registeredAtRequest || 0) >= trial).map(([k]) => k),
        ruleHits: Object.entries(usage.rules || {}).filter(([, v]) => v.hits > 0).map(([k, v]) => ({ rule: k, hits: v.hits })),
      };
    }
  }
}

// ── 摘要（給人看；細節在 JSON）──
out.summary = {
  sessions: agg.sessions, userTurns: agg.userTurns,
  dispatch: `${sent.length} 次（專案 agent ${managedDispatch.length}；另有 ${out.C.dispatchBlockedAttempts.length} 次被擋下沒派出去）；沒帶 model ${out.C.withoutModel.length}；專案 agent 沒附【開工前必讀】 ${out.C.managedWithoutMustRead.length}`,
  denials: out.C.denialsByTag,
  mustRead: `${allSubs.length} 個 subagent，少讀必讀檔的 ${out.D.missingReads.length} 個，回報沒有已讀清單的 ${out.D.reportsWithoutReadList.length} 個（對照：${out.D.mustReadSource}）`,
  sediment: `有改檔的回合 ${agg.editTurns.length} 個；Stop 沉澱提醒 ${agg.stopFeedback.length} 次；回答 ${agg.sediment.length} 次`,
  knowledge: out.E.knowledge.map((k) => `${k.file}：${k.exists ? `安裝後異動 ${k.changelogSince.length} 筆、剩示範條目 ${k.demoEntriesLeft}` : '不存在'}`),
  lastHealthCheck: out.E.lastHealthCheck ? `${out.E.lastHealthCheck.date}（${out.E.lastHealthCheck.at}）` : '找不到帶【健檢執行】標記的紀錄',
  risky: `看起來有風險的指令 ${agg.riskyCmds.length} 條（其中連到專案文件沒寫過的主機 ${agg.riskyCmds.filter((x) => x.unknownHosts).length} 條）；危險指令檢查擋下 ${out.F.guardDenials.length} 次`,
  secrets: `指令裡直接寫了金鑰、密碼或權杖 ${agg.secretCmds.length} 處`,
  userSignals: `糾正 ${agg.corrections.length} 次、打斷 ${agg.interrupts} 次`,
  versionGap: Object.entries(out.I.features).filter(([, v]) => !v).map(([k]) => k),
  learning: out.J.note || `反思 ${out.J.runs.total} 次（叫模型 ${out.J.runs.calledModel}、子程序失敗 ${out.J.runs.childFailed}、解析失敗 ${out.J.runs.parseFailed}、花費 ${out.J.runs.costUsd} 美元）；寫入 ${out.J.runs.written} 筆、拒收 ${out.J.runs.rejected} 筆；待你看 ${out.J.pendingReview.length} 筆、待核 ${out.J.pendingApproval.length} 筆（升格提案 ${out.J.promotions.length}）`
    + (out.J.usage ? `；淘汰候選 ${out.J.usage.retireCandidates.length} 筆、從未觸發的規則 ${out.J.usage.rulesNeverHit.length} 條（request 數 ${out.J.usage.requests}，試用期 ${out.J.usage.trialRequests}）` : '；沒有用量紀錄'),
};

out.notes = [...new Set(out.notes)];   // 同一條提醒（例如壞掉的必讀規則）每個 subagent 都會觸發一次
const json = JSON.stringify(redactDeep(out), null, 2);
const dest = opt('--out');
if (dest) { fs.mkdirSync(path.dirname(path.resolve(dest)), { recursive: true }); fs.writeFileSync(dest, json); console.log(JSON.stringify(redactDeep(out.summary), null, 2)); console.log('完整結果：' + path.resolve(dest)); }
else console.log(json);
