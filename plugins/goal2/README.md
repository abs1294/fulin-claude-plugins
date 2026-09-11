# goal2 🎯

**把「想做的事」變成「可驗證的完成條件」，交給 Claude Code 的 goal 引擎做到達成為止——現在就做（`goal`），或排到 5 小時 quota 重置後無人值守做（`delaylocal`）。**

無人值守最大的風險是 AI 自以為做完就停了、其實漏了一半。goal 引擎解這個問題：不是讓 AI 自己覺得「差不多了」，而是先定一條**可測量的完成條件**（每回合用 Haiku 檢查器驗證），**做到達成為止**。關鍵在前一步：**你只給原始 prompt，由 Claude 幫你推導出完成條件、先 propose 給你過目**（逾時沒回覆就自動採納、不卡流程；逾時分鐘數可在設定檔調）。

> plugin 名叫 `goal2` 是為了避開 Claude Code 內建的 `/goal` 指令；兩個 skill 的觸發名是 `/goal2:goal` 與 `/goal2:delaylocal`。

## 兩個 skill

> **wtf 整合**：`goal` skill 的最終回報，若本機裝了 `wtf` plugin（重講紀律：一句話一件事、關係畫表、事實不漏），會套它的格式寫，寬度用 wtf 記的視窗寬。這是使用者授權的例外——wtf 本身禁止模型自行呼叫，這裡不呼叫它，只套規則。

| | `goal` | `delaylocal` |
|---|---|---|
| 一句話 | 定好完成條件，**現在**就讓引擎做到完成 | 定好完成條件，**quota 重置後**在本機無人值守做到完成 |
| 觸發 | `/goal2:goal <任務>`、「幫我定完成條件再跑」、「用 goal 引擎做到完成」 | `/goal2:delaylocal <任務>`、「排程到 quota 之後」、「等 5h 額度回來再跑」 |
| 引擎何時起 | 你同意當下（或確認逾時自動採納，預設 1 分鐘） | 5h quota 重置後 + 緩衝（預設 15 分）的 cron 到點時；確認逾時預設 10 分鐘 |
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
- **4000 字元上限**：`/goal` 條件超過會卡死引擎。`lib/goal-head.js` 統一處理——第一行 ≤ 3900 照放，超過則換指針句、完整條件下放工作清單步驟 0。

## 設定（選用）

設定都在 `~/.claude/goal2/config.json`（家目錄，重裝 plugin 不會被清掉）。複製 plugin 根層的 `config.example.json` 過去改即可，所有欄位選填：

```json
{
  "engine":     { "permissionMode": "bypassPermissions", "stopHookBlockCap": 0, "model": null },
  "goal":       { "confirmTimeoutMinutes": 1 },
  "delaylocal": { "confirmTimeoutMinutes": 10, "bufferSeconds": 900 }
}
```

| 欄位 | 意思 | 預設 |
|---|---|---|
| `engine.permissionMode` | 子程序 `claude -p` 的權限模式。無人值守遇到權限提示就會卡死，所以預設全放行；保守可改 `acceptEdits` | bypassPermissions |
| `engine.stopHookBlockCap` | 引擎連續擋停幾次後 Claude Code 強制結束回合（Claude Code 自己預設 8）；0 = 不設上限 | 0 |
| `engine.model` | 子程序用的模型；每次 run 是獨立 session、有固定開銷（極簡任務實測約 0.8 USD），要省就改小模型 | null（沿用預設） |
| `goal.confirmTimeoutMinutes` | propose 後等你確認幾分鐘；逾時自動採納並啟動引擎 | 1 |
| `delaylocal.confirmTimeoutMinutes` | propose 後等你確認幾分鐘；逾時自動採納並排程 | 10 |
| `delaylocal.bufferSeconds` | quota 重置後再等幾秒才 fire（`/goal2:delaylocal` 帶裸數字可臨時覆蓋） | 900 |

檔案不存在就全用預設；存在但 JSON 壞掉、值型別錯、或有打錯的欄位名，工具會直接報錯而不是靜默用預設。`node <skill_dir>/goal.js --show-config` 或 `delaylocal.js --show-config` 可看生效值。

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

成功會回報 Cron Job ID、觸發時間、完成條件；取消用 `CronDelete <id>`。

> ⚠️ cron 只活在本 Claude Code process（`durable` 在目前版本無效），且 REPL idle 時才會 fire——「無人值守」指的是你人不用守著，但 Claude Code 程式要開著。引擎子程序一旦起來就獨立跑，不受本對話影響。
