#!/usr/bin/env python3
"""
md_to_pdf.py — to-checklist 的 Markdown 確認清單轉 PDF。

用法：python md_to_pdf.py <清單.md> [輸出.pdf]
      輸出省略時與 md 同名同目錄、副檔名換成 .pdf。

做法：markdown 套件轉 HTML（含表格）→ 套固定樣式 → 本機 Chrome／Edge 無頭列印成 A4 PDF。
      不依賴 pandoc／wkhtmltopdf／weasyprint（本機實測皆未安裝），只要 Python markdown 套件
      與任一瀏覽器。

轉檔前後的閘，任一不過就不算產出（exit 1）：
  轉檔前  易讀性自檢：呼叫同 plugin 的 check-before/scripts/check_doc.js（與 Stop hook 同一套判準），
          硬缺陷 >0 就不轉；提醒照印，由人逐條判斷。讀不到、或本機沒有 node → 一樣不轉。
  轉檔前  議題編號連續（「### 議題 N」要 1..N 無缺號），章節「一、二、三」連續。
  轉檔後  pypdf 抽得出每個 ## / ### 標題的文字——抽不出代表字型沒嵌好或內容被截掉，
          PDF 在對方電腦上可能是豆腐字或缺段。
  ⚠ pypdf 讀得過 ≠ PDF 閱讀器開得了（交付格式紀律）。本腳本通過後，仍要用
    閱讀器實際開一次看畫面，SKILL.md 的步驟 5 有寫。
"""
import html
import os
import re
import shutil
import subprocess
import sys
import tempfile

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

CN = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十",
      "十一", "十二", "十三", "十四", "十五", "十六", "十七", "十八", "十九", "二十"]

CSS = """
@page {
  size: A4;
  margin: 18mm 16mm 20mm 16mm;
  @bottom-center { content: counter(page) " / " counter(pages); font-size: 9pt; color: #666;
                  font-family: "Microsoft JhengHei", "Noto Sans CJK TC", sans-serif; }
}
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { font-family: "Microsoft JhengHei", "Noto Sans CJK TC", "PingFang TC", sans-serif;
       font-size: 10.5pt; line-height: 1.65; color: #1a1a1a; }
h1 { font-size: 18pt; margin: 0 0 10pt; padding-bottom: 6pt; border-bottom: 2px solid #1f3a5f; color: #1f3a5f; }
h2 { font-size: 14pt; margin: 20pt 0 8pt; padding: 4pt 8pt; background: #e8eef5; color: #1f3a5f;
     break-after: avoid; }
h3 { font-size: 12pt; margin: 14pt 0 6pt; padding-left: 8pt; border-left: 4px solid #2f6db3;
     break-after: avoid; }
h2 + p, h3 + p, h3 + ul { break-before: avoid; }
p { margin: 5pt 0; }
ul, ol { margin: 4pt 0 6pt; padding-left: 20pt; }
li { margin: 2pt 0; }
code { font-family: Consolas, "Microsoft JhengHei", monospace; font-size: 9.5pt;
       background: #f1f3f5; padding: 0 3pt; border-radius: 2pt; }
table { border-collapse: collapse; width: 100%; margin: 6pt 0 10pt; font-size: 9.5pt; break-inside: auto; }
tr { break-inside: avoid; }
th, td { border: 1px solid #b8c2cc; padding: 4pt 6pt; vertical-align: top; text-align: left; }
th { background: #f1f4f8; }
em { color: #444; }
blockquote { margin: 6pt 0; padding: 4pt 10pt; border-left: 3px solid #c9a227; background: #fdf8e8; }
"""


def fail(msg):
    print("✗ " + msg)
    sys.exit(1)


def readability_gate(md_path):
    """跑 check_doc.js 易讀性自檢。硬缺陷、讀不到、沒有 node 都不轉檔——SKILL.md 寫「要先自檢」會被跳過，
    接進轉檔腳本才跑得掉不了。回傳提醒清單（不擋）。"""
    import json
    checker = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                            "..", "..", "check-before", "scripts", "check_doc.js"))
    node = shutil.which("node")
    if not node:
        fail("本機找不到 node，無法跑易讀性自檢（check_doc.js），不轉檔")
    if not os.path.isfile(checker):
        fail("找不到易讀性自檢腳本：%s，不轉檔" % checker)
    r = subprocess.run([node, checker, md_path, "--json"], capture_output=True, timeout=120)
    out = r.stdout.decode("utf-8", "replace").strip()
    if r.returncode == 2 or not out.startswith("{"):
        fail("易讀性自檢讀不到原稿：%s" % (out or r.stderr.decode("utf-8", "replace").strip())[-400:])
    res = json.loads(out)
    if res["bad"]:
        fail("易讀性自檢有 %d 項硬缺陷，改完再轉：\n" % len(res["bad"]) +
             "\n".join("   · " + b for b in res["bad"]))
    return res["notes"]


def strip_fences(src):
    """去掉 ``` / ~~~ 程式碼區塊：區塊裡的 ## 是範例，不是文件標題。"""
    out, in_fence = [], False
    for line in src.splitlines():
        if re.match(r"^\s*(```|~~~)", line):
            in_fence = not in_fence
            continue
        if not in_fence:
            out.append(line)
    return "\n".join(out)


def pre_gate(src):
    heads = [(len(m.group(1)), m.group(2).strip())
             for m in re.finditer(r"^\s{0,3}(#{1,6})\s+(.+)$", strip_fences(src), re.M)]
    if not any(lv == 1 for lv, _ in heads):
        fail("缺少 # 主標題")
    issues = [int(m.group(1)) for lv, t in heads if lv == 3
              for m in [re.match(r"議題\s*(\d+)", t)] if m]
    if not issues:
        fail("找不到任何「### 議題 N：…」標題——確認清單至少要有一個議題")
    if issues != list(range(1, len(issues) + 1)):
        fail("議題編號不連續：依序是 %s，應為 1~%d 連續" % ("、".join(map(str, issues)), len(issues)))
    chapters = [m.group(1) for lv, t in heads if lv == 2
                for m in [re.match(r"([一二三四五六七八九十]+)、", t)] if m]
    nums = [CN.index(c) + 1 if c in CN else -1 for c in chapters]
    if nums and nums != list(range(1, len(nums) + 1)):
        fail("章節編號不連續：依序是 %s" % "、".join(chapters))
    return heads, len(issues)


def find_browser():
    cands = [
        os.path.expandvars(r"%ProgramFiles%\Google\Chrome\Application\chrome.exe"),
        os.path.expandvars(r"%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"),
        os.path.expandvars(r"%LocalAppData%\Google\Chrome\Application\chrome.exe"),
        os.path.expandvars(r"%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"),
        os.path.expandvars(r"%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"),
    ]
    for c in cands:
        if os.path.isfile(c):
            return c
    for n in ("google-chrome", "chromium", "chromium-browser", "chrome", "msedge"):
        p = shutil.which(n)
        if p:
            return p
    return None


# ---------- 部首字元修正 ----------
# 實測（2026-09-29，Chrome 無頭列印）：微軟正黑體、Noto Sans TC 在字型內把「一」U+4E00 與
# 部首「⼀」U+2F00 對到同一個字形，Chrome 反查時取較小的碼位，PDF 的文字對應表（ToUnicode）
# 於是寫成部首字元。畫面看起來一樣，但對方在 PDF 裡搜尋、複製「使用」會得到「使⽤」而找不到。
# 新細明體、標楷體沒有這個問題，但為了版面不改字型，改成轉檔後把對應表裡的部首換回正常字。
RADICAL_SUPPLEMENT = {   # U+2E80–2EFF 沒有 NFKC 對應，只能逐字列；閘會擋下這裡沒列到的
    "⻄": "西", "⻆": "角", "⻊": "足", "⻌": "辶", "⻍": "辶",
    "⻏": "阝", "⻑": "長", "⻖": "阝", "⻘": "青", "⻝": "食",
    "⻤": "鬼", "⺏": "尢", "⺠": "民", "⺟": "母", "⺩": "王",
    "⻣": "骨", "⺮": "竹", "⺼": "肉",
}


def is_radical(ch):
    return 0x2E80 <= ord(ch) <= 0x2FDF


def fix_char(ch):
    import unicodedata
    if 0x2F00 <= ord(ch) <= 0x2FDF:
        return unicodedata.normalize("NFKC", ch)
    return RADICAL_SUPPLEMENT.get(ch, ch)


def fix_tounicode(pdf_path):
    """把每個字型 ToUnicode CMap 裡指向部首字元的對應換成正常字。回傳換掉的筆數。"""
    import pypdf

    def utf16_hex_to_str(h):
        b = bytes.fromhex(h)
        return b.decode("utf-16-be", "replace")

    def str_to_utf16_hex(s):
        return s.encode("utf-16-be").hex().upper()

    writer = pypdf.PdfWriter(clone_from=pdf_path)
    seen, changed = set(), 0
    for page in writer.pages:
        fonts = (page.get("/Resources") or {}).get("/Font") or {}
        for _, ref in fonts.items():
            font = ref.get_object()
            tu_ref = font.get("/ToUnicode")
            if tu_ref is None:
                continue
            key = getattr(tu_ref, "idnum", id(tu_ref))
            if key in seen:
                continue
            seen.add(key)
            tu = tu_ref.get_object()
            data = tu.get_data().decode("latin-1")

            def fix_dst(m):
                nonlocal changed
                s = utf16_hex_to_str(m.group(2))
                if not any(is_radical(c) for c in s):
                    return m.group(0)
                changed += 1
                return m.group(1) + "<" + str_to_utf16_hex("".join(fix_char(c) for c in s)) + ">"

            def fix_block(bm):
                body = bm.group(2)
                if bm.group(1) == "bfchar":
                    # 每行 <src> <dst>：只改 dst
                    body = re.sub(r"(<[0-9A-Fa-f]+>\s*)<([0-9A-Fa-f]+)>", fix_dst, body)
                else:
                    # bfrange：<lo> <hi> <dst> 或 <lo> <hi> [<d1> <d2> …]
                    def fix_range(rm):
                        nonlocal changed
                        lo, hi, rest = rm.group(1), rm.group(2), rm.group(3)
                        if rest.startswith("["):
                            return "<%s> <%s> %s" % (lo, hi, re.sub(r"()<([0-9A-Fa-f]+)>", fix_dst, rest))
                        start = int(rest.strip("<>"), 16)
                        n = int(hi, 16) - int(lo, 16)
                        if not any(is_radical(chr(start + i)) for i in range(n + 1) if start + i < 0x110000):
                            return rm.group(0)
                        # 範圍內有部首 → 攤成陣列逐一修正
                        items = []
                        for i in range(n + 1):
                            ch = chr(start + i)
                            if is_radical(ch):
                                changed += 1
                                ch = fix_char(ch)
                            items.append("<" + str_to_utf16_hex(ch) + ">")
                        return "<%s> <%s> [%s]" % (lo, hi, " ".join(items))
                    body = re.sub(r"<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(\[[^\]]*\]|<[0-9A-Fa-f]+>)", fix_range, body)
                return "begin" + bm.group(1) + body + "end" + bm.group(1)

            new = re.sub(r"begin(bfchar|bfrange)(.*?)end\1", fix_block, data, flags=re.S)
            if new != data:
                tu.set_data(new.encode("latin-1"))
    if changed:
        tmp = pdf_path + ".tmp"
        with open(tmp, "wb") as f:
            writer.write(f)
        os.replace(tmp, pdf_path)
    return changed


def main():
    if len(sys.argv) < 2:
        print("用法：python md_to_pdf.py <清單.md> [輸出.pdf]")
        sys.exit(2)
    md_path = os.path.abspath(sys.argv[1])
    pdf_path = os.path.abspath(sys.argv[2]) if len(sys.argv) > 2 else os.path.splitext(md_path)[0] + ".pdf"
    # 輸出必須是另一個 .pdf：寫錯成原稿路徑會把 Markdown 蓋掉
    if not pdf_path.lower().endswith(".pdf") or os.path.normcase(pdf_path) == os.path.normcase(md_path):
        fail("輸出路徑必須是 .pdf 且不能與原稿相同：%s" % pdf_path)
    if os.path.isdir(pdf_path):
        fail("輸出路徑是一個資料夾，不是檔案：%s" % pdf_path)
    if not os.path.isdir(os.path.dirname(pdf_path)):
        fail("輸出資料夾不存在：%s" % os.path.dirname(pdf_path))
    try:
        import markdown
    except ImportError:
        fail("缺 Python markdown 套件：pip install markdown")

    # utf-8-sig：Windows PowerShell 寫出的 UTF-8 常帶 BOM，留著會讓第一行「# 主標題」比對不到
    with open(md_path, encoding="utf-8-sig") as f:
        src = f.read()
    notes = readability_gate(md_path)
    heads, n_issues = pre_gate(src)

    title = next(t for lv, t in heads if lv == 1)
    md_dir = os.path.dirname(md_path)

    # fenced_code：``` 區塊要渲染成程式碼；不開的話區塊裡的「## …」會變成真標題，
    # 而 pre_gate 已把它當範例略過，等於印出一個沒驗過的標題
    body = markdown.markdown(src, extensions=["tables", "sane_lists", "fenced_code"])

    # 圖片檢查看「渲染後的 <img>」而不是猜 Markdown 寫法：行內、參照式、原始 HTML（含不加引號的 src）
    # 最後都會變成 <img>，一次涵蓋。缺圖時 PDF 照樣產得出來、標題檢查也會過，所以必須在這裡擋。
    from html.parser import HTMLParser
    from urllib.parse import unquote, urlparse
    from urllib.request import url2pathname

    class ImgSrc(HTMLParser):
        def __init__(self):
            super().__init__()
            self.srcs = []

        def handle_starttag(self, tag, attrs):
            if tag == "img":
                self.srcs.append(dict(attrs).get("src") or "")

    ip = ImgSrc()
    ip.feed(body)

    class HeadText(HTMLParser):
        """收集 h2／h3 渲染後的純文字（轉檔後閘用來比對 PDF 抽出的文字）。"""
        def __init__(self):
            super().__init__(convert_charrefs=True)
            self.heads, self.buf = [], None

        def handle_starttag(self, tag, attrs):
            if tag in ("h2", "h3"):
                self.buf = []

        def handle_endtag(self, tag):
            if tag in ("h2", "h3") and self.buf is not None:
                self.heads.append("".join(self.buf).strip())
                self.buf = None

        def handle_data(self, data):
            if self.buf is not None:
                self.buf.append(data)

    hp_ = HeadText()
    hp_.feed(body)
    rendered_heads = [h for h in hp_.heads if h]
    missing_img, remote_img = [], []
    for ref in ip.srcs:
        u = urlparse(ref)
        scheme = u.scheme.lower()
        if scheme == "data":
            continue
        if scheme == "file":
            local = url2pathname(u.path)
        elif len(scheme) == 1:                       # C:\… 被解析成 scheme "c"
            local = ref
        elif scheme:
            remote_img.append(ref)                   # 轉檔時網路一律封鎖，遠端圖必定缺圖
            continue
        else:
            local = os.path.join(md_dir, unquote(ref))
        if not ref or not os.path.isfile(local):
            missing_img.append(ref or "（空白 src）")
    if remote_img:
        fail("原稿引用了網路圖片，轉檔時網路是封鎖的、PDF 會缺圖，請先下載到本機再引用："
             + "、".join(remote_img[:5]))
    if missing_img:
        fail("原稿引用的圖片找不到（以原稿所在資料夾為基準）：" + "、".join(missing_img[:5]))
    # 原始 HTML 裡的 <meta>（例如 refresh 跳轉）CSP 管不到，整個拿掉
    body = re.sub(r"<meta\b[^>]*>", "", body, flags=re.I)
    # CSP：禁止腳本與一切對外連線（圖片只准本機檔與內嵌）；瀏覽器層另以失效代理封網，見下方 cmd
    csp = ("<meta http-equiv='Content-Security-Policy' content=\"default-src 'none'; "
           "style-src 'unsafe-inline'; img-src file: data:; font-src file: data:\">")
    # base：HTML 放在暫存目錄，相對路徑的圖片要以原稿所在資料夾為基準
    # as_uri() 會做 URL 編碼：資料夾名稱含 # 或 %（例如「C#」）時，手拼的路徑會被當成錨點或跳脫字元
    import pathlib
    base = "<base href='%s/'>" % html.escape(pathlib.Path(md_dir).as_uri(), quote=True)
    doc = ("<!doctype html><html lang='zh-Hant'><head><meta charset='utf-8'>%s%s<title>%s</title>"
           "<style>%s</style></head><body>%s</body></html>") % (csp, base, html.escape(title), CSS, body)

    browser = find_browser()
    if not browser:
        fail("找不到 Chrome 或 Edge，無法轉 PDF")
    try:
        import io
        import pypdf
    except ImportError:
        fail("缺 pypdf，無法做轉檔後檢查：pip install pypdf")

    # 先轉到暫存檔、全部檢查過才搬到正式檔名：
    # 失敗時不會弄丟舊 PDF，也不會在正式檔名留下一份沒驗過的 PDF
    with tempfile.TemporaryDirectory() as td:
        hp = os.path.join(td, "checklist.html")
        tmp_pdf = os.path.join(td, "out.pdf")
        with open(hp, "w", encoding="utf-8", newline="") as f:
            f.write(doc)
        cmd = [browser, "--headless=new", "--disable-gpu", "--no-pdf-header-footer",
               "--user-data-dir=" + os.path.join(td, "profile"),
               # 封網：所有連線走一個不存在的代理、網域一律解析失敗（file: 不受影響）
               "--proxy-server=http://127.0.0.1:9", "--proxy-bypass-list=<-loopback>",
               "--host-resolver-rules=MAP * ~NOTFOUND",
               "--print-to-pdf=" + tmp_pdf, pathlib.Path(hp).as_uri()]   # 編碼過的 URI，路徑含 # % 也不會錯
        r = subprocess.run(cmd, capture_output=True, timeout=120)
        if not os.path.isfile(tmp_pdf) or os.path.getsize(tmp_pdf) == 0:
            fail("瀏覽器沒有產出 PDF：%s" % (r.stderr.decode("utf-8", "replace").strip()[-400:]))

        # 轉檔後閘：部首字元修正後不得殘留、每個 ## / ### 標題都要抽得出來
        fixed = fix_tounicode(tmp_pdf)
        with open(tmp_pdf, "rb") as f:
            reader = pypdf.PdfReader(io.BytesIO(f.read()))   # 讀進記憶體，搬檔時不佔用檔案
        raw = "".join((p.extract_text() or "") for p in reader.pages)
        left = sorted(set(c for c in raw if is_radical(c)))
        if left:
            fail("PDF 內仍有部首字元（對方搜尋會找不到）：%s——請把它們補進 RADICAL_SUPPLEMENT"
                 % "、".join("%s U+%04X" % (c, ord(c)) for c in left))
        text = re.sub(r"\s+", "", raw)
        missing = []
        # 比對「渲染後的標題文字」而不是 Markdown 原文：連結、字元實體、粗體、結尾 # 都由渲染器處理掉，
        # 拿原文比會把 PDF 上正常顯示的標題誤判成缺失
        for t in rendered_heads:
            if re.sub(r"\s+", "", t) not in text:
                missing.append(t)
        if missing:
            fail("PDF 抽不到這些標題（字型或內容可能出問題）：" + "；".join(missing[:5]))
        # 全部通過才落到正式檔名。先複製到目的資料夾內的暫存名，再同資料夾原子換名：
        # 暫存目錄與輸出可能不在同一顆磁碟，直接 move 會退化成「邊複製邊覆寫」，中途失敗就把舊 PDF 寫壞
        staging = "%s.tmp-%d" % (pdf_path, os.getpid())
        try:
            shutil.copyfile(tmp_pdf, staging)
            os.replace(staging, pdf_path)
        finally:
            if os.path.exists(staging):
                os.remove(staging)

    print("✓ 產出 %s" % pdf_path)
    print("  易讀性自檢：硬缺陷 0 項" + ("，提醒 %d 項（逐條判斷，不擋）：" % len(notes) if notes else ""))
    for n in notes:
        print("   · " + n)
    if fixed:
        print("  已修正 %d 筆部首字元對應（搜尋、複製會得到正常字）" % fixed)
    print("  %d 頁、%d 個議題、%d 個章節標題全數在 PDF 內可讀" %
          (len(reader.pages), n_issues, sum(1 for lv, _ in heads if lv == 2)))


if __name__ == "__main__":
    main()
