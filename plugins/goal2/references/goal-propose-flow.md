# goal 引擎共用流程：propose 完成條件 → 確認 / 逾時採納 → 交給 /goal 引擎

> 本檔是 goal2 plugin 兩個 skill（`goal`、`delaylocal`）的**共用骨架**。skill 各自的 SKILL.md 只寫差異，通論在這裡。

## 1. 為什麼要先 propose

無人值守最大的風險是 AI 自以為做完就停了、其實漏了一半。Claude Code 的 `/goal` 引擎解這個問題——不是讓 AI 自己覺得「差不多了」，而是先定一條**可測量的完成條件**，引擎每回合用檢查器驗證、**做到達成為止**。

但完成條件寫得模糊，引擎會空轉燒 token；寫得好才能真正「做到完成」。所以由 Claude 先擬、使用者過目。使用者可能離線，故 **逾時無回覆即自動採納**，不讓流程卡在等確認。逾時分鐘數在 `~/.claude/goal2/config.json`（`goal.confirmTimeoutMinutes` 預設 **0**＝印出條件後直接啟動、`delaylocal.confirmTimeoutMinutes` 預設 10；結構見 `lib/config.js`、範本 `config.example.json`）。

**禁止沒把完成條件印給使用者看就啟動引擎。** goal skill 預設「印出即啟動」：條件必須先完整出現在回覆裡，啟動後使用者隨時可 `--stop`；這是設計選擇（CHANGELOG 0.3.0），不是漏了 propose。要「先看過再跑」就把 `goal.confirmTimeoutMinutes` 設 ≥1。

## 2. 可測量完成條件怎麼寫

條件只寫**驗收標準**，不寫任務本身。任務原文另放工作清單，條件是加在上面的一層。

| ✅ 可測量（有驗證方法） | ❌ 模糊（引擎會空轉） |
|---|---|
| `npm test` exit 0 | 測試都通過且程式品質良好 |
| `docs/` 下每個 `.md` 用 `npx markdown-link-check` 回報 0 個壞連結 | 壞連結修掉了 |
| 檔案 `out/report.docx` 存在，且用 Word COM 開啟成功、`Paragraphs.Count ≥ 40` | 報告產好了 |
| `curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/health` 回 200 | 服務正常 |
| `git diff --stat` 顯示只動了 `src/auth/` 底下的檔案 | 改動範圍合理 |

判準：**一個不知道任務脈絡的檢查器，能不能光靠跑指令 / 看檔案就判真假？** 不能就重寫。

多項條件用「且」串起來、逐項列出；不要寫「等等」「諸如此類」。

**條件要極端（等式＋全稱），不准自己放寬**：

| 使用者說 | ✅ 寫成 | ❌ 不准 |
|---|---|---|
| 把 A 類工作做完 | A 類未完成數 **= 0**（附算未完成數的指令或檔案）；例外清單內項目不計，每項附 blocker 類別＋證據＋原因 | 未完成數 < 0（永遠不成立）、≤ 1、「大部分完成」、沒有原因的例外 |
| 測試都要過 | `npm test` exit 0 **且**失敗數 = 0 **且**跳過數 = 0（或明列允許跳過的清單） | 「主要測試通過」、「失敗數明顯下降」 |
| 文件都修好 | 清單裡**每一份**（列出清單或產生清單的指令）皆… | 「重要的幾份」 |

**例外條款（允許，但要極端地明確）**：條件寫成「… = 0；**例外清單內的項目不計**」，例外清單由引擎在執行時建立，每一項必須同時滿足：(1) 屬於真 blocker——需使用者決策／授權的破壞性操作、外部系統不可用、缺只有使用者能給的祕密或資料、與任務書明文規範衝突；(2) 附證據（指令輸出、錯誤原文、檔案路徑）與一句原因；(3) 寫進進度帳本「決策與注意」並在最後回報以「例外清單」標題逐項列出。「太花時間」「不確定要不要」「看起來不重要」都不是例外。例外清單為空時就是純 = 0。這樣檢查器有明確依據放行，你事後也看得到每一個例外是為什麼。

引擎與檢查器不得把 `= 0` 讀成「差不多 0」；不在例外清單裡的未完成項就是未達成。2026-09-12 實例：使用者要「A 類完成」，propose 出來的是「A 類未完成數 < 0」——這種條件一出現就重寫。

**子程序看不到本對話**：引擎在另一個 headless session 跑，任務原文與完成條件必須自足（路徑寫絕對路徑、需要的脈絡寫進任務）。

## 3. propose → timer → 收斂（通用骨架）

1. **理解任務 → 事實層**：讀懂目的與範圍；任務原文含對話指涉（「你掌握的」「你的建議」「這 N 個」「上述」）或指向一份文件說「把沒做完的做完」→ **先把項目逐條展開成任務書的 `## 項目清單`**（編號、內容、驗收方式、來源）。引擎在另一個 session，看不到本對話；工具對不自足的任務會拒絕。事實自己查（讀檔、派 sub-agent），不問使用者。**另寫 `## 脈絡與約束`**：對話裡已決定的事（決策與理由、使用者更正、禁止動作、套用過的記憶／harness 判準、已知坑、相關檔絕對路徑）——子程序有 CLAUDE.md／記憶／輸出風格／plugin（依 `--cwd` 載入，所以 cwd 必須是專案根），唯獨沒有這段對話。
1b. **決策層（grill）**：`goal.grill`（預設 true）——把任務當設計樹，每輪把當下能問的全部分岔問完（每題附建議答案，❓/➡️ 格式），答完重算 frontier 再問，**問到沒有任何決策是默默假設的為止**，不限輪數；常見分岔：範圍邊界、驗收方式、例外條款、禁止動作、並行共用資源、產出落點。事實自己查，只問決策；使用者說「直接跑」就停、未答照建議。fast-path／plain／使用者說「直接跑」跳過。
2. **propose ＋ 排確認 timer**：
   - 一次 propose 出來：**完成條件**（核心，照第 2 節寫）、任務拆解、（delaylocal 另有）緩衝秒數 / 預計 fire 時間。
   - **goal skill 預設（`confirmTimeoutMinutes` = 0）不排 timer**：propose 印給使用者後直接啟動，錯了用 `--stop` 終止再改。設 ≥1 才走下面的 timer。delaylocal 一律走 timer（預設 10 分）。
   - 走 timer 時：**同時** `CronCreate` 一個 `recurring:false` 的確認 timer，**記下 job id**。timer 的 cron 由各 skill 的 js 算（不要心算）；timer 的 prompt 是**給未來的自己的文字指令**，兩個 skill 不同（見下表）。
   - 回報使用者：完成條件全文、（有 timer 時）job id 與「N 分鐘內沒回覆將自動採納」、run_dir、終止方式。
3. **收斂（兩種）**：
   - **a. 使用者逾時前回覆** → **先 `CronDelete <timer id>`**，再依回覆處理：同意 → 進第 4 步；要改 → 調整條件、重新 propose（並重排新 timer）；取消 → 到此結束。
   - **b. 逾時無回覆** → timer fire → **自動採納** propose 的條件，進第 4 步。
4. **啟動引擎**：用各 skill 的 js 把 `/goal` prompt 交給子程序（見第 4 節）。

| | `goal` skill（現在就做） | `delaylocal` skill（quota 重置後做） |
|---|---|---|
| 準備 | `goal.js --prompt-file … --goal … --cwd <專案根>` → run_dir + `run_command` + `confirm_timer_cron` | `delaylocal.js --show-config` 拿 `confirm_timer_cron`；確認後 `delaylocal.js … --goal … --cwd <專案根>` → run_dir + `run_command` + 任務 cron |
| 並行 | 不擋；`active_runs_in_tree` 列出同棵樹活著的 run，回報時提醒。路徑不重疊仍會共用 DB／port／測試結果，任務書要寫範圍切分；`--stop` 殺不到 `&`／nohup 起的背景服務 | 同左 |
| timer 的 prompt | （預設不排）開啟時：文字指令「[goal2 逾時自動採納] …請用 Bash 背景執行 `<run_command>`」 | 文字指令：「[delaylocal 逾時自動採納] …請以 --goal-file 跑 delaylocal.js 後 CronCreate」 |
| 使用者同意後 | `CronDelete` timer → Bash 背景執行 `run_command` | `CronDelete` timer → `delaylocal.js --goal` → `CronCreate(任務 cron)` |
| 引擎何時起 | propose 完立刻（或開 timer 時：同意／逾時） | 任務 cron 到點 → fire 進來的 prompt 叫 Claude 背景執行 `run_command` |
| 終止／進度 | `goal.js --stop <run_dir>`／`--status <run_dir>`；多個活著的 run 時先問停哪一個 | `delaylocal.js --stop <run_dir>`／`--status <run_dir>`（不需 session id） |
| 煞車 | `engine.maxBudgetUsd`（預設 300，觸發 → `status: budget`）、`engine.maxMinutes`（預設 480，≤10080）；殺 runner 或主 Claude Code 退出，引擎都跟著死（實測）；預算在回合邊界才對帳 | 同左 |
| 任務 cron | 無 | quota 重置後 + `delaylocal.bufferSeconds`（預設 900）；session-only，另有 session 守衛 |
| 收尾 | 主 session 讀 summary 回報（有 wtf 就套 wtf 格式）；不發 LINE | 子程序寫報告檔 + `notify-line.js` 發 LINE（選用）；主 session 再讀 summary 回報 |

## 4. /goal 引擎契約（實測整理，2.1.268）

- **引擎本質**：官方 hooks 文件明寫 `/goal` 是「內建的 session 級 prompt-based Stop hook」——Claude 每次要停下，檢查器驗證條件，未達成就把回饋塞回去要求繼續。
- **誰能啟動它**：只有互動輸入框的 `/goal …`，以及 **`claude -p "/goal …"`**（官方 goal 文件：「Setting a goal with -p runs the loop to completion in a single invocation」；本機實測 Goal set → 故意做一半 → 引擎推第二回合 → 達成）。以下**都不行**：CronCreate 排程 prompt 開頭放 `/goal`（2.1.196 起被標 skipSlashCommands，只是純文字；GitHub #75837、官方 scheduled-tasks 文件）、跨 session 訊息、skill／custom command 內包 `/goal`（#91146）、任何工具。所以兩個 skill 都走子程序，實作在 `lib/engine.js`。
- **子程序的兩個坑**（engine.js 已處理）：git-bash 會把開頭 `/goal` 的參數轉成 Windows 路徑（實測變 `D:/Program Files/Git/goal`），engine.js 用 `spawn` 傳 argv 陣列並設 `MSYS_NO_PATHCONV=1`；巢狀 session 會繼承 `CLAUDECODE=1`，engine.js 清掉。
- **第一行必須以 `/goal ` 開頭**，其後即完成條件；可含多行 args（第二行起是工作清單）。
- **4000 字元硬上限，-p 路徑算整段 prompt**：超過回 `Goal condition is limited to 4000 characters (got N)`、0 回合就退。2026-09-12 實測：第一行 156 字、整段 6368 字 → got 6361 被拒（2.1.195 互動模式只算第一行，所以舊版「下放步驟 0」曾有效；-p 不行）。goal2 的做法：`/goal` prompt 只放「條件（含 tail）＋一句指向系統提示錨定區」，任務全文／工作清單／報告格式／帳本規則全在 anchor.md；`lib/goal-head.js` 與 `engine.js` 對整段 prompt 做 ≤3900 硬檢查。條件本身超長 → 第一行換指針句「已逐項達成本 run 錨定區「完成條件全文」列出的每一項」，全文放 anchor 並要求引擎第一則回覆先貼出（讓檢查器在對話裡看到）。引擎拒收時 summary 有 `goal_error`。
- **達成後自動清除、不接後續指示**：任何「一定要做的收尾」必須**寫進完成條件**，引擎才會強迫做完才停。delaylocal 的「已執行 notify-line.js」tail 就是這樣來的；goal skill 沒有必做收尾，所以沒有 tail。
- **連續擋停上限**：Claude Code 對 Stop hook 連續 block 有上限（程式碼 `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP ?? 8`，`cap > 0` 才生效，超過就強制結束回合並警告）。engine.js 依設定檔 `engine.stopHookBlockCap` 設此環境變數給子程序，**預設 0＝不設上限**。
- **達成判定只認子程序 transcript**：stream-json 裡沒有檢查器判定；transcript（`~/.claude/projects/<cwd 編碼>/<session>.jsonl`）每次 Stop 檢查寫一筆 `attachment {type:"goal_status", met, failed?, reason?}`（Goal set 當下那筆 `sentinel:true` 不算）。engine.js 收尾時讀最後一筆 → `goal_verdict`：`met`→`done`；`failed:true`→`impossible`；只有 sentinel 或沒有→`unverified`（引擎未經檢查就 end_turn，不可當達成）；找不到 transcript→`no_transcript`。2026-09-12 實測三種結局都出現過（達成／判不可能放行／未經檢查結束），舊版全記成達成。
- **檢查器會為了達成改系統狀態**：bypassPermissions 下，條件「Z 槽下某檔存在」被擋 2 次後引擎用 `subst` 造出 Z 槽達成（實測）。條件與任務書要寫清楚不准動什麼；`maxBudgetUsd`／`maxMinutes` 是最後煞車。
- **`durable` 無效**：CronCreate 的 `durable` 參數由遠端旗標控制、目前關閉（工具 schema 明寫「Has no effect — all jobs are session-only」；六月與現在皆如此）。排程只活在本 Claude Code process。
- **到點時 REPL 忙碌**（Claude 在跑、或使用者剛送出訊息）→ 排程器等下一個 idle 再 fire、不會漏掉（依 CronCreate 工具說明）。
- **runs 目錄是全機共用的**：`~/.claude/goal2/runs/` 被所有 session、所有專案共用。禁止整批刪除；清理只能 `goal.js --prune`（只刪已結束且程序不在的）。同一棵工作樹（相同／祖先／子孫目錄）已有活著的 run 時不阻擋（使用者的工作型態就是同一專案並行多個調整），但準備輸出的 `active_runs_in_tree` 會列出來，回報時要提醒使用者兩個引擎可能互相改檔。
- **長任務與上下文壓縮**：引擎的完成條件存在 app state（`activeGoal`＋session 級 Stop hook），壓縮不影響驗收；會流失的是任務細節與進度。goal2 三層錨定：① `anchor.md` 以 `--append-system-prompt-file` 進系統提示（每回合重送）；② `progress.md` 進度帳本（引擎 prompt 規定里程碑更新、壓縮後先讀）；③ `hooks/compact-anchor.js` 以 `--settings` 只掛在該子程序的 SessionStart(compact)，壓縮後把 ①＋② 注回。`engine.autocompact` 可把壓縮視窗調到 100k–1M tokens。summary 的 `compactions`／`anchor_injections` 回報這兩件事發生了幾次。**實測**（2.1.268）：autocompact=100000、每回合 25KB 輸出 → 3 次壓縮、3 次注回、壓縮後從帳本接續零重做，但第 3 次後被 Claude Code 的 `rapid_refill_breaker` 熔斷（壓縮空轉保護）；autocompact 別設太小、大檔分小塊讀。

## 5. 兩層時間別混淆（弱模型最常錯的點）

| 層 | `goal` skill | `delaylocal` skill |
|---|---|---|
| 第 1 層＝引擎何時起 | 使用者同意當下（或 timer 逾時） | 任務 cron 到點（quota 重置後 + 緩衝） |
| 第 2 層＝propose 確認逾時 | 預設沒有（直接起）；設 ≥1 分才有確認 timer | 確認 timer（預設 10 分，逾時就排任務 cron），與第 1 層是**不同的 job** |

delaylocal 的 fast-path 與 plain 模式**沒有**第 2 層，也不起子程序。

## 6. 回報紀律

- 只回報固定欄位（各 SKILL.md 列的那幾項），格式固定。
- 引擎結束後的回報要含 `status`／`goal_verdict`（`unverified` 必須明講不可當達成）、`continuations`、`compactions`、`num_turns`、`total_cost_usd`、`result_text`（**原文保留**）、`run_dir`、`plugin_version`；被終止的要標明 `stopped`／`timeout` 並說做到哪。
- 「停」的消歧問題（多個活著的 run 時問停哪一個）不算下面禁止的 offer。
- **嚴禁**在回報結尾追加「建議 / 下一步 / 要不要我改用別的方式」之類的提問或 offer。
- 排程是時間敏感操作，任何多餘的反問都在浪費使用者的視窗。
