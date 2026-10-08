# Changelog

本檔記錄 plugin-manager 的版本變更，格式依 [Keep a Changelog](https://keepachangelog.com/)。

## [0.19.1] - 2026-10-08
### Fixed
- 會交給 Bash 執行的來源與 key 加白名單（owner/repo、https 網址、git@ 位址、本機路徑；不含空白與 shell 特殊字元；Windows 反斜線路徑印成單引號包住）：register-external、restore-env 不符時只印警告不印指令；upgrade-check 的 marketplace 名與 plugin 名只接受英數與 . _ -，不符就中止或略過，setup-plugins 規定不符的不跑、先問使用者。
- scope 不再寫死：upgrade-check 以 `claude plugin list --json` 的實際安裝紀錄決定 `--scope`（本專案的 local／project 優先，否則 user），CLI 跑不起來或查不到紀錄時才依啟用宣告所在檔推定並標「推定」；restore-env 的 install 依原環境的 scope 印 user／到專案目錄下 project|local；disable 只對 user 層印（快照的啟用狀態只記 user 層，專案層的看各專案 settings）。
- 「Claude 不能代執行 /plugin」改為正確分工：install／uninstall／update／enable／disable／marketplace add|update 由 Claude 經核可後直接跑 `claude plugin …` 非互動 CLI，只有 `/reload-plugins` 與 update 後重開 session 要使用者自己做（實測 2026-10-08：`claude plugin update` 存在、`--scope user|project|local|managed`，預設依目前目錄判斷；Claude Code 2.1.294 的 slash `/plugin` 沒有 update 子指令）。改 CONVENTIONS「互動指令邊界」節為「plugin 指令分工」、README 安裝與 Q&A、update／publish／adopt／clone-env／setup-plugins 五支 skill；upgrade-check.js 改印 `claude plugin marketplace update` + `claude plugin update <name>@<mkt> --scope <scope>`；restore-env.js 改印 `claude plugin marketplace add`／`claude plugin install … --scope <原環境的 scope>`（scope 規則見上兩條）；register-external.js、bump-version.js、export-env.js 註解與輸出同步

## [0.19.0] - 2026-09-20
### Changed
- publish 步驟 4 改走 git-commit skill 的 flow.sh，不再裸下 git commit。起因：裸 git commit 會被 PreToolUse hook block-bare-git-commit.sh 擋下——那道閘攔全部 repo 不限供應商平台，且沒有旁路，2026-09-20 實際撞過一次；而本 monorepo CLAUDE.md 第 2 條本來就要求「commit/push 一律走 git-commit skill」，舊寫法等於違反自己 repo 的規矩。實測 flow.sh 沒有 repo 白名單（resolve_repo_path 只組路徑不查清單），從供應商平台工作目錄用相對路徑 ../../fulin-claude-plugins 直接可用。同批修正型別慣例：步驟 3 原寫「動作詞 Add/Update/Fix」，但 Add/Update 不在 flow.sh 允許清單內會 exit 1，改為直接用 flow.sh 的十個值並附對照（Add→Feat、Update→Modify）。另修掉指向不存在檔案的連結：CONVENTIONS.md 在 monorepo 根不存在（實查），規範實際在 CLAUDE.md。

## [0.18.0] - 2026-09-10
### Added
- setup-plugins 與 clone-env 補「裝完 cc-statusline 要帶使用者做寬度目視校正」：面板依 `COLUMNS` 繪製但實際可用寬度少幾格，**差幾格因機器而異**（終端程式、字型、視窗設定），畫太寬會讓每列被 TUI 折行並切掉最右端（session 名字所在處）。兩支 skill 都寫明判準（框線右上角 `┐` 是否出現、每列右端有無 TUI 折行記號 `…`、名字是否完整）與「此值無法由腳本或 AI 推導、只能使用者目視回報」
- clone-env 的「重要限制」補一條：環境快照**不含**逐機器的顯示設定（`widthMargin`），舊機器的值不能沿用，新機需重做校正

## [0.17.1] - 2026-08-26
### Fixed
- publish skill：cron 只在 REPL 閒置時 fire，使用者持續互動時永遠不觸發且靜默不推。改為每輪回覆前自檢窗口是否已過，過了就當輪直接推，cron 降為備援。

## [0.17.0] - 2026-07-19
### Changed
- recommends 加 installMethod 欄位：skill-copy 型（非 marketplace 的裸 skill 合集）登記帶 --install-method skill-copy，register-external 與 setup-plugins 依此顯示複製安裝指引（/install-skill / skill-fetch / 手動放 .claude/skills/），不再對其誤導 /plugin install；登記子流程強制先驗來源 repo 有無 .claude-plugin/ 再定型態

## [0.16.0] - 2026-07-19
### Changed
- setup-plugins 升級「核可後代裝」：核可後由 Claude 直接跑 CLI 裝（claude plugin marketplace add + claude plugin install --scope project），不再只列指令請使用者自貼；CLI 失敗才退回列指令。enable 值為 false 的項目視為刻意停用、跳過。
- 新增子流程「一字核可代裝（auto mode）」：SessionStart 的 [plugin-profile] 提示後回「裝」→ 偵測有把握直接裝完推薦 profile（不再多問）；沒把握才退回手選。
- upgrade 子流程改代跑：claude plugin update <name>@fulin-plugins 為非互動 CLI，Claude 直接執行（修正舊說法「沒有 /plugin update 子指令」——CLI 已提供）。

## [0.15.4] - 2026-07-09
### Fixed
- recommends.json 登記 4 個外部 plugin：codex（Codex 委派/審查，git-commit Codex 軌依賴）、code-simplifier（程式碼精煉）、gopls-lsp（Go LSP）、csharp-lsp（.NET LSP 對應版）

## [0.15.3] - 2026-07-09
### Fixed
- README 補前置依賴段（Node.js、git CLI、本機 clone monorepo 為管理對象）

## [0.15.2] - 2026-06-28
### Changed
- publish skill 默許自動發布、補喚醒源

## [0.15.1] - 2026-06-28
### Changed
- README 補痛點/價值 hook，修安裝指令

## [0.15.0] - 2026-06-27
### Changed
- setup-plugins 改為只偵測+推薦+給指令、不再代寫 settings(install 選 scope 時自己寫); 新增專案自動偵測推薦(讀 CLAUDE.md 為主訊號對照 profile detect 規則); 新增可推廣 profiles.json(通用套餐+detect, 公司專屬 supplier 留本機)

## [0.14.0] - 2026-06-26
### Changed
- bump-version 加 CHANGELOG 自動維護、update SKILL 帶變更摘要參數
