"""生成 CATALOG.md 薄索引：讀各資料夾 COVERAGE.md ＋ .runs/results.sqlite。

CATALOG 不是知識載體（知識在各 COVERAGE.md），只是一張「哪裡有什麼、上次何時跑過、
綠不綠、文件與程式碼差多少」的索引，因此可被完全重生，也因此不准手改。

自檢（生成器算錯比不生成更糟）：
  - 資料夾數或函式數實計為 0 → 拒絕生成（磁碟掃描異常或尚無測試）
  - 函式數用兩條不同判準各算一次（行首 regex vs AST），不一致 → 拒絕生成

「🔒 鎖定 bug」節由各 COVERAGE.md 的鎖定節匯集（不寫死在生成器裡）。

用法：python tools/gen_catalog.py            （exit 0＝已生成；1＝自檢拒絕；2＝既有 CATALOG 不是本工具生成的，拒絕覆寫）

既有同名檔沒有生成標記（專案自有的索引）→ 一律不覆寫，提示改 catalog.file 或自行改名保留。
AST 解析失敗（第二條判準算不出來）→ 拒絕生成並列出壞檔，不宣稱已自檢。
"""
import os
import sys

try:
    from . import coverage_md as cm
    from . import drift_check
    from . import qa_config
    from . import runs_db
except ImportError:
    import coverage_md as cm
    import drift_check
    import qa_config
    import runs_db

GEN_MARK = "本檔由 `tools/gen_catalog.py` 生成"


def header(cfg):
    cov = cfg["coverage"]["file"]
    return "\n".join([
        "# tests/e2e 索引（生成檔）",
        "",
        "> ⚠️ **%s，手動修改會在下次生成時被覆蓋。**" % GEN_MARK,
        "> 情境知識請改各資料夾的 `%s`（正本）；執行紀錄由 pytest hook 寫入" % cov,
        "> `.runs/results.sqlite`，不需人工維護。",
        ">",
        "> 三層架構：",
        "> 1. `<folder>/%s` — 情境知識正本（人寫）" % cov,
        "> 2. `.runs/results.sqlite` — 執行事實（機器寫）",
        "> 3. 本檔 — 薄索引（腳本生成）",
        ">",
        "> 重生：`python tools/gen_catalog.py`　漂移檢查：`python tools/drift_check.py all`",
        "> 批次名：跑 pytest 時帶 `QA_BATCH=<批次名>`（未帶記為 `adhoc`；相容舊名 `E2E_BATCH`）。",
        "> 「最後執行」為 UTC 日期。",
    ])


def cell_text(v):
    """放進 Markdown 表格一格的文字：| 轉義、換行換成空白（說明與批次名都可能含這些字元）。"""
    return str(v or "").replace("\r", " ").replace("\n", " ").replace("|", "\\|")


def output_path(cfg):
    wanted = cfg["catalog"]["file"]
    return os.path.join(cfg.root, cm.existing_case_name(cfg.root, wanted))


def unparsable_files(folders, root):
    import ast
    out = []
    for f in folders:
        for name in cm.test_files(f, root):
            path = os.path.join(cm.folder_dir(f, root), name)
            try:
                with open(path, encoding="utf-8-sig", errors="replace") as fh:
                    ast.parse(fh.read())
            except SyntaxError as exc:
                out.append("%s（第 %s 行）" % (os.path.relpath(path, root).replace("\\", "/"), exc.lineno))
    return out


def foreign_catalog(path):
    """既有檔不是本工具生成的（沒有生成標記）→ 回 True：專案自有的 CATALOG 不得被覆寫。"""
    if not os.path.exists(path):
        return False
    try:
        with open(path, encoding="utf-8-sig", errors="replace") as fh:
            return GEN_MARK not in fh.read()
    except OSError:
        return True


def build(cfg):
    root = cfg.root
    folders = cm.audit_folders(root, cfg)
    runs = runs_db.last_run_by_folder(runs_db.db_path(root))

    func_count = sum(len(cm.actual_functions(f, root)) for f in folders)
    ast_counts = [cm.ast_function_count(f, root) for f in folders]
    file_count = sum(len(cm.test_files(f, root)) for f in folders)
    if not folders or func_count == 0:
        return None, "ERROR: 實計為 0（資料夾 %d／函式 %d），拒絕生成" % (len(folders), func_count)
    if None in ast_counts:
        # 第二條判準算不出來＝自檢沒做成：不得照樣生成還宣稱已自檢
        bad = unparsable_files(folders, root)
        return None, ("ERROR: 有測試檔 AST 解析失敗，函式數無法用第二條判準交叉驗證，拒絕生成——"
                      "先修好語法錯誤：%s" % "、".join(bad or ["（不明）"]))
    if sum(ast_counts) != func_count:
        return None, ("ERROR: 函式數兩判準不一致（行首 def=%d，AST=%d），拒絕生成——"
                      "檢查是否有縮排的 test 函式或重複定義" % (func_count, sum(ast_counts)))

    lines = [header(cfg), ""]
    lines.append("統計：**%d 個含 test 檔的資料夾 / %d 個 test 檔 / %d 個 test 函式定義**"
                 "（parametrize 展開後的實跑數以 `pytest --collect-only -q` 為準）。"
                 % (len(folders), file_count, func_count))
    lines += ["", "---", "", "## 資料夾索引", ""]
    lines.append("| 資料夾 | 說明 | 情境數 | 函式數 | ✅ | ⚠️ | ❌ | 最後執行 | 批次 | 通過 | 失敗 | 其他 | 漂移 |")
    lines.append("|---|---|--:|--:|--:|--:|--:|---|---|--:|--:|--:|--:|")
    tot = {"scen": 0, "ok": 0, "partial": 0, "missing": 0, "drift": 0,
           "passed": 0, "failed": 0, "other": 0}
    for folder in folders:
        scen, ok, partial, missing = cm.count_scenarios(folder, cfg, root)
        funcs = len(cm.actual_functions(folder, root))
        d = drift_check.check(folder, cfg, root)
        drift = len(d["orphans"]) + len(d["ghosts"]) + len(d["placeholders"])
        r = runs.get(folder, {})
        title = cell_text(cm.folder_title(folder, cfg, root))
        if len(title) > 40:
            title = title[:39] + "…"
        lines.append("| `%s` | %s | %d | %d | %d | %d | %d | %s | %s | %s | %s | %s | %s |" % (
            cm.display_name(folder), title, scen, funcs, ok, partial, missing,
            r.get("date") or "—", cell_text(r.get("batch") or "") or "—",
            r.get("passed", "—") if r else "—", r.get("failed", "—") if r else "—",
            r.get("other", "—") if r else "—", drift or "—"))
        tot["scen"] += scen
        tot["ok"] += ok
        tot["partial"] += partial
        tot["missing"] += missing
        tot["drift"] += drift
        for k in ("passed", "failed", "other"):
            tot[k] += r.get(k, 0) if r else 0

    lines += ["", "### 全域統計", ""]
    lines.append("- 情境列共 **%d** 條（✅ %d / ⚠️ %d / ❌ %d）"
                 % (tot["scen"], tot["ok"], tot["partial"], tot["missing"]))
    lines.append("- 測試函式共 **%d** 個，分佈於 %d 個資料夾 / %d 個檔案"
                 % (func_count, len(folders), file_count))
    lines.append("- 各資料夾最後一次執行合計：通過 **%d** / 失敗 **%d** / 其他（skip、xfail…）**%d**"
                 % (tot["passed"], tot["failed"], tot["other"]))
    lines.append("- 漂移（孤兒＋幽靈＋佔位）共 **%d** 處 —— 跑 `python tools/drift_check.py all` 看明細"
                 % tot["drift"])
    if not runs:
        lines.append("- ⚠️ `.runs/results.sqlite` 尚無執行紀錄（conftest 片段已接上的話，下次實跑 pytest 後自動填入）")

    xf_kw = cfg["coverage"]["xfail_section"]
    lines += ["", "---", "", "## 已知 %s / skip 一覽（自各 %s 匯集）" % (xf_kw, cfg["coverage"]["file"]), ""]
    lines += ["| 資料夾 | 測試函式 | 標記 | 原因 |", "|---|---|---|---|"]
    n_xf = 0
    for folder in folders:
        text = cm.read_text(cm.coverage_path(folder, cfg, root)) or ""
        for row in cm.section_rows(text, xf_kw):
            lines.append("| `%s` %s" % (cm.display_name(folder), row))
            n_xf += 1
    if n_xf == 0:
        lines.append("| （無） | | | |")

    lk_kw = cfg["coverage"]["locked_section"]
    lines += ["", "---", "", "## %s bug（自各 %s 的「%s」節匯集）" % (lk_kw, cfg["coverage"]["file"], lk_kw), ""]
    lines.append("> xfail 鎖定的已知缺陷：修好後 XPASS 要轉正（移除 xfail）；刻意保留的紅燈勿「修綠」。")
    lines += ["", "| 資料夾 | 情境 | 位置 | 狀態 |", "|---|---|---|---|"]
    n_lk = 0
    for folder in folders:
        text = cm.read_text(cm.coverage_path(folder, cfg, root)) or ""
        for row in cm.section_rows(text, lk_kw):
            lines.append("| `%s` %s" % (cm.display_name(folder), row))
            n_lk += 1
    if n_lk == 0:
        lines.append("| （無） | | | |")
    lines.append("")
    stats = {"folders": len(folders), "files": file_count, "functions": func_count,
             "xfail_rows": n_xf, "locked_rows": n_lk}
    stats.update(tot)
    return "\n".join(lines), stats


def main(argv=None):
    qa_config.force_utf8_stdio()
    cfg = qa_config.load_or_exit()
    text, stats = build(cfg)
    if text is None:
        print(stats)
        return 1
    out = output_path(cfg)
    if foreign_catalog(out):
        print("[gen_catalog] 拒絕覆寫：%s 已存在且不是本工具生成的（缺「%s」標記）——看起來是專案自有的索引。"
              % (out, GEN_MARK))
        print("             三層登記的正本在各資料夾 COVERAGE.md，已照常寫入；生成索引請擇一：")
        print("             (a) 在 qa-webwright.json 設 catalog.file 為別的檔名（例：\"QA-CATALOG.md\"），或")
        print("             (b) 確認該檔可以被取代後，自行改名保留再重跑。本工具不會刪改它。")
        return 2
    cm.atomic_write(out, text)
    print("%s generated: %d folders / %d files / %d functions / %d scenario rows"
          % (os.path.basename(out), stats["folders"], stats["files"], stats["functions"], stats["scen"]))
    print("last-run totals: passed=%d failed=%d other=%d   drift=%d   xfail rows=%d   locked rows=%d"
          % (stats["passed"], stats["failed"], stats["other"], stats["drift"],
             stats["xfail_rows"], stats["locked_rows"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
