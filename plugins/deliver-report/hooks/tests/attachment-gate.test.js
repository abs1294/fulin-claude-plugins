#!/usr/bin/env node
/**
 * 附件兩道閘的測試 — (G) reply 附件帶入 ＋ PreToolUse 25MB 上限
 *
 * 由來：2026-10-06 實案。replyToMessageId 建的回覆草稿被帶入對方原信的
 * 9 張 image.png，沒有任何一道閘出聲，使用者自己打開草稿才發現；
 * 同日 30.6MB zip 超過 API 25MB 上限，模型叫使用者自己拖附件被打回票。
 *
 * 這組測試守住三件事：
 *   1. resultAttachmentCount 必須 parse JSON 取頂層欄位——reply 草稿的
 *      htmlBody 引文區帶著原信內嵌圖 URL，字串搜會把引文顯示圖誤判成附件
 *   2. attachmentsTotalBytes 的 base64 → bytes 換算與邊界
 *   3. attachment-gate 端到端：>25MB deny、≤25MB／無附件／壞輸入 放行
 */

const path = require('path');
const { spawnSync } = require('child_process');
const C = require(path.join(__dirname, '..', 'lib', 'draft-checks.core.js'));

let pass = 0, fail = 0;

function check(desc, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log('  PASS  ' + desc); }
  else { fail++; console.log('  FAIL  ' + desc + '\n        got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want)); }
}

console.log('=== resultAttachmentCount ===');

check('讀回帶 9 個 attachments → 9',
  C.resultAttachmentCount({ content: JSON.stringify({ id: 'r1', attachments: new Array(9).fill({ filename: 'image.png' }) }) }), 9);

check('只有 attachmentIds → 用它的長度',
  C.resultAttachmentCount({ content: JSON.stringify({ id: 'r1', attachmentIds: ['a', 'b'] }) }), 2);

check('無附件欄位 → 0（可銷帳）',
  C.resultAttachmentCount({ content: JSON.stringify({ id: 'r1', htmlBody: 'x' }) }), 0);

check('引文區的內嵌圖 URL 不是附件（防字串搜誤判）',
  C.resultAttachmentCount({ content: JSON.stringify({ id: 'r1', htmlBody: '<img src="https://mail.google.com/mail/u/1?view=fimg&attid=0.6&attbid=ANG" alt="image.png">' }) }), 0);

check('parse 不了 → null（判不出，不出聲）',
  C.resultAttachmentCount({ content: '不是 JSON' }), null);

check('空 res → null', C.resultAttachmentCount(null), null);

console.log('=== attachmentsTotalBytes ===');

check('4 字元 base64 ≒ 3 bytes', C.attachmentsTotalBytes({ attachments: [{ content: 'AAAA' }] }), 3);
check('多附件加總', C.attachmentsTotalBytes({ attachments: [{ content: 'AAAA' }, { content: 'AAAAAAAA' }] }), 9);
check('無 attachments → 0', C.attachmentsTotalBytes({}), 0);
check('content 非字串 → 當 0 計', C.attachmentsTotalBytes({ attachments: [{ content: 123 }] }), 0);

console.log('=== gmail-draft-attachment-gate 端到端 ===');

const GATE = path.join(__dirname, '..', 'gmail-draft-attachment-gate.js');

function runGate(input) {
  const r = spawnSync('node', [GATE], { input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', timeout: 10000 });
  let decision = 'allow';
  if (r.stdout) {
    try {
      const o = JSON.parse(r.stdout);
      if (o.hookSpecificOutput && o.hookSpecificOutput.permissionDecision === 'deny') decision = 'deny';
    } catch (_) { /* 非 JSON 輸出一律當 allow */ }
  }
  return decision;
}

const big = 'A'.repeat(Math.ceil(26 * 1024 * 1024 * 4 / 3));   // ≒26MB
const small = 'A'.repeat(Math.ceil(1 * 1024 * 1024 * 4 / 3));  // ≒1MB

check('26MB 附件 → deny',
  runGate({ tool_name: 'mcp__claude_ai_Gmail__create_draft', tool_input: { attachments: [{ content: big }] } }), 'deny');

check('1MB 附件 → allow',
  runGate({ tool_name: 'mcp__claude_ai_Gmail__create_draft', tool_input: { attachments: [{ content: small }] } }), 'allow');

check('無附件 → allow',
  runGate({ tool_name: 'mcp__claude_ai_Gmail__create_draft', tool_input: { body: 'hi' } }), 'allow');

check('update_draft 26MB 也要擋',
  runGate({ tool_name: 'mcp__claude_ai_Gmail__update_draft', tool_input: { draftId: 'r1', attachments: [{ content: big }] } }), 'deny');

check('非 Gmail 寫入工具 → allow',
  runGate({ tool_name: 'mcp__claude_ai_Gmail__get_draft', tool_input: { attachments: [{ content: big }] } }), 'allow');

check('壞輸入（非 JSON）→ fail-open allow', runGate('not json'), 'allow');

console.log('');
console.log(`pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
