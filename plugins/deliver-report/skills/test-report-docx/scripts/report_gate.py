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

典型用法（生成腳本）：

    import sys
    sys.path.insert(0, r"<plugin>/skills/test-report-docx/scripts")
    from report_gate import validate_cases, verify_docx, summary_rows, detail_title

    CASES = [...]
    validate_cases(CASES, base_dir=Path(__file__).parent)   # 閘二

    for seq, title, result in summary_rows(CASES):          # 閘一：總表
        ...
    for c in CASES:                                          # 閘一：逐項
        doc.add_heading(detail_title(c), level=3)

    doc.save(out)
    verify_docx(out, CASES)                                  # 閘三
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

__all__ = [
    "validate_cases",
    "summary_rows",
    "detail_title",
    "evidence_label",
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

_REQUIRED_CASE_KEYS = ("id", "title", "expect", "actual", "result", "evidence")

# 判定欄允許值。「通過」以外一律要在交付揭露講清楚，不可靜默放行。
_ALLOWED_RESULTS = {"通過", "不通過", "未驗證"}


def _norm(s) -> str:
    """比對用正規化：去頭尾空白、全形空白，壓縮連續空白。

    只用於「比對」，不改寫實際寫進文件的字串——文件用原字串。
    """
    return re.sub(r"\s+", "", str(s).replace("　", " ")).strip()


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
        key = _norm(c.get("title", ""))
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

    for c in cases:
        cid = c.get("id", "?")

        missing = [k for k in _REQUIRED_CASE_KEYS if k not in c]
        if missing:
            errs.append("第 {} 項缺欄位：{}".format(cid, "、".join(missing)))
            continue

        for k in ("expect", "actual", "result"):
            if not str(c[k]).strip():
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
    details = []
    pat = re.compile(r"^\s*(\d+)[\s　]+(.+?)\s*$")
    for p in doc.paragraphs:
        if (p.style.name or "").lower().startswith("heading 3"):
            m = pat.match(p.text)
            if m:
                details.append((m.group(1), m.group(2)))

    images = len(doc.inline_shapes)
    return {"summary": summary, "details": details, "images": images}


def verify_docx(docx_path, cases, open_with_word=True):
    """閘三。讀回產出的 docx，與 CASES 對帳；並用 Word 實開確認檔案能開。

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

    if errs:
        raise GateError(
            "\n閘三不通過，產出檔與資料源對不上（檔案已產出但不得交付）：\n"
            + "\n".join("  - " + e for e in errs)
            + "\n"
        )

    return True


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

def _selftest():
    ok_case = [{
        "id": 1, "title": "供應商送件後 SAP 收到最新銀行帳號",
        "expect": "SAP 端帳號＝畫面最新值",
        "actual": "資料庫 0012345 → SAP 傳輸參數 0012345，逐欄一致",
        "result": "通過",
        "evidence": [{"type": "db", "content": "SELECT bank_acct → 0012345",
                      "caption": "資料庫實值"}],
    }]
    cases_should_fail = [
        ("無證據", [dict(ok_case[0], evidence=[])]),
        ("跳號", [dict(ok_case[0], id=2)]),
        ("實測欄空話", [dict(ok_case[0], actual="測試通過")]),
        ("情境名重複", [dict(ok_case[0]), dict(ok_case[0], id=2)]),
        ("判定值非法", [dict(ok_case[0], result="大致 OK")]),
        ("證據缺 content", [dict(ok_case[0],
                               evidence=[{"type": "db", "caption": "x"}])]),
        ("證據缺 caption", [dict(ok_case[0],
                               evidence=[{"type": "db", "content": "x"}])]),
        ("圖檔不存在", [dict(ok_case[0],
                         evidence=[{"type": "image", "path": "no_such_file.png",
                                    "caption": "x"}])]),
    ]

    failures = []
    try:
        validate_cases(ok_case)
    except GateError as e:
        failures.append("合法 CASES 被誤擋：{}".format(e))

    for name, bad in cases_should_fail:
        try:
            validate_cases(bad)
        except GateError:
            pass
        else:
            failures.append("『{}』應被擋卻放行".format(name))

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
    print("SELFTEST OK：合法案例放行，{} 種違規全數攔下".format(len(cases_should_fail)))
    return True


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        _selftest()
    else:
        print(__doc__)
