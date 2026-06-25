---
name: plugin-manager-update
description: 維護一個既有自製 plugin 並 bump 版本號。當使用者說 /plugin-manager:update、「改自製 plugin」、「更新某個 plugin」、「bump plugin 版本」、「plugin 改完要發版」時觸發。協助修改 plugin 的 skill/hook 內容後，bump plugin.json 的 version 並同步 registry，讓其他專案刷新 marketplace 後能抓到新版。
---

# plugin-manager:update — 維護既有自製 plugin + bump 版本

維護 monorepo 裡既有的自製 plugin（與 `/plugin-manager:adopt`「搬既有 skill」相對）。核心是 **bump 版本號**——因為 Claude Code 靠 plugin.json 的 `version` 判斷有無更新，改了內容卻不 bump，其他專案就算刷新 marketplace 也抓不到新版。

## 何時用
- 改了某個自製 plugin 的 skill/hook/script 內容，要正式發一版。
- 只想 bump 版本（內容已改好）。

## 執行步驟

1. **確認要更新哪個 plugin**：使用者指明 plugin 名（= monorepo `plugins/<name>`）。若沒指明，讀 `~/.claude/plugin-manager/registry.json` 的 `selfMade` 列出供選。

2. **協助修改內容**（這部分是一般檔案編輯，主 AI 直接處理）：
   - 真身在 monorepo `plugins/<name>/`（**不是** cache）。改 SKILL.md、hooks、scripts 都改這裡。
   - 確認沒改錯到 cache（`~/.claude/plugins/cache/...`）——那是唯讀快取，publish + 重裝（uninstall + install）才會更新。

3. **決定 bump 等級**：詢問使用者 patch / minor / major：
   - `patch`：修字、修 bug、小調整（0.1.0 → 0.1.1）
   - `minor`：加功能、加新指令但相容（0.1.0 → 0.2.0）
   - `major`：破壞性變更（0.1.0 → 1.0.0）

4. **跑 bump 腳本**（純檔案操作）：
   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/bump-version.js" <name> <patch|minor|major>
   ```
   - 腳本會：算新版號 → 寫回 `plugins/<name>/.claude-plugin/plugin.json` 的 version → 同步 registry `selfMade[<name>].version` 與 `dirty:true`。
   - 輸出會印 `舊版 → 新版`，呈現給使用者確認。

5. **提示發布**：bump 後內容與版本都已就緒但**尚未推上 git**。提示用 `/plugin-manager:publish` 發布。

## 重要限制（誠實告知）
- **version 只設在 plugin.json**，不在 marketplace.json 加 version 欄。兩處都設會衝突，Claude Code 以 plugin.json 為準。
- bump 後該 plugin `dirty:true`（已改未推），publish 後才清。
- publish 只推 monorepo，**不會自動讓已安裝該 plugin 的專案更新**——各專案需自己刷新：`/plugin marketplace update fulin-plugins` 後 `/plugin uninstall <name>@fulin-plugins`、再 `/plugin install <name>@fulin-plugins`（兩行各自貼，/plugin 不是 shell 不能 && 串接；或開 auto-update）。**Claude Code 沒有 `/plugin update` 子指令**，且 `/plugin` 系列是互動指令 Claude 不能代執行。
- 改的是 monorepo 真身；若不慎改到 cache，那份會在下次重裝（uninstall + install）時被覆蓋。
