# Changelog

本檔記錄 supplier-agents 的版本變更，格式依 [Keep a Changelog](https://keepachangelog.com/)。

## [Unreleased]
### Changed
- 各 agent 檔尾的變更紀錄移到本檔（指令檔每次派工都整份載入，歷史紀錄不佔每次的 context）；agent 檔尾改為一行指標。以下為移入的原紀錄，依 agent 分組：

#### backend-architect.md
- 2026-07-30 交接節新增「簽收閘門」（Contract＋情境表 seam 收斂須明文確認才算完成；無簽收流程環境不適用）（經使用者同意，第二波落地）
- 2026-07-30 冷啟測試 FAIL 後修正：輸出格式加第 6 項測試情境表；簽收閘門改為末句待簽收聲明的格式指令（經使用者同意）

#### backend-engineer.md
- 2026-07-30 前置條件新增第 4 點「實作前自檢」（層別規則檔指標＋ DQ 基線；限存在 rules/ 目錄的專案）（經使用者同意，第二波落地）
- 2026-07-31 註解規範內聯內容改為指標（唯一正本＝workspace 根 `註解撰寫規範.md`；冷啟探針驗證後定案）（經使用者同意）

#### code-reviewer.md
- 2026-07-31 註解審查內聯清單改為指標（唯一正本＝workspace 根 註解撰寫規範.md；冷啟探針驗證後定案）（經使用者同意）

#### frontend-engineer.md
- 2026-07-30 前置條件新增第 3 點「實作前自檢」（rules/frontend/ 選讀＋DQ 基線；條件式生效）（經使用者同意，第二波落地）
- 2026-07-31 註解規範內聯內容改為指標（唯一正本＝workspace 根 `註解撰寫規範.md`；冷啟探針驗證後定案）（經使用者同意）

#### qa-engineer.md
- 2026-09-01 設計原則補「反向／終止分支＋多步狀態序列＋共用元件其他使用點」；回報判準「不自行增減」改為「不得少報＋範圍外發現必報」。起因：三個月 79 個 session 稽核——本檔全文「回歸／既有功能／未改動範圍」零命中，且原句在制度上禁止 QA 補派工單之外的情境；同期 301 份 QA 派工單僅 16% 要求測反向分支、8% 要求逐欄驗值，使用者實測抓包的缺陷幾乎全落在派工單沒寫的那一格。配套：Supplier_Code 的 04 新增模板六、03 新增 B15、hook check-review-discipline.js 加【範圍展開】閘（經使用者核准）
- 2026-07-30 輸出格式新增回報判準（簽收表逐列三態、N 外部錨定）與 codify 完成判準（drift_check 0/0 必貼）；CATALOG 登記改 COVERAGE.md（經使用者同意，第二波落地）
- 2026-08-07 codify 完成判準加第三類「0 佔位」（drift_check 同日新增待補偵測；健檢抓到 120 列佔位債）（經使用者同意）

## [0.1.2] - 2026-07-05
### Fixed
- qa-engineer 指路更新：browser-testing skill 已移除，改指 qa-webwright browser-qa＋tests/Project_Detail 專案知識層
