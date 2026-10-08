---
description: 上線前健檢（smoke test）：照專案設定起服務、健康檢查、依等級跑自動套件＋手動 TC，全部跑完才出報告；FAIL 由使用者決定，不自動修。
argument-hint: [等級，例如 P0 / P0+P1 / P0+P1+P2；省略會先問]
---

執行上線前健檢。等級：

$ARGUMENTS

**開工前先讀本 plugin `browser-qa` skill 的 `methodology/smoke-run.md`**——分級、起服務決策樹（不殺別人的程序）、執行規則四條、報告閘都在那裡，本命令只列步驟。
每次呼叫 `qa-flow.sh` 都帶 `CLAUDE_PROJECT_DIR=<Primary working directory>`（原封不動；理由見 `qa-run.md` 的落點鐵則）。

1. **確認等級**：上面沒給等級就先問使用者（可選的等級以 `tests/Project_Detail/SMOKE.json` 的 `levels` 為準；還沒有設定檔就照常見三級 P0／P0+P1／P0+P1+P2 問）。
2. **設定就緒**：`tests/Project_Detail/SMOKE.json` 不存在，或有服務還沒 verified 時——
   1. 讀專案文件（README、package.json scripts、launch 設定、既有啟動腳本、`tests/Project_Detail/`）抓出每個服務的啟動指令、port、scheme、健康檢查網址；
   2. 照 `templates/SMOKE.example.json` 寫草稿（`verified: null`），出處與起服務的坑寫進 `tests/Project_Detail/SMOKE.md`（範例 `templates/SMOKE.example.md`）；
   3. 逐一 `qa-flow.sh smoke-try <服務名>`，**通過才算**；失敗照輸出的原因與 log 尾段修設定再試。port 被佔（exit 4）就停下回報使用者，不殺。
3. **起服務**：`qa-flow.sh smoke-preflight`。exit 4＝port 被別的程序佔且不健康，把輸出的佔用者回報使用者、停止；exit 3＝有服務未驗證，回第 2 步。
4. **跑自動套件**：`qa-flow.sh smoke-run <等級>`（等級不存在 exit 2）。
5. **手動 TC**：`smoke-run` 有印出本輪手動結果檔時，派 **qa-engineer** 逐案執行並把結果與證據填進那份檔（派工單照 `SKILL.md`「派工範本」逐格填；主對話不親跑瀏覽器）。
6. **出報告**：`qa-flow.sh smoke-report`。被拒絕時照它列的缺項補齊（缺的手動結果再派工），不得自己拼報告繞過。
7. **收尾**：不論結果，`qa-flow.sh smoke-stop`（只停本腳本起的程序）。
8. 把報告路徑、摘要數字、FAIL 清單回報使用者；**FAIL 由使用者決定，不自動修**。
