#!/usr/bin/env node
// goal 主工具（goal2 plugin 的 goal skill）：把「可測量完成條件 + 任務」交給 Claude Code 官方 /goal 引擎，
// 在本機另起一個 headless session（claude -p）跑到條件達成為止。
//
// 為什麼不是 cron、不是直接送 /goal：Claude 自己輸入不了斜線指令；2.1.196 起排程 fire 的 prompt 也不再解析
// slash command。唯一可由 Claude 啟動引擎的入口是 `claude -p "/goal …"`（見 ../../lib/engine.js 檔頭）。
//
// 用法（兩段式）：
//   node goal.js --prompt-file <path> --goal "<可測量完成條件>"   # 準備：建 run 目錄、落 prompt、輸出 run_command 與確認 timer cron
//   node goal.js --start <run_dir>                               # 執行：把 runner 起成獨立程序（不受背景 Bash 2 小時上限、對話關掉也照跑），立刻返回
//   node goal.js --wait <run_dir> [--minutes 100]                # 等：skill 用 Bash 背景執行；結束就回結果，逾時回「還在跑」再接著等
//   node goal.js --run <run_dir>                                 # 內部：runner 本體，起引擎、阻塞到完成、寫 result.json（由 --start 起）
//   node goal.js --pending [--session <id>]                      # 看板用：沒人等、該送回原對話的 run
//   node goal.js --claim|--release <run_dir> --by <誰>           # 看板用：搶／放回報權（只回報一次）
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

let versionFields = {}; // lib 載入後填入 plugin_version / plugin_root，讓錯誤輸出也看得出版本
function fail(msg) {
  console.log(JSON.stringify({ ok: false, error: msg, ...versionFields }, null, 2));
  process.exit(1);
}

// --- plugin 共用 lib（__dirname 對 symlink 取真身路徑，symlink / plugin cache 兩種安裝都成立）---
const LIB = path.join(__dirname, '..', '..', 'lib');
let buildGoalHead, dateToCron, ceilToMinute, loadConfig, prepareRun, runEngine, stopRun, runStatus, listRuns, pruneRuns, detectWtf, selfSufficiency, inspectCwd, buildAnchor, ledgerRules, pluginVersion, PLUGIN_ROOT;
let startDetached, waitRun, claimReport, releaseReport, pendingReports, reportMessage, parentSession;
try {
  ({ buildGoalHead } = require(path.join(LIB, 'goal-head.js')));
  ({ dateToCron, ceilToMinute } = require(path.join(LIB, 'cron-time.js')));
  ({ loadConfig } = require(path.join(LIB, 'config.js')));
  ({ prepareRun, runEngine, stopRun, runStatus, listRuns, pruneRuns, detectWtf, selfSufficiency, inspectCwd, buildAnchor, ledgerRules, pluginVersion, PLUGIN_ROOT, startDetached, waitRun, claimReport, releaseReport, pendingReports, reportMessage, parentSession } = require(path.join(LIB, 'engine.js')));
} catch (e) {
  fail(`找不到 plugin 共用 lib（${LIB}）：本 skill 須整個 plugin 一起安裝（/plugin install goal2@fulin-plugins）或 symlink 指向 monorepo 內的 skill 目錄，不可只複製 skill 資料夾。` + e.message);
}
// 每個 JSON 輸出都帶版本與路徑：主 session 才看得出「載入的是 cache 舊版還是 repo 工作樹」
const VERSION_FIELDS = { plugin_version: pluginVersion(), plugin_root: PLUGIN_ROOT };
versionFields = VERSION_FIELDS;

// --- 0a. 清掉超過 7 天的 goal-input-*／goal-cond-* 中繼檔（失敗路徑會保留它們，避免無限累積）---
try {
  const dir = require('os').tmpdir(); const cutoff = Date.now() - 7 * 86400e3;
  for (const name of fs.readdirSync(dir)) { if (!/^goal-(input|cond)-/.test(name)) continue; const fp = path.join(dir, name); try { const st = fs.statSync(fp); if (st.isFile() && st.mtimeMs < cutoff) fs.unlinkSync(fp); } catch (_) {} }
} catch (_) {}

// --- 0. 設定檔 ---
let cfg;
try { cfg = loadConfig(); } catch (e) { fail(e.message); }
const goalCfg = cfg.config.goal;
const engineCfg = cfg.config.engine;

// --- 1. 參數 ---
const args = process.argv.slice(2);
let promptFile = null;
let goalCondition = null;
let goalFile = null;
let runDir = null;
let stopDir = null;
let forceStop = false;
let statusDir = null;
let showConfig = false;
let cwdArg = null;
let listMode = false;
let pruneMode = false, pruneDry = false, pruneHours = 24;
let startDir = null, waitDir = null, waitMinutes = 100, pendingMode = false, sessionFilter = null, claimDir = null, releaseDir = null, byWho = null;
const dirArg = (flag, v) => { if (!v || v.startsWith('--')) fail(`${flag} 後面要接 run 目錄路徑`); return v; };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--prompt-file') promptFile = args[++i];
  else if (a === '--goal') goalCondition = args[++i];
  else if (a === '--goal-file') goalFile = args[++i];   // 條件含引號／$／反引號時用檔案傳，避免 shell 改寫
  else if (a === '--cwd') cwdArg = args[++i];
  else if (a === '--list') listMode = true;
  else if (a === '--prune') pruneMode = true;
  else if (a === '--dry-run') pruneDry = true;
  else if (a === '--keep-hours') { const v = args[++i]; if (!/^\d+$/.test(String(v))) fail(`--keep-hours 需為整數（收到：${v}）`); pruneHours = parseInt(v, 10); }
  else if (a === '--run') runDir = args[++i];            // 內部用：runner 本體（由 --start 起成獨立程序；直接在背景 Bash 跑會受 2 小時上限、對話關掉就一起死）
  else if (a === '--start') startDir = dirArg(a, args[++i]);
  else if (a === '--wait') waitDir = dirArg(a, args[++i]);
  else if (a === '--minutes') { const v = args[++i]; if (!/^\d+$/.test(String(v)) || +v < 1 || +v > 110) fail(`--minutes 需為 1–110 的整數（背景 Bash 最長 120 分鐘，要留餘裕；收到：${v}）`); waitMinutes = parseInt(v, 10); }
  else if (a === '--pending') pendingMode = true;
  else if (a === '--session') sessionFilter = args[++i];
  else if (a === '--claim') claimDir = dirArg(a, args[++i]);
  else if (a === '--release') releaseDir = dirArg(a, args[++i]);
  else if (a === '--by') byWho = args[++i];
  else if (a === '--stop') { stopDir = args[++i]; if (!stopDir || stopDir.startsWith('--')) fail('--stop 後面要接 run 目錄路徑'); }
  else if (a === '--force') forceStop = true;   // 與 --stop 併用：程序狀態不明時只把狀態收成 stopped、不殺程序
  else if (a === '--status') statusDir = args[++i];
  else if (a === '--show-config') showConfig = true;
  else if (/^\d+$/.test(a)) fail(`goal.js 不接受裸數字參數「${a}」（delaylocal 的裸數字是 bufferSeconds，本工具沒有這個概念）。`);
  else fail(`未知參數：${a}`);
}

if (showConfig) {
  console.log(JSON.stringify({ ok: true, mode: 'show-config', ...VERSION_FIELDS, config_path: cfg.path, config_loaded: cfg.loaded, engine: engineCfg, goal: goalCfg, delaylocal: cfg.config.delaylocal, wtf: detectWtf() }, null, 2));
  process.exit(0);
}

// --- 1a. 列表 / 安全清理 ---
if (listMode) {
  let runs; try { runs = listRuns(); } catch (e) { fail(`列出 runs 失敗：${e.message}`); }
  console.log(JSON.stringify({ ok: true, mode: 'list', ...VERSION_FIELDS, runs }, null, 2));
  process.exit(0);
}
if (pruneMode) {
  // 唯一允許的清理方式：只清已結束且程序不在、或 running 但程序早已死／pid 被重用、或 prepared 從未啟動、或壞目錄，且都超過 keep-hours；活著的一律不碰
  let r; try { r = pruneRuns({ keepHours: pruneHours, dryRun: pruneDry }); } catch (e) { fail(`清理失敗：${e.message}`); }
  console.log(JSON.stringify({ mode: 'prune', ...r }, null, 2));
  process.exit(r.ok ? 0 : 1);
}

// --- 1a2. 回報（看板用）：該補報的 run、搶／放回報權 ---
if (pendingMode) {
  let runs; try { runs = pendingReports({ sessionId: sessionFilter }); } catch (e) { fail(`列出待回報失敗：${e.message}`); }
  console.log(JSON.stringify({ ok: true, mode: 'pending', ...VERSION_FIELDS, runs: runs.map((r) => ({ ...r, message: reportMessage(r) })) }, null, 2));
  process.exit(0);
}
if (claimDir || releaseDir) {
  const d = claimDir || releaseDir;
  if (!fs.existsSync(path.join(d, 'meta.json'))) fail(`目錄不存在或缺 meta.json：${d}`);
  if (!byWho) fail('--claim／--release 要帶 --by <誰>（例如 board）');
  const r = claimDir ? claimReport(d, byWho) : releaseReport(d, byWho);
  console.log(JSON.stringify({ mode: claimDir ? 'claim' : 'release', run_dir: d, ...VERSION_FIELDS, ...r }, null, 2));
  process.exit(r.ok ? 0 : 1);
}

// --- 1b. 終止 / 狀態 ---
if (stopDir) {
  if (!fs.existsSync(path.join(stopDir, 'meta.json'))) fail(`--stop 目錄不存在或缺 meta.json：${stopDir}`);
  let r; try { r = stopRun(stopDir, { force: forceStop }); } catch (e) { fail(`終止失敗：${e.message}`); }
  console.log(JSON.stringify({ mode: 'stopped', ...r }, null, 2));
  process.exit(r.ok ? 0 : 1);
}
if (statusDir) {
  if (!fs.existsSync(path.join(statusDir, 'meta.json'))) fail(`--status 目錄不存在或缺 meta.json：${statusDir}`);
  let r; try { r = runStatus(statusDir); } catch (e) { fail(`讀狀態失敗：${e.message}`); }
  console.log(JSON.stringify({ mode: 'status', ...r }, null, 2));
  process.exit(0);
}

// --- 1c. 獨立啟動 / 等待 ---
if (startDir) {
  if (!fs.existsSync(path.join(startDir, 'prompt.txt'))) fail(`--start 目錄不存在或缺 prompt.txt：${startDir}`);
  startDetached(startDir, path.resolve(__filename)).then((r) => {
    const self = path.resolve(__filename);
    console.log(JSON.stringify({ mode: 'started', ...VERSION_FIELDS, ...r, wait_command: `node "${self}" --wait "${startDir}"`, stop_command: `node "${self}" --stop "${startDir}"`, status_command: `node "${self}" --status "${startDir}"` }, null, 2));
    process.exit(r.ok ? 0 : 1);
  }).catch((e) => fail(`啟動失敗：${e.message}`));
} else if (waitDir) {
  if (!fs.existsSync(path.join(waitDir, 'meta.json'))) fail(`--wait 目錄不存在或缺 meta.json：${waitDir}`);
  waitRun(waitDir, { minutes: waitMinutes }).then((r) => {
    const self = path.resolve(__filename);
    const out = { ...r, ...VERSION_FIELDS };
    if (r.mode === 'waiting') out.next = `還在跑：先跟使用者說一句進度（summary_zh），然後立刻再背景執行同一個 wait_command 接著等`;
    if (r.mode === 'ran') out.wtf = detectWtf();
    out.wait_command = `node "${self}" --wait "${waitDir}"`;
    console.log(JSON.stringify(out, null, 2));
    process.exit(r.ok === false && r.mode !== 'ran' ? 1 : 0);
  }).catch((e) => fail(`等待失敗：${e.message}`));
} else
// --- 2. 執行模式（內部）：--run <run_dir> ---
if (runDir) {
  if (!fs.existsSync(path.join(runDir, 'prompt.txt'))) fail(`--run 目錄不存在或缺 prompt.txt：${runDir}`);
  let p; try { p = runEngine(runDir, engineCfg); } catch (e) { fail(`引擎啟動前檢查失敗：${e.message}`); }
  p.then((summary) => {
    console.log(JSON.stringify({ mode: 'ran', ...summary, wtf: detectWtf() }, null, 2));
    process.exit(summary.ok ? 0 : 1);
  }).catch((e) => fail(`引擎執行失敗：${e.message}`));
} else {
  // --- 3. 準備模式：任務原文 + 完成條件 → run 目錄 ---
  let userPrompt = '';
  if (promptFile) {
    try { userPrompt = fs.readFileSync(promptFile, 'utf8'); } catch (e) { fail(`讀 --prompt-file 失敗：${e.message}`); }
  } else {
    try { userPrompt = fs.readFileSync(0, 'utf8'); } catch (_) { userPrompt = ''; }
  }
  userPrompt = userPrompt.replace(/\r\n/g, '\n').trim();
  if (!userPrompt) fail('任務原文為空：請用 --prompt-file <path> 或 stdin 提供要做的事。');
  if (goalFile) {
    if (goalCondition) fail('--goal 與 --goal-file 只能擇一。');
    try { goalCondition = fs.readFileSync(goalFile, 'utf8').replace(/\r\n/g, '\n').trim(); } catch (e) { fail(`讀 --goal-file 失敗：${e.message}`); }
  }
  if (!goalCondition || !goalCondition.trim()) fail('需提供完成條件 --goal "<可測量完成條件>" 或 --goal-file <path>。請先把完成條件 propose 給使用者、確認（或逾時採納）後再準備。');
  // 事實層閘：任務原文含對話指涉（引擎在另一個 session 看不到本對話）又沒有「## 項目清單」→ 不自足，拒絕
  const suff = selfSufficiency(userPrompt);
  if (!suff.self_sufficient) fail(`任務不自足：原文含對話指涉「${suff.conversational_refs.join('、')}」但沒有「## 項目清單」節。引擎在另一個 headless session 跑，看不到本對話——這是 Claude（主 session）的工作、不要回去問使用者：從本對話與相關文件把要做的項目逐條展開成「## 項目清單」（編號、內容、驗收方式、來源檔:行）寫進任務書，再重跑。`);

  // /goal prompt 只放「條件＋指向錨定區的一句」（-p 路徑整段都算進 4000 字元上限，見 lib/goal-head.js 檔頭）。
  // 任務全文、工作清單、帳本規則全在 anchor.md（系統提示）。無 tail：本 skill 沒有「必做收尾」要納入條件。
  let head;
  try { head = buildGoalHead({ condition: goalCondition }); } catch (e) { fail(e.message); }
  const { goalPrompt: finalPrompt, overflow, length, conditionForAnchor } = head;

  const workList = `1. [開工] 先把任務拆成里程碑寫進進度帳本的「剩餘」節，再開始做。${overflow ? '（開工前先照上方要求把「完成條件全文」貼進第一則回覆。）' : ''}
2. [執行任務] 完成「任務全文」（持續做到完成；遇真正 blocker 先把其餘能做的做完再記錄）。全程繁體中文、無人值守：不停下來問使用者、需要決定時自己選風險最小做法。
3. [收尾] 完成條件達成後，把帳本「剩餘」清空、「已完成」補齊；最後一則回覆只寫一段簡短文字：做了什麼、怎麼驗證的（附實際指令輸出或檔案內容）、未完成項（沒有就寫「無」）。這段會被主 session 讀取當成最終回報素材。不要追加任何提問或 offer。`;

  // 子程序的工作目錄：--cwd 明確指定 > CLAUDE_PROJECT_DIR > 本 shell 的 cwd。
  // Claude Code 的 Bash 工具 cwd 會漂移（前一個指令 cd 過就留在那），同 session 多個 goal2 並發時尤其危險，
  // 所以 SKILL 規定一律帶 --cwd；這裡把來源記進 JSON 讓回報看得到。
  const cwd = path.resolve(cwdArg || process.env.CLAUDE_PROJECT_DIR || process.cwd());
  const cwdInspection = inspectCwd(cwd);
  const cwdSource = cwdArg ? 'cli' : (process.env.CLAUDE_PROJECT_DIR ? 'env:CLAUDE_PROJECT_DIR' : 'process.cwd');
  const anchor = buildAnchor({ condition: goalCondition, conditionOverflow: overflow, task: userPrompt, workList, runDir: '<RUN_DIR>', cwd });
  let prepared;
  try { prepared = prepareRun({ skill: 'goal', prompt: finalPrompt, cwd, anchor, meta: { condition: goalCondition, overflow, cwdSource, pluginVersion: pluginVersion(), ...parentSession() } }); } catch (e) { fail(e.message); }
  const { runDir: rd, runId, promptPath, activeRunsInTree } = prepared;
  // 中繼檔到這裡才刪：所有驗證都過、任務全文已落進 run 目錄的 anchor.md。之前任何一步 fail 都保留原檔，重跑不必重寫 10–20KB 任務書。
  if (promptFile) { try { fs.unlinkSync(promptFile); } catch (_) {} }
  if (goalFile) { try { fs.unlinkSync(goalFile); } catch (_) {} }

  // 確認逾時 timer 的 cron：現在 + confirmTimeoutMinutes，向上取整到整分（cron 是分鐘粒度，避免只剩幾秒）。
  // confirmTimeoutMinutes = 0（預設）→ 不排 timer，skill 直接執行 run_command（--start）再背景執行 wait_command；隨時可 --stop。
  const now = Math.floor(Date.now() / 1000);
  const direct = goalCfg.confirmTimeoutMinutes === 0;
  const confirmTarget = direct ? null : ceilToMinute(now + goalCfg.confirmTimeoutMinutes * 60);
  const confirmD = direct ? null : new Date(confirmTarget * 1000);
  const self = path.resolve(__filename);
  const runCommand = `node "${self}" --start "${rd}"`;   // 0.8.0 起：獨立啟動、立刻返回；之後一定要接 wait_command

  console.log(JSON.stringify({
    ok: true,
    mode: 'prepared',
    ...VERSION_FIELDS,
    run_dir: rd,
    run_id: runId,
    prompt_path: promptPath,
    run_command: runCommand,
    wait_command: `node "${self}" --wait "${rd}"`,
    stop_command: `node "${self}" --stop "${rd}"`,
    status_command: `node "${self}" --status "${rd}"`,
    start_mode: direct ? 'direct' : 'confirm-timer',
    confirm_timeout_minutes: goalCfg.confirmTimeoutMinutes,
    confirm_timer_cron: direct ? null : dateToCron(confirmD),
    confirm_timer_target_local: direct ? null : confirmD.toLocaleString(),
    confirm_timer_fire_in_seconds: direct ? null : confirmTarget - now,
    cwd,
    cwd_source: cwdSource,
    active_runs_in_tree: activeRunsInTree,
    sessionId: process.env.CLAUDE_CODE_SESSION_ID || null,
    engine: engineCfg,
    config_path: cfg.path,
    config_loaded: cfg.loaded,
    goal_overflow: overflow,
    goal_line_length: length,
    goal_prompt_length: finalPrompt.length,
    items_count: suff.items_count,
    has_items_section: suff.has_items,
    has_context_section: suff.has_context,
    warnings: [
      ...(suff.has_context ? [] : ['任務書沒有「## 脈絡與約束」節：引擎看不到本對話，對話裡已決定的事（決策、使用者更正、禁止動作、套用過的記憶）它不會知道——建議補上再啟動']),
      ...cwdInspection.warnings
    ],
    cwd_inspection: cwdInspection,
    grill: goalCfg.grill,
    anchor_path: path.join(rd, 'anchor.md'),
    progress_path: path.join(rd, 'progress.md'),
    final_prompt: fs.readFileSync(promptPath, 'utf8')
  }, null, 2));
}
