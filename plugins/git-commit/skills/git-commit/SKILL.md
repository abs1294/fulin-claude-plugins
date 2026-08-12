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

**Codex 不可用時的降級**：先排除命名坑；確認叫不到 → 單軌降級（B 軌記 `skipped: codex-unavailable`、匯流視為 PASS），預覽明講「本環境不可用，已降為單軌」；**兩軌都不可用 → 不可自動 commit**，停下請使用者人工確認。**審查軌逾時**（數分鐘未回）→ 不無限等也不當 PASS，告知使用者問「續等還是以現有結果決策」。

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
- 2026-07-31 713 行壓縮至本版（Claude 5 世代 context engineering 調整，經使用者核准）：砍 9-task 編排時序細則（追蹤紀律歸 memory `feedback_task_tracking_discipline`）、三處重複豁免說明合一、20 列匯流矩陣壓成四條核心原則、排版細則壓行。三軌架構、默許機制、豁免判準、flow.sh 介面、事故收據條款（git add -A／codex 命名坑／hook 故障處置／AI 署名禁令）全數保留。
