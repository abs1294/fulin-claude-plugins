#!/usr/bin/env bash
# review-record 的專案 QA 閘（.claude/qa-gate.conf）實跑測試。用法：bash test_qa_gate.sh <flow.sh 路徑>
set -u
FLOW="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
ROOT="$(mktemp -d)"
export CLAUDE_PROJECT_DIR="$ROOT/ws"
mkdir -p "$CLAUDE_PROJECT_DIR/.claude"
pass=0; fail=0; failed=()

ok()   { pass=$((pass+1)); echo "PASS  $1"; }
bad()  { fail=$((fail+1)); failed+=("$1"); echo "FAIL  $1"; [ -n "${2:-}" ] && echo "      $2"; }
# expect <名稱> <期望 exit> <指令...>
expect() {
  local name="$1" want="$2"; shift 2
  local out rc
  out="$("$@" 2>&1)"; rc=$?
  if [ "$rc" -eq "$want" ]; then ok "$name (exit $rc)"; else bad "$name" "期望 exit $want，實際 $rc：$(printf '%s' "$out" | tail -3 | tr '\n' '|')"; fi
  LAST_OUT="$out"
}
# has <名稱> <固定字串>：上一個 expect 的輸出含該字串
has()    { printf '%s' "$LAST_OUT" | grep -qF -- "$2" && ok "$1" || bad "$1" "輸出沒有「$2」：$(printf '%s' "$LAST_OUT" | head -20 | tr '\n' '|')"; }
hasnt()  { printf '%s' "$LAST_OUT" | grep -qF -- "$2" && bad "$1" "輸出不該有「$2」" || ok "$1"; }
flow() { bash "$FLOW" "$@"; }
rec_of() { echo "$CLAUDE_PROJECT_DIR/.claude/.git-commit-tmp/review-${1//\//__}.rec"; }
LOG="$CLAUDE_PROJECT_DIR/.claude/.git-commit-tmp/review-log.tsv"
CONF="$CLAUDE_PROJECT_DIR/.claude/qa-gate.conf"
OVR="$CLAUDE_PROJECT_DIR/.claude/local-overrides.yml"
log_rows() { [ -f "$LOG" ] && wc -l < "$LOG" | tr -d ' ' || echo 0; }

new_repo() {
  local r="$CLAUDE_PROJECT_DIR/$1"
  mkdir -p "$r"; git -C "$r" init -q -b main
  git -C "$r" config user.email t@example.com; git -C "$r" config user.name tester
  git -C "$r" config core.autocrlf false
  echo base > "$r/base.txt"; git -C "$r" add base.txt
  GIT_COMMIT_FLOW=1 git -C "$r" commit -q -m "Chore: init"
}
# stage <repo> <檔案...>：寫入內容後走 prepare（每次內容不同，hash 會變）
stage() {
  local repo="$1"; shift
  local f
  for f in "$@"; do
    mkdir -p "$(dirname "$CLAUDE_PROJECT_DIR/$repo/$f")"
    echo "x $RANDOM $f" >> "$CLAUDE_PROJECT_DIR/$repo/$f"
  done
  flow prepare "$repo" "$@" >/dev/null 2>&1 || bad "stage $repo $*（prepare 失敗）"
  rm -f "$(rec_of "$repo")"
}
# 清掉 staged 並還原工作區，讓下一個情境從乾淨狀態開始
reset_repo() {
  local r="$CLAUDE_PROJECT_DIR/$1"
  git -C "$r" reset -q --hard HEAD; git -C "$r" clean -qfd
}

PASS_REPLY=$'VERDICT: PASS\n- src/a.js:1 觀察點'
BLOCK_REPLY=$'VERDICT: BLOCK\n- src/a.js:1 必錯邏輯'
rr() { local repo="$1"; shift; flow review-record "$repo" --codex "$PASS_REPLY" --reviewer "$PASS_REPLY" "$@"; }

STD_CONF='# QA 閘設定
behavior_ext=  .js .TS .vue .py      # 行尾註解：比對檔名結尾、大小寫不分
exclude=^tests?/ (^|/)__tests__/ \.(test|spec)\.[a-z]+$   # 測試檔不算行為類
block_staged_overrides=0             # 先不檢查覆寫檔
'

new_repo r1

# ---------- 沒有設定檔：行為不變 ----------
rm -f "$CONF"
stage r1 src/a.js
expect "Q01 無 qa-gate.conf，不帶 --qa 照常記錄" 0 rr r1
[ -f "$(rec_of r1)" ] && ok "Q01b 紀錄已寫入" || bad "Q01b 紀錄已寫入"

# ---------- 有設定檔＋staged 有行為類檔 ----------
printf '%s' "$STD_CONF" > "$CONF"
stage r1 src/a.js
rows_before="$(log_rows)"
expect "Q02 staged 有 .js 不帶 --qa 被擋" 1 rr r1
[ ! -f "$(rec_of r1)" ] && ok "Q02b 被擋時沒寫紀錄" || bad "Q02b 被擋時沒寫紀錄"
[ "$(log_rows)" = "$rows_before" ] && ok "Q02c 被擋時流水帳沒多一行" || bad "Q02c 被擋時流水帳沒多一行"
has "Q02d 列出行為類檔" "- src/a.js"
has "Q02e 說明要求來自 qa-gate.conf" ".claude/qa-gate.conf"
has "Q02f 選項 a 已 QA" '--qa "已QA：<報告或測試檔路徑＋綠的輸出行>"'
has "Q02g 選項 b 分流例外" '--qa "分流例外：<為何讀 code 就能確定'
has "Q02h 選項 c 尚未 QA 不得記錄" "尚未 QA：不得記錄"
has "Q02i 印出收到的 --qa（未帶）" "收到的 --qa：（未帶）"

expect "Q03 --qa \"已QA：…\" 可記錄" 0 rr r1 --qa "已QA：tests/e2e/a.spec.js 3 passed"
grep -q "^qa=已QA：tests/e2e/a.spec.js 3 passed$" "$(rec_of r1)" && ok "Q03b QA 表態寫進紀錄" || bad "Q03b QA 表態寫進紀錄" "$(grep '^qa=' "$(rec_of r1)")"
rm -f "$(rec_of r1)"
expect "Q04 --qa \"已 qa：…\"（空白＋小寫）可記錄" 0 rr r1 --qa "已 qa：報告 docs/qa.md 全綠"
rm -f "$(rec_of r1)"
expect "Q04b 前導空白＋換行後的值也可記錄" 0 rr r1 --qa $'  \n 已Qa：tests/x.py 1 passed'
rm -f "$(rec_of r1)"
expect "Q04c --qa \"分流例外：…\" 可記錄" 0 rr r1 --qa "分流例外：只改常數名稱，讀 code 即可確定"
rm -f "$(rec_of r1)"
expect "Q05 --qa \"還沒測\" 被擋" 1 rr r1 --qa "還沒測"
[ ! -f "$(rec_of r1)" ] && ok "Q05b 被擋時沒寫紀錄" || bad "Q05b 被擋時沒寫紀錄"
has "Q05c 印出收到的 --qa 值" "收到的 --qa：還沒測"
expect "Q05d --qa \"QA 已完成\"（不是以已QA開頭）被擋" 1 rr r1 --qa "QA 已完成"
expect "Q05e --qa \"已經測過\"（已後面不是 QA）被擋" 1 rr r1 --qa "已經測過"
expect "Q05f --qa \"分流\"（不完整）被擋" 1 rr r1 --qa "分流"

# ---------- --exempt 模式同樣要求 ----------
expect "Q06 --exempt 不帶 --qa 被擋" 1 flow review-record r1 --exempt "使用者明示 POC"
[ ! -f "$(rec_of r1)" ] && ok "Q06b 被擋時沒寫紀錄" || bad "Q06b 被擋時沒寫紀錄"
expect "Q06c --exempt 帶 --qa \"已QA：…\" 可記錄" 0 flow review-record r1 --exempt "使用者明示 POC" --qa "已QA：手動實測截圖 docs/shot.png"
expect "Q06d 帶 QA 的紀錄 ship 放行" 0 flow ship r1 Feat "新增功能"

# ---------- 不算行為類的檔 ----------
stage r1 tests/unit/a.js test/b.js src/__tests__/c.js src/d.test.js src/e.spec.ts README.md package.json
expect "Q07 只有 exclude 命中的測試檔、.md、.json 不要求 --qa" 0 rr r1
reset_repo r1
stage r1 docs/guide.md
expect "Q07b 只有 .md 不要求 --qa" 0 rr r1
reset_repo r1
stage r1 docs/guide.md src/B.ts
expect "Q08 副檔名大小寫不同（B.ts 對 .TS）也算行為類" 1 rr r1
has "Q08b 列出 src/B.ts" "- src/B.ts"
hasnt "Q08c 不列 .md" "docs/guide.md"
reset_repo r1
stage r1 src/a.JS
expect "Q08d 檔名大寫副檔名（a.JS 對 .js）也算行為類" 1 rr r1
reset_repo r1
# 檔名特殊：用 -z 讀原始檔名，不靠 git 加引號後的輸出
stage r1 "src/有 空白 的檔.js"
expect "Q08e 檔名含空白與非 ASCII 仍算行為類" 1 rr r1
has "Q08f 列出原始檔名（不加引號）" "- src/有 空白 的檔.js"
reset_repo r1
# 檔名含 Tab、換行、雙引號時 git 不加 -z 會把檔名加引號輸出；這幾個字元在 Windows 檔案系統建不出來，未在本測試涵蓋

# ---------- 超過 20 個只列 20 個＋總數 ----------
many=(); for i in $(seq 1 25); do many+=("src/m$i.js"); done
stage r1 "${many[@]}"
expect "Q09 25 個行為類檔被擋" 1 rr r1
has "Q09b 印出總數" "共 25 個"
has "Q09c 印出未列出的數量" "另 5 個未列出"
[ "$(printf '%s\n' "$LAST_OUT" | grep -c '^         - src/m')" = 20 ] && ok "Q09d 只列 20 個" || bad "Q09d 只列 20 個" "$(printf '%s\n' "$LAST_OUT" | grep -c '^         - src/m')"
reset_repo r1

# ---------- 多 repo：只看指定的那個 repo ----------
new_repo ra; new_repo grp/rb
stage ra notes.md
stage grp/rb src/x.vue
expect "Q10 ra 只有 .md：不受 grp/rb 的 .vue 影響" 0 rr ra
expect "Q10b grp/rb 有 .vue：被擋" 1 rr grp/rb
has "Q10c 列的是 grp/rb 的檔" "- src/x.vue"
hasnt "Q10d 不列 ra 的檔" "notes.md"
expect "Q10e grp/rb 帶 --qa 可記錄" 0 rr grp/rb --qa "已QA：e2e 2 passed"

# ---------- 設定檔的註解、空白、CRLF ----------
printf 'behavior_ext=.py   # .md 寫在註解裡不算\n' > "$CONF"
stage r1 docs/a.md
expect "Q11 行尾註解裡的 .md 不算副檔名" 0 rr r1
reset_repo r1
stage r1 app/main.py
expect "Q11b 註解前的 .py 仍生效" 1 rr r1
reset_repo r1
printf '# 整行註解\r\n   behavior_ext   =   .py\t\r\n\r\nexclude =  ^app/gen/  \r\n' > "$CONF"
stage r1 app/main.py
expect "Q11c CRLF＋key/值前後空白的設定檔仍生效" 1 rr r1
reset_repo r1
stage r1 app/gen/auto.py
expect "Q11d CRLF 設定檔的 exclude 仍生效" 0 rr r1
reset_repo r1
printf 'behavior_ext=\nblock_staged_overrides=0\n' > "$CONF"
stage r1 src/a.js
expect "Q11e behavior_ext 為空＝不做 QA 檢查" 0 rr r1
reset_repo r1
printf 'behavior_ext=.js\nexclude=(unclosed\n' > "$CONF"
stage r1 src/a.js
expect "Q11f exclude 正規表示式無效時拒收並說明" 1 rr r1 --qa "已QA：x"
has "Q11g 錯誤訊息指出無效的規則" "(unclosed"
reset_repo r1
printf 'behavior_ext=.js\nbehaviour=.ts\n' > "$CONF"
stage r1 src/a.js
expect "Q11h 不認得的 key 只警告不擋（有 --qa）" 0 rr r1 --qa "已QA：x"
has "Q11i 警告不認得的 key" "behaviour"
reset_repo r1

# ---------- block_staged_overrides ----------
cat > "$OVR" <<'EOF'
r1:
  repo: r1
  files:
    - path: config/local.json
      reason: 本機連線設定
EOF
printf 'block_staged_overrides=1   # 擋覆寫檔\n' > "$CONF"
stage r1 config/local.json notes.md
rows_before="$(log_rows)"
expect "Q12 staged 含覆寫清單上的檔被擋" 1 rr r1
[ ! -f "$(rec_of r1)" ] && ok "Q12b 被擋時沒寫紀錄" || bad "Q12b 被擋時沒寫紀錄"
[ "$(log_rows)" = "$rows_before" ] && ok "Q12c 被擋時流水帳沒多一行" || bad "Q12c 被擋時流水帳沒多一行"
has "Q12d 列出覆寫檔" "- config/local.json"
hasnt "Q12e 不列非覆寫檔" "notes.md"
has "Q12f 提示 git restore --staged" "git restore --staged"
has "Q12g 提示 --allow-overrides" '--allow-overrides "<理由>"'
has "Q12h 說明來自 block_staged_overrides" "block_staged_overrides=1"
expect "Q13 --allow-overrides 空理由不收" 1 rr r1 --allow-overrides "   "
expect "Q13b --allow-overrides 有理由可記錄" 0 rr r1 --allow-overrides "檔內混有真改動，已用 git apply --cached 只 stage 那幾行"
[ "$(tail -n 1 "$LOG" | awk -F'\t' '{print $NF}')" = "檔內混有真改動，已用 git apply --cached 只 stage 那幾行" ] && ok "Q13c 理由寫在流水帳最後一欄" || bad "Q13c 理由寫在流水帳最後一欄" "$(tail -n 1 "$LOG")"
[ "$(head -n 1 "$LOG" | awk -F'\t' '{print $NF}')" = "allow_overrides" ] && ok "Q13d 流水帳表頭最後一欄是 allow_overrides" || bad "Q13d 流水帳表頭最後一欄是 allow_overrides" "$(head -n 1 "$LOG")"
[ "$(head -n 1 "$LOG" | cut -f1-8)" = "$(printf 'recorded_at\trepo\tdiff_hash\tmode\tcodex\treviewer\texempt_reason\tqa')" ] && ok "Q13e 既有欄位順序不變" || bad "Q13e 既有欄位順序不變" "$(head -n 1 "$LOG")"
grep -q "^allow_overrides=檔內混有真改動" "$(rec_of r1)" && ok "Q13f 理由寫進紀錄檔" || bad "Q13f 理由寫進紀錄檔"
expect "Q13g 帶 --allow-overrides 的紀錄 ship 放行" 0 flow ship r1 Chore "調整本機設定範本"
printf 'block_staged_overrides=0\n' > "$CONF"
stage r1 config/local.json
expect "Q14 block_staged_overrides=0 不檢查覆寫檔" 0 rr r1
reset_repo r1
rm -f "$CONF"
stage r1 config/local.json
expect "Q14b 無設定檔不檢查覆寫檔" 0 rr r1
reset_repo r1
printf 'block_staged_overrides=yes\n' > "$CONF"
stage r1 config/local.json
expect "Q14c block_staged_overrides 不是 0/1 時當成 0" 0 rr r1
has "Q14d 並警告值無效" "只收 0 或 1"
reset_repo r1
# 兩種問題同時存在：一次列完
printf 'behavior_ext=.js\nblock_staged_overrides=1\n' > "$CONF"
stage r1 config/local.json src/a.js
expect "Q15 覆寫檔＋行為類檔同時存在被擋" 1 rr r1
has "Q15b 列出行為類檔" "- src/a.js"
has "Q15c 列出覆寫檔" "- config/local.json"
expect "Q15d 只給 --qa 仍因覆寫檔被擋" 1 rr r1 --qa "已QA：x"
has "Q15d2 擋下原因是覆寫檔" "- config/local.json"
hasnt "Q15d3 不再要求 QA" "行為類檔："
expect "Q15e 只給 --allow-overrides 仍因缺 QA 被擋" 1 rr r1 --allow-overrides "理由"
has "Q15e2 擋下原因是缺 QA" "- src/a.js"
hasnt "Q15e3 不再擋覆寫檔" "local-overrides 清單上的檔"
expect "Q15f 兩個都給可記錄" 0 rr r1 --qa "已QA：x" --allow-overrides "理由"
reset_repo r1
# 覆寫檔放在子路徑 repo，以頂層 key 比對（與 analyze 同一套）
cat > "$OVR" <<'EOF'
grp/rb:
  files:
    - path: appsettings.Local.json
EOF
printf 'block_staged_overrides=1\n' > "$CONF"
reset_repo grp/rb
stage grp/rb appsettings.Local.json
expect "Q16 子路徑 repo 的覆寫檔也擋" 1 rr grp/rb
has "Q16a 擋下原因是覆寫檔" "- appsettings.Local.json"
reset_repo ra; stage ra appsettings.Local.json
expect "Q16b 別的 repo 同名檔不在它的清單裡不擋" 0 rr ra
reset_repo grp/rb; reset_repo ra
# cd 進巢狀 repo 再用 '.'、不設 CLAUDE_PROJECT_DIR：repo 參數只是 '.'，要靠「相對於設定檔所在目錄的路徑」認出 grp/rb 區塊
in_rb() { (cd "$CLAUDE_PROJECT_DIR/grp/rb" && env -u CLAUDE_PROJECT_DIR bash "$FLOW" "$@"); }
reset_repo grp/rb
echo "x $RANDOM" >> "$CLAUDE_PROJECT_DIR/grp/rb/appsettings.Local.json"
in_rb prepare . appsettings.Local.json >/dev/null 2>&1 && ok "Q16c 在巢狀 repo 裡 prepare 成功" || bad "Q16c 在巢狀 repo 裡 prepare 成功"
LAST_OUT="$(in_rb review-record . --codex "$PASS_REPLY" --reviewer "$PASS_REPLY" 2>&1)"; rc=$?
[ "$rc" -eq 1 ] && ok "Q16d cd 進巢狀 repo 用 '.'，路徑式 key 的覆寫檔照樣擋 (exit $rc)" || bad "Q16d cd 進巢狀 repo 用 '.'，路徑式 key 的覆寫檔照樣擋" "exit $rc：$(printf '%s' "$LAST_OUT" | head -5 | tr '\n' '|')"
has "Q16e 擋下原因是覆寫檔" "- appsettings.Local.json"
rm -rf "$CLAUDE_PROJECT_DIR/grp/rb/.claude"
reset_repo grp/rb

# 經 symlink（Windows 用目錄連接點）進入的巢狀 repo：實體 repo 在工作目錄外，工作目錄底下 grp/rl 只是連結
LNK_BASE="$(mktemp -d)"; LNK_REAL="$LNK_BASE/real-rl"
mkdir -p "$LNK_REAL"; git -C "$LNK_REAL" init -q -b main
git -C "$LNK_REAL" config user.email t@example.com; git -C "$LNK_REAL" config user.name tester; git -C "$LNK_REAL" config core.autocrlf false
echo base > "$LNK_REAL/base.txt"; git -C "$LNK_REAL" add base.txt; GIT_COMMIT_FLOW=1 git -C "$LNK_REAL" commit -q -m "Chore: init"
mkdir -p "$CLAUDE_PROJECT_DIR/grp"
made_link=0
# Windows（Git Bash）先建目錄連接點：沒權限建 symlink 時 ln -s 會默默改成複製整個目錄，測不到「經連結進入」
if command -v powershell >/dev/null 2>&1 && command -v cygpath >/dev/null 2>&1; then
  powershell -NoProfile -Command "New-Item -ItemType Junction -Path '$(cygpath -w "$CLAUDE_PROJECT_DIR/grp/rl")' -Target '$(cygpath -w "$LNK_REAL")' | Out-Null" 2>/dev/null
fi
[ -e "$CLAUDE_PROJECT_DIR/grp/rl" ] || ln -s "$LNK_REAL" "$CLAUDE_PROJECT_DIR/grp/rl" 2>/dev/null
# 字面路徑與實體路徑真的不同，才算建成連結
if [ -d "$CLAUDE_PROJECT_DIR/grp/rl/.git" ] \
  && [ "$(cd "$CLAUDE_PROJECT_DIR/grp/rl" && pwd -P)" != "$(cd "$CLAUDE_PROJECT_DIR/grp/rl" && pwd -L)" ]; then
  made_link=1
else
  rm -rf "$CLAUDE_PROJECT_DIR/grp/rl" 2>/dev/null
fi
if [ "$made_link" -eq 1 ]; then
  cat > "$OVR" <<'EOF'
grp/rl:
  files:
    - path: local.json
EOF
  printf 'block_staged_overrides=1\n' > "$CONF"
  in_rl() { (cd "$CLAUDE_PROJECT_DIR/grp/rl" && env -u CLAUDE_PROJECT_DIR bash "$FLOW" "$@"); }
  echo x > "$CLAUDE_PROJECT_DIR/grp/rl/local.json"
  in_rl prepare . local.json >/dev/null 2>&1 && ok "Q16j 經連結進入的 repo 裡 prepare 成功" || bad "Q16j 經連結進入的 repo 裡 prepare 成功"
  LAST_OUT="$(in_rl review-record . --codex "$PASS_REPLY" --reviewer "$PASS_REPLY" 2>&1)"; rc=$?
  [ "$rc" -eq 1 ] && ok "Q16k 經連結進入、實體在工作目錄外，路徑式 key 的覆寫檔照樣擋 (exit $rc)" || bad "Q16k 經連結進入、實體在工作目錄外，路徑式 key 的覆寫檔照樣擋" "exit $rc：$(printf '%s' "$LAST_OUT" | head -5 | tr '\n' '|')"
  has "Q16l 擋下原因是覆寫檔" "- local.json"
  if [ -L "$CLAUDE_PROJECT_DIR/grp/rl" ]; then rm -f "$CLAUDE_PROJECT_DIR/grp/rl"
  else powershell -NoProfile -Command "Remove-Item -LiteralPath '$(cygpath -w "$CLAUDE_PROJECT_DIR/grp/rl")' -Force" 2>/dev/null; fi
  rm -rf "$CLAUDE_PROJECT_DIR/grp/rl" 2>/dev/null
else
  echo "  SKIP Q16j–Q16l 這個環境建不出 symlink 或目錄連接點"
fi
rm -rf "$LNK_BASE"

# 巢狀 repo 的子目錄裡用 '.'、路徑大小寫不同、巢狀 repo 的 worktree 在工作目錄外——都要認得 grp/rb 區塊
cat > "$OVR" <<'EOF'
grp/rb:
  files:
    - path: appsettings.Local.json
EOF
printf 'block_staged_overrides=1\n' > "$CONF"
rb_try() {   # rb_try <標籤> <cd 到哪裡（相對工作目錄）>
  local label="$1" where="$2"
  reset_repo grp/rb
  echo "x $RANDOM" >> "$CLAUDE_PROJECT_DIR/grp/rb/appsettings.Local.json"
  mkdir -p "$CLAUDE_PROJECT_DIR/grp/rb/src"
  ( cd "$CLAUDE_PROJECT_DIR/$where" && env -u CLAUDE_PROJECT_DIR bash "$FLOW" prepare . "$(git rev-parse --show-cdup)appsettings.Local.json" >/dev/null 2>&1 ) \
    || bad "$label（prepare 失敗）"
  LAST_OUT="$(cd "$CLAUDE_PROJECT_DIR/$where" && env -u CLAUDE_PROJECT_DIR bash "$FLOW" review-record . --codex "$PASS_REPLY" --reviewer "$PASS_REPLY" 2>&1)"; local rc=$?
  [ "$rc" -eq 1 ] && printf '%s' "$LAST_OUT" | grep -qF -- "- appsettings.Local.json" && ok "$label (exit $rc)" \
    || bad "$label" "exit $rc：$(printf '%s' "$LAST_OUT" | head -4 | tr '\n' '|')"
  rm -rf "$CLAUDE_PROJECT_DIR/grp/rb/.claude"
}
rb_try "Q16m 在巢狀 repo 的子目錄（grp/rb/src）裡用 '.'，覆寫檔照樣擋" grp/rb/src
if [ -d "$CLAUDE_PROJECT_DIR/GRP/RB" ]; then
  rb_try "Q16n 路徑大小寫不同（cd GRP/RB），覆寫檔照樣擋" GRP/RB
else
  echo "  SKIP Q16n 這個檔案系統區分大小寫"
fi
reset_repo grp/rb
# 巢狀 repo 的 worktree 放在工作目錄外：清單的 grp/rb 區塊指的是主 repo，worktree 與它是同一個 repo
WT2="$(mktemp -d)/wt-rb"
git -C "$CLAUDE_PROJECT_DIR/grp/rb" worktree add -q -b wt-rb "$WT2" >/dev/null 2>&1 && ok "Q16o 建巢狀 repo 的 worktree" || bad "Q16o 建巢狀 repo 的 worktree"
echo "x $RANDOM" >> "$WT2/appsettings.Local.json"
( cd "$WT2" && env -u CLAUDE_PROJECT_DIR bash "$FLOW" prepare . appsettings.Local.json >/dev/null 2>&1 ) || bad "Q16p（prepare 失敗）"
LAST_OUT="$(cd "$WT2" && env -u CLAUDE_PROJECT_DIR bash "$FLOW" review-record . --codex "$PASS_REPLY" --reviewer "$PASS_REPLY" 2>&1)"; rc=$?
[ "$rc" -eq 1 ] && printf '%s' "$LAST_OUT" | grep -qF -- "- appsettings.Local.json" && ok "Q16p 巢狀 repo 的 worktree 在工作目錄外，覆寫檔照樣擋 (exit $rc)" \
  || bad "Q16p 巢狀 repo 的 worktree 在工作目錄外，覆寫檔照樣擋" "exit $rc：$(printf '%s' "$LAST_OUT" | head -4 | tr '\n' '|')"
git -C "$CLAUDE_PROJECT_DIR/grp/rb" worktree remove --force "$WT2" >/dev/null 2>&1
git -C "$CLAUDE_PROJECT_DIR/grp/rb" branch -q -D wt-rb >/dev/null 2>&1
rm -rf "$(dirname "$WT2")"

# ---- 覆寫比對的身分判定：各種清單寫法擋與不擋（Q17）----
# 每個情境自建暫存工作目錄；sc_try 只在目標 repo 確實位於暫存目錄底下時才 reset／clean
SC_BASE="$(mktemp -d)"
SC_W=""
sc_mk() {   # sc_mk <相對 SC_W 的 repo 路徑>
  local r="$SC_W/$1"; mkdir -p "$r"
  git -C "$r" init -q -b main; git -C "$r" config user.email t@example.com; git -C "$r" config user.name tester
  git -C "$r" config core.autocrlf false
  echo b > "$r/base.txt"; git -C "$r" add base.txt; GIT_COMMIT_FLOW=1 git -C "$r" commit -q -m "Chore: init"
}
sc_ws() {   # sc_ws <名稱>：開一個新的暫存工作目錄，寫好 qa-gate.conf
  SC_W="$SC_BASE/$1"; mkdir -p "$SC_W/.claude"
  printf 'block_staged_overrides=1\n' > "$SC_W/.claude/qa-gate.conf"
}
# sc_try <標籤> <預期 exit> <cd 到哪（相對 SC_W）> <repo 參數> <repo 根（相對 SC_W）> <檔（相對 repo 根）>
sc_try() {
  local label="$1" want="$2" where="$3" arg="$4" root="$5" file="$6" r out rc
  r="$SC_W/$root"
  case "$r" in "$SC_BASE"/*) ;; *) bad "$label（目標不在暫存目錄，拒跑）"; return ;; esac
  [ -d "$r/.git" ] || { bad "$label（$r 不是 repo，拒跑）"; return; }
  git -C "$r" reset -q --hard HEAD; git -C "$r" clean -qfd -e .claude
  mkdir -p "$(dirname "$r/$file")"; echo "x $RANDOM" >> "$r/$file"
  # 照真實流程跑 prepare：repo 參數是 '.' 時檔案路徑相對於 cd 的位置，否則相對於 repo 根
  local fp="$file"
  [ "$arg" = "." ] && fp="$(cd "$SC_W/$where" && git rev-parse --show-cdup)$file"
  (cd "$SC_W/$where" && env -u CLAUDE_PROJECT_DIR bash "$FLOW" prepare "$arg" "$fp" >/dev/null 2>&1) \
    || { bad "$label（prepare 失敗）"; git -C "$r" reset -q --hard HEAD; return; }
  out="$(cd "$SC_W/$where" && env -u CLAUDE_PROJECT_DIR bash "$FLOW" review-record "$arg" --codex "$PASS_REPLY" --reviewer "$PASS_REPLY" 2>&1)"; rc=$?
  if [ "$rc" = "$want" ]; then ok "$label (exit $rc)"
  else bad "$label" "預期 exit $want、實際 $rc：$(printf '%s' "$out" | grep -E 'ERROR|- ' | head -3 | tr '\n' '|')"; fi
  git -C "$r" reset -q --hard HEAD; rm -rf "$r/.claude/.git-commit-tmp" "$SC_W/.claude/.git-commit-tmp"
}

sc_ws a
sc_mk ra; sc_mk grp/rb; sc_mk named
git -C "$SC_W/named" remote add origin https://example.com/org/MyRealName.git
cat > "$SC_W/.claude/local-overrides.yml" <<'EOF'
MyRealName:
  files:
    - path: conf/remote.json
subblk:
  repo: grp/rb/src
  files:
    - path: sub.json
ghost:
  repo: does/not/exist
  files:
    - path: ghost.json
ra:
  files:
    - path: shared.json
EOF
sc_try "Q23a 清單用 remote 名稱當 key，從工作目錄用 named" 1 . named named conf/remote.json
sc_try "Q23b 清單用 remote 名稱當 key，cd named 用 ." 1 named . named conf/remote.json
sc_try "Q23c repo 值是子目錄（grp/rb/src），src/sub.json 擋" 1 grp/rb . grp/rb src/sub.json
sc_try "Q23d repo 值是子目錄，根目錄的 sub.json 不擋" 0 grp/rb . grp/rb sub.json
sc_try "Q23e 不同 repo、同路徑 shared.json 不擋" 0 grp/rb . grp/rb shared.json
sc_try "Q23f ra 自己的 shared.json 擋" 1 ra . ra shared.json
sc_try "Q23g 清單有不存在的目錄，不報錯也不誤擋" 0 ra . ra ghost.json
sc_try "Q23h 從工作目錄用 ra 名稱" 1 . ra ra shared.json

# 工作目錄本身是 git repo、清單有 `repo: .` 區塊：巢狀 repo 同路徑的檔不能被套到
sc_ws b
sc_mk .; sc_mk grp/rb
printf '.claude/\ngrp/\n' > "$SC_W/.gitignore"
cat > "$SC_W/.claude/local-overrides.yml" <<'EOF'
root:
  repo: .
  files:
    - path: config/local.json
EOF
sc_try "Q23i 根 repo 自己的 config/local.json 擋" 1 . . . config/local.json
sc_try "Q23j cd 巢狀 repo 用 .，同路徑 config/local.json 不擋" 0 grp/rb . grp/rb config/local.json
sc_try "Q23k 從工作目錄用 grp/rb，同路徑不擋" 0 . grp/rb grp/rb config/local.json

# 同名不同 repo：清單 key 是 rb，grp/rb 不能被套到
sc_ws c
sc_mk rb; sc_mk grp/rb
cat > "$SC_W/.claude/local-overrides.yml" <<'EOF'
rb:
  files:
    - path: x.json
EOF
sc_try "Q23l 頂層 rb 擋" 1 . rb rb x.json
sc_try "Q23m grp/rb（同名、不同 repo）不擋" 0 . grp/rb grp/rb x.json
sc_try "Q23n cd grp/rb 用 .（同名、不同 repo）不擋" 0 grp/rb . grp/rb x.json

# 設定檔在 repo 自己的 .claude 裡
sc_ws d
sc_mk proj
mkdir -p "$SC_W/proj/.claude"
printf 'block_staged_overrides=1\n' > "$SC_W/proj/.claude/qa-gate.conf"
rm -f "$SC_W/.claude/qa-gate.conf"
cat > "$SC_W/proj/.claude/local-overrides.yml" <<'EOF'
proj:
  repo: .
  files:
    - path: appsettings.Local.json
EOF
sc_try "Q23o repo 自帶設定，cd proj 用 . 擋" 1 proj . proj appsettings.Local.json
sc_try "Q23p repo 自帶設定，子目錄的同名檔不擋" 0 proj . proj web/appsettings.Local.json

# repo 值寫絕對路徑、key 只是別名
sc_ws e
sc_mk elsewhere/realrepo
cat > "$SC_W/.claude/local-overrides.yml" <<EOF
alias-name:
  repo: $SC_W/elsewhere/realrepo
  files:
    - path: abs.json
EOF
sc_try "Q23q repo 值是絕對路徑，cd 進該 repo 用 . 擋" 1 elsewhere/realrepo . elsewhere/realrepo abs.json
if command -v cygpath >/dev/null 2>&1; then
  cat > "$SC_W/.claude/local-overrides.yml" <<EOF
alias-name:
  repo: $(cygpath -m "$SC_W/elsewhere/realrepo")
  files:
    - path: abs.json
EOF
  sc_try "Q23r repo 值是 Windows 絕對路徑（C:/…），照樣擋" 1 elsewhere/realrepo . elsewhere/realrepo abs.json
fi
# 區塊 key 是 ra、repo 值明確指向 rb：只算 rb 的，ra 同路徑的檔不擋
sc_ws f
sc_mk ra; sc_mk rb
cat > "$SC_W/.claude/local-overrides.yml" <<'EOF'
ra:
  repo: rb
  files:
    - path: k.json
EOF
sc_try "Q23s repo 值指向 rb、key 是 ra：rb 的 k.json 擋" 1 rb . rb k.json
sc_try "Q23t repo 值指向 rb、key 是 ra：ra 的 k.json 不擋" 0 ra . ra k.json
# 清單 key 是 remote 名稱：上層 repo 裡碰巧有同名普通資料夾、或同名目錄是同一個 remote 的另一份 clone，都照樣擋
sc_ws g
sc_mk .; sc_mk grp/named
printf '.claude/\ngrp/\nother/\n' > "$SC_W/.gitignore"
mkdir -p "$SC_W/MyRealName"
git -C "$SC_W/grp/named" remote add origin https://example.com/org/MyRealName.git
cat > "$SC_W/.claude/local-overrides.yml" <<'EOF'
MyRealName:
  files:
    - path: conf/remote.json
EOF
sc_try "Q23u key 是 remote 名、上層 repo 有同名普通資料夾，照樣擋" 1 grp/named . grp/named conf/remote.json
sc_ws h
sc_mk MyRealName; sc_mk other/clone2
git -C "$SC_W/MyRealName" remote add origin https://example.com/org/MyRealName.git
git -C "$SC_W/other/clone2" remote add origin git@example.com:org/MyRealName.git
cat > "$SC_W/.claude/local-overrides.yml" <<'EOF'
MyRealName:
  files:
    - path: conf/remote.json
EOF
sc_try "Q23v 同一個 remote 的另一份 clone，照樣擋" 1 other/clone2 . other/clone2 conf/remote.json
sc_try "Q23w 同名目錄那份 clone 自己，照樣擋" 1 MyRealName . MyRealName conf/remote.json
# key 是 remote 名、repo 值指向同一個 repo 的子目錄：只擋子目錄下的檔，根目錄同名檔不擋
cat > "$SC_W/.claude/local-overrides.yml" <<'EOF'
MyRealName:
  repo: MyRealName/sub
  files:
    - path: config.json
EOF
# sub/ 要有已 commit 的檔，否則 sc_try 開頭的 git clean 會把空目錄清掉
mkdir -p "$SC_W/MyRealName/sub"; echo k > "$SC_W/MyRealName/sub/.keep"
git -C "$SC_W/MyRealName" add sub/.keep; GIT_COMMIT_FLOW=1 git -C "$SC_W/MyRealName" commit -q -m "Chore: sub"
sc_try "Q23x key 是 remote 名、repo 值是子目錄：sub/config.json 擋" 1 MyRealName . MyRealName sub/config.json
sc_try "Q23y key 是 remote 名、repo 值是子目錄：根目錄 config.json 不擋" 0 MyRealName . MyRealName config.json
rm -rf "$SC_BASE"

# worktree 放在工作目錄外：往上找不到設定檔，要靠主 repo 那邊找回來
printf 'behavior_ext=.js\n' > "$CONF"
WT_DIR="$(mktemp -d)/wt-r1"
git -C "$CLAUDE_PROJECT_DIR/r1" worktree add -q -b wt-qa "$WT_DIR" >/dev/null 2>&1 \
  && ok "Q16f 在工作目錄外建 worktree" || bad "Q16f 在工作目錄外建 worktree"
in_wt() { (cd "$WT_DIR" && env -u CLAUDE_PROJECT_DIR bash "$FLOW" "$@"); }
mkdir -p "$WT_DIR/src"; echo "x $RANDOM" > "$WT_DIR/src/wt.js"
in_wt prepare . src/wt.js >/dev/null 2>&1 && ok "Q16g 在 worktree 裡 prepare 成功" || bad "Q16g 在 worktree 裡 prepare 成功"
LAST_OUT="$(in_wt review-record . --codex "$PASS_REPLY" --reviewer "$PASS_REPLY" 2>&1)"; rc=$?
[ "$rc" -eq 1 ] && ok "Q16h 工作目錄外的 worktree 用 '.'，找回主 repo 那邊的設定檔照樣擋 (exit $rc)" || bad "Q16h 工作目錄外的 worktree 用 '.'，找回主 repo 那邊的設定檔照樣擋" "exit $rc：$(printf '%s' "$LAST_OUT" | head -5 | tr '\n' '|')"
has "Q16i 擋下原因是 QA 表態" "必須帶有效的 --qa 表態"
git -C "$CLAUDE_PROJECT_DIR/r1" worktree remove --force "$WT_DIR" >/dev/null 2>&1
git -C "$CLAUDE_PROJECT_DIR/r1" branch -q -D wt-qa >/dev/null 2>&1
rm -rf "$(dirname "$WT_DIR")"


# ---------- 閘過了仍走原本的檢查 ----------
printf 'behavior_ext=.js\n' > "$CONF"
stage r1 src/a.js
expect "Q17 QA 表態有效但 Codex BLOCK 仍不收" 1 flow review-record r1 --codex "$BLOCK_REPLY" --reviewer "$PASS_REPLY" --qa "已QA：x"
expect "Q17b QA 表態有效但只給一軌仍不收" 1 flow review-record r1 --codex "$PASS_REPLY" --qa "已QA：x"
echo more >> "$CLAUDE_PROJECT_DIR/r1/src/a.js"; git -C "$CLAUDE_PROJECT_DIR/r1" add src/a.js
expect "Q17c QA 表態有效但 prepare 後 staged 變動仍不收" 1 rr r1 --qa "已QA：x"
reset_repo r1

# ---------- 舊版流水帳（8 欄表頭）就地補上新欄 ----------
printf 'recorded_at\trepo\tdiff_hash\tmode\tcodex\treviewer\texempt_reason\tqa\n2026-01-01 00:00:00\told\tabc\treview\tPASS\tPASS\t-\t-\n' > "$LOG"
rm -f "$CONF"
stage r1 a.txt
expect "Q18 舊流水帳仍可記錄" 0 rr r1
[ "$(head -n 1 "$LOG" | awk -F'\t' '{print $NF}')" = "allow_overrides" ] && ok "Q18b 舊表頭補上 allow_overrides" || bad "Q18b 舊表頭補上 allow_overrides" "$(head -n 1 "$LOG")"
[ "$(sed -n 2p "$LOG")" = "$(printf '2026-01-01 00:00:00\told\tabc\treview\tPASS\tPASS\t-\t-')" ] && ok "Q18c 舊資料列原樣保留" || bad "Q18c 舊資料列原樣保留" "$(sed -n 2p "$LOG")"
[ "$(wc -l < "$LOG" | tr -d ' ')" = 3 ] && ok "Q18d 新增一列" || bad "Q18d 新增一列" "$(cat "$LOG")"
[ "$(tail -n 1 "$LOG" | awk -F'\t' '{print NF}')" = 9 ] && ok "Q18e 新列 9 欄（未帶旗標記 -）" || bad "Q18e 新列 9 欄（未帶旗標記 -）" "$(tail -n 1 "$LOG")"

# ---------- 設定檔位置：cd 進 repo 再用 '.'、沒設 CLAUDE_PROJECT_DIR 也找得到 ----------
# 照實際用法：prepare 與 review-record 都在 repo 裡跑、都不設 CLAUDE_PROJECT_DIR（WORKSPACE_DIR＝repo 本身），
# 設定檔只在上一層的 .claude/。只看 WORKSPACE_DIR 的版本會找不到設定檔而放行。
reset_repo r1
printf '%s' "$STD_CONF" > "$CONF"
in_repo() { (cd "$CLAUDE_PROJECT_DIR/r1" && env -u CLAUDE_PROJECT_DIR bash "$FLOW" "$@"); }
echo "x $RANDOM" >> "$CLAUDE_PROJECT_DIR/r1/src/cd.js" 2>/dev/null || { mkdir -p "$CLAUDE_PROJECT_DIR/r1/src"; echo "x $RANDOM" > "$CLAUDE_PROJECT_DIR/r1/src/cd.js"; }
in_repo prepare . src/cd.js >/dev/null 2>&1 && ok "Q20a 在 repo 裡 prepare 成功" || bad "Q20a 在 repo 裡 prepare 成功"
LAST_OUT="$(in_repo review-record . --codex "$PASS_REPLY" --reviewer "$PASS_REPLY" 2>&1)"; rc=$?
[ "$rc" -eq 1 ] && ok "Q20 cd 進 repo、沒設 CLAUDE_PROJECT_DIR，往上找到設定檔照樣擋 (exit $rc)" || bad "Q20 cd 進 repo、沒設 CLAUDE_PROJECT_DIR，往上找到設定檔照樣擋" "exit $rc：$(printf '%s' "$LAST_OUT" | head -5 | tr '\n' '|')"
has "Q20b 擋下的原因是 QA 表態" "必須帶有效的 --qa 表態"
LAST_OUT="$(in_repo review-record . --codex "$PASS_REPLY" --reviewer "$PASS_REPLY" --qa "已QA：tests/cd.test.js 1 passed" 2>&1)"; rc=$?
[ "$rc" -eq 0 ] && ok "Q20c 同樣位置帶 --qa 可記錄 (exit $rc)" || bad "Q20c 同樣位置帶 --qa 可記錄" "exit $rc：$(printf '%s' "$LAST_OUT" | head -5 | tr '\n' '|')"
rm -rf "$CLAUDE_PROJECT_DIR/r1/.claude"
reset_repo r1

# ---------- 設定檔開頭有 UTF-8 BOM ----------
printf '\xef\xbb\xbf%s' "behavior_ext=.js
" > "$CONF"
stage r1 src/bom.js
expect "Q21 設定檔開頭有 BOM、第一行就是 behavior_ext，照樣擋" 1 rr r1
hasnt "Q21b 不把第一行當成不認得的 key" "不認得"
reset_repo r1

# ---------- --qa 要有內容 ----------
printf '%s' "$STD_CONF" > "$CONF"
stage r1 src/empty.js
expect "Q22 --qa \"已QA\"（沒有內容）被擋" 1 rr r1 --qa "已QA"
expect "Q22b --qa \"已QA：\"（只有冒號）被擋" 1 rr r1 --qa "已QA："
expect "Q22c --qa \"已QAnope\"（沒有分隔符）被擋" 1 rr r1 --qa "已QAnope"
expect "Q22d --qa \"分流例外\"（沒有內容）被擋" 1 rr r1 --qa "分流例外"
expect "Q22e --qa \"分流例外：純文案\" 可記錄" 0 rr r1 --qa "分流例外：純文案，讀 code 即可確定"
reset_repo r1
stage r1 src/empty2.js
expect "Q22f --qa \"已 QA 手動實測\"（空白分隔）可記錄" 0 rr r1 --qa "已 QA 手動實測 docs/shot.png"
reset_repo r1

# ---------- help ----------
bash "$FLOW" --help | grep -q "qa-gate.conf" && ok "Q19 --help 提到 qa-gate.conf" || bad "Q19 --help 提到 qa-gate.conf"
bash "$FLOW" --help | grep -q -- "--allow-overrides" && ok "Q19b --help 提到 --allow-overrides" || bad "Q19b --help 提到 --allow-overrides"

rm -rf "$ROOT"
echo ""
echo "=== 結果：PASS $pass / FAIL $fail ==="
[ "$fail" -eq 0 ] || { printf '  - %s\n' "${failed[@]}"; exit 1; }
