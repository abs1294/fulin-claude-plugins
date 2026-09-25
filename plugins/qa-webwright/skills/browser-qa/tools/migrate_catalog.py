"""一次性遷移：舊版單一 catalog（4 欄：白話業務情境｜對應測試函式｜覆蓋狀態｜業務模組分類）→ 三層。

用法（於 tests/e2e 下；qa-flow.sh migrate 會代跑）：
    python tools/migrate_catalog.py [--dry-run]

做法（用程式搬而非手抄：手工搬運必漏，程式搬可對帳）：
  1. 只認本 plugin 骨架的舊 catalog（同時命中「qa-flow.sh catalog 回填」標記與 4 欄表頭），
     其他格式一律拒絕（曾有對非本 plugin 格式的 catalog 解析，整份 320 列全報孤兒的事故）。
  2. 每列依「對應測試函式」找它實際所在的資料夾與檔案，寫進 `<folder>/COVERAGE.md` 情境表
     （函式為 — 的列：模組名恰好是資料夾名就放那裡，否則放 tests/e2e 根的 COVERAGE.md）。
  3. 對帳：舊資料列數 ＝ 新寫入列數 ＋ 已存在而略過的列數，不等就 exit 1（先全部算好、對帳相符才寫檔）。
     「已存在」只算同一函式＋同一情境＋同一狀態的完全重複；同一函式的其他情境照樣遷入。
     同名函式在多個檔都有定義 → 不猜，一列都不寫、exit 1，請先在舊 catalog 寫成完整式。
     函式為 — 的列，模組欄只認 tests/e2e 第一層資料夾名（..／絕對路徑／symlink 逃出一律放根 COVERAGE）。
  4. 舊檔**改名**保留為 catalog.pre-migrate-<日期>.md（os.replace，不刪）。改名要先於產生新的
     CATALOG.md——Windows NTFS 與 macOS APFS 預設大小寫不敏感，catalog.md 與 CATALOG.md 是同一個檔。

exit 0＝完成且對帳相符；1＝對帳不符；2＝找不到或不是本 plugin 格式。
"""
import argparse
import os
import re
import sys
from datetime import date

try:
    from . import coverage_md as cm
    from . import qa_config
except ImportError:
    import coverage_md as cm
    import qa_config

MARK = "qa-flow.sh catalog 回填"
HEADER = "白話業務情境 | 對應測試函式 | 覆蓋狀態 | 業務模組分類"
EMOJI = (("✅", "✅"), ("⚠", "⚠️"), ("❌", "❌"))


def find_legacy(root):
    for n in os.listdir(root):
        if n.lower() == "catalog.md":
            return os.path.join(root, n)
    return None


def parse_rows(text):
    rows = []
    for line in text.splitlines():
        s = line.strip()
        if not s.startswith("|") or cm.is_separator(s):
            continue
        c = cm.cells(s)
        if c and c[0] == "白話業務情境":
            continue
        if len(c) < 4:
            continue
        rows.append((c[0], c[1], c[2], c[3]))
    return rows


def locate(func, root, index):
    # 可帶資料夾：orders/test_x.py::test_y（不同資料夾有同名檔時用來消除歧義）
    m = re.match(r"^`?(?:([A-Za-z0-9_.-]+)/)?(test_[A-Za-z0-9_]+\.py)::(test_[A-Za-z0-9_]+)`?$", func)
    if m:
        hits = [(fo, fi) for fo, fi, fn in index
                if fi == m.group(2) and fn == m.group(3) and (m.group(1) is None or fo == m.group(1))]
        name = m.group(3)
    else:
        name = func.strip("`")
        hits = [(fo, fi) for fo, fi, fn in index if fn == name]
    return hits, name


def main(argv=None):
    qa_config.force_utf8_stdio()
    cfg = qa_config.load_or_exit()
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args(argv)
    root = cfg.root
    legacy = find_legacy(root)
    if not legacy:
        print("[migrate] 找不到舊版 catalog.md（%s）" % root)
        return 2
    if cm.linked_out_file(legacy):
        # 連到別處（別的專案）的 catalog：搬進來會把別人的情境寫進本專案 COVERAGE → 拒絕
        print("[migrate] %s 是連到別處的 symlink，拒絕遷移（請把舊 catalog 本體放進 tests/e2e）。" % legacy)
        return 2
    with open(legacy, encoding="utf-8-sig") as fh:
        text = fh.read()
    if MARK not in text or HEADER not in text:
        print("[migrate] %s 不是本 plugin 骨架格式（缺「%s」標記或 4 欄表頭），拒絕遷移。" % (legacy, MARK))
        if "tools/gen_catalog.py` 生成" in text:
            print("          它看起來已是三層模式生成的 CATALOG，不需遷移。")
        return 2

    rows = parse_rows(text)
    ph = cfg["coverage"]["placeholder"]
    # 只索引 tests/e2e 第一層的實體資料夾：symlink／junction 連到外面的資料夾不遷入（寫入會落到 tests/e2e 外）
    safe_folders = [fo for fo in cm.test_folders(root) if not cm.safe_folder(fo, root)[1]]
    index = [(fo, fi, fn) for fo in safe_folders for fi, fn in cm.actual_functions(fo, root)]
    plan = {}          # folder -> [(函式欄, 情境, emoji, row line)]
    unresolved = []
    ambiguous = []
    for scen, func, state, module in rows:
        emoji = next((e for k, e in EMOJI if k in state), "⚠️")
        label = None
        if func in ("—", "-", ""):
            # 模組欄只當「tests/e2e 第一層資料夾名」用：../、絕對路徑、symlink 逃出 → 放根 COVERAGE
            safe, _err = cm.safe_folder(module, root) if module else ("", None)
            folder = safe if safe and os.path.isdir(os.path.join(root, safe)) else ""
            ref = "—"
        else:
            hits, name = locate(func, root, index)
            if len(hits) > 1:
                ambiguous.append("%s → %s" % (func, "、".join("%s%s" % (cm.display_name(fo), fi) for fo, fi in hits)))
                continue
            if hits:
                folder, fname = hits[0]
                ref = "`%s::%s`" % (fname, name)
            else:
                # 磁碟上找不到的函式：函式欄寫佔位字，drift_check 會報 placeholder（不能讓失效登記在遷移後變成零漂移）
                folder, ref = "", ph
                unresolved.append(func)
                label = "%s〔原函式：%s，磁碟上找不到%s〕" % (scen, func.strip("`"), "；模組：%s" % module if module else "")
        if label is None:
            label = scen if (not module or module == folder) else "%s〔模組：%s〕" % (scen, module)
        plan.setdefault(folder, []).append((ref, label, emoji, "| %s | %s | %s |" % (label, ref, emoji)))

    if ambiguous:
        # 同名函式在多個檔／資料夾：猜第一個＝把情境登記到錯的測試，還宣稱對帳成功。一列都不寫，請人先寫成完整式。
        print("[migrate] ❌ %d 列的測試函式在多個檔案都有同名定義，無法自動判斷歸屬（未寫任何檔、舊檔保留）：" % len(ambiguous))
        for a in ambiguous[:20]:
            print("    %s" % a)
        print("[migrate] 修法：在舊 catalog 把這些列的函式改寫成完整式 test_x.py::test_y（不同資料夾同檔名時寫 資料夾/test_x.py::test_y）後重跑。")
        return 1

    written = skipped = 0
    first = cfg["coverage"]["header"][0]
    outputs = []       # (path, 新全文, 這次要加的列) —— 先全部算好、確認沒有錯才一起寫（避免寫一半中止）
    for folder, items in sorted(plan.items()):
        path = cm.coverage_path(folder, cfg, root)
        cur = cm.read_text(path) or cm.skeleton_text(folder, cfg)
        lines = cur.splitlines()
        existing = [cm.cells(e) for e in cm.scenario_rows(cur, cfg)]
        new_lines = []
        for ref, label, emoji, line in items:
            # 只略過「同一函式欄、同一情境、同一狀態」的完全重複（含 — 列與找不到函式的佔位列：
            # 中途失敗後重跑不會重複追加）；同一函式的另一個情境或不同狀態照樣遷入
            dup = any(len(c) > 2 and c[1] == ref and c[0] == label and emoji[0] in c[2] for c in existing)
            if dup or line in new_lines:
                skipped += 1
                continue
            new_lines.append(line)
        # 插在情境表末端
        idx = None
        in_tbl = False
        width = 3
        for i, ln in enumerate(lines):
            s = ln.strip()
            if s.startswith("|"):
                if not in_tbl and cm.cells(s)[0] == first:
                    in_tbl = True
                    width = max(3, len(cm.cells(s)))
                if in_tbl:
                    idx = i
            elif in_tbl:
                break
        if idx is None:
            print("[migrate] %s 找不到情境表（表頭第一格應為「%s」），中止（未寫任何檔）。" % (path, first))
            return 1
        # 表頭超過三欄（備註等自訂欄）：新列補空格，列寬與表頭一致
        new_lines = [ln + "  |" * (width - 3) for ln in new_lines]
        lines[idx + 1:idx + 1] = new_lines
        written += len(new_lines)
        print("  %-30s +%d 列" % (cm.display_name(folder), len(new_lines)))
        outputs.append((path, "\n".join(lines) + "\n", new_lines))

    print("[migrate] 舊資料列 %d ＝ 新寫入 %d ＋ 已存在略過 %d" % (len(rows), written, skipped))
    if unresolved:
        print("[migrate] ⚠️ %d 列的測試函式在磁碟上找不到（放在根 COVERAGE、函式欄為「%s」，drift_check 會列為佔位待處理）：%s"
              % (len(unresolved), ph, "、".join(unresolved[:10])))
    if len(rows) != written + skipped:
        print("[migrate] ❌ 對帳不符")
        return 1
    if args.dry_run:
        print("[migrate] ✅ 對帳相符（dry-run，未寫檔）")
        return 0
    for path, body, _new in outputs:
        cm.atomic_write(path, body)
    # 寫入後複核：重新讀檔，確認每一列都真的在情境表裡（對帳只證明「算得對」，這一步證明「寫進去了」）
    missing = []
    for path, _body, new_lines in outputs:
        got = set(r.strip() for r in cm.scenario_rows(cm.read_text(path) or "", cfg))
        missing += ["%s：%s" % (os.path.relpath(path, root), ln) for ln in new_lines if ln.strip() not in got]
    if missing:
        print("[migrate] ❌ 寫入後複核不符：%d 列沒有出現在 COVERAGE 情境表（舊檔保留未改名，請檢查後重跑）：" % len(missing))
        for m in missing[:20]:
            print("    %s" % m)
        return 1
    dst = os.path.join(root, "catalog.pre-migrate-%s.md" % date.today().isoformat())
    n = 1
    while os.path.exists(dst):
        n += 1
        dst = os.path.join(root, "catalog.pre-migrate-%s-%d.md" % (date.today().isoformat(), n))
    os.replace(legacy, dst)
    print("[migrate] 舊檔已改名保留：%s" % dst)
    print("[migrate] ✅ 對帳相符，寫入後複核 %d 列皆在情境表中" % written)
    return 0


if __name__ == "__main__":
    sys.exit(main())
