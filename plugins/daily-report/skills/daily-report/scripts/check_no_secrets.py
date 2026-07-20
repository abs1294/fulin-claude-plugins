#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
check_no_secrets.py — 機制閘：擋住憑證誤入 git。

為什麼需要這支：config.example.json 是「隨 plugin 發布出去的範本」，
而真正的設定檔在使用者家目錄。兩者長得一樣，只差一個是空的。
「不要把真值填進範本」寫在文件裡是自律，AI 或趕時間的人都會繞過；
只有 commit 前跑的檢查是他律。（本 repo CLAUDE.md 硬規則 4）

用法：
  python check_no_secrets.py            # 檢查 repo 內所有 config.example.json
  python check_no_secrets.py --staged   # 只檢查 git staged 的檔（給 pre-commit hook 用）

Exit code：0 乾淨；1 發現疑似真憑證（附檔名與欄位，不印出值本身）。
"""
import argparse
import glob
import json
import os
import re
import subprocess
import sys

if sys.stdout.encoding and sys.stdout.encoding.lower() not in ("utf-8", "utf8"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(
    os.path.dirname(os.path.abspath(__file__))))))  # scripts→skill→skills→plugin→plugins→repo

# 欄位 → 判定為「真值」的樣式。空字串與明顯佔位符一律放行。
SECRET_PATTERNS = {
    "client_id": re.compile(r"\.apps\.googleusercontent\.com$"),
    "client_secret": re.compile(r"^GOCSPX-\S+"),
    "refresh_token": re.compile(r"^1//\S{10,}"),
    "app_password": re.compile(r"^(?:[a-z]{4}\s?){4}$", re.I),
    "access_token": re.compile(r"^ya29\.\S+"),
}
PLACEHOLDER_HINT = re.compile(r"^(x{4}|你的|請填|<.*>|example|placeholder)", re.I)


def walk(obj, path=""):
    """遞迴吐出 (欄位路徑, 值) 的字串葉節點"""
    if isinstance(obj, dict):
        for k, v in obj.items():
            yield from walk(v, path + "." + k if path else k)
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            yield from walk(v, "{}[{}]".format(path, i))
    elif isinstance(obj, str):
        yield path, obj


def scan_file(path):
    """回傳這個檔案裡疑似真憑證的欄位清單"""
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    except (json.JSONDecodeError, OSError):
        return []  # 不是合法 JSON 就不是我們要管的範本檔
    hits = []
    for field_path, value in walk(data):
        leaf = field_path.split(".")[-1]
        pat = SECRET_PATTERNS.get(leaf)
        if not pat or not value.strip() or PLACEHOLDER_HINT.match(value.strip()):
            continue
        if pat.search(value.strip()):
            hits.append(field_path)
    return hits


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--staged", action="store_true", help="只檢查 git staged 的檔案")
    args = ap.parse_args()

    if args.staged:
        try:
            out = subprocess.run(["git", "-C", REPO, "diff", "--cached", "--name-only"],
                                 capture_output=True, text=True, encoding="utf-8", timeout=30)
            files = [os.path.join(REPO, f) for f in out.stdout.split("\n") if f.strip()]
        except (OSError, subprocess.SubprocessError) as e:
            print("WARN: 無法取得 staged 檔案清單（{}），改掃全 repo".format(e), file=sys.stderr)
            files = glob.glob(os.path.join(REPO, "**", "*.json"), recursive=True)
        files = [f for f in files if f.endswith(".json") and os.path.exists(f)]
    else:
        files = glob.glob(os.path.join(REPO, "**", "*.json"), recursive=True)

    problems = []
    for f in files:
        if "node_modules" in f:
            continue
        for field in scan_file(f):
            problems.append((os.path.relpath(f, REPO), field))

    if problems:
        print("✗ 發現疑似真實憑證進入 repo：", file=sys.stderr)
        for f, field in problems:
            print("    {} → {}".format(f, field), file=sys.stderr)
        print("\n憑證正本應放使用者家目錄（~/.claude/daily-report/config.json），"
              "repo 內的 *.example.json 必須留空。", file=sys.stderr)
        print("若確定是誤判，把值改成明顯佔位符（xxxx… / 你的… / <...>）。", file=sys.stderr)
        sys.exit(1)

    print("✓ 未發現憑證外洩（掃描 {} 個 JSON 檔）".format(len(files)))


if __name__ == "__main__":
    main()
