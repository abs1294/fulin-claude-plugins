# 上線前健檢：本專案的服務與起法（tests/Project_Detail/SMOKE.md）

> 機器讀的欄位在同目錄 `SMOKE.json`；本檔寫給人與 AI 看：每個服務怎麼起、為什麼這樣起、踩過哪些坑。
> 改了起法先改 `SMOKE.json`，再跑 `qa-flow.sh smoke-try <服務名>` 重新驗證（驗證後改過設定，preflight 會拒絕代起）。

## 服務清單

| 服務 | port／scheme | 啟動指令出處 | 健康檢查 |
|------|--------------|--------------|----------|
| backend | 8080／https | `backend/README.md`「本機啟動」 | `/swagger` 回 200 |
| frontend | 5173／https | `frontend/package.json` 的 dev script | 首頁回 200 |

啟動順序：先後端、後前端（`order`）。

## 起服務的坑（本專案實際踩過的才寫）

- 例：後端用 `--no-launch-profile` 起，環境名要在 `start.env` 明帶，否則會以 Production 跑。
- 例：前端繞過 npm script 直接呼叫 vite 時，`--mode` 一定要帶，否則讀不到環境檔、API base URL 變空。
- 例：前端的 API base URL 預設指向遠端環境，本機健檢要在 `start.env` 覆寫，並用 `post_start_checks` 的 `log_absent` 確認沒有指到遠端。

## 手動 TC

自動套件還沒涵蓋的案例在 `SMOKE-manual.md`；跑穩了就 codify 進 `tests/e2e/`，並從手動清單移除。
