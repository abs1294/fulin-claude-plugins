# Changelog

本檔記錄 daily-report 的版本變更，格式依 [Keep a Changelog](https://keepachangelog.com/)。

## [0.6.2] - 2026-07-22
### Fixed
- README 與程式對齊 0.6.0 收件人紀律：README 到處說「寄給設定檔指定的收件人」但實際收件人只認專案層、家目錄不當預設——修正 README 開頭與新增「憑證與收件人分兩層」段講清楚兩層設定；config.example 移除誤導的家目錄 recipients（程式已不採用），新增 daily-report.project.example.json 專案設定範本；doctor 收件人檢查同步改只認專案層（原本讀家目錄 recipients，會顯示借用來的收件人為綠燈誤導使用者）；doctor 檢查項 README 從 5 改 6（補寄件帳號）；setup 完成提示不再說「設定檔補 recipients」改說「各專案自設」

## [0.6.1] - 2026-07-21
### Fixed
- SKILL.md 呈現核可步驟明訂：寄送資訊每一項（尤其主旨）必須顯示 dry-run 印出的實際值，不准用「（日報前綴）」這類佔位符或示意文字——否則使用者核可的是示意版而非真正會寄的內容，呈現核可形同虛設。起因：呈現時用佔位符代替實際主旨給使用者看

## [0.6.0] - 2026-07-21
### Changed
- 收件人紀律修正（安全）：收件人只認專案層 .claude/daily-report.json，家目錄的 recipients 不再當預設——沒設收件人的專案改為拒寄並走引導，不再默默借用家目錄收件人寄給不相干的人（起因：測試時未設專案收件人的專案直接寄給家目錄的 aa22942072）；send_common.resolve_recipients 與 setup_gate.detect 同步此紀律。郵件排版拿掉手刻 HTML（卡片/強調條/inline style/置中 table 全砍），md_to_html 改輸出最基本的 p/ul/li/b，交給 Gmail 預設渲染——華麗 HTML 讓信不像個人寫的；移除連帶用不到的 build_meta 與樣式常數

## [0.5.1] - 2026-07-20
### Fixed
- 重構：抽出 send_common.py 統一兩條寄送路徑的前置契約（展開路徑/解析收件人/內容閘/確認窗口閘/sent 去重/scope_key）。原本 send_gmail 與 gmail_oauth 各自實作同一套檢查，紅隊已證實對等性靠複製貼上必然失衡（SMTP 曾漏兩道閘）；現在兩路徑跑同一份 prepare_send，各腳本只保留「怎麼把郵件送出去」（SMTP 連線 vs REST 呼叫）。scope_key/sent_path 單一事實來源移入 send_common，confirm_gate 改為 import 而非重實作，消除雜湊不一致導致去重漏接的風險。行為經 OAuth/SMTP 雙路徑實測一致（內容閘 exit 3、確認閘 exit 5、乾淨內容通過、arm→check→auto 全鏈路）

## [0.5.0] - 2026-07-20
### Changed
- 紅藍對抗（對外釋出視角，2 個獨立 fresh-context 紅隊）修 3 CRITICAL + 4 HIGH/MEDIUM：① SMTP 路徑補齊 --auto 確認閘與 sent 去重（原本只有 OAuth 路徑有，選 app_password 的使用者等於零核可保護、可無限重寄）② content_guard 擴充憑證/個資/金額偵測（原本只擋 AI 詞彙，含明文密碼與身分證字號的日報被判通過；密碼 pattern 要求值具密碼特徵以免誤判正常敘述）③ confirm_gate 狀態改以「日期+專案雜湊」為鍵（原本只用日期，多專案同日互相覆蓋/TOCTOU 比對錯檔/veto 連坐/誤判已寄——而多專案分設收件人正是主打功能）④ setup_gate channel 明示優先於憑證偵測（mcp_draft 選項原本永遠無法完成設定）⑤ 四支腳本補 expanduser（SKILL.md 用 ~ 開頭路徑，PowerShell/subprocess 不展開）⑥ arm 補建 reports/ 目錄 ⑦ README 修正與實況矛盾的「絕不自動寄」描述、補列 setup_gate/content_guard/confirm_gate、界線改為誠實說明語意層機密與私人 session 過濾的自律本質

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
