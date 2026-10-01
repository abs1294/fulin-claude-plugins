#!/usr/bin/env python3
"""
visual_check.py — 交付前視覺檢查（疊字、字跑出框、文字超出頁面、字被縮太小…）

用法：python visual_check.py <檔案> [--out <輸出目錄>] [--engine <排版方式>] [--json]
  支援 .pptx / .docx / .pdf。check_doc.js 會自動呼叫；也可單獨跑。

做法分兩段：
  1. 排版：用「對方實際會用的軟體」把檔案轉成 PDF，換行、字型替換、自動縮字都以那個軟體為準。
       pptx  Windows：PowerPoint → LibreOffice
             macOS  ：PowerPoint → Keynote → LibreOffice
             Linux  ：LibreOffice
       docx  Windows：Word → LibreOffice；macOS：Word → LibreOffice；Linux：LibreOffice
       pdf   本身就是排版結果，不必轉
     前面的失敗（沒裝、開檔失敗、逾時）就換下一個，失敗原因記在提醒裡。都沒有 → exit 2（視覺未驗證，不算通過）。
  2. 判定（只有一份，不管用誰排版）：讀 PDF 上每個字實際畫出來的位置
       疊字          兩行文字的字形互相壓到，壓到的面積 > 較小那行的 5%            硬缺陷
       字跑出框      pptx 有底色／框線的方塊，裡面的字畫到方塊外面                 硬缺陷
       超出頁面      字畫在頁面外（含 pptx 有字卻沒出現在畫面上＝被裁掉）         硬缺陷
       字太小        實際字級 < 10pt（含「溢出時縮小文字」縮出來的）              提醒
       文字壓在圖上  文字和圖片重疊（不含整頁背景圖）                             提醒
       字型          pptx 指定的字型沒內嵌（換電腦會被替換）；這次排版已被替換    提醒
       空白頁／重複頁  整頁同一顏色；兩頁畫面完全相同                             提醒
     每頁輸出一張 PNG（問題處畫紅框）和一張總覽圖，清單寫進 visual-manifest.json；
     Stop hook（hooks/visual-view-gate.js）會檢查每一張都被打開看過。

exit code：0 沒有硬缺陷、1 有硬缺陷、2 無法排版／讀不到（不算通過）。
依賴：Python 3.8+、PyMuPDF、Pillow（pip install pymupdf pillow）。
"""
import sys
import os
import re
import json
import time
import shutil
import hashlib
import zipfile
import platform
import tempfile
import subprocess
import posixpath
import xml.etree.ElementTree as ET

MIN_PT = 10.0            # 實際字級低於此值 → 提醒
OVERLAP_RATIO = 0.05     # 兩行字形交疊面積 > 較小那行的 5% → 疊字
EDGE_TOL = 1.5           # 超出頁面／框的容忍值（pt），吸收字形外框的誤差
RENDER_TIMEOUT = int(os.environ.get("DR_VISUAL_TIMEOUT", "180"))

IS_WIN = sys.platform == "win32"
IS_MAC = sys.platform == "darwin"


def die(code, msg, as_json=False):
    if as_json:
        print()   # 先換行：啟動設定（sitecustomize）印字不換行時，JSON 才會獨占最後一行
        print(json.dumps({"ok": False, "error": msg}, ensure_ascii=False))
    else:
        print(msg)
    sys.exit(code)


try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass


# =====================================================================
# 一、排版：轉成 PDF
# =====================================================================
class RenderError(Exception):
    pass


def _kill_pids(pidfile):
    """逾時時只清掉這次自己啟動的程序（記在 pidfile），不碰使用者本來就開著的 PowerPoint／Word。"""
    try:
        with open(pidfile, "r", encoding="ascii") as f:
            pids = [p.strip() for p in f.read().split(",") if p.strip().isdigit()]
    except OSError:
        return
    for pid in pids:
        try:
            if IS_WIN:
                subprocess.run(["taskkill", "/PID", pid, "/T", "/F"], capture_output=True, timeout=20)
            else:
                os.kill(int(pid), 9)
        except Exception:
            pass


def _automation_pids(proc, since):
    """Windows：命令列帶 /Automation -Embedding（程式呼叫啟動）、且在 since（epoch 秒）之後建立的 Office 程序。
    只拿來「列出」可能殘留的程序給使用者看，不拿來殺——特徵證明不了是這次檢查開的（可能是別的程式同時開的）。"""
    ps = ("Get-CimInstance Win32_Process -Filter \"Name='{}.EXE'\" | Where-Object {{ $_.CommandLine -match 'Embedding|/automation' }} | "
          "ForEach-Object {{ '{{0}} {{1}}' -f $_.ProcessId, ([DateTimeOffset]$_.CreationDate).ToUnixTimeSeconds() }}").format(proc)
    try:
        r = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", ps],
                           capture_output=True, timeout=30, creationflags=0x08000000)
    except Exception:
        return []
    out = []
    for line in r.stdout.decode("utf-8", "replace").splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[0].isdigit() and parts[1].lstrip("-").isdigit() and int(parts[1]) >= since - 2:
            out.append(parts[0])
    return out


def _run(cmd, env=None, pidfile=None, timeout=RENDER_TIMEOUT, proc=None):
    kw = dict(capture_output=True, timeout=timeout, env={**os.environ, **(env or {})})
    if IS_WIN:
        kw["creationflags"] = 0x08000000  # CREATE_NO_WINDOW
    started = time.time()
    try:
        r = subprocess.run(cmd, **kw)
    except subprocess.TimeoutExpired:
        if pidfile and os.path.isfile(pidfile):
            _kill_pids(pidfile)   # pidfile 裡的編號是用視窗代號查出來的，確定是這次開的
        elif IS_WIN and proc:
            # 卡在拿到視窗代號之前（COM 啟動、開檔對話框）：證明不了哪個程序是這次開的，寧可留著也不誤殺，只列給使用者
            cands = _automation_pids(proc, started)
            if cands:
                raise RenderError("逾時 {} 秒；可能殘留程式啟動的 {}（程序 {}），確認不是別的程式在用後請手動關閉"
                                  .format(timeout, proc, "、".join(cands)))
        raise RenderError("逾時 {} 秒".format(timeout))
    except FileNotFoundError:
        raise RenderError("找不到執行檔 {}".format(cmd[0]))
    if r.returncode != 0:
        msg = (r.stderr or r.stdout or b"").decode("utf-8", "replace").strip().splitlines()
        tagged = [m[len("DR_ERR: "):] for m in msg if m.startswith("DR_ERR: ")]   # PowerShell 端 trap 出來的真正原因
        raise RenderError((tagged[-1] if tagged else msg[-1] if msg else "結束碼 {}".format(r.returncode)).strip()[:160])
    return r


_PS_OFFICE = r"""
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[System.Text.Encoding]::UTF8
trap { [Console]::Error.WriteLine('DR_ERR: ' + $_.Exception.Message); exit 1 }
Add-Type -Namespace DrVisual -Name Win -MemberDefinition '[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr h, out uint pid);'
# 用視窗代號（HWND）查出 COM 物件所在的確切程序——這是唯一能「證明」哪個 Office 是這次開的方法。
# 比對程序清單或命令列都只能推測（同時段別的程式、使用者自己開的都可能被算進來而誤關、誤殺）
function OwnerPid($hwnd) { $o=[uint32]0; [void][DrVisual.Win]::GetWindowThreadProcessId([IntPtr][int64]$hwnd, [ref]$o); return [int]$o }
# 本次開的＝啟動前不存在、而且是程式呼叫啟動的（命令列帶 /Automation）。後者擋掉「快照之後使用者剛好雙擊開了 PowerPoint、COM 接到它」
function IsMine($owner) {
  if ($owner -le 0 -or $pre -contains $owner) { return $false }
  $c = Get-CimInstance Win32_Process -Filter "ProcessId=$owner" -ErrorAction SilentlyContinue
  return [bool]($c -and $c.CommandLine -match '/automation|Embedding')
}
$pre=@(Get-Process $env:DR_PROC -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
# 建立不了 COM 物件＝這台沒裝（或沒註冊）Office：訊息要帶「沒有安裝」，呼叫端才會提示安裝而不是報「排版失敗」
try { $app=New-Object -ComObject $env:DR_PROGID }
catch { [Console]::Error.WriteLine('DR_ERR: 沒有安裝 ' + $env:DR_PROGID.Split('.')[0] + '（' + $_.Exception.Message + '）'); exit 1 }
$mine=$false
$p=$null; $d=$null
try {
  if ($env:DR_PROGID -eq 'PowerPoint.Application') {
    $owner=OwnerPid $app.HWND
    # 啟動前就存在的程序＝使用者本來開著的 PowerPoint（COM 接到同一個）——不記、最後也不 Quit
    $mine=IsMine $owner
    if ($mine) { Set-Content -Path $env:DR_PIDFILE -Value $owner -Encoding ascii }
    # Open(檔名, ReadOnly=True, Untitled=False, WithWindow=False)；SaveAs 32 = PDF
    $p=$app.Presentations.Open($env:DR_SRC, -1, 0, 0)
    $p.SaveAs($env:DR_OUT, 32)
  } else {
    # Word 要有文件視窗才有視窗代號：先開一份空白文件判定歸屬再關掉，之後開檔失敗（例如有密碼）也知道要不要 Quit。
    # 程式啟動的 Word 預設就不顯示，不必（也不該）去改 Visible——接到使用者的 Word 時會把它藏起來
    $probe=$app.Documents.Add()
    $owner=OwnerPid $probe.ActiveWindow.Hwnd
    $probe.Close(0)
    $mine=IsMine $owner
    if ($mine) { Set-Content -Path $env:DR_PIDFILE -Value $owner -Encoding ascii; $app.DisplayAlerts=0 }
    # 假密碼：有密碼的文件直接失敗，不會跳出輸入密碼視窗卡到逾時
    $d=$app.Documents.Open($env:DR_SRC,$false,$true,$false,'__dr_no_password__')
    $d.ExportAsFixedFormat($env:DR_OUT, 17)
  }
} finally {
  # 轉檔失敗也要關掉開過的複本：接到使用者開著的 Office 時不會 Quit，不關的話複本會一直開在使用者的程式裡
  if ($p) { try { $p.Close() } catch {} }
  if ($d) { try { $d.Close(0) } catch {} }
  if ($mine) { $app.Quit() }
}
"""


def render_office_win(src, out_pdf, progid, proc):
    pidfile = out_pdf + ".pid"
    try:
        _run(["powershell", "-NoProfile", "-NonInteractive", "-Command", _PS_OFFICE],
             env={"DR_SRC": src, "DR_OUT": out_pdf, "DR_PROGID": progid, "DR_PROC": proc, "DR_PIDFILE": pidfile},
             pidfile=pidfile, proc=proc)
    finally:
        try:
            os.remove(pidfile)
        except OSError:
            pass


# macOS：以 AppleScript 控制。Office 與 iWork 都在沙盒裡，直接寫到任意資料夾可能跳「授予存取權」視窗而卡住，
# 所以依序試：① 直接寫到目標位置 ② 寫到該程式自己的容器資料夾再搬出來。
_OSA_PPT = '''
on run argv
  set srcPath to item 1 of argv
  set outPath to item 2 of argv
  set wasRunning to application "Microsoft PowerPoint" is running
  tell application "Microsoft PowerPoint"
    open (POSIX file srcPath)
    set p to active presentation
    save p in (POSIX file outPath) as save as PDF
    close p saving no
    if not wasRunning then quit
  end tell
end run
'''
_OSA_WORD = '''
on run argv
  set srcPath to item 1 of argv
  set outPath to item 2 of argv
  set wasRunning to application "Microsoft Word" is running
  tell application "Microsoft Word"
    open (POSIX file srcPath) with read only
    set d to active document
    save as d file name outPath file format format PDF
    close d saving no
    if not wasRunning then quit
  end tell
end run
'''
_OSA_KEYNOTE = '''
on run argv
  set srcPath to item 1 of argv
  set outPath to item 2 of argv
  set wasRunning to application "Keynote" is running
  tell application "Keynote"
    set d to open (POSIX file srcPath)
    export d to (POSIX file outPath) as PDF
    close d saving no
    if not wasRunning then quit
  end tell
end run
'''
_MAC_APPS = {
    "powerpoint": ("Microsoft PowerPoint", _OSA_PPT, "com.microsoft.Powerpoint"),
    "word": ("Microsoft Word", _OSA_WORD, "com.microsoft.Word"),
    "keynote": ("Keynote", _OSA_KEYNOTE, "com.apple.iWork.Keynote"),
}


def _mac_app_installed(name):
    return any(os.path.isdir(os.path.join(d, name + ".app"))
               for d in ("/Applications", os.path.expanduser("~/Applications"), "/System/Applications"))


def render_mac(src, out_pdf, key):
    app, script, bundle = _MAC_APPS[key]
    if not _mac_app_installed(app):
        raise RenderError("沒有安裝 {}".format(app))
    was_running = subprocess.run(["pgrep", "-x", app], capture_output=True).returncode == 0
    with tempfile.NamedTemporaryFile("w", suffix=".applescript", delete=False, encoding="utf-8") as f:
        f.write(script)
        scpt = f.name
    container_tmp = os.path.expanduser("~/Library/Containers/{}/Data/tmp".format(bundle))
    targets = [out_pdf]
    if os.path.isdir(os.path.dirname(container_tmp)):
        targets.append(os.path.join(container_tmp, "dr-visual-{}.pdf".format(os.getpid())))
    errs = []
    try:
        for t in targets:
            try:
                os.makedirs(os.path.dirname(t), exist_ok=True)
                _run(["osascript", scpt, os.path.abspath(src), t])
            except RenderError as e:
                errs.append(str(e))
                if "逾時" in str(e) and not was_running:
                    subprocess.run(["pkill", "-x", app], capture_output=True)
                    # 第一次執行多半是卡在「允許控制」授權視窗，換位置重試也一樣會卡
                    raise RenderError("逾時（第一次執行請到 系統設定 → 隱私權與安全性 → 自動化，允許終端機控制 {}）".format(app))
                continue
            if os.path.isfile(t) and os.path.getsize(t) > 0:
                if t != out_pdf:
                    shutil.move(t, out_pdf)
                return
            errs.append("沒有產出 PDF（{}）".format(t))
    finally:
        os.remove(scpt)
    raise RenderError("；".join(errs)[:200])


def find_soffice():
    cands = [shutil.which("soffice"), shutil.which("libreoffice")]
    if IS_WIN:
        for pf in (os.environ.get("ProgramFiles"), os.environ.get("ProgramFiles(x86)")):
            if pf:
                cands.append(os.path.join(pf, "LibreOffice", "program", "soffice.exe"))
    if IS_MAC:
        cands.append("/Applications/LibreOffice.app/Contents/MacOS/soffice")
    for c in cands:
        if c and os.path.isfile(c):
            return c
    return None


def render_libreoffice(src, out_pdf):
    exe = find_soffice()
    if not exe:
        raise RenderError("沒有安裝 LibreOffice")
    work = tempfile.mkdtemp(prefix="dr-lo-")
    try:
        # 獨立設定檔：使用者開著 LibreOffice 時，共用設定檔會讓轉檔直接結束而不產檔
        profile = "file:///" + os.path.join(work, "profile").replace("\\", "/").lstrip("/")
        cmd = [exe, "-env:UserInstallation=" + profile, "--headless", "--norestore",
               "--convert-to", "pdf", "--outdir", work, os.path.abspath(src)]
        p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             **({"creationflags": 0x08000000} if IS_WIN else {"start_new_session": True}))
        try:
            p.communicate(timeout=RENDER_TIMEOUT)
        except subprocess.TimeoutExpired:
            if IS_WIN:
                subprocess.run(["taskkill", "/PID", str(p.pid), "/T", "/F"], capture_output=True)
            else:
                os.killpg(p.pid, 9)
            raise RenderError("逾時 {} 秒".format(RENDER_TIMEOUT))
        produced = os.path.join(work, os.path.splitext(os.path.basename(src))[0] + ".pdf")
        if not os.path.isfile(produced):
            raise RenderError("沒有產出 PDF")
        shutil.move(produced, out_pdf)
    finally:
        shutil.rmtree(work, ignore_errors=True)


# 排版方式：(代號, 顯示名稱, 是否為目標軟體, 函式)
def engines_for(ext):
    ppt_win = ("powerpoint", "PowerPoint（Windows）", True,
               lambda s, o: render_office_win(s, o, "PowerPoint.Application", "POWERPNT"))
    word_win = ("word", "Word（Windows）", True,
                lambda s, o: render_office_win(s, o, "Word.Application", "WINWORD"))
    ppt_mac = ("powerpoint", "PowerPoint（macOS）", True, lambda s, o: render_mac(s, o, "powerpoint"))
    word_mac = ("word", "Word（macOS）", True, lambda s, o: render_mac(s, o, "word"))
    keynote = ("keynote", "Keynote", False, lambda s, o: render_mac(s, o, "keynote"))
    lo = ("libreoffice", "LibreOffice", False, render_libreoffice)
    if ext == ".pptx":
        return [ppt_win, lo] if IS_WIN else [ppt_mac, keynote, lo] if IS_MAC else [lo]
    if ext == ".docx":
        return [word_win, lo] if IS_WIN else [word_mac, lo] if IS_MAC else [lo]
    return []


# =====================================================================
# 二、pptx 結構（純 zip＋XML，不需 python-pptx）：每頁的文字方塊位置、是否有底色、字型
# =====================================================================
NS = {
    "p": "http://schemas.openxmlformats.org/presentationml/2006/main",
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
}
RID = "{%s}id" % NS["r"]
EMU_PER_PT = 12700.0


def _rels(z, part):
    d, b = posixpath.split(part)
    rp = posixpath.join(d, "_rels", b + ".rels")
    out = {}
    if rp not in z.namelist():
        return out
    for rel in ET.fromstring(z.read(rp)):
        tgt = rel.get("Target", "")
        full = posixpath.normpath(posixpath.join(d, tgt)) if not tgt.startswith("/") else tgt.lstrip("/")
        out[rel.get("Id")] = (rel.get("Type", "").rsplit("/", 1)[-1], full)
    return out


def _xfrm(el):
    """回傳 (x, y, w, h, rot) EMU；沒有 xfrm → None"""
    x = el.find("a:xfrm", NS)
    if x is None:
        return None
    off, ext = x.find("a:off", NS), x.find("a:ext", NS)
    if off is None or ext is None:
        return None
    return (int(off.get("x", 0)), int(off.get("y", 0)), int(ext.get("cx", 0)), int(ext.get("cy", 0)),
            int(x.get("rot", "0") or 0))


def _ph_key(sp):
    ph = sp.find("p:nvSpPr/p:nvPr/p:ph", NS)
    if ph is None:
        return None
    return (ph.get("type", "body" if ph.get("idx") else "obj"), ph.get("idx"))


def _ph_map(root):
    """layout／master 裡的佔位符位置：以 idx 與 type 兩種鍵查"""
    by_idx, by_type = {}, {}
    for sp in root.iter("{%s}sp" % NS["p"]):
        k = _ph_key(sp)
        spPr = sp.find("p:spPr", NS)
        g = _xfrm(spPr) if spPr is not None else None
        if not k or not g:
            continue
        if k[1] is not None:
            by_idx.setdefault(k[1], g)
        by_type.setdefault(k[0], g)
    return by_idx, by_type


def _has_visible_box(sp):
    spPr = sp.find("p:spPr", NS)
    if spPr is not None:
        for tag in ("a:solidFill", "a:gradFill", "a:pattFill", "a:blipFill"):
            if spPr.find(tag, NS) is not None:
                return True
        ln = spPr.find("a:ln", NS)
        if ln is not None and ln.find("a:noFill", NS) is None and len(list(ln)) > 0:
            return True
        if spPr.find("a:noFill", NS) is not None:
            return False
    # 沒寫明填色：預設樣式（插入的矩形、圓角方塊）有 fillRef idx>0 就是有底色；文字方塊沒有 style
    fr = sp.find("p:style/a:fillRef", NS)
    return fr is not None and fr.get("idx", "0") != "0"


def _norm(s):
    # 只留文字與數字比對：箭頭、三角形這類符號在 PowerPoint 匯出的 PDF 文字層常常抽不到
    # （畫面上有、文字層沒有；實測「產品 ↔ 原料」「◀ 查原料 ▶」），留著會把看得到的段落誤報成被裁掉
    return re.sub(r"[\W_]+", "", s or "")


def pptx_structure(path):
    """回傳 {size:(cx,cy), slides:[{shapes:[{rect_pt, text, visible_box, rotated}], fonts:set}], embedded:bool, theme_fonts:set}"""
    z = zipfile.ZipFile(path)
    pres = ET.fromstring(z.read("ppt/presentation.xml"))
    sz = pres.find("p:sldSz", NS)
    size = (int(sz.get("cx")), int(sz.get("cy"))) if sz is not None else (12192000, 6858000)
    embedded = pres.find("p:embeddedFontLst", NS) is not None and len(pres.find("p:embeddedFontLst", NS)) > 0
    prels = _rels(z, "ppt/presentation.xml")
    theme_fonts = set()
    for n in z.namelist():
        if re.match(r"ppt/theme/theme\d+\.xml$", n):
            t = ET.fromstring(z.read(n))
            for tag in ("a:latin", "a:ea"):
                for f in t.iterfind(".//a:fontScheme//" + tag, NS):
                    if f.get("typeface"):
                        theme_fonts.add(f.get("typeface"))
    slides = []
    lst = pres.find("p:sldIdLst", NS)
    for sid in (list(lst) if lst is not None else []):
        rel = prels.get(sid.get(RID))
        if not rel:
            continue
        part = rel[1]
        root = ET.fromstring(z.read(part))
        srels = _rels(z, part)
        lay_idx, lay_type, mas_idx, mas_type = {}, {}, {}, {}
        lay = next((t for k, t in srels.values() if k == "slideLayout"), None)
        if lay and lay in z.namelist():
            lroot = ET.fromstring(z.read(lay))
            lay_idx, lay_type = _ph_map(lroot)
            mas = next((t for k, t in _rels(z, lay).values() if k == "slideMaster"), None)
            if mas and mas in z.namelist():
                mas_idx, mas_type = _ph_map(ET.fromstring(z.read(mas)))
        shapes, fonts, pics = [], set(), []
        for f in root.iter():
            if f.tag in ("{%s}latin" % NS["a"], "{%s}ea" % NS["a"]) and f.get("typeface") and not f.get("typeface").startswith("+"):
                fonts.add(f.get("typeface"))

        def walk(parent, tf):
            for el in parent:
                tag = el.tag.split("}")[1]
                if tag == "grpSp":
                    gp = el.find("p:grpSpPr/a:xfrm", NS)
                    ntf = tf
                    if gp is not None:
                        off, ext = gp.find("a:off", NS), gp.find("a:ext", NS)
                        choff, chext = gp.find("a:chOff", NS), gp.find("a:chExt", NS)
                        if None not in (off, ext, choff, chext):
                            sx = int(ext.get("cx")) / max(1, int(chext.get("cx")))
                            sy = int(ext.get("cy")) / max(1, int(chext.get("cy")))
                            ox, oy = int(off.get("x")) - int(choff.get("x")) * sx, int(off.get("y")) - int(choff.get("y")) * sy
                            # 先套子群組、再套外層
                            ntf = (lambda f0, a, b, c, d: (lambda x, y, w, h: f0(a + x * c, b + y * d, w * c, h * d)))(tf, ox, oy, sx, sy)
                    walk(el, ntf)
                elif tag == "sp":
                    if el.find("p:nvSpPr/p:cNvPr", NS) is not None and el.find("p:nvSpPr/p:cNvPr", NS).get("hidden") == "1":
                        continue
                    body = el.find("p:txBody", NS)
                    if body is None:
                        continue
                    text = "\n".join("".join(t.text or "" for t in p.iter("{%s}t" % NS["a"]))
                                     for p in body.iterfind("a:p", NS))
                    if not _norm(text):
                        continue
                    spPr = el.find("p:spPr", NS)
                    g = _xfrm(spPr) if spPr is not None else None
                    if g is None:
                        k = _ph_key(el)
                        if k:
                            g = (lay_idx.get(k[1]) or lay_type.get(k[0]) or mas_idx.get(k[1]) or mas_type.get(k[0]))
                    bp = body.find("a:bodyPr", NS)
                    vert = bp is not None and bp.get("vert", "horz") not in ("horz",)
                    # 「溢出時縮小文字」記在檔案裡的縮小比例：PowerPoint 開檔照這個比例顯示，
                    # LibreOffice 會自己重算（實測同一份 35% 的簡報，PowerPoint 6.96pt、LibreOffice 11pt）
                    shrunk = None
                    na = bp.find("a:normAutofit", NS) if bp is not None else None
                    if na is not None and na.get("fontScale"):
                        ratio_ = int(na.get("fontScale")) / 100000.0
                        szs = [int(r.get("sz")) / 100.0 for r in body.iter("{%s}rPr" % NS["a"]) if r.get("sz")]
                        if szs:
                            shrunk = round(min(szs) * ratio_, 1)
                    shapes.append({
                        "rect": tf(*g[:4]) if g else None,
                        "rotated": bool(g and g[4]) or vert,
                        "text": text,
                        "visible_box": _has_visible_box(el),
                        "paras": [p for p in text.split("\n") if _norm(p)],
                        "shrunk_pt": shrunk,
                    })
                elif tag == "pic":
                    spPr = el.find("p:spPr", NS)
                    g = _xfrm(spPr) if spPr is not None else None
                    if g:
                        pics.append(tf(*g[:4]))
                elif tag == "graphicFrame":
                    # 表格：只收文字（用來確認有沒有被裁掉），不判斷框
                    text = "\n".join("".join(t.text or "" for t in p.iter("{%s}t" % NS["a"]))
                                     for p in el.iter("{%s}p" % NS["a"]))
                    if _norm(text):
                        shapes.append({"rect": None, "rotated": False, "text": text, "visible_box": False,
                                       "paras": [p for p in text.split("\n") if _norm(p)]})

        tree = root.find("p:cSld/p:spTree", NS)
        if tree is not None:
            walk(tree, lambda x, y, w, h: (x, y, w, h))
        for s in shapes:
            if s["rect"]:
                s["rect"] = tuple(v / EMU_PER_PT for v in s["rect"])
        pics = [tuple(v / EMU_PER_PT for v in r) for r in pics]
        # 隱藏投影片（<p:sld show="0">）：PowerPoint 匯出 PDF 時不輸出（實測）；其他排版方式未實測，
        # 所以不假設行為，交給 slide_map() 用張數判斷
        slides.append({"shapes": shapes, "fonts": fonts, "pics": pics, "hidden": root.get("show") in ("0", "false")})
    return {"size": size, "slides": slides, "embedded": embedded, "theme_fonts": theme_fonts}


def slide_map(struct, page_count):
    """PDF 第 i 頁對應哪一張投影片。排版結果不輸出隱藏投影片，所以先比「未隱藏的張數」；
    對不上就回 None——對錯頁會把別頁的文字、方塊拿來比，產生假的「文字被裁掉」硬缺陷。"""
    shown = [s for s in struct["slides"] if not s["hidden"]]
    if len(shown) == page_count:
        return shown
    if len(struct["slides"]) == page_count:
        return struct["slides"]
    return None


# Windows 與 macOS（裝了 Office）都有的字型：沒內嵌也不會被替換
SAFE_FONTS = {f.lower() for f in (
    "Arial", "Arial Black", "Calibri", "Calibri Light", "Cambria", "Cambria Math", "Candara", "Consolas",
    "Constantia", "Corbel", "Courier New", "Georgia", "Impact", "Tahoma", "Times New Roman", "Trebuchet MS",
    "Verdana", "Comic Sans MS", "Aptos", "Aptos Display", "Aptos Narrow", "Symbol", "Wingdings")}


# =====================================================================
# 三、判定
# =====================================================================
def _area(r):
    return max(0.0, r[2] - r[0]) * max(0.0, r[3] - r[1])


def _inter(a, b):
    return (max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3]))


def page_lines(page, fitz):
    """PDF 一頁的文字行：[{text, bbox, chars:[bbox], size}]。含頁面外的字（不套頁面裁切）。"""
    flags = fitz.TEXTFLAGS_RAWDICT & ~fitz.TEXT_MEDIABOX_CLIP
    d = page.get_text("rawdict", flags=flags)
    lines = []
    for b in d.get("blocks", []):
        if b.get("type") != 0:
            continue
        for ln in b.get("lines", []):
            chars, text, sizes = [], [], []
            for sp in ln.get("spans", []):
                if sp.get("alpha", 255) == 0:   # 完全透明的字（OCR 隱藏文字層）不算
                    continue
                for ch in sp.get("chars", []):
                    c = ch.get("c", "")
                    text.append(c)
                    if c.strip():
                        chars.append(tuple(ch["bbox"]))
                        sizes.append(sp.get("size", 0))
            if not chars:
                continue
            bbox = (min(c[0] for c in chars), min(c[1] for c in chars),
                    max(c[2] for c in chars), max(c[3] for c in chars))
            lines.append({"text": "".join(text).strip(), "bbox": bbox, "chars": chars,
                          "size": min(sizes) if sizes else 0})
    return lines


def find_collisions(lines):
    """兩行字形互相壓到：逐字計算交疊面積（字與字只擦到邊的不算，吸收字距與斜體的誤差）"""
    hits = []
    for i in range(len(lines)):
        a = lines[i]
        for j in range(i + 1, len(lines)):
            b = lines[j]
            if _area(_inter(a["bbox"], b["bbox"])) <= 0:
                continue
            inter = 0.0
            for ca in a["chars"]:
                if _area(_inter(ca, b["bbox"])) <= 0:
                    continue
                for cb in b["chars"]:
                    x = _area(_inter(ca, cb))
                    if x > 0.10 * min(_area(ca), _area(cb)):
                        inter += x
            if inter <= 0:
                continue
            aa = sum(_area(c) for c in a["chars"]) or 1
            ab = sum(_area(c) for c in b["chars"]) or 1
            ratio = inter / min(aa, ab)
            if ratio > OVERLAP_RATIO:
                dx = abs(a["bbox"][0] - b["bbox"][0]) + abs(a["bbox"][1] - b["bbox"][1])
                ghost = _norm(a["text"]) == _norm(b["text"]) and dx < 4
                hits.append((a, b, ratio, ghost))
    return hits


# 引用片段的標記（私用區字元）：帶 --raw-quotes 時不在這裡截短，改交出完整片段與原本的長度，
# 由呼叫端（check_doc.js）先遮蔽憑證／個資再截——先截再遮蔽，被截斷的號碼比對不到遮蔽規則
QUOTE_OPEN, QUOTE_SEP, QUOTE_CLOSE = "\ue000", "\ue001", "\ue002"


def _clip(s, n=14):
    s = re.sub(r"\s+", " ", s).strip()
    # 用命令列旗標、不用環境變數：環境變數會被繼承，直接執行時可能誤開、把標記字元印到畫面上
    if "--raw-quotes" in sys.argv[1:]:
        for ch in (QUOTE_OPEN, QUOTE_SEP, QUOTE_CLOSE):
            s = s.replace(ch, "")
        return "{}{}{}{}{}".format(QUOTE_OPEN, n, QUOTE_SEP, s, QUOTE_CLOSE)
    return s if len(s) <= n else s[:n] + "…"


def analyze(pdf_path, src_ext, struct, out_dir, fitz, Image, ImageDraw, target=True):
    fitz.TOOLS.set_small_glyph_heights(True)   # 字形外框用字級高度，不含行距留白——否則相鄰兩行會互相「重疊」
    doc = fitz.open(pdf_path)
    unit = "張投影片" if src_ext == ".pptx" else "頁"
    bad, notes, images, hashes = [], [], [], {}
    small_pages, over_img_pages, blank_pages = [], [], []

    smap = slide_map(struct, doc.page_count) if struct is not None else None
    if struct is not None and smap is None:
        notes.append("簡報有 {} 張投影片（{} 張隱藏）、排版結果 {} 頁，對不上哪一頁是哪一張，"
                     "「字跑出方塊外」「文字被裁掉」「字被縮小」三項未檢查".format(
                         len(struct["slides"]), sum(s["hidden"] for s in struct["slides"]), doc.page_count))
    elif struct is not None and len(smap) != len(struct["slides"]):
        notes.append("有 {} 張隱藏投影片沒有輸出，頁碼以排版結果為準（第幾張＝放映時看到的第幾張）"
                     .format(len(struct["slides"]) - len(smap)))

    for pno in range(doc.page_count):
        page = doc[pno]
        label = "第 {} {}".format(pno + 1, unit)
        # 用「未旋轉」的頁面範圍比對：抽出來的字座標是未旋轉的；page.rect 是旋轉後的（實測 90 度頁寬高對調）
        pr = fitz.Rect(page.rect) * page.derotation_matrix
        pr.normalize()
        sl = smap[pno] if smap is not None else None
        lines = page_lines(page, fitz)
        marks = []   # (bbox, color)

        # 疊字（同一頁最多列 3 處，其餘彙總成一行；紅框全部畫）
        cols = find_collisions(lines)
        for k, (a, b, ratio, ghost) in enumerate(cols):
            box = (min(a["bbox"][0], b["bbox"][0]), min(a["bbox"][1], b["bbox"][1]),
                   max(a["bbox"][2], b["bbox"][2]), max(a["bbox"][3], b["bbox"][3]))
            marks.append((box, "red"))
            if k == 3:
                bad.append("{} 另有 {} 處疊字（見圖上紅框）".format(label, len(cols) - 3))
            if k >= 3:
                continue
            if ghost:
                bad.append("{} 同一段文字疊了兩層、位置略有偏移（重複貼上的文字方塊或陰影效果，畫面會糊）：「{}」"
                           .format(label, _clip(a["text"])))
            else:
                bad.append("{} 疊字：「{}」與「{}」互相壓到（重疊 {:.0%}）"
                           .format(label, _clip(a["text"]), _clip(b["text"]), min(ratio, 1)))

        # 超出頁面
        for ln in lines:
            bx = ln["bbox"]
            if bx[0] < pr.x0 - EDGE_TOL or bx[1] < pr.y0 - EDGE_TOL or bx[2] > pr.x1 + EDGE_TOL or bx[3] > pr.y1 + EDGE_TOL:
                bad.append("{} 文字超出頁面邊界：「{}」".format(label, _clip(ln["text"])))
                clip = (max(bx[0], pr.x0), max(bx[1], pr.y0), min(bx[2], pr.x1), min(bx[3], pr.y1))
                if clip[2] > clip[0] and clip[3] > clip[1]:   # 整行都在頁外時沒有可框的範圍（反向座標會讓畫框出錯）
                    marks.append((clip, "red"))

        # 字太小
        for ln in lines:
            if 0 < ln["size"] < MIN_PT - 0.05:
                small_pages.append((pno + 1, round(ln["size"], 1), ln["text"]))
        # 不是用 PowerPoint 排版時，改從檔案記錄的縮小比例推算 PowerPoint 會顯示的字級
        if not target and sl is not None:
            for sh in sl["shapes"]:
                if sh.get("shrunk_pt") and sh["shrunk_pt"] < MIN_PT - 0.05:
                    small_pages.append((pno + 1, sh["shrunk_pt"], sh["text"] + "（PowerPoint 縮小後）"))

        # 文字壓在圖上（整頁背景圖不算）。
        # pptx 用簡報裡真正的圖片物件：PowerPoint 匯出時會把方塊的陰影、漸層畫成點陣圖，
        # 只看 PDF 會把「字放在有陰影的方塊上」誤報成壓在圖上（實測誤報）
        if sl is not None:
            sc = pr.width / (struct["size"][0] / EMU_PER_PT)
            imgs = [(x * sc, y * sc, (x + w) * sc, (y + h) * sc) for x, y, w, h in sl["pics"]]
        else:
            try:
                imgs = [tuple(i["bbox"]) for i in page.get_image_info()]
            except Exception:
                imgs = []
        imgs = [im for im in imgs if _area(im) < 0.6 * pr.width * pr.height]
        cover = [ln for ln in lines for im in imgs if _area(_inter(ln["bbox"], im)) > 0.5 * _area(ln["bbox"])]
        if cover:
            over_img_pages.append("{}（「{}」）".format(pno + 1, _clip(cover[0]["text"], 10)))

        # pptx：字跑出有底色／框線的方塊；有字卻沒畫出來（被裁掉）
        if sl is not None:
            scale = pr.width / (struct["size"][0] / EMU_PER_PT)
            page_text = _norm("".join(l["text"] for l in lines))
            missing = [p for s in sl["shapes"] for p in s["paras"]
                       if len(_norm(p)) >= 2 and _norm(p) not in page_text]
            if missing:
                bad.append("{} 有 {} 段文字沒出現在畫面上（超出投影片或被裁掉）：「{}」"
                           .format(label, len(missing), _clip(missing[0])))
            boxes = [s for s in sl["shapes"] if s["rect"] and not s["rotated"]]
            for s in boxes:
                if not s["visible_box"]:
                    continue   # 看不見的方塊，字超出去畫面上看不出來；撞到別的字時由疊字抓
                x, y, w, h = (v * scale for v in s["rect"])
                st = _norm(s["text"])
                spill = []
                for ln in lines:
                    nt = _norm(ln["text"])
                    if len(nt) < 2 or nt not in st:
                        continue
                    cx = (ln["bbox"][0] + ln["bbox"][2]) / 2
                    # 用「水平方向有重疊」認定是這個方塊的字，不用中心點：往右溢出很多的一行，
                    # 中心點會落在方塊外而被跳過（實測 p12：行 79～500pt、方塊 72～288pt）
                    if ln["bbox"][2] < x - EDGE_TOL or ln["bbox"][0] > x + w + EDGE_TOL:
                        continue
                    # 這一行若也屬於另一個完整裝得下它的方塊，就是那個方塊的字，不是溢出
                    owners = [o for o in boxes if o is not s and nt in _norm(o["text"])]
                    # 「裝得下」要上下左右都包住；只看中心點時，兩個方塊有重複文字會讓真正的左右溢出被跳過
                    if any(o["rect"][1] * scale - EDGE_TOL <= ln["bbox"][1] and ln["bbox"][3] <= (o["rect"][1] + o["rect"][3]) * scale + EDGE_TOL
                           and o["rect"][0] * scale - EDGE_TOL <= ln["bbox"][0] and ln["bbox"][2] <= (o["rect"][0] + o["rect"][2]) * scale + EDGE_TOL
                           for o in owners):
                        continue
                    # 上下左右都要看：不自動換行（wrap=none）的字會從方塊左右兩側跑出去
                    if (ln["bbox"][3] > y + h + EDGE_TOL or ln["bbox"][1] < y - EDGE_TOL
                            or ln["bbox"][2] > x + w + EDGE_TOL or ln["bbox"][0] < x - EDGE_TOL):
                        spill.append(ln)
                        marks.append((ln["bbox"], "red"))
                if spill:
                    bad.append("{} 字跑出方塊外：「{}」所在的方塊，有 {} 行畫在方塊底色／框線外"
                               .format(label, _clip(s["text"]), len(spill)))

        # 輸出圖片
        zoom = min(2.0, 1500.0 / max(pr.width, 1))
        pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=False)
        raw = pix.tobytes("png")
        h = hashlib.md5(raw).hexdigest()
        hashes.setdefault(h, []).append(pno + 1)
        img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
        ext_ = img.getextrema()
        if all(hi - lo <= 3 for lo, hi in ext_):
            blank_pages.append(str(pno + 1))
        if marks:
            dr = ImageDraw.Draw(img)
            for (bx, color) in marks:
                # 標記座標是未旋轉的；圖片是旋轉後畫出來的，要先轉回畫面座標
                rr = fitz.Rect(bx) * page.rotation_matrix
                rr.normalize()
                r = [(rr.x0 - page.rect.x0) * zoom - 3, (rr.y0 - page.rect.y0) * zoom - 3,
                     (rr.x1 - page.rect.x0) * zoom + 3, (rr.y1 - page.rect.y0) * zoom + 3]
                if r[2] > r[0] and r[3] > r[1]:
                    dr.rectangle(r, outline=(230, 0, 0), width=3)
        fn = os.path.join(out_dir, "page-{:03d}.png".format(pno + 1))
        img.save(fn)
        images.append(os.path.abspath(fn))

    if small_pages:
        # 同一段小字出現在 3 頁以上（頁首、頁尾、資料來源）合併成一條，其餘逐頁列最小的那段
        by_text = {}
        for pg, sz, tx in small_pages:
            # 數字視為相同：頁碼「2 / 28」「3 / 28」是同一個頁尾
            by_text.setdefault(re.sub(r"\d+", "#", _norm(tx)) or tx, []).append((pg, sz, tx))
        parts, per_page = [], {}
        for items in by_text.values():
            pages = sorted({i[0] for i in items})
            if len(pages) >= 3:
                parts.append("「{}」{}pt 出現在 {} {}（多半是頁首頁尾）".format(
                    _clip(items[0][2], 12), min(i[1] for i in items), len(pages), unit))
            else:
                for pg, sz, tx in items:
                    if pg not in per_page or sz < per_page[pg][0]:
                        per_page[pg] = (sz, tx)
        pp = ["第 {} {}（{}pt：「{}」）".format(pg, unit, sz, _clip(tx, 10)) for pg, (sz, tx) in sorted(per_page.items())]
        parts += pp[:8] + (["另 {} {}".format(len(pp) - 8, unit)] if len(pp) > 8 else [])
        notes.append("字級小於 {:.0f}pt（含自動縮小文字縮出來的）：{}".format(MIN_PT, "；".join(parts)))
    if over_img_pages:
        notes.append("文字壓在圖片上（若是刻意的圖說可忽略）：第 {} {}".format("、".join(over_img_pages[:8]), unit))
    if blank_pages:
        notes.append("空白頁（整頁同一顏色）：第 {} {}".format("、".join(blank_pages), unit))
    for pages in hashes.values():
        if len(pages) > 1:
            notes.append("畫面完全相同的頁：第 {} {}".format("、".join(map(str, pages)), unit))

    # 字型沒內嵌：對方電腦沒有該字型就會被替換，換行與疊字跟這次檢查不同。
    # Windows 與 macOS（含 Office）都一定有的字型不列，免得每份簡報都報 Calibri。
    # 不做「這次排版是否已替換字型」的判斷：PDF 只記實際用到的字型，中文字會落到東亞字型，
    # 反推不出哪個字原本要用哪個字型（實測把本機有裝的 Calibri 誤報成被替換，已拿掉）。
    if struct is not None and not struct["embedded"]:
        wanted = set(struct["theme_fonts"])
        for s in struct["slides"]:
            wanted |= s["fonts"]
        risky = sorted(f for f in wanted if f and not f.startswith("+") and f.lower() not in SAFE_FONTS)
        if risky:
            notes.append("簡報指定的字型沒有內嵌：{}（對方電腦沒有這些字型時會被換成別的字型，換行與疊字可能和這次檢查不同；"
                         "PowerPoint 可在 選項 → 儲存 → 在檔案內嵌字型）".format("、".join(risky)))

    # 總覽圖：一眼看完全部頁面
    overview = None
    if images:
        thumbs = []
        for fn in images:
            im = Image.open(fn)
            im.thumbnail((360, 360))
            thumbs.append(im)
        cols = 4
        cw = max(t.width for t in thumbs) + 16
        ch = max(t.height for t in thumbs) + 30
        rows = (len(thumbs) + cols - 1) // cols
        sheet = Image.new("RGB", (cols * cw, rows * ch), (235, 235, 235))
        dr = ImageDraw.Draw(sheet)
        for k, t in enumerate(thumbs):
            cx0, cy0 = (k % cols) * cw + 8, (k // cols) * ch + 22
            sheet.paste(t, (cx0, cy0))
            dr.text((cx0, cy0 - 16), str(k + 1), fill=(0, 0, 0))
        overview = os.path.abspath(os.path.join(out_dir, "overview.png"))
        sheet.save(overview)
    doc.close()
    return {"pages": len(images), "images": images, "overview": overview, "bad": bad, "notes": notes}


# =====================================================================
# 主程式
# =====================================================================
def main():
    args = sys.argv[1:]
    as_json = "--json" in args
    src, out_dir, force = None, None, None
    i = 0
    while i < len(args):
        a = args[i]
        if a in ("--out", "--engine"):
            if i + 1 >= len(args) or args[i + 1].startswith("--"):
                die(2, "{} 後面要接值".format(a), as_json)   # exit 2＝沒檢查；不能掉成 exit 1（那是「有硬缺陷」）
            if a == "--out":
                out_dir = args[i + 1]
            else:
                force = args[i + 1]
            i += 1
        elif a not in ("--json", "--raw-quotes") and src is None:
            src = a
        i += 1
    if not src:
        die(2, "用法：python visual_check.py <檔案> [--out <目錄>] [--engine powerpoint|word|keynote|libreoffice] [--json]", as_json)
    src = os.path.abspath(src)
    if not os.path.isfile(src):
        die(2, "找不到檔案：{}".format(src), as_json)
    ext = os.path.splitext(src)[1].lower()
    if ext not in (".pptx", ".docx", ".pdf"):
        die(2, "視覺檢查支援 .pptx / .docx / .pdf，不支援 {}".format(ext), as_json)
    try:
        import fitz  # PyMuPDF
        from PIL import Image, ImageDraw
    except ImportError as e:
        die(2, "視覺檢查需要 PyMuPDF 與 Pillow：pip install pymupdf pillow（缺 {}）".format(e.name), as_json)

    base = os.path.join(tempfile.gettempdir(), "deliver-report-visual")
    # 7 天前的舊輸出順手清掉（只清這個專用資料夾底下、名稱是本工具格式的子資料夾）。
    # 給了 --out 也要清：check-before 一律指定輸出資料夾（同一個專用資料夾、同樣的命名格式）。
    # 本次的輸出資料夾與它的祖先不清：--out 剛好指到舊資料夾（或它底下）時，不能先把它刪掉
    # --out 路徑上只要有一層是連結（符號連結、junction 等重新導向點），這次就不清：
    # 連結可以指向別的連結、一層接一層，路徑實際會經過哪些資料夾無法只從各層的解析結果推回來。
    # 舊輸出只是晚一點清。專用資料夾本身與它的上層是連結不算（macOS 的暫存路徑經過 /var → /private/var）：
    # 候選資料夾也是從同一個專用資料夾路徑列出來的，那一段的連結兩邊解析結果相同，不影響比對。
    # 沒有連結時，路徑字串之外再依實際檔案身分比對 --out 每一層已存在的祖先，
    # 涵蓋大小寫不同與 8.3 短檔名這類同一資料夾的不同寫法；字串比對與它重疊，留著在比對檔案身分出錯時備用
    def _is_link(p):
        # 0x400＝Windows 的 FILE_ATTRIBUTE_REPARSE_POINT（junction 不算 islink）
        return os.path.islink(p) or bool(getattr(os.lstat(p), "st_file_attributes", 0) & 0x400)

    def _has_link(p):
        # 本工具的輸出只有圖片、清單與 PDF，不會含連結；含連結的資料夾可能是別的路徑借道之處
        # （例如暫存資料夾本身是連結、繞經舊輸出裡的連結），刪了會讓那條路徑斷掉，所以不刪
        try:
            if _is_link(p):
                return True
            for e in os.scandir(p):
                if _is_link(e.path) or (e.is_dir(follow_symlinks=False) and _has_link(e.path)):
                    return True
        except OSError:
            return True
        return False

    keep = os.path.normcase(os.path.abspath(out_dir)) if out_dir else None
    nbase = os.path.normcase(os.path.abspath(base))
    guards = []
    linked = False
    if out_dir:
        cur = os.path.abspath(out_dir)
        while True:
            ncur = os.path.normcase(cur)
            shared = ncur == nbase or nbase.startswith(ncur if ncur.endswith(os.sep) else ncur + os.sep)
            if os.path.lexists(cur) and not shared:
                try:
                    if _is_link(cur):
                        linked = True
                except OSError:
                    linked = True
            if os.path.exists(cur):
                guards.append(cur)
            nxt = os.path.dirname(cur)
            if nxt == cur:
                break
            cur = nxt

    def _protected(p):
        np_ = os.path.normcase(os.path.abspath(p))
        if keep and (keep == np_ or keep.startswith(np_ + os.sep)):
            return True
        for g in guards:
            try:
                if os.path.samefile(p, g):
                    return True
            except OSError:
                pass
        return False

    try:
        for d in ([] if linked else os.listdir(base)):
            p = os.path.join(base, d)
            if _protected(p):
                continue
            if re.search(r"-\d{8}-\d{6}-[0-9a-f]{6}$", d) and os.path.isdir(p) and time.time() - os.path.getmtime(p) > 7 * 86400 and not _has_link(p):
                shutil.rmtree(p, ignore_errors=True)
    except OSError:
        pass
    if not out_dir:
        stem = re.sub(r"[^\w\-]+", "_", os.path.splitext(os.path.basename(src))[0])[:40]
        # 加亂數尾碼：同一秒檢查兩份同名檔（不同資料夾）時不會共用資料夾、互相覆蓋圖片與清單
        out_dir = os.path.join(base, "{}-{}-{}".format(stem, time.strftime("%Y%m%d-%H%M%S"), os.urandom(3).hex()))
    out_dir = os.path.abspath(out_dir)
    os.makedirs(out_dir, exist_ok=True)

    notes_pre, engine_used, target = [], None, True
    if ext == ".pdf":
        pdf = src
        engine_used = "PDF 原檔"
    else:
        # 一律用正規化的絕對路徑：PowerPoint 的 SaveAs 不接受混用正斜線的路徑
        pdf = os.path.abspath(os.path.join(out_dir, "rendered.pdf"))
        engines = engines_for(ext)
        if force:
            engines = [e for e in engines if e[0] == force]
            if not engines:
                die(2, "這台電腦不支援排版方式「{}」".format(force), as_json)
        fails = []
        # 排版一律開「複本」：直接開原檔時，若使用者正開著同一份，Mac 的 close saving no 會連使用者的視窗一起關掉、
        # 丟掉沒存的修改；Word 也不能同時開兩份同名文件。複本取不會撞名的檔名，放在獨立暫存資料夾，用完就刪
        work = tempfile.mkdtemp(prefix="dr-src-")
        copy = os.path.join(work, "dr-check-{}{}".format(os.urandom(4).hex(), ext))
        try:
            shutil.copy2(src, copy)
            for key, name, is_target, fn in engines:
                try:
                    if os.path.exists(pdf):
                        os.remove(pdf)
                    fn(copy, pdf)
                    if not os.path.isfile(pdf) or os.path.getsize(pdf) == 0:
                        raise RenderError("沒有產出 PDF")
                    engine_used, target = name, is_target
                    break
                except RenderError as e:
                    fails.append("{}：{}".format(name, e))
        finally:
            shutil.rmtree(work, ignore_errors=True)
        if not engine_used:
            hint = ("Windows 請安裝 Microsoft Office 或 LibreOffice" if IS_WIN else
                    "macOS 請安裝 Microsoft Office、Keynote 或 LibreOffice（brew install --cask libreoffice）" if IS_MAC else
                    "請安裝 LibreOffice（例如 sudo apt install libreoffice）")
            # 軟體都在、是這份檔打不開（有密碼、損毀）時不能叫人去裝軟體
            none_installed = all(("沒有安裝" in f) or ("找不到執行檔" in f) for f in fails)
            if fails and not none_installed:
                die(2, "視覺未驗證：排版失敗（{}）".format("；".join(fails)), as_json)
            die(2, "視覺未驗證：沒有可用的排版軟體（{}）。{}".format("；".join(fails) or "本機沒有支援的軟體", hint), as_json)
        if fails:
            notes_pre.append("前面的排版方式沒成功，改用 {}：{}".format(engine_used, "；".join(fails)))
        if not target:
            notes_pre.append("這次用 {} 排版，不是對方實際會用的 {}：換行、字型、自動縮字可能不同，"
                             "疊字判定僅供參考，有 {} 的電腦請再跑一次".format(
                                 engine_used, "PowerPoint" if ext == ".pptx" else "Word",
                                 "PowerPoint" if ext == ".pptx" else "Word"))

    struct = None
    if ext == ".pptx":
        try:
            struct = pptx_structure(src)
        except Exception as e:
            notes_pre.append("讀不到簡報結構（{}），「字跑出方塊外」「文字被裁掉」「字型」三項未檢查".format(type(e).__name__))

    try:
        res = analyze(pdf, ext, struct, out_dir, fitz, Image, ImageDraw, target)
    except Exception as e:
        die(2, "排版結果讀取失敗（{}: {}）".format(type(e).__name__, str(e)[:160]), as_json)
    # 非原生排版（LibreOffice、Keynote）：疊字、字跑出方塊、超出頁面都取決於換行位置，
    # 而換行跟字寬走——實測兩份真實簡報在 PowerPoint 0 處、在 LibreOffice 各多 6～7 處（標題最後一個字被擠到下一行）。
    # 所以全部降為提醒，請使用者在原生軟體確認；紅框照畫、圖照樣要逐張看。
    if not target:
        app = "PowerPoint" if ext == ".pptx" else "Word"
        res["notes"] = ["【{} 排版下的問題，{} 可能正常，請在 {} 確認】{}".format(engine_used, app, app, b)
                        for b in res["bad"]] + res["notes"]
        res["bad"] = []
    res["notes"] = notes_pre + res["notes"]
    manifest = {
        "file": src, "engine": engine_used, "target_software": target, "out_dir": os.path.abspath(out_dir),
        "created": time.time(), **res,
    }
    mpath = os.path.join(out_dir, "visual-manifest.json")
    with open(mpath, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    manifest["manifest"] = os.path.abspath(mpath)

    if as_json:
        print()   # 先換行，理由同 die()
        print(json.dumps({"ok": True, **manifest}, ensure_ascii=False))
    else:
        print("視覺檢查：{}".format(src))
        print("排版：{}　頁數：{}".format(engine_used, res["pages"]))
        print("✗ 硬缺陷 {} 項".format(len(res["bad"])) if res["bad"] else "✓ 硬缺陷 0 項")
        for b in res["bad"]:
            print("   · " + b)
        print("△ 提醒 {} 項".format(len(res["notes"])))
        for n in res["notes"]:
            print("   · " + n)
        print("每頁圖片（問題處有紅框，每一張都要打開看過）：")
        for p in res["images"]:
            print("   " + p)
        print("VISUAL_MANIFEST: " + manifest["manifest"])
    sys.exit(1 if res["bad"] else 0)


if __name__ == "__main__":
    main()
