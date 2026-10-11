// 「使用者已裁決」與「任務清單最後狀態」的整合測試：snapshot 抽出的內容、reinject 兩條路徑原樣注入
// 用法：node compact_decisions_test.js   （TPL_DIR 可指到別的目錄做對照組；不呼叫 claude）
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const TPL = process.env.TPL_DIR || path.resolve(__dirname, '..', '..', 'hooks', 'templates');
let ok = 0, bad = 0;
function check(name, cond, extra) { if (cond) { ok++; console.log('OK  ', name); } else { bad++; console.log('FAIL', name, extra || ''); } }

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'compactdec-'));
const hooks = path.join(root, '.claude', 'hooks');
fs.mkdirSync(hooks, { recursive: true });
for (const f of ['compact-snapshot.js', 'compact-handoff.js', 'compact-reinject.js']) fs.copyFileSync(path.join(TPL, f), path.join(hooks, f));
function run(hook, payload, env) {
  return spawnSync(process.execPath, [path.join(hooks, hook)], { input: JSON.stringify(payload), cwd: root, encoding: 'utf8',
    env: Object.assign({}, process.env, { COMPACT_HANDOFF_OFF: '1' }, env || {}), timeout: 60000 });
}
let n = 0;
// 寫 transcript、跑 snapshot，回傳快照內容與 reinject 用的參數
function snapOf(T, env) {
  const sid = 's' + (++n);
  const tp = path.join(root, sid + '.jsonl');
  fs.writeFileSync(tp, T.map(o => JSON.stringify(o)).join('\n') + '\n');
  const r = run('compact-snapshot.js', { session_id: sid, transcript_path: tp, hook_event_name: 'PreCompact', trigger: 'manual', custom_instructions: null }, env);
  const dir = path.join(root, sid, 'compact-snapshots');
  const stamp = fs.existsSync(path.join(dir, 'latest.txt')) ? fs.readFileSync(path.join(dir, 'latest.txt'), 'utf8').trim() : null;
  const snap = stamp ? JSON.parse(fs.readFileSync(path.join(dir, stamp + '.json'), 'utf8')) : {};
  return { r, snap, sid, tp, dir, stamp };
}
const reinject = (s) => run('compact-reinject.js', { session_id: s.sid, transcript_path: s.tp, hook_event_name: 'SessionStart', source: 'compact' });

// 真實格式（取自本機 transcript 的結構，內容換成假資料）
const ask = (id, questions) => ({ type: 'assistant', timestamp: '2026-10-07T10:35:25.923Z', message: { role: 'assistant', content: [
  { type: 'tool_use', id, name: 'AskUserQuestion', input: { questions } }] } });
const q = (question, multiSelect) => ({ question, header: 'h', multiSelect: !!multiSelect, options: [{ label: '甲 (Recommended)', description: 'd' }, { label: '乙', description: 'd' }] });
const answered = (id, ts, answers, annotations, questions) => ({ type: 'user', timestamp: ts, toolUseResult: { questions, answers, annotations: annotations || {} },
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id,
    content: 'Your questions have been answered: ' + Object.entries(answers).map(([k, v]) => `"${k}"="${v}"`).join(', ') + '. You can now continue with these answers in mind.' }] } });
const tool = (id, name, input) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
const result = (id, content, tur, isError) => ({ type: 'user', timestamp: '2026-10-07T11:00:00.000Z', toolUseResult: tur,
  message: { role: 'user', content: [Object.assign({ type: 'tool_result', tool_use_id: id, content }, isError ? { is_error: true } : {})] } });
const summary = (t) => ({ type: 'user', isCompactSummary: true, message: { role: 'user', content: t } });

const Q1 = 'git-commit 的 description 要改成「只寫何時觸發」嗎？（實測 18/18）';
const Q2 = '另外三件小事，勾選要做的：';
const Q3 = '「資料」這一類指的是什麼？';
const Q4 = '要不要現在 push？';
const Q5 = '舊格式的題目';
const QS = '子 agent 的提問';

// 1. 正向：裁決逐題配對、原樣、跨壓縮保留並標記；拒答／逾時／子 agent 不收；舊格式退回整段
{
  const T = [
    { type: 'user', message: { role: 'user', content: '開始' } },
    ask('a1', [q(Q1)]),
    answered('a1', '2026-10-07T10:41:10.718Z', { [Q1]: '維持原樣 (Recommended)' }, {}, [q(Q1)]),
    summary('第一次壓縮摘要'),
    ask('a2', [q(Q2, true), q(Q3)]),
    answered('a2', '2026-10-08T03:09:03.235Z', { [Q2]: 'C 軌判準加全檔核對, evals/results 不進 git', [Q3]: '(notes only)' },
      { [Q3]: { notes: '資料庫 schema、髒資料清理，data migration 之類' }, [Q2]: { preview: '不該被當成答案的預覽' } }, [q(Q2, true), q(Q3)]),
    summary('第二次壓縮摘要'),
    ask('a3', [q(Q4)]),
    result('a3', "The user doesn't want to proceed with this tool use. The tool use was rejected.", 'Error: rejected', true),
    ask('a4', [q(Q4)]),
    result('a4', 'No response after 60s — the user may be away from keyboard.', { questions: [q(Q4)], answers: {}, annotations: {}, afkTimeoutMs: 60000 }),
    ask('a5', [q(Q5)]),
    result('a5', 'The user answered: "舊格式的題目"="自由輸入的答覆". Read the answers carefully — they may request clarification.', undefined),
    Object.assign(ask('as', [q(QS)]), { isSidechain: true }),
    Object.assign(answered('as', '2026-10-08T05:00:00.000Z', { [QS]: '甲 (Recommended)' }, {}, [q(QS)]), { isSidechain: true }),
  ];
  const s = snapOf(T);
  check('snapshot exit 0 且無輸出', s.r.status === 0 && !s.r.stdout, s.r.stderr);
  const d = s.snap.decisions || [];
  check('裁決共 4 筆（Q1、Q2、Q3、舊格式；拒答／逾時／子 agent 不收）', d.length === 4, JSON.stringify(d.map(x => x.q)));
  check('Q1 答案原樣、時間轉台北時間、標上次壓縮前', d[0] && d[0].q === Q1 && d[0].a === '維持原樣 (Recommended)' && d[0].at === '10-07 18:41' && d[0].before === true, JSON.stringify(d[0]));
  check('兩次壓縮之間的 Q2 也標上次壓縮前（第二次摘要之前）', d[1] && d[1].before === true, JSON.stringify(d[1]));
  check('多選答案原樣（逗號串接）', d[1] && d[1].a === 'C 軌判準加全檔核對, evals/results 不進 git' && d[1].notes === '', JSON.stringify(d[1]));
  check('只寫附註：答案 (notes only)＋附註原文；preview 不收', d[2] && d[2].a === '(notes only)' && d[2].notes === '資料庫 schema、髒資料清理，data migration 之類', JSON.stringify(d[2]));
  check('舊格式（無 toolUseResult）退回整段答覆、去掉前後制式句', d[3] && d[3].q === Q5 && d[3].a === '"舊格式的題目"="自由輸入的答覆"' && !d[3].before, JSON.stringify(d[3]));
  check('沒用過任務清單工具 → tasks 為空陣列', Array.isArray(s.snap.tasks) && s.snap.tasks.length === 0, JSON.stringify(s.snap.tasks));

  // reinject：快照清單路徑
  let r = reinject(s);
  check('快照路徑：有「使用者已裁決」節', r.status === 0 && r.stdout.includes('■ 使用者已裁決'), r.stdout.slice(0, 200));
  check('快照路徑：每筆題目、答案、附註原文都在', [Q1, Q2, Q3, '維持原樣 (Recommended)', 'C 軌判準加全檔核對, evals/results 不進 git', '(notes only)',
    '資料庫 schema、髒資料清理，data migration 之類', '"舊格式的題目"="自由輸入的答覆"'].every(v => r.stdout.includes(v)));
  check('快照路徑：上次壓縮前的標〔上次壓縮前〕、之後的不標', (r.stdout.match(/〔上次壓縮前〕/g) || []).length === 3, r.stdout);
  check('快照路徑：拒答、逾時、子 agent、preview 不出現', !r.stdout.includes(Q4) && !r.stdout.includes(QS) && !r.stdout.includes('不該被當成答案的預覽'));
  check('快照路徑：沒用過任務清單 → 不輸出任務清單節', !r.stdout.includes('■ 任務清單'));

  // reinject：交接信路徑（交接信本身完全沒提裁決，程式照樣附上）
  fs.writeFileSync(path.join(s.dir, s.stamp + '.handoff.md'), '## 未完成（完整保留）\n1. 改登入頁\n');
  r = reinject(s);
  check('交接信路徑：注入交接信且附上裁決原文', r.stdout.includes('壓縮前寫好的交接信') && r.stdout.includes('■ 使用者已裁決') && r.stdout.includes(Q1) && r.stdout.includes('維持原樣 (Recommended)'));
  // 超長交接信：裁決仍完整，整段 ≤ 9800
  fs.writeFileSync(path.join(s.dir, s.stamp + '.handoff.md'), '## 未完成（完整保留）\n' + '這是很長的未完成事項。'.repeat(2000));
  r = reinject(s);
  check('交接信超長：整段 ≤ 9800、裁決節完整保留', r.stdout.length <= 9800 && r.stdout.includes('■ 使用者已裁決') && r.stdout.includes('資料庫 schema、髒資料清理，data migration 之類'), 'len=' + r.stdout.length);
}

// 2. 任務清單：TaskCreate／TaskUpdate 重播、deleted 移除、清單外 id 不造、改標題、Task not found 不套用
{
  const T = [
    tool('c1', 'TaskCreate', { subject: '甲：改登入頁', description: 'x' }), result('c1', 'Task #1 created successfully: 甲：改登入頁', { task: { id: '1', subject: '甲：改登入頁' } }),
    tool('c2', 'TaskCreate', { subject: '乙：跑測試', description: 'x' }), result('c2', 'Task #2 created successfully: 乙：跑測試', { task: { id: '2', subject: '乙：跑測試' } }),
    tool('c3', 'TaskCreate', { subject: '丙：要刪的', description: 'x' }), result('c3', 'Task #3 created successfully: 丙：要刪的', { task: { id: '3', subject: '丙：要刪的' } }),
    tool('c4', 'TaskCreate', { subject: '丁：舊標題', description: 'x' }), result('c4', 'Task #4 created successfully: 丁：舊標題', undefined),
    tool('u1', 'TaskUpdate', { taskId: '1', status: 'completed' }), result('u1', 'Updated task #1 status', { success: true, taskId: '1', updatedFields: ['status'] }),
    summary('壓縮摘要（任務清單跨壓縮延續）'),
    tool('u2', 'TaskUpdate', { taskId: '2', status: 'in_progress' }), result('u2', 'Updated task #2 status', { success: true, taskId: '2', updatedFields: ['status'] }),
    tool('u3', 'TaskUpdate', { taskId: '3', status: 'deleted' }), result('u3', 'Updated task #3 deleted', { success: true, taskId: '3', updatedFields: ['deleted'] }),
    tool('u4', 'TaskUpdate', { taskId: '9', status: 'completed' }), result('u4', 'Updated task #9 status', { success: true, taskId: '9', updatedFields: ['status'] }),
    tool('u5', 'TaskUpdate', { taskId: '4', subject: '丁：新標題' }), result('u5', 'Updated task #4 subject', { success: true, taskId: '4', updatedFields: ['subject'] }),
    tool('u6', 'TaskUpdate', { taskId: '4', status: 'completed' }), result('u6', 'Task not found', { success: false, taskId: '4' }),
  ];
  const s = snapOf(T);
  const t = s.snap.tasks || [];
  check('任務清單重播：3 項（丙已刪、#9 不造）', t.length === 3, JSON.stringify(t));
  check('狀態與標題正確（含跨壓縮的更新、改標題、Task not found 不套用）',
    JSON.stringify(t.map(x => [x.id, x.subject, x.status])) === JSON.stringify([['1', '甲：改登入頁', 'completed'], ['2', '乙：跑測試', 'in_progress'], ['4', '丁：新標題', 'pending']]), JSON.stringify(t));
  check('沒有 AskUserQuestion → decisions 為空陣列', Array.isArray(s.snap.decisions) && s.snap.decisions.length === 0);
  const r = reinject(s);
  check('reinject：有任務清單節、未完成的排在已完成前', r.stdout.includes('■ 任務清單') && r.stdout.indexOf('[in_progress] 乙：跑測試') < r.stdout.indexOf('[completed] 甲：改登入頁')
    && r.stdout.includes('[pending] 丁：新標題') && !r.stdout.includes('丙：要刪的'), r.stdout);
  check('reinject：沒有裁決 → 不輸出裁決節', !r.stdout.includes('■ 使用者已裁決'));
}

// 3. 任務清單：id 重複＝清單被重置；TaskList 回傳整份換掉（含純文字格式）
{
  const T = [
    tool('c1', 'TaskCreate', { subject: '舊一' }), result('c1', 'Task #1 created successfully: 舊一', { task: { id: '1', subject: '舊一' } }),
    tool('c2', 'TaskCreate', { subject: '舊二' }), result('c2', 'Task #2 created successfully: 舊二', { task: { id: '2', subject: '舊二' } }),
    tool('c3', 'TaskCreate', { subject: '新一' }), result('c3', 'Task #1 created successfully: 新一', { task: { id: '1', subject: '新一' } }),
  ];
  let s = snapOf(T);
  check('id 重複 → 舊清單丟掉，只剩新一', JSON.stringify((s.snap.tasks || []).map(x => x.subject)) === JSON.stringify(['新一']), JSON.stringify(s.snap.tasks));
  s = snapOf([...T,
    tool('l1', 'TaskList', {}), result('l1', '#7 [in_progress] 別處建的\n#8 [pending] 另一項', { tasks: [{ id: '7', subject: '別處建的', status: 'in_progress', blockedBy: [] }, { id: '8', subject: '另一項', status: 'pending', blockedBy: [] }] }),
    tool('u1', 'TaskUpdate', { taskId: '8', status: 'completed' }), result('u1', 'Updated task #8 status', { success: true, taskId: '8' }),
  ]);
  check('TaskList 回傳整份換掉、之後的更新照套', JSON.stringify((s.snap.tasks || []).map(x => [x.id, x.status])) === JSON.stringify([['7', 'in_progress'], ['8', 'completed']]), JSON.stringify(s.snap.tasks));
  s = snapOf([...T, tool('l1', 'TaskList', {}), result('l1', '#5 [pending] 純文字格式', undefined)]);
  check('TaskList 沒有 toolUseResult 時解析純文字', JSON.stringify((s.snap.tasks || []).map(x => [x.id, x.subject, x.status])) === JSON.stringify([['5', '純文字格式', 'pending']]), JSON.stringify(s.snap.tasks));
  s = snapOf([...T, tool('l1', 'TaskList', {}), result('l1', 'No tasks found', { tasks: [] })]);
  check('TaskList 回傳空清單 → tasks 為空、不輸出', (s.snap.tasks || []).length === 0 && !reinject(s).stdout.includes('■ 任務清單'));
}

// 4. TodoWrite（官方 schema，本機無真實紀錄）：每次整份覆蓋，取最後一次
{
  const s = snapOf([
    tool('w1', 'TodoWrite', { todos: [{ content: '第一版', status: 'pending', activeForm: 'x' }] }), result('w1', 'Todos have been modified successfully.', undefined),
    tool('w2', 'TodoWrite', { todos: [{ content: '讀規格', status: 'completed', activeForm: 'x' }, { content: '改程式', status: 'in_progress', activeForm: 'x' }] }), result('w2', 'Todos have been modified successfully.', undefined),
  ]);
  check('TodoWrite 取最後一次整份', JSON.stringify((s.snap.tasks || []).map(x => [x.subject, x.status])) === JSON.stringify([['讀規格', 'completed'], ['改程式', 'in_progress']]), JSON.stringify(s.snap.tasks));
  const r = reinject(s);
  check('最後是 TodoWrite → 標頭要求用 TodoWrite 整份重寫', r.stdout.includes('■ 任務清單') && r.stdout.includes('TodoWrite 整份重寫') && !r.stdout.includes('TaskList'), r.stdout);
}

// 4b. TaskCreate 與 TodoWrite 混用：TodoWrite 只換掉自己那份；標頭依最後一次的來源
{
  const create = [tool('c1', 'TaskCreate', { subject: '甲：Task 建的' }), result('c1', 'Task #1 created successfully: 甲：Task 建的', { task: { id: '1', subject: '甲：Task 建的' } })];
  const todo = (id, items) => [tool(id, 'TodoWrite', { todos: items.map(content => ({ content, status: 'pending', activeForm: 'x' })) }), result(id, 'Todos have been modified successfully.', undefined)];
  let s = snapOf([...create, ...todo('w1', ['舊待辦']), ...todo('w2', ['新待辦'])]);
  check('先 TaskCreate 再 TodoWrite → 兩邊都保留、TodoWrite 只留最後一份', JSON.stringify((s.snap.tasks || []).map(x => x.subject)) === JSON.stringify(['甲：Task 建的', '新待辦']), JSON.stringify(s.snap.tasks));
  check('最後是 TodoWrite → tasksSource 為 TodoWrite', s.snap.tasksSource === 'TodoWrite', String(s.snap.tasksSource));
  s = snapOf([...todo('w1', ['待辦']), tool('u1', 'TaskUpdate', { taskId: '1', status: 'in_progress' }), result('u1', 'Task not found', { success: false, taskId: '1' }),
    tool('c2', 'TaskCreate', { subject: '乙' }), result('c2', 'Task #2 created successfully: 乙', { task: { id: '2', subject: '乙' } })]);
  const r = reinject(s);
  check('最後是 Task 系列 → 標頭要求先跑 TaskList', r.stdout.includes('■ 任務清單') && r.stdout.includes('先跑 TaskList') && !r.stdout.includes('TodoWrite 整份重寫'), r.stdout);
  // TaskList／重複 id 的 TaskCreate 只換 Task 項目，TodoWrite 的項目留著
  s = snapOf([...create, ...todo('w1', ['待辦']),
    tool('l1', 'TaskList', {}), result('l1', '#7 [pending] 別處建的', { tasks: [{ id: '7', subject: '別處建的', status: 'pending', blockedBy: [] }] })]);
  const subj = (x) => JSON.stringify((x.snap.tasks || []).map(t => t.subject).sort());
  check('先 TodoWrite 再 TaskList → todo 項目保留、Task 項目換成 TaskList 的', subj(s) === JSON.stringify(['別處建的', '待辦'].sort()), JSON.stringify(s.snap.tasks));
  s = snapOf([...create, ...todo('w1', ['待辦']),
    tool('c3', 'TaskCreate', { subject: '重置後' }), result('c3', 'Task #1 created successfully: 重置後', { task: { id: '1', subject: '重置後' } })]);
  check('先 TodoWrite 再重複 id 的 TaskCreate → todo 項目保留、舊 Task 項目丟掉', subj(s) === JSON.stringify(['待辦', '重置後'].sort()), JSON.stringify(s.snap.tasks));
  // 沒套用到清單的呼叫不改 tasksSource
  s = snapOf([...create, ...todo('w1', ['待辦']), tool('u2', 'TaskUpdate', { taskId: '1', status: 'completed' }), result('u2', 'Task not found', { success: false, taskId: '1' })]);
  check('TodoWrite 之後 TaskUpdate 失敗 → tasksSource 仍為 TodoWrite', s.snap.tasksSource === 'TodoWrite', String(s.snap.tasksSource));
}

// 5. 數量多時：裁決保留較新的並註明略掉幾筆、任務清單先略已完成；交接信路徑整段仍 ≤ 9800
{
  const T = [];
  for (let i = 0; i < 40; i++) {
    const qq = `第 ${i} 題：` + '很長的題目說明'.repeat(20);
    T.push(ask('m' + i, [q(qq)]), answered('m' + i, '2026-10-08T03:00:00.000Z', { [qq]: `答案 ${i}` }, {}, [q(qq)]));
  }
  for (let i = 1; i <= 50; i++) T.push(tool('c' + i, 'TaskCreate', { subject: '任務' + i }), result('c' + i, '', { task: { id: String(i), subject: `任務${i}：` + '說明'.repeat(10) } }));
  for (let i = 1; i <= 45; i++) T.push(tool('u' + i, 'TaskUpdate', { taskId: String(i), status: 'completed' }), result('u' + i, '', { success: true }));
  const s = snapOf(T);
  fs.writeFileSync(path.join(s.dir, s.stamp + '.handoff.md'), '## 未完成（完整保留）\n' + '這是很長的未完成事項。'.repeat(2000));
  let r = reinject(s);
  check('多筆：交接信路徑整段 ≤ 9800', r.stdout.length <= 9800, 'len=' + r.stdout.length);
  check('多筆：保留最新的裁決（答案 39）、註明略掉較早的', r.stdout.includes('答案 39') && !r.stdout.includes('答案 0\n') && /較早的 \d+ 筆放不下/.test(r.stdout));
  check('多筆：5 項未完成全列、略掉部分已完成並註明', [46, 47, 48, 49, 50].every(i => r.stdout.includes(`[pending] 任務${i}：`)) && /另有 \d+ 項放不下/.test(r.stdout));
  fs.unlinkSync(path.join(s.dir, s.stamp + '.handoff.md'));
  r = reinject(s);
  check('多筆：快照路徑整段 ≤ 3500＋2400＋1200', r.stdout.length <= 3500 + 2400 + 1200 + 4, 'len=' + r.stdout.length);
}

// 6. 交接信寫不出來（找不到 claude）時，裁決照樣存進快照
{
  const s = snapOf([ask('a1', [q(Q1)]), answered('a1', '2026-10-07T10:41:10.718Z', { [Q1]: '甲 (Recommended)' }, {}, [q(Q1)])],
    { COMPACT_HANDOFF_OFF: '', PATH: '', USERPROFILE: '/nonexistent-home', HOME: '/nonexistent-home' });
  check('找不到 claude：handoff 記錯誤、裁決照存', s.r.status === 0 && s.snap.handoff && s.snap.handoff.ok === false && (s.snap.decisions || []).length === 1, JSON.stringify(s.snap.handoff));
}

console.log(`\n合計 OK ${ok} / FAIL ${bad}；暫存目錄 ${root}`);
fs.rmSync(root, { recursive: true, force: true });
process.exit(bad ? 1 : 0);
