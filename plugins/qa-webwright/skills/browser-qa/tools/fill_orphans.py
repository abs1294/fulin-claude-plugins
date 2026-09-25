"""把孤兒測試（程式碼有、COVERAGE.md 未登記）補成佔位列。

刻意不發明情境內容：情境欄一律佔位字面值（預設「待補」）、覆蓋欄 ⚠️，只保證每個測試函式
在文件裡看得見；drift_check 會把它們報成 placeholder，直到有人寫上白話情境。

用法：python tools/fill_orphans.py [folder|all] [--dry-run]
沒有 COVERAGE.md 的資料夾會先建骨架（同 make_skeleton）。
"""
import argparse
import os
import sys

try:
    from . import coverage_md as cm
    from . import drift_check
    from . import qa_config
except ImportError:
    import coverage_md as cm
    import drift_check
    import qa_config

MARKER = "<!-- orphan-skeleton -->"


def scenario_table_end(lines, cfg, info=None):
    """情境表最後一列的下一個 index；找不到情境表回 None。info（dict）會填入 width＝表頭欄數。"""
    first = cfg["coverage"]["header"][0]
    in_tbl = False
    last = None
    for i, ln in enumerate(lines):
        s = ln.strip()
        if s.startswith("|"):
            if not in_tbl and cm.cells(s)[0] == first:
                in_tbl = True
                last = i
                if info is not None:
                    info["width"] = max(3, len(cm.cells(s)))
                continue
            if in_tbl:
                last = i
        elif in_tbl:
            break
    return (last + 1) if last is not None else None


def main(argv=None):
    qa_config.force_utf8_stdio()
    cfg = qa_config.load_or_exit()
    ap = argparse.ArgumentParser()
    ap.add_argument("target", nargs="?", default="all")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args(argv)
    ph = cfg["coverage"]["placeholder"]
    if args.target == "all":
        folders = []
        for f in cm.test_folders(cfg.root):
            safe, err = cm.safe_folder(f, cfg.root)   # symlink／junction 連到 tests/e2e 外的資料夾不寫
            if err:
                print("SKIP：%s" % err)
                continue
            folders.append(safe)
    else:
        t, err = cm.safe_folder(args.target, cfg.root)   # 拒絕 ..／絕對路徑／symlink 逃出 tests/e2e
        if err:
            print("ERROR: " + err)
            return 2
        if not os.path.isdir(cm.folder_dir(t, cfg.root)):
            print("ERROR: 找不到資料夾：%s" % cm.folder_dir(t, cfg.root))
            return 2
        folders = [t]
    total = 0
    for folder in folders:
        r = drift_check.check(folder, cfg, cfg.root)
        orphans = r["orphans"]
        if not orphans:
            continue
        path = cm.coverage_path(folder, cfg)
        if r["missing_coverage"]:
            text = cm.skeleton_text(folder, cfg, "", orphans)
        else:
            lines = cm.read_text(path).splitlines()
            info = {}
            idx = scenario_table_end(lines, cfg, info)
            if idx is None:
                print("SKIP（找不到情境表，表頭第一格應為「%s」）：%s"
                      % (cfg["coverage"]["header"][0], path))
                continue
            # 三欄之後的自訂欄（備註等）補空格，列寬與表頭一致
            pad = "  |" * (info.get("width", 3) - 3)
            rows = ["| %s | `%s::%s` | ⚠️ |%s" % (ph, f, fn, pad) for f, fn in orphans]
            text = "\n".join(lines[:idx] + rows + lines[idx:]) + "\n"
            if MARKER not in text:
                text += "\n%s 佔位列由 fill_orphans 補上；把「%s」換成白話情境。\n" % (MARKER, ph)
        if not args.dry_run:
            cm.atomic_write(path, text)
        print("  %-34s +%d" % (cm.display_name(folder), len(orphans)))
        total += len(orphans)
    print("%sskeleton rows added: %d" % ("[dry-run] " if args.dry_run else "", total))
    return 0


if __name__ == "__main__":
    sys.exit(main())
