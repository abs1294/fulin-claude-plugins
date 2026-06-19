# plugin-manager 工作規範（CONVENTIONS）

本檔是 fulin plugin monorepo 的**權威工作規範總表**。adopt / new / publish 三個 SKILL.md 的對應步驟只放簡引，細節以本檔為準。改規範改這裡，並同步三個 SKILL.md 的簡引。

monorepo 路徑與 repo 從 `~/.claude/plugin-manager/config.json` 讀（owner=fulin，repo=abs1294/fulin-claude-plugins，PRIVATE）。

---

## 規則 1 — 真身單一份（C 折衷模式）

- 任何 skill 的真身**只有 monorepo 一份**；各專案 / `~/.claude/skills/` 原位以 **symlink / junction** 指回 monorepo，不留第二份實體。
- **adopt 一律**：move 真身進 monorepo → 原位建 symlink。若發現某 skill 在 monorepo 與專案各有一份**獨立實體**（非 symlink），是歷史遺留的「兩份不同步」，應收斂：先 diff 兩份內容 → 確認後刪實體那份 → 原位改 symlink 指回 monorepo。
- **C 折衷**：開發期靠 symlink 即時迭代（改 symlink = 改 monorepo 真身，免發布即生效），**一個段落完成就 publish**。兼顧迭代速度與版本追蹤。

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
- adopt（新增 plugin）、new（新增 plugin）做完都要做這步；publish 發布前若 status 含新增/刪除 `plugins/<name>/`，要先確認 README 已同步再發。
- README 隨該次變更一起 publish。

---

## 版本號慣例

- bump 只設在各 plugin 的 `plugin.json` 的 `version`，**不在 marketplace.json 加 version 欄**（兩處衝突時 Claude Code 以 plugin.json 為準）。用 `scripts/bump-version.js`。
- 改了某 plugin 的內容（skill/hook/script）→ bump 該 plugin（patch/minor/major）。
- 改 repo 根層級文件（README / 本檔 / .gitignore 等，在 `plugins/` 之外）→ **不綁任何 plugin 版本**，不 bump。

## 互動指令邊界（誠實限制）

- Claude **不能**代執行 `/plugin install`、`/plugin uninstall`、`/plugin marketplace add/update`、`/reload-plugins`——這些是互動指令，一律「產生指令讓使用者貼」。只有 git 與檔案操作用 Bash 直接做。
- **Claude Code 沒有 `/plugin update` 子指令**。更新已裝 plugin 的正解：`/plugin marketplace update fulin-plugins` 刷新 → `/plugin uninstall <name>@fulin-plugins` + `/plugin install <name>@fulin-plugins` 重裝（或在 `/plugin` UI 開 Enable auto-update）。
- registry 存家目錄 `~/.claude/plugin-manager/`，不存 plugin 內（plugin 更新會覆蓋）。
