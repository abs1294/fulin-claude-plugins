---
name: setup-plugins
description: 為「當前工作目錄」偵測並推薦該裝哪些 Claude Code plugin（venv 概念，per-project 隔離），給出要貼的 install 指令——不直接寫 settings（啟用宣告由 /plugin install 選 scope 時自己寫）。當使用者輸入 /setup-plugins、說「設定這專案的 plugin」、「這目錄要裝哪些 plugin」、「套用 plugin 組合 / profile」、「推薦這專案的 plugin」、「推薦外部 plugin」、「登記外部 plugin」時觸發。也含子流程 upgrade（偵測自製 plugin 落後版）與外部 plugin 推薦登記（recommends.json，進 git、會推廣）。
---

# Setup Plugins（per-project plugin 偵測與推薦）

讓使用者為「當前目錄」按需啟用 plugin，像 Python venv 那樣按專案隔離，避免全部塞 user scope 浪費上下文。

## 核心職責（重要 — 邊界）

setup 只做**偵測 + 推薦 + 給指令**，**不寫 settings**：

- **`/plugin install` 選 scope（project / local）時，Claude Code 會自己把 `enabledPlugins` 寫進對應 settings.json。** 這是 install 的職責，不是 setup 的。
- 所以 setup **不碰、不代寫** `<cwd>/.claude/settings.json` 的 enabledPlugins——重複寫只會打架。
- setup 的價值是：① 看專案**偵測**該裝什麼 → ② **推薦** profile / plugin 組合 → ③ 列出**要貼的 install 指令**（提醒選 project scope）。寫入交給 install。

## 背景知識

- plugin「安裝」是全域一份 cache（`~/.claude/plugins/cache/`），但「**啟用 scope**」per-scope：`/plugin install` 互動 UI（`/plugin` → Discover → 選 plugin → Enter）可選 **user**（全域）/ **project**（寫 `<cwd>/.claude/settings.json`，團隊共享）/ **local**（寫 `settings.local.json`，只自己、不進 git）。
- 全域常駐（不需 profile 重複處理）：`claude-mem`、`codex`、`example-skills`。
- **profile 來源有兩份，讀時合併**：
  - 基底（可推廣、進 git）：`<monorepo>/plugins/plugin-manager/profiles.json`（monorepo 路徑取自 `~/.claude/plugin-manager/config.json`）——通用 profile（dotnet/frontend/full…）+ 各自的 `detect` 偵測規則。
  - 覆寫（本機、不進 git）：`~/.claude/plugin-profiles.json`——使用者個人 / 公司專屬 profile（如 supplier）。
  - **合併規則**：以基底為底，本機覆寫——同名 profile 本機贏，本機獨有的 profile 保留。

## 執行步驟（Claude 依此操作）

1. **確認當前工作目錄**（cwd）。

2. **讀 profile 清單（合併兩份）**：Read `<monorepo>/plugins/plugin-manager/profiles.json`（基底）與 `~/.claude/plugin-profiles.json`（本機覆寫），合併後取每個 profile 的 key + description + detect。
   - **fallback**：config.json 不存在或 monorepo 路徑無效（如剛裝 plugin-manager 還沒 `init`）→ 略過基底，只用本機那份；兩份都讀不到 → 告知使用者「找不到 profile 定義，請先 `init` 或建立 `~/.claude/plugin-profiles.json`」，不中斷報錯。

3. **讀當前目錄現況**：Read `<cwd>/.claude/settings.json` 與 `<cwd>/.claude/settings.local.json`（可能不存在）。列出目前已啟用了哪些 plugin（避免推薦重複）。

4. **偵測專案、推薦 profile**（這次的核心）。偵測訊號**以 CLAUDE.md 為主**，副檔名為輔：
   - **主訊號**：Read `<cwd>/CLAUDE.md`（+ 上層目錄的 CLAUDE.md）、`README.md`——萃取專案自己宣告的架構/技術棧/agent 需求。這是最高保真的訊號（專案作者親口說的意圖），優先於猜副檔名。
   - **身分訊號**：git remote（`git -C <cwd> remote -v`）、cwd 路徑。
   - **輔證**：Glob 副檔名/結構（`*.csproj`/`*.sln`/`*.vue`/`*.py`/`go.mod`…）、`package.json` 的 deps。涵蓋非 .NET/Vue 的專案（Python/Go/純文件…）。
   - **語意對應**：拿上面萃取到的，對照各 profile 的 `detect` 提示（`claudeMdHints` 語意關鍵詞 / `files` / `deps` / `pathHint`），**語意判斷**最貼的 profile（不是字面 exact match——detect 是提示不是硬規則）。
   - **誠實**：訊號弱或模糊（沒 CLAUDE.md/README、副檔名也認不出）→ **明說「沒把握，請你手選」**，不硬猜。

5. **用 AskUserQuestion 呈現推薦給使用者確認**：
   - **第一選項** = 偵測到的推薦 profile，標題寫成「偵測到 X → 建議套用 `<profile>`（這 N 個 plugin）」，description 列出該 profile 的 plugin。
   - 其餘選項 = 其他 profile（minimal / 其他 detect 沒中的）+「自訂（我逐一勾選）」+「取消」。
   - 偵測無把握時，不放推薦選項，直接列全部 profile 讓手選（並說明為何沒推薦）。
   - 選自訂 → 再一次 AskUserQuestion（multiSelect）列出所有 profile 涵蓋過的 plugin 逐一勾。

5.5. **推薦的外部 plugin 挑裝**（別人做的 plugin）——**這步固定要問**（不論清單有無內容）：
   讀推薦清單 `<monorepo>/plugins/plugin-manager/recommends.json` 的 `recommends`。
   - **若清單為空**：仍告知「目前沒有推薦的外部 plugin，要加跟我說『推薦外部 plugin …』」，讓使用者知道有此功能。
   - **若有內容**：少（≤ 約 8 筆）直接 AskUserQuestion（multiSelect）列出（`name@marketplace` — note）；多（> 8）且有 tags 先問面向（tag）再列選中 tag 的。顯示**務必帶 note**。

6. **產出「要裝什麼 + 怎麼裝」清單給使用者貼**（**不寫 settings**）：
   把選定 profile 的 `enable`（+ 5.5 挑中的外部 plugin）整理成一份清單，對每個 plugin 給出 install 指令，並**明確提醒選 project 或 local scope**（這樣 install 會自己把 enabledPlugins 寫進對應 settings，不需要 setup 代寫）：
   ```
   建議這個專案啟用（profile: <name>）：
     • csharp-lsp@claude-plugins-official — C# LSP
     • dotnet-skills@dotnet-skills — .NET skills 包
     ...
   逐個貼（互動 UI 選 scope = Project 或 Local，install 會自動寫進對應 settings）：
     /plugin                      # → Discover → 選該 plugin → Enter → 選 Project/Local scope
   或命令列指定 scope：
     claude plugin install csharp-lsp@claude-plugins-official --scope project
   ```
   - **不要**自己去 Edit `<cwd>/.claude/settings.json` 的 enabledPlugins——那是 install 選 scope 時做的。
   - 已啟用的（步驟 3 讀到的）不重複列。

7. **提醒前置**：
   - 非官方 marketplace（如 `dotnet-skills@dotnet-skills`）需先 `/plugin marketplace add <source>`（Claude 不能代執行 /plugin，請使用者自貼）。
   - 啟用 `csharp-lsp`/`typescript-lsp` → 對應 binary（`csharp-ls`/`typescript-language-server`）需在 PATH，否則 `/plugin` Errors tab 報 `Executable not found`。
   - 裝完執行 `/reload-plugins`（或重開 session）才生效。

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
   - 登記/推薦只是進清單，**不會自動安裝**。要實際裝需自貼 `/plugin marketplace add <source>` + `/plugin install <name@marketplace>`（選 scope）+ `/reload-plugins`，或下次 `/setup-plugins` 看推薦挑裝。

## 重要限制（要誠實告知）

- Claude **不能**代為執行 `/plugin install` / `/plugin marketplace add` / `/reload-plugins`——這些是互動指令，必須使用者自己在輸入框打。
- **setup 不寫 enabledPlugins**——啟用宣告由 `/plugin install` 選 scope（project/local）時自己寫進對應 settings.json。setup 只負責偵測、推薦、給要貼的指令。
- 寫進 project settings 的是「啟用宣告」；plugin 本體仍需已 install 過（在 cache 裡）。未 install 的會在 reload 時報錯。
- project scope（`.claude/settings.json`）會被 git 追蹤、影響協作者；只想自己用選 local scope（`settings.local.json`，不進 git）。
