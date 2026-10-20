#!/usr/bin/env bash
# 0.14.0 兩道閘的實跑測試。用法：bash test_amend_cleanup_new_commit.sh <flow.sh 路徑>
# 涵蓋：①追加修正閘——HEAD 還沒推上遠端時 ship 預設拒絕另開一顆、--new-commit 帶理由才放行並寫 review-log、
#         push-only 補推不受影響、沒有 remote 的 repo 不管；②amend 驗證通過自動刪備份分支並印證據（有改碼與只改 message 兩種）。
set -u
FLOW="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
ROOT="$(mktemp -d)"
export CLAUDE_PROJECT_DIR="$ROOT/ws"
mkdir -p "$CLAUDE_PROJECT_DIR"
winp() { cygpath -m "$1" 2>/dev/null || printf '%s' "$1"; }
export GIT_COMMIT_TICKET_DIR="$(winp "$ROOT/tickets")"
pass=0; fail=0; failed=()

ok()   { pass=$((pass+1)); echo "PASS  $1"; }
bad()  { fail=$((fail+1)); failed+=("$1"); echo "FAIL  $1"; [ -n "${2:-}" ] && echo "      $2"; }
expect() {
  local name="$1" want="$2"; shift 2
  local out rc
  out="$("$@" 2>&1)"; rc=$?
  if [ "$rc" -eq "$want" ]; then ok "$name (exit $rc)"; else bad "$name" "期望 exit $want，實際 $rc：$(printf '%s' "$out" | tail -4 | tr '\n' '|')"; fi
  LAST_OUT="$out"
}
has() { if printf '%s' "$LAST_OUT" | grep -qF -- "$2"; then ok "$1"; else bad "$1" "輸出沒有「$2」：$(printf '%s' "$LAST_OUT" | tail -4 | tr '\n' '|')"; fi; }
flow() { bash "$FLOW" "$@"; }
R() { echo "$CLAUDE_PROJECT_DIR/$1"; }
new_repo() {
  local r; r="$(R "$1")"
  mkdir -p "$r"; git -C "$r" init -q -b main
  git -C "$r" config user.email t@example.com; git -C "$r" config user.name tester
  git -C "$r" config core.autocrlf false
  echo base > "$r/base.txt"; git -C "$r" add base.txt
  GIT_COMMIT_FLOW=1 git -C "$r" commit -q -m "Chore: init"
}
put() { mkdir -p "$(dirname "$(R "$1")/$2")"; printf '%s\n' "$3" >> "$(R "$1")/$2"; }
PASS_REPLY=$'VERDICT: PASS\n- a.txt:1 觀察點'
rec_pass() { flow review-record "$1" --codex "$PASS_REPLY" --reviewer "$PASS_REPLY" >/dev/null 2>&1; }
backups() { git -C "$(R "$1")" branch --list 'backup/*' | tr -d ' *' | tr '\n' ' '; }
REVIEW_LOG="$CLAUDE_PROJECT_DIR/.claude/.git-commit-tmp/review-log.tsv"

# ================= 1. 追加修正閘 =================
BARE="$ROOT/remote.git"; git init -q --bare "$BARE"
new_repo n1
git -C "$(R n1)" remote add origin "$BARE"
git -C "$(R n1)" push -q -u origin main

put n1 a.txt one
flow prepare n1 a.txt >/dev/null; rec_pass n1
expect "N01 HEAD 已推：ship 正常建第一顆" 0 flow ship n1 Feat "第一顆"
[ -z "$(git -C "$(R n1)" branch -r --contains HEAD)" ] && ok "N01b 現在 HEAD 未推" || bad "N01b 現在 HEAD 未推"

put n1 a.txt two
flow prepare n1 a.txt >/dev/null; rec_pass n1
expect "N02 HEAD 未推：ship 不帶 --new-commit 被擋" 1 flow ship n1 Fix "追加修正"
has "N02b 訊息說明應 amend 併進 HEAD" "應併進 HEAD 而不是另開一顆"
has "N02c 訊息給出 amend 指令" "flow.sh amend n1 --confirm-rewrite"
[ "$(git -C "$(R n1)" log -1 --format=%s)" = "Feat: 第一顆" ] && ok "N02d HEAD 沒被動" || bad "N02d HEAD 沒被動"

expect "N03 --new-commit 沒給理由被擋" 1 flow ship n1 Fix "追加修正" --new-commit
expect "N04 --new-commit 帶理由放行" 0 flow ship n1 Feat "獨立功能" --new-commit "與第一顆是不同功能，刻意分開"
has "N04b 輸出說理由已記進 review-log" "理由已記進 review-log.tsv"
grep -q $'\tnew-commit\t' "$REVIEW_LOG" 2>/dev/null && grep -q "與第一顆是不同功能" "$REVIEW_LOG" && ok "N04c review-log.tsv 有 new-commit 列與理由" || bad "N04c review-log.tsv 有 new-commit 列與理由" "$(cat "$REVIEW_LOG" 2>/dev/null | tail -2)"
[ "$(git -C "$(R n1)" log -1 --format=%s)" = "Feat: 獨立功能" ] && ok "N04d 第二顆已建" || bad "N04d 第二顆已建"

# ================= 2. amend 驗證通過自動刪備份分支 =================
put n1 a.txt three
flow prepare n1 a.txt >/dev/null; rec_pass n1
expect "A01 有改碼的 amend 成功" 0 flow amend n1 --confirm-rewrite --type Fix --desc "併進去"
has "A01b 印出備份分支已刪除與驗證證據" "已刪除（驗證通過：parent"
[ -z "$(backups n1)" ] && ok "A01c 沒有殘留 backup/* 分支" || bad "A01c 沒有殘留 backup/* 分支" "殘留：$(backups n1)"
[ "$(git -C "$(R n1)" log -1 --format=%s)" = "Fix: 併進去" ] && ok "A01d message 已改" || bad "A01d message 已改"
grep -q three "$(R n1)/a.txt" && git -C "$(R n1)" diff --quiet HEAD -- a.txt && ok "A01e 改動已進 HEAD" || bad "A01e 改動已進 HEAD"

expect "A02 只改 message 的 amend 成功" 0 flow amend n1 --confirm-rewrite --type Fix --desc "再改一次名字"
has "A02b 印出備份分支已刪除" "已刪除（驗證通過"
[ -z "$(backups n1)" ] && ok "A02c 沒有殘留 backup/* 分支" || bad "A02c 沒有殘留 backup/* 分支" "殘留：$(backups n1)"

# amend 被閘擋下時（staged 內容沒有審查紀錄）仍要清掉剛建的備份分支、HEAD 不變
put n1 a.txt four
flow prepare n1 a.txt >/dev/null
expect "A03 沒審查紀錄的 amend 被擋" 1 flow amend n1 --confirm-rewrite
[ -z "$(backups n1)" ] && ok "A03b 擋下時也沒殘留 backup/* 分支" || bad "A03b 擋下時也沒殘留 backup/* 分支" "殘留：$(backups n1)"
git -C "$(R n1)" restore --staged a.txt; git -C "$(R n1)" checkout -- a.txt

# ================= 3. push-only 補推不受追加修正閘影響；推完 HEAD 已推 =================
expect "P01 push-only 補推（沒有 staged）成功" 0 flow ship n1 Fix "再改一次名字" --push
[ -n "$(git -C "$(R n1)" branch -r --contains HEAD)" ] && ok "P01b 推完 HEAD 在遠端分支上" || bad "P01b 推完 HEAD 在遠端分支上"
put n1 a.txt five
flow prepare n1 a.txt >/dev/null; rec_pass n1
expect "P02 HEAD 已推：ship 又可以直接建新的一顆" 0 flow ship n1 Feat "推完之後的新功能"

# ================= 3b. 未推的 HEAD 不是本流程建的（有 remote 但從沒推過的 init）：不擋；接著自己建的那顆才擋 =================
new_repo n3
git -C "$(R n3)" remote add upstream "$BARE"
put n3 a.txt one
flow prepare n3 a.txt >/dev/null; rec_pass n3
expect "U01 HEAD 是別人／init 的未推 commit：ship 不擋" 0 flow ship n3 Feat "第一顆"
put n3 a.txt two
flow prepare n3 a.txt >/dev/null; rec_pass n3
expect "U02 HEAD 變成本流程剛建的那顆：第二顆被擋" 1 flow ship n3 Fix "追加"
has "U02b 訊息說明是這一輪剛建的" "是這一輪 flow.sh 剛建的"

# ================= 4. 沒有 remote 的 repo：閘不管 =================
new_repo n2
put n2 a.txt one
flow prepare n2 a.txt >/dev/null; rec_pass n2
expect "R01 沒有 remote：第一顆" 0 flow ship n2 Feat "第一顆"
put n2 a.txt two
flow prepare n2 a.txt >/dev/null; rec_pass n2
expect "R02 沒有 remote：第二顆也不擋" 0 flow ship n2 Feat "第二顆"

# ================= 5. merge 收尾建出的未推 merge commit 不算追加修正的基底：合併後的下一顆 ship 不擋 =================
BARE2="$ROOT/remote2.git"; git init -q --bare "$BARE2"
new_repo n4
git -C "$(R n4)" remote add origin "$BARE2"
git -C "$(R n4)" checkout -q -b topic
echo topic-side > "$(R n4)/a.txt"; git -C "$(R n4)" add a.txt; GIT_COMMIT_FLOW=1 git -C "$(R n4)" commit -q -m "Feat: topic"
git -C "$(R n4)" checkout -q main
echo main-side > "$(R n4)/a.txt"; git -C "$(R n4)" add a.txt; GIT_COMMIT_FLOW=1 git -C "$(R n4)" commit -q -m "Feat: main"
git -C "$(R n4)" push -q -u origin main
git -C "$(R n4)" merge -q topic >/dev/null 2>&1 && bad "M00 預期 merge 衝突" || ok "M00 merge 衝突（add/add）"
echo resolved > "$(R n4)/a.txt"; git -C "$(R n4)" add a.txt
flow prepare n4 --staged >/dev/null; rec_pass n4
expect "M01 merge 收尾：ship 建出 merge commit" 0 flow ship n4 Chore "合併 topic"
[ "$(git -C "$(R n4)" rev-list --parents -n 1 HEAD | wc -w)" -eq 3 ] && ok "M01b HEAD 是兩個 parent 的 merge commit" || bad "M01b HEAD 是兩個 parent 的 merge commit"
[ -z "$(git -C "$(R n4)" branch -r --contains HEAD)" ] && ok "M01c merge commit 還沒推" || bad "M01c merge commit 還沒推"
put n4 a.txt after-merge
flow prepare n4 a.txt >/dev/null; rec_pass n4
expect "M02 HEAD 是本流程建的未推 merge commit：合併後的下一顆 ship 不擋" 0 flow ship n4 Feat "合併後的新功能"
[ "$(git -C "$(R n4)" log -1 --format=%s)" = "Feat: 合併後的新功能" ] && ok "M02b 新的一顆已建" || bad "M02b 新的一顆已建"
put n4 a.txt again
flow prepare n4 a.txt >/dev/null; rec_pass n4
expect "M03 HEAD 變成一般的未推 commit：再下一顆才被擋" 1 flow ship n4 Fix "追加"

echo ""
echo "合計 PASS $pass / FAIL $fail"
[ "$fail" -eq 0 ] || { printf '  - %s\n' "${failed[@]}"; }
rm -rf "$ROOT"
exit "$fail"
