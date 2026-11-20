---
name: line
description: 設定、檢查、關閉看板的「LINE 小秘書」：在自己的 LINE 官方帳號跟小秘書說話，它回報看板全局、讀某個對話做到哪，也能替你交代對話、開新對話、停止、核准請求（會先在 LINE 問你「好」才做）。帶使用者一步步完成：建 LINE 官方帳號與 Messaging API、把 Channel secret 與 access token 存成本機檔（不經過聊天）、用綁定碼綁自己的 LINE、開 Tailscale Funnel、設 webhook 並跑 LINE 的連線測試。當使用者打「/session-board:line」、說「設定 LINE 小秘書」、「LINE 小秘書壞了／沒回」、「我同事也要用 LINE 小秘書」、「關掉 LINE 小秘書」、「LINE 小秘書狀態」時觸發。
allowed-tools: Bash(node:*)
---

# /session-board:line：LINE 小秘書

小秘書的程式在看板裡（`lib/line.js`）。它在本機 127.0.0.1:4318 自己聽，只收 LINE 送來、用你的 Channel secret 簽過的訊息，只回綁定的那一個 LINE 帳號。對外只開一個 Tailscale Funnel（8443 埠，只轉到 4318）；看板本身（4317）不會上網路。設定檔在 `~/.claude/session-board/line.json`，不在任何 repo 裡。

這個 skill 一載入就已經檢查過一次，結果如下：

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/line-setup.js" status 2>&1 || echo "SETUP-CHECK-FAILED exit $?"`

## 怎麼做

照最後一行 `NEXT:` 做那一步。做完再跑一次 `node "${CLAUDE_PLUGIN_ROOT}/scripts/line-setup.js" status`，照新的 `NEXT:` 繼續，直到 `NEXT: done`。每一步只做那一步，不要跳。✓／✗ 那幾行原樣給使用者看。

**祕密規則（最重要）**：Channel secret 和 access token 一律請使用者自己打進設定檔（`edit` 會幫他打開），**不要請他貼在聊天裡**；貼進聊天的東西會進對話紀錄、送到 API。他還是貼了的話：照他貼的寫進設定檔（用 Write 工具寫 `~/.claude/session-board/line.json`，不要用會把值印出來的指令），然後建議他之後到 LINE 後台重發一組（重發後舊的失效，再用 `edit` 換新的）。任何時候都不要把這兩個值印出來或寫進回覆。

| NEXT | 你做什麼 | 使用者做什麼 |
|---|---|---|
| `edit` | 先講「會開一個記事本視窗」，再跑 `line-setup.js edit` | 在打開的檔案裡填 `channelSecret`、`channelToken` 兩個欄位的值，存檔，回你「好了」。還沒有 LINE 官方帳號的，先照下面「建 LINE 官方帳號」做 |
| `claim` | 跑 `line-setup.js claim`，把印出的 `CODE:` 那 6 個數字給他 | 在 LINE 把這 6 個數字傳給他的官方帳號，收到「綁定好了」就完成。10 分鐘內有效；過期就再跑一次 claim。（綁定是最後一步：其他都好了，碼才傳得到） |
| `send-code` | 不用跑。綁定碼還有效，提醒他傳 claim 時給他的那 6 個數字（status 不會再印出那組碼；他手上沒有了就再跑一次 claim） | 傳綁定碼 |
| `tailscale` | 照 ✗ 那行的原因說明 | 安裝 Tailscale（https://tailscale.com/download）並登入 |
| `funnel` | 跑 `line-setup.js funnel` | 印出 `NEED:` 時：打開它給的 `login.tailscale.com/f/funnel?...` 網址、按啟用，回你之後你再跑一次 funnel。公司的 Tailscale 網路可能要管理員同意 |
| `board` | 請他先打 `/session-board` 啟動看板 | — |
| `start` | 跑 `line-setup.js start`（看板是舊版、沒帶起小秘書時才會到這步；看板下次重開就會自己帶） | — |
| `webhook` | 跑 `line-setup.js webhook`。它會設網址、跑 LINE 的連線測試（Funnel 剛開時要等約 30 秒，它會自己重試） | — |
| `use-webhook` | 說明在哪裡打開 | LINE Developers → 他的 channel → **Messaging API** 分頁 → Webhook settings → **Use webhook** 打開。另外建議到 LINE Official Account Manager → 回應設定，把「自動回應訊息」關掉，不然每句都會多一則罐頭回覆 |
| `done` | 告訴他可以用了：在 LINE 問「看板現在有什麼在跑」試試 | — |

`SETUP-CHECK-FAILED`：把輸出原文給使用者，不要猜原因。

### 建 LINE 官方帳號（同事第一次用）

每個人用**自己的**官方帳號：一個官方帳號只能指到一台電腦（一個 webhook 網址），而小秘書只回綁定的那一個人。免費方案就夠：小秘書在 50 秒內回答就用免費的「回覆」；超過才用每月有額度的「推播」。

1. 到 LINE Official Account Manager 建一個官方帳號（名字隨意，例如「我的看板秘書」）。
2. 在它的設定裡啟用 Messaging API，會建出一個 channel（HYPOTHESIS：LINE 目前的流程是先建官方帳號再啟用 Messaging API；畫面跟這裡寫的不同時，照 LINE 的畫面走）。
3. 到 LINE Developers 打開那個 channel：
   - **Basic settings** 分頁 → **Channel secret**（32 碼）
   - **Messaging API** 分頁 → **Channel access token (long-lived)** → Issue
   這兩個就是 `edit` 要填的值。
4. 用手機加這個官方帳號好友（Messaging API 分頁有 QR code）。

### 其他指令

- 看狀態：`line-setup.js status`
- 關掉對外入口（從網路來的都進不來，小秘書收不到訊息）：`line-setup.js off`；要再開就是 `funnel`
- 換綁定的人：把 `line.json` 的 `userId` 刪掉，再跑 `claim`

不用 goal2 的人也能用：沒填 `channelToken` 時，才會改用 goal2 的 LINE 通知設定裡的 token 和 userId（`status` 會寫「沿用 goal2 的設定」）。
