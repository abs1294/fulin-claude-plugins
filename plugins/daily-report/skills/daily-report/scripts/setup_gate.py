#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
setup_gate.py — 首次設定的機械閘：把「該講清楚的話」從模型自律變成腳本輸出。

為什麼需要這支（本 repo CLAUDE.md 硬規則 4）：
SKILL.md 寫「要把三個選項的差別講清楚」是自律——模型在長對話尾端或趕時間時，
會壓縮成「你要用哪種？」，使用者就在資訊不足下選了權限最寬的那個。
解法不是把字寫得更大聲，而是讓「選項文字」由腳本產生：模型只負責搬運，
搬運不會遺漏內容。同一份文字每次都一樣，不隨模型狀態浮動。

三個子命令：
  status   偵測目前設定到哪（decide 前必跑，輸出決定走哪條路）
  options  印出三選項的完整比較（JSON，供模型填進 AskUserQuestion）
  guide    印出指定管道的逐步引導（步驟固定，不靠模型記憶）

Exit code：
  0 = 已完成設定（status 會印出使用哪條管道）
  10 = 尚未設定，需要跑引導（status 專用，非錯誤）
  1 = 參數錯誤
"""
import argparse
import json
import os
import sys

if sys.stdout.encoding and sys.stdout.encoding.lower() not in ("utf-8", "utf8"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

CONFIG_PATH = os.path.join(os.path.expanduser("~"), ".claude", "daily-report", "config.json")

# 三選項的完整比較。這份文字是「必須被講出來的內容」的單一事實來源——
# 改這裡，所有使用者看到的說明就一起改，不必期待每個模型都記得補上。
OPTIONS = [
    {
        "key": "oauth",
        "label": "Gmail API OAuth（推薦）",
        "權限": "只有『代你寄信』（gmail.send）——讀不到你任何信件",
        "有效期": "token 會過期並自動更新；可隨時在 Google 帳戶頁撤銷",
        "設定成本": "約 5 分鐘，一次性：開 Google Cloud 專案 → 建用戶端 → 瀏覽器按一下允許",
        "適合": "長期使用、在意權限範圍、或這台要給別人也用",
        "代價": "設定步驟較多（但 Claude 會一步步帶你做完）",
    },
    {
        "key": "app_password",
        "label": "應用程式密碼（快速）",
        "權限": "⚠ 等同整個信箱的完整存取權（能讀、能寄、能刪）",
        "有效期": "⚠ 永不過期，除非你手動刪除或變更帳號密碼",
        "設定成本": "約 2 分鐘：開兩步驟驗證 → 產生 16 碼密碼 → 貼進設定檔",
        "適合": "只想快速跑起來、或需要無人值守排程自動寄送",
        "代價": "Google 官方立場為不建議使用；密碼外洩等於信箱失守",
    },
    {
        "key": "mcp_draft",
        "label": "Gmail MCP 建草稿（零設定）",
        "權限": "不直接寄出——只把日報放進你的草稿匣",
        "有效期": "沿用你既有的 Claude Gmail 連線授權",
        "設定成本": "0：不需任何憑證，只要告訴我收件人是誰",
        "適合": "先試用看看、或希望每次都親自按下送出",
        "代價": "需要你自己開 Gmail 按送出；無法排程自動寄",
    },
]

GUIDES = {
    "oauth": {
        "title": "Gmail API OAuth 設定引導",
        "note": "每一步做完再進下一步；卡住就把畫面描述給我，我針對那個畫面給提示。",
        "steps": [
            {"do": "開 https://console.cloud.google.com/projectcreate ，專案名稱可填 daily-report，按「建立」",
             "check": "右上角通知顯示建立完成，且畫面頂端已切換到這個新專案"},
            {"do": "開 https://console.cloud.google.com/apis/library/gmail.googleapis.com ，按「啟用」",
             "check": "按鈕變成「管理」即代表已啟用"},
            {"do": "開 https://console.cloud.google.com/auth/branding ，填應用程式名稱與使用者支援電子郵件（填你自己的信箱），對象選「外部」，儲存",
             "check": "個人 Gmail 帳號只會有「外部」這個選項，屬正常"},
            {"do": "開 https://console.cloud.google.com/auth/audience ，在「測試使用者」加入你自己的 Gmail 地址",
             "check": "沒加這一步，稍後授權會被 Google 拒絕。另注意：維持「測試中」狀態的話授權 7 天後會過期，想長期用可在同頁按「發布應用程式」（個人自用不會觸發 Google 驗證要求）"},
            {"do": "開 https://console.cloud.google.com/auth/clients ，按「建立用戶端」，類型選「桌面應用程式」，建立",
             "check": "畫面會顯示「用戶端 ID」與「用戶端密鑰」兩個值，先留在畫面上"},
            {"do": "把上一步兩個值填進這個指令執行（瀏覽器會自動開啟）：\n"
                   "  python \"<PLUGIN>/skills/daily-report/scripts/gmail_oauth.py\" setup --client-id <用戶端ID> --client-secret <用戶端密鑰>",
             "check": "瀏覽器若顯示「Google 尚未驗證這個應用程式」→ 點「進階」→「前往…（不安全）」。這是自建用戶端未送驗證的正常畫面。看到「授權完成」頁即成功"},
            {"do": "驗收：python \"<PLUGIN>/skills/daily-report/scripts/gmail_oauth.py\" status",
             "check": "應顯示「✓ 可換發 access_token，授權有效」"},
        ],
    },
    "app_password": {
        "title": "應用程式密碼設定引導",
        "note": "密碼請你自己填進設定檔，不要貼在對話裡。",
        "steps": [
            {"do": "確認 Google 帳戶已開啟兩步驟驗證：https://myaccount.google.com/security",
             "check": "沒開的話下一步的頁面會是空的或顯示不適用"},
            {"do": "開 https://myaccount.google.com/apppasswords ，應用程式名稱填 daily-report，按「建立」",
             "check": "會顯示 16 個字母的密碼，只顯示這一次，當場複製起來"},
            {"do": "把密碼貼進 ~/.claude/daily-report/config.json 的 smtp.app_password 欄位（我可以先幫你把其他欄位建好）",
             "check": "有沒有空格都可以，Google 兩種都接受"},
            {"do": "驗收：python \"<PLUGIN>/skills/daily-report/scripts/send_gmail.py\" --report <日報檔> --date <日期> --dry-run",
             "check": "應印出收件人與主旨而非設定檔錯誤"},
        ],
    },
    "mcp_draft": {
        "title": "MCP 草稿設定引導",
        "note": "不需憑證，只需要知道收件人。",
        "steps": [
            {"do": "告訴我收件人 email（可多位），我寫進 ~/.claude/daily-report/config.json 的 recipients",
             "check": "設定檔只會有 recipients / cc / subject_prefix，不含任何憑證"},
            {"do": "之後每次產日報，我會把它放進你的 Gmail 草稿匣",
             "check": "你開 Gmail 過目後自己按送出——按送出這一下就是最終核可"},
        ],
    },
}


def detect():
    """回傳 (管道, 說明)。管道為 None 代表尚未設定。"""
    if not os.path.exists(CONFIG_PATH):
        return None, "設定檔不存在：" + CONFIG_PATH
    try:
        with open(CONFIG_PATH, encoding="utf-8") as fh:
            cfg = json.load(fh)
    except (json.JSONDecodeError, OSError) as e:
        return None, "設定檔無法解析（{}）：{}".format(CONFIG_PATH, e)

    oauth = cfg.get("oauth") or {}
    smtp = cfg.get("smtp") or {}
    recipients = [r for r in (cfg.get("recipients") or []) if str(r).strip()]

    if oauth.get("refresh_token"):
        chan = "oauth"
    elif smtp.get("app_password"):
        chan = "app_password"
    elif cfg.get("channel") == "mcp_draft":
        chan = "mcp_draft"
    else:
        return None, "設定檔存在但沒有任何可用的寄送管道"

    if not recipients:
        return None, "管道 {} 已設定，但 recipients（收件人）是空的".format(chan)
    return chan, "管道={} 收件人={}".format(chan, ", ".join(recipients))


def cmd_status(args):
    chan, detail = detect()
    if chan:
        print("SETUP_OK")
        print(detail)
        sys.exit(0)
    print("SETUP_REQUIRED", file=sys.stderr)
    print(detail, file=sys.stderr)
    print("\n下一步：跑 `setup_gate.py options` 取得三選項的完整說明，"
          "用 AskUserQuestion 原文呈現給使用者選；選定後跑 `setup_gate.py guide <選項>`。",
          file=sys.stderr)
    sys.exit(10)


def cmd_options(args):
    # 輸出 JSON 讓模型直接映射進 AskUserQuestion 的 label/description，
    # 不需要它自己「回憶」每個選項的權限與代價——那正是會被省略的部分。
    out = []
    for o in OPTIONS:
        desc = "權限：{}｜有效期：{}｜設定：{}｜代價：{}".format(
            o["權限"], o["有效期"], o["設定成本"], o["代價"])
        out.append({"key": o["key"], "label": o["label"],
                    "description": desc, "適合": o["適合"]})
    print(json.dumps({
        "question": "日報要用哪種方式寄出？",
        "header": "寄送管道",
        "instruction": "以下三個選項的 label 與 description 必須原文呈現給使用者，"
                       "不可自行摘要或省略權限與有效期欄位——使用者要在知道『這個選擇給出多少權限』的前提下決定。",
        "options": out,
    }, ensure_ascii=False, indent=2))


def cmd_guide(args):
    g = GUIDES.get(args.channel)
    if not g:
        print("ERROR: 未知管道 {}（可用：{}）".format(args.channel, ", ".join(GUIDES)), file=sys.stderr)
        sys.exit(1)
    print("== {} ==".format(g["title"]))
    print(g["note"])
    print()
    for i, s in enumerate(g["steps"], 1):
        print("步驟 {}：{}".format(i, s["do"]))
        print("  確認：{}".format(s["check"]))
        print()
    print("（每步做完等使用者回報再講下一步；<PLUGIN> 請替換成實際 plugin 路徑）")


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("status").set_defaults(func=cmd_status)
    sub.add_parser("options").set_defaults(func=cmd_options)
    g = sub.add_parser("guide")
    g.add_argument("channel", choices=list(GUIDES))
    g.set_defaults(func=cmd_guide)
    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
