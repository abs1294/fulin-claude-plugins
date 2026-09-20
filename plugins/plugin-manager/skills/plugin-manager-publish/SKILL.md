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
> 完整規範見 `../../CLAUDE.md`。

## 執行步驟

1. **先看待發布狀態**（唯讀，不動 git）：
   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/publish-status.js"
   ```
   輸出：改動的 plugin、git status、建議 commit message。

2. **若工作區乾淨**：告知沒有待發布改動（若本地領先 origin，提示是否只需 push）。

3. **若有改動**：把 status 與建議 commit message 呈現給使用者，採**無人值守默許模式**：
   - 呈現後若使用者**改了 message** → 用改後的；**明確拒絕/喊停** → 中止不 commit、並刪除已排的喚醒（見下）。
   - **超過 5 分鐘沒有任何拒絕或修改** → **視為默許，自動採用建議 message 繼續 commit + push**（不再卡等）。
   - 呈現時明白告知這條規則（例如「5 分鐘內沒回覆就用這個 message 自動發布」），讓使用者知道可在時限內介入。
   - **這是刻意的無人值守設計**（使用者明確要求）：5 分鐘默許後會**自動 commit + push**整條跑完——push 是對外動作，但這裡刻意以「沉默即同意」換取無人值守（掛著不顧、回來已發好）。5 分鐘的窗口就是使用者的介入點。

   > ⚠️ **「5 分鐘自動推」必須有喚醒源，否則是空頭承諾**（實戰教訓）：呈現完 message 後，這一輪就結束、控制權交還使用者——若不主動排一個喚醒，5 分鐘後根本沒有任何東西會觸發 push，只會卡等下一次使用者輸入。
   >
   > **所以呈現 message 的「同一輪」必須立刻排一個 ~5 分鐘後的喚醒**（與 git-commit 不同：那邊的默許掛在「審查完成事件」、當輪即到，不需計時器；本 skill 是時間驅動，必須自備計時器）：
   > - 優先 `ScheduleWakeup({ delaySeconds: 300, reason: "publish 默許窗口", prompt: "<重述：到 /plugin-manager:publish 的 commit+push 步驟>" })`；
   > - 若環境無 ScheduleWakeup，用 `CronCreate({ recurring:false, durable:false, cron:<現在+5分>, prompt: "[publish 默許自動發布] 若使用者自呈現後未否決/未改 message，直接用建議 message 跑 commit + push + finalize。" })`，並記下 job id。
   > - **喚醒時的守衛**：先檢查 ① 使用者是否已在窗口內否決/改 message（是 → 不推、結束）② git 是否已 commit/push（已推 → 結束，不重複）；兩者皆否才執行步驟 4。
   > - **使用者在 5 分鐘內回應時**：先 `CronDelete <id>`（或讓 ScheduleWakeup 的守衛自然 no-op），再依回應處理，避免喚醒重複觸發。
   >
   > ⚠️ **cron 只是備援，不是主路徑**（2026-08-26 實戰教訓）：cron job **只在 REPL 閒置時才 fire**。
   > 若使用者在窗口期間**持續互動**（問別的事、派別的工），REPL 從來不會 idle，cron 永遠不會觸發——
   > 而且是**靜默不推**，使用者不問就不會發現（實證：排了 02:17 的 job，一直對話到 03:40 都沒推）。
   >
   > **正解：每一輪回覆前自己檢查窗口是否已過，過了就直接推，不要等 cron。**
   > 具體做法：呈現 message 後的**每一輪**（不論使用者問的是不是 publish 相關），先判定：
   > ① 距離呈現是否已過 5 分鐘？② 使用者期間有否否決或改 message？③ git 是否已推？
   > ① 是、② 否、③ 否 → **當輪直接跑 commit + push + finalize**，並在回覆中順帶一句告知已發布。
   > cron 保留作為「使用者真的離開了」的備援，兩路以 ③ 守衛互斥、不會重複推。

   **commit message 必須註明本次改了哪一個/哪些 skill（規則 3 — 版本追蹤）**。格式 `<Type>: <skill 名> — <摘要>`，不得加 AI 署名。**`<Type>` 用 flow.sh 的允許值**（`Feat` `Modify` `Style` `Refactor` `Perf` `Chore` `Docs` `Test` `Fix` `Hotfix`），因為步驟 4 是交給 flow.sh 執行、它會擋掉清單外的值。範例：`Modify: delaylocal skill — 修正 LINE 通知逾時重試`。⚠️ 舊版寫「動作詞 Add/Update/Fix」——`Add`／`Update` 不在 flow.sh 清單內，會 exit 1（2026-09-20 實測）；對照改用 Add→`Feat`、Update→`Modify`。
   - 因為有默許機制，建議 message 必須**夠完整可直接發布**（照規則 3 寫好），不能只丟半成品等使用者補。

4. **確認後執行 git**（使用者明確確認、或步驟 3 的 5 分鐘喚醒觸發且通過守衛時；順序：analyze → prepare → ship）：

   ⚠️ **走 `git-commit` skill 的 `flow.sh`，不要裸下 `git commit`**（本 monorepo `CLAUDE.md` 第 2 條）。
   裸 `git commit` 會被 PreToolUse hook `block-bare-git-commit.sh` 擋下——**那道閘攔全部 repo，不限供應商平台**，
   而且沒有旁路（`GIT_COMMIT_FLOW=1` 從外部設不進來）。2026-09-20 實際撞過一次。

   `flow.sh` 收「工作目錄底下的 git 子目錄名」或「`.`」，也收相對路徑——**沒有 repo 白名單**，
   從供應商平台工作目錄指過來用 `../../fulin-claude-plugins` 即可（已實測可行）。

   ```bash
   FLOW="<供應商平台工作目錄>/.claude/skills/git-commit/flow.sh"
   REPO="../../fulin-claude-plugins"   # 相對於該工作目錄

   bash "$FLOW" analyze "$REPO"                       # 看狀態＋敏感掃描
   bash "$FLOW" prepare "$REPO" <files...>            # 逐檔 stage（禁 add -A）
   bash "$FLOW" ship    "$REPO" <Type> "<描述>"       # 只 local commit
   bash "$FLOW" ship    "$REPO" <Type> "<描述>" --push # 使用者核可後才推
   ```

   - **`<Type>` 用 flow.sh 的允許值**，不是本 skill 步驟 3 的 Add/Update/Fix：
     `Feat` `Modify` `Style` `Refactor` `Perf` `Chore` `Docs` `Test` `Fix` `Hotfix`。
     對照：Add→`Feat`、Update→`Modify`、Fix→`Fix`。**寫 `Update` 會被 flow.sh 擋下**（實測 exit 1）。
   - flow.sh 自己會擋 AI 署名、多行 message、敏感字、message 痕跡與寬度超標，不必另外檢查。
   - commit message 由 flow.sh 用 HEREDOC 傳遞，**不會**有字串拼接的注入問題。
   - 找不到 flow.sh（例如這台機器沒裝供應商平台）→ 停下來問使用者，不要改用裸 git 繞過。

5. **發布後清 dirty**（狀態機閉合，**務必執行**）：push 成功後跑：
   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/publish-finalize.js"
   ```
   - 此腳本只在「工作區乾淨且本地未領先 origin（確實已 push）」時，才把 registry 所有 `dirty=true` 清成 false。
   - 若它回報「尚未 push」或「工作區仍有改動」，代表 publish 未完成——先補完再跑。
   - **不要**手動編輯 registry 清 dirty；一律用這支腳本，避免漏清或誤清。

## 安全原則（誠實告知）
- push 是對外動作。執行前一定要讓使用者看過 status + commit message（採無人值守默許：呈現後 5 分鐘無拒絕/修改即自動採用，見步驟 3）。
- 不做 force-push / rebase / amend，除非使用者明確要求。
- 若 push 失敗（遠端有新 commit），回報並建議先 pull，不要自動 force。
- publish 只推 monorepo，**不會自動讓已安裝該 plugin 的專案更新**——使用者需各自刷新：`/plugin marketplace update fulin-plugins` 後重裝（`/plugin uninstall` + `/plugin install`），或開 auto-update。**Claude Code 沒有 `/plugin update` 子指令**，且 `/plugin` 系列是互動指令 Claude 不能代執行。
