#!/usr/bin/env bash
# merge 收尾支援（0.8.1）的實跑測試：偵測器判定、hook 端到端、flow.sh prepare 的 merge 情境。
# 用法：bash test_merge_support.sh <flow.sh 路徑>
set -u
FLOW="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
HOOKS="$(cd "$(dirname "$FLOW")/../../hooks" && pwd)"
DETECTOR="$HOOKS/detect-git-write.py"
HOOK="$HOOKS/block-bare-git-commit.sh"
PY="$(command -v python3 2>/dev/null || command -v python 2>/dev/null)"
ROOT="$(mktemp -d)"
export CLAUDE_PROJECT_DIR="$ROOT/ws"
export GIT_EDITOR=true GIT_MERGE_AUTOEDIT=no
mkdir -p "$CLAUDE_PROJECT_DIR"
pass=0; fail=0; failed=()

ok()   { pass=$((pass+1)); echo "PASS  $1"; }
bad()  { fail=$((fail+1)); failed+=("$1"); echo "FAIL  $1"; [ -n "${2:-}" ] && echo "      $2"; }
expect() {
  local name="$1" want="$2"; shift 2
  local out rc
  out="$("$@" 2>&1)"; rc=$?
  if [ "$rc" -eq "$want" ]; then ok "$name (exit $rc)"; else bad "$name" "期望 exit $want，實際 $rc：$(printf '%s' "$out" | tail -3 | tr '\n' '|')"; fi
  LAST_OUT="$out"
}
flow() { bash "$FLOW" "$@"; }

# ---------- 偵測器：攔 ----------
# detect <期望 hit|pass> <指令>
# 偵測器契約：命中＝exit 0 且印出命中項；未命中＝exit 1 且無輸出。stderr 必須為空——
# 只看 stdout 的話，偵測器丟例外（exit 1、stdout 空）會被當成「放行」而假綠。
detect() {
  local want="$1" cmd="$2" got rc err
  got="$(printf '%s' "$cmd" | "$PY" "$DETECTOR" 2>"$ROOT/detect.err")"; rc=$?
  err="$(cat "$ROOT/detect.err")"
  if [ -n "$err" ]; then bad "D $want $cmd" "偵測器 stderr：$(printf '%s' "$err" | tail -1)"
  elif [ "$want" = hit ] && [ "$rc" -eq 0 ] && [ -n "$got" ]; then ok "D 攔  $cmd"
  elif [ "$want" = pass ] && [ "$rc" -eq 1 ] && [ -z "$got" ]; then ok "D 放行 $cmd"
  else bad "D $want $cmd" "偵測器 exit $rc，輸出：[$got]"; fi
}
detect hit  'git merge --continue'
detect hit  'git merge --continue 2>/dev/null'
detect hit  'git merge --continue; echo ok'
detect hit  'git merge --continue && git push'
detect hit  'git -C sub merge --continue'
detect hit  'cd x && git merge --continue'
detect hit  "bash -c 'git merge --continue'"
detect hit  "git -c alias.mc='merge --continue' mc"
detect hit  'git.exe merge --continue'
# --continue 只是值／目標，或 git 本身會拒絕（--continue expects no arguments）
detect pass 'git merge -qm --continue topic'
detect pass 'git merge -m --continue topic'
detect pass 'git merge --message --continue topic'
detect pass 'git merge -F --continue topic'
detect pass 'git merge -- --continue'
detect pass 'git merge -s ours --continue'
detect pass 'git merge --continue --no-edit'
detect pass 'git merge feat'
detect pass 'git merge --no-ff --no-commit feat'
detect pass 'git merge --abort'
detect pass 'git merge-base a b'
detect pass 'git pull'
detect pass 'git log --grep=--continue'
detect pass 'git status'
# 既有射程不變
detect hit  'git commit -m x'
detect hit  'git commit-tree t'
detect hit  'git update-ref refs/heads/x y'
detect hit  'git branch -f x'

# ---------- 判準依據：git 只在 --continue 單獨出現時收尾 ----------
# 若未來 git 改變這個行為，偵測器的「args 恰為 [--continue]」判準就要重審。
R="$CLAUDE_PROJECT_DIR/g"
conflict_repo() {
  rm -rf "$R"; mkdir -p "$R"; git -C "$R" init -q -b main
  git -C "$R" config user.email t@example.com; git -C "$R" config user.name tester
  git -C "$R" config core.autocrlf false
  printf 'a\n' > "$R/f"; printf 'a\n' > "$R/h"; git -C "$R" add f h
  GIT_COMMIT_FLOW=1 git -C "$R" commit -q -m "Chore: init"
  git -C "$R" checkout -q -b feat
  printf 'b\n' > "$R/f"; printf 'b\n' > "$R/h"; printf 'n\n' > "$R/new"; git -C "$R" add f h new
  GIT_COMMIT_FLOW=1 git -C "$R" commit -q -m "Feat: b"
  git -C "$R" checkout -q main
  printf 'c\n' > "$R/f"; printf 'c\n' > "$R/h"
  GIT_COMMIT_FLOW=1 git -C "$R" commit -q -am "Feat: c"
  git -C "$R" merge feat >/dev/null 2>&1
}
conflict_repo
printf 'r\n' > "$R/f"; printf 'r\n' > "$R/h"; git -C "$R" add f h
expect "G1 --continue 帶其他參數 git 拒絕" 129 git -C "$R" merge -s ours --continue
[ -f "$R/.git/MERGE_HEAD" ] && ok "G1b 被拒後 MERGE_HEAD 仍在" || bad "G1b 被拒後 MERGE_HEAD 仍在"
expect "G2 單獨 --continue 真的收尾" 0 git -C "$R" -c core.hooksPath=/dev/null merge --continue
[ ! -f "$R/.git/MERGE_HEAD" ] && [ "$(git -C "$R" cat-file -p HEAD | grep -c '^parent')" = 2 ] \
  && ok "G2b 產生雙 parent commit" || bad "G2b 產生雙 parent commit"

# ---------- hook 端到端 ----------
hook() { printf '{"tool_input":{"command":"%s"}}' "$1" | bash "$HOOK"; }
expect "H1 hook 攔 git merge --continue" 2 hook 'git merge --continue'
printf '%s' "$LAST_OUT" | grep -q 'merge 停在衝突' && ok "H1b 攔截訊息含 merge 收尾段" || bad "H1b 攔截訊息含 merge 收尾段"
expect "H2 hook 放行 --continue 當訊息值" 0 hook 'git merge -qm --continue topic'
expect "H3 hook 放行 git merge" 0 hook 'git merge feat'

# ---------- flow.sh prepare 的 merge 情境 ----------
cd "$CLAUDE_PROJECT_DIR"
conflict_repo
expect "P1 --staged 但仍有未解衝突被擋" 1 flow prepare g --staged
printf '%s' "$LAST_OUT" | grep -q '未解衝突' && ok "P1b 錯誤訊息指出未解衝突" || bad "P1b 錯誤訊息指出未解衝突"
printf 'r\n' > "$R/f"
expect "P2 只解一檔仍被擋" 1 flow prepare g f
printf '%s' "$LAST_OUT" | grep -q '^  h$' && ok "P2b 列出剩下的衝突檔 h" || bad "P2b 列出剩下的衝突檔 h" "$LAST_OUT"
expect "P3 --staged 帶檔名被擋" 1 flow prepare g --staged f
expect "P4 不帶檔名也不帶 --staged 被擋" 1 flow prepare g
printf '%s' "$LAST_OUT" | grep -q -- '--staged' && ok "P4b 錯誤訊息提示 --staged" || bad "P4b 錯誤訊息提示 --staged"
printf 'r\n' > "$R/h"; git -C "$R" add h
expect "P5 解完後 --staged 可送審" 0 flow prepare g --staged
printf '%s' "$LAST_OUT" | grep -q 'MERGE_HEAD 存在' && ok "P5b 提示 merge 進行中" || bad "P5b 提示 merge 進行中"
expect "P6 豁免紀錄" 0 flow review-record g --exempt "merge 測試"
expect "P7 ship 建出 merge commit" 0 flow ship g Chore "合併 feat"
[ "$(git -C "$R" cat-file -p HEAD | grep -c '^parent')" = 2 ] && ok "P7b 雙 parent" || bad "P7b 雙 parent"
[ ! -f "$R/.git/MERGE_HEAD" ] && ok "P7c MERGE_HEAD 已清" || bad "P7c MERGE_HEAD 已清"
expect "P8 index 空時 --staged 被擋" 1 flow prepare g --staged
# 非 merge 狀態的一般 prepare 不受影響
printf 'z\n' > "$R/z"
expect "P9 一般逐檔 prepare 照常" 0 flow prepare g z
git -C "$R" reset -q

# ---------- 外來 staged 閘（prepare 逐檔模式） ----------
# index 是所有 session 共用的：別人 stage 的檔不在這次清單內就拒絕，免得一起被 commit。
F="$CLAUDE_PROJECT_DIR/fg"
rm -rf "$F"; mkdir -p "$F"; git -C "$F" init -q -b main
git -C "$F" config user.email t@example.com; git -C "$F" config user.name tester
git -C "$F" config core.autocrlf false
echo base > "$F/base.txt"; git -C "$F" add base.txt
GIT_COMMIT_FLOW=1 git -C "$F" commit -q -m "Chore: init"
echo other > "$F/other.txt"; git -C "$F" add other.txt      # 模擬別的 session 已 stage
echo mine > "$F/mine.txt"
expect "F1 index 有清單外 staged 項目被擋" 1 flow prepare fg mine.txt
printf '%s' "$LAST_OUT" | grep -q '^  other.txt$' && ok "F1b 列出外來項目 other.txt" || bad "F1b 列出外來項目 other.txt" "$LAST_OUT"
printf '%s' "$LAST_OUT" | grep -q -- '--staged' && ok "F1c 提示自己切 hunk 的改用 --staged" || bad "F1c 提示自己切 hunk 的改用 --staged"
[ -z "$(git -C "$F" diff --cached --name-only -- mine.txt)" ] && ok "F1d 被擋時沒有 git add 清單內的檔" || bad "F1d 被擋時沒有 git add 清單內的檔"
[ -n "$(git -C "$F" diff --cached --name-only -- other.txt)" ] && ok "F1e 被擋時沒有動到別人的 staged" || bad "F1e 被擋時沒有動到別人的 staged"
expect "F2 外來項目也列進清單就放行" 0 flow prepare fg mine.txt other.txt
git -C "$F" reset -q
mkdir -p "$F/sub"; echo y > "$F/sub/y.txt"; git -C "$F" add sub/y.txt
expect "F3 目錄 pathspec 涵蓋已 staged 的檔就放行" 0 flow prepare fg sub
git -C "$F" reset -q
echo other2 >> "$F/other.txt"; git -C "$F" add other.txt
expect "F4 --staged 模式不檢查（整個 index 就是要送審的）" 0 flow prepare fg --staged
git -C "$F" reset -q
expect "F5 index 乾淨時逐檔照常" 0 flow prepare fg mine.txt
git -C "$F" reset -q
echo cjk > "$F/中文 檔.txt"; git -C "$F" add "中文 檔.txt"
expect "F7 外來項目是中文含空白檔名也擋" 1 flow prepare fg mine.txt
printf '%s' "$LAST_OUT" | grep -q '^  中文 檔.txt$' && ok "F7b 中文檔名原樣列出（不轉八進位）" || bad "F7b 中文檔名原樣列出（不轉八進位）" "$LAST_OUT"
git -C "$F" reset -q
# rename 偵測會把「別人 staged 刪除 base.txt」與「我已 staged 的同內容 mine.txt」併成一筆 R，只列 mine.txt
cp "$F/base.txt" "$F/mine.txt"; git -C "$F" add mine.txt; git -C "$F" rm -q --cached base.txt
expect "F8 別人 staged 刪除被 rename 偵測併進清單內檔案也擋" 1 flow prepare fg mine.txt
printf '%s' "$LAST_OUT" | grep -q '^  base.txt$' && ok "F8b 列出被刪的 base.txt" || bad "F8b 列出被刪的 base.txt" "$LAST_OUT"
git -C "$F" reset -q; echo mine > "$F/mine.txt"
# repo 設定會改變 git diff 輸出（藏 submodule 更新、偵測 rename）——閘用 plumbing，不能受影響
git -C "$F" update-index --add --cacheinfo "160000,$(git -C "$F" rev-parse HEAD),sublink"
git -C "$F" config diff.ignoreSubmodules all; git -C "$F" config submodule.sublink.ignore all
git -C "$F" config diff.renames copies
expect "F9 repo 設定藏起 staged submodule 更新也擋" 1 flow prepare fg mine.txt
printf '%s' "$LAST_OUT" | grep -q '^  sublink$' && ok "F9b 列出 sublink" || bad "F9b 列出 sublink" "$LAST_OUT"
git -C "$F" reset -q
git -C "$F" config --unset diff.ignoreSubmodules; git -C "$F" config --unset submodule.sublink.ignore
git -C "$F" config --unset diff.renames
# 既有 submodule 的指標更新（HEAD 已有 gitlink，staged 換成另一個 commit），兩種 ignore 設定各自單獨測
C1="$(git -C "$F" rev-parse HEAD)"
git -C "$F" update-index --add --cacheinfo "160000,$C1,sublink2"
# submodule.<name>.ignore 只對 .gitmodules 登記過的 submodule 生效，要登記才測得到
git -C "$F" config -f "$F/.gitmodules" submodule.sublink2.path sublink2
git -C "$F" config -f "$F/.gitmodules" submodule.sublink2.url ./sublink2
git -C "$F" add .gitmodules
GIT_COMMIT_FLOW=1 git -C "$F" commit -q -m "Chore: add gitlink"
C2="$(git -C "$F" rev-parse HEAD)"
git -C "$F" update-index --cacheinfo "160000,$C2,sublink2"
git -C "$F" config diff.ignoreSubmodules all
expect "F9c 既有 submodule 指標更新＋只設 diff.ignoreSubmodules 也擋" 1 flow prepare fg mine.txt
printf '%s' "$LAST_OUT" | grep -q '^  sublink2$' && ok "F9d 列出 sublink2" || bad "F9d 列出 sublink2" "$LAST_OUT"
git -C "$F" config --unset diff.ignoreSubmodules
git -C "$F" config submodule.sublink2.ignore all
expect "F9e 既有 submodule 指標更新＋只設 submodule.<name>.ignore 也擋" 1 flow prepare fg mine.txt
printf '%s' "$LAST_OUT" | grep -q '^  sublink2$' && ok "F9f 列出 sublink2" || bad "F9f 列出 sublink2" "$LAST_OUT"
git -C "$F" config --unset submodule.sublink2.ignore
git -C "$F" reset -q
# 還沒有任何 commit（沒有 HEAD）：比空 tree
E="$CLAUDE_PROJECT_DIR/empty"
rm -rf "$E"; mkdir -p "$E"; git -C "$E" init -q -b main; git -C "$E" config core.autocrlf false
echo o > "$E/other.txt"; git -C "$E" add other.txt; echo m > "$E/mine.txt"
expect "F10 沒有 HEAD 的 repo 也擋外來項目" 1 flow prepare empty mine.txt
printf '%s' "$LAST_OUT" | grep -q '^  other.txt$' && ok "F10b 列出 other.txt" || bad "F10b 列出 other.txt" "$LAST_OUT"
git -C "$E" rm -q --cached other.txt
expect "F10c 沒有 HEAD 且 index 乾淨時照常" 0 flow prepare empty mine.txt
# merge 進行中不檢查：合併進來的新檔（new）已由 git stage，不在清單內也放行
conflict_repo
printf 'r\n' > "$R/f"; printf 'r\n' > "$R/h"
expect "F6 merge 進行中逐檔 prepare 不被外來閘擋" 0 flow prepare g f h
git -C "$R" merge --abort 2>/dev/null

# ---------- repo 參數給絕對路徑 ----------
expect "A1 絕對路徑 /c/... 被擋" 1 flow analyze /c/foo
printf '%s' "$LAST_OUT" | grep -q '不收絕對路徑' && ok "A1b 錯誤訊息講明不收絕對路徑" || bad "A1b 錯誤訊息講明不收絕對路徑"
expect "A2 絕對路徑 C:\foo 被擋" 1 flow analyze 'C:\foo'
printf '%s' "$LAST_OUT" | grep -q '不收絕對路徑' && ok "A2b 錯誤訊息講明不收絕對路徑" || bad "A2b 錯誤訊息講明不收絕對路徑"
expect "A3 不存在的子目錄名" 1 flow analyze nosuch
printf '%s' "$LAST_OUT" | grep -q '不收絕對路徑' && bad "A3b 相對路徑不該出現絕對路徑提示" || ok "A3b 相對路徑不出現絕對路徑提示"

# ---------- --help ----------
flow --help | grep -q 'prepare <repo> --staged' && ok "U1 --help 列出 --staged" || bad "U1 --help 列出 --staged"
flow --help | grep -q 'Merge 收尾' && ok "U2 --help 有 merge 收尾段" || bad "U2 --help 有 merge 收尾段"

cd /; rm -rf "$ROOT"
echo
echo "=== 結果：PASS $pass / FAIL $fail ==="
[ "$fail" -gt 0 ] && { printf '  - %s\n' "${failed[@]}"; exit 1; }
exit 0
