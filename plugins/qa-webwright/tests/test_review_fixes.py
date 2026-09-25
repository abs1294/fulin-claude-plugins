"""0.9.0 送審意見的回歸測試（測試名以審查 ID 開頭：test_H9_…、test_B01_…；可用 -k 篩選）。

每條意見先以本檔的測試實跑重現（紅），修正後同一測試轉綠。hook 類意見的案例在 hooks/test-gate-fixes.mjs。
"""
import importlib
import json
import os
import sqlite3
import sys
import types

import pytest

from conftest import SKILL

TOOLS = SKILL / "tools"


def _import_tool(name):
    if str(TOOLS) not in sys.path:
        sys.path.insert(0, str(TOOLS))
    return importlib.import_module(name)


def counts(r):
    import re
    out = {}
    for m in re.finditer(r"^=== ([^\s（]+).*?：(\d+) 處", r.stdout, re.M):
        out[m.group(1)] = int(m.group(2))
    return out


def scan(p, body, rel="orders/test_x.py", *args):
    p.write(rel, body)
    return p.tool("hardcode_check.py", "all", *args)


# =====================================================================
# H9：baseline 檔壞掉不得當成「沒有 baseline」
# =====================================================================

BASELINE_NAMES = {
    "hardcode_check.py": "hardcode-baseline.json",
    "drift_check.py": "drift-baseline.json",
    "skip_audit.py": "skip-baseline.json",
    "i18n_locator_check.py": "i18n-locator-baseline.json",
}


@pytest.mark.parametrize("script", sorted(BASELINE_NAMES))
@pytest.mark.parametrize("broken", ["{ not json", "[1, 2]", '{"fingerprints": "x"}'])
def test_H9_corrupt_baseline_is_error_not_absent(installed, script, broken):
    installed.write("orders/test_o.py", "def test_a():\n    pass\n")
    installed.coverage("orders", ["| 建立訂單 | `test_o.py::test_a` | ✅ |"])
    installed.write("_reports/" + BASELINE_NAMES[script], broken)
    r = installed.tool(script, "orders", "--baseline")
    assert r.returncode == 2, (r.returncode, r.stdout, r.stderr)
    assert "QA-TOOL-RESULT: baseline-error" in r.stdout, r.stdout
    assert "壞" in r.stdout, r.stdout


@pytest.mark.parametrize("script", sorted(BASELINE_NAMES))
def test_H9_write_baseline_refuses_when_old_is_corrupt(installed, script):
    installed.write("orders/test_o.py", "def test_a():\n    pass\n")
    installed.coverage("orders", ["| 建立訂單 | `test_o.py::test_a` | ✅ |"])
    installed.write("_reports/" + BASELINE_NAMES[script], "{ not json")
    r = installed.tool(script, "all", "--write-baseline", "--why", "x")
    assert r.returncode == 2 and "壞" in r.stdout, r.stdout
    # 明說要改判準才可覆寫：--allow-raise 仍可重產（並留理由）
    r = installed.tool(script, "all", "--write-baseline", "--why", "舊檔壞掉重產", "--allow-raise")
    assert r.returncode == 0, r.stdout


# =====================================================================
# B01–B04：qa_pytest_plugin
# =====================================================================

def test_B01_teardown_failure_not_recorded_as_passed(installed):
    installed.write("orders/test_o.py",
                    "import pytest\n\n@pytest.fixture\ndef res():\n    yield 1\n    raise RuntimeError('teardown boom')\n\n"
                    "def test_t(res):\n    assert res\n")
    installed.pytest("orders")
    rows = [(n, o) for _b, n, _f, o in installed.sqlite_rows()]
    assert rows == [("orders/test_o.py::test_t", "error")], rows


def test_B02_fallback_skipif_false_runtime_skip_is_not_collection_time():
    plugin = _import_tool("qa_pytest_plugin")

    class Stash(object):
        def get(self, _key, default=None):
            return default   # 模擬拿不到 skipped_by_mark 旗標（舊版 pytest）

    mark = pytest.mark.skipif(False, reason="只在舊版跳過").mark
    item = types.SimpleNamespace(stash=Stash(), iter_markers=lambda name=None: iter([mark] if name in (None, "skipif") else []))
    report = types.SimpleNamespace(when="setup")
    assert plugin._collection_time_skip(item, report) is False
    mark_t = pytest.mark.skipif(True, reason="平台不支援").mark
    item_t = types.SimpleNamespace(stash=Stash(), iter_markers=lambda name=None: iter([mark_t] if name in (None, "skipif") else []))
    assert plugin._collection_time_skip(item_t, report) is True


def test_B03_xdist_folder_summary_counts_all_workers(installed):
    pytest.importorskip("xdist")
    body = ["def test_p%d():\n    assert True\n" % i for i in range(4)]
    body += ["def test_f%d():\n    assert False\n" % i for i in range(4)]
    installed.write("orders/test_o.py", "\n".join(body))
    installed.pytest("orders", "-n", "2", "-p", "xdist")
    rdb = _import_tool("runs_db")
    last = rdb.last_run_by_folder(str(installed.e2e / ".runs" / "results.sqlite"))
    assert last["orders"]["passed"] == 4 and last["orders"]["failed"] == 4, last


def test_B04_skip_gate_false_does_not_claim_failure(installed):
    installed.config(skip_gate=False)
    installed.write("orders/test_o.py", "import pytest\n\ndef test_a():\n    pytest.skip('no data available')\n")
    r = installed.pytest("orders")
    assert r.returncode == 0, r.stdout
    assert "整輪判為失敗" not in r.stdout, r.stdout
    assert "skip_gate" in r.stdout, r.stdout


# =====================================================================
# B09–B13：hardcode_check
# =====================================================================

def test_B09_earlier_safe_note_does_not_exempt_later_hit(installed):
    body = ("def test_x(db):\n"
            "    # SCAN-REVIEWED: safe — 這一句是清理用的合法寫法\n"
            "    db.execute(\"DELETE FROM orders WHERE id = 1\")\n"
            "    x = 1\n    y = 2\n    z = 3\n    w = 4\n"
            "    db.execute(\"INSERT INTO orders (title) VALUES ('x')\")\n")
    r = scan(installed, body)
    assert counts(r).get("E") == 1 and r.returncode == 1, r.stdout


def test_B09_docstring_note_still_exempts(installed):
    body = ('def seed(db):\n    """造一筆上游推送才有的訂單。\n\n'
            '    # SCAN-REVIEWED: safe — 該狀態只由上游 webhook 產生，產品端沒有入口\n    """\n'
            '    x = 1\n    y = 2\n    z = 3\n    w = 4\n    v = 5\n'
            '    db.execute("INSERT INTO orders (title) VALUES (\'E2E-x\')")\n')
    r = scan(installed, body)
    assert r.returncode == 0 and "E" not in counts(r), r.stdout


def test_B10_module_constant_after_function_does_not_inherit_docstring_note(installed):
    body = ('def helper():\n    """# SCAN-REVIEWED: safe — helper 自己的例外"""\n    return 1\n\n\n'
            "ORDER_ID = 1133\n")
    r = scan(installed, body)
    assert counts(r).get("A") == 1 and r.returncode == 1, r.stdout


def test_B11_lowercase_update_is_detected(installed):
    r = scan(installed, "def test_x(db):\n    db.execute(\"update orders set title = 'x' where id = 1\")\n")
    assert counts(r).get("E") == 1 and r.returncode == 1, r.stdout


def test_B12_intentional_variable_name_exempts_account_literal(installed):
    r = scan(installed, 'INVALID_USERNAME = "REALUSER"\n\ndef test_x():\n    pass\n')
    assert r.returncode == 0 and "F" not in counts(r), r.stdout
    r = scan(installed, 'LOGIN_USERNAME = "REALUSER"\n\ndef test_x():\n    pass\n')
    assert counts(r).get("F") == 1, r.stdout   # 對照：一般命名照擋


def test_B13_review_db_keeps_real_status_and_note(installed):
    body = ("from helpers import identity\n\ndef make_order(api, owner=None):\n"
            "    # G-REVIEWED: real — 後端沒有補 owner，已開單追蹤（2026-09-20）\n"
            "    if owner is None:\n        owner = identity.current_alias()\n"
            "    return api.post('/orders', json={\"owner\": owner})\n")
    scan(installed, body)
    r = installed.tool("hardcode_check.py", "all", "--review-db")
    assert "[review-db]" in r.stdout
    con = sqlite3.connect(str(installed.e2e / ".runs" / "results.sqlite"))
    try:
        rows = con.execute("SELECT status, note FROM hygiene_g_reviews").fetchall()
    finally:
        con.close()
    assert len(rows) == 1 and rows[0][0] == "real" and "已開單追蹤" in (rows[0][1] or ""), rows


# =====================================================================
# A6／A7：hook 輸出與時間預算紀律（靜態：macOS pipe 非同步寫入無法在 Windows 以行為重現）
# =====================================================================

def check_no_exit_after_output(hooks_dir):
    """guard-*.js（PreToolUse／PostToolUse 閘）一律不得呼叫 process.exit：輸出後立刻 exit 在 macOS pipe 會截斷。"""
    import re
    bad = []
    for f in sorted(os.listdir(str(hooks_dir))):
        if f.startswith("guard-") and f.endswith(".js"):
            text = open(os.path.join(str(hooks_dir), f), encoding="utf-8").read()
            for i, line in enumerate(text.splitlines(), 1):
                if re.search(r"process\.exit\(", line):
                    bad.append("%s:%d %s" % (f, i, line.strip()))
    return bad


def check_hygiene_budget(hooks_dir):
    """hygiene hook 的內部總預算必須存在且低於 hooks.json 的 timeout（留 10 秒以上餘裕），子程序 timeout 不得寫死。"""
    import re
    src = open(os.path.join(str(hooks_dir), "guard-test-asset-hygiene.js"), encoding="utf-8").read()
    hooks = json.load(open(os.path.join(str(hooks_dir), "hooks.json"), encoding="utf-8"))
    limit = [h.get("timeout") for e in hooks["hooks"]["PostToolUse"] for h in e["hooks"]
             if "guard-test-asset-hygiene.js" in h["command"]][0]
    m = re.search(r"HOOK_BUDGET_MS\s*=\s*(\d+)", src)
    problems = []
    if not m:
        problems.append("缺 HOOK_BUDGET_MS 總預算")
    elif int(m.group(1)) / 1000.0 + 10 > limit:
        problems.append("預算 %ss 未低於 hooks.json timeout %ss 至少 10 秒" % (int(m.group(1)) / 1000.0, limit))
    literal = re.findall(r"timeout:\s*\d+", src)
    if literal:
        problems.append("子程序 timeout 寫死：%s" % literal)
    return problems


def test_A6_guard_hooks_do_not_call_process_exit():
    from conftest import PLUGIN
    assert check_no_exit_after_output(PLUGIN / "hooks") == []


def test_A7_hygiene_budget_below_hooks_json_timeout():
    from conftest import PLUGIN
    assert check_hygiene_budget(PLUGIN / "hooks") == []


# =====================================================================
# B14：i18n_locator_check —— 定位器套在 expect()／assert 裡仍是定位器
# =====================================================================

def test_B14_expect_wrapped_locator_is_locator(installed):
    installed.write("orders/test_o.py", 'def test_x(page):\n'
                    '    expect(page.get_by_text("送出")).to_have_text("送出")\n')
    r = installed.tool("i18n_locator_check.py", "all", "--list")
    assert "定位器（切語系會找不到元素）：1 處" in r.stdout, r.stdout
    assert "斷言（驗顯示文字內容）：0 處" in r.stdout, r.stdout


def test_B14_value_side_text_is_assertion(installed):
    installed.write("orders/test_o.py", 'def test_x(page):\n'
                    '    assert page.locator("#msg").get_attribute("data-sel") == "text=已送出"\n')
    r = installed.tool("i18n_locator_check.py", "all", "--list")
    assert "定位器（切語系會找不到元素）：0 處" in r.stdout, r.stdout
    assert "斷言（驗顯示文字內容）：1 處" in r.stdout, r.stdout


# =====================================================================
# A5／B07／B08：env_gates port 歸屬閘
# =====================================================================

class _Proc(object):
    def __init__(self, out):
        self.stdout = out
        self.returncode = 0


def test_A5_owner_query_timeout_is_fail_open(monkeypatch):
    eg = _import_tool("env_gates")
    import subprocess as sp

    def boom(*a, **k):
        raise sp.TimeoutExpired(a[0] if a else "lsof", 30)
    monkeypatch.setattr(eg.subprocess, "run", boom)
    ok, lines = eg.port_guard_check(expect="wt", cfg={"ports": [{"label": "前端", "port": 5173}]}, env={}, backend="lsof")
    assert ok is True, lines
    assert any("無法查" in ln for ln in lines), lines


def test_B07_ipv6_url_port():
    eg = _import_tool("env_gates")
    assert eg._port_of_url("http://[::1]:8080/api") == 8080
    assert eg._port_of_url("https://[2001:db8::1]/") == 443
    assert eg._port_of_url("http://localhost:5173") == 5173


def test_B08_all_listeners_checked(monkeypatch):
    eg = _import_tool("env_gates")

    def fake(args, **k):
        if args[0] == "lsof":
            return _Proc("111\n222\n")
        pid = args[-1]
        return _Proc({"111": "node /home/u/wt/app/server.js", "222": "node /home/u/other/app/server.js"}.get(pid, ""))
    monkeypatch.setattr(eg.subprocess, "run", fake)
    ok, lines = eg.port_guard_check(expect="wt", cfg={"ports": [{"label": "前端", "port": 5173}]}, env={}, backend="lsof")
    assert ok is False and any("other" in ln for ln in lines), lines


# =====================================================================
# H5／B05／B06：sweep_residue
# =====================================================================

def _sweep_db(p, extra_sql=""):
    con = sqlite3.connect(str(p.e2e / "demo.sqlite"))
    con.executescript("""
        CREATE TABLE orders (id INTEGER PRIMARY KEY, title TEXT, created_at TEXT);
        CREATE TABLE order_items (id INTEGER PRIMARY KEY, order_id INTEGER, sku TEXT);
        INSERT INTO orders VALUES (1, 'QA_order-a', '2020-01-01 00:00:00');
        INSERT INTO orders VALUES (2, 'QAXorder-real', '2020-01-01 00:00:00');
        INSERT INTO orders VALUES (3, 'QA%real-100%', '2020-01-01 00:00:00');
        INSERT INTO order_items VALUES (10, 1, 'x'), (11, 2, 'y'), (12, 3, 'z');
    """ + extra_sql)
    con.commit()
    con.close()


def _rows(p, table):
    con = sqlite3.connect(str(p.e2e / "demo.sqlite"))
    try:
        return sorted(r[0] for r in con.execute("SELECT id FROM %s" % table))
    finally:
        con.close()


def _sweep_cfg(p, prefix, created=True):
    t = {"table": "orders", "marker_column": "title", "pk_column": "id",
         "children": [{"table": "order_items", "fk_column": "order_id"}]}
    if created:
        t["created_column"] = "created_at"
    p.config(test_data_prefix=prefix, db={"connector": "sqlite:demo.sqlite"}, residue={"targets": [t]})


def test_H5_like_wildcards_in_prefix_are_literal(installed):
    _sweep_db(installed)
    _sweep_cfg(installed, "QA_")
    r = installed.tool("sweep_residue.py", "--apply")
    assert "命中 1 筆" in r.stdout, r.stdout + r.stderr
    assert _rows(installed, "orders") == [2, 3], r.stdout      # QAXorder-real 不得因 _ 萬用字元被刪
    assert _rows(installed, "order_items") == [11, 12]


def test_H5_percent_in_prefix_is_literal(installed):
    _sweep_db(installed)
    _sweep_cfg(installed, "QA%")
    r = installed.tool("sweep_residue.py")
    assert "命中 1 筆" in r.stdout and "QA%real" in r.stdout, r.stdout


def test_B05_older_than_without_created_column_skips_table(installed):
    _sweep_db(installed)
    _sweep_cfg(installed, "QA_", created=False)
    r = installed.tool("sweep_residue.py", "--older-than-days", "7", "--apply")
    assert _rows(installed, "orders") == [1, 2, 3], r.stdout   # 無法判斷年齡 → 本表不刪
    assert "created_column" in r.stdout, r.stdout


def test_B06_delete_is_atomic_children_rolled_back(installed):
    _sweep_db(installed, "CREATE TRIGGER no_del BEFORE DELETE ON orders BEGIN SELECT RAISE(ABORT, 'locked'); END;")
    _sweep_cfg(installed, "QA_")
    r = installed.tool("sweep_residue.py", "--apply")
    assert r.returncode != 0, r.stdout
    assert _rows(installed, "order_items") == [10, 11, 12], r.stdout + r.stderr   # 主表刪失敗 → 子表的刪除要一起回滾


# =====================================================================
# B16：run_by_folder 輸出檔名不得相撞
# =====================================================================

def test_B16_output_names_do_not_collide(installed, tmp_path):
    installed.write("a/b/test_x.py", "def test_1():\n    pass\n")
    installed.write("a_b/test_y.py", "def test_2():\n    pass\n")
    out = tmp_path / "runs"
    installed.tool("run_by_folder.py", "a/b", "a_b", "--out-dir", str(out))
    folders = sorted(json.loads(f.read_text(encoding="utf-8"))["folder"] for f in out.glob("*.json"))
    assert folders == ["a/b", "a_b"], folders


# =====================================================================
# B15：參數檔巢狀型別錯誤 → 明確 exit 2，不得未捕捉例外
# =====================================================================

@pytest.mark.parametrize("key,value", [
    ("coverage", {"header": "使用情境"}),
    ("coverage", {"placeholder": 5}),
    ("hardcode", {"id_name_suffixes": "_ID"}),
    ("hardcode", {"account_context": [1, 2]}),
    ("i18n", {"script_class": 5}),
    ("residue", {"targets": "orders"}),
    ("skip_classify", {"A": "no data"}),
    ("external_system_keywords", {"webhook": "x"}),
    ("env_requirements", ["QA_URL"]),
    ("ports", ["5173"]),
    ("catalog", {"file": ["CATALOG.md"]}),
    ("db", {"connector": 5}),
])
@pytest.mark.parametrize("script", ["drift_check.py", "hardcode_check.py"])
def test_B15_nested_config_type_errors_exit_2(installed, key, value, script):
    installed.write("orders/test_o.py", "def test_a():\n    pass\n")
    installed.coverage("orders", ["| 建立訂單 | `test_o.py::test_a` | ✅ |"])
    installed.config(**{key: value})
    r = installed.tool(script, "all")
    assert r.returncode == 2, (r.returncode, r.stdout, r.stderr)
    assert "Traceback" not in r.stderr, r.stderr
    assert "型別" in r.stderr, r.stderr


# =====================================================================
# B20：同日多次 --force 更新不得覆蓋同名備份
# =====================================================================

def test_B20_force_sync_keeps_every_backup(installed):
    from conftest import INSTALLER
    import subprocess
    tool = installed.e2e / "tools" / "drift_check.py"
    for n in (1, 2):
        tool.write_text(tool.read_text(encoding="utf-8") + "\n# 本地修改 %d\n" % n, encoding="utf-8")
        subprocess.run([sys.executable, str(INSTALLER), "sync", str(installed.e2e), "--force"],
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    baks = sorted(p.name for p in (installed.e2e / "tools").glob("drift_check.py.bak-*"))
    assert len(baks) == 2, baks
    contents = [(installed.e2e / "tools" / b).read_text(encoding="utf-8") for b in baks]
    assert any("本地修改 1" in c for c in contents) and any("本地修改 2" in c for c in contents)


# =====================================================================
# B21：掛點貼到既有 conftest.py 尾端不得蓋掉專案自己的同名 hook
# =====================================================================

def test_B21_snippet_does_not_override_project_hooks(installed):
    from conftest import TEMPLATES
    own = ("import os\n\n"
           "def pytest_configure(config):\n"
           "    open(os.path.join(os.path.dirname(__file__), 'project_configure.marker'), 'w').close()\n\n")
    snippet = (TEMPLATES / "conftest_snippet.py").read_text(encoding="utf-8")
    installed.write("conftest.py", own + snippet)
    installed.write("orders/test_o.py", "def test_a():\n    assert True\n")
    r = installed.pytest("orders")
    assert r.returncode == 0, r.stdout + r.stderr
    assert (installed.e2e / "project_configure.marker").exists(), "專案自己的 pytest_configure 被蓋掉了"
    assert [(n, o) for _b, n, _f, o in installed.sqlite_rows()] == [("orders/test_o.py::test_a", "passed")]


# =====================================================================
# B22／B23：coverage_md
# =====================================================================

def test_B22_folder_with_coverage_but_no_tests_still_audited(installed):
    installed.write("orders/test_o.py", "def test_a():\n    pass\n")
    installed.coverage("orders", ["| 建立訂單 | `test_o.py::test_a` | ✅ |"])
    assert installed.tool("drift_check.py", "all").returncode == 0
    os.remove(str(installed.e2e / "orders" / "test_o.py"))
    r = installed.tool("drift_check.py", "all")
    assert r.returncode == 1 and "ghost" in r.stdout and "test_a" in r.stdout, r.stdout


def test_B23_status_counted_from_state_column_only(installed):
    installed.write("orders/test_o.py", "def test_a():\n    pass\n")
    installed.coverage("orders", ["| 使用者看到 ✅ 勾勾後送出 | `test_o.py::test_a` | ❌ |"])
    cm = _import_tool("coverage_md")
    qc = _import_tool("qa_config")
    cfg = qc.load(str(installed.e2e), use_cache=False)
    assert cm.count_scenarios("orders", cfg, str(installed.e2e)) == (1, 0, 0, 1)


# =====================================================================
# B24／B26／B27：寫入落點不得逃出 tests/e2e（.. 與 symlink）
# =====================================================================

def _dir_link(link, target):
    try:
        os.symlink(str(target), str(link), target_is_directory=True)
        return True
    except (OSError, NotImplementedError):
        if sys.platform.startswith("win"):
            import _winapi
            try:
                _winapi.CreateJunction(str(target), str(link))
                return True
            except OSError:
                return False
        return False


def test_B24_register_refuses_symlinked_folder(installed, tmp_path):
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "test_x.py").write_text("def test_a():\n    pass\n", encoding="utf-8")
    if not _dir_link(installed.e2e / "linked", outside):
        pytest.skip("此平台無法建立目錄連結")
    r = installed.tool("coverage_register.py", "情境", "test_x.py::test_a", "完整", "linked")
    assert r.returncode == 2, r.stdout
    assert not (outside / "COVERAGE.md").exists()


def test_B26_fill_orphans_refuses_dotdot(installed):
    outside = installed.root / "tests" / "outside"
    outside.mkdir(parents=True)
    (outside / "test_z.py").write_text("def test_z():\n    pass\n", encoding="utf-8")
    r = installed.tool("fill_orphans.py", "../outside")
    assert r.returncode == 2, r.stdout
    assert not (outside / "COVERAGE.md").exists()


def test_B27_make_skeleton_refuses_dotdot(installed):
    outside = installed.root / "tests" / "outside"
    outside.mkdir(parents=True)
    (outside / "COVERAGE.md").write_text("# 別人的檔\n", encoding="utf-8")
    r = installed.tool("make_skeleton.py", "../outside", "--force")
    assert r.returncode == 2, r.stdout
    assert (outside / "COVERAGE.md").read_text(encoding="utf-8") == "# 別人的檔\n"


def test_B27_make_skeleton_refuses_symlinked_folder(installed, tmp_path):
    outside = tmp_path / "outside2"
    outside.mkdir()
    if not _dir_link(installed.e2e / "linked2", outside):
        pytest.skip("此平台無法建立目錄連結")
    r = installed.tool("make_skeleton.py", "linked2")
    assert r.returncode == 2, r.stdout
    assert not (outside / "COVERAGE.md").exists()


# =====================================================================
# B25：明確指定檔名但不匹配時，不得退回其他檔的同名函式
# =====================================================================

def test_B25_explicit_wrong_file_is_ghost_not_registered(installed):
    installed.write("orders/test_a.py", "def test_1():\n    pass\n")
    installed.write("orders/test_b.py", "def test_x():\n    pass\n")
    installed.coverage("orders", ["| 一 | `test_a.py::test_1` | ✅ |", "| 二 | `test_a.py::test_x` | ✅ |"])
    r = installed.tool("drift_check.py", "orders")
    assert r.returncode == 1, r.stdout
    assert "orphan (code has, doc missing): test_b.py::test_x" in r.stdout, r.stdout
    assert "ghost  (doc has, code missing): test_a.py::test_x" in r.stdout, r.stdout


# =====================================================================
# B28／H1：gen_catalog
# =====================================================================

def test_B28_ast_failure_refuses_instead_of_claiming_selfcheck(installed):
    installed.write("orders/test_ok.py", "def test_a():\n    pass\n")
    installed.write("orders/test_bad.py", "def test_b():\n    pass\n\ndef broken(:\n    pass\n")
    installed.coverage("orders", ["| 一 | `test_ok.py::test_a` | ✅ |", "| 二 | `test_bad.py::test_b` | ✅ |"])
    r = installed.tool("gen_catalog.py")
    assert r.returncode == 1 and "test_bad.py" in r.stdout, r.stdout
    assert not (installed.e2e / "CATALOG.md").exists()


def test_H1_gen_catalog_refuses_to_overwrite_project_catalog(installed):
    own = "# 專案自有格式的 CATALOG\n\n| 模組 | 負責人 |\n|---|---|\n| orders | 小明 |\n"
    installed.write("CATALOG.md", own)
    installed.write("orders/test_o.py", "def test_a():\n    pass\n")
    installed.coverage("orders", ["| 建立訂單 | `test_o.py::test_a` | ✅ |"])
    r = installed.tool("gen_catalog.py")
    assert r.returncode == 2, r.stdout
    assert "不是本工具生成" in r.stdout, r.stdout
    assert installed.read("CATALOG.md") == own


def test_H1_gen_catalog_still_regenerates_own_output(installed):
    installed.write("orders/test_o.py", "def test_a():\n    pass\n")
    installed.coverage("orders", ["| 建立訂單 | `test_o.py::test_a` | ✅ |"])
    assert installed.tool("gen_catalog.py").returncode == 0
    assert installed.tool("gen_catalog.py").returncode == 0   # 第二次（自己生成的檔）照常重生


# =====================================================================
# B29／B30／B31：migrate_catalog
# =====================================================================

LEGACY_HEAD = ("# 情境覆蓋索引（catalog）\n\n> 由 qa-flow.sh catalog 回填，邊 codify 邊登記。\n\n"
               "| 白話業務情境 | 對應測試函式 | 覆蓋狀態 | 業務模組分類 |\n|------|------|------|------|\n")


def _legacy(p, rows):
    p.write("catalog.md", LEGACY_HEAD + "".join(rows))


def test_B29_module_column_cannot_escape_e2e(installed):
    outside = installed.root / "tests" / "outside"
    outside.mkdir(parents=True)
    installed.write("orders/test_o.py", "def test_a():\n    pass\n")
    _legacy(installed, ["| 管理員建立訂單 | test_a | ✅完整 | orders |\n",
                        "| 越界 | — | ❌未覆蓋 | ../outside |\n"])
    installed.tool("migrate_catalog.py")
    assert not (outside / "COVERAGE.md").exists()
    assert "越界" in installed.read("COVERAGE.md")


def test_B30_ambiguous_function_is_not_silently_resolved(installed):
    installed.write("orders/test_o.py", "def test_x():\n    pass\n")
    installed.write("billing/test_b.py", "def test_x():\n    pass\n")
    _legacy(installed, ["| 同名 | test_x | ✅完整 | orders |\n"])
    r = installed.tool("migrate_catalog.py")
    assert r.returncode == 1, r.stdout
    assert "多個" in r.stdout and "test_x" in r.stdout, r.stdout
    assert (installed.e2e / "catalog.md").exists()          # 失敗不得改名舊檔
    assert not (installed.e2e / "orders" / "COVERAGE.md").exists()


def test_B31_same_function_different_scenario_is_migrated(installed):
    installed.write("orders/test_o.py", "def test_a():\n    pass\n")
    installed.coverage("orders", ["| 舊情境 | `test_o.py::test_a` | ✅ |"])
    _legacy(installed, ["| 新情境：取消後重建 | test_o.py::test_a | ❌未覆蓋 | orders |\n"])
    r = installed.tool("migrate_catalog.py")
    assert r.returncode == 0, r.stdout
    cov = installed.read("orders/COVERAGE.md")
    assert "舊情境" in cov and "新情境：取消後重建" in cov, cov


# =====================================================================
# qa-flow.sh：H1 H4 B17 B18 B19 B32
# =====================================================================

from conftest import needs_bash  # noqa: E402

FLOW_LEGACY = LEGACY_HEAD + "| 管理員建立訂單 | test_create | ✅完整 | orders |\n"


def _flow_legacy(project, conftest=True):
    project.e2e.mkdir(parents=True, exist_ok=True)
    project.write("orders/test_orders.py", "def test_create():\n    assert True\n")
    if conftest:
        project.write("conftest.py", "# 專案自己的 conftest\n")
    project.write("catalog.md", FLOW_LEGACY)
    return project


@needs_bash
def test_H1_bootstrap_reports_project_catalog_and_catalog_keeps_it(project):
    own = "# 專案自有格式的 CATALOG\n\n| 模組 | 負責人 |\n|---|---|\n| orders | 小明 |\n"
    project.e2e.mkdir(parents=True)
    project.write("CATALOG.md", own)
    r = project.flow("bootstrap")
    assert "MODE: none" in r.stdout, r.stdout
    assert "專案自有" in r.stdout and "CATALOG.md" in r.stdout, r.stdout
    assert project.flow("scaffold", "orders", "pytest").returncode == 0
    project.write("orders/test_orders.py", "def test_create():\n    assert True\n")
    r = project.flow("catalog", "管理員建立訂單", "test_orders.py::test_create", "完整", "orders")
    assert project.read("CATALOG.md") == own, "專案自有 CATALOG 被覆寫了"
    assert "拒絕覆寫" in r.stdout + r.stderr, r.stdout + r.stderr


@needs_bash
def test_H4_migrate_dry_run_writes_nothing(project):
    _flow_legacy(project)
    before = sorted(str(p.relative_to(project.root)) for p in project.root.rglob("*"))
    r = project.flow("migrate", "--dry-run")
    assert r.returncode == 0, r.stdout + r.stderr
    after = sorted(str(p.relative_to(project.root)) for p in project.root.rglob("*"))
    assert after == before, sorted(set(after) - set(before))[:10]


@needs_bash
def test_B17_failed_migrate_can_be_retried(project):
    _flow_legacy(project)
    # 既有 orders/COVERAGE.md 沒有情境表 → migrate_catalog 會失敗
    project.write("orders/COVERAGE.md", "# 只有標題，沒有情境表\n")
    r = project.flow("migrate")
    assert r.returncode != 0, r.stdout + r.stderr
    assert not (project.e2e / "qa-webwright.json").exists(), "遷移失敗卻留下參數檔（之後被判成三層、無法重跑）"
    assert "MODE: legacy-catalog" in project.flow("bootstrap").stdout
    project.write("orders/COVERAGE.md", "# orders/ 情境覆蓋\n\n| 使用情境（白話） | 測試函式 | 覆蓋 |\n|---|---|---|\n")
    r = project.flow("migrate")
    assert r.returncode == 0, r.stdout + r.stderr


@needs_bash
def test_B18_migrate_without_conftest_creates_hook(project):
    _flow_legacy(project, conftest=False)
    r = project.flow("migrate")
    assert r.returncode == 0, r.stdout + r.stderr
    assert (project.e2e / "conftest.py").exists(), r.stdout
    assert "qa-webwright 掛點" in project.read("conftest.py")


@needs_bash
def test_B19_run_tool_refuses_project_owned_same_name_tool(project):
    project.e2e.mkdir(parents=True)
    project.write("tools/make_skeleton.py",
                  "# 專案自有的同名工具\nopen('ran.marker', 'w').close()\n")
    r = project.flow("scaffold", "orders", "pytest")
    assert not (project.e2e / "ran.marker").exists(), "執行了專案自有的同名工具"
    assert "不是本 plugin 版本" in r.stdout + r.stderr, r.stdout + r.stderr


@needs_bash
def test_B32_run_date_is_validated(project):
    assert project.flow("scaffold", "orders", "pytest").returncode == 0
    project.write("orders/test_ok.py", "def test_ok():\n    assert True\n")
    r = project.flow("run", "orders", "orders/test_ok.py", "../../../escaped")
    assert r.returncode == 1 and "YYYY-MM-DD" in r.stderr, r.stdout + r.stderr
    assert not list(project.root.parent.glob("*escaped*")) and not list(project.root.rglob("*escaped*"))


# =====================================================================
# H2／H3／B33：文件
# =====================================================================

def _all_text_files():
    from conftest import PLUGIN
    for p in sorted(PLUGIN.rglob("*")):
        if p.is_file() and "__pycache__" not in p.parts and ".pytest_cache" not in p.parts:
            try:
                yield p, p.read_text(encoding="utf-8")
            except (UnicodeDecodeError, OSError):
                continue


def test_H2_upgrade_report_moved_out_of_plugin():
    from conftest import PLUGIN
    name = "UPGRADE-0.9.0" + "-REPORT"   # 拆開寫，免得本檔自己命中
    assert not (PLUGIN / "docs" / (name + ".md")).exists()
    hits = [p.relative_to(PLUGIN).as_posix() for p, t in _all_text_files() if name in t]
    assert hits == [], hits


# H3：原專案語彙（不分大小寫）。拆開寫免得本檔自己命中；ASCII 縮寫用字界比對
# （ldap、adapter 這類一般英文字不是專案語彙）。
H3_BANNED = [
    "Win" + "bond", "Supp" + "lier_Code", r"\bD" + r"AP\b", "WE" + "HQ", "PHC" + "HOU", r"fu\." + "lin", "ko" + "fee",
    "碳" + "排", "外" + "站", "內" + "站", "供" + "應商", "品" + "改", "評" + "比", "稽" + "催", r"\bK" + r"MS\b",
    r"\bB" + r"PM\b", r"\bHM" + r"S2\b", r"\bAP" + r"IM\b", r"\bS" + r"AP\b", "政府" + "資料", r"\bCA" + r"IS\b",
    # 來源專案的類別名片段（真實檔名加行號外洩過一次，專案詞清單看不到）
    "Callback" + "Boss", "Submit" + "Supp" + "lier", "Main" + "VendorCode", "Invite" + "Link", "Partner" + "Auth",
]
# 真實站名：只允許「不是測試標的」的文件參考連結（格式規範、工具來源、安裝說明）與 example.* 保留網域
H3_ALLOWED_HOSTS = {"keepachangelog.com", "github.com", "python.org", "localhost", "127.0.0.1"}


def test_H3_no_source_project_vocabulary_anywhere():
    import re
    from conftest import PLUGIN
    rx = re.compile("|".join(H3_BANNED), re.I)
    hits = []
    for p, text in _all_text_files():
        for i, line in enumerate(text.splitlines(), 1):
            if rx.search(line):
                hits.append("%s:%d %s" % (p.relative_to(PLUGIN).as_posix(), i, line.strip()[:80]))
    assert hits == [], "\n".join(hits)


def test_H3_no_real_site_names_except_doc_references():
    import re
    from conftest import PLUGIN
    host = re.compile(r"\b((?:[a-z0-9-]+\.)+(?:com|net|org|io|tw|cn|jp|dev|app|co|test|local))\b", re.I)
    bad = []
    for p, text in _all_text_files():
        for m in host.finditer(text):
            h = m.group(1).lower().rstrip(".")
            if h in H3_ALLOWED_HOSTS or re.search(r"(^|\.)example(-[a-z]+)?\.(com|net|org|test)$|\.(test|local)$", h):
                continue
            if re.match(r"^[\w-]+\.(py|js|mjs|json|md|sh|xml|log|png|docx|app)$", h):
                continue
            bad.append("%s: %s" % (p.relative_to(PLUGIN).as_posix(), h))
    assert bad == [], sorted(set(bad))


def test_B33_plugin_json_description_lists_every_wired_hook():
    import re
    from conftest import PLUGIN
    desc = json.loads((PLUGIN / ".claude-plugin" / "plugin.json").read_text(encoding="utf-8"))["description"]
    hooks = json.loads((PLUGIN / "hooks" / "hooks.json").read_text(encoding="utf-8"))
    names = sorted({re.search(r"hooks/([\w.-]+)\.js", h["command"]).group(1)
                    for entries in hooks["hooks"].values() for e in entries for h in e["hooks"]})
    missing = [n for n in names if n not in desc]
    assert missing == [], missing


def test_C_known_limitations_listed_in_readme():
    """C 類只修第 5 節指定者；其餘逐條寫進 README「已知限制」節（一句話＋為何不追）。"""
    from conftest import PLUGIN
    text = (PLUGIN / "README.md").read_text(encoding="utf-8")
    sec = text.split("## 已知限制", 1)[1].split("\n## ", 1)[0]
    for cid in ("C01", "C03", "C04", "C05", "C08", "C14", "C16"):
        assert "| %s |" % cid in sec, cid
    assert "為何不追" in sec


# =====================================================================
# 註：下方各段的「A 軌／B 軌」＝送審時並行的兩條獨立審查軌，編號前綴標明意見出自哪一軌。
# R3 第 1 輪審查意見（K2-xx＝A 軌 qa-flow/lib/templates/tools1 批、K3-xx＝tools2 批、CR1-xx＝B 軌）
# =====================================================================

def _can_symlink_file(tmp_path):
    src = tmp_path / "probe_src.py"
    src.write_text("x", encoding="utf-8")
    try:
        os.symlink(str(src), str(tmp_path / "probe_link.py"))
        return True
    except (OSError, NotImplementedError):
        return False


@needs_bash
def test_K2_01_run_rejects_symlinked_test_file(project, tmp_path):
    if not _can_symlink_file(tmp_path):
        pytest.skip("此平台不能建立檔案 symlink（Windows 需開發人員模式／系統管理員）")
    assert project.flow("scaffold", "orders", "pytest").returncode == 0
    outside = tmp_path / "outside_test.py"
    outside.write_text("def test_x():\n    assert True\n", encoding="utf-8")
    os.symlink(str(outside), str(project.e2e / "orders" / "test_link.py"))
    r = project.flow("run", "orders", "orders/test_link.py")
    assert r.returncode == 1 and "symlink" in r.stderr, r.stdout + r.stderr


@needs_bash
def test_K2_02_playwright_js_scaffold_in_three_layer_mode(project):
    assert project.flow("scaffold", "orders", "pytest").returncode == 0
    r = project.flow("scaffold", "cart", "playwright-js")
    assert r.returncode == 0, r.stdout + r.stderr
    assert not (project.e2e / "catalog.md").exists(), "三層模式不該再建舊版單一 catalog"
    assert "—" in r.stdout and "COVERAGE" in r.stdout, r.stdout


@needs_bash
def test_K2_03_no_conftest_hook_when_tools_conflict(project):
    project.e2e.mkdir(parents=True)
    project.write("tools/qa_config.py", "# 專案自有的同名工具\nX = 1\n")
    r = project.flow("scaffold", "orders", "pytest")
    assert not (project.e2e / "conftest.py").exists(), "撞名工具會讓掛點 import 到不相容的模組"
    assert "ACTION-REQUIRED" in r.stdout + r.stderr and "qa_config.py" in r.stdout + r.stderr, r.stdout + r.stderr


def test_K2_04_snippet_chains_prev_hook_with_plugin_name(installed):
    from conftest import TEMPLATES
    own = ("import os\n\n"
           "def pytest_plugin_registered(plugin, plugin_name, manager):\n"
           "    pass\n\n")
    installed.write("conftest.py", own + (TEMPLATES / "conftest_snippet.py").read_text(encoding="utf-8"))
    installed.write("orders/test_o.py", "def test_a():\n    assert True\n")
    r = installed.pytest("orders")
    assert r.returncode == 0, r.stdout + r.stderr
    assert [(n, o) for _b, n, _f, o in installed.sqlite_rows()] == [("orders/test_o.py::test_a", "passed")]


def test_K2_05_fill_orphans_all_skips_linked_folder(installed, tmp_path):
    outside = tmp_path / "outside_all"
    outside.mkdir()
    (outside / "test_z.py").write_text("def test_z():\n    pass\n", encoding="utf-8")
    if not _dir_link(installed.e2e / "linked_all", outside):
        pytest.skip("此平台無法建立目錄連結")
    installed.tool("fill_orphans.py", "all")
    assert not (outside / "COVERAGE.md").exists()


def test_K2_06_migrate_skips_linked_folder(installed, tmp_path):
    outside = tmp_path / "outside_mig"
    outside.mkdir()
    (outside / "test_m.py").write_text("def test_m():\n    pass\n", encoding="utf-8")
    if not _dir_link(installed.e2e / "linked_mig", outside):
        pytest.skip("此平台無法建立目錄連結")
    _legacy(installed, ["| 連結裡的測試 | test_m | ✅完整 | linked_mig |\n"])
    installed.tool("migrate_catalog.py")
    assert not (outside / "COVERAGE.md").exists()


def test_K2_07_unresolved_function_is_visible_as_drift(installed):
    installed.write("orders/test_o.py", "def test_a():\n    pass\n")
    _legacy(installed, ["| 建立訂單 | test_a | ✅完整 | orders |\n", "| 已刪掉的舊測試 | test_gone | ✅完整 | orders |\n"])
    assert installed.tool("migrate_catalog.py").returncode == 0
    r = installed.tool("drift_check.py", "all")
    assert r.returncode == 1 and "test_gone" in installed.read("COVERAGE.md"), r.stdout


def test_K2_08_migrate_rerun_does_not_duplicate_rows(installed):
    installed.write("orders/test_o.py", "def test_a():\n    pass\n")
    rows = ["| 建立訂單 | test_a | ✅完整 | orders |\n", "| 報表匯出 | — | ❌未覆蓋 | orders |\n"]
    _legacy(installed, rows)
    assert installed.tool("migrate_catalog.py").returncode == 0
    _legacy(installed, rows)          # 模擬上次中途失敗、舊檔還在，重跑
    assert installed.tool("migrate_catalog.py").returncode == 0
    cov = installed.read("orders/COVERAGE.md")
    assert cov.count("報表匯出") == 1 and cov.count("`test_o.py::test_a`") == 1, cov


def test_K2_09_register_updates_row_in_later_scenario_table(installed):
    installed.write("orders/test_o.py", "def test_a():\n    pass\n\ndef test_b():\n    pass\n")
    installed.write("orders/COVERAGE.md",
                    "# orders/ 情境覆蓋\n\n## 建立\n\n| 使用情境（白話） | 測試函式 | 覆蓋 |\n|---|---|---|\n"
                    "| 建立訂單 | `test_o.py::test_a` | ✅ |\n\n## 取消\n\n| 使用情境（白話） | 測試函式 | 覆蓋 |\n|---|---|---|\n"
                    "| 取消訂單 | `test_o.py::test_b` | ⚠️ |\n")
    r = installed.tool("coverage_register.py", "取消訂單（含退款）", "test_o.py::test_b", "完整", "orders")
    assert r.returncode == 0, r.stdout
    cov = installed.read("orders/COVERAGE.md")
    assert cov.count("`test_o.py::test_b`") == 1 and "取消訂單（含退款）" in cov, cov


def test_K2_10_ambiguous_bare_reference_does_not_register_all(installed):
    installed.write("orders/test_a.py", "def test_x():\n    pass\n")
    installed.write("orders/test_b.py", "def test_x():\n    pass\n")
    installed.coverage("orders", ["| 同名 | test_x | ✅ |"])
    r = installed.tool("drift_check.py", "orders")
    assert r.returncode == 1 and "orphan" in r.stdout, r.stdout


@needs_bash
def test_K2_11_audit_fix_reports_remaining_drift(project):
    assert project.flow("scaffold", "orders", "pytest").returncode == 0
    project.write("orders/test_orders.py", "def test_a():\n    pass\n")
    r = project.flow("audit", "--fix")
    assert r.returncode == 3, r.stdout + r.stderr          # 孤兒補成「待補」佔位列＝還沒寫情境，不是 drift 0/0/0
    assert "佔位" in r.stdout + r.stderr


# ---- env_gates ----

def test_K3_01_powershell_failure_is_fail_open(monkeypatch):
    eg = _import_tool("env_gates")

    class P(object):
        stdout = ""
        returncode = 1
    monkeypatch.setattr(eg.subprocess, "run", lambda *a, **k: P())
    monkeypatch.setattr(eg.shutil, "which", lambda n: "C:/fake/" + n)  # portable-ok: 假的執行檔路徑字串，只供 monkeypatch
    ok, lines = eg.port_guard_check(expect="wt", cfg={"ports": [{"label": "前端", "port": 5173}]}, env={}, backend="windows")
    assert ok is True and any("無法查" in ln for ln in lines), lines


def test_K3_02_windows_unreadable_listener_is_not_skipped(monkeypatch):
    eg = _import_tool("env_gates")

    def fake(args, **k):
        script = args[-1]
        p = _Proc("")
        # 模擬 PowerShell：111 的命令列讀不到（系統／提權程序），222 在期望的 worktree
        if "`t" in script:   # 新格式：每個 listener 一行「pid<TAB>命令列」
            p.stdout = "111\t\n222\tC:\\u\\wt\\app\\node.exe server.js\n"
        else:
            p.stdout = "\nC:\\u\\wt\\app\\node.exe server.js\n"
        return p
    monkeypatch.setattr(eg.subprocess, "run", fake)
    monkeypatch.setattr(eg.shutil, "which", lambda n: "C:/fake/" + n)  # portable-ok: 假的執行檔路徑字串，只供 monkeypatch
    ok, lines = eg.port_guard_check(expect="wt", cfg={"ports": [{"label": "前端", "port": 5173}]}, env={}, backend="windows")
    assert ok is False, lines


def test_K3_03_worktree_suffix_with_hyphens_and_case():
    eg = _import_tool("env_gates")
    assert eg.owner_matches("/home/u/wt-feature-login/app/server.js", ["wt"])
    if sys.platform.startswith("win") or sys.platform == "darwin":
        assert eg.owner_matches("C:\\Users\\u\\WT\\app\\node.exe", ["wt"])  # portable-ok: 比對用的命令列字串，非執行路徑


def test_K3_04_owner_command_line_secrets_masked():
    eg = _import_tool("env_gates")
    ok, lines = eg.port_guard_check(expect="wt", cfg={"ports": [{"label": "後端", "port": 8080}]}, env={},
                                    owner_fn=lambda p: ["node /srv/other/app.js --token=abc123SECRET -p hunter2 --password=pw9876"])
    text = "\n".join(lines)
    assert ok is False and "abc123SECRET" not in text and "hunter2" not in text and "pw9876" not in text, text


# ---- hardcode_check ----

def test_K3_05_type_annotated_id_constant(installed):
    r = scan(installed, "ORDER_ID: int = 1133\n")
    assert counts(r).get("A") == 1 and r.returncode == 1, r.stdout


def test_K3_06_non_account_value_in_same_dict_not_flagged(installed):
    r = scan(installed, 'def test_x(api, current_user):\n    payload = {"username": current_user, "status": "ACTIVE"}\n')
    assert "F" not in counts(r) and r.returncode == 0, r.stdout


def test_K3_07_comparison_elsewhere_does_not_demote_hardcoded_account(installed):
    r = scan(installed, 'def test_x(role, current_user):\n    username = "ALICE" if role == "ADMIN" else current_user\n')
    assert counts(r).get("F") == 1 and r.returncode == 1, r.stdout


# ---- i18n_locator_check ----

def test_K3_08_multiline_locator_detected(installed):
    installed.write("orders/test_o.py", 'def test_x(page):\n    page.get_by_text(\n        "送出"\n    ).click()\n')
    r = installed.tool("i18n_locator_check.py", "all")
    assert "定位器（切語系會找不到元素）：1 處" in r.stdout, r.stdout


def test_K3_09_docstring_and_trailing_comment_ignored(installed):
    installed.write("orders/test_o.py", 'def test_x(page):\n    """範例：page.get_by_text("送出") 是錯誤示範。"""\n'
                                        '    x = 1  # 不要寫 page.get_by_text("送出")\n')
    r = installed.tool("i18n_locator_check.py", "all")
    assert "共 0 處" in r.stdout, r.stdout


def test_K3_10_locator_string_on_value_side_is_still_locator(installed):
    installed.write("orders/test_o.py", 'def test_x(page):\n    assert "送出" == page.locator("text=送出").inner_text()\n')
    r = installed.tool("i18n_locator_check.py", "all")
    assert "定位器（切語系會找不到元素）：1 處" in r.stdout, r.stdout


# ---- qa_config ----

def test_K3_11_null_section_is_config_error(installed):
    installed.write("orders/test_o.py", "def test_a():\n    pass\n")
    installed.config(hardcode=None)
    r = installed.tool("hardcode_check.py", "all")
    assert r.returncode == 2 and "Traceback" not in r.stderr and "型別" in r.stderr, (r.returncode, r.stderr)


def test_K3_12_invalid_regex_in_config_is_config_error(installed):
    installed.write("orders/test_o.py", "def test_a():\n    pass\n")
    installed.config(hardcode=dict(installed.config()["hardcode"], identity_lookup_patterns=["["]))
    r = installed.tool("hardcode_check.py", "all")
    assert r.returncode == 2 and "Traceback" not in r.stderr and "regex" in r.stderr, (r.returncode, r.stderr)


# ---- qa_pytest_plugin：xdist 下 A/D 閘 ----

def test_K3_13_xdist_runtime_A_skip_fails_the_run(installed):
    pytest.importorskip("xdist")
    installed.write("orders/test_o.py", "import pytest\n\ndef test_a():\n    pytest.skip('no data available')\n\n"
                                        "def test_b():\n    assert True\n")
    r = installed.pytest("orders", "-n", "2", "-p", "xdist")
    assert r.returncode != 0, r.stdout
    assert "A/D" in r.stdout, r.stdout


# ---- sweep_residue ----

def test_K3_14_negative_days_rejected(installed):
    _sweep_db(installed)
    _sweep_cfg(installed, "QA_")
    r = installed.tool("sweep_residue.py", "--older-than-days", "-1", "--apply")
    assert r.returncode == 2, r.stdout + r.stderr
    assert _rows(installed, "orders") == [1, 2, 3]


AUTOCOMMIT_DB = '''import sqlite3, os
LOG = []
class Auto(object):
    """每次 execute 立即 commit（模擬沒有交易語意的驅動）；begin/commit 是空操作，rollback 依設定拋錯。"""
    def __init__(self):
        self.conn = sqlite3.connect(os.path.join(os.path.dirname(__file__), "demo.sqlite"))
    def query(self, sql, params=()):
        return self.conn.execute(sql, params).fetchall()
    def execute(self, sql, params=()):
        self.conn.execute(sql, params); self.conn.commit()
    def begin(self):
        pass
    def commit(self):
        pass
    def rollback(self):
        if os.environ.get("QA_ROLLBACK_FAILS"):
            raise RuntimeError("rollback 失敗")
def connect():
    return Auto()
'''


def test_K3_15_identifiers_validated_before_any_delete(installed):
    _sweep_db(installed)
    installed.write("auto_db.py", AUTOCOMMIT_DB)
    installed.config(test_data_prefix="QA_", db={"connector": "auto_db:connect"}, residue={"targets": [
        {"table": "orders", "marker_column": "title", "pk_column": "id",
         "children": [{"table": "order_items", "fk_column": "order_id"}, {"table": "bad;drop", "fk_column": "order_id"}]}]})
    installed.tool("sweep_residue.py", "--apply")
    assert _rows(installed, "order_items") == [10, 11, 12]   # 第二張子表名不合法 → 一筆都不能先刪


def test_K3_16_failed_rollback_is_not_reported_as_rolled_back(installed):
    _sweep_db(installed, "CREATE TRIGGER no_del BEFORE DELETE ON orders BEGIN SELECT RAISE(ABORT, 'locked'); END;")
    installed.write("auto_db.py", AUTOCOMMIT_DB)
    _sweep_cfg(installed, "QA_")
    installed.config(db={"connector": "auto_db:connect"})
    r = installed.tool("sweep_residue.py", "--apply", env={"QA_ROLLBACK_FAILS": "1"})
    assert r.returncode != 0 and "已回滾" not in r.stdout and "回滾失敗" in r.stdout, r.stdout


# ---- CR1 ----

def test_CR1_03_migrate_verifies_written_content(installed, monkeypatch):
    installed.write("orders/test_o.py", "def test_a():\n    pass\n")
    _legacy(installed, ["| 建立訂單 | test_a | ✅完整 | orders |\n"])
    monkeypatch.setenv("QA_E2E_ROOT", str(installed.e2e))
    mc = _import_tool("migrate_catalog")
    cm = _import_tool("coverage_md")
    qc = _import_tool("qa_config")
    qc._CACHE.clear()
    monkeypatch.setattr(cm, "atomic_write", lambda path, text: None)   # 模擬寫入沒生效
    rc = mc.main([])
    assert rc == 1
    assert (installed.e2e / "catalog.md").exists()


@needs_bash
def test_CR1_04_js_legacy_catalog_not_migrated(project):
    assert project.flow("scaffold", "cart", "playwright-js").returncode == 0
    project.write("cart.spec.js", "test('加入購物車', async () => {});\n")
    r = project.flow("bootstrap")
    assert "qa-flow.sh migrate —— 轉成三層" not in r.stdout, r.stdout
    r = project.flow("migrate")
    assert r.returncode == 2 and "JS" in r.stderr, r.stdout + r.stderr
    assert not (project.e2e / "qa-webwright.json").exists()


@needs_bash
def test_CR1_05_scaffold_lists_gates_enabled_by_example_config(project):
    r = project.flow("scaffold", "orders", "pytest")
    for gate in ("dispatch_gate", "commit_gate", "command_guards", "report_hygiene", "browser_guard"):
        assert gate in r.stdout, (gate, r.stdout)
    from conftest import PLUGIN
    readme = (PLUGIN / "README.md").read_text(encoding="utf-8")
    assert "scaffold 建立的參數檔" in readme


def test_CR1_06_config_with_utf8_bom(installed):
    installed.write("orders/test_o.py", "def test_a():\n    pass\n")
    installed.coverage("orders", ["| 建立訂單 | `test_o.py::test_a` | ✅ |"])
    p = installed.e2e / "qa-webwright.json"
    p.write_bytes(b"\xef\xbb\xbf" + p.read_bytes())
    r = installed.tool("drift_check.py", "all")
    assert r.returncode == 0, r.stdout + r.stderr


def test_CR1_09_crlf_checkout_is_not_local_modification(installed):
    from conftest import INSTALLER
    import subprocess
    tool = installed.e2e / "tools" / "drift_check.py"
    tool.write_bytes(tool.read_bytes().replace(b"\n", b"\r\n"))
    r = subprocess.run([sys.executable, str(INSTALLER), "status", str(installed.e2e)],
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    line = [ln for ln in r.stdout.splitlines() if "drift_check.py" in ln][0]
    assert "本地修改" not in line, line


def test_CR1_10_environment_reasons_are_B_not_A():
    sa = _import_tool("skip_audit")
    for reason in ("後端服務未回應", "API 未回應", "外部系統無回應", "環境變數未設定", "連線逾時"):
        assert sa.classify(reason) == "B", reason
    for reason in ("查無訂單", "找不到資料", "no data available", "0 筆資料"):
        assert sa.classify(reason) == "A", reason


def test_CR1_13_changelog_created_column_precondition():
    from conftest import PLUGIN
    text = (PLUGIN / "CHANGELOG.md").read_text(encoding="utf-8")
    line = [ln for ln in text.splitlines() if "created_column" in ln and "不刪" in ln][0]
    assert "--older-than-days" in line, line


def test_K3_09_docstring_with_cjk_does_not_blank_next_line(installed):
    """docstring 含中文時（ast 位移是位元組），抹除範圍不得溢到下一行的真定位器。"""
    installed.write("orders/test_o.py", 'def test_x(page):\n    """中文說明中文說明中文說明中文說明。"""\n'
                                        '    page.get_by_text("送出").click()\n')
    r = installed.tool("i18n_locator_check.py", "all")
    assert "定位器（切語系會找不到元素）：1 處" in r.stdout, r.stdout


# =====================================================================
# R3 第 2 輪審查意見（L1-15＝hooks 批靜態、L2-xx＝qa-flow/lib/templates/tools1、L3-xx＝tools2）
# =====================================================================

def check_commit_gate_budget(hooks_dir):
    """commit 閘的 git 查詢要有總預算且低於 hooks.json 的 timeout；單次 timeout 不得寫死。"""
    import re
    src = open(os.path.join(str(hooks_dir), "guard-qa-before-commit.js"), encoding="utf-8").read()
    hooks = json.load(open(os.path.join(str(hooks_dir), "hooks.json"), encoding="utf-8"))
    limit = [h.get("timeout") for e in hooks["hooks"]["PreToolUse"] for h in e["hooks"]
             if "guard-qa-before-commit.js" in h["command"]][0]
    m = re.search(r"GIT_BUDGET_MS\s*=\s*(\d+)", src)
    problems = []
    if not m:
        problems.append("缺 GIT_BUDGET_MS 總預算")
    elif int(m.group(1)) / 1000.0 + 5 > limit:
        problems.append("預算 %ss 未低於 hooks.json timeout %ss 至少 5 秒" % (int(m.group(1)) / 1000.0, limit))
    if re.findall(r"timeout:\s*\d+", src):
        problems.append("git 查詢 timeout 寫死")
    return problems


def test_L1_15_commit_gate_git_budget():
    from conftest import PLUGIN
    assert check_commit_gate_budget(PLUGIN / "hooks") == []


@needs_bash
def test_L2_01_bootstrap_does_not_merge_into_foreign_catalog(project):
    own = "# 專案自有格式的 CATALOG\n\n| 模組 | 負責人 |\n|---|---|\n| orders | 小明 |\n"
    project.e2e.mkdir(parents=True)
    project.write("CATALOG.md", own)
    (project.root / "catalog.md").write_text(LEGACY_HEAD + "| 舊情境 | test_a | ✅完整 | orders |\n", encoding="utf-8")
    project.flow("bootstrap")
    assert project.read("CATALOG.md") == own
    assert (project.root / "catalog.md").exists()


def test_L2_02_installer_refuses_linked_tools_dir(project, tmp_path):
    from conftest import INSTALLER
    import subprocess
    project.e2e.mkdir(parents=True)
    outside = tmp_path / "outside_tools"
    outside.mkdir()
    if not _dir_link(project.e2e / "tools", outside):
        pytest.skip("此平台無法建立目錄連結")
    r = subprocess.run([sys.executable, str(INSTALLER), "install", str(project.e2e)],
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    assert r.returncode == 2, r.stdout + r.stderr
    assert list(outside.iterdir()) == []


def test_L2_03_snippet_survives_other_tools_package(installed):
    from conftest import TEMPLATES
    installed.write("thirdparty/tools/__init__.py", "NAME = 'someone else'\n")
    own = ("import os, sys\nsys.path.insert(0, os.path.join(os.path.dirname(__file__), 'thirdparty'))\n"
           "import tools  # 另一個同名頂層套件先被載入（sys.modules 快取）\n\n")
    installed.write("conftest.py", own + (TEMPLATES / "conftest_snippet.py").read_text(encoding="utf-8"))
    installed.write("orders/test_o.py", "def test_a():\n    assert True\n")
    r = installed.pytest("orders")
    assert r.returncode == 0, r.stdout + r.stderr
    assert [(n, o) for _b, n, _f, o in installed.sqlite_rows()] == [("orders/test_o.py::test_a", "passed")]


def test_L2_04_catalog_ignores_linked_folder(installed, tmp_path):
    outside = tmp_path / "outside_cat"
    outside.mkdir()
    (outside / "test_z.py").write_text("def test_z():\n    pass\n", encoding="utf-8")
    (outside / "COVERAGE.md").write_text("| 使用情境（白話） | 測試函式 | 覆蓋 |\n|---|---|---|\n| 別專案機密情境 | `test_z.py::test_z` | ✅ |\n",
                                         encoding="utf-8")
    if not _dir_link(installed.e2e / "linked_cat", outside):
        pytest.skip("此平台無法建立目錄連結")
    installed.write("orders/test_o.py", "def test_a():\n    pass\n")
    installed.coverage("orders", ["| 建立訂單 | `test_o.py::test_a` | ✅ |"])
    assert installed.tool("gen_catalog.py").returncode == 0
    assert "linked_cat" not in installed.read("CATALOG.md")


@needs_bash
@pytest.mark.parametrize("name", ["helpers", "reports", "tools", "_reports"])
def test_L2_05_excluded_folder_names_rejected(installed, name):
    installed.write("%s/test_h.py" % name, "def test_h():\n    pass\n")
    r = installed.tool("coverage_register.py", "情境", "test_h.py::test_h", "完整", name)
    assert r.returncode == 2, r.stdout


@needs_bash
def test_L2_05_scaffold_rejects_excluded_feature(project):
    assert project.flow("scaffold", "helpers", "pytest").returncode == 1


def test_L2_06_class_based_tests_warned(installed):
    installed.write("orders/test_o.py", "class TestOrder:\n    def test_a(self):\n        assert True\n\n\ndef test_b():\n    pass\n")
    installed.coverage("orders", ["| 建立訂單 | `test_o.py::test_b` | ✅ |"])
    r = installed.tool("drift_check.py", "all")
    assert "類別" in r.stdout and "TestOrder" in r.stdout, r.stdout
    from conftest import PLUGIN
    sec = (PLUGIN / "README.md").read_text(encoding="utf-8").split("## 已知限制", 1)[1].split("\n## ", 1)[0]
    assert "類別" in sec


def test_L2_07_def_inside_string_ignored_and_extra_spaces_counted(installed):
    installed.write("orders/test_o.py", '"""說明：\ndef test_fake():\n    pass\n"""\n\ndef  test_real():\n    pass\n')
    installed.coverage("orders", [])
    r = installed.tool("drift_check.py", "orders")
    assert "test_real" in r.stdout and "test_fake" not in r.stdout, r.stdout


def test_L2_08_continuation_ref_to_deleted_function_is_ghost(installed):
    installed.write("orders/test_a.py", "def test_ok():\n    pass\n")
    installed.coverage("orders", ["| 一 | `test_a.py::test_ok`, `::test_deleted` | ✅ |"])
    r = installed.tool("drift_check.py", "orders")
    assert r.returncode == 1 and "ghost" in r.stdout and "test_deleted" in r.stdout, r.stdout


def test_L2_09_register_updates_row_without_backticks(installed):
    installed.write("orders/test_o.py", "def test_a():\n    pass\n")
    installed.coverage("orders", ["| 建立訂單 | test_o.py::test_a | ⚠️ |"])
    r = installed.tool("coverage_register.py", "建立訂單（含付款）", "test_o.py::test_a", "完整", "orders")
    assert r.returncode == 0, r.stdout
    cov = installed.read("orders/COVERAGE.md")
    assert cov.count("test_o.py::test_a") == 1 and "建立訂單（含付款）" in cov, cov


def test_L2_09_register_refuses_multi_function_row(installed):
    installed.write("orders/test_o.py", "def test_a():\n    pass\n\ndef test_b():\n    pass\n")
    installed.coverage("orders", ["| 建立與取消 | `test_o.py::test_a`、`::test_b` | ⚠️ |"])
    r = installed.tool("coverage_register.py", "建立", "test_o.py::test_a", "完整", "orders")
    assert r.returncode == 2 and "多個函式" in r.stdout, r.stdout


def test_L2_10_register_rejects_carriage_return(installed):
    installed.write("orders/test_o.py", "def test_a():\n    pass\n")
    r = installed.tool("coverage_register.py", "第一行\r第二行", "test_o.py::test_a", "完整", "orders")
    assert r.returncode == 2, r.stdout


def test_L2_11_migrate_keeps_rows_mentioning_header_words(installed):
    installed.write("orders/test_o.py", "def test_a():\n    pass\n")
    _legacy(installed, ["| 補登白話業務情境說明 | test_a | ✅完整 | orders |\n"])
    assert installed.tool("migrate_catalog.py").returncode == 0
    assert "補登白話業務情境說明" in installed.read("orders/COVERAGE.md")


def test_L2_12_migrate_folder_qualified_refs(installed):
    installed.write("orders/test_x.py", "def test_a():\n    pass\n")
    installed.write("billing/test_x.py", "def test_a():\n    pass\n")
    _legacy(installed, ["| 訂單 | orders/test_x.py::test_a | ✅完整 | orders |\n",
                        "| 帳務 | billing/test_x.py::test_a | ✅完整 | billing |\n"])
    r = installed.tool("migrate_catalog.py")
    assert r.returncode == 0, r.stdout
    assert "訂單" in installed.read("orders/COVERAGE.md") and "帳務" in installed.read("billing/COVERAGE.md")


def test_L2_13_started_at_has_subsecond_precision_and_latest_wins(tmp_path):
    import re
    rdb = _import_tool("runs_db")
    assert re.search(r"T\d\d:\d\d:\d\d\.\d{6}", rdb.utc_now_iso()), rdb.utc_now_iso()
    db = str(tmp_path / "r.sqlite")
    rdb.record_run("later-start", "2026-09-24T10:00:00.900000+00:00", "b", [("orders/test_o.py::test_a", "failed", 0)], db)
    rdb.record_run("early-start", "2026-09-24T10:00:00.100000+00:00", "b", [("orders/test_o.py::test_a", "passed", 0)], db)
    assert rdb.last_run_by_folder(db)["orders"]["run_id"] == "later-start"


def test_L2_14_catalog_escapes_pipes_in_title_and_batch(installed):
    installed.write("orders/test_o.py", "def test_a():\n    pass\n")
    installed.write("orders/COVERAGE.md", "# orders/ 情境覆蓋 訂單|退款\n\n| 使用情境（白話） | 測試函式 | 覆蓋 |\n|---|---|---|\n"
                                          "| 建立訂單 | `test_o.py::test_a` | ✅ |\n")
    installed.pytest("orders", env={"QA_BATCH": "a|b"})
    assert installed.tool("gen_catalog.py").returncode == 0
    row = [ln for ln in installed.read("CATALOG.md").splitlines() if ln.startswith("| `orders/`")][0]
    assert row.count(" | ") + 2 == 14 and "訂單\\|退款" in row and "a\\|b" in row, row


# ---- env_gates ----

def test_L3_01_powershell_script_distinguishes_not_found_from_failure():
    eg = _import_tool("env_gates")
    import inspect
    src = inspect.getsource(eg.owners_of)
    assert "-ErrorAction Stop" in src and "ObjectNotFound" in src
    if sys.platform.startswith("win") and eg.owner_backend() == "windows":
        import socket
        s = socket.socket()
        s.bind(("127.0.0.1", 0))
        free = s.getsockname()[1]
        s.close()
        assert eg.owners_of(free) == []   # 沒人 listen＝空清單，不是錯誤


def test_L3_02_lsof_stderr_and_ps_failure_are_query_errors(monkeypatch):
    eg = _import_tool("env_gates")

    class P(object):
        def __init__(self, out, rc, err=""):
            self.stdout, self.returncode, self.stderr = out, rc, err
    monkeypatch.setattr(eg.subprocess, "run", lambda args, **k: P("", 1, "lsof: WARNING: can't stat()"))
    ok, lines = eg.port_guard_check(expect="wt", cfg={"ports": [{"label": "前端", "port": 5173}]}, env={}, backend="lsof")
    assert ok is True and any("無法查" in ln for ln in lines), lines

    def fake(args, **k):
        return P("111\n", 0) if args[0] == "lsof" else P("", 1)
    monkeypatch.setattr(eg.subprocess, "run", fake)
    ok, lines = eg.port_guard_check(expect="wt", cfg={"ports": [{"label": "前端", "port": 5173}]}, env={}, backend="lsof")
    assert ok is True and any("無法查" in ln for ln in lines), lines


def test_L3_03_quoted_short_password_fully_masked():
    eg = _import_tool("env_gates")
    out = eg.mask_command_line('mysql -u qa -p "secret with spaces" db')
    assert "secret" not in out and "spaces" not in out, out


def test_L3_04_owner_paths_shortened():
    eg = _import_tool("env_gates")
    ok, lines = eg.port_guard_check(expect="wt", cfg={"ports": [{"label": "後端", "port": 8080}]}, env={},
                                    owner_fn=lambda p: ["node /home/someone/secret-proj/app/server.js"])
    text = "\n".join(lines)
    assert ok is False and "/home/someone" not in text and "server.js" in text, text


# ---- hardcode_check ----

def test_L3_05_trailing_comment_not_scanned(installed):
    r = scan(installed, 'def test_x():\n    x = 1  # username = "ALICE"\n')
    assert "F" not in counts(r) and r.returncode == 0, r.stdout


def test_L3_06_call_argument_account_literal(installed):
    r = scan(installed, 'def test_x(api):\n    api.login("ALICE")\n')
    assert counts(r).get("F") == 1 and r.returncode == 1, r.stdout


def test_L3_07_non_identity_bind_still_borrows(installed):
    r = scan(installed, 'def test_x(db):\n    row = db.query("SELECT * FROM orders WHERE status = ? LIMIT 1", ("paid",))\n')
    assert counts(r).get("H") == 1 and r.returncode == 1, r.stdout
    r = scan(installed, 'def test_x(db, oid):\n    row = db.query("SELECT * FROM orders WHERE id = ? LIMIT 1", (oid,))\n')
    assert "H" not in counts(r), r.stdout   # 以自造列的 Id 讀回＝合規（對照）


# ---- i18n ----

def test_L3_08_alt_text_and_chained_text_selector(installed):
    installed.write("orders/test_o.py", 'def test_x(page):\n    page.get_by_alt_text("商品圖片").click()\n'
                                        '    page.locator("button >> text=送出").click()\n')
    r = installed.tool("i18n_locator_check.py", "all")
    assert "定位器（切語系會找不到元素）：2 處" in r.stdout, r.stdout


def test_L3_09_multiline_fingerprint_covers_whole_call(installed):
    installed.write("orders/test_o.py", 'def test_x(page):\n    page.get_by_role(\n        "button",\n        name="送出",\n    ).click()\n')
    assert installed.tool("i18n_locator_check.py", "all", "--write-baseline", "--why", "初始").returncode == 0
    installed.write("orders/test_o.py", 'def test_x(page):\n    page.get_by_role(\n        "button",\n        name="取消",\n    ).click()\n')
    r = installed.tool("i18n_locator_check.py", "orders", "--baseline")
    assert r.returncode == 1 and "QA-TOOL-RESULT: violations" in r.stdout, r.stdout


# ---- qa_config ----

def test_L3_10_inline_flag_regex_is_config_error(installed):
    installed.write("orders/test_o.py", "def test_a():\n    pass\n")
    installed.config(skip_classify={"A": ["(?i)nodata"]})
    r = installed.tool("skip_audit.py", "all")
    assert r.returncode == 2 and "Traceback" not in r.stderr and "regex" in r.stderr, (r.returncode, r.stdout, r.stderr)


# ---- qa_pytest_plugin ----

def test_L3_11_xdist_worker_record_error_reported_by_controller(installed):
    pytest.importorskip("xdist")
    (installed.e2e / ".runs").mkdir(exist_ok=True)
    (installed.e2e / ".runs" / "results.sqlite").mkdir()        # 寫入必失敗（是個資料夾）
    installed.write("orders/test_o.py", "def test_a():\n    assert True\n\ndef test_b():\n    assert True\n")
    r = installed.pytest("orders", "-n", "2", "-p", "xdist")
    assert "recording FAILED" in r.stdout, r.stdout


# ---- skip_audit ----

def test_L3_12_non_pytest_skip_call_ignored(installed):
    installed.write("orders/test_o.py", "def test_a(cursor):\n    cursor.skip(10)\n    assert True\n")
    r = installed.tool("skip_audit.py", "orders", "--baseline")   # 與寫入衛生閘相同的呼叫方式
    assert r.returncode == 0 and "[A]" not in r.stdout, r.stdout


# ---- sweep_residue ----

RECORDING_DB = '''import sqlite3, os
SQL = []
class Rec(object):
    def __init__(self):
        self.conn = sqlite3.connect(os.path.join(os.path.dirname(__file__), "demo.sqlite"))
    def query(self, sql, params=()):
        return self.conn.execute(sql, params).fetchall()
    def execute(self, sql, params=()):
        with open(os.path.join(os.path.dirname(__file__), "sql.log"), "a", encoding="utf-8") as fh:
            fh.write(sql + "\\n")
        self.conn.execute(sql, params)
    def begin(self):
        self.conn.execute("BEGIN")
    def commit(self):
        self.conn.execute("COMMIT")
    def rollback(self):
        self.conn.execute("ROLLBACK")
def connect():
    return Rec()
'''


def test_L3_13_child_delete_rechecks_parent_marker(installed):
    _sweep_db(installed)
    installed.write("rec_db.py", RECORDING_DB)
    _sweep_cfg(installed, "QA_")
    installed.config(db={"connector": "rec_db:connect"})
    installed.tool("sweep_residue.py", "--apply")
    child = [ln for ln in installed.read("sql.log").splitlines() if ln.startswith("DELETE FROM order_items")][0]
    assert "SELECT" in child and "LIKE" in child, child


def test_L3_14_stop_after_failed_rollback(installed):
    _sweep_db(installed, "CREATE TRIGGER no_del BEFORE DELETE ON orders BEGIN SELECT RAISE(ABORT, 'locked'); END;"
                         "CREATE TABLE logs (id INTEGER PRIMARY KEY, title TEXT);"
                         "INSERT INTO logs VALUES (7, 'QA_log');")
    installed.write("auto_db.py", AUTOCOMMIT_DB)
    installed.config(test_data_prefix="QA_", db={"connector": "auto_db:connect"}, residue={"targets": [
        {"table": "orders", "marker_column": "title", "pk_column": "id",
         "children": [{"table": "order_items", "fk_column": "order_id"}]},
        {"table": "logs", "marker_column": "title", "pk_column": "id"}]})
    r = installed.tool("sweep_residue.py", "--apply", env={"QA_ROLLBACK_FAILS": "1"})
    assert r.returncode != 0
    assert _rows(installed, "logs") == [7], r.stdout      # 回滾失敗後不得繼續處理下一張表


# =====================================================================
# R3 第 3 輪審查意見（M2-xx＝A 軌 qa-flow/lib/templates/tools1 批、M3-xx＝tools2 批、
# CR3-xx＝B 軌與 A 軌不重疊者；同題者併入 M 編號）
# =====================================================================

def _file_link(link, target):
    try:
        os.symlink(str(target), str(link))
        return True
    except (OSError, NotImplementedError):
        return False


@needs_bash
def test_M2_01_scaffold_dotted_feature_suggests_registrable_file(project):
    r = project.flow("scaffold", "foo.bar", "pytest")
    assert r.returncode == 0, r.stdout + r.stderr
    assert "test_foo_bar.py" in r.stdout and "test_foo.bar.py" not in r.stdout, r.stdout


def test_M2_01_register_dotted_test_file_no_traceback(installed):
    installed.write("orders/test_foo.bar.py", "def test_x():\n    pass\n")
    r = installed.tool("coverage_register.py", "情境", "test_x", "完整", "orders")
    assert "Traceback" not in r.stderr, r.stderr
    assert r.returncode == 2, r.stdout


def test_M2_02_register_keeps_bare_continuation(installed):
    installed.write("orders/test_a.py", "def test_x():\n    pass\n\ndef test_y():\n    pass\n")
    installed.coverage("orders", ["| 一 | `test_a.py::test_x`、test_y | ⚠️ |"])
    assert installed.tool("drift_check.py", "orders").returncode == 0     # 裸名續寫算登記
    r = installed.tool("coverage_register.py", "一", "test_a.py::test_x", "完整", "orders")
    assert r.returncode == 2, r.stdout      # 同列還登記了 test_y：不得整列覆寫
    assert installed.tool("drift_check.py", "orders").returncode == 0, installed.read("orders/COVERAGE.md")


def test_M2_03_register_updates_matching_scenario_row(installed):
    installed.write("orders/test_o.py", "def test_a():\n    pass\n")
    installed.coverage("orders", ["| 建立訂單 | `test_o.py::test_a` | ✅ |", "| 取消訂單 | `test_o.py::test_a` | ⚠️ |"])
    r = installed.tool("coverage_register.py", "取消訂單", "test_o.py::test_a", "完整", "orders")
    assert r.returncode == 0, r.stdout
    cov = installed.read("orders/COVERAGE.md")
    assert "| 建立訂單 | `test_o.py::test_a` | ✅ |" in cov and "| 取消訂單 | `test_o.py::test_a` | ✅ |" in cov, cov
    # 同一函式多列、情境又都對不上 → 不知道該改哪一列 → 拒絕
    r = installed.tool("coverage_register.py", "退款", "test_o.py::test_a", "完整", "orders")
    assert r.returncode == 2, r.stdout


def test_M2_04_continuation_to_function_in_other_file_is_ghost(installed):
    installed.write("orders/test_a.py", "def test_x():\n    pass\n")
    installed.write("orders/test_b.py", "def test_y():\n    pass\n")
    installed.coverage("orders", ["| 一 | `test_a.py::test_x`, `::test_y` | ✅ |"])
    r = installed.tool("drift_check.py", "orders")
    assert r.returncode == 1 and "ghost" in r.stdout and "test_a.py::test_y" in r.stdout, r.stdout


def test_M2_05_drift_target_outside_e2e_rejected(installed):
    other = installed.root / "other"
    other.mkdir()
    (other / "test_s.py").write_text("def test_secret_other():\n    pass\n", encoding="utf-8")
    r = installed.tool("drift_check.py", "../../other")
    assert r.returncode == 2 and "test_secret_other" not in r.stdout, r.stdout


def test_M2_06_nested_test_files_warned(installed):
    installed.write("orders/test_o.py", "def test_a():\n    pass\n")
    installed.write("orders/sub/test_x.py", "def test_nested():\n    pass\n")
    installed.coverage("orders", ["| 建立 | `test_o.py::test_a` | ✅ |"])
    r = installed.tool("drift_check.py", "all")
    assert "sub/test_x.py" in r.stdout and "子資料夾" in r.stdout, r.stdout
    from conftest import PLUGIN
    sec = (PLUGIN / "README.md").read_text(encoding="utf-8").split("## 已知限制", 1)[1].split("\n## ", 1)[0]
    assert "子資料夾" in sec


def test_M2_07_linked_test_file_ignored(installed, tmp_path):
    outside = tmp_path / "x_other.py"
    outside.write_text("def test_secret_other():\n    pass\n", encoding="utf-8")
    installed.write("orders/test_o.py", "def test_a():\n    pass\n")
    installed.coverage("orders", ["| 建立 | `test_o.py::test_a` | ✅ |"])
    if not _file_link(installed.e2e / "orders" / "test_link.py", outside):
        pytest.skip("此平台無法建立檔案連結（Windows 需開發人員模式）")
    r = installed.tool("drift_check.py", "all")
    assert "test_secret_other" not in r.stdout, r.stdout


def test_M2_08_linked_coverage_file_ignored(installed, tmp_path):
    outside = tmp_path / "COVERAGE_other.md"
    outside.write_text("| 使用情境（白話） | 測試函式 | 覆蓋 |\n|---|---|---|\n| 別專案機密情境 | `test_o.py::test_a` | ✅ |\n",
                       encoding="utf-8")
    installed.write("orders/test_o.py", "def test_a():\n    pass\n")
    if not _file_link(installed.e2e / "orders" / "COVERAGE.md", outside):
        pytest.skip("此平台無法建立檔案連結（Windows 需開發人員模式）")
    installed.tool("gen_catalog.py")
    cat = installed.e2e / "CATALOG.md"
    assert not cat.exists() or "別專案機密情境" not in cat.read_text(encoding="utf-8")


def test_M2_09_snippet_does_not_exec_project_tools_init(installed):
    from conftest import TEMPLATES
    installed.write("tools/__init__.py", "raise RuntimeError('project tools init must not run')\n")
    installed.write("conftest.py", (TEMPLATES / "conftest_snippet.py").read_text(encoding="utf-8"))
    installed.write("orders/test_o.py", "def test_a():\n    assert True\n")
    r = installed.pytest("orders")
    assert r.returncode == 0, r.stdout + r.stderr
    assert [(n, o) for _b, n, _f, o in installed.sqlite_rows()] == [("orders/test_o.py::test_a", "passed")]


@needs_bash
def test_M2_10_js_project_detection_survives_sigpipe(project):
    d = project.e2e / ("specs_" + "x" * 60)
    d.mkdir(parents=True)
    for i in range(2500):
        (d / ("case_%04d_%s.spec.js" % (i, "y" * 40))).write_text("test('a', () => {});\n", encoding="utf-8")
    project.write("CATALOG.md", LEGACY_HEAD + "| 舊情境 | 舊標題 | ✅完整 | orders |\n")
    for _ in range(3):
        r = project.flow("migrate", "--dry-run")
        assert r.returncode == 2, r.stdout + r.stderr
    assert not (project.e2e / "tools").exists()


@needs_bash
def test_M2_11_run_refuses_linked_reports_dir(installed, tmp_path):
    import shutil
    outside = tmp_path / "outside_reports"
    outside.mkdir()
    installed.write("orders/test_o.py", "def test_a():\n    assert True\n")
    rep = installed.e2e / "reports"
    if rep.exists():
        shutil.rmtree(str(rep))
    if not _dir_link(rep, outside):
        pytest.skip("此平台無法建立目錄連結")
    r = installed.flow("run", "orders", "orders/test_o.py")
    assert r.returncode != 0, r.stdout + r.stderr
    assert list(outside.iterdir()) == []


@needs_bash
def test_M2_12_legacy_audit_accepts_file_qualified_refs(project):
    project.write("cart/test_a.py", "def test_x():\n    pass\n")
    project.write("CATALOG.md", LEGACY_HEAD + "| 加購 | test_a.py::test_x | ✅完整 | cart |\n"
                  + "| 加購2 | `cart/test_a.py::test_x` | ✅完整 | cart |\n")
    r = project.flow("audit")
    assert r.returncode == 0, r.stdout + r.stderr
    r = project.flow("audit", "--fix")
    assert r.returncode == 0 and "❌未覆蓋" not in project.read("CATALOG.md"), project.read("CATALOG.md")


def test_M2_13_runs_db_refuses_linked_runs_dir(tmp_path):
    rdb = _import_tool("runs_db")
    e2e = tmp_path / "e2e"
    e2e.mkdir()
    outside = tmp_path / "outside_runs"
    outside.mkdir()
    if not _dir_link(e2e / ".runs", outside):
        pytest.skip("此平台無法建立目錄連結")
    with pytest.raises(Exception):
        rdb.record_run("r", "2026-09-24T00:00:00.000000+00:00", "b", [("orders/test_o.py::test_a", "passed", 0)],
                       str(e2e / ".runs" / "results.sqlite"))
    assert list(outside.iterdir()) == []


# ---- env_gates ----

def test_M3_01_authorization_bearer_masked():
    eg = _import_tool("env_gates")
    out = eg.mask_command_line('curl -H "Authorization: Bearer SECRETTOKEN123" http://x')
    assert "SECRETTOKEN123" not in out, out


def test_M3_02_short_and_spaced_paths_masked():
    eg = _import_tool("env_gates")
    out = eg.display_owner("/opt/server --flag")
    assert "/opt/server" not in out and "server" in out, out
    out = eg.display_owner('"C:/Users/Some One/Private Proj/wt/app/srv.exe" --x')  # portable-ok: 遮罩測試的輸入字串
    assert "Some One" not in out and "Private Proj" not in out and "wt/app/srv.exe" in out, out
    out = eg.display_owner("/srv/app/x --flag")
    assert "/srv/app" not in out and "x" in out, out


# ---- hardcode_check ----

def test_M3_03_multiline_insert_update_blocked(installed):
    r = scan(installed, 'def test_x(db):\n    db.execute("""INSERT INTO\n        orders (id) VALUES (1)""")\n')
    assert counts(r).get("E") == 1 and r.returncode == 1, r.stdout
    r = scan(installed, 'def test_x(db):\n    db.execute("""UPDATE\n        orders SET x = 1""")\n')
    assert counts(r).get("E") == 1 and r.returncode == 1, r.stdout


def test_M3_04_lowercase_and_short_account_values(installed):
    r = scan(installed, 'def test_x(api):\n    api.login(username="alice")\n')
    assert counts(r).get("F") == 1 and r.returncode == 1, r.stdout
    r = scan(installed, 'def test_x(api):\n    api.login(username="BOB")\n')
    assert counts(r).get("F") == 1 and r.returncode == 1, r.stdout
    r = scan(installed, 'def test_x(api):\n    api.login(username="qa_bot")\n')   # 假身分前綴（對照）
    assert "F" not in counts(r), r.stdout


def test_M3_05_neighbour_statement_binding_does_not_exempt(installed):
    r = scan(installed, 'def test_x(db):\n    row = db.query("SELECT * FROM orders LIMIT 1")\n'
                        '    other = db.query("SELECT * FROM users WHERE id = ?", (1,))\n')
    assert counts(r).get("H") == 1 and r.returncode == 1, r.stdout


def _read_fails(monkeypatch, bad_name):
    import builtins
    real = builtins.open

    def fake(file, *a, **k):
        if str(file).replace("\\", "/").endswith(bad_name):
            raise PermissionError(13, "Permission denied", str(file))
        return real(file, *a, **k)
    monkeypatch.setattr(builtins, "open", fake)


@pytest.mark.parametrize("tool", ["hardcode_check", "i18n_locator_check", "skip_audit"])
def test_M3_06_read_failure_is_error_not_clean(installed, monkeypatch, capsys, tool):
    installed.write("orders/test_ok.py", "def test_a():\n    pass\n")
    installed.write("orders/test_locked.py", 'def test_b(api):\n    api.login(username="ALICE")\n')
    monkeypatch.setenv("QA_E2E_ROOT", str(installed.e2e))
    mod = _import_tool(tool)
    importlib.reload(_import_tool("qa_config"))
    importlib.reload(mod)
    _read_fails(monkeypatch, "test_locked.py")
    rc = mod.main(["all"])
    out = capsys.readouterr().out
    assert rc == 2 and "讀不到" in out, (rc, out)
    rc = mod.main(["all", "--write-baseline", "--why", "x"])
    out = capsys.readouterr().out
    assert rc == 2, (rc, out)
    assert not (installed.e2e / "_reports").exists() or not any((installed.e2e / "_reports").iterdir())


def test_M3_07_output_masks_password_literal(installed):
    r = scan(installed, 'def test_x(api):\n    api.login(username="ALICE", password="S3cretPw!")\n', "orders/test_x.py",
             "--md", "_out/hc.md")
    assert "S3cretPw!" not in r.stdout, r.stdout
    assert "S3cretPw!" not in installed.read("_out/hc.md")


# ---- i18n ----

def test_M3_08_regex_compiled_text_locator(installed):
    installed.write("orders/test_o.py", 'import re\n\ndef test_x(page):\n    page.get_by_text(re.compile("送出")).click()\n')
    r = installed.tool("i18n_locator_check.py", "all")
    assert "定位器（切語系會找不到元素）：1 處" in r.stdout, r.stdout


def test_M3_10_multiline_to_have_text_is_assertion(installed):
    installed.write("orders/test_o.py", 'def test_x(page, expect):\n    expect(page.locator("#msg")).to_have_text(\n'
                                        '        "text=送出"\n    )\n')
    r = installed.tool("i18n_locator_check.py", "all")
    assert "定位器（切語系會找不到元素）：0 處" in r.stdout, r.stdout


def test_M3_11_fingerprint_ignores_paren_inside_string(installed):
    installed.write("orders/test_o.py", 'def test_x(page):\n    page.get_by_text("送出) 舊版").click()\n')
    assert installed.tool("i18n_locator_check.py", "all", "--write-baseline", "--why", "初始").returncode == 0
    installed.write("orders/test_o.py", 'def test_x(page):\n    page.get_by_text("送出) 新版").click()\n')
    r = installed.tool("i18n_locator_check.py", "orders", "--baseline")
    assert r.returncode == 1 and "QA-TOOL-RESULT: violations" in r.stdout, r.stdout


# ---- qa_config ----

def test_M3_12_boolean_port_is_config_error(installed):
    installed.write("orders/test_o.py", "def test_a():\n    pass\n")
    installed.config(ports=[{"label": "前端", "port": True}])
    r = installed.tool("skip_audit.py", "all")
    assert r.returncode == 2 and "ports" in r.stderr + r.stdout, (r.returncode, r.stdout, r.stderr)
    eg = _import_tool("env_gates")
    assert eg.configured_ports({"ports": [{"label": "x", "port": True}]}, {}) == []


def test_M3_13_duplicate_named_groups_is_config_error(installed):
    installed.write("orders/test_o.py", "def test_a():\n    pass\n")
    installed.config(skip_classify={"A": ["(?P<n>foo)", "(?P<n>bar)"]})
    r = installed.tool("skip_audit.py", "all")
    assert r.returncode == 2 and "Traceback" not in r.stderr, (r.returncode, r.stdout, r.stderr)


# ---- qa_pytest_plugin ----

ENV_REQ = [{"fixtures": ["admin_page"], "env": ["QA_ADMIN_URL_FOR_TEST"], "desc": "管理後台"}]
ADMIN_CONFTEST = "import pytest\n\n@pytest.fixture\ndef admin_page():\n    return 1\n"


def test_M3_14_env_check_runs_after_deselection(installed):
    installed.config(env_requirements=ENV_REQ)
    installed.write("orders/conftest.py", ADMIN_CONFTEST)
    installed.write("orders/test_o.py", "import pytest\n\ndef test_a():\n    assert True\n\n"
                                        "@pytest.mark.slow\ndef test_b(admin_page):\n    assert True\n")
    r = installed.pytest("orders", "-k", "test_a")
    assert r.returncode == 0, r.stdout + r.stderr
    r = installed.pytest("orders", "-m", "not slow", "-p", "no:warnings")
    assert r.returncode == 0, r.stdout + r.stderr
    r = installed.pytest("orders")    # 對照：真的會跑到 test_b → 缺環境變數擋
    assert r.returncode != 0 and "QA_ADMIN_URL_FOR_TEST" in r.stdout + r.stderr, r.stdout + r.stderr


def test_M3_15_env_check_ignores_skipped_tests(installed):
    installed.config(env_requirements=ENV_REQ)
    installed.write("orders/conftest.py", ADMIN_CONFTEST)
    installed.write("orders/test_o.py", "import pytest\n\ndef test_a():\n    assert True\n\n"
                                        "@pytest.mark.skip(reason='後台尚未開放')\ndef test_b(admin_page):\n    assert True\n\n"
                                        "@pytest.mark.skipif(True, reason='停用')\ndef test_c(admin_page):\n    assert True\n")
    r = installed.pytest("orders")
    assert r.returncode == 0, r.stdout + r.stderr


# ---- skip_audit ----

def test_M3_16_environment_versions_not_class_a(installed):
    sa = _import_tool("skip_audit")
    qc = _import_tool("qa_config")
    cfg = qc.load(str(installed.e2e))
    assert sa.classify("Windows 10 only", cfg) != "A"
    assert sa.classify("requires python >= 3.10", cfg) != "A"
    assert sa.classify("rows < 3", cfg) == "A"      # 對照：數量描述仍是資料缺席
    assert sa.classify("got 0 rows", cfg) == "A"


def test_M3_17_module_level_skip_is_collection_time(installed):
    installed.write("orders/test_o.py", 'import pytest\n\npytest.skip("no data", allow_module_level=True)\n\n'
                                        'def test_a():\n    pass\n')
    r = installed.tool("skip_audit.py", "orders", "--baseline")
    assert r.returncode == 0 and "[A]" not in r.stdout, r.stdout


# ---- sweep_residue ----

LIMITED_DB = '''import sqlite3, os
class Lim(object):
    def __init__(self):
        self.conn = sqlite3.connect(os.path.join(os.path.dirname(__file__), "demo.sqlite"), isolation_level=None)
    def _chk(self, params):
        if len(params) > 999:
            raise RuntimeError("too many SQL variables")
    def query(self, sql, params=()):
        self._chk(params)
        return self.conn.execute(sql, params).fetchall()
    def execute(self, sql, params=()):
        self._chk(params)
        self.conn.execute(sql, params)
    def begin(self):
        self.conn.execute("BEGIN")
    def commit(self):
        self.conn.execute("COMMIT")
    def rollback(self):
        self.conn.execute("ROLLBACK")
def connect():
    return Lim()
'''


def test_M3_19_many_hits_deleted_in_chunks(installed):
    db = installed.e2e / "demo.sqlite"
    con = sqlite3.connect(str(db))
    con.executescript("CREATE TABLE orders (id INTEGER PRIMARY KEY, title TEXT);"
                      "CREATE TABLE order_items (id INTEGER PRIMARY KEY, order_id INTEGER);")
    con.executemany("INSERT INTO orders VALUES (?, ?)", [(i, "QA_%d" % i) for i in range(1, 1501)])
    con.executemany("INSERT INTO order_items VALUES (?, ?)", [(i, i) for i in range(1, 1501)])
    con.commit()
    con.close()
    installed.write("lim_db.py", LIMITED_DB)
    _sweep_cfg(installed, "QA_")
    installed.config(db={"connector": "lim_db:connect"})
    r = installed.tool("sweep_residue.py", "--apply")
    assert r.returncode == 0, r.stdout[-2000:]
    assert _rows(installed, "orders") == [] and _rows(installed, "order_items") == []


# ---- CR3 ----

def test_CR3_19_no_source_identifier_in_methodology():
    from conftest import PLUGIN
    word = "SUPP" + "LIER"
    hits = [p.relative_to(PLUGIN).as_posix() for p, t in _all_text_files() if word.lower() in t.lower()]
    assert hits == [], hits


def test_M2_07_linked_test_and_coverage_files_logic(installed, tmp_path, monkeypatch):
    """不需要建立連結權限的版本：模擬「orders/test_link.py 與 orders/COVERAGE.md 是連到別處的 symlink」。"""
    cm = _import_tool("coverage_md")
    installed.write("orders/test_o.py", "def test_a():\n    pass\n")
    installed.write("orders/test_link.py", "def test_secret_other():\n    pass\n")
    installed.coverage("orders", ["| 別專案機密情境 | `test_o.py::test_a` | ✅ |"])
    outside = str(tmp_path / "elsewhere")
    real_islink, real_realpath = os.path.islink, os.path.realpath
    linked = {str(installed.e2e / "orders" / "test_link.py"), str(installed.e2e / "orders" / "COVERAGE.md")}

    def islink(p):
        return str(p) in linked or real_islink(p)

    def realpath(p, *a, **k):
        if str(p) in linked:
            return os.path.join(outside, os.path.basename(str(p)))
        return real_realpath(p, *a, **k)
    monkeypatch.setattr(cm.os.path, "islink", islink)
    monkeypatch.setattr(cm.os.path, "realpath", realpath)
    assert cm.test_files("orders", str(installed.e2e)) == ["test_o.py"]
    assert "test_link.py" in cm.unregistrable_test_files("orders", str(installed.e2e))
    assert cm.read_text(str(installed.e2e / "orders" / "COVERAGE.md")) is None


# =====================================================================
# R3 第 4 輪審查意見（CR4-xx＝B 軌；A 軌該輪未回覆）
# =====================================================================

def test_CR4_01_selector_constants_not_accounts(installed):
    r = scan(installed, 'USERNAME_INPUT = "#username"\n\ndef test_x(page):\n    username_input = "#username"\n'
                        '    login_button = "button.submit"\n    account_title = "帳戶設定"\n    page.fill(username_input, "x")\n')
    assert "F" not in counts(r) and r.returncode == 0, r.stdout
    r = scan(installed, 'def test_x(api):\n    default_login = "alice"\n')   # 對照：欄位名以帳號字樣結尾＝帳號值
    assert counts(r).get("F") == 1 and r.returncode == 1, r.stdout


@needs_bash
def test_CR4_02_legacy_audit_with_native_project_dir(project):
    project.write("cart/test_a.py", "def test_x():\n    pass\n")
    project.write("CATALOG.md", LEGACY_HEAD + "| 加購 | `cart/test_a.py::test_x` | ✅完整 | cart |\n")
    r = project.flow("audit", env={"CLAUDE_PROJECT_DIR": str(project.root)})   # Windows 上是反斜線原生路徑
    assert r.returncode == 0, r.stdout + r.stderr


def test_CR4_04_environment_reasons_not_class_a(installed):
    sa = _import_tool("skip_audit")
    qc = _import_tool("qa_config")
    cfg = qc.load(str(installed.e2e))
    for reason in ("no network", "no display", "未設定 QA_ADMIN_URL", "功能未開放"):
        assert sa.classify(reason, cfg) != "A", reason
    assert sa.classify("no data", cfg) == "A"       # 對照
    assert sa.classify("查無訂單", cfg) == "A"


def test_CR4_05_fstring_paren_does_not_truncate_fingerprint(installed):
    installed.write("orders/test_o.py", 'def test_x(page, n):\n    page.get_by_text(f"送出) 舊版{n}").click()\n')
    assert installed.tool("i18n_locator_check.py", "all", "--write-baseline", "--why", "初始").returncode == 0
    installed.write("orders/test_o.py", 'def test_x(page, n):\n    page.get_by_text(f"送出) 新版{n}").click()\n')
    r = installed.tool("i18n_locator_check.py", "orders", "--baseline")
    assert r.returncode == 1 and "QA-TOOL-RESULT: violations" in r.stdout, r.stdout


@needs_bash
def test_CR4_02_legacy_catalog_writer_keeps_backslashes(project):
    project.write("cart/test_a.py", "def test_x():\n    pass\n")
    project.write("CATALOG.md", LEGACY_HEAD)
    scen = "匯出到 C:" + chr(92) + "temp 資料夾"      # 情境文字含反斜線（chr(92)：避免本檔被當成含 Windows 路徑）
    r = project.flow("catalog", scen, "test_x", "完整", "cart")
    assert r.returncode == 0, r.stdout + r.stderr
    assert scen in project.read("CATALOG.md"), project.read("CATALOG.md")


# =====================================================================
# R3 第 5 輪審查意見（CR5-xx＝B 軌）
# =====================================================================

@pytest.mark.parametrize("line", [
    'btn_login = "登入"', 'btn_login = "login-btn"', 'input_username = "input[name=username]"',
    'txt_username = "text=Username"', 'title_login = "登入"', 'BTN_LOGIN = "LOGIN"', 'login_button = "SUBMIT"',
    'login_button_text = "LOGIN"',
])
def test_CR5_01_ui_constants_not_accounts(installed, line):
    r = scan(installed, "def test_x(page):\n    %s\n" % line)
    assert "F" not in counts(r) and r.returncode == 0, r.stdout


@pytest.mark.parametrize("line", ['login_name = "alice"', 'account_name = "bob"', 'owner = "CAROL"',
                                  'api.login(username="dave")'])
def test_CR5_02_account_fields_still_caught(installed, line):
    r = scan(installed, "def test_x(api):\n    %s\n" % line)
    assert counts(r).get("F") == 1 and r.returncode == 1, r.stdout


def test_CR5_03_more_environment_reasons_not_class_a(installed):
    sa = _import_tool("skip_audit")
    qc = _import_tool("qa_config")
    cfg = qc.load(str(installed.e2e))
    for reason in ("未提供 QA_TOKEN", "QA_ADMIN_URL 未提供", "未連線到測試環境", "無網路", "沒有網路", "No DB connection",
                   "no database", "no X server", "no playwright"):
        assert sa.classify(reason, cfg) != "A", reason
    for reason in ("no data", "查無訂單", "訂單數 < 3", "沒有可用的訂單資料"):   # 對照：資料缺席仍是 A
        assert sa.classify(reason, cfg) == "A", reason


@needs_bash
def test_CR5_04_legacy_merge_compares_backslash_literally(project):
    bs = chr(92)
    row = "| 匯出 | x%sty | ✅完整 | cart |\n" % bs      # 函式欄含反斜線（x\ty）
    project.write("CATALOG.md", LEGACY_HEAD + row)
    (project.root / "catalog.md").write_text(LEGACY_HEAD + row, encoding="utf-8")
    project.flow("bootstrap")
    assert project.read("CATALOG.md").count("x%sty" % bs) == 1, project.read("CATALOG.md")


# =====================================================================
# R3 第 6 輪審查意見（CR6-xx＝B 軌）：F 類與 skip 分類改用結構化判準，
# 歷輪審查者提過的正反例全部收進這張矩陣（任何一側回退都會紅）
# =====================================================================

F_POSITIVE = [
    'username = "alice"', 'username = "BOB"', 'login_name = "alice"', 'account_name = "bob"', 'owner = "CAROL"',
    'default_login = "alice"', 'user_id = "u123"', 'username = "王小明"', 'api.login(username="dave")',
    'api.login("ALICE")', 'form_data = {"username": "realadmin", "password": "x"}',
    'page = login(page, username="realadmin")', 'page = login_as(page, "ALICE")',
    'error = client.login(username="realadmin")',
    # row = db.fetch_account("ALICE")：非登入類呼叫的位置參數，字面值分不出是帳號還是狀態值（CR7：create_account(db, "PREMIUM")
    # 同一結構）→ 列入 README 已知限制，不判
]
F_NEGATIVE = [
    'username_input = "#username"', 'login_button = "button.submit"', 'account_title = "帳戶設定"',
    'btn_login = "登入"', 'btn_login = "login-btn"', 'input_username = "input[name=username]"',
    'txt_username = "text=Username"', 'title_login = "登入"', 'BTN_LOGIN = "LOGIN"', 'login_button = "SUBMIT"',
    'login_button_text = "LOGIN"', 'LOGIN_ENDPOINT = "api/login"', 'login_provider = "google"', 'login_method = "sso"',
    'login_redirect = "dashboard"', 'account_plan = "premium"', 'account_currency = "usd"', 'login_locale = "zh-TW"',
    'LOGIN_SUCCESS = "welcome"', 'account_type = "premium"', 'username = "qa_bot"',
]


@pytest.mark.parametrize("line", F_POSITIVE)
def test_CR6_01_account_literals_caught(installed, line):
    r = scan(installed, "def test_x(api, page, client, db):\n    %s\n" % line)
    assert counts(r).get("F") == 1 and r.returncode == 1, r.stdout


@pytest.mark.parametrize("line", F_NEGATIVE)
def test_CR6_01_non_account_constants_not_blocked(installed, line):
    r = scan(installed, "def test_x(page):\n    %s\n" % line)
    assert "F" not in counts(r) and r.returncode == 0, r.stdout


SKIP_A = ["no data", "查無訂單", "訂單數 < 3", "沒有可用的訂單資料", "No DB records found", "no database rows", "no db rows",
          "no database records for this customer", "no api data returned", "未提供訂單資料", "未提供測試訂單", "沒有連線紀錄",
          "TEST_USER 查無", "QA_ADMIN_USER 帳號不存在", "got 0 rows", "rows < 3"]
SKIP_NOT_A = ["no network", "no display", "未設定 QA_ADMIN_URL", "功能未開放", "未提供 QA_TOKEN", "QA_ADMIN_URL 未提供",
              "未連線到測試環境", "無網路", "沒有網路", "No DB connection", "no database", "no X server", "no playwright",
              "Windows 10 only", "requires python >= 3.10"]


def test_CR6_02_skip_classification_matrix(installed):
    sa = _import_tool("skip_audit")
    qc = _import_tool("qa_config")
    cfg = qc.load(str(installed.e2e))
    wrong = [(r, sa.classify(r, cfg)) for r in SKIP_A if sa.classify(r, cfg) != "A"]
    wrong += [(r, "A") for r in SKIP_NOT_A if sa.classify(r, cfg) == "A"]
    assert wrong == [], wrong


# =====================================================================
# R3 第 7 輪審查意見（CR7-xx＝B 軌）：F 類只認「帳號欄位名／登入類呼叫／信箱」三種位置
# =====================================================================

F7_POSITIVE = [
    'LOGIN_USER = "alice"', 'login_user = "alice"', 'account_user = "alice"', 'login_user_name = "alice"',
    'userId = "u123"', 'createdBy = "bob"', 'login_as(page, "alice")', 'api.login("alice")', 'sign_in(page, "ALICE")',
]
F7_NEGATIVE = [
    'create_account(db, "PREMIUM")', 'accounts = list_accounts(api, "ACTIVE")',
    'resp = api.update_account(acc_id, status="CLOSED")', 'account_page.select_option("#plan", "PREMIUM")',
    'login_form.fill("#user", "HELLO")', 'switch_account_tab(page, "BILLING")', 'ACCOUNT_TYPE = "PREMIUM"',
    'LOGIN_PROVIDER = "GOOGLE"', 'LOGIN_METHOD = "OAUTH"', 'account_status = "ACTIVE"',
    'payload = {"account_type": "PREMIUM", "name": "x"}', 'payload = {"accountStatus": "ACTIVE"}',
    'login_title = page.get_by_text("WELCOME")', 'account_title = page.get_by_text("SETTINGS")',
    'bank_account = "checking"', 'social_login = "google"', 'sso_login = "okta"', 'auto_login = "enabled"',
]


@pytest.mark.parametrize("line", F7_POSITIVE)
def test_CR7_01_account_positions_caught(installed, line):
    r = scan(installed, "def test_x(api, page):\n    %s\n" % line)
    assert counts(r).get("F") == 1 and r.returncode == 1, r.stdout


@pytest.mark.parametrize("line", F7_NEGATIVE)
def test_CR7_01_business_values_not_blocked(installed, line):
    r = scan(installed, "def test_x(api, page, db, acc_id, account_page, login_form):\n    %s\n" % line)
    assert "F" not in counts(r) and r.returncode == 0, r.stdout


SKIP7_A = ["No DB user found", "no db users", "no database orders", "no db match", "no database: orders table empty",
           "QA_ADMIN_USER 帳號不存在", "TEST_USER 查無"]
SKIP7_NOT_A = ["no API key", "no API access", "no server", "no backend", "no backend running", "no driver",
               "缺少 QA_ADMIN_USER", "QA_ADMIN_USER missing", "QA_USER not set"]


def test_CR7_02_skip_classification_matrix(installed):
    sa = _import_tool("skip_audit")
    qc = _import_tool("qa_config")
    cfg = qc.load(str(installed.e2e))
    wrong = [(r, sa.classify(r, cfg)) for r in SKIP7_A + SKIP_A if sa.classify(r, cfg) != "A"]
    wrong += [(r, "A") for r in SKIP7_NOT_A + SKIP_NOT_A if sa.classify(r, cfg) == "A"]
    assert wrong == [], wrong


def test_CR7_03_limits_documented():
    from conftest import PLUGIN
    sec = (PLUGIN / "README.md").read_text(encoding="utf-8").split("## 已知限制", 1)[1].split("\n## ", 1)[0]
    assert "fetch_account" in sec and "skip_classify" in sec, sec[-800:]


# =====================================================================
# R3 第 8 輪審查意見（CR8-xx＝B 軌）
# =====================================================================

F8_POSITIVE = [
    'TEST_USER = "alice"', 'ADMIN_USER = "admin01"', 'user_name = "alice"', 'user = "alice"', 'current_user = "alice"',
    'email = "jdoe@acme.local"', 'user_email = "jdoe@acme.local"', 'api.post("/u", json={"email": "jdoe@acme.local"})',
    'login(page, "ALICE", "pw")', 'api.login("alice")',
]
F8_NEGATIVE = [
    'api.login(os.environ["QA_USER"], "S3cretPass!")', 'login(page, USER, "secret")', 'login(page, f"{user}")',
    'login(page, f"{PREFIX}alice")', 'login(page, f"{cfg.user}", pw)', 'verify_login(page, "Dashboard")',
    'wait_for_login(page, "dashboard")', 'assert_login(page, "Welcome back")', 'login(page, "https://staging.example.test")',
    'with_login("admin_state.json")', 'mock_login("token123")', 'account_code = "PREMIUM"',
    'user_agent = "Mozilla/5.0"', 'user_role = "admin"', 'system_user = "svc"',
]


@pytest.mark.parametrize("line", F8_POSITIVE)
def test_CR8_01_account_positions_caught(installed, line):
    r = scan(installed, "import os\n\ndef test_x(api, page):\n    %s\n" % line)
    assert counts(r).get("F") == 1 and r.returncode == 1, r.stdout


@pytest.mark.parametrize("line", F8_NEGATIVE)
def test_CR8_01_non_account_literals_not_blocked(installed, line):
    r = scan(installed, "import os\n\ndef test_x(api, page, cfg, pw, USER, PREFIX, user):\n    %s\n" % line)
    assert "F" not in counts(r) and r.returncode == 0, r.stdout


def test_CR8_02_password_in_login_call_masked(installed):
    r = scan(installed, 'def test_x(page):\n    login(page, "ALICE", "S3cretPass!")\n', "orders/test_x.py", "--md", "_out/hc.md")
    assert counts(r).get("F") == 1, r.stdout
    assert "S3cretPass!" not in r.stdout and "S3cretPass!" not in installed.read("_out/hc.md"), r.stdout


SKIP8_NOT_B = ["order_items is empty", "缺少 order_items 資料", "order_items 為空", "missing order_id", "customer_id missing",
               "order_id 為空"]


def test_CR8_03_lowercase_names_are_not_env_vars(installed):
    sa = _import_tool("skip_audit")
    qc = _import_tool("qa_config")
    cfg = qc.load(str(installed.e2e))
    wrong = [(r, sa.classify(r, cfg)) for r in SKIP8_NOT_B if sa.classify(r, cfg) == "B"]
    assert wrong == [], wrong
    assert sa.classify("order_items is empty", cfg) == "A" and sa.classify("缺少 order_items 資料", cfg) == "A"


# =====================================================================
# R3 第 9 輪審查意見（CR9-xx＝B 軌）
# =====================================================================

F9_POSITIVE = [
    'login(admin_page, "alice")', 'login(self.page, "alice")', 'login(self.driver, "alice")', 'login(page_obj, "alice")',
    'login(browser_context, "alice")', 'login(p, "alice", "pw")', 'login(new_page, "ALICE")',
    'admin_login(page, "alice")', 'user_login(page, "alice")',
]
F9_NEGATIVE = [
    'pymysql.connect(host="127.0.0.1", user="root", password="")', 'psycopg2.connect(user="postgres", dbname="x")',
    'DB_USER = "postgres"', 'db_user = "postgres"', 'support_email = "support@acme.local"',
    'expected_sender_email = "noreply@acme.local"', 'email = "abc"', 'email = "not-an-email"',
    'login(page, USER, "secret")', 'login(page, user, "pw")', 'login(page, cfg.user, "pw")',
]


@pytest.mark.parametrize("line", F9_POSITIVE)
def test_CR9_01_login_first_account_argument_caught(installed, line):
    r = scan(installed, "import os\n\ndef test_x(self, page, admin_page, page_obj, browser_context, p, new_page):\n    %s\n" % line)
    assert counts(r).get("F") == 1 and r.returncode == 1, r.stdout


@pytest.mark.parametrize("line", F9_NEGATIVE)
def test_CR9_02_non_account_settings_not_blocked(installed, line):
    r = scan(installed, "import os, pymysql, psycopg2\n\ndef test_x(page, USER, user, cfg):\n    %s\n" % line)
    assert "F" not in counts(r) and r.returncode == 0, r.stdout


def test_CR9_04_short_password_keys_masked(installed):
    r = scan(installed, 'def test_x(api):\n    api.post("/login", json={"username": "alice", "pass": "S3cretX"})\n')
    assert counts(r).get("F") == 1 and "S3cretX" not in r.stdout, r.stdout


# =====================================================================
# R3 第 10 輪審查意見（CR10-xx＝B 軌）：登入呼叫的帳號只在第 0 個參數，
# 或「第 0 個是 page／driver 類控制代碼」時的第 1 個——再往後一律不看（不得把密碼當帳號）
# =====================================================================

F10_POSITIVE = [
    'login(page, "admin", "admin123")', 'username = "admin"', 'admin_email = "admin@acme.local"',
    'ADMIN_EMAIL = "admin@acme.local"', 'team_lead_email = "lead@acme.local"', 'contact_email = "jane@acme.local"',
]
F10_NEGATIVE = [
    'login(page, customer, "S3cretPw!")', 'login(page, admin, "S3cretPw!")', 'sign_in(page, admin, "S3cretPw!")',
    'login(page, lang, "en")', 'DB_CONFIG = {"host": "localhost", "user": "postgres", "password": "x"}',
    'db_config = dict(host="localhost", user="postgres")', 'DATABASES = {"default": {"USER": "postgres"}}',
    'client = MongoClient(host="db", username="app")', 'r = redis.Redis(host="c", username="app")',
    'url = URL.create("postgresql", username="app", host="db")', 'smtp.login("noreply@acme.local", "S3cretPw!")',
    'ftp.login("anonymous")', 'oauth_login(page, "google")', 'social_login(page, "github")', 'saml_login(page, "azure")',
    'click_login(page, "Sign in")', 'submit_login(page, "Log in")', 'goto_login(page, "en")',
]


@pytest.mark.parametrize("line", F10_POSITIVE)
def test_CR10_01_accounts_caught(installed, line):
    r = scan(installed, "def test_x(page):\n    %s\n" % line)
    assert counts(r).get("F") == 1 and r.returncode == 1, r.stdout


@pytest.mark.parametrize("line", F10_NEGATIVE)
def test_CR10_02_not_accounts(installed, line):
    r = scan(installed, "def test_x(page, customer, admin, lang, smtp, ftp):\n    %s\n" % line)
    assert "F" not in counts(r) and r.returncode == 0 and "S3cretPw!" not in r.stdout, r.stdout


def test_CR10_03_multiline_db_config_not_account(installed):
    r = scan(installed, 'DB_CONFIG = {\n    "host": "localhost",\n    "user": "postgres",\n    "password": "x",\n}\n\n'
                        'def test_x():\n    pass\n', "orders/conftest.py")
    assert "F" not in counts(r) and r.returncode == 0, r.stdout


# =====================================================================
# R3 第 11 輪審查意見（CR11-xx＝B 軌）：連線設定判準只看「自己的設定區塊」與「呼叫名本身」
# =====================================================================

F11_POSITIVE = [
    'creds = {"username": "alice", "pw": "x"}\n    host = os.environ["H"]',
    'client.post("/x", json={"username": "alice"})\n    headers = {"Host": "h"}',
    'page.fill(username="alice")\n    HomePage(driver=driver)',
    'fill(page, username="alice")\n    port = 8080',
    'db.get_user(username="alice")', 'db.create_user(username="alice")', 'user = db.fetch_user(username="alice")',
    'u = db.users.find_one({"username": "alice"})', 'db.query_one("q", username="alice")',
    'pg.create_user(username="alice")', 'db_user = api.get(username="alice")', 'login_url = build_url(username="alice")',
    'url_for("x", username="alice")', 'auth_service.login("alice", "pw")', 'self.auth_service.login("alice", "pw")',
    'LoginService.login("alice", "pw")', 'account_service.sign_in("alice", "pw")', 'proxy.login("alice", "pw")',
    'auto_login(page, "alice")', 'cache_login(page, "alice")', 'login(db, "alice")',
    'x = client.post("/login", json={"note": ":)", "username": "alice"})',
]
F11_NEGATIVE = [
    'conn = psycopg2.connect(\n        host="db",\n        user="postgres",\n    )',
    'engine = create_engine(URL.create("postgresql", username="app", host="db"))',
]


@pytest.mark.parametrize("body", F11_POSITIVE)
def test_CR11_01_accounts_caught(installed, body):
    r = scan(installed, "import os\n\ndef test_x(api, page, client, db, pg, driver, HomePage, self, proxy):\n    %s\n" % body)
    assert counts(r).get("F") == 1 and r.returncode == 1, r.stdout


@pytest.mark.parametrize("body", F11_NEGATIVE)
def test_CR11_02_connection_settings_not_accounts(installed, body):
    r = scan(installed, "import psycopg2\n\ndef test_x(create_engine, URL):\n    %s\n" % body)
    assert "F" not in counts(r) and r.returncode == 0, r.stdout


# =====================================================================
# R3 第 12 輪審查意見（CR12-xx＝B 軌）：拿掉「區塊裡有 host／port 鍵就算連線」判準
# =====================================================================

F12_POSITIVE = [
    'login(driver=driver, username="alice", password="x")', 'LoginPage(driver=self.driver, username="alice")',
    'ApiClient(host="https://stg.example.test", username="alice")', 'make_session(host=BASE_HOST, username="alice")',
    'APIClient(base_url=URL, port=443, user="alice")',
    'api.post("/login", json={"username": "alice"}, headers={"Host": "stg"})',
    'ACCOUNTS = [{"username": "alice"}, {"username": "QA_bob", "port": 1}]', 'users = [{"username": "alice"}, {"host": "h"}]',
    'tenant = {"host": "t1.example.test", "admin": {"username": "alice"}}', 'data = {"username": "alice", "note": "{host: 1}"}',
    'page.goto(f"/x?port=1", username="alice")', 'get_connection_user(username="alice")', 'page.connect_wallet(username="alice")',
]
F12_NEGATIVE = [
    'r = aioredis.from_url("redis://h", username="app")', 'f = ftplib.FTP("h", user="app")',
    'p = KafkaProducer(sasl_plain_username="app")', 'connection_user = "app"', 'config = {"db": {"user": "app"}}',
]


@pytest.mark.parametrize("line", F12_POSITIVE)
def test_CR12_01_sibling_keys_do_not_exempt_accounts(installed, line):
    r = scan(installed, "def test_x(api, page, driver, self, BASE_HOST, URL, LoginPage, ApiClient, APIClient, make_session,"
                        " get_connection_user):\n    %s\n" % line)
    assert counts(r).get("F") == 1 and r.returncode == 1, r.stdout


@pytest.mark.parametrize("line", F12_NEGATIVE)
def test_CR12_02_service_connection_accounts_not_blocked(installed, line):
    r = scan(installed, "import ftplib\n\ndef test_x(aioredis, KafkaProducer):\n    %s\n" % line)
    assert "F" not in counts(r) and r.returncode == 0, r.stdout


# =====================================================================
# R3 第 13 輪 審查 Minor（B 軌）（CR13-xx）：連線呼叫判準再收斂
# =====================================================================

F13_POSITIVE = ['ApiClient.from_url("https://stg.example.test", username="alice")',
                'HttpClient.from_url(BASE, username="alice")', 'get_connection(username="alice")',
                'search_engine(username="alice")']
F13_NEGATIVE = ['r = aioredis.from_url("redis://h", username="app")', 'pool = asyncpg.create_pool(user="postgres")',
                'engine = create_engine(URL.create("postgresql", username="app"))', 'c = sqlite3.connect("x.db")']


@pytest.mark.parametrize("line", F13_POSITIVE)
def test_CR13_01_non_connection_calls_still_checked(installed, line):
    r = scan(installed, "def test_x(ApiClient, HttpClient, BASE, get_connection, search_engine):\n    %s\n" % line)
    assert counts(r).get("F") == 1 and r.returncode == 1, r.stdout


@pytest.mark.parametrize("line", F13_NEGATIVE)
def test_CR13_02_connection_calls_exempt(installed, line):
    r = scan(installed, "import sqlite3\n\ndef test_x(aioredis, asyncpg, create_engine, URL):\n    %s\n" % line)
    assert "F" not in counts(r) and r.returncode == 0, r.stdout


# =====================================================================
# R3 第 14 輪審查意見（N2-xx＝qa-flow/lib/templates/tools1 批、N3-xx＝tools2 批）
# =====================================================================

def test_N2_01_unreadable_baseline_is_scan_error_not_block(installed, monkeypatch, capsys):
    import builtins
    bl = _import_tool("baseline")
    p = installed.write("_reports/drift-baseline.json", '{"fingerprints": []}')
    real = builtins.open

    def fake(file, *a, **k):
        if str(file) == str(p):
            raise PermissionError(13, "Permission denied", str(file))
        return real(file, *a, **k)
    monkeypatch.setattr(builtins, "open", fake)
    with pytest.raises(SystemExit) as ei:
        bl.load_for_gate(str(p))
    out = capsys.readouterr().out
    assert ei.value.code == 2 and "scan-error" in out and "baseline-error" not in out, out


def test_N2_02_bom_test_file_counted(installed):
    p = installed.e2e / "orders" / "test_o.py"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(b"\xef\xbb\xbfdef test_a():\n    pass\n")
    installed.coverage("orders", ["| 建立 | `test_o.py::test_a` | ✅ |"])
    r = installed.tool("drift_check.py", "orders")
    assert r.returncode == 0, r.stdout
    assert installed.tool("gen_catalog.py").returncode == 0


def test_N2_03_bare_continuation_to_deleted_function_is_ghost(installed):
    installed.write("orders/test_a.py", "def test_one():\n    pass\n")
    installed.coverage("orders", ["| 一 | `test_a.py::test_one`、test_removed | ✅ |"])
    r = installed.tool("drift_check.py", "orders")
    assert r.returncode == 1 and "test_a.py::test_removed" in r.stdout, r.stdout


def test_N2_04_two_projects_in_one_process_use_their_own_tools(tmp_path):
    import subprocess
    from conftest import Project
    a, b = Project(tmp_path / "a").install(), Project(tmp_path / "b").install()
    code = ("import importlib.util, sys\n"
            "def load(name, path):\n"
            "    spec = importlib.util.spec_from_file_location(name, path)\n"
            "    m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m); return m\n"
            "c1 = load('c1', sys.argv[1]); c2 = load('c2', sys.argv[2])\n"
            "print(c1._qa_plugin.__file__); print(c2._qa_plugin.__file__)\n")
    r = subprocess.run([sys.executable, "-B", "-c", code, str(a.e2e / "conftest.py"), str(b.e2e / "conftest.py")],
                       capture_output=True, text=True)
    lines = r.stdout.strip().splitlines()
    assert r.returncode == 0 and len(lines) == 2, r.stdout + r.stderr
    assert str(tmp_path / "b") in lines[1], lines


def test_N3_01_multiline_login_call(installed):
    r = scan(installed, 'def test_x(page, password):\n    login(page,\n          "alice",\n          password)\n')
    assert counts(r).get("F") == 1 and r.returncode == 1, r.stdout


def test_N3_02_annotated_account_constant(installed):
    r = scan(installed, 'def test_x():\n    username: str = "alice"\n')
    assert counts(r).get("F") == 1 and r.returncode == 1, r.stdout


def test_N3_03_long_line_secret_masked_before_truncation(installed):
    line = '    result = api.login(username="ALICE", note="' + "n" * 30 + '", password="S3cretPw_' + "z" * 40 + '")'
    r = scan(installed, "def test_x(api):\n%s\n" % line, "orders/test_x.py", "--md", "_out/hc.md")
    assert counts(r).get("F") == 1, r.stdout
    assert "S3cretPw_" not in r.stdout and "S3cretPw_" not in installed.read("_out/hc.md"), r.stdout


def test_N3_04_i18n_listing_masks_filled_values(installed):
    installed.write("orders/test_o.py", 'def test_x(page):\n    page.get_by_label("密碼").fill("RealPass123")\n')
    r = installed.tool("i18n_locator_check.py", "all", "--list")
    assert "定位器（切語系會找不到元素）：1 處" in r.stdout and "RealPass123" not in r.stdout, r.stdout


@pytest.mark.parametrize("tool", ["hardcode_check", "i18n_locator_check", "skip_audit"])
def test_N3_05_unreadable_subdir_is_scan_error(installed, monkeypatch, capsys, tool):
    installed.write("orders/test_ok.py", "def test_a():\n    pass\n")
    installed.write("locked/test_b.py", "def test_b():\n    pass\n")
    monkeypatch.setenv("QA_E2E_ROOT", str(installed.e2e))
    mod = _import_tool(tool)
    importlib.reload(_import_tool("qa_config"))
    importlib.reload(mod)
    real = os.scandir
    locked = os.path.normcase(str(installed.e2e / "locked"))

    def fake(path="."):
        if os.path.normcase(os.fspath(path)) == locked:
            raise PermissionError(13, "Permission denied", os.fspath(path))
        return real(path)
    monkeypatch.setattr(os, "scandir", fake)
    rc = mod.main(["all"])
    out = capsys.readouterr().out
    assert rc == 2 and "讀不到" in out, (rc, out)


# =====================================================================
# R3 第 15 輪審查意見（P2-xx＝qa-flow/lib/templates/tools1 批、P3-xx＝tools2 批）
# =====================================================================

def test_P2_01_unstatable_baseline_is_scan_error(installed, monkeypatch, capsys):
    bl = _import_tool("baseline")
    p = str(installed.e2e / "_reports" / "locked" / "drift-baseline.json")
    real_stat = os.stat

    def fake_stat(path, *a, **k):
        if os.path.normcase(os.fspath(path)) == os.path.normcase(p):
            raise PermissionError(13, "Permission denied", os.fspath(path))
        return real_stat(path, *a, **k)
    monkeypatch.setattr(bl.os, "stat", fake_stat)
    monkeypatch.setattr(bl.os.path, "exists", lambda x: False if os.path.normcase(str(x)) == os.path.normcase(p) else os.path.lexists(x))
    with pytest.raises(SystemExit) as ei:
        bl.load_for_gate(p)
    out = capsys.readouterr().out
    assert ei.value.code == 2 and "scan-error" in out, out


def test_P2_02_bare_continuation_binds_to_previous_file(installed):
    installed.write("orders/test_a.py", "def test_x():\n    pass\n")
    installed.write("orders/test_b.py", "def test_y():\n    pass\n")
    installed.coverage("orders", ["| 一 | `test_a.py::test_x`、test_y | ✅ |"])
    r = installed.tool("drift_check.py", "orders")
    assert r.returncode == 1 and "test_a.py::test_y" in r.stdout and "test_b.py::test_y" in r.stdout, r.stdout


def test_P2_03_migrate_refuses_linked_legacy_catalog(installed, monkeypatch, capsys):
    installed.write("orders/test_o.py", "def test_a():\n    pass\n")
    _legacy(installed, ["| 別專案機密情境 | test_a | ✅完整 | orders |\n"])
    monkeypatch.setenv("QA_E2E_ROOT", str(installed.e2e))
    importlib.reload(_import_tool("qa_config"))
    cm = importlib.reload(_import_tool("coverage_md"))
    mc = importlib.reload(_import_tool("migrate_catalog"))
    legacy = os.path.normcase(str(installed.e2e / "catalog.md"))
    real_islink, real_realpath = os.path.islink, os.path.realpath
    monkeypatch.setattr(cm.os.path, "islink", lambda x: os.path.normcase(str(x)) == legacy or real_islink(x))
    monkeypatch.setattr(cm.os.path, "realpath", lambda x, *a, **k: (str(installed.root.parent / "elsewhere" / "catalog.md")
                                                                  if os.path.normcase(str(x)) == legacy else real_realpath(x, *a, **k)))
    rc = mc.main([])
    out = capsys.readouterr().out
    assert rc == 2, out
    assert not (installed.e2e / "orders" / "COVERAGE.md").exists()


@needs_bash
def test_P2_04_migrate_preflights_linked_tools_dir(project, tmp_path):
    project.write("orders/test_o.py", "def test_a():\n    pass\n")
    project.write("CATALOG.md", LEGACY_HEAD + "| 建立 | test_a | ✅完整 | orders |\n")
    outside = tmp_path / "outside_tools_p204"
    outside.mkdir()
    if not _dir_link(project.e2e / "tools", outside):
        pytest.skip("此平台無法建立目錄連結")
    r = project.flow("migrate")
    assert r.returncode != 0, r.stdout + r.stderr
    assert "qa-flow.sh catalog 回填" in project.read("CATALOG.md")      # 舊 catalog 沒被改名／改寫
    assert not (project.e2e / "orders" / "COVERAGE.md").exists()
    assert list(outside.iterdir()) == []


def test_P3_01_login_with_account_attribute_does_not_flag_password(installed):
    r = scan(installed, 'def test_x(self):\n    login(self.username, "S3cretPw!")\n')
    assert "F" not in counts(r) and "S3cretPw!" not in r.stdout, r.stdout


def test_P3_02_escaped_quote_passwords_masked(installed):
    body = ('def test_x(api, page):\n    api.login(username="ALICE", password="ab\\"S3cretTail")\n'
            '    login(page, "BOB", "x\\"S3cretTail2")\n')
    r = scan(installed, body, "orders/test_x.py", "--md", "_out/hc.md")
    assert counts(r).get("F") == 2, r.stdout
    out = r.stdout + installed.read("_out/hc.md")
    assert "S3cretTail" not in out, out


def test_P3_03_multiline_sql_limit_line(installed):
    body = ('def test_x(db):\n    row = db.query(\n        "SELECT id "\n        "FROM orders "\n        "WHERE x = 1 "\n'
            '        "ORDER BY id "\n        "LIMIT 1")\n')
    r = scan(installed, body)
    assert counts(r).get("H") == 1 and r.returncode == 1, r.stdout


def test_P3_04_i18n_listing_masks_second_fill_argument(installed):
    installed.write("orders/test_o.py", 'def test_x(page):\n    page.fill("text=密碼", "RealPass123")\n')
    r = installed.tool("i18n_locator_check.py", "all", "--list")
    assert "定位器（切語系會找不到元素）：1 處" in r.stdout and "RealPass123" not in r.stdout, r.stdout


def test_P3_05_powershell_output_encoding_fixed():
    eg = _import_tool("env_gates")
    import inspect
    assert "OutputEncoding" in inspect.getsource(eg.owners_of)


def test_P3_06_port_guard_fail_open_note_is_shown(installed):
    installed.config(ports=[])
    installed.write("orders/test_o.py", "def test_a():\n    assert True\n")
    r = installed.pytest("orders", env={"QA_EXPECT_WORKTREE": "wt"})
    assert r.returncode == 0 and "port-guard" in r.stdout, r.stdout


def test_P3_07_summary_does_not_print_absolute_db_path(installed):
    installed.write("orders/test_o.py", "def test_a():\n    assert True\n")
    r = installed.pytest("orders")
    line = [ln for ln in r.stdout.splitlines() if "recorded" in ln]
    assert line and str(installed.e2e) not in line[0] and ".runs" in line[0], line


def test_P3_08_not_provided_only_for_settings(installed):
    sa = _import_tool("skip_audit")
    qc = _import_tool("qa_config")
    cfg = qc.load(str(installed.e2e))
    assert sa.classify("Test data not provided", cfg) == "A"
    assert sa.classify("QA_TOKEN not provided", cfg) != "A"


def test_P3_09_allow_module_level_inside_function_still_runtime(installed):
    installed.write("orders/test_o.py", 'import pytest\n\ndef test_a():\n    pytest.skip("no data", allow_module_level=True)\n')
    r = installed.tool("skip_audit.py", "orders", "--baseline")
    assert r.returncode == 1 and "[A]" in r.stdout, r.stdout


# =====================================================================
# R3 第 16 輪審查意見（Q2-xx＝qa-flow/lib/templates/tools1 批、Q3-xx＝tools2 批）
# =====================================================================

def test_Q2_01_scenario_table_ref_not_exempted_by_other_folder(installed):
    installed.write("orders/test_o.py", "def test_a():\n    pass\n")
    installed.write("billing/test_x.py", "def test_y():\n    pass\n")
    installed.coverage("billing", ["| 帳務 | `test_x.py::test_y` | ✅ |"])
    installed.coverage("orders", ["| 建立 | `test_o.py::test_a` | ✅ |", "| 已刪 | `test_x.py::test_y` | ✅ |"])
    r = installed.tool("drift_check.py", "orders")
    assert r.returncode == 1 and "ghost" in r.stdout and "test_x.py::test_y" in r.stdout, r.stdout


def test_Q2_02_register_updates_bare_name_row(installed):
    installed.write("orders/test_o.py", "def test_a():\n    pass\n")
    installed.coverage("orders", ["| 建立 | test_a | ⚠️ |"])
    assert installed.tool("drift_check.py", "orders").returncode == 0
    r = installed.tool("coverage_register.py", "建立", "test_o.py::test_a", "完整", "orders")
    assert r.returncode == 0, r.stdout
    cov = installed.read("orders/COVERAGE.md")
    assert cov.count("test_a") == 1 and "✅" in cov, cov


def test_Q3_01_subscript_account_assignment(installed):
    r = scan(installed, 'def test_x(payload):\n    payload["username"] = "alice"\n')
    assert counts(r).get("F") == 1 and r.returncode == 1, r.stdout


def test_Q3_02_reversed_comparison_is_reference_class(installed):
    r = scan(installed, 'def test_x(user):\n    if "alice" == user.username:\n        pass\n')
    assert counts(r).get("F'") == 1 and "F" not in counts(r) and r.returncode == 0, r.stdout


def test_Q3_03_every_statement_on_line_checked(installed):
    r = scan(installed, 'def test_x(db):\n    db.executescript("INSERT INTO users VALUES (1); INSERT INTO orders VALUES (2)")\n')
    assert counts(r).get("E") == 1 and r.returncode == 1, r.stdout


def test_Q3_04_adjacent_string_concatenation_insert(installed):
    r = scan(installed, 'def test_x(db):\n    db.execute("INSERT INTO "\n               "orders (id) VALUES (1)")\n')
    assert counts(r).get("E") == 1 and r.returncode == 1, r.stdout


def test_Q3_05_multiline_login_password_masked(installed):
    r = scan(installed, 'def test_x(page):\n    login(page,\n          "alice", "S3cretPwML")\n', "orders/test_x.py", "--md", "_out/hc.md")
    assert counts(r).get("F") == 1, r.stdout
    assert "S3cretPwML" not in r.stdout + installed.read("_out/hc.md"), r.stdout


def test_Q3_06_sql_values_password_masked(installed):
    r = scan(installed, 'def test_x(db):\n    db.execute("INSERT INTO orders (username, password) VALUES (\'alice\', \'S3cretSql\')")\n',
             "orders/test_x.py", "--md", "_out/hc.md")
    assert counts(r).get("E") == 1, r.stdout
    assert "S3cretSql" not in r.stdout + installed.read("_out/hc.md"), r.stdout


def test_Q3_07_config_messages_do_not_print_absolute_path(installed):
    installed.write("orders/test_o.py", "def test_a():\n    pass\n")
    cfgp = installed.e2e / "qa-webwright.json"
    cfgp.unlink()
    r = installed.tool("hardcode_check.py", "all")
    assert str(installed.e2e) not in r.stdout + r.stderr, r.stdout + r.stderr
    cfgp.write_text("{ broken", encoding="utf-8")
    r = installed.tool("hardcode_check.py", "all")
    assert r.returncode == 2 and str(installed.e2e) not in r.stdout + r.stderr, r.stdout + r.stderr


def test_Q3_08_state_reset_between_sessions_in_one_process(installed):
    import subprocess
    installed.write("orders/test_o.py", "def test_a():\n    assert True\n")
    runs = installed.e2e / ".runs"
    runs.mkdir(exist_ok=True)
    (runs / "results.sqlite").mkdir()          # 第一輪記錄必失敗（是個資料夾）
    code = ("import shutil, sys, pytest, os\n"
            "pytest.main(['-q', '-p', 'no:cacheprovider', 'orders'])\n"
            "shutil.rmtree(os.path.join('.runs', 'results.sqlite'))\n"
            "print('=====SECOND=====', flush=True)\n"
            "pytest.main(['-q', '-p', 'no:cacheprovider', 'orders'])\n")
    r = subprocess.run([sys.executable, "-B", "-c", code], cwd=str(installed.e2e), capture_output=True, text=True,
                       encoding="utf-8", errors="replace")
    first, _, second = r.stdout.partition("=====SECOND=====")
    assert "recording FAILED" in first, r.stdout
    assert "recording FAILED" not in second and "recorded 1 result" in second, second


# =====================================================================
# R3 第 18 輪 審查 Minor（B 軌）（CR18-xx）
# =====================================================================

def test_CR18_01_values_mask_handles_function_calls(installed):
    r = scan(installed, 'def test_x(db):\n    db.execute("INSERT INTO orders (a, password) VALUES (NOW(), \'S3cretFn\')")\n',
             "orders/test_x.py", "--md", "_out/hc.md")
    assert counts(r).get("E") == 1, r.stdout
    assert "S3cretFn" not in r.stdout + installed.read("_out/hc.md"), r.stdout


def test_CR18_02_docstring_login_does_not_overmask(installed):
    r = scan(installed, 'def test_x(api):\n    """見 login( 的說明"""\n    user = "alice"\n')
    assert counts(r).get("F") == 1 and 'user = "alice"' in r.stdout, r.stdout


def test_CR18_08_not_available_with_data_noun_is_class_a(installed):
    sa = _import_tool("skip_audit")
    qc = _import_tool("qa_config")
    cfg = qc.load(str(installed.e2e))
    assert sa.classify("orders not available", cfg) == "A"
    assert sa.classify("item unavailable", cfg) == "A"
    assert sa.classify("service not available", cfg) == "B"     # 對照：環境


def test_CR18_09_duplicate_mount_warning_does_not_raise(installed, tmp_path):
    import subprocess
    from conftest import Project
    b = Project(tmp_path / "b2").install()
    code = ("import importlib.util, sys, warnings\n"
            "warnings.simplefilter('error')\n"
            "def load(name, path):\n"
            "    spec = importlib.util.spec_from_file_location(name, path)\n"
            "    m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m); return m\n"
            "c1 = load('c1', sys.argv[1]); c2 = load('c2', sys.argv[2])\n"
            "class FM(object):\n"
            "    def get_plugin(self, name): return c1._qa_plugin\n"
            "    def register(self, p, name): pass\n"
            "c2.pytest_plugin_registered(plugin=None, manager=FM())\n"
            "print('OK')\n")
    r = subprocess.run([sys.executable, "-B", "-c", code, str(installed.e2e / "conftest.py"), str(b.e2e / "conftest.py")],
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    assert r.returncode == 0 and "OK" in r.stdout, r.stdout + r.stderr
    assert "qa-webwright" in r.stderr, r.stderr      # 仍要明講（印到 stderr）


# ---- 預審 S1-07：落點基準註解與實作、寫入端 qa-flow.sh 同源（CLAUDE_PROJECT_DIR 優先，input.cwd 只是備援）----
def test_S1_07_landing_base_comment_matches_code_and_writer():
    import re as _re
    hooks = os.path.join(os.path.dirname(os.path.dirname(str(SKILL))), "hooks")
    flow = open(os.path.join(str(SKILL), "qa-flow.sh"), encoding="utf-8").read()
    assert 'WORKSPACE_DIR="${CLAUDE_PROJECT_DIR:-$PWD}"' in flow
    for name in ("qa-landing-gate.js", "project-knowledge-gate.js", "qa-early-nudge.js"):
        src = open(os.path.join(hooks, name), encoding="utf-8").read()
        assert "const cwd = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();" in src, name
        # 註解不得宣稱與實作相反的優先序
        assert not _re.search(r"input\.cwd\s*為首選", src), name


# ---- 預審 S2（qa-flow.sh／tools 第一組）----
@needs_bash
def test_S2_01_gate_listing_error_does_not_abort_scaffold(project):
    project.e2e.mkdir(parents=True, exist_ok=True)
    (project.e2e / "qa-webwright.json").write_text(
        json.dumps({"report_hygiene": {"roots": [1, 2]}}), encoding="utf-8")
    r = project.flow("scaffold", "orders", "pytest")
    assert r.returncode == 0, r.stdout + r.stderr
    assert "Traceback" not in r.stdout + r.stderr, r.stdout + r.stderr
    assert "NEXT:" in r.stdout, r.stdout + r.stderr          # 閘清單之後的流程照常走完
    assert "report_hygiene.roots" in r.stdout + r.stderr       # 型別錯誤由參數檔驗證明講


@needs_bash
def test_S2_02_excluded_names_case_insensitive(project):
    cm = _import_tool("coverage_md")
    assert cm.excluded_name("Tools") and cm.excluded_name("REPORTS") and cm.excluded_name("Helpers")
    assert not cm.excluded_name("orders")
    r = project.flow("scaffold", "Tools", "pytest")
    assert r.returncode == 1, r.stdout + r.stderr


def test_S2_03_register_keeps_extra_columns(installed):
    installed.write("orders/test_o.py", "def test_a():\n    pass\n\n\ndef test_b():\n    pass\n")
    installed.write("orders/COVERAGE.md",
                    "# orders\n\n| 使用情境（白話） | 測試函式 | 覆蓋 | 備註 |\n|---|---|---|---|\n"
                    "| 建立訂單 | `test_o.py::test_a` | ⚠️ | 缺讀回 |\n")
    r = installed.tool("coverage_register.py", "建立訂單", "test_o.py::test_a", "完整", "orders")
    assert r.returncode == 0, r.stdout + r.stderr
    r = installed.tool("coverage_register.py", "取消訂單", "test_o.py::test_b", "完整", "orders")
    assert r.returncode == 0, r.stdout + r.stderr
    text = installed.read("orders/COVERAGE.md")
    assert "| 建立訂單 | `test_o.py::test_a` | ✅ | 缺讀回 |" in text, text
    rows = [l for l in text.splitlines() if "test_b" in l]
    assert rows and rows[0].count("|") == 5, text     # 新列補齊四欄


def test_S2_04_fstring_def_is_not_a_test_function(installed):
    cm = _import_tool("coverage_md")
    src = 'X = 1\nTEMPLATE = f"""\ndef test_fake():\n    pass {X}\n"""\n\n\ndef test_real():\n    pass\n'
    masked = cm.code_without_strings(src)
    assert "test_fake" not in masked and "test_real" in masked, masked


@needs_bash
def test_S2_05_scaffold_survives_non_utf8_stdout_encoding(project):
    r = project.flow("scaffold", "orders", "pytest", env={"PYTHONIOENCODING": "cp1252"})
    assert "Traceback" not in r.stdout + r.stderr, r.stdout + r.stderr
    assert r.returncode == 0, r.stdout + r.stderr
    assert (project.e2e / "orders" / "COVERAGE.md").exists(), r.stdout + r.stderr


def test_S2_06_placeholder_rows_follow_header_width(installed):
    cfg = json.loads((installed.e2e / "qa-webwright.json").read_text(encoding="utf-8"))
    cov = dict(cfg.get("coverage") or {})
    cov["header"] = ["使用情境（白話）", "測試函式", "覆蓋", "備註"]
    installed.config(coverage=cov)
    # fill_orphans：既有四欄表補佔位列
    installed.write("orders/test_o.py", "def test_a():\n    pass\n\n\ndef test_b():\n    pass\n")
    installed.write("orders/COVERAGE.md",
                    "# orders\n\n| 使用情境（白話） | 測試函式 | 覆蓋 | 備註 |\n|---|---|---|---|\n"
                    "| 建立訂單 | `test_o.py::test_a` | ✅ | 無 |\n")
    r = installed.tool("fill_orphans.py", "orders")
    assert r.returncode == 0, r.stdout + r.stderr
    rows = [l for l in installed.read("orders/COVERAGE.md").splitlines() if "test_b" in l]
    assert rows and rows[0].count("|") == 5, rows
    # 沒有 COVERAGE 的資料夾：骨架的佔位列同樣四欄
    installed.write("carts/test_c.py", "def test_c():\n    pass\n")
    r = installed.tool("fill_orphans.py", "carts")
    assert r.returncode == 0, r.stdout + r.stderr
    rows = [l for l in installed.read("carts/COVERAGE.md").splitlines() if "test_c" in l]
    assert rows and rows[0].count("|") == 5, rows


def test_S2_07_migrate_rows_follow_header_width(installed):
    cfg = json.loads((installed.e2e / "qa-webwright.json").read_text(encoding="utf-8"))
    cov = dict(cfg.get("coverage") or {})
    cov["header"] = ["使用情境（白話）", "測試函式", "覆蓋", "備註"]
    installed.config(coverage=cov)
    installed.write("orders/test_o.py", "def test_a():\n    pass\n")
    installed.write("orders/COVERAGE.md",
                    "# orders\n\n| 使用情境（白話） | 測試函式 | 覆蓋 | 備註 |\n|---|---|---|---|\n")
    _legacy(installed, ["| 管理員建立訂單 | test_a | ✅完整 | orders |\n"])
    r = installed.tool("migrate_catalog.py")
    assert r.returncode == 0, r.stdout + r.stderr
    rows = [l for l in installed.read("orders/COVERAGE.md").splitlines() if "test_a" in l]
    assert rows and rows[0].count("|") == 5, rows


# ---- 預審 S3（tools 第二組）----
def test_S3_01_values_params_tuple_masked(installed):
    r = scan(installed, 'def test_x(db):\n    db.execute("INSERT INTO orders (title, api_token) VALUES (%s, %s)", '
                        '("E2E-1", "tok_live_abc123"))\n', "orders/test_x.py", "--md", "_out/hc.md")
    assert counts(r).get("E") == 1, r.stdout
    assert "tok_live_abc123" not in r.stdout + installed.read("_out/hc.md"), r.stdout
    # 多行三引號 SQL 的續行：VALUES 在字串裡、參數 tuple 在字串外
    r = scan(installed, 'def test_x(db):\n    db.execute("""INSERT INTO orders (title, api_token)\n'
                        '        VALUES (?, ?)""", ("E2E-2", "tok_live_zzz999"))\n', "orders/test_x.py", "--md", "_out/hc.md")
    assert "tok_live_zzz999" not in r.stdout + installed.read("_out/hc.md"), r.stdout


@pytest.mark.parametrize("reason", ["沒資料", "查不到訂單", "資料不夠", "訂單數量不夠", "Not enough data",
                                    "cannot find order", "Could not find an order to edit", "Need at least 2 orders"])
def test_S3_02_common_data_absence_phrases_are_a(installed, reason):
    sa = _import_tool("skip_audit")
    qc = _import_tool("qa_config")
    assert sa.classify(reason, qc.load(str(installed.e2e))) == "A", reason


@pytest.mark.parametrize("reason,cls", [("No test data in this environment", "A"),
                                        ("No orders in staging environment", "A"),
                                        ("test user does not exist in this environment", "A"),
                                        ("environment not ready", "B"),
                                        ("test environment unavailable", "B")])
def test_S3_03_environment_word_does_not_override_data_absence(installed, reason, cls):
    sa = _import_tool("skip_audit")
    qc = _import_tool("qa_config")
    assert sa.classify(reason, qc.load(str(installed.e2e))) == cls, reason


@pytest.mark.parametrize("reason", ["帳號被其他測試佔用", "訂單已送出", "user already exists"])
def test_S3_04_shared_state_phrases_are_d(installed, reason):
    sa = _import_tool("skip_audit")
    qc = _import_tool("qa_config")
    assert sa.classify(reason, qc.load(str(installed.e2e))) == "D", reason


def test_S3_05_role_login_is_not_hardcoded_account(installed):
    body = ("import pytest\n\n\n@pytest.fixture\ndef admin_page(browser):\n    return login_as(browser, \"admin\")\n\n\n"
            "def test_view(page):\n    login_as(page, \"viewer\")\n    login(page, \"manager\")\n")
    r = scan(installed, body)
    assert "F" not in counts(r), r.stdout
    # 對照：帶了密碼字面值＝寫死的帳密，照擋
    r = scan(installed, 'def test_x(page):\n    login_as(page, "admin", "admin123")\n')
    assert counts(r).get("F") == 1, r.stdout


def test_S3_06_relative_command_line_uses_cwd_or_fails_open(monkeypatch):
    eg = _import_tool("env_gates")
    ok, lines = eg.port_guard_check(expect="feat-a", cfg={"ports": [{"label": "be", "port": 8000}]}, env={},
                                    owner_fn=lambda p: ["python manage.py runserver 8000"])
    assert ok is True and any("無法確認" in ln for ln in lines), lines

    class R(object):
        def __init__(self, out, rc=0):
            self.stdout, self.returncode, self.stderr = out, rc, ""

    def fake(args, **k):
        if args[:2] == ["lsof", "-nP"]:
            return R("4242\n")
        if args[0] == "ps":
            return R("python manage.py runserver 8000\n")
        if args[0] == "lsof" and "cwd" in args:
            return R("p4242\nfcwd\nn" + cwd[0] + "\n")
        return R("", 1)
    monkeypatch.setattr(eg.subprocess, "run", fake)
    cwd = ["/Users/a/wt/feat-a"]
    ok, lines = eg.port_guard_check(expect="feat-a", cfg={"ports": [{"label": "be", "port": 8000}]}, env={}, backend="lsof")
    assert ok is True, lines
    cwd[0] = "/Users/a/wt/feat-b"
    ok, lines = eg.port_guard_check(expect="feat-a", cfg={"ports": [{"label": "be", "port": 8000}]}, env={}, backend="lsof")
    assert ok is False, lines


def test_S3_07_display_owner_hides_user_home_name():
    eg = _import_tool("env_gates")
    for cmd, name in (("node /Users/alice/other/server.js", "alice"),
                      ("C:\\Users\\Alice Chen\\wt\\feat\\a.exe", "Alice"),  # portable-ok: 比對用的命令列字串，非執行路徑
                      ("node /home/bob/x/y/z.js", "bob")):
        assert name not in eg.display_owner(cmd), eg.display_owner(cmd)


def test_S3_08_more_secret_args_masked_and_header_quote_kept():
    eg = _import_tool("env_gates")
    for cmd, secret in (("python manage.py runserver --pass hunter2", "hunter2"),
                        ("app --private-key=abcd1234", "abcd1234"),
                        ("app --session-key xyz789", "xyz789")):
        assert secret not in eg.display_owner(cmd), eg.display_owner(cmd)
    out = eg.display_owner('curl -H "X-Api-Key: abc123"')
    assert "abc123" not in out and out.endswith('"'), out


def test_S3_11_url_env_problems_are_reported(installed):
    eg = _import_tool("env_gates")
    assert eg.configured_ports({"ports": [{"label": "be", "url_env": "U"}]}, {"U": "localhost:8000"}) == [("be", 8000)]
    ok, lines = eg.port_guard_check(expect="feat-a", cfg={"ports": [{"label": "be", "url_env": "U"},
                                                                    {"label": "fe", "port": 5173}]},
                                    env={}, owner_fn=lambda p: ["/w/feat-a/node server.js"])
    assert ok is True and any("U" in ln and "be" in ln for ln in lines), lines


def test_S3_12_epoch_created_column_respects_age(installed):
    import time
    con = sqlite3.connect(str(installed.e2e / "demo.sqlite"))
    now = int(time.time())
    con.executescript("CREATE TABLE orders (id INTEGER PRIMARY KEY, title TEXT, created_at INTEGER);"
                      "CREATE TABLE order_items (id INTEGER PRIMARY KEY, order_id INTEGER, sku TEXT);")
    con.execute("INSERT INTO orders VALUES (1, 'QA_new', ?)", (now,))
    con.execute("INSERT INTO orders VALUES (2, 'QA_old', ?)", (now - 30 * 86400,))
    con.commit()
    con.close()
    _sweep_cfg(installed, "QA_")
    r = installed.tool("sweep_residue.py", "--older-than-days", "7", "--apply")
    assert _rows(installed, "orders") == [1], r.stdout + r.stderr


def test_S3_13_missing_sqlite_file_is_an_error(installed):
    installed.config(test_data_prefix="QA_", db={"connector": "sqlite:.runs/nope.sqlite"},
                     residue={"targets": [{"table": "orders", "marker_column": "title", "pk_column": "id"}]})
    r = installed.tool("sweep_residue.py")
    assert r.returncode != 0 and "Traceback" not in r.stderr, r.stdout + r.stderr
    assert "nope.sqlite" in r.stdout + r.stderr
    assert not (installed.e2e / ".runs" / "nope.sqlite").exists()


def test_S3_14_login_secret_spans_stay_inside_the_call():
    hc = _import_tool("hardcode_check")
    text = 'login_as(page, "viewer")\nx = 1\nlogin_as(page, "alice")\n'
    assert hc.login_call_secret_spans(text) == [], hc.login_call_secret_spans(text)
    assert hc.login_call_secret_spans('login(page, "alice", "pw")') != []


def test_S3_15_self_seed_fallback_only_covers_its_own_query(installed):
    body = ("def test_pick(db):\n"
            "    row = db.execute(\"SELECT id FROM orders ORDER BY id LIMIT 1\").fetchone()\n"
            "    if row is None:\n"
            "        row = create_order(db)\n"
            "    other = db.execute(\"SELECT id FROM orders ORDER BY id DESC LIMIT 1\").fetchone()\n"
            "    assert other\n")
    r = scan(installed, body)
    assert counts(r).get("H") == 1 and "DESC LIMIT 1" in r.stdout, r.stdout


def test_S3_16_runtime_xfail_with_data_absence_reason_fails_the_run(installed):
    installed.write("orders/test_x.py", "import pytest\n\n\ndef test_a():\n    pytest.xfail(\"沒資料\")\n")
    r = installed.pytest("orders")
    assert r.returncode != 0, r.stdout + r.stderr
    installed.write("orders/test_x.py", "import pytest\n\n\ndef test_a():\n    pytest.xfail(\"known bug #12\")\n")
    r = installed.pytest("orders")
    assert r.returncode == 0, r.stdout + r.stderr


# ---- R3 第 19 輪審查（B 軌，CR19-xx）----
@pytest.mark.parametrize("reason,cls", [("cannot find chromedriver", "?"), ("Could not find browser executable", "?"),
                                        ("unable to find Chrome binary", "?"), ("記憶體不夠", "?"), ("權限不夠", "B"),
                                        ("need at least 2 CPUs", "?"), ("not enough memory", "?"),
                                        # 對照：資料缺席照樣是 A
                                        ("cannot find order", "A"), ("Could not find an order to edit", "A"),
                                        ("資料不夠", "A"), ("訂單數量不夠", "A"), ("Need at least 2 orders", "A"),
                                        ("Not enough data", "A")])
def test_CR19_02_find_and_not_enough_need_a_data_noun(installed, reason, cls):
    sa = _import_tool("skip_audit")
    qc = _import_tool("qa_config")
    got = sa.classify(reason, qc.load(str(installed.e2e)))
    if cls == "?":
        assert got != "A", (reason, got)          # 環境缺件不得被當成資料缺席（A 會讓整輪失敗）
    else:
        assert got == cls, (reason, got)


def test_CR19_03_upfront_seed_covers_following_queries(installed):
    body = ("def test_pick(db):\n"
            "    create_order(db)\n"
            "    a = db.execute(\"SELECT id FROM orders ORDER BY id LIMIT 1\").fetchone()\n"
            "    b = db.execute(\"SELECT id FROM orders ORDER BY id DESC LIMIT 1\").fetchone()\n"
            "    assert a and b\n")
    r = scan(installed, body)
    assert "H" not in counts(r), r.stdout


def test_CR19_08_role_word_with_password_argument_is_still_account(installed):
    r = scan(installed, 'import os\n\n\ndef test_x(page):\n    login(page, "user", PW)\n')
    assert counts(r).get("F") == 1, r.stdout
    r = scan(installed, 'def test_x(page):\n    login_as(page, "admin", headless=True)\n')
    assert "F" not in counts(r), r.stdout


# =====================================================================
# 最後一輪退步審查（FR-xx）
# =====================================================================

def _lsof_fake(ps_cmd, cwd):
    def fake(args, **k):
        if args[0] == "lsof" and "-t" in args:
            return _Proc("111\n")
        if args[0] == "ps":
            return _Proc(ps_cmd + "\n")
        if args[0] == "lsof" and "cwd" in args:
            return _Proc("p111\nn%s\n" % cwd)
        return _Proc("")
    return fake


@pytest.mark.parametrize("cmd,cwd,want", [
    ("/usr/bin/python3 manage.py runserver", "/home/u/wt/app", True),     # 系統直譯器＋相對腳本、cwd 在 wt
    ("/usr/bin/python3 manage.py runserver", "/home/u/other/app", False),  # 對照：cwd 在別處
    ("/home/u/other/venv/bin/uvicorn app:app", "/home/u/wt/app", False),   # 對照：非直譯器的絕對路徑在別處
    ("node /home/u/wt/app/server.js", "/x", True),                         # 回歸：絕對腳本在 wt
])
def test_FR_01_system_interpreter_path_is_not_location(monkeypatch, cmd, cwd, want):
    eg = _import_tool("env_gates")
    monkeypatch.setattr(eg.subprocess, "run", _lsof_fake(cmd, cwd))
    ok, lines = eg.port_guard_check(expect="wt", cfg={"ports": [{"label": "後端", "port": 8000}]}, env={}, backend="lsof")
    assert ok is want, lines


def test_FR_01_strip_interpreter_windows_quoted_exe():
    eg = _import_tool("env_gates")
    assert eg.strip_interpreter('"C:/Program Files/Python313/python.exe" app.py').strip() == "app.py"  # portable-ok: 測試資料字串（模擬 Windows 命令列），非執行路徑
    assert eg.strip_interpreter("/usr/local/bin/uvicorn app:app").startswith("/usr/local/bin/uvicorn")


def test_FR_02_tools_regular_file_rejected_in_precheck(tmp_path):
    if str(SKILL / "lib") not in sys.path:
        sys.path.insert(0, str(SKILL / "lib"))
    it = importlib.import_module("install_tools")
    (tmp_path / "tools").write_text("", encoding="utf-8")
    with pytest.raises(it.LinkedToolsDir):
        it.check_tools_dir(str(tmp_path))
    ok_dir = tmp_path / "ok"
    (ok_dir / "tools").mkdir(parents=True)
    it.check_tools_dir(str(ok_dir))


@pytest.mark.parametrize("body,want", [
    ('def test_x():\n    pay = {"account": "1000000000001", "account_name": "Acme Trading"}\n', 0),  # 銀行帳號／戶名
    ('def test_x():\n    pay = {"account_name": "測試股份有限公司"}\n', 0),                          # 中文戶名
    ('def test_x():\n    account_name = "bob"\n', 1),                                             # 像登入帳號的值照抓
    ('def test_x():\n    pay = {"account": "US123456789"}\n', 0),                                 # 外國帳號號碼
    ('def test_x():\n    p = {"account_id": "ACC-X"}\n', 0),                                      # 全大寫代號
    ('def test_x():\n    account = "alice01"\n', 1),
    ('def test_x():\n    creds = {"user_account": "alice01"}\n', 1),
    ('def test_x():\n    login_account = "bob77"\n', 1),
])
def test_FR_04_bare_account_is_not_login_account(installed, body, want):
    r = scan(installed, body)
    assert counts(r).get("F", 0) == want, r.stdout


# =====================================================================
# 整份重審（FR-05～FR-08）
# =====================================================================

@pytest.mark.parametrize("reason,want", [
    ("資料已存在，略過", "D"), ("前次殘留資料已存在", "D"), ("共用帳號被佔用", "D"), ("訂單被別的測試佔用", "D"),
    ("already exists", "D"),
    ("port 8080 被佔用", "B"), ("埠 5173 已被佔用", "B"), ("Windows 上檔案被佔用（PermissionError）", "B"),
    ("Port 8080 already in use", "B"), ("address already in use", "B"), ("account already in use", "D"),
    ("email address already in use", "D"), ("Email address is already in use", "D"), ("IP address already in use", "B"),
    ("Email-Address already in use", "D"), ("email  address already in use", "D"), ("bind: address already in use", "B"),
    ("email\taddress already in use", "D"),
    ("無已存在的客戶可用", "A"), ("沒有已送出的單據", "A"), ("已存在的資料不足", "A"), ("查無訂單", "A"),
])
def test_FR_05_skip_exists_and_occupied_classification(reason, want):
    sa = _import_tool("skip_audit")
    assert sa.classify(reason) == want


@pytest.mark.parametrize("cmd,secret", [
    ("curl -u admin:S3cret http://x", "S3cret"), ("curl -uadmin:S3cret x", "S3cret"),
    ('curl -u "admin:s3 cret" x', "s3 cret"), ("curl -u 'admin:s3 cret' x", "s3 cret"),
    ("svc -U user:pw9", "pw9"), ("svc --user=admin:S3cret", "S3cret"),
])
def test_FR_06_user_colon_password_masked(cmd, secret):
    eg = _import_tool("env_gates")
    out = eg.mask_command_line(cmd)
    assert secret not in out and "***" in out, out


@pytest.mark.parametrize("cmd", ["git log -u", "psql -U postgres db"])
def test_FR_06_user_flag_without_password_untouched(cmd):
    eg = _import_tool("env_gates")
    assert eg.mask_command_line(cmd) == cmd


def test_FR_07_windows_without_powershell_is_query_error(monkeypatch):
    eg = _import_tool("env_gates")
    monkeypatch.setattr(eg.shutil, "which", lambda name: None)
    with pytest.raises(eg.OwnerQueryError):
        eg.owners_of(5173, "windows")
    ok, lines = eg.port_guard_check(expect="wt", cfg={"ports": [{"label": "前端", "port": 5173}]}, env={}, backend="windows")
    assert ok is True, lines


def test_FR_07_listener_query_distinguishes_not_found_from_missing_cmdlet():
    eg = _import_tool("env_gates")
    src = open(eg.__file__, encoding="utf-8").read()
    assert "CmdletizationQuery_NotFound" in src
    assert "CategoryInfo.Category -eq 'ObjectNotFound'" not in src


def test_FR_09_collided_dependency_skips_dependents(tmp_path):
    if str(SKILL / "lib") not in sys.path:
        sys.path.insert(0, str(SKILL / "lib"))
    it = importlib.import_module("install_tools")
    e2e = tmp_path / "e2e"
    (e2e / "tools").mkdir(parents=True)
    (e2e / "tools" / "runs_db.py").write_text("# 專案自己的 runs_db\n", encoding="utf-8")
    added, _u, _s, skipped = it.sync(str(e2e), quiet=True)
    names = {n for n, _why in skipped}
    assert {"runs_db.py", "qa_pytest_plugin.py", "gen_catalog.py"} <= names, skipped
    assert "qa_pytest_plugin.py" not in added and (e2e / "tools" / "runs_db.py").read_text(encoding="utf-8") == "# 專案自己的 runs_db\n"
    assert "hardcode_check.py" in added  # 不依賴撞名檔的工具照裝


def _install_mod():
    if str(SKILL / "lib") not in sys.path:
        sys.path.insert(0, str(SKILL / "lib"))
    return importlib.import_module("install_tools")


def test_FR_10_transitive_collision_names_the_root_file(tmp_path):
    it = _install_mod()
    e2e = tmp_path / "e2e"
    (e2e / "tools").mkdir(parents=True)
    (e2e / "tools" / "baseline.py").write_text("# 專案自己的 baseline\n", encoding="utf-8")
    _a, _u, _s, skipped = it.sync(str(e2e), quiet=True)
    why = dict(skipped)
    assert "drift_check.py" in why and "qa_pytest_plugin.py" in why, skipped
    msg = why["qa_pytest_plugin.py"]
    assert "baseline.py" in msg and "drift_check.py" not in msg, msg


def test_FR_11_collision_after_install_keeps_file_and_warns(tmp_path):
    it = _install_mod()
    e2e = tmp_path / "e2e"
    it.sync(str(e2e), quiet=True)
    (e2e / "tools" / "runs_db.py").write_text("# 後來換成專案自己的 runs_db\n", encoding="utf-8")
    _a, _u, _s, skipped = it.sync(str(e2e), quiet=True)
    assert "已安裝的這支舊版仍在原處" in dict(skipped)["qa_pytest_plugin.py"]
    assert (e2e / "tools" / "qa_pytest_plugin.py").exists()
    import subprocess as sp
    r = sp.run([sys.executable, str(SKILL / "lib" / "install_tools.py"), "status", str(e2e)], capture_output=True,
               text=True, encoding="utf-8", errors="replace")
    line = [ln for ln in r.stdout.splitlines() if "qa_pytest_plugin.py" in ln]
    assert line and "撞名受阻" in line[0], r.stdout


def test_FR_13_deps_via_ast_multiline_and_continuation(tmp_path, monkeypatch):
    it = _install_mod()
    src = tmp_path / "src"
    src.mkdir()
    for n in ("alpha", "beta", "gamma", "delta"):
        (src / (n + ".py")).write_text("X = 1\n", encoding="utf-8")
    (src / "user.py").write_text(
        "try:\n    from . import (alpha,\n        beta)\nexcept ImportError:\n    import alpha, \\\n        beta\n"
        "def f():\n    import gamma as g\n    return g\n", encoding="utf-8")
    monkeypatch.setattr(it, "SRC_TOOLS", str(src))
    assert it._deps("user.py") == {"alpha.py", "beta.py", "gamma.py"}


def test_FR_14_same_name_directory_does_not_crash(tmp_path):
    it = _install_mod()
    e2e = tmp_path / "e2e"
    (e2e / "tools" / "qa_config.py").mkdir(parents=True)
    _a, _u, _s, skipped = it.sync(str(e2e), quiet=True)
    why = dict(skipped)
    assert "同名的資料夾" in why["qa_config.py"]
    assert "qa_config.py" in why["drift_check.py"]
    import contextlib
    import io as _io
    buf = _io.StringIO()
    with contextlib.redirect_stdout(buf):
        it.status(str(e2e))
    assert "同名資料夾" in buf.getvalue()


def test_FR_12_pattern_cache_checks_cfg_identity():
    sa = _import_tool("skip_audit")
    cfg = {"skip_classify": {"D": ["自訂D字樣"]}}
    sa._PATS[id(cfg)] = (object(), {"stale": True})
    assert "stale" not in sa._compile(cfg)
    assert sa.classify("出現自訂D字樣", cfg) == "D"


@needs_bash
def test_FR_08_same_day_legacy_migration_keeps_every_backup(project):
    legacy = ("> 由 qa-flow.sh catalog 回填\n\n| 白話業務情境 | 對應測試函式 | 覆蓋狀態 | 業務模組分類 |\n"
              "|------|------|------|------|\n| a%d | test_a%d | ✅完整 | m |\n")
    project.write("catalog.md", "> 由 qa-flow.sh catalog 回填\n\n| 白話業務情境 | 對應測試函式 | 覆蓋狀態 | 業務模組分類 |\n"
                                "|------|------|------|------|\n")
    for i in (1, 2):
        (project.root / "catalog.md").write_text(legacy % (i, i), encoding="utf-8")
        r = project.flow("bootstrap")
        assert "已合併舊版 catalog" in r.stderr, r.stdout + r.stderr
    backups = sorted(p.name for p in project.root.iterdir() if ".migrated-" in p.name)
    assert len(backups) == 2 and backups[1].endswith("-2"), backups
    merged = project.read("catalog.md") if (project.e2e / "catalog.md").exists() else project.read("CATALOG.md")
    assert "test_a1" in merged and "test_a2" in merged


def test_FR_03_root_folder_output_name(installed, tmp_path):
    installed.write("test_root.py", "def test_1():\n    pass\n")
    out = tmp_path / "runs"
    installed.tool("run_by_folder.py", ".", "--out-dir", str(out))
    names = sorted(f.name for f in out.glob("*.xml"))
    assert names == ["%2E.xml"], names
