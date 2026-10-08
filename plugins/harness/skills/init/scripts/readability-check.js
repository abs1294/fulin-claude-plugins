#!/usr/bin/env node
'use strict';
/**
 * readability-check.js — init 交給使用者看的東西，交付前的易讀性自檢。
 *
 * 掃什麼：Phase 6 的流程圖 JSON（標題、泳道、階段、節點、線、卡片的全部文字）與收尾回報
 *   （`.claude/harness/install-report.md`）。讀者是第一次用 harness 的人（實際回饋：流程圖寫
 *   「派工缺欄位」，第一次用的人根本不知道是什麼意思）。
 *
 * 規則依據是 deliver-report plugin 的 references/document-readability.md（十四條鐵則）。
 * deliver-report 自己的機械閘只掃 .docx、且只在調用它的回合啟動，掃不到 init 的產出，
 * 所以在這裡對 init 的產出跑它「機器判得準」的部分，再加上 harness 自己的內部用語表：
 *   - 鐵則 3 編號連續：Markdown 的「N.」清單不得缺號、不得小數點
 *   - 鐵則 4 未定義代號：§N、#N、B23／A-1 這類字母加數字、Q2、「B 類」
 *   - 鐵則 5 異動紀錄用語：取 deliver-report 的 banned-patterns.json（revision_history）
 *   - 內部用語：本 plugin 的 plain-language-terms.json
 * 其餘鐵則（兩邊對照、資訊放一起、能查的自己查、長度重複、做完寫成做完…）機器判不準，
 * 由模型讀完那份文件後逐條自檢——本腳本最後會列出來提醒。
 *
 * 沒裝 deliver-report：不掃，exit 3，並印出安裝指令（非互動 CLI，使用者同意後 Claude 可直接執行）。
 *
 * 用法：node readability-check.js <落點目錄> <檔案…>
 *   檔案：flow-1.json…（archify 圖）、install-report.md（收尾回報）
 * exit 0＝通過；1＝有問題（逐項列出）；2＝參數錯誤；3＝沒裝 deliver-report，已跳過。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const [, , rootArg, ...files] = process.argv;
if (!rootArg || !files.length) {
  console.error('用法：node readability-check.js <落點目錄> <flow-1.json|install-report.md …>');
  process.exit(2);
}
const root = path.resolve(rootArg);
const HOME = os.homedir();
const readJson = p => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const norm = p => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p)); // Windows 路徑不分大小寫

// ---- 找 deliver-report：installed_plugins.json 有這個落點看得到的安裝紀錄，且沒被停用 ----
function findDeliverReport() {
  const inst = readJson(path.join(HOME, '.claude', 'plugins', 'installed_plugins.json'));
  if (!inst) return null;
  const table = inst.plugins || inst;
  const settingsFiles = [
    path.join(HOME, '.claude', 'settings.json'),
    path.join(root, '.claude', 'settings.json'),
    path.join(root, '.claude', 'settings.local.json'),
  ];
  for (const [key, entries] of Object.entries(table)) {
    if (!/^deliver-report@/.test(key) || !Array.isArray(entries)) continue;
    // 任一層 settings 明確設 false＝停用（後面的層覆蓋前面的）
    let enabled = true;
    for (const f of settingsFiles) {
      const s = readJson(f);
      if (s && s.enabledPlugins && key in s.enabledPlugins) enabled = s.enabledPlugins[key] !== false;
    }
    if (!enabled) continue;
    for (const e of entries) {
      if (!e || typeof e !== 'object') continue;
      const base = e.projectPath ? norm(e.projectPath) : null;
      const visible = e.scope === 'user' ||
        (base && (norm(root) === base || norm(root).startsWith(base.endsWith(path.sep) ? base : base + path.sep)));
      const ref = e.installPath && path.join(e.installPath, 'references', 'document-readability.md');
      if (visible && ref && fs.existsSync(ref)) return { key, dir: e.installPath, ref, version: e.version };
    }
  }
  return null;
}

const dr = findDeliverReport();
if (!dr) {
  console.log([
    '沒有找到可用的 deliver-report plugin（這個專案看得到、且沒被停用的安裝紀錄），跳過交付前易讀性自檢。',
    '請在收尾回報告訴使用者：',
    '  「交給你看的流程圖與這份回報，原本會用 deliver-report 的易讀性規則自檢（避免內部用語、沒解釋的代號）。',
    '   這台機器沒裝，這次跳過了。要裝的話跟我說，我可以幫你裝。」',
    '（安裝指令：claude plugin install deliver-report@fulin-plugins --scope project（在這個專案目錄下跑）——非互動 CLI，使用者同意後 Claude 可直接執行；',
    '  裝完要使用者自己 /reload-plugins 或重開 session 才生效。）',
  ].join('\n'));
  process.exit(3);
}

// ---- 規則來源 ----
const termsFile = path.join(__dirname, '..', 'plain-language-terms.json');
const terms = (readJson(termsFile) || { terms: [] }).terms;
const banned = readJson(path.join(dr.dir, 'references', 'banned-patterns.json'));
const revisionLiterals = (banned && banned.revision_history && banned.revision_history.literals) ||
  ['本次查核', '本文件初版', '原文件', '上一版', '第 N 輪', '本次清點'];

// ---- 取出要掃的文字：[{ where, text, isLabel }] ----
function textsOf(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const base = path.basename(file);
  let d = null;
  try { d = JSON.parse(raw); } catch { /* Markdown */ }
  const out = [];
  if (d && typeof d === 'object') {
    const m = d.meta || {};
    if (m.title) out.push({ where: `${base} 標題`, text: m.title });
    if (m.subtitle) out.push({ where: `${base} 副標`, text: m.subtitle });
    for (const l of (d.lanes || []).filter(Boolean)) out.push({ where: `${base} 泳道`, text: l.label });
    for (const p of (d.phases || []).filter(Boolean)) out.push({ where: `${base} 階段`, text: p.label });
    for (const n of (d.nodes || []).filter(Boolean)) {
      out.push({ where: `${base} 節點 ${n.id}`, text: n.label, isLabel: true });
      if (n.sublabel) out.push({ where: `${base} 節點 ${n.id} 小字`, text: n.sublabel });
      if (n.tag) out.push({ where: `${base} 節點 ${n.id} 標籤`, text: n.tag });
    }
    for (const e of (d.edges || []).filter(Boolean)) if (e.label) out.push({ where: `${base} 線 ${e.from}→${e.to}`, text: e.label });
    for (const c of (d.cards || []).filter(Boolean)) {
      out.push({ where: `${base} 卡片`, text: c.title });
      for (const it of c.items || []) out.push({ where: `${base} 卡片`, text: it });
    }
    return { kind: 'json', out };
  }
  let fence = null;
  raw.split(/\r?\n/).forEach((line, i) => {
    const fm = openFence(line);
    if (fm) {
      if (!fence) { fence = fm[1]; return; }
      if (fm[1][0] === fence[0] && fm[1].length >= fence.length && !line.trim().slice(fm[1].length).trim()) { fence = null; return; }
    }
    if (!fence) out.push({ where: `${base} 第 ${i + 1} 行`, text: line });
  });
  return { kind: 'md', out, raw };
}

// Markdown 圍欄：``` 或 ~~~ 開頭；反引號圍欄那一行後面不能再有反引號，否則是行內程式碼（```npm ci```）
function openFence(line) {
  const m = line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
  if (!m) return null;
  if (m[1][0] === '`' && m[2].includes('`')) return null;
  return m;
}

// 檔名、路徑、指令、反引號內的東西不掃
const stripCode = (s, { keepKebab = false } = {}) => keepKebab
  ? String(s || '')
    .replace(/`[^`]*`/g, ' ')
    .replace(/[\w.\-]*[\\/][\w.\-\\/]*/g, ' ')
    .replace(/\b[\w\-]+\.(md|js|json|html|txt|yml|yaml|py|sh|ps1)\b/g, ' ')
  : String(s || '')
  .replace(/`[^`]*`/g, ' ')
  .replace(/[\w.\-]*[\\/][\w.\-\\/]*/g, ' ')              // 路徑
  .replace(/\b[\w\-]+\.(md|js|json|html|txt|yml|yaml|py|sh|ps1)\b/g, ' ') // 檔名
  .replace(/\b[a-z]+(?:-[a-z]+)+\b/g, ' ');                // kebab-case 名稱（hook、agent 檔名）
const looksLikeFileLabel = s => /^[\w.\-\/（）() ]+$/.test(s) && /[.\-\/]/.test(s);

const problems = [];
for (const f of files) {
  let r;
  try { r = textsOf(f); } catch (e) { console.error(`讀不到：${f}（${e.message}）`); process.exit(2); }
  for (const { where, text, isLabel } of r.out) {
    if (isLabel && looksLikeFileLabel(text)) continue; // 節點名稱是檔名時（完整性檢查要求的）不掃
    const s = stripCode(text);
    // 鐵則 4 代號
    const codes = s.match(/§\s*\S+|#\d+|\b[A-Z]{1,2}-?\d{1,3}\b|\bQ\d\b|[A-E]\s?類/g);
    if (codes) problems.push(`${where}：出現代號 ${[...new Set(codes)].join('、')}——改成白話（鐵則 4）｜${text}`);
    // 鐵則 5 異動紀錄
    for (const lit of revisionLiterals) if (s.includes(lit)) problems.push(`${where}：異動紀錄用語「${lit}」——只寫現況（鐵則 5）｜${text}`);
    // 內部用語
    // 有連字號的詞（dry-run）要在還沒拿掉 kebab-case 名稱的版本上比對，否則永遠比不到
    const sKeepKebab = stripCode(text, { keepKebab: true });
    for (const t of terms) {
      const body = t.term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // 英文詞前後不能緊接英文字母（gateway 不算 gate）；中文詞沒有字界問題
      const re = /^[A-Za-z]/.test(t.term)
        ? new RegExp('(?<![A-Za-z])' + body + '(?![A-Za-z])(?!（)', 'g')
        : new RegExp(body + '(?!（)', 'g'); // 英文詞分大小寫：CONTEXT.md 這類檔名不是內部用語 context
      if (re.test(t.term.includes('-') ? sKeepKebab : s)) problems.push(`${where}：內部用語「${t.term}」——改說「${t.say}」｜${text}`);
    }
  }
  // 鐵則 3 編號連續（Markdown）
  if (r.kind === 'md') {
    // 程式碼框內不算清單；空行不打斷清單（Markdown 允許項目之間留空行），只有其他頂層內容才算清單結束
    let expect = null, blockStart = 0, fence = null;
    r.raw.split(/\r?\n/).forEach((line, i) => {
      const fm = openFence(line);
      if (fm) {
        if (!fence) { fence = fm[1]; return; }
        if (fm[1][0] === fence[0] && fm[1].length >= fence.length && !line.trim().slice(fm[1].length).trim()) { fence = null; return; }
      }
      if (fence || !line.trim()) return;
      const m = line.match(/^(\s*)(\d+(?:\.\d+)?)\.\s/);
      if (!m || m[1].length) { if (!/^\s+\S/.test(line)) expect = null; return; }
      if (m[2].includes('.')) { problems.push(`${path.basename(f)} 第 ${i + 1} 行：小數點編號 ${m[2]}（鐵則 3）`); return; }
      const n = parseInt(m[2], 10);
      if (expect === null) { expect = n + 1; blockStart = i + 1; if (n !== 1) problems.push(`${path.basename(f)} 第 ${i + 1} 行：清單從 ${n} 開始（鐵則 3）`); return; }
      if (n !== expect) problems.push(`${path.basename(f)} 第 ${i + 1} 行：編號 ${n}，前一項之後應是 ${expect}（第 ${blockStart} 行起的清單，鐵則 3）`);
      expect = n + 1;
    });
  }
}

console.log(`規則依據：${dr.ref}（deliver-report ${dr.version || ''}）`);
if (problems.length) {
  console.log(`\n有 ${problems.length} 處要改（改完整份重跑，不要只改被點到的那一處）：`);
  for (const p of problems) console.log(`  - ${p}`);
}
console.log([
  '',
  '機器判不準、要你讀完上面那份規則後逐條自檢的：',
  '  1 讀者要不要兩邊對照才看得懂（例：圖上只有代號，意思寫在別處）',
  '  2 同一件事的資訊是不是放在一起',
  '  6 有沒有「待確認」其實你自己查得到',
  '  7 有沒有重複、太長',
  ' 12 做完的寫成做完；做不到的講清楚是環境所限還是沒做',
  ' 13 內部推導過程（試了幾次、改了什麼）不寫進給使用者的東西',
].join('\n'));
if (problems.length) process.exit(1);
console.log('\n機器可判的部分通過。');
process.exit(0);
