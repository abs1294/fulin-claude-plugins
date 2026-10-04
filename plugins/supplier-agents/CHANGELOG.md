# Changelog

本檔記錄 supplier-agents 的版本變更，格式依 [Keep a Changelog](https://keepachangelog.com/)。

## [Unreleased] - 2026-10-04
同步 harness 引擎 0.10.0 的 agent 骨架補項並修既有缺陷（經使用者同意；plugin.json 版號未動，發版時再定）。
### Fixed
- backend-engineer：「要求 backend-architect 完成設計」「回報 backend-architect 確認」改為回報主對話轉派（agent 之間不直接交接，對齊 Supplier_Code `.claude/harness/02-model-dispatch.md` §1）
- backend-architect／backend-engineer／frontend-engineer：刪除抄自 skill 的步驟編號（「Step 1 ~ Step 7」等，skill 已加 Step 0 而漂移），改為「照該 skill 現行的步驟編排」指標
- code-reviewer：刪除寫死的規則檔數量（13 檔、17 檔），改為以目錄現況為準
### Added
- backend-architect：API Contract 列錯誤碼；測試情境表必含反向路徑（03 B15）；交接前規範符合性自檢，衝突寫進設計文件請使用者裁決
- backend-engineer：明寫「不負責測試（QA 負責）」；交接加偏離設計之處、`dotnet build` 結尾輸出、FLOWS 鏈路同步判定
- frontend-engineer：共用元件改動先列使用點；明寫「不負責測試（QA 負責）」；交接加共用元件使用點、偏離契約之處、`npm run build` 結尾輸出、FLOWS 鏈路同步判定
- qa-engineer：必讀加 `.claude/test-guide/test-guide.md`；設計前先讀被測物；涵蓋範圍改照 04 模板六【範圍展開】四格（取代「正常流程、驗證失敗、邊界條件」）；新坑寫回 `tests/Project_Detail/` 並補同目錄 CHANGELOG
- code-reviewer：「零規則引用又零違規＝未完成」擴及前端審查；嚴重度加「對 commit 的效果」表（判準指向 skill `code-review` 嚴重程度表）。輸出格式（VERDICT 契約）未動

## [0.2.0] - 2026-10-03
### Changed
- 開發順序統一為「實作 → 回報主對話 → QA → review」（對齊 Supplier_Code `CLAUDE.md` §3「QA 先於 review」）：
  - backend-engineer／frontend-engineer「開發完成後的交接」改為回報主對話、由主對話依 §3 接 QA（行為類）或直接送審（分流例外），agent 不自行派下一棒
  - qa-engineer 開工條件拿掉「code-reviewer 審查通過」，改為「實作完成並已回報主對話」；description 觸發詞同步
  - code-reviewer 觸發時機與 description 同步改為主對話派審（行為類在 QA 之後）＋git-commit C 軌
  - README 表格、流程圖、交接規則同步；順手修正 README 兩處與現況不符：qa-engineer 寫成「只設計、不操作瀏覽器」（實際由 QA 親跑 Playwright MCP）、skill 表仍寫已移除的 `browser-testing`
- （先前未發版、併入本版）各 agent 檔尾的變更紀錄移到本檔（指令檔每次派工都整份載入，歷史紀錄不佔每次的 context）；agent 檔尾改為一行指標。以下為移入的原紀錄，依 agent 分組：

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
- 2026-09-01 回報判準「不自行增減」改為「不得少報＋範圍外發現必報」（範圍外發現節列舉反向終止分支、多步狀態序列、共用元件連帶影響三類）。**設計原則節本體沒有加**「反向／終止分支＋多步狀態序列＋共用元件其他使用點」——此三類情境改由 Supplier_Code 的 04 模板六【範圍展開】承擔，派 QA 時由 hook check-review-discipline.js 強制填寫（2026-10-03 更正：原紀錄誤記為設計原則已補；grep 本檔，「反向／終止分支」「共用元件其他使用點」0 筆，「多步狀態序列」只出現在回報判準的範圍外發現清單、設計原則節沒有。使用者裁定不補進 agent）。起因：三個月 79 個 session 稽核——本檔全文「回歸／既有功能／未改動範圍」零命中，且原句在制度上禁止 QA 補派工單之外的情境；同期 301 份 QA 派工單僅 16% 要求測反向分支、8% 要求逐欄驗值，使用者實測抓包的缺陷幾乎全落在派工單沒寫的那一格。配套：Supplier_Code 的 04 新增模板六、03 新增 B15、hook check-review-discipline.js 加【範圍展開】閘（經使用者核准）
- 2026-07-30 輸出格式新增回報判準（簽收表逐列三態、N 外部錨定）與 codify 完成判準（drift_check 0/0 必貼）；CATALOG 登記改 COVERAGE.md（經使用者同意，第二波落地）
- 2026-08-07 codify 完成判準加第三類「0 佔位」（drift_check 同日新增待補偵測；健檢抓到 120 列佔位債）（經使用者同意）

### Added
- 五支 agent 加「開工前必讀」節：`CLAUDE.md`（root）、`CONTEXT.md`、`FLOWS.md`（碰到已收錄鏈路才讀）；qa-engineer 另加 `tests/Project_Detail/PROJECT.md`、`tests/e2e/README.md`。回報最後一行為「已讀：…；略過：…（理由）」，與 git-commit C 軌範本一致（backend-architect 例外：已讀行放倒數第二行，最後一句仍是待簽收聲明）
- README 新增「搭配 git-commit 時的專案設定」節：說明 workspace 的 `.claude/git-commit-reviewer-addendum.md` 與 git-commit 0.10.0 以上的相依
- code-reviewer「提供修正前後的程式碼範例」加例外：git-commit C 軌派工時照派工 prompt 格式（VERDICT 行＋逐行問題），不附修正範例
### Fixed
- CHANGELOG qa-engineer 2026-09-01 紀錄更正為實際落地內容（見上方 qa-engineer.md 節）

## [0.1.2] - 2026-07-05
### Fixed
- qa-engineer 指路更新：browser-testing skill 已移除，改指 qa-webwright browser-qa＋tests/Project_Detail 專案知識層
