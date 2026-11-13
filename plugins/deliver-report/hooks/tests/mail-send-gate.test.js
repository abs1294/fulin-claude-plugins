// mail-send-gate 實跑測試：spawn 真行程、餵真 stdin、看輸出決定
'use strict';
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const GATE = path.join(__dirname, '..', 'mail-send-gate.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'msg-gate-'));
let pass = 0, fail = 0;

function transcript(name, prompt, extra) {
  const lines = [
    { type: 'user', promptId: 'p1', message: { role: 'user', content: prompt } },
    ...(extra || []),
  ];
  const tp = path.join(TMP, name + '.jsonl');
  fs.writeFileSync(tp, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return tp;
}
const findResult = (txt) => ({ type: 'user', promptId: 'p1', toolUseResult: {}, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: txt }] }] } });
const navUse = (url) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't0', name: 'mcp__claude-in-chrome__navigate', input: { url } }] } });

function run(label, tool, input, tp, expect) {
  const r = spawnSync('node', [GATE], { input: JSON.stringify({ tool_name: tool, tool_input: input, transcript_path: tp || '' }), encoding: 'utf8' });
  const got = /"permissionDecision":"deny"/.test(r.stdout) ? 'deny' : 'allow';
  if (got === expect && r.status === 0) { pass++; console.log('ok  ', label); }
  else { fail++; console.log('FAIL', label, 'expect', expect, 'got', got, 'exit', r.status, r.stdout.slice(0, 200)); }
}

const askOnly = transcript('ask', '這份測試報告幫我寄給YCLIAO0', [
  navUse('https://mail.google.com/mail/?authuser=x#all?compose=1'),
  findResult('42 elements share words with the query; the 20 closest:\nref_1858 button "傳送"\nref_1859 button "更多傳送選項"'),
]);
const allowSay = transcript('allow', '草稿我看過了，你按傳送', [
  findResult('ref_1858 button "傳送"'),
]);
const pwSnap = transcript('pw', '幫我寄給他', [
  findResult('- button "傳送" [ref=e512]\n- button "儲存並關閉" [ref=e600]'),
]);

// 1. Gmail 直接寄出的工具
run('send_message 擋', 'mcp__claude_ai_Gmail__send_message', { to: ['a@b'], body: 'x' }, askOnly, 'deny');
run('reply 擋', 'mcp__claude_ai_Gmail__reply', { messageId: '1', body: 'x' }, askOnly, 'deny');
run('forward 擋', 'mcp__claude_ai_Gmail__forward', { messageId: '1', to: ['a@b'] }, askOnly, 'deny');
run('send_message 使用者明講按傳送 → 放行', 'mcp__claude_ai_Gmail__send_message', { to: ['a@b'] }, allowSay, 'allow');
// 2. 2026-11-13 實案重現：find 查到 ref_1858 是傳送，再點它
run('實案：點 ref_1858（傳送）擋', 'mcp__claude-in-chrome__computer', { action: 'left_click', tabId: 1, ref: 'ref_1858' }, askOnly, 'deny');
run('點別的 ref（儲存並關閉）放行', 'mcp__claude-in-chrome__computer', { action: 'left_click', tabId: 1, ref: 'ref_2000' }, askOnly, 'allow');
run('action_summary 寫寄出 擋', 'mcp__claude-in-chrome__computer', { action: 'left_click', coordinate: [1, 2], action_summary: 'Sends the test report email to YCLIAO0@winbond.com' }, '', 'deny');
run('截圖放行', 'mcp__claude-in-chrome__computer', { action: 'screenshot', tabId: 1 }, askOnly, 'allow');
run('Gmail 頁 Ctrl+Enter 擋', 'mcp__claude-in-chrome__computer', { action: 'key', text: 'ctrl+Enter' }, askOnly, 'deny');
run('沒開 Gmail 的 Ctrl+Enter 放行', 'mcp__claude-in-chrome__computer', { action: 'key', text: 'ctrl+Enter' }, transcript('nogmail', 'x'), 'allow');
run('browser_batch 內含點傳送 擋', 'mcp__claude-in-chrome__browser_batch', { actions: [{ action: 'screenshot' }, { action: 'left_click', ref: 'ref_1858' }] }, askOnly, 'deny');
run('使用者明講按傳送 → 點 ref_1858 放行', 'mcp__claude-in-chrome__computer', { action: 'left_click', ref: 'ref_1858' }, allowSay, 'allow');
// 3. 網頁腳本
run('JS 點 aria-label 傳送 擋', 'mcp__claude-in-chrome__javascript_tool', { action: 'javascript_exec', text: "document.querySelector('[aria-label^=\"傳送\"]').click()" }, askOnly, 'deny');
run('JS 讀撰寫視窗內容放行', 'mcp__claude-in-chrome__javascript_tool', { action: 'javascript_exec', text: "[...document.querySelectorAll('div[role=dialog]')].map(d=>d.innerText).join('')" }, askOnly, 'allow');
// 4. Playwright
run('PW click element 傳送 按鈕 擋', 'mcp__playwright__browser_click', { element: '傳送 button', ref: 'e1' }, pwSnap, 'deny');
run('PW click ref 為快照中的傳送 擋', 'mcp__playwright__browser_click', { element: 'Gmail 按鈕', ref: 'e512' }, pwSnap, 'deny');
run('PW click 儲存並關閉 放行', 'mcp__playwright__browser_click', { element: '儲存並關閉', ref: 'e600' }, pwSnap, 'allow');
// 5. fail-open
const r = spawnSync('node', [GATE], { input: 'not json', encoding: 'utf8' });
if (r.status === 0 && !r.stdout) { pass++; console.log('ok   壞輸入放行'); } else { fail++; console.log('FAIL 壞輸入'); }
run('transcript 不存在仍擋 send_message', 'mcp__claude_ai_Gmail__send_message', { to: ['a@b'] }, path.join(TMP, 'nope.jsonl'), 'deny');

console.log(`\n${pass} passed, ${fail} failed`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
