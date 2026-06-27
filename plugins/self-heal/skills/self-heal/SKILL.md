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
**怎麼起**：用當前環境可用的排程/喚醒工具（如 `ScheduleWakeup`，部分環境為 `CronCreate`；先確認可用再用，不寫死）設一個短延遲喚醒（建議 ~240s，落在 prompt 快取窗內；若工具僅支援分鐘粒度 cron，取最接近的一次性排程），喚醒 prompt 寫明：
- 「檢查 <這項作業> 進度」
- 「若上一個動作 malformed/未完成 → 重發」
- 「若全部完成 → 不再續設 scheduler，直接結束」

**喚醒時的判斷（核心循環）**：
1. 作業**未完成且卡住** → 重發上一個失敗的工具呼叫，並續設下一個 scheduler。**但設重試上限**：同一個失敗點連續重試 ≥3 次仍 malformed → **停止續設、把問題交還使用者**（說明卡在哪、試過什麼），不可無限續設燒 quota。
2. 作業**進行中但正常** → 繼續做，續設下一個 scheduler。
3. 作業**已完成**（目標達成、驗證過）→ **不再續設**，自然終止。

### 降低失敗的操作守則

> 注意：以下守則與 scheduler 同屬「寫給模型看、靠自願遵守」的 best-effort 規約，非程式強制。plugin 真正程式強制的只有 hook 那層的事前提醒。
- 改含 JSX/HTML（含 `<` `>` 角括號）的檔 → **優先用 Node 腳本做字串替換**（Write 一個 .mjs，readFileSync→replace→writeFileSync），避開工具 XML 的角括號衝突。這是失敗最集中的地方。
- 長參數工具（AskUserQuestion、Agent prompt）→ 把長內容先 Write 成檔，工具參數只引用檔路徑，縮短易錯的 inline 內容。
- Write 與後續 Bash 分開不同訊息送，避免一個失敗連帶。

## 範例：起 self-heal scheduler
作業：「修 5 個檔的亮色對比，逐個 build 驗證」。開工時：
- 用可用的排程工具設 ~240s 喚醒，prompt 例：「檢查亮色對比修正進度：已改X/5。若上個動作 malformed→重發；若進行中→接著改下一個並續設；若 5 個都改完+build 過→不再續設，結束。」（工具名依環境：ScheduleWakeup 或 CronCreate，用前先確認存在）
- 每次喚醒按上述三條判斷走。完成即終止，不留殘留排程。
