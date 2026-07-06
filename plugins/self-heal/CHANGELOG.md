# Changelog

本檔記錄 self-heal 的版本變更，格式依 [Keep a Changelog](https://keepachangelog.com/)。

## [0.3.0] - 2026-07-06
### Changed
- 補終止機制：kill-switch 旗標檔 ~/.claude/self-heal.off——hook 開頭讀旗標存在即靜默（程式強制、fail-open），SKILL 核心循環第 0 步加使用者喊停優先於一切不續設；「終止/恢復 self-heal」觸發詞入 description

## [0.2.3] - 2026-06-28
### Changed
- README 補痛點/價值 hook；SKILL 加「malformed 根因分診」段

## [0.2.2] - 2026-06-27
### Fixed
- SKILL加可照抄的續設tool call範本

## [0.2.1] - 2026-06-27
### Fixed
- 續設prompt用固定通用短語免malformed

## [0.2.0] - 2026-06-27
### Changed
- 喚醒先續設下一棒保接力鏈不斷+換工具通道守則
