## Phase 1 — 盤點（唯讀，一次查完再往下）

超過 3 檔的探索照骨架 02 的紀律派 `Explore`（prompt 帶上「搜尋限定目標目錄、禁止全碟掃描」）。以下十三項全部查完（第 12 項只在參考模式查），填進盤點表：

| # | 項目 | 怎麼查（實讀，不信 README） | 記下什麼 |
|---|------|----------------------------|----------|
| 1 | 技術棧 | 讀套件與建置設定檔：`package.json`、`pyproject.toml`／`requirements.txt`、`go.mod`、`pom.xml`／`build.gradle`、`*.csproj`／`*.sln`、`Cargo.toml`、`Gemfile`、`composer.json`、`pubspec.yaml` | 語言、框架、資料存取方式、資料庫；前端與後端各一行 |
| 2 | build／test 指令 | **實際讀**腳本本體：`package.json` 的 `scripts`、`Makefile`、`*.sh`／`*.bat`／`*.ps1`、CI 設定（`.github/workflows/`、`.gitlab-ci.yml`）。能安全執行的（build、測試列出）實跑一次確認存在 | 每條指令＋「查證方式」（讀到哪個檔哪一行、有沒有實跑）。README 寫了但腳本不存在的，記成「文件漂移」。另記**專案自己的掃描或稽核腳本**（有 `--baseline`、或靠 exit code 判斷的：硬編檢查、對應檢查、沒人用的譯文或 export、覆蓋登記…）與**會說謊的東西**（程式碼索引、快取、產生物——過期了不報錯、只給舊答案）：指令、在哪個目錄跑、怎樣算過、看不到什麼，供 05 §5.1 |
| 3 | repo 結構與 git remote | workspace 根的資料夾；每個 repo 的 `git -C <repo> remote -v`；檔案數（`git -C <repo> ls-files \| wc -l`） | remote 指向外部／客戶伺服器＝push 屬外向動作，要進邊界條款；檔案數供裁切規則判斷「小專案」 |
| 4 | 前端類型（三分類） | 照下方「前端分類判準」 | 瀏覽器可驅動／非瀏覽器前端／無前端，**附證據檔案路徑** |
| 5 | 測試基礎 | 找測試目錄（`tests/`、`test/`、`__tests__/`、`spec/`、`src/test/`）與測試設定；**打開看裡面有沒有東西**——數測試檔數量、讀一支確認不是空殼 | 目錄存在 ≠ 有測試（經過見 `../rationale.md` §Phase 1-1）。記「有且有 N 支實測／有目錄但空／無」 |
| 6 | 既有治理層 | `AGENTS.md`、`.agents/`、`.cursor/`、`.github/copilot-instructions.md`、`CONTRIBUTING.md`、`docs/` 底下的開發規範、CI 規範（既有 `CLAUDE.md`／`.claude/` 不在這項，歸第 12 項） | 有 → 記下它管什麼（流程／規範／stack 限制），harness 讓位；這些檔也是 Q7「必讀文件」的候選。**只給某一個 AI 工具讀的規則檔**（`.github/copilot-instructions.md`、`.github/instructions/*.instructions.md`、`.cursor/rules/`、`.windsurfrules`）另記三件，供 Q7 決定讓位還是精煉成自有正本（adaptation-guide §2.2）：篇幅、誰在維護（看 `git log` 的作者）、跟 repo 現況對不上的地方（逐條對程式碼，記檔:行）。**另查註解相關三件（Q11 的依據）**：①既有的註解規範文件（檔名或標題含「註解」「comment」「docstring」的規範檔）②**強制寫 doc 註解的編譯器或 linter 設定**——grep 建置與 lint 設定檔（`*.csproj`、`Directory.Build.props`、`.eslintrc*`／`eslint.config.*`、`Cargo.toml`／`lib.rs`／`main.rs`、`pyproject.toml`／`setup.cfg`／`.pylintrc`／`ruff.toml`、`checkstyle*.xml`）裡的 `GenerateDocumentationFile`、`CS1591`、`require-jsdoc`（含 `jsdoc/require-jsdoc`）、`missing_docs`、`missing-docstring`／`C011[456]`、ruff 或 pydocstyle 的 `D1`、`MissingJavadoc`／`JavadocMethod`，每筆記檔:行與它管哪些成員 ③空殼或罐頭 doc 的熱點：用 `skeleton-comment-guide.md` 第五節的樣式取樣（≤5 筆，記檔:行），另挑 2～3 個講原因、講限制的好註解當「真人範本」候選 |
| 7 | 既有 agent | `.claude/agents/`、`.agents/`、plugin 提供的 agent（`claude plugin list` 或讀 `~/.claude/settings.json` 的 enabledPlugins） | 有 → Q1 裁切規則「已有自己的 agents→用他的名字」 |
| 8 | 外部副作用路徑 | 照下方「危險動作候選推導」掃描表逐類 grep | 每類命中的檔案:行號（取樣 ≤5 筆）＋判斷是真路徑還是假命中；供 Q2 |
| 9 | 敏感物 | `.env*`、`*.pem`／`*.key`／`*.pfx`、`credentials*`、`secrets*`、VPN 設定、客戶機密目錄；`.gitignore` 有沒有擋 | 進實例 CLAUDE.md 絕對邊界（「不得出現在 commit、文件、對外輸出」）；沒被 `.gitignore` 擋的要回報 |
| 10 | 執行期風險事實（B 類 hook 的依據） | ①資料庫：用戶端指令（`psql`／`mysql`／`sqlcmd`／`mongosh`／`redis-cli`）出現在腳本或文件、連線字串與其中的帳號（`sa`／`root`／`postgres`／`admin` 這類高權帳號要特別記；只記帳號名，**密碼與 token 記下的當下就遮成 `***`**，同第 13 項②）、出現過的資料庫主機名（文件或命名說它是正式或測試都只當線索；主機名一併列進第 13 項②走 U1，只有使用者確認過的才算測試庫，沒確認的在規則與寫進的檔案裡一律照正式庫處理） ②起服務：啟動指令與它依賴的環境變數（`NODE_ENV`／`ASPNETCORE_ENVIRONMENT`／`SPRING_PROFILES_ACTIVE`／`--profile`／`.env.<環境>`） ③測試指令本體（第 2 項已查）與測試是否讀環境變數或設定檔（`process.env`／`os.environ`／`.env.test`／測試設定檔） | 每一項都會變成 `guard-risky-command` 或 `guard-test-preconditions` 的一條規則（見 `references/hook-catalog.md` 第 10–14 列）；記下樣式與「正確值」長什麼樣 |
| 11 | 工作法（C 類 hook 的依據） | `.claude/local-overrides.yml` 有沒有條目；有沒有本機覆寫檔（`*.local.*`、`appsettings.*.json`、`.env.local`、`settings.local.*` 被追蹤卻常有未提交改動——`git status` 看一次）；有沒有多工作樹（`git worktree list`）。有本機覆寫時再查兩件事，作為 Q9 的候選：①**只在某些分支才需要的覆寫**——清單上不被 git 追蹤或被 .gitignore 排除的整檔覆寫（例：本機 mock 類別），在 repo 裡找誰引用它的檔名或類別名（注入／註冊／import 的那一行，例：`Program.cs`、`main.ts`、DI 設定檔）；有引用點的記「判準檔＋要找的字串」，查不到引用點的不列（沒有判準可寫） ②**已知會帶到舊版的覆寫**——清單 `reason` 欄或專案記錄提到「舊版會出事」的，記下能代表新版能力的識別字 | 有本機覆寫 → 裝本機覆寫保護三件組（形狀目錄第 16–18 列），①②有候選才問 Q9；同時有本機覆寫與多工作樹 → 裝起服務時的工作樹覆寫提醒（形狀目錄第 19 列，起服務指令樣式用第 10 項②查到的實際啟動指令），03 的 A9 加填「開新工作樹時帶齊覆寫」；只有多工作樹沒有覆寫檔 → 第 19 列不裝，記進收尾回報。有多工作樹、**而且**第 10 項②有在本機起服務的指令（與有沒有覆寫檔無關）→ 裝工作樹的 port 驗證腳本（形狀目錄第 30 列），另記它的填空內容：每個服務的 repo 與平常監聽的 port（啟動設定或指令裡實際寫的值，記檔:行）、「誰該打誰」寫在哪個設定檔的哪一行（檔:行＋原文；服務讀的是建置輸出目錄裡的複本時兩份都記）、重啟才會讀的建置產物在哪（編譯輸出、建置輸出目錄裡的設定檔；有熱更新的開發伺服器不記）、有沒有健康檢查端點（實讀路由，記回應裡「真的拿到值」才會出現的字樣；查不到就不填，不准猜）；只有多工作樹、沒有起本機服務的 → 第 30 列不裝，記進收尾回報。有本機覆寫時另記每個覆寫檔改了哪些鍵、本機值長什麼樣（`git diff -- <檔>`；未追蹤或被排除的讀全文；**帳密、權杖記下的當下就遮成 `***`**）、讀那個鍵的程式在哪、值不對時程式會怎樣（逾時、授權錯誤、改打外部服務…），以及它是靠環境變數自動切換、還是直接改在檔案裡——這是 Phase 4 本機覆寫說明的內容 |
| 12 | 原有的 Claude Code 設定（**僅參考模式**） | 從備份讀，逐項**打開看內容**，不只列檔名：`CLAUDE.md` 每一節；`.claude/agents/*.md` 每支的職責、工具、模型、硬性規則；`.claude/hooks/*` 每支擋什麼（讀程式，不信檔頭註解）與 settings 裡怎麼接線；`.claude/commands/`、`.claude/skills/` 各做什麼；settings 的 `permissions`（allow／deny／ask）；之前裝過 harness 的話，另讀 `05-knowledge-protocol.md` 的健檢紀錄、三份知識筆記檔有沒有真實條目（示範條目不算） | 每一項記「它在管什麼」＋「對應到 harness 的哪一塊」＋預設處置（見下方「原有設定的預設處置」）。另外把原有規矩裡**這個專案自己的經驗**逐條挑出來——這是 Q8 的題目，也是 Phase 5 經驗帶走審查的對照基準之一。**派一支 fresh-context subagent 做（`opus`：要跨檔讀語意、判斷的是「這句話背後有沒有經驗」），不准用關鍵字比對判定**：經驗多半寫成一條普通規則，不會帶「事故」「踩坑」這類字（例：「不准改某個設定檔」「寄送類 API 每次測試最多呼叫 1 次」），grep 只會抓到會自稱踩坑的那幾條。判準（語意，逐段讀）：**拿掉這句，照 harness 通用骨架重產的新規則會不會讓 Claude 重犯某個錯、違反某個人定的約定、或不知道某個這個專案才有的限制？** 會，就是經驗。涵蓋但不限於：出過的錯與繞法、工具或第三方套件的坑、某個人或團隊定的約定與禁令、數字化的安全上限、使用者糾正過的偏好、看似多餘但有原因的步驟。範圍：備份裡的 `CLAUDE.md` 與 `.claude/` 全部，加上 `CLAUDE.md` 路由表指到的每份規則或紀錄文件（在原位唯讀，不搬）。每條記：原文一句、出處（檔名＋章節）、它防的是什麼、現在有沒有東西擋（原有哪支 hook／只有文字）、照預設處置會不會被帶進新設定（會→帶到哪；不會→列為 Q8 候選）。subagent prompt 要帶「搜尋限定目標目錄、禁止全碟掃描」。**裡面寫到的專案事實是盤點證據**：build／test 指令、禁止動作、保護某個檔或某台主機的 hook，照樣拿去跟第 2、8、10 項交叉查證——原有 hook 在擋的東西，代表使用者在乎那個風險，Q2 與 Q5 要列入，不能因為 harness 的形狀目錄沒有就丟掉 |
| 13 | 專案輪廓（業務面；**每個專案都查**） | 讀 README、需求／規格文件、提案文件，再拿程式碼對：①用途與使用者（系統給誰用、解決什麼問題） ②串接的外部系統與資料庫：每個是讀還是寫（對照第 8 項的呼叫點）、**方向**（出向＝我方呼叫對方；入向＝對方主動打進來——grep 對外開放的路由與處理器名稱：`webhook`、`callback`、`notify`、`hook`、`/api/.*/receive` 這類，以及驗對方簽章或共用密鑰的程式；入向的副作用由對方觸發，測試時要問「誰會打進來、打到哪個環境」）、程式與設定檔裡的位址（**記下的當下就遮掉帳密**：連線字串的帳號密碼、路徑或查詢參數裡的 token／key／secret 一律換成 `***` 並註明來自哪個環境變數或設定鍵；核對表與問環境的題目用遮過的版本；**寫進檔案時帳密整段拿掉**——只留主機與路徑，後面註「（帳密取自 <環境變數或設定鍵名稱>）」，連 `***` 都不留）、**文件或位址看起來是正式還是測試**——這只是線索，一律記成「待問（文件說是 X）」，不准當成結論；只有使用者在 U1 確認過的才算測試環境，沒確認的在 Q2 候選、自動檢查規則、寫進的檔案裡一律照正式環境處理；不走網路的（人工下載檔案再上傳）記「不適用」，不列進 U1 ③業務流程：文件列的流程（有代號就記代號）逐條對程式，分「已實作／部分實作／還沒做」三種；部分實作要寫出缺哪一段（例：核心邏輯與測試都在，但沒接進實際流程） ④進度：文件自述的階段 vs 實際（測試數、已實作的流程、最近改動的檔） ⑤候選專案詞，最多 10 個，有幾個列幾個（湊不滿不准拿通用詞充數，一個都沒有就寫「查不到」）：文件與程式識別字裡反覆出現、不是通用程式概念、讀者不問就可能誤解的詞；每個附文件裡的出處與你推的定義 ⑥文件哪裡過時：每份可能列為必讀的文件，逐一記下跟實況不符的地方 | 整理成 Phase 2 的「專案概要草稿」；②的「待問」是 U1 的題目、④是 U2、⑤是 U3、⑥供 Q7 標註。**全部是推論**，每一句附出處（檔名:行號或文件章節），推不出來的寫「查不到」，不准補想像 |

### 原有設定的預設處置（參考模式）

原則：**事實與知識一律留下，流程與機制換成 harness 的，但每一項都要在 Phase 2 攤給使用者否決**。不靜默刪除任何東西——就算有備份，使用者沒看到就是沒交代。

| 原有的東西 | 預設處置 | 為什麼 |
|---|---|---|
| `CLAUDE.md` | **取代**：用 harness 骨架重寫；原檔裡的專案事實（指令、路徑、邊界、禁止事項、術語）逐條搬進新檔對應的節；流程類規定（怎麼派工、怎麼審查）由 harness 的取代。每條原規則記去向：搬進哪一節／被哪條 harness 規則取代／沒搬（理由） | 使用者就是對原本的流程不滿意；但專案事實不會因為換流程而失效 |
| 角色與 harness 某個 agent 相同的 agent（例：原本的 reviewer 對上 code-reviewer） | **併入**：用 harness 骨架建，原 agent 裡的專案專屬內容（技術棧規範、檢查清單、禁止事項）搬進新檔的硬性規則。名字預設用 harness 的名字；使用者要保留原名就用原名，02 對照表、04 模板、check-agent-model 名單、`check-review-discipline.js` 的 `REQUIRED_MARKERS` key 跟著改 | 骨架帶交接契約與回報格式（派工閘與 git-commit 依賴它們），原 agent 帶專案知識，兩邊都要 |
| harness 沒有對應角色的 agent（例：資料遷移專員、文件撰寫） | **沿用**：原檔不動，加進 02 對照表、check-agent-model 名單與 `check-review-discipline.js` 的 `REQUIRED_MARKERS`（兩份名單都要加：前者管有沒有指定模型，後者管派工欄位與必讀檔名）。02 對照表的預設模型照職責對應（adaptation-guide §2.1）：**寫規格或做設計的（需求規格、UX 規格、架構、API 契約）對應 `backend-architect` 那一級，預設 `opus`**；照規格實作、審查的預設 `sonnet`；測試的不低於它要驗的那支實作用的模型（實作是 `opus` 就用 `opus`）；純機械的 `haiku`。原 agent 檔自己寫了 model 的照原檔 | 不是 harness 該決定的分工；但模型要照職責定，不能一律套 sonnet |
| 原有 hook | 讀程式判斷它擋什麼：形狀與 harness 某支相同 → **取代**（harness 版有 cases 可實測）；harness 沒有的 → **沿用**，照原接線寫進新 settings，並在 05 健檢清單加一列（沒有 cases 可跑，註明「原有 hook，手動試跑」） | 原有 hook 在擋的東西代表使用者在乎那個風險 |
| `commands/`、`skills/` | **沿用**，原封不動 | 不屬於開發流程骨架 |
| settings 的 `permissions` | **沿用**，照 Phase 4 JSON 合併 | 使用者自己決定的權限 |
| 之前裝過的 harness（重裝） | 制度文件與 hook 用新版骨架重生，**上一版填進去的專案參數與規則（B 類規則、agent 名單、Q 的答案）當成這次訪談的預設答案**；知識筆記檔與 05 健檢紀錄的真實條目**原樣保留**，只換結構（0.10.0 起變更紀錄拆出本體：舊實例本體的 `## Changelog` 節整節搬進新的紀錄檔，見 Phase 4 知識容器層表下的參考模式說明（`phase-4-generate.md`））（唯一例外：`GLOSSARY.md`（既有專案沿用 `CONTEXT.md`）裡 U3 裁決改寫或刪除的詞，見 Phase 4 知識容器層）；memory 不動 | 知識是專案自己長出來的資產，重裝不能歸零 |
| 其他檔（`.claude/` 下的過程產物、殘檔） | **不動**，列在收尾回報，由使用者決定 | 不確定用途的東西不替使用者處理 |

### 前端分類判準

依序判斷，命中即停：

| 分類 | 證據（任一成立） | 處置 |
|------|-----------------|------|
| **瀏覽器可驅動** | 有 `index.html`（非文件用途）；`*.vue`／`*.svelte` 檔；`*.tsx`／`*.jsx` 且 `package.json` 相依含 `react-dom`；相依或設定檔含 `vite`／`webpack`／`next`／`nuxt`／`@angular/core`；伺服器端模板渲染頁面（`templates/*.html` 搭配 Web 框架） | 建議安裝 **qa-webwright** plugin（瀏覽器 QA 方法論＋落地 Stop hook）；qa-engineer 骨架用「(A) 瀏覽器可驅動」段；Phase 0-4 的 Playwright MCP allow-list 在此變成必要項 |
| **非瀏覽器前端** | `*.xcodeproj`／`*.xcworkspace`（iOS／macOS）；`AndroidManifest.xml`；`pubspec.yaml`（Flutter）；相依含 `electron`；`*.unity`／`ProjectSettings/`（Unity）；`package.json` 含 `engines.vscode` 或 `contributes`（VS Code extension） | **不裝** qa-webwright；保留 frontend-engineer；qa-engineer 骨架用「(B) 非瀏覽器前端」段改寫成該平台的實測方式 |
| **無前端** | 以上皆無（純 API／CLI／函式庫／資料處理） | 拿掉 frontend-engineer；qa-engineer 用「(C) 無前端」段（實測＝跑測試指令與實際呼叫介面）；**觸發 Q3**（怎樣算做完） |

同一 workspace 有多個 repo 分屬不同分類時，逐 repo 記錄；只要有一個瀏覽器可驅動就走 (A)，其餘 repo 的 QA 方式在 qa-engineer 骨架內並列。

### 危險動作候選推導（外部副作用路徑掃描）

對目標程式碼（排除 `node_modules`／`vendor`／`dist`／`build`／`.git` 等產物目錄）逐類 grep，命中的類別成為 Q2 的候選：

| 類別 | 要 grep 的關鍵字（不分大小寫） | 為什麼危險 |
|------|-------------------------------|-----------|
| 寄信 | `smtp`、`sendmail`、`nodemailer`、`SmtpClient`、`MailMessage`、`sendgrid`、`mailgun`、`ses.send`、`send_mail`、`EmailService` | 測試信真的寄給真人；收不回 |
| 打外部 API | `https?://`（排除 localhost／127.0.0.1／example）、`axios`、`fetch(`、`requests.`、`HttpClient`、`RestTemplate`、`webhook`、`apiKey`／`api_key` | 對外部系統產生真實副作用、耗用配額、觸發對方流程 |
| 毀滅性 SQL | `DROP `、`TRUNCATE`、`DELETE FROM`（無 WHERE）、`ALTER TABLE`、migration 目錄（`migrations/`、`*.sql`）、ORM 的 `drop_all`／`db.sync({ force` | 不可逆的資料損失；schema 變更影響共用資料庫 |
| 部署 | `deploy`、`kubectl`、`helm`、`terraform`、`serverless`、`docker push`、`az webapp`、`gcloud`、`aws s3 sync`、`vercel`、`netlify`、CI 的 deploy job | 動到正式或共用環境 |
| 金流計費 | `stripe`、`paypal`、`braintree`、`adyen`、`綠界`／`ecpay`、`藍新`／`newebpay`、`charge`、`refund`、`invoice`、`billing`、`payment` | 真實金錢流動；退款與重複扣款難收拾 |
| 實機硬體 | `serialport`、`pyserial`、`usb`、`gpio`、`modbus`、`opcua`、`bluetooth`／`ble`、`/dev/tty`、`COM[0-9]`、PLC／韌體燒錄工具 | 物理世界的副作用，可能損壞設備或造成安全問題 |
| 資料管線 | `airflow`、`dag`、`cron`、`schedule`、`kafka`、`rabbitmq`、`pubsub`、`etl`、`bigquery`、`snowflake`、`s3://`、`gs://`、排程設定檔 | 觸發下游全鏈重跑、覆寫他人依賴的資料 |

命中要人判讀：`payment` 出現在變數名不代表有金流路徑。取樣確認是真的會執行到的呼叫點才算候選。

**出關**：十三項（非參考模式十二項）都查完、填進盤點表，跑 `node <本 plugin>/skills/init/scripts/init-flow.js advance <目標> 2` 進 Phase 2。
