"""qa-flow.sh 其餘子命令：legacy 單一 catalog 相容、migrate、tools-sync、大小寫不敏感防誤刪、help/錯誤碼。

涵蓋每個子命令的實跑，以及 APFS／NTFS 大小寫不敏感的情況。
"""
import os
import re

import pytest

from conftest import QAFLOW, needs_bash

LEGACY = """# 情境覆蓋索引（catalog）

> 由 qa-flow.sh catalog 回填，邊 codify 邊登記。

| 白話業務情境 | 對應測試函式 | 覆蓋狀態 | 業務模組分類 |
|------|------|------|------|
| 管理員建立訂單 | test_create | ✅完整 | orders |
| 管理員取消訂單 | test_cancel | ⚠️部分 | orders |
| 根目錄冒煙 | test_smoke | ✅完整 | 冒煙 |
| 報表匯出（尚未寫測試） | — | ❌未覆蓋 | orders |
| 已刪掉的舊測試 | test_gone | ✅完整 | orders |
"""


def _legacy_project(project, catalog_name="catalog.md"):
    project.e2e.mkdir(parents=True)
    project.write("orders/test_orders.py", "def test_create():\n    assert True\n\ndef test_cancel():\n    assert True\n")
    project.write("test_smoke.py", "def test_smoke():\n    assert True\n")
    project.write(catalog_name, LEGACY)
    return project


def _is_case_insensitive(path):
    probe = os.path.join(str(path), "CaseProbe.tmp")
    open(probe, "w").close()
    try:
        return os.path.exists(os.path.join(str(path), "caseprobe.TMP"))
    finally:
        os.remove(probe)


@needs_bash
def test_help_and_unknown(project):
    r = project.flow("--help")
    assert r.returncode == 0
    for cmd in ("bootstrap", "scaffold", "run", "catalog", "audit", "tools-sync", "migrate"):
        assert cmd in r.stdout
    assert project.flow("nope").returncode == 1
    assert project.flow("scaffold", "../x", "pytest").returncode == 1
    assert project.flow("scaffold", "x", "cypress").returncode == 1


@needs_bash
def test_legacy_catalog_compat(project):
    _legacy_project(project)
    r = project.flow("bootstrap")
    assert r.returncode == 0, r.stderr
    assert "MODE: legacy-catalog" in r.stdout and "qa-flow.sh migrate" in r.stdout
    # legacy audit：test_gone 是孤兒 → exit 3；--fix 標成 ❌
    r = project.flow("audit")
    assert r.returncode == 3 and "test_gone" in r.stderr
    r = project.flow("audit", "--fix")
    assert r.returncode == 0
    assert "| 已刪掉的舊測試 | test_gone | ❌未覆蓋 |" in project.read("catalog.md")
    # legacy catalog 回填（update + append）
    r = project.flow("catalog", "管理員取消訂單（含退款）", "test_cancel", "完整", "orders")
    assert r.returncode == 0, r.stderr
    txt = project.read("catalog.md")
    assert "| 管理員取消訂單（含退款） | test_cancel | ✅完整 | orders |" in txt
    assert txt.count("test_cancel") == 1
    assert project.flow("catalog", "新情境", "test_x", "完整", "a|b").returncode == 1
    # legacy scaffold 不改成三層、不裝工具
    r = project.flow("scaffold", "orders", "pytest")
    assert r.returncode == 0 and "MODE: legacy-catalog" in r.stdout
    assert not (project.e2e / "qa-webwright.json").exists()
    # 寫入沒有殘留暫存檔
    assert not [n for n in os.listdir(str(project.e2e)) if n.startswith(".catalog.")]


@needs_bash
def test_foreign_catalog_is_skipped(project):
    project.e2e.mkdir(parents=True)
    project.write("orders/test_o.py", "def test_o():\n    pass\n")
    foreign = "# 專案自有索引\n\n| 模組 | 說明 |\n|---|---|\n| orders | 訂單 |\n"
    project.write("CATALOG.md", foreign)
    r = project.flow("audit", "--fix")
    assert r.returncode == 0 and "跳過" in r.stdout
    assert project.read("CATALOG.md") == foreign
    # 專案自有三層（有 COVERAGE、沒有參數檔、沒有本 plugin 工具）→ 跳過、不代跑
    project.write("orders/COVERAGE.md", "| 使用情境（白話） | 測試函式 | 覆蓋 |\n|---|---|---|\n")
    project.write("tools/drift_check.py", "raise SystemExit('專案自有工具不該被代跑')\n")
    r = project.flow("audit")
    assert r.returncode == 0 and "不是本 plugin 版本" in r.stdout
    r = project.flow("bootstrap")
    assert "MODE: three-layer-no-config" in r.stdout


@needs_bash
def test_migrate_legacy_to_three_layer(project):
    _legacy_project(project)
    r = project.flow("migrate", "--dry-run")
    assert r.returncode == 0, r.stdout + r.stderr
    assert "舊資料列 5 ＝ 新寫入 5 ＋ 已存在略過 0" in r.stdout
    assert (project.e2e / "catalog.md").exists() and not (project.e2e / "orders" / "COVERAGE.md").exists()

    r = project.flow("migrate")
    assert r.returncode == 0, r.stdout + r.stderr
    assert "舊資料列 5 ＝ 新寫入 5 ＋ 已存在略過 0" in r.stdout
    assert "對帳相符" in r.stdout
    cov = project.read("orders/COVERAGE.md")
    assert "`test_orders.py::test_create`" in cov and "`test_orders.py::test_cancel`" in cov
    assert "| 報表匯出（尚未寫測試） | — | ❌ |" in cov
    root_cov = project.read("COVERAGE.md")
    assert "`test_smoke.py::test_smoke`" in root_cov and "〔模組：冒煙〕" in root_cov
    assert "test_gone" in root_cov  # 找不到的函式原樣保留、提示人工確認
    backups = [n for n in os.listdir(str(project.e2e)) if n.startswith("catalog.pre-migrate-")]
    assert len(backups) == 1
    assert project.read(backups[0]) == LEGACY  # 舊檔改名保留、內容不變
    cat = project.read("CATALOG.md")
    assert "tools/gen_catalog.py` 生成" in cat
    r = project.flow("bootstrap")
    assert "MODE: three-layer" in r.stdout
    assert project.flow("migrate").returncode == 2  # 已非 legacy


@needs_bash
def test_migrate_refuses_foreign(project):
    project.e2e.mkdir(parents=True)
    project.write("catalog.md", "| a | b |\n|---|---|\n| 1 | 2 |\n")
    r = project.flow("migrate")
    assert r.returncode == 2


@needs_bash
def test_case_insensitive_catalog_never_deleted(project):
    """大小寫不敏感檔案系統（Windows NTFS、macOS APFS 預設）上，catalog.md 與 CATALOG.md 是同一個檔。

    舊版曾因對小寫檔名 rm 而刪掉 CATALOG.md 正本。這裡在實際檔案系統上走一遍 catalog／audit --fix／migrate，
    確認正本內容一直都在（大小寫敏感的系統上同樣驗「只有一份、內容正確」）。
    """
    _legacy_project(project, catalog_name="CATALOG.md")
    ci = _is_case_insensitive(project.e2e)
    r = project.flow("catalog", "新增一列", "test_create", "部分", "orders")
    assert r.returncode == 0, r.stderr
    names = [n for n in os.listdir(str(project.e2e)) if n.lower() == "catalog.md"]
    assert names == ["CATALOG.md"], names  # 沒有另建小寫檔、正本沒被刪
    assert "| 新增一列 | test_create | ⚠️部分 | orders |" in project.read("CATALOG.md")
    assert project.flow("audit", "--fix").returncode == 0
    names = [n for n in os.listdir(str(project.e2e)) if n.lower() == "catalog.md"]
    assert names == ["CATALOG.md"], names
    txt = project.read("CATALOG.md")
    assert "報表匯出" in txt and "| 已刪掉的舊測試 | test_gone | ❌未覆蓋 |" in txt
    r = project.flow("migrate")
    assert r.returncode == 0, r.stdout + r.stderr
    cat_names = [n for n in os.listdir(str(project.e2e)) if n.lower() == "catalog.md"]
    assert len(cat_names) == 1  # 生成的 CATALOG 與舊檔不會同時存在兩份
    assert "tools/gen_catalog.py` 生成" in project.read(cat_names[0])
    backups = [n for n in os.listdir(str(project.e2e)) if n.startswith("catalog.pre-migrate-")]
    assert backups and "新增一列" in project.read(backups[0])
    print("case-insensitive filesystem:", ci)


def test_qaflow_has_no_rm_on_catalog():
    """寫入邏輯不得出現對 catalog 檔名的 rm（tmp＋原子 rename 取代）。"""
    src = QAFLOW.read_text(encoding="utf-8")
    code = "\n".join(ln for ln in src.splitlines() if not ln.lstrip().startswith("#"))
    assert not re.search(r"\brm\b[^\n]*(catalog|CATALOG)", code)
    assert not re.search(r"\brm\s+-[a-z]*f", code)


@needs_bash
def test_tools_sync(project):
    r = project.flow("scaffold", "orders", "pytest")
    assert r.returncode == 0, r.stderr
    cfg_before = project.read("qa-webwright.json") + "\n"
    project.write("qa-webwright.json", cfg_before)  # 使用者改過參數檔
    # 1) 未改過 → 已是最新
    r = project.flow("tools-sync")
    assert r.returncode == 0 and "已是最新" in r.stdout, r.stdout + r.stderr
    # 2) 模擬舊版：把標記版本改舊、內容改舊但雜湊一致 → 會更新
    p = project.e2e / "tools" / "runs_db.py"
    data = p.read_bytes()
    first, rest = data.split(b"\n", 1)
    import hashlib
    old_body = rest + b"\n# old\n"
    header = re.sub(rb"v\d+\.\d+\.\d+", b"v0.0.1", first)
    header = re.sub(rb"sha256=[0-9a-f]{64}", b"sha256=" + hashlib.sha256(old_body).hexdigest().encode(), header)
    p.write_bytes(header + b"\n" + old_body)
    r = project.flow("tools-sync")
    assert r.returncode == 0 and "更新 runs_db.py" in r.stdout, r.stdout
    assert p.read_bytes() == data
    # 3) 本地修改 → 警告不覆蓋、exit 3
    p.write_bytes(data + b"# local tweak\n")
    r = project.flow("tools-sync")
    assert r.returncode == 3 and "本地修改" in r.stdout, r.stdout + r.stderr
    assert p.read_bytes().endswith(b"# local tweak\n")
    # 4) 撞名的專案自有檔（沒標記）→ 不碰
    q = project.e2e / "tools" / "sweep_residue.py"
    q.write_text("# 專案自己的清掃器\n", encoding="utf-8")
    r = project.flow("tools-sync")
    assert "沒有 qa-webwright 版本標記" in r.stdout
    assert q.read_text(encoding="utf-8") == "# 專案自己的清掃器\n"
    # 5) --force → 覆蓋有標記的本地修改並備份；撞名的仍不碰
    r = project.flow("tools-sync", "--force")
    assert p.read_bytes() == data
    assert [n for n in os.listdir(str(project.e2e / "tools")) if n.startswith("runs_db.py.bak-")]
    assert q.read_text(encoding="utf-8") == "# 專案自己的清掃器\n"
    # 參數檔從頭到尾沒被覆寫
    assert project.read("qa-webwright.json") == cfg_before


@needs_bash
def test_scaffold_existing_conftest_not_rewritten(project):
    project.e2e.mkdir(parents=True)
    project.write("conftest.py", "# 使用者自己的 conftest\n")
    r = project.flow("scaffold", "orders", "pytest")
    assert r.returncode == 0
    assert "ACTION-REQUIRED" in r.stdout
    assert project.read("conftest.py") == "# 使用者自己的 conftest\n"


@needs_bash
def test_scaffold_playwright_js(project):
    r = project.flow("scaffold", "orders", "playwright-js")
    assert r.returncode == 0
    assert (project.e2e / "catalog.md").exists()
    assert not (project.e2e / "qa-webwright.json").exists()


@needs_bash
def test_catalog_does_not_run_project_own_gen_catalog(project):
    """專案自有同名 gen_catalog.py（無版本標記）→ catalog 只寫 COVERAGE，不代跑生成器、CATALOG 不動。"""
    r = project.flow("scaffold", "orders", "pytest")
    assert r.returncode == 0, r.stderr
    project.write("tools/gen_catalog.py",
                  "# 專案自有生成器\nopen('CATALOG.md', 'w').write('overwritten by project tool\\n')\n")
    project.write("CATALOG.md", "# 專案自有格式 CATALOG\n")
    r = project.flow("catalog", "管理員建立訂單", "test_orders.py::test_create", "完整", "orders")
    assert r.returncode == 0, r.stdout + r.stderr
    assert "不代跑" in r.stderr
    assert project.read("CATALOG.md") == "# 專案自有格式 CATALOG\n"
    assert "test_orders.py::test_create" in project.read("orders/COVERAGE.md")


@needs_bash
def test_catalog_requires_scaffold_in_none_mode(project):
    project.e2e.mkdir(parents=True)
    r = project.flow("catalog", "x", "test_x", "完整", "orders")
    assert r.returncode == 1 and "scaffold" in r.stderr


@needs_bash
def test_run_guards(project):
    project.flow("scaffold", "orders", "pytest")
    assert project.flow("run", "orders", "/abs/test_x.py").returncode == 1
    assert project.flow("run", "orders", "../x.py").returncode == 1
    project.write("orders/test_empty.py", "# 沒有任何測試函式\n")
    r = project.flow("run", "orders", "orders/test_empty.py")
    assert r.returncode == 1 and "找不到任何 test_" in r.stderr
    project.write("orders/test_ok.py", "def test_ok():\n    assert True\n")
    project.write("orders/COVERAGE.md", project.read("orders/COVERAGE.md"))
    r = project.flow("run", "orders", "tests/e2e/orders/test_ok.py")
    assert r.returncode == 0, r.stdout + r.stderr


@pytest.mark.parametrize("sub", ["bootstrap", "scaffold", "run", "catalog", "audit", "tools-sync", "migrate"])
def test_every_subcommand_documented(sub):
    src = QAFLOW.read_text(encoding="utf-8")
    assert "  %s)" % sub in src or "  %s) " % sub in src
