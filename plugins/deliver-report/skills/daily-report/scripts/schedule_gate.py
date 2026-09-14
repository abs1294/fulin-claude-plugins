#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
schedule_gate.py — 自續鏈的兜底檢查：找出「該寄卻沒寄」的日期，並算出下一次該排的時間。

## 為什麼需要這支

日報的定時觸發走「自續鏈」：寄成功 → 立刻排下一個 recurring:false 的 cron →
到點觸發 → 產稿 → 核可 → 寄出 → 再排下一個。一次只有一個 job 活著，
所以不會爆量、也不受 CronCreate 的 7 天過期限制（那只限 recurring:true）。

但自續鏈有個固有失效模式：**任何一環斷掉，後面全沒了**，而且靜默。
斷鏈的四種成因：
  - 使用者 veto（今天不寄）→ 沒有 mark_sent → 沒排下一次
  - 內容閘擋下 → 沒寄 → 同上
  - cron 到點時 REPL 不是 idle（工具契約：jobs only fire while the REPL is idle）
  - 關掉 Claude Code（job 只活在 session 裡）

recurring:true 至少「這次沒觸發下次還會來」；自續鏈是一次失敗就終止。
本腳本就是那個「發現斷了」的機制——不依賴 cron 有沒有觸發，只看**事實上哪幾天沒寄**。

## 判準（刻意簡單，避免自己變成另一個要維護的曆法引擎）

「該寄的日子」＝ 由 schedule.cron 的**星期欄位**決定（第 5 欄，如 1-5 代表週一到週五）。
不解析分/時/日/月——那些決定「當天幾點」，與「哪一天該有日報」無關。
今天一律不算缺口（今天的還沒到寄送時間）。

用法：
  schedule_gate.py check [--project DIR] [--days N] [--json]
  schedule_gate.py next  [--project DIR]        # 算下一次該排的時間，供 CronCreate 用

Exit code（check）：0=無缺口；20=有缺口（Claude 應據此詢問使用者要不要補）
"""
import argparse
import hashlib
import json
import os
import re
import sys
from datetime import datetime, timedelta

if sys.stdout.encoding and sys.stdout.encoding.lower() not in ("utf-8", "utf8"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

BASE_DIR = os.path.join(os.path.expanduser("~"), ".claude", "daily-report")
CONFIG_PATH = os.path.join(BASE_DIR, "config.json")
SENT_DIR = os.path.join(BASE_DIR, "sent")
DEFAULT_LOOKBACK_DAYS = 30


def die(msg, code=1):
    print("ERROR: " + msg, file=sys.stderr)
    sys.exit(code)


def scope_key(project_dir=None):
    """必須與 send_common.scope_key / confirm_gate.scope_key 完全一致，
    否則查不到別人寫的 sent 標記，會把「已寄」誤報成缺口。"""
    root = os.path.abspath(project_dir or os.getcwd())
    return hashlib.sha256(os.path.normcase(root).encode("utf-8")).hexdigest()[:10]


def load_schedule(project_dir=None):
    """讀 schedule 區塊：專案層優先，家目錄次之。與 confirm_gate.wait_minutes 同一套分層。"""
    sched = {}
    for path in (CONFIG_PATH,
                 os.path.join(os.path.abspath(project_dir or os.getcwd()),
                              ".claude", "daily-report.json")):
        if not os.path.exists(path):
            continue
        try:
            with open(path, encoding="utf-8") as fh:
                cfg = json.load(fh) or {}
        except (json.JSONDecodeError, OSError):
            continue
        s = cfg.get("schedule")
        if isinstance(s, dict):
            sched.update({k: v for k, v in s.items() if not k.startswith("_")})
    return sched


# ── cron 星期欄位解析 ────────────────────────────────────────────────
# 只解析第 5 欄，且只支援 cron 的常見寫法。看不懂就回 None（＝每天都該寄），
# 寧可多報缺口讓使用者自己判斷，也不要因為解析失敗就靜默地什麼都不報。
_DOW_NAMES = {"sun": 0, "mon": 1, "tue": 2, "wed": 3, "thu": 4, "fri": 5, "sat": 6}


def parse_dow(cron_expr):
    """回傳該寄的星期集合（0=週日 … 6=週六）；無法解析或 * 時回 None（＝每天）。"""
    if not cron_expr or not str(cron_expr).strip():
        return None
    fields = str(cron_expr).split()
    if len(fields) < 5:
        return None
    dow = fields[4].strip().lower()
    if dow in ("*", "?"):
        return None

    out = set()
    for part in dow.split(","):
        part = part.strip()
        if not part:
            continue
        # 步進（*/2、1-5/2）先切掉，本腳本不支援步進，整串放棄
        if "/" in part:
            return None
        m = re.match(r"^(\w+)-(\w+)$", part)
        if m:
            a, b = m.group(1), m.group(2)
            a = _DOW_NAMES.get(a, a)
            b = _DOW_NAMES.get(b, b)
            try:
                a, b = int(a), int(b)
            except (TypeError, ValueError):
                return None
            # cron 的 7 也是週日
            a, b = a % 7, b % 7
            if a <= b:
                out.update(range(a, b + 1))
            else:  # 跨週，如 5-1（週五到週一）
                out.update(list(range(a, 7)) + list(range(0, b + 1)))
            continue
        v = _DOW_NAMES.get(part, part)
        try:
            out.add(int(v) % 7)
        except (TypeError, ValueError):
            return None
    return out or None


def cron_hhmm(cron_expr):
    """取 cron 的分與時，回 (hour, minute)；解析不了回 None。"""
    if not cron_expr:
        return None
    f = str(cron_expr).split()
    if len(f) < 2:
        return None
    try:
        minute, hour = int(f[0]), int(f[1])
    except (TypeError, ValueError):
        return None
    if not (0 <= minute <= 59 and 0 <= hour <= 23):
        return None
    return hour, minute


def _py_weekday_to_cron(d):
    """datetime.weekday(): 0=週一…6=週日 → cron: 0=週日…6=週六。"""
    return (d.weekday() + 1) % 7


def sent_dates(project_dir=None):
    """已寄出的日期集合。只看檔名，不讀內容——檔名就是事實來源。"""
    key = scope_key(project_dir)
    out = set()
    if not os.path.isdir(SENT_DIR):
        return out
    suffix = "-{}.json".format(key)
    for name in os.listdir(SENT_DIR):
        if name.endswith(suffix):
            out.add(name[:-len(suffix)])
    return out


def find_gaps(project_dir=None, days=None, today=None):
    """回傳 (缺口日期 list, 用到的參數 dict)。今天不算缺口。"""
    sched = load_schedule(project_dir)
    cron_expr = sched.get("cron", "")
    lookback = days if days is not None else int(
        sched.get("lookback_days", DEFAULT_LOOKBACK_DAYS) or DEFAULT_LOOKBACK_DAYS)

    dows = parse_dow(cron_expr)
    done = sent_dates(project_dir)
    today = today or datetime.now().date()

    gaps = []
    for i in range(1, lookback + 1):          # 從昨天往回；今天不算
        d = today - timedelta(days=i)
        if dows is not None and _py_weekday_to_cron(d) not in dows:
            continue
        ds = d.isoformat()
        if ds not in done:
            gaps.append(ds)
    gaps.reverse()                             # 由舊到新，讀起來自然
    return gaps, {"cron": cron_expr, "lookback_days": lookback,
                  "dow_filter": (sorted(dows) if dows else "每天"),
                  "enabled": bool(sched.get("enabled", False))}


def next_fire(project_dir=None, now=None):
    """算下一次該排的觸發時間（自續鏈用）。回傳 datetime 或 None。"""
    sched = load_schedule(project_dir)
    hm = cron_hhmm(sched.get("cron", ""))
    if not hm:
        return None
    hour, minute = hm
    dows = parse_dow(sched.get("cron", ""))
    now = now or datetime.now()

    for i in range(1, 15):                     # 最多找兩週
        cand = (now + timedelta(days=i)).replace(
            hour=hour, minute=minute, second=0, microsecond=0)
        if dows is None or _py_weekday_to_cron(cand.date()) in dows:
            return cand
    return None


def cmd_check(args):
    gaps, meta = find_gaps(args.project, args.days)
    if args.json:
        print(json.dumps({"gaps": gaps, **meta}, ensure_ascii=False, indent=2))
    else:
        print("排程設定 : {}（{}）".format(
            meta["cron"] or "(未設定)",
            "已啟用" if meta["enabled"] else "未啟用"))
        print("該寄的日 : {}".format(meta["dow_filter"]))
        print("回溯天數 : {}".format(meta["lookback_days"]))
        if not meta["cron"]:
            print("\n未設定 schedule.cron——無從判斷哪幾天該有日報，不報缺口。")
            return 0
        if gaps:
            print("\n缺口 {} 天（該寄而沒有寄出紀錄）：".format(len(gaps)))
            for g in gaps:
                print("  - " + g)
            print("\n自續鏈可能斷過（veto／內容閘擋下／cron 錯過觸發／Claude Code 關閉）。")
            print("問使用者要不要補，補完記得重新接上鏈（跑 next 拿下一次時間）。")
        else:
            print("\n無缺口。")
    return 20 if gaps else 0


def cmd_next(args):
    nxt = next_fire(args.project)
    if not nxt:
        print("無法算出下一次時間：schedule.cron 未設定或格式不支援（本腳本不支援步進如 */2）。",
              file=sys.stderr)
        return 1
    print(nxt.strftime("%Y-%m-%d %H:%M"))
    print("cron: {} {} {} {} *".format(
        nxt.minute, nxt.hour, nxt.day, nxt.month))
    print("（給 CronCreate 用：recurring:false，一次性；寄成功後再排下一次）")
    return 0


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    c = sub.add_parser("check", help="找出該寄卻沒寄的日期")
    c.add_argument("--project", help="專案目錄（決定 scope 與讀哪份設定）")
    c.add_argument("--days", type=int, help="回溯天數，覆寫設定檔的 lookback_days")
    c.add_argument("--json", action="store_true")
    c.set_defaults(func=cmd_check)

    n = sub.add_parser("next", help="算下一次該排的觸發時間")
    n.add_argument("--project", help="專案目錄")
    n.set_defaults(func=cmd_next)

    args = ap.parse_args()
    if getattr(args, "project", None):
        args.project = os.path.expanduser(args.project)
    sys.exit(args.func(args))


if __name__ == "__main__":
    main()
