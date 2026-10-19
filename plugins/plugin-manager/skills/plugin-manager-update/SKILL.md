---
name: plugin-manager-update
description: （使用端）把這台電腦所有專案與 user 層已安裝的 fulin marketplace plugin 批次更新到最新版。當使用者說 /plugin-manager-update、「更新所有 plugin」、「把這台電腦的 plugin 全部更新」、「已裝的 plugin 更新到最新」、「各專案的 plugin 同步最新版」、「publish 完讓各專案拿到新版」時觸發。先 dry-run 列表給使用者看，核可後才套用。改完 plugin 要 bump 版號是開發端的 /plugin-manager-bump，不是本 skill。
---

# plugin-manager-update — 全機批次更新已裝的 plugin（使用端）

publish 只把新版推上 git，**已經裝好的專案不會自己變新版**。本 skill 掃這台電腦每一筆本 marketplace 的安裝紀錄（user 層＋各專案的 project／local 層），把落後的更新到 marketplace 最新版。

## 分工
| 端 | 指令 | 範圍 |
|---|---|---|
| 開發端 | `/plugin-manager-bump` | 在 monorepo 改完 plugin → bump 版號、寫 CHANGELOG |
| 開發端 | `/plugin-manager-publish` | 把 monorepo 推上 git |
| 使用端 | `/plugin-manager-update`（本 skill） | **整台電腦**所有已裝的本 marketplace plugin |
| 使用端 | `/setup-plugins upgrade` | 只看**目前這個專案**啟用的自製 plugin，並對照 registry（含「還沒 publish」的提醒） |

順序：`bump` → `publish` → `update`。dirty（bump 了還沒 publish）的版本 marketplace 上還沒有，本 skill 看到的「最新版」是 marketplace clone 裡的版本，不是 monorepo 工作樹。

## 流程

1. **dry-run**（只列表，不改任何東西）：
   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/update-all.js"
   ```
   - 會先刷新 marketplace（`claude plugin marketplace update <mkt>`），再讀 marketplace clone 裡各 plugin 的 `plugin.json` 版號。刷新失敗時 dry-run 照樣列（標示可能過期），但 `--apply` 會拒絕執行；確定要用目前 clone 就明確加 `--no-refresh`。
   - 列出每一筆落後的安裝：plugin、scope、專案路徑、舊版 → 新版、類別：
     - **可更新**：user 層，或 project／local 且專案目錄存在。
     - **失效**：project／local 的專案目錄已不存在（不論版本是否最新都列）。
    - **比 marketplace 新（不動）**：已裝的版號比 marketplace 的新（例如本機開發版），不更新，避免降版。版號用 SemVer 比大小，不是比相不相等。
     - **不處理**：managed、synced 等由系統管理的 scope。
     - **無法判定**：marketplace 已沒有這個 plugin、或讀不到版號。
   - 把表**原樣**給使用者看，問要不要套用。

2. **使用者核可後套用**：
   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/update-all.js" --apply
   ```
   - 逐筆在該安裝的專案目錄下（user 層用家目錄）跑 `claude plugin update <id> --scope <scope> --json`。
   - 跑完重新 `claude plugin list --json` 逐筆比對版本。
   - **巢狀補救**：同一 plugin 在 `X` 與 `X` 底下的子目錄各有一筆 project 安裝時，在 `X` 跑 update 可能拿子目錄那筆比對、回 up_to_date，`X` 那筆沒動（2026-10-11 實測：`X` 是 git 根目錄、子目錄那筆排在前面時重現；兩層都是一般目錄時沒重現）。反過來（子目錄那筆沒動、`X` 那筆排在前面）也實測重現過。腳本偵測到「仍落後且同 plugin 另有 project 安裝在它底下或上層」→ 記下該專案的 `.claude/settings.json`、`settings.local.json` 的位元組 → `uninstall --keep-data` ＋ `install` → 再比對：
     - 設定檔沒變、版本到最新 → `reinstalled`。
     - 設定檔有變 → 印出差異、標「需人工確認」，**不自動還原**。常見原因：原本是 `false`（停用），重裝後變成 `true`。把差異給使用者看，由使用者決定要不要改回。
   - 只更新部分 plugin：加 `--only <plugin名,...>`。

3. **回報總表**：腳本最後印 `updated`／`up_to_date`／`reinstalled`／需人工確認／仍落後／失敗（附 CLI 原始輸出前 200 字）。原樣轉給使用者，並列出**要重開 session 的專案清單**（腳本最後一段）——新版要重開 Claude Code 才生效，這步 Claude 做不到。

4. **失效紀錄逐筆問**：dry-run／apply 的輸出會列出失效紀錄與對應指令。逐筆問使用者要不要移除，**同意哪一筆才跑哪一筆**：
   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/update-all.js" --prune-missing <name@mkt>@<專案路徑>
   ```
   - 做法（2026-10-11 以 Claude Code 2.1.296 在暫存安裝實測）：在別的目錄跑 `claude plugin uninstall --scope project` **不會**作用到失效紀錄；在原路徑暫建空目錄、於其中跑 `uninstall --scope project --keep-data` 才會移除，跑完腳本刪掉暫建的目錄。
   - 腳本會比對前後的安裝紀錄，若有**其他**紀錄一起消失會列出並給裝回指令、exit 1。
   - 不要手改 `~/.claude/plugins/` 底下的 JSON。

## 參數
| 參數 | 作用 |
|---|---|
| （無） | dry-run，只列表 |
| `--apply` | 真的更新 |
| `--no-refresh` | 不刷新 marketplace，直接用目前 clone 的版本 |
| `--only a,b` | 只處理這幾個 plugin |
| `--json` | 輸出 JSON（dry-run 與 apply 都可） |
| `--marketplace <名稱>` | 指定 marketplace（預設依 `~/.claude/plugin-manager/config.json` 的 `marketplace` → monorepo 的 marketplace.json → `fulin-plugins`） |
| `--prune-missing <id>@<路徑>` | 逐筆移除一筆失效紀錄 |

**`--apply` 結束碼**：0＝全部完成；1＝有失敗（CLI 報錯、重裝的 install 失敗）；3＝沒有失敗，但有「仍落後」或「需人工確認」的紀錄——看總表處理。

## 限制（誠實告知）
- `--apply` 會動到**別的專案**的安裝；一定先給使用者看 dry-run 表、拿到核可才跑。
- 更新後要使用者自己重開該專案的 session。
- 預設只處理本 marketplace。外部 marketplace 可用 `--marketplace <名稱>` 另跑，但 plugin 來源不在 clone 內（例如 github 來源）且條目沒寫 version 的，會列為「無法判定」不動；那些用 `/plugin` 介面開 auto-update。
