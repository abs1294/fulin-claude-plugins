#!/usr/bin/env bash
# Codex 模型自動同步：挑出帳戶目前可用的最強模型，必要時寫回 config.toml。
#
# 解決什麼：Codex 的帳戶可用模型會隨方案／服務端調整而變動（實證 gpt-5.4 被下架），
# 變動後 B 軌審查整批失敗，且伺服器被拒時不列舉替代品、CLI 沒有查詢指令。
# 過去每次變動都要人工逐一猜 slug 試——猜名字還會猜錯
# （猜 gpt-5.6 / gpt-6 皆失敗，真名是 gpt-5.6-sol / gpt-6-astra）。
#
# 為什麼不乾脆不設 model 讓 CLI 自己挑：實測不設也能跑，且今天解析到 gpt-6-astra，
# 但那個 <default> 是 CLI/服務端的黑箱決定，models_cache.json 內沒有任何
# default 標記可供驗證，換機器或改版後不保證仍是最強的。明確寫死 + 定期同步
# 才能確保「用的是當下最強」，而不是「用的是某個能跑的」。
#
# 判準：models_cache.json 內 visibility=list 且 priority 最小者＝最強
#       （priority 1 = gpt-6-astra「Our most capable model」）。
#       選出後一律送真請求驗證，通過才採用。
#
# 用法（需在 git repo 內，codex 拒絕在非 git 目錄啟動）：
#   bash .claude/skills/git-commit/codex-model-sync.sh          # 檢查，需要時才改
#   bash .claude/skills/git-commit/codex-model-sync.sh --check  # 唯讀，不改檔（供 hook/CI）
#
# 離開碼：0＝已是最強（或已成功改成最強）；1＝需人工處理。

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


CHECK_ONLY=0
[ "${1:-}" = "--check" ] && CHECK_ONLY=1

CODEX_DIR="${CODEX_HOME:-$HOME/.codex}"
CONFIG="$CODEX_DIR/config.toml"
CACHE="$CODEX_DIR/models_cache.json"

# 迴圈內的暫存檔在被 kill／Ctrl+C 時也要清掉（check.sh 已有對應機制）
# 探測失敗的原始輸出保留於此供回溯；成功的不留（避免堆積）
FAIL_LOG_DIR="${TMPDIR:-/tmp}/codex-model-probe-fail"
PROBE_TMP=""
cleanup() { [ -n "${PROBE_TMP:-}" ] && rm -f "$PROBE_TMP"; }
# 收到訊號時：清完立刻退出。若只清檔不退出，控制流會帶著「檔案已消失」的狀態
# 繼續跑到 grep，把探測中的模型誤判成不可用，進而把次強模型寫進 config。
# 依慣例回 128+訊號值（INT=130、TERM=143、HUP=129），呼叫端才分得出中止原因。
on_signal() {
  cleanup
  # 不斷言「未變更」——寫入是 python 子行程做的，bash 要等它整體結束才處理訊號，
  # 所以存在「os.replace 已完成、訊號才被處理」的窄窗口。實測坐實：該窗口內
  # 中止會印「未變更」但 config 其實已是新值。訊息與事實相反比沒訊息更糟，
  # 故改為誠實描述不確定性並指出備份位置。
  echo "已中止（收到 SIG$1）。config 可能已變更也可能未變更，請自行核對；" >&2
  echo "  若需還原，備份在 ${CONFIG}.bak.*（最近一次：${backup_path:-尚未建立}）" >&2
  case "$1" in
    INT) exit 130 ;;
    TERM) exit 143 ;;
    HUP) exit 129 ;;
    *) exit 130 ;;
  esac
}
trap cleanup EXIT
trap 'on_signal INT' INT
trap 'on_signal TERM' TERM
trap 'on_signal HUP' HUP

if ! command -v codex >/dev/null 2>&1; then
  echo "codex CLI 不在 PATH" >&2
  exit 1
fi
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "請在 git repo 內執行（codex 拒絕在非 git 目錄啟動）" >&2
  exit 1
fi

# cache 由 CLI 自己維護（含 fetched_at / etag），刪掉後下次真正發請求時會重建。
# 註：codex --version 不會刷新 cache（實測 fetched_at 不變），故不在此預熱；
# 下方每個候選都會送真請求，cache 陳舊時仍以「實測結果」為準。

if [ ! -f "$CACHE" ]; then
  echo "找不到 $CACHE —— 先跑一次 codex 讓它產生，或確認已登入（codex login）" >&2
  exit 1
fi

# Windows 版 python 讀不懂 Git Bash 的 /c/... 路徑。不靠猜環境（有無 cygpath
# 不足以判斷 python 是哪一種，WSL 混用時會誤判），改成直接問 python 讀不讀得到，
# 讀不到才嘗試轉換，兩種都不行就讓後續的檔案檢查報錯。
cache_path="$CACHE"
if ! "$PY" -c "import io,sys; io.open(sys.argv[1], encoding='utf-8').read(1)" "$cache_path" >/dev/null 2>&1; then
  if command -v cygpath >/dev/null 2>&1; then
    cache_path="$(cygpath -m "$CACHE" 2>/dev/null || echo "$CACHE")"
  fi
fi

ranked="$("$PY" -c "
import json, io, sys
try:
    d = json.load(io.open(sys.argv[1], encoding='utf-8'))
except Exception as e:
    print('CACHE_UNREADABLE', e, file=sys.stderr); sys.exit(1)
ms = [m for m in d.get('models', []) if m.get('visibility') == 'list' and m.get('slug')]
if not ms:
    sys.exit(1)
ms.sort(key=lambda m: m.get('priority', 9999))
for m in ms:
    sys.stdout.write(m['slug'] + '\n')
" "$cache_path" 2>/dev/null | tr -d '\r')"

if [ -z "${ranked:-}" ]; then
  echo "無法從 cache 解析可用模型，請改跑 codex-model-check.sh 逐一實測" >&2
  exit 1
fi
# 候選白名單：在進入探測迴圈之前就逐一過濾，只放行英數與 . _ -。
# 位置很重要——只驗最終選出的 best 不夠：迴圈裡每個候選都會被拿去
# 組 log 檔路徑（`$FAIL_LOG_DIR/$m.log`），未驗證的候選帶 ../ 就能寫到
# 目錄外、甚至覆寫既有檔案（已實測坐實）。
# 關掉 glob 再切詞：`for m in $ranked` 本身就會被萬用字元展開
# （實測 `glob_test_*` 在有符合檔名的目錄下會變成多個候選），
# 過濾器不能用它自己要防的寫法。
set -f
safe_ranked=""
for m in $ranked; do
  case "$m" in
    *[!A-Za-z0-9._-]*|"") echo "  略過含非預期字元的候選：$m" >&2 ;;
    *) safe_ranked="${safe_ranked}${safe_ranked:+ }$m" ;;
  esac
done
if [ -z "$safe_ranked" ]; then
  set +f
  echo "cache 內所有候選都含非預期字元，拒絕繼續——請確認 $CACHE 是否被竄改" >&2
  exit 1
fi
ranked="$safe_ranked"
set +f


current=""
if [ -f "$CONFIG" ]; then
  current="$(grep -m1 -E '^[[:space:]]*model[[:space:]]*=' "$CONFIG" \
    | sed -E 's/.*=[[:space:]]*"?([^"#]+)"?.*/\1/' | tr -d '[:space:]')"
fi

rm -rf "$FAIL_LOG_DIR" 2>/dev/null   # 清上一輪紀錄，避免陳舊資訊誤導診斷

echo "codex-cli : $(codex --version 2>&1 | head -1)"
echo "cache     : $("$PY" -c "
import json, io, sys
d = json.load(io.open(sys.argv[1], encoding='utf-8'))
print(d.get('fetched_at', '?'))
" "$cache_path" 2>/dev/null)"
echo "目前設定  : ${current:-（未設定，將落到 CLI 黑箱預設）}"
echo "排名（priority 由小到大）:"
echo "$ranked" | sed 's/^/  /'
echo "------------------------------------------------------------"

# 由最強往下找第一個「真的送得出請求」的
# set -f：過濾後的 ranked 已不含萬用字元，這裡再關一次是不依賴上游的縱深防護
set -f
best=""
for m in $ranked; do
  [ -n "$m" ] || continue
  printf '  驗證 %-16s ' "$m"
  out="$(mktemp)"
  PROBE_TMP="$out"
  run_probe 110 codex exec --model "$m" --json "回 PING_OK" < /dev/null > "$out" 2>&1
  if grep -q "PING_OK" "$out" 2>/dev/null && ! grep -q "Model metadata for .* not found" "$out" 2>/dev/null; then
    echo "✓"
    best="$m"
    rm -f "$out"
    break
  fi
  echo "✗"
  # 失敗原文留存——只看 ✗ 無法診斷真因（實證：slug 帶 \r 時每個都 ✗，看不出原因）
  if mkdir -p "$FAIL_LOG_DIR" 2>/dev/null && cp "$out" "$FAIL_LOG_DIR/$m.log" 2>/dev/null; then
    echo "      （原文：$FAIL_LOG_DIR/$m.log）"
  fi
  rm -f "$out"
done
set +f

if [ -z "$best" ]; then
  echo "清單內沒有任何模型可用——請確認登入狀態與帳戶方案" >&2
  exit 1
fi

# 第二道白名單（第一道在探測迴圈之前）：寫入 config 是最後也最不可逆的一步，
# 縱深防護一次。含引號或換行的 slug 會寫出無法解析的 config.toml，
# 而 config 一旦壞掉，codex 整個起不來、也就修不回去了。
case "$best" in
  *[!A-Za-z0-9._-]*|"")
    echo "模型代號含非預期字元，拒絕寫入 config：$best" >&2
    echo "（只接受英數與 . _ -；請確認 $CACHE 是否被竄改）" >&2
    exit 1 ;;
esac

echo "------------------------------------------------------------"
echo "當下最強可用：$best"

if [ "$best" = "$current" ]; then
  echo "結論：config 已是最強，不需更動。"
  exit 0
fi

if [ "$CHECK_ONLY" -eq 1 ]; then
  echo "結論：config 目前是 ${current:-（未設定）}，落後於 ${best}。"
  echo "（--check 模式不改檔；要套用請不帶參數重跑）"
  exit 1
fi

config_path="$CONFIG"
if ! "$PY" -c "import io,sys; io.open(sys.argv[1], encoding='utf-8').read(1)" "$config_path" >/dev/null 2>&1; then
  if command -v cygpath >/dev/null 2>&1; then
    config_path="$(cygpath -m "$CONFIG" 2>/dev/null || echo "$CONFIG")"
  fi
fi

# 備份失敗就不准往下走——沒有備份的覆寫等於不可還原
backup_path="${CONFIG}.bak.$(date +%Y%m%d%H%M%S)"
if ! cp "$CONFIG" "$backup_path"; then
  echo "備份 config 失敗（無法寫入 $backup_path），設定未變更——請檢查磁碟空間或目錄權限" >&2
  exit 1
fi
if [ ! -s "$backup_path" ]; then
  echo "備份檔為空（$backup_path），設定未變更——原檔可能讀取失敗" >&2
  rm -f "$backup_path"
  exit 1
fi
# 備份只留最近 5 份，避免無限累積
ls -1t "${CONFIG}".bak.* 2>/dev/null | tail -n +6 | while IFS= read -r old; do
  rm -f "$old"
done
"$PY" -c "
import io, os, re, sys
p = sys.argv[1]
lines = io.open(p, encoding='utf-8').read().split('\n')
new_line = 'model = \"%s\"' % sys.argv[2]

# 逐行掃描並追蹤 table 邊界：只有頂層（尚未進入任何 [table]）的 model 行
# 才是要改的那一行。純 regex 的 count=1 會誤改 [profiles.x] 子表裡的 model；
# 用 s.find('[') 找插入點則會被陣列值（x = [1,2]）或含 [ 的字串騙走。
table_re = re.compile(r'^[ \t]*\[')
model_re = re.compile(r'^[ \t]*model[ \t]*=')
first_table = None
replaced = False
for i, ln in enumerate(lines):
    if table_re.match(ln):
        if first_table is None:
            first_table = i
        continue
    if first_table is None and model_re.match(ln):
        lines[i] = new_line
        replaced = True
        break

if not replaced:
    # 頂層沒有 model：插在第一個 table 之前（TOML 規定頂層鍵必須先於所有 table）
    if first_table is None:
        while lines and not lines[-1].strip():
            lines.pop()
        lines.append(new_line)
    else:
        lines.insert(first_table, new_line)
        lines.insert(first_table + 1, '')

# 原子寫入：先寫暫存檔再 os.replace（同分割區的 rename 是原子操作）。
# 直接對原檔開 'w' 會先截斷再寫，中途遇 SIGKILL 或斷電會留下半份損毀的 config；
# trap 攔不到 SIGKILL，所以「失敗則設定未變更」只有靠原子寫入才成立。
tmp = p + '.tmp'
with io.open(tmp, 'w', encoding='utf-8', newline='') as f:
    f.write('\n'.join(lines))
    f.flush()
    os.fsync(f.fileno())
os.replace(tmp, p)
" "$config_path" "$best"
write_rc=$?
if [ "$write_rc" -ne 0 ]; then
  echo "寫入 config 失敗（python 回 $write_rc），設定未變更——請檢查檔案權限或是否被鎖定" >&2
  exit 1
fi

# 寫完回讀驗證，不靠「沒報錯」推論成功
verify="$(grep -m1 -E '^[[:space:]]*model[[:space:]]*=' "$CONFIG" \
  | sed -E 's/.*=[[:space:]]*"?([^"#]+)"?.*/\1/' | tr -d '[:space:]')"
if [ "$verify" != "$best" ]; then
  echo "寫入後回讀不符：期望 $best，實際 ${verify:-（空）}——設定可能未生效" >&2
  exit 1
fi

echo "結論：config 已更新為 ${best}（回讀驗證通過；原檔備份於 ${CONFIG}.bak.*）"
exit 0
