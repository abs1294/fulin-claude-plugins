# plugins 共同規則

**cc-statusline 負責蒐集資料；匯總可以由它做，也可以各 plugin 自己做。** 完整規則與公開介面清單：`cc-statusline/docs/data-boundary.md`。

要用額度、token、花費、context 用量、對話活動（訊息數、壓縮、子代理、skill、MCP、改過的檔）時：

- 先讀那份，只讀它列的公開介面；不可以自己讀對話紀錄的 usage、自己計價、自己查額度。
- 缺欄位就去改 cc-statusline，不要在自己這邊先算一份。
- 改完跑 `node plugins/cc-statusline/hooks/tests/data-boundary.test.js`（在 repo 根目錄），沒登記就碰原始用量資料會失敗。
