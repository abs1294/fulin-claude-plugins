"""把 plugin 的測試資產工具複製進專案 tests/e2e/tools/，並管理版本（qa-flow.sh scaffold / tools-sync 呼叫）。

用法：
    python install_tools.py install <tests/e2e 目錄>          # scaffold：缺的補上、未改過的更新
    python install_tools.py sync    <tests/e2e 目錄> [--force] # tools-sync
    python install_tools.py status  <tests/e2e 目錄>          # 列出各工具版本與狀態
    python install_tools.py check   <tests/e2e 目錄>          # 只檢查工具落點（tools 不得連到外面）；migrate 預檢用

每支複製出去的工具第一行帶版本標記：
    # qa-webwright-tool: v<版本> sha256=<本體雜湊> — ...
本體雜湊＝標記行以外內容的 sha256。sync 時重算：
  - 相符（沒被改過）→ 以 plugin 新版覆蓋（寫入一律同目錄 tmp＋os.replace）
  - 不符（專案端改過）→ **警告、不覆蓋**（--force 才覆蓋，且先把舊檔改名備份成 <名>.bak-<日期>，同日再備份遞增 -2、-3…）
  - 同名檔沒有標記（專案自有工具撞名）→ 一律不碰
tests/e2e/qa-webwright.json 永遠不覆寫（只在不存在時從範例建立）。

exit：0＝完成；3＝有檔案因本地修改或撞名而略過（需人處理）；2＝參數錯誤。
"""
import ast
import hashlib
import json
import os
import shutil
import sys
from datetime import date

HERE = os.path.dirname(os.path.abspath(__file__))
SKILL_DIR = os.path.dirname(HERE)
PLUGIN_DIR = os.path.dirname(os.path.dirname(SKILL_DIR))
SRC_TOOLS = os.path.join(SKILL_DIR, "tools")
TEMPLATES = os.path.join(SKILL_DIR, "templates")
MARK = "# qa-webwright-tool:"


def plugin_version():
    try:
        with open(os.path.join(PLUGIN_DIR, ".claude-plugin", "plugin.json"), encoding="utf-8") as fh:
            return json.load(fh).get("version", "0.0.0")
    except (OSError, ValueError):
        return "0.0.0"


def sha(data):
    return hashlib.sha256(data).hexdigest()


def header_line(version, body):
    return ("%s v%s sha256=%s — 由 qa-flow.sh scaffold/tools-sync 複製。要改行為請改 plugin 本體；"
            "在此改動會被 tools-sync 視為本地修改而不再更新。\n" % (MARK, version, sha(body)))


def parse(path):
    """回傳 (version, recorded_hash, body_bytes)；無標記回 (None, None, 全文)。"""
    with open(path, "rb") as fh:
        data = fh.read()
    # 本體雜湊以 LF 計算：專案以 autocrlf 等方式 checkout 成 CRLF 不算本地修改
    data = data.replace(b"\r\n", b"\n")
    first, sep, rest = data.partition(b"\n")
    line = first.decode("utf-8", "replace")
    if not line.startswith(MARK):
        return None, None, data
    parts = line[len(MARK):].split()
    ver = parts[0][1:] if parts and parts[0].startswith("v") else None
    rec = None
    for p in parts:
        if p.startswith("sha256="):
            rec = p[len("sha256="):]
    return ver, rec, rest


def atomic_write_bytes(path, data):
    d = os.path.dirname(path)
    os.makedirs(d, exist_ok=True)
    tmp = os.path.join(d, ".%s.tmp-%d" % (os.path.basename(path), os.getpid()))
    with open(tmp, "wb") as fh:
        fh.write(data)
    os.replace(tmp, path)


def source_tools():
    return sorted(n for n in os.listdir(SRC_TOOLS) if n.endswith(".py"))


class LinkedToolsDir(Exception):
    """tests/e2e/tools 是連到別處的 symlink／junction。"""


def check_tools_dir(e2e):
    """tools 目錄若是連到 tests/e2e 外的 symlink／junction，寫入會落到外部目錄 → 拒絕。"""
    dst_dir = os.path.join(e2e, "tools")
    if os.path.lexists(dst_dir) and not os.path.islink(dst_dir) and not os.path.isdir(dst_dir):
        # 同名一般檔案：寫入必在安裝階段才失敗，預檢就要擋，免得 migrate 做到一半
        raise LinkedToolsDir("%s 是一般檔案而不是資料夾，拒絕寫入（請先移走或改名）" % dst_dir)
    if os.path.lexists(dst_dir):
        real = os.path.normcase(os.path.realpath(dst_dir))
        want = os.path.normcase(os.path.join(os.path.realpath(e2e), "tools"))
        if real != want:
            raise LinkedToolsDir("%s 是連到 %s 的連結，拒絕寫入（工具只能複製進 tests/e2e/tools 本身）" % (dst_dir, real))


def _deps(name):
    """某支本 plugin 工具 import 了哪些同目錄工具（模組名，含 .py）。

    用 AST 推導：括號多行 `from . import (a,\n b)`、反斜線續行、`import a as b` 都認得，
    文字比對會靜默漏掉這些寫法。"""
    mods = {os.path.splitext(n)[0] for n in source_tools()}
    try:
        with open(os.path.join(SRC_TOOLS, name), encoding="utf-8") as fh:
            tree = ast.parse(fh.read())
    except (OSError, SyntaxError, ValueError):
        return set()   # 讀不到或解析不了：當成沒有同目錄依賴，不讓整個安裝中斷
    found = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            if node.level >= 1 and not node.module:
                found.update(a.name for a in node.names)       # from . import a, b
            elif node.module:
                found.add(node.module.split(".")[0])            # from a import x／from .a import x
        elif isinstance(node, ast.Import):
            found.update(a.name.split(".")[0] for a in node.names)
    return {m + ".py" for m in found if m in mods and m + ".py" != name}


def _blocked_by_collision(dst_dir):
    """回 {工具名: 撞名的根源檔集合}：依賴（含遞移）落在專案自有同名檔上的本 plugin 工具。

    值是「真正撞名的那幾支專案自有檔」，不是中間那層因此沒裝的本 plugin 工具——
    訊息要指出使用者該去看哪個檔。"""
    collided = set()
    for name in source_tools():
        dst = os.path.join(dst_dir, name)
        if os.path.isdir(dst) or (os.path.exists(dst) and parse(dst)[0] is None):
            collided.add(name)
    deps = {n: _deps(n) for n in source_tools()}
    blocked = {}
    changed = True
    while changed:
        changed = False
        for n, ds in deps.items():
            if n in collided:
                continue
            roots = set()
            for d in ds:
                if d in collided:
                    roots.add(d)
                elif d in blocked:
                    roots |= blocked[d]
            if roots and blocked.get(n) != roots:
                blocked[n] = roots
                changed = True
    return blocked


def sync(e2e, force=False, quiet=False):
    version = plugin_version()
    dst_dir = os.path.join(e2e, "tools")
    check_tools_dir(e2e)
    os.makedirs(dst_dir, exist_ok=True)
    added, updated, same, skipped = [], [], [], []
    blocked = _blocked_by_collision(dst_dir)
    for name in source_tools():
        if name in blocked:
            roots = "、".join(sorted(blocked[name]))
            dst = os.path.join(dst_dir, name)
            if os.path.exists(dst) and parse(dst)[0] is not None:
                skipped.append((name, "它（直接或間接）依賴的 %s 現在是專案自有同名檔，不更新；"
                                      "已安裝的這支舊版仍在原處、import 時會拿到專案那支而介面對不上——"
                                      "請移除本檔，或把專案的同名檔改名" % roots))
            else:
                skipped.append((name, "它（直接或間接）依賴的 %s 是專案自有同名檔（沒有 qa-webwright 版本標記），"
                                      "本工具 import 會拿到那支、介面對不上，不裝" % roots))
            continue
        with open(os.path.join(SRC_TOOLS, name), "rb") as fh:
            body = fh.read().replace(b"\r\n", b"\n")
        new = header_line(version, body).encode("utf-8") + body
        dst = os.path.join(dst_dir, name)
        if os.path.isdir(dst):
            skipped.append((name, "tools/ 底下有同名的資料夾，不碰"))
            continue
        if not os.path.exists(dst):
            atomic_write_bytes(dst, new)
            added.append(name)
            continue
        ver, rec, cur_body = parse(dst)
        if ver is None:
            skipped.append((name, "同名檔沒有 qa-webwright 版本標記（專案自有檔？），不碰"))
            continue
        modified = (rec != sha(cur_body))
        if modified and not force:
            skipped.append((name, "本地修改過（本體雜湊與標記不符），不覆蓋；確認後可 tools-sync --force"))
            continue
        if not modified and cur_body == body and ver == version:
            same.append(name)
            continue
        if modified and force:
            # 同日多次強制更新：備份檔名遞增（-2、-3…），不得覆蓋先前的備份
            bak = "%s.bak-%s" % (dst, date.today().isoformat())
            n = 1
            while os.path.exists(bak):
                n += 1
                bak = "%s.bak-%s-%d" % (dst, date.today().isoformat(), n)
            os.replace(dst, bak)
        atomic_write_bytes(dst, new)
        updated.append("%s（v%s → v%s）" % (name, ver, version))
    if not quiet:
        print("[tools-sync] plugin 版本 v%s → %s" % (version, dst_dir))
        for n in added:
            print("  + 新增 %s" % n)
        for n in updated:
            print("  ~ 更新 %s" % n)
        if same:
            print("  = 已是最新：%d 支" % len(same))
        for n, why in skipped:
            print("  ⚠️ 略過 %s：%s" % (n, why))
    return added, updated, same, skipped


def ensure_config(e2e):
    dst = os.path.join(e2e, "qa-webwright.json")
    if os.path.exists(dst):
        print("[scaffold] 已存在，不覆寫：%s" % dst)
        return False
    with open(os.path.join(TEMPLATES, "qa-webwright.example.json"), "rb") as fh:
        atomic_write_bytes(dst, fh.read().replace(b"\r\n", b"\n"))
    print("[scaffold] 已建立參數檔：%s（請依專案改 biz_tables / ports / residue / external_system_keywords）" % dst)
    return True


def status(e2e):
    version = plugin_version()
    dst_dir = os.path.join(e2e, "tools")
    blocked = _blocked_by_collision(dst_dir) if os.path.isdir(dst_dir) else {}
    for name in source_tools():
        dst = os.path.join(dst_dir, name)
        if name in blocked:
            state = "已安裝但" if os.path.exists(dst) and parse(dst)[0] is not None else ""
            print("  %-26s %s撞名受阻（依賴的 %s 是專案自有同名檔）" % (name, state, "、".join(sorted(blocked[name]))))
            continue
        if os.path.isdir(dst):
            print("  %-26s 同名資料夾（不是工具檔）" % name)
            continue
        if not os.path.exists(dst):
            print("  %-26s 未安裝" % name)
            continue
        ver, rec, body = parse(dst)
        if ver is None:
            print("  %-26s 無版本標記（專案自有檔）" % name)
        else:
            state = "本地修改" if rec != sha(body) else ("最新" if ver == version else "可更新")
            print("  %-26s v%s（%s）" % (name, ver, state))


def main(argv):
    if len(argv) < 3 or argv[1] not in ("install", "sync", "status", "check"):
        print(__doc__)
        return 2
    cmd, e2e = argv[1], os.path.abspath(argv[2])
    force = "--force" in argv[3:]
    if cmd == "status":
        status(e2e)
        return 0
    try:
        check_tools_dir(e2e)
    except LinkedToolsDir as exc:
        print("[tools-sync] 錯誤：%s" % exc)
        return 2
    if cmd == "check":
        return 0                        # 只做落點預檢（migrate 在改寫任何檔之前先跑）
    if cmd == "install":
        ensure_config(e2e)
    _a, _u, _s, skipped = sync(e2e, force=force)
    return 3 if skipped else 0


if __name__ == "__main__":
    for _s in (sys.stdout, sys.stderr):
        if hasattr(_s, "reconfigure"):
            try:
                _s.reconfigure(encoding="utf-8")
            except (ValueError, OSError):
                pass
    sys.exit(main(sys.argv))
