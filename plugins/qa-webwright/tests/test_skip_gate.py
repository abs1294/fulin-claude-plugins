"""skip 四分類與 A/D 整輪失敗閘。"""
import re
import sys

import pytest

from conftest import SKILL

sys.path.insert(0, str(SKILL / "tools"))
import qa_config  # noqa: E402
import skip_audit  # noqa: E402


def _summary(stdout):
    m = re.search(r"收集期 skip/skipif＝(\d+)（不計入閘）；執行期 skip＝(\d+)：([^\s]+)", stdout)
    assert m, stdout
    return int(m.group(1)), int(m.group(2)), m.group(3)


def test_runtime_A_skip_fails_the_run(installed):
    installed.write("orders/test_o.py", "import pytest\n\ndef test_a():\n    pytest.skip('no data available')\n")
    r = installed.pytest()
    assert r.returncode == 1, r.stdout
    static_n, runtime_n, parts = _summary(r.stdout)
    assert (static_n, runtime_n, parts) == (0, 1, "A=1")
    assert "⛔ 本輪有 1 支" in r.stdout and "[A] orders/test_o.py" in r.stdout


def test_runtime_D_skip_fails_the_run(installed):
    installed.write("orders/test_o.py", "import pytest\n\ndef test_d():\n    pytest.skip('模組目前審查中，不重複觸發')\n")
    r = installed.pytest()
    assert r.returncode == 1
    assert _summary(r.stdout)[2] == "D=1"


def test_skip_in_fixture_is_runtime(installed):
    installed.write("orders/test_o.py", "import pytest\n\n@pytest.fixture\ndef row():\n"
                                        "    pytest.skip('查無可用訂單')\n\ndef test_x(row):\n    pass\n")
    r = installed.pytest()
    assert r.returncode == 1
    assert _summary(r.stdout)[:2] == (0, 1)


def test_collection_time_skipif_does_not_fail(installed):
    # 理由刻意寫得跟 A 類一模一樣——判準是「決定的時機」，不是理由字面
    installed.write("orders/test_o.py", "import pytest\n\n@pytest.mark.skipif(True, reason='no data available')\n"
                                        "def test_c():\n    pass\n\n@pytest.mark.skip(reason='查無資料')\n"
                                        "def test_d():\n    pass\n\ndef test_ok():\n    assert True\n")
    r = installed.pytest()
    assert r.returncode == 0, r.stdout
    assert _summary(r.stdout)[:2] == (2, 0)


def test_dynamic_add_marker_is_collection_time(installed):
    installed.write("orders/conftest.py", "import pytest\n\ndef pytest_collection_modifyitems(items):\n"
                                          "    for it in items:\n"
                                          "        it.add_marker(pytest.mark.skip(reason='no data available'))\n")
    installed.write("orders/test_o.py", "def test_x():\n    pass\n")
    r = installed.pytest()
    assert r.returncode == 0, r.stdout
    assert _summary(r.stdout)[:2] == (1, 0)


def test_counts_and_exit_share_one_source(installed):
    """終端計數與 exit code 同一口徑：同一輪同時有收集期（像 A）與執行期 B → exit 0、計數 1/1。"""
    installed.write("orders/test_o.py",
                    "import pytest\n\n@pytest.mark.skipif(True, reason='no data available')\ndef test_c():\n    pass\n\n"
                    "def test_b():\n    pytest.skip('payment sandbox unavailable')\n")
    r = installed.pytest()
    assert r.returncode == 0, r.stdout
    assert _summary(r.stdout) == (1, 1, "B=1")


def test_skip_gate_can_be_disabled(installed):
    installed.config(skip_gate=False)
    installed.write("orders/test_o.py", "import pytest\n\ndef test_a():\n    pytest.skip('no data available')\n")
    assert installed.pytest().returncode == 0


def test_real_failure_still_fails_and_xfail_not_counted(installed):
    installed.write("orders/test_o.py", "import pytest\n\n@pytest.mark.xfail(reason='no data available')\n"
                                        "def test_x():\n    assert False\n\ndef test_ok():\n    pass\n")
    r = installed.pytest()
    assert r.returncode == 0, r.stdout
    assert "SKIP 分類" not in r.stdout


@pytest.mark.parametrize("reason,expected", [
    ("DB 當下查無此類訂單", "A"),
    ("no rows in orders table", "A"),
    ("only 1 records found, need 2", "A"),
    ("外部付款服務不可用", "B"),
    ("payment gateway unreachable", "B"),
    ("頁面結構已改", "C"),
    ("page structure changed", "C"),
    ("模組審查中，不重複觸發", "D"),
    ("record is locked by previous run", "D"),
    ("可能全數被後端改成審查中（未找到該狀態的列）", "A"),   # D 排除：推測語氣 → A
    ("maybe locked, no row with status pending", "A"),
    ("無此端點（404）", "B"),                              # B 先於 A：環境類理由常帶「無」
    ("", "?"),
    ("weird thing", "?"),
])
def test_classify(reason, expected):
    assert skip_audit.classify(reason, qa_config.load(use_cache=False)) == expected


def test_classify_extensible_by_config(installed):
    installed.config(skip_classify={"B": ["\\bsandbox rebooting\\b"]})
    installed.write("orders/test_o.py", "import pytest\n\ndef test_x():\n    pytest.skip('sandbox rebooting')\n")
    r = installed.tool("skip_audit.py", "all", "--list")
    assert "B 環境不可用（合理保留，但須具名條件）：1 處" in r.stdout, r.stdout


def test_static_scan_is_ast_only(installed):
    installed.write("orders/test_o.py", '''"""說明：不要寫 pytest.skip("no data available")。"""
import pytest

# pytest.skip("查無資料") 只是註解


@pytest.mark.skip(reason="no data available")
def test_decorated():
    pass


MARK = pytest.mark.skipif(True, reason="no data available")


def test_runtime():
    pytest.skip("no data available")
''')
    r = installed.tool("skip_audit.py", "all", "--list", "--strict")
    assert r.returncode == 1
    assert "共 1 處" in r.stdout, r.stdout
    assert "orders/test_o.py:16" in r.stdout
