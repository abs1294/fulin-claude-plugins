# longshot — 網頁長截圖

把很長的網頁截成一整張圖。主要用在要登入的後台（Google Play Console、App Store Connect…）：這類頁面多半是內層捲動，瀏覽器內建截圖只截得到一個畫面，另存成網頁再打開又常常版面跑掉。

## 安裝

```text
/plugin install longshot --marketplace abs1294/fulin-claude-plugins
```

## 用法

跟 Claude 說「長截圖」「把這頁截下來給 IT」即可（skill：`longshot`）。也可以自己執行：

```bash
node <plugin 目錄>/scripts/longshot.mjs chrome                 # Chrome 目前分頁 → 桌面
node <plugin 目錄>/scripts/longshot.mjs chrome ~/Desktop/a.png  # 指定輸出
node <plugin 目錄>/scripts/longshot.mjs 某頁.html               # 已另存的網頁檔
node <plugin 目錄>/scripts/longshot.mjs https://example.com     # 公開網頁
# 選項：--width 1440（版面寬度）  --scale 2（清晰度倍數）
```

輸出沒指定時存到桌面（Windows 有 OneDrive 桌面時存那裡），檔名＝網頁標題＋時間。

## 怎麼做的

1. `chrome` 模式：把 Chrome 叫到前面，按 Cmd/Ctrl+S，用剪貼簿貼上一個唯一檔名（避開中文輸入法），按 Enter 存檔；完成後還原剪貼簿。
2. 用無畫面的 Chrome 開那個網頁檔：**不執行頁面程式、擋掉所有對外連線**（只讀本機檔案）。
3. 找出內層捲動區，連同上層一起解除高度限制，整頁變成全長；隱藏沒載入的圖示字型（否則會顯示成 `arrow_right_alt` 這類英文字）。
4. 截整頁 PNG，最後刪掉另存的網頁檔（含登入後的頁面內容）。

不依賴任何 npm 套件：直接用 Chrome DevTools Protocol（Node 22 內建 WebSocket）驅動電腦上的 Chrome，找不到 Chrome 會改用 Edge，或用環境變數 `LONGSHOT_BROWSER` 指定執行檔。

## 需要

- Node.js 22 以上
- Google Chrome（截圖也可用 Edge／Chromium；自動另存只支援 Chrome）
- macOS：第一次用 `chrome` 模式要開權限：「系統設定 → 隱私權與安全性 → 輔助使用」勾選執行的 App（終端機／iTerm／Claude）
- Windows：不用另外設定；執行時 Chrome 視窗會被叫到前面，幾秒內不要動鍵盤滑鼠
- 另存對話框真的出現在最前面才會輸入檔名、按 Enter；10 秒內沒出現就停下來報錯，不會把字打在網頁上
- Linux：只能截網頁檔與公開網址（沒有自動另存）

## 已知限制

- Chrome 上次另存若選「網頁，僅 HTML」，截出來沒有樣式；手動另存一次改成「網頁，完整」即可（Chrome 會記住）。
- 截圖高度上限 30000px。
- 只看得到另存當下的畫面；需要點開才出現的內容要先點開再截。

## 測試

```bash
node plugins/longshot/tests/longshot.test.mjs
```
