## Phase 5 — 驗收（兩層，任一項失敗＝init 未完成）

### 第一層：靜態十三項

**先跑腳本，再做腳本做不到的**：

```
node <本 plugin>/skills/init/scripts/init-verify.js <落點>
```

每項印一行 `<id> | PASS／FAIL／SKIP | <證據>`，任一 FAIL 就 exit 1。**原始輸出整段貼進收尾回報**。FAIL 回 Phase 4 修、修完整份重跑；確定是誤判（例：引用的是使用者說之後才會建的檔）才用 `init-flow.js waive <目標> <id> --match <命中內容> --reason <理由>` 登記豁免，豁免的每一筆收尾回報都要列出（V09 hook 語法、V10 settings、V12 帳密不可豁免）。

腳本做的是下面十三項裡能機械化的部分：

| 下方第幾項 | 腳本的檢查 | 腳本做不到、仍要你做的（語意項） |
|---|---|---|
| 1 變更紀錄位置 | V02 本體不留 changelog、V03 每份檔有「建立」那一行（含 skill 的最後一行與同目錄 CHANGELOG）、V04 05 節標題 | 健檢提醒的實跑（`HARNESS_TODAY` 那一段）；skill 的 description 有沒有同時寫觸發與排除條件 |
| 2 `{{` 殘留 | V01 | — |
| 3 污染詞表 | V05（命中先判斷是不是目標專案查證過的事實；是的話用 waive 登記理由） | 命中逐筆判斷 |
| 4 詞彙表檔名只有一個 | V06 | 參考模式沿用的原檔的命中逐筆列進收尾回報；流程圖到 Phase 6 才查 |
| 5 引用的路徑存在 | V07（CLAUDE.md、04、agent 檔的反引號路徑；settings 的 hook 指令路徑） | 工作流地圖雙向對、本機覆寫說明逐筆涵蓋與自檢指令實跑、addendum 實跑印出 |
| 6 03 驗證指令本體存在 | V08 | 腳本只認得 npm／node／bash／python／pytest 這幾種寫法；其他寫法照下方逐條查 |
| 7 檔尾完整、hook 語法、settings JSON | V11、V09、V10 | — |
| 8 probe-hooks 行為層、qa-gate 實跑 | — | 全部（在 `.claude/hooks/` 跑 probe-hooks；qa-gate 的 flow.sh 實跑） |
| 9 規則引擎的解析器 | — | 全部 |
| 10 B 類規則的放行方式 | — | 全部（實跑放行方式、掃盲點字樣） |
| 11 專案理解落地 | V13 概要四塊、V14 詞條數＝答案檔、V12 帳密樣式 | 概要內容與使用者改過的版本逐句一致、U1 每個外部系統的去向、Q7 過時註記 |
| 12 形狀目錄逐列對帳 | V16 每列有去向、V17 每支 hook 有接線 | B 類每個 Q2 勾選項對得到規則、Q9 欄位、restore／port 驗證實跑 |
| 13 參考模式 | — | 全部（含另派 subagent 的經驗帶走審查） |
| （新）答案檔 | V15 init-answers.json 合法、必答題齊 | — |
| （新）學習迴路 | V18 檔齊、五個事件都有接線、團隊模式 `.gitignore` 排除 learning/ | 冷啟探針 P6 |

下面是十三項的完整判準（腳本的檢查照這份寫；語意項照這份做）：

```
□ 變更紀錄位置：CLAUDE.md、.claude/harness/ 各指令檔、.claude/agents/*.md、三個知識容器本體 `grep -n "^## Changelog"` = 0 命中；
  每份實際建立的檔都在它的紀錄檔找得到「建立」那一行（harness 檔與 agent 檔在各自 CHANGELOG.md 的 `## <檔名>` 節裡，
  CLAUDE.md 與 GLOSSARY（沿用舊名時 CONTEXT）／FLOWS 在 `<檔名>.changelog.md`，PROJECT.md 在 tests/Project_Detail/CHANGELOG.md 的 `## PROJECT.md` 節）；
  `.claude/harness/CHANGELOG.md` 有 `## 05-knowledge-protocol.md` 節。這次建的每支專案 skill（Q12 與本機覆寫導向）：同目錄 `CHANGELOG.md` 有「建立」那一行、
  `SKILL.md` 最後一行是「變更紀錄見同目錄 `CHANGELOG.md`」、frontmatter 的 description 同時寫了觸發與排除條件（架構保養另要寫「使用者明說才啟動」）——
  照 05 §4.1，對**這次 init 產生的每支** skill 逐一跑 `grep -n "^## Changelog" .claude/skills/<名稱>/SKILL.md` 要 0 命中（不用 `.claude/skills/*/` 萬用字元：參考模式原封不動沿用的既有 skill 不在本項範圍，它有 changelog 節不算 init 失敗，列進收尾回報由使用者決定）。裝了健檢提醒時在 <落點> 實跑一次
  `HARNESS_TODAY=<建立日加 31 天> node .claude/hooks/health-check-reminder.js`（PowerShell：`$env:HARNESS_TODAY='<日期>'; node .claude/hooks/health-check-reminder.js`；跑完 `Remove-Item Env:HARNESS_TODAY`）：
  要印出提醒，且「紀錄來源」是 CHANGELOG.md 的 05 節——印的是 05 本體＝節標題寫錯、提醒讀到舊位置
□ grep "{{" 於所有實例檔（文件層、agent 層、容器層、hook 檔）= 0 命中（無殘留填空；hook 檔的「init 填空區」常數已填）
□ grep 污染詞表 = 0 命中（詞表＝本 plugin 的 skills/init/pollution-wordlist.txt；
  指令見 adaptation-guide §4.1；命中逐筆判斷：目標專案查證過的事實可留，骨架漏進來的來源事實要清；changelog 出處標註除外）
□ 詞彙表檔名只有一個（Phase 4 開頭的詞彙表檔名規則）：在 <落點> grep **另一個**檔名，除了下方排除項列明可保留的命中（詞彙表變更紀錄檔裡記錄「改名」的那一行、CLAUDE.md 說明改名的那段、參考模式沿用的原檔），其餘命中 = 0。實際用 `GLOSSARY.md` 時跑
  `grep -nE --exclude=CHANGELOG.md "CONTEXT\.(changelog\.)?md" CLAUDE.md .claude/harness/*.md .claude/agents/*.md tests/Project_Detail/PROJECT.md GLOSSARY.md GLOSSARY.changelog.md <這次 init 產生的每支 .claude/skills/<名稱>/SKILL.md>`；
  實際用 `CONTEXT.md` 時把樣式換成 `"GLOSSARY\.(changelog\.)?md"`、清單裡的 `GLOSSARY.md`、`GLOSSARY.changelog.md` 換成 `CONTEXT.md`、`CONTEXT.changelog.md`（沒產生專案 skill 時不列 skill 路徑）。參考模式另把原檔不動的每個原檔路徑加進清單——Phase 1 預設處置判為「沿用」、Phase 2 使用者沒改成其他處置的原檔，以及使用者在 Phase 2 改成保留原檔不動的；其中 `.claude/hooks/` 底下的原有 hook 不加（理由見下方排除項的 hook 程式碼）。它們的命中照下方排除項處理。
  流程圖（`flow-*.json`／`flow.md`）與收尾回報 `install-report.md` 要到 Phase 6 才產生，不在這項的判定範圍內：重裝時 `.claude/harness/*.md` 會掃到上一次 init 留下的舊 `flow.md`、`install-report.md`，這兩份的命中不算（`install-report.md` Phase 6 一定重產；舊 `flow.md` 在這次沒有 archify 時重產，這次有 archify 時不會重產，由 Phase 6 第 4 步當上一次的舊流程圖刪掉），流程圖改在 Phase 6 第 4 步完整性檢查時照同一個判準查。排除項：hook 程式碼（`.claude/hooks/` 不在清單內，執行時判斷照原樣兩個都認）；變更紀錄的歷史條目（`--exclude=CHANGELOG.md` 排掉 harness 與 agents 的紀錄檔；詞彙表自己的變更紀錄檔**在清單內**——標題與內文只能有實際檔名，只有記錄「改名」的那一行可以出現另一個檔名）；
  CLAUDE.md 裡說明詞彙表改名的那一段（若有）；參考模式「沿用、不動」的原檔（沿用的 agent、文件）——原檔不改，命中逐筆列進收尾回報「沿用的原檔仍寫另一個檔名：<檔:行>」，讓使用者決定要不要改。逐筆看命中內容判斷，其餘命中都要改成實際檔名再重跑。貼原始輸出
□ 實例內引用的路徑逐條 ls 存在（含路由表、必讀清單、指向既有治理層的路徑、settings 裡的 hook 指令路徑；有 07 註解規範時含它第三節設定表的檔:行；有 `.claude/git-commit-reviewer-addendum.md` 時含它寫的每支掃描工具與規範檔路徑；有 `review-rules.md` 時含它記的原檔路徑與每條出處；code-reviewer「改到哪類檔就照哪份規則審」表的每個規則來源）。
  有工作流地圖時雙向對：地圖「匝道」寫到的每支 skill 與指令都存在，`.claude/skills/`、`.claude/commands/` 底下每一個（地圖自己除外）都在地圖上。
  有本機覆寫說明時：表格涵蓋覆寫清單的每一筆（逐筆對 `path`，不抽樣）、沒有寫出任何帳密值（grep `Password=`、`pwd=`、`token=`、`://帳號:密碼@` 這類樣式 0 命中）、第 1 節的自檢指令在 <落點> 實跑一次貼原始輸出、`check-local-hacks-alive.js`（與 `remind-worktree-overrides.js`）的 `SETUP_DOC` 是它的路徑。
  有 addendum 時另實跑一次它真的會被印出來（git-commit 低於 0.10.0 時標「不適用：git-commit 版本低於 0.10.0」）。**本項用自己的暫存目錄，跑完就刪；不要與下面 qa-gate 那一項共用**——`prepare` 會拒絕 index 裡已有清單外 staged 項目的 repo，共用的話 qa-gate 那一項的 `prepare` 會 exit 1。做法：在 scratchpad 底下另建一個暫存目錄當 `<暫存根>`，形狀照下面 qa-gate 那一項的規定（與 hook 填空區的 `REPOS` 一致；`<R>` 的意思同那一項），在（子）repo 裡建一個檔並 `git add`，把 addendum 複製到 `<暫存根>/.claude/`，設 `CLAUDE_PROJECT_DIR=<暫存根>` 跑 `bash <flow.sh> prepare <R> <該檔>`——要 exit 0，輸出最後要出現「C 軌專案附加審查要求」那段標記，且內容與檔案逐字相同（印「無」＝放錯層或檔名錯）；貼原始輸出，跑完刪這個暫存目錄。Windows 上的 `bash` 要用 Git Bash：PATH 上的 bash 可能是 WSL，flow.sh 在 WSL 裡讀不到 Windows 路徑；用 `"<Git 安裝目錄>/bin/bash.exe"`，或在 Claude Code 的 Bash 工具裡跑。`<flow.sh>` 的取法同下面 qa-gate 那一項
□ 03 矩陣 B 寫入的每條驗證指令，指令本體實際存在（腳本檔在、npm script 有定義、測試目錄在）
□ 每個實例檔 Read 回檔尾確認未截斷；每支 hook `node --check` 通過；settings JSON 可解析
□ 在 <落點>/.claude/hooks/ 跑 `node probe-hooks.js`：全數符合預期、沒有「缺 cases」（這是行為層，前幾條只是結構層）；
  有 `.claude/qa-gate.conf`（git-commit 低於 0.11.0 時標「不適用：git-commit 版本低於 0.11.0」）另實跑一次 flow.sh 的 QA 閘——
  probe-hooks 只測得到 hook，權威檢查在 flow.sh，要在它身上證明。用暫存目錄（scratchpad 底下，不污染目標專案的審查紀錄）：
  **暫存目錄的形狀要跟 hook 填空區的 `REPOS` 一致**——`REPOS` 是 `['.']`（單一 repo）就在暫存目錄本身 `git init`；是 `['web', 'api']` 這類多 repo 就在暫存目錄底下照名字各建一個子 repo（都要 `git init`），下面「那個檔」放進其中一個子 repo。以下用 `<暫存根>` 指暫存目錄本身、`<R>` 指 flow.sh 的 repo 參數：單一 repo 時 `<R>` 是 `.`；多 repo 時 `<R>` 是放了那個檔的子目錄名（例 `web`），檔案路徑一律寫成相對 `<R>` 的路徑（例 `a.js`，不是 `web/a.js`）。形狀不一致的話 hook 會去查不存在的子 repo、看不到 staged，驗收必然失敗，那不是 hook 壞了。
  複製目標的 qa-gate.conf 到暫存目錄的 `.claude/`，在（子）repo 裡建一個符合 behavior_ext 的檔並 `git add`，
  設 `CLAUDE_PROJECT_DIR=<暫存根>`（多 repo 時也是暫存根，不是子 repo——設成子 repo 的話 hook 找不到 REPOS 裡的子目錄而放行，flow.sh 也會找錯路徑）後依序跑 `bash <flow.sh> prepare <R> <該檔>`（Windows 上的 `bash` 要用 Git Bash：PATH 上的 bash 可能是 WSL，flow.sh 在 WSL 裡讀不到 Windows 路徑；用 `"<Git 安裝目錄>/bin/bash.exe"`，或在 Claude Code 的 Bash 工具裡跑——它本身就是 Git Bash）、`bash <flow.sh> review-record <R> --exempt "harness-probe"`
  ——要被拒（exit 非 0，訊息是「必須帶有效的 --qa 表態」）；同一行加 `--qa "已QA：harness-probe"` 再跑——要寫入紀錄（exit 0）。
  同一個暫存目錄（那個檔仍在 staged）再對 `guard-qa-before-commit.js` 餵一次 Skill payload（`{"tool_name":"Skill","tool_input":{"skill":"git-commit"}}`，不帶 --qa-verified），
  **同樣要設 `CLAUDE_PROJECT_DIR=<暫存根>`**（hook 從它找專案根與 repo；沒設的話 hook 在目標專案的 `.claude/hooks/` 底下，會把目標專案當成專案根、看的是目標專案的 staged）：
  要擋（exit 2），而且擋下訊息的「行為類的判準來自」是那份 qa-gate.conf 的路徑——證明 hook 與 flow.sh 讀的是同一份判準；寫成「填空區」就是沒讀到。
  block_staged_overrides=1 時再補一組：`<暫存根>/.claude/local-overrides.yml` 照 git-commit 的格式列一個檔（頂層 key 自取、`repo: <R>`——單一 repo 寫 `.`，多 repo 寫那個子目錄名，寫成 `.` 會對不到子 repo 而不擋、`files:` 底下 `- path: <相對 <R> 的檔案路徑>`），
  在 `<R>` 裡 stage 它、重跑 `prepare <R> --staged` 與帶 --qa 的 review-record——要被拒（訊息是「staged 含 local-overrides 清單上的檔」），加 `--allow-overrides "harness-probe"` 才寫入。
  `<flow.sh>` 用目標專案實際載入的那份（installed_plugins.json 該筆的 installPath 底下 `skills/git-commit/flow.sh`）；貼每次的原始輸出，跑完刪暫存目錄（這一項的暫存目錄與上面 addendum 那一項各自獨立）
□ 有裝規則引擎：probe-hooks.js 開頭那行要是「語法樹路徑（Bash 與 PowerShell 解析器都已載入）」；
  `node probe-hooks.js --parser=off` 也要沒有 FAIL（標「只有語法樹路徑做得到」的案例會略過並計數）；在 <落點>（專案根目錄，不是 .claude/hooks）跑
  `node -e "const s=require('./.claude/hooks/shell-model.js');console.log(s.available('Bash'),s.available('PowerShell'))"`
  印 `true true`（任一個 false＝該文法沒裝上，對應的指令走正則判法，回報寫明）；`git check-ignore .claude/hooks/node_modules` 有輸出（不會被 commit 進去）
□ B 類每條規則的「放行方式」若是可照抄的指令：①以同一個 hook 餵回去必須放行 ②在它說的位置實際執行一次（唯讀或無害的才實跑；有副作用的只驗①並在回報裡註明）——過得了閘卻跑不起來的放行方式，照上面「訊息怎麼寫」第 2 點改寫。另掃一次 `reason`／`fix` 不得出現「看不到」「擋不住」「限制」這類引擎盲點字樣
□ 專案理解落地：CLAUDE.md 有「專案概要」節，用途、外部系統環境表（沒有外部系統時是一行「無」）、業務流程、目前進度四塊都在，且跟 Phase 2 使用者改過的版本與 U1、U2 答案一致（逐句對，不抽樣）；GLOSSARY.md（既有專案沿用 CONTEXT.md）這次新增的詞條數＝U3 確認新增的詞數（無人值守＝0，概要標「未經使用者確認」）；參考模式原有的真實條目另外照下面參考模式那一項對帳（總數＝原有＋新增－裁決刪除）；環境表有「方向」欄，U1 使用者答的每一個入向（對方主動打進來的）都在表上；U1 的每一個外部系統都有去向：正式與「不確定」的寫入動作在 Q2 候選裡出現過，測試環境的有對應的「位址不是測試環境就擋」規則或文字（無人值守時「待問」的照正式環境對）；CLAUDE.md 與 PROJECT.md 沒有帳密（grep 連線字串裡的 `://帳號:密碼@`、`Password=`、`pwd=`、`token=` 這類樣式要 0 命中，只准出現環境變數或設定鍵的名稱）；Q7 選進必讀的過時文件，在 04 的【開工前必讀】、CLAUDE.md 路由表、agent 的開工前必讀都有「（過時：…）」註記
□ 形狀目錄逐列對帳：每一列都有「已裝／不裝＋理由／由 plugin 提供」三者之一；B 類每個 Q2 勾選項、每條標了自動檢查的 Q8 條款都對得到一條規則；
  裝了本機覆寫保護時，Q9 選的每一筆都在覆寫清單裡寫上了對應欄位，並在 <落點> 跑一次 `node .claude/hooks/restore-local-hacks.js`（檢查模式、不改檔）貼原始輸出——
  needed-when 條件不成立的那幾筆要出現在「目前這個 checkout 用不到」，不能出現在「不見了」；
  裝了第 30 列（工作樹的 port 驗證）時，在 <落點> 用**填好的實際服務名**實跑三次、各貼原始輸出與結束碼（這支不是 hook，probe-hooks 只測得到範本案例）：
  (1) 參數錯誤——`node .claude/hooks/check-worktree-ports.js --ports 不存在的名字=1`：exit 2，且輸出列出可填的服務與每個 repo 的工作樹、附可直接複製的範例指令；
  (2) 沒有服務在聽——挑一個這台沒人聽的 port（先用 Phase 1 查 port 歸屬的指令確認），`--ports <某服務>=<該 port> --layers runtime`：exit 1，結果欄是「沒有服務在聽」；
  (3) 設定指標不符——挑一筆 POINTERS，`--ports <寫設定的服務>=<它的 port>,<目標服務>=<設定檔寫的值以外的 port> --layers config`：exit 1，那一列是「不一致」且說明指到正確的檔:行（不必改設定檔）；
  再用設定檔實際寫的值跑一次 `--layers config`：要 exit 0——不然就是 POINTERS 的正則跟實際寫法對不上（但書：有 POINTERS 指到建置輸出目錄裡的複本、而目前還沒建置過時，那一筆會是「讀不到檔案」——先建置一次再跑；不能建置的，那一筆標「不適用（尚未建置）」並寫明原因，其餘筆照樣要 OK，不得因此把整項算通過）。服務當下有在跑的話，另跑一次不帶 `--layers` 的完整檢查貼輸出（判「?」的項目照實寫進收尾回報，不算通過）；沒在跑就寫「未起服務，執行層的實際 listener 與 HTTP 探測未實測」。
  有裝第 19 列且填了 `PORT_CHECK_CMD`：對 `remind-worktree-overrides.js` 餵一次起服務指令的 payload，輸出要出現「起好服務之後驗 port」那一句
□ 參考模式（非參考模式標「不適用」）：①備份與原檔逐檔 hash 一致（在 Phase 4 動檔之前比，Phase 5 再比一次備份本身沒被動過）②Phase 2 處置表逐列對帳：「併入」與取代時搬過去的專案事實，內容在新檔找得到（grep 原句的關鍵詞）；「沿用」的原檔 hash 未變、接線還在；「取代」的原接線已拿掉 ③知識筆記檔條目數：新檔＝原有真實條目數＋U3 新增數－U3 裁決刪除數（`GLOSSARY.md`／`CONTEXT.md` 這份詞彙表以外的檔新增與刪除都是 0），原有條目逐條找得到（U3 裁決改寫過的找改寫後的版本；裁決刪除的在收尾回報列得出來） ④原有 CLAUDE.md 的每條規則都在處置表上有去向（逐節對，不抽樣） ⑤Q8：03 矩陣 D 的列數＝Q8 選的條數，每列有出處；標了自動檢查的，對得到一條規則且 `probe-hooks.js` 有它一擋一放的案例；原本在 CLAUDE.md、升格進 D 的條款，新 CLAUDE.md 對應的節留一行指向 `03 D<n>`（Q8 沒問時標「不適用」） ⑥**經驗帶走審查**（不同判準的兜底）：另派一支 fresh-context subagent（`opus`），**不給它第 12 項的清單**，只給備份路徑、路由表指到的原文件路徑、這次新產生與修改的檔案清單；prompt 要帶「搜尋限定目標目錄、禁止全碟掃描」。它從舊文件那一側逐段讀，用第 12 項同一個語意判準認出每條經驗，再到新設定裡找它還在不在：在→寫出新檔名與行號（沿用原位的文件也算，要在新 CLAUDE.md 路由表或必讀清單上找得到）；不在→列為「沒帶到」。回報格式：一條一列「經驗原文｜出處｜新設定裡在哪／沒帶到」，全部附出處，不准只給數字。主對話拿它的清單跟第 12 項清單互比：只有一邊有的逐條回原文判斷。**Q8 使用者明確選了不帶的經驗，出現在「沒帶到」裡是預期結果**：標「你選了不帶」，不重問、不算缺漏、不擋 init 完成。其餘「沒帶到」的每一條：屬於專案事實的回 Phase 4 補進新檔；屬於要不要升格的，攤給使用者決定（等同補問 Q8）。補完再派一支新的 subagent 重審，最多兩輪，第二輪仍有沒帶到的就停下，把清單交給使用者。審查的原始回報貼進收尾回報
```

### 第二層：冷啟探針（新開 session 實測，不是讀設定檔推論）

hook 設定在 session 啟動時載入，當前 session 看不到剛寫進去的 hook——**必須在目標目錄起一個新 session 實測**。做法：在目標 workspace 根跑 headless 子程序（cwd＝目標目錄），把探針指令交給它，讀它回來的原文判定：

```
cd <目標> && claude -p "<探針 prompt>" --output-format text
```

（無法起子程序的環境：請使用者在目標目錄開新 session，貼上探針 prompt，把回覆原文貼回來。）

| # | 探針 | 探針 prompt 要點 | PASS 判準 | 前提 |
|---|------|------------------|-----------|------|
| P1 | **故意派不帶 model 的 agent，看有沒有被擋** | 「用 Agent tool 派 subagent_type=`<pipeline 內任一專案 agent>`、prompt＝`<探針基底 prompt>`，**不要帶 model 參數**。把工具回傳的原文完整貼出。」 | 回傳原文含 `[02-model-dispatch §1]` 的 deny 訊息，且沒有出現 `PROBE-OK`。**只看到派工紀律閘的訊息不算**——那代表基底 prompt 沒帶齊欄位，要修 prompt 重跑，不是 PASS | 有裝 check-agent-model |
| P2 | **派正常 agent，看有沒有誤擋** | 同上（同一份基底 prompt），但**帶 `model: "sonnet"`** | 回傳含 `PROBE-OK`，且沒有 deny 訊息 | 有裝 check-agent-model |
| P3 | **SessionStart 提醒有沒有出來** | 「你這個 session 開始時，context 裡有沒有一段以 `[harness]` 開頭的提醒？有的話逐字貼出，沒有就回答『沒有』。」 | 回覆逐字貼出 `[harness] 本專案有制度層 .claude/harness/…` | 無 |
| P4 | **git-commit 攔不攔得住裸 git commit（兩種殼都要）** | 探針前先記 `git -C <repo> rev-parse HEAD`。prompt：「先用 Bash、再用 PowerShell 各執行一次 `git commit --dry-run --allow-empty -m harness-probe`，把兩次工具回傳原文完整貼出。」（沒有 PowerShell 工具的環境只跑 Bash） | 兩次回傳原文都是 hook 擋下的訊息（非 git 自己的輸出），且探針後 `rev-parse HEAD` 與探針前相同。**多 repo 工作區**：對每個子 repo 各跑一次，指令改成 `git -C <子 repo> commit --dry-run --allow-empty -m harness-probe`，每個子 repo 各記前後 HEAD | 0-1 是單一 repo 或多 repo 工作區，且有裝 git-commit plugin |
| P5 | **B 類規則的接線是真的**（Claude Code 真的會對 Bash／PowerShell 叫 `guard-risky-command`） | 每條規則造一條**就算沒被擋也無害**的觸發指令：在命中規則樣式的前提下加 `--help`／`--version`／`--dry-run`，或指向不存在的主機、不存在的檔案。prompt：「用 Bash 執行 `<無害觸發指令>`，把工具回傳原文完整貼出。」 | 回傳原文為 guard-risky-command 的擋下訊息 | 有裝 guard-risky-command 且至少一條規則造得出無害形式；**造不出無害形式的規則不准拿來冷啟**（只靠 probe-hooks 驗行為），在回報裡寫明 |

- **探針基底 prompt**（P1／P2 共用）：「只回覆 PROBE-OK」加上該 agent 在 `check-review-discipline.js` 的 `REQUIRED_MARKERS` 裡要求的每個標記（共用的回報鏈鐵則、【驗收條件】、【回報格式】、【開工前必讀】與它要寫到的必讀檔名，加上該 agent 自己的欄位），每欄寫一句最小內容即可——【驗收條件】要寫一條實際條件（例：「回覆是 PROBE-OK」），只放標題會被擋；QA agent 的【測試資料來源】第一行寫「選 a：探針不造資料」（該格會驗有沒有明選）；實作與 QA agent 的【開工前對齊】寫「無分岔：探針」，QA 的【目標環境】【既有測試分流】各寫一句（例：「本機」「新 TC：探針不跑測試」）；不要帶【計畫／設計文件】（帶了會打開那份檔驗章節）。P1 與 P2 之間**唯一的差別是有沒有帶 model**——一次只變一個變因，否則 P1 被擋時分不出是哪支閘擋的。沒裝 check-review-discipline 時基底就是「只回覆 PROBE-OK」。
- 用 `--dry-run` 是為了**探針失敗時也不會真的建 commit**。
- 前提不成立的探針標「不適用：<原因>」，不算失敗；**前提成立卻沒跑＝未完成**。
- 任一 FAIL → 回 Phase 4 修（常見原因：settings 接線路徑錯、`$CLAUDE_PROJECT_DIR` 沒展開、hook 檔名不一致、agent 名單沒填對），修完**整組重跑**，不是只重跑失敗那項。
- 探針的原始輸出貼進收尾回報（證據紀律：只寫「探針通過」不算）。

**P6（學習迴路，有裝時做；不用開新 session）**：在 `<落點>/.claude/hooks/` 跑 `node learn-reflect.js --self-test`。它在系統暫存目錄建一個假專案（複製這裡的學習迴路檔、寫一份假對話紀錄、建暫存 memory 目錄），自己產生一支假的 claude 執行檔（回固定的一筆綠區、一筆紅區、一筆該被拒收的提案），照正式流程跑一次反思與落地，逐項印 PASS／FAIL：綠區的 memory 寫進暫存 memory 目錄且 MEMORY.md 多一行、紅區的沒有寫入只進待核清單（pending.json）、拒收那筆有理由、ledger 有三筆、last-run.json 存在。全部 PASS 且 exit 0 才算過；不碰落點本身、不叫真的模型、不花用量。原始輸出貼進收尾回報。

**出關**：`init-verify.js` exit 0、語意項都做完、P1～P6 前提成立的都 PASS，跑 `init-flow.js advance <目標> 6`（腳本會再跑一次 `init-verify.js`，沒過就不讓進 Phase 6）。
