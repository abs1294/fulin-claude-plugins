#!/usr/bin/env node
/**
 * 附件清單 ↔ attachments 比對 —— 跑法：node hooks/tests/attachment-list.test.js
 *
 * 2026-10-11 使用者回報：信裡附件清單列 3 個檔，草稿實際只附 2 個。
 * 判準 attachmentListMismatch（draft-checks.core.js），由 PreToolUse 閘
 * gmail-draft-attachment-gate.js 擋下；這裡同時測判準與閘的端到端輸出。
 */
const path = require('path');
const { spawnSync } = require('child_process');
const C = require(path.join(__dirname, '..', 'lib', 'draft-checks.core.js'));
const GATE = path.join(__dirname, '..', 'gmail-draft-attachment-gate.js');

let pass = 0, fail = 0;
function t(label, input, wantProblems) {
  const r = C.attachmentListMismatch(input);
  const got = r ? r.problems.length > 0 : false;
  const ok = got === wantProblems;
  ok ? pass++ : fail++;
  console.log('  ' + (ok ? 'PASS' : '** FAIL **').padEnd(12) + label + (ok ? '' : '  → ' + JSON.stringify(r)));
}
const A = (...names) => names.map((n) => ({ filename: n, content: 'AAAA' }));
const LIST3 = '<div dir="ltr">Hi,<br><br>附件 3 份：<br><ol><li>盤點報告.docx — 全案評估</li><li>時程.xlsx — 甘特圖</li><li>設定檔.zip — 原始資料</li></ol>謝謝！</div>';

console.log('=== 應擋 ===');
t('實案：列 3 個只附 2 個', { htmlBody: LIST3, attachments: A('盤點報告.docx', '時程.xlsx') }, true);
t('附了 4 個、清單只列 3 個', { htmlBody: LIST3, attachments: A('盤點報告.docx', '時程.xlsx', '設定檔.zip', 'x.pdf') }, true);
t('個數對但檔名不對（附錯檔）', { htmlBody: LIST3, attachments: A('盤點報告.docx', '時程.xlsx', '舊版.zip') }, true);
t('標題寫 3 份、清單只有 2 項（無附件也擋）',
  { htmlBody: '<div dir="ltr">附件三份：<br><ol><li>a.pdf</li><li>b.pdf</li></ol></div>' }, true);
t('「隨信附上兩份檔案」＋ <ul>，只附 1 個',
  { htmlBody: '<div dir="ltr">隨信附上兩份檔案：<ul><li>報告</li><li>附錄</li></ul></div>', attachments: A('報告.pdf') }, true);
t('沒寫 </li> 的清單仍數得出 3 項',
  { htmlBody: '<div dir="ltr">附件：<br><ol><li>a.pdf<li>b.pdf<li>c.pdf</ol></div>', attachments: A('a.pdf', 'b.pdf') }, true);
t('inline 圖不算附件數',
  { htmlBody: '<div dir="ltr">附件：<ol><li>a.pdf</li><li>b.pdf</li></ol></div>',
    attachments: [{ filename: 'a.pdf', content: 'A' }, { filename: 'logo.png', content: 'A', inline: true }] }, true);

console.log('=== 應放行 ===');
t('3 個全附、檔名對得上', { htmlBody: LIST3, attachments: A('盤點報告.docx', '時程.xlsx', '設定檔.zip') }, false);
t('無附件（瀏覽器上傳流程先建草稿）→ 交給 (H) 提醒', { htmlBody: LIST3 }, false);
t('子清單是補充說明，只數第一層',
  { htmlBody: '<div dir="ltr">附件 2 份：<ol><li>a.pdf<ul><li>第 1 節</li><li>第 2 節</li></ul></li><li>b.pdf</li></ol></div>', attachments: A('a.pdf', 'b.pdf') }, false);
t('<a href> 項目是雲端連結，不計入附件',
  { htmlBody: '<div dir="ltr">附件 3 份：<ol><li>a.pdf</li><li>b.pdf</li><li><a href="https://drive.google.com/x">影片（雲端）</a></li></ol></div>', attachments: A('a.pdf', 'b.pdf') }, false);
t('非附件清單（改完確認步驟）不檢查',
  { htmlBody: '<div dir="ltr">改完確認：<br><ol><li>回應要有 Location</li><li>指向加密版</li></ol></div>', attachments: A('a.pdf') }, false);
t('「附件」開頭的一般句子不當清單標題',
  { htmlBody: '<div dir="ltr">附件裡的報告比較了三個方案，步驟如下：<ol><li>甲</li><li>乙</li></ol></div>', attachments: A('a.pdf') }, false);
t('句中提到附件的長句不當清單標題',
  { htmlBody: '<div dir="ltr">處理步驟（細節見附件三份報告）：<br><ol><li>甲</li><li>乙</li></ol></div>', attachments: A('a.pdf') }, false);
t('引用原信裡的附件清單不歸這封信',
  { htmlBody: '<div dir="ltr">收到，謝謝<br></div><div class="gmail_quote"><div>附件：<ol><li>x.pdf</li><li>y.pdf</li></ol></div></div>', attachments: A('z.pdf') }, false);
t('清單項只寫說明沒寫檔名，個數對 → 放行',
  { htmlBody: '<div dir="ltr">附件 2 份：<ol><li>盤點報告</li><li>時程表</li></ol></div>', attachments: A('r.docx', 's.xlsx') }, false);
t('沒有 htmlBody', { body: '附件 3 份', attachments: A('a.pdf') }, false);
t('壞輸入', null, false);

console.log('=== 閘端到端（實跑 hook 子程序）===');
function runGate(payload) {
  const p = spawnSync(process.execPath, [GATE], { input: JSON.stringify(payload), encoding: 'utf8' });
  return { code: p.status, out: p.stdout };
}
function g(label, payload, wantDeny, mustContain) {
  const { code, out } = runGate(payload);
  let deny = false, reason = '';
  try { const o = JSON.parse(out); deny = o.hookSpecificOutput.permissionDecision === 'deny'; reason = o.hookSpecificOutput.permissionDecisionReason; } catch (_) {}
  const ok = code === 0 && deny === wantDeny && (!mustContain || reason.indexOf(mustContain) !== -1);
  ok ? pass++ : fail++;
  console.log('  ' + (ok ? 'PASS' : '** FAIL **').padEnd(12) + label + (ok ? '' : '  → code=' + code + ' out=' + out));
  return reason;
}
const reason = g('create_draft 列 3 附 2 → deny', {
  tool_name: 'mcp__claude_ai_Gmail__create_draft',
  tool_input: { htmlBody: LIST3, attachments: A('盤點報告.docx', '時程.xlsx') },
}, true, '清單列了 3 個檔，實際附了 2 個');
g('update_draft 同樣擋', {
  tool_name: 'mcp__claude_ai_Gmail__update_draft',
  tool_input: { draftId: 'r1', htmlBody: LIST3, attachments: A('盤點報告.docx') },
}, true, '附件');
g('全附 → 放行', {
  tool_name: 'mcp__claude_ai_Gmail__create_draft',
  tool_input: { htmlBody: LIST3, attachments: A('盤點報告.docx', '時程.xlsx', '設定檔.zip') },
}, false);
g('非 Gmail 工具 → 放行', { tool_name: 'Bash', tool_input: { htmlBody: LIST3 } }, false);
g('壞 stdin → 放行', 'not json', false);
console.log('\n--- deny 理由全文 ---\n' + reason + '\n');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
