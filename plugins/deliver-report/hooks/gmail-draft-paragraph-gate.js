#!/usr/bin/env node
/**
 * gmail-draft-paragraph-gate — htmlBody 不准用 <p> 分段（PreToolUse，硬擋）
 *
 * ── 為什麼會有這支（2026-11-03 實案）──────────────────────────
 * SKILL.md 第三步之三自 0.18.0 起就寫「換行一律用 <br>，禁止用 <p>」，PostToolUse 閘
 * （gmail-draft-posttool-gate）的標籤白名單也會報 <p>——但 PostToolUse 只能提醒，工具已經跑完。
 * 2026-11-03 回覆草稿寫成 <p>Hi Soloment,<br>…</p>\n\n<p>…</p>，PostToolUse 當場提醒
 * 「■ htmlBody 用了白名單以外的標籤或屬性：<p>」，模型照樣交付；Gmail 把 <p> 的上下邊距
 * 原樣顯示，收件人列和稱謂行之間空出一大段、每段之間也多一截，使用者截圖退件
 * （原話「你為什麼有padding」）。同一個 session 這句提醒出現過 9 次都沒被理。
 * 2026-09-17 也發生過一次（7 個 <p>，「我根本改不了」）。提醒擋不住就改成 deny。
 *
 * ── 行為 ─────────────────────────────────────────────────────
 *   create_draft／update_draft 的 htmlBody，剝掉簽名檔（gmail_signature）與引用區
 *   （gmail_quote／gmail_extra／gmail_attr 的 div、blockquote）之後還有 <p> 開頭標籤 → deny。
 *   引用區要剝，是因為 update_draft 以 get_draft 讀回為底，原信若是 Outlook 寫的滿是
 *   <p class="MsoNormal">——那是對方的，不是這次寫的。
 *   只擋 <p>，不擋其餘白名單外的標籤：使用者在 Gmail 介面手改過的草稿讀回來會帶編輯器自己
 *   產生的巢狀 <div>／<span>，硬擋會讓「以讀回為底改草稿」走不下去；那些仍由 PostToolUse 提醒。
 *   判準在 draft-checks.core.js：paragraphTags()、stripQuotedRegions()（兩者共用 scanTags 單趟掃描，
 *   線性；2026-11-03 獨立審查實測正則版在 '<div '.repeat(50000) 這類沒有 '>' 的輸入要跑 19 秒、
 *   超過 15 秒 timeout 被中止＝閘靜默失效，故不用正則剝引用區、也不呼叫正則版 stripSignature）。
 *
 * ★ 最高原則：FAIL-OPEN。解析不了輸入、載不到判準、沒有 htmlBody → 放行。
 *   刻意不放行的只有「引用區沒有配對的結束標籤」：剝不掉就照正文算，寧可多擋一次
 *   （修法是把自己那段的 <p> 改掉，代價很小），也不要讓內容藏進沒收尾的引用區躲過閘。
 * ★ 範圍：防手滑，不是沙箱。刻意把正文包進假的 blockquote 來躲，不在這道閘的範圍。
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
  const html = C.safeStr(toolInput.htmlBody);
  if (!html.trim()) return process.exit(0);

  // 引用區與簽名檔一起由單趟掃描剝掉；不呼叫正則版 stripSignature()（惡意輸入會二次方、拖過 timeout）
  const own = C.stripQuotedRegions(html);
  const hits = C.paragraphTags(own);
  if (!hits.length) return process.exit(0);

  const sample = hits.filter((v, i) => hits.indexOf(v) === i).slice(0, 3).join('、');
  return deny(
    `htmlBody 用 <p> 分段（共 ${hits.length} 處，例如 ${sample}），已先擋下這次 ${suffix}。\n` +
    'Gmail 會把 <p> 的上下邊距原樣顯示：第一個 <p> 把收件人列和稱謂行之間撐出一大段空白、\n' +
    '段落之間也多一截（2026-11-03 實案，使用者截圖退件「你為什麼有padding」）；而且使用者在\n' +
    'Gmail 編輯器裡改一個字就可能整段跑版（2026-09-17 實案，7 個 <p>，「我根本改不了」）。\n' +
    '修法：整封只包一層 <div dir="ltr">，段落用 <br> 分——段內換行 <br>、段落之間空一行 <br><br>；\n' +
    '稱謂行寫 Hi X,<br> 直接接正文、不空行；清單照舊 <ol>／<ul><li>；不要改成每段一個 <div>。\n' +
    '引用區（gmail_quote／blockquote）與簽名檔（gmail_signature）裡的 <p> 是對方或 Gmail 的，\n' +
    '這道閘不算它們——update_draft 以 get_draft 讀回為底時，只要把自己寫的那段改掉。\n' +
    '（SKILL.md 第三步之三 格式）'
  );
}
