#!/usr/bin/env node
// harness-kind: cli（學習迴路的待處理清單工具，手動執行，不是 hook、不接線）
/**
 * 待你看（黃區）與待核（紅區、升格提案）清單的查看與處理。
 *
 * 【範本】由 /harness:init 複製到目標專案 `.claude/hooks/`，之後歸該專案自治（可自改；plugin 更新不會自動同步）。
 * 用法：
 *   node .claude/hooks/learn-pending.js list            列 pending（紅區含建議內容與出處）＋淘汰候選
 *   node .claude/hooks/learn-pending.js list --all      連已處理與綠區寫入也列
 *   node .claude/hooks/learn-pending.js approve <id>    黃區：保留寫入；紅區：標 approved 並印給 Claude 的執行指示（不改任何規則檔）
 *   node .claude/hooks/learn-pending.js reject <id>     黃／綠區：目標檔 hash 與寫入後相同才還原備份（新建的刪掉）；紅區：標 rejected
 *   node .claude/hooks/learn-pending.js revert <id>     黃／綠區：同 reject 的還原
 * 結束碼：0 成功；1 找不到 id／狀態不允許／hash 不符／取不到鎖／在 Claude 的工具裡呼叫 approve|reject|revert；2 用法錯。
 *
 * 核可只認使用者原話（設計稿 4.5、審查 R14）：偵測到 CLAUDECODE 環境變數（Claude Code 的工具執行的子程序會帶）時，
 * approve／reject／revert 一律拒絕，請使用者在提示列輸入「核可 <id>」「駁回 <id>」「還原 <id>」——由 learn-approve.js
 * （UserPromptSubmit hook）讀使用者這則訊息的原文執行同一套動作。list 不受限。
 *
 * 自行決定的細節：
 * - 「淘汰候選」從 learning/candidates.json 讀（由開場回報 hook 算好寫入；這支不重算，免得兩處試用期設定漂移）。
 * - list 的建議內容每行縮排印出，超過 LIST_CONTENT_MAX 字截斷（完整內容在 pending.json）。
 */
'use strict';
const lib = require('./learn-lib.js');

// ── init 填空區 ──────────────────────────────────────────────────────────────
// list 時每筆建議內容最多印幾個字。
const LIST_CONTENT_MAX = 1200;
// ────────────────────────────────────────────────────────────────────────────

const TYPE_TEXT = { write: '已寫入', 'write-review': '待你看', proposal: '待核', promotion: '升格提案' };

function list(all) {
  const P = lib.paths(lib.rootOf(__dirname));
  const pd = lib.readJson(P.pending, lib.emptyPending());
  const items = (pd.items || []).filter((x) => all || x.status === 'pending');
  const out = [];
  if (!items.length) out.push(all ? '（沒有任何項目）' : '（沒有待處理項目；加 --all 看已處理與綠區寫入）');
  for (const it of items) {
    out.push(it.id + ' | ' + (lib.LEVEL_TEXT[it.level] || it.level) + ' | ' + (TYPE_TEXT[it.type] || it.type) + ' | ' + it.status
      + ' | ' + (it.topic || '-') + ' | ' + it.target);
    out.push('    摘要：' + it.summary);
    if (it.evidence && it.evidence.length) out.push('    出處：' + it.evidence.join('、'));
    if (it.flags && it.flags.length) out.push('    標記：' + it.flags.join('、') + (it.flags.includes('destructive') ? '（內容含破壞性指令樣式）' : ''));
    if (it.checks && it.checks.length) out.push('    格式檢查：' + it.checks.join('；'));
    if (it.content && (it.type === 'proposal' || it.type === 'promotion')) {
      const c = [...it.content].length > LIST_CONTENT_MAX ? [...it.content].slice(0, LIST_CONTENT_MAX).join('') + '…（完整內容見 pending.json）' : it.content;
      out.push('    建議內容：');
      for (const l of c.split('\n')) out.push('      ' + l);
    }
    if (it.backup) out.push('    備份：learning/' + it.backup);
  }
  const cand = lib.readJson(P.candidates, null);
  if (cand && ((cand.items || []).length || (cand.rules || []).length)) {
    out.push('', '淘汰候選（' + cand.at + ' 算的；試用期 ' + cand.trialRequests + ' 個 request，只列不動）：');
    for (const k of cand.items || []) out.push('  - ' + k + '（零使用）');
    for (const k of cand.rules || []) out.push('  - ' + k + '（候選降級：試用期內一次都沒擋過）');
  }
  out.push('', '核可或駁回請使用者直接在提示列輸入「核可 <編號>」「駁回 <編號>」「還原 <編號>」。');
  console.log(out.join('\n'));
  return 0;
}

function main(argv) {
  const [cmd, arg] = argv;
  if (cmd === 'list') return list(argv.includes('--all'));
  if (!['approve', 'reject', 'revert'].includes(cmd) || !arg || !/^p-[\w-]+$/.test(arg)) {
    console.error('用法：node learn-pending.js list [--all] ｜ approve <id> ｜ reject <id> ｜ revert <id>（id 形如 p-20261009-01）');
    return 2;
  }
  if (process.env.CLAUDECODE) {
    const word = cmd === 'approve' ? '核可' : (cmd === 'reject' ? '駁回' : '還原');
    console.error('[learn-pending] 拒絕：' + cmd + ' 要由使用者本人決定，不能在 Claude 的工具裡執行。請使用者在提示列輸入「' + word + ' ' + arg + '」（例：「核可 ' + arg + '」或「駁回 ' + arg + '」）。');
    return 1;
  }
  const r = lib.pendingAction(lib.rootOf(__dirname), cmd, arg, 'cli');
  (r.code === 0 ? console.log : console.error)(r.text);
  return r.code;
}

try { process.exit(main(process.argv.slice(2))); } catch (e) {
  console.error('[learn-pending] ERROR: ' + ((e && e.message) || e) + (e && e.code === 'ELOCKED' ? '（請重跑）' : ''));
  process.exit(1);
}
