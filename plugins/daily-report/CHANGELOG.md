# Changelog

本檔記錄 daily-report 的版本變更，格式依 [Keep a Changelog](https://keepachangelog.com/)。

## [0.4.0] - 2026-07-20
### Changed
- extract 預設只掃當前專案（--project/--all-projects，用 session cwd 判歸屬，輸出檔名帶專案識別）；收件人支援專案層覆寫（<專案>/.claude/daily-report.json 只能覆寫 recipients/cc/subject_prefix/from_name，憑證強制只從家目錄讀，已實測專案層假憑證被忽略）；gmail_oauth 新增 doctor 子命令：實打 API 逐項驗證（設定檔/用戶端/授權換 token/Gmail API 是否啟用/收件人），失敗輸出 Google 原始錯誤與連結而非寫死的 Console 路徑——起因是作者自己照引導跑仍漏掉啟用 Gmail API 而被 403；SKILL.md 與 guide 改為「doctor 判定、不信自我回報、Console 路徑以 Google 即時訊息為準」

## [0.3.0] - 2026-07-20
### Added
- setup_gate.py 機制閘：把首次設定從「模型自律講清楚」改成腳本產生內容。`status`（四種未完成情境統一判定，exit 10=需引導、0=可交付）、`options`（三選項的 label/description 由腳本輸出，權限/有效期/設定成本/代價四欄固定不可摘要，供模型原文填進 AskUserQuestion）、`guide <channel>`（逐步引導含每步「確認」判準）。
- check_no_secrets.py：掃 repo 內 JSON 範本有無真憑證（`--staged` 供 pre-commit）。
- .gitignore 擋 daily-report 真設定檔路徑。

### Changed
- SKILL.md 第 5 步改為「先跑 setup_gate status，退出碼決定走哪條」，禁止自行讀檔推論或直接詢問使用者；首次設定引導改為搬運腳本輸出，並明訂兩條紅線（憑證不進對話、範本不填真值）。

## [0.2.0] - 2026-07-20
### Added
- Gmail API OAuth 路徑（gmail_oauth.py）：`setup` 引導式授權（loopback redirect + PKCE S256 + state 防 CSRF，瀏覽器自動開、使用者按一下允許即完成，refresh_token 自動寫入 config）、`send`（refresh→access token 現換不落盤、Gmail API users.messages.send）、`status`（授權健檢）。零外部套件（urllib 直打 endpoint），scope 僅 gmail.send（能寄不能讀）。
- 交付管道三選一自動判斷（oauth → smtp → MCP 草稿），依使用者 config 內容決定，不重複詢問。
- SKILL.md 新增首次設定引導：Claude 逐步帶使用者開 GCP 專案→啟用 Gmail API→同意畫面→測試使用者→建桌面用戶端→執行授權，含「未驗證應用程式」警告畫面與測試模式 7 天過期的預先說明。

### Changed
- 刻意不內建任何 OAuth 憑證（選項 B）：避免配額/驗證狀態/撤銷風險綁在單一發布者，也避免個人憑證進公開 repo 的 git 歷史。

## [0.1.0] - 2026-07-20
### Added
- 初版：extract_sessions.py（掃 session jsonl → 按專案分組中間 JSON；mtime 預過濾、isSidechain/SDK/promptSource 系統注入過濾、ai-title 直取、prompt 截 400 字）＋ send_gmail.py（Gmail SMTP 應用程式密碼寄送，--dry-run 預覽、plain+HTML 雙格式、收件人設定檔管理）＋ SKILL.md 流程（萃取→生成→人工核可→寄送；統計僅本機顯示；私人 session 預設略過）
