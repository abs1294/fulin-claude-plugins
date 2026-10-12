#!/usr/bin/env node
/**
 * upload-count-gate 端到端測試 —— 跑法：node hooks/tests/upload-count.test.js
 *
 * 用與真實 transcript 同形狀的行（assistant tool_use {type,id,name,input}、
 * user tool_result {type,tool_use_id,is_error,content}、使用者輸入行帶 promptId）
 * 造出 transcript，實際以子程序執行 hook，看 stdout 是 block／提醒／放行。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const GATE = path.join(__dirname, '..', 'upload-count-gate.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-count-'));

let pass = 0, fail = 0, n = 0;
const LIST3 = '<div dir="ltr">附件 3 份：<br><ol><li>a.docx — 報告</li><li>b.xlsx — 時程</li><li>c.zip — 原始資料</li></ol></div>';

const prompt = (text) => ({ type: 'user', promptId: 'p' + (++n), message: { role: 'user', content: text } });
const call = (id, name, input) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
const result = (id, isErr) => ({ type: 'user', toolUseResult: {}, message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: !!isErr, content: isErr ? 'Error' : 'ok' }] } });
const say = (text) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const draft = (id, input) => [call(id, 'mcp__claude_ai_Gmail__create_draft', input), result(id)];
const up = (id, paths, name, isErr) => [call(id, name || 'mcp__claude-in-chrome__file_upload', { paths, ref: 'ref_1', tabId: 1 }), result(id, isErr)];

function run(lines, extra) {
  const f = path.join(TMP, 't' + (++n) + '.jsonl');
  fs.writeFileSync(f, lines.map((o) => JSON.stringify(o)).join('\n') + '\n');
  const p = spawnSync(process.execPath, [GATE], { input: JSON.stringify(Object.assign({ transcript_path: f }, extra || {})), encoding: 'utf8' });
  let o = null; try { o = JSON.parse(p.stdout); } catch (_) {}
  return { code: p.status, o, out: p.stdout };
}
function t(label, lines, want, mustContain, extra) {
  const r = run(lines, extra);
  const got = !r.o ? 'allow' : r.o.decision === 'block' ? 'block' : r.o.systemMessage ? 'remind' : 'other';
  const text = r.o ? (r.o.reason || r.o.systemMessage || '') : '';
  const ok = r.code === 0 && got === want && (!mustContain || text.indexOf(mustContain) !== -1);
  ok ? pass++ : fail++;
  console.log('  ' + (ok ? 'PASS' : '** FAIL **').padEnd(12) + label + (ok ? '' : '  → ' + got + ' ' + r.out));
  return text;
}
const U = 'C:\\out\\';

console.log('=== 應擋 ===');
const reason = t('實案：清單 3 個，瀏覽器只傳 2 個', [
  prompt('寫回信'), ...draft('d1', { htmlBody: LIST3 }),
  prompt('附檔'), ...up('u1', [U + 'a.docx', U + 'b.xlsx']), say('附好了'),
], 'block', '清單列了 3 個檔，實際上傳了 2 個');
t('分兩次上傳，合計仍少一個', [
  prompt('x'), ...draft('d1', { htmlBody: LIST3 }), ...up('u1', [U + 'a.docx']), ...up('u2', [U + 'b.xlsx']),
], 'block', '「c.zip」');
t('上傳失敗的不算（第三個傳失敗）', [
  prompt('x'), ...draft('d1', { htmlBody: LIST3 }), ...up('u1', [U + 'a.docx', U + 'b.xlsx']), ...up('u2', [U + 'c.zip'], null, true),
], 'block', '實際上傳了 2 個');
t('傳錯檔（個數對、檔名不對）', [
  prompt('x'), ...draft('d1', { htmlBody: LIST3 }), ...up('u1', [U + 'a.docx', U + 'b.xlsx', U + 'old.zip']),
], 'block', '「c.zip」');
t('Playwright 的 browser_file_upload 也算', [
  prompt('x'), ...draft('d1', { htmlBody: LIST3 }), ...up('u1', [U + 'a.docx'], 'mcp__playwright__browser_file_upload'),
], 'block', '實際上傳了 1 個');
t('上傳完又 update_draft 不帶 attachments → 附件被清掉', [
  prompt('x'), ...draft('d1', { htmlBody: LIST3 }), ...up('u1', [U + 'a.docx', U + 'b.xlsx', U + 'c.zip']),
  call('d2', 'mcp__claude_ai_Gmail__update_draft', { draftId: 'r1', subject: '改主旨' }), result('d2'),
], 'block', '整批清掉');
t('第二次 Stop 仍不符 → 改提醒放行', [
  prompt('x'), ...draft('d1', { htmlBody: LIST3 }), ...up('u1', [U + 'a.docx']),
], 'remind', '已擋過一次', { stop_hook_active: true });

console.log('=== 應放行 ===');
t('3 個都傳了（含重傳同一檔去重）', [
  prompt('x'), ...draft('d1', { htmlBody: LIST3 }), ...up('u1', [U + 'a.docx', U + 'b.xlsx']), ...up('u2', [U + 'b.xlsx', U + 'c.zip']),
], 'allow');
t('上傳在前一回合、本回合沒上傳 → 不出聲', [
  prompt('x'), ...draft('d1', { htmlBody: LIST3 }), ...up('u1', [U + 'a.docx']), prompt('別的事'), say('好'),
], 'allow');
t('草稿走 API attachments（PreToolUse 管）', [
  prompt('x'), ...draft('d1', { htmlBody: LIST3, attachments: [{ filename: 'a.docx', content: 'A' }] }), ...up('u1', [U + 'z.png']),
], 'allow');
t('草稿沒有附件清單（上傳的是別的網站）', [
  prompt('x'), ...draft('d1', { htmlBody: '<div dir="ltr">Hi</div>' }), ...up('u1', [U + 'z.png']),
], 'allow');
t('沒有任何草稿寫入', [prompt('x'), ...up('u1', [U + 'z.png'])], 'allow');
t('<a href> 那項是雲端連結，不必上傳', [
  prompt('x'), ...draft('d1', { htmlBody: '<div dir="ltr">附件 3 份：<ol><li>a.docx</li><li>b.xlsx</li><li><a href="https://drive.google.com/x">影片</a></li></ol></div>' }),
  ...up('u1', [U + 'a.docx', U + 'b.xlsx']),
], 'allow');
t('上傳前的 update_draft 不算清掉', [
  prompt('x'), ...draft('d1', { htmlBody: LIST3 }), call('d2', 'mcp__claude_ai_Gmail__update_draft', { draftId: 'r1', subject: 's' }), result('d2'),
  ...up('u1', [U + 'a.docx', U + 'b.xlsx', U + 'c.zip']),
], 'allow');
t('子代理（sidechain）的呼叫不看', [
  prompt('x'), ...draft('d1', { htmlBody: LIST3 }),
  Object.assign(call('u1', 'mcp__claude-in-chrome__file_upload', { paths: [U + 'a.docx'] }), { isSidechain: true }),
], 'allow');

console.log('=== fail-open ===');
{
  const p = spawnSync(process.execPath, [GATE], { input: 'not json', encoding: 'utf8' });
  const ok = p.status === 0 && !p.stdout; ok ? pass++ : fail++;
  console.log('  ' + (ok ? 'PASS' : '** FAIL **').padEnd(12) + '壞 stdin → 放行');
  const q = spawnSync(process.execPath, [GATE], { input: JSON.stringify({ transcript_path: path.join(TMP, 'nope.jsonl') }), encoding: 'utf8' });
  const ok2 = q.status === 0 && !q.stdout; ok2 ? pass++ : fail++;
  console.log('  ' + (ok2 ? 'PASS' : '** FAIL **').padEnd(12) + 'transcript 不存在 → 放行');
}
console.log('\n--- block 理由全文 ---\n' + reason + '\n');
fs.rmSync(TMP, { recursive: true, force: true });
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
