# self-heal

**少看到 Claude 工具呼叫卡在半路、少自己打「繼續」——把 tool call 失敗事前降低，無人值守時卡住還能自己接力。**

降低並自動接力 tool call 失敗。

## 它解決什麼

模型偶爾輸出未收尾的 `<invoke>`/`<parameter>` 標籤 → 解析層退回 malformed，使用者得反覆催「繼續」。

**關鍵限制（誠實說在前面）**：malformed 在解析層就掛、形不成有效 tool call，所以 **PostToolUse/Stop hook 都觸發不到**——沒有「自動偵測 malformed 並修復」的技術手段。本 plugin 做的是能做到的兩層：

1. **事前降低**（hook，自動生效）：每輪 UserPromptSubmit 注入 XML 收尾提醒。這層是程式強制的。
2. **卡住接力**（skill，行為規約，best-effort）：作業中起 self-heal scheduler，喚醒時卡住就重發、完成則終止。**這層靠模型自願照 skill 執行，非程式強制**，效果是 best-effort，不是保證。
   - **接力鏈不斷的關鍵**：收到喚醒時，**第一個動作永遠是「續設下一棒 scheduler」**，且 prompt 用固定通用短語「請確認工作是否完成，若未完成請繼續完成。」——**不塞任務細節**（塞長說明進 prompt 是續設自己 malformed 的主因；進度從脈絡讀）。再做正事，正事 malformed 也不斷鏈。
   - **換工具通道**：同一指令在同一工具連兩次 malformed → 換通道（Bash↔PowerShell、Edit↔Node 腳本）。實戰常一次就過。

## 前置需求

- **Node.js 需在 PATH**（hook 用 `node` 執行）。若用 nvm/volta 等版本管理器且未設全域，hook 每輪會失敗——請確認 `node` 全域可用。

## 組成

| 檔 | 作用 |
|---|---|
| `hooks/xml-reminder.js` + `hooks.json` | UserPromptSubmit 注入收尾提醒 |
| `skills/self-heal/SKILL.md` | self-heal scheduler 接力規約 |

## 已知限制

- **hook 已實測生效**：啟用 + 重啟後，UserPromptSubmit hook 確實每輪注入 XML 收尾提醒（已在實戰 session 觀察到 reminder 內容注入）。
- **第②層救不了「對話中即時連環 malformed」**：scheduler 的價值在「無人值守卡死時自己接力」；若使用者正盯著看的連環 malformed，主要靠第①層 hook + 操作守則事前降低，scheduler 是兜底不是主力。最關鍵的操作守則（SKILL 列為**第一鐵律**）：**一則訊息只送一個工具呼叫**——實戰最常見的爆法是「一則塞 ≥2 個工具呼叫」，任一標籤沒收尾就整批 malformed；要連做多件事就拆成多則逐一發。其餘守則：長參數用檔案引用、含角括號的檔優先用 Node 腳本改、同工具連 2 次 malformed 換通道。
- **scheduler 接力有重試上限**：同一失敗點連續重試 ≥3 次仍 malformed 會停止續設、交還使用者，避免無限續設燒 quota。

## 安裝後注意

- 若你先前在 user scope（`~/.claude/settings.json`）自行加過 xml-reminder hook，**啟用本 plugin 後請移除那一份**，否則提醒會雙重注入。
- 啟用：`/plugin install self-heal@fulin-plugins`，重啟 session 後 hook 生效。
