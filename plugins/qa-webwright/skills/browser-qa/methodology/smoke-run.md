# 上線前健檢（smoke test）方法論

> 對象：`/qa-webwright:smoke` 的執行者（主對話負責起服務、跑腳本、出報告；手動 TC 派 qa-engineer）。
> 腳本：`qa-flow.sh smoke-try／smoke-preflight／smoke-run／smoke-report／smoke-stop`，設定在專案的
> `tests/Project_Detail/SMOKE.json`（欄位見 plugin README「上線前健檢」節，範例 `templates/SMOKE.example.json`）。
> 測試執行的通用紀律（不打斷、整輪才出報告、Partial／N.A.／Env Limit 分類、副作用邊界）在 `test-discipline.md`，本檔不重寫，只寫健檢特有的部分。

## 1. 分級

| 等級 | 適用時機 | 選哪些測試 |
|------|----------|------------|
| P0 | 每次上線必測 | `SMOKE.json` 的 `levels.P0`（通常 `-m P0`） |
| P0+P1 | 大版本更新 | 通常 `-m "P0 or P1"` |
| P0+P1+P2 | 完整回歸 | 空字串＝不加 `-m`，全部 |

- 等級名與篩選式**由專案在 `levels` 定義**，上表只是常見寫法；等級不在 `levels` 裡，`smoke-run` 直接 exit 2。
- 案例數以當下的 `tests/e2e/CATALOG.md`（或專案自己的索引）為準，**不寫死在任何文件裡**。
- 不分等級都要跑的關卡測試（上線必驗的回歸鎖）放 `always_run`：它從等級套件排除、另跑一次，不會被 `-m` 篩掉、也不會重複計數。
- 測試要標 marker（`@pytest.mark.P0` 等），marker 要在專案的 pytest 設定檔 `markers` 註冊；漏標的測試不會被任何等級選到（`smoke-report` 遇到 0 筆會拒絕，就是在擋這件事）。

## 2. 起服務：先試起、通過才 codify

`SMOKE.json` 的每個服務必須先經過一次「試起」才算數：

1. **抓指令**：AI 讀專案文件（README、`package.json` scripts、launch 設定、既有的啟動腳本、`tests/Project_Detail/` 底下的說明）抓出啟動指令、port、scheme、健康檢查網址，寫成 `SMOKE.json` 草稿（`verified: null`），出處與理由寫進 `SMOKE.md`。
2. **試起**：`qa-flow.sh smoke-try <服務名>`——腳本照設定在背景起服務（log 落 `report_dir/logs/`）、等 port LISTEN、打健康檢查、跑 `post_start_checks`。
3. **通過才寫 `verified`**（時間、`start_ok`、`health_ok`、設定指紋）；失敗會印原因與 log 尾段、停掉剛起的程序、不寫 `verified`。照 log 修 `SMOKE.json` 再試。
4. 之後的健檢只用 verified 的設定由腳本代起。**驗證後改過** start／health／port／cwd／post_start_checks，指紋對不上，`smoke-preflight` 會拒絕、要求重新 `smoke-try`。

試起必須在 port 空著時做（才能證明「這組設定起得來」）；port 被佔時 `smoke-try` 印出佔用者後停止。

### 起服務決策樹（`smoke-preflight` 依 `order` 逐一）

```
服務未 verified（或驗證後設定被改過）→ 拒絕（exit 3），先 smoke-try
檢查 port 是否有人 LISTEN
  ├─ 沒有 → 用 verified 設定代起 → 等 LISTEN → 健康檢查 → 起後檢查
  │          ├─ 通過 → 記錄 PID（smoke-stop 只停這些）→ 下一個服務
  │          └─ 失敗 → 停掉自己剛起的程序、印 log 尾段，停止（exit 1）
  └─ 有 → 直接健康檢查
             ├─ 通過 → 沿用，不重起
             └─ 失敗 → 印佔用者 PID 與命令列（已遮罩），**不殺**，回報使用者，停止（exit 4）
```

**不殺別人的程序**：佔著 port 的可能是別的 session、別的分支、使用者自己開著的服務。要不要停它、或改 port，由使用者決定。
（多實例、port 歸屬以實測為準等通用坑見 `knowledge/pitfalls.md` N 段；Windows 背景啟動的坑見 D 段。）

## 3. 執行：自動套件優先，其餘手動

1. `qa-flow.sh smoke-run <等級>`：先對每個服務做一次健康檢查（沒過＝拒絕，先 preflight），再跑等級套件與 `always_run`，junit 落 `report_dir`。pytest 有 FAIL 屬預期內，照常往下走。
2. 自動套件涵蓋到的 TC 直接採計 junit 結果，不再手動重跑。
3. **索引沒涵蓋的 TC 才手動**：`smoke-run` 會把 `manual_tc_file` 依等級篩出、結果欄清空，存成本輪副本 `report_dir/manual-<本輪編號>.md`。
   派 **qa-engineer** 用瀏覽器逐案執行並把結果與證據填進本輪副本（派工單照 `SKILL.md`「派工範本」填，主對話不親跑瀏覽器）。

### 執行規則（四條）

1. **照計畫，不增減步驟**：手動 TC 照清單的步驟做，不跳步、不自己加步驟；計畫與實作不一致時標 N.A. 並寫明差在哪（不要自己改計畫湊 PASS）。
2. **CRUD 要讀回驗證**：新增後清單看得到、編輯後值有變、刪除後從清單消失；只看到成功提示（Toast）不算 PASS。證據欄寫讀回結果（`critical-points.md` 證據規範）。
3. **有依賴照順序**：手動清單「備註」標了依賴的，先跑被依賴的那支；被依賴的 FAIL，依賴它的標 N.A. 並寫原因。
4. **錯誤一律記**：每個 FAIL 都要在本輪副本填結果、證據、嚴重程度；`smoke-report` 會把自動與手動的 FAIL 一起追加到 `issues_log`（同一天接在該日區段表尾，同一輪重出報告不重複追加）。

### 穩定的手動 TC 要 codify

手動跑通且穩定的 TC，照 Phase 2 的沉澱流程寫進 `tests/e2e/<模組>/`（標等級 marker、登記 COVERAGE、drift 0/0/0），
再從 `manual_tc_file` 移除——下一輪就由自動套件涵蓋，不必再手動。手動清單應該只會越來越短。

## 4. 全部跑完才出報告（由 `smoke-report` 機制保證）

`qa-flow.sh smoke-report` 在以下任一情況**拒絕產出報告**（exit 3，逐條列出缺什麼）：

- 本輪 junit 不存在或解析不了
- 自動案例 0 筆（等級篩選式沒選到任何測試、marker 漏標）
- 手動 TC 本輪副本有任何一列沒填「結果」、結果不是 PASS／FAIL／Partial／N.A.／Env Limit、或沒填「證據」

報告的摘要數字**直接由 junit 逐筆計數**（與 `run_by_folder.py` 同一個計數函式）加上手動結果算出，不從 pytest 的終端摘要抄。
報告落 `report_dir/smoke-report-<本輪編號>.md`：測試資訊（日期、等級、各服務網址）、結果摘要、案例明細（含證據欄）、發現問題、結論。

## 5. FAIL 不自動修

結論句固定是「FAIL 由使用者決定，不自動修」。發現 FAIL 時：列出來、記進 `issues_log`、寫完報告，**最後**讓使用者決定
（派工修正後重跑健檢，或記為已知問題暫不修）。測試者不改產品碼（`test-discipline.md` §2）。

## 6. 收尾

健檢結束（不論通過與否）跑 `qa-flow.sh smoke-stop`：只停狀態檔記錄的、本腳本起的程序（建立時間也要對得上，PID 被重用的不碰）；
沿用的、別人起的一律不碰。
