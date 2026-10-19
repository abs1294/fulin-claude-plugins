#!/usr/bin/env node
/**
 * gmail-draft-stale-gate — 改既有草稿前必須先讀回（PreToolUse，只掛 update_draft）
 *
 * ── 為什麼會有這支（2026-10-20 實案）──────────────────────────
 * 使用者習慣在 Gmail 介面直接改草稿內文。同一輪對話裡草稿改了四次，
 * 第三次改信時模型照「自己上次送出的 htmlBody」重組再 update_draft，
 * 使用者剛在介面刪掉的 repo 表格、改掉的小標被原樣寫回。使用者原話：
 * 「我會習慣去改信件內文，但你常常都不看就直接覆蓋」。
 * SKILL.md 寫「先 get_draft 再改」是自律，模型會跳過；這支是他律。
 *
 * ── 行為 ─────────────────────────────────────────────────────
 *   update_draft 的 draftId 在共用狀態檔裡帶著 stale:<draftId> 記號
 *   （由 gmail-draft-posttool-gate 在上一次 create_draft／update_draft 成功時寫入，
 *     get_draft 讀回帶 htmlBody 時銷掉）→ deny，理由寫清楚做法。
 *   沒有記號（這個 session 之前沒寫過、或已讀回）→ 放行。
 *   create_draft 不經過這支（新草稿沒有「上一版」可覆蓋）。
 *
 * ── 這支擋不到的 ─────────────────────────────────────────────
 *   讀回之後有沒有真的拿讀回的內容當底、有沒有保住使用者的修改——
 *   那要靠 SKILL.md 要點 6 的「改前改後切段比對」。這支只擋「連讀都沒讀就覆蓋」。
 *
 * ★ 最高原則：FAIL-OPEN。狀態檔讀不到、輸入解析不了 → 放行。
 *   擋錯的代價是流程卡死；放錯的代價是使用者再改一次。
 */

const path = require('path');

let C;
try {
  C = require(path.join(__dirname, 'lib', 'draft-checks.core.js'));
} catch (_) {
  process.exit(0);
}

let stdinData = '';
process.stdin.on('data', (c) => (stdinData += c));
process.stdin.on('end', () => {
  try { main(stdinData); } catch (_) { process.exit(0); }
});
process.stdin.on('error', () => process.exit(0));

function deny(reason) {
  try {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
    }), () => process.exit(0));
  } catch (_) { process.exit(0); }
}

function main(raw) {
  let input;
  try { input = JSON.parse(raw); } catch (_) { return process.exit(0); }
  if (!input || typeof input !== 'object') return process.exit(0);

  const toolName = C.safeStr(input.tool_name);
  if (!C.isGmailTool(toolName, 'update_draft')) return process.exit(0);

  const toolInput = (input.tool_input && typeof input.tool_input === 'object') ? input.tool_input : {};
  const draftId = C.safeStr(toolInput.draftId);
  if (!draftId) return process.exit(0);

  const st = C.readState();
  if (st.warned.indexOf('stale:' + draftId) === -1) return process.exit(0);

  return deny(
    `這封草稿（${draftId}）上次由工具寫入後還沒有 get_draft 讀回，已先擋下這次 update_draft。\n` +
    '使用者常在 Gmail 介面直接改內文；拿自己上次送出的文字當底覆蓋，會把他的修改洗掉\n' +
    '（2026-10-20 實案：使用者刪掉的表格、改過的小標被原樣寫回）。\n' +
    '做法：\n' +
    '  1. 先 get_draft（messageFormat: FULL_CONTENT），以讀回的 htmlBody 當底稿；\n' +
    '  2. 讀回的內容與上次送出的不同＝使用者手改過，先在對話裡列出他改了什麼再動手；\n' +
    '     他的修改與這次要改的地方衝突就停下來問，不要自己選一邊；\n' +
    '  3. 只改這次被要求的那幾處，其餘逐字保留；attachments 要全部重附（不帶會清空）；\n' +
    '  4. 改完再 get_draft 一次，改前改後切段比對，只能出現這次要改的那幾段差異。\n' +
    '（SKILL.md 第三步之三 要點 6）'
  );
}
