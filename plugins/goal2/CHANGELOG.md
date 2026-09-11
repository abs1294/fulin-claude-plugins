# Changelog

本檔記錄 goal2（原 delaylocal）的版本變更，格式依 [Keep a Changelog](https://keepachangelog.com/)。

## [0.3.2] - 2026-09-11
### Fixed
- **/goal 4000 字元上限判準錯誤（真 bug，使用者實際踩到 got 12511）**：`goal-head.js` 只量第一行，但 Claude Code 在 `claude -p` 路徑把 `/goal` 後的**整段 prompt**（工作清單、任務、帳本規則）都算進完成條件，超過就 0 回合退場。實測：第一行 156 字、整段 6368 字 → `Goal condition is limited to 4000 characters (got 6361)`；同 prompt 砍到 2958 字 → Goal set。（2.1.195 互動模式只算第一行，0.1.3 的「下放步驟 0」因此曾有效；-p 不行。）修法：`/goal` prompt 只放「條件（含 tail）＋一句指向錨定區」，任務全文、工作清單、報告格式、帳本規則全移到 `anchor.md`（`--append-system-prompt-file`，不受限）；`goal-head.js`／`engine.prepareRun`／`runEngine` 對整段 prompt 做 ≤3900 硬檢查，超過直接報錯不起子程序。條件本身超長 → 第一行換指針句「已逐項達成本 run 錨定區「完成條件全文」…」、全文放 anchor 並要求引擎第一則回覆先貼進對話（檢查器看得到）。實測 11.5KB 任務：prompt 243 字、Goal set、達成。
- **引擎拒收可見**：summary 新增 `goal_error`（例：`Goal condition is limited to 4000 characters (got N)`），此時 `ok:false`、`goal_set:false`、`error` 帶說明，不再只看到 num_turns 0。
- 準備輸出 JSON 新增 `goal_prompt_length`。

## [0.3.1] - 2026-09-11
### Changed
- **`--status` 看得懂了**：新增 `last_text`（引擎最後一句）、`last_tool`（最後一個工具動作，單行）、`last_event_at`、`assistant_messages`，以及一行白話 `summary_zh`（例：「進行中；目前 8 則回覆；被檢查器擋停要求繼續 1 次；上下文壓縮 2 次、錨定注回 2 次；最後一個動作：Bash：…；最後一句：「…」」）。兩份 SKILL.md 規定回報進度時第一句直接用 summary_zh、再貼帳本，**不准把 JSON 欄位丟給使用者**，並附欄位白話對照表（status 五種值、alive、num_turns、continuations、compactions／anchor_injections、last_*）。

## [0.3.0] - 2026-09-11
### Added
- **長任務壓縮防漂移（三層錨定）**：子程序上下文滿了自動壓縮後常忘記目標或做到哪。現在 ① `anchor.md`（完成條件＋任務全文＋帳本規則）以 `--append-system-prompt-file` 放進子程序**系統提示**，每回合重送、壓縮碰不到；② `progress.md` 進度帳本：引擎 prompt 規定開工先拆里程碑、每完成一項搬到「已完成」附證據、壓縮後先讀再動手；③ `hooks/compact-anchor.js`：engine.js 用 `--settings` 只對該子程序掛 SessionStart（matcher `compact`）hook，壓縮一結束把 ①＋② 以 additionalContext 注回，並記 `compact-log.txt`；非 compact／無 `GOAL2_RUN_DIR`／任何錯誤一律靜默放行。**實測**（2.1.268，24 段 × 8KB、autocompact=100000）：6 次壓縮、6 次注回、24 段依序零重印、24 個 secret 全對、引擎正常達成。summary 新增 `compactions`、`anchor_injections`、`progress_path`。
- **`--stop <run_dir>`／`--status <run_dir>`**（goal.js 與 delaylocal.js 皆有）：engine.js 把子程序 PID 記進 meta.json；`--stop` 殺整棵程序樹（Windows `taskkill /T /F`、其他平台 kill 群組）、meta 標 `stopped`，runner 收尾時 summary 帶 `stopped: true`，帳本與 stream.jsonl 保留；`--status` 不阻塞地回 status／alive／壓縮次數／帳本原文。實測：90 秒任務起跑後 --stop，11 個子孫程序全部終止、目標檔未被寫。準備輸出 JSON 新增 `stop_command`、`status_command`。
- **`engine.autocompact`** 設定：`auto` 或 100000–1000000 tokens。⚠️ 設太小加上大塊工具輸出會觸發 Claude Code 的壓縮空轉熔斷（`terminal_reason: rapid_refill_breaker`，實測 autocompact=100000＋每回合 25KB 時第 3 次壓縮後終止）；summary 的 `terminal_reason` 會回報。
### Changed
- **goal skill 預設直接啟動、不等確認**：`goal.confirmTimeoutMinutes` 預設由 1 改為 **0**＝propose 印給使用者後立刻背景起引擎（隨時 `--stop`）；設 ≥1 才走確認 timer。準備輸出多 `start_mode`（`direct`／`confirm-timer`），direct 時 `confirm_timer_*` 為 null。delaylocal 流程不變（仍走 10 分鐘 timer）。
- 引擎 prompt 工作清單改為 ①開工拆里程碑進帳本 ②執行任務 ③收尾（goal：補帳本＋簡短回報；delaylocal：補帳本＋寫報告＋LINE）。
- ⚠️ **升級順序**：設定檔驗證是嚴格的，舊版 0.2.x 不認識 `engine.autocompact`、也不接受 `goal.confirmTimeoutMinutes: 0`，會直接報錯罷工。請**先升級到 0.3.0 再改設定檔**。

## [0.2.1] - 2026-09-11
### Fixed
- goal skill 回報：未裝 wtf plugin 時結尾提示可安裝 wtf 以取得精簡表格式回報

## [0.2.0] - 2026-09-11
### Changed
- **plugin 由 `delaylocal` 更名為 `goal2`**（取 goal2 以避開 Claude Code 內建 `/goal` 指令），原 skill 整目錄搬到 `skills/delaylocal/`，觸發名改為 `/goal2:delaylocal`。plain 模式、fast-path、quota 計算、LINE 通知的 CLI 與輸出**逐字不變**（以 HEAD 舊版對新版 diff 驗證）；goal 模式改走子程序引擎（見下）。舊 plugin 使用者請 `/plugin uninstall delaylocal@fulin-plugins` 後 `/plugin install goal2@fulin-plugins`；plugin 安裝模式下 LINE 憑證建議改用環境變數 `LINE_TOKEN`／`LINE_USER_ID`（cache 目錄的 config 檔重裝會被清掉）。
- **goal 模式改走子程序引擎（重大）**：Claude Code **2.1.196 起**，CronCreate 排程 fire 的 prompt 被標 `skipSlashCommands`，開頭 `/goal` 只是純文字、引擎不會啟動（GitHub #75837；官方 scheduled-tasks 文件明寫 built-in commands「reach Claude as plain text」）。0.1.x 的 goal 模式自 2.1.196 起其實一直沒在跑引擎，只是任務照做而已。現在 `delaylocal.js` 排程時就把引擎 prompt（`/goal <條件>；已發 LINE` + 任務 + 報告 + notify）落到 `~/.claude/goal2/runs/<id>/prompt.txt`，cron 的 final_prompt 改為「session 守衛 → 叫 Claude 背景執行 `delaylocal.js --run <run_dir>`」，`--run` 用 `claude -p "/goal …"`（官方 goal 文件記載的非互動入口）另起 headless session 跑到達成。2.1.268 實測 Goal set → 續行 → 達成，報告與 LINE 收尾照舊。
- **CronCreate `durable` 誠實化**：工具 schema 明寫 `durable` 「Has no effect — all jobs are session-only」（由遠端旗標控制，六月與現在皆關閉）；文件與 CronCreate 呼叫改為 `durable:false`，不再宣稱跨 session。
- **抽 plugin 根層 `lib/`**：`engine.js`（子程序引擎：`spawn` 傳 argv 避開 git-bash 把 `/goal` 轉成路徑、清 `CLAUDECODE`、依設定設 `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`、收 stream.jsonl、產 result.json；含 wtf plugin 偵測）、`goal-head.js`（/goal 第一行 3900 字元門檻／指針句／步驟 0 下放，0.1.3 修法的單一來源）、`cron-time.js`（Date→5 欄 cron、整分向上取整、跨月警告）、`config.js`。兩支 skill 以 `path.join(__dirname,"..","..","lib")` 載入，symlink／junction 情境已實測 Node 以真身路徑解析；只複製 skill 資料夾會得到明確錯誤訊息。
- `skills/delaylocal/SKILL.md` 的 goal 通論（為何 propose、條件寫法、引擎契約、兩層時間）移到共用 `references/goal-propose-flow.md`，SKILL.md 只留 delaylocal 專屬差異。
### Added
- **新 skill `goal`（`/goal2:goal`）**：不排程到 quota 之後，現在就做——推導可測量完成條件 → 確認或逾時自動採納（預設 1 分鐘）→ `goal.js` 準備 run 目錄（`/goal` prompt、`run_command`、確認 timer cron）→ 同意後 Bash 背景執行 `goal.js --run <run_dir>` 起子程序引擎跑到達成 → 主對話讀 summary（`goal_achieved`、`continuations`、`num_turns`、`result_text` 原文、`run_dir`）回報。確認 timer 的 prompt 是文字指令「去執行 run_command」。不發 LINE；**本機裝了 wtf plugin 時，最終回報套 wtf 的重講紀律**（使用者授權的例外，不呼叫 wtf skill 本身，寬度用 wtf 記的 `terminalWidth`）。不接受裸數字參數。
- `references/goal-propose-flow.md`：兩 skill 共用的 propose 流程、可測量條件正反例、/goal 引擎契約（第一行、4000 上限、達成後自動清除）、兩層時間對照表、回報紀律。
- **設定檔 `~/.claude/goal2/config.json`**（`lib/config.js` 讀取與驗證、範本 `config.example.json`）：`engine.permissionMode`（子程序權限，預設 bypassPermissions）、`engine.stopHookBlockCap`（引擎連續擋停上限，預設 0＝不設上限；Claude Code 自己預設 8）、`engine.model`、`goal.confirmTimeoutMinutes`（預設 1）、`delaylocal.confirmTimeoutMinutes`（預設 10）、`delaylocal.bufferSeconds`（預設 900，CLI 裸數字仍可覆蓋）。放家目錄是因為 plugin 重裝會清 cache 目錄。檔案壞掉／型別錯／未知欄位一律報錯不靜默退回。`goal.js`／`delaylocal.js` 皆有 `--show-config` 與 `--run <run_dir>`；`delaylocal.js` 輸出 JSON 多了 `run_dir`、`run_command`、`engine_prompt`、`confirm_timer_cron`（讓 skill 不再心算「現在＋N 分」）、`buffer_source`、`config_path`、`config_loaded`。

## [0.1.5] - 2026-07-04
### Fixed
- **跨月/跨年 cron 排錯防呆**：CronCreate 只吃 5 欄週期式 cron（無年份、無絕對時間）；當目標時間與現在不在同月/年時，`31 7 * *` 這類一次性 cron 可能被引擎解讀成「明年的 7/31」而排到非預期年份。現偵測 target 與 now 跨月/跨年時，於輸出 JSON 附 `cron_warning`，並要求 SKILL 步驟 5 把它轉達使用者核對觸發日期（5 欄限制下能做的最強防呆，不改 cron 值以保短任務向後相容）。
- **暫存檔零清理**：報告檔（`delaylocal-report-*`）與 LINE 超長截斷備份（`delaylocal-line-*`）原本留在 `os.tmpdir()` 永不刪、長期累積且含任務報告內容。現 `delaylocal.js`／`notify-line.js` 各於執行時清掃自己前綴、mtime 逾 7 天的舊檔（嚴格前綴比對、只掃 tmpdir、best-effort 失敗即忽略，不刪到等待中排程的目標檔）。

## [0.1.4] - 2026-07-04
### Fixed
- **收尾通知失敗不再害 goal 模式空轉重試**：`notify-line.js` 原本 LINE API 回非 200（token 過期 / rate limit / userId 失效）或網路錯誤時 `exit 1`，而 goal 完成條件（GOAL_TAIL）寫「發出總結並回應 200」，導致「有設憑證但發送失敗」時 goal 引擎誤判任務未完成、持續重試燒 quota（任務其實早已做完）。現改為：notify 是「盡力通知」而非「必須成功」，任何發送結果（含非 200、網路錯）都 `exit 0` 並印出失敗原因；GOAL_TAIL 措辭放寬為「已嘗試發送即視為此步完成，絕不因非 200 重試」。「未設憑證→exit 0」的既有行為不變。

## [0.1.3] - 2026-06-30
### Fixed
- delaylocal.js goal 模式 final_prompt 第一行 /goal 條件超過 Claude Code 的 4000 字元上限會卡死（回 "Goal condition is limited to 4000 characters"）。現自動偵測：第一行（含收尾通知尾巴）≤ 3900 字照舊整段放第一行（短任務向後相容）；超過則第一行換固定指針句（指向工作清單步驟 0），完整 goalCondition 原封下放步驟 0，避免機械截斷破壞語意。收尾通知尾巴兩種情況都保留在第一行（確保 goal 引擎仍強制發 LINE）。
