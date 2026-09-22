#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""cbm 索引新鮮度檢查——索引比原始碼舊就報紅。

為什麼需要這支：
    codebase-memory-mcp 的查詢結果**不帶新鮮度標記**。對著兩天前的索引查，
    回傳的節點數、行號、關係邊都長得跟新鮮的一模一樣，不報錯、不警告。

    實測案例：四個 project 有兩個索引比 HEAD 舊 40 小時以上，而該段期間
    正好有一輪死碼清理 commit。對那兩個 project 查「某元件還在不在」，
    會拿到已經刪掉的檔案——且看起來完全正常。

    ⚠ 互補驗證抓不到這件事：舊索引的 657+611 與新索引的 570+698 都等於
    總數 1,268，兩組各自都自洽。要判斷索引新不新，只能比對時間。

判準：
    索引時間 < 該 repo HEAD 的 commit 時間  →  過期（exit 1）
    工作區有未提交改動時**不算過期**——本地 hack 本來就不該進索引，
    拿它當判準會恆紅。

盲區（引用本工具結論時要一併說明）：
    1. 只比對「時間」，不比對內容。索引時間新於 HEAD 不代表索引內容正確。
    2. 看不到「索引成功但解析失敗」的檔案（index_status 的 parse_partial）。
    3. 只認 git HEAD。未提交的改動一律忽略。
    4. 反向不檢查：索引比 HEAD 新很多（repo 被 reset）不報紅。

設定：
    專案根的 cbm-guard.config.json 的 "freshness" 段：
      repos          要檢查的 repo 目錄名（相對於專案根）
      projectPrefix  cbm project 名稱前綴（用 list_projects 看實際值）
      binary         cbm 執行檔路徑（不填則自動找）
    沒有設定檔時：自動偵測專案根下所有含 .git 的第一層子目錄。

用法：
    python cbm_index_freshness.py            # 檢查全部，過期列出來
    python cbm_index_freshness.py --quiet    # 只回 exit code
    python cbm_index_freshness.py --fix      # 印出重建指令（不自動跑）
    python cbm_index_freshness.py --root X   # 指定專案根
"""
import json
import os
import subprocess
import sys
from datetime import datetime, timezone


def find_binary(configured):
    if configured and os.path.exists(configured):
        return configured
    for cand in (
        os.path.expanduser("~/.local/bin/codebase-memory-mcp.exe"),
        os.path.expanduser("~/.local/bin/codebase-memory-mcp"),
    ):
        if os.path.exists(cand):
            return cand
    return "codebase-memory-mcp"  # 賭它在 PATH 上


def find_root(argv):
    if "--root" in argv:
        return os.path.abspath(argv[argv.index("--root") + 1])
    return os.path.abspath(os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd())


def load_config(root):
    for name in ("cbm-guard.config.json", ".cbm-guard.json"):
        p = os.path.join(root, name)
        if os.path.exists(p):
            try:
                with open(p, encoding="utf-8") as f:
                    return json.load(f).get("freshness", {}) or {}
            except (ValueError, OSError):
                return {}
    return {}


def autodetect_repos(root):
    """沒設定時：找第一層裡含 .git 的子目錄。"""
    out = []
    try:
        for name in sorted(os.listdir(root)):
            if name.startswith("."):
                continue
            if os.path.isdir(os.path.join(root, name, ".git")):
                out.append(name)
    except OSError:
        pass
    return out


def cbm_call(binary, tool, args):
    try:
        r = subprocess.run(
            [binary, "cli", "--quiet", "--json", tool, json.dumps(args)],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if r.returncode != 0 or not r.stdout.strip():
        return None
    try:
        return json.loads(r.stdout).get("content", [{}])[0].get("text", "")
    except (ValueError, IndexError, KeyError):
        return None


def parse_indexed_at(text):
    if not text:
        return None
    for line in text.split("\n"):
        line = line.strip()
        if line.startswith("indexed_at:"):
            raw = line.split(":", 1)[1].strip()
            try:
                return datetime.strptime(raw, "%Y-%m-%dT%H:%M:%SZ").replace(
                    tzinfo=timezone.utc)
            except ValueError:
                return None
    return None


def head_commit_time(repo_dir):
    try:
        r = subprocess.run(
            ["git", "-C", repo_dir, "log", "-1", "--format=%cI"],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if r.returncode != 0 or not r.stdout.strip():
        return None
    try:
        return datetime.fromisoformat(r.stdout.strip())
    except ValueError:
        return None


def main():
    argv = sys.argv[1:]
    quiet = "--quiet" in argv
    show_fix = "--fix" in argv

    root = find_root(argv)
    cfg = load_config(root)
    binary = find_binary(cfg.get("binary"))
    repos = cfg.get("repos") or autodetect_repos(root)
    prefix = cfg.get("projectPrefix", "")

    if not repos:
        if not quiet:
            print("[!] 找不到任何 repo。用 --root 指定專案根，")
            print("    或在 cbm-guard.config.json 的 freshness.repos 列出來。")
        return 2

    stale, fresh, missing = [], [], []

    for repo in repos:
        repo_dir = os.path.join(root, repo)
        if not os.path.isdir(repo_dir):
            missing.append((repo, "目錄不存在"))
            continue

        project = prefix + repo
        idx_at = parse_indexed_at(cbm_call(binary, "index_status", {"project": project}))
        if idx_at is None:
            missing.append((repo, "索引不存在或讀不到 indexed_at（projectPrefix 對嗎？）"))
            continue

        head_at = head_commit_time(repo_dir)
        if head_at is None:
            missing.append((repo, "讀不到 HEAD commit 時間"))
            continue

        delta_h = (head_at - idx_at).total_seconds() / 3600.0
        row = (repo, idx_at, delta_h, repo_dir)
        (stale if delta_h > 0 else fresh).append(row)

    if not quiet:
        print("cbm 索引新鮮度（索引時間 vs 該 repo HEAD commit 時間）")
        print("=" * 72)
        for repo, idx_at, _, _ in fresh:
            print("  [新鮮] %-38s 索引 %s" % (repo, idx_at.strftime("%Y-%m-%d %H:%MZ")))
        for repo, idx_at, delta_h, _ in stale:
            print("  [過期] %-38s 索引 %s  落後 HEAD %.1f 小時" % (
                repo, idx_at.strftime("%Y-%m-%d %H:%MZ"), delta_h))
        for repo, why in missing:
            print("  [缺]   %-38s %s" % (repo, why))

        if stale:
            print("")
            print("[!] 過期索引的查詢結果**看起來跟新鮮的一模一樣**——不報錯、不警告。")
            print("    對過期索引查「某個東西還在不在」會拿到已刪除的檔案。")
            if show_fix:
                print("")
                print("重建指令（成本極低，110K 行約 9 秒）：")
                for _, _, _, repo_dir in stale:
                    print('  "%s" cli --quiet index_repository \'{"repo_path":"%s"}\''
                          % (binary, repo_dir.replace("\\", "/")))
            else:
                print("    加 --fix 可印出重建指令。")

    if missing:
        return 2
    return 1 if stale else 0


if __name__ == "__main__":
    sys.exit(main())
