# Changelog

本檔記錄 cc-statusline 的版本變更，格式依 [Keep a Changelog](https://keepachangelog.com/)。

## [0.3.0] - 2026-07-09
### Changed
- 新增 crons 排程顯示：cron-tracker hook（PostToolUse CronCreate/CronDelete/ScheduleWakeup 寫 claude-crons 狀態檔）＋ statusline 第三欄（agents/skills）改 token 兩段式渲染、欄底固定兩 row 顯示排程（下一發時刻＋標籤，無排程顯示 —，一次性逾時自動剔除、循環顯示至刪除）；rows 開關加 crons key；README 資料源表同步 7 支 hooks

## [0.2.2] - 2026-07-09
### Fixed
- README 前置依賴段補全（git/claude CLI/PowerShell 各欄位降級行為）

## [0.2.1] - 2026-07-06
### Fixed
- 修右欄訊息歷史 off-by-one：summary 直接接分割區塊的版面下，totalSlots 把兼任 section 分隔與 split-open 的同一列分隔線計了兩次，導致最新一則訊息永遠不顯示（歷史僅 1 則時整欄空白）。只在 split 分隔線不兼任 section 分隔時才計 sectionDividers。

## [0.2.0] - 2026-07-05
### Changed
- 加入 6 支 tracker hooks（message/summary/file/skill/subagent/compact）並以 hooks/hooks.json 於安裝時自動註冊，補齊 status line 資料源；README 新增資料源與重複註冊警告、setup skill 加 hook 重複偵測步驟
