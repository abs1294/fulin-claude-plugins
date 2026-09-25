# Changelog

All notable changes to this plugin will be documented in this file.

## [0.3.1] - 2026-09-25

### Changed（壓縮交接跟上來源實例）
- **交接信改九節**（`compact-handoff.js`）：未完成、目標版本（中途改目標時 v1／v2 各引原話並註明作廢步驟）、硬約束（使用者原話）、關鍵值（原樣）、走過的死路、HYPOTHESIS／已推翻、已完成、偏好、建議 skill；禁推論句（「使用者傾向…」）、禁簡體字形（語言規則收進填空區 `LANGUAGE_RULE`）。
- **關鍵值清單**：對話骨架只收助理的文字，工具回傳的測試數字、錯誤行、exit code、commit、PR／票號到不了交接信。改由程式從工具回傳抽原值交給模型，信寫完用字串比對驗「自稱抄入的是否原樣出現」，結果記 `keysClaimed`／`keysMangled`；讀檔類工具（Read、Grep、`cat`／`sed -n` 讀檔）的回傳不抽，避免把程式字面或舊交接信的數字當成這輪結果。
- **子 session 逾時 180→220 秒**：來源實例 180 秒時 4 次重寫逾時 2 次；PreCompact 接線 timeout 240 秒，差距留給快照寫檔，兩者在填空區註明要一起調。
- **注入超長時先截「已完成」節**（`compact-reinject.js`）：原本從信尾截，排在後面的節會先被砍；改為先壓「已完成」節內文，仍不夠才整段截斷。
- **流水帳加 `missingInHandoff`**（`compact-summary-log.js`）：同一份快照對交接信再比一次，量交接信有沒有補上內建摘要漏掉的項目。

### Added
- `hooks/templates/resume-stale-reminder.js`（SessionStart matcher `resume`，併入形狀目錄第 26 列）：距上次活動超過 `STALE_HOURS`（預設 4）才 resume 時，提醒服務狀態、背景 agent、DB 與 git、測試數字都可能已過期，附最近一封交接信路徑與使用者最後一則指示原文。壓縮有交接信補位，resume 沒有——context 原封不動回來，模型會把暫停當下的說法當成現況。

### Fixed（審查抓到，來源實例同步修正）
- **多行讀檔指令誤判**：判斷「這個 shell 指令只是讀檔」的樣式允許換行，`cat notes.md` 換行接 `pytest` 會被整段當成讀檔，後段真的測試結果抽不進關鍵值；換行改為等同接下一道指令。
- **resume 提醒把最新指示換成舊句**：原本排除「最近 60 秒內」的紀錄，以免 resume 自己寫入的紀錄被當成活動；但 resume 當下寫入的只有 queue-operation 與 hook 輸出的 attachment（來源實例以 `-p --resume` 實測），本來就被「只看 user／assistant」擋掉，這層排除唯一的效果是：暫停前 60 秒內才講的話被略過，提醒誤報過期，「最後一則指示」還顯示更早的舊句。已移除。HYPOTHESIS：互動模式 resume 是否會在 hook 之前先寫 user／assistant 紀錄未實測；若會，最壞結果是該次不出提醒。

### 驗證
- 範本以來源實例為邏輯正本產生，程式化逐行比對：差異只剩填空區常數、通用 `DOC_RE`／`NOISE_RE`、`COMPACT_HANDOFF_OFF` 分支。
- probe：語法樹路徑 482/482；正則路徑 439 通過、43 略過（含 resume-stale-reminder 新增 4 條）。
- 新增行為整合測試 16/16（關鍵值抽取與讀檔排除、多行指令、先截已完成節、missingInHandoff、resume 5 小時提醒、1 小時與 30 秒前才活動時靜默）；以 0.3.0 範本為對照組 11 條失敗、以修正前的本版為對照組 2 條失敗（多行指令、30 秒前才活動），證明測試抓得到差異。0.3.0 的整合測試 17/17 無退步；真呼叫 `claude -p` 一次，交接信九節齊全、統計行已移除。
- 未實測：真呼叫時「關鍵值：」統計行的移除與 `keysMangled` 比對（測試對話沒有工具回傳可抽）。

## [0.3.0] - 2026-09-23

### Fixed（冷啟實測抓到）
- **指令名稱**：skill 目錄從 `skills/harness-init/` 改名為 `skills/init/`。plugin 的指令名由 skill 的**目錄名**決定（frontmatter 的 `name` 不影響，兩者都實測過），所以自 0.1.0 起實際註冊的指令一直是 `/harness:harness-init`，而文件全部寫 `/harness:init`——照文件打的人打不開。連帶更新 9 處路徑引用，其中 `hooks/wordlist-sweep.js` 的路徑正則與 `path.join` 兩處若漏改，這支閘會永遠比不中而靜默放行。
- **`/harness:review` 被寫成現成指令**：該指令尚未提供，3 處敘述（init Phase 0 的建議動作、會被複製進使用者專案的 05 骨架、adaptation-guide 標題）改標「規劃中、尚未提供」。
- **冷啟驗收**（兩輪，皆對全新沙盒專案以 `--plugin-dir` 載入本版實跑 `/harness:init` 全流程）：
  - 第一輪（可執行層仍是 4 支固定範本時）抓到指令名稱、C 軌 agent、PowerShell 旁路三個問題，並暴露可執行層只從菜單挑的根本問題——沙盒裡被掃到的寄信、TRUNCATE、部署全都只停在文字熔斷清單。
  - 第二輪（形狀目錄推導後）：沙盒含高權帳號連線字串、正式庫主機、對正式機 ssh 的部署腳本、會 TRUNCATE 的管理端點、真實 SMTP 主機、寫死 production 的啟動指令與本機覆寫清單。init 推導出 14 支 hook、13 條 B 類規則（每條都對得到盤點證據），本機覆寫三件組因偵測到覆寫清單而裝上、多工作樹那支正確地不裝；實例內探針 158/158；冷啟探針 P1、P2、P3、P5 在新 session 通過（P5 的 13 條無害觸發指令全數被擋，含 PowerShell），P4 因目標目錄未啟用 git-commit 不適用；裝完的沉澱閘在同一個 session 就擋下收尾、逼答四題。
  - 第二輪抓到並已修：規則引擎把「傳給一般程式的引號字串」也當成執行（commit 描述提到 `deploy.sh` 會被擋）；不認 `node --env-file`；環境檔相對路徑沒跟同一條指令前面的 `cd` 走；前置條件檢查不分子專案（新增 `when`）；SKILL 的 P1／P2 探針 prompt 會先撞上派工紀律閘而蓋掉要驗的訊息；Q5 推導清單在有預先答案時沒先印出。修後範本探針 189/189；並把第二輪實例實際產出的 11 條 RULES／2 條 CHECKS 搬進修好的引擎交叉驗證：13 條該擋的全擋、冷啟實際踩到的 3 種誤擋全部放行。
  - 擋下訊息逐條審閱（第二輪實例的 13 條）：格式與「為什麼」都對得到專案實物，10 條可照抄的放行方式餵回閘全數放行；但有 5 條會誤導——放行方式裡寫出引擎盲點（等於教人繞）、照做過得了閘卻跑不起來（repo 根沒有 package.json）、要模型把連線字串貼進指令列、指向沒裝的 skill、沿用別專案的錯誤理由（高權帳號寫成「密碼錯會被鎖」）。後兩者的源頭是範本示範規則，已改；SKILL.md 新增「B 類規則的訊息怎麼寫」六條與 Phase 5 驗收「照放行方式做：餵回閘必須放行、可實跑的要實跑」；前置條件閘結尾的「重啟跑中服務」改為只在設定檔類檢查不符時出現。
- **規則引擎的「會不會執行」與「環境值」跟真實 shell 不一致**（審查抓到，實跑重現）：`guard-risky-command` 的 `when`／`unless` 與環境取值、`guard-test-preconditions` 的環境取值原本都看整串指令的字面，於是別條指令能替這條背書——`kubectl apply -f prod.yaml; kubectl apply --dry-run …` 由第二條的 `--dry-run` 放行、`NODE_ENV=production node server.js; NODE_ENV=test true` 由後段賦值放行；環境值也不分 shell 變數與匯出變數、不認 `unset`／`env -u`／子殼範圍。先以正則逐項補了十三輪審查，每輪都再被掃出同類寫法（子殼、條件執行、命令替換先後、包裝指令的內層……），字面比對在結構上收斂不了，改為**用語法解析器判**：
  - **語法樹路徑（預設）**：新增 `hooks/templates/shell-model.js`，以 tree-sitter（`tree-sitter`、`tree-sitter-bash`、`tree-sitter-powershell`，版本由 `package.json`／lock 檔釘住，皆 MIT、附六個平台的預編譯檔）把指令解析成語法樹，照 shell 語意建出「每個會執行的指令」與「每個指令實際拿到的環境值」：`export`／`declare -x`／`set -a` 才傳給子程序、`unset`／`export -n`／`env -u`／`env -i` 讓它消失；`( … )`、`$( … )`、管線元素是 fork 子殼（繼承全部變數、設定不回到外層），`bash -c`、find -exec、xargs 是新程序（只繼承匯出的）；`&&`／`||`／if／迴圈是條件區域；殼包裝（bash -c 一個詞、`cmd /c` 與 `powershell -Command` 取整串）、heredoc（由 shell 開啟的主體當指令、其他程式開啟的主體併進它的比對文字）、`cmd /c` 脈絡的 `set X=v`、`node --env-file`（不覆蓋已存在的變數、只認寫在腳本名之前的）、`cd` 的目錄追蹤都依語法樹。`when` 逐條管線比對、`unless` 只看命中的那個指令、`requireEnv` 對命中的每個指令各自取值。兩支引擎共用這一份模組。
  - **正則路徑（退回）**：解析器沒裝、載入失敗、設 `HARNESS_SHELL_PARSER=off`，或語法樹有錯誤節點時整串改走原本的正則判法（十三輪修正都保留在這條路徑）。錯誤節點不一定是指令寫壞：PowerShell 文法把合法的 `./deploy.ps1`、`--dry-run=client`、單獨的 `--` 都解析成錯誤節點，實測一批 32 種常見 PowerShell 寫法有 3 種走退回；原本「有錯誤節點照樣分析」的設計會讓 `./deploy.ps1 -Force` 一個指令都認不出來而放行，已改為退回。
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
  - **驗證**：以被執行就留下標記的假指令、印出實際環境值的假程式，交給真 Git Bash 與真 Windows PowerShell 5.1 執行，與 hook 判定逐條對照。語法樹路徑：Bash 會不會執行 68/73（危險指令閘）、52/57（前置條件閘）；Bash 環境值 66/69、65/69；`node --env-file` 11/11；PowerShell 會不會執行 43/48、環境值 37/47；雙軌審查點名的寫法與同類寫法另 153 種，146 種一致、漏擋 0、多擋 7（只定義不呼叫的函式、函式本體內指令的環境值兩種寫法、沒有繼承值時的條件式 source、`a && export … || export …` 兩支都設同值、`eval "$(…)"` 之後不帶值直接起服務、值來自別的變數——皆為刻意保守）；審查者另以真 Bash 對照的 212 種寫法（條件分支、迴圈、引號與拼接變數名、同名展開、source 檔內結構、未知值的各條傳遞路徑、值的表示法邊界、殼包裝旗標等）無漏擋，多擋皆屬保守方向；殼包裝旗標另有 19 種寫法的 hook 判定兩條路徑全數符合真 PowerShell 的實際行為。另以審查者整理的日常寫法 40 種（`npm ci && npm start`、`cd api && npm start`、`[ -f .env ] && source .env; npm test`、`export APP_ENV=${APP_ENV:-local}`、`source .venv/bin/activate && npm start`、`trap 'kill $(jobs -p)' EXIT` 等）實跑，語法樹路徑擋 3 種，都是 `eval "$(…)"`／`source <(…)` 接起服務，訊息會給可照做的帶值寫法。未一致的全數歸類過：對照組本身的限制（本機無 sudo、假測試執行器不分 `--help`、目標程式根本沒被執行）、刻意的保守多擋（條件與函式本體裡的指令一律當成會執行、可能發生過的設定判成無法確認、PowerShell 非字面寫法判成無法確認），以及看不到腳本檔內容（`bash run.sh`）。正則路徑同批對照 67/73、52/57、65/69、65/69、11/11、43/48、37/47，另 153 種中漏擋 41——都是它不建模的寫法，列入檔頭 [正則] 極限。
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
- **壓縮交接四支**（形狀目錄第 26 列，A 類必裝）：`compact-snapshot.js`（PreCompact：存背景 agent、讀過的規範、改過的檔、使用者原話的快照，並呼叫 `compact-handoff.js` 開隔離的 `claude -p` 子 session 寫交接信——不給工具、不載 MCP／skill／使用者設定，實測從 144k token 降到不到 1k；不能用 `--bare`，它不認 OAuth 登入）、`compact-reinject.js`（SessionStart `compact`：注入交接信與接續指示，整段扣掉前後固定文字後不超過平台 10,000 字元上限）、`compact-summary-log.js`（PostCompact：記摘要漏掉的項目）。子 session 帶 `COMPACT_HANDOFF_CHILD=1` 防遞迴；全程 fail-open，找不到 claude 或逾時只留快照、不擋壓縮；`COMPACT_HANDOFF_OFF=1` 可只存快照。來源實例三組冷起對照：待決事項覆蓋從只有摘要的 6/9 到 9/9。與來源實例的行為差異兩處（審查抓到、實例同樣存在）：快照也收使用者在助理工作中途的插話（原本只有交接信收，交接信失敗時退回的快照會漏掉最新指示）；退回快照清單時截斷提示與結尾換行也算進 3500 字上限（原本會超出十幾字）。已知未解（寫在範本檔頭）：帶說明的 `/compact` 其 `custom_instructions` 實際值未實測、子 session 逾時後有無孫行程未驗證、「未處理」句數判定不穩定。
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
