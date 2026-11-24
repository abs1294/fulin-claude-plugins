#!/usr/bin/env node
// token-scan.js — 健檢第 1 步的「token 花費」面向（K）：範圍內哪些 session 花得特別多、花在哪。
//
// 用法：node token-scan.js <落點> [--since YYYY-MM-DD] [--transcripts <目錄>] [--usage-detail <檔>] [--out <檔.json>] [--top N]
//
// 兩個資料來源，分工不同：
//   1. 金額（排名、總額、按日、按模型、輸入／輸出／快取寫入／快取讀取四項拆分、thinking token）
//      讀 cc-statusline 的明細檔 ~/.claude/usage-data/cc-statusline-usage-detail.json（有明細輸出的 cc-statusline 版本起，
//      由它的 scripts/all-usage-refresh.js 在背景每 6 小時掃全機逐字紀錄、照官方牌價換算後寫出）。
//      這支腳本不自己猜單價。
//   2. 「發生什麼事」（快取重建、長壽、上下文大小、單次工具結果太大、同一檔反覆讀）只對排名前面的 session
//      讀它的逐字紀錄（含 subagent 紀錄）診斷，金額用明細檔裡的牌價換算。開場固定底也在這裡算：明細檔的回應次數
//      與模型把 subagent 混在一起，而 subagent 不背主對話的固定底，所以主對話的回應與模型從逐字紀錄自己數。
// 沒有明細檔（沒裝 cc-statusline、版本太舊、還沒跑過、明細寫入失敗）時退回「輸入等價單位」：input×1、快取建立 5 分鐘×1.25／1 小時×2、
// 快取讀取×0.1、output×5。那組倍率不分模型，只能粗排序，輸出裡 `unit` 會是 `units` 並在 notes 明講，不能當金額。
//
// 金額有兩種口徑，輸出的 `fields` 逐欄寫明：
//   範圍內（只算 --since 當天起的花費）：totals.cost、totals.dayCost、byDay。前後兩次健檢要比就比這些。
//   整個 session（含它在 --since 之前的花費）：totals.sessionsFullCost、medianPerSession、top5Share、breakdown、flagged、allSessions。
//
// 只讀。不執行任何專案程式、不寫專案。輸出不含對話、指令、工具結果的原文，只有數字、工具名稱、
// 檔名（專案內相對路徑；專案外一律寫「（專案外）」）與出處（檔名:行號）。例外是 root、transcripts、usageDetail 三欄：寫這次讀的來源路徑，給人核對。
//
// 結束碼：0 正常；2 參數或目錄錯誤。

'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const root = args[0] && !args[0].startsWith('--') ? path.resolve(args[0]) : null;
if (!root) { console.error('用法：node token-scan.js <落點> [--since YYYY-MM-DD] [--transcripts <目錄>] [--usage-detail <檔>] [--out <檔>] [--top N]'); process.exit(2); }
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
const DETAIL_PATH = opt('--usage-detail') ? path.resolve(opt('--usage-detail')) : path.join(os.homedir(), '.claude', 'usage-data', 'cc-statusline-usage-detail.json');
const TOTALS_PATH = path.join(path.dirname(DETAIL_PATH), 'cc-statusline-all-usage.json');   // 同一次掃描寫的總額檔，明細寫不進去時它帶 detailFailed

// 退回模式的倍率（以一般輸入價為 1）
const W = { input: 1, cw5m: 1.25, cw1h: 2, read: 0.1, output: 5 };
const GAP_5M = 5 * 60e3, GAP_1H = 60 * 60e3;
const BIG_CACHE_BUILD = 20000;     // 單次回應建立的快取 token ≥ 這個數才算「重建」
const BIG_RESULT_CHARS = 20000;    // 單一工具結果 ≥ 這個字數才列
const BIG_CONTEXT = 200000;        // 單次回應的上下文 ≥ 這個 token 數算「大上下文」（啟發式門檻，只用來看花費集中在哪）
const NEVER_COMPACTED_CTX = 100000; // 主對話上下文到過這麼多 token 還沒壓縮過才值得看（啟發式門檻；小上下文本來就不用壓縮）
const LONG_LIVED_MIN = 24 * 60;    // session 從第一次到最後一次回應跨過這麼多分鐘算「長壽」
const DETAIL_STALE_MS = 48 * 3600 * 1000;
const DIFF_SHARE = 0.05, DIFF_ABS = 0.05;   // 自己掃的金額與明細檔差超過 5% 而且超過 0.05 美元才說（便宜的 session 差幾分錢沒有意義）
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

// ── cc-statusline 明細檔 ──
const notes = [];
let detailFailed = false;
try { const t = JSON.parse(fs.readFileSync(TOTALS_PATH, 'utf8')); detailFailed = !!(t && t.detailFailed === true); } catch {}
let D = null;
try {
  const j = JSON.parse(fs.readFileSync(DETAIL_PATH, 'utf8'));
  if (j && j.v === 1 && isObj(j.byProject) && Array.isArray(j.sessions)) D = j;
  else notes.push('cc-statusline 明細檔格式不認得（v=' + (j && j.v) + '），退回比例模式');
  if (D && detailFailed) notes.push('cc-statusline 最近一次掃描的明細寫入失敗（總額檔標了 detailFailed），讀到的是更早那一次的明細');
} catch (e) {
  notes.push(detailFailed
    ? 'cc-statusline 有掃描過，但明細寫入失敗（總額檔 ' + slash(TOTALS_PATH) + ' 標了 detailFailed；檢查該目錄的寫入權限與磁碟空間）。退回「輸入等價單位」比例模式，沒有美元、不分模型，只能粗排序'
    : e && e.code === 'ENOENT'
      ? '沒有 cc-statusline 明細檔（' + slash(DETAIL_PATH) + '）：沒裝 cc-statusline、版本還沒有明細輸出、或它的背景掃描還沒跑過。退回「輸入等價單位」比例模式，沒有美元、不分模型，只能粗排序'
      : '讀不了 cc-statusline 明細檔（' + (e && e.message) + '），退回比例模式');
}
// 明細檔的專案名是磁碟上的資料夾名；落點打的大小寫可能不同（c:\ 對 C--）
const projDir = path.basename(tdir);
const projKey = !D ? null : own(D.byProject, projDir) ? projDir
  : (FOLD && Object.keys(D.byProject).find((k) => k.toLowerCase() === projDir.toLowerCase())) || null;
const PD = projKey != null && isObj(D.byProject[projKey]) ? D.byProject[projKey] : null;
if (D && !PD) { notes.push('cc-statusline 明細檔裡沒有這個專案（' + projDir + '）：它的背景掃描可能還沒涵蓋到，退回比例模式'); D = null; }
if (D && Date.now() - D.at > DETAIL_STALE_MS) notes.push('cc-statusline 明細檔是 ' + Math.round((Date.now() - D.at) / 3600e3) + ' 小時前產生的，最近的花費可能還沒算進去');
const MODE = D ? 'usd' : 'units';
const money = (n) => MODE === 'usd' ? Math.round(n * 100) / 100 : Math.round(n);
const moneyMap = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, money(v)]));

// 一則回應的金額（usd 模式用 cc-statusline 的牌價；退回模式用比例）
const priceOfModel = (model) => {
  if (!D || !model || !isObj(D.prices)) return null;
  const k = (isObj(D.modelIds) && own(D.modelIds, model) && D.modelIds[model]) || model;
  const p = own(D.prices, k) ? D.prices[k] : null;
  return isObj(p) && ['in', 'out', 'cw', 'cw1h', 'cr'].every((x) => Number.isFinite(p[x])) ? p : null;
};
const unpricedIds = new Set();
const val = (r) => {
  if (MODE === 'usd') {
    const pr = priceOfModel(r.model);
    if (!pr) { unpricedIds.add(r.id); return 0; }
    return (r.in * pr.in + r.out * pr.out + r.cw5 * pr.cw + r.cw1 * pr.cw1h + r.rd * pr.cr) / 1e6;
  }
  return r.in * W.input + r.cw5 * W.cw5m + r.cw1 * W.cw1h + r.rd * W.read + r.out * W.output;
};
const cwVal = (r) => {
  if (MODE === 'usd') { const pr = priceOfModel(r.model); return pr ? (r.cw5 * pr.cw + r.cw1 * pr.cw1h) / 1e6 : 0; }
  return r.cw5 * W.cw5m + r.cw1 * W.cw1h;
};
const readPrice = (r) => { if (MODE === 'usd') { const pr = priceOfModel(r.model); return pr ? pr.cr / 1e6 : 0; } return W.read; };
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
// 有用量的回應；<synthetic> 是程式自己補的列（沒有呼叫模型），不算回應也不算找不到牌價
const usageOf = (o) => o.type === 'assistant' && isObj(o.message) && isObj(o.message.usage) && o.message.model !== '<synthetic>' ? o.message.usage : null;
const reqOf = (o, u) => {
  const cc = isObj(u.cache_creation) ? u.cache_creation : {};
  const cw1 = num(cc.ephemeral_1h_input_tokens), cwAll = num(u.cache_creation_input_tokens);
  const cw5 = cc.ephemeral_5m_input_tokens != null ? num(cc.ephemeral_5m_input_tokens) : Math.max(0, cwAll - cw1);
  return { id: o.message.id, ts: validTs(o.timestamp) ? o.timestamp : null, line: o.__line, model: o.message.model || null, side: o.isSidechain === true,
    in: num(u.input_tokens), out: num(u.output_tokens), cw5, cw1, rd: num(u.cache_read_input_tokens), think: num(isObj(u.output_tokens_details) ? u.output_tokens_details.thinking_tokens : 0) };
};

// 只讀到夠判斷為止：第一個 cwd、有沒有任何一列是這個專案、主對話第一則回應的上下文（＝開場固定底）、是不是從壓縮摘要起頭
const headCache = new Map();
function headInfo(f, needCtx) {
  if (headCache.has(f)) return headCache.get(f);
  const h = { firstCwd: null, anyMine: false, firstCtx: null, fromSummary: false };
  eachRow(f, (o) => {
    if (typeof o.cwd === 'string' && o.cwd) { if (!h.firstCwd) h.firstCwd = o.cwd; if (!h.anyMine && isMine(o.cwd)) h.anyMine = true; }
    if (needCtx && h.firstCtx == null) {
      if (o.isCompactSummary || (o.type === 'system' && o.subtype === 'compact_boundary')) h.fromSummary = true;
      const u = usageOf(o);
      if (u && !o.isSidechain) h.firstCtx = ctxOf(reqOf(o, u));
    }
    return !(h.anyMine && (!needCtx || h.firstCtx != null));
  });
  h.other = !!h.firstCwd && !h.anyMine;
  headCache.set(f, h);
  return h;
}

// 一個檔（主對話或 subagent）→ { reqs: [{id, ts, line, model, in, out, cw5, cw1, rd, think, side}], toolCount, results, reads, compactions, userTurns, otherRows }
function scanFile(f, isMain) {
  const byId = new Map();            // message.id → req（同 id 去重）
  const toolNameById = new Map();    // tool_use id → name
  const results = [];                // { tool, chars, at }
  const toolCount = {};
  const reads = {};                  // 相對路徑 → 次數
  let compBoundary = 0, compSummary = 0, dropped = 0, userTurns = 0, firstUserText = null, entrypoint = null, otherRows = 0, thinkField = false;
  // 沒有 cwd 的列沿用前一列；開頭沒有 cwd 的列沿用第一個出現的 cwd
  let cur = headInfo(f, isMain).firstCwd, mine = !cur || isMine(cur);
  const bad = eachRow(f, (o) => {
    if (typeof o.cwd === 'string' && o.cwd && o.cwd !== cur) { cur = o.cwd; mine = isMine(cur); }
    if (!mine) { otherRows++; return; }
    if (!entrypoint && o.entrypoint) entrypoint = o.entrypoint;
    if (o.type === 'assistant' && isObj(o.message)) {
      const u = usageOf(o);
      if (u && !o.message.id) dropped++;
      if (u && o.message.id) {
        if (isObj(u.output_tokens_details) && u.output_tokens_details.thinking_tokens != null) thinkField = true;
        const r = reqOf(o, u);
        const prev = byId.get(r.id);
        if (!prev) byId.set(r.id, r);
        else for (const k of ['in', 'out', 'cw5', 'cw1', 'rd', 'think']) prev[k] = Math.max(prev[k], r[k]);
      }
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
  return { file: f, bad, reqs: [...byId.values()], dropped, toolCount, results, reads, compactions: compBoundary || compSummary, userTurns, firstUserText, entrypoint, otherRows, thinkField };
}

// 一個 session 的主檔與 subagent 檔。同一個 message.id 同時在主檔與 subagent 檔時只算一次、歸 subagent（主檔那份是回音）
let badTotal = 0, droppedTotal = 0, thinkFieldSeen = false;
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
  const subIds = new Set();
  for (const p of parts.slice(1)) p.reqs = p.reqs.filter((r) => { if (subIds.has(r.id)) return false; subIds.add(r.id); return true; });
  main.reqs = main.reqs.filter((r) => !subIds.has(r.id));
  badTotal += sum(parts, (p) => p.bad); droppedTotal += sum(parts, (p) => p.dropped);
  if (parts.some((p) => p.thinkField)) thinkFieldSeen = true;
  return parts;
}

// 回傳的金額都不捨入（比較、占比、排名用原值），輸出前才捨入
function summarize(parts) {
  const main = parts[0];
  const byTs = (a, b) => a.ts < b.ts ? -1 : 1;
  const reqs = parts.flatMap((p) => p.reqs).filter((r) => r.ts).sort(byTs);
  for (const r of reqs) r.v = val(r);
  const isSub = new Set(parts.slice(1).flatMap((p) => p.reqs));
  const mainReqs = reqs.filter((r) => !isSub.has(r) && !r.side);
  const mainSet = new Set(mainReqs);
  const tot = { input: sum(reqs, (r) => r.in), output: sum(reqs, (r) => r.out), cacheCreate5m: sum(reqs, (r) => r.cw5), cacheCreate1h: sum(reqs, (r) => r.cw1), cacheRead: sum(reqs, (r) => r.rd) };
  const total = sum(reqs, (r) => r.v);
  const subCost = sum(reqs.filter((r) => !mainSet.has(r)), (r) => r.v);
  // 快取重建：這一次回應建立了大量快取、而讀到的很少（≈前面累積的上下文沒命中）；附上前一次回應到這次的間隔
  const rebuilds = [];
  let maxCtx = 0, maxCtxAt = null, gaps1h = 0, rebuildCost = 0;
  mainReqs.forEach((r, i) => {
    const ctx = ctxOf(r);
    if (ctx > maxCtx) { maxCtx = ctx; maxCtxAt = r.line; }
    const gap = i ? new Date(r.ts) - new Date(mainReqs[i - 1].ts) : 0;
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
  const think = sum(reqs, (r) => r.think);
  return {
    requests: reqs.length, mainRequests: mainReqs.length, subagents: parts.length - 1, kind, models,
    first, last, day: first ? localDay(first) : null, spanMinutes: first && last ? Math.round((new Date(last) - new Date(first)) / 60e3) : 0,
    tokens: tot, cost: total, subagentCost: subCost, subagentShare: ratio(subCost, total),
    thinkTokens: think, thinkShare: tot.output ? Math.min(1, ratio(think, tot.output)) : 0,
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
    _dayCost: dayCost, _mainReqs: mainReqs, _ids: reqs.map((r) => r.id),
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
// 明細檔的 startCtx 是「跨檔去重之後的第一則」。分叉／resume 複製歷史的 session，開頭幾則在別的檔算過了，留下的是分叉後那一則（哪個檔算到受檔名排序影響），
// 不是開場。拿逐字紀錄真正的第一則來對：差太多、或是從壓縮摘要起頭，就不是開場固定底。回 true／false／null（沒有紀錄可對）
const isOpening = (startCtx, h) => {
  if (!h || h.firstCtx == null || startCtx == null) return null;
  if (h.fromSummary) return false;
  return Math.abs(h.firstCtx - startCtx) <= Math.max(1000, 0.1 * Math.min(h.firstCtx, startCtx));
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
  if (s.startupFloorShare >= 0.2) out.push({ code: 'startup-heavy', text: `主對話每則回應都背著開場的 ${s.startCtx} token 固定底（主對話 ${s.mainRequests} 則），光是讀它就占 ${Math.round(s.startupFloorShare * 100)}%（約 ${s.startupFloorCost} ${MODE === 'usd' ? '美元' : '單位'}）`, check: '固定底裡是 CLAUDE.md、規則檔、hook 開場輸出、MCP 工具定義、skill 清單；逐項看哪些每個回合都真的需要，不需要的移到要用時才載入' });
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
let sessions = [];        // 每個 { session, cost（不捨入）, … }；usd 模式先只有明細檔的欄位，診斷欄位只有排名前面的才補
let rangeByDay = {};      // 日期 → 範圍內的金額（不捨入）
let rangeKnown = true;
const daySessions = {};
const otherSessions = [];
let truncated = 0;        // 這個專案沒列在明細裡的 session 數（-1＝有截掉、但不知道這個專案占幾個）
let dupIds = 0;

if (MODE === 'usd') {
  const listed = D.sessions.filter((s) => isObj(s) && typeof s.id === 'string' && s.id && s.project === projKey);
  const cut = num(isObj(D.sessionsRest) ? D.sessionsRest.count : 0) || Math.max(0, num(D.sessionsTotal) - D.sessions.length);
  if (cut) truncated = Number.isFinite(PD.sessions) ? Math.max(0, PD.sessions - listed.length) : -1;
  // 範圍：這個 session 在 --since 之後還有活動（看最後一次回應的當地日期），跟比例模式一致
  for (const s of listed) {
    if (!validTs(s.last) || (since && localDay(s.last) < since)) continue;
    const f = path.join(tdir, s.id + '.jsonl');
    const h = fs.existsSync(f) ? headInfo(f, true) : null;
    if (h && h.other) { otherSessions.push(s.id); continue; }
    const cost = num(s.cost), startCtx = Number.isFinite(s.startCtx) ? s.startCtx : null;
    sessions.push({ session: s.id, day: validTs(s.first) ? localDay(s.first) : null, cost, subCost: num(s.subCost), requests: num(s.requests), models: isObj(s.models) ? s.models : {}, parts: Object.fromEntries(['in', 'out', 'cw', 'cr'].map((k) => [k, num(isObj(s.parts) ? s.parts[k] : 0)])),
      startCtx, opening: isOpening(startCtx, h), think: num(s.think), tok: isObj(s.tok) ? s.tok : {}, _file: f });
  }
  if (isObj(PD.byDay)) rangeByDay = Object.fromEntries(Object.entries(PD.byDay).filter(([d, c]) => Number.isFinite(c) && (!since || d >= since)).sort());
  else { rangeKnown = false; notes.push('明細檔這個專案沒有按日金額（byDay），範圍內的總額算不出來（totals.cost 是 null）'); }
} else {
  const seenIn = new Map();   // message.id → 先出現的 session
  let names; try { names = fs.readdirSync(tdir); } catch (e) { console.error('讀不到逐字紀錄目錄：' + tdir + '（' + e.code + '）'); process.exit(2); }
  for (const f of names.filter((n) => n.endsWith('.jsonl')).map((n) => path.join(tdir, n))) {
    const sid = path.basename(f, '.jsonl');
    const h = headInfo(f, true);
    if (h.other) { otherSessions.push(sid); continue; }
    const s = summarize(loadSession(sid, f));
    if (!s.requests) continue;
    if (since && localDay(s.last) < since) continue;
    for (const id of s._ids) { if (seenIn.has(id)) dupIds++; else seenIn.set(id, sid); }
    const startCtx = h.fromSummary ? null : h.firstCtx;
    s.outputShare = s.outputCostShare = ratio(s.tokens.output * W.output, s.cost);
    sessions.push({ session: sid, ...s, startCtx, startCtxIsOpening: startCtx == null ? false : true, ...startupFields(startCtx, s._mainReqs, s.cost) });
    for (const [d, c] of Object.entries(s._dayCost)) if (!since || d >= since) { rangeByDay[d] = (rangeByDay[d] || 0) + c; daySessions[d] = (daySessions[d] || 0) + 1; }
  }
}

const sortedCost = sessions.map((s) => s.cost).sort((a, b) => a - b);
const median = sortedCost.length >= 5 ? sortedCost[Math.floor(sortedCost.length / 2)] : null;
sessions.sort((a, b) => b.cost - a.cost);
const fullCost = sum(sessions, (s) => s.cost);
const rangeCost = sum(Object.values(rangeByDay), (x) => x);
const flaggedRaw = sessions.filter((s, i) => i < TOP || (median && s.cost >= 3 * median));

// usd 模式：只對排名前面的 session 讀逐字紀錄診斷
const strip = (s) => Object.fromEntries(Object.entries(s).filter(([k]) => !k.startsWith('_')));
const flagged = flaggedRaw.map((s) => {
  if (MODE !== 'usd') return { ...strip(s), cost: money(s.cost), subagentCost: money(s.subagentCost), models: moneyMap(s.models), signals: signalsOf(s, median) };
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
  // 金額以明細檔為準（它跨檔去重）；自己掃出來的只用在占比，差太多就明說。比的是沒捨入的值
  const gap = Math.abs(sc.cost - s.cost);
  if (s.cost && gap / s.cost > DIFF_SHARE && gap > DIFF_ABS) notes.push('session ' + id8 + '：自己掃逐字紀錄算出的金額與 cc-statusline 明細檔差 ' + Math.round(gap / s.cost * 100) + '%（明細檔跨檔去重、以它為準；占比類訊號以自己掃的為準，僅供參考）');
  const startup = startupFields(s.opening ? s.startCtx : null, sc._mainReqs, s.cost);
  const merged = { ...sc, ...base, ...startup, scannedRequests: sc.requests };
  return { ...strip(merged), cost: money(s.cost), signals: signalsOf(merged, median) };
});

const byDay = {};
for (const [d, c] of Object.entries(rangeByDay).sort()) byDay[d] = MODE === 'usd' ? { cost: money(c) } : { sessions: daySessions[d], cost: money(c) };

// ── 說明 ──
if (truncated) notes.push('cc-statusline 明細檔只列全機花最多的 ' + D.sessions.length + ' 個 session' + (truncated > 0 ? '，這個專案有 ' + truncated + ' 個花費較少的沒列' : '，這個專案的可能有些沒列') + '：個別 session 的排名與拆分（breakdown）看不到它們；totals.cost 與 byDay 是專案總帳，仍含它們');
if (!sessions.length) {
  if (truncated || rangeCost > 0) notes.push('範圍內沒有可看的個別 session' + (truncated ? '（這個專案的可能被上面那個上限截掉了）' : '') + '，但不代表沒花錢：範圍內的金額看 totals.cost 與 byDay');
  else notes.push('範圍內沒有可看的 session：數字全為 0 不代表沒花錢，而是沒有資料');
}
if (median === null && sessions.length) notes.push('範圍內不到 5 個 session，沒有中位數可比，只列前 ' + TOP + ' 名');
if (otherSessions.length) notes.push('略過 ' + otherSessions.length + ' 個別的專案的 session（不同資料夾換算成同一個逐字紀錄目錄名，cwd 不是這個專案）：' + otherSessions.slice(0, 5).map((x) => x.slice(0, 8)).join('、') + (otherSessions.length > 5 ? '…' : '') + (MODE === 'usd' ? '。明細檔的每天金額按目錄名加總、拆不開，totals.cost 與 byDay 仍含它們，偏高' : ''));
if (otherRowsBy.length) notes.push('有 ' + otherRowsBy.length + ' 個 session 中途切到別的專案（共 ' + sum(otherRowsBy, (x) => x.n) + ' 列的 cwd 不是這個專案），那些列不算' + (MODE === 'usd' ? '進診斷；明細檔的金額拆不開，仍含它們' : ''));
if (skippedSubs.length) notes.push('略過 ' + skippedSubs.length + ' 個 cwd 不是這個專案（或分不出屬於哪個專案）的 subagent 紀錄：' + skippedSubs.slice(0, 3).join('、') + (skippedSubs.length > 3 ? '…' : ''));
if (unreadable.size) notes.push('有 ' + unreadable.size + ' 個逐字紀錄讀不了或沒讀完，數字會偏低：' + [...unreadable].slice(0, 5).map(([f, c]) => f + '（' + c + '）').join('、') + (unreadable.size > 5 ? '…' : ''));
if (droppedTotal) notes.push('有 ' + droppedTotal + ' 則回應有 usage 但沒有 message.id，沒算進去（逐字紀錄格式可能改了，數字會偏低）');
if (unpricedIds.size) notes.push('有 ' + unpricedIds.size + ' 則回應的模型在 cc-statusline 的牌價表裡找不到，診斷用的金額沒算它們');
if (badTotal) notes.push('有 ' + badTotal + ' 行解析失敗，已略過（檔案可能還在寫入）');
if (MODE === 'units') {
  notes.push('輸入等價單位是比例，不是美元：倍率 input×1、快取建立 5 分鐘×1.25／1 小時×2、快取讀取×0.1、output×5，且不分模型（Fable、Opus、Sonnet 的價差整個被抹掉）；要金額請安裝或更新 cc-statusline');
  notes.push('比例模式的訊號限制：startup-heavy、output-heavy、think-heavy 用上面那組倍率算占比，不是真實金額占比，只能當線索' + (sessions.length && !thinkFieldSeen ? '；這次的逐字紀錄沒有 thinking token 欄位，think-heavy 不會出現（不代表 thinking 少）' : ''));
  if (sessions.length) notes.push('resume／fork 會把歷史複製到另一個 session 檔，比例模式跨 session 不去重，這部分會重複計算' + (dupIds ? '（這次範圍內有 ' + dupIds + ' 則回應在別的 session 檔也出現過）' : '（這次範圍內沒有偵測到）'));
} else {
  notes.push('金額是 cc-statusline 照官方牌價換算的「API 等值金額」，不是你的實際帳單（訂閱方案的實際扣款不同）');
  const forked = sessions.filter((s) => s.opening === false).length;
  if (sessions.length) notes.push('resume／fork 複製的歷史：明細檔跨檔去重、同一則回應只算一次，但算在哪個 session 受檔名排序影響，分叉出來的 session 金額只是它多出來的部分。' + (forked ? '有 ' + forked + ' 個 session 的開場上下文與逐字紀錄第一則對不上（分叉或從壓縮摘要起頭），不是開場固定底，中位數與 startup-heavy 都不算它們' : '這次範圍內沒有偵測到開場上下文對不上的 session'));
}
notes.push('totals.cost、totals.dayCost 與 byDay 只算' + (since ? ' ' + since + ' 當天起' : '全部') + '的花費，要跟別次健檢比就比這些；其餘（sessionsFullCost、breakdown、flagged、allSessions）是範圍內有活動的 session 的整個花費，含 --since 之前的，不能拿來比（哪些 session 在範圍內，看最後一次回應的日期）');

// 專案層的拆分（usd 模式）：四項成本、按模型、開場固定底
let breakdown = null;
if (MODE === 'usd') {
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
  source: MODE === 'usd' ? 'cc-statusline' : 'transcripts-only', unit: MODE,
  root: slash(root), transcripts: slash(tdir), usageDetail: MODE === 'usd' ? slash(DETAIL_PATH) : null, usageDetailAt: D && Number.isFinite(D.at) && !isNaN(new Date(D.at)) ? new Date(D.at).toISOString() : null,
  since: since || null, weights: MODE === 'units' ? W : null,
  fields: {
    'totals.cost、totals.dayCost': '範圍內的花費（byDay 加總，只算 --since 當天起）；跟別次健檢比用這個',
    'totals.sessionsFullCost': '範圍內有活動的 session 整個加起來，含它們在 --since 之前的花費；medianPerSession、top5Share、allSessions[].share 都以它為準',
    byDay: '範圍內每天的花費（照每則回應的日期分）',
    breakdown: '整個 session 的拆分（含 --since 之前），看花在哪用，不能跟別次健檢比',
    'breakdown.startup': '開場固定底的 token 數；excludedNotOpening 是分叉或從壓縮摘要起頭、已排除的個數，unverified 是沒有逐字紀錄可核對的個數（仍列入）',
    'flagged[].requests': MODE === 'usd' ? '明細檔的回應數（含 subagent，跨檔去重）；scannedRequests 是自己掃逐字紀錄數的，mainRequests 是其中主對話的' : '逐字紀錄的回應數（含 subagent，同一則只算一次）；mainRequests 是其中主對話的',
    'flagged[].startCtxIsOpening': 'true＝startCtx 是這個 session 的開場；false＝不是（分叉或從壓縮摘要起頭，startupFloor 是 null）；null＝沒有紀錄可核對',
  },
  totals: { sessions: sessions.length, cost: rangeKnown ? money(rangeCost) : null, dayCost: rangeKnown ? money(rangeCost) : null, sessionsFullCost: money(fullCost), medianPerSession: median === null ? null : money(median), top5Share: ratio(sum(sessions.slice(0, 5), (s) => s.cost), fullCost) },
  breakdown,
  byDay,
  flagged,
  allSessions: sessions.map((s) => ({ session: s.session, day: s.day, kind: s.kind || null, requests: s.requests, subagents: s.subagents == null ? null : s.subagents, cost: money(s.cost), share: fullCost ? +(s.cost / fullCost).toFixed(3) : 0 })),
  notes,
};
const json = JSON.stringify(result, null, 2);
const dest = opt('--out');
if (dest) {
  try { fs.mkdirSync(path.dirname(path.resolve(dest)), { recursive: true }); fs.writeFileSync(dest, json); } catch (e) { console.error('寫不進 --out 指定的檔：' + path.resolve(dest) + '（' + e.code + '）'); process.exit(2); }
  console.log(JSON.stringify({ source: result.source, unit: result.unit, totals: result.totals, breakdown: result.breakdown, flagged: result.flagged.map((s) => ({ session: s.session.slice(0, 8), day: s.day, cost: s.cost, signals: s.signals.map((x) => x.code) })), notes }, null, 2));
  console.log('完整結果：' + path.resolve(dest));
} else console.log(json);
