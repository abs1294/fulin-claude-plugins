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


## 快速參照（先掃這張表，再讀對應段落）

| 症狀 | 一句話處置 | 細節 |
|---|---|---|
| `rejected: blocked by policy` | **diff 內嵌進 prompt ＋ 寫死「不要執行任何指令、不要讀取任何檔案」，且不附檔案路徑** | §讀 diff 被沙箱擋 |
| `Agent type not found` | `subagent_type` 必須是 `codex:codex-rescue` 完整字串 | §派工方式 |
| `Not inside a trusted directory` | prompt 開頭加「先 `cd` 到 `<repo>`」 | §派工方式 |
| 400 `model is not supported` | 跑 `codex-model-sync.sh`，是 model 下架不是環境故障（**model 名若是旗標字樣，是下一列**） | §降級前先排除 model 下架 |
| 400 `The '--continue' model is not supported`（model 名是 prompt 裡的某個旗標字樣） | prompt 內的 `-m` 之類被 companion 當成 `--model`；prompt 要求「以 stdin／暫存檔傳入、不拆成命令列參數」，範例指令的短旗標改用文字描述 | §派工方式 |
| `--resume-last is not supported`（exit 1） | agent 自帶 `--resume-last` 接續舊 thread，本帳號不支援；走 companion 時明寫「`task --fresh`，禁止 `--resume-last`／`--resume`」 | §派工方式 |
| `error: unexpected argument '--fresh' found`（exit 2） | `--fresh` 是 companion `task` 的旗標，**`codex exec` 沒有**；直接用 exec 就不加（exec 本來每次就是新 session） | §派工方式 |
| `You've hit your usage limit ... try again at <時間>` | **不是不可用，不得 skipped／降級**（`review-record` 會擋）：取重置時間、當輪排重置後約 5 分鐘的一次性喚醒（CronCreate）重跑 B 軌，預覽明講已排幾點；**載不到 CronCreate 就把應重跑的時間回報呼叫端，不得寫「已排」** | SKILL.md 核心原則 5 |
| exit 0 但輸出沒有 `VERDICT:` 行 | **不是審查完成**：多半是管線（`codex exec ... \| tail`）把 codex 的非 0 exit 蓋成 0。看 `${PIPESTATUS[0]}` 與原始輸出；沒有 VERDICT 就是沒有可採用的結論（沒跑、中途失敗或輸出被截斷），回 UNAVAILABLE | §派工方式 |
| 卡在 `Reading additional input from stdin` | `codex exec` 加 `< /dev/null` | §派工方式 |
| 只收到 idle、沒有 VERDICT | **不是死了**，續等；判死要客觀證據 | §判活與降級 |
| 回「無法驗證」型 BLOCK（全是 remain unverified） | 同第一列——它讀不到檔，不是發現缺陷 | §讀 diff 被沙箱擋 |
| 想判定「codex 壞了」 | 「我等不下去」不是證據——先跑最小題 | §判活與降級 |

⚠ **`blocked by policy` 是最常誤判的一條**：外觀像 codex 掛了，實際只要改 prompt 就過。
**本機實測**（2026-09-20）：沙箱擋掉**所有**外部 shell（`powershell.exe`、`bash.exe`、`cat`），
所以「改用 cat 不要用 PowerShell」這類處置**在此環境無效**——只有內嵌 diff ＋硬性禁令有用。
其他環境若沙箱正常，讀檔本來就會成功、不會走到這條；但內嵌仍是較可靠的預設做法。

---

## 讀 diff 被沙箱擋：`rejected: blocked by policy`（2026-09-11）

**症狀**：agent 回 `VERDICT: UNAVAILABLE`，錯誤原文長這樣——

```
exec_command failed: CreateProcess { message: "Rejected(\"`\"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\" -Command \"Get-Content -LiteralPath '.../staged-<repo>.diff'\"` rejected: blocked by policy\")" }
```

**這不是 codex 不可用**，也不該據此降級單軌。codex 本身活著、模型正常，被擋的只是
它為了讀 diff 檔而起的 **PowerShell 子程序**——沙箱 policy 不放行 `powershell.exe -Command`。

**處置（唯一可行）**：**把 diff 直接內嵌進 prompt，並下硬性禁令。**

```
【嚴格限制】不要執行任何指令、不要讀取任何檔案。
（本環境的 codex 沙箱會擋外部 shell，讀檔必敗。）
以下資訊已完整提供，僅根據它判斷。

<diff 內容直接貼在此，不要附任何檔案路徑>
```

三個必守（2026-09-20 實測，三次失敗換來的）：

1. **不要在 prompt 裡附檔案路徑**——給了它就會去讀。第三次失敗就是內嵌了 diff 卻又附上路徑。
2. **禁令要硬**——只寫「不需要讀任何檔案」不夠，要寫「不要執行任何指令、不要讀取任何檔案」。
3. **大 diff 不是例外**——791 行的 diff 一樣可行，只內嵌需要判斷的部分（JSON 結構 diff、
   檔案清單、已驗證結果）即可。因為「太大」而改走別的處置，是 09-20 選錯處置的主因。

> **只講「用 `cat` 讀、不要用 PowerShell」在本機無效**：2026-09-20 實測改講用 cat 之後，
> codex 改起 `bash.exe`，一樣 `rejected: blocked by policy`——沙箱擋的是**所有**外部 shell，不是特定某一種。

**沙箱層根因**（2026-09-20 實測）：`codex sandbox cat package.json` 直接回
`cat.exe: *** fatal error - CreateFileMapping ... Win32 error 5`（存取被拒）——
Git-Bash 的 cygwin 工具在 codex 沙箱內建不了共享記憶體映射。實測所有 sandbox 模式
（預設／`-s read-only`／`--ignore-rules`／`-c approval_policy="never"`／
`-c sandbox_permissions=["disk-full-read-access"]`）**全部擋**，僅 `-s danger-full-access` 例外。
但**不需要動沙箱設定**——prompt 寫對就好：實測純推理任務（明令不執行指令）回完整 VERDICT 正常。

**他律**：PreToolUse hook `guard-codex-diff-embed.js`——派 codex 系 agent 時，
prompt 含 `.git-commit-tmp`／`staged-*.diff` 路徑、或含「先 cat 讀取」類指示而無硬性禁令，即擋。

⚠ 重送時把**上一次的錯誤原文**也貼進 prompt，並明寫「這次 diff 已內嵌、不需要讀任何檔案」——
否則 agent 很可能再走一次同樣的讀檔路徑。實測這樣寫就一次過。

**為什麼值得單獨列**：它的外觀（`UNAVAILABLE` ＋一長串 CreateProcess 錯誤）與「codex 真的掛了」
幾乎一樣，而處置完全相反——前者換個讀檔方式就過，後者才需要降級。誤判的代價是**白白跳過一軌審查**。

---

## 派工方式

> ⚠️ subagent_type 必為 **`codex:codex-rescue`**（踩過多次：`codex:rescue` 是 slash command、`codex-rescue` 缺 namespace、`codex` 只是 namespace——回 `Agent type not found` 就是踩這坑）。

`run_in_background: true`，與 1.3a/1.3c 同輪。

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

> ⚠️ **呼叫層的兩個坑：都不是審查結論，是 codex 根本沒跑起來**（2026-09-24 實證，同一次 commit 的第三輪審查連踩兩次）。
> - **prompt 裡的類旗標字樣被當參數**：審查的是 git 旗標偵測器，prompt 範例寫了 `git merge -m --continue topic`，
>   回 `400 The '--continue' model is not supported when using Codex with a ChatGPT account.`。
>   codex companion（`codex-companion.mjs` 的 `aliasMap: { m: "model" }`）把 `-m` 解析成 `--model`，後一個 token 就成了 model 名。
>   同一時段 config 的 `gpt-6-astra` 前兩輪都正常回 VERDICT——**錯誤訊息裡的 model 名若是某個旗標字樣，是 argv 解析，不是 model 下架，別跑 model-sync**。
>   （「prompt 被拆成 argv」這段是推論：agent 實際下的指令列看不到；改寫 prompt 後即不再發生。）
> - **`--resume-last` 本帳號不支援**：agent 自行帶上接續舊 thread 的旗標，回 `--resume-last is not supported with this Codex account type`（exit 1）。
> - **`--fresh` 只有 companion 認得**（2026-09-25 實測，使用者回報）：`--fresh` 是 `codex-companion.mjs task` 的旗標（`booleanOptions` 內），`codex exec` 沒有——
>   `codex exec --fresh ...` 回 `error: unexpected argument '--fresh' found`（exit 2），完全沒跑。更危險的是接在管線裡：`codex exec --fresh ... 2>&1 | tail -3`
>   末端 exit 為 **0**、`${PIPESTATUS[0]}` 才是 2——外觀像審查跑完，實際整軌白跳。早期文件寫「一律帶 `--fresh`」沒分兩條路，照 exec 寫法就中。
>   **判定有結論的唯一依據是輸出裡的 `VERDICT:` 行**，不是 exit code；沒有這行不論原因（沒跑、中途失敗、輸出被截斷）都不能當審查完成。
> - **處置**（照做後同一份審查兩輪皆正常回 VERDICT）：prompt 開頭明寫三句——「開全新對話：走 companion 用 `task --fresh`、禁止 `--resume-last`／`--resume`；直接用 `codex exec` 則不加 `--fresh`」
>   「審查內容寫成檔案後以 stdin 傳給 codex（`codex exec ... < 內容檔`，此時不再另加 `< /dev/null`），禁止拆成命令列參數」「失敗時逐字貼錯誤原文（含 exit code 與 stderr），不要轉述」；
>   審查內容本身若含 git／CLI 旗標範例，短旗標改用文字描述（例「訊息選項（短旗標 m）」）。

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

**額度用完不是不可用**（2026-09-24 實證：同一天兩度撞上 ChatGPT 帳號的 Codex 用量上限，第一次 18:32 回 `try again at 8:24 PM`，重置後兩輪審查又用完、回 `try again at Sep 25th, 2026 1:27 AM`）：額度錯誤有明確的恢復時間，不符合下面「真的不可用」的判準。處置照 SKILL.md 核心原則 5——取重置時間、當輪排一次性喚醒、預覽明講幾點重跑。**冷啟實測**（2026-09-25，假 codex 固定回 `try again at 4:29 PM`、不告知測試目的的 general-purpose subagent 照 SKILL.md 走 commit）：沒記 skipped、沒 commit、正確算出 16:34——但 subagent 內 `ToolSearch("select:CronCreate")` 回 `No matching deferred tools found`，喚醒排不上；它照實回報「應排 16:34、未排上、需手動重跑」，沒有謊稱已排。所以在 subagent 裡跑 git-commit 時，排程要交回呼叫端（headless 等其他環境未驗證；只要載不到 CronCreate 就同樣處理）。goal2 的 `delaylocal` 不能代替：它排的是 Claude 5h quota 的重置時間，且自己也靠 CronCreate；`review-record` 對理由含額度字樣的 `skipped` 一律拒收，所以「記 skipped 先 commit」這條路機械上走不通。注意 companion 在額度用完時也可能先報成別的錯（本機曾誤報「CLI 未安裝」），判定前先跑最小題看原文。

**真的不可用時的降級**：先排除命名坑（見上方 ⚠️）；取得上述客觀證據後 → 單軌降級（B 軌記 `skipped: codex-unavailable`、匯流視為 PASS），預覽明講「本環境不可用，已降為單軌」，並補做 B 軌該查的項目（注入風險、跨檔一致性、邊界守門）；**兩軌都不可用 → 不可自動 commit**，停下請使用者人工確認。不當 PASS 的原則不變。另需分辨**工具層逾時**——agent 回報「任務仍在背景跑但我不被允許輪詢」而非 Codex 算得慢 → 直接重送一次，不計入等待時間（2026-08-16 實證：首次工具層 2 分鐘卡住無 VERDICT，重送後 37 秒回覆）。

Prompt 範本以 SKILL.md 1.3b 為準。
