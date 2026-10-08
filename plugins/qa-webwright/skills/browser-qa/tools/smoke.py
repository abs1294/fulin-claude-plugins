"""上線前健檢（smoke test）：照專案設定起服務、健康檢查、分級跑 pytest、出報告、只停自己起的程序。

由 qa-flow.sh 的 smoke-* 子命令呼叫（直接跑 plugin 本體這支，不經專案 tests/e2e/tools/）：
    python smoke.py --workspace <專案根> try <服務名>
    python smoke.py --workspace <專案根> preflight
    python smoke.py --workspace <專案根> run <等級>
    python smoke.py --workspace <專案根> report
    python smoke.py --workspace <專案根> stop

設定檔：<專案根>/tests/Project_Detail/SMOKE.json（欄位見 plugin README「上線前健檢」節、範例 templates/SMOKE.example.json）。
狀態檔：<report_dir>/.smoke-state.json（本腳本起的 PID、最近一次 preflight、最近一輪 run）。

設計重點：
  - 不殺別人的程序：port 已被佔且健康檢查失敗 → 印佔用者 PID 與遮罩後的命令列，停止（exit 4）。
  - 試起後 codify：服務要先 `try` 成功（起得來＋健康檢查過）才寫 `verified`；preflight 只代起 verified 的服務，
    且 verified 綁設定指紋——驗證後改過啟動設定就要重 try。
  - 全部跑完才出報告：report 遇到 junit 不存在、自動案例 0 筆、手動 TC 有一筆沒填結果或證據，一律拒絕（exit 3）。
  - stop 只停狀態檔記錄、且身分（建立時間）仍相符的 PID；其他一律不碰。

exit：0＝完成；1＝服務起不來／健康檢查失敗／pytest 沒產出 junit；2＝設定或參數錯誤（含等級不存在）；
      3＝前置條件不符而拒絕（未 verified、未過 preflight、報告閘）；4＝port 被別的程序佔著且不健康（不殺）。
"""
import argparse
import copy
import hashlib
import io
import json
import os
import re
import shutil
import signal
import socket
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime

try:
    from . import env_gates
    from .run_by_folder import counts_from_junit
except ImportError:
    import env_gates
    from run_by_folder import counts_from_junit

CONFIG_REL = "tests/Project_Detail/SMOKE.json"
STATE_NAME = ".smoke-state.json"
RESULTS = ("PASS", "FAIL", "Partial", "N.A.", "Env Limit")
IS_WIN = sys.platform.startswith("win")


class SmokeError(Exception):
    def __init__(self, msg, code=2):
        Exception.__init__(self, msg)
        self.code = code


def out(msg=""):
    print(msg, flush=True)


def err(msg):
    print(msg, file=sys.stderr, flush=True)


# ---------------------------------------------------------------- 設定檔

def _is_int(v):
    return isinstance(v, int) and not isinstance(v, bool)


def _strip_comments(obj):
    if isinstance(obj, dict):
        return {k: _strip_comments(v) for k, v in obj.items() if not (isinstance(k, str) and k.startswith("_"))}
    if isinstance(obj, list):
        return [_strip_comments(x) for x in obj]
    return obj


_NAME_RE = re.compile(r"^[A-Za-z0-9_.-]+$")


def _rel_path(where, v, allow_node_id=False):
    if not isinstance(v, str) or not v.strip():
        raise SmokeError("SMOKE.json 的 `%s` 應為非空字串" % where)
    p = v.split("::", 1)[0] if allow_node_id else v
    norm = p.replace("\\", "/")
    if os.path.isabs(p) or re.match(r"^[A-Za-z]:", p) or norm.startswith("/") or ".." in norm.split("/"):
        raise SmokeError("SMOKE.json 的 `%s` 必須是相對專案根的路徑、不得含 '..'：%r" % (where, v))
    return v


# ---- 等級篩選式（pytest -m 的子集：名稱、and／or／not、括號）----
_TOKEN = re.compile(r"\s*(\(|\)|[A-Za-z_][A-Za-z0-9_]*)")


def _tokens(expr):
    toks, pos, s = [], 0, expr.strip()
    while pos < len(s):
        m = _TOKEN.match(s, pos)
        if not m:
            raise ValueError("看不懂的字元：%r" % s[pos:])
        toks.append(m.group(1))
        pos = m.end()
        while pos < len(s) and s[pos].isspace():
            pos += 1
    return toks


def marker_match(expr, markers):
    """expr 為空＝全部符合；否則以 markers（集合）求值。語法錯丟 ValueError。"""
    if not expr.strip():
        return True
    toks = _tokens(expr)
    i = [0]

    def peek():
        return toks[i[0]] if i[0] < len(toks) else None

    def take():
        i[0] += 1
        return toks[i[0] - 1]

    def p_or():
        v = p_and()
        while peek() == "or":
            take()
            r = p_and()
            v = v or r
        return v

    def p_and():
        v = p_not()
        while peek() == "and":
            take()
            r = p_not()
            v = v and r
        return v

    def p_not():
        if peek() == "not":
            take()
            return not p_not()
        t = peek()
        if t is None:
            raise ValueError("篩選式不完整")
        if t == "(":
            take()
            v = p_or()
            if peek() != ")":
                raise ValueError("括號沒有配對")
            take()
            return v
        if t in (")", "and", "or"):
            raise ValueError("不該出現在這裡：%s" % t)
        take()
        return t in markers

    v = p_or()
    if i[0] != len(toks):
        raise ValueError("多出來的字：%s" % " ".join(toks[i[0]:]))
    return v


_SERVICE_FIELDS = {"name", "port", "scheme", "cwd", "start", "health", "order", "timeout_s",
                   "post_start_checks", "verified"}


def validate(raw):
    """回傳去掉註解欄位、補上預設值的設定；不合法丟 SmokeError（exit 2）。"""
    if not isinstance(raw, dict):
        raise SmokeError("SMOKE.json 頂層必須是 JSON 物件")
    c = _strip_comments(raw)
    for k in ("levels", "services", "issues_log", "report_dir"):
        if k not in c:
            raise SmokeError("SMOKE.json 缺必填欄位 `%s`" % k)
    lv = c["levels"]
    if not isinstance(lv, dict) or not lv:
        raise SmokeError("SMOKE.json 的 `levels` 應為非空物件（等級名 → pytest -m 篩選式）")
    for name, expr in lv.items():
        if not isinstance(expr, str):
            raise SmokeError("SMOKE.json 的 `levels.%s` 型別應為字串（空字串＝不加 -m），實際是 %s"
                             % (name, type(expr).__name__))
        try:
            marker_match(expr, set())
        except ValueError as exc:
            raise SmokeError("SMOKE.json 的 `levels.%s` 篩選式不合法：%r（%s）" % (name, expr, exc))
    for k, default in (("always_run", []), ("test_paths", ["tests/e2e"]), ("pytest_args", [])):
        v = c.setdefault(k, list(default))
        if not isinstance(v, list) or not all(isinstance(x, str) for x in v):
            raise SmokeError("SMOKE.json 的 `%s` 型別應為字串清單" % k)
    for i, p in enumerate(c["always_run"]):
        _rel_path("always_run[%d]" % i, p, allow_node_id=True)
    for i, p in enumerate(c["test_paths"]):
        _rel_path("test_paths[%d]" % i, p)
    _rel_path("issues_log", c["issues_log"])
    _rel_path("report_dir", c["report_dir"])
    c.setdefault("manual_tc_file", None)
    if c["manual_tc_file"] is not None:
        _rel_path("manual_tc_file", c["manual_tc_file"])
    svcs = c["services"]
    if not isinstance(svcs, list):
        raise SmokeError("SMOKE.json 的 `services` 型別應為清單")
    seen = set()
    for i, s in enumerate(svcs):
        w = "services[%d]" % i
        if not isinstance(s, dict):
            raise SmokeError("SMOKE.json 的 `%s` 型別應為物件" % w)
        for k in ("name", "port", "scheme", "start", "health"):
            if k not in s or s[k] in (None, ""):
                raise SmokeError("SMOKE.json 的 `%s` 缺必填欄位 `%s`" % (w, k))
        unknown = [k for k in s if k not in _SERVICE_FIELDS]
        if unknown:
            raise SmokeError("SMOKE.json 的 `%s` 有不認得的欄位 %s（註解請用底線開頭）" % (w, unknown))
        if not isinstance(s["name"], str) or not _NAME_RE.match(s["name"]):
            raise SmokeError("SMOKE.json 的 `%s.name` 只能含英數字、_、-、.：%r" % (w, s["name"]))
        if s["name"] in seen:
            raise SmokeError("SMOKE.json 的服務名稱重複：%s" % s["name"])
        seen.add(s["name"])
        if not _is_int(s["port"]) or not 0 < s["port"] < 65536:
            raise SmokeError("SMOKE.json 的 `%s.port` 應為 1–65535 的整數，實際是 %r" % (w, s["port"]))
        if s["scheme"] not in ("http", "https"):
            raise SmokeError("SMOKE.json 的 `%s.scheme` 只能是 http 或 https，實際是 %r" % (w, s["scheme"]))
        s.setdefault("cwd", ".")
        if not isinstance(s["cwd"], str) or not s["cwd"]:
            raise SmokeError("SMOKE.json 的 `%s.cwd` 應為非空字串" % w)
        st = s["start"]
        if not isinstance(st, dict) or not isinstance(st.get("cmd"), str) or not st.get("cmd").strip():
            raise SmokeError("SMOKE.json 的 `%s.start` 應為物件且 `cmd` 為非空字串" % w)
        st.setdefault("args", [])
        st.setdefault("env", {})
        if not isinstance(st["args"], list) or not all(isinstance(x, str) for x in st["args"]):
            raise SmokeError("SMOKE.json 的 `%s.start.args` 型別應為字串清單" % w)
        if not isinstance(st["env"], dict) or not all(isinstance(v, str) for v in st["env"].values()):
            raise SmokeError("SMOKE.json 的 `%s.start.env` 型別應為 {名稱: 字串值}" % w)
        h = s["health"]
        if not isinstance(h, dict) or not isinstance(h.get("url"), str) or not re.match(r"^https?://", h.get("url", "")):
            raise SmokeError("SMOKE.json 的 `%s.health.url` 應為 http:// 或 https:// 開頭的網址" % w)
        h.setdefault("expect_status", 200)
        if not _is_int(h["expect_status"]):
            raise SmokeError("SMOKE.json 的 `%s.health.expect_status` 型別應為整數" % w)
        if "expect_text" in h and h["expect_text"] is not None and not isinstance(h["expect_text"], str):
            raise SmokeError("SMOKE.json 的 `%s.health.expect_text` 型別應為字串" % w)
        s.setdefault("order", i)
        if not _is_int(s["order"]):
            raise SmokeError("SMOKE.json 的 `%s.order` 型別應為整數" % w)
        s.setdefault("timeout_s", 120)
        if not (_is_int(s["timeout_s"]) or isinstance(s["timeout_s"], float)) or s["timeout_s"] <= 0:
            raise SmokeError("SMOKE.json 的 `%s.timeout_s` 應為正數（秒）" % w)
        s.setdefault("post_start_checks", [])
        if not isinstance(s["post_start_checks"], list):
            raise SmokeError("SMOKE.json 的 `%s.post_start_checks` 型別應為清單" % w)
        for j, ck in enumerate(s["post_start_checks"]):
            cw = "%s.post_start_checks[%d]" % (w, j)
            if not isinstance(ck, dict) or ck.get("type") not in ("log_absent", "log_present", "http"):
                raise SmokeError("SMOKE.json 的 `%s.type` 只能是 log_absent／log_present／http" % cw)
            if ck["type"] == "http":
                if not isinstance(ck.get("url"), str) or not re.match(r"^https?://", ck["url"]):
                    raise SmokeError("SMOKE.json 的 `%s.url` 應為 http(s) 網址" % cw)
                ck.setdefault("expect_status", 200)
                if not _is_int(ck["expect_status"]):
                    raise SmokeError("SMOKE.json 的 `%s.expect_status` 型別應為整數" % cw)
            else:
                if not isinstance(ck.get("pattern"), str) or not ck["pattern"]:
                    raise SmokeError("SMOKE.json 的 `%s.pattern` 應為非空字串（regex）" % cw)
                try:
                    re.compile(ck["pattern"])
                except re.error as exc:
                    raise SmokeError("SMOKE.json 的 `%s.pattern` 不是合法 regex：%s" % (cw, exc))
        v = s.get("verified")
        if v is not None:
            if not isinstance(v, dict) or not isinstance(v.get("at"), str) \
                    or not isinstance(v.get("start_ok"), bool) or not isinstance(v.get("health_ok"), bool):
                raise SmokeError("SMOKE.json 的 `%s.verified` 應為 {at: 字串, start_ok: 布林, health_ok: 布林} 或 null"
                                 "（由 smoke-try 寫入，不要手填）" % w)
    return c


def fingerprint(svc):
    keep = {k: svc.get(k) for k in ("name", "port", "scheme", "cwd", "start", "health", "post_start_checks")}
    return hashlib.sha256(json.dumps(keep, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()[:16]


def is_verified(svc):
    v = svc.get("verified") or {}
    return bool(v.get("start_ok") and v.get("health_ok") and v.get("config_sha") == fingerprint(svc))


def atomic_write_text(path, text):
    d = os.path.dirname(path)
    if d:
        os.makedirs(d, exist_ok=True)
    tmp = os.path.join(d, ".%s.tmp-%d" % (os.path.basename(path), os.getpid()))
    with io.open(tmp, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(text)
    os.replace(tmp, path)


class Ctx(object):
    def __init__(self, workspace):
        self.ws = os.path.abspath(workspace)
        self.cfg_path = os.path.join(self.ws, *CONFIG_REL.split("/"))
        if not os.path.isfile(self.cfg_path):
            raise SmokeError("找不到 %s——第一次用要先由 AI 讀專案文件寫出草稿（範例：plugin 的 "
                             "skills/browser-qa/templates/SMOKE.example.json），再 smoke-try 逐一試起。" % CONFIG_REL, 3)
        try:
            with io.open(self.cfg_path, encoding="utf-8-sig") as fh:
                self.raw = json.load(fh)
        except ValueError as exc:
            raise SmokeError("%s 不是合法 JSON：%s" % (CONFIG_REL, exc))
        self.cfg = validate(copy.deepcopy(self.raw))
        self.report_dir = self.path(self.cfg["report_dir"])
        self.state_path = os.path.join(self.report_dir, STATE_NAME)

    def path(self, rel):
        return os.path.normpath(os.path.join(self.ws, rel.replace("/", os.sep)))

    def service(self, name):
        for s in self.cfg["services"]:
            if s["name"] == name:
                return s
        raise SmokeError("SMOKE.json 沒有名為 %r 的服務（現有：%s）"
                         % (name, "、".join(s["name"] for s in self.cfg["services"]) or "無"))

    def ordered(self):
        return sorted(self.cfg["services"], key=lambda s: s["order"])

    # ---- 狀態檔 ----
    def load_state(self):
        try:
            with io.open(self.state_path, encoding="utf-8") as fh:
                st = json.load(fh)
            if isinstance(st, dict):
                st.setdefault("started", [])
                return st
        except (OSError, ValueError):
            pass
        return {"started": []}

    def save_state(self, st):
        atomic_write_text(self.state_path, json.dumps(st, ensure_ascii=False, indent=2) + "\n")

    def write_verified(self, name, verified):
        """只改該服務的 verified 欄位，其餘原樣（含底線註解）；同目錄 tmp＋原子 rename。"""
        raw = copy.deepcopy(self.raw)
        for s in raw.get("services") or []:
            if isinstance(s, dict) and s.get("name") == name:
                s["verified"] = verified
        atomic_write_text(self.cfg_path, json.dumps(raw, ensure_ascii=False, indent=2) + "\n")
        self.raw = raw


# ---------------------------------------------------------------- 程序身分（建立時間）／存活／樹

def _win_k32():
    import ctypes
    from ctypes import wintypes
    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    k32.OpenProcess.restype = wintypes.HANDLE
    k32.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
    k32.CloseHandle.argtypes = (wintypes.HANDLE,)
    k32.GetProcessTimes.argtypes = (wintypes.HANDLE,) + (ctypes.POINTER(wintypes.FILETIME),) * 4
    k32.GetExitCodeProcess.argtypes = (wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD))
    return ctypes, wintypes, k32


def proc_identity(pid):
    """程序還活著→回建立時間字串（同 PID 被重用時會不同）；不存在／已結束→None。"""
    pid = int(pid)
    if IS_WIN:
        ctypes, wintypes, k32 = _win_k32()
        h = k32.OpenProcess(0x1000, False, pid)   # PROCESS_QUERY_LIMITED_INFORMATION
        if not h:
            return None
        try:
            code = wintypes.DWORD()
            if not k32.GetExitCodeProcess(h, ctypes.byref(code)) or code.value != 259:   # STILL_ACTIVE
                return None
            t = [wintypes.FILETIME() for _ in range(4)]
            if not k32.GetProcessTimes(h, *[ctypes.byref(x) for x in t]):
                return None
            return str((t[0].dwHighDateTime << 32) | t[0].dwLowDateTime)
        finally:
            k32.CloseHandle(h)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return None
    except PermissionError:
        pass
    try:
        p = subprocess.run(["ps", "-o", "lstart=", "-p", str(pid)], capture_output=True, text=True,
                           encoding="utf-8", errors="replace", timeout=10)
    except (OSError, subprocess.SubprocessError):
        return None
    s = (p.stdout or "").strip()
    return s or None


def parent_map():
    """{pid: 父 pid}；查不到回 {}。"""
    if IS_WIN:
        import ctypes
        from ctypes import wintypes

        class PE(ctypes.Structure):
            _fields_ = [("dwSize", wintypes.DWORD), ("cntUsage", wintypes.DWORD),
                        ("th32ProcessID", wintypes.DWORD), ("th32DefaultHeapID", ctypes.c_size_t),
                        ("th32ModuleID", wintypes.DWORD), ("cntThreads", wintypes.DWORD),
                        ("th32ParentProcessID", wintypes.DWORD), ("pcPriClassBase", ctypes.c_long),
                        ("dwFlags", wintypes.DWORD), ("szExeFile", ctypes.c_wchar * 260)]
        k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        k32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
        k32.CreateToolhelp32Snapshot.argtypes = (wintypes.DWORD, wintypes.DWORD)
        k32.Process32FirstW.argtypes = (wintypes.HANDLE, ctypes.POINTER(PE))
        k32.Process32NextW.argtypes = (wintypes.HANDLE, ctypes.POINTER(PE))
        k32.CloseHandle.argtypes = (wintypes.HANDLE,)
        snap = k32.CreateToolhelp32Snapshot(0x2, 0)
        if not snap or snap == ctypes.c_void_p(-1).value:
            return {}
        res = {}
        try:
            pe = PE()
            pe.dwSize = ctypes.sizeof(PE)
            ok = k32.Process32FirstW(snap, ctypes.byref(pe))
            while ok:
                res[int(pe.th32ProcessID)] = int(pe.th32ParentProcessID)
                ok = k32.Process32NextW(snap, ctypes.byref(pe))
        finally:
            k32.CloseHandle(snap)
        return res
    try:
        p = subprocess.run(["ps", "-A", "-o", "pid=", "-o", "ppid="], capture_output=True, text=True,
                           encoding="utf-8", errors="replace", timeout=10)
    except (OSError, subprocess.SubprocessError):
        return {}
    res = {}
    for ln in (p.stdout or "").splitlines():
        parts = ln.split()
        if len(parts) == 2 and parts[0].isdigit() and parts[1].isdigit():
            res[int(parts[0])] = int(parts[1])
    return res


def is_descendant(pid, ancestor, pmap):
    cur, seen = int(pid), set()
    while cur in pmap and cur not in seen:
        if cur == int(ancestor):
            return True
        seen.add(cur)
        cur = pmap[cur]
    return cur == int(ancestor)


def kill_tree(pid):
    """停掉 pid 與其子孫（呼叫端先確認身分）。回 (成功, 訊息)。"""
    pid = int(pid)
    if IS_WIN:
        try:
            # taskkill 的訊息用主控台 OEM 字碼頁（繁中＝cp950），用 utf-8 解會變亂碼
            p = subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], capture_output=True, text=True,
                               encoding="oem", errors="replace", timeout=30)
        except (OSError, subprocess.SubprocessError) as exc:
            return False, "taskkill 失敗：%s" % exc
        msg = ((p.stdout or "") + (p.stderr or "")).strip().splitlines()
        return p.returncode == 0, (msg[-1] if msg else "")
    try:
        target = os.getpgid(pid) if os.getpgid(pid) == pid else None
    except OSError:
        target = None
    try:
        if target:
            os.killpg(target, signal.SIGTERM)
        else:
            os.kill(pid, signal.SIGTERM)
    except OSError as exc:
        return False, "SIGTERM 失敗：%s" % exc
    for _ in range(20):
        if proc_identity(pid) is None:
            return True, "SIGTERM"
        time.sleep(0.25)
    try:
        if target:
            os.killpg(target, signal.SIGKILL)
        else:
            os.kill(pid, signal.SIGKILL)
    except OSError:
        pass
    return proc_identity(pid) is None, "SIGKILL"


# ---------------------------------------------------------------- port／健康檢查

def port_open(port):
    for host in ("127.0.0.1", "::1"):
        try:
            with socket.create_connection((host, port), timeout=0.5):
                return True
        except OSError:
            continue
    return False


def listeners(port):
    """回 (清單 [(pid, 命令列)], 查詢說明)。查詢失敗時退回 socket 探測：有人 listen 但 PID 不明 → [("?", "")]。"""
    try:
        return env_gates.owners_of(port, with_pid=True), ""
    except env_gates.OwnerQueryError as exc:
        note = "（查 port 佔用者的指令失敗：%s；改用連線探測）" % exc
        return ([("?", "")] if port_open(port) else []), note


def describe_owners(owners):
    lines = []
    for pid, cmd in owners:
        lines.append("    PID %s：%s" % (pid, env_gates.display_owner(cmd)[:200] if cmd else "（命令列讀不到）"))
    return lines


def http_check(url, expect_status, expect_text=None, timeout=10):
    """回 (ok, 說明)。不走系統 proxy；本機開發憑證不驗。"""
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    # 本程序只做健康檢查：直接裝成全域 opener（不走 proxy、不驗本機憑證）
    urllib.request.install_opener(urllib.request.build_opener(
        urllib.request.ProxyHandler({}), urllib.request.HTTPSHandler(context=ctx)))
    req = urllib.request.Request(url, headers={"User-Agent": "qa-webwright-smoke"})
    try:
        resp = urllib.request.urlopen(req, timeout=timeout)
        status, final, body = resp.status, resp.geturl(), resp.read(500000)
    except urllib.error.HTTPError as exc:
        status, final = exc.code, exc.geturl() or url
        try:
            body = exc.read(500000)
        except OSError:
            body = b""
    except (urllib.error.URLError, OSError, ValueError) as exc:
        reason = getattr(exc, "reason", exc)
        return False, "連線失敗：%s（服務沒起來？scheme 是否打錯 http／https？）" % reason
    text = body.decode("utf-8", "replace")
    moved = "" if final.rstrip("/") == url.rstrip("/") else "（被導向 %s）" % final
    if status != expect_status:
        return False, "HTTP %s，期望 %s%s" % (status, expect_status, moved)
    if expect_text and expect_text not in text:
        return False, "HTTP %s 但內容沒有期望字樣 %r%s——可能被導到登入頁／無權限頁" % (status, expect_text, moved)
    return True, "HTTP %s%s%s" % (status, "，含期望字樣" if expect_text else "", moved)


def health(svc):
    h = svc["health"]
    return http_check(h["url"], h["expect_status"], h.get("expect_text"))


def config_warnings(svc):
    w = []
    h = svc["health"]["url"]
    if not h.startswith(svc["scheme"] + "://"):
        w.append("health.url 的 scheme 與 scheme 欄位（%s）不一致——http／https 打錯常被導到無權限頁" % svc["scheme"])
    port = env_gates._port_of_url(h)
    if port is not None and port != svc["port"]:
        w.append("health.url 的 port（%s）與 port 欄位（%s）不一致" % (port, svc["port"]))
    return w


def post_checks(svc, log_path):
    """回 [(ok, 說明)]；log_path 為 None（不是本腳本起的）時 log 類檢查略過並明講。"""
    res = []
    for ck in svc.get("post_start_checks") or []:
        desc = ck.get("desc") or ck["type"]
        if ck["type"] == "http":
            ok, msg = http_check(ck["url"], ck["expect_status"], ck.get("expect_text"))
            res.append((ok, "%s：%s" % (desc, msg)))
            continue
        if not log_path:
            res.append((True, "%s：略過（服務不是本腳本起的，讀不到它的 log）" % desc))
            continue
        try:
            with io.open(log_path, encoding="utf-8", errors="replace") as fh:
                text = fh.read()
        except OSError as exc:
            res.append((False, "%s：讀不到 log（%s）" % (desc, exc)))
            continue
        n = len(re.findall(ck["pattern"], text))
        if ck["type"] == "log_absent":
            res.append((n == 0, "%s：log 命中 %d 筆（應為 0）" % (desc, n)))
        else:
            res.append((n > 0, "%s：log 命中 %d 筆（應至少 1）" % (desc, n)))
    return res


def log_tail(path, n=30):
    try:
        with io.open(path, encoding="utf-8", errors="replace") as fh:
            lines = fh.read().splitlines()
    except OSError:
        return ["（讀不到 log）"]
    return [env_gates.mask_command_line(x) for x in lines[-n:]] or ["（log 是空的）"]


# ---------------------------------------------------------------- 起服務

def resolve_cmd(cmd, cwd, env):
    if os.path.dirname(cmd):
        p = cmd if os.path.isabs(cmd) else os.path.join(cwd, cmd)
        if os.path.isfile(p):
            return p
        if IS_WIN:
            for ext in (".exe", ".cmd", ".bat"):
                if os.path.isfile(p + ext):
                    return p + ext
        return None
    # Windows：npm／npx 是 .cmd 包裝（不是 .exe），shutil.which 依 PATHEXT 會找到 npm.cmd
    return shutil.which(cmd, path=env.get("PATH") or env.get("Path"))


def launch(ctx, svc):
    """背景起服務（脫離 qa-flow.sh 存活）；回 (Popen, log 路徑, 開始時間)。失敗丟 SmokeError(code=1)。"""
    cwd = svc["cwd"]
    cwd = cwd if os.path.isabs(cwd) else os.path.normpath(os.path.join(ctx.ws, cwd))
    if not os.path.isdir(cwd):
        raise SmokeError("服務 %s 的 cwd 不存在：%s" % (svc["name"], cwd), 1)
    env = dict(os.environ)
    env.update(svc["start"]["env"])
    exe = resolve_cmd(svc["start"]["cmd"], cwd, env)
    if not exe:
        raise SmokeError("服務 %s 的啟動指令找不到：%r（PATH 裡沒有；Windows 的 npm／npx 會解析成 .cmd）"
                         % (svc["name"], svc["start"]["cmd"]), 1)
    logs = os.path.join(ctx.report_dir, "logs")
    os.makedirs(logs, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    log_path = os.path.join(logs, "%s-%s.log" % (svc["name"], stamp))
    args = [exe] + list(svc["start"]["args"])
    fh = io.open(log_path, "ab")
    try:
        kw = dict(cwd=cwd, env=env, stdin=subprocess.DEVNULL, stdout=fh, stderr=subprocess.STDOUT, close_fds=True)
        if IS_WIN:
            # 不開視窗、自成 process group；能脫離外層 job 就脫離（外層 shell 結束時 job 會連坐殺掉子程序）
            base = 0x08000000 | 0x00000200   # CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP
            try:
                proc = subprocess.Popen(args, creationflags=base | 0x01000000, **kw)   # CREATE_BREAKAWAY_FROM_JOB
            except OSError:
                proc = subprocess.Popen(args, creationflags=base, **kw)
        else:
            proc = subprocess.Popen(args, start_new_session=True, **kw)   # 新 session：外層 shell 結束不會帶走它
    except OSError as exc:
        raise SmokeError("服務 %s 啟動失敗：%s" % (svc["name"], exc), 1)
    finally:
        fh.close()
    return proc, log_path, time.time()


def wait_ready(svc, proc, deadline):
    """等 LISTEN 再等健康檢查通過。回 (ok, 原因)。"""
    while time.time() < deadline:
        if proc.poll() is not None:
            return False, "程序已結束（exit %s），port %d 沒有 LISTEN" % (proc.returncode, svc["port"])
        if port_open(svc["port"]):
            break
        time.sleep(0.5)
    else:
        return False, ("等了 %ss port %d 仍沒有 LISTEN（程序還活著——可能改聽別的 port，例如 launch profile 名稱打錯時"
                       "靜默回退預設 port；看下方 log 的 listening 行）" % (svc["timeout_s"], svc["port"]))
    last = ""
    while time.time() < deadline:
        ok, last = health(svc)
        if ok:
            return True, last
        if proc.poll() is not None:
            return False, "程序已結束（exit %s）；最後一次健康檢查：%s" % (proc.returncode, last)
        time.sleep(1)
    return False, "port 已 LISTEN 但健康檢查在 %ss 內沒通過：%s" % (svc["timeout_s"], last)


def record_started(ctx, svc, proc, log_path, t0):
    """把本腳本起的程序記進狀態檔：launcher＋確認是它子孫的 listener（之後 stop 才知道哪些是自己的）。"""
    owners, _note = listeners(svc["port"])
    pmap = parent_map()
    pids = [{"pid": proc.pid, "identity": proc_identity(proc.pid), "role": "launcher"}]
    for pid, _cmd in owners:
        if pid.isdigit() and int(pid) != proc.pid and is_descendant(int(pid), proc.pid, pmap):
            pids.append({"pid": int(pid), "identity": proc_identity(int(pid)), "role": "listener"})
    st = ctx.load_state()
    st["started"] = [x for x in st["started"] if x.get("service") != svc["name"]] + [{
        "service": svc["name"], "port": svc["port"], "started_at": datetime.fromtimestamp(t0).isoformat(timespec="seconds"),
        "log": os.path.relpath(log_path, ctx.ws).replace(os.sep, "/"), "pids": pids}]
    ctx.save_state(st)
    return pids


def start_and_check(ctx, svc):
    """起服務＋等 ready＋post checks。成功回 log 路徑；失敗停掉自己剛起的程序、丟 SmokeError(1)。"""
    proc, log_path, t0 = launch(ctx, svc)
    out("  已啟動：PID %d，log：%s" % (proc.pid, os.path.relpath(log_path, ctx.ws).replace(os.sep, "/")))
    ok, why = wait_ready(svc, proc, t0 + float(svc["timeout_s"]))
    checks = post_checks(svc, log_path) if ok else []
    bad = [m for c_ok, m in checks if not c_ok]
    for c_ok, m in checks:
        out("  %s 起後檢查：%s" % ("OK" if c_ok else "NG", m))
    if ok and not bad:
        out("  健康檢查通過：%s" % why)
        pids = record_started(ctx, svc, proc, log_path, t0)
        out("  記錄到狀態檔的 PID（smoke-stop 只停這些）：%s"
            % "、".join("%d（%s）" % (p["pid"], p["role"]) for p in pids))
        return log_path
    if proc.poll() is None:
        k_ok, k_msg = kill_tree(proc.pid)
        out("  已停掉本次自己起的程序 PID %d：%s" % (proc.pid, "成功" if k_ok else "失敗 " + k_msg))
    reason = why if not ok else "起後檢查未過：" + "；".join(bad)
    err("  失敗原因：%s" % reason)
    err("  log 尾段（%s）：" % os.path.relpath(log_path, ctx.ws).replace(os.sep, "/"))
    for ln in log_tail(log_path):
        err("    | " + ln)
    raise SmokeError("服務 %s 起不來或不健康：%s" % (svc["name"], reason), 1)


def occupied_report(svc, owners, note, why):
    err("  port %d 已被佔用，且健康檢查失敗：%s %s" % (svc["port"], why, note))
    for ln in describe_owners(owners):
        err(ln)
    err("  依規則不殺別人的程序：請確認佔用者是誰、由你決定要停掉它或改 SMOKE.json 的 port，再重跑。")


# ---------------------------------------------------------------- 子命令

def cmd_try(ctx, name):
    svc = ctx.service(name)
    out("=== smoke-try：%s（port %d，%s）===" % (svc["name"], svc["port"], svc["scheme"]))
    for w in config_warnings(svc):
        out("  ⚠ %s" % w)
    shown = " ".join([svc["start"]["cmd"]] + svc["start"]["args"])
    out("  啟動指令：%s（cwd：%s）" % (env_gates.mask_command_line(shown), svc["cwd"]))
    if svc["start"]["env"]:
        out("  環境變數：%s" % "、".join(sorted(svc["start"]["env"])))
    owners, note = listeners(svc["port"])
    if owners:
        ok, why = health(svc)
        err("  port %d 已被佔用（健康檢查：%s）%s——試起必須在 port 空著時做，才能證明這組啟動設定起得來。" % (
            svc["port"], why, note))
        for ln in describe_owners(owners):
            err(ln)
        err("  依規則不殺：佔用者若就是要測的服務，先由使用者停掉它再 smoke-try；不是的話換 port。")
        return 4
    try:
        start_and_check(ctx, svc)
    except SmokeError as exc:
        err("[smoke-try] %s——verified 未寫入。修正 SMOKE.json 的 start／health 後重跑 smoke-try。" % exc)
        return exc.code
    v = {"at": datetime.now().isoformat(timespec="seconds"), "start_ok": True, "health_ok": True,
         "config_sha": fingerprint(svc)}
    ctx.write_verified(svc["name"], v)
    out("[smoke-try] OK：已寫入 %s 的 services[%s].verified（%s）。服務保持運行，smoke-stop 會停它。"
        % (CONFIG_REL, svc["name"], v["at"]))
    return 0


def cmd_preflight(ctx):
    svcs = ctx.ordered()
    out("=== smoke-preflight（%d 個服務，依 order）===" % len(svcs))
    bad = [s["name"] + ("（verified 後設定被改過）" if s.get("verified") else "") for s in svcs if not is_verified(s)]
    if bad:
        err("[smoke-preflight] 拒絕：以下服務還沒經過試起驗證：%s" % "、".join(bad))
        err("  先逐一跑 qa-flow.sh smoke-try <服務名>，通過才會寫 verified；preflight 只代起驗證過的設定。")
        return 3
    st = ctx.load_state()
    result = []
    for svc in svcs:
        out("--- %s（port %d）---" % (svc["name"], svc["port"]))
        owners, note = listeners(svc["port"])
        if owners:
            ok, why = health(svc)
            if not ok:
                occupied_report(svc, owners, note, why)
                st["preflight"] = {"at": datetime.now().isoformat(timespec="seconds"), "ok": False, "failed": svc["name"]}
                ctx.save_state(st)
                return 4
            mine = [x for x in st["started"] if x.get("service") == svc["name"]]
            checks = post_checks(svc, ctx.path(mine[0]["log"]) if mine else None)
            for c_ok, m in checks:
                out("  %s 起後檢查：%s" % ("OK" if c_ok else "NG", m))
            if not all(c for c, _m in checks):
                err("  port 上的服務健康檢查過了，但起後檢查沒過——不殺、不沿用，請人工確認。")
                for ln in describe_owners(owners):
                    err(ln)
                return 4
            out("  port 已有服務且健康（%s）→ 沿用，不重起。" % why)
            result.append({"service": svc["name"], "action": "reused"})
            continue
        out("  port 空著 → 用 verified 設定代起")
        try:
            start_and_check(ctx, svc)
        except SmokeError as exc:
            err("[smoke-preflight] %s" % exc)
            st = ctx.load_state()
            st["preflight"] = {"at": datetime.now().isoformat(timespec="seconds"), "ok": False, "failed": svc["name"]}
            ctx.save_state(st)
            return exc.code
        st = ctx.load_state()
        result.append({"service": svc["name"], "action": "started"})
    st = ctx.load_state()
    st["preflight"] = {"at": datetime.now().isoformat(timespec="seconds"), "ok": True, "services": result}
    ctx.save_state(st)
    out("[smoke-preflight] OK：%s" % "、".join("%s（%s）" % (r["service"], "代起" if r["action"] == "started" else "沿用")
                                            for r in result) or "（沒有服務）")
    return 0


def _pytest_cmd():
    raw = os.environ.get("QA_SMOKE_PYTEST", "").strip()
    return raw.split() if raw else [sys.executable, "-m", "pytest"]


# ---- 手動 TC 表 ----
_MANUAL_REQUIRED = ("編號", "功能", "等級", "結果", "證據")


def _cells(line):
    s = line.strip()
    if s.startswith("|"):
        s = s[1:]
    if s.endswith("|"):
        s = s[:-1]
    return [c.strip() for c in re.split(r"(?<!\\)\|", s)]


def parse_manual(text):
    """回 (lines, header_idx, cols, row_idx_list)；找不到表丟 SmokeError。"""
    lines = text.split("\n")
    for i, ln in enumerate(lines):
        if ln.strip().startswith("|"):
            cells = _cells(ln)
            if all(h in cells for h in _MANUAL_REQUIRED) and i + 1 < len(lines) \
                    and re.match(r"^\s*\|[\s:|-]+\|?\s*$", lines[i + 1]):
                cols = {h: cells.index(h) for h in cells}
                rows = []
                j = i + 2
                while j < len(lines) and lines[j].strip().startswith("|"):
                    rows.append(j)
                    j += 1
                return lines, i, cols, rows
    raise SmokeError("手動 TC 檔找不到結果表：表頭至少要有 %s 五欄（見 templates/SMOKE-manual.example.md）"
                     % "／".join(_MANUAL_REQUIRED))


def _set_cells(line, cols, values):
    cells = _cells(line)
    for k, v in values.items():
        if k in cols:
            while len(cells) <= cols[k]:
                cells.append("")
            cells[cols[k]] = v
    return "| " + " | ".join(cells) + " |"


def make_manual_copy(ctx, expr, run_id):
    src = ctx.cfg.get("manual_tc_file")
    if not src:
        return None, 0
    p = ctx.path(src)
    if not os.path.isfile(p):
        raise SmokeError("manual_tc_file 指的檔不存在：%s" % src)
    with io.open(p, encoding="utf-8-sig") as fh:
        lines, hi, cols, rows = parse_manual(fh.read().replace("\r\n", "\n"))
    keep = []
    for j in rows:
        c = _cells(lines[j])
        lvl = c[cols["等級"]] if cols["等級"] < len(c) else ""
        # 等級欄空白＝每個等級都跑；可寫多個（P0、P1）
        if (not lvl) or marker_match(expr, set(x for x in re.split(r"[\s,，、/]+", lvl) if x)):
            keep.append(_set_cells(lines[j], cols, {"結果": "", "嚴重程度": "", "證據": ""}))
    # 表頭兩行之後換成本輪要跑的列，表格以外的內容（步驟說明等）原樣保留
    new = lines[:hi + 2] + keep + [ln for j, ln in enumerate(lines) if j >= hi + 2 and j not in rows]
    note = ("> 本檔是 %s 這一輪的手動 TC 結果檔（smoke-run 從 `%s` 依等級篩出、結果欄清空）。"
            "逐列填「結果」（PASS／FAIL／Partial／N.A.／Env Limit）與「證據」；FAIL 另填「嚴重程度」。"
            "全部填完 smoke-report 才會產出報告。\n" % (run_id, src))
    dst = os.path.join(ctx.report_dir, "manual-%s.md" % run_id)
    atomic_write_text(dst, note + "\n" + "\n".join(new))
    return dst, len(keep)


def cmd_run(ctx, level):
    levels = ctx.cfg["levels"]
    if level not in levels:
        err("[smoke-run] 等級 %r 不在 SMOKE.json 的 levels 裡（可用：%s）" % (level, "、".join(levels)))
        return 2
    bad = []
    for svc in ctx.ordered():
        ok, why = health(svc)
        out("  健康檢查 %s：%s" % (svc["name"], why))
        if not ok:
            bad.append(svc["name"])
    if bad:
        err("[smoke-run] 拒絕：%s 健康檢查沒過——先跑 qa-flow.sh smoke-preflight。" % "、".join(bad))
        return 3
    expr = levels[level]
    run_id = datetime.now().strftime("%Y%m%d-%H%M%S")
    os.makedirs(ctx.report_dir, exist_ok=True)
    base = _pytest_cmd()
    junits, rcs = [], []
    excludes = []
    for a in ctx.cfg["always_run"]:
        excludes += ["--deselect", a] if "::" in a else ["--ignore", a]
    plan = [("level", list(ctx.cfg["test_paths"]) + (["-m", expr] if expr.strip() else []) + excludes)]
    if ctx.cfg["always_run"]:
        plan.append(("always", list(ctx.cfg["always_run"])))
    env = dict(os.environ, PYTHONIOENCODING="utf-8")
    for tag, args in plan:
        junit = os.path.join(ctx.report_dir, "junit-%s-%s.xml" % (run_id, tag))
        cmd = base + args + list(ctx.cfg["pytest_args"]) + ["--junitxml", junit]
        out("=== pytest（%s）：%s ===" % ("等級 %s" % level if tag == "level" else "always_run", " ".join(cmd)))
        p = subprocess.run(cmd, cwd=ctx.ws, env=env)
        rcs.append(p.returncode)
        out("  exit %s" % p.returncode)
        if not os.path.isfile(junit):
            err("[smoke-run] pytest 沒產出 junit：%s（exit %s）" % (junit, p.returncode))
            return 1
        junits.append(os.path.relpath(junit, ctx.ws).replace(os.sep, "/"))
    manual, n_manual = make_manual_copy(ctx, expr, run_id)
    st = ctx.load_state()
    st["run"] = {"id": run_id, "level": level, "expr": expr, "junit": junits, "pytest_rc": rcs,
                 "at": datetime.now().isoformat(timespec="seconds"),
                 "manual": os.path.relpath(manual, ctx.ws).replace(os.sep, "/") if manual else None,
                 "manual_count": n_manual}
    ctx.save_state(st)
    out("[smoke-run] 本輪 %s 已記錄：junit %s" % (run_id, "、".join(junits)))
    if manual:
        out("[smoke-run] 手動 TC %d 筆，結果請填進：%s（全部填完才能 smoke-report）"
            % (n_manual, os.path.relpath(manual, ctx.ws).replace(os.sep, "/")))
    if any(rcs):
        out("[smoke-run] pytest 有非 0 exit（有 FAIL／skip 閘）屬預期內，照常進 smoke-report。")
    return 0


def _md(s):
    return re.sub(r"\s+", " ", (s or "")).replace("|", "\\|").strip()


def junit_cases(path):
    root = ET.parse(path).getroot()
    rows = []
    for tc in root.iter("testcase"):
        tags = [c.tag for c in tc]
        name = "%s::%s" % (tc.get("classname") or "", tc.get("name") or "")
        if "error" in tags or "failure" in tags:
            el = tc.find("error") if "error" in tags else tc.find("failure")
            msg = (el.get("message") or el.text or "").strip().splitlines()
            rows.append((name, "FAIL", "junit %s：%s" % (el.tag, _md(msg[0] if msg else "")[:200])))
        elif "skipped" in tags:
            sk = tc.find("skipped")
            msg = _md(((sk.get("type") or "") + " " + (sk.get("message") or "")).strip())[:200]
            rows.append((name, "N.A.", "junit skipped：%s" % msg))
        else:
            rows.append((name, "PASS", "junit 通過（%ss）" % tc.get("time", "?")))
    return rows


def append_issues(ctx, date, issues):
    path = ctx.path(ctx.cfg["issues_log"])
    text = ""
    if os.path.isfile(path):
        with io.open(path, encoding="utf-8-sig") as fh:
            text = fh.read().replace("\r\n", "\n")
    if not text.strip():
        text = "# Smoke Test Issues\n"
    lines = text.rstrip("\n").split("\n")
    head = "## %s" % date
    try:
        si = [ln.strip() for ln in lines].index(head)
    except ValueError:
        si = None
    if si is None:
        add = ["", head, "", "| # | 對應 TC | 嚴重程度 | 問題描述 |", "|---|---------|----------|----------|"]
        add += ["| %d | %s | %s | %s |" % (n, _md(tc), _md(sev), _md(desc)) for n, (tc, sev, desc) in enumerate(issues, 1)]
        lines += add
    else:
        end = len(lines)
        for j in range(si + 1, len(lines)):
            if lines[j].startswith("## "):
                end = j
                break
        rows = [j for j in range(si + 1, end) if lines[j].strip().startswith("|")]
        nums = []
        for j in rows[2:]:
            c = _cells(lines[j])
            if c and c[0].isdigit():
                nums.append(int(c[0]))
        start = max(nums) + 1 if nums else 1
        new = ["| %d | %s | %s | %s |" % (start + k, _md(tc), _md(sev), _md(desc)) for k, (tc, sev, desc) in enumerate(issues)]
        if rows:
            at = rows[-1] + 1
        else:
            new = ["", "| # | 對應 TC | 嚴重程度 | 問題描述 |", "|---|---------|----------|----------|"] + new
            at = end
            while at > si + 1 and not lines[at - 1].strip():
                at -= 1
        lines[at:at] = new
    atomic_write_text(path, "\n".join(lines) + "\n")
    return path


def cmd_report(ctx):
    st = ctx.load_state()
    run = st.get("run")
    problems = []
    if not run:
        err("[smoke-report] 拒絕：狀態檔沒有本輪紀錄——先跑 qa-flow.sh smoke-run <等級>。")
        return 3
    auto_rows, counts = [], dict.fromkeys(("passed", "failed", "error", "xfail", "skip"), 0)
    for j in run.get("junit") or []:
        p = ctx.path(j)
        c = counts_from_junit(p)
        if c is None:
            problems.append("junit 不存在或無法解析：%s" % j)
            continue
        for k in counts:
            counts[k] += c[k]
        auto_rows += junit_cases(p)
    if not run.get("junit"):
        problems.append("本輪沒有任何 junit 紀錄")
    n_auto = sum(counts.values())
    if not problems and n_auto == 0:
        problems.append("自動案例 0 筆（等級篩選式 %r 沒有選到任何測試？marker 有沒有標？）" % run.get("expr"))
    if not problems and len(auto_rows) != n_auto:
        problems.append("junit 逐筆明細 %d 筆與計數 %d 筆不一致" % (len(auto_rows), n_auto))
    manual_rows = []
    if run.get("manual"):
        mp = ctx.path(run["manual"])
        if not os.path.isfile(mp):
            problems.append("本輪手動 TC 結果檔不見了：%s" % run["manual"])
        else:
            with io.open(mp, encoding="utf-8-sig") as fh:
                lines, _hi, cols, rows = parse_manual(fh.read().replace("\r\n", "\n"))
            for j in rows:
                c = _cells(lines[j])
                g = lambda k: (c[cols[k]] if k in cols and cols[k] < len(c) else "").strip()   # noqa: E731
                res = {r.lower(): r for r in RESULTS}.get(g("結果").lower())
                if not g("結果"):
                    problems.append("手動 TC %s 沒填結果" % (g("編號") or "（第 %d 行）" % (j + 1)))
                elif res is None:
                    problems.append("手動 TC %s 的結果 %r 不是 %s 之一" % (g("編號"), g("結果"), "／".join(RESULTS)))
                elif not g("證據"):
                    problems.append("手動 TC %s 沒填證據（CRUD 要寫讀回結果，不能只寫 Toast）" % g("編號"))
                manual_rows.append({"id": g("編號"), "func": g("功能"), "result": res or g("結果"),
                                    "sev": g("嚴重程度"), "evidence": g("證據"), "note": g("備註")})
    if problems:
        err("[smoke-report] 拒絕產出報告（全部跑完、全部填完才出報告）：")
        for p in problems:
            err("  - %s" % p)
        return 3
    passed = counts["passed"] + sum(1 for m in manual_rows if m["result"] == "PASS")
    failed = counts["failed"] + counts["error"] + sum(1 for m in manual_rows if m["result"] == "FAIL")
    other = counts["skip"] + counts["xfail"] + sum(1 for m in manual_rows if m["result"] not in ("PASS", "FAIL"))
    total = n_auto + len(manual_rows)
    date = run["at"][:10]
    L = ["## Smoke Test 報告", "", "### 測試資訊",
         "- 測試日期：%s" % date, "- 測試等級：%s（pytest -m：%s）" % (run["level"], run["expr"] or "不加 -m"),
         "- 測試環境："]
    for svc in ctx.ordered():
        L.append("  - %s：%s://localhost:%d" % (svc["name"], svc["scheme"], svc["port"]))
    L.append("- 自動套件 junit：%s（pytest exit：%s）" % ("、".join(run["junit"]), "、".join(map(str, run["pytest_rc"]))))
    if run.get("manual"):
        L.append("- 手動 TC 結果檔：%s" % run["manual"])
    L += ["", "### 結果摘要", "", "| 項目 | 數量 |", "|------|------|",
          "| 測試案例總數 | %d |" % total, "| PASS | %d |" % passed, "| FAIL | %d |" % failed,
          "| Partial / N.A. / Env Limit | %d |" % other, "",
          "（自動 %d 筆＝junit 逐筆計數：通過 %d、失敗 %d、錯誤 %d、skip %d、xfail %d；手動 %d 筆）"
          % (n_auto, counts["passed"], counts["failed"], counts["error"], counts["skip"], counts["xfail"], len(manual_rows)),
          "", "### 測試案例明細", "",
          "| 編號 | 功能 | 結果 | 證據（API 回應 / DOM 狀態 / 失敗 root cause） | 備註 |", "|------|------|------|------|------|"]
    for name, res, ev in auto_rows:
        mod, _s, fn = name.rpartition("::")
        L.append("| %s | %s | %s | %s | 自動 |" % (_md(fn), _md(mod), res, ev))
    for m in manual_rows:
        L.append("| %s | %s | %s | %s | 手動%s |" % (_md(m["id"]), _md(m["func"]), m["result"], _md(m["evidence"]),
                                                  ("；" + _md(m["note"])) if m["note"] else ""))
    issues = [(name, "待判定", ev) for name, res, ev in auto_rows if res == "FAIL"]
    issues += [(m["id"], m["sev"] or "待判定", m["evidence"] + (("；" + m["note"]) if m["note"] else ""))
               for m in manual_rows if m["result"] == "FAIL"]
    L += ["", "### 發現問題（若有）", ""]
    if issues:
        L += ["| # | 對應 TC | 嚴重程度 | 問題描述 |", "|---|---------|----------|----------|"]
        L += ["| %d | %s | %s | %s |" % (n, _md(tc), _md(sev), _md(d)) for n, (tc, sev, d) in enumerate(issues, 1)]
    else:
        L.append("無")
    # 沒有 FAIL 不等於可上板：整個等級被 skip、手動全填 N.A.／Env Limit 時 PASS 為 0，什麼都沒驗到。
    if failed:
        verdict = "需修正後重測"
    elif passed == 0:
        verdict = "未驗證（沒有任何通過的案例，不可視為上板就緒）"
    else:
        verdict = "上板就緒"
    L += ["", "### 結論", "%s；FAIL 由使用者決定，不自動修。" % verdict, ""]
    dst = os.path.join(ctx.report_dir, "smoke-report-%s.md" % run["id"])
    atomic_write_text(dst, "\n".join(L))
    out("[smoke-report] 報告：%s" % os.path.relpath(dst, ctx.ws).replace(os.sep, "/"))
    out("  總數 %d｜PASS %d｜FAIL %d｜Partial／N.A.／Env Limit %d｜結論：%s" % (total, passed, failed, other, verdict))
    if issues:
        if run.get("issues_logged_at"):
            out("  FAIL 已在 %s 寫進 %s，這次不重複追加。" % (run["issues_logged_at"], ctx.cfg["issues_log"]))
        else:
            append_issues(ctx, date, issues)
            st = ctx.load_state()
            st["run"]["issues_logged_at"] = datetime.now().isoformat(timespec="seconds")
            ctx.save_state(st)
            out("  FAIL %d 筆已追加到 %s 的 ## %s 區段。" % (len(issues), ctx.cfg["issues_log"], date))
    return 0


def cmd_stop(ctx):
    st = ctx.load_state()
    if not st["started"]:
        out("[smoke-stop] 狀態檔沒有本腳本起的程序，什麼都不做。")
        return 0
    keep = []
    for rec in st["started"]:
        out("--- %s（port %s）---" % (rec.get("service"), rec.get("port")))
        for p in rec.get("pids") or []:
            ident = proc_identity(p["pid"])
            if ident is None:
                out("  PID %s（%s）已不在，略過。" % (p["pid"], p.get("role")))
                continue
            if p.get("identity") and ident != p["identity"]:
                out("  PID %s（%s）的建立時間與紀錄不符（PID 已被別的程序重用），不碰。" % (p["pid"], p.get("role")))
                continue
            ok, msg = kill_tree(p["pid"])
            out("  停止 PID %s（%s）：%s %s" % (p["pid"], p.get("role"), "成功" if ok else "失敗", msg))
            if not ok:
                keep.append(rec)
    st["started"] = keep
    ctx.save_state(st)
    return 0 if not keep else 1


def main(argv=None):
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            try:
                stream.reconfigure(encoding="utf-8")
            except (ValueError, OSError):
                pass
    ap = argparse.ArgumentParser(description="上線前健檢（smoke test）")
    ap.add_argument("--workspace", required=True)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("try").add_argument("service")
    sub.add_parser("preflight")
    sub.add_parser("run").add_argument("level")
    sub.add_parser("report")
    sub.add_parser("stop")
    a = ap.parse_args(argv)
    try:
        ctx = Ctx(a.workspace)
        if a.cmd == "try":
            return cmd_try(ctx, a.service)
        if a.cmd == "preflight":
            return cmd_preflight(ctx)
        if a.cmd == "run":
            return cmd_run(ctx, a.level)
        if a.cmd == "report":
            return cmd_report(ctx)
        return cmd_stop(ctx)
    except SmokeError as exc:
        err("[smoke] %s" % exc)
        return exc.code


if __name__ == "__main__":
    sys.exit(main())
