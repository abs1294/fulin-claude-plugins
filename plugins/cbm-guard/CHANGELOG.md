# Changelog

All notable changes to this plugin will be documented in this file.

## [0.1.0] - 2026-09-22
### Added
- 首版。codebase-memory-mcp 查詢的機械閘：PreToolUse hook（`hooks/guard-cbm-query.js`）在查詢當下攔截五類已知會誤導的用法——EXISTS 綁定變數位置錯導致結果恆為全部或零且不報錯、計數沒跑對照組、節點數被當成實體數、孤兒查詢高估、Route 節點在 attribute routing 框架下建不出來。
- 泛化框架反射入口（MediatR Handle／EF Core Configure／Spring @Component／Angular ngOnInit 等），避免被誤判成死碼。
- 索引新鮮度檢查 `scripts/cbm_index_freshness.py`：cbm 的查詢結果不帶新鮮度標記，對過期索引查會拿到已刪除的檔案且看起來完全正常。
- 專案相依部分走 `cbm-guard.config.json`（範本 `cbm-guard.config.example.json`），零設定亦可用（五類通用判準全開）。
- 使用說明 skill `cbm-usage`。
