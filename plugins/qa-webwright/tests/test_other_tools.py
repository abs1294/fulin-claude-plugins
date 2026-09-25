"""其他工具：sweep_residue、run_by_folder、i18n_locator_check。"""
import json
import sqlite3
import sys

from conftest import SKILL


def _seed_db(path):
    con = sqlite3.connect(str(path))
    con.executescript("""
        CREATE TABLE orders (id INTEGER PRIMARY KEY, title TEXT, created_at TEXT);
        CREATE TABLE order_items (id INTEGER PRIMARY KEY, order_id INTEGER, sku TEXT);
        INSERT INTO orders VALUES (1, 'E2E-order-a', '2020-01-01 00:00:00');
        INSERT INTO orders VALUES (2, 'E2E-order-b', '2999-01-01 00:00:00');
        INSERT INTO orders VALUES (3, '真實客戶訂單', '2020-01-01 00:00:00');
        INSERT INTO order_items VALUES (10, 1, 'x'), (11, 2, 'y'), (12, 3, 'z');
    """)
    con.commit()
    con.close()


def _sweep_project(p):
    _seed_db(p.e2e / "demo.sqlite")
    p.config(db={"connector": "sqlite:demo.sqlite"}, residue={"targets": [
        {"table": "orders", "marker_column": "title", "pk_column": "id", "created_column": "created_at",
         "children": [{"table": "order_items", "fk_column": "order_id"}]}]})


def _ids(p, table):
    con = sqlite3.connect(str(p.e2e / "demo.sqlite"))
    try:
        return sorted(r[0] for r in con.execute("SELECT id FROM %s" % table))
    finally:
        con.close()


def test_sweep_dry_run_default(installed):
    _sweep_project(installed)
    r = installed.tool("sweep_residue.py")
    assert r.returncode == 0, r.stdout + r.stderr
    assert "命中 2 筆" in r.stdout and "[DRY-RUN]" in r.stdout
    assert _ids(installed, "orders") == [1, 2, 3]


def test_sweep_apply_children_first_and_prefix_only(installed):
    _sweep_project(installed)
    r = installed.tool("sweep_residue.py", "--apply")
    assert r.returncode == 0, r.stdout + r.stderr
    assert "實刪 2 筆" in r.stdout
    assert _ids(installed, "orders") == [3]            # 沒帶前綴的真資料不動
    assert _ids(installed, "order_items") == [12]      # 子表先刪


def test_sweep_older_than(installed):
    _sweep_project(installed)
    r = installed.tool("sweep_residue.py", "--older-than-days", "7", "--apply")
    assert "命中 1 筆" in r.stdout
    assert _ids(installed, "orders") == [2, 3]


def test_sweep_recheck_mismatch_skips(installed):
    """--apply 前重查：命中集合與剛才不同 → 本表本輪不刪（用可插拔 connector 模擬時間差）。"""
    sys.path.insert(0, str(installed.e2e))
    installed.write("flaky_db.py", '''import sqlite3, os
class Flaky(object):
    def __init__(self):
        self.conn = sqlite3.connect(os.path.join(os.path.dirname(__file__), "demo.sqlite"))
        self.n = 0
    def query(self, sql, params=()):
        self.n += 1
        rows = self.conn.execute(sql, params).fetchall()
        return rows if self.n == 1 else rows[:1]
    def execute(self, sql, params=()):
        self.conn.execute(sql, params); self.conn.commit()
def connect():
    return Flaky()
''')
    _sweep_project(installed)
    installed.config(db={"connector": "flaky_db:connect"})
    r = installed.tool("sweep_residue.py", "--apply")
    assert "[SKIP] 複查命中集合不一致" in r.stdout, r.stdout + r.stderr
    assert _ids(installed, "orders") == [1, 2, 3]


def test_sweep_requires_connector_and_safe_prefix(installed):
    installed.config(residue={"targets": [{"table": "orders", "marker_column": "title", "pk_column": "id"}]})
    r = installed.tool("sweep_residue.py")
    assert r.returncode != 0 and "db.connector 未設定" in r.stdout + r.stderr
    installed.config(test_data_prefix="E")
    r = installed.tool("sweep_residue.py")
    assert r.returncode == 2 and "太短" in r.stdout


def test_run_by_folder_counts_from_junit(installed, tmp_path):
    installed.write("orders/test_o.py", "import pytest\n\ndef test_p():\n    pass\n\ndef test_f():\n    assert 0\n\n"
                                        "@pytest.mark.xfail(reason='known')\ndef test_x():\n    assert 0\n\n"
                                        "@pytest.mark.skipif(True, reason='env')\ndef test_s():\n    pass\n")
    installed.write("billing/test_b.py", "def test_ok():\n    pass\n")
    out = tmp_path / "runs"
    r = installed.tool("run_by_folder.py", "orders", "billing", "--out-dir", str(out))
    lines = [json.loads(ln) for ln in r.stdout.splitlines() if ln.startswith("{")]
    assert len(lines) == 2, r.stdout + r.stderr
    o = lines[0]
    assert (o["passed"], o["failed"], o["xfail"], o["skip"], o["error"]) == (1, 1, 1, 1, 0), o
    assert o["junit_ok"] and o["total"] == 4 and o["rc"] == 1
    assert lines[1]["passed"] == 1 and lines[1]["rc"] == 0
    assert (out / "orders.xml").exists() and (out / "orders.json").exists() and (out / "orders.log").exists()
    assert r.returncode == 1


def test_i18n_locator_vs_assert(installed):
    installed.write("orders/test_o.py", '''def test_x(page):
    page.get_by_role("button", name="送出").click()
    assert page.get_by_text("訂單").count() > 0
    assert page.get_by_text("已送出").inner_text() == "已送出"
    assert page.locator("#msg").get_attribute("data-sel") == "text=已送出"
    page.get_by_role("button", name="Submit").click()
    # page.get_by_text("註解不算")
''')
    r = installed.tool("i18n_locator_check.py", "all", "--list")
    # 第 4 行是用顯示文字定位後再驗內容：元素本身靠中文找到，切語系一樣失效 → 定位器（B14 同判準）
    assert "定位器（切語系會找不到元素）：3 處" in r.stdout, r.stdout
    assert "斷言（驗顯示文字內容）：1 處" in r.stdout


def test_i18n_script_class_configurable(installed):
    installed.write("orders/test_o.py", 'def test_x(page):\n    page.get_by_text("ログイン").click()\n')
    r = installed.tool("i18n_locator_check.py", "all")
    assert "定位器（切語系會找不到元素）：0 處" in r.stdout
    cfg = installed.config()
    cfg["i18n"]["script_class"] = "぀-ヿ一-鿿"
    installed.config(i18n=cfg["i18n"])
    r = installed.tool("i18n_locator_check.py", "all")
    assert "定位器（切語系會找不到元素）：1 處" in r.stdout, r.stdout


def test_i18n_strict_and_disabled(installed):
    installed.write("orders/test_o.py", 'def test_x(page):\n    switch_locale(page, "en-US")\n'
                                        '    page.get_by_text("送出").click()\n')
    r = installed.tool("i18n_locator_check.py", "all", "--strict")
    assert r.returncode == 1
    cfg = installed.config()
    cfg["i18n"]["enabled"] = False
    installed.config(i18n=cfg["i18n"])
    r = installed.tool("i18n_locator_check.py", "all", "--strict")
    assert r.returncode == 0 and "停用" in r.stdout


def test_sweep_module_importable_without_db():
    sys.path.insert(0, str(SKILL / "tools"))
    import sweep_residue  # noqa: F401
