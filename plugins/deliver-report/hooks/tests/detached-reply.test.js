#!/usr/bin/env node
/**
 * detachedReplyDrafts 的測試 — 掉串偵測的第二判準
 *
 * 由來：2026-09-17 實案。最終草稿 r748399319062911997 回傳
 *   {"messageId":"1a0afc52a3cf3145","threadId":"1a0afc52a3cf3145"}
 * 主旨是「Re: …」，卻自成一串。原本的 detachedThreads 因為
 * `hist.length < 2` 而靜默放行——單次觀測是它的結構性盲區。
 *
 * 這組測試同時守住兩件事：
 *   1. 真的掉串要抓到（單次觀測也要抓）
 *   2. 「本來就是新信」不可誤報——誤報會訓練使用者忽略警告
 */

const path = require('path');
const C = require(path.join(__dirname, '..', 'lib', 'draft-checks.core.js'));

let pass = 0, fail = 0;

function mkTurn(calls) {
  const uses = [], results = new Map();
  calls.forEach((c, i) => {
    const id = 't' + i;
    uses.push({ id, name: 'mcp__claude_ai_Gmail__' + (c.tool || 'create_draft'), input: c.input || {} });
    results.set(id, { content: JSON.stringify(c.result) });
  });
  return { pid: 'x', uses, results };
}

function check(desc, calls, expectIds) {
  const got = C.detachedReplyDrafts(mkTurn(calls)).map((x) => x.id).sort();
  const want = expectIds.slice().sort();
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log('  PASS  ' + desc); }
  else { fail++; console.log('  FAIL  ' + desc + '\n        got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want)); }
}

console.log('=== detachedReplyDrafts ===');

// ── 真陽性 ──
check('實案：Re: 主旨但 threadId===messageId', [
  { input: { subject: 'Re: 汎銓基準測 HTTPS 導入 — 驗收第一階段' },
    result: { id: 'r748399319062911997', messageId: '1a0afc52a3cf3145', threadId: '1a0afc52a3cf3145' } },
], ['r748399319062911997']);

check('RE: 大寫也要抓', [
  { input: { subject: 'RE: something' },
    result: { id: 'rA', messageId: 'm1', threadId: 'm1' } },
], ['rA']);

check('中文「回覆」開頭也要抓', [
  { input: { subject: '回覆：您的詢問' },
    result: { id: 'rB', messageId: 'm2', threadId: 'm2' } },
], ['rB']);

check('帶 replyToMessageId 卻自成一串', [
  { input: { subject: '無 Re 前綴', replyToMessageId: 'msgOrig' },
    result: { id: 'rC', messageId: 'm3', threadId: 'm3' } },
], ['rC']);

check('input 帶 threadId 卻自成一串', [
  { input: { subject: '無 Re 前綴', threadId: 'thrOrig' },
    result: { id: 'rD', messageId: 'm4', threadId: 'm4' } },
], ['rD']);

// ── 真陰性（誤報防線）──
check('本來就是新信：無 Re、自成一串 → 不報', [
  { input: { subject: '新專案啟動通知' },
    result: { id: 'rNew', messageId: 'm5', threadId: 'm5' } },
], []);

check('Re: 且正確掛在原串 → 不報', [
  { input: { subject: 'Re: 原討論' },
    result: { id: 'rOk', messageId: 'm6', threadId: 'thrOriginal' } },
], []);

check('有兩次觀測 → 交給 detachedThreads，不重複報', [
  { input: { subject: 'Re: x' }, result: { id: 'rDup', messageId: 'm7', threadId: 'thrO' } },
  { tool: 'update_draft', input: { subject: 'Re: x' },
    result: { id: 'rDup', messageId: 'm8', threadId: 'm8' } },
], []);

check('回傳非 JSON → 判不出，放行', [
  { input: { subject: 'Re: x' }, result: 'not json' },
], []);

check('缺 threadId 欄位 → 放行', [
  { input: { subject: 'Re: x' }, result: { id: 'rE', messageId: 'm9' } },
], []);

check('Resume/Result 等非 Re 字樣不可誤判為回覆', [
  { input: { subject: 'Resume for review' },
    result: { id: 'rF', messageId: 'mA', threadId: 'mA' } },
], []);

check('多封混合：只報真的掉串那封', [
  { input: { subject: 'Re: 甲' }, result: { id: 'rBad', messageId: 'mB', threadId: 'mB' } },
  { input: { subject: '新信乙' }, result: { id: 'rNew2', messageId: 'mC', threadId: 'mC' } },
  { input: { subject: 'Re: 丙' }, result: { id: 'rGood', messageId: 'mD', threadId: 'thrX' } },
], ['rBad']);

// ── detachedThreads 仍要正常（沒被改壞）──
// ── 回傳缺 messageId（2026-09-18 審查抓到的盲區）──
// create_draft / update_draft 的官方 schema 只保證回 id 與 threadId；
// messageId 只有部分實作才有。原本硬性要求它存在，缺了就整支判準靜默回 []
// ——而那正是本判準要抓的情境，等於主打功能在半數實作上沉默。
check('缺 messageId：threadId === id 且自稱 Re: → 要抓到', [
  { input: { subject: 'Re: 測試報告' },
    result: { id: 'd-nomsg-1', threadId: 'd-nomsg-1' } },
], ['d-nomsg-1']);

check('缺 messageId：帶 replyToMessageId 卻自成一串 → 要抓到', [
  { input: { replyToMessageId: 'm-orig' },
    result: { id: 'd-nomsg-2', threadId: 'd-nomsg-2' } },
], ['d-nomsg-2']);

check('缺 messageId：有掛在原串上 → 不可誤報', [
  { input: { subject: 'Re: 測試報告' },
    result: { id: 'd-nomsg-3', threadId: 't-original' } },
], []);

check('缺 messageId：本來就是新信 → 不可誤報', [
  { input: { subject: '專案進度說明' },
    result: { id: 'd-nomsg-4', threadId: 'd-nomsg-4' } },
], []);

check('messageId 有回時仍以 messageId 為準（不被 id 蓋過）', [
  // id 與 threadId 不同、但 messageId === threadId → 仍是自成一串
  { input: { subject: 'Re: 測試報告' },
    result: { id: 'd-mix', messageId: 'mm-1', threadId: 'mm-1' } },
], ['d-mix']);

check('缺 threadId 欄位 → 判不出，放行', [
  { input: { subject: 'Re: 測試報告' },
    result: { id: 'd-nothread' } },
], []);

console.log('=== detachedThreads 回歸 ===');
function checkOld(desc, calls, expect) {
  const got = C.detachedThreads(mkTurn(calls)).sort();
  const ok = JSON.stringify(got) === JSON.stringify(expect.slice().sort());
  if (ok) { pass++; console.log('  PASS  ' + desc); }
  else { fail++; console.log('  FAIL  ' + desc + '\n        got=' + JSON.stringify(got) + ' want=' + JSON.stringify(expect)); }
}
checkOld('掛串後脫離 → 抓到', [
  { input: {}, result: { id: 'rX', messageId: 'm1', threadId: 'thrO' } },
  { tool: 'update_draft', input: {}, result: { id: 'rX', messageId: 'm2', threadId: 'm2' } },
], ['rX']);
checkOld('全程掛同一串 → 不報', [
  { input: {}, result: { id: 'rY', messageId: 'm1', threadId: 'thrO' } },
  { tool: 'update_draft', input: {}, result: { id: 'rY', messageId: 'm2', threadId: 'thrO' } },
], []);

console.log(`\n  → ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
