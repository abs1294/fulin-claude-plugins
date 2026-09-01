---
name: git-commit
description: >
  並行審查模式的 Git Commit 流程：Stage → 並行三軌（使用者確認 message + Codex 審查 + code-reviewer 審查）→ Commit → Push。
  觸發詞（任一命中即觸發）：
  - 中文：「commit」、「提交」、「上版」、「推上去」、「推上板」、「推」
  - 指令式：「git commit」、「git push」、「git add」、「push」
  - 組合：「commit and push」、「commit 後 push」、「stage 一下」
  **重要**：AI 禁止直接執行 `git commit` / `git push` / `git add` 指令。
  只要使用者意圖是「要把程式碼提交或推上去」，一律透過本 skill 走完整流程。
---

# Git Commit Skill — 並行審查流程

核心設計：兩軌審查（Codex＋code-reviewer）前移到 commit **之前**，與使用者確認 message 三軌並行。BLOCK 只需改碼重 stage，無需 revert/reset，git 歷史永遠乾淨。

| 階段 | 動作 |
|------|------|
| Step 1 | `analyze` 分析 → `prepare` stage → **同一輪並行三軌**（1.3a 預覽＋1.3b Codex＋1.3c code-reviewer）→ 匯流 |
| Step 2 | `ship`（commit → push → 驗證） |

多步驟用 TaskCreate 追蹤、完成當下關、流程結束清空清單。

## 核心原則（默許機制）

> Commit 觸發條件：**Codex 非 BLOCK ∧ code-reviewer 非 BLOCK ∧ 使用者未明確否決。**

1. 兩軌皆 PASS（或豁免）＋使用者未回覆 → **自動 commit**（默許；local）。push 另需使用者當次明確核可（如「commit 並推上去」）才帶 `--push`。預覽時必須明講此行為。
2. **任一軌 BLOCK → 永不自動 commit**，列必修項等使用者——即使使用者已先回 OK。
3. 使用者明確否決（「等等」「先別上」、改 message、調 staging）→ 照使用者意思，不 commit。
4. PASS 附清單＝「可 commit 但有建議」，預設放行；使用者要先修 → 改碼 → 重跑 `prepare` → 兩軌重送（diff 變了就重判豁免）。BLOCK 後重做同樣走完整 Step 1。禁止沿用先前確認過的 message 直接 commit（碼可能已變）。

## Review 豁免規則

`Style`（純 CSS／`<style>` 區塊／template class 調整／i18n value／格式化）與 `Docs`（純 `.md`／註解文字／XML doc 內文）可**同時豁免兩軌**（不得只豁免一軌），敏感掃描仍必做，1.3a 預覽仍要出並標示「已豁免——未回覆將自動 commit + push」。

判斷原則一句話：**diff 觸及「會被執行到的程式邏輯」一律不豁免**——`.vue` 的 `<script>`、`v-if`/`@click` 綁定、i18n 的 **key**（value 不算）、任何 `.cs`/`.js`/`.ts` 邏輯行，都算。使用者標 Style/Docs 但 diff 含邏輯行 → 告知「diff 含邏輯修改，仍送審」，禁止私下豁免。

## flow.sh（必用）

`.claude/skills/git-commit/flow.sh` 包掉所有純 git 操作，**不要手動組 git 指令**：

| 指令 | 動作 |
|------|------|
| `flow.sh analyze <repo>` | 狀態分類＋local-overrides 過濾＋敏感字掃描 |
| `flow.sh prepare <repo> <files...>` | 逐檔 `git add` → staged diff 輸出到 `.claude/.git-commit-tmp/staged-<repo>.diff` |
| `flow.sh ship <repo> <type> <description> [--push]` | HEREDOC commit → 驗證（內建禁 `--amend`/`--no-verify`/force push、過濾 AI 署名）。**預設只 local commit；帶 `--push` 才推遠端**——push 不可逆，需使用者當次明確核可 |

`<repo>`＝`.` 或工作目錄下的 git 子目錄名（多 repo workspace 各自獨立 commit）。`<type>`＝`Feat`/`Modify`/`Style`/`Refactor`/`Perf`/`Chore`/`Docs`/`Test`/`Fix`/`Hotfix`。

腳本不能代勞的：豁免判斷、1.3a 預覽、啟動兩個審查 subagent、匯流決策。

## Step 1

### 1.1–1.2 分析與 Stage

對每個有變更的 repo 跑 `analyze`，輸出已含敏感掃描（password/secret/token/硬編 JWT/console.log/TODO: remove 等 pattern）與 local-overrides 過濾。掃描命中 → 預覽列出請使用者確認是否刻意保留；清單外的可疑 unstaged（`appsettings.Localhost.json`、`BlobStorage/`、含測試 JWT 的檔）→ 預覽提醒。

**local-overrides.yml**（`.claude/local-overrides.yml`，記錄本機常駐覆寫檔——Mock 切換、本地連線、測試 JWT）：清單內檔案不告警、不 stage、不進預覽。使用者明示要 commit 清單內檔案 → 本次 override 走完整流程，commit 後問「本地預設值變了嗎？要不要移出清單？」。同一 tracked 檔連續多次未 stage → 主動建議入清單。

**Stage 紀律（事故收據 2026-07-17）**：**禁止 `git add -A` / `git add .`**——會把 local-overrides 的本機 hack 整檔混進 staged。一律逐檔 `prepare`；覆寫清單內「混有真改動」的檔案（如 Program.cs 的 DI 註冊）用 `git diff` 切 hunk、`git apply --cached` 精準 stage，commit 前 grep `LocalDevToken|MockSap|MockBPM|mysecret` 確認 staged diff 0 命中。禁 `git update-index --skip-worktree`。

### 1.3 並行三軌（同一輪訊息啟動）

#### 1.3a 預覽（A 軌）

Commit message 用 unicode double-line box 框住＋包 fenced code block（高對比，CJK 對齊目視即可）；無警示就不出警示區塊。格式：

```markdown
## 📦 {Repository}（{分支}）

**Staged 檔案：**
- `M` `src/path/file.vue` (+10/-5)

**⚠️ 掃描警示：**（若有才出）
- 敏感字：`<file>:<line>` 發現 `"password"`
- AI 痕跡：`<file>` 新增行引用文件出處（`§`／`CLAUDE.md`／`設計文件`）——ship 會擋，須先改掉

### 📝 建議 Commit Message

\```
╔══════════════════════════════════════════╗
║  {Type}: {描述}                           ║
╚══════════════════════════════════════════╝
\```

🚀 兩軌 Review 非 BLOCK 後將自動 commit + push；要攔截／改 message／調 staging 請在審查完成前回覆
**🔍 Codex Review：**🟡 進行中｜✅ 已豁免（理由）— 未回覆將自動 commit + push
**🔍 code-reviewer：**🟡 進行中｜✅ 已豁免（理由）— 未回覆將自動 commit + push
```

#### 1.3b Codex（B 軌）

> ⚠️ subagent_type 必為 **`codex:codex-rescue`**（踩過多次：`codex:rescue` 是 slash command、`codex-rescue` 缺 namespace、`codex` 只是 namespace——回 `Agent type not found` 就是踩這坑）。

`run_in_background: true`，與 1.3a/1.3c 同輪。diff 已在 `.claude/.git-commit-tmp/staged-<repo>.diff`。

> ⚠️ **派工前先確認 cwd 在 git repo 內**（本 workspace 必然觸發）：codex 拒絕在非 git 目錄啟動，
> 直接回 `Not inside a trusted directory and --skip-git-repo-check was not specified.` 然後退出。
> subagent 的預設 cwd 是 workspace 根（四個 repo 各自獨立，**根目錄不是 git repo**），所以不指定就必死。
> **prompt 開頭必須明寫「執行任何 codex 指令前先 `cd` 到 `<repo>` 目錄」**，並要求失敗時回 `VERDICT: UNAVAILABLE` 附錯誤原文、不得靜默退出。
> 2026-08-26 實證：上一輪派出的 codex agent 只送一次 idle、無 VERDICT、等逾 1 小時，事後查 `Get-Process codex` = 0、
> agent 也不在 `ListAgents` 清單——不是算很久，是**啟動即死**。同一道最小題在 workspace 根失敗、切到 repo 內即回 `PING_OK`。
> **所以判不可用前的第一件事是跑最小題（在 repo 內），不是耐心等**——耐心等只對「真的在算」有意義，對「根本沒啟動」只是白費時間。

> ⚠️ **`codex exec` 一律要重導 stdin：`codex exec ... "$PROMPT" < /dev/null`**（2026-08-31 實證，根治性修法）。
> 不帶 `< /dev/null` 時，codex CLI 讀完 arg 的 prompt 後**仍會去等一個永遠不會結束的 stdin**，
> 輸出檔卡在 `Reading additional input from stdin...` 不再增長，程序存活但 CPU 幾乎不動。
> 現象與「算很久」肉眼無法分辨——實證卡死 16.5 分鐘、CPU 僅 0.03 秒才被 CPU 判準揪出。
> 補上重導後同一份審查立刻正常跑完（EXIT_CODE=0）。**這是必死坑，不是偶發。**

**Codex 要時間，別把「我等不下去」當成「它壞了」**（2026-08-23 實證，同輪犯三次）：

- **idle 通知 ≠ 沒在跑、≠ 死了**。subagent 送出 idle 只代表它此刻沒訊息要說；催它、看不到動靜都不構成「不可用」的證據。實證：`codex-fe2` 被催兩次仍無回應，第 3 分鐘回了完整 VERDICT 並糾正三個疑慮；`codex-be3` 亦在放手等待後正常回覆。
- **判定不可用前，必須有客觀證據**，至少其一：①`Get-Process codex` 為 0 且重跑最小題（`codex exec --json "回 PING_OK" < /dev/null`）也失敗；②程序在但**CPU 近乎為零且持續數分鐘不動**（＝卡死，見下方判活）；③agent 明確回 `VERDICT: UNAVAILABLE`。**「我設的 timeout 到了」不是證據。**
- **逾 10 分鐘先告知一次＋同步檢查 codex 活性、之後續等不再打擾，至多等到 1 小時**：滿 10 分鐘時告知使用者「已逾時、仍在等」並附現有軌別狀態，**不必問、不停下**；同一時點做活性檢查——**活著就繼續等，死了就重新起**：
  - **判活**：程序要同時滿足**兩個**條件才算在算——①StartTime 晚於本輪送審時刻，②**CPU 時間有在累積**（`Get-Process codex | Select Id, StartTime, CPU` 三欄一起看）。**只看程序存在會漏掉「啟動了但沒在算」**（2026-08-31 實證：PID 存活 16.5 分鐘、CPU 僅 0.03 秒＝卡在等 stdin，比同機 8/27 殭屍的 68 秒還低，卻因符合「StartTime 晚於送審」而被判成正在算，白等）。**只數程序數更會被殭屍污染**（2026-08-28 實證：8/27 殘留 PID 兩度被誤判）。存活數分鐘而 CPU 仍近乎為零 → 直接當卡死處理，不要續等。
  - **查無新程序 ≠ 死**：codex exec 跑完即退（同日實證：agent 已把完整 VERDICT 寫入輸出檔、程序早退查不到）。此時 SendMessage 向 agent 要狀態（回 VERDICT／`RUNNING since <時間>`／`VERDICT: UNAVAILABLE` 附錯誤原文），並可在 repo 內跑最小題（`codex exec --json "回 PING_OK"`）驗 CLI 本體。
  - **確認死**（agent 要不出結果＋無新程序＋最小題可過＝agent 端沒起）→ **重新起**：重送同一份審查請求（必要時重派 agent），計時重算；重起一次仍死才走單軌降級。
  之後安靜續等，不再每輪回報。滿 1 小時仍無 VERDICT 才停下請使用者決定（續等／以現有結果單軌降級）。期間使用者隨時可指示改以現有結果決策。自行判定不可用就 commit＝違規。
- **審查任務本來就比雜務慢得多**。診斷分級（2026-08-23 實測）：純文字／`echo`／讀小檔／跑 git／讀 28KB diff 全部**數秒完成**；唯獨「讀 diff ＋分析＋給 VERDICT」需 **7 分鐘以上**。慢的是思考，不是工具。據此排除「讀檔會卡」「大檔會卡」這類誤判——曾據此誤宣告不可用。
- **前景 `codex exec` 的失敗完全不能拿來判 subagent 生死**：兩者是不同執行路徑，且在本機實測**結果相反**——同一份審查任務，subagent（`codex-be3`）數分鐘內回完整 PASS，前景 `codex exec` 給到 **20 分鐘仍 timeout、零輸出**（2026-08-23 背景任務實證）。也就是說前景路徑在本機對「審查」等級的任務根本跑不出來，前景失敗**不代表任何事**。要診斷 Codex 本身請用 `--json`（事件流即時輸出，繞開 renderer 緩衝）逐步加壓（純文字→shell→讀小檔→讀大檔→完整審查）定位斷點；但**要判 subagent 可用與否，只看 subagent 自己的回覆**。
- 逾 600 秒會被工具層轉背景續跑，**那是繼續執行、不是失敗**，等通知即可。

**真的不可用時的降級**：先排除命名坑（見上方 ⚠️）；取得上述客觀證據後 → 單軌降級（B 軌記 `skipped: codex-unavailable`、匯流視為 PASS），預覽明講「本環境不可用，已降為單軌」，並補做 B 軌該查的項目（注入風險、跨檔一致性、邊界守門）；**兩軌都不可用 → 不可自動 commit**，停下請使用者人工確認。不當 PASS 的原則不變。另需分辨**工具層逾時**——agent 回報「任務仍在背景跑但我不被允許輪詢」而非 Codex 算得慢 → 直接重送一次，不計入等待時間（2026-08-16 實證：首次工具層 2 分鐘卡住無 VERDICT，重送後 37 秒回覆）。

Prompt 範本：

```
請審查 staged diff（在 <DIFF_PATH>，請先 `cat` 讀取）。

【任務背景】<一句話：這次改動在做什麼、影響範圍>

【判準】
- BLOCK：會壞功能、資安洞、邏輯錯、敏感資訊外洩（.env / credentials / hardcoded JWT / 連線字串）、
         改名遺漏跨檔、不該 commit 的檔案。
- PASS：其餘一切。有疑問寧可 BLOCK。

【重點檢查】明顯 bug／邊界（rollback、exception、null）／安全性／不該 commit 的檔案或 debug 痕跡／改名跨檔殘留

【回覆格式，嚴格遵守】
第 1 行：`VERDICT: PASS` 或 `VERDICT: BLOCK`
第 2 行起每行 `- <file>:<line> <短描述>`：BLOCK 列所有必修項；PASS 列所有觀察點
（edge case／跨檔殘留／缺測試或 i18n／future risk——觀察到幾項列幾項，不自我省略；真沒有才只回第 1 行）
一句話講清楚即可，不寫「應該怎麼改」；不要分析段、標題、總結。
```

#### 1.3c code-reviewer（C 軌）

`subagent_type: code-reviewer`、`run_in_background: true`，同輪觸發。Prompt 範本（VERDICT 格式與 B 軌對齊，利匯流判讀）：

```
請審查 staged diff（在 <DIFF_PATH>，請先 `cat` 讀取）。

【任務背景】<一句話：這次改動在做什麼、影響範圍>
【審查對象】Repository: <repo>；檔案類型：<.vue/.cs/...>；適用規則：code-review Skill＋rules/

【判準】
- BLOCK：🔴 Critical（違反架構原則、資安洞、破壞 DDD 分層、必錯邏輯）
- PASS：無 Critical 即放行；🟡 Important／🟢 Minor 列清單供使用者決定。

【重點檢查】架構規範（DDD/CQRS/Repository/Section component）／規則違反／資安／i18n 完整性／測試覆蓋

【回覆格式，嚴格遵守】
第 1 行：`VERDICT: PASS` 或 `VERDICT: BLOCK`
第 2 行起每行 `- <file>:<line> [<Critical|Important|Minor>] <短描述>`
一句話講清楚即可，不寫「應該怎麼改」；不要分析段、標題、總結。
```

多 repo 可合併或拆分送審，但**全部非 BLOCK** 才進 Step 2。

### 1.4 匯流

B＋C 皆返回即匯流（不等 A 軌），按核心原則四條決策。補充：

- 自動 commit 前輸出：兩軌狀態＋「使用者回覆：尚未（視為默許）」＋套用的 message；PASS 附清單時**清單先列給使用者**再告知已開始自動 commit。
- BLOCK 處理：列必修項 → 使用者決定修或強制 commit（需明示）→ 修的話改碼、重 `prepare`、兩軌重送，直到全非 BLOCK。無 revert、無歷史噪音。

## Step 2：`flow.sh ship`

- **禁止 AI 署名**（`Co-Authored-By: Claude` 等）——公司禁止揭露 AI 參與；腳本已過濾，description 參數也不得夾帶。
- 禁 `--amend`（除非使用者明示）、禁 force push；push 到 `main`/`master` 前特別確認使用者意圖。
- 使用者要求跳過審查（緊急 hotfix）→ commit message 下加 `[skip-review: <原因>]` 並告知破例。

**pre-commit hook 失敗，先分辨兩種情況：**

- **(a) hook 正常執行但檢查不過**（eslint/測試失敗）→ 依提示修正 → 重跑 `prepare` → 兩軌重審 → 再 `ship`。
- **(b) hook 本身故障**（`Exec format error`、segfault、CRLF/缺 shebang、無法 spawn）→ 這不是程式碼問題，修碼會卡死。處置：①手動補跑 hook 本該做的檢查（prettier/eslint/test）確認乾淨；②明告使用者是 hook 環境故障＋已補跑哪些檢查；③**經使用者同意**才可手動 `git commit --no-verify`（本 skill 唯一允許情境，脫離 flow.sh），message 加 `[skip-verify: hook 環境故障，已手動補跑 <檢查項>]`；④建議根治（修 shebang/LF 或 `core.autocrlf=input`），不根治每次都炸。

## Commit Message 規範

格式：`{Type}: {簡短描述}`——Type 首字大寫、冒號後空格、中文描述 1 句 ≤50 字。例：`Feat: 相關申請紀錄新增發起人欄位與 Excel 匯出`。

| 類型 | 說明 |
|------|------|
| Feat | 新功能 |
| Modify | 既有功能需求調整的修改 |
| Style | UI 調整、格式調整 |
| Refactor | 重構（不改變功能） |
| Perf | 改善效能 |
| Chore | 建置設定、版號等瑣事 |
| Docs | 純文件 |
| Test | 測試 |
| Fix | 錯誤修正 |
| Hotfix | 緊急修正嚴重 bug |

**描述只寫「改了什麼」，禁止對話脈絡**：`P0/P1/Critical`、`紅藍對抗/紅隊/Codex/code-reviewer`、`PoC/第 N 輪/補修`、任何 reviewer 名稱或流程關鍵字都不得出現。辨識法：未來看 git log 的人沒有今天的 context——message 離了 context 看不懂就重寫成「對著 diff 也讀得懂」的純動作描述（❌ `Fix: 補 P0 防護` → ✅ `Fix: handleConfirmFinalReply 失敗時保留 dialog`）。

## 多議題拆 Commit（不要問）

Dirty 檔案涵蓋多個不相關議題 → **直接拆多個 commit，自己決定怎麼拆與 message 用詞**（使用者明示過偏好拆、不要問）。一個議題＝一個 commit；同議題跨多檔放同 commit；同檔跨多議題可合併、message 概括。逐個走完整流程（`analyze`→`prepare`→三軌→`ship`），完成一個再 `analyze` 下一個。可以問的例外：檔案歸屬判不明、跨 repo 邊界（內外站誰先誰後）、涉破壞性操作。

## Changelog
- 2026-08-31 新增真閘 5「AI 痕跡」（使用者當次指示，`--allow-ai-trace` 可豁免）：掃 staged diff **新增行**是否引用外部文件出處（`CLAUDE.md`／skill／設計文件／`docs/*.md`／裸 `§` 章節號），`.md` 除外；prepare 顯示、ship 攔截。起因是一次清出 53 處同型痕跡散在 4 個 repo，根因為「註解撰寫規範」曾有「✅ 指向規範文件」的鼓勵條文（已刪並改立 N9）。**判準含裸 `§` 是必要的**——實證刪掉「CLAUDE.md §8.2」後，同段落下一行的 `§8.4` 不含任何關鍵字，關鍵字與「見/依+章節」兩種判準都抓不到，第三種純掃 `§` 才撈出 13 處。已實跑紅綠測（含 `.md` 排除、裸 `§` 命中、刪除行不誤判、`--allow-ai-trace` 放行）。
- 2026-08-31 B 軌判活補 CPU 判準＋stdin 根治條款（使用者當次指示）：原規則只看「StartTime 晚於送審」，擋得住殭屍污染卻擋不住「啟動了但沒在算」——實證 PID 存活 16.5 分鐘 CPU 僅 0.03 秒（比同機殭屍的 68 秒還低）卻被判成正在算，白等 16 分鐘。修正為 StartTime 與 CPU 累積**兩個條件並用**。根因是 `codex exec` 未重導 stdin 導致 CLI 卡在 `Reading additional input from stdin...`，已列為必死坑，一律帶 `< /dev/null`。
- 2026-08-28 10 分鐘通知點加入 codex 活性同步檢查（使用者當次指示）：活著→續等；死了→重送同一審查（重起一次、計時重算），重起仍死才降級。判活必看程序 StartTime 是否晚於送審時刻——同日兩個實證：殭屍 PID（8/27 殘留）污染「正在算」判讀白等；codex exec 跑完即退，「查無程序」時 agent 其實已寫完 VERDICT，先要狀態再判死。
- 2026-08-26 B 軌補「codex 拒絕在非 git 目錄啟動」的必死坑（使用者當次指示記錄）：subagent 預設 cwd 是 workspace 根、而根目錄不是 git repo，codex 會回 `Not inside a trusted directory` 即退出，現象與「算很久」完全相同（只送 idle、無 VERDICT），實證白等逾 1 小時。修正：prompt 開頭強制指定 `cd` 到 repo，並把「先跑最小題」提到「耐心等」之前。
- 2026-08-25 B 軌等待門檻 5 分鐘 → 10 分鐘，改為「告知一次後續等、至多 1 小時」（使用者當次指示）。起因：原門檻 5 分鐘與同段實測「完整審查需 7 分鐘以上」自相矛盾，照規則走每次都必然打擾使用者一次。新規則下 10 分鐘只告知不停手，1 小時才是真正的停損點。
- 2026-08-23 B 軌等待紀律重寫（使用者當次指示「Codex 要等啊，你是不是太急」）：明訂 idle≠死亡、判不可用須有客觀證據（程序數 0＋最小題失敗，或 agent 回 UNAVAILABLE）、逾 5 分鐘是問使用者而非自行降級；補審查任務的耗時分級實測（雜務數秒 vs 完整審查 7 分鐘以上）與 `--json` 逐步加壓的診斷法。起因：同一輪三次把自設 timeout 當成 Codex 失效，並據錯誤診斷（「讀檔就卡」）自行降級 commit。事後背景任務補證：同一審查任務 subagent 數分鐘回 PASS、前景 `codex exec` 給 20 分鐘仍 timeout 零輸出，兩路徑結果相反，故前景失敗不可作為 subagent 不可用的依據。
- 2026-08-16 審查軌逾時門檻明定為 5 分鐘（使用者當次指示：「我願意等他到 5 分鐘」）：5 分鐘內續等不打擾，逾時才問；並補「工具層逾時 vs Codex 算得慢」的分辨與重送處置。
- 2026-07-31 713 行壓縮至本版（Claude 5 世代 context engineering 調整，經使用者核准）：砍 9-task 編排時序細則（追蹤紀律歸 memory `feedback_task_tracking_discipline`）、三處重複豁免說明合一、20 列匯流矩陣壓成四條核心原則、排版細則壓行。三軌架構、默許機制、豁免判準、flow.sh 介面、事故收據條款（git add -A／codex 命名坑／hook 故障處置／AI 署名禁令）全數保留。
