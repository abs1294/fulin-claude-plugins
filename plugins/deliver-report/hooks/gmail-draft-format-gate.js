#!/usr/bin/env node
/**
 * gmail-draft-format-gate — 草稿格式硬擋（PreToolUse，掛 create_draft／update_draft）
 *
 * ── 為什麼會有這支（2026-11-13 實案）──────────────────────────
 * SKILL.md 第三步之三早就寫了「預設給 htmlBody」「序號與列點一律用清單標籤，禁止手打」，
 * PostToolUse 閘也會提醒——但那支閘的提醒輸出格式錯了（systemMessage 塞在 hookSpecificOutput 裡），
 * 一個 session 建了 7 次草稿，提醒一次都沒送到模型：
 *   1. 第一版只給純文字 body，設定名稱 logging.file.name 被 Gmail 改寫成 google.com/url?q=… 連結；
 *   2. 之後每一版都用 <br> 手打「1.」「- 」，使用者截圖退件「為什麼不用 OL LI」。
 * 提醒擋不住就改成 deny（與 gmail-draft-paragraph-gate 擋 <p> 同一個理由）。
 *
 * ── 行為 ─────────────────────────────────────────────────────
 *   (1) 只給 body、沒給 htmlBody → deny。
 *       create_draft：純文字裡的網址會被改寫、行首縮排會被吃掉、沒有清單標籤。
 *       update_draft：只帶 body 會把既有的 HTML 內文整段清掉（SKILL.md 第三步之三）。
 *   (2) htmlBody 正文（剝掉引用區與簽名檔）手打序號或列點 ≥2 處 → deny。
 *       判準沿用 draft-checks.core.js 的 handTypedLists()（<pre> 與引用區不算）。
 *
 * ★ 最高原則：FAIL-OPEN。解析不了輸入、載不到判準 → 放行。
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

  const ti = (input.tool_input && typeof input.tool_input === 'object') ? input.tool_input : {};
  const html = C.safeStr(ti.htmlBody);
  const body = C.safeStr(ti.body);

  // (1) 只有純文字
  if (!html.trim() && body.trim()) {
    return deny(
      `這次 ${suffix} 只帶了純文字 body、沒有 htmlBody，已先擋下。\n` +
      '純文字草稿的三個坑都是實案：①看起來像網址的字串會被 Gmail 改寫成 google.com/url?q= 連結\n' +
      '（2026-11-13：設定名稱 logging.file.name 被改寫，對方照貼會貼錯）；②行首縮排會被吃掉；\n' +
      '③沒有清單標籤，序號與列點只能手打。' +
      (suffix === 'update_draft' ? '另外 update_draft 只帶 body 會把草稿既有的 HTML 內文整段清掉。\n' : '\n') +
      '修法：htmlBody 與 body 都給——htmlBody 是對方實際看到的版本（整封包一層 <div dir="ltr">，\n' +
      '段落用 <br>、清單用 <ol>／<ul><li>、小標用 <b>），body 放同一份內容的純文字當退路。\n' +
      '（SKILL.md 第三步之三 格式）'
    );
  }

  // (2) 手打序號／列點
  if (html.trim()) {
    const lists = C.handTypedLists(C.stripQuotedRegions(html));
    if (lists.length) {
      return deny(
        `htmlBody 用 <br> 手打序號或列點（${lists.join('、')}），已先擋下這次 ${suffix}。\n` +
        '有順序的用 <ol><li>，沒順序的用 <ul><li>；同一點的補充行用 <br> 接在同一個 <li> 裡。\n' +
        '手打的「1.」「- 」在 Gmail 編輯器裡只是文字，使用者增刪一項就得自己重編號、子行也對不齊\n' +
        '（2026-11-13 實案：使用者截圖退件「為什麼不用 OL LI」）。\n' +
        '純文字 body 退路照常手打「1.」即可——這道閘只看 htmlBody。（SKILL.md 第三步之三 格式）'
      );
    }
  }

  return process.exit(0);
}
