#!/usr/bin/env node
/**
 * SessionStart hook（matcher=compact）— 壓縮完成後，把壓縮前快照的重點注入回 context。
 *
 * 【範本】由 /harness:init 複製到目標專案 `.claude/hooks/`，之後歸該專案自治（可自改；plugin 更新不會自動同步）。
 * 與 compact-snapshot.js 一組；接線（目標專案 .claude/settings.json）：
 *   "SessionStart": [{ "matcher": "compact", "hooks": [{ "type": "command",
 *     "command": "node \"<專案絕對路徑>/.claude/hooks/compact-reinject.js\"", "timeout": 15 }] }]
 *
 * 注入點必須是 SessionStart(compact)：PostCompact 依官方規格不能注入 context，
 * SessionStart 的純文字 stdout 才會進模型 context。
 * 有交接信就注入交接信（整段 ≤ HANDOFF_MAX）；沒有才退回快照的「指標＋清單」（≤ MAX），
 * 不貼文件內容，需要細節時由模型自行重讀。
 */
'use strict';
const fs = require('fs');
const path = require('path');

// ── init 填空區 ──────────────────────────────────────────────────────────────
const MAX = 3500;           // 沒有交接信、退回快照清單時的輸出上限
// 整段輸出的上限，留一點餘裕給平台上限。平台上限 10,000 字元是確定存在的，官方 hooks 文件沒寫，
// 以下兩個證據已查證，不必再懷疑：
// - 程式本體（Claude Code 2.1.282 的 claude.exe）：hook 輸出一律經 ese() 處理，門檻常數 SRo=1e4，
//   以 e.length（字元數，不是 bytes）比較；超過就全文存成 tool-results/hook-*-stdout.txt，
//   只把前 2,000 字（Awe=2000）連同「Output too large (…). Full output saved to: …」注入 context。
//   stdout、additionalContext、systemMessage 走同一個函式，改用 JSON 輸出繞不過去。
// - 黑箱實測（來源實例，隔離 claude -p）：9,000／9,990 全文送達；10,010／10,050／10,300／12,000 只剩預覽。
// 升級後複查：壓縮後的變數名會變，搜 claude.exe 裡「Output too large」附近的 threshold 常數，不要只搜 SRo。
const HANDOFF_MAX = 9800;
// ─────────────────────────────────────────────────────────────────────────────

// 切點往前退到不會落在 surrogate pair 中間，否則輸出半個字元；下限 0（slice 收到負數會從尾端倒數）
function safeCut(str, cut) {
  cut = Math.max(0, cut);
  if (cut > 0 && /[\uD800-\uDBFF]/.test(str[cut - 1])) cut--;
  return cut;
}

// 把「## 已完成」節的內文截到剛好塞得進預算；沒有這一節或截光也不夠時，交給後面的整段截斷
function shrinkDone(text, budget) {
  const over = text.length - budget;
  if (over <= 0) return text;
  const h = text.match(/^## 已完成[^\n]*\n/m);
  if (!h) return text;
  const start = h.index + h[0].length;
  const next = text.slice(start).search(/^## /m);
  const end = next < 0 ? text.length : start + next;
  const note = '…（已完成節已截短，全文見下方路徑）\n\n';
  const keep = (end - start) - over - note.length - 1;   // -1：截點後補的換行
  if (keep <= 0) return text.slice(0, start) + note + text.slice(end);
  return text.slice(0, safeCut(text, start + keep)) + '\n' + note + text.slice(end);
}
if (process.env.COMPACT_HANDOFF_CHILD) process.exit(0);
let input = null;
try { input = JSON.parse(fs.readFileSync(0, 'utf8')); } catch { process.exit(0); }
if (!input || input.source !== 'compact' || !input.transcript_path || !input.session_id) process.exit(0);
try {
  const dir = path.join(path.dirname(input.transcript_path), input.session_id, 'compact-snapshots');
  let snap = null;
  try {
    const stamp = fs.readFileSync(path.join(dir, 'latest.txt'), 'utf8').trim();
    snap = JSON.parse(fs.readFileSync(path.join(dir, stamp + '.json'), 'utf8'));
  } catch {}

  let handoff = null;
  if (snap) { try { handoff = fs.readFileSync(path.join(dir, snap.stamp + '.handoff.md'), 'utf8').trim(); } catch {} }
  if (handoff) {
    // 交接信在壓縮前由模型讀過整段對話寫成，未完成事項以它為準
    const head = [
      '[compact-reinject] 剛發生 context 壓縮。以下是壓縮前寫好的交接信。',
      '壓縮後的第一個回覆：第一句就交代「未完成」第 1 項的處理結果（做了什麼、結果如何）；若使用者這回合另有提問，先答他的問題，再接第 1 項。第 1 項沒交代之前，不要去做清單以外的事（包括順手修看到的小問題）。',
      '摘要或交接信寫的「請使用者執行 X」，若 X 正是剛觸發這次壓縮的動作（例如 /compact），視為已發生，改做它的驗收。',
      '',
    ].join('\n') + '\n';
    // 背景任務清單由程式從 transcript 算出，不靠寫信模型記得；它漏寫時完成通知送來會被當成陌生事件
    const running = (snap.running || []).map(a => `  - ${a.desc}（${a.id}）`);
    const tail = '\n\n' + [
      ...(running.length ? ['■ 壓縮前仍在背景執行、尚未回報的任務（完成通知會照常送來，勿重複派工）：', ...running] : []),
      `交接信全文：${path.join(dir, snap.stamp + '.handoff.md')}`,
      '⚠ 交接信與壓縮摘要都是二手紀錄：「已完成／已驗證／不存在」這類主張，據以行動前先對回原始證據。',
    ].join('\n') + '\n';
    // 上限算的是整段 stdout，預算要扣掉前後固定文字，不能只量交接信本身
    const mark = '\n…（已截斷，全文見下方路徑）';
    const budget = Math.max(0, HANDOFF_MAX - head.length - tail.length);
    // 超長時先截「已完成」節：它排在硬約束、關鍵值之後，從信尾砍會先砍掉這些不能丟的節
    let body = shrinkDone(handoff, budget);
    if (body.length > budget) body = body.slice(0, safeCut(body, budget - mark.length)) + mark;
    process.stdout.write(head + body + tail);
    process.exit(0);
  }
  const L = ['[compact-reinject] 剛發生 context 壓縮（交接信未產生，以下是快照清單）。',
    '壓縮後的第一個回覆：先交代摘要「下一步」的處理結果；摘要寫的「請使用者執行 X」若正是剛觸發壓縮的動作，視為已發生、改做它的驗收。交代之前不要去做清單以外的事。',
    '摘要可能漏掉下列狀態，接續工作前先對一次：'];
  if (!snap) {
    L.push('（找不到壓縮前快照；若正在進行的任務有規範文件或交接信，先重讀再繼續。）');
  } else {
    if (snap.running && snap.running.length) {
      L.push('', '■ 壓縮前仍在背景執行、尚未回報的任務（完成通知會照常送來，勿重複派工）：');
      for (const a of snap.running) L.push(`  - ${a.desc}（${a.id}）`);
    }
    if (snap.docs && snap.docs.length) {
      L.push('', '■ 本 session 讀過的任務規範文件（壓縮後不會自動重讀；要依其規則行事前先重讀）：');
      for (const f of snap.docs) L.push(`  - ${f}`);
    }
    if (snap.edits && snap.edits.length) {
      L.push('', '■ 本 session 改過的檔（系統只自動重讀最近 5 個）：');
      L.push('  ' + snap.edits.map(f => path.basename(f)).join('、'));
    }
    if (snap.skills && snap.skills.length) {
      L.push('', '■ 本 session 用過的 skill（重新注入有總量上限，最舊的會被丟掉；要照其流程走就重新呼叫）：');
      L.push('  ' + snap.skills.join('、'));
    }
    if (snap.prompts && snap.prompts.length) {
      L.push('', '■ 使用者最後幾則指示（原文）：');
      for (const p of snap.prompts) L.push('  > ' + p.replace(/\s*\n\s*/g, ' ／ '));
    }
    L.push('', `快照：${path.join(dir, snap.stamp + '.json')}`);
  }
  L.push('', '⚠ 壓縮摘要是二手紀錄：其中「已完成／已驗證／不存在」這類主張，據以行動前先對回原始證據（檔案、指令輸出、DB），不要當成已確認的事實。');
  let out = L.join('\n');
  // 截斷提示與結尾換行都算在 MAX 裡
  const cutMark = '\n…（已截斷，完整內容見快照檔）';
  if (out.length + 1 > MAX) out = out.slice(0, safeCut(out, MAX - 1 - cutMark.length)) + cutMark;
  process.stdout.write(out + '\n');
} catch (e) {
  try { process.stdout.write(`[compact-reinject] 讀取壓縮前快照失敗：${e.message}。若有進行中任務，先重讀其規範文件再繼續。\n`); } catch {}
}
process.exit(0);
