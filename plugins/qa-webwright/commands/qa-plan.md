---
description: 用 qa-engineer agent 設計一份可落成可重跑 pytest 的測試計畫（單一 TC 表，每列一條含證據與需求對照）。
argument-hint: <要測試的功能 / PR 範圍描述>
---

請以 **qa-engineer** agent 的角色，為以下功能設計測試計畫。

功能 / 範圍：

$ARGUMENTS

先讀本 plugin `browser-qa` skill 的 `SKILL.md` 與 `methodology/test-plan-design.md`、`methodology/critical-points.md`，
然後依 Phase 1 流程設計，**輸出格式一律用 `qa-engineer` agent 定義的單一表格**
（每列一條 TC，欄位：TC / 功能情境 / 操作步驟 / 證據 / 預期結果 / 需求）：

- 設計時**內部**要做（不寫進輸出）：窮舉覆蓋矩陣（status/enum、分支、角色、tab/視圖、資料邊界）確保每維度有 TC；
  大型功能做一次紅隊漏測複查補漏。**補出來的 TC 直接併進輸出表，矩陣與複查過程不另立段落。**
- 每條 TC 的預期結果寫成「可由其結構化證據獨立判定」的形式，標好對應的 critical point 與需求。

**只輸出那張 TC 表**——本命令不開瀏覽器、不執行測試，那是 `/qa-webwright:qa-run` 階段的工作（由 qa-engineer agent 執行）。
