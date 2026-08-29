#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
confirm_gate.py — 寄送前的確認窗口機械閘（抄 git-commit A 軌，但把時間判斷交給腳本）。

要解決的問題：
「呈現日報給使用者 → 30 分鐘沒回就自動寄」如果只寫在 SKILL.md，那是自律——
模型可能沒呈現就直接寄、可能沒排喚醒（窗口變成空頭承諾）、可能窗口沒到就搶先寄。
本腳本把這三件事變成可驗證的狀態：

  arm     宣告「已呈現、進入待確認」，寫下窗口到期時間（供寄送時查驗）
  check   查詢目前狀態：still-waiting / ready / vetoed / not-armed / sent
  veto    使用者喊停 → 標記否決，之後的自動寄一律拒絕
  clear   使用者改內容 → 清掉舊狀態（呼叫端須重新 arm，窗口重新計時）

寄送腳本的 --auto（喚醒觸發的自動寄）會強制呼叫 check，狀態不是 ready 就拒寄。
使用者明確說「寄」時走一般路徑（不帶 --auto），不受窗口限制——這是他的意思表示。

仍無法機械化的部分（誠實說明）：
「模型有沒有真的去排喚醒」無法由腳本強制，因為排喚醒是模型的工具呼叫。
緩解方式：arm 會記下預期到期時間，check 在「早該寄卻還沒寄」時回報 overdue，
讓下一次對話能發現漏排，而不是靜默地永遠不寄。

用法：
  confirm_gate.py arm <date> --report <md> --recipients a@x,b@y [--minutes 30] [--project DIR]
  confirm_gate.py check <date> [--project DIR] [--json]
  confirm_gate.py veto <date> [--reason ...] [--project DIR]
  confirm_gate.py clear <date> [--project DIR]

Exit code（check）：0=ready（可寄）；10=still-waiting；11=vetoed；12=not-armed；13=already-sent
"""
import argparse
import hashlib
import json
import os
import sys
from datetime import datetime, timedelta

if sys.stdout.encoding and sys.stdout.encoding.lower() not in ("utf-8", "utf8"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

BASE_DIR = os.path.join(os.path.expanduser("~"), ".claude", "daily-report")
CONFIG_PATH = os.path.join(BASE_DIR, "config.json")
PENDING_DIR = os.path.join(BASE_DIR, "pending")
SENT_DIR = os.path.join(BASE_DIR, "sent")
DEFAULT_WAIT_MIN = 30


def die(msg, code=1):
    print("ERROR: " + msg, file=sys.stderr)
    sys.exit(code)


def wait_minutes(project_dir=None):
    """等待分鐘數：專案層 > 家目錄 > 預設 30。"""
    val = DEFAULT_WAIT_MIN
    for path in (CONFIG_PATH,
                 os.path.join(os.path.abspath(project_dir or os.getcwd()),
                              ".claude", "daily-report.json")):
        if not os.path.exists(path):
            continue
        try:
            with open(path, encoding="utf-8") as fh:
                v = (json.load(fh) or {}).get("confirm_wait_minutes")
            if isinstance(v, (int, float)) and v >= 0:
                val = v
        except (json.JSONDecodeError, OSError):
            pass
    return val


# scope_key / sent_path 的單一事實來源在 send_common——sent 標記由寄送腳本寫、
# 由本檔的 already_sent 讀，兩處若各算各的雜湊就會對不上。故一律從 send_common 取。
# send_common 用 subprocess 呼叫本檔，不 import，所以沒有循環相依。
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from send_common import scope_key, sent_path  # noqa: E402


def state_path(date, project_dir=None):
    return os.path.join(PENDING_DIR, "{}-{}.json".format(date, scope_key(project_dir)))


def report_digest(path):
    """報告內容的指紋——用來偵測「arm 之後內容被改了」。
    防的是：呈現 A 版給使用者、窗口到期時卻寄出被偷改的 B 版（TOCTOU）。"""
    try:
        with open(path, "rb") as fh:
            return hashlib.sha256(fh.read()).hexdigest()[:16]
    except OSError:
        return None


def load_state(date, project_dir=None):
    p = state_path(date, project_dir)
    if not os.path.exists(p):
        return None
    try:
        with open(p, encoding="utf-8") as fh:
            return json.load(fh)
    except (json.JSONDecodeError, OSError):
        return None


def save_state(date, data, project_dir=None):
    os.makedirs(PENDING_DIR, exist_ok=True)
    p = state_path(date, project_dir)
    tmp = p + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    os.replace(tmp, p)


def already_sent(date, project_dir=None):
    # 專案命名空間內的已寄記錄；舊格式（僅日期）一併認，避免升級後重寄
    return (os.path.exists(sent_path(date, project_dir))
            or os.path.exists(os.path.join(SENT_DIR, "{}.json".format(date))))


def cmd_arm(args):
    args.report = os.path.expanduser(args.report)
    if args.project:
        args.project = os.path.expanduser(args.project)
    # reports/ 是模型寫日報的落點，但沒有任何腳本負責建它（紅隊發現）。
    # arm 是第一個碰到報告路徑的閘，由它補建，與 out//pending//sent/ 一致。
    os.makedirs(os.path.join(BASE_DIR, "reports"), exist_ok=True)
    if not os.path.exists(args.report):
        die("找不到報告檔：" + args.report)
    mins = args.minutes if args.minutes is not None else wait_minutes(args.project)
    now = datetime.now()
    due = now + timedelta(minutes=mins)
    recipients = [a.strip() for a in (args.recipients or "").split(",") if a.strip()]
    state = {
        "date": args.date,
        "report": os.path.abspath(args.report),
        "digest": report_digest(args.report),
        "recipients": recipients,
        "cc": [a.strip() for a in (args.cc or "").split(",") if a.strip()],
        "armed_at": now.isoformat(timespec="seconds"),
        "due_at": due.isoformat(timespec="seconds"),
        "wait_minutes": mins,
        "vetoed": False,
    }
    save_state(args.date, state, args.project)
    print("✓ 已進入待確認狀態")
    print("  日期     : " + args.date)
    print("  收件人   : " + (", ".join(recipients) or "(未指定)"))
    print("  窗口     : {} 分鐘，到期 {}".format(mins, due.strftime("%H:%M")))
    print("\n呼叫端注意：**這一輪必須立刻排喚醒**（ScheduleWakeup {}s 或 CronCreate），"
          "否則窗口到期沒有任何東西會觸發寄送。".format(int(mins * 60)))


def cmd_check(args):
    date = args.date
    if already_sent(date, args.project):
        out = {"status": "already-sent", "message": "{} 的日報已寄出".format(date)}
        code = 13
    else:
        st = load_state(date, args.project)
        if not st:
            out = {"status": "not-armed",
                   "message": "尚未呈現給使用者確認（未 arm）——不得自動寄送"}
            code = 12
        elif st.get("vetoed"):
            out = {"status": "vetoed",
                   "message": "使用者已否決：" + (st.get("veto_reason") or "(未附原因)")}
            code = 11
        else:
            now = datetime.now()
            due = datetime.fromisoformat(st["due_at"])
            cur = report_digest(st["report"])
            if cur and st.get("digest") and cur != st["digest"]:
                # 內容在窗口內被改過：使用者看到的不是現在這份，重新 arm 才算數
                out = {"status": "not-armed",
                       "message": "報告內容在確認窗口內被修改（呈現的版本與現在不同）——"
                                  "須重新呈現並 arm"}
                code = 12
            elif now < due:
                left = int((due - now).total_seconds() // 60)
                out = {"status": "still-waiting", "due_at": st["due_at"], "minutes_left": left,
                       "message": "確認窗口未到期，還有約 {} 分鐘".format(left)}
                code = 10
            else:
                over = int((now - due).total_seconds() // 60)
                out = {"status": "ready", "due_at": st["due_at"],
                       "recipients": st.get("recipients", []),
                       "overdue_minutes": over,
                       "message": "窗口已到期（逾 {} 分鐘），可自動寄送".format(over)}
                if over > 60:
                    out["warning"] = ("逾期超過 1 小時——可能是當初沒排喚醒源，"
                                      "本次補寄後請確認喚醒機制")
                code = 0

    if args.json:
        print(json.dumps(out, ensure_ascii=False, indent=2))
    else:
        print("[{}] {}".format(out["status"], out["message"]))
        if out.get("warning"):
            print("  ⚠ " + out["warning"])
    sys.exit(code)


def cmd_veto(args):
    st = load_state(args.date, args.project) or {"date": args.date}
    st["vetoed"] = True
    st["veto_reason"] = args.reason or ""
    st["vetoed_at"] = datetime.now().isoformat(timespec="seconds")
    save_state(args.date, st, args.project)
    print("✓ 已標記否決：{} 的日報不會自動寄出".format(args.date))
    print("  呼叫端請一併刪除已排的喚醒（CronDelete），避免無效觸發。")


def cmd_clear(args):
    p = state_path(args.date, args.project)
    if os.path.exists(p):
        os.remove(p)
        print("✓ 已清除 {} 的待確認狀態（內容有更動時用；需重新呈現並 arm）".format(args.date))
    else:
        print("（{} 本來就沒有待確認狀態）".format(args.date))


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)

    a = sub.add_parser("arm", help="宣告已呈現、進入待確認窗口")
    a.add_argument("date")
    a.add_argument("--report", required=True)
    a.add_argument("--recipients", help="逗號分隔")
    a.add_argument("--cc", help="逗號分隔")
    a.add_argument("--minutes", type=float, help="窗口分鐘數（省略=讀 config，預設 30）")
    a.add_argument("--project")
    a.set_defaults(func=cmd_arm)

    c = sub.add_parser("check", help="查詢是否可自動寄送")
    c.add_argument("date")
    c.add_argument("--project")
    c.add_argument("--json", action="store_true")
    c.set_defaults(func=cmd_check)

    v = sub.add_parser("veto", help="使用者喊停")
    v.add_argument("date")
    v.add_argument("--reason")
    v.add_argument("--project")
    v.set_defaults(func=cmd_veto)

    cl = sub.add_parser("clear", help="清除待確認狀態（內容更動時）")
    cl.add_argument("date")
    cl.add_argument("--project")
    cl.set_defaults(func=cmd_clear)

    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
