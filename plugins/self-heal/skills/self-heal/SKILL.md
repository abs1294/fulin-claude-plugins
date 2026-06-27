---
name: self-heal
description: 降低並自動接力 tool call 失敗。觸發詞：「tool call 一直失敗」「工具呼叫失敗」「malformed」「自救機制」「self-heal」「卡住自己續」「起 scheduler 接力」「別讓我一直催繼續」；或一段需多步工具操作的作業開始時。建立 self-heal scheduler 接力循環。註：scheduler 與操作守則皆為行為規約、非程式強制，效果 best-effort（唯一程式強制的是 hook 那層的事前提醒）。
---

# Self-Heal：tool call 失敗的降低與自動接力

## 問題
模型偶爾輸出未收尾的 `<invoke>`/`<parameter>` 標籤 → 解析層退回 malformed。
**關鍵限制**：malformed 在解析層就掛、形不成有效 tool call → PostToolUse/Stop hook 都觸發不到。
所以沒有「自動偵測 malformed 並修復」的 hook 機制。能做的只有兩層：①事前降低機率 ②卡住後自動接力。

## 兩層機制

### 第 1 層：事前提醒（本 plugin 的 hook，自動生效）
`hooks/xml-reminder.js` 在每次 UserPromptSubmit 注入 XML 收尾提醒。裝了就生效，無需動作。

### 第 2 層：self-heal scheduler 接力（行為規約，需主動執行）
**何時起**：開始一段「需要多步工具操作、可能中途 malformed 中斷」的作業時。
**怎麼起**：用當前環境可用的排程/喚醒工具（如 `ScheduleWakeup`，部分環境為 `CronCreate`；先確認可用再用，不寫死）設一個短延遲喚醒（建議 ~240s，落在 prompt 快取窗內；若工具僅支援分鐘粒度 cron，取最接近的一次性排程）。

**喚醒 prompt 用「固定通用短語」，不要塞任務細節**——這是 malformed 高發點：把整段任務說明（含中文、箭頭、括號）塞進 prompt 參數，續設那一棒自己就會 malformed，鏈當場斷。喚醒時當前作業是什麼，從對話脈絡 / task list 自己讀得到，不必寫進 prompt。建議固定句：

> 「請確認工作是否完成，若未完成請繼續完成。」

就這一句，永遠不變、永遠不會 malformed。任務細節、重試上限、換通道規則，喚醒後依本 SKILL 的核心循環判斷即可。

**喚醒時的判斷（核心循環）**：

> **鐵律：收到喚醒，第一個 tool call 永遠是「續設下一個 scheduler」——prompt 用固定通用短語「請確認工作是否完成，若未完成請繼續完成。」，絕不塞任務細節**，先把下一棒接力保證住，再去做正事。（塞長任務說明進 prompt 是續設自己 malformed 的主因——任務細節從對話脈絡讀，不寫進 prompt。）
> 為什麼：若先做正事、正事 malformed、還沒續設下一棒 → 接力鏈當場斷掉，使用者又得催。把「續設」提到正事之前、且做成最短（malformed 機率趨近 0），鏈就斷不了——正事再怎麼死，下一棒已設好會再喚醒重試。
> 唯一不續設的情況：正事已**確認完成**（順序 3），或已達重試上限（順序 1 的上限）。

**續設用的標準 tool call 範本（照抄，別自己組）**——把下面整段複製、只改 delaySeconds 數字，其餘原樣（標籤已收尾、prompt 是固定句，照抄就不會 malformed）：

```
ScheduleWakeup(
  delaySeconds = 240,
  reason = "self-heal 接力",
  prompt = "請確認工作是否完成，若未完成請繼續完成。"
)
```

對應的實際 XML 形式（不同環境工具名可能是 ScheduleWakeup 或 CronCreate，先確認可用）：開 `invoke name="ScheduleWakeup"`，三個 `parameter`：`delaySeconds`（數字）、`reason`（短字串）、`prompt`（固定句「請確認工作是否完成，若未完成請繼續完成。」），每個 parameter 與 invoke 都確實收尾。**reason 與 prompt 都別塞任務細節**，照抄此範本即可。

每次喚醒依序：
0. **極簡先判**：正事是否「明顯已完成」或「已達重試上限」？是 → 跳過續設、直接終止/交還（不繞「先設再取消」）。這步只做一眼可判的，別做會 malformed 的重活。
1. 否則 **先續設下一個 scheduler**（最短指令、優先於正事）。**重試上限**：同一個失敗點連續重試 ≥3 次仍 malformed → **這次就不續設、把問題交還使用者**（說明卡在哪、試過什麼），不可無限續設燒 quota。
2. **再判斷正事狀態**：
   - **未完成且卡住** → 重發上一個失敗的工具呼叫（**若同一工具已連續 malformed ≥2 次 → 換工具通道**，見操作守則）。
   - **進行中但正常** → 接著做下一步。
   - **已完成**（目標達成、驗證過）→ 回頭把第 1 步剛設的 scheduler **取消/不再續**，自然終止（完成才終止，不是「做完正事就忘了關接力」）。

### 先分診：malformed 是哪一種？（對症才有效）

| 症狀 | 根因 | 對策 |
|---|---|---|
| **一啟動就壞** | settings.json 格式錯（多餘逗號/括號） | 先 `node -e "JSON.parse(require('fs').readFileSync('~/.claude/settings.json','utf8'))"` 驗合法；壞了先修 config，別怪模型 |
| **跑到一半才壞、且集中在改某種檔** | 工具參數含 `<` `>` 角括號 / 長參數 → XML 解析衝突 | 走下方操作守則（換通道、Node 腳本替換、縮短參數）。**最常見、本 plugin 主攻這種** |
| **長時間跑很多輪後越來越頻繁** | 長 context / 快取稀釋注意力 | 操作守則仍有效；若已嚴重到無法工作 → `/clear` 開新 session 卸掉 context |
| **換版本後突然狂壞** | 特定 Claude Code 版本的 rendering bug | 最後手段：降到上一個穩定版。先排除前三種再考慮 |

> 多數「跑到一半」的 malformed 是第二種（角括號/長參數），下方操作守則就是對它的解。先分診、別所有情況都用同一招。

### 降低失敗的操作守則

> 注意：以下守則與 scheduler 同屬「寫給模型看、靠自願遵守」的 best-effort 規約，非程式強制。plugin 真正程式強制的只有 hook 那層的事前提醒。
- **換工具通道（實戰最有效）**：同一個指令/動作在**同一工具連續 malformed ≥2 次 → 立刻換另一個工具通道重試，別在同一通道死撞**。malformed 常不是內容錯、而是特定工具的 XML 解析對某些字串（長路徑、中文、角括號）敏感——換通道往往一次就過。對應：
  - 跑指令：`Bash` ↔ `PowerShell` 互換（實測：長路徑 `node "C:/.../x.js"` 在 Bash 反覆 malformed，換 PowerShell 一次過）。
  - 改檔：`Edit`/`Write` ↔ Node 腳本字串替換 互換。
- 改含 JSX/HTML（含 `<` `>` 角括號）的檔 → **優先用 Node 腳本做字串替換**（Write 一個 .mjs，readFileSync→replace→writeFileSync），避開工具 XML 的角括號衝突。這是失敗最集中的地方。
- 長參數工具（AskUserQuestion、Agent prompt、commit message）→ 把長內容先 Write 成檔、工具參數只引用檔路徑；commit 用短單行 message、細節進 CHANGELOG。縮短易錯的 inline 內容。
- Write 與後續 Bash 分開不同訊息送，避免一個失敗連帶。

## 範例：起 self-heal scheduler
作業：「修 5 個檔的亮色對比，逐個 build 驗證」。開工時：
- 用可用的排程工具設 ~240s 喚醒，prompt 就用固定句：「請確認工作是否完成，若未完成請繼續完成。」（不要寫「已改 X/5」這種任務細節進 prompt——那會讓續設自己 malformed。進度從 task list / 對話脈絡讀。）
- 每次喚醒：**第一個 tool call 先續設下一棒**（同上固定句，保證接力鏈不斷），再按核心循環三條判斷走（卡住重發、同工具連兩次 malformed 換通道、完成則取消接力）。完成即終止，不留殘留排程。
