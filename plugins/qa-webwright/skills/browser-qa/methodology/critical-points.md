# 從「TC 預期結果」到「critical point」＋ assert（方法論）

核心對映：QA Agent 設計的每條測試案例預期結果 → 一個**可被其結構化證據獨立驗證**的（證據強度依 CP 類型，見下方證據規範）
critical point → 可重跑 runner（pytest 等）裡**（至少）一行 `assert`**（雙向／多面卡控可對多行 assert，見 CP5 範例）。

最後這一步（落成 assert）是讓測試「寫一次、以後直接 `pytest` 跑、
無 agent、不花 token、可進 CI」的關鍵——沒有 assert，就只能每次靠人/agent 看畫面判定。

> **載體中立**：runner 用專案既有的（pytest-playwright / Playwright Test / 任何帶 assert+exit code 者）。
> 證據一律是**結構化**的（API 業務碼 / DOM/a11y 讀回值 / 來源 readback），不靠讀截圖；截圖至多留檔備查。

## 對映規則

| 測試計畫 | critical point | runner 測試碼 |
|----------|----------------|----------------|
| TC 的一個「預期結果」 | 一個 critical point（CP） | （至少）一行 `assert`（打在結構化證據上；雙向卡控等可多行） |
| 步驟的【證據】說明 | 該 CP 的證據來源（API 碼 / DOM 值 / readback） | 取該證據 + 對應斷言 |
| 需檢查項目 | 額外 CP | 額外 assert（無 console error、業務碼 0000 等） |

每個 CP 必須**獨立可驗證**：依 CP 類型，光看其結構化證據（讀取型一個即可；寫入型需業務碼＋readback；
雙向卡控需兩個方向斷言，見下方證據規範與 CP5/CP7 範例）就能判定 pass/fail，不依賴「我記得剛剛點了什麼」。

## 好 / 壞 critical point

✅ **好**（具體、打在結構化證據上）：
```
- [ ] CP2: 用唯一鍵(DocNo)定位那一列，**再 scope 到狀態欄那一格**讀其文字、精確比對（不讀整列，避免「待處理」出現在備註/按鈕等別欄而誤綠）
      → row = page.locator("tr:has-text('DOC-20260626-001')")；assert row.locator("td.status-col").inner_text().strip() == "待處理"（狀態欄定位子依專案實際 DOM）
- [ ] CP5: 必填「聯絡信箱」卡控**雙向**都要驗（只驗一邊＝把「按鈕壞掉永遠 disabled」誤判成設計對）
      → 留空時 assert page.get_by_role("button", name="送出").is_disabled()
      → 填妥後 assert not page.get_by_role("button", name="送出").is_disabled()
- [ ] CP7: 送出成功（業務碼，非只看 HTTP 200）+ DB 讀回 token 相符
      → assert resp.json()["code"] == "0000"；再查 DB 該筆關鍵欄位 == 寫入的 unique token
```

❌ **壞**（模糊、無法斷言）：
```
- [ ] 表單運作正常        ← 斷言什麼？
- [ ] 資料有存進去        ← 從哪看出來？
- [ ] 沒有 bug
```

## 斷言規範

- **每個 CP 對應至少一行 `assert`**，斷言失敗時印出清楚訊息（哪個 CP、預期 vs 實際）。
- **斷言打在結構化證據上**：API 業務碼（如 `code == "0000"`，**非只看 HTTP 200**——業務失敗常 200+碼≠0000）、
  DOM/a11y 讀回值、來源（DB / 重查）readback。寫入型操作必「寫 unique token → 讀回那一筆比對」。
- 斷言要打在**穩定、語意化的條件**上（可見文字、role、狀態、業務碼），不要打在脆弱的 xpath index。
- 最終資料（單號 / 狀態 / 關鍵值）印進測試 log 或 stdout，供報告引用。
- 全部 assert 通過 → exit 0；任一失敗 → 非 0，CI 即可據此擋。

## 證據規範（self-verify 時嚴格把關）

- 每個 CP 至少對應一個結構化證據，**依 CP 類型決定證據強度**：
  - **讀取 / 查詢型**：API 業務碼 **或** DOM/a11y 讀回值 **或** 來源 readback，任一即可。
  - **寫入 / 送出型**：業務碼（如 `code=="0000"`）**且**必附「寫 unique token → 讀回那一筆比對」（DB 重查 / 重新 GET / UI 渲染含該 token）——業務碼單證據不足（呼應斷言規範的寫入型讀回鐵則與 CP7 範例）。
  - **守門 / 卡控型**（本無寫入）：斷言特定狀態 / 錯誤碼（如按鈕 disabled、特定業務錯誤碼）即可，不需 readback。
- 確認證據**明確無歧義**：業務碼正確、值完全相符、列表確實反映該條件（用 unique 鍵定位那一筆再讀欄位，
  不是只驗「有列 / 非空」）。
- 對「狀態在 modal / drawer / dropdown 關閉後被藏起來」的情況：操作前先讀到值，或重開後再讀。
- 對「UI 看不到」的 CP（如資料真的寫進某來源）：查來源（DB / 重新 GET）印出結果作證，並對應一行 assert。
- 模糊、被遮擋、只套用一半的狀態 → 一律當 FAIL，不放水。

## 截圖（留檔備查，非判定依據）

- 判定一律靠上述結構化證據；**截圖不作為 pass/fail 依據**（讀圖花 token，且看圖會漏掉渲染層以外的 bug）。
- 若要留檔備查（例：佐證 RWD 破版這類純視覺問題），命名清楚、一個情境一張即可，不要每步狂截。
- runner 的瀏覽器 / viewport / 等待策略一律**沿用該 runner 的慣例**（pytest-playwright 用 chromium + locator；
  外部站備用探索才用 webwright 的 Firefox contract，見 `knowledge/pitfalls.md` G 段）。
