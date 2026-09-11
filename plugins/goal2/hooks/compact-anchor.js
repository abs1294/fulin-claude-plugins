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
  if (input.source && input.source !== 'compact') process.exit(0);

  const runDir = process.env.GOAL2_RUN_DIR;
  if (!runDir || !fs.existsSync(runDir)) process.exit(0);

  const read = (name) => { try { return fs.readFileSync(path.join(runDir, name), 'utf8').trim(); } catch (_) { return ''; } };
  const anchor = read('anchor.md');
  const progress = read('progress.md');
  if (!anchor && !progress) process.exit(0);

  // 記一筆，方便事後從 run 目錄看 hook 有沒有真的 fire
  try { fs.appendFileSync(path.join(runDir, 'compact-log.txt'), `${new Date().toISOString()} compact-anchor injected (anchor ${anchor.length} chars, progress ${progress.length} chars)\n`); } catch (_) {}

  const ctx = [
    '[goal2 壓縮後錨定] 上下文剛被壓縮。以下是本 run 的完成條件、任務全文與進度帳本，以此為準繼續，不要重做已完成項、不要偏離任務。',
    '',
    '===== anchor.md =====',
    anchor || '（無）',
    '',
    '===== progress.md（進度帳本，繼續前先讀，做完里程碑要更新）=====',
    progress || '（尚未建立：請先依 anchor.md 的帳本規則建立它）'
  ].join('\n');

  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: ctx } }));
  process.exit(0);
} catch (_) {
  process.exit(0);
}
