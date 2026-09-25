"""可攜性掃描與交付格式（CRLF＝0）。

.sh：macOS 內建 bash 3.2 ＋ BSD 工具禁用語法；有正當理由的行內加 `# portable-ok: <理由>` 才放行。
.py/.js/.mjs：不得寫死 Windows 路徑（磁碟代號）；把 python 當命令時必須同時備 python3（macOS 沒有 python）；
Node hook 不得呼叫 Windows 專屬指令；出貨的 Python 工具檔案 I/O 與文字子程序明確 encoding。
"""
import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest

from conftest import PLUGIN, QAFLOW

SH_RULES = [
    ("declare -A（bash 4 關聯陣列）", re.compile(r"\b(?:declare|local|typeset)\s+-[a-zA-Z]*A")),
    ("mapfile/readarray（bash 4）", re.compile(r"\b(?:mapfile|readarray)\b")),
    ("${var,,} / ${var^^} 大小寫轉換（bash 4）", re.compile(r"\$\{[A-Za-z_][A-Za-z0-9_]*(?:,,?|\^\^?)\}")),
    ("&>>（bash 4）", re.compile(r"&>>")),
    ("|&（bash 4）", re.compile(r"\|&")),
    ("負索引陣列（bash 4.3）", re.compile(r"\$\{[A-Za-z_][A-Za-z0-9_]*\[-\d+\]\}")),
    ("sed -i 無後綴（BSD sed 不相容）", re.compile(r"\bsed\b(?:\s+-[a-zA-HJ-Z]+)*\s+-i(?=\s|$)")),
    ("grep -P（BSD grep 無）", re.compile(r"\bgrep\b[^|;&\n]*\s-[a-zA-Z]*P")),
    ("readlink -f（BSD 無）", re.compile(r"\breadlink\s+-[a-zA-Z]*f")),
    ("realpath（macOS 舊版無）", re.compile(r"\brealpath\b")),
    ("date -d（BSD date 無）", re.compile(r"\bdate\s+(?:-[a-zA-Z]+\s+)*-d\b")),
    ("stat -c（BSD stat 用 -f）", re.compile(r"\bstat\s+-c\b")),
    ("find -printf（BSD find 無）", re.compile(r"\bfind\b[^|;\n]*\s-printf\b")),
    ("xargs -r（BSD xargs 無）", re.compile(r"\bxargs\s+(?:-[a-zA-Z]+\s+)*-[a-zA-Z]*r\b")),
    ("timeout 指令（macOS 無）", re.compile(r"(?:^|[;&|(]\s*|\bthen\s+|\bdo\s+)timeout\s+\d")),
]
PORTABLE_OK = re.compile(r"#\s*portable-ok:\s*(\S.{3,})")


def scan_sh(text):
    """回傳 [(行號, 規則, 原文)]。整行註解略過；行內 `# portable-ok: <理由>` 放行（理由至少 4 字）。"""
    hits = []
    heredoc = None
    for i, line in enumerate(text.splitlines(), 1):
        s = line.strip()
        if heredoc:
            if s == heredoc:
                heredoc = None
            continue
        m = re.search(r"<<-?\s*['\"]?([A-Za-z_]+)['\"]?", line)
        if m and not s.startswith("#"):
            heredoc = m.group(1)
        if s.startswith("#"):
            continue
        if PORTABLE_OK.search(line):
            continue
        for name, rx in SH_RULES:
            if rx.search(line):
                hits.append((i, name, s[:100]))
    return hits


def _files(exts):
    out = []
    for root, dirs, files in os.walk(str(PLUGIN)):
        dirs[:] = [d for d in dirs if d not in ("__pycache__", ".pytest_cache", "node_modules")]
        for f in files:
            if os.path.splitext(f)[1] in exts:
                out.append(Path(root) / f)
    return sorted(out)


# ---------------- .sh ----------------

def test_sh_files_exist():
    assert QAFLOW in _files({".sh"})


@pytest.mark.parametrize("path", _files({".sh"}), ids=lambda p: p.name)
def test_sh_portable(path):
    hits = scan_sh(path.read_text(encoding="utf-8"))
    assert hits == [], "\n".join("%s:%d  [%s] %s" % (path.name, n, rule, src) for n, rule, src in hits)


@pytest.mark.parametrize("line,bad", [
    ("declare -A MAP", True), ("mapfile -t arr < f", True), ('echo "${name,,}"', True),
    ('echo "${name^^}"', True), ("cmd &>> log", True), ("cmd |& tee x", True), ('echo "${arr[-1]}"', True),
    ("sed -i 's/a/b/' f", True), ("sed -E -i 's/a/b/' f", True), ("sed -i.bak 's/a/b/' f", False),
    ("grep -P '\\d' f", True), ("grep -oP x f", True), ("grep -E '[0-9]' f", False),
    ("readlink -f x", True), ("realpath x", True), ("date -d yesterday", True), ("date +%F", False),
    ("stat -c %s f", True), ("find . -printf '%p'", True), ("xargs -r rm", True),
    ("timeout 5 cmd", True), ("x=1; timeout 5 cmd", True), ("echo timeout 5", False),
    ("mktemp -d", False), ("sed -E 's/a/b/'", False), ("local arr=()", False),
    ("realpath x  # portable-ok: 前一行已檢查 command -v realpath，缺時走 cd+pwd -P", False),
    ("realpath x  # portable-ok:", True),       # 註記沒寫理由 → 不放行
    ("realpath x  # portable-ok: ok", True),     # 理由太短 → 不放行
    ("# 註解裡提到 declare -A 不算", False),
])
def test_sh_scanner_rules_and_portable_ok(line, bad):
    assert bool(scan_sh(line)) is bad, line


def test_sh_heredoc_body_not_scanned():
    text = "cat <<'EOF'\n用法說明：不要用 declare -A\nEOF\necho ok\n"
    assert scan_sh(text) == []


def test_bash_syntax_check():
    bash = shutil.which("bash")
    if not bash:
        pytest.skip("本機沒有 bash")
    r = subprocess.run([bash, "-n", QAFLOW.as_posix()], capture_output=True, text=True)
    assert r.returncode == 0, r.stderr


def _bash32():
    for cand in (os.environ.get("QA_BASH32"), "/bin/bash"):
        if cand and os.path.exists(cand):
            try:
                v = subprocess.run([cand, "-c", "echo $BASH_VERSION"], capture_output=True, text=True).stdout
            except OSError:
                continue
            if v.startswith("3.2"):
                return cand
    return None


@pytest.mark.skipif(_bash32() is None, reason="本機無 bash 3.2（Windows Git Bash 為 5.x；macOS 內建 /bin/bash 為 3.2，"
                                               "或以 QA_BASH32 指定）——改以 test_sh_portable 靜態保證")
def test_qaflow_under_bash32():
    r = subprocess.run([_bash32(), "-n", QAFLOW.as_posix()], capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    r = subprocess.run([_bash32(), QAFLOW.as_posix(), "--help"], capture_output=True, text=True)
    assert r.returncode == 0, r.stderr


# ---------------- .py / .js / .mjs ----------------

WIN_PATH = re.compile(r"""["'`]r?[A-Za-z]:[\\/]""")
WIN_CMD_JS = re.compile(r"""\b(?:powershell|pwsh|cmd\.exe|wmic|reg\s+query|tasklist|taskkill)\b""", re.I)


def _code_lines(path):
    """(行號, 原文)；略過整行註解。行內 `portable-ok:` 註記放行。"""
    out = []
    for i, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        s = line.strip()
        if s.startswith("#") or s.startswith("//") or s.startswith("*"):
            continue
        if re.search(r"(#|//)\s*portable-ok:\s*\S.{3,}", line):
            continue
        out.append((i, line))
    return out


@pytest.mark.parametrize("path", _files({".py", ".js", ".mjs"}), ids=lambda p: "/".join(p.parts[-2:]))
def test_no_hardcoded_windows_path(path):
    hits = [(n, l.strip()) for n, l in _code_lines(path) if WIN_PATH.search(l)]
    assert hits == [], hits


@pytest.mark.parametrize("path", _files({".py", ".js", ".mjs"}), ids=lambda p: "/".join(p.parts[-2:]))
def test_python_command_has_python3_fallback(path):
    text = "\n".join(l for _n, l in _code_lines(path))
    if re.search(r"""["']python["']""", text):
        assert re.search(r"""["']python3["']""", text), "%s 把 python 當命令卻沒有 python3 備援（macOS 沒有 python）" % path


@pytest.mark.parametrize("path", _files({".js"}) + [p for p in _files({".mjs"})], ids=lambda p: p.name)
def test_node_hooks_no_windows_only_commands(path):
    hits = [(n, l.strip()) for n, l in _code_lines(path) if WIN_CMD_JS.search(l)]
    assert hits == [], hits


def _open_calls(text):
    for m in re.finditer(r"\bopen\(|(?<!cm)\.read_text\(|(?<!cm)\.write_text\(|subprocess\.(?:run|Popen)\(", text):
        depth, j = 0, m.end() - 1
        while j < len(text):
            if text[j] == "(":
                depth += 1
            elif text[j] == ")":
                depth -= 1
                if depth == 0:
                    break
            j += 1
        yield m.group(0), text[m.start(): j + 1], text[: m.start()].count("\n") + 1


@pytest.mark.parametrize("path", [p for p in _files({".py"}) if "skills" in p.parts], ids=lambda p: p.name)
def test_shipped_python_explicit_encoding(path):
    """出貨工具：文字模式 open/read_text/write_text 與 text=True 的子程序都要明確 encoding（Windows 預設 cp950）。"""
    bad = []
    text = path.read_text(encoding="utf-8")
    for kind, call, line in _open_calls(text):
        if kind.startswith("subprocess"):
            if "text=True" in call and "encoding=" not in call:
                bad.append((line, call[:80]))
            continue
        if re.search(r"""["'][rwa]b\+?["']|["']rb["']|["']wb["']""", call):
            continue
        if kind == "open(" and re.match(r"open\(\s*0\s*[,)]", call):
            continue
        if "encoding=" not in call:
            bad.append((line, call[:80]))
    assert bad == [], bad


# ---------------- 交付格式：CRLF＝0 ----------------

@pytest.mark.parametrize("path", _files({".sh", ".py", ".js", ".mjs", ".json"}), ids=lambda p: "/".join(p.parts[-2:]))
def test_no_crlf(path):
    assert path.read_bytes().count(b"\r\n") == 0
