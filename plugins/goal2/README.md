# goal2 🎯

**把「想做的事」變成「可驗證的完成條件」，交給 Claude Code 的 goal 引擎做到達成為止——現在就做（`goal`），或排到 5 小時 quota 重置後無人值守做（`delaylocal`）。**

無人值守最大的風險是 AI 自以為做完就停了、其實漏了一半。goal 引擎解這個問題：不是讓 AI 自己覺得「差不多了」，而是先定一條**可測量的完成條件**（每回合用 Haiku 檢查器驗證），**做到達成為止**。關鍵在前一步：**你只給原始 prompt，由 Claude 幫你推導出完成條件、先 propose 給你過目**（逾時沒回覆就自動採納、不卡流程；逾時分鐘數可在設定檔調）。

> plugin 名叫 `goal2` 是為了避開 Claude Code 內建的 `/goal` 指令；兩個 skill 的觸發名是 `/goal2:goal` 與 `/goal2:delaylocal`。

## 兩個 skill

> **wtf 整合**：`goal` skill 的最終回報，若本機裝了 `wtf` plugin（重講紀律：一句話一件事、關係畫表、事實不漏），會套它的格式寫，寬度用 wtf 記的視窗寬。這是使用者授權的例外——wtf 本身禁止模型自行呼叫，這裡不呼叫它，只套規則。沒裝 wtf 時用固定欄位列點回報，並在結尾提示一行「想更精簡就 `/plugin install wtf@fulin-plugins`」。

| | `goal` | `delaylocal` |
|---|---|---|
| 一句話 | 定好完成條件，**現在**就讓引擎做到完成 | 定好完成條件，**quota 重置後**在本機無人值守做到完成 |
| 觸發 | `/goal2:goal <任務>`、「幫我定完成條件再跑」、「用 goal 引擎做到完成」 | `/goal2:delaylocal <任務>`、「排程到 quota 之後」、「等 5h 額度回來再跑」 |
| 引擎何時起 | 先把項目清單落檔（任務不自足會被拒）、問一輪影響條件的分岔（`goal.grillRounds`），propose 印給你看完就直接起；想先確認可在設定檔開 timer | 5h quota 重置後 + 緩衝（預設 15 分）的 cron 到點時；確認逾時預設 10 分鐘 |
| 中途終止／看進度 | 說「停」→ `goal.js --stop`（核對 pid 身分後殺整棵子程序樹；多個 run 時先問停哪個）；`--status` 看帳本；`--list` 看全機所有 run | `delaylocal.js --stop`／`--status` 同上（不需 session id） |
| 達成怎麼判 | 讀子程序 transcript 的檢查器紀錄（`goal_verdict`：met／impossible／unverified／no_transcript）；`status: done` 只在 `met` 時 | 同左 |
| 煞車 | `engine.maxBudgetUsd`（預設 300 USD → `status: budget`）、`engine.maxMinutes`（預設 480）；能停它的只有這兩個與 `--stop`（殺 runner 引擎會跟著死；關掉主 Claude Code 後是否存活未實測） | 同左 |
| 並行 | 不擋；準備時列出同棵樹（含祖先／子孫目錄）活著的 run（`active_runs_in_tree`）提醒你。路徑不重疊仍會共用 DB／port／測試結果，任務書要寫範圍切分；`--stop` 殺不到 `&`／nohup 起的背景服務 | 同左 |
| 引擎在哪跑 | 子程序 `claude -p "/goal …"`（headless session），log 在 `~/.claude/goal2/runs/<id>/` | 同左，由 cron 到點後的本 session 啟動 |
| 設定 | `~/.claude/goal2/config.json` 的 `engine`、`goal` 區段 | 同檔的 `engine`、`delaylocal` 區段（`bufferSeconds` 也可用 CLI 裸數字臨時覆蓋） |
| cron | 只有確認逾時 timer（session-only） | 任務 cron + 確認 timer（皆 session-only；`durable` 在目前版本無效） |
| 最終回報 | 本對話；本機有 wtf plugin 就套 wtf 的重講紀律寫；不發 LINE | 子程序寫報告檔並發 LINE（選用，未設憑證自動略過），主對話再讀 summary 回報 |
| 其他模式 | 無 | `--plain` 文字紀律模式、fast-path「直接排別問」 |

兩者共用 `references/goal-propose-flow.md`（propose 流程、可測量條件寫法、/goal 引擎契約、兩層時間）與 `lib/`（`engine.js` 子程序引擎、`goal-head.js` 4000 字元門檻、`cron-time.js`、`config.js`）。

## 典型情境

- 「這件事幫我定好驗收條件，然後做到完成再叫我」→ `goal`
- 「quota 快滿了，這個任務排到額度回來再自動跑」→ `delaylocal`
- 「排好就去睡，跑完用 LINE 通知我結果」→ `delaylocal`

## 運作原理

確定性邏輯全在工具裡，skill 只負責「呼叫工具 → 拿結果 → CronCreate」，不靠 AI 即興：

- **為什麼走子程序**：Claude 自己輸入不了斜線指令，而且 **Claude Code 2.1.196 起，cron 排程 fire 的 prompt 不再解析 slash command**——開頭 `/goal` 只是純文字（官方 scheduled-tasks 文件、GitHub #75837）。跨 session 訊息、skill 內包 `/goal` 也不行。唯一可由 Claude 啟動引擎的入口是 `claude -p "/goal …"`（官方 goal 文件），`lib/engine.js` 用它另起一個 headless session 跑到達成，並避開 git-bash 把 `/goal` 轉成路徑、巢狀 session 環境變數兩個坑。2.1.268 實測：Goal set → 第一回合故意做一半 → 引擎自動推第二回合 → 達成。
- **`goal.js`**：準備（建 run 目錄、落 `/goal` prompt、算確認 timer cron）與執行（`--run`：起子程序、收 stream、產 summary）兩段式。確認 timer 的 prompt 是給未來 Claude 的文字指令「去執行 run_command」。
- **`delaylocal.js`**：讀 `CLAUDE_CODE_SESSION_ID` 鎖定當前 session 的 5h quota 重置時間。排程時就把引擎 prompt（`/goal <條件>；已發 LINE` + 任務 + 寫報告 + `notify-line.js`）落到 run 目錄；cron 的 prompt 只做「session 守衛 → 叫 Claude 背景執行 `delaylocal.js --run`」。「已嘗試發 LINE」寫進完成條件，引擎才不會在通知前提早結束。
- **連續擋停上限**：`/goal` 本質是 Stop hook，Claude Code 預設連續 8 次擋停就放棄；設定檔 `engine.stopHookBlockCap` 預設 0 = 不設上限，做到達成為止。
- **達成不是猜的**：`claude -p` 的事件流裡沒有檢查器判定，只有子程序自己的 transcript 有（每次 Stop 檢查一筆 `goal_status`）。engine.js 收尾時讀它：`met` 才算 `done`；正常結束但沒有任何判定記 `unverified`（不可當達成）；檢查器判不可能記 `impossible`。0.3.x 用「exit 0」推定達成，曾把 130 回合、報告檔根本不存在的 run 記成達成。
- **煞車**：`engine.maxBudgetUsd`（傳給子程序 `--max-budget-usd`）與 `engine.maxMinutes`（runner 超時殺整棵樹、`status: timeout`）。無人值守下條件寫錯或永遠達不到時，沒有它們引擎會跑到 quota 用光（殺 runner 引擎會跟著死；關掉主 Claude Code 後是否存活未實測）。
- **長任務不忘目標**：上下文滿了會自動壓縮，壓縮後 Claude 常忘記最初目標或做到哪。goal2 三層錨定：`anchor.md`（條件＋任務＋帳本規則）放進子程序的系統提示，每回合重送、壓縮碰不到；`progress.md` 進度帳本邊做邊更新；壓縮一結束由只掛在該子程序的 SessionStart(compact) hook 把兩者注回。引擎自己的完成條件也存在對話之外，做不到就停不下來。run 目錄裡的 `progress.md` 隨時能看它做到哪。
- **4000 字元上限（整段 prompt 都算）**：`claude -p` 路徑下 `/goal` 後面整段文字都算進條件長度，超過就 0 回合退場。所以 goal2 只把「條件＋一句指向錨定區」放進 prompt（≤3900，工具硬檢查），任務全文、工作清單、報告格式都走 anchor.md 的系統提示；條件本身太長就換指針句、全文放 anchor 並要引擎第一則回覆先貼出。

## 設定（選用）

設定都在 `~/.claude/goal2/config.json`（家目錄，重裝 plugin 不會被清掉）。複製 plugin 根層的 `config.example.json` 過去改即可，所有欄位選填：

```json
{
  "engine":     { "permissionMode": "bypassPermissions", "stopHookBlockCap": 0, "model": null, "autocompact": "auto",
                  "maxBudgetUsd": 300, "maxMinutes": 480 },
  "goal":       { "confirmTimeoutMinutes": 0, "grillRounds": 1 },
  "delaylocal": { "confirmTimeoutMinutes": 10, "bufferSeconds": 900 }
}
```

| 欄位 | 意思 | 預設 |
|---|---|---|
| `engine.permissionMode` | 子程序 `claude -p` 的權限模式。無人值守遇到權限提示就會卡死，所以預設全放行；保守可改 `acceptEdits` | bypassPermissions |
| `engine.stopHookBlockCap` | 引擎連續擋停幾次後 Claude Code 強制結束回合（Claude Code 自己預設 8）；0 = 不設上限 | 0 |
| `engine.model` | 子程序用的模型；每次 run 是獨立 session、有固定開銷（極簡任務實測約 0.8 USD），要省就改小模型 | null（沿用預設） |
| `engine.autocompact` | 子程序的上下文自動壓縮視窗：`auto` 或 100000–1000000 tokens。長任務想讓壓縮晚點發生就調大 | auto |
| `engine.maxBudgetUsd` | 子程序的 `--max-budget-usd`，花到就自己停（`status: budget`）；實測正常任務約 0.5 USD/分鐘，300 ≈ 10 小時；null 不設 | 300 |
| `engine.maxMinutes` | runner 時限（分鐘，≤10080），超過殺整棵子程序樹、`status: timeout`；null 不設 | 480 |
| `goal.confirmTimeoutMinutes` | 0 = propose 完直接啟動、不等確認（隨時可停）；≥1 = 等你確認幾分鐘，逾時自動採納 | 0 |
| `goal.grillRounds` | propose 前問幾輪「會改變完成條件的分岔」（每題附建議答案，不答照建議）；0 = 不問直接起；項目清單落檔不受此影響 | 1 |
| `delaylocal.confirmTimeoutMinutes` | propose 後等你確認幾分鐘；逾時自動採納並排程 | 10 |
| `delaylocal.bufferSeconds` | quota 重置後再等幾秒才 fire（`/goal2:delaylocal` 帶裸數字可臨時覆蓋） | 900 |

檔案不存在就全用預設；存在但 JSON 壞掉、值型別錯、或有打錯的欄位名，工具會直接報錯而不是靜默用預設。`node <skill_dir>/goal.js --show-config` 或 `delaylocal.js --show-config` 可看生效值。`claude` 不在 PATH 時設環境變數 `GOAL2_CLAUDE_BIN`。

所有 JSON 輸出都帶 `plugin_version` 與 `plugin_root`：安裝版（`~/.claude/plugins/cache/...`）落後 repo 時以安裝版行為為準，先 `/plugin update goal2@fulin-plugins` 再看文件。

## 安裝

```
/plugin install goal2@fulin-plugins
/reload-plugins
```

### 前置（一次性）

1. **需要 Node.js**（三支工具皆為 node 腳本）。Windows `winget install OpenJS.NodeJS`、macOS `brew install node`、Linux 套件管理器。
2. **LINE 通知為選用**（只有 `delaylocal` 用；有設就發、沒設自動略過、不影響執行）。要啟用設定其一，憑證**不進 git**：
   - 複製 `skills/delaylocal/notify-line.config.example.json` → `notify-line.config.json`（同目錄），填 LINE Channel Access Token 與 userId；**或**
   - 設環境變數 `LINE_TOKEN`、`LINE_USER_ID`（plugin 安裝模式下 config 檔放在 cache 目錄、重裝會被清掉，**建議用環境變數**）。

> ⚠️ 兩個 skill 都依賴 plugin 根層的 `lib/`，須整個 plugin 一起安裝。開發期若要 symlink，只連 `skills/delaylocal`（Node 會以真身路徑解析 `../../lib`）；**不要**把 `skills/goal` 連成 `~/.claude/skills/goal`，會與內建 `/goal` 撞名。

### 從舊的 `delaylocal` plugin 遷移

`delaylocal` plugin（≤ 0.1.5）已整個併入本 plugin 成為 `delaylocal` skill，功能、CLI、輸出 JSON 與 final_prompt 逐字不變，只有觸發名改為 `/goal2:delaylocal`。

```
/plugin marketplace update fulin-plugins
/plugin uninstall delaylocal@fulin-plugins
/plugin install goal2@fulin-plugins
/reload-plugins
```

若之前有 `~/.claude/skills/delaylocal` 的 symlink，它已指向不存在的路徑，請刪掉（或重指到 `plugins/goal2/skills/delaylocal`）。

## 用法

```
/goal2:goal <要做到完成的任務>
/goal2:delaylocal <要排程的 prompt 原文>
# 自然語言：「幫我定完成條件再跑」→ goal；「排到 quota 重置後再跑」→ delaylocal
# delaylocal 直接排不囉嗦：「直接排程 / 不要問直接排」→ fast-path，立刻排不反問
```

goal 啟動後回報完成條件與 run_dir，說「停」就終止（`goal.js --stop <run_dir>`），問「做到哪」就看進度（`--status`）。`~/.claude/goal2/runs/` 全機共用、跨 session：**不要整批刪**，清理用 `goal.js --prune`（只清已結束且程序不在、running 但 pid 已死或被重用、prepared 從未啟動、壞目錄四類，且都超過保留時數，預設 24 小時；活著的一律不碰）。plugin 附 PreToolUse hook `runs-guard`：Bash／PowerShell 對 runs 目錄的整批、萬用字元、迴圈式刪除與 `--prune --keep-hours <2` 會被直接攔下，只放行指名完整 run id 的單筆刪除。delaylocal 排程後回報 Cron Job ID、觸發時間、完成條件；取消用 `CronDelete <id>`，引擎起來後同樣可 `--stop`。

> ⚠️ cron 只活在本 Claude Code process（`durable` 在目前版本無效），且 REPL idle 時才會 fire——「無人值守」指的是你人不用守著，但 Claude Code 程式要開著。引擎子程序起來後本對話可以繼續做別的事；殺掉 runner（TaskStop）引擎會跟著死，關掉整個 Claude Code 後引擎是否存活未實測。
