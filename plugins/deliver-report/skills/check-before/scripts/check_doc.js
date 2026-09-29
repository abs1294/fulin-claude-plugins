#!/usr/bin/env node
/**
 * check_doc.js — deliver-report plugin 的交付前自檢 CLI（四個 subskill 的自檢步驟都呼叫這支）。
 *
 * 用法：node check_doc.js <檔案路徑或檔名> [--root <搜尋根目錄>] [--json] [--visual | --no-visual]
 *   - 給路徑：直接用。
 *   - 只給檔名（可省略副檔名）：在 --root（預設目前目錄）底下往下找，最多 6 層，
 *     跳過 node_modules/.git 等目錄。找到多份 → 列出候選、exit 2，由呼叫端請使用者指定。
 *   - 支援 .docx / .pptx / .md / .markdown / .txt / .pdf（pdf 需 Python + pypdf 抽文字）。
 *   - 視覺檢查（同目錄 visual_check.py：疊字、字跑出框、超出頁面，每頁輸出圖片）：
 *       pptx 預設就跑；docx／pdf 要加 --visual（check-before 流程一律加）。
 *       不預設給 docx／pdf 跑，是因為測試報告閘、確認清單轉檔、日報寄送也呼叫這支，
 *       它們不需要多開 Word 十幾秒，沒有排版軟體的機器也不該因此被擋。--no-visual 可關掉。
 *
 * 判準全部在 hooks/lib/readability-scan.core.js 的 scanFile()——與 Stop hook 同一份，這裡只負責找檔與輸出。
 *
 * exit code：0 通過（可能有提醒）、1 有硬缺陷、2 找不到檔／多份候選／讀不到內容／要跑視覺檢查卻無法排版。
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
let target = null, root = process.cwd(), asJson = false, visualFlag = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--root') root = args[++i];
  else if (args[i] === '--json') asJson = true;
  else if (args[i] === '--visual') visualFlag = true;
  else if (args[i] === '--no-visual') visualFlag = false;
  else if (!target) target = args[i];
}
if (!target) die(2, '用法：node check_doc.js <檔案路徑或檔名> [--root <目錄>] [--json] [--visual | --no-visual]');

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

// 規則沒有完整載入就不掃：少載的規則會讓結果靜默顯示「通過」（曾整組漏載一個月沒人發現）
const cov = core.ruleCoverage();
if (!cov.ok) die(2, `禁用規則載入不完整，不執行檢查：${cov.reason}（references/banned-patterns.json 與 hooks/lib/readability-scan.core.js 的讀法對不上）`);

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

// ---------- 視覺檢查 ----------
const VISUAL_EXTS = ['.pptx', '.docx', '.pdf'];
const wantVisual = VISUAL_EXTS.includes(r.ext) && (visualFlag === null ? r.ext === '.pptx' : visualFlag);
let vis = null;          // visual_check.py 的結果
let visError = null;     // 要跑卻跑不成的原因（＝未驗證，不算通過）
if (wantVisual) {
  const { spawnSync } = require('child_process');
  const script = path.join(__dirname, 'visual_check.py');
  let ran = null;
  for (const exe of ['python', 'python3', 'py']) {
    const p = spawnSync(exe, [script, file, '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true,
      timeout: 15 * 60 * 1000 });
    if (p.error && p.error.code === 'ENOENT') continue;
    ran = p; break;
  }
  if (!ran) visError = '視覺檢查需要 Python 3（本機找不到 python）';
  else {
    let j = null;
    try { j = JSON.parse(String(ran.stdout).trim().split(/\r?\n/).pop()); } catch (_) { /* 下面處理 */ }
    if (j && j.ok) vis = j;
    else visError = (j && j.error) || `視覺檢查執行失敗：${String(ran.stderr || ran.stdout || ran.error || '').trim().split(/\r?\n/).pop()}`;
  }
}
const bad = [...r.bad, ...(vis ? vis.bad.map((b) => '視覺 ' + b) : [])];
const notes = [...r.notes, ...(vis ? vis.notes.map((n) => '視覺 ' + n) : [])];
const code = visError ? 2 : bad.length ? 1 : 0;

// ---------- 輸出 ----------
if (asJson) {
  process.stdout.write(JSON.stringify({ file, pass: code === 0, bad, notes,
    visual: vis ? { engine: vis.engine, target_software: vis.target_software, pages: vis.pages, images: vis.images,
                    overview: vis.overview, manifest: vis.manifest } : null,
    visual_error: visError }, null, 2) + NL);
  // JSON 模式只輸出一段 JSON（呼叫端整段 parse）；看圖閘從 "manifest" 欄位找清單
  process.exit(code);
}
const out = [];
out.push(`檔案：${file}`);
out.push(`格式：${r.ext.slice(1)}　段落：${r.paragraphs}`);
if (r.ext !== '.docx') out.push('（樣式一致性、表格欄寬兩項只有 docx 能機械判定；此格式請目視確認）');
if (vis) out.push(`視覺檢查：${vis.engine} 排版，${vis.pages} 頁${vis.target_software ? '' : '（非對方實際使用的軟體，疊字判定僅供參考）'}`);
else if (visError) out.push(`✗ 視覺未驗證：${visError}（不算通過）`);
else if (VISUAL_EXTS.includes(r.ext)) out.push('（未跑視覺檢查：加 --visual 可檢查疊字、字跑出框與每頁畫面）');
out.push('');
out.push(bad.length ? `✗ 硬缺陷 ${bad.length} 項（要改）：` : '✓ 硬缺陷 0 項');
for (const b of bad) out.push('   · ' + b);
out.push('');
out.push(notes.length ? `△ 提醒 ${notes.length} 項（逐一判斷）：` : '△ 提醒 0 項');
for (const n of notes) out.push('   · ' + n);
if (vis) {
  out.push('');
  out.push(`每頁畫面 ${vis.images.length} 張（問題處有紅框）。每一張都要用 Read 打開看過，沒看完 Stop hook 會擋：`);
  for (const im of vis.images) out.push('   ' + im);
  out.push('總覽（只當索引，縮圖看不出細微疊字）：' + vis.overview);
  out.push('VISUAL_MANIFEST: ' + vis.manifest);
}
process.stdout.write(out.join(NL) + NL);
process.exit(code);
