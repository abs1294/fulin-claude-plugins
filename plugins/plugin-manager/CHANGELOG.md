# Changelog

本檔記錄 plugin-manager 的版本變更，格式依 [Keep a Changelog](https://keepachangelog.com/)。

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
