# review-collect.js 在來源專案實例的 8 處誤判（2026-10-13 健檢回報）

來源：`/harness:review` 0.18.0 在 來源專案工作區（自行演進的實例，19 支 hook 與範本不同）跑一次，收集腳本的數字逐項回原文核對後的落差。鐵則 1 要求「數字由腳本抽、模型只判讀」，下面每一項都是腳本抽出來的數字不能直接採信的情況；判讀時已人工剔除，這裡只記給 plugin 改。

| # | 面向 | 腳本給的 | 回原文後 | 原因 | 建議 |
|---|---|---|---|---|---|
| 1 | C denials 標籤 | 40 筆歸「不是本專案 hook」 | 全是本專案 hook 擋的 | 標籤表不認 `[sediment-sweep]`、`[qa-before-commit]`、`[服務啟動守門]`、`[skill-gate:*]`（實例自己長出的閘） | 標籤改從實例 `.claude/hooks/*.js` 的 deny 訊息開頭 `[…]` 動態收集，或至少把 settings.json 接線的每支 hook 檔名都當本專案 hook |
| 2 | E 沉澱回答 | 0 | 14 session 共 57 行 `--sediment 詞= 鏈= QA= 代號=` | 腳本只認 Stop hook 的問答形式；本實例是 `guard-sediment-sweep.js` 在 Skill(git-commit) 的 args 表態制 | 另認 Skill tool_input.args 內的 `--sediment` 表態 |
| 3 | G 糾正偵測 | 24 筆 | 真糾正 4 筆（`311a0dac…:3522`、`3cfbb7ba…:1824`、`9bc758b2…:217`、`a2eef0be…:5970`） | 命中壓縮摘要（summary 列）與子 agent 回報文字 | 只掃 `type=user` 且非 tool_result、非 compact summary 的列 |
| 4 | F secretsInCommands | 38 處 | 真值 9 處（7 處 sqlcmd 測試庫帳密、2 處 localhost Bearer） | 命中 grep 樣式（`grep -P`）、程式碼片段裡的 `password` 字樣、hook 原始碼 | 排除 grep/rg/sed 的 pattern 參數與 `.js`／`.py` 檔內容；要求值是 token 形狀（長度、字元類）才算 |
| 5 | D 必讀 | 344 筆「少讀 CONTEXT.md」 | 不成立 | root CLAUDE.md 以 `@CONTEXT.md` 匯入，子 agent 開頭自動載入，不會出現 Read | 解析 CLAUDE.md 的 `@<檔>` 匯入，匯入的檔標「自動載入」（與 CLAUDE.md 同處理） |
| 6 | B firstDispatchAligned | 7 個 session 未對齊 | 真未對齊 1 個（`6deaccfe…:226`）；3 個 prompt 內寫「【開工前對齊】無分岔」，3 個是 codex-rescue 非專案 agent | 只認使用者文字或 AskUserQuestion，不認派工 prompt 內的對齊表態；非專案 agent 也算首次派工 | 派工 prompt 命中 `對齊回合|無分岔|已對齊|分流例外` 也算對齊；首次派工只算專案 agent |
| 7 | C denials 出處 | `9bc758b2:75` | 實為 `:73`（`git stash push … rebase -i`，擋下正確） | deny 訊息（:75）對到「下一行工具」（:74）而不是被擋的那次 tool_use | 以 tool_result 的 `tool_use_id` 反查對應的 tool_use 列 |
| 8 | D reportsWithoutReadList | 57 筆（qa 43 筆） | 多數是補交訊息 | 只看子 agent 最後一則 SendMessage；qa-engineer 常在主回報之後再補一則短訊息 | 掃該 agent 全部 SendMessage，任一則含已讀清單即算有 |

附帶：`H.progressDate` 為 null 是因為本實例 §0 沒有進度敘述欄位（只有整理日期）；`installDate` 為 null 是因為本實例沒有 `CLAUDE.changelog.md` 的「建立」筆。兩者都不是 bug，但報告判讀時要寫清楚「沒有資料」而不是「0」。
