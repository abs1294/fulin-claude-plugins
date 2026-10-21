#!/usr/bin/env node
/**
 * upload-count-gate — deliver-report 的 Stop hook：瀏覽器上傳的附件要和信裡的附件清單對得上。
 *
 * 為什麼要這支：PreToolUse 的 gmail-draft-attachment-gate 只看得到 create_draft／update_draft
 * 帶的 attachments。走瀏覽器上傳（草稿先建成無附件，再開 viewUrl 用 file_upload 上傳）時，
 * 檔案不經過 Gmail 工具，那道閘看不到；2026-10-11 使用者回報信裡列 3 個檔、實際只附 2 個，
 * 這條路要另一道閘在回合結束時數。
 *
 * 觸發（兩種）：
 *   1. 本回合（最後一則使用者輸入之後）有成功的瀏覽器上傳
 *      （工具名結尾 file_upload／browser_file_upload，例如 Chrome 擴充、Playwright）→ 比對清單。
 *   2. 跨回合清附件：本回合對「本 session 曾上傳過附件」的草稿下了不帶 attachments 的 update_draft，
 *      之後沒把附件傳回同一封（crossTurnWipes）。上傳歸給之前最近一次打開的草稿網址（msg-a:<草稿 id>）；
 *      上傳歸屬逐分頁（tabId）記錄。沒開草稿網址就上傳（例如從草稿匣列表點開），判斷不出是哪封，
 *      session 寫過不止一封時就不歸屬、不檢查——包括「從草稿匣點進去重傳」這條常見路徑，所以 SKILL.md
 *      要求上傳前一定開那封的 viewUrl。
 *      限同一個 session 的 transcript；別的 session 上傳過的看不到。
 *   都沒有就不出聲——沒附檔的情況由 posttool (H) 與 attach-handback-gate 負責。
 * 比對：
 *   - 清單來源＝最後一次上傳之前、最近一次帶 htmlBody 的 Gmail 草稿寫入；
 *     那次寫入有帶 attachments（走 API）就不歸這支管。
 *   - 上傳的檔＝那次寫入之後所有成功的上傳（跨回合累計，同名去重，失敗的不算）。
 *   - 判準與 PreToolUse 閘同一份（draft-checks.core.js 的 parseAttachmentList／compareAttachmentList）。
 *   - 另查：最後一次上傳之後又有不帶 attachments 的 update_draft → 已上傳的附件會被整批清掉。
 * 退出口：同一回合第二次 Stop（stop_hook_active）仍不符 → 改為提醒放行，不讓 session 卡死。
 * 限制：子代理（sidechain）裡的上傳不看；上傳工具回成功不等於 Gmail 收進附件區，
 *   仍要照 SKILL.md 從草稿匣重開確認。
 *
 * ★ FAIL-OPEN：transcript 讀不到、解析失敗、判不出 → 放行。
 */
const fs = require('fs');
const path = require('path');

let C;
try { C = require(path.join(__dirname, 'lib', 'draft-checks.core.js')); } catch (_) { C = null; }

if (require.main === module) {
  if (!C) process.exit(0);
  let stdinData = '';
  process.stdin.on('data', (c) => (stdinData += c));
  process.stdin.on('end', () => {
    try { main(stdinData); } catch (_) { allow(); }
  });
  process.stdin.on('error', () => allow());
}

function allow() { process.exit(0); }
function emit(obj) {
  try { process.stdout.write(JSON.stringify(obj), () => process.exit(0)); } catch (_) { allow(); }
}

const UPLOAD = /(?:^|__)(?:browser_)?file_upload$/;

// 瀏覽器導覽工具（Chrome 擴充的 navigate／開分頁、Playwright 的 browser_navigate）
const NAV_TOOL = /(?:^|__)(?:browser_)?(?:navigate|tabs_create(?:_mcp)?)$/;
// 草稿網址裡的草稿 id：get_draft／create_draft 回傳的 viewUrl 形如 …compose=thread-f:…%2Bmsg-a:r-6380…
// （2026-10-21 實測：get_draft 回傳 id r-1346994169448255443，同筆 viewUrl 為 …msg-a:r-1346994169448255443）
const DRAFT_IN_URL = /msg-a(?::|%3A)(r-?\d+)/i;
// create_draft 回傳內容裡的草稿 id（純字串 JSON，或陣列經 JSON.stringify 後帶跳脫引號）
const RESULT_ID = /"id\\?"\s*:\s*\\?"(r-?\d+)/;

/**
 * transcript 各行 → 依序的事件，回傳 { events, errors:Set, start }。事件：
 *   write  Gmail create_draft／update_draft：{ input, isUpdate, draft（update 的 draftId 或 create 回傳的 id）}
 *   upload 瀏覽器上傳：{ input }
 *   nav    瀏覽器導覽：{ draft }——網址是草稿網址就是那封的 id，不是（例如草稿匣列表）就是 ''
 */
function collect(lines) {
  let start = -1;
  const parsed = lines.map((l) => { if (!l) return null; try { return JSON.parse(l); } catch (_) { return null; } });
  for (let i = parsed.length - 1; i >= 0; i--) {
    if (C.isUserPromptLine(parsed[i])) { start = i; break; }
  }
  const events = [];
  const errors = new Set();
  const byId = new Map();
  for (let i = 0; i < parsed.length; i++) {
    const o = parsed[i];
    if (!o || typeof o !== 'object' || o.isSidechain === true) continue;
    const c = o.message && o.message.content;
    if (!Array.isArray(c)) continue;
    for (const b of c) {
      if (!b || typeof b !== 'object') continue;
      if (o.type === 'assistant' && b.type === 'tool_use') {
        const name = C.safeStr(b.name);
        const input = (b.input && typeof b.input === 'object') ? b.input : {};
        let ev = null;
        if (C.isGmailTool(name, C.WRITE_TOOLS)) {
          ev = { kind: 'write', idx: i, id: b.id, input, isUpdate: C.isGmailTool(name, 'update_draft'), draft: C.safeStr(input.draftId) };
        } else if (UPLOAD.test(name)) {
          ev = { kind: 'upload', idx: i, id: b.id, input };
        } else if (NAV_TOOL.test(name)) {
          const d = DRAFT_IN_URL.exec(JSON.stringify(input));
          ev = { kind: 'nav', idx: i, id: b.id, input, draft: d ? d[1] : '' };
        }
        if (ev) { events.push(ev); byId.set(b.id, ev); }
      } else if (o.type === 'user' && b.type === 'tool_result') {
        if (b.is_error === true) errors.add(b.tool_use_id);
        const ev = byId.get(b.tool_use_id);
        if (ev && ev.kind === 'write' && !ev.draft) {
          const m = RESULT_ID.exec(typeof b.content === 'string' ? b.content : JSON.stringify(b.content || ''));
          if (m) ev.draft = m[1];
        }
      }
    }
  }
  return { events, errors, start };
}

/**
 * 每次成功上傳歸給哪封草稿（唯一的歸屬判準，兩段檢查共用）：
 *   - 上傳前最近一次瀏覽器導覽是草稿網址 → 那封；導覽到別的頁面（草稿匣列表等）→ 判斷不出。
 *   - 判斷不出時，整個 session 只寫過一封草稿 → 歸給那封（不知道 id 就用寫入位置當代號）；
 *     寫過不止一封 → 不歸屬（''），兩段檢查都跳過它。
 *   寧可漏抓，也不要擋錯對象、引導模型把 A 的附件傳進 B。
 *   （第一版用「上傳前最近一次寫入」推定，多封草稿交錯時擋錯、漏抓、誤認重傳——2026-10-21 審查實測。）
 */
// 寫入對應的草稿代號：知道 id 就用 id；不知道（回傳裡抽不到）就用寫入位置當暫時代號
function writeKey(e) { return e.draft || '__w' + e.idx; }

// 分頁代號：Chrome 擴充的 navigate／file_upload 都帶 tabId；沒帶的工具（Playwright 等）共用一個預設分頁
function tabOf(input) { return input && input.tabId !== undefined && input.tabId !== null ? String(input.tabId) : '__default'; }

function attributeUploads(events, ok) {
  const targets = new Set();
  for (const e of events) if (e.kind === 'write' && ok(e)) targets.add(writeKey(e));
  const solo = targets.size === 1 ? Array.from(targets)[0] : '';
  // 每個分頁目前開著哪封：沒有紀錄＝沒導覽過；''＝導覽到非草稿頁（只清該分頁）
  // （只看最近一次導覽、不分分頁時，分頁 1 開 A、分頁 2 開 B、在分頁 1 上傳 A 會被算給 B——2026-10-21 審查實測）
  const open = new Map();
  const ups = [];
  for (const e of events) {
    if (e.kind === 'nav' && ok(e)) open.set(tabOf(e.input), e.draft);
    else if (e.kind === 'upload' && ok(e) && Array.isArray(e.input.paths) && e.input.paths.length) {
      ups.push({ idx: e.idx, paths: e.input.paths, draft: open.get(tabOf(e.input)) || solo });
    }
  }
  return { ups, solo };
}

/**
 * 跨回合清附件：本回合對「本 session 曾用瀏覽器上傳過附件」的草稿下了不帶 attachments 的 update_draft
 * （Gmail 會把附件整批清掉），之後卻沒有把附件傳回**同一封** → 問題字串陣列。
 * 2026-10-21 起附件預設走瀏覽器上傳、改內文常在下一輪，舊版只在「本回合有上傳」時才檢查，這條路完全漏掉。
 */
function crossTurnWipes(events, ok, ups, start) {
  const problems = [];
  for (const w of events) {
    if (w.kind !== 'write' || !ok(w) || w.idx <= start || !w.isUpdate || !w.draft) continue;
    if (Array.isArray(w.input.attachments) && w.input.attachments.length) continue;
    if (!ups.some((u) => u.idx < w.idx && u.draft === w.draft)) continue;
    if (ups.some((u) => u.idx > w.idx && u.draft === w.draft)) continue;
    // 同一回合「上傳後又被清掉」由清單比對那段報，不重複報
    if (ups.some((u) => u.idx > start && u.idx < w.idx && u.draft === w.draft)) continue;
    problems.push('草稿 ' + w.draft + ' 先前用瀏覽器上傳過附件，這回合的 update_draft 沒帶 attachments，' +
      '附件已被整批清掉，回合結束前沒有把附件傳回這封草稿');
  }
  return problems;
}

/**
 * 本回合清單比對：本回合上傳過的每一封草稿，各自拿「它最近一次帶 htmlBody 的寫入」裡的附件清單，
 * 比對傳給**這封**的檔（那次寫入之後、跨回合累計，同名去重）；上傳後又被不帶附件的寫入清掉也報。
 */
function evaluateUploads(events, ok, ups, start, solo) {
  const drafts = [];
  for (const u of ups) if (u.idx > start && u.draft && drafts.indexOf(u.draft) === -1) drafts.push(u.draft);
  const problems = [];
  let items = [];
  let uploaded = [];
  for (const d of drafts) {
    const mine = ups.filter((u) => u.draft === d);
    const lastUp = mine[mine.length - 1];
    let src = null;
    for (const e of events) {
      const mineWrite = writeKey(e) === d || (solo && writeKey(e) === solo);   // 回傳抽不到 id 時，只有一封草稿就是它
      if (e.kind === 'write' && ok(e) && mineWrite && e.idx < lastUp.idx && typeof e.input.htmlBody === 'string' && e.input.htmlBody) src = e;
    }
    if (!src) continue;
    if (Array.isArray(src.input.attachments) && src.input.attachments.length) continue;   // API 附檔，PreToolUse 管
    const list = C.parseAttachmentList(src.input.htmlBody);
    if (!list) continue;

    const seen = new Map();
    for (const u of mine) {
      if (u.idx <= src.idx) continue;
      for (const p of u.paths) {
        const b = basename(p);
        if (b && !seen.has(b.toLowerCase())) seen.set(b.toLowerCase(), b);
      }
    }
    const got = Array.from(seen.values());
    const prefix = drafts.length > 1 ? '草稿 ' + d + '：' : '';
    for (const p of C.compareAttachmentList(list, got, '上傳了')) problems.push(prefix + p);

    const wiped = events.some((e) => e.kind === 'write' && ok(e) && (writeKey(e) === d || (solo && writeKey(e) === solo)) && e.idx > lastUp.idx &&
      !(Array.isArray(e.input.attachments) && e.input.attachments.length));
    if (wiped) problems.push(prefix + '上傳之後又呼叫了不帶 attachments 的 update_draft——已上傳的附件會被整批清掉，要重新上傳');
    if (drafts.length === 1) { items = list.items.map((it) => it.text); uploaded = got; }
  }
  return drafts.length ? { problems, items, uploaded } : null;
}

function basename(p) { return String(p).split(/[\\/]/).pop(); }

/** 回傳 { problems, items, uploaded, wipeOnly? } 或 null（不歸這支管／判不出） */
function evaluate(lines) {
  const { events, errors, start } = collect(lines);
  if (start < 0) return null;
  const ok = (e) => !errors.has(e.id);
  const { ups, solo } = attributeUploads(events, ok);
  const wipes = crossTurnWipes(events, ok, ups, start);
  const r = evaluateUploads(events, ok, ups, start, solo);
  if (!wipes.length) return r && r.problems.length ? r : null;
  if (!r) return { problems: wipes, items: [], uploaded: [], wipeOnly: true };
  r.problems.push(...wipes);
  return r;
}

function main(raw) {
  let payload = {};
  try { payload = JSON.parse(raw || '{}'); } catch (_) { return allow(); }
  const tp = payload.transcript_path;
  if (!tp) return allow();
  let lines;
  try { lines = fs.readFileSync(tp, 'utf8').split('\n'); } catch (_) { return allow(); }
  const r = evaluate(lines);
  if (!r || !r.problems.length) return allow();

  const body = [
    r.wipeOnly ? '草稿的附件被改內文的 update_draft 清掉了：' : '瀏覽器上傳的附件和信裡的附件清單對不上：',
    ...r.problems.map((p) => '   ・' + p), '',
    ...(r.items.length ? [
      '清單第一層 <li>（' + r.items.length + ' 項）：',
      ...r.items.map((it, i) => '   ' + (i + 1) + '. ' + it),
      '已上傳（' + r.uploaded.length + ' 個）：' + (r.uploaded.join('、') || '（無）'), ''] : []),
    '修法：把漏的檔用 file_upload 補傳、按「儲存並關閉」，再從草稿匣重開確認附件區；',
    '或把信裡的清單改成真正要附的檔（標題份數要等於清單項數）。（SKILL.md 第三步之三 要點 5）',
    ...(r.wipeOnly ? ['附件是對方本來就叫你拿掉的話就不用重傳，在回覆裡說明即可（第二次結束時會改提醒放行）。'] : []),
  ].join('\n');
  if (payload.stop_hook_active === true) {
    return emit({ systemMessage: '【附件上傳數】（本回合已擋過一次，這次放行）\n' + body });
  }
  emit({ decision: 'block', reason: '【附件上傳數】請先補齊附件再結束。\n' + body });
}

module.exports = { evaluate };
