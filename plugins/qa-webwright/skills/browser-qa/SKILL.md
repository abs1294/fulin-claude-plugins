---
name: browser-qa
description: >
  瀏覽器功能測試方法論。當要對某功能 / 頁面 / 流程做功能測試時觸發——含「開發完成需驗證新互動 / 新畫面 / 新流程」，
  也含使用者說「執行 / 跑 / 做 一些測試案例」、「幫我測這個功能」、「跑 e2e / 端對端測試」、「回歸測試」、
  「測試落地 / 沉澱測試 / 存測試案例」等意圖（這些都指「設計並執行功能測試、沉澱成可重跑 runner」，不是單純跑一支既有腳本）。
  兩階段：QA Agent 設計測試計畫（含 critical points），主 Agent 先預擬 codify 草稿（grep 原始碼填真實值）、
  首跑收失敗清單、只對失敗 CP 定向探索補值，以結構化證據（API 碼 / DOM 讀回 / 來源 readback）
  自我驗證並輸出測試報告。
---

# Browser QA Skill

> **機械保證的邊界（先讀）**：本 skill 分兩層——
> **產物層**（每個功能在 `tests/e2e/` 留下可重跑的 `test_*.py` + junitxml 報告 + 回填的 catalog）由 `qa-flow.sh` + Stop hook **機械強制**，AI 繞不過。
> **設計品質層**（覆蓋矩陣是否窮盡、證據是否夠強、是否真走兩階段 qa-engineer 設計）**無法機械強制**（品質是 AI-complete）——下面的方法論是**強烈建議的流程**，靠引導不靠閘門。
> 所以：產物一定會有，但「測得好不好」需人把關。別把「hook 全綠」當成「測試設計到位」。

把測試計畫的每條「預期結果」對映成一個 **critical point**，再落成可重跑 runner 裡**（至少）一行 `assert`**（雙向卡控等可多行）。

這條設計的好處：測試**寫一次**（探索階段花一次 agent token），之後直接 `pytest`（或對應 runner）跑——
有 assert 就能自動判 pass/fail、無 agent、不花 token、可掛 CI。

> **方法論中立、載體固定優先 pytest（核心原則）**：本 skill 的價值在「測試設計方法論」（覆蓋矩陣 /
> 可追溯 / CP→assert / 必測 checklist / 測試資料原則）。沉澱載體**固定優先 pytest-playwright**——
> **唯二例外**：(a) 目標專案「既有」測試資產就是別的 runner（如既有 Playwright JS 專案）→ 沿用既有、對齊風格；
> (b) greenfield 且**使用者明確不同意**裝 Python 環境 → 退而用 Playwright JS。除此之外一律 pytest，
> **不得因「載體中立」自行選 JS**（歷史踩雷：主 Agent 看到子目錄有 JS 專案就鑽進去出 JS）。
> 判定一律靠**結構化證據**（API 業務碼、DOM/a11y 讀回、來源 readback），**不靠讀截圖**。截圖至多留檔備查。
>
> **落點鎖死**：測試 / 報告 / catalog 一律落在**你起 session 的那個資料夾**底下（`tests/e2e/`），
> **禁止鑽進子專案目錄**。此規範由 `qa-flow.sh`（鎖 `CLAUDE_PROJECT_DIR`）機械執行，見下方「qa-flow.sh 腳本」。

| Phase | 執行者 | 職責 |
|-------|--------|------|
| Phase 1 | QA Agent（本 plugin 的 `qa-engineer` agent） | 設計測試計畫、定義 critical points 與輸出格式 |
| Phase 2 | 主 Agent | 預擬草稿（每 CP 一行 assert）→ 首跑收失敗清單 → 定向探索補值 → 結構化證據自驗 → 輸出測試報告 |

本 skill 分層維護：
- **方法論** `methodology/` — 怎麼做測試，穩定、不綁技術棧。
- **知識庫** `knowledge/` — 踩過的雷與領域知識，**會長大**、依專案技術棧選用。

---

## 前置（一次性 / 每次）

**一次性（每台開發機）：**
- 沉澱 runner **固定優先 pytest-playwright**（例外見上方核心原則）。**不需自己 mkdir / 判斷落點**——
  Phase 2 第一步一律先跑 `qa-flow.sh bootstrap`，它會盤點既有資產、發安裝決策訊號、鎖定落點。
- 探索方式優先用專案既有手段（Playwright MCP 的 a11y snapshot `ref`、Page Object）。

**選用（僅「真實外部站」備用探索）：**
- 當未來需打**真實外部站**（無法注入 a11y test token、後端不可攔、`ERR_HTTP2_PROTOCOL_ERROR`／Akamai/H2
  封鎖 Chromium、長程未知路徑）時，才裝 **webwright**（`/plugin install webwright@webwright` +
  `playwright install firefox`，用其 SOTA 自主探索）。**探索完一律 codify 成上述 runner，回歸端永遠不是 webwright。**
  （`ERR_HTTP2_PROTOCOL_ERROR`／指紋封鎖的處置見 `knowledge/pitfalls.md` H 段：先換 `playwright.firefox`。）
  本機自家系統（有 a11y、有後端可攔）**不需要**裝 webwright。

**每次測試前：**
- **專案 QA 知識層（約定位置）**：`<CLAUDE_PROJECT_DIR>/tests/Project_Detail/`，入口 `PROJECT.md`。
  入口是**路由中心、分層負責**：只放專案鐵則與路由表，細節（環境啟動、UI 操作規範、領域驗證知識…）
  在同目錄分層檔，照路由**按需讀**、不整包灌。入口存在就**必先讀**（`bootstrap` 會回報 `PROJECT-KNOWLEDGE` 訊號）；
  不存在而專案有專屬 QA 知識時，建議依此分層建立，別把專案知識寫進泛用 skill。
  「必先讀」由機械層執行：`hooks/project-knowledge-gate.js`（PreToolUse）在入口存在而未讀時 deny 瀏覽器呼叫
  （最多兩次、FAIL-OPEN），`qa-early-nudge` 同步軟提醒——先軟後硬。
- 目標專案要能在本機跑起來（啟動方式見該專案的 CLAUDE.md / README；Windows 背景啟動雷見 `knowledge/pitfalls.md` D 段）。

---

## Phase 1：設計測試計畫（QA Agent）

由 `qa-engineer` agent 負責，依 `methodology/test-plan-design.md` 設計，**輸出一律用固定的單一 TC 表**
（每列一條 TC，欄位：TC / 功能情境 / 操作步驟 / 證據 / 預期結果 / 需求；格式詳見 `qa-engineer` agent 的「輸出」段）：

- **內部設計動作（不寫進輸出）**：窮舉覆蓋矩陣（狀態維度）確保每維度有 TC、大型功能做一次紅隊漏測複查補漏——
  補出來的 TC 直接併進表，矩陣與複查過程不另立段落。
- **可追溯**：每條驗收條件 / 需求點對應到表的「需求」欄；不測的另列寫「不測 + 理由」。

**關鍵交接規則**：每條 TC 的每個「預期結果」都要寫成「可由其結構化證據獨立驗證」的形式
—— 這就是 Phase 2 要列成的 critical point 清單、再落成 runner 的 assert。
詳見 `methodology/critical-points.md`。

---

## Phase 2：執行測試（主 Agent）

主 Agent 嚴格按測試計畫執行，不得自行增減步驟。流程是「**預擬 codify 草稿 → 首跑收失敗清單 → 只對失敗 CP 定向探索補值**」（draft-first：探索是補洞手段，不是起手式）。

### 強制步驟追蹤（MANDATORY）

**開始執行前，必須先用 `TaskCreate` 建立以下任務清單。** 不可跳過——這是防「跳掉沉澱 / 沒出報告 / 沒回填 catalog」的機械閘（歷史踩雷：純 prompt 規範被略過，測完只印對話、沒落地任何檔）。

> **鐵則：「把 CP 沉澱成可重跑 pytest runner」是本 skill 的核心目的，永遠必做——禁止問使用者「要不要沉澱 / 要不要出 runner」。**
> 這不是選項。整個 Phase 2 **唯一**可以問使用者的是：greenfield 空目錄時「同不同意在這台電腦裝 pytest-playwright 環境」（因為動到使用者機器裝套件）——
> 那是問「裝環境」，不是問「要不要沉澱」。載體用什麼（pytest / 既有 JS）依 bootstrap 訊號決定，也不是問「要不要做」。
> **別把「裝環境要問」擴大解讀成「整個沉澱流程都可以先問使用者要不要做」。**

初始 8 個任務：

```
#1 Phase2-0 qa-flow.sh bootstrap（盤點資產 + 鎖落點 + 確保 catalog）    [in_progress]
#2 Phase2-0b 僅 greenfield 空目錄：問使用者「是否同意裝 pytest 環境」（不問要不要沉澱）[pending]
#3 Phase2-1 列 critical points 清單                                    [pending]
#4 Phase2-2 預擬 codify 草稿：每 CP 先落 pytest assert（grep 原始碼填真實值，拿不到標 TODO-EXPLORE）[pending]
#5 Phase2-3 qa-flow.sh run（防假綠燈 grep + pytest --junitxml；首跑收失敗清單，修完重跑）[pending]
#6 Phase2-4 定向探索補值：僅對失敗 / TODO-EXPLORE 的 CP 做 MCP 探索修草稿（≤5 CP 一批，修完回 #5）[pending]
#7 Phase2-5 self-verify（逐 CP 對結構化證據 + FAIL 前排除紀律）          [pending]
#8 Phase2-6 輸出報告 + qa-flow.sh catalog 回填每個情境覆蓋狀態          [pending]
```

**執行規則（比照 git-commit skill）：**
- 每個步驟**開始前**用 `TaskUpdate` 標 `in_progress`，**完成的當下那一輪**就標 `completed`，不累積補。
- 任一 CP self-verify 失敗（#7）→ 修測試（需要真實值就走 #6 探索）→ 把 #5 / #6 / #7 reset 回 `pending` 重跑，**不新增 task**。
- 全部 `completed` 後於同一輪清空清單（逐一 `TaskUpdate status=deleted`）。
- **#5、#8 是硬性落地閘**：沒跑 `qa-flow.sh run` 出報告、沒跑 `qa-flow.sh catalog` 回填，**不得宣稱測試完成**。
- **假綠燈紀律（draft-first 的代價）**：#4 預擬的 assert 是推測——**禁止為了轉綠而弱化斷言、寫恆真條件、或把 FAIL 的 CP 改成 skip**；失敗 CP 唯一的修法是 #6 探索取真實值。「修到綠就交」不是完成，self-verify（#7）照樣逐 CP 對證據。

### ⚡ qa-flow.sh 腳本（必用）

本 skill 提供 `qa-flow.sh`（位於本 skill 目錄）把「一定要落地的動作」包成 subcommand，落點一律鎖 `CLAUDE_PROJECT_DIR`（session 起始目錄），主 Agent **不要自己 mkdir / 自己組 pytest 指令 / 自己判斷落點**。

> **落點鐵則**：`CLAUDE_PROJECT_DIR` Claude Code 不一定內建，故**每次呼叫 qa-flow.sh 都要顯式帶 `CLAUDE_PROJECT_DIR=<Primary working directory>`（原封不動、即環境說明裡的 session 起始目錄）**。
> **嚴禁自己 export 成子目錄**（即使判斷子目錄才是被測 repo 也不行）。你知道 Primary working directory 是哪，就用那個。
> 要測某子專案 → 請使用者到該子專案目錄重啟 claude，不要從上層鑽進去（`test-plan-design.md` §0 原則）。
> `qa-flow.sh run` 內建守門員：落點若不在 `CLAUDE_PROJECT_DIR/tests/e2e/` 正下方（鑽了子目錄）會直接報錯擋下。

| 指令 | 動作 | 對應步驟 |
|------|------|---------|
| `qa-flow.sh bootstrap` | 盤點既有測試資產（pytest/JS/空）、確保 catalog.md、發安裝/runner 決策訊號（不擅自安裝）| Phase2-0 |
| `qa-flow.sh scaffold <feature> <pytest\|playwright-js>` | 建 `tests/e2e/` 骨架 + conftest；安裝指令只印出讓使用者跑 | Phase2-0b（使用者同意後）|
| `qa-flow.sh run <feature> <test-file> [date]` | grep 驗證 test 函式存在（防假綠燈）→ `pytest --junitxml` 出報告（date 省略=今天；自動偵測 pytest 執行方式）| Phase2-3（首跑收失敗清單＋每輪修完重跑）|
| `qa-flow.sh catalog <情境> <函式> <狀態> <模組>` | 機械回填 tests/e2e/catalog.md 總表（以函式為主鍵 update/append）| Phase2-6 |

**bootstrap 決策訊號怎麼接：**
- `ASSET: pytest-existing` → 直接復用既有、對齊風格，進 Phase2-1。
- `ASSET: js-existing` + `ACTION-REQUIRED: ask-user-runner` → **問使用者**：在既有 JS 旁另起 pytest，或沿用 JS。
- `ASSET: none` + `ACTION-REQUIRED: ask-user-install` → **問使用者**是否同意裝 pytest-playwright：同意→`scaffold <feature> pytest`；不同意→`scaffold <feature> playwright-js`。

> **腳本不代裝任何東西**：安裝指令一律印出來由使用者執行（依決策：安裝需經同意）。

### 執行步驟

1. **列 critical points**：把測試計畫**每條預期結果**列成一張清單，每個 CP 要能被其結構化證據
   獨立驗證（讀取型一個即可；寫入/送出型需業務碼＋readback；守門/卡控型斷言狀態或錯誤碼——證據強度依 CP 類型，
   見 `methodology/critical-points.md` 證據規範）——不依賴「我記得剛剛點了什麼」。

2. **預擬 codify 草稿（draft-first，不先開瀏覽器）**：直接把每個 critical point 落成 `tests/e2e/test_<feature>.py` 裡
   **（至少）一行 `assert`**（雙向／多面卡控可對多行）——斷言打在結構化證據上（業務碼 `code=="0000"` 非只看 HTTP 200、
   DOM/a11y 讀回 unique token、DB/重查 readback）。寫入型操作必「寫 unique token → 讀回那一筆比對」，不可只驗送出成功。
   selector / 端點 / 欄位名 / 業務碼**先 grep 原始碼取真實值**——多數路徑落差是「程式碼真實值 ≠ 記憶」的問題，
   grep 就能填掉大半；grep 拿不到的（動態 DOM、跨頁流程、登入態相依）在該處標 `TODO-EXPLORE` 註記，別瞎猜。
   斷言規範見 `methodology/critical-points.md`。

3. **Execute 首跑收失敗清單（用 `qa-flow.sh run`）**：跑 `qa-flow.sh run <feature> <test-file>`（date 可省略=今天）——
   它先 grep 驗證 test 函式確實寫入（防假綠燈），再跑 `pytest --junitxml` 出報告到 `tests/e2e/reports/<feature>-<date>.xml`
   （assert 失敗 → 非 0 exit）。**首跑的目的不是全綠**：是把「預擬猜錯 / TODO-EXPLORE」的 CP 變成明確的失敗清單，
   探索預算只花在這份清單上。最終綠燈那次的報告路徑回填報告模板「報告產物」欄；截圖至多留檔備查，不作判定依據。

4. **定向探索補值（只探失敗的）**：僅對失敗與 `TODO-EXPLORE` 的 CP 開 MCP 探索——**先 grep 原始碼再上 DOM**；
   a11y `ref` 比 CSS 文字選擇器精準。（僅「真實外部站、無 a11y、長程未知」才改用 webwright 自主探索，見前置。）
   **Context 經濟（必守，違反會把 session 撐到反覆 compact）**：全頁 snapshot 只在「導航後首次 / 結構變化後」拍，
   驗單一元素或讀值用 `browser_evaluate` / 既有 a11y `ref` 定向讀取；**批次修值**——探索一批 CP（建議 ≤5）
   → 立即回填草稿 → 回步驟 3 重跑，**禁止把全部失敗 CP 在 MCP 逐步跑完才開始回填**。細節與實測教訓見 `knowledge/pitfalls.md` I 段。
   **修草稿只准用探索到的真實值——禁止為了轉綠而弱化斷言或改 skip**（見上方假綠燈紀律）。全綠後進步驟 5。

5. **Self-verify**：逐項走 CP 清單，確認**每個 assert 的結構化證據明確相符**才打勾。
   任一 CP 失敗 → 診斷具體原因 → 修測試 → 重跑重驗。
   **判 FAIL 前先走 `methodology/test-plan-design.md` §7 的「FAIL 前排除紀律」**（服務存活 / 操作沒生效五排除 /
   業務語意三問），別把環境塌 / 探索沒對準 / by-design 卡控誤判成功能 FAIL。

6. **輸出測試報告（格式見下）＋ 回填 catalog**：`qa-flow.sh run` 的防假綠燈 grep 已確認 test 函式存在
   （Write / replace 在並行取消時可能假成功，造成「假登記、假綠燈」——腳本已把關）。
   接著對**每個情境**跑 `qa-flow.sh catalog <白話情境> <測試函式> <完整/部分/未覆蓋> <模組>` 回填 `tests/e2e/catalog.md` 總表
   （必做，見 `methodology/test-plan-design.md` §0.5）——讓 codify 閉環不止於 runner、累積成可查的跨功能應測情境索引。

### 測試哲學（通用，少數鐵則）

- **能走 UI 就走 UI**：模擬使用者操作要點畫面、填表、按鈕，不要繞過前端直接打資料來源
  （例外與細節見 `knowledge/pitfalls.md` A 段）。UI 上跑通才算 PASS。
- 排名語意（最新 / 最便宜 / 評價最高）要用畫面實際的排序/篩選控制，不能用自己對結果的排序。
- 數字 / 日期 / 數量 / 單位是**精確**比對。
- 技術棧專屬的「怎麼驗 / 怎麼點 / 哪裡有雷」一律查 `knowledge/pitfalls.md`，**不要靠記憶猜 UI**。

---

## 測試報告格式

```
## 測試報告
測試範圍：{功能}　測試日期：{YYYY-MM-DD}　報告產物：{runner 報告路徑，如 pytest junitxml / log；若有截圖留檔一併附}

### 結果摘要
| 測試案例總數 | PASS | FAIL |
|---|---|---|
| N | N | N |

### 案例明細
| 編號 | 功能 | 結果 | 證據（assert / API 碼 / readback 值） | 備註 |
|------|------|------|--------------------------------------|------|
| TC-001 | {功能} | PASS/FAIL | submit code=="0000" + DB 讀回 token 相符 | {若 FAIL 說明差異} |

### 發現問題（若有 FAIL）
BUG-{編號}｜嚴重度：Critical/Major/Minor｜對應 TC-{編號}
重現步驟 / 預期 / 實際 / 證據（assert 失敗訊息 / 實際 API 碼 / readback 值）

### 結論
通過 / 需修正後重測（列出 BUG 編號）
```

**每個 PASS/FAIL 都必須引用一行 assert、一個 API 業務碼或一個 readback 值作證據**，不得用「看起來正常」這種模糊判定。截圖至多留檔備查，不作為判定依據。

---

## 文件地圖

- `qa-flow.sh` — 流程輔助腳本（bootstrap / scaffold / run / catalog）；把落地動作鎖進腳本，落點鎖 `CLAUDE_PROJECT_DIR`
- `methodology/test-plan-design.md` — 覆蓋矩陣、可追溯、必測 checklist、TC 格式、測試資料原則
- `methodology/critical-points.md` — TC 預期 → critical point → assert 的對映與證據規範
- `knowledge/pitfalls.md` — 踩過的雷與領域知識（後端驗證、日期時區、壞值、Windows 啟動、元件 portal、state 同步、外部站 TLS/HTTP2 指紋封鎖、長流程 context 經濟；G 段 webwright 操作雷僅在啟用 webwright 備用探索時適用）；**持續 append**（新增分類時同步更新此枚舉）
- 沉澱 runner 的官方文件（pytest-playwright / Playwright Test）— 瀏覽器啟動、locator、斷言、fixture
- （選用，僅外部站備用探索）webwright skill 的 `reference/` — 瀏覽器啟動、aria snapshot、log 格式
