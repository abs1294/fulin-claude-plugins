// 壓縮交接範本整條鏈的整合測試：snapshot → summary-log → reinject，檢查實際寫出的檔與輸出
// 用法：node compact_chain_test.js [--real]   （--real 會真的呼叫 claude -p 寫一封交接信，約 0.1 美元）
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const TPL = process.env.TPL_DIR || path.resolve(__dirname, '..', '..', 'hooks', 'templates');
const REAL = process.argv.includes('--real');
let ok = 0, bad = 0;
function check(name, cond, extra) { if (cond) { ok++; console.log('OK  ', name); } else { bad++; console.log('FAIL', name, extra || ''); } }

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'compactchain-'));
const hooks = path.join(root, '.claude', 'hooks');
fs.mkdirSync(hooks, { recursive: true });
for (const f of ['compact-snapshot.js', 'compact-handoff.js', 'compact-reinject.js', 'compact-summary-log.js']) fs.copyFileSync(path.join(TPL, f), path.join(hooks, f));

const tp = path.join(root, 'transcript.jsonl');
const T = [
  { type: 'user', message: { role: 'user', content: '把登入頁的錯誤訊息改成中文，改完跑測試' } },
  { type: 'assistant', message: { role: 'assistant', content: [
    { type: 'text', text: '我會先讀制度文件，再改 src/login.js。' },
    { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/proj/.claude/harness/README.md' } },
    { type: 'tool_use', id: 't1b', name: 'Read', input: { file_path: '/proj/openspec/spec.md' } },
    { type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: '/proj/src/login.js' } },
    { type: 'tool_use', id: 't2b', name: 'Edit', input: { file_path: '/proj/node_modules/x/index.js' } },
    { type: 'tool_use', id: 't3', name: 'Agent', input: { description: '審查登入頁改動' } },
  ] } },
  { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't3', content: 'Async agent launched successfully.\nagentId: abc123def (internal ID)' }] } },
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '審查還在跑。測試要不要現在就跑，等你決定。' }] } },
  { type: 'attachment', attachment: { type: 'queued_command', prompt: '先不要跑測試，等審查回來', origin: { kind: 'human' } } },
];
fs.writeFileSync(tp, T.map(o => JSON.stringify(o)).join('\n') + '\n');
const sid = 'sess1';
const snapDir = path.join(root, sid, 'compact-snapshots');

function run(hook, payload, env) {
  return spawnSync(process.execPath, [path.join(hooks, hook)], { input: JSON.stringify(payload), cwd: root, encoding: 'utf8',
    env: Object.assign({}, process.env, env || {}), timeout: 300000 });
}

// 1. snapshot（關閉交接信）
let r = run('compact-snapshot.js', { session_id: sid, transcript_path: tp, cwd: root, hook_event_name: 'PreCompact', trigger: 'manual', custom_instructions: null }, { COMPACT_HANDOFF_OFF: '1' });
check('snapshot exit 0 且無 stdout', r.status === 0 && !r.stdout, r.stderr);
const stamp = fs.existsSync(path.join(snapDir, 'latest.txt')) ? fs.readFileSync(path.join(snapDir, 'latest.txt'), 'utf8').trim() : null;
check('latest.txt 寫出', !!stamp);
const snap = stamp ? JSON.parse(fs.readFileSync(path.join(snapDir, stamp + '.json'), 'utf8')) : {};
check('背景 agent 列為仍在跑', snap.running && snap.running.length === 1 && snap.running[0].id === 'abc123def', JSON.stringify(snap.running));
check('docs 收 harness README', (snap.docs || []).some(f => f.endsWith('harness/README.md')), JSON.stringify(snap.docs));
check('docs 不收未填入的 openspec（預設填空區不含）', !(snap.docs || []).some(f => f.includes('openspec')), JSON.stringify(snap.docs));
check('edits 收 login.js、排除 node_modules', JSON.stringify(snap.edits) === JSON.stringify(['/proj/src/login.js']), JSON.stringify(snap.edits));
check('prompts 收使用者原話與中途插話', (snap.prompts || []).length === 2 && snap.prompts[1].includes('先不要跑測試'), JSON.stringify(snap.prompts));
check('handoff 記為 disabled', snap.handoff && snap.handoff.ok === false && /disabled/.test(snap.handoff.error), JSON.stringify(snap.handoff));
check('inputKeys 記錄 custom_instructions', (snap.inputKeys || []).includes('custom_instructions'));

// 2. summary-log
r = run('compact-summary-log.js', { session_id: sid, transcript_path: tp, hook_event_name: 'PostCompact', trigger: 'manual', compact_summary: '摘要：在改登入頁' });
check('summary-log exit 0 且無 stdout', r.status === 0 && !r.stdout, r.stderr);
check('summary.md 寫出', fs.existsSync(path.join(snapDir, stamp + '.summary.md')));
const row = JSON.parse(fs.readFileSync(path.join(snapDir, 'compact-log.jsonl'), 'utf8').trim().split('\n').pop());
check('流水帳記下摘要漏掉的 agent 與檔案', row.missing.agents.length === 1 && row.missing.edits.includes('login.js'), JSON.stringify(row.missing));

// 3. reinject（沒有交接信 → 快照清單）
r = run('compact-reinject.js', { session_id: sid, transcript_path: tp, hook_event_name: 'SessionStart', source: 'compact' });
check('reinject 退回快照清單', r.status === 0 && r.stdout.includes('交接信未產生') && r.stdout.includes('abc123def') && r.stdout.includes('login.js'), r.stdout.slice(0, 200));

// 3b. reinject 退回清單過長 → 整段不超過 MAX（3500）
{ const big = JSON.parse(fs.readFileSync(path.join(snapDir, stamp + '.json'), 'utf8'));
  big.edits = Array.from({ length: 400 }, (_, i) => '/proj/src/很長的檔名第' + i + '號元件.js');
  fs.writeFileSync(path.join(snapDir, stamp + '.json'), JSON.stringify(big));
  r = run('compact-reinject.js', { session_id: sid, transcript_path: tp, hook_event_name: 'SessionStart', source: 'compact' });
  check('快照清單過長時整段 ≤ 3500', r.stdout.length <= 3500 && r.stdout.includes('已截斷'), 'len=' + r.stdout.length);
  fs.writeFileSync(path.join(snapDir, stamp + '.json'), JSON.stringify(snap)); }

// 4. reinject（超長交接信 → 整段不超過 9800 字元、有截斷標記）
fs.writeFileSync(path.join(snapDir, stamp + '.handoff.md'), '## 未完成（完整保留）\n' + '這是很長的未完成事項。'.repeat(2000));
r = run('compact-reinject.js', { session_id: sid, transcript_path: tp, hook_event_name: 'SessionStart', source: 'compact' });
check('超長交接信整段 ≤ 9800', r.stdout.length <= 9800, 'len=' + r.stdout.length);
check('超長交接信有截斷標記與全文路徑', r.stdout.includes('已截斷') && r.stdout.includes('交接信全文：'));

// 5. 找不到 claude → handoff.ok=false 記錄錯誤，快照照存
fs.unlinkSync(path.join(snapDir, stamp + '.handoff.md'));
r = run('compact-snapshot.js', { session_id: sid, transcript_path: tp, hook_event_name: 'PreCompact', trigger: 'auto', custom_instructions: null },
  { PATH: '', USERPROFILE: '/nonexistent-home', HOME: '/nonexistent-home' });
const stamp2 = fs.readFileSync(path.join(snapDir, 'latest.txt'), 'utf8').trim();
const snap2 = JSON.parse(fs.readFileSync(path.join(snapDir, stamp2 + '.json'), 'utf8'));
check('找不到 claude：exit 0、快照照存、handoff 記錯誤', r.status === 0 && snap2.handoff && snap2.handoff.ok === false && !!snap2.handoff.error, JSON.stringify(snap2.handoff));

// 6. 真的呼叫 claude -p 寫一封交接信（選用）
if (REAL) {
  r = run('compact-snapshot.js', { session_id: sid, transcript_path: tp, hook_event_name: 'PreCompact', trigger: 'manual', custom_instructions: null });
  const s3 = fs.readFileSync(path.join(snapDir, 'latest.txt'), 'utf8').trim();
  const snap3 = JSON.parse(fs.readFileSync(path.join(snapDir, s3 + '.json'), 'utf8'));
  console.log('handoff 統計：', JSON.stringify(snap3.handoff));
  const hp = path.join(snapDir, s3 + '.handoff.md');
  check('真呼叫：交接信寫出', snap3.handoff && snap3.handoff.ok && fs.existsSync(hp), JSON.stringify(snap3.handoff));
  if (fs.existsSync(hp)) {
    const h = fs.readFileSync(hp, 'utf8');
    check('真呼叫：有「未完成」段且提到登入頁', h.includes('未完成') && h.includes('登入'), h.slice(0, 200));
    check('真呼叫：「已處理」統計行已移除', !/^[ \t]*已處理[：:]/m.test(h));
    console.log('----- 交接信 -----\n' + h + '\n------------------');
  }
  r = run('compact-reinject.js', { session_id: sid, transcript_path: tp, hook_event_name: 'SessionStart', source: 'compact' });
  check('真呼叫：reinject 注入交接信', r.stdout.includes('壓縮前寫好的交接信') && r.stdout.length <= 9800, 'len=' + r.stdout.length);
}

console.log(`\n合計 OK ${ok} / FAIL ${bad}；暫存目錄 ${root}`);
fs.rmSync(root, { recursive: true, force: true });
process.exit(bad ? 1 : 0);
