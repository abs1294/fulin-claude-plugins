# Changelog

## [0.1.0] - 2026-11-27
### Added
- 網頁長截圖：`longshot chrome` 自動另存 Chrome 目前分頁（macOS 用 AppleScript、Windows 用 PowerShell 送鍵）→ 離線截整頁 → 刪掉另存檔；也可截已另存的網頁檔或公開網址
- 內層捲動區自動撐開成全長、沒載入的圖示字型自動隱藏
- 本機網頁檔開啟時關掉頁面程式、擋掉所有對外連線
- 另存網頁的樣式表帶 crossorigin／integrity 時（GitHub 等）先拿掉再開，避免樣式整個被擋
- 零相依：直接用 Chrome DevTools Protocol 驅動電腦上的 Chrome／Edge（Node 22 內建 WebSocket）
- tests/longshot.test.mjs：內層捲動、圖示隱藏、對外連線 0 次、中文與空白路徑、帶 crossorigin／integrity 的樣式表
