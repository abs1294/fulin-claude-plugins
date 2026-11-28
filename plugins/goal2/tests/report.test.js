#!/usr/bin/env node
// goal2 0.8.0：獨立啟動（--start）、等待（--wait）、只回報一次（等待／看板／原對話 hook 搶 reported.json）。
// Run: node plugins/goal2/tests/report.test.js
//
// 用假引擎（tests/fixtures/fake-claude.js）與假的使用者目錄（USERPROFILE／HOME／APPDATA／LOCALAPPDATA 指到暫存目錄），
// 不碰真實的 ~/.claude/goal2/runs。不開視窗。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const GOAL = path.join(ROOT, 'skills', 'goal', 'goal.js');
const HOOK = path.join(ROOT, 'hooks', 'pending-report.js');
const FAKE = path.join(__dirname, 'fixtures', 'fake-claude.js');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'g2r-'));
const WORK = path.join(HOME, 'work'); fs.mkdirSync(WORK);
for (const k of ['USERPROFILE', 'HOME']) process.env[k] = HOME;
process.env.APPDATA = path.join(HOME, 'AppData', 'Roaming'); process.env.LOCALAPPDATA = path.join(HOME, 'AppData', 'Local');
process.env.GOAL2_CLAUDE_BIN = FAKE;
delete process.env.CLAUDE_PROJECT_DIR;
const E = require('../lib/engine.js');   // 環境變數設好後才載入：RUNS_DIR 由 os.homedir() 決定

let pass = 0, fail = 0;
const check = (ok, label, detail) => { ok ? pass++ : fail++; console.log('  ' + (ok ? 'PASS' : '** FAIL **').padEnd(12) + label + (ok ? '' : '  -> ' + detail)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const goal = (args, env = {}) => {
  const r = spawnSync(process.execPath, [GOAL, ...args], { encoding: 'utf8', env: { ...process.env, ...env }, windowsHide: true });
  let j = null; try { j = JSON.parse(r.stdout); } catch (_) {}
  return { code: r.status, j, out: r.stdout, err: r.stderr };
};
const prepare = (sid) => {
  const pf = path.join(HOME, `task-${Math.random().toString(16).slice(2)}.md`);
  fs.writeFileSync(pf, '## 任務\n在 work 目錄建立 a.txt。\n\n## 脈絡與約束\n測試用。\n');
  const r = goal(['--prompt-file', pf, '--goal', 'work/a.txt 存在', '--cwd', WORK], sid ? { CLAUDE_CODE_SESSION_ID: sid } : { CLAUDE_CODE_SESSION_ID: '' });
  if (!r.j || !r.j.ok) throw new Error('prepare 失敗：' + r.out + r.err);
  return r.j;
};
const age = (rd, ms) => { const m = E.readMeta(rd); E.writeMeta(rd, { ...m, endedAt: new Date(Date.now() - ms).toISOString() }); };
const hook = (sid, event = 'UserPromptSubmit') => {
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ session_id: sid, hook_event_name: event }), encoding: 'utf8', env: process.env, windowsHide: true });
  let j = null; try { j = JSON.parse(r.stdout); } catch (_) {}
  return { code: r.status, j, out: r.stdout };
};

(async () => {
  console.log('goal2 report tests  (HOME=' + HOME + ')');

  // ── 1. 準備：記下起它的對話、指令改成 --start / --wait ──
  const p1 = prepare('parent-A');
  const m1 = E.readMeta(p1.run_dir);
  check(m1.parentSessionId === 'parent-A', '準備時記下起它的對話 id', JSON.stringify(m1));
  check(/--start "/.test(p1.run_command) && /--wait "/.test(p1.wait_command || ''), 'run_command 是 --start、另有 wait_command', p1.run_command + ' | ' + p1.wait_command);

  // ── 2. --start：立刻返回、runner 是獨立程序、啟動者結束後仍在跑 ──
  const t0 = Date.now();
  const s1 = goal(['--start', p1.run_dir], { FAKE_SLEEP_MS: '8000' });
  check(s1.code === 0 && s1.j && s1.j.mode === 'started' && s1.j.status === 'running', '--start 回 started／running', s1.out + s1.err);
  check(Date.now() - t0 < 15000, '--start 不等引擎跑完就返回（' + (Date.now() - t0) + ' ms）', '');
  check(s1.j && alive(s1.j.runner_pid), '啟動者結束後 runner 仍在跑', s1.j && s1.j.runner_pid);
  const again = goal(['--start', p1.run_dir]);
  check(again.code !== 0 && /已啟動過/.test(again.out), '同一個 run 不能 --start 兩次', again.out);

  // ── 3. --wait：先逾時回「還在跑」，再等一次拿到結果並搶到回報權 ──
  const w0 = await E.waitRun(p1.run_dir, { minutes: 0.03, pollMs: 300 });   // 約 2 秒
  check(w0.mode === 'waiting' && w0.still_running === true, '等待逾時回 waiting／still_running', JSON.stringify(w0).slice(0, 300));
  check(fs.existsSync(path.join(p1.run_dir, E.WAIT_FILE)), '等待中寫心跳 waiting.json', '');
  const w1 = await E.waitRun(p1.run_dir, { minutes: 1, pollMs: 300 });
  check(w1.mode === 'ran' && w1.report === 'yours', '引擎結束：等待拿到結果、回報權歸它', JSON.stringify(w1).slice(0, 300));
  check(w1.result_text === '做完了（假引擎）' && w1.status === 'unverified', '結果是 result.json 的內容（假引擎沒有 transcript → unverified）', w1.status + ' / ' + w1.result_text);
  check(!alive(s1.j.runner_pid), 'runner 收尾後結束', s1.j.runner_pid);
  const w2 = await E.waitRun(p1.run_dir, { minutes: 1, pollMs: 300 });
  check(w2.mode === 'ran' && w2.report === 'already', '第二次等待：已有人回報、不要重複', JSON.stringify(w2).slice(0, 200));
  age(p1.run_dir, 10 * 60000);
  check(E.pendingReports({ sessionId: 'parent-A' }).length === 0, '等待接走的 run 不會再被列成待補報', '');

  // ── 4. 沒人等：心跳／寬限期內不補報，過了才補；hook 只補一次、只補給起它的對話 ──
  const p2 = prepare('parent-B');
  const s2 = goal(['--start', p2.run_dir], { FAKE_SLEEP_MS: '500' });
  check(s2.j && s2.j.ok, '第二個 run 啟動', s2.out);
  for (let i = 0; i < 60 && !fs.existsSync(path.join(p2.run_dir, 'result.json')); i++) await sleep(250);
  check(fs.existsSync(path.join(p2.run_dir, 'result.json')), '沒人等也會跑完、寫 result.json', '');
  check(E.pendingReports({ sessionId: 'parent-B' }).length === 0, '剛結束（寬限期內）不補報', '');
  age(p2.run_dir, 2 * 60000);
  fs.writeFileSync(path.join(p2.run_dir, E.WAIT_FILE), JSON.stringify({ pid: 1, at: new Date().toISOString() }));
  check(E.pendingReports({ sessionId: 'parent-B' }).length === 0, '有新鮮等待心跳（兩輪等待之間）不補報', '');
  fs.writeFileSync(path.join(p2.run_dir, E.WAIT_FILE), JSON.stringify({ pid: 1, at: new Date(Date.now() - 6 * 60000).toISOString() }));
  const pend = goal(['--pending']);
  const row = pend.j && pend.j.runs.find((r) => r.runDir === p2.run_dir);
  check(!!row && row.parentSessionId === 'parent-B' && /goal2 跑完了/.test(row.message), '--pending 列出它、帶起它的對話與要送的話', pend.out.slice(0, 400));
  check(!hook('someone-else').j, 'hook：別的對話打字不會收到', '');
  const h1 = hook('parent-B');
  check(h1.code === 0 && h1.j && /goal2 跑完了/.test(h1.j.hookSpecificOutput.additionalContext) && h1.j.hookSpecificOutput.hookEventName === 'UserPromptSubmit', 'hook：起它的對話打字時補上回報', h1.out);
  check(!hook('parent-B').j, 'hook：只補一次', '');
  check((E.reportInfo(p2.run_dir) || {}).by === 'hook:parent-B', '回報權記在 hook 名下', JSON.stringify(E.reportInfo(p2.run_dir)));

  // ── 5. 看板用的搶／放：只有搶到的能放，放回後 hook 還能補 ──
  const p3 = prepare('parent-C');
  goal(['--start', p3.run_dir], { FAKE_SLEEP_MS: '300' });
  for (let i = 0; i < 60 && !fs.existsSync(path.join(p3.run_dir, 'result.json')); i++) await sleep(250);
  age(p3.run_dir, 2 * 60000);
  const c1 = goal(['--claim', p3.run_dir, '--by', 'board']);
  check(c1.code === 0 && c1.j.ok, '看板搶到回報權', c1.out);
  const c2 = goal(['--claim', p3.run_dir, '--by', 'board']);
  check(c2.code !== 0 && c2.j.already && c2.j.already.by === 'board', '第二次搶：已被搶走', c2.out);
  const r1 = goal(['--release', p3.run_dir, '--by', 'someone']);
  check(r1.code !== 0, '不是搶到的人不能放', r1.out);
  check(!hook('parent-C').j, '被看板搶著時 hook 不補', '');
  const r2 = goal(['--release', p3.run_dir, '--by', 'board']);
  check(r2.code === 0 && r2.j.ok, '看板送不出去時放回', r2.out);
  check(!!hook('parent-C', 'SessionStart').j, '放回後 hook（重新打開對話）補上', '');
  check(goal(['--claim', p3.run_dir]).code !== 0, '--claim 沒帶 --by 拒絕', '');

  // ── 6. 不是從對話起的（看板排程、舊版）沒有可送回的對話：不列 ──
  const p4 = prepare(null);
  goal(['--start', p4.run_dir], { FAKE_SLEEP_MS: '300' });
  for (let i = 0; i < 60 && !fs.existsSync(path.join(p4.run_dir, 'result.json')); i++) await sleep(250);
  age(p4.run_dir, 2 * 60000);
  check(!E.pendingReports().some((r) => r.runDir === p4.run_dir), '沒有起它的對話：不列為待補報', '');

  // ── 6b. delaylocal：排程當下就起獨立的等待程序（不用 CronCreate：對話被關掉排程也還在），到點才起引擎 ──
  {
    const DELAY = path.join(ROOT, 'skills', 'delaylocal', 'delaylocal.js');
    const lim = path.join(HOME, '.claude', 'cc-statusline', 'state', 'account-limits.json');
    fs.mkdirSync(path.dirname(lim), { recursive: true });
    const limits = (resetIn) => fs.writeFileSync(lim, JSON.stringify({ v: 1, at: Date.now(), five_hour: { used_percentage: 10, resets_at: Math.floor(Date.now() / 1000) + resetIn }, seven_day: { used_percentage: 10, resets_at: Math.floor(Date.now() / 1000) + 86400 * 3 } }));
    const pf = () => { const p = path.join(HOME, 'dl-task-' + Math.random().toString(36).slice(2) + '.md'); fs.writeFileSync(p, '## 任務\n建立 b.txt。\n\n## 脈絡與約束\n測試用。\n'); return p; };
    const env = { ...process.env, TEMP: HOME, TMP: HOME, TMPDIR: HOME, CLAUDE_CODE_SESSION_ID: 'parent-D', FAKE_SLEEP_MS: '500' };
    const run = (args) => { const r = spawnSync(process.execPath, [DELAY, ...args], { encoding: 'utf8', env, windowsHide: true }); let j = null; try { j = JSON.parse(r.stdout); } catch (_) {} return { j, out: (r.stdout + r.stderr).slice(0, 500) }; };
    // an hour away: scheduled, the waiting process there, nothing started; --stop cancels it
    limits(3600);
    const a = run(['--prompt-file', pf(), '--goal', 'work/b.txt 存在', '--cwd', WORK]);
    check(!!a.j && a.j.ok && a.j.scheduled && a.j.scheduled.status === 'scheduled' && a.j.cron === null && a.j.final_prompt === null, 'delaylocal：排程當下起等待程序（status scheduled），不再給 cron／final_prompt', a.out);
    if (a.j && a.j.ok) {
      const m = E.readMeta(a.j.run_dir);
      check(m.parentSessionId === 'parent-D' && !!m.waiterPid && !m.pid, 'delaylocal：記下起它的對話與等待程序，引擎還沒起', JSON.stringify(m).slice(0, 300));
      const st = run(['--status', a.j.run_dir]).j;
      check(!!st && st.status === 'scheduled' && st.waiter_state === 'alive' && st.alive === true && /已排程/.test(st.summary_zh), 'delaylocal --status：已排程、等待程序在（alive 看等待程序）', st && st.summary_zh);
      check(E.findActiveRunsIn(WORK).some((x) => x.runDir === a.j.run_dir), '排程中的 run 算在工作樹裡活著的 run', '');
      const sp = run(['--stop', a.j.run_dir]).j;
      await sleep(800);
      let gone = true; try { process.kill(m.waiterPid, 0); gone = false; } catch (_) {}
      check(!!sp && sp.ok && E.readMeta(a.j.run_dir).status === 'stopped' && gone && !fs.existsSync(path.join(a.j.run_dir, 'stream.jsonl')), 'delaylocal --stop：取消排程、等待程序結束、引擎沒起', JSON.stringify(sp));
      age(a.j.run_dir, 2 * 60000);
      check(!E.pendingReports().some((r) => r.runDir === a.j.run_dir), 'delaylocal：取消的排程不會被當成跑完了送回對話', '');
    }
    // reset already passed: the time it waits for comes, then the engine runs; --wait gets the result
    limits(-60);
    const b = run(['0', '--prompt-file', pf(), '--goal', 'work/b.txt 存在', '--cwd', WORK]);
    check(!!b.j && b.j.ok && b.j.scheduled && b.j.scheduled.ok, 'delaylocal：額度已重置也照樣排（到下一分鐘）', b.out);
    if (b.j && b.j.ok) {
      const w = spawnSync(process.execPath, [DELAY, '--wait', b.j.run_dir, '--minutes', '3'], { encoding: 'utf8', env: process.env, windowsHide: true });
      let wj = null; try { wj = JSON.parse(w.stdout); } catch (_) {}
      check(!!wj && wj.mode === 'ran' && wj.report === 'yours' && wj.result_text === '做完了（假引擎）', 'delaylocal：到點起引擎，--wait 拿到結果', (w.stdout + w.stderr).slice(0, 300));
      { const m = E.readMeta(b.j.run_dir); check(Date.parse(m.startedAt) >= Date.parse(m.scheduledFor) - 1000, 'delaylocal：引擎不早於排定時間起', m.startedAt + ' / ' + m.scheduledFor); }
    }
    // the waiting process gone (a restart): --wait says so rather than waiting for ever
    limits(3600);
    const c = run(['--prompt-file', pf(), '--goal', 'work/b.txt 存在', '--cwd', WORK]);
    if (c.j && c.j.ok) {
      const pid = E.readMeta(c.j.run_dir).waiterPid; try { process.kill(pid); } catch (_) {}
      await sleep(800);
      const st = run(['--status', c.j.run_dir]).j;
      check(!!st && st.waiter_state === 'dead' && /不會自動開始/.test(st.summary_zh), 'delaylocal：等待程序不在了，--status 說不會自動開始', st && st.summary_zh);
      run(['--stop', c.j.run_dir]);
    } else check(false, 'delaylocal：第三個排程', c.out);
  }

  // ── 7. 參數 ──
  check(goal(['--wait', p1.run_dir, '--minutes', '200']).code !== 0, '--minutes 超過 110 拒絕', '');
  check(goal(['--start']).code !== 0, '--start 沒給目錄拒絕', '');

  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch (_) {}
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
