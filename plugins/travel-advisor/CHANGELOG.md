# Changelog

本檔記錄 travel-advisor 的版本變更，格式依 [Keep a Changelog](https://keepachangelog.com/)。

## [0.1.1] - 2026-11-05
### Changed
- `config/隱私.md`：原始稽核資料的未去識別化備份（`_pii-backup-20261101`）已刪除，改為記錄刪除日期與剩餘目錄的掃描結果（0 命中）。

## [0.1.0] - 2026-11-05
### Added
- 自 user 層 skill 納管為 plugin：四道閘門規範、分階段細則、踩過的坑、七支腳本（含即時位置分享 `live-loc.py` 與一次性分享連結 `parse-loc.py`）、批量查核 agent。
- 個人設定檔與行程狀態檔以 `.gitignore` 排除（repo 為 public）。
