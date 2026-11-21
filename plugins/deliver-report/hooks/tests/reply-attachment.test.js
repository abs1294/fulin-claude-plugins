#!/usr/bin/env node
/**
 * reply-attachment.test — 回覆草稿的原信附件殘留判準（2026-11-20 實案）
 *
 * 背景：用 replyToMessageId 掛原信串時，Gmail 伺服器端把原信附件整批複製進草稿。
 * 那些檔不在 create_draft 的 attachments 裡，PreToolUse 看不到；
 * 而 create_draft／get_draft 的回傳一律不含附件欄位（三種 messageFormat 實測皆然），
 * 所以 API 也驗不到——只有開瀏覽器看才算數。
 */
const assert = require('assert');
const path = require('path');
const C = require(path.join(__dirname, '..', 'lib', 'draft-checks.core.js'));
const G = require(path.join(__dirname, '..', 'upload-count-gate.js'));

const ok = () => true;
let n = 0;
// 輸出走 stdout.write：git-commit 的敏感字閘把主控台 log 呼叫當 debug 殘留擋下
const say = (m) => process.stdout.write(m + '\n');
function t(name, fn) { fn(); n++; say('  ok ' + name); }

say('replyDraftsNeedingCleanup');

t('回覆草稿未查看 → 回報', () => {
  const ev = [{ kind: 'write', idx: 5, id: 'a', input: { replyToMessageId: 'm1' }, draft: 'r-123', isUpdate: false }];
  const r = C.replyDraftsNeedingCleanup(ev, ok, 1);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].draft, 'r-123');
  assert.strictEqual(r[0].replyTo, 'm1');
});

t('建立後有導覽到該草稿 → 放行', () => {
  const ev = [
    { kind: 'write', idx: 5, id: 'a', input: { replyToMessageId: 'm1' }, draft: 'r-123', isUpdate: false },
    { kind: 'nav', idx: 7, id: 'b', input: {}, draft: 'r-123' },
  ];
  assert.strictEqual(C.replyDraftsNeedingCleanup(ev, ok, 1).length, 0);
});

t('導覽到別封草稿 → 仍回報', () => {
  const ev = [
    { kind: 'write', idx: 5, id: 'a', input: { replyToMessageId: 'm1' }, draft: 'r-123', isUpdate: false },
    { kind: 'nav', idx: 7, id: 'b', input: {}, draft: 'r-999' },
  ];
  assert.strictEqual(C.replyDraftsNeedingCleanup(ev, ok, 1).length, 1);
});

t('導覽發生在建立之前 → 不算（那是看別的狀態）', () => {
  const ev = [
    { kind: 'nav', idx: 3, id: 'b', input: {}, draft: 'r-123' },
    { kind: 'write', idx: 5, id: 'a', input: { replyToMessageId: 'm1' }, draft: 'r-123', isUpdate: false },
  ];
  assert.strictEqual(C.replyDraftsNeedingCleanup(ev, ok, 1).length, 1);
});

t('非回覆草稿（沒有 replyToMessageId）→ 不管', () => {
  const ev = [{ kind: 'write', idx: 5, id: 'a', input: {}, draft: 'r-1', isUpdate: false }];
  assert.strictEqual(C.replyDraftsNeedingCleanup(ev, ok, 1).length, 0);
});

t('update_draft 不觸發（伺服器端複製只發生在 create）', () => {
  const ev = [{ kind: 'write', idx: 5, id: 'a', input: { replyToMessageId: 'm1' }, draft: 'r-1', isUpdate: true }];
  assert.strictEqual(C.replyDraftsNeedingCleanup(ev, ok, 1).length, 0);
});

t('上一回合建的（idx <= start）→ 不管', () => {
  const ev = [{ kind: 'write', idx: 0, id: 'a', input: { replyToMessageId: 'm1' }, draft: 'r-1', isUpdate: false }];
  assert.strictEqual(C.replyDraftsNeedingCleanup(ev, ok, 1).length, 0);
});

t('呼叫失敗的 create_draft → 不管', () => {
  const ev = [{ kind: 'write', idx: 5, id: 'bad', input: { replyToMessageId: 'm1' }, draft: 'r-1', isUpdate: false }];
  const notOk = (e) => e.id !== 'bad';
  assert.strictEqual(C.replyDraftsNeedingCleanup(ev, notOk, 1).length, 0);
});

t('抽不到草稿 id → fail-open', () => {
  const ev = [{ kind: 'write', idx: 5, id: 'a', input: { replyToMessageId: 'm1' }, draft: '', isUpdate: false }];
  assert.strictEqual(C.replyDraftsNeedingCleanup(ev, ok, 1).length, 0);
});

t('同一封建兩次只報一次', () => {
  const ev = [
    { kind: 'write', idx: 5, id: 'a', input: { replyToMessageId: 'm1' }, draft: 'r-1', isUpdate: false },
    { kind: 'write', idx: 6, id: 'b', input: { replyToMessageId: 'm1' }, draft: 'r-1', isUpdate: false },
  ];
  assert.strictEqual(C.replyDraftsNeedingCleanup(ev, ok, 1).length, 1);
});

t('非陣列輸入 → fail-open', () => {
  assert.deepStrictEqual(C.replyDraftsNeedingCleanup(null, ok, 1), []);
  assert.deepStrictEqual(C.replyDraftsNeedingCleanup(undefined, ok, 0), []);
});

say('\nevaluate 整合（透過 transcript 行）');

let pn = 0;
function line(obj) { return JSON.stringify(obj); }
function userLine() { return line({ type: 'user', promptId: 'p' + (++pn), message: { role: 'user', content: '做事' } }); }
function useLine(id, name, input) {
  return line({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
}
function resLine(id, text) {
  return line({ type: 'user', toolUseResult: {}, message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: false, content: text }] } });
}

t('回覆草稿未查看 → evaluate 帶出 replyDrafts', () => {
  const lines = [
    userLine(),
    useLine('u1', 'mcp__claude_ai_Gmail__create_draft', { replyToMessageId: 'm1', htmlBody: '<div>x</div>' }),
    resLine('u1', '{"id":"r-55","messageId":"abc123","threadId":"t1"}'),
  ];
  const r = G.evaluate(lines);
  assert.ok(r, 'evaluate 應回傳結果');
  assert.ok(Array.isArray(r.replyDrafts) && r.replyDrafts.length === 1, 'replyDrafts 應有一筆');
  assert.strictEqual(r.replyDrafts[0].draft, 'r-55');
});

t('回覆草稿已查看 → evaluate 不報', () => {
  const lines = [
    userLine(),
    useLine('u1', 'mcp__claude_ai_Gmail__create_draft', { replyToMessageId: 'm1', htmlBody: '<div>x</div>' }),
    resLine('u1', '{"id":"r-55","messageId":"abc123","threadId":"t1"}'),
    useLine('u2', 'mcp__playwright__browser_navigate', { url: 'https://mail.google.com/mail/?authuser=x#all?compose=thread-f:1%2Bmsg-a:r-55' }),
    resLine('u2', 'ok'),
  ];
  const r = G.evaluate(lines);
  assert.ok(!r || !r.replyDrafts || !r.replyDrafts.length, '查看過就不該報');
});

t('一般草稿（非回覆）→ evaluate 回 null', () => {
  const lines = [
    userLine(),
    useLine('u1', 'mcp__claude_ai_Gmail__create_draft', { htmlBody: '<div>x</div>' }),
    resLine('u1', '{"id":"r-77","messageId":"abc","threadId":"t"}'),
  ];
  assert.strictEqual(G.evaluate(lines), null);
});

say('\n' + n + ' tests passed');
