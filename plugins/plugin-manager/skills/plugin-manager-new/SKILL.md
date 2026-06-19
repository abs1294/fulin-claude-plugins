---
name: plugin-manager-new
description: 在 monorepo 從零建立一個全新的自製 plugin 骨架。當使用者說 /plugin-manager:new、「新增一個 plugin」、「建一個新 plugin」、「從零做 plugin」時觸發。建立 plugin.json + skills/hooks/commands 骨架、更新 marketplace 與 registry。與 adopt（搬既有 skill）相對，這是從零建空骨架。
---

# plugin-manager:new — 從零建立自製 plugin

在 monorepo 直接長出一個全新 plugin 的骨架。與 `/plugin-manager:adopt`（把既有 skill 搬進來）相對，這是「從零建空殼」，建完再填內容。

## 何時用
- 要做一個全新的自製 plugin，內容還沒寫。
- 想先有正確的 monorepo 結構（plugin.json + 元件骨架 + marketplace/registry 登記）再開始填。

## 執行步驟

1. **收集資訊**：
   - plugin 名稱（= monorepo `plugins/<name>`，建議 kebab-case）。
   - 一句描述（會進 plugin.json 與 marketplace）。
   - 要含哪些元件：`skills` / `hooks` / `commands`（可多選，預設只建 skills）。

2. **跑 new 腳本**（純檔案操作，不需 claude CLI）：
   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/new.js" <name> "<description>" --with skills,hooks,commands
   ```
   - `--with` 省略時只建 skills。
   - 腳本會：檢查不重名 → 建 plugin.json（version 0.1.0）→ 建選定元件骨架 → 更新 marketplace.json → 更新 registry（native, dirty:true）。
   - 若 monorepo 已有同名 plugin，腳本會中止並要求改名。

3. **填內容**（一般檔案編輯，主 AI 處理）：
   - `skills/<name>/SKILL.md`：補 frontmatter 的中文觸發詞、執行步驟、誠實限制。
   - `hooks/hooks.json`：若有 hook，補事件與指令（指令用 `${CLAUDE_PLUGIN_ROOT}` 引用以可攜）。
   - `commands/<name>.md`：若有 command，補內容。

4. **更新 monorepo README（規則 4 — 務必執行）**：新增 plugin 後，**必須**同步更新 monorepo 根 `README.md`：plugin 列表加一列（plugin 名 / 用途 / 指令）、「結構」樹補上新目錄。README 隨本次一起 publish。**新增/移除任何 plugin 或 skill 都要做這步**，否則 README 與實際 plugin 不符。

5. **提示下一步**：
   - 用 `/plugin-manager:publish` 把 monorepo 推上 git。
   - 要在當前 session 啟用需 `/plugin install <name>@fulin-plugins`（互動指令，使用者自貼）。

## 重要限制（誠實告知）
- 腳本只建骨架，**不會自動 install/enable**（install 是互動指令 /plugin，Claude 不能代執行）。
- 新 plugin 初始 `version 0.1.0`、`dirty:true`，publish 後才清 dirty。
- skill 的 frontmatter `description` 是觸發判斷依據，骨架只給範本，**務必補上具體中文觸發詞**否則不會被觸發。
