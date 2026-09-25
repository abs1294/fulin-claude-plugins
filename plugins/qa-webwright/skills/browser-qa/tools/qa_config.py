"""專案參數檔載入：`tests/e2e/qa-webwright.json`。

所有 qa-webwright 工具（drift_check / gen_catalog / skip_audit / hardcode_check /
i18n_locator_check / sweep_residue / env_gates / pytest plugin）一律從這裡取專案專屬值，
**不在工具裡寫死**業務表名、刻意值前綴、port、測試資料前綴。

找檔順序：
  1. 環境變數 QA_E2E_ROOT（指向 tests/e2e 目錄）
  2. 本檔所在 tools/ 的上一層（scaffold 會把工具複製到 <專案>/tests/e2e/tools/）

缺檔 → 全部走 DEFAULTS（`found=False`），工具照常可跑；
檔案存在但 JSON 壞掉或型別不對 → 丟 ConfigError（明確錯誤，不猜）。
"""
import copy
import json
import os
import sys

CONFIG_NAME = "qa-webwright.json"

# 刻意值命名慣例（提示文字與工具實作必須同一來源）。
# 測 not-found、守門佔位、刻意缺席的值用這些字樣命名，稽核工具就不列入違規；
# hook 的修法提示也從工具輸出取這份清單，不自己另寫一份。
DEFAULT_INTENTIONAL_PREFIXES = [
    "NONEXISTENT", "PLACEHOLDER", "MISSING", "NOT_FOUND",
    "INVALID", "FAKE", "DUMMY", "BAD",
]

DEFAULTS = {
    "schema_version": 1,
    # 測試造的業務資料名稱類欄位一律帶這個前綴（殘留清掃依此定位）
    "test_data_prefix": "E2E-",
    "intentional_prefixes": list(DEFAULT_INTENTIONAL_PREFIXES),
    # 測試自己捏的假身分（帳號 / 部門代碼）前綴：本來就不必真實存在，等同刻意值
    "fake_identity_prefixes": ["QA", "E2E", "ZZ", "MOCK", "DUMMY", "FAKE", "TEST"],
    "fake_email_domains": ["example.com", "example.org", "example.net", "test", "invalid", "localhost"],
    # 業務主體表：測試直接 INSERT/UPDATE ＝繞過產品入口（E 類，阻擋）
    "biz_tables": [],
    # 骨架/字典表：直接寫入風險較低（E' 類，參考）
    "skeleton_tables": [],
    # port 歸屬閘：[{ "label": "前端", "port": 5173 } | { "label": "後端", "url_env": "QA_API_URL" }]
    "ports": [],
    "residue": {
        # 每項：{table, marker_column, pk_column, created_column?, children:[{table, fk_column}]}
        "targets": [],
    },
    "db": {
        # 可插拔 DB 連線："module:factory"（factory() 回傳帶 query(sql, params)/execute(sql, params) 的物件）
        # 或 "sqlite:<相對 tests/e2e 的路徑>"。null ＝未設定（殘留清掃會明確報錯）。
        "connector": None,
    },
    "coverage": {
        "file": "COVERAGE.md",
        "header": ["使用情境（白話）", "測試函式", "覆蓋"],
        "placeholder": "待補",
        "locked_section": "🔒 鎖定",
        "xfail_section": "xfail",
    },
    "catalog": {"file": "CATALOG.md"},
    # E 類整檔豁免的第三條：理由段必須落在這幾類「產品端沒有入口」的外部系統邊界之一
    "external_system_keywords": {
        "workflow_callback": ["簽核系統", "送審鏈", "approval workflow", "workflow callback", "callback_"],
        "upstream_push": ["webhook", "上游推送", "upstream push"],
        "external_master_data": ["外部主檔", "external master data", "mock master"],
        "directory_service": ["ldap", "目錄服務", "directory service"],
    },
    # 【測試資料來源】理由段標記（整檔豁免 E 類的必要條件之一）
    "data_source_tags": ["【測試資料來源】", "[test-data-source]"],
    # skip 四分類的專案擴充關鍵字（regex 片段；與內建中英文預設合併）
    "skip_classify": {"A": [], "B": [], "C": [], "D": [], "D_exclude": []},
    # A/D 類執行期 skip 讓整輪 exit 非 0
    "skip_gate": True,
    # fixture → 必要環境變數（依 collect 結果的 fixture 圖判定，不 grep）
    "env_requirements": [],
    "i18n": {
        "enabled": True,
        # 寫 PostToolUse hook 時要不要把 i18n 定位器檢查當阻擋閘
        "hook_gate": False,
        # 「顯示文字」字元類（regex 字元類內容）；預設 CJK 統一表意文字
        "script_class": "一-鿿",
        "locale_switch_hints": ["switch_locale", "en-US", "en_US", "setLocale", "locale\\s*="],
    },
    "hardcode": {
        # A 類：常數名以這些結尾且值為整數 → 業務資料列 Id 寫死
        "id_name_suffixes": ["_ID", "_IDS", "HEADER_ID", "_PK"],
        # A 類排除：字典/設定類（期望值該查來源推導，是另一種病）
        "dict_hints": ["CATEGORY", "TYPE", "ROLE", "STATUS", "KIND", "LEVEL", "LOCALE",
                       "LANG", "TIMEOUT", "PORT", "RETRY", "PAGE", "LIMIT"],
        # 參考類升為阻擋類（照升級規則：連續 N 次 --baseline 新增 0 ＋ 抽驗零誤判後才加）
        "extra_blocking": [],
        # F 類：出現這些語境的字串字面值才檢查寫死帳號
        "account_context": ["alias", "owner", "employee", "account", "username", "user_id",
                            "login", "assignee", "created_by", "帳號", "員工", "負責人", "承辦"],
        # G 類：值來自環境反查（而非字面值）的樣式
        "identity_lookup_patterns": ["identity\\.", "current_\\w+\\(", "resolve_\\w+\\(",
                                     "lookup_\\w+\\("],
        # H 類：「查無就自種」的訊號
        "self_seed_patterns": ["_chain\\b", "\\bensure_\\w+\\(", "\\bcreate_\\w+\\(",
                               "\\bseed_\\w+\\(", "\\b_seed\\w*\\(", "factory"],
        # H' 類：共用層目錄（改動波及全庫，另軌）
        "shared_helper_dirs": ["helpers"],
    },
    "hook": {"enabled": True},
    # ---- PreToolUse 機械閘（hooks/guard-*.js 直接讀參數檔；這裡的預設＝「沒設＝該閘靜默」）----
    # 派 qa-engineer 的派工單表態閘；None ＝未設（靜默）
    "dispatch_gate": None,
    # commit 前 QA 表態閘：預設關閉
    "commit_gate": {"enabled": False},
    # 跑測試前的環境對齊＋副作用防護；兩個清單都空＝靜默
    "pretest": {"test_command_regex": [], "alignment": [], "side_effect_guards": []},
    # 參數化指令守門；空清單＝靜默
    "command_guards": [],
    # 交付資料夾紀律；roots 空＝靜默
    "report_hygiene": {"roots": [], "work_dir": "_work"},
    # 瀏覽器導向守門；兩者都沒設＝靜默
    "browser_guard": {"deny_hosts_regex": None, "rate_limits": []},
}

DISPATCH_CHECK_IDS = ("triage", "target_env", "data_source", "out_of_scope", "no_relay",
                      "alignment", "scope_expansion", "field_verification")

# 型別檢查：頂層 key → 期望型別（缺的 key 用預設；多出的 key 忽略）
_TYPES = {
    "test_data_prefix": str,
    "intentional_prefixes": list,
    "fake_identity_prefixes": list,
    "fake_email_domains": list,
    "biz_tables": list,
    "skeleton_tables": list,
    "ports": list,
    "residue": dict,
    "db": dict,
    "coverage": dict,
    "catalog": dict,
    "external_system_keywords": dict,
    "data_source_tags": list,
    "skip_classify": dict,
    "skip_gate": bool,
    "env_requirements": list,
    "i18n": dict,
    "hardcode": dict,
    "hook": dict,
    "dispatch_gate": dict,
    "commit_gate": dict,
    "pretest": dict,
    "command_guards": list,
    "report_hygiene": dict,
    "browser_guard": dict,
}

# 閘規則段的第二層型別：段名 → {欄位: 型別}；("list", T) ＝元素型別為 T 的清單。
# 以底線開頭的欄位是註解，不檢查。hook 端讀到壞型別會 fail-open 靜默，所以壞型別要在這裡（工具端）明講。
_STR_LIST = ("list", str)
_DICT_LIST = ("list", dict)
_SECTION_FIELDS = {
    "dispatch_gate": {
        "enabled": bool, "agent_regex": str, "checks": _STR_LIST, "required_reading": _STR_LIST,
        "required_reading_existing_only": bool, "custom_checks": _DICT_LIST, "params": dict,
    },
    "commit_gate": {
        "enabled": bool, "behavior_globs": _STR_LIST, "exclude_globs": _STR_LIST, "repos": _STR_LIST,
        "skill_name_regex": str, "qa_answer_regex": str, "sediment_regex": str, "require_sediment": bool,
        "extra_commands": _DICT_LIST,
    },
    "pretest": {
        "enabled": bool, "test_command_regex": _STR_LIST, "alignment": _DICT_LIST, "side_effect_guards": _DICT_LIST,
    },
    "report_hygiene": {"enabled": bool, "roots": _STR_LIST, "process_ext_regex": str, "work_dir": str},
    "browser_guard": {"enabled": bool, "deny_hosts_regex": str, "rate_limits": _DICT_LIST},
}
# 清單內物件的欄位型別：(段名, 欄位) → {欄位: 型別}；required 為必填欄位
_ITEM_FIELDS = {
    ("command_guards", None): ({"name": str, "enabled": bool, "when_regex": str, "deny_regex": _STR_LIST,
                                "require_regex": _STR_LIST, "require_env": _STR_LIST, "message": str},
                               ("when_regex",)),
    ("pretest", "alignment"): ({"env": str, "required": bool, "equals_file": str, "regex": str,
                                "must_be_under": str, "matches": str, "when_regex": str, "message": str,
                                "port": int, "port_env": str, "equals_process_file": str,
                                "under_process_root": str, "search_up": int},
                               ("env",)),
    ("pretest", "side_effect_guards"): ({"name": str, "enabled": bool, "file": str, "require_regex": _STR_LIST,
                                         "forbid_regex": _STR_LIST, "block_regex": str, "message": str},
                                        ("file",)),
    ("browser_guard", "rate_limits"): ({"host_regex": str, "max": int, "window_s": (int, float)},
                                       ("host_regex", "max", "window_s")),
    ("commit_gate", "extra_commands"): ({"name": str, "regex": str, "repo_group": int}, ("regex",)),
    ("dispatch_gate", "custom_checks"): ({"id": str, "label": str, "regex": str, "message": str}, ("regex",)),
}


def _type_name(t):
    if isinstance(t, tuple) and t and t[0] == "list":
        return "list[%s]" % t[1].__name__
    if isinstance(t, tuple):
        return "/".join(x.__name__ for x in t)
    return t.__name__


def _type_ok(value, t):
    if value is None:
        return True
    if isinstance(t, tuple) and t and t[0] == "list":
        return isinstance(value, list) and all(isinstance(x, t[1]) for x in value)
    # bool 是 int 的子類：型別沒明列 bool 時，true／false 不得冒充數字（port: true 會被當成 1）
    if isinstance(value, bool) and not (t is bool or (isinstance(t, tuple) and bool in t)):
        return False
    return isinstance(value, t)


def _check_items(path, where, items, fields, required):
    for i, item in enumerate(items):
        if not isinstance(item, dict):
            raise ConfigError("%s 的 `%s[%d]` 型別應為物件，實際是 %s" % (path, where, i, type(item).__name__))
        for k in required:
            if item.get(k) in (None, ""):
                raise ConfigError("%s 的 `%s[%d]` 缺必填欄位 `%s`" % (path, where, i, k))
        for k, t in fields.items():
            if k in item and not _type_ok(item[k], t):
                raise ConfigError("%s 的 `%s[%d].%s` 型別應為 %s，實際是 %s"
                                  % (path, where, i, k, _type_name(t), type(item[k]).__name__))


# 工具設定段的第二層型別（B15：值型別錯時工具不得丟未捕捉例外或默默照跑，要 exit 2 明講）
_TOOL_FIELDS = {
    "coverage": {"file": str, "header": _STR_LIST, "placeholder": str, "locked_section": str, "xfail_section": str},
    "catalog": {"file": str},
    "hardcode": {k: _STR_LIST for k in ("id_name_suffixes", "dict_hints", "extra_blocking", "account_context",
                                        "identity_lookup_patterns", "self_seed_patterns", "shared_helper_dirs")},
    "i18n": {"enabled": bool, "hook_gate": bool, "script_class": str, "locale_switch_hints": _STR_LIST},
    "residue": {"targets": _DICT_LIST},
    "db": {"connector": str},
    "hook": {"enabled": bool},
}
# 值一律是字串清單的對照表段
_STR_LIST_MAPS = ("skip_classify", "external_system_keywords")
# 頂層清單的元素型別
_STR_LIST_TOP = ("intentional_prefixes", "fake_identity_prefixes", "fake_email_domains", "biz_tables",
                 "skeleton_tables", "data_source_tags")
_TOOL_ITEMS = {
    ("residue", "targets"): ({"table": str, "marker_column": str, "pk_column": str, "created_column": str,
                              "children": _DICT_LIST}, ("table", "marker_column", "pk_column")),
    ("env_requirements", None): ({"fixtures": _STR_LIST, "env": _STR_LIST, "desc": str}, ()),
    ("ports", None): ({"label": str, "port": (int, str), "url_env": str}, ()),
}


# 會被工具拿去編 regex 的欄位：編不起來要在載入時就明講（否則工具跑到一半丟 re.error）
_REGEX_FIELDS = (("hardcode", "identity_lookup_patterns"), ("hardcode", "self_seed_patterns"),
                 ("i18n", "locale_switch_hints"))


def _check_regex(path, where, pattern, as_class=False):
    import re
    try:
        re.compile("[%s]" % pattern if as_class else pattern)
    except re.error as exc:
        raise ConfigError("%s 的 `%s` 不是合法的 regex%s：%r（%s）"
                          % (path, where, "字元類內容" if as_class else "", pattern, exc))


def check_tool_sections(path, data):
    """工具設定段的巢狀型別檢查；不合法丟 ConfigError（工具 exit 2）。"""
    for key, typ in _TYPES.items():
        # null 只有「預設就是 null」的段可以用（例：dispatch_gate）；其他段寫 null 等於把預設值整段抹掉
        if key in data and data[key] is None and DEFAULTS.get(key) is not None:
            raise ConfigError("%s 的 `%s` 型別應為 %s，實際是 null（不設定請整個拿掉這個 key）"
                              % (path, key, typ.__name__))
    for sec, fields in _TOOL_FIELDS.items():
        body = data.get(sec)
        if not isinstance(body, dict):
            continue
        for k, t in fields.items():
            if k in body and body[k] is None and (DEFAULTS.get(sec) or {}).get(k) is not None:
                raise ConfigError("%s 的 `%s.%s` 型別應為 %s，實際是 null" % (path, sec, k, _type_name(t)))
            if k in body and not _type_ok(body[k], t):
                raise ConfigError("%s 的 `%s.%s` 型別應為 %s，實際是 %s"
                                  % (path, sec, k, _type_name(t), type(body[k]).__name__))
    cov = data.get("coverage")
    if isinstance(cov, dict) and isinstance(cov.get("header"), list) and len(cov["header"]) < 3:
        raise ConfigError("%s 的 `coverage.header` 型別應為 list[str] 且至少 3 格（情境／測試函式／覆蓋），實際 %d 格"
                          % (path, len(cov["header"])))
    for sec in _STR_LIST_MAPS:
        body = data.get(sec)
        if isinstance(body, dict):
            for k, v in body.items():
                if not k.startswith("_") and not _type_ok(v, _STR_LIST):
                    raise ConfigError("%s 的 `%s.%s` 型別應為 list[str]，實際是 %s" % (path, sec, k, type(v).__name__))
    for key in _STR_LIST_TOP:
        if isinstance(data.get(key), list) and not _type_ok(data[key], _STR_LIST):
            raise ConfigError("%s 的 `%s` 型別應為 list[str]" % (path, key))
    for (sec, k), (ifields, req) in _TOOL_ITEMS.items():
        items = data.get(sec) if k is None else (data.get(sec) or {}).get(k) if isinstance(data.get(sec), dict) else None
        if not isinstance(items, list):
            continue
        where = sec if k is None else "%s.%s" % (sec, k)
        _check_items(path, where, items, ifields, req)
        if (sec, k) == ("residue", "targets"):
            for i, t in enumerate(items):
                _check_items(path, "%s[%d].children" % (where, i), t.get("children") or [],
                             {"table": str, "fk_column": str}, ("table", "fk_column"))
        if (sec, k) == ("ports", None):
            for i, p in enumerate(items):
                port = p.get("port")
                if isinstance(port, str) and not port.isdigit():
                    raise ConfigError("%s 的 `ports[%d].port` 應為整數，實際是 %r" % (path, i, port))
    for sec, k in _REGEX_FIELDS:
        body = data.get(sec)
        if isinstance(body, dict) and isinstance(body.get(k), list):
            pats = [p for p in body[k] if isinstance(p, str) and p]
            for i, pat in enumerate(pats):
                _check_regex(path, "%s.%s[%d]" % (sec, k, i), pat)
            if pats:   # 工具以 | 串接後編譯：(?i) 這類全域旗標放在中間會失敗，要用實際組合的形式驗
                _check_regex(path, "%s.%s（串接後）" % (sec, k), "|".join(pats))
    i18n = data.get("i18n")
    if isinstance(i18n, dict) and isinstance(i18n.get("script_class"), str):
        _check_regex(path, "i18n.script_class", i18n["script_class"], as_class=True)
    sc = data.get("skip_classify")
    if isinstance(sc, dict):
        for k, v in sc.items():
            if not k.startswith("_") and isinstance(v, list):
                pats = [p for p in v if isinstance(p, str) and p]
                for i, pat in enumerate(pats):
                    # skip_audit 以 (?:…) 包起來再串接：驗包起來的形式（(?i) 放在群組裡會失敗）
                    _check_regex(path, "skip_classify.%s[%d]" % (k, i), "(?:%s)" % pat)
                if pats:   # 串接後才會出現的錯（兩項用了同名具名群組）也要在載入時擋下
                    _check_regex(path, "skip_classify.%s（串接後）" % k, "|".join("(?:%s)" % p for p in pats))


def check_gate_sections(path, data):
    """閘規則段的第二層型別檢查；不合法丟 ConfigError（工具端 exit 2，hook 端靜默）。"""
    for sec, fields in _SECTION_FIELDS.items():
        body = data.get(sec)
        if not isinstance(body, dict):
            continue
        for k, t in fields.items():
            if k.startswith("_") or k not in body:
                continue
            if not _type_ok(body[k], t):
                raise ConfigError("%s 的 `%s.%s` 型別應為 %s，實際是 %s"
                                  % (path, sec, k, _type_name(t), type(body[k]).__name__))
        for (s, k), (ifields, req) in _ITEM_FIELDS.items():
            if s == sec and k and isinstance(body.get(k), list):
                _check_items(path, "%s.%s" % (sec, k), body[k], ifields, req)
    if isinstance(data.get("command_guards"), list):
        ifields, req = _ITEM_FIELDS[("command_guards", None)]
        _check_items(path, "command_guards", data["command_guards"], ifields, req)
    dg = data.get("dispatch_gate")
    if isinstance(dg, dict) and isinstance(dg.get("checks"), list):
        bad = [c for c in dg["checks"] if c not in DISPATCH_CHECK_IDS]
        if bad:
            raise ConfigError("%s 的 `dispatch_gate.checks` 有不認得的檢查項 %s（可用：%s）"
                              % (path, bad, "、".join(DISPATCH_CHECK_IDS)))


class ConfigError(Exception):
    """參數檔存在但內容不合法。"""


def tools_dir():
    return os.path.dirname(os.path.abspath(__file__))


def e2e_root():
    env = os.environ.get("QA_E2E_ROOT", "").strip()
    if env:
        return os.path.abspath(env)
    return os.path.dirname(tools_dir())


def config_path(root=None):
    return os.path.join(root or e2e_root(), CONFIG_NAME)


def _merge(base, over):
    out = copy.deepcopy(base)
    for k, v in over.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _merge(out[k], v)
        else:
            out[k] = v
    return out


class Config(dict):
    """dict 子類別，多帶 found / path 兩個屬性。"""
    found = False
    path = ""
    root = ""


_CACHE = {}


def load(root=None, use_cache=True):
    root = os.path.abspath(root or e2e_root())
    if use_cache and root in _CACHE:
        return _CACHE[root]
    path = config_path(root)
    # 訊息只顯示相對專案的路徑：完整本機路徑會跟著輸出進日誌
    shown = "tests/e2e/" + CONFIG_NAME
    data = {}
    found = False
    if os.path.isfile(path):
        found = True
        try:
            # utf-8-sig：Windows PowerShell 5.1 寫檔預設帶 BOM；hook 端也會去掉 BOM，兩端讀法一致
            with open(path, encoding="utf-8-sig") as fh:
                data = json.load(fh)
        except ValueError as exc:
            raise ConfigError("%s 不是合法 JSON：%s" % (shown, exc))
        except OSError as exc:
            raise ConfigError("%s 讀取失敗：%s" % (shown, getattr(exc, "strerror", None) or type(exc).__name__))
        if not isinstance(data, dict):
            raise ConfigError("%s 頂層必須是 JSON 物件" % shown)
        for key, typ in _TYPES.items():
            if key in data and data[key] is not None and not isinstance(data[key], typ):
                raise ConfigError("%s 的 `%s` 型別應為 %s，實際是 %s"
                                  % (shown, key, typ.__name__, type(data[key]).__name__))
        check_gate_sections(shown, data)
        check_tool_sections(shown, data)
    cfg = Config(_merge(DEFAULTS, {k: v for k, v in data.items() if not k.startswith("_")}))
    cfg.found = found
    cfg.path = path
    cfg.root = root
    _CACHE[root] = cfg
    return cfg


def load_or_exit(root=None):
    """CLI 工具用：參數檔壞掉就明確報錯 exit 2；缺檔走預設並提示一行。"""
    try:
        cfg = load(root)
    except ConfigError as exc:
        print("[qa-webwright] 參數檔錯誤：%s" % exc, file=sys.stderr)
        sys.exit(2)
    return cfg


def missing_note(cfg):
    if cfg.found:
        return ""
    return ("[qa-webwright] 找不到 %s，使用內建預設值（業務表清單為空 → E/H 類不會命中）。"
            "qa-flow.sh scaffold 會產生此檔。" % ("tests/e2e/" + CONFIG_NAME))


def force_utf8_stdio():
    """Windows 終端預設 cp950/cp1252，印中文或 ⚠ 會在跑完後才 UnicodeEncodeError。"""
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            try:
                stream.reconfigure(encoding="utf-8")
            except (ValueError, OSError):
                pass


def intentional_regex(cfg):
    import re
    words = [re.escape(w) for w in cfg.get("intentional_prefixes") or [] if w]
    if not words:
        return None
    return re.compile("|".join(words), re.I)


def flag_true(raw):
    """探測覆寫約定：1/true/yes/on（不分大小寫）＝真；其他非空值＝假；None/空字串＝未設。"""
    if raw is None:
        return None
    s = str(raw).strip()
    if s == "":
        return None
    return s.lower() in ("1", "true", "yes", "on")
