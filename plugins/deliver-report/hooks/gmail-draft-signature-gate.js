#!/usr/bin/env node
/**
 * gmail-draft-signature-gate — Gmail 草稿簽名檔閘（PreToolUse）
 *
 * ── 為什麼會有這支（2026-10-21 實案）──────────────────────────
 * 使用者回報：請 Claude 建新信草稿，內建的簽名檔不見了。SKILL.md 原本寫「Gmail 會自動附上簽名」，
 * 實測推翻：create_draft 預設不加簽名檔，要帶 includeSignature: true；update_draft 沒有這個參數，
 * 帶新內文會把簽名檔整段清掉。寫在 SKILL.md 是自律，所以用 hook。
 *
 * ── 行為 ─────────────────────────────────────────────────────
 *   create_draft 沒帶 includeSignature: true（且 htmlBody 也沒有 gmail_signature）→ deny
 *   create_draft 帶了 includeSignature: true、htmlBody 又已有 gmail_signature → deny（會變兩份）
 *   update_draft 改了內文、新內文沒有 gmail_signature：
 *     這封草稿讀回確認原本就沒有簽名（nosig）→ 放行；原本有（sig）→ deny；本 session 不知道 → deny 並要求先 get_draft
 *   簽名狀態由 gmail-draft-posttool-gate 在 get_draft 讀回／寫入成功時記（共用狀態檔 sig:<id>／nosig:<id>）。
 *   判準在 draft-checks.core.js signatureProblem()。其餘一律放行。
 *
 * ★ 最高原則：FAIL-OPEN。解析不了輸入、載不到判準就放行。
 *   唯一刻意不放行的是 update_draft「不知道這封草稿有沒有簽名」（狀態檔沒紀錄、讀不到或被擠掉）：
 *   弄丟簽名收不回來，而解法只要先 get_draft 讀回一次，代價很小。
 * ★ 範圍：防手滑，不是沙箱。內容閘掃描前剝掉的是 class 含 gmail_signature 的 div；刻意把正文
 *   包進假的簽名 div 來躲內容閘，不在這道閘的範圍。
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
  const suffix = C.isGmailTool(toolName, 'create_draft') ? 'create_draft'
    : C.isGmailTool(toolName, 'update_draft') ? 'update_draft' : '';
  if (!suffix) return process.exit(0);

  const toolInput = (input.tool_input && typeof input.tool_input === 'object') ? input.tool_input : {};
  const sigState = suffix === 'update_draft'
    ? C.signatureState(C.readState(), C.safeStr(toolInput.draftId)) : null;
  const problem = C.signatureProblem(suffix, toolInput, sigState);
  if (!problem) return process.exit(0);

  const fix = suffix === 'create_draft'
    ? '修法：create_draft 帶 includeSignature: true（回覆草稿同樣適用），內文結尾不要自己打簽名。'
    : '修法：先 get_draft（FULL_CONTENT）讀回。讀回的 htmlBody 有 <div class="gmail_signature" …>…</div> 就整段' +
      '原樣保留在新的 htmlBody 結尾、只改這次要改的地方，不要只帶 body；讀回確認原本就沒有簽名檔，之後的 update 會直接放行。';
  return deny('草稿的簽名檔會不見，已先擋下：' + problem + '。\n' + fix + '\n（SKILL.md 第三步之三）');
}
