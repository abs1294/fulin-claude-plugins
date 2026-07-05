# cc-statusline

資訊密度高的 Claude Code status line。一次把當前狀態攤在眼前：目錄、git repo/branch、模型、本 session 成本、token 用量與 context 佔比、5h quota 額度與重置倒數、執行中的 subagent、觸發中的 skill、memory 與 MCP server 健康狀態、近期編輯過的檔案、動作歷史。

特點：

- **多欄排版**：左右分欄 + 全寬列混排，資訊多但不亂。
- **East-Asian 寬字對齊**：中文/emoji 等寬字元照 UAX #11 正確算寬，欄位不會歪。
- **原子寫入的跨進程狀態快取**：多個 Claude Code session 同時跑也不會寫壞共享狀態（CAS-style merge + rename 原子寫）。
- **逐列開關**：附 `/cc-statusline-rows` skill，用自然語言開關任一列或整條關閉。

---

## 資料從哪來：6 支 tracker hooks（裝 plugin 即自動註冊）

status line 上的 agents / skills / 近期編輯 / 動作歷史 / 頂部摘要 / compact 次數，不是 statusline.js 自己變出來的——它們由 6 支 tracker hooks 在對應事件時寫入 temp 狀態檔，statusline.js 只負責讀：

| hook | 事件 | 餵哪一列 |
|------|------|----------|
| `message-tracker.js` | UserPromptSubmit、Stop | history（動作歷史） |
| `summary-updater.js` | UserPromptSubmit | summary（頂部摘要） |
| `file-tracker.js` | PostToolUse (Write\|Edit) | edited（近期編輯檔案） |
| `skill-tracker.js` | PostToolUse (Skill) | skills（觸發中的 skill） |
| `subagent-tracker.js` | SubagentStart/Stop | agents（執行中的 subagent） |
| `compact-monitor.js` | PreCompact | compact 計數 |

這些 hooks 由本 plugin 的 `hooks/hooks.json` **在安裝啟用時自動註冊**（v0.2.0 起），不需手動設定。沒有它們，上述各列會永遠空白（其餘列如 dir/repo/model/cost/quota 不受影響）。

> ⚠️ **重複註冊警告**：若你以前曾手動把這些 tracker 複製到 `~/.claude/hooks/` 並註冊在自己的 `settings.json`，啟用本 plugin 後同一事件會**跑兩份**（history 列會出現重複條目）。請二選一：移除 settings.json 裡的手動註冊，或不啟用本 plugin 的 hook（開發機直接把 settings.json 指向 repo 內路徑時，就不要同時啟用本 plugin）。

## ⚠️ 安裝需手動一步（plugin 無法自動接上 status line）

Claude Code **不支援由 plugin 自動設定主 status line**（plugin.json 沒有這個欄位，此為官方限制）。所以裝完 plugin 後，還需要在 `settings.json` 加一段 `statusLine` 指到本 plugin 帶的腳本——但**這步不必自己動手：直接跟 Claude 說「幫我設定 statusline」即可**，它會觸發 `/cc-statusline-setup` 替你寫入（先問你要寫哪個 scope、同意才寫）。想手動加的話照下方步驟。

好消息：可以用 `${CLAUDE_PLUGIN_ROOT}` 變數，它永遠指到「當前啟用版本」的 plugin 目錄，**升版也不會壞**，不用填含版本號的絕對路徑。

### 步驟

1. 安裝 plugin：

   ```text
   /plugin marketplace add abs1294/fulin-claude-plugins
   /plugin install cc-statusline@fulin-plugins
   ```

2. **設定 `settings.json`**。兩種方式擇一：

   **(a) 讓 skill 幫你設（推薦）**——裝完後直接跟 Claude 說「幫我設定 statusline」，會觸發 `/cc-statusline-setup`。它會**先問你**要寫全域還是單一專案、若已有 statusLine 會問你要不要覆蓋，**同意才寫**，不自動改設定。

   **(b) 手動加**——在你的 `~/.claude/settings.json`（使用者層，全域生效）加入：

   ```json
   {
     "statusLine": {
       "type": "command",
       "command": "node \"${CLAUDE_PLUGIN_ROOT}/statusline.js\"",
       "padding": 0,
       "refreshInterval": 30
     }
   }
   ```

   > 只想在單一專案啟用就寫進該專案的 `.claude/settings.json`（同一段內容）。
   > 已經有 `statusLine` 設定的話，改掉 `command` 那行即可。

3. 重載讓設定生效（送出下一則訊息、或 `/reload` 一類的重整動作）。約 30 秒（`refreshInterval`）刷新一次。

前置依賴：**Node.js**（腳本是 `node` 執行）。

---

## 逐列開關 `/cc-statusline-rows`

裝好 plugin 後，直接用自然語言調整顯示，例如：

- 「關掉 status line 的 cost 那列」
- 「status line 只留 dir、repo、model、quota」
- 「隱藏 quota」
- 「關掉整條 status line」
- 「重設 status line 顯示（全部打開）」

背後改寫 `~/.claude/cc-statusline-rows.json`；**此檔不存在 = 全部顯示**。可開關的列：

`summary`（頂部摘要）、`dir`、`repo`、`model`、`cost`、`usage`、`quota`、`agents`、`skills`、`memory_mcp`、`edited`、`history`，外加總開關 `enabled`。

也可手動編那個 JSON——只寫要關的 key 即可，例如 `{ "cost": false, "history": false }`。

---

## 選配：MCP 狀態即時刷新

`memory_mcp` 那列會顯示 MCP server 的連線健康（✔ 連線 / ✘ 失敗 / △ 待授權）。這份資料由背景刷新腳本 `hooks/mcp-status-refresh.js`（跑 `claude mcp list` 寫快取）產生。

**限制**：`statusline.js` 目前**只在 `~/.claude/hooks/mcp-status-refresh.js` 這個固定位置**找刷新腳本（找不到就靜默跳過，其餘欄位完全不受影響）。因此若你要 MCP 那列會自動更新，需手動把本 plugin 的刷新腳本複製過去一次。

從本 repo 直接複製最簡單：

```bash
cp <你 clone 的 repo>/plugins/cc-statusline/hooks/mcp-status-refresh.js ~/.claude/hooks/mcp-status-refresh.js
```

若只裝了 plugin 沒 clone repo，檔案在 plugin cache 裡（路徑含版本號、升版會變）：

```bash
# 先找出實際路徑
ls ~/.claude/plugins/cache/*/cc-statusline/*/hooks/mcp-status-refresh.js
# 再 cp 到 ~/.claude/hooks/
```

不做這步也沒關係——MCP 那列會顯示最後一次的快取或留空，status line 其餘所有欄位一切正常。

---

## 相容性

- 路徑全用 `os.homedir()`，Windows / macOS / Linux 皆可攜，無硬編個人路徑。
- 所有讀外部檔的地方都有 try/catch 兜底，缺任何配置檔都會安全降級，不會讓 status line 掛掉。
