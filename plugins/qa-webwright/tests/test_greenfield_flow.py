"""greenfield 端到端：bootstrap → scaffold → pytest（sqlite）→ gen_catalog → drift_check → 修正 → 0/0/0。

涵蓋 SQLite 執行事實、三層登記＋CATALOG、drift、qa-flow.sh 子命令。
"""
import re

from conftest import needs_bash

TESTS = '''import pytest


def test_create_order():
    assert 1 + 1 == 2


def test_cancel_order():
    assert True


@pytest.mark.xfail(reason="已知缺陷：取消後金額未歸零", strict=True)
def test_cancel_refund_locked():
    assert 0 == 1


def test_orphan_not_registered():
    assert True


def test_placeholder_row():
    assert True
'''


@needs_bash
def test_greenfield_end_to_end(project):
    # ---- bootstrap：空目錄 → ASSET none、MODE none，不擅自建任何登記檔 ----
    r = project.flow("bootstrap")
    assert r.returncode == 0, r.stdout + r.stderr
    assert "ASSET: none" in r.stdout
    assert "MODE: none" in r.stdout
    assert not (project.e2e / "catalog.md").exists()

    # ---- scaffold：三層骨架 ----
    r = project.flow("scaffold", "orders", "pytest")
    assert r.returncode == 0, r.stdout + r.stderr
    for rel in ("qa-webwright.json", "conftest.py", "orders/COVERAGE.md", "tools/drift_check.py",
                "tools/gen_catalog.py", "tools/qa_pytest_plugin.py"):
        assert (project.e2e / rel).exists(), rel
    first = project.read("tools/drift_check.py").splitlines()[0]
    assert re.match(r"# qa-webwright-tool: v\d+\.\d+\.\d+ sha256=[0-9a-f]{64}", first), first
    assert "qa-webwright 掛點" in project.read("conftest.py")
    r = project.flow("bootstrap")
    assert "MODE: three-layer" in r.stdout

    # ---- 寫測試 + COVERAGE（故意：孤兒 1、幽靈 1、佔位 1）----
    project.write("orders/test_orders.py", TESTS)
    project.coverage("orders", [
        "| 使用者建立訂單後在列表看得到 | `test_orders.py::test_create_order` | ✅ |",
        "| 使用者取消訂單，狀態變已取消 | `test_orders.py::test_cancel_order`、`::test_cancel_refund_locked` | ⚠️ |",
        "| 待補 | `test_orders.py::test_placeholder_row` | ⚠️ |",
        "| 已刪除的舊測試 | `test_orders.py::test_ghost_removed` | ✅ |",
        "| 說明文字提到「待補貨」狀態不算佔位 | `test_orders.py::test_create_order` | ✅ |",
    ], locked=["| 取消後退款金額未歸零 | `test_orders.py::test_cancel_refund_locked` | xfail 鎖定，修好轉正 |"],
        xfail=["| `test_orders.py::test_cancel_refund_locked` | xfail(strict) | 取消後金額未歸零 |"])

    # ---- 假專案 pytest：5 支測試 → sqlite 5 列（批次名 QA_BATCH）----
    r = project.pytest(env={"QA_BATCH": "nightly-1"})
    assert r.returncode == 0, r.stdout + r.stderr
    rows = project.sqlite_rows()
    assert len(rows) == 5, rows
    assert {b for b, _n, _f, _o in rows} == {"nightly-1"}
    assert {f for _b, _n, f, _o in rows} == {"orders"}
    outcomes = sorted(o for _b, _n, _f, o in rows)
    assert outcomes == ["passed", "passed", "passed", "passed", "xfailed"], outcomes
    assert "COVERAGE DRIFT" in r.stdout  # 總結區印 drift 狀態

    # ---- 相容舊批次變數名 E2E_BATCH ----
    r = project.pytest("orders/test_orders.py::test_create_order", env={"E2E_BATCH": "legacy-batch"})
    assert r.returncode == 0
    assert project.sqlite_rows()[-1][0] == "legacy-batch"

    # ---- drift_check：孤兒/幽靈/佔位各 1，exit 1 ----
    r = project.tool("drift_check.py", "all")
    assert r.returncode == 1, r.stdout
    assert "orphans=1  ghosts=1  placeholders=1" in r.stdout, r.stdout
    assert "test_orphan_not_registered" in r.stdout and "test_ghost_removed" in r.stdout
    assert r.stdout.count("placeholder (registered") == 1  # 「待補貨」正文不算佔位

    # ---- gen_catalog：最後執行日期＋統計與 sqlite 一致；鎖定節由 COVERAGE 匯集 ----
    r = project.tool("gen_catalog.py")
    assert r.returncode == 0, r.stdout
    cat = project.read("CATALOG.md")
    last = [row for row in project.sqlite_rows() if row[2] == "orders"]
    # 最後一次 run 只跑了 1 支（legacy-batch）
    line = [ln for ln in cat.splitlines() if ln.startswith("| `orders/`")][0]
    cells = [c.strip() for c in line.strip("|").split("|")]
    assert re.match(r"\d{4}-\d{2}-\d{2}", cells[7]), cells
    assert cells[8] == "legacy-batch"
    assert (cells[9], cells[10], cells[11]) == ("1", "0", "0"), cells
    assert cells[2] == "5" and cells[3] == "5"  # 情境列 5、函式 5
    assert cells[4] == "3" and cells[5] == "2"  # ✅ 3、⚠️ 2
    assert cells[12] == "3"  # 漂移 3
    assert "取消後退款金額未歸零" in cat  # 🔒 鎖定節來自 COVERAGE，不是寫死在生成器
    assert "xfail(strict)" in cat
    assert len(last) == 6

    # ---- 修正漂移 → 0/0/0 ----
    project.coverage("orders", [
        "| 使用者建立訂單後在列表看得到 | `test_orders.py::test_create_order` | ✅ |",
        "| 使用者取消訂單，狀態變已取消 | `test_orders.py::test_cancel_order`、`::test_cancel_refund_locked` | ⚠️ |",
        "| 送出空白訂單被擋下並提示必填 | `test_orders.py::test_placeholder_row` | ✅ |",
        "| 未登記測試補登：訂單列表分頁 | `test_orders.py::test_orphan_not_registered` | ✅ |",
    ])
    r = project.tool("drift_check.py", "all")
    assert r.returncode == 0, r.stdout
    assert "orphans=0  ghosts=0  placeholders=0" in r.stdout
    r = project.pytest(env={"QA_BATCH": "nightly-2"})
    assert r.returncode == 0
    assert "COVERAGE drift clean" in r.stdout
    assert len(project.sqlite_rows()) == 5 + 1 + 5

    # ---- qa-flow.sh audit（三層 → drift_check）/ catalog / run ----
    r = project.flow("audit")
    assert r.returncode == 0 and "drift 0/0/0" in r.stdout, r.stdout + r.stderr
    project.write("orders/test_more.py", "def test_new_unregistered():\n    assert True\n")
    r = project.flow("audit")
    assert r.returncode == 3, r.stdout
    r = project.flow("catalog", "新增訂單備註", "test_new_unregistered", "完整", "orders")
    assert r.returncode == 0, r.stdout + r.stderr
    assert "`test_more.py::test_new_unregistered`" in project.read("orders/COVERAGE.md")
    r = project.flow("catalog", "新增訂單備註（改寫）", "test_more.py::test_new_unregistered", "部分", "orders")
    assert r.returncode == 0
    cov = project.read("orders/COVERAGE.md")
    assert cov.count("test_new_unregistered") == 1 and "新增訂單備註（改寫）" in cov
    r = project.flow("catalog", "不存在的函式", "test_nope", "完整", "orders")
    assert r.returncode != 0
    r = project.flow("audit")
    assert r.returncode == 0
    r = project.flow("run", "orders", "orders/test_orders.py", env={"QA_BATCH": "via-run"})
    assert r.returncode == 0, r.stdout + r.stderr
    assert (project.e2e / "reports").exists()
    assert any(p.suffix == ".xml" for p in (project.e2e / "reports").iterdir())
    assert project.sqlite_rows()[-1][0] == "via-run"
    assert "| via-run |" in project.read("CATALOG.md")  # run 後 CATALOG 重生


def test_gen_catalog_refuses_zero(installed):
    r = installed.tool("gen_catalog.py")
    assert r.returncode == 1
    assert "拒絕生成" in r.stdout
    assert not (installed.e2e / "CATALOG.md").exists()


def test_gen_catalog_refuses_counter_mismatch(installed):
    # 行首 def 與 AST 兩判準不一致（class 內方法不算，縮排 def 也不算，但 AST 同樣不算）→ 構造一個真的不一致：
    # 同名函式定義兩次，行首 regex 去重後 1 個、AST 集合也 1 個 → 一致；改用語法錯誤讓 AST 失敗則不比對。
    installed.write("orders/test_a.py", "def test_a():\n    pass\n")
    installed.coverage("orders", ["| 情境 | `test_a.py::test_a` | ✅ |"])
    assert installed.tool("gen_catalog.py").returncode == 0
    # 字串裡行首的 async def 不是測試函式：行首判準先去掉字串與註解（審查 L2-07），兩判準一致、照常生成
    installed.write("orders/test_b.py", 'X = """\nasync def test_in_string():\n"""\n\ndef test_b():\n    pass\n')
    r = installed.tool("gen_catalog.py")
    assert r.returncode == 0 and "2 functions" in r.stdout, r.stdout
    # 兩判準真的不一致時仍拒絕生成（以 monkeypatch 讓 AST 判準多算一支）
    import importlib
    import sys as _sys
    from conftest import SKILL
    _sys.path.insert(0, str(SKILL / "tools"))
    try:
        gc = importlib.import_module("gen_catalog")
        qc = importlib.import_module("qa_config")
        cmod = importlib.import_module("coverage_md")
        cfg = qc.load(str(installed.e2e), use_cache=False)
        orig = cmod.ast_function_count
        cmod.ast_function_count = lambda f, root=None: (orig(f, root) or 0) + 1
        try:
            text, msg = gc.build(cfg)
        finally:
            cmod.ast_function_count = orig
        assert text is None and "兩判準不一致" in msg, msg
    finally:
        _sys.path.remove(str(SKILL / "tools"))


def test_root_folder_tests_are_tracked(installed):
    installed.write("test_root.py", "def test_root_level():\n    assert True\n")
    r = installed.tool("drift_check.py", "all")
    assert r.returncode == 1 and "test_root_level" in r.stdout
    installed.write("COVERAGE.md", "# ./ 情境覆蓋\n\n| 使用情境（白話） | 測試函式 | 覆蓋 |\n|---|---|---|\n"
                                   "| 根目錄冒煙 | `test_root.py::test_root_level` | ✅ |\n")
    assert installed.tool("drift_check.py", ".").returncode == 0
    r = installed.pytest()
    assert r.returncode == 0
    assert installed.sqlite_rows()[-1][2] == ""  # 根資料夾 folder = ""


def test_cross_folder_reference_is_not_ghost(installed):
    installed.write("orders/test_o.py", "def test_o():\n    pass\n")
    installed.write("billing/test_b.py", "def test_b():\n    pass\n")
    installed.coverage("orders", ["| 訂單 | `test_o.py::test_o` | ✅ |",
                                  "| 參見帳務 | 交叉指路 `test_b.py::test_b` | ✅ |"])
    installed.coverage("billing", ["| 帳務 | `test_b.py::test_b` | ✅ |"])
    r = installed.tool("drift_check.py", "all")
    assert r.returncode == 0, r.stdout


def test_make_skeleton_and_fill_orphans(installed):
    installed.write("orders/test_o.py", "def test_one():\n    pass\n\ndef test_two():\n    pass\n")
    r = installed.tool("make_skeleton.py", "orders")
    assert r.returncode == 0
    r = installed.tool("drift_check.py", "orders")
    assert "placeholders=2" in r.stdout and "orphans=0" in r.stdout
    assert installed.tool("make_skeleton.py", "orders").returncode == 2  # 不覆寫
    installed.write("orders/test_o.py", "def test_one():\n    pass\n\ndef test_two():\n    pass\n\n"
                                        "def test_three():\n    pass\n")
    r = installed.tool("fill_orphans.py", "--dry-run")
    assert "+1" in r.stdout
    assert "test_three" not in installed.read("orders/COVERAGE.md")
    r = installed.tool("fill_orphans.py")
    assert "test_three" in installed.read("orders/COVERAGE.md")
    r = installed.tool("drift_check.py", "orders")
    assert "orphans=0" in r.stdout and "placeholders=3" in r.stdout
