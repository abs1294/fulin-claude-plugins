#!/usr/bin/env node
/**
 * daily-draft-gate（PreToolUse：Gmail 建立／更新草稿之前）的回歸測試
 * 守：日報草稿要過內容閘與易讀性閘才建立；非日報草稿不受影響；hook 讀不懂輸入時放行。
 */
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOOK = path.join(__dirname, '..', 'daily-draft-gate.js');
let pass = 0, fail = 0;
const check = (desc, cond, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + desc); }
  else { fail++; console.log('  ✗ ' + desc + (detail ? '：' + String(detail).slice(0, 300) : '')); }
};
const call = (toolInput, rawInput) => {
  const input = rawInput !== undefined ? rawInput : JSON.stringify({
    cwd: os.tmpdir(), tool_name: 'mcp__claude_ai_Gmail__create_draft', tool_input: toolInput,
  });
  const r = spawnSync('node', [HOOK], { input, encoding: 'utf8', timeout: 120000 });
  let decision = 'allow', reason = '';
  try { const o = JSON.parse(r.stdout); decision = o.hookSpecificOutput.permissionDecision; reason = o.hookSpecificOutput.permissionDecisionReason; } catch (_) { /* 空輸出＝放行 */ }
  return { decision, reason, code: r.status };
};

const SUBJ = '[工作日報] 2026-09-29 工作日報';
const clean = '# 工作日報 2026-09-29\n\n## 一、供應商平台\n\n- 完成國外廠商寫入規格整理\n\n## 二、內部工具\n\n- 更新交付文件檢查\n';

const fs = require('fs');
const leftovers = () => fs.readdirSync(os.tmpdir()).filter((n) => /^daily-draft-\d+-\d+\.md$/.test(n));
const before = leftovers().length;
let r = call({ subject: SUBJ, body: clean, to: ['x@example.com'] });
check('乾淨的日報草稿放行', r.decision === 'allow', r.reason);
check('放行後不留暫存檔（日報內文不殘留在暫存目錄）', leftovers().length === before, leftovers().join(','));

r = call({ subject: SUBJ, body: '# 工作日報\n\n- 用 Claude 完成規格整理\n' });
check('含 AI 工具名稱的日報草稿被拒', r.decision === 'deny' && /內容閘/.test(r.reason), r.reason);

r = call({ subject: SUBJ, body: '# 工作日報\n\n## 一、A\n\n- 本次查核完成\n\n## 三、B\n\n- 更新\n' });
check('易讀性缺陷（異動紀錄用語、章節跳號）的日報草稿被拒', r.decision === 'deny' && /易讀性/.test(r.reason), r.reason);
check('拒絕訊息裡不出現暫存檔路徑', !/daily-draft-\d+/.test(r.reason), r.reason);

r = call({ subject: SUBJ, htmlBody: '<b>工作日報</b><br><ul><li>用 Codex 完成審查</li></ul>' });
check('只有 htmlBody 的日報草稿也會檢查（去標籤後掃）', r.decision === 'deny', r.reason);

r = call({ subject: SUBJ, body: '   ' });
check('日報草稿沒有內文被拒', r.decision === 'deny', r.reason);

r = call({ subject: '交付：CASProject 報告', body: '附件是報告，本次查核的結果如下。' });
check('非日報草稿不受本閘影響（放行）', r.decision === 'allow', r.reason);

r = call(null, '這不是 JSON');
check('hook 讀不懂輸入時放行（不卡住 Gmail 工具）', r.decision === 'allow' && r.code === 0);

// ---- C 軌審查第一輪：update_draft 沒帶主旨、body 與 htmlBody 並存 ----
const callAs = (toolName, toolInput, transcript) => {
  let tp;
  if (transcript) {
    tp = path.join(os.tmpdir(), `ddg-tr-${process.pid}.jsonl`);
    fs.writeFileSync(tp, transcript.map((o) => JSON.stringify(o)).join('\n') + '\n');
  }
  const input = JSON.stringify({ cwd: os.tmpdir(), tool_name: toolName, tool_input: toolInput, transcript_path: tp });
  const out = spawnSync('node', [HOOK], { input, encoding: 'utf8', timeout: 120000 });
  if (tp) fs.unlinkSync(tp);
  try { const o = JSON.parse(out.stdout); return o.hookSpecificOutput.permissionDecision; } catch (_) { return 'allow'; }
};
const UPD = 'mcp__claude_ai_Gmail__update_draft';
const created = [
  { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'c1', name: 'mcp__claude_ai_Gmail__create_draft', input: { subject: SUBJ, body: clean } }] } },
  { type: 'user', promptId: 'p1', toolUseResult: {}, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: '{"id":"r-123","threadId":"t-9"}' }] } },
];
const badBody = '# 週報\n\n- 用 Claude 完成規格整理\n';
check('update_draft 沒帶主旨：從 transcript 找回原主旨（工作日報）→ 照樣檢查並擋', callAs(UPD, { draftId: 'r-123', body: badBody }, created) === 'deny');
check('update_draft 沒帶主旨、transcript 找不到，但內文有「工作日報」→ 檢查並擋', callAs(UPD, { draftId: 'r-999', body: '# 工作日報\n\n- 用 Claude 完成\n' }) === 'deny');
check('update_draft 只改收件人、沒帶內文 → 放行（內文沿用，建立時已檢查）', callAs(UPD, { draftId: 'r-123', to: ['y@example.com'] }, created) === 'allow');
check('update_draft 不是日報草稿（transcript 主旨不是工作日報）→ 放行', callAs(UPD, { draftId: 'r-777', body: badBody }, [
  { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'c2', name: 'mcp__claude_ai_Gmail__create_draft', input: { subject: '交付：報告', body: 'x' } }] } },
  { type: 'user', promptId: 'p1', toolUseResult: {}, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c2', content: '{"id":"r-777"}' }] } },
]) === 'allow');
check('update_draft 沒帶主旨、找不到原主旨、內文也看不出是日報 → 擋（請帶主旨再更新）', callAs(UPD, { draftId: 'r-555', body: '只改一段內文' }) === 'deny');
check('update_draft 沒帶主旨但帶了內文、找不到原主旨時，帶上非日報主旨就放行', callAs(UPD, { draftId: 'r-555', subject: '交付：報告', body: '只改一段內文' }) === 'allow');
check('body 乾淨但 htmlBody 有 AI 名稱 → 擋（兩份都掃）', callAs('mcp__claude_ai_Gmail__create_draft', { subject: SUBJ, body: clean, htmlBody: '<p>用 Codex 完成審查</p>' }) === 'deny');

console.log(`\n${pass} 過、${fail} 失敗`);
process.exit(fail ? 1 : 0);
