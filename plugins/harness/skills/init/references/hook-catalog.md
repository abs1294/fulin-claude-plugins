# hook 形狀目錄（init 可執行層的正本）

> init 的可執行層**不是從固定菜單挑**，而是對本目錄逐列判「觸發條件成不成立」：成立就裝，並把該列的
> 專案參數填進範本的「init 填空區」。來源＝來源專案實際在跑的 23 支 hook＋3 個 plugin 自帶的閘，
> 逐支拆成「通用形狀＋觸發條件＋專案參數」。範本檔名與來源 hook 同名的，是同一支的去專案化版本。
>
> 為什麼要這份目錄：來源專案的 hook 絕大多數綁著專案事實（某支寄信服務的檔名、某台 DB 的帳號、
> 某套環境變數），用「能不能原封複製」當判準，幾乎全數會被淘汰——但它們的**形狀**是通用的。
> 舊版 init 只帶 4 支，正是用錯了判準；而冷啟實測中，沙盒專案的寄信、TRUNCATE、部署在 Phase 1
> 全被掃到，卻只寫進文字熔斷清單，風險最高的那幾件事全靠自律。

## 分類

| 類別 | 意思 | init 怎麼處理 |
|---|---|---|
| **A 必裝** | 對應開發流程骨幹本身，任何專案都適用 | 條件成立（多半是「有建 agent」「有 git-commit」）就裝，Q5 只讓使用者**取消** |
| **B 盤點觸發** | 對應 Phase 1 掃到的風險或 Q2 勾進熔斷清單的項目 | 每個掃到的風險都要落成一條規則；使用者在 Q2 取消勾選的才不裝 |
| **C 工作法觸發** | 對應特定工作法（本機覆寫檔、多工作樹） | Phase 1 偵測到該工作法才裝 |
| **D 由 plugin 提供** | 閘本身屬於另一個 plugin 的流程 | init 不複製，改列入安裝指引；冷啟探針驗它真的在擋 |
| **E 長出來才裝** | 需要專案先有某種資產（稽核工具）才有意義 | init 不裝，寫進 05 升格協議的「可升格機械閘」清單 |

## 目錄

| # | 來源 hook | 通用形狀 | 掛載 | 類別 | 觸發條件（init 怎麼判） | 專案參數（填空區） | 範本 |
|---|---|---|---|---|---|---|---|
| 1 | check-agent-model | 派專案 agent 必帶 model；subagent 不得擅用最高階模型 | PreToolUse `Agent\|Task` | A | Q1 裁切後有建專案 agent | agent 名單 | `check-agent-model.js` |
| 2 | check-review-discipline | 派工 prompt 必含該 agent 的紀律標記（三件套、回報鏈鐵則、QA 的範圍展開與測資來源…）才准派 | PreToolUse `Agent\|Task` | A | 有建專案 agent | 每個 agent 必含的標記表（對齊 04 模板欄位） | `check-review-discipline.js` |
| 3 | check-ask-discipline | 問使用者時每題必附建議選項 | PreToolUse `AskUserQuestion` | A | 無 | 無 | `check-ask-discipline.js` |
| 4 | guard-qa-before-commit | 行為類改動沒表態 QA 狀態不准 commit | PreToolUse `Skill`（git-commit） | A | 有 git-commit、是 git repo | 行為類副檔名、排除路徑、repo 清單 | `guard-qa-before-commit.js` |
| 5 | guard-sediment-sweep | 收尾前逼答知識沉澱四題（詞／鏈／QA／代號） | 有 git-commit → PreToolUse `Skill`；否則 `Stop` | A | 無（兩種形狀都在範本） | 三個容器路徑、`TRIGGER_MODE` | `guard-sediment-sweep.js` |
| 6 | health-check-reminder | 距上次制度健檢超過 N 天就提醒 | SessionStart | A | 無 | 天數門檻、健檢紀錄所在檔 | `health-check-reminder.js` |
| 7 | memory-write-advisory | 寫 memory 後提醒索引大小與總則檔合併 | PostToolUse `Write\|Edit\|MultiEdit` | A | 無 | memory 目錄、索引字元上限 | `memory-write-advisory.js` |
| 8 | guard-claude-dir-hygiene | `.claude/` 底下只准在機制目錄新建檔，過程產物不得混進制度層 | PreToolUse `Write` | A | 無 | 白名單目錄、產物應去的落點 | `guard-claude-dir-hygiene.js` |
| 9 | （inline 提醒） | 開 session 提醒制度入口 | SessionStart | A | 未啟用 harness plugin 時 inline；啟用則由 plugin 提供 | 無 | settings inline |
| 10 | guard-db-login | 連資料庫禁用高權帳號／禁連正式庫 | PreToolUse `Bash\|PowerShell` | B | Phase 1 掃到 DB 用戶端指令、連線字串或 Q2 勾選「資料庫」 | 高權帳號名、正式庫主機樣式、允許的測試帳號 | `guard-risky-command.js` 的規則 |
| 11 | guard-service-startup | 起服務必帶正確環境設定 | PreToolUse `Bash\|PowerShell` | B | Phase 1 掃到啟動指令依賴環境變數（`NODE_ENV`／`ASPNETCORE_ENVIRONMENT`／`--profile`…） | 啟動指令樣式、必帶的環境值 | `guard-risky-command.js` 的規則 |
| 12 | （熔斷清單的部署、推送、毀滅性 SQL） | 熔斷清單上的不可逆指令，執行前一律擋下請示 | PreToolUse `Bash\|PowerShell` | B | Q2 每一項勾選 | 每項的指令樣式與放行條件 | `guard-risky-command.js` 的規則 |
| 13 | guard-mail-recipients | 跑測試前驗證寄信已收斂（收件人／SMTP 指向本機） | PreToolUse `Bash\|PowerShell` | B | Phase 1 掃到寄信程式碼，且專案有測試指令 | 測試指令樣式、要驗的設定檔／環境變數與判準 | `guard-test-preconditions.js` 的檢查 |
| 14 | guard-e2e-env-alignment | 跑測試前驗環境對齊（變數齊全、指向同一套服務） | PreToolUse `Bash\|PowerShell` | B | 專案測試依賴環境變數（`.env.test`／測試設定讀 `process.env`／`os.environ`） | 測試指令樣式、必備變數與一致性規則 | `guard-test-preconditions.js` 的檢查 |
| 15 | guard-report-output | 交付物只能落在「主題_日期」資料夾，過程檔進 `_work/` | PreToolUse `Write\|Edit\|Bash\|PowerShell` | B | 有 QA 流程（前端類型非「無」或 Q3 有測試報告需求） | 交付根目錄、過程檔副檔名 | `guard-report-output.js` |
| 16 | backup-local-hacks | 每次 shell 指令前，把本機覆寫檔的改動逐檔備份（追蹤中的存 patch、被排除或未追蹤的存整份） | PreToolUse `Bash\|PowerShell` | C | `.claude/local-overrides.yml` 存在且有條目（git-commit 會自動建這個檔），或 Phase 1 看到 `*.local.*`／`appsettings.*.json` 這類本機覆寫檔 | 覆寫清單位置、備份目錄 | `backup-local-hacks.js`（**與 `restore-local-hacks.js` 一起複製**：16–18 三支的訊息都叫使用者跑它，不帶就是指向不存在的指令） |
| 17 | guard-local-hack-destroy | 會銷毀工作區的 git 指令（`reset --hard`、`checkout -- .`、`clean -f`…）碰到本機覆寫檔時擋下 | PreToolUse `Bash\|PowerShell` | C | 同 16 | 覆寫清單位置 | `guard-local-hack-destroy.js` |
| 18 | check-local-hacks-alive | 開 session 時點名本機覆寫是否遺失並給救回指令 | SessionStart | C | 同 16 | 覆寫清單位置、備份目錄 | `check-local-hacks-alive.js` |
| 19 | check-wt-hacks-on-start | 從別的工作樹起服務時提醒覆寫帶齊沒 | PreToolUse `Bash\|PowerShell` | C（不移植） | 多工作樹＋多服務拓撲 | — | 無：形狀依賴來源專案的服務拓撲與埠號對照；16–18＋`guard-test-preconditions` 已涵蓋「環境不對」的主要形狀。專案真的長出多工作樹工作法時，走 05 升格協議 |
| 20 | guard-codex-diff-embed | 派 Codex 審查時 diff 必須內嵌、不得叫它讀檔（沙箱擋外部 shell） | PreToolUse `Agent\|Task` | D | 裝了 git-commit（它的 B 軌需要） | 無 | git-commit plugin 自帶（`plugins/git-commit/hooks/`） |
| 21 | check-codex-cwd | 派 Codex 時 prompt 必須指定要 cd 進的 repo | PreToolUse `Agent\|Task` | D | 同 20 | 無（cd 目標是否存在、是否在 git repo 內由 hook 動態判斷） | git-commit plugin 自帶（`plugins/git-commit/hooks/`） |
| 22 | （git-commit）block-bare-git-commit | 裸 `git commit`／plumbing 繞過審查流程 | PreToolUse `Bash\|PowerShell` | D | 是 git repo | 無 | git-commit plugin 自帶 |
| 23 | （qa-webwright）landing／early-nudge／project-knowledge | 用了瀏覽器卻沒落地可重跑測試；先讀 QA 知識檔 | Stop／PostToolUse／PreToolUse | D | 前端為瀏覽器可驅動 | 無 | qa-webwright plugin 自帶 |
| 24 | （cbm-guard）guard-cbm-query | 程式碼圖譜查詢的錯誤寫法攔截 | PreToolUse cbm 工具 | D | 專案有用 codebase-memory-mcp | 無 | cbm-guard plugin 自帶 |
| 25 | guard-test-asset-hygiene | 寫測試檔後自動跑測試資產稽核（硬編資料、覆蓋登記、顯示文字定位、skip 濫用），只擋新增 | PostToolUse `Write\|Edit\|MultiEdit` | E | 專案已有對應的稽核工具 | 測試目錄、每個稽核工具的指令 | `guard-test-asset-hygiene.js`（範本已備，init 只在有稽核工具時裝） |
| 26 | compact-snapshot／compact-reinject／compact-summary-log | 壓縮前存快照並由隔離的子 session 寫交接信，壓縮後把交接信注入回 context——摘要常漏的背景 agent、只讀過的規範、未兌現的承諾與待決事項接得回來 | PreCompact（timeout 240）／SessionStart `compact`／PostCompact | A | 無。交接信要能執行 claude CLI（`~/.local/bin` 或 PATH），找不到時只留快照、不擋壓縮；每次壓縮約 0.1～0.3 美元、35～140 秒，Q5 攤清單時要講出這個成本 | 規範文件樣式 `DOC_RE`、交接信模型／語言／長度、注入上限 | `compact-snapshot.js`＋`compact-handoff.js`（被 require 的模組，不接線）＋`compact-reinject.js`＋`compact-summary-log.js`，四支一起裝 |

## init 的推導步驟（Phase 4 可執行層照這個做）

1. 逐列判「觸發條件」，用 Phase 1 盤點結果與 Q1–Q7 的答案——**不問使用者**，這是事實判定。
2. B 類：Phase 1「危險動作候選」與 Q2 勾選的每一項都要落成 `guard-risky-command.js` 或
   `guard-test-preconditions.js` 的一條規則。**熔斷清單上的項目只寫進文字、沒有對應規則＝推導不完整**。
   做不成規則的（例如只能靠人判斷的「對外命名」），在 Phase 5 回報裡逐項說明為什麼只能停在文字。
3. Q5 攤出推導結果：每支列「擋什麼、為什麼這個專案需要（對應哪個盤點證據或哪題答案）」，
   使用者只能**取消**，不能從空清單挑。
4. 連同 `probe-hooks.js` 與 `cases/` 一起複製；填空區改了什麼，對應的 cases 同步改。
   裝了任一個 B 類規則引擎時，連同 `shell-model.js`、`package.json`、`package-lock.json` 一起複製，並在 `.claude/hooks/` 跑 `npm ci`（見下表）。
5. Phase 5 在目標專案跑 `node .claude/hooks/probe-hooks.js`，全數符合預期才算裝完；再加冷啟探針驗「Claude Code 真的會叫它」。

## 範本檔以外的配套

| 檔 | 用途 | 何時複製 |
|---|---|---|
| `probe-hooks.js`＋`cases/` | hook 行為探針與兩向案例；Phase 5 驗收與 05 健檢都跑它 | 一律（只帶已裝 hook 對應的 cases） |
| `shell-model.js`＋`package.json`＋`package-lock.json` | 兩個規則引擎共用的指令語法解析：用 tree-sitter（bash、PowerShell 各一套文法）照 shell 真實語意判「哪些指令會執行」「每個指令實際拿到的環境值」。在 `.claude/hooks/` 跑 `npm ci` 裝進 `node_modules/`（版本由 lock 檔釘住；三個套件皆 MIT、附預編譯檔，不需要編譯器）；`node_modules/` 要進 `.gitignore`。沒裝、載入失敗或解析出錯誤節點時，引擎整串退回正則判法——不會失效，但準確度較低（見兩支引擎檔頭的已知極限） | 裝了 `guard-risky-command` 或 `guard-test-preconditions` 就一起帶 |
| `compact-handoff.js` | 交接信模組（不是 hook，由 `compact-snapshot.js` require；探針也把它當模組排除） | 裝了第 26 列就一起帶 |
| `restore-local-hacks.js` | 本機覆寫救回腳本（不是 hook，但探針把它當一支來測：檢查模式有東西可救時 exit 2，cases 裡的 BLOCK 就是這個意思） | 裝了第 16–18 列任一支就一起帶 |

## 維護

- 來源專案長出新的 hook 時，照本表格式補一列，判它屬於哪一類；A、B 類要附範本與 cases。
- 範本改動一律跑 `node hooks/templates/probe-hooks.js` 全綠才算完成；新增的範本沒有 cases 時執行器會報「缺 cases」並以結束碼 1 失敗。
- 動到兩個規則引擎或 `shell-model.js` 時，`probe-hooks.js`（語法樹路徑）與 `probe-hooks.js --parser=off`（正則路徑）兩者都要沒有 FAIL；plugin 開發環境要先在 `hooks/templates/` 跑一次 `npm ci`，否則預設那一輪也會走正則路徑（開頭那行會標出來）。只有語法樹路徑做得到的案例標 `"parser": "only"`，正則路徑略過並計數。
