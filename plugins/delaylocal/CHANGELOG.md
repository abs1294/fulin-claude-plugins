# Changelog

本檔記錄 delaylocal 的版本變更，格式依 [Keep a Changelog](https://keepachangelog.com/)。

## [0.1.4] - 2026-07-04
### Fixed
- **收尾通知失敗不再害 goal 模式空轉重試**：`notify-line.js` 原本 LINE API 回非 200（token 過期 / rate limit / userId 失效）或網路錯誤時 `exit 1`，而 goal 完成條件（GOAL_TAIL）寫「發出總結並回應 200」，導致「有設憑證但發送失敗」時 goal 引擎誤判任務未完成、持續重試燒 quota（任務其實早已做完）。現改為：notify 是「盡力通知」而非「必須成功」，任何發送結果（含非 200、網路錯）都 `exit 0` 並印出失敗原因；GOAL_TAIL 措辭放寬為「已嘗試發送即視為此步完成，絕不因非 200 重試」。「未設憑證→exit 0」的既有行為不變。
### Fixed
- delaylocal.js goal 模式 final_prompt 第一行 /goal 條件超過 Claude Code 的 4000 字元上限會卡死（回 "Goal condition is limited to 4000 characters"）。現自動偵測：第一行（含收尾通知尾巴）≤ 3900 字照舊整段放第一行（短任務向後相容）；超過則第一行換固定指針句（指向工作清單步驟 0），完整 goalCondition 原封下放步驟 0，避免機械截斷破壞語意。收尾通知尾巴兩種情況都保留在第一行（確保 goal 引擎仍強制發 LINE）。
