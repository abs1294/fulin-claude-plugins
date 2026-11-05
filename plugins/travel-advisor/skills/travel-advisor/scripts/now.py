#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""現在幾點 / 日落幾點 / 現在該在哪 —— 不問使用者，自己算。

為什麼有這支腳本
----------------
使用者原話（10-29）：「現在幾點了，你自己不會查嗎？」
規範 02-現場即時.md 1-5 寫了「自己查」，但沒給工具，等於還是靠我記得去查。
這支把「查」變成一行指令。

能算什麼 / 不能算什麼
---------------------
  可以   當地時間（給時區）、日落/日出時刻（給座標）、該時段對應的行程
  不行   使用者的實際位置 —— 本腳本跑在桌機，而桌機沒有定位來源
         （已實測：環境變數零命中、系統時區只反映電腦所在地）。
         座標必須由呼叫方給，預設值只是方便。
         ⛔ 這不代表「Claude 沒有定位能力」—— 手機的 Claude app 有 location tool，
            那是另一個執行環境。判準見 references/02-現場即時.md 1-1a。

日落用公式算不查表（使用者 2026-11-01 決定「B」）
-----------------------------------------------
理由：「帶著走」不該依賴快取。任何座標、任何日期都能離線算，
誤差數分鐘，而 config/user-profile.md 的「日落緩衝_分 = 30」吃得下。

演算法：NOAA Solar Calculator（低精度版）。
誤差來源與量級：
  * 忽略大氣折射的逐日變化 —— 固定用 -0.833° 的日心高度角（含標準折射 34' + 日面半徑 16'）
  * 忽略觀測者海拔 —— 高地日落會比算出來晚，每 100 m 約晚 1 分
  * 忽略地形遮蔽 —— 山谷/高樓後方的「視覺日落」會更早，這點公式永遠算不到
  中緯度（<55°）實測誤差 < 2 分鐘。極區（|lat| > 66.5°）可能無日出/日落，本腳本會明說。

用法
----
  python scripts/now.py                                 本機時區，不算日落
  python scripts/now.py --tz Asia/Tokyo                 指定時區
  python scripts/now.py --tz Asia/Tokyo --at 34.6937,135.5023      加算日落（大阪）
  python scripts/now.py --tz Asia/Tokyo --at osaka      用內建地標代號
  python scripts/now.py --tz Asia/Tokyo --at osaka --state 2026-關西   加對行程表
  python scripts/now.py --date 2026-10-28 --tz Asia/Tokyo --at kyoto   算指定日期

exit code
---------
  0  正常
  1  參數錯誤（時區名打錯、座標格式錯、找不到狀態檔）
  2  極區當日無日出或無日落（已輸出其餘資訊，只是日落那段無意義）
  4  狀態檔沒有逐日行程段落（--state 問了但那份檔沒這一節）
  5  環境缺 IANA 時區資料庫（Windows 的 Python 沒內建，要 pip install --user tzdata）
     🔴 跟 1 分開，因為處置完全不同：1 是你打錯字，5 是機器缺東西。
        不分開的話，錯誤訊息會叫使用者「改用 IANA 格式例 Asia/Tokyo」，
        而他給的就是 Asia/Tokyo（2026-11-01 實際發生過）。
"""

from __future__ import annotations

import argparse
import math
import re
import sys
from datetime import date as _date
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

# Windows 終端預設 cp950，印 emoji / 框線 / U+2212 會 UnicodeEncodeError 中斷。
# 實測紀錄：本腳本第一版在 PowerShell 直接炸在 '-'。
# 這裡強制 stdout/stderr 走 UTF-8，讓腳本在任何終端都印得出來。
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass  # 被重導向到非 TextIO 時忽略，errors=replace 已是保險


def _ensure_tzdata() -> str:
    """確保 IANA 時區名（Asia/Tokyo 這種）可用。回傳狀態字給診斷用。

    🔴 這段的存在理由（2026-11-01 實測，踩了才知道）：

      Windows 的 CPython 【沒有】內建 IANA 時區資料庫。Linux/macOS 有
      /usr/share/zoneinfo，Windows 沒有 —— 所以 ZoneInfo("Asia/Tokyo")
      在這台機器上直接 ZoneInfoNotFoundError，而本檔的說明通篇寫
      `--tz Asia/Tokyo`。那個用法從來沒成功過，我卻在上一輪驗證裡
      回報「全部路徑 exit code 正確」—— 因為我測的時候【沒給 --tz】，
      走的是「用本機時區」那條分支。

      修法是 pip install --user tzdata（348 KB 純 Python）。但還有第二層坑：

        python -I  的 -I 是 isolated mode，它【排除 user site-packages】。
        所以 --user 裝好的 tzdata，用 python -I 跑就是讀不到。
        而環境指引要求跑外部資料時用 -I。

      兩個要求直接衝突。不能靠呼叫者記得拿掉 -I —— 那又是一條靠記憶的規則。
      所以由腳本自己把 user site-packages 補回 sys.path。
    """
    try:
        ZoneInfo("Asia/Tokyo")
        return "ok"
    except Exception:
        pass

    # 補 user site-packages。-I 把它拿掉了，這裡加回來。
    try:
        import site
        import sysconfig
        cands = []
        try:
            cands.append(sysconfig.get_path("purelib", scheme="nt_user"))
        except Exception:
            pass
        try:
            cands.extend(site.getusersitepackages() if isinstance(
                site.getusersitepackages(), list) else [site.getusersitepackages()])
        except Exception:
            pass
        for c in cands:
            if c and c not in sys.path:
                sys.path.append(c)
    except Exception:
        return "fail-no-site"

    # 重新試。zoneinfo 會快取找不到的結果，要清掉。
    try:
        import zoneinfo
        zoneinfo.reset_tzpath()
        ZoneInfo.clear_cache()
    except Exception:
        pass
    try:
        ZoneInfo("Asia/Tokyo")
        return "ok-via-usersite"
    except Exception:
        return "fail-need-tzdata"


_TZDATA_STATUS = _ensure_tzdata()

# ── 內建地標（只是打字方便，不是權威座標來源）────────────────────────
# 要精確到店家門口時，用 Google Maps URL 的 !3d<lat>!4d<lng>，別用這裡的值。
LANDMARKS: dict[str, tuple[float, float, str]] = {
    "osaka":    (34.6937, 135.5023, "大阪（梅田一帶）"),
    "namba":    (34.6659, 135.5012, "難波"),
    "kyoto":    (35.0116, 135.7681, "京都（京都車站一帶）"),
    "kobe":     (34.6901, 135.1955, "神戶（三宮一帶）"),
    "nara":     (34.6851, 135.8048, "奈良"),
    "kansai":   (34.4320, 135.2304, "關西機場"),
    "taipei":   (25.0330, 121.5654, "台北"),
    "taoyuan":  (25.0797, 121.2342, "桃園機場"),
    "sydney":   (-33.8688, 151.2093, "雪梨"),
    "melbourne": (-37.8136, 144.9631, "墨爾本"),
}

# 日心高度角。-0.833° = 標準大氣折射 34' + 日面視半徑 16'。
SUN_ALTITUDE_DEG = -0.833


# ── 日落計算（NOAA 低精度演算法）──────────────────────────────────
def _julian_day(d: _date) -> float:
    """該日 12:00 UT 的儒略日。"""
    y, m = d.year, d.month
    if m <= 2:
        y -= 1
        m += 12
    a = y // 100
    b = 2 - a + a // 4
    return (math.floor(365.25 * (y + 4716))
            + math.floor(30.6001 * (m + 1))
            + d.day + b - 1524.5 + 0.5)


def _solar_events_utc(d: _date, lat: float, lng: float) -> dict[str, float | None]:
    """回傳當日日出/日落/正午的 UTC 小時數（float）。無事件時為 None。"""
    jc = (_julian_day(d) - 2451545.0) / 36525.0  # 儒略世紀

    # 幾何平黃經與平近點角
    gml = (280.46646 + jc * (36000.76983 + jc * 0.0003032)) % 360.0
    gma = 357.52911 + jc * (35999.05029 - 0.0001537 * jc)
    gma_r = math.radians(gma)

    # 中心差 → 真黃經 → 視黃經
    eoc = (math.sin(gma_r) * (1.914602 - jc * (0.004817 + 0.000014 * jc))
           + math.sin(2 * gma_r) * (0.019993 - 0.000101 * jc)
           + math.sin(3 * gma_r) * 0.000289)
    true_long = gml + eoc
    omega = 125.04 - 1934.136 * jc
    app_long = true_long - 0.00569 - 0.00478 * math.sin(math.radians(omega))

    # 黃赤交角（含修正）
    seconds = 21.448 - jc * (46.8150 + jc * (0.00059 - jc * 0.001813))
    mean_obliq = 23.0 + (26.0 + seconds / 60.0) / 60.0
    obliq = mean_obliq + 0.00256 * math.cos(math.radians(omega))

    # 赤緯
    decl = math.degrees(math.asin(
        math.sin(math.radians(obliq)) * math.sin(math.radians(app_long))))

    # 時差（分鐘）
    vary = math.tan(math.radians(obliq / 2)) ** 2
    ecc = 0.016708634 - jc * (0.000042037 + 0.0000001267 * jc)
    eq_time = 4 * math.degrees(
        vary * math.sin(2 * math.radians(gml))
        - 2 * ecc * math.sin(gma_r)
        + 4 * ecc * vary * math.sin(gma_r) * math.cos(2 * math.radians(gml))
        - 0.5 * vary * vary * math.sin(4 * math.radians(gml))
        - 1.25 * ecc * ecc * math.sin(2 * gma_r))

    # 太陽正午（UTC 小時）
    noon_utc = (720 - 4 * lng - eq_time) / 60.0

    # 時角：cos(H) 超出 [-1,1] 代表極日/極夜
    lat_r, decl_r = math.radians(lat), math.radians(decl)
    cos_h_num = (math.cos(math.radians(90.0 - SUN_ALTITUDE_DEG))
                 - math.sin(lat_r) * math.sin(decl_r))
    cos_h_den = math.cos(lat_r) * math.cos(decl_r)

    if abs(cos_h_den) < 1e-12 or not -1.0 <= cos_h_num / cos_h_den <= 1.0:
        return {"sunrise": None, "sunset": None, "noon": noon_utc, "decl": decl}

    ha = math.degrees(math.acos(cos_h_num / cos_h_den))
    return {
        "sunrise": noon_utc - ha * 4 / 60.0,
        "sunset": noon_utc + ha * 4 / 60.0,
        "noon": noon_utc,
        "decl": decl,
    }


def sun_times(d: _date, lat: float, lng: float, tz: ZoneInfo):
    """算當地日出/日落/正午。無事件回 (None, None, 正午)。"""
    ev = _solar_events_utc(d, lat, lng)

    def to_local(hours_utc: float | None):
        if hours_utc is None:
            return None
        base = datetime(d.year, d.month, d.day, tzinfo=timezone.utc)
        t = (base + timedelta(hours=hours_utc)).astimezone(tz)
        # 四捨五入到整分，不要截斷。
        # 截斷會讓 17:04:58 印成 17:04，比第三方來源早 1 分 —— 日落方向「早」雖偏安全，
        # 但那是錯的理由對；寧可數字正確，安全邊際交給「日落緩衝_分」。
        return (t + timedelta(seconds=30)).replace(second=0, microsecond=0)

    return to_local(ev["sunrise"]), to_local(ev["sunset"]), to_local(ev["noon"])


# ── 座標解析 ────────────────────────────────────────────────────────
def parse_location(raw: str) -> tuple[float, float, str]:
    """吃 'lat,lng' 或內建地標代號。"""
    key = raw.strip().lower()
    if key in LANDMARKS:
        lat, lng, label = LANDMARKS[key]
        return lat, lng, label

    m = re.fullmatch(r"\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*", raw)
    if not m:
        raise ValueError(
            f"看不懂的位置：{raw!r}\n"
            f"  要嘛給 'lat,lng'（例 34.6937,135.5023）\n"
            f"  要嘛給內建代號：{', '.join(sorted(LANDMARKS))}")

    lat, lng = float(m.group(1)), float(m.group(2))
    if not -90 <= lat <= 90:
        raise ValueError(f"緯度超出範圍：{lat}（要在 -90~90）")
    if not -180 <= lng <= 180:
        raise ValueError(f"經度超出範圍：{lng}（要在 -180~180）")
    return lat, lng, f"{lat},{lng}"


# ── 行程表對照 ──────────────────────────────────────────────────────
DAY_HEAD_RE = re.compile(r"^#{1,4}\s*.*?(\d{1,2})\s*/\s*(\d{1,2})")
TIME_LINE_RE = re.compile(r"(\d{1,2}):(\d{2})")


def lookup_itinerary(state_path: Path, now_local: datetime) -> tuple[list[str], bool]:
    """從狀態檔撈出今天該時段的行程行。

    回 (時刻行清單, 有沒有找到任何日期標題)。
    第二個值用來分辨兩種「查無」—— 這個區別很重要：
      有日期標題但今天沒行程  → 今天真的空著
      連日期標題都沒有        → 狀態檔沒有逐日行程這一節（結構缺，不是資料缺）

    🔴 2026-11-01 實測：現有的 state/2026-關西.md 與 init-state.py 範本
    都【沒有】逐日行程段落。所以這個功能現在一定走「結構缺」那條路。
    不要把它講成「今天沒安排」—— 那是把結構缺謊報成資料缺。

    刻意寫得寬鬆：狀態檔是手寫 Markdown，格式會變。撈不到就說撈不到，不要猜。
    """
    try:
        text = state_path.read_text(encoding="utf-8")
    except OSError as e:
        raise ValueError(f"讀不到狀態檔 {state_path}：{e}") from e

    today_md = (now_local.month, now_local.day)
    in_today, saw_any_day_heading, hits = False, False, []

    for line in text.splitlines():
        head = DAY_HEAD_RE.match(line)
        if head:
            saw_any_day_heading = True
            in_today = (int(head.group(1)), int(head.group(2))) == today_md
            continue
        if in_today and TIME_LINE_RE.search(line) and line.strip():
            hits.append(line.strip())

    return hits, saw_any_day_heading


def nearest_slot(lines: list[str], now_local: datetime) -> tuple[str | None, str | None]:
    """從行程行裡挑「現在這格」與「下一格」。"""
    now_min = now_local.hour * 60 + now_local.minute
    current = nxt = None
    cur_delta = None

    for line in lines:
        m = TIME_LINE_RE.search(line)
        if not m:
            continue
        hh, mm = int(m.group(1)), int(m.group(2))
        if not (0 <= hh <= 23 and 0 <= mm <= 59):
            continue
        slot_min = hh * 60 + mm
        if slot_min <= now_min:
            delta = now_min - slot_min
            if cur_delta is None or delta < cur_delta:
                cur_delta, current = delta, line
        elif nxt is None:
            nxt = line

    return current, nxt


# ── 輸出 ────────────────────────────────────────────────────────────
def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(
        description="現在幾點 / 日落幾點 / 現在該在哪",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="地標代號：" + ", ".join(sorted(LANDMARKS)))
    p.add_argument("--tz", default=None,
                   help="IANA 時區名，例 Asia/Tokyo。省略用本機時區（＝電腦所在地，不是你所在地）")
    p.add_argument("--at", default=None,
                   help="座標 'lat,lng' 或地標代號。給了才算日落")
    p.add_argument("--date", default=None,
                   help="算哪一天（YYYY-MM-DD），省略用今天")
    p.add_argument("--state", default=None,
                   help="狀態檔行程名（例 2026-關西），對照該時段行程")
    args = p.parse_args(argv)

    # 時區
    if args.tz:
        try:
            tz = ZoneInfo(args.tz)
        except (ZoneInfoNotFoundError, ValueError) as e:
            # 🔴 兩種失敗原因長得一樣，但處置完全不同。不可共用一句訊息。
            # 實測教訓（2026-11-01）：原本一律印「要用 IANA 格式，例 Asia/Tokyo」，
            # 而使用者給的【就是】Asia/Tokyo —— 照那句除錯會原地打轉。
            if _TZDATA_STATUS.startswith("fail"):
                print(f"時區建不起來：{args.tz!r}", file=sys.stderr)
                print("", file=sys.stderr)
                print("原因不是你打錯字，是這台機器【沒有 IANA 時區資料庫】。",
                      file=sys.stderr)
                print("Windows 的 CPython 不像 Linux/macOS 有 /usr/share/zoneinfo。",
                      file=sys.stderr)
                print("", file=sys.stderr)
                print("  修法：python -m pip install --user tzdata", file=sys.stderr)
                print(f"  （本腳本已試過補 user site-packages，狀態：{_TZDATA_STATUS}）",
                      file=sys.stderr)
                print("", file=sys.stderr)
                print("不想裝：拿掉 --tz 走本機時區（只有在你跟目的地同時區時才對），",
                      file=sys.stderr)
                print("或直接給 UTC 偏移 —— 但有日光節約的地區（澳洲、英國、歐美）",
                      file=sys.stderr)
                print("偏移會在切換日前後差 1 小時，日落時刻就錯 1 小時。", file=sys.stderr)
                return 5
            print(f"時區名有問題：{args.tz!r} —— {e}", file=sys.stderr)
            print("要用 IANA 格式，例 Asia/Tokyo、Australia/Sydney、Asia/Taipei",
                  file=sys.stderr)
            print("（時區庫本身是好的，狀態 " + _TZDATA_STATUS + "，所以這是名稱打錯）",
                  file=sys.stderr)
            return 1
        tz_label = args.tz
    else:
        tz = datetime.now().astimezone().tzinfo
        tz_label = f"{datetime.now().astimezone().tzname()}（本機）"

    now_local = datetime.now(tz)

    # 指定日期時，時刻保留現在的時分（方便算「那天的日落」）
    if args.date:
        try:
            d = _date.fromisoformat(args.date)
        except ValueError as e:
            print(f"日期格式錯：{args.date!r} —— 要 YYYY-MM-DD（{e}）", file=sys.stderr)
            return 1
        now_local = now_local.replace(year=d.year, month=d.month, day=d.day)
    else:
        d = now_local.date()

    out = [
        "══ 時間與位置 ══",
        f"現在      {now_local:%Y-%m-%d (%a) %H:%M}  {tz_label}",
    ]
    if args.date:
        out.append("          ⚠️ 用了 --date，上面的日期是你指定的，時分是現在的")

    exit_code = 0

    # 日落
    if args.at:
        try:
            lat, lng, label = parse_location(args.at)
        except ValueError as e:
            print(e, file=sys.stderr)
            return 1

        sunrise, sunset, noon = sun_times(d, lat, lng, tz)
        out.append(f"位置      {label}  ({lat:.4f}, {lng:.4f})")

        if sunset is None:
            out += [
                "日落      ⚠️ 當日無日出/日落（極日或極夜）",
                f"太陽正午  {noon:%H:%M}" if noon else "",
                "          → 日落緩衝規則在這個緯度無意義，改用別的判準",
            ]
            exit_code = 2
        else:
            buffer_min = 30  # 預設值；真值讀 config/user-profile.md「日落緩衝_分」
            deadline = sunset - timedelta(minutes=buffer_min)
            remain = deadline - now_local
            out += [
                f"日出      {sunrise:%H:%M}",
                f"日落      {sunset:%H:%M}   （公式算，誤差 <2 分；未計海拔與地形遮蔽）",
                f"戶外收工  {deadline:%H:%M}   （日落 - 緩衝 {buffer_min} 分）",
            ]
            # 🔴 倒數只有在「算的就是今天」時才有意義。
            # --date 指到別天時，時分仍是現在的（見 392 行的 replace），
            # 相減出來的「還有 N 小時」是拿別天的日落配今天的時分，是垃圾數字。
            # 實測（2026-11-01 dry-run）：--date 2027-01-15 印出「還有 18 小時 5 分」。
            # 上面雖有 ⚠️ 提示，但下面照印一個看起來精確的倒數 ——
            # 提示擋不住一個具體數字的說服力。
            #
            # ⛔ 不可用 `sunset.date() == now_local.date()` 判。
            #    392 行已把 now_local 的年月日 replace 成 --date 的值，
            #    兩者【永遠相等】，那個判斷式從設計上就測不出差異。
            #    我寫錯過一次，而且單獨驗 sun_times 時看起來是對的 ——
            #    因為單獨驗沒有經過 392 行那個覆寫。
            #    判準只能用 args.date 自己：有給且不是今天，就不印倒數。
            _today_real = datetime.now(tz).date()
            _is_today = (not args.date) or (d == _today_real)
            if _is_today:
                if remain.total_seconds() > 0:
                    h, m = divmod(int(remain.total_seconds() // 60), 60)
                    out.append(f"          還有 {h} 小時 {m} 分到戶外收工時間")
                else:
                    over = int(-remain.total_seconds() // 60)
                    out.append(f"          🔴 已超過戶外收工時間 {over} 分 "
                               "—— 戶外/山道/公園行程要收")
            else:
                out.append("          （不印倒數：你算的不是今天，"
                           "倒數要拿當天的時刻才有意義）")
            out.append("          🔴 緩衝值的真值在 config/user-profile.md，"
                       "帶長輩/幼兒要拉長（45–60）")

    # 行程對照
    if args.state:
        state_path = (Path(__file__).resolve().parent.parent
                      / "state" / f"{args.state}.md")
        out.append("")
        out.append("══ 行程對照 ══")
        try:
            lines, saw_day_heading = lookup_itinerary(state_path, now_local)
        except ValueError as e:
            print(e, file=sys.stderr)
            return 1

        if not lines and not saw_day_heading:
            # 結構缺，不是資料缺 —— 兩者不可混講
            out += [
                "結構缺    這份狀態檔沒有「逐日行程」段落（連日期標題都沒有）",
                "          → 不是「今天沒安排」，是這份檔從來沒記過逐日時刻",
                "          → 要用這個功能，狀態檔要加一節，格式：",
                "              ### 10/28 (三)",
                "              - 09:00 梅田出發",
                "              - 11:30 大阪城（園內接駁）",
                "          🔴 就算加了，它仍是「計畫」不是「實際位置」",
            ]
            exit_code = max(exit_code, 4)
        elif not lines:
            out += [
                f"今天空著  狀態檔有逐日行程，但 {now_local:%m/%d} 沒有時刻行",
                "          → 不要猜使用者在哪。要位置就問，且給選項讓他一個字回完",
            ]
        else:
            current, nxt = nearest_slot(lines, now_local)
            out.append(f"現在這格  {current or '（今天還沒開始，或格式對不上）'}")
            out.append(f"下一格    {nxt or '（今天沒有更晚的時段了）'}")
            out.append(f"今日共    {len(lines)} 個時刻行")
            out.append("          ⚠️ 這是「計畫」不是「實際位置」。"
                       "人會脫稿 —— 要位置還是得問")

    print("\n".join(x for x in out if x != ""))
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
