#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
send_common.py — 兩條寄送路徑（Gmail API OAuth / SMTP）共用的「寄送契約」。

為什麼存在：紅隊發現 send_gmail.py 與 gmail_oauth.py 各自實作同一套前置檢查
（內容閘、確認窗口閘、sent 去重、路徑展開、收件人解析、scope key），而其中一支
漏了兩道閘——「對等性靠複製貼上維持」必然失衡。把契約收進單一模組後，
兩條路徑的安全行為由同一份程式碼保證，不可能再各修一半。

模組的邊界：本檔擁有「寄之前與寄之後要做什麼」；各腳本只擁有「怎麼把郵件送出去」
（SMTP 連線 vs REST 呼叫）。所以本檔不 import smtplib 也不打 Gmail API。

主要進入點：
  prepare_send(args, cfg) -> SendPlan
      展開路徑 → 解析收件人/主旨 → 內容閘 → （--auto 時）確認閘 → sent 去重檢查。
      任一關卡不過就在此 die，呼叫端拿到 SendPlan 時代表「可以送了」。
  mark_sent(plan, channel)
      寄成功後寫 sent 標記（與 confirm_gate 同命名空間，供去重與 already_sent 查驗）。
"""
import hashlib
import json
import os
import subprocess
import sys
from datetime import datetime

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
BASE_DIR = os.path.join(os.path.expanduser("~"), ".claude", "daily-report")
SENT_DIR = os.path.join(BASE_DIR, "sent")
PROJECT_CONFIG_REL = os.path.join(".claude", "daily-report.json")


def die(msg, code=1):
    print("ERROR: " + msg, file=sys.stderr)
    sys.exit(code)


def scope_key(project_dir=None):
    """狀態檔的專案命名空間——必須與 confirm_gate.scope_key 完全一致，
    否則本檔寫的 sent 標記與 confirm_gate 的 already_sent() 對不上。
    這是「單一事實來源」的核心：兩處若各算各的，去重就會漏。"""
    root = os.path.abspath(project_dir or os.getcwd())
    return hashlib.sha256(os.path.normcase(root).encode("utf-8")).hexdigest()[:10]


def sent_path(date, project_dir=None):
    return os.path.join(SENT_DIR, "{}-{}.json".format(date, scope_key(project_dir)))


def expand_paths(args):
    """SKILL.md 的指令用 ~ 開頭；PowerShell 與 subprocess 都不展開它，
    必須在程式裡做（作者只在 bash 測過所以原本沒發現）。"""
    if getattr(args, "report", None):
        args.report = os.path.expanduser(args.report)
    if getattr(args, "project", None):
        args.project = os.path.expanduser(args.project)


def resolve_recipients(args, cfg):
    """決定收件人與副本。

    收件人紀律（安全）：收件人只能來自 (a) --to 臨時覆寫，或 (b) 專案層設定
    <專案>/.claude/daily-report.json。**家目錄的 recipients 不當預設**——
    否則一個沒設定收件人的新專案會默默借用家目錄的收件人（可能是別的專案設的、
    或作者自己）就寄出去，等於「沒問就寄給不相干的人」。
    家目錄只該存憑證（跟人綁定），收件人跟專案綁定，必須各專案自設。

    --to 是臨時覆寫，會連 cc 一併清空——否則自己拿 --to 測試時，
    config 的 cc（可能是主管）會照收測試信。
    """
    if getattr(args, "to", None):
        return [a.strip() for a in args.to.split(",") if a.strip()], []
    # 只有「收件人確實來自專案層」才採用。cfg["_project_config"] 由 load_config
    # 在讀到專案層設定時設定；但它也可能只帶了 subject_prefix 而沒帶 recipients，
    # 所以還要確認專案層那份真的有 recipients。
    proj_path = cfg.get("_project_config")
    proj_has_recipients = False
    if proj_path and os.path.exists(proj_path):
        try:
            with open(proj_path, encoding="utf-8") as fh:
                proj_has_recipients = bool((json.load(fh) or {}).get("recipients"))
        except (json.JSONDecodeError, OSError):
            proj_has_recipients = False
    if not proj_has_recipients:
        die("這個專案沒有設定收件人。\n"
            "  收件人必須在專案自己的 .claude/daily-report.json 設定（家目錄的收件人"
            "不會被當預設，避免誤寄給別的專案的窗口）。\n"
            "  跑首次設定引導，或臨時指定 --to a@x,b@y。", 6)
    recipients = [str(a).strip() for a in (cfg.get("recipients") or []) if str(a).strip()]
    cc = [str(a).strip() for a in (cfg.get("cc") or []) if str(a).strip()]
    return recipients, cc


def make_subject(args, cfg):
    return args.subject or "{} {} 工作日報".format(
        cfg.get("subject_prefix", "[工作日報]"), args.date).strip()


def _run_gate(script_name, gate_args, fail_msg, fail_code):
    """跑一個閘腳本，非 0 就把它的輸出轉給使用者並 die。
    閘與寄送腳本用 subprocess 而非 import：閘要能獨立被 CLI 呼叫，
    而且各閘的 sys.exit 語意不該污染寄送腳本的行程。"""
    gate = os.path.join(SCRIPT_DIR, script_name)
    if not os.path.exists(gate):
        die("找不到 {}——對應的機制閘缺失，拒絕寄送（不冒無檢查寄出的風險）。".format(script_name), fail_code)
    r = subprocess.run([sys.executable, gate] + gate_args,
                       capture_output=True, text=True, encoding="utf-8")
    if r.returncode != 0:
        sys.stderr.write(r.stderr or r.stdout or "")
        die(fail_msg, fail_code)
    sys.stdout.write(r.stdout or "")


def assert_content_clean(report_path, project_dir=None):
    """硬閘：日報不得含 AI/工具鏈用語與憑證/個資/金額。無豁免。"""
    a = [report_path]
    if project_dir:
        a += ["--project", project_dir]
    _run_gate("content_guard.py", a,
              "內容檢查未通過，已中止寄送（見上方命中清單）。", 3)


def assert_confirm_ready(date, project_dir=None):
    """硬閘（僅 --auto）：喚醒觸發的自動寄送必須通過確認窗口。
    使用者明確說「寄」時不帶 --auto，不受此限——那是他的意思表示。"""
    a = ["check", date]
    if project_dir:
        a += ["--project", project_dir]
    _run_gate("confirm_gate.py", a,
              "確認窗口檢查未通過，中止自動寄送。（使用者明確要求寄出時，不要帶 --auto）", 5)


class SendPlan:
    """prepare_send 的產出：一份「已通過所有前置閘、可以送」的寄送計畫。"""
    def __init__(self, md, recipients, cc, subject, date, project_dir):
        self.md = md
        self.recipients = recipients
        self.cc = cc
        self.subject = subject
        self.date = date
        self.project_dir = project_dir


def prepare_send(args, cfg):
    """兩條寄送路徑共用的前置流程。回傳 SendPlan；任一關卡不過就在此 die。

    順序固定：展開路徑 → 讀檔 → 解析收件人 → sent 去重 → 內容閘 →（--auto）確認閘。
    去重放在閘之前：已寄過就沒必要再跑內容/確認檢查。
    """
    expand_paths(args)
    if not os.path.exists(args.report):
        die("找不到日報檔：" + args.report)
    with open(args.report, encoding="utf-8") as fh:
        md = fh.read()
    if not md.strip():
        die("日報檔是空的：" + args.report)

    recipients, cc = resolve_recipients(args, cfg)
    if not recipients:
        die("收件人清單是空的（設定檔 recipients 未設，或 --to 只有空白）")
    subject = make_subject(args, cfg)
    project_dir = getattr(args, "project", None)

    # 已寄過就不重寄（喚醒重複觸發、session 續接都可能導致重跑）。
    # dry-run 不受此限（預覽不算寄出）；--force 可強制重寄。
    mark = sent_path(args.date, project_dir)
    if os.path.exists(mark) and not getattr(args, "force", False) and not getattr(args, "dry_run", False):
        try:
            with open(mark, encoding="utf-8") as fh:
                prev = json.load(fh)
        except (json.JSONDecodeError, OSError):
            prev = {}
        die("{} 的日報已寄出過（{} → {}）。要重寄請加 --force。".format(
            args.date, prev.get("sent_at", "?"), ", ".join(prev.get("recipients", []))), 4)

    assert_content_clean(args.report, project_dir)
    if getattr(args, "auto", False):
        assert_confirm_ready(args.date, project_dir)

    return SendPlan(md, recipients, cc, subject, args.date, project_dir)


def mark_sent(plan, channel):
    """寄成功後寫 sent 標記。與 confirm_gate 同命名空間，供去重與 already_sent 查驗。
    寫失敗不該讓「已成功寄出」變成錯誤，故吞 OSError。"""
    try:
        os.makedirs(SENT_DIR, exist_ok=True)
        with open(sent_path(plan.date, plan.project_dir), "w", encoding="utf-8") as fh:
            json.dump({"date": plan.date, "recipients": plan.recipients, "cc": plan.cc,
                       "subject": plan.subject, "channel": channel,
                       "sent_at": datetime.now().isoformat(timespec="seconds")},
                      fh, ensure_ascii=False, indent=2)
    except OSError:
        pass


def print_preview(plan, channel_label, dry_run):
    """兩條路徑一致的預覽輸出。"""
    print("管道     : " + channel_label)
    print("收件人   : " + ", ".join(plan.recipients))
    if plan.cc:
        print("副本     : " + ", ".join(plan.cc))
    print("主旨     : " + plan.subject)
    print("內文     : {} 字".format(len(plan.md)))
    if dry_run:
        print("\n--dry-run：未寄送。內文前 10 行：")
        for ln in plan.md.splitlines()[:10]:
            print("  | " + ln)
