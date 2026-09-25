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
| Step 1 | `analyze` 分析 → `prepare` stage → **同一輪並行三軌**（1.3a 預覽＋1.3b Codex＋1.3c code-reviewer）→ 匯流 → `review-record` 記下兩軌結果 |
| Step 2 | `ship`（commit → push → 驗證）；沒有 `review-record` 紀錄會被拒 |

步驟多時可用 TaskCreate 追蹤；流程結束前確認清單沒有殘留未關項目。

## 核心原則（默許機制）

> Commit 觸發條件：**Codex 非 BLOCK ∧ code-reviewer 非 BLOCK ∧ 使用者未明確否決。**

1. 兩軌皆 PASS（或豁免）＋使用者未回覆 → **自動 commit**（默許；local）。push 另需使用者當次明確核可（如「commit 並推上去」）才帶 `--push`。預覽時必須明講此行為。
2. **任一軌 BLOCK → 永不自動 commit**，列必修項等使用者——即使使用者已先回 OK。
3. 使用者明確否決（「等等」「先別上」、改 message、調 staging）→ 照使用者意思，不 commit。
4. PASS 附清單＝「可 commit 但有建議」，預設放行；使用者要先修 → 改碼 → 重跑 `prepare` → 兩軌重送（diff 變了就重判豁免）。BLOCK 後重做同樣走完整 Step 1。禁止沿用先前確認過的 message 直接 commit（碼可能已變）。
5. **某一軌確定不可用**（額度用完不算，見本條下方）→ 單軌降級（該軌記 `skipped: <原因>`、匯流視為 PASS；`review-record` 該軌就填這串），預覽明講已降為單軌，並由主 agent 補做該軌該查的項目。**兩軌都不可用 → 不可自動 commit**，停下請使用者人工確認（`review-record` 收到兩軌都 `skipped` 會直接拒絕；使用者核可後改走 `--exempt`）。
   > 「確定不可用」有嚴格判準，不是「我等不下去」——B 軌見 `references/codex-troubleshooting.md`，**自行判定不可用就 commit ＝ 違規**。
   > **額度／用量上限不算不可用**（錯誤原文如 `You've hit your usage limit ... try again at 8:24 PM`）：這是暫時狀態，**不得記 `skipped`、不得單軌降級**——`review-record` 會機械擋下理由含 usage limit／rate limit／quota／credits／try again at／額度／用量上限／配額的 skipped。處置：
   > 1. 從錯誤原文取重置時間（`try again at <時間>`）；讀不到就停下問使用者，不要自己猜一個時間了事。
   > 2. **當輪就排好喚醒**，時間設在重置後約 5 分鐘：Claude Code 內用 CronCreate（`recurring: false`、釘死分／時／日／月，只活在本 session）；session 可能先關掉就改用 goal2 plugin 的 `delaylocal` 排到本機。只寫「稍後再審」不排喚醒＝空頭承諾。
   > 3. 預覽明講「Codex 額度用完，已排 HH:MM 重跑」，commit 維持不做（這一軌沒結論，不是 PASS）。
   > 4. 喚醒後依序：最小題確認額度恢復 → 確認 index 沒被別人改動（外來 staged 閘會擋）→ staged 沒變就沿用 prepare 的 diff hash 直接重送 B 軌；staged 變了就從 prepare 重來。仍是額度錯誤就依新的重置時間再排一次。
6. **兩軌對同一項判不同嚴重度（一軌 BLOCK、一軌 Minor／PASS）→ 主 agent 自己實跑驗證再匯流**，不可取中間值、不可選寬鬆那軌放行（實證：Codex 判 BLOCK／code-reviewer 判 Minor，實測 Codex 對；「需要更好的工具才能正確處理」≠「可以不正確」）。驗證結果貼進預覽，才決定走 1 或 2。

## Review 豁免規則

`Style`（純 CSS／`<style>` 區塊／template class 調整／i18n value／格式化）與 `Docs`（純 `.md`／註解文字／XML doc 內文）可**同時豁免兩軌**（不得只豁免一軌），敏感掃描仍必做，1.3a 預覽仍要出並標示「已豁免——未回覆將自動 commit + push」。豁免也要落紀錄：`flow.sh review-record <repo> --exempt "Style：<為什麼只動到樣式>"`，否則 ship 會拒絕。

判斷原則一句話：**diff 觸及「會被執行到的程式邏輯」一律不豁免**——`.vue` 的 `<script>`、`v-if`/`@click` 綁定、i18n 的 **key**（value 不算）、任何 `.cs`/`.js`/`.ts` 邏輯行，都算。使用者標 Style/Docs 但 diff 含邏輯行 → 告知「diff 含邏輯修改，仍送審」，禁止私下豁免。

## flow.sh（必用）

`.claude/skills/git-commit/flow.sh` 包掉所有純 git 操作，**不要手動組 git 指令**：

| 指令 | 動作 |
|------|------|
| `flow.sh analyze <repo>` | 狀態分類＋local-overrides 過濾＋敏感字掃描 |
| `flow.sh prepare <repo> <files...>` | 逐檔 `git add` → staged diff 輸出到 `.claude/.git-commit-tmp/staged-<repo>.diff`；重跑會作廢上一輪的審查紀錄。**index 已有不在清單內的 staged 項目就拒絕**（多半是別的 session stage 的；merge 進行中不檢查） |
| `flow.sh prepare <repo> --staged` | 不 `git add`，直接拿當下 index 送審（merge 收尾用：git 已把合併進來的檔案 stage 好）。index 空的拒絕 |
| `flow.sh review-record <repo> --codex "<回覆原文>" --reviewer "<回覆原文>"` | 匯流後把兩軌回覆記下並綁定當下 staged diff 的 hash。回覆第一行須為 `VERDICT: PASS`（BLOCK 不收）；不可用的那軌填 `skipped: <原因>`（兩軌都 skipped 不收；理由含額度字樣不收——額度用完要排重跑，見核心原則 5） |
| `flow.sh review-record <repo> --exempt "<理由>"` | 使用者明示豁免（Style/Docs、POC、plugin 發布、使用者要求跳過審查）。理由寫使用者的原話或豁免依據，會進稽核流水帳 `review-log.tsv` |
| `review-record ... --qa "<QA 狀態>"`（選填） | QA 表態，與審查結果一起寫進紀錄與流水帳。flow.sh 本身不強制；專案可用 hook 在行為類改動時要求必帶（例：供應商平台的 `guard-qa-before-commit.js` 要求 `已QA：…` 或 `分流例外：…`） |
| `flow.sh audit <repo> [<range>]` | 體檢既有 commit 的 message，唯讀。抓：空 message／缺 `Type:` 前綴／Type 不在允許清單／描述超長／痕跡命中／含多行 body（軟清單命中另標「待確認」）。exit `0`＝乾淨、`1`＝有問題、`2`＝range 無效 |
| `flow.sh ship <repo> <type> <description> [--push]` | HEREDOC commit → 驗證（內建禁 `--no-verify`/force push、過濾 AI 署名）。**預設只 local commit；帶 `--push` 才推遠端**——push 不可逆，需使用者當次明確核可 |
| `flow.sh amend <repo> --confirm-rewrite [--type <T> --desc <描述>]` | 改寫 HEAD。自動建備份分支、擋已 push 的 commit、沿用 ship 全部真閘，改寫後做 tree 級重現驗證。不帶 `--type`/`--desc` 則沿用既有 message；**只做本地改寫，不 push** |

`<repo>`＝`.` 或工作目錄下的 git 子目錄名（多 repo workspace 各自獨立 commit）。**不收絕對路徑**——要操作別處的 repo 先 `cd` 過去再用 `.`。`<type>`＝`Feat`/`Modify`/`Style`/`Refactor`/`Perf`/`Chore`/`Docs`/`Test`/`Fix`/`Hotfix`。

腳本不能代勞的：豁免判斷、1.3a 預覽、啟動兩個審查 subagent、匯流決策。但腳本會**檢查結果有沒有落地**：`ship`／有改到碼的 `amend` 找不到對應當下 staged diff 的 `review-record` 紀錄就拒絕，見下方「真閘 7」。

### hook：`hooks/block-bare-git-commit.sh`（他律）

PreToolUse hook，攔截 Bash 工具裡「不經 flow.sh 就建出 commit」的所有路徑：

| 攔 | 為什麼 |
|---|---|
| `git commit`（含 `--amend`） | porcelain 入口 |
| `git commit-tree` | plumbing：建 commit 物件 |
| `git update-ref` / `symbolic-ref`（寫入與刪除） / `branch -f`、`-M`、`-C` | 讓那顆 commit 生效，或把 HEAD 挪走藏掉 commit |
| `git merge --continue` | 收尾衝突 merge 時內部就是 `git commit`，不攔就是旁路（2026-09-24 補） |

後兩列是 2026-09-14 真實事故補上的：headless 引擎被 `git commit` 擋下後，改用 `write-tree` + `commit-tree` + `update-ref` 三件組完成了四個 worktree 的 merge commit，hook 靜默通過。三件組等價於 `git commit`，但字面上完全不像。

**刻意不攔**：`git merge` 本身（含無衝突時自動建的 merge commit；2026-09-24 使用者決定維持放行）、`git write-tree`（單獨用只建 tree、不動 ref，`git stash` 內部會用到）、`reset`／`rebase`／`filter-branch`／`cherry-pick`（屬 §歷史改寫 的使用者意圖層級，且日常常用，攔了頻繁誤擋）、`push`（超出本 hook 職責）。唯讀指令（`status`/`log`/`diff`/`add`）一律不攔。

放行條件**只有一條**：`GIT_COMMIT_FLOW=1`。這個變數由 `flow.sh` 執行時自己 export 給子程序，所以「真的經過 flow.sh」與「這個變數存在」是同一件事——**外部設不進來**（hook 是獨立 process，inline 前綴／`export`／`env` 全無效）。

**沒有「說明原因就能繞」的旁路**。

> **為什麼需要**：上面那句「不要手動組 git 指令」與 frontmatter 的「AI 禁止直接執行 git commit」都是**自律**，AI 會繞；繞過去就等於六道真閘一道都不觸發。skill 的「必須」是自律，只有 hook 是他律。
> hook **fail-open**：自身任何錯誤（空輸入、壞 JSON、無 python）一律放行並印警告，絕不把使用者鎖在無法 commit 的狀態。

### 真閘 7：審查紀錄（`ship`／`amend` 內建）

上面那支 hook 只保證「commit 是經 flow.sh 建的」，**不保證「經過三軌審查」**——`bash flow.sh ship ...` 這條指令裡沒有 `git commit` 字樣，hook 放行；flow.sh 內部的 commit 是子程序，hook 根本看不到。所以三軌原本完全靠自律。

`ship` 與有改到碼的 `amend` 在 commit 前會比對 `review-record` 留下的紀錄：紀錄不存在、或紀錄綁的 diff hash 與當下 staged 不同，一律 exit 1。紀錄在 commit 成功後即清，重跑 `prepare` 也會作廢——每一份 diff 都要重新記一次。**沒有旗標可以繞過**；所有「不審」的正當情境（Style/Docs 豁免、POC、plugin 發布、使用者要求跳過）都走 `review-record --exempt "<理由>"`，並留在 `.claude/.git-commit-tmp/review-log.tsv` 供事後稽核（該檔不隨 commit 清除）。

紀錄同時綁定 repo 身分（該 repo 的 git 目錄）：repo 路徑轉成檔名時 `grp/sub` 與 `grp__sub` 會撞名，沒有這一層就能借用別的 repo 的紀錄。

**補推捷徑（`ship ... --push` 且沒有 staged）只認 flow.sh 親手建的那顆**：ship 成功後會記下 commit sha，補推時 HEAD 必須就是那顆。只比 message 字串的舊寫法，可以 `reset --soft` 換掉內容、沿用同一句 message 重新 commit 後直接推。只改 message 的 amend 只有在原 HEAD 本來就是 ship 建的時候才承接這筆紀錄，不能替流程外建的 commit 洗白。副作用：舊版 flow.sh 建的未推 commit 沒有這筆紀錄，補推會被擋。

紀錄內容是呼叫者自陳的：這道閘擋的是「忘了審」，擋不住蓄意填假結果。假結果會在流水帳留下可查的一行，但不會被自動發現——**`--codex`／`--reviewer` 必須貼 agent 回覆原文，不得自己組一行 `VERDICT: PASS`**。

## Step 1

### 1.1–1.2 分析與 Stage

對每個有變更的 repo 跑 `analyze`，輸出已含敏感掃描（password/secret/token/硬編 JWT/console.log/TODO: remove 等 pattern）與 local-overrides 過濾。掃描命中 → 預覽列出請使用者確認是否刻意保留；清單外的可疑 unstaged（`appsettings.Localhost.json`、`BlobStorage/`、含測試 JWT 的檔）→ 預覽提醒。

**local-overrides.yml**（`.claude/local-overrides.yml`，記錄本機常駐覆寫檔——Mock 切換、本地連線、測試 JWT）：清單內檔案不告警、不 stage、不進預覽。使用者明示要 commit 清單內檔案 → 本次 override 走完整流程，commit 後問「本地預設值變了嗎？要不要移出清單？」。同一 tracked 檔連續多次未 stage → 主動建議入清單。

**Stage 紀律**：**禁止 `git add -A` / `git add .`**——會把 local-overrides 的本機 hack 整檔混進 staged。一律逐檔 `prepare`；覆寫清單內「混有真改動」的檔案（如 Program.cs 的 DI 註冊）用 `git diff` 切 hunk、`git apply --cached` 精準 stage，commit 前 grep `LocalDevToken|MockSap|MockBPM|mysecret` 確認 staged diff 0 命中。禁 `git update-index --skip-worktree`。

**多 session 共用同一個 repo 時**（index、工作區、`.claude/.git-commit-tmp/` 都是共用的）：`prepare` 逐檔 `git add` 前先 `git diff <檔案>` 看工作區有沒有**別人還沒 stage 的改動**混在同一檔——有就不能整檔 add，改用 `git apply --cached` 或 `git hash-object -w` + `git update-index --cacheinfo` 只 stage 自己的部分（腳本分不出一行改動是誰寫的，這一步只能靠人看）。`prepare` 逐檔模式遇到「index 已有不在清單內的 staged 項目」會直接拒絕並列出檔名（外來 staged 閘）——那些是自己的（切 hunk stage 的）就改用 `--staged`；不是自己的就先問使用者，確認後記下那些項目的 mode 與 blob、移出 index，commit 後用同一批 blob 原樣放回並逐項比對 hash。`--staged` 模式不做這道檢查，用之前自己看過 status。碰到 `.git/index.lock` 已存在不要刪，等它消失再重試（2026-09-24 實證：另一 session 送審期間 stage 了 5 個檔，並把歷史段寫進同一份 CHANGELOG，一句 `git add` 就把對方半成品掃進 staged）。

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

`subagent_type: codex:codex-rescue`（**必須是這個完整字串**）、`run_in_background: true`，與 1.3a/1.3c 同輪送出。diff 已在 `.claude/.git-commit-tmp/staged-<repo>.diff`。

Prompt 開頭**必須**寫兩件事，缺一必死：
1. 「執行任何 codex 指令前先 `cd` 到 `<repo>` 目錄」——subagent 預設 cwd 可能不是 git repo，codex 會拒絕啟動
2. 「`codex exec` 一律加 `< /dev/null`」——否則 CLI 會卡在等一個永遠不會來的 stdin

並要求失敗時回 `VERDICT: UNAVAILABLE` 附錯誤原文，不得靜默退出。

另三條呼叫層規定（2026-09-24／25 實證，違反時 codex 根本沒跑、不是審查結論，詳見 troubleshooting）：
3. 「開全新對話，禁止接續舊 thread」——**兩條路寫法不同，不可混用**：走 companion（`node <codex plugin>/scripts/codex-companion.mjs task`）才帶 `--fresh`，並禁止 `--resume-last`／`--resume`（本帳號不支援，exit 1）；直接用 `codex exec` 時**不加 `--fresh`**——exec 沒有這個旗標，會回 `error: unexpected argument '--fresh' found`（exit 2），完全沒跑。exec 本來每次就是新 session，接續要另下 `codex exec resume`，一樣禁用
4. 「審查內容以 stdin 傳入（`codex exec ... < 內容檔`），禁止拆成命令列參數」——內容裡的 `-m` 之類會被 companion 當成 `--model`，回 400 `The '<旗標字樣>' model is not supported`；審查內容本身有旗標範例時，短旗標改用文字描述。以內容檔當 stdin 時就**不再加** `< /dev/null`（兩者都是指定 stdin，只能擇一；內容檔有結尾，不會卡在等 stdin），第 2 條的 `< /dev/null` 指的是「不從 stdin 傳內容」的呼叫
5. 「判定這一軌有跑，看輸出裡有沒有 `VERDICT:` 行，不看 exit code」——`codex exec ... | tail` 這類管線的 exit code 是最後一個指令的：codex 報錯 exit 2，管線末端照樣回 0，外觀像跑完了（2026-09-25 實測）。要看 codex 本身的結果用 `${PIPESTATUS[0]}`；輸出沒有 `VERDICT:` 行就是**沒有可採用的結論**（可能沒跑、中途失敗或輸出被截斷，三者都不能當審查完成），要回 `VERDICT: UNAVAILABLE` 附原文，絕不可當成 PASS 或當成「沒意見」

**等待紀律**：逾 10 分鐘告知使用者一次（不必問、不停下），之後安靜續等，至多 1 小時。完整審查本來就要 7 分鐘以上，慢的是思考不是工具。

> 🔧 **B 軌出任何狀況，先讀 `references/codex-troubleshooting.md` 再動作。**
>
> 涵蓋：只收到 idle 沒有 VERDICT／`Agent type not found`／`Not inside a trusted directory`／
> 400 `model is not supported`／卡在 `Reading additional input from stdin`／
> **以及「什麼才算判定 codex 不可用的客觀證據」**（判定前必讀——自行判定不可用就 commit ＝ 違規）。
>
> 那份檔案裡每一條都有日期與實測數據，不要憑印象處置。

> ⚠️ **diff 一律內嵌，不要在 prompt 裡附檔案路徑**——內嵌比讓 agent 自己讀檔可靠，任何環境皆適用。
> 給了路徑它就會去讀，而讀檔是最容易出環境問題的一步。
>
> **若該環境的 codex 沙箱會擋外部 shell**（症狀：`rejected: blocked by policy`，錯誤原文含
> `powershell.exe` / `bash.exe`），讀檔會直接失敗，回 `UNAVAILABLE` 或「無法驗證」型 BLOCK——
> 外觀像 codex 掛了，實際只要改 prompt 就過，誤判代價是白跳一軌審查。
> 本機屬於這種環境（2026-09-11 首見、09-20 再踩三次，實測所有 sandbox 模式皆擋）。
>
> **大 diff 不是例外**：只內嵌需要判斷的部分（JSON 結構 diff、檔案清單、已驗證結果）即可。
> 他律＝本 plugin 自帶的 PreToolUse hook `hooks/guard-codex-diff-embed.js`（prompt 含路徑或讀檔指示即擋；隨 git-commit 一起安裝，見 `hooks/hooks.json`）。同批還有 `hooks/check-codex-cwd.js` 擋 prompt 沒指定 cd 目標或目標不是 git repo 的派工。

Prompt 範本（開頭的 cd 指示與 codex exec 用法照 145–147 兩件事實際寫出，不能只在散文段提過）：

```
執行任何 codex 指令前，先 cd 到 <repo 的絕對路徑>（`codex exec` 一律加 `< /dev/null`）。
呼叫 codex 一律開全新對話：走 companion 用 `task --fresh`（禁止 `--resume-last`／`--resume`）；直接用 `codex exec` 則**不加 `--fresh`**（exec 沒有這個旗標，加了 exit 2、完全沒跑），也不用 `codex exec resume`。以下審查內容寫成檔案後以 stdin 傳入（`codex exec ... < 內容檔`，此時不再另加 `< /dev/null`），禁止拆成命令列參數。
判定跑完與否看輸出有沒有 `VERDICT:` 行，不看 exit code（管線末端的 exit 0 蓋得掉 codex 的 exit 2）；沒有就回 `VERDICT: UNAVAILABLE`。
失敗時回 `VERDICT: UNAVAILABLE`，逐字貼錯誤原文（含 exit code 與 stderr），不要轉述。

【嚴格限制】不要執行任何指令、不要讀取任何檔案。
（本環境的 codex 沙箱會擋外部 shell，讀檔必敗。）以下資訊已完整提供，僅根據它判斷。

請審查以下 staged diff（已完整內嵌，**不附檔案路徑**）：

<diff 內容直接貼在此>

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

`subagent_type` **先用 `code-reviewer`**（專案自訂的審查者，帶該專案規範）；Agent 工具回 `Agent type 'code-reviewer' not found` 時，**同輪改用 `git-commit:code-reviewer`**（本 plugin 自帶的通用版）重發，不算失敗、不降級單軌。**名稱解析規則（實測）**：plugin 自帶的 agent 只能用帶前綴的 `git-commit:code-reviewer` 叫到，裸名 `code-reviewer` 只會解析到專案層／使用者層的同名 agent——**即使全環境只有 plugin 這一支，裸名也回 not found**。所以兩段式缺一不可：只寫裸名，沒有自訂審查者的專案就沒有 C 軌；只寫前綴，有自訂審查者的專案會被通用版蓋掉。`run_in_background: true`，同輪觸發。Prompt 範本（VERDICT 格式與 B 軌對齊，利匯流判讀）：

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
- 匯流判定可 commit 後，**先跑 `flow.sh review-record <repo> --codex "<Codex 回覆原文>" --reviewer "<code-reviewer 回覆原文>"`** 再 ship。回覆原文多行時用 `"$(cat <<'EOF' … EOF)"` 帶入。多 repo 各記各的。
- BLOCK 處理：列必修項 → 使用者決定修或強制 commit（需明示）→ 修的話改碼、重 `prepare`、兩軌重送，直到全非 BLOCK。無 revert、無歷史噪音。使用者明示強制 commit → `review-record --exempt "<使用者的原話>"`（BLOCK 的回覆原文不會被 `--codex`／`--reviewer` 收下）。

## Step 2：`flow.sh ship`

- **禁止 AI 署名**（`Co-Authored-By: Claude` 等）——公司禁止揭露 AI 參與；腳本已過濾，description 參數也不得夾帶。
- `ship` 不做 amend——要改寫 HEAD 走 `flow.sh amend`（需使用者明示才加 `--confirm-rewrite`）。禁 force push；push 到 `main`/`master` 前特別確認使用者意圖。
- 使用者要求跳過審查（緊急 hotfix）→ `review-record <repo> --exempt "<使用者的原話>"` 後再 ship，並告知破例。

**pre-commit hook 失敗，先分辨兩種情況：**

- **(a) hook 正常執行但檢查不過**（eslint/測試失敗）→ 依提示修正 → 重跑 `prepare` → 兩軌重審 → 再 `ship`。
- **(b) hook 本身故障**（`Exec format error`、segfault、CRLF/缺 shebang、無法 spawn）→ 這不是程式碼問題，修碼會卡死。處置：①手動補跑 hook 本該做的檢查（prettier/eslint/test）確認乾淨；②明告使用者是 hook 環境故障＋已補跑哪些檢查；③**經使用者同意**才可手動 `git commit --no-verify`（本 skill 唯一允許情境，脫離 flow.sh），message 加 `[skip-verify: hook 環境故障，已手動補跑 <檢查項>]`；④建議根治（修 shebang/LF 或 `core.autocrlf=input`），不根治每次都炸。

## Merge 收尾（flow.sh 沒有 merge 子命令，用 ship）

`git merge` 停在衝突或 `--no-commit` 時（MERGE_HEAD 存在），**不要下 `git commit` 或 `git merge --continue`**（hook 會擋），照一般流程走 flow.sh——`ship` 在 MERGE_HEAD 存在時建出的就是雙 parent 的 merge commit（2026-09-24 實測）：

1. 解衝突 → `flow.sh prepare <repo> <解完的檔案...>`（逐檔列，會 `git add` 標為已解）；或已全部 stage 好就 `flow.sh prepare <repo> --staged`
2. 照 Step 1 送審 → `review-record`
3. `flow.sh ship <repo> Chore "合併 <分支> 進 <目標分支>"`（無 `Merge` Type，merge 一律用 `Chore`）

prepare 發現還有未解衝突（`git diff --diff-filter=U` 有東西）會直接拒絕，並列出檔案。staged diff 是相對第一個 parent（目前分支），審查看到的是「合併進來的全部變更＋衝突解法」。
要放棄 merge：`git merge --abort` 不在攔截範圍，照 §歷史改寫 先問使用者。

## Commit Message 規範

格式：`{Type}: {簡短描述}`——Type 首字大寫、冒號後空格、中文描述 1 句。例：`Feat: 相關申請紀錄新增發起人欄位與 Excel 匯出`。

**單行，不寫 body。** `flow.sh ship <repo> <type> <description>` 只吃單行 description，`assert_no_signature` 會機制級擋掉多行。理由要留就留在 PR／issue，不進 git message。

**長度上限：顯示寬度 ≤72**——全形字（中文、全形標點）算 2、半形算 1。由 `flow.sh ship` 機械檢查，超標即 exit 1，無豁免旗標。

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

**判準一句話：寫成一般正常人會寫的樣子。**

正常人寫 commit message 是描述「改了什麼」，**不會寫「我用什麼方法確認它是對的」**。後者是作業過程，只有今天在場的人看得懂，而 git log 是給六個月後的人看的。

| ❌ 不是正常人會寫的 | ✅ 正常人會寫的 |
|---|---|
| `Fix: 經語法樹掃描確認 25 個 await 全數位於 try 保護中` | `Fix: DAP 推送的 await 全數移入 try 保護範圍` |
| `Fix: 實測七則官方回應，六則失敗已修正` | `Fix: DAP 回應信封改為型別無關，失敗不再擲例外` |
| `Fix: 補 P0 防護` | `Fix: handleConfirmFinalReply 失敗時保留 dialog` |
| `Chore: 將 .claude 納入 gitignore，該目錄為 Claude Code 的本機設定` | `Chore: 將 .claude 納入 gitignore` |

機制側由 `flow.sh ship` 的 `MESSAGE_TRACE_PATTERN` 擋三類（命中即 exit 1）：

1. **AI／工具身分**：`Claude`、`Anthropic`、`Codex`、`code-reviewer`、`subagent`、`紅藍對抗`
2. **作業過程句式**：`經…掃描/確認/比對`、`實測…通過/失敗`、`實跑…通過`、`掃描確認`、`驗證：`後接結論

> 抓的是**詞組不是裸詞**——單一名詞分不出業務語意與作業過程。「審查」是簽核業務、`agent` 是代理商，用裸詞會擋掉正常 commit（`新增審查流程狀態欄位`、`agent-based 架構調整` 都該放行）。作業過程的特徵在句式，不在名詞。
>
> **刻意不抓的**（試過、會誤擋，交由人在審查時判斷）：
>
> | 不抓 | 因為它在業務上是 |
> |---|---|
> | `P0`–`P3` | 缺陷單系統的欄位命名（`P1 缺陷`、`P2 問題`） |
> | `本輪`、`第 N 輪` | 招標、面試、報價按輪次進行 |
> | `複查` | 保險、稽核、品管的標準流程名詞 |
> | `紅隊` | 資安演練產品的業務命名 |
> | `審查`、`agent` | 簽核流程、代理商 |
>
> `Fix: 補 P0 防護` 真正的問題是描述太模糊——那該由人在審查時判斷，不是 regex 的事。這道閘只負責攔「一眼就知道是作業過程」的寫法。
>
> 即便如此，文字比對仍必然有誤判，所以這道閘留了出口：確認命中的是業務詞彙，用 `--allow-message-trace` 放行。**長度上限沒有出口**——長度是客觀事實，不會誤判。

> ⚠️ 黑名單只是兜底，**判準是上面那句話**。關鍵字清單永遠有漏網的寫法，寫之前先自問：**這句話，一個拿到 diff 但沒有今天對話的人，能不能自己驗證？**

## 歷史改寫（rebase / amend / reset）

改寫既有 commit（`rebase -i`／`--amend`／`reset`）同樣受本 skill 管轄——`git commit` 以外的改寫指令一樣會繞過全部真閘，禁令不因指令名稱不同而失效。

**amend 走 `flow.sh amend <repo> --confirm-rewrite`**，下面第 1、4、5 條它會自動做（建備份分支、機械驗證、擋已 push 的改寫），第 2、3 條仍是你的責任。`rebase -i`／`reset` 尚無子命令封裝，需人工按本節規則走。

規則：

1. **改寫前必建備份分支**，並把分支名回報給使用者：`git branch backup/pre-<動作>-$(date +%H%M%S)`。回報的分支名一律複製**指令實際輸出**，不要憑記憶寫——名字裡有時戳，記錯了使用者就查不到。
2. **只改 message、不改碼** → 免三軌審查，但**每顆的新 message 都要過 §Commit Message 規範**（含痕跡與寬度）。
3. **有改到碼** → 走完整三軌流程，等同新 commit（`flow.sh amend` 會檢查 `review-record` 紀錄，沒有就拒絕並清掉剛建的備份分支）。
4. **改寫後必須機械驗證**，兩種情況驗法不同（用錯會得到假結論）：
   - **只改 message（第 2 條）** → `git diff <備份分支> HEAD` 必須為空。不空代表改 message 的過程動到了碼。
   - **有改到碼（第 3 條）** → diff 必然不為空，上面那條驗不了，改驗「只動了該動的檔案」：
     `git diff --name-only <備份分支> HEAD` 的清單須等於本次 staged 的清單；清單外的檔案 blob hash 須逐一相同；
     決定性驗證是把備份分支的樹套上本次的 blob、`write-tree` 出來的 tree hash 須等於 HEAD 的 tree hash
     （tree hash 是整棵樹的 Merkle hash，相同即 byte 級一致）。
   `flow.sh amend` 會依有無 staged 內容自動選對驗法並印結果，走它就不必手動驗。
5. **已 push 的 branch 禁止改寫**，除非使用者明示且確認無人共用。
6. 改寫完 `git log --format='%h %s' <range>` 逐顆看過再回報，不要只看最上面那顆。

## 交付路徑不只有 push

`format-patch` / `bundle` / `archive` 產出的檔案**內含完整 commit message 原文**，會直接送到客戶或上游手上——比 push 更難收回。

先跑 `flow.sh audit <repo>` 體檢一次 message（空 message、缺 Type、超長、痕跡、多行 body），再對**產出物本身**掃一次，而不是只掃 repo：

```bash
grep -n -i -E 'Claude|Anthropic|Codex|subagent|實測|掃描確認|本輪' <產出的 patch/bundle>
```

> 這是「用目標軟體驗、不要用自己的 parser 驗」的同型教訓：驗 repo 不等於驗交付物。

## 多議題拆 Commit（不要問）

Dirty 檔案涵蓋多個不相關議題 → **直接拆多個 commit，自己決定怎麼拆與 message 用詞**（使用者明示過偏好拆、不要問）。一個議題＝一個 commit；同議題跨多檔放同 commit；同檔跨多議題可合併、message 概括。逐個走完整流程（`analyze`→`prepare`→三軌→`review-record`→`ship`），完成一個再 `analyze` 下一個。可以問的例外：檔案歸屬判不明、跨 repo 邊界（內外站誰先誰後）、涉破壞性操作。

變更紀錄見 plugin 根目錄 `../../CHANGELOG.md`。
