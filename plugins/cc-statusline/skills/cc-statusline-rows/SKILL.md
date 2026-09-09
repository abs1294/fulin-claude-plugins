---
name: cc-statusline-rows
description: 開關 cc-statusline status line 上各列（欄位）的顯示、整條 status line 的總開關，以及面板寬度邊距。當使用者說「/cc-statusline-rows」、「關掉 status line 的 X 列」、「status line 只留 X」、「打開/關閉 成本那列」、「隱藏 quota」、「status line 太長/太吵」、「重設 status line 顯示」、「關掉整條 status line」時觸發；**面板右邊被切掉／換行／跑版／session 名字顯示不全／框線右邊不見了／status line 超出視窗**時也觸發（調 widthMargin）。透過改寫 ~/.claude/cc-statusline-rows.json 生效，statusline.js 下一次刷新即套用。
---

# cc-statusline-rows — status line 逐列顯示開關

`cc-statusline` 的 `statusline.js` 每次刷新時會讀 `~/.claude/cc-statusline-rows.json` 決定哪些列顯示。**此檔不存在 = 全部顯示（預設全開）**。本 skill 的工作就是安全地讀改寫這個 JSON。

## 可開關的列（key）

| key | 內容 |
|-----|------|
| `summary` | 頂部摘要行（濃縮的一行總覽） |
| `dir` | 當前工作目錄 |
| `repo` | git repo / branch 狀態 |
| `model` | 目前模型 |
| `cost` | 本 session 成本 |
| `usage` | token 用量 / context 佔用 |
| `quota` | 5h quota 額度與重置倒數 |
| `agents` | 執行中的 subagent / task |
| `skills` | 可用 / 觸發中的 skill |
| `crons` | 排程狀態（CronCreate / ScheduleWakeup），有排程時佔 agents/skills 欄底部兩行（下一發時刻＋標籤），無排程不顯示不佔位 |
| `memory_mcp` | memory 與 MCP server 狀態 |
| `edited` | 近期編輯過的檔案 |
| `history` | 指令 / 動作歷史 |

另外有一個總開關 key：

| key | 效果 |
|-----|------|
| `enabled` | 設 `false` 時整條 status line 印空字串（完全關閉）。設 `true` 或省略 = 開啟。 |

## 面板寬度邊距（`widthMargin`）

statusline 依環境變數 `COLUMNS` 繪製面板，但**實際可用寬度通常比 `COLUMNS` 少幾格**（TUI 自身的渲染邊距），差幾格**因機器而異**——終端程式、字型、視窗設定都會影響。畫太寬的後果是每一列被 TUI 折行，且被切掉的是每列**最右端**，也就是 session 名字所在處。

| key | 型別 | 說明 |
|-----|------|------|
| `widthMargin` | 非負整數 | 繪製寬度 = `COLUMNS - widthMargin`。省略時預設 `4`。小數無條件捨去；負數、非數字（含字串 `"6"`、布林）一律忽略並回到預設。**無上界檢查**——設太大不報錯，面板會靜默收斂到最小版面（約 87 格）並在右側留大片空白，看到這個症狀就是值給太大。合理範圍通常是 0~12。 |

判斷該設多少**只能目視**，腳本量不出來：

1. 看 status line 最上面那條 `┌───…┐`，**右端的 `┐` 看得到嗎**？
2. 每一列右端有沒有多出 `…`（那是 TUI 的折行記號，不是內容）？
3. session 名字（最右端那串）是否完整？

看得到 `┐`、無折行記號、名字完整 = 目前的值正確。若被切，**每次加 2** 重試（4 → 6 → 8），直到框線完整；若右側空白過多、想收回一點，就往下調。

臨時試值可用環境變數 `CC_STATUSLINE_MARGIN`（優先於設定檔），確認好再寫進設定檔。

優先序：`CC_STATUSLINE_MARGIN` 環境變數 > 設定檔 `widthMargin` > 預設 `4`。

## 檔案格式

`~/.claude/cc-statusline-rows.json` 是一個扁平物件，值為布林（或 0/1）。只需寫「要偏離預設」的 key；沒寫到的 key 一律當作開啟。範例——只想關掉 cost 與 history：

```json
{ "cost": false, "history": false }
```

`widthMargin` 與列開關放在同一個物件裡（值是數字不是布林）：

```json
{ "cost": false, "widthMargin": 6 }
```

只留 dir / repo / model（其餘全關）時，把其他所有列明確設 false 比較清楚：

```json
{ "summary": false, "cost": false, "usage": false, "quota": false, "agents": false, "skills": false, "memory_mcp": false, "edited": false, "history": false }
```

## 操作流程

1. **讀現況**：讀 `~/.claude/cc-statusline-rows.json`。讀不到（檔不存在）就當作 `{}`（= 全開）。
2. **對照使用者意圖**：把上表的中文/口語對到正確的 key。若使用者講「成本」→ `cost`、「額度/quota」→ `quota`、「MCP」或「記憶」→ `memory_mcp`、「編輯過的檔」→ `edited`、「排程/cron/鬧鐘」→ `crons`，以此類推。含糊時（例如只說「關掉最下面那列」）先用上表向使用者確認是哪個 key，不要猜。
3. **合併**：在既有物件上「只改要動的 key」，保留其他既有設定，不要整檔覆寫成只剩這次的 key。
4. **寫回**：把合併後的物件寫回 `~/.claude/cc-statusline-rows.json`（格式化 JSON）。
5. **回報**：告訴使用者最終哪些列開、哪些關，並提醒下一次 status line 刷新（預設約 30s，或送出下一則訊息時）即生效。

## 特殊指令對照

- 「重設 / 全部打開 / 恢復預設」→ 直接刪除 `~/.claude/cc-statusline-rows.json`（缺檔即全開），或寫入 `{}`。刪檔前先確認這是使用者要的。
- 「關掉整條 status line」→ 設 `{ "enabled": false }`（保留其他 key）。
- 「打開整條 status line」→ 設 `enabled: true` 或移除該 key。
- 「status line 太長 / 太吵 / 精簡一點」→ 這是偏好而非明確 key，向使用者提議一組精簡組合（例如只留 `dir/repo/model/quota`），確認後再寫。
- 「右邊被切掉 / 跑版 / 換行 / 名字顯示不全 / 框線右邊不見了 / 超出視窗」→ 這是 `widthMargin` 太小，**不是**列開關問題。把現值加 2 寫回（未設過就從 4 加到 6），並請使用者看框線右上角的 `┐` 是否出現；還是被切就再加 2。
- 「右邊空白太多 / 面板太窄」→ `widthMargin` 太大，往下調 2。

## 注意

- 只碰 `~/.claude/cc-statusline-rows.json` 這一個檔，**不要**去改 `statusline.js` 或 `settings.json`。
- key 打錯（不在上表）會被 statusline.js 忽略，不會報錯但也不會生效——寫入前務必用上表核對 key 拼字。
- `widthMargin` 的值是**數字**，不是布林；寫成 `true`／`"6"`（字串）都會被忽略而回到預設 4。
- **`widthMargin` 的正確值無法由腳本推導，只能由使用者目視回報**——不要自行宣稱「已修正對齊」，要請使用者確認框線右端的 `┐` 是否完整出現。
