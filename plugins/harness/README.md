# harness — 開發流程制度安裝器

`/harness:init` 幫任何軟體開發專案裝上一套讓 Claude 照規矩做事的流程：什麼工作用哪一級模型、什麼時候該停下來換方法、怎樣才算做完、哪些動作要先問你、怎麼派工給 agent、踩過的坑怎麼記下來；再加上一組分工的 agent 角色、會真的擋下危險動作的自動檢查、三份知識筆記檔。**不管專案是什麼語言、什麼架構都能用**，會依掃描結果拿掉你用不到的部分。

## 設計核心

### 引擎與實例分離

| 層 | 位置 | 誰維護 |
|----|------|--------|
| **引擎**（規則文件範本、自動檢查範本、改編原則、init 流程） | 本 plugin | monorepo（bump＋publish） |
| **實例**（各專案的規則檔、agent、自動檢查、知識筆記檔） | 各專案 `.claude/`＋workspace 根 | 該專案自己維護（改之前要先問過使用者） |

plugin 更新只換掉引擎，**永遠不會動到任何專案裡已經產生的檔案**——各專案產生之後各自演變。這是刻意的：曾經發生 plugin 升級把本機客製的修改蓋掉，所以專案自己的檔案絕不能放在會被更新覆蓋的位置。自動檢查也一樣：init 把範本**複製**進專案的 `.claude/hooks/`，你可以自己改，代價是 plugin 更新時不會自動同步過來。

### 規則要能自動擋

只寫在文件裡的「必須」，AI 還是可能不照做；只有程式真的擋下來才靠得住。所以 init 不只產文件，也裝上自動檢查（Claude Code 的 hook：Claude 每次執行指令或派工前自動跑，命中就擋下），最後**開一個新的 session 實際試**（真的去派工、真的下 `git commit`），證明它真的會擋。

### 先說清楚：這是基本架構，不是成熟的 harness

init 產出的是**一套基本架構，加上讓它越用越完整的方法**。一套成熟的 harness 除了規則檔，還有數十到上百條踩坑紀錄、數百支自動測試、每個模組測到哪裡的登記——那些只能從專案自己的工作裡累積。結束時的回報會明列「你已經有的」與「你還沒有的」。

## 用法

在目標專案說：

```
/harness:init
```

| 步驟 | 做什麼 |
|------|--------|
| 0 前置檢查 | 是不是 git repo／裝過 harness 沒（裝過就停，不覆蓋）／Codex CLI 裝了沒（沒裝就給安裝指引並停下，不會跳過它繼續往下做）／Playwright MCP 有沒有列在允許清單 |
| 1 盤點 | 十一項實際讀程式碼查（不只看 README）：技術棧、build/test 指令、repo 結構與 remote、前端類型、有沒有測試、既有的開發規範文件、既有 agent、會對外造成影響的動作（寄信、部署、刪資料等七類）、敏感檔案、跑起來時的風險（資料庫帳號、起服務與跑測試要的環境設定）、工作方式（例如本機一直改著不提交的設定檔） |
| 2 攤開核對 | 把盤點結果和據此推導的預設一次給你看，有錯請直接指出 |
| 3 訪談 | 一次問一題、每題附建議：①開發流程要哪些角色 ②哪些動作執行前一定要先問你 ③沒有畫面的專案怎樣算做完（只有沒前端時問）④一個人用還是團隊用 ⑤要裝哪些自動檢查（預設全裝，你可以取消）⑥還沒有自動測試時要不要先暫停「每次改動都補測試」的要求（只有沒測試時問）⑦哪些文件動手前必讀 |
| 4 生成 | 規則文件、自動檢查、agent 角色、知識筆記檔、Claude Code 設定檔（settings） |
| 5 驗收 | 檔案檢查九項，加上開新 session 實際試五項（派工沒指定模型會被擋／正常派工不會被誤擋／開 session 時有出現提醒／直接下 git commit 會被擋／危險指令的自動檢查真的有接上），任一項失敗就不算完成 |

專案已經有自己的開發規範（AGENTS.md、.agents/ 等）或自己的 agents 時，**以你們既有的為準**，harness 不另外蓋一套，只補上 Claude Code 特有的部分。

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
