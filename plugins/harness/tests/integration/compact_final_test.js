// 實例最終定版新增行為的整合測試（不呼叫 claude CLI）
// 用法：node compact_final_test.js   （TPL_DIR 可指到別的目錄做對照組）
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const TPL = process.env.TPL_DIR || path.resolve(__dirname, '..', '..', 'hooks', 'templates');
let ok = 0, bad = 0;
function check(name, cond, extra) { if (cond) { ok++; console.log('OK  ', name); } else { bad++; console.log('FAIL', name, extra || ''); } }
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'compactfinal-'));
const hooks = path.join(root, '.claude', 'hooks');
fs.mkdirSync(hooks, { recursive: true });
for (const f of ['compact-snapshot.js', 'compact-handoff.js', 'compact-reinject.js', 'compact-summary-log.js', 'resume-stale-reminder.js'])
  if (fs.existsSync(path.join(TPL, f))) fs.copyFileSync(path.join(TPL, f), path.join(hooks, f));
function run(hook, payload, env) {
  return spawnSync(process.execPath, [path.join(hooks, hook)], { input: JSON.stringify(payload), cwd: root, encoding: 'utf8',
    env: Object.assign({}, process.env, { COMPACT_HANDOFF_OFF: '1' }, env || {}), timeout: 60000 });
}
const iso = (ms) => new Date(Date.now() - ms).toISOString();
const w = (name, arr) => { const p = path.join(root, name); fs.writeFileSync(p, arr.map(o => JSON.stringify(o)).join('\n') + '\n'); return p; };
const sid = 's1';
const snapDir = path.join(root, sid, 'compact-snapshots');
const readSnap = () => { const st = fs.readFileSync(path.join(snapDir, 'latest.txt'), 'utf8').trim(); return JSON.parse(fs.readFileSync(path.join(snapDir, st + '.json'), 'utf8')); };

// 1. 快照認得三種背景任務，以及完成判定
{
  const tp = w('bg.jsonl', [
    { type: 'user', message: { role: 'user', content: '開始' } },
    { type: 'assistant', message: { role: 'assistant', content: [
      { type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'codex exec', run_in_background: true, description: '背景跑 Codex 審查' } },
      { type: 'tool_use', id: 'b2', name: 'Bash', input: { command: 'npm test', run_in_background: true, description: '背景跑測試（已完成）' } },
      { type: 'tool_use', id: 'a1', name: 'Agent', input: { description: '具名 reviewer', name: 'rev' } },
      { type: 'tool_use', id: 'a2', name: 'Agent', input: { description: '具名 qa（已 idle）', name: 'qa' } },
      { type: 'tool_use', id: 'a3', name: 'Agent', input: { description: '剛派出的 agent' } },
    ] } },
    { type: 'user', message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'b1', content: 'Command running in background with ID: bgaaa111' },
      { type: 'tool_result', tool_use_id: 'b2', content: 'Command running in background with ID: bgbbb222' },
      { type: 'tool_result', tool_use_id: 'a1', content: 'Spawned successfully. agent_id: rev@sess-1' },
      { type: 'tool_result', tool_use_id: 'a2', content: 'Spawned successfully. agent_id: qa@sess-1' },
    ] } },
    { type: 'user', message: { role: 'user', content: '<task-notification><task-id>bgbbb222</task-id><summary>done</summary></task-notification>' } },
    { type: 'user', message: { role: 'user', content: '<teammate-message teammate_id="qa">{"type":"idle_notification"}</teammate-message>' } },
  ]);
  // teammate-message 的引號在 transcript 原始行裡是 \"，上面用 \\" 模擬 JSON 字串內的跳脫
  run('compact-snapshot.js', { session_id: sid, transcript_path: tp, hook_event_name: 'PreCompact', trigger: 'auto' });
  let snap = {}; try { snap = readSnap(); } catch {}
  const ids = (snap.running || []).map(r => r.id + '|' + r.desc);
  check('背景 Bash（run_in_background）未完成 → 列為執行中', ids.some(s => s.startsWith('bgaaa111|')), JSON.stringify(ids));
  check('背景 Bash 已收到 task-notification → 不列', !ids.some(s => s.startsWith('bgbbb222|')), JSON.stringify(ids));
  check('具名 agent（Spawned successfully）未 idle → 列為執行中', ids.some(s => s.startsWith('rev|')), JSON.stringify(ids));
  check('具名 agent 已 idle → 不列', !ids.some(s => s.startsWith('qa|')), JSON.stringify(ids));
  check('剛派出還沒有 tool_result 的呼叫 → 列為執行中並註明', ids.some(s => s.startsWith('a3|') && s.includes('剛派出')), JSON.stringify(ids));

  // 2. 走交接信路徑時，reinject 把背景任務清單附在信後
  fs.writeFileSync(path.join(snapDir, snap.stamp + '.handoff.md'), '## 未完成（完整保留）\n1. 等審查\n');
  const r = run('compact-reinject.js', { session_id: sid, transcript_path: tp, hook_event_name: 'SessionStart', source: 'compact' });
  check('交接信路徑：附上背景任務清單', r.stdout.includes('壓縮前寫好的交接信') && r.stdout.includes('bgaaa111') && r.stdout.includes('rev'), r.stdout.slice(0, 160));
}

// 3. 關鍵值防污染與新樣式（buildDigest，不呼叫模型）
{
  const tp = w('keys.jsonl', [
    { type: 'user', message: { role: 'user', content: '跑測試' } },
    { type: 'assistant', message: { role: 'assistant', content: [
      { type: 'tool_use', id: 'k1', name: 'Bash', input: { command: 'node app.js' } },
      { type: 'tool_use', id: 'k2', name: 'Bash', input: { command: 'cat ~/.claude/projects/x/other.handoff.md | head' } },
      { type: 'tool_use', id: 'k3', name: 'Bash', input: { command: 'dotnet build' } },
      { type: 'tool_use', id: 'k4', name: 'Bash', input: { command: 'curl -s api' } },
    ] } },
    { type: 'user', message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'k1', content: 'Error: ENOENT: no such file\nconsole.log("5 passed")\n報告寫的 8 passed in 1.2s' },
      { type: 'tool_result', tool_use_id: 'k2', content: '965 passed in 12.3s' },
      { type: 'tool_result', tool_use_id: 'k3', content: 'Foo.cs(3,1): error CS0103: 名稱不存在 [C:\\proj\\Foo.csproj]' },
      { type: 'tool_result', tool_use_id: 'k4', content: '{"code":"0000","status":404}\n{"status":2000}' },
    ] } },
  ]);
  let vals = null;
  try { delete require.cache[require.resolve(path.join(hooks, 'compact-handoff.js'))]; vals = require(path.join(hooks, 'compact-handoff.js')).buildDigest(tp).keys.map(k => k.value); } catch (e) { vals = []; }
  check('裸 Error: ENOENT 會抽到', vals.some(v => v.startsWith('Error: ENOENT')), JSON.stringify(vals));
  check('引號裡的測試數字（程式字串）不抽', !vals.some(v => v.includes('5 passed')), JSON.stringify(vals));
  check('測試數字所在行夾中文（人寫的敘述）不抽', !vals.some(v => v.includes('8 passed')), JSON.stringify(vals));
  check('讀別的 session 交接信的輸出（meta 來源）不抽', !vals.some(v => v.includes('965 passed')), JSON.stringify(vals));
  check('msbuild 行尾的 [*.csproj] 被剝掉', vals.some(v => v.includes('error CS0103') && !v.includes('.csproj')), JSON.stringify(vals));
  check('HTTP status 後接第 4 位數字（2000）不被截成 200 抽入', !vals.some(v => /status":200$/.test(v)), JSON.stringify(vals));
  check('HTTP 只抽 status，"code":"0000" 不抽', vals.some(v => v.includes('"status":404')) && !vals.some(v => v.includes('0000')), JSON.stringify(vals));
}

// 4. 短值比對只放寬空白與大小寫（抽出範本實際的分類段對假資料跑）
{
  const src = fs.readFileSync(path.join(hooks, 'compact-handoff.js'), 'utf8');
  const a0 = src.indexOf('    const notVerbatim = '), a1 = src.indexOf('    return { ok: true, ms,', a0);
  let r = null;
  try { r = new Function('keys', 'body', 'claimed', src.slice(a0, a1) + '; return { mangled, missing };')(
    [{ value: 'Exit code 2' }, { value: 'Exit code 1' }], '結果 exit  CODE 2；另外 exitcode1 是檔名', [1, 2]); } catch (e) { r = null; }
  check('短值：只差空白大小寫 → 判改寫', r && r.mangled.includes(1), JSON.stringify(r));
  check('短值：去標點後碰巧拼得出（exitcode1）→ 判缺漏，不算改寫', r && r.missing.includes(2), JSON.stringify(r));
}

// 5. compact-handoff.js 壞掉時：快照照寫、resume 靜默退出
{
  fs.writeFileSync(path.join(hooks, 'compact-handoff.js'), 'throw new Error("broken");');
  const tp = w('broken.jsonl', [{ type: 'user', timestamp: iso(5 * 3600000), message: { role: 'user', content: '最後指示' } }]);
  const r1 = run('compact-snapshot.js', { session_id: 's2', transcript_path: tp, hook_event_name: 'PreCompact', trigger: 'auto' }, { COMPACT_HANDOFF_OFF: '' });
  let snap2 = null; try { const d = path.join(root, 's2', 'compact-snapshots'); const st = fs.readFileSync(path.join(d, 'latest.txt'), 'utf8').trim(); snap2 = JSON.parse(fs.readFileSync(path.join(d, st + '.json'), 'utf8')); } catch {}
  check('handoff 模組壞掉：快照照寫、prompts 仍有使用者原話、exit 0', r1.status === 0 && snap2 && (snap2.prompts || []).includes('最後指示'), JSON.stringify({ status: r1.status, stderr: r1.stderr.slice(0, 120), snap2 }));
  const r2 = run('resume-stale-reminder.js', { session_id: 's2', transcript_path: tp, hook_event_name: 'SessionStart', source: 'resume' });
  check('handoff 模組壞掉：resume 靜默 exit 0', r2.status === 0 && r2.stdout === '', JSON.stringify({ status: r2.status, out: r2.stdout.slice(0, 80) }));
}

console.log(`\n合計 OK ${ok} / FAIL ${bad}`);
fs.rmSync(root, { recursive: true, force: true });
process.exit(bad ? 1 : 0);
