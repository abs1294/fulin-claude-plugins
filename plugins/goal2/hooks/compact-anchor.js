#!/usr/bin/env node
'use strict';
/**
 * goal2 壓縮後錨定 hook（SessionStart, matcher: compact）
 *
 * 問題：長任務跑到上下文滿、自動壓縮後，子程序常忘記最初目標或做到哪，成果漂移。
 * 做法：engine.js 起子程序時用 --settings 只對「那個子程序」掛本 hook，並設環境變數 GOAL2_RUN_DIR。
 *       壓縮一結束（SessionStart 的 source=compact），本 hook 把 run 目錄裡的
 *       anchor.md（完成條件＋任務全文＋帳本規則）與 progress.md（進度帳本）以 additionalContext 注回對話。
 *
 * 這是第三層保險。第一層是 anchor.md 已經以 --append-system-prompt-file 放進系統提示（每回合重送、壓縮碰不到）；
 * 第二層是引擎 prompt 規定每個里程碑更新 progress.md。本 hook 讓「壓縮後的第一個回合」立刻看到兩者，
 * 不必等 Claude 自己想起來去讀檔。
 *
 * 一律 fail-open：不是 compact、沒有 GOAL2_RUN_DIR、檔案缺、任何例外 → exit 0 不輸出。
 */
const fs = require('fs');
const path = require('path');

function readStdin() { try { return fs.readFileSync(0, 'utf8'); } catch (_) { return ''; } }

try {
  const raw = readStdin();
  let input = {};
  if (raw.trim()) { try { input = JSON.parse(raw); } catch (_) { process.exit(0); } }
  if (!input || typeof input !== 'object' || Array.isArray(input)) process.exit(0);
  if (input.hook_event_name && input.hook_event_name !== 'SessionStart') process.exit(0);
  // 嚴格要求 source === 'compact'：沒有 source 欄位（手動測試、其他事件誤接）也不注入，
  // 不能只靠 engine.js 那邊的 matcher 當唯一保險
  if (input.source !== 'compact') process.exit(0);

  const runDir = process.env.GOAL2_RUN_DIR;
  if (!runDir || !fs.existsSync(runDir)) process.exit(0);

  const read = (name) => { try { return fs.readFileSync(path.join(runDir, name), 'utf8').trim(); } catch (_) { return ''; } };
  const anchor = read('anchor.md');
  const progress = read('progress.md');
  if (!anchor && !progress) process.exit(0);

  // anchor.md 整份已經在系統提示裡（--append-system-prompt-file，壓縮碰不到），這裡不重送一遍——
  // 只抽「完成條件」那一節（最容易在壓縮摘要裡被改寫的東西）＋帳本＋提醒。
  // 取某個「## 標題」到下一個「## 」之間的內容（逐行掃，不用 regex 的 $——多行模式下會在第一行就停）
  // 節邊界：0.4.0 起 buildAnchor 在每節前放 <!-- goal2:sec=NAME --> 標記，任務書／條件自帶的「## 」標題不會誤切；
  // 舊版 anchor（沒標記）退回用固定標題文字切（只認 buildAnchor 那幾個標題的首次出現）
  const hasMarkers = /<!-- goal2:sec=/.test(anchor);
  const sectionByMarker = (name) => {
    const m = anchor.match(new RegExp(`<!-- goal2:sec=${name} -->\\n(?:## [^\\n]*\\n)?([\\s\\S]*?)(?=\\n<!-- goal2:sec=|$(?![\\s\\S]))`));
    return m ? m[1].trim() : '';
  };
  const TOP = ['## 工作目錄', '## 完成條件', '## 任務全文', '## 工作清單', '## 補充', '【進度帳本規則'];
  const sectionByHeading = (prefix) => {
    const lines = anchor.split('\n'); const out = []; let on = false; const seen = new Set();
    for (const l of lines) {
      const top = TOP.find((t) => l.startsWith(t) && !seen.has(t));
      if (top) { seen.add(top); if (on) break; on = top === prefix; continue; }
      if (on) out.push(l);
    }
    return out.join('\n').trim();
  };
  const condition = hasMarkers ? sectionByMarker('condition') : sectionByHeading('## 完成條件');
  const itemsRaw = hasMarkers ? sectionByMarker('items') : '';
  const items = itemsRaw.length > 8000 ? itemsRaw.slice(0, 8000) + '\n…（清單超過 8KB，其餘見系統提示錨定區）' : itemsRaw;
  // 任務書若外置（anchor 只放「先去讀某檔」），壓縮後最容易漏的就是那份檔的細節：把錨定區提到的檔案路徑列出來要求重讀
  const taskSection = hasMarkers ? sectionByMarker('task') : sectionByHeading('## 任務全文');
  // 檔案路徑：token 以 .md/.txt/.json/.yaml/.yml 結尾且後接邊界（空白／引號／各式括號／中英標點含頓號、冒號、問號）；
  // 含 :// 的是 URL 不算；必須含路徑分隔符或以 ~ 開頭；token 前面若緊貼中文也從路徑字元起算
  const SEP = '\\s"\'`()（）「」【】\\[\\],;，；、。：:？?!！<>';
  const scanText = taskSection.length > 30000 ? taskSection.slice(0, 30000) : taskSection;   // base64／超長任務書：regex 平方級會撞 hook 15 秒 timeout
  const tokens = scanText.match(new RegExp(`(?:[A-Za-z]:[\\\\/]|~[\\\\/]|\\.{1,2}[\\\\/]|[A-Za-z0-9_\\-\\u4e00-\\u9fff.]+[\\\\/])[^${SEP}]*\\.(?:md|txt|json|yaml|yml)(?=[${SEP}]|$)`, 'g')) || [];
  const filePaths = Array.from(new Set(tokens.filter((t) => t.length <= 400 && !/:\/\//.test(t)))).slice(0, 12);
  const progressOut = progress.length > 20000 ? '（帳本超過 20KB，只注回最後 20KB；完整檔在 run 目錄 progress.md）\n…' + progress.slice(-20000) : progress;

  // 記一筆，方便事後從 run 目錄看 hook 有沒有真的 fire
  try { fs.appendFileSync(path.join(runDir, 'compact-log.txt'), `${new Date().toISOString()} compact-anchor injected (condition ${condition.length} chars, progress ${progress.length} chars, task files ${filePaths.length})\n`); } catch (_) {}

  const ctx = [
    '[goal2 壓縮後錨定] 上下文剛被壓縮。完成條件、任務全文、工作清單與帳本規則都還在你的系統提示「goal2 錨定」區塊（壓縮碰不到它），先重讀那一區再動手；以下只重申最容易被壓縮摘要改寫的兩樣東西。不要重做已完成項、不要偏離任務。',
    '',
    '===== 完成條件（逐項皆為真才算達成）=====',
    condition || '（見系統提示錨定區）',
    '',
    ...(items ? ['===== 項目清單（完成條件對著它算，每一項都要處理到）=====', items, ''] : []),
    ...(filePaths.length ? [`===== 任務書外置檔案（壓縮後細節最容易丟，繼續前先重讀）=====`, ...filePaths, ''] : []),
    '===== progress.md（進度帳本，繼續前先讀，做完里程碑要更新）=====',
    progressOut || '（尚未建立：請先依錨定區的帳本規則建立它）'
  ].join('\n');

  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: ctx } }));
  process.exit(0);
} catch (_) {
  process.exit(0);
}
