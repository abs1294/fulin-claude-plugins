# Changelog

本檔記錄 delaylocal 的版本變更，格式依 [Keep a Changelog](https://keepachangelog.com/)。

## [0.1.3] - 2026-06-30
### Fixed
- delaylocal.js goal 模式 final_prompt 第一行 /goal 條件超過 Claude Code 的 4000 字元上限會卡死（回 "Goal condition is limited to 4000 characters"）。現自動偵測：第一行（含收尾通知尾巴）≤ 3900 字照舊整段放第一行（短任務向後相容）；超過則第一行換固定指針句（指向工作清單步驟 0），完整 goalCondition 原封下放步驟 0，避免機械截斷破壞語意。收尾通知尾巴兩種情況都保留在第一行（確保 goal 引擎仍強制發 LINE）。
