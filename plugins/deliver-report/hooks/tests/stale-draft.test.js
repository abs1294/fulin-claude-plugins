#!/usr/bin/env node
/**
 * stale-draft 閘的測試 — 改既有草稿前必須先讀回
 *
 * 由來：2026-10-20 實案。使用者在 Gmail 介面刪掉草稿裡的 repo 表格、改了小標，
 * 下一輪模型照自己上次送出的 htmlBody 重組再 update_draft，表格原樣寫回。
 *
 * 這組測試實跑兩支 hook 子程序（posttool 記帳／銷帳、PreToolUse 擋下），
 * 把 USERPROFILE／HOME 指到暫存目錄，狀態檔不碰真實家目錄：
 *   1. 沒寫過的草稿 → update_draft 放行（沒有「上一版」可覆蓋）
 *   2. create_draft／update_draft 成功後 → 下一次 update_draft 擋下
 *   3. get_draft 不帶 htmlBody（MINIMAL／PLAIN_TEXT）→ 仍擋
 *   4. get_draft 帶 htmlBody → 放行；放行後再寫一次 → 又要讀
 *   5. 寫入失敗（isError）不記帳；create_draft 永不被擋；壞輸入放行
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOOKS = path.join(__dirname, '..');
const PRE = path.join(HOOKS, 'gmail-draft-stale-gate.js');
const POST = path.join(HOOKS, 'gmail-draft-posttool-gate.js');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-stale-'));
const env = Object.assign({}, process.env, { USERPROFILE: home, HOME: home });

let pass = 0, fail = 0;
function check(desc, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log('  PASS  ' + desc); }
  else { fail++; console.log('  FAIL  ' + desc + '\n        got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want)); }
}

function run(script, input) {
  const r = spawnSync('node', [script], {
    input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', timeout: 10000, env,
  });
  if (r.error) throw r.error;
  return r.stdout || '';
}

function pre(draftId, tool) {
  const out = run(PRE, { tool_name: 'mcp__claude_ai_Gmail__' + (tool || 'update_draft'), tool_input: { draftId, htmlBody: '<div dir="ltr">x</div>' } });
  try {
    const o = JSON.parse(out);
    return (o.hookSpecificOutput && o.hookSpecificOutput.permissionDecision === 'deny') ? 'deny' : 'allow';
  } catch (_) { return 'allow'; }
}

function post(tool, toolInput, result, opts) {
  const tr = Object.assign({ type: 'text', text: JSON.stringify(result) }, (opts && opts.isError) ? { isError: true } : {});
  run(POST, { tool_name: 'mcp__claude_ai_Gmail__' + tool, tool_input: toolInput, tool_use_id: 'u' + Math.random(), tool_response: tr });
}

function stateHas(key) {
  try {
    const o = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'deliver-report', 'draft-link-gate', 'warned.json'), 'utf8'));
    return Array.isArray(o.warned) && o.warned.indexOf(key) !== -1;
  } catch (_) { return false; }
}

console.log('=== 沒寫過的草稿 ===');
check('沒有任何記號 → update_draft 放行', pre('r-unknown'), 'allow');
check('壞 JSON → 放行', (() => { const out = run(PRE, '{not json'); return out ? 'something' : 'allow'; })(), 'allow');
check('沒有 draftId → 放行', (() => {
  const out = run(PRE, { tool_name: 'mcp__claude_ai_Gmail__update_draft', tool_input: {} });
  return out ? 'something' : 'allow';
})(), 'allow');

console.log('=== 寫入後沒讀回 → 擋 ===');
post('create_draft', { subject: 'hi', htmlBody: '<div dir="ltr">v1</div>' }, { id: 'r1', messageId: 'm1', threadId: 't1' });
check('create_draft 成功後狀態檔記了 stale:r1', stateHas('stale:r1'), true);
check('接著 update_draft r1 → deny', pre('r1'), 'deny');
check('同時 create_draft 不被擋', pre('r1', 'create_draft'), 'allow');
check('別封草稿 r2 不受影響', pre('r2'), 'allow');

console.log('=== 讀回不帶 htmlBody 不算 ===');
post('get_draft', { draftId: 'r1', messageFormat: 'MINIMAL' }, { id: 'r1', subject: 'hi', snippet: 'v1' });
check('MINIMAL 讀回後仍 deny', pre('r1'), 'deny');
post('get_draft', { draftId: 'r1', messageFormat: 'PLAIN_TEXT' }, { id: 'r1', plaintextBody: 'v1' });
check('PLAIN_TEXT（只有 plaintextBody）讀回後仍 deny', pre('r1'), 'deny');

console.log('=== 讀回帶 htmlBody → 放行；再寫又要讀 ===');
post('get_draft', { draftId: 'r1', messageFormat: 'FULL_CONTENT' }, { id: 'r1', htmlBody: '<div dir="ltr">v1 使用者改過</div>', plaintextBody: 'v1' });
check('FULL_CONTENT 讀回後狀態檔已銷 stale:r1', stateHas('stale:r1'), false);
check('讀回後 update_draft r1 → allow', pre('r1'), 'allow');
post('update_draft', { draftId: 'r1', htmlBody: '<div dir="ltr">v2</div>' }, { id: 'r1', messageId: 'm2', threadId: 't1' });
check('update_draft 成功後再次記 stale:r1', stateHas('stale:r1'), true);
check('沒再讀回就第二次 update_draft → deny', pre('r1'), 'deny');

console.log('=== 寫入失敗不記帳 ===');
post('update_draft', { draftId: 'r3', htmlBody: '<div dir="ltr">x</div>' }, { error: 'quota exceeded' }, { isError: true });
check('isError 的 update_draft 不記 stale:r3', stateHas('stale:r3'), false);
check('r3 update_draft 放行', pre('r3'), 'allow');

console.log('=== 狀態檔壞掉 → 放行（fail-open） ===');
fs.writeFileSync(path.join(home, '.claude', 'deliver-report', 'draft-link-gate', 'warned.json'), '\uFEFF{broken', 'utf8');
check('狀態檔不是 JSON → update_draft r1 放行', pre('r1'), 'allow');

try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) { /* 暫存目錄留著也無妨 */ }

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
