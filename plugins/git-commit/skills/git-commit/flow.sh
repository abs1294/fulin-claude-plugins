#!/usr/bin/env bash
# ============================================================
# flow.sh — git-commit skill 流程輔助腳本
#
# 目的：把 skill 流程中所有「純 git / 檔案 / build 操作」包成
#       三個 subcommand，讓主 AI agent 每階段只需一次 bash call，
#       減少 tool-call 往返的 overhead。
#
# 機制閘（非自律）：ship 在 commit 前實際攔截以下項目，命中即 exit 1：
#   - AI 署名（Co-Authored-By / Generated with Claude / 🤖 / noreply@anthropic …）
#   - 多行 commit message（署名常見夾帶載體）
#   - staged diff 與 prepare 被審查版本不符（TOCTOU，防審查後掉包）
#   - staged diff 沒有審查紀錄（兩軌結果或使用者豁免，見 review-record；不可豁免）
#   - 敏感字（除非顯式 --allow-sensitive）
#   - 真實憑證特徵字串（不可豁免）
#   - 建置產物/快取/備份檔名（除非顯式 --allow-artifacts）
#   - commit message 含 AI 痕跡/作業過程敘述（除非顯式 --allow-message-trace）
#   - commit message 顯示寬度超標（不可豁免）
# 其餘規範（local-overrides 過濾、禁 force push/no-verify）由 subcommand 封裝與旗標缺席保證。
# amend 有專屬子命令（flow.sh amend，見下），會自動建備份分支、擋已 push 的改寫、
# 並在改寫後做 tree 級重現驗證；不經該子命令的裸 amend 由 PreToolUse hook 攔。
#
# 用法：
#   flow.sh analyze <repo>
#   flow.sh prepare <repo> <files...>
#   flow.sh review-record <repo> --codex "<回覆>" --reviewer "<回覆>"   # 兩軌結果
#   flow.sh review-record <repo> --exempt "<理由>"                        # 使用者明示豁免
#     （兩種都可加 --qa "<QA 狀態>"；專案有 .claude/qa-gate.conf 時，staged 含行為類檔就必帶，見 assert_qa_gate）
#   flow.sh check-msg <repo> <type> <description> [--body "<…>"]   # 預覽前先檢查 message
#   flow.sh ship <repo> <type> <description> [--body "<…>"]   # 只 local commit（預設）
#   flow.sh ship <repo> <type> <description> --push     # 經使用者核可後才推遠端
# ============================================================

set -euo pipefail

# 向 PreToolUse hook（hooks/block-bare-git-commit.sh）宣告「本次 git commit 走的是正規流程」。
# hook 只在此變數不為 1 時攔截裸 commit；不 export 的話 flow.sh 自己的 commit 會被自家 hook 擋死。
export GIT_COMMIT_FLOW=1

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 通用化：WORKSPACE_DIR 取自 Claude Code 的工作目錄（不靠 skill 位置回推，
# 因 skill 可能被 plugin-manager adopt 進 monorepo，回推層數會錯）。
# 優先用 CLAUDE_PROJECT_DIR；否則 fallback 到 PWD。
WORKSPACE_DIR="${CLAUDE_PROJECT_DIR:-$PWD}"

# 通用化：local-overrides 放工作目錄層的 .claude/（一份管底下所有 repo）。
OVERRIDES_FILE="$WORKSPACE_DIR/.claude/local-overrides.yml"

# 審查紀錄與流程暫存檔放「工作區」層的 .claude/（不放 skill 內，避免被 plugin 更新影響）。
# 沒設 CLAUDE_PROJECT_DIR 時 PWD 可能是 cd 進去的子 repo 或 worktree，直接用 PWD 會把 review-log.tsv
# 寫進那個 repo：status 冒出 ?? .claude/，工作區的流水帳也少了這幾筆。
# 只有兩種情況改放上層工作區（從 repo 頂層的上一層往上找第一個有 .claude/local-overrides.yml 的目錄）：
#   - repo 是 linked worktree（主 repo 不在這裡，worktree 自己的 .claude/ 是複製來的設定，不是工作區）
#   - 該目錄的 local-overrides.yml 有 `repo: <這個 repo 相對它的路徑>`，表示它本來就是這個 repo 的工作區
# 其餘一律維持 PWD，單一 repo 專案的行為不變。
# 工作區不是 PWD 時，檔名與流水帳的 repo 欄改用「repo 相對工作區的路徑」，否則各 worktree 都是 "." 會互蓋。
TMP_ANCHOR="$WORKSPACE_DIR"
TMP_KEY_PREFIX=""
resolve_tmp_anchor() {
  [ -n "${CLAUDE_PROJECT_DIR:-}" ] && return 0
  local top git_dir common_dir is_linked=0 dir rel
  top="$(git rev-parse --show-toplevel 2>/dev/null)" || return 0
  top="$(cd "$top" && pwd)"
  git_dir="$(cd "$(git rev-parse --git-dir)" && pwd -P)"
  common_dir="$(cd "$(git rev-parse --git-common-dir)" && pwd -P)"
  [ "$git_dir" != "$common_dir" ] && is_linked=1
  dir="$(dirname "$top")"
  while [ "$dir" != "/" ] && [ "$dir" != "." ]; do
    if [ -f "$dir/.claude/local-overrides.yml" ]; then
      rel="${top#"$dir"/}"
      if [ "$is_linked" -eq 1 ] || grep -qE "^[[:space:]]*repo:[[:space:]]*['\"]?${rel//./\\.}['\"]?[[:space:]]*(#.*)?\$" "$dir/.claude/local-overrides.yml"; then
        TMP_ANCHOR="$dir"
        TMP_KEY_PREFIX="$rel"
      fi
      return 0
    fi
    dir="$(dirname "$dir")"
  done
  return 0
}
resolve_tmp_anchor
# 同理，當下目錄沒有自己的 local-overrides.yml 時改讀工作區那份，
# 否則 analyze 會在 repo 裡自動建一份空範本，工作區登記的本機覆寫檔也就不會被排除。
# worktree 自己帶了一份（刻意複製進去的）就照用。
if [ ! -f "$OVERRIDES_FILE" ] && [ "$TMP_ANCHOR" != "$WORKSPACE_DIR" ]; then
  OVERRIDES_FILE="$TMP_ANCHOR/.claude/local-overrides.yml"
fi
TMP_DIR="$TMP_ANCHOR/.claude/.git-commit-tmp"
mkdir -p "$TMP_DIR"

# 暫存檔檔名用的 repo 鍵（斜線換 __）與流水帳 repo 欄的值。
tmp_repo_key() {
  local repo="$1"
  if [ -z "$TMP_KEY_PREFIX" ]; then printf '%s' "$repo"
  elif [ "$repo" = "." ]; then printf '%s' "$TMP_KEY_PREFIX"
  else printf '%s' "$TMP_KEY_PREFIX/$repo"
  fi
}
tmp_repo_slug() { local key; key="$(tmp_repo_key "$1")"; printf '%s' "${key//\//__}"; }

VALID_TYPES=(Feat Modify Style Refactor Perf Chore Docs Test Fix Hotfix)

# 專案層設定（.claude/git-commit.conf，見 load_commit_conf）；沒有設定檔就用下面這組預設。
# 起因：有的 repo 慣例是 `minor:`／`patch:` 前綴、有的完全沒有前綴，寫死一組 Type 只能靠各專案自己改腳本。
COMMIT_CONF=""
# commit 內文（第二行以後）最多幾行。內文是選填，只給「diff 看不出來、但接手的人一定要知道」的一兩句
# （例：要等某個套件發版才能建置）；寫長了就是作業過程敘述，該進交接文件。
BODY_MAX_LINES=3
# 同一批改動審到第幾輪仍 BLOCK 就停下來問使用者（修，或記進交接）；0＝不停（預設）。
# 預設判準：以正確性為準修到底——還有一般問題就繼續修、重送，只有極端情境可以例外（review-record --edge）。
# 每輪都停下來問會讓使用者被同一批改動問好幾次，所以預設不停；要停的專案在設定檔打開。
REVIEW_ASK_ROUND=0
# Codex 仲裁判「只剩極端情境」（RULING: EDGE）就預設豁免（review-record --edge）；0＝關閉，一律要使用者決定。
# 大於 0 都是開啟。舊版的意思是「連續幾輪」，改由獨立的 Codex 仲裁判定後不再數輪數
# （判成極端就不再追，多數一輪只是逼著修極端情境）；保留這個鍵與預設值，舊設定檔不必改。
EDGE_AUTO_EXEMPT_ROUNDS=2
# 審查單登記處：prepare 發的審查單 id → 這個 repo 的狀態目錄。SubagentStop hook（hooks/capture-review-reply.js）
# 靠它把審查代理的回覆存回對的 repo。兩邊都用使用者家目錄，測試可用環境變數換位置。
TICKET_DIR="${GIT_COMMIT_TICKET_DIR:-$HOME/.claude/git-commit-tickets}"

# ------------------------------------------------------------
# Utility
# ------------------------------------------------------------

# 通用化：repo 可為 (a) 工作目錄底下的 git 子目錄名，或 (b) "." 代表工作目錄本身就是 git repo。
resolve_repo_path() {
  local repo="$1"
  if [ "$repo" = "." ]; then
    echo "$WORKSPACE_DIR"
  else
    echo "$WORKSPACE_DIR/$repo"
  fi
}

assert_valid_repo() {
  local repo="$1"
  local repo_path
  repo_path="$(resolve_repo_path "$repo")"
  if [ ! -d "$repo_path" ]; then
    echo "ERROR: repo 路徑不存在：$repo_path" >&2
    case "$repo" in
      /*|[A-Za-z]:*)
        echo "       repo 參數不收絕對路徑，只收「工作目錄（$WORKSPACE_DIR）底下的子目錄名」或 '.'。" >&2
        echo "       要操作別處的 repo：先 cd 到該 repo 再用 '.'。" >&2
        ;;
    esac
    exit 1
  fi
  if ! git -C "$repo_path" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "ERROR: 不是 git repo：$repo_path（repo 參數應為工作目錄底下的 git 子目錄名，或 '.' 代表工作目錄本身）" >&2
    exit 1
  fi
}

assert_valid_type() {
  local type="$1"
  for valid in "${VALID_TYPES[@]}"; do
    [ "$valid" = "$type" ] && return 0
  done
  echo "ERROR: Invalid type: $type" >&2
  echo "Valid types: ${VALID_TYPES[*]}" >&2
  if [ -n "$COMMIT_CONF" ]; then
    echo "       （Type 清單來自 $COMMIT_CONF 的 types=）" >&2
  else
    echo "       這個 repo 慣例不同（例如 minor:/patch: 或沒有前綴）時，在 .claude/git-commit.conf 設 types=，見 git-commit.conf.example" >&2
  fi
  exit 1
}

# Type 為 none（設定檔 types= 列了 none 才合法）時 subject 只有描述本身，不加「Type: 」。
compose_subject() {
  if [ "$1" = "none" ]; then printf '%s' "$2"; else printf '%s: %s' "$1" "$2"; fi
}

type_allowed() {
  local t="$1" v
  for v in "${VALID_TYPES[@]}"; do [ "$v" = "$t" ] && return 0; done
  return 1
}

# 開頭像「Type: 」（英文字＋冒號＋空白）。types= 列了 none 時，只有「不像 Type 前綴」的 subject 才算無前綴描述；
# 像 Type 前綴卻不在清單（`Feat: …` 配 `types=minor none`）要報 Type 不合法，不能當描述放過——
# 否則 amend 沿用、audit 檢查都會被繞過（commit 前第 19 輪 Codex）。ship／check-msg 的 none 描述同一判準。
looks_like_type_prefix() {
  printf '%s' "$1" | grep -E -q '^[A-Za-z]+: '
}

# 通用化：若工作目錄層的 local-overrides.yml 不存在，從 skill 範本自動建立空檔。
# 讓使用者首次在新專案跑 git-commit 時不會缺檔報錯，並提示可填入本地覆寫清單。
ensure_overrides_file() {
  [ -f "$OVERRIDES_FILE" ] && return 0
  mkdir -p "$(dirname "$OVERRIDES_FILE")"
  local example="$SKILL_DIR/local-overrides.example.yml"
  if [ -f "$example" ]; then
    cp "$example" "$OVERRIDES_FILE"
  else
    printf '# local-overrides — 本地覆寫清單（自動建立）\n' > "$OVERRIDES_FILE"
  fi
  echo "[git-commit] 已自動建立 local-overrides：$OVERRIDES_FILE（目前為空範本，可填入本地覆寫檔）" >&2
}

# 推導一個 repo 的所有候選識別字（每行一個），供 overrides 區塊比對。
# 不只用呼叫端傳進來的相對路徑，因為 git worktree 的目錄名（如 wt/dapfe、.worktrees/feat-x）
# 與 overrides 慣用的 repo 正名（如 WEHQ.SupplierManager.Frontend）天生不同，
# 只比路徑會讓整份 overrides 在 worktree 下靜默失效——本機 hack 檔於是全部裸奔進 staging。
# 候選順序不影響結果（任一命中即可），涵蓋：
#   1. 呼叫端傳入的字串（相容既有用法：頂層 key 或 repo: 值直接寫路徑）
#   2. 路徑最後一段（wt/dapfe → dapfe）
#   3. remote URL 的 repo 名（worktree 與其主 repo 共用 remote，這是跨目錄的天然錨點）
#   4. git common dir 的上層目錄名（無 remote 時的退路，指向主 repo 目錄）
repo_identity_candidates() {
  local repo="$1"
  local repo_path
  repo_path="$(resolve_repo_path "$repo")"

  echo "$repo"
  [ "$repo" != "." ] && basename "$repo"

  local url
  url="$(git -C "$repo_path" remote get-url origin 2>/dev/null || true)"
  if [ -n "$url" ]; then
    url="${url%/}"
    url="${url%.git}"
    basename "$url"
  fi

  # worktree 的 commondir 指向主 repo 的 .git；其上層目錄名即主 repo 目錄名
  local common
  common="$(git -C "$repo_path" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
  if [ -n "$common" ]; then
    basename "$(dirname "$common")"
  fi
}

# 從 local-overrides.yml 取得指定 repo 的 path 清單（每行一個）。
# 匹配鍵：頂層 YAML key（如 `my-repo:`）或區塊內 `repo:` 的值，等於任一候選識別字即命中。
#   - 頂層 key 天生唯一，是防「多個區塊都寫 repo: . 而互相污染」的正解。
#   - 同時仍接受 `repo:` 值匹配，向後相容既有 overrides 檔。
# 一個區塊只要頂層 key 或 repo 值其一命中，就輸出它 files 下所有 path。
parse_overrides_for_repo() {
  local target_repo="$1"
  [ -f "$OVERRIDES_FILE" ] || return 0

  local candidates
  candidates="$(repo_identity_candidates "$target_repo" | awk 'NF && !seen[$0]++' | paste -sd '|' -)"
  [ -z "$candidates" ] && candidates="$target_repo"

  awk -v targets="$candidates" '
    BEGIN { n = split(targets, t, "|") }
    function hits(v,   i) {
      for (i = 1; i <= n; i++) if (v == t[i]) return 1
      return 0
    }
    # 頂層 key：行首無縮排、以 : 結尾（排除註解）
    /^[^[:space:]#][^:]*:[[:space:]]*$/ {
      top_key = $0; sub(/:.*$/, "", top_key)
      block_match = hits(top_key) ? 1 : 0
      next
    }
    /^  repo:[[:space:]]/ {
      if (hits($2)) block_match = 1
    }
    /^    - path:[[:space:]]/ {
      if (block_match) { sub(/^    - path:[[:space:]]*/, ""); print }
    }
  ' "$OVERRIDES_FILE"
}

# 檢查 file 是否在 overrides 清單。
# 注意：只做「精確路徑字串相等」比對——不支援萬用字元（*）、目錄前綴或 glob。
# overrides 的 path 必須是與 git status 輸出完全一致的相對路徑（範本已註明此限制）。
is_in_overrides() {
  local file="$1"
  local overrides="$2"
  while IFS= read -r p; do
    [ -z "$p" ] && continue
    [ "$file" = "$p" ] && return 0
  done <<< "$overrides"
  return 1
}

# 從 `git status -s` 輸出行取出檔名（處理 rename）
extract_path_from_status() {
  local line="$1"
  local path="${line:3}"
  [[ "$path" == *" -> "* ]] && path="${path##* -> }"
  path="${path%\"}"
  path="${path#\"}"
  echo "$path"
}

# ------------------------------------------------------------
# 真閘：署名偵測 + 敏感字掃描（機制級，非自律）
# 這兩個函式讓 ship 在 commit 前實際攔截，而不只是印出提醒。
# ------------------------------------------------------------

# 署名 pattern：命中即代表 commit message 混入 AI 署名（使用者最硬的全域規則：禁止）。
# claude.ai 網址與 Claude-Session 尾行（2026-10-16 對抗審查實跑）：開放 --body 之後，Claude Code 預設附的
# session 尾行只靠 MESSAGE_TRACE_PATTERN 的 Claude 擋，而那道可用 --allow-message-trace 放行；小寫網址更是完全不中。
# 署名不可豁免，所以收在這裡。
# 變形寫法（Coauthored-by、Claude Session）只在後面接冒號（trailer 的形狀）時才算，署名這層不可豁免，
# 不能把「新增 coauthored by 欄位」「ClaudeSession 物件」「api.anthropic.com 逾時」這類業務描述硬擋掉（第三輪對抗審查實跑）。
# 網址只認署名會出現的 claude.ai/code（session 網址）與 claude.com/claude-code（預設署名的連結），
# 「支援 claude.ai 連結」這類業務描述不算（commit 前 C 軌審查指出）。
SIGNATURE_PATTERN='Co-Authored-By|Co-?Authored[ -]?By[[:space:]]*:([^:]|$)|Generated with \[?Claude|🤖|noreply@anthropic|Claude Code|Claude[ _-]?Session[[:space:]]*:([^:]|$)|claude\.ai/code|claude\.com/claude-code'

# 可用的 python（實際跑得起來才算）。Windows 的 WindowsApps 佔位 python3 存在但一執行就 exit 49、沒有輸出，
# 只看 command -v 會把它當成可用，寬度算成空字串、署名正規化變空——前者在 set -e 下無聲中止（第三輪對抗審查實跑）。
PYTHON_BIN=""
for _py in python3 python; do
  if command -v "$_py" >/dev/null 2>&1 && [ "$("$_py" -c 'print(1)' 2>/dev/null | tr -d '\r')" = "1" ]; then
    PYTHON_BIN="$(command -v "$_py")"
    break
  fi
done
unset _py

# 署名比對前的正規化：全形轉半形（NFKC）、拿掉零寬字元與軟連字號，免得「ｃｌａｕｄｅ.ａｉ」「claude<零寬>.ai」溜過。
# 沒有可用的 python 就原樣比對（只少這層正規化，原文比對照做）。
# 字元類用 \u 跳脫寫，不寫字元本身：零寬字元在原始碼裡看不見，改檔時容易被弄丟。
scan_normalize() {
  if [ -z "$PYTHON_BIN" ]; then printf '%s' "$1"; return 0; fi
  local out
  if out="$(printf '%s' "$1" | "$PYTHON_BIN" -c '
import sys, unicodedata, re
t = sys.stdin.buffer.read().decode("utf-8", "replace")
t = unicodedata.normalize("NFKC", t)
t = re.sub("[\u200b-\u200f\u2060\ufeff\u00ad]", "", t)
sys.stdout.buffer.write(t.encode("utf-8"))
')"; then
    printf '%s' "$out"
  else
    printf '%s' "$1"
  fi
}
# 原文或正規化後任一命中署名就回 0。
# 用 grep -c 讀完全部輸入、不用 -q：-q 命中就提早結束，上游吃 SIGPIPE，pipefail 下整條回非 0 被當成「沒命中」。
has_signature() {
  local n
  n="$(printf '%s\n' "$1" | grep -E -i -c "$SIGNATURE_PATTERN" || true)"
  [ "${n:-0}" != "0" ] && return 0
  n="$(scan_normalize "$1" | grep -E -i -c "$SIGNATURE_PATTERN" || true)"
  [ "${n:-0}" != "0" ]
}
# Commit message 專用的痕跡 pattern。
# 為什麼要獨立一份：AI_TRACE_PATTERN 只掃 staged diff 的新增行、不掃 message 本身，
# SIGNATURE_PATTERN 又只認 5 個署名關鍵字。「經語法樹掃描確認 25 個 await 全在 try 內」
# 這種句子兩道都不擋，得靠這一份。
# 判準：**一般正常人會寫的文字**。
#   正常人寫 commit message 描述「改了什麼」，不會寫「我用什麼方法確認它是對的」。
#   所以抓的是「作業過程」的語言特徵，不是主題關鍵字——關鍵字黑名單必漏（同 AI_TRACE 的教訓）。
# **抓詞組不抓裸詞**——單一名詞分不出業務語意與作業過程：
#   「審查」是簽核業務、「agent」是代理商，裸詞會擋掉正常 commit。
#   作業過程的特徵在句式（動詞＋結果、冒號帶結論），不在單一名詞。
#   優先度代碼（P0-P3）刻意不抓：在缺陷單系統裡 P1 缺陷／P2 問題／P3 項
#   都是業務欄位命名，接任何詞都可能誤攔。「補 P0 防護」的問題其實是
#   描述太模糊，那該由人判斷、不該由 regex 攔。
#   ⚠️ 中介用 `.` 不用 `[^，。；]`：grep -E 的否定字元類按 byte 運作，
#      會排除 CJK 字的個別 byte，導致整段完全不匹配（「經完整比對」測不到）。
#   ⚠️ 同理不要對 CJK 字用 `?`／`*`：量詞只作用在該字的最後一個 byte，
#      `對抗式?審查` 永遠配不到「對抗審查」。要選擇性就寫成 (A|B) 分支。
#   ⚠️ `.{0,N}` 的 N 也是 byte 數：中文 1 字＝3 bytes，要放行 6 個中文字得寫 {0,18}。
#      寫成中文字數會讓後綴配不到（`驗證：.{0,12}正常` 抓不到「驗證：登入功能正常」）。
#   ⚠️ 不要對 CJK 用字元類 `[經以]`：byte 模式下它匹配這兩字的**任一 byte**，
#      等於變成通配符——實測「理賠案件複查確認」「供應商審查」全被撈進來。用 (A|B) 分支。
#   1) AI/工具身分：專有名詞，業務語境不會出現，可用裸詞
#   2) 作業過程句式：經…確認／實測…通過／驗證：後接結論——要有「動作＋結論」的結構
#   刻意不抓的（試過、會誤擋，交由人在審查時判斷）：
#     優先度代碼 P0-P3  → 缺陷單系統的欄位命名（P1 缺陷／P2 問題）
#     本輪／第 N 輪     → 招標、面試、報價按輪次進行
#     複查             → 保險、稽核、品管的標準流程名詞
#     紅隊             → 資安演練產品的業務命名
#     審查／agent      → 簽核流程／代理商
MESSAGE_TRACE_PATTERN='Claude|Anthropic|Codex|code-reviewer|subagent|紅藍對抗|AI 署名|(經|以實際|以程式).{0,24}(掃描|確認|比對|檢查|審查)|掃描確認|實測.{0,24}(通過|失敗|確認|回應|則)|實跑.{0,24}(通過|確認|驗證)|驗證[：:].{0,36}(通過|正常|無誤|一致|符合|皆已|全數|確認|沒問題|OK)'
# Commit message 描述的顯示寬度上限。單位必須明確定義——寫「N 字」而不說是
# 字元/中文字/byte，同一顆 commit 會被算出兩種不同長度。
# 這裡的定義：全形（CJK、全形標點）算 2，半形算 1。
# 軟清單：命中只印提醒、不擋（無豁免旗標，因為它本來就不擋）。
# 為什麼要有這層：硬擋清單為了不誤傷業務詞而收得很窄，於是「本輪修正登入逾時問題」
# 「第三輪修正後通過驗證」「複查確認無誤後合併」這類句子完全不會被攔、也不會有任何提示。
# 這些詞在業務上確實常見（招標輪次、稽核複查、資安紅隊），硬擋會天天誤傷；
# 但它們同時也是作業過程敘述的典型開頭，全無提示等於防線只剩專有名詞。
# 折衷：印一行提醒，讓寫的人自己判斷。不 exit、不影響回傳碼。
MESSAGE_SOFT_PATTERN='本輪|上輪|本次迭代|第[0-9一二三四五六七八九十]+輪|複查|紅隊|對抗審查|PoC|[Pp][0-3][ -]?(防護|修正|問題|項|缺陷)'

MESSAGE_MAX_WIDTH=72
# 敏感字 pattern（與 analyze 共用同一份，單一事實來源）。
#
# 標記類關鍵字（TEMP/DEBUG/FIXME/XXX/TODO: remove/console.log）一律加後接限定——
# 它們有明確邊界，不加就會吃到正常識別字：實測誤擋過 `// TEMPLATE 常數`、
# `// DEBUGGER 說明`、`// FIXMEs 清單`、`const XXXL`、`// TODO: removeItem`、
# `console.logger()` 六種寫法。
# `// DEBUG` / `// TEMP` 的斜線與字之間用 [[:space:]]* 而非固定一個空白，
# 因為 `//DEBUG`（無空白）同樣該攔。
#
# ★ 後接限定用「不是英數」而**不是 \b**（2026-09-16 對抗審查，兩軌各自實測重現）：
#   POSIX ERE 的 \b 把底線算成 word char，於是 `// DEBUG_MODE`、`// TEMP_FILE`、
#   `XXX_TOKEN`、`FIXME_LATER` 這些**本來就該擋**的寫法會一起被放掉。
#   底線命名的標記是常態，這個漏報比誤報嚴重得多。
#   （\b 另有跨平台風險：它是 GNU 擴充，非 POSIX 標準。）
# ★ console.log 用「後面不是識別字字元」而**不是「後面必須是左括號」**：
#   要求接 `(` 會讓 `console.log`（裸引用）、`const f = console.log;`（別名）、
#   `console.log.apply(...)`、`console.log?.(x)`、tagged template 全部逃掉——
#   其中別名與 tagged template 是真的會印出機敏值的寫法。
#   用否定式一樣擋得住誤報的 `console.logger()` / `console.logging()`。
#
# password / secret 刻意「不」加任何限定：`passwordless`、`secretary` 這類確實會誤報，
# 但這兩個字出現在 diff 裡本來就值得看一眼——誤報只花一次目視，漏報是外洩。
#
# ★ 連線字串／查詢字串類的「鍵=值」寫法要排除程式碼裡的同名識別字（2026-10-16 使用回饋）：
#   整串用 grep -i 比對，原本的 `User ?Id[[:space:]]*=` 會中 React 的 `userId={...}`、JS 的 `userId = x`，
#   同型的 `Pwd[[:space:]]*=`（`newPwd={x}`）與 `token=`（`accessToken={t}`）也一樣——React 專案幾乎每次都中，
#   只能加 --allow-sensitive，等於整條檢查失效。改成只認連線字串的形狀：
#   - `User Id=`：帶空白的寫法不可能是識別字，照舊
#   - `UserId=`：只認連線字串裡的位置——前面緊接 ; 或引號或反引號（中間可有空白），或是行首的 ini 寫法
#     `UserId=abc`。擋得到 `"…;UserId=x"`、`` `…;UserId=x` ``；不中 `<Avatar userId={x} />`、`<Avatar userId="abc" />`、
#     `const userId = 5;`、`this.userId=userId;`（第二輪對抗審查實跑：只看「等號後面」的寫法會同時漏抓反引號／空白，
#     又誤擋 this.userId=）。值不能以 { $ % 開頭、也不能是引號包住的 $，否則會中 f"userId={uid}"、`userId=${id}&…`、
#     "userId=%s"、shell 的 `userId="$1"`（第三輪對抗審查、commit 前第 4 輪實跑）。行首寫死的 `userId="abc"` 照擋（ini 寫法）。
#   - `Pwd=`：程式碼檔四支，前面接什麼都算（`DB_PWD=`、`spring.datasource.pwd=`、`export DB_PWD=`、縮排的 `  Pwd=`）——
#     .env／.properties／ini 的明文密碼最常長這樣（commit 前第 3 輪兩軌審查：只認連線字串位置會全部漏抓）
#     1. 值是引號／反引號包住的字面值（等號兩側可有空白）：引號後第一個字不是空白、引號、$ 就擋，後面接什麼不管——
#        擋 `pwd = "Secr3t"`、`pwd = "Prod(2026)"`、`` const Pwd = `x`; ``、`<F pwd="x"/>`、`DB_PWD="Secr3t" # (x)`；
#        不中 `pwd = ""`、`local pwd="$1"`、`PWD="$(pwd)"`、`pwd == "x"`
#     2. 等號兩側沒有空白（shell、.env、連線字串的寫法）：值的第一個字不是空白 { $ ( ; 引號 / = > 就擋，後面接什麼不管——
#        擋 `DB_PWD=Prod(2026)`、`DB_PWD=Secr3t  # 正式機 (勿外流)`、`connect('Server=x;Pwd=Secr3t', f(1))`；
#        不中 `PWD=/tmp`、`pwd=$(pwd)`、`echo "Pwd=${pwd}"`、`newPwd={x}`、`pwd==x`
#        等號兩側有空白、值又沒加引號的（`pwd = getPwd()`、`showPwd = !showPwd`、`this.pwd = pwd;`）在程式碼裡一定是運算式，
#        不擋；設定檔裡的 `Pwd = Secr3t` 由下面的 CONFIG_PWD_PATTERN 擋（commit 前第 4 輪：原本用「整行沒有 ( 」分辨
#        函式呼叫，密碼或行尾註解有括號就漏，又誤擋布林切換）
#     3. 連線字串位置（前面緊接 ; 可有空白，或緊接引號）：值以 { 開頭時大括號裡要有英數 _ . 以外的字才擋
#        （ODBC `Pwd={p@ss;w}`），f"…;Pwd={pwd}" 這類組字串、JSX `user="a" pwd={pwd}` 不擋
#     4. 行首（可縮排、可加 YAML 清單的 `- `、export、鍵可帶前綴）`DB_PWD={…}`：同 3 的大括號判準，擋 `Pwd = {實際密碼}`、
#        `pwd={"Secr3t"}`、`DB_PWD={Pr0d#2026}`、`  - DB_PWD={Pr0d#2026}`，不中 JSX `pwd={form.pwd}`
#     5. 冒號或 => 後接引號字面值（物件、PHP 陣列）：擋 `{ user: 'sa', pwd: 'Secr3t' }`、`'Pwd' => 'Secr3t'`；
#        三元運算 `ok ? pwd : 'x'`、`process.env.DB_PWD ? process.env.DB_PWD : 'Secr3t'` 也擋：冒號後的字面值就是密碼的
#        預設值，等於寫死（第 19 輪曾放行三元運算，第 20 輪 C 軌實跑指出寫死的預設密碼因此漏抓，已撤回；token 類同）；
#        不中 `showPwd: false`、`pwd: string`、`pwd: ""`（commit 前第 5 輪 C 軌；0.12.0 起就漏）
#     1、2、5 的鍵也收 `_PASS`／`.pass`／`-pass`／`passwd`（`DB_PASS=Secr3t`、`user_pass = "x"`、`--pass=x`）；
#     沒有分隔字元的 `bypass=`、`compass=` 不中；單獨的 `pass=`／`pw=`（前面是邊界）也擋：shell 部署腳本的
#     `pass=Prod2026!`、`pw='…'`、`--pw=…`（第 21 輪 Codex），`pw=$(read_pw)`、`pass=$PASS`、`pw = getpass()` 不中；
#     無引號的 `pass=`／`pw=` 值要含數字或 ! @ # ^ & + ~ 才擋，且不以 * % ? 開頭——shell 參數解析 `--pass=*)`、Python
#     關鍵字參數 `pw=pw`、log 格式 `pw=%s`、SQL 佔位 `where pw=?` 都不是密碼（第 22 輪 C 軌實跑誤擋）；
#     冒號／=> 寫法 `{ pass: 'hunter2' }`（nodemailer）、`{ pw: '…' }` 也擋；`DB_PW = "…"` 比照 `_pass` 擋（第 22 輪兩軌）；
#     單獨 `pass`／`pw` 的引號值要含數字才擋（Go 的 `pw := "…"` 也算，第 24 輪）：三元式 `ok ? "PASS" : "FAIL"`（字串以 pass 結尾接冒號）、
#     審核狀態對照 `{ pass: '已通過' }`、`pass: "PASS"`、表情符號對照 `{ pass: "✅" }` 都不是密碼（第 23 輪 C 軌實跑誤擋）；
#     已知取捨：純字母的 `pass: 'hunter'` 不擋。`_pass`／`.pass` 的引號值不加這個限定（`DB_PASS="hunter"` 要擋），
#     代價是 `result.pass = "ok"` 會誤擋一次
#     駝峰命名的 `dbPass`／`smtpPw` 另由 CAMEL_PASS_PATTERN 分大小寫比對（見下）
#     已知取捨（實跑確認）：程式碼檔裡大括號中只有英數的 `Pwd = {Secr3t}`、`;Pwd={Secr3t}` 不擋（和 {變數} 分不開；
#     設定檔照擋）；沒空白的 `this.pwd=pwd;`、舊式反引號取值 `` pwd=`pwd` `` 會誤擋一次
#   - `mysql -p密碼`：密碼直接黏在 -p 後面才擋；`-p`（互動輸入）、`-p"$VAR"`、`-P3306`（埠號，-i 比對分不開大小寫，
#     所以數字開頭不擋）不擋（commit 前第 4 輪 C 軌）
#   - `token=`：後面接 { 的是 JSX 屬性，不算；`?token=abc`、`token="..."` 照擋；
#     `token={"…"}`、`` token={`abc`} `` 大括號裡直接放字串常數也擋（commit 前 Codex 審查）；反引號字串裡有 `${` 就不擋
#     （`` token={`${t}`} ``、`` token={`Token ${t}`} ``）。`` `Bearer ${t}` `` 仍會被 bearer 關鍵字擋，那是刻意的
#     已知取捨：JSX 把字串常數換行寫（`token={` 下一行才是 `` `sk_live_…` ``）不擋——逐行比對做不到，屬極端情境
SENSITIVE_PATTERN='password|secret|api_key|bearer|(token|api[_-]?key|access[_-]?key|private[_-]?key)=\{[[:space:]]*(["'\'']|`[^`$]*`)|ConnectionString|console\.log([^A-Za-z0-9_]|$)|Console\.WriteLine|System\.out\.print|debugger;|TODO:[[:space:]]*remove([^A-Za-z0-9]|$)|FIXME([^A-Za-z0-9]|$)|XXX([^A-Za-z0-9]|$)|//[[:space:]]*DEBUG([^A-Za-z0-9]|$)|//[[:space:]]*TEMP([^A-Za-z0-9]|$)|eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|sqlcmd .{0,120}-P ([^[:space:]$%"'\''`]|["'\''][^$%"'\''])|mysql(dump|admin)?[[:space:]].{0,120}[[:space:]]-p([^[:space:]0-9$"'\''`-]|["'\''][^$"'\''])|(Pwd|[_.-]pass|[_.-]pw|passwd)\??[[:space:]]*(:[^=;,?"'\''`(){}]*\??[[:space:]]*|[[:space:]][A-Za-z_][A-Za-z0-9_.]*[[:space:]]*|\{[^}]*\}[[:space:]]*|["'\''`]?[[:space:]]*\][[:space:]]*(\|\||\?\?)?|\[[0-9]*\][[:space:]]*|[[:space:]]+[Aa][Ss][[:space:]]+[A-Za-z_][A-Za-z0-9_.]*[[:space:]]*)?=[[:space:]]*["'\''`][^[:space:]"'\''`$]|(Pwd|[_.-]pass|[_.-]pw|passwd)=[^[:space:]{$(;"'\''`/=<>*%?]|(^|[^A-Za-z0-9_])(db|database|smtp|mail|email|ftp|sftp|ssh|redis|mysql|mariadb|pg|postgres|mongo|mongodb|ldap|admin|root|user|sa|proxy|rabbitmq|amqp|mq|sql|mssql|oracle|jdbc|imap|pop3?|vnc|rdp|wifi|svc|service|sys|master|login)?(pass|pw)=[^[:space:]{$(;"'\''`/=<>*%?,)][^[:space:],()]*[0-9!@#^&+~]|(^|[^A-Za-z0-9_])(db|database|smtp|mail|email|ftp|sftp|ssh|redis|mysql|mariadb|pg|postgres|mongo|mongodb|ldap|admin|root|user|sa|proxy|rabbitmq|amqp|mq|sql|mssql|oracle|jdbc|imap|pop3?|vnc|rdp|wifi|svc|service|sys|master|login)?(pass|pw)\??[[:space:]]*(:[^=;,?"'\''`(){}]*\??[[:space:]]*|[[:space:]][A-Za-z_][A-Za-z0-9_.]*[[:space:]]*|\{[^}]*\}[[:space:]]*|["'\''`]?[[:space:]]*\][[:space:]]*(\|\||\?\?)?|\[[0-9]*\][[:space:]]*|[[:space:]]+[Aa][Ss][[:space:]]+[A-Za-z_][A-Za-z0-9_.]*[[:space:]]*)?=[[:space:]]*["'\''`]([0-9]|[^[:space:]"'\''`$][^"'\''`]*[0-9])|(^|[^A-Za-z0-9_])(db|database|smtp|mail|email|ftp|sftp|ssh|redis|mysql|mariadb|pg|postgres|mongo|mongodb|ldap|admin|root|user|sa|proxy|rabbitmq|amqp|mq|sql|mssql|oracle|jdbc|imap|pop3?|vnc|rdp|wifi|svc|service|sys|master|login)?(pass|pw)["'\''`]?[[:space:]]*(:|=>)[[:space:]]*["'\''`]([0-9]|[^[:space:]"'\''`${][^"'\''`]*[0-9])|(^|[^A-Za-z0-9_])(([A-Za-z_][A-Za-z0-9_.:]*|\$[A-Za-z_][A-Za-z0-9_]*(->[A-Za-z_][A-Za-z0-9_]*)*)(<[^<>()]*>)?[[:space:]]*\(([[:space:]]*["'\''`][^"'\''`]*["'\''`][[:space:]]*,)?|getattr[[:space:]]*\([^,()]*,)[[:space:]]*["'\''`]([A-Za-z0-9_.:-]*pwd|([A-Za-z0-9_.:-]*[_.:-])?(db|database|smtp|mail|email|ftp|sftp|ssh|redis|mysql|mariadb|pg|postgres|mongo|mongodb|ldap|admin|root|user|sa|proxy|rabbitmq|amqp|mq|sql|mssql|oracle|jdbc|imap|pop3?|vnc|rdp|wifi|svc|service|sys|master|login)?(pass|passwd|pw))["'\''`][[:space:]]*(,[[:space:]]*((default|fallback)[[:space:]]*=)?|\)+[[:space:]]*(,|\?\?|\?:|\|\||\{|or[[:space:]]|\.(orelse|or_else|unwrap_or|unwrap_or_else|getorelse)[[:space:]]*\([^"'\''`]*))[[:space:]]*["'\''`]([0-9][^[:space:]"'\''`$]{3,}|[^[:space:]"'\''`$][0-9][^[:space:]"'\''`$]{2,}|[^[:space:]"'\''`$]{2}[0-9][^[:space:]"'\''`$]+|[^[:space:]"'\''`$]{3,}[0-9][^[:space:]"'\''`$]*)["'\''`]|([]A-Za-z0-9_)]\??\.|->|\$env:|\[["'\''`]?:?)([A-Za-z0-9_:]*pwd|([A-Za-z0-9_:]*[_:])?(db|database|smtp|mail|email|ftp|sftp|ssh|redis|mysql|mariadb|pg|postgres|mongo|mongodb|ldap|admin|root|user|sa|proxy|rabbitmq|amqp|mq|sql|mssql|oracle|jdbc|imap|pop3?|vnc|rdp|wifi|svc|service|sys|master|login)?(pass|passwd|pw))(["'\''`]?\])?\)?[[:space:]]*(\?\?|\|\||\?:|or[[:space:]])[[:space:]]*["'\''`]([0-9][^[:space:]"'\''`$]{3,}|[^[:space:]"'\''`$][0-9][^[:space:]"'\''`$]{2,}|[^[:space:]"'\''`$]{2}[0-9][^[:space:]"'\''`$]+|[^[:space:]"'\''`$]{3,}[0-9][^[:space:]"'\''`$]*)["'\''`]|\$\{([A-Za-z0-9_.-]*pwd|([A-Za-z0-9_.-]*[_.-])?(db|database|smtp|mail|email|ftp|sftp|ssh|redis|mysql|mariadb|pg|postgres|mongo|mongodb|ldap|admin|root|user|sa|proxy|rabbitmq|amqp|mq|sql|mssql|oracle|jdbc|imap|pop3?|vnc|rdp|wifi|svc|service|sys|master|login)?(pass|passwd|pw)):(-|=)?[^}[:space:]$:?+=0-9#-][^}[:space:]$]*\}|#[[:space:]]*define[[:space:]]+([A-Za-z0-9_]*pwd|([A-Za-z0-9_]*_)?(db|database|smtp|mail|email|ftp|sftp|ssh|redis|mysql|mariadb|pg|postgres|mongo|mongodb|ldap|admin|root|user|sa|proxy|rabbitmq|amqp|mq|sql|mssql|oracle|jdbc|imap|pop3?|vnc|rdp|wifi|svc|service|sys|master|login)?(pass|passwd|pw))[[:space:]]+(L|u8)?"([0-9]|[^[:space:]"$\\][^"]*[0-9])|#[[:space:]]*define[[:space:]]+[A-Za-z0-9_]*(token|api_?key|access_?key)[[:space:]]+(L|u8)?"([^"$[:space:]]*[A-Za-z][^"$[:space:]]*[0-9][^"[:space:]]*|[^"$[:space:]]*[0-9][^"$[:space:]]*[A-Za-z][^"[:space:]]*|[A-Za-z0-9_+/=.~-]{20,})"|(Pwd|[_.-]pass|[_.-]pw|passwd)["'\''`]?[[:space:]]*(:|=>)[[:space:]]*["'\''`][^[:space:]"'\''`${]|(;[[:space:]]*|["'\''`])Pwd[[:space:]]*=[[:space:]]*([^[:space:];$({]|\{[^}]*[^A-Za-z0-9_.}][^}]*\})|^[[:space:]]*(-[[:space:]]+)?(export[[:space:]]+)?[A-Za-z0-9_.]*Pwd[[:space:]]*=[[:space:]]*\{[^}]*[^A-Za-z0-9_.}][^}]*\}|^UserId=([^[:space:]{$%"'\''`]|["'\''`][^$"'\''`])|[;"'\''`][[:space:]]*UserId[[:space:]]*=[[:space:]]*[^[:space:]{$%;"'\''`]|User Id[[:space:]]*=|Data Source[[:space:]]*=|Initial Catalog[[:space:]]*=|[A-Za-z][A-Za-z0-9+.-]*://[^/:@[:space:]"'\''`$]*:[^/@[:space:]"'\''`$<{%]*[0-9!#^&+~*][^/@[:space:]"'\''`$]*@|curl([[:space:]].*)?[[:space:]](-u[[:space:]=]*|--user[[:space:]=]+)["'\''`]?[^[:space:]:"'\''`$-][^[:space:]:"'\''`$]*:[^[:space:]"'\''`$<{%]*[0-9!#^&+~*]|sshpass[[:space:]]+-p[[:space:]]*["'\''`]?[^[:space:]$"'\''`-]|--([A-Za-z0-9-]*-)?(db|database|smtp|mail|email|ftp|sftp|ssh|redis|mysql|mariadb|pg|postgres|mongo|mongodb|ldap|admin|root|user|sa|proxy|rabbitmq|amqp|mq|sql|mssql|oracle|jdbc|imap|pop3?|vnc|rdp|wifi|svc|service|sys|master|login)?(pass|passwd|pwd|pw)[[:space:]]+["'\''`]?([0-9]|[^[:space:]"'\''`$<{%-][^[:space:]"'\''`]*[0-9!#^&+~])|(key|name)[[:space:]]*=[[:space:]]*["'\''`]([A-Za-z0-9_.-]*pwd|([A-Za-z0-9_.-]*[_.-])?(db|database|smtp|mail|email|ftp|sftp|ssh|redis|mysql|mariadb|pg|postgres|mongo|mongodb|ldap|admin|root|user|sa|proxy|rabbitmq|amqp|mq|sql|mssql|oracle|jdbc|imap|pop3?|vnc|rdp|wifi|svc|service|sys|master|login)?(pass|passwd|pw))["'\''`][^>]*[[:space:]]value[[:space:]]*=[[:space:]]*["'\''`][^"'\''`$%{<[:space:]]|[[:space:]]value[[:space:]]*=[[:space:]]*["'\''`][^"'\''`$%{<[:space:]][^"'\''`]*["'\''`][^>]*[[:space:]](key|name)[[:space:]]*=[[:space:]]*["'\''`]([A-Za-z0-9_.-]*pwd|([A-Za-z0-9_.-]*[_.-])?(db|database|smtp|mail|email|ftp|sftp|ssh|redis|mysql|mariadb|pg|postgres|mongo|mongodb|ldap|admin|root|user|sa|proxy|rabbitmq|amqp|mq|sql|mssql|oracle|jdbc|imap|pop3?|vnc|rdp|wifi|svc|service|sys|master|login)?(pass|passwd|pw))["'\''`]|<([A-Za-z0-9_.-]*pwd|([A-Za-z0-9_.-]*[_.-])?(db|database|smtp|mail|email|ftp|sftp|ssh|redis|mysql|mariadb|pg|postgres|mongo|mongodb|ldap|admin|root|user|sa|proxy|rabbitmq|amqp|mq|sql|mssql|oracle|jdbc|imap|pop3?|vnc|rdp|wifi|svc|service|sys|master|login)?(pass|passwd|pw))>([0-9]|[^<[:space:]$%{][^<]*[0-9!#^&+~])[^<]*</|(^|[^A-Za-z0-9_])((set|with)[A-Za-z0-9_]*|(set|with)?(db|database|smtp|mail|email|ftp|sftp|ssh|redis|mysql|mariadb|pg|postgres|mongo|mongodb|ldap|admin|root|user|sa|proxy|rabbitmq|amqp|mq|sql|mssql|oracle|jdbc|imap|pop3?|vnc|rdp|wifi|svc|service|sys|master|login)?)(pass|passwd|pwd|pw)[[:space:]]*\([[:space:]]*["'\''`]([0-9][^[:space:]"'\''`$]{3,}|[^[:space:]"'\''`$][0-9][^[:space:]"'\''`$]{2,}|[^[:space:]"'\''`$]{2}[0-9][^[:space:]"'\''`$]+|[^[:space:]"'\''`$]{3,}[0-9][^[:space:]"'\''`$]*)["'\''`]|identified[[:space:]]+by[[:space:]]+(["'\''`][^"'\''`$[:space:]]|[^"'\''`$:&?[:space:];]*[0-9][^[:space:];]*)|(^|[[:space:]])login([[:space:]]+[^[:space:]]+)*[[:space:]]+-p[[:space:]]*["'\''`]?([0-9]|[^[:space:]$%"'\''`-][^[:space:]"'\''`]*[0-9!#^&+~])|^[[:space:]]*ENV[[:space:]]+([A-Za-z0-9_.-]*pwd|([A-Za-z0-9_.-]*[_.-])?(db|database|smtp|mail|email|ftp|sftp|ssh|redis|mysql|mariadb|pg|postgres|mongo|mongodb|ldap|admin|root|user|sa|proxy|rabbitmq|amqp|mq|sql|mssql|oracle|jdbc|imap|pop3?|vnc|rdp|wifi|svc|service|sys|master|login)?(pass|passwd|pw))[[:space:]]+["'\''`]?[^=[:space:]$"'\''`]'
# 設定檔的密碼鍵另掃一次（只套用在下面這些檔名的新增行）：設定檔裡 `鍵 = 值`、`鍵: 值` 的值本身就是字面值，
# 不會是函式呼叫，所以「值裡有 ( 」「等號兩側有空白」「大括號包住」都照擋——程式碼檔不能這樣判，
# `pwd = getPwd()`、`showPwd = !showPwd` 會全中（commit 前第 4 輪兩軌審查：`DB_PWD=Prod(2026)`、
# `DB_PWD=Secr3t  # 正式機 (勿外流)`、`DB_PWD={Pr0d#2026}`、`db_pwd: "Secr3t"` 在 .env／.properties／yaml 漏抓）。
#   檔名：.env、.env.*、*.env、*.properties、*.ini、*.conf、*.cfg、*.cnf、*.yml、*.yaml、*.toml、*.mk、Makefile、GNUmakefile
#   鍵：名稱以 pwd 結尾（DB_PWD、spring.datasource.pwd、db_pwd），或是 pass／passwd／pw 本身、以 _ . - 接在
#       前綴後面（DB_PASS、REDIS_PASS、db.passwd、DB_PW；不中 BYPASS、COMPASS）（commit 前第 5 輪 Codex：`DB_PASS = …` 漏抓）；
#       可加 export、引號、YAML 清單的 `- `、行首註解符號（# ;）——註解掉的舊密碼一樣是外洩；
#       名稱以 token／api_key／apikey／access_key／private_key 結尾的鍵同樣處理（GITHUB_TOKEN、auth.token、
#       openai_api_key；不中 token_url、max_tokens）（commit 前第 6 輪 Codex：yaml 的 `token: "…"` 漏抓）
#   檔名比對前先轉小寫（`UPPER.ENV`、`App.YML` 也算）
#   值：非空、不以 $ 開頭（${VAR}、$VAR 是引用環境變數）、不是空引號
# 放行（CONFIG_PWD_BENIGN，只濾設定檔這一支的命中）：鍵剛好是 PWD／OLDPWD 且值是 / 開頭的路徑（shell 工作目錄）、
# 值是 null／~／none（yaml 的空值）、true／false／yes／no（布林，`skip_pw: false`）、`{{ … }}`（Ansible／Jinja 樣板引用）、
# `!vault`（ansible-vault 加密值）（commit 前第 6 輪 C 軌實跑）；鍵以 private_key／token 結尾、值是檔案路徑
# （/ ./ ../ ~/ 開頭）。放行只看第一個 = 或 : 後面的值，行尾註解含 `{{`、`: none` 不會讓前面的真密碼過關（第 7 輪 C 軌）。已知取捨：git mv 改名的設定檔逐檔取 diff 時沒有
# rename 偵測，整檔算新增，舊有的密碼行會再報一次（只會多擋、不會漏）
# `token=` 拆出來另掃：值是 await／new／函式呼叫（`accessToken=await refreshToken()`、`token=getToken()`）是程式碼
# 取值，不是寫死的憑證（commit 前第 5 輪 Codex；0.12.0 起就誤擋）。TOKEN_BENIGN 只刪掉命中的那一段再比對
# （見 token_assign_hits），同一行另有寫死的 token 照擋。HTTP header 幾支也放在這裡，讓佔位字放行套得到。
# 值是空的、$ 開頭（`token=`、`token=$T`、`token="${T}"`）也不擋：.env.example 的空白範本、引用環境變數（第 6 輪 C 軌）。
# 鍵也收 apiKey／api-key／access_key／private_key：網址參數 `?apiKey=…` 一樣是寫死（commit 前第 7 輪 Codex）。
# HTTP header `X-Api-Key: …`／`X-Auth-Token: …`／`Api-Key: …`／`Auth-Token: …`／`Authorization: Token …`／`Authorization: Basic …` 由本
# pattern 擋（第 8 輪 Codex：Django REST Framework 的 Token 授權漏抓；第 12 輪 Codex：不帶 X- 的 `Api-Key:` 漏抓——只認
# 帶連字號的寫法，TS 型別 `apiKey: string` 不中；冒號、逗號、中括號賦值三種寫法都認這四個名稱——第 13 輪 Codex）；
# 值是 null／~／none／true／false（yaml 的 `api-key: null`）不擋（第 13 輪 C 軌），read／write 也不擋（GitHub Actions 的
# `id-token: write` 權限設定）；分頁游標 `nextPageToken`／`pageToken`／`cursor_token` 不擋（第 14 輪 Codex；設定檔同），
# page／cursor 前面要是邊界或 next／prev，`HOMEPAGE_TOKEN` 不算（第 15 輪 C 軌）；
# TS 型別註記 `apiKey: string = "…"`、`pwd: string = "…"` 也擋（第 15 輪 Codex）；
# 型別註記允許空白與 | [] <>（`apiKey: string | undefined = "…"`；第 16 輪兩軌），但不跨 , ? ; 引號與括號——
# 跨過逗號會接到下一個參數的預設值，`connect(token: string, baseUrl = "https://…")`、`def f(token: str, model = "gpt-4o")`、
# `{ token: a, version = "v2" }` 全被誤擋（第 17 輪 C 軌實跑，比 0.12.0 退步）；Go 的 `var token string = "…"` 也擋（空白＋型別名）；
# 型別結尾可接一個 ?（Kotlin `val apiKey: String? = "…"`；第 18 輪 Codex）；
# Python 關鍵字參數 `get(url, token=token)` 不擋（第 17 輪 C 軌；0.12.0 起就誤擋）——鍵前面要是 ( 或 ,、值只能是字母 _ .
# 組成的名稱（不含數字）：放寬成「任何識別字接 , 或 )」時，markdown 連結 `(…?token=abc123def)`、log `token=abc123def,`
# 都被放過（第 18 輪 C 軌實跑，比 0.12.0 退步）；
# JSX 大括號包字串常數 `apiKey={"…"}`／`accessKey={"…"}` 跟 `token={"…"}` 一樣擋（第 17 輪 Codex）；
# 設定檔裡 token／api_key 類鍵的值不含數字，且「短於 20 位元組、或中間有空白、或含非 ASCII 字元」就當翻譯文字不擋
# （`token: "Token"`、`invalid_token: "Invalid authentication token."`、`token: "此處輸入存取權杖"`；第 15、16 輪）；
# 程式碼引號值的「20 字以上」只算 token 會用的字元（英數 _ + / = . ~ -），中文字串不會因位元組多被誤擋（第 16 輪 Codex）；程式 API 的逗號寫法 `addHeader("Authorization", "Basic …")`、
# `setRequestProperty("X-Api-Key", "…")` 也擋，但值要有引號（`headers.set("Authorization", token + x)` 是變數，不擋）
# （第 9 輪 Codex）；中括號賦值 `headers['X-Api-Key'] = '…'`、`headers["Authorization"] = "Token …"` 也擋（第 11 輪 C 軌）。
# Authorization 的 scheme 認 Token／Basic／ApiKey／Api-Key／Key／Digest（第 11 輪 Codex：`ApiKey …` 漏抓）；只列這幾個，
# 不放任意字，免得 `Authorization: await getToken()` 被當成 scheme＋值；佔位 `Token changeme`／`Token your-…` 不擋。值以 $ < % 開頭（`$SVC_KEY`、`${SVC_KEY}`、文件佔位 `<your-key>`、Python `'Token %s' % t`）不擋。
# `token=` 的引號後緊接空白或 + ) , ; .（`"?apiKey=" + key`、`"?token="+token` 組網址）不擋（第 8、9 輪 C 軌；0.12.0 起就誤擋）。
# 範本佔位 `<your-token>`、`changeme`、`your-…` 不擋（第 9 輪 C 軌；設定檔同）。
# private_key 的值是檔案路徑（/ ./ ../ ~/ C:\ \\server）不擋，`=`、`:`、`=>` 三種寫法、程式碼與設定檔都一樣（第 8、9 輪兩軌）。
# 已知取捨：沒加引號、剛好以 / 開頭的 base64 token（`GITHUB_TOKEN: /9j4…`）在設定檔會被當成路徑放過——極端情境。
# 有空白或冒號的寫法（`const token = "…"`、`{ token: "…" }`、`apiKey = "…"`）由本 pattern 後兩支擋：引號值要「同時有
# 英文字母與數字」或 20 字以上——真正的 token／金鑰幾乎都符合；`ACCESS_TOKEN = "access_token"`、`CSRF_TOKEN = "X-CSRF-Token"`
# 這類鍵名常數、純數字的 `nextPageToken = "2"` 不擋（commit 前第 6、7 輪：這幾種從 0.12.0 起就漏）。這兩支放在 token 管線
# 而不是 SENSITIVE_PATTERN，是為了讓 TOKEN_BENIGN 的路徑／佔位放行也套得到它們。
TOKEN_ASSIGN_PATTERN='\.[a-z0-9_]*(token|api_?key|access_?key)[[:space:]]*\([[:space:]]*["'\''`]([^"'\''`$[:space:]]*[A-Za-z][^"'\''`$[:space:]]*[0-9][^"'\''`[:space:]]*|[^"'\''`$[:space:]]*[0-9][^"'\''`$[:space:]]*[A-Za-z][^"'\''`[:space:]]*|[A-Za-z0-9_+/=.~-]{20,})["'\''`]|(key|name)[[:space:]]*=[[:space:]]*["'\''`][a-z0-9_.-]*(token|api[_-]?key|access[_-]?key|private[_-]?key)["'\''`][^>]*[[:space:]]value[[:space:]]*=[[:space:]]*["'\''`]([^"'\''`$[:space:]]*[A-Za-z][^"'\''`$[:space:]]*[0-9][^"'\''`[:space:]]*|[^"'\''`$[:space:]]*[0-9][^"'\''`$[:space:]]*[A-Za-z][^"'\''`[:space:]]*|[A-Za-z0-9_+/=.~-]{20,})["'\''`]|[[:space:]]value[[:space:]]*=[[:space:]]*["'\''`]([^"'\''`$[:space:]]*[A-Za-z][^"'\''`$[:space:]]*[0-9][^"'\''`[:space:]]*|[^"'\''`$[:space:]]*[0-9][^"'\''`$[:space:]]*[A-Za-z][^"'\''`[:space:]]*|[A-Za-z0-9_+/=.~-]{20,})["'\''`][^>]*[[:space:]](key|name)[[:space:]]*=[[:space:]]*["'\''`][a-z0-9_.-]*(token|api[_-]?key|access[_-]?key|private[_-]?key)["'\''`]|<[a-z0-9_.-]*(token|api[_-]?key|access[_-]?key|private[_-]?key)>([^"'\''`$[:space:]]*[A-Za-z][^"'\''`$[:space:]]*[0-9][^"'\''`[:space:]]*|[^"'\''`$[:space:]]*[0-9][^"'\''`$[:space:]]*[A-Za-z][^"'\''`[:space:]]*|[A-Za-z0-9_+/=.~-]{20,})</|--[a-z0-9-]*(token|api-key|access-key)[[:space:]]+["'\''`]?([^"'\''`$[:space:]]*[A-Za-z][^"'\''`$[:space:]]*[0-9][^"'\''`[:space:]]*|[^"'\''`$[:space:]]*[0-9][^"'\''`$[:space:]]*[A-Za-z][^"'\''`[:space:]]*|[A-Za-z0-9_+/=.~-]{20,})|^[[:space:]]*env[[:space:]]+[a-z0-9_]*(token|api[_-]?key|access[_-]?key|private[_-]?key)[[:space:]]+["'\''`]?([^"'\''`$[:space:]]*[A-Za-z][^"'\''`$[:space:]]*[0-9][^"'\''`[:space:]]*|[^"'\''`$[:space:]]*[0-9][^"'\''`$[:space:]]*[A-Za-z][^"'\''`[:space:]]*|[A-Za-z0-9_+/=.~-]{20,})|(^|[^a-z0-9_])(([a-z_][a-z0-9_.:]*|\$[a-z_][a-z0-9_]*(->[a-z_][a-z0-9_]*)*)(<[^<>()]*>)?[[:space:]]*\(([[:space:]]*["'\''`][^"'\''`]*["'\''`][[:space:]]*,)?|getattr[[:space:]]*\([^,()]*,)[[:space:]]*["'\''`][a-z0-9_.:-]*(token|api[_-]?key|access[_-]?key|private[_-]?key)["'\''`][[:space:]]*(,[[:space:]]*((default|fallback)[[:space:]]*=)?|\)+[[:space:]]*(,|\?\?|\?:|\|\||\{|or[[:space:]]|\.(orelse|or_else|unwrap_or|unwrap_or_else|getorelse)[[:space:]]*\([^"'\''`]*))[[:space:]]*["'\''`]([^"'\''`$[:space:]]*[A-Za-z][^"'\''`$[:space:]]*[0-9][^"'\''`[:space:]]*|[^"'\''`$[:space:]]*[0-9][^"'\''`$[:space:]]*[A-Za-z][^"'\''`[:space:]]*|[A-Za-z0-9_+/=.~-]{20,})["'\''`]|([]a-z0-9_)]\??\.|->|\$env:|\[["'\''`]?:?)[a-z0-9_.:-]*(token|api[_-]?key|access[_-]?key|private[_-]?key)(["'\''`]?\])?\)?[[:space:]]*(\?\?|\|\||\?:|or[[:space:]])[[:space:]]*["'\''`]([^"'\''`$[:space:]]*[A-Za-z][^"'\''`$[:space:]]*[0-9][^"'\''`[:space:]]*|[^"'\''`$[:space:]]*[0-9][^"'\''`$[:space:]]*[A-Za-z][^"'\''`[:space:]]*|[A-Za-z0-9_+/=.~-]{20,})["'\''`]|\$\{[a-z0-9_.-]*(token|api[_-]?key|access[_-]?key|private[_-]?key):(-|=)?([a-z_][^}[:space:]$]*[0-9][^}[:space:]]*|[0-9][^}[:space:]$]*[a-z][^}[:space:]]*|[a-z0-9_][a-z0-9_+/=.~-]{19,})\}|(token|api[_-]?key|access[_-]?key|private[_-]?key)=([^{$[:space:]"'\''`<%]|["'\''`][^$"'\''`[:space:]+),;.<%])|(token|api[_-]?key|access[_-]?key|private[_-]?key)[[:space:]]*(:[^=;,?"'\''`(){}]*\??[[:space:]]*|[[:space:]][a-z_][a-z0-9_.]*[[:space:]]*|\{[^}]*\}[[:space:]]*|["'\''`]?[[:space:]]*\][[:space:]]*(\|\||\?\?)?|\[[0-9]*\][[:space:]]*|[[:space:]]+[Aa][Ss][[:space:]]+[A-Za-z_][A-Za-z0-9_.]*[[:space:]]*)?=[[:space:]]*["'\''`]([^"'\''`$[:space:]]*[A-Za-z][^"'\''`$[:space:]]*[0-9][^"'\''`[:space:]]*|[^"'\''`$[:space:]]*[0-9][^"'\''`$[:space:]]*[A-Za-z][^"'\''`[:space:]]*|[A-Za-z0-9_+/=.~-]{20,})["'\''`]|(token|api[_-]?key|access[_-]?key|private[_-]?key)["'\''`]?[[:space:]]*(:|=>)[[:space:]]*["'\''`]([^"'\''`$[:space:]]*[A-Za-z][^"'\''`$[:space:]]*[0-9][^"'\''`[:space:]]*|[^"'\''`$[:space:]]*[0-9][^"'\''`$[:space:]]*[A-Za-z][^"'\''`[:space:]]*|[A-Za-z0-9_+/=.~-]{20,})["'\''`]|(x-(api|auth)[_-]?(key|token)|(api|auth)-(key|token))[[:space:]]*:[[:space:]]*["'\''`]?[^[:space:]"'\''`${<%]|(x-(api|auth)[_-]?(key|token)|(api|auth)-(key|token))["'\''`][[:space:]]*(,|\][[:space:]]*=)[[:space:]]*["'\''`][^[:space:]"'\''`${<%]|authorization["'\''`]?[[:space:]]*[:=][[:space:]]*["'\''`]?(token|basic|api[_-]?key|key|digest)[[:space:]]+[^[:space:]"'\''`${<%]|authorization["'\''`][[:space:]]*(,|\][[:space:]]*=)[[:space:]]*["'\''`](token|basic|api[_-]?key|key|digest)[[:space:]]+[^[:space:]"'\''`${<%]'
TOKEN_BENIGN='(token|api[_-]?key|access[_-]?key|private[_-]?key)=(await[[:space:]]|new[[:space:]]|[A-Za-z_$][A-Za-z0-9_$.]*\()|[(,][[:space:]]*[a-z_]*(token|api[_-]?key|access[_-]?key|private[_-]?key)=[a-z_][a-z_.]*[[:space:]]*[,)]|private[_-]?key["'\''`]?[[:space:]]*(=|:|=>|,)[[:space:]]*["'\''`]?(\.{0,2}/|~/|[A-Za-z]:[\\/]|\\\\)[^[:space:]"'\''`,;)}&]*|(token|api[_-]?key|access[_-]?key|private[_-]?key)["'\''`]?[[:space:]]*(=|:|=>|,|\][[:space:]]*=)[[:space:]]*["'\''`]?(changeme|change_me|your[_-])[^[:space:]"'\''`,;)}&]*|(token|api[_-]?key|access[_-]?key|private[_-]?key)["'\''`]?[[:space:]]*(=|:)[[:space:]]*(null|~|none|true|false|read|write)([[:space:]].*)?$|(^|[^a-z]|next|prev)(page|cursor)[_-]?token["'\''`]?[[:space:]]*(=|:|=>|,|\][[:space:]]*=)[[:space:]]*["'\''`]?[^[:space:]"'\''`,;)}&]*|authorization["'\''`]?[[:space:]]*(=|:|,|\][[:space:]]*=)[[:space:]]*["'\''`]?[a-z-]+[[:space:]]+(changeme|change_me|your[_-])[^[:space:]"'\''`,;)}&]*'
# 駝峰命名的密碼鍵（第 23 輪 Codex：`const dbPass = "Prod2026!";`、yaml 的 `dbPass: Prod2026!` 漏抓）：上面幾支用 grep -i，
# 分不出 `dbPass` 和 `compass`／`bypass`，所以另外分大小寫比：小寫字母或數字後面緊接 Pass／PASS／Pw／PW，
# 或大寫字母後面緊接 Pass／Pw（Go／.NET 的縮寫 `DBPass`、`SMTPPass`，第 24 輪兩軌）才算鍵；`BYPASS` 全大寫不中。
# Go 的短宣告 `dbPass := "…"` 也算（第 24 輪 C 軌）；Go 帶型別 `var dbPass string = "…"`、C# 自動屬性
# `SmtpPass { get; set; } = "…"` 也算（第 25 輪 C 軌；單獨 pass／pw、_pass／Pwd、token 類同樣補上這兩種寫法）。
# 全大寫無分隔的 `DBPASS=`、`SMTPPASS=`（第 25 輪兩軌）分不出 `BYPASS`，所以只認常見服務名前綴
# （db／smtp／mail／ftp／ssh／redis／mysql／pg／mongo／ldap／admin／root／user……）直接接 pass／pw，
# 程式碼檔併入單獨 pass／pw 那三支、設定檔併入 CONFIG_PWD_PATTERN 的鍵。已知取捨：清單外的前綴（`XYZPASS=`）不擋；
# 設定檔大寫縮寫鍵的非密碼值誤擋（`UIPass: 2`）；Go 多重賦值 `user, pass := "admin", "x1"` 不擋。
# 第 26 輪 C 軌：單獨 pass／pw 的 = 支補冒號型別（TS／Kotlin／Swift／Python／Rust 的 `pw: string = "…"`、`pass: &str = "…"`），
# 駝峰鍵的型別支改成跟 _pass 同一段（收 `&str`）；三支都收 TS 選填欄位 `pass?: string = "…"`。
# 鍵當字串參數、值是下一個參數（`define('DB_PASS', '…')`、`os.getenv("DB_PASS", "…")`）也擋：寫死的預設值等於寫死。
# 第 27 輪 C 軌：只認取設定值的呼叫（define／getenv／get／getProperty／getString／setdefault／env／fetch），值要 4 字以上
# 且含數字——測試與 CI 的 `assert(…, "pass", "case 1")`、`push(["pass", "case 3"])`、`["pw", "pw2"]`、旗標
# `getenv("SECOND_PASS", "1")` 原本會誤擋；token 類同樣只認這幾個呼叫，值判準照 token（`setItem("token", "v1abc")` 不擋）。
# 中括號下標賦值 `$cfg['db_pass'] = '…'`、`os.environ["DB_PASS"] = "…"`、`ENV["DB_PASS"] ||= "…"`、`headers["token"] = "…"` 也擋；
# C／Arduino 的 `#define WIFI_PASS "…"`、`#define API_TOKEN "…"`（值要用雙引號）也擋（第 27 輪 C 軌）。
# 一行式條件句 `case PASS: color = "#0f0"`、`if pw: msg = "Step 1"` 的冒號不當型別註記，見 COND_COLON_PATTERN。
# 已知取捨：`cfg.pass ??= "def1"` 不擋；連線 URI 內嵌密碼 `postgres://admin:Secr3t1@db/app` 不在鍵名比對範圍。
# 第 28 輪兩軌：Ruby symbol 下標 `cfg[:db_pass] = "…"`、`headers[:token] = "…"` 也擋（中括號支的引號改成可省，
# 代價是變數當下標 `arr[pass] = "x1"` 誤擋）；取設定值後接預設值的運算子也算：.NET `GetEnvironmentVariable("DB_PASS") ?? "…"`、
# PHP `getenv('DB_PASS') ?: '…'`、Ruby `ENV.fetch("DB_PASS") { "…" }`、Python `os.getenv("X") or "…"`、
# Node `process.env.DB_PASS || "…"`、Spring `${DB_PASS:Secr3t1}`（值非空就擋）。#define 的值照程式碼的判準：密碼族要含數字、
# 開頭不是跳脫字元（`#define PASS "\033[32mPASS\033[0m"`、`#define TEST_PASS "ok"` 不擋），token 類照 token 判準
# （`#define CSRF_TOKEN "csrftoken"` 不擋；這支含 #，所以留在只走 grep 的 SENSITIVE_PATTERN，不放進 TOKEN_ASSIGN_PATTERN）。已知取捨：泛用 `get` 的字典取值 `results.get("pass", "n/a1")`
# 誤擋；中括號下標的測試資料值含數字誤擋（`stats["pass"] = "3/5"`）；純字母的 `#define WIFI_PASS "hunter"` 不擋。
# 第 30 輪：`${KEY:值}` 的值不能以 - = 之外的 ? + 數字開頭、`:-`／`:=` 後要有值——shell 參數展開 `${DB_PASS:-}`、
# `${X:?訊息}`、`${X:+set}`、`${X:0:3}` 不是預設密碼（C 軌實跑：`set -u` 腳本與 docker-compose 每次都被擋）；
# `${DB_PASS:-Secr3t1}` 照擋。中括號取環境變數／設定後接預設值也擋：`ENV["DB_PASS"] || "…"`、`$_ENV['DB_PASS'] ?? '…'`、
# `config["DB_PASS"] ?? "…"`、`process.env["DB_PASS"] || "…"`、`os.environ["DB_PASS"] or "…"`（兩軌）；呼叫清單補 getOrDefault。
# 已知取捨：Python 單行條件裡有除號（`if a / b >= PASS: x = "Level 1"`）誤擋；Spring 布林旗標 `${feature.pass:false}`、
# `#define TEST_PASS "Test 1"` 誤擋；`${DB_PASS:-1234abcd}`（預設值數字開頭）與 Rust `unwrap_or`、Java `orElse` 不擋。
# 第 31 輪 C 軌：點號讀設定物件接預設值也擋（`config.db_pass ?? "…"`、nodemailer `pass: opts.pass || "…"`、
# Django `settings.DB_PASS or "…"`）——原本只認 `env.`，同一個鍵換中括號會擋、換點號不擋；呼叫清單補 Laravel `config(…)`
# 與 Django `getattr(settings, "DB_PASS", "…")`。`${KEY:值}` 的密碼族值不以 # 開頭（Spring `${smtp.pass:#{null}}` 不擋）；
# token 族的值照 token 判準（`${HF_TOKEN:-dummy}`、`:-changeme`、`:-none` 不擋）。中括號字元集要把 ] 放第一個
# （`[]A-Za-z0-9_)]`）：POSIX 字元集裡的 `\]` 不是跳脫，會提早關掉字元集（本輪先寫錯，點號支整條失效，實跑抓到）。
# 已知取捨：`${DB_PASS-x}`（不帶冒號）不擋；一般字典 `results["pass"] || "100%"`、`x.pass || "N/A1"` 誤擋；
# 中括號／點號的 page_token 不放行。assert_patterns_valid 只在 GNU grep 實測過，BSD grep 的行為是推論。
# 第 32 輪兩軌：選用鏈與 PHP 箭頭取屬性也算（`config?.smtp?.pass ?? "…"`、`$this->config->db_pass ?? '…'`），
# 鍵後可接一個右括號（`(process.env.DB_PASS) || "…"`）；取設定值的呼叫認關鍵字參數 `default=`／`fallback=`
# （python-decouple `config("DB_PASS", default="…")`、django-environ `env(…, default=…)`），並可先跳過一個引號參數
# （configparser `parser.get("database", "DB_PASS", fallback="…")`）；呼叫名前要是字邊界（`widget("pass", "Step1")`、
# `budget("db_pass", …)` 不擋）。token 類同步。色碼值不擋，見 COLOR_LITERAL_PATTERN。
# 已知取捨：Spring 預設值剛好以 # 開頭（`${smtp.pass:#Secr3t1}`）不擋。
# 第 33 輪起改用涵蓋矩陣（tests/test_feedback_0_13.sh 的 PW280：語言／框架 × 寫法的固定清單，矩陣內漏抓或誤擋才算一般問題）。
# 這輪依矩陣補齊：URI 內嵌密碼 `scheme://user:密碼@host`（密碼段含數字或符號、不以 $ { < % 開頭）、`curl -u 帳號:密碼`、
# `sshpass -p 密碼`、空白分隔的 CLI 旗標 `--db-pass 值`／`--api-token 值`、XML `<add key="DbPass" value="…">` 與 `<dbPass>…</dbPass>`、
# setter／builder `.setDbPass("…")`、`.pass("…")`、`.setApiToken("…")`、SQL `IDENTIFIED BY '…'`、Dockerfile 舊式 `ENV KEY 值`、
# 寫入呼叫 `os.Setenv`／`SetEnvironmentVariable`／`setProperty`／`put`／`set`、Rust `env::var(…).unwrap_or("…")`、
# Java `.orElse("…")`、Go `cmp.Or(os.Getenv(…), "…")`、.NET `config["Db:Pass"] ?? "…"`、C 陣列 `char db_pass[] = "…"`、
# VB `Dim dbPass As String = "…"`。無引號值以 < 開頭不擋（`DB_PASS=<your-pass>` 是佔位）。
# 矩陣外的已知取捨：`localStorage.setItem("api_token", "…")` 不擋（第 27 輪判定瀏覽器存放 token 不算寫死）；
# 泛用 `map.put("pass", "Step1")`、`cache.set("token", "abc123def")`、`t.pass("step1")` 這類值含數字的會誤擋；
# 註解裡的 `sshpass -p X` 會擋；docker 的 `-u uid:gid` 只在 curl 指令裡才當帳密。
# 第 34 輪（同類重複閘判定「設定讀取寫法」連續冒新案例，改架構）：取設定值的函式名清單拿掉，改成通用呼叫形狀——
# 任何呼叫（含 `obj.method`、`ns::fn`、`$obj->m`、泛型 `<T>`）第一個或第二個引號參數是密碼／token 類鍵，後接含數字的引號值
# （或 `default=`／`fallback=`、`)` 後的 `??`／`.orElse(`）就擋，涵蓋 `env::set_var`、`dict.Add`、`os.putenv`、`env.str`、
# `GetValue<string>`、`getOrElse` 這類不再逐一列名。字串包裝在比對前統一還原（LITERAL_NORMALIZE_SED）。builder 方法名
# 以 token／apiKey／accessKey 結尾就算（`.apiKey("…")`）；變數或方法名本身是密碼鍵後接 ("值") 也算（`std::string dbPass("…")`）。
# 另補：無引號 SQL 密碼（要含數字）、`login … -p 值`、`curl -uX`、XML 屬性任意順序與 `name=`；`sqlcmd -P $變數` 與
# GitHub Actions `${{ secrets.X }}` 不再誤擋。已知取捨：通用呼叫形狀讓 `widget("pass", "Step1")`、
# `localStorage.setItem("token", "v1abc")` 這類值含數字的呼叫會擋；`--rearchitect` 只檢查文字有提到類別（自律部分）。
# 無引號值裡不能有 (（`userpass=check_user(u1)` 是函式呼叫）。已知取捨：VB `Dim dbPass As String = "…"` 不擋；
# 設定檔加前綴的鍵非密碼值誤擋（`userpass: required`、`pgpass: ~/.pgpass`）。
# 值的判準同單獨的 pass／pw：引號值要含數字，無引號值要含數字或 ! @ # ^ & + ~；`firstPass = "abc"`、`isPass: 'ok'`、
# 提示文字 `{ examPass: "Congratulations!" }`、快捷鍵 `togglePw: "Ctrl+Shift+P"` 不擋（第 24 輪 C 軌：引號值只含符號原本會誤擋）。
# 已知取捨：值含數字的駝峰鍵誤擋（`firstPass = "round1"`）；純字母／符號的引號密碼不擋（`dbPass = "P@ss!word"`）；
# 設定檔的 i18n 駝峰鍵 `resetPass: 重設密碼` 誤擋（同 `pwd: '密碼'`）。
# dbPwd／dbPasswd／dbPassword 已由上面不分大小寫的 Pwd／passwd／password 擋，這裡不重複。
CAMEL_PASS_PATTERN='([a-z0-9](Pass|PASS|Pw|PW)|[A-Z](Pass|Pw))(=[^[:space:]{$(;"'\''`/=<>*%?,)][^[:space:],()]*[0-9!@#^&+~]|\??[[:space:]]*(:[^=;,?"'\''`(){}]*\??[[:space:]]*|[[:space:]][A-Za-z_][A-Za-z0-9_.]*[[:space:]]*|\{[^}]*\}[[:space:]]*|["'\''`]?[[:space:]]*\][[:space:]]*(\|\||\?\?)?|\[[0-9]*\][[:space:]]*|[[:space:]]+[Aa][Ss][[:space:]]+[A-Za-z_][A-Za-z0-9_.]*[[:space:]]*)?=[[:space:]]*["'\''`]([0-9]|[^[:space:]"'\''`$][^"'\''`]*[0-9])|["'\''`]?[[:space:]]*(:|=>)[[:space:]]*["'\''`]([0-9]|[^[:space:]"'\''`${][^"'\''`]*[0-9]))'
# 設定檔版：鍵以駝峰 Pass／Pw 結尾，值的判準同 CONFIG_PWD_PATTERN（字面值都算），放行同 CONFIG_PWD_BENIGN。
CONFIG_CAMEL_PASS_PATTERN='^[[:space:]]*([#;]+[[:space:]]*)?(-[[:space:]]+)?(export[[:space:]]+)?["'\'']?[A-Za-z0-9_.-]*([a-z0-9](Pass|PASS|Pw|PW)|[A-Z](Pass|Pw))["'\'']?[[:space:]]*(=|:=|\?=|:)[[:space:]]*["'\''`]?[^[:space:]$"'\''`#]'
# 一行式條件句的冒號（第 27 輪 C 軌）：`case PASS: color = "#0f0"`、`if pw: msg = "Step 1"`、`case Status.PASS: label = "OK"`
# 這類寫法裡，鍵後面的冒號是條件結尾，不是型別註記；型別支會越過它吃到後面別的變數的 = 而誤擋。
# 比對前把行首（或 ; { } : 之後）`case／if／elif／while／for／with／else if …:` 結尾的那個冒號換成 \001，
# 條件本身與冒號後面的敘述照常比對（`if x: pw = "Secr3t1"` 照擋，`password` 等關鍵字也還在）。條件裡有引號就不換
# （`if x == "a:b":` 這類不動）。命中後印的是原本那一行。sed 用 # 當分隔字元，這條 pattern 不可含 #。
# 條件裡有 { } ; / 也不換（第 28 輪 C 軌）：大括號語言的 `if (x) { pw: "Secr3t1" }`、`if err != nil { return Config{Pass: "…"} }`
# 裡第一個冒號是物件鍵，`if (debug) dump(x); // TODO: remove` 的冒號是註解標記，換掉會漏抓。
COND_COLON_PATTERN='(^|[;{}:])([[:space:]]*([Cc]ase|[Ii]f|[Ee]lif|[Ww]hile|[Ff]or|[Ww]ith|[Ee]lse[[:space:]]+[Ii]f)[[:space:]][^:"'\''`{};/]*):'
COND_COLON_MARK=$'\001'
# 字面值正規化（第 34 輪起）：比對前把各語言的字串包裝還原成普通引號，鍵值規則只要認一種引號形狀——
# 字串建構式 `String::from("…")`／`new String("…")`／`String("…")`／`str("…")`／`[]byte("…")`、前綴 `@"…"`／`$"…"`／`r"…"`／
# `b"…"`／`f"…"`／`u"…"`／`s"…"`、Rust `r#"…"#`、三引號 `"""…"""`；GitHub Actions 的 `${{ secrets.X }}` 換成 civar（引用不是寫死，
# 原本被 secret 關鍵字整行擋）。起因：第 33 輪 C 軌一次報出十幾種包裝寫法，逐種補收斂不了，改在比對前統一。
# 命中後印的仍是原本那一行。sed 用 % 當分隔字元，這條不可含 %。
LITERAL_NORMALIZE_SED='s%\$\{\{[[:space:]]*secrets\.[A-Za-z0-9_]+[[:space:]]*\}\}%civar%g; s%(^|[^A-Za-z0-9_.])([Ss]tring::from|[Nn]ew[[:space:]]+[Ss]tring|[Ss]tring|str|\[\]byte)[[:space:]]*\((["'\''`])%\1\3%g; s%(^|[^A-Za-z0-9_])r#+"%\1"%g; s%(^|[^A-Za-z0-9_"'\''`])(@\$?|\$@?|[bBfFrRuUsS]{1,2})(["'\''`])%\1\3%g; s%"""%"%g'
# 色碼字面值（第 32 輪 C 軌）：狀態色表 `theme.pass || "#00ff00"`、`{ pass: "#22c55e" }`、設計 token
# `theme.token ?? "#0f0"` 的值是 3／4／6／8 位十六進位色碼，比對前換成不含數字的 color，不當密碼或 token。
# 已知取捨：剛好長得像色碼的密碼（`pass = "#a1b2c3"`）不擋。sed 用 @ 當分隔字元，這條 pattern 不可含 @。
COLOR_LITERAL_PATTERN='(["'\''`])#([0-9A-Fa-f]{3,4}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})(["'\''`])'
CONFIG_FILE_REGEX='(^|/)(\.env(\.[^/]*)?|[^/]*\.(env|properties|ini|conf|cfg|cnf|ya?ml|toml|mk)|makefile|gnumakefile)$'
CONFIG_PWD_PATTERN='^[[:space:]]*([#;]+[[:space:]]*)?(-[[:space:]]+)?(export[[:space:]]+)?["'\'']?([A-Za-z0-9_.-]*pwd|([A-Za-z0-9_.-]*[_.-])?(db|database|smtp|mail|email|ftp|sftp|ssh|redis|mysql|mariadb|pg|postgres|mongo|mongodb|ldap|admin|root|user|sa|proxy|rabbitmq|amqp|mq|sql|mssql|oracle|jdbc|imap|pop3?|vnc|rdp|wifi|svc|service|sys|master|login)?(pass|passwd|pw)|[A-Za-z0-9_.-]*(token|api[_-]?key|access[_-]?key|private[_-]?key))["'\'']?[[:space:]]*(=|:=|\?=|:)[[:space:]]*["'\''`]?[^[:space:]$"'\''`#]'
CONFIG_PWD_BENIGN='^[[:space:]]*([#;]+[[:space:]]*)?(-[[:space:]]+)?(export[[:space:]]+)?((old)?pwd["'\'']?[[:space:]]*(=|:=|\?=|:)[[:space:]]*["'\'']?/|[A-Za-z0-9_.-]*(private[_-]?key|token)["'\'']?[[:space:]]*(=|:=|\?=|:)[[:space:]]*["'\'']?(\.{0,2}/|~/|[A-Za-z]:[\\/]|\\\\)|["'\'']?([A-Za-z0-9_.-]*[_.-])?(next|prev)?[_-]?(page|cursor)[_-]?token["'\'']?[[:space:]]*(=|:=|\?=|:)|["'\'']?[A-Za-z0-9_.-]*(token|api[_-]?key|access[_-]?key)["'\'']?[[:space:]]*(=|:=|\?=|:)[[:space:]]*(["'\'']?[^0-9"'\''#[:space:]][^0-9"'\''#]{0,18}|["'\'']?[^0-9"'\''#]*[^[:space:]"'\''#0-9][[:space:]]+[^[:space:]"'\''#0-9][^0-9"'\''#]*|["'\'']?[^0-9"'\''#]*[^[:print:][:space:][:cntrl:]][^0-9"'\''#]*)["'\'']?[[:space:]]*$|["'\'']?[A-Za-z0-9_.-]*["'\'']?[[:space:]]*(=|:=|\?=|:)[[:space:]]*((null|~|none|true|false|yes|no|read|write)[[:space:]]*(#.*)?$|["'\'']?\{\{|!vault|["'\'']?(<|changeme|change_me|your[_-])))'
# AI 痕跡 pattern：註解引用「維護者手上沒有的文件」＝ 交付物洩漏 AI 參與（公司禁止揭露）。
# 掃的是新增行，既有痕跡不重複告警；.md 不掃（文件引用文件很正常）。
# 三段分別對應三種漏法（實戰：單一判準必漏——刪掉「CLAUDE.md §8.2」後，
# 同段落下一行的裸「§8.4」不含任何關鍵字，前兩段都抓不到，是第三段才撈出來的）：
#   1) 文件檔名：CLAUDE.md / skill / harness / 設計文件 / docs/*.md / openspec
#   2) 對話脈絡：使用者要求/實證/指示
#   3) 裸章節號：§ 符號本身（設計文件會改名、章節會重編，出處必爛）
# harness 不用裸詞：測試程式裡的 test harness 是正當用語（2026-10-16 使用回饋，測試檔每次都中）。
# 只認工作流制度檔的路徑（.claude/harness、.claude\harness、harness/_INDEX、harness/D-判斷…）、
# 制度檔檔名（A-漏水診斷書…G-交接信），與「harness（的）規則／規範／守則／制度／規定」這種指涉文件的寫法（H 大小寫皆可）。
# 不中：test/harness/setup.js、test/harness/A-fixture.js（A- 後接英數）、「線束 harness 檔號」「test harness 文件說明」
# （不收「檔」「文件」：測試程式與業務用語常見；第三輪對抗審查實跑）。
AI_TRACE_PATTERN='CLAUDE\.md|code-review skill|frontend-development skill|backend-ddd|\.claude[/\\]harness|harness[/\\](_INDEX|[A-G]-[^A-Za-z0-9])|[Hh]arness[[:space:]]*(的[[:space:]]*)?(規則|規範|守則|制度|規定)|[A-G]-(漏水診斷書|判斷力矩陣|模型調度守則|派工模板|反思協議|交接信)|設計文件|規劃書|需求文件|openspec|docs/[a-z0-9-]+\.md|使用者(實證|要求|指示)|§'
# 真實憑證的「形狀」pattern：上面那份抓的是關鍵字（會誤命中文件與變數名），
# 這份抓的是憑證本身長什麼樣——誤判率極低，命中幾乎必是真的外洩。
# 動機：*.example.json 這類「隨 plugin 發布的範本」與使用者家目錄的真設定檔長得一樣，
# 只差值是不是空的；靠文件寫「不要填真值」是自律，這裡才是他律。
CREDENTIAL_SHAPE_PATTERN='[0-9]{6,}-[a-z0-9]+\.apps\.googleusercontent\.com|GOCSPX-[A-Za-z0-9_-]{10,}|"refresh_token"[[:space:]]*:[[:space:]]*"1//[A-Za-z0-9_-]{10,}|ya29\.[A-Za-z0-9_-]{20,}|AIza[A-Za-z0-9_-]{30,}|-----BEGIN [A-Z ]*PRIVATE KEY-----'
# 檔名黑名單：不該進 repo 的建置產物 / 快取 / 備份 / 本機狀態。
# 動機（實戰）：上面兩道閘掃的是「檔案內容」，抓不到「這個檔案根本不該存在」——
# 曾有一次 commit 把測試執行產生的 __pycache__/*.pyc 一起推上去。
# 這類檔案的特徵在路徑不在內容，所以獨立一道以檔名判斷。
# 可豁免（--allow-artifacts）：少數 repo 確實會版控 dist/ 或 .env.example 之外的產物。
# tsbuildinfo／test-results／playwright-report：TypeScript 增量建置與 Playwright 跑測試時產生，
# 審查或 QA 時在 repo 裡留下過（2026-10-16 使用回饋）。
ARTIFACT_PATH_PATTERN='(^|/)(__pycache__|node_modules|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.venv|venv|\.idea|\.vscode|test-results|playwright-report)/|\.(pyc|pyo|class|o|obj|exe|dll|so|dylib|bak|orig|rej|swp|tmp|tsbuildinfo)$|(^|/)(\.DS_Store|Thumbs\.db|desktop\.ini)$|\.log$'

# 硬閘：commit message（type + desc）不得含任何 AI 署名，且必須單行。
# 命中即 exit 1——這是機制級攔截，不是提醒。
assert_no_signature() {
  local msg="$1"
  if has_signature "$msg"; then
    echo "ERROR: commit message 含 AI 署名，已拒絕 commit（使用者全域規則：禁止任何 Claude 署名）。" >&2
    echo "       命中內容（全形／零寬字元已正規化）：" >&2
    scan_normalize "$msg" | grep -E -i "$SIGNATURE_PATTERN" | sed 's/^/         /' >&2
    exit 1
  fi
  # 多行 desc 是署名夾帶的常見載體；SKILL.md 規範 desc 為「1 句話」，故只允許單行。
  if [ "$(printf '%s' "$msg" | wc -l | tr -d ' ')" != "0" ]; then
    echo "ERROR: commit message 為多行，已拒絕（規範：desc 為單行 1 句話，多行常是署名夾帶載體）。" >&2
    exit 1
  fi
}

# 計算字串的顯示寬度：全形（CJK / 全形標點）算 2，其餘算 1。
# 用 Python 的 unicodedata.east_asian_width 判斷，這是唯一可靠的判準。
# ⚠️ 不要用 awk：多數 awk 實作非 locale-aware，substr 按 byte 切，
#    「中文五個字元」會被算成 18（byte 數）而非 12（顯示寬度）——已實測踩過。
# Python 不可用時 fallback 到 wc -m（字元數，CJK 會低估但不會爆錯），
# 並在 stderr 提示，避免閘門靜默失準。
display_width() {
  local s="$1" w=""
  if [ -n "$PYTHON_BIN" ]; then
    w="$(printf '%s' "$s" | "$PYTHON_BIN" -c '
import sys, unicodedata
t = sys.stdin.buffer.read().decode("utf-8", "replace")
print(sum(2 if unicodedata.east_asian_width(c) in ("W", "F") else 1 for c in t))
' 2>/dev/null | tr -d '\r')" || w=""
  fi
  if [[ "$w" =~ ^[0-9]+$ ]]; then
    printf '%s\n' "$w"
  else
    # wc -m 依語系決定算字元還是位元組：語系沒設（Git Bash 常見）時算位元組，中文 1 字算 3、會偏向多擋。
    # 指定 UTF-8 語系讓它算字元；全形字仍只算 1，所以 CJK 寬度會低估。
    echo "[git-commit] WARNING: 找不到可用的 python，寬度改以字元數估算（CJK 會低估）" >&2
    printf '%s' "$s" | LC_ALL=C.UTF-8 wc -m 2>/dev/null | tr -d ' ' || printf '%s' "$s" | wc -m | tr -d ' '
  fi
}

# 硬閘：commit message 的 description 不得含 AI/作業過程痕跡，且顯示寬度不得超標。
# 註：SIGNATURE_PATTERN 只認署名詞、AI_TRACE_PATTERN 只掃 diff，兩者都攔不住
# 「把作業過程寫進 message」這類洩漏，所以需要本函式。
assert_message_clean() {
  local desc="$1"
  local allow_trace="${2:-0}"

  if printf '%s' "$desc" | grep -E -q "$MESSAGE_TRACE_PATTERN"; then
    if [ "$allow_trace" = "1" ]; then
      echo "[git-commit] message 痕跡命中，但已帶 --allow-message-trace，放行：" >&2
      echo "$desc" | grep -E -o "$MESSAGE_TRACE_PATTERN" | sort -u | sed 's/^/  /' >&2
    else
    echo "ERROR: commit message 含 AI 痕跡或作業過程敘述，已拒絕 commit。" >&2
    echo "       命中內容：" >&2
    printf '%s\n' "$desc" | grep -E -o "$MESSAGE_TRACE_PATTERN" | sort -u | sed 's/^/         /' >&2
    echo "" >&2
    echo "       判準：一般正常人會寫的 commit message。" >&2
    echo "       描述「改了什麼」，不要寫「我用什麼方法確認它是對的」。" >&2
    echo "       ❌ Fix: 經語法樹掃描確認 25 個 await 全數位於 try 保護中" >&2
    echo "       ✅ Fix: DAP 推送的 await 全數移入 try 保護範圍" >&2
    echo "" >&2
    echo "       確認是誤判（命中的是業務詞彙，例如簽核審查流程、代理商 agent）" >&2
    echo "       請在同一條指令（ship／check-msg／amend）加 --allow-message-trace 放行。" >&2
    exit 1
    fi
  fi

  # 軟清單：不擋，只提醒。放在硬擋之後——硬擋沒過就不必再提醒。
  local soft_hits
  soft_hits=$(printf %s "$desc" | grep -E -o "$MESSAGE_SOFT_PATTERN" | sort -u | paste -sd " " - || true)
  if [ -n "$soft_hits" ]; then
    echo "[git-commit] 提醒（不擋）：message 含 ${soft_hits}" >&2
    echo "             確認這是業務描述（招標輪次／稽核複查／缺陷單編號）而非作業過程。" >&2
    echo "             若是「本輪修正…」「第三輪…後通過驗證」這種寫法，請改成描述改了什麼。" >&2
  fi

  local width
  width="$(display_width "$desc")"
  if [ "$width" -gt "$MESSAGE_MAX_WIDTH" ]; then
    echo "ERROR: commit message 描述過長，已拒絕 commit。" >&2
    echo "       顯示寬度 $width（上限 $MESSAGE_MAX_WIDTH；全形算 2、半形算 1）" >&2
    echo "       描述：$desc" >&2
    echo "       改法：只留最關鍵的那一件事；改動涵蓋多個議題請拆成多個 commit。" >&2
    echo "       這個 repo 的慣例需要更長（例如英文訊息）：在 .claude/git-commit.conf 設 max_width=，見 git-commit.conf.example。" >&2
    exit 1
  fi
}

# 內文（--body）：選填，最多 BODY_MAX_LINES 行、每行寬度同描述上限，署名與痕跡跟描述用同一套判準。
# 允許內文不等於放寬署名：署名最常夾帶在多行 message 裡，所以內文一樣過 SIGNATURE_PATTERN。
assert_body_clean() {
  local body="$1" allow_trace="${2:-0}" line n=0 width
  if has_signature "$body"; then
    echo "ERROR: commit 內文含 AI 署名，已拒絕（使用者全域規則：禁止任何 Claude 署名）。" >&2
    scan_normalize "$body" | grep -E -i "$SIGNATURE_PATTERN" | sed 's/^/         /' >&2
    exit 1
  fi
  while IFS= read -r line || [ -n "$line" ]; do
    n=$((n + 1))
    width="$(display_width "$line")"
    if [ "$width" -gt "$MESSAGE_MAX_WIDTH" ]; then
      echo "ERROR: commit 內文第 $n 行過長：顯示寬度 $width（上限 $MESSAGE_MAX_WIDTH；全形算 2、半形算 1）。" >&2
      echo "       內容：$line" >&2
      echo "       改法：自己換行（--body 可以帶換行），或縮短。" >&2
      exit 1
    fi
  done <<< "$body"
  if [ "$n" -gt "$BODY_MAX_LINES" ]; then
    echo "ERROR: commit 內文 $n 行，上限 $BODY_MAX_LINES 行。" >&2
    echo "       內文只放 diff 看不出來、接手的人一定要知道的一兩句（例：要等某套件發版才能建置）；" >&2
    echo "       背景與過程請寫進 PR 或交接文件。" >&2
    exit 1
  fi
  if printf '%s' "$body" | grep -E -q "$MESSAGE_TRACE_PATTERN"; then
    if [ "$allow_trace" = "1" ]; then
      echo "[git-commit] 內文痕跡命中，但已帶 --allow-message-trace，放行：" >&2
      printf '%s\n' "$body" | grep -E -o "$MESSAGE_TRACE_PATTERN" | sort -u | sed 's/^/  /' >&2
    else
      echo "ERROR: commit 內文含 AI 痕跡或作業過程敘述，已拒絕。命中內容：" >&2
      printf '%s\n' "$body" | grep -E -o "$MESSAGE_TRACE_PATTERN" | sort -u | sed 's/^/         /' >&2
      echo "       判準同描述：寫改了什麼、接手要知道什麼，不寫用什麼方法確認它是對的。" >&2
      echo "       確認是業務詞彙誤判：加 --allow-message-trace。" >&2
      exit 1
    fi
  fi
}

# 內文正規化：去 CR、去頭尾空行。空字串＝沒有內文。
normalize_body() {
  printf '%s' "$1" | tr -d '\r' | awk '
    { lines[NR] = $0 }
    END {
      s = 1; while (s <= NR && lines[s] ~ /^[[:space:]]*$/) s++
      e = NR; while (e >= s && lines[e] ~ /^[[:space:]]*$/) e--
      for (i = s; i <= e; i++) print lines[i]
    }'
}

# commit message 的完整檢查：Type、署名＋單行（subject）、痕跡＋寬度（描述）、內文。
# ship／amend／check-msg 共用，判準只有這一份。
check_message() {
  local type="$1" desc="$2" body="$3" allow_trace="$4"
  assert_valid_type "$type"
  if [ "$type" = "none" ] && [ "${desc%%: *}" = "none" ] && looks_like_type_prefix "$desc"; then
    echo "ERROR: 描述開頭是「none:」。none 代表不加前綴，subject 裡不會出現「none:」；描述只寫冒號後面的內容即可。" >&2
    exit 1
  fi
  if [ "$type" = "none" ] && looks_like_type_prefix "$desc"; then
    echo "ERROR: 無前綴（none）的描述開頭像 Type 前綴「${desc%%: *}:」。" >&2
    echo "       要用這個 Type 就把「${desc%%: *}」當成 Type 參數、描述只寫冒號後面（須在 types= 清單內）；不是 Type 就改寫描述開頭。" >&2
    exit 1
  fi
  assert_no_signature "$(compose_subject "$type" "$desc")"
  assert_message_clean "$desc" "$allow_trace"
  if [ -n "$body" ]; then assert_body_clean "$body" "$allow_trace"; fi
  return 0
}

# 硬閘：staged 檔名命中建置產物 / 快取 / 備份黑名單即拒絕。
# 與內容掃描互補——這類檔案的問題在「不該被版控」，內容本身沒有敏感字。
assert_no_artifacts() {
  local allow="$1"
  local files hits
  files=$(git diff --staged --name-only 2>/dev/null || true)
  [ -z "$files" ] && return 0
  hits=$(printf '%s\n' "$files" | grep -E "$ARTIFACT_PATH_PATTERN" | head -20 || true)
  if [ -n "$hits" ]; then
    if [ "$allow" = "1" ]; then
      echo "[git-commit] 檔名黑名單命中，但已帶 --allow-artifacts，放行：" >&2
      printf '%s\n' "$hits" | sed 's/^/  /' >&2
    else
      echo "ERROR: staged 含不該進版控的檔案（建置產物 / 快取 / 備份），已拒絕 commit。" >&2
      echo "       命中檔案（最多 20 個）：" >&2
      printf '%s\n' "$hits" | sed 's/^/         /' >&2
      echo "       處理方式：git rm -r --cached <路徑> 並把規則加進 .gitignore；" >&2
      echo "       確實要版控這些檔：在 prepare 加 --allow-artifacts（ship 會沿用同一份 diff 的放行）。" >&2
      exit 1
    fi
  fi
}

# 硬閘：staged diff 命中敏感字時，除非帶 --allow-sensitive，否則 exit 1。
# repo_path 已 cd 進去才呼叫。allow=1 表示使用者已顯式授權保留。
# 只取 staged diff 的新增行（去掉 +++ 標頭與行首的 +），供關鍵字掃描使用。
# 與 collect_ai_trace_hits 同一作法。關鍵字掃描若吃整份 diff，會掃到：
#   - 刪除行（`-`）：正在移除的東西不該再擋一次
#   - context 行：這次根本沒改到
#   - 本檔自己的 SENSITIVE_PATTERN 定義（那一行本身就列滿了要抓的字）
# 一次 commit 同時撞到這三種，全是誤判。
staged_added_lines() {
  # 可選帶 path 參數限定範圍（analyze 用）；不帶則取全部 staged（ship 用）。
  if [ $# -gt 0 ]; then
    git -c color.ui=false diff --staged -- "$@" 2>/dev/null | awk '/^\+/ && !/^\+\+\+/ { print substr($0, 2) }' || true
  else
    git -c color.ui=false diff --staged 2>/dev/null | awk '/^\+/ && !/^\+\+\+/ { print substr($0, 2) }' || true
  fi
}

# 設定檔（CONFIG_FILE_REGEX）的新增行；可選帶 path 參數限定範圍，同 staged_added_lines。
# 檔名逐一用 --name-only -z 取，不解析 diff 的 `+++ b/…` 標頭：含空白的檔名後面會多一個 tab、
# 非 ASCII 檔名會被加引號並轉成八進位跳脫，兩種都比不上檔名規則（commit 前第 5 輪 C 軌實跑：
# `my file.env`、`設定.env` 的明文密碼整個沒掃）。逐檔取 diff 時用 :(top,literal)：--name-only 給的是相對 repo 根的
# 路徑，pathspec 預設卻從目前目錄算，少了 top 時在子目錄執行（repo 參數是子目錄、或 workspace 在 repo 的子目錄）
# 整個掃不到（commit 前第 6 輪 C 軌實跑）；literal 避免檔名裡的 * ? [ 被當萬用字元。
config_added_lines() {
  local f lf
  while IFS= read -r -d '' f; do
    lf="$(printf '%s' "$f" | tr '[:upper:]' '[:lower:]')"
    [[ "$lf" =~ $CONFIG_FILE_REGEX ]] || continue
    git -c color.ui=false diff --staged -- ":(top,literal)$f" 2>/dev/null \
      | awk '/^\+/ && !/^\+\+\+/ { print substr($0, 2) }' || true
  done < <(git -c core.quotePath=false diff --staged --name-only --diff-filter=d -z -- "$@" 2>/dev/null || true)
}

# 敏感字命中（最多 20 行）：全部新增行比 SENSITIVE_PATTERN，設定檔的新增行另比 CONFIG_PWD_PATTERN。
# prepare／ship（assert_no_sensitive）與 analyze 共用，判準不會漂移。
# token 類命中：每行先轉小寫、刪掉符合 TOKEN_BENIGN 的片段，剩下的再比 TOKEN_ASSIGN_PATTERN，命中就印原本那一行。
# 不用 `grep -v` 整行濾掉：同一行有 `privateKey: './keys/a.pem'` 這類放行片段時，旁邊寫死的
# `token: 'prod-token-abc123'` 會跟著被放過（commit 前第 10 輪兩軌；單行的 client 設定物件很常見）。
# 兩個 pattern 的字面字都是小寫，轉小寫後不必 -i；sed 用 # 當分隔字元（pattern 裡有 /、沒有 #）。
token_assign_hits() {
  local lines stripped nums
  lines="$(staged_added_lines "$@")"
  [ -n "$lines" ] || return 0
  # LC_ALL=C：逐位元組處理。UTF-8 locale 下 BSD tr／sed 遇到非 UTF-8 的行（Big5 原始碼）會報 illegal byte sequence
  # 並截斷輸出，後面的命中無聲漏掉（第 11 輪 C 軌）；pattern 全是 ASCII，逐位元組比對不影響結果。
  # sed 失敗（例如 TOKEN_BENIGN 裡出現 # 跟分隔字元撞到）必須當場中止：吞掉錯誤＝token 類檢查整段無聲失效
  # （commit 前第 13 輪改 pattern 時實際撞到，`(#.*)?` 讓 sed 報 Unmatched ( ，38 行該擋的全放過）。
  if ! stripped="$(printf '%s\n' "$lines" | LC_ALL=C tr '[:upper:]' '[:lower:]' | LC_ALL=C sed -E "$LITERAL_NORMALIZE_SED" | LC_ALL=C sed -E "s@$COLOR_LITERAL_PATTERN@\\1color\\3@g" | LC_ALL=C sed -E "s#$TOKEN_BENIGN##g" | LC_ALL=C sed -E "s#$COND_COLON_PATTERN#\\1\\2$COND_COLON_MARK#g")"; then
    echo "ERROR: LITERAL_NORMALIZE_SED、COLOR_LITERAL_PATTERN、TOKEN_BENIGN 或 COND_COLON_PATTERN 套用失敗（sed 回錯），token 類敏感字檢查無法執行，已中止。" >&2
    exit 1
  fi
  nums="$(printf '%s\n' "$stripped" | LC_ALL=C grep -n -E "$TOKEN_ASSIGN_PATTERN" | cut -d: -f1 || true)"
  [ -n "$nums" ] || return 0
  printf '%s\n' "$lines" | NUMS="$nums" awk 'BEGIN { n = split(ENVIRON["NUMS"], a, "\n"); for (i = 1; i <= n; i++) w[a[i]] = 1 } (NR in w)'
}

# SENSITIVE_PATTERN（不分大小寫）與 CAMEL_PASS_PATTERN（分大小寫）的命中行：先把一行式條件句結尾的冒號換掉
# （見 COND_COLON_PATTERN）再比，命中就印原本那一行。sed 失敗同 token_assign_hits：回傳失敗，由呼叫端中止。
sensitive_line_hits() {
  local lines stripped nums
  lines="$(staged_added_lines "$@")"
  [ -n "$lines" ] || return 0
  if ! stripped="$(printf '%s\n' "$lines" | LC_ALL=C sed -E "$LITERAL_NORMALIZE_SED" | LC_ALL=C sed -E "s@$COLOR_LITERAL_PATTERN@\\1color\\3@g" | LC_ALL=C sed -E "s#$COND_COLON_PATTERN#\\1\\2$COND_COLON_MARK#g")"; then
    echo "ERROR: 字面值正規化、色碼或條件句冒號處理失敗（sed 回錯），敏感字檢查無法執行，已中止。" >&2
    return 1
  fi
  nums="$({ printf '%s\n' "$stripped" | LC_ALL=C grep -n -E -i -- "$SENSITIVE_PATTERN" || true
            printf '%s\n' "$stripped" | LC_ALL=C grep -n -E -- "$CAMEL_PASS_PATTERN" || true; } | cut -d: -f1 | sort -un)"
  [ -n "$nums" ] || return 0
  printf '%s\n' "$lines" | NUMS="$nums" awk 'BEGIN { n = split(ENVIRON["NUMS"], a, "\n"); for (i = 1; i <= n; i++) w[a[i]] = 1 } (NR in w)'
}

# 比對前先確認每條 pattern 對 grep 都合法：下面的 grep 都帶 `|| true`（沒命中回 1 是正常），pattern 寫壞時 grep 回 2，
# 錯誤只印在 stderr、命中清單變空，整條檢查無聲失效（第 30 輪 C 軌實測：SENSITIVE_PATTERN 改壞後 `pw = "Secr3t1"` 被放過）。
assert_patterns_valid() {
  local p rc
  for p in "$SENSITIVE_PATTERN" "$CAMEL_PASS_PATTERN" "$TOKEN_ASSIGN_PATTERN" "$CONFIG_PWD_PATTERN" "$CONFIG_CAMEL_PASS_PATTERN" "$CONFIG_PWD_BENIGN" "$COLOR_LITERAL_PATTERN"; do
    rc=0
    LC_ALL=C grep -E -- "$p" </dev/null >/dev/null 2>&1 || rc=$?
    if [ "$rc" -gt 1 ]; then
      echo "ERROR: 敏感字 pattern 有語法錯誤（grep 回 $rc），敏感字檢查無法執行，已中止。" >&2
      return 1
    fi
  done
}

collect_sensitive_hits() {
  assert_patterns_valid || return 1
  # token_assign_hits／sensitive_line_hits 先在外面跑完：放進下面的 { …; } | awk 管線會變成子 shell，它的 exit 1 只結束子 shell，
  # 錯誤訊息印了卻照樣放行（commit 前第 13 輪測試 PW118 實跑抓到）。失敗就回傳失敗，由呼叫端中止。
  local tok sens
  tok="$(token_assign_hits "$@")" || return 1
  sens="$(sensitive_line_hits "$@")" || return 1
  {
    [ -z "$sens" ] || printf '%s\n' "$sens"
    [ -z "$tok" ] || printf '%s\n' "$tok"
    config_added_lines "$@" | LC_ALL=C grep -E -i "$CONFIG_PWD_PATTERN" | LC_ALL=C grep -E -i -v "$CONFIG_PWD_BENIGN" || true
    config_added_lines "$@" | LC_ALL=C grep -E "$CONFIG_CAMEL_PASS_PATTERN" | LC_ALL=C grep -E -i -v "$CONFIG_PWD_BENIGN" || true
  } | awk '!seen[$0]++' | head -20 || true
}

assert_no_sensitive() {
  local allow="$1"
  # 憑證形狀掃全 diff（含 context）：憑證出現在未改動行也代表 repo 裡有它，
  # 不因「這次沒改到」而放過。關鍵字掃描則只看新增行。
  local diff_output
  diff_output=$(git -c color.ui=false diff --staged 2>/dev/null || true)

  # 憑證形狀命中 = 不可豁免的硬閘。與下方關鍵字掃描不同，--allow-sensitive 不放行——
  # 關鍵字會誤命中（文件寫到 "password" 很正常），憑證形狀不會，命中就是真的外洩。
  local cred_hits
  cred_hits=$(printf '%s\n' "$diff_output" | grep -E "$CREDENTIAL_SHAPE_PATTERN" | head -10 || true)
  if [ -n "$cred_hits" ]; then
    echo "ERROR: staged diff 含真實憑證的特徵字串，已拒絕 commit（此閘無法用 --allow-sensitive 豁免）。" >&2
    echo "       憑證正本應放家目錄設定檔，repo 內範本必須留空。命中行（已遮蔽值）：" >&2
    printf '%s\n' "$cred_hits" | sed -E 's/[A-Za-z0-9_\/+-]{12,}/<已遮蔽>/g; s/^/         /' >&2
    exit 1
  fi

  local hits
  hits=$(collect_sensitive_hits) || exit 1
  if [ -n "$hits" ]; then
    if [ "$allow" = "1" ]; then
      echo "[git-commit] 敏感字命中，但已帶 --allow-sensitive，放行：" >&2
      printf '%s\n' "$hits" | sed 's/^/  /' >&2
    else
      echo "ERROR: staged diff 命中敏感字，已拒絕。確認要保留：在 prepare 加 --allow-sensitive（ship 會沿用同一份 diff 的放行）。" >&2
      echo "       命中內容（最多 20 行）：" >&2
      printf '%s\n' "$hits" | sed 's/^/         /' >&2
      exit 1
    fi
  fi
}

# 取 staged diff 中「新增行」的 AI 痕跡命中（排除 .md）。
# prepare 顯示、ship 攔截，兩處共用這個函式，避免判準漂移。
collect_ai_trace_hits() {
  git -c color.ui=false diff --staged 2>/dev/null \
    | awk '
        /^\+\+\+ b\// { f = substr($0, 7); next }
        /^\+/ && !/^\+\+\+/ { if (f !~ /\.md$/) print f ": " substr($0, 2) }
      ' \
    | grep -E "$AI_TRACE_PATTERN" \
    | head -20 || true
}

# 硬閘：新增的註解引用了維護者手上沒有的文件 → 拒絕 commit。
# 動機（實戰 2026-08-31）：一次清出 53 處同型痕跡，散在 4 個 repo、跨多個 session。
# 根因是「註解撰寫規範」曾有一條「✅ 指向規範文件」明文鼓勵，照做的人都會產生痕跡。
# 條文已刪，但光刪條文只擋得住「之後照規範寫的人」，擋不住習慣——所以要有他律。
assert_no_ai_trace() {
  local allow="$1"
  local hits
  hits=$(collect_ai_trace_hits)
  [ -z "$hits" ] && return 0

  if [ "$allow" = "1" ]; then
    echo "[git-commit] AI 痕跡命中，但已帶 --allow-ai-trace，放行：" >&2
    printf '%s\n' "$hits" | sed 's/^/  /' >&2
    return 0
  fi

  echo "ERROR: staged diff 的新增行引用了外部文件出處，已拒絕 commit。" >&2
  echo "       交付物不得出現 AI 痕跡——註解要寫『理由本身』，不寫『哪份文件第幾節說的』：" >&2
  echo "         ✗ // 對齊「無附件則欄位空」的語意（見設計文件 §6.2）" >&2
  echo "         ✓ // 對齊「無附件則欄位空」的語意" >&2
  echo "       文件會改名、章節會重編，出處必爛；讀碼的人手上通常也沒有那份文件。" >&2
  echo "       確認是誤判（例如 ECMAScript 規範這類公開標準）：在 prepare 加 --allow-ai-trace（ship 會沿用同一份 diff 的放行）。" >&2
  echo "       命中內容（最多 20 行）：" >&2
  printf '%s\n' "$hits" | sed 's/^/         /' >&2
  exit 1
}

# ------------------------------------------------------------
# 審查紀錄（真閘 7）
#
# 兩軌審查原本全靠自律：ship 只檢查 message 與 diff 本身，不知道這份 diff 有沒有被審過。
# 實際事故（2026-09-23）：skill 入口被別的 hook 擋下後，AI 改用 Bash 直接跑
# analyze → prepare → ship，連發 8 顆 commit（7 顆已推上遠端），兩軌一次都沒跑，
# 所有機械閘照樣放行——那些閘管的是「有沒有經過 flow.sh」，不是「有沒有審過」。
#
# 做法：兩軌結果由 review-record 記下並綁定當下 staged diff 的 hash，
# ship／有改到碼的 amend 在 commit 前比對，找不到紀錄或 diff 已變即拒絕。
# 紀錄內容由呼叫者自陳：擋的是「忘了審」，擋不住蓄意謊報，
# 但謊報會在 review-log.tsv 留下一行可稽核的紀錄。
# ------------------------------------------------------------

REVIEW_LOG="$TMP_DIR/review-log.tsv"

# 流程狀態（審查紀錄、送審 diff hash、補推標記、審查輪數、prepare 的放行旗標）放在 repo 自己的 git 目錄裡，
# 不放工作區的 .claude/.git-commit-tmp/。
# 起因（2026-10-16 使用回饋）：舊版用「repo 參數字串」當檔名、放在「當下工作區」——同一個 repo 先在上層用子目錄名、
# 後來 cd 進去用 `.`，工作區與檔名都變了，記好的豁免就找不到，要重記一次。
# git 目錄（--absolute-git-dir）跟怎麼呼叫無關，worktree 之間也各自獨立；放在 .git 裡也不會冒進 git status。
# 呼叫端都已 cd 進 repo；參數（舊版的 slug）保留但不再使用，呼叫點不必改。
repo_state_dir() {
  local d
  d="$(git rev-parse --absolute-git-dir)/git-commit-flow"
  mkdir -p "$d"
  printf '%s' "$d"
}
review_record_file() { echo "$(repo_state_dir)/review.rec"; }
staged_hash_file() { echo "$(repo_state_dir)/staged.sha"; }
# prepare 收到的 --allow-* 旗標，綁定送審 diff hash；ship／amend 在 hash 相同時沿用，不必再帶一次。
prepare_allow_file() { echo "$(repo_state_dir)/prepare-allow"; }
# 同一批改動的審查輪數（每次 prepare 加 1，commit 成功歸零）與「只剩極端情境」的輪次紀錄。
review_round_file() { echo "$(repo_state_dir)/round"; }
# 舊版「連續幾輪只剩極端情境」的計數檔；改由 Codex 仲裁後不再寫，只在歸零時順手清掉舊檔。
edge_rounds_file() { echo "$(repo_state_dir)/edge-rounds"; }
# 上一輪 prepare 時 staged 的檔名清單，用來判斷這一輪是不是同一批
round_files_file() { echo "$(repo_state_dir)/round-files"; }
current_round() {
  local f n=0
  f="$(review_round_file)"
  [ -f "$f" ] && n="$(tr -dc '0-9' < "$f")"
  printf '%s' "${n:-0}"
}
# 哪一輪的審查結果已用 review-record 記下（PASS／豁免／極端情境／BLOCK 類別都算），prepare 開下一輪前比對。
recorded_round_file() { echo "$(repo_state_dir)/recorded-round"; }
block_classes_file() { echo "$(repo_state_dir)/block-classes"; }
recorded_round() {
  local f n=""
  f="$(recorded_round_file)"
  [ -f "$f" ] && n="$(tr -dc '0-9' < "$f")"
  printf '%s' "${n:-0}"
}
mark_round_recorded() { local r; r="$(current_round)"; [ "$r" -ge 1 ] || r=1; printf '%s\n' "$r" > "$(recorded_round_file)"; }
reset_review_rounds() {
  rm -f "$(review_round_file)" "$(edge_rounds_file)" "$(round_files_file)" "$(repo_state_dir)/round-head" "$(recorded_round_file)" "$(block_classes_file)"
  drop_review_ticket
}

# ------------------------------------------------------------
# 審查單（2026-10-19 起）：審查回覆由 hook 抓，不靠 AI 自陳
#
# 兩軌審查在 flow.sh 外面跑（主對話派代理、代理把回覆交回主對話），flow.sh 原本只看得到 AI 拿去 review-record 的東西：
# 收到 BLOCK 卻不記類別、直接 prepare --redo，腳本分不出「真的還沒送審」；極端情境也由 AI 自己用 --edge 宣稱。
# 做法：prepare 發一張審查單（id），派工 prompt 第一行照抄；SubagentStop hook 在代理結束時讀它的派工內容找到審查單，
# 把最後一則回覆原文存成 reply-<id>-<軌>（codex／reviewer／arbiter）。flow.sh 只讀這些檔：
#   - 這一輪抓到 BLOCK 而還沒記類別 → prepare 一律擋（--redo 也不放）
#   - review-record 貼的結論跟抓到的不同 → 拒收；ship 時抓到的是 BLOCK、紀錄卻是一般通過 → 拒絕
#   - --edge 要有 Codex 仲裁抓到的 RULING: EDGE 才收
# 範圍：防手滑、不防故意繞（派工時刻意不帶審查單、自己寫回覆檔，腳本擋不到）。hook 沒裝或沒抓到時退回原本的自陳，
# 唯一例外是 --edge：沒有仲裁結果就不收（出口：修掉，或使用者明示 --exempt）。
# ------------------------------------------------------------
review_ticket_file() { echo "$(repo_state_dir)/ticket"; }
current_ticket_id() { read_marker_line "$(review_ticket_file)" 1; }
# 抓到的某一軌結論（PASS／BLOCK／EDGE／GENERAL）；這一輪的審查單沒有那一軌的回覆就印空字串。
captured_verdict() {
  local id f
  id="$(current_ticket_id)"
  [ -n "$id" ] || return 0
  f="$(repo_state_dir)/reply-$id-$1"
  [ -f "$f" ] || return 0
  [ "$(read_marker_line "$f" 1)" = "$id" ] || return 0
  read_marker_line "$f" 3
}
# 清掉這個 repo 的審查單、抓到的回覆，以及登記處裡指向這個 repo 的舊登記（只刪自己的，不動別的 repo）。
drop_review_ticket() {
  local sd f
  sd="$(repo_state_dir)"
  rm -f "$(review_ticket_file)" "$sd"/reply-gcf-* 2>/dev/null || true
  [ -d "$TICKET_DIR" ] || return 0
  for f in "$TICKET_DIR"/gcf-*; do
    [ -f "$f" ] || continue
    [ "$(read_marker_line "$f" 1)" = "$sd" ] && rm -f "$f"
  done
  return 0
}
# 發新的審查單：舊的（含抓到的回覆）一律作廢，登記處寫一份給 hook 找狀態目錄。
issue_review_ticket() {
  local round="$1" hash="$2" sd id
  drop_review_ticket
  sd="$(repo_state_dir)"
  id="gcf-$(printf '%s|%s|%s|%s|%s' "$sd" "$round" "$hash" "$(date '+%s')" "$RANDOM$RANDOM" | git hash-object --stdin | cut -c1-16)"
  printf 'id=%s\nround=%s\ndiff_hash=%s\n' "$id" "$round" "$hash" > "$(review_ticket_file)"
  if mkdir -p "$TICKET_DIR" 2>/dev/null; then
    printf 'state_dir=%s\nid=%s\nround=%s\ndiff_hash=%s\n' "$sd" "$id" "$round" "$hash" > "$TICKET_DIR/$id" || true
  fi
  printf '%s' "$id"
}

# 狀態檔已改放 git 目錄，這一層主要防「紀錄被手動搬到別的 repo」；保留比對，成本很低。
repo_identity() { git rev-parse --absolute-git-dir; }

# 記下 ship／amend 親手建出的那顆 commit，push-only 補推時只認它。
shipped_marker_file() { echo "$(repo_state_dir)/shipped"; }
mark_shipped() {
  local sha id
  sha="$(git rev-parse HEAD)"
  id="$(repo_identity)"
  printf 'commit=%s\nrepo_id=%s\n' "$sha" "$id" > "$(shipped_marker_file "$1")"
}
# 讀標記的第 N 行值；檔案不存在回空字串（不能讓 sed 報錯，pipefail 下會中止腳本）。
read_marker_line() {
  local file="$1" n="$2" line=""
  [ -f "$file" ] && line="$(sed -n "${n}p" "$file" | tr -d '\r')"
  printf '%s' "${line#*=}"
}

# 取回覆的結論行：第一個非空行是 VERDICT: PASS|BLOCK 或 skipped: 就取它；不是、而最後一個非空行是 VERDICT: PASS|BLOCK，
# 改取最後一行；都不是就回第一行（給錯誤訊息用）。兩端的 Markdown 標記（* _ # > ` 與空白）先去掉。
# 跟 hooks/capture-review-reply.js 的 verdictOf 同一套規則，兩邊必須一致：Codex 習慣把 VERDICT 放最後一行，
# 規則不同時 hook 抓到的 BLOCK 用原文記不進來，下一輪又被它擋住，只能改寫原文才出得去。
# awk 刻意讀完全部輸入、不提早 exit：提早結束會讓上游收到 SIGPIPE，
# 在 pipefail 下整條管線回非 0，set -e 會讓腳本無聲中止（回覆越長越容易撞上）。
verdict_line() {
  printf '%s\n' "$1" | tr -d '\r' | awk '
    { sub(/^[ \t*_#>`]+/, ""); sub(/[ \t*_`]+$/, "") }
    NF { if (!seen) { first = $0; seen = 1 }; last = $0 }
    END {
      v = "^VERDICT:[ \t]*(PASS|BLOCK)([ \t]|$)"
      if (first ~ v || first ~ /^skipped:/ || last !~ v) print first; else print last
    }'
}

# 判一軌的結果：PASS／SKIPPED 印正規化狀態並回 0；其餘印原因回 1。
classify_verdict() {
  local label="$1" text="$2" head
  head="$(verdict_line "$text")"
  if [[ "$head" =~ ^VERDICT:[[:space:]]*PASS([[:space:]]|$) ]]; then
    echo "PASS"; return 0
  fi
  if [[ "$head" =~ ^VERDICT:[[:space:]]*BLOCK([[:space:]]|$) ]]; then
    echo "ERROR: $label 回 BLOCK，不能記成通過。先用 --block-classes \"<根因類別>\" 記下這一輪，再按類別改碼、重跑 prepare、重送兩軌；" >&2
    echo "       C 軌 BLOCK 且專案 .claude/skills/code-review/SKILL.md 有「發現驗證」節：先逐條二次驗證；全部推翻時重派 C 軌一次（不必重跑 prepare），以新回覆記錄。" >&2
    echo "       使用者明示要強制 commit 時，改用 --exempt \"<使用者的原話>\"。" >&2
    echo "       認為 BLOCK 的項目全是極端情境或誤報：不能自己判，派 Codex 仲裁（審查單的 arbiter 軌），回 RULING: EDGE 才能加 --edge \"<剩下哪幾項>\"（見 SKILL.md 核心原則 7）。" >&2
    return 1
  fi
  if [[ "$head" =~ ^skipped:[[:space:]]*[^[:space:]] ]]; then
    # 額度／用量上限是暫時狀態，不是「確定不可用」：記 skipped 等於把這一軌靜默跳過。
    # 要排額度恢復後重跑（SKILL.md 核心原則 5），這裡機械擋下。
    # 用 bash 內建比對、不接 printf | grep -q：回覆很長時 grep 命中就提早結束，上游 printf 吃 SIGPIPE，
    # pipefail 下整條管線回非 0，條件被判成假而放行（3MB 文字實測誤判；短文字正常；本檔 verdict_line 同型的坑）。
    local quota_re='usage limit|rate limit|quota|credits|try again at|額度|用量上限|配額'
    local restore_nocase quota_hit=0
    # shopt -p 在該選項關閉時回 1。目前呼叫點是 `x="$(classify_verdict ...)" || exit 1`，errexit 在 || 左側被暫停，
    # 所以現況不會中止；但若改成在 set -e 生效處直接呼叫，函式會無聲中止——防呆吞掉 exit code，不要依賴呼叫點。
    restore_nocase="$(shopt -p nocasematch || true)"
    shopt -s nocasematch
    [[ "$text" =~ $quota_re ]] && quota_hit=1
    eval "$restore_nocase"
    if [ "$quota_hit" -eq 1 ]; then
      echo "ERROR: $label 的 skipped 理由是額度／用量上限——這是暫時狀態，不算「確定不可用」，不能靜默跳過這一軌。" >&2
      echo "       從錯誤原文取重置時間（例：try again at 8:24 PM），排一個重置後的一次性喚醒重跑這一軌，" >&2
      echo "       並在預覽明講「Codex 額度用完，已排 HH:MM 重跑」；staged 沒變的話 prepare 的 diff hash 仍有效。" >&2
      echo "       詳見 SKILL.md 核心原則 5。" >&2
      return 1
    fi
    # C 軌「找不到 agent」不算不可用：本 plugin 自帶審查者定義（agents/code-reviewer.md），
    # 專案沒啟用 git-commit 時 agent 不會註冊，但仍可用 general-purpose 載入該檔審查（SKILL.md 1.3c 第三層）。
    # 實案：在沒啟用 git-commit 的專案借用 flow.sh，C 軌連續多次記成 skipped: not found，實際只有 Codex 一軌在審。
    if [ "$label" = "code-reviewer" ]; then
      # 放行清單、失敗即擋：C 軌的 skipped 只收「第三層 general-purpose 也試過且失敗」這一種。
      # 不猜理由的寫法——舊版列舉「找不到 agent」的句型，審了五輪每輪都冒出新的誤擋或漏擋
      # （host not found、找不到 code-reviewer 的回覆、找不到審查者…），列舉收斂不了。
      # 本 plugin 自帶審查者定義（agents/code-reviewer.md），任何 agent 都叫不到時仍可用 general-purpose 載入它審。
      local gp_hit=0
      restore_nocase="$(shopt -p nocasematch || true)"
      shopt -s nocasematch
      [[ "$text" =~ general-purpose ]] && gp_hit=1
      eval "$restore_nocase"
      if [ "$gp_hit" -eq 0 ]; then
        local self_dir reviewer_md
        # flow.sh 本身可能是檔案層級的 symlink：先把腳本路徑解析成實體（pwd -P 只解析目錄、不追檔案連結）；
        # readlink -f 不可用（舊版 macOS）時退回原路徑，目錄層級的連結仍由 pwd -P 處理
        local self_src="${BASH_SOURCE[0]}" resolved
        if resolved="$(readlink -f "$self_src" 2>/dev/null)" && [ -n "$resolved" ]; then self_src="$resolved"; fi
        self_dir="$(cd "$(dirname "$self_src")" && pwd -P)"
        reviewer_md="$self_dir/../../agents/code-reviewer.md"
        echo "ERROR: code-reviewer 那一軌只有在「第三層 general-purpose 也試過且失敗」時才能記 skipped。" >&2
        echo "       本 plugin 自帶預設審查者：改用 subagent_type: general-purpose，prompt 開頭請它先讀這份定義並照它執行：" >&2
        echo "         $reviewer_md" >&2
        echo "       再接 SKILL.md 1.3c 的 prompt 範本（見 1.3c 第三層）。第三層也失敗時，理由寫明 general-purpose 並貼它的錯誤原文。" >&2
        return 1
      fi
    fi
    echo "SKIPPED"; return 0
  fi
  echo "ERROR: $label 的結論行（第一個或最後一個非空行）必須是「VERDICT: PASS」（貼 agent 回覆原文）或「skipped: <原因>」（該軌確定不可用；C 軌 code-reviewer 只收理由寫明 general-purpose 第三層也試過且失敗的）。" >&2
  echo "       收到的第一行（最後一行也不是結論行）：${head:-（空白）}" >&2
  return 1
}

print_review_howto() {
  local repo="$1"
  echo "       commit 前必須跑完 Codex 與 code-reviewer 兩軌，並把兩軌回覆記下來：" >&2
  echo "         flow.sh review-record $repo --codex \"<Codex 回覆原文>\" --reviewer \"<code-reviewer 回覆原文>\"" >&2
  echo "       某一軌確定不可用：該軌填 \"skipped: <原因>\"（兩軌都 skipped 不收，要停下來問使用者；C 軌 code-reviewer 只收理由寫明 general-purpose 第三層也試過且失敗的）。" >&2
  echo "       額度／用量上限不算不可用：不能記 skipped，要排額度恢復後重跑這一軌（SKILL.md 核心原則 5）。" >&2
  echo "       使用者明示豁免（Style/Docs 豁免、POC、plugin 發布、緊急修正經同意跳過審查）：" >&2
  echo "         flow.sh review-record $repo --exempt \"<理由>\"" >&2
  echo "       這道閘沒有旗標可以繞過；紀錄只對當下這份 staged diff 有效，重跑 prepare 就要重記。" >&2
}

# 回 0＝有對得上當下 staged diff 的審查紀錄；回 1＝沒有（已印原因）。
# 不直接 exit：amend 被擋時還要清掉剛建的備份分支，收尾交給呼叫端。
check_review_recorded() {
  local repo="$1" slug="$2" action="$3" rec current recorded
  rec="$(review_record_file "$slug")"
  current="$(git -c color.ui=false diff --staged | git hash-object --stdin)"
  if [ ! -f "$rec" ]; then
    echo "ERROR: 這份 staged diff 沒有審查紀錄，已拒絕 $action。" >&2
    print_review_howto "$repo"
    return 1
  fi
  local recorded_repo current_repo
  recorded_repo="$(read_marker_line "$rec" 3)"
  current_repo="$(repo_identity)"
  if [ "$recorded_repo" != "$current_repo" ]; then
    echo "ERROR: 審查紀錄屬於另一個 repo（路徑轉成檔名後撞名），不能拿來用，已拒絕 $action。" >&2
    echo "       紀錄的 repo：${recorded_repo:-（無）}" >&2
    echo "       目前的 repo：$current_repo" >&2
    print_review_howto "$repo"
    return 1
  fi
  recorded="$(read_marker_line "$rec" 1)"
  if [ "$recorded" != "$current" ]; then
    echo "ERROR: 審查紀錄對應的不是目前這份 staged diff（記錄後內容又變了），已拒絕 $action。" >&2
    echo "       紀錄的 hash：$recorded" >&2
    echo "       當前的 hash：$current" >&2
    print_review_howto "$repo"
    return 1
  fi
  # 一般通過的紀錄，記下之後 hook 又抓到這一輪某一軌回 BLOCK（例如重派那一軌）：以抓到的為準。
  # 使用者豁免、仲裁判極端的預設豁免本來就是在 BLOCK 之下放行，不看這一條。
  local summary_line t v
  summary_line="$(sed -n 2p "$rec" | tr -d '\r')"
  if [[ "$summary_line" == Codex* ]]; then
    for t in codex reviewer; do
      v="$(captured_verdict "$t")"
      if [ "$v" = "BLOCK" ]; then
        echo "ERROR: hook 抓到這一輪 $t 軌的回覆是 BLOCK（.git/git-commit-flow/reply-$(current_ticket_id)-$t），紀錄卻是通過，已拒絕 $action。" >&2
        echo "       照 BLOCK 處理：review-record --block-classes 記類別 → 修 → 重跑 prepare → 兩軌重送。" >&2
        return 1
      fi
    done
  fi
  echo "[git-commit] 審查紀錄吻合：$summary_line"
  return 0
}

# ------------------------------------------------------------
# QA 閘（專案選用）：.claude/qa-gate.conf
#
# 「行為類改動要先 QA」原本由專案 hook 在 Bash 指令層攔，但看指令文字（連語法樹也一樣）
# 擋不住間接呼叫：函式包裝、變數、陣列、`set -- …; source flow.sh`、PowerShell 的 Invoke-Expression…
# 繞法補不完。review-record 是 ship 前必經的一步，在這裡由腳本自己看實際 staged 內容，
# 指令外面怎麼包裝（函式、變數、Invoke-Expression…）都會走到這裡被查。設定檔找不到＝完全不檢查，舊專案行為不變。
# 有好幾份設定檔時取第一個找到的、不合併（repo 自帶的設定會蓋過工作目錄層的；往上找也會走到家目錄的 .claude）。
#
# 設定檔位置：依序從 repo 目錄（字面路徑、實體路徑）、主 repo 目錄（worktree 時）、工作目錄（WORKSPACE_DIR）
# 各自往上逐層找 .claude/qa-gate.conf，取第一個找到的。只看 WORKSPACE_DIR 的話，沒設 CLAUDE_PROJECT_DIR 時 WORKSPACE_DIR＝當下目錄，
# 先 cd 進 repo 再用 '.'（本檔錯誤訊息也這樣建議）就找不到設定檔、閘整個不觸發（審查時實跑重現）。
# 同一層的 local-overrides.yml 一併當成 block_staged_overrides 的清單來源（比對方式見 list_override_entries 上方）。
#
# 格式（key=value；整行 # 開頭是註解；「空白後接 #」起到行尾也是註解；值前後空白會剝掉）：
#   behavior_ext=.js .ts .vue        空白分隔；比對檔名結尾，大小寫不分；沒寫或空＝不做 QA 檢查
#   exclude=^tests?/ (^|/)__tests__/  空白分隔的 ERE，任一命中（比對 repo 內相對路徑）就不算行為類
#   block_staged_overrides=1          staged 含 local-overrides 清單上的檔就拒絕記錄（--allow-overrides 放行）
# ------------------------------------------------------------

QA_GATE_CONF=""

# 從給的幾個起點各自往上找 .claude/qa-gate.conf，印出第一個找到的完整路徑；都沒有就不印、回 1。
find_qa_gate_conf() { find_conf_file qa-gate.conf "$@"; }

# 同上，檔名由第一個參數指定（qa-gate.conf、git-commit.conf 共用同一套找法）。
find_conf_file() {
  local name="$1"; shift
  local start d parent
  for start in "$@"; do
    [ -n "$start" ] && [ -d "$start" ] || continue
    d="$(cd "$start" 2>/dev/null && pwd -P)" || continue
    # 同一個起點的字面路徑（可能經過 symlink）也走一遍：與實體路徑不同時先試字面路徑
    local lit
    lit="$(cd "$start" 2>/dev/null && pwd -L)" || lit=""
    if [ -n "$lit" ] && [ "$lit" != "$d" ]; then
      local ld="$lit" lparent
      while [ -n "$ld" ]; do
        if [ -f "$ld/.claude/$name" ]; then printf '%s\n' "$ld/.claude/$name"; return 0; fi
        lparent="$(dirname "$ld")"
        [ "$lparent" = "$ld" ] && break
        ld="$lparent"
      done
    fi
    while [ -n "$d" ]; do
      if [ -f "$d/.claude/$name" ]; then printf '%s\n' "$d/.claude/$name"; return 0; fi
      parent="$(dirname "$d")"
      [ "$parent" = "$d" ] && break
      d="$parent"
    done
  done
  return 1
}

trim_space() {
  local s="$1"
  s="${s#"${s%%[![:space:]]*}"}"
  s="${s%"${s##*[![:space:]]}"}"
  printf '%s' "$s"
}

# 讀設定檔到 QA_BEHAVIOR_EXT、QA_EXCLUDE、QA_BLOCK_OVERRIDES。參數＝repo 目錄；找不到設定檔回 1。
load_qa_gate_conf() {
  QA_BEHAVIOR_EXT=""; QA_EXCLUDE=""; QA_BLOCK_OVERRIDES=0
  # 起點：repo 目錄（find 內部取實體路徑）、未展開 symlink 的路徑、主 repo 目錄（worktree 放在工作目錄外時
  # 靠它找回主 repo 那邊的設定檔）、工作目錄。各自往上找，取第一個找到的。
  local logical="" main=""
  logical="$(cd "$1" 2>/dev/null && pwd -L)" || logical=""
  main="$(git -C "$1" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" && main="$(dirname "$main")" || main=""
  QA_GATE_CONF="$(find_qa_gate_conf "$1" "$logical" "$main" "$WORKSPACE_DIR")" || return 1
  local line key val n=0
  while IFS= read -r line || [ -n "$line" ]; do
    n=$((n+1))
    line="${line%$'\r'}"
    # UTF-8 BOM（PowerShell 5.1 存檔預設會加）：不剝的話第一行的 key 認不出來，閘就靜默失效
    [ "$n" -eq 1 ] && line="${line#$'\xef\xbb\xbf'}"
    [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
    # 只剝「空白後接 #」：緊貼在值裡的 # 保留（ERE 可能用到）
    line="$(printf '%s' "$line" | sed 's/[[:space:]]#.*$//')"
    if [[ "$line" != *=* ]]; then
      echo "WARNING: $QA_GATE_CONF 第 $n 行不是 key=value，已略過：$line" >&2
      continue
    fi
    key="$(trim_space "${line%%=*}")"
    val="$(trim_space "${line#*=}")"
    case "$key" in
      behavior_ext) QA_BEHAVIOR_EXT="$val" ;;
      exclude) QA_EXCLUDE="$val" ;;
      block_staged_overrides)
        case "$val" in
          1) QA_BLOCK_OVERRIDES=1 ;;
          0|"") QA_BLOCK_OVERRIDES=0 ;;
          *) echo "WARNING: $QA_GATE_CONF 的 block_staged_overrides 只收 0 或 1，收到「$val」，當成 0（不檢查）。" >&2
             QA_BLOCK_OVERRIDES=0 ;;
        esac
        ;;
      *) echo "WARNING: $QA_GATE_CONF 第 $n 行的 key「$key」不認得，已略過（可用：behavior_ext、exclude、block_staged_overrides）。" >&2 ;;
    esac
  done < "$QA_GATE_CONF"
  return 0
}

# ------------------------------------------------------------
# 專案層 commit 設定：.claude/git-commit.conf（選用；找法與 qa-gate.conf 相同，取第一個找到的、不合併）
#   types=Feat Fix …                 允許的 Type，空白分隔；列了 none 才能不加前綴（subject 只有描述本身）
#   max_width=72                     描述（與內文每行）的顯示寬度上限，全形算 2、半形算 1
#   review_ask_round=0               審到第幾輪仍 BLOCK 就停下來問使用者；0＝不停，修到只剩極端情境（預設）
#   edge_auto_exempt_rounds=2        Codex 仲裁判只剩極端情境（RULING: EDGE）就預設豁免；0＝關閉（大於 0 都是開啟）
# 沒有設定檔＝沿用本檔頂端的預設值，既有專案行為不變。
# 參數＝repo 目錄。ship／amend／check-msg／audit／prepare／review-record 在 assert_valid_repo 之後呼叫。
# ------------------------------------------------------------
load_commit_conf() {
  local logical="" main=""
  logical="$(cd "$1" 2>/dev/null && pwd -L)" || logical=""
  main="$(git -C "$1" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" && main="$(dirname "$main")" || main=""
  COMMIT_CONF="$(find_conf_file git-commit.conf "$1" "$logical" "$main" "$WORKSPACE_DIR")" || { COMMIT_CONF=""; return 0; }
  local line key val n=0 t bad
  while IFS= read -r line || [ -n "$line" ]; do
    n=$((n+1))
    line="${line%$'\r'}"
    [ "$n" -eq 1 ] && line="${line#$'\xef\xbb\xbf'}"
    [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
    line="$(printf '%s' "$line" | sed 's/[[:space:]]#.*$//')"
    if [[ "$line" != *=* ]]; then
      echo "WARNING: $COMMIT_CONF 第 $n 行不是 key=value，已略過：$line" >&2
      continue
    fi
    key="$(trim_space "${line%%=*}")"
    val="$(trim_space "${line#*=}")"
    case "$key" in
      types)
        local list=()
        read -r -a list <<< "$val" || true
        bad=""
        for t in ${list[@]+"${list[@]}"}; do
          [[ "$t" =~ ^[A-Za-z][A-Za-z0-9_-]*$ ]] || bad="$bad $t"
        done
        if [ "${#list[@]}" -eq 0 ] || [ -n "$bad" ]; then
          echo "ERROR: $COMMIT_CONF 的 types= 無效（要空白分隔的英數字，例：types=major minor patch none）：${bad:-（空的）}" >&2
          exit 1
        fi
        VALID_TYPES=("${list[@]}")
        ;;
      max_width|review_ask_round|edge_auto_exempt_rounds)
        if ! [[ "$val" =~ ^[0-9]+$ ]] || { [ "$key" = "max_width" ] && [ "$val" -lt 20 ]; }; then
          echo "ERROR: $COMMIT_CONF 的 $key= 要是整數（max_width 至少 20），收到「$val」。" >&2
          exit 1
        fi
        case "$key" in
          max_width) MESSAGE_MAX_WIDTH="$val" ;;
          review_ask_round) REVIEW_ASK_ROUND="$val" ;;
          edge_auto_exempt_rounds) EDGE_AUTO_EXEMPT_ROUNDS="$val" ;;
        esac
        ;;
      *) echo "WARNING: $COMMIT_CONF 第 $n 行的 key「$key」不認得，已略過（可用：types、max_width、review_ask_round、edge_auto_exempt_rounds）。" >&2 ;;
    esac
  done < "$COMMIT_CONF"
  return 0
}

# --qa 的值是否算有效表態：去掉前導空白後以「已QA」（中間可有空白、QA 大小寫不分）或「分流例外」開頭，
# 後面接分隔符（冒號、空白）再接內容。只寫「已QA」「分流例外」沒有內容、或「已QAnope」都不算——
# 表態要留下可查的依據（報告路徑、測試輸出、為何讀 code 就能確定）。
qa_value_ok() {
  local v rest prev="" re='^已([[:space:]]|　)*[Qq][Aa](.*)$'
  v="$(trim_space "$1")"
  if [[ "$v" =~ $re ]]; then
    rest="${BASH_REMATCH[2]}"
  elif [[ "$v" == 分流例外* ]]; then
    rest="${v#分流例外}"
  else
    return 1
  fi
  case "$rest" in
    :*|：*|" "*|"　"*|$'\t'*) ;;
    *) return 1 ;;
  esac
  # 逐一剝掉前導的分隔符（不用 ${rest#?}：C 語系下它只剝一個位元組，會把全形字切壞）
  while [ "$rest" != "$prev" ]; do
    prev="$rest"
    rest="${rest#:}"; rest="${rest#：}"; rest="${rest# }"; rest="${rest#　}"; rest="${rest#$'\t'}"
  done
  [ -n "$rest" ]
}

# ---- 本機覆寫夾帶檢查用：以 git 實際身分比對（block_staged_overrides）----
# 不靠「repo 參數寫成什麼字」去對清單的 key：cd 進子目錄、Windows 大小寫不同、worktree、symlink
# 都會讓寫法對不上（審查時連三輪實跑重現）。改成把清單每一區解析成「哪個 git repo（git 共用目錄，
# worktree 與主 repo 相同）＋檔案在 repo 裡的路徑」，staged 的檔用同一套身分比。

# 路徑比較用的正規化：git 設了 core.ignorecase（Windows、macOS 預設）就轉小寫
qa_norm_path() {
  if [ "$2" = "true" ]; then printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; else printf '%s' "$1"; fi
}

# 某個目錄所屬 repo 的 git 共用目錄（實體絕對路徑）；不是 git repo 就回 1
git_common_of() {
  local c
  c="$(git -C "$1" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" || return 1
  [ -n "$c" ] || return 1
  (cd "$c" 2>/dev/null && pwd -P)
}

# 列出覆寫清單所有條目：<區塊 key>\x1f<repo 值>\x1f<path>（格式與 parse_overrides_for_repo 相同的那套縮排規則）
list_override_entries() {
  [ -f "$OVERRIDES_FILE" ] || return 0
  awk '
    { sub(/\r$/, "") }
    /^[^[:space:]#][^:]*:[[:space:]]*$/ { key = $0; sub(/:.*$/, "", key); repo = ""; next }
    /^  repo:[[:space:]]/ { repo = $0; sub(/^  repo:[[:space:]]*/, "", repo); next }
    /^    - path:[[:space:]]/ { p = $0; sub(/^    - path:[[:space:]]*/, "", p); print key "\037" repo "\037" p }
  ' "$OVERRIDES_FILE"
}

# review-record 寫紀錄前的專案閘。沒過就印原因並 exit 1（不寫紀錄）。
# 兩個檢查的問題一次列完，免得修一個才看到下一個。
assert_qa_gate() {
  local repo="$1" qa="$2" allow_overrides="$3"
  local repo_path
  repo_path="$(resolve_repo_path "$repo")"
  load_qa_gate_conf "$repo_path" || return 0
  # block_staged_overrides 讀的覆寫清單跟設定檔同一層（parse_overrides_for_repo 讀 OVERRIDES_FILE；local 會一路帶進它）
  local OVERRIDES_FILE
  OVERRIDES_FILE="$(dirname "$QA_GATE_CONF")/local-overrides.yml"

  local exts=() excludes=() re rc
  read -r -a exts <<< "$QA_BEHAVIOR_EXT" || true
  read -r -a excludes <<< "$QA_EXCLUDE" || true
  [ "${#exts[@]}" -eq 0 ] && [ "$QA_BLOCK_OVERRIDES" -ne 1 ] && return 0

  for re in ${excludes[@]+"${excludes[@]}"}; do
    rc=0; [[ "" =~ $re ]] || rc=$?
    if [ "$rc" -eq 2 ]; then
      echo "ERROR: $QA_GATE_CONF 的 exclude 有無效的正規表示式：$re" >&2
      echo "       修正設定檔後再跑 review-record。" >&2
      exit 1
    fi
  done

  # 用 -z（NUL 分隔）讀原始檔名：不用 -z 時，檔名含 Tab、換行或雙引號會被 git 包成 "a\"b.js" 輸出，
  # 副檔名比對失敗就等於不帶 --qa 也能記錄（core.quotepath=false 只管非 ASCII，管不到這幾個字元）。
  local staged=() f
  while IFS= read -r -d '' f; do
    staged+=("$f")
  done < <(git -C "$repo_path" diff --cached --name-only -z)

  local failed=0 f ext hit restore_nocase

  # ---- QA 表態 ----
  if [ "${#exts[@]}" -gt 0 ]; then
    local behavior=()
    for f in ${staged[@]+"${staged[@]}"}; do
      [ -z "$f" ] && continue
      hit=0
      restore_nocase="$(shopt -p nocasematch || true)"
      shopt -s nocasematch
      for ext in "${exts[@]}"; do
        if [[ "$f" == *"$ext" ]]; then hit=1; break; fi
      done
      eval "$restore_nocase"
      [ "$hit" -eq 1 ] || continue
      for re in ${excludes[@]+"${excludes[@]}"}; do
        if [[ "$f" =~ $re ]]; then hit=0; break; fi
      done
      [ "$hit" -eq 1 ] && behavior+=("$f")
    done

    if [ "${#behavior[@]}" -gt 0 ] && ! qa_value_ok "$qa"; then
      failed=1
      local total="${#behavior[@]}" i
      echo "ERROR: staged 含行為類檔（共 $total 個），review-record 必須帶有效的 --qa 表態，已拒絕記錄。" >&2
      echo "       這個要求來自 $QA_GATE_CONF（behavior_ext／exclude 決定哪些檔算行為類）。" >&2
      echo "       行為類檔：" >&2
      for ((i = 0; i < total && i < 20; i++)); do
        echo "         - ${behavior[$i]}" >&2
      done
      [ "$total" -gt 20 ] && echo "         …另 $((total - 20)) 個未列出" >&2
      echo "       收到的 --qa：${qa:-（未帶）}" >&2
      echo "       三選一：" >&2
      echo "         a. 已 QA：--qa \"已QA：<報告或測試檔路徑＋綠的輸出行>\"" >&2
      echo "         b. 分流例外：--qa \"分流例外：<為何讀 code 就能確定行為正確>\"" >&2
      echo "         c. 尚未 QA：不得記錄。先派 QA 實測，拿到結果再用 a 記錄。" >&2
    fi
  fi

  # ---- staged 含 local-overrides 清單上的檔 ----
  if [ "$QA_BLOCK_OVERRIDES" -eq 1 ] && [ -z "$allow_overrides" ]; then
    local hits=() wanted="" my_common ic e_key e_repo e_path cand bdir bcommon bprefix resolved matched names conf_root is_key
    conf_root="$(dirname "$(dirname "$QA_GATE_CONF")")"
    my_common="$(git_common_of "$repo_path")" || my_common=""
    ic="$(git -C "$repo_path" config --bool core.ignorecase 2>/dev/null)" || ic="false"
    # 這次 repo 的名稱候選（目錄名、remote 名等），只給「目錄解析不出 git repo」的區塊用；`.` 不算名稱
    names="$(repo_identity_candidates "$repo" | awk 'NF && $0 != "." && !seen[$0]++')"
    # 這次 repo 的 remote（origin）repo 名：區塊 key 或 repo 值等於它，就算目錄解析成別的 repo 也照樣擋
    # （同一個 remote 的另一份 clone、或碰巧同名的別的 repo——寧可多擋，有 --allow-overrides 可放行）
    local my_remote="" ru
    ru="$(git -C "$repo_path" remote get-url origin 2>/dev/null)" || ru=""
    if [ -n "$ru" ]; then ru="${ru%/}"; ru="${ru%.git}"; my_remote="${ru##*/}"; my_remote="${my_remote##*:}"; fi
    # 欄位用 \x1f 分隔：Tab 屬於空白類分隔字元，repo 值是空的時兩個 Tab 會被 read 合併、欄位錯位
    while IFS=$'\x1f' read -r e_key e_repo e_path; do
      [ -z "$e_path" ] && continue
      resolved=0; matched=0
      # ① git 實際身分：區塊對應的目錄（設定檔所在目錄 + repo 值或區塊 key）解析得出 git repo 時，
      #    只看它跟這次的 repo 是不是同一個（git 共用目錄相同；worktree、經 symlink、大小寫不同的路徑
      #    都會解析到同一個），是就把該區的檔換算成 repo 內路徑（區塊目錄若是子目錄，前面補上子目錄路徑）。
      #    解析得出卻對不上，就是別的 repo，不再用名稱比——否則 `repo: .` 或同名的另一個 repo 會被套到
      #    這次的 repo 上而誤擋。
      if [ -n "$my_common" ]; then
        for cand in "$e_repo" "$e_key"; do
          [ -z "$cand" ] && continue
          [ "$cand" = "$e_key" ] && [ -n "$e_repo" ] && [ "$cand" != "$e_repo" ] && is_key=1 || is_key=0
          [ -z "$e_repo" ] && is_key=1
          # repo 值可能是絕對路徑（/x/y、C:/x、C:\x）：直接用，不接在設定檔目錄底下
          case "$cand" in
            .) bdir="$conf_root" ;;
            /*|[A-Za-z]:[\\/]*) bdir="$cand" ;;
            *) bdir="$conf_root/$cand" ;;
          esac
          [ -d "$bdir" ] || continue
          bcommon="$(git_common_of "$bdir")" || continue
          bprefix="$(git -C "$bdir" rev-parse --show-prefix 2>/dev/null)" || bprefix=""
          # 由區塊 key 推出的目錄必須本身是 repo 根目錄：上層 repo 裡碰巧同名的普通資料夾
          # 會被 git 往上解析成上層 repo，不能當成「已認出」（key 多半是 remote 名稱）
          [ "$is_key" -eq 1 ] && [ -n "$bprefix" ] && continue
          # 先解析出 git repo 的那個候選說了算（repo 值排在 key 前面）：身分對不上就是別的 repo，
          # 不再拿下一個候選比，否則 `repo: rb`、key 碰巧是 ra 的區塊會被套到 ra 上
          resolved=1
          if [ "$(qa_norm_path "$bcommon" "$ic")" = "$(qa_norm_path "$my_common" "$ic")" ]; then
            matched=1
            wanted="$wanted
$(qa_norm_path "$bprefix$e_path" "$ic")"
          fi
          break
        done
      fi
      # ② 認出的是別的 repo，但 key 或 repo 值等於這次 repo 的 origin remote 名：照樣擋（同一個 remote 的
      #    另一份 clone）。身分已對上時路徑已換算過（可能是子目錄），不能再用原路徑加一次，所以只在對不上時補比
      if [ "$resolved" -eq 1 ] && [ "$matched" -eq 0 ] && [ -n "$my_remote" ]; then
        for cand in "$e_repo" "$e_key"; do
          if [ "$cand" = "$my_remote" ]; then
            wanted="$wanted
$(qa_norm_path "$e_path" "$ic")"
            break
          fi
        done
      fi
      # ③ 區塊目錄不存在或不是 git repo（例如清單用 remote 名稱當 key）：退回用名稱比，
      #    key 或 repo 值等於這次 repo 的任一名稱候選就算
      if [ "$resolved" -eq 0 ] && [ -n "$names" ]; then
        for cand in "$e_repo" "$e_key"; do
          [ -n "$cand" ] && [ "$cand" != "." ] || continue
          if printf '%s\n' "$names" | grep -qxF -- "$cand"; then
            wanted="$wanted
$(qa_norm_path "$e_path" "$ic")"
            break
          fi
        done
      fi
    done < <(list_override_entries)
    if [ -n "$wanted" ]; then
      for f in ${staged[@]+"${staged[@]}"}; do
        [ -z "$f" ] && continue
        if printf '%s\n' "$wanted" | grep -qxF -- "$(qa_norm_path "$f" "$ic")"; then hits+=("$f"); fi
      done
    fi
    if [ "${#hits[@]}" -gt 0 ]; then
      failed=1
      echo "ERROR: staged 含 local-overrides 清單上的檔（本機專用的覆寫），已拒絕記錄。" >&2
      echo "       這個檢查來自 $QA_GATE_CONF 的 block_staged_overrides=1。" >&2
      printf '         - %s\n' "${hits[@]}" >&2
      echo "       多半是誤加：git restore --staged <檔案> 移出後重跑 prepare。" >&2
      echo "       確實要推（例如檔內混有真改動、已用 git apply --cached 只 stage 真改動那幾行）：" >&2
      echo "         加 --allow-overrides \"<理由>\"，理由會寫進 review-log.tsv 供稽核。" >&2
    fi
  fi

  [ "$failed" -eq 0 ] || exit 1
  return 0
}

# ------------------------------------------------------------
# Command: review-record <repo> (--codex <回覆> --reviewer <回覆> | --exempt <理由>)
#   把兩軌結果（或使用者豁免）綁定到當下 staged diff，供 ship／amend 比對
# ------------------------------------------------------------

# 收到任一軌 BLOCK：在 review-record 做任何解析與檢查之前，先作廢那個 repo 現有的審查紀錄。
# 第 34–36 輪兩軌連續找到「某個錯誤在作廢之前就離開」（同類閘拒收、一般模式 BLOCK、類別空白、設定檔寫錯、
# 旗標缺值、--allow-overrides 空字串），逐條往前挪收斂不了，改成函式第一行就做。
# 不靠旗標配對（第 37 輪 C 軌：中間的旗標缺值、旗標名打錯，配對就錯位、BLOCK 認不出來）：
# 任何一個參數的結論行（verdict_line：第一個或最後一個非空行，去掉 Markdown 標記）以 VERDICT: BLOCK 開頭就算收到 BLOCK；
# 每個指向工作目錄底下 git repo 的單行參數都當成候選 repo，一律作廢它的紀錄（多刪的代價只是重記一次）。
invalidate_record_on_block() {
  local a blocked=0 head
  for a in "$@"; do
    head="$(verdict_line "$a")"
    if [[ "$head" =~ ^VERDICT:[[:space:]*_]*BLOCK ]]; then blocked=1; break; fi
  done
  [ "$blocked" -eq 1 ] || return 0
  for a in "$@"; do
    case "$a" in --*|*$'\n'*|'') continue ;; esac
    [ -d "$(resolve_repo_path "$a")" ] || continue
    ( cd "$(resolve_repo_path "$a")" && git rev-parse --git-dir >/dev/null 2>&1 && rm -f "$(review_record_file)" ) || true
  done
}

cmd_review_record() {
  invalidate_record_on_block "$@"
  local codex="" reviewer="" exempt="" qa="" allow_overrides="" edge="" block_classes="" rearchitect=""
  local has_codex=0 has_reviewer=0 has_exempt=0 has_allow_overrides=0 has_edge=0 has_block=0
  local positional=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --codex|--reviewer|--exempt|--qa|--allow-overrides|--edge|--block-classes|--rearchitect)
        if [ $# -lt 2 ]; then
          echo "ERROR: $1 後面缺內容。" >&2
          exit 1
        fi
        case "$1" in
          --codex) codex="$2"; has_codex=1 ;;
          --reviewer) reviewer="$2"; has_reviewer=1 ;;
          --exempt) exempt="$2"; has_exempt=1 ;;
          # QA 表態：專案有 .claude/qa-gate.conf 且 staged 含行為類檔時必帶（assert_qa_gate），
          # 否則選填；不論哪種都跟審查結果一起留下來。
          --qa) qa="$(printf '%s' "$2" | tr '\r\n\t' '   ' | sed 's/^ *//; s/ *$//')" ;;
          --allow-overrides)
            allow_overrides="$(printf '%s' "$2" | tr '\r\n\t' '   ' | sed 's/^ *//; s/ *$//')"
            has_allow_overrides=1 ;;
          # 這一輪的 BLOCK 只剩極端情境：寫明剩哪幾項、為什麼算極端（見 SKILL.md 核心原則 7）
          --edge) edge="$(printf '%s' "$2" | tr '\r\n\t' '   ' | sed 's/^ *//; s/ *$//')"; has_edge=1 ;;
          # 這一輪 BLOCK 的根因類別（分號分隔）；同類別在同一批改動第二次出現要附 --rearchitect（見 SKILL.md 核心原則 7）
          --block-classes) block_classes="$2"; has_block=1 ;;
          --rearchitect) rearchitect="$(printf '%s' "$2" | tr '\r\n\t' '   ' | sed 's/^ *//; s/ *$//')" ;;
        esac
        shift 2
        ;;
      *) positional+=("$1"); shift ;;
    esac
  done

  local usage='Usage: flow.sh review-record <repo> --codex "<回覆原文>" --reviewer "<回覆原文>" [--qa "<QA 狀態>"] [--allow-overrides "<理由>"]
       flow.sh review-record <repo> --codex "<原文>" --reviewer "<原文>" --edge "<剩下哪幾項、為什麼算極端情境>"
       flow.sh review-record <repo> --codex "<原文>" --reviewer "<原文>" --block-classes "<根因類別1>;<根因類別2>" [--rearchitect "<類別>：<改了什麼架構／判準>"]
       flow.sh review-record <repo> --exempt "<理由>" [--qa "<QA 狀態>"] [--allow-overrides "<理由>"]'
  if [ "${#positional[@]}" -ne 1 ]; then
    echo "$usage" >&2
    exit 1
  fi
  local repo="${positional[0]}"
  assert_valid_repo "$repo"
  load_commit_conf "$(resolve_repo_path "$repo")"

  if [ "$has_allow_overrides" -eq 1 ] && [ -z "$allow_overrides" ]; then
    echo "ERROR: --allow-overrides 必須寫明理由（為什麼這次要把 local-overrides 清單上的檔推上去）。" >&2
    exit 1
  fi

  # 專案 QA 閘（.claude/qa-gate.conf；沒有這個檔就不檢查）。過了才進原本的記錄邏輯。
  # BLOCK 類別紀錄不放行 commit，不需要 QA 表態。
  [ "$has_block" -eq 1 ] || assert_qa_gate "$repo" "$qa" "$allow_overrides"

  local mode codex_status="-" reviewer_status="-" reason="-"
  if [ "$has_block" -eq 1 ] && { [ "$has_exempt" -eq 1 ] || [ "$has_edge" -eq 1 ]; }; then
    echo "ERROR: --block-classes 與 --exempt／--edge 只能擇一。" >&2
    exit 1
  fi
  if [ -n "$rearchitect" ] && [ "$has_block" -eq 0 ]; then
    echo "ERROR: --rearchitect 要跟 --block-classes 一起用。" >&2
    exit 1
  fi
  if [ "$has_exempt" -eq 1 ]; then
    if [ "$has_codex" -eq 1 ] || [ "$has_reviewer" -eq 1 ] || [ "$has_edge" -eq 1 ]; then
      echo "ERROR: --exempt 與 --codex／--reviewer／--edge 只能擇一。" >&2
      exit 1
    fi
    reason="$(printf '%s' "$exempt" | tr '\r\n\t' '   ' | sed 's/^ *//; s/ *$//')"
    if [ -z "$reason" ]; then
      echo "ERROR: --exempt 必須寫明理由（例如使用者的原話、Style/Docs 豁免依據）。" >&2
      exit 1
    fi
    mode="exempt"
  elif [ "$has_block" -eq 1 ]; then
    if [ "$has_codex" -eq 0 ] || [ "$has_reviewer" -eq 0 ]; then
      echo "ERROR: --block-classes 也要兩軌原文：--codex 與 --reviewer 缺一不可。" >&2
      exit 1
    fi
    codex_status="$(edge_track_status "Codex" "$codex")" || exit 1
    reviewer_status="$(edge_track_status "code-reviewer" "$reviewer")" || exit 1
    if [ "$codex_status" != "BLOCK" ] && [ "$reviewer_status" != "BLOCK" ]; then
      echo "ERROR: --block-classes 只收至少一軌 BLOCK（收到 Codex $codex_status／code-reviewer $reviewer_status）。" >&2
      exit 1
    fi
    mode="block"
  elif [ "$has_edge" -eq 1 ]; then
    if [ "$has_codex" -eq 0 ] || [ "$has_reviewer" -eq 0 ]; then
      echo "ERROR: --edge 也要兩軌原文：--codex 與 --reviewer 缺一不可。" >&2
      exit 1
    fi
    if [ -z "$edge" ]; then
      echo "ERROR: --edge 必須寫明剩下哪幾項、為什麼算極端情境（只在不尋常的時序或外部條件下才會發生）。" >&2
      exit 1
    fi
    codex_status="$(edge_track_status "Codex" "$codex")" || exit 1
    reviewer_status="$(edge_track_status "code-reviewer" "$reviewer")" || exit 1
    # 兩軌都 BLOCK 也收：判準是「剩下的項目是不是極端情境」，不是幾軌 BLOCK。
    # skipped 的那軌沒有結論，不能替另一軌背書；兩軌都 PASS 不需要 --edge。
    if [ "$codex_status" = "SKIPPED" ] || [ "$reviewer_status" = "SKIPPED" ] \
       || { [ "$codex_status" != "BLOCK" ] && [ "$reviewer_status" != "BLOCK" ]; }; then
      echo "ERROR: --edge 只收「至少一軌 BLOCK、另一軌 BLOCK 或 PASS」（收到 Codex $codex_status／code-reviewer $reviewer_status）。" >&2
      echo "       兩軌都 PASS 不需要 --edge；skipped 的那軌沒有結論，不能替另一軌背書。" >&2
      exit 1
    fi
    mode="edge"
  else
    if [ "$has_codex" -eq 0 ] || [ "$has_reviewer" -eq 0 ]; then
      echo "ERROR: 兩軌結果都要給：--codex 與 --reviewer 缺一不可（不可用的那軌填 \"skipped: <原因>\"；C 軌 code-reviewer 只收理由寫明 general-purpose 第三層也試過且失敗的）。" >&2
      echo "$usage" >&2
      exit 1
    fi
    codex_status="$(classify_verdict "Codex" "$codex")" || exit 1
    reviewer_status="$(classify_verdict "code-reviewer" "$reviewer")" || exit 1
    if [ "$codex_status" = "SKIPPED" ] && [ "$reviewer_status" = "SKIPPED" ]; then
      echo "ERROR: 兩軌都不可用，不能自動 commit。停下來請使用者人工確認；" >&2
      echo "       使用者核可後改用 --exempt \"<使用者的原話>\"。" >&2
      exit 1
    fi
    mode="review"
  fi

  local repo_path
  repo_path="$(resolve_repo_path "$repo")"
  cd "$repo_path"

  if git diff --staged --quiet; then
    echo "ERROR: 沒有 staged 內容，沒有東西可以記錄。先跑 prepare。" >&2
    exit 1
  fi

  # 紀錄必須對應「prepare 產出、送去審查的那份 diff」，否則等於替沒看過的內容背書。
  local repo_slug="$(tmp_repo_slug "$repo")"
  local hash_file
  hash_file="$(staged_hash_file)"
  if [ ! -f "$hash_file" ]; then
    echo "ERROR: 找不到 prepare 產生的 diff hash（$hash_file）。先跑 prepare，拿它產出的 diff 送審。" >&2
    exit 1
  fi
  local prepared current
  prepared="$(tr -d '\r' < "$hash_file")"
  current="$(git -c color.ui=false diff --staged | git hash-object --stdin)"
  if [ "$prepared" != "$current" ]; then
    echo "ERROR: 目前的 staged diff 與 prepare 時送審的版本不符，不能記錄。" >&2
    echo "       送審版 hash：$prepared" >&2
    echo "       當前版 hash：$current" >&2
    echo "       請重跑 prepare 並重送兩軌。" >&2
    exit 1
  fi

  # hook 抓到的回覆是準的：貼進來的結論跟抓到的不同就拒收（抓不到的那軌照舊收自陳）。
  local cap_codex="" cap_reviewer=""
  if [ "$mode" != "exempt" ]; then
    cap_codex="$(captured_verdict codex)"
    cap_reviewer="$(captured_verdict reviewer)"
    local cap_bad=""
    [ -n "$cap_codex" ] && [ "$cap_codex" != "$codex_status" ] && cap_bad+="  - Codex：hook 抓到 $cap_codex，貼的是 $codex_status"$'\n'
    [ -n "$cap_reviewer" ] && [ "$cap_reviewer" != "$reviewer_status" ] && cap_bad+="  - code-reviewer：hook 抓到 $cap_reviewer，貼的是 $reviewer_status"$'\n'
    if [ -n "$cap_bad" ]; then
      rm -f "$(review_record_file)"
      echo "ERROR: 貼進來的審查結論跟 hook 抓到的回覆原文不同，不能記錄：" >&2
      printf '%s' "$cap_bad" >&2
      echo "       抓到的原文在 $(repo_state_dir)/reply-$(current_ticket_id)-<軌>；照原文的結論記（BLOCK 用 --block-classes）。" >&2
      exit 1
    fi
  fi

  # 同類重複閘（2026-10-18 起）：BLOCK 這一輪記下根因類別；同一類別在同一批改動的前幾輪出現過，
  # 代表逐案補收斂不了（審查者每輪都能找到同類的新案例），要改架構／判準讓這一類一次涵蓋，用 --rearchitect 寫明，
  # 或把這一類剩下的判成極端情境走 --edge。起因：git-commit 0.13.0 的敏感字規則逐案補寫法，同一批改動審了 32 輪；
  # 更早 harness 0.5.0 的主機規則審 13 輪，改成放行清單（失敗即擋）才收斂。
  # 類別名稱由 AI 填，換名字躲比對這件事腳本擋不到（自律部分）；腳本保證的是「每輪都要記、重複就要交代架構改法」。
  if [ "$mode" = "block" ]; then
    local round classes cls bc_file prev_round repeats="" rearch_l
    round="$(current_round)"; [ "$round" -ge 1 ] || round=1
    classes="$(printf '%s' "$block_classes" | sed 's/；/;/g' | tr ';\r\n\t' '\n\n\n ' | sed 's/^ *//; s/ *$//' | tr '[:upper:]' '[:lower:]' | sed '/^$/d' | awk '!seen[$0]++')"
    if [ -z "$classes" ]; then
      echo "ERROR: --block-classes 要寫這一輪 BLOCK 的根因類別（分號分隔），例：\"敏感字漏抓-設定讀取寫法;誤擋-色碼\"。" >&2
      exit 1
    fi
    bc_file="$(block_classes_file)"
    rearch_l="$(printf '%s' "$rearchitect" | tr '[:upper:]' '[:lower:]')"
    while IFS= read -r cls; do
      prev_round="$( { [ -f "$bc_file" ] && awk -F'\t' -v r="$round" -v c="$cls" '$1 < r && $2 == c { print $1 }' "$bc_file"; } | head -1 || true)"
      if [ -n "$prev_round" ] && [[ "$rearch_l" != *"$cls"* ]]; then
        repeats+="  - 「$cls」（第 $prev_round 輪出現過）"$'\n'
      fi
    done <<< "$classes"
    if [ -n "$repeats" ]; then
      echo "ERROR: 以下類別在這批改動的前幾輪就出現過，又冒出新案例＝逐案補收斂不了：" >&2
      printf '%s' "$repeats" >&2
      echo "       不要再逐案補。二選一：" >&2
      echo "       1) 改架構／判準，讓這一類一次涵蓋（例：列舉改放行清單、失敗即擋、換判準、先定範圍再交審查者），" >&2
      echo "          改完用 --rearchitect \"<類別>：<改了什麼>\" 記這一輪" >&2
      echo "       2) 這一類剩下的都是極端情境 → 派 Codex 仲裁，回 RULING: EDGE 再用 review-record --edge" >&2
      exit 1
    fi
    { [ -f "$bc_file" ] && awk -F'\t' -v r="$round" '$1 != r' "$bc_file"; printf '%s\n' "$classes" | awk -v r="$round" '{ print r "\t" $0 }'; } > "$bc_file.tmp"
    mv "$bc_file.tmp" "$bc_file"
    mark_round_recorded
    [ -f "$REVIEW_LOG" ] || printf 'recorded_at\trepo\tdiff_hash\tmode\tcodex\treviewer\texempt_reason\tqa\tallow_overrides\n' > "$REVIEW_LOG"
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$(tmp_repo_key "$repo")" "$current" "block" "$codex_status" "$reviewer_status" "$(printf '%s' "$classes" | tr '\n' ';')${rearchitect:+ ／ 架構改法：$rearchitect}" "-" "-" >> "$REVIEW_LOG"
    echo "=== 已記下第 $round 輪 BLOCK 的根因類別（不放行 commit）==="
    printf '%s\n' "$classes" | sed 's/^/  - /'
    echo "下一步：按類別一次修完（整類掃過，不是只修被點名的那幾行）→ 重跑 prepare → 兩軌重送。"
    exit 0
  fi

  # 極端情境：由 Codex 仲裁判，不由 AI 自己判（改的人判自己的改動會偏向放過）。仲裁回 RULING: EDGE 就預設豁免、不再追；
  # RULING: GENERAL 就是一般問題，要修。仲裁回覆由 hook 抓（審查單的 arbiter 軌），沒抓到就不收。
  # 起因：舊版 --edge 只檢查理由有沒有填，AI 球員兼裁判；又規定連續 2 輪才豁免，等於逼著把極端情境再修一輪。
  # 更早（2026-10-16）：「任一軌 BLOCK 就不能 commit」沒有停止條件，同一批審了 9 輪。
  local ruling=""
  if [ "$mode" = "edge" ]; then
    ruling="$(captured_verdict arbiter)"
    if [ "$ruling" != "EDGE" ]; then
      if [ "$ruling" = "GENERAL" ]; then
        echo "ERROR: Codex 仲裁判定還有一般問題（RULING: GENERAL），不能走 --edge。" >&2
        echo "       照仲裁回覆（$(repo_state_dir)/reply-$(current_ticket_id)-arbiter）把判成一般問題的項目修掉 → 重跑 prepare → 兩軌重送；" >&2
        echo "       這一輪先用 --block-classes 記類別。" >&2
      else
        echo "ERROR: 沒有這一輪的 Codex 仲裁結果，不能走 --edge（極端情境不由主對話自己判）。" >&2
        echo "       派 codex:codex-rescue 仲裁，prompt 第一行照抄 prepare 印的「[git-commit 審查單 $(current_ticket_id) arbiter]」，" >&2
        echo "       內容與格式照 SKILL.md 1.4「極端情境仲裁」；回 RULING: EDGE 後再跑同一條 review-record。" >&2
        echo "       沒有 hook（仲裁回覆存不下來）時，只能修掉，或請使用者明示 --exempt。" >&2
      fi
      exit 1
    fi
    if [ "$EDGE_AUTO_EXEMPT_ROUNDS" -le 0 ]; then
      mark_round_recorded
      echo "ERROR: 未寫入審查紀錄。仲裁判定只剩極端情境，但 ${COMMIT_CONF:-設定檔} 設了 edge_auto_exempt_rounds=0，極端情境不會自動豁免。" >&2
      echo "       下一步：把剩下的項目用白話列給使用者，請使用者決定修或記進交接；" >&2
      echo "       選記進交接：review-record $repo --exempt \"<使用者原話>；記進交接：<剩下的項目>\"" >&2
      exit 1
    fi
    mode="edge-exempt"
    reason="$edge"
  fi

  local now summary
  now="$(date '+%Y-%m-%d %H:%M:%S')"
  if [ "$mode" = "exempt" ]; then
    summary="豁免（$reason）"
  elif [ "$mode" = "edge-exempt" ]; then
    summary="極端情境預設豁免（Codex 仲裁 RULING: EDGE；Codex $codex_status／code-reviewer $reviewer_status）"
  else
    summary="Codex $codex_status／code-reviewer $reviewer_status"
  fi

  # 第 1 行固定是 hash、第 2 行是摘要、第 3 行是 repo 身分——check_review_recorded 只讀這三行，
  # 回覆原文放在後面，內容再怎麼寫都不會被誤讀成 hash。
  local rec
  rec="$(review_record_file "$repo_slug")"
  {
    echo "diff_hash=$current"
    echo "$summary"
    echo "repo_id=$(repo_identity)"
    echo "recorded_at=$now"
    echo "repo=$repo"
    echo "qa=${qa:--}"
    echo "allow_overrides=${allow_overrides:--}"
    echo "captured=codex:${cap_codex:--} reviewer:${cap_reviewer:--} arbiter:${ruling:--}"
    if [ "$mode" = "exempt" ]; then
      echo "exempt_reason=$reason"
    else
      [ "$mode" = "edge-exempt" ] && echo "edge_reason=$reason"
      echo "--- codex ---"
      printf '%s\n' "$codex"
      echo "--- code-reviewer ---"
      printf '%s\n' "$reviewer"
    fi
  } > "$rec"
  mark_round_recorded

  # 稽核用流水帳，commit 後不清：事後查「哪些 commit 是豁免放行的」只能靠它。
  # allow_overrides 欄（0.11.0 起）加在最後、不動既有欄位順序；舊檔的表頭就地補上這一欄，
  # 舊資料列少這一欄＝當時沒有這個旗標。
  # 已知限制：補表頭是 tmp＋mv 改寫、沒有鎖；兩個 session 剛好同時第一次在 0.11.0 記錄時，可能少掉其中一列。
  # 只會發生在升級後第一次寫入的那一刻（之後表頭已是新的，只做附加），沒為此加鎖。
  local log_header_old log_header log_first
  log_header_old=$'recorded_at\trepo\tdiff_hash\tmode\tcodex\treviewer\texempt_reason\tqa'
  log_header="$log_header_old"$'\tallow_overrides'
  if [ ! -f "$REVIEW_LOG" ]; then
    printf '%s\n' "$log_header" > "$REVIEW_LOG"
  else
    log_first="$(head -n 1 "$REVIEW_LOG" | tr -d '\r')"
    if [ "$log_first" = "$log_header_old" ]; then
      { printf '%s\n' "$log_header"; tail -n +2 "$REVIEW_LOG"; } > "$REVIEW_LOG.tmp" && mv "$REVIEW_LOG.tmp" "$REVIEW_LOG"
    fi
  fi
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$now" "$(tmp_repo_key "$repo")" "$current" "$mode" "$codex_status" "$reviewer_status" "$reason" "${qa:--}" "${allow_overrides:--}" >> "$REVIEW_LOG"

  echo "=== 審查紀錄已寫入 ==="
  echo "  repo：$repo"
  echo "  diff hash：$current"
  echo "  結果：$summary"
  echo "  QA：${qa:-（未表態）}"
  if [ "$mode" != "exempt" ]; then
    if [ -z "$cap_codex$cap_reviewer" ]; then
      echo "  hook 抓到的回覆：無（派工 prompt 第一行沒帶 prepare 印的審查單，或 hook 沒裝）——這一輪的結論只有自陳"
    else
      echo "  hook 抓到的回覆：Codex ${cap_codex:-（沒抓到）}／code-reviewer ${cap_reviewer:-（沒抓到）}"
    fi
  fi
  [ -n "$allow_overrides" ] && echo "  放行 local-overrides 檔：$allow_overrides"
  if [ "$mode" = "edge-exempt" ]; then
    echo "  極端情境：$reason"
    echo "  ⚠ 這是預設豁免：預覽要明講「Codex 仲裁判定只剩極端情境，已預設豁免」，剩下的項目寫進交接紀錄。"
  fi
  echo "  下一步：flow.sh ship $repo <Type> \"<描述>\""
}

# --edge 模式判一軌：BLOCK 照收（回 BLOCK），其餘交給 classify_verdict（PASS／SKIPPED 或報錯）。
edge_track_status() {
  local label="$1" text="$2" head
  head="$(verdict_line "$text")"
  if [[ "$head" =~ ^VERDICT:[[:space:]]*BLOCK([[:space:]]|$) ]]; then
    echo "BLOCK"; return 0
  fi
  classify_verdict "$label" "$text"
}

# ------------------------------------------------------------
# Command: analyze <repo>
#   輸出 git 狀態 / local-overrides 過濾 / 敏感字掃描
#   供 AI 一次拿完分析結果
# ------------------------------------------------------------

cmd_analyze() {
  local repo="${1:-}"
  [ -z "$repo" ] && { echo "Usage: flow.sh analyze <repo>" >&2; exit 1; }
  assert_valid_repo "$repo"
  ensure_overrides_file

  local repo_path
  repo_path="$(resolve_repo_path "$repo")"
  cd "$repo_path"

  local branch
  branch=$(git branch --show-current)

  local overrides
  overrides=$(parse_overrides_for_repo "$repo")

  echo "=== REPO: $repo ==="
  echo "Branch: $branch"
  echo ""

  local staged=()
  local modified=()
  local untracked=()
  local excluded=()

  while IFS= read -r line; do
    [ -z "$line" ] && continue
    local xy="${line:0:2}"
    local file
    file=$(extract_path_from_status "$line")

    local in_override=0
    is_in_overrides "$file" "$overrides" && in_override=1

    # X 欄（左）= index，Y 欄（右）= working tree
    local x="${xy:0:1}"
    local y="${xy:1:1}"

    if [ "$xy" = "??" ]; then
      untracked+=("$file")
    elif [ "$x" != " " ] && [ "$x" != "?" ]; then
      # Staged（含 MM: 已 stage 過又改）
      if [ $in_override -eq 1 ]; then
        excluded+=("$file [STAGED, in overrides]")
      else
        staged+=("$line")
      fi
    elif [ "$y" != " " ]; then
      # 僅 working tree 修改
      if [ $in_override -eq 1 ]; then
        excluded+=("$file [in overrides]")
      else
        modified+=("$line")
      fi
    fi
  done < <(git -c color.ui=false status -s -u)

  echo "--- Staged (${#staged[@]}) ---"
  [ ${#staged[@]} -eq 0 ] && echo "(none)" || printf '%s\n' "${staged[@]}"
  echo ""

  echo "--- Modified (${#modified[@]}) ---"
  [ ${#modified[@]} -eq 0 ] && echo "(none)" || printf '%s\n' "${modified[@]}"
  echo ""

  echo "--- Untracked (${#untracked[@]}) ---"
  [ ${#untracked[@]} -eq 0 ] && echo "(none)" || printf '%s\n' "${untracked[@]}"
  echo ""

  echo "--- Excluded by local-overrides (${#excluded[@]}) ---"
  [ ${#excluded[@]} -eq 0 ] && echo "(none)" || printf '%s\n' "${excluded[@]}"
  echo ""

  # 敏感字掃描 — 只掃 staged 檔案的 diff（避免誤報）
  echo "--- Sensitive scan (staged diff 新增行) ---"
  if [ ${#staged[@]} -eq 0 ]; then
    echo "(no staged files)"
  else
    local staged_paths=()
    for entry in "${staged[@]}"; do
      staged_paths+=("$(extract_path_from_status "$entry")")
    done

    # 與 ship 的 assert_no_sensitive 共用同一個抽取函式——判準必須相同，
    # 否則會出現「analyze 報 HITS 但 ship 放行」的矛盾。
    local hits
    hits=$(collect_sensitive_hits "${staged_paths[@]}") || exit 1

    if [ -z "$hits" ]; then
      echo "CLEAN"
    else
      echo "HITS (prepare 會實際攔截，除非在 prepare 帶 --allow-sensitive):"
      printf '%s\n' "$hits"
    fi
  fi
}

# ------------------------------------------------------------
# Command: prepare <repo> <files...>
#   git add → 產出 staged diff 到 .tmp/
# ------------------------------------------------------------

cmd_prepare() {
  local repo="${1:-}"
  [ -z "$repo" ] && { echo "Usage: flow.sh prepare <repo> <files...> | --staged  [--allow-sensitive] [--allow-artifacts] [--allow-ai-trace]" >&2; exit 1; }
  assert_valid_repo "$repo"
  load_commit_conf "$(resolve_repo_path "$repo")"
  shift
  # --allow-*：內容閘（敏感字／建置產物／AI 痕跡）提前到 prepare 擋，誤判時在這裡就放行，
  # 旗標綁定送審 diff hash 記下來，ship／amend 沿用，不必再帶一次。
  local allow_sensitive=0 allow_artifacts=0 allow_ai_trace=0 redo=0 args=() a
  for a in "$@"; do
    case "$a" in
      --redo) redo=1 ;;
      --allow-sensitive) allow_sensitive=1 ;;
      --allow-artifacts) allow_artifacts=1 ;;
      --allow-ai-trace) allow_ai_trace=1 ;;
      *) args+=("$a") ;;
    esac
  done
  set -- ${args[@]+"${args[@]}"}
  # --staged：不 git add，直接拿當下 index 送審。給 merge 收尾用——
  # git 已把合併進來的檔案 stage 好，逐檔重列既囉嗦又容易漏。
  local use_staged=0
  if [ "${1:-}" = "--staged" ]; then
    use_staged=1
    shift
    [ $# -gt 0 ] && { echo "ERROR: --staged 不可再帶檔名（要加檔案就不帶 --staged 逐檔列）" >&2; exit 1; }
  fi
  local files=("$@")
  if [ $use_staged -eq 0 ] && [ ${#files[@]} -eq 0 ]; then
    echo "ERROR: No files specified（merge 收尾要沿用 git 已 stage 的內容，改用 --staged）" >&2
    exit 1
  fi

  local repo_path
  repo_path="$(resolve_repo_path "$repo")"
  cd "$repo_path"

  # 外來 staged 閘：index 裡已有「不在這次檔案清單內」的 staged 項目就拒絕。
  # index 是所有 session 共用的——別的 session 送審期間 stage 的檔，逐檔 prepare 會照單全收，
  # 最後 ship 一起 commit（2026-09-24 實證：另一 session 已 stage 的 5 個檔就是這樣混進來）。
  # 判斷用 pathspec（git 自己的比對），目錄、萬用字元與檔名一體適用。
  # merge 進行中不檢查：git 已把合併進來的檔案 stage 好，那些本來就屬於這顆 commit。
  if [ $use_staged -eq 0 ] && [ ! -f "$(git rev-parse --git-dir)/MERGE_HEAD" ]; then
    # 兩份清單先存變數：寫在 <(...) 裡的 git 失敗不會傳出來（set -e 看不到），
    # 清單變空就等於閘直接放行。一般命令替換失敗時 set -e 會直接中止。
    # 用 plumbing 的 diff-index 而非 git diff：git diff 的輸出受 repo 設定左右
    # （diff.renames 把「刪清單外 old + 加同內容 mine」併成一筆 mine；diff.ignoreSubmodules／
    # submodule.<name>.ignore 把 staged 的 submodule 指標更新整個藏起來），任何一種都讓外來項目漏判。
    # 再明寫 --no-renames --ignore-submodules=none，不依賴預設值。還沒有任何 commit 時沒有 HEAD，改比空 tree。
    local base all_staged listed_staged foreign
    base=HEAD
    git rev-parse -q --verify HEAD >/dev/null || base="$(git hash-object -t tree /dev/null)"
    all_staged="$(git -c core.quotePath=false diff-index --cached --no-renames --ignore-submodules=none --name-only "$base")"
    listed_staged="$(git -c core.quotePath=false diff-index --cached --no-renames --ignore-submodules=none --name-only "$base" -- "${files[@]}")"
    foreign="$(comm -23 <(printf '%s\n' "$all_staged" | sort) <(printf '%s\n' "$listed_staged" | sort) | sed '/^$/d')"
    if [ -n "$foreign" ]; then
      echo "ERROR: index 裡已有不在這次檔案清單內的 staged 項目（可能是別的 session stage 的）：" >&2
      printf '%s\n' "$foreign" | sed 's/^/  /' >&2
      echo "       是你自己的（例如用 git apply --cached 切 hunk stage 的）→ 改用 prepare <repo> --staged" >&2
      echo "       不是你的 → 先跟使用者確認，別直接 unstage 別人的東西" >&2
      exit 1
    fi
  fi

  # 新一批改動：逐檔模式下 index 原本是空的，就是新的一批（重審時上一輪 stage 的檔還在 index 裡）。
  # 輪數、審查單與抓到的回覆歸零——否則放棄的改動留下的輪次與 BLOCK 會被算進不相干的下一批。
  if [ $use_staged -eq 0 ] && git diff --cached --quiet 2>/dev/null; then
    reset_review_rounds
  fi

  # 同類重複閘的前提：上一輪送審的結果要先用 review-record 記下（BLOCK 用 --block-classes 記根因類別），
  # 才能開下一輪——不記就重送，類別重複就查不出來（見 cmd_review_record 的 block 模式）。
  # 在 git add 之前擋，index 不動。還沒送審就要重送（漏了檔、內容閘後補改）用 --redo。
  # 「同一批」只在這裡判一次，這道閘與後面的輪數歸零共用同一個結論（第 34 輪 C 軌實跑：原本閘在 git add 前判、
  # 歸零在 git add 後判，只 unstage 一部分檔就兩邊結論不一致，閘放行、輪數卻照加）。
  # 同一批＝HEAD 沒變，且上一輪送審的檔全部在「這次 prepare 之後會 staged 的範圍」內
  # （--staged：當下 index；逐檔：當下 index ＋ 這次列出的路徑底下的檔）。換了一批就不擋，交給歸零。
  local head_file_rec prev_files_rec same_batch=0 predicted_files
  head_file_rec="$(repo_state_dir)/round-head"
  prev_files_rec="$(round_files_file)"
  predicted_files="$({ git -c core.quotePath=false diff --cached --name-only
                       [ $use_staged -eq 1 ] || git -c core.quotePath=false ls-files --cached --others --exclude-standard -- "${files[@]}"; } | sed '/^$/d' | sort -u)"
  if [ -f "$head_file_rec" ] && [ "$(tr -d '\r' < "$head_file_rec")" = "$(git rev-parse -q --verify HEAD 2>/dev/null || echo none)" ] \
    && [ -f "$prev_files_rec" ] \
    && [ -z "$(comm -23 <(tr -d '\r' < "$prev_files_rec" | sed '/^$/d' | sort) <(printf '%s\n' "$predicted_files") | sed '/^$/d')" ]; then
    same_batch=1
  fi
  # hook 已抓到這一輪有 BLOCK（審查單 reply 檔）：確定送審過，--redo 也不放，一定要先記類別。
  # 抓不到（沒送審、還沒回、hook 沒裝）才輪到下面那道靠 --redo 自陳的閘。
  if [ "$same_batch" -eq 1 ] && [ "$(current_round)" -ge 1 ] && [ "$(recorded_round)" != "$(current_round)" ] \
    && [ "$(read_marker_line "$(review_ticket_file)" 2)" = "$(current_round)" ]; then
    local cap_t cap_hit=""
    for cap_t in codex reviewer; do
      [ "$(captured_verdict "$cap_t")" = "BLOCK" ] && cap_hit+=" $cap_t"
    done
    if [ -n "$cap_hit" ]; then
      echo "ERROR: 第 $(current_round) 輪已送審，hook 抓到 BLOCK（${cap_hit# }），還沒記類別，不能重新準備（帶 --redo 也一樣）。" >&2
      echo "       先記：review-record $repo --codex \"<原文>\" --reviewer \"<原文>\" --block-classes \"<根因類別1>;<根因類別2>\"" >&2
      echo "       認為是極端情境或誤報 → 派 Codex 仲裁，回 RULING: EDGE 再用 --edge（見 SKILL.md 核心原則 7）" >&2
      echo "       抓到的原文：$(repo_state_dir)/reply-$(current_ticket_id)-<軌>" >&2
      exit 1
    fi
  fi
  if [ "$redo" -eq 0 ] && [ "$same_batch" -eq 1 ] && [ "$(current_round)" -ge 1 ] \
    && [ "$(recorded_round)" != "$(current_round)" ]; then
    echo "ERROR: 第 $(current_round) 輪送審後還沒用 review-record 記下結果，不能開下一輪。" >&2
    echo "       BLOCK → review-record $repo --codex \"<原文>\" --reviewer \"<原文>\" --block-classes \"<根因類別1>;<根因類別2>\"" >&2
    echo "       只剩極端情境 → 派 Codex 仲裁、回 RULING: EDGE 再用 --edge；兩軌 PASS → 照常 review-record" >&2
    echo "       還沒送審就要重送（漏了檔、內容閘後補改）→ prepare 加 --redo" >&2
    exit 1
  fi

  echo "=== Stage files ==="
  if [ $use_staged -eq 0 ]; then
    git add "${files[@]}"
  fi
  git -c color.ui=false status -s
  echo ""

  if [ $use_staged -eq 1 ] && git diff --staged --quiet; then
    echo "ERROR: --staged 但 index 是空的，沒有東西可送審" >&2
    exit 1
  fi

  # merge 進行中：衝突沒解完 commit 必失敗，在送審前就擋，免得白審一輪。
  if [ -f "$(git rev-parse --git-dir)/MERGE_HEAD" ]; then
    local unmerged
    unmerged="$(git diff --name-only --diff-filter=U)"
    if [ -n "$unmerged" ]; then
      echo "ERROR: merge 進行中，仍有未解衝突的檔案（解完並列進 prepare 再來）：" >&2
      printf '%s\n' "$unmerged" | sed 's/^/  /' >&2
      exit 1
    fi
    echo "--- merge 進行中（MERGE_HEAD 存在）---"
    echo "ship 會建出雙 parent 的 merge commit；Type 用 Chore。下方 diff 是相對第一個 parent（目前分支）。"
    echo ""
  fi

  echo "=== Staged diff stat ==="
  git -c color.ui=false diff --staged --stat
  echo ""

  # repo 可能是含斜線的子路徑（例：worktree wt/frontend-devout），
  # 斜線會被當成目錄分隔導致寫檔失敗；統一把斜線換成 __ 當檔名 slug。
  local repo_slug="$(tmp_repo_slug "$repo")"
  local hash_file
  hash_file="$(staged_hash_file)"

  # 重新 prepare 代表要重新送審，上一輪的審查紀錄、diff hash、放行旗標一律作廢（下面的內容閘沒過也一樣）。
  rm -f "$(review_record_file "$repo_slug")" "$hash_file" "$(prepare_allow_file)"

  # 內容閘提前到送審前（2026-10-16 使用回饋）：原本只在 ship 才擋，兩軌審完才被 AI 痕跡擋下，
  # 改完註解 diff hash 就變了，要整個重審一輪。改在這裡擋，沒過就不產生 diff hash（送不了審）。
  # 子 shell 執行：三道閘都跑完、一次列出全部命中，不會修一個才看到下一個。ship 仍會再檢查一次。
  echo "--- 內容閘（敏感字／建置產物／AI 痕跡，ship 前會再查一次）---"
  local gate_fail=0
  ( assert_no_sensitive "$allow_sensitive" ) || gate_fail=1
  ( assert_no_artifacts "$allow_artifacts" ) || gate_fail=1
  ( assert_no_ai_trace "$allow_ai_trace" ) || gate_fail=1
  if [ "$gate_fail" -eq 1 ]; then
    echo "" >&2
    echo "ERROR: 內容閘沒過，未產生 diff hash，這一份不能送審。" >&2
    echo "       改掉後重跑同一條 prepare；確認是誤判，在 prepare 加對應的 --allow-sensitive／--allow-artifacts／--allow-ai-trace。" >&2
    echo "       （檔案已 stage，重跑 prepare 列同一批檔即可）" >&2
    exit 1
  fi
  echo "(pass)"
  echo ""

  local diff_file="$TMP_DIR/staged-$repo_slug.diff"
  git -c color.ui=false diff --staged > "$diff_file"
  local lines
  lines=$(wc -l < "$diff_file" | tr -d ' ')
  echo "Staged diff saved: $diff_file ($lines lines)"

  # TOCTOU 防護：記錄「被審查的這份 staged diff」的 hash。
  # ship 會重算當下 staged diff 的 hash 並比對，不符即拒——確保 commit 的內容
  # 就是三軌審查看過的那份，中間若 index 被改動（AI 再 add、多 repo 交錯）會被擋下。
  local current_hash
  current_hash="$(git -c color.ui=false diff --staged | git hash-object --stdin)"
  printf '%s\n' "$current_hash" > "$hash_file"
  echo "Staged diff hash saved: $hash_file ($current_hash)"
  if [ "$allow_sensitive$allow_artifacts$allow_ai_trace" != "000" ]; then
    {
      echo "diff_hash=$current_hash"
      [ "$allow_sensitive" -eq 1 ] && echo "allow-sensitive"
      [ "$allow_artifacts" -eq 1 ] && echo "allow-artifacts"
      [ "$allow_ai_trace" -eq 1 ] && echo "allow-ai-trace"
      true
    } > "$(prepare_allow_file)"
  fi

  # 審查輪數：同一批改動每 prepare 一次加 1，commit 成功才歸零。
  # 「同一批」＝上一輪 staged 的檔這一輪都還在（修 BLOCK 時檔會留在 index，可能再多幾個）。
  # 上一輪的檔有任何一個不在了，就當成新的一批，輪數歸零——涵蓋 --staged 模式、
  # 以及「留一個舊檔、加上不相干的新檔」（第二輪對抗審查實跑：只看 index 是否為空，這兩條都繞得過）。
  # HEAD 變了也算新的一批：上一批在流程外被 commit 掉（使用者在 IDE 自己 commit）時，
  # 檔名清單可能剛好對得上（第三輪對抗審查實跑）。
  local files_now files_file gone head_now head_file
  files_file="$(round_files_file)"
  head_file="$(repo_state_dir)/round-head"
  head_now="$(git rev-parse -q --verify HEAD 2>/dev/null || echo none)"
  files_now="$(git -c core.quotePath=false diff --cached --name-only | sort)"
  # 是不是同一批，沿用 git add 之前判的 same_batch（同一個結論，見上方同類重複閘）。
  if [ -f "$head_file" ] || [ -f "$files_file" ]; then
    [ "$same_batch" -eq 1 ] || reset_review_rounds
  fi
  printf '%s\n' "$files_now" > "$files_file"
  printf '%s\n' "$head_now" > "$head_file"
  local round
  round=$(( $(current_round) + 1 ))
  # --redo（上一輪沒送審就重送）不加輪數：同一輪重新準備，不能拿來跳過 BLOCK 類別紀錄去開新的一輪。
  # 留在流水帳，事後查得到。
  if [ "$redo" -eq 1 ] && [ "$(current_round)" -ge 1 ] && [ "$(recorded_round)" != "$(current_round)" ]; then
    round="$(current_round)"
    [ -f "$REVIEW_LOG" ] || printf 'recorded_at\trepo\tdiff_hash\tmode\tcodex\treviewer\texempt_reason\tqa\tallow_overrides\n' > "$REVIEW_LOG"
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$(tmp_repo_key "$repo")" "$current_hash" "redo" "-" "-" "第 $round 輪未送審就重新準備" "-" "-" >> "$REVIEW_LOG"
  fi
  printf '%s\n' "$round" > "$(review_round_file)"
  local ticket_id
  ticket_id="$(issue_review_ticket "$round" "$current_hash")"
  echo ""
  echo "=== 審查第 $round 輪 ==="
  echo "審查單：$ticket_id——派工 prompt 第一行照抄下面那一行（hook 靠它把回覆原文存回這個 repo，見 SKILL.md 1.3）："
  echo "  B 軌 Codex：      [git-commit 審查單 $ticket_id codex]"
  echo "  C 軌 reviewer：   [git-commit 審查單 $ticket_id reviewer]"
  echo "  極端情境仲裁：    [git-commit 審查單 $ticket_id arbiter]（只在要走 --edge 時派，見 SKILL.md 1.4）"
  if [ "$REVIEW_ASK_ROUND" -gt 0 ] && [ "$round" -ge "$REVIEW_ASK_ROUND" ]; then
    echo "⚠ 已到第 $round 輪（門檻 $REVIEW_ASK_ROUND，${COMMIT_CONF:-設定檔} 設定）。這輪兩軌若仍有 BLOCK："
    echo "   - 認為 BLOCK 的全是極端情境或誤報 → 派 Codex 仲裁，回 RULING: EDGE 再用 review-record --edge（AI 不自己判）"
    echo "   - 其他情況 → 停下來把剩下的項目用白話列給使用者，請使用者決定修或記進交接；不要自己繼續修下一輪"
  elif [ "$round" -ge 3 ]; then
    echo "⚠ 已到第 $round 輪。這輪兩軌若仍有 BLOCK：以正確性為準——"
    echo "   - 還有一般問題（含資安、資料遺失、正常流程會壞）→ 按類別一次修完、重跑 prepare、兩軌重送，不要停下來問使用者"
    echo "   - 同一類別前幾輪出現過 → 逐案補收斂不了，改架構／判準讓這類一次涵蓋（review-record --block-classes 會擋）"
    echo "   - 認為 BLOCK 的全是極端情境或誤報 → 派 Codex 仲裁，回 RULING: EDGE 再用 review-record --edge（AI 不自己判）"
  fi
  echo ""

  print_reviewer_addendum
}

# 把 prepare 記下的放行旗標套到呼叫端的 allow_* 變數（bash 動態作用域：設的是 ship／amend 的 local）。
apply_prepare_allows() {
  local pa
  while IFS= read -r pa; do
    case "$pa" in
      allow-sensitive) allow_sensitive=1 ;;
      allow-artifacts) allow_artifacts=1 ;;
      allow-ai-trace) allow_ai_trace=1 ;;
    esac
  done < <(prepare_allows)
}

# prepare 記下的放行旗標：檔案存在且 diff hash 等於當下 staged 時，印出旗標名稱（每行一個）。
prepare_allows() {
  local f current
  f="$(prepare_allow_file)"
  [ -f "$f" ] || return 0
  current="$(git -c color.ui=false diff --staged | git hash-object --stdin)"
  [ "$(read_marker_line "$f" 1)" = "$current" ] || return 0
  tail -n +2 "$f" | tr -d '\r'
}

# C 軌的專案附加審查要求：通用範本不會帶專案專屬步驟（例：Supplier_Code 的 rule-scan），
# 專案把要求寫進工作目錄層的這份檔，prepare 時原文印出，由 AI 逐字貼進 C 軌 prompt。
REVIEWER_ADDENDUM_FILE="$WORKSPACE_DIR/.claude/git-commit-reviewer-addendum.md"
print_reviewer_addendum() {
  # 同名路徑是資料夾（誤建）時先攔下來講清楚：Git Bash 上空資料夾的 -s 為假，會被靜默當成「無」；
  # 資料夾大小不為 0 的平台可能反而走進 cat 而中斷 prepare（未實測）。兩種都不該發生。
  if [ -e "$REVIEWER_ADDENDUM_FILE" ] && [ ! -f "$REVIEWER_ADDENDUM_FILE" ]; then
    echo "WARNING: $REVIEWER_ADDENDUM_FILE 存在但不是一般檔案（可能誤建成資料夾），C 軌專案附加審查要求未讀到；請改成 Markdown 檔。" >&2
    echo "C 軌專案附加審查要求：無（路徑不是檔案，見上方 WARNING）"
    return 0
  fi
  if [ -s "$REVIEWER_ADDENDUM_FILE" ]; then
    echo "--- C 軌專案附加審查要求（$REVIEWER_ADDENDUM_FILE）：整段逐字貼進 C 軌 prompt 的【專案附加審查要求】---"
    cat "$REVIEWER_ADDENDUM_FILE"
    # 檔尾沒換行時補一行，結束標記才不會黏在最後一行後面
    [ -z "$(tail -c 1 "$REVIEWER_ADDENDUM_FILE")" ] || echo
    echo "--- 附加審查要求結束 ---"
  else
    echo "C 軌專案附加審查要求：無（$REVIEWER_ADDENDUM_FILE 不存在或為空，C 軌 prompt 刪掉【專案附加審查要求】那段）"
  fi
}

# 推目前分支。有 upstream 就 git push；沒有（新開的分支第一次推）就 git push -u <remote> HEAD，
# 否則 git push 會回「no upstream branch」而失敗（2026-10-16 使用回饋：新分支第一次 push 必敗，
# AI 改自己組 push 指令，commit 失敗後照樣推出去，在遠端留下空分支）。
# remote 依序取 branch.<分支>.pushRemote、remote.pushDefault、origin、唯一的那個 remote；都沒有就報錯不猜。
push_current_branch() {
  if git rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1; then
    git push
    return $?
  fi
  local branch remote remotes
  if ! branch="$(git symbolic-ref --short -q HEAD)"; then
    echo "ERROR: 目前是 detached HEAD，沒有分支可推。" >&2
    return 1
  fi
  remote="$(git config --get "branch.$branch.pushRemote" 2>/dev/null || git config --get remote.pushDefault 2>/dev/null || true)"
  if [ -z "$remote" ]; then
    remotes="$(git remote)"
    if printf '%s\n' "$remotes" | grep -qx origin; then
      remote=origin
    elif [ -n "$remotes" ] && [ "$(printf '%s\n' "$remotes" | wc -l | tr -d ' ')" = "1" ]; then
      remote="$remotes"
    else
      echo "ERROR: 分支 $branch 沒有 upstream，且無法決定推到哪個 remote（remote：${remotes:-（無）}）。" >&2
      echo "       請使用者指定後：git -C \"$(pwd)\" push -u <remote> HEAD" >&2
      return 1
    fi
  fi
  echo "[git-commit] 分支 $branch 沒有 upstream，改用 git push -u $remote HEAD"
  git push -u "$remote" HEAD
}

# ------------------------------------------------------------
# Command: ship <repo> <type> <description> [--push]
#   git commit (HEREDOC) → 驗證結果；帶 --push 才推遠端
#   預設 local commit only：push 是不可逆的對外動作，必須使用者當次明確核可。
# ------------------------------------------------------------

cmd_ship() {
  # 解析旗標：--allow-sensitive（顯式授權保留敏感字）、--allow-artifacts（顯式授權版控建置產物）、
  # --allow-ai-trace（顯式授權保留文件出處引用，例如引用的是公開標準而非內部文件）。
  local allow_sensitive=0
  local allow_artifacts=0
  local allow_ai_trace=0
  # 真閘 6 的豁免：痕跡判準是文字比對，必然有誤判（業務詞彙撞上作業過程用語）。
  # 沒有出口＝誤判時使用者完全無法 commit，與 hook 端 fail-open 的設計目標矛盾。
  local allow_message_trace=0
  # 預設只做 local commit。push 是對外動作、不可逆（推出去就在遠端歷史上），
  # 必須由使用者當次明確核可才做——故設計成顯式 --push 才推，不提供「預設推」的路徑。
  local do_push=0
  # 內文（第二行以後）：選填，一兩句 diff 看不出來、接手的人一定要知道的事。
  local body=""
  local positional=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --allow-sensitive) allow_sensitive=1; shift ;;
      --allow-artifacts) allow_artifacts=1; shift ;;
      --allow-ai-trace) allow_ai_trace=1; shift ;;
      --allow-message-trace) allow_message_trace=1; shift ;;
      --push) do_push=1; shift ;;
      --body)
        [ $# -lt 2 ] && { echo "ERROR: --body 後面缺內容。" >&2; exit 1; }
        body="$(normalize_body "$2")"; shift 2 ;;
      *) positional+=("$1"); shift ;;
    esac
  done
  set -- "${positional[@]:-}"

  local repo="${1:-}"
  local type="${2:-}"
  local desc="${3:-}"
  if [ -z "$repo" ] || [ -z "$type" ] || [ -z "$desc" ]; then
    echo "Usage: flow.sh ship <repo> <type> <description> [--body \"<一兩句>\"] [--push] [--allow-sensitive] [--allow-artifacts] [--allow-ai-trace] [--allow-message-trace]" >&2
    exit 1
  fi
  assert_valid_repo "$repo"

  local repo_path
  repo_path="$(resolve_repo_path "$repo")"
  load_commit_conf "$repo_path"
  cd "$repo_path"

  # === 真閘 1＋6：Type、署名＋單行、message 痕跡＋長度、內文 ===
  # 位置在 TOCTOU 之前：message 有問題就沒必要往下算 hash。
  # 預覽前先跑 flow.sh check-msg 就不會到這一步才被擋。
  check_message "$type" "$desc" "$body" "$allow_message_trace"
  local subject
  subject="$(compose_subject "$type" "$desc")"

  # prepare 時帶過的 --allow-*（綁定同一份 diff hash）沿用，不必在 ship 再帶一次
  apply_prepare_allows

  # === Push-only 分支：ship（無 --push）完成 commit 後，staged 已空、hash 必不符，
  #     原「重跑同指令加 --push」的指引會被真閘 2 擋死（2026-08-10 實測）。
  #     四條件全符才視為「補推先前已 commit 的那筆」，跳過 commit 直接 push；
  #     任一不符即落回原流程（照樣被真閘擋，不放水）。
  if [ "$do_push" -eq 1 ] && git diff --staged --quiet; then
    local head_subject
    head_subject="$(git log -1 --format=%s)"
    if [ "$head_subject" = "$subject" ] && [ -n "$(git log @{u}..HEAD --oneline 2>/dev/null || echo pending)" ]; then
      # subject 相同不代表內容相同：reset --soft 換掉內容、沿用同一句 message 重新 commit，
      # 就能讓一顆沒審過的 commit 走這條捷徑推出去。所以只認 ship／amend 當初記下的那顆 sha。
      local marker head_sha shipped_commit shipped_repo
      marker="$(shipped_marker_file "$(tmp_repo_slug "$repo")")"
      head_sha="$(git rev-parse HEAD)"
      shipped_commit="$(read_marker_line "$marker" 1)"
      shipped_repo="$(read_marker_line "$marker" 2)"
      if [ "$shipped_commit" != "$head_sha" ] || [ "$shipped_repo" != "$(repo_identity)" ]; then
        echo "ERROR: HEAD 的 message 相同，但不是 flow.sh ship／amend 建出的那顆 commit，拒絕直接推。" >&2
        echo "       HEAD：$head_sha" >&2
        echo "       最後一次 ship 建出的：${shipped_commit:-（無紀錄）}" >&2
        echo "       內容可能在 commit 後被換過（例如 reset --soft 後沿用同一句 message 重新 commit）。" >&2
        echo "       要推的內容請重新走 prepare → 兩軌 → review-record → ship。" >&2
        exit 1
      fi
      echo "=== Push-only：偵測到同 message 的未推 commit，跳過 commit 直接推 ==="
      local push_only_rc=0
      if push_current_branch; then
        rm -f "$(staged_hash_file)" "$TMP_DIR/staged-$(tmp_repo_slug "$repo").diff" "$marker" "$(prepare_allow_file)"
      else
        push_only_rc=$?
        echo "ERROR: push 失敗（exit $push_only_rc）。處置同主流程：pull --rebase 後重推，禁止 force。" >&2
        exit "$push_only_rc"
      fi
      echo "=== Verify ==="
      git -c color.ui=false status -sb | head -2
      echo "--- last commit ---"
      git -c color.ui=false log --oneline -1
      return 0
    fi
  fi

  # === 真閘 2：TOCTOU — 比對當下 staged diff 與 prepare 時被審查的那份 ===
  local repo_slug="$(tmp_repo_slug "$repo")"
  local hash_file
  hash_file="$(staged_hash_file)"
  if [ -f "$hash_file" ]; then
    local expected current
    expected="$(tr -d '\r' < "$hash_file")"
    current="$(git -c color.ui=false diff --staged | git hash-object --stdin)"
    if [ "$expected" != "$current" ]; then
      echo "ERROR: staged diff 與 prepare 時被審查的版本不符，已拒絕 commit。" >&2
      echo "       審查版 hash：$expected" >&2
      echo "       當前版 hash：$current" >&2
      echo "       請重跑 prepare + 三軌審查，確保 commit 的就是被審查的內容。" >&2
      exit 1
    fi
  else
    echo "WARNING: 找不到 prepare 產生的 diff hash（$hash_file），跳過 TOCTOU 校驗。建議先跑 prepare。" >&2
  fi

  # === 真閘 7：審查紀錄 — 這份 staged diff 要先有兩軌結果或使用者豁免 ===
  check_review_recorded "$repo" "$repo_slug" "commit" || exit 1

  # === 真閘 3：敏感字掃描（命中即 exit 1，除非 --allow-sensitive）===
  assert_no_sensitive "$allow_sensitive"

  # === 真閘 4：檔名黑名單（建置產物/快取/備份，除非 --allow-artifacts）===
  assert_no_artifacts "$allow_artifacts"

  # === 真閘 5：AI 痕跡（註解引用外部文件出處，除非 --allow-ai-trace）===
  assert_no_ai_trace "$allow_ai_trace"

  echo "=== Commit ==="
  # message 禁止任何 AI 署名——已由 check_message 機制級攔截（subject 與內文都掃）。
  if [ -n "$body" ]; then
    git commit -m "$subject" -m "$body"
  else
    git commit -m "$subject"
  fi
  # 紀錄只對這一顆 commit 有效，用完即清；改記下建出的 commit，供之後補推比對。
  rm -f "$(review_record_file "$repo_slug")" "$(prepare_allow_file)"
  reset_review_rounds
  mark_shipped "$repo_slug"
  echo ""

  if [ "$do_push" -eq 0 ]; then
    echo "=== Push: 略過（local commit only）==="
    echo "  本次只在本地 commit，未推上遠端。"
    echo "  要推請在使用者明確核可後，重跑同一條指令並加 --push："
    echo "    flow.sh ship $repo $type \"$desc\" --push"
    echo ""
    # 未 push 不算完成，保留 diff hash 與 staged diff 供後續 --push 時比對／人接手。
    echo "=== Verify ==="
    git -c color.ui=false status
    echo "--- last commit ---"
    git -c color.ui=false log -1 --oneline
    return 0
  fi

  echo "=== Push ==="
  # push 可能因遠端有新 commit 被拒（non-fast-forward）。用 if 攔住，避免 set -e 直接中止
  # 而留下「已 commit、未 push」的懸置狀態卻無下一步指引（AI 易自行裸跑 pull / push -f）。
  local push_rc=0
  if push_current_branch; then
    echo ""
    # commit+push 都成功才清本次 diff hash，避免下次沿用舊 hash 誤判。
    rm -f "$hash_file" "$TMP_DIR/staged-$repo_slug.diff" "$(shipped_marker_file "$repo_slug")"
  else
    push_rc=$?
    echo "" >&2
    echo "ERROR: push 失敗（exit $push_rc）。commit 已在本地完成，但尚未推上遠端。" >&2
    echo "  最可能原因：遠端有你本地沒有的新 commit（non-fast-forward）。" >&2
    echo "  正確處置（依序，禁止 force push / 禁止 -f）：" >&2
    echo "    1. git -C \"$repo_path\" pull --rebase" >&2
    echo "    2. 解決衝突（若有）後，git -C \"$repo_path\" push" >&2
    echo "  保留本次 diff hash（未清），push 成功前狀態不算完成。" >&2
    # 不清 hash：這次 ship 未達成完成狀態，保留供人接手；但不刪 commit（那是難逆操作，交人決定）。
    exit "$push_rc"
  fi

  echo "=== Verify ==="
  git -c color.ui=false status
  echo "--- last commit ---"
  git -c color.ui=false log --oneline -1
}

# ------------------------------------------------------------
# amend — 改寫 HEAD（SKILL.md 歷史改寫章節的機制化實作）
#
# 為什麼需要這支：該章節允許 amend 並訂了六條規則（備份分支／三軌／未 push 才可改寫／
# 改寫後機械驗證），但本腳本原先未實作 amend，唯一走法是繞過 PreToolUse hook 裸跑
# git commit --amend——繞過之後那六條規則沒有任何機制檢查，與 hook「規範是自律、
# 只有 hook 是他律」的設計目標矛盾。本子命令把那六條變成可執行的閘，並沿用 ship 的既有真閘。
#
# 刻意不提供：已 push 的 commit 改寫（需 force push）。那是要停下來問人的情境，
# 不是給旗標就放行——force push 會改寫別人已經拉過的歷史。
# ------------------------------------------------------------
cmd_amend() {
  local allow_sensitive=0
  local allow_artifacts=0
  local allow_ai_trace=0
  local allow_message_trace=0
  # 改寫歷史不可逆（舊 hash 之後只剩 reflog 可尋），故要求使用者當次明示。
  # 與 --push 同一種設計：不提供「預設改寫」的路徑。
  local confirm_rewrite=0
  local new_type=""
  local new_desc=""
  local new_body="" has_body=0
  local positional=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --allow-sensitive) allow_sensitive=1; shift ;;
      --allow-artifacts) allow_artifacts=1; shift ;;
      --allow-ai-trace) allow_ai_trace=1; shift ;;
      --allow-message-trace) allow_message_trace=1; shift ;;
      --confirm-rewrite) confirm_rewrite=1; shift ;;
      # 缺值時 shift 2 在 set -e 下會無聲中止，先檢查
      --type|--desc|--body)
        [ $# -lt 2 ] && { echo "ERROR: $1 後面缺內容。" >&2; exit 1; }
        case "$1" in
          --type) new_type="$2" ;;
          --desc) new_desc="$2" ;;
          --body) new_body="$(normalize_body "$2")"; has_body=1 ;;
        esac
        shift 2 ;;
      *) positional+=("$1"); shift ;;
    esac
  done
  set -- "${positional[@]:-}"

  local repo="${1:-}"
  if [ -z "$repo" ]; then
    echo "Usage: flow.sh amend <repo> --confirm-rewrite [--type <Type> --desc <描述> [--body \"<一兩句>\"]] [--allow-*]" >&2
    echo "  不帶 --type/--desc：沿用 HEAD 既有 message（含內文）" >&2
    exit 1
  fi
  assert_valid_repo "$repo"
  load_commit_conf "$(resolve_repo_path "$repo")"

  if [ "$confirm_rewrite" -eq 0 ]; then
    echo "ERROR: amend 會改寫既有 commit（舊 hash 之後只剩 reflog 可尋），屬不可逆操作。" >&2
    echo "       需使用者當次明確核可後，加 --confirm-rewrite 重跑。" >&2
    exit 1
  fi

  local repo_path
  repo_path="$(resolve_repo_path "$repo")"
  cd "$repo_path"

  # === amend 閘 1：目標 commit 必須未 push ===
  # 已 push 的 commit 改寫後只能 force push，會改寫別人拉過的歷史。
  #
  # 兩段判斷，缺一不可：
  #   ① 本地遠端追蹤 ref（branch -r --contains）——快，但只反映「上次 fetch 當下」的遠端狀態。
  #      自己剛 push 完、或別人推了而本地沒 fetch，這段都會回空（實測：push 過的 commit 判回空）。
  #   ② ls-remote 實查遠端——要連網，但看的是遠端此刻的真實狀態。
  # 只靠 ① 會放行已推出去的 commit，這是本閘最不能出的錯，故補 ②。
  local remote_branches
  remote_branches="$(git branch -r --contains HEAD 2>/dev/null || true)"
  if [ -n "$remote_branches" ]; then
    echo "ERROR: HEAD 已存在於遠端分支，禁止 amend（改寫後只能 force push，會改寫他人已拉取的歷史）。" >&2
    echo "       HEAD 出現在：" >&2
    printf '%s\n' "$remote_branches" | sed 's/^/         /' >&2
    echo "       正解：改成新的一顆 commit（flow.sh ship）。" >&2
    echo "       真要改寫已推出去的歷史：停下來問使用者，確認無人共用該分支後由人工處理。" >&2
    exit 1
  fi

  # ② 本地 ref 說沒推過，再跟每個遠端實查一次——本地 ref 可能過期
  local remotes
  remotes="$(git remote 2>/dev/null || true)"
  if [ -n "$remotes" ]; then
    local head_sha r ls_out ls_rc
    head_sha="$(git rev-parse HEAD)"
    for r in $remotes; do
      # ls_rc 要用 || 接住：本函式在 set -e 下執行，
      # 直接寫 ls_out="$(git ls-remote ...)" 失敗時會整支中止，
      # 下面的錯誤說明與 fail-closed 分支永遠執行不到。
      ls_rc=0
      ls_out="$(git ls-remote --heads --tags "$r" 2>/dev/null)" || ls_rc=$?
      if [ "$ls_rc" -ne 0 ]; then
        echo "ERROR: 無法查詢遠端 $r 的狀態（git ls-remote 失敗，exit $ls_rc），無法確認 HEAD 是否已 push。" >&2
        echo "       本閘不在查不到時放行——改寫已推出去的 commit 需要 force push，代價太高。" >&2
        echo "       確認網路/認證後重試；確定未推出去也可改走 flow.sh ship 建新 commit。" >&2
        exit 1
      fi
      # 遠端 ref 的 tip 剛好等於 HEAD
      if printf '%s' "$ls_out" | grep -q "^$head_sha[[:space:]]"; then
        echo "ERROR: HEAD 在遠端 $r 實查中命中，禁止 amend（本地遠端追蹤 ref 未更新才沒擋在上一關）。" >&2
        echo "       HEAD: $head_sha" >&2
        printf '%s\n' "$ls_out" | grep "^$head_sha[[:space:]]" | sed 's/^/         /' >&2
        echo "       正解：改成新的一顆 commit（flow.sh ship）。" >&2
        exit 1
      fi
      # tip 不等於 HEAD，但 HEAD 可能已在遠端分支的歷史裡（別人又推了新 commit 上去）。
      # 只比對 tip 會漏掉這種情況，而那顆 commit 其實早就在遠端、改寫它一樣要 force push。
      # 逐個遠端 tip 往回找 HEAD 是否在其祖先鏈上。
      # merge-base --is-ancestor 的 exit code 是三態，不能只分真假：
      #   0   = 是祖先          → 擋
      #   1   = 不是祖先        → 這個 tip 過關，看下一個
      #   128 = 物件不在本地    → 查不動，不能當成「不是祖先」
      # 遠端 tip 沒 fetch 下來時就是 128，而那正是「別人推了新 commit、我方 HEAD
      # 已在遠端歷史裡」的典型情況——當成「不是」會放行掉真正該擋的改寫。
      local tip mb_rc
      while read -r tip _; do
        [ -z "$tip" ] && continue
        mb_rc=0
        git merge-base --is-ancestor "$head_sha" "$tip" 2>/dev/null || mb_rc=$?
        if [ "$mb_rc" -eq 0 ]; then
          echo "ERROR: HEAD 已存在於遠端 $r 的歷史中（不是 tip，但在其祖先鏈上），禁止 amend。" >&2
          echo "       HEAD: $head_sha" >&2
          echo "       遠端上包含它的 commit: $tip" >&2
          echo "       正解：改成新的一顆 commit（flow.sh ship）。" >&2
          exit 1
        fi
        if [ "$mb_rc" -ne 1 ]; then
          echo "ERROR: 無法判斷 HEAD 是否在遠端 $r 的歷史中（merge-base exit $mb_rc，" >&2
          echo "       多半是遠端 commit $tip 尚未 fetch 到本地）。" >&2
          echo "       本閘不在查不動時放行——那正是「別人推了新 commit、我方 HEAD 已在遠端歷史裡」的情況。" >&2
          echo "       請先 git fetch $r 後重試；確定未推出去也可改走 flow.sh ship 建新 commit。" >&2
          exit 1
        fi
      done <<EOF
$ls_out
EOF
    done
  fi

  # root commit 沒有 parent，改寫後無法驗證基底未變
  if ! git rev-parse HEAD^ >/dev/null 2>&1; then
    echo "ERROR: HEAD 是 root commit，本子命令不支援（無 parent 可驗證基底未變）。" >&2
    exit 1
  fi

  # === 決定最終 message：沿用既有，或以 --type/--desc 覆寫 ===
  local final_msg
  if [ -n "$new_type" ] || [ -n "$new_desc" ]; then
    if [ -z "$new_type" ] || [ -z "$new_desc" ]; then
      echo "ERROR: --type 與 --desc 必須成對提供（只給一個組不出完整 message）。" >&2
      exit 1
    fi
    # === 真閘 1 + 真閘 6：新 message 要過 Type／署名／單行／痕跡／寬度／內文 ===
    check_message "$new_type" "$new_desc" "$new_body" "$allow_message_trace"
    final_msg="$(compose_subject "$new_type" "$new_desc")"
    [ -n "$new_body" ] && final_msg="$final_msg

$new_body"
  else
    if [ "$has_body" -eq 1 ]; then
      echo "ERROR: --body 要跟 --type／--desc 一起給（沿用既有 message 時不改內文）。" >&2
      exit 1
    fi
    # 沿用既有 message：讀 %B 全文而非 %s。只取 subject 會把原 commit 的 body 與
    # trailer（Refs:、Fixes: 等）靜默刪光——使用者以為只是重新 commit，卻掉了資訊。
    final_msg="$(git log -1 --format=%B)"
    local subject
    subject="$(git log -1 --format=%s)"

    # 署名要掃「整份 message」（body 裡也可能夾帶），但 assert_no_signature 同時做單行檢查，
    # 對本來就合法的多行既有 message 會誤擋——故此處拆開：署名掃全文、單行檢查只對 subject。
    if has_signature "$final_msg"; then
      echo "ERROR: HEAD 的 message 含 AI 署名，拒絕沿用（使用者全域規則：禁止任何 Claude 署名）。" >&2
      scan_normalize "$final_msg" | grep -E -i "$SIGNATURE_PATTERN" | sed 's/^/         /' >&2
      echo "       請用 --type <Type> --desc <描述> 指定乾淨的新 message。" >&2
      exit 1
    fi

    # 必須是「Type: 描述」格式。缺冒號時 ${x#*: } 會原樣回傳整串，
    # 不檢查就等於讓不合規的既有 message 原地漂白。
    # 設定檔 types= 列了 none 時，開頭不是合法 Type 的整行就當成無前綴的描述。
    local existing_type="" existing_desc=""
    case "$subject" in
      *": "*) existing_type="${subject%%: *}"; existing_desc="${subject#*: }" ;;
    esac
    # none 只代表「不加前綴」，字面寫成 `none: …` 不是合法 Type（第 20 輪 Codex：audit／amend 原本放過、ship 卻拒收）
    if [ "$existing_type" = "none" ]; then
      echo "ERROR: HEAD 的 message 以「none:」開頭；none 是「不加前綴」的意思，不能當 Type 寫進 subject：" >&2
      echo "         $subject" >&2
      if type_allowed none; then
        echo "       請用 --type <Type> --desc <描述>（或 --type none --desc <描述> 不加前綴）明確指定新 message。" >&2
      else
        echo "       請用 --type <Type> --desc <描述> 明確指定新 message（這個 repo 的 types 沒有列 none，不能不加前綴）。" >&2
      fi
      exit 1
    elif [ -n "$existing_type" ] && type_allowed "$existing_type"; then
      :
    elif type_allowed none && ! looks_like_type_prefix "$subject"; then
      existing_type=none; existing_desc="$subject"
    elif [ -z "$existing_type" ]; then
      echo "ERROR: HEAD 的 message 不是「Type: 描述」格式，無法沿用：" >&2
      echo "         $subject" >&2
      echo "       請用 --type <Type> --desc <描述> 明確指定新 message。" >&2
      exit 1
    fi
    assert_valid_type "$existing_type"
    assert_message_clean "$existing_desc" "$allow_message_trace"
    # 既有內文：署名上面已掃；痕跡也要掃（可用 --allow-message-trace 放行），否則沿用 message 的 amend
    # 會成為把作業過程敘述留在內文的旁路（Codex 審查指出）。行數與寬度不套用：
    # 舊 commit 的 trailer（Refs:、Fixes: 接長網址）是合法內容，不該因此擋下 amend。
    local existing_body
    existing_body="$(normalize_body "$(git log -1 --format=%b)")"
    if [ -n "$existing_body" ] && printf '%s\n' "$existing_body" | grep -E -c "$MESSAGE_TRACE_PATTERN" >/dev/null; then
      if [ "$allow_message_trace" = "1" ]; then
        echo "[git-commit] HEAD 內文痕跡命中，但已帶 --allow-message-trace，放行。" >&2
      else
        echo "ERROR: HEAD 的內文含 AI 痕跡或作業過程敘述，無法沿用：" >&2
        printf '%s\n' "$existing_body" | grep -E -o "$MESSAGE_TRACE_PATTERN" | sort -u | sed 's/^/         /' >&2
        echo "       請用 --type <Type> --desc <描述> [--body …] 指定新 message；確認是業務詞彙誤判則加 --allow-message-trace。" >&2
        exit 1
      fi
    fi
  fi

  # === amend 閘 2：自動建備份分支 ===
  local backup_branch="backup/pre-amend-$(date +%Y%m%d-%H%M%S)"
  git branch "$backup_branch"
  echo "=== 備份分支已建立：$backup_branch ==="
  echo "    改寫前的 HEAD：$(git rev-parse --short "$backup_branch")"
  echo ""

  local repo_slug="$(tmp_repo_slug "$repo")"
  local hash_file
  hash_file="$(staged_hash_file)"
  local has_staged=0
  git diff --staged --quiet || has_staged=1

  if [ "$has_staged" -eq 1 ]; then
    # prepare 時帶過的 --allow-*（綁定同一份 diff hash）沿用
    apply_prepare_allows
    # === 真閘 2：TOCTOU — 比對當下 staged diff 與 prepare 時被審查的那份 ===
    # 與 ship 不同：ship 在找不到 hash 時只印 WARNING 放行，amend 一律拒絕。
    # 理由是風險不對稱——ship 寫壞了還留在 git 歷史上可回溯，amend 是就地改寫，
    # 放行等於「直接呼叫 amend 即可跳過審查版本比對」，六道閘形同虛設。
    if [ ! -f "$hash_file" ]; then
      echo "ERROR: 找不到 prepare 產生的 diff hash（$hash_file），拒絕 amend。" >&2
      echo "       有 staged 內容卻沒有審查基準，無法確認即將寫進去的就是被審查過的內容。" >&2
      echo "       請先跑：flow.sh prepare $repo <files...>" >&2
      git branch -D "$backup_branch" >/dev/null 2>&1 && echo "       （尚未改寫，已清掉剛建的備份分支 $backup_branch）" >&2
      exit 1
    fi
    local expected current
    expected="$(tr -d '\r' < "$hash_file")"
    current="$(git -c color.ui=false diff --staged | git hash-object --stdin)"
    if [ "$expected" != "$current" ]; then
      echo "ERROR: staged diff 與 prepare 時被審查的版本不符，已拒絕 amend。" >&2
      echo "       審查版 hash：$expected" >&2
      echo "       當前版 hash：$current" >&2
      echo "       請重跑 prepare + 三軌審查，確保 amend 進去的就是被審查的內容。" >&2
      # 此時還沒改寫任何東西，備份分支沒有保留價值，留著只會累積垃圾
      git branch -D "$backup_branch" >/dev/null 2>&1 && echo "       （尚未改寫，已清掉剛建的備份分支 $backup_branch）" >&2
      exit 1
    fi

    # === 真閘 7：審查紀錄 — 有改到碼的 amend 等同新 commit，同樣要兩軌結果或使用者豁免 ===
    if ! check_review_recorded "$repo" "$repo_slug" "amend"; then
      git branch -D "$backup_branch" >/dev/null 2>&1 && echo "       （尚未改寫，已清掉剛建的備份分支 $backup_branch）" >&2
      exit 1
    fi

    # === 真閘 3/4/5：敏感字、建置產物、AI 痕跡 ===
    # 三個閘失敗時直接 exit：放在子 shell 裡跑，才能在中止前清掉剛建的備份分支（commit 前第 14 輪 C 軌：原本會留下
    # 沒用的 backup/pre-amend-*；此時還沒改寫任何東西）
    # 三道各自跑完再判斷（不用 && 串）：一次列出全部命中，跟 prepare 一樣（第 15 輪 C 軌）
    local amend_gate_fail=0
    ( assert_no_sensitive "$allow_sensitive" ) || amend_gate_fail=1
    ( assert_no_artifacts "$allow_artifacts" ) || amend_gate_fail=1
    ( assert_no_ai_trace "$allow_ai_trace" ) || amend_gate_fail=1
    if [ "$amend_gate_fail" -ne 0 ]; then
      git branch -D "$backup_branch" >/dev/null 2>&1 && echo "       （尚未改寫，已清掉剛建的備份分支 $backup_branch）" >&2
      exit 1
    fi
  else
    echo "=== 無 staged 內容：本次為「只改 message」的 amend ==="
    echo ""
  fi

  # === 記錄改寫前狀態，供改寫後驗證 ===
  # 關鍵：期望樹要在「改寫前」用 staged 的內容算出來，不能在改寫後從 HEAD 取。
  # 從 HEAD 取等於拿結果去證明結果——pre-commit hook 若在 commit 當下改了檔案，
  # 比對的兩邊都會是被改後的值，等式恆成立，驗證永遠通過（實測：hook 偷加一行仍印「驗證通過」）。
  local before_tree before_parent expected_tree
  before_tree="$(git rev-parse "HEAD^{tree}")"
  before_parent="$(git rev-parse HEAD^)"
  # 此刻的 index 就是「應該被寫進去的內容」，直接落成 tree 當期望值
  expected_tree="$(git write-tree)"

  echo "=== Amend ==="
  # 失敗要自己接住：直接讓 set -e 中止的話，使用者看不到備份分支還在、也不知道現在是什麼狀態。
  # exit code 要在這裡抓：寫在 if 主體內的 $? 是 if 判斷本身的結果（恆為 0），
  # 而 local 宣告又會再覆寫一次 $?——兩者都會讓失敗回報成 exit 0。
  local amend_rc=0
  git commit --amend -m "$final_msg" || amend_rc=$?
  if [ "$amend_rc" -ne 0 ]; then
    echo "" >&2
    echo "ERROR: git commit --amend 失敗（exit $amend_rc），歷史未被改寫。" >&2
    echo "       常見原因：pre-commit hook 擋下、message 被 commit-msg hook 拒絕。" >&2
    echo "       HEAD 仍是原本那顆：$(git log -1 --format='%h %s')" >&2
    echo "       備份分支 $backup_branch 保留著（內容與 HEAD 相同，確認後可刪）：" >&2
    echo "         git branch -D $backup_branch" >&2
    exit "$amend_rc"
  fi
  rm -f "$(review_record_file "$repo_slug")" "$(prepare_allow_file)"
  [ "$has_staged" -eq 1 ] && reset_review_rounds
  # 只改 message 的 amend 不經紀錄閘：若原 HEAD 本來就不是 ship 建的（例如裸 merge 出來的），
  # 承接標記等於替沒審過的內容背書，之後就能走補推捷徑推出去。
  # 比 commit 之外也要比 repo 身分：slug 撞名的另一個 clone 可能有同一顆 HEAD，不能借它的標記。
  local marker_file
  marker_file="$(shipped_marker_file "$repo_slug")"
  if [ "$has_staged" -eq 1 ] || { [ "$(read_marker_line "$marker_file" 1)" = "$(git rev-parse "$backup_branch")" ] && [ "$(read_marker_line "$marker_file" 2)" = "$(repo_identity)" ]; }; then
    mark_shipped "$repo_slug"
  else
    rm -f "$(shipped_marker_file "$repo_slug")"
  fi
  echo ""

  # === amend 閘 3：改寫後機械驗證 ===
  # 期望樹（改寫前的 index）必須等於改寫後 HEAD 的樹。
  # tree hash 是整棵樹的 Merkle hash，相同即每個檔案每個 byte 都一致——
  # 這個比法天然涵蓋 rename、檔案刪除、模式變更（100644 vs 100755）與特殊檔名，
  # 不必自己解析 --name-only 的輸出（那條路會被 rename 只列目的路徑、
  # 中文檔名被印成八進位跳脫這兩件事各絆倒一次）。
  echo "=== 改寫後驗證 ==="
  local rc=0

  # 共同檢查：parent 不得改變（amend 不該動基底）
  local after_parent after_tree
  after_parent="$(git rev-parse HEAD^)"
  after_tree="$(git rev-parse "HEAD^{tree}")"
  if [ "$before_parent" != "$after_parent" ]; then
    echo "  [FAIL] parent 改變了：$before_parent -> $after_parent（amend 不該動基底）" >&2
    rc=1
  else
    echo "  [OK] parent 未變（$(git rev-parse --short "$after_parent")）"
  fi

  if [ "$expected_tree" = "$after_tree" ]; then
    if [ "$has_staged" -eq 0 ]; then
      echo "  [OK] 樹與改寫前一致（只改 message，tree $after_tree）"
    else
      echo "  [OK] 寫進去的內容等於改寫前的 staged 內容（tree $after_tree）"
      echo "       tree hash 為整棵樹的 Merkle hash，相同即每個檔案每個 byte 都一致"
    fi
  else
    echo "  [FAIL] 實際寫進去的內容與改寫前的 staged 不符" >&2
    echo "         預期樹（改寫前的 index）：$expected_tree" >&2
    echo "         實際樹（改寫後的 HEAD）：$after_tree" >&2
    echo "         最可能的原因是 pre-commit hook 在 commit 當下改了檔案。" >&2
    echo "         差異：git diff $expected_tree $after_tree" >&2
    rc=1
  fi

  if [ "$rc" -ne 0 ]; then
    echo "" >&2
    echo "ERROR: 改寫後驗證未通過。備份分支 $backup_branch 保留著，可用它還原：" >&2
    echo "         git reset --hard $backup_branch" >&2
    exit 1
  fi


  # 驗證通過才清 diff hash；staged diff 檔比照 ship 保留（未推不算完成）
  rm -f "$hash_file"

  echo ""
  echo "=== Push: 略過（amend 只做本地改寫）==="
  echo "  本次只改寫本地 commit，未推上遠端。"
  echo "  要推請在使用者明確核可後跑："
  echo "    flow.sh ship $repo <Type> \"<描述>\" --push"
  echo "  ship 會偵測到同 message 的未推 commit，走 push-only 分支。"
  echo ""
  echo "=== Verify ==="
  git -c color.ui=false status -sb | head -3
  echo "--- last commit ---"
  git -c color.ui=false log --oneline -1
  echo ""
  echo "備份分支 $backup_branch 保留著。確認無誤後可刪：git branch -D $backup_branch"
}


# ------------------------------------------------------------
# Command: audit <repo> [<range>]
#   體檢既有 commit 的 message：空 message / 缺 Type 前綴 / Type 不合法 /
#   超長 / 痕跡命中 / 軟清單命中。唯讀，不改動任何東西。
#   用途：交付 patch（format-patch / bundle）或推上游前先掃一次，
#         patch 檔內含完整 message 原文，會直接送到對方手上。
# ------------------------------------------------------------

cmd_audit() {
  local repo="${1:-}"
  [ -z "$repo" ] && { echo "Usage: flow.sh audit <repo> [<range>]" >&2; exit 1; }
  assert_valid_repo "$repo"
  local range="${2:-}"

  local repo_path
  repo_path="$(resolve_repo_path "$repo")"
  load_commit_conf "$repo_path"
  cd "$repo_path"

  # 預設範圍：有 upstream 就掃未推的，否則掃最近 20 顆
  if [ -z "$range" ]; then
    if git rev-parse --abbrev-ref '@{u}' >/dev/null 2>&1; then
      range="@{u}..HEAD"
      echo "=== audit: $repo（範圍 $range＝尚未推上遠端的 commit）==="
    else
      range="-20"
      echo "=== audit: $repo（無 upstream，掃最近 20 顆）==="
    fi
  else
    echo "=== audit: $repo（範圍 $range）==="
  fi

  # range 先驗證再掃——打錯的 range 會讓 git log 靜默回空，
  # 輸出「0 顆、exit 0」與「掃過且全乾淨」無法區分，使用者會以為體檢過了。
  if ! git -c color.ui=false log --format='%h' $range >/dev/null 2>&1; then
    echo "ERROR: 無效的 range：$range" >&2
    echo "       請確認分支／commit 是否存在（例：@{u}..HEAD、-20、abc123..HEAD）。" >&2
    return 2
  fi

  local total=0 bad=0 warn=0
  local valid_types_re
  # none 不是可寫進 subject 的前綴，`none: …` 要報 Type 不合法（第 20 輪 Codex）
  local vt
  valid_types_re=""
  for vt in "${VALID_TYPES[@]}"; do [ "$vt" = "none" ] || valid_types_re="${valid_types_re}${vt}|"; done
  valid_types_re="${valid_types_re%|}"
  [ -n "$valid_types_re" ] || valid_types_re="__no_prefix_type__"

  while IFS= read -r line; do
    [ -z "$line" ] && continue
    total=$((total + 1))
    local sha subject issues
    sha="${line%% *}"
    subject="${line#* }"
    issues=""

    # 空 message
    if [ -z "$subject" ] || [ "$subject" = "$sha" ]; then
      issues="${issues}空 message；"
    else
      # Type 前綴（設定檔 types= 列了 none 時，沒有合法前綴的整行就是描述本身）
      local desc width
      if printf '%s' "$subject" | grep -E -q "^($valid_types_re): "; then
        desc="${subject#*: }"
      elif type_allowed none && ! looks_like_type_prefix "$subject"; then
        desc="$subject"
      else
        desc="${subject#*: }"
        if printf '%s' "$subject" | grep -E -q '^[A-Za-z]+: '; then
          issues="${issues}Type 不在允許清單；"
        else
          issues="${issues}缺 Type 前綴；"
        fi
      fi
      # 長度（只算描述，不含 Type 前綴）
      width="$(display_width "$desc")"
      if [ "$width" -gt "$MESSAGE_MAX_WIDTH" ]; then
        issues="${issues}描述寬度 $width 超過 $MESSAGE_MAX_WIDTH；"
      fi
      # 痕跡
      if printf '%s' "$subject" | grep -E -q "$MESSAGE_TRACE_PATTERN"; then
        local th
        th="$(printf '%s' "$subject" | grep -E -o "$MESSAGE_TRACE_PATTERN" | sort -u | paste -sd " " -)"
        issues="${issues}痕跡命中［$th］；"
      fi
    fi

    # 內文：允許最多 BODY_MAX_LINES 行（ship --body），超過、單行過寬或含痕跡才算問題
    local body body_lines bl bw
    body="$(git log -1 --format=%b "$sha" | tr -d '\r')"
    # 跟 ship 的 assert_body_clean 同一算法：內文中間的空白行也算一行（第 35 輪 Codex：只數非空行，四行內文躲得過 audit）
    body_lines=0
    [ -z "$body" ] || body_lines="$(printf '%s\n' "$body" | wc -l | tr -d ' ')"
    if [ "$body_lines" -gt "$BODY_MAX_LINES" ]; then
      issues="${issues}內文 $body_lines 行（上限 $BODY_MAX_LINES）；"
    fi
    if [ "$body_lines" -gt 0 ]; then
      while IFS= read -r bl; do
        [ -z "$bl" ] && continue
        bw="$(display_width "$bl")"
        if [ "$bw" -gt "$MESSAGE_MAX_WIDTH" ]; then issues="${issues}內文有一行寬度 $bw 超過 $MESSAGE_MAX_WIDTH；"; break; fi
      done <<< "$body"
      if printf '%s' "$body" | grep -E -q "$MESSAGE_TRACE_PATTERN"; then
        issues="${issues}內文痕跡命中［$(printf '%s' "$body" | grep -E -o "$MESSAGE_TRACE_PATTERN" | sort -u | paste -sd " " -)］；"
      fi
    fi
    # AI 署名：跟 ship 同一套判準（has_signature，含 NFKC 與零寬字元正規化），整則 message 一起看。
    # 第 35 輪：audit 原本只比 MESSAGE_TRACE_PATTERN，`claude.ai/code`、🤖、noreply@anthropic 這類 ship 擋得下的署名 audit 看不到。
    if has_signature "$(git log -1 --format=%B "$sha" | tr -d '\r')"; then
      issues="${issues}含 AI 署名；"
    fi

    # 軟清單獨立判斷，不放在 else 分支——否則一顆同時「缺 Type」又命中軟清單的 commit
    # 只會報前者，使用者修完才看到後者，等於要跑兩輪。audit 的價值就是一次列完。
    local soft_note=""
    if [ -n "$subject" ] && [ "$subject" != "$sha" ]; then
      local sh
      sh="$(printf %s "$subject" | grep -E -o "$MESSAGE_SOFT_PATTERN" | sort -u | paste -sd " " - || true)"
      [ -n "$sh" ] && soft_note="軟清單命中［$sh］，確認是業務描述而非作業過程"
    fi

    if [ -n "$issues" ]; then
      bad=$((bad + 1))
      echo "  [X] $sha $subject"
      echo "        → ${issues%；}"
      [ -n "$soft_note" ] && echo "        → $soft_note"
    elif [ -n "$soft_note" ]; then
      warn=$((warn + 1))
      echo "  [!] $sha $subject"
      echo "        → $soft_note"
    fi
  done < <(git -c color.ui=false log --format='%h %s' $range 2>/dev/null)

  echo ""
  if [ "$total" -eq 0 ]; then
    echo "--- 此範圍內沒有任何 commit（range: $range）——不是「全部乾淨」，是沒東西可掃 ---"
    return 0
  fi
  echo "--- 共 $total 顆：$bad 顆有問題、$warn 顆待確認、$((total - bad - warn)) 顆乾淨 ---"
  if [ "$bad" -gt 0 ]; then
    echo "有問題的 commit 若尚未推上遠端可用 rebase 改寫——改寫前務必先建備份分支。" >&2
    return 1
  fi
  return 0
}

# ------------------------------------------------------------
# Command: check-msg <repo> <type> <description> [--body "<…>"] [--allow-message-trace]
#   只檢查 commit message（與 ship 同一套判準），不碰 git。
#   起因（2026-10-16 使用回饋）：message 先給使用者核可，到 ship 才說超過寬度上限，要再核可一次。
#   預覽（1.3a）前先跑這支，給使用者看的就是一定過得了 ship 的版本。
# ------------------------------------------------------------
cmd_check_msg() {
  local allow_trace=0 body="" positional=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --allow-message-trace) allow_trace=1; shift ;;
      --body)
        [ $# -lt 2 ] && { echo "ERROR: --body 後面缺內容。" >&2; exit 1; }
        body="$(normalize_body "$2")"; shift 2 ;;
      *) positional+=("$1"); shift ;;
    esac
  done
  local repo="${positional[0]:-}" type="${positional[1]:-}" desc="${positional[2]:-}"
  if [ -z "$repo" ] || [ -z "$type" ] || [ -z "$desc" ] || [ "${#positional[@]}" -ne 3 ]; then
    echo "Usage: flow.sh check-msg <repo> <type> <description> [--body \"<一兩句>\"] [--allow-message-trace]" >&2
    exit 1
  fi
  assert_valid_repo "$repo"
  load_commit_conf "$(resolve_repo_path "$repo")"
  check_message "$type" "$desc" "$body" "$allow_trace"
  echo "=== commit message 檢查通過 ==="
  echo "  subject：$(compose_subject "$type" "$desc")"
  echo "  描述寬度：$(display_width "$desc") / $MESSAGE_MAX_WIDTH（全形算 2、半形算 1）"
  if [ -n "$body" ]; then
    echo "  內文（$(printf '%s\n' "$body" | wc -l | tr -d ' ') 行，上限 $BODY_MAX_LINES）："
    printf '%s\n' "$body" | sed 's/^/    /'
  fi
  [ -n "$COMMIT_CONF" ] && echo "  設定檔：$COMMIT_CONF"
  return 0
}

# ------------------------------------------------------------
# Entry
# ------------------------------------------------------------

case "${1:-}" in
  analyze) shift; cmd_analyze "$@" ;;
  prepare) shift; cmd_prepare "$@" ;;
  ship)    shift; cmd_ship "$@" ;;
  amend)   shift; cmd_amend "$@" ;;
  review-record) shift; cmd_review_record "$@" ;;
  audit)   shift; cmd_audit "$@" ;;
  check-msg) shift; cmd_check_msg "$@" ;;
  -h|--help|"")
    cat <<USAGE
Usage: flow.sh <command> [args]

Commands:
  analyze <repo>                    顯示 git 狀態、local-overrides 過濾結果、敏感字掃描（僅提示）
  prepare <repo> <files...>         git add + 輸出 staged diff 到 .claude/.git-commit-tmp/ + 記錄 diff hash 到 .git/git-commit-flow/
                                    index 已有清單外的 staged 項目（多半是別的 session 的）即拒絕
                                    最後印出 .claude/git-commit-reviewer-addendum.md（C 軌專案附加審查要求，沒有就印「無」）
  prepare <repo> --staged           不 git add，直接拿當下 index 送審（merge 收尾用）
          [--allow-sensitive] [--allow-artifacts] [--allow-ai-trace]
                                    送審前先跑內容閘（敏感字／建置產物／AI 痕跡），沒過就不產生 diff hash；
                                    誤判時在 prepare 帶 --allow-*，旗標綁定這份 diff，ship／amend 沿用不必再帶
                                    每跑一次算一輪審查（commit 成功歸零），第 3 輪起印停止條件提示
  check-msg <repo> <type> <desc> [--body "<一兩句>"] [--allow-message-trace]
                                    只檢查 commit message（同 ship 的判準：Type／署名／痕跡／寬度／內文），
                                    預覽給使用者看之前先跑，免得核可後才在 ship 被擋
  review-record <repo> --codex "<回覆>" --reviewer "<回覆>" [--qa "<QA 狀態>"] [--allow-overrides "<理由>"]
  review-record <repo> --codex "<原文>" --reviewer "<原文>" --edge "<剩下哪幾項、為什麼算極端>"
                                    至少一軌 BLOCK，且 Codex 仲裁（審查單 arbiter 軌，hook 抓回覆）判 RULING: EDGE：
                                    寫成「極端情境預設豁免」紀錄；沒有仲裁結果或判 GENERAL 一律拒收
  review-record <repo> --exempt "<理由>" [--qa "<QA 狀態>"] [--allow-overrides "<理由>"]
                                    把兩軌結果（或使用者豁免）綁定到當下 staged diff；ship／amend 沒有它就拒絕
                                    回覆的結論行（第一個或最後一個非空行）須為 VERDICT: PASS，不可用的那軌填 "skipped: <原因>"（兩軌都 skipped 不收；C 軌 code-reviewer 只收理由寫明 general-purpose 第三層也試過且失敗的）
                                    額度／用量上限不算不可用：skipped 理由含 usage limit、quota、額度等字樣一律拒收（要排重跑）
                                    專案有 .claude/qa-gate.conf 時：staged 含行為類檔（behavior_ext／exclude）就必須帶
                                    --qa "已QA：…" 或 --qa "分流例外：…"；block_staged_overrides=1 時 staged 含
                                    local-overrides 清單上的檔就拒收，確實要推加 --allow-overrides "<理由>"（寫進 review-log.tsv）
  audit   <repo> [<range>]          體檢既有 commit 的 message，唯讀。抓：空 message／缺 Type: 前綴／
                                    Type 不在允許清單／描述超長／痕跡命中／內文超過行數、過寬或含痕跡
                                    不帶 range 時：有 upstream 掃未推的，否則掃最近 20 顆
                                    exit 0=乾淨、1=有問題、2=range 無效。交付 patch 或推上游前先跑一次
  ship    <repo> <type> <desc> [--body "<一兩句>"] [--push] [--allow-sensitive] [--allow-artifacts] [--allow-ai-trace] [--allow-message-trace]
                                    真閘(署名/單行/message痕跡+長度/diff-hash/敏感字/建置產物/AI痕跡)
                                    → git commit → 驗證；--body 是選填內文（最多 3 行，每行寬度同描述上限）
                                    預設只 local commit；--push 才推遠端（需使用者明確核可）
                                    分支沒有 upstream 時 --push 自動改用 git push -u <remote> HEAD
  amend   <repo> --confirm-rewrite [--type <Type> --desc <描述> [--body "<一兩句>"]] [--allow-*]
                                    改寫 HEAD。自動建備份分支、擋已 push 的 commit、沿用 ship 全部真閘
                                    改寫後做 tree 級重現驗證（證明只動了 staged 的那幾個檔案）
                                    不帶 --type/--desc 則沿用既有 message；只做本地改寫，不 push

repo 參數：
  工作目錄底下的 git 子目錄名（多 repo workspace），或 "." 代表工作目錄本身就是 git repo。
  不收絕對路徑：要操作別處的 repo 先 cd 過去再用 "."。

Merge 收尾（沒有 merge 子命令，MERGE_HEAD 存在時 ship 就會建出 merge commit）：
  解完衝突 → prepare <repo> <檔案...>（或 --staged）→ review-record → ship <repo> Chore "合併 <分支>"
  不要下 git commit / git merge --continue（hook 會擋）

Valid types（預設；專案可在 .claude/git-commit.conf 用 types= 覆寫，列 none 表示可不加前綴）:
  ${VALID_TYPES[*]}

專案設定檔 .claude/git-commit.conf（選用，找法同 qa-gate.conf；範本 git-commit.conf.example）:
  types=…                   允許的 Type；none＝subject 只有描述
  max_width=72              描述與內文每行的顯示寬度上限
  review_ask_round=0        審到第幾輪仍 BLOCK 就停下來問使用者（0＝不停，修到只剩極端情境；預設）
  edge_auto_exempt_rounds=2 Codex 仲裁判只剩極端情境（RULING: EDGE）就預設豁免（大於 0＝開啟；0＝關閉）

Examples:
  flow.sh analyze .                              # 工作目錄本身是 git repo
  flow.sh analyze WEHQ.SupplierManager.Frontend  # 多 repo workspace 底下的子 repo
  flow.sh prepare . src/foo.vue src/bar.js
  flow.sh ship    WEHQ.SupplierManager.Frontend Modify "修正 XXX"           # local commit
  flow.sh ship    WEHQ.SupplierManager.Frontend Modify "修正 XXX" --push    # 核可後才推
  flow.sh amend   WEHQ.SupplierManager.Frontend --confirm-rewrite            # 改寫 HEAD，沿用 message

Notes:
  - 禁止 --no-verify、禁止 force push（旗標層不提供）
  - amend 走 flow.sh amend <repo> --confirm-rewrite：自動建備份分支、擋已 push 的 commit、
    沿用 ship 的全部真閘，改寫後做 tree 級重現驗證（證明只動了 staged 的那幾個檔案）
  - 預設 local commit only：未帶 --push 不會推遠端，且保留 diff hash（未 push 不算完成）
  - Commit message 禁止任何 AI 署名——ship 會機制級攔截（assert_no_signature），非僅提醒
  - 新增行的註解禁止引用外部文件出處（CLAUDE.md / skill / 設計文件 / §章節號）——
    交付物不得洩漏 AI 參與；寫「理由本身」而非「哪份文件第幾節說的」。
    誤判（引用的是公開標準如 ECMAScript）才用 --allow-ai-trace 放行
  - staged diff 命中敏感字時 prepare 就擋下（不產生 diff hash），除非在 prepare 帶 --allow-sensitive；ship 會再查一次並沿用該放行
  - staged 含建置產物/快取/備份（__pycache__、*.pyc、node_modules、*.bak、*.log…）時 prepare 就擋下，除非在 prepare 帶 --allow-artifacts
  - ship 會比對 prepare 記錄的 diff hash，內容被改動過即拒絕（防審查後掉包）
  - ship／有改到碼的 amend 必須先有 review-record 紀錄且 hash 吻合，否則拒絕（無旗標可繞）；
    豁免同樣走 review-record --exempt，並寫進 .claude/.git-commit-tmp/review-log.tsv 供稽核
  - commit message 描述須為「一般正常人會寫的文字」：寫改了什麼，不寫「用什麼方法確認它是對的」。
    含 Claude/Codex/agent、實測/掃描確認/驗證：、P0/本輪/第N輪 等痕跡即擋（不可豁免）
  - commit message 痕跡誤判（命中的是業務詞彙如簽核審查、代理商 agent）用 --allow-message-trace 放行
  - commit message 描述顯示寬度上限預設 72（全形算 2、半形算 1），超標即擋（沒有豁免旗標；要放寬改專案設定檔 max_width=）
  - 審查紀錄、diff hash、補推標記、審查輪數存在該 repo 的 git 目錄（.git/git-commit-flow/），
    用子目錄名或 cd 進去用 "." 都找得到同一份；送審 diff 檔與 review-log.tsv 仍在 .claude/.git-commit-tmp/
  - 搭配 hooks/block-bare-git-commit.sh（PreToolUse）攔裸 git commit；本腳本 export GIT_COMMIT_FLOW=1 放行
USAGE
    ;;
  *)
    echo "ERROR: Unknown command: $1" >&2
    echo "Run 'flow.sh --help' for usage" >&2
    exit 1
    ;;
esac
