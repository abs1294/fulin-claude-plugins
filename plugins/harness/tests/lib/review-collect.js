#!/usr/bin/env node
// /harness:review 收集腳本（skills/review/scripts/review-collect.js）的誤判回歸測試。
// 來源：docs/review-collect-feedback-source-project-2026-10-13.md 的 8 處，加上紅方報告的第 9 處（實例沒有 REQUIRED_MARKERS 時 managed=[]）。
// 每一項都是在自行演進的實例上實際發生過的誤判；夾具照當時逐字紀錄的形狀合成，不放真實紀錄。
//
// 用法：node plugins/harness/tests/lib/review-collect.js   → 每項印一行 `PASS|FAIL <項目> <證據>`，有 FAIL 時 exit 1
// 在系統暫存目錄建假專案與假逐字紀錄目錄，以 --transcripts 指過去跑收集腳本（唯讀、不加 --probe），跑完刪。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.resolve(__dirname, '..', '..', 'skills', 'review', 'scripts', 'review-collect.js');
const TS = '2026-10-10T02:00:00.000Z';
let pass = 0, fail = 0;
const check = (ok, label, detail) => { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${label}｜${detail}`); };
const put = (p, t) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, t); };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-proj-'));
const tdir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-tr-'));
const fwd = root.split(path.sep).join('/');
try {
  // ── 假專案：形狀照自行演進的實例（hook 自帶標籤、CLAUDE.md 以 @ 匯入詞彙表、派工檢查沒有 REQUIRED_MARKERS）──
  put(path.join(root, '.claude', 'harness', 'README.md'), '# harness\n');
  put(path.join(root, 'CLAUDE.md'), '# 專案\n\n@CONTEXT.md\n\n## 1. 其他\n');
  put(path.join(root, 'CONTEXT.md'), '# 詞彙\n');
  put(path.join(root, '.claude', 'agents', 'qa-engineer.md'), '---\nname: qa-engineer\n---\n');
  put(path.join(root, '.claude', 'hooks', 'check-review-discipline.js'), "const ACC_AGENTS = ['qa-engineer'];\n");
  put(path.join(root, '.claude', 'hooks', 'guard-sediment-sweep.js'), "const m = ['[sediment-sweep] commit 前先做知識沉澱四問'];\n");
  // 訊息字面量裡緊接 \n（原始碼是反斜線＋n 兩個字元）
  put(path.join(root, '.claude', 'hooks', 'guard-service-startup.js'), "const m = '[服務啟動守門]\\n' + reasons.join('\\n');\n");
  // 標籤由前綴＋變數組成
  put(path.join(root, '.claude', 'hooks', 'guard-skill-required.js'), "const markOf = (skill) => '[skill-gate:' + skill + ']';\n");
  put(path.join(root, '.claude', 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Skill', hooks: [{ type: 'command', command: 'node ' + fwd + '/.claude/hooks/guard-sediment-sweep.js' }] }] } }));

  // ── 主對話逐字紀錄（行號＝陣列索引＋1，斷言用）──
  const base = { cwd: root, timestamp: TS, sessionId: 'S1' };
  const U = (content, extra) => Object.assign({ type: 'user', message: { role: 'user', content } }, base, extra || {});
  const TU = (id, name, input) => Object.assign({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } }, base);
  const TR = (id, text, isErr, extra) => U([{ type: 'tool_result', tool_use_id: id, is_error: !!isErr, content: text }], extra);
  const main = [
    /* 1 */ U('請幫我修好結案申請的單號'),
    /* 2 */ U('This session is being continued from a previous conversation that ran out of context. Summary: 使用者說「不對」要重做', { isCompactSummary: true, isVisibleInTranscriptOnly: true }),
    /* 3 */ U('Another Claude session sent a message: <agent-message from="a1">驗收結果不對，有一項沒有照派工方向</agent-message>'),
    /* 4 */ U('不對，單號要照其他 BPM 單號的做法'),
    /* 5 */ TU('a0', 'Agent', { subagent_type: 'codex:codex-rescue', model: 'sonnet', prompt: '查一下這個錯誤' }),
    /* 6 */ TR('a0', 'done\nagentId: x0'),
    /* 7 */ TU('a1', 'Agent', { subagent_type: 'qa-engineer', model: 'sonnet', prompt: '【開工前對齊】無分岔：使用者已裁定做法。\n【目標】驗收' }),
    /* 8 */ TR('a1', 'ok\nagentId: sub1', false, { toolUseResult: { agentId: 'sub1' } }),
    /* 9 */ TU('s1', 'Skill', { skill: 'git-commit', args: '--sediment 詞=無 鏈=無 QA=無 代號=無' }),
    /* 10 */ TR('s1', 'Launching skill: git-commit'),
    /* 11 */ TU('b1', 'Bash', { command: 'git stash push -m tmp' }),
    /* 12 */ TU('b2', 'Bash', { command: 'ls' }),
    /* 13 */ TR('b1', 'PreToolUse:Bash hook error: [node ' + fwd + '/.claude/hooks/guard-sediment-sweep.js]: [sediment-sweep] commit 前先做知識沉澱四問', true),
    /* 14 */ TR('b2', 'a.txt'),
    /* 15 */ TU('p1', 'PowerShell', { command: 'dotnet run' }),
    /* 16 */ TR('p1', 'PreToolUse:PowerShell hook error: [服務啟動守門]\n  - 工作目錄是 X', true),
    /* 17 */ TU('e1', 'Edit', { file_path: fwd + '/src/a.cs', old_string: 'a', new_string: 'b' }),
    /* 18 */ TR('e1', 'PreToolUse:Edit hook error: [skill-gate:backend-ddd-development] 這次要改的是內站後端的程式碼', true),
    /* 19 */ TU('g1', 'Bash', { command: 'git commit -m x' }),
    /* 20 */ TR('g1', 'PreToolUse:Bash hook error: [bash "${CLAUDE_PLUGIN_ROOT}/hooks/block-bare-git-commit.sh"]: 禁止直接 git commit', true),
    // 金鑰偵測：前四條是樣式、程式碼、手稿內容，不是值；第五條才是指令裡直接寫的密碼
    /* 21 */ TU('k1', 'Bash', { command: "grep -rn 'password=hunter22' src | head" }),
    /* 22 */ TU('k2', 'Bash', { command: 'node -e "const token=getToken(); const password=cfg.password; console.log(token)"' }),
    /* 23 */ TU('k3', 'Bash', { command: "cat > x.py <<'EOF'\napi_key = 'abcd1234efgh5678'\nEOF\npython x.py" }),
    /* 24 */ TU('k4', 'Bash', { command: 'python - <<\'PY\'\nreq.add_header("Authorization", f"Bearer {C._INTERNAL_TEST_TOKEN}")\nPY' }),
    /* 25 */ TU('k5', 'Bash', { command: 'sqlcmd -S "db.local,1433" -U tester -P S3cretValue9 -d App -Q "SELECT 1"' }),
    // Stop hook 回饋也帶 isMeta：第 3 項的過濾不可連它一起丟掉
    /* 26 */ U('Stop hook feedback:\n[sediment-sweep] 這輪改了檔，答四問', { isMeta: true }),
    // 迴圈裡的 grep：段首是 do，不可因此認不出 grep 而把樣式當值
    /* 27 */ TU('k6', 'Bash', { command: 'for r in a b; do git -C $r diff --cached | grep -cE "Bearer eyJhbGciOiJIUzI1NiJ9abc|testAccessToken"; done' }),
    // 引號裡的 $(grep …) 與「UUID.jsonl」檔名
    /* 28 */ TU('k7', 'Bash', { command: 'for r in a b; do echo "$r: $(grep -c -E \'^\\+.*(Mock|Bearer eyJhbGciOiJIUzI1NiJ9abc|x)\' s-$r.diff)"; done' }),
    /* 29 */ TU('k8', 'Bash', { command: 'f=311a0dac-c568-4e85-a1d0-3f1615d3cad4.jsonl; ls -la $f' }),
    // 重複交代（第 11 項）：平鋪直敘、沒有糾正語氣，但在兩個 session 講了三次
    /* 30 */ U('推吧，備份分支確認一致就刪除'),
    /* 31 */ U('4f479e8 備份分支確認一致就刪除，然後碳排那支也推'),
    // 第 12 項：heredoc 內文裡的「git push」是寫進檔案的文字，不是指令；真的 git push 在下一行
    /* 32 */ TU('h1', 'Bash', { command: "cat > notes.md <<'EOF'\n記得 git push 前先驗一致\nEOF" }),
    /* 33 */ TU('h2', 'Bash', { command: 'git push origin main' }),
    // 第 12 項續：node -e／python -c 的程式碼字串裡的「git push」「curl」也不是指令
    /* 34 */ TU('h3', 'Bash', { command: 'node -e "process.stdout.write(\'git push 之前先驗\'); fetch(\'curl\')"' }),
    /* 35 */ TU('h4', 'Bash', { command: "python -c 'print(\"ssh ok\")'" }),
    // 第 13 項：使用者發言裡重複出現的長金鑰（含 / + = 分隔符，像 base64）不得被切段混進片語；中文交代照常
    /* 36 */ U('這把 abcdefghijkl/mnop+qrst== 要換掉，然後備份分支確認一致就刪除'),
    // 第 14 項：跨三個 session 各講一次的交代（S1:37、S2:4、S3:1）
    /* 37 */ U('文件寫完要跑易讀性檢查'),
    // 第 11 項續：同一則發言分成兩個文字區塊、都含同一句——只能算一則（messages 5 不是 6）
    /* 38 */ U([{ type: 'text', text: '備份分支確認一致就刪除' }, { type: 'text', text: '然後再說一次：備份分支確認一致就刪除' }]),
    // 第 16 項：英文交代（S1:39、S2:5、S3:2），5 個英文詞就超過 16 字，字數上限會整段略過
    /* 39 */ U('always delete the backup branch after verifying'),
    // 第 18 項（2026-11-17 實例健檢）：常見中文糾正說法要抓到；一般敘述裡的「每次都」「重做」「不對外…」不算
    /* 40 */ U('檢視表那個不用啊，這是 etl 自動產的，你到底有沒有看啊'),
    /* 41 */ U('你給我的根本不是啊，好好研究一下上傳格式'),
    /* 42 */ U('我不是說要先讀規格嗎'),
    /* 43 */ U('客戶每次都跟我回饋匯入很困難，有沒有更好的做法'),
    /* 44 */ U('好，照新金額改，那份也通知他重做'),
    /* 45 */ U('在拿到樣本前，不對「錯在哪」下結論'),
    // 第 19 項：短變數名＝引號包住的金鑰字串（值全是假的）；heredoc 裡的也算；檔名路徑、短字串、git SHA、grep 樣式不算
    /* 46 */ TU('k9', 'Bash', { command: "K='mb_FAKE0000000000000000'; curl -s -H \"x-api-key: $K\" http://localhost:3000/api/user/current" }),
    /* 47 */ TU('k10', 'Bash', { command: 'TOK="Zq8vR2mXk4LpT9wN3bYc7HdF1sJ6gA0e"; curl -H "x-api-key: $TOK" http://localhost/api' }),
    /* 48 */ TU('k11', 'Bash', { command: "python - <<'PY'\nK='mb_FAKE1111111111111111'\nPY" }),
    /* 49 */ TU('k12', 'Bash', { command: "MSG='hello'; NAME=\"report_final_version_2026\"; SHA='3f9a1c0b7e2d4a6f8b1c3e5d7f9a0b2c4d6e8f01'; p='apbmt_export_v1.0.0/src/MappingDefinition.php'; grep -E \"K='mb_[A-Za-z0-9]{40}'\" x.log" }),
    // 第 20 項：屬性與下標的名稱也算（PowerShell $c.ApiKey、c['ApiKey']）；大小寫混的十六進位、結尾副檔名的 sk- 不算
    /* 50 */ TU('k13', 'PowerShell', { command: "$c = @{}; $c.ApiKey = 'mb_FAKE2222222222222222'; Invoke-RestMethod -Headers @{ 'x-api-key' = $c.ApiKey } http://localhost/api" }),
    /* 51 */ TU('k14', 'Bash', { command: "python - <<'PY'\nc = {}\nc['ApiKey']='mb_FAKE3333333333333333'\nPY" }),
    /* 52 */ TU('k15', 'Bash', { command: "H='3F9A1c0B7e2D4a6F8b1C3e5D7f9A0b2C4d6E8f01'; F='sk-abcdef1234567890.json'; N='npm_config_cache_dir_x'" }),
  ];
  put(path.join(tdir, 'S1.jsonl'), main.map((o) => JSON.stringify(o)).join('\n') + '\n');
  // ── 第二個 session（範圍前）：同一句交代再講一次；壓縮摘要與跨 session 訊息裡的同一句話不算 ──
  const base2 = { cwd: root, timestamp: '2026-09-20T02:00:00.000Z', sessionId: 'S2' };
  const U2 = (content, extra) => Object.assign({ type: 'user', message: { role: 'user', content } }, base2, extra || {});
  const s2 = [
    /* 1 */ U2('碳排推上去，備份分支確認一致就刪除'),
    /* 2 */ U2('這把 abcdefghijkl/mnop+qrst== 要換掉'),
    /* 3 */ U2('這把 abcdefghijkl/mnop+qrst== 要換掉喔'),
    /* 4 */ U2('文件寫完要跑易讀性檢查再交'),
    /* 5 */ U2('please always delete the backup branch after verifying it'),
    /* 2 */ U2('This session is being continued from a previous conversation. Summary: 使用者說備份分支確認一致就刪除', { isCompactSummary: true, isVisibleInTranscriptOnly: true }),
    /* 3 */ U2('Another Claude session sent a message: <agent-message>備份分支確認一致就刪除</agent-message>'),
  ];
  put(path.join(tdir, 'S2.jsonl'), s2.map((o) => JSON.stringify(o)).join('\n') + '\n');
  // ── 第三個 session：同一句交代只講一次（跨三個 session 各一次也要算到，第 14 項）──
  const base3 = { cwd: root, timestamp: '2026-08-01T02:00:00.000Z', sessionId: 'S3' };
  const U3 = (content) => JSON.stringify(Object.assign({ type: 'user', message: { role: 'user', content } }, base3));
  put(path.join(tdir, 'S3.jsonl'), [U3('文件寫完要跑易讀性檢查喔'), U3('always delete the backup branch after verifying, thanks')].join('\n') + '\n');

  // ── subagent 1：qa-engineer，舊式注入（只渲染 CLAUDE.md，詞彙表靠 @ 匯入）；主回報有已讀清單，之後再補一則短訊息 ──
  const sb = { cwd: root, timestamp: TS, isSidechain: true, agentId: 'sub1' };
  const win = root.split('/').join('\\');
  const sub1 = [
    Object.assign({ type: 'attachment', attachment: { type: 'text' }, rendered: [{ content: 'Codebase and user instructions are shown below.\n\nContents of ' + win + path.sep + 'CLAUDE.md (project instructions, checked into the codebase):\n\n# 專案' }] }, sb),
    Object.assign({ type: 'user', message: { role: 'user', content: '【開工前對齊】無分岔' } }, sb),
    Object.assign({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: path.join(root, 'tests', 'Project_Detail', 'PROJECT.md') } }] } }, sb),
    Object.assign({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'r1', content: '# QA' }] } }, sb),
    Object.assign({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'm1', name: 'SendMessage', input: { to: 'team-lead', message: '驗收 PASS。\n已讀清單：CLAUDE.md、CONTEXT.md、PROJECT.md' } }] } }, sb),
    Object.assign({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'm1', content: 'sent' }] } }, sb),
    Object.assign({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'm2', name: 'SendMessage', input: { to: 'team-lead', message: '補充：DOM 快照路徑在 scratchpad。' } }] } }, sb),
    Object.assign({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'm2', content: 'sent' }] } }, sb),
    Object.assign({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '完成。' }] } }, sb),
  ];
  put(path.join(tdir, 'S1', 'subagents', 'agent-sub1.jsonl'), sub1.map((o) => JSON.stringify(o)).join('\n') + '\n');
  put(path.join(tdir, 'S1', 'subagents', 'agent-sub1.meta.json'), JSON.stringify({ agentType: 'qa-engineer', model: 'sonnet' }));
  // ── subagent 2：新式注入（attachment.files 逐檔列出 CLAUDE.md 與 CONTEXT.md）──
  const sub2 = [
    Object.assign({ type: 'attachment', attachment: { type: 'instructions', files: [{ path: path.join(root, 'CLAUDE.md'), type: 'Project', content: '# 專案' }, { path: path.join(root, 'CONTEXT.md'), type: 'Project', content: '# 詞彙' }] } }, sb, { agentId: 'sub2' }),
    Object.assign({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '查完了。' }] } }, sb, { agentId: 'sub2' }),
  ];
  put(path.join(tdir, 'S1', 'subagents', 'agent-sub2.jsonl'), sub2.map((o) => JSON.stringify(o)).join('\n') + '\n');
  put(path.join(tdir, 'S1', 'subagents', 'agent-sub2.meta.json'), JSON.stringify({ agentType: 'general-purpose', model: 'sonnet' }));

  // ── 審查評測集的 headless 審查 session（review-eval.js 起的 claude -p）：三個，entrypoint sdk-cli，第一則提問是固定 prompt ──
  //    E1 另派一次 qa-engineer（不可進 B 的派工統計）。對照組：N1＝entrypoint cli、使用者在互動 session 貼同一句（照算）；
  //    N2＝sdk-cli 但提問是別的（goal2 之類的 headless 子程序，照算）
  const evalPrompt = (n) => '請審查這份改動：' + fwd + '/.claude/review-evals/cases/' + n + '/case.diff（請先 cat 讀取）。本任務由你親自執行，不得再轉派給其他 agent。\n需要上下文時，改動後的檔案全文在 ' + fwd + '/.claude/review-evals/cases/' + n + '/context/ 底下。';
  const sess = (sid, entrypoint, rowsIn) => put(path.join(tdir, sid + '.jsonl'), rowsIn.map((o) => JSON.stringify(Object.assign({ cwd: root, timestamp: TS, sessionId: sid, entrypoint }, o))).join('\n') + '\n');
  const UU = (content) => ({ type: 'user', message: { role: 'user', content } });
  ['bug-a', 'bug-b', 'bug-c'].forEach((n, i) => {
    const rowsE = [{ type: 'agent-setting', agentSetting: 'code-reviewer' }, UU(evalPrompt(n))];
    if (i === 0) rowsE.push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'ea', name: 'Agent', input: { subagent_type: 'qa-engineer', model: 'sonnet', prompt: '評測內的派工' } }] } });
    sess('E' + (i + 1), 'sdk-cli', rowsE);
  });
  sess('N1', 'cli', [UU(evalPrompt('bug-a')), UU('這是我手貼的審查請求，請先確認再回覆')]);
  sess('N2', 'sdk-cli', [UU('整理今天的待辦清單')]);
  // ── 健檢自己在背景起的 /doctor、/claude-api prompt-audit（claude -p）：略過；對照組 H3＝使用者在互動 session 親手打 /doctor（照算）
  //    逐字紀錄的寫法照 2026-11-19 實測（content 是字串，<command-message> 在前）
  const slash = (name, a) => '<command-message>' + name + '</command-message>\n<command-name>/' + name + '</command-name>' + (a ? '\n<command-args>' + a + '</command-args>' : '');
  sess('H1', 'sdk-cli', [UU(slash('doctor'))]);
  sess('H2', 'sdk-cli', [UU(slash('claude-api', 'prompt-audit'))]);
  sess('H3', 'cli', [UU(slash('doctor'))]);

  const outFile = path.join(tdir, 'out.json');
  const r = spawnSync(process.execPath, [SCRIPT, root, '--since', '2026-10-01', '--transcripts', tdir, '--out', outFile], { encoding: 'utf8' });
  if (r.status !== 0 || !fs.existsSync(outFile)) { check(false, '收集腳本跑得完', 'exit ' + r.status + ' ' + String(r.stderr).slice(-800)); process.exit(1); }
  const j = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  const at = (n) => 'S1.jsonl:' + n;
  const show = (v) => JSON.stringify(v);

  // 1 標籤：實例 hook 的擋下都要認得；plugin 的 hook 要標成不是本專案，並點名哪支
  const tags = j.C.denialsByTag || {};
  const want1 = { 'sediment-sweep': 1, '服務啟動守門': 1, 'skill-gate:backend-ddd-development': 1 };
  const own = Object.entries(want1).every(([k, n]) => tags[k] === n);
  const plug = Object.keys(tags).filter((k) => !want1[k]);
  check(own && plug.length === 1 && /block-bare-git-commit\.sh/.test(plug[0]), '1 C denials 標籤', '實得 ' + show(tags));
  // 2 沉澱：Skill args 裡的 --sediment 表態要算
  const sed = j.E.sedimentAnswers || [];
  check(sed.length === 1 && sed[0].at === at(9) && sed[0]['詞'] === '無', '2 E 沉澱回答', '實得 ' + show(sed));
  // 3 糾正：壓縮摘要與跨 session 的 agent 回報不算，只算使用者自己打的
  const cor = (j.G.corrections || []).map((c) => c.at);
  check(show(cor) === show([at(4), at(40), at(41), at(42)]), '3／18 G 糾正偵測（含「到底有沒有」「根本不是」「我不是說」；「每次都」「重做」「不對「…」」不算）', '實得 ' + show(j.G.corrections));
  check((j.E.stopFeedback || []).length === 1 && j.E.stopFeedback[0].at === at(26), '3 附帶：Stop 回饋（isMeta）照算', '實得 ' + show(j.E.stopFeedback));
  // 4 金鑰：grep 樣式、node -e 程式碼、heredoc 內容、{…} 佔位都不算；只剩 sqlcmd -P 那條
  const sec = (j.F.secretsInCommands || []).map((s) => s.at);
  check(show(sec) === show([at(25), at(46), at(47), at(48), at(50), at(51)]), '4／19 F secretsInCommands（含 K=\'mb_…\'、TOK="高熵"、heredoc 裡的 K=；路徑、短字串、SHA、grep 樣式不算）', '實得 ' + show(j.F.secretsInCommands));
  check(!/mb_FAKE|Zq8vR2mXk4/.test(fs.readFileSync(outFile, 'utf8')), '19 輸出不含假金鑰原文', '');
  // 20 找與遮是同一份判準（key-shape.js）：凡是找得到的寫法，值都會被遮；遮值規則真的接到它（拿掉就轉紅）
  const KS = require(path.join(path.dirname(SCRIPT), 'key-shape.js'));
  const forms = ["K='mb_FAKE0000000000000000'", "$c.ApiKey = 'mb_FAKE2222222222222222'", "c['ApiKey']='mb_FAKE3333333333333333'", 'TOK="Zq8vR2mXk4LpT9wN3bYc7HdF1sJ6gA0e"', "a_name_longer_than_forty_one_characters_is_still_a_name_x='mb_FAKE4444444444444444'"];
  const bad = forms.filter((x) => { const m = x.match(KS.ASSIGN); return !(m && KS.assignHasKey(m[0]) && !/mb_FAKE|Zq8vR2mXk4/.test(KS.redactAssign(x))); });
  check(bad.length === 0, '20 找得到的寫法，值一定遮得掉（同一份判準）', '沒對上：' + show(bad));
  const notKeys = ['3F9A1c0B7e2D4a6F8b1C3e5D7f9A0b2C4d6E8f01', 'sk-abcdef1234567890.json', 'npm_config_cache_dir_x', 'report_final_version_2026', 'apbmt_export_v1.0.0/src/MappingDefinition.php'].filter((v) => KS.looksLikeKey(v));
  check(notKeys.length === 0, '20 十六進位（大小寫混也一樣）、副檔名結尾、設定名稱、路徑不算金鑰', '被當成金鑰：' + show(notKeys));
  const src = fs.readFileSync(SCRIPT, 'utf8');
  check(/\[KeyShape\.ASSIGN_REDACT,/.test(src) && /\['變數=金鑰字串', KeyShape\.ASSIGN\]/.test(src), '20 review-collect 的遮值與偵測都接到 key-shape.js', '');
  // 5 必讀：@CONTEXT.md 匯入（舊式只渲染 CLAUDE.md）與新式逐檔注入，都算自動載入
  const subs = j.D.subagents || [];
  const g1 = (subs.find((s) => /agent-sub1/.test(s.file)) || {}).requiredReads || {};
  const g2 = (subs.find((s) => /agent-sub2/.test(s.file)) || {}).requiredReads || {};
  check((j.D.missingReads || []).length === 0 && g1['GLOSSARY.md/CONTEXT.md'] === '自動載入' && g2['GLOSSARY.md/CONTEXT.md'] === '自動載入', '5 D 必讀', 'missingReads ' + show(j.D.missingReads) + '；sub1 ' + show(g1) + '；sub2 ' + show(g2));
  // 6 首次派工：非專案 agent（codex-rescue）不算首次；派工 prompt 內的「無分岔」表態算對齊
  const fd = j.B.firstDispatchAligned || [];
  check(fd.length === 1 && fd[0].aligned === true && fd[0].at === at(7), '6 B firstDispatchAligned', '實得 ' + show(fd));
  // 7 出處：擋下要對到被擋的那次 tool_use（第 11 行），不是 tool_result 所在列
  const d7 = (j.C.denials || []).find((d) => d.toolUseId === 'b1') || {};
  check(d7.at === at(11), '7 C denials 出處', '實得 ' + show(d7));
  // 8 已讀清單：任一則 SendMessage 有就算，補交的短訊息不蓋掉
  check((j.D.reportsWithoutReadList || []).length === 0, '8 D reportsWithoutReadList', '實得 ' + show(j.D.reportsWithoutReadList));
  // 9 專案 agent：沒有 REQUIRED_MARKERS 時以 .claude/agents 的角色為準
  check(j.C.managedDispatch === 1, '9 C managedDispatch（managed 名單）', '實得 ' + j.C.managedDispatch + '；摘要「' + (j.summary || {}).dispatch + '」');
  // 10 範本閘的必讀開關（2026-10-19 紅藍對抗 R4B-09）：REQUIRED_MARKERS 表裡 `when: REQUIRE_GLOSSARY_READ` 的那條，開關 false 時不算必讀、true 時算。
  //    同一份逐字紀錄、CLAUDE.md 拿掉 @ 匯入（否則兩種都判自動載入），只換 hook 的開關值跑兩次
  const tableHook = (flag) => "const REQUIRE_GLOSSARY_READ = " + flag + ";\nconst REQUIRED_MARKERS = {\n  '*': [\n    { name: '驗收條件', pattern: '【驗收條件】', hint: 'x' },\n"
    + "    { name: '必讀：專案用語', pattern: 'GLOSSARY\\\\.md|CONTEXT\\\\.md', hint: 'x', when: REQUIRE_GLOSSARY_READ },\n  ],\n  'qa-engineer': [\n    { name: '必讀：測試知識', pattern: 'tests[\\\\\\\\/]Project_Detail[\\\\\\\\/][^\\\\s）)]+\\\\.md', hint: 'x' },\n  ],\n};\n";
  put(path.join(root, 'CLAUDE.md'), '# 專案\n\n## 1. 其他\n');
  const runWith = (flag) => {
    put(path.join(root, '.claude', 'hooks', 'check-review-discipline.js'), tableHook(flag));
    const o = path.join(tdir, 'out-' + flag + '.json');
    const rr = spawnSync(process.execPath, [SCRIPT, root, '--since', '2026-10-01', '--transcripts', tdir, '--out', o], { encoding: 'utf8' });
    if (rr.status !== 0 || !fs.existsSync(o)) return { err: 'exit ' + rr.status + ' ' + String(rr.stderr).slice(-300) };
    const jj = JSON.parse(fs.readFileSync(o, 'utf8'));
    const g = ((jj.D.subagents || []).find((s) => /agent-sub1/.test(s.file)) || {}).requiredReads || {};
    return { reads: g, missing: (jj.D.missingReads || []).flatMap((m) => m.missing || []) };
  };
  // 11 重複交代：沒有糾正語氣的同一句交代，跨兩個 session 三則發言要被列出來（全部歷史；S2 在 --since 之前，inRange 只算 S1 的兩則）；
  //    壓縮摘要與跨 session 訊息裡的同一句不算；糾正詞表仍然不該命中這幾句
  const rep = (j.G.repeatedInstructions || []).filter((x) => /備份分支確認一致就刪/.test(x.phrase));
  const top = rep[0] || {};
  check(rep.length >= 1 && top.messages === 5 && top.sessions === 2 && top.inRange === 4 && (top.at || []).includes(at(30)) && (top.at || []).includes(at(38)) && (top.at || []).includes('S2.jsonl:1'),
    '11 G repeatedInstructions（跨 session 重複交代；S1:38 兩個文字區塊只算一則）', '實得 ' + show(rep.slice(0, 2)) + '；糾正 ' + show(cor));
  // 12 風險指令：heredoc 內文、node -e／python -c 程式碼字串裡的「git push」「curl」「ssh」不算，真的 git push 算
  const risky = (j.F.riskyLookingCommands || []).map((x) => x.at);
  check(!risky.includes(at(32)) && !risky.includes(at(34)) && !risky.includes(at(35)) && risky.includes(at(33)), '12 F riskyLookingCommands（heredoc 與程式碼字串不算）', '實得 ' + show(risky));
  // 13 片語不得含金鑰片段（S1:36、S2:2、S2:3 三則都有同一把帶 / + = 的「金鑰」，跨兩個 session；
  //    舊切法會切出 abcdefghijkl／mnop／qrst 三個純字母詞，「把abcdefghijkl要換掉」剛好 16 字、三則共有，會被列出）
  const leaked = (j.G.repeatedInstructions || []).filter((x) => /abcdefghij|mnop|qrst/.test(x.phrase));
  check(leaked.length === 0, '13 G repeatedInstructions 不抄金鑰片段', '實得 ' + show(leaked));
  // 14 跨三個 session 各講一次（S1:37、S2:4、S3:1）也要列出——草圖計數不會因為「只出現一次」先丟掉
  const once = (j.G.repeatedInstructions || []).find((x) => /寫完要跑易讀性/.test(x.phrase));
  check(!!once && once.messages === 3 && once.sessions === 3, '14 G repeatedInstructions（跨三個 session 各一次）', '實得 ' + show(once));
  // 16 英文交代（S1:39、S2:5、S3:2）：英文詞之間補空白、不設字數上限、指示語認英文
  const en = (j.G.repeatedInstructions || []).find((x) => /always delete the backup branch/.test(x.phrase));
  check(!!en && en.messages === 3 && en.sessions === 3, '16 G repeatedInstructions（英文交代）', '實得 ' + show(en) + '；全部 ' + show((j.G.repeatedInstructions || []).map((x) => x.phrase)));
  // 17 審查評測集的 headless session：略過 3 個（notes 寫數量與依據、點名編號），N1（cli）與 N2（非評測 prompt）照算；
  //    評測的固定 prompt 不進重複交代，評測內的派工不進 B
  const evalNote = (j.notes || []).find((s) => /審查評測集/.test(s)) || '';
  check(/session 3 個/.test(evalNote) && /sdk-cli/.test(evalNote) && /E1/.test(evalNote) && /E2/.test(evalNote) && /E3/.test(evalNote) && !/N1|N2/.test(evalNote),
    '17 notes 記略過評測 session 的數量、依據與編號', '實得 ' + show(evalNote));
  check(j.summary.sessions === 4 && j.C.managedDispatch === 1,
    '17 評測 session 不進 A 的 session 數與 B 的派工；N1／N2／H3 照算（S1+N1+N2+H3＝4）', 'sessions ' + j.summary.sessions + '；managedDispatch ' + j.C.managedDispatch);
  // 21 健檢背景跑的 /doctor、/claude-api prompt-audit 略過並點名；使用者親手打的 /doctor（cli）不略過
  const hNotes = (j.notes || []).filter((s) => /健檢自己在背景跑/.test(s));
  check(hNotes.length === 2 && hNotes.some((s) => /\/doctor session：H1/.test(s)) && hNotes.some((s) => /\/claude-api session：H2/.test(s)) && !hNotes.some((s) => /H3/.test(s)),
    '21 健檢背景跑的 /doctor、prompt-audit 略過；親手打的 /doctor 照算', '實得 ' + show(hNotes));
  const evalGrams = (j.G.repeatedInstructions || []).filter((x) => /審查這份改動|請先cat|不得再轉派|親自執行/.test(x.phrase) || (x.at || []).some((a) => /^E\d/.test(a)));
  check(evalGrams.length === 0, '17 G repeatedInstructions 沒有評測 prompt 的片語', '實得 ' + show(evalGrams));
  const incl = path.join(tdir, 'out-incl.json');
  const ri = spawnSync(process.execPath, [SCRIPT, root, '--since', '2026-10-01', '--transcripts', tdir, '--out', incl, '--include-eval'], { encoding: 'utf8' });
  const ji = ri.status === 0 && fs.existsSync(incl) ? JSON.parse(fs.readFileSync(incl, 'utf8')) : null;
  check(!!ji && ji.summary.sessions === 7 && !(ji.notes || []).some((s) => /審查評測集/.test(s)), '17 --include-eval 時評測 session 照算（7 個）、不寫略過 note', ji ? 'sessions ' + ji.summary.sessions : 'exit ' + ri.status);
  // 15 候選上限：REVIEW_COLLECT_CAND_CAP=1 時只收第一條、notes 說明、不當掉
  const out2 = path.join(tdir, 'out2.json');
  const r2 = spawnSync(process.execPath, [SCRIPT, root, '--since', '2026-10-01', '--transcripts', tdir, '--out', out2], { encoding: 'utf8', env: Object.assign({}, process.env, { REVIEW_COLLECT_CAND_CAP: '1' }) });
  const j2 = r2.status === 0 && fs.existsSync(out2) ? JSON.parse(fs.readFileSync(out2, 'utf8')) : null;
  check(!!j2 && (j2.G.repeatedInstructions || []).length <= 1 && (j2.notes || []).some((s) => /候選片語超過 1 條/.test(s)), '15 G 候選片語上限（notes 說明、不當掉）', 'exit ' + r2.status + ' ' + (j2 ? show(j2.notes) : String(r2.stderr).slice(-300)));
  const off = runWith(false), on = runWith(true);
  check(!off.err && !on.err && !('GLOSSARY.md/CONTEXT.md' in off.reads) && !off.missing.includes('GLOSSARY.md/CONTEXT.md')
    && ('GLOSSARY.md/CONTEXT.md' in on.reads) && on.missing.includes('GLOSSARY.md/CONTEXT.md'),
    '10 D 必讀開關 when（false 不算必讀、true 算）', 'false→' + show(off) + '；true→' + show(on));
} finally {
  for (const d of [root, tdir]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
}
console.log(`合計 PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
