---
name: setup-plugins
description: 為「當前工作目錄」選擇並啟用一組 Claude Code plugin 組合（venv 概念），含推薦/挑裝別人做的外部 plugin。當使用者輸入 /setup-plugins、說「設定這專案的 plugin」、「這目錄要裝哪些 plugin」、「套用 plugin 組合 / profile」、「推薦外部 plugin」、「登記外部 plugin」、「把別人的 plugin 加進推薦」時觸發。把選定組合寫進該目錄 .claude/settings.json 的 enabledPlugins（per-project 覆寫），不污染 user 全域；外部 plugin 推薦寫進 plugin 內的 recommends.json（進 git、會推廣）。
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

4.5. **推薦的外部 plugin 挑裝**（別人做的 plugin）——**這步固定要問**（不論清單有無內容）：
   讀推薦清單 `<monorepo>/plugins/plugin-manager/recommends.json` 的 `recommends`（monorepo 路徑取自 `~/.claude/plugin-manager/config.json`）。
   - **若清單為空**：仍要告知使用者「目前沒有推薦的外部 plugin。要加的話跟我說『推薦外部 plugin …』即可（見下方子流程）」，讓使用者知道有這功能。
   - **若清單有內容**，依數量決定怎麼問：
     - **少（≤ 約 8 筆）**：直接用 AskUserQuestion（multiSelect）列出每筆（`name@marketplace` — note）讓使用者挑。
     - **多（> 約 8 筆）且有 tags**：**先**用 AskUserQuestion 問「要哪個面向」（選項 = 清單裡出現過的所有 tag，可多選），**再**只把選中 tag 的那些 plugin 列出來讓使用者勾。避免一長串勾選。
     - 多但無 tags：仍直接列（並可建議使用者之後給推薦補 tag）。
   - 顯示每筆時**務必帶 note**（用途描述），讓使用者認得出每個 plugin 是做什麼的。
   - 挑中的併進下一步的 enabledPlugins，並在步驟 6 一起提示其 `marketplace add` 來源（取自該筆的 `source`）。

5. **寫入設定**：把選定 profile 的 `enable`（或自訂勾選結果，含 4.5 挑中的推薦外部 plugin）合併進 `<cwd>/.claude/settings.json` 的 `enabledPlugins`。
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
   - 若有 `⚠ dirty`（registry 最新版尚未 publish）→ 提醒**得先 `/plugin-manager:publish`**，否則使用者刷新 marketplace 後也抓不到新版。

3. **給更新指令請使用者自貼**（Claude 不能代執行 /plugin；**Claude Code 沒有 `/plugin update` 子指令**，更新靠 marketplace update 刷新 + uninstall/install 重裝）：
   ```
   /plugin marketplace update fulin-plugins
   /plugin uninstall <name>@fulin-plugins      # 每個落後的自製 plugin：兩行各自貼，
   /plugin install <name>@fulin-plugins        # /plugin 不是 shell，不能用 && 串接
   /reload-plugins
   ```
   或：在 `/plugin` 互動 UI 的 Marketplaces tab 對 `fulin-plugins` 開 **Enable auto-update**，下次啟動自動更新。

4. **推薦的外部 plugin**：若有已啟用的推薦外部 plugin，可一併提示 `/plugin marketplace update <其 marketplace>` 刷新（外部 plugin 的更新由其上游 marketplace 管，不在本系統的版本追蹤內）。

**為什麼只偵測不代更新**：專案 settings 的 enabledPlugins 只存 `name@marketplace`、不帶版本號，Claude Code 裝的是 cache 那份；且 `/plugin` 系列是互動指令。所以 upgrade 只做「偵測 + 列出 + 給指令」。

## 子流程：推薦外部 plugin（別人做的）

當使用者說「推薦外部 plugin」、「登記外部 plugin」、「把別人的 plugin 加進推薦」時走這條。把「別人做的 plugin」的**來源 + 用途 + tag** 登記進**推薦清單** `plugins/plugin-manager/recommends.json`（在 plugin 內、隨 monorepo 進 git）——**會被 publish 推廣，別人裝你的 repo 就看得到你精選的清單**。**不複製別人的程式碼進 monorepo**（尊重它住在別人的 repo）。

1. **收集資訊**：
   - `name@marketplace`、取得來源 `source`（`/plugin marketplace add` 的參數，如 `owner/repo`、GitHub URL）。
   - **note（必填）**：一句話說明這 plugin 做什麼——之後翻清單 / setup 挑裝時靠它認出來。
   - tag（建議）：面向標籤（如 `backend`、`frontend`、`ai`、`test`），供 setup 按面向分組挑，清單多時不必一長串勾。

2. **跑登記腳本**（純檔案操作，recommends 一律由腳本寫、不手編 JSON）：
   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/register-external.js" <name@marketplace> <source> <note> --tags a,b
   ```
   - note 必填（缺會 die）；已存在同 key 會更新（覆蓋）。
   - 移除：`node "${CLAUDE_PLUGIN_ROOT}/scripts/register-external.js" --remove <name@marketplace>`

3. **提示兩件事**：
   - 推薦寫進 recommends.json 後**要 `/plugin-manager:publish`** 才會推上去讓別人看到。
   - 登記/推薦只是進清單，**不會自動安裝**。要實際裝需自貼 `/plugin marketplace add <source>` + `/plugin install <name@marketplace>` + `/reload-plugins`，或下次 `/setup-plugins` 挑裝。

## 重要限制（要誠實告知）

- Claude **不能**代為執行 `/plugin install` / `/plugin marketplace add` / `/reload-plugins`——這些是互動指令，必須使用者自己在輸入框打。Claude 只負責「寫好 enabledPlugins 設定 + 給要貼的指令」。
- 寫進 project settings 的是「啟用宣告」；plugin 本體仍需已 install 過（在 cache 裡）。未 install 的會在 reload 時報錯。
- 若當前目錄是 git repo，project settings.json 會被版控追蹤（影響協作者）；非 git 目錄則只影響自己。寫入前若偵測到是 git repo 且含第三方 plugin，提醒使用者。
