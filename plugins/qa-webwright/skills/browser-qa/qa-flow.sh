#!/usr/bin/env bash
# ============================================================
# qa-flow.sh — qa-webwright skill 流程輔助腳本
#
# 目的：把 skill 流程中所有「一定要落地的動作」（偵測既有資產、
#       建目錄骨架、跑 pytest 出 junitxml 報告、驗證 test 函式
#       確實寫入、登記情境覆蓋）包成 subcommand，
#       讓主 Agent 每階段呼叫一次即可，落地動作由腳本強制執行、
#       不靠 AI 自律（比照 git-commit skill 的 flow.sh）。
#
# 核心：所有路徑一律從 WORKSPACE_DIR（= session 起始目錄）展開，
#       AI 無法讓腳本鑽進子專案目錄（test-plan-design.md §0 規範
#       「測試放 session 起始目錄、不鑽子目錄」的機械閘）。
#
# 兩種登記模式（bootstrap 會偵測並回報 MODE）：
#   three-layer    tests/e2e/qa-webwright.json 存在。新專案預設。
#                  <模組>/COVERAGE.md（手寫情境正本）＋ .runs/results.sqlite（執行事實）
#                  ＋ 生成的 CATALOG.md（薄索引）。工具在 tests/e2e/tools/（scaffold 複製、tools-sync 更新）。
#   legacy-catalog 舊版單一 catalog.md（4 欄，本 plugin 骨架）。維持相容；可用 migrate 轉三層。
#
# 用法：
#   qa-flow.sh bootstrap
#   qa-flow.sh scaffold   <feature> <pytest|playwright-js>
#   qa-flow.sh run        <feature> <test-file> [date]
#   qa-flow.sh catalog    <情境> <測試函式> <狀態> <模組>
#   qa-flow.sh audit      [--fix]
#   qa-flow.sh tools-sync [--force]
#   qa-flow.sh migrate    [--dry-run]
#
# 可攜性：須能在 macOS 內建 bash 3.2 ＋ BSD 工具、Windows Git Bash、Linux 上跑。
#   禁用 declare -A / mapfile / ${v,,} / sed -i / grep -P / readlink -f / date -d / stat -c 等
#   （P/tests/test_portability.py 會掃）。Python 一律經 detect_python（macOS 只有 python3）。
# ============================================================

set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 落點鎖定：WORKSPACE_DIR 取自 Claude Code 的 session 起始目錄。
# 優先用 CLAUDE_PROJECT_DIR；否則 fallback 到 PWD。
# 所有測試 / 報告 / catalog 一律落在此目錄下，腳本不接受絕對路徑或
# 上鑽/下鑽，確保「不鑽子專案目錄」由腳本層鎖死。
#
# ★★ 落點基準必須與稽核端 hooks/qa-landing-gate.js 的 `cwd` 同源（改一處要改兩處）★★
#   本腳本（寫入端）在此決定產物落在哪；hook（稽核端）在同一基準目錄下找產物來
#   決定是否放行。兩端若指向不同目錄，hook 會誤擋（產物在 A、hook 看 B）或漏擋。
#   兩端優先序相同：CLAUDE_PROJECT_DIR 優先（hook 那端沒設才用 input.cwd，再退回 process.cwd()）。
#   hook 程序的 CLAUDE_PROJECT_DIR 由 Claude Code 設定，AI 在 Bash 裡 export 只影響本腳本、不影響 hook——
#   亂 export 時兩端就會指向不同目錄。正常情況（未亂 export、且 session 未 cd 離開起始目錄）下三者一致。
#   若你要調整任一端的解析順序，務必同步檢視另一端，勿讓兩者在正常情況下發散。
WORKSPACE_DIR="${CLAUDE_PROJECT_DIR:-$PWD}"

TESTS_DIR="$WORKSPACE_DIR/tests/e2e"
REPORTS_DIR="$TESTS_DIR/reports"
CONFIG_FILE="$TESTS_DIR/qa-webwright.json"
INSTALLER="$SKILL_DIR/lib/install_tools.py"
# 舊版單一 catalog 與它索引的 test 檔 / report 同層（tests/e2e/）。
# 檔名大小寫沿用專案既有那份：不少專案的 SSOT 是 CATALOG.md，本腳本硬寫小寫時，
# 在大小寫敏感的檔案系統上會另建一份小寫檔，變成兩份互不同步的索引。
if [ -f "$TESTS_DIR/CATALOG.md" ]; then
  CATALOG_FILE="$TESTS_DIR/CATALOG.md"
else
  CATALOG_FILE="$TESTS_DIR/catalog.md"
fi

VALID_RUNNERS=(pytest playwright-js)

# ------------------------------------------------------------
# Utility
# ------------------------------------------------------------

# 偵測可用的 Python（回填全域 PY_CMD，空=找不到）。
# macOS 沒有 `python` 只有 `python3`；Windows 的 `python3` 可能是 Store 佔位程式（跑不起來）
# → 每個候選都實際跑一次 `-c "import sys"` 確認能用。
detect_python() {
  PY_CMD=""
  local c
  for c in python3 python py; do
    if command -v "$c" >/dev/null 2>&1 && "$c" -c "import sys" >/dev/null 2>&1; then
      PY_CMD="$c"
      return 0
    fi
  done
}

# 傳給 Python 的絕對路徑轉成原生格式：Git Bash 的 /c/... 或 /tmp/... 交給原生 Windows Python
# 會被解讀成 C:/c/...（MSYS_NO_PATHCONV=1 時 MSYS 不自動轉）。有 cygpath 才轉；macOS/Linux 原樣。
native_path() {
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -m "$1"
  else
    printf '%s\n' "$1"
  fi
}

require_python() {
  detect_python
  if [ -z "$PY_CMD" ]; then
    echo "ERROR: 找不到可用的 Python（試過 python3 / python / py）。" >&2
    echo "       macOS：xcode-select --install 或 brew install python；Windows：安裝 python.org 版並勾 Add to PATH。" >&2
    exit 1
  fi
}

# 偵測可用的 pytest 執行方式，把命令回填到全域 PYTEST_CMD（空=找不到）。
# Windows 常無 `pytest` 命令但有 `python -m pytest`；macOS 只有 python3。
detect_pytest() {
  PYTEST_CMD=""
  if command -v pytest >/dev/null 2>&1; then
    PYTEST_CMD="pytest"
    return 0
  fi
  local c
  for c in python3 python py; do
    if command -v "$c" >/dev/null 2>&1 && "$c" -c "import pytest" >/dev/null 2>&1; then
      PYTEST_CMD="$c -m pytest"
      return 0
    fi
  done
}

# 判斷登記模式（回填全域 MODE）：
#   three-layer / three-layer-no-config / legacy-catalog / none
is_plugin_legacy_catalog() {
  [ -f "$CATALOG_FILE" ] || return 1
  grep -q 'qa-flow\.sh catalog 回填' "$CATALOG_FILE" 2>/dev/null || return 1
  grep -qF '白話業務情境 | 對應測試函式 | 覆蓋狀態 | 業務模組分類' "$CATALOG_FILE" 2>/dev/null
}

has_coverage_files() {
  local f
  for f in "$TESTS_DIR"/COVERAGE.md "$TESTS_DIR"/*/COVERAGE.md; do
    [ -f "$f" ] && return 0
  done
  return 1
}

detect_mode() {
  if [ -f "$CONFIG_FILE" ]; then
    MODE="three-layer"
  elif is_plugin_legacy_catalog; then
    MODE="legacy-catalog"
  elif has_coverage_files; then
    MODE="three-layer-no-config"
  else
    MODE="none"
  fi
}

# 本 plugin 複製進專案的工具（第一行帶版本標記）才算數；專案自有同名工具不代跑。
has_plugin_tool() {
  local f="$TESTS_DIR/tools/$1"
  [ -f "$f" ] && head -n 1 "$f" | grep -q '^# qa-webwright-tool:'
}

# 在 tests/e2e 下跑一支專案內工具（PYTHONIOENCODING 強制 UTF-8：Windows 預設 cp950 會印亂碼）。
# 只跑本 plugin 複製進去的版本（首行帶版本標記）：安裝器遇到撞名的專案自有工具會保留不碰，
# 那支檔的參數與輸出契約不一定相同，代跑可能改壞專案檔 → 不代跑、回 4。
run_tool() {
  local script="$1"; shift
  if ! has_plugin_tool "$script"; then
    echo "[qa-flow] tests/e2e/tools/$script 不存在或不是本 plugin 版本（專案自有的同名工具？），不代跑。" >&2
    echo "          要接本 plugin 工具：把撞名的專案檔改名後跑 qa-flow.sh tools-sync。" >&2
    return 4
  fi
  require_python
  ( cd "$TESTS_DIR" && PYTHONIOENCODING=utf-8 "$PY_CMD" "tools/$script" "$@" )
}

# 直接跑 plugin 本體的工具（專案還沒裝工具時用，例如 migrate）：不寫任何檔到專案的 tools/，
# 也不在 plugin 目錄留下 __pycache__；工具經 QA_E2E_ROOT 找到專案的 tests/e2e。
run_plugin_tool() {
  local script="$1"; shift
  require_python
  ( cd "$TESTS_DIR" && QA_E2E_ROOT="$(native_path "$TESTS_DIR")" PYTHONDONTWRITEBYTECODE=1 PYTHONIOENCODING=utf-8 \
      "$PY_CMD" "$(native_path "$SKILL_DIR/tools/$script")" "$@" )
}

# conftest 掛點 import 的工具：任一支不是本 plugin 版本（專案自有同名檔）→ 掛點會 import 到不相容的模組、
# pytest 收集失敗。回填全域 HOOK_TOOL_CONFLICTS（空字串＝沒有衝突）。
HOOK_TOOLS="qa_pytest_plugin.py qa_config.py runs_db.py env_gates.py skip_audit.py drift_check.py coverage_md.py baseline.py"
check_hook_tools() {
  HOOK_TOOL_CONFLICTS=""
  local t
  for t in $HOOK_TOOLS; do
    has_plugin_tool "$t" || HOOK_TOOL_CONFLICTS="$HOOK_TOOL_CONFLICTS $t"
  done
}

# 建 conftest 掛點（缺檔才建；既有檔只提示）。撞名工具存在時不建，提示先處理。
ensure_conftest_hook() {
  local conftest="$TESTS_DIR/conftest.py" who="$1"
  check_hook_tools
  if [ -n "$HOOK_TOOL_CONFLICTS" ]; then
    echo "[$who] ⚠️ tests/e2e/tools/ 有非本 plugin 版本的同名工具：$HOOK_TOOL_CONFLICTS"
    echo "         ACTION-REQUIRED: 掛點會 import 到它們而讓 pytest 收集失敗，所以沒有建立／提示 conftest 掛點。"
    echo "         先把撞名的專案檔改名，跑 qa-flow.sh tools-sync，再把 $SKILL_DIR/templates/conftest_snippet.py 放進 tests/e2e/conftest.py。"
    return 0
  fi
  if [ ! -f "$conftest" ]; then
    cp "$SKILL_DIR/templates/conftest_snippet.py" "$conftest"
    echo "[$who] 已建立：$conftest（含 qa-webwright 掛點：sqlite 執行紀錄、A/D skip 閘、drift 摘要）"
  elif grep -q 'qa-webwright 掛點' "$conftest"; then
    echo "[$who] conftest.py 已含 qa-webwright 掛點"
  else
    echo "[$who] ⚠️ 既有 $conftest 沒有 qa-webwright 掛點，不自動改寫。"
    echo "           ACTION-REQUIRED: 把 $SKILL_DIR/templates/conftest_snippet.py 的內容貼到該檔尾，"
    echo "           sqlite 執行紀錄、A/D skip 閘、drift 摘要才會生效。"
  fi
}

# 指令有沒有任何輸出。不用 `find … | grep -q .`：pipefail 下 grep 找到第一行就結束，
# 輸出量大時 find 會收到 SIGPIPE、整條管線被當成失敗（＝誤判成「沒有」）。
has_output() {
  [ -n "$("$@" 2>/dev/null)" ]
}

# tests/e2e 底下有 JS 測試（*.spec.js／*.spec.ts）但沒有 test_*.py＝playwright-js 專案
is_js_project() {
  has_output find "$TESTS_DIR" -type f \( -name '*.spec.js' -o -name '*.spec.ts' \) -not -path '*/node_modules/*' || return 1
  has_output find "$TESTS_DIR" -type f -name 'test_*.py' -not -path '*/tools/*' && return 1
  return 0
}

# 參數檔目前開啟了哪些閘（scaffold 用範例建參數檔時，範例會開啟數支閘——要讓使用者知道）
print_enabled_gates() {
  [ -f "$CONFIG_FILE" ] || return 0
  require_python
  # 只是資訊列印：參數檔壞掉／型別不對不得中斷 scaffold／migrate（set -e）；中文輸出固定 UTF-8
  PYTHONIOENCODING=utf-8 "$PY_CMD" -c 'import json, sys
c = json.load(open(sys.argv[1], encoding="utf-8-sig"))
on = []
if isinstance(c.get("hook"), dict) and c["hook"].get("enabled") is False:
    print("  （hook.enabled=false：所有 hook 閘皆關閉）"); sys.exit(0)
d = c.get("dispatch_gate")
if isinstance(d, dict) and d.get("enabled", True) is not False: on.append("dispatch_gate（派 qa-engineer 的派工單表態）")
g = c.get("commit_gate")
if isinstance(g, dict) and g.get("enabled") is True: on.append("commit_gate（行為類改動 commit 前 QA 表態）")
r = [x.get("name") or x.get("when_regex") for x in (c.get("command_guards") or []) if isinstance(x, dict) and x.get("enabled", True) is not False]
if r: on.append("command_guards（" + "、".join(map(str, r)) + "）")
h = c.get("report_hygiene")
if isinstance(h, dict) and h.get("enabled", True) is not False and h.get("roots"): on.append("report_hygiene（交付根：" + "、".join(map(str, h["roots"])) + "）")
b = c.get("browser_guard")
if isinstance(b, dict) and b.get("enabled", True) is not False and (b.get("deny_hosts_regex") or b.get("rate_limits")): on.append("browser_guard（正式站禁止／導向限速）")
p = c.get("pretest")
if isinstance(p, dict) and p.get("enabled", True) is not False and (p.get("alignment") or p.get("side_effect_guards")): on.append("pretest（測試前環境對齊／副作用防線）")
print("  " + ("\n  ".join(on) if on else "（沒有開啟任何 PreToolUse 閘）"))' "$(native_path "$CONFIG_FILE")" \
    || echo "  （參數檔無法解析或欄位型別不對，無法列出開啟的閘；請檢查 $CONFIG_FILE）"
}

# 專案自有的 CATALOG.md（不是本 plugin 的舊版骨架、也不是 gen_catalog 生成的）→ 回 0。
# 三層模式的 gen_catalog 會拒絕覆寫它；bootstrap／scaffold 先講清楚，免得以為索引會自動更新。
is_project_catalog() {
  [ -f "$CATALOG_FILE" ] || return 1
  is_plugin_legacy_catalog && return 1
  grep -q 'tools/gen_catalog\.py` 生成' "$CATALOG_FILE" 2>/dev/null && return 1
  return 0
}

# 舊版落地物遷移：0.3.1 時代 catalog 落在 WORKSPACE_DIR/catalog.md（root），
# 0.3.2 起改 tests/e2e/catalog.md。偵測到 root 舊檔（含本 plugin 表頭）就搬/併過來，
# 免得另建空 catalog 造成雙檔漂移、舊資料被遺棄。
migrate_legacy_catalog() {
  local legacy="$WORKSPACE_DIR/catalog.md"
  [ -f "$legacy" ] || return 0
  # 嚴格識別「本 plugin 的 catalog」：要同時命中兩個本 plugin 專屬特徵。
  grep -q 'qa-flow\.sh catalog 回填' "$legacy" 2>/dev/null || return 0
  grep -qF '白話業務情境 | 對應測試函式 | 覆蓋狀態 | 業務模組分類' "$legacy" 2>/dev/null || return 0
  [ "$legacy" = "$CATALOG_FILE" ] && return 0

  mkdir -p "$TESTS_DIR"
  if [ ! -f "$CATALOG_FILE" ]; then
    mv "$legacy" "$CATALOG_FILE"
    echo "[qa-flow] 遷移舊版 catalog：$legacy → $CATALOG_FILE（保留全部內容）" >&2
    return 0
  fi
  # 目的檔必須也是本 plugin 的舊版骨架才合併：專案自有索引或三層生成的 CATALOG 一律不碰（舊檔也不搬）
  if ! is_plugin_legacy_catalog; then
    echo "[qa-flow] ⚠️ 偵測到根目錄舊版 catalog（$legacy），但 $CATALOG_FILE 不是本 plugin 的舊版骨架（專案自有或三層生成）——不合併、不搬動，請人工處理。" >&2
    return 0
  fi

  # 兩者都存在 → 把舊檔資料列併入新檔（以新檔函式為準去重），舊檔改名保留供人工確認。
  local today merged line func
  today="$(date +%F)"
  merged="$(mktemp "$TESTS_DIR/.catalog.merge.XXXXXX")"
  cp "$CATALOG_FILE" "$merged"
  while IFS= read -r line; do
    case "$line" in \|*) ;; *) continue ;; esac
    case "$line" in *白話業務情境*) continue ;; esac
    printf '%s' "$line" | grep -qE '^\|[[:space:]-]+\|' && continue
    func="$(printf '%s' "$line" | awk -F'|' '{gsub(/^ +| +$/,"",$3); print $3}')"
    [ -z "$func" ] && continue
    case "$func" in "—"|"-") continue ;; esac
    # 值經環境變數傳給 awk（命令列的 f=值 與 -v 一樣會把反斜線當跳脫）
    if ! QA_F="$func" awk -F'|' '{gsub(/^ +| +$/,"",$3); if($3==ENVIRON["QA_F"]) found=1} END{exit !found}' "$CATALOG_FILE"; then
      printf '%s\n' "$line" >> "$merged"
    fi
  done < "$legacy"
  mv -f "$merged" "$CATALOG_FILE"
  # 同一天第二次遷移不得蓋掉前一份備份：已存在就加遞增序號
  local bak="$legacy.migrated-$today" n=2
  while [ -e "$bak" ]; do
    bak="$legacy.migrated-$today-$n"
    n=$((n + 1))
  done
  mv "$legacy" "$bak"
  echo "[qa-flow] 已合併舊版 catalog 資料列 → $CATALOG_FILE；舊檔改名 $bak（可人工確認後刪）" >&2
}

# 舊版單一 catalog 骨架（legacy 模式與 playwright-js 用；三層模式不建）。
ensure_legacy_catalog() {
  [ -f "$CATALOG_FILE" ] && return 0
  mkdir -p "$TESTS_DIR"
  local tmp
  tmp="$(mktemp "$TESTS_DIR/.catalog.new.XXXXXX")"
  cat > "$tmp" <<'EOF'
# 情境覆蓋索引（catalog）

> 跨功能、持久化的「應測情境 ＋ 各自覆蓋狀態」單一真相來源（含 ❌未覆蓋）。
> 由 qa-flow.sh catalog 回填，邊 codify 邊登記。詳見 browser-qa skill
> methodology/test-plan-design.md §0.5。
>
> 覆蓋狀態：✅完整（操作＋讀回） / ⚠️部分（附缺口原因） / ❌未覆蓋

| 白話業務情境 | 對應測試函式 | 覆蓋狀態 | 業務模組分類 |
|------|------|------|------|
EOF
  mv -f "$tmp" "$CATALOG_FILE"
  echo "[qa-flow] 已建立 catalog 骨架：$CATALOG_FILE" >&2
}

assert_valid_runner() {
  local r="$1" v
  for v in "${VALID_RUNNERS[@]}"; do
    [ "$v" = "$r" ] && return 0
  done
  echo "ERROR: Invalid runner: $r（合法值：${VALID_RUNNERS[*]}）" >&2
  exit 1
}

# feature 是「識別字」，不得含任何路徑分隔或上鑽——否則 feature=foo/bar 會在
# tests/e2e/ 底下再鑽子目錄，破壞「不鑽子目錄」的落點鎖定。只允許英數 . _ -。
assert_safe_feature() {
  local name="$1"
  case "$name" in
    ""|*/*|*..*|/*)
      echo "ERROR: feature 不得含 '/'、'..' 或為絕對路徑：$name（feature 是識別字，非路徑）" >&2
      exit 1
      ;;
  esac
  if ! printf '%s' "$name" | grep -Eq '^[A-Za-z0-9_.-]+$' || printf '%s' "$name" | grep -Eq '^\.+$'; then
    echo "ERROR: feature 只能含 英數字 / _ / - / .（且不得為純點名）：$name" >&2
    exit 1
  fi
  # 稽核工具會略過的資料夾名（工具、報告、共用層、隱藏／雙底線開頭）不得當 feature：建了也永遠不會被稽核
  # 不分大小寫：macOS／Windows 的檔案系統不分大小寫，Tools 與 tools 是同一個資料夾
  local fid
  fid="$(printf '%s' "${name//-/_}" | tr '[:upper:]' '[:lower:]')"
  case "$fid" in
    tools|reports|_reports|outputs|node_modules|helpers|.*|__*)
      echo "ERROR: feature 不得是 $fid（稽核工具會略過這個資料夾，測試與登記會永遠漏出漂移稽核）" >&2
      exit 1
      ;;
  esac
}

# 把使用者給的 test-file 正規化到 WORKSPACE_DIR/tests/e2e/ 底下並驗證存在。
resolve_test_file() {
  local f="$1"
  case "$f" in
    /*|*..*)
      echo "ERROR: test-file 不得為絕對路徑或含 '..'：$f" >&2
      exit 1
      ;;
  esac
  # 一律要求落在 tests/e2e/ 下。接受三種寫法：
  #   1. tests/e2e/<模組>/x.py（完整相對路徑）
  #   2. <模組>/x.py（相對 tests/e2e 的模組路徑）—— 多數專案把測試分模組放子目錄，此為常態
  #   3. x.py（裸檔名，直接放 tests/e2e 根下）
  # 早期版本把 2 誤判成「不在 tests/e2e 下」而擋掉，導致子目錄式專案完全無法用 run。
  case "$f" in
    tests/e2e/*) ;;
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
# ------------------------------------------------------------

cmd_bootstrap() {
  echo "=== qa-flow bootstrap ==="
  echo "WORKSPACE_DIR: $WORKSPACE_DIR"
  echo "（測試落點一律在此目錄下，不鑽子專案目錄）"
  echo ""

  echo "--- 環境自檢 ---"
  if command -v node >/dev/null 2>&1; then
    echo "node： $(node --version 2>/dev/null)"
  else
    echo "node： ⚠️ 找不到——**Stop hook 落地強制在本機不會生效**（hook 靠 node 執行，harness 會靜默跳過）。" >&2
  fi
  detect_python
  if [ -n "$PY_CMD" ]; then
    echo "python： $PY_CMD（$("$PY_CMD" --version 2>&1)）"
  else
    echo "python： ⚠️ 找不到（試過 python3 / python / py）" >&2
  fi
  detect_pytest
  if [ -n "$PYTEST_CMD" ]; then
    echo "pytest： $PYTEST_CMD（可用）"
  else
    echo "pytest： ⚠️ 找不到——run 階段會報錯。" >&2
    echo "       greenfield 請於 scaffold 後執行：python3 -m pip install pytest-playwright && python3 -m playwright install chromium" >&2
  fi
  echo ""

  migrate_legacy_catalog
  detect_mode

  local has_pytest=0 has_js=0 marker
  local py_hits=() js_hits=()
  for marker in conftest.py pytest.ini pyproject.toml setup.cfg; do
    [ -f "$WORKSPACE_DIR/$marker" ] && { has_pytest=1; py_hits+=("$marker"); }
  done
  [ -f "$TESTS_DIR/conftest.py" ] && { has_pytest=1; py_hits+=("tests/e2e/conftest.py"); }
  if has_output find "$WORKSPACE_DIR" -maxdepth 4 -type f -name 'test_*.py' -not -path '*/node_modules/*'; then
    has_pytest=1
    py_hits+=("test_*.py（已存在）")
  fi
  [ -f "$WORKSPACE_DIR/playwright.config.ts" ] && { has_js=1; js_hits+=("playwright.config.ts"); }
  [ -f "$WORKSPACE_DIR/playwright.config.js" ] && { has_js=1; js_hits+=("playwright.config.js"); }
  if has_output find "$WORKSPACE_DIR" -maxdepth 4 -type f \( -name '*.spec.js' -o -name '*.spec.ts' \) -not -path '*/node_modules/*'; then
    has_js=1
    js_hits+=("*.spec.js/ts（已存在）")
  fi

  echo "--- 既有測試資產 ---"
  [ $has_pytest -eq 1 ] && echo "Python/pytest： ${py_hits[*]}"
  [ $has_js -eq 1 ] && echo "JS/Playwright： ${js_hits[*]}"
  if [ $has_pytest -eq 0 ] && [ $has_js -eq 0 ]; then
    echo "(none)"
  fi
  echo ""

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
    echo "      同意   → qa-flow.sh scaffold <feature> pytest（預設三層登記）"
    echo "      不同意 → qa-flow.sh scaffold <feature> playwright-js（退而求其次）"
  fi
  echo ""

  echo "--- 登記模式 ---"
  echo "MODE: $MODE"
  case "$MODE" in
    three-layer)
      echo "  三層：<模組>/COVERAGE.md（正本）＋ .runs/results.sqlite（執行事實）＋ 生成 CATALOG.md"
      echo "  參數檔：$CONFIG_FILE"
      if [ -f "$INSTALLER" ]; then
        require_python
        "$PY_CMD" "$(native_path "$INSTALLER")" status "$(native_path "$TESTS_DIR")" | sed 's/^/  /'
      fi
      ;;
    legacy-catalog)
      echo "  舊版單一 catalog：$CATALOG_FILE（維持相容）"
      if is_js_project; then
        echo "  JS（playwright-js）專案：維持單一 catalog。三層工具與 migrate 只適用 pytest 測試。"
      else
        echo "  NEXT（建議）：qa-flow.sh migrate —— 轉成三層（列數對帳、舊檔改名保留）"
      fi
      ;;
    three-layer-no-config)
      echo "  偵測到 <模組>/COVERAGE.md 但沒有 $CONFIG_FILE（專案自有三層？）"
      echo "  NEXT：要接本 plugin 工具 → qa-flow.sh scaffold <feature> pytest（只補缺的，不覆寫既有檔）"
      ;;
    none)
      echo "  尚無登記。scaffold pytest 會建立三層架構（新專案預設）。"
      ;;
  esac
  if is_project_catalog; then
    echo "PROJECT-CATALOG: $CATALOG_FILE 是專案自有格式（不是本 plugin 骨架、也不是 gen_catalog 生成的）"
    echo "  本工具**不會覆寫**它：三層模式的 CATALOG 重生會拒絕寫入並提示。"
    echo "  要本 plugin 的生成索引 → 在 qa-webwright.json 設 catalog.file 為別的檔名（例 \"QA-CATALOG.md\"）。"
  fi
  echo ""

  if [ -f "$WORKSPACE_DIR/tests/Project_Detail/PROJECT.md" ]; then
    echo "PROJECT-KNOWLEDGE: found $WORKSPACE_DIR/tests/Project_Detail/PROJECT.md"
    echo "NEXT: 先完整讀該檔（專案 QA 知識路由中心），再依其路由按需讀分層檔。"
  else
    echo "PROJECT-KNOWLEDGE: missing（無 tests/Project_Detail/PROJECT.md；若該專案有專屬 QA 知識，建議建立此路由入口）"
  fi

  # 每次 QA 起點自動核對登記漂移（只警告不改）。audit 的 exit 3 = 有漂移（預期內、不算 bootstrap 失敗）。
  echo ""
  local audit_rc=0
  cmd_audit || audit_rc=$?
  if [ "$audit_rc" -ne 0 ] && [ "$audit_rc" -ne 3 ]; then
    echo "[qa-flow] ⚠️ audit 執行異常（exit $audit_rc），請檢查 catalog/tests 狀態。" >&2
    return "$audit_rc"
  fi
}

# ------------------------------------------------------------
# Command: scaffold <feature> <pytest|playwright-js>
#   pytest（非 legacy 模式）→ 三層：複製工具＋參數檔＋conftest 掛點＋<feature>/COVERAGE.md 骨架。
#   安裝指令只印出讓使用者跑，腳本不代跑。
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
  local feature_id="${feature//-/_}"
  feature_id="${feature_id//./_}"   # 檔名／資料夾名的 . 也換成 _：test_foo.bar.py 寫不進 test_x.py::test_y 登記格式
  detect_mode
  mkdir -p "$TESTS_DIR" "$REPORTS_DIR"

  echo "=== qa-flow scaffold（$runner）==="
  echo "落點：$TESTS_DIR"
  echo ""

  if [ "$runner" = "playwright-js" ] && [ "$MODE" = "three-layer" ]; then
    # 已是三層模式：不另建舊版單一 catalog（兩套登記互不同步）；JS 測試用「函式欄填 —」登記在 COVERAGE.md
    echo "runner：Playwright Test（JS）。本專案已是三層登記（$CONFIG_FILE），不另建單一 catalog。"
    echo ""
    echo "--- 需使用者執行的安裝指令（腳本不代跑）---"
    echo "  npm i -D @playwright/test && npx playwright install chromium"
    echo ""
    echo "NEXT: 沉澱成 $TESTS_DIR/${feature_id}.spec.js 的 expect 斷言，用 npx playwright test --reporter=junit 產報告"
    echo "      → 登記進 COVERAGE：qa-flow.sh catalog \"<白話情境>（spec：<測試標題>）\" — <完整|部分|未覆蓋> <資料夾或 .>"
    echo "        （三層登記器只認 pytest 函式；JS 測試函式欄填 —，把 spec 標題寫進情境欄）"
    return 0
  fi
  if [ "$runner" = "playwright-js" ]; then
    ensure_legacy_catalog
    echo "runner：Playwright Test（JS，退而求其次——使用者不同意裝 Python）。三層工具為 pytest 專用，JS 用單一 catalog。"
    echo ""
    echo "--- 需使用者執行的安裝指令（腳本不代跑）---"
    echo "  npm i -D @playwright/test && npx playwright install chromium"
    echo ""
    echo "NEXT: 探索路徑 → 沉澱成 $TESTS_DIR/${feature_id}.spec.js 的 expect 斷言"
    echo "      → 用 npx playwright test --reporter=junit 產報告，qa-flow.sh catalog 回填"
    return 0
  fi

  if [ "$MODE" = "legacy-catalog" ]; then
    local conftest="$TESTS_DIR/conftest.py"
    if [ ! -f "$conftest" ]; then
      cat > "$conftest" <<'EOF'
# conftest.py — pytest-playwright 最小骨架（qa-flow.sh scaffold 產生）
import os
import pytest


@pytest.fixture(scope="session")
def base_url() -> str:
    return os.environ.get("QA_BASE_URL", "http://localhost")
EOF
      echo "已建立：$conftest（最小骨架）"
    fi
    echo "MODE: legacy-catalog（沿用舊版單一 catalog；建議 qa-flow.sh migrate 轉三層）"
    echo "NEXT: 把每個 CP 沉澱成 $TESTS_DIR/test_${feature_id}.py 的 assert"
    echo "      → qa-flow.sh run $feature tests/e2e/test_${feature_id}.py"
    return 0
  fi

  # ---- 三層 ----
  require_python
  local rc=0
  "$PY_CMD" "$(native_path "$INSTALLER")" install "$(native_path "$TESTS_DIR")" || rc=$?
  if [ "$rc" -ne 0 ] && [ "$rc" -ne 3 ]; then
    echo "ERROR: 工具安裝失敗（exit $rc）" >&2
    exit "$rc"
  fi

  ensure_conftest_hook scaffold
  echo "[scaffold] 參數檔 $CONFIG_FILE 目前開啟的閘（範例預設開啟；不要的段設 enabled:false 或刪掉該段）："
  print_enabled_gates

  local fdir="$TESTS_DIR/$feature_id"
  mkdir -p "$fdir"
  if [ -f "$fdir/COVERAGE.md" ]; then
    echo "[scaffold] 已存在，不覆寫：$fdir/COVERAGE.md"
  else
    run_tool make_skeleton.py "$feature_id" "$feature" \
      || echo "[scaffold] ⚠️ 沒有建立 $fdir/COVERAGE.md 骨架（見上方訊息）；可手動依 COVERAGE 表格約定建立。" >&2
  fi
  if is_project_catalog; then
    echo "[scaffold] ⚠️ $CATALOG_FILE 是專案自有格式：本 plugin 不會覆寫它，三層索引不會自動重生到這個檔名。"
    echo "           要生成索引 → 在 $CONFIG_FILE 設 catalog.file 為別的檔名（例 \"QA-CATALOG.md\"）。"
  fi

  echo ""
  echo "--- 需使用者執行的安裝指令（腳本不代跑）---"
  echo "  Windows：python -m pip install pytest-playwright && python -m playwright install chromium"
  echo "  macOS／Linux：python3 -m pip install pytest-playwright && python3 -m playwright install chromium"
  echo ""
  echo "NEXT: 把每個 CP 沉澱成 $fdir/test_${feature_id}.py 的 assert"
  echo "      → qa-flow.sh run $feature $feature_id/test_${feature_id}.py"
  echo "      → qa-flow.sh catalog <白話情境> test_${feature_id}.py::<函式> <完整|部分|未覆蓋> $feature_id"
  echo "      codify 完成判準：drift_check 0/0/0（孤兒／幽靈／佔位）"
}

# ------------------------------------------------------------
# Command: run <feature> <test-file> [date]
#   grep 驗證 test 函式確實寫入（防假綠燈）→ pytest --junitxml 出報告。
#   三層模式：跑完重生 CATALOG（最後執行日期由 sqlite 帶入）。
# ------------------------------------------------------------

cmd_run() {
  local feature="${1:-}"
  local test_file="${2:-}"
  local date="${3:-$(date +%F)}"
  if [ -z "$feature" ] || [ -z "$test_file" ]; then
    echo "Usage: qa-flow.sh run <feature> <test-file（相對 session 目錄）> [date（YYYY-MM-DD，省略=今天）]" >&2
    exit 1
  fi
  assert_safe_feature "$feature"
  # date 會拼進報告檔名：只收 YYYY-MM-DD（含 / 或 .. 會讓報告寫到 reports/ 外）
  if ! printf '%s' "$date" | grep -Eq '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'; then
    echo "ERROR: date 必須是 YYYY-MM-DD 格式：$date" >&2
    exit 1
  fi

  local abs_test
  abs_test="$(resolve_test_file "$test_file")"
  # 測試檔本身是 symlink：實體可能在 tests/e2e 外（下面的實體路徑檢查只解析父目錄），一律拒絕
  if [ -L "$abs_test" ]; then
    echo "ERROR: 測試檔是 symlink（$abs_test）——實體可能不在 tests/e2e 下。請把測試檔本體放進 tests/e2e。" >&2
    exit 1
  fi

  # 守門員（symlink 逃逸偵測）：canonical 只在「兩邊都成功解析出實體路徑」時才比對，
  # 兩邊一律用 `cd && pwd -P`（統一格式；Windows 上 realpath 與 pwd -P 格式不同曾誤擋）。
  # 比對用「前綴涵蓋」而非「父目錄相等」：測試檔常放在 tests/e2e/<模組>/ 子目錄。
  local canon_test="" canon_expected_dir="" test_parent
  canon_test="$( { cd "$(dirname "$abs_test")" 2>/dev/null && printf '%s/%s' "$(pwd -P)" "$(basename "$abs_test")"; } || true)"
  canon_expected_dir="$( { cd "$TESTS_DIR" 2>/dev/null && pwd -P; } || true)"
  if [ -n "$canon_test" ] && [ -n "$canon_expected_dir" ]; then
    test_parent="$(dirname "$canon_test")"
    if [ "$test_parent" != "$canon_expected_dir" ] && \
       [ "${test_parent#"$canon_expected_dir"/}" = "$test_parent" ]; then
      echo "ERROR: 測試檔落點不對——實體路徑不在啟動目錄的 tests/e2e/ 下（可能是 symlink 指向外部）。" >&2
      echo "       啟動目錄(WORKSPACE_DIR)：$WORKSPACE_DIR" >&2
      echo "       應在：           $canon_expected_dir" >&2
      echo "       實際測試檔在：   $test_parent" >&2
      echo "       修法：(a) 把測試移回 $canon_expected_dir 下重跑；(b) 要測子專案 → 到那個目錄重新啟動 claude。" >&2
      exit 1
    fi
  fi

  echo "=== 落地驗證（防假綠燈）==="
  if ! grep -qE '^[[:space:]]*(async[[:space:]]+)?def[[:space:]]+test_' "$abs_test"; then
    echo "ERROR: $abs_test 內找不到任何 test_ 函式定義——" >&2
    echo "       Write/replace 可能假成功（並行取消時），未真正落地。請重新沉澱測試碼後再跑。" >&2
    exit 1
  fi
  local n_tests
  n_tests=$(grep -cE '^[[:space:]]*(async[[:space:]]+)?def[[:space:]]+test_' "$abs_test")
  echo "OK：偵測到 $n_tests 個 test_ 函式於 $test_file"
  echo ""

  # 報告落點不得是 symlink：reports 目錄或同名舊報告連到 tests/e2e 外，pytest 會沿連結覆寫外部檔
  local report="$REPORTS_DIR/${feature}-${date}.xml"
  if [ -L "$REPORTS_DIR" ] || [ -L "$report" ]; then
    echo "ERROR: 報告落點是 symlink（$REPORTS_DIR 或 $report）——實體可能在 tests/e2e 外，拒絕寫入。" >&2
    exit 1
  fi
  mkdir -p "$REPORTS_DIR"
  local canon_reports=""
  canon_reports="$( { cd "$REPORTS_DIR" 2>/dev/null && pwd -P; } || true)"
  if [ -n "$canon_reports" ] && [ -n "$canon_expected_dir" ] && [ "$canon_reports" != "$canon_expected_dir/reports" ]; then
    echo "ERROR: 報告資料夾的實體路徑不在 tests/e2e/reports（$canon_reports；junction／symlink？），拒絕寫入。" >&2
    exit 1
  fi
  detect_pytest
  if [ -z "$PYTEST_CMD" ]; then
    echo "ERROR: 找不到可用的 pytest（試過 pytest / python3 -m pytest / python -m pytest / py -m pytest）。" >&2
    echo "       請先安裝：python3 -m pip install pytest-playwright && python3 -m playwright install chromium" >&2
    exit 1
  fi
  export PYTHONIOENCODING="${PYTHONIOENCODING:-utf-8}"

  echo "=== 執行 pytest（$PYTEST_CMD）==="
  local py_test py_report
  py_test="$(native_path "$abs_test")"
  py_report="$(native_path "$report")"
  echo "$PYTEST_CMD \"$py_test\" --junitxml=\"$py_report\""
  set +e
  $PYTEST_CMD "$py_test" --junitxml="$py_report"
  local rc=$?
  set -e
  echo ""
  echo "=== 結果 ==="
  echo "exit code: $rc（0=全綠、非0=有 FAIL 或 A/D 類執行期 skip）"
  echo "報告產物: $report"
  detect_mode
  if [ "$MODE" = "three-layer" ] && has_plugin_tool gen_catalog.py; then
    run_tool gen_catalog.py || echo "[qa-flow] ⚠️ CATALOG 未重生（見上方自檢訊息）" >&2
  fi
  exit $rc
}

# ------------------------------------------------------------
# Command: catalog <情境> <測試函式> <狀態> <模組>
#   三層：寫入 <模組>/COVERAGE.md（模組＝tests/e2e 下的資料夾名；根目錄用 .）後重生 CATALOG。
#   legacy：機械 append/update 單一 catalog 的一列（以測試函式為主鍵）。
#   寫入一律同目錄 tmp ＋ 原子 rename：不 rm、不先刪後寫——Windows NTFS 與 macOS APFS
#   預設大小寫不敏感，catalog.md 與 CATALOG.md 是同一個檔（2026-07-17 曾因此刪掉正本）。
# ------------------------------------------------------------

cmd_catalog() {
  local scenario="${1:-}" func="${2:-}" state="${3:-}" module="${4:-}"
  if [ -z "$scenario" ] || [ -z "$func" ] || [ -z "$state" ] || [ -z "$module" ]; then
    echo "Usage: qa-flow.sh catalog <白話情境> <測試函式(或 —)> <覆蓋狀態> <模組>" >&2
    echo "  覆蓋狀態：完整 / 部分 / 未覆蓋（會自動加 ✅/⚠️/❌）" >&2
    echo "  三層模式的 <模組> ＝ tests/e2e 下的資料夾名（根目錄用 .）；函式可寫 test_x.py::test_y" >&2
    exit 1
  fi
  detect_mode
  if [ "$MODE" = "three-layer" ]; then
    if ! has_plugin_tool coverage_register.py; then
      echo "ERROR: 三層模式但 tests/e2e/tools/coverage_register.py 不存在或非本 plugin 版本——先跑 qa-flow.sh tools-sync" >&2
      exit 1
    fi
    run_tool coverage_register.py "$scenario" "$func" "$state" "$module"
    if has_plugin_tool gen_catalog.py; then
      run_tool gen_catalog.py || echo "[qa-flow] ⚠️ CATALOG 未重生（COVERAGE.md 已寫入；見上方自檢訊息）" >&2
    else
      echo "[qa-flow] tests/e2e/tools/gen_catalog.py 不是本 plugin 版本（專案自有生成器），不代跑；COVERAGE.md 已寫入，CATALOG 請用專案自己的方式重生。" >&2
    fi
    return 0
  fi
  if [ "$MODE" = "none" ] || [ "$MODE" = "three-layer-no-config" ]; then
    echo "ERROR: 尚無本 plugin 的登記檔（MODE=$MODE）。先跑 qa-flow.sh scaffold <feature> pytest 建立三層架構。" >&2
    exit 1
  fi

  # ---- legacy 單一 catalog ----
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
  local v
  for v in "$scenario" "$func" "$module"; do
    case "$v" in
      *"|"*|*$'\n'*|*$'\r'*)
        echo "ERROR: catalog 欄位值不得含 '|' 或換行（會破壞表格）：$v" >&2
        exit 1
        ;;
    esac
  done
  local newline="| $scenario | $func | $state_disp | $module |"
  local key_col key_val
  if [ "$func" = "—" ] || [ "$func" = "-" ]; then
    key_col=1; key_val="$scenario"
  else
    key_col=2; key_val="$func"
  fi
  local tmp
  tmp="$(mktemp "$TESTS_DIR/.catalog.write.XXXXXX")"
  # 值經環境變數傳給 awk（-v 會把反斜線當跳脫：情境文字裡的 C:\temp 會被改成 tab）
  QA_KEY_COL="$key_col" QA_KEY_VAL="$key_val" QA_NEWLINE="$newline" awk '
    BEGIN { key_col=ENVIRON["QA_KEY_COL"]+0; key_val=ENVIRON["QA_KEY_VAL"]; newline=ENVIRON["QA_NEWLINE"]; updated=0 }
    /^\|/ && $0 !~ /白話業務情境/ && $0 !~ /^\|[- ]+\|/ {
      n = split($0, cells, "|")
      val = cells[key_col+1]
      gsub(/^ +| +$/, "", val)
      if (val == key_val) { print newline; updated=1; next }
    }
    { print }
    END { if (!updated) print newline }
  ' "$CATALOG_FILE" > "$tmp"
  mv -f "$tmp" "$CATALOG_FILE"
  echo "catalog 已回填：$CATALOG_FILE"
  echo "  $newline"
}

# ------------------------------------------------------------
# Command: audit [--fix]
#   三層：呼叫 tools/drift_check.py all（孤兒／幽靈／佔位）；--fix 用 fill_orphans 把孤兒補成佔位列。
#   legacy：核對 catalog 第 2 欄 vs 實際 test 函式，揪孤兒列；--fix 標成 ❌未覆蓋。
#   回傳：有漂移且未修 → exit 3；乾淨或已修 → exit 0。
# ------------------------------------------------------------

cmd_audit() {
  local fix=0
  [ "${1:-}" = "--fix" ] && fix=1
  detect_mode

  if [ "$MODE" = "three-layer" ] || [ "$MODE" = "three-layer-no-config" ]; then
    if ! has_plugin_tool drift_check.py; then
      echo "[qa-flow audit] 三層登記但 tests/e2e/tools/drift_check.py 不是本 plugin 版本（或不存在），跳過漂移稽核。"
      echo "[qa-flow audit] 要接本 plugin 工具：qa-flow.sh scaffold <feature> pytest 或 qa-flow.sh tools-sync。"
      return 0
    fi
    local rc=0
    run_tool drift_check.py all || rc=$?
    if [ "$rc" -eq 0 ]; then
      echo "[qa-flow audit] drift 0/0/0。"
      return 0
    fi
    if [ "$rc" -ne 1 ]; then
      return "$rc"
    fi
    if [ $fix -eq 1 ]; then
      run_tool fill_orphans.py all || return $?
      # 補成佔位列只是「看得見」，不是修好：重跑 drift，還有漂移（佔位／幽靈／補不進去的孤兒）就照實回 3
      local rc2=0
      run_tool drift_check.py all >/dev/null || rc2=$?
      if [ "$rc2" -eq 0 ]; then
        echo "[qa-flow audit] drift 0/0/0。"
        return 0
      fi
      echo "[qa-flow audit] 孤兒已補成佔位列，但仍有漂移（佔位列的情境欄待補寫、幽靈需人工改 COVERAGE.md）——codify 未完成。" >&2
      return 3
    fi
    echo "[qa-flow audit] ⚠️ 有漂移：補登記 COVERAGE.md（或 audit --fix 先把孤兒補成佔位列）。" >&2
    return 3
  fi

  if [ ! -f "$CATALOG_FILE" ]; then
    echo "[qa-flow audit] 無 catalog（$CATALOG_FILE），略過。"
    return 0
  fi
  # 格式守門：解析假設（第 2 欄＝測試函式）只對本 plugin 的 catalog 骨架成立。
  # 專案自有格式的 catalog 解析必然全錯，會把整份誤判成孤兒（實測 320 列全報孤兒的事故）。
  if ! grep -q 'qa-flow\.sh catalog 回填' "$CATALOG_FILE" 2>/dev/null; then
    echo "[qa-flow audit] catalog 非本 plugin 骨架格式（缺「qa-flow.sh catalog 回填」標記），跳過孤兒稽核。"
    echo "[qa-flow audit] ⚠️ 勿對此檔跑 audit --fix（會用錯誤解析改寫使用者自有格式）。"
    return 0
  fi

  local py_funcs js_titles funcs_present
  py_funcs="$(grep -rhoE '^[[:space:]]*(async[[:space:]]+)?def[[:space:]]+(test_[A-Za-z0-9_]+)' "$TESTS_DIR" \
                    --include='test_*.py' 2>/dev/null \
                    | sed -E 's/.*def[[:space:]]+//' || true)"
  # JS：test('標題') / test("標題")（含 test.only/test.skip 等變體）的第一個字串參數。
  js_titles="$(grep -rhoE "test(\.[A-Za-z]+)?\([[:space:]]*['\"][^'\"]+['\"]" "$TESTS_DIR" \
                    --include='*.spec.js' --include='*.spec.ts' 2>/dev/null \
                    | sed -E "s/^test(\.[A-Za-z]+)?\([[:space:]]*['\"]//; s/['\"]$//" || true)"
  # 完整式登記（migrate 要求用來消歧義的 test_x.py::test_y、資料夾/test_x.py::test_y）也要認得
  local py_refs
  py_refs="$(grep -rHoE '^[[:space:]]*(async[[:space:]]+)?def[[:space:]]+test_[A-Za-z0-9_]+' "$TESTS_DIR" \
                    --include='test_*.py' 2>/dev/null \
                    | sed -E 's/:[[:space:]]*(async[[:space:]]+)?def[[:space:]]+/::/' \
                    | QA_AUDIT_PRE="$TESTS_DIR/" awk '{ pre=ENVIRON["QA_AUDIT_PRE"]; s=$0; if (index(s, pre) == 1) s=substr(s, length(pre)+1); print s; n=split(s, a, "/"); print a[n] }' || true)"
  # （前綴經環境變數傳給 awk：-v 會把反斜線當跳脫，Windows 原生路徑 C:\Users\… 會被改掉而比對失敗）
  funcs_present="$(printf '%s\n%s\n%s\n' "$py_funcs" "$js_titles" "$py_refs" | grep -v '^$' | sort -u || true)"

  local orphans=() line func
  while IFS= read -r line; do
    case "$line" in \|*) ;; *) continue ;; esac
    case "$line" in *白話業務情境*) continue ;; esac
    printf '%s' "$line" | grep -qE '^\|[[:space:]-]+\|' && continue
    func="$(printf '%s' "$line" | awk -F'|' '{gsub(/^ +| +$/,"",$3); print $3}')"
    [ -z "$func" ] && continue
    case "$func" in "—"|"-") continue ;; esac
    local want
    want="$(printf '%s' "$func" | tr -d '`')"
    # here-string 而非管線：funcs_present 很大時 grep -q 提早結束會讓 printf 收到 SIGPIPE（pipefail 下誤判孤兒）
    if ! grep -qxF -- "$want" <<< "$funcs_present"; then
      orphans+=("$func")
    fi
  done < "$CATALOG_FILE"

  if [ ${#orphans[@]} -eq 0 ]; then
    echo "[qa-flow audit] catalog 與 tests/e2e 一致，無孤兒列。"
    return 0
  fi
  echo "[qa-flow audit] ⚠️ 偵測到 ${#orphans[@]} 個孤兒列（catalog 有、實際 test 函式已消失）：" >&2
  printf '  - %s\n' "${orphans[@]}" >&2
  if [ $fix -eq 0 ]; then
    echo "  跑 'qa-flow.sh audit --fix' 把這些列標成 ❌未覆蓋（對應測試已不存在）。" >&2
    return 3
  fi
  local tmp orph_list
  tmp="$(mktemp "$TESTS_DIR/.catalog.audit.XXXXXX")"
  orph_list="$(printf '%s\n' "${orphans[@]}")"
  QA_ORPHANS="$orph_list" awk '
    BEGIN { orphans=ENVIRON["QA_ORPHANS"]; n=split(orphans, arr, "\n"); for(i=1;i<=n;i++) if(arr[i]!="") isorph[arr[i]]=1 }
    /^\|/ && $0 !~ /白話業務情境/ && $0 !~ /^\|[- ]+\|/ {
      nf=split($0, c, "|")
      f=c[3]; gsub(/^ +| +$/,"",f)
      if (f in isorph) {
        scen=c[2]; gsub(/^ +| +$/,"",scen)
        mod=c[5]; gsub(/^ +| +$/,"",mod)
        printf "| %s | %s | ❌未覆蓋 | %s（對應測試已不存在，audit 標記）|\n", scen, f, mod
        next
      }
    }
    { print }
  ' "$CATALOG_FILE" > "$tmp"
  mv -f "$tmp" "$CATALOG_FILE"
  echo "[qa-flow audit] 已把 ${#orphans[@]} 個孤兒列標為 ❌未覆蓋：$CATALOG_FILE"
  return 0
}

# ------------------------------------------------------------
# Command: tools-sync [--force]
#   以 plugin 本體更新 tests/e2e/tools/ 已複製的工具（帶版本標記者）。
#   專案端改過的工具只警告不覆蓋（--force 才覆蓋並先備份）；qa-webwright.json 永不覆寫。
# ------------------------------------------------------------

cmd_tools_sync() {
  if [ ! -d "$TESTS_DIR" ]; then
    echo "ERROR: $TESTS_DIR 不存在——先跑 qa-flow.sh scaffold <feature> pytest。" >&2
    exit 1
  fi
  require_python
  local rc=0
  "$PY_CMD" "$(native_path "$INSTALLER")" sync "$(native_path "$TESTS_DIR")" "$@" || rc=$?
  if [ "$rc" -eq 3 ]; then
    echo "[qa-flow tools-sync] ⚠️ 有工具因本地修改或撞名而未更新（見上方）。確認後可 tools-sync --force。" >&2
  fi
  return "$rc"
}

# ------------------------------------------------------------
# Command: migrate [--dry-run]
#   舊版單一 catalog（4 欄）→ 三層。先補工具與參數檔，再逐列寫進各 <模組>/COVERAGE.md，
#   列數對帳不符即失敗；舊檔改名保留（不刪）；最後重生 CATALOG 並印 drift。
# ------------------------------------------------------------

cmd_migrate() {
  detect_mode
  if [ "$MODE" != "legacy-catalog" ]; then
    echo "ERROR: migrate 只處理本 plugin 的舊版單一 catalog（目前 MODE=$MODE）。" >&2
    exit 2
  fi
  if is_js_project; then
    echo "ERROR: 這是 JS（playwright-js）專案：三層工具與登記器只適用 pytest 測試，遷移後 JS 測試會全部無法登記。" >&2
    echo "       維持單一 catalog（qa-flow.sh catalog 照常回填）。" >&2
    exit 2
  fi
  require_python
  local dry=0 rc=0
  [ "${1:-}" = "--dry-run" ] && dry=1
  # 先用 plugin 本體的 migrate_catalog 遷移，成功後才裝工具與參數檔：
  #   · --dry-run 不寫任何檔（不裝工具、不建參數檔、不留 __pycache__）
  #   · 遷移失敗不留參數檔——否則下次被判成 three-layer，migrate 重跑會被拒
  # 預檢工具落點（tests/e2e/tools 是連到外面的連結就不能安裝）：遷移會改名舊 catalog，
  # 裝不上工具時三層模式就回不來——所以在改寫任何檔之前先檢查
  if ! "$PY_CMD" "$(native_path "$INSTALLER")" check "$(native_path "$TESTS_DIR")"; then
    echo "ERROR: 工具落點不能用（見上方訊息），migrate 未執行、沒有改任何檔。修正後重跑 migrate。" >&2
    exit 2
  fi
  run_plugin_tool migrate_catalog.py "$@" || rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "[qa-flow migrate] 遷移未完成（exit $rc）：沒有安裝工具、沒有建立參數檔，修正後可直接重跑 migrate。" >&2
    exit "$rc"
  fi
  if [ $dry -eq 1 ]; then
    echo "[qa-flow migrate] dry-run：未寫任何檔（未裝工具、未建參數檔）。"
    return 0
  fi
  "$PY_CMD" "$(native_path "$INSTALLER")" install "$(native_path "$TESTS_DIR")" || rc=$?
  if [ "$rc" -ne 0 ] && [ "$rc" -ne 3 ]; then
    echo "ERROR: 工具安裝失敗（exit $rc）——COVERAGE.md 已寫入、舊檔已改名保留；修正後跑 $PY_CMD $(native_path "$INSTALLER") install $(native_path "$TESTS_DIR")（會補建參數檔與工具）。" >&2
    exit "$rc"
  fi
  ensure_conftest_hook "qa-flow migrate"
  echo "[qa-flow migrate] 參數檔 $CONFIG_FILE 目前開啟的閘（範例預設開啟；不要的段設 enabled:false 或刪掉該段）："
  print_enabled_gates
  run_tool gen_catalog.py || echo "[qa-flow migrate] ⚠️ CATALOG 未重生（見上方自檢訊息）" >&2
  run_tool drift_check.py all || echo "[qa-flow migrate] 遷移後尚有漂移（佔位／孤兒），請補寫 COVERAGE.md。" >&2
  return 0
}

# ------------------------------------------------------------
# Entry
# ------------------------------------------------------------

case "${1:-}" in
  bootstrap)  shift; cmd_bootstrap "$@" ;;
  scaffold)   shift; cmd_scaffold "$@" ;;
  run)        shift; cmd_run "$@" ;;
  catalog)    shift; cmd_catalog "$@" ;;
  audit)      shift; cmd_audit "$@" ;;
  tools-sync) shift; cmd_tools_sync "$@" ;;
  migrate)    shift; cmd_migrate "$@" ;;
  -h|--help|"")
    cat <<USAGE
Usage: qa-flow.sh <command> [args]

Commands:
  bootstrap                              盤點既有測試資產、偵測登記模式（MODE）、發安裝/runner 決策訊號
  scaffold <feature> <runner>            pytest：三層骨架（工具＋參數檔＋conftest 掛點＋<feature>/COVERAGE.md）
                                         playwright-js：單一 catalog；安裝指令只印出讓使用者跑
  run      <feature> <test-file> [date]  grep 驗證 test 函式存在（防假綠燈）→ pytest --junitxml 出報告
  catalog  <情境> <函式> <狀態> <模組>   三層：寫 <模組>/COVERAGE.md 並重生 CATALOG；legacy：回填單一 catalog
  audit    [--fix]                       三層：drift_check（孤兒/幽靈/佔位）；legacy：catalog 孤兒列
  tools-sync [--force]                   以 plugin 新版更新 tests/e2e/tools/（本地修改只警告不覆蓋）
  migrate  [--dry-run]                   舊版單一 catalog → 三層（列數對帳、舊檔改名保留）

落點：一律鎖 CLAUDE_PROJECT_DIR（session 起始目錄）底下的 tests/e2e/，不接受絕對路徑 / '..'。
覆蓋狀態合法值：完整 / 部分 / 未覆蓋（自動加 ✅/⚠️/❌）

Examples:
  qa-flow.sh bootstrap
  qa-flow.sh scaffold role-permission pytest
  qa-flow.sh run role-permission role_permission/test_role_permission.py
  qa-flow.sh catalog "管理員可編輯角色權限" test_role_permission.py::test_admin_edit_role 完整 role_permission
USAGE
    ;;
  *)
    echo "ERROR: Unknown command: $1" >&2
    echo "Run 'qa-flow.sh --help' for usage" >&2
    exit 1
    ;;
esac
