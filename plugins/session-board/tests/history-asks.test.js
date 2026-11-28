'use strict';
// lib/history.js: Claude's questions as they are drawn from a transcript - one that never reached you is not drawn.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const H = require('../lib/history');

const L = (o) => JSON.stringify(o);
const Q = (q) => ({ questions: [{ question: q, header: '保留', options: [{ label: '甲', description: '' }, { label: '乙', description: '' }], multiSelect: false }] });
const ask = (n, id, q) => L({ type: 'assistant', uuid: 'a' + n, message: { content: [{ type: 'tool_use', id, name: 'AskUserQuestion', input: Q(q) }] } });
const result = (n, id, content, isError) => L({ type: 'user', uuid: 'u' + n, message: { role: 'user', content: [Object.assign({ type: 'tool_result', tool_use_id: id, content }, isError ? { is_error: true } : {})] } });

test('a question stopped before it was shown (a hook, input not taken) is not drawn; one you saw - declined, answered, or with a hook failing after - is', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-asks-')), f = path.join(d, 't.jsonl');
  fs.writeFileSync(f, [
    // stopped by a hook (seen 2026-11-28: [提問自省] wants a recommended option), then asked again
    ask(1, 'h1', '哪兩個 session？'),
    result(1, 'h1', 'PreToolUse:AskUserQuestion hook error: [提問自省] 每題必須附建議答案', true),
    ask(2, 'h2', '哪兩個 session？（推薦第一個）'),
    result(2, 'h2', 'User has answered your questions: "哪兩個 session？（推薦第一個）"="甲"'),
    // input Claude Code did not take
    ask(3, 'v1', '格式不對的'),
    result(3, 'v1', '<tool_use_error>InputValidationError: questions is too long</tool_use_error>', true),
    // seen and declined on the board: drawn (you saw it)
    ask(4, 'n1', '你看過但不回答的'),
    result(4, 'n1', '使用者在看板上選擇不回答這些問題。', true),
    // a hook that ran after it was shown: you saw it - drawn
    ask(5, 'p1', '看過之後才有 hook 報錯的'),
    result(5, 'p1', 'PostToolUse:AskUserQuestion hook error: 記錄失敗', true),
    // the refusal as a list of text blocks: stopped all the same
    ask(6, 'h3', '陣列形式被擋下的'),
    result(6, 'h3', [{ type: 'text', text: 'PreToolUse:AskUserQuestion hook error: [提問自省]' }], true),
  ].join('\n'));
  try {
    const asks = H.readHistory(f, { max: 100 }).items.filter((x) => x.role === 'ask').map((x) => x.questions[0].question);
    assert.deepStrictEqual(asks, ['哪兩個 session？（推薦第一個）', '你看過但不回答的', '看過之後才有 hook 報錯的']);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('a question still waiting for you (no result yet) is drawn', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-asks-')), f = path.join(d, 't.jsonl');
  fs.writeFileSync(f, ask(1, 'w1', '還在等你回答的'));
  try { assert.strictEqual(H.readHistory(f, { max: 100 }).items.filter((x) => x.role === 'ask').length, 1); } finally { fs.rmSync(d, { recursive: true, force: true }); }
});
