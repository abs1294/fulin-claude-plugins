#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""解析使用者貼來的「分享我的位置」連結，吐出座標與可用性判定。

為什麼要有這支
--------------
Remote Control 的訊息不帶 GPS（FetchInboxMessage 的回傳只有 body /
sender_display / slack_permalink，沒有座標欄位；2026-11-04 實測本 session
的訊息也沒附位置）。但手機地圖的「分享我的位置」連結【本身就含座標】——
使用者一鍵貼過來，電腦這邊解析，就拿到手機 GPS 等級的位置。

用法
----
  python scripts/parse-loc.py "<貼來的連結或整段訊息>"
  python scripts/parse-loc.py --no-net "<...>"     不跟轉址（離線測 regex 用）

支援格式
  Apple   https://maps.apple.com/?ll=34.69,135.50&q=...
          https://maps.apple.com/place?coordinate=34.69,135.50&...
  Google  https://maps.app.goo.gl/XXXX           <- 短網址，要跟轉址
          https://www.google.com/maps/@34.69,135.50,17z
          https://www.google.com/maps?q=34.69,135.50
          .../data=...!3d34.69!4d135.50...
          maps.google.com/maps?q=<地址店名>&ftid=0x..:0x..&entry=gps
            ^ 2026-11-04 實測 iOS Google Maps「分享你的位置資訊」真正長這樣：
              【沒有座標】，只有 ftid（地點識別碼）。Google 把藍點吸附到最近的店再分享。
              → 拿 ftid 打 /maps/preview/place 端點，回應裡有 /@lat,lng（不用開瀏覽器）
              → entry=gps 是「這是從藍點分享的」訊號；沒有它就當成「分享地點」
  純文字  "34.6937, 135.5023"

exit code
---------
  0  解析到座標，且判定可當步行起點
     （payload.snapped=true 表示是吸附到最近地點的座標，不是原始 GPS；
       誤差＝使用者到那個地點的距離，通常幾十公尺，仍夠算步行）
  4  解析到座標，但那是【地點】不是【使用者位置】（連結裡有店名／place id）
  3  有連結但解析不到座標
  1  輸入裡沒有任何像連結或座標的東西
  2  跟轉址時網路失敗（無法解析 != 連結壞掉）

「分享我的位置」與「分享這個地點」長得很像，但意義相反：
   前者是使用者站的地方，後者是他點的那家店。
   判準：URL 路徑含 /place/<名稱>/ 或 data 含 !16s（place 識別碼）-> 是地點。
   只有座標、沒有名稱 -> 是位置。判成地點的要回報，不可拿去算步行。
"""
from __future__ import annotations

import json
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

URL_RE = re.compile(r"https?://[^\s<>\"'）」]+")
SHORT_HOSTS = ("maps.app.goo.gl", "goo.gl", "g.co")
COORD = r"(-?\d{1,2}\.\d{3,})\s*,\s*(-?\d{1,3}\.\d{3,})"
UA = {"User-Agent": "Mozilla/5.0 travel-advisor/1.0"}


def follow(url: str, timeout: float = 15.0) -> tuple[str, str | None]:
    """跟轉址到底。回 (最終 URL, 錯誤訊息或 None)。"""
    try:
        req = urllib.request.Request(url, method="HEAD", headers=UA)
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.geturl(), None
    except urllib.error.HTTPError as e:
        if e.code not in (403, 405):
            return url, f"HTTPError {e.code}"
    except Exception as e:  # noqa: BLE001
        return url, f"{type(e).__name__}: {e}"
    # 有些端點對 HEAD 回 403/405，改 GET
    try:
        req = urllib.request.Request(url, headers=UA)
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.geturl(), None
    except Exception as e:  # noqa: BLE001
        return url, f"{type(e).__name__}: {e}"


# 「我的位置」類標籤：各語系地圖 app 分享自身位置時塞進 q=/name= 的字，不是店名。
# 這份清單是推測＋英文一例實測格式（見 cache/externals.md E-05），遇到新語系要補。
SELF_LABELS = {
    "my location", "current location", "dropped pin", "pinned location",
    "我的位置", "目前位置", "現在位置", "放置的大頭針", "已標記的位置",
    "现在位置", "当前位置", "現在地", "ピンの位置", "指定した場所",
}


def _is_self_label(v: str) -> bool:
    return v.strip().lower() in SELF_LABELS


PREVIEW = ("https://www.google.com/maps/preview/place?authuser=0&hl=zh-TW&gl=tw&q=x&pb="
           "%211m2%211s{ftid}%212sx")


def resolve_ftid(ftid: str, timeout: float = 20.0) -> tuple[float, float] | None:
    """ftid -> 座標，不開瀏覽器。
    回應是 )]}' 開頭的 JSON 塊，裡面嵌著該地點的正規 URL /maps/place/<名>/@lat,lng,...
    2026-11-04 實測：最小 pb（只給 ftid）就回 16 KB，座標與 Chrome 改寫後的 !3d!4d 完全一致。
    抓不到回 None（端點改版或網路），呼叫端要分清「無法解析」與「不是座標」。"""
    try:
        req = urllib.request.Request(PREVIEW.format(ftid=ftid), headers=UA)
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = r.read().decode("utf-8", "replace")
    except Exception:  # noqa: BLE001
        return None
    m = re.search(r"/@(-?\d{1,2}\.\d{4,}),(-?\d{1,3}\.\d{4,}),", body)
    return (float(m[1]), float(m[2])) if m else None


def extract(url: str, no_net: bool = False) -> dict:
    """從已展開的 URL 抓座標。回 dict(lat, lng, via, is_place, place_hint)。"""
    u = urllib.parse.urlparse(url)
    qs = urllib.parse.parse_qs(u.query)
    out = {"lat": None, "lng": None, "via": None, "is_place": False, "place_hint": None,
           "snapped": False, "ftid": qs.get("ftid", [None])[0]}

    # 是「地點」而非「位置」的訊號。
    # 兩個假陽性要避開：
    #   ① Apple「分享我的位置」帶 q=My Location（標籤，不是店名）
    #   ② Google 分享位置轉址後是 /maps/place/<lat>,<lng>/（路徑段是座標，不是店名）
    if "/maps/place/" in u.path:
        seg = urllib.parse.unquote_plus(u.path.split("/maps/place/", 1)[1].split("/", 1)[0])
        if seg and not re.fullmatch(COORD, seg.strip()):
            out["is_place"] = True
            out["place_hint"] = seg
    if "!16s" in url or "!1s0x" in url:
        out["is_place"] = True
    for k in ("q", "name", "address"):
        if k in qs:
            v = qs[k][0].strip()
            if re.fullmatch(COORD, v) or _is_self_label(v):
                continue
            out["is_place"] = True
            out["place_hint"] = out["place_hint"] or v

    # Apple: ll= / coordinate= / sll=
    for k in ("ll", "coordinate", "sll"):
        if k in qs:
            m = re.fullmatch(COORD, qs[k][0].strip())
            if m:
                out.update(lat=float(m[1]), lng=float(m[2]), via=f"query {k}=")
                return out
    # Google data=!3d!4d（這對是 place 的精確座標，優先於 @）
    m = re.search(r"!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)", url)
    if m:
        out.update(lat=float(m[1]), lng=float(m[2]), via="data !3d!4d")
        return out
    # Google ?q=lat,lng
    if "q" in qs:
        m = re.fullmatch(COORD, qs["q"][0].strip())
        if m:
            out.update(lat=float(m[1]), lng=float(m[2]), via="query q=")
            return out
    # Google /@lat,lng,zoom
    m = re.search(r"/@" + COORD, url)
    if m:
        out.update(lat=float(m[1]), lng=float(m[2]), via="path @lat,lng")
        return out
    # 只有 ftid、沒有座標（iOS Google Maps 分享位置的實際格式）
    if out["ftid"] and not no_net:
        got = resolve_ftid(out["ftid"])
        if got:
            out.update(lat=got[0], lng=got[1], via="ftid -> preview/place")
            # entry=gps：藍點分享，Google 吸附到最近地點。是【位置】不是【地點】。
            if qs.get("entry", [""])[0] == "gps":
                out["snapped"] = True
                out["is_place"] = False
            return out
    return out


def _delegate_live(text: str, no_net: bool) -> int:
    import importlib.util
    from pathlib import Path
    spec = importlib.util.spec_from_file_location("live_loc", Path(__file__).with_name("live-loc.py"))
    mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
    print("LIVE  這是即時位置分享，轉交 live-loc.py")
    return mod.main((["--no-net"] if no_net else []) + [text])


def main(argv: list[str]) -> int:
    no_net = "--no-net" in argv
    args = [a for a in argv if a != "--no-net"]
    if not args:
        print('usage: parse-loc.py [--no-net] "<貼來的連結或訊息>"')
        return 1
    text = " ".join(args)

    urls = URL_RE.findall(text)
    if not urls:
        m = re.search(COORD, text)
        if m:
            lat, lng = float(m[1]), float(m[2])
            print(json.dumps({"lat": lat, "lng": lng, "via": "純文字座標",
                              "source": "text", "usable_as_origin": True}, ensure_ascii=False))
            print(f"OK  {lat},{lng}  來源=純文字  -> 可當步行起點（精度未知，假設是從手機抄的）")
            return 0
        print("NONE  輸入裡沒有連結也沒有座標")
        return 1

    url = urls[0]
    final, err = url, None
    # 即時位置分享（!2e2）走 live-loc.py —— 它是持續串流，不是一次性連結
    if "!2e2" in url or "即時位置" in text or "实时位置" in text:
        return _delegate_live(text, no_net)
    if any(h in url for h in SHORT_HOSTS):
        if no_net:
            print(f"SKIP-NET  短網址未展開：{url}")
            return 2
        final, err = follow(url)
        if err:
            print(f"NET-FAIL  無法展開短網址 {url}：{err}")
            print("          這是【無法解析】不是【連結壞掉】。等網路好或請使用者改貼長網址。")
            return 2

    if "!2e2" in final:
        return _delegate_live(final, no_net)
    r = extract(final, no_net=no_net)
    if r["lat"] is None:
        if r["ftid"]:
            if no_net:
                print(f"SKIP-NET  URL 只有 ftid={r['ftid']}，要連網才能解析成座標")
                return 2
            print(f"NET-FAIL  ftid={r['ftid']} 打 preview/place 端點拿不到座標（端點改版或網路）")
            print("          這是【無法解析】不是【連結壞掉】。備援：node 開 Chrome 讀改寫後 URL 的 !3d!4d")
            return 2
        print(f"NO-COORD  展開後的 URL 抓不到座標：{final[:160]}")
        return 3

    payload = {"lat": r["lat"], "lng": r["lng"], "via": r["via"],
               "source_url": url, "final_url": final[:200],
               "is_place": r["is_place"], "place_hint": r["place_hint"],
               "snapped": r["snapped"], "ftid": r["ftid"],
               "usable_as_origin": not r["is_place"]}
    print(json.dumps(payload, ensure_ascii=False))
    if r["is_place"]:
        print(f"PLACE  {r['lat']},{r['lng']}  這是【地點】「{r['place_hint']}」，不是使用者的位置")
        print("       -> 不可當步行起點。回問：你是在這家店門口，還是要去這家店？")
        return 4
    if r["snapped"]:
        print(f"OK  {r['lat']},{r['lng']}  來源={r['via']}  -> 藍點分享，Google 吸附到最近地點"
              f"「{r['place_hint']}」；誤差＝使用者到該點的距離（通常數十公尺），可當步行起點")
    else:
        print(f"OK  {r['lat']},{r['lng']}  來源={r['via']}  -> 手機分享的位置，可當步行起點")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
