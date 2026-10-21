# -*- coding: utf-8 -*-
"""測試報告 DOCX 的機械閘。

用途：保證「測試結果總覽表」每一列與「逐項驗證」段落標題 100% 對得上，
且每個情境都指得出證據。閘沒過就不產檔／不交付。

三道閘，由強到弱：

  閘一（結構性）：情境只在 CASES 定義一次，總表與逐項段落由同一個 list 渲染。
                  → 對不上在結構上不可能發生，不是「掃描後沒發現問題」。
  閘二（產出前）：validate_cases() 擋資料源本身殘缺（缺證據、跳號、空話填充）。
                  不通過 raise SystemExit，不產檔。
  閘三（產出後）：verify_docx() 用**不同判準**反向讀 docx 對帳，並用 Word COM 實開。
                  閘一二共用 CASES 這個前提，閘三不讀 CASES 的渲染邏輯，
                  防「python-docx 寫入時被吃掉／錯位」這類前兩閘同構的盲區。

  順序（閘一的一部分）：情境用不變的 key 定義，STAGES 依業務流程列出各階段含哪些 key，
                  arrange() 依 STAGES 排序並自動編號。項次、圖號、階段涵蓋內容全由位置算出，
                  補測的情境插回所屬階段即可，不會因為「插中間要改一堆編號」而被加在最後。

典型用法（生成腳本）：

    import sys
    sys.path.insert(0, r"<plugin>/skills/test-report-docx/scripts")
    from report_gate import (arrange, validate_cases, verify_docx, summary_rows,
                             detail_title, stage_rows, stage_starts)

    CASES = [{"key": "cn-branch", "scope": "中國帳戶只查中國分行", ...}, ...]
    STAGES = [{"name": "外站註冊：銀行帳戶", "keys": ["cn-branch", ...]}, ...]
    CASES = arrange(CASES, STAGES)                           # 排序＋編號
    validate_cases(CASES, base_dir=Path(__file__).parent)   # 閘二

    for name, span, scope, n in stage_rows(CASES):          # 總覽：驗證範圍表
        ...
    for seq, title, result in summary_rows(CASES):          # 閘一：總表
        ...
    starts = stage_starts(CASES)
    for c in CASES:                                          # 閘一：逐項
        if c["id"] in starts:
            doc.add_heading(starts[c["id"]], level=2)        # 階段小標題
        doc.add_heading(detail_title(c), level=3)

    doc.save(out)
    verify_docx(out, CASES)                                  # 閘三
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

__all__ = [
    "arrange",
    "validate_cases",
    "summary_rows",
    "detail_title",
    "figure_no",
    "evidence_label",
    "stage_rows",
    "stage_starts",
    "ref",
    "conclusion",
    "verify_docx",
    "GateError",
]


class GateError(SystemExit):
    """閘沒過。繼承 SystemExit，未被接住時直接中止且回傳非 0。"""


# ── 無指涉詞：填在「實測結果」欄等同沒有證據 ──────────────────────────
_VACUOUS_ACTUAL = {
    "已驗證", "驗證通過", "測試通過", "通過", "正常", "無異常", "符合預期",
    "ok", "OK", "Ok", "pass", "PASS", "Pass", "yes", "YES",
    "沒問題", "無問題", "成功", "已完成", "完成", "-", "—", "N/A", "n/a",
}

# ── 證據型別白名單：使用者裁定「一定要有證明，不限圖片」 ──────────────
#    image     實機截圖（有畫面入口的功能，主證據）
#    db        資料庫查詢結果（實值）
#    payload   系統間傳輸紀錄／送出參數
#    log       執行紀錄／log 行
#    mail      寄出的信件實體（背景寄信等無畫面機制）
#    file      匯出檔案（Excel／CSV／PDF 等產出物）
_EVIDENCE_TYPES = {"image", "db", "payload", "log", "mail", "file"}

_EVIDENCE_LABEL = {
    "image": "實機截圖",
    "db": "資料庫實值",
    "payload": "傳輸參數紀錄",
    "log": "執行紀錄",
    "mail": "信件實體",
    "file": "匯出檔案",
}

_REQUIRED_CASE_KEYS = ("id", "key", "stage", "scope", "title", "expect", "actual", "result", "evidence")

# 截圖檔名以項次開頭（01_xxx.png、15d_xxx.png）＝重排後檔名與圖號會對不上。
# 只認 1～2 位數，日期開頭（2026-10-21_xxx.png）不算
_NUMBERED_SHOT = re.compile(r"^\d{1,2}[a-z]?[_\-](?!\d)")

# 階段名「整個就是」補測／追加／其他這類收容區＝把補測加在最後的換個名字，不是業務流程。
# 整名比對（去空白後），「其他國家帳戶」「補充文件上傳」這類業務名稱不受影響
_CATCHALL_STAGE = re.compile(
    r"^(補測|補拍|補充|追加|新增|其他|其餘|雜項|附加|額外|後補)(的)?(情境|項目|測試|案例|檢核|驗證)?$")

# 「第 N 項」前一個字若是文字（合約第 15 項、規範第 3 項），指的不是本報告的情境；
# 只有前面是開頭、空白、標點或這些引導詞時才算情境引用
_REF_LEADS = set("見如同與及和至或、，。；：（(「『　 ")

# 單一階段塞太多情境＝多半沒分階段（只開一個「全流程」大階段），印提醒
_BIG_STAGE = 8

# 判定欄允許值。「通過」以外一律要在交付揭露講清楚，不可靜默放行。
_ALLOWED_RESULTS = {"通過", "不通過", "未驗證"}


def _norm(s) -> str:
    """比對用正規化：去頭尾空白、全形空白，壓縮連續空白。

    只用於「比對」，不改寫實際寫進文件的字串——文件用原字串。
    """
    return re.sub(r"\s+", "", str(s).replace("　", " ")).strip()


def _text(v) -> str:
    """必填文字欄位取值：只收字串，None／數字／list 一律視為空（避免 str(None)＝"None" 混過去）。"""
    return v.strip() if isinstance(v, str) else ""


# 階段小標題允許的前綴：「（一）」「一、」「1.」「1、」「(1)」
_STAGE_PREFIX = re.compile(r"^(（[一二三四五六七八九十]+）|\([0-9一二三四五六七八九十]+\)|[一二三四五六七八九十]+、|[0-9]+[.、])")


def _stage_heading_name(text) -> str:
    """從階段小標題去掉序號前綴後正規化，供閘三『精確』比對階段名（不用子字串包含）。"""
    return _norm(_STAGE_PREFIX.sub("", _norm(text)))


class _Arranged(list):
    """arrange() 的回傳型別。閘二用它判斷 CASES 真的經過 arrange，而不是手寫了 key／stage／id。"""


# ══════════════════════════════════════════════════════════════════════
# 閘一：單一資料源的渲染輔助
#   總表與逐項段落都只能經由這裡取字，確保兩邊拿到的是同一份 title。
# ══════════════════════════════════════════════════════════════════════

def summary_rows(cases):
    """總覽表的列。回傳 [(序號字串, 情境名, 判定), ...]。

    總表只有三欄——預期／實測／證據全部在逐項段落，避免讀者兩邊對照
    （document-readability.md 鐵則 1）。
    """
    return [(str(c["id"]), c["title"], c["result"]) for c in cases]


def detail_title(case) -> str:
    """逐項驗證的段落標題：『N　情境名』（全形空格分隔）。

    情境名取自同一個 case dict，與 summary_rows 同源，無法歧異。
    """
    return "{}　{}".format(case["id"], case["title"])


def evidence_label(ev) -> str:
    """證據的中文形式標籤，供圖說／證據段落使用。"""
    return _EVIDENCE_LABEL.get(ev.get("type", ""), "證據")


def figure_no(case, idx) -> str:
    """圖號：『N-M』（情境號－該情境內序號）。

    圖號自帶情境號，孤兒圖與缺圖在版面上直接露餡，不必靠讀者交叉比對。
    idx 為 0-based。
    """
    return "{}-{}".format(case["id"], idx + 1)


def arrange(cases, stages):
    """依 STAGES 排序並編號，回傳新 list（不改動傳入的 dict）。

    cases：每項以不變的 key 識別（不寫 id——項次由位置決定）。
    stages：[{"name": 階段名, "keys": [key, ...]}, ...]，依業務流程排：主流程從頭走到底，
            分支（退件、權限、異常）放後面。補測的情境把 key 插進所屬階段，不加在最後。

    結構有缺就 raise GateError：階段引用不存在的 key（空引用）、情境沒排進任何階段、
    同一情境出現在兩處、key 重複、階段名空白／重複／是「補測、其他」這類收容區、階段沒有情境、
    輸入型別不對。
    """
    errs = []
    if not isinstance(stages, (list, tuple)) or not stages:
        raise GateError("排序閘不通過：STAGES 為空。情境要依業務流程分階段排列。")
    if not isinstance(cases, (list, tuple)) or not cases:
        raise GateError("排序閘不通過：CASES 為空，報告無情境可寫。")
    bad = [i for i, c in enumerate(cases, 1) if not isinstance(c, dict)]
    bad_s = [i for i, s in enumerate(stages, 1) if not isinstance(s, dict)]
    if bad or bad_s:
        raise GateError(
            "排序閘不通過：CASES 第 {} 筆、STAGES 第 {} 筆不是 dict".format(bad or "—", bad_s or "—")
        )

    by_key = {}
    for i, c in enumerate(cases, 1):
        k = _text(c.get("key"))
        if not k:
            errs.append("CASES 第 {} 筆沒有 key（要是非空字串；情境用不變的 key 識別，項次由 STAGES 排出）".format(i))
        elif k in by_key:
            errs.append("key「{}」重複".format(k))
        else:
            by_key[k] = c
        if "id" in c:
            errs.append(
                "key「{}」自己寫了 id——項次由 arrange() 依 STAGES 位置產生，不要手寫"
                "（對 arrange() 的結果再 arrange 一次也會觸發這條）".format(k or i)
            )

    seen_names = {}
    placed = {}
    norm_keys = []
    for i, s in enumerate(stages, 1):
        name = _text(s.get("name"))
        if not name:
            errs.append("STAGES 第 {} 筆沒有 name（要是非空字串）".format(i))
            name = "（第 {} 個階段）".format(i)
        elif _norm(name) in seen_names:
            errs.append("階段名「{}」與「{}」重複（忽略空白後相同）".format(name, seen_names[_norm(name)]))
        else:
            seen_names[_norm(name)] = name
        if _CATCHALL_STAGE.match(_norm(name)):
            errs.append(
                "階段名「{}」是收容區，不是業務流程——補測的情境要插回它所屬的流程階段".format(name)
            )
        keys = s.get("keys")
        if not isinstance(keys, (list, tuple)):
            errs.append("階段「{}」的 keys 要是 list（實際是 {}）".format(name, type(keys).__name__))
            keys = []
        elif not keys:
            errs.append("階段「{}」沒有任何情境".format(name))
        norm_keys.append([k.strip() if isinstance(k, str) else k for k in keys])
        for k in norm_keys[-1]:
            if not isinstance(k, str):
                errs.append("階段「{}」的 keys 含非字串值 {!r}".format(name, k))
            elif k not in by_key:
                errs.append(
                    "階段「{}」引用了不存在的情境「{}」——證據還沒補齊就不要先排進來；"
                    "補不出來就從 STAGES 拿掉並走交付揭露".format(name, k)
                )
            elif k in placed:
                errs.append("情境「{}」同時排在「{}」與「{}」".format(k, placed[k], name))
            else:
                placed[k] = name

    for k in by_key:
        if k not in placed:
            errs.append("情境「{}」沒有排進任何階段——要插回它所屬的流程位置，不是加在最後".format(k))

    if errs:
        raise GateError(
            "\n排序閘不通過，以下 {} 項必須先修，未產出任何檔案：\n".format(len(errs))
            + "\n".join("  - " + e for e in errs)
            + "\n"
        )

    out = _Arranged()
    for s, keys in zip(stages, norm_keys):
        if len(keys) >= _BIG_STAGE:
            print("  提醒（不擋）：階段「{}」有 {} 個情境，確認不是把整份報告塞進單一階段"
                  "（照使用者實際走的流程切開）".format(_text(s["name"]), len(keys)))
        for k in keys:
            c = dict(by_key[k])
            c["key"] = k
            c["id"] = len(out) + 1
            c["stage"] = _text(s["name"])
            out.append(c)
    return out


def ref(cases, key) -> str:
    """正文交叉引用：「第 N 項」由 key 查出，不寫死項次（重排後才不會指錯）。"""
    for c in cases:
        if c["key"] == key:
            return "第 {} 項".format(c["id"])
    raise GateError("ref() 找不到情境「{}」".format(key))


def conclusion(cases, tail="全數驗證通過，建議部署。") -> str:
    """結論句：「〈階段〉 N 項、〈階段〉 M 項，全數驗證通過…」，數字取自 stage_rows()。

    有非「通過」的情境時不要用預設 tail，照實寫。
    """
    return "、".join("{} {} 項".format(r[0], r[3]) for r in stage_rows(cases)) + "，" + tail


def stage_starts(cases):
    """{該階段第一項的 id: 階段名}，逐項段落在這些位置前插階段小標題。"""
    starts, prev = {}, None
    for c in cases:
        if c["stage"] != prev:
            starts[c["id"]] = c["stage"]
            prev = c["stage"]
    return starts


def stage_rows(cases):
    """總覽的驗證範圍表。回傳 [(階段名, 「第 a～b 項」, 涵蓋內容, 項數), ...]。

    涵蓋內容由該階段各情境的 scope 串成，不手寫——沒有情境就不會出現對應的宣稱
    （鐵則 8：宣稱必須逐項對得上實際檢核）。
    """
    rows = []
    for c in cases:
        if rows and rows[-1][0] == c["stage"]:
            rows[-1][1].append(c)
        else:
            rows.append((c["stage"], [c]))
    out = []
    for name, cs in rows:
        a, b = cs[0]["id"], cs[-1]["id"]
        span = "第 {} 項".format(a) if a == b else "第 {}～{} 項".format(a, b)
        out.append((name, span, "；".join(str(c["scope"]).strip() for c in cs), len(cs)))
    return out


# ══════════════════════════════════════════════════════════════════════
# 閘二：產出前驗證資料源
# ══════════════════════════════════════════════════════════════════════

def validate_cases(cases, base_dir=None, strict_image=True):
    """檢查 CASES 是否具備產出資格。不通過 raise GateError，不產檔。

    base_dir：type=image 的相對 path 以此為基準解析；None 則以 CWD。
    strict_image：True 時 image 證據的檔案必須存在（預設；關掉等於放棄本閘）。
    """
    errs = []

    if not isinstance(cases, (list, tuple)) or not cases:
        raise GateError("閘二不通過：CASES 為空，報告無情境可寫。")

    base = Path(base_dir) if base_dir else Path.cwd()

    # ── 必須是 arrange() 的回傳物件：手寫 key／stage／id 的 list 不算 ──
    #    （arrange 結果被切片、重新組 list 也會失去這個型別——要改順序就改 STAGES 重跑 arrange）
    if not isinstance(cases, _Arranged):
        raise GateError(
            "\n閘二不通過：CASES 不是 arrange(CASES, STAGES) 的回傳結果。\n"
            "  情境要用 key 定義、依業務流程分階段排序，項次由位置產生（見 SKILL.md〈情境順序〉）。\n"
            "  手寫 key／stage／id、或把 arrange 的結果切片重組，都不算。\n"
        )

    # ── 同一階段必須連續（arrange 之後又被改動時的兜底）──
    seen_stage, prev = set(), None
    for c in cases:
        st = _norm(c.get("stage", ""))
        if st != prev:
            if st in seen_stage:
                errs.append(
                    "階段「{}」被拆成不連續的兩段（第 {} 項又回到此階段）——"
                    "同流程的情境要排在一起".format(st, c.get("id", "?"))
                )
            seen_stage.add(st)
            prev = st

    # ── 編號：必須是 1..N 連續、無重複、無跳號 ──
    ids = [c.get("id") for c in cases]
    if ids != list(range(1, len(cases) + 1)):
        errs.append(
            "編號必須是 1..{} 連續且無重複，實際為 {}"
            "（純序號、不加字母前綴——見 SKILL.md 決定一）".format(len(cases), ids)
        )

    # ── 情境名：不得空、不得重複（重複會讓總表與逐項無法一對一對應）──
    seen = {}
    for c in cases:
        cid = c.get("id", "?")
        key = _norm(_text(c.get("title")))
        if not key:
            errs.append("第 {} 項 title 為空".format(cid))
            continue
        if key in seen:
            errs.append(
                "第 {} 項與第 {} 項情境名重複（「{}」）；"
                "總表與逐項將無法一對一對應，請改寫其中一項".format(cid, seen[key], c["title"])
            )
        else:
            seen[key] = cid

    numbered = []
    for c in cases:
        cid = c.get("id", "?")

        missing = [k for k in _REQUIRED_CASE_KEYS if k not in c]
        if missing:
            errs.append("第 {} 項缺欄位：{}".format(cid, "、".join(missing)))
            continue

        for k in ("scope", "expect", "actual", "result"):
            if not _text(c[k]):
                errs.append("第 {} 項 {} 為空".format(cid, k))

        # ── 實測結果不得是無指涉詞 ──
        actual = str(c["actual"]).strip()
        if _norm(actual) in {_norm(v) for v in _VACUOUS_ACTUAL}:
            errs.append(
                "第 {} 項實測結果是無指涉詞「{}」——那是判定不是證據。"
                "請寫值層級事實（資料庫實值、送出參數逐欄比對）".format(cid, actual)
            )

        result = str(c["result"]).strip()
        if result not in _ALLOWED_RESULTS:
            errs.append(
                "第 {} 項判定「{}」不在允許值 {} 內".format(cid, result, "／".join(sorted(_ALLOWED_RESULTS)))
            )

        # ── 證據：一定要有，形式不限圖片（使用者裁定）──
        evs = c.get("evidence") or []
        if not evs:
            errs.append(
                "第 {} 項無證據。每個進報告的情境都必須指得出證明"
                "（形式可為 {}）；補不出來就把該情境移出報告、走交付揭露"
                .format(cid, "／".join(sorted(_EVIDENCE_TYPES)))
            )
            continue

        for i, ev in enumerate(evs, 1):
            if not isinstance(ev, dict):
                errs.append("第 {} 項證據 {} 不是 dict".format(cid, i))
                continue
            etype = ev.get("type", "")
            if etype not in _EVIDENCE_TYPES:
                errs.append(
                    "第 {} 項證據 {} 的 type「{}」不在允許值 {} 內"
                    .format(cid, i, etype, "／".join(sorted(_EVIDENCE_TYPES)))
                )
            if not str(ev.get("caption", "")).strip():
                errs.append(
                    "第 {} 項證據 {} 缺 caption。圖說要寫『這張證明了什麼』，"
                    "不是重述情境名".format(cid, i)
                )
            if etype == "image":
                p = ev.get("path", "")
                if _NUMBERED_SHOT.match(Path(str(p)).name):
                    numbered.append(Path(str(p)).name)
                if not str(p).strip():
                    errs.append("第 {} 項證據 {} 為 image 但沒有 path".format(cid, i))
                elif strict_image:
                    fp = Path(p)
                    if not fp.is_absolute():
                        fp = base / fp
                    if not fp.exists():
                        errs.append(
                            "第 {} 項證據 {} 的截圖檔不存在：{}"
                            "（證據盤點要實際開檔核對，別憑對話記憶）".format(cid, i, fp)
                        )
                    elif fp.stat().st_size < 20 * 1024:
                        errs.append(
                            "第 {} 項證據 {} 的截圖僅 {:.1f} KB，疑似空白頁／未載入完成，"
                            "請開圖確認：{}".format(cid, i, fp.stat().st_size / 1024, fp)
                        )
            else:
                # 非圖片證據必須有可引用的內容，不能只寫個 type 交差
                if not str(ev.get("content", "")).strip():
                    errs.append(
                        "第 {} 項證據 {}（{}）缺 content。"
                        "非圖片證據要附可引用的實際內容：查詢結果、參數逐欄、log 行"
                        .format(cid, i, etype)
                    )

    if numbered:
        print("  提醒（不擋）：{} 張截圖檔名以數字開頭（例：{}），重排後檔名與圖號對不上；"
              "新拍的截圖請用情境 key 命名".format(len(numbered), numbered[0]))

    if errs:
        raise GateError(
            "\n閘二不通過，以下 {} 項必須先補，未產出任何檔案：\n".format(len(errs))
            + "\n".join("  - " + e for e in errs)
            + "\n"
        )

    return True


# ══════════════════════════════════════════════════════════════════════
# 閘三：產出後以不同判準反向比對
# ══════════════════════════════════════════════════════════════════════

def _extract_from_docx(docx_path):
    """從產出的 docx 反向抽事實。不參照 CASES，也不重用渲染函式。

    回傳 dict：
      summary  [(序號, 情境名, 判定), ...]  來自第一張含表頭「編號」的表
      details  [(序號, 情境名), ...]        來自 Heading 3 段落
      under    {序號: 上方最近的 Heading 2 文字}
      ranges   [[(階段名, 第 a～b 項), ...], ...]  每張表頭含「對應項目」且至少兩欄的表各一份
      refs     [int, ...]                   全文被當成情境引用的「第 N 項」數字
      images   int                          InlineShapes 數
    """
    try:
        from docx import Document
    except ImportError:
        raise GateError("閘三需要 python-docx：pip install python-docx")

    doc = Document(str(docx_path))

    # ── 總表：找第一張表頭含「編號」的表 ──
    summary = []
    for tbl in doc.tables:
        if not tbl.rows:
            continue
        head = [_norm(c.text) for c in tbl.rows[0].cells]
        if "編號" in head:
            for row in tbl.rows[1:]:
                cells = [c.text.strip() for c in row.cells]
                if len(cells) >= 3 and cells[0]:
                    summary.append((cells[0].strip(), cells[1].strip(), cells[2].strip()))
            break

    # ── 逐項：Heading 3 段落，格式「N　情境名」 ──
    # ── 每個逐項段落上方最近的 Heading 2（階段小標題）──
    details = []
    under = {}
    pat = re.compile(r"^\s*(\d+)[\s　]+(.+?)\s*$")
    last_h2 = ""
    for p in doc.paragraphs:
        style = (p.style.name or "").lower()
        if style.startswith("heading 2"):
            last_h2 = p.text
        elif style.startswith("heading 3"):
            m = pat.match(p.text)
            if m:
                details.append((m.group(1), m.group(2)))
                under[m.group(1)] = last_h2

    # ── 驗證範圍表候選：表頭含「對應項目」且至少兩欄的表，取（階段名, 第 a～b 項）──
    #    可能不只一張（文件別處也可能有同名欄位的表），全部收下由 verify_docx 判斷有沒有一張對得上
    ranges = []
    for tbl in doc.tables:
        if not tbl.rows:
            continue
        head = [_norm(c.text) for c in tbl.rows[0].cells]
        if "對應項目" in head and len(head) >= 2:
            ranges.append([(r.cells[0].text.strip(), r.cells[1].text.strip())
                           for r in tbl.rows[1:] if len(r.cells) >= 2])

    # ── 全文（段落＋表格）裡的「第 N 項」「第 a～b 項」引用 ──
    texts = [p.text for p in doc.paragraphs]
    for tbl in doc.tables:
        for row in tbl.rows:
            texts.extend(c.text for c in row.cells)
    refs = []
    for t in texts:
        for m in re.finditer(r"第\s*(\d+)\s*(?:[～~\-－至到]\s*(\d+)\s*)?項", t):
            before = t[m.start() - 1] if m.start() > 0 else ""
            if before and before not in _REF_LEADS:
                continue                                  # 「合約第 15 項」不是情境引用
            refs.extend(int(x) for x in m.groups() if x)

    images = len(doc.inline_shapes)
    return {"summary": summary, "details": details, "under": under, "images": images,
            "ranges": ranges, "refs": refs}


def verify_docx(docx_path, cases, open_with_word=True, check_readability=True):
    """閘三。讀回產出的 docx，與 CASES 對帳；用 Word 實開確認檔案能開；再跑易讀性自檢。

    check_readability：呼叫同 plugin 的 check-before/scripts/check_doc.js（與 Stop hook 同一套判準）。
    接在這裡而不是靠 Stop hook——hook 只掃 cwd／_work／docs／output，報告規定放的
    tests/reports/<主題>_<日期>/ 不在它的範圍內，靠 hook 等於沒掃。

    open_with_word：Windows 上以 COM 實際開檔（python-docx 開得了 ≠ Word 開得了）。
    """
    docx_path = Path(docx_path)
    if not docx_path.exists():
        raise GateError("閘三不通過：產出檔不存在 {}".format(docx_path))

    got = _extract_from_docx(docx_path)
    errs = []

    exp_sum = [(str(c["id"]), _norm(c["title"]), _norm(c["result"])) for c in cases]
    exp_det = [(str(c["id"]), _norm(c["title"])) for c in cases]

    got_sum = [(a, _norm(b), _norm(cc)) for a, b, cc in got["summary"]]
    got_det = [(a, _norm(b)) for a, b in got["details"]]

    # ① 總表列數 == 情境數
    if len(got_sum) != len(cases):
        errs.append(
            "總表 {} 列，CASES {} 項——有情境沒被寫進總表，或總表多了列"
            .format(len(got_sum), len(cases))
        )

    # ② 逐項段落數 == 情境數
    if len(got_det) != len(cases):
        errs.append(
            "逐項段落 {} 個，CASES {} 項——有情境沒被寫進逐項，或多了段落"
            .format(len(got_det), len(cases))
        )

    # ③ 總表 ↔ 逐項：序號與情境名必須逐項一致（這是使用者要的 100% 對應）
    s_map = {a: b for a, b, _ in got_sum}
    d_map = dict(got_det)
    only_summary = sorted(set(s_map) - set(d_map), key=lambda x: int(x) if x.isdigit() else 0)
    only_detail = sorted(set(d_map) - set(s_map), key=lambda x: int(x) if x.isdigit() else 0)
    if only_summary:
        errs.append("這些編號在總表有、逐項沒有：{}".format("、".join(only_summary)))
    if only_detail:
        errs.append("這些編號在逐項有、總表沒有：{}".format("、".join(only_detail)))
    for k in sorted(set(s_map) & set(d_map), key=lambda x: int(x) if x.isdigit() else 0):
        if s_map[k] != d_map[k]:
            errs.append(
                "第 {} 項情境名不一致：總表「{}」／逐項「{}」".format(k, s_map[k], d_map[k])
            )

    # ④ 產出 ↔ CASES：防渲染階段被吃掉或錯位
    if got_sum != exp_sum:
        diff = [
            "  第 {} 項 期望（{}｜{}）實得（{}｜{}）".format(
                e[0], e[1], e[2],
                (g[1] if g else "—"), (g[2] if g else "—"),
            )
            for e, g in zip(exp_sum, got_sum + [None] * (len(exp_sum) - len(got_sum)))
            if e != g
        ]
        errs.append("總表內容與 CASES 不符：\n" + "\n".join(diff))
    if got_det != exp_det:
        errs.append(
            "逐項標題與 CASES 不符：期望 {}／實得 {}".format(exp_det, got_det)
        )

    # ④-2 階段小標題：每個逐項段落上方最近的 Heading 2，去掉「（一）」這類序號後必須「等於」階段名
    #      （不用子字串包含——「送審」會被「退件後重新送審」誤放行，一個泛稱標題也會涵蓋全部階段）
    for c in cases:
        h2 = got["under"].get(str(c["id"]))
        if h2 is not None and _stage_heading_name(h2) != _norm(c["stage"]):
            errs.append(
                "第 {} 項應在階段標題「{}」底下（Heading 2，可加「（一）」前綴），"
                "文件中它上方的 Heading 2 是「{}」".format(c["id"], c["stage"], h2 or "（無）")
            )

    # ④-3 驗證範圍表（表頭含「對應項目」）必須與 stage_rows() 逐列相同
    exp_ranges = [(_norm(r[0]), _norm(r[1])) for r in stage_rows(cases)]
    cands = [[(_norm(a), _norm(b)) for a, b in t] for t in got["ranges"]]
    if not cands:
        errs.append("找不到驗證範圍表（表頭含「對應項目」、至少兩欄）——總覽要列各階段與對應項次，由 stage_rows() 產生")
    elif exp_ranges not in cands:
        errs.append(
            "驗證範圍表與階段不符：期望 {}／文件中的候選表 {}（範圍表要由 stage_rows() 產生，不手寫）"
            .format([" ".join(r) for r in exp_ranges], [[" ".join(r) for r in t] for t in cands])
        )

    # ④-4 全文的「第 N 項」引用不得超出情境數（寫死的項次在重排後會指錯；用 ref() 由 key 查）
    over = sorted({n for n in got["refs"] if n < 1 or n > len(cases)})
    if over:
        errs.append(
            "文件引用了不存在的項次：第 {} 項（共 {} 項）——交叉引用用 ref(CASES, key) 產生，不寫死"
            .format("、".join(map(str, over)), len(cases))
        )

    # ⑤ 圖片數：文件內圖片數 == CASES 的 image 證據數
    exp_imgs = sum(
        1 for c in cases for ev in (c.get("evidence") or []) if ev.get("type") == "image"
    )
    if got["images"] != exp_imgs:
        errs.append(
            "文件內圖片 {} 張，CASES 宣告 image 證據 {} 筆——有圖沒插進去，或插了不在清單的圖"
            .format(got["images"], exp_imgs)
        )

    # ⑥ Word 實開（交付檔案格式紀律：不能只用寫檔的同一套函式庫自我驗證）
    if open_with_word and sys.platform == "win32":
        errs.extend(_word_open_check(docx_path))

    # ⑦ 易讀性自檢（硬缺陷擋、提醒照印）。check_doc.js 讀 docx 改用純 Node 解壓，各平台都能跑；
    #    只有其中的「目錄頁碼」要開 Word，非 Windows 會記為未檢查（印在提醒裡）
    if check_readability:
        errs.extend(_readability_check(docx_path))

    if errs:
        raise GateError(
            "\n閘三不通過（對帳、Word 實開或易讀性；檔案已產出但不得交付）：\n"
            + "\n".join("  - " + e for e in errs)
            + "\n"
        )

    return True


def _readability_check(docx_path):
    """跑 check_doc.js。硬缺陷、讀不到、沒有 node 都算不通過；提醒只印出來由人判斷。"""
    import json
    import shutil
    import subprocess
    checker = (Path(__file__).resolve().parent.parent.parent
               / "check-before" / "scripts" / "check_doc.js")
    node = shutil.which("node")
    if not node:
        return ["本機找不到 node，未能跑易讀性自檢（check_doc.js）——此項屬未驗證"]
    if not checker.exists():
        return ["找不到易讀性自檢腳本 {}".format(checker)]
    r = subprocess.run([node, str(checker), str(Path(docx_path).resolve()), "--json"],
                       capture_output=True, timeout=180)
    out = r.stdout.decode("utf-8", "replace").strip()
    if r.returncode == 2 or not out.startswith("{"):
        return ["易讀性自檢讀不到產出檔：{}".format(out or r.stderr.decode("utf-8", "replace").strip())]
    res = json.loads(out)
    for n in res["notes"]:
        print("  易讀性提醒（不擋，逐條判斷）：" + n)
    return ["易讀性：" + b for b in res["bad"]]


def _word_open_check(docx_path):
    """用 Word COM 實際開檔。開不了就是壞檔，不管 python-docx 讀不讀得動。"""
    errs = []
    try:
        import win32com.client  # type: ignore
    except ImportError:
        return ["未安裝 pywin32，未能以 Word 實開驗證（pip install pywin32）"
                "——此項屬未驗證，不可宣稱『Word 開得了』"]

    word = None
    doc = None
    try:
        word = win32com.client.Dispatch("Word.Application")
        word.Visible = False
        word.DisplayAlerts = 0
        doc = word.Documents.Open(str(Path(docx_path).resolve()), ReadOnly=True)
        if doc.Paragraphs.Count <= 0:
            errs.append("Word 開啟後段落數為 0")
    except Exception as exc:  # noqa: BLE001
        errs.append("Word 無法開啟此檔：{}".format(exc))
    finally:
        try:
            if doc is not None:
                doc.Close(False)
        except Exception:  # noqa: BLE001
            pass
        try:
            if word is not None:
                word.Quit()
        except Exception:  # noqa: BLE001
            pass
    return errs


# ══════════════════════════════════════════════════════════════════════
# 自測：python report_gate.py --selftest
#   驗的是「閘會不會擋」，不是「閘寫得出來」。
# ══════════════════════════════════════════════════════════════════════

def _raw(key, title, scope):
    return {
        "key": key, "title": title, "scope": scope,
        "expect": "SAP 端帳號＝畫面最新值",
        "actual": "資料庫 0012345 → SAP 傳輸參數 0012345，逐欄一致",
        "result": "通過",
        "evidence": [{"type": "db", "content": "SELECT bank_acct → 0012345",
                      "caption": "資料庫實值"}],
    }


def _selftest():
    failures = []

    # ── 排序閘：arrange() ──
    raw = [
        _raw("reject", "退件後出現編輯鈕", "退件後解鎖"),
        _raw("submit", "送審後資料鎖定", "送審後鎖定"),
        _raw("cn", "中國帳戶只出中國分行", "中國帳戶只查中國分行"),
        _raw("swift", "美國帳戶用 SWIFT 選銀行", "其他國家用 SWIFT 選銀行"),
    ]
    stages = [
        {"name": "外站註冊", "keys": ["cn", "swift"]},
        {"name": "送審", "keys": ["submit"]},
        {"name": "退件後修改", "keys": ["reject"]},
    ]
    arranged = None
    try:
        arranged = arrange(raw, stages)
    except GateError as e:
        failures.append("合法 STAGES 被誤擋：{}".format(e))
    if arranged:
        if [c["key"] for c in arranged] != ["cn", "swift", "submit", "reject"]:
            failures.append("arrange 沒照 STAGES 排序：{}".format([c["key"] for c in arranged]))
        if [c["id"] for c in arranged] != [1, 2, 3, 4]:
            failures.append("arrange 編號不是 1..N")
        if any("id" in c for c in raw):
            failures.append("arrange 改動了傳入的 dict")
        if stage_starts(arranged) != {1: "外站註冊", 3: "送審", 4: "退件後修改"}:
            failures.append("stage_starts 錯：{}".format(stage_starts(arranged)))
        rows = stage_rows(arranged)
        if rows[0] != ("外站註冊", "第 1～2 項", "中國帳戶只查中國分行；其他國家用 SWIFT 選銀行", 2) \
                or rows[1][1] != "第 3 項":
            failures.append("stage_rows 錯：{}".format(rows))
        try:
            validate_cases(arranged)
        except GateError as e:
            failures.append("arrange 後的合法 CASES 被閘二誤擋：{}".format(e))
        # 插到中間：補測的 swift 放回外站註冊，後面自動順延
        ins = arrange(raw + [_raw("tw", "台灣帳戶只出台灣分行", "台灣帳戶只查台灣分行")],
                      [{"name": "外站註冊", "keys": ["cn", "tw", "swift"]}] + stages[1:])
        if [(c["key"], c["id"]) for c in ins][:4] != [("cn", 1), ("tw", 2), ("swift", 3), ("submit", 4)]:
            failures.append("插中間後未自動重編：{}".format([(c["key"], c["id"]) for c in ins]))

    # 每個違規都要被「預期的那條理由」擋下，不是被別的檢查順手擋掉
    def expect_block(fn, label, needle, bucket):
        try:
            fn()
        except GateError as e:
            if needle not in str(e):
                failures.append("{}『{}』被擋了，但理由不對（應含「{}」）：{}".format(
                    bucket, label, needle, str(e).strip().splitlines()[-1]))
        else:
            failures.append("{}『{}』應被擋卻放行".format(bucket, label))

    arrange_should_fail = [
        ("階段引用不存在的情境", raw, stages + [{"name": "權限", "keys": ["ghost"]}], "不存在的情境"),
        ("情境沒排進階段", raw + [_raw("orphan", "孤兒情境", "x")], stages, "沒有排進任何階段"),
        ("同一情境排在兩處", raw, stages + [{"name": "權限", "keys": ["cn"]}], "同時排在"),
        ("key 重複", raw + [_raw("cn", "另一個情境", "x")], stages, "重複"),
        ("手寫 id", [dict(raw[0], id=9)] + raw[1:], stages, "自己寫了 id"),
        ("階段名重複（只差空白）", raw, [stages[0], dict(stages[1], name="外站 註冊"), stages[2]], "重複"),
        ("階段沒有情境", raw, stages + [{"name": "權限", "keys": []}], "沒有任何情境"),
        ("收容區階段名", raw + [_raw("late", "後補情境", "x")],
         stages + [{"name": "補測項目", "keys": ["late"]}], "收容區"),
        ("keys 寫成字串", raw, [dict(stages[0], keys="cn")] + stages[1:], "要是 list"),
        ("key 是 None", [dict(raw[0], key=None)] + raw[1:], stages, "沒有 key"),
        ("階段名是 None", raw, [dict(stages[0], name=None)] + stages[1:], "沒有 name"),
        ("情境不是 dict", raw + ["cn"], stages, "不是 dict"),
    ]
    for name, cs, sts, needle in arrange_should_fail:
        expect_block(lambda: arrange(cs, sts), name, needle, "排序閘")

    # ── 閘二 ──
    ok_case = arrange([_raw("bank", "供應商送件後 SAP 收到最新銀行帳號", "SAP 收到最新帳號")],
                      [{"name": "送件", "keys": ["bank"]}])

    def arr(*cs):
        return _Arranged(cs)

    split = arr(*[dict(arranged[i]) for i in (0, 2, 1)]) if arranged else arr()
    for i, c in enumerate(split, 1):
        c["id"] = i
    hand = [dict(c) for c in arranged] if arranged else []          # 內容一樣，但不是 arrange 的回傳
    cases_should_fail = [
        ("手寫 key／stage／id 不經 arrange", hand, "不是 arrange"),
        ("arrange 結果切片重組", list(arranged or []), "不是 arrange"),
        ("同階段被拆開", split, "不連續"),
        ("同階段被拆開（名稱多空白）", arr(*[dict(c, stage=c["stage"] + (" " if i == 2 else ""))
                                       for i, c in enumerate(split)]), "不連續"),
        ("scope 空白", arr(dict(ok_case[0], scope=" ")), "scope 為空"),
        ("scope 是 None", arr(dict(ok_case[0], scope=None)), "scope 為空"),
        ("無證據", arr(dict(ok_case[0], evidence=[])), "無證據"),
        ("跳號", arr(dict(ok_case[0], id=2)), "連續"),
        ("實測欄空話", arr(dict(ok_case[0], actual="測試通過")), "無指涉詞"),
        ("情境名重複", arr(dict(ok_case[0]), dict(ok_case[0], id=2)), "情境名重複"),
        ("判定值非法", arr(dict(ok_case[0], result="大致 OK")), "不在允許值"),
        ("證據缺 content", arr(dict(ok_case[0], evidence=[{"type": "db", "caption": "x"}])), "缺 content"),
        ("證據缺 caption", arr(dict(ok_case[0], evidence=[{"type": "db", "content": "x"}])), "缺 caption"),
        ("圖檔不存在", arr(dict(ok_case[0], evidence=[{"type": "image", "path": "no_such_file.png",
                                                     "caption": "x"}])), "不存在"),
    ]

    try:
        validate_cases(ok_case)
    except GateError as e:
        failures.append("合法 CASES 被誤擋：{}".format(e))

    for name, bad, needle in cases_should_fail:
        expect_block(lambda: validate_cases(bad), name, needle, "閘二")

    if not _NUMBERED_SHOT.match("15d_finance.png") or _NUMBERED_SHOT.match("2026-10-21_login.png"):
        failures.append("截圖檔名提醒的判準錯：該抓項次開頭、不該抓日期開頭")

    # ── 閘三（不開 Word、不跑易讀性；只驗對帳判準）──
    n_docx = 0
    try:
        import docx  # noqa: F401
    except ImportError:
        print("  （未安裝 python-docx，略過閘三自測）")
    else:
        if arranged:
            n_docx = _selftest_docx(arranged, failures, expect_block)
        else:
            failures.append("arrange 失敗，略過閘三自測")

    # 業務名稱不得被當成收容區；整個就是收容區的才擋
    for ok_name in ("其他國家帳戶", "補充文件上傳", "附加檔案", "額外費用申請", "新增供應商"):
        try:
            arrange(raw, [dict(stages[0], name=ok_name)] + stages[1:])
        except GateError as e:
            failures.append("排序閘：業務階段名「{}」被誤擋：{}".format(ok_name, str(e).strip().splitlines()[-1]))
    for bad_name in ("補測", "其他", "其他情境", "追加測試", "後補項目", "補 測"):
        expect_block(lambda: arrange(raw, [dict(stages[0], name=bad_name)] + stages[1:]),
                     "收容區「{}」".format(bad_name), "收容區", "排序閘")

    # 閘一同源性：總表與逐項標題必須來自同一個 title
    rows = summary_rows(ok_case)
    title = detail_title(ok_case[0])
    if _norm(rows[0][1]) not in _norm(title):
        failures.append("閘一失效：總表情境名與逐項標題不同源")

    if failures:
        print("SELFTEST FAILED:")
        for f in failures:
            print("  - " + f)
        raise SystemExit(1)
    print("SELFTEST OK：合法案例放行、排序與插入重編正確；排序閘 {} 種、閘二 {} 種、閘三 {} 種違規"
          "全數被預期理由攔下".format(len(arrange_should_fail), len(cases_should_fail), n_docx))
    return True


def _selftest_docx(cases, failures, expect_block):
    """組一份最小報告，驗閘三：合法版放行，四種違規各被預期理由擋下。回傳違規種數。"""
    import tempfile
    from docx import Document

    def build(path, h2=None, ranges=True, extra="", decoy=False):
        doc = Document()
        doc.add_heading("一、總覽", 1)
        if decoy:                                    # 範圍表之前另有同欄名的表、以及單欄表
            t = doc.add_table(rows=2, cols=2)
            t.cell(0, 0).text, t.cell(0, 1).text = "附件", "對應項目"
            t.cell(1, 0).text, t.cell(1, 1).text = "合約", "合約第 15 項"
            doc.add_table(rows=2, cols=1).cell(0, 0).text = "對應項目"
        if ranges:
            t = doc.add_table(rows=1, cols=3)
            for i, h in enumerate(("驗證範圍", "對應項目", "涵蓋內容")):
                t.cell(0, i).text = h
            for name, span, scope, _n in stage_rows(cases):
                r = t.add_row().cells
                r[0].text, r[1].text, r[2].text = name, span, scope
        doc.add_paragraph(conclusion(cases) + extra)
        t = doc.add_table(rows=1, cols=3)
        for i, h in enumerate(("編號", "測試情境", "判定")):
            t.cell(0, i).text = h
        for seq, title, res in summary_rows(cases):
            r = t.add_row().cells
            r[0].text, r[1].text, r[2].text = seq, title, res
        doc.add_heading("二、逐項驗證", 1)
        starts = stage_starts(cases)
        for k, c in enumerate(cases):
            if c["id"] in starts:
                doc.add_heading((h2 or {}).get(c["id"], "（{}）{}".format("一二三四五"[len([x for x in starts if x < c["id"]])],
                                                                    starts[c["id"]])), 2)
            doc.add_heading(detail_title(c), 3)
        doc.save(path)

    def run(path):
        verify_docx(path, cases, open_with_word=False, check_readability=False)

    import shutil
    d = Path(tempfile.mkdtemp(prefix="report_gate_selftest_"))
    try:
        return _selftest_docx_run(d, build, run, cases, failures, expect_block)
    finally:
        shutil.rmtree(d, ignore_errors=True)


def _selftest_docx_run(d, build, run, cases, failures, expect_block):
    oks = [
        ("合法文件", dict(extra="細節見{}。".format(ref(cases, "submit")))),
        # 前面有同欄名的表＋單欄表、正文引用別的文件的「第 15 項」：都不該誤擋或當掉
        ("前置同名表、單欄表、引用他文件條號", dict(decoy=True, extra="依合約第 15 項辦理，另見規範第 12 項。")),
    ]
    for i, (label, kw) in enumerate(oks):
        p = d / "ok{}.docx".format(i)
        build(p, **kw)
        try:
            run(p)
        except GateError as e:
            failures.append("閘三：{}被誤擋：{}".format(label, e))
        except Exception as e:  # noqa: BLE001
            failures.append("閘三：{}當掉：{!r}".format(label, e))

    # 外站註冊在第 1 項，把它的階段標題改成「外站註冊與送審」→ 子字串包含會誤放行，精確比對要擋
    bad = [
        ("階段標題是另一個名稱的超集合", dict(h2={1: "（一）外站註冊與送審"}), "應在階段標題"),
        ("單一泛稱階段標題", dict(h2={1: "（一）全部情境", 3: "（二）全部情境 ", 4: "（三）全部情境"}), "應在階段標題"),
        ("缺驗證範圍表", dict(ranges=False), "找不到驗證範圍表"),
        ("引用超出項次", dict(extra="另見第 9 項。"), "不存在的項次"),
    ]
    for i, (label, kw, needle) in enumerate(bad):
        p = d / "bad{}.docx".format(i)
        build(p, **kw)
        expect_block(lambda: run(p), label, needle, "閘三")
    return len(bad)


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        _selftest()
    else:
        print(__doc__)
