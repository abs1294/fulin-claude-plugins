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

HOME_CONFIG = os.path.join(os.path.expanduser("~"), ".claude", "daily-report", "config.json")
# 專案層設定：放專案自己的 .claude/ 底下。plugin 裝在 project scope 時，
# 收件人本來就該跟著專案走（Winbond 的日報不該寄給 AI Platform 的窗口）。
PROJECT_CONFIG_REL = os.path.join(".claude", "daily-report.json")


def resolve_config_path(project_dir=None):
    """回傳 (使用的設定檔路徑, 是否為專案層)。

    解析順序：專案層 <專案>/.claude/daily-report.json → 家目錄 config.json。
    專案層只需覆寫收件人（recipients/cc/subject_prefix）；憑證一律留在家目錄那份，
    因為憑證跟「人」綁定而非跟專案綁定，而且專案目錄常在 git 版控內。
    """
    root = os.path.abspath(project_dir or os.getcwd())
    p = os.path.join(root, PROJECT_CONFIG_REL)
    if os.path.exists(p):
        return p, True
    return HOME_CONFIG, False


def load_merged(project_dir=None):
    """合併家目錄（憑證）與專案層（收件人）設定。專案層的收件人欄位優先。"""
    merged = {}
    for path in (HOME_CONFIG,):
        if os.path.exists(path):
            try:
                with open(path, encoding="utf-8") as fh:
                    merged.update(json.load(fh))
            except (json.JSONDecodeError, OSError):
                pass
    proj_path, is_proj = resolve_config_path(project_dir)
    if is_proj:
        try:
            with open(proj_path, encoding="utf-8") as fh:
                proj = json.load(fh)
            # 只讓專案層覆寫「寄給誰」，不讓它帶憑證（避免憑證進 git）
            for k in ("recipients", "cc", "subject_prefix", "from_name", "channel"):
                if k in proj:
                    merged[k] = proj[k]
            merged["_project_config"] = proj_path
        except (json.JSONDecodeError, OSError):
            pass
    return merged

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
        "label": "應用程式密碼（快速，但公司帳號多半不可用）",
        "權限": "⚠ 等同整個信箱的完整存取權（能讀、能寄、能刪）",
        "有效期": "⚠ 永不過期，除非你手動刪除或變更帳號密碼",
        "設定成本": "約 2 分鐘：開兩步驟驗證 → 產生 16 碼密碼 → 貼進設定檔",
        "適合": "個人 Gmail、只想快速跑起來、或需要無人值守排程自動寄送",
        "代價": "⚠ 公司 Google Workspace 帳號常被管理員停用此功能（頁面會顯示"
                "「setting not available」）——若你的信箱是公司發的，別花時間試，直接走 OAuth。"
                "另外 Google 官方立場為不建議使用；密碼外洩等於信箱失守",
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
        "note": "每一步做完再進下一步；卡住就把畫面描述給我，我針對那個畫面給提示。\n"
                "⚠ 步驟裡的 Console 網址可能隨 Google 改版而過時——最後的 doctor 會實際打 API 驗證，"
                "並輸出 Google 當下給的正確連結。以 doctor 的輸出為準，不以本步驟文字為準。",
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
            {"do": "驗收（必跑，不可略）：python \"<PLUGIN>/skills/daily-report/scripts/gmail_oauth.py\" doctor",
             "check": "五項全綠才算完成。若顯示「尚未啟用 Gmail API」→ 開它附的那個連結按啟用（用 Google 給的連結，不要用步驟 2 的網址，Console 路徑會改版）；顯示 invalid_grant → 重跑 setup。doctor 是實際打 API 驗證，比自己看畫面可靠"},
        ],
    },
    "app_password": {
        "title": "應用程式密碼設定引導",
        "note": "密碼請你自己填進設定檔，不要貼在對話裡。\n"
                "⚠ 先確認帳號類型再開始：這條路對「公司 Google Workspace 帳號」多半不通"
                "（管理員預設停用），別白花時間，不確定就先做步驟 0。",
        "steps": [
            {"do": "【前置判斷】你的 Gmail 是公司發的（you@公司網域）還是個人 @gmail.com？"
                   "公司帳號請直接開 https://myaccount.google.com/apppasswords 確認——"
                   "若顯示「The setting you are looking for is not available for your account」，"
                   "代表被管理員停用，**這條路走不通，改用 OAuth**（回 setup_gate options 選 oauth）。",
             "check": "個人 Gmail 通常可用；公司帳號看到 not available 就停，別繼續下面步驟"},
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
            {"do": "告訴我收件人 email（可多位）。我會寫進設定檔的 recipients，"
                   "並同時寫入 \"channel\": \"mcp_draft\" 標明你選的是草稿管道",
             "check": "設定檔只會有 channel / recipients / cc / subject_prefix，不含任何憑證。"
                      "channel 這欄不可省略——沒有它，若這台機器剛好有別的憑證，"
                      "會被誤判成直接寄送而不是建草稿"},
            {"do": "驗收：python \"<PLUGIN>/skills/daily-report/scripts/setup_gate.py\" status",
             "check": "應顯示 SETUP_OK 且「管道=mcp_draft」。若顯示別的管道，代表 channel 沒寫進去"},
            {"do": "之後每次產日報，我會把它放進你的 Gmail 草稿匣",
             "check": "你開 Gmail 過目後自己按送出——按送出這一下就是最終核可"},
        ],
    },
}


def detect(project_dir=None):
    """回傳 (管道, 說明)。管道為 None 代表尚未設定。"""
    proj_path, is_proj = resolve_config_path(project_dir)
    if not os.path.exists(HOME_CONFIG) and not is_proj:
        return None, "設定檔不存在：" + HOME_CONFIG
    cfg = load_merged(project_dir)
    if not cfg:
        return None, "設定檔無法解析或內容為空"

    oauth = cfg.get("oauth") or {}
    smtp = cfg.get("smtp") or {}
    # 收件人只認專案層——家目錄的 recipients 不算數（避免沒設定的專案借用別人的收件人）。
    # 與 send_common.resolve_recipients 同紀律：收件人跟專案綁定，不跟人綁定。
    recipients = []
    proj_path = cfg.get("_project_config")
    if proj_path and os.path.exists(proj_path):
        try:
            with open(proj_path, encoding="utf-8") as fh:
                recipients = [r for r in ((json.load(fh) or {}).get("recipients") or [])
                              if str(r).strip()]
        except (json.JSONDecodeError, OSError):
            recipients = []

    # channel 是使用者的明示選擇，優先於「偵測到有什麼憑證」。
    # 沒有這個優先序時，選了 mcp_draft 的人會因為家目錄剛好有 OAuth 憑證
    # 而被誤判成 oauth 管道（同一台機器多人/多情境共用時必然發生）。
    explicit = cfg.get("channel")
    if explicit == "mcp_draft":
        chan = "mcp_draft"
    elif explicit == "oauth" and oauth.get("refresh_token"):
        chan = "oauth"
    elif explicit == "app_password" and smtp.get("app_password"):
        chan = "app_password"
    elif explicit in ("oauth", "app_password"):
        return None, ("設定檔指定管道 {} 但缺對應憑證（{}）——跑對應的引導完成設定"
                      .format(explicit,
                              "oauth.refresh_token" if explicit == "oauth" else "smtp.app_password"))
    elif oauth.get("refresh_token"):
        chan = "oauth"
    elif smtp.get("app_password"):
        chan = "app_password"
    else:
        return None, "設定檔存在但沒有任何可用的寄送管道"

    if not recipients:
        return None, ("管道 {} 已設定（憑證就緒），但這個專案還沒設收件人。\n"
                      "  收件人要在專案自己的 .claude/daily-report.json 設定"
                      "（家目錄的收件人不當預設，避免誤寄給別的專案的窗口）。".format(chan))
    src = cfg.get("_project_config")
    cc = [c for c in (cfg.get("cc") or []) if str(c).strip()]
    # 標明寄件帳號：憑證一律來自家目錄，收件人可能來自專案層。
    # 不標的話，使用者看不出這封信會用哪個帳號寄出——多帳號共用一台機器時會寄錯身分。
    sender = cfg.get("from_email") or (cfg.get("smtp") or {}).get("user") or ""
    parts = ["管道=" + chan, "收件人=" + ", ".join(recipients)]
    if cc:
        parts.append("副本=" + ", ".join(cc))
    if sender and chan != "mcp_draft":
        parts.append("寄件帳號={}（憑證來自 {}）".format(sender, HOME_CONFIG))
    parts.append("收件人設定來源=" + src)
    return chan, "  ".join(parts)


def cmd_status(args):
    chan, detail = detect(getattr(args, "project", None))
    if chan:
        print("SETUP_OK")
        print(detail)
        sys.exit(0)
    print("SETUP_REQUIRED", file=sys.stderr)
    print(detail, file=sys.stderr)
    print("\n下一步：跑 `setup_gate.py options` 取得三選項的完整說明，"
          "用 AskUserQuestion 原文呈現給使用者選；選定後跑 `setup_gate.py guide <選項>`。",
          file=sys.stderr)
    print("提示：收件人可依專案覆寫——在專案建 .claude/daily-report.json 放 "
          "{\"recipients\": [...], \"cc\": [...]}；憑證仍統一留在家目錄那份。", file=sys.stderr)
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
    st = sub.add_parser("status")
    st.add_argument("--project", help="專案目錄（省略=目前工作目錄）")
    st.set_defaults(func=cmd_status)
    sub.add_parser("options").set_defaults(func=cmd_options)
    g = sub.add_parser("guide")
    g.add_argument("channel", choices=list(GUIDES))
    g.set_defaults(func=cmd_guide)
    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
