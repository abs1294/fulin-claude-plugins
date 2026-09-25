"""hardcode_check 泛用版與跳脫註記。

每類放一個違規樣本 → 逐類命中；每種豁免樣本 → 不命中；每種註記缺理由或格式錯 → 不放行。
"""
import re

import pytest


def counts(r):
    out = {}
    for m in re.finditer(r"^=== ([^\s（]+).*?：(\d+) 處", r.stdout, re.M):
        out[m.group(1)] = int(m.group(2))
    return out


def scan(p, body, rel="orders/test_x.py", *args):
    p.write(rel, body)
    return p.tool("hardcode_check.py", "all", *args)


# ---------------- 各類命中 ----------------

@pytest.mark.parametrize("label,body,blocking", [
    ("A", "ORDER_ID = 1133\n", True),
    ("B", "import pytest\n\ndef test_x():\n    pytest.skip('請先跑 seed_orders.sql 再執行')\n", True),
    ("B", "def test_x():\n    print('run seed/orders.sql first')\n", True),
    ("C", "def test_x():\n    pass\n    # teardown：還原成原值\n", False),
    ("E", "def test_x(db):\n    db.execute(\"INSERT INTO orders (title) VALUES ('x')\")\n", True),
    ("E", "def test_x(db):\n    db.execute(\"UPDATE orders SET title = 'x' WHERE id = 1\")\n", True),
    ("E", "def test_x(db):\n    db.execute(\"\"\"UPDATE o SET o.title = 'x'\n        FROM dbo.orders o WHERE o.id = 1\"\"\")\n", True),
    ("E'", "def test_x(db):\n    db.execute(\"INSERT INTO users (name) VALUES ('x')\")\n", False),
    ("F", "def test_x(page):\n    login(page, username=\"JDOE\")\n", True),
    ("F", "def test_x(api):\n    api.post('/o', json={'owner': 'alice@corp.example-mail.com'})\n", True),
    ("F'", "def test_x(order):\n    assert order.owner == \"JDOE\"\n", False),
    ("G", "from helpers import identity\n\ndef make_order(api, owner=None):\n    if owner is None:\n"
          "        owner = identity.current_alias()\n    return api.post('/orders', json={\"owner\": owner})\n", False),
    ("H", "def test_x(db):\n    row = db.query(\"SELECT TOP 1 id FROM orders WHERE status = 'open'\")\n", True),
    ("H", "def test_x(db):\n    row = db.query(\"SELECT id FROM orders WHERE status = 'open' LIMIT 1\")\n", True),
])
def test_each_class_hits(installed, label, body, blocking):
    r = scan(installed, body)
    c = counts(r)
    assert c.get(label) == 1, (label, c, r.stdout)
    assert r.returncode == (1 if blocking else 0), r.stdout


def test_shared_helper_borrow_is_H_prime(installed):
    r = scan(installed, "def pick(db):\n    return db.query(\"SELECT TOP 1 id FROM orders WHERE x = 'y'\")\n",
             "helpers/orders.py")
    assert counts(r).get("H'") == 1 and r.returncode == 0, r.stdout


def test_vendor_code_class_not_ported(installed):
    """專案版 D 類（特定業務代碼格式）刻意不搬：字串代碼不在任何類別。"""
    r = scan(installed, "VENDOR = \"0XY123456\"\n\ndef test_x():\n    pass\n")
    assert r.returncode == 0 and counts(r) == {}, r.stdout


# ---------------- 豁免：命名慣例（缺陷 2：與 hook 提示同源）----------------

@pytest.mark.parametrize("prefix", ["NONEXISTENT", "PLACEHOLDER", "MISSING", "NOT_FOUND",
                                    "INVALID", "FAKE", "DUMMY", "BAD"])
def test_intentional_prefixes_exempt(installed, prefix):
    r = scan(installed, "%s_ORDER_ID = 999\n" % prefix)
    assert r.returncode == 0 and "A" not in counts(r), r.stdout


def test_intentional_prefix_list_comes_from_config(installed):
    installed.config(intentional_prefixes=["GHOST"])
    r = scan(installed, "GHOST_ORDER_ID = 1\nBAD_ORDER_ID = 2\n")
    c = counts(r)
    assert c.get("A") == 1 and "BAD_ORDER_ID" in r.stdout and "GHOST_ORDER_ID" not in r.stdout.split("修法")[0]
    assert "刻意值命名慣例（qa-webwright.json intentional_prefixes，工具自動不列）：GHOST_*" in r.stdout


def test_dict_hint_and_fake_identity_exempt(installed):
    body = ("STATUS_ID = 3\nROLE_ID = 1\n\ndef test_x(page, api):\n    login(page, username=\"QAUSER1\")\n"
            "    api.post('/o', json={'owner': 'bob@example.com'})\n")
    r = scan(installed, body)
    assert r.returncode == 0 and counts(r) == {}, r.stdout


# ---------------- 豁免：註解與 docstring 不計 ----------------

def test_comments_and_docstrings_not_counted(installed):
    body = ('"""模組說明：以前寫死 ORDER_ID = 1133，也曾 INSERT INTO orders，owner="JDOE"。\n'
            'SELECT TOP 1 id FROM orders WHERE x=\'y\'\n"""\n'
            "# ORDER_ID = 1133\n# db.execute(\"INSERT INTO orders VALUES (1)\")\n\n"
            "def test_x():\n    \"\"\"不可寫 login(username=\"JDOE\")。\"\"\"\n    pass\n")
    r = scan(installed, body)
    assert r.returncode == 0 and counts(r) == {}, r.stdout


def test_sql_in_triple_quoted_argument_is_code(installed):
    body = 'def test_x(db):\n    db.execute("""\n        INSERT INTO orders (title) VALUES (\'x\')\n    """)\n'
    r = scan(installed, body)
    assert counts(r).get("E") == 1, r.stdout


# ---------------- 豁免：SCAN-REVIEWED ----------------

def test_scan_reviewed_safe_above(installed):
    body = "# SCAN-REVIEWED: safe — 對外文件的示範 id，不會查 DB\nORDER_ID = 1133\n"
    r = scan(installed, body)
    c = counts(r)
    assert r.returncode == 0 and "A" not in c and c.get("已覆核") == 1, r.stdout


def test_scan_reviewed_in_function_docstring(installed):
    body = ('def seed(db):\n    """造一筆上游推送才有的訂單。\n\n'
            '    # SCAN-REVIEWED: safe — 該狀態只由上游 webhook 產生，產品端沒有入口\n    """\n'
            '    db.execute("INSERT INTO orders (title) VALUES (\'E2E-x\')")\n')
    r = scan(installed, body)
    assert r.returncode == 0 and "E" not in counts(r), r.stdout


@pytest.mark.parametrize("note", [
    "# SCAN-REVIEWED: safe",                     # 缺理由
    "# SCAN-REVIEWED: safe —",                   # 缺理由
    "# SCAN-REVIEWED: ok — 看過了沒問題",           # 結論不是 safe|real
    "# SCAN-REVIEWED safe — 少了冒號",             # 格式錯
])
def test_scan_reviewed_malformed_not_exempt(installed, note):
    r = scan(installed, "%s\nORDER_ID = 1133\n" % note)
    c = counts(r)
    assert r.returncode == 1 and c.get("A") == 1, r.stdout
    if "REVIEWED:" in note:
        assert c.get("覆核註記格式錯誤") == 1, r.stdout


def test_scan_reviewed_too_far_above(installed):
    body = ("# SCAN-REVIEWED: safe — 太遠了\n# 1\n# 2\n# 3\n# 4\n# 5\nORDER_ID = 1133\n")
    r = scan(installed, body)
    assert counts(r).get("A") == 1, r.stdout


def test_scan_reviewed_real_still_listed(installed):
    r = scan(installed, "# SCAN-REVIEWED: real — 已開單追蹤，下個迭代改自種\nORDER_ID = 1133\n")
    assert r.returncode == 1 and "[已覆核 real]" in r.stdout, r.stdout


# ---------------- 豁免：G-REVIEWED ----------------

G_BODY = ("from helpers import identity\n\ndef make_order(api, owner=None):\n{note}    if owner is None:\n"
          "        owner = identity.current_alias()\n    return api.post('/orders', json={{\"owner\": owner}})\n")


def test_g_reviewed_safe_with_evidence_and_date(installed):
    note = "    # G-REVIEWED: safe — 後端 OrderCommand.owner 標 JsonIgnore，由 token 灌入（2026-09-20）\n"
    r = scan(installed, G_BODY.format(note=note))
    c = counts(r)
    assert "G" not in c and c.get("已覆核") == 1, r.stdout


@pytest.mark.parametrize("note", [
    "    # G-REVIEWED: safe — 後端標 JsonIgnore\n",               # 缺日期
    "    # G-REVIEWED: safe（2026-09-20）\n",                     # 缺證據
    "    # G-REVIEWED: maybe — 不確定（2026-09-20）\n",            # 結論錯
])
def test_g_reviewed_malformed(installed, note):
    r = scan(installed, G_BODY.format(note=note))
    c = counts(r)
    assert c.get("G") == 1 and c.get("覆核註記格式錯誤") == 1, r.stdout


# ---------------- 豁免：E 類整檔三條件（【測試資料來源】）----------------

WHY_OK = ('"""【測試資料來源】訂單的「已出貨」狀態只由上游推送 webhook 產生，產品端沒有入口，故以 SQL 自種。\n"""\n')
SEED_OK = ("def test_x(db):\n    cur = db.execute(\"INSERT INTO orders (title) VALUES ('E2E-ship')\")\n"
           "    oid = cur.lastrowid\n    try:\n        pass\n    finally:\n"
           "        db.execute(\"DELETE FROM orders WHERE id = %d\" % oid)\n")


def test_data_source_exemption_all_three(installed):
    r = scan(installed, WHY_OK + SEED_OK)
    assert r.returncode == 0 and "E" not in counts(r), r.stdout


def test_data_source_exemption_missing_why_keyword(installed):
    why = '"""【測試資料來源】跑產品流程太麻煩，直接 SQL 比較快。\n"""\n'
    r = scan(installed, why + SEED_OK)
    assert counts(r).get("E") == 1 and r.returncode == 1, r.stdout


def test_data_source_exemption_missing_cleanup(installed):
    body = WHY_OK + "def test_x(db):\n    cur = db.execute(\"INSERT INTO orders (title) VALUES ('E2E-ship')\")\n"
    r = scan(installed, body)
    assert counts(r).get("E") == 1, r.stdout


def test_data_source_exemption_missing_tag(installed):
    r = scan(installed, '"""訂單只由上游推送 webhook 產生。\n"""\n' + SEED_OK)
    assert counts(r).get("E") == 1, r.stdout


def test_write_inside_finally_is_restore(installed):
    body = ("def test_x(db):\n    old = db.query('SELECT title FROM orders WHERE id = ?', (1,))\n    try:\n"
            "        pass\n    finally:\n        if old:\n"
            "            db.execute(\"UPDATE orders SET title = ? WHERE id = 1\", (old,))\n")
    r = scan(installed, body)
    assert "E" not in counts(r), r.stdout


# ---------------- H 類豁免 ----------------

def test_borrow_bound_or_seeded_is_ok(installed):
    body = ("def test_bound(db, oid):\n    db.query(\"SELECT TOP 1 id FROM orders WHERE id = ?\", (oid,))\n\n"
            "def test_seeded(db):\n    rows = db.query(\"SELECT TOP 1 id FROM orders WHERE status = 'open'\")\n"
            "    return rows[0] if rows else create_order(db)\n")
    r = scan(installed, body)
    assert "H" not in counts(r), r.stdout


# ---------------- 輸出與參數 ----------------

def test_md_output(installed, tmp_path):
    out = tmp_path / "report.md"
    r = scan(installed, "ORDER_ID = 1\n", "orders/test_x.py", "--md", str(out))
    text = out.read_text(encoding="utf-8")
    assert "## 總計" in text and "orders/test_x.py" in text and "| 是 |" in text
    assert r.returncode == 1


def test_probe_flag_removed(installed):
    """--probe 在泛用版不提供，明確拒絕而不是靜默忽略。"""
    r = installed.tool("hardcode_check.py", "all", "--probe")
    assert r.returncode == 2 and "--probe" in r.stdout
    src = (installed.e2e / "tools" / "hardcode_check.py").read_text(encoding="utf-8")
    usage = src.split("## 類別")[0]
    assert "--probe" not in usage  # 用法段不再宣稱有 --probe


def test_extra_blocking_promotes_reference_class(installed):
    installed.config(hardcode=dict(installed.config()["hardcode"], extra_blocking=["AUTOFILL"]))
    r = scan(installed, G_BODY.format(note=""))
    assert r.returncode == 1 and "G" in r.stdout.split("阻擋類（")[1].split("）")[0], r.stdout


def test_review_db(installed):
    import sqlite3
    scan(installed, G_BODY.format(note=""))
    r = installed.tool("hardcode_check.py", "all", "--review-db")
    assert "[review-db]" in r.stdout
    con = sqlite3.connect(str(installed.e2e / ".runs" / "results.sqlite"))
    assert con.execute("SELECT status FROM hygiene_g_reviews").fetchall() == [("pending",)]
    con.close()


def test_biz_tables_from_config(installed):
    installed.config(biz_tables=["invoices"])
    body = "def test_x(db):\n    db.execute(\"INSERT INTO orders (t) VALUES (1)\")\n"
    r = scan(installed, body)
    assert "E" not in counts(r)
    r = scan(installed, body.replace("orders", "invoices"))
    assert counts(r).get("E") == 1


def test_snip_masks_bearer_and_url_credentials():
    """違規清單的片段可能轉交他人：Bearer／Basic 值與網址內嵌帳密要遮罩，其他內容保留。"""
    import importlib
    import sys
    import pathlib
    sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "skills" / "browser-qa" / "tools"))
    h = importlib.import_module("hardcode_check")
    assert h._snip('headers = {"Authorization": "Bearer abc.def.ghi"}') == 'headers = {"Authorization": "Bearer ***"}'
    assert h._snip("auth = 'Basic dXNlcjpwYXNz'") == "auth = 'Basic ***'"
    # 帳密命名的變數（底線、大寫）與同行有 Authorization 的純字母 Bearer 值也要遮
    assert h._snip('basic_auth = "Basic dXNlcjpwYXNz"') == 'basic_auth = "Basic ***"'
    assert h._snip('AUTH_HEADER = "Basic dXNlcjpwYXNz"') == 'AUTH_HEADER = "Basic ***"'
    assert h._snip('h = {"Authorization": "Bearer abcdefghij"}') == 'h = {"Authorization": "Bearer ***"}'
    assert h._snip('API = "https://bob:Hunter2@api.example.com/v1"') == 'API = "https://bob:***@api.example.com/v1"'
    assert h._snip('URL = "https://api.example.com:8443/v1"') == 'URL = "https://api.example.com:8443/v1"'
    assert h._snip('token = "s3cr3t"') == 'token = "***"'
    assert h._snip('{"a": "BEARER tok123"}') == '{"a": "BEARER ***"}'
    # 一般英文與非帳密網址不得被遮
    for s in ['assert page.title == "Basic info"', '# Basic flow test for login', 'doc = "Bearer tokens expire"',
              'REPO = "ssh://git@github.com/org/repo"', 'mail = "user@example.com"', 'URL = "http://localhost:8080/api"']:
        assert h._snip(s) == s, s
