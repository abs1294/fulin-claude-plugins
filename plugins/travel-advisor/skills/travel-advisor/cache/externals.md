# 外部事實快取（第④層）

本檔放**會因外部世界改變而失效**的事實。它不是規範。

```
規範（②）  「分數必須綁定該分店本身」          ← 判準，不會變
快取（④）  「用 div.F7nice 讀分數」            ← 實作細節，Google 改版就錯
```

🔴 **每條都有 `查核日` 與 `有效天數`。過期即視為「未查證」，Gate-V 不得引用。**

為什麼要獨立成層：Gate-V 的全部機械判準建立在 Google 的 CSS class name 上。
把它放進「不變的規範」層，等於把三個月後必然失效的東西刻進「不變」那層。

---

## 使用前先檢查

```
跑 scripts/check-cache.py
  → 列出過期項
  → 有過期項：該項視為未查證，要用就先重新實測並更新本檔
```

---

## E-01 Google Maps：證明讀到的是店頁而非搜尋列表

```
查核日 2026-11-01   有效天數 90   查核方式 Playwright 實測（日文＋英文介面）
複驗日 2026-11-01   七項判準在 ja 與 en 兩種介面全部成立
                    複驗方式 node scripts/verify-gatev.js（exit 0）
```

```javascript
// 兩項都要成立
document.querySelector('[role="feed"]') === null          // 無列表容器
document.querySelector('div[role="main"][aria-label]')     // aria-label 逐字 == 店名
```

🔴 **第二項不相等時，絕不可改口說「就是這家」。**

### 🔴 但「不相等」有三種，處置完全不同（2026-11-01 dry-run 實測）

逐字比對會把「我多打了區名」誤判成「這家不存在」。實測四個案例：

| 我搜的 | aria-label 回 | 逐字 | 真實情況 |
|---|---|---|---|
| `Flour and Stone` | `Flour and Stone` | 相等 | ✅ 對的店 |
| `Flour and Stone Woolloomooloo` | `Flour and Stone` | **不等** | 🔴 **也是對的店**（我多打了區名） |
| `Gelato Messina Darlinghurst` | `Gelato Messina Darlinghurst` | 相等 | ✅ 對的店 |
| `Gelato Messina Antarctica Branch` | `Messina Wan Chai` | 不等 | ✅ 判對（但換到**香港**了） |

**所以判準要分三種，不是二分**：

```
① aria-label == 我搜的字串
   → 確定是這家。通過。

② aria-label 是我搜字串的【子集】（我搜的字串包含 aria-label 全文）
   → 很可能是我多打了區名／地名／「本店」這類修飾詞。
   → ⛔ 不可直接當通過，也不可報「不存在」。
   → 處置：拿 aria-label 的值去比對地址／座標是否落在我要的那一區。
            落在 → 通過，並告知使用者「官方店名是 X，不含你說的區名」。
            沒落在 → 走 ③。

③ 其餘（aria-label 與我搜的字串無包含關係）
   → 這就是靜默重導向。報「該店名不存在，實際找到的是 X」。
   → 🔴 連跨國都可能：實測搜雪梨的假分店，Google 給了【香港灣仔】那家，
        而 feed===null、place 頁、F7nice 分數（4.9|(48)）三項判準全綠。
        只有這一項擋住。
```

🔴 **②③ 的差別一定要分**：把 ② 報成「不存在」，使用者會以為自己記錯店名，
而那家店明明就在。把 ③ 當成通過，會給出另一個國家的店。

### 語言依賴：哪些判準跟語言有關、哪些無關（2026-11-01 兩種介面都實測過）

原本整條標「未驗證，換地區先實測」。**已實測英文介面（hl=en, locale en-AU），
結果是：大部分判準與語言無關，只有一項有關。** 下表是實測結果，不是推論。

| 判準 | 日文介面 | 英文介面 | 結論 |
|---|---|---|---|
| `[role="feed"] === null` | ✅ | ✅ | 語言無關 |
| `div[role="main"][aria-label]` 存在 | ✅ | ✅ | 語言無關 |
| `div.F7nice` 讀分數＋評論數 | ✅ `4.4｜(80)` | ✅ `4.6｜(1,388)` | 語言無關 |
| URL `!3d` `!4d` 座標 | ✅ | ✅ | 語言無關 |
| URL `!16s` / `ftid` | ✅ | ✅ | 語言無關 |
| 營業時間**逐日表** | ✅ 7 天 | ✅ Mon–Sun 7 天 | 語言無關（**但解析用的 regex 有關**，見下） |
| aria-label 比對 | ⚠️ | ⚠️ | 🔴 **有關**，見下 |

🔴 **aria-label 是唯一與語言有關的那一項。** 你手上的店名與 Google 登錄名
可能是不同語言／羅馬字轉寫，逐字必然不等 —— 所以**一定要用上面的三分支判準**，
不要用二分的逐字比對。三分支判準在兩種介面都實測成立。

🔴 **營業時間的解析 regex 與語言強相關，而且是靜默失效**：

```
日文介面   営業時間／定休日／営業中     命中
英文介面   営業時間／定休日／営業中     🔴 0 命中（實測 ja_hit = 0）
           要改用 Open / Closed / Opens / Closes / Hours
```

這條**不會報錯，只會什麼都抓不到**，然後被當成「這家店沒有營業時間資訊」。
換地區時：`cache/externals.md` 的 E-04（營業時間 regex）必須換該語言的詞彙並實測。
各地區用哪些詞，記在 `config/user-profile.md` 的 I 段。

### 複驗紀錄 2026-11-01（Playwright，日文介面）

測試店：大寅蒲鉾 難波戎橋筋本店

```
[role="feed"] === null                true                     ✅ 成立
div[role="main"][aria-label]          存在，class m6QErb WNBkOb XiKgde
  aria-label                          「大寅蒲鉾 難波戎橋筋本店」逐字相符  ✅ 成立
div.F7nice                            存在，innerText「4.4 | (80)」      ✅ 成立
```

🔴 **新發現的坑：`/maps/place/<店名>/` 這個 URL 形狀會失敗。**

```
❌ https://www.google.com/maps/place/<URL編碼店名>/?hl=ja
     → 重導向成 /maps/place//@25.0249216,121.5266816,13z
        店名被吃掉，落在台北的空白地圖
        title 只回「Google マップ」、三項判準全部讀不到

✅ https://www.google.com/maps/search/<URL編碼店名>?hl=ja
     → 自動解析成 /maps/place/<店名>/@34.666,135.501,17z/data=...!16s/g/...
        title 變「<店名> - Google マップ」，三項判準齊備
```

**判準**：開完要看 `location.href` 有沒有長出 `@lat,lng` 與 `!16s`。
沒長出來就是沒開到店頁，不要往下讀分數。

---

**zh-TW 實測（2026-11-05，`verify-gatev.js --suite zh`，鼎泰豐信義店）**：
```
判準 1–7      exact／superset 全 PASS（F7nice "4.4 | (13,210)"，逐日表 12 列，!3d!4d + !16s）
營業時間詞彙  打烊／營業時間／已打烊 命中；營業中未命中（測試時段店已打烊，不是詞錯）
假店          🔴 行為與 ja/en 不同：Google【留在搜尋列表】（[role=feed] 存在），不重導向
              → 這是正確行為，但腳本原本只處理「重導向到店頁」的假店，會誤報 5 個 FAIL；已修
              → 判準：fake 案例 feed 存在 = 沒有靜默換店，N/A 不是 FAIL
```

## E-02 Google 對不存在的店名會靜默重導向

```
查核日 2026-11-01   有效天數 180   查核方式 Playwright 實測
複驗日 2026-11-01   完整重現，數值與 10-31 完全相同
```

搜「551蓬莱 戎橋本店」（不存在）→ 靜默導到「551蓬莱 本店」，
照常回 4.2(4,603)，**無任何錯誤提示**。只讀分數看不出來。

防法：用 E-01 的 aria-label 比對，**照 E-01 的三分支判準**
（相等／我搜的字串包含它／無包含關係），不要只做二分的逐字比對。
無包含關係才回報「該店名不存在，實際找到的是 X」，並列出同品牌周邊分店。

### 複驗紀錄 2026-11-01

```
我搜的                 551蓬莱 戎橋本店（不存在的店名）
Google 給的            551蓬莱 本店          ← 靜默換了一家
分數照常給             4.2 (4,603)
URL 變成               /maps/place/551蓬莱+本店/@34.6664,135.5013,17z/...!16s/g/11c0r5dk3b
document.title         「551蓬莱 本店 - Google マップ」
錯誤提示               無

三項判準各自的反應：
  [role="feed"] === null          true     ← 🔴 這項【通過】，會讓你以為可信
  div.F7nice 存在                  true     ← 🔴 這項也【通過】，照常給分數
  aria-label 逐字比對              不相等    ← ✅ 只有這項抓到
```

🔴 **三項判準裡只有 aria-label 比對抓得到這個錯。**
另兩項在重導向後照樣全綠 —— 它們證明的是「這是一個店頁」，
不是「這是你要的那家店」。省掉 aria-label 比對，Gate-V 就形同失效。

---

## E-03 分數與座標的讀取位置

```
查核日 2026-11-01   有效天數 90   查核方式 Playwright 實測（日文介面）
複驗日 2026-11-01   div.F7nice 仍存在，讀到「4.4 | (80)」（大寅蒲鉾 難波戎橋筋本店）
                    URL 的 !3d34.6662299 !4d135.5015537、!16s/g/1tfk49xx 均齊備
```

```
分數     div.F7nice        形如「4.4 | (19,042)」
座標     URL 的 !3d !4d    不是 @lat,lng（那是地圖視窗中心，可差 300 m）
識別碼   ftid（0x…:0x…）+ !16s（/g/…）
```

**place_id（ChIJ… 形式）拿不到** —— 無法從 ftid 推算、也不在 DOM 裡。
兩條驗證路徑都試過失敗：
```
① 從 ftid 推算 → 開 ?q=place_id: 標題只回「Google マップ」，未解析
② 掃 DOM 找 /ChI[A-Za-z0-9_-]{20,}/ → null
```

⚠️ `div.F7nice` 是 Google 前端 class name，**改版即失效**。
失效時的症狀是「讀不到分數」而非「讀到錯的分數」，方向安全，
但會讓 Gate-V 無法完成 → 該主張須標 HYPOTHESIS，不得猜。

### 🔴 headless 會讓評論數靜默消失（2026-11-01 實測）

```
headless=true    UA 含 HeadlessChrome    div.F7nice = "4.4"            ← 評論數不見了
headless=false   UA 含 Chrome/145        div.F7nice = "4.4 | (80)"     ← 完整
```

同一個 URL、同一個 selector、同一天，差別只有 headless。
`document.body.innerText` 全文掃 `\(\d[\d,]*\)` 在 headless 下也是 0 筆 ——
不是跑到別的容器，是**整個沒渲染**。

**為什麼這條比「class name 改版」危險**：

```
class name 改版   → 讀到 null           看得出壞了      方向安全
headless 省略     → 讀到 "4.4"          看起來正常      🔴 靜默少讀
```

4.4 配 80 則評論，跟 4.4 配 3 則，是完全不同的主張。
只讀到分數就當查證完成，等於把「樣本數不明」講成「分數 4.4」。

**判準**：讀分數時必須同時拿到 `(\d[\d,]*)` 形狀的評論數。
只有分數沒有評論數 → 先查 `navigator.userAgent` 有沒有 `HeadlessChrome`：

```
有 HeadlessChrome   → 不是判準失效，換 headed 重讀
沒有               → 這是新情況，實際開頁面查，不要猜
```

`scripts/verify-gatev.js` 已把這條編碼進去（預設 headed，判準 3 檢分數＋評論數）。

---

## E-04 雙入口交叉驗證的 URL 形狀

```
查核日 2026-10-31   有效天數 90
```

```
入口一  .../maps/place/<店名>/@<lat>,<lng>,17z/data=...?hl=<語言>
入口二  .../maps/place/<店名>/data=!4m6!3m5!1s<ftid>!8m2!3d<lat>!4d<lng>!16s<16s>?hl=<語言>
```

🔴 **這不是「兩個來源」，是同一個來源的兩條入口。**
它只能抓「我讀錯分店」，**抓不到「Google 本身的資料是錯的」**。

不得因為做了這個就宣稱「已交叉驗證」。真正的交叉驗證定義見 `SKILL.md` Gate-V。

---

## E-05 展開逐日營業時間

```
查核日 2026-10-31   有效天數 90   查核方式 Playwright 實測（日文介面）
```

```javascript
[...document.querySelectorAll('button')]
  .find(b => /営業中|営業終了|営業開始|営業時間/.test(b.textContent))
```

🔴🔴 **這段在非日文介面會靜默失效。** `find` 回 `undefined`，
`if(btn){btn.click()}` 不執行、**不報錯**，於是「逐日表」永遠展不開
而我會以為跑過了。這是教科書級的靜默失效：工具沉默、規則被滿足、答案是錯的。

換地區必須換 regex 並實測：
```
英文  /Open|Closed|Opens|Closes|Hours/
```
未實測前這條標 **未驗證**，營業時間改用其他來源或標 HYPOTHESIS。

---

## E-06 tabelog 403 繞過

```
查核日 2026-10-31   有效天數 180   查核方式 實測
```

```
tabelog.com/...     → 403
s.tabelog.com/...   → 403
tabelog.com/en/...  → 302，跟隨後 200  ✅
```

⚠️ 僅日本適用。其他地區的平台需各自實測。

---

## E-07 台灣入境檢疫（會變，法規性）

```
查核日 2026-10   有效天數 90   來源 台灣防檢署
```

```
肉製品（含肉乾、肉鬆、含肉泡麵調味包）→ 禁止輸入台灣，罰 20 萬起
「乾燥的肉可以」是錯的 —— 乾燥不改變禁止狀態
```

🔴 **每次回答檢疫問題都要查當期條文，不得引用本檔。**
本檔只記「我上次查到什麼」，供對照是否有變動。

⚠️ **檢疫要雙向查**：出發國的輸出限制 + 目的地國的入境限制。
原規則只寫「帶回台灣」，漏了「帶去當地」——
澳洲入境管制全球最嚴之一（生鮮、堅果、種子、蜂蜜、木製品），未申報可罰。

---

## E-08 agent 定義檔不熱載入（平台事實，與旅遊無關）

```
查核日 2026-11-01   有效天數 60   環境 Claude Code 2.1.316
```

```
建檔：放在原本空的 ~/.claude/agents/ → 需重啟才被偵測
      （watcher 只覆蓋 session 啟動時已有內容的目錄）
編輯：官方文件說熱載入，實測「沒有」—— 連派三個 agent 全讀到舊版
      （檔案已用 md5 + 逐行 dump 確認是新的）
skill：確認會熱載入
```

因應：防錯規則真身一律放 skill，agent 定義檔只放流程骨架。

⚠️ 這條會隨 Claude Code 版本變動，有效天數設短。

---

## E-10 手機地圖「分享我的位置」連結格式（parse-loc.py 的依據）

查核日 2026-11-04   有效天數 180

**已驗（本 session）**：
```
Remote Control 訊息不帶 GPS   FetchInboxMessage 回傳欄位 body/sender_display/slack_permalink，無座標
parse-loc.py 解析路徑         Apple ll= / coordinate= ；Google @lat,lng / ?q= / !3d!4d / /place/<座標>/
                              純文字 "lat, lng"；短網址 follow() 用 http://google.com 驗過會跟轉址
負向                          店名 place 頁（/place/<名>/、!16s、name=）正確判成「地點」exit 4
```

**✅ Google 已驗（2026-11-04，使用者 iOS Google Maps 真連結）—— 原 HYPOTHESIS 已推翻**：
```
原本推測     短網址轉址後是 /maps/place/<lat>,<lng>/ 或 ?q=<lat>,<lng>
實際         https://maps.app.goo.gl/<id>?g_st=ic
             → 轉址 https://maps.google.com/maps?q=<地址+店名>&ftid=0x..:0x..&entry=gps&...
             【沒有座標】。Google 把藍點吸附到最近的店，分享的是那家店的 ftid
             entry=gps 是「從藍點分享」的訊號（只有一個樣本，HYPOTHESIS：分享地點時沒這參數）

ftid → 座標  不用開瀏覽器：GET /maps/preview/place?...&pb=!1m2!1s<ftid>!2sx
             回 )]}' 開頭的 JSON 塊（16 KB），內嵌正規 URL /maps/place/<名>/@lat,lng,...
             實測 24.9750554,121.5402897 與 Chrome 改寫後 URL 的 !3d!4d 完全一致
             靜態 HTML（maps?ftid=）與 output=embed 都【沒有】座標 —— 唯一的 center= 是台北預設中心
備援         node 開 Chrome（channel:'chrome'）讀改寫後 URL 的 !3d!4d（慢 3–5 秒，端點改版時用）
精度         吸附點不是原始 GPS。誤差＝使用者到那家店的距離，這次是站在店門口，可當步行起點
```

**✅ Google「即時位置分享」已驗（2026-11-04，使用者真連結，scripts/live-loc.py 的依據）**：
```
連結          maps.app.goo.gl/<id>?g_st=ic
              → /maps/@/data=!4m5!7m4!1m2!1s<帳號ID>!2s<token>!2e2   沒有座標
位置從哪來    頁面載入時 POST /maps/_/MapsWizUi/data/batchexecute?rpcids=Qt4aBe
              最小本體 [1,null,[[<帳號ID>,<token>]]]；session 類的值全部不需要（A–E 五種變體同結果）
              【不帶 cookie、不開瀏覽器】重放成功，200
回應結構      [null,<lng>,<lat>],<ts_ms>,<未知整數>,"<反查地址>",...,[<充電 bool>,<電量 int>]
              🔴 lng 在前 lat 在後
失效樣態      兩種，形狀不同，腳本分開報（2026-11-05 實測）：
                連結無效    110 bytes  "Qt4aBe",null,null,null,[13]        → 重貼也沒用，要重新分享
                分享已結束  302 bytes  "Qt4aBe","[null,null,…,1800,<ts>]"  → 連結對，請他再開一次
              都是 200，不是 4xx。那個 1800 疑似輪詢間隔秒數，未驗、不解讀
新鮮度        ts 每次呼叫都在前進（實測 +60 s），age 可當精度代理
              ⚠️ 同一次實測稍後：ts 停住 15 分鐘以上但座標照回（分享仍開）—— 手機靜止或 app 退背景
              → HYPOTHESIS：Google 只在移動時推新點。耗電監測 log 同時記 age，看靜止時是否恢復
              2026-11-04 20:37–21:07 每 10 分鐘讀一次（4 筆，之後被系統因記憶體不足中止）：
                age  989 → 19 → 279 → 880    更新是【一陣一陣】的，中間 15 分鐘沒更新屬正常
                → 支持上面的 HYPOTHESIS（手機被拿起／移動時才推），規矩④成立
              電量 70 → 65 → 65 → 65（30 分鐘，未充電）
                🔴 不能算每小時耗電：第一筆 70 是 16 分鐘前的舊值（跟位置一起回，age 989），
                   有效區間只有 20 分鐘且整數 % 解析度太粗。要量至少跑 2 小時且分享要一直活著
              電量值跟座標一樣會「過期」—— 讀到的是上次回報時的電量，不是此刻
瀏覽器側      未登入 profile 看得到分享者列（姓名、剛剛、電量）但座標畫在 canvas，URL/DOM 沒有
              🔴 登入分享者【自己的】帳號反而看不到（頁面寫「朋友分享後會在此顯示」）
              → 本機 Chrome 擴充套件那條路對使用者本人無效，別再試
```
⚠️ 未知：ts 後面那個整數（實測 6）是什麼。沒文件，不解讀。

**⚠️ 仍是 HYPOTHESIS**：
```
Apple「分享我的位置」實際格式   推測 https://maps.apple.com/?ll=<lat>,<lng>&q=My%20Location
                                q= 標籤各語系不同，腳本白名單 SELF_LABELS 是推測 —— 沒有真連結可驗
Google 藍點在空曠處時            會不會改回 /place/<lat>,<lng>/ 不吸附？只有一個市區樣本
```
驗法：第一次拿到 Apple 連結、或在公園／河堤等空曠處分享一次 → 跑 parse-loc.py 對一次。

## E-09 hook 能力邊界（平台事實）

```
查核日 2026-11-01   有效天數 60   環境 Claude Code 2.1.316
來源 官方文件 + 本機實測
```

```
已實測
  Read 的 tool_input 欄位名 = file_path
  subagent transcript 獨立存在於 <session>/subagents/agent-{agentId}.jsonl
    內含 isSidechain:true 與 agentId

官方文件記載（未親自實測）
  PreToolUse/PostToolUse 在 subagent 內同樣觸發，輸入帶 agent_id / agent_type
  SubagentStop 事件存在，輸入帶 agent_transcript_path
  exit 2 可擋
```

**能判／不能判的分界**（這條最重要）：

```
hook 判得了  這份產出的形狀對不對、該跑的步驟跑了沒、該同步的檔同步了沒
hook 判不了  內容是不是真的、這個選擇對不對
```

F／D／E 三類（93 次，68%）全在後者，**不可由 hook 承擔**。
