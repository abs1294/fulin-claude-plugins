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
4. **既有設定分兩種對待**：
   - **既有的 Claude Code 設定（`.claude/`、`CLAUDE.md`，含之前裝過的 harness）是參考來源，不是權威**。使用者會在已經有設定的專案跑 init，代表他覺得原本的流程有問題，想換這套試試。所以不停下、不讓位：先整份備份，再把它當成盤點證據（裡面的指令、邊界、保護動作、agent 分工都是這個專案的事實），逐項決定沿用、併入或取代，並問出原本哪裡不好用（見 Phase 0-2、Phase 1 第 12 項、第 0 題）。
   - **其他工具共用的治理層（AGENTS.md／.agents/／.cursor/ 這類多工具規範）讓位**：harness 只補 Claude Code 特有行為層，開發流程正本讓給它（adaptation-guide §2）。這些檔不只 Claude 在用，改掉會影響別的工具與別的人。
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
- **送出前自掃一次**：拿上表左欄逐詞搜自己的草稿，命中就改寫再送。上表的機械可讀版在 `plain-language-terms.json`（另收了流程圖實際被指出看不懂的詞：派工、欄位、對齊回合、主對話、快照、注回…），流程圖與收尾回報由 Phase 6 的易讀性自檢腳本掃；兩份要同步。

## 流程總覽

```
Phase 0 前置檢查 ─→ Phase 1 盤點（唯讀） ─→ Phase 2 攤開核對 ─→ Phase 3 訪談（一次一題，Q0~Q7）
                                                                          │
收尾回報 ←─ Phase 6 流程圖 ←─ Phase 5 驗收（靜態十項＋冷啟探針五項） ←─ Phase 4 生成（五層）
```

**已經有 Claude Code 設定的專案**（Phase 0-2 判定）多走四步：Phase 0 先整份備份 → Phase 1 第 12 項盤點原有設定 → Phase 2 攤出「原有設定怎麼處理」對照表 → Phase 3 第 0 題問原本哪裡不好用。收尾回報多一段交代原有設定的去向與痛點有沒有解。

任一 Phase 未完成不得進下一個。Phase 5 任一項失敗＝init 未完成。

---

## Phase 0 — 前置檢查（四項；0-3 不過就停在這裡，其餘記下繼續）

先確認目標 workspace 路徑（預設＝當前工作目錄；使用者指定別的路徑就用那個）。

**第一個動作、在動任何檔案之前：拍快照**（Phase 6 靠它找出 init 新增或改過的每個檔案，事後補拍比不出差異）：

```
node <本 plugin>/skills/init/scripts/check-flow-diagram.js snapshot <目標>
```

之後 Phase 1 實跑測試、Phase 4 生成、Phase 5 探針留下的所有變動都會被 Phase 6 抓出來——不該留的殘檔要在收尾前刪掉，否則會被要求畫上流程圖。

以下指令一律對目標路徑跑：

| # | 檢查 | 指令 | 不過時 |
|---|------|------|--------|
| 0-1 | 目標是不是 git repo | `git -C <目標> rev-parse --is-inside-work-tree`；workspace 根不是 repo 時再列子資料夾：`for d in <目標>/*/; do git -C "$d" rev-parse --show-toplevel 2>/dev/null; done` | 不是 repo 也可以繼續，但記下「非 git repo」：沉澱閘改綁 Stop hook、git-commit 相關的閘與探針整組不裝不測 |
| 0-2 | 有沒有既有的 Claude Code 設定 | 對 workspace 根與每個子 repo 各查一次：`ls <目標>/CLAUDE.md <目標>/.claude/ 2>/dev/null`；`.claude/` 底下列 `agents/`、`hooks/`、`commands/`、`skills/`、`harness/`，讀 `settings.json`／`settings.local.json` 看有沒有 `hooks`、`permissions`；`CLAUDE.md` 是否含「Harness 路由表」（＝之前裝過 harness） | **不停下**。判定規則：只有 `settings*.json` 且裡面只有 `enabledPlugins`＝**沒有既有設定**，照一般流程走（settings 照 Phase 4 合併）。其餘任何一項存在＝**有既有設定，進入參考模式**：①動 Phase 1 之前先整份備份——`CLAUDE.md`、`.claude/`（排除 `node_modules/`）、`CONTEXT.md`、`FLOWS.md`、`tests/Project_Detail/PROJECT.md` 原樣複製到 `<目標>/.harness-backup/<YYYYMMDD-HHMM>/`（保持相對路徑）；是 git repo 就把 `.harness-backup/` 加進 `.gitignore`；備份完用 `diff -r` 或逐檔 hash 比對確認一致，比對不過就停 ②Phase 1 第 12 項盤點原有設定 ③Phase 3 第 0 題問原本哪裡不好用。之前裝過 harness 也一樣走參考模式（重裝），不另外停 |
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

超過 3 檔的探索照骨架 02 的紀律派 `Explore`（prompt 帶上「搜尋限定目標目錄、禁止全碟掃描」）。以下十二項全部查完（第 12 項只在參考模式查），填進盤點表：

| # | 項目 | 怎麼查（實讀，不信 README） | 記下什麼 |
|---|------|----------------------------|----------|
| 1 | 技術棧 | 讀套件與建置設定檔：`package.json`、`pyproject.toml`／`requirements.txt`、`go.mod`、`pom.xml`／`build.gradle`、`*.csproj`／`*.sln`、`Cargo.toml`、`Gemfile`、`composer.json`、`pubspec.yaml` | 語言、框架、資料存取方式、資料庫；前端與後端各一行 |
| 2 | build／test 指令 | **實際讀**腳本本體：`package.json` 的 `scripts`、`Makefile`、`*.sh`／`*.bat`／`*.ps1`、CI 設定（`.github/workflows/`、`.gitlab-ci.yml`）。能安全執行的（build、測試列出）實跑一次確認存在 | 每條指令＋「查證方式」（讀到哪個檔哪一行、有沒有實跑）。README 寫了但腳本不存在的，記成「文件漂移」 |
| 3 | repo 結構與 git remote | workspace 根的資料夾；每個 repo 的 `git -C <repo> remote -v`；檔案數（`git -C <repo> ls-files \| wc -l`） | remote 指向外部／客戶伺服器＝push 屬外向動作，要進邊界條款；檔案數供裁切規則判斷「小專案」 |
| 4 | 前端類型（三分類） | 照下方「前端分類判準」 | 瀏覽器可驅動／非瀏覽器前端／無前端，**附證據檔案路徑** |
| 5 | 測試基礎 | 找測試目錄（`tests/`、`test/`、`__tests__/`、`spec/`、`src/test/`）與測試設定；**打開看裡面有沒有東西**——數測試檔數量、讀一支確認不是空殼 | 目錄存在 ≠ 有測試（曾實測某 repo 自述有測試目錄，實際不存在）。記「有且有 N 支實測／有目錄但空／無」 |
| 6 | 既有治理層 | `AGENTS.md`、`.agents/`、`.cursor/`、`.github/copilot-instructions.md`、`CONTRIBUTING.md`、`docs/` 底下的開發規範、CI 規範（既有 `CLAUDE.md`／`.claude/` 不在這項，歸第 12 項） | 有 → 記下它管什麼（流程／規範／stack 限制），harness 讓位；這些檔也是 Q7「必讀文件」的候選 |
| 7 | 既有 agent | `.claude/agents/`、`.agents/`、plugin 提供的 agent（`claude plugin list` 或讀 `~/.claude/settings.json` 的 enabledPlugins） | 有 → Q1 裁切規則「已有自己的 agents→用他的名字」 |
| 8 | 外部副作用路徑 | 照下方「危險動作候選推導」掃描表逐類 grep | 每類命中的檔案:行號（取樣 ≤5 筆）＋判斷是真路徑還是假命中；供 Q2 |
| 9 | 敏感物 | `.env*`、`*.pem`／`*.key`／`*.pfx`、`credentials*`、`secrets*`、VPN 設定、客戶機密目錄；`.gitignore` 有沒有擋 | 進實例 CLAUDE.md 絕對邊界（「不得出現在 commit、文件、對外輸出」）；沒被 `.gitignore` 擋的要回報 |
| 10 | 執行期風險事實（B 類 hook 的依據） | ①資料庫：用戶端指令（`psql`／`mysql`／`sqlcmd`／`mongosh`／`redis-cli`）出現在腳本或文件、連線字串與其中的帳號（`sa`／`root`／`postgres`／`admin` 這類高權帳號要特別記）、正式與測試庫主機名 ②起服務：啟動指令與它依賴的環境變數（`NODE_ENV`／`ASPNETCORE_ENVIRONMENT`／`SPRING_PROFILES_ACTIVE`／`--profile`／`.env.<環境>`） ③測試指令本體（第 2 項已查）與測試是否讀環境變數或設定檔（`process.env`／`os.environ`／`.env.test`／測試設定檔） | 每一項都會變成 `guard-risky-command` 或 `guard-test-preconditions` 的一條規則（見 `references/hook-catalog.md` 第 10–14 列）；記下樣式與「正確值」長什麼樣 |
| 11 | 工作法（C 類 hook 的依據） | `.claude/local-overrides.yml` 有沒有條目；有沒有本機覆寫檔（`*.local.*`、`appsettings.*.json`、`.env.local`、`settings.local.*` 被追蹤卻常有未提交改動——`git status` 看一次）；有沒有多工作樹（`git worktree list`） | 有本機覆寫 → 裝本機覆寫保護三件組（形狀目錄第 16–18 列）；只有多工作樹沒有覆寫檔 → 不裝，記進收尾回報 |
| 12 | 原有的 Claude Code 設定（**僅參考模式**） | 從備份讀，逐項**打開看內容**，不只列檔名：`CLAUDE.md` 每一節；`.claude/agents/*.md` 每支的職責、工具、模型、硬性規則；`.claude/hooks/*` 每支擋什麼（讀程式，不信檔頭註解）與 settings 裡怎麼接線；`.claude/commands/`、`.claude/skills/` 各做什麼；settings 的 `permissions`（allow／deny／ask）；之前裝過 harness 的話，另讀 `05-knowledge-protocol.md` 的健檢紀錄、三份知識筆記檔有沒有真實條目（示範條目不算） | 每一項記「它在管什麼」＋「對應到 harness 的哪一塊」＋預設處置（見下方「原有設定的預設處置」）。**裡面寫到的專案事實是盤點證據**：build／test 指令、禁止動作、保護某個檔或某台主機的 hook，照樣拿去跟第 2、8、10 項交叉查證——原有 hook 在擋的東西，代表使用者在乎那個風險，Q2 與 Q5 要列入，不能因為 harness 的形狀目錄沒有就丟掉 |

### 原有設定的預設處置（參考模式）

原則：**事實與知識一律留下，流程與機制換成 harness 的，但每一項都要在 Phase 2 攤給使用者否決**。不靜默刪除任何東西——就算有備份，使用者沒看到就是沒交代。

| 原有的東西 | 預設處置 | 為什麼 |
|---|---|---|
| `CLAUDE.md` | **取代**：用 harness 骨架重寫；原檔裡的專案事實（指令、路徑、邊界、禁止事項、術語）逐條搬進新檔對應的節；流程類規定（怎麼派工、怎麼審查）由 harness 的取代。每條原規則記去向：搬進哪一節／被哪條 harness 規則取代／沒搬（理由） | 使用者就是對原本的流程不滿意；但專案事實不會因為換流程而失效 |
| 角色與 harness 某個 agent 相同的 agent（例：原本的 reviewer 對上 code-reviewer） | **併入**：用 harness 骨架建，原 agent 裡的專案專屬內容（技術棧規範、檢查清單、禁止事項）搬進新檔的硬性規則。名字預設用 harness 的名字；使用者要保留原名就用原名，02 對照表、04 模板、check-agent-model 名單跟著改 | 骨架帶交接契約與回報格式（派工閘與 git-commit 依賴它們），原 agent 帶專案知識，兩邊都要 |
| harness 沒有對應角色的 agent（例：資料遷移專員、文件撰寫） | **沿用**：原檔不動，加進 02 對照表與 check-agent-model 名單（要在名單裡才受派工檢查管） | 不是 harness 該決定的分工 |
| 原有 hook | 讀程式判斷它擋什麼：形狀與 harness 某支相同 → **取代**（harness 版有 cases 可實測）；harness 沒有的 → **沿用**，照原接線寫進新 settings，並在 05 健檢清單加一列（沒有 cases 可跑，註明「原有 hook，手動試跑」） | 原有 hook 在擋的東西代表使用者在乎那個風險 |
| `commands/`、`skills/` | **沿用**，原封不動 | 不屬於開發流程骨架 |
| settings 的 `permissions` | **沿用**，照 Phase 4 JSON 合併 | 使用者自己決定的權限 |
| 之前裝過的 harness（重裝） | 制度文件與 hook 用新版骨架重生，**上一版填進去的專案參數與規則（B 類規則、agent 名單、Q 的答案）當成這次訪談的預設答案**；知識筆記檔與 05 健檢紀錄的真實條目**原樣保留**，只換結構；memory 不動 | 知識是專案自己長出來的資產，重裝不能歸零 |
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

---

## Phase 2 — 攤開核對（一則訊息，讓使用者糾正事實）

把 Phase 0 與 Phase 1 的結果攤成**一張盤點表**給使用者看，並附上「據此自動推導的預設」。這一步不是提問，是**讓使用者在生成前糾正事實錯誤**——盤點是推論，使用者才知道真相（例：某個 `deploy` 腳本其實早已廢棄）。

內容（下列項目名稱是給你的清單；攤給使用者時照「對使用者講話的寫法」改成白話，例如「危險動作候選清單」寫成「做了收不回來的動作，我找到這幾個」）：

1. 十二項盤點表（每項附證據路徑；查不到的明寫「查不到」；第 12 項非參考模式時不列）
2. Phase 0 四項檢查結果（參考模式另附備份位置與比對結果）
3. 自動推導的預設：
   - 前端分類與對應處置
   - Q1 預設 pipeline 依裁切規則裁完的樣子（先給出，Q1 再讓使用者改）
   - 危險動作候選清單（Q2 的題目來源；參考模式含原有 hook 在擋的東西）
   - 是否觸發 Q3（無前端）、Q6（無測試基礎）
4. 發現的目標專案自身問題（文件漂移、缺測試基礎、敏感物未被 `.gitignore` 擋）
5. **原有設定怎麼處理**（僅參考模式）：每一項一列，照下面格式。使用者在這裡改處置，改了就照改的做

```
| 原有的東西 | 它在管什麼 | 我打算怎麼處理 | 處理後在哪裡 |
| CLAUDE.md 的「部署前要先跑 smoke test」 | 部署前的檢查 | 搬過去（這是專案事實） | 新 CLAUDE.md「絕對邊界」一節 |
| CLAUDE.md 的「改完直接 commit」 | 開發流程 | 換成新流程（改完要先實測、再審查） | 新 CLAUDE.md 的開發流程圖 |
| .claude/agents/reviewer.md | 程式碼審查 | 合併進 code-reviewer（程式碼審查），它的檢查清單搬過去 | .claude/agents/code-reviewer.md |
| .claude/hooks/block-prod-db.js | 擋連正式資料庫 | 保留，繼續接著 | 新 settings 照原樣接線 |
| .claude/commands/deploy.md | 部署指令 | 不動 | 原位 |
```

   表格下面一句話講備份在哪、怎麼還原（「整份原樣在 `.harness-backup/<時間>/`，要還原就把裡面的檔案複製回原位」）。

訊息開頭先用兩三句講結論（這是什麼專案、有沒有前端與測試、找到幾類做了收不回來的動作），再接上面四項；整則訊息的**最後一句**固定是：「以上事實有錯請直接指出；沒有的話我開始逐題訪談（共 N 題）。」使用者糾正的事實回 Phase 1 重查確認後更新表格。**無人值守（headless）時**：照推導預設繼續，所有推導值在收尾回報列為「已代決」供事後否決。

---

## Phase 3 — 訪談（共 7 題，參考模式加問第 0 題；**一次一題**）

**一次一題，不要湊成一次 AskUserQuestion**——每題的答案會改變後面題目的選項（Q1 裁掉 frontend-engineer，Q5 的 hook 名單就跟著變）。每題都附**推薦選項與一行理由**（未附推薦會被 check-ask-discipline 閘擋下，也是三重自查有做的證據）。條件問的題目條件不成立就跳過，並在收尾回報記「Q<N> 跳過：<原因>」。

| 題 | 必問／條件問 | 問什麼 | 答案決定什麼 |
|----|-------------|--------|-------------|
| **Q0** | **僅參考模式問，排在最前面** | 原本的設定哪裡不好用、這次想改善什麼（可複選，附「其他」） | 後面每一題的推薦選項要朝解決這些痛點調整；每個痛點在收尾回報都要交代「這次怎麼處理的，或沒處理、為什麼」。選項從第 12 項盤點推：例如原本沒有審查角色 →「改完沒人審」；原本 hook 只有 0～1 支 →「規則寫了但 Claude 不照做」；CLAUDE.md 很長 →「規則太多、Claude 抓不到重點」 |
| **Q1** | **必問** | 給預設 pipeline（已依裁切規則裁過）讓使用者刪改 | 02 agent 對照表、04 模板五 pipeline、`.claude/agents/` 建哪幾支、check-agent-model 名單 |
| **Q2** | **必問** | Phase 1 掃出來的危險動作，哪些要熔斷（執行前必須徵得同意） | 03 C2 清單、CLAUDE.md 絕對邊界；掃描零命中時改問「有沒有掃不到但確實存在的危險動作」 |
| **Q3** | **僅無前端時問** | 怎樣算做完（沒有畫面可以看，「實際跑起來」的證據是什麼：CLI 輸出？API 回應？產出檔案？） | 03 B3 的驗證方式、qa-engineer 骨架 (C) 段的實測方式 |
| **Q4** | **必問** | 單人還是團隊 | 落點與紅區語義（見下表） |
| **Q5** | **必問** | 攤出依形狀目錄推導出的 hook 清單（每支：擋什麼、為什麼這個專案需要——對應哪個盤點證據或哪題答案），問要不要**取消**哪幾支 | 可執行層裝哪幾支、B 類引擎裝哪幾條規則、settings 層接哪幾條 |
| **Q6** | **僅無測試基礎時問** | 要不要暫時豁免「QA codify 成可重跑測試」的要求（豁免期間 QA 改為實跑＋貼輸出） | 04 模板五配套第 3 條加豁免行、03 B4／B14 的驗證欄改寫 |
| **Q7** | **必問** | 哪幾份文件動手前必讀（從 Phase 1 第 6 項的既有治理層與規範檔中挑） | 04 共通規則的「開工前必讀清單」、五支 agent 的「開工前必讀」、CLAUDE.md 路由表 |

### 每一題對使用者怎麼問（照這個講，`<…>` 換成盤點到的實際內容）

上表是給你判斷用的；下面才是對使用者說的話。每題都要有：要他決定什麼、選了之後會發生什麼、我的建議與理由。

**第 0 題（原本的設定哪裡不好用；只在專案已經有 Claude Code 設定時問）**
> 你的專案原本就有 Claude Code 設定（<例：CLAUDE.md、2 個 agent、1 支自動檢查>），已經整份備份在 `.harness-backup/<時間>/`。
> 會重新裝一套，應該是原本用起來有地方不順。哪些是你想改善的？可以複選：
> 1. <例：規則寫了，但 Claude 常常不照做>
> 2. <例：改完沒人審查，錯到你自己發現>
> 3. <例：CLAUDE.md 太長，Claude 抓不到重點>
> 4. 其他（直接告訴我）
> 建議：<選項>——<一行理由，從盤點到的原有設定推，例：原本只有文字規則、沒有任何自動檢查>。

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
| **已有自己的 agents**（參考模式） | 照 Phase 1「原有設定的預設處置」：同角色的併入 harness 骨架（名字預設用 harness 的，使用者要保留原名就用原名）；harness 沒有的角色沿用並加進名單。02 對照表、04 模板、check-agent-model 名單填最後定案的名字 |
| **AGENTS.md／.agents/ 這類多工具治理層定義了角色** | 用它的名字：不建同名通用 agent，02 對照表、04 模板、check-agent-model 名單全部改填既有名稱（adaptation-guide §2） |

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

1. 形狀目錄逐列判觸發條件，用 Phase 1 十二項與 Q1–Q4 的答案（參考模式：原有 hook 照「原有設定的預設處置」逐支判定取代或沿用，沿用的也列進 Q5 清單，標「原本就有」）。
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

參考模式照 Phase 2 定案的處置表做：「併入」的用骨架建、把原 agent 的專案專屬內容搬進硬性規則（每條註明出自原檔哪一節）；「沿用」的原檔不動。AGENTS.md 這類多工具治理層已定義角色時不建同名檔，只把 harness 需要的段落（交接契約、回報格式）以建議形式列在收尾回報，由使用者決定要不要合併。

### 知識容器層（3 份）

| 來源（`references/containers/`） | 落點 | 填空重點 |
|------|------|----------|
| `skeleton-CONTEXT.md` | `<落點>/CONTEXT.md` | 專案名；**不替使用者編詞條**，只留標明「示範」的一條 |
| `skeleton-FLOWS.md` | `<落點>/FLOWS.md` | 模組單位（repo／服務／模組）；**不憑盤點畫鏈路**，只留示範 |
| `skeleton-PROJECT.md` | `<落點>/tests/Project_Detail/PROJECT.md` | 「環境與執行」節填 Phase 1 查證事實；其餘三節只留示範 |

參考模式：原本的知識筆記檔有真實條目（不是示範）時，**條目原樣搬進新結構，一條都不能少**，示範條目才刪；寫完逐條比對新舊條目數（`grep -c` 各自的條目標記），數字對不上就是漏搬。

### settings 層

| 來源 | 落點 | 內容 |
|------|------|------|
| 每支已裝 hook 檔頭的「接線」註解 | Q4 決定：`<落點>/.claude/settings.local.json`（單人）或 `.claude/settings.json`（團隊） | `hooks` 區接上每支 hook（PreToolUse matcher 照檔頭）；Phase 0-4 缺的 `mcp__playwright__*` 補進 `permissions.allow`（僅瀏覽器可驅動時）。**既有 settings 檔先建 `.bak` 再以 JSON 合併寫回，不整檔覆蓋**；寫完 `node -e "JSON.parse(...)"` 驗格式。參考模式：處置為「沿用」的原有 hook 照原本的接線（事件、matcher、指令）保留；處置為「取代」的把原接線拿掉、只留 harness 版，免得同一件事被擋兩次 |

壓縮交接五支（形狀目錄第 26 列）掛四個事件：PreCompact 的 timeout 必須大於 `compact-handoff.js` 的 `CHILD_TIMEOUT`（範本為 240 秒對 220 秒，差距留給快照寫檔），否則交接信寫到一半被中止，兩者要一起調；`compact-reinject.js` 掛 SessionStart matcher `compact`，只在壓縮後注入；`resume-stale-reminder.js` 掛 SessionStart matcher `resume`，只在 resume 時判斷要不要提醒。

SessionStart 提醒由本 plugin 的條件式 hook 提供（偵測到 `.claude/harness/README.md` 才輸出），啟用本 plugin 的專案不必在 settings 重複加；未啟用本 plugin 的專案才在 settings 補一條 inline 提醒。

---

## Phase 5 — 驗收（兩層，任一項失敗＝init 未完成）

### 第一層：靜態十項

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
□ 參考模式（非參考模式標「不適用」）：①備份與原檔逐檔 hash 一致（在 Phase 4 動檔之前比，Phase 5 再比一次備份本身沒被動過）②Phase 2 處置表逐列對帳：「併入」與取代時搬過去的專案事實，內容在新檔找得到（grep 原句的關鍵詞）；「沿用」的原檔 hash 未變、接線還在；「取代」的原接線已拿掉 ③原知識筆記檔的真實條目數＝新檔條目數 ④原有 CLAUDE.md 的每條規則都在處置表上有去向（逐節對，不抽樣）
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

---

## Phase 6 — 流程圖：裝了什麼、之後一個需求進來會怎麼跑

**為什麼有這一步**：只給檔案清單，使用者看完仍不知道裝了這些之後，下一個需求進來會發生什麼事、每個東西在哪一步起作用（實際回饋：「裝完之後沒有告訴我裝了些什麼」）。所以收尾前畫流程圖，三條硬規則，都由 `scripts/check-flow-diagram.js` 機械檢查：

1. **要畫的清單不是寫死的，是 init 實際動過的檔案**：Phase 0 拍的快照對比現況，新增、修改、刪除的每個檔案都要是某張圖上的一個節點（`label` 含它的名字）。只寫在卡片、線上文字或 sublabel 都不算——卡片是圖外清單，看不出在哪一步（實際回饋：「不應該寫死，要看有新增或更改的檔案」「不是說所有的檔案嗎」）。
2. **每個節點都要有線**，線上標關係：讀、寫、擋、觸發、載入。只擺節點不拉線，看不出它跟流程的關係（實際回饋：「知識筆記裡面讀跟寫的流程也都沒有畫出來」）。
3. **拆成三張圖放同一頁**：全部檔案加上全部關係塞進一張圖，實測 29 處線交叉、線穿過別的節點，讀不出來。

### 1. 找 archify（跑 CLI 驗活，不看目錄在不在）

依序試 `~/.claude/skills/archify`、`~/.agents/skills/archify`，對每個路徑跑 `node <路徑>/bin/archify.mjs doctor`，**exit 0 才算可用**（目錄在但 Node 版本不符或檔案不全時照樣跑不動）。

找不到或都不是 exit 0 → **不准自己裝**，問使用者，四件事一次講完：這是什麼（第三方的流程圖產生工具 tt-a1i/archify，MIT 授權、免費）、為什麼要它（有格式檢查與真瀏覽器量測，比手刻可靠）、裝了會動到什麼（連網下載、寫進 `~/.claude/skills/`，不動這個專案）、不裝會怎樣（改成在終端機給流程表，內容一樣完整，只是沒有圖）。他說要才跑 `npx skills add tt-a1i/archify -g`，裝完再跑一次 doctor。他說不要、或無人值守 → 走第 6 步的退回做法。

### 2. 先列清單，再寫三張圖的 JSON

先寫一個只有 `{"nodes":[],"edges":[]}` 的暫存 JSON，跑一次 `check-flow-diagram.js check <落點> <那個暫存 JSON>` 拿到「init 之後的變動」清單（它會全部列成缺項，這就是要畫的清單）。清單裡有不該留下的殘檔（測試產物、暫存檔）→ 刪掉，不要畫上去。

每個檔案的關係要**查證後才畫**：讀它的是誰、在哪一步（讀 agent 檔的「開工前必讀」、CLAUDE.md 路由表、hook 檔頭的接線與填空區常數），寫它的是誰、在哪一步。查不到就不畫那條線，並在收尾回報說明。

落點：`<落點>/.claude/harness/flow-1.json`～`flow-3.json`，產出 `flow-1.html`～`flow-3.html`，再組成 `flow.html`（路由表要列 `flow.html`）。格式：archify `workflow`、`schema_version: 2`、`meta.quality_profile: "showcase"`、`meta.locale: "zh-CN"`（archify 只收 `en`／`zh-CN`；節點文字照樣寫繁體中文，只有圖例與按鈕會是簡體，這是 archify 的限制）。結構範例見 `references/example-flow-1.json`～`example-flow-3.json`——**只抄結構，內容一律換成這次實際的檔案與查證過的關係**。

| 圖 | 泳道（由上往下） | 放什麼 | 線 |
|---|---|---|---|
| **圖一：需求進來之後怎麼跑** | 自動檢查（擋主對話，`variant: "exception"`）／主對話（含你提出需求、你簽收）／agent 角色／自動檢查（擋 agent，`exception`） | 主線：需求 → 對齊 → 派工 → 第 1 題定案的每支 agent → 收尾。**每支 agent 只畫一個節點、名字照實際裝的檔名**：同一支做兩步（例：architect 併入 engineer 時，engineer 先寫設計、你同意後再寫程式），用「設計給你看」「同意後寫程式」一來一回兩條線表示，小字寫它做哪幾步；畫兩個同名節點，讀者會以為專案裡有兩個角色（實際回饋：被看成有後端架構師）；每支**會擋人的** hook 放在它擋的那一步的上方或下方 | 主線箭頭；步驟 → hook 標「擋」（`variant: "security"`、`role: "error"`） |
| **圖二：文件在哪一步被讀、被寫** | 規則文件（只讀）／流程步驟／知識筆記（讀＋寫）／記憶 | 步驟一列：開 session、對齊、派工、設計＋實作、實測、收尾（不做的步驟拿掉）；CLAUDE.md、harness/README.md、02～05 放在讀它的那一步上方；CONTEXT.md、FLOWS.md、`tests/Project_Detail/` 底下每個檔放在讀它的那一步下方 | 文件 → 步驟標「讀」（`variant: "dashed"`）；步驟 → 文件標「寫」（`variant: "emphasis"`）。**知識筆記讀和寫都要畫**：誰在哪一步讀、誰在哪一步寫，分開兩條線 |
| **圖三：背景自動執行與維護工具** | 設定／觸發時機／背景自動執行／讀寫的資料／維護 | settings 檔；開 session、resume、壓縮前、壓縮後這些時機；不擋人的 hook 與它載入的模組；它們讀寫的東西（專案外的就註明「專案外」）；健檢時跑的 probe-hooks 與 `hooks/cases/` | 時機 → hook 標「觸發」；hook 之間標「載入」；讀寫同圖二的畫法 |

參考模式另把沿用的原有 agent、hook、指令、skill 畫進它所屬的那張圖，sublabel 標「原有」。

限制：
- 同一張圖裡，同一個檔案（agent、hook、文件）只能有一個節點；完整性檢查會擋。
- 一條泳道同一欄只能有一個節點，最多六個；放不下就再開一條泳道，不准合併節點或移到卡片。
- 檔名一律完整寫出。archify 預設節點寬 92px，檔名放不下時 validate 會回報「Label … is wider than node」，這時給該節點設 `width`（約：英數字每字 7px、中文每字 14px，再加 24px），**不准縮寫檔名**。
- 一群用途相同的檔（例：`hooks/cases/` 的測試案例）可以畫成一個目錄節點（label 以 `/` 結尾），sublabel 寫份數；各有作用的檔不准用目錄節點帶過。
- 先不要手寫 `via`、`channelX` 這類座標，驗證報錯再照它給的修法改。

### 3. 驗證與產出（三張各跑一次）

```
node <archify>/bin/archify.mjs validate workflow <flow-N.json> --quality showcase --json
node <archify>/bin/archify.mjs deliver  workflow <flow-N.json> <flow-N.html> --quality showcase --json
node <archify>/bin/archify.mjs visual-check <flow-N.html> --json
```

- validate 有錯就照回報的 `supportedFixes` 修，連續兩輪錯誤數沒有減少就停，照實回報沒修掉的診斷。**線交叉（`composition/proper-crossing`）要靠調整節點所在的欄與泳道消除，不准降成 `standard` 品質來過關**。
- **`deliver` exit 非 0＝沒產出**，不准說成功。
- visual-check 唯一可接受的診斷是 `viewer/viewport-overflow` 且 `overflowX` 為 false（頁面要往下捲）；其他診斷都要修。記下它在 1440 寬回報的 `scrollHeight`（pass 時記 900），組頁要用。
- 組成同一頁：`node <本 plugin>/skills/init/scripts/flow-page.js <落點>/.claude/harness/flow.html "<專案名>：裝了什麼、需求進來怎麼跑" flow-1.html:<高度> flow-2.html:<高度> flow-3.html:<高度>`
- **每張圖都截圖親自看過**：`chrome --headless=new --window-size=1600,1300 --screenshot=<png> file:///<flow-N.html>`。主線看得出順序、檔名完整沒被截斷、每條讀寫線看得出從哪到哪，才算數。

### 4. 完整性檢查（不同判準的兜底，這步沒過不准收尾）

```
node <本 plugin>/skills/init/scripts/check-flow-diagram.js check <落點> <落點>/.claude/harness/flow-1.json <落點>/.claude/harness/flow-2.json <落點>/.claude/harness/flow-3.json
```

腳本不看圖怎麼畫，而是拿 Phase 0 的快照對比現況，列出 init 之後新增、修改、刪除的每個檔案（排除 `.git/`、備份、流程圖本身、測試快取；`node_modules` 收成一項），逐項確認它是三張圖其中一張的節點 label；另外檢查每個節點都至少有一條線。exit 1 會列出缺哪些 → 補節點或補線（殘檔就刪）→ 重跑第 3 步與這一步，直到 exit 0。腳本輸出原文貼進收尾回報。

### 5. 交付前易讀性自檢（流程圖與收尾回報都要過）

讀者是第一次用 harness 的人。流程圖上的每一句話（標題、泳道、節點小字、線上的字）與收尾回報，都要讓他不用開口問就看得懂（實際回饋：流程圖寫「派工缺欄位」，第一次用的人根本不知道是什麼意思）。規則依據是 deliver-report plugin 的易讀性鐵則。

```
node <本 plugin>/skills/init/scripts/readability-check.js <落點> <落點>/.claude/harness/flow-1.json <落點>/.claude/harness/flow-2.json <落點>/.claude/harness/flow-3.json <落點>/.claude/harness/install-report.md
```

- **exit 3＝這個專案看不到可用的 deliver-report**（沒裝，或被停用）：跳過這一步，照腳本印的那段話在收尾回報告訴使用者「這次沒做易讀性自檢，要裝的話輸入 `/plugin install deliver-report@fulin-plugins`」（Claude 不能代裝）。不准因為沒裝就卡住 init。
- **exit 1**：逐項改。內部用語換成腳本給的說法；節點小字放不下說明就改寫整句，不准用「（見圖二）」這類叫讀者去別處找的寫法。改完**整份重跑**，不是只重跑被點到的那一處。
- **exit 0 之後還沒完**：腳本會印出它判不準的幾條（兩邊對照、資訊放一起、重複、做完寫成做完…）。**先把它印出的規則檔全文讀完**，再對三張圖與收尾回報逐條自檢，改到的地方重跑第 3 步的 deliver。
- 內部用語清單在 `plain-language-terms.json`，是本檔「對使用者講話的寫法」對照表的機械可讀版；使用者再指出看不懂的詞，兩邊一起加。
- 沒有 archify、改用 Markdown 流程表時，把指令裡的三個 flow-N.json 換成 `flow.md`。
- 範圍：流程圖三張（或 `flow.md`）＋收尾回報。寫進專案的制度文件（CLAUDE.md、02～05、agent 檔）是給 Claude 照做的規則，本來就用內部用語，不在這一步的範圍。

### 6. 給使用者看

- 有 archify：用系統預設瀏覽器打開 `flow.html`（Windows `start "" <路徑>`、macOS `open`、Linux `xdg-open`；無人值守時不開，只給路徑）。
- 沒有 archify：寫一份 Markdown 流程表到 `<落點>/.claude/harness/flow.md`，一樣分三節對應三張圖；每一列是一步，欄位是「步驟｜誰做｜讀了哪些檔｜寫了哪些檔｜被哪支自動檢查擋｜觸發了什麼」，每個變動檔都要以完整檔名出現在它那一步；第 4 步的完整性檢查改對這份檔跑，同樣要 exit 0。

### 收尾回報（誠實條款，缺一不算完成）

先寫成檔案 `<落點>/.claude/harness/install-report.md`，過完上面第 5 步的易讀性自檢，再把同樣的內容貼給使用者（之後他也能回頭看這份檔）。下面八段（參考模式九段）；寫給使用者時照「對使用者講話的寫法」，段名可以直接用下面的粗體字。**第 1、2 段放最前面**——使用者最想知道的是「之後會怎麼跑」與「裝了什麼」，驗收證據往後放。

1. **之後一個需求進來會怎麼跑**：先給流程圖的路徑（說明已經在瀏覽器打開）；接著在終端機寫一段 5～8 步的文字版，每步一行：誰做、讀了哪些檔、寫了哪些檔、哪個自動檢查在這一步擋什麼、卡住時會怎樣；背景與維護另寫兩三行。**圖打不開也要看得懂**，每個檔名都要出現在它那一步。最後一句講「完整性檢查：init 新增 N、修改 M、刪除 K 項，每一項都是圖上的節點、每個節點都有線」，附腳本輸出。
2. **裝了哪些東西**：逐檔列出路徑，每個檔附一句用途，分新增／修改／刪除。**項目要和完整性檢查腳本列的變動清單一致**（腳本列幾項，這裡就是幾項；修改的寫出改了什麼）。接著列「我替你做的決定」：拿掉了哪些角色、沿用了你們哪些既有規範、哪些是我先決定的（無人值守時，剛才盤點推導出的預設全列在這裡，註明「你可以推翻」）。
3. **驗收證據**：靜態檢查十項逐項結果、「開新 session 實際試擋」五項的原始輸出、流程圖完整性檢查與易讀性自檢的腳本輸出（易讀性自檢被跳過時，寫明是因為沒裝 deliver-report，並附安裝指令）。
4. **你已經有的**：
   - 一套開發流程：各角色的分工與順序（列出來）、固定跟著流程走的三條規則、40 條判斷規則（什麼時候該停下來換方法、怎樣才算做完、哪些動作要先問你）、派工範本、記錄踩坑的規則
   - <N> 項會真的擋下來的自動檢查，每項一句講它擋什麼；危險指令檢查逐條列出各自對應的風險。<N> 個 agent 角色（名稱加中文職稱）
   - 沒有裝的自動檢查逐項列出與原因：用不到／你取消的／要另裝某個 plugin／要等專案有了某個工具才用得到
   - 三份知識筆記檔（`CONTEXT.md` 詞彙表、`FLOWS.md` 跨模組流程、`PROJECT.md` 測試知識）的空白範本與收錄原則
5. **你還沒有的**（照實列，不要美化）：
   - **踩坑知識 0 條**——memory 與三份知識筆記檔都是空的（只有示範條目）。成熟的 harness 靠的是數十到上百條「這裡曾經出過什麼事」，那些只能從本專案自己的工作裡長出來。（參考模式且原本就有真實條目時，改寫「沿用原有 N 條」，照實數）
   - **回歸測試 0 支**（init 不寫測試）<若 Phase 1 盤點到既有測試，寫「既有測試 N 支，還沒照這套流程檢視過」>
   - 每個模組測到哪裡的登記、專案專屬的檢查腳本、針對過去事故寫的規則——全部沒有。
   - 目前的規則都是通用版本：裡面的數字與範例還沒被本專案真實發生過的問題校正過。
6. **之後怎麼讓它越用越貼合**：
   - 每次踩坑 → 照 `05-knowledge-protocol.md` 的「踩坑紀錄格式」記進 memory；同一類坑第二次出現 → 照同一檔的「升格協議」提議寫進正式規則，能自動檢查的就一起做成自動檢查
   - 每次 commit（不是 git repo 時改成：每個有改檔的回合結束）→ 會問你四個問題（這次有沒有新名詞、新的跨模組流程、新的測試知識、自創的縮寫），答案記進知識筆記檔
   - 每次改到程式行為 → 補一支可以重跑的自動測試
   - 每 30 天 → 照 `05-knowledge-protocol.md` 的「定期健檢」檢查一次，包括拿每項自動檢查試跑：該擋的有擋、不該擋的有放行
7. **在哪裡開 session 才有效**：自動檢查只在設定所在的那一層目錄開 session 時生效。在子 repo 裡開 session，`CLAUDE.md` 仍會被讀到（上層目錄的也會讀），但 workspace 根的自動檢查不會跑。
8. **盤點發現的專案本身問題**（文件寫的指令其實不存在、沒有測試、敏感檔沒被 `.gitignore` 擋）照實回報，不略過。
9. **原本的設定怎麼處理了**（僅參考模式）：
   - 備份位置與還原方式（「整份原樣在 `.harness-backup/<時間>/`，要還原就把裡面的檔案複製回原位」）
   - Phase 2 處置表的最終版（使用者改過的照改過的寫），每列附「處理後在哪裡」
   - **第 0 題的每個痛點逐一交代**：這次靠哪個東西解決（寫出檔名或自動檢查名）；沒解決的照實說沒解決、為什麼、之後怎麼補。不准只寫「已改善」
   - 原有 `.claude/` 裡沒動的殘檔清單，由使用者決定去留
