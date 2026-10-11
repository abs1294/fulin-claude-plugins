// 0.3.1 新增行為的整合測試：關鍵值抽取、先截「已完成」節、missingInHandoff、resume 過期提醒
// 用法：node compact_v031_test.js   （TPL_DIR 可指到別的目錄做對照組）
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const TPL = process.env.TPL_DIR || path.resolve(__dirname, '..', '..', 'hooks', 'templates');
let ok = 0, bad = 0;
function check(name, cond, extra) { if (cond) { ok++; console.log('OK  ', name); } else { bad++; console.log('FAIL', name, extra || ''); } }

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'compact031-'));
const hooks = path.join(root, '.claude', 'hooks');
fs.mkdirSync(hooks, { recursive: true });
for (const f of ['compact-snapshot.js', 'compact-handoff.js', 'compact-reinject.js', 'compact-summary-log.js', 'resume-stale-reminder.js']) {
  if (fs.existsSync(path.join(TPL, f))) fs.copyFileSync(path.join(TPL, f), path.join(hooks, f));
}
function run(hook, payload, env) {
  if (!fs.existsSync(path.join(hooks, hook))) return { status: -1, stdout: '', stderr: 'missing ' + hook };
  return spawnSync(process.execPath, [path.join(hooks, hook)], { input: JSON.stringify(payload), cwd: root, encoding: 'utf8',
    env: Object.assign({}, process.env, { COMPACT_HANDOFF_OFF: '1' }, env || {}), timeout: 60000 });
}
const sid = 'sess1';
const snapDir = path.join(root, sid, 'compact-snapshots');
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();

// 1. 關鍵值抽取（buildDigest，不呼叫模型）
{
  const tp = path.join(root, 'keys.jsonl');
  const T = [
    { type: 'user', timestamp: iso(600000), message: { role: 'user', content: '跑測試' } },
    { type: 'assistant', timestamp: iso(590000), message: { role: 'assistant', content: [
      { type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'pytest tests/' } },
      { type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: '/proj/x.py' } },
      { type: 'tool_use', id: 'b2', name: 'Bash', input: { command: 'cat old-handoff.md' } },
      { type: 'tool_use', id: 'b3', name: 'Bash', input: { command: 'cat notes.md\npytest tests/e2e' } },
    ] } },
    { type: 'user', timestamp: iso(580000), message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'b1', content: '...\n12 passed, 1 failed in 3.21s\nFAILED tests/test_login.py::test_error_msg' },
      { type: 'tool_result', tool_use_id: 'r1', content: 'raise RuntimeError("x")\nFAILED = 3' },
      { type: 'tool_result', tool_use_id: 'b2', content: '上次 99 passed in 1.0s' },
      { type: 'tool_result', tool_use_id: 'b3', content: '筆記內容\n7 passed, 2 failed in 9.87s' },
    ] } },
  ];
  fs.writeFileSync(tp, T.map(o => JSON.stringify(o)).join('\n') + '\n');
  let keys = null;
  try { delete require.cache[require.resolve(path.join(hooks, 'compact-handoff.js'))]; keys = require(path.join(hooks, 'compact-handoff.js')).buildDigest(tp).keys; } catch (e) { keys = null; }
  const vals = (keys || []).map(k => k.value);
  check('關鍵值：抽到 pytest 結果行', vals.some(v => v.includes('12 passed, 1 failed')), JSON.stringify(vals));
  check('關鍵值：抽到 FAILED 錯誤行', vals.some(v => v.startsWith('FAILED tests/test_login.py')), JSON.stringify(vals));
  check('關鍵值：Read 回傳的程式字面不收', !vals.some(v => v.includes('FAILED = 3') || v.includes('RuntimeError')), JSON.stringify(vals));
  check('關鍵值：cat 讀舊信的數字不收', !vals.some(v => v.includes('99 passed')), JSON.stringify(vals));
  check('關鍵值：多行指令（cat 換行接 pytest）的測試結果照收', vals.some(v => v.includes('7 passed, 2 failed')), JSON.stringify(vals));
}

// 2. 注入超長：先截「已完成」節，硬約束與關鍵值保留
{
  const tp = path.join(root, 't.jsonl');
  fs.writeFileSync(tp, JSON.stringify({ type: 'user', message: { role: 'user', content: 'x' } }) + '\n');
  fs.mkdirSync(snapDir, { recursive: true });
  fs.writeFileSync(path.join(snapDir, 'latest.txt'), '20260101T000000');
  fs.writeFileSync(path.join(snapDir, '20260101T000000.json'), JSON.stringify({ stamp: '20260101T000000', running: [], docs: [], edits: [], skills: ['git-commit'], prompts: [] }));
  const letter = ['## 未完成（完整保留）', '1. 改登入頁', '## 目標版本', '無', '## 硬約束（使用者原話）', '- 「不要 push」', '## 關鍵值（原樣）', '- 測試結果：12 passed, 1 failed in 3.21s',
    '## 走過的死路', '無', '## HYPOTHESIS／已推翻', '無', '## 已完成（每項一兩句）', '這是很長的已完成事項。'.repeat(1200), '## 偏好（使用者原話）', '- 「回覆用繁體中文」', '## 建議 skill', '- git-commit'].join('\n');
  fs.writeFileSync(path.join(snapDir, '20260101T000000.handoff.md'), letter);
  const r = run('compact-reinject.js', { session_id: sid, transcript_path: tp, hook_event_name: 'SessionStart', source: 'compact' });
  check('注入整段 ≤ 9800', r.stdout.length <= 9800, 'len=' + r.stdout.length);
  check('注入：硬約束保留', r.stdout.includes('「不要 push」'));
  check('注入：關鍵值保留', r.stdout.includes('12 passed, 1 failed in 3.21s'));
  check('注入：已完成之後的偏好與建議 skill 也保留', r.stdout.includes('「回覆用繁體中文」') && r.stdout.includes('## 建議 skill'));
  check('注入：已完成節有截短提示', r.stdout.includes('已完成節已截短'));

  // 3. summary-log 記 missingInHandoff（交接信沒提到快照裡的 skill 時要記下來）
  fs.writeFileSync(path.join(snapDir, '20260101T000000.json'), JSON.stringify({ stamp: '20260101T000000', running: [], docs: [], edits: [], skills: ['git-commit', 'browser-qa'], prompts: [] }));
  run('compact-summary-log.js', { session_id: sid, transcript_path: tp, hook_event_name: 'PostCompact', trigger: 'auto', compact_summary: '摘要' });
  let row = null;
  try { row = JSON.parse(fs.readFileSync(path.join(snapDir, 'compact-log.jsonl'), 'utf8').trim().split('\n').pop()); } catch {}
  check('流水帳：missingInHandoff 記下交接信漏的 skill', row && row.missingInHandoff && JSON.stringify(row.missingInHandoff.skills) === '["browser-qa"]', JSON.stringify(row && row.missingInHandoff));

  // 4. resume 過期提醒：5 小時前 → 提醒並附交接信路徑與最後指示；1 小時前 → 不出聲
  const tp5 = path.join(root, 'r5.jsonl');
  fs.writeFileSync(tp5, [
    { type: 'user', timestamp: iso(5 * 3600000), message: { role: 'user', content: '先不要推，等我回來' } },
    { type: 'assistant', timestamp: iso(5 * 3600000 - 1000), message: { role: 'assistant', content: [{ type: 'text', text: '好' }] } },
  ].map(o => JSON.stringify(o)).join('\n') + '\n');
  let rr = run('resume-stale-reminder.js', { session_id: sid, transcript_path: tp5, hook_event_name: 'SessionStart', source: 'resume' });
  check('resume 5 小時：有提醒', rr.stdout.includes('[resume-stale]') && /距上次活動 5\.\d 小時/.test(rr.stdout), rr.stdout.slice(0, 120) || rr.stderr);
  check('resume 5 小時：附最近交接信路徑', rr.stdout.includes('20260101T000000.handoff.md'));
  check('resume 5 小時：附使用者最後指示原文', rr.stdout.includes('先不要推，等我回來'));
  const tp1 = path.join(root, 'r1.jsonl');
  fs.writeFileSync(tp1, JSON.stringify({ type: 'user', timestamp: iso(3600000), message: { role: 'user', content: 'x' } }) + '\n');
  rr = run('resume-stale-reminder.js', { session_id: sid, transcript_path: tp1, hook_event_name: 'SessionStart', source: 'resume' });
  check('resume 1 小時：不出聲', rr.status === 0 && rr.stdout === '', JSON.stringify(rr.stdout));
  // 5 小時前一則舊指示，30 秒前又有新指示與回覆 → 上次活動是 30 秒前，不該提醒（舊版會誤報並把舊句子當成最後指示）
  const tp30 = path.join(root, 'r30.jsonl');
  fs.writeFileSync(tp30, [
    { type: 'user', timestamp: iso(5 * 3600000), message: { role: 'user', content: '舊指示' } },
    { type: 'user', timestamp: iso(30000), message: { role: 'user', content: '剛剛才說的：先不要推' } },
    { type: 'assistant', timestamp: iso(25000), message: { role: 'assistant', content: [{ type: 'text', text: '好' }] } },
  ].map(o => JSON.stringify(o)).join('\n') + '\n');
  rr = run('resume-stale-reminder.js', { session_id: sid, transcript_path: tp30, hook_event_name: 'SessionStart', source: 'resume' });
  check('resume：30 秒前才活動 → 不出聲', rr.status === 0 && rr.stdout === '', JSON.stringify(rr.stdout.slice(0, 80)));
  // 5 小時前真實活動＋1 秒前一筆系統注入的 isMeta user 紀錄 → isMeta 不算活動，仍要提醒
  const tpm = path.join(root, 'rm.jsonl');
  fs.writeFileSync(tpm, [
    { type: 'user', timestamp: iso(5 * 3600000), message: { role: 'user', content: '真實的最後指示' } },
    { type: 'user', isMeta: true, timestamp: iso(1000), message: { role: 'user', content: '系統注入' } },
  ].map(o => JSON.stringify(o)).join('\n') + '\n');
  rr = run('resume-stale-reminder.js', { session_id: sid, transcript_path: tpm, hook_event_name: 'SessionStart', source: 'resume' });
  check('resume：isMeta 紀錄不算活動 → 仍提醒 5 小時且最後指示是真實那句', /距上次活動 5\.\d 小時/.test(rr.stdout) && rr.stdout.includes('真實的最後指示'), JSON.stringify(rr.stdout.slice(0, 80)));
}

console.log(`\n合計 OK ${ok} / FAIL ${bad}`);
fs.rmSync(root, { recursive: true, force: true });
process.exit(bad ? 1 : 0);
