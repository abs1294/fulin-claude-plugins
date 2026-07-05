# fulin-claude-plugins — 專案指令（路由中心）

> 本檔是**路由中心**，不是規則倉庫。核心規則抽離在 `.claude/harness/`，這裡只留「你在哪、往哪走」。
> 設計原則：**弱模型需要明確指路，強模型需要留白**。所以本檔短、指向清楚，細節在各別檔。

---

## 你在哪：這個 repo 是什麼

fulin 的**自製 Claude Code plugin monorepo**。所有自製 plugin 集中在 `plugins/`，只有一個 repo、一個 marketplace。主角是 `plugin-manager`（管理所有 plugin 的 meta-plugin）。
完整介紹見 `README.md`。工作規範見 `plugins/plugin-manager/CONVENTIONS.md`。

**你在這個 repo 的主要工作**：開發/維護這些自製 plugin（改 skill/hook/agent → bump 版本 → 發布）。

---

## 最重要的路由：弱模型工作流 Harness

> **若你是 Sonnet / Opus 4.8 / Haiku，開場先讀這兩份**——它們決定你怎麼工作，不只做什麼。

| 先讀 | 檔案 | 給你什麼 |
|------|------|----------|
| ① | `.claude/harness/A-漏水診斷書.md` | 這台機器最會浪費 token / 失焦 / 調錯工具的三個坑 + 阻斷法 |
| ② | `.claude/harness/D-判斷力矩陣.md` | 何時該停、換路、問人——可肉眼比對的判準 |

其餘按需（總索引見 `.claude/harness/_INDEX.md`）：
- 要派 subagent → `C-模型調度守則.md`（指揮官不下場）+ `E-派工模板.md`（填空模板）
- 踩坑後 / 想改規則 → `F-反思協議.md`
- 想懂「為什麼這樣設計」→ `G-交接信.md`

**一句話總則**：主對話只做判斷與派工，不下場讀檔搜尋；任何實作都要 fresh-context subagent 隔離驗證；同一件事最多重試兩輪，不確定就停下問人。

---

## 硬規則（繞不過 or 血淚換來，別踩）

1. **搜尋用 Glob/Grep 工具，限定目錄**。禁止 Bash 跑 `find /` 全碟盲搜（見 A 痛點 1，這是本機真實發生過的事故）。
2. **commit / push 一律走 `git-commit` skill**，禁止裸 `git commit`。commit message **不加任何 Claude 署名**（見全域 CLAUDE.md）。
3. **改完 plugin 要 bump 版本**：走 `/plugin-manager:update` → `/plugin-manager:publish`（見 CONVENTIONS.md）。
4. **「一定要落地」的動作需機制閘**，不能只寫「必須」（skill 的「必須」是自律、AI 會繞；只有 hook 是他律）。範式：`qa-webwright` 的 qa-flow.sh + Stop hook、`git-commit` 流程。
5. **改既有檔前建 `.bak`**。
6. **debug 前先給三件套**（錯誤行 / 讀過的碼 / 哪台機器），猜測標 HYPOTHESIS（見全域 CLAUDE.md）。

---

## 既有 plugin 分工（需要時調用，別重造）

| 需求 | 用這個 |
|------|--------|
| 對抗式驗證一個決策/設計/文件 | `red-blue-review` skill |
| 瀏覽器 QA / 沉澱可重跑測試 | `qa-webwright` |
| tool call 失敗自動接力 | `self-heal`（背景運作，不需手動） |
| 把產出寫成給外部看的交付訊息 | `deliver-report` |
| 排程到 quota 重置後本機執行 | `delaylocal` |
| Winbond 供應商平台 DDD 開發 | `supplier-agents`（5 個 agent） |

各 plugin 細節見各自 `plugins/<name>/README.md`。

---

## 記憶與反思

- **跨 session 記憶**：`~/.claude/projects/C--Users-User-Claude-fulin-claude-plugins/memory/`（+ `MEMORY.md` 索引）。踩坑教訓優先寫這裡。
- **制度改進提案**：寫進 `.claude/harness/F-反思協議.md` 的踩坑區（🟡 只可 append）。
- **改 harness 骨幹檔（A/C/D/E/F/G 正文）或本 CLAUDE.md 前，先徵得 User 同意**（見 F 檔檔案分級；F/G 的 append 區可自行追加，正文不可自改）。
