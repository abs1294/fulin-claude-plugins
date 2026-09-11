# Changelog

本檔記錄 git-commit 的版本變更，格式依 [Keep a Changelog](https://keepachangelog.com/)。

## [0.5.0] - 2026-09-10
### Added
- **`flow.sh audit <repo> [<range>]`**：體檢既有 commit 的 message，唯讀不改動任何東西。抓六種問題——空 message、缺 `Type:` 前綴、Type 不在允許清單、描述寬度超標、痕跡命中、含多行 body；軟清單命中另標為「待確認」。不帶 range 時：有 upstream 掃未推的 commit，否則掃最近 20 顆。exit 碼三態： 乾淨、 有問題、 range 無效——打錯的 range 會讓 git log 靜默回空，若不分辨，「0 顆」看起來就跟「全部乾淨」一樣。
  用途是交付前體檢：`format-patch` / `bundle` 產出的檔案內含完整 message 原文，會直接送到對方手上，比 push 更難收回。SKILL.md 的 §交付路徑已加上「先跑 audit 再掃產出物」。

### Changed
- `staged_added_lines()` 支援選用的 path 參數，`cmd_analyze` 改為呼叫它而非自己維護一份相同的 awk——兩處判準必須共用同一份實作，否則會漂移成「analyze 報 HITS 但 ship 放行」。

### Verified
- PreToolUse hook 已在**真實 Claude Code 環境**驗證：安裝 plugin 後直接下 `git commit -m test`，確認被攔下。先前只驗過直接餵 JSON 給腳本，這次補上端到端證據。

## [0.4.1] - 2026-09-10
### Fixed
- **真閘 3（敏感字）不再掃到自己**：關鍵字掃描改為只看 staged diff 的**新增行**（比照 `collect_ai_trace_hits`），新增 `staged_added_lines()`。原本吃整份 diff，會誤命中刪除行、未改動的 context 行、以及本檔自己的 `SENSITIVE_PATTERN` 定義。`analyze` 的預掃同步改用相同判準——兩邊判準必須一致，否則會出現「analyze 報 HITS 但 ship 放行」的矛盾。**憑證形狀那道仍掃全 diff**：憑證出現在未改動行也代表 repo 裡有它，不因「這次沒改到」而放過。
- `assert_message_clean` 豁免路徑的 `printf` 原本以字面換行寫成兩行（與全檔 `
` 轉義風格不一致），改用 `echo` 一行完成。
- 硬擋清單補 `以…確認` 句式（原本只抓 `經…確認`），這是漏擋的作業過程寫法。

### Added
- **軟清單 `MESSAGE_SOFT_PATTERN`（只提醒、不擋、無豁免旗標）**：`本輪`／`上輪`／`本次迭代`／`第 N 輪`／`複查`／`紅隊`／`對抗審查`／`PoC`／`P0-P3 防護|修正|問題|項|缺陷`。
  硬擋清單為了不誤傷業務詞（招標輪次、稽核複查、資安紅隊、缺陷單編號）收得很窄，於是「本輪修正登入逾時問題」這類作業過程敘述完全不會被攔、也無任何提示，防線退到只剩專有名詞。折衷成軟提醒：印一行讓寫的人自己判斷，不影響回傳碼。
- `references/codex-troubleshooting.md`：B 軌 codex 的疑難排解（idle 無 VERDICT／`Agent type not found`／`Not inside a trusted directory`／model 下架／卡在 stdin／判活與客觀證據／降級條件）。

### Changed
- SKILL.md 的 1.3b 從 58 行縮到 41 行（佔比 19%→14%），只留日常派工必需的（subagent_type、prompt 開頭兩條必寫、等待紀律、prompt 範本），疑難排解移入 references 並在主文留醒目路標，列出「什麼狀況該進去看」。
- **單軌降級與「兩軌都不可用不可自動 commit」提升到核心原則第 5 條**——這是主流程決策規則，不該只存在於 reference。

## [0.4.0] - 2026-09-10
### Added
- **`hooks/block-bare-git-commit.sh`（PreToolUse hook）**：機制級攔截 Bash 工具裡的裸 `git commit`，只在 `GIT_COMMIT_FLOW=1`（flow.sh 自 export）或指令本身跑 `flow.sh` 時放行。射程只含 `commit`——`status`/`log`/`add`/`rebase` 不攔。**fail-open**：空輸入、壞 JSON、無 python 一律放行並印警告，絕不把使用者鎖在無法 commit 的狀態。已跑 14 項紅綠測（含 `git -C <path> commit`、分號與 `&&` 後的 commit、三種 fail-open 情境）。
- **真閘 6：`assert_message_clean`** — commit message 的痕跡與長度檢查，命中即 exit 1 且不可豁免。
  - `MESSAGE_TRACE_PATTERN` 三段：AI／工具身分（Claude／Anthropic／Codex／code-reviewer／agent／subagent／紅藍對抗）、作業過程動詞（實測／實跑／掃描確認／經…確認／複查／審查／驗證：）、流程與輪次（P0–P3／Critical／本輪／第 N 輪／補修／PoC）。
  - `MESSAGE_MAX_WIDTH=72`：顯示寬度（全形算 2、半形算 1），由 `display_width()` 以 Python `unicodedata.east_asian_width` 計算。
- SKILL.md 新增 **§歷史改寫**（rebase／amend／reset）與 **§交付路徑不只有 push**（format-patch／bundle／archive 的產出物須自行掃過）。

### Changed
- §Commit Message 規範**明文寫死「單行，不寫 body」**，並註明這是刻意設計（`flow.sh ship` 只吃單行 description）。
- 「禁止對話脈絡」的判準從關鍵字黑名單改為一句話：**寫成一般正常人會寫的樣子**——描述「改了什麼」，不寫「我用什麼方法確認它是對的」。黑名單降為兜底，附四組 ❌/✅ 對照。
- 長度上限由「≤50 字」（單位未定義）改為「顯示寬度 ≤72」並有機械檢查。50 是純英文語境的 git 慣例，中文 1 字佔 2 寬度且 message 常需帶長識別符——實測「DAP 推送改為獨立例外處理，連線失敗不再中斷簽核主流程」＝52，是完全正常的一句話。
- `flow.sh` 開頭 `export GIT_COMMIT_FLOW=1`，供 hook 辨識正規流程。

### Notes（判準收斂過程）
`MESSAGE_TRACE_PATTERN` 經五輪對抗審查才收斂。**每一輪的 BLOCK 都是實測可複現的誤擋**，不是理論疑慮：

| 輪 | 誤擋案例 | 修法 |
|---|---|---|
| 1 | `修正登入頁面 agent 字串未過濾`、`新增審查流程狀態欄位`、`P2 專案的匯出功能新增欄位` | 裸詞改詞組 |
| 2 | 判準無豁免出口，誤判即無法 commit | 加 `--allow-message-trace` |
| 3 | `新增客戶資料驗證：手機號碼格式`、`P3項目編號規則調整`、`缺陷單 P1問題 批次匯出` | `驗證：`要求結論詞、刪 `P0-P3` |
| 4 | `本輪新增供應商評分欄位`、`理賠案件複查確認欄位新增附件上傳`、`紅隊演練管理系統新增派工欄位` | 收斂到最小可靠集 |

教訓：**關鍵字黑名單兩個方向都會錯**——太寬會誤擋業務詞（「審查」是簽核、`agent` 是代理商、`P1` 是缺陷單欄位、「複查」是稽核流程、「紅隊」是資安產品），太窄會漏掉作業過程敘述。最終只保留「業務語境幾乎不可能出現」的兩類：AI/工具專名，以及帶結論的作業過程句式。模糊描述（`Fix: 補 P0 防護`）交由人在審查時判斷。

過程中踩到三個 regex 的 byte 坑，`bash -n` 全部放行，只有實跑才抓得到：
1. `[^，。；]` 否定字元類按 byte 運作，會排除 CJK 字的個別 byte，導致整段完全不匹配
2. 對 CJK 字用 `?` 量詞只作用在該字最後一個 byte，`對抗式?審查` 永遠配不到「對抗審查」
3. `.{0,N}` 的 N 也是 byte 數（中文 1 字＝3 bytes），`驗證：.{0,12}正常` 抓不到「驗證：登入功能正常」

### Known issue（本次發現，未修）
真閘 3（敏感字）掃的是**整份 staged diff**，包含刪除行（`-`）與未改動的 context 行，與真閘 5（AI 痕跡）只掃新增行的作法不一致。本次 commit 自己就撞上三處誤判：兩處是 SKILL.md 教人「commit 前 grep `LocalDevToken|MockSap|MockBPM|mysecret`」的文件描述（一處還是刪除行），一處是 `SENSITIVE_PATTERN` 定義行本身被自己的 pattern 命中——**掃描器掃到自己的定義**。三處皆無真實憑證，以 `--allow-sensitive` 放行。
建議修法：比照 `collect_ai_trace_hits` 只取 `^+` 且排除 `+++` 的行。

### Notes（事故收據 2026-09-10）
起因：另一個 session 在 KMS-dev 繞過本 skill，直接跑 `git rebase -i` / `--amend` 產出 8 顆 commit，把「經語法樹掃描確認 25 個 await…」「實測七則官方回應」「該目錄為 Claude Code 的本機設定與暫存」寫進 git 歷史。**五道既有真閘一道都沒觸發**，因為它根本沒經過 flow.sh。三個結構缺口：
1. 規範是自律，AI 會繞（skill 的「必須」擋不住，只有 hook 是他律）→ 補 hook。
2. `AI_TRACE_PATTERN` 只掃 staged diff 的新增行、從不掃 message；`SIGNATURE_PATTERN` 只認 5 個署名詞（且沒有 `Claude` 單獨一詞）→ 補真閘 6。
3. 「≤50 字」沒定義單位、「body 可不可以有」規範空白 → 該 session 先寫長 body（規範沒禁）、事後又自行認定「skill 要求不含 body」全砍（規範也沒要求），兩次都在填空白。→ 明文寫死。

開發過程中的自我實證：`display_width()` 初版用 awk `length(c)!=1` 判全形，`bash -n` 通過但**實跑錯誤**——多數 awk 非 locale-aware，`substr` 按 byte 切，「中文五個字元」被算成 18（byte 數）而非 12。改用 Python `east_asian_width` 後重測正確。**語法檢查過 ≠ 能跑**。

## [0.3.0] - 2026-09-05
### Added
- `codex-model-sync.sh`：找出帳戶當下可用的最強 Codex 模型並寫回 `~/.codex/config.toml`。判準為 `~/.codex/models_cache.json`（CLI 維護的**帳號專屬**清單，非全球目錄）中 `visibility=list` 且 priority 最小者，選出後一律送真請求驗證才採用；`--check` 為唯讀模式，供 hook/CI 使用。
- `codex-model-check.sh`：列出所有候選的可用狀態，不改檔。

### Changed
- 降級流程前置「先排除 model 下架」：B 軌報 400 `model is not supported` 時，先跑 `codex-model-sync.sh` 判斷是設定過期還是環境故障，對齊後重送即可，不必走單軌降級。

### Fixed
- 修正三個會讓「腳本跑得動但結論錯誤」的缺陷（經 Codex 三輪審查，前兩輪皆 BLOCK）：
  - 寫回 config 後未檢查 python 回傳碼、也未回讀驗證——實測 python 拋例外時仍印「已更新」並 exit 0。已補回傳碼檢查＋寫入後重讀比對。
  - trap 收到 INT/TERM 只刪暫存檔卻不結束腳本，控制流帶著「檔案已消失」的狀態跑到 grep，把探測中的模型誤判為不可用、進而把次強模型寫進 config。已將訊號處理與正常結束分離，訊號版清完立刻退出。
  - Windows 版 python 的 stdout 為文字模式，`\n` 會被轉成 `\r\n`，slug 尾端帶 `\r` 導致每個判斷都錯。已在 bash 端 `tr -d '\r'`。

### Notes
- 探測失敗的原始輸出保留於 `$TMPDIR/codex-model-probe-fail/<slug>.log` 供回溯；每次執行先清上一輪，避免陳舊資訊誤導診斷。
- 訊號離開碼依慣例區分：INT=130／TERM=143／HUP=129。

## [0.2.1] - 2026-08-26
### Fixed
- 補「codex 拒絕在非 git 目錄啟動」的必死坑：subagent 預設 cwd 是 workspace 根、根目錄非 git repo，codex 會回 Not inside a trusted directory 即退出，死狀與「還在算」相同（只送 idle、無 VERDICT），實證白等逾 1 小時。prompt 開頭強制指定 cd 到 repo，並把「先跑最小題」提到「耐心等」之前。另 B 軌等待門檻 5 分鐘改為 10 分鐘告知一次後續等、至多 1 小時。

## [0.2.0] - 2026-08-25
### Changed
- B 軌等待門檻 5 分鐘改為 10 分鐘：滿 10 分鐘告知一次後續等不再打擾，至多等到 1 小時才停下請使用者決定。原門檻與同段實測「完整審查需 7 分鐘以上」自相矛盾，照規則走每次都必然打擾使用者。

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
