# Changelog

本檔記錄 qa-webwright 的版本變更，格式依 [Keep a Changelog](https://keepachangelog.com/)。

## [0.6.0] - 2026-07-06
### Changed
- Phase 2 改 draft-first：預擬 codify 草稿（grep 原始碼填真實值、拿不到標 TODO-EXPLORE）→ qa-flow.sh run 首跑收失敗清單 → 只對失敗 CP 定向探索補值（≤5 一批）；新增假綠燈紀律（禁弱化斷言/恆真/改 skip 轉綠）；任務清單 #4/#5/#6 重排，探索從起手式降為補洞手段

## [0.5.6] - 2026-07-06
### Fixed
- 修 hooks 載入失敗：plugin.json 移除多餘的 hooks 欄位——hooks/hooks.json 本就自動載入，manifest 再引用會觸發 Duplicate hooks file 錯誤導致整組 hook 失效

## [0.5.5] - 2026-07-06
### Fixed
- PROJECT.md 必讀改機械強制：新增 project-knowledge-gate（PreToolUse deny 最多兩次、FAIL-OPEN）＋ qa-early-nudge 併知識層軟提醒，先軟後硬

## [0.5.4] - 2026-07-05
### Fixed
- browser-qa 新增專案 QA 知識層約定（tests/Project_Detail/PROJECT.md 路由入口＋bootstrap PROJECT-KNOWLEDGE 訊號）；audit 加格式守門，非本 plugin 骨架的 catalog 跳過孤兒稽核防誤判改寫

## [0.5.3] - 2026-07-05
### Fixed
- browser-qa 補長流程 context 經濟規範：snapshot 節制、批次沉澱、進度落檔、compact 徵兆分段（SKILL.md Explore + pitfalls I 段）

## [0.5.2] - 2026-07-04
### Fixed
- **audit --fix 對 JS 措辭精確化**：孤兒列備註原寫「函式已不存在」，對 playwright-js（用測試標題非函式）語意不符。改為中性的「對應測試已不存在」，同時涵蓋 py（函式）與 js（測試標題）。純文字，不動判定邏輯。

## [0.5.1] - 2026-07-04
### Fixed
- **playwright-js runner 落地判定修復**：先前 `audit` 只掃 `test_*.py` 的 `def test_`、Stop hook（`qa-landing-gate.js`）落地判定只認 `test_*.py`——JS 專案即使正確落地 `*.spec.js` + junit xml，仍會被 audit 把 catalog 的 JS 列全判成孤兒（資料破壞）、被 hook 誤判「沒落地」而 block。現 `audit` 依 runner 同時蒐集 py 函式名與 js 測試標題（`test('…')`/`.only`/`.skip` 變體），hook 落地判定同時接受 `test_*.py` 與 `*.spec.js/ts`。pytest 原路徑不受影響。
  - 已知限制（邊界）：JS 測試標題含引號或用模板字串時 audit 抽取會失準（少數列可能誤判孤兒），落地判定本身不受影響（認副檔名）。
- **落點基準防呆**：寫入端（`qa-flow.sh` WORKSPACE_DIR）與稽核端（`qa-landing-gate.js` cwd）定位優先序刻意不同（hook 以 harness `input.cwd` 為首選、防 AI `export CLAUDE_PROJECT_DIR` 蓋掉稽核基準）。兩處加互指註解「改一處要改兩處」，並載明正常情況下兩端同源。

## [0.5.0] - 2026-07-03
架構強化版：紅藍對抗（architecture 面向）挖出多個結構性盲點，逐項修補。

### Added
- **`qa-flow.sh audit [--fix]`**：核對 catalog 的「對應測試函式」欄 vs `tests/e2e/` 內實際存在的 `def test_`，揪出孤兒列（函式已消失＝catalog 漂移成看似權威的錯誤索引）；`--fix` 把孤兒列標 ❌未覆蓋（不刪列）。`bootstrap` 結尾自動跑一次（只警告），把漂移暴露在每次 QA 起點——SSOT 防漂移由自律升為機械化
- **`bootstrap` 環境自檢**：偵測 node（缺→醒目警告「Stop hook 落地強制在本機不會生效」）與 pytest 執行方式，避免同事機器缺依賴導致他律靜默失效
- **`bootstrap` 舊版 catalog 遷移**：偵測 0.3.1 時代 root 落點的 `catalog.md`（含本 plugin 表頭）→ 搬移或合併去重到 `tests/e2e/`，舊檔改名 `.migrated-<date>`
- **PostToolUse hook `qa-early-nudge.js`**：第一次用瀏覽器工具、且尚未 scaffold 時注入提示引導先走落地流程（remind-once、fail-open），把「測完才發現無法沉澱」的浪費擋在發生前（他律不再只在 Stop 才生效）
- **`hooks/test-gate.mjs`**：hook 回歸測試（合成 fixtures + 真實語料 + 委派/長 session 情境），改 hook 後 `node hooks/test-gate.mjs` 一鍵驗證誤擋/漏擋

### Fixed
- **【HIGH】委派即隱形**：Stop hook 原只掃主 transcript，主 Agent 把瀏覽器 QA 委派給 subagent（`Agent` 工具）時，實際 tool_use 記在獨立的 `subagents/*.jsonl`，主檔看不到 → 整套他律歸零放行。現掃描納入 subagent transcripts。同時修 `hasQaTrigger` 只認 `Task`（真實工具名是 `Agent`）的死碼
- **【MEDIUM】長 session enforcement 靜默關閉**：hook 原只讀尾 2MB，長 session 前段的瀏覽器操作被截斷漏看 → 放行。改為全檔逐行 streaming 掃描（分塊 + 跨塊行緩衝 + early-exit + 記憶體防線），fail-open 不變
- `qa-flow.sh run` 守門員 canonical 比對改「任一解析失敗→放行不誤擋」（移除舊的 fallback 到原始字串比對，那是 Windows temp/短檔名/junction 誤擋合法落點的來源）；字串層落點鎖定仍在，canonical 只多抓 symlink 逃逸

### Changed
- **兩階段設計誠實化**：實戰顯示 qa-engineer 設計階段常被跳過而 hook 照樣全綠（閘保產物 floor、文檔賣品質 ceiling 的落差）。SKILL/README 明寫「機械保證僅及產物層，測試設計品質屬建議流程、無法機械強制」；hook 的 block/warn（僅本來就要提醒時）追加一句「未偵測到 qa-engineer 設計階段」的零噪音提示
- `qa-flow.sh run` 的 `<date>` 參數改為可省略（預設今天）——確定性資訊不交給 AI（曾有 AI 傳字面 `<date>` 佔位符）

### Note
- qa-flow.sh 與兩個 hook 的邏輯改動經 Codex 多輪對抗審查；hook 修掉一個 fail-open 破口（來源讀到一半失敗被誤當「掃完沒命中」而進 block/warn）；qa-flow 修掉「bootstrap 吞掉 audit 真失敗」與「migrate 誤搬使用者 catalog」兩處。架構強化經紅藍對抗 R1→R2 複驗收斂（R2 零新 ≥MEDIUM 弱點）
- **已知取捨（ACCEPT）**：`run` 守門員的 symlink 逃逸偵測採 fail-open——canonical 路徑解析失敗時放行（不誤擋）。字串層已擋所有非 symlink 逃逸（絕對路徑 / `..` / tests-e2e 外）；殘餘風險僅「Linux/Mac 建了真 symlink 且 realpath 剛好失敗」的極窄縫。此取捨源於 Windows temp/短檔名/junction 曾誤擋合法落點的實際痛點，寧可漏擋不誤擋

## [0.4.1] - 2026-07-02
### Added
- `qa-flow.sh run` 自動偵測 pytest 執行方式（pytest / python -m pytest / python3 / py）——Windows 無 pytest 命令時免自建 shim；強制 `PYTHONIOENCODING=utf-8` 避免中文輸出 UnicodeEncodeError
### Changed
- Stop hook `hasQaTrigger` 加認「執行過 qa-flow.sh 子命令」為觸發（抓「跑了流程卻漏 catalog 回填」），並排除 echo/grep 等「提及非執行」誤判
- BLOCK 與 WARN 改共用提醒計數（上限 2 次，第 3 次靜默）；偵測到落地即重置計數（下一輪新 QA 又有完整額度）

## [0.4.0] - 2026-07-02
### Added
- 內建 Stop hook `qa-landing-gate.js`（他律強制落地）：觸發 QA + 用瀏覽器工具 + 無落地產物（test_*.py / reports/*.xml / catalog 有資料列）→ 硬擋；FAIL-OPEN 設計（任何自身失敗→放行，絕不卡死 session），經 3 輪 Codex 對抗審查。plugin.json 宣告 `hooks`
- 純 prompt 的 MANDATORY 規範擋不住 AI 跳過整個流程手動測，此 hook 是繞不過的他律兜底

## [0.3.5] - 2026-07-02
### Added
- `qa-flow.sh run` 落點守門員：測試檔實體路徑不在啟動目錄的 tests/e2e/ 下（鑽子目錄）→ 報錯擋下
### Changed
- 明訂 `CLAUDE_PROJECT_DIR` 必須設為環境的 Primary working directory、禁止 AI 自改成子目錄；README 加「你在哪啟動就落在哪」對照表

## [0.3.4] - 2026-07-02
### Changed
- 明訂「把 CP 沉澱成 runner」為核心必做，禁止問使用者「要不要沉澱」；唯一可問的是 greenfield 空目錄的環境安裝同意

## [0.3.3] - 2026-07-02
### Changed
- 測試計畫輸出改單一 TC 表（TC / 情境 / 操作步驟 / 證據 / 預期 / 需求，每列一條）；覆蓋矩陣與紅隊漏測複查轉為設計內部動作、不寫進交付輸出

## [0.3.2] - 2026-07-02
### Changed
- catalog.md 落點從 session 根目錄改到 `tests/e2e/`（與它索引的 test 檔 / report 同層）；Phase 1 計畫固定輸出格式，統一各次產出

## [0.3.1] - 2026-07-01
### Added
- 擴充 QA 觸發詞，涵蓋「執行 / 跑 / 存測試案例」「跑 e2e / 端對端」「回歸測試」等自然語意圖

## [0.3.0] - 2026-07-01
### Added
- 新增 `qa-flow.sh` 機械閘（bootstrap / scaffold / run / catalog）：落點鎖 `CLAUDE_PROJECT_DIR`、防假綠燈 grep、catalog 機械回填——把「一定要落地的動作」從純 prompt 規範改為腳本強制
- SKILL.md Phase 2 強制 TaskCreate 8 步清單
### Changed
- 沉澱載體固定優先 pytest-playwright（既有別的 runner 或使用者不同意裝 Python 才退而 JS）

## [0.2.x] - 2026-06
### Note
- 早期方法論成形期：情境覆蓋索引（§0.5）、落地路徑白話化、多輪對齊稽核與紅藍對抗修內部一致性（詳見 git log）
