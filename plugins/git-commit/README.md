# git-commit

**讓 code review 在 commit「之前」就跑完，git 歷史不再留下「Fix → Revert → 再 Fix」的噪音——確認 commit message 的同時，兩軌審查同步進行，過了才 commit。**

並行審查模式的 Git 提交流程：**Stage → 三軌並行（使用者確認 message + Codex 審查 + code-reviewer 審查）→ Commit → Push**。

## 它解決什麼

傳統流程是「先 commit、再審查、發現問題又 revert」，git 歷史會留下 `Fix → Revert → 新 Fix` 的噪音。本 plugin 把兩軌 code review **前移到 commit 之前**，對著「尚未 commit 的 staged diff」審查：

- BLOCK 只需改程式碼 + 重新 stage，**無需 `git revert` / `git reset`**，歷史永遠乾淨。
- 使用者審閱 commit message 預覽的同時，兩軌審查同步在跑，**減少等待**。
- **AI 禁止直接執行 `git commit` / `git push` / `git add`**，一律走本 skill 完整流程。

## 安裝

```
/plugin install git-commit@fulin-plugins
```

安裝後 **reload / 重啟 session** 才會生效。觸發詞：`commit`、`提交`、`上版`、`推上去`、`git push`、`commit and push` 等。

## 前置依賴

- **git CLI** — 整套流程的本體。
- **bash**（Windows 用 Git Bash，裝 Git for Windows 即附帶）— `flow.sh` 是 bash 腳本，主流程靠它落地。
- **（選用）codex plugin**（`codex@openai-codex`）— 僅 Codex 審查軌需要；未裝時流程會自動降級走 C 軌（`code-reviewer` subagent），不影響 commit 本體。

## 核心流程

| 階段 | 動作 |
|------|------|
| **Step 1** | 分析 + Stage → **三軌並行**（A 使用者確認 message ∥ B Codex 審查 ∥ C code-reviewer 審查）→ 匯流決策 |
| **Step 2** | Commit → Push → 確認結果 |

三軌（A/B/C）**必須在同一輪訊息內啟動**，才算真並行。匯流條件：

> **Codex PASS（或豁免）✅ ∧ code-reviewer PASS（或豁免）✅ ＋ 使用者未明確否決 → 才能 commit。**

所有純 git / 檔案操作都包在 `flow.sh` 三個 subcommand，主 AI 每階段只呼叫一次 bash：

| 指令 | 動作 | 對應步驟 |
|------|------|---------|
| `flow.sh analyze <repo>` | git 狀態分類 + local-overrides 過濾 + 敏感字掃描 | 1.2 分析 |
| `flow.sh prepare <repo> <files...>` | `git add`（只加列出的檔，不 `git add .`）→ 產出 staged diff 供兩軌讀取 | 1.2 Stage |
| `flow.sh ship <repo> <type> "<desc>"` | HEREDOC `git commit` → `git push` → 驗證 | 2.1 + 2.2 + 2.3 |

## 重點規則

**三軌默許機制**（B + C 兩軌完成即可推進，不必等 A 軌）：

| 情境 | 行為 |
|------|------|
| 兩軌 PASS ＋ 使用者尚未回覆 | → **自動** commit + push（默許，輸出時註明） |
| 兩軌 PASS ＋ 使用者明確確認 ✅ | → commit + push |
| 兩軌 PASS ＋ 使用者明確否決 🖊（「等等」/「先別上」/改 message） | → 照使用者意思，不 commit |
| 任一軌**豁免**（Style/Docs）＋ 尚未回覆 | → **自動** commit + push（豁免比照 PASS 默許） |
| **任一軌 BLOCK** ＋ 任何狀態 | → **絕不自動 commit**，列出必修項等使用者 |

- **AI 禁直接 git**：不手動組 `git status` / `git add` / `git commit`，一律走 `flow.sh`。
- **BLOCK 不 commit**：BLOCK 永遠不默許，即使使用者已先回「OK」也不行；修完直接在 working tree 改 → 重跑 `prepare` → 兩軌重審，無 revert、無 reset。
- **commit message 格式**：`{Type}: {中文描述}`（Type 首字大寫，如 `Feat`、`Fix`、`Refactor`、`Docs`…）；只寫「改了什麼」，禁止把 `P0`/`紅藍對抗`/`Codex`/`PoC` 等對話脈絡寫進 message。
- **多議題自動拆 commit**：一輪 dirty 涵蓋多個不相關議題時直接拆，不問使用者偏好。
- **禁用**：`--amend`、`--no-verify`、force push（`flow.sh ship` 不提供這些旗標）；唯一 `--no-verify` 例外是 pre-commit hook 環境本身故障（須手動補跑檢查 + 留 `[skip-verify]` 標記 + 經使用者同意）。
- **禁 AI 署名**：commit message 不得含 `Co-Authored-By: Claude` 等任何 AI 參與標記。

### 豁免規則

為避免瑣碎變更浪費審查資源，**`Style`（純 UI/CSS/formatting）與 `Docs`（純 `.md`／註解）自動豁免 B、C 兩軌**（仍須 1.3a 預覽 + 敏感字掃描）。

**反豁免（治本把關）**：只要 diff 觸及「會被執行到的程式邏輯」一律不豁免——例如 `Style` 卻動了 `.vue` 的 `<script>` / `v-if` / `@click`、或改了 i18n 的 **key**（非 value）。AI 偵測到就強制送兩軌，並告知使用者。

## 適用情境

- 想把 review 前移、保持 git 歷史乾淨（不留 Fix→Revert 噪音）。
- 單一 git repo，或工作目錄底下多個 git 子目錄的 multi-repo workspace（各自獨立 commit）。
- 需要 Codex 與 code-reviewer 雙軌把關、又不想每次純樣式/文件變更都被審查拖慢。

> 前置：`flow.sh` 走 bash，需可執行 shell；Codex 軌透過 `codex:codex-rescue` subagent，C 軌透過 `code-reviewer` subagent。
