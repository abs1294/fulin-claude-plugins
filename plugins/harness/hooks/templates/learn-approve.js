#!/usr/bin/env node
// UserPromptSubmit＋PostToolUse(AskUserQuestion)：學習迴路的使用者核可——只認使用者在提示列打的原話，或使用者在選單上點的答案。
//
// 【範本】由 /harness:init 複製到目標專案 `.claude/hooks/`，之後歸該專案自治（可自改；plugin 更新不會自動同步）。
// 接線（目標專案 .claude/settings.json，兩個事件接同一支）：
//   "UserPromptSubmit": [{ "hooks": [{ "type": "command",
//     "command": "node \"<專案絕對路徑>/.claude/hooks/learn-approve.js\"", "timeout": 15, "statusMessage": "學習迴路：看這則訊息是不是在核可或駁回待核項目" }] }]
//   "PostToolUse": [{ "matcher": "AskUserQuestion", "hooks": [{ "type": "command",
//     "command": "node \"<專案絕對路徑>/.claude/hooks/learn-approve.js\"", "timeout": 15, "statusMessage": "學習迴路：看使用者在選單上是不是核可或駁回待核項目" }] }]
//
// 為什麼加選單路徑（2026-10-17）：開場只印一行「請在提示列輸入核可 <編號>」，實際從沒有人照打，黃區待你看擱著沒人審。
// 開場回報改叫 Claude 用 AskUserQuestion 逐項問，使用者點選後由這裡執行。選單答案是使用者在 UI 上點的（或在「其他」自己打的），
// 不是模型產生的文字，所以仍守住 R14；Claude 自己在回覆裡寫「核可 p-…」不會觸發任何事件，learn-pending.js 的 CLAUDECODE 拒絕維持不動。
// AskUserQuestion 的回應形狀：tool_response.answers 是 { 題目原文: 答案原文 }（多選以「, 」串接）。這個形狀還沒在真的 session 裡點過選單驗證
// （HYPOTHESIS，2026-10-18；之前檔頭引 compact-snapshot.js 作依據是空引用，該檔沒碰 answers），所以也接受 [{question, answer}] 陣列形狀。
// 選單答案這樣認（整個答案比對，去掉結尾的「 (Recommended)」）：
//   答案本身是「核可|駁回|還原 <id>」→ 照答案裡的 id，且那個 id 要出現在題目裡（答案與題目對不上就不動）；
//   答案只有動作詞（限中文「核可」「駁回」「還原」，不含「同意」「approve」這些日常用語）→ 題目要是開場指示的那種格式
//   （含「<id>｜」的「編號｜類型｜主題｜摘要」一行）且恰好一個 id 才算；其他問句（「要不要駁回 p-…？」）即使使用者點「同意」也不動作——
//   題目是模型寫的，核可的對象不能由模型的問句決定（紅藍對抗 R2 R1-10：無關問題點「同意」就核可了那筆）；
//   「稍後」或其他答案 → 不動作。
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

let EVENT = 'UserPromptSubmit';
function tell(text) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: EVENT, additionalContext: text } }) + '\n');
}

const ID = 'p-\\d{8}-\\d+';
const WORDS = APPROVE_WORDS + '|' + REJECT_WORDS + '|' + REVERT_WORDS;
function actionOf(word) {
  const w = String(word).toLowerCase();
  return new RegExp('^(' + APPROVE_WORDS + ')$', 'i').test(w) ? 'approve' : (new RegExp('^(' + REJECT_WORDS + ')$', 'i').test(w) ? 'reject' : 'revert');
}

// 提示列原話：某一行整行是指令才算
function jobsFromPrompt(prompt) {
  const line = new RegExp('^\\s*(' + WORDS + ')\\s*[:：]?\\s*((?:' + ID + ')(?:\\s*[,，、\\s]\\s*' + ID + ')*)\\s*[。.!！]?\\s*$', 'i');
  const jobs = [];
  for (const l of String(prompt || '').split(/\r?\n/)) {
    const m = l.match(line);
    if (!m) continue;
    const action = actionOf(m[1]);
    for (const id of m[2].match(new RegExp(ID, 'g'))) jobs.push({ action, id });
  }
  return jobs;
}

// 選單答案：每題的答案整個比對，規則見檔頭
function jobsFromAsk(input) {
  const resp = input.tool_response;
  let pairs = null;
  if (resp && typeof resp === 'object') {
    if (resp.answers && typeof resp.answers === 'object' && !Array.isArray(resp.answers)) pairs = Object.entries(resp.answers);
    else if (Array.isArray(resp.answers)) pairs = resp.answers.filter((x) => x && typeof x === 'object').map((x) => [x.question, x.answer]);
  }
  if (!pairs) return [];
  const withId = new RegExp('^(' + WORDS + ')\\s*[:：]?\\s*(' + ID + ')$', 'i');
  // 裸動作詞只認開場指示叫 Claude 寫的選項字（「核可」「駁回」「還原」），不認「同意」「approve」這類日常用語
  const bare = /^(核可|駁回|還原)$/;
  // 題目要長得像開場指示的格式：「<id>｜類型｜主題｜摘要」（id 後面緊接全形或半形直線）
  const menuShaped = new RegExp('(' + ID + ')\\s*[｜|]');
  const jobs = [];
  for (const [q, a] of pairs) {
    const question = String(q == null ? '' : q);
    const ans = String(a == null ? '' : a).replace(/\s*[(（](?:Recommended|建議)[)）]\s*$/i, '').trim();
    let m = ans.match(withId);
    if (m) {
      // 答案帶的 id 要出現在題目裡：選項與題目對不上（模型把別筆的 id 放進選項）就不動
      if (question.includes(m[2])) jobs.push({ action: actionOf(m[1]), id: m[2] });
      continue;
    }
    m = ans.match(bare);
    if (!m) continue;
    if (!menuShaped.test(question)) continue;
    const ids = [...new Set(question.match(new RegExp(ID, 'g')) || [])];
    if (ids.length === 1) jobs.push({ action: actionOf(m[1]), id: ids[0] });
  }
  return jobs;
}

try {
  if (process.env.HARNESS_LEARN_CHILD || process.env.COMPACT_HANDOFF_CHILD) process.exit(0);
  let raw = '';
  try { raw = fs.readFileSync(0, 'utf8'); } catch { process.exit(0); }
  const input = JSON.parse(raw || '{}');
  const viaAsk = input.hook_event_name === 'PostToolUse';
  if (viaAsk) {
    EVENT = 'PostToolUse';
    // 只收 AskUserQuestion；matcher 沒設好接到別的工具時安靜放過
    if (input.tool_name !== 'AskUserQuestion') process.exit(0);
  }
  const jobs = viaAsk ? jobsFromAsk(input) : jobsFromPrompt(input.prompt);
  if (!jobs.length) process.exit(0);
  const lib = require('./learn-lib.js');
  const root = lib.rootOf(__dirname);
  const out = [];
  for (const j of jobs) {
    try {
      const r = lib.pendingAction(root, j.action, j.id, viaAsk ? 'user-ask' : 'user-prompt');
      out.push((r.code === 0 ? '✔ ' : '✘ ') + r.text);
    } catch (e) {
      out.push('✘ ' + j.id + ' 處理失敗：' + ((e && e.message) || e) + (e && e.code === 'ELOCKED' ? (viaAsk ? '（請使用者改在提示列輸入同一個指令）' : '（請使用者再送一次同一句）') : ''));
    }
  }
  tell('[learn-approve] 使用者' + (viaAsk ? '在選單上選了' : '在提示列下了') + '學習迴路的核可指令，hook 已執行：\n' + out.join('\n')
    + '\n（紅區核可只改了 pending.json 的狀態；要落實建議內容，請依 05 §1 的分級處理。）');
  process.exit(0);
} catch (e) {
  process.stderr.write('[learn-approve] ERROR: ' + ((e && e.message) || e) + '\n');
  try { tell('[learn-approve] ERROR: 學習迴路核可 hook 故障，這次的核可／駁回指令沒有被處理——' + ((e && e.message) || e)); } catch {}
  process.exit(0);
}
