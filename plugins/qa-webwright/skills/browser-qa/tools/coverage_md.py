"""三層架構的共用解析：模組資料夾、實際 test 函式、`<folder>/COVERAGE.md` 表格。

三層：
  1. `<folder>/COVERAGE.md` — 情境知識正本（人寫）
  2. `.runs/results.sqlite` — 執行事實（pytest hook 寫）
  3. `CATALOG.md`          — 薄索引（gen_catalog 生成，不准手改）

資料夾＝tests/e2e 底下第一層、含 `test_*.py` 的子目錄；直接放在 tests/e2e 根的測試檔
歸入「根資料夾」（folder = ""，COVERAGE 在 tests/e2e/COVERAGE.md）。

COVERAGE.md 表格約定（表頭字面值、佔位字面值由參數檔 coverage.* 決定）：

    | 使用情境（白話） | 測試函式 | 覆蓋 |
    |---|---|---|
    | 管理員停用帳號後該帳號無法登入 | `test_account.py::test_disable_blocks_login` | ✅ |

    ## 🔒 鎖定 bug
    | 情境 | 位置 | 狀態 |

    ## 本資料夾 xfail / skip
    | 測試函式 | 標記 | 原因 |
"""
import ast
import os
import re

try:
    from . import qa_config
except ImportError:
    import qa_config

DEF_RE = re.compile(r"^(?:async\s+)?def\s+(test_[A-Za-z0-9_]+)")
REF_RE = re.compile(r"(test_[A-Za-z0-9_]+\.py)::(test_[A-Za-z0-9_]+)")
SKIP_DIRS = {"tools", "reports", "_reports", "outputs", "node_modules", "helpers"}


def is_separator(s):
    return s.startswith("|") and set(s) <= set("|-: ")


def cells(line):
    return [c.strip() for c in line.strip().strip("|").split("|")]


def folder_dir(folder, root=None):
    root = root or qa_config.e2e_root()
    return os.path.join(root, folder) if folder else root


def coverage_path(folder, cfg=None, root=None):
    cfg = cfg or qa_config.load(root)
    return os.path.join(folder_dir(folder, root or cfg.root), cfg["coverage"]["file"])


def _has_tests(path):
    try:
        return any(f.startswith("test_") and f.endswith(".py") for f in os.listdir(path))
    except OSError:
        return False


def excluded_name(name):
    """稽核會略過的資料夾名：工具、報告、共用層、隱藏／雙底線開頭。登記器與 scaffold 也不得接受這些名字。"""
    # 不分大小寫：macOS／Windows 的檔案系統不分大小寫，Tools 與 tools 是同一個資料夾
    return name.startswith(".") or name.startswith("__") or name.lower() in SKIP_DIRS


def _linked_out(root, name):
    """第一層資料夾的實體路徑不在 tests/e2e 底下（symlink／junction 連到外面）。"""
    real_root = os.path.normcase(os.path.realpath(root))
    return os.path.dirname(os.path.normcase(os.path.realpath(os.path.join(root, name)))) != real_root


def test_folders(root=None):
    """含 test 檔的資料夾（依名稱排序；根資料夾以 "" 表示並排最前）。

    連到 tests/e2e 外的 symlink／junction 資料夾不算（不得把別的專案的測試與 COVERAGE 匯進來）。
    """
    root = root or qa_config.e2e_root()
    out = []
    if _has_tests(root):
        out.append("")
    for name in sorted(os.listdir(root)):
        path = os.path.join(root, name)
        if not os.path.isdir(path) or excluded_name(name) or _linked_out(root, name):
            continue
        if _has_tests(path):
            out.append(name)
    return out


def audit_folders(root=None, cfg=None):
    """稽核用的資料夾清單＝含 test 檔的資料夾 ∪ 還留著 COVERAGE.md 的資料夾。

    只看 test_folders 時，刪掉資料夾最後一支測試後，它的 COVERAGE.md 登記全變幽靈卻從稽核裡消失。
    """
    root = root or qa_config.e2e_root()
    cfg = cfg or qa_config.load(root)
    name = cfg["coverage"]["file"]
    out = list(test_folders(root))
    if "" not in out and os.path.isfile(os.path.join(root, name)):
        out.insert(0, "")
    for d in sorted(os.listdir(root)):
        path = os.path.join(root, d)
        if d in out or not os.path.isdir(path) or excluded_name(d) or _linked_out(root, d):
            continue
        if os.path.isfile(os.path.join(path, name)):
            out.append(d)
    head = [""] if "" in out else []
    return head + sorted(f for f in out if f)


def safe_folder(folder, root=None):
    """使用者給的資料夾名 → (正規化名稱, 錯誤訊息)。寫入類工具共用。

    只接受 tests/e2e 底下第一層的資料夾名（根用 "" 或 "."）：拒絕絕對路徑、含 .. 或路徑分隔、
    以及實體路徑（symlink／junction 解析後）不在 tests/e2e 底下的資料夾——否則寫入會落到 tests/e2e 外。
    """
    root = root or qa_config.e2e_root()
    f = (folder or "").strip()
    f = f.strip("/\\") if f not in ("/", "\\") else f
    if f in ("", "."):
        return "", None
    if os.path.isabs(folder or "") or "/" in f or "\\" in f or f.strip(".") == "" or ".." in f.split("/"):
        return None, "資料夾名只能是 tests/e2e 底下第一層的名稱（不得含路徑分隔、..、或為絕對路徑）：%s" % folder
    if not re.match(r"^[A-Za-z0-9_.-]+$", f):
        return None, "資料夾名只能含英數 . _ -：%s" % folder
    if excluded_name(f):
        return None, ("資料夾名 %s 是稽核工具會略過的名字（%s、. 或 __ 開頭）——登記在這裡會永遠漏出漂移稽核"
                      % (f, "／".join(sorted(SKIP_DIRS))))
    d = os.path.join(root, f)
    if os.path.exists(d):
        real_root = os.path.normcase(os.path.realpath(root))
        real = os.path.normcase(os.path.realpath(d))
        if os.path.dirname(real) != real_root:
            return None, "資料夾 %s 的實體路徑（%s）不在 tests/e2e 底下（symlink／junction？），拒絕寫入" % (f, real)
    return f, None


# 可登記的測試檔名：與登記格式 `test_x.py::test_y` 的檔名部分一致（含 . 或 - 的檔名寫不進登記，另行提醒）
TEST_FILE_RE = re.compile(r"^test_[A-Za-z0-9_]+\.py$")


def linked_out_file(path):
    """檔案本身是 symlink 且實體不在同一個資料夾（連到別處）：不得把別的專案的內容讀進來。"""
    try:
        if not os.path.islink(path):
            return False
        real_dir = os.path.normcase(os.path.dirname(os.path.realpath(path)))
        return real_dir != os.path.normcase(os.path.realpath(os.path.dirname(path)))
    except OSError:
        return True


def _test_like(folder, root=None):
    d = folder_dir(folder, root)
    try:
        names = os.listdir(d)
    except OSError:
        return d, []   # 只剩 COVERAGE.md 的資料夾也會被稽核；資料夾整個不在就當沒有測試檔
    return d, sorted(n for n in names if n.startswith("test_") and n.endswith(".py")
                     and os.path.isfile(os.path.join(d, n)))


def test_files(folder, root=None):
    """可登記的測試檔（檔名合登記格式、不是連到別處的 symlink）。"""
    d, names = _test_like(folder, root)
    return [n for n in names if TEST_FILE_RE.match(n) and not linked_out_file(os.path.join(d, n))]


def unregistrable_test_files(folder, root=None):
    """稽核看不到的測試檔：檔名含 . 或 -（登記格式寫不進去）、或連到別處的 symlink。drift_check 拿來提醒。"""
    d, names = _test_like(folder, root)
    return [n for n in names if not TEST_FILE_RE.match(n) or linked_out_file(os.path.join(d, n))]


def nested_test_files(folder, root=None):
    """資料夾底下更深一層以下的 test_*.py（三層登記只看資料夾第一層；已知限制，drift_check 拿來提醒）。"""
    base = folder_dir(folder, root)
    out = []
    if not folder:
        return out   # 根資料夾的子目錄就是各模組資料夾，各自稽核
    for dirpath, dirnames, filenames in os.walk(base):
        dirnames[:] = [x for x in dirnames if not excluded_name(x)]
        if os.path.normcase(dirpath) == os.path.normcase(base):
            continue
        for n in filenames:
            if n.startswith("test_") and n.endswith(".py"):
                out.append(os.path.relpath(os.path.join(dirpath, n), base).replace("\\", "/"))
    return sorted(out)


def code_without_strings(src):
    """字串與註解換成空白（保留換行）：多行字串裡的 `def test_…` 範例不是測試函式。tokenize 失敗回原文。"""
    import io as _io
    import tokenize
    try:
        toks = list(tokenize.generate_tokens(_io.StringIO(src).readline))
    except (tokenize.TokenError, IndentationError, SyntaxError):
        return src
    lines = src.splitlines(True)
    offs = [0]
    for ln in lines:
        offs.append(offs[-1] + len(ln))
    chars = list(src)

    def blank(a, b):
        for k in range(a, min(b, len(chars))):
            if chars[k] not in "\r\n":
                chars[k] = " "

    # Python 3.12 起 f-string 拆成 FSTRING_START／MIDDLE／END（3.14 的 t-string 同理）：整段從開頭抹到對應的結尾
    starts = {getattr(tokenize, n) for n in ("FSTRING_START", "TSTRING_START") if hasattr(tokenize, n)}
    ends = {getattr(tokenize, n) for n in ("FSTRING_END", "TSTRING_END") if hasattr(tokenize, n)}
    open_at = []
    for t in toks:
        a = offs[t.start[0] - 1] + t.start[1]
        b = offs[t.end[0] - 1] + t.end[1]
        if t.type in starts:
            open_at.append(a)
        elif t.type in ends and open_at:
            s0 = open_at.pop()
            if not open_at:
                blank(s0, b)
        elif t.type in (tokenize.STRING, tokenize.COMMENT) and not open_at:
            blank(a, b)
    return "".join(chars)


def actual_functions(folder, root=None):
    """磁碟上實際存在的 (檔名, 函式名)——以行首 `def test_` 為準（模組層函式；字串與註解裡的不算）。"""
    out = set()
    d = folder_dir(folder, root)
    for name in test_files(folder, root):
        with open(os.path.join(d, name), encoding="utf-8-sig", errors="replace") as fh:
            src = fh.read()
        for line in code_without_strings(src).splitlines():
            m = DEF_RE.match(line)
            if m:
                out.add((name, m.group(1)))
    return out


def class_test_methods(folder, root=None):
    """類別裡的 test 方法 [(檔名, 類別名, 方法名)]——三層登記只追模組層 test 函式（已知限制），這裡拿來提醒。"""
    out = []
    d = folder_dir(folder, root)
    for name in test_files(folder, root):
        try:
            with open(os.path.join(d, name), encoding="utf-8-sig", errors="replace") as fh:
                tree = ast.parse(fh.read())
        except SyntaxError:
            continue
        for node in tree.body:
            if isinstance(node, ast.ClassDef) and node.name.startswith("Test"):
                for sub in node.body:
                    if isinstance(sub, (ast.FunctionDef, ast.AsyncFunctionDef)) and sub.name.startswith("test_"):
                        out.append((name, node.name, sub.name))
    return out


def ast_function_count(folder, root=None):
    """另一條判準的函式數：AST 數模組層 test_* 函式。gen_catalog 自檢用（兩判準須一致）。"""
    n = 0
    d = folder_dir(folder, root)
    for name in test_files(folder, root):
        try:
            with open(os.path.join(d, name), encoding="utf-8-sig", errors="replace") as fh:
                tree = ast.parse(fh.read())
        except SyntaxError:
            return None
        names = {node.name for node in tree.body
                 if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
                 and node.name.startswith("test_")}
        n += len(names)
    return n


def read_text(path):
    """讀檔；不存在回 None。檔案本身是連到別處的 symlink 也回 None（不得把別的專案的內容匯進來）。"""
    if not os.path.exists(path) or linked_out_file(path):
        return None
    with open(path, encoding="utf-8-sig") as fh:
        return fh.read()


def _header_first(cfg):
    return cfg["coverage"]["header"][0]


def iter_tables(text):
    """逐一產出 (section_title, header_cells, rows[list of raw line])。"""
    section = ""
    header = None
    rows = []
    for line in text.splitlines():
        s = line.strip()
        if line.startswith("## ") or line.startswith("### "):
            if header is not None:
                yield section, header, rows
                header, rows = None, []
            section = line.lstrip("#").strip()
            continue
        if s.startswith("|"):
            if header is None:
                header = cells(s)
                continue
            if is_separator(s):
                continue
            rows.append(s)
        else:
            if header is not None:
                yield section, header, rows
                header, rows = None, []
    if header is not None:
        yield section, header, rows


def scenario_rows(text, cfg):
    """情境表（表頭第一格＝coverage.header[0]）的資料列。"""
    first = _header_first(cfg)
    out = []
    for _section, header, rows in iter_tables(text):
        if header and header[0] == first:
            out.extend(rows)
    return out


def section_rows(text, keyword):
    """標題含 keyword 的節底下所有表格資料列。"""
    out = []
    for section, _header, rows in iter_tables(text):
        if keyword and keyword in section:
            out.extend(rows)
    return out


def count_scenarios(folder, cfg, root=None):
    """(列數, ✅, ⚠️, ❌)——只數情境表，不數鎖定 bug 表與 xfail 表。"""
    text = read_text(coverage_path(folder, cfg, root))
    if text is None:
        return 0, 0, 0, 0
    rows = scenario_rows(text, cfg)
    ok = partial = missing = 0
    for r in rows:
        # 只看「覆蓋」欄（表頭第 3 格）：情境文字裡出現 ✅ 之類的字不算狀態
        c = cells(r)
        state = c[2] if len(c) > 2 else ""
        if "✅" in state:
            ok += 1
        elif "❌" in state:
            missing += 1
        elif "⚠" in state:
            partial += 1
    return len(rows), ok, partial, missing


def folder_title(folder, cfg, root=None):
    text = read_text(coverage_path(folder, cfg, root))
    if not text:
        return ""
    first = text.splitlines()[0].strip() if text.splitlines() else ""
    m = re.match(r"^#\s+\S*\s*情境覆蓋\s*(.*)$", first)
    return (m.group(1).strip() if m else "").strip("（）()")


def display_name(folder):
    return "%s/" % folder if folder else "./"


def atomic_write(path, text):
    """tmp（同目錄）＋ os.replace：寫到一半失敗不會清空正本；大小寫不敏感的檔案系統也不會刪到正本。"""
    d = os.path.dirname(path) or "."
    os.makedirs(d, exist_ok=True)
    tmp = os.path.join(d, ".%s.tmp-%d" % (os.path.basename(path), os.getpid()))
    with open(tmp, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(text)
    os.replace(tmp, path)


def existing_case_name(directory, wanted):
    """目錄裡若已有同名（不分大小寫）檔案，回傳它在磁碟上的實際大小寫；否則回 wanted。"""
    try:
        for n in os.listdir(directory):
            if n.lower() == wanted.lower():
                return n
    except OSError:
        pass
    return wanted


def skeleton_text(folder, cfg, title="", funcs=None):
    h = cfg["coverage"]["header"]
    ph = cfg["coverage"]["placeholder"]
    lines = ["# %s 情境覆蓋 %s" % (display_name(folder), title), ""]
    lines.append("> 情境知識正本（手寫）。新增/修改測試時同步這裡；`%s` 由 `tools/gen_catalog.py` "
                 "依本檔生成，改那邊會被覆蓋。" % cfg["catalog"]["file"])
    lines.append("> 覆蓋：✅完整（操作＋讀回） / ⚠️部分（附缺口原因） / ❌未覆蓋。"
                 "情境欄仍是「%s」＝佔位，drift_check 會報。" % ph)
    lines += ["", "| %s |" % " | ".join(h), "|%s" % ("---|" * len(h))]
    pad = "  |" * (len(h) - 3)   # 表頭超過三欄（備註等）：佔位列補空格，列寬一致
    for fname, func in funcs or []:
        lines.append("| %s | `%s::%s` | ⚠️ |%s" % (ph, fname, func, pad))
    lines += ["", "## %s bug" % cfg["coverage"]["locked_section"], "",
              "> 已知產品缺陷以 xfail 鎖定或刻意保留紅燈者登記於此；gen_catalog 會匯集到 CATALOG。",
              "", "| 情境 | 位置 | 狀態 |", "|---|---|---|", "",
              "## 本資料夾 %s / skip" % cfg["coverage"]["xfail_section"], "",
              "| 測試函式 | 標記 | 原因 |", "|---|---|---|", ""]
    return "\n".join(lines)
