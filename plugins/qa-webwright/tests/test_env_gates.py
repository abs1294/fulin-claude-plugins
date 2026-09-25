"""環境閘框架：(a) port 歸屬閘、(b) fixture 圖環境檢查、(c) 探測覆寫三態。"""
import socket
import subprocess
import sys
import time

import pytest

from conftest import SKILL

sys.path.insert(0, str(SKILL / "tools"))
import env_gates  # noqa: E402
import qa_config  # noqa: E402


# ---------------- (c) QA_<NAME>_AVAILABLE 三態 ----------------

@pytest.mark.parametrize("raw,expected,source", [
    ("1", True, "forced"), ("true", True, "forced"), ("YES", True, "forced"), (" on ", True, "forced"),
    ("0", False, "forced"), ("false", False, "forced"), ("nope", False, "forced"),
    (None, "probe", "probe"), ("", "probe", "probe"), ("  ", "probe", "probe"),
])
def test_probe_flag_three_states(raw, expected, source):
    env = {} if raw is None else {"QA_PAYMENT_SANDBOX_AVAILABLE": raw}
    calls = []

    def probe():
        calls.append(1)
        return "probe"

    val, src = env_gates.probe_flag("payment-sandbox", probe, env=env)
    assert src == source
    if source == "probe":
        assert calls == [1] and val is True
    else:
        assert calls == [] and val is expected


def test_probe_env_name():
    assert env_gates.probe_env_name("payment-sandbox") == "QA_PAYMENT_SANDBOX_AVAILABLE"
    assert env_gates.probe_env_name("mail") == "QA_MAIL_AVAILABLE"


# ---------------- (a) port 歸屬閘 ----------------

def _cfg(ports):
    cfg = qa_config.load(use_cache=False)
    cfg = qa_config.Config(dict(cfg))
    cfg["ports"] = ports
    return cfg


def test_port_guard_skipped_when_unset():
    ok, lines = env_gates.port_guard_check(cfg=_cfg([{"label": "fe", "port": 1}]), env={},
                                           owner_fn=lambda p: pytest.fail("不該查詢"))
    assert ok and lines == []


def test_port_guard_match_and_mismatch():
    cfg = _cfg([{"label": "前端", "port": 5173}, {"label": "後端", "url_env": "QA_API_URL"}])
    env = {"QA_EXPECT_WORKTREE": "feat-x", "QA_API_URL": "http://localhost:8080/api"}
    owners = {5173: "node /repo/wt/feat-x/node_modules/.bin/vite", 8080: r"C:\repo\wt\feat-x-api\bin\app.exe"}  # portable-ok: 模擬 Windows 命令列字串的比對資料
    ok, lines = env_gates.port_guard_check(cfg=cfg, env=env, owner_fn=owners.get)
    assert ok, lines
    owners[8080] = "/repo/wt/other-branch/app"
    ok, lines = env_gates.port_guard_check(cfg=cfg, env=env, owner_fn=owners.get)
    assert not ok and any("由別處佔用" in ln and ":8080" in ln for ln in lines)
    owners.pop(5173)
    ok, lines = env_gates.port_guard_check(cfg=cfg, env=env, owner_fn=owners.get)
    assert any("沒有任何 process 在 listen" in ln for ln in lines)


def test_port_guard_fail_open_without_backend(monkeypatch):
    """PowerShell（Windows）與 lsof（macOS/Linux）都不可用 → 放行並明說。"""
    monkeypatch.setattr(env_gates, "owner_backend", lambda: None)
    cfg = _cfg([{"label": "fe", "port": 5173}])
    ok, lines = env_gates.port_guard_check(cfg=cfg, env={"QA_EXPECT_WORKTREE": "x"})
    assert ok and "fail-open" in lines[0] and "lsof" in lines[0]


def test_owner_backend_by_platform(monkeypatch):
    monkeypatch.setattr(env_gates.sys, "platform", "darwin")
    monkeypatch.setattr(env_gates.shutil, "which", lambda n: "/usr/sbin/lsof" if n == "lsof" else None)
    assert env_gates.owner_backend() == "lsof"
    monkeypatch.setattr(env_gates.sys, "platform", "win32")
    monkeypatch.setattr(env_gates.shutil, "which", lambda n: "C:/Windows/powershell.exe" if n == "powershell" else None)  # portable-ok: 模擬 which 回傳值
    assert env_gates.owner_backend() == "windows"
    monkeypatch.setattr(env_gates.shutil, "which", lambda n: None)
    assert env_gates.owner_backend() is None


def _free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def test_port_guard_real_listener_in_pytest(installed, tmp_path):
    """真的起一個 listener（命令列路徑含 wt-demo），用假專案的 pytest 實跑 port 閘。"""
    if env_gates.owner_backend() is None:
        pytest.skip("本機沒有 PowerShell（Windows）或 lsof（macOS/Linux），port 歸屬查詢不可用")
    port = _free_port()
    srv_dir = tmp_path / "wt-demo" / "svc"
    srv_dir.mkdir(parents=True)
    script = srv_dir / "server.py"
    script.write_text("import socket, sys, time\ns = socket.socket()\ns.bind(('127.0.0.1', %d))\n"
                      "s.listen(5)\ntime.sleep(120)\n" % port, encoding="utf-8")
    proc = subprocess.Popen([sys.executable, str(script)])
    try:
        for _ in range(50):
            try:
                socket.create_connection(("127.0.0.1", port), timeout=0.2).close()
                break
            except OSError:
                time.sleep(0.1)
        installed.config(ports=[{"label": "demo", "port": port}])
        installed.write("orders/test_o.py", "def test_ok():\n    assert True\n")
        r = installed.pytest(env={"QA_EXPECT_WORKTREE": "wt-demo"})
        assert r.returncode == 0, r.stdout + r.stderr
        r = installed.pytest(env={"QA_EXPECT_WORKTREE": "wt-other"})
        assert r.returncode == 3, r.stdout + r.stderr
        assert "port 歸屬檢查失敗" in r.stdout + r.stderr
        r = installed.pytest()   # 未設 → 不檢查
        assert r.returncode == 0
    finally:
        proc.kill()
        proc.wait()


# ---------------- (b) fixture 圖 → 必要環境變數 ----------------

CONFTEST = '''import pytest


@pytest.fixture
def admin_page():
    return "admin"


@pytest.fixture
def order_page(admin_page):   # 遞移依賴 admin_page
    return "order"
'''


def _fixture_project(p):
    p.config(env_requirements=[{"fixtures": ["admin_page"], "env": ["QA_ADMIN_URL"], "desc": "後台畫面"}])
    p.write("orders/conftest.py", CONFTEST)


def test_fixture_env_missing_is_usage_error(installed):
    _fixture_project(installed)
    installed.write("orders/test_o.py", "def test_direct(admin_page):\n    assert admin_page\n")
    r = installed.pytest()
    out = r.stdout + r.stderr
    assert r.returncode == 4, out
    assert "缺：QA_ADMIN_URL" in out and "orders/test_o.py::test_direct" in out


def test_fixture_env_transitive_dependency(installed):
    _fixture_project(installed)
    installed.write("orders/test_o.py", "def test_indirect(order_page):\n    assert order_page\n")
    r = installed.pytest()
    assert r.returncode == 4 and "fixture：admin_page" in r.stdout + r.stderr


def test_fixture_env_present_or_unused(installed):
    _fixture_project(installed)
    installed.write("orders/test_o.py", "def test_direct(admin_page):\n    assert admin_page\n")
    assert installed.pytest(env={"QA_ADMIN_URL": "http://admin.local"}).returncode == 0
    installed.write("orders/test_o.py", "def test_plain():\n    assert True\n")
    assert installed.pytest().returncode == 0
