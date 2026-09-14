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


# ── 表格樣式（固定，不可由設定檔調整）────────────────────────────────
# 為什麼硬寫：可調樣式等於重新打開「華麗 HTML」的門，也多一堆設定欄位要驗證。
# 這組值抄自實際寄出且使用者認可的信件（2026-09-14 裁定）：素框線、灰表頭、
# 無配色/無圓角/無陰影——是「表格該有的框線」，不是裝飾。
# 每個 cell 都內嵌 style 是必要的：Gmail 會剝掉 <style> 區塊，只認 inline style。
_TBL_BORDER = "1px solid #d0d0d0"
_TBL_STYLE = ("border-collapse:collapse;font-family:Arial,sans-serif;"
              "font-size:13px;width:100%")
_TH_STYLE = "border:{};background:#f4f4f4;text-align:left".format(_TBL_BORDER)
_TD_STYLE = "border:{};vertical-align:top".format(_TBL_BORDER)

# markdown 表格的對齊分隔列：|:-:|---|:--|--:| 這種。
# 它是語法不是資料——沒認出來就會被當成一般資料列渲染成一行 :-:（實際發生過）。
_ALIGN_ROW = re.compile(r"^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$")


def _is_table_row(s):
    """markdown 表格列：至少要有兩個 | 才算（避免把內文裡的單一 | 誤判成表格）。"""
    t = s.strip()
    return t.startswith("|") and t.count("|") >= 2


def _split_row(s):
    """切一列的 cell。去掉首尾的 |，中間以 | 分欄。"""
    t = s.strip()
    if t.startswith("|"):
        t = t[1:]
    if t.endswith("|"):
        t = t[:-1]
    return [c.strip() for c in t.split("|")]


def _render_table(rows_raw, inline):
    """把連續的 markdown 表格列渲染成固定樣式的 HTML <table>。

    第一列為表頭（<th>）；緊接其後的對齊分隔列**丟棄不渲染**；其餘為資料列。
    合計列不特殊處理——md 裡寫 `|  |  | Total hours | 40.0 |  |` 就照一般列渲染
    （2026-09-14 裁定：轉換器不懂「合計」這件事，保持單純）。
    """
    rows = [_split_row(r) for r in rows_raw if not _ALIGN_ROW.match(r)]
    if not rows:
        return []
    out = ['<table cellspacing="0" cellpadding="8" style="{}">'.format(_TBL_STYLE)]
    for i, cells in enumerate(rows):
        style = _TH_STYLE if i == 0 else _TD_STYLE
        tag = "th" if i == 0 else "td"
        tds = "".join('<{0} style="{1}">{2}</{0}>'.format(tag, style, inline(c))
                      for c in cells)
        out.append("<tr>" + tds + "</tr>")
    out.append("</table>")
    return out


def md_to_html(md, meta=None):
    """markdown → 極簡 HTML，只做 Gmail 富文本編輯器本來就會有的東西：
    段落、清單、粗體、表格。**刻意不做**裝飾性版面（無卡片、無強調條、無配色）。

    為什麼砍掉排版：沒有人寫日報會手刻 HTML 版面——一般人就是在 Gmail 打字。
    華麗的 HTML 反而讓信「不像個人寫的」。這裡只把 markdown 語法轉成最基本的
    HTML 標籤，樣式交給收件人的郵件客戶端預設，看起來就像手打的。

    **表格是例外，且只是「表格該有的框線」**（2026-09-14 使用者裁定）：工時、
    明細這類內容本來就是表格，而郵件客戶端對無框線 <table> 的預設渲染會糊成一團，
    所以框線與表頭底色必須內嵌。樣式硬寫、不可調（見 _TBL_STYLE 上方註解）。
    """
    out = []
    in_list = False
    tbl_buf = []

    def esc_inline(s):
        """cell／內文共用的跳脫與行內語法（粗體、code）。"""
        e = s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        e = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", e)
        e = re.sub(r"`(.+?)`", r"<code>\1</code>", e)
        return e

    def close_list():
        nonlocal in_list
        if in_list:
            out.append("</ul>")
            in_list = False

    def close_table():
        """把累積的表格列吐出來。表格結束的時機＝遇到非表格列或檔案結尾。"""
        if tbl_buf:
            out.extend(_render_table(tbl_buf, esc_inline))
            tbl_buf.clear()

    for line in md.splitlines():
        raw = line.strip()

        # 表格列先攔截：它的 | 不能被當成內文處理。
        if _is_table_row(raw):
            close_list()
            tbl_buf.append(raw)
            continue
        close_table()

        esc = esc_inline(raw)
        is_li = esc.startswith("- ") or esc.startswith("* ")

        if not is_li:
            close_list()
        if not esc:
            continue
        if esc.startswith("### "):
            out.append("<p><b>" + esc[4:] + "</b></p>")
        elif esc.startswith("## "):
            out.append("<p><b>" + esc[3:] + "</b></p>")
        elif esc.startswith("# "):
            out.append("<p><b>" + esc[2:] + "</b></p>")
        elif esc in ("---", "***"):
            out.append("<hr>")
        elif is_li:
            if not in_list:
                out.append("<ul>")
                in_list = True
            out.append("<li>" + esc[2:] + "</li>")
        else:
            out.append("<p>" + esc + "</p>")
    close_list()
    close_table()
    return "\n".join(out)


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

    import send_common as sc
    sc.expand_paths(args)
    cfg = load_config(getattr(args, "project", None))
    smtp = cfg["smtp"]

    # 所有前置閘（路徑/收件人/去重/內容/確認窗口）走共用契約——
    # 與 OAuth 路徑同一份程式碼，對等性由此保證而非靠複製貼上。
    plan = sc.prepare_send(args, cfg)
    print("寄件人 : {} <{}>".format(cfg.get("from_name", ""), smtp["user"]))
    if cfg.get("_project_config"):
        print("來源   : " + cfg["_project_config"] + "（專案層覆寫收件人）")
    sc.print_preview(plan, "Gmail SMTP", args.dry_run)
    if args.dry_run:
        return

    # 本檔只負責「怎麼把郵件送出去」：組 MIME → SMTP 連線
    msg = MIMEMultipart("alternative")
    msg["Subject"] = Header(plan.subject, "utf-8")
    msg["From"] = formataddr((cfg.get("from_name") or smtp["user"], smtp["user"]))
    msg["To"] = ", ".join(plan.recipients)
    if plan.cc:
        msg["Cc"] = ", ".join(plan.cc)
    msg.attach(MIMEText(plan.md, "plain", "utf-8"))
    msg.attach(MIMEText(md_to_html(plan.md), "html", "utf-8"))

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
            server.sendmail(smtp["user"], plan.recipients + plan.cc, msg.as_string())
    except smtplib.SMTPAuthenticationError:
        die("SMTP 登入失敗——檢查 app_password 是否正確（須為「應用程式密碼」，"
            "非 Gmail 登入密碼；且帳戶要先開兩步驟驗證）。", 2)
    except (smtplib.SMTPException, OSError) as e:
        die("寄送失敗：" + str(e), 2)

    sc.mark_sent(plan, "smtp")
    print("✓ 已寄出")


if __name__ == "__main__":
    main()
