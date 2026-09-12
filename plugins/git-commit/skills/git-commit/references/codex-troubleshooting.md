# Codex（B 軌）疑難排解

> **什麼時候讀這份**：B 軌 codex agent 出現以下任一狀況，就從頭讀完本檔再動作——
> 不要憑印象處置，這裡每一條都是實際踩過、有日期與實測數據的。
>
> - 派出去只收到 idle、遲遲沒有 `VERDICT`
> - agent 回 `Agent type not found`
> - codex 回 `Not inside a trusted directory`
> - 回 400 `model is not supported` 或 `Model metadata for X not found`
> - 輸出檔卡在 `Reading additional input from stdin...` 不再增長
> - agent 回 `VERDICT: UNAVAILABLE` 且錯誤含 `rejected: blocked by policy`（**不是 codex 壞了**，見下）
> - 你想判定「codex 壞了、要降級單軌」——**判定前必讀**，這裡列了什麼才算客觀證據
>
> 一句話總則：**「我等不下去」不是「它壞了」的證據。** 判不可用之前先跑最小題。

---

## 讀 diff 被沙箱擋：`rejected: blocked by policy`（2026-09-11）

**症狀**：agent 回 `VERDICT: UNAVAILABLE`，錯誤原文長這樣——

```
exec_command failed: CreateProcess { message: "Rejected(\"`\"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\" -Command \"Get-Content -LiteralPath '.../staged-<repo>.diff'\"` rejected: blocked by policy\")" }
```

**這不是 codex 不可用**，也不該據此降級單軌。codex 本身活著、模型正常，被擋的只是
它為了讀 diff 檔而起的 **PowerShell 子程序**——沙箱 policy 不放行 `powershell.exe -Command`。

**處置（兩個都有效，擇一）**：

1. **把 diff 直接內嵌進 prompt**（小 diff 首選）。實測 13 行的 diff 內嵌後重送，35 秒回 `VERDICT: PASS`。
2. prompt 裡明講「用 `cat` 讀，不要用 PowerShell」。

⚠ 重送時把**上一次的錯誤原文**也貼進 prompt，並明寫「這次 diff 已內嵌、不需要讀任何檔案」——
否則 agent 很可能再走一次同樣的讀檔路徑。實測這樣寫就一次過。

**為什麼值得單獨列**：它的外觀（`UNAVAILABLE` ＋一長串 CreateProcess 錯誤）與「codex 真的掛了」
幾乎一樣，而處置完全相反——前者換個讀檔方式就過，後者才需要降級。誤判的代價是**白白跳過一軌審查**。

---

## 派工方式

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

**降級前先排除 model 下架**：Codex 可用模型會隨帳戶方案／服務端調整而變動（2026-09-05 實證：`gpt-5.4` 於 8/31 退役、config 仍寫該值 → 兩個 agent 皆回 400 `not supported`，實為設定過期而非環境故障，卻走完整套降級流程）。錯誤訊息含 `model is not supported` 或 `Model metadata for X not found` 時，先在任一 repo 內跑 `bash .claude/skills/git-commit/codex-model-sync.sh`——它讀 `~/.codex/models_cache.json`（CLI 維護的**帳號專屬**可用清單，非全球目錄）取 priority 最小者、實測送得出請求才寫回 config；exit 0＝已對齊，exit 1＝需人工處理。對齊後重送 B 軌即可，**不必降級**。官方文件明列 `gpt-5.4`／`gpt-5.4-mini` 為 deprecated，此類退役會再發生。

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
