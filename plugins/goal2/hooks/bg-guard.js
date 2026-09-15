#!/usr/bin/env node
'use strict';
/**
 * goal2 bg-guard — 掛在引擎子程序上的 command 型 Stop hook（engine.js 以 --settings 只對該子程序掛）
 *
 * 問題：Claude Code 在 Stop 時若還有背景任務，會把 /goal 的檢查「延後」（goal 的 Stop hook 暫時移出 registry）；
 *       互動 session 稍後會 check-in，但 headless（claude -p）不會，而且 -p 對背景 Bash（local_bash）根本不等、
 *       回合一結束就退出並殺掉它們（實測 run 9af9：sleep 45 丟背景、17 秒後 session 結束、檔案沒建、判定從未發生）。
 *       真實 run 55a0／89c2／0296 都是引擎「把測試丟背景、結束回合等通知」而落空。
 * 做法：Stop 時掃這個子程序的背景 Bash 輸出檔（Bash 工具 run_in_background 會寫到
 *       <tmpdir>/claude/<cwd 編碼>/<session_id>/tasks/<id>.output，結束時尾端追加「[exited with code N]」）；
 *       還有沒結束的 → 回 {"decision":"block"} 把引擎推回去等它完成（或 TaskStop），沒有才放行——
 *       放行的那次 Stop 才會真的跑 /goal 檢查。
 * 防呆：只在 GOAL2_RUN_DIR 存在時動作；同一 run 最多 block 30 次（計數寫在 run 目錄），超過就放行並留紀錄；任何錯誤 fail-open。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_BLOCKS = 30;
function readStdin() { try { return fs.readFileSync(0, 'utf8'); } catch (_) { return ''; } }
function enc(p) { return String(p || '').replace(/[^A-Za-z0-9]/g, '-'); }

/** 找出還在跑的背景 Bash 任務（輸出檔沒有 exited 標記） */
function runningBgTasks(tasksDir) {
  let names = []; try { names = fs.readdirSync(tasksDir); } catch (_) { return []; }
  const out = [];
  for (const n of names) {
    if (!n.endsWith('.output')) continue;
    const p = path.join(tasksDir, n);
    try {
      const st = fs.statSync(p);
      const fd = fs.openSync(p, 'r');
      const len = Math.min(st.size, 400);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, Math.max(0, st.size - len));
      fs.closeSync(fd);
      const tail = buf.toString('utf8');
      if (!/\[exited with code -?\d+\]|\[killed\]|\[stopped\]/.test(tail)) out.push({ id: n.replace(/\.output$/, ''), ageSec: Math.round((Date.now() - st.mtimeMs) / 1000) });
    } catch (_) {}
  }
  return out;
}

try {
  const raw = readStdin();
  let input = {};
  if (raw.trim()) { try { input = JSON.parse(raw); } catch (_) { process.exit(0); } }
  if (!input || typeof input !== 'object') process.exit(0);
  if (input.hook_event_name && input.hook_event_name !== 'Stop') process.exit(0);
  const runDir = process.env.GOAL2_RUN_DIR;
  if (!runDir || !fs.existsSync(runDir)) process.exit(0);
  const sessionId = input.session_id; const cwd = input.cwd;
  if (!sessionId || !cwd) process.exit(0);

  const tasksDir = path.join(os.tmpdir(), 'claude', enc(cwd), sessionId, 'tasks');
  const running = runningBgTasks(tasksDir);
  const logPath = path.join(runDir, 'bg-guard-log.txt');
  const countPath = path.join(runDir, 'bg-guard-count.txt');
  let count = 0; try { count = parseInt(fs.readFileSync(countPath, 'utf8'), 10) || 0; } catch (_) {}

  if (running.length === 0) {
    try { fs.appendFileSync(logPath, `${new Date().toISOString()} pass (no running bg tasks; tasksDir=${tasksDir})\n`); } catch (_) {}
    process.exit(0);
  }
  if (count >= MAX_BLOCKS) {
    try { fs.appendFileSync(logPath, `${new Date().toISOString()} pass-after-cap (${running.length} running, blocked ${count} times already)\n`); } catch (_) {}
    process.exit(0);
  }
  try { fs.writeFileSync(countPath, String(count + 1)); } catch (_) {}
  try { fs.appendFileSync(logPath, `${new Date().toISOString()} block #${count + 1}: running=${running.map((r) => `${r.id}(${r.ageSec}s)`).join(',')}\n`); } catch (_) {}
  const reason = `[goal2 bg-guard] 還有 ${running.length} 個背景 Bash 任務在跑（${running.map((r) => r.id).join('、')}），現在結束回合會讓完成條件的檢查被延後且 headless 模式不會再叫醒你，成果永遠不會被驗收。請等它們完成（會收到 task-notification）或 TaskStop 掉，再結束回合。以後測試／建置請前景執行（用 timeout 調長），不要 run_in_background。（第 ${count + 1}/${MAX_BLOCKS} 次提醒）`;
  process.stdout.write(JSON.stringify({ decision: 'block', reason }));
  process.exit(0);
} catch (_) {
  process.exit(0);
}
