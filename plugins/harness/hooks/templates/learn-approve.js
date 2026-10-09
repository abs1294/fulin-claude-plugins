#!/usr/bin/env node
// UserPromptSubmit：學習迴路的使用者核可——只認使用者在提示列打的原話。
//
// 【範本】由 /harness:init 複製到目標專案 `.claude/hooks/`，之後歸該專案自治（可自改；plugin 更新不會自動同步）。
// 接線（目標專案 .claude/settings.json）：
//   "UserPromptSubmit": [{ "hooks": [{ "type": "command",
//     "command": "node \"<專案絕對路徑>/.claude/hooks/learn-approve.js\"", "timeout": 15, "statusMessage": "學習迴路：看這則訊息是不是在核可或駁回待核項目" }] }]
//
// payload.prompt 是使用者這一則訊息的原文。某一行**整行**是下列形狀才動作（大小寫不分，可一次列多個 id）：
//   核可|同意|approve <id> [<id> …]     → 黃區保留寫入；紅區標 approved，並把建議內容交給 Claude 依 05 §1 執行
//   駁回|拒絕|reject  <id> [<id> …]     → 黃／綠區 hash 相符才還原；紅區標 rejected
//   還原|revert       <id> [<id> …]     → 黃／綠區還原
// id 形如 p-20261009-01。結果用 {"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"…"}} 告訴 Claude。
// 沒命中 → 不輸出任何東西。動作與 learn-pending.js 共用 learn-lib.pendingAction（同一套鎖與 ledger）。
//
// 為什麼要整行比對：「不要核可 p-…」「核可 p-… 之前先讓我看」這類句子不能被當成核可；
// 只有使用者單獨打一行指令才算數。Claude 在工具裡跑 learn-pending.js approve 會被拒（CLAUDECODE），
// 所以核可紀錄只會來自使用者原話（設計稿 4.5、審查 R14）。本 hook 不擋使用者的訊息（不回 decision）。
//
// 遞迴防護：HARNESS_LEARN_CHILD 或 COMPACT_HANDOFF_CHILD 存在時直接 exit 0，不印。
// fail-open：任何例外 exit 0，stderr 印 `[learn-approve] ERROR: …`，並以 additionalContext 告訴 Claude 這次沒處理。

'use strict';
const fs = require('fs');

// ── init 填空區 ──────────────────────────────────────────────────────────────
// 三種指令的關鍵字（regex 片段，不分大小寫）。
const APPROVE_WORDS = '核可|同意|approve';
const REJECT_WORDS = '駁回|拒絕|reject';
const REVERT_WORDS = '還原|revert';
// ────────────────────────────────────────────────────────────────────────────

function tell(text) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } }) + '\n');
}

try {
  if (process.env.HARNESS_LEARN_CHILD || process.env.COMPACT_HANDOFF_CHILD) process.exit(0);
  let raw = '';
  try { raw = fs.readFileSync(0, 'utf8'); } catch { process.exit(0); }
  const input = JSON.parse(raw || '{}');
  const prompt = String(input.prompt || '');
  const ID = 'p-\\d{8}-\\d+';
  const line = new RegExp('^\\s*(' + APPROVE_WORDS + '|' + REJECT_WORDS + '|' + REVERT_WORDS + ')\\s*[:：]?\\s*((?:' + ID + ')(?:\\s*[,，、\\s]\\s*' + ID + ')*)\\s*[。.!！]?\\s*$', 'i');
  const jobs = [];
  for (const l of prompt.split(/\r?\n/)) {
    const m = l.match(line);
    if (!m) continue;
    const w = m[1].toLowerCase();
    const action = new RegExp('^(' + APPROVE_WORDS + ')$', 'i').test(w) ? 'approve' : (new RegExp('^(' + REJECT_WORDS + ')$', 'i').test(w) ? 'reject' : 'revert');
    for (const id of m[2].match(new RegExp(ID, 'g'))) jobs.push({ action, id });
  }
  if (!jobs.length) process.exit(0);
  const lib = require('./learn-lib.js');
  const root = lib.rootOf(__dirname);
  const out = [];
  for (const j of jobs) {
    try {
      const r = lib.pendingAction(root, j.action, j.id, 'user-prompt');
      out.push((r.code === 0 ? '✔ ' : '✘ ') + r.text);
    } catch (e) {
      out.push('✘ ' + j.id + ' 處理失敗：' + ((e && e.message) || e) + (e && e.code === 'ELOCKED' ? '（請使用者再送一次同一句）' : ''));
    }
  }
  tell('[learn-approve] 使用者在提示列下了學習迴路的核可指令，hook 已執行：\n' + out.join('\n')
    + '\n（紅區核可只改了 pending.json 的狀態；要落實建議內容，請依 05 §1 的分級處理。）');
  process.exit(0);
} catch (e) {
  process.stderr.write('[learn-approve] ERROR: ' + ((e && e.message) || e) + '\n');
  try { tell('[learn-approve] ERROR: 學習迴路核可 hook 故障，這則訊息裡的核可／駁回指令沒有被處理——' + ((e && e.message) || e)); } catch {}
  process.exit(0);
}
