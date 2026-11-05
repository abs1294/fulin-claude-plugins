#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""讀 Google Maps「即時位置分享」連結 → 分享者此刻的座標。不開瀏覽器、不用登入。

為什麼要有這支
--------------
「分享你的位置」（parse-loc.py 處理的那種）是一次性的，而且 Google 會吸附到最近的店。
「即時位置分享」是持續串流：使用者開一次（1 小時或直到關閉），之後每次問路
我自己拉最新位置，他不用再貼任何東西。這是現場即時拿位置的最佳路徑。

2026-11-04 實測（使用者 iOS Google Maps 真連結）：
  短網址 → https://www.google.com/maps/@/data=!4m5!7m4!1m2!1s<帳號ID>!2s<token>!2e2
  頁面載入時打 POST /maps/_/MapsWizUi/data/batchexecute?rpcids=Qt4aBe
  本體最小形式 f.req=[[["Qt4aBe","[1,null,[[\\"<帳號ID>\\",\\"<token>\\"]]]",null,"generic"]]]
  → 不帶 cookie 重放成功（200），回應含 [null,<lng>,<lat>],<ts_ms>,...,"<反查地址>",...,[<充電>,<電量>]
  → 🔴 座標是【lng, lat】順序，不是 lat, lng
  → 壞 token／壞帳號回 200 但只有 111 bytes 空殼（不是 4xx），要用「有沒有座標」判

用法
----
  python scripts/live-loc.py "<即時分享連結或整則訊息>"
  python scripts/live-loc.py --json "<...>"
  python scripts/live-loc.py --no-net "<...>"      只解析連結，不打端點
  python scripts/live-loc.py --who 太太 "<連結>" --who 爸 "<連結>"     多人：一次讀全部
      → 每人一行 + 兩兩直線距離（haversine，不是步行距離）
      → 標籤只在這次執行的記憶體裡，不落檔；連結同樣不落檔

exit code
---------
  0  拿到位置（多人模式：全部拿到且都新鮮）
  3  端點回了但沒有位置（分享已結束、token 失效、或對方關掉分享；多人模式：任一人如此）
  2  網路失敗（無法讀取 != 分享結束）
  1  輸入裡沒有即時分享連結

🔴 隱私：連結裡有分享者的 Google 帳號 ID 與 token，拿到連結的人都能持續追蹤他。
   本支【不印姓名、頭像】；座標與連結【不可寫進 state/ 或 cache/】（見 config/隱私.md）。

⚠️ 「6」那個欄位（在 ts 後面）意義未知 —— 可能是精度等級或來源類型，沒有文件。
   目前不解讀、不印。要用精度就看 age（幾秒前更新）當代理。
"""
from __future__ import annotations

import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131",
      "Accept-Language": "zh-TW"}
RPC = "https://www.google.com/maps/_/MapsWizUi/data/batchexecute?rpcids=Qt4aBe&hl=zh-TW"
URL_RE = re.compile(r"https?://[^\s<>\"'）」]+")
SHARE_RE = re.compile(r"!1s(\d{15,25})!2s([A-Za-z0-9%+/=_-]+)!2e2")


def follow(url: str, timeout: float = 15.0) -> tuple[str, str | None]:
    try:
        req = urllib.request.Request(url, method="HEAD", headers=UA)
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.geturl(), None
    except urllib.error.HTTPError as e:
        if e.code not in (403, 405):
            return url, f"HTTPError {e.code}"
    except Exception as e:  # noqa: BLE001
        return url, f"{type(e).__name__}: {e}"
    try:
        req = urllib.request.Request(url, headers=UA)
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.geturl(), None
    except Exception as e:  # noqa: BLE001
        return url, f"{type(e).__name__}: {e}"


def parse_share(url: str) -> tuple[str, str] | None:
    """從展開後的 URL 取 (帳號ID, token)。token 在 URL 裡是百分比編碼過的。"""
    m = SHARE_RE.search(url)
    if not m:
        return None
    return m[1], urllib.parse.unquote(m[2])


def read_live(acc: str, tok: str, timeout: float = 20.0) -> dict:
    """打 Qt4aBe。回 dict(ok, lat, lng, ts_ms, age_s, address, battery, charging, err)。"""
    inner = [1, None, [[acc, tok]]]
    freq = json.dumps([[["Qt4aBe", json.dumps(inner, separators=(",", ":")), None, "generic"]]],
                      separators=(",", ":"))
    body = urllib.parse.urlencode({"f.req": freq}).encode()
    req = urllib.request.Request(RPC, data=body, method="POST",
                                 headers={**UA, "Content-Type": "application/x-www-form-urlencoded;charset=utf-8"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read().decode("utf-8", "replace")
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "err": f"{type(e).__name__}: {e}", "net": True}
    u = raw.replace("\\", "")
    m = re.search(r"\[null,(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)\],(\d{13})", u)
    if not m:
        # 2026-11-05 實測兩種失敗長得不一樣，處置不同，要分開講：
        #   連結無效   "Qt4aBe",null,null,null,[13]      → token 或帳號錯，重貼也沒用，要重新分享
        #   分享已結束 "Qt4aBe","[null,null,…,1800,<ts>]" → 連結正確但沒有分享者，請他再開一次
        if re.search(r'"Qt4aBe",null,null,null,\[13\]', u):
            return {"ok": False, "err": "連結無效（token 或帳號錯，錯誤碼 13）", "kind": "invalid", "net": False}
        if re.search(r'"Qt4aBe","\[null,null,', u):
            return {"ok": False, "err": "分享已結束（連結正確，但對方已關掉或時限到）", "kind": "ended", "net": False}
        return {"ok": False, "err": f"回應 {len(raw)} bytes，沒有座標（未知形狀，要看 raw）", "kind": "unknown", "net": False}
    lng, lat, ts = float(m[1]), float(m[2]), int(m[3])
    addr = re.search(r'\],\d{13},\d+,"([^"]*)"', u)
    bat = re.search(r"\[(true|false),(\d{1,3})\]", u)
    return {"ok": True, "lat": lat, "lng": lng, "ts_ms": ts,
            "age_s": max(0, int(time.time() - ts / 1000)),
            "address": addr[1] if addr else None,
            "charging": (bat[1] == "true") if bat else None,
            "battery": int(bat[2]) if bat else None}


def _haversine_m(lat1, lng1, lat2, lng2) -> float:
    import math
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2 - lat1), math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def _resolve_one(text: str, no_net: bool) -> tuple[str, tuple[str, str] | None]:
    """訊息 → (狀態碼, (帳號, token) 或 None)。狀態碼：ok / none / net / notlive / skipnet"""
    urls = URL_RE.findall(text)
    if not urls:
        return "none", None
    url = urls[0]
    final = url
    if not parse_share(url):
        if no_net:
            return "skipnet", None
        final, err = follow(url)
        if err:
            return "net", None
    pair = parse_share(final)
    return ("ok", pair) if pair else ("notlive", None)


def _fresh_tag(age: int) -> str:
    return "✅ 新鮮" if age <= 120 else ("⚠️ 偏舊" if age <= 600 else "🔴 過期，當作沒有位置")


def main_multi(people: list[tuple[str, str]], no_net: bool, as_json: bool) -> int:
    """多人模式。people = [(標籤, 連結或訊息), ...]"""
    rows = []
    worst = 0
    for label, text in people:
        st, pair = _resolve_one(text, no_net)
        if st != "ok":
            msg = {"none": "沒有連結", "net": "短網址展不開（網路）", "notlive": "不是即時分享連結",
                   "skipnet": "--no-net，未展開"}[st]
            rows.append({"who": label, "ok": False, "err": msg})
            worst = max(worst, 2 if st in ("net", "skipnet") else 1)
            continue
        if no_net:
            rows.append({"who": label, "ok": False, "err": "--no-net，未讀位置"})
            continue
        r = read_live(*pair)
        r["who"] = label
        rows.append(r)
        if not r["ok"]:
            worst = max(worst, 2 if r.get("net") else 3)
        elif r["age_s"] > 600:
            worst = max(worst, 3)
    if as_json:
        print(json.dumps(rows, ensure_ascii=False))
        return worst
    for r in rows:
        if not r["ok"]:
            print(f"{r['who']:<6} ✗ {r['err']}")
            continue
        print(f"{r['who']:<6} {r['lat']:.6f},{r['lng']:.6f}  {r['age_s']} 秒前 {_fresh_tag(r['age_s'])}"
              + (f"  電量 {r['battery']}%" if r.get("battery") is not None else ""))
        if r.get("address"):
            print(f"       {r['address']}")
    good = [r for r in rows if r["ok"]]
    if len(good) >= 2:
        print("直線距離（不是步行距離，步行要再乘繞路係數）：")
        for i in range(len(good)):
            for j in range(i + 1, len(good)):
                d = _haversine_m(good[i]["lat"], good[i]["lng"], good[j]["lat"], good[j]["lng"])
                print(f"  {good[i]['who']} ↔ {good[j]['who']}  {d:,.0f} m")
    return worst


def main(argv: list[str]) -> int:
    as_json = "--json" in argv
    no_net = "--no-net" in argv
    # 多人模式：--who <標籤> <連結>，可重複
    people: list[tuple[str, str]] = []
    rest: list[str] = []
    i = 0
    while i < len(argv):
        if argv[i] == "--who" and i + 2 < len(argv):
            people.append((argv[i + 1], argv[i + 2])); i += 3; continue
        if argv[i] == "--who":
            print("usage: --who <標籤> <連結>  （--who 後面要跟兩個參數）")
            return 1
        rest.append(argv[i]); i += 1
    if people:
        return main_multi(people, no_net, as_json)
    args = [a for a in rest if a not in ("--json", "--no-net")]
    if not args:
        print('usage: live-loc.py [--json] [--no-net] "<即時分享連結或訊息>"')
        return 1
    text = " ".join(args)
    urls = URL_RE.findall(text)
    if not urls:
        print("NONE  輸入裡沒有連結")
        return 1
    url = urls[0]
    final = url
    if not parse_share(url):
        if no_net:
            print(f"SKIP-NET  要展開短網址才知道是不是即時分享：{url}")
            return 2
        final, err = follow(url)
        if err:
            print(f"NET-FAIL  展開短網址失敗：{err}")
            return 2
    pair = parse_share(final)
    if not pair:
        print(f"NOT-LIVE  這不是即時位置分享連結（沒有 !1s<帳號>!2s<token>!2e2）：{final[:140]}")
        print("          一次性的「分享你的位置」請用 scripts/parse-loc.py")
        return 1
    acc, tok = pair
    if no_net:
        print(f"PARSED  帳號ID長度={len(acc)}  token長度={len(tok)}  （--no-net，未讀位置）")
        return 0
    r = read_live(acc, tok)
    if not r["ok"]:
        if r.get("net"):
            print(f"NET-FAIL  {r['err']}")
            return 2
        print(f"NO-POSITION  {r['err']}")
        if r.get("kind") == "ended":
            print("             → 請使用者在 Google Maps 重新開「位置資訊分享」，選「直到關閉」，再貼新連結")
        elif r.get("kind") == "invalid":
            print("             → 連結貼錯或被截斷，請使用者重新複製一次")
        else:
            print("             → 請使用者確認 Google Maps 的「位置資訊分享」還開著，或重新分享一次")
        return 3
    if as_json:
        print(json.dumps(r, ensure_ascii=False))
    else:
        age = r["age_s"]
        fresh = "✅ 新鮮" if age <= 120 else ("⚠️ 偏舊" if age <= 600 else "🔴 過期，當作沒有位置")
        print(f"OK  {r['lat']:.6f},{r['lng']:.6f}  更新於 {age} 秒前 {fresh}")
        if r["address"]:
            print(f"    反查地址：{r['address']}")
        if r["battery"] is not None:
            print(f"    手機電量 {r['battery']}%{'（充電中）' if r['charging'] else ''}")
        if age > 600:
            return 3
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
