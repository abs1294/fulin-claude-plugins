# harness — 開發流程制度安裝器

`/harness:init` 在任何軟體開發專案裝上一套工作紀律：模型調度、停損熔斷、完成判準、派工模板、知識協議，加上一條 agent pipeline、會真的擋人的 hook、三份知識容器——**不管那個專案是什麼語言、什麼架構**，並依盤點結果自動裁切。

## 設計核心

### 引擎與實例分離

| 層 | 位置 | 誰維護 |
|----|------|--------|
| **引擎**（骨架、hook 範本、改編原則、init 流程） | 本 plugin | monorepo（bump＋publish） |
| **實例**（各專案的制度檔、agent、hook、知識容器） | 各專案 `.claude/`＋workspace 根 | 該專案自治（紅區流程） |

plugin 更新只覆蓋引擎，**永不觸碰任何專案的實例**——各實例落地後各自演化。這是刻意設計：曾有 plugin 升級覆蓋本機客製 patch 的前例，實例絕不能放在會被更新輾過的位置。hook 也一樣：init 把範本**複製**進專案 `.claude/hooks/`，使用者可自改，代價是 plugin 更新不自動同步。

### 規則要有機械閘

skill 與制度檔寫「必須」是自律，AI 會繞；只有 hook 是他律。所以 init 不只產文件，也產可執行的 hook，並在最後用**冷啟探針**（新開 session 實際派工、實際下 `git commit`）證明 hook 真的會擋。

### 誠實：骨架不是成熟的 harness

init 產出的是**骨架＋長出資產的路徑**。一套成熟的 harness 除了制度檔，還有數十到上百條踩坑記憶、數百支回歸測試、每個模組的覆蓋登記——那些只能從專案自己的工作裡長出來。收尾回報會明列「你已經有的」與「你還沒有的」。

## 用法

在目標專案說：

```
/harness:init
```

| Phase | 做什麼 |
|-------|--------|
| 0 前置檢查 | 是不是 git repo／裝過 harness 沒（裝過就停，不覆蓋）／Codex CLI 裝了沒（沒裝就給安裝指引並停下，不降級單軌）／Playwright MCP 在不在 allow-list |
| 1 盤點 | 十一項實讀（不信 README）：技術棧、build/test 指令、repo 結構與 remote、前端三分類、測試基礎、既有治理層、既有 agent、外部副作用路徑（七類危險動作）、敏感物、執行期風險事實（B 類 hook 依據）、工作法（C 類 hook 依據） |
| 2 攤開核對 | 盤點表＋自動推導的預設一次攤給使用者糾正事實 |
| 3 訪談 | 一次一題、每題附推薦：Q1 pipeline 刪改／Q2 哪些危險動作要熔斷／Q3 怎樣算做完（僅無前端）／Q4 單人或團隊／Q5 哪些規矩要程式擋／Q6 要不要豁免測試（僅無測試基礎）／Q7 哪些文件動手前必讀 |
| 4 生成 | 五層：文件層、可執行層、agent 層、知識容器層、settings 層 |
| 5 驗收 | 靜態五條＋冷啟探針四項（缺 model 被擋／正常派工不誤擋／SessionStart 提醒有出來／裸 git commit 被擋），任一失敗＝未完成 |

目標 repo 已有自己的治理層（AGENTS.md／.agents/ 等）或自己的 agents 時，實例會**讓位**：開發流程正本歸它，harness 只補 Claude Code 特有行為層。

## 內容物

```
skills/init/
  SKILL.md                                /harness:init 主流程（Phase 0~5）
  pollution-wordlist.txt                  污染詞表（黑名單，機器可讀；Phase 5 驗收與 wordlist-sweep hook 共用）
  references/
    adaptation-guide.md                   改編原則（帶／不帶判準、讓位、外向邊界、詞表與其維護觸發、骨架維護、實例差異）
    skeleton-CLAUDE-md.md                 路由中心骨架（含 pipeline 節、路由表指向容器／agents／hooks）
    skeleton-harness-README.md            harness 導航頁骨架（五層清單、生效範圍、誠實揭露）
    skeleton-02-model-dispatch.md         模型調度（agent 對照表、Fable 禁下放、Quota 節流、指揮官不下場、隔離驗證）
    skeleton-03-judgment-matrix.md        判斷矩陣 40 條（A1-A8 停損／B1-B23 完成判準／C1-C9 熔斷）＋三重自查＋品味決策流程
    skeleton-04-delegation-templates.md   派工模板一～六（模板五 Pipeline 編排、模板六 QA 驗證型）
    skeleton-05-knowledge-protocol.md     知識協議（三區分級、踩坑格式、MEMORY.md 字元數精簡觸發、健檢、升格）
    agents/                               五支通用 agent 骨架
      skeleton-agent-backend-architect.md
      skeleton-agent-backend-engineer.md
      skeleton-agent-frontend-engineer.md
      skeleton-agent-qa-engineer.md       （瀏覽器可驅動時整段指向 qa-webwright plugin）
      skeleton-agent-code-reviewer.md     （保留 git-commit C 軌的 VERDICT 契約）
    containers/                           三份知識容器骨架（收錄原則＋示範條目＋Changelog）
      skeleton-CONTEXT.md                 專案特有詞彙表 → workspace 根 CONTEXT.md
      skeleton-FLOWS.md                   跨模組鏈路圖 → workspace 根 FLOWS.md
      skeleton-PROJECT.md                 QA 操作坑與測試設計知識 → tests/Project_Detail/PROJECT.md
hooks/
  hooks.json                              plugin 自己的 hook 宣告
  session-reminder.js                     SessionStart 條件式提醒：偵測到 .claude/harness/ 才輸出，未 init 的專案保持沉默
  wordlist-sweep.js                       引擎側：改到骨架檔要 commit 時，要求表態「有沒有新的專案特徵詞要補進詞表」
  templates/                              init 複製到目標專案 .claude/hooks/ 的範本（檔頭「init 填空區」常數由 init 填）
    （裝哪幾支照 skills/init/references/hook-catalog.md 推導，沒有固定數量）
    ── A 必裝 ──
    check-agent-model.js                  派專案 agent 沒帶 model／subagent 帶 fable → deny
    check-review-discipline.js            派工 prompt 缺該 agent 的紀律標記（驗收條件、回報格式、範圍展開…）→ deny
    check-ask-discipline.js               AskUserQuestion 每題沒附推薦選項 → deny
    guard-qa-before-commit.js             staged 含行為類檔但沒表態 QA 狀態 → 擋 git-commit
    guard-sediment-sweep.js               知識沉澱四題閘（詞／鏈／QA／代號；args 表態制；可綁 git-commit 或 Stop）
    guard-claude-dir-hygiene.js           .claude/ 底下只准在機制目錄新建檔
    health-check-reminder.js              距上次制度健檢超過門檻天數 → 開 session 提醒
    memory-write-advisory.js              寫 memory 後提醒索引大小與總則檔合併
    compact-snapshot.js＋compact-handoff.js
                                          壓縮前存快照（背景 agent、讀過的規範、改過的檔、使用者原話），並開隔離的 claude -p
                                          子 session 寫交接信（九節，未完成完整保留、工具回傳的關鍵值原樣抄入）；找不到 claude 或失敗時只留快照、不擋壓縮
    compact-reinject.js                   壓縮後（SessionStart compact）注入交接信與接續指示，超長時先截「已完成」節，整段不超過平台 10,000 字元上限
    compact-summary-log.js                壓縮後記下摘要漏掉的項目、交接信又漏了什麼（評估用流水帳）
    resume-stale-reminder.js              隔數小時才 resume 時提醒狀態可能已過期，附最近交接信路徑與最後一則指示
    ── B 盤點觸發（規則由 init 依盤點結果填）──
    guard-risky-command.js                熔斷清單上的指令（高權帳號連 DB、部署、正式主機、毀滅性 SQL、起服務缺環境）→ 擋
    guard-test-preconditions.js           跑測試前驗前置條件（寄信收斂、測試環境對齊）→ 不符就擋
    shell-model.js＋package.json＋package-lock.json
                                          上面兩個引擎共用的指令語法解析（tree-sitter，bash 與 PowerShell 各一套文法）；
                                          init 在目標專案 .claude/hooks 跑 npm ci，沒裝或解析失敗時引擎退回正則判法
    guard-report-output.js                交付物落點紀律（主題_日期資料夾、過程檔進 _work/）
    ── C 工作法觸發（偵測到本機覆寫檔才裝）──
    backup-local-hacks.js                 shell 指令前逐檔備份本機覆寫
    guard-local-hack-destroy.js           會銷毀工作區的 git 指令碰到本機覆寫 → 擋（沒有放行記號）
    check-local-hacks-alive.js            開 session 點名遺失的本機覆寫
    restore-local-hacks.js                救回腳本（上面三支的訊息會叫使用者跑它）
    ── E 長出來才裝 ──
    guard-test-asset-hygiene.js           寫測試檔後跑專案自己的稽核工具
    probe-hooks.js＋cases/                每支範本正反兩向的案例與執行器；Phase 5 驗收與 05 健檢都跑它
```

## 骨架不帶什麼（同樣是設計）

原則是**開發流程骨幹全帶、事故型條款不帶**（細節見 `references/adaptation-guide.md` §1）：

- **帶**：純行為紀律（原文照搬）、可參數化的判準（專案事實挖成填空）、開發流程骨架（pipeline、agent、機械閘、知識容器）。
- **綁定特定工作法的條款不預載**：本機覆寫檔管理、多工作樹並行、特定鏡像架構——判斷矩陣不帶這幾條。但對應的**保護 hook** 照形狀目錄 C 類處理：Phase 1 偵測到目標專案也有這種工作法（例如有本機覆寫檔）才裝。
- **不帶事故型條款**：某個第三方套件的坑、某次事故的細則——由目標專案自己的 memory 長出來，或歸未來的 `/harness:review` 對照各實例提議。
- **不帶 01 診斷書、06 交接信**——那是各專案自己的病歷與遺囑。
- **不帶任何知識內容**：CONTEXT／FLOWS／PROJECT 只帶結構與一個標明「示範」的條目，不替專案編詞條、畫鏈路、寫坑。
- **hook 不從固定清單挑**：可執行層照 `references/hook-catalog.md` 推導——來源專案每支 hook 都拆成「通用形狀＋觸發條件＋專案參數」。綁著來源專案事實的那些（資料庫登入守衛、服務啟動環境、寄信收斂、測試環境對齊）不是原檔照搬，而是收成兩個規則引擎（`guard-risky-command`、`guard-test-preconditions`），init 用目標專案盤點到的事實填規則。每支範本自帶正反兩向的 `cases/`，由 `probe-hooks.js` 實跑驗證。

## 骨架條款回收門檻

某實例升格的條款要進骨架：須「≥2 個專案獨立踩過同類坑」、「與專案無關的純行為紀律」或「挖空專案事實後形狀仍成立」。單一專案的事故留在該實例。回收時事故只講機制不寫日期，改到骨架檔 commit 時會被 `wordlist-sweep.js` 要求回答詞表維護題。詳見 `references/adaptation-guide.md` §4–§5。
