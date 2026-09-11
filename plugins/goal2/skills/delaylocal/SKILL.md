---
name: delaylocal
description: 當使用者要「把一段 prompt 排程到 5 小時 quota 重置之後自動在本機執行」時觸發。觸發詞：「/goal2:delaylocal」、「delaylocal」、「排程到 quota 之後」、「quota 重置後跑」、「延後到額度恢復再執行」、「等 5h 額度回來再跑」。要「現在就做、不等 quota」→ 用同 plugin 的 goal skill（/goal2:goal），不是本 skill。
---

# delaylocal — 排程 prompt 到 5h quota 重置後（工具化；goal2 plugin 的 delaylocal skill）

## 架構（薄 skill + 確定性工具）

確定性邏輯全在工具裡，skill 只負責「呼叫工具 → 拿結果 → CronCreate」，不靠 AI 即興。

- `delaylocal.js`：鎖定**當前 session**（讀 `CLAUDE_CODE_SESSION_ID`）的 5h quota 重置時間。goal 模式（預設）：排程時就把引擎 prompt（只有 `/goal <條件>；已發 LINE` 加一句指向錨定區，≤3900 字）落到 `~/.claude/goal2/runs/<id>/prompt.txt`，任務全文、工作清單、報告格式、notify 指令全進同目錄 `anchor.md`（走系統提示，不受 /goal 的 4000 字元限制），cron 的 final_prompt 只做「session 守衛 → 叫 Claude 背景執行 `delaylocal.js --run <run_dir>`」；到點後 `--run` 起子程序 `claude -p "/goal …"` 跑官方引擎到達成。plain 模式：final_prompt 內建「session 守衛 + 無人值守文字紀律 + 任務 + LINE 通知」，不起子程序。
- **為什麼 goal 模式要繞子程序**：2.1.196 起 cron fire 的 prompt 不再解析 slash command，開頭 `/goal` 只是純文字（官方 scheduled-tasks 文件、GitHub #75837）；`claude -p "/goal …"` 是唯一入口（見 `../../lib/engine.js` 檔頭與 goal skill 的 SKILL.md）。
- `notify-line.js`：LINE push 通知工具（node https，處理中文 / emoji）。

> 本 skill 的 js（`delaylocal.js` / `notify-line.js`）與這份 `SKILL.md` **同目錄**。
> 執行時用「本 SKILL.md 所在目錄」組出 js 絕對路徑即可——user-level skill、symlink、plugin 安裝
> 三種情境都成立（不依賴 `CLAUDE_PLUGIN_ROOT` 是否存在）。
> `delaylocal.js` 另依賴 plugin 根層的 `../../lib/`（`goal-head.js`：/goal 第一行 4000 字元門檻；`cron-time.js`：cron 轉換與跨月警告；`config.js`：設定檔讀取；`engine.js`：子程序引擎），
> 與同 plugin 的 goal skill 共用。**須整個 plugin 一起安裝**，只複製 `skills/delaylocal/` 資料夾會找不到 lib（工具會明確報錯）。

## 前置設定（一次性，每台機器）

**需要 Node.js**（`delaylocal.js` 與 `notify-line.js` 皆為 node 腳本）：
- Windows：`winget install OpenJS.NodeJS` 或官網安裝包
- macOS：`brew install node`
- Linux：發行版套件管理器，或 nvm / nodenv

**skill 安裝（user-level symlink，三平台皆可）**：把 plugin 內的 skill 目錄連到 `~/.claude/skills/`：
- macOS / Linux：`ln -s <repo>/plugins/goal2/skills/delaylocal ~/.claude/skills/delaylocal`
- Windows（系統管理員 PowerShell）：`New-Item -ItemType SymbolicLink -Path $HOME\.claude\skills\delaylocal -Target <repo>\plugins\goal2\skills\delaylocal`
- 或三平台都可改用 `/plugin install goal2@fulin-plugins`（免手動 symlink，**建議**；觸發名為 `/goal2:delaylocal`）

（`delaylocal.js` / `notify-line.js` 以 `__dirname` 解析同目錄與 `../../lib`，Node 對 symlink 取真身路徑，所以 symlink、plugin 安裝、user-level 三情境都成立，不依賴執行平台。）

**設定檔（選用）**：`~/.claude/goal2/config.json`（家目錄，重裝 plugin 不會被清掉；範本在 plugin 根層 `config.example.json`）。本 skill 用的欄位：`delaylocal.confirmTimeoutMinutes`（propose 後等使用者確認的逾時，**預設 10 分鐘**）、`delaylocal.bufferSeconds`（quota 重置後再等幾秒才 fire，**預設 900**，CLI 裸數字可臨時覆蓋）、`engine.permissionMode`（子程序權限模式，**預設 bypassPermissions**）、`engine.stopHookBlockCap`（引擎連續擋停上限，**預設 0＝做到達成為止**）、`engine.model`、`engine.autocompact`（子程序壓縮視窗，預設 auto；長任務可調大）。沒檔就用預設；檔案壞掉或欄位錯會直接報錯不靜默退回。`node "<skill_dir>/delaylocal.js" --show-config` 可看生效值與當下的 `confirm_timer_cron`。

LINE 通知為**選用**：**有設憑證就發、沒設就自動略過、完全不影響任務執行**。
要啟用通知再設定其一（憑證**不進 git**）：

- **設定檔（建議）**：複製本 skill 目錄下的 `notify-line.config.example.json`
  成 `notify-line.config.json`（同目錄），填入你的 LINE Channel Access Token 與 userId。
- **或環境變數**：設 `LINE_TOKEN`、`LINE_USER_ID`。

沒設好的話，排程照常建立、任務照常無人值守執行；結束時 `notify-line.js` 只會印一行
`LINE SKIP …` 並以 exit 0 結束（不算失敗、不卡 goal）。

## 執行步驟

### 🧭 先看這張決策表（三選一，弱模型務必先分流再往下）

| 使用者的意圖 | 走哪條 | 關鍵動作 |
|--------------|--------|----------|
| 「直接排、別問」（趕 quota 視窗、明說不要問） | **fast-path**（下方⚡） | `--plain`，立刻排，唯一可停：args 為空 |
| 一般排程、要「做到完成」（預設） | **goal 模式** | 先 propose 完成條件 → 使用者確認 → `--goal` 排程 |
| 明確說「不要目標、就照文字跑」 | **plain 模式** | `--plain`，不要完成條件 |
| 要「現在就做、不等 quota」 | **不是本 skill** | 改用同 plugin 的 `goal` skill（`/goal2:goal`） |

> **兩層時間別混淆**（弱模型最常錯的點；完整表見 `../../references/goal-propose-flow.md` 第 5 節）：
> - **第 1 層＝任務何時 fire**：quota 重置後（`delaylocal.js` 算出的 cron）。這是「任務本體」的排程。⚠️ CronCreate 的 `durable` 在目前版本**無效**（工具 schema 明寫「Has no effect — all jobs are session-only」，六月與現在皆如此）：job 只活在本 process，Claude Code 關掉就沒了。
> - **第 2 層＝goal 模式的 propose 確認 timer**（預設 10 分鐘，設定檔 `delaylocal.confirmTimeoutMinutes` 可調）：只在 goal 模式、且你 propose 完成條件後才有，是「等使用者確認」的短 timer（`durable:false`），與第 1 層是**不同的 job**。
> - fast-path 與 plain 模式**沒有**第 2 層。只有 goal 模式才需要處理 propose timer。

### ⚡ 無條件直接排程（fast-path，最高優先）

當使用者意圖是「直接排、別問」時（觸發詞：「直接排程」、「無條件放進排程」、「quota 快滿了先排」、「不要 propose」、「不要問直接排」，或單純就是要你立刻把 args 排進去），**立刻用 `--plain` 模式排程**，並**嚴禁**：
- ❌ 用 AskUserQuestion 反問「要不要排 / 怎麼排 / 是不是真任務」
- ❌ 走 goal propose → 確認 → 確認 timer 流程
- ❌ 要求使用者補完成條件

直接執行：
1. Write 把 args 原文寫進唯一名暫存檔（命名規則同下方步驟 2）。
2. `node "<skill_dir>/delaylocal.js" --prompt-file <檔> --plain`（讓工具讀**真實** `CLAUDE_CODE_SESSION_ID`，勿自設假值）。
3. 用輸出的 cron + final_prompt 直接 `CronCreate({ recurring:false, durable:false })`。
4. 依步驟 5 格式回報。

> **唯一可停下的情況**：args 完全為空 → 請使用者補。其餘一律直接排，不問。
> ⚠️ 排程是時間敏感操作（quota 視窗），任何反問都在浪費使用者的視窗——這就是本 fast-path 存在的理由。

---

**（一般情況）預設為 goal 模式。** 先做下方「goal 模式排程流程」的 propose → 確認，拿到使用者確認的**完成條件**，
再走下列步驟（步驟 3 會帶 `--goal "<完成條件>"`）。只有在這個任務實在無法定義可測量條件時，
才改用 `--plain` 文字模式（可跳過 propose、不需完成條件）。
> 若使用者要求「無條件直接排」，**上方 fast-path 優先**，跳過本 goal propose 流程。

### 1. 取得使用者要排的 prompt 原文
`/delaylocal <prompt>` 的 args。空 → 請使用者補，停止。

### 2. 把 prompt 寫進「唯一名稱」的暫存檔（避免 shell escape + 並發覆寫）
用 Write 把 prompt 原文寫到暫存檔。**檔名必須每次唯一**，禁止用固定檔名（多 session 並發、或同 session 多次排程會互相覆寫）。

檔名規則：`delaylocal-input-<14位時間戳>-<4位隨機>.txt`，放在**系統暫存目錄**（不要寫死使用者名，一律用該機器展開後的絕對路徑）：
- **Windows**：`%TEMP%`，通常 `C:\Users\<你的帳號>\AppData\Local\Temp\`
- **macOS**：`$TMPDIR`（通常 `/var/folders/.../T/`）或 `/tmp`
- **Linux**：`$TMPDIR` 或 `/tmp`

例如 Windows `%TEMP%\delaylocal-input-20260520213045-7f3a.txt`；macOS `$TMPDIR/delaylocal-input-20260520213045-7f3a.txt`

> 步驟 3、收尾的 `node "<skill_dir>/..."` 與 `cat "<path>" | node ...` 指令在 macOS / Linux 原生 shell（bash / zsh）即可執行；Windows 則在 git-bash 下執行（語法相同）。

> 此中繼檔是一次性消耗品：`delaylocal.js` 讀取後會**自動刪除**。

### 3. 跑主工具拿 JSON
```bash
# <skill_dir> = 本 SKILL.md 所在目錄
# 預設 goal 模式：帶 --goal "<使用者已確認的完成條件>"
node "<skill_dir>/delaylocal.js" [bufferSeconds] --prompt-file <步驟2的唯一檔名> --goal "<已確認的完成條件>"
# 文字模式（少數無法定義可測量條件時）：改帶 --plain、省略 --goal
```
- `bufferSeconds` 預設 900（15 分），可在設定檔 `~/.claude/goal2/config.json` 的 `delaylocal.bufferSeconds` 改預設；要臨時不同緩衝就帶數字（例 `1800`=30 分，CLI 優先於設定檔）。輸出的 `buffer_source` 說明用了哪個（cli / config / default）。
- 工具讀完 prompt 會**自動刪除**該 `--prompt-file`。
- 工具輸出 JSON：`{ ok, sessionId, snapshotKey, resets_at_local, target_local, cron, cron_warning, fire_in_minutes, buffer_seconds, buffer_source, confirm_timeout_minutes, confirm_timer_cron, confirm_timer_target_local, config_path, config_loaded, mode, run_dir, run_command, stop_command, engine, engine_prompt, final_prompt }`。goal 模式時 `run_dir` 已建好、`engine_prompt`（`/goal` 開頭）已落在裡面；plain 模式這三個為 null。
- `ok:false` → 把 error 告訴使用者，停止。

### 4. 用工具輸出的 cron + final_prompt 排程
```
CronCreate({
  cron: <JSON.cron>,
  prompt: <JSON.final_prompt>,   // goal 模式：session 守衛 + 「背景執行 run_command」指令；plain 模式：守衛 + 紀律 + 任務 + LINE
  recurring: false,
  durable: false                 // durable 在目前版本無效，填 true 也是 session-only；誠實寫 false
})
```
**禁止**自己把 `/goal` 放進 cron 的 prompt——到點時它只是純文字，不會啟動引擎。

### 5. 回報使用者（只回報以下欄位，格式固定）
- Cron Job ID
- 觸發時間：`JSON.target_local`（約 `JSON.fire_in_minutes` 分鐘後）
- **若 `JSON.cron_warning` 非 null → 必須把它原文一併回報給使用者**（跨月/跨年時 cron 可能 fire 到非預期年份的警告；請使用者核對觸發時間是否為預期那天）。為 null 則略過此行。
- quota 重置時間：`JSON.resets_at_local`、緩衝秒數
- 綁定 session：`JSON.sessionId`；goal 模式另報 `JSON.run_dir`
- 提醒（純陳述事實，不加 offer）：
  - cron 只活在本 Claude Code process，且 REPL idle 才 fire（`durable` 無效，關掉程式排程就沒了）
  - final prompt 內建 **session 守衛**：只有 `JSON.sessionId` 那個 session 會真正執行，其他 session fire 到會自動跳過
  - goal 模式到點後會另起子程序跑官方 /goal 引擎做到達成；完成 / 中止會嘗試發 LINE 總結（未設 LINE 憑證則自動略過、不影響任務）
- 取消：`CronDelete <id>`

### 6. cron 到點後（goal 模式，final_prompt 會指示你做這些）
1. Session 守衛通過 → 用 Bash、`run_in_background: true` 原樣執行 `run_command`（`node "<delaylocal.js>" --run "<run_dir>"`）。它阻塞到引擎結束，最後印 summary JSON。
2. 收到背景結束通知後讀 JSON：`goal_achieved`、`continuations`、`compactions`／`anchor_injections`（壓縮次數與壓縮後錨定注回次數）、`num_turns`、`result_text`（引擎最後一則回覆＝報告全文，**原文保留**）、`run_dir`（`stream.jsonl` 可追查、`progress.md` 是進度帳本）。固定格式回報，不加提問或 offer。
3. 進行中要終止：`node "<skill_dir>/delaylocal.js" --stop <run_dir>`（殺整棵子程序樹、標 stopped）；要看進度：`--status <run_dir>`，回報時第一句直接用它的 `summary_zh`（狀態＋回合＋擋停次數＋壓縮次數＋最後動作＋最後一句，已是人話），再貼 `progress_md` 的已完成／剩餘；欄位對照見 goal skill 的 SKILL.md 4b。不要只 TaskStop 背景指令，子程序會變孤兒。

**嚴禁**在回報結尾追加任何「建議 / 下一步 / 要不要我改用別的方式」之類的提問或 offer。
回報到「取消方式」就結束。

### goal 模式排程流程（propose →（確認 / 逾時自動採納）→ 排程）⚠️ 必守

goal 是**預設模式**。通用骨架（為什麼要 propose、可測量條件怎麼寫、timer 怎麼收斂、/goal 引擎契約）在 `../../references/goal-propose-flow.md`，**先讀第 2、3 節**。`delaylocal.js` 在「非 --plain 又沒給 --goal」時會直接報錯，提醒先 propose——**禁止未經 propose 就排任務**。

本 skill 的具體差異（對照 references 第 3 節的表）：

1. **propose 時**一併給：完成條件、任務拆解、**緩衝秒數 / 預計 fire 時間**。
2. **確認 timer 的 cron 由工具算，不要心算**：先跑 `node "<skill_dir>/delaylocal.js" --show-config`，拿 `confirm_timer_cron`（= 現在 + 設定檔 `delaylocal.confirmTimeoutMinutes`，預設 10 分鐘，向上取整到整分）與 `confirm_timeout_minutes`。timer 的 prompt 是**文字指令**（不是任務本體）：`CronCreate({ cron: <confirm_timer_cron>, recurring:false, durable:false, prompt: "[delaylocal 逾時自動採納] 若使用者自此 propose 後尚未回覆，視為自動採納，直接完成排程。完成條件：<condition 全文>；任務：<task>；buffer：<秒>。請跑 delaylocal.js --goal 後 CronCreate。" })`。**記下 timer 的 job id。**回報時把 `confirm_timeout_minutes` 講給使用者（「N 分鐘內沒回覆將自動採納」）。
3. **收斂**：使用者回覆 → 先 `CronDelete <timer id>` 再處理（同意 → 第 4 步；改 → 重 propose 並重排 timer）；逾時 → timer fire 自動採納，進第 4 步。
4. **排程任務**：跑 `delaylocal.js … --goal "<採納的完成條件>"`（此時引擎 prompt 已落 `run_dir`）取得 final_prompt，再 `CronCreate`（到 quota 重置後 fire；fire 進來的 prompt 會叫你背景執行 `run_command` 起引擎）。timer 與任務是**兩個不同的 job**。

## 運作原理（why，不是執行步驟）

- **算哪個 session 的 quota**：工具讀 `CLAUDE_CODE_SESSION_ID`（去 dash 取前 24 字元 = snapshot key）→ 精準鎖定當前 session。
- **排到哪個 session 執行**：cron 是 session-only（`durable` 無效），fire 時仍以 final prompt 第一步的 session 守衛保險 → 只有目標 session 執行。
- **無人值守（unattended）**：plain 模式的 final prompt 內建紀律——假設使用者不在線、不停下來問、持續執行直到無可執行項目、每次收尾前強制自問清單全「否」才可結束、只有真 blocker 才停。goal 模式則交給官方引擎的檢查器。
- **goal 引擎在子程序**：/goal 引擎契約（第一行必須是 `/goal`、4000 字元上限、達成後自動清除、本質是 Stop hook）見 `../../references/goal-propose-flow.md` 第 4 節。2.1.195 時 cron 送 `/goal` 曾能啟動引擎；**2.1.196 起不再解析**（GitHub #75837），所以現在分兩層：
  - **cron 的 final_prompt**（fire 進本 session）：session 守衛 → 叫 Claude 背景執行 `delaylocal.js --run <run_dir>`。
  - **引擎 prompt**（排程時落在 `run_dir/prompt.txt`，由 `--run` 交給 `claude -p`）：**第一行** = `/goal <完成條件>；並且已執行 notify-line.js 完成收尾通知（…）`——把「已收尾通知」**納入完成條件**：goal 達成後會自動清除、不接後續指示，唯有把這步寫進條件，引擎才會強迫做完才停（未設憑證時 notify-line.js 回 exit 0，同樣算達成、不卡）。⚠️ -p 路徑下 4000 字元上限算的是**整段 prompt**（2026-09-12 實測），所以任務、工作清單、報告格式一律在 anchor.md；條件本身超長時 `lib/goal-head.js` 把第一行換成指針句、全文放 anchor「完成條件全文」並要求引擎第一則回覆先貼出。工作清單（在 anchor）= ①開工先拆里程碑進帳本 ②執行任務 ③補帳本＋寫報告＋發 LINE。子程序沒有 session 守衛的問題（它就是為這個任務起的）。
  - **長任務防漂移**：`anchor.md`（條件＋任務＋帳本規則）進子程序系統提示、`progress.md` 帳本邊做邊更新、SessionStart(compact) hook 壓縮後注回——與 goal skill 同一套，細節見 goal skill 的 SKILL.md「運作原理」與 references 第 4 節。
- **為什麼 goal 要先 propose**：見 references 第 1 節。無法定義可測量條件的少數任務，才加 `--plain` 退回文字版紀律（不需條件、跳過 propose）。
- **LINE 通知（選用）**：final prompt 結尾呼叫 `notify-line.js` 嘗試發總結；未設憑證則自動略過、不影響完成。

## 注意

- `rate-limit-snapshots.json` 的 `resets_at` 只在送訊息時更新；skill 由使用者送 prompt 觸發 → 即時可信。
- 只用 CronCreate 排程，不可用 SQL 偽造。
- LINE 憑證放本機 `notify-line.config.json` 或環境變數，**不進 git**（已被 .gitignore 排除）。
