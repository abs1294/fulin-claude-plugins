#!/usr/bin/env bash
# ============================================================
# flow.sh — git-commit skill 流程輔助腳本
#
# 目的：把 skill 流程中所有「純 git / 檔案 / build 操作」包成
#       三個 subcommand，讓主 AI agent 每階段只需一次 bash call，
#       減少 tool-call 往返的 overhead。
#
# 語義保留：所有 SKILL.md 規範（敏感字掃描、local-overrides 過濾、
#           HEREDOC commit、禁止 force push、禁止 --no-verify）
#           都在腳本內部執行，規範不被繞過。
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

# 從 local-overrides.yml 取得指定 repo 的 path 清單（每行一個）
parse_overrides_for_repo() {
  local target_repo="$1"
  [ -f "$OVERRIDES_FILE" ] || return 0
  awk -v target="$target_repo" '
    /^  repo: / { current_repo = $2 }
    /^    - path: / {
      if (current_repo == target) {
        sub(/^    - path: /, "")
        print
      }
    }
  ' "$OVERRIDES_FILE"
}

# 檢查 file 是否在 overrides 清單
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

    local pattern='password|secret|api_key|bearer|token=|ConnectionString|console\.log|Console\.WriteLine|System\.out\.print|debugger;|TODO: remove|FIXME|XXX|// DEBUG|// TEMP|eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+'
    local hits
    hits=$(printf '%s\n' "$diff_output" | grep -E -i "$pattern" | head -20 || true)

    if [ -z "$hits" ]; then
      echo "CLEAN"
    else
      echo "HITS:"
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
}

# ------------------------------------------------------------
# Command: ship <repo> <type> <description>
#   git commit (HEREDOC) → push → 驗證結果
# ------------------------------------------------------------

cmd_ship() {
  local repo="${1:-}"
  local type="${2:-}"
  local desc="${3:-}"
  if [ -z "$repo" ] || [ -z "$type" ] || [ -z "$desc" ]; then
    echo "Usage: flow.sh ship <repo> <type> <description>" >&2
    exit 1
  fi
  assert_valid_repo "$repo"
  assert_valid_type "$type"

  local repo_path
  repo_path="$(resolve_repo_path "$repo")"
  cd "$repo_path"

  echo "=== Commit ==="
  # 注意：HEREDOC 內禁止任何 AI 署名（SKILL.md 規範）
  git commit -m "$(cat <<EOF
$type: $desc
EOF
)"
  echo ""

  echo "=== Push ==="
  git push
  echo ""

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
  analyze <repo>                    顯示 git 狀態、local-overrides 過濾結果、敏感字掃描
  prepare <repo> <files...>         git add + 輸出 staged diff 到 .claude/.git-commit-tmp/
  ship    <repo> <type> <desc>      git commit (HEREDOC) + push + 結果驗證

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
  - 禁止 --no-verify、禁止 --amend、禁止 force push（由 SKILL.md 規範覆蓋）
  - Commit message HEREDOC 內禁止任何 AI 署名
USAGE
    ;;
  *)
    echo "ERROR: Unknown command: $1" >&2
    echo "Run 'flow.sh --help' for usage" >&2
    exit 1
    ;;
esac
