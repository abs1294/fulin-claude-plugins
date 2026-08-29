#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
content_guard.py — 硬閘：日報內容不得出現 AI / 工具鏈相關描述。

為什麼是硬閘而不是寫在 SKILL.md 裡：
「產日報時不要提到 AI」是自律，長對話中模型會忘、會用同義詞繞過
（把「AI 工作流程」寫成「智能助理流程」照樣洩漏）。實戰證據：本 plugin
首次寄出的日報就含 9 處（「Claude Code 用量」「AI 工作流程」「plugin 推薦清單」）。
所以真正的保證只能來自「寄送前掃描、命中即 exit 1」——寄送腳本呼叫它，繞不過。

黑名單擋得住直球（AI、Claude、prompt…），擋不住同義詞。同義詞靠 SKILL.md 的
改寫指引處理，這是「兩層」設計：機制擋直球、自律處理語意，不假裝單靠一層就夠。

用法：
  python content_guard.py <報告.md>          # 檢查，命中 exit 1
  python content_guard.py <報告.md> --json   # 機器可讀輸出

設定檔（可選）：~/.claude/daily-report/config.json 的 content_guard 區塊
  {
    "extra_banned": ["自訂禁用詞"],
    "allow": ["某個誤判的詞"],
    "aliases": {"AI Platform": "Solara"}
  }
"""
import argparse
import json
import os
import re
import sys

if sys.stdout.encoding and sys.stdout.encoding.lower() not in ("utf-8", "utf8"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

CONFIG_PATH = os.path.join(os.path.expanduser("~"), ".claude", "daily-report", "config.json")

# 禁用詞：對外日報不該出現的 AI / 工具鏈用語。
# 分組是為了讓錯誤訊息能說「這屬於哪一類」，方便使用者理解為何被擋。
BANNED = {
    "AI 與模型": [
        r"\bAI\b", r"\bA\.I\.", r"人工智慧", r"人工智能",
        r"\bClaude\b", r"\bAnthropic\b", r"\bChatGPT\b", r"\bGPT-?[0-9]?\b",
        r"\bCopilot\b", r"\bGemini\b", r"\bCodex\b", r"\bLLM\b",
        r"大語言模型", r"語言模型", r"生成式",
    ],
    "工具鏈與提示詞": [
        r"\bprompt\b", r"提示詞", r"\bagent\b", r"\bsubagent\b", r"代理人",
        r"\bplugin\b", r"外掛", r"\bskill\b(?!s?-)", r"技能包",
        r"\btoken\b", r"權杖", r"\bMCP\b", r"\bhook\b",
        r"紅藍對抗", r"對抗式審查", r"自動生成", r"自動產生",
    ],
    "自動化痕跡": [
        r"由.{0,6}協助", r"協助完成", r"自動彙整", r"智能助理", r"智慧助理",
        r"機器人", r"\bbot\b",
    ],
    # 以下是「不是 AI 但更不該外洩」的東西。日報的素材是使用者的對話原文，
    # 裡面可能有客戶機密、憑證、個資——只擋 AI 詞彙而讓這些通過，
    # 會讓使用者看到「✓ 通過」而誤以為已被把關（紅隊實測：含明文密碼與身分證字號的
    # 日報被判定通過）。這些 pattern 抓的是「形狀」，誤判率低。
    "憑證與密鑰": [
        # 「密碼/password」後面跟著**看起來像密碼值**的字串才算命中。
        # 值的特徵：純 ASCII、含數字、且有大小寫混雜或符號——這樣
        # 「密碼輪替機制的設計審查」（中文敘述）不會誤命中，
        # 而「資料庫密碼 Passw0rd!2026」會。誤判會訓練使用者忽略警告，
        # 比漏抓更難補救，所以寧可窄一點。
        r"(?i)(?:密碼|passw?o?r?d)\s*[:：=]?\s*(?=[!-~]{6,})(?=[!-~]*\d)"
        r"(?:(?=[!-~]*[A-Z])(?=[!-~]*[a-z])|(?=[!-~]*[^\w\s]))[!-~]{6,}",
        r"(?i)\bapi[_-]?key\b\s*[:=]?\s*[!-~]{8,}",
        r"(?i)\bsecret\b\s*[:=]\s*[!-~]{6,}",
        r"(?i)\btoken\b\s*[:=]\s*\S+",
        r"GOCSPX-[A-Za-z0-9_-]{6,}", r"\bAIza[A-Za-z0-9_-]{20,}",
        r"\bya29\.[A-Za-z0-9_-]{10,}", r"\bsk-[A-Za-z0-9]{20,}",
        r"-----BEGIN [A-Z ]*PRIVATE KEY-----",
        r"(?i)\bBearer\s+[A-Za-z0-9._-]{20,}",
    ],
    "個資": [
        r"\b[A-Z][12]\d{8}\b",                       # 身分證字號
        r"\b\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b",  # 信用卡號
        r"\b09\d{2}[- ]?\d{3}[- ]?\d{3}\b",          # 手機號碼
        r"\b[\w.+-]+@[\w-]+\.[\w.]+\b",              # email（收件人由 config 管，內文不該有）
    ],
    "金額": [
        r"(?:NT\$|NTD|US\$|USD|＄|\$)\s?[\d,]{4,}",   # 四位數以上金額
        r"[\d,]{4,}\s*(?:萬元|億元|元整)",
    ],
}

# 這些是「看起來像但其實合法」的情況，預設放行（可被 config 的 allow 擴充）。
# 例：ChAIn、AIR 之類含 AI 的英文詞；正則已用 \b 邊界，這裡是額外保險。
DEFAULT_ALLOW = []


PROJECT_CONFIG_REL = os.path.join(".claude", "daily-report.json")


def load_guard_config(project_dir=None):
    """合併家目錄與專案層的 content_guard 設定。

    別名（aliases）多半是專案特有的（某專案的內部代號 → 對外名稱），
    所以專案層的 aliases 會疊加在家目錄那份之上，兩邊都生效。
    """
    cfg = {}
    for path in (CONFIG_PATH,
                 os.path.join(os.path.abspath(project_dir or os.getcwd()), PROJECT_CONFIG_REL)):
        if not os.path.exists(path):
            continue
        try:
            with open(path, encoding="utf-8") as fh:
                g = (json.load(fh) or {}).get("content_guard") or {}
        except (json.JSONDecodeError, OSError):
            continue
        for k in ("extra_banned", "allow"):
            if g.get(k):
                cfg.setdefault(k, []).extend(g[k])
        if g.get("aliases"):
            cfg.setdefault("aliases", {}).update(g["aliases"])
    return cfg


def suggest_aliases(text, cfg):
    """找出「疑似專案名但含禁用詞」的片段，回報給呼叫端去問使用者要什麼對外別名。

    存在理由（通用化）：禁用詞清單對所有使用者都一樣，但別名是每個人自己的
    （A 的「AI Platform」叫 Solara，B 的可能叫別的）。與其要求每個使用者自己
    去編 JSON，不如在擋下的當下把「需要命名的東西」列出來，由 Claude 問一句、
    自動寫進他的 config——使用者不必知道 aliases 這個欄位存在。
    """
    aliases = cfg.get("aliases") or {}
    found = []
    # 標題行（## 開頭）最可能是專案名；含禁用詞又還沒設別名的就提報
    for line in text.splitlines():
        s = line.strip()
        if not s.startswith("#"):
            continue
        title = s.lstrip("#").strip()
        if not title or title in aliases:
            continue
        for patterns in BANNED.values():
            if any(re.search(p, title, re.IGNORECASE) for p in patterns):
                if title not in found:
                    found.append(title)
                break
    return found


def scan(text, cfg=None):
    """回傳命中清單 [(行號, 類別, 命中詞, 該行內容)]"""
    cfg = cfg or {}
    allow = set(DEFAULT_ALLOW) | set(cfg.get("allow") or [])
    groups = {k: list(v) for k, v in BANNED.items()}
    if cfg.get("extra_banned"):
        groups.setdefault("自訂", []).extend(
            re.escape(w) if not w.startswith("re:") else w[3:]
            for w in cfg["extra_banned"])

    hits = []
    for lineno, line in enumerate(text.splitlines(), 1):
        for group, patterns in groups.items():
            for pat in patterns:
                for m in re.finditer(pat, line, re.IGNORECASE):
                    word = m.group(0)
                    if word in allow:
                        continue
                    hits.append((lineno, group, word, line.strip()))
    return hits


def main():
    ap = argparse.ArgumentParser()
    # nargs="?"：--set-alias 模式不需要報告檔，檢查模式才需要（下方自行驗證）
    ap.add_argument("report", nargs="?", help="日報 markdown 檔")
    ap.add_argument("--json", action="store_true", help="機器可讀輸出")
    ap.add_argument("--project", help="專案目錄（省略=目前工作目錄），決定讀哪份別名設定")
    ap.add_argument("--set-alias", nargs=2, metavar=("原名", "對外別名"),
                    help="登記一組專案別名並寫回設定檔（給 Claude 問完使用者後呼叫）")
    args = ap.parse_args()

    if args.set_alias:
        原名, 別名 = args.set_alias
        target = (os.path.join(os.path.abspath(args.project), PROJECT_CONFIG_REL)
                  if args.project else CONFIG_PATH)
        data = {}
        if os.path.exists(target):
            try:
                with open(target, encoding="utf-8") as fh:
                    data = json.load(fh) or {}
            except (json.JSONDecodeError, OSError) as e:
                print("ERROR: 設定檔無法解析：" + str(e), file=sys.stderr)
                sys.exit(2)
        data.setdefault("content_guard", {}).setdefault("aliases", {})[原名] = 別名
        os.makedirs(os.path.dirname(target), exist_ok=True)
        tmp = target + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False, indent=2)
            fh.write("\n")
        os.replace(tmp, target)
        print("✓ 已登記別名：「{}」→「{}」（寫入 {}）".format(原名, 別名, target))
        sys.exit(0)

    if args.report:
        args.report = os.path.expanduser(args.report)
    if args.project:
        args.project = os.path.expanduser(args.project)
    if not args.report:
        print("ERROR: 需要指定日報檔（或用 --set-alias 登記別名）", file=sys.stderr)
        sys.exit(2)
    if not os.path.exists(args.report):
        print("ERROR: 找不到報告檔：" + args.report, file=sys.stderr)
        sys.exit(2)
    with open(args.report, encoding="utf-8") as fh:
        text = fh.read()

    cfg = load_guard_config(args.project)
    hits = scan(text, cfg)
    need_alias = suggest_aliases(text, cfg) if hits else []

    if args.json:
        print(json.dumps({"passed": not hits,
                          "hits": [{"line": l, "group": g, "word": w, "text": t}
                                   for l, g, w, t in hits],
                          "need_alias": need_alias},
                         ensure_ascii=False, indent=2))
        sys.exit(1 if hits else 0)

    if not hits:
        print("✓ 內容檢查通過：未出現 AI / 工具鏈相關描述")
        sys.exit(0)

    print("✗ 日報含不得對外出現的用語，已拒絕寄送（{} 處）：".format(len(hits)), file=sys.stderr)
    seen = set()
    for lineno, group, word, line in hits:
        key = (lineno, word)
        if key in seen:
            continue
        seen.add(key)
        print("  第 {} 行 [{}] 「{}」".format(lineno, group, word), file=sys.stderr)
        print("      {}".format(line[:90]), file=sys.stderr)
    print("\n改寫原則：站在收件人角度寫「做了什麼、產出是什麼」，", file=sys.stderr)
    print("不寫用什麼工具做的。例：", file=sys.stderr)
    print("  ✗ 調整 AI 工作流程，讓 AI 遇到問題即時詢問", file=sys.stderr)
    print("  ✓ 調整開發流程：遇到需求疑義即時確認，減少返工", file=sys.stderr)
    print("  ✗ 新增 daily-report plugin，經紅藍對抗審查", file=sys.stderr)
    print("  ✓ 新增工作記錄彙整工具，完成設計審查", file=sys.stderr)

    if need_alias:
        # 專案名含禁用詞是「改寫」解決不了的——它是名字。呼叫端（Claude）看到這段
        # 就該問使用者要什麼對外名稱，然後用 --set-alias 登記，下次自動套用。
        print("\n⚠ 下列像是專案名稱，含禁用詞但無法靠改寫解決——需要對外別名：", file=sys.stderr)
        for t in need_alias:
            print("    「{}」".format(t), file=sys.stderr)
        print("  處置：問使用者「這個專案對外要怎麼稱呼？」，取得答案後執行：", file=sys.stderr)
        print("    python content_guard.py --set-alias \"<原名>\" \"<對外別名>\""
              " [--project <專案目錄>]", file=sys.stderr)
        print("  登記後下次產日報直接用別名，使用者不必再被問一次。", file=sys.stderr)
    sys.exit(1)


if __name__ == "__main__":
    main()
