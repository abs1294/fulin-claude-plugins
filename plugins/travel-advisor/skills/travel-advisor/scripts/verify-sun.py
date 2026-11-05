#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""驗 now.py 的日落公式 —— 對第三方 API 逐點比對。

為什麼要有這支
--------------
使用者要求「100% 要有第三方來源背書」。日落若用公式算，公式本身就是個事實主張。
我自己寫的公式、我自己說「誤差 <2 分」—— 那是自驗，不算數。
這支拿 sunrise-sunset.org（獨立營運主體）當真值逐點比，把誤差印出來。

全域 CLAUDE.md 的「驗證器對施作器盲區同構」條款：本支刻意不重用 now.py 的任何
計算碼，只呼叫它的公開介面並對外部真值比，所以不共用盲區。

用法
----
  python scripts/verify-sun.py              跑內建測試點
  python scripts/verify-sun.py --tolerance 2   容許誤差（分鐘），預設 2

exit code
---------
  0  全部在容許誤差內
  3  有測試點超出容許誤差
  2  環境缺 IANA 時區庫（Windows 的 Python 沒內建，見下）—— 不是驗證失敗
  1  網路或解析失敗（無法驗證，不是驗證失敗 —— 兩者要分清楚）

🔴 exit 1 和 exit 2 刻意分開。兩者的處置完全不同：
     1 = 等網路好再跑
     2 = pip install --user tzdata
   2026-11-01 實測本機就是 exit 2 的情況，但當時它回 exit 1，
   訊息還寫「要用 IANA 格式，例 Asia/Tokyo」—— 而使用者給的就是 Asia/Tokyo。
   照那個訊息除錯會原地打轉。所以不可共用同一個 code。
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request
from datetime import date as _date
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

sys.path.insert(0, str(Path(__file__).resolve().parent))
# now.py 在 module 層跑 _ensure_tzdata()，import 它就會把 user site-packages
# 補回 sys.path（python -I 會把那條路徑拿掉）。所以這行 import 有副作用，
# 而那個副作用是必要的 —— 不要為了「乾淨」改成延遲 import。
from now import _TZDATA_STATUS, sun_times  # noqa: E402  只用公開介面，不重用內部計算

if _TZDATA_STATUS.startswith("fail"):
    print("CANNOT-VERIFY: 這台機器沒有 IANA 時區資料庫，無法建立 Asia/Tokyo 這類時區。")
    print("")
    print("  原因：Windows 的 CPython 不像 Linux/macOS 有 /usr/share/zoneinfo，")
    print("        必須額外安裝 tzdata 套件。")
    print("  修法：python -m pip install --user tzdata")
    print("")
    print("  ⚠️ 裝好之後若仍失敗，檢查是不是用 python -I 跑 ——")
    print("     -I 是 isolated mode，會排除 user site-packages。")
    print("     now.py 已內建補路徑的處理，但它回報的狀態是：" + _TZDATA_STATUS)
    print("")
    print("  這是【無法驗證】，不是【驗證失敗】。日落公式本身沒有被判定為錯。")
    sys.exit(2)

# (說明, lat, lng, IANA 時區, 日期)
# 刻意涵蓋：北/南半球、高低緯、分點/至點、本次行程實際地點
CASES = [
    ("大阪 行程首日",   34.6937, 135.5023, "Asia/Tokyo",       "2026-10-24"),
    ("大阪 行程末日",   34.6937, 135.5023, "Asia/Tokyo",       "2026-10-30"),
    ("京都",            35.0116, 135.7681, "Asia/Tokyo",       "2026-10-28"),
    ("台北",            25.0330, 121.5654, "Asia/Taipei",      "2026-11-01"),
    ("雪梨 夏至",      -33.8688, 151.2093, "Australia/Sydney", "2026-12-21"),
    ("墨爾本 冬至",    -37.8136, 144.9631, "Australia/Sydney", "2026-06-21"),
    ("雷克雅維克 高緯", 64.1466, -21.9426, "Atlantic/Reykjavik", "2026-03-20"),
    ("新加坡 赤道",      1.3521, 103.8198, "Asia/Singapore",   "2026-09-23"),
    ("倫敦 跨 DST",     51.5074,  -0.1278, "Europe/London",    "2026-06-21"),
]

API = "https://api.sunrise-sunset.org/json?lat={lat}&lng={lng}&date={date}&formatted=0"


def third_party(lat: float, lng: float, d: str, tz: ZoneInfo):
    """問第三方。回 (sunrise_local, sunset_local)。"""
    url = API.format(lat=lat, lng=lng, date=d)
    req = urllib.request.Request(url, headers={"User-Agent": "travel-advisor-verify/1.0"})
    with urllib.request.urlopen(req, timeout=20) as r:
        payload = json.loads(r.read().decode("utf-8"))
    if payload.get("status") != "OK":
        raise ValueError(f"API 回 status={payload.get('status')!r}")
    res = payload["results"]
    sr = datetime.fromisoformat(res["sunrise"]).astimezone(tz)
    ss = datetime.fromisoformat(res["sunset"]).astimezone(tz)
    return sr, ss


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="對第三方驗日落公式")
    p.add_argument("--tolerance", type=float, default=2.0, help="容許誤差（分鐘）")
    args = p.parse_args(argv)

    print(f"真值來源：api.sunrise-sunset.org（獨立營運主體）")
    print(f"容許誤差：{args.tolerance} 分鐘")
    print(f"比對時間：{datetime.now().astimezone():%Y-%m-%d %H:%M %Z}")
    print()
    header = f"{'測試點':<18} {'日期':<11} {'項目':<5} {'now.py':<7} {'第三方':<9} {'差(分)':>7}  判定"
    print(header)
    print("-" * len(header))

    worst = 0.0
    failures: list[str] = []
    net_errors: list[str] = []

    for label, lat, lng, tzname, dstr in CASES:
        tz = ZoneInfo(tzname)
        d = _date.fromisoformat(dstr)

        try:
            ref_sr, ref_ss = third_party(lat, lng, dstr, tz)
        except (urllib.error.URLError, TimeoutError, ValueError,
                json.JSONDecodeError, KeyError) as e:
            net_errors.append(f"{label}: {type(e).__name__}: {e}")
            print(f"{label:<18} {dstr:<11} {'—':<5} {'—':<7} {'—':<9} {'—':>7}  ⚠️ 取不到真值")
            continue

        mine_sr, mine_ss, _ = sun_times(d, lat, lng, tz)

        for item, mine, ref in (("日出", mine_sr, ref_sr), ("日落", mine_ss, ref_ss)):
            if mine is None:
                print(f"{label:<18} {dstr:<11} {item:<5} {'無事件':<7} "
                      f"{ref:%H:%M:%S}  {'—':>7}  ⚠️ 我說無、第三方有")
                failures.append(f"{label} {item}: 我判無事件，第三方給 {ref:%H:%M}")
                continue
            delta = abs((mine - ref).total_seconds()) / 60.0
            worst = max(worst, delta)
            ok = delta <= args.tolerance
            if not ok:
                failures.append(f"{label} {item}: 差 {delta:.2f} 分 "
                                f"(now.py {mine:%H:%M} vs 第三方 {ref:%H:%M:%S})")
            print(f"{label:<18} {dstr:<11} {item:<5} {mine:%H:%M}   "
                  f"{ref:%H:%M:%S}  {delta:>7.2f}  {'✅' if ok else '🔴 超出'}")

    print()
    if net_errors:
        print("取不到真值的測試點（無法驗證 ≠ 驗證失敗）：")
        for e in net_errors:
            print(f"  - {e}")
        print()

    checked = len(CASES) * 2 - len(net_errors) * 2
    if failures:
        print(f"🔴 {len(failures)} 項超出容許誤差（比了 {checked} 項，最大誤差 {worst:.2f} 分）：")
        for f in failures:
            print(f"  - {f}")
        return 3

    if net_errors and checked == 0:
        print("⚠️ 一項都沒比到 —— 網路不通，這次沒有驗證結果")
        return 1

    print(f"✅ 比了 {checked} 項，全部在 {args.tolerance} 分內。最大誤差 {worst:.2f} 分")
    if net_errors:
        print(f"⚠️ 但有 {len(net_errors)} 個測試點取不到真值，覆蓋不完整")
    return 0


if __name__ == "__main__":
    sys.exit(main())
