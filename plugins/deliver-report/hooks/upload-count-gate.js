#!/usr/bin/env node
/**
 * upload-count-gate — deliver-report 的 Stop hook：瀏覽器上傳的附件要和信裡的附件清單對得上。
 *
 * 為什麼要這支：PreToolUse 的 gmail-draft-attachment-gate 只看得到 create_draft／update_draft
 * 帶的 attachments。走瀏覽器上傳（草稿先建成無附件，再開 viewUrl 用 file_upload 上傳）時，
 * 檔案不經過 Gmail 工具，那道閘看不到；2026-10-11 使用者回報信裡列 3 個檔、實際只附 2 個，
 * 這條路要另一道閘在回合結束時數。
 *
 * 觸發：本回合（最後一則使用者輸入之後）有成功的瀏覽器上傳
 *   （工具名結尾 file_upload／browser_file_upload，例如 Chrome 擴充、Playwright）。
 *   沒上傳就不出聲——沒附檔的情況由 posttool (H) 與 attach-handback-gate 負責。
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

/** transcript 各行 → 依序的事件：{kind:'write'|'upload', idx, input, id}；回傳 { events, errors:Set, start } */
function collect(lines) {
  let start = -1;
  const parsed = lines.map((l) => { if (!l) return null; try { return JSON.parse(l); } catch (_) { return null; } });
  for (let i = parsed.length - 1; i >= 0; i--) {
    if (C.isUserPromptLine(parsed[i])) { start = i; break; }
  }
  const events = [];
  const errors = new Set();
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
        if (C.isGmailTool(name, C.WRITE_TOOLS)) events.push({ kind: 'write', idx: i, id: b.id, input });
        else if (UPLOAD.test(name)) events.push({ kind: 'upload', idx: i, id: b.id, input });
      } else if (o.type === 'user' && b.type === 'tool_result' && b.is_error === true) {
        errors.add(b.tool_use_id);
      }
    }
  }
  return { events, errors, start };
}

function basename(p) { return String(p).split(/[\\/]/).pop(); }

/** 回傳 { problems, items, uploaded } 或 null（不歸這支管／判不出） */
function evaluate(lines) {
  const { events, errors, start } = collect(lines);
  if (start < 0) return null;
  const ok = (e) => !errors.has(e.id);
  const uploads = events.filter((e) => e.kind === 'upload' && ok(e) && Array.isArray(e.input.paths) && e.input.paths.length);
  const lastUp = uploads[uploads.length - 1];
  if (!lastUp || lastUp.idx <= start) return null;            // 本回合沒有成功上傳

  let src = null;
  for (const e of events) {
    if (e.kind === 'write' && ok(e) && e.idx < lastUp.idx && typeof e.input.htmlBody === 'string' && e.input.htmlBody) src = e;
  }
  if (!src) return null;
  if (Array.isArray(src.input.attachments) && src.input.attachments.length) return null;   // API 附檔，PreToolUse 管
  const list = C.parseAttachmentList(src.input.htmlBody);
  if (!list) return null;

  const seen = new Map();
  for (const e of uploads) {
    if (e.idx <= src.idx) continue;
    for (const p of e.input.paths) {
      const b = basename(p);
      if (b && !seen.has(b.toLowerCase())) seen.set(b.toLowerCase(), b);
    }
  }
  const uploaded = Array.from(seen.values());
  const problems = C.compareAttachmentList(list, uploaded, '上傳了');

  const wiped = events.some((e) => e.kind === 'write' && ok(e) && e.idx > lastUp.idx &&
    !(Array.isArray(e.input.attachments) && e.input.attachments.length));
  if (wiped) problems.push('上傳之後又呼叫了不帶 attachments 的 update_draft／create_draft——已上傳的附件會被整批清掉，要重新上傳');

  return { problems, items: list.items.map((it) => it.text), uploaded };
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
    '瀏覽器上傳的附件和信裡的附件清單對不上：',
    ...r.problems.map((p) => '   ・' + p), '',
    '清單第一層 <li>（' + r.items.length + ' 項）：',
    ...r.items.map((it, i) => '   ' + (i + 1) + '. ' + it),
    '已上傳（' + r.uploaded.length + ' 個）：' + (r.uploaded.join('、') || '（無）'), '',
    '修法：把漏的檔用 file_upload 補傳、按「儲存並關閉」，再從草稿匣重開確認附件區；',
    '或把信裡的清單改成真正要附的檔（標題份數要等於清單項數）。（SKILL.md 第三步之三 要點 5）',
  ].join('\n');
  if (payload.stop_hook_active === true) {
    return emit({ systemMessage: '【附件上傳數】（本回合已擋過一次，這次放行）\n' + body });
  }
  emit({ decision: 'block', reason: '【附件上傳數】請先補齊附件再結束。\n' + body });
}

module.exports = { evaluate };
