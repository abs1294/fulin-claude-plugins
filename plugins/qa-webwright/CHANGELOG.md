# Changelog

本檔記錄 qa-webwright 的版本變更，格式依 [Keep a Changelog](https://keepachangelog.com/)。

## [0.9.0] - 2026-09-24

吸收一個大型專案 QA 基礎設施中已驗證可泛化的機制（測試資產稽核工具、pytest 掛點、寫測試碼當下的衛生閘、QA 流程紀律閘、測試方法論），並修掉移植時發現的六個缺陷。來源專案的逐項對照與回修建議屬該專案內部文件，不隨 plugin 發布。

### Added
- **三層登記架構**（新專案預設）：`<模組>/COVERAGE.md` 手寫情境正本 ＋ `.runs/results.sqlite` 執行事實 ＋ 生成 `CATALOG.md` 薄索引。新工具 `gen_catalog.py`（生成前自檢：實計 0 拒絕、行首 def 與 AST 兩判準函式數不一致拒絕；✅⚠️❌統計、最後執行日期／批次／通過失敗、xfail 節與 🔒 鎖定節匯集）、`drift_check.py`（孤兒／幽靈／佔位，續行式登記、跨資料夾引用不算幽靈、佔位只認整格）、`make_skeleton.py`、`fill_orphans.py`、`coverage_register.py`、`migrate_catalog.py`
- **SQLite 執行事實層**：`runs_db.py` ＋ `qa_pytest_plugin.py`（conftest 掛點片段 `templates/conftest_snippet.py`）——makereport 收集、sessionfinish 寫入、批次名 `QA_BATCH`（相容 `E2E_BATCH`）、寫入失敗在總結區紅字不吞；每次 pytest 結束印 drift 狀態
- **skip 四分類＋A/D 整輪失敗閘**：`skip_audit.py`（C→D→B→A 判定順序、D 排除、AST 只抓執行期 skip、中英文內建判準、參數檔可擴充）；執行期 A（資料不存在）／D（共用狀態被佔）類 skip 讓整輪 exit 非 0
- **測試資產硬編檢查** `hardcode_check.py`：A 業務 Id 常數、B 人工種子依賴、C 還原他人資料（參考）、E/E' 直寫業務／骨架表、F/F' 寫死帳號與信箱、G helper 替產品補欄位（參考）、H/H' 借一筆現成資料且無自種後路；阻擋類與事件驅動升級規則（`hardcode.extra_blocking`）；`--md` 逐檔清單、`--review-db` G 類覆核總表
- **跳脫註記**：`# SCAN-REVIEWED: <safe|real> — <理由>`（上方最多 4 行連續註解或所屬函式 docstring）、`# G-REVIEWED: <safe|real> — <產品端證據>（YYYY-MM-DD）`、刻意值命名慣例、註解與 docstring 不計、【測試資料來源】理由段三條件整檔豁免、`finally:` 內寫入算還原；缺理由或格式錯的註記不放行並列入「覆核註記格式錯誤」
- **共用 baseline 模組** `baseline.py`：`--baseline` 只擋新增、`--write-baseline --why` 必填、集合差有新增拒寫（`--allow-raise` 例外）、只能全範圍重產、指紋不含行號、JSON 記 `generated_at`／`count`／`prev_count`／`why`
- **環境閘框架** `env_gates.py`：port 歸屬閘（`QA_EXPECT_WORKTREE`，Windows PowerShell／macOS·Linux `lsof` 兩條查法、都不可用 fail-open、不符 `pytest.exit(3)`）、依 collect 結果 `item.fixturenames` 判定的必要環境變數檢查（缺件 `UsageError`）、探測覆寫約定 `QA_<NAME>_AVAILABLE`（1/true/yes/on＝真、其他非空＝假、未設＝自動探測）
- **其他工具**：`sweep_residue.py`（前綴標記、dry-run 預設、`--apply` 前重查、子表先刪、DB 連線可插拔 `sqlite:` 或 `module:factory`）、`run_by_folder.py`（junit 逐筆計數、輸出目錄參數化）、`i18n_locator_check.py`（字元類可參數化、「有 assert 但只驗存在性」判定位器）
- **專案參數檔約定** `tests/e2e/qa-webwright.json`（範例 `templates/qa-webwright.example.json`）：業務／骨架表、刻意值前綴、測試資料前綴、port、殘留清掃登錄表、COVERAGE 表頭與佔位字面值、四類外部系統邊界關鍵字、skip 分類擴充、fixture→環境變數等；缺檔走預設、壞檔 exit 2 明確報錯
- **PostToolUse hook** `guard-test-asset-hygiene.js`：寫 `tests/e2e/**/*.py`（`tools/` 除外）當下對該資料夾跑 hardcode_check／drift_check／skip_audit（i18n 依參數檔 `i18n.hook_gate`），皆帶 `--baseline`；新增違規 exit 2；**只有專案存在參數檔才啟動，否則完全靜默**；自身錯誤與工具崩潰 fail-open；參考類提示每 session 上限 3 次
- **六支 PreToolUse 流程紀律閘**（泛化自來源專案的 QA 流程閘；規則與關鍵字全部參數化於 `tests/e2e/qa-webwright.json`，**只有參數檔存在且該段有設定才啟動，否則完全靜默**；自身錯誤 fail-open；一次列完所有未過項；共用 `hooks/lib/qa-gate-common.js`）：
  - `guard-qa-dispatch.js`（Agent／Task）：派 qa-engineer 的派工單表態——【增量分流】reuse／新TC、【目標環境】、【測試資料來源】a/b/c 明選＋b/c 理由（照抄選單、英文冠詞 a 不算表態）、【範圍外發現】必報、親自執行不得轉派、必讀清單；可加開【開工前對齊】【範圍展開】與自訂 regex（`dispatch_gate`）。SKILL.md 新增「派工範本」節，qa-run.md、agents/qa-engineer.md 同一份，測試驗三份一致且填好的範例一次過閘
  - `guard-qa-before-commit.js`（Bash／PowerShell／Skill）：行為類改動 commit 前必須帶「已QA：…」或「分流例外：…」表態，`require_sediment` 時另要「新 QA 坑：…／無」；認 `git commit`（含 `-C`、`cd … &&`、`-a`）、參數檔列的 commit 流程指令與 git-commit Skill；註解、引號內、heredoc 本文提到不算呼叫；表態只認該次呼叫自己那一段（`commit_gate`，**預設關閉**，範例開啟）
  - `guard-pretest-env.js`（Bash／PowerShell）：指令真的在跑 pytest／`qa-flow.sh run`／自訂測試指令時，檢查環境變數對齊（`required`／`equals_file`＋`regex`／`must_be_under`／`matches`；值來源依序 inline 前綴 → 同指令 source 的檔 → process env）與副作用防線檔（`require_regex`／`forbid_regex`／`block_regex`，檔讀不到＝擋）；`--collect-only`／`--fixtures`／`-h`、heredoc、echo/grep 提及放行；無豁免註解（`pretest`）
  - `guard-command-rules.js`（Bash／PowerShell）：`when_regex` 命中時 `deny_regex`／`require_regex`／`require_env`（認 inline、export、`$env:`、set、process env）；範例附高權限 DB 帳號禁止（生效）與服務啟動必帶環境名（示範，預設不生效）兩條（`command_guards`）
  - `guard-report-output.js`（Write／Edit／NotebookEdit、Bash／PowerShell 寫入動詞）：交付根層不准直接放檔、交付資料夾內過程格式檔必須在 `_work/`；`tests/e2e/reports/`（qa-flow.sh run 的 junit）一律不管（`report_hygiene`）
  - `guard-browser-nav.js`（browser_navigate／browser_tabs／claude-in-chrome navigate／tabs_create_mcp）：禁止導向正式站、對指定 host 滾動視窗限速（被擋那次不計數，狀態在 os.tmpdir()）、localhost 永遠放行（`browser_guard`）
  - `qa_config.py` 納入六段的預設值（＝靜默）與第二層型別檢查（壞型別工具端 exit 2 明講、hook 端 fail-open 靜默）；`hook.enabled=false` 成為所有 hook 閘的總開關
  - 回歸：`hooks/test-gate-pretool.mjs`（由 `test-gate.mjs` 匯入）涵蓋每支閘的無參數檔靜默、違規擋、合規放行、fail-open
- **qa-flow.sh 新子命令**：`tools-sync`（依版本標記＋本體雜湊更新已複製工具，本地修改只警告不覆蓋，`--force` 先備份）、`migrate`（舊 4 欄 catalog → 三層，列數對帳，舊檔改名保留）
- **方法論**：新增 `methodology/test-discipline.md`（核心鐵則、不打斷、整輪才出報告、直打界線、副作用邊界）與 `methodology/test-asset-hygiene.md`（三層登記、skip 四分類紀律、xfail 鎖定與反向紀律、故意保留紅燈、缺陷現場當定位錨、直寫 DB 例外判準框架、G 類五種 safe 性質穩定度表）；`test-plan-design.md` 新增 §8 探索七類、§9 失敗注入、§10 A/B 對照定位；`critical-points.md` 新增「斷言隔離度」；`knowledge/pitfalls.md` 新增 J～N 段
- **plugin 自測套件** `tests/`（pytest）：在暫存目錄建 greenfield 假專案實跑 bootstrap→scaffold→pytest→gen_catalog→drift_check，含各類違規樣本、每種跳脫註記、baseline 保護、A/D 閘、環境閘（含真 listener 的 port 歸屬查詢）、殘留清掃、migrate、tools-sync、大小寫不敏感防誤刪、可攜性掃描（bash 3.2／BSD 禁用語法、`# portable-ok:` 註記）、CRLF＝0
- **macOS 適用性**：qa-flow.sh 限用 bash 3.2＋BSD 工具語法；Python 一律挑 `python3`→`python`→`py` 並實測可跑；Git Bash 路徑轉原生格式（`cygpath`，macOS 原樣）；README 補 macOS 安裝與執行說明

### Changed
- `qa-flow.sh bootstrap` 回報登記模式 `MODE`（three-layer／legacy-catalog／three-layer-no-config／none），greenfield 不再自動建舊版單一 catalog；`scaffold pytest` 改建三層骨架（工具複製進 `tests/e2e/tools/` 並帶版本標記、參數檔、conftest 掛點、`<feature>/COVERAGE.md`），既有 conftest 不改寫只提示
- `qa-flow.sh catalog` 三層模式寫入 `<模組>/COVERAGE.md` 後重生 CATALOG；`audit` 三層模式改呼叫 drift_check（非本 plugin 版本的工具不代跑）；`run` 三層模式跑完重生 CATALOG
- **catalog 寫入重寫**：所有寫入改同目錄 tmp＋原子 rename，沒有任何對 catalog 檔名的 `rm`——Windows NTFS 與 macOS APFS 預設大小寫不敏感，`catalog.md` 與 `CATALOG.md` 是同一個檔
- Stop hook（`qa-landing-gate.js`）落地判定認三層：子目錄測試、`<模組>/COVERAGE.md` 資料列、任意大小寫的 catalog；生成的 CATALOG 不算登記
- SKILL.md、`agents/qa-engineer.md`、`commands/qa-run.md`：Phase 2 步驟與任務清單改用三層登記，codify 完成判準＝drift 0/0/0；硬規則④補 D 類
- 既有 hook 檔與 plugin.json 行尾統一為 LF；SKILL.md 與本檔行尾亦統一為 LF
- 測試報告格式新增「範圍外發現」節（派工範本要求 QA 回報範圍外看到的異常）

### Fixed（移植時在專案版發現、泛用版已修的六個缺陷）
1. **A/D 失敗閘未排除收集期 skip**：專案版 sessionfinish 對所有 skip 分類、terminal summary 卻排除收集期，兩處口徑不同——理由像 A 類的 `@pytest.mark.skipif` 會讓整輪變紅。泛用版在 makereport 當下以 pytest 的 skipped-by-mark 旗標判定收集期／執行期，終端計數與 exit 閘讀同一份清單
2. **hook 說 `BAD_*` 可豁免但工具的刻意值清單沒有 BAD**：泛用版刻意值前綴只有一個來源（參數檔 `intentional_prefixes`，預設含 BAD），hook 的修法提示直接取工具輸出的那一行
3. **hook 建議的 `--write-baseline` 沒帶 `--why` 會被工具拒**：hook 提示的重產指令一律帶 `--why "<這批清掉了什麼>"`
4. **skip_audit 的 baseline 零保護**：改用共用 baseline 模組，與其他稽核工具同等保護（理由必填、集合差拒寫、部分掃描拒寫）
5. **鎖定 bug 清單寫死在 CATALOG 生成器**：改由各 COVERAGE.md 的「🔒 鎖定」節匯集
6. **hardcode_check 的 `--probe` 只存在於 docstring**：泛用版不提供（需連特定 DB），傳入會明確拒絕（exit 2），文件不再宣稱
- 另修：Git Bash 在 `MSYS_NO_PATHCONV=1` 下把 `/c/...`、`/tmp/...` 原樣傳給原生 Windows Python/pytest（解讀成 `C:\c\...`，收集 0 筆）——`qa-flow.sh` 傳給 Python 的路徑一律轉原生格式
- 送審修正（四軌審查意見，每條以 `tests/test_review_fixes.py` 或 `hooks/test-gate-fixes.mjs` 先紅後綠）：
  - **不覆寫專案資產**：`gen_catalog.py` 遇到沒有生成標記的既有 CATALOG（專案自有索引）拒絕覆寫（exit 2），bootstrap／scaffold 會回報 `PROJECT-CATALOG`；AST 解析失敗拒絕生成、不再宣稱已自檢；`migrate --dry-run` 不寫任何檔（改用 plugin 本體工具先遷移、成功後才裝工具與參數檔，遷移失敗可直接重跑），原本沒有 conftest.py 時建立掛點；`run_tool` 只跑帶版本標記的本 plugin 工具；`run` 的 date 參數只收 YYYY-MM-DD
  - **寫入落點**：coverage_register／fill_orphans／make_skeleton／migrate_catalog 的資料夾參數拒絕 `..`、絕對路徑與 symlink／junction 逃出 tests/e2e
  - **baseline**：壞檔不再當成「沒有 baseline」——`--baseline` exit 2（`QA-TOOL-RESULT: baseline-error`，衛生閘據此擋）、`--write-baseline` 拒寫；直接改 baseline JSON 時衛生閘提示改用 `--write-baseline`
  - **Stop 閘**：COVERAGE 只有「待補」佔位列不算已登記；子目錄 stat／readdir 失敗視為不確定（放行）
  - **fail-open 破口**：commit 閘 git 無法啟動／逾時放行、讀不到 staged 時 shell 與 Skill 兩路徑一致要求表態（例外：`commit_gate.repos` 未設定、專案根本身不是 git repo 的多 repo 結構時不擋，拒絕訊息提示設定 repos）；派工閘 triage regex 壞掉該項放行；nav 閘狀態寫不進去放行；衛生閘缺某支工具其他照跑、不呼叫 process.exit（macOS pipe 截斷）、全部子程序共用 150 秒預算（低於 hooks.json 180 秒）；port 歸屬閘查詢逾時不當成「服務沒起」
  - **誤擋／漏擋**：報告閘改為逐段分詞只看寫入目標（ls／cat／rm 帶 `2>/dev/null` 不再被擋、`mv 違規檔 /tmp/` 放行、`_work/../x` 先消解、cp 到目錄以來源檔名判定、複合指令每段都檢查）；pretest 閘認得引號包住的執行檔、`echo qa-flow.sh run` 不算執行、`must_be_under` 展開 `$PWD`／`${VAR}` 並轉 Git Bash 路徑、拒絕訊息遮罩值；commit 閘不再把 `commit-tree` 當 commit、`cd a && cd b`／`git -C a -C b` 逐段累積、`git commit <path>` 與同指令先前的 `git add` 算進要 commit 的內容；nav 閘 host 尾端句點視同無句點、限速計數鍵含專案根
  - **工具判準**：teardown 失敗記 error 不記 passed；舊版 pytest 退回判準改看 skipif 條件是否成立；xdist 各 worker 共用 run_id；`skip_gate=false` 不再宣稱整輪失敗；覆核註記只認緊鄰註解或所屬函式 docstring（以 AST 判函式範圍，函式外常數不繼承）；小寫 `update` 也算直寫；刻意值命名的變數（`INVALID_USERNAME = "…"`）豁免 F 類；`--review-db` 保留 real 狀態與註記；`expect(get_by_text("送出"))` 判定位器；參數檔巢狀型別錯 exit 2；run_by_folder 輸出檔名以 `%2F` 編碼不相撞；同日多次 `tools-sync --force` 備份遞增不覆蓋；conftest 掛點改為註冊成獨立 plugin（貼在既有 conftest 尾端不再蓋掉專案自己的同名 hook）；只剩 COVERAGE 的資料夾照樣稽核（幽靈不消失）；覆蓋統計只看覆蓋欄；明確寫錯檔名的登記不退回他檔同名函式；migrate 同名多候選不猜（一列都不寫）、同一函式的其他情境照樣遷入；殘留清掃前綴當字面值（LIKE 跳脫＋startswith 複核）、帶 `--older-than-days` 但該表缺 `created_column` 時只列不刪、複查＋刪除包在交易；env_gates 支援 IPv6 網址、同 port 多 listener 全部檢查
  - **造被測狀態的紀律補齊**：硬規則 ① 不再以「產品本來就沒有入口」為門檻，改為直寫 DB 原則禁止、只接受專案的封閉例外清單；`test-asset-hygiene.md` §6 新增「判產品有沒有入口」四條判準（前提資料不存在≠沒入口、例外清單不擴充、追寫入端不靠畫面推論、別讓舊種子細節定義需求）、「不算例外的理由」清單、失敗注入的邊界（不得用來造前置狀態）、環境開通（權限／角色）也走產品入口；`test-discipline.md` 核心鐵則新增第 6 條；`test-plan-design.md` §9 補注入器邊界
  - **測試資料來源與派工紀律對齊「走真實業務流程，不論成本」**：派工閘的 b 選項改為封閉例外——只收產品外部系統產生、產品端沒有入口的前置，理由必須點名是哪一類外部系統邊界（內建：外部簽核回呼／上游推送／外部主檔 mock／目錄服務，另認參數檔 `external_system_keywords`）（後改為還須附產品端「檔名:行號」證據，見下方白名單條目）；`hardcode_check` 修法提示同步改寫。派工閘預設檢查由 5 項增為 8 項，新增【開工前對齊】、【範圍展開】（正向／反向／狀態序列／共用元件四格都要寫到）、`field_verification`【欄位級驗證】（要寫出拿什麼實值比對，DB 讀回或三方對照）；範本三份與範例同步加格。⚠ 既有專案的 `qa-webwright.json` 若明列了舊的五項 `checks`，要自己把三項加進去才會生效
  - **跑測前環境對齊可對照正在跑的服務**：`pretest.alignment` 新增 `port`／`port_env` ＋ `equals_process_file`（值要等於該 port 上此刻 LISTEN 的 process 實際讀的那份檔）與 `under_process_root`（路徑要落在該 process 的專案根底下）；新模組 `hooks/lib/port-process.js`（Windows netstat＋CIM、macOS／Linux lsof／ps，查不到就略過）
  - **第七～十輪重審修正**：b 的例外關鍵字不收裸字 mock／callback／回呼；查 process 時 node_modules 內的執行檔改取外層、bin 內的建置輸出先試上一層（專案目錄），切到磁碟根時補分隔符；所有查詢共用時間預算、netstat 同次共用，Windows 另以對方位址 `:0` 判 LISTEN（非英文系統的狀態字樣會在地化）；pretest 閘逾時 10→15 秒；qa-run.md 與 README 修法欄補三格；選項判定改為固定格式——【測試資料來源】第一行開頭必須是「選 a／選 b／選 c」（與【增量分流】「第一行開頭寫 reuse 或 新TC」同一套規則），取代自由文字判讀（試過五種判法都有破口：否定句被判成另一個選項、先說明後表態被判成沒選）；b 的類別／證據與 c 的理由只看「作答段」（第一行起到空行，或到 a./b./c.／（／⛔ 開頭的說明行為止），範本附在同一格下方的選項說明不得頂替作答（說明行帶 `- `、`> ` 前綴也截斷；擋下訊息講明只讀作答段）；c 的「理由：」後面要真的有內容——計數判準：刪掉佔位字詞（待補、TBD、TODO、N/A、OK、同上、…）與全部空白標點後，剩下至少 2 個字（不列舉句型）；參數 `data_source.reason_regex` 語意改為「出現即算有理由的關鍵字」，新增 `reason_marker_regex`（理由標記）；舊參數檔只覆寫 `reason_regex` 時維持舊語意（它就是唯一判準）；參數檔選項鍵大小寫不拘；範本佔位（可巢狀）剝到沒有變化為止
  - **b 的判定改為白名單**：理由必須點名外部系統類別，並附產品端證據的「檔名:行號」（全形冒號與 `#L行號` 也認；檔名可含 `@ [ ] + ~`，副檔名含 `.c／.h／.cpp`）；移除推託詞清單與剝除邏輯（推託的講法無限多，黑名單在第七～九輪每修一種句型就漏另一種、還誤擋正當描述）。已知取捨：點名類別又附證據、但順口提到「比較快」的派工單會放行；真正的防線在寫入衛生閘的 E 類（直寫業務表要三條件全中才豁免）
  - **方法論補齊**：`test-plan-design.md` §11 範圍展開四格與欄位級驗證；`test-asset-hygiene.md` §6 宣稱真例外的四步證據（含「順序能不能換」與實跑輸出）、「歷史相容性」列入不算例外的理由、借資料光跑過不算修好、既有 id 寫死進回歸測試會在空庫靜默消失；`test-discipline.md` §6 判斷與交付的證據要求（掩蓋手段一律停、每批三重重驗、red→green、ablation、parametrize 展開、掃描器盲區三問＋反向樣本、交付前自己跑衛生工具、teardown 清乾淨的計數），§5 補「防線靠本機未提交改動存在時版控乾淨是紅旗」
  - **文件**：README 新增「已知限制」節（字串層級 shell 解析不追的繞法逐條列出）；plugin.json 描述列出全部 10 支 hook；方法論與測試裡的來源專案語彙改為通用詞，禁字掃描擴充並涵蓋 CHANGELOG；hook 回歸測試不再寫死本機 transcript 路徑
  - **修正引入的退步**（最後一輪只審修正本身）：派工閘的否定判斷涵蓋雙字動詞（「無法使用 a」「不採用 a」「不選用 b」不再被當成明選）；hardcode F 類單獨的 `account`／`account_name`／`account_id` 改看值：像登入帳號（英文開頭、含小寫、無空白、無連續 6 位數字，如 `bob`）才算，帳號號碼、戶名、全大寫代號不算，前面有人員字樣（`user_account`、`login_account`）直接算；port 歸屬閘去掉命令列開頭的直譯器路徑再判落點（`/usr/bin/python3 manage.py runserver` 改看工作目錄）；安裝預檢拒絕同名一般檔案 `tools`；run_by_folder 根資料夾輸出 `%2E.xml`；衛生閘路徑比對不先轉小寫（避免 `İ` 等字元讓索引錯位）、專案自有工具的 baseline 不給不存在的重產指令
  - **整份重審**（測試 `test_FR_05`～`test_FR_14`）：skip 理由「資料已存在」「帳號／資料被佔用」歸 D 類（原本中文被排除成未分類、英文 already exists 卻判 D），「port／檔案被佔用」「port／address already in use」歸 B（中英一致；`email address already in use` 仍歸 D）、「無已存在的 X」「已存在的 X 不足」歸 A；port 歸屬閘遮罩 `-u`／`-U`／`--user` 的 `帳號:密碼`（含黏寫與引號內含空白）；Windows 查 listener 改認錯誤代號 `CmdletizationQuery_NotFound`（原本認類別 `ObjectNotFound`，缺 `Get-NetTCPConnection` 指令時會被誤當成沒人 listen 而擋跑），找不到 PowerShell 時當成查詢失敗（fail-open）；同一天第二次遷移舊 catalog 的備份加遞增序號、不覆蓋前一份；安裝時專案自有同名檔撞名，依賴它（含間接依賴）的本 plugin 工具一併不裝，訊息指出真正撞名的那支專案檔；安裝後才撞名的已裝舊版保留原檔並提示移除或改名，`install_tools.py status` 標出「撞名受阻」；skip 分類的編譯快取改為核對同一個設定物件（避免物件回收後 id 重用拿到舊判準）；`Email-Address`、`email  address`、`email<tab>address` 等寫法同樣視為信箱位址；安裝器的依賴推導改用 AST（認得括號多行、反斜線續行與 `import x as y`，解析失敗當成無依賴），`tools/` 底下有同名資料夾時略過而不丟例外（測試 `test_FR_13`、`test_FR_14`）；README 寫明 `report_hygiene.roots` 只接受子目錄、寫入衛生閘依版本標記代跑工具的信任前提
- 另修：「專案自有同名工具不代跑」原則有兩處沒落實——`guard-test-asset-hygiene.js` 只看檔案存在就代跑 `tools/` 下四支工具，`qa-flow.sh catalog` 寫完 COVERAGE 後直接跑 `tools/gen_catalog.py`。已有自家同名工具的專案一建參數檔，就會被 plugin 用它自己的參數契約去跑專案工具（hook 誤擋、或用專案生成器改寫 CATALOG）。兩處改為先檢查首行 `# qa-webwright-tool:` 版本標記，沒有就不代跑（hook 靜默、catalog 只寫 COVERAGE 並提示 CATALOG 由專案自行重生）

## [0.8.2] - 2026-09-09
### Added
- 硬規則由四條擴為**五條**，新增 ⑤「驗環境看 `response.url`，不信環境變數」：前端 dev server 的 API base URL 在啟動當下就寫死，測試端環境變數管不到瀏覽器裡的頁面——兩者指到不同後端時「環境變數看起來設對了、實際完全沒生效」，於是瀏覽器操作 A 庫、SQL 斷言讀 B 庫，值級三方比對全部不可信。前四條做得再好，打錯後端就整輪作廢。附三個同型陷阱：`ASPNETCORE_URLS` 會被 launchSettings 的 `applicationUrl` 蓋過（要用命令列 `--urls`）、身分類環境變數若由服務啟動時讀取則兩個 process 各要帶一份、多堆疊並存時 port 可能被別分支的 binary 佔著
### Changed
- `SKILL.md` 的摘要同步補 ⑤ 並改為五條；三處「四條硬規則」字樣一併更新
- 條號改為**只增不改**並在正本明寫：既有文件與工具訊息會引用「硬規則③」這種編號，重排會讓那些引用全部指錯
### Fixed
- 修一個跨檔複製造成的分歧：⑤ 先前只存在於某個專案的本地文件（`smoke-test-guide.md`），skill 這份是四條——同一套紀律兩個地方條數不同，照 skill 做的人會漏掉它。現正本收斂到本 skill，該專案本地檔改為一行指路、只留專案特有的補充

## [0.8.1] - 2026-09-08
### Added
- 四條硬規則③補「遷移時不可弱化比對強度」：`h1:text-is('X')`（精確）改成 `get_by_role(name=i18n_t(...))`（預設模糊）會 strict mode violation——頁面若同時有「X」與「已填寫X」就整包紅（2026-09-07 實測一次改壞 15 支）。遷移目標是換掉寫死文字，不是順便換定位方式：比對強度、`level=`、容器 scope 都要原樣保留

## [0.8.0] - 2026-09-07
### Added
- 新增「四條硬規則：測試不得依賴環境既有資料」（critical-points.md 完整判準＋SKILL.md 摘要入口＋步驟 2 草稿檢核點）：①前提資料走產品入口自造，不寫死既有 Id、不直接 INSERT（INSERT 造出的資料形狀產品永遠不會產生）②期望值查來源推導且不得抄被測程式那句查詢（同源＝後端錯時測試一起錯、突變存活）③定位錨語系無關，優先產品既有錨→i18n key 取譯文→測試端 setAttribute，禁在產品碼埋測試專用屬性④沒資料不准 skip 要自己生（A 資料缺自造／B 環境具名 skipif／C 結構變改 fail）。另補「紅燈歸屬先分流」：端點 grep 命中 0 即環境缺功能非測試債，不得改測試遷就
### Changed
- 斷言規範移除「可見文字」作為穩定條件的例示——多語系專案切語系即全失效，改列 role/狀態/業務碼/產品既有 id；髒資料紀律補「只刪自己造的、不要 UPDATE 回原值」
### Fixed
- 明示 `assert xxx.get_by_text("中文").count() > 0` 屬定位器而非斷言（有 assert 字樣不等於豁免語系失效）

## [0.7.1] - 2026-07-10
### Fixed
- 修正 qa-flow.sh run 落點守門員在 Windows 誤擋：canon_test 用 realpath(C:/) 比對 canon_expected_dir 的 pwd -P(/c/) 格式不一致→合法落點被擋；改成兩邊統一 cd+pwd -P

## [0.7.0] - 2026-07-06
### Changed
- 架構改「QA agent 一手包」：qa-engineer 設計+自跑 Playwright MCP+codify+報告+回填 catalog，主 Agent 只派工收結論不親跑 MCP、實作 agent 不自驗（qa-engineer.md/qa-run.md/qa-plan.md/SKILL.md/test-plan-design.md 五檔改寫）；allow-list 前提（sub-agent 無法回應 permission prompt，mcp__playwright__* 須在 permissions.allow）寫進 README+SKILL+agent；hooks 相容性 review：landing-gate 已掃 subagent transcripts 相容、early-nudge 純 cwd 相容、project-knowledge-gate 補掃 subagent transcripts（原只掃單檔會誤 deny）、landing-gate block 訊息同步 draft-first 步序，test-gate.mjs 回歸 14/14 過；qa-flow.sh 依 §4 不動

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
- qa-flow.sh 與兩個 hook 的邏輯改動經多輪對抗審查；hook 修掉一個 fail-open 破口（來源讀到一半失敗被誤當「掃完沒命中」而進 block/warn）；qa-flow 修掉「bootstrap 吞掉 audit 真失敗」與「migrate 誤搬使用者 catalog」兩處。架構強化經紅藍對抗 R1→R2 複驗收斂（R2 零新 ≥MEDIUM 弱點）
- **已知取捨（ACCEPT）**：`run` 守門員的 symlink 逃逸偵測採 fail-open——canonical 路徑解析失敗時放行（不誤擋）。字串層已擋所有非 symlink 逃逸（絕對路徑 / `..` / tests-e2e 外）；殘餘風險僅「Linux/Mac 建了真 symlink 且 realpath 剛好失敗」的極窄縫。此取捨源於 Windows temp/短檔名/junction 曾誤擋合法落點的實際痛點，寧可漏擋不誤擋

## [0.4.1] - 2026-07-02
### Added
- `qa-flow.sh run` 自動偵測 pytest 執行方式（pytest / python -m pytest / python3 / py）——Windows 無 pytest 命令時免自建 shim；強制 `PYTHONIOENCODING=utf-8` 避免中文輸出 UnicodeEncodeError
### Changed
- Stop hook `hasQaTrigger` 加認「執行過 qa-flow.sh 子命令」為觸發（抓「跑了流程卻漏 catalog 回填」），並排除 echo/grep 等「提及非執行」誤判
- BLOCK 與 WARN 改共用提醒計數（上限 2 次，第 3 次靜默）；偵測到落地即重置計數（下一輪新 QA 又有完整額度）

## [0.4.0] - 2026-07-02
### Added
- 內建 Stop hook `qa-landing-gate.js`（他律強制落地）：觸發 QA + 用瀏覽器工具 + 無落地產物（test_*.py / reports/*.xml / catalog 有資料列）→ 硬擋；FAIL-OPEN 設計（任何自身失敗→放行，絕不卡死 session），經 3 輪對抗審查。plugin.json 宣告 `hooks`
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
