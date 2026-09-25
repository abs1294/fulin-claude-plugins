"""執行事實層：把每次 pytest 的結果寫進 SQLite，供 gen_catalog 產出「最後執行日／批次／綠不綠」。

為何要有這層：COVERAGE.md 是人寫的情境知識（會過時但改得動），CATALOG.md 是生成的索引
（不該手改）。「這個資料夾上次什麼時候真的跑過、綠不綠」既不是知識也不是索引，是事實，
只能由機器在跑的當下記下來。

寫入點：tools/qa_pytest_plugin.py 的 pytest_sessionfinish（conftest 片段引入）。
"""
import os
import sqlite3
from contextlib import closing
from datetime import datetime, timezone

try:
    from . import qa_config
except ImportError:  # 以腳本方式執行
    import qa_config

_SCHEMA = """
CREATE TABLE IF NOT EXISTS runs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id      TEXT    NOT NULL,
    started_at  TEXT    NOT NULL,
    batch       TEXT    NOT NULL,
    nodeid      TEXT    NOT NULL,
    folder      TEXT    NOT NULL,
    outcome     TEXT    NOT NULL,
    duration_s  REAL    NOT NULL DEFAULT 0.0
);
CREATE INDEX IF NOT EXISTS ix_runs_folder ON runs (folder);
CREATE INDEX IF NOT EXISTS ix_runs_run_id ON runs (run_id);
"""


def db_path(root=None):
    return os.path.join(root or qa_config.e2e_root(), ".runs", "results.sqlite")


def folder_of(nodeid):
    """nodeid（相對 tests/e2e）→ 資料夾名；根目錄下的測試檔回 ""。

    `orders/test_x.py::test_y` → `orders`；`test_x.py::test_y` → ``。
    """
    head = nodeid.replace("\\", "/").split("::", 1)[0]
    parts = [p for p in head.split("/") if p]
    return parts[0] if len(parts) > 1 else ""


class LinkedPathError(Exception):
    """`.runs` 目錄或資料庫檔是連到別處的 symlink／junction。"""


def _linked_out(p):
    """p 的實體路徑與「父目錄實體路徑＋自己的名字」不同＝p 本身是連到別處的連結（symlink／junction）。"""
    if not os.path.lexists(p):
        return False
    real = os.path.normcase(os.path.realpath(p))
    expect = os.path.normcase(os.path.join(os.path.realpath(os.path.dirname(os.path.abspath(p))), os.path.basename(p)))
    return real != expect


def check_path(path):
    """寫入／讀取前確認 `.runs` 與資料庫檔不是連到別處：否則記錄會改到別的專案的資料庫。"""
    d = os.path.dirname(os.path.abspath(path))
    for p in (d, path):
        if _linked_out(p):
            raise LinkedPathError("%s 是連到別處的 symlink／junction，拒絕讀寫執行紀錄" % p)


def connect(path=None):
    path = path or db_path()
    check_path(path)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    conn = sqlite3.connect(path)
    conn.executescript(_SCHEMA)
    return conn


def record_run(run_id, started_at, batch, results, path=None):
    """寫入一次 session 的所有結果。results 為 (nodeid, outcome, duration_s)。回傳寫入列數。"""
    rows = [
        (run_id, started_at, batch, nodeid, folder_of(nodeid), outcome, float(duration or 0.0))
        for nodeid, outcome, duration in results
    ]
    if not rows:
        return 0
    with closing(connect(path)) as conn:
        conn.executemany(
            "INSERT INTO runs (run_id, started_at, batch, nodeid, folder, outcome, duration_s)"
            " VALUES (?, ?, ?, ?, ?, ?, ?)",
            rows,
        )
        conn.commit()
    return len(rows)


def last_run_by_folder(path=None):
    """每個資料夾最後一次執行的摘要：{folder: {date, batch, run_id, passed, failed, other}}。"""
    path = path or db_path()
    if not os.path.exists(path):
        return {}
    try:
        check_path(path)
    except LinkedPathError:
        return {}   # 連到別處的資料庫不讀（不得把別的專案的執行紀錄匯進本專案 CATALOG）
    out = {}
    with closing(connect(path)) as conn:
        latest = conn.execute(
            "SELECT folder, MAX(started_at) FROM runs GROUP BY folder"
        ).fetchall()
        for folder, started_at in latest:
            # MAX(started_at) 與同列其他欄未必同筆，重新取該時間點的 run_id
            row = conn.execute(
                "SELECT run_id FROM runs WHERE folder = ? AND started_at = ?"
                " ORDER BY id DESC LIMIT 1",
                (folder, started_at),
            ).fetchone()
            rid = row[0] if row else ""
            counts = dict(conn.execute(
                "SELECT outcome, COUNT(*) FROM runs WHERE folder = ? AND run_id = ? GROUP BY outcome",
                (folder, rid),
            ).fetchall())
            batch_row = conn.execute(
                "SELECT batch FROM runs WHERE folder = ? AND run_id = ? LIMIT 1", (folder, rid)
            ).fetchone()
            out[folder] = {
                "date": (started_at or "")[:10],
                "batch": batch_row[0] if batch_row else "",
                "run_id": rid,
                "passed": counts.get("passed", 0),
                "failed": counts.get("failed", 0),
                "other": sum(v for k, v in counts.items() if k not in ("passed", "failed")),
            }
    return out


def count_rows(path=None):
    path = path or db_path()
    if not os.path.exists(path):
        return 0
    with closing(sqlite3.connect(path)) as conn:
        return conn.execute("SELECT COUNT(*) FROM runs").fetchone()[0]


def new_run_id():
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%f")


def utc_now_iso():
    # 微秒精度：同一秒內開始的兩輪，「最後執行」要以真正較晚開始的那輪為準
    return datetime.now(timezone.utc).isoformat(timespec="microseconds")
