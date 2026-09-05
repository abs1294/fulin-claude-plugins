#!/usr/bin/env bash
# Codex 可用模型檢查閘。
#
# 為什麼需要這支：Codex 的帳戶可用模型會隨方案／服務端調整而變動，變動後
# B 軌（Codex 審查）會整批失敗，錯誤是 400 "The 'X' model is not supported"。
# 伺服器被拒時**不列舉替代品**，CLI 也沒有「列出我能用什麼」的指令，
# 過去只能靠人工逐一猜 slug 試——而猜名字會錯得很離譜：
# 2026-09-05 實測 `gpt-5.6` / `gpt-6` 都失敗，一度誤判「沒有更新的模型」，
# 但實際 slug 是 `gpt-5.6-sol` / `gpt-6-astra`，都可用且更強。
#
# 正確的清單正本是 ~/.codex/models_cache.json（CLI 自己維護，含 slug 與
# priority）。本腳本以它為準列出候選、再逐一送真請求驗證，兩層都做：
# 讀 cache 解決「不知道有哪些」，實測解決「cache 可能過期」。
#
# 用法（需在 git repo 內，codex 拒絕在非 git 目錄啟動）：
#   bash .claude/skills/git-commit/codex-model-check.sh          # 依 cache 測全部可見模型
#   bash .claude/skills/git-commit/codex-model-check.sh gpt-6-astra ...  # 只測指定的
#
# 離開碼：0＝config 目前設定的 model 可用；1＝不可用或無可用模型。

set -u

# ── 跨平台前置：解析可用的 python 與 timeout ──────────────────
# macOS 預設無 timeout（coreutils 裝了才有 gtimeout）；多數現代系統只有 python3。
# 這兩者在本機都存在，但發布給別台機器不能假設，缺了要能明確報錯而非靜默誤判。
# 注意：Windows Store 會在 WindowsApps/ 放一個假的 python3 stub，
# `command -v` 找得到但執行沒有任何輸出。所以要實際跑一次確認可用，
# 只查存在會選到假的、後續解析全部靜默失敗。
PY=""
for c in python3 python py; do
  command -v "$c" >/dev/null 2>&1 || continue
  if [ "$("$c" -c "print('ok')" 2>/dev/null)" = "ok" ]; then PY="$c"; break; fi
done
if [ -z "$PY" ]; then
  echo "找不到可執行的 python（python3／python／py 皆不可用），無法解析模型清單" >&2
  exit 1
fi

# timeout 缺席時退化為不設限執行（總比整批誤判為失敗好）
TIMEOUT_BIN=""
for c in timeout gtimeout; do
  if command -v "$c" >/dev/null 2>&1; then TIMEOUT_BIN="$c"; break; fi
done
run_probe() {  # run_probe <秒數> <指令...>
  local secs="$1"; shift
  if [ -n "$TIMEOUT_BIN" ]; then
    "$TIMEOUT_BIN" "$secs" "$@"
  else
    "$@"
  fi
}


CODEX_DIR="${CODEX_HOME:-$HOME/.codex}"
CONFIG="$CODEX_DIR/config.toml"
CACHE="$CODEX_DIR/models_cache.json"

PROBE_DIR="$(mktemp -d 2>/dev/null || echo "${TMPDIR:-/tmp}/codex-model-check.$$")"
mkdir -p "$PROBE_DIR"
# 訊號版清完立刻退出，避免帶著「暫存目錄已消失」的狀態繼續做判斷
trap 'rm -rf "$PROBE_DIR"' EXIT
# 依慣例回 128+訊號值，呼叫端才分得出中止原因
trap 'rm -rf "$PROBE_DIR"; echo "已中止（收到 SIGINT）" >&2; exit 130' INT
trap 'rm -rf "$PROBE_DIR"; echo "已中止（收到 SIGTERM）" >&2; exit 143' TERM
trap 'rm -rf "$PROBE_DIR"; echo "已中止（收到 SIGHUP）" >&2; exit 129' HUP

if ! command -v codex >/dev/null 2>&1; then
  echo "codex CLI 不在 PATH，無法實測" >&2
  exit 1
fi

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "請在 git repo 內執行（codex 拒絕在非 git 目錄啟動）" >&2
  exit 1
fi

# ── 候選來源：優先讀 cache（依 priority 由強到弱），失敗才用寫死的備援清單 ──
read_cache_models() {
  [ -f "$CACHE" ] || return 1
  # Git Bash 的 /c/... 路徑 Windows 版 python 讀不懂，需轉成 C:/... 再傳入
  # 不靠「有無 cygpath」猜環境（WSL 混用時會誤判），直接問 python 讀不讀得到
  local cache_path="$CACHE"
  if ! "$PY" -c "import io,sys; io.open(sys.argv[1], encoding='utf-8').read(1)" "$cache_path" >/dev/null 2>&1; then
    if command -v cygpath >/dev/null 2>&1; then
      cache_path="$(cygpath -m "$CACHE" 2>/dev/null || echo "$CACHE")"
    fi
  fi
  "$PY" -c "
import json, io, sys
try:
    d = json.load(io.open(sys.argv[1], encoding='utf-8'))
except Exception:
    sys.exit(1)
ms = [m for m in d.get('models', []) if m.get('visibility') == 'list' and m.get('slug')]
if not ms:
    sys.exit(1)
ms.sort(key=lambda m: m.get('priority', 9999))
sys.stdout.write(' '.join(m['slug'] for m in ms) + '\n')
" "$cache_path" 2>/dev/null | tr -d '\r'
}

if [ "$#" -gt 0 ]; then
  CANDIDATES=("$@")
  SOURCE="指定參數"
else
  cached="$(read_cache_models || true)"
  if [ -n "${cached:-}" ]; then
    # set -f：未加引號的展開會被萬用字元展開（實測 `glob_test_*` 在有符合
    # 檔名的目錄下變成多個候選）。切完詞立刻恢復。
    set -f
    # shellcheck disable=SC2206
    CANDIDATES=($cached)
    set +f
    # 候選白名單：候選會被拿去組探測輸出的檔名，未驗證的值帶 ../ 能寫到目錄外。
    filtered=()
    for c in "${CANDIDATES[@]}"; do
      case "$c" in
        *[!A-Za-z0-9._-]*|"") echo "  略過含非預期字元的候選：$c" >&2 ;;
        *) filtered+=("$c") ;;
      esac
    done
    CANDIDATES=("${filtered[@]}")
    if [ "${#CANDIDATES[@]}" -eq 0 ]; then
      echo "cache 內所有候選都含非預期字元，拒絕繼續——請確認 $CACHE 是否被竄改" >&2
      exit 1
    fi
    SOURCE="models_cache.json（依 priority 排序）"
  else
    CANDIDATES=(gpt-6-astra gpt-5.6-sol gpt-5.6-terra gpt-5.6-luna gpt-5.5 gpt-5.4-mini)
    SOURCE="內建備援清單（cache 讀不到，可能已過期）"
  fi
fi

current=""
if [ -f "$CONFIG" ]; then
  current="$(grep -m1 -E '^[[:space:]]*model[[:space:]]*=' "$CONFIG" \
    | sed -E 's/.*=[[:space:]]*"?([^"#]+)"?.*/\1/' | tr -d '[:space:]')"
fi

echo "codex-cli : $(codex --version 2>&1 | head -1)"
echo "候選來源  : ${SOURCE}"
echo "目前設定  : ${current:-（未設定）}"
echo "------------------------------------------------------------"

available=()
for m in "${CANDIDATES[@]}"; do
  out="$PROBE_DIR/${m//\//_}.txt"
  printf '  %-18s ' "$m"
  run_probe 110 codex exec --model "$m" --json "回 PING_OK" < /dev/null > "$out" 2>&1

  if grep -q "PING_OK" "$out" 2>/dev/null; then
    # 跑得動還要確認不是靠 fallback metadata 硬撐——那代表伺服器並不真的認得它
    if grep -q "Model metadata for .* not found" "$out" 2>/dev/null; then
      echo "△ 可跑但走 fallback metadata（不建議採用）"
    else
      echo "✓ 可用"
      available+=("$m")
    fi
  else
    reason="$(grep -oE "The '[^']*' model is not supported" "$out" | head -1)"
    echo "✗ ${reason:-無回應／逾時}"
  fi
done

echo "------------------------------------------------------------"
if [ "${#available[@]}" -eq 0 ]; then
  echo "沒有任何候選可用——請確認登入狀態（codex login）與帳戶方案。"
  exit 1
fi

best="${available[0]}"
echo "可用：${available[*]}"
echo "最佳：${best}"

for m in "${available[@]}"; do
  if [ "$m" = "$current" ]; then
    if [ "$m" != "$best" ]; then
      echo "結論：目前設定的 ${current} 可用，但 ${best} 更強，可考慮改用。"
    else
      echo "結論：目前設定的 ${current} 可用且是最佳選項，不需更動。"
    fi
    exit 0
  fi
done

echo
echo "結論：目前設定的 ${current:-（未設定）} 不在可用清單內。"
echo "請把 ${CONFIG} 的 model 改為：${best}"
exit 1
