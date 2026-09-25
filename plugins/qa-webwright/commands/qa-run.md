---
description: 依測試計畫執行瀏覽器測試，把每個 critical point 沉澱成可重跑 runner（pytest 等）的一行 assert，輸出測試報告。
argument-hint: <測試計畫，或要測的功能（會先請 qa-engineer 設計）>
---

本命令由 **qa-engineer agent** 執行：主 Agent 收到本命令時，把下方輸入與步驟**整包派給 `qa-engineer` agent**（附環境啟動方式 / 已知 DOM 坑 / allow-list 前提），由它依測試計畫執行瀏覽器測試並沉澱成可重跑的回歸資產；主 Agent 只收報告結論，**不親跑 MCP**。

輸入：

$ARGUMENTS

**派工單照下方範本逐格填寫**（與 `browser-qa` SKILL.md「派工範本（主 Agent 派 qa-engineer 用）」同一份）。專案 `tests/e2e/qa-webwright.json` 有 `dispatch_gate` 段時，
`guard-qa-dispatch` hook 會在派工當下檢查【增量分流】【目標環境】【測試資料來源】【範圍外發現】【開工前對齊】【範圍展開】【欄位級驗證】與「親自執行、不得再轉派」，缺一即 deny 並一次列完缺項——照範本填可一次過閘。

<!-- qa-dispatch-template:begin -->
```text
完成後把測試報告（含「範圍外發現」節）回報給主對話。本任務由你親自執行，不得再轉派給其他 agent。
【任務】<要測的功能／變更範圍；使用者原話照貼>
【開工前必讀】<照 tests/e2e/qa-webwright.json 的 dispatch_gate.required_reading 逐條列路徑；專案有 tests/Project_Detail/PROJECT.md 就列上>
【增量分流】<reuse 或 新TC 擇一寫在最前面>：<reuse 寫要改的既有 test 檔路徑；新TC 寫一句為何既有案例接不住>
【目標環境】<前端網址；後端 API／登入身分來源與預設不同時一併寫>
【測試資料來源】<a、b、c 三選一，寫成「選 X」；a＝走真實業務流程長出來（常態，不論成本）；b＝封閉例外，只限產品外部系統產生、產品端沒有入口的前置（外部簽核回呼／上游推送／外部主檔 mock／目錄服務），理由寫出是哪一類，並附產品端守門或寫入點的「檔名:行號」當證據；c＝依賴既有字典／設定類，附理由；理由與證據寫在同一段，空行之後的內容不算>
【開工前對齊】<對齊結論一句話；或「無分岔：<一句理由>」>
【範圍展開】<1 正向：…；2 反向（退件／拒絕／取消／軟刪／逾時／重送／權限不足，逐條列適用與否，不適用說為什麼）：…；3 狀態序列（做A→做B→撤銷A→存檔→重開）：…；4 共用元件（本次觸及的共用元件與其他使用點是否連帶回歸）：…>
【欄位級驗證】<涉及 N 個欄位；逐欄比對畫面顯示值 ↔ API 回傳 ↔ DB 實值；寫入型逐欄讀回 DB（bool/int 用非預設值、集合驗筆數＋順序）；不驗的欄位逐個列理由>
【範圍外發現】範圍外看到的異常一律列在報告「範圍外發現」節回報，不自行擴大修改、也不當作沒看到。
【執行方式】本任務由你親自執行，不得再轉派。照 browser-qa SKILL.md「執行清單（完成判準）」核對 8 項；每次呼叫 qa-flow.sh 都帶 CLAUDE_PROJECT_DIR=<Primary working directory>。完成後回報主對話。
```
<!-- qa-dispatch-template:end -->

填法與填好的範例見 SKILL.md 同節；`<…>` 換成實際內容、刪掉角括號。被擋下時把 deny 訊息列出的**所有**缺項一次補齊，重發同一個 agent。

**先讀本 plugin `browser-qa` skill 的 `SKILL.md`，並依其「執行清單（完成判準）」核對 8 項再開工（可用任務清單工具追蹤進度）。** 若上面只給了功能描述、還沒有測試計畫，先用 `qa-engineer` agent（或 `/qa-webwright:qa-plan`）產出計畫。

> **鐵則：「把 CP 沉澱成可重跑 pytest runner」是核心目的、永遠必做——禁止問使用者「要不要沉澱 / 要不要出 runner」。**
> 整個流程唯一可問使用者的是：greenfield 空目錄時「同不同意裝 pytest-playwright 環境」（動到使用者機器裝套件才問）。
> 那是問「裝環境」，不是問「要不要做這件事」。

> **落點鐵則（每次跑 qa-flow.sh 都適用）**：`qa-flow.sh` 的落點靠 `CLAUDE_PROJECT_DIR` 決定。Claude Code **不一定內建這個變數**，
> 故你**每次呼叫 qa-flow.sh 都要顯式帶上 `CLAUDE_PROJECT_DIR=<session 起始目錄>`，且該值一律等於環境的 `Primary working directory`（原封不動）**。
> **嚴禁自己把它 export 成某個子目錄**（如 `.../AI Platform/customer-hub`）——即使你判斷子目錄才是「被測 repo」也不行。
> 你知道 Primary working directory 是哪（環境說明裡有寫），就用那個。要測某個子專案 → **請使用者到那個子專案目錄重新啟動 claude**，不要自己鑽進去。
> （歷史踩雷：在 `AI Platform` 啟動，AI 自行 `export CLAUDE_PROJECT_DIR=.../customer-hub`，把測試建進子 repo，違背使用者「測整個 app」的意圖。）

步驟（一律透過 `qa-flow.sh`，落點鎖 session 起始目錄、不鑽子專案目錄）：

1. **bootstrap**：跑 `qa-flow.sh bootstrap` 盤點既有測試資產、看登記模式 `MODE`（three-layer／legacy-catalog）、拿安裝/runner 決策訊號。
   - `ASSET: pytest-existing` → 復用既有、對齊風格，進第 3 步。
   - `ASSET: js-existing` + `ACTION-REQUIRED: ask-user-runner` → **問使用者**：既有 JS 旁另起 pytest，或沿用 JS。
   - `ASSET: none` + `ACTION-REQUIRED: ask-user-install` → **問使用者**是否同意裝 pytest-playwright。
2. **scaffold（使用者同意後）**：`qa-flow.sh scaffold <feature> pytest`（同意）或 `playwright-js`（不同意退而求其次）。
   **腳本固定優先 pytest，不因「載體中立」自行選 JS**；安裝指令由腳本印出、使用者自行執行（腳本不代裝）。
   確認目標專案前後端服務起著（起法見該專案 CLAUDE.md）。
3. **探索/首跑**（路徑未知時）：用專案既有探索方式摸出穩定 selector 與真實值
   （**先 grep 原始碼確認後端真實欄位名 / 端點名，再盲試 DOM**——多數路徑落差是程式碼真實值問題，非導航問題）。
4. **沉澱**：把測試計畫每條 TC 的預期結果落成 `tests/e2e/<feature>/test_<feature>.py`（舊版單一 catalog 專案為 `tests/e2e/test_<feature>.py`）的一個 critical point →**（至少）一行 `assert`**（雙向／多面卡控可對多行，見 critical-points.md CP5）：
   - 斷言打在**結構化證據**上：API 業務碼（如 `code == "0000"`，**非只看 HTTP 200**）、
     DOM/a11y 讀回 unique token、來源（DB / 重查）readback——不靠讀截圖判定。
   - 截圖至多留檔備查，**不作為 pass/fail 判定依據**（省 token、避免漏掉渲染層以外的 bug）。
5. **Execute（用 `qa-flow.sh run`）**：`qa-flow.sh run <feature> <test-file>`（date 可省略=今天）——先 grep 驗證 test 函式確實寫入（防假綠燈），再 `pytest --junitxml` 出報告到 `tests/e2e/reports/<功能>-<日期>.xml`，路徑回填報告模板「報告產物」欄。全 assert 通過 → exit 0；任一失敗 → 非 0，可掛 CI、可重跑、零 agent token。
6. **能走 UI 就走 UI**，禁止直接打後端 API 繞過前端的 validation / payload 組裝 / 按鈕鎖控（即模擬使用者「操作」）。例外（housekeeping 與驗證，非操作）：無 UI 入口的外部 callback；SQL **或 API** 做資料準備 / 驗證 / 清理——含寫入型 CP 必做的「重新 GET readback」（見 pitfalls A 段、critical-points 證據規範）。
7. **逐項走完每個 CP 的 self-verify（無論 PASS/FAIL）後**，輸出 `SKILL.md` 規定格式的測試報告（含 PASS/FAIL 與「發現問題（若有 FAIL）」BUG 區塊）；每個 PASS/FAIL 引用 assert / API 碼 / readback 作證據；任一真實 FAIL 於報告列 BUG 編號並結論「需修正後重測」。
8. **登記情境（必做）**：對每個情境跑 `qa-flow.sh catalog <白話情境> <test_x.py::測試函式> <完整/部分/未覆蓋> <模組資料夾>`——
   三層模式寫進 `tests/e2e/<模組>/COVERAGE.md` 並重生 `CATALOG.md`（舊版專案回填 `tests/e2e/catalog.md`）。
   **codify 完成判準＝drift 0/0/0**：`qa-flow.sh audit` 回 0（孤兒／幽靈／佔位皆 0），pytest 總結區印 `COVERAGE drift clean`。
   **沒登記、或 drift 不為 0，不得宣稱測試完成。**
   寫測試碼時若被 `guard-test-asset-hygiene` hook 擋下（exit 2：新增的硬編／漂移／A/D 類 skip），照訊息修掉再繼續；
   不得用 `--write-baseline` 把本輪新增蓋章成存量。
