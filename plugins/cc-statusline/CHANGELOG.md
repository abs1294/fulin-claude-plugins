# Changelog

本檔記錄 cc-statusline 的版本變更，格式依 [Keep a Changelog](https://keepachangelog.com/)。

## [1.6.3] - 2026-09-25
### Fixed
- 單價回填背景程序的鎖改用原子改名接手，並在寫檔時合併，不再有兩支同時抓網頁或互相蓋掉紀錄；整次抓取加 45 秒總時限，伺服器慢速回應也不會卡住；表裡沒有的模型改用同系列版本最接近的單價暫估（原本用最新版，已退役舊型號會被少算，如 opus-3 以 $4 估、實價 $15）
- 版本比較改為每一層各佔獨立位數，兩位數次版本（如 4-10）不再被進位成 5；背景程序開始抓取前再確認一次鎖仍屬於自己，三方同時搶鎖時也只會有一支在抓
- 單價快取改用 hooks/lib-state 的 casMerge 合併寫入（兩支同時寫 200 次實測 400/400 筆不掉，舊寫法掉 193 筆）；背景程序的鎖改名 `.run.lock`，與 casMerge 的寫檔鎖分開。全量用量重掃（all-usage-refresh）原本也是 stat→刪除→建立的搶鎖寫法、結束時不分是誰的鎖就刪，一併改用同一套鎖
- 共用狀態檔的檔案鎖（hooks/lib-state）重寫：拿不到鎖時改為跳過該次更新，不再「不加鎖照寫」；鎖內記錄持有者 pid，只有持有者已結束（或鎖超過上限時間）才會被回收，且同一時間只有一個回收者，不會再刪到別人剛拿到的鎖。statusline.js 內那份同樣寫法的副本改用共用版（拿不到鎖時畫面照常顯示，只是這次不寫回）；message-tracker、cron-tracker、compact-monitor、file-tracker、summary-updater 原本讀改寫完全沒有鎖，一併改用。實測每支 hook 同時觸發 8 次、跑 3 輪：新版全部數量正確；舊版每輪有 4～6 項掉資料（例如壓縮次數 5/8、排程 4/8、同時刪除後排程殘留 2 筆）

## [1.6.2] - 2026-09-25
### Fixed
- cost 計價改為模型 id 精確比對：原本用子字串比對，新模型（Opus 5.5、Fable 5.1）被安靜地套上舊版單價，Opus 5.5 多算約 57%；表裡沒有的模型改以同系列單價暫估並標「~」，背景抓官方單價頁回填後自動重算。另補 1 小時快取寫入的獨立計價
- 回填只補內建表沒有的模型、不覆蓋內建單價；官方頁依表頭欄名解析，缺欄或不足 5 列就整批不寫
- 背景程序（全量用量重掃、單價回填）啟動失敗時，statusline 不再整條崩潰（原本 spawn 的非同步 error 事件沒接住，實測 exit 1）

## [1.6.1] - 2026-09-25
### Fixed
- cron-tracker 改從 tool_response.id 取 job id：原本只用 regex 找「task <id>」，但 hook 收到的是結構化物件，抓不到而落到 cron-<時間戳> 假 id，CronDelete 永遠對不上，statusline 持續顯示已刪除的排程

## [1.6.0] - 2026-09-21
### Added
- **新增 `mcps` 列：觀察 MCP 工具的呼叫活動**，顯示在 middle 欄 agents 區塊的**正下方**（與 skills／crons 同樣的「header ＋ 縮排項目」形狀）。每筆顯示 `Server__tool` ＋ 呼叫次數 ＋ 失敗數 ＋ 多久前，依最近呼叫排序取前 5 筆；本 session 沒有任何 MCP 呼叫時整區不顯示（不佔位、不留空 header）
- mcp 區塊採**欄底固定保留**（比照 crons 在第三欄的 `r3fixed` 做法），不是接在 agents 後面的流動內容。原因實測而來：middle 欄的**高度由左欄列數決定、與終端寬度無關**，實務上常只有 6 格，所以當 mcp 是流動內容時 agents 會吃光所有格，mcp 只剩 header ＋ `…+N`——COLUMNS=200、3 個 agent、5 筆呼叫的實測結果是**一個呼叫名稱都沒顯示出來**，整個功能等於看不到。改為保留欄底後 agents 先被截（它本來就有 `…+N` 機制）
- 保留格數上限為**欄高的一半**，兩個區塊都不會被對方吃光：先前試過固定保留 4 格，在 6 格欄裡反而把 agents 壓成只剩 header ＋ `…+N`，是同一個病換個方向犯。欄高不足 3 格時 mcp 區塊整個讓位
- 新增 `hooks/mcp-tracker.js`（第 8 支 tracker），掛 PostToolUse 的 `mcp__.*` matcher，以 `lib-state.js` 的鎖定 CAS 合併寫入 `claude-mcp-<sid>.json`，與 skill-tracker 同一套併發保護。MCP 工具無 Start/Stop 事件，PostToolUse 在呼叫後才觸發，故只記「呼叫過」沒有執行中狀態
- 顯示名在 **hook 端**就縮短成 `Server__tool`：砍掉 `mcp__` 前綴，再砍健康列也會砍的 `claude.ai `／`plugin:x:` 前綴（此處為底線變體），使兩處對同一 server 的稱呼一致。實測七個真實樣本：`mcp__claude_ai_Gmail__create_draft` → `Gmail__create_draft`、`mcp__claude-in-chrome__computer` → `claude-in-chrome__computer`、`mcp__claude_ai_Adobe_for_creativity__adobe_mandatory_init` → `Adobe_for_creativity__adobe_mandatory_init`
- 前綴比對以 **`__` 雙底線**為 server／tool 分界，且只在「砍掉前綴後 server 名仍非空」時才砍。開發中一度寫成字元類 `^plugin[:_][^:_]+[:_]` 與 `^claude[._]ai[._ ]`，把**單底線也當分隔符**，於是真的叫 `plugin_foo` 的 server 被吃掉自己的名字（`mcp__plugin_foo__bar` → `_bar`）、叫 `claude_ai` 的變成 `_ping`。已以 13 個樣本（7 真實 ＋ 6 對抗：`plugin_foo`／`claude_ai`／`plugin_x_y`／`claude_airtable`／`claude_aide`／`claude_ai_internal`）實跑驗證全部正確
- 名稱上限取 34 而非 agents/skills 用的 20，且省略號放在**名字中間**：實測縮短後仍有 19～42 字元，用 20 會把每個名字的 tool 半段整個吃掉——而 tool 半段正是要觀察的東西；中間省略讓 server 與 tool 兩端都留得住
- 失敗呼叫另計並標紅 `✘`（如 `Gmail__trash_message ✘ 2m ago`）。**失敗判定是 best-effort**：已驗證的是 transcript 的 `tool_result` 帶 `is_error`，但 hook 端 PostToolUse 對「失敗的 MCP 呼叫」的實際 payload 形狀**未經實測驗證**，故程式探測數種已知形狀（`is_error`／`isError`／`status`）後預設當成功。漏判只會少算紅字，不會讓該列壞掉

### Fixed
- **middle 欄溢位標記 `…+N` 改為計算真正被隱藏的「項目數」**。原式是「`totalAgentGroups` 減一個 header 列」，隱含假設該欄只有一個 header ＋ 一份清單；加入 mcp 區塊後該欄有兩個 header ＋ 兩份清單，算式低報——實測在 5 筆 MCP、只顯示得下 3 筆時顯示 `…+0`（明明少了 2 筆）。改版過程中一度改成「數被截掉的列數」，但那會**混用單位**：被截的列可能是區塊標題（`agents`／`mcp` 那行），標題不是項目，每有一個被截的標題就多報 1。最終作法是為 midRows 併行維護 `midIsHeader[]` 標記哪列是標題，只數被截列中的**非標題列**，再加上 agents 在 `AGENT_BUILD_CAP`(40) 前就被丟掉、根本沒進 midRows 的組數（且僅在 agents 列實際顯示時才加——關掉 agents 時那些組本來就不是這一欄的候選，加了會灌水）。與該欄有幾個區塊無關，日後再加區塊也不會再錯
- 上述修正的驗證方式：`…+N` 的真值**隨該欄可用格數變動**（格數由左欄列數決定，不由終端寬度決定），所以不綁單一數字，改以「畫面上實際看得見幾項」反推真值逐組比對——開發過程中以 50 個 agent 分組（超過 cap 40）＋ 5 筆 MCP 的情境確認過混用單位會多報 1，最終版的完整驗證見下方回歸驗證條目
- **`…+N` 不再只由「agents 溢位」決定**：改成欄底保留後，出現過「agents 全部放得下、但 mcp 有 3 筆放不下卻完全沒有標記」的靜默丟失（4 格欄顯示 2 筆、另 3 筆無聲消失）。現在只要 agents 溢位**或** mcp 有未顯示筆數就會出標記，且 N 同時涵蓋兩者
- 回歸驗證（最終版，全部在**隔離 HOME** 下執行，不碰使用者的 `~/.claude/cc-statusline-rows.json`）：
  1. **計數正確性**：720 組（agents 0～45 × MCP 0～9 × 兩列開關 × 寬度 100/115/130/150/200），每組從畫面實際可見的項目反推真值，比對 marker 數字 —— 380 組有欄渲染者 **0 問題**（無靜默丟失／無憑空多報／無數字錯誤），340 組為窄終端三欄收合（既有行為）
  2. **既有行為未破壞**：以 `git show HEAD:` 取改動前版本，8 種資料組合（含 agents 超 cap 的 45、skills 0～4、crons 0～2）× 6 種寬度 = 48 組，在 `mcps` 關閉時**逐位元組比對全等（48/48）**——這同時反證關閉時不再洩漏計數
  3. **差異歸因**：`mcps` 開啟時有 17 組與 HEAD 不同，逐組以機械判準檢查（skills 可見值、crons 可見值、左欄 quota／tokens／memory／cost 可見值是否改變、agents 消失是否有 marker 交代）—— **判定為回歸者 0**，差異全數來自 mcp 區塊本身、agents 讓位截斷與 marker
- **`…+N` 補上 `mcpItems` 顯示上限丟掉的工具數**：`mcps` 只取最近 5 個工具，但被 `slice` 丟掉的工具原本不計入標記——實測 9 個工具、可顯示 2 筆時標記寫 `…+3`（真值 7），少報 4。改為記下 slice 前的 `totalMcpTools`（對應 agents 既有的 `totalAgentGroups`）再計算，修正後同情境顯示 `…+7`；另測 9 工具 ＋ 8 agents、該欄可顯示 1 個 agent 與 2 筆 MCP 時顯示 `…+14`（7 個未顯示 agent ＋ 7 個未顯示 MCP），皆與真值相符
- 標記的標題判定由 `!midIsHeader[k]` 改為 `midIsHeader[k] === false`：越界索引取值為 `undefined`，用 `!` 會把它當成項目多算 1。改後不必再依賴「draw 迴圈不會給出越界索引」這個未驗證前提
- **關掉 `mcps` 列時 `…+N` 不再憑空多報**：`totalMcpTools` 與 `totalAgentGroups` 一樣是無條件從狀態檔算出（不受 `showRow` 保護），而 `hiddenMcp` 原本無條件使用它，於是使用者把該列關掉後、marker 仍把狀態檔裡每個工具算成隱藏。實測 `{"mcps": false}` ＋ 9 個工具 ＋ 2 個 agent：兩個 agent 全部顯示完、畫面還有空格，marker 卻印 `…+9`（真值 0）。改為以 `hasMcpContent` 閘住。此為修 slice 缺口時引入的新缺陷，且與稍早 `preCapHidden` 未閘 agents 開關是**同型錯**——已按同一判準掃過全檔，確認只有這兩個變數符合「從狀態檔算出、無 showRow 保護、被 marker 使用」，兩者現均已閘住
- **`…+N` 改為緊貼 agents 區塊下方**，不再浮在空白之後：agents 為空時該欄仍會顯示 `agents` 標題（既有設計），標記若落在流動區最後一格就會隔著一片空白出現，看起來像在交代 agents 的溢位，實際數的是 MCP 呼叫。改為取 `min(flowCells - 1, rightMsgs.length)`，貼在最後一列 agents（或其標題）正下方

### Changed
- `/cc-statusline-rows` skill 補上 `mcps` 的說明，並**把 `mcps` 與 `memory_mcp` 的語意分清楚**：前者是「呼叫了什麼」（本次新增），後者是「伺服器接不接得上」（既有）。該 skill 原本把 `memory_mcp` 描述成「MCP」，使用者說「MCP」時會對到錯的 key，現已在意圖對照表分列兩條

## [1.5.0] - 2026-09-10
### Added
- **面板寬度邊距改為可設定的個別設定，不再是寫死常數**：正確的邊距值取決於終端程式、字型與 TUI 自身的渲染邊距，**因機器而異**，腳本量不出來（1.4.0 的預設 4 只在單一台 Windows Terminal 上測得）。新增 `~/.claude/cc-statusline-rows.json` 的 `widthMargin` 鍵（與既有列開關同檔），值須為有限的非負數，小數無條件捨去；負數、字串（含 `"6"` 這類數字字串）、布林、`null`、物件陣列、`NaN` 與 `Infinity` 一律忽略並回到預設（判準是 `Number.isFinite`，故不轉型字串、也排除無限大）。無上界檢查：值過大時面板收斂到最小版面而非報錯
- 解析優先序：環境變數 `CC_STATUSLINE_MARGIN`（一次性試值）> 設定檔 `widthMargin`（該機器的固定值）> 預設 `4`
- `/cc-statusline-rows` skill 與 README 同步補上 widthMargin 的設定方式與**目視判準**（框線右端的 `┐` 是否出現、每列右端有無 TUI 折行記號 `…`、session 名字是否完整），並明訂此值只能由使用者目視回報、不得自行宣稱已對齊

## [1.4.0] - 2026-09-10
### Fixed
- **面板寬度預留安全邊距，修正右端被 TUI 截斷**：原本按 `COLUMNS` 全寬繪製（舊註解明寫「Don't subtract padding」），實測會超出視窗可用寬度，導致每一列被 TUI 折行，被切掉的正是最右端——也就是 session 名字所在處。實測證據：探針測得 `COLUMNS=179`（來源確為 Claude Code 匯出的環境變數，非 PowerShell 的假值 120），而視窗實際僅容得下約 175 格，`fulin-claude-plugins-89` 被截成 `fulin-claude-plugins…`、右框線消失、十列全部折行。改為排版寬度扣 4 格，可用環境變數 `CC_STATUSLINE_MARGIN` 覆寫（預設 4，設 0 即恢復舊行為）
- 那 4 格差距的確切成因**未經證實**：`settings.json` 的 `statusLine.padding` 已是 0，腳本輸出本身也不含前導空白（實測每列開頭即為框線字元），故非本腳本或該設定所致；推測與 TUI 自身的渲染邊距有關，但無法從腳本端驗證。邊距值因此設為可覆寫而非寫死
- 此為既有缺陷，非 1.3.0 引入——改動前尾端顯示的 session id 同樣會被截，只是截 UUID 不易察覺

## [1.3.0] - 2026-09-09
### Changed
- session summary 列右端由 session id 改顯示 **session 定址名**（`fulin-claude-plugins-13` 這類），即 ListAgents 列出、`SendMessage({to: ...})` 收的名字，看到就能直接貼去發訊息給該 session
- 名稱來源為 `~/.claude/sessions/<pid>.json` 的 `name` 欄位（以 payload 未清洗的 `session_id` 比對其 `sessionId`）——statusline payload 本身的 `session_name` 是對話標題不是定址名，不可用
- 顯示上限 24 格寬，超出截斷加 `…`（衍生短名普遍 ≤23 格不受影響；被使用者／Remote Control 命名成整句標題的 session 會截斷，該類名稱本就非短 handle）
- registry 查不到對應 entry 時退回原本的 session id 行為；一旦取到名字，各寬度下都顯示名字（窄終端縮短名字而非退回 id——截短的名字仍認得出視窗，UUID 認不出）
- 截斷寬度計算須扣掉 `…` 自身佔的一格（開發中實測抓到 off-by-one：`out` 累積滿 cap 後再附 `…` 會使實際寬度為 cap+1，撐破東亞寬字框線對齊）。已以 11 組邊界輸入（全形／中英混排／恰好等於上限／空字串／cap=12）實跑驗證輸出寬度全部 ≤ cap

## [1.2.0] - 2026-08-23
### Changed
- cost 改由 transcript 實算，不再取用 payload 的 total_cost_usd：新增官方 API 定價表（platform.claude.com，2026-08-23 查證；含 fable-5/mythos-5 $10/$50、opus-5/4.8 $5/$25、sonnet-5 $2/$10 與各自 cache write/read 費率），依 message.usage 四欄逐筆計價
- transcript 讀取器同時掃 subagent（<session-id>/subagents/*.jsonl），每檔各自 offset 增量續讀、message.id 跨檔去重 keep-first。實測單一 session 40 檔 1846.3M tokens，subagent 佔本機總花費 23.9%
- (all) 改為快取式全掃 ~/.claude/projects（新增 scripts/all-usage-refresh.js，單執行鎖＋6h 新鮮度，背景 detached 執行約 29s），取代原本只加總 cumulative store 的做法——舊法僅涵蓋 68/591 個主 session（11.5%）且不含 subagent，實測低估 3.2 倍（$26,085 vs 實際 $38,380）
- 無定價的模型不猜費率：其 token 記入 unpricedTok，(all) 顯示前綴 ~ 表示數字不完整；快取缺失時顯示 --

### Removed
- cum store 不再保存 cost 欄位，連同其 epoch/峰值/時戳防抖等專為 payload reset 而設的機制一併退出 cost 路徑（dur/add/rm/tok 仍沿用）；移除已無呼叫者的 cumTotal

### Fixed
- casMerge verify 原本斷言 mine.cost.peak，cost 退出 store 後會每次失敗並燒完 10 次重試，改為斷言 mine.tok.peak
- token state 檔更名 claude-toksum2-*（結構改為 per-file offset），舊 v1 檔自然失效重掃，不會被誤讀為「已掃完且零成本」

## [1.1.0] - 2026-08-07
### Changed
- 紅藍對抗（token 段）產出：tokens 列改真 session 用量——transcript usage 四欄增量累加（StringDecoder 串流、offset 快取、message.id 去重 keep-first、truncate 重掃、0-byte/目錄 fallback）、tok 退出 epoch 累計器改單調 max、payload 數值入口統一夾取、fmtTok 補 T 檔與進位；ctx% 不動（官方語意本就正確）。(all) 過渡期新舊混合、隨 session 讀取跳升至真值

## [1.0.2] - 2026-08-07
### Fixed
- 修 cost 累計天文數字（單 session 顯示一百萬美元）：併發 render 乒乓累加根治——累計帳改 epoch 峰值制（settled+peak，與 render 順序無關）＋深跌需持續 45s 的時戳防抖；累計檔 key 改完整 session id 並修新舊 key 雙算；新增 scripts/repair-cumulative.js（idempotent，修復被灌爆的歷史資料，含 --list-fixtures）；已知自癒取捨 B1/B2 註解在案

## [1.0.1] - 2026-08-01
### Fixed
- 修 agents/skills 欄同 session 莫名刷新：tracker prune 改名稱保底（done 每名稱至少留最新 1 筆、額度 20→40）不再擠掉整個 agent 名稱；tracker 寫入抽共用 lib-state.js 加跨程序檔案鎖，並發啟停掉資料歸零；running 超 4h 未收到 Stop 事件降級為 done 保留名稱

## [1.0.0] - 2026-07-31
### Changed
- 版面大改版：中間欄由對話歷史改為 agents 清單、skills 留最右欄且兩欄等寬（右側剩餘寬度對半分，餘數歸 agents）、crons 釘欄底；session summary 列橫跨全盒寬、右端顯示 session id、最多 1 列超長截斷；任何模式盒子撐滿終端寬；agents 超量末格 …+N 折疊；欄位常駐（無 agent 時不收合）；三欄模式需終端約 115 欄以上，不足整組收合單欄；修 100–114 欄混合態與 agents>5 無聲消失

## [0.4.0] - 2026-07-16
### Changed
- agents 列名字前加模型縮寫前綴 (f)/(o)/(s)/(h)：SubagentStart/Stop payload 無 model 欄位（實證＋官方文件確認），改由 statusline.js 渲染時 lazy 讀各 subagent transcript 前 256KB 抓 model id，快取到獨立 tmp 檔（不碰 tracker 狀態檔避免 CAS 競態）；前綴與名字共用原 20 字元預算，欄寬計算不變（0.4.0）

## [0.3.1] - 2026-07-09
### Fixed
- crons 區塊改條件顯示：有排程才佔 agents/skills 欄底兩 row，無排程不顯示不佔位（原 0.3.0 固定佔位＋— 佔位符移除）；README/rows skill 措辭同步

## [0.3.0] - 2026-07-09
### Changed
- 新增 crons 排程顯示：cron-tracker hook（PostToolUse CronCreate/CronDelete/ScheduleWakeup 寫 claude-crons 狀態檔）＋ statusline 第三欄（agents/skills）改 token 兩段式渲染、欄底固定兩 row 顯示排程（下一發時刻＋標籤，無排程顯示 —，一次性逾時自動剔除、循環顯示至刪除）；rows 開關加 crons key；README 資料源表同步 7 支 hooks

## [0.2.2] - 2026-07-09
### Fixed
- README 前置依賴段補全（git/claude CLI/PowerShell 各欄位降級行為）

## [0.2.1] - 2026-07-06
### Fixed
- 修右欄訊息歷史 off-by-one：summary 直接接分割區塊的版面下，totalSlots 把兼任 section 分隔與 split-open 的同一列分隔線計了兩次，導致最新一則訊息永遠不顯示（歷史僅 1 則時整欄空白）。只在 split 分隔線不兼任 section 分隔時才計 sectionDividers。

## [0.2.0] - 2026-07-05
### Changed
- 加入 6 支 tracker hooks（message/summary/file/skill/subagent/compact）並以 hooks/hooks.json 於安裝時自動註冊，補齊 status line 資料源；README 新增資料源與重複註冊警告、setup skill 加 hook 重複偵測步驟
