#!/usr/bin/env node
// SessionStart：學習迴路的開場一行回報（含淘汰候選）；同時登記新條目、算淘汰候選、清理 90 天前的紀錄。
//
// 【範本】由 /harness:init 複製到目標專案 `.claude/hooks/`，之後歸該專案自治（可自改；plugin 更新不會自動同步）。
// 接線（目標專案 .claude/settings.json）：
//   "SessionStart": [{ "hooks": [{ "type": "command",
//     "command": "node \"<專案絕對路徑>/.claude/hooks/learn-session-report.js\"", "timeout": 15, "statusMessage": "學習迴路：整理上次反思的結果" }] }]
//
// 輸出（SessionStart 的純文字 stdout 會進 context）：有東西才印一行，例如
//   [learn] 上次反思（10/09 14:20）寫入 2 筆（db-login-lockout：連庫前先確認帳號；…）、待你看 1 筆、待核 3 筆（含升格提案 1 筆）、
//   被拒 1 筆（格式 1）、淘汰候選 2 筆——清單：node .claude/hooks/learn-pending.js list；核可或駁回請直接在提示列輸入「核可 <編號>」「駁回 <編號>」
// 待你看／待核不為 0 時改印「本回合先用 AskUserQuestion 逐項問使用者」的指示，後面每項一行「編號｜類型｜主題｜摘要」，
// 最後一行保留提示列輸入的替代寫法；使用者點選的答案由 learn-approve.js（PostToolUse matcher AskUserQuestion）執行。
// - 上次 run 失敗（子程序錯、解析失敗）也印；反思暫停中印一次「反思暫停到 <日期>」——反沉默。
// - 上次 run 的結果只印一次（印過就把 last-run.json 的 reported 設 true）；待你看／待核／淘汰候選只要不是 0 每次都印。
// - 全部為 0 且上次 run 已回報過 → 不印任何東西。
// 順手做（設計稿 2.7、5 節）：
// - 登記：memory 目錄、`.claude/skills/*/`、兩支規則引擎 RULES／CHECKS 陣列裡的規則 id，沒登記過的補登記（試用期從登記起算）。
// - 淘汰候選：request 數 - 登記時的 request 數 ≥ TRIAL_REQUESTS 且 view+use=0 的 memory 與專案 skill
//   （MEMORY.md 索引行標 ⭐⭐ 以上的不列）；規則 id 過了試用期且 hits=0 的列「候選降級」。只列不動，清單寫進 learning/candidates.json。
// - 清理 learning/ 底下 90 天前的 runs、backups、session 檔（pending 引用中的備份不刪）。
//
// 遞迴防護：HARNESS_LEARN_CHILD 或 COMPACT_HANDOFF_CHILD 存在時直接 exit 0，不印。
// fail-open：任何例外 exit 0，stdout 印一行 `[learn-session-report] ERROR: …`（純文字會進 context，讓人知道壞了）。
//
// 自行決定的細節：
// - 上次 run 成功但沒有任何提案時，印一次「上次反思（…）沒有新提案」（設計稿只規定「全部為 0 且已回報過」不印）。
// - 登記或淘汰計算取不到鎖時略過這一段，回報其餘部分。

'use strict';
const fs = require('fs');
const path = require('path');

// ── init 填空區 ──────────────────────────────────────────────────────────────
// 淘汰試用期：登記後經過幾個 request 仍零使用，才列為淘汰候選。
const TRIAL_REQUESTS = 200;
// 一行回報最多逐筆列幾筆綠區寫入（其餘寫「…等 N 筆」）。
const SHOW_WRITES = 3;
// ────────────────────────────────────────────────────────────────────────────

const REASON_TEXT = { format: '格式', secret: '帳密', injection: '注入', exfil: '外洩', evidence: '出處', clue: '線索', verbatim: '抄原文',
  conflict: '矛盾未調和', 'over-limit': '超量', target: '目標不合法', io: '寫入失敗' };
const TYPE_TEXT = { 'write-review': '待你看', proposal: '待核', promotion: '升格提案' };

try {
  if (process.env.HARNESS_LEARN_CHILD || process.env.COMPACT_HANDOFF_CHILD) process.exit(0);
  try { fs.readFileSync(0, 'utf8'); } catch {}
  const lib = require('./learn-lib.js');
  const root = lib.rootOf(__dirname);
  const P = lib.paths(root);

  try { lib.cleanup(root); } catch {}
  let cand = { items: [], rules: [] };
  try {
    const usage = lib.registerAll(root);
    cand = lib.computeCandidates(root, usage, TRIAL_REQUESTS);
    lib.writeJson(P.candidates, Object.assign({ at: lib.nowIso(), trialRequests: TRIAL_REQUESTS, requests: usage.requests || 0 }, cand));
  } catch (e) { if (!(e && e.code === 'ELOCKED')) throw e; }

  const parts = [];
  const last = lib.readJson(P.lastRun, null);
  const runRef = (r) => 'learning/runs/' + r.run + '.json';
  if (last && last.run && !last.reported) {
    const d = new Date(last.endedAt || last.startedAt || Date.now());
    const when = lib.pad(d.getMonth() + 1) + '/' + lib.pad(d.getDate()) + ' ' + lib.pad(d.getHours()) + ':' + lib.pad(d.getMinutes());
    if (last.child && last.child.ok === false) {
      parts.push('上次反思失敗：子程序失敗（' + String(last.child.error || '').slice(0, 80) + '；詳見 ' + runRef(last) + '）');
    } else if (last.parse && last.parse.ok === false) {
      parts.push('上次反思失敗：解析失敗（詳見 ' + runRef(last) + '）');
    } else if (last.landing && last.landing.ok === false) {
      parts.push('上次反思失敗：落地失敗，已回復寫入前狀態（' + String(last.landing.error || '').slice(0, 80) + '；詳見 ' + runRef(last) + '）');
    } else {
      const res = last.results || {};
      const gw = Array.isArray(last.greenWrites) ? last.greenWrites : [];
      if (res.written) {
        const shown = gw.slice(0, SHOW_WRITES).map((g) => (g.topic ? g.topic + '：' : '') + g.summary);
        parts.push('上次反思（' + when + '）寫入 ' + res.written + ' 筆（' + shown.join('；') + (res.written > shown.length ? '；…等 ' + res.written + ' 筆' : '') + '）');
      } else if (!res.pendingReview && !res.pendingApproval && !res.rejected) {
        parts.push('上次反思（' + when + '）沒有新提案');
      } else parts.push('上次反思（' + when + '）');
      if (res.rejected) {
        const rr = Object.entries(last.rejectReasons || {}).filter(([, n]) => n > 0).map(([k, n]) => (REASON_TEXT[k] || k) + ' ' + n);
        parts.push('被拒 ' + res.rejected + ' 筆（' + rr.join('、') + '）');
      }
      for (const n of last.notes || []) parts.push(n);
    }
  }
  const pd = lib.readJson(P.pending, lib.emptyPending());
  const items = pd.items || [];
  const review = items.filter((x) => x.type === 'write-review' && x.status === 'pending').length;
  const red = items.filter((x) => (x.type === 'proposal' || x.type === 'promotion') && x.status === 'pending');
  const promos = red.filter((x) => x.type === 'promotion').length;
  if (review) parts.push('待你看 ' + review + ' 筆');
  if (red.length) parts.push('待核 ' + red.length + ' 筆' + (promos ? '（含升格提案 ' + promos + ' 筆）' : ''));

  const pause = lib.readJson(P.pause, null);
  const pauseActive = pause && pause.until && pause.until > lib.today();
  if (pauseActive && !pause.reported) parts.push('反思暫停到 ' + pause.until + '：' + (pause.lastError || '連續失敗'));

  const nCand = cand.items.length + cand.rules.length;
  if (nCand) parts.push('淘汰候選 ' + nCand + ' 筆' + (cand.rules.length ? '（含規則候選降級 ' + cand.rules.length + ' 筆）' : ''));

  // 有待你看／待核時叫 Claude 本回合就用 AskUserQuestion 逐項問（2026-10-17）：只印一句「請在提示列輸入核可 <編號>」
  // 實際上沒有人照打，黃區寫入擱著沒人審。使用者點選的答案由 learn-approve.js（PostToolUse）執行；提示列輸入仍可用。
  const open = items.filter((x) => x.status === 'pending' && TYPE_TEXT[x.type]);
  if (parts.length && open.length) {
    console.log('[learn] ' + parts.join('、') + '——本回合先用 AskUserQuestion 把下列項目逐項問使用者（一項一題，題目寫「編號｜類型｜主題｜摘要」，'
      + '選項三個：「核可 <編號>」「駁回 <編號>」「稍後」；一次最多 4 題，超過分批問）。使用者選完由 learn-approve.js 照 learn-pending.js 的規則執行，'
      + '不要自己跑 learn-pending.js approve／reject（核可只認使用者本人，在 Claude 的工具裡跑會被拒）：');
    for (const x of open) console.log('  ' + x.id + '｜' + TYPE_TEXT[x.type] + '｜' + (x.topic || '-') + '｜' + x.summary);
    console.log('（替代：使用者也可以直接在提示列輸入「核可 <編號>」「駁回 <編號>」；詳細內容：node .claude/hooks/learn-pending.js list）');
  } else if (parts.length) {
    console.log('[learn] ' + parts.join('、') + '——清單：node .claude/hooks/learn-pending.js list；核可或駁回請直接在提示列輸入「核可 <編號>」「駁回 <編號>」');
  }
  if (last && last.run && !last.reported) {
    try {
      lib.updateJson(P.learn, 'last-run.json', {}, (o) => { if (o.run === last.run) o.reported = true; });
      const rp = path.join(P.runs, last.run + '.json');
      const rr = lib.readJson(rp, null);
      if (rr) { rr.reported = true; lib.writeJson(rp, rr); }
    } catch {}
  }
  if (pauseActive && !pause.reported) {
    try { lib.updateJson(P.learn, 'pause.json', {}, (o) => { o.reported = true; }); } catch {}
  }
  process.exit(0);
} catch (e) {
  console.log('[learn-session-report] ERROR: 開場回報故障——' + ((e && e.message) || e) + '（學習迴路 hook 鏽蝕要修，勿靜默忽略）');
  process.exit(0);
}
