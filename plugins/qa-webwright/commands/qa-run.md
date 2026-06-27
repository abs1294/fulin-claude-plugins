---
description: 依測試計畫執行瀏覽器測試，把每個 critical point 沉澱成可重跑 runner（pytest 等）的一行 assert，輸出測試報告。
argument-hint: <測試計畫，或要測的功能（會先請 qa-engineer 設計）>
---

請以**主 Agent** 身分，依測試計畫執行瀏覽器測試並沉澱成可重跑的回歸資產。

輸入：

$ARGUMENTS

步驟：

1. 先讀本 plugin `browser-qa` skill 的 `SKILL.md`。若上面只給了功能描述、還沒有測試計畫，
   先用 `qa-engineer` agent（或 `/qa-webwright:qa-plan`）產出計畫。
2. 確認前置：目標專案前後端服務起著；確認本專案的**沉澱 runner**（pytest-playwright / Playwright Test
   等任何帶 `assert` + exit code 的 runner）與**探索方式**（優先用該專案既有的 a11y snapshot / Page Object；
   僅在「真實外部站、無 a11y、長程未知路徑」才用 webwright 備用探索，見 `SKILL.md` 前置）。
3. **探索/首跑**（路徑未知時）：用專案既有探索方式摸出穩定 selector 與真實值
   （**先 grep 原始碼確認後端真實欄位名 / 端點名，再盲試 DOM**——多數路徑落差是程式碼真實值問題，非導航問題）。
4. **沉澱**：把測試計畫每條 TC 的預期結果落成 runner 的一個 critical point →**（至少）一行 `assert`**（雙向／多面卡控可對多行，見 critical-points.md CP5）：
   - 斷言打在**結構化證據**上：API 業務碼（如 `code == "0000"`，**非只看 HTTP 200**）、
     DOM/a11y 讀回 unique token、來源（DB / 重查）readback——不靠讀截圖判定。
   - 截圖至多留檔備查，**不作為 pass/fail 判定依據**（省 token、避免漏掉渲染層以外的 bug）。
   - 全 assert 通過 → exit 0；任一失敗 → 非 0，可掛 CI、可重跑、零 agent token。
5. **能走 UI 就走 UI**，禁止直接打後端 API 繞過前端（例外：無 UI 入口的外部 callback、SQL 做資料準備/驗證/清理）。
6. 全部 CP 綠燈後，輸出 `SKILL.md` 規定格式的測試報告，每個 PASS/FAIL 引用 assert / API 碼 / readback 作證據。
