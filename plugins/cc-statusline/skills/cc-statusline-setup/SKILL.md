---
name: cc-statusline-setup
description: 幫使用者把 cc-statusline 這條 status line 接上他的 settings.json（plugin 無法自動設定主 status line，需寫 statusLine 欄位才會生效）。**務必先問過使用者、同意才寫**，不自動改設定。當使用者說「幫我設定 statusline」、「啟用 cc-statusline」、「裝了 cc-statusline 但沒反應 / status line 沒出來」、「把 status line 接起來」、「設定 cc-statusline」時觸發。
---

# cc-statusline-setup — 把 status line 接上 settings.json（先問再寫）

`/plugin install cc-statusline` 只會下載檔案，**不會**讓 status line 自動生效——Claude Code 不支援由 plugin 自動設定主 status line（`plugin.json` 沒有這欄，官方限制）。要生效，必須在使用者的 `settings.json` 寫入 `statusLine` 欄位。本 skill 負責這一步，**核心原則：一定先問過使用者、得到同意才寫入，絕不自動或無聲修改設定檔。**

## 要寫入的內容

```json
"statusLine": {
  "type": "command",
  "command": "node \"${CLAUDE_PLUGIN_ROOT}/statusline.js\"",
  "padding": 0,
  "refreshInterval": 30
}
```

`${CLAUDE_PLUGIN_ROOT}` 會展開到當前啟用版本的 plugin 目錄，升版也不會壞——**不要**改用含版本號的絕對路徑。

## 流程（每一步都對使用者透明）

1. **確認 plugin 已裝**：確認 `cc-statusline` 已安裝（否則先請使用者 `/plugin install cc-statusline@fulin-plugins`）。

2. **問要寫哪個 scope**：
   - 全域（所有專案都有）→ `~/.claude/settings.json`
   - 只這個專案 → 專案的 `.claude/settings.json`
   若使用者沒指定，預設建議全域，但**先問一句確認**。

3. **讀現況並偵測衝突**：讀目標 `settings.json`。
   - 若**已有** `statusLine` 欄位：把現有的 `command` 秀給使用者看，**問他要不要覆蓋**成 cc-statusline 的。他不要就停手。
   - 若**沒有** `statusLine`：告訴他將新增這段，**問他同意嗎**。
   - 檔案不存在：告訴他將建立 `settings.json` 並寫入，**問他同意嗎**。

4. **得到明確同意後才寫**：把 `statusLine` 段合併進該 `settings.json`（保留其他既有設定，只加/改 `statusLine` 這一個 key，不要整檔覆寫）。寫入用格式化 JSON。

5. **回報 + 後續**：
   - 告訴使用者已寫入哪個檔、內容為何。
   - 提醒約 30 秒（`refreshInterval`）或送出下一則訊息後刷新即可看到。
   - 前置依賴 **Node.js**（`command` 用 `node` 執行）——若使用者環境沒有 node，status line 會空白，提醒他裝。

## 相關

- 裝好後想開關各列顯示（cost / quota / mcp…），用 `/cc-statusline-rows`。
- 選配的 MCP 即時刷新見 plugin README「選配：MCP 狀態即時刷新」段。

## 邊界

- **只碰目標 `settings.json` 的 `statusLine` 一個 key**，不要動其他設定、不要改 `statusline.js`。
- **任何寫入前一定先問**——這是本 skill 存在的理由（使用者明確要「先問、不自動」）。使用者說不要，就不寫、據實回報。
