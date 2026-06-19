---
name: setup-plugins
description: 為「當前工作目錄」選擇並啟用一組 Claude Code plugin 組合（venv 概念）。當使用者輸入 /setup-plugins、說「設定這專案的 plugin」、「這目錄要裝哪些 plugin」、「套用 plugin 組合 / profile」，或被 SessionStart 的 plugin-profile-check 提醒後想設定時觸發。把選定組合寫進該目錄 .claude/settings.json 的 enabledPlugins（per-project 覆寫），不污染 user 全域。
---

# Setup Plugins（per-project plugin 組合）

讓使用者為「當前目錄」按需啟用 plugin，像 Python venv 那樣按專案隔離，避免全部塞 user scope 浪費上下文。

## 背景知識

- plugin「安裝」是全域一份（cache 在 `~/.claude/plugins/cache/`），但「**啟用**」是 per-scope 的。
- 寫進「目錄/.claude/settings.json」的 `enabledPlugins` = project scope，只在該目錄樹生效，**覆寫 user 全域**。
- 全域常駐（不需 profile 重複處理）：`claude-mem`、`codex`、`example-skills`。
- profile 定義在 `~/.claude/plugin-profiles.json`。

## 執行步驟（Claude 依此操作）

1. **確認當前工作目錄**（cwd）。所有寫入都針對 `<cwd>/.claude/settings.json`。

2. **讀 profile 清單**：Read `~/.claude/plugin-profiles.json`，取出 `profiles` 的每個 key + description。

3. **讀當前目錄現況**：Read `<cwd>/.claude/settings.json`（可能不存在）。列出目前已啟用了哪些 plugin（若有）。

4. **用 AskUserQuestion 問使用者要套哪個 profile**：
   - 選項 = profiles 的 key（minimal / dotnet / frontend / supplier / full…），每項 description 用 profile 的 description。
   - 額外提供「自訂（我逐一勾選）」與「取消」。
   - 若使用者選自訂，再用一次 AskUserQuestion（multiSelect: true）列出所有 profile 涵蓋過的 plugin 讓他逐一勾。

5. **寫入設定**：把選定 profile 的 `enable`（或自訂勾選結果）合併進 `<cwd>/.claude/settings.json` 的 `enabledPlugins`。
   - **保留**該檔原有的其他 key 與原有 enabledPlugins 項目（用 Read→Edit，不要整檔覆蓋）。
   - 若檔案不存在，新建一個 `{ "enabledPlugins": { ... } }`。
   - plugin 名稱格式必須是 `name@marketplace`。

6. **檢查 marketplace 是否已知**：若選的 profile 含非官方 plugin（如 `dotnet-skills@dotnet-skills`），提醒使用者該 marketplace 需先 `/plugin marketplace add`（Claude 不能代執行 /plugin，請使用者自己貼）。

7. **檢查 LSP binary**：若啟用了 `csharp-lsp` / `typescript-lsp`，提醒對應 binary（`csharp-ls` / `typescript-language-server`）需在 PATH，否則 `/plugin` Errors tab 會報 `Executable not found`。

8. **提醒生效**：設定改了不會即時套用，請使用者執行 `/reload-plugins`（或重開 session）。

## 子流程：`/setup-plugins upgrade`（同步自製 plugin 到 registry 最新版）

當使用者說 `/setup-plugins upgrade`、「把這專案的自製 plugin 更到最新」、「plugin 升版同步」時走這條，**不是**重選 profile，而是「偵測本專案啟用的自製 plugin 是否落後 registry 最新版 + 給更新指令」。

1. **跑偵測腳本**（唯讀，不動檔案）：
   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/upgrade-check.js" [projectDir]
   ```
   - projectDir 省略時用當前目錄。
   - 腳本會：讀本專案 `.claude/settings.json` 的 enabledPlugins → 篩出屬於本 marketplace（`fulin-plugins`）的自製 plugin → 對照 registry `selfMade` 最新版 → 印出版本、dirty 狀態、與建議自貼的指令。

2. **呈現結果給使用者**：
   - 列出本專案啟用了哪些自製 plugin、各自 registry 最新版。
   - 若有 `⚠ dirty`（registry 最新版尚未 publish）→ 提醒**得先 `/plugin-manager:publish`**，否則 `/plugin update` 抓不到新版。

3. **給更新指令請使用者自貼**（Claude 不能代執行 /plugin）：
   ```
   /plugin marketplace update fulin-plugins
   /plugin update <name>@fulin-plugins      # 每個落後的自製 plugin 各一行
   /reload-plugins
   ```

4. **外部 plugin 候選**：若 registry 的 `externalCandidates` 有內容，可一併提示 `/plugin marketplace update`。

**為什麼只偵測不代更新**：專案 settings 的 enabledPlugins 只存 `name@marketplace`、不帶版本號，Claude Code 裝的是 cache 那份；且 `/plugin update` 是互動指令。所以 upgrade 只做「偵測 + 列出 + 給指令」。

## 重要限制（要誠實告知）

- Claude **不能**代為執行 `/plugin install` / `/plugin marketplace add` / `/reload-plugins`——這些是互動指令，必須使用者自己在輸入框打。Claude 只負責「寫好 enabledPlugins 設定 + 給要貼的指令」。
- 寫進 project settings 的是「啟用宣告」；plugin 本體仍需已 install 過（在 cache 裡）。未 install 的會在 reload 時報錯。
- 若當前目錄是 git repo，project settings.json 會被版控追蹤（影響協作者）；非 git 目錄則只影響自己。寫入前若偵測到是 git repo 且含第三方 plugin，提醒使用者。
