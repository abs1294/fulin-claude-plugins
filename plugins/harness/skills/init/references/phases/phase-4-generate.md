## Phase 4 — 生成（五層）

以骨架為底逐檔生成。所有 `{{...}}` 必須填掉或整段刪除（該段不適用時）；**不確定的事實回 Phase 1 查證，不得留猜測**。落點中的 `<落點>` 依 Q4：單人＝workspace 根、團隊＝repo 根。

**答案一律從 `<落點>/.claude/harness/init-answers.json` 讀**（Phase 3 每答一題寫進去的那一份），不憑對話記憶：本 Phase 下面每一處「Q1 的答案」「U3 確認的詞」「Q4 決定」都是指答案檔裡那一題的 `answer` 與 `data`。答案檔跟對話裡講的不一樣時，先跟使用者確認哪個對，再用 `init-flow.js answer` 改答案檔，不要直接改檔（plugin 的 `init-state-guard.js` 會擋 Write／Edit 直接改）。

**團隊模式（Q4 選團隊）的 `.gitignore`**：加兩行 `.claude/harness/learning/`（學習迴路的個人反思紀錄）與 `.claude/harness/.init-state.json`（init 的過程檔，被 commit 出去會讓隊友 clone 下來被 Stop 閘誤擋）；`init-answers.json` 照常進版控（重裝時是全隊共用的預設答案，裡面沒有帳密）。

**生成完**（五層都寫好、`probe-hooks.js` 全綠）跑 `init-flow.js advance <目標> 5`：腳本會檢查 CLAUDE.md 在、這次真的寫過 `.claude/harness/CHANGELOG.md`（參考模式下舊檔一直都在，所以看修改時間）、答案檔有形狀目錄逐列去向（`hookCatalog`，見 `phase-4-hooks.md`）。

**詞彙表檔名只寫一個（所有骨架共用：文件層、選裝 skill、agent 層、知識容器層都適用）**：骨架是新建專案與沿用舊檔名的專案共用的來源，詞彙表寫成雙檔名，例如「`GLOSSARY.md`（專案用語；沒有就讀 `CONTEXT.md`）」「`GLOSSARY.md`（舊專案沿用 `CONTEXT.md`）」「`GLOSSARY.md`（沒有就讀 `CONTEXT.md`）」、03 A8 的 `{{詞彙表檔名…}}`。產出任何檔時，凡是同時寫到兩個檔名的地方，一律換成本專案實際的詞彙表檔名、只留一個；括號裡講另一個檔名的說明一併拿掉（例：「`GLOSSARY.md`（專案用語；沒有就讀 `CONTEXT.md`）」→「`GLOSSARY.md`（專案用語）」；05 健檢清單那條 `grep -n "^## Changelog"` 指令只列實際那一個，「詞彙表 GLOSSARY.md／CONTEXT.md 通常只有一個、另一個報找不到檔」那半句刪掉）。
- **實際檔名怎麼判**：`<落點>` 已有 `CONTEXT.md` 就沿用 `CONTEXT.md`，否則用 `GLOSSARY.md`——跟下面知識容器層 `skeleton-CONTEXT.md` 那一列的落點同一個判準，兩處判出來必須是同一個檔名。
- **變更紀錄檔名跟著詞彙表走**：`GLOSSARY.md` 配 `GLOSSARY.changelog.md`，`CONTEXT.md` 配 `CONTEXT.changelog.md`；骨架寫成雙檔名的變更紀錄（例：「`GLOSSARY.changelog.md`（沿用舊檔名時 `CONTEXT.changelog.md`）」）同樣只留一個。
- **例外**：hook 程式碼（`.claude/hooks/` 底下的 `.js` 與 `cases/`）裡的執行時判斷照原樣保留兩個都認，不換——例如 `check-review-discipline.js` 必讀檢查的 `pattern`、`guard-sediment-sweep.js` 的 `resolveGlossaryPath`、`compact-snapshot.js` 的 `DOC_RE`。程式在執行時才判斷，不會在規則檔留下另一個檔名；派工單只寫實際那一個，必讀檢查照樣放行。
- **代價**：專案日後把詞彙表改名（例：`CONTEXT.md` 改成 `GLOSSARY.md`）時，這些產出檔裡的檔名要同步改：`CLAUDE.md`、`.claude/harness/README.md`、`.claude/harness/03-judgment-matrix.md`、`.claude/harness/04-delegation-templates.md`、`.claude/harness/05-knowledge-protocol.md`、`.claude/agents/backend-architect.md`、`.claude/agents/backend-engineer.md`、`.claude/agents/frontend-engineer.md`、`.claude/agents/qa-engineer.md`、`.claude/agents/code-reviewer.md`、`tests/Project_Detail/PROJECT.md`、`.claude/skills/workflow-map/SKILL.md`（有建才有）、`.claude/harness/flow-2.json`（流程圖二的節點名；改完重產 `flow-2.html` 與 `flow.html`；沒有 archify 時是 `.claude/harness/flow.md`），以及詞彙表本檔（內文寫了變更紀錄檔名）與它的變更紀錄檔（跟著改名，標題與內文的檔名也改）；CLAUDE.md 有 `@` 匯入時那一行也要改。漏改的檔會指向不存在的詞彙表，讀那份檔的 agent 會略過詞彙表、照自己的理解解讀專案詞。

### 文件層（6 份 md＋2 份變更紀錄；Q11 選「建」時多 1 份註解規範；Q7 有規則檔選精煉時多 1 份自有正本；Q5 保留本機覆寫保護時多 1 份本機覆寫說明）

**變更紀錄一律不寫在指令檔本體**（0.10.0 起）：CLAUDE.md 與 harness 各檔每次載入都整份進 context，紀錄放在檔裡只會越長越胖。harness 目錄的檔記在 `.claude/harness/CHANGELOG.md`、依檔名分節（`## 05-knowledge-protocol.md`）；CLAUDE.md 記在同目錄的 `CLAUDE.changelog.md`；agent 檔與知識容器見各自那一層的表。每份實際建立的檔都要在它的紀錄檔留一行「建立（harness plugin /harness:init 實例化）」——`/harness:review` 的收集腳本用這行判安裝日、略過 init 那一筆。

| 來源（`references/`） | 落點 | 填空重點 |
|------|------|----------|
| `skeleton-CLAUDE-md.md` | `<落點>/CLAUDE.md` | 專案概要（Phase 2 草稿經使用者改過的版本＋U1 環境表＋U2 進度，附確認日期；環境表「方向」欄照 U1 答案寫出向／入向，裝了本機覆寫保護時加「本機」欄，每格附正本出處；位址只寫主機與路徑，帳密一律寫「取自 <環境變數或設定鍵名稱>」，連線字串裡帶帳密的要拆掉）、workspace 對照、治理分層、絕對邊界（含 Q2 熔斷清單、敏感物）、pipeline 圖（Q1）、路由表（含容器、agents、hooks、Q7 必讀；有產生時加本機覆寫說明、`review-rules.md`、專案 skill 那幾列）；Q10 選匯入時加 `@<實際檔名>`（`@GLOSSARY.md`，沿用舊檔名時 `@CONTEXT.md`）那一行並改路由表那一列（寫法見 Q10 那一列）；詞彙表檔名換成實際檔名（見本 Phase 開頭的通用規則） |
| `skeleton-CLAUDE.changelog.md` | `<落點>/CLAUDE.changelog.md`（與 CLAUDE.md 同目錄） | 建立日。CLAUDE.md 本體不留 changelog 節 |
| `skeleton-harness-CHANGELOG.md` | `<落點>/.claude/harness/CHANGELOG.md` | 每份實際建立的 harness 檔一節（`## <檔名>`），各記一行「建立」；沒建的檔不留節（07 那一節：Q11 選「建」照常留；選「沿用」也留，改填既有文件的路徑，寫法見 Q11 那一列；只有選「不建」才刪）。**`## 05-knowledge-protocol.md` 這個節標題一個字都不能改**——健檢到期提醒（`health-check-reminder.js`）與 `/harness:review` 只從這一節找【健檢執行】紀錄 |
| `skeleton-harness-README.md` | `<落點>/.claude/harness/README.md` | 五層清單、生效範圍限制照實寫、誠實揭露；詞彙表與它的變更紀錄檔名換成實際檔名（見本 Phase 開頭的通用規則） |
| `skeleton-02-model-dispatch.md` | `<落點>/.claude/harness/02-model-dispatch.md` | agent 對照表（Q1 裁切後）、MCP 紀律（依前端分類保留或改寫）、hook 強制句（Q5） |
| `skeleton-03-judgment-matrix.md` | `<落點>/.claude/harness/03-judgment-matrix.md` | 驗證指令（Phase 1 第 2 項）、B 系列參數（測試目錄、QA agent、工具）、A9 與 B5 的覆寫清單位置與檢查指令（Phase 1 第 11 項；有多工作樹時 A9 加填「開新工作樹時帶齊覆寫」，裝了起服務時的工作樹覆寫提醒再加它那一句，裝了工作樹的 port 驗證（第 30 列）再加指向它的那一句——**這一句不受本機覆寫有無影響**：沒有本機覆寫但裝了第 30 列時，A9 不改寫成「本專案不適用」，改成「本專案沒有本機覆寫檔」＋port 驗證那一句（照骨架 A9 的條件填空）；沒有產生本機覆寫說明時（Q5 取消了本機覆寫保護）刪掉 A9 指向 `local-overrides-guide.md` 那一句；沒有本機覆寫時 A9 改寫為不適用（裝了第 30 列時例外，見上））、C2 熔斷清單（Q2）；矩陣 D（Q8 選的經驗，一條一列附出處；Q8 沒問或都不要時整節刪除）；**不適用條款保留編號改寫為「本專案不適用：<理由>」，不刪列**；A8 的 `{{詞彙表檔名…}}` 填實際檔名（見本 Phase 開頭的通用規則） |
| `skeleton-04-delegation-templates.md` | `<落點>/.claude/harness/04-delegation-templates.md` | 必讀清單（Q7；過時文件加「（過時：…，以程式碼為準）」）、模板五 pipeline（Q1；有既有治理層走 (A) 讓位版）、模板六參數、Q6 豁免行；詞彙表檔名換成實際檔名（見本 Phase 開頭的通用規則；必讀清單與各模板【開工前必讀】每一處都換） |
| `skeleton-05-knowledge-protocol.md` | `<落點>/.claude/harness/05-knowledge-protocol.md` | 紅區清單（含既有治理層檔案、Q4 紅區語義）、健檢清單列出實際裝的 hook 與其 dry-run 輸入、§5.1 稽核工具表（Phase 1 第 2 項記下的掃描／稽核腳本與會說謊的東西；一支都沒有就寫「目前沒有」）；有裝 cbm-guard plugin 時保留「會說謊的東西」那一項的 cbm 新鮮度指令；參考模式原本健檢清單裡專案專屬的項目（跑某支掃描、看某個指標），照「原有設定的預設處置」搬進新清單，使用者要求「健檢時提醒我看」的項目標【使用者親自看】；詞彙表與它的變更紀錄檔名換成實際檔名（見本 Phase 開頭的通用規則；含健檢清單的 `grep -n "^## Changelog"` 指令） |
| `skeleton-comment-guide.md`（僅 Q11 選「建」） | `<落點>/.claude/harness/07-comment-guide.md` | 適用範圍（Phase 1 第 1、3 項的語言與 repo）；第三節「編譯器或 linter 要求一定要寫 doc 註解時」的設定表照 Phase 1 第 6 項②盤點到的設定逐列填（檔:行、管哪些成員、本專案語言的局部關閉寫法；使用者同意過的整專案關閉也寫在這一欄），一個都沒有時保留設定表表頭（空表）、刪範例列，表下加一行「目前沒有強制寫 doc 註解的編譯器或 linter 設定；之後出現時補進本表」，「改完怎麼確認」那一行刪掉；第三節標題、說明、三種做法與表頭保留（N1、N6 與審查 agent 引用這一節，整專案關閉要記進這張表）；第四節真人範本只寫 Q11 使用者確認過的，一個都沒有時保留節標題與最後「共同特徵」那一段（第一節引用「第四節」），只把引言與範例列換成一行「尚未收錄；審查時看到好例子就補進來（黃區）」；第五節指紋樣式只留本專案用得到的語言，每條在本專案實跑過一次（命中數不寫進檔）；git-commit 沒裝就刪掉 N9 機械閘那一段 |
| `skeleton-refined-rules.md`（僅 Q7 有規則檔選「精煉成自有正本」） | `<落點>/.claude/harness/review-rules.md` | 原檔路徑與精煉當下的版本（commit 或修改日期）；規則依適用範圍分節，節標題的 glob 與 code-reviewer「改到哪類檔就照哪份規則審」表一致，每條附出處；已知矛盾表只寫 Q7 使用者確認過或程式碼查證過的（Phase 1 第 6 項記的對不上的地方），一列都沒有時照骨架留表頭與那一行說明 |

### 選裝 skill 與本機覆寫說明（文件層的一部分）

骨架在 `references/skills/` 與 `references/skeleton-local-overrides-guide.md`。每支 skill 照 `05-knowledge-protocol.md` §4.1 的寫法：description 同時寫何時觸發與何時不觸發、skill 自己的狀態檔住在 skill 目錄、高成本的要使用者明說才啟動、變更紀錄在同目錄 `CHANGELOG.md`（`SKILL.md` 最後一行指向它）。

| 來源 | 落點 | 何時產生 | 填空重點 |
|------|------|----------|----------|
| `skeleton-local-overrides-guide.md` | `<落點>/.claude/harness/local-overrides-guide.md`（不放 `.claude/` 根層：根層只放 Claude Code 與 git-commit 規定的設定檔，整潔檢查會擋） | Q5 保留了本機覆寫保護 | 表格一筆覆寫一列（一個檔改了好幾個鍵時一鍵一列）：檔、鍵、本機正確值、漏補的症狀、類型（環境變數切換／手改常數），照 Phase 1 第 11 項記的內容填；**帳密、權杖不寫值**，寫「取自 <環境變數或設定鍵名稱>」；症狀查不到寫「待補」，不准編。第 1 節的自檢指令要實跑過。產生後把 `check-local-hacks-alive.js`（有裝第 19 列時連同 `remind-worktree-overrides.js`）的 `SETUP_DOC` 填成這個路徑；harness README 與 CHANGELOG 加這一列／節 |
| `skills/skeleton-skill-local-env-symptoms.md` | `<落點>/.claude/skills/local-env-symptoms/SKILL.md` | 同上（跟說明一起，不另外問） | description 的症狀字樣加本專案實際出現過的（覆寫清單的 reason 欄、專案紀錄）；本檔不放任何值 |
| `skills/skeleton-skill-bug-hunt.md` | `<落點>/.claude/skills/bug-hunt/SKILL.md` | Q12 選① | 「本專案迴路配方」每類一行、照 Phase 1 第 2、5、10 項實際的指令填、每條實跑過一次；沒有的類別刪掉 |
| `skills/skeleton-skill-structure-upkeep.md` | `<落點>/.claude/skills/structure-upkeep/SKILL.md` | Q12 選③ | repo 清單、候選類型（附規範條目）、不准質疑的結構；排除清單 `exclusions.md` **不建**（第一次收尾時由 skill 自己建） |
| `skills/skeleton-skill-workflow-map.md` | `<落點>/.claude/skills/workflow-map/SKILL.md` | Q12 選② | 「匝道」列出這次建的每支 skill（本 skill 自己不列）與專案原有的 `.claude/commands/`、`.claude/skills/`；「已停用」列參考模式被取代的原有指令或 skill；05 §4.1 第 5 條與 §5 的地圖檢查那一項保留；詞彙表檔名換成實際檔名（見本 Phase 開頭的通用規則） |
| `skills/skeleton-skill-CHANGELOG.md` | 上面每支 skill 的同目錄 `CHANGELOG.md` | 每產生一支 skill 就放一份 | 標題填 skill 名、建立日 |

skill 名稱可以依專案慣例改；改了就同步工作流地圖、CHANGELOG 標題與 harness README 那一列。參考模式原本就有同名的 skill 時不覆蓋：照「原有設定的預設處置」的 `commands/`、`skills/` 那一列沿用原檔，選裝的那支換一個名字或不建，在 Phase 2 核對表講明。

### agent 層（5 份＋變更紀錄）

| 來源（`references/agents/`） | 落點 | 填空重點 |
|------|------|----------|
| `skeleton-agents-CHANGELOG.md` | `<落點>/.claude/agents/CHANGELOG.md` | 每支實際建立的 agent 一節（`## <檔名>`），各記一行「建立」；Q1 裁掉的角色不留節。agent 檔本體不留 changelog 節（每次派工整份載入） |
| `skeleton-agent-backend-architect.md` | `<落點>/.claude/agents/backend-architect.md` | 專案名、分層方向、必讀清單；Q1 裁掉則不建；詞彙表檔名換成實際檔名（見本 Phase 開頭的通用規則） |
| `skeleton-agent-backend-engineer.md` | `<落點>/.claude/agents/backend-engineer.md` | 技術棧、硬性規則（引用規範檔條目標題＋路徑，不複製內文）、build 指令；併步裁切時改寫前置條件；詞彙表檔名換成實際檔名（見本 Phase 開頭的通用規則） |
| `skeleton-agent-frontend-engineer.md` | `<落點>/.claude/agents/frontend-engineer.md` | 技術棧、規範、i18n；無前端不建；詞彙表檔名換成實際檔名（見本 Phase 開頭的通用規則） |
| `skeleton-agent-qa-engineer.md` | `<落點>/.claude/agents/qa-engineer.md` | 依前端分類保留 (A)／(B)／(C) 其一；測試目錄與指令；詞彙表檔名換成實際檔名（見本 Phase 開頭的通用規則） |
| `skeleton-agent-code-reviewer.md` | `<落點>/.claude/agents/code-reviewer.md` | 規範來源、靜態掃描工具；**VERDICT 輸出格式不得改**（git-commit C 軌依賴它）；詞彙表檔名換成實際檔名（見本 Phase 開頭的通用規則） |

參考模式照 Phase 2 定案的處置表做：「併入」的用骨架建、把原 agent 的專案專屬內容搬進硬性規則（每條註明出自原檔哪一節）；「沿用」的原檔不動。AGENTS.md 這類多工具治理層已定義角色時不建同名檔，只把 harness 需要的段落（交接契約、回報格式）以建議形式列在收尾回報，由使用者決定要不要合併。

### 知識容器層（3 份＋各自的變更紀錄）

| 來源（`references/containers/`） | 落點 | 填空重點 |
|------|------|----------|
| `skeleton-CONTEXT.md` | `<落點>/GLOSSARY.md`（既有專案沿用 `CONTEXT.md`） | 專案名；**U3 使用者確認過的詞逐條寫成詞條**（照格式，≤2 句、只講是什麼），寫了真詞條就刪示範；沒確認的詞不寫——不替使用者編詞條。本體不留 changelog 節；內文提到的變更紀錄檔名換成實際那一個（見本 Phase 開頭的通用規則） |
| `skeleton-CONTEXT.changelog.md` | `<落點>/GLOSSARY.changelog.md`（沿用舊名時用 `CONTEXT.changelog.md`；與詞彙表同目錄） | 「建立」那一行照實際情況寫「init 時與使用者確認 N 條」／「沿用原有 M 條」／「示範詞條待第一個真詞條寫入時刪除」（可合併）；標題與內文的詞彙表檔名換成實際檔名（見本 Phase 開頭的通用規則） |
| `skeleton-FLOWS.md` | `<落點>/FLOWS.md` | 模組單位（repo／服務／模組）；**不憑盤點畫鏈路**，只留示範。業務流程不放這裡（本檔只收踩過坑的跨模組鏈路），放 CLAUDE.md 專案概要。本體不留 changelog 節 |
| `skeleton-FLOWS.changelog.md` | `<落點>/FLOWS.changelog.md` | 建立日 |
| `skeleton-PROJECT.md` | `<落點>/tests/Project_Detail/PROJECT.md` | 「環境與執行」節填 Phase 1 查證事實＋U1 確認的測試環境位址（位址可寫，帳密一律寫「取自 <環境變數或設定鍵名稱>」）；其餘三節只留示範；詞彙表檔名換成實際檔名（見本 Phase 開頭的通用規則） |
| `skeleton-Project_Detail-CHANGELOG.md` | `<落點>/tests/Project_Detail/CHANGELOG.md` | `## PROJECT.md` 一節，記「建立」；該目錄之後拆出子檔時每個子檔各加一節 |

參考模式（含從 0.9.x 以前的 harness 實例升級）：原檔本體有 `## Changelog` 節的，整節搬進對應的變更紀錄檔，落點照 05 §4 與上面 Phase 4 各表（`.claude/harness/` 的 02～05 → `.claude/harness/CHANGELOG.md` 該檔那一節；`CLAUDE.md` → `CLAUDE.changelog.md`；`.claude/agents/*.md` → `.claude/agents/CHANGELOG.md` 該檔那一節；`GLOSSARY.md`（既有專案沿用 `CONTEXT.md`）、`FLOWS.md` → `<檔名>.changelog.md`；`tests/Project_Detail/PROJECT.md` → 同目錄 `CHANGELOG.md` 的 `## PROJECT.md` 節），**一行都不能少、照原順序**，本體不留；05 舊 changelog 裡的【健檢執行】紀錄也一起搬進 `## 05-knowledge-protocol.md` 節，健檢提醒才接得上上次的日期。原本的知識筆記檔有真實條目（不是示範）時，**條目搬進新結構，一條都不能少**，示範條目才刪；唯一會改動原條目的是 U3 裁決過的衝突詞（照裁決改寫，或使用者說不用了就刪除）。寫完用 `grep -c` 各自的條目標記對帳：新檔條目數＝原有條目數＋U3 新增數－U3 裁決刪除數（`GLOSSARY.md`／`CONTEXT.md` 這份詞彙表以外的檔新增與刪除都是 0），對不上就是漏搬或多寫。
