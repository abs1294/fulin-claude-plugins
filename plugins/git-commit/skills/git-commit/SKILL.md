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
5. **某一軌確定不可用** → 單軌降級（該軌記 `skipped: <原因>`、匯流視為 PASS），預覽明講已降為單軌，並由主 agent 補做該軌該查的項目。**兩軌都不可用 → 不可自動 commit**，停下請使用者人工確認。
   > 「確定不可用」有嚴格判準，不是「我等不下去」——B 軌見 `references/codex-troubleshooting.md`，**自行判定不可用就 commit ＝ 違規**。

## Review 豁免規則

`Style`（純 CSS／`<style>` 區塊／template class 調整／i18n value／格式化）與 `Docs`（純 `.md`／註解文字／XML doc 內文）可**同時豁免兩軌**（不得只豁免一軌），敏感掃描仍必做，1.3a 預覽仍要出並標示「已豁免——未回覆將自動 commit + push」。

判斷原則一句話：**diff 觸及「會被執行到的程式邏輯」一律不豁免**——`.vue` 的 `<script>`、`v-if`/`@click` 綁定、i18n 的 **key**（value 不算）、任何 `.cs`/`.js`/`.ts` 邏輯行，都算。使用者標 Style/Docs 但 diff 含邏輯行 → 告知「diff 含邏輯修改，仍送審」，禁止私下豁免。

## flow.sh（必用）

`.claude/skills/git-commit/flow.sh` 包掉所有純 git 操作，**不要手動組 git 指令**：

| 指令 | 動作 |
|------|------|
| `flow.sh analyze <repo>` | 狀態分類＋local-overrides 過濾＋敏感字掃描 |
| `flow.sh prepare <repo> <files...>` | 逐檔 `git add` → staged diff 輸出到 `.claude/.git-commit-tmp/staged-<repo>.diff` |
| `flow.sh audit <repo> [<range>]` | 體檢既有 commit 的 message，唯讀。抓：空 message／缺 `Type:` 前綴／Type 不在允許清單／描述超長／痕跡命中／含多行 body（軟清單命中另標「待確認」）。exit `0`＝乾淨、`1`＝有問題、`2`＝range 無效 |
| `flow.sh ship <repo> <type> <description> [--push]` | HEREDOC commit → 驗證（內建禁 `--amend`/`--no-verify`/force push、過濾 AI 署名）。**預設只 local commit；帶 `--push` 才推遠端**——push 不可逆，需使用者當次明確核可 |

`<repo>`＝`.` 或工作目錄下的 git 子目錄名（多 repo workspace 各自獨立 commit）。`<type>`＝`Feat`/`Modify`/`Style`/`Refactor`/`Perf`/`Chore`/`Docs`/`Test`/`Fix`/`Hotfix`。

腳本不能代勞的：豁免判斷、1.3a 預覽、啟動兩個審查 subagent、匯流決策。

### hook：`hooks/block-bare-git-commit.sh`（他律）

PreToolUse hook，攔截 Bash 工具裡的裸 `git commit`（`git status`/`log`/`add`/`rebase` 不攔）。放行條件：`GIT_COMMIT_FLOW=1`（`flow.sh` 自己 export）或指令本身就在跑 `flow.sh`。

> **為什麼需要**：上面那句「不要手動組 git 指令」與 frontmatter 的「AI 禁止直接執行 git commit」都是**自律**，AI 會繞；繞過去就等於六道真閘一道都不觸發。skill 的「必須」是自律，只有 hook 是他律。
> hook **fail-open**：自身任何錯誤（空輸入、壞 JSON、無 python）一律放行並印警告，絕不把使用者鎖在無法 commit 的狀態。

## Step 1

### 1.1–1.2 分析與 Stage

對每個有變更的 repo 跑 `analyze`，輸出已含敏感掃描（password/secret/token/硬編 JWT/console.log/TODO: remove 等 pattern）與 local-overrides 過濾。掃描命中 → 預覽列出請使用者確認是否刻意保留；清單外的可疑 unstaged（`appsettings.Localhost.json`、`BlobStorage/`、含測試 JWT 的檔）→ 預覽提醒。

**local-overrides.yml**（`.claude/local-overrides.yml`，記錄本機常駐覆寫檔——Mock 切換、本地連線、測試 JWT）：清單內檔案不告警、不 stage、不進預覽。使用者明示要 commit 清單內檔案 → 本次 override 走完整流程，commit 後問「本地預設值變了嗎？要不要移出清單？」。同一 tracked 檔連續多次未 stage → 主動建議入清單。

**Stage 紀律**：**禁止 `git add -A` / `git add .`**——會把 local-overrides 的本機 hack 整檔混進 staged。一律逐檔 `prepare`；覆寫清單內「混有真改動」的檔案（如 Program.cs 的 DI 註冊）用 `git diff` 切 hunk、`git apply --cached` 精準 stage，commit 前 grep `LocalDevToken|MockSap|MockBPM|mysecret` 確認 staged diff 0 命中。禁 `git update-index --skip-worktree`。

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

**等待紀律**：逾 10 分鐘告知使用者一次（不必問、不停下），之後安靜續等，至多 1 小時。完整審查本來就要 7 分鐘以上，慢的是思考不是工具。

> 🔧 **B 軌出任何狀況，先讀 `references/codex-troubleshooting.md` 再動作。**
>
> 涵蓋：只收到 idle 沒有 VERDICT／`Agent type not found`／`Not inside a trusted directory`／
> 400 `model is not supported`／卡在 `Reading additional input from stdin`／
> **以及「什麼才算判定 codex 不可用的客觀證據」**（判定前必讀——自行判定不可用就 commit ＝ 違規）。
>
> 那份檔案裡每一條都有日期與實測數據，不要憑印象處置。

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

規則：

1. **改寫前必建備份分支**，並把分支名回報給使用者：`git branch backup/pre-<動作>-$(date +%H%M%S)`。回報的分支名一律複製**指令實際輸出**，不要憑記憶寫——名字裡有時戳，記錯了使用者就查不到。
2. **只改 message、不改碼** → 免三軌審查，但**每顆的新 message 都要過 §Commit Message 規範**（含痕跡與寬度）。
3. **有改到碼** → 走完整三軌流程，等同新 commit。
4. **改寫後必須機械驗證**：`git diff <備份分支> HEAD` 必須為空。不空代表改 message 的過程動到了碼。這一行指令就能驗，別跳過。
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

Dirty 檔案涵蓋多個不相關議題 → **直接拆多個 commit，自己決定怎麼拆與 message 用詞**（使用者明示過偏好拆、不要問）。一個議題＝一個 commit；同議題跨多檔放同 commit；同檔跨多議題可合併、message 概括。逐個走完整流程（`analyze`→`prepare`→三軌→`ship`），完成一個再 `analyze` 下一個。可以問的例外：檔案歸屬判不明、跨 repo 邊界（內外站誰先誰後）、涉破壞性操作。

## Changelog
- 2026-09-10 補 hook（他律）＋真閘 6（message 痕跡與長度）＋§歷史改寫＋§交付路徑，並把 body 政策與長度單位明文寫死。**起因**：另一 session 在 KMS-dev 繞過本 skill 直接跑 `rebase -i`／`--amend` 改寫 8 顆 commit，把「經語法樹掃描確認」「實測七則官方回應」「Claude Code 的本機設定」寫進 git 歷史，**五道既有真閘一道都沒觸發**——因為它根本沒經過 flow.sh。三個結構缺口各自補上：①規範全是自律，AI 會繞 → PreToolUse hook 攔裸 `git commit`（fail-open，14 項紅綠測）；②`AI_TRACE_PATTERN` 只掃 staged diff、從不掃 message，`SIGNATURE_PATTERN` 只認 5 個署名詞且沒有單獨的 `Claude` → 新增 `MESSAGE_TRACE_PATTERN`（16 項紅綠測，測資用 KMS 真實 message）；③「≤50 字」沒定義單位、「能不能有 body」規範空白 → 該 session 先寫長 body（沒禁）、事後又自認「skill 要求不含 body」全砍（也沒要求），**兩次都在填空白且方向相反**，現已寫死「單行、寬度 ≤72」。**開發中自撞一次**：`display_width()` 初版用 awk，`bash -n` 過但實跑把「中文五個字元」算成 18（byte 數）——多數 awk 非 locale-aware、`substr` 按 byte 切，改用 Python `east_asian_width` 才對。語法檢查過 ≠ 能跑。
- 2026-09-05 補第三輪最後一個觀察項：探測失敗時原始輸出被刪、只留 `✗`，事後無法回溯真因。已改為把失敗原文存到 `$TMPDIR/codex-model-probe-fail/<slug>.log` 並在輸出標明路徑（每次執行先清上一輪，避免陳舊資訊誤導）。**這正是本輪吃過的虧**：腳本一度報「最強可用是 gpt-5.4-mini」卻看不到 astra 失敗的原文，只能手動重跑才發現真因是 slug 尾端帶 `\r`。實測：插一個 priority 0 的假 model 觸發失敗分支，確認原文留存 940 bytes 且具診斷價值、腳本仍正確選出 gpt-6-astra。
- 2026-09-05 同兩支腳本再送 Codex 覆審兩輪（第二輪 BLOCK、第三輪 PASS）：第二輪抓到**我上一輪加 trap 時引進的新缺陷**——`trap cleanup INT TERM` 只刪暫存檔卻不結束腳本，控制流帶著「檔案已消失」的狀態跑到 `grep`，把探測中的模型誤判為不可用、進而把次強模型寫回 config。已獨立重現（`grep: ... No such file` 接 `✗`）後修正：訊號處理與正常結束分離，訊號版清完立刻退出；兩處 grep 補 `2>/dev/null`。第三輪 PASS 並提兩個觀察項，一併修掉：INT/TERM 共用 exit 130 不精確，改為依慣例回 128+訊號值（INT=130／TERM=143／HUP=129）並補攔 SIGHUP。**教訓：修一個小瑕疵（暫存檔殘留）可以引進更嚴重的缺陷（寫錯設定），修完必須重送審查而非只跑正常路徑。**
- 2026-09-05 `codex-model-sync.sh` 經 Codex 審查回 BLOCK 後修三項（使用者要求拿自己寫的腳本送審）：①**寫回 config 後未檢查 python 回傳碼、也未回讀驗證**——實測 python 拋 FileNotFoundError 時腳本仍印「已更新」並 exit 0，正是本檔一再防的「跑得動但結論錯誤」，已補 rc 檢查＋回讀比對（紅測：修前 exit 0 謊報成功、修後 exit 1 並明講未變更）；②缺 `trap`，暫存檔在 Ctrl+C／kill 時殘留（check.sh 本來就有，兩支不對稱）；③備份 `config.toml.bak.*` 無限累積，改為只留最近 5 份。Codex 另指 `current` 變數未防 `\r`，實測 `tr -d [:space:]` 已涵蓋 `\r`，**該項不成立故未改**——審查意見仍須逐條驗證再採納。
- 2026-09-05 降級段落前置「先排除 model 下架」（使用者當次核准）：`gpt-5.4` 8/31 退役而 config 未更新，導致兩個 codex agent 各撞一次 400、並補做完整單軌降級——實際只需改一行設定。新增 `.claude/skills/git-commit/codex-model-sync.sh` （讀帳號專屬 models_cache.json 取 priority 最小者、實測後寫回 config，三條路徑均已實跑驗證）。官方文件（learn.chatgpt.com/docs/models）明說未指定 model 時用「recommended」且依帳戶層級而定，**不保證最強**，故不採「不設 model 讓 CLI 自選」。判活紀律與等待門檻一字未改。
- 2026-08-31 新增真閘 5「AI 痕跡」（使用者當次指示，`--allow-ai-trace` 可豁免）：掃 staged diff **新增行**是否引用外部文件出處（`CLAUDE.md`／skill／設計文件／`docs/*.md`／裸 `§` 章節號），`.md` 除外；prepare 顯示、ship 攔截。起因是一次清出 53 處同型痕跡散在 4 個 repo，根因為「註解撰寫規範」曾有「✅ 指向規範文件」的鼓勵條文（已刪並改立 N9）。**判準含裸 `§` 是必要的**——實證刪掉「CLAUDE.md §8.2」後，同段落下一行的 `§8.4` 不含任何關鍵字，關鍵字與「見/依+章節」兩種判準都抓不到，第三種純掃 `§` 才撈出 13 處。已實跑紅綠測（含 `.md` 排除、裸 `§` 命中、刪除行不誤判、`--allow-ai-trace` 放行）。
- 2026-08-31 B 軌判活補 CPU 判準＋stdin 根治條款（使用者當次指示）：原規則只看「StartTime 晚於送審」，擋得住殭屍污染卻擋不住「啟動了但沒在算」——實證 PID 存活 16.5 分鐘 CPU 僅 0.03 秒（比同機殭屍的 68 秒還低）卻被判成正在算，白等 16 分鐘。修正為 StartTime 與 CPU 累積**兩個條件並用**。根因是 `codex exec` 未重導 stdin 導致 CLI 卡在 `Reading additional input from stdin...`，已列為必死坑，一律帶 `< /dev/null`。
- 2026-08-28 10 分鐘通知點加入 codex 活性同步檢查（使用者當次指示）：活著→續等；死了→重送同一審查（重起一次、計時重算），重起仍死才降級。判活必看程序 StartTime 是否晚於送審時刻——同日兩個實證：殭屍 PID（8/27 殘留）污染「正在算」判讀白等；codex exec 跑完即退，「查無程序」時 agent 其實已寫完 VERDICT，先要狀態再判死。
- 2026-08-26 B 軌補「codex 拒絕在非 git 目錄啟動」的必死坑（使用者當次指示記錄）：subagent 預設 cwd 是 workspace 根、而根目錄不是 git repo，codex 會回 `Not inside a trusted directory` 即退出，現象與「算很久」完全相同（只送 idle、無 VERDICT），實證白等逾 1 小時。修正：prompt 開頭強制指定 `cd` 到 repo，並把「先跑最小題」提到「耐心等」之前。
- 2026-08-25 B 軌等待門檻 5 分鐘 → 10 分鐘，改為「告知一次後續等、至多 1 小時」（使用者當次指示）。起因：原門檻 5 分鐘與同段實測「完整審查需 7 分鐘以上」自相矛盾，照規則走每次都必然打擾使用者一次。新規則下 10 分鐘只告知不停手，1 小時才是真正的停損點。
- 2026-08-23 B 軌等待紀律重寫（使用者當次指示「Codex 要等啊，你是不是太急」）：明訂 idle≠死亡、判不可用須有客觀證據（程序數 0＋最小題失敗，或 agent 回 UNAVAILABLE）、逾 5 分鐘是問使用者而非自行降級；補審查任務的耗時分級實測（雜務數秒 vs 完整審查 7 分鐘以上）與 `--json` 逐步加壓的診斷法。起因：同一輪三次把自設 timeout 當成 Codex 失效，並據錯誤診斷（「讀檔就卡」）自行降級 commit。事後背景任務補證：同一審查任務 subagent 數分鐘回 PASS、前景 `codex exec` 給 20 分鐘仍 timeout 零輸出，兩路徑結果相反，故前景失敗不可作為 subagent 不可用的依據。
- 2026-08-16 審查軌逾時門檻明定為 5 分鐘（使用者當次指示：「我願意等他到 5 分鐘」）：5 分鐘內續等不打擾，逾時才問；並補「工具層逾時 vs Codex 算得慢」的分辨與重送處置。
- 2026-07-31 713 行壓縮至本版（Claude 5 世代 context engineering 調整，經使用者核准）：砍 9-task 編排時序細則（追蹤紀律歸 memory `feedback_task_tracking_discipline`）、三處重複豁免說明合一、20 列匯流矩陣壓成四條核心原則、排版細則壓行。三軌架構、默許機制、豁免判準、flow.sh 介面、事故收據條款（git add -A／codex 命名坑／hook 故障處置／AI 署名禁令）全數保留。
