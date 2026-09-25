"""為資料夾產骨架 COVERAGE.md（實際 test 函式全列、情境欄＝佔位字面值）。

用途：孤兒資料夾（測試存在但從未登記）先進三層架構，情境欄留佔位讓 drift_check
看得見它們（placeholder），而不是繼續隱形。**刻意不發明情境內容**。

用法：python tools/make_skeleton.py <folder|.> [標題] [--force]
已有 COVERAGE.md 時拒絕覆寫（改用 fill_orphans.py 補孤兒列），除非 --force。
"""
import argparse
import os
import sys

try:
    from . import coverage_md as cm
    from . import qa_config
except ImportError:
    import coverage_md as cm
    import qa_config


def main(argv=None):
    qa_config.force_utf8_stdio()
    cfg = qa_config.load_or_exit()
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("folder")
    ap.add_argument("title", nargs="?", default="")
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args(argv)
    folder, err = cm.safe_folder(args.folder, cfg.root)   # 拒絕 ..／絕對路徑／symlink 逃出 tests/e2e
    if err:
        print("ERROR: " + err)
        return 2
    d = cm.folder_dir(folder, cfg.root)
    if not os.path.isdir(d):
        print("找不到資料夾：%s" % d)
        return 2
    path = cm.coverage_path(folder, cfg)
    if os.path.exists(path) and not args.force:
        print("已存在，不覆寫：%s（補孤兒列請用 tools/fill_orphans.py）" % path)
        return 2
    funcs = sorted(cm.actual_functions(folder, cfg.root))
    cm.atomic_write(path, cm.skeleton_text(folder, cfg, args.title, funcs))
    print("%s: %d functions -> %s" % (cm.display_name(folder), len(funcs), path))
    return 0


if __name__ == "__main__":
    sys.exit(main())
