#!/usr/bin/env node
/**
 * gmail-draft-attachment-gate — Gmail 草稿附件上限閘（PreToolUse）
 *
 * ── 為什麼會有這支（2026-10-06 實案）──────────────────────────
 * 30.6MB 的交付 zip 超過 Gmail API 附件上限（25MB），API 這條路不存在，
 * 但「叫使用者自己拖進網頁」被使用者打回票（「我不是你的狗」）。
 * 正確分工：≤25MB 由工具直接帶；>25MB 一定失敗，**要在呼叫前就擋下**
 * 並把替代路徑（網頁拖入自動轉 Drive／瀏覽器代拖）講清楚——
 * 而不是讓呼叫打出去吃 API 錯誤、或更糟：模型根本不附、叫使用者動手。
 *
 * ── 行為 ─────────────────────────────────────────────────────
 *   create_draft / update_draft 的 attachments 合計 > 25MB → deny，
 *   理由附三條替代路徑。其餘一律放行。
 *
 * ★ 最高原則：FAIL-OPEN。解析不了就放行——擋錯的代價是流程卡死，
 *   放錯的代價只是吃一次 API 錯誤訊息。
 */

const path = require('path');

let C;
try {
  C = require(path.join(__dirname, 'lib', 'draft-checks.core.js'));
} catch (_) {
  process.exit(0);
}

const LIMIT_BYTES = 25 * 1024 * 1024;

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
  if (!C.isGmailTool(toolName, C.WRITE_TOOLS)) return process.exit(0);

  const toolInput = (input.tool_input && typeof input.tool_input === 'object') ? input.tool_input : {};
  const total = C.attachmentsTotalBytes(toolInput);
  if (total <= LIMIT_BYTES) return process.exit(0);

  const mb = (total / 1024 / 1024).toFixed(1);
  return deny(
    `附件合計約 ${mb}MB，超過 Gmail API 的 25MB 上限，這次呼叫必定失敗，已先擋下。\n` +
    '超限附件的三條路（擇一，不要叫使用者自己想辦法）：\n' +
    '  1. 檔案可再縮（分卷、去掉非必要內容）→ 縮到 25MB 內再由工具附上；\n' +
    '  2. 由瀏覽器自動化代拖進 Gmail 網頁草稿（>25MB 網頁版會自動轉雲端硬碟連結）；\n' +
    '  3. 走使用者慣用的檔案交換管道，並把信裡「請詳附件」改成實際取檔方式。\n' +
    '（SKILL.md 第三步之三 要點 5）'
  );
}
