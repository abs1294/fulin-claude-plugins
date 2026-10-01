#!/usr/bin/env node
/**
 * check_doc.js — deliver-report plugin 的交付前自檢 CLI（四個 subskill 的自檢步驟都呼叫這支）。
 *
 * 用法：node check_doc.js <檔案路徑或檔名> [--root <搜尋根目錄>] [--json] [--visual | --no-visual]
 *                          [--thread <客戶信件串文字檔>] [--prev <上一版檔案>]
 *   - 給路徑：直接用。
 *   - 只給檔名（可省略副檔名）：在 --root（預設目前目錄）底下往下找，最多 6 層，
 *     跳過 node_modules/.git 等目錄。找到多份 → 列出候選、exit 2，由呼叫端請使用者指定。
 *   - 支援 .docx / .pptx / .xlsx / .md / .markdown / .txt / .pdf（pdf 需 Python + pypdf 抽文字）。
 *   - 文件屬性（docx／pptx／xlsx／pdf 的標題、作者、描述、公司）：依格式自動檢查，產生工具沒改掉的預設值、
 *     AI 工具名稱算硬缺陷；md／txt 沒有文件屬性，列為不適用。
 *   - --thread：客戶信件串（純文字）。列出文件裡每條「待確認」與信件串最新日期，由人逐條判斷信裡是否已答覆（提醒）。
 *   - --prev：上一版檔案。比對票期、付款、驗收、保固、金額等條款，整段消失或數字變動都列出（提醒，不判對錯）。
 *   - 沒給 --thread／--prev 的項目列在「這次沒檢查到的」，不算通過。
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
let target = null, root = process.cwd(), asJson = false, visualFlag = null, threadFile = null, prevFile = null;
// 參數值缺漏或本身是另一個旗標（--thread --json）→ exit 2，不可把旗標當檔名
const val = (i) => (args[i] !== undefined && !args[i].startsWith('--') ? args[i] : die(2, `${args[i - 1]} 後面要接檔案路徑`));
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--root') root = val(++i);
  else if (args[i] === '--thread') threadFile = val(++i);
  else if (args[i] === '--prev') prevFile = val(++i);
  else if (args[i] === '--json') asJson = true;
  else if (args[i] === '--visual') visualFlag = true;
  else if (args[i] === '--no-visual') visualFlag = false;
  else if (!target) target = args[i];
}
if (!target) die(2, '用法：node check_doc.js <檔案路徑或檔名> [--root <目錄>] [--json] [--visual | --no-visual] [--thread <信件串>] [--prev <上一版>]');

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

// 這次沒檢查到的：不算通過。放「沒給 --thread／--prev」與「缺 Python 而沒讀的內容」
const unchecked = [];
let envMissing = false;   // 有任何一項因缺 Python 或其套件沒檢查：--json 的 pass 不給 true
let r;
try { r = core.scanFile(file); }
catch (e) {
  // 缺 Python／pypdf 是這台機器沒裝，不是檔案壞了：不擋（不 exit 2），列進「這次沒檢查到的」並寫明怎麼裝
  if (e instanceof core.NeedsPython) {
    r = { file, ext: path.extname(file).toLowerCase(), text: [], paragraphs: '（未讀取）', bad: [], notes: [], unread: true };
    unchecked.push(`文件內容：${e.reason}`);
    envMissing = true;
  }
  // 其他讀檔失敗（含權限不足、檔案被鎖、檔案損毀）都是「讀不到」＝ exit 2，不可落成 exit 1 被當成「有缺陷但讀過了」
  else if (e instanceof core.ReadError) die(2, `${e.message}：${file}`);
  else die(2, `讀取失敗（${e.code || e.name}）：${e.message.split(NL)[0]}：${file}`);
}

// ---------- 視覺檢查 ----------
const VISUAL_EXTS = ['.pptx', '.docx', '.pdf'];
const wantVisual = VISUAL_EXTS.includes(r.ext) && (visualFlag === null ? r.ext === '.pptx' : visualFlag);
let vis = null;          // visual_check.py 的結果
let visError = null;     // 要跑卻跑不成的原因（＝未驗證，不算通過）
let visNeeds = null;     // 缺 Python 或其套件而沒跑：不擋，列進「這次沒檢查到的」並附安裝方式
if (wantVisual) {
  const { spawnSync } = require('child_process');
  const script = path.join(__dirname, 'visual_check.py');
  // 先確認環境：沒有能用的 Python、PyMuPDF／Pillow 沒裝 → 只提醒。環境齊了還跑不成才是真正的失敗（exit 2）
  // DR_VISUAL_PYTHON：指定 Python 執行檔（測試「找不到 python」時用；平常不必設）
  const exe = core.findPython('DR_VISUAL_PYTHON');
  const mods = exe ? [['fitz', 'PyMuPDF'], ['PIL', 'Pillow']].map(([m, n]) => [n, core.hasModule(exe, m)]) : [];
  const missing = mods.filter(([, has]) => has === false).map(([n]) => n);
  if (mods.some(([, has]) => has === null)) visError = '視覺檢查執行失敗：無法確認 PyMuPDF／Pillow 是否已安裝';
  else if (!exe) visNeeds = `本機找不到可用的 Python（3.8 以上）。${core.PY_INSTALL}`;
  else if (missing.length) visNeeds = `缺 Python 套件 ${missing.join('、')}，請執行 pip install pymupdf pillow，裝好後重新檢查`;
  else {
    // 輸出資料夾由這裡決定（命名格式同 visual_check.py 的預設，7 天自動清理照樣認得），才知道清單檔在哪：
    // 沒拿到遮蔽好的結果時要把它刪掉
    const stem = path.basename(file, path.extname(file)).replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 40);
    const p2 = (n) => String(n).padStart(2, '0');
    const now = new Date();
    const stamp = `${now.getFullYear()}${p2(now.getMonth() + 1)}${p2(now.getDate())}-${p2(now.getHours())}${p2(now.getMinutes())}${p2(now.getSeconds())}`;
    const tmpRoot = require('os').tmpdir();
    const outDir = path.join(tmpRoot, 'deliver-report-visual', `${stem}-${stamp}-${require('crypto').randomBytes(3).toString('hex')}`);
    const manifestPath = path.join(outDir, 'visual-manifest.json');
    // --raw-quotes：引用片段不在 Python 端截短，這裡先遮蔽再截（見 quoteMasked）
    // 暫存路徑兩邊取法不同（Windows 上 Node 看 TEMP、Python 先看 TMPDIR），統一成這裡的，
    // 7 天清理才會清到這裡放輸出的那個專用資料夾
    const ran = spawnSync(exe, [script, file, '--json', '--raw-quotes', '--out', outDir], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
      windowsHide: true, timeout: 15 * 60 * 1000, env: { ...process.env, TMPDIR: tmpRoot, TEMP: tmpRoot, TMP: tmpRoot } });
    let j = null;
    try { j = JSON.parse(String(ran.stdout).trim().split(/\r?\n/).pop()); } catch (_) { /* 下面處理 */ }
    // 印了成功結果之後才逾時、被終止或異常結束，檢查不算跑完：只認 0（通過）與 1（有缺陷）
    const exited = !ran.error && !ran.signal && (ran.status === 0 || ran.status === 1);
    if (j && j.ok && exited) {
      // 引用片段先遮蔽再截；清單檔也改寫成遮蔽後的版本，完整原文不留在磁碟上
      j.bad = j.bad.map(quoteMasked);
      j.notes = j.notes.map(quoteMasked);
      try {
        const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        m.bad = j.bad;
        m.notes = j.notes;
        fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2));
        vis = j;
      } catch (e) { visError = `視覺檢查執行失敗：清單檔改寫不了（${e.code || e.name}）`; }
    }
    else if (j && j.ok) visError = `視覺檢查執行失敗：程序沒有正常結束（${ran.error ? ran.error.code || ran.error.message : ran.signal || `結束碼 ${ran.status}`}）`;
    // 錯誤原文可能夾帶文件裡的字（檔名、例外訊息），印出前先遮蔽憑證／個資
    else visError = core.maskSecrets((j && j.error) || `視覺檢查執行失敗：${String(ran.stderr || ran.stdout || ran.error || '').trim().split(/\r?\n/).pop()}`);
    // 沒拿到遮蔽好的結果（寫完清單才異常結束、清單改寫不了）：清單檔裡是完整原文，刪掉；刪不掉就講明位置
    if (!vis) {
      try { fs.rmSync(manifestPath, { force: true }); }
      catch (e) { visError += `；清單檔刪不掉（${e.code || e.name}），內含未遮蔽的原文，請手動刪除：${manifestPath}`; }
    }
  }
}
// ---------- 文件屬性 ----------
// 沒有文件屬性的格式（md／txt）是不適用、不是沒檢查（表頭註明）。
// 屬性檔本身讀不到（解不開、同一欄位出現兩次）屬未驗證：記成提醒、不 exit 2（同目錄頁碼的處理）——放在提醒裡，
// 測試報告閘這類只印提醒的呼叫端才看得到。缺 Python 時訊息裡帶安裝方式。
// Python 本身沒跑成（逾時、崩潰、查不出套件裝了沒）是真正的執行錯誤，exit 2，不可降成提醒
const metaNotes = [];
let meta = null;
try {
  meta = core.checkMetadata(file);
} catch (e) {
  if (e instanceof core.PythonFailed) die(2, `${String(e.message).split(NL)[0]}：${file}`);
  if (e instanceof core.NeedsPython) envMissing = true;
  metaNotes.push(`文件屬性未檢查：${e instanceof core.NeedsPython ? e.reason : String(e.message).split(NL)[0]}（此項屬未驗證）`);
}
// 輸出用的屬性值一律遮蔽憑證／個資（終端機與 --json 都會被保存或轉貼）
const metaShown = meta ? Object.fromEntries(Object.entries(meta.meta).map(([k, v]) => [k, core.maskSecrets(v)])) : null;

// 附帶檔（信件串、上一版）讀文字：支援格式走同一支掃描的抽文字；其他副檔名（.eml 等）當純文字讀。
// 缺 Python 讀不了 → 回 null，該項列進「這次沒檢查到的」
function readSide(f, what, item) {
  if (!fs.existsSync(f) || !fs.statSync(f).isFile()) die(2, `找不到${what}：${f}`);
  try {
    if (core.SUPPORTED.includes(path.extname(f).toLowerCase()) && !/\.(?:txt|md|markdown)$/i.test(f)) return core.scanFile(f).text;
    return fs.readFileSync(f, 'utf8').split(/\r?\n/);
  } catch (e) {
    if (e instanceof core.NeedsPython) { unchecked.push(`${item}：讀不了${what}——${e.reason}`); envMissing = true; return null; }
    die(2, `${what}讀不到：${String(e.message).split(NL)[0]}：${f}`);
  }
}

// ---------- 客戶來信對照（--thread）----------
// 腳本只做機械部分；「這條在信裡算不算已答覆」是語意判斷，由人或模型逐條判讀，所以一律是提醒
const pending = core.pendingItems(r.text);
const threadNotes = [];
let thread = null;
// 文件內容沒讀到（缺 Python）時不比對：拿空內容去比會把每條舊條款都報成消失
if (r.unread && threadFile) unchecked.push('客戶來信對照：文件內容沒有讀取，沒有對照');
if (r.unread && prevFile) unchecked.push('合約條款比對：文件內容沒有讀取，沒有和上一版比對');
const mail = threadFile && !r.unread ? readSide(threadFile, '信件串', '客戶來信對照') : null;
if (mail) {
  const latest = core.latestMailDate(mail.join(NL));
  thread = { file: path.resolve(threadFile), latest: latest && latest.date, pending };
  if (pending.length) {
    threadNotes.push(`客戶來信對照：文件有 ${pending.length} 條待確認，信件串最新日期 ${latest ? latest.date : '（找不到日期）'}。` +
      `逐條對照信件判斷是否已答覆，已答覆的要改：` + pending.slice(0, 8).map((p) => `第 ${p.para} 段「${p.text}」`).join('；') +
      (pending.length > 8 ? `；另 ${pending.length - 8} 條` : ''));
  }
}

// ---------- 合約條款比對（--prev）----------
let clauseNotes = [];
const prevText = prevFile && !r.unread ? readSide(prevFile, '上一版', '合約條款比對') : null;
if (prevText) clauseNotes = core.compareClauses(prevText, r.text);

// 沒給參數的列進「這次沒檢查到的」：只限 docx／pptx／xlsx／pdf 這類交付檔格式。
// md／txt 不列——日報寄送與確認清單轉檔也呼叫這支、會照印輸出，印出「不算通過」會和放行結果自相矛盾；
// check-before 點名檢查 md 時，由 SKILL.md 的流程先問要不要給信件串與上一版。
if (core.META_EXTS.includes(r.ext)) {
  if (!threadFile && pending.length) unchecked.push(`客戶來信對照：沒給 --thread，文件裡有 ${pending.length} 條待確認沒有對照客戶最新來信`);
  if (!prevFile) unchecked.push('合約條款比對：沒給 --prev，沒有和上一版比對票期、付款、金額等條款');
}

if (visNeeds) unchecked.push(`視覺檢查：${visNeeds}`);

// 視覺檢查的缺陷與提醒會引用文件原文（「…」），印出前同樣先遮蔽。
// visual_check.py 交來的引用片段是完整原文（前後有標記、帶原本的截短長度）：先遮蔽再截，被截斷的號碼才不會漏遮
function quoteMasked(s) {
  const masked = s.replace(/\ue000(\d+)\ue001([\s\S]*?)\ue002/g, (_, n, t) => {
    const cs = Array.from(core.maskSecrets(t));
    return cs.length <= +n ? cs.join('') : cs.slice(0, +n).join('') + '…';
  });
  return core.maskSecrets(masked);
}
const bad = [...r.bad, ...(meta ? meta.bad : []), ...(vis ? vis.bad.map((b) => '視覺 ' + b) : [])];
const notes = [...r.notes, ...(meta ? meta.notes : metaNotes), ...threadNotes, ...clauseNotes,
  ...(vis ? vis.notes.map((n) => '視覺 ' + n) : [])];
const code = visError ? 2 : bad.length ? 1 : 0;

// ---------- 輸出 ----------
if (asJson) {
  // 任何一項因缺 Python 沒檢查（內容、文件屬性、視覺、附帶檔）：exit 照樣是 0（不擋），但 pass 不給 true——
  // 只看 pass 的程式不能把沒檢查的檔當成通過
  process.stdout.write(JSON.stringify({ file, pass: code === 0 && !envMissing && !visNeeds, bad, notes,
    metadata: metaShown,
    thread, unchecked,
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
if (!core.META_EXTS.includes(r.ext)) out.push(`（${r.ext.slice(1)} 沒有文件屬性，標題／作者檢查不適用）`);
else if (meta) out.push('文件屬性：' + (Object.entries(metaShown).filter(([, v]) => v).map(([k, v]) => `${k}＝${v}`).join('；') || '（全部空白）'));
if (vis) out.push(`視覺檢查：${vis.engine} 排版，${vis.pages} 頁${vis.target_software ? '' : '（非對方實際使用的軟體，疊字判定僅供參考）'}`);
else if (visError) out.push(`✗ 視覺未驗證：${visError}（不算通過）`);
else if (visNeeds) out.push('□ 視覺檢查沒有跑（缺 Python 或其套件），見下方「這次沒檢查到的」');
else if (VISUAL_EXTS.includes(r.ext)) out.push('（未跑視覺檢查：加 --visual 可檢查疊字、字跑出框與每頁畫面）');
out.push('');
// 內容沒讀到時「0 項」不代表乾淨，同一行講明，不讓人只看這行就當成通過
out.push(bad.length ? `✗ 硬缺陷 ${bad.length} 項（要改）：` : r.unread ? '△ 硬缺陷 0 項——但文件內容沒有讀取，見下方「這次沒檢查到的」' : '✓ 硬缺陷 0 項');
for (const b of bad) out.push('   · ' + b);
out.push('');
out.push(notes.length ? `△ 提醒 ${notes.length} 項（逐一判斷）：` : '△ 提醒 0 項');
for (const n of notes) out.push('   · ' + n);
if (unchecked.length) {
  out.push('');
  out.push(`□ 這次沒檢查到的 ${unchecked.length} 項（不算通過）：`);
  for (const u of unchecked) out.push('   · ' + u);
}
if (vis) {
  out.push('');
  out.push(`每頁畫面 ${vis.images.length} 張（問題處有紅框）。每一張都要用 Read 打開看過，沒看完 Stop hook 會擋：`);
  for (const im of vis.images) out.push('   ' + im);
  out.push('總覽（只當索引，縮圖看不出細微疊字）：' + vis.overview);
  out.push('VISUAL_MANIFEST: ' + vis.manifest);
}
process.stdout.write(out.join(NL) + NL);
process.exit(code);
