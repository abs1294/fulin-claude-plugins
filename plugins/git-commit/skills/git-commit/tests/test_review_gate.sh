#!/usr/bin/env bash
# 審查紀錄閘（真閘 7）的實跑測試。用法：bash test_review_gate.sh <flow.sh 路徑>
set -u
FLOW="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
ROOT="$(mktemp -d)"
export CLAUDE_PROJECT_DIR="$ROOT/ws"
mkdir -p "$CLAUDE_PROJECT_DIR"
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
flow() { bash "$FLOW" "$@"; }
commits() { git -C "$CLAUDE_PROJECT_DIR/$1" rev-list --count HEAD; }
rec_of() { echo "$CLAUDE_PROJECT_DIR/.claude/.git-commit-tmp/review-${1//\//__}.rec"; }

new_repo() {
  local r="$CLAUDE_PROJECT_DIR/$1"
  mkdir -p "$r"; git -C "$r" init -q -b main
  git -C "$r" config user.email t@example.com; git -C "$r" config user.name tester
  git -C "$r" config core.autocrlf false
  echo base > "$r/base.txt"; git -C "$r" add base.txt
  GIT_COMMIT_FLOW=1 git -C "$r" commit -q -m "Chore: init"
}
edit() { echo "$3" >> "$CLAUDE_PROJECT_DIR/$1/$2"; }

PASS_REPLY=$'VERDICT: PASS\n- src/a.txt:1 觀察點'
BLOCK_REPLY=$'VERDICT: BLOCK\n- src/a.txt:1 必錯邏輯'

# ---------- ship ----------
new_repo r1
edit r1 a.txt one
flow prepare r1 a.txt >/dev/null
expect "T01 無紀錄 ship 被擋" 1 flow ship r1 Feat "新增一行"
[ "$(commits r1)" = 1 ] && ok "T01b 被擋時沒有產生 commit" || bad "T01b 被擋時沒有產生 commit"
printf '%s' "$LAST_OUT" | grep -q "review-record" && ok "T01c 錯誤訊息指出 review-record" || bad "T01c 錯誤訊息指出 review-record"

expect "T02 兩軌 PASS 可記錄" 0 flow review-record r1 --codex "$PASS_REPLY" --reviewer "$PASS_REPLY"
[ -f "$(rec_of r1)" ] && ok "T02b 紀錄檔已寫入" || bad "T02b 紀錄檔已寫入"
expect "T02c 有紀錄 ship 放行" 0 flow ship r1 Feat "新增一行"
[ "$(commits r1)" = 2 ] && ok "T02d commit 已建立" || bad "T02d commit 已建立"
[ ! -f "$(rec_of r1)" ] && ok "T02e commit 後紀錄已清" || bad "T02e commit 後紀錄已清"
LOG="$CLAUDE_PROJECT_DIR/.claude/.git-commit-tmp/review-log.tsv"
grep -q $'\tr1\t.*\treview\tPASS\tPASS\t' "$LOG" && ok "T02f 稽核流水帳有一行 review" || bad "T02f 稽核流水帳有一行 review" "$(cat "$LOG" 2>/dev/null)"

# 記錄後 staged 又變
edit r1 a.txt two
flow prepare r1 a.txt >/dev/null
flow review-record r1 --codex "$PASS_REPLY" --reviewer "$PASS_REPLY" >/dev/null 2>&1
edit r1 b.txt extra; git -C "$CLAUDE_PROJECT_DIR/r1" add b.txt
expect "T03 記錄後 staged 變動 ship 被擋" 1 flow ship r1 Feat "再加一行"
git -C "$CLAUDE_PROJECT_DIR/r1" reset -q HEAD b.txt; rm -f "$CLAUDE_PROJECT_DIR/r1/b.txt"

# prepare 重跑會作廢舊紀錄
flow prepare r1 a.txt >/dev/null
[ ! -f "$(rec_of r1)" ] && ok "T04 重跑 prepare 作廢舊紀錄" || bad "T04 重跑 prepare 作廢舊紀錄"
expect "T04b 作廢後 ship 被擋" 1 flow ship r1 Feat "再加一行"

# ---------- review-record 的輸入檢查 ----------
expect "T05 BLOCK 不收" 1 flow review-record r1 --codex "$BLOCK_REPLY" --reviewer "$PASS_REPLY"
[ ! -f "$(rec_of r1)" ] && ok "T05b BLOCK 不寫紀錄" || bad "T05b BLOCK 不寫紀錄"
expect "T06 兩軌都 skipped 不收" 1 flow review-record r1 --codex "skipped: 沙箱擋" --reviewer "skipped: agent 不存在"
expect "T07 一軌 skipped 一軌 PASS 可收" 0 flow review-record r1 --codex "skipped: codex 400 model not supported" --reviewer "$PASS_REPLY"
expect "T08 亂寫的結論不收" 1 flow review-record r1 --codex "看起來沒問題" --reviewer "$PASS_REPLY"
expect "T09 skipped 沒寫原因不收" 1 flow review-record r1 --codex "skipped:" --reviewer "$PASS_REPLY"
expect "T10 只給一軌不收" 1 flow review-record r1 --codex "$PASS_REPLY"
expect "T11 exempt 空理由不收" 1 flow review-record r1 --exempt "   "
expect "T12 exempt 與 codex 並用不收" 1 flow review-record r1 --exempt "POC" --codex "$PASS_REPLY"
expect "T13 小寫 verdict 不收" 1 flow review-record r1 --codex "verdict: pass" --reviewer "$PASS_REPLY"
expect "T14 PASSED 不算 PASS" 1 flow review-record r1 --codex "VERDICT: PASSED" --reviewer "$PASS_REPLY"
expect "T15 缺 repo 參數" 1 flow review-record --codex "$PASS_REPLY" --reviewer "$PASS_REPLY"

# 前導空行＋CRLF
CRLF_REPLY=$'\r\n\r\n   VERDICT: PASS   \r\n- a:1 x\r\n'
expect "T16 前導空行與 CRLF 可收" 0 flow review-record r1 --codex "$CRLF_REPLY" --reviewer "$PASS_REPLY"

# 超長回覆：驗 pipefail 下不會因 SIGPIPE 無聲中止
BIG="VERDICT: PASS"$'\n'"$(head -c 400000 /dev/zero | tr '\0' 'x' | fold -w 100)"
expect "T17 400KB 回覆可收" 0 flow review-record r1 --codex "$BIG" --reviewer "$PASS_REPLY"
grep -q "^--- codex ---" "$(rec_of r1)" && ok "T17b 大回覆原文寫進紀錄" || bad "T17b 大回覆原文寫進紀錄"
expect "T17c 以大回覆紀錄 ship 放行" 0 flow ship r1 Feat "再加一行"

# 未 prepare 就記錄
new_repo r2
edit r2 a.txt x; git -C "$CLAUDE_PROJECT_DIR/r2" add a.txt
expect "T18 沒跑 prepare 不能記錄" 1 flow review-record r2 --codex "$PASS_REPLY" --reviewer "$PASS_REPLY"
# prepare 之後 staged 又變才記錄
flow prepare r2 a.txt >/dev/null
edit r2 c.txt y; git -C "$CLAUDE_PROJECT_DIR/r2" add c.txt
expect "T19 prepare 後 staged 變動不能記錄" 1 flow review-record r2 --codex "$PASS_REPLY" --reviewer "$PASS_REPLY"
git -C "$CLAUDE_PROJECT_DIR/r2" reset -q HEAD c.txt; rm -f "$CLAUDE_PROJECT_DIR/r2/c.txt"
# 沒有 staged
git -C "$CLAUDE_PROJECT_DIR/r2" reset -q HEAD a.txt
expect "T20 沒有 staged 不能記錄" 1 flow review-record r2 --codex "$PASS_REPLY" --reviewer "$PASS_REPLY"

# ---------- exempt ----------
flow prepare r2 a.txt >/dev/null
expect "T21 exempt 有理由可收" 0 flow review-record r2 --exempt "POC 畫面，使用者明示不走審查"
expect "T21b exempt 紀錄 ship 放行" 0 flow ship r2 Style "調整樣式"
grep -q $'\tr2\t.*\texempt\t-\t-\tPOC 畫面' "$LOG" && ok "T21c 流水帳記下豁免理由" || bad "T21c 流水帳記下豁免理由" "$(tail -2 "$LOG")"

# ---------- 含斜線的 repo（worktree 子路徑）----------
new_repo wt/sub
edit wt/sub a.txt x
flow prepare wt/sub a.txt >/dev/null
expect "T22 子路徑 repo 無紀錄被擋" 1 flow ship wt/sub Feat "子路徑"
expect "T22b 子路徑 repo 記錄" 0 flow review-record wt/sub --codex "$PASS_REPLY" --reviewer "$PASS_REPLY"
expect "T22c 子路徑 repo ship 放行" 0 flow ship wt/sub Feat "子路徑"

# 兩個 repo 的紀錄互不通用
new_repo r3; new_repo r4
edit r3 a.txt same; edit r4 a.txt same
flow prepare r3 a.txt >/dev/null; flow prepare r4 a.txt >/dev/null
flow review-record r3 --codex "$PASS_REPLY" --reviewer "$PASS_REPLY" >/dev/null 2>&1
expect "T23 別的 repo 的紀錄不能拿來用" 1 flow ship r4 Feat "同內容"

# ---------- amend ----------
new_repo r5
edit r5 a.txt one
flow prepare r5 a.txt >/dev/null
flow review-record r5 --codex "$PASS_REPLY" --reviewer "$PASS_REPLY" >/dev/null 2>&1
flow ship r5 Feat "第一版" >/dev/null 2>&1
head_before="$(git -C "$CLAUDE_PROJECT_DIR/r5" rev-parse HEAD)"
branches_before="$(git -C "$CLAUDE_PROJECT_DIR/r5" branch --list 'backup/*' | wc -l)"
edit r5 a.txt two
flow prepare r5 a.txt >/dev/null
expect "T24 改到碼的 amend 無紀錄被擋" 1 flow amend r5 --confirm-rewrite
[ "$(git -C "$CLAUDE_PROJECT_DIR/r5" rev-parse HEAD)" = "$head_before" ] && ok "T24b 被擋時 HEAD 未改寫" || bad "T24b 被擋時 HEAD 未改寫"
[ "$(git -C "$CLAUDE_PROJECT_DIR/r5" branch --list 'backup/*' | wc -l)" = "$branches_before" ] && ok "T24c 被擋時備份分支已清" || bad "T24c 被擋時備份分支已清"
flow review-record r5 --codex "$PASS_REPLY" --reviewer "$PASS_REPLY" >/dev/null 2>&1
expect "T25 改到碼的 amend 有紀錄放行" 0 flow amend r5 --confirm-rewrite
[ "$(git -C "$CLAUDE_PROJECT_DIR/r5" rev-parse HEAD)" != "$head_before" ] && ok "T25b HEAD 已改寫" || bad "T25b HEAD 已改寫"
[ ! -f "$(rec_of r5)" ] && ok "T25c amend 後紀錄已清" || bad "T25c amend 後紀錄已清"
expect "T26 只改 message 的 amend 不需紀錄" 0 flow amend r5 --confirm-rewrite --type Feat --desc "第一版改名"

# ---------- push ----------
BARE="$ROOT/remote.git"; git init -q --bare "$BARE"
new_repo r6
git -C "$CLAUDE_PROJECT_DIR/r6" remote add origin "$BARE"
git -C "$CLAUDE_PROJECT_DIR/r6" push -q -u origin main
edit r6 a.txt one
flow prepare r6 a.txt >/dev/null
flow review-record r6 --codex "$PASS_REPLY" --reviewer "$PASS_REPLY" >/dev/null 2>&1
expect "T27 有紀錄 ship --push" 0 flow ship r6 Feat "推上去" --push
[ "$(git -C "$BARE" rev-parse main)" = "$(git -C "$CLAUDE_PROJECT_DIR/r6" rev-parse HEAD)" ] && ok "T27b 遠端已更新" || bad "T27b 遠端已更新"
edit r6 a.txt two
flow prepare r6 a.txt >/dev/null
flow review-record r6 --codex "$PASS_REPLY" --reviewer "$PASS_REPLY" >/dev/null 2>&1
flow ship r6 Feat "先本地" >/dev/null 2>&1
expect "T28 補推先前已審的 commit 不需再記錄" 0 flow ship r6 Feat "先本地" --push
edit r6 a.txt three
flow prepare r6 a.txt >/dev/null
expect "T29 無紀錄 ship --push 被擋" 1 flow ship r6 Feat "沒審就推" --push
[ "$(git -C "$BARE" rev-parse main)" = "$(git -C "$CLAUDE_PROJECT_DIR/r6" rev-parse HEAD)" ] && ok "T29b 被擋時遠端未變" || bad "T29b 被擋時遠端未變"

# ---------- 審查回報的兩個繞過（2026-09-24）----------
# slug 碰撞：grp/sub 與 grp__sub 轉成同一個 slug，內容相同時會借用對方的紀錄
new_repo grp/sub; new_repo grp__sub
edit grp/sub a.txt same; edit grp__sub a.txt same
flow prepare grp/sub a.txt >/dev/null
flow review-record grp/sub --codex "$PASS_REPLY" --reviewer "$PASS_REPLY" >/dev/null 2>&1
git -C "$CLAUDE_PROJECT_DIR/grp__sub" add a.txt
expect "T31 slug 相同的另一個 repo 不能借用紀錄" 1 flow ship grp__sub Chore "借用紀錄"
[ "$(commits grp__sub)" = 1 ] && ok "T31b 借用被擋時沒有產生 commit" || bad "T31b 借用被擋時沒有產生 commit"

# push-only 捷徑：換掉未推 commit 的內容、保留同一句 message，不能直接推
BARE7="$ROOT/remote7.git"; git init -q --bare "$BARE7"
new_repo r7
git -C "$CLAUDE_PROJECT_DIR/r7" remote add origin "$BARE7"
git -C "$CLAUDE_PROJECT_DIR/r7" push -q -u origin main
edit r7 g.txt reviewed
flow prepare r7 g.txt >/dev/null
flow review-record r7 --codex "$PASS_REPLY" --reviewer "$PASS_REPLY" >/dev/null 2>&1
flow ship r7 Feat "add widget" >/dev/null 2>&1
git -C "$CLAUDE_PROJECT_DIR/r7" reset -q --soft HEAD^
echo "UNREVIEWED" > "$CLAUDE_PROJECT_DIR/r7/g.txt"; git -C "$CLAUDE_PROJECT_DIR/r7" add g.txt
GIT_COMMIT_FLOW=1 git -C "$CLAUDE_PROJECT_DIR/r7" commit -q -m "Feat: add widget"
expect "T32 換過內容的同名 commit 不能走 push-only" 1 flow ship r7 Feat "add widget" --push
[ -z "$(git -C "$BARE7" ls-tree main g.txt)" ] && ok "T32b 未審內容沒有推上遠端" || bad "T32b 未審內容沒有推上遠端"
# 正常情境仍要能補推：丟掉換過內容的那顆，重走一次正規流程
git -C "$CLAUDE_PROJECT_DIR/r7" reset -q --hard origin/main
edit r7 h.txt ok
flow prepare r7 h.txt >/dev/null
flow review-record r7 --codex "$PASS_REPLY" --reviewer "$PASS_REPLY" >/dev/null 2>&1
flow ship r7 Feat "正常補推" >/dev/null 2>&1
expect "T33 flow.sh 建的那顆仍可補推" 0 flow ship r7 Feat "正常補推" --push
[ "$(git -C "$BARE7" rev-parse main)" = "$(git -C "$CLAUDE_PROJECT_DIR/r7" rev-parse HEAD)" ] && ok "T33b 補推後遠端已更新" || bad "T33b 補推後遠端已更新"

# 只改 message 的 amend 不能替流程外建的 commit 洗白
echo "OUTSIDE" > "$CLAUDE_PROJECT_DIR/r7/o.txt"; git -C "$CLAUDE_PROJECT_DIR/r7" add o.txt
GIT_COMMIT_FLOW=1 git -C "$CLAUDE_PROJECT_DIR/r7" commit -q -m "Chore: 流程外"
flow amend r7 --confirm-rewrite --type Feat --desc "改名後想補推" >/dev/null 2>&1
expect "T34 流程外的 commit 改完 message 仍不能走補推" 1 flow ship r7 Feat "改名後想補推" --push
[ -z "$(git -C "$BARE7" ls-tree main o.txt)" ] && ok "T34b 流程外內容沒有推上遠端" || bad "T34b 流程外內容沒有推上遠端"

# 由 ship 建的 commit 只改 message 後仍可補推
git -C "$CLAUDE_PROJECT_DIR/r7" reset -q --hard origin/main
edit r7 k.txt ok
flow prepare r7 k.txt >/dev/null
flow review-record r7 --codex "$PASS_REPLY" --reviewer "$PASS_REPLY" >/dev/null 2>&1
flow ship r7 Feat "原本的描述" >/dev/null 2>&1
flow amend r7 --confirm-rewrite --type Feat --desc "修正後的描述" >/dev/null 2>&1
expect "T35 ship 建的 commit 改 message 後仍可補推" 0 flow ship r7 Feat "修正後的描述" --push

# 只改 message 的 amend：標記的 commit 相同但屬於另一個 repo（slug 撞名的 clone），不能承接
BAREC="$ROOT/remotec.git"; git init -q --bare "$BAREC"
new_repo cl/one
git -C "$CLAUDE_PROJECT_DIR/cl/one" remote add origin "$BAREC"; git -C "$CLAUDE_PROJECT_DIR/cl/one" push -q -u origin main
edit cl/one a.txt x
flow prepare cl/one a.txt >/dev/null
flow review-record cl/one --codex "$PASS_REPLY" --reviewer "$PASS_REPLY" >/dev/null 2>&1
flow ship cl/one Feat "clone 原本" >/dev/null 2>&1
git clone -q "$CLAUDE_PROJECT_DIR/cl/one" "$CLAUDE_PROJECT_DIR/cl__one"
git -C "$CLAUDE_PROJECT_DIR/cl__one" config user.email t@example.com; git -C "$CLAUDE_PROJECT_DIR/cl__one" config user.name tester
git -C "$CLAUDE_PROJECT_DIR/cl__one" remote set-url origin "$BAREC"; git -C "$CLAUDE_PROJECT_DIR/cl__one" fetch -q origin
git -C "$CLAUDE_PROJECT_DIR/cl__one" branch -q -u origin/main
flow amend cl__one --confirm-rewrite --type Feat --desc "clone 改名" >/dev/null 2>&1
expect "T39 另一個 repo 的標記不能被 amend 承接" 1 flow ship cl__one Feat "clone 改名" --push

# ---------- --qa 表態（選填，專案 hook 決定何時必填）----------
new_repo r8
edit r8 a.vue x
flow prepare r8 a.vue >/dev/null
expect "T36 帶 --qa 可記錄" 0 flow review-record r8 --codex "$PASS_REPLY" --reviewer "$PASS_REPLY" --qa $'已QA：tests/e2e/x.py\n 3 passed'
grep -q "^qa=已QA：tests/e2e/x.py  3 passed$" "$(rec_of r8)" && ok "T36b QA 表態寫進紀錄（換行已攤平）" || bad "T36b QA 表態寫進紀錄（換行已攤平）" "$(grep '^qa=' "$(rec_of r8)")"
grep -q $'\tr8\t.*\t已QA：tests/e2e/x.py  3 passed$' "$LOG" && ok "T36c QA 表態寫進流水帳" || bad "T36c QA 表態寫進流水帳" "$(tail -1 "$LOG")"
expect "T36d 帶 QA 的紀錄 ship 放行" 0 flow ship r8 Feat "帶 QA"
edit r8 a.vue y
flow prepare r8 a.vue >/dev/null
expect "T37 --qa 缺值不收" 1 flow review-record r8 --codex "$PASS_REPLY" --reviewer "$PASS_REPLY" --qa
expect "T38 豁免模式不帶 --qa 仍可記錄（flow.sh 本身不強制）" 0 flow review-record r8 --exempt "Style：只動樣式"
edit r8 a.vue z
flow prepare r8 a.vue >/dev/null
expect "T38c 兩軌模式不帶 --qa 仍可記錄" 0 flow review-record r8 --codex "$PASS_REPLY" --reviewer "$PASS_REPLY"
grep -q "^qa=-$" "$(rec_of r8)" && ok "T38b 未表態記成 -" || bad "T38b 未表態記成 -"

# ---------- help ----------
bash "$FLOW" --help | grep -q "review-record" && ok "T30 --help 列出 review-record" || bad "T30 --help 列出 review-record"

rm -rf "$ROOT"
echo ""
echo "=== 結果：PASS $pass / FAIL $fail ==="
[ "$fail" -eq 0 ] || { printf '  - %s\n' "${failed[@]}"; exit 1; }
