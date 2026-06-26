---
name: browser-qa
description: >
  瀏覽器功能測試方法論。當開發完成、需要對「新互動 / 新畫面 / 新流程」做功能驗證時觸發。
  兩階段：QA Agent 設計測試計畫（含 critical points），主 Agent 探索後把每個 critical point
  沉澱成可重跑 runner（pytest 等）的一行 assert，以結構化證據（API 碼 / DOM 讀回 / 來源 readback）
  自我驗證並輸出測試報告。
---

# Browser QA Skill

把測試計畫的每條「預期結果」對映成一個 **critical point**，再落成可重跑 runner 裡**一行 `assert`**。

這條設計的好處：測試**寫一次**（探索階段花一次 agent token），之後直接 `pytest`（或對應 runner）跑——
有 assert 就能自動判 pass/fail、無 agent、不花 token、可掛 CI。

> **載體中立（核心原則）**：本 skill 的價值在「測試設計方法論」（覆蓋矩陣 / 可追溯 / CP→assert /
> 必測 checklist / 測試資料原則），**不綁任何特定執行工具**。沉澱載體用專案既有的 runner
> （pytest-playwright / Playwright Test / 任何帶 `assert` + exit code 者）；判定一律靠**結構化證據**
> （API 業務碼、DOM/a11y 讀回、來源 readback），**不靠讀截圖**。截圖至多留檔備查、不作判定依據。

| Phase | 執行者 | 職責 |
|-------|--------|------|
| Phase 1 | QA Agent（本 plugin 的 `qa-engineer` agent） | 設計測試計畫、定義 critical points 與輸出格式 |
| Phase 2 | 主 Agent | 探索 → 把每個 CP 沉澱成 runner 一行 assert → 結構化證據自驗 → 輸出測試報告 |

本 skill 分層維護：
- **方法論** `methodology/` — 怎麼做測試，穩定、不綁技術棧。
- **知識庫** `knowledge/` — 踩過的雷與領域知識，**會長大**、依專案技術棧選用。

---

## 前置（一次性 / 每次）

**一次性（每台開發機）：**
- 確認專案有可重跑的測試 runner（**首選 pytest-playwright**；或 Playwright Test 等）。
- 探索方式優先用專案既有手段（Playwright MCP 的 a11y snapshot `ref`、Page Object）。

**選用（僅「真實外部站」備用探索）：**
- 當未來需打**真實外部站**（無法注入 a11y test token、後端不可攔、`ERR_HTTP2_PROTOCOL_ERROR`／Akamai/H2
  封鎖 Chromium、長程未知路徑）時，才裝 **webwright**（`/plugin install webwright@webwright` +
  `playwright install firefox`，用其 SOTA 自主探索）。**探索完一律 codify 成上述 runner，回歸端永遠不是 webwright。**
  本機自家系統（有 a11y、有後端可攔）**不需要**裝 webwright。

**每次測試前：**
- 目標專案要能在本機跑起來（啟動方式見該專案的 CLAUDE.md / README；Windows 背景啟動雷見 `knowledge/pitfalls.md` D 段）。

---

## Phase 1：設計測試計畫（QA Agent）

由 `qa-engineer` agent 負責，依 `methodology/test-plan-design.md` 產出：

1. **覆蓋矩陣**（窮舉狀態維度，每格對應 TC）
2. **測試案例**（每步標【證據】+ 預期結果）
3. **需求 ↔ TC 對照表**
4.（大型功能）紅隊漏測複查一次

**關鍵交接規則**：每條 TC 的每個「預期結果」都要寫成「可被單一證據獨立驗證」的形式
—— 這就是 Phase 2 要落進 `plan.md` 的 critical point、再落成腳本一行 assert。
詳見 `methodology/critical-points.md`。

---

## Phase 2：執行測試（主 Agent）

主 Agent 嚴格按測試計畫執行，不得自行增減步驟。流程是「探索路徑 → 沉澱成可重跑 runner」。

1. **列 critical points**：把測試計畫**每條預期結果**列成一張清單，每個 CP 要能被
   **一個結構化證據**（API 業務碼 / DOM 讀回值 / 來源 readback）獨立驗證——不依賴「我記得剛剛點了什麼」。

2. **Explore（路徑未知時）**：摸出穩定 selector 與真實值。**先 grep 原始碼確認後端真實欄位名 / 端點名，
   再盲試 DOM**——多數路徑落差是「程式碼真實值 ≠ 記憶」的問題，不是視覺導航問題；a11y `ref` 比 CSS 文字選擇器精準。
   （僅「真實外部站、無 a11y、長程未知」才改用 webwright 自主探索，見前置。）

3. **沉澱成可重跑 runner**：把每個 critical point 落成 runner（pytest 等）裡**一行 `assert`**——
   斷言打在結構化證據上（業務碼 `code=="0000"` 非只看 HTTP 200、DOM/a11y 讀回 unique token、DB/重查 readback）。
   寫入型操作必「寫 unique token → 讀回那一筆比對」，不可只驗送出成功。斷言規範見 `methodology/critical-points.md`。

4. **Execute**：跑一次（assert 失敗 → 非 0 exit）。截圖至多留檔備查，不作判定依據。

5. **Self-verify**：逐項走 CP 清單，確認**每個 assert 的結構化證據明確相符**才打勾。
   任一 CP 失敗 → 診斷具體原因 → 修測試 → 重跑重驗。
   **判 FAIL 前先走 `methodology/test-plan-design.md` §7 的「FAIL 前排除紀律」**（服務存活 / 操作沒生效五排除 /
   業務語意三問），別把環境塌 / 探索沒對準 / by-design 卡控誤判成功能 FAIL。

6. **輸出測試報告**（格式見下）。沉澱成 runner 後、**宣稱綠燈 / 登記完成前，先 grep 驗證該 test 函式確實寫入存在**
   （Write / replace 在並行取消時可能假成功，造成「假登記、假綠燈」），確認存在再宣稱通過。

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

- `methodology/test-plan-design.md` — 覆蓋矩陣、可追溯、必測 checklist、TC 格式、測試資料原則
- `methodology/critical-points.md` — TC 預期 → critical point → assert 的對映與證據規範
- `knowledge/pitfalls.md` — 踩過的雷與領域知識（後端驗證、日期時區、壞值、Windows 啟動、元件 portal、state 同步；G 段 webwright 操作雷僅在啟用 webwright 備用探索時適用）；**持續 append**
- 沉澱 runner 的官方文件（pytest-playwright / Playwright Test）— 瀏覽器啟動、locator、斷言、fixture
- （選用，僅外部站備用探索）webwright skill 的 `reference/` — 瀏覽器啟動、aria snapshot、log 格式
