# Changelog

All notable changes to this plugin will be documented in this file.

## [0.2.0] - 2026-09-15
### Changed
- 稱呼甲方一律用「您們」（單一窗口用「您」），不用公文式敬稱（貴司、貴公司、貴中心…）；SKILL.md 補上此規則，範例專案 JSON 的專案定義同步改寫。

## [0.1.1] - 2026-09-01
### Fixed
- 補上 plugin 描述（原為 adopt 時的佔位字串）。

## [0.1.0] - 2026-08-18
### Added
- 首版。產生「寓意科技」格式的正式軟體開發報價單 .docx：套用已脫敏的公司標準模板（標題樣式、表格框線、欄寬字型、乙方資料、通用條款全部內建），只需提供該案的客戶資料與專案 JSON，服務明細列依階段自動展開、含稅總計自動計算（`scripts/build_quote.py`、`assets/quote_template.docx`、`assets/example_project.json`）。
