#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
gmail_oauth.py — Gmail API OAuth 授權與寄送（選項 B：使用者自帶 client_id）。

零外部依賴：不用 google-api-python-client，直接打 OAuth endpoint 與 Gmail REST API
（urllib + json 而已）。理由是 daily-report 全套維持 stdlib-only，裝套件對日報工具是過度負擔。

三個子命令：
  setup   引導式授權：開瀏覽器讓使用者按「允許」，把 refresh_token 存進 config
  send    用 refresh_token 換 access_token → Gmail API users.messages.send 寄出
  status  檢查目前授權狀態（有沒有 refresh_token、能不能換到 access_token）

設定檔：~/.claude/daily-report/config.json 的 oauth 區塊
  { "oauth": { "client_id": "...", "client_secret": "...", "refresh_token": "（setup 自動寫入）" } }

安全設計：
- 走 loopback redirect（http://127.0.0.1:<隨機埠>），這是 Google 對桌面應用的建議做法，
  比 out-of-band（已淘汰）安全，且使用者不必手動貼授權碼。
- 帶 PKCE（S256）——即使 client_secret 被看到（桌面 app 本來就藏不住），
  授權碼也無法被第三方攔截兌換。
- state 隨機值防 CSRF。
- scope 只要 gmail.send（唯寄不能讀），最小權限。
"""
import argparse
import base64
import hashlib
import json
import os
import re
import secrets
import socket
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from email.header import Header
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.utils import formataddr
from http.server import BaseHTTPRequestHandler, HTTPServer

if sys.stdout.encoding and sys.stdout.encoding.lower() not in ("utf-8", "utf8"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

CONFIG_DIR = os.path.join(os.path.expanduser("~"), ".claude", "daily-report")
CONFIG_PATH = os.path.join(CONFIG_DIR, "config.json")
SCOPE = "https://www.googleapis.com/auth/gmail.send"
AUTH_URI = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URI = "https://oauth2.googleapis.com/token"
SEND_URI = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send"
CLIENT_ID_RE = re.compile(r"^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$")

SUCCESS_HTML = """<!doctype html><meta charset="utf-8">
<title>授權完成</title>
<body style="font-family:-apple-system,'Segoe UI','Microsoft JhengHei',sans-serif;
text-align:center;padding:60px;color:#222">
<h2>✅ 授權完成</h2>
<p>daily-report 已取得寄信授權（僅 gmail.send，無法讀取你的信件）。</p>
<p style="color:#666">可以關掉這個分頁，回到終端機繼續。</p>
</body>"""

FAIL_HTML = """<!doctype html><meta charset="utf-8">
<title>授權失敗</title>
<body style="font-family:-apple-system,'Segoe UI','Microsoft JhengHei',sans-serif;
text-align:center;padding:60px;color:#222">
<h2>❌ 授權未完成</h2><p>回到終端機看錯誤訊息。</p></body>"""


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
    """家目錄設定（含憑證）＋專案層覆寫（只收件人）。

    憑證只從家目錄讀——它跟「人」綁定不跟專案綁定，且專案目錄通常在 git 版控內。
    專案層只覆寫寄給誰，這樣同一組授權可以服務多個專案、各自寄給不同窗口。
    """
    cfg = {}
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, encoding="utf-8") as fh:
                cfg = json.load(fh)
        except (json.JSONDecodeError, OSError) as e:
            die("設定檔解析失敗（{}）：{}".format(CONFIG_PATH, e))
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
    return cfg


def save_config(cfg):
    """原子寫入，避免中斷留半截 JSON 毀掉設定。"""
    os.makedirs(CONFIG_DIR, exist_ok=True)
    tmp = CONFIG_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(cfg, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    os.replace(tmp, CONFIG_PATH)
    # 憑證檔限本人可讀（POSIX；Windows 上 chmod 語意有限，靠家目錄 ACL 保護）
    try:
        os.chmod(CONFIG_PATH, 0o600)
    except OSError:
        pass


def post_form(url, data):
    body = urllib.parse.urlencode(data).encode()
    req = urllib.request.Request(url, data=body,
                                 headers={"Content-Type": "application/x-www-form-urlencoded"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")
        raise RuntimeError("HTTP {}：{}".format(e.code, detail[:400]))
    except urllib.error.URLError as e:
        raise RuntimeError("連線失敗：{}".format(e.reason))


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class _CallbackHandler(BaseHTTPRequestHandler):
    """只收一次 redirect 回呼，把 code/state/error 塞進 server.result。"""
    def do_GET(self):
        q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        self.server.result = {k: v[0] for k, v in q.items()}
        ok = "code" in self.server.result
        html = SUCCESS_HTML if ok else FAIL_HTML
        body = html.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):  # 靜音 HTTP server 的 stderr 日誌
        pass


def cmd_setup(args):
    cfg = load_config()
    oauth = cfg.get("oauth") or {}
    client_id = args.client_id or oauth.get("client_id")
    client_secret = args.client_secret or oauth.get("client_secret")

    if not client_id or not client_secret:
        die("缺 client_id / client_secret。\n"
            "請先在 Google Cloud Console 建立「桌面應用程式」OAuth 用戶端（詳見 SKILL.md 引導），\n"
            "然後：python gmail_oauth.py setup --client-id <id> --client-secret <secret>")
    if not CLIENT_ID_RE.match(client_id.strip()):
        die("client_id 格式不像 Google 的（應以 .apps.googleusercontent.com 結尾）：" + client_id[:60])
    client_id, client_secret = client_id.strip(), client_secret.strip()

    # PKCE：verifier 隨機、challenge = S256(verifier)
    verifier = base64.urlsafe_b64encode(secrets.token_bytes(64)).decode().rstrip("=")
    challenge = base64.urlsafe_b64encode(
        hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
    state = secrets.token_urlsafe(24)

    port = free_port()
    redirect_uri = "http://127.0.0.1:{}/".format(port)
    params = {
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": SCOPE,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        "state": state,
        "access_type": "offline",   # 要 refresh_token
        "prompt": "consent",        # 強制同意畫面，確保拿得到 refresh_token
    }
    auth_url = AUTH_URI + "?" + urllib.parse.urlencode(params)

    print("即將開啟瀏覽器進行 Google 授權。")
    print("  • 請選擇要用來寄日報的 Gmail 帳號")
    print("  • 若看到「Google 尚未驗證這個應用程式」→ 點「進階」→「前往（不安全）」")
    print("    （這是因為此 OAuth 用戶端是你自己建立、未送 Google 驗證，屬正常）")
    print("  • 授權範圍只有「代您傳送電子郵件」，無法讀取信件")
    print()
    print("若瀏覽器沒自動開，手動貼上這個網址：")
    print("  " + auth_url)
    print()

    server = HTTPServer(("127.0.0.1", port), _CallbackHandler)
    server.result = None
    server.timeout = 300  # 5 分鐘沒完成就放棄，不要無限卡住
    try:
        webbrowser.open(auth_url)
    except Exception:
        pass
    print("等待授權完成中（最多 5 分鐘）…")
    server.handle_request()
    server.server_close()

    result = server.result
    if not result:
        die("等待授權逾時（5 分鐘）。重跑 setup 再試一次。")
    if result.get("state") != state:
        die("state 不符——可能遭 CSRF 或瀏覽器帶了舊的授權頁。請重跑 setup。")
    if "error" in result:
        die("Google 回報授權失敗：{}（使用者按了拒絕，或用戶端設定有誤）".format(result["error"]))

    try:
        tok = post_form(TOKEN_URI, {
            "code": result["code"],
            "client_id": client_id,
            "client_secret": client_secret,
            "redirect_uri": redirect_uri,
            "grant_type": "authorization_code",
            "code_verifier": verifier,
        })
    except RuntimeError as e:
        die("兌換 token 失敗：{}".format(e), 2)

    # 順手記下授權帳號的信箱：日報表頭要顯示寄件者，而 OAuth 路徑的寄件地址
    # 就是授權的那個帳號——這裡拿到就不必再問使用者一次。
    # id_token 是 JWT，payload 段含 email；只解不驗（我們不用它做身分決策）。
    try:
        idt = tok.get("id_token") or ""
        if idt.count(".") == 2:
            payload = idt.split(".")[1]
            payload += "=" * (-len(payload) % 4)
            claims = json.loads(base64.urlsafe_b64decode(payload).decode("utf-8"))
            if claims.get("email"):
                cfg["from_email"] = claims["email"]
    except (ValueError, KeyError, UnicodeDecodeError):
        pass

    refresh_token = tok.get("refresh_token")
    if not refresh_token:
        die("Google 沒回傳 refresh_token。通常是該帳號先前已授權過此用戶端——\n"
            "到 https://myaccount.google.com/permissions 移除後重跑 setup。", 2)

    cfg.setdefault("oauth", {})
    cfg["oauth"].update({
        "client_id": client_id,
        "client_secret": client_secret,
        "refresh_token": refresh_token,
    })
    save_config(cfg)
    print("\n✓ 授權完成，refresh_token 已寫入 " + CONFIG_PATH)
    if not cfg.get("recipients"):
        print("  提醒：設定檔還沒有 recipients（收件人），寄送前要補。")


def access_token(oauth):
    """用 refresh_token 換短效 access_token（每次寄送現換，不落盤）。"""
    for k in ("client_id", "client_secret", "refresh_token"):
        if not oauth.get(k):
            die("oauth 設定不完整（缺 {}）——先跑：python gmail_oauth.py setup".format(k))
    try:
        tok = post_form(TOKEN_URI, {
            "client_id": oauth["client_id"],
            "client_secret": oauth["client_secret"],
            "refresh_token": oauth["refresh_token"],
            "grant_type": "refresh_token",
        })
    except RuntimeError as e:
        die("換發 access_token 失敗：{}\n"
            "若訊息含 invalid_grant，代表授權已失效（使用者撤銷、密碼變更、"
            "或同意畫面仍是「測試中」狀態導致 7 天過期）——重跑 setup 即可。".format(e), 2)
    if not tok.get("access_token"):
        die("Google 未回傳 access_token：" + json.dumps(tok)[:200], 2)
    return tok["access_token"]


def probe_send_api(token):
    """實際打一次 Gmail send 端點來探測「API 有沒有啟用、scope 對不對」。

    刻意送一個必然被拒的空 raw：我們要的是 Google 的錯誤『種類』，不是真的寄信。
    - 403 + "has not been used in project" → Gmail API 未啟用（附 Google 給的啟用連結）
    - 403 + insufficient/scope        → 授權範圍不含 gmail.send
    - 400                              → API 通了（400 是我們故意送壞資料造成的，代表這關過）
    這是本檔存在的理由：不問使用者「你啟用了嗎」，直接問 Google。
    """
    req = urllib.request.Request(
        SEND_URI, data=json.dumps({"raw": ""}).encode(),
        headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30):
            return True, "Gmail API 可呼叫"
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")
        if e.code == 400:
            return True, "Gmail API 可呼叫（探測用的空郵件被拒屬預期）"
        if e.code == 403:
            m = re.search(r"https://console\.developers\.google\.com/\S+?(?=[\s\"\\])", detail)
            link = m.group(0) if m else None
            if "has not been used in project" in detail or "is disabled" in detail:
                msg = "GCP 專案尚未啟用 Gmail API"
                if link:
                    msg += "\n      啟用連結（Google 提供）：" + link
                return False, msg
            if "insufficient" in detail.lower() or "scope" in detail.lower():
                return False, ("授權範圍不含 gmail.send —— 重跑 setup 重新授權\n"
                               "      Google 原文：" + detail[:200])
            return False, "Gmail API 拒絕（403）：" + detail[:250]
        if e.code == 401:
            return False, "access_token 被拒（401）——授權可能已撤銷，重跑 setup"
        return False, "HTTP {}：{}".format(e.code, detail[:200])
    except urllib.error.URLError as e:
        return False, "無法連線 Gmail API：{}".format(e.reason)


def cmd_doctor(args):
    """逐項實測設定是否可用——每一項都用程式驗證，不靠使用者回報。

    設計原則：使用者說「我做過了」不算數（實戰上引導步驟就是會被漏掉，
    寫引導的人自己也會漏）。能打 API 驗的就打，不能驗的才讀檔。
    輸出 Google 的原始錯誤與連結，而不是本腳本記憶中的 Console 路徑——
    Console 介面會改版，Google 當下回的訊息永遠比寫死的步驟新。
    """
    cfg = load_config(getattr(args, "project", None))
    oauth = cfg.get("oauth") or {}
    checks = []   # (項目, 通過?, 說明)

    # 1. 設定檔存在
    checks.append(("設定檔", os.path.exists(CONFIG_PATH),
                   CONFIG_PATH if os.path.exists(CONFIG_PATH)
                   else CONFIG_PATH + " 不存在 → 跑 setup"))

    # 2. 用戶端憑證
    has_client = bool(oauth.get("client_id") and oauth.get("client_secret"))
    checks.append(("OAuth 用戶端", has_client,
                   "已設定" if has_client else "缺 client_id/client_secret → 跑 setup"))

    # 3. 授權（refresh_token 存在且能換 access_token）
    token = None
    if oauth.get("refresh_token"):
        try:
            tok = post_form(TOKEN_URI, {
                "client_id": oauth.get("client_id", ""),
                "client_secret": oauth.get("client_secret", ""),
                "refresh_token": oauth["refresh_token"],
                "grant_type": "refresh_token"})
            token = tok.get("access_token")
            checks.append(("授權狀態", bool(token),
                           "有效，可換發 access_token" if token else "換發失敗：" + json.dumps(tok)[:150]))
        except RuntimeError as e:
            hint = ""
            if "invalid_grant" in str(e):
                hint = ("\n      invalid_grant 代表授權已失效——常見原因：使用者撤銷、帳號改密碼、"
                        "或同意畫面仍是「測試中」導致 7 天過期。重跑 setup 即可。")
            checks.append(("授權狀態", False, str(e)[:200] + hint))
    else:
        checks.append(("授權狀態", False, "尚未授權（無 refresh_token）→ 跑 setup"))

    # 4. Gmail API 是否啟用（實打，不問使用者）
    if token:
        ok, msg = probe_send_api(token)
        checks.append(("Gmail API", ok, msg))
    else:
        checks.append(("Gmail API", False, "跳過（需先完成授權）"))

    # 4.5 寄件帳號：舊版授權沒存 from_email，doctor 順手補回設定檔，
    # 免得使用者為了顯示寄件人而被要求重新授權。
    if token and not cfg.get("from_email"):
        try:
            # 用 Gmail 自己的 profile 端點：它在 gmail.send 的權限範圍內，
            # 而 oauth2/userinfo 需要 userinfo.email scope（我們刻意不要那個）。
            req = urllib.request.Request(
                "https://gmail.googleapis.com/gmail/v1/users/me/profile",
                headers={"Authorization": "Bearer " + token})
            with urllib.request.urlopen(req, timeout=15) as resp:
                info = json.loads(resp.read().decode("utf-8"))
            info = {"email": info.get("emailAddress")}
            if info.get("email"):
                raw = {}
                if os.path.exists(CONFIG_PATH):
                    with open(CONFIG_PATH, encoding="utf-8") as fh:
                        raw = json.load(fh)
                raw["from_email"] = info["email"]
                save_config(raw)
                cfg["from_email"] = info["email"]
        except (urllib.error.HTTPError, urllib.error.URLError,
                json.JSONDecodeError, OSError):
            pass  # 補不到不影響寄送，只是顯示少一項

    # 非阻斷項：拿不到寄件帳號只是預覽少一行，不該讓整體健檢判定失敗
    # （用裝飾性欄位擋住可用的設定，會讓使用者以為壞了）
    if cfg.get("from_email"):
        checks.append(("寄件帳號", True, cfg["from_email"]))
    else:
        print("  [–] {:<12} {}".format("寄件帳號", "未取得（不影響寄送，預覽會少顯示一行）"))

    # 5. 收件人
    recipients = [str(a).strip() for a in (cfg.get("recipients") or []) if str(a).strip()]
    src = cfg.get("_project_config") or CONFIG_PATH
    checks.append(("收件人", bool(recipients),
                   "{}（來源：{}）".format(", ".join(recipients), src) if recipients
                   else "未設定 → 在 config 的 recipients 填入，或在專案建 .claude/daily-report.json"))

    print("== daily-report 設定健檢（實測，非自我回報）==")
    failed = 0
    for name, ok, msg in checks:
        print("  [{}] {:<12} {}".format("✓" if ok else "✗", name, msg))
        if not ok:
            failed += 1
    if failed:
        print("\n{} 項未通過——依上方訊息處理後再跑一次 doctor。".format(failed))
        sys.exit(1)
    print("\n全部通過：可以寄送。")


def cmd_status(args):
    cfg = load_config()
    oauth = cfg.get("oauth") or {}
    print("設定檔     : " + (CONFIG_PATH if os.path.exists(CONFIG_PATH) else CONFIG_PATH + "（不存在）"))
    print("client_id  : " + (oauth.get("client_id", "（未設定）")[:32] + "…" if oauth.get("client_id") else "（未設定）"))
    print("refresh    : " + ("已授權" if oauth.get("refresh_token") else "（未授權——跑 setup）"))
    print("recipients : " + (", ".join(cfg.get("recipients") or []) or "（未設定）"))
    if oauth.get("refresh_token"):
        access_token(oauth)  # 失敗會 die 並附說明
        print("連線測試   : ✓ 可換發 access_token，授權有效")


def build_message(md, subject, sender, recipients, cc, html):
    msg = MIMEMultipart("alternative")
    msg["Subject"] = Header(subject, "utf-8")
    msg["From"] = formataddr((sender.get("name") or "", sender["email"])) if sender.get("email") else ""
    msg["To"] = ", ".join(recipients)
    if cc:
        msg["Cc"] = ", ".join(cc)
    msg.attach(MIMEText(md, "plain", "utf-8"))
    if html:
        msg.attach(MIMEText(html, "html", "utf-8"))
    return base64.urlsafe_b64encode(msg.as_bytes()).decode()


def assert_content_clean(report_path, project_dir=None):
    """寄送前的內容硬閘——命中 AI/工具鏈用語即中止，不可豁免。

    為何無豁免旗標：這條規則的性質是「對外不可洩漏」，跟敏感字掃描（會誤命中、
    需要出口）不同。留了出口就會在趕時間時被用掉，等於沒有這道閘。
    """
    guard = os.path.join(os.path.dirname(os.path.abspath(__file__)), "content_guard.py")
    if not os.path.exists(guard):
        die("找不到 content_guard.py——內容硬閘缺失，拒絕寄送（避免無檢查寄出）。", 2)
    cmd = [sys.executable, guard, report_path]
    if project_dir:
        cmd += ["--project", project_dir]
    r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8")
    if r.returncode != 0:
        sys.stderr.write(r.stderr or r.stdout or "")
        die("內容檢查未通過，已中止寄送（見上方命中清單）。", 3)


def assert_confirm_ready(date, project_dir=None):
    """自動寄送前查驗確認窗口狀態——not-armed / still-waiting / vetoed 一律拒寄。

    這道閘存在的理由：沒有它，「30 分鐘窗口」就只是 SKILL.md 裡的一句話，
    模型可以沒呈現就寄、可以窗口沒到就寄。時間由腳本算，不由模型記。
    """
    gate = os.path.join(os.path.dirname(os.path.abspath(__file__)), "confirm_gate.py")
    if not os.path.exists(gate):
        die("找不到 confirm_gate.py——自動寄送的確認閘缺失，拒絕寄送。", 5)
    cmd = [sys.executable, gate, "check", date]
    if project_dir:
        cmd += ["--project", project_dir]
    r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8")
    if r.returncode != 0:
        sys.stderr.write(r.stdout or "")
        sys.stderr.write(r.stderr or "")
        die("確認窗口檢查未通過，中止自動寄送。"
            "（使用者明確要求寄出時，不要帶 --auto）", 5)
    sys.stdout.write(r.stdout or "")


def cmd_send(args):
    # SKILL.md 的指令用 ~ 開頭；PowerShell 與 subprocess 不會展開它，必須在程式裡做
    args.report = os.path.expanduser(args.report)
    if getattr(args, "project", None):
        args.project = os.path.expanduser(args.project)

    cfg = load_config(getattr(args, "project", None))
    oauth = cfg.get("oauth") or {}
    if not os.path.exists(args.report):
        die("找不到日報檔：" + args.report)
    with open(args.report, encoding="utf-8") as fh:
        md = fh.read()
    if not md.strip():
        die("日報檔是空的：" + args.report)

    if args.to:
        # --to 是臨時覆寫：cc 一併清空，免得自己測試時 config 的 cc（可能是主管）照收
        recipients = [a.strip() for a in args.to.split(",") if a.strip()]
        cc = []
    else:
        recipients = [str(a).strip() for a in (cfg.get("recipients") or []) if str(a).strip()]
        cc = [str(a).strip() for a in (cfg.get("cc") or []) if str(a).strip()]
    if not recipients:
        die("收件人清單是空的（設定檔 recipients 未設，或 --to 只有空白）")

    subject = args.subject or "{} {} 工作日報".format(
        cfg.get("subject_prefix", "[工作日報]"), args.date).strip()

    print("管道     : Gmail API（OAuth, gmail.send）")
    if cfg.get("_project_config"):
        print("收件人來源: " + cfg["_project_config"] + "（專案層覆寫）")
    print("收件人   : " + ", ".join(recipients))
    if cc:
        print("副本     : " + ", ".join(cc))
    print("主旨     : " + subject)
    print("內文     : {} 字（{}）".format(len(md), args.report))

    # 硬閘：內容不得含 AI / 工具鏈描述。dry-run 也要跑——不然預覽時看不出會被擋。
    assert_content_clean(args.report, getattr(args, "project", None))

    # 硬閘：--auto（喚醒觸發的自動寄）必須通過確認窗口檢查。
    # 使用者明確說「寄」時不帶 --auto，走一般路徑——那是他的意思表示，不需等窗口。
    if getattr(args, "auto", False):
        assert_confirm_ready(args.date, getattr(args, "project", None))

    if args.dry_run:
        print("\n--dry-run：未寄送。內文前 10 行：")
        for ln in md.splitlines()[:10]:
            print("  | " + ln)
        return

    # HTML 版沿用 send_gmail.py 的轉換器，兩條寄送路徑外觀一致
    html = None
    try:
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        from send_gmail import md_to_html
        from send_gmail import build_meta
        html = md_to_html(md, build_meta(cfg, args.date, cfg.get("from_email")))
    except Exception:
        pass  # 轉換不可用就只寄純文字，不因排版問題擋住寄送

    # 已寄過就不重寄：默許窗口的喚醒可能重複觸發（cron 沒刪乾淨、session 續接…），
    # 主管收到兩封一樣的日報比漏寄更尷尬。以「日期＋收件人」為鍵。
    sent_dir = os.path.join(os.path.dirname(CONFIG_PATH), "sent")
    sent_mark = os.path.join(sent_dir, "{}-{}.json".format(
        args.date, _scope_key(getattr(args, "project", None))))
    if os.path.exists(sent_mark) and not getattr(args, "force", False):
        try:
            with open(sent_mark, encoding="utf-8") as fh:
                prev = json.load(fh)
        except (json.JSONDecodeError, OSError):
            prev = {}
        die("{} 的日報已寄出過（{} → {}）。要重寄請加 --force。".format(
            args.date, prev.get("sent_at", "?"), ", ".join(prev.get("recipients", []))), 4)

    token = access_token(oauth)
    raw = build_message(md, subject, {"email": cfg.get("from_email", ""),
                                      "name": cfg.get("from_name", "")},
                        recipients, cc, html)
    req = urllib.request.Request(
        SEND_URI, data=json.dumps({"raw": raw}).encode(),
        headers={"Authorization": "Bearer " + token,
                 "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")
        if e.code == 403:
            die("Gmail API 拒絕（403）：{}\n"
                "常見原因：GCP 專案未啟用 Gmail API，或授權範圍不含 gmail.send。".format(detail[:300]), 2)
        die("寄送失敗 HTTP {}：{}".format(e.code, detail[:300]), 2)
    except urllib.error.URLError as e:
        die("寄送失敗（連線）：{}".format(e.reason), 2)

    try:
        os.makedirs(sent_dir, exist_ok=True)
        with open(sent_mark, "w", encoding="utf-8") as fh:
            json.dump({"date": args.date, "recipients": recipients, "cc": cc,
                       "subject": subject, "report": os.path.abspath(args.report),
                       "sent_at": __import__("datetime").datetime.now().isoformat(timespec="seconds")},
                      fh, ensure_ascii=False, indent=2)
    except OSError:
        pass  # 記錄失敗不該讓「已成功寄出」變成錯誤

    print("✓ 已寄出")


def main():
    ap = argparse.ArgumentParser(description="Gmail OAuth 授權與寄送（gmail.send 最小權限）")
    sub = ap.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("setup", help="引導式授權（開瀏覽器，一次即可）")
    s.add_argument("--client-id")
    s.add_argument("--client-secret")
    s.set_defaults(func=cmd_setup)

    s = sub.add_parser("status", help="檢查授權狀態（簡版）")
    s.set_defaults(func=cmd_status)

    s = sub.add_parser("doctor", help="逐項實測設定可用性（實打 API，不靠自我回報）")
    s.add_argument("--project", help="專案目錄（省略=目前工作目錄）")
    s.set_defaults(func=cmd_doctor)

    s = sub.add_parser("send", help="寄送日報")
    s.add_argument("--report", required=True)
    s.add_argument("--date", required=True)
    s.add_argument("--subject")
    s.add_argument("--to")
    s.add_argument("--project", help="專案目錄（省略=目前工作目錄），決定用哪份收件人設定")
    s.add_argument("--dry-run", action="store_true")
    s.add_argument("--force", action="store_true", help="即使當日已寄過仍重寄")
    s.add_argument("--auto", action="store_true",
                   help="喚醒觸發的自動寄送：強制通過 confirm_gate 檢查才寄")
    s.set_defaults(func=cmd_send)

    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
