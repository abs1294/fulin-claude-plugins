#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
extract_sessions.py — 掃描 ~/.claude/projects/ 的 session jsonl，萃取指定日期的工作紀錄。

輸出一份「按專案（cwd）分組」的精簡 JSON 中間檔，供 Claude 生成日報用。
零外部依賴（純 stdlib）。Windows/UTF-8 安全。

用法：
  python extract_sessions.py [--date YYYY-MM-DD] [--tz +08:00] [--out 路徑]
                             [--project <路徑>|--all-projects]

  --date          目標日期（依 --tz 的當地時間界定一天），省略 = 今天
  --tz            時區偏移，預設 +08:00（台北）
  --out           輸出 JSON 檔路徑，省略 = ~/.claude/daily-report/out/<date>[-<專案>].json
  --project       只掃這個專案路徑底下的 session（含子目錄）。
                  省略時預設用目前工作目錄——因為 plugin 通常裝在 project scope，
                  「這個專案的日報」才是預期行為；掃全機器會把別的客戶/專案混進來。
  --all-projects  明確要求掃全機器所有專案（跨專案總覽時才用）

Exit code：0 成功；3 = 該日無任何 session（呼叫端可據此提示）。

設計要點（為何這樣做）：
- mtime 預過濾：jsonl 檔 mtime 早於目標日 00:00 就整檔跳過——當天沒動過的檔
  不可能含當天記錄，大幅減少要解析的檔案數。
- isSidechain 過濾：subagent 對話（isSidechain=true）不是使用者本人說的話，
  混進 prompts 會讓日報充滿派工雜訊。
- ai-title 直取：Claude Code 自動為每個 session 生成標題，是現成的主題訊號，
  比從 prompt 猜關鍵字可靠。
- prompts 截斷 400 字：日報要的是「做了什麼」的線索，不是全文重播。
"""
import argparse
import glob
import json
import os
import re
import sys
from collections import Counter
from datetime import datetime, timedelta, timezone

# Windows 主控台預設 cp950，強制 UTF-8 輸出避免中文炸編碼
if sys.stdout.encoding and sys.stdout.encoding.lower() not in ("utf-8", "utf8"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

PROJECTS_DIR = os.path.join(os.path.expanduser("~"), ".claude", "projects")
DEFAULT_OUT_DIR = os.path.join(os.path.expanduser("~"), ".claude", "daily-report", "out")
PROMPT_MAX = 400

# 這些開頭的 user 記錄不是使用者親手打的話（本機指令回顯、hook 注入、系統提醒），
# 進日報只會是雜訊。
NOISE_PREFIXES = (
    "<local-command-caveat", "<command-name", "<command-message", "<local-command-stdout",
    "Caveat:", "<system-reminder", "[Request interrupted", "<task-notification", "[{",
    "Base directory for this skill",       # skill 載入時注入的 SKILL.md 全文
    "This session is being continued",     # 續接 session 的自動摘要
    "The previous response failed",        # tool call 失敗的系統重試提示
    "[Image: source:",                     # 圖片附件路徑列
)

# 人打的 prompt 才進日報。promptSource 'system'（task 通知/peer 訊息）與 'sdk'
# 是程式注入；'typed'/'queued' 是人；None 是舊格式（多為人打，靠 NOISE_PREFIXES 兜底）。
HUMAN_PROMPT_SOURCES = (None, "typed", "queued")


def parse_tz(tz_str):
    """'+08:00' → timezone 物件"""
    sign = 1 if tz_str[0] != "-" else -1
    body = tz_str.lstrip("+-")
    hh, mm = (body.split(":") + ["0"])[:2]
    return timezone(sign * timedelta(hours=int(hh), minutes=int(mm)))


def parse_ts(ts_str, tz):
    """ISO UTC timestamp → 目標時區的 datetime；解析失敗回 None"""
    try:
        return datetime.fromisoformat(ts_str.replace("Z", "+00:00")).astimezone(tz)
    except (ValueError, AttributeError, TypeError):
        return None


def clean_prompt(content):
    """從 user message content 取出人打的文字；雜訊/非文字回 None"""
    if isinstance(content, list):
        # content 陣列：只收 text block（tool_result 等跳過）
        texts = [b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text"]
        content = "\n".join(t for t in texts if t)
    if not isinstance(content, str):
        return None
    s = content.strip()
    if not s:
        return None
    for p in NOISE_PREFIXES:
        if s.startswith(p):
            return None
    if len(s) > PROMPT_MAX:
        s = s[:PROMPT_MAX] + "…"
    return s


def in_scope(cwd, scope_root):
    """session 的 cwd 是否落在 scope_root 底下（含自身與子目錄）。

    用 normcase 比對：Windows 路徑大小寫不敏感，且可能混用 / 與 \\。
    加尾綴分隔符再比前綴，避免 C:\\proj 誤匹配到 C:\\project2。
    """
    if not cwd:
        return False
    a = os.path.normcase(os.path.abspath(cwd))
    b = os.path.normcase(os.path.abspath(scope_root))
    return a == b or a.startswith(b + os.sep)


def scan_file(path, day_start, day_end, tz, include_auto=False):
    """解析一個 session jsonl，回傳該日摘要 dict；該日無記錄回 None"""
    title = None
    prompts = []
    tool_counts = Counter()
    first_ts = last_ts = None
    cwd = None
    git_branch = None
    assistant_turns = 0
    is_sdk = False  # entrypoint 'sdk-cli' = headless/程式驅動 session（自動化雜訊）

    try:
        fh = open(path, encoding="utf-8", errors="replace")
    except OSError:
        return None
    with fh:
        for line in fh:
            try:
                o = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(o, dict):
                continue
            t = o.get("type")
            if t == "ai-title":
                title = o.get("aiTitle") or title  # 取最後一個（標題會隨對話演進更新）
                continue
            if t not in ("user", "assistant"):
                continue
            ts = parse_ts(o.get("timestamp"), tz)
            if ts is None or not (day_start <= ts < day_end):
                continue
            if o.get("isSidechain"):
                continue  # subagent 對話，非使用者本人
            first_ts = first_ts or ts
            last_ts = ts
            cwd = o.get("cwd") or cwd
            git_branch = o.get("gitBranch") or git_branch
            # jsonl 格式隨 Claude Code 版本演進（origin 曾見 dict，難保不出現字串等變體）。
            # 單行畸形不可讓整次萃取崩潰——寧可跳過一行，不要死掉一天的日報。
            message = o.get("message")
            if not isinstance(message, dict):
                message = {}
            if t == "user":
                if o.get("entrypoint") == "sdk-cli":
                    is_sdk = True
                src = o.get("promptSource")
                origin = o.get("origin")
                origin_kind = origin.get("kind") if isinstance(origin, dict) else origin
                # 非人打的注入（task 通知、peer 訊息、SDK 程式輸入）不進 prompts
                if src not in HUMAN_PROMPT_SOURCES or origin_kind not in (None, "human"):
                    continue
                p = clean_prompt(message.get("content"))
                if p:
                    prompts.append({"time": ts.strftime("%H:%M"), "text": p})
            else:  # assistant
                assistant_turns += 1
                content = message.get("content")
                if isinstance(content, list):
                    for b in content:
                        if isinstance(b, dict) and b.get("type") == "tool_use":
                            tool_counts[b.get("name", "?")] += 1

    if first_ts is None:
        return None
    # 程式驅動 session（SDK 或整場零人打 prompt）預設不進日報——日報涵蓋的是「人做的工作」，
    # 自動化跑批（隔離複本改碼、tunnel 測試等）只會稀釋內容。要看可用 --include-auto。
    if not include_auto and (is_sdk or not prompts):
        return None
    return {
        "session_id": os.path.splitext(os.path.basename(path))[0],
        "title": title,
        "cwd": cwd,
        "git_branch": git_branch,
        "time_range": [first_ts.strftime("%H:%M"), last_ts.strftime("%H:%M")],
        "prompt_count": len(prompts),
        "assistant_turns": assistant_turns,
        "prompts": prompts,
        "tool_counts": dict(tool_counts.most_common()),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", help="YYYY-MM-DD，省略=今天（依 --tz）")
    ap.add_argument("--tz", default="+08:00")
    ap.add_argument("--out", help="輸出 JSON 路徑")
    ap.add_argument("--include-auto", action="store_true",
                    help="連程式驅動 session（SDK/零人打 prompt）也納入")
    ap.add_argument("--project", help="只掃此專案路徑底下的 session（省略=目前工作目錄）")
    ap.add_argument("--all-projects", action="store_true", help="掃全機器所有專案")
    args = ap.parse_args()

    # 專案範圍：預設限定當前工作目錄。plugin 多裝在 project scope，
    # 「產日報」的預期是「這個專案今天做了什麼」，不是把所有客戶的工作混成一封信。
    scope_root = None
    if not args.all_projects:
        scope_root = os.path.abspath(args.project or os.getcwd())

    try:
        tz = parse_tz(args.tz)
    except (ValueError, IndexError):
        print("ERROR: --tz 格式錯誤（例：+08:00）：" + repr(args.tz), file=sys.stderr)
        sys.exit(1)
    if args.date:
        try:
            day = datetime.strptime(args.date, "%Y-%m-%d").replace(tzinfo=tz)
        except ValueError:
            print("ERROR: --date 格式錯誤（需 YYYY-MM-DD）：" + repr(args.date), file=sys.stderr)
            sys.exit(1)
    else:
        now = datetime.now(tz)
        day = now.replace(hour=0, minute=0, second=0, microsecond=0)
    day_start = day.replace(hour=0, minute=0, second=0, microsecond=0)
    day_end = day_start + timedelta(days=1)

    sessions = []
    # mtime 預過濾：檔案最後修改早於當日 00:00 → 不可能含當日記錄
    cutoff = day_start.timestamp()
    for path in glob.glob(os.path.join(PROJECTS_DIR, "*", "*.jsonl")):
        try:
            if os.path.getmtime(path) < cutoff:
                continue
        except OSError:
            continue
        s = scan_file(path, day_start, day_end, tz, args.include_auto)
        if not s:
            continue
        # 用 session 記錄裡的 cwd 判斷歸屬，而非目錄名——目錄名是編碼過的路徑，
        # 反解容易出錯（含空格/中文的路徑更是）。cwd 是原始絕對路徑，可靠。
        if scope_root and not in_scope(s.get("cwd"), scope_root):
            continue
        sessions.append(s)

    if not sessions:
        scope_note = ("（範圍：{}）".format(scope_root) if scope_root else "（範圍：全機器）")
        print("({} 無任何 session 記錄){}".format(day_start.strftime("%Y-%m-%d"), scope_note),
              file=sys.stderr)
        if scope_root:
            print("  若這天的工作在別的目錄，用 --project <路徑> 指定，"
                  "或 --all-projects 掃全機器。", file=sys.stderr)
        sys.exit(3)

    # 按專案（cwd）分組；cwd 缺失的歸入 (unknown)
    projects = {}
    for s in sessions:
        key = s["cwd"] or "(unknown)"
        projects.setdefault(key, []).append(s)
    project_list = []
    for cwd_key in sorted(projects):
        sess = sorted(projects[cwd_key], key=lambda x: x["time_range"][0])
        merged_tools = Counter()
        for s in sess:
            merged_tools.update(s["tool_counts"])
        project_list.append({
            "cwd": cwd_key,
            "session_count": len(sess),
            "tool_counts": dict(merged_tools.most_common(15)),
            "sessions": sess,
        })

    result = {
        "date": day_start.strftime("%Y-%m-%d"),
        "tz": args.tz,
        "scope": scope_root or "(all-projects)",
        "generated_at": datetime.now(tz).isoformat(timespec="seconds"),
        "project_count": len(project_list),
        "session_count": len(sessions),
        "projects": project_list,
    }

    # 檔名帶專案識別，避免不同專案的日報互相覆蓋（同一天可能產多份）
    if args.out:
        out_path = args.out
    else:
        suffix = ""
        if scope_root:
            base = os.path.basename(scope_root.rstrip(os.sep)) or "root"
            suffix = "-" + re.sub(r"[^A-Za-z0-9_.-]", "_", base)
        out_path = os.path.join(DEFAULT_OUT_DIR, result["date"] + suffix + ".json")
    out_dir = os.path.dirname(out_path)
    if out_dir:  # --out 給純檔名（無目錄）時 dirname 為空，makedirs('') 會炸
        os.makedirs(out_dir, exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(result, fh, ensure_ascii=False, indent=1)
    print(out_path)  # 唯一 stdout 輸出＝中間檔路徑，方便呼叫端接
    print("  {}：{} 個專案、{} 個 session（範圍：{}）".format(
        result["date"], len(project_list), len(sessions),
        scope_root or "全機器"), file=sys.stderr)


if __name__ == "__main__":
    main()
