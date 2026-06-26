# plugin-manager 工作規範（CONVENTIONS）

本檔是 fulin plugin monorepo 的**權威工作規範總表**。adopt / publish 等 SKILL.md 的對應步驟只放簡引，細節以本檔為準。改規範改這裡，並同步各 SKILL.md 的簡引。

monorepo 路徑與 repo 從 `~/.claude/plugin-manager/config.json` 讀（owner=fulin，repo=abs1294/fulin-claude-plugins，PRIVATE）。

---

## 規則 1 — 真身單一份（C 折衷模式）

- 任何 skill 的真身**只有 monorepo 一份**；各專案 / `~/.claude/skills/` 原位以 **symlink / junction** 指回 monorepo，不留第二份實體。
- **adopt 一律**：move 真身進 monorepo → 原位建 symlink。若發現某 skill 在 monorepo 與專案各有一份**獨立實體**（非 symlink），是歷史遺留的「兩份不同步」，應收斂：先 diff 兩份內容 → 確認後刪實體那份 → 原位改 symlink 指回 monorepo。
- **C 折衷**：開發期靠 symlink 即時迭代（改 symlink = 改 monorepo 真身，免發布即生效），**一個段落完成就 publish**。兼顧迭代速度與版本追蹤。
- **agent 納管**（`scripts/adopt-agents.js`）：agent 是**單檔**、Claude Code 不支援 agent 目錄結構，而 Windows 非管理員無法對單檔建 symlink、junction 只能對目錄——所以 agent **整個 `.claude/agents` 目錄一起納管**：move 進 `plugins/<name>/agents/`，原位建**整包目錄 junction**（一個 junction 帶走目錄內全部 agent，免管理員權限）。粒度是「一組 agent = 一個 plugin」，非「一 agent 一 plugin」。

## 規則 2 — 改 skill 必發布

> 只要改動了任何已納管 skill（monorepo 真身或其 symlink），完成後**必須主動提醒使用者用 `/plugin-manager:publish` 推上 remote monorepo**，不可只停在本機生效。

- 因 symlink 改了本機立刻生效、極易忘記推遠端，導致 monorepo 落後本機。
- 對「改完 skill 卻沒走 publish 就結束對話」也成立——結束前要提醒尚有未發布的 skill 變更。

## 規則 3 — commit message 註明 skill（版本追蹤）

commit message **必須註明本次改了哪一個 / 哪些 skill**。格式：

```
<動作>: <skill 名> — <一句變更摘要>
```

- 動作詞：`Add`（新 skill/plugin）/ `Update`（改既有）/ `Fix`（修錯）。
- 範例：
  - `Update: delaylocal skill — 修正 LINE 通知逾時重試`
  - `Update: plugin-manager — adopt/publish SKILL 補真身單一份原則與發布紀律`
  - `Update: git-commit 補正式描述、setup-plugins 修 upgrade 指令`
- 一律寫**現行狀態的變更**，不寫遷移敘事；**不得加任何 AI 署名**。
- 純設定/文件改動（非 skill 內容）可用 `Update: monorepo config — …` 或 `Update: monorepo README — …`。

## 規則 4 — 新增/移除 plugin 或 skill 必更新 README

- 新增/移除任何 **plugin 或 skill** 時，**必須**同步更新 monorepo 根 `README.md`：plugin 列表（plugin 名 / 用途 / 指令）與「結構」樹。
- adopt（新增 plugin）做完都要做這步；publish 發布前若 status 含新增/刪除 `plugins/<name>/`，要先確認 README 已同步再發。
- README 隨該次變更一起 publish。

---

## 版本號慣例

- bump 只設在各 plugin 的 `plugin.json` 的 `version`，**不在 marketplace.json 加 version 欄**（兩處衝突時 Claude Code 以 plugin.json 為準）。用 `scripts/bump-version.js`。
- 改了某 plugin 的內容（skill/hook/script）→ bump 該 plugin（patch/minor/major）。
- 改 repo 根層級文件（README / 本檔 / .gitignore 等，在 `plugins/` 之外）→ **不綁任何 plugin 版本**，不 bump。
- **bump plugin-manager 後，務必同步 `docs/使用教學.html` 的版本號**（header 的 `<span class="pill">vX.Y.Z</span>` 與 footer 的 `plugin-manager vX.Y.Z`）——HTML 是靜態檔、不會自動帶版號，漏改就會脫節（紅藍稽核已抓過此坑）。

## 互動指令邊界（誠實限制）

- Claude **不能**代執行 `/plugin install`、`/plugin uninstall`、`/plugin marketplace add/update`、`/reload-plugins`——這些是互動指令，一律「產生指令讓使用者貼」。只有 git 與檔案操作用 Bash 直接做。
- **Claude Code 沒有 `/plugin update` 子指令**。更新已裝 plugin 的正解：`/plugin marketplace update fulin-plugins` 刷新 → `/plugin uninstall <name>@fulin-plugins` + `/plugin install <name>@fulin-plugins` 重裝（或在 `/plugin` UI 開 Enable auto-update）。
- registry 存家目錄 `~/.claude/plugin-manager/`，不存 plugin 內（plugin 更新會覆蓋）。

## 外部 plugin 推薦清單（recommends.json）

兩個不同的東西，存放位置與隱私性刻意分開：

| | 存哪 | 進 git | 內容 |
|---|---|---|---|
| `registry.json` 的 `selfMade` | 家目錄 `~/.claude/plugin-manager/` | ❌ 私人 | 你自製 plugin 的版本/dirty（本機狀態） |
| `recommends.json` | plugin 內 `plugins/plugin-manager/` | ✅ 推廣 | 你精選的**別人做的**外部 plugin（來源/用途/tag） |

- **recommends.json 在 plugin 內、隨 monorepo publish**——別人裝你的 repo 就看到你精選的外部 plugin 清單（這是刻意，目的是推廣）。
- 只記**來源 + 用途 + tag**（`name@marketplace` → `{marketplace, source, note, tags}`），**不複製別人的程式碼進 monorepo**（尊重它住在別人的 repo、跟著上游更新）。
- 登記/移除一律用 `scripts/register-external.js`（不手編）；**note 必填**（之後要靠它認出 plugin 用途）。`/setup-plugins` 讀 recommends.json 列給使用者挑裝（清單多時按 tag 分組），產生 `marketplace add` + `install` 指令。
- 外部 plugin 的**版本更新由其上游 marketplace 管**，本系統不追蹤其版本。
- 改 recommends.json 後要 `/plugin-manager:publish` 才會推上去讓別人看到。

## 環境快照 / 復現（export-env / restore-env）

- `scripts/export-env.js`：讀 Claude Code 官方記錄（`known_marketplaces.json` + `installed_plugins.json` + settings 的 enabledPlugins）產出 `env-snapshot.json`，含三類：`marketplaces`（來源 repo）、`plugins`（版本/scope/user 層 enabled）、`projects`（各專案 per-project enabledPlugins，專案來源取自 installed 的 project scope projectPath，**key 存 basename 脫敏**）。**預設寫進 plugin 內** `plugins/plugin-manager/env-snapshot.json`（隨 git/publish）。
- **為什麼快照放 plugin 內（與 registry 相反）**：registry 是「本機未推的變動狀態」，被 cache 覆蓋會丟資料故存家目錄；快照則是「export 完即 publish、權威版本就是 git 那版」，放 plugin 內隨 git 走——新機 `/plugin install plugin-manager` 時快照進 cache，restore 從 `CLAUDE_PLUGIN_ROOT` 讀得到，免手動帶檔。cache 被 install/update 更新成 git 版正是要的（不是 bug）。
- `scripts/restore-env.js`：吃快照產生「在新環境要自己貼的」`marketplace add` + `install` 指令鏈（Claude 不能代執行 /plugin）。`--enabled-only` 只列啟用中的（同機換專案用）。找快照順序：參數 > `CLAUDE_PLUGIN_ROOT` > monorepo 內 plugin 目錄 > cwd。
- 涵蓋自製 + 第三方 plugin（真正的「一模一樣」）；但第三方能否裝起來取決於其上游 marketplace 是否可及，自製的（在本 repo）一定可裝。
- env-snapshot.json 含「你啟用了哪些 plugin」且隨 repo 進 git——repo 是 PRIVATE 故只自己看得到（換新機自用的場景合理）。若要散佈給別人或不想入 git，export 時用參數指定 monorepo 外的路徑。
