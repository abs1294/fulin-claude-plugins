# harness — AI 工作流制度層引擎

把 Supplier_Code 淬煉出的通用工作紀律（模型調度、停損熔斷、派工模板、知識協議）打包成可實例化的引擎：`/harness:init` 在任何專案 workspace 生成一套量身的 `.claude/harness/` 制度層——**不管那個專案是什麼語言、什麼架構**。

## 設計核心：引擎與實例分離

| 層 | 位置 | 誰維護 |
|----|------|--------|
| **引擎**（通用骨架＋改編原則＋init 流程） | 本 plugin | monorepo（bump＋publish） |
| **實例**（各專案的 harness 檔） | 各專案 `.claude/harness/` | 該專案自治（紅區流程） |

plugin 更新只覆蓋引擎，**永不觸碰任何專案的實例**——各實例落地後各自演化（升格協議：規則從該專案自己的事故長出來）。這是刻意設計：曾有 plugin 升級覆蓋本機客製 patch 的前例，實例絕不能放在會被更新輾過的位置。

## 用法

在目標專案（或指定目標路徑）說：

```
/harness:init
```

流程＝**盤點**（實查結構/build 指令/既有治理層/測試基礎，不信文件宣稱）→ **決策**（實例落點、治理分工，湊一次問）→ **骨架填空**（生成 CLAUDE.md 路由中心＋harness 02~05）→ **機械驗收**（placeholder 殘留=0、來源污染詞=0、引用路徑逐條存在）。

目標 repo 已有自己的治理層（AGENTS.md／.agents/ 等多工具規範）時，實例會**讓位**：開發流程正本歸它，harness 只補 Claude Code 特有行為層。

## 內容物

```
skills/harness-init/
  SKILL.md                      /harness:init 主流程
  references/
    adaptation-guide.md          改編原則（通用/專案切分、讓位規則、去專案化檢核、骨架回收門檻）
    skeleton-CLAUDE-md.md        路由中心骨架
    skeleton-harness-README.md   harness 導航頁骨架
    skeleton-02-model-dispatch.md
    skeleton-03-judgment-matrix.md
    skeleton-04-delegation-templates.md
    skeleton-05-knowledge-protocol.md
hooks/
  session-reminder.js            SessionStart 條件式提醒：偵測到專案有 .claude/harness/ 才輸出入口提醒，未 init 的專案保持沉默
```

## 骨架不帶什麼（同樣是設計）

- 不帶 01 診斷書、06 交接信——那是各專案自己的病歷與遺囑。
- 不帶事故型 DoD 細則與 guard hooks——沒付過學費的規則只是 token 稅；等實例踩坑後依升格協議長出來。
- 不帶任何來源專案的 agent 組合、pipeline、已知的坑。

## 骨架條款回收門檻

某實例升格的條款要進骨架：須「≥2 個專案獨立踩過同類坑」或「與專案無關的純行為紀律」。單一專案的事故留在該實例。詳見 `references/adaptation-guide.md` §5。
