---
name: goal
description: 當使用者要「先定一條可測量完成條件、再讓 Claude Code 的 goal 引擎做到完成為止」時觸發。觸發詞：「/goal2:goal」、「幫我定完成條件再跑」、「propose goal」、「用 goal 引擎做到完成」、「做到完成為止」、「定好驗收條件自動跑」。不排程到 quota 之後（那是同 plugin 的 delaylocal skill）；也不是替使用者手打內建 /goal——本 skill 幫使用者推導條件、確認（或逾時自動採納）後，用 goal.js 起一個 headless 子程序 `claude -p "/goal …"` 跑官方引擎到達成，最後在本對話回報（本機有裝 wtf plugin 就套 wtf 的重講紀律寫回報）。
---

# goal — 定完成條件、讓官方 /goal 引擎做到完成

把「做到完成」的判定交給 Claude Code 的 `/goal` 引擎（本質是 session 級的 Stop hook：Claude 每次要停下時由檢查器驗證條件，未達成就被推回去繼續），但**條件由你（Claude）先推導、使用者過目**，不是直接把使用者的一句話丟給引擎。

| | 本 skill（`goal`） | 同 plugin 的 `delaylocal` |
|---|---|---|
| 何時跑 | 確認後立刻（或逾時自動採納） | 5h quota 重置後 |
| 引擎在哪跑 | 子程序 `claude -p`（headless session） | 同左，由 cron 到點後的本 session 啟動 |
| 需要 cron | 只有「等你確認」的逾時 timer | 任務本體與逾時 timer 都要 |
| LINE 收尾 | 無；最終回報在本對話（有 wtf 就套 wtf 格式） | 有（選用） |

## 為什麼是子程序（讀完再動手，別想走捷徑）

- Claude 自己輸入不了斜線指令。
- **2.1.196 起，cron 排程 fire 的 prompt 不再解析 slash command**：開頭 `/goal` 只是純文字（官方 scheduled-tasks 文件、GitHub #75837）。跨 session 訊息、skill 內包 `/goal` 也一樣不執行。**禁止**再用 CronCreate 送 `/goal`。
- 唯一可由 Claude 啟動引擎的入口是 `claude -p "/goal …"`（官方 goal 文件；2.1.268 實測：Goal set → 第一回合故意做一半 → 引擎自動推第二回合 → 達成）。`goal.js --run` 就是在做這件事，並避開兩個坑：git-bash 會把開頭 `/goal` 轉成 Windows 路徑、巢狀 session 的 `CLAUDECODE` 環境變數。

## 架構（薄 skill + 確定性工具）

- `goal.js`：**準備**（建 run 目錄、落 `/goal` prompt、算逾時 timer cron）與**執行**（`--run <run_dir>`：起子程序、收 stream、產 summary）兩段式。
- `../../lib/`：`goal-head.js`（4000 字元門檻）、`cron-time.js`、`config.js`（設定檔）、`engine.js`（子程序引擎、wtf 偵測）。**本 skill 須整個 plugin 一起安裝**，只複製 `skills/goal/` 會找不到 lib（工具會明確報錯）。
- run 目錄：`~/.claude/goal2/runs/<時間戳-goal-隨機>/`，內含 `prompt.txt`、`meta.json`、`stream.jsonl`（子程序完整事件流）、`result.json`（summary）。要追查引擎做了什麼就看 stream.jsonl。

> `goal.js` 與這份 `SKILL.md` **同目錄**。執行時用「本 SKILL.md 所在目錄」組出 js 絕對路徑即可。

## 前置設定

- **需要 Node.js**，且 `claude` 在 PATH（子程序就是它）。
- 安裝：`/plugin install goal2@fulin-plugins` → `/reload-plugins`。
- ⚠️ **不要**把本 skill symlink 成 `~/.claude/skills/goal`——user-level 名字會與內建 `/goal` 撞名。plugin 安裝後的觸發名是 `/goal2:goal`。
- **設定檔（選用）**：`~/.claude/goal2/config.json`（家目錄，重裝 plugin 不會被清掉；範本在 plugin 根層 `config.example.json`）。本 skill 用的欄位：
  - `engine.permissionMode`：子程序權限模式，**預設 bypassPermissions**（無人值守遇到權限提示就會卡死；保守可改 acceptEdits）。
  - `engine.stopHookBlockCap`：引擎連續擋停幾次後 Claude Code 強制結束回合，**預設 0＝不設上限**（Claude Code 自己的預設是 8）。
  - `engine.model`：子程序模型，預設 null 沿用預設。
  - `goal.confirmTimeoutMinutes`：propose 後等使用者確認的逾時，**預設 1 分鐘**。
  - 沒檔就用預設；檔案壞掉、值錯、欄位名打錯會直接報錯不靜默退回。`node "<skill_dir>/goal.js" --show-config` 可看生效值與 wtf 偵測結果。

## 執行步驟

通用流程（propose 怎麼寫、timer 怎麼收斂、引擎契約、兩層時間）在 `../../references/goal-propose-flow.md`，**先讀第 2、3 節**。以下只寫本 skill 的具體動作。

### 1. 取得任務原文
`/goal2:goal <任務>` 的 args。空 → 請使用者補，停止。

### 2. 推導完成條件並 propose
依 references 第 2 節寫出**可測量、有驗證方法**的完成條件。先不要跑。

### 3. 準備 run 目錄 → 排逾時 timer
用 Write 把任務原文寫到**唯一名**暫存檔：`goal-input-<14位時間戳>-<4位隨機>.txt`，放系統暫存目錄（用該機器展開後的絕對路徑）。工具讀完會**自動刪除**。

```bash
# <skill_dir> = 本 SKILL.md 所在目錄
node "<skill_dir>/goal.js" --prompt-file <暫存檔> --goal "<propose 的完成條件>"
```
輸出 JSON：`{ ok, mode:"prepared", run_dir, run_command, confirm_timeout_minutes, confirm_timer_cron, confirm_timer_target_local, goal_overflow, final_prompt, … }`。`ok:false` → 把 error 告訴使用者，停止。

排逾時 timer（prompt 是**文字指令**給未來的你，不是 `/goal`）：
```
CronCreate({ cron: <JSON.confirm_timer_cron>, recurring: false, durable: false,
  prompt: "[goal2 逾時自動採納] 使用者自 propose 後未回覆，視為採納完成條件。請立刻用 Bash（run_in_background: true）執行：<JSON.run_command>，結束後依 goal SKILL 步驟 5 回報。" })
```
**記下 timer 的 job id。** 回報使用者（步驟 5 的「已準備」格式），並說明「`confirm_timeout_minutes` 分鐘內未回覆將於 `confirm_timer_target_local` 自動啟動」。

### 4. 收斂
- **同意** → `CronDelete <timer id>` → 用 Bash、`run_in_background: true` 執行 `<JSON.run_command>`（它會阻塞到引擎結束並印 summary JSON）。
- **要改條件** → `CronDelete <timer id>` → 重寫暫存檔 → 重跑步驟 3（舊 run 目錄留著無妨）。
- **取消** → `CronDelete <timer id>`，結束。
- **逾時無回覆** → timer fire，照它的指令執行 `run_command`。

### 5. 回報使用者

**已準備（步驟 3 後）**：完成條件全文、timer job id 與自動啟動時間、run_dir、取消方式（`CronDelete <id>`）。

**引擎結束後**（背景指令結束會收到通知，讀它印的 JSON）：必含
- 達成與否：`goal_achieved`（`goal_set` 為 false 代表引擎根本沒設目標，這是異常，要講）
- 回合數 `num_turns`、被推回去續行的次數 `continuations`、耗時、`total_cost_usd`
- `result_text`：引擎最後一則回覆（做了什麼／怎麼驗證／未完成項），**原文保留不摘要**
- `run_dir`（要追查看 `stream.jsonl`）
- `permission_denials` 非 0 或 `ok:false` → 原文列出，說明可能要調 `engine.permissionMode`

**回報格式——本機有 wtf plugin 時套它的重講紀律**（使用者已明確授權本 skill 在此步套用；wtf 本身是 `disable-model-invocation: true`，**不要**用 Skill 工具去呼叫它，也不要跑它的問寬度流程）：
1. JSON 的 `wtf.installed` 為 true → 讀 `wtf.skill_md`，照它的規則寫這則回報：先一句脈絡、一句話一件事、關係一律畫 ASCII 表格或箭頭圖、砍鋪陳與重複、事實一件不能少、證據原文逐字保留；寬度上限用 `wtf.terminal_width`（null 就用 80，不要問）。
2. `wtf.installed` 為 false → 用上面的必含欄位以列點回報。

**不發 LINE**（本 skill 沒有 LINE 收尾）。**嚴禁**在回報結尾追加任何提問或 offer。

## 運作原理（why）

- **子程序而非本 session**：本 session 的對話會被引擎佔用直到達成；子程序讓你在本對話保持可對話，且引擎的完整事件流留在 `stream.jsonl` 可追查。代價是子程序看不到本對話的上下文，所以任務原文與完成條件必須自足。
- **為什麼 timer 的 prompt 是文字指令**：它 fire 進來就是普通回合，你照指令起子程序即可；放 `/goal` 反而沒用。
- **`stopHookBlockCap` 預設 0**：官方引擎預設連續 8 次擋停就放棄；無人值守要的是做到達成，所以關掉上限。要保險就在設定檔給個數字。
- **成本**：每次 run 是一個獨立 session，任務再小也有固定開銷（實測極簡任務約 0.8 USD）；要省就設 `engine.model`。

## Non-goals
不發 LINE、不算 quota、沒有 plain 模式、不在本 session 內跑引擎。

## 注意
- 只用 CronCreate 排逾時 timer，不可用 SQL 偽造；`CronList` 可查。
- cron 到點時你正在打字或 Claude 正在跑：排程器只在 REPL idle 時 fire，會等下一個空檔，不會漏掉（依 CronCreate 工具說明）。
- 背景執行的 `run_command` 結束才會通知；引擎跑很久是正常的，不要中途去殺。
