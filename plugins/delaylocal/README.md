# delaylocal ⏳

**讓 5 小時的 quota 等待不再浪費——額度用完還有事想跑，現在就排好，額度一回來它自己在本機把任務做完、發 LINE 通知你，你不用守著電腦。**

Claude Code 的 quota 每 5 小時重置一次。以前額度用完又有任務想跑，只能設鬧鐘等重置、手動回來貼 prompt。delaylocal 把這段等待自動化，重置後在本機**無人值守**執行，完成或中止發 **LINE 通知**（選用，未設憑證自動略過、不影響執行）。

## 典型情境

- 「quota 快滿了，這個任務排到額度回來再自動跑」
- 長時間的整理 / 產生 / 批次工作，留到離峰額度執行
- 排好就去睡，跑完用 LINE 通知你結果

## 運作原理

確定性邏輯全在工具裡，skill 只負責「呼叫工具 → 拿結果 → CronCreate」，不靠 AI 即興：

- **鎖定當前 session**：讀 `CLAUDE_CODE_SESSION_ID`，算出這個 session 的 5h quota 重置時間。
- **durable cron 排程**：用 `CronCreate` 排到重置後；final prompt 內建 **session 守衛**——只有原 session 會真正執行，別的 session 醒來會自動跳過。
- **做到完成**：預設用下方的 **goal 模式**確保任務真正做完才停（詳見下節）。

## goal 模式（預設）：把「想做的事」變成「可驗證的完成條件」

無人值守最大的風險是 AI 自以為做完就停了、其實漏了一半。goal 模式解這個問題——不是讓 AI 自己覺得「差不多了」，而是先定一條**可測量的完成條件**，交給 Claude Code 的 goal 引擎（每回合用 Haiku 檢查器驗證）**做到達成為止**。

關鍵在排程前那一步：**你只給原始 prompt，由 Claude 幫你推導出完成條件**。

1. **你說想做什麼**：例如「把 `docs/` 下所有 markdown 的壞連結修掉」。
2. **Claude 幫你推導成可驗證的完成條件，先 propose 給你過目**：例如「`npx markdown-link-check docs/**/*.md` 回報 0 個壞連結」。你的原始 prompt 會原封不動放進任務清單，完成條件是另外加的一層「驗收標準」。
3. **你確認**（或 10 分鐘沒回覆 → 自動採納，不卡排程）。
4. **工具組裝排程**：把確認後的條件組成 `/goal <完成條件>` 開頭的 prompt，額度回來後 fire，goal 引擎照這條標準做到達成。「已發 LINE 收尾通知」也被寫進完成條件，所以 goal 不會在通知前提早結束（未設 LINE 憑證則自動略過、同樣算達成）。

> 為什麼要先 propose？完成條件寫得模糊，goal 引擎會空轉燒 token；寫得好才能真正「做到完成」而不是「做到 AI 覺得夠了」。由 Claude 先擬、你過目，兼顧品質與不打擾。
>
> 少數任務無法定義可測量條件時，可退回 **`--plain` 文字紀律模式**：不需完成條件、跳過 propose，改用內建的「收尾前強制自問清單」。

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
