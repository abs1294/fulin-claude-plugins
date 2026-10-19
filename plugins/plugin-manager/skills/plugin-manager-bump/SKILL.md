---
name: plugin-manager-bump
description: （開發端）改完自製 plugin 後 bump 版號。當使用者說 /plugin-manager-bump、「bump 版號」、「bump plugin 版本」、「發版」、「改完 plugin 要升版」、「plugin 改完要發版」、「改自製 plugin 要出新版」時觸發。在 monorepo 改 plugin 的 skill/hook 內容後，bump plugin.json 的 version、寫 CHANGELOG 並同步 registry，publish 後其他專案刷新 marketplace 才抓得到新版。要把「這台電腦已裝的 plugin 更新到最新」是使用端的 /plugin-manager-update，不是本 skill。
---

# plugin-manager-bump — 維護既有自製 plugin + bump 版本（開發端）

維護 monorepo 裡既有的自製 plugin（與 `/plugin-manager-adopt`「搬既有 skill」相對）。核心是 **bump 版本號**——因為 Claude Code 靠 plugin.json 的 `version` 判斷有無更新，改了內容卻不 bump，其他專案就算刷新 marketplace 也抓不到新版。

## 分工
| 端 | 指令 | 做什麼 |
|---|---|---|
| 開發端 | `/plugin-manager-bump`（本 skill） | 在 monorepo 改完 plugin → bump 版號、寫 CHANGELOG |
| 開發端 | `/plugin-manager-publish` | 把 monorepo 推上 git |
| 使用端 | `/plugin-manager-update` | 把這台電腦所有專案（與 user 層）已裝的 fulin plugin 批次更新到 marketplace 最新版 |

順序：`bump` → `publish` → （各機器）`update`。

## 何時用
- 改了某個自製 plugin 的 skill/hook/script 內容，要正式發一版。
- 只想 bump 版本（內容已改好）。
- **不是**：想把已安裝的 plugin 換成新版 → 用 `/plugin-manager-update`。

## 執行步驟

1. **確認要更新哪個 plugin**：使用者指明 plugin 名（= monorepo `plugins/<name>`）。若沒指明，讀 `~/.claude/plugin-manager/registry.json` 的 `selfMade` 列出供選。

2. **協助修改內容**（這部分是一般檔案編輯，主 AI 直接處理）：
   - 真身在 monorepo `plugins/<name>/`（**不是** cache）。改 SKILL.md、hooks、scripts 都改這裡。
   - 確認沒改錯到 cache（`~/.claude/plugins/cache/...`）——那是唯讀快取，publish + 重裝（uninstall + install）才會更新。

3. **決定 bump 等級**：詢問使用者 patch / minor / major：
   - `patch`：修字、修 bug、小調整（0.1.0 → 0.1.1）
   - `minor`：加功能、加新指令但相容（0.1.0 → 0.2.0）
   - `major`：破壞性變更（0.1.0 → 1.0.0）

4. **跑 bump 腳本**（純檔案操作）。**務必帶第三參數＝這次的變更摘要**（會寫進 CHANGELOG）：
   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/bump-version.js" <name> <patch|minor|major> "<變更摘要>"
   ```
   - 腳本會：算新版號 → 寫回 `plugin.json` 的 version → 同步 registry（version + `dirty:true`）→ **在 `plugins/<name>/CHANGELOG.md` 追加一條 [Keep a Changelog](https://keepachangelog.com/) 條目**（patch→### Fixed、minor/major→### Changed，最新在上）。
   - 摘要省略時 CHANGELOG 會留「（待補變更摘要）」佔位——**應補上**，別留佔位就 publish。
   - 輸出會印 `舊版 → 新版`，呈現給使用者確認。

5. **提示發布**：bump 後內容與版本都已就緒但**尚未推上 git**。提示用 `/plugin-manager-publish` 發布。

## 重要限制（誠實告知）
- **version 只設在 plugin.json**，不在 marketplace.json 加 version 欄。兩處都設會衝突，Claude Code 以 plugin.json 為準。
- bump 後該 plugin `dirty:true`（已改未推），publish 後才清。
- publish 只推 monorepo，**不會自動讓已安裝該 plugin 的專案更新**——publish 後用 `/plugin-manager-update` 一次把這台電腦所有已裝的 fulin plugin 更新到最新；只更新單一專案也可直接跑非互動 CLI `claude plugin marketplace update fulin-plugins` → `claude plugin update <name>@fulin-plugins --scope <該安裝的 scope>`（scope 用 `claude plugin list --json` 查；project/local scope 要在該專案目錄下跑；動別的專案前先問使用者），跑完請使用者**重開 session** 才生效；或開 auto-update。互動 slash UI 的 `/plugin` 沒有 `update` 子指令，所以走 CLI。
- 改的是 monorepo 真身；若不慎改到 cache，那份會在下次重裝（uninstall + install）時被覆蓋。
