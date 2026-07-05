# Changelog

本檔記錄 cc-statusline 的版本變更，格式依 [Keep a Changelog](https://keepachangelog.com/)。

## [0.2.0] - 2026-07-05
### Changed
- 加入 6 支 tracker hooks（message/summary/file/skill/subagent/compact）並以 hooks/hooks.json 於安裝時自動註冊，補齊 status line 資料源；README 新增資料源與重複註冊警告、setup skill 加 hook 重複偵測步驟
