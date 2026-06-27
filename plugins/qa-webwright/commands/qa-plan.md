---
description: 用 qa-engineer agent 設計一份可落成可重跑 runner（pytest 等）的測試計畫（覆蓋矩陣 + critical points）。
argument-hint: <要測試的功能 / PR 範圍描述>
---

請以 **qa-engineer** agent 的角色，為以下功能設計測試計畫。

功能 / 範圍：

$ARGUMENTS

先讀本 plugin `browser-qa` skill 的 `SKILL.md` 與 `methodology/test-plan-design.md`、`methodology/critical-points.md`，
然後依 Phase 1 流程產出：

1. **覆蓋矩陣**（窮舉 status/enum、分支、角色、tab/視圖、資料邊界，每格對應 TC）
2. **測試案例**（每步標【證據】+ 預期結果，預期結果寫成可由其結構化證據獨立判定的形式）
3. **需求 ↔ TC 對照表**
4.（大型功能）紅隊漏測複查一次

輸出完整測試計畫，並標好每條預期結果對應的 critical point —— 不要自己開瀏覽器或執行測試，
那是 `/qa-webwright:qa-run` 階段主 Agent 的工作。
