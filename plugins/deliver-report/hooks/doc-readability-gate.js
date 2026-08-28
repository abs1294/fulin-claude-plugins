#!/usr/bin/env node
/**
 * doc-readability-gate — deliver-report plugin 的 Stop hook
 *
 * 目的：把 references/document-readability.md 的鐵則中「機器判得準」的那幾條，
 *       做成交付前的最後一道機械閘。純 prompt 規範擋不住——實證：該文件寫完
 *       鐵則 8「修完一類要全文重掃」之後，作者接著又在同一批文件犯了三次同類問題。
 *
 * 判得準（會擋）：
 *   鐵則 3  編號連續性：缺號、小數點式編號（四之二）
 *   鐵則 4  未定義代號：§N / #N / 字母-數字 / S,V 編號，且全文無定義句
 *   鐵則 5  異動紀錄用語：本次查核／本文件初版／原文件／改版／第 N 輪
 *   鐵則 8  交叉引用失效：見第N節／見步驟X 指不到
 *   鐵則 9  樣式一致性：同級標題字級不一、主標小於子標、⚠※◆ 樣式分歧
 *   鐵則 9d 表格窄欄塞長字（<1500 dxa 放 >10 字，會擠成直排）
 *
 * 判不準（只提醒，不擋）：
 *   鐵則 1 兩邊對照 / 2 資訊放一起 / 6 能自查卻丟給讀者 / 10 該腳本化
 *
 * 觸發條件：本回合（最後一個 promptId 的區段）有調用 deliver-report skill 才啟動。
 *   ——不是「session 動過 docx」。舊版用後者，導致改過文件之後每一句話都跑檢查、
 *   連跟文件無關的對話都被擋。交付檢查該綁「交付動作」，不是綁「檔案存在」。
 *
 * ★ 最高原則：FAIL-OPEN。任何讀檔失敗、解析例外、判斷不確定 → 一律放行。
 *   這 hook 會影響 session 能不能結束，寧可漏擋，絕不卡死。
 * ★ 不設擋下次數上限：觸發條件已收窄成「本回合調用過本 skill」，
 *   每次交付都該檢查。舊版的「擋 2 次就放行」會讓第三次交付沒人把關。
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

let stdinData = '';
process.stdin.on('data', (c) => (stdinData += c));
process.stdin.on('end', () => {
  try { main(stdinData); } catch (_) { allow(); }
});

function allow() { process.exit(0); }
function writeThenExit(obj) {
  let json;
  try { json = JSON.stringify(obj); } catch (_) { return allow(); }
  try { process.stdout.write(json, () => process.exit(0)); } catch (_) { allow(); }
}
function block(reason) { writeThenExit({ decision: 'block', reason }); }
function warn(msg) { writeThenExit({ systemMessage: msg }); }

function main(raw) {
  let payload = {};
  try { payload = JSON.parse(raw || '{}'); } catch (_) { return allow(); }

  const cwd = payload.cwd || process.cwd();

  // 只在「本回合調用過 deliver-report skill」時才啟動。
  // 判不出來（沒有 transcript_path、讀檔失敗、解析失敗）一律放行。
  if (calledSkillThisTurn(payload.transcript_path) !== true) return allow();

  const docs = recentDocx(cwd);
  if (!docs.length) return allow();

  let findings = [];
  for (const d of docs) {
    let r;
    try { r = scan(d); } catch (_) { continue; }   // 單檔失敗 → 略過該檔
    if (r && r.length) findings.push({ file: path.basename(d), items: r });
  }

  if (!findings.length) return allow();

  const lines = [];
  lines.push('【交付前機械閘】文件易讀性檢查未通過，請修正後再結束：');
  lines.push('');
  for (const f of findings) {
    lines.push(`■ ${f.file}`);
    for (const it of f.items) lines.push(`   · ${it}`);
    lines.push('');
  }
  lines.push('依據：deliver-report skill 的 references/document-readability.md');
  lines.push('');
  lines.push('機器判不了、需你自己確認的四條：');
  lines.push('  1 讀者是否要兩邊對照才能做完一件事？');
  lines.push('  2 同一項要改的東西是否散在正文與備註兩處？');
  lines.push('  6 有沒有「待確認」其實你自己查得到？');
  lines.push(' 10 有沒有機械性步驟該寫成腳本而不是叫人手動做？');
  block(lines.join('\n'));
}

// ---------- 找出這個 session 動過的 .docx ----------
function calledSkillThisTurn(tp) {
  // 回傳 true = 本回合確實調用了 deliver-report skill；
  //       false = 確實沒有；null = 判不出來（呼叫端一律放行）。
  if (!tp) return null;
  let raw;
  try { raw = fs.readFileSync(tp, 'utf8'); } catch (_) { return null; }

  const lines = raw.split('\n');
  // 由後往前找最後一個 user 訊息的 promptId——那是本回合的起點。
  // 用 promptId 而不是「最後 N 行」：一個回合可能有數十次工具往返，行數不固定。
  let pid = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (!l) continue;
    let o;
    try { o = JSON.parse(l); } catch (_) { continue; }
    if (o && o.type === 'user' && o.promptId) { pid = o.promptId; break; }
  }
  if (!pid) return null;

  for (const l of lines) {
    if (!l) continue;
    // 先用字串快篩，避免每行都 JSON.parse（transcript 可達數十 MB）
    if (l.indexOf(pid) === -1) continue;
    if (l.indexOf('deliver-report') === -1) continue;
    let o;
    try { o = JSON.parse(l); } catch (_) { continue; }
    if (o.promptId !== pid) continue;
    const c = o.message && o.message.content;
    if (!Array.isArray(c)) continue;
    for (const b of c) {
      if (b && b.type === 'tool_use' && b.name === 'Skill' &&
          b.input && typeof b.input.skill === 'string' &&
          b.input.skill.indexOf('deliver-report') !== -1) {
        return true;
      }
    }
  }
  return false;
}

function recentDocx(cwd) {
  const out = [];
  const seen = new Set();
  const cutoff = Date.now() - 6 * 3600 * 1000;   // 6 小時內改過的
  const dirs = [cwd, path.join(cwd, '_work'), path.join(cwd, 'docs'), path.join(cwd, 'output')];
  for (const dir of dirs) {
    let names;
    try { names = fs.readdirSync(dir); } catch (_) { continue; }
    for (const n of names) {
      if (!n.toLowerCase().endsWith('.docx')) continue;
      if (n.startsWith('~$')) continue;              // Word 暫存檔
      const p = path.join(dir, n);
      if (seen.has(p)) continue;
      try {
        const st = fs.statSync(p);
        if (st.mtimeMs >= cutoff && st.size > 0) { out.push(p); seen.add(p); }
      } catch (_) { /* 略過 */ }
    }
  }
  return out.slice(0, 4);   // 最多檢查 4 份，避免逾時
}

// ---------- 掃描單一 .docx ----------
function scan(file) {
  const xml = readDocXml(file);
  if (!xml) return null;                            // 讀不到 → 不擋

  const paras = [...xml.matchAll(/<w:p\b(?:(?!<\/w:p>).)*?<\/w:p>/gs)].map(m => m[0]);
  if (paras.length < 20) return null;               // 太短、不像交付文件 → 不擋
  const text = paras.map(strip);
  const full = text.join('\n');

  const bad = [];

  // ---- 鐵則 5：異動紀錄用語 ----
  const banned = ['本次查核', '本文件初版', '原文件', '上一版', '第 N 輪', '本次清點'];
  const hitBanned = banned.filter(w => full.includes(w));
  if (hitBanned.length) bad.push(`鐵則5 異動紀錄用語：${hitBanned.join('、')}`);

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
  const styleIssues = checkStyle(paras);
  bad.push(...styleIssues);

  // ---- 鐵則 9d：表格窄欄塞長字 ----
  const narrow = checkTables(xml);
  if (narrow.length) {
    bad.push(`鐵則9 表格窄欄塞長字（會擠成直排）：${narrow.slice(0, 3).join('；')}`);
  }

  return bad;
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
      { maxBuffer: 64 * 1024 * 1024, timeout: 12000, windowsHide: true });
    const s = buf.toString('utf8');
    return s.includes('<w:p') ? s : null;
  } catch (_) { return null; }
}

function strip(x) { return x.replace(/<[^>]+>/g, ''); }

// ---------- 擋次計數 ----------
