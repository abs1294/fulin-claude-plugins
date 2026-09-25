# qa-webwright

**讓 Claude 幫你測網頁功能，而且每次都能重跑、看的是真證據不是截圖——測完留下一支可重複執行的測試，下次改壞了馬上抓得到。**

要 AI 測網頁，常見的痛是：它跑一遍「看起來沒問題」就說過了，但你無法重跑、也不知道它到底驗了什麼；日期、時區、下拉選單這種細節最容易漏。qa-webwright 把一套成熟的 QA 方法論裝進 Claude Code，讓它**先設計測試計畫、再實際操作網頁驗證、最後把每個關鍵檢查點變成一支可重跑的自動化測試**——驗的是後端回傳的業務碼、頁面真正讀回的值，不是截圖看圖說故事。

## 能幫我做什麼

- **不只測一次**：測完沉澱成可重跑的測試腳本（**固定優先 pytest-playwright**），之後回歸隨時重跑。
- **一定會落地檔案**：`qa-flow.sh` 把「建測試骨架 / 出 junitxml 報告 / 防假綠燈驗證 / 登記情境覆蓋」鎖進腳本，
  落點鎖 session 起始目錄（不鑽子專案目錄），不再有「測完只印對話、沒留下任何檔」的情形。
- **三層登記（0.9.0 起新專案預設）**：情境知識、執行事實、索引分開放——`<模組>/COVERAGE.md` 手寫情境正本、
  `.runs/results.sqlite` 由 pytest hook 自動記下每支測試最後一次跑的結果、`CATALOG.md` 由腳本生成。
  「測試寫了沒登記／登記了測試卻沒了／情境欄還是待補」三種漂移每次 pytest 結束都印出來，codify 完成判準是 drift 0/0/0。
- **測試資產衛生閘**：寫測試碼的當下就擋「寫死業務 Id、直接 INSERT 業務表、寫死帳號、借一筆現成資料、沒資料就 skip」——
  這些寫法換一個庫、換一顆 token、清空業務資料就全垮，而且平常都是綠的。
- **內建 hook 他律強制**：光靠 SKILL 裡寫「必須落地」擋不住 AI 用通用 Playwright MCP 手動測完就口頭回報。本 plugin 用 hook 兜底（裝即生效，不需改 settings.json），見下方「hook 一覽」。
- **驗真證據**：用 API 回傳碼 / 頁面讀回值 / 資料來源比對來判定通過，不靠人眼看截圖。
- **覆蓋容易漏的細節**：內建必測 checklist、測試資料規範，特別處理日期欄位的「畫面 / 送出 payload / 資料來源 / 重新整理後」四點一致性。
- **跨專案、跨平台**：方法論不綁特定網站或技術棧；腳本與工具同時支援 Windows（Git Bash）與 macOS（內建 bash 3.2＋BSD 工具＋python3），Linux 順帶。

> **載體中立**：本 plugin 的價值在「測試設計方法論」，**不綁特定執行工具**。沉澱端用專案既有的 runner
> （首選 pytest-playwright）。[webwright](https://github.com/microsoft/webwright) 是**選用的備用探索器**——
> 僅當需打「真實外部站（無 a11y、Akamai/H2 封 Chromium、長程未知路徑）」時才裝它做一次性探索，
> 探索完一律 codify 成 runner，回歸端永遠不是 webwright。本機自家系統有 a11y、有後端可攔，**不需要** webwright。

## 內容

```
qa-webwright/
├─ .claude-plugin/
│   └─ plugin.json              plugin manifest
│       （marketplace.json 在 monorepo root 的 .claude-plugin/，統一註冊各 plugin，不在本 plugin 內）
├─ agents/
│   └─ qa-engineer.md           QA Agent：一手包設計測試計畫＋自行執行瀏覽器測試＋codify＋出報告＋登記情境
├─ hooks/
│   ├─ hooks.json               Stop + PreToolUse + PostToolUse hook 宣告（裝 plugin 即生效）
│   ├─ qa-landing-gate.js       Stop 落地強制閘：觸發 QA 後用了瀏覽器卻沒落地產物就擋（認三層與舊版單一 catalog）
│   ├─ qa-early-nudge.js        PostToolUse 早期提醒：首次用瀏覽器且未 scaffold 時提示先走落地流程（remind-once）
│   ├─ project-knowledge-gate.js PreToolUse 知識層閘：專案有 tests/Project_Detail/PROJECT.md 而未讀就 deny 瀏覽器呼叫
│   ├─ guard-test-asset-hygiene.js PostToolUse 衛生閘：寫 tests/e2e/**/*.py 當下跑硬編／漂移／skip 檢查（有參數檔才啟動）
│   ├─ guard-qa-dispatch.js     PreToolUse 派工表態閘：派 qa-engineer 的派工單缺格就 deny（參數檔 dispatch_gate）
│   ├─ guard-qa-before-commit.js PreToolUse commit 前 QA 閘：行為類改動 commit 要帶 QA 表態（參數檔 commit_gate，預設關）
│   ├─ guard-pretest-env.js     PreToolUse 跑測前閘：環境變數對齊＋副作用防線（參數檔 pretest）
│   ├─ guard-command-rules.js   PreToolUse 指令守門：參數化 when/deny/require/require_env（參數檔 command_guards）
│   ├─ guard-report-output.js   PreToolUse 報告落點閘：交付根層不放檔、過程檔進 _work/（參數檔 report_hygiene）
│   ├─ guard-browser-nav.js     PreToolUse 瀏覽器導向守門：禁正式站、對 host 限速（參數檔 browser_guard）
│   ├─ lib/qa-gate-common.js    六支 PreToolUse 閘共用：找參數檔、shell 指令解析、deny 輸出
│   ├─ test-gate.mjs            hook 回歸測試（改 hook 後 `node hooks/test-gate.mjs`）
│   ├─ test-gate-pretool.mjs    六支 PreToolUse 閘的回歸案例（由 test-gate.mjs 匯入）
│   └─ test-gate-fixes.mjs      送審修正的回歸案例（每案例帶審查 ID；由 test-gate.mjs 匯入，也可單獨依 ID 篩選）
├─ commands/
│   ├─ qa-plan.md               /qa-webwright:qa-plan — 設計測試計畫
│   └─ qa-run.md                /qa-webwright:qa-run — 派 qa-engineer agent：預擬草稿 → 首跑 → 定向探索補值 → 驗證
├─ tests/                       plugin 自測（pytest；在暫存目錄建假專案實跑）
└─ skills/
    └─ browser-qa/
        ├─ SKILL.md             方法論：兩階段流程、critical-point 對映、報告格式
        ├─ qa-flow.sh           流程腳本：bootstrap / scaffold / run / catalog / audit / tools-sync / migrate
        ├─ tools/               測試資產工具（scaffold 時複製進專案 tests/e2e/tools/，第一行帶版本標記）
        │   ├─ qa_config.py          讀專案參數檔 tests/e2e/qa-webwright.json（缺檔走預設、壞檔明確報錯）
        │   ├─ baseline.py           所有稽核工具共用的存量豁免（--baseline / --write-baseline --why）
        │   ├─ qa_pytest_plugin.py   pytest 掛點：sqlite 執行紀錄、A/D skip 閘、drift 摘要、環境閘
        │   ├─ runs_db.py            .runs/results.sqlite 執行事實層
        │   ├─ coverage_md.py        COVERAGE.md 解析（三層共用）
        │   ├─ gen_catalog.py        生成 CATALOG.md（含自檢、鎖定 bug 節由 COVERAGE 匯集）
        │   ├─ drift_check.py        孤兒／幽靈／佔位漂移檢查
        │   ├─ make_skeleton.py      為資料夾產骨架 COVERAGE.md
        │   ├─ fill_orphans.py       把孤兒補成佔位列
        │   ├─ coverage_register.py  qa-flow.sh catalog 的三層實作（原子寫入）
        │   ├─ migrate_catalog.py    舊版單一 catalog → 三層（列數對帳）
        │   ├─ skip_audit.py         skip 四分類（中英文判準、AST 只抓執行期 skip）
        │   ├─ hardcode_check.py     測試資料硬編檢查（A/B/C/E/E'/F/F'/G/H/H'）
        │   ├─ i18n_locator_check.py 顯示文字定位器檢查（字元類可參數化）
        │   ├─ env_gates.py          port 歸屬閘／fixture 圖環境檢查／探測覆寫約定
        │   ├─ sweep_residue.py      測試殘留清掃（前綴標記、dry-run 預設、DB 連線可插拔）
        │   └─ run_by_folder.py      逐資料夾跑 pytest、以 junit 逐筆計數
        ├─ lib/install_tools.py 工具複製／版本比對（scaffold、tools-sync 用）
        ├─ templates/
        │   ├─ qa-webwright.example.json  專案參數檔範例
        │   └─ conftest_snippet.py        conftest 掛點片段
        ├─ methodology/         方法論（穩定、不綁技術棧）
        │   ├─ test-plan-design.md   覆蓋矩陣 / 必測 checklist / TC 格式 / 測試資料原則 / 探索七類 / 失敗注入
        │   ├─ critical-points.md    TC 預期 → critical point → assert 對映；五條硬規則
        │   ├─ test-discipline.md    核心鐵則（選單導航、mock 在就不准 skip、測試庫可破壞）、不打斷、副作用邊界
        │   └─ test-asset-hygiene.md 三層登記與 drift、skip 四分類紀律、xfail 鎖定、G 類五種 safe 性質、直寫 DB 判準框架
        └─ knowledge/           知識庫（踩過的雷與領域知識，持續 append）
            └─ pitfalls.md           A～N 段（後端驗證、日期時區、壞值、Windows 啟動、元件、state、webwright、H2 指紋、
                                     長流程 context、定位與多語系、等待時序、斷言盲區、種子與共用狀態、多實例環境）
```

> **方法論 vs 知識庫**：`methodology/` 是穩定、跨專案不變的「怎麼做」；`knowledge/` 是會長大的
> 「踩過的雷」，每測一次踩到新坑就 append 一條，並依目標專案技術棧選用。兩者分開維護。

## 機械保證的邊界（先讀這段）

本 plugin **機械強制的有三層**：
- **產物層**——測完必須在 `tests/e2e/` 留下可重跑的 `test_*.py` + junitxml 報告 + 情境登記（由 `qa-flow.sh` 落地 + Stop hook 兜底）。
- **測試資產衛生層**（專案有 `tests/e2e/qa-webwright.json` 時）——寫測試碼當下擋新增的硬編、漂移、A/D 類 skip；
  pytest 整輪遇到執行期 A/D 類 skip 直接判失敗。
- **流程紀律層**（專案參數檔有對應段時）——派 qa-engineer 的派工單表態、行為類 commit 前 QA 表態、跑測前環境對齊與副作用防線、
  高風險指令寫法、交付資料夾落點、瀏覽器導向正式站與高頻導向，六支 PreToolUse 閘在動作發生**之前**擋下。
  這些閘只驗「有沒有表態／寫法對不對」，不判表態內容是否正確。

**測試設計「品質層」**（覆蓋矩陣是否窮盡、證據是否夠強、是否真走兩階段 qa-engineer 設計）**由方法論引導，屬強烈建議、無法機械強制**——品質本質上是 AI-complete，硬加閘只會製造噪音。所以：產物一定會有，但「測得好不好」仍需你把關。

## 三層登記架構

| 層 | 檔案 | 誰寫 | 內容 |
|---|---|---|---|
| 1 情境正本 | `tests/e2e/<模組>/COVERAGE.md` | 人（或 `qa-flow.sh catalog`） | 白話使用情境、對應 `檔.py::函式`、覆蓋 ✅/⚠️/❌、🔒 鎖定 bug、xfail/skip 說明 |
| 2 執行事實 | `tests/e2e/.runs/results.sqlite` | pytest hook（conftest 掛點） | 每支測試每次執行的結果、批次名（`QA_BATCH`，相容 `E2E_BATCH`） |
| 3 索引 | `tests/e2e/CATALOG.md` | `tools/gen_catalog.py`（不准手改） | 各資料夾情境數、函式數、✅⚠️❌、最後執行日期／批次／通過失敗、漂移數、鎖定 bug 匯總 |

- 模組＝`tests/e2e/` 第一層、含 `test_*.py` 的子目錄；直接放在 `tests/e2e/` 根的測試歸「根資料夾」（COVERAGE 在 `tests/e2e/COVERAGE.md`）。
- 漂移三類：**孤兒**（有測試沒登記）、**幽靈**（登記了 `檔.py::函式` 但函式不存在；跨資料夾引用不算）、**佔位**（某格整格等於「待補」）。
- 舊版單一 `catalog.md`（4 欄）專案維持相容；`qa-flow.sh migrate` 一次轉成三層（列數對帳、舊檔改名保留，不刪）。

## 專案參數檔 `tests/e2e/qa-webwright.json`

所有工具一律讀這份，不寫死專案值（範例：`skills/browser-qa/templates/qa-webwright.example.json`，`scaffold` 會自動建立）。
缺檔時工具走內建預設並提示一行；檔案壞掉（非 JSON、型別錯）一律 exit 2 明確報錯。以 `_` 開頭的 key 視為註解。

| key | 用途 | 預設 |
|---|---|---|
| `test_data_prefix` | 測試造的資料名稱前綴（殘留清掃依此定位） | `E2E-` |
| `intentional_prefixes` | 刻意值命名慣例（測 not-found／佔位），hardcode_check 不列 | NONEXISTENT／PLACEHOLDER／MISSING／NOT_FOUND／INVALID／FAKE／DUMMY／BAD |
| `fake_identity_prefixes`／`fake_email_domains` | 測試自己捏的假帳號／信箱網域 | QA／E2E／ZZ／MOCK／DUMMY／FAKE／TEST；example.com 等 |
| `biz_tables`／`skeleton_tables` | 業務主體表（E/H 類）／骨架字典表（E' 類） | 空 |
| `ports` | port 歸屬閘要查的 port（`port` 或 `url_env`） | 空 |
| `residue.targets`／`db.connector` | 殘留清掃登錄表／可插拔 DB 連線（`sqlite:<路徑>` 或 `module:factory`） | 空／null |
| `coverage.*`／`catalog.file` | COVERAGE 檔名、表頭字面值、佔位字面值「待補」、鎖定節與 xfail 節關鍵字／CATALOG 檔名 | 見範例 |
| `external_system_keywords` | E 類整檔豁免時，理由必須落在的四類「產品端沒有入口」外部系統邊界 | 簽核回呼／上游推送／外部主檔／目錄服務 |
| `data_source_tags` | 【測試資料來源】理由段標記 | `【測試資料來源】`、`[test-data-source]` |
| `skip_classify.{A,B,C,D,D_exclude}` | skip 分類的專案擴充關鍵字（與內建中英文預設合併） | 空 |
| `skip_gate` | 執行期 A/D 類 skip 讓整輪 exit 非 0 | true |
| `env_requirements` | fixture → 必要環境變數（依 fixture 圖判定） | 空 |
| `i18n.*` | 定位器檢查開關、是否當 hook 閘、字元類、切語系關鍵字 | enabled、不當閘、CJK |
| `hardcode.*` | Id 常數後綴、字典類排除、參考類升阻擋、帳號語境、身分反查樣式、自種樣式、共用層目錄 | 見範例 |
| `hook.enabled` | 本 plugin 參數檔驅動之閘的總開關（寫入衛生閘＋六支 PreToolUse 閘＋專案知識閘；false＝全部靜默）。Stop 落地閘與早期提示不受此開關（落地閘是「測試要落地」的強制機制，不能由專案參數檔關掉） | true |
| `dispatch_gate` | 派 qa-engineer 的派工單表態閘（見下方「PreToolUse 閘」） | 未設＝靜默（範例：開啟） |
| `commit_gate` | 行為類改動 commit 前的 QA 表態閘 | `enabled:false`（範例：開啟） |
| `pretest.{alignment,side_effect_guards,test_command_regex}` | 跑測試前的環境對齊／副作用防護 | 空＝靜默（範例規則放在 `_…_example` 註解欄） |
| `command_guards` | 參數化指令守門（when／deny／require／require_env） | 空＝靜默（範例：高權限 DB 帳號禁止生效、服務啟動環境名示範 `enabled:false`） |
| `report_hygiene.{roots,process_ext_regex,work_dir}` | 交付資料夾紀律 | roots 空＝靜默（範例：`tests/reports`） |
| `browser_guard.{deny_hosts_regex,rate_limits}` | 瀏覽器導向守門：禁止導向正式站、對 host 限速 | 未設＝靜默（範例：佔位正式站網域＋每 host 10 秒 30 次） |

閘規則段的第二層型別（如 `commit_gate.enabled` 必須是 bool、`command_guards[i].when_regex` 必填）由工具端 `qa_config.py` 檢查，
型別錯一樣 exit 2 明講；hook 端讀到壞設定則 fail-open、完全靜默（不因設定寫錯把人鎖住）。

## 跳脫機制總表（合法例外怎麼宣告）

| 機制 | 寫法 | 適用 | 放行條件 |
|---|---|---|---|
| 刻意值命名 | 名稱含 `intentional_prefixes`（如 `BAD_ORDER_ID`、`NONEXISTENT_USER`） | A、F | 命名即宣告；hook 提示與工具實作讀同一份清單 |
| 假身分前綴 | `QAUSER1`、`bob@example.com` | F | 前綴／網域在參數檔清單內 |
| 註解與 docstring | 說明文字裡提到違規寫法 | A、B、E、F、H | 一律不計（C 類除外：它本來就靠註解字樣） |
| `# SCAN-REVIEWED: safe — <理由>` | 命中行上方最多 4 行連續註解，或所屬函式 docstring | 全部類別 | 結論 safe 且理由至少 4 字；`real` 照列（附註記）；缺理由／結論錯列入「覆核註記格式錯誤」 |
| `# G-REVIEWED: safe — <產品端證據>（YYYY-MM-DD）` | 同上 | G | 需證據與日期；缺一不放行 |
| 【測試資料來源】理由段 | 檔頭 docstring 寫明為何只能 SQL 自種 | E（整檔） | 三條全中：可辨識自種（取回自動 Id／前綴／marker／條件式精準刪）＋對稱清理＋理由落在外部系統邊界 |
| `finally:` 內寫入 | teardown 還原 | E | 結構上即還原 |
| 收集期 skip | `@pytest.mark.skipif(<具名條件>, reason=…)` | skip 閘 | 開跑前就決定的 skip 不計入 A/D 閘 |
| `# portable-ok: <理由>` | `.sh` 行內 | 可攜性掃描 | 理由至少 4 字 |

## baseline（存量豁免）用法

存量違規不可能一次清完，全量零容忍的閘會永遠告警而被關掉。四支稽核工具（hardcode_check／drift_check／skip_audit／i18n_locator_check）共用同一套 baseline：

```bash
cd tests/e2e
python3 tools/hardcode_check.py all --write-baseline --why "初始存量：42 處寫死 Id"   # 記下存量
python3 tools/hardcode_check.py orders --baseline                                   # 只擋新增（hook 就是這樣跑）
python3 tools/hardcode_check.py all --write-baseline --why "清掉 orders 的 5 處"     # 清完重產，水位下降
python3 tools/hardcode_check.py all --write-baseline --why "判準改了，指紋重算" --allow-raise
```

保護（寫在 `tools/baseline.py`）：`--why` 必填；集合差有新增就拒寫（總數下降不代表沒有新增）；只能對 `all` 重產（部分掃描會抹掉其他範圍的指紋）；指紋不含行號；JSON 記 `generated_at`／`count`／`prev_count`／`why`。
**baseline 檔壞掉（不是 JSON、fingerprints 不是字串清單）≠ 沒有 baseline**：`--baseline` 明確報錯 exit 2（印 `QA-TOOL-RESULT: baseline-error`，寫入衛生閘據此擋下）；`--write-baseline` 拒寫，除非加 `--allow-raise` 並在 `--why` 說明。
直接用 Write／Edit 改 `tests/e2e/_reports/*-baseline.json` 時，寫入衛生閘會提示改用 `--write-baseline`（擋不掉已發生的寫入；刪檔與手改屬已知限制，見文末）。
⚠ baseline 模式沉默不代表水位是 0——看真實水位跑不帶 `--baseline` 的那次。

## hook 一覽

| hook | 事件 | 做什麼 | 失敗時 |
|---|---|---|---|
| `qa-landing-gate.js` | Stop | 觸發 QA 後用了瀏覽器、卻沒在 `tests/e2e/` 留下測試＋報告＋情境登記 → 擋下要求補落地（上限 2 次、落地即重置；掃 subagent transcripts） | fail-open |
| `qa-early-nudge.js` | PostToolUse（瀏覽器工具） | 第一次用瀏覽器且尚未 scaffold → 提示先走落地流程（remind-once） | 靜默 |
| `project-knowledge-gate.js` | PreToolUse（瀏覽器工具） | 專案有 `tests/Project_Detail/PROJECT.md` 而未讀 → deny 瀏覽器呼叫（上限 2 次） | fail-open |
| `guard-test-asset-hygiene.js` | PostToolUse（Write／Edit／MultiEdit／NotebookEdit） | 寫 `tests/e2e/**/*.py`（`tools/` 除外）當下對該資料夾跑 hardcode_check／drift_check／skip_audit（i18n 依參數檔）皆帶 `--baseline`；有新增、或 baseline 檔壞掉 → exit 2 回饋給模型；直接改 `_reports/*-baseline.json` → 提示改用 `--write-baseline`。**只有專案存在 `tests/e2e/qa-webwright.json` 才啟動，否則完全靜默**；只代跑本 plugin 版本的工具（缺哪支略過哪支）；全部子程序共用 150 秒預算（低於 hooks.json 的 180 秒）；參考類提示每 session 最多 3 次 | fail-open（工具崩潰、逾時、找不到 python、預算用完一律放行） |
| `guard-qa-dispatch.js` | PreToolUse（Agent／Task） | 派 `qa-engineer`（subagent_type 以 qa-engineer 結尾）時驗派工單表態：【增量分流】【目標環境】【測試資料來源】第一行開頭「選 a／b／c」（理由與證據只讀作答段：到空行或 a./b./c.／（／⛔ 說明行為止）（b 只限外部系統邊界，且附產品端「檔名:行號」證據）、【範圍外發現】、親自執行不得轉派、【開工前對齊】、【範圍展開】四格、【欄位級驗證】、必讀清單；缺項一次列完 deny。參數檔 `dispatch_gate` | fail-open |
| `guard-qa-before-commit.js` | PreToolUse（Bash／PowerShell／Skill） | 真的在執行的 `git commit`（`commit-tree` 等底層子命令不算；`cd a && cd b`、`git -C a -C b` 逐段累積；`-a`、`git commit <path>`、同指令先前的 `git add <path>`／`-A` 都算進要 commit 的內容）、`commit_gate.extra_commands`、`git-commit` Skill：要 commit 的內容含行為類檔 → 必須帶 QA 表態（`require_sediment` 時另要「新 QA 坑」表態）。註解／引號內／heredoc 本文提到不算。參數檔 `commit_gate`（**未設＝關閉**；但 scaffold 建立的參數檔（範例）是開啟的，見下方「PreToolUse 閘」） | fail-open（git 無法啟動或逾時也放行）；git 讀不到 staged（非 repo）或 repo 指向解析不出（變數、`cd ~`）時要求表態——shell 與 Skill 兩條路徑同一套 |
| `guard-pretest-env.js` | PreToolUse（Bash／PowerShell） | 指令真的在跑 pytest（引號包住的 `"pytest"` 也算）／在指令位置的 `qa-flow.sh run`／`test_command_regex` 時：環境變數對齊（inline → source 檔 → process env 三來源；`must_be_under` 的路徑先展開 `$PWD`／`${VAR}`／`~`、Git Bash 的 `/c/…` 轉原生；`equals_process_file`／`under_process_root` 對照**該 port 上此刻在跑的 process** 實際讀的檔與專案根：Windows 用 netstat＋CIM、macOS／Linux 用 lsof／ps，查不到就略過）與副作用防線檔檢查；`--collect-only`／`--fixtures`／`-h`、heredoc、echo/grep 提及放行；拒絕訊息裡的值一律遮罩（只露長度與前後 2 字元）。參數檔 `pretest` | fail-open；**防線檔讀不到＝擋** |
| `guard-command-rules.js` | PreToolUse（Bash／PowerShell） | 指令符合 `when_regex` 時，命中 `deny_regex`、缺 `require_regex`、`require_env` 沒設 → deny。參數檔 `command_guards` | fail-open（壞 regex 的規則略過） |
| `guard-report-output.js` | PreToolUse（Write／Edit／MultiEdit／NotebookEdit、Bash／PowerShell） | 交付根層直接放檔、交付資料夾內過程檔不在 `_work/` → deny。Bash 逐段分詞，只看寫入目標：重導目標（`/dev/null`、`2>&1` 不算）、tee／touch 參數、`--junitxml`、cp／mv 的**目的地**（目的地是目錄時以「目錄/來源檔名」判定；搬到交付根外放行）、PowerShell 寫檔 cmdlet；路徑以 cwd 解析並消解 `..`。讀取與刪除（ls、cat、rm…）放行；`tests/e2e/reports/`（qa-flow.sh run 的 junit）一律不管。參數檔 `report_hygiene` | fail-open |
| `guard-browser-nav.js` | PreToolUse（browser_navigate／browser_tabs／claude-in-chrome navigate／tabs_create_mcp） | 導向符合 `deny_hosts_regex` 的正式站 → deny（host 尾端句點 `prod.example.com.` 視同無句點）；對符合 `rate_limits` 的 host 在滾動視窗內超過 max 次 → deny（狀態在 os.tmpdir()，計數鍵含專案根，不同專案各算各的）；localhost 永遠放行。參數檔 `browser_guard` | fail-open（狀態檔寫不進去也放行） |

六支 PreToolUse 閘共用 `hooks/lib/qa-gate-common.js`（找參數檔、shell 指令解析、deny 輸出），回歸測試 `node hooks/test-gate.mjs`（案例在 `hooks/test-gate-pretool.mjs`）。

## PreToolUse 閘（參數檔各段與放行語法）

⚠ **scaffold 建立的參數檔（從範例複製）會直接開啟**：`dispatch_gate`、`commit_gate`、`command_guards`（高權限 DB 帳號禁止）、`report_hygiene`（`tests/reports`）、`browser_guard`（佔位正式站網域＋每 host 10 秒 30 次限速）；scaffold／migrate 會把目前開啟的閘列出來。不要的段設 `enabled:false` 或刪掉該段。下表的「預設」指參數檔沒寫該段時的行為。

共同契約：**只有專案 `tests/e2e/qa-webwright.json` 存在且該閘的規則段有設定才啟動，否則完全靜默**；
hook 自身任何錯誤、設定壞掉 → fail-open；擋下一律 `permissionDecision=deny`，**一次列完所有未過項**並附正解；
`hook.enabled=false` 全部關閉（範圍見上表 `hook.enabled`）、各段 `enabled:false` 關單支。Windows 與 macOS 同一份碼（Node 只用 path 模組、git 走 spawnSync 參數陣列，不呼叫作業系統專屬指令）。

| 參數檔段 | 欄位 | 說明 |
|---|---|---|
| `dispatch_gate` | `enabled`、`agent_regex`（預設 `qa-engineer$`）、`checks`（預設 `triage`／`target_env`／`data_source`／`out_of_scope`／`no_relay`／`alignment`／`scope_expansion`／`field_verification`）、`required_reading`、`required_reading_existing_only`（預設 true：只要求真的存在的檔）、`custom_checks: [{label, regex, message}]`、`params.<檢查項>`（覆寫標籤與關鍵字） | 範本：`skills/browser-qa/SKILL.md`「派工範本」（qa-run.md、agents/qa-engineer.md 同一份，`tests/test_docs.py` 驗三份一致、`test-gate` 驗填好的範例一次過閘） |
| `commit_gate` | `enabled`（**必須 true 才啟動**）、`behavior_globs`、`exclude_globs`（預設排除 `tests/**` 與 md/txt/json/yml/yaml/xml）、`repos`（Skill 路徑要看的 repo，預設 `.`）、`skill_name_regex`（預設 `(?:^|:)git-commit$`）、`qa_answer_regex`、`require_sediment`、`sediment_regex`、`extra_commands: [{name, regex, repo_group}]` | shell 表態要寫在「該次呼叫自己那一段」，同條指令別次呼叫的表態不算 |
| `pretest` | `alignment: [{env, required \| equals_file+regex \| must_be_under \| matches \| port/port_env＋equals_process_file+regex \| port/port_env＋under_process_root, search_up?, when_regex?, message?}]`、`side_effect_guards: [{name, file, require_regex[], forbid_regex[], block_regex?, message}]`、`test_command_regex[]` | 對照值讀不到（檔不在、regex 沒命中）→ 該條略過；**防線檔讀不到、或 block_regex 找不到防線所在的區塊 → 擋**（防線不在就不准跑）。沒有豁免註解 |
| `command_guards` | `[{name, when_regex, deny_regex[], require_regex[], require_env[], message, enabled}]` | `require_env` 認 inline 前綴、`export X=`、`$env:X=`、`set X=` 與 process env |
| `report_hygiene` | `roots[]`、`process_ext_regex`、`work_dir`（預設 `_work`） | 與 qa-flow.sh 分工：`tests/e2e/reports/` 是回歸資產（機器讀的 junit），不歸本閘；`roots` 管給人看的交付資料夾；只接受專案根底下的子目錄，寫 `.`（專案根本身）會被忽略——否則連 README 這類根目錄檔都會被擋 |
| `browser_guard` | `deny_hosts_regex`、`rate_limits: [{host_regex, max, window_s}]` | 被擋的那次不計數；狀態檔可用環境變數 `QA_WEBWRIGHT_NAV_STATE` 指定 |

**各閘放行語法總表**

| 閘 | 被擋時怎麼放行 | 沒有的東西 |
|---|---|---|
| guard-qa-dispatch | 派工單補齊：首行回報指示＋「本任務由你親自執行，不得再轉派」、`【開工前必讀】<路徑>`、`【增量分流】reuse：<既有 test 檔路徑>` 或 `【增量分流】新TC：<理由>`、`【目標環境】<網址>`、`【測試資料來源】選 a`（或 `選 b，理由：<哪一類外部系統邊界>，證據：<檔名:行號>`／`選 c，理由：…`）、`【範圍外發現】…`、`【開工前對齊】<對齊結論或無分岔＋理由>`、`【範圍展開】1 正向…2 反向…3 狀態序列…4 共用元件…`、`【欄位級驗證】<逐欄對 DB 實值>`，重發**同一個** agent | 改派其他 agent type 繞過（不同 type 本來就不檢查，但那是違反派工紀律） |
| guard-qa-before-commit | 該次 commit 訊息或後綴帶 `已QA：<pytest 路徑＋實跑綠輸出>`、`分流例外：<為何只靠讀 code 就能確定>`（`--qa "…"`、`QA已驗：…` 也認）；`require_sediment` 時另帶 `新 QA 坑：<檔>` 或 `新 QA 坑：無`；Skill 呼叫寫在 args | 還沒 QA 就 commit——先派 qa-engineer |
| guard-pretest-env | 對齊環境：`source <自己的環境檔> && python -m pytest …` 或 `X=值 python -m pytest …`；修好副作用防線檔再跑 | 豁免註解（刻意不提供：豁免唯一能豁免的就是本閘唯一該守的對象） |
| guard-command-rules | 照規則 `message` 的正解改寫；`require_env` 用 `X=值 cmd`／`export X=值 &&`／`$env:X="值";`／`set X=值&&` | 換寫法試密碼、自行繞過——先問使用者 |
| guard-report-output | 改寫到 `〈交付根〉/〈主題〉_〈日期〉/〈最終交付檔〉`，過程檔進 `…/_work/` | — |
| guard-browser-nav | 改打測試站／本機；限速被擋等視窗滑過（訊息附秒數）或放慢導向頻率 | 高頻需求請使用者調 `rate_limits` |

## 已知限制

六支 PreToolUse 閘靠**字串層級的 shell 近似解析**判斷「這條指令在做什麼」——完整模擬 shell（展開、子殼層、變數生命週期、
檔案系統實體路徑）等於重寫一個 shell，誤判成本反而更高。以下繞法**不追**，列出來讓你知道閘的邊界在哪
（正常寫法都擋得到；這些需要刻意改寫才會漏）：

| # | 情境 | 為何不追 |
|---|---|---|
| C01 | 雙引號裡的命令替換：`echo "$(pytest)"`、`echo "$(git commit -m x)"` 被當成字串內容，不算執行 | 要判斷就得實作 bash 的引號內展開規則；正常跑測試／commit 不會包在 echo 的引號裡 |
| C03 | `echo X=ok; pytest`、`X=ok true; pytest` 會被當成已設 `X`（賦值辨識只看字面 `X=…`，不分它是不是 echo 的參數、或只對 `true` 生效的前綴） | 要追蹤「前綴賦值只對同一個指令生效」得模擬每個指令的環境；對齊檢查的目的是提醒，不是防刻意繞過 |
| C04 | `export X=ok; unset X; pytest` 仍被當成已設 `X` | 同上：沒有追蹤變數生命週期（unset、子殼層、函式內 local） |
| C05 | `guard-command-rules` 以整條指令比對 `deny_regex`／`require_regex`：別的指令的參數或之後的賦值可能讓目標指令「看起來」合規 | 規則是使用者寫的 regex，本閘不知道哪一段屬於哪個指令；要精準就把 `when_regex`／`require_regex` 寫得貼近目標指令 |
| C08 | `must_be_under` 的路徑包含只做字串正規化（`path.resolve`，Windows／macOS 不分大小寫），不解析 symlink：透過 symlink 指到允許目錄外仍會放行 | 解析 symlink 要實際讀檔案系統且目標常不存在（還沒建）；同一台機器上刻意做 symlink 繞過屬人為規避 |
| C14 | `guard-browser-nav` 的限速是「讀狀態 → 判斷 → 寫回」，沒有跨程序鎖：多個瀏覽器呼叫同時進來可能略超上限 | 節流閘不是精確配額；加檔案鎖在 Windows／macOS 的語意不同、鎖殘留反而會卡死 fail-open 原則 |
| C16 | `guard-report-output` 不管沒有副檔名的檔：交付根層直接放 `README` 之類無副檔名檔會放行 | 無副檔名多半是資料夾（`mkdir tests/reports/x`），逐一 stat 判斷會誤擋開資料夾的正常動作 |
| — | `guard-qa-before-commit` 的 `cd` 累積不理會子殼層範圍：`(cd a) && git commit` 會被當成在 `a` 裡 commit | 子殼層範圍要完整括號配對與作用域追蹤；最壞結果是多要求一次表態或檢查到另一個 repo 的 staged |
| — | baseline 檔**直接刪掉再重產**等於回到首次產生，集合差無從比對；手改 JSON 也不經過保護邏輯 | 機器無法區分「刪檔」與「首次」；寫入衛生閘只能提示直接 Write／Edit，刪檔與手改請在 code review 看 git diff |
| — | `sweep_residue` 的自訂 connector 若沒提供 `begin()`／`commit()`／`rollback()`，子表與主表的刪除不是原子操作（會明講） | 交易介面因 DB 驅動而異，只能由 adapter 提供；內建 `sqlite:` 已包交易 |
| — | `sweep_residue` 複查到刪除之間，若別的程序同時把某列的 marker 改掉：子表刪除會再比對一次主表 marker（子查詢），但主表與子表兩句之間仍可能有極短空窗 | 真正的列鎖（`SELECT … FOR UPDATE` 等）語法因 DB 而異，只能由自訂 connector 在交易裡處理；內建 `sqlite:` 用 `BEGIN IMMEDIATE` 鎖整庫 |
| — | 一次 pytest 只認一個 `tests/e2e` 的掛點：同一次執行同時收進兩個專案的 conftest 時，只有先載入的那個生效（會印警告） | 執行紀錄、閘與參數檔都以單一 `tests/e2e` 為根；要跑多個專案請分開執行 |
| — | `hardcode_check` F 類（寫死帳號）只看字面值放在哪：帳號欄位的值（`username="alice"`、`"login": "BOB"`、`owner_id = "u1"`）、登入類呼叫的帳號參數（第 0 個位置參數；第 0 個是 `page`／`self.driver` 這類控制代碼時是第 1 個，再往後不看——`login(page, customer, "pw")` 的帳號在變數上、後面的字串是密碼）、帳號語境裡的信箱、與帳號欄位比較的期望值。資料庫／服務連線帳號（`DB_USER`、`connect(user=…)`、`DB_CONFIG = {…, "user": …}`、`MongoClient(username=…)`、`smtp.login(…)`）不算。其他呼叫的位置參數（`fetch_account("ALICE")`）不判 | `fetch_account("ALICE")` 與 `create_account(db, "PREMIUM")` 結構完全相同，只看字面值分不出帳號與狀態值；判了就會誤擋一般業務值。要抓就把帳號改成具名參數（`fetch_account(username=…)`）或走身分反查 |
| — | `skip_audit` 與執行期 A/D 閘的 skip 理由分類是關鍵詞＋結構啟發式：說法含糊（沒講清楚缺的是資料還是環境）時可能歸錯類 | 自然語言無法窮舉；專案慣用的說法請加進 `qa-webwright.json` 的 `skip_classify`（與內建判準合併），或把 skip 理由寫清楚（「資料庫連線失敗」vs「查無訂單」） |
| — | 三層登記只看模組資料夾**第一層**的測試檔：放在子資料夾裡的（`orders/sub/test_x.py`）、檔名含 `.` 或 `-` 的（寫不進 `test_x.py::test_y` 登記格式）、以及連到別處的 symlink 測試檔都不在孤兒／幽靈判定內——`drift_check` 會逐一列出提醒，不會沉默略過 | 子資料夾要一併改登記格式與工具；scaffold 產生的檔名已自動把 `.`／`-` 換成 `_` |
| — | 三層登記只追**模組層** `def test_…`；pytest 類別（`class TestX: def test_y(self)`）裡的測試方法不在孤兒／幽靈判定內——`drift_check` 會列出「類別內的 test 方法」提醒，不會沉默略過 | 類別測試的 nodeid 是 `檔::類別::方法`，要連同 COVERAGE 登記格式、登記器、遷移工具一起擴充；先以明確提醒代替 |
| — | `guard-qa-before-commit` 只攔 `git commit`（與參數檔 `commit_gate.extra_commands` 列的指令）：`git merge`／`cherry-pick`／`revert`／`am` 產生的提交不在範圍 | 這些多半是合併已審過的提交；要一併攔，把指令的 regex 加進 `extra_commands` |
| — | `guard-report-output` 只看 Bash／PowerShell 指令與 Write／Edit 類工具：瀏覽器 MCP 工具自帶檔名參數寫檔（例如截圖）不經過這些工具，本閘看不到 | 寫檔落點由 MCP 伺服器自己的輸出目錄決定；把該輸出目錄設在交付根以外 |
| — | 瀏覽器相關 hook 的 matcher 只認 `mcp__playwright__`、`mcp__claude-in-chrome__` 開頭的工具名：Playwright MCP 若以其他伺服器名稱註冊（工具名前綴跟著不同），`guard-browser-nav`、專案知識閘、早期提示不會觸發 | 工具名前綴取決於 MCP 的註冊名稱（各種安裝方式的實際前綴未逐一實測）；用了別的名稱請在 hooks.json 的 matcher 補上 |
| — | 六支 PreToolUse 閘以 hook 收到的 `cwd`（Claude Code 回報的目前工作目錄）找參數檔：Bash 先 `cd` 到專案外（例如暫存目錄）後再下指令，那一次六支閘都找不到參數檔而靜默放行 | 屬於放行方向（不會誤擋）；改用 `CLAUDE_PROJECT_DIR` 當後援會讓在別的專案目錄裡做事時誤套本專案規則 |
| — | 寫入衛生閘只憑工具首行的 `# qa-webwright-tool:` 標記就代跑 `tests/e2e/tools/*.py`，不驗內容雜湊：不受信任的 repo 可以放一支帶標記的檔，寫測試碼時就會被執行 | 與 pytest 載入 `conftest.py` 的信任前提相同（打開一個 repo 跑測試本來就會執行它的程式碼）；`tools-sync` 另有雜湊比對，只用來判斷本地是否改過 |
| — | port 歸屬閘的名字比對接受 `<名>-<尾綴>`（`QA_EXPECT_WORKTREE=feat-a` 也會命中 `feat-a-old`），且路徑任一段相符即算 | 刻意支援帶尾綴的 worktree 目錄命名；要區分請改用彼此不互為前綴的名稱 |

## 前置依賴

本 plugin 是「QA 方法論層」，沉澱端用專案既有的測試 runner。

**環境需求（缺了會讓落地/他律靜默失效，`qa-flow.sh bootstrap` 會自檢並警告）：**
- **Node.js** — hook 靠 node 執行；缺 node 則 harness 會靜默跳過 hook，他律無聲消失。
- **bash** — `qa-flow.sh` 是 bash 腳本。Windows 用 Git Bash；macOS 內建 `/bin/bash`（3.2）即可——腳本刻意只用 bash 3.2 與 BSD 工具都支援的語法（`tests/test_portability.py` 逐行掃描保證）。
- **Python 3 + pytest-playwright** — 沉澱載體與工具。腳本與 hook 會自動挑可用的 `python3`／`python`／`py`（macOS 只有 `python3`）；Windows 常無 `pytest` 命令，`qa-flow.sh run` 會改用 `python -m pytest`。
  - Windows：`python -m pip install pytest-playwright` → `python -m playwright install chromium`
  - macOS：`python3 -m pip install pytest-playwright` → `python3 -m playwright install chromium`（沒有 python3 先 `xcode-select --install` 或 `brew install python`）
- **port 歸屬閘（選用）** — Windows 用 PowerShell 查、macOS／Linux 用 `lsof`（macOS 內建）；兩者都沒有時該閘放行並明說。
- **MCP 工具 allow-list（新架構必備）** — 瀏覽器測試由 **qa-engineer sub-agent** 執行，sub-agent 在背景跑、
  **無法互動回應 permission prompt**：要用的 `mcp__playwright__browser_*` 工具必須已列在專案
  `settings.json` / `settings.local.json` 的 `permissions.allow`，否則會被直接 deny（這是權限機制，不是架構限制）。

**必備 runner：** 可重跑的測試 runner（**固定優先 pytest-playwright**）。greenfield 專案由 `qa-flow.sh scaffold` 建骨架、
印出安裝指令讓你執行（腳本不代裝）；僅當你明確不同意裝 Python，才退而用 Playwright JS。既有專案已有別的 runner 則沿用。

**選用（僅「真實外部站」備用探索）：** 當需打真實外部站（無 a11y test token、後端不可攔、
Akamai/H2 封 Chromium、長程未知路徑）時，才裝 webwright：

```text
/plugin marketplace add microsoft/webwright
/plugin install webwright@webwright
playwright install firefox     # webwright 用 Firefox 規避 H2 指紋封鎖
```

> 探索完一律把路徑 codify 成 runner（pytest 等），回歸端永遠不是 webwright。

## 安裝本 plugin

本 plugin 屬 monorepo（`fulin-claude-plugins`）的一員，marketplace.json 在 **monorepo root** 的 `.claude-plugin/`
統一註冊各 plugin。安裝走 monorepo marketplace：

```text
/plugin marketplace add <monorepo-git-repo>   # 例：/plugin marketplace add abs1294/fulin-claude-plugins
/plugin install qa-webwright@fulin-plugins
```

安裝後**重開一個 Claude Code session**（或 `/reload-plugins`；plugin 在 session 啟動時載入）。

驗證：

```bash
claude plugin validate ./qa-webwright
node qa-webwright/hooks/test-gate.mjs          # hook 回歸
python3 -m pytest qa-webwright/tests -q        # plugin 自測（暫存目錄建假專案實跑）
```

## 使用

裝好後，在**任何專案**裡：

```text
# 設計測試計畫
/qa-webwright:qa-plan 訂單新增頁的「通知財務」流程

# 依計畫探索 → 沉澱成 runner assert + 結構化證據驗證 + 出報告
/qa-webwright:qa-run <貼上計畫，或直接給功能描述>
```

或直接用自然語言（skill / agent 會依描述自動觸發）：「請 QA 測試這個新增流程」。

已有測試專案接上三層：`qa-flow.sh scaffold <feature> pytest`（只補缺的、不覆寫既有檔；既有 conftest 會提示貼上掛點片段），
舊版單一 catalog 專案：`qa-flow.sh migrate`。工具更新：`qa-flow.sh tools-sync`（專案端改過的工具只警告不覆蓋，參數檔永不覆寫）。

## ⚠️ 測試會落在哪：你**在哪個資料夾啟動 claude**，就落在哪

測試檔 / 報告 / 登記一律落在**你啟動 claude 的那個資料夾**底下的 `tests/e2e/`——由 `qa-flow.sh` 鎖定，**不會鑽進子專案目錄**。

| 你想測的範圍 | 該在哪啟動 claude | 測試落點 |
|---|---|---|
| 整個 app / workspace | 在該 workspace 根目錄啟動 | `<workspace>/tests/e2e/` |
| 某個子專案 / 子 repo（如 `customer-hub`）| **進到那個子專案資料夾裡啟動** | `<子專案>/tests/e2e/` |

> **不要**「在上層 workspace 啟動、卻期待測試落進某個子 repo」——那會被 `qa-flow.sh run` 的守門員擋下。

## 移植到新專案要補的「專案專屬」資訊

本 plugin 的方法論是通用的；專案專屬的有兩類：
1. **啟動服務**：在目標專案的 `CLAUDE.md` 或 README 補上前後端各自的 port、啟動指令、健康檢查 URL、登入方式
   （Windows 背景啟動的 `npm.cmd` 雷見 `knowledge/pitfalls.md` D 段）。
2. **測試資產參數**：`tests/e2e/qa-webwright.json` 的業務表清單、外部系統邊界關鍵字、殘留清掃登錄表、port 清單。

## 作者

fulin
