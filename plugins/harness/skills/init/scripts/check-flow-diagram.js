#!/usr/bin/env node
'use strict';
/**
 * check-flow-diagram.js — 收尾流程圖的完整性閘：init 新增或改過的每一個檔案，都要是圖上的節點。
 *
 * 為什麼要這支：流程圖是模型自己寫的，模型漏畫的東西，它自己回頭看也看不出來
 * （施作與驗證用同一份判準）。這支改用另一個判準：init 動工前先對目標目錄拍快照，
 * 收尾時拿現況跟快照比，**實際新增、修改、刪除的檔案**就是必須上圖的清單——
 * 不寫死要去哪些位置找（寫死的清單會漏掉 init 動到的其他檔，例如 .gitignore、
 * 忘了清的測試殘檔；使用者指出過「不應該寫死，要看有新增或更改的檔案」）。
 *
 * 用法：
 *   node check-flow-diagram.js snapshot <落點目錄>
 *       Phase 0 第一步、動任何檔案之前跑。快照存在系統暫存目錄，以落點路徑區分；
 *       重跑會覆蓋（重新開始一次 init 就重拍）。
 *   node check-flow-diagram.js check <落點目錄> <圖1.json> [<圖2.json> ...]
 *       Phase 6 跑。列出新增／修改／刪除的檔案，逐項確認是某張圖上某個節點的 label
 *       （多張圖合併計算；沒有 archify 時傳退回用的 Markdown 流程表）。
 *       另檢查每張 JSON 圖的每個節點都至少有一條線——沒有線的節點看不出它跟流程哪一步有關
 *       （使用者指出過「知識筆記的讀跟寫都沒有畫出來」）。
 *       也檢查同一張圖裡同一個檔案（agent、hook、文件）只有一個節點。
 *
 * 怎樣算「是節點」：
 *   - JSON：只看 nodes[].label。寫在卡片（cards）、線、sublabel 都不算——卡片是圖外的清單，
 *     看不出它在流程哪一步。Markdown 退回表：整份文字。
 *   - label 含該檔路徑的某個「足以區分」的尾段即可：先試檔名（.js／.md 可省副檔名），
 *     跟其他變動檔撞名時要多帶上層目錄，直到唯一（例：兩個 README.md 就要寫 harness/README.md）。
 *   - 目錄節點：label 以 `/` 結尾（可接說明，例 `hooks/cases/（12 份）`），涵蓋該目錄底下全部變動檔。
 *     這是給同一種用途的一批檔（測試案例、相依套件）用的；每支有各自作用的檔不要用目錄節點帶過。
 *
 * 不列入比對：.git/、快照本身、.harness-backup/（參考模式的備份）、流程圖本身
 *   （.claude/harness/flow.html、flow-N.json／html、flow.md）與收尾回報檔 install-report.md、init 階段狀態檔 .init-state.json、執行測試產生的快取
 *   （__pycache__、.pytest_cache、.mypy_cache、.ruff_cache）——排除的數量照實印出。
 *   node_modules 底下的變動收成一項「<那層>/node_modules/」，要用目錄節點畫。
 *
 * exit 0＝每一項都是節點；exit 1＝有漏（逐項列出）；exit 2＝參數、快照或檔案錯誤。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const SKIP_DIRS = new Set(['.git', '.harness-backup']);
const CACHE_DIRS = new Set(['__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache']);
// 流程圖本身（flow.html、flow-1.json、flow-2.html、flow.md…）與收尾回報檔，是畫圖這一步自己的產出；
// .init-state.json 是 init-flow.js 的階段狀態檔（init 的過程檔，不畫圖）
const isSelfOutput = r => /^\.claude\/harness\/(flow(-\d+)?\.(json|html|md)|install-report\.md|\.init-state\.json)$/.test(r);

const die = (msg, code = 2) => { console.error(msg); process.exit(code); };
const [, , cmd, rootArg, ...diagramArgs] = process.argv;
const USAGE = '用法：\n  node check-flow-diagram.js snapshot <落點目錄>\n  node check-flow-diagram.js check <落點目錄> <圖1.json> [<圖2.json> ...]';
if (!rootArg || !['snapshot', 'check'].includes(cmd) || (cmd === 'check' && !diagramArgs.length)) die(USAGE);

const root = path.resolve(rootArg);
if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) die(`落點不是目錄：${root}`);
// Windows 路徑不分大小寫，其他平台要分
const rootKey = process.platform === 'win32' ? root.toLowerCase() : root;
const snapPath = path.join(os.tmpdir(), 'harness-init-snapshots',
  crypto.createHash('sha1').update(rootKey).digest('hex').slice(0, 16) + '.json');

// 走訪目錄，回傳 { 相對路徑: sha1 }；node_modules 整層收成一個 { 目錄/: 內容雜湊 }
function scan() {
  const files = Object.create(null); // 不用一般物件：檔名 __proto__ 之類不會被原型吃掉
  const unreadable = [];
  let cacheCount = 0;
  const hashFile = p => crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex');
  const hashTree = (dir, treeRel) => {
    const h = crypto.createHash('sha1');
    (function walk(d, rel) {
      let ents;
      try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { unreadable.push(`${treeRel}${rel}/`); return; }
      for (const e of ents.sort((a, b) => a.name.localeCompare(b.name))) {
        const r = `${rel}/${e.name}`;
        if (e.isDirectory()) walk(path.join(d, e.name), r);
        else if (e.isFile()) { try { h.update(r).update(hashFile(path.join(d, e.name))); } catch { unreadable.push(`${treeRel}${r}`); } }
      }
    })(dir, '');
    return h.digest('hex');
  };
  (function walk(dir, rel) {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { unreadable.push((rel || '.') + '/'); return; }
    for (const e of ents) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        if (CACHE_DIRS.has(e.name)) { cacheCount++; continue; }
        if (e.name === 'node_modules') { files[`${r}/`] = hashTree(full, r); continue; }
        walk(full, r);
      } else if (e.isFile()) {
        if (isSelfOutput(r)) continue;
        try { files[r] = hashFile(full); } catch { unreadable.push(r); }
      }
    }
  })(root, '');
  return { files, cacheCount, unreadable };
}

if (cmd === 'snapshot') {
  const { files, unreadable } = scan();
  fs.mkdirSync(path.dirname(snapPath), { recursive: true });
  fs.writeFileSync(snapPath, JSON.stringify({ root, takenAt: new Date().toISOString(), files, unreadable }));
  if (unreadable.length) {
    console.log(`注意：有 ${unreadable.length} 個檔案或目錄讀不到，快照裡沒有它們，收尾比對時會被當成「無法判斷」列出：`);
    for (const u of unreadable) console.log(`  - ${u}`);
  }
  console.log(`已拍快照：${root}（${Object.keys(files).length} 個檔）\n存在：${snapPath}`);
  process.exit(0);
}

// ---- check ----
let snap;
try { snap = JSON.parse(fs.readFileSync(snapPath, 'utf8')); }
catch { die(`找不到這個落點的快照（${snapPath}）。快照要在 Phase 0 動任何檔案之前拍：\n  node check-flow-diagram.js snapshot "${root}"\n事後補拍沒有意義——那時 init 的改動已經在裡面了，比不出差異。`); }

const labels = [];
const isolated = []; // { file, id, label }
const duplicated = []; // { file, label, ids }
for (const f of diagramArgs) {
  let raw;
  try { raw = fs.readFileSync(f, 'utf8'); } catch (e) { die(`讀不到：${f}\n${e.message}`); }
  let d;
  if (!/\.json$/i.test(f)) { labels.push(raw); continue; } // Markdown 退回表：整份文字
  try { d = JSON.parse(raw); } catch (e) { die(`圖的 JSON 解析失敗：${f}\n${e.message}`); }
  if (!d || !Array.isArray(d.nodes) || !Array.isArray(d.edges)) die(`圖的 JSON 缺少 nodes 或 edges 陣列：${f}`);
  const hasId = n => (typeof n.id === 'string' && n.id !== '') || typeof n.id === 'number';
  const nodes = d.nodes.filter(n => n && typeof n === 'object');
  for (const n of nodes.filter(n => !hasId(n)))
    isolated.push({ file: path.basename(f), id: '（缺少 id）', label: n.label });
  const ids = new Set(nodes.filter(hasId).map(n => n.id));
  // 只算兩端都是存在節點的線；指向不存在節點的線不能讓節點看起來「有線」
  const edges = d.edges.filter(e => e && ids.has(e.from) && ids.has(e.to));
  for (const e of d.edges.filter(e => !e || !ids.has(e.from) || !ids.has(e.to)))
    isolated.push({ file: path.basename(f), id: e ? `${e.from}→${e.to}` : 'null', label: '（線的兩端有不存在的節點）' });
  const withId = nodes.filter(hasId).length;
  if (ids.size !== withId)
    isolated.push({ file: path.basename(f), id: '（id 重複）', label: `${withId} 個節點只有 ${ids.size} 個不同 id` });
  const seen = new Map();
  for (const n of nodes) {
    labels.push(String(n.label || ''));
    if (hasId(n) && !edges.some(e => e.from === n.id || e.to === n.id))
      isolated.push({ file: path.basename(f), id: n.id, label: n.label });
    // 檔名／角色名（英數、點、斜線、連字號組成）在同一張圖只能有一個節點：
    // 同一支 agent 畫兩個節點，讀者會以為是兩個角色（實際回饋：設計與實作各畫一個 backend-engineer，
    // 被看成專案裡有後端架構師）。同一個角色做兩步，用一來一回的線表示。
    const key = String(n.label || '').trim();
    if (/^[\w.\-\/]+$/.test(key) && /[.\-\/]/.test(key)) {
      if (seen.has(key)) duplicated.push({ file: path.basename(f), label: key, ids: [seen.get(key), n.id] });
      else seen.set(key, n.id);
    }
  }
}

const { files: now, cacheCount, unreadable: nowUnreadable } = scan();
const before = snap.files;
// 兩次掃描任一次讀不到的路徑（含目錄底下所有檔）都無法判斷，不列為新增或刪除，另外列出
const unreadable = [...new Set([...(snap.unreadable || []), ...nowUnreadable])];
const isUnknown = p => unreadable.some(u =>
  p === u ||
  (u.endsWith('/') && (u === './' || p.startsWith(u))) ||   // 讀不到的目錄底下的檔
  (p.endsWith('/') && u.startsWith(p)));                    // node_modules/ 這類彙總項，其下有讀不到的
const changes = [];
for (const [p, h] of Object.entries(now)) {
  if (isUnknown(p)) continue;
  if (!Object.prototype.hasOwnProperty.call(before, p)) changes.push({ p, kind: '新增' });
  else if (before[p] !== h) changes.push({ p, kind: '修改' });
}
for (const p of Object.keys(before))
  if (!Object.prototype.hasOwnProperty.call(now, p) && !isUnknown(p)) changes.push({ p, kind: '刪除' });
changes.sort((a, b) => a.p.localeCompare(b.p));

// 目錄節點：label 裡以 / 結尾的路徑片段
const dirNodes = [];
for (const l of labels)
  for (const m of l.matchAll(/([\w.\-\u0080-￿/]+\/)(?=[\s（(]|$)/g)) dirNodes.push(m[1]);
const coveredByDir = c => dirNodes.find(d => c.p === d || c.p.startsWith(d) || c.p.includes(`/${d}`));

// 其餘逐檔：找出足以區分的最短尾段
const rest = changes.filter(c => !coveredByDir(c));
const suffixes = p => {
  const seg = p.replace(/\/$/, '').split('/');
  const out = [];
  for (let i = seg.length - 1; i >= 0; i--) out.push(seg.slice(i).join('/') + (p.endsWith('/') ? '/' : ''));
  return out; // 由短到長
};
const stem = p => /\.(js|md)$/.test(p) ? path.basename(p).replace(/\.(js|md)$/, '') : null;
const allSuffixes = rest.map(c => new Set([...suffixes(c.p), stem(c.p)].filter(Boolean)));
// 名稱前後不能緊接英數字、連字號、點、底線：foobar.js 不算涵蓋 bar.js
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const inLabels = s => labels.some(l => new RegExp('(^|[^\\w.\\-])' + escRe(s) + '(?![\\w\\-]|\\.\\w)').test(l));
const missing = [];
rest.forEach((c, i) => {
  const unique = s => allSuffixes.every((set, j) => j === i || !set.has(s));
  const cands = [stem(c.p), ...suffixes(c.p)].filter(Boolean);
  const ok = cands.filter(unique);
  if (!ok.some(inLabels)) missing.push({ ...c, need: ok[0] || c.p });
});

const count = k => changes.filter(c => c.kind === k).length;
console.log(`落點：${root}\n快照時間：${snap.takenAt}`);
console.log(`init 之後的變動：新增 ${count('新增')}、修改 ${count('修改')}、刪除 ${count('刪除')}，共 ${changes.length} 項${cacheCount ? `（另排除執行測試產生的快取目錄 ${cacheCount} 個）` : ''}`);
for (const c of changes) {
  const d = coveredByDir(c);
  console.log(`  ${c.kind}  ${c.p}${d ? `　← 目錄節點 ${d}` : ''}`);
}
if (unreadable.length) {
  console.log(`\n有 ${unreadable.length} 個檔案或目錄讀不到（被鎖住或沒權限），這次沒比對到，請確認後重跑：`);
  for (const u of unreadable) console.log(`  - ${u}`);
}
if (isolated.length) {
  console.log(`\n有 ${isolated.length} 個節點沒有任何線（要畫出它跟哪一步是什麼關係：讀、寫、擋、觸發、載入，線上標字）：`);
  for (const x of isolated) console.log(`  - ${x.file}：${x.label}（id ${x.id}）`);
}
if (duplicated.length) {
  console.log(`
有 ${duplicated.length} 個檔案在同一張圖畫了兩個節點（讀者會以為是兩個不同的東西；同一個角色做兩步，用一來一回的線表示）：`);
  for (const x of duplicated) console.log(`  - ${x.file}：${x.label}（id ${x.ids.join('、')}）`);
}
if (!missing.length && !isolated.length && !duplicated.length && !unreadable.length) { console.log('每一項都是圖上的節點，每個節點都有線。'); process.exit(0); }
if (!missing.length) process.exit(1);
console.log(`\n有 ${missing.length} 項不是圖上的節點（各自畫成一個節點、label 含右邊的名稱，放在它起作用那一步的直欄；只寫在卡片、線或 sublabel 不算。不該留下的殘檔就刪掉，不要畫上去）：`);
for (const m of missing) console.log(`  - ${m.kind}  ${m.p}　→ label 要含：${m.need}`);
process.exit(1);
