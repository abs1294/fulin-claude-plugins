#!/usr/bin/env node
// delaylocal 主工具（goal2 plugin 的 delaylocal skill）：算當前 session 的 5h quota 重置時間，組裝排程用的 final prompt。
// /goal 第一行組裝與 cron 轉換抽在 plugin 根層 ../../lib/（goal-head.js、cron-time.js），與 goal skill 共用。
//
// 用法：
//   echo "<使用者要排的 prompt 原文>" | node delaylocal.js [bufferSeconds]
//   node delaylocal.js [bufferSeconds] --prompt-file <path>
//   node delaylocal.js [bufferSeconds] --prompt-file <path> --goal "<可測量完成條件>"
//   node delaylocal.js --run <run_dir>          # cron 到點後由 Claude 呼叫：起 claude -p "/goal …" 子程序跑到完成
//   node delaylocal.js --show-config
//
// 設定檔（選用）：~/.claude/goal2/config.json 的 delaylocal 區段，結構與驗證見 ../../lib/config.js。
//   bufferSeconds（預設 900）：CLI 裸數字可覆蓋。confirmTimeoutMinutes（預設 10）：propose 確認逾時，
//   本檔據此算出 confirm_timer_cron 給 skill 直接 CronCreate，不讓 Claude 心算「現在＋N 分」。
//
// 兩種模式：
//   - 預設（--goal 必填）：排程時就把「/goal <完成條件>（含已發 LINE）+ 任務 + 報告 + notify」組成引擎 prompt
//     落到 ~/.claude/goal2/runs/<id>/prompt.txt；cron 的 final_prompt 只做兩件事：session 守衛、
//     叫 Claude 用 Bash 背景執行 `delaylocal.js --run <run_dir>`（起 claude -p 子程序跑官方 goal 引擎）。
//     ⚠️ 2.1.196 起 cron fire 的 prompt 不再解析 slash command，開頭 /goal 只是純文字（GitHub #75837），
//        所以不能再把 /goal 放 cron prompt 第一行；唯一可用入口是 claude -p（見 ../../lib/engine.js）。
//   - --plain：final_prompt 內建「session 守衛 + 無人值守文字紀律 + 任務 + 發 LINE」，不需完成條件、不起子程序。
//
// 輸出：JSON { ok, sessionId, snapshotKey, resets_at_local, target_local, cron, cron_warning, fire_in_minutes, buffer_seconds, buffer_source,
//             confirm_timeout_minutes, confirm_timer_cron, confirm_timer_target_local, config_path, config_loaded, mode,
//             run_dir, run_command, engine, engine_prompt（goal 模式）, final_prompt（cron 用） }
// --run 模式輸出：{ mode:"ran", ok, goal_set, goal_achieved, continuations, num_turns, result_text, stream_path, … }
// skill 拿 cron + final_prompt 去 CronCreate({ recurring:false, durable:false })（durable 在目前版本無效，一律 session-only）。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

function fail(msg) {
  console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
  process.exit(1);
}

// --- plugin 共用 lib（__dirname 對 symlink 取真身路徑，symlink / plugin cache 兩種安裝都成立）---
const LIB = path.join(__dirname, '..', '..', 'lib');
let buildGoalHead, dateToCron, ceilToMinute, crossMonthWarning, loadConfig, prepareRun, runEngine;
try {
  ({ buildGoalHead } = require(path.join(LIB, 'goal-head.js')));
  ({ dateToCron, ceilToMinute, crossMonthWarning } = require(path.join(LIB, 'cron-time.js')));
  ({ loadConfig } = require(path.join(LIB, 'config.js')));
  ({ prepareRun, runEngine } = require(path.join(LIB, 'engine.js')));
} catch (e) {
  fail(`找不到 plugin 共用 lib（${LIB}）：本 skill 須整個 plugin 一起安裝（/plugin install goal2@fulin-plugins）或 symlink 指向 monorepo 內的 skill 目錄，不可只複製 skill 資料夾。` + e.message);
}

// --- 暫存檔清理（防止 os.tmpdir() 無限累積、殘留任務報告等敏感內容）---
// 生命週期分析：
//   • delaylocal-report-*.txt：本檔在「排程時」決定路徑，但實際「寫入 + 由 notify-line.js 讀取」
//     發生在 cron fire（quota 重置後、通常數小時內）。所以「當下這次執行」不可刪任何 report 檔
//     ——可能是等待中排程的目標檔。安全窗：cron fire 至遲在建立後幾小時，故超過 CLEANUP_MAX_AGE_DAYS
//     的檔一定是已完成 / 已放棄的殘留，刪之安全。
//   • delaylocal-line-*.txt：notify-line.js 在「內容過長」時寫的完整內容備份，供使用者事後翻閱。
//     同樣以年齡為準清理（幾天後使用者若沒看即視為過期）。
// 策略：每次執行 delaylocal.js 時，掃 tmpdir 下「本工具自己前綴」的檔，刪掉 mtime 超過 N 天者。
//   — 只碰 delaylocal-report-* / delaylocal-line- * 這兩個專屬前綴，絕不動別的檔 / 別的目錄。
//   — 以 mtime 年齡為閾值，不刪近期（可能仍在等 fire 或剛寫入）的檔。
//   — 清理失敗一律吞掉（best-effort），不影響主流程。
const CLEANUP_MAX_AGE_DAYS = 7;
function sweepStaleTempFiles() {
  try {
    const dir = os.tmpdir();
    const cutoff = Date.now() - CLEANUP_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
    for (const name of fs.readdirSync(dir)) {
      // 只清本工具自己產生的兩類暫存檔，前綴嚴格比對，避免誤刪同目錄他人檔案。
      if (!/^delaylocal-(report|line)-/.test(name)) continue;
      const fp = path.join(dir, name);
      try {
        const st = fs.statSync(fp);
        if (st.isFile() && st.mtimeMs < cutoff) fs.unlinkSync(fp);
      } catch (_) { /* 單檔失敗（權限/競態）忽略，繼續掃下一個 */ }
    }
  } catch (_) { /* 整體失敗（讀不到 tmpdir 等）忽略，不阻斷主流程 */ }
}
sweepStaleTempFiles();

// --- 1. 當前 session id ---
const envId = process.env.CLAUDE_CODE_SESSION_ID || '';
if (!envId) fail('CLAUDE_CODE_SESSION_ID 環境變數不存在，無法鎖定當前 session');
const snapshotKey = envId.replace(/-/g, '').slice(0, 24);

// --- 2. 讀參數與使用者 prompt（stdin 優先，否則 --prompt-file）---
// --- 設定檔（~/.claude/goal2/config.json 的 delaylocal 區段）---
let cfg;
try { cfg = loadConfig(); } catch (e) { fail(e.message); }
const dlConfig = cfg.config.delaylocal;

const args = process.argv.slice(2);
let bufferSeconds = dlConfig.bufferSeconds; // 預設 900（15 分鐘）；設定檔可改；CLI 裸數字覆蓋
let bufferSource = cfg.loaded ? 'config' : 'default';
let promptFile = null;
let goalCondition = null; // 完成條件（預設 goal 模式必填；由 Claude propose、使用者確認後填入）
let plainMode = false;    // --plain 才退回舊的文字紀律模式
let showConfig = false;
let runDir = null;        // --run <run_dir>：cron 到點後起引擎
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--prompt-file') promptFile = args[++i];
  else if (args[i] === '--goal') goalCondition = args[++i];
  else if (args[i] === '--plain') plainMode = true;
  else if (args[i] === '--show-config') showConfig = true;
  else if (args[i] === '--run') runDir = args[++i];
  else if (/^\d+$/.test(args[i])) { bufferSeconds = parseInt(args[i], 10); bufferSource = 'cli'; }
}
if (runDir) {
  // 執行模式：起 claude -p 子程序跑官方 goal 引擎，阻塞到完成，印 summary（skill 用 Bash 背景執行）
  if (!fs.existsSync(path.join(runDir, 'prompt.txt'))) fail(`--run 目錄不存在或缺 prompt.txt：${runDir}`);
  runEngine(runDir, cfg.config.engine).then((summary) => {
    console.log(JSON.stringify({ mode: 'ran', ...summary }, null, 2));
    process.exit(summary.ok ? 0 : 1);
  }).catch((e) => fail(`引擎執行失敗：${e.message}`));
  return; // 下面是排程準備流程
}
// propose 確認逾時 timer 的 cron：現在 + confirmTimeoutMinutes，向上取整到整分（同 goal.js 的取整理由）。
// --show-config 也輸出它：skill 在 propose 當下跑 --show-config 就能直接拿 cron 去 CronCreate timer。
const confirmTarget = ceilToMinute(Math.floor(Date.now() / 1000) + dlConfig.confirmTimeoutMinutes * 60);
const confirmTimerCron = dateToCron(new Date(confirmTarget * 1000));
if (showConfig) {
  console.log(JSON.stringify({
    ok: true, mode: 'show-config', config_path: cfg.path, config_loaded: cfg.loaded, delaylocal: dlConfig, goal: cfg.config.goal, engine: cfg.config.engine,
    confirm_timeout_minutes: dlConfig.confirmTimeoutMinutes, confirm_timer_cron: confirmTimerCron,
    confirm_timer_target_local: new Date(confirmTarget * 1000).toLocaleString(), buffer_seconds_default: dlConfig.bufferSeconds
  }, null, 2));
  process.exit(0);
}
let userPrompt = '';
if (promptFile) {
  userPrompt = fs.readFileSync(promptFile, 'utf8');
  // 中繼檔是一次性消耗品：讀完立刻刪除，避免殘留被其他流程誤讀 / 覆寫競態。
  try { fs.unlinkSync(promptFile); } catch (_) {}
} else {
  try { userPrompt = fs.readFileSync(0, 'utf8'); } catch (_) { userPrompt = ''; }
}
userPrompt = (userPrompt || '').trim();
if (!userPrompt) fail('沒有收到要排程的 prompt（請用 stdin 或 --prompt-file 傳入）');
if (!plainMode && !goalCondition) fail('delaylocal 預設為 goal 模式：需提供完成條件 --goal "<可測量完成條件>"。請先把完成條件 propose 給使用者、確認後再排程。若確實要用無目標的文字紀律模式，加 --plain。');

// --- 3. 讀 quota 重置時間（鎖定當前 session）---
const snapFile = path.join(os.homedir(), '.claude', 'rate-limit-snapshots.json');
let snaps;
try { snaps = JSON.parse(fs.readFileSync(snapFile, 'utf8')); } catch (e) { fail('讀 rate-limit-snapshots.json 失敗: ' + e.message); }
const now = Math.floor(Date.now() / 1000);

let base;
const entry = snaps[snapshotKey];
if (entry && entry.five_hour && typeof entry.five_hour.resets_at === 'number') {
  base = entry.five_hour.resets_at;
} else {
  // fallback：當前 session 沒快照 → 取所有 session 最晚的未來 resets_at（最保守）
  const future = Object.values(snaps)
    .map((s) => s && s.five_hour && s.five_hour.resets_at)
    .filter((x) => typeof x === 'number' && x > now);
  base = future.length ? Math.max(...future) : now;
}
// 若 resets_at 已過期 → 用 now（quota 應已重置）
if (base < now) base = now;

const target = base + bufferSeconds;
const d = new Date(target * 1000);
const cron = dateToCron(d);

// --- 跨月/跨年防呆 ---
// CronCreate 只吃 5 欄 cron（分 時 日 月 週），無年份欄、亦不支援絕對時間戳（已查官方
// scheduled-tasks 文件確認）。recurring:false 的一次性任務會在「cron 下一個符合的時間點」fire。
// 問題：若 target 落在與「現在」不同的月/年（例：現在 8/1、目標算到隔年或另一月的 7/31），
// `31 7 * *` 這種週期式表達的「下一個符合時間」可能被引擎解讀成「明年的 7/31」→ 排到錯年份。
// 修法（在 5 欄限制下能做的最強防呆）：偵測 target 與 now 不同月/年時，於輸出附 cron_warning，
// 讓 skill / 使用者知道這個一次性 cron 是週期式表達、fire 時點依引擎「下一個符合」語意，
// 若跨到非預期年份需人工確認。純加提示，不改 cron 值（避免破壞短任務的既有行為）。
const nowD = new Date(now * 1000);
const cronWarning = crossMonthWarning(d, nowD, cron); // 文案與判定在 lib/cron-time.js

// notify-line.js 與本檔同目錄；用 __dirname 取絕對路徑，plugin 裝在哪都能找到。
const notifyPath = path.join(__dirname, 'notify-line.js');
// 報告檔放系統暫存目錄（os.tmpdir()）→ 不綁特定使用者名、換機器也寫得進去（#1 可攜性）；
// 檔名帶 snapshotKey + 時間戳 → 多 session / 同 session 多次排程並發時不互相覆寫（#3 唯一化，
// 對齊步驟 2 prompt 中繼檔「檔名每次唯一」的原則）。
const reportPath = path.join(os.tmpdir(), `delaylocal-report-${snapshotKey}-${Date.now()}.txt`);

// 固定報告格式（兩種模式共用）
const REPORT_FORMAT = `[delaylocal 完成] <一句話結論>

■ 任務
<一句話描述這次做了什麼專案 / 修了什麼>

■ 執行結果
- <項目>：<完成 / Pass / Fail / 未做原因>

■ 決策記錄
- <做了什麼決策>：<理由>（沒有就寫「無」）

■ 發現問題
- BUG-1 [Critical/Major/Minor]：<描述>（沒有就寫「無」）

■ 產出
- <檔案路徑 / commit / PR / 啟動方式>

■ 下一步建議
- <建議>（沒有就寫「無」）`;

// --- 4. 組裝 final prompt ---
let finalPrompt;
let enginePrompt = null;   // goal 模式：交給子程序引擎的 prompt（已落 run 目錄）
let runDirOut = null;
let runCommandOut = null;
if (!plainMode) {
  // === goal 模式（預設）===
  // 第一行 = /goal <完成條件>，把「已發 LINE」納入條件（goal 達成後自動清除、不接後續，
  // 所以發 LINE 必須是達成條件的一部分，goal 引擎才會強迫自己發完才停）。
  // session 守衛改成工作清單第①項（不搶 /goal 的第一行位置）。
  //
  // ⚠️ Claude Code 的 /goal 完成條件有 4000 字元硬上限（超過會回
  //    "Goal condition is limited to 4000 characters"、cron fire 進 REPL 時卡死）。
  //    goalCondition 由使用者傳入、長度不可控，故：
  //    - 第一行（含收尾通知尾巴）≤ 安全閾值 → 照舊整段放第一行（短任務行為不變、向後相容）。
  //    - 超過 → 第一行換成固定「指針句」（指向工作清單的完成條件全文），完整 goalCondition
  //      原封不動下放到工作清單步驟 0，避免機械截斷破壞語意。
  const GOAL_TAIL = '並且已將完整報告寫入暫存檔、執行 notify-line.js 完成收尾通知（只要已「嘗試發送」即視為此步完成：有設憑證就發出、未設則自動略過；即使 API 回非 200 或 token 失效，notify-line.js 也回 exit 0，此步同樣視為完成——絕不可因為沒收到 LINE、或發送未回 200 就重試或卡住）';
  // 3900 門檻 / 指針句 / 步驟 0 下放的邏輯在 lib/goal-head.js（與 goal skill 共用、單一來源）。
  // pointer 沿用本 skill 原句（多了「且已完成步驟 2 的任務全部項目」），輸出與 0.1.5 逐字相同。
  const { goalLine, goalFullBlock } = buildGoalHead({
    condition: goalCondition,
    tail: GOAL_TAIL,
    pointer: '已逐項達成「工作清單步驟 0」列出的完整完成條件（每一項皆為真），且已完成步驟 2 的任務全部項目'
  });
  // 引擎 prompt（交給 claude -p 子程序；子程序沒有 session 守衛的問題，守衛留在 cron prompt）
  enginePrompt = `${goalLine}

（上面第一行是 goal 完成條件。下面是達成它要依序完成的工作清單，當作你的執行指引；全程繁體中文、無人值守：不停下來問使用者、需要決定時自己選風險最小做法、做到完成。）

工作清單（依序）：
${goalFullBlock}1. [執行任務] 完成以下任務（持續做到完成；遇真正 blocker 先把其餘能做的做完再記錄）：
${userPrompt}
2. [收尾通知] 把依「報告格式」填好的報告寫進 "${reportPath}"，再執行：
   cat "${reportPath}" | node "${notifyPath}"
   （notify-line.js 走 node https，自動拆多則、可帶中文/emoji。LINE 為選用：有設憑證就發出；未設則自動略過並回 exit 0、不算失敗——報告已寫入暫存檔即視為此步完成，別因為沒收到 LINE 就重試或卡住。）
   最後一則回覆貼上報告全文（主 session 會讀取它當最終回報素材），不要追加任何提問或 offer。

報告格式（步驟 2 用，嚴格照填、不增不減）：

${REPORT_FORMAT}`;
  const prepared = prepareRun({ skill: 'delaylocal', prompt: enginePrompt, cwd: process.cwd(), meta: { sessionId: envId, condition: goalCondition, overflow: enginePrompt.includes('0. [完成條件全文]') } });
  runDirOut = prepared.runDir;
  runCommandOut = `node "${path.resolve(__filename)}" --run "${prepared.runDir}"`;

  // cron 到點時送進 REPL 的 prompt：不能放 /goal（2.1.196 起不解析），只做守衛 + 起引擎
  finalPrompt = `[delaylocal 排程任務 — 綁定 session ${envId}]

依序做，全程繁體中文、無人值守（不停下來問使用者）：

1. [Session 守衛] 確認環境變數 CLAUDE_CODE_SESSION_ID 是否等於 ${envId}。
   - 不等於 → 這是別的 session 誤觸發本排程：什麼都不做、不要執行下一步，回一句「非目標 session，略過」即可結束。
   - 等於 → 繼續。
2. [啟動 goal 引擎] 用 Bash 工具、run_in_background: true 執行下面這條指令（原樣執行，不要改參數）：
   ${runCommandOut}
   它會另起一個 headless Claude Code session，用官方 /goal 引擎把任務做到完成條件達成，並在收尾時寫報告、嘗試發 LINE。指令會阻塞到引擎結束，最後印一份 JSON summary。
3. [等待與回報] 背景指令結束後（你會收到通知），讀它印出的 JSON：goal_achieved、continuations、num_turns、result_text（引擎最後一則回覆＝報告全文）。用固定格式回報：達成與否、回合數、報告內容、run_dir 路徑（含 stream.jsonl 可追查）。不要追加任何提問或 offer。`;
} else {
  // === 文字紀律模式（--plain，選用 fallback）===
  finalPrompt = `[delaylocal 排程任務 — 綁定 session ${envId}]

== Session 守衛（第一步，務必先做）==
這個排程綁定建立它的 session（${envId}）。多 session 環境下其他 session 可能也會 fire 到本任務。
請先確認環境變數 CLAUDE_CODE_SESSION_ID 是否等於 ${envId}：
  - 若「不等於」→ 立刻停止，不執行任何後續、不發 LINE（這是別的 session 誤觸發）。
  - 若「等於」→ 繼續往下執行。

== 執行模式：無人值守（UNATTENDED，嚴格遵守）==
前提假設：使用者「不在線、不會看訊息、不會回覆」。整個任務期間沒有任何人可以問、可以確認。
1. 假設無人值守：絕不停下來問使用者問題、絕不等待回覆或確認。需要做決定時，自己選最合理、風險最小的做法繼續，事後在報告 / LINE 說明。
2. 持續執行直到「再也沒有任何可執行項目」為止——把任務拆到底、逐項做完，包含實作、驗證 / 測試、收尾。
3. 【結束前的強制自問】每一次你想收尾 / 結束前，都必須先把下列問題問自己一遍，全部答「否（沒有了）」才可以結束：
   - 原始需求的每一項都完成了嗎？有沒有漏掉的子項？
   - 還有沒有「下一個可執行的項目」、未驗證 / 未測試的部分、寫了一半的 TODO？
   - 有沒有「想留到之後再做」、但其實現在就能做的事？
   只要任何一項答案是「還有」，就回去繼續做，不可結束。確認真的全部做完才進入結束流程。
4. 唯一可結束的另一種情況＝遇到「真正的 blocker」：需使用者明確授權的破壞性操作、外部系統不可用、缺少只有使用者能提供的祕密 / 決策。遇到時也不是停著乾等，而是先把不受該 blocker 影響、所有還能做的事做完，再把 blocker 寫進報告後結束。
5. 全程繁體中文；若專案有 CLAUDE.md 規範務必全部遵守。

== 實際任務 ==
${userPrompt}

== 結束時必做：收尾通知（LINE 選用）==
無論「全部完成」或「遇到 blocker 中止」，最後一步把報告寫進暫存檔，再用 stdin 管道發出：
  cat "${reportPath}" | node "${notifyPath}"
（notify-line.js 走 node https，自動把長內容拆多則，每則 4800 字、最多 5 則；超過則完整內容存本機並附路徑。可直接帶中文 / emoji。LINE 為選用：有設憑證就發出；未設則自動略過並回 exit 0、不算失敗——報告仍已寫入暫存檔，照常結束。）

報告**必須嚴格照以下固定格式**填寫，只填這些區塊、不增不減：

${REPORT_FORMAT}`;
}

console.log(JSON.stringify({
  ok: true,
  sessionId: envId,
  snapshotKey,
  resets_at_local: new Date(base * 1000).toLocaleString(),
  target_local: d.toLocaleString(),
  cron,
  cron_warning: cronWarning,
  fire_in_minutes: Math.round((target - now) / 60),
  buffer_seconds: bufferSeconds,
  buffer_source: bufferSource,
  confirm_timeout_minutes: dlConfig.confirmTimeoutMinutes,
  confirm_timer_cron: confirmTimerCron,
  confirm_timer_target_local: new Date(confirmTarget * 1000).toLocaleString(),
  config_path: cfg.path,
  config_loaded: cfg.loaded,
  mode: plainMode ? 'plain' : 'goal',
  run_dir: runDirOut,
  run_command: runCommandOut,
  engine: cfg.config.engine,
  engine_prompt: enginePrompt,
  final_prompt: finalPrompt
}, null, 2));
