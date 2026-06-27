# 知識庫：測試踩過的雷與領域知識

> **這是會長大的累積檔，不是穩定規範。** 每次測試踩到新坑、發現某技術棧的眉角，就在對應分類
> **append 一條**（標日期）。方法論（`methodology/`）保持穩定；專屬知識全部沉澱在這裡。
>
> 每條格式建議：**現象 → 原因 → 正確做法**。不確定通用性的也先寫，標「（待驗證是否通用）」。

選用：以下知識**依目標專案技術棧取用**，沒有後端的專案略過後端段，沒有富文本的略過編輯器段。

---

## A. 資料來源 / 後端驗證（專案有後端或外部 API 時）

- **能走 UI 就走 UI**：模擬使用者操作必須點畫面、填表、按鈕，
  **禁止直接打後端 API 繞過前端 validation / payload 組裝 / 按鈕鎖控**。UI 上跑通才算 PASS。
  - 例外：沒有 UI 入口的外部系統 callback（如 BPM / webhook）可用指令模擬；
    資料準備 / 驗證 / 清理可用 SQL 或 API（那是 housekeeping 與驗證，不是「操作」）。
- **業務錯誤碼 ≠ HTTP 2xx**：後端可能回 HTTP 200 但 body 帶業務失敗碼。
  斷言要看**業務碼**，不要看到 200 就當成功。
- **重複/並發**：送出中重複點擊、並發編輯，要驗不產生重複資料或互蓋。

## B. 日期 / 時區：跨 UI → 送出 → 來源 → 顯示 的一致性驗證

**何時必做**：PR 動到任何日期 / DateTime / Timestamp / Converter / DatePicker。

**原因（時區偏移）**：UI 的 DatePicker 選「2026-04-23」時，前端常用本地時區產生 ms：
`new Date(2026, 3, 23).getTime()` → 在 UTC+8 代表的瞬間是 `UTC 2026-04-22 16:00`。
同一個 ms，用哪個時區「取日期部分」會得到 04-23 或 04-22。後端 getter（UTC vs Local）、
序列化 Converter、前端再 `new Date(...)` 顯示——任一環算錯就 **-1 / +1 天 或 ±8 小時**。

**為什麼只用 curl 測 API 抓不到**：手寫 payload 幾乎都用「UTC 00:00」的 ms，
UTC 當天和本地當天同日，**踩不到偏移**。所以 curl 全綠 ≠ 真實 UI 沒事。

**四點驗證（同一筆日期從頭跟到尾，每點 log+assert；截圖至多留檔備查、不作判定）：**
1. **UI**：DatePicker 選一個好辨識的本地日期 → 斷言 input 顯示 `2026-04-23`
2. **送出 payload**：抓 request body，記下該欄位的 Unix ms
3. **來源實際值**（若有持久化）：查存進去的值，比對是本地 `2026-04-23 00:00` 還是合理 UTC（看約定）
4. **刷新後**：重新載入後 DatePicker 仍顯示 `2026-04-23`（沒變 04-22）

四者任一不一致即 FAIL。**禁止**：只用 curl 送 UTC 零點 ms 就宣稱已驗證；用 SQL 硬塞正確值繞過 pipeline；
送出後只看成功碼就 pass、不查來源 / 不刷新對照。

> 純前端無後端時：第 3 點（來源）省略，只驗 UI 選值 = 元件 state / 送出值 = 刷新後顯示。

## C. 測試資料「壞值」的具體後果

- **邊界日期**：留空的日期欄位若在資料層存成型別最小值（例 .NET `DateTime.MinValue` / `0001-01-01`），
  前端用 JS Date 對它做 UTC 換算會因歷史時區偏移產出**超界 Unix timestamp**，
  後端 `DateTimeOffset.FromUnixTimeMilliseconds` 會拋 `ArgumentOutOfRangeException`。
  → 所以即使非必填，日期也要填合理值。
- 空字串 / null 在後續「變更歷史 / 顯示 / 再送審」流程容易炸或渲染空白，遮蔽真 bug。

## D. Windows PowerShell 背景啟動 dev server

- `npm` / `npx` 在 Windows 是 `.cmd` / `.ps1` 包裝、**不是 `.exe`**。
  `Start-Process 'npm' ...` 走 Win32 CreateProcess 不認 PowerShell script → **silent fail**。
  - 正確：`Start-Process 'npm.cmd' ...` 或 `Start-Process 'cmd.exe' '/c','npm.cmd',...`；`dotnet.exe` 則正常。
- 啟動後用 `Get-NetTCPConnection -State Listen -LocalPort <port>` 確認真的 LISTEN，
  別只靠回傳的 PID 當作起來了。
- 某些 dev server 對 `npm run dev -- --port 5182` 的 `--` token 處理會吃掉 flag（PowerShell 5.1）→
  改用底層工具直接帶參數（如 `npx vite --port 5182`）繞過 npm script 包裝。

## E. 前端元件互動雷（依元件庫取用）

- **下拉選單常用 portal**：選項渲染在 body 末端的 portal，**不在 modal/trigger 的 DOM 內**
  （例：Naive UI 的 `.n-base-select-option`、多數 UI 庫的 popper）。
  → 找選項要 scope 在「最新顯示」的 menu，不要 scope 在 modal 內找不到。
- **巢狀 modal**：最上層 modal 通常是容器選擇器的「最後一個」（例：`.n-modal-container` 的 `.last`）。
  同頁多個同名 dropdown 時，精準 scope 最上層 modal，否則會誤觸背景元素破壞測試環境。
- **隱藏的 file input**：上傳元件的 `input[type=file]` 多半隱藏，用 `set_input_files` 直接設檔，
  不必點按鈕、不走 file chooser。
- **二次確認 dialog 可能在獨立節點**（例：`dialog.warning()` 產生的 `.n-dialog`，不在原 modal 內）→
  找確認鈕要全頁 scan 或精準 scope 該 dialog。
- **DatePicker / 日期輸入多為受控元件**：禁止只用「打字塞值」（如 `browser_type` / `fill`）——值常不同步進框架 model。
  → 正確做法是點開日曆 picker 選日期，或打字後**驗證輸入框確實回饋了該值**（input 顯示 + state 已更新）再往下。
  （此為「值怎麼正確輸入進去」的互動機制；「選進去後日期解析對不對」屬時區一致性，見 B 段四點驗證。兩者是不同失效面。）
- **互動觸發一律用 trusted click，禁 `evaluate` 內的 `element.click()`**（此條主探索/runner 皆適用，不限 webwright）：
  框架的 `v-on:click` 等需 **trusted event**；`evaluate` 內 `element.click()` 是 untrusted，handler **時跑時不跑** →
  不可重現的**假性 FAIL**。正確：用探索工具的 trusted click（MCP `browser_click` + ref / runner `locator.click()`）；
  ref/locator 失效時換 selector 重定位，`evaluate.click()` 只作最後手段並於報告註明。

## F. 受控元件 / 富文本 state 同步雷

- 富文本編輯器（例：基於 slate.js 的 WangEditor）內部是 immutable model，
  **直接設 `innerHTML` / Playwright `fill` 不會同步到框架 model**。
  → 正確做法是透過框架的 component state 設值（例 Vue dev mode 的 `__vueParentComponent.setupState.<ref>`），
  且只有 dev/非 production build 才有這些 debug hook。
- 通則：受控元件（值由框架 state 驅動）不能只改 DOM，要觸發框架認得的事件或直接改 state。

## G. webwright 操作雷（僅在啟用 webwright 備用探索時適用）

> **適用範圍**：本段只在「真實外部站、無 a11y、長程未知路徑」才用 webwright 自主探索時適用。
> 有 a11y / 後端可攔的專案走 a11y `ref` + ApiRecorder + runner locator，**不走截圖、不走 Firefox contract**。

- **一次一個動作**：不要在一次 evaluate 內同時 click + verify（DOM 更新時序，verify 拿到舊狀態）→
  分兩步：操作 → 等 → 驗證。（此 DOM 時序雷正是 webwright 抓不到「連點 race」的根因——回歸期的時序斷言應交給
  runner 的 API count/事件斷言，不靠截圖。）
- **用 ref > CSS selector**：從 snapshot 取得的 ref 是 strict locator，精準；
  CSS 文字選擇器可能 match 到背景的同名舊元素而誤點。
- 探索瀏覽器設定：viewport 固定 `1280×1800`、headless local Firefox（webwright 探索 contract）。
  （留檔截圖若有，不用 `full_page=True`；但截圖僅備查，判定一律靠結構化證據，不是截圖。）

## H. 外部站 TLS/HTTP2 指紋封鎖（2026-06-26）

- **現象**：打真實外部站（Akamai / HTTP2-protected）時 Chromium 報 `ERR_HTTP2_PROTOCOL_ERROR`
  或連線被靜默拒，看起來像 flaky test。
- **原因**：站台以 TLS/H2 指紋封鎖 Playwright Chromium。
- **正確做法**：**先換 `playwright.firefox` 再排查，別當 flaky 重試。** 本機自家系統用 chromium 即可、踩不到此雷。

---

<!-- 新知識 append 在上面對應分類；若是新分類就新增一段 H、I… 並標日期 -->
