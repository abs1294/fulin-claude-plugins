"""測試殘留清掃器：依測試資料前綴（預設 `E2E-`）掃描測試造的髒資料。**預設 dry-run**。

用法（於 tests/e2e 下）：
    python tools/sweep_residue.py                       # dry-run，列命中清單
    python tools/sweep_residue.py --older-than-days 7   # 只列 7 天前造的（需該表設 created_column）
    python tools/sweep_residue.py --apply               # 真刪（刪前重查；子表先刪）

登錄表與 DB 連線讀 tests/e2e/qa-webwright.json：

    "test_data_prefix": "E2E-",
    "residue": {"targets": [
      {"table": "orders", "marker_column": "title", "pk_column": "id", "created_column": "created_at",
       "children": [{"table": "order_items", "fk_column": "order_id"}]}
    ]},
    "db": {"connector": "sqlite:.runs/demo.sqlite"}      // 或 "mypkg.mydb:connect"

connector 可插拔，不綁任何 DB 用戶端：
  - `sqlite:<路徑>`（相對 tests/e2e）——內建，供示範與自測
  - `<module>:<factory>`——factory() 回傳物件，需有
        query(sql, params) -> list[tuple]   與   execute(sql, params) -> None
    參數佔位符用 `?`；若你的驅動用 %s，請在 adapter 內轉換。
    另可提供 begin() / commit() / rollback()：有就把「複查＋刪除」包成一個交易。

收錄紀律：只收「查得到測試確實會寫入」證據的表；查證不到寫入路徑的，寧缺勿濫。
安全欄：
  - 前綴當**字面值**比對：LIKE 前把 % _ 與跳脫字元本身跳脫（ESCAPE），取回後再用 Python startswith 精確複核。
  - --apply 前重跑同一查詢，命中集合與剛才列出的不一致就本表本輪不刪。
  - 複查＋子表刪除＋主表刪除包在同一個交易裡：任何一步失敗整批回滾（子表不會先被刪掉）；
    connector 沒提供交易介面時照舊執行，但會明講「非原子」。
  - --older-than-days 但該表沒設 created_column → 無法判斷年齡，**本表本輪只列不刪**。
  - 年齡在 Python 端判斷（不在 SQL 裡拿字串比）：created_column 可存日期時間字串、datetime 或 epoch 秒／毫秒整數；
    值讀不懂的列算「年齡不明」，不列入命中（寧可少刪）。
  - sqlite:<路徑> 的檔不存在 → 明確報錯（不讓 sqlite3 默默建出空檔）。
"""
import argparse
import importlib
import os
import sqlite3
import sys
from datetime import datetime, timedelta, timezone

try:
    from . import qa_config
except ImportError:
    import qa_config

IDENT_OK = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.[]\"`")
ESC = "!"   # LIKE 的跳脫字元（不用反斜線：各 DB 對字串內反斜線的處理不一）


class SqliteConnector(object):
    def __init__(self, path):
        self.conn = sqlite3.connect(path, isolation_level=None)   # 交易由 begin/commit 明確控制
        self.in_tx = False

    def query(self, sql, params=()):
        return list(self.conn.execute(sql, params).fetchall())

    def execute(self, sql, params=()):
        self.conn.execute(sql, params)

    def begin(self):
        self.conn.execute("BEGIN IMMEDIATE")
        self.in_tx = True

    def commit(self):
        self.conn.execute("COMMIT")
        self.in_tx = False

    def rollback(self):
        if self.in_tx:
            self.conn.execute("ROLLBACK")
        self.in_tx = False


def make_connector(cfg):
    spec = (cfg.get("db") or {}).get("connector")
    if not spec:
        raise SystemExit("[sweep] 參數檔 db.connector 未設定——不知道怎麼連 DB。"
                         "設成 \"sqlite:<路徑>\" 或 \"<module>:<factory>\"（見本檔 docstring）。")
    if spec.startswith("sqlite:"):
        path = spec[len("sqlite:"):]
        if not os.path.isabs(path):
            path = os.path.join(cfg.root, path)
        if not os.path.isfile(path):
            raise SystemExit("[sweep] db.connector 指到的 SQLite 檔不存在：%s（不自動建立空檔）" % spec[len("sqlite:"):])
        return SqliteConnector(path)
    if ":" not in spec:
        raise SystemExit("[sweep] db.connector 格式錯誤：%s（應為 module:factory 或 sqlite:<路徑>）" % spec)
    mod, fn = spec.split(":", 1)
    sys.path.insert(0, cfg.root)
    return getattr(importlib.import_module(mod), fn)()


def _ident(name):
    if not name or any(ch not in IDENT_OK for ch in name):
        raise SystemExit("[sweep] 登錄表的表名／欄名含不允許字元：%r" % name)
    return name


def target_problems(targets):
    """開始碰 DB 前先驗完所有登錄表的表名／欄名（子表也算）：不得刪到一半才發現下一張表名不合法。"""
    bad = []
    for t in targets:
        names = [t.get("table"), t.get("marker_column"), t.get("pk_column")]
        if t.get("created_column"):
            names.append(t.get("created_column"))
        for c in t.get("children") or []:
            names += [c.get("table"), c.get("fk_column")]
        for n in names:
            if not n or not isinstance(n, str) or any(ch not in IDENT_OK for ch in n):
                bad.append("%s：%r" % (t.get("table"), n))
    return bad


def _non_negative(v):
    import argparse as _ap
    try:
        n = int(v)
    except ValueError:
        raise _ap.ArgumentTypeError("必須是整數：%r" % v)
    if n < 0:
        raise _ap.ArgumentTypeError("不得為負數：%d（負數會讓年齡條件失效、刪到新資料）" % n)
    return n


def like_prefix(prefix):
    """前綴 → LIKE 樣式：% _ 與跳脫字元本身都當字面值（搭配 ESCAPE '!'）。"""
    esc = prefix.replace(ESC, ESC + ESC).replace("%", ESC + "%").replace("_", ESC + "_")
    return esc + "%"


def _as_utc(v):
    """created_column 的值 → aware datetime（UTC）；讀不懂回 None。
    支援 datetime、日期時間字串（ISO／'YYYY-MM-DD HH:MM:SS'，無時區視為 UTC）、epoch 秒或毫秒（整數／數字字串）。"""
    if v is None or isinstance(v, bool):
        return None
    if isinstance(v, datetime):
        return v if v.tzinfo else v.replace(tzinfo=timezone.utc)
    if isinstance(v, (int, float)) or (isinstance(v, str) and v.strip().isdigit()):
        n = float(v)
        if n > 1e11:          # 毫秒
            n /= 1000.0
        try:
            return datetime.fromtimestamp(n, timezone.utc)
        except (OverflowError, OSError, ValueError):
            return None
    if isinstance(v, str):
        s = v.strip().replace("Z", "+00:00")
        try:
            d = datetime.fromisoformat(s.replace(" ", "T", 1) if len(s) > 10 else s)
        except ValueError:
            return None
        return d if d.tzinfo else d.replace(tzinfo=timezone.utc)
    return None


def select_hits(db, target, prefix, older_than_days=0, unknown_age=None):
    """回 (rows, deletable)。--older-than-days 但沒設 created_column → deletable=False（無法判斷年齡）。
    年齡在 Python 端比（epoch 整數與字串在 SQL 裡比大小會失真）；讀不懂的列放進 unknown_age（list）、不列入命中。"""
    table = _ident(target["table"])
    marker = _ident(target["marker_column"])
    pk = _ident(target["pk_column"])
    created = target.get("created_column") if older_than_days > 0 else None
    cols = "%s, %s" % (pk, marker) + (", %s" % _ident(created) if created else "")
    sql = "SELECT %s FROM %s WHERE %s LIKE ? ESCAPE '%s'" % (cols, table, marker, ESC)
    params = [like_prefix(prefix)]
    deletable = not (older_than_days > 0 and not created)
    sql += " ORDER BY %s" % pk
    got = db.query(sql, tuple(params))
    # 雙保險：LIKE 的行為因 DB 而異（大小寫、ESCAPE 支援），取回後再精確比對前綴
    got = [r for r in got if str(r[1] or "").startswith(prefix)]
    if not created:
        return [(r[0], r[1]) for r in got], deletable
    cutoff = datetime.now(timezone.utc) - timedelta(days=older_than_days)
    rows = []
    for r in got:
        at = _as_utc(r[2])
        if at is None:
            if unknown_age is not None:
                unknown_age.append((r[0], r[1]))
        elif at < cutoff:
            rows.append((r[0], r[1]))
    return rows, deletable


# 單句 SQL 的 id 參數上限：各 DB／驅動的綁定參數上限不同（舊版 SQLite 999），分批刪（仍在同一個交易裡）
CHUNK = 500


def apply_delete(db, target, prefix, ids):
    table = _ident(target["table"])
    marker = _ident(target["marker_column"])
    pk = _ident(target["pk_column"])
    for k in range(0, len(ids), CHUNK):
        part = list(ids[k:k + CHUNK])
        marks = ",".join("?" for _ in part)
        for child in target.get("children") or []:
            # 子表刪除時再比對一次主表 marker（子查詢）：複查後主表那列若被改掉前綴，就不動它的子表
            db.execute("DELETE FROM %s WHERE %s IN (SELECT %s FROM %s WHERE %s IN (%s) AND %s LIKE ? ESCAPE '%s')"
                       % (_ident(child["table"]), _ident(child["fk_column"]), pk, table, pk, marks, marker, ESC),
                       tuple(part) + (like_prefix(prefix),))
        # 雙重保險：id 清單之外仍要求 marker 帶前綴（字面值比對）
        db.execute("DELETE FROM %s WHERE %s IN (%s) AND %s LIKE ? ESCAPE '%s'" % (table, pk, marks, marker, ESC),
                   tuple(part) + (like_prefix(prefix),))


def _has_tx(db):
    return all(callable(getattr(db, n, None)) for n in ("begin", "commit", "rollback"))


def main(argv=None, db=None):
    qa_config.force_utf8_stdio()
    cfg = qa_config.load_or_exit()
    ap = argparse.ArgumentParser(description="測試殘留清掃（預設 dry-run）")
    ap.add_argument("--apply", action="store_true", help="真刪；預設僅列清單")
    ap.add_argument("--older-than-days", type=_non_negative, default=0)
    args = ap.parse_args(argv)
    prefix = cfg.get("test_data_prefix") or ""
    if len(prefix) < 2:
        print("[sweep] test_data_prefix 太短（%r），拒絕執行——前綴太寬會掃到真資料。" % prefix)
        return 2
    targets = (cfg.get("residue") or {}).get("targets") or []
    if not targets:
        print("[sweep] 參數檔 residue.targets 為空，沒有可掃描的表。")
        return 0
    bad = target_problems(targets)
    if bad:
        print("[sweep] 登錄表的表名／欄名含不允許字元，整批不執行（一筆都沒刪）：%s" % "、".join(bad))
        return 2
    db = db or make_connector(cfg)
    total_hits = total_deleted = 0
    failed = False
    for t in targets:
        unknown = []
        rows, deletable = select_hits(db, t, prefix, args.older_than_days, unknown)
        print("\n[%s] marker=%s 命中 %d 筆" % (t["table"], t["marker_column"], len(rows)))
        for pk_val, marker_val in rows:
            print("    id=%s  %s=%r" % (pk_val, t["marker_column"], marker_val))
        if unknown:
            print("    [略過] %d 筆的 %s 值讀不懂（不是日期時間／epoch），年齡不明、不列入命中：id=%s"
                  % (len(unknown), t.get("created_column"), "、".join(str(u[0]) for u in unknown[:10])))
        total_hits += len(rows)
        if not deletable:
            print("    [SKIP] 指定了 --older-than-days 但 %s 未設 created_column——無法判斷年齡，"
                  "本表本輪只列不刪（在 residue.targets 補 created_column 才會套年齡條件）" % t["table"])
            continue
        if not args.apply or not rows:
            continue
        tx = _has_tx(db)
        if not tx:
            print("    [注意] connector 沒提供 begin()/commit()/rollback()——子表與主表的刪除不是原子操作")
        try:
            if tx:
                db.begin()
            recheck, _ok = select_hits(db, t, prefix, args.older_than_days)
            if sorted(r[0] for r in recheck) != sorted(r[0] for r in rows):
                if tx:
                    db.rollback()
                print("    [SKIP] 複查命中集合不一致（%d → %d），本表本輪不刪，請重跑掃描" % (len(rows), len(recheck)))
                continue
            ids = [r[0] for r in recheck]
            apply_delete(db, t, prefix, ids)
            if tx:
                db.commit()
        except Exception as exc:  # noqa: BLE001 — 任一步失敗：整批回滾、明講、不假裝成功
            state = "（connector 沒有交易介面，先前的刪除可能已生效，請人工確認）"
            rolled_back = not tx
            if tx:
                try:
                    db.rollback()
                    state = "，已回滾"
                    rolled_back = True
                except Exception as rexc:  # noqa: BLE001
                    state = "，回滾失敗（%s: %s）——資料可能已部分刪除，請人工確認" % (type(rexc).__name__, rexc)
            print("    [ERROR] %s 刪除失敗%s（%s: %s）" % (t["table"], state, type(exc).__name__, exc))
            failed = True
            if not rolled_back:
                # 交易狀態不明：繼續處理下一張表可能在同一個未結束的交易裡刪、再被後面的 commit 一起提交 → 停止
                print("    [STOP] 回滾失敗，後續登錄表本輪不處理")
                break
            continue
        print("    [DELETED] %s 實刪 %d 筆（子表 %d 張先刪）" % (t["table"], len(ids), len(t.get("children") or [])))
        total_deleted += len(ids)
    print("\n[%s] 掃描表數=%d  命中總筆數=%d  實刪總筆數=%d"
          % ("APPLY" if args.apply else "DRY-RUN", len(targets), total_hits, total_deleted))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
