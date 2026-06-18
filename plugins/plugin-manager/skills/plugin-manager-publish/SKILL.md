---
name: plugin-manager-publish
description: 一鍵把整個自製 plugin monorepo 發布上 git（stage + commit + push）。當使用者說 /plugin-manager:publish、「發布 plugin」、「推上去 monorepo」、「把自製 plugin 推上 git」時觸發。因為所有納管的 skill 真身在 adopt 時已搬進 monorepo，publish 只做純 git 發布——一次推整個 repo，不管改了幾個 plugin。
---

# plugin-manager:publish — 一鍵發布整個 monorepo

把 monorepo（所有自製 plugin 的家）一次 commit + push。解決「一 plugin 一 repo、500 個 plugin 無法維護」的核心痛點——所有自製 plugin 在同一個 repo，發布只需一次。

## 前提
- 自製 skill 的真身在 `/plugin-manager:adopt` 時就已搬進 monorepo，所以 publish **不需要再蒐集**，只做 git。
- monorepo 路徑與 repo 從 `~/.claude/plugin-manager/config.json` 讀。

## 執行步驟

1. **先看待發布狀態**（唯讀，不動 git）：
   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/publish-status.js"
   ```
   輸出：改動的 plugin、git status、建議 commit message。

2. **若工作區乾淨**：告知沒有待發布改動（若本地領先 origin，提示是否只需 push）。

3. **若有改動**：把 status 與建議 commit message 呈現給使用者，**請使用者確認 commit message**（可改）。

4. **確認後執行 git**（在 config.monorepo 目錄）：
   ```
   git -C "<monorepo>" add -A
   git -C "<monorepo>" commit -m "<確認後的訊息>"
   git -C "<monorepo>" push
   ```
   - 這是獨立的自製 plugin monorepo（非供應商平台四個 repo），可直接在此執行 git。
   - commit message 不得加任何 AI 署名（遵守全域規範）。

5. **發布後**：把 registry 中剛發布的 plugin 的 `dirty` 標記清掉（改 false）。可用：
   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/publish-status.js"
   ```
   確認工作區已乾淨。

## 安全原則（誠實告知）
- push 是對外動作。執行前一定要讓使用者看過 status + 確認 commit message。
- 不做 force-push / rebase / amend，除非使用者明確要求。
- 若 push 失敗（遠端有新 commit），回報並建議先 pull，不要自動 force。
- publish 只推 monorepo，**不會自動讓已安裝該 plugin 的專案更新**——使用者需各自 /plugin update（互動指令，Claude 不能代執行）。
