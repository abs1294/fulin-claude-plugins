#!/usr/bin/env python3
"""
視覺檢查回歸測試：產生 12 份測試文件，用指定的排版方式跑 visual_check.py，逐份對照預期。

用法：python run_fixtures.py [--engine powerpoint|keynote|libreoffice] [--out <資料夾>]
  --engine 只套在 pptx；docx 在 --engine libreoffice 時也用 LibreOffice，其餘用預設順序（Word 優先）。
  不給 --engine 就用本機預設順序。
依賴：python-pptx、python-docx（產測試檔）、PyMuPDF、Pillow（visual_check.py）
結果：每份一行 PASS/FAIL，最後印總數；各份的圖片與 visual-manifest.json 在輸出資料夾，
      summary.json 是整批結果（Mac 實測時把整個輸出資料夾傳回來即可）。
"""
import os
import sys
import json
import time
import platform
import subprocess
import tempfile

try:
    sys.stdout.reconfigure(encoding="utf-8")   # Windows 主控台預設 cp950，中文會變亂碼
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
VC = os.path.normpath(os.path.join(HERE, "..", "..", "..", "skills", "check-before", "scripts", "visual_check.py"))

args = sys.argv[1:]
engine = args[args.index("--engine") + 1] if "--engine" in args else None
out = os.path.abspath(args[args.index("--out") + 1]) if "--out" in args else os.path.join(
    tempfile.gettempdir(), "dr-visual-fixtures-" + time.strftime("%Y%m%d-%H%M%S"))
fx = os.path.join(out, "fixtures")
os.makedirs(fx, exist_ok=True)
subprocess.run([sys.executable, os.path.join(HERE, "make_fixtures.py"), fx], check=True, capture_output=True)


def has(items, *words):
    return any(all(w in x for w in words) for x in items)


# (檔名, 預期說明, 判斷函式(bad, notes) -> bool)
CASES = [
    ("p01_clean.pptx", "0 缺陷", lambda b, n: not b),
    ("p02_overlap.pptx", "報疊字", lambda b, n: has(b, "疊字")),
    ("p03_card_overflow.pptx", "報字跑出方塊", lambda b, n: has(b, "跑出方塊")),
    ("p04_offslide.pptx", "報超出頁面或被裁掉", lambda b, n: has(b, "超出頁面") or has(b, "沒出現在畫面上")),
    ("p05_text_on_shape.pptx", "0 缺陷、不報壓在圖上", lambda b, n: not b and not has(n, "壓在圖片")),
    ("p06_table_tall.pptx", "報超出頁面或被裁掉", lambda b, n: has(b, "超出頁面") or has(b, "沒出現在畫面上")),
    ("p07_shrunk.pptx", "提醒字太小", lambda b, n: has(n, "字級小於")),
    ("p08_ghost.pptx", "報疊兩層或疊字", lambda b, n: has(b, "疊了兩層") or has(b, "疊字")),
    ("p09_multi.pptx", "第 2 張疊字、第 3 張空白", lambda b, n: has(b, "第 2 張", "疊字") and not has(b, "第 1 張") and has(n, "空白頁", "3")),
    ("p10_placeholders.pptx", "0 缺陷", lambda b, n: not b),
    ("d11_clean.docx", "0 缺陷", lambda b, n: not b),
    ("d12_tight_spacing.docx", "報疊字", lambda b, n: has(b, "疊字")),
]

results, npass = [], 0
print("平台：{} {}　排版：{}".format(platform.system(), platform.release(), engine or "預設順序"))
for name, want, judge in CASES:
    src = os.path.join(fx, name)
    cmd = [sys.executable, VC, src, "--json", "--out", os.path.join(out, os.path.splitext(name)[0])]
    eng = engine if name.endswith(".pptx") else ("libreoffice" if engine == "libreoffice" else None)
    if eng:
        cmd += ["--engine", eng]
    t0 = time.time()
    r = subprocess.run(cmd, capture_output=True)
    txt = r.stdout.decode("utf-8", "replace").strip()
    try:
        j = json.loads(txt.splitlines()[-1])
    except Exception:
        j = {"ok": False, "error": (txt or r.stderr.decode("utf-8", "replace"))[-300:]}
    if not j.get("ok"):
        ok, got = False, "無法執行：" + str(j.get("error"))
    else:
        ok = judge(j["bad"], j["notes"])
        got = "；".join(j["bad"] + ["（提醒）" + x for x in j["notes"]]) or "0 缺陷、0 提醒"
    npass += ok
    results.append({"file": name, "want": want, "pass": ok, "engine": j.get("engine"), "seconds": round(time.time() - t0, 1),
                    "bad": j.get("bad"), "notes": j.get("notes"), "error": j.get("error")})
    print("{}  {:<26} 預期：{}　{}".format("PASS" if ok else "FAIL", name, want,
                                        "" if ok else "\n        實際：" + got[:400]))

with open(os.path.join(out, "summary.json"), "w", encoding="utf-8") as f:
    json.dump({"platform": platform.platform(), "engine": engine, "results": results}, f, ensure_ascii=False, indent=2)
print("\n{} passed, {} failed".format(npass, len(CASES) - npass))
print("輸出資料夾：" + out)
sys.exit(0 if npass == len(CASES) else 1)
