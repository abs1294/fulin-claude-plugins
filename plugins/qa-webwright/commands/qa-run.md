---
description: 依測試計畫執行瀏覽器測試，把每個 critical point 沉澱成可重跑 runner（pytest 等）的一行 assert，輸出測試報告。
argument-hint: <測試計畫，或要測的功能（會先請 qa-engineer 設計）>
---

請以**主 Agent** 身分，依測試計畫執行瀏覽器測試並沉澱成可重跑的回歸資產。

輸入：

$ARGUMENTS

**先讀本 plugin `browser-qa` skill 的 `SKILL.md`，並依其「強制步驟追蹤（MANDATORY）」用 `TaskCreate` 建 8 步清單再開工。** 若上面只給了功能描述、還沒有測試計畫，先用 `qa-engineer` agent（或 `/qa-webwright:qa-plan`）產出計畫。

步驟（一律透過 `qa-flow.sh`，落點鎖 session 起始目錄、不鑽子專案目錄）：

1. **bootstrap**：跑 `qa-flow.sh bootstrap` 盤點既有測試資產、確保 catalog.md、拿安裝/runner 決策訊號。
   - `ASSET: pytest-existing` → 復用既有、對齊風格，進第 3 步。
   - `ASSET: js-existing` + `ACTION-REQUIRED: ask-user-runner` → **問使用者**：既有 JS 旁另起 pytest，或沿用 JS。
   - `ASSET: none` + `ACTION-REQUIRED: ask-user-install` → **問使用者**是否同意裝 pytest-playwright。
2. **scaffold（使用者同意後）**：`qa-flow.sh scaffold <feature> pytest`（同意）或 `playwright-js`（不同意退而求其次）。
   **腳本固定優先 pytest，不因「載體中立」自行選 JS**；安裝指令由腳本印出、使用者自行執行（腳本不代裝）。
   確認目標專案前後端服務起著（起法見該專案 CLAUDE.md）。
3. **探索/首跑**（路徑未知時）：用專案既有探索方式摸出穩定 selector 與真實值
   （**先 grep 原始碼確認後端真實欄位名 / 端點名，再盲試 DOM**——多數路徑落差是程式碼真實值問題，非導航問題）。
4. **沉澱**：把測試計畫每條 TC 的預期結果落成 `tests/e2e/test_<feature>.py` 的一個 critical point →**（至少）一行 `assert`**（雙向／多面卡控可對多行，見 critical-points.md CP5）：
   - 斷言打在**結構化證據**上：API 業務碼（如 `code == "0000"`，**非只看 HTTP 200**）、
     DOM/a11y 讀回 unique token、來源（DB / 重查）readback——不靠讀截圖判定。
   - 截圖至多留檔備查，**不作為 pass/fail 判定依據**（省 token、避免漏掉渲染層以外的 bug）。
5. **Execute（用 `qa-flow.sh run`）**：`qa-flow.sh run <feature> <test-file> <date>`——先 grep 驗證 test 函式確實寫入（防假綠燈），再 `pytest --junitxml` 出報告到 `tests/e2e/reports/<功能>-<日期>.xml`，路徑回填報告模板「報告產物」欄。全 assert 通過 → exit 0；任一失敗 → 非 0，可掛 CI、可重跑、零 agent token。
6. **能走 UI 就走 UI**，禁止直接打後端 API 繞過前端的 validation / payload 組裝 / 按鈕鎖控（即模擬使用者「操作」）。例外（housekeeping 與驗證，非操作）：無 UI 入口的外部 callback；SQL **或 API** 做資料準備 / 驗證 / 清理——含寫入型 CP 必做的「重新 GET readback」（見 pitfalls A 段、critical-points 證據規範）。
7. **逐項走完每個 CP 的 self-verify（無論 PASS/FAIL）後**，輸出 `SKILL.md` 規定格式的測試報告（含 PASS/FAIL 與「發現問題（若有 FAIL）」BUG 區塊）；每個 PASS/FAIL 引用 assert / API 碼 / readback 作證據；任一真實 FAIL 於報告列 BUG 編號並結論「需修正後重測」。
8. **回填 catalog（必做）**：對每個情境跑 `qa-flow.sh catalog <白話情境> <測試函式> <完整/部分/未覆蓋> <模組>`，累積進 `tests/e2e/catalog.md` 總表。**沒回填不得宣稱測試完成。**
