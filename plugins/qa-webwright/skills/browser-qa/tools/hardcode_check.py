"""測試資產硬編檢查：掃出「換一個庫、換一顆 token、清空業務資料就死」的測試。

用法（於 tests/e2e 下）：
    python tools/hardcode_check.py all
    python tools/hardcode_check.py <folder|.>
    python tools/hardcode_check.py all --md <路徑>       # 另輸出逐檔違規清單 markdown（全量）
    python tools/hardcode_check.py all --review-db       # G 類覆核狀態寫進 .runs/results.sqlite（衍生總表）
    python tools/hardcode_check.py <folder> --baseline   # 只擋 baseline 以外的新增（接閘用）
    python tools/hardcode_check.py all --write-baseline --why "<清掉了什麼>"
    python tools/hardcode_check.py all --write-baseline --why "<判準改了>" --allow-raise

總判準：**換 token、換身分、清空業務資料只留 schema 與字典，測試都要能跑過。**
「宣告一個常數讓大家引用」不算修好——常數仍是寫死，換身分還是要人工同步、還是會漏。

## 類別（業務表清單、刻意值前綴、假身分前綴等一律讀 tests/e2e/qa-webwright.json）

  A  業務資料列 Id 寫死（HARD，阻擋）        `ORDER_ID = 1133` → DB 重建即失效
  B  外部種子 SQL 依賴（SEED，阻擋）          明講「要先人工跑 xxx.sql」→ 換機器／換庫就死
  C  teardown 還原他人資料（RESTORE，參考）  靠註解字樣命中，計數不可靠；真正判準是「資料是不是
                                             測試自己造的」，regex 看不出來。只當「值得人工看一眼」清單，
                                             **不要當待辦數字追、也不要拿它衡量改善**
  E  直寫業務主體表（DBWRITE，阻擋）         測試自己 INSERT/UPDATE 造被測狀態，繞過產品入口——
                                             造出來的欄位組合可能是產品永遠不會產生的狀態
  E' 直寫骨架／字典表（DBWRITE_SKELETON，參考）
  F  寫死帳號／信箱（ALIAS，阻擋）           換一顆 token 就全垮
  F' 帳號出現在斷言（ALIAS_ASSERT，參考）    多為 mock 固定值，逐案判
  G  helper 替產品補欄位（AUTOFILL，參考）   `if x is None: x = identity.current_x()` 且 x 進 payload／SQL——
                                             打了產品端點但自己補參數，只是借用端點，會遮蔽「產品不填該欄位」的缺陷
  H  借一筆現成的（HBORROW，阻擋）           `SELECT TOP 1 / LIMIT 1 … FROM <業務表>` 未綁定自造列、且查無沒有自種後路
                                             ——滿庫有效、空庫直接死（最容易被誤認已修好的階段）
  H' 同 H 但在共用層（HBORROW_SHARED，參考） 共用 helper 波及全庫，而閘只驗「這次寫入的那一支檔」，另軌處理

（專案版另有「特定業務代碼格式寫死」的 D 類，格式因專案而異，不在泛用版；帳號類由 F 涵蓋。）

## 跳脫機制（每種都有自測）

  - 刻意值命名慣例：名稱含 intentional_prefixes（預設 NONEXISTENT/PLACEHOLDER/MISSING/NOT_FOUND/
    INVALID/FAKE/DUMMY/BAD）的 A/F 類不列。想讓工具閉嘴就得改成這種名字——那本身就是在宣告「這是刻意的」。
  - 假身分前綴：fake_identity_prefixes（預設 QA/E2E/ZZ/MOCK/DUMMY/FAKE/TEST）開頭的帳號不列。
  - 註解與 docstring 內的命中不計（C 類例外：它本來就靠註解字樣命中）。
  - `# SCAN-REVIEWED: <safe|real> — <理由>`：放在命中行上方最多 4 行的連續註解，或所屬函式 docstring。
    safe＝已覆核為合法例外，不再列入；real＝已覆核為真違規，**照列**（附註記）。缺理由或格式錯不放行，
    並列入「覆核註記格式錯誤」提醒。
  - `# G-REVIEWED: <safe|real> — <產品端證據>（YYYY-MM-DD）`：G 類專用，理由要寫產品端證據
    （handler 檔名行號、annotation、型別約束），不是「我看過了」。缺日期或理由不放行。
  - E 類整檔豁免（三條全中）：① 造的資料認得出來（SCOPE_IDENTITY／唯一前綴／marker／條件式精準刪）
    ② 有對稱清理（DELETE／cleanup／purge）③ 有 data_source_tags（預設【測試資料來源】）理由段，
    且理由段落在 external_system_keywords 某一類外部系統邊界內（產品端根本沒有入口）。
    「跑起來麻煩／跨站要兩個前端」不是理由——產品有入口就該走入口。
  - `finally:` 區塊內的寫入＝結構上就是還原／清理，E 類不列。

## 阻擋類與升級規則

阻擋類（計入 exit code）：A、B、E、F、H。其餘為參考清單。參考類升為阻擋類走**事件驅動**，不看日曆：
  條件 A：連續 N 次 `--baseline` 跑出「新增 0」（證明沒人在寫新的）
  條件 B：抽驗 15 處逐處開檔覆核零誤判（第一次沒過就修判準、換樣本重抽）
兩者都成立才在參數檔 hardcode.extra_blocking 加入該類。閘被雜訊淹沒三天內就會被關掉，
所以寧可晚升級，不要誤擋正確寫法。共用層（H'）另需一次全庫實跑的前後對照。

（專案版 docstring 提過的 `--probe` 連 DB 實查模式在泛用版**不提供**；傳入會明確報錯。）

全乾淨 exit 0；有阻擋類命中 exit 1；參數錯誤／拒寫 baseline exit 2。
"""
import argparse
import ast
import os
import re
import sys

try:
    from . import baseline as bl
    from . import qa_config
except ImportError:
    import baseline as bl
    import qa_config

TOOL = "hardcode"

ORDER = ("HARD", "SEED", "RESTORE", "DBWRITE", "DBWRITE_SKELETON", "ALIAS", "ALIAS_ASSERT",
         "AUTOFILL", "HBORROW", "HBORROW_SHARED", "REVIEWED", "REVIEW_MALFORMED")
LABELS = {
    "HARD": "A 業務資料列 Id 寫死（DB 重建即失效）",
    "SEED": "B 外部種子 SQL 依賴（要人工先跑）",
    "RESTORE": "C teardown 還原他人資料（參考：只能刪自己造的）",
    "DBWRITE": "E 直接寫入業務主體表（繞過產品入口）",
    "DBWRITE_SKELETON": "E' 直接寫入骨架／字典表（參考：風險較低，仍應走產品入口）",
    "ALIAS": "F 寫死帳號／信箱（換一顆 token 就全垮）",
    "ALIAS_ASSERT": "F' 帳號出現在斷言（參考：多為 mock 固定值，逐案判）",
    "AUTOFILL": "G helper 替產品補欄位（參考：測試資料比產品產出完美，遮蔽缺陷）",
    "HBORROW": "H 借一筆現成的（滿庫有效、空庫直接死；查無沒有自種後路）",
    "HBORROW_SHARED": "H' 同上但在共用層（參考：改動波及全庫，另軌處理）",
    "REVIEWED": "已覆核 safe（帶 SCAN-REVIEWED／G-REVIEWED safe 註記，僅供清點）",
    "REVIEW_MALFORMED": "覆核註記格式錯誤（缺理由／缺日期／結論不是 safe|real，未放行）",
}
BASE_BLOCKING = ("HARD", "SEED", "DBWRITE", "ALIAS", "HBORROW")
REAL_TAG = "[已覆核 real] "

SCAN_REVIEWED_RE = re.compile(r"#\s*SCAN-REVIEWED:\s*(safe|real)\s*[—–-]+\s*(\S.{3,})", re.I)
G_REVIEWED_RE = re.compile(
    r"#\s*G-REVIEWED:\s*(safe|real)\s*[—–-]+\s*(\S.{3,}?)\s*[（(]\s*(\d{4}-\d{2}-\d{2})\s*[）)]", re.I)
ANY_REVIEW_RE = re.compile(r"#\s*(SCAN|G)-REVIEWED\b", re.I)

SEED_RE = re.compile(
    r"先跑[^\n]{0,20}\.sql|人工[^\n]{0,20}\.sql|手動[^\n]{0,20}\.sql|需要?先執行[^\n]{0,20}\.sql"
    r"|請先[^\n]{0,20}\.sql|run\s+[\w./\\-]*\.sql\s+(?:first|before)"
    r"|manually\s+(?:run|execute|apply)[^\n]{0,30}\.sql"
    r"|(?:requires?|needs?)\s+[^\n]{0,30}\.sql\s+(?:to\s+be\s+)?(?:run|applied|loaded)", re.I)
RESTORE_RE = re.compile(
    r"(?:還原|寫回)[^\n]{0,12}原值|還原[^\n]{0,8}既有資料|restore\s+(?:the\s+)?original\s+value"
    r"|write\s+back\s+(?:the\s+)?original", re.I)
RESTORE_EXCLUDE = re.compile(r"還原後|還原前|還原成功|after\s+restor|before\s+restor", re.I)

INSERT_RE = re.compile(r"INSERT\s+INTO\s+(?:[\[\"`]?\w+[\]\"`]?\.)?[\[\"`]?(\w+)[\]\"`]?", re.I)
UPDATE_RE = re.compile(r"\bUPDATE\s+(?:[\[\"`]?\w+[\]\"`]?\.)?[\[\"`]?(\w+)[\]\"`]?(?=[\s\"']|$)", re.I)
# 指派左側的名稱（`INVALID_USERNAME = "…"`、`user: str = "…"`）：名稱本身是刻意值時整行的帳號字面值不列
ASSIGN_NAME_RE = re.compile(r"^\s*([A-Za-z_][\w.]*)\s*(?::[^=]*)?=(?!=)")
UPDATE_ALIAS_RE = re.compile(
    r"UPDATE\s+[A-Za-z_]\w*\s+SET\b[\s\S]{0,800}?\bFROM\s+(?:[\[\"`]?\w+[\]\"`]?\.)?[\[\"`]?(\w+)[\]\"`]?",
    re.I)

# 帳號欄位直接給字面值（`username="alice"`、`"login": "BOB"`）：欄位名是帳號欄位（見 Rules.is_account_key），大小寫與長度不限
KEY_VALUE_RE = re.compile(r"""(?:\b(?P<k1>[A-Za-z_]\w*)\s*(?::\s*[A-Za-z_][\w\[\]., ]*)?=(?!=)\s*"""
                          r"""|["'](?P<k2>[A-Za-z_][\w-]*)["']\s*(?::|\]\s*=(?!=))\s*)[fru]*["'](?P<v>[^"'\s{}$%]{1,64})["']""")
# 比較運算：`x.owner == "JDOE"` 或 `"JDOE" == x.owner`（斷言裡的帳號期望值）
CMP_RE = re.compile(r"""\b([A-Za-z_][\w.]*)\s*(?:==|!=)\s*[fru]*(["'])([^"'\s]{1,64})\2"""
                    r"""|[fru]*["']([^"'\s]{1,64})["']\s*(?:==|!=)\s*([A-Za-z_][\w.]*)""")
# 名稱裡出現這些字＝UI 元件／畫面文字的常數（btn_login、username_input、login_button_text、account_title），
# 值是選擇器或顯示文字，不是帳號
UI_WORDS = {"btn", "button", "input", "txt", "text", "title", "label", "link", "field", "selector", "locator", "css",
            "xpath", "placeholder", "heading", "header", "tab", "menu", "icon", "msg", "message", "error", "hint",
            "page", "url", "path", "form", "modal", "dialog", "panel", "box", "el", "elem", "element", "sel", "loc",
            "caption", "tooltip", "banner", "toast", "alert", "prompt", "img", "image", "row", "col", "cell"}
# 接在帳號字樣後面、整個名稱仍代表帳號值的尾字（login_name、account_id、owner_email、login_user）
ACCOUNT_SUFFIX = {"id", "name", "no", "email", "mail", "user"}
# 單獨出現時語意有歧義的帳號字樣，與要求搭配的人員修飾字
AMBIGUOUS_ACCOUNT_HEADS = {"account"}
PERSON_QUALIFIERS = {"user", "login", "employee", "staff", "member", "admin", "test", "operator"}
# 登入帳號的長相：英文字母開頭、英數與 ._- 組成、不含空白、至少一個小寫字母、沒有連續 6 位以上數字
# （帳號號碼 1000000000001／US123456789、全大寫代號 ACC-X、含空白或中文的戶名都不符）
LOGIN_ID_LIKE = re.compile(r"^(?=.*[a-z])(?!.*\d{6})[A-Za-z][A-Za-z0-9._-]{1,63}$")
# 本身就代表帳號的字（不必在參數檔 account_context 裡）：user = "alice"、TEST_USER、current_user
BUILTIN_ACCOUNT_HEADS = {"user"}
# 名稱以這些字結尾＝信箱欄位（信箱本身就是身分）
EMAIL_WORDS = {"email", "mail"}
# 帳號字樣前面若是這些字，指的是機制或非人員的帳戶（bank_account、sso_login、auto_login），不是某個人的帳號
NON_PERSON_QUALIFIERS = {"bank", "billing", "payment", "savings", "checking", "credit", "debit", "service", "storage",
                         "cloud", "ledger", "expense", "revenue", "tax", "social", "sso", "auto", "oauth", "saml", "ldap",
                         "openid", "remember", "guest", "anonymous", "system", "default_type",
                         # 資料庫／服務連線帳號（DB_USER、smtp_user）：是連線設定，不是被測系統的使用者帳號
                         "db", "database", "sql", "mysql", "postgres", "pg", "redis", "mongo", "smtp", "ftp", "sftp",
                         "ssh", "proxy", "ldap", "mq", "kafka", "rabbit", "broker", "cache"}
# 系統寄件／客服信箱（support_email、sender_email）：不是某個人的帳號
SYSTEM_MAIL_WORDS = {"support", "noreply", "reply", "sender", "from", "notify", "notification", "system", "service",
                     "helpdesk", "webmaster", "postmaster", "bounce", "mailer", "daemon"}
# 連線呼叫的 user=／username= 是資料庫帳號（pymysql.connect(user="root")）：只看呼叫名**本身**的動詞
CONNECT_VERBS = {"connect"}   # 只認 connect 動詞；engine／pool／from_url 等只認下方明列的連線用戶端（search_engine、get_connection 不算）
# 直接指派字典的設定名稱（DB_CONFIG = {…}、DATABASES = {…}）
CONNECT_TARGET_WORDS = {"db", "database", "databases", "conn", "connection", "dsn", "datasource", "redis", "mongo", "pg",
                        "postgres", "mysql", "sql"}
# 服務連線物件（smtp.login、ftp.login）：它們的 login 是服務帳號，不是被測系統的使用者
CONN_OWNERS = {"smtp", "ftp", "sftp", "ssh", "imap", "pop", "ldap", "mq", "kafka", "redis", "mongo", "smb"}
# 登入動詞前的「機制」字（oauth_login、social_login、saml_login）：參數是身分提供者，不是帳號
LOGIN_MECHANISMS = {"oauth", "social", "saml", "sso", "openid", "ldap", "oidc"}
# 欄位名含這些字＝服務連線帳號（sasl_plain_username、connection_user、smtp_user），不是被測系統的使用者帳號
SERVICE_TOKENS = {"sasl", "connection", "conn", "dsn", "smtp", "ftp", "sftp", "ssh", "imap", "kafka", "redis", "mongo",
                  "ldap", "db", "database"}


def _code_mask(ln):
    """一行裡字串內容換成空白（引號保留、反斜線跳脫的引號不結束字串）：括號配對不被字串裡的 ( ) { } 干擾。"""
    out, q, esc = [], None, False
    for c in ln:
        if q:
            if esc:
                out.append(" ")
                esc = False
                continue
            if c == "\\":
                out.append(" ")
                esc = True
                continue
            out.append(c if c == q else " ")
            if c == q:
                q = None
        else:
            out.append(c)
            if c in "\"'":
                q = c
    return "".join(out)


# 連線類呼叫：呼叫名本身（最後一段）含 connect／engine…，或是常見的連線用戶端類別
CONNECT_CALL_RE = re.compile(r"(?:^|\.)(?:MongoClient|Redis|StrictRedis|create_engine|create_async_engine|URL\.create|create_pool"
                             r"|(?:aio)?redis\.from_url|Redis\.from_url|FTP|FTP_TLS|SMTP|SMTP_SSL|IMAP4|IMAP4_SSL|KafkaProducer"
                             r"|KafkaConsumer|SSHClient)$")


def connection_context(lines, i, pos):
    """第 i 行 pos 所在的值是不是資料庫／服務連線設定。從它往外逐層找未閉合的 ( [ {（可跨行，最多 40 行；字串裡的
    括號不算），任一層符合就是：
      ① 連線類呼叫的參數：呼叫名**最後一個字**是 connect／engine／pool／dsn，或是 MongoClient／Redis／URL.create／
         FTP／SMTP／Kafka 用戶端（db.get_user(…)、url_for(…)、get_connection_user(…) 不算）
      ② 直接指派給連線設定名稱的字典：DB_CONFIG = {…}、db_config = dict(…)、DATABASES = {…}、{"db": {…}}
         （db_user = api.get(…) 是呼叫結果，不算）
    不看區塊裡有沒有 host／port／driver 之類的鍵：login(driver=…, username=…)、headers={"Host": …} 這類
    同呼叫的兄弟參數很常見，拿來豁免會漏掉寫死的帳號。"""
    j, depth = i, 0
    while j >= 0 and i - j < 40:
        code = _code_mask(lines[j])
        k = (pos if j == i else len(code)) - 1
        while k >= 0:
            c = code[k]
            if c in ")]}":
                depth += 1
            elif c in "([{":
                if depth > 0:
                    depth -= 1
                else:
                    head = code[:k]
                    call = re.search(r"([A-Za-z_][\w.]*)\s*$", head) if c == "(" else None
                    if call:
                        name = call.group(1)
                        last_toks = name_tokens(name.rsplit(".", 1)[-1])
                        if CONNECT_CALL_RE.search(name) or (last_toks and last_toks[-1] in CONNECT_VERBS):
                            return True
                    # 字典鍵要看原文（code 已把字串內容遮成空白）：{"db": {…}}
                    target = re.search(r"""(?:([A-Za-z_]\w*)\s*=\s*(?:dict\s*)?|["']([A-Za-z_]\w*)["']\s*:\s*)$""",
                                       lines[j][:k])
                    if target and (c == "{" or head.rstrip().endswith("dict")) \
                            and any(t in CONNECT_TARGET_WORDS for t in name_tokens(target.group(1) or target.group(2))):
                        return True
            k -= 1
        j -= 1
    return False


# 登入類呼叫：名稱（去掉 as／with／user／by 尾字後）以這些動詞結尾，且前面不是檢查／模擬／畫面動作字
# （verify_login、wait_for_login、mock_login、click_login 的第一個字串不是帳號）
LOGIN_VERBS = {"login", "logon", "signin", "impersonate", "authenticate"}
LOGIN_VERB_SEQS = (["sign", "in"], ["log", "in"], ["switch", "user"])
# 動詞前面出現這些字＝檢查／等待／模擬登入的 helper，第一個字串不是帳號（verify_login、wait_for_login、mock_login）；
# 角色前綴（admin_login、user_login、do_login）仍是登入
NOT_LOGIN_PREFIXES = {"verify", "wait", "assert", "mock", "with", "check", "expect", "ensure", "is", "has", "should",
                      "fake", "stub", "get", "set", "handle", "on", "after", "before", "skip", "require", "requires",
                      "test", "patch", "spy", "validate", "confirm", "await", "until", "for",
                      # 畫面動作（click_login、goto_login）：參數是按鈕文字或語系，不是帳號
                      "click", "submit", "goto", "go", "open", "navigate", "visit", "show", "press", "tap", "fill"}
# 帳號前面的參數：名稱裡有這些字＝它本身就在傳帳號（login(page, USER, …)、login(page, cfg.user, …)），帳號位置不是後面的字串
ACCOUNT_ARG_WORDS = {"user", "username", "account", "login", "name", "email", "mail", "owner", "alias", "id", "cred",
                     "creds", "credential", "credentials", "identity", "who", "role"}


def name_tokens(name):
    """識別字斷詞（snake_case 與 camelCase）：btnLogin → [btn, login]、LOGIN_BUTTON_TEXT → [login, button, text]。"""
    out = []
    for part in re.split(r"[_\W]+", name or ""):
        out += [t.lower() for t in re.findall(r"[A-Z]+(?![a-z])|[A-Z]?[a-z]+|\d+", part)]
    return out


def ui_named(name):
    return any(t in UI_WORDS for t in name_tokens(name))
# 顯示用：密碼／token 類欄位的值遮掉（違規清單會印原始碼、寫進 markdown）
SECRET_VALUE_RE = re.compile(
    r"""((?:passw(?:or)?d|passwd|pwd|pass|pw|secret|token|api[_-]?key|apikey|credential)\w*["']?\s*[=:]\s*[fru]*)(["'])(?:\\.|(?!\2)[^\\])*\2""", re.I)
# H 類的敘述界線：下一個（上一個）SQL 敘述的開頭——綁定參數要在「同一句」查詢裡才算
SQL_START_RE = re.compile(r"(?<![.\w])(?:SELECT|INSERT|UPDATE|DELETE|MERGE)\s", re.I)


def is_login_call(name):
    """呼叫名稱是不是「登入」：login、login_as、sign_in、signInAs、impersonate、switch_user。
    get_login_url、login_form.fill（最後的呼叫是 fill）不算。"""
    owner = name_tokens((name or "").rsplit(".", 1)[0]) if "." in (name or "") else []
    if any(t in CONN_OWNERS for t in owner):
        return False                             # smtp.login、ftp.login：服務連線帳號，不是被測系統的使用者
    toks = name_tokens((name or "").rsplit(".", 1)[-1])
    if toks == ["switch", "user"]:
        return True
    while len(toks) > 1 and toks[-1] in ("as", "with", "user", "by"):
        toks.pop()
    if not toks:
        return False
    if toks[-1] in LOGIN_VERBS:
        head = toks[:-1]
    elif toks[-2:] in LOGIN_VERB_SEQS:
        head = toks[:-2]
    else:
        return False
    return not any(t in NOT_LOGIN_PREFIXES or t in LOGIN_MECHANISMS for t in head)


# 控制代碼：名稱斷詞後含這些字（page、admin_page、self.driver、browser_context、page_obj），或就是單字母 p／b
HANDLE_WORDS = {"page", "pages", "driver", "browser", "context", "ctx", "client", "session", "self", "api", "app", "db",
                "request", "req", "http", "frame", "tab", "window", "pw", "playwright"}


def _handle_arg(text):
    """登入呼叫第 0 個參數是不是「控制代碼」（page、admin_page、self.driver、browser_context、p）。
    只看第 0 個：帳號位置因此只可能是第 0 或第 1 個參數，不會一路往後把密碼當帳號。"""
    t = text.strip()
    if not re.match(r"^[a-z_][\w]*(?:\.[a-z_]\w*)*$", t):
        return False
    if t in ("p", "b"):
        return True
    toks = name_tokens(t.replace(".", "_"))
    if any(w in ACCOUNT_ARG_WORDS for w in toks):
        return False                             # login(self.username, "pw")：帳號在變數上，後面的字串是密碼
    return any(w in HANDLE_WORDS for w in toks)


def _py_str_spans(text, i=0):
    """text[i:] 裡的 Python 字串字面值 [(起, 迄, 引號)]（含三引號；跳脫字元跳過；# 之後是註解）。
    假設 i 處不在字串裡。沒收尾的字串延伸到結尾。"""
    spans = []
    n = len(text)
    while i < n:
        c = text[i]
        if c == "#":
            nl = text.find("\n", i)
            if nl < 0:
                break
            i = nl + 1
            continue
        if c in "\"'":
            d = text[i:i + 3] if text[i:i + 3] in ('"""', "'''") else c
            j = i + len(d)
            while j < n and not text.startswith(d, j):
                j += 2 if text[j] == "\\" else 1
            end = min(n, j + len(d))
            spans.append((i, end, d))
            i = end
            continue
        i += 1
    return spans


def _call_end(text, start):
    """start（左括號之後）起、同一層的右括號位置（字串裡的括號不算）；沒有收尾回 len(text)。"""
    depth = 0
    spans = {a: b for a, b, _d in _py_str_spans(text, start)}
    j = start
    while j < len(text):
        if j in spans:
            j = spans[j]
            continue
        c = text[j]
        if c == "#":
            nl = text.find("\n", j)
            j = len(text) if nl < 0 else nl + 1
            continue
        if c in "([{":
            depth += 1
        elif c in ")]}":
            if depth == 0:
                return j
            depth -= 1
        j += 1
    return len(text)


# 依角色登入（login_as(page, "admin")）：角色名對到的帳密由環境變數／設定提供，不是寫死的帳號。
# 只有「角色字、且這次呼叫後面沒有任何字串字面值（密碼）」才算角色；login_as(page, "admin", "admin123") 照擋
ROLE_WORDS = {"admin", "administrator", "viewer", "manager", "editor", "guest", "operator", "approver", "reviewer",
              "staff", "member", "owner", "superuser", "supervisor", "user", "customer", "buyer", "seller", "vendor",
              "auditor", "readonly", "read_only", "author", "moderator", "agent", "tester", "anonymous", "anon",
              "sysadmin", "support", "finance", "accountant", "approver1", "approver2"}


def _role_only(line, pos_args, idx, args):
    """登入呼叫在帳號位置之後，沒有任何字串字面值、沒有位置參數、也沒有密碼類關鍵字參數（password=、pw=、secret=…）。
    login(page, "user", PW) 的 PW 是密碼 → "user" 是帳號，不是角色。"""
    if len(pos_args) > idx + 1:
        return False
    after = [(a0, a1) for a0, a1 in args if a0 >= pos_args[idx][1]]
    for a0, a1 in after:
        t = line[a0:a1]
        if _py_str_spans(t):
            return False
        km = re.match(r"^\s*([A-Za-z_]\w*)\s*=(?!=)", t)
        if km and re.search(r"pass|pwd|pw$|secret|token|cred", km.group(1), re.I):
            return False
    return True


def login_call_literals(line):
    """登入類呼叫的第一個字串位置參數 [(值, 引號位置)]（關鍵字參數交給欄位名判準）。"""
    out = []
    for m in re.finditer(r"([A-Za-z_][\w.]*)\s*\(", line):
        if not is_login_call(m.group(1)):
            continue
        j, depth, start = m.end(), 0, m.end()
        args = []
        while j < len(line):
            c = line[j]
            if c in "\"'":
                q = j + 1
                while q < len(line) and line[q] != c:
                    q += 2 if line[q] == "\\" else 1
                j = min(len(line), q + 1)
                continue
            if c in "([{":
                depth += 1
            elif c in ")]}":
                if depth == 0:
                    args.append((start, j))
                    break
                depth -= 1
            elif c == "," and depth == 0:
                args.append((start, j))
                start = j + 1
            j += 1
        pos_args = [(a0, a1) for a0, a1 in args if not re.match(r"^\s*[A-Za-z_]\w*\s*=(?!=)", line[a0:a1])]
        # 帳號位置：第 0 個位置參數；第 0 個是控制代碼（page、self.driver）時是第 1 個。再往後一律不看——
        # login(page, customer, "S3cret") 的帳號在變數 customer 上，後面的字串是密碼，不得當成帳號
        idx = 1 if pos_args and _handle_arg(line[pos_args[0][0]:pos_args[0][1]]) else 0
        if idx < len(pos_args):
            a0, a1 = pos_args[idx]
            text = line[a0:a1]
            lm = re.match(r"^\s*([fru]*)([\"'])([^\"']*)\2\s*$", text, re.I)
            if lm and "f" not in lm.group(1).lower():   # f-string（f"{user}"）是變數組出來的，不是寫死
                if lm.group(3).lower() in ROLE_WORDS and _role_only(line, pos_args, idx, args):
                    continue                     # 角色名、後面沒有密碼（字面值、位置參數、密碼類關鍵字參數都沒有）
                out.append((lm.group(3), a0 + text.index(lm.group(2))))
    return out


def login_call_secret_spans(line):
    """登入呼叫裡、帳號之後的字串位置參數（多半是密碼）的 (起, 迄)：顯示時要遮。"""
    spans = []
    for m in re.finditer(r"([A-Za-z_][\w.]*)\s*\(", line):
        if not is_login_call(m.group(1)):
            continue
        seen_account = False
        end = _call_end(line, m.end())           # 只看這個呼叫自己的括號裡（不得一路遮到後面幾行的呼叫）
        for a, b, _d in _py_str_spans(line[:end], m.end()):
            while a > 0 and line[a - 1] in "fruFRUbB":
                a -= 1                           # 字串前綴（f"…"、r'…'）一起算
            if seen_account:
                spans.append((a, b))
            seen_account = True
    return spans


def _enclosing_call(line, pos):
    """pos 所在、尚未閉合的最內層呼叫名稱（沒有就回空字串）。"""
    depth = 0
    for j in range(pos - 1, -1, -1):
        c = line[j]
        if c == ")":
            depth += 1
        elif c == "(":
            if depth:
                depth -= 1
                continue
            m = re.search(r"([A-Za-z_][\w.]*)\s*$", line[:j])
            return m.group(1) if m else ""
    return ""


def _snip(text):
    """違規清單顯示用的原始碼片段：密碼／token 類欄位的值、登入呼叫裡帳號之後的字串參數（多半是密碼）一律遮罩。

    報告與違規清單可能轉交他人，Authorization 標頭的 Bearer／Basic 值、網址內嵌的帳號密碼也一併遮掉。
    只遮「長得像憑證」的值，避免把一般英文（"Basic info"、"Bearer tokens"）也遮掉：
      同一行有 auth／credential 字樣（含 basic_auth、AUTH_HEADER 這類命名）時，Bearer／Basic 後面 6 字元以上的值一律遮；
      沒有這類字樣時只遮 Bearer 後面「至少 6 字元、且含數字或 . _ - = + / ~」的值，Basic 不遮。"""
    text = text or ""
    if re.search(r"(?i)auth|credential", text):
        text = re.sub(r"(?i)\b(Bearer)(\s+)[A-Za-z0-9._~+/=-]{6,}", r"\1\2***", text)
        text = re.sub(r"(?i)\b(Basic)(\s+)[A-Za-z0-9+/]{6,}={0,2}", r"\1\2***", text)
    else:
        text = re.sub(r"(?i)\b(Bearer)(\s+)(?=[A-Za-z0-9._~+/=-]*[\d._~+/=-])[A-Za-z0-9._~+/=-]{6,}", r"\1\2***", text)
    text = re.sub(r"(//[^/\s:@\"'`]+):[^@\s\"'`/]+@", r"\1:***@", text)
    for a, b in reversed(login_call_secret_spans(text)):
        q = text[a:b]
        quote = q.lstrip("fruFRU")[0]
        text = text[:a] + quote + "***" + quote + text[b:]
    # SQL 的 VALUES ( 之後的值一律遮（可能是密碼；VALUES (NOW(), 'pw') 這類含函式呼叫的也涵蓋）。
    # 先認出 VALUES 所在的 Python 字串在哪裡收尾：SQL 裡的字面值與收尾之後的參數 tuple（("bob", "Hunter2!")）都要遮，
    # 不能從 SQL 字串中間開始配對引號（會把 `", ("` 當成一個字串，真正的值反而露出）
    vm = re.search(r"\bVALUES\s*\(", text, re.I)
    if vm:
        close = None
        host = [s for s in _py_str_spans(text) if s[0] < vm.start() < s[1]]
        if host:
            close, hq = host[0][1] - len(host[0][2]), host[0][2]
        else:
            # 三引號 SQL 的續行（開頭引號在前幾行）：這行裡第一個三引號就是收尾
            tm = re.search(r'"""|\'\'\'', text[vm.end():])
            if tm and not _py_str_spans(text[:vm.start()]):
                close, hq = vm.end() + tm.start(), tm.group(0)
        mask = lambda q: q.group(1) + "***" + q.group(1)   # noqa: E731
        if close is not None:
            sql_q = "'" if hq[0] == '"' else '"'
            inner = re.sub(r"(%s)(?:\\.|(?!\1).)*\1" % sql_q, mask, text[vm.end():close])
            after = text[close + len(hq):]
            for a, b, d in reversed(_py_str_spans(after)):
                after = after[:a] + d + "***" + d + after[b:]
            text = text[:vm.end()] + inner + text[close:close + len(hq)] + after
        else:
            text = text[:vm.end()] + re.sub(r"""(["'])(?:\\.|(?!\1).)*\1""", mask, text[vm.end():])
    return SECRET_VALUE_RE.sub(lambda m: m.group(1) + m.group(2) + "***" + m.group(2), text)
EMAIL_RE = re.compile(r"""["']([\w.+-]+@([\w-]+(?:\.[\w-]+)+))["']""")
ALIAS_STOP = {"TRUE", "FALSE", "NULL", "NONE", "ASC", "DESC", "POST", "GET", "PUT", "PATCH", "DELETE",
              "JSON", "HTTP", "HTTPS", "HTML", "UTF", "SQL", "API", "URL", "AND", "NOT",
              "ROLE", "TEXT", "NAME", "CODE", "DATE", "TIME", "YES", "OK",
              # 按鈕／畫面上的動作字（BTN_LOGIN = "LOGIN"、login_button = "SUBMIT"）
              "LOGIN", "LOGOUT", "SIGNIN", "SIGNUP", "SUBMIT", "CANCEL", "SAVE", "CONFIRM", "BUTTON", "ENTER",
              "NEXT", "BACK", "CLOSE", "SEARCH", "RESET", "EDIT", "ADD", "REMOVE", "APPLY", "SEND", "LOAD", "OPEN"}
ASSERT_CTX = re.compile(r"\bassert\b|==\s*[\"']|!=\s*[\"']|\bexpect\(")

TOP1_RE = re.compile(r"TOP\s*\(?\s*1\s*\)?|\bLIMIT\s+1\b|FETCH\s+FIRST\s+1\s+ROWS?", re.I)
FROM_RE = re.compile(r"FROM\s+(?:[\[\"`]?\w+[\]\"`]?\.)?[\[\"`]?(\w+)[\]\"`]?", re.I)
# 綁定變數＝讀回「自己剛造的那一列」，合規（放行用）：參數必須綁在識別欄（id／pk／key／code／name／title／marker…）
# 上才算——`WHERE status = ? LIMIT 1` 綁的是狀態，仍是「借一筆現成的」
BOUND_RE = re.compile(
    r"\b\w*(?:id|pk|key|no|code|name|title|marker|guid|uuid|prefix)\s*(?:=|\bIN\b|\bLIKE\b)\s*\(?\s*"
    r"(?:\?|%s|%\(\w+\)s|:[A-Za-z_]\w*|\{[A-Za-z_]?[^}]*\}|['\"]?\s*\+|['\"]\s*%)", re.I)

SELF_SEED_RE_BASE = (r"SCOPE_IDENTITY|lastrowid|RETURNING\s+\w+|PREFIX|_MARK\b|MARKER|唯一前綴|marker"
                     r"|DELETE\s+FROM\s+[\w.\[\]\"`]+\s+WHERE\s+\w+\s*(?:=|IN)"
                     r"|_cleanup\(\)|cleanup_\w+\(|\w+\.cleanup\(|\b_seed\w*\(|\bseed_\w+\(")
CLEANUP_RE = re.compile(r"DELETE\s+FROM|_cleanup|cleanup_|\w+\.cleanup\(|_purge\(|\bpurge_", re.I)
FINALLY_RE = re.compile(r"^\s*finally\s*:")
AUTOFILL_RE = re.compile(r"^([ \t]*)if (\w+) is None:[^\n]*\n((?:\1[ \t]+[^\n]*\n)+)", re.M)


# ---------------- 共用判斷 ----------------

def prose_lines(src, lines):
    """註解行與 docstring／裸字串敘述所在行（1-based）。AST 失敗時退回三引號配對。"""
    out = {i + 1 for i, ln in enumerate(lines) if ln.strip().startswith("#")}
    try:
        tree = ast.parse(src)
    except SyntaxError:
        in_doc, delim = False, None
        for i, line in enumerate(lines, 1):
            started = in_doc
            idx = 0
            while True:
                if not in_doc:
                    m = re.search(r'"""|' + "'''", line[idx:])
                    if not m:
                        break
                    delim, in_doc, idx, started = m.group(0), True, idx + m.end(), True
                else:
                    pos = line.find(delim, idx)
                    if pos < 0:
                        break
                    in_doc, idx = False, pos + 3
            if started or in_doc:
                out.add(i)
        return out
    for node in ast.walk(tree):
        if isinstance(node, ast.Expr) and isinstance(getattr(node, "value", None), ast.Constant) \
                and isinstance(node.value.value, str):
            end = getattr(node, "end_lineno", node.lineno) or node.lineno
            out.update(range(node.lineno, end + 1))
    return out


_SPANS_CACHE = {}


def _func_spans(lines):
    """AST 取每個函式的 (def 行, 結束行+1, docstring 範圍或 None)，皆 0-based；解析失敗回 None。"""
    key = id(lines)
    hit = _SPANS_CACHE.get(key)
    if hit is not None and hit[0] is lines:
        return hit[1]
    try:
        tree = ast.parse("\n".join(lines))
    except SyntaxError:
        spans = None
    else:
        spans = []
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                doc = None
                first = node.body[0] if node.body else None
                if isinstance(first, ast.Expr) and isinstance(getattr(first, "value", None), ast.Constant) \
                        and isinstance(first.value.value, str):
                    doc = (first.lineno - 1, getattr(first, "end_lineno", first.lineno))
                spans.append((node.lineno - 1, getattr(node, "end_lineno", node.lineno), doc))
    _SPANS_CACHE.clear()
    _SPANS_CACHE[key] = (lines, spans)
    return spans


def enclosing_defs(lines, idx):
    """含第 idx 行的所有函式（由內而外），每項 (start, end, doc)；AST 解析失敗回 None。"""
    spans = _func_spans(lines)
    if spans is None:
        return None
    inside = [s for s in spans if s[0] <= idx < s[1]]
    return sorted(inside, key=lambda s: -s[0])


def enclosing_def(lines, idx, outermost=False):
    """含第 idx 行（0-based）的函式範圍 [start, end)；找不到回 None。

    以 AST 為準（命中行必須真的在函式範圍內——函式外的模組常數不屬於前一個函式）；
    AST 解析失敗才退回縮排判斷。
    """
    found = enclosing_defs(lines, idx)
    if found is not None:
        if not found:
            return None
        s = found[-1] if outermost else found[0]
        return s[0], s[1]
    start = base = None
    for j in range(idx, -1, -1):
        m = re.match(r"^(\s*)(?:async\s+)?def\s", lines[j])
        if m:
            ind = len(m.group(1))
            if base is None or ind < base:
                start, base = j, ind
                if not outermost or ind == 0:
                    break
    if start is None:
        return None
    for j in range(start + 1, len(lines)):
        ln = lines[j]
        if ln.strip() and not ln.strip().startswith("#") and (len(ln) - len(ln.lstrip())) <= base:
            if j <= idx:
                return None   # 函式在命中行之前就結束了：命中行不在函式內
            return start, j
    return start, len(lines)


def review_note(lines, idx, regex, span=4):
    """命中行（0-based idx）上方最多 span 行的連續註解，或所屬函式 docstring 裡的覆核註記。

    回傳 ("safe"|"real", 註記原文) 或 (None, None)；另回傳是否看到格式錯的註記。
    """
    malformed = None
    seen = 0
    for k in range(idx - 1, -1, -1):
        t = lines[k].strip()
        if not t:
            continue
        if not t.startswith("#"):
            # SQL 常寫成多行字串續行——那不是「撞到程式碼」，繼續往上找
            if t.startswith(('"', "'", 'f"', "f'")) and t.endswith(('"', "'", '",', "',", '")', "')")):
                continue
            break
        m = regex.search(t)
        if m:
            return m.group(1).lower(), m.group(0), None
        if ANY_REVIEW_RE.search(t):
            malformed = t
        seen += 1
        if seen >= span:
            break
    # 所屬函式（含外層）的 docstring——只看 docstring，不看「函式開頭到命中行」的全部文字：
    # 前面某一行上方的 safe 註記不得連帶豁免後面另一處沒覆核的違規
    for head in _docstrings(lines, idx):
        m = regex.search(head)
        if m:
            return m.group(1).lower(), m.group(0), None
        if malformed is None:
            for t in head.splitlines():
                if ANY_REVIEW_RE.search(t) and not regex.search(t):
                    malformed = t.strip()
    return None, None, malformed


def _docstrings(lines, idx):
    """含命中行的各層函式的 docstring 文字（由內而外）。AST 失敗時退回「def 後緊接的三引號段」。"""
    found = enclosing_defs(lines, idx)
    out = []
    if found is not None:
        for _s, _e, doc in found:
            if doc and not (doc[0] <= idx < doc[1]):
                out.append("\n".join(lines[doc[0]:doc[1]]))
        return out
    rng = enclosing_def(lines, idx)
    if not rng:
        return out
    j = rng[0] + 1
    while j < idx and not re.match(r'\s*[rRuUbBfF]*("""|\'\'\')', lines[j]):
        if lines[j].strip() and not lines[j].rstrip().endswith((",", "(", ":")) and j > rng[0] + 1:
            return out
        j += 1
    if j >= idx:
        return out
    delim = re.match(r'\s*[rRuUbBfF]*("""|\'\'\')', lines[j]).group(1)
    k = j
    body = [lines[j]]
    if lines[j].count(delim) < 2:
        k += 1
        while k < idx and delim not in lines[k]:
            body.append(lines[k])
            k += 1
        if k < idx:
            body.append(lines[k])
    out.append("\n".join(body))
    return out


def in_finally(lines, idx):
    cur = len(lines[idx]) - len(lines[idx].lstrip())
    for j in range(idx - 1, max(-1, idx - 80), -1):
        ln = lines[j]
        if not ln.strip():
            continue
        ind = len(ln) - len(ln.lstrip())
        if ind >= cur:
            continue
        if FINALLY_RE.match(ln):
            return True
        if re.match(r"\s*(?:async\s+)?(def |class )", ln):
            return False
        cur = ind
    return False


class Rules(object):
    def __init__(self, cfg):
        self.cfg = cfg
        hc = cfg["hardcode"]
        self.biz = {t.lower() for t in cfg.get("biz_tables") or []}
        self.skel = {t.lower() for t in cfg.get("skeleton_tables") or []}
        self.intentional = qa_config.intentional_regex(cfg)
        self.intentional_list = list(cfg.get("intentional_prefixes") or [])
        fake = [re.escape(p) for p in cfg.get("fake_identity_prefixes") or [] if p]
        self.fake_prefix = re.compile("^(?:%s)" % "|".join(fake), re.I) if fake else None
        self.fake_domains = [d.lower() for d in cfg.get("fake_email_domains") or []]
        suffixes = [re.escape(s) for s in hc.get("id_name_suffixes") or [] if s]
        # 允許型別註記：`ORDER_ID: int = 1133`、`ORDER_ID: Final[int] = 1133`
        self.id_re = re.compile(r"^\s*(_?[A-Z][A-Z0-9_]*(?:%s))\s*(?::\s*[A-Za-z_][\w\[\]., ]*)?=\s*(\d+)\s*(?:#.*)?$"
                                % "|".join(suffixes or ["_ID"]))
        dh = [re.escape(s) for s in hc.get("dict_hints") or [] if s]
        self.dict_hint = re.compile("|".join(dh), re.I) if dh else None
        ctx = [re.escape(s) for s in hc.get("account_context") or [] if s]
        self.account_ctx = re.compile("|".join(ctx), re.I) if ctx else None
        # 帳號字樣斷詞：單字的（username、login、owner…）當「帳號字」，多字的（user_id、created_by）當結尾序列
        seqs = [name_tokens(w) for w in hc.get("account_context") or [] if w and not re.search(r"[^\x00-\x7f]", w)]
        self.account_heads = {q[0] for q in seqs if len(q) == 1} | BUILTIN_ACCOUNT_HEADS
        self.account_seqs = [q for q in seqs if len(q) > 1]

        look = [p for p in hc.get("identity_lookup_patterns") or [] if p]
        self.lookup = re.compile("|".join(look)) if look else None
        seeds = [p for p in hc.get("self_seed_patterns") or [] if p]
        self.h_seed = re.compile("|".join(seeds), re.I) if seeds else None
        prefix = cfg.get("test_data_prefix") or ""
        self.self_seed = re.compile(SELF_SEED_RE_BASE + ("|" + re.escape(prefix) if prefix else ""))
        tags = [re.escape(t) for t in cfg.get("data_source_tags") or [] if t]
        self.tag_re = re.compile("|".join(tags)) if tags else None
        kws = []
        for words in (cfg.get("external_system_keywords") or {}).values():
            kws.extend(re.escape(w) for w in words or [] if w)
        self.why_re = re.compile("|".join(kws), re.I) if kws else None
        self.shared_dirs = [d.strip("/\\") + "/" for d in hc.get("shared_helper_dirs") or [] if d]
        self.blocking = tuple(BASE_BLOCKING) + tuple(k for k in hc.get("extra_blocking") or []
                                                     if k in LABELS and k not in BASE_BLOCKING)

    def is_account_key(self, key, val=None):
        """欄位／參數名是否代表帳號值（結構判準，看名稱「最後」是什麼，不看「含不含」）：
          - 最後一個字是帳號字樣：username、default_login、owner、"login"
          - 帳號字樣＋帳號尾字：login_name、account_name、owner_email；多字的帳號字樣（user_id、created_by）以結尾比對
          - 含 UI 元件字樣（btn_login、username_input、account_title）不算
        所以 login_provider、LOGIN_ENDPOINT、account_plan、account_type 這類設定常數不會被當成帳號。"""
        if not key or ui_named(key):
            return False
        if any(t in SERVICE_TOKENS for t in name_tokens(key)):
            return False                         # sasl_plain_username、connection_user：服務連線帳號
        if name_tokens(key)[-1:] and name_tokens(key)[-1] in EMAIL_WORDS:
            # email、user_email、owner_mail：信箱欄位本身就是身分；support_email、sender_email 是系統信箱
            return not any(t in SYSTEM_MAIL_WORDS for t in name_tokens(key))
        if re.search(r"[^\x00-\x7f]", key):
            return bool(self.account_ctx and self.account_ctx.search(key))   # 中文欄位名：含帳號字樣即算
        toks = name_tokens(key)
        if not toks:
            return False
        if any(len(seq) > 1 and toks[-len(seq):] == seq for seq in self.account_seqs):
            return True                          # user_id、userId、created_by、createdBy
        core = list(toks)
        while len(core) > 1 and core[-1] in ACCOUNT_SUFFIX and core[-1] not in self.account_heads:
            core.pop()                           # login_user_name → login、account_id → account
        if core[-1] not in self.account_heads:
            return False
        # 帳號字樣前面是「機制／非人員」修飾（bank_account、sso_login、auto_login）＝不是某個人的帳號
        # （先判這條：bank_account = "checking" 的值長得像帳號，但欄位本身已表明不是人）
        if len(core) >= 2 and core[-2] in NON_PERSON_QUALIFIERS:
            return False
        # account 單獨出現有歧義（銀行帳號 account／戶名 account_name 也叫這名字）：
        # 前面有人員字樣（user_account、login_account）直接算；否則看值像不像登入帳號——
        # "bob"、"alice01" 算；"1000000000001"（帳號號碼）、"Acme Trading"、中文戶名、全大寫代號不算
        if core[-1] in AMBIGUOUS_ACCOUNT_HEADS and not (len(core) >= 2 and core[-2] in PERSON_QUALIFIERS):
            return bool(val is not None and LOGIN_ID_LIKE.match(val))
        return True

    def account_value(self, val):
        """字面值能不能是帳號：選擇器、網址／路徑／檔名、樣板、按鈕動作字、假身分前綴、刻意值、假網域信箱都不算。"""
        if not val or re.match(r"^[#.\[/:>*]", val) or re.search(r"[=\[\]>{}\s]", val):
            return False
        if re.search(r"://|[/\\]|\.(?:json|ya?ml|txt|html?|csv|xml|png|jpe?g)$", val, re.I):
            return False
        if val.upper() in ALIAS_STOP or (self.fake_prefix and self.fake_prefix.match(val)) or self.is_intentional(val):
            return False
        if "@" in val:
            local, _sep, dom = val.partition("@")
            dom = dom.lower()
            if any(dom == d or dom.endswith("." + d) for d in self.fake_domains):
                return False
            if (self.fake_prefix and self.fake_prefix.match(local)) or self.is_intentional(local):
                return False
        return True

    def is_intentional(self, name):
        return bool(self.intentional and self.intentional.search(name))

    def why_section(self, src):
        if not self.tag_re:
            return ""
        m = self.tag_re.search(src)
        if not m:
            return ""
        tail = src[m.start():]
        end = re.search(r"\n\s*\n|\"\"\"|'''", tail[10:])
        return tail[:10 + end.start()] if end else tail[:1200]

    def e_exempt(self, path, src):
        """E 類整檔豁免：自種可辨識 ∧ 對稱清理 ∧ 理由段落在外部系統邊界內（三條全中）。"""
        conf = os.path.join(os.path.dirname(path), "conftest.py")
        both = src
        if os.path.isfile(conf) and os.path.abspath(conf) != os.path.abspath(path):
            try:
                with open(conf, encoding="utf-8-sig", errors="replace") as fh:
                    both = src + "\n" + fh.read()
            except OSError:
                pass
        why = self.why_section(src)
        return bool(self.self_seed.search(both) and CLEANUP_RE.search(both)
                    and why and self.why_re and self.why_re.search(why))


def _reviewed(lines, idx, hits, key, rel, a, b, regex=SCAN_REVIEWED_RE):
    """處理覆核註記：safe → 記 REVIEWED 並回 True（不列）；real → 列入原類別附註記；格式錯 → 記提醒。"""
    status, note, malformed = review_note(lines, idx, regex)
    if malformed:
        hits["REVIEW_MALFORMED"].append((rel, idx + 1, "%s:%s" % (key, a), malformed[:120]))
    if status == "safe":
        hits["REVIEWED"].append((rel, idx + 1, "%s:%s" % (key, a), note[:120]))
        return True
    if status == "real":
        hits[key].append((rel, idx + 1, a, REAL_TAG + note[:100]))
        return True
    return False


def _without_comments(src, lines):
    """行尾註解換成空白（字串保留：SQL 與帳號字面值就在字串裡）；tokenize 失敗退回原行。"""
    import io as _io
    import tokenize
    try:
        toks = list(tokenize.generate_tokens(_io.StringIO(src).readline))
    except (tokenize.TokenError, IndentationError, SyntaxError):
        return list(lines)
    out = list(lines)
    for t in toks:
        if t.type == tokenize.COMMENT and t.start[0] == t.end[0] and t.start[0] - 1 < len(out):
            ln = out[t.start[0] - 1]
            out[t.start[0] - 1] = ln[:t.start[1]] + " " * (len(ln) - t.start[1])
    return out


def scan_file(rel, path, src, rules, hits):
    before = {k: len(v) for k, v in hits.items()}
    _scan_file(rel, path, src, rules, hits)
    # 顯示欄（第 4 欄：原始碼片段）一律遮罩密碼類值；指紋只用第 3 欄，不受影響。
    # 覆核註記（REVIEWED／REVIEW_MALFORMED 與 real 註記）是人寫的理由、不是程式碼片段，不套遮罩
    for k, v in hits.items():
        if k in ("REVIEWED", "REVIEW_MALFORMED"):
            continue
        for n in range(before.get(k, 0), len(v)):
            r = v[n]
            if len(r) == 4 and isinstance(r[3], str) and not r[3].startswith(REAL_TAG):
                v[n] = (r[0], r[1], r[2], _snip(r[3]))


def _scan_file(rel, path, src, rules, hits):
    raw_lines = src.splitlines()
    # 判定用去掉行尾註解的版本（`x = 1  # username = "ALICE"` 的註解不是程式碼）；覆核註記與顯示用原文
    lines = _without_comments(src, raw_lines)
    # 登入呼叫常跨行寫（login(page,\n "alice",\n pw)）：整份一次找帳號參數，再對回所在行
    import bisect as _bisect
    prose = prose_lines(src, raw_lines)
    whole_pre = "\n".join(lines)
    # 找登入呼叫時 docstring／說明行換成等長空白：說明文字裡沒收尾的 login( 不得吃進後面的程式碼
    code_only = "\n".join((" " * len(ln_)) if (k_ + 1) in prose else ln_ for k_, ln_ in enumerate(lines))
    starts = [0]
    for ln_ in lines:
        starts.append(starts[-1] + len(ln_) + 1)
    login_hits = {}
    for val_, pos_ in login_call_literals(code_only):
        li = _bisect.bisect_right(starts, pos_) - 1
        login_hits.setdefault(li, []).append((val_, pos_ - starts[li]))
    masked = list(whole_pre)
    for a_, b_ in login_call_secret_spans(code_only):
        for k_ in range(a_ + 1, b_ - 1):
            if masked[k_] != "\n":
                masked[k_] = "*"
    disp_lines = "".join(masked).split("\n")
    prose = prose_lines(src, raw_lines)
    e_exempt = rules.e_exempt(path, src)
    is_shared = any(rel.startswith(d) for d in rules.shared_dirs)

    for i, line in enumerate(lines):
        ln = i + 1
        if ln in prose:
            # C 類靠註解字樣命中，只在 prose 行檢查
            m = RESTORE_RE.search(raw_lines[i])
            if m and not RESTORE_EXCLUDE.search(raw_lines[i]):
                hits["RESTORE"].append((rel, ln, m.group(0).strip()[:60], ""))
            continue
        stripped = _snip(disp_lines[i].strip())   # 先遮罩再截斷；跨行登入呼叫的密碼已在整份上遮掉

        # A：業務資料列 Id 常數
        m = rules.id_re.match(line)
        if m:
            name, val = m.group(1), m.group(2)
            if not (rules.dict_hint and rules.dict_hint.search(name)) and not rules.is_intentional(name):
                if not _reviewed(raw_lines, i, hits, "HARD", rel, name, val):
                    hits["HARD"].append((rel, ln, name, val))

        # B：外部種子 SQL
        m = SEED_RE.search(line)
        if m and not _reviewed(raw_lines, i, hits, "SEED", rel, m.group(0)[:60], ""):
            hits["SEED"].append((rel, ln, m.group(0).strip()[:60], ""))

        # E / E'：直寫業務表（finally 內＝還原，不列）
        for regex, verb, m in [(r_, v_, m_) for r_, v_ in ((INSERT_RE, "INSERT"), (UPDATE_RE, "UPDATE"))
                               for m_ in r_.finditer(line)]:
            table = m.group(1).lower()
            if table in rules.biz:
                key = "DBWRITE"
            elif table in rules.skel:
                key = "DBWRITE_SKELETON"
            else:
                continue
            if in_finally(lines, i) or (key == "DBWRITE" and e_exempt):
                continue
            a = "%s %s" % (verb, m.group(1))
            if not _reviewed(raw_lines, i, hits, key, rel, a, stripped[:120]):
                hits[key].append((rel, ln, a, stripped[:120]))

        # F / F'：寫死帳號與信箱——只認三種「位置」（字面值本身分不出是帳號還是狀態值，只能看它放在哪）：
        #   ① 帳號欄位的值：username="alice"、"login": "BOB"、owner_id = "u1"、userId = "u1"（欄位名結構見 Rules.is_account_key）
        #   ② 登入類呼叫的第一個字串位置參數：login("ALICE")、login_as(page, "alice")、sign_in(page, "bob")
        #   ③ 帳號語境裡的信箱
        #   ④ 與帳號欄位比較的字面值：order.owner == "JDOE"（F' 參考類）
        # 其他呼叫的位置參數不判：fetch_account("ALICE") 與 create_account(db, "PREMIUM") 是同一個結構（已知限制，見 README）
        am = ASSIGN_NAME_RE.match(line)
        named_intentional = bool(am and rules.is_intentional(am.group(1).rsplit(".", 1)[-1]))
        if not named_intentional:
            cands = []   # (字面值, 起點)
            for m in KEY_VALUE_RE.finditer(line):
                key, val, pos = m.group("k1") or m.group("k2"), m.group("v"), m.start("v") - 1
                if not rules.is_account_key(key, val) or rules.is_intentional(key) or not rules.account_value(val):
                    continue
                ktoks = name_tokens(key)
                if ktoks[-1:] and ktoks[-1] in EMAIL_WORDS and "@" not in val:
                    continue                     # email = "abc"：格式驗證用的無效輸入，不是某個人的信箱
                if ktoks and ktoks[-1] in ("user", "username") and connection_context(lines, i, pos):
                    continue                     # DB_CONFIG = {"host": …, "user": "postgres"}、connect(user="root")：連線帳號
                cands.append((val, pos))
            for val, pos in login_hits.get(i, ()):
                if rules.account_value(val):
                    cands.append((val, pos))
            for m in CMP_RE.finditer(line):
                key = (m.group(1) or m.group(5) or "").rsplit(".", 1)[-1]
                val = m.group(3) if m.group(1) else m.group(4)
                pos = (m.start(3) if m.group(1) else m.start(4)) - 1
                if rules.is_account_key(key, val) and rules.account_value(val):
                    cands.append((val, pos))
            if rules.account_ctx:
                for m in EMAIL_RE.finditer(line):
                    addr, dom = m.group(1), m.group(2).lower()
                    local = addr.split("@", 1)[0]
                    if any(dom == d or dom.endswith("." + d) for d in rules.fake_domains):
                        continue
                    if (rules.fake_prefix and rules.fake_prefix.match(local)) or rules.is_intentional(local):
                        continue
                    seg = re.split(r"[,{\[;]", line[:m.start()])[-1]
                    enc = _enclosing_call(line, m.start())
                    if "." in enc and any(t in CONN_OWNERS for t in name_tokens(enc.rsplit(".", 1)[0])):
                        continue                 # smtp.login("noreply@…")：服務連線帳號
                    if rules.account_ctx.search(seg) or rules.account_ctx.search(enc):
                        cands.append((addr, m.start()))
            done = set()
            for val, pos in sorted(cands, key=lambda c: c[1]):
                if pos in done:
                    continue
                done.add(pos)
                # 參考類（斷言）只看這個字面值本身是不是比較運算的一側；同一行別處有 == 不能連帶降級
                prev = line[:pos].rstrip()
                after = line[pos + len(val) + 2:].lstrip()
                bucket = "ALIAS_ASSERT" if (re.search(r"(?:==|!=|\bin)$", prev) or after.startswith(("==", "!="))
                                            or line.lstrip().startswith("assert") or "expect(" in line) else "ALIAS"
                if not _reviewed(raw_lines, i, hits, bucket, rel, val, stripped[:120]):
                    hits[bucket].append((rel, ln, val, stripped[:120]))

        # H / H'：借一筆現成的
        if TOP1_RE.search(line):
            # 視窗只涵蓋「同一句」查詢：往前找到這句的 SELECT（最多 2 行），往後遇到下一句 SQL 的開頭就停——
            # 旁邊另一句查詢的 `WHERE id = ?` 不能替這句借一筆現成的背書
            lo = i
            for j in range(i, max(-1, i - 11), -1):
                if SQL_START_RE.search(lines[j]):
                    lo = j
                    break
            hi = i + 1
            while hi < min(len(lines), i + 7) and not SQL_START_RE.search(lines[hi]):
                hi += 1
            win = " ".join(x.strip() for x in lines[lo:hi])
            m = FROM_RE.search(line) or FROM_RE.search(win)
            if m and m.group(1).lower() in rules.biz and not BOUND_RE.search(win):
                rng = enclosing_def(raw_lines, i, outermost=True) or (max(0, i - 2), min(len(lines), i + 40))
                # 自種後路只算「這一句」的：從這句到同函式下一句借用查詢之間（第一句另含函式開頭到它之間）。
                # 同函式裡別句查詢的 create_x() 不能替這句背書
                tops = [j for j in range(rng[0], rng[1]) if j != i and TOP1_RE.search(lines[j])]
                nxt = min([j for j in tops if j > i] or [rng[1]])
                prev_tops = [j for j in tops if j < i]
                # 這句之前的自種：第一句前面的都算；之後的句子只算「與這句同層或更外層」的（無條件先種），
                # 前一句查無時才種的後路（縮排在 if row is None: 底下）不算這句的
                ind = min((len(x) - len(x.lstrip()) for x in lines[max(rng[0], lo):i + 1] if x.strip()), default=0)
                before = [x for k, x in enumerate(lines[rng[0]:i], rng[0])
                          if not prev_tops or (x.strip() and len(x) - len(x.lstrip()) <= ind)]
                if not (rules.h_seed and rules.h_seed.search("\n".join(before + lines[i:nxt]))):
                    key = "HBORROW_SHARED" if is_shared else "HBORROW"
                    if not _reviewed(raw_lines, i, hits, key, rel, m.group(1), stripped[:120]):
                        hits[key].append((rel, ln, m.group(1), stripped[:120]))

    whole = "\n".join(lines)
    # E（跨行）：`INSERT INTO` 或 `UPDATE` 與表名分在不同行（逐行比對看不到）；
    # 相鄰字串拼接（"INSERT INTO "\n "orders …"）的引號換成空白再比（等長替換，位置與行號不變）
    joined = re.sub(r"""(["'])([ \t]*\n[ \t]*)\1""", lambda mm: " " + mm.group(2) + " ", whole)
    for regex, verb in ((INSERT_RE, "INSERT"), (UPDATE_RE, "UPDATE")):
        for m in regex.finditer(joined):
            if "\n" not in m.group(0):
                continue                         # 同一行的已在逐行比對處理
            table = m.group(1).lower()
            i = whole[: m.start()].count("\n")
            if (i + 1) in prose or in_finally(lines, i):
                continue
            key = "DBWRITE" if table in rules.biz else "DBWRITE_SKELETON" if table in rules.skel else None
            if key is None or (key == "DBWRITE" and e_exempt):
                continue
            a = "%s %s" % (verb, m.group(1))
            if not _reviewed(raw_lines, i, hits, key, rel, a, _snip(raw_lines[i].strip())[:120]):
                hits[key].append((rel, i + 1, a, _snip(raw_lines[i].strip())[:120]))

    # E（跨行）：UPDATE <alias> SET … FROM <table>
    for m in UPDATE_ALIAS_RE.finditer(whole):
        table = m.group(1).lower()
        i = whole[: m.start()].count("\n")
        if (i + 1) in prose or in_finally(lines, i):
            continue
        key = "DBWRITE" if table in rules.biz else "DBWRITE_SKELETON" if table in rules.skel else None
        if key is None or (key == "DBWRITE" and e_exempt):
            continue
        a = "UPDATE %s" % m.group(1)
        if any(h[0] == rel and h[2] == a for h in hits[key]):
            continue
        if not _reviewed(raw_lines, i, hits, key, rel, a, _snip(raw_lines[i].strip())[:120]):
            hits[key].append((rel, i + 1, a, _snip(raw_lines[i].strip())[:120]))

    # G：helper 替產品補欄位（整檔看 if 區塊結構）
    if rules.lookup:
        for m in AUTOFILL_RE.finditer(src if src.endswith("\n") else src + "\n"):
            name, body = m.group(2), m.group(3)
            if not rules.lookup.search(body):
                continue                         # 純字面值＝測試輸入，不算
            if not _field_context(src, name):
                continue                         # 沒進 DB／payload，不算
            i = src[: m.start()].count("\n")
            if (i + 1) in prose:
                continue
            status, note, malformed = review_note(raw_lines, i, G_REVIEWED_RE)
            if status is None:
                status, note, malformed2 = review_note(raw_lines, i, SCAN_REVIEWED_RE)
                malformed = malformed or malformed2
            if malformed and status is None:
                hits["REVIEW_MALFORMED"].append((rel, i + 1, "AUTOFILL:%s" % name, malformed[:120]))
            if status == "safe":
                hits["REVIEWED"].append((rel, i + 1, "AUTOFILL:%s" % name, note[:120]))
                continue
            last = body.strip().splitlines()[-1][:100]
            hits["AUTOFILL"].append((rel, i + 1, name, (REAL_TAG + note[:200]) if status else last))


def _field_context(src, name):
    e = re.escape(name)
    pats = [r"INSERT[^;]{0,400}" + e, r"UPDATE[^;]{0,400}" + e,
            r"[\"']" + e + r"[\"']\s*:", r"\b" + e + r"\s*=\s*[\"']?\{", r"\b" + e + r"\s*=\s*" + e + r"\b"]
    return any(re.search(p, src, re.I | re.S) for p in pats[:2]) or any(re.search(p, src) for p in pats[2:])


def scan(cfg, target="all", errors=None):
    """errors（list）：讀不到的檔加進去——呼叫端據此判定「掃描不完整」，不得當成乾淨。"""
    rules = Rules(cfg)
    hits = {k: [] for k in ORDER}
    root = cfg.root
    if target in ("", "."):
        walk = [(root, [], [f for f in os.listdir(root) if f.endswith(".py")])]
    else:
        base = root if target == "all" else os.path.join(root, target)
        if not os.path.isdir(base):
            return None, rules
        walk = os.walk(base, onerror=lambda e: errors.append("%s（%s）" % (
            os.path.relpath(getattr(e, "filename", "") or base, root).replace("\\", "/"), type(e).__name__))
            if errors is not None else None)
    for dirpath, dirnames, filenames in walk:
        dirnames[:] = [d for d in dirnames if d not in ("__pycache__", ".runs", "outputs", "tools",
                                                        "reports", "_reports", "node_modules")
                       and not d.startswith(".")]
        for fn in sorted(filenames):
            if not fn.endswith(".py"):
                continue
            path = os.path.join(dirpath, fn)
            rel = os.path.relpath(path, root).replace("\\", "/")
            try:
                with open(path, encoding="utf-8-sig", errors="replace") as fh:
                    src = fh.read()
            except OSError as exc:
                if errors is not None:
                    errors.append("%s（%s）" % (rel, type(exc).__name__))
                continue
            scan_file(rel, path, src, rules, hits)
    return hits, rules


def fingerprint(key, rel, a):
    """指紋刻意不含行號（行號隨無關編輯漂移）。同檔同型重複違規摺疊成一筆——要擋的是「又寫了一種新的硬編」。"""
    return "%s|%s|%s" % (key, rel, a)


def blocking_fps(hits, rules):
    return {fingerprint(k, r[0], r[2]) for k in rules.blocking for r in hits[k]}


def write_markdown(hits, rules, path):
    per_file = {}
    for key in ORDER:
        for rel, line, a, b in hits[key]:
            per_file.setdefault(rel, {}).setdefault(key, []).append((line, a, b))
    ranked = sorted(per_file.items(),
                    key=lambda kv: (-sum(len(v) for k, v in kv[1].items() if k in rules.blocking), kv[0]))
    out = ["# 測試資產硬編違規逐檔清單", "",
           "> 由 `tools/hardcode_check.py all --md <路徑>` 產生；判準正本即該工具的 docstring。",
           "> 註解與 docstring 內的命中不計（C 類除外）。`DELETE FROM` 不列（teardown 自清合規）。",
           "", "## 總計", "", "| 類別 | 處數 | 檔案數 | 計入 exit code |", "|---|---|---|---|"]
    for key in ORDER:
        rows = hits[key]
        out.append("| %s | %d | %d | %s |" % (LABELS[key], len(rows), len({r[0] for r in rows}),
                                              "是" if key in rules.blocking else "否"))
    out += ["", "違規檔案共 %d 個。" % len(ranked), "", "---", "", "## 逐檔明細", ""]
    for rel, groups in ranked:
        out += ["### `%s`" % rel, ""]
        for key in ORDER:
            if key not in groups:
                continue
            out += ["**%s**" % LABELS[key], ""]
            for line, a, b in groups[key]:
                out.append("- `:%s` `%s` — `%s`" % (line, a, str(b).replace("|", "\\|")))
            out.append("")
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write("\n".join(out) + "\n")
    return len(ranked)


def write_review_db(hits, db_path):
    """G 類覆核狀態寫進 sqlite——衍生總表（整表重建），正本是程式碼裡的註記。"""
    import sqlite3
    from datetime import datetime
    os.makedirs(os.path.dirname(db_path), exist_ok=True)
    con = sqlite3.connect(db_path)
    try:
        con.execute("CREATE TABLE IF NOT EXISTS hygiene_g_reviews (rel TEXT NOT NULL, line INTEGER,"
                    " field TEXT, status TEXT NOT NULL, note TEXT, scanned_at TEXT NOT NULL)")
        con.execute("DELETE FROM hygiene_g_reviews")
        now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        rows = [(rel, line, a.split(":", 1)[1], "reviewed", note, now)
                for rel, line, a, note in hits["REVIEWED"] if a.startswith("AUTOFILL:")]
        # 已覆核 real（註記判定為真違規）與未覆核 pending 分開記，real 的註記原文要保留
        for rel, line, a, b in hits["AUTOFILL"]:
            b = str(b or "")
            if b.startswith(REAL_TAG):
                rows.append((rel, line, a, "real", b[len(REAL_TAG):].strip(), now))
            else:
                rows.append((rel, line, a, "pending", None, now))
        con.executemany("INSERT INTO hygiene_g_reviews (rel,line,field,status,note,scanned_at)"
                        " VALUES (?,?,?,?,?,?)", rows)
        con.commit()
        return len(rows)
    finally:
        con.close()


def _print_group(key, rows):
    print("\n=== %s：%d 處 / %d 檔 ===" % (LABELS[key], len(rows), len({r[0] for r in rows})))
    for rel, line, a, b in sorted(rows)[:40]:
        print("  %s:%s  %s%s" % (rel, line, a, (" = %s" % b) if b and key == "HARD" else
                                 ("  %s" % b if b else "")))
    if len(rows) > 40:
        print("  …另有 %d 處（完整清單用 --md）" % (len(rows) - 40))


def fix_hint(rules):
    pre = " / ".join("%s_*" % p for p in rules.intentional_list) or "（未設定）"
    return [
        "修法（【測試資料來源】三選一）：",
        "  a 走真實業務流程長出來（常態，不論成本）",
        "  b 封閉例外：只限產品外部系統產生、產品端沒有入口的前置才可直寫＋teardown 自刪；"
        "理由段點名是哪一類外部系統邊界（成本／麻煩／很慢都不算理由）",
        "  c 依賴既有資料：僅限字典／設定類，且期望值查來源推導",
        "身分類（帳號／信箱）一律從當前生效的設定反查，不寫死也不宣告成常數。",
        "H 借一筆現成的 → 查無就走產品入口自種：rows = query(...); return rows[0] if rows else create_x()",
        "刻意值命名慣例（qa-webwright.json intentional_prefixes，工具自動不列）：%s" % pre,
        "已覆核的合法例外：命中行上方加 `# SCAN-REVIEWED: safe — <理由>`（G 類用 `# G-REVIEWED: safe — <產品端證據>（YYYY-MM-DD）`）",
    ]


def main(argv=None):
    qa_config.force_utf8_stdio()
    raw = sys.argv[1:] if argv is None else argv
    if "--probe" in raw:
        print("[拒絕] --probe 在泛用版不提供（需連特定 DB 實查 Id 是否存在）。"
              "要實查請透過 qa-webwright.json 的 db.connector 自行查詢。")
        return 2
    cfg = qa_config.load_or_exit()
    ap = argparse.ArgumentParser(description="測試資產硬編檢查")
    ap.add_argument("target", nargs="?", default="all")
    ap.add_argument("--md", default=None, metavar="PATH")
    ap.add_argument("--review-db", nargs="?", const=os.path.join(cfg.root, ".runs", "results.sqlite"),
                    default=None, metavar="PATH")
    bl.add_args(ap, bl.default_path(cfg.root, TOOL))
    args = ap.parse_args(raw)
    target = args.target.strip("/\\")
    target = "" if target == "." else target
    note = qa_config.missing_note(cfg)
    if note:
        print(note)

    errors = []
    hits, rules = scan(cfg, target, errors)
    if hits is None:
        print("找不到資料夾：%s" % os.path.join(cfg.root, target))
        return 2
    if errors:
        # 掃描不完整：不得回報「沒有違規」，也不得據此重寫 baseline／review-db
        print("[ERROR] 讀不到 %d 個檔，掃描不完整（不當成乾淨、不寫 baseline）：%s" % (len(errors), "、".join(errors[:10])))
        print("QA-TOOL-RESULT: scan-error")
        return 2

    if args.review_db:
        n = write_review_db(hits, args.review_db)
        print("[review-db] 已寫入 %s：%d 筆（正本＝程式碼註記；本表整表重建，僅供清點）" % (args.review_db, n))

    if args.write_baseline:
        rc, msgs = bl.write(args.write_baseline, blocking_fps(hits, rules), args.why, args.allow_raise,
                            full_scan=(args.target == "all"), tool="hardcode_check", unit="處違規")
        print("\n".join(msgs))
        return rc

    shown = hits
    base = None
    if args.baseline:
        base = bl.load_for_gate(args.baseline)
        if base is None:
            print("[警告] 找不到 baseline：%s（本次以全量計）" % args.baseline)
        else:
            shown = {k: ([r for r in v if fingerprint(k, r[0], r[2]) not in base]
                         if k in rules.blocking else v) for k, v in hits.items()}

    blocking_total = sum(len(shown[k]) for k in rules.blocking)
    for key in ORDER:
        if shown[key]:
            _print_group(key, shown[key])
    letters = "/".join(LABELS[k].split(" ")[0] for k in rules.blocking)
    if base is not None:
        exempt = sum(len(hits[k]) - len(shown[k]) for k in rules.blocking)
        print("\n[baseline] 存量豁免 %d 處（%s）" % (exempt, args.baseline))
        print("[baseline] 本次**新增**阻擋類（%s）違規：%d 處" % (letters, blocking_total))
    else:
        print("\n阻擋類（%s）合計 %d 處。" % (letters, blocking_total))

    if args.md:
        n = write_markdown(hits, rules, args.md)
        print("逐檔清單（%d 檔，全量）已寫入：%s" % (n, args.md))

    if blocking_total or shown["HBORROW_SHARED"] or shown["REVIEW_MALFORMED"]:
        print("")
        print("\n".join(fix_hint(rules)))
    if blocking_total:
        print("QA-TOOL-RESULT: violations")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
