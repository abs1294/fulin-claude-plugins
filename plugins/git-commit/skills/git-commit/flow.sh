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
#   - 敏感字（除非顯式 --allow-sensitive）
#   - 真實憑證特徵字串（不可豁免）
#   - 建置產物/快取/備份檔名（除非顯式 --allow-artifacts）
# 其餘規範（local-overrides 過濾、禁 force/amend/no-verify）由 subcommand 封裝與旗標缺席保證。
#
# 用法：
#   flow.sh analyze <repo>
#   flow.sh prepare <repo> <files...>
#   flow.sh ship <repo> <type> <description>
# ============================================================

set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 通用化：WORKSPACE_DIR 取自 Claude Code 的工作目錄（不靠 skill 位置回推，
# 因 skill 可能被 plugin-manager adopt 進 monorepo，回推層數會錯）。
# 優先用 CLAUDE_PROJECT_DIR；否則 fallback 到 PWD。
WORKSPACE_DIR="${CLAUDE_PROJECT_DIR:-$PWD}"

# 通用化：local-overrides 放工作目錄層的 .claude/（一份管底下所有 repo）。
OVERRIDES_FILE="$WORKSPACE_DIR/.claude/local-overrides.yml"

# 通用化：.tmp 放工作目錄層的 .claude/，與 overrides 同層（不放 skill 內，避免被 plugin 更新影響）。
TMP_DIR="$WORKSPACE_DIR/.claude/.git-commit-tmp"
mkdir -p "$TMP_DIR"

VALID_TYPES=(Feat Modify Style Refactor Perf Chore Docs Test Fix Hotfix)

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
  exit 1
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

# 從 local-overrides.yml 取得指定 repo 的 path 清單（每行一個）。
# 匹配鍵：頂層 YAML key（如 `my-repo:`）或區塊內 `repo:` 的值，任一等於 target 即命中。
#   - 頂層 key 天生唯一，是防「多個區塊都寫 repo: . 而互相污染」的正解。
#   - 同時仍接受舊的 `repo:` 值匹配，向後相容既有 overrides 檔。
# 一個區塊只要頂層 key 或 repo 值其一命中 target，就輸出它 files 下所有 path。
parse_overrides_for_repo() {
  local target_repo="$1"
  [ -f "$OVERRIDES_FILE" ] || return 0
  awk -v target="$target_repo" '
    # 頂層 key：行首無縮排、以 : 結尾（排除註解）
    /^[^[:space:]#][^:]*:[[:space:]]*$/ {
      top_key = $0; sub(/:.*$/, "", top_key)
      block_match = (top_key == target) ? 1 : 0
      repo_val = ""
      next
    }
    /^  repo:[[:space:]]/ {
      repo_val = $2
      if (repo_val == target) block_match = 1
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
SIGNATURE_PATTERN='Co-Authored-By|Generated with \[?Claude|🤖|noreply@anthropic|Claude Code'
# 敏感字 pattern（與 analyze 共用同一份，單一事實來源）。
SENSITIVE_PATTERN='password|secret|api_key|bearer|token=|ConnectionString|console\.log|Console\.WriteLine|System\.out\.print|debugger;|TODO: remove|FIXME|XXX|// DEBUG|// TEMP|eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|sqlcmd .{0,120}-P |Pwd[[:space:]]*=|User ?Id[[:space:]]*=|Data Source[[:space:]]*=|Initial Catalog[[:space:]]*='
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
ARTIFACT_PATH_PATTERN='(^|/)(__pycache__|node_modules|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.venv|venv|\.idea|\.vscode)/|\.(pyc|pyo|class|o|obj|exe|dll|so|dylib|bak|orig|rej|swp|tmp)$|(^|/)(\.DS_Store|Thumbs\.db|desktop\.ini)$|\.log$'

# 硬閘：commit message（type + desc）不得含任何 AI 署名，且必須單行。
# 命中即 exit 1——這是機制級攔截，不是提醒。
assert_no_signature() {
  local msg="$1"
  if printf '%s' "$msg" | grep -E -i -q "$SIGNATURE_PATTERN"; then
    echo "ERROR: commit message 含 AI 署名，已拒絕 commit（使用者全域規則：禁止任何 Claude 署名）。" >&2
    echo "       命中內容：" >&2
    printf '%s\n' "$msg" | grep -E -i "$SIGNATURE_PATTERN" | sed 's/^/         /' >&2
    exit 1
  fi
  # 多行 desc 是署名夾帶的常見載體；SKILL.md 規範 desc 為「1 句話」，故只允許單行。
  if [ "$(printf '%s' "$msg" | wc -l | tr -d ' ')" != "0" ]; then
    echo "ERROR: commit message 為多行，已拒絕（規範：desc 為單行 1 句話，多行常是署名夾帶載體）。" >&2
    exit 1
  fi
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
      echo "       確實要版控這些檔請在 ship 加 --allow-artifacts。" >&2
      exit 1
    fi
  fi
}

# 硬閘：staged diff 命中敏感字時，除非帶 --allow-sensitive，否則 exit 1。
# repo_path 已 cd 進去才呼叫。allow=1 表示使用者已顯式授權保留。
assert_no_sensitive() {
  local allow="$1"
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
  hits=$(printf '%s\n' "$diff_output" | grep -E -i "$SENSITIVE_PATTERN" | head -20 || true)
  if [ -n "$hits" ]; then
    if [ "$allow" = "1" ]; then
      echo "[git-commit] 敏感字命中，但已帶 --allow-sensitive，放行：" >&2
      printf '%s\n' "$hits" | sed 's/^/  /' >&2
    else
      echo "ERROR: staged diff 命中敏感字，已拒絕 commit。確認要保留請在 ship 加 --allow-sensitive。" >&2
      echo "       命中內容（最多 20 行）：" >&2
      printf '%s\n' "$hits" | sed 's/^/         /' >&2
      exit 1
    fi
  fi
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
  echo "--- Sensitive scan (staged diff) ---"
  if [ ${#staged[@]} -eq 0 ]; then
    echo "(no staged files)"
  else
    local staged_paths=()
    for entry in "${staged[@]}"; do
      staged_paths+=("$(extract_path_from_status "$entry")")
    done

    local diff_output
    diff_output=$(git -c color.ui=false diff --staged -- "${staged_paths[@]}" 2>/dev/null || true)

    local hits
    hits=$(printf '%s\n' "$diff_output" | grep -E -i "$SENSITIVE_PATTERN" | head -20 || true)

    if [ -z "$hits" ]; then
      echo "CLEAN"
    else
      echo "HITS (ship 會實際攔截，除非帶 --allow-sensitive):"
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
  [ -z "$repo" ] && { echo "Usage: flow.sh prepare <repo> <files...>" >&2; exit 1; }
  assert_valid_repo "$repo"
  shift
  local files=("$@")
  [ ${#files[@]} -eq 0 ] && { echo "ERROR: No files specified" >&2; exit 1; }

  local repo_path
  repo_path="$(resolve_repo_path "$repo")"
  cd "$repo_path"

  echo "=== Stage files ==="
  git add "${files[@]}"
  git -c color.ui=false status -s
  echo ""

  echo "=== Staged diff stat ==="
  git -c color.ui=false diff --staged --stat
  echo ""

  local diff_file="$TMP_DIR/staged-$repo.diff"
  git -c color.ui=false diff --staged > "$diff_file"
  local lines
  lines=$(wc -l < "$diff_file" | tr -d ' ')
  echo "Staged diff saved: $diff_file ($lines lines)"

  # TOCTOU 防護：記錄「被審查的這份 staged diff」的 hash。
  # ship 會重算當下 staged diff 的 hash 並比對，不符即拒——確保 commit 的內容
  # 就是三軌審查看過的那份，中間若 index 被改動（AI 再 add、多 repo 交錯）會被擋下。
  local hash_file="$TMP_DIR/staged-$repo.sha"
  git -c color.ui=false diff --staged | git hash-object --stdin > "$hash_file"
  echo "Staged diff hash saved: $hash_file ($(cat "$hash_file"))"
}

# ------------------------------------------------------------
# Command: ship <repo> <type> <description>
#   git commit (HEREDOC) → push → 驗證結果
# ------------------------------------------------------------

cmd_ship() {
  # 解析旗標：--allow-sensitive（顯式授權保留敏感字）、--allow-artifacts（顯式授權版控建置產物）。
  local allow_sensitive=0
  local allow_artifacts=0
  local positional=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --allow-sensitive) allow_sensitive=1; shift ;;
      --allow-artifacts) allow_artifacts=1; shift ;;
      *) positional+=("$1"); shift ;;
    esac
  done
  set -- "${positional[@]:-}"

  local repo="${1:-}"
  local type="${2:-}"
  local desc="${3:-}"
  if [ -z "$repo" ] || [ -z "$type" ] || [ -z "$desc" ]; then
    echo "Usage: flow.sh ship <repo> <type> <description> [--allow-sensitive] [--allow-artifacts]" >&2
    exit 1
  fi
  assert_valid_repo "$repo"
  assert_valid_type "$type"

  local repo_path
  repo_path="$(resolve_repo_path "$repo")"
  cd "$repo_path"

  # === 真閘 1：署名 + 單行檢查（機制級，命中即 exit 1）===
  assert_no_signature "$type: $desc"

  # === 真閘 2：TOCTOU — 比對當下 staged diff 與 prepare 時被審查的那份 ===
  local hash_file="$TMP_DIR/staged-$repo.sha"
  if [ -f "$hash_file" ]; then
    local expected current
    expected="$(cat "$hash_file")"
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

  # === 真閘 3：敏感字掃描（命中即 exit 1，除非 --allow-sensitive）===
  assert_no_sensitive "$allow_sensitive"

  # === 真閘 4：檔名黑名單（建置產物/快取/備份，除非 --allow-artifacts）===
  assert_no_artifacts "$allow_artifacts"

  echo "=== Commit ==="
  # HEREDOC 內禁止任何 AI 署名——已由 assert_no_signature 機制級攔截（非僅註解）。
  git commit -m "$(cat <<EOF
$type: $desc
EOF
)"
  echo ""

  echo "=== Push ==="
  # push 可能因遠端有新 commit 被拒（non-fast-forward）。用 if 攔住，避免 set -e 直接中止
  # 而留下「已 commit、未 push」的懸置狀態卻無下一步指引（AI 易自行裸跑 pull / push -f）。
  local push_rc=0
  if git push; then
    echo ""
    # commit+push 都成功才清本次 diff hash，避免下次沿用舊 hash 誤判。
    rm -f "$hash_file" "$TMP_DIR/staged-$repo.diff"
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
# Entry
# ------------------------------------------------------------

case "${1:-}" in
  analyze) shift; cmd_analyze "$@" ;;
  prepare) shift; cmd_prepare "$@" ;;
  ship)    shift; cmd_ship "$@" ;;
  -h|--help|"")
    cat <<USAGE
Usage: flow.sh <command> [args]

Commands:
  analyze <repo>                    顯示 git 狀態、local-overrides 過濾結果、敏感字掃描（僅提示）
  prepare <repo> <files...>         git add + 輸出 staged diff + 記錄 diff hash 到 .claude/.git-commit-tmp/
  ship    <repo> <type> <desc> [--allow-sensitive] [--allow-artifacts]
                                    真閘(署名/單行/diff-hash/敏感字) → git commit (HEREDOC) → push → 驗證

repo 參數：
  工作目錄底下的 git 子目錄名（多 repo workspace），或 "." 代表工作目錄本身就是 git repo。

Valid types:
  ${VALID_TYPES[*]}

Examples:
  flow.sh analyze .                              # 工作目錄本身是 git repo
  flow.sh analyze WEHQ.SupplierManager.Frontend  # 多 repo workspace 底下的子 repo
  flow.sh prepare . src/foo.vue src/bar.js
  flow.sh ship    WEHQ.SupplierManager.Frontend Modify "修正 XXX"

Notes:
  - 禁止 --no-verify、禁止 --amend、禁止 force push（旗標層不提供）
  - Commit message 禁止任何 AI 署名——ship 會機制級攔截（assert_no_signature），非僅提醒
  - staged diff 命中敏感字時 ship 會擋下，除非顯式 --allow-sensitive
  - staged 含建置產物/快取/備份（__pycache__、*.pyc、node_modules、*.bak、*.log…）時 ship 會擋下，除非 --allow-artifacts
  - ship 會比對 prepare 記錄的 diff hash，內容被改動過即拒絕（防審查後掉包）
USAGE
    ;;
  *)
    echo "ERROR: Unknown command: $1" >&2
    echo "Run 'flow.sh --help' for usage" >&2
    exit 1
    ;;
esac
