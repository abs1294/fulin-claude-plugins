/**
 * readability-scan.core — 文件易讀性「判得準」的機械掃描，單一來源。
 *
 * 使用端（判準只改這裡，全部同時生效——不要在任一端另抄一份）：
 *   hooks/doc-readability-gate.js              Stop hook：本回合用過會產文件的 subskill 時自動掃近期產出
 *   skills/check-before/scripts/check_doc.js   CLI：四個 subskill 的交付前自檢步驟都呼叫它，
 *                                              使用者也可用 check-before 點名任一份檔案
 * 兩個入口：scan(docx, minParas) 是 hook 的原始 docx 路徑（行為不變）；
 *          scanFile(任意格式) 另加十項必掃中的第 4、8、10 項（目錄頁碼只在 docx 有目錄時跑）與 Markdown 標題編號。
 * docx／pptx／xlsx 用內建 zlib 自己解 zip（openZip），不依賴 PowerShell——Mac／Linux 也能跑。
 * 文件屬性（標題、作者等）、待確認事項、新舊版條款比對只給 check_doc.js 用，Stop hook 不跑。
 * 版面類問題（疊字、字跑出方塊）不在這裡，見 skills/check-before/scripts/visual_check.py。
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

// ---------- 讀 zip 內的檔案（docx／pptx 都是 zip；純 Node，不依賴 PowerShell，Mac／Linux 也能跑）----------
// 回傳 Map<entry 名稱, 讀取函式>；不是 zip 或壞檔 → null。不支援 ZIP64（Office 文件不會大到需要）。
function openZip(file) {
  let buf;
  try { buf = fs.readFileSync(file); } catch (_) { return null; }
  // 中央目錄結尾（EOCD）在檔尾，後面最多接 65535 位元組的註解
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  const zlib = require('zlib');
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) return null;
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), cmtLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    entries.set(name, () => {
      // 本地標頭的檔名／額外欄位長度可能與中央目錄不同，要以本地標頭為準
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + csize);
      if (method === 0) return Buffer.from(data);
      // 解壓上限 256MB：Stop hook 會掃目錄裡的 docx，異常的 zip 不能一次吃光記憶體（超過就丟例外＝讀不到）
      if (method === 8) return zlib.inflateRawSync(data, { maxOutputLength: 256 * 1024 * 1024 });
      throw new Error(`不支援的壓縮方式 ${method}`);
    });
    p += 46 + nameLen + extraLen + cmtLen;
  }
  return entries;
}

function readZipText(file, name) {
  const z = openZip(file);
  if (!z || !z.has(name)) return null;
  try { return decodeXml(z.get(name)()); } catch (_) { return null; }
}

// XML 可以是 UTF-16（開頭有 BOM）；舊的 PowerShell 讀法會自動辨識 BOM，換成 Node 後要自己處理
function decodeXml(b) {
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return b.subarray(2).toString('utf16le');
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) {
    const le = Buffer.from(b.subarray(2));
    for (let i = 0; i + 1 < le.length; i += 2) { const t = le[i]; le[i] = le[i + 1]; le[i + 1] = t; }
    return le.toString('utf16le');
  }
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return b.subarray(3).toString('utf8');
  return b.toString('utf8');
}

// ---------- 讀 docx 的 document.xml ----------
function readDocXml(file) {
  const s = readZipText(file, 'word/document.xml');
  return s && s.includes('<w:p') ? s : null;
}

// ---------- 讀 pptx 各頁文字（依簡報順序，每個 <a:p> 一段；表格儲存格、群組內文字都含）----------
// 回傳 [{ slide: 頁碼, paras: [文字…] }]；讀不到 → null
function readPptxSlides(file) {
  const z = openZip(file);
  if (!z) return null;
  const txt = (n) => { try { return z.has(n) ? decodeXml(z.get(n)()) : null; } catch (_) { return null; } };
  const pres = txt('ppt/presentation.xml');
  const rels = txt('ppt/_rels/presentation.xml.rels');
  if (!pres || !rels) return null;
  const target = relTargets(rels);
  const out = [];
  let i = 0;
  for (const m of pres.matchAll(/<p:sldId\b[^>]*\br:id="([^"]+)"/g)) {
    i++;
    const t = target.get(m[1]);
    if (!t) continue;
    const xml = txt(path.posix.normalize(path.posix.join('ppt', t.replace(/^\//, '').replace(/^ppt\//, ''))));
    if (!xml) continue;
    // 空段落 <a:p/> 要先比對：放在後面時第一個分支會從 <a:p/> 一路吞到下一段的 </a:p>，兩段併成一段。
    // 隱藏投影片（show="0"）照樣掃：它還在交付的檔案裡，對方取消隱藏就看得到（視覺檢查不輸出隱藏頁是另一回事）
    // 自閉合要涵蓋 <a:p/> 與 <a:p />、<a:p attr="x"/>；一般段落的開頭標籤結尾不能是 "/>"
    const paras = [...xml.matchAll(/<a:p(?:\s[^>]*)?\/>|<a:p(?:\s[^>]*)?(?<!\/)>(?:(?!<\/a:p>).)*?<\/a:p>/gs)]
      .map((p) => decodeEntities([...p[0].matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((x) => x[1]).join('')));
    out.push({ slide: i, paras });
  }
  return out;
}

// 關聯檔（*.rels）→ Map<rId, Target>
function relTargets(rels) {
  return new Map([...rels.matchAll(/<Relationship\b[^>]*>/g)].map((m) => {
    const id = (m[0].match(/\bId="([^"]+)"/) || [])[1];
    const t = (m[0].match(/\bTarget="([^"]+)"/) || [])[1];
    return [id, t];
  }));
}

// ---------- 讀 xlsx 文字 ----------
// 交給同目錄的 office_xml.py（Python 標準庫的 XML 解析器）：命名空間前綴、CDATA、註解、標籤配對這些格式規則
// 由完整的解析器處理，不自己用正則拼——正則版一輪輪都被找到漏網的寫法，而漏讀的內容會被當成檢查過。
// 每一列的儲存格（共用字串、內嵌字串、數值、公式結果）以全形空白接成一行：條款字眼與金額常在同一列的不同格，
// 接成一行才比對得到；另收沒被任何儲存格引用的共用字串與儲存格註解。
// 回傳 { sheets: [{ name, state, rows: [一列一行…] }], shared: [文字…], orphan: [文字…], comments: [文字…], broken: [讀不到的部分…] }；
// 不是有效的 xlsx → null；本機沒有 Python → 丟 NeedsPython。工作表、共用字串、註解有任何一塊讀不到就記進 broken，
// 由呼叫端決定整份不算檢查過。state：visible／hidden／veryHidden——隱藏的工作表照樣掃，對方取消隱藏就看得到。
function readXlsx(file) {
  const r = runOfficeXml('xlsx', file, 'xlsx 內容');
  return r.invalid ? null : r;
}

// 跑 office_xml.py（mode＝xlsx／meta），回傳它印出的 JSON
function runOfficeXml(mode, file, what) {
  const out = runPython([path.join(__dirname, 'office_xml.py'), mode, file], what);
  try { return JSON.parse(out.trim().split(/\r?\n/).pop()); } catch (_) { throw new PythonFailed(`${what}讀取失敗：office_xml.py 沒有回傳結果`); }
}

// ---------- 文件屬性（中繼資料）----------
// 標題、作者、描述、公司這些欄位不在內文裡，但對方按右鍵看內容、PDF 閱讀器的視窗標題都看得到。
// 只讀取與判定，Stop hook 不接（加進去等於改變它的擋下範圍）；check_doc.js 呼叫 checkMetadata()。
const META_EXTS = ['.docx', '.pptx', '.xlsx', '.pdf'];
const META_LABEL = { title: '標題', subject: '主旨', creator: '作者', author: '作者', lastModifiedBy: '最後修改者',
  description: '描述', keywords: '關鍵字', category: '類別', company: '公司', manager: '主管', application: '應用程式',
  creatorApp: 'PDF 建立程式', producer: 'PDF 產生器' };

// 回傳 { 欄位: 值 }；格式本來就沒有文件屬性（md／txt）→ null；讀不到 → 丟 ReadError
function readMetadata(file) {
  const ext = path.extname(file).toLowerCase();
  if (!META_EXTS.includes(ext)) return null;
  if (ext === '.pdf') {
    const py = [
      'import sys, json, pypdf',
      'sys.stdout.reconfigure(encoding="utf-8")',
      // 檔案的屬性資料讀不了是資料問題，回傳 error（呼叫端記成提醒）；Python 沒跑完才是執行錯誤
      'try:',
      '    m = pypdf.PdfReader(sys.argv[1]).metadata or {}',
      '    r = {"meta": {k.lstrip("/"): str(v) for k, v in m.items()}}',
      'except Exception as e:',
      '    r = {"error": "PDF 文件屬性讀不到（%s：%s）" % (type(e).__name__, e)}',
      'print()',   // 先換行：啟動設定（sitecustomize）印字不換行時，JSON 才會獨占最後一行
      'print(json.dumps(r, ensure_ascii=False))',
    ].join(NL);
    const out = runPython(['-c', py, file], 'PDF 文件屬性', 'pypdf');
    let res;
    try { res = JSON.parse(out.trim().split(/\r?\n/).pop()); } catch (_) { throw new PythonFailed('PDF 文件屬性讀取失敗：沒有回傳結果'); }
    // 例外原文可能夾帶文件裡的字（憑證、電話），印出前先遮蔽
    if (res.error) throw new ReadError(maskSecrets(res.error));
    const raw = res.meta || {};
    // PDF 的 Creator 是建立文件的程式（Word、Chrome…），不是 Office 屬性裡的作者，另用一個欄位
    const map = { Title: 'title', Subject: 'subject', Author: 'author', Creator: 'creatorApp', Producer: 'producer', Keywords: 'keywords' };
    const meta = {};
    for (const [k, v] of Object.entries(raw)) if (map[k]) meta[map[k]] = String(v).trim();
    return meta;
  }
  // docx／pptx／xlsx 的屬性在 docProps/core.xml、app.xml，交給 office_xml.py 解析：
  // 固定前綴的正則會漏掉 <d:creator>（前綴由檔案自訂）與 CDATA 包住的值，漏掉的作者欄就被當成檢查過。
  // 沒有這個檔＝沒有屬性（不算缺陷）；有但解不開或格式錯＝讀不到，不可當成檢查過
  const r = runOfficeXml('meta', file, '文件屬性');
  if (r.error) throw new ReadError(maskSecrets(r.error));
  return r.meta;
}

// 產生工具的預設值（references/banned-patterns.json 的 generator_defaults）；讀不到 → 空清單
// （規則檔整份讀不到時 check_doc.js 已經因 ruleCoverage() 不一致而 exit 2，不會走到這裡）
function loadGeneratorDefaults() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'references', 'banned-patterns.json'), 'utf8'));
    const out = [];
    for (const d of (j.generator_defaults && j.generator_defaults.defaults) || []) {
      if (!Array.isArray(d.fields)) continue;
      let test = null;
      if (typeof d.value === 'string') { const v = d.value.toLowerCase(); test = (s) => s.toLowerCase() === v; }
      else if (typeof d.pattern === 'string') {
        let body = d.pattern, flags = '';
        if (body.startsWith('(?i)')) { body = body.slice(4); flags = 'i'; }
        try { const re = new RegExp(body, flags); test = (s) => re.test(s); } catch (_) { continue; }
      }
      if (test) out.push({ source: d.source || '產生工具', fields: d.fields, test });
    }
    return out;
  } catch (_) {
    return [];
  }
}

/**
 * 文件屬性檢查。回傳 null（格式沒有文件屬性）或 { meta, bad, notes }；讀不到丟 ReadError。
 *   硬缺陷：產生工具預設值（欄位＋值成對）、AI 工具名稱、憑證／個資
 *   提醒：沒有標題、標題和檔名看不出關聯（中文檔名、版號、日期會讓這項判不準，所以不擋）
 */
function checkMetadata(file) {
  const meta = readMetadata(file);
  if (meta === null) return null;
  const bad = [], notes = [];
  const defaults = loadGeneratorDefaults();
  const label = (k) => `文件屬性「${META_LABEL[k] || k}」`;
  for (const [field, value] of Object.entries(meta)) {
    if (!value) continue;
    const d = defaults.find((x) => x.fields.includes(field) && x.test(value));
    // 屬性值印出前一律遮蔽憑證／個資：同一欄可能同時含 AI 名稱與密鑰
    const shown = maskSecrets(value);
    if (d) bad.push(`${label(field)}＝「${shown}」是 ${d.source} 沒改掉的預設值（對方按右鍵看內容就看得到，請改成正式名稱或清空）`);
    for (const g of BANNED.groups) {
      if (g.key !== 'ai_tool_names' && !MASK_KEYS.has(g.key)) continue;
      const hits = value.match(new RegExp(g.re.source, g.re.flags.includes('g') ? g.re.flags : g.re.flags + 'g'));
      if (!hits) continue;
      if (MASK_KEYS.has(g.key)) bad.push(`${label(field)}疑似含${g.label}（已遮蔽，請確認是否該出現在交付文件）`);
      else bad.push(`${label(field)}＝「${shown}」含 ${g.label}：${[...new Set(hits)].join('、')}（對外文件不得出現，請改寫或刪除）`);
    }
  }
  if (!meta.title) notes.push('文件屬性沒有標題（PDF 閱讀器的視窗標題會顯示空白或檔名；要不要補由您判斷）');
  else if (!titleRelated(meta.title, file) && !defaults.some((x) => x.fields.includes('title') && x.test(meta.title))) {
    notes.push(`文件屬性的標題「${maskSecrets(meta.title)}」和檔名「${path.basename(file)}」看不出關聯，確認不是別份文件留下的標題（判不準，只提醒）`);
  }
  // 同一個名稱可能同時命中品牌規則（\bCodex\b）與本機收集到的工具名（codex），同一句只報一次
  return { meta, bad: [...new Set(bad)], notes };
}

// 標題與檔名是否有共同的兩字片段（去掉副檔名、數字、空白與標點後比）；檔名太短比不出來時當作有關
function titleRelated(title, file) {
  const norm = (s) => s.toLowerCase().replace(/[\s\d_.,，、。()（）\[\]【】{}「」'"‘’“”\-－—~～+＋&＆:：;；!！?？/\\|#@$%^*=<>]/g, '');
  const t = norm(title), n = norm(path.basename(file, path.extname(file)));
  if (t.length < 2 || n.length < 2) return true;
  // 一邊中文、一邊純英文（「報價單」vs quote-v2.docx）比不出來，當作有關——這是最常見的正常寫法
  const cjk = (x) => /[\u3400-\u9fff]/.test(x);
  if (cjk(t) !== cjk(n)) return true;
  for (let i = 0; i + 2 <= t.length; i++) if (n.includes(t.slice(i, i + 2))) return true;
  return false;
}

// ---------- 待確認事項（客戶來信對照用）----------
// 只做機械部分：列出文件裡每條待確認（第幾段＋原句），「信裡算不算已答覆」由人或模型逐條判讀
const PENDING_RE = /待(?:客戶|對方|貴方|您)?(?:確認|回覆|提供|決定|討論)|待定|(?<![A-Za-z])TB[DC](?![A-Za-z])/i;
// 段落編號只數有字的段：空行（md 的段落間隔、docx 的空段落）不算，才會和人數的一致
function pendingItems(text) {
  const out = [];
  let n = 0;
  for (const t of text) {
    if (!t.trim()) continue;
    n++;
    if (PENDING_RE.test(t)) out.push({ para: n, text: maskSecrets(t.trim()).slice(0, 40) });
  }
  return out;
}

// 信件串文字裡最新的來信日期；找不到 → null
// 有 Date:／寄件日期: 這類標頭就只看標頭——內文的「請於 2026/12/31 前交貨」不是來信日期；
// 沒有標頭才退回內文日期（2026/9/8、2026-09-08、2026年9月8日），並排除晚於明天的日期
function latestMailDate(src) {
  // 2 月 31 日這類不存在的日期，Date 會自動進位成 3 月 3 日，進位過的就不算
  const mk = (y, mo, d) => { const dt = new Date(y, mo - 1, d); return dt.getMonth() === mo - 1 && dt.getDate() === d ? dt : null; };
  const ymd = (s, maxTime) => {
    const out = [];
    for (const m of s.matchAll(/((?:19|20)\d\d)\s*[/\-.年]\s*(\d{1,2})\s*[/\-.月]\s*(\d{1,2})/g)) {
      const dt = mk(+m[1], +m[2], +m[3]);
      if (dt && dt.getTime() <= maxTime) out.push(dt);
    }
    return out;
  };
  // 英文標頭兩種寫法：「Tue, 8 Sep 2026 10:00 +0800」（日 月 年）與「Tuesday, September 8, 2026」（月 日, 年）。
  // 不用 Date.parse：它一樣會把 2 月 31 日進位，沒寫年份時還會補成 2001 年
  // 月名只認完整拼法或標準縮寫（Sep、Sept、September），「Marketing 8」不是 3 月 8 日
  const MON = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const M = '(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';
  const named = (s) => {
    const a = s.match(new RegExp(`\\b(\\d{1,2})\\s+${M}\\.?,?\\s+((?:19|20)\\d\\d)\\b`, 'i'));
    const b = s.match(new RegExp(`\\b${M}\\.?\\s+(\\d{1,2}),?\\s+((?:19|20)\\d\\d)\\b`, 'i'));
    const [d, mon, y] = a ? [a[1], a[2], a[3]] : b ? [b[2], b[1], b[3]] : [];
    const mo = mon ? MON.indexOf(mon.slice(0, 3).toLowerCase()) + 1 : 0;
    return mo ? mk(+y, mo, +d) : null;
  };
  const ds = [];
  // 只吃同一行的空白：「Date:」後面空白時不能跨行抓到下一段內文的日期
  const headers = [...src.matchAll(/^[ \t]*(?:Date|Sent|日期|寄件日期|傳送時間)[ \t]*[:：][ \t]*(.*)$/gim)].map((m) => m[1].trim());
  for (const h of headers) {
    // 每個標頭只取一個日期：先試年月日（2026/9/8、2026年9月8日），再試英文月名
    const d = ymd(h, Infinity)[0] || named(h);
    if (d) ds.push(d);
  }
  // 只要有標頭（不論解不解得出來）就不看內文，內文的交期不是來信日期
  if (!headers.length) ds.push(...ymd(src, Date.now() + 24 * 3600 * 1000));
  if (!ds.length) return null;
  const max = new Date(Math.max(...ds));
  const p = (x) => String(x).padStart(2, '0');
  return { date: `${max.getFullYear()}-${p(max.getMonth() + 1)}-${p(max.getDate())}`, count: ds.length };
}

// ---------- 合約條款比對（新舊兩版）----------
// 只報「消失／數字變動」，不判對錯：報價改版時金額、日期本來就會變，所以一律是提醒
const CLAUSES = [
  { name: '票期', re: /票期|期票/ },
  { name: '付款條件', re: /付款|支付|請款/ },
  { name: '驗收', re: /驗收/ },
  { name: '保固', re: /保固|保修|維護期/ },
  { name: '報價有效期', re: /有效期|報價效期|報價期限/ },
  { name: '稅別', re: /未稅|含稅|稅金|營業稅/ },
  { name: '金額', re: /總價|總計|合計|金額|NT\$|新台幣|元整/ },
  { name: '交期', re: /交期|交貨|完成日|上線日/ },
  { name: '違約', re: /違約|罰則|逾期罰/ },
];
function compareClauses(prevText, text) {
  const notes = [];
  // 數字從遮蔽後的句子取（電話、帳號不印出來），先去掉開頭的項次編號（1.、(2)、3、），
  // 但小數（3.5 付款）不是項次，句點後面接數字就不去；用出現次數比：同一個數字少了一次也算變動
  const nums = (lines) => {
    const m = new Map();
    for (const l of lines) {
      const s = maskSecrets(l).replace(/^\s*[(（]?\d{1,3}\s*(?:[.．](?!\d)|[、)）])\s*/, '');
      for (const x of s.match(/\d[\d,]*(?:\.\d+)?/g) || []) {
        const k = x.replace(/,/g, '');
        m.set(k, (m.get(k) || 0) + 1);
      }
    }
    return m;
  };
  for (const c of CLAUSES) {
    const oldL = prevText.filter((t) => c.re.test(t)), newL = text.filter((t) => c.re.test(t));
    if (!oldL.length) continue;
    if (!newL.length) {
      notes.push(`合約條款「${c.name}」舊版有、新版找不到（舊版原句「${maskSecrets(oldL[0].trim()).slice(0, 30)}」），需確認是否刻意刪除`);
      continue;
    }
    const a = nums(oldL), b = nums(newL);
    const gone = [...a.keys()].filter((x) => (b.get(x) || 0) < a.get(x));
    const added = [...b.keys()].filter((x) => (a.get(x) || 0) < b.get(x));
    if (gone.length || added.length) {
      notes.push(`合約條款「${c.name}」數字變動：舊值 ${gone.slice(0, 5).join('、') || '（無）'} → 新值 ${added.slice(0, 5).join('、') || '（無）'}，確認是有意調整`);
    }
  }
  return notes;
}

function strip(x) { return x.replace(/<[^>]+>/g, ''); }

// =====================================================================
// 以下：任意格式的單檔掃描（check-before 點名檢查、Stop hook 掃確認清單 md 共用）
// =====================================================================
const SUPPORTED = ['.docx', '.pptx', '.xlsx', '.md', '.markdown', '.txt', '.pdf'];
const NL = String.fromCharCode(10);

class ReadError extends Error {}   // 讀不到內容：呼叫端決定是放行（hook）還是明講（check-before）
// 缺執行環境（本機沒有 Python、PDF 缺 pypdf），不是檔案壞了：這個 skill 不只一台機器在用，
// 呼叫端一律提醒「缺什麼、怎麼裝」——不擋，也不可靜默略過
class NeedsPython extends ReadError {
  constructor(what, reason) { super(`${what}未檢查：${reason}`); this.reason = reason; }   // reason：缺什麼、怎麼裝
}
// Python 本身沒跑成（逾時、程序崩潰、查不出套件裝了沒、輸出不完整），不是缺環境、也不是檔案內容的問題：
// 檢查等於沒做，呼叫端不可降成提醒（check-before exit 2；Stop hook 列出檔名提醒）
class PythonFailed extends ReadError {}
const PY_INSTALL = '請安裝 Python 3（https://www.python.org/downloads/ ，Windows 安裝時勾選「Add python.exe to PATH」），裝好後重新檢查';

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
    // 檔案本身讀不了（壞掉、加密）是資料問題：印讀不到的標記與原因，不讓 Python 異常結束（那是執行錯誤）
    'try:',
    '    t = "\\n".join((p.extract_text() or "") for p in pypdf.PdfReader(sys.argv[1]).pages)',
    '    err = None',
    'except Exception as e:',
    '    err = "%s：%s" % (type(e).__name__, e)',
    'print()',   // 先換行，標記才會獨占一行
    'if err is None:',
    '    print(sys.argv[2])',
    '    print(t)',
    'else:',
    '    print(sys.argv[3])',
    '    print(err.replace("\\n", " "))',
  ].join(NL);
  // 正文前先印一行分隔標記、只取標記之後：sitecustomize 這類啟動設定印的字不能混進文件內容
  const BEGIN = 'DR_PDF_TEXT_BEGIN', UNREADABLE = 'DR_PDF_UNREADABLE';
  const lines = runPython(['-c', py, f, BEGIN, UNREADABLE], 'PDF 內容', 'pypdf').split(/\r?\n/);
  // 先找正文標記：正文裡剛好有一行是讀不到的標記字串，也不能誤判成讀不到
  const at = lines.indexOf(BEGIN);
  if (at >= 0) return lines.slice(at + 1);
  const bad = lines.indexOf(UNREADABLE);
  if (bad >= 0) throw new ReadError(`PDF 內容讀不到（${maskSecrets((lines[bad + 1] || '').trim())}）`);
  throw new PythonFailed('PDF 內容讀取失敗：抽文字的輸出不完整');
}

// 找一個能用的 Python：依序試 python／python3／py，能印出約定字串的才算。
// 不看錯誤訊息文字——Windows 沒裝 Python 時 python 是開 Microsoft Store 的捷徑、py 是找不到直譯器的啟動器，
// 各版本印的字不一樣（有的什麼都不印），比對文字既會漏認，也會把路徑剛好含這些字的真正錯誤誤認成沒裝。
// envName 指定的環境變數有值時只試它（測試「找不到 python」用；平常不必設）。同一個設定只探測一次
const pyFound = new Map();
function findPython(envName = 'DR_PYTHON') {
  const key = `${envName}=${process.env[envName] || ''}`;
  if (pyFound.has(key)) return pyFound.get(key);
  const exes = process.env[envName] ? [process.env[envName]] : ['python', 'python3', 'py'];
  let hit = null;
  for (const exe of exes) {
    try {
      // 版本不到 3.8（例如 python 指到 Python 2）印空行：當成不能用，繼續找後面的候選。
      // 先印一個換行：啟動設定印字不換行時，約定字串才會獨占一行
      const out = execFileSync(exe, ['-c', 'import sys; print(); print("DR_PY_OK" if sys.version_info >= (3, 8) else "")'],
        { timeout: 30000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      // 逐行比：sitecustomize 這類啟動設定可能先印別的字
      if (out.toString('utf8').split(/\r?\n/).some((l) => l.trim() === 'DR_PY_OK')) { hit = exe; break; }
    } catch (_) { /* 執行不了或印不出約定字串：不是能用的 Python，換下一個 */ }
  }
  pyFound.set(key, hit);
  return hit;
}

// 套件有沒有裝：只問「找不找得到這個模組」，不真的匯入——裝了但載入失敗（DLL 壞掉）是真正的錯誤，不能當成沒裝。
// 回傳 true／false；問不出明確答案（逾時、程序崩潰）回 null，呼叫端當成讀取失敗，不可說成沒裝
function hasModule(exe, mod) {
  try {
    const out = execFileSync(exe, ['-c', 'import importlib.util, sys; print(); print(importlib.util.find_spec(sys.argv[1]) is not None)', mod],
      { timeout: 30000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const last = out.toString('utf8').trim().split(/\r?\n/).pop().trim();
    return last === 'True' ? true : last === 'False' ? false : null;
  } catch (_) { return null; }
}

// 用找到的 Python 執行（args 原樣傳給 Python）；mod＝要先確認裝了的套件。
// 沒有能用的 Python、套件沒裝 → 丟 NeedsPython；其他失敗一律是讀取失敗，丟 ReadError。what＝檢查項目名稱，放在訊息開頭
function runPython(args, what, mod) {
  const exe = findPython();
  if (!exe) throw new NeedsPython(what, `本機找不到可用的 Python（3.8 以上）。${PY_INSTALL}`);
  const has = mod ? hasModule(exe, mod) : true;
  if (has === null) throw new PythonFailed(`${what}讀取失敗（${exe}）：無法確認套件 ${mod} 是否已安裝`);
  if (!has) throw new NeedsPython(what, `缺 Python 套件 ${mod}，請執行 pip install ${mod}，裝好後重新檢查`);
  try {
    const out = execFileSync(exe, args, { maxBuffer: 64 * 1024 * 1024, timeout: 60000, windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'] });   // 錯誤收進 e.stderr，下面組成一行訊息，不直接印到畫面
    return out.toString('utf8');
  } catch (e) {
    // stderr 的例外訊息可能夾帶文件裡的字，印出前先遮蔽
    throw new PythonFailed(`${what}讀取失敗（${exe}）：${maskSecrets(String(e.stderr || e.message).trim().split(NL).pop())}`);
  }
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
 * 掃一份檔案（docx／pptx／xlsx／md／txt／pdf），跑十項必掃中機器判得了的全部項目。
 * 讀不到內容 → 丟 ReadError（hook 端接住放行；check-before 端明講讀不到）。
 * 回傳 { file, ext, text, paragraphs, bad, notes }。文件屬性不在這裡，另由 checkMetadata() 檢查。
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
    // 有目錄欄位才開 Word 檢查頁碼（開 Word 要數秒；Stop hook 走 scan() 另外呼叫 checkToc，限每次 2 份）
    if (/<w:instrText[^>]*>\s*TOC\b|w:instr="\s*TOC\b/.test(xml)) {
      const toc = checkToc(file);
      if (toc.error) result.notes.push(`目錄頁碼未檢查：${toc.error}（此項屬未驗證）`);
      else if (toc.stale.length) result.bad.push(`目錄未更新：${toc.stale.slice(0, 4).join('；')}` +
        `${toc.stale.length > 4 ? `；另 ${toc.stale.length - 4} 處` : ''}` +
        `（在目錄上按右鍵 → 更新功能變數 → 更新整個目錄）`);
    }
  } else if (ext === '.pptx') {
    const slides = readPptxSlides(file);
    if (!slides) throw new ReadError('讀不到 pptx 內容（不是有效的簡報檔）');
    text = slides.flatMap((s) => s.paras);
    // 整份是圖片的簡報（實例：每頁一張截圖）沒有文字可掃，但疊字、空白頁仍要靠視覺檢查——不當成讀檔失敗
    if (!text.some(t => t.trim())) {
      return { file, ext, paragraphs: 0, bad: [], notes: ['簡報沒有文字（整份是圖片），文字規則沒有可檢查的內容'] };
    }
    // 字級／欄寬另由視覺檢查（visual_check.py）依實際排版判斷，這裡只跑文字規則
    result = scanText(text, null);
  } else if (ext === '.xlsx') {
    const x = readXlsx(file);
    if (!x) throw new ReadError('讀不到 xlsx 內容（不是有效的 Excel 檔）');
    // 有任何部分讀不到就整份不算檢查過：只掃其餘部分就放行，讀不到的那塊裡有什麼都看不到
    if (x.broken.length) throw new ReadError(`讀不到 xlsx 的 ${maskSecrets(x.broken.join('、'))}（檔案缺損或 XML 格式錯誤）`);
    // 工作表名稱也是對方看得到的文字（「內部試算」「折扣推導」這類名稱常藏在分頁上）
    text = [...x.sheets.map((s) => s.name), ...x.sheets.flatMap((s) => s.rows), ...x.orphan, ...x.comments];
    if (!text.some(t => t.trim())) throw new ReadError('xlsx 沒有可讀的文字');
    result = scanText(text, null);
    // 表格的資料格常見 V2、S3、#4 這類版本、規格、項次代碼，是資料不是正文裡沒定義的代號：鐵則 4 對 xlsx 降為提醒
    const codeHits = result.bad.filter((b) => b.startsWith('鐵則4 '));
    if (codeHits.length) {
      result.bad = result.bad.filter((b) => !b.startsWith('鐵則4 '));
      result.notes.push(...codeHits.map((b) => b + '（表格資料常見代碼，是資料就不用改）'));
    }
    const hidden = x.sheets.filter((s) => s.state !== 'visible');
    if (hidden.length) {
      result.notes.push(`有隱藏工作表：${hidden.map((s) => `「${maskSecrets(s.name)}」${s.state === 'veryHidden' ? '（深度隱藏，Excel 介面取消隱藏看不到、但檔案裡還在）' : ''}`).join('、')}` +
        '（對方取消隱藏就看得到，確認裡面沒有內部推導或不該給的資料；內容已一併掃描）');
    }
    if (x.comments.length) result.notes.push(`有 ${x.comments.length} 則儲存格註解（對方滑過儲存格就看得到，內容已一併掃描，確認可以給對方）`);
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
    text,   // 逐段文字：check_doc.js 的來信對照、條款比對要用
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
function checkToc(file, timeoutMs) {
  // timeoutMs：呼叫端的時間預算（Stop hook 要把總時間壓在 hooks.json 的逾時以內）；環境變數僅供測試
  const limit = Number(process.env.DR_TOC_TIMEOUT_MS) || timeoutMs || 90000;
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
        maxBuffer: 16 * 1024 * 1024, timeout: limit,
        windowsHide: true }).toString('utf8').trim();
  } catch (e) {
    // 逾時或失敗：PowerShell 的 finally 不保證跑到，補砍這支腳本自己啟動的 Word
    try {
      for (const pid of fs.readFileSync(pidFile, 'ascii').split(',').map((s) => s.trim()).filter((s) => /^\d+$/.test(s))) {
        try { execFileSync('taskkill', ['/PID', pid, '/F'], { windowsHide: true, stdio: 'ignore' }); } catch (_) { /* 已結束 */ }
      }
    } catch (_) { /* 沒有 pid 檔：Word 還沒啟動就失敗 */ }
    const why = e.code === 'ETIMEDOUT' || e.signal ? `逾時 ${Math.round(limit / 1000)} 秒`
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
  BANNED, SUPPORTED, META_EXTS, ReadError, NeedsPython, PythonFailed, PY_INSTALL, findPython, hasModule,
  scan, scanText, scanFile, extraChecks, mdToLines, pdfToLines,
  checkStyle, checkTables, checkToc, harvestLocalAiNames, readDocXml, readPptxSlides, readXlsx, openZip, strip,
  readMetadata, checkMetadata, loadGeneratorDefaults, pendingItems, latestMailDate, compareClauses, maskSecrets,
};
