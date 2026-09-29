#!/usr/bin/env node
/**
 * visual-view-gate — deliver-report plugin 的 Stop hook：視覺檢查的每一張畫面都要被打開看過。
 *
 * 為什麼要這支：check-before 的視覺檢查（visual_check.py）只能機械抓「字形互相壓到」「字跑出方塊」
 * 這類判得準的問題；SmartArt、文字轉外框、圖片裡的字這類疊字，只有看圖才抓得到。
 * SKILL.md 寫「每張都要看」是自律，AI 會只看總覽或只看有紅框的那幾張——所以用 hook 他律。
 *
 * 判準：本回合（最後一則使用者輸入之後）的工具輸出裡出現視覺檢查清單
 *   （check_doc.js／visual_check.py 印的「VISUAL_MANIFEST: <路徑>」，或 --json 輸出的 "manifest" 欄位），
 *   清單列出的每一張 page-NNN.png，都要在「清單出現之後」有一次 Read 工具呼叫。
 *   同一份原始檔在本回合跑了多次，只認最後一次的清單（改完重跑，舊圖不必再看）。
 *   總覽圖 overview.png 不算數，也不要求——縮圖看不出細微疊字。
 *
 * 不涵蓋：subagent 裡跑的檢查（它的輸出在另一份 transcript，主對話看不到）。
 *
 * ★ FAIL-OPEN：transcript 讀不到、清單讀不到、解析失敗 → 放行。這支只防「跳過看圖」，不是沙箱。
 */
const fs = require('fs');
const path = require('path');

let stdinData = '';
process.stdin.on('data', (c) => (stdinData += c));
process.stdin.on('end', () => {
  try { main(stdinData); } catch (_) { allow(); }
});

function allow() { process.exit(0); }
function block(reason) {
  try { process.stdout.write(JSON.stringify({ decision: 'block', reason }), () => process.exit(0)); } catch (_) { allow(); }
}
const NL = String.fromCharCode(10);

function main(raw) {
  let payload = {};
  try { payload = JSON.parse(raw || '{}'); } catch (_) { return allow(); }
  const tp = payload.transcript_path;
  if (!tp) return allow();
  let lines;
  try { lines = fs.readFileSync(tp, 'utf8').split('\n'); } catch (_) { return allow(); }

  // 本回合起點：最後一則真正的使用者輸入（判準同 doc-readability-gate.js 的 isUserPromptLine）
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i]) continue;
    let o;
    try { o = JSON.parse(lines[i]); } catch (_) { continue; }
    if (isUserPromptLine(o)) { start = i; break; }
  }
  if (start < 0) return allow();

  // 快篩：本回合完全沒有視覺檢查清單就直接放行（大部分回合走這條，不逐行 parse）
  const turnRaw = lines.slice(start + 1).join('\n');
  if (turnRaw.indexOf('VISUAL_MANIFEST') === -1 && turnRaw.indexOf('visual-manifest.json') === -1) return allow();

  const manifests = new Map();   // 原始檔 → { manifest 路徑, 行號 }
  const reads = [];              // { file: 正規化路徑, at: 行號 }
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (!l) continue;
    let o;
    try { o = JSON.parse(l); } catch (_) { continue; }
    if (!o || typeof o !== 'object' || o.isSidechain === true) continue;
    const c = o.message && o.message.content;
    if (Array.isArray(c)) {
      for (const b of c) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'tool_use' && b.name === 'Read' && b.input && typeof b.input.file_path === 'string') {
          reads.push({ file: norm(b.input.file_path), at: i });
        }
        if (b.type === 'tool_result') {
          for (const t of textsOf(b.content)) for (const m of manifestPaths(t)) addManifest(manifests, m, i);
        }
      }
    }
    if (o.toolUseResult && typeof o.toolUseResult === 'object') {
      for (const k of ['stdout', 'output']) {
        if (typeof o.toolUseResult[k] === 'string') for (const m of manifestPaths(o.toolUseResult[k])) addManifest(manifests, m, i);
      }
    }
  }
  if (!manifests.size) return allow();

  const missing = [];
  let total = 0;
  for (const { manifest, at, data } of manifests.values()) {
    const imgs = (data.images || []).filter((p) => typeof p === 'string');
    total += imgs.length;
    const seen = new Set(reads.filter((r) => r.at > at).map((r) => r.file));
    for (const im of imgs) if (!seen.has(norm(im))) missing.push({ src: data.file, im });
  }
  if (!missing.length) return allow();

  const out = [`【視覺檢查】還有 ${missing.length} 張畫面沒打開看過（本回合共 ${total} 張）。`,
    '機械判定只抓得到字形互相壓到、字跑出方塊；SmartArt、圖片裡的字、文字轉外框的疊字要看圖才知道。',
    '請用 Read 逐張打開以下圖片，每張寫下看到什麼（有沒有疊字、被切掉、空白），再結束：', ''];
  for (const m of missing.slice(0, 40)) out.push('   ' + m.im);
  if (missing.length > 40) out.push(`   …另 ${missing.length - 40} 張（同一資料夾的 page-*.png）`);
  block(out.join(NL));
}

function addManifest(map, p, at) {
  let data;
  try { data = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return; }   // 清單讀不到 → 不要求（fail-open）
  if (!data || !Array.isArray(data.images)) return;
  const key = norm(data.file || p);
  const prev = map.get(key);
  if (!prev || prev.at <= at) map.set(key, { manifest: p, at, data });
}

function textsOf(content) {
  if (typeof content === 'string') return [content];
  if (Array.isArray(content)) return content.filter((x) => x && typeof x.text === 'string').map((x) => x.text);
  return [];
}

function manifestPaths(text) {
  const out = [];
  for (const m of text.matchAll(/VISUAL_MANIFEST: ([^\r\n]+?visual-manifest\.json)/g)) out.push(m[1].trim());
  // --json 模式：路徑在 JSON 字串裡（反斜線被跳脫），用 JSON.parse 還原
  for (const m of text.matchAll(/"manifest":\s*("(?:[^"\\]|\\.)*visual-manifest\.json")/g)) {
    try { out.push(JSON.parse(m[1])); } catch (_) { /* 略過 */ }
  }
  return out;
}

function norm(p) {
  let r = path.resolve(String(p).trim());
  if (process.platform === 'win32') r = r.replace(/\//g, '\\').toLowerCase();
  return r;
}

function isUserPromptLine(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
  if (o.type !== 'user' || !o.promptId) return false;
  if ('toolUseResult' in o) return false;
  if (o.isSidechain === true) return false;
  return true;
}
