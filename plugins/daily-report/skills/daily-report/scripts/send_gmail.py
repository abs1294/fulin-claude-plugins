#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
send_gmail.py — 把日報 markdown 檔透過 Gmail SMTP 寄給設定檔指定的收件人。

零外部依賴（smtplib + email，純 stdlib）。

設定檔（機密，放家目錄、絕不進 git）：~/.claude/daily-report/config.json
{
  "smtp": { "host": "smtp.gmail.com", "port": 465,
            "user": "you@gmail.com", "app_password": "xxxx xxxx xxxx xxxx" },
  "from_name": "顯示名稱",
  "recipients": ["boss@example.com"],
  "cc": [],
  "subject_prefix": "[工作日報]"
}
app_password = Google 帳戶「應用程式密碼」（需先開兩步驟驗證），不是登入密碼。

用法：
  python send_gmail.py --report <日報.md> --date YYYY-MM-DD [--subject 主旨] [--to a@x,b@y] [--dry-run]

  --dry-run  只印出「將寄給誰、主旨、內文前幾行」，不實際寄送。
             寄信是對外動作——呼叫端（skill 流程）應先 dry-run 給使用者過目確認。

Exit code：0 成功；1 設定/參數錯誤；2 SMTP 失敗。
"""
import argparse
import json
import os
import re
import smtplib
import ssl
import subprocess
import sys
from datetime import datetime
from email.header import Header
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.utils import formataddr

if sys.stdout.encoding and sys.stdout.encoding.lower() not in ("utf-8", "utf8"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

CONFIG_PATH = os.path.join(os.path.expanduser("~"), ".claude", "daily-report", "config.json")


def _scope_key(project_dir=None):
    """與 confirm_gate.scope_key 同演算法——sent 標記必須落在同一個專案命名空間，
    否則 confirm_gate.already_sent() 找不到本腳本寫的記錄。"""
    import hashlib
    root = os.path.abspath(project_dir or os.getcwd())
    return hashlib.sha256(os.path.normcase(root).encode("utf-8")).hexdigest()[:10]


def die(msg, code=1):
    print("ERROR: " + msg, file=sys.stderr)
    sys.exit(code)


PROJECT_CONFIG_REL = os.path.join(".claude", "daily-report.json")


def load_config(project_dir=None):
    if not os.path.exists(CONFIG_PATH):
        die("找不到設定檔 " + CONFIG_PATH + "\n"
            "請依 config.example.json 建立（Gmail 需先開兩步驟驗證、產生應用程式密碼）。")
    try:
        with open(CONFIG_PATH, encoding="utf-8") as fh:
            cfg = json.load(fh)
    except (json.JSONDecodeError, OSError) as e:
        die("設定檔解析失敗：" + str(e))
    # 專案層只覆寫收件人相關欄位（憑證一律留家目錄，不進專案 git）
    proj = os.path.join(os.path.abspath(project_dir or os.getcwd()), PROJECT_CONFIG_REL)
    if os.path.exists(proj):
        try:
            with open(proj, encoding="utf-8") as fh:
                pc = json.load(fh)
            for k in ("recipients", "cc", "subject_prefix", "from_name"):
                if k in pc:
                    cfg[k] = pc[k]
            cfg["_project_config"] = proj
        except (json.JSONDecodeError, OSError) as e:
            die("專案設定檔解析失敗（{}）：{}".format(proj, e))
    smtp = cfg.get("smtp") or {}
    for k in ("user", "app_password"):
        if not smtp.get(k):
            die("設定檔缺 smtp." + k)
    if not cfg.get("recipients"):
        die("設定檔缺 recipients（收件人清單）")
    smtp.setdefault("host", "smtp.gmail.com")
    smtp.setdefault("port", 465)
    return cfg


# 郵件 HTML 的限制決定了這裡的寫法：Gmail 會剝掉 <style> 區塊與多數 CSS 選擇器，
# 所以一律用 inline style；不用 flex/grid（Outlook 不支援），版面靠 table 與 border 撐。
# 目標是「像一份正式的工作報告」，不是像程式輸出。
_FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft JhengHei','PingFang TC',sans-serif"
_INK = "#1a1d21"      # 主文字
_MUTED = "#6b7280"    # 次要文字
_RULE = "#e5e7eb"     # 分隔線
_ACCENT = "#2563eb"   # 標題左側強調條


def md_to_html(md, meta=None):
    """markdown → 郵件用 HTML。meta 可帶 {'date':..., 'subtitle':...} 產生表頭。

    設計取捨：不追求完整 markdown 規格（日報只用到標題、清單、粗體、行內碼），
    把力氣花在排版質感——章節有層次、條目好掃讀、在深色模式下不會爆掉。
    """
    meta = meta or {}
    body = []
    in_list = False

    def close_list():
        nonlocal in_list
        if in_list:
            body.append("</ul>")
            in_list = False

    for line in md.splitlines():
        s = line.rstrip()
        esc = s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        esc = re.sub(r"\*\*(.+?)\*\*", r"<strong style='font-weight:600'>\1</strong>", esc)
        esc = re.sub(
            r"`(.+?)`",
            r"<code style=\"font-family:'SF Mono',Consolas,monospace;font-size:12.5px;"
            r"background:#f3f4f6;color:#374151;padding:1px 5px;border-radius:4px\">\1</code>",
            esc)
        st = esc.strip()
        is_li = st.startswith("- ") or st.startswith("* ")

        if not is_li:
            close_list()

        if not st:
            continue  # 空行不產生節點，間距交給各區塊的 margin 控制
        if st.startswith("# "):
            continue  # 主標題改由表頭呈現，內文不重複
        if st.startswith("### "):
            body.append(
                "<div style='margin:18px 0 6px;font-size:14px;font-weight:600;color:{}'>{}</div>"
                .format(_INK, st[4:]))
        elif st.startswith("## "):
            # 章節標題：左側強調條 + 底線，讓收件人一眼看出區塊分界
            body.append(
                "<div style='margin:26px 0 10px;padding:0 0 7px 11px;"
                "border-left:3px solid {};border-bottom:1px solid {};"
                "font-size:15px;font-weight:600;color:{};letter-spacing:.01em'>{}</div>"
                .format(_ACCENT, _RULE, _INK, st[3:]))
        elif st in ("---", "***"):
            body.append("<div style='height:1px;background:{};margin:22px 0'></div>".format(_RULE))
        elif is_li:
            if not in_list:
                body.append("<ul style='margin:0;padding:0;list-style:none'>")
                in_list = True
            # 自繪項目符號：郵件客戶端對 list-style 的處理差異大，用 table 排版最穩
            body.append(
                "<li style='margin:0 0 7px;padding:0'>"
                "<table role='presentation' cellpadding='0' cellspacing='0' border='0'><tr>"
                "<td style='vertical-align:top;padding:0 9px 0 2px;color:{};font-size:13px;"
                "line-height:1.65'>▪</td>"
                "<td style='vertical-align:top;font-size:14px;line-height:1.65;color:{}'>{}</td>"
                "</tr></table></li>".format(_ACCENT, _INK, st[2:]))
        else:
            body.append(
                "<div style='margin:0 0 9px;font-size:14px;line-height:1.65;color:{}'>{}</div>"
                .format(_INK, st))
    close_list()

    date = meta.get("date", "")
    subtitle = meta.get("subtitle", "")

    # 刻意不在內文放寄件者/寄發時間：郵件 header 本來就有，內文重複是冗餘。
    # 那些資訊屬於「寄出前給作者確認」的範疇，由 confirm_gate 的預覽呈現。
    header = (
        "<div style='padding:0 0 16px;border-bottom:2px solid {};margin:0 0 22px'>"
        "<div style='font-size:11px;font-weight:600;letter-spacing:.09em;"
        "text-transform:uppercase;color:{}'>Daily Report</div>"
        "<div style='margin:7px 0 0;font-size:21px;font-weight:600;color:{};"
        "letter-spacing:-.01em'>{} 工作日報</div>"
        "{}</div>"
    ).format(_RULE, _MUTED, _INK, date,
             "<div style='margin:5px 0 0;font-size:13px;color:{}'>{}</div>".format(_MUTED, subtitle)
             if subtitle else "")

    footer = ("<div style='margin:30px 0 0;padding:13px 0 0;border-top:1px solid {};"
              "font-size:11.5px;color:{}'>本報告依當日工作記錄彙整</div>").format(_RULE, _MUTED)

    # 外層用 table 置中：div + margin:auto 在部分郵件客戶端（尤其 Outlook）不生效
    return (
        "<table role='presentation' cellpadding='0' cellspacing='0' border='0' width='100%' "
        "style='background:#f7f8fa;margin:0;padding:26px 12px'><tr><td align='center'>"
        "<table role='presentation' cellpadding='0' cellspacing='0' border='0' "
        "style='max-width:680px;width:100%;background:#ffffff;border:1px solid {};"
        "border-radius:10px'><tr><td style=\"padding:30px 34px 26px;font-family:{};"
        "color:{};-webkit-font-smoothing:antialiased\">{}{}{}</td></tr></table>"
        "</td></tr></table>"
    ).format(_RULE, _FONT, _INK, header, "\n".join(body), footer)


def build_meta(cfg, date, sender_email=None):
    """組表頭的詮釋資料。寄件者優先顯示姓名（收件人認得的是人不是信箱），
    兩者都有就併呈；寄發時間取當下。"""
    name = (cfg.get("from_name") or "").strip()
    sender = "{} <{}>".format(name, sender_email) if name and sender_email else (name or sender_email or "")
    return {
        "date": date,
        "sender": sender,
        "sent_at": datetime.now().strftime("%Y-%m-%d %H:%M"),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--report", required=True, help="日報 markdown 檔路徑")
    ap.add_argument("--date", required=True, help="YYYY-MM-DD（進主旨）")
    ap.add_argument("--subject", help="自訂主旨；省略 = <subject_prefix> <date> 工作日報")
    ap.add_argument("--to", help="臨時覆寫收件人（逗號分隔），省略 = 設定檔 recipients")
    ap.add_argument("--project", help="專案目錄（省略=目前工作目錄），決定用哪份收件人設定")
    ap.add_argument("--dry-run", action="store_true", help="只預覽不寄送")
    ap.add_argument("--force", action="store_true", help="即使當日已寄過仍重寄")
    ap.add_argument("--auto", action="store_true",
                    help="喚醒觸發的自動寄送：強制通過 confirm_gate 檢查才寄")
    args = ap.parse_args()

    if not os.path.exists(args.report):
        die("找不到日報檔：" + args.report)
    with open(args.report, encoding="utf-8") as fh:
        md = fh.read()
    if not md.strip():
        die("日報檔是空的：" + args.report)

    # SKILL.md 的指令用 ~ 開頭；PowerShell 與 subprocess 不會展開它，
    # 必須在程式裡做（紅隊：作者只在 bash 測過所以沒發現）
    args.report = os.path.expanduser(args.report)
    if getattr(args, "project", None):
        args.project = os.path.expanduser(args.project)

    cfg = load_config(getattr(args, "project", None))
    smtp = cfg["smtp"]
    if args.to:
        # --to 是「臨時覆寫」：連 cc 一併清空。否則拿 --to 自己測試時，
        # 設定檔裡的 cc（可能是主管）會照收測試信——誤寄對外，比漏寄嚴重。
        recipients = [a.strip() for a in args.to.split(",") if a.strip()]
        cc = []
    else:
        recipients = [str(a).strip() for a in cfg["recipients"] if str(a).strip()]
        cc = [str(a).strip() for a in (cfg.get("cc") or []) if str(a).strip()]
    if not recipients:
        die("收件人清單清洗後是空的（--to 只有空白/逗號，或設定檔 recipients 全空）")
    subject = args.subject or "{} {} 工作日報".format(cfg.get("subject_prefix", "[工作日報]"), args.date).strip()

    print("寄件人 : {} <{}>".format(cfg.get("from_name", ""), smtp["user"]))
    if cfg.get("_project_config"):
        print("來源   : " + cfg["_project_config"] + "（專案層覆寫收件人）")
    print("收件人 : " + ", ".join(recipients))
    if cc:
        print("副本   : " + ", ".join(cc))
    print("主旨   : " + subject)
    print("內文   : {} 字（{}）".format(len(md), args.report))

    # 硬閘：內容不得含 AI / 工具鏈描述（與 OAuth 路徑共用同一支檢查，行為一致）
    guard = os.path.join(os.path.dirname(os.path.abspath(__file__)), "content_guard.py")
    if not os.path.exists(guard):
        die("找不到 content_guard.py——內容硬閘缺失，拒絕寄送。", 3)
    _cmd = [sys.executable, guard, args.report]
    if getattr(args, "project", None):
        _cmd += ["--project", args.project]
    _r = subprocess.run(_cmd, capture_output=True, text=True, encoding="utf-8")
    if _r.returncode != 0:
        sys.stderr.write(_r.stderr or _r.stdout or "")
        die("內容檢查未通過，已中止寄送（見上方命中清單）。", 3)

    # 硬閘：--auto（喚醒觸發的自動寄）必須通過確認窗口檢查。
    # 與 OAuth 路徑同規格——兩條寄送路徑的安全閘必須對等，
    # 否則使用者選了「設定較快」的 SMTP 就等於放棄核可保護（紅隊實測發現的缺口）。
    if getattr(args, "auto", False):
        gate = os.path.join(os.path.dirname(os.path.abspath(__file__)), "confirm_gate.py")
        if not os.path.exists(gate):
            die("找不到 confirm_gate.py——自動寄送的確認閘缺失，拒絕寄送。", 5)
        _gcmd = [sys.executable, gate, "check", args.date]
        if getattr(args, "project", None):
            _gcmd += ["--project", args.project]
        _gr = subprocess.run(_gcmd, capture_output=True, text=True, encoding="utf-8")
        if _gr.returncode != 0:
            sys.stderr.write(_gr.stdout or "")
            sys.stderr.write(_gr.stderr or "")
            die("確認窗口檢查未通過，中止自動寄送。"
                "（使用者明確要求寄出時，不要帶 --auto）", 5)
        sys.stdout.write(_gr.stdout or "")

    # 已寄過就不重寄（喚醒重複觸發、session 續接都可能導致重跑）
    _sent_dir = os.path.join(os.path.dirname(CONFIG_PATH), "sent")
    _sent_mark = os.path.join(_sent_dir, "{}-{}.json".format(
        args.date, _scope_key(getattr(args, "project", None))))
    if os.path.exists(_sent_mark) and not args.force and not args.dry_run:
        try:
            with open(_sent_mark, encoding="utf-8") as fh:
                _prev = json.load(fh)
        except (json.JSONDecodeError, OSError):
            _prev = {}
        die("{} 的日報已寄出過（{} → {}）。要重寄請加 --force。".format(
            args.date, _prev.get("sent_at", "?"), ", ".join(_prev.get("recipients", []))), 4)

    if args.dry_run:
        print("\n--dry-run：未寄送。內文前 10 行：")
        for ln in md.splitlines()[:10]:
            print("  | " + ln)
        return

    msg = MIMEMultipart("alternative")
    msg["Subject"] = Header(subject, "utf-8")
    msg["From"] = formataddr((cfg.get("from_name") or smtp["user"], smtp["user"]))
    msg["To"] = ", ".join(recipients)
    if cc:
        msg["Cc"] = ", ".join(cc)
    msg.attach(MIMEText(md, "plain", "utf-8"))
    msg.attach(MIMEText(md_to_html(md, build_meta(cfg, args.date, smtp.get("user"))),
                        "html", "utf-8"))

    try:
        ctx = ssl.create_default_context()
        port = int(smtp["port"])
        # 465 = implicit TLS（SMTP_SSL）；587 = STARTTLS。用錯類別會 SSL handshake
        # 掛到 timeout 才吐難懂錯誤，所以按 port 選對協定，兩種設定都能用。
        if port == 587:
            server_ctx = smtplib.SMTP(smtp["host"], port, timeout=30)
        else:
            server_ctx = smtplib.SMTP_SSL(smtp["host"], port, context=ctx, timeout=30)
        with server_ctx as server:
            if port == 587:
                server.starttls(context=ctx)
            server.login(smtp["user"], smtp["app_password"])
            server.sendmail(smtp["user"], recipients + cc, msg.as_string())
    except smtplib.SMTPAuthenticationError:
        die("SMTP 登入失敗——檢查 app_password 是否正確（須為「應用程式密碼」，"
            "非 Gmail 登入密碼；且帳戶要先開兩步驟驗證）。", 2)
    except (smtplib.SMTPException, OSError) as e:
        die("寄送失敗：" + str(e), 2)

    # 記錄已寄，供重複觸發時擋下（與 OAuth 路徑共用同一個 sent/ 目錄，
    # confirm_gate.already_sent() 也讀這裡——否則 SMTP 寄出後該目錄仍空，
    # 「已寄出」狀態對確認閘不可見）
    try:
        os.makedirs(_sent_dir, exist_ok=True)
        with open(_sent_mark, "w", encoding="utf-8") as fh:
            json.dump({"date": args.date, "recipients": recipients, "cc": cc,
                       "subject": subject, "report": os.path.abspath(args.report),
                       "channel": "smtp",
                       "sent_at": datetime.now().isoformat(timespec="seconds")},
                      fh, ensure_ascii=False, indent=2)
    except OSError:
        pass  # 記錄失敗不該讓「已成功寄出」變成錯誤

    print("✓ 已寄出")


if __name__ == "__main__":
    main()
