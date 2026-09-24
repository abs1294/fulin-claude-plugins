# Changelog

本檔記錄 git-commit 的版本變更，格式依 [Keep a Changelog](https://keepachangelog.com/)。

## SKILL.md 內文歷史紀錄（2026-09-24 併入；決策 1b：指令檔本體不放 changelog，原存於 `skills/git-commit/SKILL.md` 檔尾，逐字搬遷，不對應版本號）

> 本節逐字保留 SKILL.md 檔尾原有的全部條目；與下方版本條目內容相近者並存，不做刪減。

- 2026-09-24 prompt 稽核修正：D-2 移除 codex-troubleshooting.md 過時的「請 cat 讀取」範本（改指向 SKILL.md 1.3b）、D-10 刪除已廢止舊寫法的相對指涉句（保留現行規則）、D-17 精簡 task 用法規定（經使用者同意）
- 2026-09-11 「多步驟用 TaskCreate」一句展開成三條紀律＋禁止情境＋跨場景適用清單。來源＝冷啟 subagent 稽核退場 memory 發現內聯時砍掉的細節（黃區自主，已在回覆聲明）
- 2026-09-11 匯流規則加第 6 條：兩軌判不同嚴重度時主 agent 自己實跑驗證再匯流，不取中間值、不選寬鬆軌。來源＝memory 紀律升級（經使用者核准）
- 2026-08-31 新增真閘 5「AI 痕跡」（使用者當次指示，`--allow-ai-trace` 可豁免）：掃 staged diff **新增行**是否引用外部文件出處（`CLAUDE.md`／skill／設計文件／`docs/*.md`／裸 `§` 章節號），`.md` 除外；prepare 顯示、ship 攔截。起因是一次清出 53 處同型痕跡散在 4 個 repo，根因為「註解撰寫規範」曾有「✅ 指向規範文件」的鼓勵條文（已刪並改立 N9）。**判準含裸 `§` 是必要的**——實證刪掉「CLAUDE.md §8.2」後，同段落下一行的 `§8.4` 不含任何關鍵字，關鍵字與「見/依+章節」兩種判準都抓不到，第三種純掃 `§` 才撈出 13 處。已實跑紅綠測（含 `.md` 排除、裸 `§` 命中、刪除行不誤判、`--allow-ai-trace` 放行）。
- 2026-08-31 B 軌判活補 CPU 判準＋stdin 根治條款（使用者當次指示）：原規則只看「StartTime 晚於送審」，擋得住殭屍污染卻擋不住「啟動了但沒在算」——實證 PID 存活 16.5 分鐘 CPU 僅 0.03 秒（比同機殭屍的 68 秒還低）卻被判成正在算，白等 16 分鐘。修正為 StartTime 與 CPU 累積**兩個條件並用**。根因是 `codex exec` 未重導 stdin 導致 CLI 卡在 `Reading additional input from stdin...`，已列為必死坑，一律帶 `< /dev/null`。
- 2026-08-28 10 分鐘通知點加入 codex 活性同步檢查（使用者當次指示）：活著→續等；死了→重送同一審查（重起一次、計時重算），重起仍死才降級。判活必看程序 StartTime 是否晚於送審時刻——同日兩個實證：殭屍 PID（8/27 殘留）污染「正在算」判讀白等；codex exec 跑完即退，「查無程序」時 agent 其實已寫完 VERDICT，先要狀態再判死。
- 2026-08-23 B 軌等待紀律重寫（使用者當次指示「Codex 要等啊，你是不是太急」）：明訂 idle≠死亡、判不可用須有客觀證據（程序數 0＋最小題失敗，或 agent 回 UNAVAILABLE）、逾 5 分鐘是問使用者而非自行降級；補審查任務的耗時分級實測（雜務數秒 vs 完整審查 7 分鐘以上）與 `--json` 逐步加壓的診斷法。起因：同一輪三次把自設 timeout 當成 Codex 失效，並據錯誤診斷（「讀檔就卡」）自行降級 commit。事後背景任務補證：同一審查任務 subagent 數分鐘回 PASS、前景 `codex exec` 給 20 分鐘仍 timeout 零輸出，兩路徑結果相反，故前景失敗不可作為 subagent 不可用的依據。
- 2026-08-16 審查軌逾時門檻明定為 5 分鐘（使用者當次指示：「我願意等他到 5 分鐘」）：5 分鐘內續等不打擾，逾時才問；並補「工具層逾時 vs Codex 算得慢」的分辨與重送處置。
- 2026-07-31 713 行壓縮至本版（Claude 5 世代 context engineering 調整，經使用者核准）：砍 9-task 編排時序細則（追蹤紀律歸 memory `feedback_task_tracking_discipline`）、三處重複豁免說明合一、20 列匯流矩陣壓成四條核心原則、排版細則壓行。三軌架構、默許機制、豁免判準、flow.sh 介面、事故收據條款（git add -A／codex 命名坑／hook 故障處置／AI 署名禁令）全數保留。



- 2026-09-23 新增真閘 7「審查紀錄」與 `flow.sh review-record` 子命令（使用者當次核可，選自陳式紀錄＋hash 綁定）。**起因**：一個 session 呼叫本 skill 被專案 hook 擋下後，改用 Bash 直接跑 `analyze → prepare → ship`，連發 8 顆 commit（7 顆已推），兩軌一次都沒跑；bare-commit hook 放行是設計使然（它只管「有沒有經過 flow.sh」），而 flow.sh 本身從不檢查審查結果——三軌是整套流程裡唯一沒有機械閘的環節。現在 ship 與有改到碼的 amend 都要求一筆綁定當下 staged diff hash 的紀錄，無旗標可繞；豁免改走 `--exempt` 並寫稽核流水帳。同批廢止 Step 2 的 `[skip-review]` 寫法（與單行 message 規則矛盾）。**開發中自撞一次**：取回覆第一行的初版用 `awk '… exit'`，在 `set -euo pipefail` 下上游收到 SIGPIPE、整條管線回 141，腳本無聲中止——實測 400KB 回覆三次三次死；改成讀完全部輸入後就正常。首版送 code-reviewer 對抗審查回 BLOCK，兩個 Critical 皆實跑重現：①repo 路徑轉檔名撞名（`grp/sub`／`grp__sub`）可借用別的 repo 的紀錄 → 紀錄加 repo 身分；②補推捷徑只比 message 字串，`reset --soft` 換內容後沿用同一句 message 即可直推——這是**早於本次的既有洞**，順帶讓未審內容繞過全部真閘上遠端 → 改為只認 ship 記下的 commit sha，並防止只改 message 的 amend 替流程外 commit 洗白。同批新增 `review-record --qa "<QA 狀態>"`（選填，寫進紀錄與流水帳；要不要必填由專案 hook 決定——供應商平台的 QA hook 原本只掛在 skill 入口，走 Bash 直跑 flow.sh 就整個繞過，現改掛在 review-record 這一步）。測試 67 項（`tests/test_review_gate.sh`）。
- 2026-09-20 B 軌 prompt 範本改為「diff 內嵌＋硬性禁令」，並補 PreToolUse hook `guard-codex-diff-embed.js`（使用者當次核可）。**起因**：範本第一行原寫「請先 `cat` 讀取」，而本機沙箱自 2026-09-11 起就擋掉所有外部 shell（`powershell.exe`／`bash.exe`／`cat` 皆 `rejected: blocked by policy`）——該坑當天就寫進 troubleshooting，但**範本沒跟著改**，於是照範本寫必然失敗。09-20 同一個坑再踩三次：照範本送被擋、改講「用 cat 不要用 powershell」仍被擋（`bash.exe` 一樣不放行，故 troubleshooting 原「處置 2」在本機無效已刪）、第三次內嵌了 diff 卻又附上檔案路徑且禁令語氣太軟，codex 仍去讀檔並回「無法驗證」型 BLOCK（四項全是 remain unverified、零實質發現）。實測根因：`codex sandbox cat` 直接回 `Win32 error 5`（cygwin 工具在沙箱內建不了記憶體映射），所有 sandbox 模式皆擋、僅 `-s danger-full-access` 例外；但只要 prompt 明寫「不要執行任何指令、不要讀取任何檔案」並內嵌內容，codex 純推理完全正常（實測回完整 `VERDICT: PASS` 並逐條回應檢查點）。**「大 diff 不能內嵌」是誤判**——791 行的 diff 只內嵌需判斷的部分即可。C 軌（code-reviewer）讀檔正常，其範本不動。hook 紅綠已驗四項（含路徑擋／含讀檔指示且無禁令擋／內嵌加禁令放行／非 codex agent 不管）。
- 2026-09-14 hook 射程由「只攔 `git commit`」擴大到涵蓋 plumbing（`commit-tree`／`update-ref`／`symbolic-ref`／`branch -f`），並取消旁路（使用者當次核可）。**起因是真實事故**：一個 headless 引擎被 hook 擋下後，改用 `write-tree` + `commit-tree` + `update-ref` 三件組完成四個 worktree 的 merge commit，hook 完全沒反應、靜默通過，事後靠該 session 自願記帳才被發現——merge commit 的 message 完全正常，git log 看不出異常。同批修掉兩個結構缺口：①`flow.sh` 放行條件原是純字串比對（`grep -q flow\.sh`），`echo flow.sh; git commit -m x` 一行即可繞過——先改成判斷執行位置，第二輪審查證明那樣仍可繞（把 flow.sh 放後面即可），第三輪索性**整條刪除**，放行只留環境變數那一條；②訊息末句「請先向使用者說明原因並取得同意」在無人值守時等於預設放行，而事故中的引擎第一次其實想照規則走（加了 `GIT_COMMIT_FLOW=1` 前綴）、被擋後才轉向繞路，故訊息改為明講變數從外部設不進來、且沒有旁路。89 項回歸測試（攔截、不誤擋、fail-open、訊息內容四類；三輪審查各補一批變形）。**開發中自撞一次**：`GIT_PREFIX` 前置字元只認 `;&|` 與空白，把事故原文 `WIP=$(git -C "$W" commit-tree ...)` 整條漏掉——指令替換是真實會出現的寫法，補 `(`、反引號、`$` 後才命中。
- 2026-09-14 新增 `flow.sh amend` 子命令，並修正三份文件對 amend 的矛盾描述（使用者當次核可）。**起因**：§歷史改寫允許 amend 並訂了六條規則，但 flow.sh 從未實作 amend——`grep amend` 兩處命中全是註解、無任何程式碼，所謂「旗標層不提供」實為未實作。於是走這條路的唯一方式是繞過 PreToolUse hook，而繞過之後那六條規則沒有任何機制檢查，與 hook「規範是自律、只有 hook 是他律」的設計目標矛盾。reflog 顯示 amend 在本專案是常態操作（單一 worktree 就有同顆 commit 改寫三次的紀錄），不是罕見例外。新子命令把六條規則機制化：自動建備份分支、用 `branch -r --contains` 擋已 push 的改寫（比 `@{u}` 嚴）、沿用 ship 全部真閘、改寫後依有無 staged 自動選驗法。**同時修掉一個獨立缺陷**：原第 4 條的驗證方法 `git diff <備份分支> HEAD` 必須為空，只對「只改 message」成立；走「有改到碼」那條時 diff 必然不為空，照原文驗會直接判失敗——已拆成兩種驗法，有改碼的改用 tree hash 重現驗證。首版經雙軌審查退回、九項缺陷修正後才進版——其中最嚴重的兩項讓核心閘形同虛設：重現驗證取改寫後 HEAD 的 blob，等於拿結果證明結果（pre-commit hook 竄改內容仍印「驗證通過」）；已 push 判斷只看本地遠端追蹤 ref，自己剛 push 完的 commit 會判回空而放行。回歸測試從 13 項擴到 19 項——首版那 13 項全綠卻漏掉全部九個缺陷，因為測的都是預想路徑，rename／特殊檔名／檔案刪除／模式變更／hook 竄改／hook 擋下／未 fetch 的遠端一項都沒測
- 2026-09-10 補 hook（他律）＋真閘 6（message 痕跡與長度）＋§歷史改寫＋§交付路徑，並把 body 政策與長度單位明文寫死。**起因**：另一 session 在 KMS-dev 繞過本 skill 直接跑 `rebase -i`／`--amend` 改寫 8 顆 commit，把「經語法樹掃描確認」「實測七則官方回應」「Claude Code 的本機設定」寫進 git 歷史，**五道既有真閘一道都沒觸發**——因為它根本沒經過 flow.sh。三個結構缺口各自補上：①規範全是自律，AI 會繞 → PreToolUse hook 攔裸 `git commit`（fail-open，14 項紅綠測）；②`AI_TRACE_PATTERN` 只掃 staged diff、從不掃 message，`SIGNATURE_PATTERN` 只認 5 個署名詞且沒有單獨的 `Claude` → 新增 `MESSAGE_TRACE_PATTERN`（16 項紅綠測，測資用 KMS 真實 message）；③「≤50 字」沒定義單位、「能不能有 body」規範空白 → 該 session 先寫長 body（沒禁）、事後又自認「skill 要求不含 body」全砍（也沒要求），**兩次都在填空白且方向相反**，現已寫死「單行、寬度 ≤72」。**開發中自撞一次**：`display_width()` 初版用 awk，`bash -n` 過但實跑把「中文五個字元」算成 18（byte 數）——多數 awk 非 locale-aware、`substr` 按 byte 切，改用 Python `east_asian_width` 才對。語法檢查過 ≠ 能跑。
- 2026-09-05 補第三輪最後一個觀察項：探測失敗時原始輸出被刪、只留 `✗`，事後無法回溯真因。已改為把失敗原文存到 `$TMPDIR/codex-model-probe-fail/<slug>.log` 並在輸出標明路徑（每次執行先清上一輪，避免陳舊資訊誤導）。**這正是本輪吃過的虧**：腳本一度報「最強可用是 gpt-5.4-mini」卻看不到 astra 失敗的原文，只能手動重跑才發現真因是 slug 尾端帶 `\r`。實測：插一個 priority 0 的假 model 觸發失敗分支，確認原文留存 940 bytes 且具診斷價值、腳本仍正確選出 gpt-6-astra。
- 2026-09-05 同兩支腳本再送 Codex 覆審兩輪（第二輪 BLOCK、第三輪 PASS）：第二輪抓到**我上一輪加 trap 時引進的新缺陷**——`trap cleanup INT TERM` 只刪暫存檔卻不結束腳本，控制流帶著「檔案已消失」的狀態跑到 `grep`，把探測中的模型誤判為不可用、進而把次強模型寫回 config。已獨立重現（`grep: ... No such file` 接 `✗`）後修正：訊號處理與正常結束分離，訊號版清完立刻退出；兩處 grep 補 `2>/dev/null`。第三輪 PASS 並提兩個觀察項，一併修掉：INT/TERM 共用 exit 130 不精確，改為依慣例回 128+訊號值（INT=130／TERM=143／HUP=129）並補攔 SIGHUP。**教訓：修一個小瑕疵（暫存檔殘留）可以引進更嚴重的缺陷（寫錯設定），修完必須重送審查而非只跑正常路徑。**
- 2026-09-05 `codex-model-sync.sh` 經 Codex 審查回 BLOCK 後修三項（使用者要求拿自己寫的腳本送審）：①**寫回 config 後未檢查 python 回傳碼、也未回讀驗證**——實測 python 拋 FileNotFoundError 時腳本仍印「已更新」並 exit 0，正是本檔一再防的「跑得動但結論錯誤」，已補 rc 檢查＋回讀比對（紅測：修前 exit 0 謊報成功、修後 exit 1 並明講未變更）；②缺 `trap`，暫存檔在 Ctrl+C／kill 時殘留（check.sh 本來就有，兩支不對稱）；③備份 `config.toml.bak.*` 無限累積，改為只留最近 5 份。Codex 另指 `current` 變數未防 `\r`，實測 `tr -d [:space:]` 已涵蓋 `\r`，**該項不成立故未改**——審查意見仍須逐條驗證再採納。
- 2026-09-05 降級段落前置「先排除 model 下架」（使用者當次核准）：`gpt-5.4` 8/31 退役而 config 未更新，導致兩個 codex agent 各撞一次 400、並補做完整單軌降級——實際只需改一行設定。新增 `.claude/skills/git-commit/codex-model-sync.sh` （讀帳號專屬 models_cache.json 取 priority 最小者、實測後寫回 config，三條路徑均已實跑驗證）。官方文件（learn.chatgpt.com/docs/models）明說未指定 model 時用「recommended」且依帳戶層級而定，**不保證最強**，故不採「不設 model 讓 CLI 自選」。判活紀律與等待門檻一字未改。
- 2026-08-26 B 軌補「codex 拒絕在非 git 目錄啟動」的必死坑（使用者當次指示記錄）：subagent 預設 cwd 是 workspace 根、而根目錄不是 git repo，codex 會回 `Not inside a trusted directory` 即退出，現象與「算很久」完全相同（只送 idle、無 VERDICT），實證白等逾 1 小時。修正：prompt 開頭強制指定 `cd` 到 repo，並把「先跑最小題」提到「耐心等」之前。
- 2026-08-25 B 軌等待門檻 5 分鐘 → 10 分鐘，改為「告知一次後續等、至多 1 小時」（使用者當次指示）。起因：原門檻 5 分鐘與同段實測「完整審查需 7 分鐘以上」自相矛盾，照規則走每次都必然打擾使用者一次。新規則下 10 分鐘只告知不停手，1 小時才是真正的停損點。

## [0.8.3] - 2026-09-24
### Added
- **外來 staged 閘的 submodule 情境補齊**（`tests/test_merge_support.sh` F9c～F9f，共 81 項）：原本 F9 只測「新增 gitlink＋同時設兩種 ignore」，補上「既有 submodule 指標更新」且兩種 ignore 設定（`diff.ignoreSubmodules`、`submodule.<name>.ignore`）各自單獨設的情境。`submodule.<name>.ignore` 只對 `.gitmodules` 登記過的 submodule 生效——未登記時舊的 `git diff` 版本照樣能列出、測試驗不出退化，故測試先登記再測。反向驗證：換回 `git diff` 版 F9～F9f 六項全 FAIL。

### Fixed（文件）
- **README 補「回歸測試」一節**：兩套測試（`test_review_gate.sh`、`test_merge_support.sh`）的涵蓋範圍與用法，原本 README 與 SKILL.md 都沒提到測試。flow.sh 指令表補外來 staged 閘說明與 `prepare --staged` 一列。

## [0.8.2] - 2026-09-24
### Added
- **prepare 外來 staged 閘**：逐檔模式下，index 若已有「不在這次檔案清單內」的 staged 項目就拒絕（exit 1）並列出檔名，且不做任何 `git add`。起因：index 是所有 session 共用的，另一 session 送審期間 stage 的 5 個 harness 檔被逐檔 prepare 照單全收、差點一起 commit。比對用 git 自己的 pathspec（`git diff-index --cached --name-only <base> -- <files>`），目錄與萬用字元一體適用；清單取自 plumbing 的 `diff-index`（並明寫 `--no-renames --ignore-submodules=none`）而非 `git diff`——後者的輸出受 repo 設定左右：`diff.renames` 會把「別人 staged 刪除 old」與「清單內已 staged 的同內容 mine」併成一筆 mine、`diff.ignoreSubmodules`／`submodule.<name>.ignore` 會把 staged 的 submodule 指標更新整個藏起來，兩者都讓外來項目漏判（Codex 審查第二、三輪各抓到一種，皆實測重現）；還沒有任何 commit 的 repo 沒有 HEAD，改比空 tree；`--staged` 模式與 merge 進行中（合併進來的檔本來就屬於這顆 commit）不檢查。只擋得住「別人已 stage」這一種；別人在同一檔裡未 stage 的改動腳本分不出是誰寫的，仍靠 Stage 紀律。檢查與 `git add` 之間不是原子操作，那段空窗內別人新 stage 的檔擋不到；prepare 之後的變動則由 ship 的 diff hash 比對擋下。兩份清單先存變數再比對——寫在 `<(...)` 裡的 git 失敗不會觸發 `set -e`，清單變空會讓閘直接放行。
- **`tests/test_merge_support.sh`**（77 項）：0.8.1 的回歸測試，原本只在暫存 repo 手動跑過、沒有進版控。涵蓋偵測器 27 條語料（攔／放行／既有射程不變）、判準依據（git 對 `--continue` 帶其他參數回 rc=129 且 MERGE_HEAD 不動、單獨 `--continue` 產生雙 parent commit——git 若改變這個行為，這兩項會先紅）、hook 端到端（exit 2／0 與攔截訊息）、`prepare` 的 merge 情境（未解衝突／部分解／`--staged` 帶檔名／空 index／解完送審 → ship 得 merge commit）、外來 staged 閘（擋下且不動 index／清單涵蓋放行／目錄 pathspec／`--staged` 與 merge 中不檢查／中文含空白檔名原樣列出／rename 偵測併筆也擋／repo 設定藏起 submodule 更新也擋／沒有 HEAD 的 repo）。偵測器測試同時驗 exit code 與 stderr，偵測器丟例外不會被當成「放行」而假綠、絕對路徑錯誤訊息、`--help`。用法：`bash tests/test_merge_support.sh <flow.sh 路徑>`。
  反向驗證（證明測試抓得到退化）：換成 0.8.0 版 FAIL 28、換成「參數含 `--continue` 即攔」的偵測器恰好 FAIL 那 7 條值／目標寫法＋hook 放行項、拿掉 prepare 未解衝突檢查恰好 FAIL P1/P2 四項、拿掉外來 staged 閘恰好 FAIL F1～F1d 四項、改回 `git diff`（上一版）恰好 FAIL F9 兩項、拿掉無 HEAD 處理恰好 FAIL F10 三項。F8 在 `git diff` 版上是靠 `--no-renames` 才過；改用 `diff-index` 後 rename 偵測預設就關，`--no-renames` 只是明寫的防呆，拿掉它 F8 仍過（實測 77/77）——F8 現在守的是「行為」，不是這個旗標。

### Fixed（文件）
- **B 軌呼叫層兩個坑寫進 troubleshooting 與 1.3b**：①prompt 裡的類旗標字樣（`-m`）被 codex companion 當成 `--model`，回 400 `The '--continue' model is not supported`——外觀像 model 下架，實為 argv 解析；②agent 自帶 `--resume-last`，本帳號不支援（exit 1）。1.3b 新增第 3、4 條規定並寫進 prompt 範本本體（帶 `--fresh`、內容以 stdin／暫存檔傳入、失敗逐字貼原文）。
- **Stage 紀律補「多 session 共用同一個 repo」**：add 前先看工作區有沒有別人未 stage 的改動混在同一檔；別人 staged 的項目以 blob 記下、移出、commit 後原樣放回；index.lock 不刪。腳本無法判斷改動是誰寫的，這段只能是流程紀律。

## [0.8.1] - 2026-09-24
### Fixed
- **merge 收尾無路可走（文件層）**：flow.sh 沒有 merge 子命令，SKILL.md、`--help`、hook 攔截訊息也都沒寫 MERGE_HEAD 存在時怎麼辦，AI 看完 usage 判定無路、改下 `git commit` 就撞 hook。實測 `ship` 在 MERGE_HEAD 存在時本來就會建出雙 parent 的 merge commit（衝突 merge 與 `--no-ff --no-commit` 兩種皆驗），缺的是說明：SKILL.md 新增「Merge 收尾」一節，`--help` 與攔截訊息都補上 prepare → review-record → ship 的收尾步驟。merge commit 的 Type 一律 `Chore`（不新增 `Merge` Type，使用者決定）。
- **`git merge --continue` 是現成旁路**：它收尾衝突 merge 時內部就是 `git commit`，但偵測器只擋 `git commit`、放行它。`detect-git-write.py` 補上 `merge --continue`（含 `-C`、`bash -c`、`-c alias.x='merge --continue'` 變形）；`git merge` 本身（含無衝突時自動 commit）維持放行（使用者決定）。判準是「merge 後的參數恰為 `--continue` 一個」而非「含 `--continue`」：git 只在它單獨出現時才收尾，帶任何其他參數都回 `fatal: --continue expects no arguments`（rc=129，實測），所以 `-m --continue`、`-qm --continue`、`-- --continue` 這類 `--continue` 只是值或目標的寫法不會誤擋，也不必逐一列舉帶值選項。
- **repo 參數給絕對路徑時錯誤訊息誤導**：`/c/...`、`C:\...` 會被接成 `<工作目錄>//c/...` 再報「路徑不存在」。行為不變（依設計只收子目錄名或 `.`），錯誤訊息改為明講不收絕對路徑、要先 cd 過去用 `.`。

### Added
- `flow.sh prepare <repo> --staged`：不 `git add`，直接拿當下 index 送審，給 merge 收尾用（git 已把合併進來的檔案 stage 好，逐檔重列容易漏）。帶了 `--staged` 又給檔名、或 index 為空，一律拒絕。
- `prepare` 在 MERGE_HEAD 存在時先查未解衝突（`git diff --diff-filter=U`），有就拒絕並列出檔名，免得送審一輪後 commit 才失敗；沒有則提示「ship 會建出 merge commit、diff 是相對第一個 parent」。

驗證：暫存 repo 實跑衝突 merge（未解／部分解／`--staged` 帶檔名／空 index／解完 `--staged` → ship 得雙 parent commit 且 MERGE_HEAD 清除）與絕對路徑兩種寫法；偵測器 27 條語料（9 條真正收尾的 `merge --continue` 寫法皆攔、`--continue` 只是值或目標的 7 條與 `merge`／`merge --abort`／`merge-base`／`pull`／`log --grep=--continue` 放行、既有 commit／commit-tree／update-ref／branch -f 照攔；Codex 四輪審查，前三輪 BLOCK 皆為「`--continue` 被當成值卻誤擋」，第四輪改用「參數恰為 `--continue`」判準後 PASS）；hook 以 JSON payload 端到端 exit 2 且訊息含 merge 收尾段；`tests/test_review_gate.sh` 新舊版皆 PASS 69 / FAIL 0。

## [0.8.0] - 2026-09-23
### Added
- **審查紀錄閘（真閘 7，commit `d94ba12`）**：`flow.sh review-record` 記下兩軌審查結果（或使用者明示豁免）並綁定當下 staged diff 的 hash，`ship`／有改到碼的 `amend` 在 commit 前比對，找不到紀錄或 diff 已變即拒絕。原因：兩軌審查原本全靠自律，其餘機械閘只管「有沒有經過 flow.sh」，不管「有沒有審過」。
- **補上 `agents/code-reviewer.md`（通用版），修掉「C 軌 agent 不存在」的缺口**。SKILL.md 的 1.3c 直接指名 `subagent_type: code-reviewer`，但本 plugin 過去沒有 agents 目錄——那支 agent 的真身在另一個專案專屬的 agent 組 plugin 裡，所以只裝 git-commit 的人根本沒有 C 軌。plugin 的 agent 放在 plugin 根目錄 `agents/`、plugin.json 不必宣告；1.3c 同步改為兩段式叫用：先 `code-reviewer`，not found 再 `git-commit:code-reviewer`。**名稱解析規則（實測）**：plugin 自帶的 agent 只能用帶前綴的 `git-commit:code-reviewer` 叫到，裸名 `code-reviewer` 只會解析到專案層／使用者層的同名 agent——**即使全環境只有 plugin 這一支，裸名也回 not found**。（冷啟實測：沒有專案層 agent 的沙盒裡，裸名回 `Agent type 'code-reviewer' not found. Available agents: … git-commit:code-reviewer …`；專案層與 plugin 並存時，裸名拿到專案層、前綴拿到 plugin 版。）
- 規則分三層：①設計品質判準 11 條（名稱揭露行為／同一邏輯形狀不重複（3 次門檻）／分支串收斂／單一職責／deletion test／方法不大量操作別人資料／反覆同行欄位組包型別／領域概念有自己型別／一個改動不逼你散改／不依賴長導覽鏈／子類別不拒絕繼承；取判準本體，原本綁特定客戶規範的排除條款改寫成通用說法）②通用工程守則（SOLID、測試金字塔、不吞例外、禁 magic number／string、邊界輸入驗證、log 不印祕密）③資安基線（注入、認證授權、敏感資料外洩、不安全的反序列化、依賴漏洞）。
- 沿用三條使用鐵則：專案既有規範優先（衝突時本檔該條不適用、不得據此回報）；第一、二層全是 judgement call、不產生 Critical；linter／compiler 抓得到的跳過。**Critical 只留給資安洞、必錯邏輯、破壞架構邊界三類**，對齊 1.3c 的 BLOCK＝🔴 Critical。
- 輸出格式照 1.3c 契約：第 1 行 `VERDICT: PASS`／`VERDICT: BLOCK`，第 2 行起 `- <file>:<line> [<Critical|Important|Minor>] <短描述>`，不寫分析段、不寫「應該怎麼改」。

### Fixed
- **C 軌叫不到本 plugin 自帶的 code-reviewer**：plugin 提供的 agent 只能用帶前綴的 `git-commit:code-reviewer` 叫到，裸名 `code-reviewer` 只解析到專案層／使用者層——即使全環境只有 plugin 這一支，裸名也回 not found。1.3c 改為兩段式（先裸名、not found 再退前綴），並修正 README、agent 說明、本檔中「同名時專案層優先、plugin 版不會被載入」的錯誤敘述。實測：在「禁止依錯誤訊息自行挑名」的條件下，照 1.3c 明文走到退路並取得 `VERDICT` 輸出。
- **PowerShell 工具可繞過裸 commit 攔截**：`hooks.json` 的 PreToolUse matcher 原本只有 `Bash`，本機同時有 PowerShell 工具時 `git commit` 直接到得了 git。matcher 改為 `Bash|PowerShell`。
- **偵測器不認得 Windows 的寫法**（Bash 與 PowerShell 兩邊都受影響）：`git.exe commit`、大小寫變體（`Git commit`）、`cmd /c "git commit"`、`powershell -c`／`-Command`／`-EncodedCommand`、`pwsh -c`、`Invoke-Expression`／`iex`、`Start-Process git -ArgumentList …` 原本全數放行。`detect-git-write.py` 新增 Windows 殼包裝解析與 `git.exe`／大小寫辨識。PowerShell 帶值選項認縮寫（`-Exec`、`-ExecutionP`、`-WindowS` 都跳過其值，否則值被當成指令起點、後面的 `-Command` 漏掉）；Start-Process 的參數表改由 PowerShell 5.1 的 `(Get-Command Start-Process).Parameters` 實際匯出（含別名與 `-ErrorAction`、`-OutVariable` 等通用參數——漏收時它們的值會夾進 `git` 與子指令之間，`-ErrorAction Stop` 曾因此放行），參數名照 PowerShell 的規則解析：名稱或別名完全相符優先，否則以前綴比對名稱與別名，cmdlet 自己的參數優先於通用參數；與 `ResolveParameter` 逐一比對 277 個前綴，僅 `-e` 不同（`-Environment` 為 PowerShell 7.4 起的參數，5.1 下 `-e` 本就歧義）。有歧義的縮寫（`-w`＝`-Wait`／`-WindowStyle`／`-WorkingDirectory`）PowerShell 會拒絕執行，整條判為不寫入；只有對得上參數名的 `-字母` 才當參數，引號內以 `-` 開頭的整段（`-ArgumentList '-C C:/repo commit'`）與陣列寫法照樣當成要執行的內容。
  驗證方式：改前先以 76 條語料建基準線並寫死預期翻轉清單，改後恰好 18 條翻轉、其餘 58 條不變；另以 19 條專測放行方向的語料確認零誤擋（`cmd /c "echo git commit"`、`iex "echo git commit"`、`Start-Process git -ArgumentList 'status'`、`powershell -File`、`npm start` 等）；最後在新 session 以 PowerShell 工具端到端實測，`git commit`／`git.exe commit`／`cmd /c "git commit"` 皆被攔、`git status` 放行。
  仍屬列舉法：未涵蓋的包裝方式（例如先把指令寫進腳本檔再執行）照舊放行。
- **B 軌兩道機械閘只存在於來源專案、裝了本 plugin 的人根本沒有它們**：SKILL.md 的 1.3b 把 `guard-codex-diff-embed.js`（diff 必須內嵌、不得附路徑）與「prompt 必須指定 cd 目標」這兩道閘當成既有他律引用，但兩支 hook 過去只放在來源專案自己的 `.claude/hooks/`，從未進過 plugin，等於文件宣稱有閘、實際上誰裝了 git-commit 都攔不到。現隨 plugin 一起帶 `hooks/guard-codex-diff-embed.js` 與新增的 `hooks/check-codex-cwd.js`，掛進 `hooks.json` 新的 `Agent|Task` matcher（沿用既有 `Bash|PowerShell` 那組不動）；後者原本是來源專案寫死四個 repo 名單的版本，改寫成通用判準——prompt 需含明確 cd 指示，且解析出的目標路徑（相對 payload cwd）必須存在且是 git repo（或位於 git repo 內，向上找 `.git`）。同批發現 1.3b 的 prompt 範本區塊其實沒有把「先 cd」這句實際寫進去（只在散文段提過），照著範本送出的 prompt 會被新閘擋下，已把 cd 指示與 `codex exec < /dev/null` 補進範本本體。`check-codex-cwd.js` 擷取路徑時，有成對引號（"…"、'…'、「…」、『…』、反引號）就取引號內整段，含空白的路徑靠這條；沒有引號則遇空白、引號或全形標點（，。、；：！？（）【】）即截斷——範本寫法「先 cd 到 <路徑>（codex exec 一律加…）」路徑後緊接全形括號，未截斷會把括號吃進路徑而誤擋；沒加引號又含空白的路徑斷點無從判斷，只驗得到第一個空白前的那段（那段不在 repo 內就擋並提示加引號，剛好是 repo 則放行）。目標必須是目錄（檔案 cd 不進去）；往上找 `.git` 走到磁碟根為止、不設層數上限；只驗 `.git` 存在、不驗是否有效（那要實跑 git）。正反案例在 `hooks/cases/`（check-codex-cwd 13 組、guard-codex-diff-embed 6 組），payload 以 `{PROJECT_DIR}` 佔位暫存專案路徑，用 harness plugin 的 `probe-hooks.js`（0.3.0 起支援此佔位）執行全綠。

## [0.7.0] - 2026-09-20
### Changed
- B 軌 prompt 範本改為「diff 內嵌＋硬性禁令」，並補 PreToolUse hook guard-codex-diff-embed.js。範本第一行原寫「請先 cat 讀取」，但沙箱會擋掉所有外部 shell（powershell.exe／bash.exe／cat 皆 rejected: blocked by policy），照範本寫必然失敗——該坑 2026-09-11 就寫進 troubleshooting，範本卻沒跟著改，09-20 同一個坑再踩三次。troubleshooting 同批加「快速參照表」（症狀→一句話處置）放最前面，治「讀一半就挑錯處置」；原「處置 2：改講用 cat 不要用 PowerShell」經實測無效（codex 改起 bash.exe 一樣被擋）已標作廢。新增三個必守：不要在 prompt 附檔案路徑、禁令要寫「不要執行任何指令、不要讀取任何檔案」、大 diff 不是例外。C 軌（code-reviewer）讀檔正常，其範本不動。 措辭上把規則與環境斷言分開：「內嵌、不附路徑」寫成無條件（任何環境皆適用，內嵌本來就比讓 agent 讀檔可靠），沙箱那段改為條件式（「若該環境的 codex 沙箱會擋外部 shell」＋標明本機屬於這種），避免其他環境讀到時成為雜訊。

## [0.6.0] - 2026-09-14
### Changed
- **hook 射程擴大到 plumbing**：新增攔截 `git commit-tree`／`update-ref`／`symbolic-ref`（寫入與 `-d` 刪除）／`branch -f`、`-M`、`-C`。起因是 2026-09-14 的真實事故——一個 headless 引擎被原本只攔 `git commit` 的 hook 擋下後，改用 `write-tree` + `commit-tree` + `update-ref` 三件組完成了四個 worktree 的 merge commit，hook 完全沒反應、靜默通過，事後是靠那個 session 自願記帳才被發現（git log 看不出異常）。三件組等價於 `git commit` 但字面上完全不像。`write-tree` 刻意放行（單獨用只建 tree 物件、不動 ref，`git stash` 內部實作會用到，攔了誤傷），`reset`／`rebase`／`filter-branch`／`push` 也刻意不攔（前三者屬 SKILL §歷史改寫 的使用者意圖層級且日常常用，push 超出本 hook「只管建 commit」的職責）。
- **hook 刪掉「指令裡出現 flow.sh 就放行」這條，放行只留 `GIT_COMMIT_FLOW=1`**：原本是純字串比對（`grep -q flow\.sh`），`echo flow.sh; git commit -m x` 一行即可繞過。改成判斷執行位置後仍可繞（把 flow.sh 放在後面：`git commit -m x; flow.sh`），第三輪索性整條刪除——只要「一條指令裡同時有放行特徵與違規操作」就擋不住，這種比對沒有安全的寫法。刪掉不影響使用者手動跑 flow.sh：那條指令本身沒有 `git commit`、hook 自然放行，flow.sh 執行後自己 export 變數，內部的 commit 就過了（已端到端實跑驗證 ship／prepare／amend 三條路徑）。
- **hook 取消「說明原因就能繞」的旁路**：原訊息末句「真的需要繞過：請先向使用者說明原因並取得同意」，在 headless session（無人可問）等於預設放行，事故中的引擎正是讀了這句後自行決定繞路。改為明講沒有旁路、做不到就停下來回報。訊息同時補上「GIT_COMMIT_FLOW 從外部設不進來」（inline 前綴／export／env 全無效，因為 hook 是獨立 process）——事故中的引擎第一次其實是想照規則走、加了 `GIT_COMMIT_FLOW=1` 前綴，被擋之後才轉向繞路。
- **hook 的偵測從 regex 改為 shlex 斷詞**：原本用一長串 regex 比對整條指令字串，四輪審查各抓到一種漏法——指令替換 `$(...)`、含 `=` 的全域選項（`--git-dir=.git`）、值含空白的 `-c user.name="A B"`、旗標置於參數之後（`branch topic -f`、`symbolic-ref <ref> --delete`）、重導向被當成參數（`symbolic-ref HEAD > /tmp/x` 誤擋）——每補一個就冒出下一個，因為 shell 指令的變形空間比 regex 能表達的大。改為用 python `shlex` 按 shell 規則斷詞後逐 token 判斷：引號與重導向由斷詞器處理，判斷只看「第幾個 token 是什麼」。python 不存在或解析失敗時退回不擋，維持 fail-open。
- **偵測邏輯抽成獨立檔 `hooks/detect-git-write.py`，並加上遞迴解析**：第五輪審查發現 shlex 版仍有兩類結構性弱點——「字串套一層殼」（`bash -c "git commit"`、`sh -c`、`eval`、`xargs`、`CMD="git commit"; $CMD` 變數展開）內層完全隱形，以及重導向插在子指令之前（`git > /dev/null commit -m x`）整條漏攔；同輪還誤擋了 `echo git commit`／`rg git commit`（git 當別人的參數卻被當成指令）。修法：偵測器對殼包裝的字串參數遞迴解析（深度上限 5）、追蹤同段的變數賦值供 `$VAR` 展開、掃子指令時同時跳過旗標與重導向、解析同一條指令裡 `-c alias.x=commit` 設的 alias、並要求 git 必須位在「指令位置」而非任意參數位置。邏輯搬進獨立 `.py` 讓它可單獨測試與審查，hook 本體從 195 行縮到 126 行；檔案不存在時退回不擋，fail-open 不變。
- **前置包裝詞改用「找第一個 git token」而非列舉選項**：第六輪審查指出 `timeout 5`／`env -i`／`nohup -p 1`／`command -p`／`xargs -n1` 全數繞過，根因是逐類列舉各包裝詞的選項形狀——列舉法漏一個就是一個洞（實測我自己就漏了 `nice -n 10`、`stdbuf -oL`）。改為在包裝詞後方從左往右找第一個 git token，任何前置包裝都涵蓋，不必維護選項清單。
- **仍不處理的邊界（註解與本檔都已揭露）**：使用者 `.gitconfig` 裡既有的 alias（如 `ci = commit`）需讀取 git 設定才能展開；跨 Bash 呼叫的 export 變數；動態組字串後 eval；超過 5 層的巢狀殼包裝（再深就退回不擋）。
- 第六輪審查再修五項（皆實測重現）：①換行被 shlex 當普通空白，第二行的指令整條漏擋 → 先把換行轉成分隔符；②包裝詞自己的選項與值沒跳過，`timeout 10 git commit`／`xargs -0 git commit`／`env FOO=1 git commit` 漏擋 → 逐類跳過；③`bash -c 'echo $1' _ 'git commit'` 的位置參數被當成指令而誤擋 → 區分「只有第一個參數是指令字串」（bash/sh/eval）與「後面整串是指令」（timeout/xargs/env/nohup）兩類；④重導向插在參數中間時中斷掃描，`git branch >/dev/null -f topic` 的 `-f` 被漏掉 → 改為跳過符號與目標而非中斷；⑤alias 值自帶旗標時只取第一個詞，`-c alias.b="branch -f"` 的 `-f` 遺失 → 其餘詞併入參數。另一項「變數被覆寫後漏擋」經實測**不成立**：覆寫成 git 會攔、覆寫成 echo 會放行，兩向都正確。
- 第七輪再修四項（皆實測重現）：①巢狀包裝 `timeout 5 bash -c '...'` 漏擋——B 類包裝詞把內層 token 用 `' '.join` 重組成字串再掃，含空白的 token 失去引號而散開，改為拆出 `scan_tokens()` 直接傳 token 串遞迴；②`eval` 會串接所有參數當一條指令，原本歸在「只掃第一個參數」那類而漏擋；③重導向寫在指令最前面（合法 shell）時 git 不在段首而漏擋 → 先剝掉段首重導向；④「往後找第一個 git token」會把 `env FOO=1 echo …` 這種「執行的是 echo」誤擋 → 改為只跳過包裝詞自己的東西（選項／`VAR=value`／時間量），遇到其他詞就停。另兩項經實測不成立：變數覆寫（Codex 連兩輪講反同一件事，它舉的例子最後的值是 echo、本來就該放行）、引號內的字面分號（前一輪已修好）。
- 第八輪修五項：變數展開後重組讓指令字串散開；賦值與重導向交錯在指令前時只剝一輪；包裝詞選項吃掉下一個 token（`env -u FOO`）；A 類取「第一個非選項參數」而非 `-c` 緊接者（`bash -o pipefail -c '…'`）；`strip_noise` 無條件剝 `=` 左側導致 `echo foo=git …` 誤擋。
- 第九輪修五項：控制結構關鍵字後的指令看不到（`if git commit …; then`）；雙引號內的指令替換被 shlex 保留在單一 token 內（`echo "$(git commit …)"`）；反引號賦值 `WIP=\`git commit\`` 的 token 被賦值分支刪掉；無 `-c` 時把腳本檔名當指令字串而誤擋（`sh 'git commit'` 實際是執行名為 git commit 的檔）；`-c` 合併在短旗標裡（`bash -lc '…'`）。
- 第十輪修五項，其中**三項是前一輪修改的副作用**：保留反引號賦值 token 的條件太寬，`X=$HOME git commit` 停在段首賦值而漏擋；遞迴掃替換內容時連外層的字一起掃，`echo "a $(git commit) b"` 的 git 落在 idx 1 被跳過；展開拆詞用值比對，`X='git commit -m x'` 會把同值的 `bash -c` 指令字串一起拆散。另兩項是新發現：`time -p git commit`（關鍵字自己的選項）、`echo '$(git commit)'` 誤擋（單引號內的替換是字面，shlex 剝引號後分不出來，改為斷詞前中性化）。
- 第十一輪修六項：單引號中性化的佔位符在遞迴前未還原，`bash -c 'X=git; $X commit'` 的變數展開失效；中性化 regex 不辨識外層雙引號，`echo "'$(git commit)'"` 的替換被當成字面；巢狀替換 `$(echo $(date); git commit)` 被非貪婪 regex 截斷；`command -v git commit` 只查位置卻被當成執行而誤擋；另兩項（引號內分號、續行）在同輪的其他修正中一併解決。
- 第十二輪修四項（皆屬「日常寫法」而非刻意構造）：前置包裝路徑對全部參數還原佔位符，`env echo '$(git commit)'` 的字面 `$` 被還原而誤擋；`command` 的 `-v` 判斷沒限定位置，`command git commit -v -m x` 的 verbose 旗標被當成查詢而漏擋；heredoc 內容被當成指令，寫入含 git 指令的文件會誤擋 → 整段移除；續行（反斜線接換行）先併起來再斷詞。
- 第十三、十四輪修「自帶目標的複合重導向寫在指令前面」這一類漏擋（`2>&1`、`1>&2`、`>&1` 加上後面接指令）：斷詞前補空白的步驟把 `&` 當成背景執行符，從中間把它切成三段，切完的 `2>` 又被當成「要吃下一個 token 當檔名」的重導向，把指令名整個吃掉，於是整條指令無人聞問。修法兩段：斷詞前先用佔位符把複合重導向整段保護起來、切完再還原；重導向的跳過改為區分「自帶目標」（只跳 1 個 token）與「後面接檔名」（跳 2 個）兩類，`&>`／`&>>` 屬後者。
- hook 回歸測試 270 項（攔截、不誤擋、fail-open、訊息內容、多行情境五類）。每輪審查抓到的繞過與誤擋變形都補成回歸案例，另存十三個歷輪案例集逐輪複驗、零回歸：第一輪 plumbing 與字串洞、第二輪 `git commit -m x; flow.sh` 夾帶與 `branch <name> -f` 旗標位置、第三輪 `--git-dir=.git` 等號旗標與 `symbolic-ref HEAD && ...` 誤擋。開發中自撞一次：`GIT_PREFIX` 的前置字元只認 `;&|` 與空白，漏掉指令替換——事故原文 `WIP=$(git -C "$W" commit-tree ...)` 整條漏掉，補 `(`、反引號、`$` 後才命中，且驗過 `SHA=$(git rev-parse HEAD)` 這類正常寫法不誤擋。
- 新增 `flow.sh amend` 子命令：把 SKILL 歷史改寫章節的六條規則機制化——自動建備份分支、用 `branch -r --contains` 加 `ls-remote` 兩段判斷擋已 push 的改寫、沿用 ship 全部真閘、改寫後比對「改寫前的 index 樹」與「改寫後的 HEAD 樹」。同時修正 SKILL 第 4 條的驗證方法只對「只改 message」成立的缺陷，拆成兩種驗法；並清掉四處「禁止 --amend」的描述（flow.sh 從未實作 amend，那是未實作不是禁止）。
- amend 子命令首版經雙軌審查退回，九項缺陷全數修正後才進版：①重現驗證原本取改寫後 HEAD 的 blob，等於拿結果證明結果，pre-commit hook 竄改內容仍印「驗證通過」（改為在改寫前 `git write-tree` 落下期望樹）；②rename 假陽性——`--name-only` 只列目的路徑，重建樹會殘留來源檔，且當下 commit 其實已成功卻引導使用者 reset；③中文與含空白檔名被 git 印成八進位跳脫，逐行解析必然對不上（②③隨①的改法一併消失，不再解析路徑字串）；④已 push 判斷只看本地遠端追蹤 ref，自己剛 push 完的 commit 會判回空而放行（補 `ls-remote` 實查，查不到則拒絕而非放行）；⑤沿用既有 message 讀 `%s` 會把 body 與 trailer 靜默刪光（改讀 `%B`，署名掃全文、單行檢查只對 subject）；⑥沿用時不驗 Type 前綴，不合規的既有 message 會被原地漂白；⑦有 staged 卻無 prepare hash 時只印 WARNING 放行，等於直接呼叫 amend 即可跳過審查比對（改為拒絕——ship 寫壞了還留在歷史可回溯，amend 是就地改寫，風險不對稱）；⑧`git commit --amend` 失敗時腳本靜默中止，不提備份分支下落；⑨TOCTOU 失敗留下垃圾備份分支。修 ⑧ 時另自撞一個 exit code bug：`$?` 被 `if` 判斷與 `local` 宣告各吃一次，失敗卻回 exit 0。
- 回歸測試從 13 項擴到 19 項。首版那 13 項全綠卻漏掉全部九個缺陷，因為測的都是預想路徑——rename、特殊檔名、檔案刪除、模式變更、hook 竄改、hook 擋下、未 fetch 的遠端、message 帶 body、無 Type 前綴，一項都沒測。綠測只證明「想到的情況會過」，不證明「沒想到的情況不會漏」。

## [0.5.1] - 2026-09-12
### Changed
- SKILL：TaskCreate 三條紀律＋禁止情境、匯流第 6 條（兩軌判不同嚴重度主 agent 實跑再匯流）；codex-troubleshooting：讀 diff 被沙箱擋（rejected: blocked by policy）不是 codex 不可用，改內嵌 diff 或 cat

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
