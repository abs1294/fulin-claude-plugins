#!/usr/bin/env node
/**
 * check_doc.js — deliver-report plugin 的交付前自檢 CLI（四個 subskill 的自檢步驟都呼叫這支）。
 *
 * 用法：node check_doc.js <檔案路徑或檔名> [--root <搜尋根目錄>] [--json]
 *   - 給路徑：直接用。
 *   - 只給檔名（可省略副檔名）：在 --root（預設目前目錄）底下往下找，最多 6 層，
 *     跳過 node_modules/.git 等目錄。找到多份 → 列出候選、exit 2，由呼叫端請使用者指定。
 *   - 支援 .docx / .md / .markdown / .txt / .pdf（pdf 需 Python + pypdf 抽文字）。
 *
 * 判準全部在 hooks/lib/readability-scan.core.js 的 scanFile()——與 Stop hook 同一份，這裡只負責找檔與輸出。
 *
 * exit code：0 通過（可能有提醒）、1 有硬缺陷、2 找不到檔／多份候選／讀不到內容。
 * ★ 與 Stop hook 相反，這裡**不 fail-open**：使用者點名要檢查，讀不到就明講讀不到，不可回報通過。
 */
const fs = require('fs');
const path = require('path');
const core = require(path.join(__dirname, '..', '..', '..', 'hooks', 'lib', 'readability-scan.core.js'));

const NL = String.fromCharCode(10);
const SKIP_DIRS = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__', 'dist', 'build', '.next']);

function die(code, msg) { process.stdout.write(msg + NL); process.exit(code); }

// ---------- 參數 ----------
const args = process.argv.slice(2);
let target = null, root = process.cwd(), asJson = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--root') root = args[++i];
  else if (args[i] === '--json') asJson = true;
  else if (!target) target = args[i];
}
if (!target) die(2, '用法：node check_doc.js <檔案路徑或檔名> [--root <目錄>] [--json]');

// ---------- 找檔 ----------
function resolveTarget(t) {
  if (fs.existsSync(t) && fs.statSync(t).isFile()) return [path.resolve(t)];
  // 給的是路徑（含目錄分隔）卻不存在 → 直接判找不到；退回用檔名去別處搜，會檢查到另一份同名文件
  if (/[\\/]/.test(t)) return [];
  const want = path.basename(t).toLowerCase();
  const hasExt = core.SUPPORTED.includes(path.extname(want));
  const out = [];
  (function walk(dir, depth) {
    if (depth > 6 || out.length > 20) return;
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(p, depth + 1); continue; }
      const n = e.name.toLowerCase();
      if (n.startsWith('~$') || n.endsWith('.bak')) continue;
      const ext = path.extname(n);
      if (!core.SUPPORTED.includes(ext)) continue;
      if (hasExt ? n === want : n.slice(0, -ext.length) === want) out.push(p);
    }
  })(path.resolve(root), 0);
  return out;
}

let found;
// 找檔階段的例外（權限不足、existsSync 之後檔案被刪等）同樣是「讀不到」＝ exit 2
try { found = resolveTarget(target); }
catch (e) { die(2, `讀取失敗（${e.code || e.name}）：${String(e.message).split(NL)[0]}：${target}`); }
if (!found.length) die(2, `找不到檔案：${target}（搜尋根目錄 ${path.resolve(root)}，支援 ${core.SUPPORTED.join(' ')}）`);
if (found.length > 1) die(2, `「${target}」有 ${found.length} 份候選，請指定完整路徑：${NL}` + found.map(f => '  ' + f).join(NL));
const file = found[0];

let r;
try { r = core.scanFile(file); }
catch (e) {
  // 任何讀檔失敗（含權限不足、檔案被鎖）都是「讀不到」＝ exit 2，不可落成 exit 1 被當成「有缺陷但讀過了」
  if (e instanceof core.ReadError) die(2, `${e.message}：${file}`);
  die(2, `讀取失敗（${e.code || e.name}）：${e.message.split(NL)[0]}：${file}`);
}

// ---------- 輸出 ----------
if (asJson) {
  process.stdout.write(JSON.stringify({ file, pass: !r.bad.length, bad: r.bad, notes: r.notes }, null, 2) + NL);
  process.exit(r.bad.length ? 1 : 0);
}
const out = [];
out.push(`檔案：${file}`);
out.push(`格式：${r.ext.slice(1)}　段落：${r.paragraphs}`);
if (r.ext !== '.docx') out.push('（樣式一致性、表格欄寬兩項只有 docx 能機械判定；此格式請目視確認）');
out.push('');
out.push(r.bad.length ? `✗ 硬缺陷 ${r.bad.length} 項（要改）：` : '✓ 硬缺陷 0 項');
for (const b of r.bad) out.push('   · ' + b);
out.push('');
out.push(r.notes.length ? `△ 提醒 ${r.notes.length} 項（逐一判斷）：` : '△ 提醒 0 項');
for (const n of r.notes) out.push('   · ' + n);
process.stdout.write(out.join(NL) + NL);
process.exit(r.bad.length ? 1 : 0);
