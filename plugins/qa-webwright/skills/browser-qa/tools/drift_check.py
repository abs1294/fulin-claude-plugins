"""漂移檢查：實際 test 函式 ↔ `<folder>/COVERAGE.md` 登記，雙向比對。

用法（於 tests/e2e 下）：
    python tools/drift_check.py all
    python tools/drift_check.py <folder>            # 根資料夾用 "."
    python tools/drift_check.py <folder> --baseline # 只報 baseline 以外的新增漂移（接閘用）
    python tools/drift_check.py all --write-baseline --why "<補了什麼登記>"
    python tools/drift_check.py all --write-baseline --why "<判準改了>" --allow-raise

三類漂移：
  孤兒（orphan）       ＝ 程式碼有這個 test 函式，COVERAGE.md 沒登記 → 情境知識缺一塊
  幽靈（ghost）        ＝ COVERAGE.md 以完整式 `檔.py::函式` 引用了不存在的函式 → 文件沒跟上
  佔位（placeholder）  ＝ 某一格整格等於佔位字面值（預設「待補」）→ 有登記沒內容

判準細節（每條都是踩過的坑）：
  - 登記認兩種寫法：完整式 `test_x.py::test_y`，與續行式（同一行先寫過檔名，
    後面只寫 `::test_z` 或裸 `test_z`）。只認完整式會把大量已登記情境誤判成孤兒。
    明寫的檔名對不上（`test_a.py::test_x` 但 test_x 在 test_b.py）不退回別檔；
    裸名在多個檔都有同名函式、又沒有檔名可綁 → 不算登記任何一支（照報孤兒，請改寫完整式）。
  - 跨資料夾引用（該函式真的存在於別的資料夾，只是被本檔說明文字提到）不算幽靈。
  - 佔位只認「整格等於字面值」，不認「這一行含有該字」——後者會把正文裡的業務詞彙誤判成未填。

全對 exit 0；有漂移 exit 1；參數錯誤／拒寫 baseline exit 2。
"""
import argparse
import os
import re
import sys

try:
    from . import baseline as bl
    from . import coverage_md as cm
    from . import qa_config
except ImportError:
    import baseline as bl
    import coverage_md as cm
    import qa_config

TOOL = "drift"
_ALL_FUNCS_CACHE = {}


def functions_elsewhere(exclude_folder, root):
    key = root
    if key not in _ALL_FUNCS_CACHE:
        _ALL_FUNCS_CACHE[key] = {f: cm.actual_functions(f, root) for f in cm.test_folders(root)}
    out = set()
    for folder, funcs in _ALL_FUNCS_CACHE[key].items():
        if folder != exclude_folder:
            out |= funcs
    return out


def registered_functions(folder, cfg, root):
    """COVERAGE.md 中引用到的 (檔名, 函式名)；沒有 COVERAGE.md 回 None。"""
    text = cm.read_text(cm.coverage_path(folder, cfg, root))
    if text is None:
        return None
    actual = cm.actual_functions(folder, root)
    by_func = {}
    for fname, func in actual:
        by_func.setdefault(func, set()).add(fname)
    reg = set()
    for line in text.splitlines():
        last_file = None
        last_file_end = -1
        prev_end = -1       # 上一個「檔名或函式引用」的結尾：裸名續寫（`test_a.py::test_x、test_y`）只隔分隔符
        for m in re.finditer(r"(test_[A-Za-z0-9_]+\.py)|(::)?(test_[A-Za-z0-9_]+)(?!\.py)", line):
            gap = line[prev_end:m.start()] if prev_end >= 0 else None
            prev_end = m.end()
            if m.group(1):
                last_file = m.group(1)
                last_file_end = m.end()
                continue
            func = m.group(3)
            owners = by_func.get(func)
            if not owners:
                # 續行式明確綁在前一個檔名上、但函式已不存在 → 幽靈：`::test_x`（前面不是緊接著檔名），
                # 或裸名續寫（和前一個引用之間只隔 、, 空白 反引號）。完整式 `檔.py::函式` 交給下方 REF_RE（含跨資料夾豁免）
                bare_cont = not m.group(2) and gap is not None and re.match(r"^[\s`,、，;／/]*$", gap)
                if last_file and ((m.group(2) and m.start() != last_file_end) or bare_cont) \
                        and (last_file, func) not in functions_elsewhere(folder, root):
                    reg.add((last_file, func))
                continue
            bare_cont = not m.group(2) and gap is not None and re.match(r"^[\s`,、，;／/]*$", gap)
            if last_file and last_file in owners:
                reg.add((last_file, func))
            elif bare_cont and last_file:
                # 裸名續寫綁在前一個檔名上（`test_a.py::test_x、test_y`）：不得退回別的檔的同名函式——
                # test_a.py 沒有 test_y ＝幽靈；test_b.py 的 test_y 照報孤兒
                if (last_file, func) not in functions_elsewhere(folder, root):
                    reg.add((last_file, func))
                continue
            elif m.group(2) and last_file:
                # `檔.py::函式` 明確綁了檔名卻對不上：不得退回別的檔的同名函式（那是幽靈＋孤兒）。
                # 完整式交給下方 REF_RE；真正的續行式（`, ::test_y`）REF_RE 抓不到，在這裡記成幽靈
                if m.start() != last_file_end and (last_file, func) not in functions_elsewhere(folder, root):
                    reg.add((last_file, func))
                continue
            elif len(owners) == 1:
                reg.add((next(iter(owners)), func))
            # 同名函式在多個檔、又沒有檔名可綁：無法判斷登記的是哪一支 → 都不算登記（照報孤兒，請改寫完整式）
    elsewhere = functions_elsewhere(folder, root)
    for fname, func in cm.REF_RE.findall(text):
        if (fname, func) not in actual and (fname, func) not in elsewhere:
            reg.add((fname, func))
    # 情境表「測試函式」欄只寫引用（沒有「交叉指路／參見」這類說明字）＝本資料夾的登記：本資料夾沒有這支＝幽靈，
    # 不因別的資料夾剛好有同名檔與函式而豁免；帶說明字的是刻意的跨資料夾指路，照舊豁免
    for row in cm.scenario_rows(text, cfg):
        c = cm.cells(row)
        rest = re.sub(r"(?:test_[A-Za-z0-9_]+\.py)?(?:::)?test_[A-Za-z0-9_]+|[`\s,、，;／/]", "", c[1]) if len(c) > 1 else "x"
        if len(c) > 1 and not rest:
            for fname, func in cm.REF_RE.findall(c[1]):
                if (fname, func) not in actual:
                    reg.add((fname, func))
    return reg


def placeholder_rows(folder, cfg, root):
    ph = cfg["coverage"]["placeholder"]
    text = cm.read_text(cm.coverage_path(folder, cfg, root))
    if text is None:
        return []
    out = []
    for line in text.splitlines():
        if not line.lstrip().startswith("|") or ph not in line:
            continue
        if not any(c == ph for c in cm.cells(line)):
            continue
        m = cm.REF_RE.search(line)
        out.append("%s::%s" % m.groups() if m else line.strip()[:60])
    return out


def check(folder, cfg=None, root=None):
    cfg = cfg or qa_config.load(root)
    root = root or cfg.root
    actual = cm.actual_functions(folder, root)
    reg = registered_functions(folder, cfg, root)
    if reg is None:
        return {"folder": folder, "missing_coverage": True, "orphans": sorted(actual),
                "ghosts": [], "placeholders": []}
    return {
        "folder": folder,
        "missing_coverage": False,
        "orphans": sorted(actual - reg),
        "ghosts": sorted(reg - actual),
        "placeholders": placeholder_rows(folder, cfg, root),
    }


def fingerprint(folder, kind, ref):
    return "%s|%s|%s" % (cm.display_name(folder), kind, ref)


def collect_fingerprints(r):
    folder = r["folder"]
    fps = []
    for f, fn in r["orphans"]:
        fps.append(fingerprint(folder, "orphan", "%s::%s" % (f, fn)))
    for f, fn in r["ghosts"]:
        fps.append(fingerprint(folder, "ghost", "%s::%s" % (f, fn)))
    for ref in r["placeholders"]:
        fps.append(fingerprint(folder, "placeholder", ref))
    return fps


def _norm_target(target):
    t = (target or "all").strip().strip("/\\")
    return "" if t in (".", "./") else t


def main(argv=None):
    qa_config.force_utf8_stdio()
    cfg = qa_config.load_or_exit()
    root = cfg.root
    ap = argparse.ArgumentParser(description="COVERAGE.md 漂移檢查（孤兒／幽靈／佔位）")
    ap.add_argument("target", nargs="?", default="all", help="all 或資料夾名（根資料夾用 .）")
    bl.add_args(ap, bl.default_path(root, TOOL))
    args = ap.parse_args(argv)

    if args.target == "all":
        folders = cm.audit_folders(root, cfg)
    else:
        # 只接受 tests/e2e 底下第一層的資料夾（拒絕 ..、絕對路徑、連到外面的 symlink）：不得讀出 tests/e2e 外的內容
        t, err = cm.safe_folder(_norm_target(args.target), root)
        if err:
            print("ERROR: " + err)
            return 2
        if t and not os.path.isdir(os.path.join(root, t)):
            print("找不到資料夾：%s" % os.path.join(root, t))
            return 2
        folders = [t]
    results = [check(f, cfg, root) for f in folders]
    all_fps = [fp for r in results for fp in collect_fingerprints(r)]

    if args.write_baseline:
        rc, msgs = bl.write(args.write_baseline, all_fps, args.why, args.allow_raise,
                            full_scan=(args.target == "all"), tool="drift_check", unit="處漂移")
        print("\n".join(msgs))
        return rc

    base = bl.load_for_gate(args.baseline) if args.baseline else None
    if args.baseline and base is None:
        print("[警告] 找不到 baseline：%s（本次以全量計）" % args.baseline)

    def keep(fp):
        return base is None or fp not in base

    total_o = total_g = total_p = drifted = exempt = 0
    for r in results:
        folder = r["folder"]
        name = cm.display_name(folder)
        orphans = [(f, fn) for f, fn in r["orphans"]
                   if keep(fingerprint(folder, "orphan", "%s::%s" % (f, fn)))]
        ghosts = [(f, fn) for f, fn in r["ghosts"]
                  if keep(fingerprint(folder, "ghost", "%s::%s" % (f, fn)))]
        placeholders = [ref for ref in r["placeholders"]
                        if keep(fingerprint(folder, "placeholder", ref))]
        exempt += (len(r["orphans"]) - len(orphans) + len(r["ghosts"]) - len(ghosts)
                   + len(r["placeholders"]) - len(placeholders))
        if r["missing_coverage"]:
            if orphans:
                drifted += 1
                total_o += len(orphans)
                print("[NO %s] %s (%d functions unregistered)"
                      % (cfg["coverage"]["file"], name, len(orphans)))
                for f, fn in orphans:
                    print("    orphan (code has, doc missing): %s::%s" % (f, fn))
            continue
        if orphans or ghosts or placeholders:
            drifted += 1
            print("[DRIFT] %-32s orphan=%d ghost=%d placeholder=%d"
                  % (name, len(orphans), len(ghosts), len(placeholders)))
            for f, fn in orphans:
                print("    orphan (code has, doc missing): %s::%s" % (f, fn))
            for f, fn in ghosts:
                print("    ghost  (doc has, code missing): %s::%s" % (f, fn))
            for ref in placeholders:
                print("    placeholder (registered, scenario=%s): %s"
                      % (cfg["coverage"]["placeholder"], ref))
            total_o += len(orphans)
            total_g += len(ghosts)
            total_p += len(placeholders)

    print("\nfolders checked=%d  drifted=%d  orphans=%d  ghosts=%d  placeholders=%d"
          % (len(folders), drifted, total_o, total_g, total_p))
    cls = [(f, c) for folder in folders for c in cm.class_test_methods(folder, root) for f in [folder]]
    if cls:
        # 已知限制：三層登記只追模組層 test 函式；類別內的 test 方法不在孤兒／幽靈判定內（不沉默，明講）
        names = sorted(set("%s%s::%s" % (cm.display_name(f), c[0], c[1]) for f, c in cls))
        print("[注意] %d 個類別內的 test 方法不在三層登記的漂移判定範圍（已知限制，見 README）：%s"
              % (len(cls), "、".join(names[:10]) + ("…" if len(names) > 10 else "")))
    # 其他看不到的測試檔（已知限制，不沉默）：子資料夾裡的、檔名含 . 或 - 的、連到別處的 symlink
    nested = ["%s%s" % (cm.display_name(f), n) for f in folders for n in cm.nested_test_files(f, root)]
    if nested:
        print("[注意] %d 個測試檔在模組資料夾的子資料夾裡，不在三層登記的漂移判定範圍（已知限制，見 README）：%s"
              % (len(nested), "、".join(nested[:10]) + ("…" if len(nested) > 10 else "")))
    odd = ["%s%s" % (cm.display_name(f), n) for f in folders for n in cm.unregistrable_test_files(f, root)]
    if odd:
        print("[注意] %d 個測試檔無法登記（檔名含 . 或 -，或是連到別處的 symlink），不在漂移判定範圍：%s"
              % (len(odd), "、".join(odd[:10]) + ("…" if len(odd) > 10 else "")))
    if base is not None:
        print("[baseline] 存量豁免 %d 筆（%s）；本次**新增**漂移：%d 個資料夾"
              % (exempt, args.baseline, drifted))
    if drifted:
        print("QA-TOOL-RESULT: violations")
    return 1 if drifted else 0


def summary_line(root=None):
    """給 pytest terminal summary 用：(是否乾淨, 一行摘要)。"""
    cfg = qa_config.load(root)
    root = cfg.root
    o = g = p = 0
    folders = cm.audit_folders(root, cfg)
    for f in folders:
        r = check(f, cfg, root)
        o += len(r["orphans"])
        g += len(r["ghosts"])
        p += len(r["placeholders"])
    return (o + g + p == 0), ("folders=%d orphans=%d ghosts=%d placeholders=%d"
                             % (len(folders), o, g, p))


if __name__ == "__main__":
    sys.exit(main())
