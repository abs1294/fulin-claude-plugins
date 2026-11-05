#!/usr/bin/env node
/**
 * greeting-gate 測試 —— 跑法：node hooks/tests/greeting-gate.test.js
 *
 * 三層：① core 判準（greetingGapText／greetingGapHtml／greetingGapInStrings）逐案例
 *       ② hook 子程序端對端（Gmail 寫入四種工具、瀏覽器打字類工具、fail-open）
 *       ③ 2026-11-04 實案的兩種輸入形狀（create_draft 的 body、javascript_tool 的逐行陣列）
 */
const path = require('path');
const { spawnSync } = require('child_process');
const C = require(path.join(__dirname, '..', 'lib', 'draft-checks.core.js'));
const GATE = path.join(__dirname, '..', 'greeting-gate.js');

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  cond ? pass++ : fail++;
  console.log('  ' + (cond ? 'PASS' : '** FAIL **').padEnd(12) + label + (cond ? '' : '  → ' + (extra || '')));
}

console.log('=== core：純文字 body ===');
const TEXT = [
  ['Hi Tina,\n\n正文', true, '實案形狀'],
  ['Hi Tina,\n正文', false, '直接接正文'],
  ['Hi Tina,\r\n\r\n正文', true, 'CRLF'],
  ['\n\nHi Tina,\n \n正文', true, '開頭空行跳過、下一行只有空白也算空行'],
  ['Hi Tina,\n \n正文', true, '下一行是 nbsp'],
  ['正文\n\nHi Tina,\n\n再見', false, '稱謂不在開頭不管'],
  ['Hi,\n\n正文', true, '沒稱呼的 Hi,'],
  ['Dear Jen,\n\n正文', true, 'Dear'],
  ['Hello\n\n正文', true, '沒逗號'],
  ['Hi A & B,\n\n正文', true, '多人'],
  ['Hi 佳宣：\n\n正文', true, '全形冒號'],
  ['Tina 您好，\n\n正文', true, '中文稱謂'],
  ['您好\n\n正文', true, '只有您好'],
  ['High risk\n\n正文', false, 'Hi 開頭的普通字不算稱謂'],
  ['Hidden\n\nx', false, 'Hidden 不是稱謂'],
  ['Dear Jen,', false, '只有稱謂行沒下一行'],
  ['', false, '空字串'],
  [null, false, '非字串'],
  ['附件 3 份：\n\n1. a', false, '第一行不是稱謂'],
  ['Hi Tina, 附件是更新後的工項表。\n\n依您標註', false, '稱謂和正文同一行（逗號後還有字）→ 不是稱謂行'],
];
for (const [t, want, label] of TEXT) {
  const r = C.greetingGapText(t);
  ok(!!r === want, label + '：' + JSON.stringify(t).slice(0, 40), JSON.stringify(r));
}

console.log('=== core：htmlBody ===');
const HTML = [
  ['Hi Tina,<br><br>正文', true, '<br><br>'],
  ['Hi Tina,<br>正文', false, '<br> 直接接'],
  ['<div dir="ltr">Hi 暉東,<br>正式站的 HTTPS 已經上線</div>', false, 'SKILL 範例寫法'],
  ['<div dir="ltr">Hi 暉東,<br><br>正式站</div>', true, '2.4.0 以前 SKILL 範例的錯寫法'],
  ['<div dir="ltr"><div>Hi Tina,</div><div><br></div><div>正文</div></div>', true, 'Gmail 編輯器存的空行'],
  ['<div dir="ltr"><div>Hi Tina,<br></div><div>正文</div></div>', false, '區塊結尾的 br 瀏覽器不畫'],
  ['<div><div>Hi A & B,</div></div><div>正文</div>', false, '連續兩個 </div> 算一個邊界'],
  ['<div dir="ltr">Hi Tina,</div><div></div><div>正文</div>', false, '空 div 沒高度'],
  ['<div dir="ltr">Hi Tina,</div><div><br>正文</div>', true, '區塊開頭的 br 是空行'],
  ['Hi,<br>&nbsp;<br>正文', true, 'nbsp 夾在兩個 br 中間'],
  ['Hi,<br>\n<br>正文', true, '換行字元夾在中間'],
  ['Hi,<br/><br />正文', true, '自閉合 br'],
  ['Dear Jen,<br><ol><li>x</li></ol>', false, '稱謂後直接清單'],
  ['Dear Jen,<br><br><ol><li>x</li></ol>', true, '稱謂後空行再清單'],
  ['<b>Hi</b> Tina,<br>正文', false, '行內標籤拆開的稱謂'],
  ['<b>Hi</b> Tina,<br><br>正文', true, '行內標籤拆開的稱謂＋空行'],
  ['<span style="color:#000">Hi Tina,</span><br><br>正文', true, 'span 包住'],
  ['Tina 您好，<br><br>正文', true, '中文稱謂'],
  ['您好，<br>正文', false, '中文稱謂直接接'],
  ['附件 3 份：<br><br><ol><li>a</li></ol>', false, '第一行不是稱謂'],
  ['Hi Tina,<br>正文<br><br>Hi again,<br><br>x', false, '正文中間的 Hi 不管'],
  ['<div class="gmail_quote">Hi Fulin,<br><br>對方的信</div>', false, '引用區裡對方的稱謂不算'],
  ['Hi Tina,<br>正文<div class="gmail_quote"><blockquote>Hi Fulin,<br><br>對方的信</blockquote></div>', false, '自己的對、引用區不算'],
  ['<div dir="ltr">Hi Tina,<br><br>正文</div><div class="gmail_signature">sig</div>', true, '有簽名檔也抓得到'],
  ['<div dir="ltr">Hi Tina,<br></div><div class="gmail_signature"><div><br></div>sig</div>', false, '簽名檔裡的空行不算'],
  ['', false, '空字串'],
  ['Hi Tina,', false, '只有稱謂'],
  ['<p>Hi Tina,</p><p>正文</p>', false, '<p> 分段由 paragraph-gate 管，這裡停在 <p> 不重複報'],
  ['<!-- Hi X,<br><br> -->Hi Tina,<br>正文', false, '註解不算'],
  ['Hi Tina,<br><br>' + '正文'.repeat(5000), true, '長正文'],
  ['<div '.repeat(50000) + 'Hi,<br><br>x', false, '惡意輸入：沒有 > 的標籤海（只看前 6000 字元、不當掉）'],
];
for (const [h, want, label] of HTML) {
  const t0 = Date.now();
  const r = C.greetingGapHtml(h);
  const ms = Date.now() - t0;
  ok(!!r === want && ms < 2000, label + '：' + JSON.stringify(h).slice(0, 50), JSON.stringify(r) + ' ' + ms + 'ms');
}

console.log('=== core：瀏覽器工具參數裡的字串 ===');
const STR = [
  [{ text: 'const L=["Hi Tina,","","正文"]' }, true, '逐行陣列（實案形狀）'],
  [{ text: 'const L=["Hi Tina,","正文"]' }, false, '逐行陣列沒空行'],
  [{ text: "const L=['Hi Tina,', '', '正文']" }, true, '單引號逐行陣列、有空白'],
  [{ text: 'b.innerText="Hi Tina,\\n\\n正文"' }, true, '程式碼裡的字面 \\n\\n'],
  [{ text: 'b.innerText="Hi Tina,\\n正文"' }, false, '程式碼裡的字面 \\n'],
  [{ text: 'b.innerText="Hi Tina,\\r\\n\\r\\n正文"' }, true, '字面 \\r\\n\\r\\n'],
  [{ action: 'type', text: 'Hi Tina,\n\n正文' }, true, 'computer type 真換行'],
  [{ action: 'type', text: 'Hi Tina,\n正文' }, false, 'computer type 直接接'],
  [{ text: 'b.innerHTML="Hi Tina,<br><br>正文"' }, true, 'innerHTML <br><br>'],
  [{ text: 'b.innerHTML="Hi Tina,<br>正文"' }, false, 'innerHTML <br>'],
  [{ text: 'b.innerHTML="Hi Tina,<br>&nbsp;<br>正文"' }, true, 'innerHTML <br>&nbsp;<br>'],
  [{ text: "document.querySelector('div[aria-label=\"郵件內文\"]').innerText" }, false, '讀 DOM 的腳本'],
  [{ text: "if (s.startsWith('Hi')) {\n\n}" }, false, '程式碼裡的 Hi 不是稱謂'],
  [{ nested: { deep: ['x', { t: '`Hi Ken,\n\nx`' }] } }, true, '巢狀參數（browser_batch）'],
  [{ fields: [{ ref: 'r1', value: 'Dear Jen,\n\n正文' }] }, true, 'form_input 的 value'],
  ['Hi Tina,\n\n正文', true, '頂層就是字串'],
  [{ text: 'x'.repeat(300000) + 'Hi Tina,\n\n正文' }, false, '超過掃描上限的部分不看（不當掉）'],
  [null, false, 'null'],
  [{}, false, '空物件'],
];
for (const [o, want, label] of STR) {
  const r = C.greetingGapInStrings(o);
  ok(!!r === want, label, JSON.stringify(r));
}

console.log('=== hook 子程序端對端 ===');
function run(payload) {
  const p = spawnSync(process.execPath, [GATE], { input: typeof payload === 'string' ? payload : JSON.stringify(payload), encoding: 'utf8' });
  let o = null; try { o = JSON.parse(p.stdout); } catch (_) {}
  const decision = o && o.hookSpecificOutput ? o.hookSpecificOutput.permissionDecision : 'allow';
  const reason = o && o.hookSpecificOutput ? o.hookSpecificOutput.permissionDecisionReason || '' : '';
  return { code: p.status, decision, reason, out: p.stdout };
}
function th(label, payload, want, mustContain) {
  const r = run(payload);
  ok(r.code === 0 && r.decision === want && (!mustContain || r.reason.indexOf(mustContain) !== -1), label, r.decision + ' ' + r.out.slice(0, 200));
  return r.reason;
}
const G = (suffix, tool_input) => ({ tool_name: 'mcp__claude_ai_Gmail__' + suffix, tool_input });
// 2026-11-04 實案：create_draft 的 body（原文開頭）
const REAL_BODY = 'Hi Tina,\n\n附件是更新後的 10 月工項表，本月合計 13.5 人天，共 94,500 元（未稅）。\n\n依您標註與今天討論的結果，調整如下：\n\n1. Tracker 不列入 10 月，延至 11 月結算。';
const reason1 = th('實案：create_draft body「Hi Tina,」＋空行 → deny', G('create_draft', { replyToMessageId: 'x', to: ['a@b'], subject: 'Re: x', includeSignature: true, body: REAL_BODY }), 'deny', 'body 的稱謂行「Hi Tina,」');
th('同內容改成直接接正文 → 放行', G('create_draft', { body: REAL_BODY.replace('Hi Tina,\n\n', 'Hi Tina,\n') }), 'allow');
th('update_draft htmlBody <br><br> → deny', G('update_draft', { draftId: 'r1', htmlBody: '<div dir="ltr">Hi Tina,<br><br>正文</div>' }), 'deny', 'htmlBody 的稱謂行');
th('update_draft htmlBody Gmail 編輯器空行 → deny', G('update_draft', { draftId: 'r1', htmlBody: '<div dir="ltr"><div>Hi Tina,</div><div><br></div><div>正文</div></div>' }), 'deny', '2 個換行');
th('update_draft htmlBody 正確寫法 → 放行', G('update_draft', { draftId: 'r1', htmlBody: '<div dir="ltr">Hi Tina,<br>正文<br><br>第二段</div>' }), 'allow');
th('reply body 空行 → deny', G('reply', { messageId: 'm', body: 'Hi Ken,\n\n正文' }), 'deny', 'reply');
th('send_message htmlBody 空行 → deny', G('send_message', { to: ['a@b'], htmlBody: 'Dear Jen,<br><br>正文' }), 'deny', 'send_message');
th('htmlBody 對、body 錯（body 是純文字替代版）→ 仍 deny（兩個都要對）', G('create_draft', { body: 'Hi Tina,\n\n正文', htmlBody: 'Hi Tina,<br>正文' }), 'deny', 'body 的稱謂行');
th('get_draft（非寫入）→ 放行', G('get_draft', { draftId: 'r1' }), 'allow');
th('沒有 body／htmlBody → 放行', G('update_draft', { draftId: 'r1', subject: 's' }), 'allow');
// 2026-11-04 實案：javascript_tool 把逐行陣列打進 Gmail 編輯器
const REAL_JS = 'const b=document.querySelector(\'div[aria-label="郵件內文"],div[role="textbox"][g_editable="true"]\');b.focus();\n' +
  'const L=["Hi Tina,","","附件是更新後的 10 月工項表，本月合計 13.5 人天，共 94,500 元（未稅）。","","依您標註與今天討論的結果，調整如下：","","1. Tracker 不列入 10 月"];';
const reason2 = th('實案：javascript_tool 逐行陣列 ["Hi Tina,","",…] → deny', { tool_name: 'mcp__claude-in-chrome__javascript_tool', tool_input: { action: 'javascript_exec', tabId: 1, text: REAL_JS } }, 'deny', '稱謂行「Hi Tina,」');
th('同腳本拿掉空行 → 放行', { tool_name: 'mcp__claude-in-chrome__javascript_tool', tool_input: { action: 'javascript_exec', tabId: 1, text: REAL_JS.replace('"Hi Tina,","",', '"Hi Tina,",') } }, 'allow');
th('computer type 真換行 → deny', { tool_name: 'mcp__claude-in-chrome__computer', tool_input: { action: 'type', tabId: 1, text: 'Hi Tina,\n\n正文' } }, 'deny', 'computer');
th('computer 截圖（沒有文字）→ 放行', { tool_name: 'mcp__claude-in-chrome__computer', tool_input: { action: 'screenshot', tabId: 1 } }, 'allow');
th('Playwright browser_type → deny', { tool_name: 'mcp__playwright__browser_type', tool_input: { ref: 'e1', text: 'Dear Jen,\n\n正文' } }, 'deny', 'browser_type');
th('Playwright browser_evaluate 字面 \\n\\n → deny', { tool_name: 'mcp__playwright__browser_evaluate', tool_input: { function: '() => { el.innerText = "Hi Ken,\\n\\n正文" }' } }, 'deny');
th('browser_batch 巢狀 → deny', { tool_name: 'mcp__claude-in-chrome__browser_batch', tool_input: { actions: [{ tool: 'computer', input: { action: 'type', text: 'Hi Ken,\n\n正文' } }] } }, 'deny');
th('navigate（非打字類）帶同字串 → 放行', { tool_name: 'mcp__claude-in-chrome__navigate', tool_input: { url: 'x', note: 'Hi Ken,\n\n正文' } }, 'allow');
th('javascript_tool 讀 DOM 的腳本 → 放行', { tool_name: 'mcp__claude-in-chrome__javascript_tool', tool_input: { text: REAL_JS.split('\n')[0] + 'console.log(b.innerText.length)' } }, 'allow');

console.log('=== fail-open ===');
th('壞 JSON → 放行', 'not json', 'allow');
th('空輸入 → 放行', '', 'allow');
th('tool_input 不是物件 → 放行', { tool_name: 'mcp__claude_ai_Gmail__create_draft', tool_input: 'x' }, 'allow');
th('body 不是字串 → 放行', { tool_name: 'mcp__claude_ai_Gmail__create_draft', tool_input: { body: 123 } }, 'allow');
th('沒有 tool_name → 放行', { tool_input: { body: 'Hi,\n\nx' } }, 'allow');
{
  const t0 = Date.now();
  const r = run(G('update_draft', { draftId: 'r1', htmlBody: '<div '.repeat(50000) + 'Hi,<br><br>x' }));
  ok(r.code === 0 && Date.now() - t0 < 5000, '惡意輸入 250 KB 沒有 > 的標籤海：不超時（' + (Date.now() - t0) + 'ms）', r.out.slice(0, 100));
}

console.log('\n--- deny 理由（Gmail）---\n' + reason1 + '\n\n--- deny 理由（瀏覽器）---\n' + reason2 + '\n');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
