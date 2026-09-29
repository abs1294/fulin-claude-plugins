/**
 * readability-scan.core — 文件易讀性「判得準」的機械掃描，單一來源。
 *
 * 使用端（判準只改這裡，全部同時生效——不要在任一端另抄一份）：
 *   hooks/doc-readability-gate.js              Stop hook：本回合用過會產文件的 subskill 時自動掃近期產出
 *   skills/check-before/scripts/check_doc.js   CLI：四個 subskill 的交付前自檢步驟都呼叫它，
 *                                              使用者也可用 check-before 點名任一份檔案
 * 兩個入口：scan(docx, minParas) 是 hook 的原始 docx 路徑（行為不變）；
 *          scanFile(任意格式) 另加十項必掃中的第 4、8、10 項（目錄頁碼只在 docx 有目錄時跑）與 Markdown 標題編號。
 * 依據：references/document-readability.md
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// ---------- 共用禁用樣式（references/banned-patterns.json）----------
// 單一事實來源，與 skills/daily-report/scripts/content_guard.py 讀同一份。
// ★ FAIL-OPEN：讀不到 / 壞掉 → 回退到內建最小清單，絕不因此擋住 session。
function loadBanned() {
  const fallback = {
    literals: ['本次查核', '本文件初版', '原文件', '上一版', '第 N 輪', '本次清點'],
    groups: [],
  };
  try {
    const f = path.join(__dirname, '..', '..', 'references', 'banned-patterns.json');
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    const groups = [];
    for (const key of Object.keys(j)) {
      if (key.startsWith('_')) continue;
      const g = j[key];
      if (!g || !Array.isArray(g.applies_to) || !g.applies_to.includes('docx')) continue;
      // patterns 與 subgroups 兩種寫法都要讀（content_guard.py 兩種都吃；只讀 patterns 會讓
      // subgroups 寫法的組整組靜默失效——曾因此以為某個字「不在清單裡」）
      const srcs = [...(g.patterns || [])];
      for (const pats of Object.values(g.subgroups || {})) srcs.push(...pats);
      for (const src of srcs) {
        // (?i) 前綴轉成 JS 的 i flag（JS 不支援行內 (?i)）
        let flags = 'g', body = src;
        if (body.startsWith('(?i)')) { body = body.slice(4); flags += 'i'; }
        try { groups.push({ key, label: g.label || key, re: new RegExp(body, flags) }); }
        catch (_) { /* 單一 pattern 壞掉 → 略過該條，不影響其餘 */ }
      }
    }
    for (const re of harvestLocalAiNames()) groups.push({ key: 'ai_tool_names', label: 'AI 工具名稱', re, harvested: true });
    const lits = (j.revision_history && j.revision_history.literals) || fallback.literals;
    return { literals: lits, groups };
  } catch (_) {
    return fallback;   // 讀不到就用內建，維持原有行為
  }
}

// 命中時要遮蔽值的組：只有機密。其餘組（AI 名稱、敬稱…）印原文，否則看不出要改哪個字
const MASK_KEYS = new Set(['credentials', 'pii']);

/**
 * 本機 AI 工具名稱自動蒐集——新裝的 AI 工具不必手動加進禁用清單。
 * 來源（全部 fail-open：讀不到就略過該來源）：
 *   1. Claude Code 已安裝的 plugin、marketplace、MCP 伺服器名稱：這些本身就是我方工具鏈，
 *      但只收「含連字號或數字、至少 5 字元」的名稱（deliver-report、openai-codex、figma-remote-mcp）。
 *      單字名稱（figma、harness、playwright）在一般文件會正常出現，不收——品牌族規則另外涵蓋 AI 品牌單字。
 *   2. 全域 npm 套件：描述或關鍵字標明是 AI／LLM／agent 類的，收它的指令名稱與套件名
 *      （@openai/codex → codex；@fission-ai/openspec → openspec），不看描述的一般工具（playwright、typescript）不收。
 * 比對不分大小寫、以「前後不是英數字或連字號」為邊界。
 */
function harvestLocalAiNames() {
  const home = require('os').homedir();
  const names = new Set();
  const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; } };
  const distinctive = (n) => typeof n === 'string' && n.length >= 5 && /[-0-9]/.test(n) && /^[\w.-]+$/.test(n);

  const inst = readJson(path.join(home, '.claude', 'plugins', 'installed_plugins.json'));
  for (const id of Object.keys((inst && (inst.plugins || inst)) || {})) {
    for (const part of String(id).split('@')) if (distinctive(part)) names.add(part);
  }
  const mkts = readJson(path.join(home, '.claude', 'plugins', 'known_marketplaces.json'));
  for (const n of Object.keys(mkts || {})) if (distinctive(n)) names.add(n);
  const cj = readJson(path.join(home, '.claude.json'));
  if (cj) {
    for (const n of Object.keys(cj.mcpServers || {})) if (distinctive(n)) names.add(n);
    for (const pj of Object.values(cj.projects || {})) for (const n of Object.keys((pj && pj.mcpServers) || {})) if (distinctive(n)) names.add(n);
  }
  // 專案層級的 .mcp.json（從目前目錄往上找到 repo 根為止；專案內設定的 MCP 不會出現在 ~/.claude.json）
  for (let dir = process.cwd(), i = 0; i < 8; i++) {
    const mj = readJson(path.join(dir, '.mcp.json'));
    if (mj) for (const n of Object.keys(mj.mcpServers || {})) if (distinctive(n)) names.add(n);
    if (fs.existsSync(path.join(dir, '.git'))) break;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }

  const AI_SIGNAL = /\b(?:ai|llm|gpt|openai|anthropic|claude|gemini|copilot|agent|agentic|mcp)\b|AI-native/i;
  // 全域 npm 的常見位置都看（不執行 npm root -g：要多花數百毫秒，Stop hook 每次都會跑到）
  //   Windows 預設 %APPDATA%\npm；自訂 prefix（npm_config_prefix）；
  //   macOS／Linux 與 nvm：node 執行檔所在的 <prefix>/lib/node_modules；Windows 安裝版：<node 目錄>/node_modules
  const nodeDir = path.dirname(process.execPath);
  const prefix = process.env.npm_config_prefix || process.env.NPM_CONFIG_PREFIX;
  const npmRoots = [...new Set([
    process.env.APPDATA && path.join(process.env.APPDATA, 'npm', 'node_modules'),
    prefix && path.join(prefix, 'node_modules'),
    prefix && path.join(prefix, 'lib', 'node_modules'),
    path.join(nodeDir, '..', 'lib', 'node_modules'),
    path.join(nodeDir, 'node_modules'),
    path.join(home, '.npm-global', 'lib', 'node_modules'),
  ].filter(Boolean).map((p) => path.resolve(p)))];
  const pkgDirs = [];
  for (const npmRoot of npmRoots) {
    let top = [];
    try { top = fs.readdirSync(npmRoot); } catch (_) { continue; /* 這個位置沒有 */ }
    for (const d of top) {
      if (d.startsWith('@')) { try { for (const s of fs.readdirSync(path.join(npmRoot, d))) pkgDirs.push(path.join(npmRoot, d, s)); } catch (_) { /* 略過 */ } }
      else pkgDirs.push(path.join(npmRoot, d));
    }
  }
  for (const d of pkgDirs) {
    const pj = readJson(path.join(d, 'package.json'));
    if (!pj) continue;
    const meta = [pj.description || '', ...(pj.keywords || [])].join(' ');
    if (!AI_SIGNAL.test(meta)) continue;
    const bins = typeof pj.bin === 'string' ? [String(pj.name).split('/').pop()] : Object.keys(pj.bin || {});
    for (const b of bins) if (typeof b === 'string' && b.length >= 4 && /^[\w.-]+$/.test(b)) names.add(b);
    if (String(pj.name).startsWith('@')) names.add(String(pj.name));
  }

  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  return [...names].map((n) => new RegExp(`(?<![A-Za-z0-9_-])${esc(n)}(?![A-Za-z0-9_-])`, 'gi'));
}

const BANNED = loadBanned();

// ---------- 掃描單一 .docx ----------
// minParas：段落數低於此值視為「不像交付文件」→ 回 null 不擋（Stop hook 用 20；
// check-before 傳 0，因為使用者已點名這份就是交付文件）。
function scan(file, minParas = 20) {
  const xml = readDocXml(file);
  if (!xml) return null;                            // 讀不到 → 不擋

  const paras = [...xml.matchAll(/<w:p\b(?:(?!<\/w:p>).)*?<\/w:p>/gs)].map(m => m[0]);
  if (paras.length < minParas) return null;         // 太短、不像交付文件 → 不擋
  return scanText(paras.map(strip), { paras, xml });
}

// ---------- 掃描逐段文字（docx／md／pdf 共用）----------
// text：逐段文字陣列；docx：{ paras, xml }——只有 docx 才跑樣式與表格欄寬兩項。
function scanText(text, docx) {
  const full = text.join('\n');

  const bad = [];     // 擋下：判得準的硬缺陷
  const notes = [];   // 只提醒：判不準、誤判成本高於漏抓的（見檔頭分類）

  // ---- 鐵則 5：異動紀錄用語（清單來自共用檔）----
  const hitBanned = BANNED.literals.filter(w => full.includes(w));
  if (hitBanned.length) bad.push(`鐵則5 異動紀錄用語：${hitBanned.join('、')}`);

  // ---- 憑證與個資（共用檔的 credentials / pii）----
  // 交付文件同樣會夾帶：截圖說明、資料修正紀錄、參數對照表都是常見落點。
  // 命中一律遮蔽值本身再回報——訊息會出現在終端機，不該把憑證再印一次。
  const honorifics = [];   // 敬稱命中集中收集，最後併成一行（每條 pattern 各自成 group）
  const plainHits = new Map();   // 不遮蔽的組（AI 名稱…）：同組命中併成一行，原文照印
  for (const g of BANNED.groups) {
    let m;
    g.re.lastIndex = 0;
    const hits = [];
    const raw = [];
    while ((m = g.re.exec(full)) !== null) {
      const v = m[0];
      if (!raw.includes(v)) raw.push(v);
      hits.push(v.length > 12 ? v.slice(0, 4) + '…' + v.slice(-2) : v.slice(0, 2) + '…');
      if (hits.length >= 3) break;
      if (m.index === g.re.lastIndex) g.re.lastIndex++;   // 零寬匹配防呆
    }
    if (hits.length) {
      // 敬稱不是機密，遮蔽了反而看不出要改哪個詞 → 這組原文照印並直接給改法。
      if (g.key === 'formal_honorifics') {
        // 只提醒不擋：詞邊界問題會誤判（貴司機／成本中心／本司法），見檔頭說明。
        honorifics.push(...raw);
      } else if (MASK_KEYS.has(g.key)) {
        bad.push(`${g.label}：疑似 ${hits.join('、')}（已遮蔽，請確認是否該出現在交付文件）`);
      } else {
        if (!plainHits.has(g.label)) plainHits.set(g.label, new Set());
        for (const v of raw) plainHits.get(g.label).add(v);
      }
    }
  }
  for (const [label, set] of plainHits) {
    const seen = new Map();   // 同一個字只差大小寫（Claude／claude）只列一次
    for (const v of set) if (!seen.has(v.toLowerCase())) seen.set(v.toLowerCase(), v);
    bad.push(`${label}：${[...seen.values()].join('、')}（對外文件不得出現，請改寫或刪除）`);
  }

  // ---- 鐵則 3：小數點式編號 ----
  if (/步驟[一二三四五六七八九十]+之[二三四五]/.test(full)) {
    bad.push('鐵則3 出現小數點式步驟編號（如「步驟四之二」），應攤平為連續整數');
  }

  // ---- 鐵則 3：編號缺號 ----
  const NUM = { 一:1,二:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9,十:10,十一:11,十二:12 };
  const stepSet = new Set();
  for (const m of full.matchAll(/步驟(十二|十一|十|[一二三四五六七八九])(?![之0-9])/g)) {
    const v = NUM[m[1]];
    if (v) stepSet.add(v);
  }
  if (stepSet.size >= 3) {
    const arr = [...stepSet].sort((a, b) => a - b);
    const gaps = [];
    for (let i = 1; i <= arr[arr.length - 1]; i++) if (!stepSet.has(i)) gaps.push(i);
    if (gaps.length) bad.push(`鐵則3 步驟編號缺號：缺 ${gaps.join('、')}（現有 ${arr.join('、')}）`);
  }

  // ---- 鐵則 4：未定義代號 ----
  const codeChecks = [
    { re: /§\s?\d+/g,                         name: '§N',      hint: '改寫「本報告第N節」' },
    { re: /#\d+/g,                            name: '#N',      hint: '改寫「第 N 項」' },
    { re: /(?<![A-Za-z0-9])[SV]\d+(?![0-9])/g, name: 'S/V 編號', hint: '改用步驟名或項次' },
  ];
  const defHint = ['指的是', '＝', '代表', '意思是', '欄＝', '是各'];
  for (const c of codeChecks) {
    const hits = [...full.matchAll(c.re)].map(m => m[0]);
    if (!hits.length) continue;
    const uniq = [...new Set(hits)];
    // 有定義句就放過
    const defined = text.some(t => uniq.some(u => t.includes(u)) && defHint.some(h => t.includes(h)));
    if (!defined) {
      bad.push(`鐵則4 未定義代號 ${c.name}（${uniq.slice(0, 4).join('、')}${uniq.length > 4 ? '…' : ''}）→ ${c.hint}`);
    }
  }

  // ---- 鐵則 8：交叉引用失效 ----
  const secRefs = new Set([...full.matchAll(/(?:見|詳見)\s*第([一二三四五六七八九十]+)節/g)].map(m => m[1]));
  const brokenSec = [...secRefs].filter(n => !text.some(t => new RegExp(`^${n}、`).test(t.trim())));
  // 指向另一份文件的不算（有「報告」「說明書」字樣）
  const crossDoc = /(?:測試報告|變更說明書|另一份)/.test(full);
  if (brokenSec.length && !crossDoc) {
    bad.push(`鐵則8 交叉引用失效：第 ${brokenSec.join('、')} 節不存在`);
  }

  // ---- 鐵則 9：樣式一致性 ----
  // md、pdf 帶不出字級／顏色，這項只有 docx 跑
  if (docx) bad.push(...checkStyle(docx.paras));

  // ---- 鐵則 9d：表格窄欄塞長字 ----
  const narrow = docx ? checkTables(docx.xml) : [];
  if (narrow.length) {
    bad.push(`鐵則9 表格窄欄塞長字（會擠成直排）：${narrow.slice(0, 3).join('；')}`);
  }

  if (honorifics.length) {
    const uniq = [...new Set(honorifics)];
    notes.push(`鐵則14 公文式敬稱：${uniq.join('、')}` +
               `（建議改「您們」，自稱用「我們」；若是「貴司機／成本中心／本司法」這類正常詞請忽略）`);
  }

  return { bad, notes };
}


// ---------- 樣式一致性 ----------
function checkStyle(paras) {
  const out = [];
  const info = paras.map(p => ({
    t: strip(p).trim(),
    sz: (p.match(/<w:sz w:val="(\d+)"\/>/) || [])[1],
    color: (p.match(/<w:color w:val="([0-9A-Fa-f]{6})"\/>/) || [])[1],
    bold: p.includes('<w:b/>'),
    inCell: p.includes('<w:tc>'),
    mono: p.includes('Consolas'),
  })).filter(x => x.t && !x.inCell && !x.mono);

  // (a) 同一種前綴符號的樣式是否一致（2 段以上就該一致）
  for (const sym of ['⚠', '※', '◆', '★']) {
    const g = info.filter(x => x.t.startsWith(sym));
    if (g.length < 2) continue;
    const sigs = [...new Set(g.map(x => `${x.sz || '?'}|${x.color || '-'}|${x.bold ? 'B' : 'n'}`))];
    if (sigs.length > 1) {
      out.push(`鐵則9 「${sym}」有 ${sigs.length} 種樣式（共 ${g.length} 段：${sigs.join(' / ')}），應統一`);
    }
  }

  // (b) 主標是否小於子標（步驟X vs 步驟X-N）
  const main = info.filter(x => /^【?步驟[一二三四五六七八九十]+[　\s】]/.test(x.t) && x.sz);
  const sub  = info.filter(x => /^(?:［步驟[^］]*］)?步驟?[一二三四五六七八九十]*-?\d*[【S]/.test(x.t) && x.sz && !/^【?步驟[一二三四五六七八九十]+[　\s】]/.test(x.t));
  if (main.length && sub.length) {
    const mn = Math.min(...main.map(x => +x.sz));
    const mx = Math.max(...sub.map(x => +x.sz));
    if (mn < mx) out.push(`鐵則9 主標字級(${mn})小於子標(${mx})`);
  }

  // (c) 同級節標題顏色是否一致
  const sect = info.filter(x => /^[一二三四五六七八九十]+(之[一二三])?、/.test(x.t) && x.sz);
  if (sect.length >= 2) {
    const cols = new Set(sect.map(x => x.color || '-'));
    if (cols.size > 1) out.push(`鐵則9 節標題有 ${cols.size} 種顏色（${[...cols].join('、')}），應統一`);
  }
  return out;
}

// ---------- 表格窄欄 ----------
function checkTables(xml) {
  const out = [];
  for (const tm of xml.matchAll(/<w:tbl>.*?<\/w:tbl>/gs)) {
    const tbl = tm[0];
    const rows = [...tbl.matchAll(/<w:tr\b.*?<\/w:tr>/gs)].map(m => m[0]);
    if (rows.length < 2) continue;
    const head = [...rows[0].matchAll(/<w:tc>.*?<\/w:tc>/gs)].map(m => strip(m[0]).trim());
    const widths = [...rows[0].matchAll(/<w:tcW w:type="dxa" w:w="(\d+)"\/>/g)].map(m => +m[1]);
    for (const r of rows.slice(1)) {
      const cells = [...r.matchAll(/<w:tc>.*?<\/w:tc>/gs)].map(m => strip(m[0]).trim());
      for (let k = 0; k < Math.min(cells.length, widths.length); k++) {
        if (widths[k] < 1500 && cells[k].length > 10) {
          const hn = (head[k] && /^[\u4e00-\u9fff\w #（）()／/－-]{1,14}$/.test(head[k]))
                     ? head[k] : ('第' + (k + 1) + '欄');
          out.push(`「${hn}」寬${widths[k]} 放 ${cells[k].length} 字`);
          k = widths.length;   // 同表同欄只報一次
        }
      }
    }
  }
  return [...new Set(out)];
}

// ---------- 讀 docx 的 document.xml（不依賴外部套件）----------
function readDocXml(file) {
  // 優先用 PowerShell 的 System.IO.Compression（Windows 內建）
  try {
    const ps = `$ErrorActionPreference='Stop';` +
      `Add-Type -AssemblyName System.IO.Compression.FileSystem;` +
      `$z=[System.IO.Compression.ZipFile]::OpenRead('${file.replace(/'/g, "''")}');` +
      `$e=$z.Entries | Where-Object { $_.FullName -eq 'word/document.xml' };` +
      `$r=New-Object System.IO.StreamReader($e.Open(),[System.Text.Encoding]::UTF8);` +
      `$r.ReadToEnd();$r.Close();$z.Dispose()`;
    const psFull = `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;` + ps;
    const buf = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', psFull],
      // 錯誤訊息收起來不印：讀不到就回 null，由呼叫端講「讀不到」，不把 PowerShell 原始錯誤灑在畫面上
      { maxBuffer: 64 * 1024 * 1024, timeout: 12000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const s = buf.toString('utf8');
    return s.includes('<w:p') ? s : null;
  } catch (_) { return null; }
}

function strip(x) { return x.replace(/<[^>]+>/g, ''); }

// =====================================================================
// 以下：任意格式的單檔掃描（check-before 點名檢查、Stop hook 掃確認清單 md 共用）
// =====================================================================
const SUPPORTED = ['.docx', '.md', '.markdown', '.txt', '.pdf'];
const NL = String.fromCharCode(10);

class ReadError extends Error {}   // 讀不到內容：呼叫端決定是放行（hook）還是明講（check-before）

function mdToLines(src) {
  const lines = [];
  let inFence = false;
  for (let l of src.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(l)) { inFence = !inFence; continue; }
    if (inFence) { lines.push(l); continue; }
    if (/^\s*\|?\s*:?-{3,}/.test(l)) continue;            // 表格分隔列
    l = l.replace(/^\s{0,3}#{1,6}\s+/, '')                // 標題記號
         .replace(/^\s*>\s?/, '')                          // 引言
         .replace(/\*|__|`/g, '')                          // 粗體、斜體（含單星號拆字「本*次*查核」）、行內碼
         .replace(/^\s*[-*+]\s+/, '')                      // 清單記號
         .replace(/^\|\s*|\s*\|$/g, '').replace(/\s*\|\s*/g, '　');   // 表格欄
    // 先拿掉 HTML 標籤再解碼實體：「本<span>次</span>查核」在 PDF 上會顯示成完整禁詞
    lines.push(decodeEntities(l.replace(/<\/?[a-zA-Z][^>]*>/g, '')));
  }
  return lines;
}

// HTML 字元實體轉回原字：「&#26412;次查核」在 PDF 上會顯示成「本次查核」，不解碼就躲得過掃描
function decodeEntities(s) {
  const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return Object.prototype.hasOwnProperty.call(NAMED, e.toLowerCase()) ? NAMED[e.toLowerCase()] : m;
  });
}

function pdfToLines(f) {
  const py = [
    'import sys, pypdf',
    'sys.stdout.reconfigure(encoding="utf-8")',
    'r = pypdf.PdfReader(sys.argv[1])',
    'print("\\n".join((p.extract_text() or "") for p in r.pages))',
  ].join(NL);
  for (const exe of ['python', 'python3', 'py']) {
    try {
      const out = execFileSync(exe, ['-c', py, f], { maxBuffer: 64 * 1024 * 1024, timeout: 60000, windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'] });   // 錯誤收進 e.stderr，下面組成一行訊息，不直接印到畫面
      return out.toString('utf8').split(/\r?\n/);
    } catch (e) {
      if (e.code === 'ENOENT') continue;
      throw new ReadError(`PDF 讀取失敗（${exe} + pypdf）：${String(e.stderr || e.message).trim().split(NL).pop()}`);
    }
  }
  throw new ReadError('PDF 讀取需要 Python 與 pypdf（pip install pypdf），本機找不到 python');
}

// 提醒會印出原文片段；片段裡若有憑證／個資，先遮蔽再印（硬缺陷那邊已遮蔽，這裡不能再明文印一次）
function maskSecrets(s) {
  let out = s;
  for (const g of BANNED.groups) {
    if (!MASK_KEYS.has(g.key)) continue;   // 只遮機密；AI 名稱、敬稱不是機密
    out = out.replace(new RegExp(g.re.source, g.re.flags), '［已遮蔽］');
  }
  return out;
}

// 十項必掃裡 Stop hook 不跑的項目（第 4、8 項＋Markdown 標題編號；第 10 項目錄頁碼在 scanFile 另外跑）
function extraChecks(text, mdSource) {
  const bad = [], notes = [];

  // 必掃 4：重複偵測
  const count = new Map();
  for (const t of text.map(s => s.trim())) if (t.length > 25) count.set(t, (count.get(t) || 0) + 1);
  const dups = [...count].filter(([, n]) => n >= 2);
  if (dups.length) {
    notes.push(`必掃4 重複內容 ${dups.length} 處（逐一判斷是否該合併）：` +
      dups.slice(0, 5).map(([t, n]) => `「${maskSecrets(t).slice(0, 20)}…」×${n}`).join('、'));
  }

  // 必掃 8：內部推導痕跡（搜到不等於要刪）
  const TRACE = ['原價', '折', '優惠', '成本', 'buffer', '緩衝', '本來', '比照'];
  const traceHits = [];
  for (const t of text) {
    for (const w of TRACE) {
      if (w === '折' ? /折(?!線|疊|返|射|磨|騰)/.test(t) : t.toLowerCase().includes(w.toLowerCase())) {
        traceHits.push(`${w}：「${maskSecrets(t.trim()).slice(0, 24)}」`);
      }
    }
  }
  if (traceHits.length) {
    notes.push(`必掃8 內部推導痕跡 ${traceHits.length} 處（是結論就留、是推導過程就刪）：` + traceHits.slice(0, 6).join('；'));
  }

  // 鐵則 3：Markdown 標題編號連續（只看標題，正文引用別的編號不算）
  if (mdSource) {
    // 程式碼區塊裡的 ## 是範例，不是文件標題
    let inFence = false;
    const heads = mdSource.split(/\r?\n/)
      .filter(l => { if (/^\s*(```|~~~)/.test(l)) { inFence = !inFence; return false; } return !inFence; })
      .filter(l => /^\s{0,3}#{1,6}\s/.test(l))
      .map(l => ({ lv: l.match(/#+/)[0].length, t: l.replace(/^\s*#+\s+/, '').trim() }));
    const CN = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十'];
    const seqCheck = (label, nums) => {
      for (let i = 0; i < nums.length; i++) {
        if (nums[i] !== i + 1) {
          bad.push(`鐵則3 ${label}編號不連續：依序是 ${nums.join('、')}（第 ${i + 1} 個應為 ${i + 1}）`);
          return;
        }
      }
    };
    // 同一層級的「一、二、三」遇到上一層標題就重新起算——各章子節各自從「一」編是正常寫法
    for (const lv of [...new Set(heads.map(h => h.lv))]) {
      const groups = [[]];
      for (const h of heads) {
        if (h.lv < lv) { if (groups[groups.length - 1].length) groups.push([]); continue; }
        if (h.lv !== lv) continue;
        const m = h.t.match(/^([一二三四五六七八九十]+)、/);
        if (m) groups[groups.length - 1].push(CN.indexOf(m[1]) + 1);
      }
      for (const g of groups) if (g.length >= 2) seqCheck(`第 ${lv} 級標題「一、二、三」`, g);
    }
    for (const kw of ['議題', '問題', '項目', '題']) {
      const nums = heads.map(h => (h.t.match(new RegExp('^' + kw + '\\s*(\\d+)')) || [])[1]).filter(Boolean).map(Number);
      if (nums.length >= 2) seqCheck(`「${kw} N」`, nums);
    }
  }
  return { bad, notes };
}

/**
 * 掃一份檔案（docx／md／txt／pdf），跑十項必掃中機器判得了的全部項目。
 * 讀不到內容 → 丟 ReadError（hook 端接住放行；check-before 端明講讀不到）。
 * 回傳 { file, ext, paragraphs, bad, notes }。
 */
function scanFile(file) {
  const ext = path.extname(file).toLowerCase();
  if (!SUPPORTED.includes(ext)) throw new ReadError(`不支援的格式 ${ext}（支援 ${SUPPORTED.join(' ')}）`);
  let text, result, mdSource = null;
  if (ext === '.docx') {
    const xml = readDocXml(file);
    if (!xml) throw new ReadError('讀不到 docx 內文（word/document.xml）');
    const paras = [...xml.matchAll(/<w:p\b(?:(?!<\/w:p>).)*?<\/w:p>/gs)].map(m => m[0]);
    text = paras.map(strip);
    // 空白或只有圖片（例如掃描檔轉成的 docx）＝沒有可掃的文字，不可回報通過
    if (!text.some(t => t.trim())) throw new ReadError('docx 沒有可讀的文字（空白或只有圖片）');
    result = scanText(text, { paras, xml });
    // 有目錄欄位才開 Word 檢查頁碼（開 Word 要數秒；Stop hook 走 scan() 不跑這項，避免逾時）
    if (/<w:instrText[^>]*>\s*TOC\b|w:instr="\s*TOC\b/.test(xml)) {
      const toc = checkToc(file);
      if (toc.error) result.notes.push(`目錄頁碼未檢查：${toc.error}（此項屬未驗證）`);
      else if (toc.stale.length) result.bad.push(`目錄未更新：${toc.stale.slice(0, 4).join('；')}` +
        `${toc.stale.length > 4 ? `；另 ${toc.stale.length - 4} 處` : ''}` +
        `（在目錄上按右鍵 → 更新功能變數 → 更新整個目錄）`);
    }
  } else {
    if (ext === '.pdf') text = pdfToLines(file);
    else {
      mdSource = fs.readFileSync(file, 'utf8');
      if (ext === '.txt') mdSource = null;
      text = mdSource ? mdToLines(mdSource) : fs.readFileSync(file, 'utf8').split(/\r?\n/);
    }
    if (!text.some(t => t.trim())) throw new ReadError('檔案沒有可讀的文字（掃描圖檔型 PDF 需先 OCR）');
    result = scanText(text, null);
  }
  const extra = extraChecks(text, mdSource);
  return {
    file, ext,
    paragraphs: text.filter(t => t.trim()).length,
    bad: [...result.bad, ...extra.bad],
    notes: [...result.notes, ...extra.notes],
  };
}

/**
 * 目錄是否過期：用 Word 唯讀開檔，比對「更新目錄前」與「更新目錄後」的內容，不存檔。
 * 用 Word 自己的排版與目錄邏輯判斷——頁碼、改過名的標題、新增或刪掉的標題都涵蓋，不必自己推算分頁。
 * 回傳 { stale: [差異說明…] } 或 { error: '原因' }（沒有 Word、開檔失敗等；呼叫端記為未驗證）。
 */
function checkToc(file) {
  if (process.platform !== 'win32') return { error: '需要 Windows 與 Microsoft Word' };
  const pidFile = path.join(require('os').tmpdir(), `dr-toc-${process.pid}-${Date.now()}.pid`);
  const ps = [
    "$ErrorActionPreference='Stop'",
    '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8',
    // 記下「這支腳本啟動的」WINWORD 程序：逾時被砍時由 Node 端只清掉這一個，不碰使用者自己開的 Word
    '$pre=@(Get-Process WINWORD -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })',
    '$w=New-Object -ComObject Word.Application',
    '$mine=@(Get-Process WINWORD -ErrorAction SilentlyContinue | Where-Object { $pre -notcontains $_.Id } | ForEach-Object { $_.Id })',
    'Set-Content -Path $env:DR_TOC_PIDFILE -Value ($mine -join ",") -Encoding ascii',
    '$w.Visible=$false; $w.DisplayAlerts=0',
    'try {',
    // 參數依序：檔名、ConfirmConversions、ReadOnly、AddToRecentFiles、PasswordDocument。
    // 假密碼：有密碼的文件直接開檔失敗，不會跳出輸入密碼視窗卡到逾時（沒密碼的文件會忽略這個值）
    "  $d=$w.Documents.Open($env:DR_TOC_FILE,$false,$true,$false,'__dr_no_password__')",
    '  $res=@()',
    '  foreach($t in $d.TablesOfContents){ $b=$t.Range.Text; $t.Update(); $a=$t.Range.Text; $res+=[pscustomobject]@{before=$b;after=$a} }',
    '  $d.Close(0)',
    '} finally { $w.Quit() }',
    'ConvertTo-Json -InputObject @($res) -Compress',
  ].join(NL);
  let out;
  try {
    out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps],
      { env: { ...process.env, DR_TOC_FILE: path.resolve(file), DR_TOC_PIDFILE: pidFile },
        stdio: ['ignore', 'pipe', 'pipe'],   // PowerShell 的錯誤訊息收進 e.stderr，不直接印到畫面弄亂輸出
        maxBuffer: 16 * 1024 * 1024, timeout: Number(process.env.DR_TOC_TIMEOUT_MS) || 90000,   // 環境變數僅供測試逾時清理
        windowsHide: true }).toString('utf8').trim();
  } catch (e) {
    // 逾時或失敗：PowerShell 的 finally 不保證跑到，補砍這支腳本自己啟動的 Word
    try {
      for (const pid of fs.readFileSync(pidFile, 'ascii').split(',').map((s) => s.trim()).filter((s) => /^\d+$/.test(s))) {
        try { execFileSync('taskkill', ['/PID', pid, '/F'], { windowsHide: true, stdio: 'ignore' }); } catch (_) { /* 已結束 */ }
      }
    } catch (_) { /* 沒有 pid 檔：Word 還沒啟動就失敗 */ }
    const why = e.code === 'ETIMEDOUT' || e.signal ? `逾時 ${Math.round((Number(process.env.DR_TOC_TIMEOUT_MS) || 90000) / 1000)} 秒`
      : (String(e.stderr || '').trim() || String(e.message)).split(/\r?\n/)[0].slice(0, 80);
    return { error: `無法用 Word 開啟（${why}）` };
  } finally {
    try { fs.unlinkSync(pidFile); } catch (_) { /* 略過 */ }
  }
  let tocs;
  try { tocs = JSON.parse(out); } catch (_) { return { error: 'Word 回傳內容無法解析' }; }
  // 依目錄條目的順序比對，不用標題當鍵：報告常有同名標題（多個「測試結果」），當鍵會互相覆蓋而漏報
  const entries = (txt) => {
    const arr = [];
    for (const line of String(txt || '').split(/\r|\n/)) {
      const i = line.lastIndexOf('\t');
      if (i > 0) arr.push([line.slice(0, i).trim(), line.slice(i + 1).trim()]);
    }
    return arr;
  };
  const stale = [];
  for (const t of tocs) {
    const b = entries(t.before), a = entries(t.after);
    if (b.length === a.length) {
      for (let i = 0; i < b.length; i++) {
        if (b[i][0] !== a[i][0]) stale.push(`第 ${i + 1} 條目錄「${b[i][0]}」與正文標題「${a[i][0]}」不一致`);
        else if (b[i][1] !== a[i][1]) stale.push(`「${b[i][0]}」目錄寫第 ${b[i][1]} 頁、實際第 ${a[i][1]} 頁`);
      }
    } else {
      // 條目數不同：用「標題出現次數」比出多的與少的
      const count = (arr) => arr.reduce((m, [x]) => m.set(x, (m.get(x) || 0) + 1), new Map());
      const cb = count(b), ca = count(a);
      stale.push(`目錄 ${b.length} 條、正文標題 ${a.length} 個`);
      for (const [x, n] of cb) if (n > (ca.get(x) || 0)) stale.push(`「${x}」目錄有、正文找不到（標題改過名或刪掉了）`);
      for (const [x, n] of ca) if (n > (cb.get(x) || 0)) stale.push(`「${x}」正文有、目錄沒列`);
    }
  }
  // 標題原文會印到畫面：先遮蔽憑證／個資，不把其他掃描已遮蔽的值再印一次
  return { stale: stale.map(maskSecrets) };
}

/**
 * 規則載入完整性：規則檔裡「套用在 docx 的規則」有幾條，實際載入了幾條。
 * 用和 loadBanned() 不同的算法數——走訪整個組的結構、收集所有字串陣列（不管是 patterns、
 * subgroups 還是將來的新寫法），只排除 applies_to／literals／note。
 * 由來：loadBanned() 曾只讀 patterns，subgroups 寫法的組整組靜默漏載一個月；
 * 測試全都用同一個讀取函式驗證，所以對它的盲區完全看不見。
 */
function ruleCoverage() {
  let j;
  try {
    j = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'references', 'banned-patterns.json'), 'utf8'));
  } catch (e) {
    return { ok: false, expected: null, loaded: 0, reason: '規則檔讀不到或格式錯誤：' + e.message };
  }
  let expected = 0;
  const walk = (v, keyName) => {
    if (['applies_to', 'literals', 'note', 'label'].includes(keyName)) return;
    if (Array.isArray(v)) { for (const x of v) if (typeof x === 'string') expected++; else walk(x); }
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  for (const [key, g] of Object.entries(j)) {
    if (key.startsWith('_') || !g || !Array.isArray(g.applies_to) || !g.applies_to.includes('docx')) continue;
    walk(g);
  }
  const loaded = BANNED.groups.filter((g) => !g.harvested).length;
  return { ok: expected === loaded, expected, loaded,
           reason: expected === loaded ? '' : `規則檔有 ${expected} 條套用在文件的規則，只載入了 ${loaded} 條` };
}

module.exports = {
  ruleCoverage,
  BANNED, SUPPORTED, ReadError,
  scan, scanText, scanFile, extraChecks, mdToLines, pdfToLines,
  checkStyle, checkTables, checkToc, harvestLocalAiNames, readDocXml, strip,
};
