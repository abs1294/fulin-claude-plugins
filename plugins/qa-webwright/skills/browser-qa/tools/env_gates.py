"""環境閘框架：開跑前確認「這輪要用到的環境件」是對的、齊的。

三件事，都在 pytest 開跑前擋（錯誤環境下跑完一整輪＝全部作廢，而 warning 會被輸出淹沒）：

(a) port 歸屬閘 `port_guard_check()`
    多個 worktree／分支的服務可能佔著同一個 port，測試照樣連得上、回 200，
    驗的卻是別份 binary。查 OS 上該 port 由哪條命令列佔著，比對是否落在期望的 worktree。
      - 期望 worktree 由使用者顯式提供：`QA_EXPECT_WORKTREE`（逗號分隔，每個名字也吃 `<名>-<尾綴>`）。
        **未設就不檢查**——不猜，猜錯會擋掉合法跑法（例如在主 repo 跑）。
      - port 清單讀參數檔 ports：`{"label": "前端", "port": 5173}` 或 `{"label": "後端", "url_env": "QA_API_URL"}`。
      - 查法：Windows 用 PowerShell（Get-NetTCPConnection＋Win32_Process 命令列）；
        macOS／Linux 用 `lsof -nP -iTCP:<port> -sTCP:LISTEN -t` ＋ `ps -o command= -p <pid>`。
        兩者都不可用 → fail-open 並明說「無法查 port 歸屬，本閘略過」。
        同一 port 有多個 listener（IPv4／IPv6 各一、多個 process）→ 每一個都要落在期望的 worktree。
        命令列沒有絕對路徑（python manage.py runserver 這類相對路徑啟動）→ macOS／Linux 改看程序工作目錄
        （lsof -d cwd）；仍無法確認（Windows 查不到工作目錄）→ 該 listener 略過並明講。
        讀不到命令列（提權／系統程序）→ 當不符（無從確認它不是別份 binary）。
        url_env 沒設或讀不出 port → 該項略過並明講（不無聲少檢查）。
        查詢指令本身逾時或 OS 錯誤 → 該 port fail-open（附一行說明），不當成「服務沒起」去擋。
      - URL 的 port 用 urllib 解析（支援 IPv6 字面值 http://[::1]:8080）。
      - 不符 → pytest.exit(returncode=3)。

(b) fixture 圖環境檢查 `fixture_env_problems(items)`
    「這輪要不要檢外部站台／某外部件」用 **item.fixturenames** 判，不用 grep：
    fixturenames 是執行期事實且已展開遞移依賴，間接用到也抓得到；字串掃描回答的是
    「函式簽章有沒有這個參數名」，不是「這輪真的需要它」。
    參數檔 env_requirements：`[{"fixtures": ["external_page"], "env": ["QA_EXTERNAL_URL"], "desc": "..."}]`
    ⚠ 不要把 base_url、page 這類通用 fixture 放進 fixtures——它們被所有瀏覽器測試遞移依賴，
      判準會退化成「全部都要」。只放該環境件**獨有**的 fixture。
    缺件 → pytest.UsageError（exit 4），訊息指名是哪支測試、哪個 fixture 觸發。

(c) 探測覆寫約定 `probe_flag(name, probe)`
    `QA_<NAME>_AVAILABLE`：1/true/yes/on（不分大小寫）＝強制可用；其他非空值＝強制不可用；
    未設或空字串＝呼叫 probe() 自動探測。用途：探測本身在某些網路拓撲下必然失敗時，
    讓其餘模組照跑、相關測試各自具名失敗（具名失敗優於整輪中止）。
"""
import os
import re
import shutil
import subprocess
import sys
from urllib.parse import urlsplit

try:
    from . import qa_config
except ImportError:
    import qa_config


# ---------------- (c) 探測覆寫 ----------------

def probe_env_name(name):
    return "QA_%s_AVAILABLE" % re.sub(r"[^A-Za-z0-9]+", "_", name).strip("_").upper()


def probe_flag(name, probe, env=None):
    """回傳 (available: bool, source: 'forced'|'probe')。"""
    env = os.environ if env is None else env
    forced = qa_config.flag_true(env.get(probe_env_name(name)))
    if forced is not None:
        return forced, "forced"
    return bool(probe()), "probe"


# ---------------- (a) port 歸屬 ----------------

def _port_of_url(url):
    """網址 → port（支援 IPv6 字面值 http://[::1]:8080）；沒寫 port 時 http=80、https=443；解析不了回 None。
    沒寫 scheme 的 host:port（localhost:8000）當 http。"""
    url = (url or "").strip()
    if url and "://" not in url:
        url = "http://" + url
    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError:
        return None
    if port:
        return port
    scheme = (parts.scheme or "").lower()
    return {"https": 443, "http": 80}.get(scheme)


class OwnerQueryError(Exception):
    """查 port 佔用者的指令本身失敗（逾時、OS 錯誤）——不等於「沒有人在 listen」。"""


def configured_ports(cfg=None, env=None, notes=None):
    """參數檔 ports → [(label, port)]。url_env 沒設、網址讀不出 port 的項目不列入，原因寫進 notes（list）——
    不得無聲少檢查一個 port。訊息只提環境變數名，不印網址（可能內嵌帳密）。"""
    cfg = cfg or qa_config.load()
    env = os.environ if env is None else env
    out = []
    for p in cfg.get("ports") or []:
        if not isinstance(p, dict):
            continue
        label = p.get("label") or "service"
        port = p.get("port")
        if port is None and p.get("url_env"):
            raw = env.get(p["url_env"], "")
            port = _port_of_url(raw)
            if port is None and notes is not None:
                notes.append("[port-guard] %s：%s %s，本 port 略過（未檢查）。"
                             % (label, p["url_env"], "未設定" if not raw else "的網址讀不出 port（port 超出範圍或格式不對）"))
        # bool 是 int 的子類（True＝1）：port 寫成 true 不得被當成 port 1
        if (isinstance(port, int) and not isinstance(port, bool)) or (isinstance(port, str) and port.isdigit()):
            out.append((label, int(port)))
    return out


def owner_backend():
    """回傳可用的查詢方式名稱：'windows' / 'lsof' / None。"""
    if sys.platform.startswith("win"):
        return "windows" if shutil.which("powershell") or shutil.which("pwsh") else None
    return "lsof" if shutil.which("lsof") else None


def owners_of(port, backend=None):
    """佔用該 port 的**所有** listener 命令列（同一 port 可能有多個，例如 IPv4／IPv6 各一）。

    沒有人 listen → []；查詢指令本身失敗（逾時、OS 錯誤）→ 丟 OwnerQueryError（呼叫端 fail-open，
    不可當成「服務沒起」去擋）。
    """
    backend = backend or owner_backend()
    run = dict(capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30)
    unreadable = "（pid %s，命令列讀不到）"
    try:
        if backend == "windows":
            exe = shutil.which("powershell") or shutil.which("pwsh")
            if not exe:
                raise OwnerQueryError("找不到 powershell／pwsh")
            # 每個 listener 一行「pid<TAB>命令列」：讀不到命令列（系統／提權程序）的也要留下，不得被略過。
            # -ErrorAction Stop：查無 listener → exit 0 空輸出；其他錯誤 → exit 3（查詢失敗，fail-open）。
            # 認錯誤代號 CmdletizationQuery_NotFound，不認類別 ObjectNotFound——「沒有 Get-NetTCPConnection 這個指令」
            # （CommandNotFoundException）的類別也是 ObjectNotFound，會被誤當成沒人 listen 而擋跑
            # 輸出編碼固定 UTF-8（Windows PowerShell 5.1 預設跟主控台字碼頁走，中文 worktree 路徑會變亂碼而比對失敗）
            p = subprocess.run(
                [exe, "-NoProfile", "-Command",
                 "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;"
                 "try{$c=Get-NetTCPConnection -State Listen -LocalPort %d -ErrorAction Stop}"
                 "catch{if($_.FullyQualifiedErrorId -like 'CmdletizationQuery_NotFound*'){exit 0}else{exit 3}};"
                 "$c | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object {"
                 "$w=Get-CimInstance Win32_Process -Filter \"ProcessId=$_\" -ErrorAction Stop; \"$_`t$($w.CommandLine)\" }"
                 % int(port)],
                **run)
            if p.returncode != 0:
                raise OwnerQueryError("PowerShell exit %s" % p.returncode)
            owners = []
            for ln in p.stdout.splitlines():
                if not ln.strip():
                    continue
                pid, _sep, cmd = ln.partition("\t")
                owners.append(cmd.strip() or unreadable % pid.strip())
            return owners
        if backend == "lsof":
            q = subprocess.run(["lsof", "-nP", "-iTCP:%d" % int(port), "-sTCP:LISTEN", "-t"], **run)
            # lsof：沒有符合的 listener 回 1、無輸出也無錯誤訊息（＝沒人 listen）；其他情況＝查詢本身失敗
            if q.returncode not in (0, 1) or (q.returncode == 1 and (q.stdout.strip() or (q.stderr or "").strip())):
                raise OwnerQueryError("lsof exit %s" % q.returncode)
            pids = []
            for pid in q.stdout.split():
                if pid not in pids:
                    pids.append(pid)
            owners = []
            for pid in pids:
                ps = subprocess.run(["ps", "-o", "command=", "-p", pid], **run)
                if ps.returncode != 0:
                    raise OwnerQueryError("ps exit %s（pid %s）" % (ps.returncode, pid))
                cmd = ps.stdout.strip()
                if cmd and not has_location(cmd):
                    # 相對路徑啟動（python manage.py runserver、go run .）：命令列看不出落點，改附上程序的工作目錄
                    cwd = _process_cwd(pid, run)
                    if cwd:
                        cmd += "  [cwd %s/]" % cwd.rstrip("/")
                owners.append(cmd or unreadable % pid)
            return owners
    except (OSError, subprocess.SubprocessError) as exc:
        raise OwnerQueryError("%s: %s" % (type(exc).__name__, exc))
    return []


def _process_cwd(pid, run):
    """lsof 查程序的工作目錄；查不到回 None（呼叫端當「落點無法確認」）。"""
    try:
        q = subprocess.run(["lsof", "-a", "-p", str(pid), "-d", "cwd", "-Fn"], **run)
    except (OSError, subprocess.SubprocessError):
        return None
    for ln in (q.stdout or "").splitlines():
        if ln.startswith("n") and len(ln) > 1:
            return ln[1:].strip()
    return None


# 命令列裡可能帶祕密（--token=…、--pass、--private-key、-p 密碼、password=…）：輸出前遮罩。
# 值不吃引號：-H "X-Api-Key: abc" 遮成 "X-Api-Key: ***"（收尾引號保留）
_SECRET_ARG = re.compile(
    r"((?:--?|/)?(?:[\w-]*(?:password|passwd|pwd|pass(?![a-z])|token|secret|api[-_]?key|apikey"
    r"|(?:private|session|access|signing|client)[-_]?key|auth|credential)[\w-]*)"
    r"(?:\s*[=:]\s*|\s+))(\"[^\"]*\"|'[^']*'|[^\s\"']+)", re.I)
# -u／-U／--user 後的「帳號:密碼」：可黏寫（-uadmin:pw）、可用引號包（含空白的密碼整段遮）
_USER_PASS = re.compile(r"((?:\s|^)(?:-[uU]|--user)(?:\s+|=)?)"
                        r"(?:(\"[^\":]*:)[^\"]*(\")|('[^':]*:)[^']*(')|([^\s:\"']+:)\S+)")


def _mask_user_pass(m):
    if m.group(2):
        return m.group(1) + m.group(2) + "***" + m.group(3)
    if m.group(4):
        return m.group(1) + m.group(4) + "***" + m.group(5)
    return m.group(1) + m.group(6) + "***"
_SHORT_P = re.compile(r"(\s-p\s*)(\"[^\"]*\"|'[^']*'|\S+)")
# HTTP 認證標頭的 scheme 後面才是祕密（Authorization: Bearer <token>、Basic <base64>）
_AUTH_SCHEME = re.compile(r"\b(Bearer|Basic|Digest|Token|Negotiate|NTLM)(\s+)([^\s\"']+)", re.I)
# 絕對路徑：引號包住的（可含空白）或不含空白的；兩段以上才算（/c 這類單段是選項）
_ABS_PATH = re.compile(r"\"((?:[A-Za-z]:)?[\\/][^\"]+)\"|'((?:[A-Za-z]:)?[\\/][^']+)'"
                       r"|((?:[A-Za-z]:)?(?:[\\/][^\s\\/\"']+){2,})")


def mask_command_line(cmd):
    # scheme 後的祕密先遮（否則 Authorization: 的遮罩只吃掉 "Bearer" 這個字，後面的 token 照樣露出）
    s = _AUTH_SCHEME.sub(lambda m: m.group(1) + m.group(2) + "***", cmd or "")
    s = _SECRET_ARG.sub(lambda m: m.group(1) + "***", s)
    s = _SHORT_P.sub(lambda m: m.group(1) + "***", s)
    s = _USER_PASS.sub(_mask_user_pass, s)                  # curl -u user:pass、--user user:pass
    return re.sub(r"(://[^/\s:@]+:)[^@\s]+@", r"\1***@", s)   # URL 內嵌的帳密


# 家目錄前綴（/Users/<名>、/home/<名>、C:\Users\<名>）：使用者名稱不得印出（名稱可含空白）。
# 先換成一個哨兵段（路徑仍連續、不含空白），截短時再拿掉
_HOME_PREFIX = re.compile(r"(?:[A-Za-z]:)?[\\/](?:Users|home)[\\/][^\\/\"']+(?=[\\/])", re.I)
_HOME_MARK = "~home~"


def display_owner(cmd):
    """給人看的佔用者：祕密遮罩；家目錄前綴換成 ~（不印使用者名稱）；其餘絕對路徑一律不整段顯示——
    超過三段的只留最後三段（看得出是哪個 checkout 的哪支程式），三段以內的只留檔名。引號包住、含空白的路徑同樣處理。"""
    def short(m):
        quote = '"' if m.group(1) is not None else "'" if m.group(2) is not None else ""
        p = m.group(1) or m.group(2) or m.group(3)
        parts = [x for x in re.split(r"[\\/]", p) if x and not re.match(r"^[A-Za-z]:$", x)]
        home = False
        if parts and parts[0] == _HOME_MARK:
            parts, home = parts[1:], True
        elif len(parts) >= 2 and parts[0].lower() in ("users", "home"):
            parts, home = parts[2:], True        # /Users/<名> 結尾、沒有下一段
        if not parts:
            return quote + "~" + quote
        # 家目錄底下：名稱已拿掉，剩三段就留三段（看得出是哪個 checkout）；其他路徑超過三段才留三段
        keep = parts[-3:] if len(parts) > 3 or (home and len(parts) == 3) else parts[-1:]
        return quote + ("~/…/" if home else "…/") + "/".join(keep) + quote
    return _ABS_PATH.sub(short, _HOME_PREFIX.sub("/" + _HOME_MARK, mask_command_line(cmd)))


def owner_of(port, backend=None):
    """相容舊介面：第一個 listener 的命令列；沒有回 None。查詢失敗丟 OwnerQueryError。"""
    owners = owners_of(port, backend)
    return owners[0] if owners else None


# 命令列開頭的直譯器（/usr/bin/python3 manage.py、C:\...\node.exe server.js）只說明「用哪支直譯器」，
# 不說明服務落在哪個 worktree；判「命令列有沒有落點線索」時要先去掉它，否則系統直譯器的絕對路徑
# 會被當成落點而誤判不符。
_LEAD_TOKEN = re.compile(r"^\s*(?:\"([^\"]+)\"|'([^']+)'|(\S+))")
_INTERPRETER = re.compile(r"^(python[0-9.]*w?|py|node(js)?|java(w)?|dotnet|ruby|php[0-9.]*|perl|bun|deno)$", re.I)


def strip_interpreter(cmd):
    m = _LEAD_TOKEN.match(cmd or "")
    if not m:
        return cmd or ""
    tok = m.group(1) or m.group(2) or m.group(3)
    base = os.path.basename(tok.replace("\\", "/"))
    if base.lower().endswith(".exe"):
        base = base[:-4]
    return cmd[m.end():] if _INTERPRETER.match(base) else cmd


def has_location(cmd):
    """去掉開頭直譯器後，命令列（含附上的 [cwd …]）是否還有絕對路徑可判落點。"""
    return bool(_ABS_PATH.search(strip_interpreter(cmd)))


def expected_names(raw):
    return [n.strip() for n in (raw or "").replace("，", ",").split(",") if n.strip()]


def owner_matches(owner, names):
    """命令列落在任一 worktree 目錄（`<名>` 或 `<名>-<尾綴>`，尾綴可含連字號，前後是路徑分隔）即算命中。

    Windows／macOS 檔案系統預設不分大小寫，比對也不分大小寫。
    """
    flags = re.I if (sys.platform.startswith("win") or sys.platform == "darwin") else 0
    for n in names:
        pat = r"[\\/]" + re.escape(n) + r"(-[A-Za-z0-9_.-]+)?[\\/]"
        if re.search(pat, owner or "", flags):
            return True
    return False


def port_guard_check(expect=None, cfg=None, env=None, owner_fn=None, backend=None):
    """回傳 (ok, lines)。未設 QA_EXPECT_WORKTREE → (True, [])。"""
    env = os.environ if env is None else env
    names = expected_names(expect if expect is not None else env.get("QA_EXPECT_WORKTREE", ""))
    if not names:
        return True, []
    notes = []
    ports = configured_ports(cfg, env, notes)
    if not ports:
        return True, notes or ["[port-guard] 參數檔 ports 為空，無可檢查的 port，略過。"]
    if owner_fn is None:
        backend = backend if backend is not None else owner_backend()
        if backend is None:
            return True, ["[port-guard] 本機沒有 PowerShell（Windows）或 lsof（macOS/Linux），"
                          "無法查 port 歸屬，本閘略過（fail-open）。"]
        owner_fn = lambda p: owners_of(p, backend)  # noqa: E731
    bad = []
    for label, port in ports:
        try:
            got = owner_fn(port)
        except OwnerQueryError as exc:
            notes.append("[port-guard] %s :%d 無法查佔用者（%s），本 port 略過（fail-open）。" % (label, port, exc))
            continue
        owners = [got] if isinstance(got, str) else list(got or [])
        if not owners:
            bad.append("  %s :%d → 沒有任何 process 在 listen（服務沒起？）" % (label, port))
            continue
        # 同一 port 多個 listener：每一個都要落在期望的 worktree（任一個是別份 binary，請求就可能打過去）
        for owner in owners:
            if owner.strip() and not owner.strip().startswith("（pid") and not has_location(owner):
                # 命令列讀得到、但沒有任何絕對路徑（相對路徑啟動、Windows 上查不到工作目錄）：落點無法確認 → 略過並明講。
                # 讀不到命令列的 listener（提權／系統程序）不在此列，照「不符」處理（無從確認它不是別份 binary）
                notes.append("[port-guard] %s :%d 的佔用者命令列沒有絕對路徑、無法確認落點（%s），本 listener 略過（fail-open）。"
                             % (label, port, display_owner(owner.strip())[:120]))
                continue
            if not owner_matches(owner, names):
                short = display_owner(owner.strip())
                bad.append("  %s :%d → 由別處佔用：%s" % (label, port, short[:150] + ("…" if len(short) > 150 else "")))
    if bad:
        return False, ["port 歸屬檢查失敗（期望 worktree：%s）：" % "、".join(names)] + bad + [
            "",
            "跑下去會驗到別份 binary——端點可能整組 404、錯誤 modal 遮罩擋點擊，整批結果無效。",
            "先把該 port 換成正確 worktree 的服務再跑；不需要此檢查就別設 QA_EXPECT_WORKTREE。",
        ] + notes
    return True, notes


# ---------------- (b) fixture 圖 → 必要環境變數 ----------------

def fixture_env_problems(items, cfg=None, env=None):
    """回傳 [(requirement, 缺的變數 list, 觸發的 nodeid, 觸發的 fixture list)]。"""
    cfg = cfg or qa_config.load()
    env = os.environ if env is None else env
    problems = []
    for req in cfg.get("env_requirements") or []:
        fixtures = set(req.get("fixtures") or [])
        if not fixtures:
            continue
        trigger = None
        for it in items:
            hit = fixtures.intersection(set(getattr(it, "fixturenames", ()) or ()))
            if hit:
                trigger = (getattr(it, "nodeid", "?"), sorted(hit))
                break
        if trigger is None:
            continue
        missing = [v for v in req.get("env") or [] if not str(env.get(v, "")).strip()]
        if missing:
            problems.append((req, missing, trigger[0], trigger[1]))
    return problems


def format_fixture_env_report(problems):
    lines = ["環境不完備：本輪收集到的測試需要以下環境件，但對應環境變數沒帶（開跑前就擋，免得跑完整輪才發現）："]
    for req, missing, nodeid, fx in problems:
        lines.append("  - %s" % (req.get("desc") or "、".join(req.get("fixtures") or [])))
        lines.append("      缺：%s" % "、".join(missing))
        lines.append("      觸發：%s（fixture：%s）" % (nodeid, "、".join(fx)))
    lines.append("判準＝item.fixturenames（執行期事實、已展開遞移依賴），宣告在 tests/e2e/qa-webwright.json 的 env_requirements。")
    return "\n".join(lines)
