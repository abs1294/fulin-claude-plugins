# Changelog

本檔記錄 git-commit 的版本變更，格式依 [Keep a Changelog](https://keepachangelog.com/)。

## [0.1.6] - 2026-07-20
### Fixed
- 敏感字掃描新增 CREDENTIAL_SHAPE_PATTERN 不可豁免硬閘：抓 OAuth client_id/GOCSPX secret/refresh_token/ya29 access token/AIza API key/PEM 私鑰的憑證特徵字串，命中即拒 commit 且 --allow-sensitive 不放行（關鍵字會誤命中、憑證形狀不會），輸出遮蔽值防二次外洩

## [0.1.5] - 2026-07-09
### Fixed
- README 補前置依賴段（git CLI、bash/Git Bash、選用 codex plugin＋降級說明）

## [0.1.4] - 2026-07-04
### Fixed
- **push 失敗有結構化處置，不再靜默掛住或誘發裸 git**：`ship` 的 `git push` 原為裸呼叫，失敗時被 `set -e` 直接中止，留下「已 commit、未 push」懸置狀態卻無下一步，AI 易自行裸跑 `git pull`／`push -f`。現用 `if git push` 包住，失敗分支明講狀態、指引 `pull --rebase`、**明確禁 force/-f**、保留 diff hash（未達完成不清）、以非 0 結束。
- **local-overrides 多 repo 撞鍵**：`parse_overrides_for_repo` 原只用 `repo:` 的值匹配，多個區塊都寫 `repo: .`（單 repo 常態）時會被視為同一 repo 而合併、互相污染清單。現改以「頂層 YAML key（天生唯一）或 `repo:` 值任一命中」匹配，範本說明頂層 key 才是識別鍵；向後相容既有 `repo:` 值寫法。

### Added
- **Codex 軌不可用時的降級規範 + 三軌 timeout**：SKILL.md 原教了 `subagent_type` 正確寫法，卻沒說 Codex 軌根本叫不到（未裝/環境缺）時怎麼辦。補：確認叫不到後降為單軌（B 軌記 `skipped: codex-unavailable`、預覽明講少一道）、A+B 兩軌都失效則不可自動 commit 須人工確認；background 審查軌逾時不無限等，告知使用者選「續等或以現有結果決策」，禁逾時自動當 PASS。

## [0.1.3] - 2026-07-04
### Fixed
- **署名防護從「假機制」升為真閘（機制級攔截）**：先前 `flow.sh` 僅在 commit 附近寫註解「HEREDOC 內禁止任何 AI 署名」，文件三處聲稱「腳本內已過濾」，但實際上 `$desc` 原樣進 commit、零過濾——屬「文件謊報機制存在」，比單純沒做更危險。現 `ship` 在 commit 前實際攔截（`assert_no_signature`）：命中 `Co-Authored-By|Generated with Claude|🤖|noreply@anthropic|Claude Code` 即 `exit 1` 不 commit；並拒絕多行 commit message（署名常見夾帶載體）。
- **敏感字掃描從「只印不擋」升為真閘**：先前 `analyze` 命中敏感字只 `echo HITS` 後正常結束、`ship` 不重掃，能否攔截全靠 AI 自願讀輸出。現 `ship` commit 前重掃 staged diff，命中即 `exit 1`，除非顯式帶 `--allow-sensitive`。`analyze` 仍為提示用途。

### Added
- **TOCTOU 防護（diff hash 校驗）**：`prepare` 記錄被審查的 staged diff hash，`ship` 重算當下 staged diff hash 並比對，不符即拒——確保實際 commit 的內容就是三軌審查看過的那份，防「審查後偷改 index 掉包」。commit+push 成功後自動清理該 hash。

### Changed
- 頂部語義說明與 `--help` Notes 改為與實作相符：明列 ship 會機制級攔截署名/敏感字/diff 掉包，不再只是「規範」宣稱。
