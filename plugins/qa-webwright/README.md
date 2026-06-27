# qa-webwright

瀏覽器功能測試方法論，包成可安裝的 Claude Code plugin。

把一套成熟的 QA 方法論（測試計畫設計、覆蓋矩陣、必測 checklist、測試資料建立規範、
日期欄位跨 UI/送出payload/來源/刷新 四點驗證）**通用化**：QA Agent 設計計畫 → 主 Agent 探索路徑後，把每個
critical point **沉澱成可重跑 runner（pytest 等）的一行 assert**，以結構化證據
（API 業務碼 / DOM 讀回 / 來源 readback）自我驗證，不靠讀截圖。

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
├─ commands/
│   ├─ qa-plan.md               /qa-webwright:qa-plan — 設計測試計畫
│   └─ qa-run.md                /qa-webwright:qa-run — 探索 → 沉澱成 runner assert + 驗證
└─ skills/
    └─ browser-qa/
        ├─ SKILL.md             方法論：兩階段流程、critical-point 對映、報告格式
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

**必備：** 專案有可重跑的測試 runner（**首選 pytest-playwright**；或 Playwright Test 等帶 assert+exit code 者）。
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

## 移植到新專案要補的「專案專屬」資訊

本 plugin 的方法論是通用的；**只有「啟動服務」那段是專案專屬**。在目標專案的 `CLAUDE.md`
或 README 補上：前後端各自的 port、啟動指令、健康檢查 URL、登入方式。`browser-qa` skill 的
Phase 2 會引用這些來起服務（Windows 背景啟動的 `npm.cmd` 雷見 `browser-qa` skill 的 `knowledge/pitfalls.md` D 段）。

## 作者

fulin
