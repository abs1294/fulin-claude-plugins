#!/usr/bin/env node
// ledger-diff.js — 讓實例的修正回流帳本（.claude/harness/sync-ledger.md）有機械讀者。
// 帳本是人寫的表格，裡面「X.js 與範本同文」這類主張不會自己過期；這支腳本把帳本裡宣稱同文的檔名抽出來，
// 對實例 .claude/hooks/<檔> 與 plugin hooks/templates/<檔> 跑比對，列出已經漂移的。/harness:review 第 1 步順手跑，
// 結果貼進報告第 9 段「版本差距」前面。
//
// 判準：
// - 只看帳本裡含「同文」「0 行差」「同一份」的句段（以表格格線「|」與全形／半形的分號、逗號切段；頓號「、」不切），
//   段內含「不同文」「同判法」的不算；段內反引號或裸寫的 <名稱>.js 都抽。
//   寫帳本時檔名與「同文」要在同一句（「x.js 與範本同文」），用逗號隔開（「x.js，與範本同文」）會漏抽。
// - 比對忽略行尾 CR，也忽略檔頭 `// harness-wire:`／`// harness-kind:` 標記行（實例接線標記 plugin 範本刻意不帶）。
// - 一檔一行：SAME／DRIFT n 行／只有實例有／只有範本有；有 DRIFT 或缺檔就 exit 1。
//
// 用法：node ledger-diff.js <實例根> [--plugin <plugin harness 根>] [--ledger <帳本路徑>]
//       node ledger-diff.js --self-test
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const MARK = /同文|0 行差|同一份/;
const NOT = /不同文|同判法/;
const FILE_RE = /`?([A-Za-z0-9_.-]+\.js)`?(?![A-Za-z0-9]|\.[A-Za-z0-9])/g;   // 尾端邊界：package.json、foo.js.md、foo.js.bak 都不是 .js 檔
const HEADER_RE = /^\/\/ harness-(wire|kind):/;

function claimedFiles(ledgerText) {
  const out = new Set();
  for (const line of ledgerText.split(/\r?\n/)) {
    if (!line.startsWith('|')) continue;
    // 一格一個主張（第一格寫「同文」不能讓第三格的檔名被抽）；分句用全形與半形的分號、逗號；
    // 頓號「、」是並列連接不切（`a.js、b.js 兩邊同文` 要兩個都抽）
    for (const seg of line.split(/[|；;，,]/)) {
      if (!MARK.test(seg) || NOT.test(seg)) continue;
      for (const m of seg.matchAll(FILE_RE)) out.add(m[1]);
    }
  }
  return [...out].sort();
}

function normalized(p) {
  return fs.readFileSync(p, 'utf8').split(/\r?\n/).filter((l) => !HEADER_RE.test(l));
}

function diffCount(a, b) {
  // 簡單 LCS 行數差（檔案不大，O(n·m) 夠用）；回傳「不在共同子序列裡的行數」＝兩邊加總
  const n = a.length, m = b.length;
  const prev = new Array(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    let diag = 0;
    for (let j = 1; j <= m; j++) {
      const tmp = prev[j];
      prev[j] = a[i - 1] === b[j - 1] ? diag + 1 : Math.max(prev[j], prev[j - 1]);
      diag = tmp;
    }
  }
  const lcs = prev[m];
  return (n - lcs) + (m - lcs);
}

function run(instRoot, pluginRoot, ledgerPath) {
  const ledger = ledgerPath || path.join(instRoot, '.claude', 'harness', 'sync-ledger.md');
  if (!fs.existsSync(ledger)) return { lines: ['（實例沒有 sync-ledger.md，略過）'], bad: 0, files: [] };
  const files = claimedFiles(fs.readFileSync(ledger, 'utf8'));
  const lines = [];
  let bad = 0;
  for (const f of files) {
    const a = path.join(instRoot, '.claude', 'hooks', f);
    const b = path.join(pluginRoot, 'hooks', 'templates', f);
    const ea = fs.existsSync(a), eb = fs.existsSync(b);
    if (!ea && !eb) { lines.push('缺檔  ' + f + '：實例與範本都沒有（帳本點名的檔已不存在）'); bad++; continue; }
    if (!ea) { lines.push('缺檔  ' + f + '：只有範本有（實例 .claude/hooks/ 沒這支）'); bad++; continue; }
    if (!eb) { lines.push('缺檔  ' + f + '：只有實例有（範本 hooks/templates/ 沒這支）'); bad++; continue; }
    const d = diffCount(normalized(a), normalized(b));
    if (d) { lines.push('DRIFT ' + f + '：' + d + ' 行不同（忽略 CR 與 harness-wire／harness-kind 標記行）'); bad++; }
    else lines.push('SAME  ' + f);
  }
  lines.push('合計 帳本宣稱同文 ' + files.length + ' 支：漂移或缺檔 ' + bad + ' 支');
  return { lines, bad, files };
}

function selfTest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-diff-'));
  const inst = path.join(tmp, 'inst'), plug = path.join(tmp, 'plug');
  const w = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
  w(path.join(inst, '.claude', 'hooks', 'a.js'), '// harness-wire: PreToolUse Bash\nconst x = 1;\r\n');
  w(path.join(plug, 'hooks', 'templates', 'a.js'), 'const x = 1;\n');
  w(path.join(inst, '.claude', 'hooks', 'b.js'), 'const y = 1;\nconst z = 2;\n');
  w(path.join(plug, 'hooks', 'templates', 'b.js'), 'const y = 1;\nconst z = 3;\n');
  w(path.join(inst, '.claude', 'hooks', 'c.js'), 'c\n');
  w(path.join(inst, '.claude', 'hooks', 'd.js'), 'd\n');
  w(path.join(plug, 'hooks', 'templates', 'd.js'), 'different\n');
  w(path.join(inst, '.claude', 'harness', 'sync-ledger.md'), [
    '# 帳本', '', '| 項 | 狀態 |', '|---|---|',
    '| `a.js` 與範本同文（diff --strip-trailing-cr 0 行）；b.js 兩邊同文 | 已拿 |',
    '| c.js 與範本同一份 | 已拿 |',
    '| d.js 與範本同判法不同文 | 已拿 |',
    '| e.js 只在實例 | — |',
    '| package.json 與範本同文（不是 .js 檔，不抽） | 已拿 |',
    '| notes.js.md 與範本同文；old.js.bak 同一份（.js 後面還接副檔名，不抽） | 已拿 |',
    '| 這一格說同文 | 第二格的 other.js 不在同一格，不抽 |',
    '| g.js 同文, h.js 不同文; i.js、j.js 兩邊同一份 | 半形逗號與分號切段、頓號不切 |',
    '', '不是表格的這行提到 f.js 同文也不算',
  ].join('\n'));
  let pass = 0, fail = 0;
  const check = (name, cond, extra) => { if (cond) { pass++; console.log('PASS  ' + name); } else { fail++; console.log('FAIL  ' + name + (extra ? '\n      -> ' + extra : '')); } };
  try {
    const files = claimedFiles(fs.readFileSync(path.join(inst, '.claude', 'harness', 'sync-ledger.md'), 'utf8'));
    check('抽檔名：反引號與裸寫都抽；不同文／非表格／非同文句段、跨格、.js 後接副檔名不抽；半形逗號分號切段、頓號不切', JSON.stringify(files) === JSON.stringify(['a.js', 'b.js', 'c.js', 'g.js', 'i.js', 'j.js']), JSON.stringify(files));
    const r = run(inst, plug);
    check('a.js：只差 harness-wire 標記與 CR → SAME', r.lines.some((l) => l === 'SAME  a.js'), r.lines.join(' | '));
    check('b.js：一行不同 → DRIFT 2 行（兩邊各一行）', r.lines.some((l) => /^DRIFT b\.js：2 行不同/.test(l)), r.lines.join(' | '));
    check('c.js：範本沒有 → 缺檔並說是哪邊沒有', r.lines.some((l) => /^缺檔  c\.js：只有實例有/.test(l)), r.lines.join(' | '));
    check('合計行與 bad 計數（b DRIFT、c 缺範本、g／i／j 兩邊都沒有）', r.bad === 5 && /合計 帳本宣稱同文 6 支：漂移或缺檔 5 支/.test(r.lines[r.lines.length - 1]), r.lines.join(' | '));
    const r2 = run(path.join(tmp, 'nope'), plug);
    check('沒有帳本 → 一行略過、bad 0', r2.bad === 0 && /沒有 sync-ledger\.md/.test(r2.lines[0]), r2.lines.join(' | '));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  console.log(fail ? `\n${fail} FAILED（合計 ${pass + fail} 案）` : `\nALL ${pass} PASS`);
  process.exit(fail ? 1 : 0);
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) return selfTest();
  const argValue = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
  const instRoot = args.find((a) => !a.startsWith('--') && a !== argValue('--plugin') && a !== argValue('--ledger'));
  if (!instRoot) { console.error('用法：node ledger-diff.js <實例根> [--plugin <plugin harness 根>] [--ledger <帳本>] | --self-test'); process.exit(2); }
  const pluginRoot = argValue('--plugin') || path.resolve(__dirname, '..', '..', '..');
  const r = run(path.resolve(instRoot), path.resolve(pluginRoot), argValue('--ledger'));
  for (const l of r.lines) console.log(l);
  process.exit(r.bad ? 1 : 0);
}

if (require.main === module) main();
module.exports = { claimedFiles, diffCount, run };
