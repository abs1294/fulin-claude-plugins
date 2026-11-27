# Changelog

## [0.1.1] - 2026-11-27
### Fixed
- 自動另存：按 Ctrl/Cmd+S 後一定等到另存對話框真的出現在最前面，才輸入檔名、按 Enter；10 秒內沒出現就一個字都不打、停下來報錯。原本固定等 2 秒（macOS 1.5 秒）就打字，電腦慢時全選、貼上、Enter 會打在網頁本身，要登入的後台游標剛好在輸入框時可能填字並送出表單。Windows 實測：對話框沒出現時沒有送出任何按鍵、剪貼簿還原；macOS 未實跑。
- Windows：取你最近用的那個 Chrome 視窗（原本取第一個 chrome 程序，多個視窗時不一定是眼前那個），並確認它真的到了最前面才按 Ctrl+S；叫不到前面就停下來。
- 剪貼簿原本是圖片或檔案時也還原（原本只還原文字，其他內容會被檔名蓋掉）：Windows 整份逐格式存起來再放回，一開始就讀不到（被別的程式鎖住）時不清空；macOS 在同一段 AppleScript 裡整份存起來、最後放回，中途出錯也放回（macOS 未實跑）。
- macOS：按 Cmd+S 之前 Chrome 視窗上已經掛著別的面板，就停下來不按，不會把字打進那個面板。

## [0.1.0] - 2026-11-27
### Added
- 網頁長截圖：`longshot chrome` 自動另存 Chrome 目前分頁（macOS 用 AppleScript、Windows 用 PowerShell 送鍵）→ 離線截整頁 → 刪掉另存檔；也可截已另存的網頁檔或公開網址
- 內層捲動區自動撐開成全長、沒載入的圖示字型自動隱藏
- 本機網頁檔開啟時關掉頁面程式、擋掉所有對外連線
- 另存網頁的樣式表帶 crossorigin／integrity 時（GitHub 等）先拿掉再開，避免樣式整個被擋
- 零相依：直接用 Chrome DevTools Protocol 驅動電腦上的 Chrome／Edge（Node 22 內建 WebSocket）
- tests/longshot.test.mjs：內層捲動、圖示隱藏、對外連線 0 次、中文與空白路徑、帶 crossorigin／integrity 的樣式表
