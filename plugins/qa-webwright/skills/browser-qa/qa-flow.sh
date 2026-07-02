#!/usr/bin/env bash
# ============================================================
# qa-flow.sh — qa-webwright skill 流程輔助腳本
#
# 目的：把 skill 流程中所有「一定要落地的動作」（偵測既有資產、
#       建目錄骨架、跑 pytest 出 junitxml 報告、驗證 test 函式
#       確實寫入、回填 catalog 情境索引）包成 subcommand，
#       讓主 Agent 每階段呼叫一次即可，落地動作由腳本強制執行、
#       不靠 AI 自律（比照 git-commit skill 的 flow.sh）。
#
# 核心：所有路徑一律從 WORKSPACE_DIR（= session 起始目錄）展開，
#       AI 無法讓腳本鑽進子專案目錄（test-plan-design.md §0 規範
#       「測試放 session 起始目錄、不鑽子目錄」的機械閘）。
#
# 用法：
#   qa-flow.sh bootstrap
#   qa-flow.sh scaffold <feature> <pytest|playwright-js>
#   qa-flow.sh run      <feature> <test-file> <date>
#   qa-flow.sh catalog  <情境> <測試函式> <狀態> <模組>
# ============================================================

set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 落點鎖定：WORKSPACE_DIR 取自 Claude Code 的 session 起始目錄。
# 優先用 CLAUDE_PROJECT_DIR；否則 fallback 到 PWD。
# 所有測試 / 報告 / catalog 一律落在此目錄下，腳本不接受絕對路徑或
# 上鑽/下鑽，確保「不鑽子專案目錄」由腳本層鎖死。
WORKSPACE_DIR="${CLAUDE_PROJECT_DIR:-$PWD}"

TESTS_DIR="$WORKSPACE_DIR/tests/e2e"
REPORTS_DIR="$TESTS_DIR/reports"
# catalog 與它索引的 test 檔 / report 同層（tests/e2e/），一眼找得到；仍是跨功能一份總表。
CATALOG_FILE="$TESTS_DIR/catalog.md"

VALID_RUNNERS=(pytest playwright-js)
VALID_STATES=("完整" "部分" "未覆蓋")   # ✅完整 / ⚠️部分 / ❌未覆蓋

# ------------------------------------------------------------
# Utility
# ------------------------------------------------------------

# 確保 session 目錄有一份跨功能總 catalog.md（不存在就建四欄表頭骨架）。
# 對齊 test-plan-design.md §0.5：讀者是人、格式釘 md 表、跨功能累積。
ensure_catalog() {
  [ -f "$CATALOG_FILE" ] && return 0
  mkdir -p "$TESTS_DIR"   # catalog 放 tests/e2e/ 下，先確保目錄存在（bootstrap 可能早於 scaffold）
  cat > "$CATALOG_FILE" <<'EOF'
# 情境覆蓋索引（catalog）

> 跨功能、持久化的「應測情境 ＋ 各自覆蓋狀態」單一真相來源（含 ❌未覆蓋）。
> 由 qa-flow.sh catalog 回填，邊 codify 邊登記。詳見 browser-qa skill
> methodology/test-plan-design.md §0.5。
>
> 覆蓋狀態：✅完整（操作＋讀回） / ⚠️部分（附缺口原因） / ❌未覆蓋

| 白話業務情境 | 對應測試函式 | 覆蓋狀態 | 業務模組分類 |
|------|------|------|------|
EOF
  echo "[qa-flow] 已建立 catalog 骨架：$CATALOG_FILE" >&2
}

assert_valid_runner() {
  local r="$1"
  for v in "${VALID_RUNNERS[@]}"; do
    [ "$v" = "$r" ] && return 0
  done
  echo "ERROR: Invalid runner: $r（合法值：${VALID_RUNNERS[*]}）" >&2
  exit 1
}

# feature 是「識別字」，不得含任何路徑分隔或上鑽——否則 feature=foo/bar 會在
# tests/e2e/ 底下再鑽子目錄，破壞「不鑽子目錄」的落點鎖定。只允許中英數 . _ -。
assert_safe_feature() {
  local name="$1"
  # 禁路徑分隔 / 上鑽 / 絕對路徑
  case "$name" in
    ""|*/*|*..*|/*)
      echo "ERROR: feature 不得含 '/'、'..' 或為絕對路徑：$name（feature 是識別字，非路徑）" >&2
      exit 1
      ;;
  esac
  # 正向白名單：只允許中英數字、底線、連字號、點；且不得為純點名（. / .. / ...）
  if ! printf '%s' "$name" | grep -Eq '^[A-Za-z0-9_.-]+$' || printf '%s' "$name" | grep -Eq '^\.+$'; then
    echo "ERROR: feature 只能含 中英數字 / _ / - / .（且不得為純點名）：$name" >&2
    exit 1
  fi
}

# 把使用者給的 test-file 正規化到 WORKSPACE_DIR/tests/e2e/ 底下並驗證存在。
# 限制在 tests/e2e/ 下，避免 run 執行 CLAUDE_PROJECT_DIR 內任意檔案（落點機械鎖定）。
resolve_test_file() {
  local f="$1"
  case "$f" in
    /*|*..*)
      echo "ERROR: test-file 不得為絕對路徑或含 '..'：$f" >&2
      exit 1
      ;;
  esac
  # 一律要求落在 tests/e2e/ 下（接受給 tests/e2e/x.py 或裸檔名 x.py 兩種寫法）
  case "$f" in
    tests/e2e/*) ;;
    */*)
      echo "ERROR: test-file 必須位於 tests/e2e/ 下（落點鎖定），得到：$f" >&2
      exit 1
      ;;
    *) f="tests/e2e/$f" ;;
  esac
  local path="$WORKSPACE_DIR/$f"
  if [ ! -f "$path" ]; then
    echo "ERROR: 測試檔不存在：$path" >&2
    exit 1
  fi
  echo "$path"
}

# ------------------------------------------------------------
# Command: bootstrap
#   盤點 session 目錄既有測試資產，輸出結構化結果供主 Agent 決策。
#   不擅自安裝任何東西；空目錄時發 ACTION-REQUIRED 訊號要主 Agent 問使用者。
# ------------------------------------------------------------

cmd_bootstrap() {
  echo "=== qa-flow bootstrap ==="
  echo "WORKSPACE_DIR: $WORKSPACE_DIR"
  echo "（測試落點一律在此目錄下，不鑽子專案目錄）"
  echo ""

  ensure_catalog

  # 偵測既有測試資產
  local has_pytest=0
  local has_js=0
  local py_hits=()
  local js_hits=()

  # Python / pytest 資產
  for marker in conftest.py pytest.ini pyproject.toml setup.cfg; do
    [ -f "$WORKSPACE_DIR/$marker" ] && { has_pytest=1; py_hits+=("$marker"); }
  done
  # tests 目錄下的 test_*.py
  if find "$WORKSPACE_DIR" -maxdepth 4 -type f -name 'test_*.py' -not -path '*/node_modules/*' 2>/dev/null | grep -q .; then
    has_pytest=1
    py_hits+=("test_*.py（已存在）")
  fi

  # JS / Playwright Test 資產
  [ -f "$WORKSPACE_DIR/playwright.config.ts" ] && { has_js=1; js_hits+=("playwright.config.ts"); }
  [ -f "$WORKSPACE_DIR/playwright.config.js" ] && { has_js=1; js_hits+=("playwright.config.js"); }
  if find "$WORKSPACE_DIR" -maxdepth 4 -type f \( -name '*.spec.js' -o -name '*.spec.ts' \) -not -path '*/node_modules/*' 2>/dev/null | grep -q .; then
    has_js=1
    js_hits+=("*.spec.js/ts（已存在）")
  fi

  echo "--- 既有測試資產 ---"
  if [ $has_pytest -eq 1 ]; then
    echo "Python/pytest： ${py_hits[*]}"
  fi
  if [ $has_js -eq 1 ]; then
    echo "JS/Playwright： ${js_hits[*]}"
  fi
  if [ $has_pytest -eq 0 ] && [ $has_js -eq 0 ]; then
    echo "(none)"
  fi
  echo ""

  # 決策訊號（供主 Agent 判讀）
  echo "--- 決策訊號 ---"
  if [ $has_pytest -eq 1 ]; then
    echo "ASSET: pytest-existing"
    echo "NEXT: 復用既有 pytest 資產，新 TC 對齊既有風格/命名，不重建。直接進探索→沉澱。"
  elif [ $has_js -eq 1 ]; then
    echo "ASSET: js-existing"
    echo "ACTION-REQUIRED: ask-user-runner"
    echo "NEXT: 既有為 JS runner，但本 plugin 固定優先 pytest。請主 Agent 詢問使用者："
    echo "      (a) 在既有 JS 專案旁另起 pytest（scaffold pytest），或"
    echo "      (b) 沿用既有 JS runner（scaffold playwright-js）。"
  else
    echo "ASSET: none"
    echo "ACTION-REQUIRED: ask-user-install"
    echo "NEXT: greenfield（無測試資產）。請主 Agent 詢問使用者是否同意安裝 pytest-playwright："
    echo "      同意   → qa-flow.sh scaffold <feature> pytest"
    echo "      不同意 → qa-flow.sh scaffold <feature> playwright-js（退而求其次）"
  fi
  echo ""
  echo "catalog: $CATALOG_FILE"
}

# ------------------------------------------------------------
# Command: scaffold <feature> <pytest|playwright-js>
#   使用者同意後，建目錄骨架 + conftest。安裝指令只印出讓使用者跑，
#   腳本不代跑（依使用者決策：安裝需經同意）。
# ------------------------------------------------------------

cmd_scaffold() {
  local feature="${1:-}"
  local runner="${2:-}"
  if [ -z "$feature" ] || [ -z "$runner" ]; then
    echo "Usage: qa-flow.sh scaffold <feature> <pytest|playwright-js>" >&2
    exit 1
  fi
  assert_safe_feature "$feature"
  assert_valid_runner "$runner"

  # Python 模組名不得含連字號 → 正規化成底線供 pytest 檔名用（JS 檔名不受此限，但一併統一）
  local feature_id="${feature//-/_}"

  ensure_catalog
  mkdir -p "$TESTS_DIR" "$REPORTS_DIR"

  echo "=== qa-flow scaffold（$runner）==="
  echo "落點：$TESTS_DIR"
  echo ""

  if [ "$runner" = "pytest" ]; then
    local conftest="$TESTS_DIR/conftest.py"
    if [ ! -f "$conftest" ]; then
      cat > "$conftest" <<'EOF'
# conftest.py — pytest-playwright 最小骨架（qa-flow.sh scaffold 產生）
#
# 專案專屬值（BASE_URL / port / 登入方式）委派目標專案 CLAUDE.md，
# 不寫死在此。以下只提供最小共用 fixture 掛點。
import os
import pytest


@pytest.fixture(scope="session")
def base_url() -> str:
    # 由目標專案 CLAUDE.md 指定的環境變數注入；未設時請自行覆寫。
    return os.environ.get("QA_BASE_URL", "http://localhost")


# pytest-playwright 已內建 `page` fixture；如需登入態 / 共用前置，
# 在此以 fixture 疊加（見該 runner 官方文件）。
EOF
      echo "已建立：$conftest（最小骨架）"
    else
      echo "已存在，不覆寫：$conftest"
    fi
    echo ""
    echo "--- 需使用者執行的安裝指令（腳本不代跑）---"
    echo "  pip install pytest-playwright && playwright install chromium"
    echo ""
    echo "NEXT: 探索路徑 → 把每個 CP 沉澱成 $TESTS_DIR/test_${feature_id}.py 的一行 assert"
    echo "      → qa-flow.sh run $feature tests/e2e/test_${feature_id}.py <date>"

  else  # playwright-js
    local pw_test_dir="$TESTS_DIR"
    echo "runner：Playwright Test（JS，退而求其次——使用者不同意裝 Python）"
    echo ""
    echo "--- 需使用者執行的安裝指令（腳本不代跑）---"
    echo "  npm i -D @playwright/test && npx playwright install chromium"
    echo ""
    echo "NEXT: 探索路徑 → 沉澱成 $pw_test_dir/${feature_id}.spec.js 的 expect 斷言"
    echo "      → 用 npx playwright test --reporter=junit 產報告，回填 catalog"
  fi
}

# ------------------------------------------------------------
# Command: run <feature> <test-file> <date>
#   pytest --junitxml 出報告 + 跑完 grep 驗證 test 函式確實寫入（防假綠燈）。
#   date 由主 Agent 傳入（腳本內不取系統時間，保持可重現）。
# ------------------------------------------------------------

cmd_run() {
  local feature="${1:-}"
  local test_file="${2:-}"
  local date="${3:-}"
  if [ -z "$feature" ] || [ -z "$test_file" ] || [ -z "$date" ]; then
    echo "Usage: qa-flow.sh run <feature> <test-file（相對 session 目錄）> <date（YYYY-MM-DD）>" >&2
    exit 1
  fi
  assert_safe_feature "$feature"

  local abs_test
  abs_test="$(resolve_test_file "$test_file")"

  # 守門員：落點必須正好在「啟動目錄 WORKSPACE_DIR/tests/e2e/」下，鑽任何子專案目錄一律擋。
  # 用實體路徑比對（解 symlink / .. / 空格），防「AI 跳過 bootstrap、自己 cd 子目錄再建 tests/e2e」。
  # （歷史踩雷：在 AI Platform 啟動卻把測試建到 AI Platform/customer-hub/tests/e2e。）
  local canon_test canon_expected_dir test_parent
  # 先解檔案本身的實體路徑（含 symlink）：symlink 測試檔可能指向 tests/e2e 外，須用 realpath 解穿。
  if command -v realpath >/dev/null 2>&1; then
    canon_test="$(realpath "$abs_test" 2>/dev/null)" || canon_test="$abs_test"
  else
    # 無 realpath 時退而求其次：解父目錄 + basename（symlink 檔仍可能漏解，但至少解穿 .. 與父目錄 symlink）
    canon_test="$(cd "$(dirname "$abs_test")" 2>/dev/null && pwd -P)/$(basename "$abs_test")" || canon_test="$abs_test"
  fi
  test_parent="$(dirname "$canon_test")"
  canon_expected_dir="$(cd "$TESTS_DIR" 2>/dev/null && pwd -P)" || canon_expected_dir="$TESTS_DIR"
  if [ "$test_parent" != "$canon_expected_dir" ]; then
    echo "ERROR: 測試檔落點不對——必須正好在啟動目錄的 tests/e2e/ 下，不得鑽子專案目錄。" >&2
    echo "       啟動目錄(WORKSPACE_DIR)：$WORKSPACE_DIR" >&2
    echo "       應在：           $canon_expected_dir" >&2
    echo "       實際測試檔在：   $test_parent" >&2
    echo "" >&2
    echo "       多半是跳過了 qa-flow.sh bootstrap/scaffold、自己 mkdir 到子目錄。" >&2
    echo "       修法：(a) 若要測整個專案 → 把測試移回 $canon_expected_dir 下重跑；" >&2
    echo "             (b) 若要測某個子專案(如 customer-hub) → 到那個子專案目錄裡重新啟動 claude，再走 bootstrap。" >&2
    exit 1
  fi

  # 防假綠燈：先確認 test 函式確實寫入存在（SKILL.md 規範：宣稱綠燈前先 grep 驗證）
  echo "=== 落地驗證（防假綠燈）==="
  if ! grep -qE '^\s*(async\s+)?def\s+test_' "$abs_test"; then
    echo "ERROR: $abs_test 內找不到任何 test_ 函式定義——" >&2
    echo "       Write/replace 可能假成功（並行取消時），未真正落地。請重新沉澱測試碼後再跑。" >&2
    exit 1
  fi
  local n_tests
  n_tests=$(grep -cE '^\s*(async\s+)?def\s+test_' "$abs_test")
  echo "OK：偵測到 $n_tests 個 test_ 函式於 $test_file"
  echo ""

  mkdir -p "$REPORTS_DIR"
  local report="$REPORTS_DIR/${feature}-${date}.xml"

  echo "=== 執行 pytest ==="
  echo "pytest \"$abs_test\" --junitxml=\"$report\""
  set +e
  pytest "$abs_test" --junitxml="$report"
  local rc=$?
  set -e
  echo ""
  echo "=== 結果 ==="
  echo "exit code: $rc（0=全綠、非0=有 FAIL）"
  echo "報告產物: $report"
  exit $rc
}

# ------------------------------------------------------------
# Command: catalog <情境> <測試函式> <狀態> <模組>
#   機械 append/update session 目錄那份總 catalog.md 的一列。
#   以「測試函式」為主鍵：同函式已存在則 update 該列，否則 append。
# ------------------------------------------------------------

cmd_catalog() {
  local scenario="${1:-}"
  local func="${2:-}"
  local state="${3:-}"
  local module="${4:-}"
  if [ -z "$scenario" ] || [ -z "$func" ] || [ -z "$state" ] || [ -z "$module" ]; then
    echo "Usage: qa-flow.sh catalog <白話情境> <測試函式(或 —)> <覆蓋狀態> <業務模組>" >&2
    echo "  覆蓋狀態：完整 / 部分 / 未覆蓋（會自動加 ✅/⚠️/❌ 前綴）" >&2
    exit 1
  fi

  # 狀態正規化成帶 emoji 的顯示值
  local state_disp
  case "$state" in
    完整|✅完整|✅)   state_disp="✅完整" ;;
    部分|⚠️部分|⚠️)   state_disp="⚠️部分" ;;
    未覆蓋|❌未覆蓋|❌) state_disp="❌未覆蓋" ;;
    *)
      echo "ERROR: 覆蓋狀態需為 完整/部分/未覆蓋（或帶 emoji），得到：$state" >&2
      exit 1
      ;;
  esac

  ensure_catalog

  # 欄位值含 '|' 或換行會破壞 markdown 表格與 awk 的 '|' 分欄。catalog 是給人看的 md 表，
  # 情境名/函式名/模組名本就不該含 '|' → 直接拒絕，要求呼叫端改寫（比脆弱的轉義可靠）。
  for v in "$scenario" "$func" "$module"; do
    case "$v" in
      *"|"*|*$'\n'*)
        echo "ERROR: catalog 欄位值不得含 '|' 或換行（會破壞表格）：$v" >&2
        echo "       請改寫情境/函式/模組名稱後重試（例如把 'A|B' 寫成 'A/B' 或 'A、B'）。" >&2
        exit 1
        ;;
    esac
  done

  local newline="| $scenario | $func | $state_disp | $module |"

  # 以「測試函式」為主鍵 update；函式為 — 時退回以「情境」為鍵，避免多筆未覆蓋互蓋。
  local key_col
  local key_val
  if [ "$func" = "—" ] || [ "$func" = "-" ]; then
    key_col=1; key_val="$scenario"
  else
    key_col=2; key_val="$func"
  fi

  local tmp
  tmp="$(mktemp)"
  # 欄位值已保證不含 '|'（上面已擋），故用 '|' 分欄安全。
  awk -v key_col="$key_col" -v key_val="$key_val" -v newline="$newline" '
    BEGIN { updated=0 }
    # 只處理資料列（以 | 開頭、且非表頭/分隔線）
    /^\|/ && $0 !~ /白話業務情境/ && $0 !~ /^\|[- ]+\|/ {
      n = split($0, cells, "|")
      # cells[1] 為空（行首 |），欄位從 cells[2] 起
      val = cells[key_col+1]
      gsub(/^ +| +$/, "", val)
      if (val == key_val) {
        print newline
        updated=1
        next
      }
    }
    { print }
    END {
      if (!updated) print newline
    }
  ' "$CATALOG_FILE" > "$tmp"
  mv "$tmp" "$CATALOG_FILE"

  echo "catalog 已回填：$CATALOG_FILE"
  echo "  $newline"
}

# ------------------------------------------------------------
# Entry
# ------------------------------------------------------------

case "${1:-}" in
  bootstrap) shift; cmd_bootstrap "$@" ;;
  scaffold)  shift; cmd_scaffold "$@" ;;
  run)       shift; cmd_run "$@" ;;
  catalog)   shift; cmd_catalog "$@" ;;
  -h|--help|"")
    cat <<USAGE
Usage: qa-flow.sh <command> [args]

Commands:
  bootstrap                              盤點 session 目錄既有測試資產、確保 catalog.md 存在、
                                         發安裝/runner 決策訊號（不擅自安裝）
  scaffold <feature> <runner>            建目錄骨架 + conftest（runner: pytest | playwright-js）；
                                         安裝指令只印出讓使用者跑，腳本不代跑
  run      <feature> <test-file> <date>  grep 驗證 test 函式存在（防假綠燈）→ pytest --junitxml 出報告
  catalog  <情境> <函式> <狀態> <模組>   機械回填 tests/e2e/catalog.md 總表（以函式為主鍵 update/append）

落點：一律鎖 CLAUDE_PROJECT_DIR（session 起始目錄）底下的 tests/e2e/，
      不接受絕對路徑 / '..'，確保不鑽子專案目錄。

覆蓋狀態合法值：完整 / 部分 / 未覆蓋（自動加 ✅/⚠️/❌）

Examples:
  qa-flow.sh bootstrap
  qa-flow.sh scaffold role-permission pytest
  qa-flow.sh run role-permission tests/e2e/test_role_permission.py 2026-07-02
  qa-flow.sh catalog "管理員可編輯角色權限" test_admin_edit_role 完整 "角色權限"
USAGE
    ;;
  *)
    echo "ERROR: Unknown command: $1" >&2
    echo "Run 'qa-flow.sh --help' for usage" >&2
    exit 1
    ;;
esac
