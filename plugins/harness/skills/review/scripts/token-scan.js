#!/usr/bin/env node
// token-scan.js — 健檢第 1 步的「token 花費」面向（K）：範圍內哪些 session 花得特別多、花在哪。
//
// 用法：node token-scan.js <落點> [--since YYYY-MM-DD] [--transcripts <目錄>] [--usage-detail <檔>] [--records <目錄>] [--out <檔.json>] [--top N]
//
// 用量與金額一律來自 cc-statusline（1.10.0 起），這支腳本不讀對話紀錄裡的用量、不自己計價
// （規則在 cc-statusline 的 docs/data-boundary.md）。三個來源，分工不同：
//   1. 明細檔 ~/.claude/usage-data/cc-statusline-usage-detail.json：排名、總額、按日、按模型、
//      輸入／輸出／快取寫入／快取讀取四項拆分、thinking token。
//   2. 每則用量紀錄 ~/.claude/usage-data/records/：一行一則，已去重、已計價。診斷排名前面的 session 時，
//      拿紀錄的（檔, 行）去對逐字紀錄的那一列；對不到的列是重複的（同一則回應拆成多列、複製出來的對話帶著的舊內容）
//      或還沒收進去，不算用量。
//   3. 逐字紀錄（含 subagent 的）：只看內容與時序——工具結果大小、重複讀檔、使用者回合數、壓縮標記、cwd。
// 開場固定底的花費也在這裡算：明細檔的回應次數與模型把 subagent 混在一起，而 subagent 不背主對話的固定底，
// 所以主對話的回應與模型看每則用量紀錄。
// 沒有明細檔、沒有紀錄、版本太舊、裡面沒有這個專案：沒有金額。輸出的 source 是 'none'、noData 寫原因，exit 0，不退回自己算。
//
// 金額有兩種口徑，輸出的 `fields` 逐欄寫明：
//   範圍內（只算 --since 當天起的花費）：totals.cost、totals.dayCost、byDay。前後兩次健檢要比就比這些。
//   整個 session（含它在 --since 之前的花費）：totals.sessionsFullCost、medianPerSession、top5Share、breakdown、flagged、allSessions。
//
// 只讀。不執行任何專案程式、不寫專案。輸出不含對話、指令、工具結果的原文，只有數字、工具名稱、
// 檔名（專案內相對路徑；專案外一律寫「（專案外）」）與出處（檔名:行號）。例外是 root、transcripts、usageDetail、records 四欄與 noData 的說明：寫這次讀的來源路徑，給人核對。
//
// 結束碼：0 正常（沒有金額也是 0，看 noData）；2 參數或目錄錯誤。

'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const root = args[0] && !args[0].startsWith('--') ? path.resolve(args[0]) : null;
if (!root) { console.error('用法：node token-scan.js <落點> [--since YYYY-MM-DD] [--transcripts <目錄>] [--usage-detail <檔>] [--records <目錄>] [--out <檔>] [--top N]'); process.exit(2); }
const since = opt('--since');
if (since && !/^\d{4}-\d{2}-\d{2}$/.test(since)) { console.error('--since 要寫成 YYYY-MM-DD：' + since); process.exit(2); }
const TOP = Math.max(1, Number(opt('--top')) || 5);
const tdir = opt('--transcripts') ? path.resolve(opt('--transcripts'))
  : path.join(os.homedir(), '.claude', 'projects', root.replace(/[^A-Za-z0-9]/g, '-'));
let tdirOk = false; try { tdirOk = fs.statSync(tdir).isDirectory(); } catch {}
if (!tdirOk) {
  console.error('找不到逐字紀錄目錄：' + tdir + '\n'
    + (opt('--transcripts') ? '這是 --transcripts 指定的路徑，請確認它存在、而且是目錄。\n'
      : '這個路徑是由落點換算的（英數字以外的字元換成 -）。常見原因：落點不是當初開 Claude Code 的那個資料夾（例如開在它的上層或子目錄）、專案搬過或改過名、逐字紀錄放在別處。\n')
    + '沒有產生結果檔。請用 --transcripts <目錄> 指定這個專案的逐字紀錄目錄後重跑（review-collect.js 用的是同一個目錄、同一個參數）。');
  process.exit(2);
}
const USAGE_DIR = path.join(os.homedir(), '.claude', 'usage-data');
const DETAIL_PATH = opt('--usage-detail') ? path.resolve(opt('--usage-detail')) : path.join(USAGE_DIR, 'cc-statusline-usage-detail.json');
const RECORDS_DIR = opt('--records') ? path.resolve(opt('--records')) : path.join(USAGE_DIR, 'records');

const GAP_5M = 5 * 60e3, GAP_1H = 60 * 60e3;
const BIG_CACHE_BUILD = 20000;     // 單次回應建立的快取 token ≥ 這個數才算「重建」
const BIG_RESULT_CHARS = 20000;    // 單一工具結果 ≥ 這個字數才列
const BIG_CONTEXT = 200000;        // 單次回應的上下文 ≥ 這個 token 數算「大上下文」（啟發式門檻，只用來看花費集中在哪）
const NEVER_COMPACTED_CTX = 100000; // 主對話上下文到過這麼多 token 還沒壓縮過才值得看（啟發式門檻；小上下文本來就不用壓縮）
const LONG_LIVED_MIN = 24 * 60;    // session 從第一次到最後一次回應跨過這麼多分鐘算「長壽」
const STALE_MS = 48 * 3600 * 1000, BEHIND_MS = 6 * 3600 * 1000;   // 明細檔最多 15 分鐘更新一次；比用量紀錄舊這麼多就是更新不了
const DIFF_SHARE = 0.05, DIFF_ABS = 0.05;   // 對到逐字紀錄的金額與明細檔差超過 5% 而且超過 0.05 美元才說（便宜的 session 差幾分錢沒有意義）
const CHUNK = 4 * 1024 * 1024, LINE_MAX = 256 * 1024 * 1024;

const localDay = (ts) => { const d = new Date(ts); const p = (n) => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); };
const validTs = (t) => typeof t === 'string' && !isNaN(new Date(t));
const num = (x) => { const n = Number(x); return Number.isFinite(n) && n > 0 ? n : 0; };
const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const sum = (a, f) => a.reduce((s, x) => s + f(x), 0);
const ratio = (a, b) => b ? +(a / b).toFixed(2) : 0;
const slash = (x) => String(x).replace(/\\/g, '/');
// 檔案系統預設不分大小寫的是 Windows 與 macOS；Linux 分（大小寫不同是另一個專案、另一個檔）
const FOLD = process.platform === 'win32' || process.platform === 'darwin';
const foldCase = (s) => (FOLD ? s.toLowerCase() : s);
const rootS = foldCase(slash(root));
// 專案內回相對路徑；專案外回「（專案外）」加上路徑雜湊（同一個檔同一個 key，不同檔不同 key，但看不出檔名）。
// 先正規化（吃掉 .. 與 .），否則 <root>/../x 會以「看起來在專案內」的樣子洩漏專案外的檔名；非絕對路徑照專案根解析
const OUT = '（專案外）';
const relPath = (p) => {
  let s = slash(p);
  if (!/^(?:[A-Za-z]:)?\//.test(s)) s = rootS + '/' + s;
  s = (s.startsWith('//') ? '/' : '') + path.posix.normalize(s);   // normalize 會把 UNC 開頭的兩個斜線併成一個
  if (foldCase(s).startsWith(rootS + '/')) return s.slice(rootS.length + 1);
  return OUT + require('crypto').createHash('md5').update(foldCase(s)).digest('hex').slice(0, 8);
};
const oneLine = (x) => x.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '?');   // 檔名可以有換行：輸出只佔一行
const shownPath = (k) => k.startsWith(OUT) ? OUT + '的某個檔' : oneLine(k);
const rel = (f) => oneLine(slash(path.relative(tdir, f)));   // 出處用相對逐字紀錄目錄的路徑（subagent 檔要帶 <session>/subagents/…）
// 遞迴找 jsonl（subagents 底下還有 workflows/wf_*/agent-*.jsonl）
function walkJsonl(d) { const out = []; let ents = []; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return out; } for (const e of ents) { const p = path.join(d, e.name); if (e.isDirectory()) out.push(...walkJsonl(p)); else if (e.name.endsWith('.jsonl')) out.push(p); } return out; }
// 不同資料夾可能換算成同一個逐字紀錄目錄名（英數字以外都變 -），要看列上的 cwd 才知道是不是這個專案；判法同 review-collect.js
const normP = (x) => foldCase(path.resolve(x));
const rootN = normP(root);
const isMine = (c) => normP(c) === rootN || normP(c).startsWith(rootN + path.sep);

// ── cc-statusline 的明細檔與每則用量紀錄 ──
const notes = [];
const dest = opt('--out');
function emit(result, say = console.log) {
  const json = JSON.stringify(result, null, 2);
  if (!dest) { say(json); return; }
  try { fs.mkdirSync(path.dirname(path.resolve(dest)), { recursive: true }); fs.writeFileSync(dest, json); } catch (e) { console.error('寫不進 --out 指定的檔：' + path.resolve(dest) + '（' + e.code + '）'); process.exit(2); }
  say(JSON.stringify({ source: result.source, unit: result.unit, noData: result.noData, totals: result.totals, breakdown: result.breakdown, flagged: result.flagged.map((s) => ({ session: s.session.slice(0, 8), day: s.day, cost: s.cost, signals: s.signals.map((x) => x.code) })), notes: result.notes }, null, 2));
  say('完整結果：' + path.resolve(dest));
}
const iso = (ms) => Number.isFinite(ms) && !isNaN(new Date(ms)) ? new Date(ms).toISOString() : null;
// 沒有金額：說原因就結束，不自己讀用量
function noData(code, why, fix) {
  const message = '沒有金額，' + (fix || '請安裝或更新 cc-statusline 到 1.10.0。已經是 1.10.0 的，開一次對話、等它在背景掃完（第一次可能要幾分鐘）再重跑') + '。原因：' + why;
  emit({ source: 'none', unit: null, noData: { code, message }, root: slash(root), transcripts: slash(tdir), usageDetail: slash(DETAIL_PATH), usageDetailAt: null, records: slash(RECORDS_DIR), recordsAt: null, since: since || null, fields: {},
    totals: { sessions: null, cost: null, dayCost: null, sessionsFullCost: null, medianPerSession: null, top5Share: null }, breakdown: null, byDay: {}, flagged: [], allSessions: [], notes: [message] }, (s) => fs.writeSync(1, s + '\n'));   // 馬上要結束，直接寫出去
  process.exit(0);
}
// 沒有 v＝產生它的版本太舊；比 1 大照用：v 加一只代表多了欄位，舊欄位的意思不變（cc-statusline 的 docs/data-boundary.md）
const readPublic = (f, what, ok) => {
  let j;
  try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) {
    if (e && e.code === 'ENOENT') noData('missing', '沒有 cc-statusline 的' + what + '（' + slash(f) + '）');
    noData('unreadable', '讀不了 cc-statusline 的' + what + '（' + slash(f) + '，' + ((e && e.code) || '內容不完整') + '）', '請檢查那個檔的讀寫權限與磁碟空間；內容不完整的話更新 cc-statusline 到 1.10.0 以上，開一次對話讓它在背景重寫');
  }
  if (!isObj(j) || !Number.isFinite(j.v) || j.v < 1 || !ok(j)) noData('version', 'cc-statusline 的' + what + '格式不認得（v：' + (isObj(j) && own(j, 'v') ? String(j.v).slice(0, 20) : '沒有') + '）');
  return j;
};
const D = readPublic(DETAIL_PATH, '明細檔', (j) => isObj(j.byProject) && Array.isArray(j.sessions));
const M = readPublic(path.join(RECORDS_DIR, 'meta.json'), '每則用量紀錄', (j) => isObj(j.prices) && isObj(j.modelIds));
// 明細檔的專案名是磁碟上的資料夾名；落點打的大小寫可能不同（c:\ 對 C--）。名字太長的，cc-statusline 截短加雜湊
const longName = (p) => p.length > 180 ? p.slice(0, 170) + '-' + require('crypto').createHash('md5').update(p).digest('hex').slice(0, 8) : p;
const projDir = path.basename(tdir), projDirs = [projDir, longName(projDir)];
const sameProj = (k) => projDirs.includes(k) || (FOLD && k.toLowerCase() === projDir.toLowerCase());
const projKey = projDirs.find((k) => own(D.byProject, k)) || Object.keys(D.byProject).find(sameProj) || null;
const PD = projKey != null && isObj(D.byProject[projKey]) ? D.byProject[projKey] : null;
if (!PD) noData('project', 'cc-statusline 的明細檔裡沒有這個專案（' + projDir + '）');
const recordFiles = [];
try {
  for (const m of fs.readdirSync(RECORDS_DIR).filter((x) => /^\d{4}-\d{2}$/.test(x) && fs.statSync(path.join(RECORDS_DIR, x)).isDirectory()).sort())
    for (const f of fs.readdirSync(path.join(RECORDS_DIR, m))) if (f.endsWith('.jsonl') && (f.slice(0, -6) === projKey || sameProj(f.slice(0, -6)))) recordFiles.push(path.join(RECORDS_DIR, m, f));
} catch (e) { noData('unreadable', '讀不了 cc-statusline 的每則用量紀錄（' + slash(RECORDS_DIR) + '，' + (e && e.code) + '）', '請檢查那個目錄的讀寫權限'); }
if (!recordFiles.length) noData('project', 'cc-statusline 的每則用量紀錄裡沒有這個專案（' + projDir + '）');
if (Date.now() - D.at > STALE_MS) notes.push('cc-statusline 明細檔是 ' + Math.round((Date.now() - D.at) / 3600e3) + ' 小時前產生的，最近的花費可能還沒算進去');
if (M.at - D.at > BEHIND_MS) notes.push('cc-statusline 明細檔比它的用量紀錄舊 ' + Math.round((M.at - D.at) / 3600e3) + ' 小時：總額與排名停在明細檔那時（可能是明細檔寫不進去，看 ' + slash(path.dirname(DETAIL_PATH)) + ' 的寫入權限與磁碟空間）');
const money = (n) => Math.round(n * 100) / 100;
const moneyMap = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, money(v)]));

// 一則紀錄的單價（每百萬 token 美元）：只用來拆一則裡面的快取寫入與快取讀取，整則的金額直接用紀錄的
const priceOf = (r) => {
  const k = r.key || (own(M.modelIds, r.model) && M.modelIds[r.model]) || r.model;
  const p = k && own(M.prices, k) ? M.prices[k] : null;
  return isObj(p) && ['cw', 'cw1h', 'cr'].every((x) => Number.isFinite(p[x])) ? p : null;
};
const unpriced = new Set(), approx = new Set();
const cwVal = (r) => { const pr = priceOf(r); return pr ? (r.cw5 * pr.cw + r.cw1 * pr.cw1h) / 1e6 : 0; };
const readPrice = (r) => { const pr = priceOf(r); return pr ? pr.cr / 1e6 : 0; };
const ctxOf = (r) => r.in + r.rd + r.cw5 + r.cw1;

// ── 逐字紀錄 ──
const unreadable = new Map();   // 相對路徑 → 錯誤代碼
// 逐塊讀、逐列解析：整檔讀成一個字串，超過字串長度上限的檔會整個丟掉。cb 回 false 就停
function eachRow(f, cb) {
  let bad = 0, line = 0, pieces = [], size = 0, skip = false, go = true, fd;
  const emit = (b) => {
    line++;
    let o;
    try { let t = b.toString('utf8'); if (line === 1) t = t.replace(/^\uFEFF/, ''); if (!t.trim()) return; o = JSON.parse(t); } catch { bad++; return; }
    if (!isObj(o)) { bad++; return; }
    o.__line = line;
    if (cb(o) === false) go = false;
  };
  const flush = (tail) => {
    const b = pieces.length ? Buffer.concat([...pieces, tail]) : tail;
    const dropIt = skip; pieces = []; size = 0; skip = false;
    if (dropIt) { line++; bad++; } else emit(b);
  };
  try {
    fd = fs.openSync(f, 'r');
    const buf = Buffer.allocUnsafe(CHUNK);
    while (go) {
      const n = fs.readSync(fd, buf, 0, CHUNK, null);
      if (!n) break;
      let at = 0;
      while (go) {
        const nl = buf.subarray(0, n).indexOf(10, at);
        if (nl < 0) break;
        flush(buf.subarray(at, nl)); at = nl + 1;
      }
      if (go && at < n && !skip) {
        pieces.push(Buffer.from(buf.subarray(at, n))); size += n - at;
        if (size > LINE_MAX) { skip = true; pieces = []; }
      }
    }
    if (go && (pieces.length || skip)) flush(Buffer.alloc(0));
  } catch (e) { unreadable.set(rel(f), (e && e.code) || '讀取失敗'); }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
  return bad;
}
const blocksOf = (o) => { const c = o.message && o.message.content; return Array.isArray(c) ? c.filter(isObj) : (typeof c === 'string' ? [{ type: 'text', text: c }] : []); };
const resultLen = (b) => typeof b.content === 'string' ? b.content.length : (Array.isArray(b.content) ? sum(b.content, (x) => x && typeof x.text === 'string' ? x.text.length : 0) : 0);
// 模型的回應；<synthetic> 是程式自己補的列（沒有呼叫模型）
const isResponse = (o) => o.type === 'assistant' && isObj(o.message) && o.message.model !== '<synthetic>';
// 每則用量紀錄：逐字紀錄（相對逐字紀錄目錄）→ 行號 → 紀錄。只收要看的 session
const recs = new Map();
let badRecords = 0;
function loadRecords(sids) {
  for (const f of recordFiles) badRecords += eachRow(f, (r) => {
    if (!sids.has(r.sid) || !Number.isFinite(r.ts) || !Number.isFinite(r.line)) return;
    const k = r.file || r.sid + '.jsonl';
    if (!recs.has(k)) recs.set(k, new Map());
    if (!recs.get(k).has(r.line)) recs.get(k).set(r.line, []);   // 逐字紀錄被改寫過，同一行可以有不只一則：用 message.id 對
    recs.get(k).get(r.line).push(r);
  });
  const gone = recordFiles.find((f) => unreadable.has(rel(f)));
  if (gone) noData('unreadable', '讀不了 cc-statusline 的每則用量紀錄（' + slash(gone) + '，' + unreadable.get(rel(gone)) + '）', '請檢查那個檔的讀取權限；一時被占用的話再跑一次（要 cc-statusline 到 1.10.0 以上）');   // 少一部分的不能當成全部
}
const keyOf = (f) => slash(path.relative(tdir, f));
// 對到的要是同一則：逐字紀錄被改寫過的話行號會跑掉
const recordOf = (f, o) => {
  const m = recs.get(keyOf(f)), rs = m && isObj(o.message) ? m.get(o.__line) : null;
  return (rs && (rs.find((r) => r.id && r.id === o.message.id) || rs.find((r) => !r.id))) || null;
};
const reqOf = (r, o) => ({ ts: r.ts, line: r.line, model: r.model || null, key: r.key || null, side: o.isSidechain === true, flag: r.flag || null,
  in: num(r.in), out: num(r.out), cw5: num(r.cw5), cw1: num(r.cw1), rd: num(r.rd), think: num(r.think), v: num(r.cost), id: r.id || (r.file || r.sid) + ':' + r.line });

// 只讀到夠判斷為止：第一個 cwd、有沒有任何一列是這個專案、主對話第一則回應是哪一列（它的上下文＝開場固定底）、是不是從壓縮摘要起頭
const headCache = new Map();
function headInfo(f, needFirst) {
  if (headCache.has(f)) return headCache.get(f);
  const h = { firstCwd: null, anyMine: false, first: null, fromSummary: false };
  eachRow(f, (o) => {
    if (typeof o.cwd === 'string' && o.cwd) { if (!h.firstCwd) h.firstCwd = o.cwd; if (!h.anyMine && isMine(o.cwd)) h.anyMine = true; }
    if (needFirst && !h.first) {
      if (o.isCompactSummary || (o.type === 'system' && o.subtype === 'compact_boundary')) h.fromSummary = true;
      if (isResponse(o) && !o.isSidechain) h.first = { __line: o.__line, message: { id: o.message.id } };
    }
    return !(h.anyMine && (!needFirst || h.first));
  });
  h.other = !!h.firstCwd && !h.anyMine;
  headCache.set(f, h);
  return h;
}

// 一個檔（主對話或 subagent）→ { reqs: [用量紀錄，見 reqOf], toolCount, results, reads, compactions, userTurns, otherRows, lost }
// reqs 只有對得到用量紀錄的列；內容（工具呼叫、結果、讀檔）每一列都看，同一則回應拆成多列時後面那幾列的工具呼叫也算
function scanFile(f, isMain) {
  const reqs = [], matched = new Set();
  const toolNameById = new Map();    // tool_use id → name
  const results = [];                // { tool, chars, at }
  const toolCount = {};
  const reads = {};                  // 相對路徑 → 次數
  let compBoundary = 0, compSummary = 0, userTurns = 0, firstUserText = null, entrypoint = null, otherRows = 0;
  // 沒有 cwd 的列沿用前一列；開頭沒有 cwd 的列沿用第一個出現的 cwd
  let cur = headInfo(f, isMain).firstCwd, mine = !cur || isMine(cur);
  const bad = eachRow(f, (o) => {
    if (typeof o.cwd === 'string' && o.cwd && o.cwd !== cur) { cur = o.cwd; mine = isMine(cur); }
    const r = recordOf(f, o);
    if (r) matched.add(r);
    if (!mine) { otherRows++; return; }
    if (r) reqs.push(reqOf(r, o));
    if (!entrypoint && o.entrypoint) entrypoint = o.entrypoint;
    if (o.type === 'assistant' && isObj(o.message)) {
      for (const b of blocksOf(o)) if (b.type === 'tool_use') {
        toolNameById.set(b.id, b.name);
        toolCount[b.name] = (toolCount[b.name] || 0) + 1;
        if (b.name === 'Read' && b.input && typeof b.input.file_path === 'string') { const r = relPath(b.input.file_path); reads[r] = (reads[r] || 0) + 1; }
      }
    } else if (o.type === 'user') {
      if (o.isCompactSummary) compSummary++;
      let hasText = false;
      for (const b of blocksOf(o)) {
        if (b.type === 'tool_result') {
          const n = resultLen(b);
          if (n >= BIG_RESULT_CHARS) results.push({ tool: toolNameById.get(b.tool_use_id) || '（未知）', chars: n, at: rel(f) + ':' + o.__line });
        } else if (b.type === 'text' && b.text) { hasText = true; if (!firstUserText && !o.isMeta) firstUserText = String(b.text); }
      }
      if (hasText && !o.isMeta && !o.isCompactSummary && !o.isSidechain) userTurns++;
    } else if (o.type === 'system' && o.subtype === 'compact_boundary') compBoundary++;
  });
  const all = recs.get(keyOf(f));
  return { file: f, bad, reqs, lost: all ? sum([...all.values()], (rs) => rs.length) - matched.size : 0, toolCount, results, reads, compactions: compBoundary || compSummary, userTurns, firstUserText, entrypoint, otherRows };
}

// 一個 session 的主檔與 subagent 檔。同一則回應同時在主檔與 subagent 檔時，用量紀錄只記一次、歸 subagent（主檔那份是回音）
let badTotal = 0, lostTotal = 0;
const otherRowsBy = [], skippedSubs = [];
function loadSession(sid, f) {
  const main = scanFile(f, true);
  const parts = [main];
  if (main.otherRows) otherRowsBy.push({ sid, n: main.otherRows });
  for (const p of walkJsonl(path.join(tdir, sid, 'subagents'))) {
    const h = headInfo(p, false);
    // 整份都不是這個專案的，或沒有 cwd 而主對話切過別的專案（分不出是誰派的）：不算
    if (h.other || (!h.firstCwd && main.otherRows)) { skippedSubs.push(rel(p)); continue; }
    parts.push(scanFile(p, false));
  }
  badTotal += sum(parts, (p) => p.bad); lostTotal += sum(parts, (p) => p.lost);
  return parts;
}

// 回傳的金額都不捨入（比較、占比、排名用原值），輸出前才捨入
function summarize(parts) {
  const main = parts[0];
  const reqs = parts.flatMap((p) => p.reqs).sort((a, b) => a.ts - b.ts || a.line - b.line);
  for (const r of reqs) { if (r.flag === 'unpriced') unpriced.add(r.id); else if (r.flag === 'approx') approx.add(r.id); }
  const isSub = new Set(parts.slice(1).flatMap((p) => p.reqs));
  const mainReqs = reqs.filter((r) => !isSub.has(r) && !r.side);
  const tot = { input: sum(reqs, (r) => r.in), output: sum(reqs, (r) => r.out), cacheCreate5m: sum(reqs, (r) => r.cw5), cacheCreate1h: sum(reqs, (r) => r.cw1), cacheRead: sum(reqs, (r) => r.rd) };
  const total = sum(reqs, (r) => r.v);
  // 快取重建：這一次回應建立了大量快取、而讀到的很少（≈前面累積的上下文沒命中）；附上前一次回應到這次的間隔
  const rebuilds = [];
  let maxCtx = 0, maxCtxAt = null, gaps1h = 0, rebuildCost = 0;
  mainReqs.forEach((r, i) => {
    const ctx = ctxOf(r);
    if (ctx > maxCtx) { maxCtx = ctx; maxCtxAt = r.line; }
    const gap = i ? r.ts - mainReqs[i - 1].ts : 0;
    if (gap >= GAP_1H) gaps1h++;
    const cw = r.cw5 + r.cw1;
    if (i && cw >= BIG_CACHE_BUILD && cw > r.rd) { rebuildCost += cwVal(r); rebuilds.push({ at: rel(main.file) + ':' + r.line, cost: money(cwVal(r)), cacheCreateTokens: cw, gapMinutes: Math.round(gap / 60e3), afterIdleOver5m: gap >= GAP_5M, afterIdleOver1h: gap >= GAP_1H }); }
  });
  const models = {}, dayCost = {};
  let bigCtxCost = 0;
  for (const r of reqs) {
    const m = r.model || '（未知）'; models[m] = (models[m] || 0) + r.v;
    const d = localDay(r.ts); dayCost[d] = (dayCost[d] || 0) + r.v;
    if (ctxOf(r) >= BIG_CONTEXT) bigCtxCost += r.v;
  }
  const toolCount = {}; const reads = {}; let results = [];
  for (const p of parts) {
    for (const [k, v] of Object.entries(p.toolCount)) toolCount[k] = (toolCount[k] || 0) + v;
    for (const [k, v] of Object.entries(p.reads)) reads[k] = (reads[k] || 0) + v;
    results = results.concat(p.results);
  }
  const first = reqs.length ? reqs[0].ts : null, last = reqs.length ? reqs[reqs.length - 1].ts : null;
  const fut = main.firstUserText || '';
  const kind = /<command-name>\/(doctor|insights)<\/command-name>/.test(fut) && main.entrypoint === 'sdk-cli' ? '健檢背景子程序'
    : main.entrypoint === 'sdk-cli' ? '程式起的（sdk-cli／claude -p）' : '互動';
  return {
    requests: reqs.length, mainRequests: mainReqs.length, subagents: parts.length - 1, kind, models,
    first: first && iso(first), last: last && iso(last), day: first ? localDay(first) : null, spanMinutes: first && last ? Math.round((last - first) / 60e3) : 0,
    cost: total, scannedTokens: tot,
    maxContextTokens: maxCtx, maxContextAt: maxCtxAt ? rel(main.file) + ':' + maxCtxAt : null,
    compactions: main.compactions, subagentCompactions: sum(parts.slice(1), (p) => p.compactions), userTurns: main.userTurns,
    idleGapsOver1h: gaps1h, cacheRebuilds: rebuilds,
    rebuildShare: ratio(rebuildCost, total),
    bigContextShare: ratio(bigCtxCost, total),
    topDays: Object.entries(dayCost).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([day, c]) => ({ day, cost: money(c), share: ratio(c, total) })),
    toolCalls: Object.entries(toolCount).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, n]) => ({ name, n })),
    bigToolResults: results.sort((a, b) => b.chars - a.chars).slice(0, 5),
    bigToolResultCount: results.length,
    repeatedReads: Object.entries(reads).filter(([, n]) => n >= 4).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([file, n]) => ({ file: shownPath(file), n })),
    _mainReqs: mainReqs,
  };
}
// 沒有逐字紀錄可診斷時的空值（讓訊號判斷不必處處防 undefined）
const NO_DIAG = { cacheRebuilds: [], spanMinutes: 0, topDays: [], repeatedReads: [], bigToolResults: [], bigToolResultCount: 0, kind: '互動', compactions: 1, maxContextTokens: 0, rebuildShare: 0, bigContextShare: 0 };

// 開場固定底的花費下限：主對話每則回應都背著它，最少要付快取讀取價（沒命中時付得更多）。
// 固定底不會比那則回應的整個上下文大，取小者；只看主對話，用每則回應自己的模型
const floorOf = (startCtx, mainReqs) => sum(mainReqs, (r) => Math.min(startCtx, ctxOf(r)) * readPrice(r));
const startupFields = (startCtx, mainReqs, total) => {
  if (startCtx == null || !mainReqs) return { startupFloorCost: null, startupFloorShare: null };
  const raw = Math.min(floorOf(startCtx, mainReqs), total);
  return { startupFloorCost: money(raw), startupFloorShare: Math.min(1, ratio(raw, total)) };
};
// 明細檔的 startCtx 是這個 session 的用量紀錄裡主對話最前面那一則。分叉／resume 複製歷史的 session，開頭幾則算在原本那個對話，留下的是分叉後那一則，
// 不是開場。看逐字紀錄真正的第一則回應有沒有算在這個 session：沒有、差太多、或是從壓縮摘要起頭，就不是開場固定底。回 true／false／null（沒有紀錄可對）
const isOpening = (startCtx, f, h) => {
  if (!h || !h.first || startCtx == null || !recs.has(keyOf(f))) return null;
  if (h.fromSummary) return false;
  const r = recordOf(f, h.first);
  if (!r) return false;
  const c = num(r.in) + num(r.rd) + num(r.cw5) + num(r.cw1);
  return Math.abs(c - startCtx) <= Math.max(1000, 0.1 * Math.min(c, startCtx));
};

// 這個 session 該怎麼往下看：只給「看哪裡」的線索，原因要回出處讀原文確認
function signalsOf(s, medianCost) {
  const out = [];
  if (s.cacheRebuilds.length) {
    const idle = s.cacheRebuilds.filter((r) => r.afterIdleOver5m).length;
    out.push({ code: 'cache-rebuild', text: `快取重建 ${s.cacheRebuilds.length} 次（其中前一次回應距今超過 5 分鐘的 ${idle} 次、超過 1 小時的 ${s.cacheRebuilds.filter((r) => r.afterIdleOver1h).length} 次）`, check: '回出處看重建前後在做什麼：閒置後回來、換了設定或 hook 輸出、compact 之後，各是不同原因' });
  }
  if (s.spanMinutes >= LONG_LIVED_MIN) out.push({ code: 'long-lived', text: `同一個 session 從第一次到最後一次回應跨 ${(s.spanMinutes / 1440).toFixed(1)} 天，花費最多的三天占 ${Math.round(s.topDays.reduce((a, x) => a + x.share, 0) * 100)}%（${s.topDays.map((d) => d.day).join('、')}）`, check: '長壽 session 每回合都重付整段上下文的快取讀取，換主題或隔天回來開新 session 通常比續用便宜；看是哪幾天、當時在做什麼' });
  if (s.bigContextShare >= 0.5) out.push({ code: 'big-context', text: `${Math.round(s.bigContextShare * 100)}% 的花費發生在上下文 ≥ ${BIG_CONTEXT} token 的回應上（最大 ${s.maxContextTokens}）`, check: `看 ${s.maxContextAt} 附近上下文為什麼那麼大、當時有沒有 compact` });
  if (s.rebuildShare >= 0.1) out.push({ code: 'rebuild-cost', text: `快取重建本身占 ${Math.round(s.rebuildShare * 100)}% 的花費`, check: '閒置超過快取時效（5 分鐘或 1 小時）才回來，整段上下文要重新寫入一次；大上下文的 session 隔久再回來最貴' });
  if (s.startupFloorShare >= 0.2) out.push({ code: 'startup-heavy', text: `主對話每則回應都背著開場的 ${s.startCtx} token 固定底（主對話 ${s.mainRequests} 則），光是讀它就占 ${Math.round(s.startupFloorShare * 100)}%（約 ${s.startupFloorCost} 美元）`, check: '固定底裡是 CLAUDE.md、規則檔、hook 開場輸出、MCP 工具定義、skill 清單；逐項看哪些每個回合都真的需要，不需要的移到要用時才載入' });
  if (s.thinkShare >= 0.5 && s.outputCostShare >= 0.15) out.push({ code: 'think-heavy', text: `輸出的 ${Math.round(s.thinkShare * 100)}% 是 thinking token，輸出本身占花費 ${Math.round(s.outputCostShare * 100)}%`, check: '看這個 session 的工作性質：搬運、檢索、照清單執行的工作不需要高 effort；effort 是要取捨品質的做法，要先有品質檢查' });
  if (s.maxContextTokens >= NEVER_COMPACTED_CTX && s.compactions === 0 && s.mainRequests >= 30) out.push({ code: 'context-never-compacted', text: `主對話上下文最大 ${s.maxContextTokens} token、整段沒有壓縮過（主對話 ${s.mainRequests} 則回應）`, check: `看 ${s.maxContextAt} 附近：這段上下文裡塞了什麼` });
  if (s.bigToolResultCount) out.push({ code: 'big-tool-result', text: `單次工具結果 ≥ ${BIG_RESULT_CHARS} 字的有 ${s.bigToolResultCount} 次（最大 ${s.bigToolResults[0].tool} ${s.bigToolResults[0].chars} 字）`, check: '看出處：整檔讀進來、整個目錄列出、或指令輸出沒截斷；每一次之後的每個回合都要再付一次快取讀取' });
  if (s.repeatedReads.length) out.push({ code: 'repeated-read', text: `同一個檔讀 ≥ 4 次：${s.repeatedReads.map((r) => r.file + '×' + r.n).join('、')}`, check: '看是不是改檔後的必要重讀，還是上下文沒記住、或被 compact 掉才重讀' });
  if (s.subagentShare >= 0.4) out.push({ code: 'subagent-heavy', text: `subagent 占這個 session 的 ${Math.round(s.subagentShare * 100)}%${s.subagents == null ? '' : `（${s.subagents} 個）`}`, check: '看派工數量與每個的回報長度：能不能合併、有沒有把大檔整份讀進去、model 能不能降' });
  if (s.outputShare >= 0.4) out.push({ code: 'output-heavy', text: `輸出占花費 ${Math.round(s.outputShare * 100)}%`, check: '看是長回報、重複貼大段內容、還是 thinking 很多' });
  if (s.kind !== '互動') out.push({ code: 'not-interactive', text: `這是「${s.kind}」session`, check: '不是人在對話；看是誰起的（排程、健檢、goal 引擎、別的 plugin）、跑了幾輪、有沒有該停沒停' });
  if (medianCost && s.cost >= 3 * medianCost) out.push({ code: 'over-3x-median', text: `是範圍內中位數的 ${(s.cost / medianCost).toFixed(1)} 倍`, check: '' });
  return out;
}

// ── 主流程 ──
let sessions = [];        // 每個 { session, cost（不捨入）, … }；先只有明細檔的欄位，診斷欄位只有排名前面的才補
let rangeByDay = {};      // 日期 → 範圍內的金額（不捨入）
let rangeKnown = true;
const otherSessions = [];
let truncated = 0;        // 這個專案沒列在明細裡的 session 數（-1＝有截掉、但不知道這個專案占幾個）

const listed = D.sessions.filter((s) => isObj(s) && typeof s.id === 'string' && s.id && s.project === projKey);
const cut = num(isObj(D.sessionsRest) ? D.sessionsRest.count : 0) || Math.max(0, num(D.sessionsTotal) - D.sessions.length);
if (cut) truncated = Number.isFinite(PD.sessions) ? Math.max(0, PD.sessions - listed.length) : -1;
// 範圍：這個 session 在 --since 之後還有活動（看最後一次回應的當地日期）
const inRange = listed.filter((s) => validTs(s.last) && !(since && localDay(s.last) < since));
loadRecords(new Set(inRange.map((s) => s.id)));
for (const s of inRange) {
  const f = path.join(tdir, s.id + '.jsonl');
  const h = fs.existsSync(f) ? headInfo(f, true) : null;
  if (h && h.other) { otherSessions.push(s.id); continue; }
  const cost = num(s.cost), startCtx = Number.isFinite(s.startCtx) ? s.startCtx : null;
  sessions.push({ session: s.id, day: validTs(s.first) ? localDay(s.first) : null, cost, subCost: num(s.subCost), requests: num(s.requests), models: isObj(s.models) ? s.models : {}, parts: Object.fromEntries(['in', 'out', 'cw', 'cr'].map((k) => [k, num(isObj(s.parts) ? s.parts[k] : 0)])),
    startCtx, opening: isOpening(startCtx, f, h), think: num(s.think), tok: isObj(s.tok) ? s.tok : {}, _file: f });
}
if (isObj(PD.byDay)) rangeByDay = Object.fromEntries(Object.entries(PD.byDay).filter(([d, c]) => Number.isFinite(c) && (!since || d >= since)).sort());
else { rangeKnown = false; notes.push('明細檔這個專案沒有按日金額（byDay），範圍內的總額算不出來（totals.cost 是 null）'); }

const sortedCost = sessions.map((s) => s.cost).sort((a, b) => a - b);
const median = sortedCost.length >= 5 ? sortedCost[Math.floor(sortedCost.length / 2)] : null;
sessions.sort((a, b) => b.cost - a.cost);
const fullCost = sum(sessions, (s) => s.cost);
const rangeCost = sum(Object.values(rangeByDay), (x) => x);
const flaggedRaw = sessions.filter((s, i) => i < TOP || (median && s.cost >= 3 * median));

// 只對排名前面的 session 讀逐字紀錄診斷
const strip = (s) => Object.fromEntries(Object.entries(s).filter(([k]) => !k.startsWith('_')));
const flagged = flaggedRaw.map((s) => {
  const id8 = s.session.slice(0, 8);
  const outShare = ratio(s.parts.out, s.cost);
  const base = { session: s.session, day: s.day, cost: s.cost, subagentCost: money(s.subCost), subagentShare: ratio(s.subCost, s.cost), requests: s.requests,
    parts: moneyMap(s.parts), models: Object.fromEntries(Object.entries(s.models).map(([k, v]) => [k, money(num(v))])), tokens: s.tok,
    startCtx: s.startCtx, startCtxIsOpening: s.opening, thinkTokens: s.think, outputCostShare: outShare, outputShare: outShare,
    thinkShare: num(s.tok.out) ? Math.min(1, ratio(s.think, s.tok.out)) : 0 };
  const noDiag = (why) => ({ ...base, cost: money(s.cost), ...startupFields(null), diagnosis: why, signals: signalsOf({ ...NO_DIAG, ...base }, median) });
  if (!fs.existsSync(s._file)) { notes.push('找不到 session ' + id8 + ' 的逐字紀錄，只有金額、沒有「發生什麼事」的診斷（也算不出開場固定底的花費）'); return noDiag('missing'); }
  const sc = summarize(loadSession(s.session, s._file));
  if (!sc.requests && unreadable.has(rel(s._file))) return noDiag('unreadable');
  // 兩邊都是 cc-statusline 的數字，本來就該相等；差太多就明說。比的是沒捨入的值
  const gap = Math.abs(sc.cost - s.cost);
  if (s.cost && gap / s.cost > DIFF_SHARE && gap > DIFF_ABS) notes.push('session ' + id8 + '：對到逐字紀錄的用量紀錄合計 ' + money(sc.cost) + ' 美元，與明細檔的 ' + money(s.cost) + ' 差 ' + Math.round(gap / s.cost * 100) + '%（以明細檔為準；占比類訊號只看對到的，僅供參考。可能是對話還在進行、逐字紀錄有一部分已清掉或改寫過、或有些列是別的專案）');
  const startup = startupFields(s.opening ? s.startCtx : null, sc._mainReqs, s.cost);
  const merged = { ...sc, ...base, ...startup, scannedRequests: sc.requests, scannedCost: money(sc.cost) };
  return { ...strip(merged), cost: money(s.cost), signals: signalsOf(merged, median) };
});

const byDay = {};
for (const [d, c] of Object.entries(rangeByDay).sort()) byDay[d] = { cost: money(c) };

// ── 說明 ──
if (truncated) notes.push('cc-statusline 明細檔只列全機花最多的 ' + D.sessions.length + ' 個 session' + (truncated > 0 ? '，這個專案有 ' + truncated + ' 個花費較少的沒列' : '，這個專案的可能有些沒列') + '：個別 session 的排名與拆分（breakdown）看不到它們；totals.cost 與 byDay 是專案總帳，仍含它們');
if (!sessions.length) {
  if (truncated || rangeCost > 0) notes.push('範圍內沒有可看的個別 session' + (truncated ? '（這個專案的可能被上面那個上限截掉了）' : '') + '，但不代表沒花錢：範圍內的金額看 totals.cost 與 byDay');
  else notes.push('範圍內沒有可看的 session：數字全為 0 不代表沒花錢，而是沒有資料');
}
if (median === null && sessions.length) notes.push('範圍內不到 5 個 session，沒有中位數可比，只列前 ' + TOP + ' 名');
if (otherSessions.length) notes.push('略過 ' + otherSessions.length + ' 個別的專案的 session（不同資料夾換算成同一個逐字紀錄目錄名，cwd 不是這個專案）：' + otherSessions.slice(0, 5).map((x) => x.slice(0, 8)).join('、') + (otherSessions.length > 5 ? '…' : '') + '。明細檔的每天金額按目錄名加總、拆不開，totals.cost 與 byDay 仍含它們，偏高');
if (otherRowsBy.length) notes.push('有 ' + otherRowsBy.length + ' 個 session 中途切到別的專案（共 ' + sum(otherRowsBy, (x) => x.n) + ' 列的 cwd 不是這個專案），那些列不算進診斷；明細檔的金額拆不開，仍含它們');
if (skippedSubs.length) notes.push('略過 ' + skippedSubs.length + ' 個 cwd 不是這個專案（或分不出屬於哪個專案）的 subagent 紀錄：' + skippedSubs.slice(0, 3).join('、') + (skippedSubs.length > 3 ? '…' : ''));
if (unreadable.size) notes.push('有 ' + unreadable.size + ' 個檔讀不了或沒讀完，數字會偏低：' + [...unreadable].slice(0, 5).map(([f, c]) => f + '（' + c + '）').join('、') + (unreadable.size > 5 ? '…' : ''));
if (lostTotal) notes.push('有 ' + lostTotal + ' 則用量紀錄在逐字紀錄裡對不到那一列（逐字紀錄可能被改寫過），診斷沒算它們；金額仍含');
if (unpriced.size) notes.push('有 ' + unpriced.size + ' 則回應的模型沒有單價，金額沒算它們');
if (approx.size) notes.push('有 ' + approx.size + ' 則回應用的是暫估單價（cc-statusline 還沒有那個模型的牌價），查到牌價後金額會變');
if (badRecords) notes.push('用量紀錄有 ' + badRecords + ' 行讀不出來，已略過（可能正在寫入）');
if (badTotal) notes.push('有 ' + badTotal + ' 行解析失敗，已略過（檔案可能還在寫入）');
notes.push('金額是 cc-statusline 照官方牌價換算的「API 等值金額」，不是你的實際帳單（訂閱方案的實際扣款不同）');
const forked = sessions.filter((s) => s.opening === false).length;
if (sessions.length) notes.push('resume／fork 複製的歷史：同一則回應只算一次，算在先建立的那個對話，分叉出來的 session 金額只是它多出來的部分。' + (forked ? '有 ' + forked + ' 個 session 的開場上下文與逐字紀錄第一則對不上（分叉或從壓縮摘要起頭），不是開場固定底，中位數與 startup-heavy 都不算它們' : '這次範圍內沒有偵測到開場上下文對不上的 session'));
notes.push('totals.cost、totals.dayCost 與 byDay 只算' + (since ? ' ' + since + ' 當天起' : '全部') + '的花費，要跟別次健檢比就比這些；其餘（sessionsFullCost、breakdown、flagged、allSessions）是範圍內有活動的 session 的整個花費，含 --since 之前的，不能拿來比（哪些 session 在範圍內，看最後一次回應的日期）');

// 專案層的拆分：四項成本、按模型、開場固定底
let breakdown;
{
  const startCtxs = sessions.filter((s) => s.startCtx != null && s.opening !== false).map((s) => s.startCtx).sort((a, b) => a - b);
  const pctl = (p) => startCtxs.length ? startCtxs[Math.min(startCtxs.length - 1, Math.floor(startCtxs.length * p))] : null;
  const parts = { in: 0, out: 0, cw: 0, cr: 0 }; const models = {};
  for (const s of sessions) { for (const k of Object.keys(parts)) parts[k] += s.parts[k]; for (const [m, c] of Object.entries(s.models)) models[m] = (models[m] || 0) + num(c); }
  breakdown = {
    scope: '範圍內有活動的 session 的整個花費（含 --since 之前的），合計是 totals.sessionsFullCost',
    parts: moneyMap(parts),
    partsShare: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, ratio(v, fullCost)])),
    models: Object.fromEntries(Object.entries(models).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, { cost: money(v), share: ratio(v, fullCost) }])),
    startup: { sessions: startCtxs.length, medianCtxTokens: pctl(0.5), p90CtxTokens: pctl(0.9), excludedNotOpening: sessions.filter((s) => s.opening === false).length, unverified: sessions.filter((s) => s.startCtx != null && s.opening === null).length },
  };
}

const result = {
  source: 'cc-statusline', unit: 'usd', noData: null,
  root: slash(root), transcripts: slash(tdir), usageDetail: slash(DETAIL_PATH), usageDetailAt: iso(D.at), records: slash(RECORDS_DIR), recordsAt: iso(M.at),
  since: since || null,
  fields: {
    'totals.cost、totals.dayCost': '範圍內的花費（byDay 加總，只算 --since 當天起）；跟別次健檢比用這個',
    'totals.sessionsFullCost': '範圍內有活動的 session 整個加起來，含它們在 --since 之前的花費；medianPerSession、top5Share、allSessions[].share 都以它為準',
    byDay: '範圍內每天的花費（照每則回應的日期分）',
    breakdown: '整個 session 的拆分（含 --since 之前），看花在哪用，不能跟別次健檢比',
    'breakdown.startup': '開場固定底的 token 數；excludedNotOpening 是分叉或從壓縮摘要起頭、已排除的個數，unverified 是沒有逐字紀錄可核對的個數（仍列入）',
    'flagged[].requests': '明細檔的回應數（含 subagent，跨檔去重）；scannedRequests、scannedCost、scannedTokens 是用量紀錄對得到逐字紀錄的那些，mainRequests 是其中主對話的',
    'flagged[].startCtxIsOpening': 'true＝startCtx 是這個 session 的開場；false＝不是（分叉或從壓縮摘要起頭，startupFloor 是 null）；null＝沒有紀錄可核對',
  },
  totals: { sessions: sessions.length, cost: rangeKnown ? money(rangeCost) : null, dayCost: rangeKnown ? money(rangeCost) : null, sessionsFullCost: money(fullCost), medianPerSession: median === null ? null : money(median), top5Share: ratio(sum(sessions.slice(0, 5), (s) => s.cost), fullCost) },
  breakdown,
  byDay,
  flagged,
  allSessions: sessions.map((s) => ({ session: s.session, day: s.day, kind: s.kind || null, requests: s.requests, subagents: s.subagents == null ? null : s.subagents, cost: money(s.cost), share: fullCost ? +(s.cost / fullCost).toFixed(3) : 0 })),
  notes,
};
emit(result);
