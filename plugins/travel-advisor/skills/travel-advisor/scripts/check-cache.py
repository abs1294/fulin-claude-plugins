#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
檢查 cache/externals.md 裡的外部事實有沒有過期。

用法:
    python -I scripts/check-cache.py        從 skill 根目錄跑（建議）
    python -I check-cache.py                只有 cwd 在 scripts/ 時才成立

🔴 路徑要寫全。原本只寫後者，從 skill 根目錄跑會拿到 Python 的
   "can't open file" 並回 exit 2 —— 那是 Python 的 code，不是本腳本的，
   會被誤讀成「有過期項」之類。文件示範的指令要能直接複製貼上就跑。

每個 E-xx 區塊要有一行形如:
    查核日 2026-10-31   有效天數 90
到期日 = 查核日 + 有效天數。過期項視為「未查證」，Gate-V 不得引用。

🔴 這支只做日期算術。它【不能】回答「判準今天還有效嗎」。

    TTL 沒過期  ≠  判準還活著

Gate-V 的機械判準建在 Google 的 CSS class name（div.F7nice）與
ARIA 屬性上。Google 改版不會通知任何人，日期也不會變 ——
於是這支會印 VALID，而判準其實已經死了。

要驗判準本身，跑 scripts/verify-gatev.js（Node + Playwright，
實際開 Google Maps 比對）。本支會在結尾提醒。

Windows 注意: 本腳本不 print 中文到 stdout (cp950 會亂碼)，
只 print 代號、日期與 ASCII 狀態字。
exit 0 = 全部有效 / exit 3 = 有過期項 / exit 1 = 解析失敗
"""
import io
import os
import re
import sys
from datetime import date, timedelta

ITEM_RE = re.compile(r'^##\s+(E-\d+)\s+(.*)$')
META_RE = re.compile(r'查核日\s+(\d{4})-(\d{2})(?:-(\d{2}))?\s+.*?有效天數\s+(\d+)')

# 建在外部前端實作上的條目 —— 日期有效也可能已經失效。
# 這裡只列「程式化判準」，不列靠文字描述的條目（那些壞掉會被人看出來）。
FRAGILE = {
    "E-01": 'role="feed" / div[role=main][aria-label]',
    "E-02": "depends on E-01 aria-label comparison",
    "E-03": "div.F7nice (score + review count)",
}


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    path = os.path.join(os.path.dirname(here), "cache", "externals.md")
    if not os.path.exists(path):
        print("ERROR: cache/externals.md not found")
        print(path)
        return 1

    with io.open(path, encoding="utf-8") as f:
        lines = f.read().split("\n")

    items = []          # (code, checked_date, ttl_days)
    current = None
    for line in lines:
        m = ITEM_RE.match(line)
        if m:
            current = m.group(1)
            continue
        if current:
            mm = META_RE.search(line)
            if mm:
                y, mo, d, ttl = mm.groups()
                checked = date(int(y), int(mo), int(d) if d else 1)
                items.append((current, checked, int(ttl)))
                current = None

    if not items:
        print("ERROR: no dated E-xx blocks parsed")
        return 1

    today = date.today()
    expired, ok = [], []
    for code, checked, ttl in items:
        due = checked + timedelta(days=ttl)
        (expired if due < today else ok).append((code, checked, due))

    print("today      %s" % today.isoformat())
    print("parsed     %d items" % len(items))
    print("")
    for code, checked, due in ok:
        print("VALID    %-6s checked %s  due %s" % (code, checked, due))
    for code, checked, due in expired:
        print("EXPIRED  %-6s checked %s  due %s  <-- re-verify before use"
              % (code, checked, due))
    print("")
    # 🔴 TTL 有效 != 判準有效。這段必須印在 stdout，不能只寫在 docstring ——
    # 寫在 docstring 等於沒寫，沒人會去讀腳本原始碼。
    fragile = [c for c, _, _ in items if c in FRAGILE]
    if fragile:
        print("")
        print("NOTE: TTL valid does NOT mean the criterion still works.")
        print("      These are built on Google CSS class / ARIA attributes,")
        print("      which change without notice while the date stays valid:")
        for code in fragile:
            print("        %-6s %s" % (code, FRAGILE[code]))
        print("      To verify the criteria themselves (not the dates), run:")
        print("        node scripts/verify-gatev.js")
        print("      It opens Google Maps for real and compares. exit 0 = still valid.")

    print("")
    if expired:
        print("RESULT: %d EXPIRED -- treat as unverified, do not cite in Gate-V"
              % len(expired))
        return 3
    print("RESULT: all dates valid (criteria NOT checked -- see NOTE above)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
