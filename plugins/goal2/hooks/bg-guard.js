#!/usr/bin/env node
'use strict';
/**
 * goal2 bg-guard — 掛在引擎子程序上的 command 型 Stop hook（engine.js 以 --settings 只對該子程序掛）
 *
 * 問題：Claude Code 在 Stop 時若還有背景任務，會把 /goal 的檢查「延後」（goal 的 Stop hook 暫時移出 registry）；
 *       互動 session 稍後會 check-in，但 headless（claude -p）不會，而且 -p 對背景 Bash（local_bash）根本不等、
 *       回合一結束就退出並殺掉它們（實測 run 9af9：sleep 45 丟背景、17 秒後 session 結束、檔案沒建、判定從未發生）。
 *       真實 run 55a0／89c2／0296 都是引擎「把測試丟背景、結束回合等通知」而落空。
 * 做法：Stop 時掃這個子程序的背景任務輸出檔（<tmpdir>/claude/<cwd 編碼>/<session_id>/tasks/<id>.output）；
 *       還有沒結束的 → 回 {"decision":"block"} 把引擎推回去等它完成（或 TaskStop），沒有才放行——
 *       放行的那次 Stop 才會真的跑 /goal 檢查。
 *
 * 結束的判定有三條獨立判準，任一成立即視為已結束（刻意用不同來源，避免單一判準的盲區同構）：
 *   ① 尾端標記：Bash 工具 run_in_background 結束時在 .output 尾端追加「[exited with code N]」。
 *   ② task-notification：Agent 型任務（Agent 工具）的 .output 是 JSONL transcript，
 *      **永遠不會**寫入 ① 的標記，所以只靠 ① 會把早已結束的 agent 永久誤判為在跑
 *      （2026-09-22 run bdd4 實證：6 個已結束 agent 被當成在跑，引擎被迫把 transcript 搬走才能收尾）。
 *      真實訊號在主 session 的 transcript：agent 停下時會寫入一個 <task-notification> 區塊，
 *      帶 <task-id> 與 <status>completed|failed|...</status>。這裡收集非 running 狀態的 task-id 當白名單。
 *   ③ mtime 靜止兜底：輸出檔超過 STALE_SEC 沒有任何寫入，視為已結束。
 *      用途是在 ①② 都取不到時（transcript 路徑變更、格式改版）不要無限期卡住。
 *
 * 防呆：只在 GOAL2_RUN_DIR 存在時動作；同一 run 最多 block 30 次（計數寫在 run 目錄），超過就放行並留紀錄；任何錯誤 fail-open。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_BLOCKS = 30;
/** 輸出檔靜止多久後視為已結束（判準 ③ 的兜底門檻） */
const STALE_SEC = 900;
/** 讀 transcript 的上限，避免超大檔拖慢 Stop */
const TRANSCRIPT_TAIL_BYTES = 4 * 1024 * 1024;

function readStdin() { try { return fs.readFileSync(0, 'utf8'); } catch (_) { return ''; } }
function enc(p) { return String(p || '').replace(/[^A-Za-z0-9]/g, '-'); }

/** 讀檔案尾端最多 n 個位元組 */
function readTail(p, n) {
  const st = fs.statSync(p);
  const len = Math.min(st.size, n);
  const fd = fs.openSync(p, 'r');
  try {
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, Math.max(0, st.size - len));
    return { text: buf.toString('utf8'), mtimeMs: st.mtimeMs };
  } finally { fs.closeSync(fd); }
}

/**
 * 判準 ②：從主 session transcript 收集「已收到結束通知」的 task-id。
 * transcript 路徑由 hook payload 的 transcript_path 提供；取不到就回空集合（退回判準 ①③）。
 */
function completedTaskIds(transcriptPath) {
  const done = new Set();
  if (!transcriptPath) return done;
  let text = '';
  try { text = readTail(transcriptPath, TRANSCRIPT_TAIL_BYTES).text; } catch (_) { return done; }
  // transcript 是 JSONL，task-notification 以逸出後的字串內嵌在某些行裡，
  // 所以直接對原始文字掃描，同時容忍 \n 被逸出成字面的 \\n。
  const re = /<task-id>\s*([A-Za-z0-9_-]+)\s*<\/task-id>[\s\S]{0,4000}?<status>\s*([a-z_]+)\s*<\/status>/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const id = m[1];
    const status = m[2];
    if (status && status !== 'running' && status !== 'in_progress') done.add(id);
  }
  return done;
}

/** 找出還在跑的背景任務（三條判準都不成立才算在跑） */
function runningBgTasks(tasksDir, doneIds) {
  let names = []; try { names = fs.readdirSync(tasksDir); } catch (_) { return []; }
  const out = [];
  for (const n of names) {
    if (!n.endsWith('.output')) continue;
    const id = n.replace(/\.output$/, '');
    // 判準 ②：主 session 已收到這個 task 的結束通知
    if (doneIds.has(id)) continue;
    const p = path.join(tasksDir, n);
    try {
      const { text: tail, mtimeMs } = readTail(p, 400);
      // 判準 ①：Bash 背景任務的結束標記
      if (/\[exited with code -?\d+\]|\[killed\]|\[stopped\]/.test(tail)) continue;
      const ageSec = Math.round((Date.now() - mtimeMs) / 1000);
      // 判準 ③：輸出檔長時間沒有任何寫入
      if (ageSec >= STALE_SEC) continue;
      out.push({ id, ageSec });
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
  const doneIds = completedTaskIds(input.transcript_path);
  const running = runningBgTasks(tasksDir, doneIds);
  const logPath = path.join(runDir, 'bg-guard-log.txt');
  const countPath = path.join(runDir, 'bg-guard-count.txt');
  let count = 0; try { count = parseInt(fs.readFileSync(countPath, 'utf8'), 10) || 0; } catch (_) {}

  if (running.length === 0) {
    try { fs.appendFileSync(logPath, `${new Date().toISOString()} pass (no running bg tasks; notified=${doneIds.size}; tasksDir=${tasksDir})\n`); } catch (_) {}
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
