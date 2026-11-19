---
name: session-board
description: 啟動「session 看板」並用瀏覽器打開——一個只聽本機的網頁，左邊是這台電腦所有 Claude Code session 的清單，右邊是對話。每次叫都會先把這台電腦已裝的 fulin plugin 更新到最新、重開看板（跑的就是磁碟上最新的程式），並確認 Tailscale 那邊又連得到。當使用者打「/session-board」、說「開 session 看板」、「打開看板」、「啟動看板」、「重開看板」、「更新看板」、「看板網址是什麼」、「我有哪些 session 開著」、「哪個 session 在等我」時觸發。要停止或查狀態不要叫這個（一叫就會更新並重開），直接跑 scripts/start.js --stop／--status。
allowed-tools: Bash(node:*), Bash(echo:*)
---

# session-board：啟動看板

這個 skill 一載入就已經執行了 `scripts/start.js --refresh --open`，依序做三件事：

1. **更新 plugin**：用 plugin-manager 的 `update-all.js --apply` 把這台電腦已裝的 fulin plugin 全部更新到 marketplace 最新版——所有專案層與使用者層的安裝都算，不先列清單問、也不看看板設定裡「plugin 自動更新」開了沒。這是使用者明定的（2026-11-19：「指令除了啟動看板以外，要包含更新 plugin 與重啟網站、Tailscale」）；想先看清單再決定的時候用 `/plugin-manager-update`。最多跑 110 秒，超過就停下來回報、這次不重開看板（它起的安裝可能還在跑）；過一兩分鐘再打一次，會重新比對版本，已經更新好的不會重做（中途被切斷的那一筆會不會被當成落後重做：HYPOTHESIS，沒實測）。
2. **重開看板**：在跑就先停（不強制）再啟動，跑的就是磁碟上現在的程式；沒在跑就直接啟動。看板上有對話正在做事時不會停，舊版照跑。
3. **Tailscale**：看板設定有開「從其他裝置連」時，確認它又在 Tailscale 位址上聽了。

結果如下：

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/start.js" --refresh --open 2>&1 || echo "START-FAILED exit $?"`

## 回報

照上面的輸出逐行回報，不要再跑一次腳本：

- `plugins:` 那行：更新了哪些（版本從幾到幾、幾處）、仍落後或失敗的照原文給；有 `sessions to start again` 時列出要重開 Claude Code 的地方（新版 plugin 要重開 session 才生效，這步要使用者自己做）。
- `board:` 那幾行與 `session-board <版本> (pid …)`、網址：網址原樣給使用者（可以加到書籤）。
- `board: NOT restarted`（exit 2），兩種原因，照它印的寫：
  - 看板上有對話在做事：看板沒有重開、還是舊版在跑。把它列的對話告訴使用者，等它們做完再打一次 /session-board；**不要自己加 `--force`**。
  - `plugins:` 那行寫更新超過 110 秒被停下：它起的安裝可能還在跑，所以這次沒重開。請使用者過一兩分鐘再打一次。
- `tailscale:` 那行：照原文給（在聽就給位址；`not listening yet` 代表 Tailscale 還沒起來，看板會自己定時重試；`off` 代表看板設定沒開從其他裝置連）。
- **失敗**（上面有 `START-FAILED`，且不是 exit 2）：讀 `~/.claude/session-board/server.log` 的最後幾行找原因，把錯誤原文給使用者。最常見是 4317 埠被別的程式佔用：可以用 `node "${CLAUDE_PLUGIN_ROOT}/scripts/start.js" --open --port <其他埠號>` 改用別的埠。
- 不要替使用者解讀看板上的內容（那是他自己看的畫面）。
