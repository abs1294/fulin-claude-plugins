#!/usr/bin/env node
// PreToolUse(Bash|PowerShell)：危險指令規則引擎——「指令命中某樣式 → 除非滿足放行條件 → 否則擋下並說明怎麼改」。
//
// 【範本】由 /harness:init 複製到目標專案 `.claude/hooks/`，之後歸該專案自治（可自改；plugin 更新不會自動同步）。
// 接線（目標專案 .claude/settings.json）：
//   "PreToolUse": [{ "matcher": "Bash|PowerShell", "hooks": [{ "type": "command",
//     "command": "node \"<專案絕對路徑>/.claude/hooks/guard-risky-command.js\"", "timeout": 15 }] }]
//
// 為什麼是「一個引擎＋一張規則表」：來源專案原本有好幾支各綁一個專案事實的守門——
//   · 資料庫登入守門：曾有人憑印象拼帳密、用高權帳號連測試庫，連續登入失敗觸發鎖定，
//     整台庫一段時間對所有人不可用。
//   · 服務啟動守門：曾把環境參數放在會被前一個參數吃掉的位置，服務照常監聽、照常回 200，
//     實際卻跑在正式環境設定上（外部相依指向正式主機、本機模式未啟用），直到有人開畫面才發現。
//     同款靜默失敗先前已發生多次——「沒帶對環境」不會報錯，只會在很遠的地方壞掉。
//   · 熔斷清單上的不可逆動作（部署、推送、毀滅性 SQL）原本只寫在文字規則裡，全靠自律。
// 它們的形狀完全相同，差別只在「樣式」與「放行條件」兩個專案事實。收成一張表之後，
// 每掃到一個風險就是加一列，不必再寫一支新 hook。
//
// 兩條判定路徑（兩支規則引擎共用同一套設計）：
//   · 語法樹路徑（預設）：同目錄的 shell-model.js 用 tree-sitter 把指令解析成語法樹（bash 與 PowerShell 各一套文法），
//     依 shell 的真實語意判「哪些指令會執行」與「每個指令實際拿到的環境值」——子殼範圍、條件執行、命令替換的先後、
//     引號、heredoc、殼包裝的內層都依語法樹，不靠字面猜。解析器由 /harness:init 在 .claude/hooks 以 npm ci 安裝
//     （同目錄 package.json 釘版本：tree-sitter、tree-sitter-bash、tree-sitter-powershell，皆 MIT 授權、
//     附六個平台的預編譯檔，不需要編譯器；版本由 package-lock.json 釘住）；團隊成員拉下專案後要在 .claude/hooks 跑一次 npm ci。
//   · 正則路徑（退回）：解析器沒裝、載入失敗、設 HARNESS_SHELL_PARSER=off，或語法樹有錯誤節點時，整串改走原本的正則判法。
//     錯誤節點不一定是指令寫壞：PowerShell 文法把合法的 `./deploy.ps1`、`--x=值`、單獨的 `--` 都解析成錯誤，
//     這類指令一律走正則路徑。準確度較低（下方已知極限標 [正則] 的條目），但不會整個失效。
//   兩條路徑都以真 shell（Git Bash、Windows PowerShell 5.1）逐條對照驗證過，細節見 plugin 的 CHANGELOG。
//   probe-hooks.js 預設走語法樹、加 --parser=off 走正則路徑，改動引擎後兩者都不得有 FAIL
//   （標 "parser": "only" 的案例是正則路徑的已知極限，走正則路徑時略過並計數）。
//
// 規則欄位（RULES 的每一列）：
//   id          規則代號（訊息用）。
//   when        字串 regex（不分大小寫、多行模式），比對「整條指令」——包含 `bash -c '…'`、
//               `cmd /c "…"`、`powershell -Command "…"` 這類包裝，所以不要只看第一個 token。
//               比對對象是「實際會執行的部分」：每條指令各佔一行（同一條管線合成一行，以 | 相接），
//               可用 ^ 錨定行首；要限定在同一條指令內請用 [^\n]*，不要用 [\s\S]*（會跨到別條指令）。
//               引號內的字串預設**不參與比對**（見下方「字串裡提到但沒執行」）。
//   unless      選填，字串 regex，命中則放行（例如 `--dry-run`、指定的測試帳號）。與 when 比對**同一條指令**
//               ——別條指令帶的 `--dry-run` 不能替這條背書（`kubectl apply -f prod.yaml; kubectl apply --dry-run …`
//               照擋第一條）。管線裡也一樣：when 命中的是管線中某一個指令時，unless 只看那一個指令
//               （`kubectl apply -f prod.yaml | node helper.js --dry-run` 照擋）；when 本身跨管線（例如
//               `echo "…" | psql` 這種要合看的）時才看整條管線。
//   matchQuoted 選填，true＝這條規則連一般程式的引號引數也比對（例如要擋 `psql -U "postgres"` 這種
//               把帳號包在引號裡的寫法）。代價是提到該字樣的 commit 訊息、給其他工具的提示字串也會被擋，
//               只在確定需要時才開。
//   requireEnv  選填，{ 變數名: 期望值的 regex }——「起服務必帶正確環境」用。值＝命中那條指令執行時
//               **實際拿到**的值：照 shell 的語意模擬前面的指令（語法樹路徑在 shell-model.js、正則路徑在 envValueAt），重點：
//               · `export X=v`／`declare -x`、`set -a` 之後的賦值、`$env:X`、cmd 的 `set X=v` 會傳給子程序；
//                 只寫 `X=v`、或 `source` 一份沒寫 export 的環境檔，只是 shell 變數，子程序拿不到。
//               · `unset X`、`export -n X`、`env -u X`、`env -i` 會讓它消失；管線與子殼（`bash -c`）裡的設定
//                 不回到外層；命中那條自己的前綴（`X=v cmd`，含外層包裝帶進來的）最後套用。
//               · 命中那條自己的 `node --env-file=<檔>`：Node 不讓它覆蓋已存在的變數，只補還沒有的。
//               · 環境檔的 `#` 註解行不算；相對路徑以同一條指令裡在它之前的 cd／pushd／Set-Location 累積出的目錄為基準
//                 （`cd api && node --env-file=.env.test …` 讀的是 api/.env.test）。
//               管線裡有多個指令命中 when 時各自驗。以真 bash 執行的逐一對照見 CHANGELOG。
//               有 requireEnv 的規則＝「全部變數都對才放行」，任一缺或不符就擋。空字串視同未設。
//   reason      擋下時說明「為什麼擋」——寫機制與後果，不寫「禁止」兩個字就交差。
//   fix         怎麼做才會放行——給可照抄的正解，或寫明「請使用者親自執行」。
//
// 「字串裡提到但沒執行」的判定（引擎內建，兩條路徑相同，不必每條規則自己處理）：
//   · 指令先依 ; && || | & 換行切段（引號內不切），每段取動詞；動詞是 echo／printf／grep／rg／cat／
//     Write-Output／Select-String 這類只讀或只印字的指令，該段整段不參與比對——
//     否則寫文件、查字串、grep 腳本名都會被誤擋。
//   · 例外：只印字的段落若用管線接給會執行的指令（`echo "DROP …" | psql`），那段照樣算數。
//   · 傳給一般程式的引號引數是**資料**不是指令：`<某 CLI> -p "…請執行 git push…"`、
//     `bash release.sh "修正 deploy.sh 的路徑"`（commit 描述提到腳本名）都不該被擋——冷啟實測時
//     正常的提示字串與 commit 描述正是這樣被誤擋的。所以預設只比對未加引號的部分（段首的指令名本身
//     即使加了引號也照樣算，例如 PowerShell 的 `& "./deploy.ps1"`）。
//     只有段首指令本身會把字串當程式執行時，引號內容才納入比對：
//       - DB 用戶端（psql／mysql／sqlcmd／mongosh／sqlite3／Invoke-Sqlcmd）：一律納入——它們的引號引數
//         不是 SQL 就是連線參數，都是規則要看的東西（sqlite3 的 SQL 是位置引數，沒有旗標可認）。
//       - eval／iex／Invoke-Expression／ssh（遠端指令）：一律納入。
//       - node -e／-p、python -c、ruby -e、perl -e、php -r、bun -e、deno eval：帶這些旗標時納入。
//       - `bash -c '…'`／`cmd /c "…"`／`powershell -Command "…"`：拆開內層，當成一條新指令整套重判
//         （內層的引號一樣照上面的規則處理）。不帶 -c 的 `bash script.sh "…"` 是跑腳本，引數照樣是資料。
//   · 命令替換 `$(…)`／反引號裡的指令另外拆出來當成一條指令判：`echo "$(git push)"` 的 echo 是印字，
//     但替換裡的 git push 會真的執行。
//   · heredoc 主體併入開啟它的那一段：`cat > notes.md <<EOF` 的主體是資料，`psql <<EOF` 的主體是 SQL。
// 已知極限（擋不住或會多擋，靠文字規則與 review 補）。標 [正則] 的只在退回正則路徑時成立，語法樹路徑已正確判：
//   · 條件與函式只做保守判：條件區塊、迴圈、`a || b`、函式本體裡的指令一律當成會執行（`while false; do …; done`、
//     只定義不呼叫的 `f() { …; }` 照擋）。條件區段裡的設定（export、unset、set -a、source）兩種情況都算——有發生、
//     沒發生各得一個可能值，**每一個都符合**才放行：`[ -f .env ] && source .env`（.env 與繼承值都對）放行，
//     `[ -f x ] && export X=production` 擋。代價是模型不判斷條件真假：沒有繼承值時的 `[ -f .env ] && source .env`、
//     `if [ -z "$X" ]; then export X=v; fi` 會因「沒發生」那一支是空值而擋。迴圈體後段的設定當成也可能落在前段指令之前
//     （下一輪）。函式本體、trap 裡的設定看不出何時發生，同一串裡碰到該變數就判成無法確認；條件區段裡的 cd 讓環境檔位置
//     無法確認。
//   · 會寫進變數、但沒逐一建模的寫法——read、mapfile／readarray、getopts、printf -v、let、`for X in`、`declare -n`、
//     來源不是字面檔案的 source（`source <(…)`、`. /dev/stdin`）、含展開的 eval——一律讓該變數（或全部變數）判成無法確認；
//     字面的 `eval "…"` 照內層指令解析。source 進來的檔案只套最外層、一定會執行的設定；檔內的條件式寫入與巢狀 source
//     讓相關變數判成無法確認。指令名本身是展開（`c=unset; $c X`）時，引數裡出現的變數名判成無法確認。
//     值分三種：字面值照原樣（單引號裡的 `'$X'` 也是字面，`$'…'` 會解碼跳脫）、同名展開（`$X`、`${X:-預設}`）照當下的值展開、
//     別的變數的展開在這串指令完全沒碰過那個變數時照繼承值展開（`${NODE_ENV:-local}`），碰過就視為未知；
//     其餘展開（`$(cmd)`、`${X}x`、`${X,,}`、cmd 的 `%X%`）一律視為未知——`OTHER=local; export APP_ENV=$OTHER` 這類也會擋。
//     `X+=v` 接在目前的值後面；`X[i]=v`（變數變成陣列、不再匯出）判成無法確認。多個前綴由左到右依序展開、依序生效。
//     這一類擋下時訊息會建議在那條指令前面直接帶**字面值**（`X=local npm start`）——「未知」會跟著值走，只有字面值的前綴
//     （指令自己的，或父指令的 `X=local bash -c …`）蓋得掉它；引用同名變數的前綴（`X="$X" cmd`、`X=${X:-local} cmd`）仍是未知。
//     指令名本身是展開時，引數恰好等於被檢查的變數名（`"$TOOL" --flag APP_ENV`）也會判成無法確認（多擋方向）。
//   · 會把字串當指令跑的程式只認：bash／sh -c（可與其他短旗標合寫：-lc、-ec）、cmd /c、/k（Git Bash 上實際會執行的是 `//c`，
//     兩種都認，前面可有其他 cmd 旗標）、powershell／pwsh 的 -Command（任何前綴縮寫 -c、-Com、-comm，前面可以是 -、-- 或 //，
//     不分大小寫；前面有 -exec bypass 這類旗標照樣認）、-EncodedCommand（-e、-ec、-enc，解碼後判內層）、powershell.exe 不帶旗標時的
//     第一個位置引數、eval、find -exec、xargs、su -c、script -c、watch、trap；PowerShell 的 -File 腳本檔內容看不到；
//     PowerShell 的 iex／Invoke-Expression 引數不是字面字串、或 `[scriptblock]::Create(…)` 時，所有環境變數判成無法確認；
//     其他（`parallel`、`flock -c`、`nsenter`、專案自製的包裝腳本）看不到內層。
//   · 走訪沒建模到的位置若還有指令，兜底掃描一律補收成「會執行」（多擋方向），環境值從嚴。
//   · PowerShell 設環境變數只認最外層、名字大小寫一致、值為字面值的 `$env:X = '…'`（`$Env:` 前綴不分大小寫）／
//     `$env:X = $null`；同一串裡這個變數出現過其他寫法（Set-Item／Clear-Item／Remove-Item 等 Env: 項目操作、
//     `${env:X}`、SetEnvironmentVariable、`+=`、名字大小寫不同、寫在區塊或條件裡）就判成值無法確認而擋下；
//     Env: 磁碟機被變數語法以外的方式碰到（`New-Item -Path Env: -Name X`、`gci Env:X | Remove-Item`、`Get-ChildItem Env:`）
//     時，所有環境變數一律判成無法確認。真 PowerShell 對照證實這些寫法把正確的繼承值改壞時，逐條模擬會照舊值放行，所以一律從嚴。
//   · 餵給殼當腳本的 stdin 只認 echo／printf 印的、heredoc、here-string（`echo 'git push' | bash`、`bash <<< '…'`）；
//     其他來源（`bash < run.sh`、`curl … | bash`）看不到內容。
//   · sudo 預設會重設環境（env_reset），外層匯出的變數多半傳不進去；引擎不模擬這點，照一般前綴處理（`sudo X=v cmd` 有認）。
//   · 腳本檔的內容看不到：`bash run.sh` 裡執行了什麼引擎不知道；`source run.sh` 只讀它的環境設定，裡面執行的指令看不到。
//   · `psql -f drop.sql` 或 `< drop.sql` 看不到檔案內容；-EncodedCommand 看不到字面。
//   · 變數間接（`$q = "DROP …"; Invoke-Sqlcmd -Query $q`）：SQL 在賦值段的引號裡，執行段只看得到變數名。
//   · 自製的「會執行字串」的程式（例如專案自己的 run-sql 腳本）引擎不認得，它的引號引數會被當資料；
//     要守它就在規則加 matchQuoted: true。
//   · 引號內容一律不比對的反面：`some-cli "DROP TABLE x"` 若該 CLI 真的會執行 SQL 且不在上列清單，就會漏；
//     同上，用 matchQuoted 補。
//   · 環境檔的目錄追蹤只認字面的切目錄動作：`cd -`、`cd ~`、`cd $DIR`、不帶引數的 cd 判讀不了，
//     一律退回專案根解析。判錯的後果是找不到環境檔 → 落到 hook 程序環境變數判（多半是擋，訊息會寫變數未設定）。
//   · [正則] PowerShell 的反引號續行（行尾 `）不接回；bash 的反斜線續行有接。
//   · [正則] 命令替換的內容排在整條指令最後判，取環境值時看得到它之後的 export
//     （`echo "$(node server.js)"; export X=v` 會被當成已設 X）。
//   · [正則] heredoc 的開頭 `<<TERM` 不辨識是否在引號裡：`echo '<<EOF'` 會把之後到 EOF 的行當成資料略過。
//   · [正則] 條件不建模：`false && export X=v`、`a || export X=v && cmd` 會被當成已設；迴圈、case、函式本體裡的
//     unset 與改值看不到（漏擋方向）。
//   · [正則] `( … )` 子殼不辨識範圍：`(export X=v; cmd)` 會多擋、`(cd api); …` 的切目錄會被當成留在外層；
//     兩次各自獨立的 `bash -c '…'` 之間也分不出是不是同一個子殼；包裝指令與子殼裡的 cd 照同一條線性順序算；
//     `set -a` 會被當成傳進 `bash -c` 的新程序。
//   · [正則] `X[i]=v`、`X+=v` 不建模（照一般賦值或字面判）；`$'…'` 不解碼、`${OTHER:-預設}` 與多個同名前綴不展開（照字面比對而多擋）。
//   · [正則] 內建指令的變形不認：`! unset X`、`builtin unset X`、`declare +x X`、`command export X=v`；
//     eval、read、printf -v、`for X in`、`declare -n`、`source <(…)` 寫進變數看不到；迴圈體後段的設定不回到前段；
//     `${X:-預設}` 不展開（照字面比對而多擋）；trap、su -c、script -c、watch 的內層看不到。
//   · [正則] 重導向上的行程替換（`cat < <(cmd)`）、here-string（`bash <<< '…'`）、stdin 餵給殼的腳本
//     （`echo '…' | bash`、`printf '…\n' | sh`）裡的指令與設定看不到。
//   · [正則] 只有賦值、沒有指令的段落（`x=danger-cmd`）若命中 when 也會擋；find／xargs 那一行拿外層的環境判
//     它叫起的指令（`xargs env X=v cmd` 會多擋）。
//
// ⚠ 不要在規則裡設「註解豁免」（例如指令尾巴加 `# ok` 就放行）：來源專案曾有守門設了豁免註解，
// 結果整輪作業每條指令都習慣性帶上它，守門從頭到尾沒生效過一次——
// 豁免能豁免的對象，正好就是守門唯一該守的對象。真的要放行，就把放行條件寫成 unless。
//
// fail-open：解析失敗、單條規則的 regex 寫壞、任何例外一律放行（壞掉的規則只印提醒，不擋路）。
//
// ── init 怎麼從盤點結果產規則 ──────────────────────────────────────────────
// 1. Phase 1「危險動作候選」與 Q2 熔斷清單勾選的每一項，各落成一列；做不成 regex 的在 Phase 5 回報說明。
// 2. when 取自盤點到的實際指令形狀（專案用哪個 DB 用戶端、部署腳本叫什麼、正式主機的命名樣式）；
//    unless 取自專案查證過的「正確做法」（測試帳號、dry-run 旗標）。不要填猜的值。
// 3. 起服務類：Phase 1 看到啟動指令依賴環境變數（NODE_ENV／APP_ENV／--profile…）→ 一列 requireEnv。
// 4. 每加一列，cases/guard-risky-command.json 就要補一擋一放，跑 probe-hooks.js 全綠才算裝完。
//
// 四個抽象示範規則（寫在註解裡，不啟用；init 依盤點結果改寫後放進 RULES）：
//   { id: 'db-privileged-login',
//     when: '\\b(psql|mysql|sqlcmd|mongosh)\\b[^\\n]*(-U\\s*|-u\\s*|--user(name)?[=\\s]+)(postgres|root|sa|admin)\\b',
//     reason: '用高權帳號連資料庫：它繞過所有權限檢查，一個手滑就能刪掉任何資料庫或整批資料，沒有回滾。',
//     fix: '改用專案的測試帳號（見 DB 連線正本）；帳密不確定就問使用者，不要試密碼。' },
//   { id: 'deploy',
//     when: '(^|[\\s/\\\\"\'])deploy\\.(sh|ps1)\\b|\\b(kubectl\\s+apply|terraform\\s+apply|helm\\s+(upgrade|install))\\b',
//     unless: '--dry-run\\b',
//     reason: '部署會改到共用環境，出錯要別人收拾，且不可逆。',
//     fix: '先用 --dry-run 看差異；真的要部署，把指令交給使用者親自執行。' },
//   { id: 'ssh-prod',
//     when: '\\b(ssh|scp|rsync)\\b[^\\n]*\\b[\\w.-]*(prod|prd)[\\w.-]*',
//     reason: '對正式主機的任何操作都在熔斷清單上：沒有回滾、影響真實使用者。',
//     fix: '需要正式主機的資訊，請使用者提供或由使用者親自登入操作。' },
//   { id: 'destructive-sql',
//     // 兩個前瞻：同一行（同一條管線）裡「有 DB 用戶端」且「有毀滅性語句」，不限先後——
//     // `echo "TRUNCATE …" | psql` 的語句在用戶端之前。
//     when: '^(?=[^\\n]*\\b(psql|mysql|sqlcmd|sqlite3|mongosh|invoke-sqlcmd)\\b)(?=[^\\n]*(\\bDROP\\s+(TABLE|DATABASE|SCHEMA)\\b|\\bTRUNCATE\\b|\\bDELETE\\s+FROM\\s+[^\\s;"\']+(?![^;\\n]*\\bWHERE\\b)))',
//     reason: 'DROP／TRUNCATE／不帶 WHERE 的 DELETE 會整批毀掉資料，沒有回滾；多人共用的庫還會連別人的資料一起消失（單人專案 init 時刪掉這半句）。',
//     fix: '只刪自己造的列（帶 WHERE 鎖定鍵值）；真的要整表清除，請使用者親自執行。' },

// ── init 填空區 ──────────────────────────────────────────────────────────────
// 規則表（= Phase 1 危險動作候選 ＋ Q2 熔斷清單勾選項，每項一列；格式見檔頭）。預設空陣列＝全放行。
const RULES = [];
// 擋下訊息開頭的標籤（只影響訊息文字）。
const LABEL = '危險指令守門';
// ────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');

// 只讀或只印字的動詞：該段不是在「執行」目標指令，只是提到它。
const MENTION_VERBS = new Set([
  'echo', 'printf', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'cat', 'less', 'more', 'head', 'tail',
  'wc', 'ls', 'dir', 'man', 'which', 'where', 'type', 'tee', 'findstr', 'find',
  'write-host', 'write-output', 'select-string', 'sls', 'get-content', 'gc', 'get-command', 'out-file',
]);
const WRAPPERS = new Set(['bash', 'sh', 'zsh', 'dash', 'cmd', 'powershell', 'pwsh']);

// 「後面接著真正要跑的指令」的前綴程式與它們的選項（sudo -u x、env -u x、nice -n 5、timeout -s KILL 10…）。
// 判動詞、取環境值的前綴、拆 find／xargs 的段首三處共用這一份——以前三處各寫一份清單，改一處就漏其他處
// （sudo -u postgres psql 的動詞被認成 -u；env -u X 在段首判斷裡認不得）。
const ASSIGN_SRC = String.raw`[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)`;
// 選項的值：可以是加引號的（`sudo -p "Password: "`、`env --chdir="/path with spaces"`），引號裡的空白不算斷點
const VAL_SRC = String.raw`(?:"[^"]*"|'[^']*'|[^\s"';&|])+`;
const RUNNER_PREFIX_SRC = [
  String.raw`sudo(?:\s+(?:-[ugphCDrtTU](?:\s*|=)` + VAL_SRC + String.raw`|--[a-z-]+=` + VAL_SRC + String.raw`|--|-[A-Za-z]+))*`,
  String.raw`env(?:\s+(?:-i|--ignore-environment|-u\s+` + VAL_SRC + String.raw`|--unset=` + VAL_SRC + String.raw`|-C\s+` + VAL_SRC + String.raw`|--chdir=` + VAL_SRC + String.raw`|-))*`,
  String.raw`nice(?:\s+(?:-n\s*` + VAL_SRC + String.raw`|-\d+|--adjustment=` + VAL_SRC + String.raw`))*`,
  String.raw`timeout(?:\s+(?:-[sk]\s*` + VAL_SRC + String.raw`|--[a-z-]+(?:=` + VAL_SRC + String.raw`)?|-\S+))*\s+` + VAL_SRC,
  String.raw`time(?:\s+-p)?`,
  String.raw`nohup`,
  String.raw`command(?:\s+-p)?`,
  String.raw`exec(?:\s+-a\s+` + VAL_SRC + String.raw`|\s+-[cl]+)*`,
  String.raw`builtin`,
].join('|');
const KEYWORD_SRC = String.raw`if|then|do|else|elif|while|until|!`;
// 判動詞：一次剝一層（賦值、前綴程式連同選項、控制關鍵字）
const PREFIX_STEP_RE = new RegExp('^(?:' + ASSIGN_SRC + '\\s+|(?:' + RUNNER_PREFIX_SRC + ')\\s+|(?:' + KEYWORD_SRC + ')\\s+)');
// 拆 find／xargs 前的段首：賦值與前綴程式整串剝掉
const LEAD_RE = new RegExp('^(?:' + ASSIGN_SRC + '\\s+|(?:' + RUNNER_PREFIX_SRC + ')\\s+)*');
// 取環境值的前綴：再加上殼包裝名（包裝展開後的 X=1 bash Y=2 cmd）
const ENV_PREFIX_RE = new RegExp('^(?:(?:bash|sh|zsh|dash|cmd|powershell|pwsh|' + ASSIGN_SRC + '|' + RUNNER_PREFIX_SRC + ')\\s+)*');

// heredoc 主體併進開啟它的那一行（插在 <<TERM 之後），並把主體裡的分隔字元與引號壓成空白，
// 讓它跟著開啟者的動詞一起被判：cat 開的就是資料、psql 開的就是 SQL。
function foldHeredocs(cmd) {
  const lines = cmd.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = /<<-?\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))/.exec(line);
    if (!m) { out.push(line); continue; }
    const term = m[1] || m[2] || m[3];
    const body = [];
    let j = i + 1;
    for (; j < lines.length && lines[j].trim() !== term; j++) body.push(lines[j]);
    let flat = body.join(' ').replace(/[;&|'"#\r]/g, ' ');
    // 結束標記加了引號（<<'EOF'、<<"EOF"）＝主體不展開，裡面的 $( 與反引號只是字，不當成命令替換
    if (m[1] || m[2]) flat = flat.replace(/\$\(/g, '$ (').replace(/`/g, ' ');
    const at = m.index + m[0].length;
    out.push(line.slice(0, at) + ' ' + flat + ' ' + line.slice(at));
    i = j;
  }
  return out.join('\n');
}

// 依 ; && || | & 換行切段（引號內不切；2>&1、&> 不算分隔；未加引號的 # 之後是註解）。
function splitSegments(cmd) {
  const segs = [];
  let cur = '';
  let q = null;
  const push = (pipeNext) => { segs.push({ text: cur, pipeNext }); cur = ''; };
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (q) {
      cur += ch;
      if (ch === q) q = null;
      else if (ch === '\\' && q === '"' && i + 1 < cmd.length) cur += cmd[++i];
      continue;
    }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if (ch === '\\' && i + 1 < cmd.length && cmd[i + 1] !== '\n') { cur += ch + cmd[++i]; continue; }
    if (ch === '#' && (cur === '' || /\s$/.test(cur))) {
      while (i + 1 < cmd.length && cmd[i + 1] !== '\n') i++;
      continue;
    }
    if (ch === '\n' || ch === ';') { push(false); continue; }
    if (ch === '&') {
      if (cmd[i - 1] === '>' || cmd[i + 1] === '>') { cur += ch; continue; }
      if (cmd[i + 1] === '&') i++;
      push(false);
      continue;
    }
    if (ch === '|') {
      if (cmd[i + 1] === '|') { i++; push(false); } else push(true);
      continue;
    }
    cur += ch;
  }
  push(false);
  return segs;
}

// 取該段的動詞（略過前綴環境變數與 sudo／env 之類的前綴，去路徑、去 .exe）。
function verbOf(seg) {
  let t = seg.trim().replace(/^[({]+\s*/, '');
  for (;;) {
    // env 的選項（-i、-u X）也是前綴的一部分，否則 `env -u X kubectl …` 的動詞會被認成 -u
    const m = PREFIX_STEP_RE.exec(t);
    if (!m) break;
    t = t.slice(m[0].length);
  }
  const w = /^(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(t);
  if (!w) return { verb: '', rest: t };
  const verb = String(w[1] || w[2] || w[3]).split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, '');
  return { verb, rest: t };
}

function isMention(verb, rest) {
  if (!MENTION_VERBS.has(verb)) return false;
  if (verb === 'find' && /\s-(exec|execdir|ok|delete)\b/.test(rest)) return false;
  return true;
}

// 段首指令本身會把引號字串當程式執行 → 引號內容要納入比對。
const DB_CLIENTS = new Set(['psql', 'mysql', 'sqlcmd', 'mongosh', 'mongo', 'sqlite3', 'invoke-sqlcmd']);
const EVAL_ALWAYS = new Set(['eval', 'iex', 'invoke-expression', 'ssh']);
function evaluatesQuoted(verb, rest) {
  if (DB_CLIENTS.has(verb) || EVAL_ALWAYS.has(verb)) return true;
  if ((verb === 'node' || verb === 'bun') && /\s(?:-e|-p|--eval|--print)(?=[\s=]|$)/.test(rest)) return true;
  if (/^(?:python[0-9.]*|py)$/.test(verb) && /\s-c(?=\s|$)/.test(rest)) return true;
  if ((verb === 'ruby' || verb === 'perl') && /\s-[A-Za-z]*e(?=\s|$)/.test(rest)) return true;
  if (verb === 'php' && /\s-r(?=\s|$)/.test(rest)) return true;
  if (verb === 'deno' && /^\S+\s+eval\b/.test(rest)) return true;
  return false;
}

// 把段首指令名之後所有引號內的內容清空（保留引號本身），讓規則只看得到未加引號的部分。
function maskQuoted(t) {
  const head = (/^(?:"[^"]*"|'[^']*'|\S+)/.exec(t) || [''])[0];
  let out = head;
  let q = null;
  for (let i = head.length; i < t.length; i++) {
    const ch = t[i];
    if (q) {
      if (ch === q) { q = null; out += ch; } else if (ch === '\\' && q === '"') i++;
      continue;
    }
    if (ch === '"' || ch === "'") { q = ch; out += ch; continue; }
    out += ch;
  }
  return out;
}

// 命令替換 `$(…)`／反引號裡的指令會真的執行，不管外層是什麼動詞（`echo "$(git push)"` 會推送）。
// 單引號裡與跳脫過的（`'$(x)'`、`\$(x)`）是字面文字，不執行。
// 逐字元掃：只有不在單引號裡時才認 `$(`，並以括號深度配對取出完整內容——替換裡面的引號原樣保留
// （`echo "$(psql -c 'DROP TABLE x')"` 取出的是 `psql -c 'DROP TABLE x'`，SQL 不能被當成字面剔掉）。
function substitutions(text) {
  const out = [];
  let q = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q === "'") { if (ch === "'") q = null; continue; }
    if (ch === '\\') { i++; continue; }
    if (ch === "'" && q === null) { q = "'"; continue; }
    if (ch === '"') { q = q === '"' ? null : '"'; continue; }
    if (ch === '$' && text[i + 1] === '(') {
      let depth = 0;
      let iq = null;
      let j = i + 1;
      for (; j < text.length; j++) {
        const c = text[j];
        if (iq) { if (c === iq) iq = null; else if (c === '\\' && iq === '"') j++; continue; }
        if (c === '\\') { j++; continue; }
        if (c === "'" || c === '"') { iq = c; continue; }
        if (c === '(') depth++;
        else if (c === ')' && --depth === 0) break;
      }
      const inner = text.slice(i + 2, j).trim();
      if (inner) out.push(inner);
      i = j;
      continue;
    }
    if (ch === '`') {
      const j = text.indexOf('`', i + 1);
      if (j < 0) break;
      const inner = text.slice(i + 1, j).trim();
      if (inner) out.push(inner);
      i = j;
    }
  }
  return out;
}

// 殼包裝（`bash -c '…'`、`cmd /c "…"`、`powershell -Command "…"`）的內層指令。取法依殼而不同：
//   bash 系（bash／sh／zsh／dash）：-c 後面「一個詞」就是指令，之後的是 $0、$1…；加引號就自己配對引號拿內容，
//     沒加引號（`bash -c pytest`）就是那個詞。後面接引數或重導向（`_ arg`、`> "out.log" 2>&1`）都不影響。
//   cmd 的 /c、/k（Git Bash 上寫成 //c、//k）與 PowerShell 的 -Command：後面「整串」都是指令（`cmd /c kubectl apply -f prod.yaml`）；
//     整串剛好是一個加引號的字串時取引號內容。
// 以前用「一路比對到行尾」的正則，每多一種尾巴寫法就漏一次。沒有 -c 就回 null。
function wrapperInner(rest, verb) {
  // 依殼的種類找它自己的「執行指令」旗標（找第一個像旗標的會被 PowerShell 的 -exec 先命中而整個不拆）：
  //   bash 系：-c，可與其他短旗標合寫（-lc、-ec），大小寫有別（-C 是別的旗標）
  //   cmd：/c、/k；Git Bash（MSYS）上要寫成 //c（單斜線會被轉成路徑、內層不執行），兩種都認
  //   PowerShell：-Command 的任何前綴縮寫（-c、-Com、-comm），前面可以是 - 、-- 或 //，不分大小寫；
  //   -EncodedCommand（-e、-ec、-enc…）解碼後就是指令；powershell.exe 不帶旗標時第一個位置引數就是指令
  const v = String(verb || '').toLowerCase().replace(/\.exe$/, '');
  // 與語法樹路徑同一套判準：從殼名後面開始，只在連續的旗標區裡找；碰到腳本名（或 pwsh 的位置引數、-File）就停——
  // 腳本名之後的 `-c` 是腳本自己的參數（`bash release.sh -check …`、`powershell -File x.ps1 -c …`）
  const tok = /("[^"]*"|'[^']*'|[^\s]+)/g;
  const words = [];
  let t;
  while ((t = tok.exec(rest))) words.push({ w: t[1], end: t.index + t[0].length, start: t.index });
  if (words.length && words[0].w.replace(/^["']|["']$/g, '').split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, '') === v) words.shift();
  let i = null;
  if (/^(?:bash|sh|zsh|dash)$/.test(v)) {
    for (let k = 0; k < words.length; k++) {
      const w = words[k].w;
      if (/^-[A-Za-z]*c[A-Za-z]*$/.test(w)) { i = words[k].end; break; }
      if (/^[-+][oO]$/.test(w) || /^--(?:rcfile|init-file)$/.test(w)) { k++; continue; }
      if (w === '--' || !/^[-+]/.test(w)) break;
    }
  } else if (v === 'cmd') {
    const hit = words.find((x) => /^\/{1,2}[ck]$/i.test(x.w));
    if (hit) i = hit.end;
  } else if (v === 'powershell' || v === 'pwsh') {
    for (let k = 0; k < words.length; k++) {
      const w = words[k].w;
      if (/^(?:-{1,2}|\/{1,2})c(?:o(?:m(?:m(?:a(?:n(?:d)?)?)?)?)?)?$/i.test(w)) { i = words[k].end; break; }
      if (/^(?:-{1,2}|\/{1,2})e(?:c|n[a-z]*)?$/i.test(w)) {
        try { return words[k + 1] ? Buffer.from(words[k + 1].w, 'base64').toString('utf16le') : null; } catch (e) { return null; }
      }
      if (/^(?:-{1,2}|\/{1,2})(?:f|fi|fil|file)$/i.test(w)) return null;          // 腳本檔內容看不到
      // 會吃值的旗標認完整的前綴縮寫（-wi、-inp、-ou…）；下一個詞不是旗標才當成它的值；
      // pwsh 的 -i 是 -Interactive，不吃值（powershell.exe 的 -i 才是 InputFormat）
      if (/^(?:-{1,2}|\/{1,2})(?:ex\w*|ep|w(?:i(?:n\w*)?)?|v(?:e\w*)?|i(?:n(?:p\w*)?)?|o(?:u(?:t\w*)?)?|psc\w*|conf\w*|cus\w*|sett\w*|wd|workingd\w*)$/i.test(w) &&
          !(v === 'pwsh' && /^(?:-{1,2}|\/{1,2})i$/i.test(w))) {
        if (words[k + 1] && !/^[-\/]/.test(words[k + 1].w)) k++;
        continue;
      }
      if (/^(?:-{1,2}|\/{1,2})\w/.test(w)) continue;
      // 第一個位置引數：powershell.exe 預設是 -Command，pwsh 預設是 -File
      if (v === 'powershell') i = words[k].start;
      break;
    }
  } else {
    const m = /\s(?:-[A-Za-z]*c|\/{1,2}[ck]|-command)\s+/i.exec(rest);
    if (m) i = m.index + m[0].length;
  }
  if (i === null) return null;
  const tail = rest.slice(i).trim();
  const quoted = (s) => {
    const q = s[0];
    if (q !== '"' && q !== "'") return null;
    let body = '';
    for (let k = 1; k < s.length; k++) {
      const ch = s[k];
      if (ch === q) return { body, end: k + 1 };
      // 雙引號裡的反斜線只跳脫 $ ` " \ 與換行，其他字元前的反斜線原樣保留（bash 的規則）
      if (ch === '\\' && q === '"' && k + 1 < s.length && '$`"\\\n'.includes(s[k + 1])) { body += s[++k]; continue; }
      body += ch;
    }
    return null;
  };
  if (/^(?:cmd|powershell|pwsh)$/.test(verb || '')) {
    const qd = quoted(tail);
    return qd && !tail.slice(qd.end).trim() ? qd.body : tail;
  }
  const qd = quoted(tail);
  if (qd) return qd.body;
  const w = /^[^\s;&|<>]+/.exec(tail);
  return w ? w[0] : null;
}

// find -exec／-execdir／-ok／-okdir 與 xargs 會執行後面接的指令（`find . -exec pytest {} \\;`、`ls | xargs pytest`），
// 拆出那段指令當成一條新指令判；`{}` 佔位與結尾的 `\\;`／`+` 去掉。xargs 的選項（會吃值的 -n／-I／-L／-P／-d／-E／-s／-a）跳過。
function runnerCommands(seg) {
  const out = [];
  // 只看段首的動詞（去掉 X=v、sudo、env、nice、nohup、timeout N 這類前綴）：
  // `man xargs`、`grep -r xargs src` 裡的 xargs 只是字，不是在執行後面的東西
  const lead = seg.trim().replace(LEAD_RE, '');
  const head = (lead.split(/\s+/)[0] || '').split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, '');
  if (head === 'find') {
    // 終止符是字面的 `\;`、`;` 或 `+`；每個 -exec 各自一條（`-exec a \; -exec b \;` 是兩條，不能合併）
    for (const m of lead.matchAll(/(?:^|\s)-(?:exec|execdir|ok|okdir)\s+([\s\S]*?)(?:\s(?:\\;|;|\+)(?=\s|$)|$)/g)) {
      const c = m[1].replace(/(^|\s)\{\}(?=\s|$)/g, ' ').trim();
      if (c) out.push(c);
    }
  } else if (head === 'xargs') {
    const w = lead.split(/\s+/);
    let k = 1;
    while (k < w.length && w[k].startsWith('-')) k += /^-[nILPdEsa]$/.test(w[k]) ? 2 : 1;
    const c = w.slice(k).join(' ').trim();
    if (c) out.push(c);
  }
  return out;
}

// 回傳「實際會執行的部分」兩份：raw（原文，取環境變數用）與 masked（規則比對用，一般程式的引號內容已清空）。
// 一條指令一行；包裝指令拆開內層遞迴再判。
function executedText(cmd, depth) {
  // 反斜線續行（`kubectl \` 換行 `apply …`）是同一條指令，先接回，否則換行會被當成分段
  const segs = splitSegments(depth === 0 ? foldHeredocs(cmd.replace(/\\\r?\n/g, ' ')) : cmd);
  const keep = new Array(segs.length).fill(true);
  const feeds = new Array(segs.length).fill(false);
  // 由右往左：只印字的段落若管線接給會被保留的段落，它就是輸入來源，照樣保留（而且整段原文算數）。
  for (let i = segs.length - 1; i >= 0; i--) {
    const { verb, rest } = verbOf(segs[i].text);
    if (!segs[i].text.trim()) { keep[i] = false; continue; }
    feeds[i] = segs[i].pipeNext && i + 1 < segs.length && keep[i + 1];
    if (isMention(verb, rest) && !feeds[i]) keep[i] = false;
  }
  // 同一條管線的段落接在同一行（`echo "…" | psql` 要能被當成一個單位比對），不同指令各佔一行。
  let raw = '';
  let masked = '';
  let prevPiped = false;
  for (let i = 0; i < segs.length; i++) {
    if (!keep[i]) { prevPiped = false; continue; }
    const t0 = segs[i].text.trim();
    const { verb, rest } = verbOf(t0);
    let pRaw = t0;
    let pMasked;
    const inner = WRAPPERS.has(verb) && depth < 3 ? wrapperInner(rest, verb) : null;
    if (inner !== null) {
      const sub = executedText(inner, depth + 1);
      // 外層的前綴（`NODE_ENV=test bash -c '…'`）內層每條指令都繼承，一起帶上
      const pre = t0.slice(0, t0.length - rest.length) + verb + ' ';
      pRaw = pre + sub.raw.replace(/\n/g, '\n' + pre);
      pMasked = pre + sub.masked.replace(/\n/g, '\n' + pre);
    } else if (feeds[i] || evaluatesQuoted(verb, rest)) {
      pMasked = t0;
    } else {
      // 前綴（環境變數賦值、sudo…）原樣保留，只遮指令名之後的引號內容。
      pMasked = t0.slice(0, t0.length - rest.length) + maskQuoted(rest);
    }
    const sep = raw === '' ? '' : (prevPiped ? ' | ' : '\n');
    // 在管線裡、但管線另一端被當成只印字剔掉了（`export X=1 | cat`）：原文補上 ' | '，
    // 讓 envValueAt 仍認得「這段跑在子殼、設定不回到外層」
    const lonePipe = (segs[i].pipeNext && !(i + 1 < segs.length && keep[i + 1])) || (i > 0 && segs[i - 1].pipeNext && !keep[i - 1]);
    raw += sep + pRaw + (lonePipe ? ' | ' : '');
    masked += sep + pMasked;
    prevPiped = segs[i].pipeNext;
  }
  // 各段（含被判成只印字而剔除的段）裡的命令替換，以及 find -exec／xargs 要執行的指令，拆出來各自成行
  if (depth < 3) {
    for (const s of segs) {
      for (const inner of substitutions(s.text).concat(runnerCommands(s.text))) {
        const sub = executedText(inner, depth + 1);
        if (!sub.raw.trim()) continue;
        // 原文前面標上 sh 脈絡：替換跑在子殼裡，裡面的 export／unset 不會回到外層（envValueAt 靠脈絡分辨）
        raw += (raw === '' ? '' : '\n') + sub.raw.split('\n').map((l) => 'sh ' + l).join('\n');
        masked += (masked === '' ? '' : '\n') + sub.masked;
      }
    }
  }
  return { raw, masked };
}

// 把一段指令切成詞，引號拿掉並接起來（`loc"al"` → `local`、`"cfg dir/.env"` → `cfg dir/.env`）。
function words(s) {
  const out = [];
  for (const m of String(s).matchAll(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)) {
    out.push(m[0].replace(/"([^"]*)"|'([^']*)'/g, (x, a, b) => (a !== undefined ? a : b)));
  }
  return out;
}

// 被 bash -c／cmd /c／powershell -Command 展開的內層指令，行首帶著「外層前綴＋包裝名」（`X=1 bash …`）。
// 這段前綴就是它的包裝脈絡：子殼裡的設定不會回到外層，外層已匯出的會傳進子殼。
// 殼名前面可以有賦值與前綴程式（`env bash -c '…'`、`sudo -u x bash -c '…'`），由共用常數產生。
const CTX_RE = new RegExp('^(?:(?:(?:' + ASSIGN_SRC + '|' + RUNNER_PREFIX_SRC + ')\\s+)*(?:bash|sh|zsh|dash|cmd|powershell|pwsh)\\s+)*', 'i');
function ctxOf(line) {
  return CTX_RE.exec(line.trim())[0];
}

// 指令本身的前綴（`X=v cmd`、`env -u X cmd`、`env -i cmd`、包裝展開後的 `X=1 bash Y=2 cmd`），交給 envValueAt 依序套用。
// 引數裡長得像賦值的字串（`node server.js 'NODE_ENV=test'`）不在前綴裡，不算。
function prefixOf(line) {
  const m = ENV_PREFIX_RE.exec(line.trim());
  return m ? m[0] : '';
}

// 指令載入的環境檔：source <檔>、. <檔>、node --env-file=<檔>／--env-file <檔>（依出現順序，後者覆蓋前者）。
// 相對路徑的基準＝同一條指令裡、該環境檔之前的切目錄動作（cd／pushd／popd／Set-Location／sl／chdir）累積出來的目錄：
// 相對 cd 疊加、絕對 cd 取代；`cd -`、`cd ~`、不帶引數、含變數（$／%）等判讀不了的，退回專案根。
// 沒有任何切目錄動作時，依序試 hook 收到的 cwd 與專案根。
// 為什麼要追 cd：`cd api && node --env-file=.env.test …` 的環境檔在 api/ 底下，
// 對專案根解析會找不到（或找到別套的同名檔），把環境正確的指令誤擋——冷啟交叉驗證實際抓到。
function envFilesOf(command, startDir, root) {
  const out = [];
  const stack = [];
  let dir = null;
  // 路徑可加引號，引號內可含空白（`--env-file="./config files/.env.test"`）
  const re = /(?:^|[\s;&|(])(?:(cd|pushd|popd|set-location|sl|chdir)(?:\s+-(?:literal)?path)?(?:\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|"')]+)))?(?=\s*(?:$|[;&|)\n]))|(?:source|\.)\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|"']+))|--env-file(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s;&|"']+)))/gi;
  for (const m of command.matchAll(re)) {
    if (m[1]) {
      const verb = m[1].toLowerCase();
      if (verb === 'popd') { dir = stack.length ? stack.pop() : null; continue; }
      if (verb === 'pushd') stack.push(dir);
      let t = m[2] || m[3] || m[4];
      if (!t || t === '-' || /^~|[$%]/.test(t)) { dir = root; continue; }
      if (process.platform === 'win32') t = t.replace(/^\/([A-Za-z])(?=\/|$)/, '$1:');
      dir = path.resolve(dir === null ? startDir : dir, t);
      continue;
    }
    const envFileArg = m[8] || m[9] || m[10];
    const file = m[5] || m[6] || m[7] || envFileArg;
    if (file) out.push({ file, bases: dir === null ? [startDir, root] : [dir], at: m.index, envFile: !!envFileArg });
  }
  return out;
}

// `node --env-file=x server.js` 的 --env-file 是 Node 的選項；`node server.js --env-file=x` 則是傳給 server.js 的引數，
// Node 不會載入那個檔。before＝指令從頭到 --env-file 出現處為止：去掉前綴後，node 之後若已經出現非選項的詞
// （腳本名），這個 --env-file 就不算。會吃掉下一個詞當值的選項（-r x、--import x）要跳過它的值——
// 清單收常見的；清單以外、以空白隔開值的選項會把值誤認成腳本名而多擋（寫成 --flag=value 就不受影響）。
// 不是 node 開頭的（例如 tsx、bun 自己也認 --env-file）照舊算。
function envFileIsNodeOption(before) {
  const w = words(before.trim().slice(prefixOf(before).length));
  if (!w.length || !/^node(\.exe)?$/i.test(w[0].split(/[\\/]/).pop())) return true;
  const takesValue = /^(?:-r|--require|--import|--loader|--experimental-loader|--env-file|--env-file-if-exists|--inspect-port|-C|--conditions|--title|--input-type|--cpu-prof-dir|--cpu-prof-name|--heap-prof-dir|--heap-prof-name|--diagnostic-dir|--report-dir|--report-directory|--report-filename|--redirect-warnings|--openssl-config|--icu-data-dir|--trace-event-categories|--trace-event-file-pattern|--watch-path|--test-name-pattern|--test-reporter|--test-reporter-destination|--test-shard|--test-concurrency|--test-timeout)$/;
  for (let k = 1; k < w.length; k++) {
    if (!w[k].startsWith('-')) return false;
    if (takesValue.test(w[k])) k++;
  }
  return true;
}

// 第 i 條指令執行時，那個程式實際拿到的變數值（lines＝逐條指令的原文；ownText＝管線裡真正要判的那個指令）。
// 照 bash 的語意逐行模擬外層殼的狀態——值、是否匯出給子程序、allexport（set -a）——而不是抓字串：
//   · 繼承的環境變數一開始就是「已匯出」。
//   · `export X=v`／`export X`／`declare -x`／`typeset -x`：設值並匯出；`export -n X`：取消匯出。
//   · `X=v`（整段只有賦值、後面沒指令）：只設 shell 變數，除非 X 早已匯出或 set -a 開著，否則子程序看不到。
//   · `source <檔>`／`. <檔>`：檔內的 `export X=v` 會匯出，沒寫 export 的只是 shell 變數（同上）。
//   · `unset X`／`Remove-Item Env:X`：清掉。cmd 的 `set X=v`、PowerShell 的 `$env:X = 'v'`：直接設進環境。
//   · 管線裡的段落與別的包裝脈絡（子殼）裡的設定，不回到外層。
//   · 這條指令自己的前綴（`X=v cmd`、`env -u X cmd`、`env -i cmd`，含外層包裝帶進來的）最後套用。
//   · 這條自己的 `node --env-file=<檔>`：Node 不讓它覆蓋已存在的變數，只補還沒有的。
// 後面的指令、前面只作用在單一指令的 `X=v cmd`、引數裡的字串都不影響結果。
function envValueAt(lines, i, name, startDir, root, ownText) {
  const cur = ownText !== undefined ? ownText : lines[i];
  const ctx = ctxOf(lines[i]);
  const text = lines.slice(0, i).concat([cur]).join('\n');
  const lineStart = text.length - cur.length;
  const starts = [];
  let off = 0;
  for (let j = 0; j < i; j++) { starts.push(off); off += lines[j].length + 1; }
  // 環境檔的比對位置可能落在前一行結尾的換行字元上（正則以分隔字元起頭），往後挪一格再歸行
  const lineOf = (at) => {
    const p = /[\s;&|(]/.test(text[at] || '') ? at + 1 : at;
    let k = -1;
    for (let j = 0; j < starts.length; j++) if (p >= starts[j]) k = j;
    return k;
  };
  const files = envFilesOf(text, startDir, root);
  const readEnvFile = (f) => {
    for (const base of f.bases) {
      try {
        // 註解行（`# NODE_ENV=test`）不是設定
        return fs.readFileSync(path.resolve(base, f.file), 'utf8').split(/\r?\n/).filter((l) => l.trim() && !/^\s*#/.test(l));
      } catch (e) { /* 讀不到就換下一個候選位置 */ }
    }
    return null;
  };
  const valueIn = (word) => (word.startsWith(name + '=') ? word.slice(name.length + 1) : undefined);

  // 繼承的變數就算是空字串也算「存在」：Node 的 --env-file 不會覆蓋它（空值最後照未設定判）
  const inherited = process.env[name];
  let val = inherited;
  let exported = inherited !== undefined;
  let allexport = false;
  const assign = (v, exportIt) => { val = v; if (exportIt || allexport) exported = true; };

  // 外層包裝帶進來的前綴（`X=1 bash -c '…'` 的 X=1）在進入子殼時生效，之後子殼內的 export 可以蓋掉它
  let ctxApplied = false;
  const applyCtx = () => {
    if (ctxApplied) return;
    ctxApplied = true;
    if (!ctx) return;
    // 進入子殼：外層沒匯出的 shell 變數不會傳進來（`X=test; bash -c 'export X; …'` 裡的 X 是空的）
    if (!exported) val = undefined;
    applyPrefix(words(ctx));
  };

  // 依序套用一串前綴詞（`X=v`、`env -u X`、`env -i`、`sudo -u x`、`timeout 10`…）到目前的狀態。
  // 進入子殼時套外層包裝帶的前綴、最後套這條指令自己的前綴，兩處都用這一份——以前子殼那處只認賦值，
  // `env -u X bash -c '…'` 的清除就被漏掉了。
  // `X=v` 只在「指令開頭」或 `env`／`sudo`／新殼之後才是賦值；timeout／nice／nohup／exec／command 後面接的是指令，
  // `timeout 10 X=v cmd` 會把 `X=v` 當成指令名去執行（bash 實測），不是設定。
  // -i／-u X／--unset=X 只有在 env 後面才是清除變數；sudo -u postgres 的 -u 是「以誰的身分」，不是清變數。
  function applyPrefix(pw) {
    let assignOk = true;
    let runner = '';
    for (let k = 0; k < pw.length; k++) {
      const x = pw[k];
      const low = x.toLowerCase();
      if (/^(?:timeout|nice|nohup|exec|command|builtin|time)$/.test(low)) { assignOk = false; runner = low; }
      else if (/^(?:env|sudo|bash|sh|zsh|dash|cmd|powershell|pwsh)$/.test(low)) { assignOk = true; runner = low; }
      else if (runner === 'env' && (x === '-i' || x === '--ignore-environment')) { val = undefined; exported = false; }
      else if (runner === 'env' && x === '-u') { if (pw[k + 1] === name) { val = undefined; exported = false; } k++; }
      else if (runner === 'env' && x === '--unset=' + name) { val = undefined; exported = false; }
      else if (runner === 'sudo' && /^-[ugphCDrtTU]$/.test(x)) k++;
      else if (assignOk && valueIn(x) !== undefined) { val = valueIn(x); exported = true; }
    }
  }


  for (let j = 0; j < i; j++) {
    const line = lines[j];
    if (line.includes(' | ')) continue;           // 管線各段跑在子殼，設定不回到外層
    const cj = ctxOf(line);
    if (!ctx.startsWith(cj)) continue;            // 別的包裝脈絡（子殼）裡的設定不回到這裡
    if (ctx && cj === ctx) applyCtx();
    const body = line.trim().slice(cj.length).replace(/^\{\s*/, '');
    const w = words(body);
    if (!w.length) continue;
    const head = w[0].toLowerCase();
    if (head === 'unset') {
      if (w.slice(1).includes(name)) { val = undefined; exported = false; }
    } else if (head === 'remove-item') {
      if (w.slice(1).some((x) => x.toLowerCase() === 'env:' + name.toLowerCase())) { val = undefined; exported = false; }
    } else if (head === 'set' && /^[-+]a$/.test(w[1] || '')) {
      allexport = w[1] === '-a';
    } else if (head === 'set' && /^[-+]o$/.test(w[1] || '') && (w[2] || '') === 'allexport') {
      allexport = w[1] === '-o';
    } else if (head === 'set' && w.length === 2 && /\bcmd\s+$/i.test(cj) && w[1].toLowerCase().startsWith(name.toLowerCase() + '=')) {
      // 只有 cmd.exe 的 set X=v 是設環境變數；bash 的 set 是設位置參數、PowerShell 的 set 是 Set-Variable
      val = w[1].slice(name.length + 1); exported = true;
    } else if (head === 'export' || ((head === 'declare' || head === 'typeset') && w.some((x) => /^-\w*x/.test(x)))) {
      const unexport = w.some((x) => /^-\w*n/.test(x));
      for (const x of w.slice(1)) {
        if (x.startsWith('-')) continue;
        if (x === name) exported = !unexport;
        else if (valueIn(x) !== undefined) { val = valueIn(x); exported = !unexport; }
      }
    } else if (new RegExp('^\\$env:' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*=', 'i').test(body)) {
      const m = /=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/.exec(body);   // PowerShell 的 $env:X = 'v'
      if (m) { val = m[1] !== undefined ? m[1] : (m[2] !== undefined ? m[2] : m[3]); exported = val !== '$null'; if (!exported) val = undefined; }
    } else if (head === 'source' || head === '.') {
      for (const f of files) {
        if (f.envFile || lineOf(f.at) !== j) continue;
        for (const l of readEnvFile(f) || []) {
          const lw = words(l.trim());
          const isExport = lw[0] === 'export';
          const v = valueIn(isExport ? (lw[1] || '') : (lw[0] || ''));
          if (v !== undefined) assign(v, isExport);
        }
      }
    } else if (w.every((x) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(x))) {
      for (const x of w) if (valueIn(x) !== undefined) assign(valueIn(x), false);   // 整段只有賦值＝shell 變數
    }
  }

  applyCtx();
  // 這條指令自己的前綴（扣掉已在進入子殼時套用的外層包裝前綴）：依序套用，賦值直接進這個程序的環境
  const curTrim = cur.trim();
  const pw = words(prefixOf(ctx && curTrim.startsWith(ctx) ? curTrim.slice(ctx.length) : curTrim));
  applyPrefix(pw);
  if (exported && val !== undefined) return val;

  let fromEnvFile;
  for (const f of files) {
    if (!f.envFile || f.at < lineStart) continue;   // --env-file 只作用在帶它的那條指令
    if (!envFileIsNodeOption(cur.slice(0, f.at - lineStart + 1))) continue;
    for (const l of readEnvFile(f) || []) {
      const lw = words(l.trim());
      const v = valueIn(lw[0] === 'export' ? (lw[1] || '') : (lw[0] || ''));
      if (v !== undefined) fromEnvFile = v;
    }
  }
  return fromEnvFile;
}

// PowerShell 寫環境變數的方式很多，兩條路徑都只模擬得了一種：最外層（不在任何 { }、( )、字串裡）、
// 名字大小寫完全相同、值是字面值的 `$env:X = '…'`／`$env:X = $null`。同一串指令裡只要這個變數出現過其他寫法的寫入——
// Set-Item／Clear-Item／Remove-Item 等 Env: 磁碟機操作與其別名、`${env:X}`、[Environment]::SetEnvironmentVariable、
// `+=`、大小寫不同（Windows 環境變數不分大小寫）、寫在區塊或條件裡——值就模擬不出來，判成「無法確認」。
// 以真 PowerShell 對照過：這些寫法把原本正確的繼承值改壞時，逐條模擬的判法會照舊值放行。
// 只在 PowerShell 工具、或 Bash 指令裡叫了 powershell／pwsh 時才看；回傳「這個變數名是否無法確認」的函式。
function psEnvUnsure(command, tool) {
  if (tool !== 'PowerShell' && !/(^|[\s;&|("'])(?:powershell|pwsh)(?:\.exe)?\b/i.test(command)) return () => false;
  // 掃一遍：註解換成空白；記下每個位置是否在最外層程式碼（不在字串、不在任何括號裡）
  const n = command.length;
  const top = new Array(n).fill(false);
  let code = '';
  let depth = 0;
  for (let i = 0; i < n; i++) {
    const ch = command[i];
    const here = command.startsWith("@'", i) || command.startsWith('@"', i);
    if (here && /^[ \t]*\r?\n/.test(command.slice(i + 2))) {
      const close = command.indexOf('\n' + command[i + 1] + '@', i + 2);
      const end = close < 0 ? n : close + 3;
      code += command.slice(i, end);
      i = end - 1;
      continue;
    }
    if (ch === "'") {
      let j = i + 1;
      while (j < n && !(command[j] === "'" && command[j + 1] !== "'")) j += command[j] === "'" ? 2 : 1;
      code += command.slice(i, j + 1);
      i = j;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < n && command[j] !== '"') j += command[j] === '`' ? 2 : 1;
      code += command.slice(i, j + 1);
      i = j;
      continue;
    }
    if (command.startsWith('<#', i)) {
      const close = command.indexOf('#>', i + 2);
      const end = close < 0 ? n : close + 2;
      code += ' '.repeat(end - i);
      i = end - 1;
      continue;
    }
    if (ch === '#' && (i === 0 || /[\s;]/.test(command[i - 1]))) {
      let j = i;
      while (j < n && command[j] !== '\n') j++;
      code += ' '.repeat(j - i);
      i = j - 1;
      continue;
    }
    if (ch === '`') { code += command.slice(i, i + 2); i++; continue; }
    if (ch === '{' || ch === '(') depth++;
    if (ch === '}' || ch === ')') depth = Math.max(0, depth - 1);
    top[i] = depth === 0 && ch !== '}' && ch !== ')';
    code += ch;
  }
  const writes = [];   // { name, ok }
  const NAME = '([A-Za-z_][A-Za-z0-9_]*)';
  const LITERAL = /^\s*(?:'(?:[^']|'')*'|"[^"$`]*"|\$null|-?\d+(?:\.\d+)?)\s*(?:$|;|\r?\n|\|\||&&)/i;
  let m;
  const assign = new RegExp('\\$(\\{)?env:' + NAME + '(\\})?\\s*([-+*/%]?=)(?!=)', 'gi');
  while ((m = assign.exec(code))) {
    // `$env:`／`$Env:` 前綴不分大小寫（微軟文件慣用 $Env:）；變數名才要求大小寫一致
    const ok = !m[1] && m[4] === '=' && top[m.index] && /^\$env:/i.test(code.slice(m.index, m.index + 5)) && LITERAL.test(code.slice(m.index + m[0].length));
    writes.push({ name: m[2], ok });
  }
  const item = new RegExp('(?:^|[\\s;|&({])(?:set-item|si|new-item|ni|remove-item|ri|rm|del|erase|rd|rmdir|clear-item|cli|rename-item|rni|move-item|mi|move|mv|copy-item|cpi|copy|cp|set-content|sc|add-content|ac|clear-content|clc)\\b[^;\\n|]*?env:\\\\?' + NAME, 'gi');
  while ((m = item.exec(code))) writes.push({ name: m[1], ok: false });
  const api = new RegExp('SetEnvironmentVariable\\s*\\(\\s*[\'"]' + NAME, 'gi');
  while ((m = api.exec(code))) writes.push({ name: m[1], ok: false });
  // Env: 磁碟機被 $env:／${env:} 變數語法以外的方式碰到（New-Item -Path Env: -Name X、gci Env:X | Remove-Item、
  // Set-Location Env:……），或 SetEnvironmentVariable 的名字不是字面值：改的是哪個變數從字面看不出來，
  // 所有環境變數一律判成無法確認
  const anyDrive = /(^|[\s'"(=,;|&])env:/i.test(code);
  const anyApi = /SetEnvironmentVariable\s*\(\s*(?!['"][A-Za-z_])/i.test(code) ||
    // iex／Invoke-Expression 的引數不是字面字串、或 [scriptblock]::Create(…)：在目前的工作階段執行看不到的程式碼
    /\[scriptblock\]\s*::\s*create\s*\(/i.test(code) ||
    /(^|[\s;|&({])(?:iex|invoke-expression)\s+(?!'[^']*'\s*(?:$|[;|&)}]))(?!"[^"$`]*"\s*(?:$|[;|&)}]))/i.test(code);
  const f = (name) => anyDrive || anyApi ||
    writes.some((w) => w.name.toLowerCase() === String(name).toLowerCase() && !(w.ok && w.name === name));
  f.fromBash = tool !== 'PowerShell';
  return f;
}

function envUnsureMsg(name) {
  if (envUnsure.fromBash) {
    return name + ' 的值無法確認：這是 Bash 指令裡叫起的 PowerShell，它改環境變數的寫法從外面驗不了；' +
      '要帶值請在 bash 這一側用 export ' + name + '=… 或前綴 ' + name + '=… 帶給它';
  }
  return name + " 的值無法確認：這串指令用了 $env:" + name + " = '…'（寫在最外層、名字大小寫一致、值為字面值）以外的方式改它";
}
// 語法樹路徑：前面有「可能發生過、也可能沒有」的設定（條件區段、函式本體裡的 export／unset／cd／source）
function condUnsureMsg(name) {
  return name + ' 的值無法確認：前面有只在條件成立時才會執行、或看不出何時執行的設定（if／&&／||／迴圈／函式裡的 export、unset、set -a、cd、source）；' +
    '在這條指令前面直接帶值（' + name + '=… <指令>），或把設定改成一定會執行的寫法再跑';
}
// 語法樹路徑：前面有看不到內容的寫入（eval "$(…)"、source <(…)、read、printf -v、指令名是變數……）
function opaqueMsg(name) {
  return name + ' 的值無法確認：前面有看不到內容的寫入（eval 展開、source <(…)、read、printf -v 之類），不知道它有沒有改到 ' + name + '；' +
    '在這條指令前面直接帶字面值（' + name + '=<值> <指令>）即可——字面值不受前面影響（引用 $' + name + ' 的寫法仍無法確認）';
}
// 主流程依本串指令設定；兩條路徑取環境值時先問它
let envUnsure = () => false;

// 語法解析器路徑（shell-model.js＋npm 裝在 .claude/hooks/node_modules 的 tree-sitter）。
// 模組缺、解析器沒裝、載入失敗、設 HARNESS_SHELL_PARSER=off、語法樹有錯誤節點時回 null，呼叫端改走正則路徑——準確度較低，但不會整個失效。
function analyzeWithParser(command, tool, startDir, root) {
  try {
    const sm = require('./shell-model.js');
    const a = sm.analyze(command, tool === 'PowerShell' ? 'PowerShell' : 'Bash', startDir, root);
    // 語法樹有錯誤節點＝這串沒被完整認出來（PowerShell 文法連 ./deploy.ps1 都解析成錯誤），整串改走正則路徑
    return a && !a.hasError ? a : null;
  } catch (e) {
    return null;
  }
}

// 正則路徑（沒有語法解析器時）：原本的判法，照舊保留。
function regexHits(command, startDir, root, hits) {
  const ex = executedText(command, 0);
  if (!ex.raw.trim()) return;

  const rawLines = ex.raw.split('\n');
  const maskedLines = ex.masked.split('\n');

  for (const r of RULES) {
    try {
      if (!r || !r.when) continue;
      const lines = r.matchQuoted ? rawLines : maskedLines;
      // 逐條指令判：when／unless／環境都只看命中的那一條（環境另計前面已持續生效的設定）。
      let hit = false;
      let envProblems = null;
      for (let i = 0; i < lines.length && !hit; i++) {
        const whenRe = new RegExp(r.when, 'im');
        if (!whenRe.test(lines[i])) continue;
        // when 命中的那一個管線元素；when 要合看整條管線才命中時，退回整條
        const parts = lines[i].split(' | ');
        const scope = parts.filter((p) => whenRe.test(p));
        if (r.unless) {
          const unlessRe = new RegExp(r.unless, 'im');
          if (scope.length ? scope.every((p) => unlessRe.test(p)) : unlessRe.test(lines[i])) continue;
        }
        if (r.requireEnv && typeof r.requireEnv === 'object') {
          const probs = [];
          for (const [name, want] of Object.entries(r.requireEnv)) {
            // 管線裡每個命中 when 的指令各自驗（前綴與 --env-file 只給它自己）。
            // 比對用遮罩版找出是第幾個元素，取值用同位置的原文；兩邊切不齊（原文引號裡有 ' | '）就退回整行。
            const rawParts = rawLines[i].split(' | ');
            const idxs = scope.length ? parts.map((p, k) => (whenRe.test(p) ? k : -1)).filter((k) => k >= 0) : [0];
            for (const k of idxs) {
              const target = rawParts.length === parts.length ? rawParts[k] : rawLines[i];
              const val = envValueAt(rawLines, i, name, startDir, root, target);
              let msg = null;
              if (envUnsure(name)) msg = envUnsureMsg(name);
              else if (val === undefined || val === '') msg = name + ' 未設定（期望符合 /' + want + '/）';
              else if (!new RegExp(want, 'i').test(val)) msg = name + '="' + val + '" 不符期望 /' + want + '/';
              if (msg && !probs.includes(msg)) probs.push(msg);
            }
          }
          if (!probs.length) continue;
          envProblems = probs;
        }
        hit = true;
      }
      if (hit) hits.push({ r, envProblems });
    } catch (e) {
      process.stderr.write('[' + LABEL + '] 規則 ' + (r && r.id) + ' 無法套用（' + e.message + '），已略過——請修規則。\n');
    }
  }
}

// 語法樹路徑：每條管線一行比對 when；unless 只看命中的那個指令；requireEnv 對命中的每個指令取它實際拿到的環境值
function astHits(a, hits) {
  for (const r of RULES) {
    try {
      if (!r || !r.when) continue;
      const whenRe = new RegExp(r.when, 'im');
      const pick = (x) => (r.matchQuoted ? x.raw : x.masked);
      let hit = false;
      let envProblems = null;
      for (const line of a.lines) {
        if (!whenRe.test(pick(line))) continue;
        const scope = line.parts.filter((p) => whenRe.test(pick(p)));
        if (r.unless) {
          const unlessRe = new RegExp(r.unless, 'im');
          if (scope.length ? scope.every((p) => unlessRe.test(pick(p))) : unlessRe.test(pick(line))) continue;
        }
        if (r.requireEnv && typeof r.requireEnv === 'object') {
          const probs = [];
          for (const t of (scope.length ? scope : line.parts)) {
            for (const [name, want] of Object.entries(r.requireEnv)) {
              // 條件分支會讓值有好幾種可能：每一種都要符合才放行
              const info = a.envInfo(t.exec, name);
              let msg = null;
              if (envUnsure(name)) msg = envUnsureMsg(name);
              else if (info.unsure) msg = info.opaque ? opaqueMsg(name) : condUnsureMsg(name);
              else {
                const tail = info.values.length > 1 ? '（前面有條件式設定，其中一種情況）' : '';
                for (const val of info.values) {
                  if (val === undefined || val === '') msg = name + ' 未設定' + tail + '（期望符合 /' + want + '/）';
                  else if (!new RegExp(want, 'i').test(val)) msg = name + '="' + val + '"' + tail + ' 不符期望 /' + want + '/';
                  if (msg) break;
                }
              }
              if (msg && !probs.includes(msg)) probs.push(msg);
            }
          }
          if (!probs.length) continue;
          envProblems = probs;
        }
        hit = true;
        break;
      }
      if (hit) hits.push({ r, envProblems });
    } catch (e) {
      process.stderr.write('[' + LABEL + '] 規則 ' + (r && r.id) + ' 無法套用（' + e.message + '），已略過——請修規則。\n');
    }
  }
}

let raw = '';
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  const hits = [];
  try {
    const input = JSON.parse(raw);
    const command = String((input.tool_input || {}).command || '');
    if (!command || !RULES.length) process.exit(0);
    const root = process.env.CLAUDE_PROJECT_DIR || path.resolve(__dirname, '..', '..');
    const startDir = input.cwd || root;
    envUnsure = psEnvUnsure(command, input.tool_name);
    // 有語法解析器就用語法樹判；沒有才走正則路徑
    const analysis = analyzeWithParser(command, input.tool_name, startDir, root);
    if (analysis) astHits(analysis, hits);
    else regexHits(command, startDir, root, hits);
  } catch (e) {
    process.exit(0);
  }
  if (!hits.length) process.exit(0);

  const reason = '[' + LABEL + '] 這條指令命中 ' + hits.length + ' 條規則：\n\n' +
    hits.map(({ r, envProblems }) =>
      '  - [' + (r.id || '未命名') + '] ' + (r.reason || '') +
      (envProblems ? '\n      環境：' + envProblems.join('；') : '') +
      '\n      放行方式：' + (r.fix || '請先向使用者確認。')).join('\n\n') +
    '\n\n規則表在 .claude/hooks/guard-risky-command.js 的 RULES。若判斷是規則錯擋，回報使用者改規則；' +
    '不要改寫指令字面去繞過（換包裝、拆變數），那等於把守門關掉。';
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
});
