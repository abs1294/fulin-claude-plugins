"""skip 四分類稽核：把「靜默 skip」變成看得見的數字。

用法（於 tests/e2e 下）：
    python tools/skip_audit.py [folder|all]          # 靜態掃描執行期 skip 並分類
    python tools/skip_audit.py all --list            # 逐筆列出
    python tools/skip_audit.py all --strict          # A 或 D 類 > 0 → exit 1（可掛 CI）
    python tools/skip_audit.py <folder> --baseline   # 只報 baseline 以外的新增 A/D（接閘用）
    python tools/skip_audit.py all --write-baseline --why "<清掉了什麼>"

同一份 classify() 也被 pytest plugin（qa_pytest_plugin.py）用來分類「本次實際發生」的 skip，
並讓 A/D 類執行期 skip 把整輪 exit 設成非 0。

## 為什麼要有這支

skip 讓「沒有測到」長得跟「測過而且沒問題」一模一樣。資料一空，「沒這種資料所以跳過」
全面觸發——通過率看起來還行，保護力歸零。

## 四分類（依「該由誰負責讓它跑起來」）

  A 資料不存在   → 測試自己該造。空庫是常態，「沒資料」不是跳過的理由；造不出來才 fail。
  B 環境不可用   → 真的環境邊界（外部服務不可達、登入態建立不了）。保留合理，但要具名條件，
                   否則會被拿來當 A 類的藏身處。已有 mock 的外部系統不得拿來當 skip 藉口。
  C 頁面結構變更 → 回歸訊號，寫成 skip 是錯的，應改 fail。
  D 共用狀態被佔／前置沒做成功 → 應改 fail。測試自己該把狀態還原、把前置做成功。
                   D 比 A 更毒：一次殘留沒清，之後每輪都安靜跳過——跑一百次一百次綠，一次都沒真的測。

## 判定順序 C → D（先過 D 排除）→ B → A（最寬）

  - C 最 specific。
  - D 在 A 之前：D 的理由幾乎都帶否定詞（仍不可點、不成立），會被 A 的結構判準整批吃掉。
  - D 在 B 之前：共用狀態是測試自己弄髒的，不是環境邊界。
  - D 排除（D_EXCLUDE）：帶推測語氣（可能／maybe）或描述「找不到符合條件的資料」的，
    其實是 A 不是 D。誤判代價不對稱——把 A 當 D 會被要求改 fail，那在資料不足時是假紅。
  - B 在 A 之前：環境類理由常也含「無／找不到」（如「無此端點」），先判 A 會把真正的環境邊界
    誤歸成「該自種」——那是不可能達成的要求。

## 只抓執行期 skip（AST）

收集期的 `@pytest.mark.skip/skipif`（裝飾器、或先建 mark 物件再 add_marker）是**開跑前就知道
不適用**，報告看得出「這輪沒涵蓋這塊」，是誠實的形式、要保留；本工具與 A/D 閘都不管它。
判準是「決定的時機」，不是「有沒有 skip」。AST 也避免把文件字串與註解裡的示例算成 skip。

專案可在 qa-webwright.json 的 skip_classify.{A,B,C,D,D_exclude} 追加 regex 片段（與內建預設合併）。
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

TOOL = "skip"

# 業務資料類名詞（A 類「找不到／不夠／至少要 N」要接這些才算資料缺席）
_DATA_NOUN = (r"(?:data|rows?|records?|orders?|users?|items?|products?|accounts?|customers?|fixtures?|entries|entry"
              r"|results?|samples?|invoices?|tickets?|documents?|matches|match)\b")

_BUILTIN = {
    "A": [
        # 中文：「這種資料沒有」的各種說法（措辭發散，故開得寬）
        r"DB\s*(?:當下)?\s*(?:查)?無", r"種子缺", r"種子未", r"不存在", r"查無", r"無可用", r"無可借",
        r"\b(?:data|rows?|records?|fixtures?|seed(?:ed)?(?:\s+data)?|orders?|users?|items?)\b.{0,20}\bnot provided\b",
        r"無.{0,8}樣本", r"回傳空", r"無資料", r"不足", r"沒有.{0,8}資料", r"前提資料已變動", r"列表無",
        r"找不到", r"無法.{0,10}(?:驗證|構造|挑|取得)", r"不在.{0,10}(?:清單|列表|種)",
        r"筆數", r"少於", r"僅.{0,4}筆", r"只有.{0,4}筆", r"無其他", r"無下一頁",
        r"沒.{0,4}資料", r"查不到",
        # 「不夠」要接在資料類名詞後（資料不夠、訂單數量不夠）；記憶體不夠、權限不夠是環境
        r"(?:資料|數量|筆數|樣本|訂單|紀錄|記錄|項目|資料列|筆)\S{0,4}不夠",
        # English
        r"\bno (?:data|rows?|records?|items?|results?|matching|such)\b", r"\bnot found\b",
        r"\bdoes(?:n't| not) exist\b", r"\bempty (?:list|table|result|db|database)\b",
        r"\bmissing (?:data|record|row|seed|fixture data)\b", r"\bnothing to\b",
        r"\binsufficient\b", r"\bfewer than\b", r"\bless than \d+\b", r"\bonly \d+ (?:rows?|records?|items?)\b",
        r"\bno .{0,20} available\b", r"\bseed(?:ed)? data\b",
        # find／not enough／need at least 一律要接資料類名詞（cannot find chromedriver、need at least 2 CPUs 是環境）
        r"\bnot enough (?:test )?" + _DATA_NOUN,
        r"\b(?:cannot|can't|could(?:n't| not)|unable to) find (?:any |an? |the |a matching |matching |existing |enough )?"
        r"(?:test )?" + _DATA_NOUN,
        r"\b(?:need|require)s? at least \d+ (?:\w+ )?" + _DATA_NOUN,
    ],
    "B": [
        r"未進登入態", r"不可用", r"mock 未生效", r"環境限制", r"環境不可用", r"未啟動", r"連不上",
        r"本機.{0,8}未", r"無此端點", r"尚未實作", r"未部署", r"不支援",
        r"(?:port|埠|連接埠|檔案|file|目錄).{0,12}被佔用",
        r"(?:\bport\b|(?<!mail[\s-])(?<!mail\s\s)\baddress\b|\bsocket\b).{0,20}\balready in use\b",
        # 服務／連線／環境設定類的說法（B 先於 A 判定；A 的結構判準含「未」「無」，不先攔會被誤判成資料缺席）
        r"(?:未|無|沒有?)(?:回應|反應)", r"逾時", r"\btimed?\s?out\b", r"環境變數", r"連線(?:失敗|中斷|錯誤)",
        r"(?:服務|伺服器|後端|API|外部系統|server|backend)\S{0,4}(?:未|無|不)(?:回應|啟動|可用|連線)",
        r"\bunavailable\b", r"\bnot available\b", r"\bunreachable\b", r"\bnot reachable\b",
        r"\bconnection (?:refused|failed|error)\b", r"\bnot running\b", r"\bnot deployed\b",
        r"\bnot supported\b", r"\bnot implemented\b", r"\brequires? (?:vpn|network|credentials?)\b",
        r"\bservice down\b", r"\btimeout connecting\b", r"\b404\b",
        # 設定／安裝／開放狀態與執行環境（網路、顯示器、瀏覽器、平台）——是環境條件，不是資料缺席
        r"未(?:設定|設|配置|安裝|啟用|開放|開通|登入|授權)", r"尚未開放", r"功能關閉", r"權限不(?:足|夠)",
        r"(?:記憶體|磁碟|空間|CPU|核心)\S{0,2}不(?:足|夠)",
        # 找不到的是執行檔／驅動／瀏覽器＝環境缺件
        r"\b(?:cannot|can't|could(?:n't| not)|unable to) find (?:the |a |an )?(?:\w+ ){0,2}"
        r"(?:executable|binary|driver|chromedriver|geckodriver|browser|chrome|chromium|firefox|display|module|package|command)\b",
        r"\bnot enough (?:memory|disk|space|cpus?|cores?|permissions?)\b", r"\b(?:need|require)s? at least \d+ (?:cpus?|cores?|gb|mb)\b",
        r"\bno (?:network|internet|display|gpu|browser|x11|vpn|credentials?|permission|access|license|token)\b",
        r"\bnot (?:set|configured|installed|enabled|licensed|authorized|logged in)\b",
        r"\bmissing (?:env|environment|config(?:uration)?|credentials?|token|api key|secret|permission)\b",
        # 「沒有／無／未…」後面接的是執行環境（網路、資料庫連線、瀏覽器、顯示器…），不是業務資料
        r"(?:無|沒有|缺少?|未|無法|連不到)\s*(?:連線到?|連到)?\s*(?:網路|網際網路|資料庫連線|DB\s*連線|瀏覽器|顯示器|桌面|X\s*server"
        r"|(?:測試|執行|目標)環境|VPN|GPU)",
        r"(?:無|沒有|未|無法)\s*連線(?!紀錄|記錄|資料|明細|歷史)",           # 「沒有連線紀錄」是資料缺席，不是連不上
        # no 後面接「執行環境」才是 B；接 rows／records／data 是資料缺席（No DB records found 仍是 A）
        # no db／database 只有「就此結束」或接連線／存取類字眼才是環境；接任何名詞（users、orders、match…）是資料缺席
        r"\bno (?:db|database)(?:\s+(?:connection|access|server|available|configured|running|instance))?\s*(?:$|[.,;!)])",
        r"\bno (?:db|database) (?:connection|access|server|instance)\b",
        r"\bno (?:x server|x display|playwright|chromium|firefox|webkit|selenium|webdriver|browser driver|driver)\b",
        r"\bno (?:api (?:key|access|token)|server|backend)\b(?!\s+(?:data|rows?|records?|results?|items?|entries|response data))",
        # 缺的是環境變數（缺少 QA_ADMIN_USER、QA_ADMIN_USER missing）；「TEST_USER 查無」是那筆帳號資料不存在（A）
        # 環境變數名一律大寫（(?-i:…) 關掉整體的 re.I）：小寫的 order_items、customer_id 是資料表／欄位，不是設定
        r"(?:缺少?|未設定?|沒有設定?|\bmissing|\bnot set)\s*(?-i:[A-Z][A-Z0-9]*_[A-Z0-9_]+)\b",
        r"\b(?-i:[A-Z][A-Z0-9]*_[A-Z0-9_]+)\s*(?:missing\b|未設定?|缺少?|\bnot set\b|\bis empty\b|為空)",
        # 「未提供」只有接設定項（環境變數名、憑證、網址…）才是 B；「未提供訂單資料」是資料缺席
        r"未提供\s*(?:(?-i:[A-Z][A-Z0-9_]{2,})|環境變數|設定|憑證|token|金鑰|密碼|帳密|網址|URL)",
        r"\b(?-i:[A-Z][A-Z0-9]*_[A-Z0-9_]*)\s*未提供", r"\bis not set\b", r"\bunset\b",
        # not provided 只有接在設定項後面才是環境（QA_TOKEN not provided、credentials not provided）；
        # 「Test data not provided」是資料缺席（A）
        r"(?:\b(?-i:[A-Z][A-Z0-9]*_[A-Z0-9_]+)|\b(?:env(?:ironment)?(?:\s+var(?:iable)?)?|config(?:uration)?|credentials?"
        r"|token|api\s*key|secret|password|url|base\s*url|host|license))\s+(?:is\s+|are\s+|was\s+)?not provided\b",
        # 環境變數名（QA_TOKEN、QA_ADMIN_URL…）＝缺的是設定。_USER 不算：TEST_USER 查無＝測試帳號這筆資料不存在（A）
        r"\b(?-i:[A-Z][A-Z0-9]*_[A-Z0-9_]*(?:URL|URI|TOKEN|KEY|SECRET|HOST|PORT|PASSWORD|PASS|ENV|DIR|PATH|DSN))\b",
    ],
    # 弱 B：只說到「環境」而沒講環境怎麼了——理由同時有資料缺席的說法時以 A 為準
    # （No test data in this environment 是資料缺席；environment not ready 才是環境）
    "B_weak": [r"\benvironment\b"],
    "C": [
        r"頁面結構", r"結構可能", r"結構已",
        r"\bpage structure\b", r"\blayout changed\b", r"\bstructure changed\b", r"\bselector changed\b",
        r"\bdom changed\b",
    ],
    "D": [
        r"審查中", r"審核中", r"已在審查", r"前次殘留", r"真殘留", r"不重複觸發", r"不疊加",
        r"已鎖", r"鎖定", r"送審快照", r"製造.{0,10}(?:失敗|仍不可點|不成立)", r"前置不成立",
        r"前提不成立", r"仍\s*disabled", r"無法.{0,8}製造", r"種.{0,8}前置情境失敗",
        r"\blocked\b", r"\bin review\b", r"\bpending (?:review|approval)\b", r"\bleftover\b",
        r"\bresidue\b", r"\balready (?:submitted|in progress|locked)\b",
        r"\bprecondition (?:failed|not met)\b", r"\bsetup (?:failed|did not)\b", r"\bstill disabled\b",
        r"\bstate (?:is )?occupied\b",
        # 共用狀態被別的測試／使用者佔用、已被送出、資料已存在（前次殘留）
        r"被(?:其他|別的|另一個?|他人|前一?個?)?\s*(?:測試|test|使用者|人|流程|session)\S{0,4}佔用",
        r"已送出", r"\balready exists\b", r"\balready (?:taken|in use)\b",
        # 「被佔用」要有資料類主詞才算共用狀態（port／檔案被佔用是環境問題，歸 B）
        r"(?:帳號|資料|單據|訂單|使用者|共用\S{0,4})\S{0,4}被佔用", r"已存在",
    ],
    "D_exclude": [
        # 「已存在」不放這裡：「資料已存在（前次殘留）」正是 D 類；放進排除會讓中文理由變成未分類、
        # 繞過 A/D 閘，而英文 already exists 卻判 D——中英口徑不一致
        r"可能", r"未找到", r"無法驗證", r"第一列", r"沒有處於", r"前提已不成立",
        # 「無已存在的 X」「沒有已送出的 X」「已存在的 X 不足」講的是資料缺席（A），不是狀態被佔
        r"(?:無|沒有)\s*已(?:存在|送出)", r"已存在的\S{0,10}(?:不足|太少)",
        r"(?:port|埠|連接埠|檔案|file|目錄).{0,12}被佔用",
        r"(?:\bport\b|(?<!mail[\s-])(?<!mail\s\s)\baddress\b|\bsocket\b).{0,20}\balready in use\b",
        r"\bmaybe\b", r"\bmight\b", r"\bpossibly\b", r"\bno (?:row|record|item)s? (?:in|with)\b",
    ],
}
# 「資料缺席」的結構性訊號：數量／存在性描述也算 A（純關鍵詞列舉會一直漏）。
# 比較運算與 0 只在「數量」語境才算：`rows < 3`、`筆數 == 0`、`got 0 rows` 是資料缺席；
# `Windows 10 only`、`python >= 3.10` 是環境條件，不是 A。
_QTY = r"(?:筆|列|項|個|數量?|樣本|rows?|records?|items?|results?|entries|count|len\(\w*\)|length)"
_A_STRUCTURAL_ZH = (r"%s\s*(?:[<>!]=?|==?)\s*\d|(?:[<>]=?|==)\s*\d+\s*%s|(?<![\w.])0(?![\w.])"
                    r"|筆|列|項|樣本|種子|(?:無|沒有|缺|未|不足|找不到|抓不到|取不到)" % (_QTY, _QTY))
_A_STRUCTURAL_EN = r"\b(?:no|none|zero|empty|lack(?:s|ing)?|count)\b"

LABELS = {
    "A": "A 資料不存在（應改為 fixture 自造，造不出來才 fail）",
    "B": "B 環境不可用（合理保留，但須具名條件）",
    "C": "C 頁面結構變更（是回歸訊號，應改 fail）",
    "D": "D 共用狀態被佔／前置沒做成功（應改 fail：測試該自己還原狀態、把前置做成功）",
    "?": "? 未分類（判準沒涵蓋，需人工看）",
}

_PATS = {}


def _compile(cfg):
    # 以 id(cfg) 當鍵，但一併存 cfg 本身並比對是同一個物件：cfg 被回收後 id 可能被新物件重用，
    # 只比 id 會拿到舊 cfg 的判準
    key = id(cfg)
    hit = _PATS.get(key)
    if hit is not None and hit[0] is cfg:
        return hit[1]
    extra = cfg.get("skip_classify") or {}
    pats = {}
    for k in ("A", "B", "B_weak", "C", "D", "D_exclude"):
        parts = list(_BUILTIN[k]) + [p for p in (extra.get(k) or []) if p]
        pats[k] = re.compile("|".join("(?:%s)" % p for p in parts), re.I)
    pats["A_struct"] = re.compile("%s|%s" % (_A_STRUCTURAL_ZH, _A_STRUCTURAL_EN), re.I)
    _PATS[key] = (cfg, pats)
    return pats


_DATA_UNAVAILABLE = re.compile(
    r"\b(?:data|rows?|records?|orders?|users?|items?|products?|accounts?|customers?|fixtures?|entries|results?)\b"
    r"\s+(?:(?:is|are|was|were)\s+)?(?:not available|unavailable)\b", re.I)   # 主詞緊接著（user service unavailable 仍是 B）


def classify(reason, cfg=None):
    """依理由字串分類：C → D（先過 D 排除）→ B → A（含結構判準）→ ?。"""
    cfg = cfg or qa_config.load()
    p = _compile(cfg)
    reason = reason or ""
    if p["C"].search(reason):
        return "C"
    if p["D"].search(reason) and not p["D_exclude"].search(reason):
        return "D"
    # 「orders not available」「item unavailable」：主詞是業務資料 → 資料缺席（A），不是環境不可用
    if _DATA_UNAVAILABLE.search(reason):
        return "A"
    if p["B"].search(reason):
        return "B"
    if p["A"].search(reason) or p["A_struct"].search(reason):
        return "A"
    if p["B_weak"].search(reason):
        return "B"
    return "?"


def _reason_of(node):
    args = list(node.args)
    if not args:
        for kw in node.keywords:
            if kw.arg in ("reason", "msg"):
                args = [kw.value]
                break
    if not args:
        return ""
    arg = args[0]
    if isinstance(arg, ast.Constant) and isinstance(arg.value, str):
        return arg.value
    if isinstance(arg, ast.JoinedStr):
        return "".join(v.value for v in arg.values
                       if isinstance(v, ast.Constant) and isinstance(v.value, str))
    return ast.unparse(arg) if hasattr(ast, "unparse") else ""


def _is_mark_construction(func):
    """`pytest.mark.skip(...)` / `pytest.mark.skipif(...)`：建 mark 物件＝收集期決定。"""
    return (isinstance(func, ast.Attribute) and func.attr in ("skip", "skipif")
            and isinstance(func.value, ast.Attribute) and func.value.attr == "mark")


def _decorator_call_ids(tree):
    ids = set()
    for node in ast.walk(tree):
        for dec in getattr(node, "decorator_list", ()):
            for sub in ast.walk(dec):
                if isinstance(sub, ast.Call):
                    ids.add(id(sub))
    return ids


def _pytest_aliases(tree):
    """(pytest 模組的別名集合, 從 pytest 匯入的 skip 名稱集合)。`cursor.skip(10)` 之類別的 skip 不算。"""
    mods, skips = {"pytest"}, set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for a in node.names:
                if a.name == "pytest":
                    mods.add(a.asname or "pytest")
        elif isinstance(node, ast.ImportFrom) and node.module == "pytest":
            for a in node.names:
                if a.name == "skip":
                    skips.add(a.asname or "skip")
    return mods, skips


def _in_function_ids(tree):
    """函式（含 fixture、類別方法）裡的所有節點 id。"""
    ids = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)):
            for sub in ast.walk(node):
                if sub is not node:
                    ids.add(id(sub))
    return ids


def runtime_skip_calls(tree):
    decorated = _decorator_call_ids(tree)
    in_func = _in_function_ids(tree)
    mods, skips = _pytest_aliases(tree)
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call) or id(node) in decorated:
            continue
        if _is_mark_construction(node.func):
            continue
        # pytest.skip(..., allow_module_level=True) 且真的在模組層＝收集期就決定（與 skipif 同一類），不是執行期 skip；
        # 寫在測試函式／fixture 裡的仍是執行期 skip（旗標不改變它執行的時機）
        if id(node) not in in_func and any(kw.arg == "allow_module_level" and isinstance(kw.value, ast.Constant)
                                          and kw.value.value is True for kw in node.keywords):
            continue
        fn = node.func
        # 只認 pytest.skip(...)（含 import pytest as pt 的 pt.skip）與 from pytest import skip 之後的 skip(...)
        if isinstance(fn, ast.Attribute) and fn.attr == "skip" and isinstance(fn.value, ast.Name) and fn.value.id in mods:
            yield node
        elif isinstance(fn, ast.Name) and fn.id in skips:
            yield node


_SKIP_CALL_RE = re.compile(r"pytest\.skip\(\s*(?:f?['\"])?([^'\")]{0,160})", re.S)
_EXCLUDE_DIRS = ("__pycache__", ".runs", "outputs", "tools", "reports", "_reports", "node_modules")


def scan(cfg, subdir=None, errors=None):
    """errors（list）：讀不到的檔（相對路徑＋原因）加進去——呼叫端據此判定「掃描不完整」，不得當成乾淨。"""
    root = cfg.root
    hits = {k: [] for k in LABELS}
    base = root if not subdir or subdir == "all" else os.path.join(root, subdir)
    if subdir == "":
        # 根資料夾：只看根目錄下的檔，不遞迴
        walk = [(root, [], [f for f in os.listdir(root) if f.endswith(".py")])]
    else:
        walk = os.walk(base, onerror=lambda e: errors.append("%s（%s）" % (
            os.path.relpath(getattr(e, "filename", "") or base, root).replace("\\", "/"), type(e).__name__))
            if errors is not None else None)
    for dirpath, dirnames, filenames in walk:
        dirnames[:] = [d for d in dirnames if d not in _EXCLUDE_DIRS and not d.startswith(".")]
        for fn in filenames:
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
            try:
                tree = ast.parse(src)
            except SyntaxError:
                for m in _SKIP_CALL_RE.finditer(src):
                    reason = (m.group(1) or "").strip()
                    hits[classify(reason, cfg)].append((rel, src[: m.start()].count("\n") + 1, reason[:90]))
                continue
            for node in runtime_skip_calls(tree):
                reason = _reason_of(node).strip()
                hits[classify(reason, cfg)].append((rel, node.lineno, reason[:90]))
    return hits


def fingerprint(key, rel, reason):
    norm = re.sub(r"\s+", " ", reason or "").strip()[:90]
    return "%s|%s|%s" % (key, rel, norm)


def main(argv=None):
    qa_config.force_utf8_stdio()
    cfg = qa_config.load_or_exit()
    ap = argparse.ArgumentParser(description="skip 四分類稽核")
    ap.add_argument("folder", nargs="?", default="all")
    ap.add_argument("--strict", action="store_true", help="A 或 D 類 > 0 時 exit 1")
    ap.add_argument("--list", action="store_true", help="逐筆列出")
    bl.add_args(ap, bl.default_path(cfg.root, TOOL))
    args = ap.parse_args(argv)
    folder = args.folder.strip("/\\")
    folder = "" if folder == "." else folder
    if folder not in ("all", "") and not os.path.isdir(os.path.join(cfg.root, folder)):
        print("找不到資料夾：%s" % os.path.join(cfg.root, folder))
        return 2

    errors = []
    hits = scan(cfg, folder, errors)
    if errors:
        # 掃描不完整：不得回報「沒有違規」，也不得據此重寫 baseline
        print("[ERROR] 讀不到 %d 個檔，掃描不完整（不當成乾淨、不寫 baseline）：%s" % (len(errors), "、".join(errors[:10])))
        print("QA-TOOL-RESULT: scan-error")
        return 2
    ad_fps = [fingerprint(k, rel, reason) for k in ("A", "D") for rel, _l, reason in hits[k]]

    if args.write_baseline:
        # skip_audit 的 baseline 與其他工具同等保護（理由必填／集合差拒寫／部分掃描拒寫）
        rc, msgs = bl.write(args.write_baseline, ad_fps, args.why, args.allow_raise,
                            full_scan=(args.folder == "all"), tool="skip_audit", unit="處 A/D 類 skip")
        print("\n".join(msgs))
        return rc

    if args.baseline:
        base = bl.load_for_gate(args.baseline)
        if base is None:
            print("[警告] 找不到 baseline：%s（本次以全量計）" % args.baseline)
        new, old = bl.split(ad_fps, base)
        rows = [(k, rel, line, reason) for k in ("A", "D") for rel, line, reason in hits[k]
                if fingerprint(k, rel, reason) in new]
        if not rows:
            if base is not None:
                print("[baseline] 無新增 A/D 類 skip（存量豁免 %d 筆）" % len(old))
            return 0
        print("[baseline] 以下是**新增**的 A/D 類假綠（存量已豁免 %d 筆）：\n" % len(old))
        for k, rel, line, reason in sorted(rows):
            print("  [%s] %s:%s  %s" % (k, rel, line, reason))
        print("\n修法：A＝改 fixture 走產品入口自種自清（造不出來才 fail）；D＝改 fail，teardown 要還原狀態。")
        print("QA-TOOL-RESULT: violations")
        return 1

    total = sum(len(v) for v in hits.values())
    print("執行期 skip 靜態掃描：共 %d 處（收集期 skipif／skip 裝飾器不計）\n" % total)
    for key in ("A", "B", "C", "D", "?"):
        rows = hits[key]
        print("  %s：%d 處" % (LABELS[key], len(rows)))
        if args.list:
            for rel, line, reason in sorted(rows):
                print("      %s:%s  %s" % (rel, line, reason))
    if hits["A"]:
        print("\nA 類 %d 處＝「沒有資料所以跳過」，空庫下會全面觸發而讓通過率失真。" % len(hits["A"]))
    if hits["D"]:
        print("D 類 %d 處＝「共用狀態被佔／前置沒做成功」，測試自己把自己讓開。" % len(hits["D"]))
    if args.strict and (hits["A"] or hits["D"]):
        print("QA-TOOL-RESULT: violations")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
