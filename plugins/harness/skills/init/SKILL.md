---
name: init
description: 當使用者說 /harness:init、「幫這個專案裝 harness」、「實例化 harness」、「把制度層搬到 X 專案」、「幫這個專案建開發流程」時觸發。把一套開發流程制度（模型調度／停損熔斷／派工模板／知識協議＋agent pipeline＋機械閘 hook＋知識容器＋學習迴路）安裝到一個軟體開發專案。流程＝前置檢查→盤點（含專案用途、業務流程、進度）→攤開核對→訪談（先問環境、進度與專案詞，再問流程設定）→五層生成→靜態驗收（init-verify.js）＋冷啟探針→流程圖與收尾回報；階段順序由 init-flow.js 狀態檔與 Stop hook 把關。不是複製既有專案的檔，是用通用骨架填入目標專案的已查證事實。
---
# harness:init — 開發流程制度安裝器

把 `references/` 的通用骨架與 `../../hooks/templates/` 的 hook 範本，實例化成目標專案的五層制度：文件層、可執行層（hook）、agent 層、知識容器層、settings 層。**引擎（本 plugin）與實例（專案檔）分離**：plugin 更新不會動到任何專案的實例；實例落地後歸該專案自治（紅區流程見實例的 05）。

## 核心原則（動工前先讀 `references/adaptation-guide.md`，本節只是摘要）

1. **開發流程骨幹全帶，事故型條款不帶**：純行為紀律照搬、可參數化的判準挖空填入、agent pipeline 依盤點裁切；綁死特定工作法的條款與單一事故的細則不帶（那些從目標專案自己的 memory 長出來，或由 `/harness:review` 健檢時從該實例的紀錄列進提案，同一件事反覆出錯就提升格）。
2. **規則要有機械閘**：skill 與制度檔寫「必須」是自律，AI 會繞；只有 hook 是他律。所以本 init 產出可執行的 hook，並用冷啟探針實測它真的會擋。
3. **實例化不是複製**：目標專案的事實（build 指令、agent 名單、邊界、危險動作）必須**實地查證後填入**，禁止從別的專案的實例照抄、禁止用猜的。
4. **既有設定分兩種對待**：
   - **既有的 Claude Code 設定（`.claude/`、`CLAUDE.md`，含之前裝過的 harness）是參考來源，不是權威**。使用者會在已經有設定的專案跑 init，代表他覺得原本的流程有問題，想換這套試試。所以不停下、不讓位：先整份備份，再把它當成盤點證據（裡面的指令、邊界、保護動作、agent 分工都是這個專案的事實），逐項決定沿用、併入或取代，並問出原本哪裡不好用（見 Phase 0-2、Phase 1 第 12 項、第 0 題）。
   - **其他工具共用的治理層（AGENTS.md／.agents/／.cursor/ 這類多工具規範）讓位**：harness 只補 Claude Code 特有行為層，開發流程正本讓給它（adaptation-guide §2）。這些檔不只 Claude 在用，改掉會影響別的工具與別的人。
5. **誠實**：init 給的是骨架＋長出資產的路徑，不是一套成熟的 harness。收尾回報必須講清楚「你已經有的」與「你還沒有的」。
6. **先懂這個專案在做什麼，再裝流程**：技術事實（指令、目錄、相依）讀檔可以查證；業務事實（系統給誰用、做什麼、哪個環境是正式、專案詞是什麼意思、現在做到哪）讀檔只能推，**一定要問使用者**。只查技術面就裝，裝出來的規則沒有業務依據，知識筆記是空的，之後每個 agent 都得從可能過時的文件自己拼湊專案理解。只問技術面就裝，曾把測試環境判成正式、詞彙表裝完只有示範條目（事故經過見 `references/rationale.md` §核心原則-1）。所以 Phase 1 第 13 項推專案輪廓、Phase 2 先攤專案概要草稿、Phase 3 先問專案理解三題（U1～U3），答案寫進 CLAUDE.md「專案概要」與 GLOSSARY.md（既有專案沿用 CONTEXT.md）。

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
| 知識容器 | 知識筆記檔：`GLOSSARY.md`（既有專案沿用 `CONTEXT.md`）詞彙表、`FLOWS.md` 跨模組流程、`PROJECT.md` 測試知識 |
| 沉澱閘 | 每次 commit 前會問你四個問題，把這次學到的東西記下來 |
| codify | 寫成可以重跑的自動測試 |
| dry-run | 試跑（不真的執行） |
| `03` B23、`05` §6 這類條號 | 不寫條號；要指路就寫完整檔名加節名（「`05-knowledge-protocol.md` 的『升格協議』一節」） |
| Q2、U1、Phase 2 | 照實際問的順序連號（第一題、第二題…），不用內部代號；提到前面的題目時寫「剛才問環境的那一題」、剛才的盤點結果 |

另外三條：
- **agent 名稱第一次出現附中文職稱**：`backend-architect`（後端架構設計）、`backend-engineer`（後端實作）、`frontend-engineer`（前端實作）、`qa-engineer`（測試）、`code-reviewer`（程式碼審查）。
- **每題都講清楚「選了之後會發生什麼」**，不要只講選項名稱。
- **送出前自掃一次**：拿上表左欄逐詞搜自己的草稿，命中就改寫再送。上表的機械可讀版在 `plain-language-terms.json`（另收了流程圖實際被指出看不懂的詞：派工、欄位、對齊回合、主對話、快照、注回…），流程圖與收尾回報由 Phase 6 的易讀性自檢腳本掃；兩份要同步。


## 流程總覽

```
Phase 0 前置檢查 ─→ Phase 1 盤點（唯讀） ─→ Phase 2 攤開核對 ─→ Phase 3 訪談（Q0 → U1～U3 →〔Q4＋Q10＋Q11 合併一則〕→ Q1、Q2、Q8 → Q3、Q5～Q7 → Q12 → Q9）
                                                                          │
收尾回報 ←─ Phase 6 流程圖 ←─ Phase 5 驗收（init-verify.js＋語意項＋冷啟探針） ←─ Phase 4 生成（五層＋學習迴路）
```

**每個專案都要先弄懂它在做什麼**：Phase 1 第 13 項從文件與程式碼推專案輪廓（用途、串接的外部系統、業務流程、進度、候選專案詞、文件哪裡過時）→ Phase 2 把它寫成專案概要草稿放在核對表最前面 → Phase 3 先問 U1 環境、U2 進度、U3 專案詞，再問流程設定 → Phase 4 寫進 CLAUDE.md「專案概要」、GLOSSARY.md（既有專案沿用 CONTEXT.md）詞條、PROJECT.md 環境。

**已經有 Claude Code 設定的專案**（Phase 0-2 判定）多走五步：Phase 0 先整份備份 → Phase 1 第 12 項盤點原有設定（含用語意挑出原有規矩裡的經驗） → Phase 2 攤出「原有設定怎麼處理」對照表與經驗清單 → Phase 3 第 0 題問原本哪裡不好用 → Q8 問不會被帶到的經驗要升格哪幾條 → Phase 5 另派 subagent 審查經驗有沒有帶走。規則文件與自動檢查一律照這一版 harness 重新產生；收尾回報多一段交代原有設定的去向、經驗的去向、痛點有沒有解。

任一 Phase 未完成不得進下一個。Phase 5 任一項失敗、Phase 6 完整性檢查沒過，都＝init 未完成。

## 硬規則（每個 Phase 都適用）

1. **進入每個 Phase 先讀完它的細節檔**（下表「進入本階段先讀」那一欄，路徑相對本檔）。每份細節檔都在 Read 單次上限內，一次讀完；沒讀完不准動手。下方各 Phase 的摘要只是導覽，不能代替細節檔。
2. **階段由狀態檔把關，不靠自律**：Phase 0 拍完快照立刻跑 `node <本 plugin>/skills/init/scripts/init-flow.js start <目標>`（無人值守加 `--headless`；Phase 0-2 判定參考模式後跑 `init-flow.js mode <目標> reference`）；每進入下一個 Phase 先跑 `init-flow.js advance <目標> <N>`——腳本會檢查前一個 Phase 的出關條件，**exit 非 0 就是沒過，照它列的缺項補完再跑**，不准跳過。Phase 6 收尾跑 `init-flow.js done <目標>`。使用者要中止就跑 `init-flow.js abort <目標> --reason "<理由>"`。`init-flow.js status <目標>` 隨時看到哪一步、缺什麼。
3. **init 進行中不准宣稱完成**：本 plugin 的 Stop hook（`hooks/init-stop-gate.js`）在狀態檔還沒 `done`／`aborted` 時，會擋下「安裝完成」「裝好了」這類收尾宣稱；訪談中一般的回合結束不受影響。被擋就跑 `init-flow.js status` 看缺什麼。
4. **訪談答案每答一題就寫檔**：`node <本 plugin>/skills/init/scripts/init-flow.js answer <目標> <題號> --file <答案 JSON 檔>`（或從 stdin 用 `--json -`；PowerShell 傳 `--json '<字串>'` 會被剝掉雙引號），寫進 `<落點>/.claude/harness/init-answers.json`（格式見 `references/init-answers.schema.json`；Q4 答完前落點＝目標）。Phase 4 生成、Phase 5 的 `init-verify.js`、日後重裝都從這份讀，不從對話記憶讀。
5. **Phase 5 先跑腳本**：`node <本 plugin>/skills/init/scripts/init-verify.js <落點>`，原始輸出貼進收尾回報；腳本做不到的語意項才由你做（清單在 `phase-5-verify.md`）。
6. **無人值守（headless）**：照各 Phase 細節檔寫的「無人值守時」做法繼續，不停下來等回答；所有代決值在收尾回報列為「已代決」，`init-answers.json` 該題標 `delegated: true`。

## 階段清單

| Phase | 做什麼 | 進入本階段先讀 | 出關（`init-flow.js advance` 檢查的） |
|---|---|---|---|
| 0 前置檢查 | 版本比對、拍快照、五項前置檢查（git、既有設定、Codex、Playwright、git-commit） | `references/phases/phase-0-precheck.md` | 快照存在 |
| 1 盤點 | 十三項盤點（唯讀），含專案輪廓與參考模式的原有設定 | `references/phases/phase-1-inventory.md` | — |
| 2 攤開核對 | 一則訊息攤出專案概要草稿與盤點表，讓使用者糾正事實 | `references/phases/phase-2-review.md` | — |
| 3 訪談 | 一次一題（只有 Q4／Q10／Q11 合併一則）；每答一題寫 `init-answers.json` | `references/phases/phase-3-interview.md`，問每一題前讀 `references/phases/questions/how-to-ask.md` | 必答題都有答案或跳過理由、答案檔通過 schema |
| 4 生成 | 五層＋學習迴路：文件、hook、agent、知識筆記、settings | `references/phases/phase-4-generate.md`（文件層、agent 層、知識容器層）與 `references/phases/phase-4-hooks.md`（可執行層、settings 層） | 落點有 CLAUDE.md 與 `.claude/harness/` |
| 5 驗收 | `init-verify.js`＋語意項＋冷啟探針 | `references/phases/phase-5-verify.md` | `init-verify.js` exit 0 |
| 6 流程圖與收尾 | 三張流程圖、完整性檢查、易讀性自檢、收尾回報 | `references/phases/phase-6-flow.md` | init-verify 重跑通過、完整性檢查 exit 0、`install-report.md` 存在（`init-flow.js done`） |

## Phase 0 — 前置檢查

進入本階段先讀 `references/phases/phase-0-precheck.md`。先比對 harness 版本（落後就停下問）、拍快照（動任何檔之前）、立刻 `init-flow.js start`，再跑五項檢查；Codex、git-commit 沒裝時問使用者要不要裝，等他回答。參考模式在這一步整份備份既有設定。

## Phase 1 — 盤點（唯讀）

進入本階段先讀 `references/phases/phase-1-inventory.md`。十三項全部實地查完（不信 README），超過 3 檔的探索派 `Explore`；第 13 項專案輪廓每個專案都查，全部是推論、每句附出處。

## Phase 2 — 攤開核對

進入本階段先讀 `references/phases/phase-2-review.md`。一則訊息：專案概要草稿放最前面，接盤點表與自動推導的預設；最後一句固定請使用者指出錯誤。

## Phase 3 — 訪談

進入本階段先讀 `references/phases/phase-3-interview.md`，每一題問之前讀 `references/phases/questions/how-to-ask.md` 那一題的講法。一次一題，只有 Q4、Q10、Q11 合成一則（理由在細節檔）；每答一題跑 `init-flow.js answer` 寫檔。重裝時舊的 `init-answers.json` 是每題的預設答案。

## Phase 4 — 生成（五層）

進入本階段先讀 `references/phases/phase-4-generate.md` 與 `references/phases/phase-4-hooks.md`。從 `init-answers.json` 讀答案生成；所有 `{{...}}` 填掉或整段刪除；hook 由形狀目錄（`references/hook-catalog.md`）推導，學習迴路是必裝類；每支 hook 的 cases 跟著填空區改，`probe-hooks.js` 全綠才往下。

## Phase 5 — 驗收

進入本階段先讀 `references/phases/phase-5-verify.md`。先跑 `init-verify.js`，再做腳本做不到的語意項，最後在新 session 跑冷啟探針（含學習迴路探針）；任一項失敗＝init 未完成，回 Phase 4 修完整組重跑。

## Phase 6 — 流程圖與收尾回報

進入本階段先讀 `references/phases/phase-6-flow.md`。三張流程圖畫出 init 動過的每個檔案、每個節點都有線；完整性檢查與易讀性自檢都過了，寫 `install-report.md`、跑 `init-flow.js done`，才可以對使用者說裝好了。

## 參考檔

- `references/adaptation-guide.md`：骨架怎麼改寫成實例（動工前讀）
- `references/hook-catalog.md`：hook 形狀目錄（可執行層的正本；實際列數以它的目錄表為準）
- `references/init-answers.schema.json`：訪談答案檔格式
- `references/rationale.md`：各條規則的理由與事故經過（改規則前讀；執行 init 時不必讀）
- `scripts/init-flow.js`、`scripts/init-verify.js`、`scripts/check-version.js`、`scripts/check-flow-diagram.js`、`scripts/flow-page.js`、`scripts/readability-check.js`
