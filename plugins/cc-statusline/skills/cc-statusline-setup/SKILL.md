---
name: cc-statusline-setup
description: 幫使用者把 cc-statusline 這條 status line 接上他的 settings.json（plugin 無法自動設定主 status line，需寫 statusLine 欄位才會生效），並在生效後帶他做一次面板寬度目視校正（widthMargin，因機器而異）。**務必先問過使用者、同意才寫**，不自動改設定。當使用者說「幫我設定 statusline」、「啟用 cc-statusline」、「裝了 cc-statusline 但沒反應 / status line 沒出來」、「把 status line 接起來」、「設定 cc-statusline」時觸發。
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
   - **順檢 hook 重複註冊**：本 plugin 的 6 支 tracker hooks（message/summary/file/skill/subagent 追蹤與 compact 計數）由 plugin 的 `hooks/hooks.json` 自動註冊，setup 不需處理。但要檢查使用者的 `settings.json` `hooks` 段裡有沒有指向 `~/.claude/hooks/` 下同名 tracker（`file-tracker.js`、`message-tracker.js`、`summary-updater.js`、`skill-tracker.js`、`subagent-tracker.js`、`compact-monitor.js`）的**手動註冊**——有的話同一事件會跑兩份（history 列出現重複條目）。把找到的條目列給使用者看，**問他要不要一併移除**；他不要就保留並提醒後果。

4. **得到明確同意後才寫**：把 `statusLine` 段合併進該 `settings.json`（保留其他既有設定，只加/改 `statusLine` 這一個 key，不要整檔覆寫）。寫入用格式化 JSON。

5. **回報 + 後續**：
   - 告訴使用者已寫入哪個檔、內容為何。
   - 提醒約 30 秒（`refreshInterval`）或送出下一則訊息後刷新即可看到。
   - 前置依賴 **Node.js**（`command` 用 `node` 執行）——若使用者環境沒有 node，status line 會空白，提醒他裝。

6. **等 status line 出現後，帶他做寬度校正（不可略過）**：見下節。這一步**必做**——預設邊距只在某一台機器上量過，別台不一定對，而畫太寬的症狀（右端被切）使用者往往以為是 plugin 壞了。

## 寬度校正（Step 6，設定完必做）

面板依環境變數 `COLUMNS` 繪製，但**實際可用寬度通常比它少幾格**（TUI 自身的渲染邊距）。少幾格**因機器而異**——終端程式、字型、視窗設定都有影響，**腳本量不出來、你也推導不出來**。畫太寬的後果是每一列被 TUI 折行，且被切掉的是每列**最右端**（session 名字所在處），看起來像 plugin 壞了。

繪製寬度 = `COLUMNS - widthMargin`，預設 `4`（只在單一台 Windows Terminal 上量過）。

**請使用者看三件事**（他的眼睛是唯一判準）：

1. 最上面那條 `┌───…┐`，**右端的 `┐` 看得到嗎**？
2. 每一列右端有沒有多出 `…`？（那是 TUI 的折行記號，不是內容）
3. 最右端的 session 名字完整嗎？

**三項都正常** → 預設值對，不用改，告訴他這樣就好。

**任一項不正常** → `widthMargin` 太小。請他先用環境變數試：`CC_STATUSLINE_MARGIN=6`（每次加 2：4 → 6 → 8），下次刷新看框線是否完整。試到 `┐` 出現、無折行記號、名字完整為止，再把該值寫進 `~/.claude/cc-statusline-rows.json`：

```json
{ "widthMargin": 6 }
```

**右側空白過多**（面板明顯比視窗窄一截）→ 值太大，往下調 2。

寫入該檔可交給 `/cc-statusline-rows`，或直接合併該 key（保留檔內既有的列開關，不要整檔覆寫）。

> **這一步不能由你代為判定**：你看不到他的終端渲染結果，量測數字也證明不了邊距正確。**禁止自行宣稱「已對齊」「版面正常」**——必須請使用者看過框線右端並回報。

## 相關

- 裝好後想開關各列顯示（cost / quota / mcp…）或事後再調 `widthMargin`，用 `/cc-statusline-rows`。
- 選配的 MCP 即時刷新見 plugin README「選配：MCP 狀態即時刷新」段。

## 邊界

- **只碰目標 `settings.json` 的 `statusLine` 一個 key**，不要動其他設定、不要改 `statusline.js`。寬度校正寫的是另一個檔（`~/.claude/cc-statusline-rows.json`），與此不衝突，但同樣只合併 `widthMargin` 這個 key。
- **任何寫入前一定先問**——這是本 skill 存在的理由（使用者明確要「先問、不自動」）。使用者說不要，就不寫、據實回報。
