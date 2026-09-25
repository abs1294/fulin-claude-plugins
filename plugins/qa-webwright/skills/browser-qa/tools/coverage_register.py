"""在 `<folder>/COVERAGE.md` 情境表登記（或更新）一列——qa-flow.sh catalog 的三層模式實作。

用法：python tools/coverage_register.py <情境> <測試函式|—> <完整|部分|未覆蓋> <folder|.>

  - 測試函式可寫 `test_x.py::test_y` 或裸 `test_y`（在該資料夾唯一時自動補檔名）
  - 以「測試函式」為主鍵：已登記則更新該列，否則接在情境表末端；函式為 — 時以情境為主鍵
    （同一函式登記在多列＝多個情境：更新情境相同的那列；情境都對不上則拒絕，不覆蓋別的情境）
  - COVERAGE.md 不存在就先建骨架
  - 寫入一律 tmp（同目錄）＋ os.replace：不 rm、不先刪後寫——大小寫不敏感的
    檔案系統（Windows NTFS、macOS APFS 預設）上不會刪到正本

exit 0＝已登記；2＝參數錯誤。
"""
import os
import re
import sys

try:
    from . import coverage_md as cm
    from . import qa_config
except ImportError:
    import coverage_md as cm
    import qa_config

STATES = {"完整": "✅", "✅完整": "✅", "✅": "✅",
          "部分": "⚠️", "⚠️部分": "⚠️", "⚠️": "⚠️",
          "未覆蓋": "❌", "❌未覆蓋": "❌", "❌": "❌"}


def resolve_func(func, folder, root):
    if func in ("—", "-"):
        return "—", None
    m = re.match(r"^(test_[A-Za-z0-9_]+\.py)::(test_[A-Za-z0-9_]+)$", func)
    actual = cm.actual_functions(folder, root)
    if m:
        ref = "`%s::%s`" % m.groups()
        return ref, (None if (m.group(1), m.group(2)) in actual
                     else "⚠️ %s 目前不存在於 %s（登記後會被 drift_check 報為幽靈）"
                     % (func, cm.display_name(folder)))
    if not re.match(r"^test_[A-Za-z0-9_]+$", func):
        return None, "測試函式格式應為 test_x.py::test_y、test_y 或 —：%s" % func
    owners = sorted(f for f, fn in actual if fn == func)
    if len(owners) == 1:
        return "`%s::%s`" % (owners[0], func), None
    if not owners:
        return None, "在 %s 找不到函式 %s；請確認資料夾或寫完整式 test_x.py::%s" % (
            cm.display_name(folder), func, func)
    return None, "函式 %s 在多個檔案出現（%s），請寫完整式" % (func, "、".join(owners))


def _cell_refs(cell):
    """函式欄裡的 (檔名, 函式名)：完整式 `x.py::test_y`（反引號可有可無）、續行式 `::test_z` 與
    裸名續寫 `、test_w`（都沿用前一個檔名）——與 drift_check 認定「已登記」的寫法一致。"""
    out = []
    last_file = None
    for m in re.finditer(r"(test_[A-Za-z0-9_]+\.py)|(?:::)?(test_[A-Za-z0-9_]+)(?!\.py)", cell or ""):
        if m.group(1):
            last_file = m.group(1)
        elif last_file:
            out.append((last_file, m.group(2)))
    return out


def register(scenario, func, state, folder, cfg):
    root = cfg.root
    for v in (scenario, func, folder):
        if "|" in v or "\n" in v or "\r" in v:
            return 2, "欄位值不得含 '|' 或換行（會破壞表格）：%r" % v
    if state not in STATES:
        return 2, "覆蓋狀態需為 完整/部分/未覆蓋（或帶 emoji），得到：%s" % state
    folder, err = cm.safe_folder(folder, root)   # 拒絕 ..／絕對路徑／symlink 逃出 tests/e2e
    if err:
        return 2, err
    d = cm.folder_dir(folder, root)
    if not os.path.isdir(d):
        return 2, "資料夾不存在：%s（先建資料夾並放測試檔，或用 . 表示 tests/e2e 根）" % d
    ref, note = resolve_func(func, folder, root)
    if ref is None:
        return 2, note
    emoji = STATES[state]
    newline = "| %s | %s | %s |" % (scenario, ref, emoji)
    target = None
    if ref != "—":
        refs = _cell_refs(ref)
        if not refs:
            # 檔名含 . 或 - 的測試檔（test_foo.bar.py）寫不進登記格式
            return 2, "%s 的檔名不符登記格式 test_<英數底線>.py，無法登記；請把測試檔改名（. 與 - 換成 _）" % ref
        target = refs[0]

    path = cm.coverage_path(folder, cfg, root)
    if cm.linked_out_file(path):
        return 2, "%s 是連到別處的 symlink，拒絕讀寫（不得把別的專案的 COVERAGE 當成本專案的）" % path
    text = cm.read_text(path)
    if text is None:
        text = cm.skeleton_text(folder, cfg)
    lines = text.splitlines()
    first = cfg["coverage"]["header"][0]
    # 同一份 COVERAGE 可能有多張情境表（依小節分）：既有列要在「所有」情境表裡找，新列才加到第一張表尾
    in_tbl = False       # 目前是否在某張情境表裡
    first_done = False   # 第一張情境表是否已結束
    last = None          # 第一張情境表最後一列
    hits = []            # 登記了這支函式（或這個情境）的列
    width = 3            # 第一張情境表的欄數（專案可在三欄之後自加欄位，例如備註）
    extras = {}          # 列號 → 第四欄起的原內容（更新時保留）
    owners = {}          # 函式名 → 擁有它的檔（裸名登記綁檔用）
    for f_, fn_ in cm.actual_functions(folder, root):
        owners.setdefault(fn_, []).append(f_)
    for i, ln in enumerate(lines):
        s = ln.strip()
        if s.startswith("|"):
            if not in_tbl and cm.cells(s)[0] == first:
                in_tbl = True
                if not first_done:
                    last = i
                    width = max(3, len(cm.cells(s)))
                continue
            if in_tbl:
                if not first_done:
                    last = i
                if cm.is_separator(s):
                    continue
                c = cm.cells(s)
                if ref == "—":
                    key_hit = c[0] == scenario
                else:
                    # 函式欄可能沒有反引號、或一格寫多支（`a.py::test_x`、`::test_y`）：解析後比對
                    refs = _cell_refs(c[1]) if len(c) > 1 else []
                    if not refs and len(c) > 1:
                        # 只寫裸函式名（drift_check 在該函式只屬於一個檔時也算登記）：綁到它唯一的檔
                        refs = [(owners[fn][0], fn) for fn in re.findall(r"(?<![\w.:])(test_[A-Za-z0-9_]+)(?![\w.])", c[1])
                                if len(owners.get(fn, ())) == 1]
                    key_hit = target in refs
                    if key_hit and len(refs) > 1:
                        return 2, ("%s 已登記在同時列了多個函式的列（第 %d 行：%s）——自動更新會連帶改掉其他函式的狀態，"
                                   "請手動拆列或直接改該列" % (func, i + 1, s))
                if key_hit:
                    hits.append((i, c[0]))
                    extras[i] = c[3:]
        elif in_tbl:
            in_tbl = False
            first_done = True
    if last is None:
        return 2, "%s 找不到情境表（表頭第一格應為「%s」）" % (path, first)
    # 同一支函式可以對應多個情境（各一列）：優先更新情境相同的那一列；只有一列就更新它；
    # 多列而情境都對不上＝不知道要改哪一列 → 拒絕（不得覆蓋掉別的情境）
    same = [i for i, sc in hits if sc == scenario]
    hit = None
    if same:
        hit = same[0]
    elif len(hits) == 1:
        hit = hits[0][0]
    elif len(hits) > 1:
        return 2, ("%s 已登記在 %d 列（第 %s 行），情境都不是「%s」——不知道要更新哪一列；"
                   "請用該列原本的情境文字更新，或手動編輯" % (func, len(hits), "、".join(str(i + 1) for i, _s in hits), scenario))
    # 三欄之後的自訂欄：更新時保留原內容，新列補空格（不得讓表格少欄）
    if hit is not None:
        newline = newline + "".join(" %s |" % x for x in extras.get(hit, []))
        lines[hit] = newline
        action = "updated"
    else:
        newline = newline + "  |" * (width - 3)
        lines.insert(last + 1, newline)
        action = "appended"
    cm.atomic_write(path, "\n".join(lines) + "\n")
    msg = "COVERAGE %s：%s\n  %s" % (action, path, newline)
    if note:
        msg += "\n" + note
    return 0, msg


def main(argv=None):
    qa_config.force_utf8_stdio()
    cfg = qa_config.load_or_exit()
    argv = sys.argv[1:] if argv is None else argv
    if len(argv) != 4:
        print("Usage: coverage_register.py <情境> <測試函式|—> <完整|部分|未覆蓋> <folder|.>")
        return 2
    rc, msg = register(argv[0].strip(), argv[1].strip(), argv[2].strip(), argv[3], cfg)
    print(msg if rc == 0 else "ERROR: " + msg)
    return rc


if __name__ == "__main__":
    sys.exit(main())
