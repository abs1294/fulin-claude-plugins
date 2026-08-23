---
name: harness-init
description: 把 harness 制度層（模型調度/停損熔斷/派工模板/知識協議）實例化到一個專案 workspace。當使用者說 /harness:init、「幫這個專案裝 harness」、「實例化 harness」、「把制度層搬到 X 專案」時觸發。流程＝盤點→決策→骨架填空→機械驗收；不是複製既有專案的檔，是用通用骨架填入目標專案的已查證事實。
---

# harness:init — 制度層實例化

把 `references/` 裡的通用骨架實例化到目標 workspace 的 `.claude/harness/`。**引擎（本 plugin）與實例（專案檔）分離**：plugin 更新不會動到任何專案的實例；實例落地後歸該專案自治（紅區流程見實例的 05）。

## 核心原則（動工前先讀 `references/adaptation-guide.md`，本節只是摘要）

1. **實例化不是複製**：骨架只含通用紀律；目標專案的事實（build 指令、agent 名單、邊界）必須**實地查證後填入**，禁止從別的專案的實例照抄、禁止用猜的。
2. **不預載別專案的事故條款**：DoD 只帶核心條款；其餘等目標專案踩坑後依實例 05 的升格協議長出來。沒付過學費的規則只是 token 稅。
3. **既有治理層讓位**：目標專案已有自己的 agent 治理（AGENTS.md／.agents/／既有 CLAUDE.md 規範）時，harness 只補「Claude Code 特有行為層」（模型派工、停損熔斷、隔離驗證、memory），開發流程正本讓給既有治理層並在路由中心明寫分工——不得重定義、不得複製內文。

## 流程

### Phase 1 — 盤點（唯讀，一次查完再往下）

對目標 workspace 查證並記下（超過 3 檔的探索照骨架 02 的紀律派 `Explore`）：

- 結構：workspace 根有哪些資料夾；哪些是 git repo；每個 repo 的 `git remote -v`（**remote 指向外部／客戶伺服器＝push 屬外向動作**，要進邊界條款）。
- 技術棧與驗證指令：**實際讀** build／run／test 腳本與設定檔（package.json scripts、pom.xml、Makefile、*.bat…），不猜、不信 README 宣稱——查證過的才能寫進實例 03 矩陣 B。
- 測試基礎：實查測試目錄是否存在（文件說有 ≠ 真的有；曾實測某 repo 自述有 src/test 但實際不存在）。
- 既有治理層：AGENTS.md、`.agents/`、`.cursor/`、既有 CLAUDE.md／`.claude/`、CI 規範。有 → 記下它管什麼，harness 讓位。
- 敏感物：憑證檔、VPN 資訊、客戶機密目錄 → 進實例 CLAUDE.md 絕對邊界。

### Phase 2 — 決策（真決策才問，湊成一次 AskUserQuestion）

1. **實例落點**：workspace 根（預設推薦；不進版控、零外向風險）vs repo 內（會被 commit/push，客戶 remote 時需明確同意）。
2. 既有治理層的分工確認（若盤點有發現）。
3. 其餘可代決的（如 changelog 出處標註留不留）自決＋回報，不問。

### Phase 3 — 生成（骨架填空）

以 `references/skeleton-*.md` 為底逐檔生成，落到目標 `.claude/harness/`（＋workspace 根 `CLAUDE.md`）：

| 骨架 | 落點 | 填空重點 |
|------|------|----------|
| `skeleton-CLAUDE-md.md` | `<ws>/CLAUDE.md` | workspace 對照表、治理分層、絕對邊界、路由表 |
| `skeleton-harness-README.md` | `.claude/harness/README.md` | 生效範圍限制照實寫 |
| `skeleton-02-model-dispatch.md` | `.claude/harness/02-model-dispatch.md` | agent type 對照（無專案 agent 就用內建 Explore/general-purpose/Plan） |
| `skeleton-03-judgment-matrix.md` | `.claude/harness/03-judgment-matrix.md` | 本專案驗證指令（Phase 1 查證的）、C2 外向清單 |
| `skeleton-04-delegation-templates.md` | `.claude/harness/04-delegation-templates.md` | 開工前必讀清單的來源（既有治理層的檔或無）、流程編排節 |
| `skeleton-05-knowledge-protocol.md` | `.claude/harness/05-knowledge-protocol.md` | 紅區清單（含既有治理層檔案）、健檢清單本地化 |

另生成 `.claude/settings.json` 建議內容（SessionStart 提醒可靠本 plugin 的條件式 hook 自動生效，專案 settings 可不用重複加；未啟用本 plugin 的專案才需要 inline 提醒 hook）。

填空紀律：所有 `{{...}}` 必須填掉或整段刪除（該段不適用時）；**不確定的事實回 Phase 1 查證，不得留猜測**。

### Phase 4 — 機械驗收（缺一不算完成）

```
□ grep "{{" 於實例目錄 = 0 命中（無殘留填空）
□ grep 來源污染詞 = 0 命中（詞表見 adaptation-guide「去專案化檢核」；changelog 出處標註除外）
□ 實例內引用的路徑逐條 ls 存在（含指向既有治理層的路徑）
□ 03 矩陣 B 寫入的每條驗證指令，指令本體實際存在（腳本檔在、npm script 有定義）
□ 每個實例檔 Read 回檔尾確認未截斷
```

### Phase 5 — 收尾回報

- 逐檔列落地清單＋關鍵改編決策（讓位了什麼、精簡了什麼、代決了什麼）。
- 明講生效範圍限制（hooks 只在啟用本 plugin 或設定所在層級生效）。
- 提醒：之後踩坑照實例 05 §6 升格協議長規則；harness 健檢照實例 05 §5。
- 盤點時發現的目標專案自身問題（文件漂移、缺測試基礎）誠實回報，不靜默。
