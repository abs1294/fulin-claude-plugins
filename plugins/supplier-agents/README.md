# supplier-agents

**在 Winbond 供應商平台上開發時，讓一條龍的角色分工幫你把關——架構先設計好才動工、寫完一定交審、審過才測，產出守住 DDD/CQRS 分層、資安與公司註解規範（不留 AI 痕跡）。**

一個人用 AI 做 DDD 專案常見的痛：AI 跳過架構設計直接寫、寫完沒人審就當完成、註解一堆「罐頭複述」的 AI 痕跡。supplier-agents 把開發拆成五個分工明確的子代理，用**強制交接鏈**綁住流程——架構設計 → 後端 / 前端實作 → 程式碼審查 → QA 驗證，每一棒沒交清楚下一棒不開工。

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
| `code-reviewer` | 程式碼審查 | backend / frontend 開發完成後，或人工指定審查。檢查 DDD / CQRS 架構規範、資安、品質一致性，並把「罐頭 / 複述型註解（AI 痕跡）」當缺陷指出。輸出分級（🔴 Critical / 🟡 Important / 🟢 Minor）並判定是否通過。 |
| `qa-engineer` | QA 工程師 | code-reviewer 審查通過後。**只設計**可逐步追蹤的測試計畫並定義 Pass/Fail 輸出格式；瀏覽器操作（Playwright MCP）與測試報告由主 Agent 執行，QA 不直接操作瀏覽器。 |

## 協作流程

agent 檔中明訂了交接鏈，典型開發流程為：

```
backend-architect  ──設計文件──▶  backend-engineer ─┐
                                                     ├─▶ code-reviewer ──審查通過──▶ qa-engineer ──測試計畫──▶ 主 Agent 執行 + 出報告
   API Contract ───────────────▶  frontend-engineer ─┘
```

關鍵交接規則：

- **architect → engineer**：未完成架構設計，backend-engineer 不得開始實作；engineer 若認為設計有問題須回報 architect，不得自行調整。
- **engineer → code-reviewer**：後端 / 前端開發完成後必須交審；未通過審查不視為完成。交接需附「異動檔案清單（含路徑）+ 功能說明 + 重點審查處」。
- **code-reviewer → qa-engineer**：須 backend、frontend 皆開發完成且審查無 Critical 問題，QA 才開始設計測試計畫。
- **qa-engineer ↔ 主 Agent**：QA 設計測試案例、定義輸出格式；主 Agent 依計畫逐步執行並輸出報告。兩者不得互相越界（QA 不跑 Playwright、主 Agent 不自行設計案例）。

## 各 agent 綁定的 Skill

每個 agent 在執行任務前都必須先讀取對應 Skill（皆位於 `.claude/skills/`）：

| Agent | 必用 Skill |
|-------|-----------|
| backend-architect | `backend-ddd-architect` |
| backend-engineer | `backend-ddd-development` |
| frontend-engineer | `frontend-development` |
| code-reviewer | `code-review` |
| qa-engineer | `browser-testing` |

## 適用情境

- .NET DDD / CQRS 後端開發（API / Application / Domain / Infrastructure 分層；Repository 只操作 Aggregate Root；Query 不寫資料；SQL 全參數化）。
- Vue 3 前端開發（Pinia、Router、i18n、Design System 元件、PermIf 權限控制、API 整合）。
- 需要嚴格 code review 與資安把關，並避免程式碼留下「罐頭 / 複述型」AI 痕跡註解（同時正確處理 C# `GenerateDocumentationFile` 的 CS1591）。
- 需要可追蹤、UI 實測（含日期 / 時區四點驗證）的功能驗收流程。
