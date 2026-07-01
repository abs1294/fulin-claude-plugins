# fulin-plugins

fulin 的自製 Claude Code plugin monorepo。核心是 **plugin-manager**——一個「管理所有自製 plugin」的 meta-plugin；本 repo 同時也是它管理出來的 marketplace。

---

## ⭐ 主角：plugin-manager

**解決的痛**：Claude Code 官方做法常是「一個 plugin = 一個 git repo」。寫 500 個自製 plugin 就有 500 個 repo，無法維護。

**plugin-manager 的解法**：所有自製 plugin 全收進**同一個 monorepo**（就是本 repo 的 `plugins/`），永遠只有 **1 個 repo** 要維護。它再提供一套指令管理這些 plugin 的納管、版本、發布、與專案啟用。

### 指令

| 指令 | 做什麼 |
|------|--------|
| **`/plugin-manager:adopt`** | 把你在某專案 `.claude/skills/` 隨手寫的自製 skill，**搬進 monorepo**（move + 原位 symlink，真身永遠一份，零不同步）。agent 整包納管見 `scripts/adopt-agents.js` |
| **`/plugin-manager:update`** | 改既有自製 plugin 後 **bump 版本號**（plugin.json + registry 同步），讓更新能被偵測 |
| **`/plugin-manager:publish`** | **一鍵 commit + push 整個 monorepo**。不管改了 1 個還是 50 個 plugin，只推一次 |
| **`/setup-plugins`** | **偵測當前專案**（讀 CLAUDE.md 為主訊號）→ **推薦該裝哪些 plugin**（profile / 自訂）→ 給要貼的 install 指令（venv 概念，per-project 隔離）。**不代寫 settings**——啟用宣告由 `/plugin install` 選 scope 時自己寫。含 `upgrade`（偵測落後版本）與**外部 plugin 推薦**（recommends.json，會推廣）/挑裝 |
| **`/plugin-manager:clone-env`** | 把整套環境（marketplace + plugin + 啟用狀態，含自製與第三方）**擷取快照、在新機器/新專案復現**。說「複製我的環境」即觸發 |

### 環境快照 / 復現（`/plugin-manager:clone-env`）

跟 Claude 說「複製我的環境」「環境復現」即觸發。Claude 幫你擷取快照（`export-env.js` → `env-snapshot.json`）並產生復現指令鏈（`restore-env.js`，`--enabled-only` 只列啟用中的）；最後實際安裝那幾步 `/plugin marketplace add` + `install` 由你自己貼（Claude 不能代執行 /plugin）。自製 monorepo 在新機器會提示先 clone + init。

### 核心概念

1. **monorepo（所有自製 plugin 的家）**：一個 repo、一個 marketplace、`plugins/` 底下放全部。
2. **move + symlink（真身一份）**：adopt 把 skill 真身搬進 monorepo，原專案留 symlink 指回——改任一邊都是改同一份檔，永不打架。
3. **兩份清單，隱私分明**：
   - **registry**（`~/.claude/plugin-manager/`，家目錄、**不進 git**）的 `selfMade`：你自製 plugin 的版本 / dirty（個人本機狀態，由 adopt/bump/publish-finalize 維護）。
   - **recommends.json**（plugin 內、**進 git、會推廣**）：你精選的**別人做的**外部 plugin（只記來源/用途/tag，不複製別人程式碼）。別人裝你的 repo 就看到，`/setup-plugins` 時可挑裝。

詳細教學（含完整實例）：**`plugins/plugin-manager/docs/使用教學.html`**
工作規範（真身單一份、改 skill 必發布、commit message 註明 skill、版本號慣例、互動指令邊界）：**`plugins/plugin-manager/CONVENTIONS.md`**

---

## 安裝

```text
/plugin marketplace add abs1294/fulin-claude-plugins
/plugin install plugin-manager@fulin-plugins
/reload-plugins
```

裝好後 `/plugin-manager:adopt`、`:update`、`:publish`、`/setup-plugins` 就會出現。其他 plugin（見下）依需要再各自 `/plugin install`。

**首次初始化（只做一次）**：所有指令靠 `~/.claude/plugin-manager/config.json` 定位你的 monorepo，第一次要先建好：

```bash
node "<你 clone 的 repo>/plugins/plugin-manager/scripts/init.js" <owner> <github-owner/repo>
```

monorepo 路徑自動偵測（從腳本位置回推），不必手填。它建好 `config.json` + `registry.json`（已存在不覆蓋）。這個固定路徑的 config 就是「任何 session、任何專案」都能定位 monorepo 的錨點。

> Claude Code **沒有** `/plugin update` 子指令。更新已裝 plugin 的正解：`/plugin marketplace update fulin-plugins` 刷新 → `/plugin uninstall <name>@fulin-plugins` + `/plugin install <name>@fulin-plugins` 重裝（或在 `/plugin` UI 開 Enable auto-update）。

**前置依賴**：plugin-manager 需 Node.js；狀態存本機 `~/.claude/plugin-manager/`（`config.json` + `registry.json`，不進 plugin、不進 git）。

---

## 本 repo 也帶的其他自製 plugin

這些是被 plugin-manager 管理的一般 plugin，依需要各自安裝：

| plugin | 用途 | 前置依賴 |
|--------|------|----------|
| **git-commit** | 並行審查模式的 Git Commit 流程（使用者確認 message + Codex + code-reviewer 三軌）→ commit → push | Codex CLI（缺則該軌略過） |
| **qa-webwright** | webwright 驅動的 QA 測試框架：QA Agent 設計測試計畫，主 Agent code-as-action 執行 + 截圖自我驗證 | webwright plugin + `playwright install firefox`，詳 `plugins/qa-webwright/README.md` |
| **delaylocal** | 把 prompt 排程到 5h quota 重置後自動在本機無人值守執行，完成發 LINE 通知 | Node.js；LINE 憑證放本機（不進 git），詳 `plugins/delaylocal/README.md` |
| **supplier-agents** | Winbond 供應商平台 DDD 開發 agent 組（backend-architect/engineer、frontend-engineer、code-reviewer、qa-engineer，共 5 個 agent） | 無（裝了 plugin 即自動載入其 agents） |
| **red-blue-review** | 中文紅藍對抗：對任何命題（決策/架構/程式碼/plugin配置/文件…）做 Red 攻→Blue 守→收斂的對抗式壓力測試，產出強化版 + go/no-go。說「紅藍對抗 X」即觸發 | 無 |
| **self-heal** | 降低並自動接力 tool call 失敗：每輪注入 XML 收尾提醒 hook + self-heal scheduler 接力規約（卡住自己續、完成則終止） | 無 |
| **cc-statusline** | 資訊密度高的 status line：目錄/repo/model/成本/用量/quota/agents/skills/memory+MCP/近期編輯/歷史多欄顯示，含寬字對齊；可用 `/cc-statusline-rows` 逐列開關。**裝完需手動在 `settings.json` 加 `statusLine` 指向腳本**（plugin 無法自動設 status line，官方限制），詳 `plugins/cc-statusline/README.md` | Node.js |

---

## 結構

```
.claude-plugin/marketplace.json     列出下列 plugin（source: ./plugins/<name>）
plugins/
├─ plugin-manager/                   ⭐ 主角：自製 plugin 集中管理器
│   ├─ skills/      adopt · update · publish · setup-plugins
│   ├─ profiles.json  可推廣的 plugin 套餐 + 偵測規則（detect）
│   ├─ scripts/     init · adopt · adopt-agents · bump-version · upgrade-check · publish-status · publish-finalize · register-external · export-env · restore-env
│   ├─ docs/        使用教學.html
│   └─ CONVENTIONS.md
├─ git-commit/                       並行審查 Git Commit 流程
├─ qa-webwright/                     QA 測試框架 plugin
├─ delaylocal/                       排程 plugin（LINE 憑證以 .gitignore 排除）
├─ supplier-agents/                  供應商平台 DDD 開發 agent 組（5 個 agent）
├─ red-blue-review/                  中文紅藍對抗（多面向對抗式審查）
├─ self-heal/                        tool call 失敗自動接力（XML 收尾 hook + scheduler）
└─ cc-statusline/                    高資訊密度 status line（需手動接 settings.json）
```

## 開發模式（C 折衷）

- 所有 skill 真身只有 monorepo 一份；各專案/user-scope 原位以 symlink/junction 指回。
- 開發期靠 symlink 即時迭代（改 = 改 monorepo 真身，免發布即生效），**一個段落完成就 `/plugin-manager:publish`**。
- 改了任何 skill 都要記得 publish 到 remote，否則 monorepo 落後本機。完整規範見 `plugins/plugin-manager/CONVENTIONS.md`。

> **維護提醒**：新增/移除 skill 或 plugin 時，務必同步更新本 README 的表與「結構」，並隨 monorepo 一起 publish；commit message 須註明改了哪個 skill。

## 作者

fulin
