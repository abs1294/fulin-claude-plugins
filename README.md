# fulin-plugins

fulin 的 Claude Code 工具集 marketplace。目前含四個獨立 plugin：

| plugin | 用途 | 指令 / skill |
|--------|------|--------------|
| **plugin-manager** | 自製 plugin 集中管理器：把散落各專案的自製 skill 納管進單一 monorepo（move+symlink，真身一份）、一鍵發布、集中 registry、版本管理、專案同步。 | `/plugin-manager:adopt`、`:new`、`:update`、`:publish`、`/setup-plugins`（含 `upgrade`） |
| **git-commit** | 並行審查模式的 Git Commit 流程：Stage → 並行三軌（使用者確認 message + Codex 審查 + code-reviewer 審查）→ Commit → Push。 | `git-commit` skill |
| **qa-webwright** | webwright 驅動的 QA 測試框架：QA Agent 設計測試計畫，主 Agent 用 code-as-action 執行 + 截圖自我驗證。 | `/qa-plan`、`/qa-run` |
| **delaylocal** | 把 prompt 排程到 5h quota 重置後，自動在本機無人值守執行，完成發 LINE 通知。 | `delaylocal` skill |

> **維護提醒**：新增/移除 skill 或 plugin 時，**務必同步更新上表與下方「結構」**，並隨 monorepo 一起 publish。commit message 須註明改了哪個 skill（見 plugin-manager 的 publish 規範）。

## 安裝

先加入這個 marketplace：

```text
/plugin marketplace add abs1294/fulin-claude-plugins
```

再依需要安裝 plugin（marketplace 名是 `fulin-plugins`）：

```text
/plugin install plugin-manager@fulin-plugins
/plugin install git-commit@fulin-plugins
/plugin install qa-webwright@fulin-plugins
/plugin install delaylocal@fulin-plugins
```

安裝後**重開一個 Claude Code session**（plugin 在 session 啟動時載入）。

> Claude Code **沒有** `/plugin update` 子指令。更新已裝 plugin 的正解：`/plugin marketplace update fulin-plugins` 刷新索引 → `/plugin uninstall <name>@fulin-plugins` + `/plugin install <name>@fulin-plugins` 重裝（或在 `/plugin` UI 的 Marketplaces tab 開 Enable auto-update）。

## 各 plugin 的前置依賴

- **plugin-manager**：需 Node.js；狀態存本機 `~/.claude/plugin-manager/`（`config.json` + `registry.json`，不進 plugin、不進 git）。詳見 `plugins/plugin-manager/docs/使用教學.html`。
- **git-commit**：依賴 Codex CLI（並行審查的一軌）；無 Codex 時該軌略過。
- **qa-webwright**：需先裝 webwright plugin（`/plugin install webwright@webwright`）+ `playwright install firefox`。詳見 `plugins/qa-webwright/README.md`。
- **delaylocal**：需 Node.js；LINE 憑證放本機 `notify-line.config.json` 或環境變數（**不進 git**，已由 `.gitignore` 排除）。詳見 `plugins/delaylocal/README.md`。

## 結構

```
.claude-plugin/marketplace.json     列出下列 plugin（source: ./plugins/<name>）
plugins/
├─ plugin-manager/                   自製 plugin 集中管理器
│   ├─ skills/  adopt · new · update · publish · setup-plugins
│   ├─ scripts/ adopt · new · bump-version · upgrade-check · publish-status
│   └─ docs/    使用教學.html
├─ git-commit/                       並行審查 Git Commit 流程
├─ qa-webwright/                     QA 測試框架 plugin
└─ delaylocal/                       排程 plugin（LINE 憑證以 .gitignore 排除）
```

## 開發模式（C 折衷）

- 所有 skill 真身只有 monorepo 一份；各專案/user-scope 原位以 symlink/junction 指回。
- 開發期靠 symlink 即時迭代（改 = 改 monorepo 真身，免發布即生效），**一個段落完成就 `/plugin-manager:publish`**。
- 改了任何 skill 都要記得 publish 到 remote，否則 monorepo 落後本機。

> 完整工作規範（真身單一份、改 skill 必發布、commit message 註明 skill、更新 README、版本號慣例、互動指令邊界）見 **`plugins/plugin-manager/CONVENTIONS.md`**。

## 作者

fulin
