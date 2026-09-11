#!/usr/bin/env node
// goal 主工具（goal2 plugin 的 goal skill）：把「可測量完成條件 + 任務」交給 Claude Code 官方 /goal 引擎，
// 在本機另起一個 headless session（claude -p）跑到條件達成為止。
//
// 為什麼不是 cron、不是直接送 /goal：Claude 自己輸入不了斜線指令；2.1.196 起排程 fire 的 prompt 也不再解析
// slash command。唯一可由 Claude 啟動引擎的入口是 `claude -p "/goal …"`（見 ../../lib/engine.js 檔頭）。
//
// 用法（兩段式）：
//   node goal.js --prompt-file <path> --goal "<可測量完成條件>"   # 準備：建 run 目錄、落 prompt、輸出 run_command 與確認 timer cron
//   node goal.js --run <run_dir>                                 # 執行：起引擎、阻塞到完成、輸出 summary JSON（skill 用 Bash 背景執行）
//   node goal.js --show-config
//   echo "<任務原文>" | node goal.js --goal "<條件>"                # 準備階段也可從 stdin 讀任務
//
// 設定檔（選用）：~/.claude/goal2/config.json，結構與驗證見 ../../lib/config.js。範本：plugin 根層 config.example.json。
//
// 輸出：
//   準備：{ ok, mode:"prepared", run_dir, run_id, prompt_path, run_command, confirm_timeout_minutes, confirm_timer_cron,
//          confirm_timer_target_local, cwd, sessionId, config_path, config_loaded, goal_overflow, goal_line_length, final_prompt }
//   執行：{ ok, mode:"ran", …engine summary（goal_set / goal_achieved / continuations / num_turns / result_text / stream_path…）,
//          wtf: { installed, version, skill_md, terminal_width } }
'use strict';
const fs = require('fs');
const path = require('path');

function fail(msg) {
  console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
  process.exit(1);
}

// --- plugin 共用 lib（__dirname 對 symlink 取真身路徑，symlink / plugin cache 兩種安裝都成立）---
const LIB = path.join(__dirname, '..', '..', 'lib');
let buildGoalHead, dateToCron, ceilToMinute, loadConfig, prepareRun, runEngine, detectWtf;
try {
  ({ buildGoalHead } = require(path.join(LIB, 'goal-head.js')));
  ({ dateToCron, ceilToMinute } = require(path.join(LIB, 'cron-time.js')));
  ({ loadConfig } = require(path.join(LIB, 'config.js')));
  ({ prepareRun, runEngine, detectWtf } = require(path.join(LIB, 'engine.js')));
} catch (e) {
  fail(`找不到 plugin 共用 lib（${LIB}）：本 skill 須整個 plugin 一起安裝（/plugin install goal2@fulin-plugins）或 symlink 指向 monorepo 內的 skill 目錄，不可只複製 skill 資料夾。` + e.message);
}

// --- 0. 設定檔 ---
let cfg;
try { cfg = loadConfig(); } catch (e) { fail(e.message); }
const goalCfg = cfg.config.goal;
const engineCfg = cfg.config.engine;

// --- 1. 參數 ---
const args = process.argv.slice(2);
let promptFile = null;
let goalCondition = null;
let runDir = null;
let showConfig = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--prompt-file') promptFile = args[++i];
  else if (a === '--goal') goalCondition = args[++i];
  else if (a === '--run') runDir = args[++i];
  else if (a === '--show-config') showConfig = true;
  else if (/^\d+$/.test(a)) fail(`goal.js 不接受裸數字參數「${a}」（delaylocal 的裸數字是 bufferSeconds，本工具沒有這個概念）。`);
  else fail(`未知參數：${a}`);
}

if (showConfig) {
  console.log(JSON.stringify({ ok: true, mode: 'show-config', config_path: cfg.path, config_loaded: cfg.loaded, engine: engineCfg, goal: goalCfg, delaylocal: cfg.config.delaylocal, wtf: detectWtf() }, null, 2));
  process.exit(0);
}

// --- 2. 執行模式：--run <run_dir> ---
if (runDir) {
  if (!fs.existsSync(path.join(runDir, 'prompt.txt'))) fail(`--run 目錄不存在或缺 prompt.txt：${runDir}`);
  runEngine(runDir, engineCfg).then((summary) => {
    console.log(JSON.stringify({ mode: 'ran', ...summary, wtf: detectWtf() }, null, 2));
    process.exit(summary.ok ? 0 : 1);
  }).catch((e) => fail(`引擎執行失敗：${e.message}`));
} else {
  // --- 3. 準備模式：任務原文 + 完成條件 → run 目錄 ---
  let userPrompt = '';
  if (promptFile) {
    try { userPrompt = fs.readFileSync(promptFile, 'utf8'); } catch (e) { fail(`讀 --prompt-file 失敗：${e.message}`); }
    // 中繼檔是一次性消耗品：讀完立刻刪除，避免殘留被其他流程誤讀 / 覆寫競態。
    try { fs.unlinkSync(promptFile); } catch (_) {}
  } else {
    try { userPrompt = fs.readFileSync(0, 'utf8'); } catch (_) { userPrompt = ''; }
  }
  userPrompt = userPrompt.replace(/\r\n/g, '\n').trim();
  if (!userPrompt) fail('任務原文為空：請用 --prompt-file <path> 或 stdin 提供要做的事。');
  if (!goalCondition || !goalCondition.trim()) fail('需提供完成條件 --goal "<可測量完成條件>"。請先把完成條件 propose 給使用者、確認（或逾時採納）後再準備。');

  // 第一行 = /goal <完成條件>（3900 門檻 / 指針句 / 步驟 0 下放的邏輯在 lib/goal-head.js，與 delaylocal 共用）。
  // 無 tail：本 skill 沒有「必做收尾」要納入條件（不發 LINE；最終回報由主 session 依 SKILL 步驟做）。
  const { goalLine, goalFullBlock, overflow, length } = buildGoalHead({ condition: goalCondition });

  const finalPrompt = `${goalLine}

（上面第一行是 goal 完成條件。下面是達成它要依序完成的工作清單，當作你的執行指引；全程繁體中文、無人值守：不停下來問使用者、需要決定時自己選風險最小做法、做到完成。）

工作清單（依序）：
${goalFullBlock}1. [執行任務] 完成以下任務（持續做到完成；遇真正 blocker 先把其餘能做的做完再記錄）：
${userPrompt}
2. [收尾] 完成條件達成後，最後一則回覆只寫一段簡短文字：做了什麼、怎麼驗證的（附實際指令輸出或檔案內容）、未完成項（沒有就寫「無」）。這段會被主 session 讀取當成最終回報素材。不要追加任何提問或 offer。`;

  const cwd = process.cwd();
  const { runDir: rd, runId, promptPath } = prepareRun({ skill: 'goal', prompt: finalPrompt, cwd, meta: { condition: goalCondition, overflow } });

  // 確認逾時 timer 的 cron：現在 + confirmTimeoutMinutes，向上取整到整分（cron 是分鐘粒度，避免只剩幾秒）
  const now = Math.floor(Date.now() / 1000);
  const confirmTarget = ceilToMinute(now + goalCfg.confirmTimeoutMinutes * 60);
  const confirmD = new Date(confirmTarget * 1000);
  const runCommand = `node "${path.resolve(__filename)}" --run "${rd}"`;

  console.log(JSON.stringify({
    ok: true,
    mode: 'prepared',
    run_dir: rd,
    run_id: runId,
    prompt_path: promptPath,
    run_command: runCommand,
    confirm_timeout_minutes: goalCfg.confirmTimeoutMinutes,
    confirm_timer_cron: dateToCron(confirmD),
    confirm_timer_target_local: confirmD.toLocaleString(),
    confirm_timer_fire_in_seconds: confirmTarget - now,
    cwd,
    sessionId: process.env.CLAUDE_CODE_SESSION_ID || null,
    engine: engineCfg,
    config_path: cfg.path,
    config_loaded: cfg.loaded,
    goal_overflow: overflow,
    goal_line_length: length,
    final_prompt: finalPrompt
  }, null, 2));
}
