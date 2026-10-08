# supplier-agents

**在 Winbond 供應商平台上開發時，讓一條龍的角色分工幫你把關——架構先設計好才動工、寫完先實測再交審（行為類變更），產出守住 DDD/CQRS 分層、資安與公司註解規範（不留 AI 痕跡）。**

一個人用 AI 做 DDD 專案常見的痛：AI 跳過架構設計直接寫、寫完沒人審就當完成、註解一堆「罐頭複述」的 AI 痕跡。supplier-agents 把開發拆成五個分工明確的子代理，用**強制交接鏈**綁住流程——架構設計 → 後端 / 前端實作 → 回報主對話 → QA 驗證 → 程式碼審查（行為類；靜態可確定等價的變更可直接送審），每一棒由主對話指揮，沒交清楚下一棒不開工。

> ⚠️ **這是專案專屬 plugin**：綁定 Winbond 供應商平台的技術棧與規範，各 agent 依賴專案內既有的 Skill（`.claude/skills/...`）與規範檔。請在已具備這些檔案的供應商平台 workspace 中使用；其他專案直接裝不會有對應 Skill 可用。

## 安裝

透過 fulin plugin marketplace 安裝：

```
/plugin marketplace add abs1294/fulin-claude-plugins
/plugin install supplier-agents@fulin-plugins
```

安裝後，五個 agent 會依各自 `description` 的觸發詞自動被主 Agent 調用，也可直接點名（如「請後端架構師」）。

> 上方 ⚠️ 提到的「專案內規範檔」具體指：`註解撰寫規範.md`、各 Repository 的 `CLAUDE.md`、`.github/instructions/`。

## 包含哪些 agent

| Agent | 角色 | 何時用 |
|-------|------|--------|
| `backend-architect` | 後端架構師 | 後端實作「之前」。設計 API 架構、分析 Aggregate、定義 Domain Model / Repository Interface / Command / Query、設計 API Contract。產出結構化設計文件後交給 backend-engineer。 |
| `backend-engineer` | 後端 / 資料庫工程師 | 依設計文件實作後端。寫 API / Command / Query / Handler、實作 Repository、設計資料表、寫 SQL Migration。前置：architect 必須先完成設計，不得自行改架構。 |
| `frontend-engineer` | 前端工程師 | Vue 3 前端開發。新增畫面 / Tab / Component、Pinia store、Router、i18n、串接 API、權限控制（PermIf）。前置：API Contract 已由 architect 確認。 |
| `code-reviewer` | 程式碼審查 | 行為類變更在 QA 實測之後；靜態可確定等價的變更在 engineer 回報後直接送審；git-commit C 軌送審；或人工指定審查。檢查 DDD / CQRS 架構規範、資安、品質一致性，並把「罐頭 / 複述型註解（AI 痕跡）」當缺陷指出。輸出分級（🔴 Critical / 🟡 Important / 🟢 Minor）並判定是否通過。 |
| `qa-engineer` | QA 工程師 | engineer 實作完成並回報主對話後、送 code-reviewer 之前（行為類變更）。設計可逐步追蹤的測試計畫、**親自執行** Playwright MCP 測試、輸出測試報告，並把穩定案例 codify 進 `tests/e2e`；主 Agent 只派工收結論、不親跑瀏覽器。 |

## 協作流程

agent 檔中明訂了交接鏈，每一棒都回報主對話、由主對話派下一棒（agent 不自行派工）。典型開發流程（順序正本＝專案 `CLAUDE.md` §3）：

```
backend-architect  ──設計文件──▶  backend-engineer ─┐
                                                     ├─▶ 回報主對話 ──▶ qa-engineer（實測＋codify）──▶ code-reviewer ──通過──▶ 完成
   API Contract ───────────────▶  frontend-engineer ─┘
```

靜態可確定等價的變更（純結構／文案／死碼／i18n）為分流例外：回報主對話後直接送 code-reviewer，QA 可評估跳過。

關鍵交接規則：

- **architect → engineer**：未完成架構設計，backend-engineer 不得開始實作；engineer 若認為設計有問題須回報 architect，不得自行調整。
- **engineer → 主對話**：後端 / 前端開發完成後回報主對話，附「異動檔案清單（含路徑）+ 功能說明 + 重點審查／實測處」；engineer 不自行派下一棒。
- **主對話 → qa-engineer**（行為類）：本功能涉及的 engineer 皆實作完成並回報後，QA 設計測試計畫、親自執行 Playwright MCP 並 codify；不需等審查通過。
- **qa-engineer → code-reviewer**：QA 完成後由主對話送審；分流例外則 engineer 回報後直接送審。未通過審查不視為完成。
- **主 Agent 的角色**：只派工與收結論，不親跑瀏覽器、不自行設計案例。
- **開工前必讀**：五支 agent 開工前都讀 `CLAUDE.md`（root）、`GLOSSARY.md`（專案詞彙；沒有就讀 `CONTEXT.md`）、`FLOWS.md`（碰到已收錄鏈路才讀）；qa-engineer 另讀 `tests/Project_Detail/PROJECT.md` 與 `tests/e2e/README.md`。回報最後一行是「已讀：…；略過：…（理由）」。

## 搭配 git-commit 時的專案設定

commit 前 git-commit 的 C 軌也會派 `code-reviewer`。供應商平台的派工 hook 要求審查 prompt 帶 rule-scan 步驟，這段要求寫在 workspace 的 `.claude/git-commit-reviewer-addendum.md`，由 git-commit **0.10.0 以上**的 `flow.sh prepare` 印出、貼進 C 軌 prompt。git-commit 版本低於 0.10.0 時這個檔不會被讀到，C 軌會被 rule-scan 閘擋一次。機制說明見 git-commit README 的「專案層設定檔」節。

## 各 agent 綁定的 Skill

每個 agent 在執行任務前都必須先讀取對應 Skill（皆位於 `.claude/skills/`）：

| Agent | 必用 Skill |
|-------|-----------|
| backend-architect | `backend-ddd-architect` |
| backend-engineer | `backend-ddd-development` |
| frontend-engineer | `frontend-development` |
| code-reviewer | `code-review` |
| qa-engineer | `browser-qa`（qa-webwright plugin）＋專案 `tests/Project_Detail/PROJECT.md` |

## 適用情境

- .NET DDD / CQRS 後端開發（API / Application / Domain / Infrastructure 分層；Repository 只操作 Aggregate Root；Query 不寫資料；SQL 全參數化）。
- Vue 3 前端開發（Pinia、Router、i18n、Design System 元件、PermIf 權限控制、API 整合）。
- 需要嚴格 code review 與資安把關，並避免程式碼留下「罐頭 / 複述型」AI 痕跡註解（同時正確處理 C# `GenerateDocumentationFile` 的 CS1591）。
- 需要可追蹤、UI 實測（含日期 / 時區四點驗證）的功能驗收流程。
