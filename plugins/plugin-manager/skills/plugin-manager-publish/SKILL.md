---
name: plugin-manager-publish
description: 一鍵把整個自製 plugin monorepo 發布上 git（stage + commit + push）。當使用者說 /plugin-manager:publish、「發布 plugin」、「推上去 monorepo」、「把自製 plugin 推上 git」時觸發。因為所有納管的 skill 真身在 adopt 時已搬進 monorepo，publish 只做純 git 發布——一次推整個 repo，不管改了幾個 plugin。
---

# plugin-manager:publish — 一鍵發布整個 monorepo

把 monorepo（所有自製 plugin 的家）一次 commit + push。解決「一 plugin 一 repo、500 個 plugin 無法維護」的核心痛點——所有自製 plugin 在同一個 repo，發布只需一次。

## 前提
- 自製 skill 的真身在 `/plugin-manager:adopt` 時就已搬進 monorepo，所以 publish **不需要再蒐集**，只做 git。
- monorepo 路徑與 repo 從 `~/.claude/plugin-manager/config.json` 讀。

> **規則 2（改 skill 必發布）**：只要改動任何已納管 skill（monorepo 真身或其 symlink），完成後必須主動提醒使用者 `/plugin-manager:publish` 推上 remote；對「改完沒 publish 就結束對話」也成立——結束前要提醒未發布的 skill 變更。
>
> **規則 4（發布前確認 README）**：若本次 status 含新增/刪除 `plugins/<name>/`，發布前先確認根 `README.md` 的 plugin 列表與「結構」樹已同步，未同步就提醒補上再一起 publish。
>
> 完整規範見 `../../CONVENTIONS.md`。

## 執行步驟

1. **先看待發布狀態**（唯讀，不動 git）：
   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/publish-status.js"
   ```
   輸出：改動的 plugin、git status、建議 commit message。

2. **若工作區乾淨**：告知沒有待發布改動（若本地領先 origin，提示是否只需 push）。

3. **若有改動**：把 status 與建議 commit message 呈現給使用者，**請使用者確認 commit message**（可改）。

   **commit message 必須註明本次改了哪一個/哪些 skill（規則 3 — 版本追蹤）**。格式 `<動作>: <skill 名> — <摘要>`，動作詞 Add/Update/Fix，不得加 AI 署名。範例：`Update: delaylocal skill — 修正 LINE 通知逾時重試`。完整格式與範例詳 `../../CONVENTIONS.md`。

4. **確認後執行 git**（在 config.monorepo 目錄，順序：add → commit → push）：

   先 stage：
   ```
   git -C "<monorepo>" add -A
   ```
   再 commit。**不要**把訊息直接拼進命令列（`-m "<訊息>"`）——若訊息含 `"`、`` ` ``、`$`、`\` 等，會破壞 shell 引號甚至造成命令注入。改用 **stdin 傳遞**，內容原樣不展開。**此段必須在 Bash 執行**（用 Bash tool）；heredoc 是 Bash 語法，PowerShell/cmd 不支援：
   ```bash
   git -C "<monorepo>" commit -F - <<'COMMIT_MSG'
   <確認後的訊息，可多行，原樣不展開>
   COMMIT_MSG
   ```
   最後 push：
   ```
   git -C "<monorepo>" push
   ```
   - 這是獨立的自製 plugin monorepo（非供應商平台四個 repo），可直接在此執行 git。
   - commit message 不得加任何 AI 署名（遵守全域規範）。
   - **安全**：commit message 來自使用者輸入，務必走 `-F -` / heredoc（在 Bash），**禁止**字串拼接進 `-m`。

5. **發布後清 dirty**（狀態機閉合，**務必執行**）：push 成功後跑：
   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/publish-finalize.js"
   ```
   - 此腳本只在「工作區乾淨且本地未領先 origin（確實已 push）」時，才把 registry 所有 `dirty=true` 清成 false。
   - 若它回報「尚未 push」或「工作區仍有改動」，代表 publish 未完成——先補完再跑。
   - **不要**手動編輯 registry 清 dirty；一律用這支腳本，避免漏清或誤清。

## 安全原則（誠實告知）
- push 是對外動作。執行前一定要讓使用者看過 status + 確認 commit message。
- 不做 force-push / rebase / amend，除非使用者明確要求。
- 若 push 失敗（遠端有新 commit），回報並建議先 pull，不要自動 force。
- publish 只推 monorepo，**不會自動讓已安裝該 plugin 的專案更新**——使用者需各自刷新：`/plugin marketplace update fulin-plugins` 後重裝（`/plugin uninstall` + `/plugin install`），或開 auto-update。**Claude Code 沒有 `/plugin update` 子指令**，且 `/plugin` 系列是互動指令 Claude 不能代執行。
