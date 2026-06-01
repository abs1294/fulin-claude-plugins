---
name: delaylocal
description: 當使用者要「把一段 prompt 排程到 5 小時 quota 重置之後自動在本機執行」時觸發。觸發詞：「delaylocal」、「排程到 quota 之後」、「quota 重置後跑」、「延後到額度恢復再執行」、「等 5h 額度回來再跑」。
---

# delaylocal — 排程 prompt 到 5h quota 重置後（工具化）

## 架構（薄 skill + 確定性工具）

確定性邏輯全在工具裡，skill 只負責「呼叫工具 → 拿結果 → CronCreate」，不靠 AI 即興。

- `delaylocal.js`：鎖定**當前 session**（讀 `CLAUDE_CODE_SESSION_ID`）的 5h quota 重置時間，組裝含「session 守衛 + autonomous 紀律 + 使用者 prompt + LINE 通知」的 final prompt，輸出 cron + final_prompt（JSON）。
- `notify-line.js`：LINE push 通知工具（node https，處理中文 / emoji）。

> 本 skill 的 js（`delaylocal.js` / `notify-line.js`）與這份 `SKILL.md` **同目錄**。
> 執行時用「本 SKILL.md 所在目錄」組出 js 絕對路徑即可——user-level skill、symlink、plugin 安裝
> 三種情境都成立（不依賴 `CLAUDE_PLUGIN_ROOT` 是否存在）。

## 前置設定（一次性，每台機器）

LINE 憑證**不進 git**，要在本機自行設定其一：

- **設定檔（建議）**：複製本 skill 目錄下的 `notify-line.config.example.json`
  成 `notify-line.config.json`（同目錄），填入你的 LINE Channel Access Token 與 userId。
- **或環境變數**：設 `LINE_TOKEN`、`LINE_USER_ID`。

沒設好的話，排程仍會建立，但結束時 LINE 通知會失敗（會印錯誤訊息）。

## 執行步驟

**預設為 goal 模式。** 先做下方「goal 模式的排程流程」的 propose → 確認，拿到使用者確認的**完成條件**，
再走下列步驟（步驟 3 會帶 `--goal "<完成條件>"`）。只有在這個任務實在無法定義可測量條件時，
才改用 `--plain` 文字模式（可跳過 propose、不需完成條件）。

### 1. 取得使用者要排的 prompt 原文
`/delaylocal <prompt>` 的 args。空 → 請使用者補，停止。

### 2. 把 prompt 寫進「唯一名稱」的暫存檔（避免 shell escape + 並發覆寫）
用 Write 把 prompt 原文寫到暫存檔。**檔名必須每次唯一**，禁止用固定檔名（多 session 並發、或同 session 多次排程會互相覆寫）。

檔名規則：`delaylocal-input-<14位時間戳>-<4位隨機>.txt`，放在 `C:\Users\User\AppData\Local\Temp\`。
例如：`C:\Users\User\AppData\Local\Temp\delaylocal-input-20260520213045-7f3a.txt`

> 此中繼檔是一次性消耗品：`delaylocal.js` 讀取後會**自動刪除**。

### 3. 跑主工具拿 JSON
```bash
# <skill_dir> = 本 SKILL.md 所在目錄
# 預設 goal 模式：帶 --goal "<使用者已確認的完成條件>"
node "<skill_dir>/delaylocal.js" [bufferSeconds] --prompt-file <步驟2的唯一檔名> --goal "<已確認的完成條件>"
# 文字模式（少數無法定義可測量條件時）：改帶 --plain、省略 --goal
```
- `bufferSeconds` 預設 900（15 分）。要不同緩衝就帶數字（例 `1800`=30 分）。
- 工具讀完 prompt 會**自動刪除**該 `--prompt-file`。
- 工具輸出 JSON：`{ ok, sessionId, resets_at_local, target_local, cron, fire_in_minutes, final_prompt }`
- `ok:false` → 把 error 告訴使用者，停止。

### 4. 用工具輸出的 cron + final_prompt 排程
```
CronCreate({
  cron: <JSON.cron>,
  prompt: <JSON.final_prompt>,   // 已含 session 守衛 + autonomous + LINE 通知
  recurring: false,
  durable: true
})
```

### 5. 回報使用者（只回報以下欄位，格式固定）
- Cron Job ID
- 觸發時間：`JSON.target_local`（約 `JSON.fire_in_minutes` 分鐘後）
- quota 重置時間：`JSON.resets_at_local`、緩衝秒數
- 綁定 session：`JSON.sessionId`
- 提醒（純陳述事實，不加 offer）：
  - durable cron 需 Claude Code process 活著 + REPL idle 才 fire
  - final prompt 內建 **session 守衛**：只有 `JSON.sessionId` 那個 session 會真正執行，其他 session fire 到會自動跳過
  - 完成 / 中止會自動發 LINE 總結
- 取消：`CronDelete <id>`

**嚴禁**在回報結尾追加任何「建議 / 下一步 / 要不要我改用別的方式」之類的提問或 offer。
回報到「取消方式」就結束。

## goal 模式（預設）

把「做到完成」的判定交給 Claude Code 的 **`/goal` 引擎**（跨回合做到可測量條件達成、Haiku 檢查器每回合驗證），
取代預設那段文字版自問清單。**已實測**：durable cron fire 進活著的 REPL 時，開頭的 `/goal`（含**多行** args）
會被解析成 slash command 並啟動 goal 引擎。

步驟 3 加 `--goal`：
```bash
node "<skill_dir>/delaylocal.js" [bufferSeconds] --prompt-file <唯一檔名> --goal "<可測量完成條件>"
```

產出的 final_prompt 特性（解掉「/goal 要佔第一行」與 delaylocal 機制的衝突）：
- **第一行** = `/goal <你的完成條件>；並且已執行 notify-line.js 發出 LINE 總結（回應 200）`
  —— 把「已發 LINE」**納入完成條件**：goal 達成後會自動清除、不接後續指示，所以唯有把發 LINE 寫進條件，
  goal 引擎才會強迫自己發完才肯停。
- **session 守衛 = 工作清單第①項**（不搶 `/goal` 的第一行）：非綁定 session fire 到 → 視為達成、不做事、不發 LINE。
- 實際任務 / 發 LINE = 工作清單第 ②③ 項。

完成條件要「可測量 + 有明確驗證方法」（例：`某檔存在且內容為 X`、`npm test exits 0`），別寫模糊的哲學目標。
**goal 是預設模式**；只有在任務無法定義可測量條件時，才加 `--plain` 退回文字版無人值守紀律（不需完成條件、跳過 propose）。`delaylocal.js` 在「非 --plain 又沒給 --goal」時會直接報錯，提醒先 propose。

### goal 模式的排程流程（propose →（確認 / 10 分鐘逾時自動採納）→ 排程）⚠️ 必守

使用 goal 模式時，**禁止未經 propose 就排任務**。固定走：

1. **理解任務**：讀懂使用者要排的任務目的與範圍。
2. **提議 goal（propose）+ 排逾時 timer**：
   - 由你（Claude）幫使用者**推導**並一次 propose 出來：**完成條件**（可測量、有驗證方法，核心）、任務拆解、緩衝秒數 / 預計 fire 時間。此時**先不要**排任務。
   - **同時排一個約 10 分鐘後的一次性 timer**：`CronCreate({ cron: <現在+10分>, recurring:false, durable:false, prompt: "[delaylocal 逾時自動採納] 若使用者自此 propose 後尚未回覆，視為自動採納，直接完成排程。完成條件：<condition 全文>；任務：<task>；buffer：<秒>。請跑 delaylocal.js --goal 後 CronCreate。" })`。**記下這個 timer 的 job id。**
3. **收斂（兩種）**：
   - **a. 使用者 10 分鐘內回覆** → **先 `CronDelete <timer id>`**，再依回覆處理：同意 → 進第 4 步；要改 → 調整完成條件、重新 propose（並重排新 timer）。
   - **b. 10 分鐘內無回覆** → timer fire → **自動採納** propose 的完成條件，進第 4 步。
4. **排程任務**：跑 `delaylocal.js … --goal "<採納的完成條件>"` 取得 final_prompt，再 `CronCreate`（`durable:true`，到 quota 重置後 fire 跑任務）。

> **兩層時間別混淆**：①「10 分鐘」是 propose 的**確認逾時**（逾時自動採納）；②任務**真正執行**在 quota 重置後（delaylocal 本意）。
> 設計動機：goal 條件寫不好會讓引擎空轉燒 token，所以先 propose 讓使用者過目；但使用者可能離線，故 10 分鐘無回覆即自動採納，不讓排程卡在等確認。

## 設計要點

- **算哪個 session 的 quota**：工具讀 `CLAUDE_CODE_SESSION_ID`（去 dash 取前 24 字元 = snapshot key）→ 精準鎖定當前 session。
- **排到哪個 session 執行**：durable cron 跨 session，但 final prompt 第一步是 session 守衛 → 只有目標 session 執行。
- **無人值守（unattended）**：final prompt 內建紀律——假設使用者不在線、不停下來問、持續執行直到無可執行項目、每次收尾前強制自問清單全「否」才可結束、只有真 blocker 才停。
- **LINE 通知**：final prompt 結尾必呼叫 `notify-line.js` 發總結。

## 注意

- `rate-limit-snapshots.json` 的 `resets_at` 只在送訊息時更新；skill 由使用者送 prompt 觸發 → 即時可信。
- 只用 CronCreate 排程，不可用 SQL 偽造。
- LINE 憑證放本機 `notify-line.config.json` 或環境變數，**不進 git**（已被 .gitignore 排除）。
