"""掃出「以顯示文字（預設 CJK）定位元素」的測試碼——切換語系就會失效的那些。

用法（於 tests/e2e 下）：
    python tools/i18n_locator_check.py [folder|all]        # 統計
    python tools/i18n_locator_check.py all --list          # 逐筆
    python tools/i18n_locator_check.py all --list --only-locator
    python tools/i18n_locator_check.py all --strict        # 位於「會切語系的檔」的定位器 > 0 → exit 1
    python tools/i18n_locator_check.py <folder> --baseline # 只報新增定位器（接閘用）
    python tools/i18n_locator_check.py all --write-baseline --why "<改掉了什麼>"

字元類讀參數檔 i18n.script_class（regex 字元類內容，預設 `\\u4e00-\\u9fff`）。
例：日文加 `\\u3040-\\u30ff`，韓文 `\\uac00-\\ud7af`。

## 定位器 vs 斷言

- **定位器**（get_by_role(name=)／get_by_text／has_text／:has-text()…）：用顯示文字找元素，
  切語系後找不到元素 → timeout。這是基建缺陷，要改錨在不隨語系變的東西。
- **斷言**（`assert "文字" in x.inner_text()`）：驗畫面顯示文字對不對，在該語系下是正確意圖；
  但若該測試會切語系，期望值要跟著語系走（查 i18n 資源或 parametrize）。

⚠ 有 `assert`／`expect(` 不等於是斷言：`assert page.get_by_text("送出").count() > 0`、
`expect(page.get_by_text("送出")).to_have_text("送出")`、`assert page.get_by_text("送出").inner_text() == "送出"`
都是**定位器套了斷言外殼**——元素本身是用顯示文字找到的，切語系一樣找不到。判準：
get_by_*()／filter(has_text=) 一律是定位器；text=／:has-text()／:text-is() 這類字串只有出現在
比較運算子（== != in）或 to_have_*( 之後（＝期望值那一側）且沒有存在性檢查時才算斷言。

修法優先序：產品既有錨（id／name／元件庫 class／路由）→ i18n key 取當前語系譯文 → 位置／順序 →
測試端執行時 setAttribute 打標記。⛔ 不得為了測試在產品碼埋 data-testid／data-qa 類屬性。
"""
import argparse
import os
import re
import sys

try:
    from . import baseline as bl
    from . import qa_config
except ImportError:
    import baseline as bl
    import qa_config

TOOL = "i18n-locator"
ASSERT_HINT = re.compile(r"\bassert\b|\bexpect\(")
EXISTENCE_HINT = re.compile(
    r"\.count\(\)|\.is_visible\(\)|\.is_hidden\(\)|\.is_enabled\(\)|\.is_disabled\(\)|"
    r"\.first\b|\.last\b|\.nth\(|to_be_visible|to_be_hidden|to_have_count|to_be_enabled|to_be_disabled")


def patterns(script_class):
    c = script_class
    # 值可以是字串，也可以是 re.compile("…")（正規表示式定位同樣以顯示文字找元素）
    rx = r'(?:re\.compile\(\s*)?'
    return [
        ("get_by_role(name=)", re.compile(r'get_by_role\([^)]*name\s*=\s*[^)]*[%s]' % c)),
        ("get_by_text()", re.compile(r'get_by_text\(\s*%s[fru]*["\'][^"\']*[%s]' % (rx, c))),
        ("get_by_label()", re.compile(r'get_by_label\(\s*%s[fru]*["\'][^"\']*[%s]' % (rx, c))),
        ("get_by_placeholder()", re.compile(r'get_by_placeholder\(\s*%s[fru]*["\'][^"\']*[%s]' % (rx, c))),
        ("get_by_title()", re.compile(r'get_by_title\(\s*%s[fru]*["\'][^"\']*[%s]' % (rx, c))),
        ("get_by_alt_text()", re.compile(r'get_by_alt_text\(\s*%s[fru]*["\'][^"\']*[%s]' % (rx, c))),
        # "text=送出" 與串接選擇器 "button >> text=送出"
        ("text= 選擇器", re.compile(r'(?:["\']|>>\s*)text=[^"\']*[%s]' % c)),
        (":has-text()", re.compile(r'has-text\([^)]*[%s]' % c)),
        ("filter(has_text=)", re.compile(r'has_text\s*=\s*%s[fru]*["\'][^"\']*[%s]' % (rx, c))),
        (":text-is()", re.compile(r'text-is\([^)]*[%s]' % c)),
    ]


# 期望值那一側：比較運算子之後、或 Playwright 斷言方法（to_have_text(…)）的參數裡
VALUE_SIDE = re.compile(r"==|!=|\bnot\s+in\b|\bin\b|\.to_(?:have|contain)_\w*\(")


# 參數是「選擇器／定位條件」的呼叫：字串出現在這些呼叫的括號裡＝拿來找元素，不是期望值
LOCATOR_CALLS = {
    "locator", "frame_locator", "get_by_text", "get_by_role", "get_by_label", "get_by_placeholder", "get_by_title",
    "get_by_alt_text", "filter", "wait_for_selector", "query_selector", "query_selector_all", "click", "dblclick",
    "fill", "type", "press", "hover", "check", "uncheck", "select_option", "is_visible", "is_hidden", "is_enabled",
    "text_content", "inner_text", "inner_html", "focus", "tap", "set_input_files", "dispatch_event",
    "eval_on_selector", "eval_on_selector_all",
}


def string_mask(code):
    """每個字元是否在字串字面值裡（bytearray，1＝字串內）：括號配對要略過字串裡的括號。解析失敗回全 0。"""
    import io
    import tokenize
    mask = bytearray(len(code))
    try:
        toks = list(tokenize.generate_tokens(io.StringIO(code).readline))
    except (tokenize.TokenError, IndentationError, SyntaxError):
        return mask
    offs = [0]
    for ln in code.splitlines(True):
        offs.append(offs[-1] + len(ln))
    fs_start = getattr(tokenize, "FSTRING_START", None)   # Python 3.12+：f-string 拆成 FSTRING_* 多個 token
    fs_end = getattr(tokenize, "FSTRING_END", None)
    open_fs = []
    for t in toks:
        a = offs[t.start[0] - 1] + t.start[1]
        b = offs[t.end[0] - 1] + t.end[1]
        if fs_start is not None and t.type == fs_start:
            open_fs.append(a)
            continue
        if fs_end is not None and t.type == fs_end and open_fs:
            a = open_fs.pop()   # 整個 f-string（含 {…} 內的括號）都算字串內
        elif t.type != tokenize.STRING:
            continue
        for k in range(a, min(b, len(mask))):
            mask[k] = 1
    return mask


def _open_calls(code, mask, pos, limit=3000):
    """pos 往回、尚未閉合的呼叫（由內而外）：[(呼叫名稱, '(' 的位置)]。字串裡的括號不算；可跨行。"""
    out = []
    depth = 0
    for j in range(pos - 1, max(-1, pos - limit), -1):
        if mask[j]:
            continue
        c = code[j]
        if c == ")":
            depth += 1
        elif c == "(":
            if depth:
                depth -= 1
                continue
            m = re.search(r"([A-Za-z_]\w*)\s*$", code[max(0, j - 80):j])
            out.append((m.group(1) if m else "", j))
    return out


def _close_of(code, mask, paren, limit=3000):
    """paren 位置的 ( 對應的 ) 之後；字串裡的括號不算。找不到回 None。"""
    depth = 0
    for j in range(paren, min(len(code), paren + limit)):
        if mask[j]:
            continue
        if code[j] == "(":
            depth += 1
        elif code[j] == ")":
            depth -= 1
            if depth == 0:
                return j + 1
    return None


def is_value_side(code, mask, kind, pos):
    """這一處命中（code 裡的位置 pos）是不是「斷言的期望值」而非定位器。

    get_by_*()／filter(has_text=) 是呼叫本身＝一定是定位器——就算包在 expect(…) 或 assert 裡
    （`expect(page.get_by_text("送出")).to_have_text("送出")` 驗的對象是用顯示文字找到的元素，切語系一樣找不到）。
    text=／:has-text()／:text-is() 是字串，只有出現在比較運算子或 to_have_*( 之後、且不在 locator(…) 這類
    選擇器呼叫的括號裡才是期望值（`assert "送出" == page.locator("text=送出").inner_text()` 仍是定位器）。
    判斷以「整個敘述」為範圍（可跨行：`.to_have_text(\\n "text=送出"\\n)` 的期望值在下一行）。
    """
    if kind.startswith("get_by") or kind.startswith("filter("):
        return False
    calls = _open_calls(code, mask, pos)
    if any(name in LOCATOR_CALLS for name, _p in calls):
        return False
    # 敘述範圍：最外層未閉合括號所在那一行的行首 → 它的配對 )（沒有括號就是命中那一行）
    outer = calls[-1][1] if calls else pos
    s0 = code.rfind("\n", 0, outer) + 1
    end = _close_of(code, mask, calls[-1][1]) if calls else None
    if end is None:
        nl = code.find("\n", pos)
        end = len(code) if nl < 0 else nl
    stmt = code[s0:max(end, pos)]
    if not ASSERT_HINT.search(stmt) or EXISTENCE_HINT.search(stmt):
        return False
    if calls and re.match(r"to_(?:have|contain)_\w*$", calls[0][0]):
        return True   # 直接是 to_have_text(…) 這類斷言方法的參數
    return bool(VALUE_SIDE.search(code[s0:pos]))


def code_only(src):
    """註解與 docstring／裸字串敘述換成空白（保留換行與長度，行號與欄位可直接對回原檔）。

    說明文字裡的定位器範例（「不要寫 page.get_by_text("送出")」）不是可執行的定位器。解析失敗回 None。
    """
    import ast
    import io
    import tokenize
    try:
        tree = ast.parse(src)
        toks = list(tokenize.generate_tokens(io.StringIO(src).readline))
    except (SyntaxError, tokenize.TokenError, IndentationError):
        return None
    lines = src.splitlines(True)
    offs = [0]
    for ln in lines:
        offs.append(offs[-1] + len(ln))
    chars = list(src)

    def blank(sl, sc, el, ec):
        a, b = offs[sl - 1] + sc, offs[el - 1] + ec
        for k in range(a, min(b, len(chars))):
            if chars[k] not in "\r\n":
                chars[k] = " "

    def char_col(lineno, byte_col):
        # ast 的 col_offset 是 UTF-8 位元組位移；換成字元位移（行內有中文時兩者不同）
        return len(lines[lineno - 1].encode("utf-8")[:byte_col].decode("utf-8", "replace"))
    for t in toks:
        if t.type == tokenize.COMMENT:   # tokenize 的欄位已是字元位移
            blank(t.start[0], t.start[1], t.end[0], t.end[1])
    for node in ast.walk(tree):
        if isinstance(node, ast.Expr) and isinstance(getattr(node, "value", None), ast.Constant) \
                and isinstance(node.value.value, str) and getattr(node, "end_lineno", None):
            blank(node.lineno, char_col(node.lineno, node.col_offset),
                  node.end_lineno, char_col(node.end_lineno, node.end_col_offset))
    return "".join(chars)


def scan(cfg, target="all", errors=None):
    """errors（list）：讀不到的檔加進去——呼叫端據此判定「掃描不完整」，不得當成乾淨。"""
    i18n = cfg.get("i18n") or {}
    pats = patterns(i18n.get("script_class") or "一-鿿")
    hints = [h for h in i18n.get("locale_switch_hints") or [] if h]
    switch_re = re.compile("|".join(hints)) if hints else None
    root = cfg.root
    rows = []
    locale_files = set()
    if target in ("", "."):
        walk = [(root, [], [f for f in os.listdir(root) if f.endswith(".py")])]
    else:
        base = root if target == "all" else os.path.join(root, target)
        walk = os.walk(base, onerror=lambda e: errors.append("%s（%s）" % (
            os.path.relpath(getattr(e, "filename", "") or base, root).replace("\\", "/"), type(e).__name__))
            if errors is not None else None)
    for dirpath, dirnames, filenames in walk:
        dirnames[:] = [d for d in dirnames if d not in ("__pycache__", ".runs", "outputs", "tools",
                                                        "reports", "_reports") and not d.startswith(".")]
        for fn in sorted(filenames):
            if not fn.endswith(".py"):
                continue
            path = os.path.join(dirpath, fn)
            rel = os.path.relpath(path, root).replace("\\", "/")
            try:
                with open(path, encoding="utf-8-sig", errors="replace") as fh:
                    src = fh.read()
            except OSError as exc:
                if errors is not None:
                    errors.append("%s（%s）" % (rel, type(exc).__name__))
                continue
            if switch_re and switch_re.search(src):
                locale_files.add(rel)
            code = code_only(src)
            src_lines = src.splitlines()
            if code is None:
                # 解析不了：退回逐行比對、只略過整行註解
                code = "\n".join(("" if ln.strip().startswith("#") else ln) for ln in src_lines)
            mask = string_mask(code)
            by_line = {}
            # 對整份（已去掉註解／docstring 的）原始碼比對：跨行寫的 get_by_text(\n "送出"\n) 也抓得到
            for kind, pat in pats:
                for m in pat.finditer(code):
                    lineno = code.count("\n", 0, m.start()) + 1
                    by_line.setdefault(lineno, []).append((kind, m.start(), _call_span(code, m, mask)))
            for lineno in sorted(by_line):
                found = by_line[lineno]
                # 每一處命中都在「期望值那一側」才算斷言；任一處是定位器（含套在 expect()／assert 裡的）就算定位器
                values = [is_value_side(code, mask, kind, pos) for kind, pos, _s in found]
                is_assert = all(values)
                kind = next((k for (k, _c, _s), v in zip(found, values) if not v), found[0][0])
                text = src_lines[lineno - 1] if lineno - 1 < len(src_lines) else ""
                # 指紋用整個呼叫（跨行也收），不只首行：改了第二行的文字就是新的定位器，不得沿用舊 baseline
                sig = " | ".join(sorted(set(s for _k, _c, s in found)))
                rows.append({"file": rel, "line": lineno, "kind": kind,
                             "is_assert": is_assert, "text": mask_display(text.strip())[:100], "sig": sig})
    for r in rows:
        r["switches_locale"] = r["file"] in locale_files
    return rows


def _call_span(code, m, mask=None):
    """命中處的完整文字（空白正規化）：有括號就取到配對的 )（字串裡的括號不算），否則取到字串結束的引號。"""
    start = m.start()
    mask = mask if mask is not None else bytearray(len(code))
    paren = -1
    for j in range(start, m.end()):
        if code[j] == "(" and not mask[j]:
            paren = j
            break
    end = _close_of(code, mask, paren) if paren >= 0 else None
    if end is None:
        q = re.search(r"[\"']", code[m.end():m.end() + 500])
        end = m.end() + (q.end() if q else 0)
    return " ".join(code[start:end].split())


# 清單顯示用：填入欄位的值（fill／type／press_sequentially）與密碼類欄位的值一律遮罩——那常是真實帳密
_FILL_CALL_RE = re.compile(r"\.(?:fill|type|press_sequentially|set_input_files)\(")
_STR_RE = re.compile(r"""[fru]*(["'])(?:\\.|(?!\1)[^\\])*\1""")
_SECRET_KV_RE = re.compile(r"""((?:passw(?:or)?d|passwd|pwd|pass|pw|secret|token|api[_-]?key)\w*["']?\s*[=:]\s*[fru]*)(["'])(?:\\.|(?!\2)[^\\])*\2""", re.I)


def mask_display(text):
    """fill／type 呼叫的「最後一個字串參數」（填入的值；page.fill(選擇器, 值) 的值、locator.fill(值) 的值）遮罩。"""
    text = text or ""
    for m in reversed(list(_FILL_CALL_RE.finditer(text))):
        depth, end = 1, len(text)
        j = m.end()
        while j < len(text):
            sm = _STR_RE.match(text, j)
            if sm:
                j = sm.end()
                continue
            if text[j] == "(":
                depth += 1
            elif text[j] == ")":
                depth -= 1
                if depth == 0:
                    end = j
                    break
            j += 1
        strs = list(_STR_RE.finditer(text, m.end(), end))
        if strs:
            last = strs[-1]
            q = last.group(1)
            text = text[:last.start()] + q + "***" + q + text[last.end():]
    return _SECRET_KV_RE.sub(lambda m: m.group(1) + m.group(2) + "***" + m.group(2), text)


def fingerprint(r):
    return "%s|%s|%s" % (r["file"], r["kind"], r.get("sig") or r["text"])


def main(argv=None):
    qa_config.force_utf8_stdio()
    cfg = qa_config.load_or_exit()
    ap = argparse.ArgumentParser(description="顯示文字定位器檢查")
    ap.add_argument("target", nargs="?", default="all")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--only-locator", action="store_true")
    ap.add_argument("--strict", action="store_true")
    bl.add_args(ap, bl.default_path(cfg.root, TOOL))
    args = ap.parse_args(argv)
    if not (cfg.get("i18n") or {}).get("enabled", True):
        print("[i18n] 參數檔 i18n.enabled=false，本檢查停用。")
        return 0
    target = args.target.strip("/\\")
    target = "" if target == "." else target
    if target not in ("all", "") and not os.path.isdir(os.path.join(cfg.root, target)):
        print("找不到資料夾：%s" % os.path.join(cfg.root, target))
        return 2
    errors = []
    rows = scan(cfg, target, errors)
    if errors:
        # 掃描不完整：不得回報「沒有定位器」，也不得據此重寫 baseline
        print("[ERROR] 讀不到 %d 個檔，掃描不完整（不當成乾淨、不寫 baseline）：%s" % (len(errors), "、".join(errors[:10])))
        print("QA-TOOL-RESULT: scan-error")
        return 2

    if args.write_baseline:
        # 只收定位器（斷言是正確意圖，不進閘）
        fps = [fingerprint(r) for r in rows if not r["is_assert"]]
        rc, msgs = bl.write(args.write_baseline, fps, args.why, args.allow_raise,
                            full_scan=(args.target == "all"), tool="i18n_locator_check", unit="處定位器")
        print("\n".join(msgs))
        return rc

    if args.baseline:
        base = bl.load_for_gate(args.baseline)
        if base is None:
            print("[警告] 找不到 baseline：%s（本次以全量計）" % args.baseline)
        else:
            n_all = len(rows)
            rows = [r for r in rows if r["is_assert"] or fingerprint(r) not in base]
            print("[baseline] 存量豁免 %d 處" % (n_all - len(rows)))

    locators = [r for r in rows if not r["is_assert"]]
    asserts = [r for r in rows if r["is_assert"]]
    high = [r for r in locators if r["switches_locale"]]
    print("以顯示文字定位／斷言的命中：共 %d 處（%d 個檔）" % (len(rows), len({r["file"] for r in rows})))
    print("  定位器（切語系會找不到元素）：%d 處；其中位於「會切語系的檔」：%d 處  ← 最高風險"
          % (len(locators), len(high)))
    print("  斷言（驗顯示文字內容）：%d 處" % len(asserts))
    if args.list or args.baseline:
        show = locators if (args.only_locator or args.baseline) else rows
        for r in sorted(show, key=lambda r: (r["file"], r["line"])):
            tag = "斷言" if r["is_assert"] else "定位"
            risk = " [會切語系]" if r["switches_locale"] and not r["is_assert"] else ""
            print("  %s:%d  [%s]%s %s" % (r["file"], r["line"], tag, risk, r["text"]))
    if locators:
        print("修法：改錨在產品既有 id／name／元件 class／路由 → i18n key 取譯文 → 位置／順序 → 測試端 setAttribute。"
              "⛔ 不得在產品碼埋 data-testid 類屬性。")
    if args.baseline and locators:
        print("QA-TOOL-RESULT: violations")
        return 1
    if args.strict and high:
        print("QA-TOOL-RESULT: violations")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
