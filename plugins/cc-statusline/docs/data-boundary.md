# 資料界線：誰蒐集、誰匯總

適用對象：這個 repo 裡所有會用到「額度、token、花費、對話活動」的 plugin。
寫程式前先看這份；要新增資料來源或欄位，先改這份再寫程式。

## 最高原則

**cc-statusline 負責蒐集資料。匯總可以讓 cc-statusline 做，也可以各 plugin 自己做。**

一句話分辨：**碰到原始來源就是蒐集，只碰 cc-statusline 寫出來的檔就是匯總。**

| | 蒐集 | 匯總 | 顯示與決策 |
| --- | --- | --- | --- |
| 做什麼 | 讀原始來源、認出是什麼、去重、計價、記下時間、寫成檔 | 把已經蒐集好的資料加總、分組、排名、比較、換算成百分比 | 畫面、文字、提醒、擋不擋、等多久 |
| 誰做 | **只有 cc-statusline** | cc-statusline 或各 plugin | 各 plugin |
| 能碰的東西 | 原始來源 | 只有下面「公開介面」列的檔 | 匯總的結果 |

## 這份管的資料

| 資料 | 原始來源 |
| --- | --- |
| 帳號額度（5 小時、7 天） | 向 Claude Code 查（get_usage）、狀態列收到的額度 |
| token 用量、花費 | 對話紀錄裡每則回應的 usage、牌價表 |
| context 用掉多少 | 最近一則回應的 usage |
| 對話活動（訊息數、壓縮次數、子代理、skill、MCP、改過的檔、排程、摘要） | hook 收到的內容 |

**不在這份範圍**：對話的文字內容、標題、工具的輸入與輸出、檔案改動。那是「內容」不是「用量」，各 plugin 為了自己的功能可以直接讀對話紀錄（例如看板顯示對話、harness 健檢看同一個檔重複讀了幾次）。讀內容時順便遇到 usage，也不可以拿來加總或計價。

## 蒐集（cc-statusline 必須做到）

1. **不靠狀態列也要收得到**：看板裡的對話、`claude -p`、沒有開終端機的時候都要算，用 hook 收。
2. **每則只算一次**：同一則回應在對話紀錄裡會寫很多次、子代理的會抄進主對話、複製出來的對話會帶著舊內容，全部要去重。
3. **帶時間**：每份檔都有 `at`（毫秒）＝資料真正取得的時間，不是寫檔的時間。收不到新的就留著舊的和舊的時間，不可以蓋新時間。
4. **分得出「沒有」和「還不知道」**：例如帳號沒有 5 小時額度是 null；有但沒在計時是另一種寫法。
5. **不寫對話內容**：公開介面只有數字、名稱、時間，例外是既有的訊息與摘要檔（見下表）。
6. **不花使用者的錢、不讓人等**：不跑模型、不送訊息；重的工作在背景做。
7. **單價只有一份**：`scripts/lib-price.js` 的牌價表。單價改變時要把算過的重算。
8. Windows、macOS、Linux 都要對；寫檔要整份換（先寫暫存檔再改名）。

## 匯總（誰都可以做，照這幾條選）

| 情況 | 放哪裡 |
| --- | --- |
| 兩個以上的 plugin 要同一個數字 | cc-statusline，公開成介面 |
| 需要原始來源才算得出來 | cc-statusline（這其實是蒐集） |
| 舊資料會被清掉、要長期留存的 | cc-statusline（例如每月用量：Claude Code 會清掉舊對話紀錄） |
| 只有自己的畫面用、從公開介面就算得出來 | 自己做 |

自己做匯總的規則：

- 輸入只能是公開介面。算出來的結果只給自己用，**不可以變成別的 plugin 的資料來源**；別人也要，就搬進 cc-statusline。
- 可以存自己的快取，但要記下根據的是哪個 `at`，來源更新了就重算。
- 同一個東西的合計要跟 cc-statusline 的合計相等；不相等就是 bug，先查再顯示。
- 不可以自己寫死單價；要計價就用介面檔裡附的 `prices`。

## 使用方的規則

1. 只讀「公開介面」列的檔與欄位。檔裡其他欄位是 cc-statusline 自己的，隨時會改。
2. 先看 `v`（介面版本）。沒有 `v`＝那個檔的產生版本太舊；`v` 比自己認得的大也照用（欄位只加不改）。
3. 讀不到、太舊：說清楚（沒裝、版本太舊、幾分鐘前的資料），**不可以退回去自己讀原始來源**。
4. 資料有新舊時顯示 `at`，或用它決定要不要提醒。
5. 不可以寫、改、刪 cc-statusline 的檔，也不可以去觸發它的掃描。
6. 缺欄位就來這份提需求、改 cc-statusline，不要在自己這邊先算一份頂著。

**例外：自己啟動的那一次執行。** plugin 自己跑了一次 `claude -p`，Claude Code 在結果裡回報這一次的花費或 token，可以直接拿來顯示「這一次花了多少」，因為那是自己那次呼叫的回傳值。限制：
- 那一次不可以是接續（`--resume`）或複製（`--fork-session`）別的對話：這時回報的是整個對話的累計，不是這一次（2026-11-24 實測 2.1.325：0.0039，接續後 0.0076，再接續 0.0098）。
- 不可以把很多次加總成「花了多少」；要合計就讀公開介面。

## 公開介面

位置：`S`＝`~/.claude/cc-statusline/state`，`U`＝`~/.claude/usage-data`；`<sid>`＝session id 去掉非英數字後的前 24 字。
規則：欄位只加不改；非改不可時 `v` 加一，並先通知所有使用方。

| 介面 | 檔案 | 欄位 | 多久更新 | 產生者 |
| --- | --- | --- | --- | --- |
| 帳號額度 | `S/account-limits.json` | `v:1`、`at`、`tried`、`none`、`five_hour`、`seven_day`；視窗是 `{used_percentage, resets_at(秒或 null)}` 或 null。null＝帳號沒有這個額度；`resets_at` 是 null＝有、目前沒在計時；`none:true`＝這個帳號沒有這種額度（API key） | 每次回覆完，最多 5 分鐘一次 | `hooks/account-limits.js`（1.9.0 起） |
| 單一對話用量 | `S/claude-toksum2-<sid>.json` | `v:1`、`at`、`total`：`cost`、`tok`、`mainCost`、`mainTok`、`agentCost`、`agentTok`、`agentRuns`、`unpricedTok`、`approxTok`（後兩個大於 0＝有一部分沒有單價或是暫估單價）；`context`：`{tokens, model, effort, at}`，最近一則回覆送進模型的量，還沒回覆過是 null | 回覆完、送出訊息、子代理結束、狀態列刷新 | `scripts/lib-session-usage.js`（1.10.0 起） |
| 每則用量紀錄 | `U/records/meta.json`、`U/records/<yyyy-mm>/<專案>.jsonl`（專案＝對話紀錄的資料夾名，超過 180 字的縮短，跟 `meta.projects` 同名） | 一行一則，已去重、已計價，只增不減：`id`、`ts`、`sid`、`agent`、`role`、`team`、`file`、`line`、`model`、`key`、`in`、`out`、`cw5`、`cw1`、`rd`、`think`、`cost`、`flag`、`entry`；0 與空字串省略；月份照 `ts` 的 UTC。`meta.json`：`v:1`、`at`、`prices`、`modelIds`、`projects`、`months`、`records`。逐欄說明在 `scripts/lib-records.js` 檔頭。Claude Code 清掉對話紀錄之後仍留著 | 該對話回覆完、送出訊息、子代理結束；全部對話最多 10 分鐘一次（`meta.at`＝上次全部看過的時間） | `scripts/lib-records.js`（1.10.0 起） |
| 全機用量明細 | `U/cc-statusline-usage-detail.json` | `v:1`、`at`、`sig`、`tz`、`prices`、`modelIds`、`byDay`、`byModel`、`byProject`、`sessions`、`sessionsTotal`、`sessionsRest` | 最多 15 分鐘一次（1.9.x 是 6 小時） | `scripts/all-usage-refresh.js`：從每則用量紀錄匯總（1.9.0 起） |
| 壓縮次數 | `S/claude-compacts-<sid>.json` | `count`、`last`；沒有檔＝0 次 | 壓縮時 | `hooks/compact-monitor.js` |
| 訊息數 | `S/claude-msgcount-<sid>` | 純文字的整數 | 送出訊息時 | `hooks/summary-updater.js` |
| 最近訊息 | `S/claude-msgs-<sid>.json` | `[{r:'u' 或 'a', t:文字}]`，最多 30 則（含對話文字） | 送出訊息、回覆完 | `hooks/message-tracker.js` |
| 摘要 | `S/claude-summary-<sid>.txt` | 一行文字（含對話文字） | Claude 更新時 | `hooks/summary-updater.js` 提示、由 Claude 寫 |
| 子代理 | `S/claude-agents-<sid>.json` | `{id: {name, status:'running'或'done', started, finished}}`；只留最近的，不是全部 | 子代理開始、結束 | `hooks/subagent-tracker.js` |
| skill | `S/claude-skills-<sid>.json` | `{名稱: {count, last}}`；只留最近的 | 用到時 | `hooks/skill-tracker.js` |
| MCP 呼叫 | `S/claude-mcp-<sid>.json` | `{名稱: {count, errors, last}}`；只留最近的 | 用到時 | `hooks/mcp-tracker.js` |
| 改過的檔 | `S/claude-files-<sid>.json` | 檔名陣列，最近 8 個 | 改檔時 | `hooks/file-tracker.js` |

不是公開介面（只有 cc-statusline 自己用）：`~/.claude/rate-limit-snapshots.json`、`U/cc-statusline-all-usage.json`、`U/cc-statusline-cumulative.json`、`U/cc-statusline-prices.json`、`U/records/.own/`、`S/claude-crons-*`、`S/claude-agent-models-*`。

「單一對話用量」與「每則用量紀錄」的同一個對話，合計相同；例外是 2.1.32x 之前複製出來的對話：前者把帶過來的舊內容也算進去，後者算原本那個對話的。

## 現況登記

`hooks/tests/data-boundary.test.js` 會掃其他 plugin 的程式，凡是碰到 token 欄位、花費欄位、額度來源的檔都要登記在下面，沒登記就失敗；登記了但已經不碰的也會失敗。格式：`檔案 | 種類 | 說明`。種類只有兩種：

- `own-run`：符合上面「自己啟動的那一次執行」的例外。
- `gap`：不符合界線，還沒搬。新程式不可以登記成 gap，要使用者同意。

```boundary
goal2/lib/engine.js | own-run | 一個 run 自己的花費（同一個 run 內累計，不跨 run 加總）
goal2/skills/delaylocal/delaylocal.js | own-run | 給模型的說明文字提到 run 的花費欄位，不取值
session-board/lib/goal2.js | own-run | 轉述 goal2 的 run 紀錄
session-board/public/index.html | own-run | 顯示 goal2 的 run 花費
session-board/lib/aside.js | own-run | 單次執行的花費；接續對話的不顯示
session-board/lib/decide.js | own-run | 單次執行的花費
session-board/lib/inbox/triage.js | own-run | 單次執行的花費
session-board/lib/line.js | own-run | 單次執行的 token
harness/hooks/templates/compact-handoff.js | own-run | 單次執行的花費
harness/hooks/templates/learn-reflect.js | own-run | 單次執行的花費
```
