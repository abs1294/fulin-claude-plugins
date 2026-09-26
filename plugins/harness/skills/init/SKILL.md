---
name: init
description: 把一套開發流程制度（模型調度／停損熔斷／派工模板／知識協議＋agent pipeline＋機械閘 hook＋知識容器）安裝到一個軟體開發專案。當使用者說 /harness:init、「幫這個專案裝 harness」、「實例化 harness」、「把制度層搬到 X 專案」、「幫這個專案建開發流程」時觸發。流程＝前置檢查→盤點→攤開核對→一次一題訪談→五層生成→靜態驗收＋冷啟探針；不是複製既有專案的檔，是用通用骨架填入目標專案的已查證事實。
---

# harness:init — 開發流程制度安裝器

把 `references/` 的通用骨架與 `../../hooks/templates/` 的 hook 範本，實例化成目標專案的五層制度：文件層、可執行層（hook）、agent 層、知識容器層、settings 層。**引擎（本 plugin）與實例（專案檔）分離**：plugin 更新不會動到任何專案的實例；實例落地後歸該專案自治（紅區流程見實例的 05）。

## 核心原則（動工前先讀 `references/adaptation-guide.md`，本節只是摘要）

1. **開發流程骨幹全帶，事故型條款不帶**：純行為紀律照搬、可參數化的判準挖空填入、agent pipeline 依盤點裁切；綁死特定工作法的條款與單一事故的細則不帶（那些從目標專案自己的 memory 長出來，或歸未來的 `/harness:review`）。
2. **規則要有機械閘**：skill 與制度檔寫「必須」是自律，AI 會繞；只有 hook 是他律。所以本 init 產出可執行的 hook，並用冷啟探針實測它真的會擋。
3. **實例化不是複製**：目標專案的事實（build 指令、agent 名單、邊界、危險動作）必須**實地查證後填入**，禁止從別的專案的實例照抄、禁止用猜的。
4. **既有治理層讓位**：目標專案已有自己的 agent 治理（AGENTS.md／.agents/／既有 CLAUDE.md 規範／既有 agents）時，harness 只補 Claude Code 特有行為層，開發流程正本讓給既有治理層（adaptation-guide §2）。
5. **誠實**：init 給的是骨架＋長出資產的路徑，不是一套成熟的 harness。收尾回報必須講清楚「你已經有的」與「你還沒有的」。

## 對使用者講話的寫法（Phase 0、Phase 2、每一題訪談、Q5 清單、收尾回報都適用）

聽的人多半第一次用 harness，沒讀過這份 SKILL。本檔為了精確，用了很多內部用語（熔斷、B 類、形狀目錄、落成規則、代決…），**這些詞只供你自己理解，不得出現在對使用者說的話裡**。判準：一個沒看過本 plugin 任何文件的工程師，讀了這句話知不知道「會發生什麼事、要他決定什麼」？不知道就改寫。

| 內部用語 | 對使用者改說 |
|---|---|
| 熔斷、熔斷清單 | 執行前一定要先問你的動作 |
| hook、機械閘、他律 | 自動檢查（第一次提到時補一句：Claude 每次執行指令或派工前自動跑，命中就擋下） |
| `guard-risky-command` 這類檔名 | 講它擋什麼；檔名只放在表格最後一欄或括號裡，不當主詞 |
| 落成一條規則 | 能從指令樣子認出來的，會設一條自動檢查：Claude 要執行這類指令時先被擋下，問過你才做；認不出來的只寫進規則文件，靠 Claude 做之前自己停下來問你 |
| A／B／C／D／E 類、形狀目錄 | 不提分類；改說原因：一定會裝／因為你的專案有 X 才裝／因為你的工作方式才裝／要另裝某個 plugin／等你有了 X 才用得到 |
| pipeline、裁切 | 開發流程的角色分工；拿掉你用不到的角色 |
| 讓位、既有治理層 | 沿用你們已經有的規範（寫出檔名），不另外蓋一套 |
| 代決 | 我先替你決定的（你可以推翻） |
| 冷啟探針 | 開一個新的 session 實際試一次，看自動檢查有沒有真的擋下 |
| 同源、驗證器與施作器同源 | 同一家模型審自己寫的東西，看不出自己的盲點 |
| 紅區／黃區／綠區 | 改之前要先問過你（團隊則是走 PR 審查）／可以改，但當次要講明改了什麼、為什麼／可以直接改，事後提一句 |
| 知識容器 | 知識筆記檔：`CONTEXT.md` 詞彙表、`FLOWS.md` 跨模組流程、`PROJECT.md` 測試知識 |
| 沉澱閘 | 每次 commit 前會問你四個問題，把這次學到的東西記下來 |
| codify | 寫成可以重跑的自動測試 |
| dry-run | 試跑（不真的執行） |
| `03` B23、`05` §6 這類條號 | 不寫條號；要指路就寫完整檔名加節名（「`05-knowledge-protocol.md` 的『升格協議』一節」） |
| Q2、Phase 2 | 第 2 題、剛才的盤點結果 |

另外三條：
- **agent 名稱第一次出現附中文職稱**：`backend-architect`（後端架構設計）、`backend-engineer`（後端實作）、`frontend-engineer`（前端實作）、`qa-engineer`（測試）、`code-reviewer`（程式碼審查）。
- **每題都講清楚「選了之後會發生什麼」**，不要只講選項名稱。
- **送出前自掃一次**：拿上表左欄逐詞搜自己的草稿，命中就改寫再送。

## 流程總覽

```
Phase 0 前置檢查 ─→ Phase 1 盤點（唯讀） ─→ Phase 2 攤開核對 ─→ Phase 3 訪談（一次一題，Q1~Q7）
                                                                          │
              收尾回報 ←─ Phase 5 驗收（靜態九項＋冷啟探針五項） ←─ Phase 4 生成（五層）
```

任一 Phase 未完成不得進下一個。Phase 5 任一項失敗＝init 未完成。

---

## Phase 0 — 前置檢查（四項，任一不過就停在這裡）

先確認目標 workspace 路徑（預設＝當前工作目錄；使用者指定別的路徑就用那個），以下指令一律對目標路徑跑：

| # | 檢查 | 指令 | 不過時 |
|---|------|------|--------|
| 0-1 | 目標是不是 git repo | `git -C <目標> rev-parse --is-inside-work-tree`；workspace 根不是 repo 時再列子資料夾：`for d in <目標>/*/; do git -C "$d" rev-parse --show-toplevel 2>/dev/null; done` | 不是 repo 也可以繼續，但記下「非 git repo」：沉澱閘改綁 Stop hook、git-commit 相關的閘與探針整組不裝不測 |
| 0-2 | 有沒有裝過 harness | `ls <目標>/.claude/harness/ <目標>/.claude/agents/ 2>/dev/null`；另查 `<目標>/CLAUDE.md` 是否含「Harness 路由表」 | **已有 → 停止，不覆蓋**。回報現況（有哪些檔、哪一版的形狀），差異檢查目前沒有現成指令（`/harness:review` 規劃中、尚未提供），請使用者決定要手動比對還是備份後重裝；使用者明確要求重裝時，先整個備份再說 |
| 0-3 | Codex CLI 裝了沒 | `codex --version` | **沒裝 → 產出「請先裝 Codex」的指引並停下，不降級成單軌**（見下方指引範本）。理由：git-commit 的三軌審查裡，Codex 是與 code-reviewer 不同源的那一軌；少了它，審查就只剩同一家模型看自己的東西，驗證器與施作器同源（03 B23） |
| 0-4 | Playwright MCP 在不在 `permissions.allow` | 讀 `<目標>/.claude/settings.json`、`<目標>/.claude/settings.local.json`、`~/.claude/settings.json` 的 `permissions.allow`，找 `mcp__playwright` 開頭的項 | 不在 → 不擋，記下來：Phase 1 判定為「瀏覽器可驅動前端」時，Phase 4 settings 層要補（經 Phase 2 核對）；非瀏覽器或無前端時此項不適用 |

**「請先裝 Codex」指引範本**（0-3 不過時照填輸出，然後停下）：

```
commit 前的程式碼審查需要 Codex CLI：它和 Claude 各審一次，
兩家模型的盲點不同，可以互相補位。
偵測結果：`codex --version` → <實際輸出，例：command not found>

請先安裝並登入：
  1. npm install -g @openai/codex        （需要 Node.js）
  2. codex login                          （用你的 OpenAI 帳號）
  3. codex --version                      （看到版本號就表示裝好了）
裝好後重跑 /harness:init，我會從頭再檢查一次。

為什麼不直接略過：少了 Codex，commit 前就只剩 Claude 審 Claude 自己寫的程式，
自己的盲點自己看不出來。
```

---

## Phase 1 — 盤點（唯讀，一次查完再往下）

超過 3 檔的探索照骨架 02 的紀律派 `Explore`（prompt 帶上「搜尋限定目標目錄、禁止全碟掃描」）。以下十一項全部查完，填進盤點表：

| # | 項目 | 怎麼查（實讀，不信 README） | 記下什麼 |
|---|------|----------------------------|----------|
| 1 | 技術棧 | 讀套件與建置設定檔：`package.json`、`pyproject.toml`／`requirements.txt`、`go.mod`、`pom.xml`／`build.gradle`、`*.csproj`／`*.sln`、`Cargo.toml`、`Gemfile`、`composer.json`、`pubspec.yaml` | 語言、框架、資料存取方式、資料庫；前端與後端各一行 |
| 2 | build／test 指令 | **實際讀**腳本本體：`package.json` 的 `scripts`、`Makefile`、`*.sh`／`*.bat`／`*.ps1`、CI 設定（`.github/workflows/`、`.gitlab-ci.yml`）。能安全執行的（build、測試列出）實跑一次確認存在 | 每條指令＋「查證方式」（讀到哪個檔哪一行、有沒有實跑）。README 寫了但腳本不存在的，記成「文件漂移」 |
| 3 | repo 結構與 git remote | workspace 根的資料夾；每個 repo 的 `git -C <repo> remote -v`；檔案數（`git -C <repo> ls-files \| wc -l`） | remote 指向外部／客戶伺服器＝push 屬外向動作，要進邊界條款；檔案數供裁切規則判斷「小專案」 |
| 4 | 前端類型（三分類） | 照下方「前端分類判準」 | 瀏覽器可驅動／非瀏覽器前端／無前端，**附證據檔案路徑** |
| 5 | 測試基礎 | 找測試目錄（`tests/`、`test/`、`__tests__/`、`spec/`、`src/test/`）與測試設定；**打開看裡面有沒有東西**——數測試檔數量、讀一支確認不是空殼 | 目錄存在 ≠ 有測試（曾實測某 repo 自述有測試目錄，實際不存在）。記「有且有 N 支實測／有目錄但空／無」 |
| 6 | 既有治理層 | `AGENTS.md`、`.agents/`、`.cursor/`、`.github/copilot-instructions.md`、既有 `CLAUDE.md`／`.claude/`、`CONTRIBUTING.md`、`docs/` 底下的開發規範、CI 規範 | 有 → 記下它管什麼（流程／規範／stack 限制），harness 讓位；這些檔也是 Q7「必讀文件」的候選 |
| 7 | 既有 agent | `.claude/agents/`、`.agents/`、plugin 提供的 agent（`claude plugin list` 或讀 `~/.claude/settings.json` 的 enabledPlugins） | 有 → Q1 裁切規則「已有自己的 agents→用他的名字」 |
| 8 | 外部副作用路徑 | 照下方「危險動作候選推導」掃描表逐類 grep | 每類命中的檔案:行號（取樣 ≤5 筆）＋判斷是真路徑還是假命中；供 Q2 |
| 9 | 敏感物 | `.env*`、`*.pem`／`*.key`／`*.pfx`、`credentials*`、`secrets*`、VPN 設定、客戶機密目錄；`.gitignore` 有沒有擋 | 進實例 CLAUDE.md 絕對邊界（「不得出現在 commit、文件、對外輸出」）；沒被 `.gitignore` 擋的要回報 |
| 10 | 執行期風險事實（B 類 hook 的依據） | ①資料庫：用戶端指令（`psql`／`mysql`／`sqlcmd`／`mongosh`／`redis-cli`）出現在腳本或文件、連線字串與其中的帳號（`sa`／`root`／`postgres`／`admin` 這類高權帳號要特別記）、正式與測試庫主機名 ②起服務：啟動指令與它依賴的環境變數（`NODE_ENV`／`ASPNETCORE_ENVIRONMENT`／`SPRING_PROFILES_ACTIVE`／`--profile`／`.env.<環境>`） ③測試指令本體（第 2 項已查）與測試是否讀環境變數或設定檔（`process.env`／`os.environ`／`.env.test`／測試設定檔） | 每一項都會變成 `guard-risky-command` 或 `guard-test-preconditions` 的一條規則（見 `references/hook-catalog.md` 第 10–14 列）；記下樣式與「正確值」長什麼樣 |
| 11 | 工作法（C 類 hook 的依據） | `.claude/local-overrides.yml` 有沒有條目；有沒有本機覆寫檔（`*.local.*`、`appsettings.*.json`、`.env.local`、`settings.local.*` 被追蹤卻常有未提交改動——`git status` 看一次）；有沒有多工作樹（`git worktree list`） | 有本機覆寫 → 裝本機覆寫保護三件組（形狀目錄第 16–18 列）；只有多工作樹沒有覆寫檔 → 不裝，記進收尾回報 |

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

---

## Phase 2 — 攤開核對（一則訊息，讓使用者糾正事實）

把 Phase 0 與 Phase 1 的結果攤成**一張盤點表**給使用者看，並附上「據此自動推導的預設」。這一步不是提問，是**讓使用者在生成前糾正事實錯誤**——盤點是推論，使用者才知道真相（例：某個 `deploy` 腳本其實早已廢棄）。

內容（下列項目名稱是給你的清單；攤給使用者時照「對使用者講話的寫法」改成白話，例如「危險動作候選清單」寫成「做了收不回來的動作，我找到這幾個」）：

1. 十一項盤點表（每項附證據路徑；查不到的明寫「查不到」）
2. Phase 0 四項檢查結果
3. 自動推導的預設：
   - 前端分類與對應處置
   - Q1 預設 pipeline 依裁切規則裁完的樣子（先給出，Q1 再讓使用者改）
   - 危險動作候選清單（Q2 的題目來源）
   - 是否觸發 Q3（無前端）、Q6（無測試基礎）
4. 發現的目標專案自身問題（文件漂移、缺測試基礎、敏感物未被 `.gitignore` 擋）

訊息開頭先用兩三句講結論（這是什麼專案、有沒有前端與測試、找到幾類做了收不回來的動作），再接上面四項；整則訊息的**最後一句**固定是：「以上事實有錯請直接指出；沒有的話我開始逐題訪談（共 N 題）。」使用者糾正的事實回 Phase 1 重查確認後更新表格。**無人值守（headless）時**：照推導預設繼續，所有推導值在收尾回報列為「已代決」供事後否決。

---

## Phase 3 — 訪談（共 7 題，**一次一題**）

**一次一題，不要湊成一次 AskUserQuestion**——每題的答案會改變後面題目的選項（Q1 裁掉 frontend-engineer，Q5 的 hook 名單就跟著變）。每題都附**推薦選項與一行理由**（未附推薦會被 check-ask-discipline 閘擋下，也是三重自查有做的證據）。條件問的題目條件不成立就跳過，並在收尾回報記「Q<N> 跳過：<原因>」。

| 題 | 必問／條件問 | 問什麼 | 答案決定什麼 |
|----|-------------|--------|-------------|
| **Q1** | **必問** | 給預設 pipeline（已依裁切規則裁過）讓使用者刪改 | 02 agent 對照表、04 模板五 pipeline、`.claude/agents/` 建哪幾支、check-agent-model 名單 |
| **Q2** | **必問** | Phase 1 掃出來的危險動作，哪些要熔斷（執行前必須徵得同意） | 03 C2 清單、CLAUDE.md 絕對邊界；掃描零命中時改問「有沒有掃不到但確實存在的危險動作」 |
| **Q3** | **僅無前端時問** | 怎樣算做完（沒有畫面可以看，「實際跑起來」的證據是什麼：CLI 輸出？API 回應？產出檔案？） | 03 B3 的驗證方式、qa-engineer 骨架 (C) 段的實測方式 |
| **Q4** | **必問** | 單人還是團隊 | 落點與紅區語義（見下表） |
| **Q5** | **必問** | 攤出依形狀目錄推導出的 hook 清單（每支：擋什麼、為什麼這個專案需要——對應哪個盤點證據或哪題答案），問要不要**取消**哪幾支 | 可執行層裝哪幾支、B 類引擎裝哪幾條規則、settings 層接哪幾條 |
| **Q6** | **僅無測試基礎時問** | 要不要暫時豁免「QA codify 成可重跑測試」的要求（豁免期間 QA 改為實跑＋貼輸出） | 04 模板五配套第 3 條加豁免行、03 B4／B14 的驗證欄改寫 |
| **Q7** | **必問** | 哪幾份文件動手前必讀（從 Phase 1 第 6 項的既有治理層與規範檔中挑） | 04 共通規則的「開工前必讀清單」、五支 agent 的「開工前必讀」、CLAUDE.md 路由表 |

### 每一題對使用者怎麼問（照這個講，`<…>` 換成盤點到的實際內容）

上表是給你判斷用的；下面才是對使用者說的話。每題都要有：要他決定什麼、選了之後會發生什麼、我的建議與理由。

**第 1 題（開發流程的角色分工）**
> 之後每個開發需求，Claude 會照下面的順序分給不同角色做：
> <例：後端架構設計（backend-architect）→ 後端實作（backend-engineer）→ 測試（qa-engineer）→ 程式碼審查（code-reviewer）>
> 我已經依你的專案拿掉用不到的角色：<例：沒有前端，所以沒有前端實作這個角色>。
> 另外有三條規則固定跟著這個流程：①動手前先確認需求有沒有兩種以上的理解，有就先問你；②改到程式行為的，先實際跑過再送審查；③只改文字、排版這類讀程式就能確定沒問題的，審查過就算完成。
> 要增加或拿掉哪個角色嗎？建議：照目前這樣——<一行理由>。

**第 2 題（執行前一定要先問你的動作）**
> 我在程式碼裡找到這些做了就收不回來的動作：
> 1. <寄信：api/src/mail.js 第 12 行用 nodemailer 寄信，測試時會真的寄給收件人>
> 2. <部署：scripts/deploy.sh 會推到正式環境>
>
> 你勾選的每一項，之後 Claude 要做之前都會先停下來問你，不會自己動手；能用指令樣式認出來的，我還會加一條自動檢查，真的遇到時直接擋下。
> 請勾選要納入的項目。有我沒找到、但確實存在的危險動作，也請直接告訴我。
> 建議：全部勾選——<一行理由>。

（掃描零命中時改問：「我在程式碼裡沒找到寄信、部署、刪資料這類收不回來的動作。有沒有我掃不到、但確實存在的？例如只在某台機器上手動跑的腳本。」）

**第 3 題（沒有畫面的專案，怎樣算做完）**
> 你的專案沒有畫面可以打開來看，所以 Claude 說「做完了」之前要拿什麼當證據？例如：指令的實際輸出、API 的回應內容、產出的檔案。
> 建議：<例：跑一次 CLI 並貼出輸出>——<一行理由>。

**第 4 題（一個人用還是團隊一起用）**
> 這套規則只有你自己用，還是團隊一起用？
> - 只有自己：規則檔不進版控、不會被 commit，要改規則問你就好。
> - 團隊：規則檔放進 repo 一起版控，大家用同一套，改規則要走 PR 審查。
> 建議：<選項>——<一行理由，例：remote 指向客戶的伺服器，規則檔不該跟著推出去>。

**第 5 題（要裝的自動檢查）**：照下方「Q5 攤給使用者的格式」列出清單，接著問：
> 以上是依你的專案推導出來、預設全部安裝的自動檢查。要取消哪幾項嗎？
> 建議：全部保留——<一行理由>。

**第 6 題（還沒有自動測試時）**
> 你的專案目前沒有自動測試。這套流程原本要求：每次改到程式行為，都要補一支可以重跑的自動測試。
> 要先暫停這個要求嗎？暫停期間改成：Claude 每次實際跑過並把輸出貼給你看。
> 建議：<選項>——<一行理由>。

**第 7 題（動手前必讀的文件）**
> 我找到這些你們既有的規範文件：<檔名清單>。哪幾份要設成 Claude 每次動手前都先讀？
> 建議：<檔名>——<一行理由>。

### Q1 的預設 pipeline（原版照搬）

```
[對齊回合] → backend-architect 設計 → backend-engineer 實作 ┐
             frontend-engineer 實作（等 API Contract 確認後）┘
           → qa-engineer 測試計畫＋開畫面實測＋codify
           → code-reviewer 審查 → 完成
```

**配套三條（裁切不拿掉，Q1 一併展示）**：

1. **無條件對齊回合**：行為類需求開工前必過一回合、不可跳過——有決策型解讀分岔就逐題訪談到清零；無分岔就明說「無分岔＋一句理由」讓使用者可否決才開工，靜默開工＝違規。
2. **QA 先於 review**：行為類一律先 QA 實測、再送審查——靜態審查看不出跑起來才會出的錯。
3. **分流例外**：純結構／文案／死碼等「靜態可確定等價」者，可審查過即完成、QA 可評估跳過（判準＝正確性能否只靠讀 code 確定）。

### 自動裁切規則（Phase 2 先套用，Q1 再讓使用者改）

| 盤點結果 | 裁切 |
|----------|------|
| **無後端** | 拿掉 `backend-architect` 與 `backend-engineer`；frontend-engineer 的前置條件改成「API／資料來源已確認」 |
| **無前端** | 拿掉 `frontend-engineer`；QA 改跑測試指令（qa-engineer 用 (C) 段） |
| **非瀏覽器前端** | 保留 `frontend-engineer`；QA 改寫（qa-engineer 用 (B) 段），不裝 qa-webwright |
| **前後端同 repo 且無分層**（前後端程式碼混在同一套目錄結構、沒有 API 邊界） | `architect` 與 `engineer` 併一步：engineer 先產出設計文件並經簽收再實作（backend-engineer 骨架的併步改寫說明） |
| **單人小專案**（1 個 repo、`git ls-files` < 50 檔） | `architect` 併入 `engineer`，**但保留對齊回合與 QA**——小專案省的是角色切換，不是驗證 |
| **已有自己的 agents** | 用他的名字：不建同名通用 agent，02 對照表、04 模板、check-agent-model 名單全部改填既有名稱 |

多條同時成立時全部套用（例：無後端＋單人小專案＝只剩 frontend-engineer → qa-engineer → code-reviewer，且 architect 職責併入 frontend-engineer 的設計步驟）。

### Q4 單人／團隊 → 落點與紅區語義

| | 單人 | 團隊 |
|---|------|------|
| 制度檔落點 | workspace 根（不進版控；零外向風險）—— remote 指向客戶時尤其如此 | repo 內（進版控，大家共用同一套制度） |
| settings | `.claude/settings.local.json`（個人層） | `.claude/settings.json`（進版控） |
| hook 指令路徑 | 絕對路徑 | `"$CLAUDE_PROJECT_DIR"/.claude/hooks/<檔>`（別台機器路徑不同；冷啟探針會驗證它真的解析得到） |
| 紅區語義 | 改前徵得「使用者」同意 | 改前需團隊共識（走 PR 審查）；Claude 端的紀律仍是「先說明原因＋位置＋建議內容，確認後才動」 |
| memory | 個人 auto-memory | 個人 auto-memory 不共享——團隊共享的教訓要升格進制度檔或知識容器（05 §6） |

### Q5 的 hook 清單怎麼來：照形狀目錄推導，不是從菜單挑

正本＝`references/hook-catalog.md`（來源專案 24 支 hook＋3 個 plugin 自帶閘，逐支拆成「通用形狀＋觸發條件＋專案參數」，分 A 必裝／B 盤點觸發／C 工作法觸發／D 由 plugin 提供／E 長出來才裝五類）。**沒有數量上限**——裝幾支由這個專案的事實決定。

推導（事實判定，不問使用者）：

1. 形狀目錄逐列判觸發條件，用 Phase 1 十一項與 Q1–Q4 的答案。
2. **B 類的每一個風險都要落成一條規則**：Phase 1 第 8 項的危險動作候選（Q2 勾選的）、第 10 項的執行期風險事實，各自變成 `guard-risky-command.js` 或 `guard-test-preconditions.js` 的一條規則。**熔斷清單上的項目只寫進文字、沒有對應規則＝推導不完整**——只能靠人判斷、做不成樣式比對的，要在 Q5 與收尾回報逐項說明為什麼停在文字（對使用者這樣講：「<某動作>沒辦法從指令的樣子認出來，所以沒有自動檢查，只寫進規則文件，靠 Claude 做之前自己停下來問你」）。
3. D 類不複製，列進安裝指引；E 類不裝，寫進 05 §6 的「可升格機械閘」清單。

Q5 攤給使用者的格式（每項一列；不列 A～E 分類，第一欄是白話名稱，檔名放最後一欄）：

```
| 自動檢查 | 會擋下什麼 | 為什麼你的專案需要 | 檔名 |
| 派工時一定要指定模型 | 派 agent 時沒指定模型（會默默沿用主對話的模型；主對話用高階模型時，每個 agent 也跟著用高階模型） | 第 1 題建了 4 個 agent 角色 | check-agent-model |
| 不准用最高權限帳號連資料庫 | 用 postgres 帳號連線（可以刪掉任何資料庫） | api/.env.example 第 3 行的連線字串用 postgres | guard-risky-command |
| 跑測試前檢查寄信設定 | 寄信伺服器沒指向本機的假收件匣就跑測試（測試信會真的寄出去） | api/src/server.js 第 5 行用 nodemailer 寄信 | guard-test-preconditions |
...
沒有裝的：
- 本機設定檔保護（backup-local-hacks 等三項）：本機覆寫清單（`.claude/local-overrides.yml`）不存在或沒有任何條目，也沒有只給本機用的設定檔（例如 `*.local.*`、`appsettings.*.json`）
- 寫測試時自動檢查測試品質（guard-test-asset-hygiene）：要等專案有自己的測試檢查腳本（例如抓測試寫死資料）才用得到
```

使用者只能**取消**（「不要 X」），不能從空清單挑——預設是全裝，取消的在收尾回報記「使用者取消：X」。**推導清單一律在 Phase 4 生成前完整印出**，即使使用者已預先給了「全裝」之類的答案、或無人值守執行——清單本身是使用者能否決的依據，不能只在收尾回報裡事後補。外部 plugin 的安裝是互動 UI（`/plugin install`），Claude 不能代裝——列出安裝指令請使用者執行，並在收尾回報標註「未裝則對應探針跳過」。

---

## Phase 4 — 生成（五層）

以骨架為底逐檔生成。所有 `{{...}}` 必須填掉或整段刪除（該段不適用時）；**不確定的事實回 Phase 1 查證，不得留猜測**。落點中的 `<落點>` 依 Q4：單人＝workspace 根、團隊＝repo 根。

### 文件層（6 份 md）

| 來源（`references/`） | 落點 | 填空重點 |
|------|------|----------|
| `skeleton-CLAUDE-md.md` | `<落點>/CLAUDE.md` | workspace 對照、治理分層、絕對邊界（含 Q2 熔斷清單、敏感物）、pipeline 圖（Q1）、路由表（含容器、agents、hooks、Q7 必讀） |
| `skeleton-harness-README.md` | `<落點>/.claude/harness/README.md` | 五層清單、生效範圍限制照實寫、誠實揭露 |
| `skeleton-02-model-dispatch.md` | `<落點>/.claude/harness/02-model-dispatch.md` | agent 對照表（Q1 裁切後）、MCP 紀律（依前端分類保留或改寫）、hook 強制句（Q5） |
| `skeleton-03-judgment-matrix.md` | `<落點>/.claude/harness/03-judgment-matrix.md` | 驗證指令（Phase 1 第 2 項）、B 系列參數（測試目錄、QA agent、工具）、C2 熔斷清單（Q2）；**不適用條款保留編號改寫為「本專案不適用：<理由>」，不刪列** |
| `skeleton-04-delegation-templates.md` | `<落點>/.claude/harness/04-delegation-templates.md` | 必讀清單（Q7）、模板五 pipeline（Q1；有既有治理層走 (A) 讓位版）、模板六參數、Q6 豁免行 |
| `skeleton-05-knowledge-protocol.md` | `<落點>/.claude/harness/05-knowledge-protocol.md` | 紅區清單（含既有治理層檔案、Q4 紅區語義）、健檢清單列出實際裝的 hook 與其 dry-run 輸入 |

### 可執行層（hook）

| 來源（`../../hooks/templates/`） | 落點 | 填空重點 |
|------|------|----------|
| Q5 推導並經使用者確認的每支範本 | `<落點>/.claude/hooks/<同名>.js` | 檔頭「init 填空區」常數：照形狀目錄該列的「專案參數」欄填（agent 名單、副檔名與 repo 清單、容器路徑、`TRIGGER_MODE`、覆寫清單路徑…） |
| `guard-risky-command.js`、`guard-test-preconditions.js` | 同上 | `RULES`／`CHECKS` 陣列：Q5 推導出的每條 B 類規則。每條的樣式要用 Phase 1 **實際看到的**指令與值寫，不寫泛用猜測。專案有多個子專案（例：web／api）時，`CHECKS` 每條都要用 `when` 限定到真正需要它的子專案指令（寄信收斂只套 api 的測試、不套 web 的 vitest），否則會把無關的測試一起擋下。比對路徑的樣式，前導字元集要同時認 `/` 與 Windows 的 `\`（寫在 RULES 字串裡是 `[\\s/\\\\]`）——只寫 `/` 會漏掉 PowerShell 的 `.\deploy.ps1` |
| `shell-model.js`＋`package.json`＋`package-lock.json`（裝了任一個規則引擎時） | `<落點>/.claude/hooks/` | 不填空。複製後在 `.claude/hooks/` 跑 `npm ci`，把 `.claude/hooks/node_modules/` 加進 `.gitignore`（沒有就建）。`npm ci` 失敗（無網路、沒有 npm、平台沒有預編譯檔）**不擋 init**：兩支引擎會退回正則判法照樣運作，在收尾回報寫明「語法解析器未裝、目前是正則判法」並附失敗原文 |
| `probe-hooks.js`＋`cases/`（只複製有裝的 hook 對應的 cases）；裝了本機覆寫三件組任一支時連同 `restore-local-hacks.js` 與其 cases | `<落點>/.claude/hooks/` | **填空區改了什麼，cases 同步改**：agent 名單換了→案例的 subagent_type 換成實際名字；B 類規則填了→把範本 cases 裡注入示範規則的 variant 換成本專案實際規則，並為每條規則補一擋一放的案例 |

**B 類規則的訊息怎麼寫**（`reason`／`fix` 是模型被擋下時唯一讀得到的東西，寫錯會把它帶去錯的方向）：

1. **理由寫這個專案的真實後果**：講被擋的東西實際會造成什麼（連到哪台主機、清掉哪張表、寄給誰），不要沿用別的專案或範本示範規則的理由。例：高權帳號連線的風險是「繞過所有權限、可以刪任何資料庫」，不是「密碼錯幾次會被鎖」。
2. **放行方式必須照做就能跑**：寫出的指令要在它說的位置真的執行得起來——不是只要過得了閘。Phase 1 查到的腳本問題（例如測試腳本在目前的執行環境跑不起來）要繞開，給能跑的寫法。
3. **不把機密值塞進指令列**：有環境檔就給 `node --env-file=<檔>`、`source <檔>` 這類載入寫法，不要叫模型把連線字串、密碼貼進指令（會留在指令列與對話紀錄）。
4. **Bash 與 PowerShell 都給**：Phase 0 看得到 PowerShell 工具的環境，每條放行方式都附 PowerShell 寫法。
5. **不寫引擎的盲點**：「分兩次呼叫就看不到」「用變數組就擋不住」這類已知極限寫進 hook 檔頭註解給維護者看，**絕不寫進 `reason`／`fix`**——寫進擋下訊息等於教被擋的人怎麼繞。
6. **只指向存在的東西**：放行方式提到的 skill、腳本、檔案，此刻都要存在（沒裝的 plugin 不寫成可用選項）；前提（單人或團隊、有沒有裝某 plugin）照 Q 的答案寫，不寫「別人正在用」這類與 Q4 不符的敘述。

**複製，不是引用 `${CLAUDE_PLUGIN_ROOT}`**：實例自治、使用者可自改；代價是 plugin 更新不自動同步（在 harness README 寫明）。複製後在 `<落點>/.claude/hooks/` 跑 `node probe-hooks.js`，**全數符合預期才往下走**；有裝規則引擎時看開頭那行是否為「語法樹路徑」，再跑一次 `node probe-hooks.js --parser=off`（正則路徑，解析器沒裝的團隊成員走的就是這條），要沒有 FAIL——標「只有語法樹路徑做得到」的案例是正則路徑的已知極限，略過並計數。

### agent 層（5 份）

| 來源（`references/agents/`） | 落點 | 填空重點 |
|------|------|----------|
| `skeleton-agent-backend-architect.md` | `<落點>/.claude/agents/backend-architect.md` | 專案名、分層方向、必讀清單；Q1 裁掉則不建 |
| `skeleton-agent-backend-engineer.md` | `<落點>/.claude/agents/backend-engineer.md` | 技術棧、硬性規則（引用規範檔條目標題＋路徑，不複製內文）、build 指令；併步裁切時改寫前置條件 |
| `skeleton-agent-frontend-engineer.md` | `<落點>/.claude/agents/frontend-engineer.md` | 技術棧、規範、i18n；無前端不建 |
| `skeleton-agent-qa-engineer.md` | `<落點>/.claude/agents/qa-engineer.md` | 依前端分類保留 (A)／(B)／(C) 其一；測試目錄與指令 |
| `skeleton-agent-code-reviewer.md` | `<落點>/.claude/agents/code-reviewer.md` | 規範來源、靜態掃描工具；**VERDICT 輸出格式不得改**（git-commit C 軌依賴它） |

「已有自己的 agents」時不建同名檔；只把 harness 需要的段落（交接契約、回報格式）以建議形式列在收尾回報，由使用者決定要不要合併。

### 知識容器層（3 份）

| 來源（`references/containers/`） | 落點 | 填空重點 |
|------|------|----------|
| `skeleton-CONTEXT.md` | `<落點>/CONTEXT.md` | 專案名；**不替使用者編詞條**，只留標明「示範」的一條 |
| `skeleton-FLOWS.md` | `<落點>/FLOWS.md` | 模組單位（repo／服務／模組）；**不憑盤點畫鏈路**，只留示範 |
| `skeleton-PROJECT.md` | `<落點>/tests/Project_Detail/PROJECT.md` | 「環境與執行」節填 Phase 1 查證事實；其餘三節只留示範 |

### settings 層

| 來源 | 落點 | 內容 |
|------|------|------|
| 每支已裝 hook 檔頭的「接線」註解 | Q4 決定：`<落點>/.claude/settings.local.json`（單人）或 `.claude/settings.json`（團隊） | `hooks` 區接上每支 hook（PreToolUse matcher 照檔頭）；Phase 0-4 缺的 `mcp__playwright__*` 補進 `permissions.allow`（僅瀏覽器可驅動時）。**既有 settings 檔先建 `.bak` 再以 JSON 合併寫回，不整檔覆蓋**；寫完 `node -e "JSON.parse(...)"` 驗格式 |

壓縮交接五支（形狀目錄第 26 列）掛四個事件：PreCompact 的 timeout 必須大於 `compact-handoff.js` 的 `CHILD_TIMEOUT`（範本為 240 秒對 220 秒，差距留給快照寫檔），否則交接信寫到一半被中止，兩者要一起調；`compact-reinject.js` 掛 SessionStart matcher `compact`，只在壓縮後注入；`resume-stale-reminder.js` 掛 SessionStart matcher `resume`，只在 resume 時判斷要不要提醒。

SessionStart 提醒由本 plugin 的條件式 hook 提供（偵測到 `.claude/harness/README.md` 才輸出），啟用本 plugin 的專案不必在 settings 重複加；未啟用本 plugin 的專案才在 settings 補一條 inline 提醒。

---

## Phase 5 — 驗收（兩層，任一項失敗＝init 未完成）

### 第一層：靜態九項

```
□ grep "{{" 於所有實例檔（文件層、agent 層、容器層、hook 檔）= 0 命中（無殘留填空；hook 檔的「init 填空區」常數已填）
□ grep 污染詞表 = 0 命中（詞表＝本 plugin 的 skills/init/pollution-wordlist.txt；
  指令見 adaptation-guide §4.1；命中逐筆判斷：目標專案查證過的事實可留，骨架漏進來的來源事實要清；changelog 出處標註除外）
□ 實例內引用的路徑逐條 ls 存在（含路由表、必讀清單、指向既有治理層的路徑、settings 裡的 hook 指令路徑）
□ 03 矩陣 B 寫入的每條驗證指令，指令本體實際存在（腳本檔在、npm script 有定義、測試目錄在）
□ 每個實例檔 Read 回檔尾確認未截斷；每支 hook `node --check` 通過；settings JSON 可解析
□ 在 <落點>/.claude/hooks/ 跑 `node probe-hooks.js`：全數符合預期、沒有「缺 cases」（這是行為層，前幾條只是結構層）
□ 有裝規則引擎：probe-hooks.js 開頭那行要是「語法樹路徑（Bash 與 PowerShell 解析器都已載入）」；
  `node probe-hooks.js --parser=off` 也要沒有 FAIL（標「只有語法樹路徑做得到」的案例會略過並計數）；在 <落點>（專案根目錄，不是 .claude/hooks）跑
  `node -e "const s=require('./.claude/hooks/shell-model.js');console.log(s.available('Bash'),s.available('PowerShell'))"`
  印 `true true`（任一個 false＝該文法沒裝上，對應的指令走正則判法，回報寫明）；`git check-ignore .claude/hooks/node_modules` 有輸出（不會被 commit 進去）
□ B 類每條規則的「放行方式」若是可照抄的指令：①以同一個 hook 餵回去必須放行 ②在它說的位置實際執行一次（唯讀或無害的才實跑；有副作用的只驗①並在回報裡註明）——過得了閘卻跑不起來的放行方式，照上面「訊息怎麼寫」第 2 點改寫。另掃一次 `reason`／`fix` 不得出現「看不到」「擋不住」「限制」這類引擎盲點字樣
□ 形狀目錄逐列對帳：每一列都有「已裝／不裝＋理由／由 plugin 提供」三者之一；B 類每個 Q2 勾選項都對得到一條規則
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
| P4 | **git-commit 攔不攔得住裸 git commit（兩種殼都要）** | 探針前先記 `git -C <repo> rev-parse HEAD`。prompt：「先用 Bash、再用 PowerShell 各執行一次 `git commit --dry-run --allow-empty -m harness-probe`，把兩次工具回傳原文完整貼出。」（沒有 PowerShell 工具的環境只跑 Bash） | 兩次回傳原文都是 hook 擋下的訊息（非 git 自己的輸出），且探針後 `rev-parse HEAD` 與探針前相同 | 0-1 是 git repo 且有裝 git-commit plugin |
| P5 | **B 類規則的接線是真的**（Claude Code 真的會對 Bash／PowerShell 叫 `guard-risky-command`） | 每條規則造一條**就算沒被擋也無害**的觸發指令：在命中規則樣式的前提下加 `--help`／`--version`／`--dry-run`，或指向不存在的主機、不存在的檔案。prompt：「用 Bash 執行 `<無害觸發指令>`，把工具回傳原文完整貼出。」 | 回傳原文為 guard-risky-command 的擋下訊息 | 有裝 guard-risky-command 且至少一條規則造得出無害形式；**造不出無害形式的規則不准拿來冷啟**（只靠 probe-hooks 驗行為），在回報裡寫明 |

- **探針基底 prompt**（P1／P2 共用）：「只回覆 PROBE-OK」加上該 agent 在 `check-review-discipline.js` 的 `REQUIRED_MARKERS` 裡要求的每個標記（共用的回報鏈鐵則、【驗收條件】、【回報格式】，加上該 agent 自己的欄位），每欄寫一句最小內容即可。P1 與 P2 之間**唯一的差別是有沒有帶 model**——一次只變一個變因，否則 P1 被擋時分不出是哪支閘擋的。沒裝 check-review-discipline 時基底就是「只回覆 PROBE-OK」。
- 用 `--dry-run` 是為了**探針失敗時也不會真的建 commit**。
- 前提不成立的探針標「不適用：<原因>」，不算失敗；**前提成立卻沒跑＝未完成**。
- 任一 FAIL → 回 Phase 4 修（常見原因：settings 接線路徑錯、`$CLAUDE_PROJECT_DIR` 沒展開、hook 檔名不一致、agent 名單沒填對），修完**整組重跑**，不是只重跑失敗那項。
- 探針的原始輸出貼進收尾回報（證據紀律：只寫「探針通過」不算）。

### 收尾回報（誠實條款，缺一不算完成）

七段的內容如下；寫給使用者時照「對使用者講話的寫法」，段名可以直接用下面的粗體字。

1. **裝了哪些東西**：逐檔列出路徑，每個檔附一句用途。接著列「我替你做的決定」：拿掉了哪些角色、沿用了你們哪些既有規範、哪些是我先決定的（無人值守時，剛才盤點推導出的預設全列在這裡，註明「你可以推翻」）。
2. **驗收證據**：靜態檢查九項逐項結果，加上「開新 session 實際試擋」五項的原始輸出。
3. **你已經有的**：
   - 一套開發流程：各角色的分工與順序（列出來）、固定跟著流程走的三條規則、40 條判斷規則（什麼時候該停下來換方法、怎樣才算做完、哪些動作要先問你）、派工範本、記錄踩坑的規則
   - <N> 項會真的擋下來的自動檢查，每項一句講它擋什麼；危險指令檢查逐條列出各自對應的風險。<N> 個 agent 角色（名稱加中文職稱）
   - 沒有裝的自動檢查逐項列出與原因：用不到／你取消的／要另裝某個 plugin／要等專案有了某個工具才用得到
   - 三份知識筆記檔（`CONTEXT.md` 詞彙表、`FLOWS.md` 跨模組流程、`PROJECT.md` 測試知識）的空白範本與收錄原則
4. **你還沒有的**（照實列，不要美化）：
   - **踩坑知識 0 條**——memory 與三份知識筆記檔都是空的（只有示範條目）。成熟的 harness 靠的是數十到上百條「這裡曾經出過什麼事」，那些只能從本專案自己的工作裡長出來。
   - **回歸測試 0 支**（init 不寫測試）<若 Phase 1 盤點到既有測試，寫「既有測試 N 支，還沒照這套流程檢視過」>
   - 每個模組測到哪裡的登記、專案專屬的檢查腳本、針對過去事故寫的規則——全部沒有。
   - 目前的規則都是通用版本：裡面的數字與範例還沒被本專案真實發生過的問題校正過。
5. **之後怎麼讓它越用越貼合**：
   - 每次踩坑 → 照 `05-knowledge-protocol.md` 的「踩坑紀錄格式」記進 memory；同一類坑第二次出現 → 照同一檔的「升格協議」提議寫進正式規則，能自動檢查的就一起做成自動檢查
   - 每次 commit → commit 前會問你四個問題（這次有沒有新名詞、新的跨模組流程、新的測試知識、自創的縮寫），答案記進知識筆記檔
   - 每次改到程式行為 → 補一支可以重跑的自動測試
   - 每 30 天 → 照 `05-knowledge-protocol.md` 的「定期健檢」檢查一次，包括拿每項自動檢查試跑：該擋的有擋、不該擋的有放行
6. **在哪裡開 session 才有效**：自動檢查只在設定所在的那一層目錄開 session 時生效。在子 repo 裡開 session，`CLAUDE.md` 仍會被讀到（上層目錄的也會讀），但 workspace 根的自動檢查不會跑。
7. **盤點發現的專案本身問題**（文件寫的指令其實不存在、沒有測試、敏感檔沒被 `.gitignore` 擋）照實回報，不略過。
