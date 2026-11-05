#!/usr/bin/env node
/**
 * greeting-gate — 稱謂行「Hi X,」下一行直接接正文，中間不留空行（PreToolUse，硬擋）
 *
 * ── 為什麼會有這支（2026-11-04 實案）──────────────────────────
 * SKILL.md 第一步要點 2 與第三步之三格式段早就寫「稱謂行下面直接接正文，中間不留空行」，是使用者的
 * 固定偏好——但只是自律。2026-11-04 回覆草稿又寫成「Hi Tina,」＋空行：先是 create_draft 的 body
 * 寫 "Hi Tina,\n\n…"（連線失敗沒建成），Gmail 工具斷線後改在 Chrome 用 javascript_tool 寫
 * ["Hi Tina,","",…] 進編輯器；兩條路都沒有任何閘看稱謂行。使用者截圖退件
 * （原話「怎麼又有信第二行是空白，我喜歡第一行 hi寫完下一行直接就是文字，不要空一行」）。
 * 提醒擋不住就改成 deny（同 gmail-draft-paragraph-gate 的教訓）。
 *
 * ── 行為 ─────────────────────────────────────────────────────
 *   Gmail create_draft／update_draft／reply／send_message：
 *     body（純文字）第一個非空行是稱謂行、下一行是空行 → deny
 *     htmlBody 剝掉引用區與簽名檔後，開頭稱謂行到下一段文字之間有 ≥2 個換行 → deny
 *     （<br><br>、<br>&nbsp;<br>、</div><div><br></div><div>…；Gmail 編輯器存的空行就是最後那種）
 *   瀏覽器打字類工具（Chrome 擴充 javascript_tool／computer／form_input／browser_batch，
 *   Playwright browser_type／browser_evaluate／browser_fill_form／browser_run_code_unsafe）：
 *     參數裡任一字串值出現「稱謂＋空行」（真換行、程式碼裡的字面 \n\n、<br><br>、逐行陣列 "Hi X,","",）→ deny
 *     內容不經 Gmail 工具時只有工具參數看得到，判準寬一點；誤擋的代價只是把空行拿掉。
 *   判準在 draft-checks.core.js：greetingGapText／greetingGapHtml／greetingGapInStrings。
 *
 * ★ 最高原則：FAIL-OPEN。解析不了輸入、載不到判準、沒有可看的欄位 → 放行。
 * ★ 範圍：防手滑，不是沙箱。
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

const GMAIL_WRITE = ['create_draft', 'update_draft', 'reply', 'send_message'];
const BROWSER_TYPE_TOOL = /(?:^|__)(?:javascript_tool|computer|form_input|browser_batch|browser_type|browser_evaluate|browser_fill_form|browser_run_code_unsafe)$/;

const FIX = '修法：稱謂行後面直接接正文——純文字 "Hi X,\\n正文"、HTML "Hi X,<br>正文"（不是 <br><br>）、\n' +
  '逐行陣列 ["Hi X,","正文",…]；段落之間才空一行。（SKILL.md 第一步要點 2、第三步之三 格式）';

function main(raw) {
  let input;
  try { input = JSON.parse(raw); } catch (_) { return process.exit(0); }
  if (!input || typeof input !== 'object') return process.exit(0);
  const toolName = C.safeStr(input.tool_name);
  const toolInput = (input.tool_input && typeof input.tool_input === 'object') ? input.tool_input : {};

  const gmail = GMAIL_WRITE.find((s) => C.isGmailTool(toolName, s));
  if (gmail) {
    const body = C.safeStr(toolInput.body);
    const html = C.safeStr(toolInput.htmlBody);
    const hit = (html.trim() ? C.greetingGapHtml(html) : null) || (body.trim() ? C.greetingGapText(body) : null);
    if (!hit) return process.exit(0);
    const field = html.trim() && C.greetingGapHtml(html) ? 'htmlBody' : 'body';
    return deny(
      `${field} 的稱謂行「${hit.greeting}」後面空了一行（${hit.how}），已先擋下這次 ${gmail}。\n` +
      '稱謂行下一行直接接正文、不留空行，是使用者的固定偏好（2026-11-04 實案，截圖退件\n' +
      '「怎麼又有信第二行是空白」）。\n' + FIX
    );
  }

  if (BROWSER_TYPE_TOOL.test(toolName)) {
    const hit = C.greetingGapInStrings(toolInput);
    if (!hit) return process.exit(0);
    return deny(
      `要打進頁面的內容裡，稱謂行「${hit.greeting}」後面接著空行，已先擋下這次 ${toolName.split('__').pop()}。\n` +
      '稱謂行下一行直接接正文、不留空行，是使用者的固定偏好（2026-11-04 實案：Gmail 工具斷線改用\n' +
      '瀏覽器寫草稿，寫成 ["Hi Tina,","",…]，截圖退件「怎麼又有信第二行是空白」）。\n' + FIX
    );
  }
  return process.exit(0);
}
