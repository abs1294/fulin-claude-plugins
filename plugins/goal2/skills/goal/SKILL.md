---
name: goal
description: 當使用者要「先定一條可測量完成條件、再讓 Claude Code 的 goal 引擎做到完成為止」時觸發。觸發詞：「/goal2:goal」、「幫我定完成條件再跑」、「propose goal」、「用 goal 引擎做到完成」、「做到完成為止」、「定好驗收條件自動跑」。不排程到 quota 之後（那是同 plugin 的 delaylocal skill）；也不是替使用者手打內建 /goal——本 skill 幫使用者推導條件、確認（或逾時自動採納）後，用 goal.js 起一個 headless 子程序 `claude -p "/goal …"` 跑官方引擎到達成，最後在本對話回報（本機有裝 wtf plugin 就套 wtf 的重講紀律寫回報）。
---

# goal — 定完成條件、讓官方 /goal 引擎做到完成

把「做到完成」的判定交給 Claude Code 的 `/goal` 引擎（本質是 session 級的 Stop hook：Claude 每次要停下時由檢查器驗證條件，未達成就被推回去繼續），但**條件由你（Claude）先推導、使用者過目**，不是直接把使用者的一句話丟給引擎。

| | 本 skill（`goal`） | 同 plugin 的 `delaylocal` |
|---|---|---|
| 何時跑 | propose 完直接起（預設）；設定檔開確認 timer 則等你確認或逾時 | 5h quota 重置後 |
| 引擎在哪跑 | 子程序 `claude -p`（headless session） | 同左，由 cron 到點後的本 session 啟動 |
| 需要 cron | 預設不需要；只有開了確認 timer 才排一個 | 任務本體與逾時 timer 都要 |
| LINE 收尾 | 無；最終回報在本對話（有 wtf 就套 wtf 格式） | 有（選用） |

## 為什麼是子程序（讀完再動手，別想走捷徑）

- Claude 自己輸入不了斜線指令。
- **2.1.196 起，cron 排程 fire 的 prompt 不再解析 slash command**：開頭 `/goal` 只是純文字（官方 scheduled-tasks 文件、GitHub #75837）。跨 session 訊息、skill 內包 `/goal` 也一樣不執行。**禁止**再用 CronCreate 送 `/goal`。
- 唯一可由 Claude 啟動引擎的入口是 `claude -p "/goal …"`（官方 goal 文件；2.1.268 實測：Goal set → 第一回合故意做一半 → 引擎自動推第二回合 → 達成）。`goal.js --run` 就是在做這件事，並避開兩個坑：git-bash 會把開頭 `/goal` 轉成 Windows 路徑、巢狀 session 的 `CLAUDECODE` 環境變數。

## 架構（薄 skill + 確定性工具）

- `goal.js`：**準備**（建 run 目錄、落 `/goal` prompt、anchor、帳本模板）→ **執行**（`--run <run_dir>`：起子程序、收 stream、產 summary）→ 隨時 **`--status <run_dir>`**（看進度，不阻塞）／**`--stop <run_dir>`**（先核對 pid 身分——啟動時間＋程式名——對得上才 `taskkill /T`；pid 已被別的程序重用就只把狀態收成 stopped、不殺任何東西）／**`--list`**（全機所有 run，含 `alive_state`：alive／dead／stale／unknown）／**`--prune [--dry-run] [--keep-hours N]`**（唯一允許的清理，四類且都要超過 N 小時（預設 24）：已結束且程序不在、`running` 但 pid 已死或被重用、`prepared` 從未啟動、沒有 meta 的壞目錄；活著或探測不明的一律不碰；單一目錄刪不掉會記進 `failed[]` 繼續）。
- `../../lib/`：`goal-head.js`（4000 字元門檻）、`cron-time.js`、`config.js`（設定檔）、`engine.js`（子程序引擎、wtf 偵測）。**本 skill 須整個 plugin 一起安裝**，只複製 `skills/goal/` 會找不到 lib（工具會明確報錯）。
- run 目錄：`~/.claude/goal2/runs/<時間戳-goal-隨機>/`，內含 `prompt.txt`（只有 `/goal 條件` 加一句指向錨定區，≤3900 字）、`anchor.md`（完成條件全文＋任務全文＋工作清單＋帳本規則，會放進子程序的系統提示）、`progress.md`（進度帳本，子程序邊做邊更新）、`meta.json`、`stream.jsonl`（子程序完整事件流）、`result.json`（summary）、`status.json`（每次 `--status` 順手寫一份；終端機是 cp950 中文糊掉時改用 Read 讀它）、`compact-log.txt`（壓縮後錨定 hook 有 fire 才出現）。要追查引擎做了什麼就看 stream.jsonl；要看它做到哪就看 progress.md；**要確認到底達成沒**，看 `result.json` 的 `goal_verdict`（來源是子程序自己的 transcript，路徑在 `child_transcript`）。

> `goal.js` 與這份 `SKILL.md` **同目錄**。執行時用「本 SKILL.md 所在目錄」組出 js 絕對路徑即可。

## 前置設定

- **需要 Node.js**，且 `claude` 在 PATH（子程序就是它；不在 PATH 時設環境變數 `GOAL2_CLAUDE_BIN` 指到可執行檔）。
- **每個 JSON 輸出都帶 `plugin_version` 與 `plugin_root`**。回報「已啟動」時要講版本；若 `plugin_root` 是 `~/.claude/plugins/cache/...` 而 repo 工作樹版本更新，代表安裝版落後，提醒使用者 `/plugin update goal2@fulin-plugins`（2026-09-12 兩個 session 都在跑 0.3.1、審的卻是 0.3.3）。
- 安裝：`/plugin install goal2@fulin-plugins` → `/reload-plugins`。
- ⚠️ **不要**把本 skill symlink 成 `~/.claude/skills/goal`——user-level 名字會與內建 `/goal` 撞名。plugin 安裝後的觸發名是 `/goal2:goal`。
- **設定檔（選用）**：`~/.claude/goal2/config.json`（家目錄，重裝 plugin 不會被清掉；範本在 plugin 根層 `config.example.json`）。本 skill 用的欄位：
  - `engine.permissionMode`：子程序權限模式，**預設 bypassPermissions**（無人值守遇到權限提示就會卡死；保守可改 acceptEdits）。
  - `engine.stopHookBlockCap`：引擎連續擋停幾次後 Claude Code 強制結束回合，**預設 0＝不設上限**（Claude Code 自己的預設是 8）。
  - `engine.model`：子程序模型，預設 null 沿用預設。
  - `engine.autocompact`：子程序的上下文自動壓縮視窗，`auto` 或 100000–1000000 tokens 的整數，**預設 auto**。長任務想讓壓縮晚一點發生就調大；壓縮後的錨定另有三層（見運作原理）。
  - `engine.maxBudgetUsd`：子程序的 `--max-budget-usd`，花到就自己停、`status: budget`，**預設 300**（實測正常任務約 0.5 USD/分鐘，300 ≈ 10 小時；使用者的長任務跑過 115 分鐘≈60 USD）；null 不設。
  - `engine.maxMinutes`：runner 時限（≤10080），超過就殺整棵子程序樹、`status: timeout`，**預設 480**（8 小時）；null 不設。這兩個是無人值守唯一的自動煞車（條件寫錯或永遠達不到時，沒有它們會跑到 quota 用光；實例：一個 16 分鐘 12.62 USD 零產出的 run）。
  - `goal.confirmTimeoutMinutes`：**預設 0＝不等確認，propose 完直接啟動引擎**（使用者隨時可終止）；設 ≥1 則排確認 timer、逾時自動採納。
  - 沒檔就用預設；檔案壞掉、值錯、欄位名打錯會直接報錯不靜默退回。`node "<skill_dir>/goal.js" --show-config` 可看生效值與 wtf 偵測結果。

## 執行步驟

通用流程（propose 怎麼寫、timer 怎麼收斂、引擎契約、兩層時間）在 `../../references/goal-propose-flow.md`，**先讀第 2、3 節**。以下只寫本 skill 的具體動作。

### 1. 取得任務原文
`/goal2:goal <任務>` 的 args。空 → 請使用者補，停止。

### 2. 推導完成條件並 propose
依 references 第 2 節寫出**可測量、有驗證方法、極端**的完成條件。先不要跑。

**極端＝把使用者的意圖翻成等式與全稱，不留放寬空間**：使用者說「把 A 類做完」→ 條件是「A 類未完成數 **= 0**」（不是 `< 0`、`≤ 1`、「大部分」「主要的」）；「測試都過」→「`npm test` exit 0 且失敗數 = 0」；「文件都修」→「每一份（列出清單或列出產生清單的指令）皆…」。**例外條款要寫進條件**：「… = 0；例外清單內的項目不計」，例外由引擎執行時建立，每項必須是真 blocker（需使用者決策／外部系統不可用／缺祕密／與任務書規範衝突）＋證據＋原因，寫進帳本並在最後回報以「例外清單」逐項列出；「太花時間」「不重要」不是例外。回報時把例外清單原文貼給使用者。2026-09-12 實例：使用者要「A 類完成」，propose 出來的判準卻是「A 類未完成數 < 0」，等於永遠不成立／或被解讀成隨便，這種條件不准出現。

### 3. 準備 run 目錄
用 Write 把任務原文寫到**唯一名**暫存檔：`goal-input-<14位時間戳>-<4位隨機>.txt`，放系統暫存目錄（用該機器展開後的絕對路徑）。工具**準備成功後才刪它**；任何驗證失敗（缺 --goal、cwd 不存在、超長）都保留原檔，補參數重跑即可、不必重寫任務書。

**完成條件一律也用檔案傳**：寫到 `goal-cond-<同時間戳>-<隨機>.txt`，用 `--goal-file <path>`（同樣成功後才刪）。條件常含引號、`$`、反引號、Windows 路徑，走 `--goal "<條件>"` 會被 shell 改寫而引擎照錯條件宣告達成；`--goal` 只留給一句話、純文字的條件。

```bash
# <skill_dir> = 本 SKILL.md 所在目錄；--cwd 一律明確帶「專案根目錄的絕對路徑」
node "<skill_dir>/goal.js" --prompt-file <暫存檔> --goal-file <條件檔> --cwd "<專案根目錄>"
```
**`--cwd` 必帶**：子程序在哪個目錄工作就是它。不帶會退回 Bash 工具當下的 cwd，而那個 cwd 會漂移（前一個指令 `cd` 過就留在那），同 session 多個 goal2 時尤其危險。輸出的 `cwd` / `cwd_source` 要一併回報。

輸出 JSON：`{ ok, mode:"prepared", plugin_version, plugin_root, start_mode, run_dir, run_command, stop_command, status_command, cwd, cwd_source, confirm_timeout_minutes, confirm_timer_cron, confirm_timer_target_local, goal_overflow, goal_prompt_length, anchor_path, progress_path, final_prompt, … }`。`ok:false` → 把 error 告訴使用者，停止。

**同一棵工作樹已有活著的 run 時不會擋**（使用者常在同一專案並行多個調整），但 JSON 會多 `active_runs_in_tree`（run id、pid、cwd）。回報「已啟動」時把它一併講出來（例：「注意：同一棵樹還有 2 個 run 在跑：…」），讓使用者知道有並行；不要自作主張停別人的 run。**並行時路徑不重疊不代表沒干擾**：共用的 DB、測試 DB／結果檔、dev server port、`git` 工作樹狀態都會互相污染。有並行時，任務書裡要寫明本 run 的範圍切分（只動哪些目錄／表／port）與「別的 run 可能同時在動什麼」，讓引擎遇到不是自己改的差異時不要去修它。

### 4. 啟動（看 `start_mode`）

**`direct`（預設，`goal.confirmTimeoutMinutes` = 0）**：不排 timer、不等確認。立刻用 Bash、`run_in_background: true` 執行 `<JSON.run_command>`（它會阻塞到引擎結束並印 summary JSON；背景執行不受 Bash 工具 timeout 限制，實測跑 6918 秒仍正常收尾）。**先別急著說「已啟動」**：等 10–15 秒跑一次 `<JSON.status_command>`，看到 `goal_set: true` 才回報「已啟動」（步驟 5）；若 `goal_error` 非 null 或 `status` 已是 `failed`／`spawn_failed`，直接回報失敗原因。引擎被拒收是 0 回合幾秒內就結束的事，先講「正在跑」再收到死亡通知會讓使用者白等。使用者看到條件不對，隨時說「停」就跑 `<JSON.stop_command>`。

**`confirm-timer`（設定檔設 ≥1 分鐘）**：排逾時 timer（prompt 是**文字指令**給未來的你，不是 `/goal`）：
```
CronCreate({ cron: <JSON.confirm_timer_cron>, recurring: false, durable: false,
  prompt: "[goal2 逾時自動採納] 使用者自 propose 後未回覆，視為採納完成條件。請立刻用 Bash（run_in_background: true）執行：<JSON.run_command>，結束後依 goal SKILL 步驟 5 回報。" })
```
**記下 timer 的 job id**，回報「已準備」並說明「`confirm_timeout_minutes` 分鐘內未回覆將於 `confirm_timer_target_local` 自動啟動」。收斂：同意 → `CronDelete` 後背景執行 `run_command`；要改條件 → `CronDelete` → 重寫暫存檔 → 重跑步驟 3；取消 → `CronDelete`；逾時 → timer fire 照指令執行。

### 4b. 進行中：終止與看進度
- 使用者說「停」「終止」「取消」→ **先看有幾個活著的 run**：本對話只起過一個就直接跑 `<JSON.stop_command>`；本對話起過多個、或 `--list` 顯示同棵樹有多個 `alive_state: alive` 的 run，就列出各 run 的 `condition` 摘要與 run id 問「停哪一個」（這是消歧問題，不是步驟 5 禁止的結尾 offer）。`--stop` 會先核對 pid 身分再 `taskkill /T`／kill 群組、meta 標 `stopped`，帳本與 stream.jsonl 保留；JSON 有 `killed`、`alive_state`。`alive_state: stale`（pid 被別的程序重用）→ 只收狀態、沒殺東西，如實講；`unknown` → 工具拒絕動手：先再跑一次 `--status`（每次都會重探身分，PowerShell 慢半拍時第二次通常就明朗），仍不明就請使用者手動確認引擎已不在（工作管理員找 claude.exe），確認後跑 `--stop <run_dir> --force`（只把狀態收成 stopped、不殺任何程序；pid 仍是活著的 claude 時會拒絕）。**同一個 run 目錄 `--run` 只准一次**：重跑會被拒（`reentry_refused`），要重做就重新準備。背景中的 `run_command` 會自己收尾並印出 `stopped: true` 的 summary。**殺不到的東西**：引擎內用 `&`／`nohup` 起、已脫離父子鏈的 dev server、watch 程序不在這棵樹上，`--stop` 後提醒使用者檢查 port。
- 使用者問「做到哪」「進度」「還在跑嗎」→ 跑 `<JSON.status_command>`（不阻塞）。**回報要講人話，不准把 JSON 欄位丟給使用者**：第一句直接用 `summary_zh`（工具已組好：狀態＋回合數＋擋停次數＋壓縮次數＋最後一個動作＋最後一句），接著貼 `progress_md` 的「已完成」與「剩餘」兩節原文。欄位對照（要解釋時用）：

  | 欄位 | 白話 |
  |---|---|
  | `status` | `prepared` 還沒啟動／`running` 進行中／`done` 檢查器確認達成／`unverified` 正常結束但**沒有任何達成判定，不可當作達成**／`impossible` 檢查器判條件不可能達成而放行／`failed` 引擎拒收或異常結束／`stopped` 被終止／`timeout` 超過 `engine.maxMinutes`／`budget` 花費達 `engine.maxBudgetUsd` 引擎自停、未達成／`unknown` stream 被刪無從判定／`spawn_failed` 起不來（含找不到 claude） |
  | `alive` / `alive_state` | 子程序此刻在不在：`alive` 在且身分對得上／`dead` 不在／`stale` pid 在但已是別的程序（引擎早已不在）／`unknown` 探測不到 |
  | `goal_verdict` | 結束後才有：`met`／`impossible`／`unverified`／`no_transcript`，來源是子程序 transcript 的檢查器紀錄，這才是「達成沒」的依據 |
  | `num_turns` | 引擎總回合數（結束後才有）；進行中看 `assistant_messages`（目前幾則回覆） |
  | `continuations` | 引擎的檢查器擋停、要求繼續的次數；0 表示還沒被打回過 |
  | `compactions` / `anchor_injections` | 上下文壓縮次數／壓縮後錨定注回次數（兩者應相等） |
  | `last_tool` / `last_text` | 引擎最後一個工具動作／最後一句話（它此刻在做什麼） |
  | `last_event_at` | 最後一個事件的時間，久沒動就可疑 |

### 5. 回報使用者

**已啟動（direct）**：完成條件全文、run_dir、終止方式（說「停」即可，對應 `stop_command`）。
**已準備（confirm-timer）**：完成條件全文、timer job id 與自動啟動時間、run_dir、取消方式（`CronDelete <id>`）。

**引擎結束後**（背景指令結束會收到通知，讀它印的 JSON）：必含
- 達成與否：看 **`status` 與 `goal_verdict`**，不要只看 `goal_achieved`（它現在等於 `status === "done"`，而 done 的唯一來源是子程序 transcript 最後一筆 `goal_status.met === true`）。`unverified` 要明講「引擎正常結束但檢查器沒留下達成判定，不可當作達成，請看 result_text 與帳本核對」（2026-09-12 run 55a0 就是這樣：130 回合、12.62 USD、報告檔根本不存在，舊版卻回報達成）；`impossible` 講「檢查器判條件不可能達成」；`timeout` 講「超過時限被終止」；`budget` 講「花費達 N USD 引擎自停、未達成，實花 M USD；要續做重新準備（可調高 `engine.maxBudgetUsd`）」；`unknown` 講「stream 被刪，看 `child_transcript`」。`goal_set` 為 false 代表引擎根本沒設目標，這是異常，要講。
- 回合數 `num_turns`、被推回去續行的次數 `continuations`、上下文壓縮次數 `compactions` 與壓縮後錨定注回次數 `anchor_injections`（壓縮發生但注回 0 次是異常，要講）、耗時、`total_cost_usd`
- `result_text`：引擎最後一則回覆（做了什麼／怎麼驗證／未完成項），**原文保留不摘要**
- `run_dir`（要追查看 `stream.jsonl`；`progress_path` 是進度帳本，長任務中途想知道做到哪就讀它）
- `stopped: true` → 是被終止的，講清楚終止時做到哪（讀 `progress_path`）
- `permission_denials` 非 0 或 `ok:false` → 原文列出，說明可能要調 `engine.permissionMode`
- `terminal_reason` 不是 `completed` → 原文列出並解釋。已知：`rapid_refill_breaker`＝Claude Code 判定壓縮空轉（壓縮後 3 回合內又滿、連續 3 次）主動終止，通常是單次工具輸出太大或 `engine.autocompact` 設太小；`result_text` 會是引擎的英文說明，一併原文貼出

**回報格式——本機有 wtf plugin 時套它的重講紀律**（使用者已明確授權本 skill 在此步套用；wtf 本身是 `disable-model-invocation: true`，**不要**用 Skill 工具去呼叫它，也不要跑它的問寬度流程）：
1. JSON 的 `wtf.installed` 為 true → **不必讀整份 `wtf.skill_md`**（41KB，每次回報都讀是浪費），照這六條寫：先一句脈絡、一句話一件事、關係一律畫 ASCII 表格或箭頭圖、砍鋪陳與重複、事實一件不能少、證據原文逐字保留；寬度上限用 `wtf.terminal_width`（null 就用 80，不要問）。**優先序**：wtf 只管版面；「事實一件不能少、證據原文逐字保留、上面的必含欄位」是本 skill 的規則，兩者衝突時本 skill 贏（wtf 的「不為了完整而全部攤開」不適用於引擎結果）。
2. `wtf.installed` 為 false → 用上面的必含欄位以列點回報，**結尾固定加一行**（這是唯一允許的附註，不算 offer）：`回報格式想更精簡（一句一事、關係畫表、寬度貼合你的視窗）→ 裝 wtf plugin：/plugin install wtf@fulin-plugins，之後 goal 的回報會自動套用。`

**不發 LINE**（本 skill 沒有 LINE 收尾）。**嚴禁**在回報結尾追加任何提問或 offer。

## 運作原理（why）

- **子程序而非本 session**：本 session 的對話會被引擎佔用直到達成；子程序讓你在本對話保持可對話，且引擎的完整事件流留在 `stream.jsonl` 可追查。代價是子程序看不到本對話的上下文，所以任務原文與完成條件必須自足。
- **為什麼預設直接啟動、不等確認**：條件已經印給使用者看了，等確認只是多一段空轉；有 `--stop` 可隨時終止，錯了就停再改，比每次都等更省。要保守就把 `goal.confirmTimeoutMinutes` 設成 ≥1。
- **為什麼 timer 的 prompt 是文字指令**：它 fire 進來就是普通回合，你照指令起子程序即可；放 `/goal` 反而沒用。
- **`stopHookBlockCap` 預設 0**：官方引擎預設連續 8 次擋停就放棄；無人值守要的是做到達成，所以關掉上限（CLI 程式碼 `cap ?? 8`，`cap > 0` 才生效，0 就是不設限）。真正的煞車是 `engine.maxBudgetUsd`／`engine.maxMinutes`。
- **達成判定的來源（0.4.0 起）**：`claude -p` 的 stream-json 裡**沒有**檢查器的判定；它只寫在子程序自己的 transcript（`~/.claude/projects/<cwd 編碼>/<child_session_id>.jsonl`）的 `attachment.type === "goal_status"`：Goal set 當下一筆 `sentinel:true`，之後每次 Stop 檢查一筆 `met:true/false`，判「不可能」時 `failed:true`。engine.js 結束時去讀最後一筆決定 `goal_verdict`／`status`。舊版用「exit 0 且 subtype success」推定達成，會把「檢查器根本沒跑就 end_turn」的 run 記成 done（實例 55a0）。實測（2026-09-12）：條件寫「Z 槽下某檔存在」→ 檢查器擋 2 次、引擎跑去 `subst` 造出 Z 槽達成（所以 bypassPermissions 下它會為了達成改系統狀態，條件要寫清楚不准動什麼）；條件註明「不可能達成」→ 檢查器 `failed:true` 放行、0 次擋停。
- **主 Claude Code 關掉後引擎會不會繼續跑：未實測（HYPOTHESIS）**。已知的是：殺 runner（node）引擎會跟著死（實測）；本對話結束、只要 runner 還在，引擎就繼續。使用者要走人前想確認有沒有東西在跑就 `--list`；能停它的只有 `--stop`、`maxMinutes`、`maxBudgetUsd`。
- **成本**：每次 run 是一個獨立 session，任務再小也有固定開銷（實測極簡任務約 0.8 USD）；要省就設 `engine.model`。
- **壓縮空轉熔斷（實測）**：`engine.autocompact` 設 100000 且每回合灌 25KB 工具輸出時，Claude Code 在第 3 次壓縮後以 `rapid_refill_breaker` 終止（「Autocompact is thrashing」）。這是引擎的保護，不是漂移；錨定在那三次壓縮都正常注回、沒有重做。對策：不要把 autocompact 調太小、任務裡讀大檔要分小塊、必要時提高 autocompact。
- **4000 字元上限算的是整段 prompt，不只第一行**（2026-09-12 實測：第一行 156 字、整段 6368 字 → `Goal condition is limited to 4000 characters (got 6361)`，0 回合 0 成本就退；使用者實際踩到 got 12511）。所以 `/goal` prompt 只放條件＋一句指向錨定區，任務全文、工作清單、帳本規則全走 anchor.md 的系統提示；`lib/goal-head.js` 與 `engine.js` 對整段 prompt 做 ≤3900 硬檢查，超過直接報錯不上車。條件本身超長 → 第一行換指針句、全文放 anchor「完成條件全文」，並要求引擎第一則回覆先把它貼進對話（檢查器在對話裡看得到）。summary 若出現 `goal_error` 就是引擎拒收，`ok:false`、`goal_set:false`。
- **長任務防漂移（上下文壓縮後不忘目標）**，三層缺一不可：
  1. `anchor.md`（完成條件＋任務全文＋帳本規則）用 `--append-system-prompt-file` 放進子程序的**系統提示**——系統提示每回合重送，壓縮只動對話紀錄，碰不到它。
  2. `progress.md` 進度帳本：引擎 prompt 規定開工先拆里程碑寫進「剩餘」、每完成一項就搬到「已完成」附證據；壓縮後或不確定時先讀 anchor 與帳本再動手。
  3. `hooks/compact-anchor.js`：engine.js 用 `--settings` **只對這個子程序**掛 SessionStart（matcher `compact`）hook，壓縮一結束就把「完成條件那一節＋帳本＋任務書外置檔路徑」以 additionalContext 注回（不重送整份 anchor——它本來就還在系統提示裡），並在 run 目錄記 `compact-log.txt`。`source !== "compact"`、沒有 `GOAL2_RUN_DIR`、任何錯誤一律靜默放行。
  **任務書外置時**（使用者常把 10–20KB 任務書放在某個 .md，anchor 只寫「先讀那個檔」）：壓縮後最容易丟的就是那份檔的細節，hook 會把錨定區「任務全文」提到的檔案路徑列出來要求重讀；任務書裡的禁令／規範若非常重要，仍建議直接貼進任務原文，讓它進系統提示。
  另外引擎自己的完成條件存在 app state（不在對話裡），壓縮不影響驗收，所以就算敘事漂了，做不到條件也停不下來。

## Non-goals
不發 LINE、不算 quota、沒有 plain 模式、不在本 session 內跑引擎。

## 注意
- 只用 CronCreate 排逾時 timer，不可用 SQL 偽造；`CronList` 可查。
- cron 到點時你正在打字或 Claude 正在跑：排程器只在 REPL idle 時 fire，會等下一個空檔，不會漏掉（依 CronCreate 工具說明）。
- 背景執行的 `run_command` 結束才會通知；引擎跑很久是正常的。要中途停一律用 `--stop`（會殺整棵樹、把狀態收好）。**不要只 TaskStop 那個背景指令**：實測殺掉 runner 時引擎子程序會一起死（Windows 同 job），但 meta 停在 `running`、沒有 result.json，之後只能靠 `--stop` 收狀態、結果只剩 `child_transcript`。
- **`~/.claude/goal2/runs/` 是全機共用、跨 session 的。禁止用 rm／rmSync 整批清它**——別的 session 可能正有 run 在跑，刪了它的 run 目錄會讓那個引擎的帳本、stream、summary 全部消失（2026-09-12 實際發生）。要清一律 `goal.js --prune`（只清已結束且程序不在的），想先看會刪什麼加 `--dry-run`。
- 幫使用者查「現在有哪些在跑」用 `--list`（看 `alive_state`，`stale` 代表 pid 已被別的程序重用、引擎早就不在）。
- `status: running` 但 `alive_state: dead/stale` 的 run 是 runner 被殺、關機留下的殘骸，不會自己變 done：用 `--stop` 收掉狀態（不會殺到別人），結果看 `child_transcript`。
- 安裝版本（`plugin_version`／`plugin_root`）與 repo 工作樹不一致時，以安裝版的行為為準，先升級再套本文件描述的流程。
