---
name: longshot
description: 把使用者 Chrome 目前開著的網頁（含要登入的後台，如 Google Play Console、App Store Connect、公司或客戶後台）截成一整張長圖存到桌面。使用者說「長截圖」「整頁截圖」「把這頁截下來給誰看」「網頁太長截不完」時使用；也可截已另存的網頁檔（.html／.mhtml）或公開網址。
---

# 網頁長截圖

程式：`node "${CLAUDE_PLUGIN_ROOT}/scripts/longshot.mjs"`（以下簡稱 `longshot`），需要 Node 22 以上與 Chrome（或 Edge）。

| 情況 | 指令 |
|---|---|
| Chrome 目前分頁（可以是要登入的頁面） | `longshot chrome [輸出.png]` |
| 使用者給了已另存的網頁檔 | `longshot <檔案.html 或 .mhtml> [輸出.png]` |
| 公開網頁（不用登入） | `longshot <https://網址> [輸出.png]` |

選項：`--width 1440`（版面寬度）、`--scale 2`（清晰度倍數）。輸出沒指定就存桌面，檔名＝網頁標題＋時間。

## 步驟（Chrome 目前分頁）

1. 先跟使用者確認要截的是哪一頁：
   - macOS：`osascript -e 'tell application "Google Chrome" to get {title, URL} of active tab of front window'`
   - Windows：`powershell -NoProfile -Command "(Get-Process chrome | ? MainWindowTitle | select -First 1).MainWindowTitle"`
   不是使用者要的那頁，就請他切過去再說一聲；不要自己切分頁。
2. 告訴使用者「接下來幾秒 Chrome 會自動跳出另存視窗，請先不要動鍵盤滑鼠」，再執行 `longshot chrome`（使用者有指定檔名或位置就帶上）。
3. 用 Read 打開輸出的 PNG 檢查：有沒有截到頁尾、版面有沒有亂、有沒有不該給對方看的資訊（帳號、信箱、其他專案或個資）。有就告訴使用者。
4. 回報輸出的完整路徑與檢查結果。

## 失敗時

- 「另存視窗 10 秒內沒有出現，沒有輸入任何字」：Ctrl/Cmd+S 之後對話框沒跳出來（電腦太忙、Chrome 卡住、或被別的視窗擋住）。程式沒有打任何字，網頁不受影響；請使用者確認 Chrome 沒卡住後再試一次。
- 「Chrome 沒辦法叫到最前面，沒有按任何鍵」（Windows）／「Chrome 沒有到最前面」（macOS）：請使用者先點一下 Chrome 視窗再試。
- 「60 秒內沒找到另存的網頁檔」：
  - macOS 多半是沒有輔助使用權限 → 請使用者到「系統設定 → 隱私權與安全性 → 輔助使用」勾選執行 Claude 的 App（終端機／iTerm／Claude），再試一次。
  - Windows 多半是 Chrome 視窗沒被叫到前面 → 請使用者先點一下 Chrome 視窗再試。
- 截出來沒有樣式：Chrome 上次另存選了「網頁，僅 HTML」→ 請使用者手動按一次 Cmd/Ctrl+S，把格式改成「網頁，完整」（Chrome 會記住），再重跑。
- 版面跑掉：請使用者手動另存後把檔案給你，改用 `longshot <檔案>`；還是不行就請他用 Chrome 開發者工具的「Capture full size screenshot」。

## 原則

- 要登入的頁面只走「另存 → 離線截圖」：本機網頁檔開啟時不執行頁面程式、不對外連線。不要把要登入的網址直接丟給 `longshot`，也不要嘗試自動登入。
- 另存的網頁檔含登入後的內容，程式截完會自己刪；中途失敗時確認 Downloads 沒有留下 `longshot-*` 檔與資料夾。
