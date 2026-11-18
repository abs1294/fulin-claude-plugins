---
name: session-board
description: 啟動「session 看板」並用瀏覽器打開——一個只聽本機的網頁，左邊是這台電腦所有 Claude Code session 的清單，右邊是對話。沒在跑就啟動（背景常駐），已經在跑就直接打開。當使用者打「/session-board」、說「開 session 看板」、「打開看板」、「啟動看板」、「看板網址是什麼」、「我有哪些 session 開著」、「哪個 session 在等我」時觸發。只負責啟動：要停止或查狀態不要叫這個（一叫就會啟動），直接跑 scripts/start.js --stop／--status。
allowed-tools: Bash(node:*), Bash(echo:*)
---

# session-board：啟動看板

這個 skill 一載入就已經執行了啟動腳本（`scripts/start.js --open`）：沒在跑就啟動、在跑就沿用，並用預設瀏覽器開啟頁面。結果如下：

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/start.js" --open 2>&1 || echo "START-FAILED exit $?"`

## 回報

- **成功**（上面有 `session-board <版本> (pid …)` 與一行網址）：只回報版本與網址，網址原樣給使用者（可以加到書籤）。不要再跑一次啟動腳本。
- **失敗**（上面有 `START-FAILED`）：讀 `~/.claude/session-board/server.log` 的最後幾行找原因，把錯誤原文給使用者。最常見是 4317 埠被別的程式佔用：可以用 `node "${CLAUDE_PLUGIN_ROOT}/scripts/start.js" --open --port <其他埠號>` 改用別的埠。
- 不要替使用者解讀看板上的內容（那是他自己看的畫面）。

## 更新 plugin 之後

上面若印出的版本比 plugin 的版本舊，表示正在跑的是更新前的看板：新版要先停再開才會生效（`node "${CLAUDE_PLUGIN_ROOT}/scripts/start.js" --stop`，再打一次 /session-board）。停止被拒絕時照腳本印的說明：把清單告訴使用者，不要自己加 `--force`。
