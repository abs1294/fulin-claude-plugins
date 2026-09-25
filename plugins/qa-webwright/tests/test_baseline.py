"""baseline 制統一（skip_audit 與其他工具同等保護）。

四支稽核工具（hardcode_check / drift_check / skip_audit / i18n_locator_check）共用 tools/baseline.py，
逐一驗：無 why 拒寫／新增拒寫／allow-raise 放行／只降不升（prev_count 記錄）／部分掃描拒寫／
指紋不含行號／--baseline 只擋新增。
"""
import json

import pytest

# 每支工具：(腳本, 產生 1 筆違規的檔案內容, 產生第 2 筆（新增）違規的內容, baseline 檔名)
CASES = {
    "hardcode_check.py": (
        "ORDER_ID = 1\n\ndef test_a():\n    pass\n",
        "ORDER_ID = 1\nITEM_ID = 2\n\ndef test_a():\n    pass\n",
        "hardcode-baseline.json"),
    "drift_check.py": (
        "def test_a():\n    pass\n",
        "def test_a():\n    pass\n\ndef test_b():\n    pass\n",
        "drift-baseline.json"),
    "skip_audit.py": (
        "import pytest\n\ndef test_a():\n    pytest.skip('no data available')\n",
        "import pytest\n\ndef test_a():\n    pytest.skip('no data available')\n\n"
        "def test_b():\n    pytest.skip('查無訂單')\n",
        "skip-baseline.json"),
    "i18n_locator_check.py": (
        "def test_a(page):\n    page.get_by_text('送出').click()\n",
        "def test_a(page):\n    page.get_by_text('送出').click()\n    page.get_by_role('button', name='取消').click()\n",
        "i18n-locator-baseline.json"),
}


def _base(project, name):
    return project.e2e / "_reports" / name


@pytest.mark.parametrize("script", sorted(CASES))
def test_baseline_protections(installed, script):
    one, two, bname = CASES[script]
    p = installed
    p.write("orders/test_o.py", one)
    if script == "drift_check.py":
        p.coverage("orders", [])

    # 無 why → 拒寫
    r = p.tool(script, "all", "--write-baseline")
    assert r.returncode == 2 and "--why" in r.stdout, r.stdout
    assert not _base(p, bname).exists()

    # 部分掃描 → 拒寫（不得抹掉其他範圍指紋）
    r = p.tool(script, "orders", "--write-baseline", "--why", "x")
    assert r.returncode == 2 and "只能對全範圍" in r.stdout, r.stdout

    # 首次帶 why → 寫入
    r = p.tool(script, "all", "--write-baseline", "--why", "初始存量")
    assert r.returncode == 0, r.stdout
    data = json.loads(_base(p, bname).read_text(encoding="utf-8"))
    assert data["count"] == 1 and data["why"] == "初始存量" and data["prev_count"] is None
    assert data["generated_at"] and data["fingerprints"]
    assert not any(ch.isdigit() and ":%s" % ch in fp for fp in data["fingerprints"] for ch in "0123456789")

    # --baseline：存量豁免 → exit 0
    r = p.tool(script, "orders", "--baseline")
    assert r.returncode == 0, r.stdout

    # 指紋不含行號：上方插空行／註解不會變成「新增」
    p.write("orders/test_o.py", "\n\n# 插幾行無關內容\n\n" + one)
    r = p.tool(script, "orders", "--baseline")
    assert r.returncode == 0, r.stdout

    # 新增一筆 → --baseline 擋；重產被拒（集合差）
    p.write("orders/test_o.py", two)
    r = p.tool(script, "orders", "--baseline")
    assert r.returncode == 1 and "QA-TOOL-RESULT: violations" in r.stdout, r.stdout
    r = p.tool(script, "all", "--write-baseline", "--why", "想偷渡")
    assert r.returncode == 2 and "新增" in r.stdout, r.stdout
    assert json.loads(_base(p, bname).read_text(encoding="utf-8"))["count"] == 1

    # --allow-raise → 放行並記 prev_count
    r = p.tool(script, "all", "--write-baseline", "--why", "判準改了", "--allow-raise")
    assert r.returncode == 0, r.stdout
    data = json.loads(_base(p, bname).read_text(encoding="utf-8"))
    assert data["count"] == 2 and data["prev_count"] == 1

    # 只降不升：清掉一筆 → 可重產，水位下降
    p.write("orders/test_o.py", one)
    r = p.tool(script, "all", "--write-baseline", "--why", "清掉一筆")
    assert r.returncode == 0, r.stdout
    data = json.loads(_base(p, bname).read_text(encoding="utf-8"))
    assert data["count"] == 1 and data["prev_count"] == 2


def test_empty_baseline_still_protects(installed):
    """水位歸零後（fingerprints 為空）保護不得被跳過（is not None 判斷）。"""
    installed.write("orders/test_o.py", "def test_a():\n    pass\n")
    r = installed.tool("hardcode_check.py", "all", "--write-baseline", "--why", "零存量")
    assert r.returncode == 0
    installed.write("orders/test_o.py", "ORDER_ID = 5\n\ndef test_a():\n    pass\n")
    r = installed.tool("hardcode_check.py", "all", "--write-baseline", "--why", "偷渡")
    assert r.returncode == 2, r.stdout


def test_baseline_module_unit(tmp_path):
    import sys
    from conftest import SKILL
    sys.path.insert(0, str(SKILL / "tools"))
    import baseline as bl
    path = str(tmp_path / "b.json")
    assert bl.load(path) is None
    rc, msgs = bl.write(path, {"a", "b"}, "", tool="t")
    assert rc == 2
    rc, _ = bl.write(path, {"a", "b"}, "init", tool="t")
    assert rc == 0 and bl.load(path) == {"a", "b"}
    new, old = bl.split({"a", "c"}, bl.load(path))
    assert new == {"c"} and old == {"a"}
    rc, msgs = bl.write(path, {"a", "c"}, "swap", tool="t")
    assert rc == 2 and any("c" in m for m in msgs)
