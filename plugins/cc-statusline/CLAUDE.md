# cc-statusline：資料蒐集的底層

**cc-statusline 負責蒐集資料；匯總可以由它做，也可以各 plugin 自己做。** 完整規則、公開介面清單、還沒搬的地方：`docs/data-boundary.md`。改這個資料夾之前先讀。

- 額度、token、花費、context 用量、對話活動，只有這裡可以碰原始來源（對話紀錄的 usage、Claude Code 的額度查詢、hook 收到的內容）。
- 別的 plugin 要新的數字：先在 `docs/data-boundary.md` 的公開介面加一列，再改這裡，不要讓對方自己先算。
- 公開介面的欄位只加不改；非改不可時 `v` 加一，並先通知所有使用方（列在該檔）。
- 沒有終端機也要收得到（看板的對話、`claude -p`）：用 hook 收，不可以只靠狀態列渲染。
- 改完跑 `node hooks/tests/data-boundary.test.js` 和 `hooks/tests/` 其餘測試；Windows 與 macOS 都要對。
