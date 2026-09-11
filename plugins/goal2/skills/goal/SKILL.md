---
name: goal
description: 當使用者要「先定一條可測量完成條件、再讓 Claude Code 的 goal 引擎做到完成為止」時觸發。觸發詞：「/goal2:goal」、「幫我定完成條件再跑」、「propose goal」、「用 goal 引擎做到完成」、「做到完成為止」、「定好驗收條件自動跑」。不排程到 quota 之後（那是同 plugin 的 delaylocal skill）；也不是替使用者手打內建 /goal——本 skill 幫使用者推導條件、確認（或逾時自動採納）後，用 goal.js 起一個 headless 子程序 `claude -p "/goal …"` 跑官方引擎到達成，最後在本對話回報（本機有裝 wtf plugin 就套 wtf 的重講紀律寫回報）。
---

# goal — 定完成條件、讓官方 /goal 引擎做到完成

把「做到完成」的判定交給 Claude Code 的 `/goal` 引擎（本質是 session 級的 Stop hook：Claude 每次要停下時由檢查器驗證條件，未達成就被推回去繼續），但**條件由你（Claude）先推導、使用者過目**，不是直接把使用者的一句話丟給引擎。

| | 本 skill（`goal`） | 同 plugin 的 `delaylocal` |
|---|---|---|
| 何時跑 | propose 完直接起（預設）；設定檔開確認 timer 則等你確認或逾時 | 5h quota 重置後 |
| 引擎在哪跑 | 子程序 `claude -p`（headless session） | 同左，由 cron 到點後的本 session 啟動 |
| 需要 cron | 預設不需要；只有開了確認 timer 才排一個 | 任務本體與逾時 timer 都要 |
| LINE 收尾 | 無；最終回報在本對話（有 wtf 就套 wtf 格式） | 有（選用） |

## 為什麼是子程序（讀完再動手，別想走捷徑）

- Claude 自己輸入不了斜線指令。
- **2.1.196 起，cron 排程 fire 的 prompt 不再解析 slash command**：開頭 `/goal` 只是純文字（官方 scheduled-tasks 文件、GitHub #75837）。跨 session 訊息、skill 內包 `/goal` 也一樣不執行。**禁止**再用 CronCreate 送 `/goal`。
- 唯一可由 Claude 啟動引擎的入口是 `claude -p "/goal …"`（官方 goal 文件；2.1.268 實測：Goal set → 第一回合故意做一半 → 引擎自動推第二回合 → 達成）。`goal.js --run` 就是在做這件事，並避開兩個坑：git-bash 會把開頭 `/goal` 轉成 Windows 路徑、巢狀 session 的 `CLAUDECODE` 環境變數。

## 架構（薄 skill + 確定性工具）

- `goal.js`：**準備**（建 run 目錄、落 `/goal` prompt、anchor、帳本模板）→ **執行**（`--run <run_dir>`：起子程序、收 stream、產 summary）→ 隨時 **`--status <run_dir>`**（看進度，不阻塞）／**`--stop <run_dir>`**（殺整棵子程序樹並標 stopped）。
- `../../lib/`：`goal-head.js`（4000 字元門檻）、`cron-time.js`、`config.js`（設定檔）、`engine.js`（子程序引擎、wtf 偵測）。**本 skill 須整個 plugin 一起安裝**，只複製 `skills/goal/` 會找不到 lib（工具會明確報錯）。
- run 目錄：`~/.claude/goal2/runs/<時間戳-goal-隨機>/`，內含 `prompt.txt`（只有 `/goal 條件` 加一句指向錨定區，≤3900 字）、`anchor.md`（完成條件全文＋任務全文＋工作清單＋帳本規則，會放進子程序的系統提示）、`progress.md`（進度帳本，子程序邊做邊更新）、`meta.json`、`stream.jsonl`（子程序完整事件流）、`result.json`（summary）、`compact-log.txt`（壓縮後錨定 hook 有 fire 才出現）。要追查引擎做了什麼就看 stream.jsonl；要看它做到哪就看 progress.md。

> `goal.js` 與這份 `SKILL.md` **同目錄**。執行時用「本 SKILL.md 所在目錄」組出 js 絕對路徑即可。

## 前置設定

- **需要 Node.js**，且 `claude` 在 PATH（子程序就是它）。
- 安裝：`/plugin install goal2@fulin-plugins` → `/reload-plugins`。
- ⚠️ **不要**把本 skill symlink 成 `~/.claude/skills/goal`——user-level 名字會與內建 `/goal` 撞名。plugin 安裝後的觸發名是 `/goal2:goal`。
- **設定檔（選用）**：`~/.claude/goal2/config.json`（家目錄，重裝 plugin 不會被清掉；範本在 plugin 根層 `config.example.json`）。本 skill 用的欄位：
  - `engine.permissionMode`：子程序權限模式，**預設 bypassPermissions**（無人值守遇到權限提示就會卡死；保守可改 acceptEdits）。
  - `engine.stopHookBlockCap`：引擎連續擋停幾次後 Claude Code 強制結束回合，**預設 0＝不設上限**（Claude Code 自己的預設是 8）。
  - `engine.model`：子程序模型，預設 null 沿用預設。
  - `engine.autocompact`：子程序的上下文自動壓縮視窗，`auto` 或 100000–1000000 tokens 的整數，**預設 auto**。長任務想讓壓縮晚一點發生就調大；壓縮後的錨定另有三層（見運作原理）。
  - `goal.confirmTimeoutMinutes`：**預設 0＝不等確認，propose 完直接啟動引擎**（使用者隨時可終止）；設 ≥1 則排確認 timer、逾時自動採納。
  - 沒檔就用預設；檔案壞掉、值錯、欄位名打錯會直接報錯不靜默退回。`node "<skill_dir>/goal.js" --show-config` 可看生效值與 wtf 偵測結果。

## 執行步驟

通用流程（propose 怎麼寫、timer 怎麼收斂、引擎契約、兩層時間）在 `../../references/goal-propose-flow.md`，**先讀第 2、3 節**。以下只寫本 skill 的具體動作。

### 1. 取得任務原文
`/goal2:goal <任務>` 的 args。空 → 請使用者補，停止。

### 2. 推導完成條件並 propose
依 references 第 2 節寫出**可測量、有驗證方法**的完成條件。先不要跑。

### 3. 準備 run 目錄
用 Write 把任務原文寫到**唯一名**暫存檔：`goal-input-<14位時間戳>-<4位隨機>.txt`，放系統暫存目錄（用該機器展開後的絕對路徑）。工具讀完會**自動刪除**。

```bash
# <skill_dir> = 本 SKILL.md 所在目錄
node "<skill_dir>/goal.js" --prompt-file <暫存檔> --goal "<propose 的完成條件>"
```
輸出 JSON：`{ ok, mode:"prepared", start_mode, run_dir, run_command, stop_command, status_command, confirm_timeout_minutes, confirm_timer_cron, confirm_timer_target_local, goal_overflow, anchor_path, progress_path, final_prompt, … }`。`ok:false` → 把 error 告訴使用者，停止。

### 4. 啟動（看 `start_mode`）

**`direct`（預設，`goal.confirmTimeoutMinutes` = 0）**：不排 timer、不等確認。立刻用 Bash、`run_in_background: true` 執行 `<JSON.run_command>`（它會阻塞到引擎結束並印 summary JSON），然後回報「已啟動」（步驟 5）。使用者看到條件不對，隨時說「停」就跑 `<JSON.stop_command>`。

**`confirm-timer`（設定檔設 ≥1 分鐘）**：排逾時 timer（prompt 是**文字指令**給未來的你，不是 `/goal`）：
```
CronCreate({ cron: <JSON.confirm_timer_cron>, recurring: false, durable: false,
  prompt: "[goal2 逾時自動採納] 使用者自 propose 後未回覆，視為採納完成條件。請立刻用 Bash（run_in_background: true）執行：<JSON.run_command>，結束後依 goal SKILL 步驟 5 回報。" })
```
**記下 timer 的 job id**，回報「已準備」並說明「`confirm_timeout_minutes` 分鐘內未回覆將於 `confirm_timer_target_local` 自動啟動」。收斂：同意 → `CronDelete` 後背景執行 `run_command`；要改條件 → `CronDelete` → 重寫暫存檔 → 重跑步驟 3；取消 → `CronDelete`；逾時 → timer fire 照指令執行。

### 4b. 進行中：終止與看進度
- 使用者說「停」「終止」「取消」→ 跑 `<JSON.stop_command>`（= `goal.js --stop <run_dir>`）：殺整棵子程序樹（`taskkill /T` 或 kill 群組）、meta 標 `stopped`，帳本與 stream.jsonl 保留；印出的 JSON 有 `killed`。背景中的 `run_command` 會自己收尾並印出 `stopped: true` 的 summary。
- 使用者問「做到哪」「進度」「還在跑嗎」→ 跑 `<JSON.status_command>`（不阻塞）。**回報要講人話，不准把 JSON 欄位丟給使用者**：第一句直接用 `summary_zh`（工具已組好：狀態＋回合數＋擋停次數＋壓縮次數＋最後一個動作＋最後一句），接著貼 `progress_md` 的「已完成」與「剩餘」兩節原文。欄位對照（要解釋時用）：

  | 欄位 | 白話 |
  |---|---|
  | `status` | `prepared` 還沒啟動／`running` 進行中／`done` 完成且達成／`failed` 結束但沒達成／`stopped` 被終止 |
  | `alive` | 子程序此刻還在不在跑 |
  | `num_turns` | 引擎總回合數（結束後才有）；進行中看 `assistant_messages`（目前幾則回覆） |
  | `continuations` | 引擎的檢查器擋停、要求繼續的次數；0 表示還沒被打回過 |
  | `compactions` / `anchor_injections` | 上下文壓縮次數／壓縮後錨定注回次數（兩者應相等） |
  | `last_tool` / `last_text` | 引擎最後一個工具動作／最後一句話（它此刻在做什麼） |
  | `last_event_at` | 最後一個事件的時間，久沒動就可疑 |

### 5. 回報使用者

**已啟動（direct）**：完成條件全文、run_dir、終止方式（說「停」即可，對應 `stop_command`）。
**已準備（confirm-timer）**：完成條件全文、timer job id 與自動啟動時間、run_dir、取消方式（`CronDelete <id>`）。

**引擎結束後**（背景指令結束會收到通知，讀它印的 JSON）：必含
- 達成與否：`goal_achieved`（`goal_set` 為 false 代表引擎根本沒設目標，這是異常，要講）
- 回合數 `num_turns`、被推回去續行的次數 `continuations`、上下文壓縮次數 `compactions` 與壓縮後錨定注回次數 `anchor_injections`（壓縮發生但注回 0 次是異常，要講）、耗時、`total_cost_usd`
- `result_text`：引擎最後一則回覆（做了什麼／怎麼驗證／未完成項），**原文保留不摘要**
- `run_dir`（要追查看 `stream.jsonl`；`progress_path` 是進度帳本，長任務中途想知道做到哪就讀它）
- `stopped: true` → 是被終止的，講清楚終止時做到哪（讀 `progress_path`）
- `permission_denials` 非 0 或 `ok:false` → 原文列出，說明可能要調 `engine.permissionMode`
- `terminal_reason` 不是 `completed` → 原文列出並解釋。已知：`rapid_refill_breaker`＝Claude Code 判定壓縮空轉（壓縮後 3 回合內又滿、連續 3 次）主動終止，通常是單次工具輸出太大或 `engine.autocompact` 設太小；`result_text` 會是引擎的英文說明，一併原文貼出

**回報格式——本機有 wtf plugin 時套它的重講紀律**（使用者已明確授權本 skill 在此步套用；wtf 本身是 `disable-model-invocation: true`，**不要**用 Skill 工具去呼叫它，也不要跑它的問寬度流程）：
1. JSON 的 `wtf.installed` 為 true → 讀 `wtf.skill_md`，照它的規則寫這則回報：先一句脈絡、一句話一件事、關係一律畫 ASCII 表格或箭頭圖、砍鋪陳與重複、事實一件不能少、證據原文逐字保留；寬度上限用 `wtf.terminal_width`（null 就用 80，不要問）。
2. `wtf.installed` 為 false → 用上面的必含欄位以列點回報，**結尾固定加一行**（這是唯一允許的附註，不算 offer）：`回報格式想更精簡（一句一事、關係畫表、寬度貼合你的視窗）→ 裝 wtf plugin：/plugin install wtf@fulin-plugins，之後 goal 的回報會自動套用。`

**不發 LINE**（本 skill 沒有 LINE 收尾）。**嚴禁**在回報結尾追加任何提問或 offer。

## 運作原理（why）

- **子程序而非本 session**：本 session 的對話會被引擎佔用直到達成；子程序讓你在本對話保持可對話，且引擎的完整事件流留在 `stream.jsonl` 可追查。代價是子程序看不到本對話的上下文，所以任務原文與完成條件必須自足。
- **為什麼預設直接啟動、不等確認**：條件已經印給使用者看了，等確認只是多一段空轉；有 `--stop` 可隨時終止，錯了就停再改，比每次都等更省。要保守就把 `goal.confirmTimeoutMinutes` 設成 ≥1。
- **為什麼 timer 的 prompt 是文字指令**：它 fire 進來就是普通回合，你照指令起子程序即可；放 `/goal` 反而沒用。
- **`stopHookBlockCap` 預設 0**：官方引擎預設連續 8 次擋停就放棄；無人值守要的是做到達成，所以關掉上限。要保險就在設定檔給個數字。
- **成本**：每次 run 是一個獨立 session，任務再小也有固定開銷（實測極簡任務約 0.8 USD）；要省就設 `engine.model`。
- **壓縮空轉熔斷（實測）**：`engine.autocompact` 設 100000 且每回合灌 25KB 工具輸出時，Claude Code 在第 3 次壓縮後以 `rapid_refill_breaker` 終止（「Autocompact is thrashing」）。這是引擎的保護，不是漂移；錨定在那三次壓縮都正常注回、沒有重做。對策：不要把 autocompact 調太小、任務裡讀大檔要分小塊、必要時提高 autocompact。
- **4000 字元上限算的是整段 prompt，不只第一行**（2026-09-12 實測：第一行 156 字、整段 6368 字 → `Goal condition is limited to 4000 characters (got 6361)`，0 回合 0 成本就退；使用者實際踩到 got 12511）。所以 `/goal` prompt 只放條件＋一句指向錨定區，任務全文、工作清單、帳本規則全走 anchor.md 的系統提示；`lib/goal-head.js` 與 `engine.js` 對整段 prompt 做 ≤3900 硬檢查，超過直接報錯不上車。條件本身超長 → 第一行換指針句、全文放 anchor「完成條件全文」，並要求引擎第一則回覆先把它貼進對話（檢查器在對話裡看得到）。summary 若出現 `goal_error` 就是引擎拒收，`ok:false`、`goal_set:false`。
- **長任務防漂移（上下文壓縮後不忘目標）**，三層缺一不可：
  1. `anchor.md`（完成條件＋任務全文＋帳本規則）用 `--append-system-prompt-file` 放進子程序的**系統提示**——系統提示每回合重送，壓縮只動對話紀錄，碰不到它。
  2. `progress.md` 進度帳本：引擎 prompt 規定開工先拆里程碑寫進「剩餘」、每完成一項就搬到「已完成」附證據；壓縮後或不確定時先讀 anchor 與帳本再動手。
  3. `hooks/compact-anchor.js`：engine.js 用 `--settings` **只對這個子程序**掛 SessionStart（matcher `compact`）hook，壓縮一結束就把 anchor＋帳本以 additionalContext 注回，並在 run 目錄記 `compact-log.txt`。不是 compact、沒有 `GOAL2_RUN_DIR`、任何錯誤一律靜默放行。
  另外引擎自己的完成條件存在 app state（不在對話裡），壓縮不影響驗收，所以就算敘事漂了，做不到條件也停不下來。

## Non-goals
不發 LINE、不算 quota、沒有 plain 模式、不在本 session 內跑引擎。

## 注意
- 只用 CronCreate 排逾時 timer，不可用 SQL 偽造；`CronList` 可查。
- cron 到點時你正在打字或 Claude 正在跑：排程器只在 REPL idle 時 fire，會等下一個空檔，不會漏掉（依 CronCreate 工具說明）。
- 背景執行的 `run_command` 結束才會通知；引擎跑很久是正常的。要中途停一律用 `--stop`（會殺整棵樹），不要只 TaskStop 那個背景指令——那樣子程序 claude 會變孤兒繼續跑。
