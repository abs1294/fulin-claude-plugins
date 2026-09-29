#!/usr/bin/env python3
"""
visual_check._run() 逾時處理的單元測試（不開 Office，用假程序模擬）：
  1. 有 pidfile（編號是用視窗代號查出來的＝確定是這次開的）→ 殺掉該程序
  2. 沒有 pidfile（卡在拿到視窗代號之前）→ 只列出候選程序、一個都不殺
用法：python hooks/tests/visual/test_timeout.py
"""
import os
import sys
import time
import subprocess
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.normpath(os.path.join(HERE, "..", "..", "..", "skills", "check-before", "scripts")))
import visual_check as v  # noqa: E402

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

passed = failed = 0


def check(label, ok, detail=""):
    global passed, failed
    print("{}  {}{}".format("PASS" if ok else "FAIL", label, "" if ok else "  → " + detail))
    passed += ok
    failed += (not ok)


def alive(pid):
    if v.IS_WIN:
        r = subprocess.run(["tasklist", "/FI", "PID eq {}".format(pid)], capture_output=True)
        return str(pid) in r.stdout.decode("utf-8", "replace")
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


SLEEP = [sys.executable, "-c", "import time; time.sleep(30)"]
tmp = tempfile.mkdtemp(prefix="dr-to-")

# 1. 有 pidfile → 殺掉記錄裡的程序
victim = subprocess.Popen(SLEEP)
pidfile = os.path.join(tmp, "a.pid")
with open(pidfile, "w", encoding="ascii") as f:
    f.write(str(victim.pid))
try:
    v._run(SLEEP, pidfile=pidfile, timeout=1, proc="POWERPNT")
    check("有 pidfile：逾時要丟 RenderError", False, "沒有丟例外")
except v.RenderError as e:
    time.sleep(1)
    check("有 pidfile：逾時後殺掉記錄裡的程序", not alive(victim.pid), "程序 {} 還活著".format(victim.pid))
finally:
    try:
        victim.kill()
    except Exception:
        pass

# 2. 沒有 pidfile → 候選程序只列出、不殺
bystander = subprocess.Popen(SLEEP)
orig = v._automation_pids
v._automation_pids = lambda proc, since: [str(bystander.pid)]   # 假裝它是「程式啟動的 PowerPoint」
try:
    v._run(SLEEP, pidfile=os.path.join(tmp, "missing.pid"), timeout=1, proc="POWERPNT")
    check("沒有 pidfile：逾時要丟 RenderError", False, "沒有丟例外")
except v.RenderError as e:
    time.sleep(1)
    check("沒有 pidfile：候選程序不能被殺", alive(bystander.pid), "程序 {} 被殺了".format(bystander.pid))
    check("沒有 pidfile：錯誤訊息列出候選程序、請使用者手動確認",
          str(bystander.pid) in str(e) and "手動關閉" in str(e), str(e))
finally:
    v._automation_pids = orig
    bystander.kill()

print("\n{} passed, {} failed".format(passed, failed))
sys.exit(1 if failed else 0)
