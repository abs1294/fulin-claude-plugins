# delaylocal ⏳

把一段 prompt 排程到 **5 小時 quota 重置之後**，自動在本機**無人值守**執行，完成或中止後發 **LINE 通知**（選用，未設憑證則自動略過、不影響執行）。

## 能幫我做什麼

quota 快用完、但還有事想跑？把它排到 quota 重置後，Claude Code 在本機自己醒來把它做完，你不用守著。典型情境：
- 「quota 快滿了，這個任務排到額度回來再自動跑」
- 長時間的整理/產生/批次工作，留到離峰額度執行
- 無人值守跑完發 LINE 通知你結果

## 運作原理

確定性邏輯全在工具裡，skill 只負責「呼叫工具 → 拿結果 → CronCreate」，不靠 AI 即興：
- **鎖定當前 session**：讀 `CLAUDE_CODE_SESSION_ID`，算出這個 session 的 5h quota 重置時間。
- **durable cron 排程**：用 `CronCreate` 排到重置後；final prompt 內建 **session 守衛**（只有原 session 會真正執行，別的 session 醒來會跳過）。
- **無人值守紀律**：final prompt 內建「不停下來問、持續做到無可執行項目、收尾前強制自問清單」。

## 安裝

```
/plugin install delaylocal@fulin-plugins
/reload-plugins
```

（或手動 symlink skill 目錄到 `~/.claude/skills/delaylocal`，見 SKILL.md。）

### 前置（一次性）

1. **需要 Node.js**（`delaylocal.js` / `notify-line.js` 為 node 腳本）。Windows `winget install OpenJS.NodeJS`、macOS `brew install node`、Linux 套件管理器。
2. **LINE 通知為選用**（有設就發、沒設自動略過、不影響執行）。要啟用設定其一，憑證**不進 git**：
   - 複製 `skills/delaylocal/notify-line.config.example.json` → `notify-line.config.json`（同目錄），填 LINE Channel Access Token 與 userId；**或**
   - 設環境變數 `LINE_TOKEN`、`LINE_USER_ID`。

## 用法

```
/delaylocal <要排程的 prompt 原文>
# 或自然語言：「把這個任務排到 quota 重置後再跑」
# 直接排不囉嗦：「直接排程 / 不要問直接排」→ 走 fast-path，立刻排不反問
```

排程成功會回報 Cron Job ID、觸發時間、綁定 session；取消用 `CronDelete <id>`。

> ⚠️ durable cron 需要 Claude Code process 活著且 REPL idle 時才會 fire——所以「無人值守」指的是你人不用守著，但 Claude Code 程式要開著。
