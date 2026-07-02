# qa-webwright

**讓 Claude 幫你測網頁功能，而且每次都能重跑、看的是真證據不是截圖——測完留下一支可重複執行的測試，下次改壞了馬上抓得到。**

要 AI 測網頁，常見的痛是：它跑一遍「看起來沒問題」就說過了，但你無法重跑、也不知道它到底驗了什麼；日期、時區、下拉選單這種細節最容易漏。qa-webwright 把一套成熟的 QA 方法論裝進 Claude Code，讓它**先設計測試計畫、再實際操作網頁驗證、最後把每個關鍵檢查點變成一支可重跑的自動化測試**——驗的是後端回傳的業務碼、頁面真正讀回的值，不是截圖看圖說故事。

## 能幫我做什麼

- **不只測一次**：測完沉澱成可重跑的測試腳本（**固定優先 pytest-playwright**），之後回歸隨時重跑。
- **一定會落地檔案**：`qa-flow.sh` 把「建測試骨架 / 出 junitxml 報告 / 防假綠燈驗證 / 回填 catalog 情境索引」鎖進腳本，
  落點鎖 session 起始目錄（不鑽子專案目錄），不再有「測完只印對話、沒留下任何檔」的情形。
- **內建 Stop hook 他律強制**：光靠 SKILL 裡寫「必須落地」擋不住 AI 用通用 Playwright MCP 手動測完就口頭回報。
  本 plugin 內建一道 Stop hook（`hooks/qa-landing-gate.js`）——**觸發 QA 後用了瀏覽器工具、卻沒在 `tests/e2e/` 留下
  `test_*.py` + `reports/*.xml` + 回填的 `catalog.md`，結束時會被擋下要求補落地**（最多擋 2 次留逃生門；沒觸發 QA 只用瀏覽器則僅警告不擋）。
  裝 plugin 即自動生效，不需改 settings.json。
- **驗真證據**：用 API 回傳碼 / 頁面讀回值 / 資料來源比對來判定通過，不靠人眼看截圖。
- **覆蓋容易漏的細節**：內建必測 checklist、測試資料規範，特別處理日期欄位的「畫面 / 送出 payload / 資料來源 / 重新整理後」四點一致性。
- **跨專案通用**：方法論不綁特定網站或技術棧，裝一次到處可用。

> **載體中立**：本 plugin 的價值在「測試設計方法論」，**不綁特定執行工具**。沉澱端用專案既有的 runner
> （首選 pytest-playwright）。[webwright](https://github.com/microsoft/webwright) 是**選用的備用探索器**——
> 僅當需打「真實外部站（無 a11y、Akamai/H2 封 Chromium、長程未知路徑）」時才裝它做一次性探索，
> 探索完一律 codify 成 runner，回歸端永遠不是 webwright。本機自家系統有 a11y、有後端可攔，**不需要** webwright。

## 內容

```
qa-webwright/
├─ .claude-plugin/
│   └─ plugin.json              plugin manifest
│       （marketplace.json 在 monorepo root 的 .claude-plugin/，統一註冊各 plugin，不在本 plugin 內）
├─ agents/
│   └─ qa-engineer.md           QA Agent：設計測試計畫（含 critical points）
├─ hooks/
│   ├─ hooks.json               Stop hook 宣告（裝 plugin 即生效）
│   └─ qa-landing-gate.js       落地強制閘：觸發 QA 後用了瀏覽器卻沒落地產物就擋（他律）
├─ commands/
│   ├─ qa-plan.md               /qa-webwright:qa-plan — 設計測試計畫
│   └─ qa-run.md                /qa-webwright:qa-run — 探索 → 沉澱成 runner assert + 驗證
└─ skills/
    └─ browser-qa/
        ├─ SKILL.md             方法論：兩階段流程、critical-point 對映、報告格式
        ├─ qa-flow.sh           流程腳本：bootstrap / scaffold / run / catalog（落地動作鎖進腳本，落點鎖 session 目錄）
        ├─ methodology/         方法論（穩定、不綁技術棧）
        │   ├─ test-plan-design.md   覆蓋矩陣 / 必測 checklist / TC 格式 / 測試資料原則
        │   └─ critical-points.md    TC 預期 → critical point → assert 對映
        └─ knowledge/           知識庫（踩過的雷與領域知識，持續 append）
            └─ pitfalls.md           後端驗證 / 日期時區 / 壞值 / Windows 啟動 / 元件雷 / state 同步 / webwright操作 / 外部站H2指紋
```

> **方法論 vs 知識庫**：`methodology/` 是穩定、跨專案不變的「怎麼做」；`knowledge/` 是會長大的
> 「踩過的雷」，每測一次踩到新坑就 append 一條，並依目標專案技術棧選用。兩者分開維護。

## 前置依賴

本 plugin 是「QA 方法論層」，沉澱端用專案既有的測試 runner。

**必備：** 可重跑的測試 runner（**固定優先 pytest-playwright**）。greenfield 專案由 `qa-flow.sh scaffold` 建骨架、
印出安裝指令讓你執行（腳本不代裝）；僅當你明確不同意裝 Python，才退而用 Playwright JS。既有專案已有別的 runner 則沿用。
探索優先用專案既有手段（Playwright MCP 的 a11y snapshot `ref` / Page Object）。

**選用（僅「真實外部站」備用探索）：** 當需打真實外部站（無 a11y test token、後端不可攔、
Akamai/H2 封 Chromium、長程未知路徑）時，才裝 webwright：

```text
/plugin marketplace add microsoft/webwright
/plugin install webwright@webwright
playwright install firefox     # webwright 用 Firefox 規避 H2 指紋封鎖
```

> 探索完一律把路徑 codify 成 runner（pytest 等），回歸端永遠不是 webwright。
> 本機自家系統（有 a11y、有後端可攔）不需要裝 webwright。

## 安裝本 plugin

本 plugin 屬 monorepo（`fulin-claude-plugins`）的一員，marketplace.json 在 **monorepo root** 的 `.claude-plugin/`
統一註冊各 plugin。安裝走 monorepo marketplace：

```text
/plugin marketplace add <monorepo-git-repo>   # 例：/plugin marketplace add abs1294/fulin-claude-plugins
/plugin install qa-webwright@fulin-plugins
```

安裝後**重開一個 Claude Code session**（或 `/reload-plugins`；plugin 在 session 啟動時載入）。

> 本機測試：`/plugin marketplace add <monorepo 根目錄路徑>`（指向**含 `.claude-plugin/marketplace.json` 的 monorepo root**，
> 不是 plugin 子資料夾——plugin 子資料夾內沒有 marketplace.json），再 `/plugin install qa-webwright@fulin-plugins`。

驗證 manifest：

```bash
claude plugin validate ./qa-webwright
```

## 使用

裝好後，在**任何專案**裡：

```text
# 設計測試計畫
/qa-webwright:qa-plan 供應商主檔新增頁的「通知財務」流程

# 依計畫探索 → 沉澱成 runner assert + 結構化證據驗證 + 出報告
/qa-webwright:qa-run <貼上計畫，或直接給功能描述>
```

或直接用自然語言（skill / agent 會依描述自動觸發）：「請 QA 測試這個新增流程」。

## ⚠️ 測試會落在哪：你**在哪個資料夾啟動 claude**，就落在哪

測試檔 / 報告 / catalog 一律落在**你啟動 claude 的那個資料夾**底下的 `tests/e2e/`——由 `qa-flow.sh` 鎖定，**不會鑽進子專案目錄**。

**這條規則決定了你該在哪啟動 claude：**

| 你想測的範圍 | 該在哪啟動 claude | 測試落點 |
|---|---|---|
| 整個 app / workspace | 在該 workspace 根目錄啟動 | `<workspace>/tests/e2e/` |
| 某個子專案 / 子 repo（如 `customer-hub`）| **進到那個子專案資料夾裡啟動** | `<子專案>/tests/e2e/` |

> **不要**「在上層 workspace 啟動、卻期待測試落進某個子 repo」——那會被 `qa-flow.sh run` 的守門員擋下。
> 要測子 repo，正確作法是**在那個子 repo 資料夾裡重新啟動 claude**（e2e 的測試棧不一定等於該 repo 語言，落點由「session 起在哪」決定）。

## 移植到新專案要補的「專案專屬」資訊

本 plugin 的方法論是通用的；**只有「啟動服務」那段是專案專屬**。在目標專案的 `CLAUDE.md`
或 README 補上：前後端各自的 port、啟動指令、健康檢查 URL、登入方式。`browser-qa` skill 的
Phase 2 會引用這些來起服務（Windows 背景啟動的 `npm.cmd` 雷見 `browser-qa` skill 的 `knowledge/pitfalls.md` D 段）。

## 作者

fulin
