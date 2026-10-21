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

// 跨回合清附件（2026-10-21 審查重現：上傳在前一回合、改內文在下一回合，舊版完全不檢查）
const created = (id, draftId, input, asString) => [call(id, 'mcp__claude_ai_Gmail__create_draft', input),
  { type: 'user', toolUseResult: {}, message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: false,
    content: asString ? JSON.stringify({ id: draftId, threadId: 't' }) : [{ type: 'text', text: JSON.stringify({ id: draftId, threadId: 't' }) }] }] } }];
const upd = (id, input) => [call(id, 'mcp__claude_ai_Gmail__update_draft', input), result(id)];
// 瀏覽器打開草稿：參數帶 viewUrl（真實形狀：…compose=thread-f:…%2Bmsg-a:<草稿 id>）
const nav = (id, draftId, name) => [call(id, name || 'mcp__claude-in-chrome__navigate',
  { url: 'https://mail.google.com/mail/?authuser=x#all?compose=thread-f:18796%2Bmsg-a:' + draftId, tabId: 1 }), result(id)];
const upTo = (id, draftId, paths) => [...nav('n' + id, draftId), ...up(id, paths)];
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
t('上傳完又 update_draft 不帶 attachments → 附件被清掉（create 回傳帶真實 id，update 指同一封）', [
  prompt('x'), ...created('d1', 'r-1879000000000000022', { htmlBody: LIST3 }), ...up('u1', [U + 'a.docx', U + 'b.xlsx', U + 'c.zip']),
  call('d2', 'mcp__claude_ai_Gmail__update_draft', { draftId: 'r-1879000000000000022', subject: '改主旨' }), result('d2'),
], 'block', '整批清掉');
const ALL3 = [U + 'a.docx', U + 'b.xlsx', U + 'c.zip'];
t('跨回合：前一回合上傳完，這回合 update_draft 改內文、沒重傳 → 擋', [
  prompt('寫信'), ...created('c1', 'r-1879000000000000000', { htmlBody: LIST3, includeSignature: true }), ...upTo('u1', 'r-1879000000000000000', ALL3),
  prompt('第二段改一下'), ...upd('d2', { draftId: 'r-1879000000000000000', htmlBody: LIST3 + '<br>改過' }), say('改好了'),
], 'block', '先前用瀏覽器上傳過附件');
t('跨回合：只改主旨也會清附件 → 擋', [
  prompt('寫信'), ...created('c1', 'r2215269328682791539', { htmlBody: LIST3 }, true), ...upTo('u1', 'r2215269328682791539', ALL3),
  prompt('改主旨'), ...upd('d2', { draftId: 'r2215269328682791539', subject: '新主旨' }),
], 'block', 'r2215269328682791539');
t('跨回合：Playwright 開草稿網址也認得', [
  prompt('寫信'), ...created('c1', 'r-1879000000000000002', { htmlBody: LIST3 }), ...nav('n1', 'r-1879000000000000002', 'mcp__playwright__browser_navigate'), ...up('u1', ALL3),
  prompt('改'), ...upd('d2', { draftId: 'r-1879000000000000002', htmlBody: LIST3 }),
], 'block', 'r-1879000000000000002');
t('跨回合：第二次 Stop 仍沒重傳 → 改提醒放行', [
  prompt('寫信'), ...created('c1', 'r-1879000000000000001', { htmlBody: LIST3 }), ...upTo('u1', 'r-1879000000000000001', ALL3),
  prompt('改'), ...upd('d2', { draftId: 'r-1879000000000000001', htmlBody: LIST3 }),
], 'remind', '已擋過一次', { stop_hook_active: true });
// 多封草稿交錯（2026-10-21 審查實測：舊判準「上傳前最近一次寫入」會擋錯、漏抓、誤認重傳）
t('多封：建 A、建 B、傳給 A；下一回合改 A 沒重傳 → 擋（舊判準漏抓）', [
  prompt('寫兩封'), ...created('c1', 'r-1879000000000000007', { htmlBody: LIST3 }), ...created('c2', 'r-1879000000000000009', { htmlBody: '<div dir="ltr">B</div>' }),
  ...upTo('u1', 'r-1879000000000000007', ALL3),
  prompt('改 A'), ...upd('d2', { draftId: 'r-1879000000000000007', htmlBody: LIST3 + '<br>改過' }),
], 'block', 'r-1879000000000000007');
t('多封：改了 A 沒重傳，接著把附件傳給 C → 仍擋 A（舊判準誤認為重傳）', [
  prompt('寫'), ...created('c1', 'r-1879000000000000008', { htmlBody: LIST3 }), ...upTo('u1', 'r-1879000000000000008', ALL3),
  prompt('改 A、另建 C'), ...upd('d2', { draftId: 'r-1879000000000000008', htmlBody: LIST3 }),
  ...created('c3', 'r-1879000000000000010', { htmlBody: LIST3 }), ...upTo('u3', 'r-1879000000000000010', ALL3),
], 'block', 'r-1879000000000000008');
t('第二次 Stop 仍不符 → 改提醒放行', [
  prompt('x'), ...draft('d1', { htmlBody: LIST3 }), ...up('u1', [U + 'a.docx']),
], 'remind', '已擋過一次', { stop_hook_active: true });

console.log('=== 應放行 ===');
t('跨回合：改內文後同回合開回同一封重傳 3 個 → 放行', [
  prompt('寫信'), ...created('c1', 'r-1879000000000000003', { htmlBody: LIST3 }), ...upTo('u1', 'r-1879000000000000003', ALL3),
  prompt('改'), ...upd('d2', { draftId: 'r-1879000000000000003', htmlBody: LIST3 + '<br>改過' }), ...upTo('u2', 'r-1879000000000000003', ALL3), say('改好並重傳'),
], 'allow');
t('跨回合：改的是另一封沒上傳過附件的草稿 → 不出聲', [
  prompt('寫信'), ...created('c1', 'r-1879000000000000004', { htmlBody: LIST3 }), ...upTo('u1', 'r-1879000000000000004', ALL3),
  ...created('c2', 'r-1879000000000000014', { htmlBody: '<div dir="ltr">別封</div>' }),
  prompt('改別封'), ...upd('d2', { draftId: 'r-1879000000000000014', htmlBody: '<div dir="ltr">別封改過</div>' }),
], 'allow');
t('多封：建 A、建 B、傳給 A；下一回合只改 B → 不擋（舊判準擋錯對象）', [
  prompt('寫兩封'), ...created('c1', 'r-1879000000000000011', { htmlBody: LIST3 }), ...created('c2', 'r-1879000000000000012', { htmlBody: '<div dir="ltr">B</div>' }),
  ...upTo('u1', 'r-1879000000000000011', ALL3),
  prompt('改 B'), ...upd('d2', { draftId: 'r-1879000000000000012', htmlBody: '<div dir="ltr">B 改過</div>' }),
], 'allow');
t('上傳前沒開草稿網址、session 寫過兩封（判斷不出是哪封）→ 不歸屬、不擋', [
  prompt('寫信'), ...created('c1', 'r-1879000000000000013', { htmlBody: LIST3 }),
  ...created('c2', 'r-1879000000000000015', { htmlBody: '<div dir="ltr">另一封</div>' }), ...up('u1', ALL3),
  prompt('改'), ...upd('d2', { draftId: 'r-1879000000000000013', htmlBody: LIST3 }),
], 'allow');
t('從草稿匣列表點進去上傳（導覽到非草稿頁會清掉歸屬）→ 不算傳給先前開過的那封', [
  prompt('寫兩封'), ...created('c1', 'r-1879000000000000016', { htmlBody: LIST3 }),
  ...created('c2', 'r-1879000000000000017', { htmlBody: LIST3 }),
  ...nav('n1', 'r-1879000000000000017'),
  call('n2', 'mcp__claude-in-chrome__navigate', { url: 'https://mail.google.com/mail/#drafts', tabId: 1 }), result('n2'),
  ...up('u1', ALL3),
  prompt('改 B'), ...upd('d2', { draftId: 'r-1879000000000000017', htmlBody: LIST3 }),
], 'allow');
t('草稿網址出現在非導覽工具（例如寫檔）→ 不算打開那封', [
  prompt('寫兩封'), ...created('c1', 'r-1879000000000000018', { htmlBody: LIST3 }),
  ...created('c2', 'r-1879000000000000019', { htmlBody: '<div dir="ltr">B</div>' }),
  ...nav('n1', 'r-1879000000000000018'),
  call('w1', 'Write', { file_path: 'x.md', content: 'https://mail.google.com/#all?compose=x%2Bmsg-a:r-1879000000000000019' }), result('w1'),
  ...up('u1', ALL3),
  prompt('改 B'), ...upd('d2', { draftId: 'r-1879000000000000019', htmlBody: '<div dir="ltr">B 改過</div>' }),
], 'allow');
t('兩個分頁：分頁 1 開 A、分頁 2 開 B，在分頁 1 傳 A 的 3 個檔 → 放行（不算給 B）', [
  prompt('寫兩封'), ...created('c1', 'r-1879000000000000023', { htmlBody: LIST3 }),
  ...created('c2', 'r-1879000000000000024', { htmlBody: '<div dir="ltr">附件 1 份：<br><ol><li>d.pdf — 說明</li></ol></div>' }),
  call('n1', 'mcp__claude-in-chrome__navigate', { url: 'https://mail.google.com/#all?compose=x%2Bmsg-a:r-1879000000000000023', tabId: 1 }), result('n1'),
  call('n2', 'mcp__claude-in-chrome__navigate', { url: 'https://mail.google.com/#all?compose=x%2Bmsg-a:r-1879000000000000024', tabId: 2 }), result('n2'),
  call('u1', 'mcp__claude-in-chrome__file_upload', { paths: ALL3, ref: 'ref_1', tabId: 1 }), result('u1'),
], 'allow');
t('兩個分頁：在分頁 1 只傳 A 的 2 個檔 → 擋 A（不是 B）', [
  prompt('寫兩封'), ...created('c1', 'r-1879000000000000025', { htmlBody: LIST3 }),
  ...created('c2', 'r-1879000000000000026', { htmlBody: '<div dir="ltr">B</div>' }),
  call('n1', 'mcp__claude-in-chrome__navigate', { url: 'https://mail.google.com/#all?compose=x%2Bmsg-a:r-1879000000000000025', tabId: 1 }), result('n1'),
  call('n2', 'mcp__claude-in-chrome__navigate', { url: 'https://mail.google.com/#all?compose=x%2Bmsg-a:r-1879000000000000026', tabId: 2 }), result('n2'),
  call('u1', 'mcp__claude-in-chrome__file_upload', { paths: [U + 'a.docx', U + 'b.xlsx'], ref: 'ref_1', tabId: 1 }), result('u1'),
], 'block', '實際上傳了 2 個');
t('create 回傳抽不到 id、只有一封草稿、開網址後少傳 → 仍擋（2026-10-11 主情境）', [
  prompt('寫信'), ...draft('d1', { htmlBody: LIST3 }), ...nav('n1', 'r-1879000000000000027'), ...up('u1', [U + 'a.docx', U + 'b.xlsx']),
], 'block', '實際上傳了 2 個');
t('Playwright（沒有分頁編號）：開 A、寫檔帶 B 的網址、上傳 → 仍算給 A；下一回合改 B 不擋', [
  prompt('寫兩封'), ...created('c1', 'r-1879000000000000028', { htmlBody: LIST3 }),
  ...created('c2', 'r-1879000000000000029', { htmlBody: '<div dir="ltr">B</div>' }),
  call('n1', 'mcp__playwright__browser_navigate', { url: 'https://mail.google.com/#all?compose=x%2Bmsg-a:r-1879000000000000028' }), result('n1'),
  call('w1', 'Write', { file_path: 'x.md', content: 'https://mail.google.com/#all?compose=x%2Bmsg-a:r-1879000000000000029' }), result('w1'),
  call('u1', 'mcp__playwright__browser_file_upload', { paths: ALL3 }), result('u1'),
  prompt('改 B'), ...upd('d2', { draftId: 'r-1879000000000000029', htmlBody: '<div dir="ltr">B 改過</div>' }),
], 'allow');
t('同一回合兩封各自上傳：各比各的清單，不混算', [
  prompt('寫兩封'), ...created('c1', 'r-1879000000000000020', { htmlBody: LIST3 }),
  ...created('c2', 'r-1879000000000000021', { htmlBody: '<div dir="ltr">附件 1 份：<br><ol><li>d.pdf — 說明</li></ol></div>' }),
  ...upTo('u1', 'r-1879000000000000020', ALL3), ...upTo('u2', 'r-1879000000000000021', [U + 'd.pdf']),
], 'allow');
t('跨回合：update_draft 自己用 API 帶了附件 → 不算清掉', [
  prompt('寫信'), ...created('c1', 'r-1879000000000000005', { htmlBody: LIST3 }), ...upTo('u1', 'r-1879000000000000005', ALL3),
  prompt('改'), ...upd('d2', { draftId: 'r-1879000000000000005', htmlBody: LIST3, attachments: [{ filename: 'a.docx', content: 'A' }] }),
], 'allow');
t('跨回合：update_draft 失敗（沒真的清掉）→ 不出聲', [
  prompt('寫信'), ...created('c1', 'r-1879000000000000006', { htmlBody: LIST3 }), ...upTo('u1', 'r-1879000000000000006', ALL3),
  prompt('改'), call('d2', 'mcp__claude_ai_Gmail__update_draft', { draftId: 'r-1879000000000000006', htmlBody: LIST3 }), result('d2', true),
], 'allow');
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
