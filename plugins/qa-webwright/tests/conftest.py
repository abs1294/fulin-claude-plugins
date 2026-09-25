"""qa-webwright plugin 自測的共用 fixture。

所有情境都在 pytest 的暫存目錄建 greenfield 假專案實跑（不碰任何真實專案）：
  - qa-flow.sh 以 bash 實跑（Windows 用 Git Bash；macOS/Linux 用系統 bash）
  - 工具以「複製進假專案 tests/e2e/tools/ 後」的樣子實跑，與使用者專案一致
  - 假專案裡的 pytest 以子程序實跑（sys.executable -m pytest），驗 exit code 與 sqlite
"""
import json
import os
import shutil
import sqlite3
import subprocess
import sys
from pathlib import Path

import pytest

# 測試會 import skills/browser-qa/tools/ 的模組；不要在 plugin 目錄留下 __pycache__
sys.dont_write_bytecode = True

PLUGIN = Path(__file__).resolve().parents[1]
SKILL = PLUGIN / "skills" / "browser-qa"
QAFLOW = SKILL / "qa-flow.sh"
INSTALLER = SKILL / "lib" / "install_tools.py"
TEMPLATES = SKILL / "templates"
BASH = shutil.which("bash")

needs_bash = pytest.mark.skipif(BASH is None, reason="本機沒有 bash（Windows 請裝 Git for Windows）")


def _env(extra=None):
    env = dict(os.environ)
    env["PYTHONIOENCODING"] = "utf-8"
    for k in ("QA_BATCH", "E2E_BATCH", "QA_EXPECT_WORKTREE", "QA_E2E_ROOT", "PYTEST_ADDOPTS"):
        env.pop(k, None)
    if extra:
        env.update(extra)
    return env


class Project(object):
    """暫存目錄裡的假專案。"""

    def __init__(self, root):
        self.root = Path(root)
        self.e2e = self.root / "tests" / "e2e"

    # ---- qa-flow.sh ----
    def flow(self, *args, env=None):
        self.root.mkdir(parents=True, exist_ok=True)
        e = _env({"CLAUDE_PROJECT_DIR": self.root.as_posix()})
        if env:
            e.update(env)
        return subprocess.run([BASH, QAFLOW.as_posix()] + list(args), cwd=str(self.root), env=e,
                              capture_output=True, text=True, encoding="utf-8", errors="replace")

    # ---- 已複製進專案的工具 ----
    def install(self):
        self.e2e.mkdir(parents=True, exist_ok=True)
        r = subprocess.run([sys.executable, str(INSTALLER), "install", str(self.e2e)],
                           capture_output=True, text=True, encoding="utf-8", errors="replace", env=_env())
        assert r.returncode == 0, r.stdout + r.stderr
        shutil.copy(str(TEMPLATES / "conftest_snippet.py"), str(self.e2e / "conftest.py"))
        return self

    def tool(self, script, *args, env=None):
        return subprocess.run([sys.executable, "tools/" + script] + list(args), cwd=str(self.e2e),
                              capture_output=True, text=True, encoding="utf-8", errors="replace",
                              env=_env(env))

    def pytest(self, *args, env=None):
        return subprocess.run([sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider"] + list(args),
                              cwd=str(self.e2e), capture_output=True, text=True, encoding="utf-8",
                              errors="replace", env=_env(env))

    # ---- 檔案 ----
    def write(self, rel, text):
        p = self.e2e / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        with open(str(p), "w", encoding="utf-8", newline="\n") as fh:
            fh.write(text)
        return p

    def read(self, rel):
        with open(str(self.e2e / rel), encoding="utf-8") as fh:
            return fh.read()

    def config(self, **updates):
        path = self.e2e / "qa-webwright.json"
        cfg = json.loads(path.read_text(encoding="utf-8"))
        cfg.update(updates)
        path.write_text(json.dumps(cfg, ensure_ascii=False, indent=1), encoding="utf-8")
        return cfg

    def coverage(self, folder, rows, locked=(), xfail=()):
        lines = ["# %s/ 情境覆蓋 測試" % folder, "", "| 使用情境（白話） | 測試函式 | 覆蓋 |", "|---|---|---|"]
        lines += rows
        lines += ["", "## 🔒 鎖定 bug", "", "| 情境 | 位置 | 狀態 |", "|---|---|---|"] + list(locked)
        lines += ["", "## 本資料夾 xfail / skip", "", "| 測試函式 | 標記 | 原因 |", "|---|---|---|"] + list(xfail)
        return self.write("%s/COVERAGE.md" % folder, "\n".join(lines) + "\n")

    def sqlite_rows(self):
        db = self.e2e / ".runs" / "results.sqlite"
        if not db.exists():
            return []
        con = sqlite3.connect(str(db))
        try:
            return con.execute("SELECT batch, nodeid, folder, outcome FROM runs ORDER BY id").fetchall()
        finally:
            con.close()


@pytest.fixture
def project(tmp_path):
    return Project(tmp_path / "proj")


@pytest.fixture
def installed(project):
    """已複製工具＋參數檔＋conftest 掛點的假專案（業務表設為 orders/order_items）。"""
    project.install()
    project.config(biz_tables=["orders", "order_items"], skeleton_tables=["users"])
    return project
