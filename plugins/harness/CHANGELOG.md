# Changelog

All notable changes to this plugin will be documented in this file.

## [0.12.0] - 2026-10-04
### Changed
- **開工前對齊回合不設後果門檻**：04 派工模板原本只在「不同 schema／API／對外行為」時才要求對齊，但真正燒時間的多是低階的理解分岔。改成每次派實作或 QA 都要先對齊，並補兩條判準：使用者說「這題你決定」算明確授權，不能自己推斷他不想被問；清零要同時滿足「已經提不出新的分岔」與「使用者確認」。模板二（實作）、模板三（重構）補上【開工前對齊】欄，與模板六一致。
- **派工閘驗範本自己的欄位**：`check-review-discipline.js` 原本不驗範本裡已有的三格，等於只靠自律。實作類與 QA 類 agent 驗【開工前對齊】，QA 另驗【目標環境】【既有測試分流】。另新增「打開【計畫／設計文件】指向的 `.md`、驗必要章節」的規則（填空常數 `DOC_SECTION_RULES`）：預設要有「測試情境表」或「驗證計畫」標題，以及「待簽收／已簽收」句；檔案不存在就擋並提示。路徑可寫成 markdown 連結（取括號裡的路徑，`[x](<含空白路徑>)` 取角括號內的）、加引號（可含空白）或 Git Bash 的 `/c/…`（Windows 上轉成 `C:/…`）；沒加引號又含空白時（例：專案在「OneDrive - 公司名」底下），從 `.md` 結尾往前延伸、找磁碟上實際存在的檔照常驗。判不準的——含空白又找不到實際的檔、`~` 開頭、`http(s)://` 網址、Windows 上其他對不到的 `/…` 寫法——不擋、提醒這次沒驗到。相對路徑以專案根解析（找法同 `guard-qa-before-commit`：`CLAUDE_PROJECT_DIR` → hook 所在位置往上兩層 → payload 的 cwd），session 停在子目錄也不會誤擋。不驗的兩種情況：【開工前對齊】開頭寫「分流例外」（04 只要求行為類任務交簽收物）；architect 與 engineer 併一步、第一次派 engineer 時【計畫／設計文件】寫「本次產出：<路徑>」。architect 骨架與 04 的簽收物段落同步寫明這兩項，照骨架產出的文件才過得了閘；architect 骨架另提醒專案有自己的設計文件格式時要同步改 `DOC_SECTION_RULES`，engineer 骨架的併步說明補上簽收狀態句與「本次產出：<路徑>」寫法。
- **QA 閘的判準只留一份**：`guard-qa-before-commit.js` 原本自帶行為類副檔名與排除樣式，要人工跟 `.claude/qa-gate.conf` 保持一致。改成執行時讀 qa-gate.conf（behavior_ext、exclude；exclude 的 ERE 翻譯成等價的 JS），讀不到或翻譯不了才退回填空區的值，並提醒模型；擋下訊息寫明判準來自哪裡。staged 清單改用 `git diff --cached --name-only -z` 讀原始檔名（同 flow.sh），中文、含空白的檔名不再被 git 包成跳脫字串而漏判。init 的說明改成「conf 是唯一正本」，Phase 5 驗 hook 與 flow.sh 讀的是同一份。
### Added
- **接線帶 statusMessage**：每支範本 hook 的接線註解加一行白話說明，init 寫入 settings.json 時一併帶上，慢的 hook 執行時看得出是哪一支在跑。
- **probe-hooks 新增佔位 `{PROJECT_DIR_POSIX}`**：payload 裡換成暫存專案路徑的 Git Bash 寫法（Windows 上 `/c/…`，其他平台同原路徑），測「派工單用 `/c/…` 寫路徑」的案例。

## [0.11.0] - 2026-10-04
### Fixed
- **本機覆寫銷毀閘的判斷精度（只在語法解析器可用時放寬，其餘照舊）**：`guard-local-hack-destroy.js` 原本只要同 repo 有改過的覆寫檔，`git restore`／`git checkout` 不論點名哪個檔都整條擋。現在先照原本的判法算，要擋時，若語法解析器可用（同目錄的 `shell-model.js`，與規則引擎共用），再用語法樹確定每個 git 呼叫實際會改到哪些檔：目前目錄照語法樹追蹤一定會執行的 cd，判不準就照原本擋（條件裡的 cd、cd 失敗或引數不是恰好一個、pushd／Push-Location、`env -C`、PowerShell 的 `cd..`、cd 接反斜線、`C:` 這類內建函式、PowerShell script block 或子運算式裡的換目錄、`iex`／`Invoke-Command`、在 `bash -c`／`pwsh -Command` 等新程序裡都算判不準；PowerShell 5.1 實跑確認這些寫法真的會換掉 session 目錄）、環境裡沒有改變 repo 位置的 `GIT_*` 變數、全域選項只認 `-C`（依序疊加）、`--no-pager`、`-P`、`--no-optional-locks`，子命令與旗標都在完整清單內（縮寫、`--pathspec-from-file`、`submodule foreach`、別名都不認）、點名參數沒有萬用字元／pathspec magic／展開語法、執行目錄的 repo 實體路徑與覆寫清單上的 repo 相同，在它之前沒有看不出會不會換目錄的指令（bash 的自訂函式或認不得的名稱、PowerShell 的 `.ps1` 腳本與函式；用路徑跑的 bash 腳本是子程序，不算；git 本身與 `pytest`、`tsc`、`docker`、`make` 這類常見開發工具是已知外部程式，也不算——git 呼叫會不會改工作區另照上面的子命令清單判），而且同一串沒有寫檔的重導向或 cmdlet、`source`／dot-source、`eval`／`iex`、指令名稱不是字面的呼叫、PowerShell 用 .NET 換目錄，文字判斷認出的危險 git 呼叫數也要等於語法樹確認的數目；放寬過程出任何錯都照原本擋；全部確定而且沒點到覆寫檔才放行，任何一處判不準就照原本擋。沒有解析器（或 `HARNESS_SHELL_PARSER=off`、語法樹有錯）時判法與改動前相同。另認得完整路徑的 git（`/usr/bin/git`、加引號的 `…\git.exe`）、合寫短旗標（`stash -ku`、`stash -ua`、`switch -fc`、`checkout -qf`）、`checkout --ours/--theirs`、`checkout --forc`、`checkout --pathspec-fr` 這類縮寫，多行指令裡前一行的 `cd` 也算進去（這幾項只加嚴）。cases 改成兩條路徑各自的預期（`probe-hooks.js` 新增 `"parser": "off"` 標示只在正則路徑跑的案例，以及 `setup.links`、`setup.worktrees`）。
- **DB 登入示範規則改成「確認過的帳號＋密碼只從環境變數帶」**：`guard-risky-command.js` 原本的 `db-privileged-login` 是黑名單（擋 sa、root 這類高權帳號），實際事故是憑印象拼錯帳密、連續登入失敗把帳號鎖住。改成三條規則：`db-unconfirmed-login` 在 DB 用戶端位於指令開頭（含 `timeout`、`time`、`sudo`、`env` 這類前綴程式後面；`mysqldump`、`pg_dump` 等同樣會登入的工具也算）、或程式裡帶連線字串與 DB 連線 URI 時觸發，只看用戶端的帳密參數，不看 SQL 內容；帳號必須是 init 確認過的測試帳號（填空 `__DB_TEST_USER__`），密碼一律引用確認過的環境變數（填空 `__DB_TEST_PW_ENV__`）；引用寫法依 shell 方言：Bash 認 `$X`、`${X}`，PowerShell 認 `$env:X`、`${env:X}`（PowerShell 的 `$X` 是它自己的變數、送出去是空值），`%X%` 兩邊都不展開而擋（正則路徑與語法樹路徑都依 payload 的 tool 判）；帳密旗標依用戶端家族認、短旗標分大小寫（mysql 的 `-P` 是連接埠、psql 的 `-P` 是 `--pset`），前置的密碼變數要是那個用戶端自己讀的（`MYSQL_PWD="$X" psql` 不算），psql 的 libpq 連線字串照樣認（值可用單引號包：`host='localhost'`、`user='帳號'`，帳號比對時剝掉單引號；外層雙引號裡的 `password='$X'` 算引用，`password=\"$X\"` 會連雙引號一起送出而擋，外層單引號裡的 `password=$X`、URI 的 `:$X@` 是字面而擋）。只限環境變數賦值那一行（`export X=…`、`X=… 指令`、`$env:X = …`、`Set-Item Env:X`）：連線字串／URI 完全沒帶密碼、帳號對時放行（同一行出現任何密碼鍵就不算），`node -e`、`python -c` 這類程式碼裡的連線字串密碼一定要是確認過的變數引用；關鍵字參數不論順序（`connect(user=…, password=…, host=…)`、沒有 host 也算）都觸發；整串就是一次 `git commit`（可先 `git add … &&`、訊息可多行或用 `-m "$(cat <<'EOF' … EOF)"`；引號外換行之後的指令照常判）不觸發。`db-password-literal` 比對整串原始指令，擋掉把確認過的變數重新賦值、用單引號包住密碼變數、把用戶端密碼環境變數或密碼環境變數（名字等於或以 `_PASSWORD`／`_PASSWD`／`_PWD`／`_PASS` 結尾：`DB_PASSWORD`、`MYSQL_ROOT_PASSWORD`、`DB_PASS`；`PASSWORD_MIN_LENGTH` 這類設定、任何指令的 `-e`／`--env` 參數都不算——不只 `docker run` 起 DB 容器，`docker exec`、`docker compose run`、`kubectl run --env` 帶猜的密碼也放行；名字沒有底線的 `DBPASSWORD`、結尾不是密碼字樣的 `DB_PASSWORD_TEST` 也放行）設成別的值（清除用的 `$null`、空字串不算）、程式碼字串（`node -e`、`python -c`、`ruby -e`…）裡的 `password=`／`password:`／`'password':` 字面值（不論有沒有連線字串）、`Rename-Item`／`Copy-Item` 等把確認過的變數換掉、連線字串／URI 裡的字面密碼（含 `export DATABASE_URL=…`、`$env:DATABASE_URL = …` 這種存進環境變數的，語法樹路徑看不到賦值內容，靠整串比對；密碼鍵認 `password`、`passwd`、`pwd`、`pass`，鍵名可加引號、值可用各種引號包；URI 認方言+驅動（`postgresql+asyncpg://`）、`mysql2://`、`oracle` 等與 `jdbc:<子協定>:`，帳密也可在查詢參數；程式碼讀環境變數的 `getenv('X')`、`System.getenv("X")`、`Environment.GetEnvironmentVariable("X")`、`ENV['X']` 等寫法算引用）。`db-conn-account` 比對整串原始指令、分大小寫：連線字串／URI 的帳號不是確認過的那一個、存進環境變數的連線字串沒帶帳號或用整合驗證，一律擋（整串只印字或搜尋——echo、printf、grep、rg、cat… 而且管線每段都是——或只寫到 `*.example`／`*.sample`／`*.template` 的不算）。「先 `export PGPASSWORD="$X"` 再連線」這種轉交，只在語法解析器可用時依 shell 語意判定放行（經 `sudo` 執行不算；清除在用戶端之前擋，在用戶端之後——含 PowerShell `try { … } finally { Remove-Item Env:… }`——不影響），沒有解析器時一律擋。hook 與 cases 永遠不存密碼值。規則引擎新增 `whenCommand`／`unlessCommand`（比對整串原始指令）、`confirmedEnv`（確認過的變數不准被動）、`unlessEnvRef`（依用戶端讀的密碼變數判轉交）、`byTool`（依 payload 的 tool 換掉規則的部分欄位；寫壞時只停用那一條規則，故障提醒看得到）、`whenCommandCase`（搭 `whenCommand` 的規則：`whenCommand` 與 `unlessCommand` 分大小寫比對），`unlessCommand` 也可搭 `when`（這時分不分大小寫依 `unlessCase`），`when` 與 `whenCommand` 同時寫視為規則錯誤；`shell-model.js` 新增 `dirAt`（從嚴的目前目錄），並把背景 `&`、PowerShell 的 `$env:A = $env:B`（`${env:A}`、`${env:B}` 同等；只用在 DB 密碼轉交的判斷，`requireEnv` 等其他規則遇到這種寫法照舊當成值無法確認）、指令前綴的變數引用照 shell 語意建模。init 的 U1 改問「測試帳號名」與「密碼放在哪個環境變數」，不收密碼值。已知取捨寫在 hook 檔頭。
- **規則引擎故障時模型看得到**：`guard-risky-command.js` 與 `guard-test-preconditions.js` 的單條規則壞掉、外層出錯時，原本只寫 stderr 再以 0 結束，PreToolUse 這樣模型看不到，閘等於靜默失效。改走 `additionalContext`；同時有別的規則要擋時併進擋下理由。照樣放行（fail-open）。
- **`.claude` 整潔閘找專案根**：`guard-claude-dir-hygiene.js` 沒設 `CLAUDE_PROJECT_DIR` 時原本退回 cwd，session 停在子目錄就把根目錄 `.claude/` 底下的新檔當成專案外而放行。改為相對路徑先用 payload 的 cwd 轉絕對路徑，專案根找不到時退回 hook 所在位置往上兩層，判斷檔案存在一律用絕對路徑。
- **範本規則檔兩處自相矛盾**：02 對照表的「交給誰」欄（engineer → qa-engineer）與 04 的「子 agent 不互通，主對話是唯一匯流排」衝突，改成「做完後主對話接」並寫明 agent 之間不直接交接；05 §3 要求同主題合併成總則檔、又要求全檔 ≤15 行，兩條不可兼得，改成總則檔豁免全檔上限、新合併進來的節 ≤15 行。
### Added
- **probe-hooks 支援多 repo 測試情境**：cases 的 `setup.repos` 可在暫存專案裡建多個子 repo（含空白或多層路徑、乾淨的 repo），本機覆寫銷毀閘的多 repo 案例靠它寫得出來。

## [0.10.0] - 2026-10-03
### Changed
- **變更紀錄從規則檔拆出去**：規則檔（harness 的 02～05、CLAUDE.md、五支 agent、三份知識筆記檔）每次載入都整份進 context，檔尾的 changelog 節只會一直變胖。骨架移除檔尾的 `## Changelog`，改記在：`.claude/harness/CHANGELOG.md`（依檔名分節）、`CLAUDE.changelog.md`、`.claude/agents/CHANGELOG.md`、`CONTEXT.changelog.md`、`FLOWS.changelog.md`、`tests/Project_Detail/CHANGELOG.md`（新增 6 份紀錄骨架）。紀錄格式加「綠區」：知識筆記檔新增條目也要記一行。init 參考模式會把舊實例本體的 Changelog 節整節搬出去；`guard-sediment-sweep.js` 的沉澱提示改指向新的變更紀錄落點；Phase 5 改為靜態十二項，新增一項檢查規則檔本體沒有 changelog 節。
- **健檢提醒改讀新位置**：`health-check-reminder.js` 只認 `.claude/harness/CHANGELOG.md` 的 `## 05-knowledge-protocol.md` 節裡帶【健檢執行】的行（別節的不算）；新檔不存在或沒有這一節時退回讀 05 本體，舊實例照常運作。對來源專案（已拆出 changelog）實測：舊版永遠不提醒，新版正常提醒。
- **健檢收集腳本**：`review-collect.js` 每份檔的紀錄改從三處讀（本體的 Changelog 節、`<檔名>.changelog.md`、同目錄 `CHANGELOG.md` 的分節），輸出實際讀到哪幾處；修正舊版把 Changelog 節之後其他節的日期也算進去。安裝日先看拆出去的紀錄檔（不再對 CLAUDE.md 全文比對，專案概要的進度行不會被誤認）；「上次健檢」與健檢提醒同一個讀法（新紀錄檔有 05 節就只讀它）。對來源專案實測知識筆記檔異動從 0 筆變成 4／3／2 筆。
- **提醒型 hook 改用 additionalContext**：官方文件寫明只有 UserPromptSubmit、SessionStart 等事件的純文字 stdout 會進模型脈絡；實測 PostToolUse 印純文字時模型回「NONE」，改成 additionalContext JSON 後逐字引用到。`memory-write-advisory.js`、`guard-test-asset-hygiene.js` 的提醒與 `guard-qa-before-commit.js` 的放行提醒都改了；`probe-hooks.js` 新增案例欄位 `"visible": true`，要求提醒必須是模型看得到的形式。
### Added
- **QA 表態閘改成兩層：權威檢查移進 git-commit 的 flow.sh，guard-qa-before-commit 只做 Skill 入口的提早提醒**：專案有 `.claude/qa-gate.conf` 時，git-commit 0.11.0 以上的 `flow.sh review-record` 自己看該 repo 的 staged，有行為類檔卻沒帶 `--qa "已QA…"`／`--qa "分流例外…"` 就拒絕記錄（ship 沒有審查紀錄一律拒絕），`block_staged_overrides=1` 時 staged 混進本機覆寫清單上的檔也拒絕（`--allow-overrides "<理由>"` 放行）。`guard-qa-before-commit.js` 接線只剩 `Skill`：呼叫 git-commit skill 時 staged 有行為類檔、args 沒帶 `--qa-verified`／`--no-qa` 就先擋下要求表態，放行時用 `additionalContext` 提醒「專案有 qa-gate.conf 時 review-record 那步由 flow.sh 強制要求 `--qa`」。為什麼不在 Bash 層攔：hook 只看得到指令文字，flow.sh 可經函式、變數、陣列、`set --` 後 source、Invoke-Expression、字串拼接間接呼叫，靜態分析（文字比對或語法樹都一樣）原理上補不完；在 flow.sh 裡檢查，怎麼呼叫到它都會被查。`guard-claude-dir-hygiene.js` 的 `.claude/` 根層允許清單加上 `qa-gate.conf`，init 才建得出來。需要 git-commit 0.11.0（與本版同時發布）。init：Phase 0-5 讀 git-commit 版本，低於 0.11.0 時問要不要更新並說明影響（不更新就只剩提早提醒）；Phase 4 裝 guard-qa 時產生 `<落點>/.claude/qa-gate.conf`（與 `local-overrides.yml` 同一層，`behavior_ext`／`exclude` 與 hook 填空區同一份盤點，裝了本機覆寫保護時 `block_staged_overrides=1`）；Phase 5 在暫存 repo 實跑 `flow.sh review-record` 不帶 `--qa` 被拒、帶了才寫入。04 模板五配套改寫成兩個入口各怎麼表態、review-record 那步由 flow.sh 強制。guard-qa 新增開關 `CHECK_OVERRIDES`（C 類，跟本機覆寫保護一起開）：在 Skill 入口讀 `flow.sh analyze` 的 `[STAGED, in overrides]` 標記，staged 裡混進本機覆寫檔就擋；Windows 上優先找 Git Bash（PATH 上的 bash 可能是 WSL）；自動找 flow.sh 時依序取 `FLOW_SH` 填空、專案自帶的 `.claude/skills/git-commit/flow.sh`、`installed_plugins.json` 裡這個專案實際裝的版本（專案層優先、其次使用者層），都沒有才取 cache 裡最新修改的那份（cache 常同時留著好幾個舊版）；擋下夾帶時一併提醒 `block_staged_overrides=1` 的專案在 review-record 那步要帶 `--allow-overrides`。guard-qa 不用語法解析器，`shell-model.js` 照舊只在裝了兩支規則引擎時帶。
- **check-review-discipline 驗作答內容**：【驗收條件】剝掉佔位與說明後不能是空的；【測試資料來源】第一行要寫「選 a／b／c」，選 b 附產品端「檔名:行號」、選 c 附理由；同一行出現兩個不同的「選 X」不算明選。只驗標題的話，整段範本照貼就會放行。04 模板六同步寫明格式；標題後的括號說明裡可以再有一層括號（數括號深度剝到配對的那個為止），照範本原文作答不會被誤擋。每一格的作答範圍：取出現在行首的那個標題（前文在句子中間提到「依下方【測試資料來源】造」不算），到下一個「換行後緊接【…】」（行首可有空白與 markdown 記號）為止——作答裡引用別處（「選 b：見【規格】src/x.py:3」）不會把證據切掉；04 模板的欄位標題都在行首，專案自加欄位也不必維護清單。驗作答的程式丟例外時照樣放行，但用 `additionalContext` 告訴模型「派工內容檢查故障」（同時有其他缺項要擋時併進 deny 理由），不靜默放行。
- **判斷矩陣 41 → 43 條**：B24「同構檔改一側，必掃另一側」、B25「自己起一套服務，就配一份自己的環境檔」（挖空形狀，綁專案的細節不帶）；新增「能力極限」一節（品味決策、模糊商業判斷、跨 session 架構級重構、規則互相矛盾時怎麼停）；A8 加錨點，引用 CLAUDE.md 新增的「引入專案沒有的新模式前先徵得同意」。
- **04 派工範本**：模板五加「大案切票」（垂直切片、blocked by、寬重構先擴後縮的例外，計畫加「切票判定」欄）；共通規則加「派 architect 前先找既有同類模組」「停背景測試一律用 TaskStop，不依父子關係砍程序」。
- **02 模型調度**：跨代換模型要手動切；quota 熔斷恢復後用 resume 續跑；單次、回傳量小的 MCP 查詢主對話可以親跑（附正反例）；MCP 分瀏覽器類與程式碼索引類兩種紀律。
- **05 知識協議**：新增「產物存放紀律」（落點表、換一個專案還需要嗎、檔名有沒有日期戳、歸檔前先查引用）；memory 索引行標星等（⭐⭐⭐ 使用者裁定、⭐⭐ 會靜默失效、⭐ 一般坑、無星），索引瘦身只動 ⭐ 與無星；§5.1 加覆蓋登記的形狀（{{覆蓋登記檔}}，判準 0 孤兒／0 幽靈／0 佔位）；新增 §7「01 診斷書／06 交接信何時建、怎麼建」。
- **五支 agent 骨架**：依觸及的層選讀規則檔、註解寫 Why 不寫 What（實作端）；審查先跑機械掃描、「零規則引用又零違規＝沒做完」；QA 設計前先讀被測物、codify 完成判準 0 孤兒／0 幽靈／0 佔位；每支加「本專案綁定的 skill」填空。
- **init 新增第 10 題**：專案用語表要不要用 `@CONTEXT.md` 匯入主對話（利：主對話一定讀到，「當場寫」的時機才有效；弊：每個 session 固定成本）。推薦匯入；實測 `@CONTEXT.md` 要獨立一行、不加反引號才會匯入。
### Fixed
- `skeleton-harness-README` 寫 01／06「照 05 的規則建立」，但 05 沒有這條規則；改指向新增的 05 §7。
- `guard-sediment-sweep.js` hook 故障時的放行訊息原本是純文字（只進除錯紀錄，沒人看得到），改成 `systemMessage` JSON。
- `guard-claude-dir-hygiene.js` 的 `.claude/` 根層允許清單漏了 git-commit 的 `git-commit-reviewer-addendum.md`（git-commit 規定放在這一層的設定檔，Write 新建會被擋），補上。
### Notes
- hook-catalog 第 28 列：來源專案的 compact-resume-judge（開 session 時起子程序回填「壓縮後使用者有沒有重講背景」）刻意不做成範本——範本沒有任何東西讀這個欄位，而且每次開 session 都要付費開子 session。
- 全套探針：語法樹路徑 616 → 662、正則路徑 568 → 614（正則路徑另略過 48 個只有語法樹做得到的案例），全數通過（guard-qa 只留 Skill 入口，另補 2 個「Bash 呼叫 review-record 不論帶不帶 --qa，hook 都不攔也不出聲」的案例，確認 Bash 層交給 flow.sh）；每支改過的 hook 都有新案例在修改前的版本會失敗。
- 骨架只是給 init 讀的文件，這版沒有實際跑一次 init 產出實例；新填空 init 填不填得好，要等下次實跑。

## [0.9.0] - 2026-10-03
### Fixed
- **本機覆寫檔被清空或刪除時，三支同時失效**（拿來源專案的實際機制逐項比對時發現，已用探針重現）：在 git 眼中「整檔刪光」也是一種改動，於是 alive 不點名、restore 檢查模式報「全部完好」，backup 還把唯一一份正常的 patch 蓋成刪除形狀。四支共用的清單解析區塊新增 `wipedReason`（檔案不在、0 bytes；只看檔案本身，不看 diff 的形狀——`git rm --cached` 之後檔案完好、diff 卻是整檔刪除，看 diff 會誤判並在救回時蓋掉現況）：backup 遇到就不存、不轉存，已有備份時用 additionalContext 提醒模型（同一次清空只提醒一次）；檔案還在、diff 卻是整檔刪除形狀的 patch 也不存（存了只會把正常的備份擠進歷史版本）；轉存歷史版本失敗時不覆蓋目前那份；alive 與 restore 把它當成「不見了」；restore 救回追蹤中的檔時先寫回 HEAD 內容再套 patch，「目前」那份備份已是刪除形狀時改用最新一份正常的歷史版本。
- **行數大幅減少只提醒、不當成不見了**：來源專案把「行數不到參考值一半」也當成清空。但覆寫本身可能就是合法的大幅縮短，審查時實跑重現：backup 永遠不存新版，alive 叫人救回，`--restore` 用舊備份蓋掉現行覆寫，新版從此沒有任何副本。改成另一個判準 `shrunkReason`：backup 照存（前一版自動留在歷史版本），剛變短那一次提醒並附縮短前版本的檔名（之後再改不重複提醒）；alive 不報；restore 檢查模式列出並指出縮短前的版本。另外 `--restore` 蓋掉還有內容的檔之前，先另存成 `<備份名>.<時間>.before-restore`（每個檔留最近 10 份；讀不到現況時該項直接失敗、不蓋掉）。歷史版本檔名加上毫秒，同一秒內轉存兩次不會互相蓋掉（舊格式照樣認得）。
- **換行自動轉換造成的假改動**：HEAD 存 LF、`core.autocrlf=true`、工作區是 CRLF 時，status 顯示有改動、`git diff HEAD` 卻是空的（已實測重現），覆寫早就不見了，三支卻當成「還在」。`fileState` 改成 status 說有改動時，再看工作區與 index 是否都跟 HEAD 相同——只看工作區的話，覆寫只留在 index（status MM）時會判成乾淨，guard 就放行 `reset --hard`（審查時抓到）。
- **認不得別的實作留下的備份**：備份檔名本組用清單的頂層 key，來源專案用 repo 值，換成本組後舊備份全部「看起來不存在」。找不到時退回試 repo 值命名的備份。
- **歷史版本誤認**：清單上同時有 `conf.txt` 與 `conf.txt.bak` 時，前者會把後者的備份當成自己的歷史版本。改成精確比對時間戳記檔名。
- **`sh -c "cd app && git reset --hard"` 放行**：包裝指令的引號裡先 cd 再 git，git 不是第一個字，原本兩條判定路徑都放行。現在引號字串裡位於指令開頭位置的 git 也算包裝在執行；只是提到 git 這個字的（`bash -c "echo legit"`）照樣放行。取捨：包裝裡用 echo／grep 引述一段以空白開頭的 git 指令會多擋（判不出是執行還是引述）。
### Added
- **覆寫清單的三個選填欄位**（只有開場檢查 alive 與救回腳本 restore 會用；git-commit 的 flow.sh 只認 path，不受影響）：
  - `needed-when-file`＋`needed-when-contains`：只有判準檔含有指定字串時，這筆覆寫才算需要。用在只在某些分支才需要的覆寫（例：本機 mock 類別只在有注入它的分支才需要），切到沒有該功能的分支時不再每次開場都假警報。判準檔讀不到就當需要。
  - `requires`（好幾個時重複寫這個鍵，也接受 `- 字串` 清單與 `|` 多行字串）：覆寫檔一定要含有的字串。檔案在、但缺了它＝帶到舊版覆寫，alive 與 restore 另列「內容不完整」。
- **init 新增訪談第 9 題**：裝了本機覆寫保護、且盤點找到候選時問。盤點第 11 項會找「不被 git 追蹤的整檔覆寫被誰引用」（候選的判準檔與字串），以及清單或紀錄寫過「舊版會出事」的覆寫；使用者選的寫進覆寫清單（先建 .bak），Phase 5 跑一次 restore 檢查模式驗證。
- **03 判斷矩陣新增 A9**：環境級異常（服務起不來、端點全回授權錯誤、外部呼叫逾時、測試信寄到真人）而本任務沒動到那一段時，先查本機覆寫還在不在；有多工作樹時加「開新工作樹時帶齊覆寫」。B5 加反方向：真改動落在覆寫檔裡時只 stage 真改動，不能因為整檔被排除就漏推。
### Changed
- 形狀目錄第 19 列（從別的工作樹起服務時檢查覆寫）：hook 仍不移植，但改正理由——它防的「新工作樹漏帶覆寫」第 16–18 列蓋不到（新工作樹沒有東西可救），改以 A9 文件條款帶過去。
- `adaptation-guide.md` §1.1 修掉前後矛盾：原本把「本機 hack 管理」列為不帶，實際上它已參數化成 C 類 hook；改成只把綁服務拓撲的多工作樹稽核列為不帶。
- 覆寫清單的選填欄位只認跟 `path` 同一層縮排的行（審查時抓到：別的屬性底下、`reason: |` 多行字串裡的 `requires:` 會掛到前一筆），沒加引號的值去掉行尾註解。
- 本機覆寫四支的探針案例從 48 個增加到 77 個；第一輪新增的 21 個裡有 12 個在修改前的版本會失敗。探針判不出的部分（備份內容有沒有被蓋掉、`--restore` 實際救回、autocrlf、只留在 index 的覆寫、合法縮短、救回前另存、`git rm --cached`、縮短只提醒一次、行數顯示）另寫端對端實測 32 項全過。經兩輪對抗審查：第一輪確認的程式問題（只留在 index 的覆寫、合法縮短被當成清空、欄位掛錯）用審查代理的重現腳本重跑都不再重現；第二輪確認的（`git rm --cached` 誤判清空、`requires` 清單與 `|` 寫法、縮短重複提醒、行數多算一行）都已修並有案例。包裝指令多擋引述是有意的取捨。

## [0.8.0] - 2026-10-01
### Changed
- 制度健檢改三軌、可逆的修正當場修：/harness:review 開跑先請使用者輸入 /doctor 與 /insights；派 subagent 逐項跑 05 健檢清單（新增 §5.1 本專案稽核工具表、會說謊的索引與快取、健檢提醒自己算得對不對、新出現的大宗工具來源），清單寫了預期結果的項目照描述實跑、對不上時查證是清單過時（有刻意改動的證據）還是自動檢查壞了（沒有證據就當故障）；/insights 的建議逐條對照現有規則分三類；清單項目可標【使用者親自看】放報告最前面。修正分兩批：可逆的列一批一次核可後當場修、每項重跑原檢查驗證，改規則或不可逆的仍逐項問。修正 health-check-reminder 取「檔案最後一筆」而非「日期最大」的錯（changelog 新的寫在上面時提醒永遠不歸零），並改成只認專用標記【健檢執行】（文字判準連續四輪審查被找到誤認或繞法）。probe-hooks 新增 SILENT 期望（不擋且不能有輸出），7 支提醒型 hook 該安靜的 25 個案例改用它——原本 ALLOW 不看輸出，誤報提醒也會判過；同時修正 memory-write-advisory 一個不真實的案例。init 盤點時記下專案自己的稽核腳本與會說謊的東西，寫進 05 §5.1。
- **升級提醒**：健檢提醒改成只認 changelog 裡日期後面緊接專用標記的紀錄（`- 2026-10-01 【健檢執行】/harness:review：結論…`）。沒有標記的舊格式（`健檢執行：…`、`制度健檢（/harness:review）執行：…`）不再算數。一筆帶標記的都沒有時，hook 依序退到 `FALLBACK_BASE_DATE`、changelog 最早的日期起算，所以舊實例照新範本更新 hook 後，只要最早日期已超過門檻就會提醒；跑一次 `/harness:review` 補紀錄時就會寫入帶標記的那行，或手動補一行同格式的紀錄。改制度的紀錄不准用這個標記。

## [0.7.0] - 2026-09-29
### Changed
- `/harness:init` 依別的專案試行的回饋改版：
  - **Phase 0 先比對遠端版本**：新增 `scripts/check-version.js`，到 marketplace 的遠端 repo 讀最新版本號，跟正在用的比；落後就停下並給更新三步（marketplace update → uninstall → install），順便列出本機已下載但沒啟用的新版。遠端預設分支直接問遠端（不拿本機分支頂替），版本照 SemVer 比（預發行版比正式版舊），遠端版本號缺漏或格式不對一律算查不到。查不到遠端不擋，收尾回報寫明。起因：安裝到一半冒出新版，舊版少了畫流程圖那一步，裝完才發現、整輪重做。
  - **git-commit、Codex 沒裝都改成「問要不要裝」**：新增 0-5 檢查 git-commit，在前置檢查就給裝與不裝的對照與安裝指令；0-3 Codex 不再停下，改成同樣附對照問使用者，排在 0-5 後面（沒有 git-commit 就用不到 Codex）。使用者裝好後由 Claude 自己重跑檢查確認。選不裝 Codex 時照一位審查員裝，並記進 05 健檢清單。
  - **多 repo 工作區算 git 專案**：根目錄不是 repo、底下有子 repo 時，git-commit 相關的檢查照裝，攔截探針對每個子 repo 各跑一次。
  - **參考模式帶走原有規矩的經驗**：由 subagent 用語意判斷（不准用關鍵字比對）挑出原有規矩裡這個專案自己的經驗，不限自稱「踩坑」的條款，也包括一般規則寫法的約定、禁令、數字上限。照預設處置不會被帶進新設定的，新增 Q8 讓使用者選要不要升格，升格的寫進 03 新增的「矩陣 D：本專案經驗條款」，認得出指令樣子的加自動檢查。Phase 5 另派一支 fresh-context subagent 做經驗帶走審查：不給它原本的清單，從舊文件那一側逐條找新設定裡還在不在，沒帶到的補回或交給使用者決定，最多兩輪。
  - **沿用原有 agent 時照職責給預設模型**：寫規格或做設計的用 opus（adaptation-guide §2.1）；收尾回報附各角色的模型對照表。
  - **收尾回報不再寫「踩坑知識 0 條」**：改成說明規則已照這一版 harness 產生（參考模式是重新產生），以及原有經驗帶到哪裡。
- `/harness:review`：init 時選了不裝 Codex 的專案，review 會再檢查一次 Codex 裝了沒，提醒或提議刪掉那一列。

## [0.6.1] - 2026-09-27

### Fixed
- `/harness:review` 收集腳本：0.6.0 發布時兩道審查附的 8 項建議。
  - **主機名含底線時完全沒被計到**：`ssh prod_db`、`psql -h prod_db.corp` 這類原本整條丟掉，連「文件沒寫過的主機」計數都沒有，判讀時會漏看；現在照樣計數，文件寫過的照樣列出。
  - **日期用 UTC 比**：逐字紀錄的時間是 UTC，`--since` 與安裝日是當地日期，台北清晨的 session 會被當成前一天而略過；現在先換成當地日期再比。
  - **跨午夜的派工沒算**：主對話 23:59 派出、subagent 午夜後才跑完時，subagent 有算進 D，但那次派工沒進 C，兩邊數字對不起來；現在用派工回傳的 agentId 對到 subagent 檔，這次派工照樣算進 C（範圍前的其他列仍不算；只認 Agent／Task 的回傳，別的工具輸出裡剛好有「agentId:」不算；這種派工之前的對齊線索在範圍前沒被看過，第一次派工的對齊狀態記「無法判斷」而不是「沒對齊」）。
  - **改檔工具自己失敗仍算有改檔**：「String to replace not found」這類失敗的 Edit 原本仍把該回合算成有改檔；現在任何失敗的改檔都不算。
  - **parserMode 被失敗案例說明誤判**：原本掃整段試跑輸出，FAIL 案例說明裡剛好有「沒有完整載入」就判成 ⚠；現在只看狀態行。
  - **沉澱回答值可帶少量任意字**：原本收「已＋1～3 個中文字＋數字」，改成固定清單（無、已補N詞／條／鏈／處／個、已正名N處）。
  - **文件**：SKILL 的「示範條目還在＝筆記沒被用過」改成只是線索，要先看安裝後異動與正文；SKILL 補寫沒有點的主機名與 ssh 別名一律只計數（含底線但有點的主機名，文件寫過照樣列出）；0.6.0 條目「後面接空白」更正為「接空白或引號」（與程式一致）。

## [0.6.0] - 2026-09-27

### Added
- **`/harness:review`**（`skills/review/SKILL.md`）：檢查 init 裝好的流程實際用起來有沒有起作用。只讀、只提案，不自己改規則。流程：找範圍（預設看上次健檢或安裝之後）→ 收集（腳本）→ 判讀（每個數字回原文核對）→ 問使用者兩題 → 報告與修正提案 → 使用者選了才照 05 分級改 → 使用者同意才在 05 補一行健檢紀錄（`health-check-reminder.js` 會從那天重算 30 天，已實測）。
- **`skills/review/scripts/review-collect.js`**：從逐字紀錄、subagent 紀錄、知識筆記、settings、版本差距抽九個面向的數字，每個附出處（`檔名:行號`）；只抽不判、只讀（加 `--probe` 才試跑實例的自動檢查）。設計原則是**輸出不抄原文**：指令、使用者發言、擋下訊息、知識筆記一律只記出處與抽出的線索；名稱類欄位只收已知值（實例的角色與 hook 檔、已知模型、專案文件寫過的主機），其他換成固定字樣或計數；遮值總清掃只當保險。
- 在一個真實專案試跑：略過 4 個安裝相關 session、看 1 個使用中的 session。最後一版抽出：派出去 12 次（另 2 次被擋下，補齊欄位後重派同一角色）、1 次提問因沒附建議被擋、12 個角色的 CLAUDE.md 都有讀到（多數是自動載入）、12 個角色只有 1 個讀了 CONTEXT.md（0.3.2 版本落後）、26 處指令把金鑰寫在指令裡（該 session 仍在使用，數字會再增加）。審查者另寫程式直接數原始紀錄，派工與擋下數字一致；跑前跑後專案檔的雜湊完全相同。報告照易讀性規則自檢通過。
- 05 骨架的定期健檢改成用 `/harness:review` 執行；README 補用法。原本寫「規劃中、尚未提供」的 4 個檔（05 骨架、init SKILL、adaptation-guide、README）改寫成實際分工：事故型條款由各實例的 `/harness:review` 列進提案；review 只看單一實例，跨專案回收進骨架仍由維護者人工判斷。

### 發布前審查修正（Codex 與 code-reviewer 共八輪）
- **外洩**：原本輸出指令與訊息摘錄、再用正則遮值，審查者每輪都造出新漏法（加引號的 `--password "…"`、值含 `&` 或空白、PowerShell hashtable 鍵、中文「密碼是…」、密碼含 `@` 被當成主機、多行指令）。改成不抄原文、名稱只收已知值之後，四組假資料（共一百多個假值，含惡意的 probe 輸出）輸出 0 外洩。另移除一處註解裡的真實金鑰前 8 碼（commit 前由敏感掃描抓到，git 歷史沒有）。
- **試跑**：只取合計數字、失敗的 hook 檔名與 BLOCK／ALLOW／NOTE／CRASH，另記規則引擎實際走的判定路徑（parserMode；解析器沒裝好時兩次試跑都走正則，數字照樣全綠）。
- **只讀**：讀派工檢查表不用 `eval`（會執行專案程式碼），改文字解析；試跑要加 `--probe`，SKILL 規定先問使用者；收集結果寫到系統暫存目錄，不進專案。
- **範圍**：日期逐筆篩（原本 session 有一筆在範圍內就整段算）；cwd 逐列篩（逐字紀錄目錄名換算會撞名、session 中途會切專案），subagent 也篩，沒有 cwd 的在主對話切過專案時略過，subagent 以最後一筆時間判斷在不在範圍內，主對話沒有範圍內的列、但 subagent 有時整個 session 照樣看（午夜前派出、午夜後才跑完的不會被丟掉）；略過安裝 session 與冷啟探針 session；安全分類器插入的訊息不算使用者發言；解析失敗的行記進 notes。
- **判定**：hook 擋下只認 `is_error=true` 且標籤是已知 hook 標籤（hook 程式碼裡引號後緊接、後面接空白或引號的「[標籤]」，不收含正則符號的；規則引擎的 `LABEL` 常數；派工檢查規則的 name；範圍含實例、plugin 範本與 plugin 常駐 hook。實測漏收 `LABEL` 時守門擋下會被算成 0 次。已知限制：提醒型 hook 的格式標記如「[memory]」也在清單裡，非 hook 的錯誤訊息開頭剛好是它們時會被多算）、或帶「PreToolUse:… hook error:」前綴（含 MCP 工具名）；被擋的提問不算對齊、被擋的派工另列、被擋的改檔不算有改檔；F 的「危險指令檢查擋下」只算危險指令守門本身（交付路徑、測試前置條件守門另計在 C）；subagent 的 Read 要對到成功的結果才算讀了，失敗記 failedReads；CLAUDE.md 自動載入只認 `type=attachment` 列（實測內容在 `rendered[].content`），比對完整路徑且路徑要在那裡結束（`CLAUDE.md.backup` 不算）；知識筆記不算 init 建檔那一行；以一般文字徵求同意也列為可能已對齊。
- **主機**：斷詞後取——網址取最後一個 `@` 之後；ssh／sftp 取第一個位置參數，scp／rsync 取 `host:path`；認得續行、`$()`、反引號、sshpass、合併短選項。38 條常見寫法抽到 37 條（漏的是沒有點的 ssh 別名，刻意只計數）。主機只輸出專案文件裡以完整主機名出現過的（兩側都不能再接「.英數字」，文件寫 `api.example.com` 不會放行 `api.example`），其他只計 unknownHosts。
- **金鑰偵測**（只記種類與出處）：名稱規則要求金鑰字在名稱結尾，補 20 多種寫法，排除佔位字與引用（`os.environ`、`.*`、`/run/secrets`）；審查者造的 22 條該抓的抓到 21 條、17 條不該抓的誤判 2 條。
- **文件**：README、05 骨架、init SKILL、adaptation-guide 的「規劃中、尚未提供」改成實際分工（review 只看單一實例，跨專案收進骨架仍由維護者判斷）；05 的健檢清單標明 review 會附證據的項目與不查的項目；留健檢紀錄與試跑自動檢查都要先問使用者。

### Fixed
- 0.5.1 審查最後一輪留下的 4 項措辭：04 範本二「一個不准跳」改成允許的略過要寫理由；範本六的略過理由只列「專案沒有這個檔」（QA 必讀不含 FLOWS.md）；SKILL 參考模式「沿用」角色要同時加進 check-agent-model 名單與 `REQUIRED_MARKERS`；qa-webwright 範例的回報格式補「沒讀的寫理由」（qa-webwright 維持 0.9.1，這是同版文件修正）。

## [0.5.1] - 2026-09-27

### Fixed
- **必讀檔讀取閉環**：逐一盤點 init 產出的每份文件「誰寫、誰讀、讀有沒有機制擋」，找到同一類缺口——寫入有檢查（沉澱四問逼問要不要寫），讀取只寫在文件裡，派工時漏列或 agent 沒讀都沒人發現。實例：`tests/Project_Detail/PROJECT.md` 只有 qa-engineer 的 agent 檔與 04 範本六列為必讀，派工檢查對 QA 只要求【範圍展開】【測試資料來源】，04 也只核對實作型回報的已讀清單；`CONTEXT.md` 不在任何實作、測試、審查角色的必讀清單；code-reviewer 的派工範本連【開工前必讀】欄位都沒有；backend-architect 根本不在派工檢查的表裡。現在每個角色都走同一個閉環：agent 檔列必讀 → 04 範本有【開工前必讀】欄位 → 派工檢查（`check-review-discipline.js`）擋缺欄位、也擋漏寫必讀檔名 → 回報列「已讀清單」、主對話核對。
  - 全部角色必讀 `CLAUDE.md`（專案概要）與 `CONTEXT.md`；架構、實作、審查另要寫到 `FLOWS.md`（有沒有觸及已收錄鏈路機械判不了，所以沒觸及也要寫一句，逼派工的人判斷一次）；QA 另要 `tests/Project_Detail/PROJECT.md`（Windows 反斜線路徑也認得）。
  - 04 範本二（實作）把必讀檔逐項列出（原本只有佔位字，照範本派會被新的檢查擋）；範本三（重構）補「親自執行」與派專案 agent 時的【開工前必讀】（原本拿去派專案 agent 會被擋，既有缺口）；範本四（審查）加【開工前必讀】欄位與原本就缺的「親自執行」；範本六（測試）加 `CONTEXT.md` 與回報的已讀清單；「派工後的指揮官義務」第 1 條從「只核對實作型」改成凡附【開工前必讀】的回報都核對：清單上每一項要有交代（讀了，或寫出允許的略過理由——`FLOWS.md` 沒觸及已收錄鏈路、專案沒有這個檔），都沒交代才退回。QA 的必讀規則要求路徑含 `tests/`（寫錯目錄的同名檔不算）。專案真的沒有某份必讀檔時，派工照樣寫出檔名並註「專案沒有這個檔」（擋下訊息會提示這個寫法）；qa-engineer 骨架與 04 各範本的「缺一檔＝整份退回」改成「沒讀又沒交代理由才退回」。
  - agent 骨架：backend-engineer 補專案概要與 `CONTEXT.md`；frontend-engineer 補專案概要與 `FLOWS.md`（`CONTEXT.md` 原本就有）；qa-engineer 補 `CONTEXT.md` 與回報的已讀清單；code-reviewer 補專案概要、`CONTEXT.md`、`FLOWS.md`，VERDICT 格式最後加一行 `- 已讀：…`（仍是「- 」開頭，匯流只看第 1 行，實測不受影響）；backend-architect 的必讀先讀專案概要、回報第一段是已讀清單。
  - 派工檢查的測試案例重寫為 19 個（只漏 CLAUDE.md、只漏 CONTEXT.md、只漏 FLOWS.md（實作與審查各一）、只漏 PROJECT.md 各有單項擋下案例，架構角色納管，Windows 反斜線路徑放行，git-commit 審查 prompt 放行），probe-hooks 兩條路徑全過。
  - 參考模式或多工具治理層保留原名的 agent：SKILL 的裁切規則加上「`REQUIRED_MARKERS` 的 key 也要改成定案名字」，否則那個角色完全不受派工檢查。
  - 已讀清單在 04 共通規則、三支實作／架構骨架、qa-webwright 範本都寫明「沒讀的寫理由」；04 共通規則的已讀清單要求獨立成一行（原本和可刪的填空寫在同一行，照字面刪會連帶刪掉）；改名時要改 `REQUIRED_MARKERS` key 的提醒補齊到 Q1、參考模式處置表、adaptation-guide 三處；派工檢查裡 git-commit 審查範本的案例改成從 git-commit 範本逐字取出。
  - 舊說法清掉：「開工前必讀清單」「04 必讀清單」「共用三項」等 5 處改成現行寫法。
- **harness 的派工檢查會擋 git-commit 的審查**：git-commit 派 code-reviewer 的 prompt 範本沒有 harness 要求的欄位，裝了 harness 又有自訂 code-reviewer 的 git repo，每次 commit 前的審查都會先被擋一次（實跑確認：一次列出 5 項缺漏）。不會卡死（補齊後重派即可），但每次多一輪。已由 git-commit 0.8.7 補上欄位，實跑新範本兩種名稱（`code-reviewer`、`git-commit:code-reviewer`）都放行。
- **harness 的派工檢查也會擋 qa-webwright 的派工範本**：harness 會剝掉 plugin 前綴，`qa-webwright:qa-engineer` 被當成 qa-engineer 檢查，而 qa-webwright 的範本原本就缺【驗收條件】【回報格式】，這次又多缺必讀檔名。已由 qa-webwright 0.9.1 補上，填好的範例兩種名稱都放行；qa-webwright 自己的閘測試 544 項全過，`tests/` 全部 973 項通過、4 項略過。

### 盤點後判定不改的
- `.claude/harness/README.md`、02～05 只有開 session 時的提醒，沒有「讀了沒」的檢查：其中關鍵規則已有結果面的自動檢查（派工帶 model、派工欄位、問題附建議、沉澱四問），逐條擋讀取成本過高；改由規劃中的 `/harness:review` 從實際紀錄量測有沒有照做。
- 健檢提醒：盤點時被判為「只在滿 30 天提醒一次」，實跑推翻——逾期期間每個 session 都會提醒（模擬第 31、50 天都有輸出）。
- memory：主對話的 `MEMORY.md` 索引由 Claude Code 在 session 開始時自動載入；派工時照 04 規定把相關條目內聯進 prompt。
- 卡丽斯韩国實例缺專案概要、install-report、流程圖：該專案用 0.3.2 安裝，這些是 0.4.0、0.5.0 才加的，屬版本落後，要用 `/harness:init` 參考模式升級，不手動補。

## [0.5.0] - 2026-09-27

### Added
- **init 先弄懂專案在做什麼，再裝流程**（`skills/init/SKILL.md` 核心原則第 6 條）。原本盤點 12 項全是技術面，訪談 8 題全是流程設定，沒有一步問這個專案給誰用、做什麼。實際紀錄（一次實際安裝）：①盤點把設定檔預設網址判成「正式 ERP」，建議 5 項動作全部要先問，使用者回「這些都是測試環境」全部推翻，這個更正是第 2 題碰巧問到才得到的 ②裝完 `CONTEXT.md` 只有示範詞條，因為過程中沒問過任何專案詞 ③必讀文件推薦了盤點時自己判定已過時的 README，沒標出哪裡過時 ④核對表整則沒有一句話講這個專案在做什麼。
  - **Phase 1 第 13 項「專案輪廓」**（每個專案都查）：用途與使用者；外部系統與資料庫（讀或寫、位址、文件說它是正式或測試——只當線索，一律記「待問」；不走網路的記「不適用」）；業務流程分已實作／部分實作（寫出缺哪一段）／還沒做；進度（文件自述 vs 實際）；候選專案詞最多 10 個（附出處與推的定義，不拿通用詞湊數）；每份可能列為必讀的文件哪裡過時。位址記下的當下就把帳密與 token 遮成 `***`（第 10 項的連線字串同樣處理），第 10 項出現的資料庫主機一併走 U1。
  - **Phase 2** 核對表最前面放「專案概要草稿」，每句附出處並明講是推論。
  - **Phase 3** 在流程設定題之前加三題：U1 外部系統與資料庫哪個是正式、哪個是測試（有要判斷的外部系統才問）；U2 現在做到哪、接下來做什麼；U3 逐個確認候選專案詞（參考模式不重問已收的詞，衝突的請使用者裁決：改寫或刪除）。只有使用者在 U1 確認過的才算測試環境，其餘（含答「不確定」、無人值守）在第 2 題候選、自動檢查規則、寫進的檔案裡一律當正式環境；測試環境改成「位址不是這個測試環境時擋下」。第 7 題推薦過時文件時同時講哪裡過時。對使用者照實際問的順序連號，不用內部代號。
  - **Phase 4**：CLAUDE.md 骨架新增 §0「專案概要」（用途、外部系統正式／測試環境表——沒確認的放正式欄並註待確認、沒有外部系統寫「無」、業務流程與狀態、目前進度與日期、過時的文件）；`CONTEXT.md` 寫入 U3 確認的詞；`PROJECT.md`「環境與執行」寫使用者確認過的測試位址，沒確認的寫「當正式環境處理，不准連」；寫進檔案的位址帳密整段拿掉，只註設定來源名稱；過時文件在 04 必讀清單、CLAUDE.md 路由表、五支 agent 的開工前必讀都加註；04 實作與測試的必讀清單第一項是專案概要，qa-engineer 骨架同步。業務流程不放 `FLOWS.md`（它只收踩過坑的跨模組鏈路）。
  - **專案概要的維護**：§0 的流程狀態與進度是黃區（依程式碼更新、當次講明），正式／測試分類是紅區（只有使用者能改，程式碼跟表不符時照正式處理並問人）。知識協議範本「制度檔不記實作進度與計數」加上 §0 的明文例外，並指定更新責任：04 加「收尾更新專案概要」，健檢加「§0 日期超過 30 天就對程式碼重查」；「CLAUDE.md 超過 80 行」的健檢不計 §0。
  - **Phase 5** 靜態驗收加第十一項：§0 四塊都在且與使用者改過的版本逐句一致；`CONTEXT.md` 新增數＝U3 確認數；U1 每個系統都有去向（正式與未確認的在第 2 題候選、測試的有放行清單規則）；CLAUDE.md 與 PROJECT.md 沒有帳密；過時文件的加註都在。參考模式的知識筆記對帳統一為「新檔＝原有＋U3 新增－U3 裁決刪除，原有逐條找得到」（Phase 4、第十一項、參考模式那一項三處）。
  - **Phase 6 流程圖**：完整性檢查只保證每個變動檔是節點且至少有一條線，CLAUDE.md 原本只有「開始對話 → 讀」一條就能過，新流程的用途畫不出來。圖二改為要畫 CLAUDE.md → 開始對話（開對話就載入）、→ 先確認需求（讀：專案概要）、→ 交代工作（列進必讀清單），CONTEXT.md 只畫骨架有列它的 agent，PROJECT.md 的測試環境位址寫在節點小字；收尾更新專案概要的寫入線畫在圖一新增的「收尾時更新的文件」泳道——圖二加這條線連試 5 種版面都有交叉。`example-flow-1.json`、`example-flow-2.json` 同步更新，archify `validate --quality showcase`、`deliver`、`visual-check` 通過（只有允許的往下捲），截圖確認。harness README 的讀取線從「先確認需求」改到「開始對話」，與開 session 時的提醒一致。
  - 無人值守：概要照草稿寫入但標「未經使用者確認」，候選詞不寫進 `CONTEXT.md`、列在收尾回報等確認。
  - `hook-catalog.md` 的資料庫登入檢查與 `guard-risky-command.js` 的填空說明改成放行清單：只放使用者確認過的測試主機，其餘一律擋（原本只擋認得出的正式主機，會放過沒被認出來的）。

### 驗證
- 派一個只讀的 agent 在一個真實專案照新段落執行，禁止它讀上次安裝產生的 CLAUDE.md、知識筆記、`.claude/`：只靠文件與程式碼推出用途、3 個外部系統（其中 1 個是人工上傳檔案）、9 條流程中 6 條已實作 3 條還沒做、README 進度過時，並產出三題與第 7 題的問法。它回報的三個指示問題已修：範例原本用了該專案的真實內容（系統名、行號、測試數，會讓執行者抄到巧合的正確答案），改成虛構資料；不走網路的系統記「不適用」、不拿去問；流程狀態加「部分實作」。
- Codex 與 code-reviewer 兩道審查跑了多輪，修掉的主要類型：知識筆記條目數三處互相矛盾、程式碼可能覆蓋使用者確認的環境分類、帳密要到寫檔才處理、知識協議禁止制度檔寫進度與新設計衝突、QA 讀不到專案概要、流程圖要求的讀取比實際規定的多。
- 第六輪另修：重裝時「知識條目原樣保留」加上 U3 裁決改寫或刪除的例外；收尾回報「專案專屬檢查腳本、事故規則全部沒有」改成照實寫（參考模式沿用的要列出）。第五輪另修：使用者不要任何新候選詞時，原條目照常搬（被裁決刪除的除外），搬完一條都沒有才留示範（U3 表格與 CONTEXT.md 骨架原本各寫一套）；收尾回報的知識筆記改成照實寫條目數，不再一律寫「空白範本」。hook 範本的主機與網址示範規則改成「沒確認的就擋」，定位是防 Claude 手滑、不是防刻意繞過的沙箱。原本是「主機名含 prod 才擋」；改成放行清單後，審查連續幾輪實測出新繞法（出現一個測試主機整條放行、scp 的 -J、`-o ProxyJump`／`HostName`、目的主機後接 `-o…`、位址加引號、`ssh.exe`、IPv6、`$HOST`、網址帳號段放測試主機名），根因是「列舉認得的主機位置再比對」寫法列不完。現在兩條都列出允許的完整形狀，其餘一律擋：ssh／scp／rsync 只准列出的選項、指令名可帶路徑、遠端主機在確認清單上，目的主機後第一個參數不准 `-` 開頭（OpenSSH 會當選項），sftp／ssh-copy-id／autossh／mosh 一律擋，`RSYNC_RSH=`／`GIT_SSH_COMMAND=`／`core.sshCommand` 也擋（`git -c core.sshCommand="…"` 值加引號時語法樹路徑看不到，列為已知極限），指令名加引號（PowerShell 的 `& "C:\Program Files\…\ssh.exe"`）、scp／rsync 目的地是變數也擋；刻意不開 matchQuoted，加引號的位址看不到就擋（`scp a.txt "staging-db:/tmp"` 也會被擋），commit 訊息提到 ssh 不觸發。curl／wget／iwr／irm 只有寫出確認過的測試網址或本機位址（localhost、127.0.0.1、`[::1]` 預設放行，QA 要打本機起的服務；改成失敗即擋的第一版漏了這點，連本機服務都擋）、沒有別的網址、沒有改連線目標或從檔案讀網址的選項（`--connect-to`、`--resolve`、`--proxy*`、`--socks*`、`--preproxy`、`-x` 代理、`--config`／`-K`、wget 的 `--execute`／`-e` 與 `--input-file`／`-i`）才放行；合併的短選項（`-sSx`、`-qe`、`-qi`）照樣判，PowerShell 的 `-Proxy` 也擋；引擎比對不分大小寫，所以 `-x` 後面接方法名（`-X POST`、`-XPOST`）不算，`-K`／`-e`／`-i` 後面接網址或別的選項（`curl -k https://…`、`curl -kL`、`curl -sSi`）不算，值直接黏著時只有看起來像檔名（`-Kprod.cfg`）才算，不寫 `https://` 的網址一律擋、帳號段有 `@` 也擋；開 matchQuoted；指令名出現在任何位置都觸發（曾改成只在「執行位置」觸發以避免誤擋 commit 訊息，結果 PowerShell 的 `$r = irm …`、`if (…) { iwr … }` 與正則路徑下的 `if curl …; then`、`watch curl` 全部漏擋），只有整行是 `git commit`／`gh pr`／`echo`／`Write-Host` 這類寫文字的指令開頭、又沒有串接別的指令（含 `( )`、`<( )`）時才放行；其他協定的網址（`ftp://`、`file://`）與 `-K -`／`-i -` 從標準輸入讀也擋。已知極限寫在範本檔頭（不寫進擋下訊息）：刻意改寫的指令名（`ss''h`、`$c`、alias、eval）、先 `export RSYNC_RSH` 再 rsync（語法樹路徑把 export 當環境事件，規則看不到）、ssh config 別名、curl 兩個網址其中一個不寫 `https://`、測試網址被伺服器轉址到別的主機（執行前看不到，屬測試伺服器的行為）、已有測試網址時另一個網址用變數寫；另有一項引擎本身的極限：正則路徑（沒裝解析器，或 PowerShell 指令帶 `./x.ps1` 而退回正則）會把 `echo`／`Write-Host` 整段當成「只是印字」不檢查，PowerShell 在裡面夾子運算式執行（`Write-Host (irm https://…)`）看不到；語法樹路徑會擋，Bash 的 `echo $(curl …)` 兩條路徑都會擋。要補得改 `executedText` 的正則路徑，另案處理。示範只涵蓋 ssh／scp／rsync（含同類工具）與 curl／wget／iwr／irm，git 遠端與程式裡的 HTTP 請求不在範圍內。兩條規則注入真的引擎，在語法樹與正則兩條路徑跑過兩位審查者實測出的全部寫法（Bash 與 PowerShell），全數符合；填空說明、`hook-catalog.md`、U1 改成同一寫法；`cases/guard-risky-command.json` 的示範規則同步換新並補上這些寫法的案例（probe-hooks 兩條路徑全過），兩個權杖案例的網址改成確認過的測試網址，讓它們只測權杖規則，填空說明的「正式主機的命名樣式」一併拿掉；CONTEXT.md 異動紀錄範本加「沿用原有 M 條」；CLAUDE.md §0 的維護規則從標題括號移到標題下方，依程式碼更新的日期寫法移進說明（原本寫在填空外面，會以字面 YYYY-MM-DD 留在實例裡）。
- 完整跑一次 `/harness:init` 的端到端實測還沒做。

## [0.4.0] - 2026-09-27

### Added
- **Phase 6 流程圖**（`skills/init/SKILL.md`）：收尾前用 archify 畫三張圖、組成同一頁 `.claude/harness/flow.html`，開在瀏覽器：①需求進來之後怎麼跑（主流程＋每一步被哪支自動檢查擋）②文件在哪一步被讀、被寫（規則文件的讀；知識筆記 CONTEXT.md、FLOWS.md、`tests/Project_Detail/` 的讀與寫分開畫）③背景自動執行與維護工具（開 session、resume、壓縮前後觸發哪支、讀寫什麼；健檢跑 probe-hooks）。三條硬規則：要畫的清單是 init 實際新增／修改／刪除的檔案（不寫死）、每個檔案都要是節點（卡片不算）、每個節點都要有標了關係的線。archify 以 `doctor` 的 exit code 判斷能不能用，沒裝先問、不自己裝，不裝就退回 Markdown 流程表。原因：使用者實測裝完後只拿到檔案清單，看不出每個東西在流程哪一步起作用。
- **流程圖完整性檢查** `skills/init/scripts/check-flow-diagram.js`：`snapshot` 在 Phase 0 動任何檔案前對目標目錄拍快照（每個檔的內容雜湊，存系統暫存目錄）；`check` 拿現況對比快照，列出 init 之後新增、修改、刪除的每個檔案，逐項確認是某張圖的節點 label（寫在卡片、線或 sublabel 不算），並檢查每個節點至少有一條線。排除 `.git/`、備份、流程圖本身、測試快取；`node_modules` 收成一項。用來補「模型畫圖、模型自己檢查」看不出漏畫的盲點。
  - 開發過程，使用者連續指出三次，每次都是判準錯：①初版判準是「名字出現在圖的 JSON 任何地方」，圖下卡片也算，於是 20 項只在卡片、沒畫在流程上也被放行（「不是說所有的檔案嗎」）②第二版改成只認節點，但要檢查的清單是寫死的幾個位置（`.claude/agents`、`.claude/hooks`、`tests/Project_Detail`…），init 動到其他檔就漏（「不應該寫死，要看有新增或更改的檔案」）→ 改成快照比對 ③節點齊了但沒有線，看不出知識筆記在哪一步被讀、被寫（「讀跟寫的流程也都沒有畫出來」）→ 加「每個節點都要有線」。
  - 實測（模擬一次安裝：卡丽斯韩国的副本拿掉 init 的檔 → 拍快照 → 放回、另改 `.gitignore`、留一個測試殘檔）：抓到新增 40、修改 1；`.gitignore` 與殘檔這兩個寫死清單不可能發現的都被抓出；原本就有、沒被改的 `.claude/settings.json` 不列入；三張圖合併通過；只給圖一抓出 30 項；舊的單張圖抓出 22 個沒有線的節點；沒拍快照時停下並說明補拍無效。
  - 全部關係畫進同一張圖時實測 29 處線交叉、64 處線共用通道、線穿過節點，無法閱讀，因此拆成三張；三張各自以 `--quality showcase` 通過（0 錯誤、0 警告），規定不准降成 `standard` 過關。
- `skills/init/scripts/flow-page.js`：把三張 archify 圖組成同一頁（只做外框，圖本身仍由 archify 產）。
- **交付前易讀性自檢** `skills/init/scripts/readability-check.js`＋`skills/init/plain-language-terms.json`：流程圖的全部文字（標題、泳道、節點小字、線上的字）與收尾回報（改為先寫成 `.claude/harness/install-report.md`）交付前都要過。規則依據是 deliver-report plugin 的 `references/document-readability.md`——它自己的機械閘只掃 `.docx`、且只在調用它的回合啟動，掃不到 init 的產出，所以在這裡跑它機器判得準的部分（編號連續、未定義代號、異動紀錄用語，異動用語直接讀它的 `banned-patterns.json`），加上內部用語表（SKILL「對使用者講話的寫法」的機械可讀版，另收流程圖實際被指出看不懂的詞：派工、欄位、對齊回合、主對話、快照、注回…）；判不準的幾條印出來要模型讀完規則全文後逐條自檢。找不到可用的 deliver-report（`installed_plugins.json` 沒有這個專案看得到的安裝紀錄，或 settings 停用）→ 跳過、exit 3，並在收尾回報提示安裝指令。原因：流程圖寫「派工缺欄位」，第一次用的人看不懂。
  - 實測：舊版三張圖掃出 26 處（含「派工缺欄位」），改寫後通過；自訂測試檔 5 處全抓到，反引號內、括號已說明的、檔名與 kebab-case 名稱不誤判；以空的家目錄模擬沒裝、以專案 settings 停用模擬停用，兩種都正確跳過並提示。實測中發現並修正一個誤判：英文詞原本不分大小寫，把檔名 `CONTEXT` 當成內部用語 context。
  - 同一標準自檢本 plugin 的 `README.md`：正文與檔案清單共改 39 處內部用語與代號（例：判斷矩陣的「A1-A8／B1-B23／C1-C9」改成「8 條何時停下換方法、23 條怎樣才算做完、9 條哪些動作要先問你」，條數以 `grep -c` 核對過）。
- 兩支檢查腳本的邊界修正（逐項以案例重現後才修）：編號檢查不再把程式碼框內的數字當清單、項目間的空行不再當成新清單；有連字號的內部用語（dry-run）原本在跳過 kebab-case 檔名時一起被跳過、永遠比不到；節點名稱比對加邊界，`foobar.js` 不再算涵蓋 `bar.js`；圖的 JSON 解析失敗或缺 nodes／edges 時直接報錯（原本被當成文字繼續比對）；指向不存在節點的線不再讓節點算「有線」、節點 id 重複或缺少會報出；nodes／edges（易讀性自檢另含泳道、卡片）裡有 null 不再當掉；落點不是目錄時拒絕；讀不到的檔案列出來而不是略過（原本會被誤報成刪除）；讀不到的目錄底下的檔、拍快照當下讀不到的檔，都列為「無法判斷」，不算新增或刪除；`node_modules` 內讀不到的也回報；沒有 id 的節點與兩端沒寫的線會被抓出（同一節點只列一次）；英文內部用語加字界，gateway 不再被當成 gate；`node_modules/` 這類彙總項底下有讀不到的，整項列為無法判斷；Markdown 程式碼框也認 `~~~` 與四個以上反引號，行首的行內程式碼（```npm ci```）不當成框；路徑只在 Windows 忽略大小寫。
- 完整性檢查加「同一張圖裡，同一個檔案只能有一個節點」：原本 SKILL 規定「同一支 agent 做兩步就畫兩個節點」，architect 併入 backend-engineer 的專案被畫成兩個 backend-engineer（一個寫設計、一個寫程式），使用者看成專案裡有後端架構師。改成每支 agent 一個節點，兩步用一來一回的線表示；以舊範例實測抓得到、新圖通過。
- 完整性檢查排除流程圖自己的產出時，原本只寫了單一檔名 `flow.json`，實際產出是 `flow-1.json`～`flow-3.html`，會被當成 init 新增的檔要求畫上圖；改用樣式排除，並一併排除 `install-report.md`（實測五個產出檔都被排除、其他檔照常列入）。
- `skills/init/references/example-flow-1.json`～`example-flow-3.json`：三張圖的結構範例，皆以 archify `validate --quality showcase` 驗過。
- **參考模式**：專案原本就有 Claude Code 設定（`CLAUDE.md`、`.claude/` 的 agents／hooks／commands／skills、有 hooks 或 permissions 的 settings，含之前裝過的 harness）時，Phase 0-2 不再停下：先整份備份到 `.harness-backup/<時間>/` 並比對 hash，Phase 1 新增第 12 項逐項讀原有設定（裡面的專案事實照樣當盤點證據，原有 hook 在擋的風險列入第 2、5 題），Phase 2 攤出「原有設定怎麼處理」對照表（沿用／併入／取代，使用者可改），Phase 3 新增第 0 題問原本哪裡不好用，後面的建議朝解決這些痛點調整。預設處置：專案事實與知識條目一律留下，流程與機制換成 harness 的，harness 沒有對應的 agent、hook、指令原樣沿用，不靜默刪任何東西。原因：使用者會在已有設定的專案重跑 init，代表他覺得原本的流程有問題，原本「已裝就停、既有設定讓位」等於把他想換掉的東西原樣留著。
- Phase 5 靜態驗收加第十項（參考模式）：備份一致、處置表逐列對帳、知識條目數新舊相等、原 CLAUDE.md 每條規則都有去向。

### Changed
- 收尾回報改成八段（參考模式九段），「之後一個需求進來會怎麼跑」與「裝了哪些東西」放最前面；第 2 段的項目數要和完整性檢查的結果一致；參考模式另交代備份位置、處置表最終版，以及第 0 題每個痛點這次怎麼處理（沒處理的照實說）。
- 「既有治理層讓位」只適用多工具共用的治理層（AGENTS.md、.agents/、.cursor/）；Claude Code 自己的設定改為參考來源（`adaptation-guide.md` §2、SKILL 核心原則第 4 條、裁切規則）。
- 知識筆記檔在參考模式下，原有的真實條目原樣搬進新結構。

## [0.3.3] - 2026-09-26

### Changed
- **init 對使用者說的話改成白話**（`skills/init/SKILL.md`）：新增「對使用者講話的寫法」一節，列出內部用語與對使用者的講法對照（熔斷→執行前一定要先問你的動作、hook→自動檢查、代決→我先替你決定的…），agent 名稱第一次出現附中文職稱，送出前照表自掃。原本訪談七題只寫給模型看的「問什麼」，模型只能拿內部詞組句，第一次用的人看不懂。
- 訪談七題各附一段可照講的問法，每題講清楚「選了之後會發生什麼」；第 5 題的自動檢查清單拿掉分類欄，第一欄改白話名稱、檔名放最後；結束時的回報整段改寫，指路一律用完整檔名加節名。
- 盤點回報開頭先用兩三句講結論，「有錯請直接指出」固定放在整則訊息最後一句。
- 生成進專案的 `harness/README.md` 骨架與 plugin `README.md` 的介紹、用法段改成白話。

### Fixed
- 驗收數量寫錯：SKILL 與 README 寫「靜態五條＋冷啟探針四項」，實際是靜態九項、開新 session 實測五項（README 漏列「危險指令檢查有沒有接上」那項）。
- 第 5 題範例的不裝理由改成真的會因專案條件而不裝的項目（原範例那支在任何專案都不會裝，理由寫的卻是專案條件）。

## [0.3.2] - 2026-09-26

### Fixed
- **殼包裝判定補齊 PowerShell 旗標縮寫**（`shell-model.js`，以及 `guard-risky-command.js`、`guard-test-preconditions.js` 的正則路徑）：pwsh／powershell 認任何合法前綴縮寫的啟動旗標，原本只收一部分，`pwsh -wo C:/x -c "git push"` 這類寫法的內層指令整個看不到。補上會吃值的 `-wo`～`-workin`（WorkingDirectory）、`-of`、`-if`、`-to`（Token）、`-utc`（UTCTimestamp）、`-ea`／`-encodeda…`（EncodedArguments），以及會帶指令的 `-cwa`／`-commandwithargs`；`-encodeda` 起不再誤認成 `-EncodedCommand`；pwsh 的 `-in` 與 `-i` 一樣是 Interactive、不吃值。判準以 pwsh 7.6.6 與 Windows PowerShell 5.1 實跑、pwsh 原始碼 `CommandLineParameterParser.cs` 為準。
- **Start-Process 參數照 PowerShell 參數繫結認縮寫**：原本只認 `-wo`、`-wi` 與完整名稱，`-work`、`-win`、`-cred`、`-en`、`-errora…` 等會吃值的縮寫被當成不吃值，後面的值被誤認成要執行的程式（`Start-Process -work app npm test` 原本不會觸發測試前置條件檢查）。
- 管線把字串餵給 powershell 時，判斷「有沒有指定 -Command／-File」改用同一組旗標判準（原本只認幾種完整寫法）。
- cases 新增兩向案例 16 條：`guard-risky-command` 14 條、`guard-test-preconditions` 2 條。

## [0.3.1] - 2026-09-25

### Changed（壓縮交接跟上來源實例）
- **交接信改九節**（`compact-handoff.js`）：未完成、目標版本（中途改目標時 v1／v2 各引原話並註明作廢步驟）、硬約束（使用者原話）、關鍵值（原樣）、走過的死路、HYPOTHESIS／已推翻、已完成、偏好、建議 skill；禁推論句（「使用者傾向…」）、禁簡體字形（語言規則收進填空區 `LANGUAGE_RULE`）。
- **關鍵值清單**：對話骨架只收助理的文字，工具回傳的測試數字、錯誤行、exit code、commit、PR／票號到不了交接信。改由程式從工具回傳抽原值交給模型，信寫完用字串比對驗「自稱抄入的是否原樣出現」，非原樣再分兩類：`keysMangled`（去掉空白、標點、符號後找得到＝改寫過）、`keysMissing`（完全找不到＝自稱抄了其實沒寫進信）；寬鬆比對保留各種文字的字母與數字（原本只留英數與漢字，希臘字母、全形數字會被刪光而誤判成改寫；審查抓到，來源實例同步修正）；讀檔類工具（Read、Grep、`cat`／`sed -n` 讀檔）的回傳不抽，避免把程式字面或舊交接信的數字當成這輪結果。
- **子 session 改 `--effort low`、逾時 180→220 秒**：預設 effort 下思考 token 佔輸出八成且每次差很多，同一份輸入 183～245 秒、常撞逾時；low 實測長對話 59～71 秒、思考 0，來源實例三輪評估中 low 那輪 4 封全數產生、零逾時，評審分數未變差（收進填空區 `EFFORT`）。逾時上限同步放寬到 220 秒，PreCompact 接線 timeout 240 秒，差距留給快照寫檔，兩者在填空區註明要一起調。
- **⚠ 自我回報的統計只能參考**：effort low 下模型在信末「已處理：」「關鍵值：」兩行的自我回報不可靠（來源實例一次自稱抄 16 筆、12 筆不在信裡），流水帳的 `asksOpen`／`keysClaimed`／`keysMissing` 只能當參考。`keysMangled` 列出的每一筆都經程式比對信文確認是改寫，但只檢查模型自稱抄入的那幾筆，空陣列不代表信裡沒有改寫過的值。
- **注入上限的出處**：平台對 hook 純文字輸出的 10,000 字元上限來自 claude.exe 內的常數（2.1.282 為 `SRo=1e4`，以字元數比，超過只留 2,000 字預覽，改用 JSON `additionalContext` 也一樣）；`compact-reinject.js` 註明升級後可用 `grep -a -o "SRo=[^,;]*" claude.exe` 複查。
- **注入超長時先截「已完成」節**（`compact-reinject.js`）：原本從信尾截，排在後面的節會先被砍；改為先壓「已完成」節內文，仍不夠才整段截斷。
- **流水帳加 `missingInHandoff`**（`compact-summary-log.js`）：同一份快照對交接信再比一次，量交接信有沒有補上內建摘要漏掉的項目。
- **快照認得三種背景任務**（`compact-snapshot.js`）：原本只認 Agent。現在另認 `run_in_background` 的 Bash／PowerShell（以 task-notification 判完成）、具名 agent 的「Spawned successfully. agent_id: 名稱@…」（逐則 teammate-message 看 idle_notification 判完成，被 SendMessage 叫醒就改回執行中），以及剛派出、還沒有 tool_result 就被壓縮打斷的呼叫；清單上限 10 筆。走交接信路徑時，`compact-reinject.js` 把這份由程式算出的清單附在信後，不靠寫信模型記得。
- **關鍵值防污染**：讀這組 hook 自己的快照、流水帳、交接信、摘要與 Claude Code transcript 目錄的工具輸出不抽（那是別的 session 的數字）；值前面緊接引號的不抽（被印出來的字串）；測試數字所在行夾中文的不抽（人寫的敘述）；抄進信時不得替數值推測用途。另補：裸 `Error: ENOENT` 這類無前綴錯誤行會抽、msbuild 行尾的 `[*.csproj]` 剝掉、HTTP 只收 `status`／`statusCode` 的 3 位數，後面不得再接數字（否則 `"status":2000` 會被截成 200 抽入，審查抓到、來源實例同步修正；`"code":"0000"` 是業務回傳碼，不抽）。
- **短值比對只放寬空白與大小寫**：去標點後不到 12 字元的值（`Exit code 2`、`HTTP/1.1 404`）在整封信裡容易碰巧拼出同一串，不走寬鬆比對，避免把缺漏誤判成改寫。
- **真人輸入判定共用一份**：抽成 `compact-handoff.js` 匯出的 `isHumanPrompt`，快照與 resume 提醒共用（各寫一份時曾三處不一致）。載入 `compact-handoff.js` 失敗時：快照退回最小判準照樣寫出（它正是交接信失敗時的退路）、resume 提醒直接不出聲。
- **交接信上限 6000→7500 字**：來源實例實際信長 4.5k～7.1k，注入預算約 9,370 字；「硬約束」標題下加一行「只列使用者親口說的，CLAUDE.md、memory 條文不列」（只寫在原則第 7 條時沒生效，樣本數 1）。
- **時區收進填空區**：關鍵值標注的時間與 resume 提醒的最後活動時間，原本寫死台北 +8 與「台北時間」字樣，改為 `TZ_OFFSET_HOURS`／`TZ_LABEL`（兩支各一份，預設不變）。

### Added
- **02 骨架補「主對話成本與壓縮交接」條**（`skeleton-02-model-dispatch.md` §1）：主對話的成本主要在長 session 的超長 context，任務告一段落就開新 session 或 `/compact`；裝了壓縮交接 hook 時再說明五支各自做什麼、壓縮後第一個回覆先交代交接信「未完成」第 1 項、交接信的「已完成」類主張行動前先對回原始證據、hook 輸出注入的字元上限。Q5 取消這組 hook 時只留前面的成本原則。
- **05 骨架健檢加「環境層」**（`skeleton-05-knowledge-protocol.md` §5）：查失效時不會擋下任何動作、只留下容易被忽略的 hook error 通知或退回較陽春做法的項目——settings 裡每條 hook 指向的檔是否存在、事件與 matcher 是否和檔頭接線一致、`node` 能否執行；裝了壓縮交接 hook 時另查流水帳的 `handoff.ok`（交接信是否真的寫出來、失敗原因）與 PreCompact timeout 是否大於 `CHILD_TIMEOUT`。語法解析器有沒有載入已由既有的機械閘那項涵蓋，不重複。
- `hooks/templates/resume-stale-reminder.js`（SessionStart matcher `resume`，併入形狀目錄第 26 列）：距上次活動超過 `STALE_HOURS`（預設 4）才 resume 時，提醒服務狀態、背景 agent、DB 與 git、測試數字都可能已過期，附最近一封交接信路徑與使用者最後一則指示原文。壓縮有交接信補位，resume 沒有——context 原封不動回來，模型會把暫停當下的說法當成現況。

### Fixed（審查抓到，來源實例同步修正）
- **多行讀檔指令誤判**：判斷「這個 shell 指令只是讀檔」的樣式允許換行，`cat notes.md` 換行接 `pytest` 會被整段當成讀檔，後段真的測試結果抽不進關鍵值；換行改為等同接下一道指令。
- **resume 提醒把最新指示換成舊句**：原本排除「最近 60 秒內」的紀錄，以免 resume 自己寫入的紀錄被當成活動；但 resume 當下寫入的只有 queue-operation 與 hook 輸出的 attachment（來源實例以 `-p --resume` 實測），本來就被「只看 user／assistant」擋掉，這層排除唯一的效果是：暫停前 60 秒內才講的話被略過，提醒誤報過期，「最後一則指示」還顯示更早的舊句。已移除。HYPOTHESIS：互動模式 resume 是否會在 hook 之前先寫 user／assistant 紀錄未實測；若會，最壞結果是該次不出提醒。
- **resume 提醒的活動時間不算系統注入紀錄**：「最後一則指示」排除了 isMeta 的 user 紀錄，「最後活動時間」卻沒排除，兩邊不對稱；拿掉 60 秒排除之後，萬一 resume 日後改成寫 isMeta 的 user 紀錄，活動時間會被刷成現在，提醒永久靜默。活動時間改為同樣排除 isMeta。

### 驗證
- 範本以來源實例最終定版（`compact-handoff.js` c75a7d71c4bc、`compact-snapshot.js` 77696660b078、`compact-reinject.js` 549347c290cc、`compact-summary-log.js` d03464ae3d22、`resume-stale-reminder.js` 6124eacbbd22）為邏輯正本、由腳本重新產生，程式化逐行比對：非註解差異只剩填空區常數（含時區）、通用 `DOC_RE`／`NOISE_RE`、`COMPACT_HANDOFF_OFF` 分支。
- probe：語法樹路徑 482/482；正則路徑 439 通過、43 略過（含 resume-stale-reminder 新增 4 條）。
- 整合測試（開發時以臨時腳本實跑，未收進 repo）：逐項驗過上方各條行為——關鍵值抽取與讀檔排除、多行指令、先截「已完成」節、`missingInHandoff`、resume 提醒的各種時間情境與 isMeta、三種背景任務與完成判定、交接信路徑附背景清單、關鍵值防污染、裸 `Error:`、msbuild 剝除、HTTP 狀態碼邊界、短值比對、`compact-handoff.js` 壞掉時的退路。以前一版範本為對照組時，新行為的斷言大多失敗（少數斷言在舊版本來就會通過）；審查途中修正的項目（多行指令、30 秒前才活動、isMeta、HTTP 狀態碼邊界、寬鬆比對）另各以修正前的版本確認對應斷言會失敗，證明測試抓得到差異；0.3.0 既有行為無退步。具名 agent 的 teammate-message 原始格式另以其他 session 的真實 transcript 核對。真呼叫 `claude -p`（預設 effort 與 effort low 各一次）：九節齊全、關鍵值原樣抄入、「已處理：」「關鍵值：」統計行已移除。
- `keysMangled`／`keysMissing` 的分類：真呼叫那次關鍵值都原樣抄入，分類沒被觸發；改把範本實際的分類程式抽出來對假資料實跑——原樣、只改標點（判改寫）、希臘字母或全形數字不同（判缺漏）各自歸位。未實測：模型真的改寫或漏抄時的分類。

## [0.3.0] - 2026-09-23

### Fixed（冷啟實測抓到）
- **指令名稱**：skill 目錄從 `skills/harness-init/` 改名為 `skills/init/`。plugin 的指令名由 skill 的**目錄名**決定（frontmatter 的 `name` 不影響，兩者都實測過），所以自 0.1.0 起實際註冊的指令一直是 `/harness:harness-init`，而文件全部寫 `/harness:init`——照文件打的人打不開。連帶更新 9 處路徑引用，其中 `hooks/wordlist-sweep.js` 的路徑正則與 `path.join` 兩處若漏改，這支閘會永遠比不中而靜默放行。
- **`/harness:review` 被寫成現成指令**：該指令尚未提供，3 處敘述（init Phase 0 的建議動作、會被複製進使用者專案的 05 骨架、adaptation-guide 標題）改標「規劃中、尚未提供」。
- **冷啟驗收**（兩輪，皆對全新沙盒專案以 `--plugin-dir` 載入本版實跑 `/harness:init` 全流程）：
  - 第一輪（可執行層仍是 4 支固定範本時）抓到指令名稱、C 軌 agent、PowerShell 旁路三個問題，並暴露可執行層只從菜單挑的根本問題——沙盒裡被掃到的寄信、TRUNCATE、部署全都只停在文字熔斷清單。
  - 第二輪（形狀目錄推導後）：沙盒含高權帳號連線字串、正式庫主機、對正式機 ssh 的部署腳本、會 TRUNCATE 的管理端點、真實 SMTP 主機、寫死 production 的啟動指令與本機覆寫清單。init 推導出 14 支 hook、13 條 B 類規則（每條都對得到盤點證據），本機覆寫三件組因偵測到覆寫清單而裝上、多工作樹那支正確地不裝；實例內探針全數通過；冷啟探針 P1、P2、P3、P5 在新 session 通過（P5 的 13 條無害觸發指令全數被擋，含 PowerShell），P4 因目標目錄未啟用 git-commit 不適用；裝完的沉澱閘在同一個 session 就擋下收尾、逼答四題。
  - 第二輪抓到並已修：規則引擎把「傳給一般程式的引號字串」也當成執行（commit 描述提到 `deploy.sh` 會被擋）；不認 `node --env-file`；環境檔相對路徑沒跟同一條指令前面的 `cd` 走；前置條件檢查不分子專案（新增 `when`）；SKILL 的 P1／P2 探針 prompt 會先撞上派工紀律閘而蓋掉要驗的訊息；Q5 推導清單在有預先答案時沒先印出。修後範本探針 189/189；並把第二輪實例實際產出的 11 條 RULES／2 條 CHECKS 搬進修好的引擎交叉驗證：該擋的全擋、冷啟實際踩到的誤擋全部放行。
  - 擋下訊息逐條審閱（第二輪實例的 13 條）：格式與「為什麼」都對得到專案實物，10 條可照抄的放行方式餵回閘全數放行；但有 5 條會誤導——放行方式裡寫出引擎盲點（等於教人繞）、照做過得了閘卻跑不起來（repo 根沒有 package.json）、要模型把連線字串貼進指令列、指向沒裝的 skill、沿用別專案的錯誤理由（高權帳號寫成「密碼錯會被鎖」）。後兩者的源頭是範本示範規則，已改；SKILL.md 新增「B 類規則的訊息怎麼寫」六條與 Phase 5 驗收「照放行方式做：餵回閘必須放行、可實跑的要實跑」；前置條件閘結尾的「重啟跑中服務」改為只在設定檔類檢查不符時出現。
- **規則引擎的「會不會執行」與「環境值」跟真實 shell 不一致**（審查抓到，實跑重現）：`guard-risky-command` 的 `when`／`unless` 與環境取值、`guard-test-preconditions` 的環境取值原本都看整串指令的字面，於是別條指令能替這條背書——`kubectl apply -f prod.yaml; kubectl apply --dry-run …` 由第二條的 `--dry-run` 放行、`NODE_ENV=production node server.js; NODE_ENV=test true` 由後段賦值放行；環境值也不分 shell 變數與匯出變數、不認 `unset`／`env -u`／子殼範圍。先以正則逐項補了十三輪審查，每輪都再被掃出同類寫法（子殼、條件執行、命令替換先後、包裝指令的內層……），字面比對在結構上收斂不了，改為**用語法解析器判**：
  - **語法樹路徑（預設）**：新增 `hooks/templates/shell-model.js`，以 tree-sitter（`tree-sitter`、`tree-sitter-bash`、`tree-sitter-powershell`，版本由 `package.json`／lock 檔釘住，皆 MIT、附六個平台的預編譯檔）把指令解析成語法樹，照 shell 語意建出「每個會執行的指令」與「每個指令實際拿到的環境值」：`export`／`declare -x`／`set -a` 才傳給子程序、`unset`／`export -n`／`env -u`／`env -i` 讓它消失；`( … )`、`$( … )`、管線元素是 fork 子殼（繼承全部變數、設定不回到外層），`bash -c`、find -exec、xargs 是新程序（只繼承匯出的）；`&&`／`||`／if／迴圈是條件區域；殼包裝（bash -c 一個詞、`cmd /c` 與 `powershell -Command` 取整串）、heredoc（由 shell 開啟的主體當指令、其他程式開啟的主體併進它的比對文字）、`cmd /c` 脈絡的 `set X=v`、`node --env-file`（不覆蓋已存在的變數、只認寫在腳本名之前的）、`cd` 的目錄追蹤都依語法樹。`when` 逐條管線比對、`unless` 只看命中的那個指令、`requireEnv` 對命中的每個指令各自取值。兩支引擎共用這一份模組。
  - **正則路徑（退回）**：解析器沒裝、載入失敗、設 `HARNESS_SHELL_PARSER=off`，或語法樹有錯誤節點時整串改走原本的正則判法（十三輪修正都保留在這條路徑）。錯誤節點不一定是指令寫壞：PowerShell 文法把合法的 `./deploy.ps1`、`--dry-run=client`、單獨的 `--` 都解析成錯誤節點，實測常見 PowerShell 寫法中有一部分會走退回；原本「有錯誤節點照樣分析」的設計會讓 `./deploy.ps1 -Force` 一個指令都認不出來而放行，已改為退回。
  - **語法樹路徑的兩條保守原則**（雙軌審查抓到語法樹路徑在幾類寫法比正則路徑還漏，按類修，不逐點補）：
    - **沒建模的位置不准消失**：走訪完再用不同判準兜底掃一次——語法樹上每個指令節點都必須已收進執行清單，沒收到的一律補收成「會執行」。函式本體一律當成會執行（`deploy() { kubectl apply …; }; deploy`）；重導向目標裡的命令替換與行程替換（`> "$(…)"`、`< <(…)`）、here-string（`psql <<< "DROP …"`、`bash <<< '…'`）、echo／printf／heredoc 經管線餵給殼的腳本（`printf 'git push\n' | sh`，printf 與 `echo -e` 的跳脫序列先展開）都建模；PowerShell 管線裡的字串元素（`'TRUNCATE orders' | psql`、`"git push" | bash`）接給下一個指令當輸入或腳本。
    - **可能發生過的設定要讓值判成無法確認，不能忽略**：條件區段（if／&&／||／迴圈／case）與函式本體裡的 export、unset、set -a、cd、source 原本一律略過，把正確值改壞的寫法（`[ -f x ] && export APP_ENV=production`、`&& unset X || true`）因此會放行；改為判成無法確認而擋，訊息寫明原因。`a || b && c` 照 bash 的左結合處理（c 執行時 b 不一定跑過）；函式本體裡的設定發生在呼叫的時候，後面再確定的設定也消不掉這份不確定。
    - **可能值集合**（第十五輪審查後）：「判成無法確認」對常見寫法太嚴（`[ -f .env ] && source .env; npm start` 在 .env 與繼承值都正確時也擋），改為把環境值算成「全部可能值」——條件區段裡的設定讓狀態一分為二（有發生／沒發生），每一個可能值都符合才放行，會把正確值改壞的照擋；同名展開 `${X:-預設}`、`${X}` 照實際值展開。迴圈體後段的設定當成也可能落在前段指令之前（`for …; do npm start; export X=production; done` 第二輪拿到 production）。read、mapfile、getopts、printf -v、let、`for X in`、`declare -n`、非字面來源的 source、含展開的 eval 這些會寫進變數卻沒逐一建模的寫法，讓該變數判成無法確認；字面的 `eval "…"` 照內層指令解析。printf 餵給殼的腳本照格式字串代入引數（`printf 'kubectl %s -f prod.yaml\n' apply | sh`）。trap、su -c、script -c、watch 的內層也拆出來判。
    - 第十六輪審查後再修：變數名加引號（`unset "X"`、`export 'X'=v`、`export "X=v"`）的寫入原本整條被忽略，改為 export／declare／local／readonly／typeset／unset 一律取引數實際值再判；進入新程序時父指令的前綴在外層殼展開（`X=prod; X=${X:-local} bash -c …` 帶進去的是 prod）；已拆出內層的 eval 那一行不再拿設定前的環境重判；source 進來的檔案裡的條件式寫入與巢狀 source 判成無法確認；指令名本身是展開（`c=unset; $c X`）時引數裡的變數名判成無法確認。「看不到內容」（eval 展開、source <(…)、read…）造成的擋下另寫訊息，建議在那條指令前面直接帶字面值（`eval "$(fnm env)"; APP_ENV=local npm start` 放行）。
    - 第十七輪審查後再修：「不確定」原本是一個旗標，指令自己帶前綴就清掉——但 `APP_ENV="$APP_ENV" npm start` 這種引用同名變數的前綴，會拿看不到內容的寫入**之前**的舊值展開而放行錯值；反過來，父指令的字面前綴（`APP_ENV=local bash -c …`）已把值帶死卻仍擋。改為讓「未知」本身成為一種值：看不到內容的寫入把值設成未知，同名展開遇到未知結果仍是未知，只有字面值能蓋掉它，最後任一可能值是未知就判無法確認。read、mapfile、getopts、printf -v 的變數名是展開時（`read "$n"`）判全部變數無法確認。
    - 第十八輪審查後再修：
      - **值的表示**：值在建事件時就轉成字串，分不出 `'$X'`（字面）與 `"$X"`（展開）：`APP_ENV='$APP_ENV' npm start` 被當成同名展開而判成 local；`env X="$X"` 的值沒展開，被當成非空字面而通過「只要存在」的檢查。改為建事件時分三種——字面值、同名展開（算值時照當下的值展開，env／sudo 的值也是）、其他展開（一律未知）——套到一般賦值、前綴、env／sudo 的 X=v、export／declare 系列、`command export`、cmd 的 `set X=%Y%`。
      - **Git Bash 的 `cmd //c`**：MSYS 會把 `/c` 當成路徑轉掉，`cmd /c "…"` 在 Git Bash 上其實不執行內層，實際會執行的是 `cmd //c "…"`——兩支引擎、shell-model、guard-local-hack-destroy 原本都只認單斜線，於是攔下不會執行的寫法、放行真的會執行的寫法（`cmd //c "git push"` 兩條路徑都放行）。改為一或兩個斜線都認。
      - **殼包裝的旗標依殼的種類找**（第十九輪審查後）：原本取「第一個以 c 結尾的旗標」，PowerShell 的 `-exec`（-ExecutionPolicy 縮寫）會先被命中，`powershell -exec bypass -c "git push"` 兩條路徑都整條放行；`-Command` 的縮寫（`-C`、`-Com`、`-comm`、`//Command`）也不認。改為 bash 系認 `-c`（可合寫 -lc、-ec，大小寫有別）、cmd 認 `/c`、`/k`（一或兩個斜線、前面可有其他旗標）、PowerShell 認 -Command 任何前綴縮寫與 `-EncodedCommand`（base64 解碼後判內層），powershell.exe 不帶旗標時第一個位置引數就是指令——以上以真 PowerShell 5.1 實跑確認。兩條路徑都只在殼名後面連續的旗標區裡找（bash 的 `-o`／`-O`、PowerShell 的 ExecutionPolicy／WindowStyle／Version／InputFormat／OutputFormat 等會吃值的旗標認完整前綴縮寫並跳過其值；下一個詞是旗標就不當值；pwsh 的 `-i` 是 -Interactive、不吃值），碰到腳本名就停——腳本名之後的 `-c` 是腳本自己的參數（`bash release.sh -check …`、`powershell -File x.ps1 -c …`）。guard-local-hack-destroy 的包裝辨識同步改寫：殼名與執行旗標之間只能是其他旗標，各可帶一個值（值可以是路徑或含空白的引號字串：`bash --rcfile /dev/null -c`、`pwsh -WorkingDirectory "C:\my repo" -Command`），殼名後面直接是腳本名就不算包裝（`bash run.sh -c …` 的 -c 是腳本參數）；取捨是旗標後面的腳本路徑也會被當成值而多擋（`bash -x run.sh -c …`）——這支守的是會銷毀本機改動的 git 指令，漏擋的代價遠大於多擋。別的變數的展開判「有沒有被這串指令碰過」時，連同任何指令的前綴與 env 選項一起算（`NODE_ENV=production APP_ENV=${NODE_ENV:-local} cmd` 擋）。另修：多個前綴由左到右依序展開（`X=prod X="$X" cmd` 帶的是 prod）；`X[i]=v` 判成無法確認；`X+=v` 串接；`$'…'` 解碼；別的變數沒被這串指令碰過時照繼承值展開（`${NODE_ENV:-local}` 不再誤擋）。
      - source 檔內照原本順序逐一套用（檔內後面的字面寫入蓋得掉前面看不到內容的寫入）；PowerShell 的 iex／Invoke-Expression 引數不是字面字串、或 `[scriptblock]::Create(…)` 時，所有環境變數判成無法確認（真 PowerShell 5.1 實測 `iex (Get-Content set.ps1 -Raw)` 會改值）。
    - 另外照真實語意修正：`X=v env -u X cmd` 前綴先進 env 的環境再被拿掉；`sudo X=v cmd` 的賦值是那個指令的環境；`set -a` 不被新的 bash 程序繼承；`! unset`、`builtin unset`、`command export`、`declare +x` 這類變形照引數補發設定事件；find／xargs 那一行不再拿外層環境判它叫起的指令；PowerShell 文法沒載入時包在 Bash 裡的 powershell 內層改為整串退回正則路徑（原本靜默丟掉）。
  - **PowerShell 環境變數寫法從嚴**：真 PowerShell 對照抓到兩條路徑都會漏擋的一類——繼承值原本正確，指令用模擬不了的寫法把它改壞（`Set-Item Env:X`、`Clear-Item`、`Remove-Item Env:\X`／`Env:/X`、別名 `ri`、`New-Item -Path Env: -Name X`、`gci Env:X | Remove-Item`、`${env:X}`、`[Environment]::SetEnvironmentVariable`、`+=`、大小寫不同的名字、寫在 `{ }` 或 if 裡），逐條模擬會照舊值放行。改為只認「最外層、名字大小寫一致、字面值的 `$env:X = '…'`」（`$Env:` 前綴不分大小寫），同一串裡這個變數出現過其他寫法就判成值無法確認而擋下；Env: 磁碟機被變數語法以外的方式碰到時，所有環境變數一律判成無法確認。從 Bash 叫起的 PowerShell 內層，擋下訊息改為提示在 bash 這一側帶值。
  - **驗證**：以被執行就留下標記的假指令、印出實際環境值的假程式，交給真 Git Bash 與真 Windows PowerShell 5.1 執行，與 hook 判定逐條對照（對照腳本為開發時的臨時腳本，未收進 repo；其中一部分寫法已沉澱成 `cases/` 由 `probe-hooks.js` 跑）。範圍涵蓋兩支規則引擎的「會不會執行」與環境取值、`node --env-file`、PowerShell 的會不會執行與環境值、雙軌審查點名的寫法與其同類寫法、審查者另以真 Bash 整理的對照組（條件分支、迴圈、引號與拼接變數名、同名展開、source 檔內結構、未知值的傳遞路徑、值的表示法邊界、殼包裝旗標），以及殼包裝旗標在真 PowerShell 的實際行為。語法樹路徑漏擋 0；多擋的寫法都屬刻意保守（只定義不呼叫的函式、函式本體內指令的環境值、沒有繼承值時的條件式 source、`a && export … || export …` 兩支都設同值、`eval "$(…)"` 之後不帶值直接起服務、值來自別的變數）。另以審查者整理的日常寫法實跑（`npm ci && npm start`、`cd api && npm start`、`[ -f .env ] && source .env; npm test`、`export APP_ENV=${APP_ENV:-local}`、`source .venv/bin/activate && npm start`、`trap 'kill $(jobs -p)' EXIT` 等），語法樹路徑只擋 `eval "$(…)"`／`source <(…)` 接起服務這類，訊息會給可照做的帶值寫法。未一致的全數歸類過：對照組本身的限制（本機無 sudo、假測試執行器不分 `--help`、目標程式根本沒被執行）、刻意的保守多擋（條件與函式本體裡的指令一律當成會執行、可能發生過的設定判成無法確認、PowerShell 非字面寫法判成無法確認），以及看不到腳本檔內容（`bash run.sh`）。正則路徑對同批寫法有漏擋，都是它不建模的寫法，列入檔頭 [正則] 極限。
  - 另修：`within` 截不到區塊時改為照不符擋下（原本退回整份檔，別的區塊的值會替它通過）；前置條件閘認 npm 系在 test 前帶選項（`npm --prefix api test`、`pnpm -C api test`、`yarn workspace api test`）與 Windows 的 `pytest.exe`／`vitest.cmd`；示範規則的路徑樣式補認 Windows 反斜線（原本漏掉 `.\deploy.ps1`，SKILL 加一句提醒）；`wordlist-sweep.js` 改以 `execFileSync` 參數陣列傳檔名（原本把檔名插進 shell 字串，POSIX 上檔名含 `$(…)` 會被執行；Windows 的 cmd.exe 不展開、未受影響）。
  - 範本案例補到 478 條（含壓縮交接三支的 12 條）：`probe-hooks.js`（語法樹路徑）478/478；`probe-hooks.js --parser=off`（正則路徑）435 條全過、43 條標 `"parser": "only"`（正則路徑的已知極限）略過並計數。探針開頭會印出本輪實際走哪條路徑，解析器沒裝齊時標警告，不再靜默全綠（探針的 setup.env 值給 null＝變數不存在、"" 是存在但為空，原本拿 "" 表示未設定的 123 處已改正）。每批新增案例都以修正前版本對照確認會失敗（後六批 31 條中 29 條、20 條中 17 條、13 條中 11 條、7 條中 5 條、18 條中 10 條、18 條中 14 條在修正前失敗，其餘是防退步用的反例）。延遲：兩條路徑中位數都約 40ms、最大約 140ms（原生解析器；曾評估的 WASM 版在本機約半數指令多出 ~400ms 結束延遲而不採用）。
- **探針把 hook 崩潰當成放行**：`probe-hooks.js` 原本只分「擋／不擋」，hook 拋例外、逾時、非 0／2 結束都算放行，期望 ALLOW 的案例會假性通過。改為 exit 0／2 以外一律判 CRASH；刻意以其他碼結束的 CLI 腳本在案例寫 `"exit": <碼>` 宣告。
- `guard-test-preconditions` 的 `when` 維持比對整串指令（要看得到前面的 `cd api`），同一串跑兩個子專案測試時可能多擋——寫進檔頭已知極限。

### Changed
- **定位從「空骨架產生器」改為「開發流程制度安裝器」**。0.2.0 只產 6 份填空 md、零可執行物。紅藍對抗對 0.2.0 的 CRITICAL 判定三條：
  1. **規則生效整個交給模型自覺**：引擎把「怎麼確保規則真的生效」交給模型自己守，而它收錄的每一條事故都在說自覺不夠——skill 的「必須」是自律、AI 會繞，只有 hook 是他律。
  2. **原則把可移植的開發流程骨幹當成事故條款排除**：舊 adaptation-guide 寫「不帶事故型 DoD 細則與 guard hooks」，但實測來源專案判斷矩陣 43 條中 40 條可移植（22 條純通用、18 條參數化後可用），只有 3 條真的綁死來源專案的工作法。
  3. **產出與宣稱之間沒有誠實揭露**：init 給的是骨架，卻沒有告訴使用者「成熟的 harness 還差什麼」（踩坑知識、回歸測試、覆蓋登記都是 0）。
- **新原則：開發流程骨幹全帶、事故型條款歸未來的 /harness:review**。判準：純行為紀律照搬、可參數化的挖空填入、綁死特定工作法的（本機 hack 管理、多 worktree、特定鏡像架構、環境檔歸屬）不帶（`references/adaptation-guide.md` §1 重寫）。
- **SKILL.md 改寫成 Phase 0~5**：
  - Phase 0 前置檢查四項：是否 git repo／是否已裝 harness（已裝就停，建議 review 不覆蓋）／`codex --version`（沒裝就產出安裝指引並停下，不降級成單軌——少了 Codex，commit 審查只剩同源模型審自己）／Playwright MCP 是否在 `permissions.allow`。
  - Phase 1 盤點十一項，新增**前端三分類判準**（瀏覽器可驅動→裝 qa-webwright／非瀏覽器前端→不裝、QA 改寫／無前端→觸發 Q3）與**危險動作候選推導**（寄信、外部 API、毀滅性 SQL、部署、金流計費、實機硬體、資料管線七類，各附 grep 關鍵字）；既有治理層白名單放寬到 CONTRIBUTING.md、docs/。
  - Phase 2 攤開核對：盤點表與自動推導預設一次攤給使用者糾正事實。
  - Phase 3 訪談 7 題、**一次一題**（Q1 pipeline 刪改／Q2 危險動作熔斷／Q3 怎樣算做完（僅無前端）／Q4 單人或團隊／Q5 哪些規矩要程式擋／Q6 豁免測試（僅無測試基礎）／Q7 必讀文件）；Q1 附預設 pipeline 原文、配套三條（無條件對齊回合、QA 先於 review、分流例外）與**自動裁切規則六列**。
  - Phase 4 生成五層：文件層 6 份、可執行層 hook、agent 層 5 份、知識容器層 3 份、settings 層，逐項列落點與來源。
  - Phase 5 驗收兩層：靜態五條＋**冷啟探針四項**（缺 model 被擋／正常派工不誤擋／SessionStart 提醒出現／裸 git commit 被擋，用 `--dry-run` 讓探針失敗也不會真的建 commit），任一失敗＝init 未完成；收尾回報加誠實條款（「你已經有的」「你還沒有的：踩坑知識 0 條、回歸測試 0 支」、接下來怎麼長）。
- **03 判斷矩陣擴充到 40 條**（A1-A8／B1-B23／C1-C9）：22 條純通用照搬、18 條參數化（build 指令、QA agent、測試目錄、稽核工具等改成填空）；保留 0.2.0 的「三種宣稱嚴格分離」（改編號為 B23）；C9 為「三重自查」的反向條款。不適用的條款在實例中保留編號改寫為「本專案不適用」，避免引用斷鏈。事故一律只講機制、不帶日期。
- **02**：agent 對照表改為「init 建一套通用同名 agent」，補 MCP 使用紀律與 hook 強制句；Quota 節流補大艦隊預算門檻。
- **04**：新增模板五（Pipeline 編排）與模板六（QA 驗證型：範圍展開四格、測試資料三選一、六條絕對禁止、欄位級驗證，專屬框架詞全部參數化）；共通規則補跨模組鏈路紀律。
- **05**：MEMORY.md 精簡觸發由 180 行改為 **20,000 字元**（中文行長差異大，行數不是好指標，且超限是靜默截斷）；健檢清單補 hook 雙向 dry-run、知識容器補課、「不適用條款前提是否改變」；升格協議補「一定要落地的條款要配機械閘」與事故型條款分流。
- **CLAUDE-md／harness-README 骨架**：新增 pipeline 節；路由表納入 `.claude/agents/`、`.claude/hooks/`、CONTEXT.md、FLOWS.md、tests/Project_Detail/PROJECT.md、Q7 必讀文件。
- **污染詞表**抽成機器可讀的 `skills/init/pollution-wordlist.txt`（維持黑名單）；移除現在是骨架刻意帶的通用名（通用 agent 名、CONTEXT.md、FLOWS.md、playwright），補來源專案的專屬腳本名。

### Added
- `references/agents/`：五支通用 agent 骨架（backend-architect／backend-engineer／frontend-engineer／qa-engineer／code-reviewer），專案名、技術棧、規範來源全部參數化；保留觸發時機、交接契約、輸出格式、嚴重度分級、「既有寫法一致不是合規理由」、「設計文件不是合規依據」、「審查者不做瀏覽器操作」。qa-engineer 瀏覽器可驅動時整段指向 qa-webwright；code-reviewer 保留 git-commit C 軌的 VERDICT 契約。
- `references/containers/`：CONTEXT（詞彙表：三條鐵則＋四個當場觸發時機）、FLOWS（跨模組鏈路圖：只收踩過坑或橫跨 ≥2 模組、每條掛事故收據、維護紀律）、PROJECT（QA 知識：操作規則／測試坑／設計知識）三份骨架，各帶收錄原則、一個標明「示範」的條目與 Changelog。
- `hooks/templates/`：18 支 hook 範本＋救回腳本 `restore-local-hacks.js`＋`probe-hooks.js` 執行器（payload 字串可用 `{PROJECT_DIR}` 佔位本次暫存專案路徑，git-commit plugin 的 hook 案例也用它跑）＋每支正反兩向的 `cases/`（init 複製到目標專案，不走 `${CLAUDE_PLUGIN_ROOT}`）。裝哪幾支不再是固定菜單，而是照 `skills/init/references/hook-catalog.md` 推導：來源專案 23 支 hook 與 3 個 plugin 自帶的閘逐支拆成「通用形狀＋觸發條件＋專案參數」，分 A 必裝／B 盤點觸發／C 工作法觸發／D 由 plugin 提供／E 長出來才裝。綁著來源專案事實的那幾支（資料庫登入、服務啟動環境、寄信收斂、測試環境對齊）不照搬，收成 `guard-risky-command`、`guard-test-preconditions` 兩個規則引擎，由 init 用目標專案盤點到的事實填規則；Phase 1 另加「執行期風險事實」與「工作法」兩項盤點當依據，Q2 熔斷清單的每一項都要落成一條規則，做不成的逐項說明。原本 init 只帶 4 支，是用「能不能原封複製」當判準——這個判準對綁專案事實的 hook 幾乎必然淘汰，而沙盒冷啟時掃到的寄信、TRUNCATE、部署全都只停在文字熔斷清單。
- `hooks/templates/shell-model.js`＋`package.json`／`package-lock.json`：兩支規則引擎共用的指令語法解析（見 Fixed）。init 裝了任一個規則引擎時一起複製，在目標專案 `.claude/hooks/` 跑 `npm ci`、`node_modules/` 進 `.gitignore`；`npm ci` 失敗不擋 init，回報寫明目前走正則判法。Phase 5 驗收與 05 健檢加「解析器載得起來」與 `--parser=off` 兩項；plugin 的 SessionStart 提醒在專案有 `shell-model.js` 卻沒裝解析器時（例如成員剛 clone）點名去跑 `npm ci`。
- **壓縮交接四支**（形狀目錄第 26 列，A 類必裝）：`compact-snapshot.js`（PreCompact：存背景 agent、讀過的規範、改過的檔、使用者原話的快照，並呼叫 `compact-handoff.js` 開隔離的 `claude -p` 子 session 寫交接信——不給工具、不載 MCP／skill／使用者設定，實測從 144k token 降到不到 1k；不能用 `--bare`，它不認 OAuth 登入）、`compact-reinject.js`（SessionStart `compact`：注入交接信與接續指示，整段扣掉前後固定文字後不超過平台 10,000 字元上限）、`compact-summary-log.js`（PostCompact：記摘要漏掉的項目）。子 session 帶 `COMPACT_HANDOFF_CHILD=1` 防遞迴；全程 fail-open，找不到 claude 或逾時只留快照、不擋壓縮；`COMPACT_HANDOFF_OFF=1` 可只存快照。來源實例以冷起對照評估過：只看內建摘要時漏掉的待決事項，交接信補得回來。與來源實例的行為差異兩處（審查抓到、實例同樣存在）：快照也收使用者在助理工作中途的插話（原本只有交接信收，交接信失敗時退回的快照會漏掉最新指示）；退回快照清單時截斷提示與結尾換行也算進 3500 字上限（原本會超出十幾字）。已知未解（寫在範本檔頭）：帶說明的 `/compact` 其 `custom_instructions` 實際值未實測、子 session 逾時後有無孫行程未驗證、「未處理」句數判定不穩定。
- `hooks/wordlist-sweep.js`（PreToolUse Skill）：改到骨架檔要 commit 時，要求 git-commit args 帶「詞表=」表態並列出已知污染詞命中；其他 repo、其他改動一律放行。選 hook 而不只寫紀律的理由：健檢 30 天一次，污染一發布就進了別人的實例，且會漏想新詞的正是改骨架的那個 session。

## [0.2.0] - 2026-09-13

### Added
- **矩陣 B 新增 B9「三種宣稱嚴格分離」**（`skeleton-03-judgment-matrix.md`）：①結構檢查（parse／lint／exit 0）②機器證據（實跑／截圖／量測）③感知審查（人或看得到圖的模型實際看過內容），**通過其中一種不准說成通過另一種**。
  - 附展開段：三層關係圖、五筆真實事故的冒充類型對照（docx parse 過但 Word 判毀損＝①當③、六個子系統 200 全綠但截圖是「连接失败」＝①當③、兩頁截圖 MD5 相同都是登入頁＝②當③、找回密碼頁截到全白＝②當③、只看 grep 命中行判假陽性＝①當③）。
  - 核心：**最危險的不是沒驗，是「驗了低層卻宣稱高層」**——每次複驗都會過（複驗的也是同一層），錯誤穿過所有關卡直到使用者發現。
  - 附帶條款：③ 沒做就明說沒做，不准用 ①② 混過去；**驗證器與施作器不可同源**（同一函式庫寫檔又驗檔，驗證器對寫入器的破壞完全盲——docx 事故的結構性成因）。
  - 改寫自 tt-a1i/archify 的 delivery-contract（MIT）。原版在程式裡強制執行：`visual-check` 的 receipt **永遠回報 `visualReview: "pending"`**，不管截圖多成功就是不准算成「有人看過」。值得學的是這個機制形狀——**不是用規則要求人誠實，而是讓證據本身拒絕被過度解讀**。
  - 使用者裁決放這裡而非只改單一專案實例：「要也是放進 harness init 裡吧」——骨架改了新專案都帶得走，只改 D 檔只有這個 repo 有。
  - 本 repo 的既有實例 `.claude/harness/D-判斷力矩陣.md` 為舊版格式（節 1/2/3），同步在「節 2 完成判準」補等效第 6 條（骨架更新不會回填既有實例）。

## [0.1.0] - 2026-08-19

### Added
- 初版：/harness:init 實例化流程（盤點→決策→骨架填空→機械驗收）、六份通用骨架（CLAUDE.md 路由中心＋harness README＋02~05）、adaptation-guide 改編原則、SessionStart 條件式提醒 hook。骨架抽取自 Supplier_Code harness，以汎銓實例（2026-08-19）為驗收樣本。
