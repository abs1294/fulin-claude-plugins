# Changelog

本檔記錄 goal2（原 delaylocal）的版本變更，格式依 [Keep a Changelog](https://keepachangelog.com/)。

## [0.5.2] - 2026-09-13
### Changed
- 兩件 HYPOTHESIS 實測後改寫：① `--max-budget-usd` 真觸發：result `subtype: error_max_budget_usd`、`is_error: true`、`terminal_reason: budget_exhausted`、`errors: ["Reached maximum budget ($N)"]`，引擎在回合邊界才對帳（上限 0.05 實花 0.28），goal2 記 `status: budget` 正確；② 主 Claude Code 退出：以 headless `claude -p` 當主程式背景起 runner 後結束，runner 與引擎當下一起消失、meta 停在 running——引擎不會在主程式關閉後存活，SKILL／README／references 已改成事實。

## [0.5.1] - 2026-09-12
### Changed
- **grill 不限輪數、不限題目**：0.5.0 的 `goal.grillRounds`（上限 3、只問影響完成條件的分岔）改為 `goal.grill` 布林（預設 true）：把任務當設計樹，每輪問完當下能問的全部分岔、答完重算 frontier 再問，問到沒有任何決策是默默假設的為止；使用者說「直接跑」就停、未答照建議。原因：限定輪數與題目會問不完整，跑出來的不是使用者要的更麻煩。
- 拿掉 mattpocock grilling skill 的偵測（`--show-config` 的 `grilling` 欄位、prepared 輸出的 `grilling`）：格式固定 ❓/➡️，不需要偵測。
- 事實層閘的錯誤訊息明講「這是 Claude（主 session）的工作、不要回去問使用者」。
- README 新增「執行流程」一節：主線 0–9 步（誰做什麼、你看到什麼）、可以停下來的點、delaylocal 差異、runs-guard 他律。

## [0.5.0] - 2026-09-12
### Added
- **事實層閘**：使用者的四次真實呼叫全是「請把你掌握到的未完成項目做完」「我同意按照你的建議開始執行」「把這 6 個補完」——引擎在另一個 session 看不到本對話，收到的就是那十幾個字。現在 SKILL 規定 propose 前先把項目逐條展開成任務書的 `## 項目清單`（編號、內容、驗收方式、來源）；`goal.js`／`delaylocal.js`（goal 模式）對「含對話指涉（你掌握的／你的建議／這 N 個／上述／剛才…）又沒有 `## 項目清單`」的任務直接拒絕（`任務不自足`）。anchor 多一節 `<!-- goal2:sec=items -->`，壓縮後 hook 會連清單一起注回；輸出多 `items_count`／`has_items_section`。
- **grill 決策輪**（借 mattpocock grilling 的做法：facts are your job、decisions are the user's、每題附建議答案）：新設定 `goal.grill`（預設 true，false = 跳過）：把任務當設計樹，每輪問完當下能問的全部分岔、答完重算 frontier 再問，**問到沒有任何決策是默默假設的為止、不限輪數**；每題附建議答案（❓/➡️），不答照建議；常見分岔：範圍邊界／驗收方式／例外條款／禁止動作／並行共用資源／產出落點。delaylocal fast-path／plain 與使用者說「直接跑」跳過。

## [0.4.1] - 2026-09-12
### Added
- **`hooks/runs-guard.js`（PreToolUse，matcher `Bash|PowerShell`）**：SKILL／CLAUDE.md 寫「禁止整批刪 runs/」是自律、AI 會繞，改成他律。指令提到 `goal2/runs`（任何斜線寫法）且含刪除動詞（rm／rmdir／rd／del／Remove-Item／rimraf／rmSync／fs.rm／rmtree／-delete）時，只放行「每個 runs 路徑都指到完整 run id、無萬用字元、無 for／forEach／readdir／Get-ChildItem 迴圈」；`--prune --keep-hours` 小於 2 也攔。攔下時 stderr 指引改用 `--prune --dry-run` 或指名單一 id。stdin 壞掉、非 Bash/PowerShell 一律放行。25 案實測（12 攔／13 放）。裝了 goal2 的 session 與其子 agent 都受管。

## [0.4.0] - 2026-09-12
紅藍對抗四輪（紅方 51 條＋藍方複驗新發現 14 條，全部有實跑證據）＋兩個 session 四個 run 的使用檢視，一次修完。**升級後請重裝**：`/plugin update goal2@fulin-plugins` → `/reload-plugins`；設定檔多兩個欄位（見下），舊版不認識會報錯，先升級再改設定檔。
### Fixed
- **達成判定是代理值（CRITICAL）**：舊版 `goal_achieved = goal_set && exit 0 && subtype success`，從不看檢查器。實例 55a0：130 回合、12.62 USD、報告檔根本不存在，被記成達成。真相：`claude -p` 的 stream-json 裡**沒有**檢查器判定，只有子程序自己的 transcript（`~/.claude/projects/<cwd 編碼>/<session>.jsonl`）每次 Stop 檢查寫一筆 `attachment {type:"goal_status", met, failed?, reason?}`。現在 `runEngine` 收尾時讀最後一筆 → 新欄位 `goal_verdict`（`met`／`impossible`／`unverified`／`no_transcript`）、`goal_checks`、`goal_verdict_reason`、`child_transcript`；`status` 新增 `unverified`（正常結束但沒有任何判定，**不可當達成**）、`impossible`（檢查器判不可能而放行）、`timeout`、`unknown`；`done` 只在 `met`。`--status` 的 `summary_zh` 逐狀態講清楚。實測（2.1.268）：不可能的條件被擋 2 次後引擎 `subst` 造出 Z 槽達成；條件註明不可能 → `failed:true` 放行 0 次擋停；兩個 session 的 4750 實為達成（transcript `met:true`）卻因 stream 被刪記成 failed。
- **`goal_error` 誤判**：偵測掃整條 stream，引擎讀到別的 run 的拒收紀錄再引述一次就被當成自己被拒（run 5cd6：60 回合達成，卻回 `ok:false` "got 14304"）。現只認第一則 assistant 回覆（引擎對 `/goal` 的立即回應）或 `goal_set` 為 false 時的 result。
- **stream.jsonl 被刪＝假失敗**：`summarizeStream` 讀不到檔靜默回全預設 → `goal_set:false → failed`。現在 `stream_missing:true` → `status: unknown`，錯誤訊息指向 `child_transcript`。
- **pid 重用會殺錯程序樹（HIGH）**：`--stop`／`--list`／並行提醒只看 pid。現在啟動時記 `pidStart`（程序啟動時間）＋`pidName`，`aliveState()` 回 `alive`／`dead`／`stale`（pid 在但身分對不上）／`unknown`（探測被拒）；`stale` 只收狀態不殺、`unknown` 拒絕動手；EPERM 不再當活著。所有終止分支都寫 `endedAt`。
- **無預算／時間煞車（HIGH）**：新設定 `engine.maxBudgetUsd`（預設 **300**，傳 `--max-budget-usd`；觸發時引擎回 `error_max_budget_usd` → `status: budget`，訊息含實花金額）與 `engine.maxMinutes`（預設 480、上限 10080 以免 setTimeout 溢位，runner 超時 `killTree` 標 `timeout`）；null 可關。預設 300／480 為使用者指定（實測正常任務 0.45–0.55 USD/分鐘；使用者的 4750 跑了 115 分鐘≈60 USD（紅方第二輪指出原訂 20 約 40 分鐘就會砍掉正常任務，第三輪指出 60 剛好砍在 115 分鐘那種 run 上）。實例：16 分鐘 12.62 USD 零產出、6918 秒的 run 都沒有任何東西攔。
- **安裝版≠repo 版看不出來（HIGH）**：所有 JSON 輸出（prepared／ran／status／stopped／list／prune／show-config）帶 `plugin_version`、`plugin_root`；meta 記 `pluginVersion`；SKILL 要求回報版本並在落後時提醒升級。兩個 session 實際跑的是 0.3.1、審查的是 0.3.3。
- **prune 殘骸永不可清／EBUSY 整支崩**：可清類別擴為四種（已結束且程序不在、`running` 但 pid 死或被重用、`prepared` 從未啟動、無 meta 壞目錄），年齡以 `endedAt`／`createdAt`／run id 時間戳判（刪一半的殘骸不再因 mtime 刷新而要多等 24 小時）；逐目錄 try/catch＋`rmSync maxRetries:3`，失敗記 `failed[]` 繼續、`ok:false`。實測 PowerShell 獨占鎖住檔案時其餘 4 個照刪。
- **meta.json 非原子寫入／壞 meta 直接 stack trace**：`writeMeta` 改 tmp＋rename；`readMeta` 重試兩次；`--status`／`--stop`／`--run`／`--list`／`--prune` 外層 try → JSON `ok:false`；`--run` 遇缺 meta 寫 `spawn_failed` meta 不炸。
- **`--prompt-file` 讀完即刪，失敗路徑任務書就沒了**：改為準備成功（run 目錄建好）後才刪；`--goal`／cwd／超長任何驗證失敗都保留原檔。兩個 session 都踩過 `cp: cannot stat`。
- **條件含引號／`$`／反引號被 shell 改寫**：新增 `--goal-file <path>`（goal.js 與 delaylocal.js），SKILL 改為條件一律走檔案。
- **delaylocal 未知旗標靜默吃掉**（`--cwdd` 不報錯 → cwd 退回當下目錄）：與 goal.js 同樣 `未知參數` 直接拒絕。
- **delaylocal `--stop`／`--status`／`--run` 不需 session id**：使用者在自己的終端、或 Claude Code 已關掉後也能查／停。
- **compact hook 重複注入＋任務書外置壓縮後只剩指針**：hook 不再重送整份 anchor（它本來就在系統提示裡），只注回「完成條件」那一節＋帳本＋錨定區「任務全文」提到的外置檔案路徑（要求重讀）；`source !== "compact"` 一律不注（缺欄位也不注，不再只靠 engine.js 的 matcher）。
- **同一 run 目錄 `--run` 可重入（紅方第二輪 HIGH）**：第二次 `--run` 會覆寫 pid、重開 stream.jsonl，第一個引擎變成找不到的孤兒。現在 `runEngine` 只接受 `status: prepared`，其餘回 `reentry_refused` 並說明（不覆寫既有 result.json）（running 且活著 → 用 --status/--stop；running 但程序不在 → 先 --stop 收狀態再重新準備）。
- **`alive_state: unknown` 沒有出口**：pid 落在受保護程序（EPERM）或身分抓不到時，`--stop` 拒絕、prune 不碰，狀態永遠收不掉。新增 `--stop <run_dir> --force`：使用者確認引擎已不在後只把狀態收成 stopped、不殺任何程序。另外 0.4.0 的 meta 若沒記到身分（`pidStart` null），每次判活都重探：程式名像 claude/node 且啟動時間落在 run 的 startedAt 後 2 分鐘內 → alive，否則 stale；抓不到 → unknown（舊版 meta 才退回只信 pid）；啟動時身分抓不到會在 500ms 後再抓一次。`--force` 有安全閥：pid 仍是活著的 claude 就拒絕收狀態（紅方第三輪：否則活引擎會被收成 stopped、24 小時後被 prune 連目錄一起刪）。
- **等 cron 的 delaylocal prepared run 會被 `--prune --keep-hours N` 清掉**：delaylocal 準備時把預計 fire 時間寫進 meta `scheduledFor`，prune 的「never-started」以它起算（舊 meta 沒有就以 createdAt＋6h）；到點前不清。
- **compact hook 的節邊界與路徑抽取**：任務書或條件內自帶的 `## ` 子標題會截斷「完成條件」與「任務全文」（後半段的外置檔全漏）；路徑 regex 把相對路徑抽成 `/e2e/x.md`、把 URL 當檔案、`.md.bak` 截成 `.md`。現在 `buildAnchor` 在每節前放 `<!-- goal2:sec=NAME -->` 標記、hook 依標記切節（舊 anchor 退回只認固定標題首次出現）；路徑改抓「磁碟／`~`／`./`／目錄名＋分隔符」起頭的 token、邊界含中英標點與頓號、排除含 `://` 的。
- **`--stop` 與引擎收尾同時發生**：引擎已 `met` 正在收尾時被 `--stop`，原本記成 stopped；現在 verdict 為 met 且正常結束就仍算 `done`。
- **找不到 claude 可執行檔**只回通用 failed：現在引擎沒起來（無 Goal set、非零退出）且 stderr 有 `spawn … ENOENT` 就記 `spawn_failed` 並提示 PATH／`GOAL2_CLAUDE_BIN`（Windows 需 .exe）；工作目錄在準備後被移除（worktree 清掉、delaylocal 隔數小時才 fire）另外先擋、訊息講明是 cwd 不在（紅方第三輪：Node 對 cwd 不存在也報 spawn ENOENT，原本會誤導去修 PATH）。
- **stream.jsonl 被刪就找不到 transcript**：runner 起跑後每 2 秒讀 stream 第一筆 init，抓到 `childSessionId` 立刻寫進 meta，收尾時 stream 不在也能靠它找 transcript 判定。
- **`timeout`／`stopped` 但引擎其實還活著**：`--list`／`--status`／prune 對這兩種狀態也探活，活著就不當 finished、不 prune、`--stop` 可再殺一次（只對 0.4.0 記了身分的 meta；舊版 meta 的 stopped run 不探活，免得 pid 被重用時殺到無關程序）；`--force` 對程式名像 claude／node 或拿不到身分的活 pid 一律拒絕。
- hook 防呆：只掃任務全文前 30KB 抽路徑、單一 token ≤400 字（base64 任務書曾讓 regex 跑 29 秒撞 15 秒 timeout）、帳本超過 20KB 只注回尾段。
- **timeout／stopped 落在引擎已達成之後**仍算 `done`；prune 只碰名稱符合 `<14位時間戳>-<skill>-<4位>` 的目錄，runs/ 底下其他東西列為 `foreign` 不動；`--stop` 後面沒接路徑直接報錯。
- **失敗路徑保留的中繼檔會累積**：`delaylocal.js` 的暫存清掃納入 `goal-input-*`／`goal-cond-*`／`delaylocal-input-*`／`delaylocal-cond-*`（>7 天），`goal.js` 清掃自己的 `goal-input-*`／`goal-cond-*`。
- **delaylocal cron 到點的 final_prompt 仍教讀 `goal_achieved`**（與 SKILL 矛盾）：改為讀 `status`／`goal_verdict`，逐狀態說法同 goal skill。
- 文件：SKILL「TaskStop 會讓子程序變孤兒繼續跑」與實測相反（殺 runner 引擎跟著死，但 meta 停在 running）；「主 Claude Code 關掉引擎照跑」未實測，改標 HYPOTHESIS。
- **`--stop` busy-wait 100% 單核 5 秒**：改 `Atomics.wait`。`kill_detail` 不再塞 taskkill 的 cp950 文字（一律亂碼），只回 exit code。
- **`--status` 中文在 cp950 終端糊掉**：每次 `--status` 順手寫 `status.json` 到 run 目錄（`status_path`），可改用 Read。
- 文件：references「禁止未經 propose 就啟動」殘句改成與 0.3.0 一致（印出條件即可啟動）；`goal.confirmTimeoutMinutes` 預設 1 → 0 的殘句；delaylocal SKILL 的 LINE 憑證建議改與 README 一致（環境變數優先）。
### Added
- SKILL：多個活著的 run 時說「停」先問停哪一個（消歧問不算禁止的 offer）；並行時路徑不重疊仍會共用 DB／port／測試結果，任務書要寫範圍切分；`--stop` 殺不到 `&`／nohup 起的背景服務，停完提醒查 port；wtf 只管版面、事實與證據完整性依本 skill，且不再要求每次讀整份 wtf SKILL；背景啟動後先 `--status` 看到 `goal_set:true` 再說「已啟動」；能停引擎的只有 `--stop`／煞車（殺 runner 引擎會跟著死；關掉主 Claude Code 後是否存活未實測）；`--stop --force` 收掉狀態不明的 run；同一 run 目錄不可重複 `--run`。
- 完成條件寫法規定**極端**（references 第 2 節新表、兩份 SKILL propose 步驟、anchor 條件節提醒）：等式與全稱（`= 0`、每一項），不准 `<`／`≤`／「大部分」；例外條款允許但要明確：條件寫「= 0；例外清單內的項目不計」，例外限真 blocker＋證據＋原因，寫進帳本並在回報以「例外清單」逐項列出。實例：使用者要「A 類完成」被 propose 成「未完成數 < 0」。
- `GOAL2_CLAUDE_BIN` 環境變數：`claude` 不在 PATH 或要用包裝器時指定；指到 `.js` 以 node 執行（測試用）。Windows 不再嘗試 `.cmd`（Node 22 spawn `.cmd` 會 EINVAL）。
- `--list` 每筆多 `alive_state`、`condition` 摘要、`pluginVersion`。
- 隔離環境測試 e12（61 案＋）：goal_error 誤判、transcript 判定四種結局、預算旗標、pid 身分四態、stale 不殺／真殺、prune 四類＋EBUSY、原子 meta、goal-file、未知旗標、hook 三態、假引擎端到端 done／unverified／impossible／timeout。

## [0.3.3] - 2026-09-11
### Fixed
- **兩個 goal2 同時跑會互相干擾（使用者回報）**。真因有兩層：① `~/.claude/goal2/runs/` 全機共用、跨 session，沒有任何保護——本次實際發生「一個 session 清測試 run 時把另一個 session 正在跑的 run 目錄整個刪掉」（引擎本身照跑，但帳本／stream／summary 全失）；② 兩個引擎可以在同一棵工作樹（一個在專案根、一個在它的子目錄）同時開工，互相改檔、搶測試。修法：
  - `prepareRun` **並行提醒（不阻擋）**：同一棵工作樹（相同、祖先或子孫目錄）已有活著的 run（meta.pid 探活）→ 準備輸出多 `active_runs_in_tree`（run id、pid、cwd），skill 回報時提醒使用者。原本做成拒絕，使用者明確表示會在同一專案並行多個調整，故改為只提醒。實測：對正在跑的 Supplier_Code 樹準備新 run 放行並列出 2 個活著的 run。
  - **`--cwd <專案根>` 必帶**（goal.js／delaylocal.js）：子程序工作目錄不再默默用 Bash 工具當下的 cwd（會漂移）；輸出 `cwd`／`cwd_source`（cli／env:CLAUDE_PROJECT_DIR／process.cwd），anchor.md 多「工作目錄」一節。
  - **`--list`／`--prune [--dry-run] [--keep-hours N]`**：唯一允許的清理方式，只刪已結束（done/failed/stopped/spawn_failed）、程序不在、結束超過 N 小時（預設 24）的 run；running／prepared 一律不碰。文件明寫禁止整批 rm runs 目錄。
  - run 目錄建立改用非 recursive mkdir，撞名（同秒同隨機）改隨機重試，不再靜默共用同一目錄；`prepareRun` 先驗 cwd 存在。

## [0.3.2] - 2026-09-11
### Fixed
- **/goal 4000 字元上限判準錯誤（真 bug，使用者實際踩到 got 12511）**：`goal-head.js` 只量第一行，但 Claude Code 在 `claude -p` 路徑把 `/goal` 後的**整段 prompt**（工作清單、任務、帳本規則）都算進完成條件，超過就 0 回合退場。實測：第一行 156 字、整段 6368 字 → `Goal condition is limited to 4000 characters (got 6361)`；同 prompt 砍到 2958 字 → Goal set。（2.1.195 互動模式只算第一行，0.1.3 的「下放步驟 0」因此曾有效；-p 不行。）修法：`/goal` prompt 只放「條件（含 tail）＋一句指向錨定區」，任務全文、工作清單、報告格式、帳本規則全移到 `anchor.md`（`--append-system-prompt-file`，不受限）；`goal-head.js`／`engine.prepareRun`／`runEngine` 對整段 prompt 做 ≤3900 硬檢查，超過直接報錯不起子程序。條件本身超長 → 第一行換指針句「已逐項達成本 run 錨定區「完成條件全文」…」、全文放 anchor 並要求引擎第一則回覆先貼進對話（檢查器看得到）。實測 11.5KB 任務：prompt 243 字、Goal set、達成。
- **引擎拒收可見**：summary 新增 `goal_error`（例：`Goal condition is limited to 4000 characters (got N)`），此時 `ok:false`、`goal_set:false`、`error` 帶說明，不再只看到 num_turns 0。
- 準備輸出 JSON 新增 `goal_prompt_length`。

## [0.3.1] - 2026-09-11
### Changed
- **`--status` 看得懂了**：新增 `last_text`（引擎最後一句）、`last_tool`（最後一個工具動作，單行）、`last_event_at`、`assistant_messages`，以及一行白話 `summary_zh`（例：「進行中；目前 8 則回覆；被檢查器擋停要求繼續 1 次；上下文壓縮 2 次、錨定注回 2 次；最後一個動作：Bash：…；最後一句：「…」」）。兩份 SKILL.md 規定回報進度時第一句直接用 summary_zh、再貼帳本，**不准把 JSON 欄位丟給使用者**，並附欄位白話對照表（status 五種值、alive、num_turns、continuations、compactions／anchor_injections、last_*）。

## [0.3.0] - 2026-09-11
### Added
- **長任務壓縮防漂移（三層錨定）**：子程序上下文滿了自動壓縮後常忘記目標或做到哪。現在 ① `anchor.md`（完成條件＋任務全文＋帳本規則）以 `--append-system-prompt-file` 放進子程序**系統提示**，每回合重送、壓縮碰不到；② `progress.md` 進度帳本：引擎 prompt 規定開工先拆里程碑、每完成一項搬到「已完成」附證據、壓縮後先讀再動手；③ `hooks/compact-anchor.js`：engine.js 用 `--settings` 只對該子程序掛 SessionStart（matcher `compact`）hook，壓縮一結束把 ①＋② 以 additionalContext 注回，並記 `compact-log.txt`；非 compact／無 `GOAL2_RUN_DIR`／任何錯誤一律靜默放行。**實測**（2.1.268，24 段 × 8KB、autocompact=100000）：6 次壓縮、6 次注回、24 段依序零重印、24 個 secret 全對、引擎正常達成。summary 新增 `compactions`、`anchor_injections`、`progress_path`。
- **`--stop <run_dir>`／`--status <run_dir>`**（goal.js 與 delaylocal.js 皆有）：engine.js 把子程序 PID 記進 meta.json；`--stop` 殺整棵程序樹（Windows `taskkill /T /F`、其他平台 kill 群組）、meta 標 `stopped`，runner 收尾時 summary 帶 `stopped: true`，帳本與 stream.jsonl 保留；`--status` 不阻塞地回 status／alive／壓縮次數／帳本原文。實測：90 秒任務起跑後 --stop，11 個子孫程序全部終止、目標檔未被寫。準備輸出 JSON 新增 `stop_command`、`status_command`。
- **`engine.autocompact`** 設定：`auto` 或 100000–1000000 tokens。⚠️ 設太小加上大塊工具輸出會觸發 Claude Code 的壓縮空轉熔斷（`terminal_reason: rapid_refill_breaker`，實測 autocompact=100000＋每回合 25KB 時第 3 次壓縮後終止）；summary 的 `terminal_reason` 會回報。
### Changed
- **goal skill 預設直接啟動、不等確認**：`goal.confirmTimeoutMinutes` 預設由 1 改為 **0**＝propose 印給使用者後立刻背景起引擎（隨時 `--stop`）；設 ≥1 才走確認 timer。準備輸出多 `start_mode`（`direct`／`confirm-timer`），direct 時 `confirm_timer_*` 為 null。delaylocal 流程不變（仍走 10 分鐘 timer）。
- 引擎 prompt 工作清單改為 ①開工拆里程碑進帳本 ②執行任務 ③收尾（goal：補帳本＋簡短回報；delaylocal：補帳本＋寫報告＋LINE）。
- ⚠️ **升級順序**：設定檔驗證是嚴格的，舊版 0.2.x 不認識 `engine.autocompact`、也不接受 `goal.confirmTimeoutMinutes: 0`，會直接報錯罷工。請**先升級到 0.3.0 再改設定檔**。

## [0.2.1] - 2026-09-11
### Fixed
- goal skill 回報：未裝 wtf plugin 時結尾提示可安裝 wtf 以取得精簡表格式回報

## [0.2.0] - 2026-09-11
### Changed
- **plugin 由 `delaylocal` 更名為 `goal2`**（取 goal2 以避開 Claude Code 內建 `/goal` 指令），原 skill 整目錄搬到 `skills/delaylocal/`，觸發名改為 `/goal2:delaylocal`。plain 模式、fast-path、quota 計算、LINE 通知的 CLI 與輸出**逐字不變**（以 HEAD 舊版對新版 diff 驗證）；goal 模式改走子程序引擎（見下）。舊 plugin 使用者請 `/plugin uninstall delaylocal@fulin-plugins` 後 `/plugin install goal2@fulin-plugins`；plugin 安裝模式下 LINE 憑證建議改用環境變數 `LINE_TOKEN`／`LINE_USER_ID`（cache 目錄的 config 檔重裝會被清掉）。
- **goal 模式改走子程序引擎（重大）**：Claude Code **2.1.196 起**，CronCreate 排程 fire 的 prompt 被標 `skipSlashCommands`，開頭 `/goal` 只是純文字、引擎不會啟動（GitHub #75837；官方 scheduled-tasks 文件明寫 built-in commands「reach Claude as plain text」）。0.1.x 的 goal 模式自 2.1.196 起其實一直沒在跑引擎，只是任務照做而已。現在 `delaylocal.js` 排程時就把引擎 prompt（`/goal <條件>；已發 LINE` + 任務 + 報告 + notify）落到 `~/.claude/goal2/runs/<id>/prompt.txt`，cron 的 final_prompt 改為「session 守衛 → 叫 Claude 背景執行 `delaylocal.js --run <run_dir>`」，`--run` 用 `claude -p "/goal …"`（官方 goal 文件記載的非互動入口）另起 headless session 跑到達成。2.1.268 實測 Goal set → 續行 → 達成，報告與 LINE 收尾照舊。
- **CronCreate `durable` 誠實化**：工具 schema 明寫 `durable` 「Has no effect — all jobs are session-only」（由遠端旗標控制，六月與現在皆關閉）；文件與 CronCreate 呼叫改為 `durable:false`，不再宣稱跨 session。
- **抽 plugin 根層 `lib/`**：`engine.js`（子程序引擎：`spawn` 傳 argv 避開 git-bash 把 `/goal` 轉成路徑、清 `CLAUDECODE`、依設定設 `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`、收 stream.jsonl、產 result.json；含 wtf plugin 偵測）、`goal-head.js`（/goal 第一行 3900 字元門檻／指針句／步驟 0 下放，0.1.3 修法的單一來源）、`cron-time.js`（Date→5 欄 cron、整分向上取整、跨月警告）、`config.js`。兩支 skill 以 `path.join(__dirname,"..","..","lib")` 載入，symlink／junction 情境已實測 Node 以真身路徑解析；只複製 skill 資料夾會得到明確錯誤訊息。
- `skills/delaylocal/SKILL.md` 的 goal 通論（為何 propose、條件寫法、引擎契約、兩層時間）移到共用 `references/goal-propose-flow.md`，SKILL.md 只留 delaylocal 專屬差異。
### Added
- **新 skill `goal`（`/goal2:goal`）**：不排程到 quota 之後，現在就做——推導可測量完成條件 → 確認或逾時自動採納（預設 1 分鐘）→ `goal.js` 準備 run 目錄（`/goal` prompt、`run_command`、確認 timer cron）→ 同意後 Bash 背景執行 `goal.js --run <run_dir>` 起子程序引擎跑到達成 → 主對話讀 summary（`goal_achieved`、`continuations`、`num_turns`、`result_text` 原文、`run_dir`）回報。確認 timer 的 prompt 是文字指令「去執行 run_command」。不發 LINE；**本機裝了 wtf plugin 時，最終回報套 wtf 的重講紀律**（使用者授權的例外，不呼叫 wtf skill 本身，寬度用 wtf 記的 `terminalWidth`）。不接受裸數字參數。
- `references/goal-propose-flow.md`：兩 skill 共用的 propose 流程、可測量條件正反例、/goal 引擎契約（第一行、4000 上限、達成後自動清除）、兩層時間對照表、回報紀律。
- **設定檔 `~/.claude/goal2/config.json`**（`lib/config.js` 讀取與驗證、範本 `config.example.json`）：`engine.permissionMode`（子程序權限，預設 bypassPermissions）、`engine.stopHookBlockCap`（引擎連續擋停上限，預設 0＝不設上限；Claude Code 自己預設 8）、`engine.model`、`goal.confirmTimeoutMinutes`（預設 1）、`delaylocal.confirmTimeoutMinutes`（預設 10）、`delaylocal.bufferSeconds`（預設 900，CLI 裸數字仍可覆蓋）。放家目錄是因為 plugin 重裝會清 cache 目錄。檔案壞掉／型別錯／未知欄位一律報錯不靜默退回。`goal.js`／`delaylocal.js` 皆有 `--show-config` 與 `--run <run_dir>`；`delaylocal.js` 輸出 JSON 多了 `run_dir`、`run_command`、`engine_prompt`、`confirm_timer_cron`（讓 skill 不再心算「現在＋N 分」）、`buffer_source`、`config_path`、`config_loaded`。

## [0.1.5] - 2026-07-04
### Fixed
- **跨月/跨年 cron 排錯防呆**：CronCreate 只吃 5 欄週期式 cron（無年份、無絕對時間）；當目標時間與現在不在同月/年時，`31 7 * *` 這類一次性 cron 可能被引擎解讀成「明年的 7/31」而排到非預期年份。現偵測 target 與 now 跨月/跨年時，於輸出 JSON 附 `cron_warning`，並要求 SKILL 步驟 5 把它轉達使用者核對觸發日期（5 欄限制下能做的最強防呆，不改 cron 值以保短任務向後相容）。
- **暫存檔零清理**：報告檔（`delaylocal-report-*`）與 LINE 超長截斷備份（`delaylocal-line-*`）原本留在 `os.tmpdir()` 永不刪、長期累積且含任務報告內容。現 `delaylocal.js`／`notify-line.js` 各於執行時清掃自己前綴、mtime 逾 7 天的舊檔（嚴格前綴比對、只掃 tmpdir、best-effort 失敗即忽略，不刪到等待中排程的目標檔）。

## [0.1.4] - 2026-07-04
### Fixed
- **收尾通知失敗不再害 goal 模式空轉重試**：`notify-line.js` 原本 LINE API 回非 200（token 過期 / rate limit / userId 失效）或網路錯誤時 `exit 1`，而 goal 完成條件（GOAL_TAIL）寫「發出總結並回應 200」，導致「有設憑證但發送失敗」時 goal 引擎誤判任務未完成、持續重試燒 quota（任務其實早已做完）。現改為：notify 是「盡力通知」而非「必須成功」，任何發送結果（含非 200、網路錯）都 `exit 0` 並印出失敗原因；GOAL_TAIL 措辭放寬為「已嘗試發送即視為此步完成，絕不因非 200 重試」。「未設憑證→exit 0」的既有行為不變。

## [0.1.3] - 2026-06-30
### Fixed
- delaylocal.js goal 模式 final_prompt 第一行 /goal 條件超過 Claude Code 的 4000 字元上限會卡死（回 "Goal condition is limited to 4000 characters"）。現自動偵測：第一行（含收尾通知尾巴）≤ 3900 字照舊整段放第一行（短任務向後相容）；超過則第一行換固定指針句（指向工作清單步驟 0），完整 goalCondition 原封下放步驟 0，避免機械截斷破壞語意。收尾通知尾巴兩種情況都保留在第一行（確保 goal 引擎仍強制發 LINE）。
