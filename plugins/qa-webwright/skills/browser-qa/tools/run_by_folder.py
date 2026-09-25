"""逐資料夾跑 pytest，以 junit XML 逐筆計數當結果事實來源（stdout 摘要行容易誤讀）。

用法（於 tests/e2e 下）：
    python tools/run_by_folder.py <folder> [<folder> ...] [--out-dir DIR] [--xdist N] [-- <額外 pytest 參數>]

每個資料夾產出 <out-dir>/<folder>.xml / .log / .json（資料夾名的 / 編碼成 %2F，根資料夾＝%2E）；stdout 每行一筆 JSON 摘要。
--out-dir 預設 reports/by_folder/<YYYY-MM-DD>（相對 tests/e2e）。
計數規則：testcase 含 <error> → error；<failure> → failed；<skipped type 含 xfail> → xfail；
其他 <skipped> → skip；其餘 → passed（xpass 在 junit 裡就是 passed）。
另標記 junit_ok（XML 是否產生）與 aborted_by_gate（被環境閘／port 閘中止）。
"""
import argparse
import io
import json
import os
import subprocess
import sys
import time
import xml.etree.ElementTree as ET
from datetime import date
from urllib.parse import quote

try:
    from . import qa_config
except ImportError:
    import qa_config

KEYS = ("passed", "failed", "error", "xfail", "skip")


def counts_from_junit(xml_path):
    if not os.path.exists(xml_path):
        return None
    try:
        root = ET.parse(xml_path).getroot()
    except ET.ParseError:
        return None
    c = dict.fromkeys(KEYS, 0)
    for tc in root.iter("testcase"):
        tags = [child.tag for child in tc]
        if "error" in tags:
            c["error"] += 1
        elif "failure" in tags:
            c["failed"] += 1
        elif "skipped" in tags:
            sk = tc.find("skipped")
            typ = ((sk.get("type") or "") + " " + (sk.get("message") or "")) if sk is not None else ""
            c["xfail" if "xfail" in typ.lower() else "skip"] += 1
        else:
            c["passed"] += 1
    return c


def run_folder(folder, out_dir, root, xdist=0, extra=()):
    # 路徑分隔符編碼成 %2F（不換成 _）：a/b 與 a_b 不得寫到同一個輸出檔；根資料夾＝%2E
    safe = quote(folder.strip("/\\").replace("\\", "/") or ".", safe="")
    if safe == ".":  # quote() 不編碼「.」；根資料夾明確寫成 %2E，免得檔名變成 ..xml
        safe = "%2E"
    xml_path = os.path.join(out_dir, safe + ".xml")
    if os.path.exists(xml_path):
        os.remove(xml_path)
    args = [sys.executable, "-m", "pytest", folder, "-q", "--junitxml", xml_path]
    args += ["-n", str(xdist)] if xdist else []
    args += list(extra)
    t0 = time.time()
    env = dict(os.environ, PYTHONIOENCODING="utf-8")
    p = subprocess.run(args, cwd=root, capture_output=True, text=True,
                       encoding="utf-8", errors="replace", env=env)
    out = (p.stdout or "") + "\n" + (p.stderr or "")
    c = counts_from_junit(xml_path)
    rec = {"folder": folder, "rc": p.returncode, "duration_s": round(time.time() - t0, 1),
           "junit_ok": c is not None,
           "aborted_by_gate": ("環境不完備" in out or "port 歸屬檢查失敗" in out)}
    c = c or dict.fromkeys(KEYS, 0)
    rec["total"] = sum(c.values())
    rec.update(c)
    with io.open(os.path.join(out_dir, safe + ".log"), "w", encoding="utf-8", newline="\n") as f:
        f.write(out)
    with io.open(os.path.join(out_dir, safe + ".json"), "w", encoding="utf-8", newline="\n") as f:
        json.dump(rec, f, ensure_ascii=False, indent=1)
    return rec


def main(argv=None):
    qa_config.force_utf8_stdio()
    cfg = qa_config.load_or_exit()
    raw = sys.argv[1:] if argv is None else list(argv)
    extra = []
    if "--" in raw:
        i = raw.index("--")
        raw, extra = raw[:i], raw[i + 1:]
    ap = argparse.ArgumentParser(description="逐資料夾跑 pytest（junit 逐筆計數）")
    ap.add_argument("folders", nargs="+")
    ap.add_argument("--out-dir", default=None)
    ap.add_argument("--xdist", type=int, default=0, help="pytest-xdist worker 數（0＝不並行）")
    args = ap.parse_args(raw)
    out_dir = args.out_dir or os.path.join("reports", "by_folder", date.today().isoformat())
    if not os.path.isabs(out_dir):
        out_dir = os.path.join(cfg.root, out_dir)
    os.makedirs(out_dir, exist_ok=True)
    worst = 0
    for fd in args.folders:
        rec = run_folder(fd, out_dir, cfg.root, args.xdist, extra)
        print(json.dumps(rec, ensure_ascii=False), flush=True)
        if rec["rc"] != 0:
            worst = 1
    return worst


if __name__ == "__main__":
    sys.exit(main())
