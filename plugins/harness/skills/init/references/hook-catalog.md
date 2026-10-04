# hook 形狀目錄（init 可執行層的正本）

> init 的可執行層**不是從固定菜單挑**，而是對本目錄逐列判「觸發條件成不成立」：成立就裝，並把該列的
> 專案參數填進範本的「init 填空區」。來源＝來源專案實際在跑的 24 支 hook＋3 個 plugin 自帶的閘，
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
| 2 | check-review-discipline | 派工 prompt 必含該 agent 的紀律標記（三件套、回報鏈鐵則、QA 的範圍展開與測資來源…）與【開工前必讀】，而且必讀清單要寫到該角色的必讀檔（全部角色：CLAUDE.md、CONTEXT.md；架構／實作／審查：FLOWS.md；QA：PROJECT.md）才准派。另驗兩格**有沒有作答**（只比對標題時，寫了標題、照貼範本就過——來源專案實測那些派工單多半「有寫這格」，測試卻照樣寫死資料）：【驗收條件】剝掉佔位 `<…>`、標題後的括號說明、條列符號後不能是空的；【測試資料來源】第一行要寫「選 a／選 b／選 c」，選 b 要附產品端證據「檔名:行號」，選 c 要附理由 | PreToolUse `Agent\|Task` | A | 有建專案 agent | 每個 agent 必含的標記表（對齊 04 模板欄位）；要驗【驗收條件】內容的 agent（預設全部）；要驗【測試資料來源】作答的 agent（預設 QA agent，Q1 裁掉 QA 時清空） | `check-review-discipline.js` |
| 3 | check-ask-discipline | 問使用者時每題必附建議選項 | PreToolUse `AskUserQuestion` | A | 無 | 無 | `check-ask-discipline.js` |
| 4 | guard-qa-before-commit | 行為類改動沒表態 QA 狀態不准 commit。分兩層：**權威檢查在 git-commit 的 flow.sh**（0.11.0 以上＋專案有 `.claude/qa-gate.conf`，init 與這支一起產生）——`flow.sh review-record` 自己看該 repo 的 staged，有行為類檔卻沒帶 `--qa "已QA：…"`／`--qa "分流例外：…"` 就拒絕記錄，ship 沒有審查紀錄一律拒絕，所以從 skill 或直接用 Bash 跑 flow.sh 都一樣被查；**這支 hook 是 Skill 入口的提早提醒**：呼叫 git-commit skill 時 staged 有行為類檔、args 沒帶 `--qa-verified`／`--no-qa` 就先擋下要求表態，放行時用 `additionalContext` 提醒 review-record 那步要帶 `--qa`。不在 Bash 層攔：hook 只看得到指令文字，flow.sh 可經函式、變數、陣列、source、Invoke-Expression、字串拼接間接呼叫，靜態分析補不完 | PreToolUse `Skill`（git-commit；範本檔頭有接線） | A | 有 git-commit、是 git 專案（單一 repo 或多 repo 工作區，SKILL Phase 0-1）；git-commit 低於 0.11.0 時照裝，但只剩提早提醒（SKILL Phase 0-5） | 行為類副檔名、排除路徑、repo 清單；`.claude/qa-gate.conf` 的 `behavior_ext`／`exclude` 與填空區同一份（SKILL Phase 4 可執行層） | `guard-qa-before-commit.js`＋`.claude/qa-gate.conf` |
| 5 | guard-sediment-sweep | 收尾前逼答知識沉澱四題（詞／鏈／QA／代號） | 有 git-commit → PreToolUse `Skill`；否則 `Stop` | A | 無（兩種形狀都在範本） | 三個容器路徑、`TRIGGER_MODE` | `guard-sediment-sweep.js` |
| 6 | health-check-reminder | 距上次制度健檢超過 N 天就提醒。只認 `.claude/harness/CHANGELOG.md` 的 `## 05-knowledge-protocol.md` 節裡帶【健檢執行】標記的行（別節寫到不算）；該檔不存在或沒有這一節時，退回讀 05 本體的舊格式 changelog（0.9.x 以前裝的實例） | SessionStart | A | 無 | 天數門檻、健檢紀錄檔與節名、舊格式位置 | `health-check-reminder.js` |
| 7 | memory-write-advisory | 寫 memory 後提醒索引大小與總則檔合併。提醒包成 `additionalContext` JSON 輸出——PostToolUse 的 exit 0 純文字 stdout 模型看不到（官方 hooks 文件只列四個事件會把純文字 stdout 加進 context；`claude -p` 實測純文字提醒模型回報「沒收到」） | PostToolUse `Write\|Edit\|MultiEdit` | A | 無 | memory 目錄、索引字元上限 | `memory-write-advisory.js` |
| 8 | guard-claude-dir-hygiene | `.claude/` 底下只准在機制目錄新建檔，過程產物不得混進制度層 | PreToolUse `Write` | A | 無 | 白名單目錄、產物應去的落點 | `guard-claude-dir-hygiene.js` |
| 9 | （inline 提醒） | 開 session 提醒制度入口 | SessionStart | A | 未啟用 harness plugin 時 inline；啟用則由 plugin 提供 | 無 | settings inline |
| 10 | guard-db-login | 連資料庫**帳號只准確認過的測試帳號、密碼一律用確認過的環境變數引用**（Bash 認 `$X`、`${X}`，PowerShell 認 `$env:X`、`${env:X}`；PowerShell 的 `$X` 是它自己的變數、送空值，`%X%` 兩邊都不展開，都擋）。來源專案的事故根因是憑印象拼帳密、連續登入失敗觸發鎖定（整台庫一段時間對所有人不可用）——不只是用了高權帳號，所以不寫成「擋高權帳號名單」。指令裡出現任何字面密碼一律擋（hook 與 cases 因此永遠不存密碼值），`-E` 整合驗證、沒帶帳密、帳號不對、帳號寫成變數也擋。DB 用戶端位於指令開頭（含 `mysqldump`、`pg_dump`、`pg_restore`、`mongodump` 這類同樣會登入的工具；只看它的帳密參數，不看 SQL 內容；`npm install mysql` 這類不算）、程式裡的連線字串（`node -e`、`python -c`、當引號參數傳給一般程式（`java -jar x.jar "Server=…"`）帶 `Server=…;User Id=…`、`{server:'…', user:'…'}`）與 DB 連線 URI（`postgresql://帳號:$變數@主機`）都算。已知取捨：DB 用戶端不在指令開頭時不觸發（`docker exec … sqlcmd`、`ssh 主機 "mysql …"`；`timeout`、`time`、`sudo`、`env`、`nice`、`nohup`、`xargs` 這類前綴程式後面、`( … )`、`{ …; }`、`then`／`do`／`!` 之後、PowerShell 的 `$r = …` 與 `if (…) { … }` 裡的照樣觸發；其他結構裡的用戶端在沒有解析器時可能看不到）；`node -e` 用字串串接組 URI、heredoc 寫 `.env` 時出現確認過的變數名賦值會被擋；轉交密碼（`export PGPASSWORD="$X"; psql …`、`$env:PGPASSWORD = $env:X; psql …`，`${env:X}` 寫法同等）**只在語法解析器可用時**依 shell 語意判（變數對錯、帶入在後、子殼、背景 `&`、在用戶端之前又 `unset`／`Remove-Item Env:X`／`= $null` 清掉都會擋；清除在用戶端之後不影響），沒有解析器時一律擋；帳密旗標依用戶端家族認、短旗標分大小寫（sqlcmd 的 `-U`／`-P`、mysql 的 `-u`／`-p`——mysql 的 `-P` 是連接埠、psql 的 `-P` 是 `--pset`），帳號比對也分大小寫；psql 的 libpq 連線字串（`"host=… user=… dbname=…"`）照樣認，值可用單引號包（`user='帳號'` 比對時剝掉單引號），外層雙引號裡的 `password='$X'` 算引用、`password=\"$X\"` 連雙引號一起送出而擋，外層單引號裡的 `password=$X`、URI 的 `:$X@` 不展開而擋；前置的密碼變數要是那個用戶端自己讀的（`MYSQL_PWD="$X" psql` 不算）；經 `sudo` 執行時轉交不算（`sudo -E` 也不算）；`for X in …`、`read … X`、`foreach ($env:X in …)` 換掉確認過的變數兩條路徑都擋；整串原始指令比對（重新賦值、單引號包住變數、`"$X"x`、連線字串／URI 裡的字面密碼——含 `export DATABASE_URL=…`、`$env:DATABASE_URL = …` 這種存進環境變數的；清除用的 `$null`、空字串不算）兩條路徑都做，commit 訊息、echo、反引號裡出現「確認過的變數=…」這類賦值字樣也會擋；整串就是一次 `git commit`（可先 `git add … &&`、訊息含括號、多行、`-m "$(cat <<'EOF' … EOF)"`）或 gh 訊息裡只是提到連線字串、URI、程式碼的不擋；只是印字或搜尋（echo、printf、grep、rg、cat… 管線每段都是）或只寫到 `*.example`／`*.sample`／`*.template` 的行，帳號規則不擋；密碼環境變數（名字等於或以 `_PASSWORD`／`_PASSWD`／`_PWD`／`_PASS` 結尾，不分大小寫：`DB_PASSWORD=…`、`DB_PASS=…`；`PASSWORD_MIN_LENGTH` 這類設定與 `docker run -e`／`--env` 不算）設成字面值也擋；整串 commit 豁免只在訊息引號內或 heredoc 主體內容許換行，引號外換行之後的指令照常判；已知取捨（不處理）：程式碼字串裡只是印出含 password= 的文字（`console.log('password=x')`）也會擋；printf 帶換行寫 .env 時第二行起的內容不認；PowerShell 的反引號跳脫不認（可能多擋）；grep 的引號參數裡有 ; 時不算「只是搜尋」（多擋）；Rename-Item 換名無關的變數也會把整串判成不確定（多擋）；自訂旗標（--db-password …）不在範圍內（放行）；名字不以 _PASSWORD／_PASSWD／_PWD／_PASS 結尾的變體（MYSQL_PWD_HINT、PASSWORD_POLICY）不算密碼變數（放行）。`node -e`、`python -c` 這類程式碼字串裡的密碼鍵（`password=`、`password:`、`'password':`）是字面值就擋，不論有沒有連線字串；關鍵字參數不論順序都觸發；連線字串／URI 的帳號一律要是確認過的那一個（分大小寫，`QA_READER` 不等於 `qa_reader`；存進環境變數時沒帶帳號或用 `Integrated Security`／`Trusted_Connection` 也擋——由 `db-conn-account` 比對整串原始指令，兩條路徑一致）；「完全沒帶密碼、帳號對就放行」**只限環境變數賦值那一行**（`export X=…`、`X=… 指令` 前置、`$env:X = …`、`${env:X} = …`、`Set-Item Env:X`），同一行任何地方出現密碼鍵（含 `connect_args` 這類旁路參數）就不算沒帶密碼；`node -e`、`python -c`、一般程式引數裡的連線字串，密碼一定要是確認過的變數引用；密碼鍵認 `password`、`passwd`、`pwd`、`pass`（鍵名可加引號、值可用 `'…'`、`"…"`、`\"…\"` 包），URI 認 `postgresql+asyncpg://` 這類方言+驅動、`mysql2://`、`oracle`／`redshift`／`cockroachdb`、`jdbc:<子協定>:`，帳密也可在查詢參數（`?user=…&password=…`）；PowerShell `try { 用戶端 } finally { Remove-Item Env:PGPASSWORD }` 照樣算轉交（其餘見 hook 檔頭）。**這三條規則不看主機**：要限制連哪台庫，用 U1 確認過的測試庫主機另寫一條「沒確認的主機就擋」的規則（寫法照遠端主機示範），或寫進文字約束 | PreToolUse `Bash\|PowerShell` | B | Phase 1 掃到 DB 用戶端指令、連線字串或 Q2 勾選「資料庫」 | 兩個填空，都在 U1 問（不收密碼值）：`__DB_TEST_USER__`＝確認過的測試帳號、`__DB_TEST_PW_ENV__`＝放密碼的環境變數名；整串取代，兩個佔位不互為前綴 | `guard-risky-command.js` 的規則（檔頭示範 `db-unconfirmed-login`＋`db-password-literal`＋`db-conn-account` 三條一起用） |
| 11 | guard-service-startup | 起服務必帶正確環境設定 | PreToolUse `Bash\|PowerShell` | B | Phase 1 掃到啟動指令依賴環境變數（`NODE_ENV`／`ASPNETCORE_ENVIRONMENT`／`--profile`…） | 啟動指令樣式、必帶的環境值 | `guard-risky-command.js` 的規則 |
| 12 | （熔斷清單的部署、推送、毀滅性 SQL） | 熔斷清單上的不可逆指令，執行前一律擋下請示 | PreToolUse `Bash\|PowerShell` | B | Q2 每一項勾選 | 每項的指令樣式與放行條件 | `guard-risky-command.js` 的規則 |
| 13 | guard-mail-recipients | 跑測試前驗證寄信已收斂（收件人／SMTP 指向本機） | PreToolUse `Bash\|PowerShell` | B | Phase 1 掃到寄信程式碼，且專案有測試指令 | 測試指令樣式、要驗的設定檔／環境變數與判準 | `guard-test-preconditions.js` 的檢查 |
| 14 | guard-e2e-env-alignment | 跑測試前驗環境對齊（變數齊全、指向同一套服務） | PreToolUse `Bash\|PowerShell` | B | 專案測試依賴環境變數（`.env.test`／測試設定讀 `process.env`／`os.environ`） | 測試指令樣式、必備變數與一致性規則 | `guard-test-preconditions.js` 的檢查 |
| 15 | guard-report-output | 交付物只能落在「主題_日期」資料夾，過程檔進 `_work/` | PreToolUse `Write\|Edit\|Bash\|PowerShell` | B | 有 QA 流程（前端類型非「無」或 Q3 有測試報告需求） | 交付根目錄、過程檔副檔名 | `guard-report-output.js` |
| 16 | backup-local-hacks | 每次 shell 指令前，把本機覆寫檔的改動逐檔備份（追蹤中的存 patch、被排除或未追蹤的存整份）；檔案被清空或刪除時不覆蓋既有備份，改提醒模型去檢查；行數大幅減少（可能是刻意縮短）照存，前一版留在歷史版本並提醒 | PreToolUse `Bash\|PowerShell` | C | `.claude/local-overrides.yml` 存在且有條目（git-commit 會自動建這個檔），或 Phase 1 看到 `*.local.*`／`appsettings.*.json` 這類本機覆寫檔 | 覆寫清單位置、備份目錄、救回指令 | `backup-local-hacks.js`（**與 `restore-local-hacks.js` 一起複製**：16–18 三支的訊息都叫使用者跑它，不帶就是指向不存在的指令） |
| 17 | guard-local-hack-destroy | 會銷毀工作區的 git 指令（`reset --hard`、`checkout -- .`、`clean -f`…）碰到本機覆寫檔時擋下。`restore`／`checkout` 依點名路徑放寬**只在語法解析器可用時**（同目錄的 `shell-model.js`；沒有解析器或語法樹有錯時與改動前相同）：每個 git 呼叫的目前目錄（照語法樹追蹤一定會執行的 cd；條件裡的 cd、cd 失敗或引數不是一個、pushd、`env -C`、PowerShell 的 `cd..`、cd 接反斜線、`C:` 這類內建函式、script block 或子運算式裡的換目錄、`iex`／`Invoke-Command` 都算判不準，判不準就照舊版擋）、環境（`GIT_*` 變數）、全域選項、子命令與旗標（只認完整清單內的）、點名參數（不含萬用字元、pathspec magic、展開語法）都確定，而且執行目錄的 repo 實體路徑與清單上的 repo 相同，沒點到覆寫檔才放行；同一串有寫檔的重導向或 cmdlet、`source`／dot-source、`eval`／`iex`、指令名稱不是字面的呼叫、PowerShell 用 .NET 換目錄（`SessionState.Path.SetLocation`、`[Environment]::CurrentDirectory`、`SetCurrentDirectory`）、git 之前先跑了看不出會不會換目錄的指令（bash 的自訂函式或認不得的名稱、PowerShell 的 `.ps1` 腳本與函式；git 本身與 `pytest`、`tsc`、`docker`、`make` 這類常見開發工具是已知外部程式，不算）也不放寬；文字判斷認出的危險 git 呼叫數必須等於語法樹確認的數目（`winpty`／`flock` 這類前綴、`node -e` 字串裡的 git 會讓兩者對不上）；放寬過程出任何錯（例：`shell-model.js` 是舊版）都照改動前擋；其餘照改動前擋 | PreToolUse `Bash\|PowerShell` | C | 同 16 | 覆寫清單位置 | `guard-local-hack-destroy.js` |
| 18 | check-local-hacks-alive | 開 session 時點名本機覆寫是否遺失（含被清空、刪除）並給救回指令；清單條目設了 `requires` 的，另點名「檔還在但缺必要字串」（帶到舊版）；設了 `needed-when-*` 而這個分支用不到的不報 | SessionStart | C | 同 16 | 覆寫清單位置、備份目錄；清單條目的選填欄位由訪談「只在某些分支才需要的覆寫」那一題決定（SKILL Q9） | `check-local-hacks-alive.js` |
| 19 | check-wt-hacks-on-start | 從別的工作樹起服務時提醒覆寫帶齊沒 | PreToolUse `Bash\|PowerShell` | C（hook 不移植，帶文件條款） | 多工作樹＋多服務拓撲 | — | 無 hook：判斷式寫死來源專案的工作樹路徑與起服務指令，實際稽核還綁埠號與服務拓撲。**但它防的場景 16–18 蓋不到**：新工作樹是乾淨的原版，沒有東西可救、patch 也套不上別的基準，16–18 只管「既有工作區的覆寫被毀」。來源專案實際因為新工作樹漏帶寄信覆寫而誤寄過信。所以裝了 16–18 且 Phase 1 看到多工作樹時，03 的 A9 要填「開新工作樹時從主要工作目錄帶齊清單上的覆寫」與檢查指令；專案長出固定的多工作樹工作法時，走 05 升格協議做成 hook |
| 20 | guard-codex-diff-embed | 派 Codex 審查時 diff 必須內嵌、不得叫它讀檔（沙箱擋外部 shell） | PreToolUse `Agent\|Task` | D | 裝了 git-commit（它的 B 軌需要） | 無 | git-commit plugin 自帶（`plugins/git-commit/hooks/`） |
| 21 | check-codex-cwd | 派 Codex 時 prompt 必須指定要 cd 進的 repo | PreToolUse `Agent\|Task` | D | 同 20 | 無（cd 目標是否存在、是否在 git repo 內由 hook 動態判斷） | git-commit plugin 自帶（`plugins/git-commit/hooks/`） |
| 22 | （git-commit）block-bare-git-commit | 裸 `git commit`／plumbing 繞過審查流程 | PreToolUse `Bash\|PowerShell` | D | 是 git 專案（單一 repo 或多 repo 工作區） | 無 | git-commit plugin 自帶 |
| 23 | （qa-webwright）landing／early-nudge／project-knowledge | 用了瀏覽器卻沒落地可重跑測試；先讀 QA 知識檔 | Stop／PostToolUse／PreToolUse | D | 前端為瀏覽器可驅動 | 無 | qa-webwright plugin 自帶 |
| 24 | （cbm-guard）guard-cbm-query | 程式碼圖譜查詢的錯誤寫法攔截 | PreToolUse cbm 工具 | D | 專案有用 codebase-memory-mcp | 無 | cbm-guard plugin 自帶 |
| 25 | guard-test-asset-hygiene | 寫測試檔後自動跑測試資產稽核（硬編資料、覆蓋登記、顯示文字定位、skip 濫用），只擋新增（擋＝exit 2＋stderr，會送給模型）；稽核工具自己故障時不擋，提醒走 `additionalContext`（理由同第 7 列） | PostToolUse `Write\|Edit\|MultiEdit` | E | 專案已有對應的稽核工具 | 測試目錄、每個稽核工具的指令 | `guard-test-asset-hygiene.js`（範本已備，init 只在有稽核工具時裝） |
| 26 | compact-snapshot／compact-reinject／compact-summary-log／resume-stale-reminder | 壓縮前存快照並由隔離的子 session 寫交接信（九節：未完成、目標版本、硬約束、關鍵值、走過的死路…），壓縮後把交接信注入回 context——摘要常漏的背景 agent、只讀過的規範、未兌現的承諾、工具回傳的測試數字與錯誤原文接得回來；隔數小時才 resume 時提醒狀態可能已過期 | PreCompact（timeout 240）／SessionStart `compact`／PostCompact／SessionStart `resume` | A | 無。交接信要能執行 claude CLI（`~/.local/bin` 或 PATH），找不到時只留快照、不擋壓縮；每次壓縮開一個子 session（effort low 實測長對話約 60～70 秒；預設 effort 時約 0.1～0.3 美元，low 的費用未重新統計），Q5 攤清單時要講出這個成本 | 規範文件樣式 `DOC_RE`、交接信模型／思考強度／語言／長度、子 session 逾時（要小於 PreCompact 的 timeout）、注入上限、resume 提醒門檻時數、顯示時區 | `compact-snapshot.js`＋`compact-handoff.js`（被 require 的模組，不接線）＋`compact-reinject.js`＋`compact-summary-log.js`＋`resume-stale-reminder.js`，五支一起裝 |
| 27 | guard-qa-before-commit 的本機覆寫夾帶檢查 | staged 裡混進本機覆寫清單上的檔（本地連線字串、mock 開關、測試憑證…）就擋。分兩層：**權威檢查在 flow.sh**——`qa-gate.conf` 的 `block_staged_overrides=1` 時 `review-record` 拒絕記錄（`--allow-overrides "<理由>"` 放行，理由寫進 review-log.tsv）；**這支 hook 在 Skill 入口提早擋**（`--allow-overrides` 可放行，而且排在 `--qa-verified` 之前檢查）。hook 不另寫清單解析：呼叫 `flow.sh analyze <repo>`，讀它本來就會印的 `<檔> [STAGED, in overrides]` 標記（flow.sh 會處理工作樹 remote 名稱等細節，另寫一份必然漂移）。找不到 flow.sh 或 Git Bash、analyze 失敗時這項放行，並用 `additionalContext` 提醒模型。來源專案實際因 `git add -A` 把本機覆寫整檔混進 staged | 同第 4 列（同一支 hook 的開關，不另接線）＋`qa-gate.conf` 的一行 | C | 同 16（跟本機覆寫保護一起裝；第 4 列沒裝就不適用） | `CHECK_OVERRIDES` 改 `true`；`FLOW_SH`（留空＝自動找：`<專案根>/.claude/skills/git-commit/flow.sh` → `~/.claude/plugins/installed_plugins.json` 裡這個專案實際裝的 git-commit（專案層優先、其次使用者層）→ `~/.claude/plugins/cache` 底下 git-commit 的 flow.sh，取最新修改的那支）；`qa-gate.conf` 寫 `block_staged_overrides=1` | `guard-qa-before-commit.js`（同一支；做成開關而不是獨立 hook：它跟 QA 表態用同一個入口判斷）＋`qa-gate.conf` 那一行。Windows 上 PATH 的 `bash` 常是 WSL（實測從 PowerShell 起的 node 叫 `bash` 會進 WSL 而失敗），範本會先找 Git Bash |
| 28 | compact-resume-judge | 事後補判壓縮流水帳（`compact-log.jsonl`）的 `resumedWithoutReexplain`：壓縮後第一個回合使用者是照常往下推進，還是在重講背景、糾正接錯的方向——字面規則分不出，由背景程序開 `claude -p`（sonnet、effort low）讀 transcript 判；SessionStart 帶 `--spawn` 轉背景執行後立即返回 | SessionStart（背景） | 不帶 | — | — | **刻意不做成範本**：①它只回填一個統計欄位，範本這邊沒有任何讀者——`/harness:review` 的收集腳本不讀這個欄位，第 26 列的 `compact-summary-log.js` 寫入時一律記 `null`；②代價不小：每次開 session 都起一個背景程序，有待判紀錄就開 `claude -p` 子 session（每次最多判 10 筆、單筆逾時 120 秒），要付費、要找得到 claude CLI；③它判的是「交接信有沒有效」，屬於改良壓縮交接機制時才需要的量測，不是開發流程本身的閘。專案要評估交接信成效時再從來源專案移植，並同時讓 review 的收集腳本讀這個欄位，否則只是花錢寫一個沒人看的數字 |

## init 的推導步驟（Phase 4 可執行層照這個做）

1. 逐列判「觸發條件」，用 Phase 1 盤點結果與 Q1–Q7 的答案——**不問使用者**，這是事實判定。
2. B 類：Phase 1「危險動作候選」與 Q2 勾選的每一項都要落成 `guard-risky-command.js` 或
   `guard-test-preconditions.js` 的一條規則。**熔斷清單上的項目只寫進文字、沒有對應規則＝推導不完整**。
   做不成規則的（例如只能靠人判斷的「對外命名」），在 Phase 5 回報裡逐項說明為什麼只能停在文字。
3. Q5 攤出推導結果：每支列「擋什麼、為什麼這個專案需要（對應哪個盤點證據或哪題答案）」，
   使用者只能**取消**，不能從空清單挑。
4. 連同 `probe-hooks.js` 與 `cases/` 一起複製；填空區改了什麼，對應的 cases 同步改。
   裝了任一個 B 類規則引擎、或第 17 列本機覆寫銷毀閘時，連同 `shell-model.js`、`package.json`、`package-lock.json` 一起複製，並在 `.claude/hooks/` 跑 `npm ci`（見下表）。
5. Phase 5 在目標專案跑 `node .claude/hooks/probe-hooks.js`，全數符合預期才算裝完；再加冷啟探針驗「Claude Code 真的會叫它」。

## 範本檔以外的配套

| 檔 | 用途 | 何時複製 |
|---|---|---|
| `probe-hooks.js`＋`cases/` | hook 行為探針與兩向案例；Phase 5 驗收與 05 健檢都跑它 | 一律（只帶已裝 hook 對應的 cases） |
| `shell-model.js`＋`package.json`＋`package-lock.json` | 兩個規則引擎共用的指令語法解析：用 tree-sitter（bash、PowerShell 各一套文法）照 shell 真實語意判「哪些指令會執行」「每個指令實際拿到的環境值」。在 `.claude/hooks/` 跑 `npm ci` 裝進 `node_modules/`（版本由 lock 檔釘住；三個套件皆 MIT、附預編譯檔，不需要編譯器）；`node_modules/` 要進 `.gitignore`。沒裝、載入失敗或解析出錯誤節點時，引擎整串退回正則判法——不會失效，但準確度較低（見兩支引擎檔頭的已知極限）。本機覆寫銷毀閘（第 17 列）的點名放寬也靠它：沒帶或載入失敗時，該閘照改動前的判法（同 repo 有改過的覆寫檔，`restore`／`checkout` 不論點名哪個檔都擋），不會變鬆 | 裝了 `guard-risky-command`、`guard-test-preconditions` 或第 17 列 `guard-local-hack-destroy` 就一起帶（只裝本機覆寫保護的 C 類也帶，否則點名一般檔的 `restore`／`checkout` 會一直被擋） |
| `compact-handoff.js` | 交接信模組（不是 hook，由 `compact-snapshot.js` require；探針也把它當模組排除） | 裝了第 26 列就一起帶 |
| `restore-local-hacks.js` | 本機覆寫救回腳本（不是 hook，但探針把它當一支來測：檢查模式有東西可救時 exit 2，cases 裡的 BLOCK 就是這個意思） | 裝了第 16–18 列任一支就一起帶 |

## 維護

- 來源專案長出新的 hook 時，照本表格式補一列，判它屬於哪一類；A、B 類要附範本與 cases。
- 範本改動一律跑 `node hooks/templates/probe-hooks.js` 全綠才算完成；新增的範本沒有 cases 時執行器會報「缺 cases」並以結束碼 1 失敗。
- 不擋、只提醒的 hook，要先確認提醒**模型看得到**：SessionStart／UserPromptSubmit 的純文字 stdout 會進 context；PreToolUse、PostToolUse 以 exit 0 結束時，純文字 stdout 模型看不到（官方 hooks 文件；PostToolUse 另經 `claude -p` 實測），要印 `{"hookSpecificOutput":{"hookEventName":"<事件>","additionalContext":"…"}}`（`claude -p` 實測兩個事件的 additionalContext 都以 system reminder 送達）。這類案例在 cases 標 `"visible": true`，探針會要求輸出是這個 JSON 形狀。
- 動到兩個規則引擎或 `shell-model.js` 時，`probe-hooks.js`（語法樹路徑）與 `probe-hooks.js --parser=off`（正則路徑）兩者都要沒有 FAIL；plugin 開發環境要先在 `hooks/templates/` 跑一次 `npm ci`，否則預設那一輪也會走正則路徑（開頭那行會標出來）。只有語法樹路徑做得到的案例標 `"parser": "only"`，正則路徑略過並計數。
