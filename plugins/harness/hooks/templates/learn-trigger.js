#!/usr/bin/env node
// PreToolUse（matcher ""）／Stop／SessionEnd：學習迴路的確定性觸發。
//
// 【範本】由 /harness:init 複製到目標專案 `.claude/hooks/`，之後歸該專案自治（可自改；plugin 更新不會自動同步）。
// 接線（目標專案 .claude/settings.json；同一支檔接三個事件，靠 payload 的 hook_event_name 分辨）：
//   "PreToolUse": [{ "matcher": "", "hooks": [{ "type": "command",
//     "command": "node \"<專案絕對路徑>/.claude/hooks/learn-trigger.js\"", "timeout": 10, "statusMessage": "學習迴路：記一次工具呼叫" }] }],
//   "Stop": [{ "hooks": [{ "type": "command",
//     "command": "node \"<專案絕對路徑>/.claude/hooks/learn-trigger.js\"", "timeout": 10, "statusMessage": "學習迴路：看要不要在背景整理這段對話的教訓" }] }],
//   "SessionEnd": [{ "hooks": [{ "type": "command",
//     "command": "node \"<專案絕對路徑>/.claude/hooks/learn-trigger.js\"", "timeout": 10, "statusMessage": "學習迴路：結束前把剩下的對話交給背景整理" }] }]
//
// 做什麼：
//   PreToolUse → 本 session 的工具呼叫計數 +1（payload 帶 agent_id＝subagent 內的呼叫，不計）。
//   Stop       → 計數 - 上次觸發點 ≥ N 就記下新的觸發點，detached 起 learn-reflect.js，立即 exit 0（不等它）。
//   SessionEnd → 剩餘（計數 - 上次觸發點）≥ MIN_REMAINDER 就同上。
// N：環境變數 HARNESS_REFLECT_EVERY_N 優先，否則填空區 EVERY_N；0＝整個學習迴路觸發關閉（連計數都不做）。
// 計數存 `.claude/harness/learning/session-<session_id>.json`，經 learn-lib 的鎖讀改寫；取不到鎖就少計一次（只會讓觸發稍晚）。
//
// 遞迴防護：HARNESS_LEARN_CHILD（反思子程序）或 COMPACT_HANDOFF_CHILD（交接信子程序）存在時直接 exit 0，不計、不印。
// 試跑：HARNESS_LEARN_DRYRUN=1 時不 spawn，只寫 learning/dryrun-trigger.json，並在 stderr 印一行
//   `[learn-trigger] dryrun: 會觸發反思（…）`（cases 與 Phase 5 探針用，避免在暫存目錄起真的背景反思、花真的用量）。
// 測試用：HARNESS_LEARN_DEBUG=1 時 PreToolUse 計數後在 stderr 印一行計數結果（只供 cases 驗「真的計了」；正常執行不設）。
// fail-open：任何例外 exit 0，stderr 印 `[learn-trigger] ERROR: …`；不得因學習迴路故障擋下使用者。
//
// 實測確認（2026-10-10，設計稿 §11.1b）：subagent 內的工具呼叫在 payload 帶 agent_id，計數只含主對話的呼叫
// （主對話 9 次、subagent 內 3 次 → 計數 9）。
//
// 自行決定的細節：
// - Stop／SessionEnd 沒有 transcript_path（或檔案不存在）時不觸發、觸發點不前進（試跑模式不看 transcript）。
// - session_id 只保留英數、底線、點、連字號當檔名，其他字元換成底線。

'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// ── init 填空區 ──────────────────────────────────────────────────────────────
// 每累積幾次主 session 工具呼叫，在回合結束時觸發一次背景反思（0＝關閉；環境變數 HARNESS_REFLECT_EVERY_N 優先）。
const EVERY_N = 80;
// session 結束時，距上次觸發剩下幾次以上才再觸發一次。
const MIN_REMAINDER = 10;
// ────────────────────────────────────────────────────────────────────────────

function log(msg) { process.stderr.write('[learn-trigger] ' + msg + '\n'); }

try {
  if (process.env.HARNESS_LEARN_CHILD || process.env.COMPACT_HANDOFF_CHILD) process.exit(0);
  const envN = process.env.HARNESS_REFLECT_EVERY_N;
  const N = envN !== undefined && envN !== '' && /^\d+$/.test(envN.trim()) ? Number(envN.trim()) : EVERY_N;
  if (N === 0) process.exit(0);

  let raw = '';
  try { raw = fs.readFileSync(0, 'utf8'); } catch { process.exit(0); }
  const input = JSON.parse(raw || '{}');
  const event = String(input.hook_event_name || '');
  if (!['PreToolUse', 'Stop', 'SessionEnd'].includes(event)) process.exit(0);
  if (event === 'PreToolUse' && input.agent_id) process.exit(0);

  const lib = require('./learn-lib.js');
  const P = lib.paths(lib.rootOf(__dirname));
  const sid = String(input.session_id || 'unknown').replace(/[^\w.-]/g, '_');
  const file = 'session-' + sid + '.json';
  const dflt = { count: 0, lastTriggerCount: 0, transcript: null, updatedAt: null };

  if (event === 'PreToolUse') {
    let n;
    try {
      n = lib.updateJson(P.learn, file, dflt, (s) => {
        s.count = (s.count || 0) + 1; s.updatedAt = lib.nowIso();
        if (input.transcript_path) s.transcript = input.transcript_path;
        return s.count;
      });
    } catch (e) { if (e && e.code === 'ELOCKED') process.exit(0); throw e; } // 取不到鎖：本次不計
    if (process.env.HARNESS_LEARN_DEBUG) log('計數 ' + n);
    process.exit(0);
  }

  // Stop／SessionEnd：判門檻
  const dry = process.env.HARNESS_LEARN_DRYRUN === '1';
  const tp = input.transcript_path ? path.resolve(input.cwd || process.cwd(), String(input.transcript_path)) : null;
  const trigger = event === 'Stop' ? 'stop-threshold' : 'session-end';
  let decision;
  try {
    decision = lib.updateJson(P.learn, file, dflt, (s) => {
      const count = s.count || 0, last = s.lastTriggerCount || 0;
      const need = event === 'Stop' ? N : MIN_REMAINDER;
      if (count - last < need) return null;
      if (!dry && !(tp && fs.existsSync(tp))) return null;
      s.lastTriggerCount = count; s.updatedAt = lib.nowIso();
      return { count, last };
    });
  } catch (e) { if (e && e.code === 'ELOCKED') process.exit(0); throw e; }
  if (!decision) process.exit(0);

  if (dry) {
    const mark = { at: lib.nowIso(), trigger, session: sid, transcript: tp, count: decision.count, lastTriggerCount: decision.last, everyN: N };
    lib.updateJson(P.learn, 'dryrun-trigger.json', {}, (o) => { for (const k of Object.keys(o)) delete o[k]; Object.assign(o, mark); });
    log('dryrun: 會觸發反思（' + trigger + '，計數 ' + decision.count + '，上次觸發點 ' + decision.last + '，N=' + N + '）');
    process.exit(0);
  }
  const child = spawn(process.execPath, [path.join(__dirname, 'learn-reflect.js'), '--transcript', tp, '--session', sid, '--trigger', trigger], {
    detached: true, stdio: 'ignore', windowsHide: true, cwd: P.root,
    env: Object.assign({}, process.env, { HARNESS_LEARN_CHILD: '1' }),
  });
  child.on('error', (e) => log('ERROR: 起背景反思失敗：' + e.message));
  child.unref();
  process.exit(0);
} catch (e) {
  log('ERROR: ' + ((e && e.message) || e) + '（放行；學習迴路 hook 鏽蝕要修）');
  process.exit(0);
}
