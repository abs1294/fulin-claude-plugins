# self-heal

降低並自動接力 tool call 失敗。

## 它解決什麼

模型偶爾輸出未收尾的 `<invoke>`/`<parameter>` 標籤 → 解析層退回 malformed，使用者得反覆催「繼續」。

**關鍵限制（誠實說在前面）**：malformed 在解析層就掛、形不成有效 tool call，所以 **PostToolUse/Stop hook 都觸發不到**——沒有「自動偵測 malformed 並修復」的技術手段。本 plugin 做的是能做到的兩層：

1. **事前降低**（hook，自動生效）：每輪 UserPromptSubmit 注入 XML 收尾提醒。這層是程式強制的。
2. **卡住接力**（skill，行為規約，best-effort）：作業中起 self-heal scheduler，喚醒時卡住就重發、完成則終止。**這層靠模型自願照 skill 執行，非程式強制**，效果是 best-effort，不是保證。

## 前置需求

- **Node.js 需在 PATH**（hook 用 `node` 執行）。若用 nvm/volta 等版本管理器且未設全域，hook 每輪會失敗——請確認 `node` 全域可用。

## 組成

| 檔 | 作用 |
|---|---|
| `hooks/xml-reminder.js` + `hooks.json` | UserPromptSubmit 注入收尾提醒 |
| `skills/self-heal/SKILL.md` | self-heal scheduler 接力規約 |

## 已知限制

- **hook 端到端尚未實測**：已驗證 `node xml-reminder.js` 腳本本身有正確輸出，但「plugin 啟用後 UserPromptSubmit hook 真的被 Claude Code 觸發並注入上下文」這條端到端路徑，需在啟用+重啟後實際觀察才能確認。
- **scheduler 接力有重試上限**：同一失敗點連續重試 ≥3 次仍 malformed 會停止續設、交還使用者，避免無限續設燒 quota。

## 安裝後注意

- 若你先前在 user scope（`~/.claude/settings.json`）自行加過 xml-reminder hook，**啟用本 plugin 後請移除那一份**，否則提醒會雙重注入。
- 啟用：`/plugin install self-heal@fulin-plugins`，重啟 session 後 hook 生效。
