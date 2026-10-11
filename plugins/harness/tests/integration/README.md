# 壓縮交接範本的整合測試

| 腳本 | 測什麼 |
|---|---|
| `compact_chain_test.js` | snapshot → summary-log → reinject 整條鏈實際寫出的檔與輸出（加 `--real` 會真的呼叫一次 `claude -p`，要花錢） |
| `compact_v031_test.js` | 0.3.1 新增：關鍵值抽取、先截「已完成」節、missingInHandoff、resume 過期提醒 |
| `compact_final_test.js` | 實例定版新增：三種背景任務與完成判定、防污染、HTTP status 抽取、短值比對等 |
| `compact_decisions_test.js` | 「使用者已裁決」與「任務清單最後狀態」：抽取規則、跨兩次壓縮、拒答／逾時不收、reinject 兩條路徑原樣注入與字數上限、任務清單來源與標頭 |

`tests/run.js` 會依序跑這 4 支（不帶 `--real`）。單獨跑（在任何目錄都可以）：

```
node plugins/harness/tests/integration/compact_chain_test.js
node plugins/harness/tests/integration/compact_v031_test.js
node plugins/harness/tests/integration/compact_final_test.js
node plugins/harness/tests/integration/compact_decisions_test.js
```

預設測 `plugins/harness/hooks/templates/`。要拿舊版當對照組，設 `TPL_DIR` 指到舊版範本目錄，
對照組有失敗才代表測試抓得到這次的改動。
