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
import sys
from email.header import Header
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.utils import formataddr

if sys.stdout.encoding and sys.stdout.encoding.lower() not in ("utf-8", "utf8"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

CONFIG_PATH = os.path.join(os.path.expanduser("~"), ".claude", "daily-report", "config.json")


def die(msg, code=1):
    print("ERROR: " + msg, file=sys.stderr)
    sys.exit(code)


def load_config():
    if not os.path.exists(CONFIG_PATH):
        die("找不到設定檔 " + CONFIG_PATH + "\n"
            "請依 config.example.json 建立（Gmail 需先開兩步驟驗證、產生應用程式密碼）。")
    try:
        with open(CONFIG_PATH, encoding="utf-8") as fh:
            cfg = json.load(fh)
    except (json.JSONDecodeError, OSError) as e:
        die("設定檔解析失敗：" + str(e))
    smtp = cfg.get("smtp") or {}
    for k in ("user", "app_password"):
        if not smtp.get(k):
            die("設定檔缺 smtp." + k)
    if not cfg.get("recipients"):
        die("設定檔缺 recipients（收件人清單）")
    smtp.setdefault("host", "smtp.gmail.com")
    smtp.setdefault("port", 465)
    return cfg


def md_to_html(md):
    """極簡 markdown → HTML（標題/粗體/清單/分隔線），夠日報用即可。
    不引第三方套件——這裡的目標是「郵件客戶端裡看起來乾淨」，不是完整 markdown 規格。"""
    out = ["<div style='font-family:-apple-system,\"Segoe UI\",\"Microsoft JhengHei\",sans-serif;"
           "font-size:14px;line-height:1.7;color:#222;max-width:720px'>"]
    in_list = False
    for line in md.splitlines():
        s = line.rstrip()
        esc = (s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))
        esc = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", esc)
        esc = re.sub(r"`(.+?)`", r"<code style='background:#f2f2f2;padding:1px 4px;border-radius:3px'>\1</code>", esc)
        stripped = esc.strip()
        is_li = stripped.startswith("- ") or stripped.startswith("* ")
        if in_list and not is_li:
            out.append("</ul>")
            in_list = False
        if not stripped:
            out.append("<div style='height:8px'></div>")
        elif stripped.startswith("### "):
            out.append("<h4 style='margin:14px 0 4px'>" + stripped[4:] + "</h4>")
        elif stripped.startswith("## "):
            out.append("<h3 style='margin:18px 0 6px;border-bottom:1px solid #ddd;padding-bottom:3px'>" + stripped[3:] + "</h3>")
        elif stripped.startswith("# "):
            out.append("<h2 style='margin:4px 0 10px'>" + stripped[2:] + "</h2>")
        elif stripped in ("---", "***"):
            out.append("<hr style='border:none;border-top:1px solid #ddd'>")
        elif is_li:
            if not in_list:
                out.append("<ul style='margin:4px 0;padding-left:22px'>")
                in_list = True
            out.append("<li>" + stripped[2:] + "</li>")
        else:
            out.append("<div>" + esc + "</div>")
    if in_list:
        out.append("</ul>")
    out.append("</div>")
    return "\n".join(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--report", required=True, help="日報 markdown 檔路徑")
    ap.add_argument("--date", required=True, help="YYYY-MM-DD（進主旨）")
    ap.add_argument("--subject", help="自訂主旨；省略 = <subject_prefix> <date> 工作日報")
    ap.add_argument("--to", help="臨時覆寫收件人（逗號分隔），省略 = 設定檔 recipients")
    ap.add_argument("--dry-run", action="store_true", help="只預覽不寄送")
    args = ap.parse_args()

    if not os.path.exists(args.report):
        die("找不到日報檔：" + args.report)
    with open(args.report, encoding="utf-8") as fh:
        md = fh.read()
    if not md.strip():
        die("日報檔是空的：" + args.report)

    cfg = load_config()
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
    print("收件人 : " + ", ".join(recipients))
    if cc:
        print("副本   : " + ", ".join(cc))
    print("主旨   : " + subject)
    print("內文   : {} 字（{}）".format(len(md), args.report))

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
    msg.attach(MIMEText(md_to_html(md), "html", "utf-8"))

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

    print("✓ 已寄出")


if __name__ == "__main__":
    main()
