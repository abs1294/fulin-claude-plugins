# git-commit

**讓 code review 在 commit「之前」就跑完，git 歷史不再留下「Fix → Revert → 再 Fix」的噪音——確認 commit message 的同時，兩軌審查同步進行，過了才 commit。**

並行審查模式的 Git 提交流程：**Stage → 三軌並行（使用者確認 message + Codex 審查 + code-reviewer 審查）→ 記錄審查結果 → Commit（本機）→ 使用者核可後才 Push**。

## 它解決什麼

傳統流程是「先 commit、再審查、發現問題又 revert」，git 歷史會留下 `Fix → Revert → 新 Fix` 的噪音。本 plugin 把兩軌 code review **前移到 commit 之前**，對著「尚未 commit 的 staged diff」審查：

- BLOCK 只需改程式碼 + 重新 stage，**無需 `git revert` / `git reset`**，歷史永遠乾淨。
- 使用者審閱 commit message 預覽的同時，兩軌審查同步在跑，**減少等待**。
- **AI 禁止直接執行 `git commit` / `git push` / `git add`**，一律走本 skill 完整流程——而且不只是規定：隨 plugin 安裝的 PreToolUse hook 會直接攔下繞過 `flow.sh` 建 commit 的指令（見下方「機制閘」）。

## 安裝

```
/plugin install git-commit@fulin-plugins
```

安裝後 **reload / 重啟 session** 才會生效。觸發詞：`commit`、`提交`、`上版`、`推上去`、`git push`、`commit and push` 等。

## 前置依賴

- **git CLI** — 整套流程的本體。
- **bash**（Windows 用 Git Bash，裝 Git for Windows 即附帶）— `flow.sh` 是 bash 腳本，主流程靠它落地。
- **（選用）codex plugin**（`codex@openai-codex`）— 僅 Codex 審查軌需要；未裝（或 Codex 確定不可用）時降為單軌（**額度／用量上限不算不可用**：要排額度恢復後重跑，`review-record` 會拒收理由含額度字樣的 skipped）：B 軌在 `review-record` 填 `skipped: <原因>`，只剩 C 軌（`code-reviewer` subagent）把關；兩軌都不可用則不會自動 commit，要使用者人工確認。

## 核心流程

| 階段 | 動作 |
|------|------|
| **Step 1** | 分析 + Stage → **三軌並行**（A 使用者確認 message ∥ B Codex 審查 ∥ C code-reviewer 審查）→ 匯流決策 → `review-record` 記下兩軌結果 |
| **Step 2** | `ship`：本機 Commit → 驗證；使用者當次明確核可才加 `--push` 推遠端 |

三軌（A/B/C）**必須在同一輪訊息內啟動**，才算真並行。匯流條件：

> **Codex 非 BLOCK ∧ code-reviewer 非 BLOCK ＋ 使用者未明確否決 → 才能 commit。**
>
> 匯流後要先用 `flow.sh review-record` 把兩軌回覆原文（或使用者的豁免理由）綁定到當下 staged diff 的 hash；`ship` 找不到對應紀錄、或 staged 內容在記錄後又變了，一律拒絕。

所有純 git / 檔案操作都包在 `flow.sh` 的子命令裡（完整用法：`bash skills/git-commit/flow.sh --help`）：

| 指令 | 動作 | 對應步驟 |
|------|------|---------|
| `flow.sh analyze <repo>` | git 狀態分類 + local-overrides 過濾 + 敏感字掃描 | 1.2 分析 |
| `flow.sh prepare <repo> <files...>` | `git add`（只加列出的檔，不 `git add .`）→ 產出 staged diff 供兩軌讀取。index 已有不在清單內的 staged 項目（多半是別的 session stage 的）就拒絕；merge 進行中不檢查（合併進來的檔本來就屬於這顆 commit） | 1.2 Stage |
| `flow.sh prepare <repo> --staged` | 不 `git add`，直接拿當下 index 送審（merge 收尾、自己切 hunk stage 時用） | 1.2 Stage／Merge 收尾 |
| `flow.sh review-record <repo> --codex "<回覆>" --reviewer "<回覆>"` | 把兩軌回覆原文綁定到當下 staged diff；回覆第一行須為 `VERDICT: PASS`，不可用的那軌填 `skipped: <原因>`（兩軌都 skipped 不收；理由含 usage limit／quota／額度等字樣也不收——額度用完要排重跑）。豁免改用 `--exempt "<理由>"`，可加 `--qa "<QA 狀態>"` | 1.4 匯流後 |
| `flow.sh ship <repo> <type> "<desc>" [--push]` | 真閘（AI 署名／單行／message 痕跡與寬度／diff hash／敏感字／建置產物／AI 痕跡）→ HEREDOC `git commit` → 驗證。**預設只本機 commit，`--push` 才推遠端**（需使用者當次核可）；沒有 `review-record` 紀錄就拒絕 | Step 2 |
| `flow.sh amend <repo> --confirm-rewrite [--type <T> --desc <描述>]` | 改寫 HEAD：自動建備份分支、擋已 push 的 commit、沿用 ship 全部真閘、改寫後做 tree 級驗證；只本機改寫不 push | 歷史改寫 |
| `flow.sh audit <repo> [<range>]` | 唯讀體檢既有 commit 的 message（空 message／缺 Type／超長／痕跡／多行 body）；交付 patch 或推上游前跑一次 | 交付前 |

`<repo>` 是工作目錄底下的 git 子目錄名，或 `.`（工作目錄本身就是 repo）；不收絕對路徑。

**Merge 收尾**：沒有 merge 子命令。`git merge` 停在衝突或 `--no-commit` 時，解完衝突照一般流程走 `prepare`（或 `prepare --staged`）→ 三軌 → `review-record` → `ship <repo> Chore "合併 <分支>"`，MERGE_HEAD 存在時 ship 建出的就是雙 parent 的 merge commit。不要下 `git commit` 或 `git merge --continue`（hook 會擋）。

**機制閘（隨 plugin 安裝的 hook）**：

| hook | 攔什麼 |
|------|------|
| `hooks/block-bare-git-commit.sh`（PreToolUse：Bash／PowerShell） | 不經 `flow.sh` 建 commit 或改 ref：`git commit`（含 `--amend`）、`commit-tree`、`update-ref`、`symbolic-ref`、`branch -f/-M/-C`、`git merge --continue`。放行條件只有 `flow.sh` 自己匯出的環境變數，外部設不進來；hook 自身出錯一律放行（fail-open） |
| `hooks/guard-codex-diff-embed.js`（PreToolUse：Agent／Task） | 派給 Codex 的審查 prompt 附檔案路徑或讀檔指示（部分環境的 codex 沙箱讀不到檔，diff 必須內嵌） |
| `hooks/check-codex-cwd.js`（PreToolUse：Agent／Task） | 派給 Codex 的 prompt 沒指定 cd 目標、或目標不是 git repo（codex 拒絕在非 git 目錄啟動） |

## 重點規則

**三軌默許機制**（B + C 兩軌完成即可推進，不必等 A 軌）：

| 情境 | 行為 |
|------|------|
| 兩軌 PASS ＋ 使用者尚未回覆 | → **自動**本機 commit（默許，輸出時註明）；push 另需使用者當次明確核可 |
| 兩軌 PASS ＋ 使用者明確確認 ✅ | → 本機 commit；使用者說要推才 push |
| 兩軌 PASS ＋ 使用者明確否決 🖊（「等等」/「先別上」/改 message） | → 照使用者意思，不 commit |
| 兩軌**豁免**（Style/Docs）＋ 尚未回覆 | → **自動**本機 commit（豁免比照 PASS 默許；仍要跑 `review-record --exempt`） |
| **任一軌 BLOCK** ＋ 任何狀態 | → **絕不自動 commit**，列出必修項等使用者 |

- **AI 禁直接 git**：不手動組 `git status` / `git add` / `git commit`，一律走 `flow.sh`。
- **BLOCK 不 commit**：BLOCK 永遠不默許，即使使用者已先回「OK」也不行；修完直接在 working tree 改 → 重跑 `prepare` → 兩軌重審，無 revert、無 reset。
- **commit message 格式**：`{Type}: {中文描述}`（Type 首字大寫，允許 `Feat`／`Modify`／`Style`／`Refactor`／`Perf`／`Chore`／`Docs`／`Test`／`Fix`／`Hotfix`）；**單行、不寫 body**，**顯示寬度 ≤72**（全形字算 2），兩者都由 `ship` 機械擋下、無豁免旗標；只寫「改了什麼」，禁止把 `P0`/`紅藍對抗`/`Codex`/`PoC` 等對話脈絡寫進 message。
- **多議題自動拆 commit**：一輪 dirty 涵蓋多個不相關議題時直接拆，不問使用者偏好。
- **禁用**：`--no-verify`、force push（`flow.sh` 不提供這些旗標）；唯一 `--no-verify` 例外是 pre-commit hook 環境本身故障（須手動補跑檢查 + 留 `[skip-verify]` 標記 + 經使用者同意）。改寫 HEAD 不直接下 `git commit --amend`（hook 會擋），走 `flow.sh amend --confirm-rewrite`（需使用者明示）；已 push 的 commit 禁止改寫。
- **禁 AI 署名**：commit message 不得含 `Co-Authored-By: Claude` 等任何 AI 參與標記。

### 豁免規則

為避免瑣碎變更浪費審查資源，**`Style`（純 CSS／`<style>`／template class／i18n value／格式化）與 `Docs`（純 `.md`／註解）可同時豁免 B、C 兩軌**（不得只豁免一軌；仍須 1.3a 預覽 + 敏感字掃描）。豁免也要落紀錄：`flow.sh review-record <repo> --exempt "<為什麼只動到樣式或文件>"`，否則 `ship` 會拒絕。

**反豁免（治本把關）**：只要 diff 觸及「會被執行到的程式邏輯」一律不豁免——例如 `Style` 卻動了 `.vue` 的 `<script>` / `v-if` / `@click`、或改了 i18n 的 **key**（非 value）。AI 偵測到就強制送兩軌，並告知使用者。

## 回歸測試

改 `flow.sh` 或 `hooks/` 之後跑這兩套，全綠才算數（語法檢查過不算）。兩套都在暫時目錄建臨時 git repo 實跑，不動你的 repo。

| 測試檔 | 涵蓋 | 用法 |
|------|------|------|
| `skills/git-commit/tests/test_review_gate.sh` | 審查紀錄閘（真閘 7）：無紀錄／紀錄後 staged 變動／BLOCK 不收／豁免／補推捷徑只認 ship 建的 commit／QA 表態 | `bash skills/git-commit/tests/test_review_gate.sh <flow.sh 的路徑>` |
| `skills/git-commit/tests/test_merge_support.sh` | 裸 commit 偵測器語料（含 `git merge --continue` 的攔／放行）、git 行為依據、hook 端到端、merge 收尾（`prepare --staged`、未解衝突檢查）、外來 staged 閘（含 rename 併筆、repo 設定藏起 submodule 更新、無 HEAD 的 repo）、絕對路徑錯誤訊息、`--help` | `bash skills/git-commit/tests/test_merge_support.sh <flow.sh 的路徑>` |

參數是 `flow.sh` 的路徑；`test_merge_support.sh` 另外從 `flow.sh` 的位置往上找 `hooks/`，所以要測改過的版本時，把整個 plugin 目錄（`hooks/` 與 `skills/`）一起複製。

## 適用情境

- 想把 review 前移、保持 git 歷史乾淨（不留 Fix→Revert 噪音）。
- 單一 git repo，或工作目錄底下多個 git 子目錄的 multi-repo workspace（各自獨立 commit）。
- 需要 Codex 與 code-reviewer 雙軌把關、又不想每次純樣式/文件變更都被審查拖慢。

> 前置：`flow.sh` 走 bash，需可執行 shell；Codex 軌透過 `codex:codex-rescue` subagent，C 軌透過 `code-reviewer` subagent——本 plugin 自帶通用版 `agents/code-reviewer.md`（設計品質 11 條＋通用工程守則＋資安基線，Critical 只留給資安洞／必錯邏輯／破壞架構邊界）；C 軌先叫 `code-reviewer`（專案自訂），not found 再叫 `git-commit:code-reviewer`（本 plugin 通用版）——plugin 的 agent 只能用帶前綴的名字叫到，裸名只解析到專案層。
