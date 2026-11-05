#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
建立新行程的狀態檔。

用法:
    python -I scripts/init-state.py <行程名>     從 skill 根目錄跑（建議）
    python -I scripts/init-state.py 2027-東京
    python -I init-state.py <行程名>             只有 cwd 在 scripts/ 時才成立

🔴 路徑要寫全，理由同 check-cache.py 的註解。

輸出到 skill 的 state/ 目錄。若檔案已存在則拒絕覆寫。

Windows 注意: 本腳本不 print 中文到 stdout (cp950 會亂碼),
只 print 路徑與 ASCII 狀態字。中文內容寫進 UTF-8 檔案,
請用 Read 工具讀該檔確認。
"""
import io
import os
import sys
from datetime import date

TEMPLATE = """# 行程狀態檔：{name}

狀態：規劃中
建立：{today}
最後更新：{today}

繼承：config/user-profile.md

🔴 **每個 session 開頭必讀。每次事實更正 / 被糾正 / 新增排除項，當下寫回。**

🔴 **本檔只寫「本趟獨有」的東西。** 旅伴能力、飲食禁忌、查核門檻、
地區實例都在 user-profile。本檔只放覆寫值（第 4 節）。

⚠️ **禁止整檔複製上一趟。** 複製會把上一趟的已訂飯店、已付款票券一起帶過來，
而那些欄位「有值」會讓檢查通過 —— 比空白更危險。

---

## 0. 即答區（現場秒回用，行前填好）

🔴 **這一節的存在就是為了讓現場不必在「秒回」與「查證」之間二選一。**
裡面每一項都是行前查過的，現場只是讀出來。

```
硬條件摘要：   （不能吃什麼／不能坐什麼／走多慢／單段上限）
已訂位行程：   （時間 / 地點 / 訂位編號）
常用動線：     （飯店↔車站、車站↔主要景點，已實算過的公尺數與分鐘數）
緊急資訊：     （最近醫院／藥局／領事館；當地緊急電話）
當日寄物點：   （站名 / 櫃號尺寸 / 費用 / 營業時間 / 客滿備案）
```

---

## 1. 基本資料

```
行程名稱：{name}
日期：            （出發 ~ 回程）
本趟旅伴：        （列 user-profile 的 id，例：self, spouse）
行程型態：        （家庭旅遊／出差順遊／獨旅）
效率 vs 舒適：    （1–5）
出發國 → 目的地： （決定檢疫雙向查哪兩邊）
語言能力：        （當地語言程度 → 決定訂位方式）
```

🔴 **「本趟旅伴」沒填不要排行程。** Gate-H 的過濾項全部從這裡推導。

---

## 2. 硬約束（不可調動，排行程前必讀）

```
已訂飯店：  日期 / 飯店名 / 地址 / 取消期限 / 是否可改
已訂機票：  航班 / 日期時間 / 機場 / 可否改
已付款票券：票券名 / 使用日期時間 / 可否退改
已訂餐廳：  店名 / 日期時間 / 人數 / 訂位編號 / 取消期限
行李動線：  可否寄放？可否宅配？幾件？尺寸？
```

🔴 **沒有這節就不要排行程。** 整天對調、改住宿城市這類建議，先對這節。

---

## 3. 逐日行程

🔴 **格式是機械判讀的，不要改。** `scripts/now.py --state {name}` 會解析這一節，
用來回答「現在該在哪」。格式壞掉它會說「結構缺」而不是亂猜。

```
日期標題   ### M/D (週)        例：### 10/28 (三)
時刻行     - HH:MM <地點或事項>  例：- 09:00 梅田出發
```

### M/D (週)

- HH:MM （出發／抵達／用餐／景點）

### M/D (週)

- HH:MM

⚠️ **這一節是「計畫」，不是「使用者的實際位置」。**
人會脫稿 —— 晚起、多逛一家、臨時改點。
現場要位置時，這裡的值**只能當問話的預設值**（「我假設你還在道頓堀，對嗎？」），
**不可當事實直接算路線**。
位置要先跑「我的工具清單裡有沒有會回傳座標的工具」這個檢查，
**不要用平台名稱推**（判準、誤判來源表與實測證據見 `references/02-現場即時.md` 1-1a）。

🔴 **排完要跑日落稽核，逐日跑、不要只算一天套全程**：

```
python scripts/now.py --tz <當地時區> --at <座標或地標> --date <YYYY-MM-DD>
```

戶外／山道／公園行程的結束時間要早於「日落 − 設定檔的 日落緩衝_分」。
日落每天差 1–2 分，7 天下來差 10 分以上。

---

## 4. 本趟覆寫（只寫與 user-profile 不同的）

```
（例：spouse 的 max_daily_m 本趟改為 2500，因為天氣熱）
```

沒有覆寫就留空。**不要把 user-profile 的內容抄過來。**

---

## 5. 已排除選項（查過不行的，避免重複推薦）

| 項目 | 類型 | 排除原因 | 違反哪條禁忌 | 查核日期 |
|---|---|---|---|---|
| | 餐廳/景點/商品/路線 | | | |

---

## 6. 本行程特有的坑

通用技術坑在 `references/踩過的坑.md`，會過期的外部事實在 `cache/externals.md`。
**這裡只記本行程獨有的**，不要抄通用的過來。

```
```

---

## 7. 交付物路徑清單

| 類型 | 路徑／URL | 存取方式 | 最後同步 |
|---|---|---|---|
| 本機主檔 | | | |

🔴 改了任一份，全部要同步。預設只做單一本機檔。

---

## 8. 未解懸案（查不到／卡住的，下個 session 接手）

| 問題 | 試過什麼 | 為什麼不通 |
|---|---|---|

---

## 9. 多人條件衝突

### 已裁決

| 衝突項 | 涉及誰 | 使用者的裁決 | 日期 |
|---|---|---|---|

### 未裁決（🔴 必須停下問，不得自行選邊）

| 衝突項 | 涉及誰 |
|---|---|

```
本次優先主體：（未指定時不得假設）
```

---

## 10. 使用者糾正紀錄（同一件事不准再犯）

| 日期 | 使用者原話 | 我的錯 | 意圖對嗎 | 已寫進哪條規則 |
|---|---|---|---|---|

🔴 **「意圖對嗎」這欄是刻意的。** 被糾正時要分開「意圖」與「手段」：
只把錯的手段寫進禁令，對的意圖要留下來變成要求。

> 反例：10-24 建議兩天對調避雨 —— 意圖對（要雨天備案）、手段錯（撞已訂飯店）。
> 原規則把意圖一起丟了，於是「雨天備案」整個消失，還留下一個會抑制正解的教訓。
"""


def main():
    if len(sys.argv) < 2:
        print("ERROR: missing trip name")
        print("usage: python -I scripts/init-state.py <trip-name>   (from skill root)")
        return 1

    name = sys.argv[1]
    here = os.path.dirname(os.path.abspath(__file__))
    state_dir = os.path.join(os.path.dirname(here), "state")
    os.makedirs(state_dir, exist_ok=True)

    path = os.path.join(state_dir, name + ".md")
    if os.path.exists(path):
        print("REFUSED: file exists")
        print(path)
        return 2

    body = TEMPLATE.format(name=name, today=date.today().isoformat())
    with io.open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(body)

    print("CREATED")
    print(path)
    print("NEXT: fill section 2 (hard constraints) before planning anything")
    return 0


if __name__ == "__main__":
    sys.exit(main())
