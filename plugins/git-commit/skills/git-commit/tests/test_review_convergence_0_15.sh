#!/usr/bin/env bash
# 0.15.0 審查收斂四項的實跑測試。用法：bash test_review_convergence_0_15.sh <flow.sh 路徑>
# 涵蓋：①review-log 多記 rounds／risk 兩欄（含舊表頭就地升級）；②第 2 輪起產出前幾輪意見與增量 diff；
#       ③第 rethink_round 輪起 prepare 要 --rethink；④風險分級（低／一般／高）與「skipped: 低風險」只收低風險。
set -u
FLOW="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
ROOT="$(mktemp -d)"
export CLAUDE_PROJECT_DIR="$ROOT/ws"
mkdir -p "$CLAUDE_PROJECT_DIR/.claude"
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
has()  { if printf '%s' "$LAST_OUT" | grep -qF -- "$2"; then ok "$1"; else bad "$1" "輸出沒有「$2」：$(printf '%s' "$LAST_OUT" | tail -6 | tr '\n' '|')"; fi; }
hasnt(){ if printf '%s' "$LAST_OUT" | grep -qF -- "$2"; then bad "$1" "輸出不該有「$2」"; else ok "$1"; fi; }
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
setf() { mkdir -p "$(dirname "$(R "$1")/$2")"; printf '%s\n' "$3" > "$(R "$1")/$2"; }
PASS_REPLY=$'VERDICT: PASS\n- a.txt:1 觀察點'
BLOCK_REPLY=$'VERDICT: BLOCK\n- a.txt:1 [一般] 邏輯錯'
REVIEW_LOG="$CLAUDE_PROJECT_DIR/.claude/.git-commit-tmp/review-log.tsv"
TMPD="$CLAUDE_PROJECT_DIR/.claude/.git-commit-tmp"
state() { echo "$(git -C "$(R "$1")" rev-parse --absolute-git-dir)/git-commit-flow"; }
# 模擬 SubagentStop hook 抓到某一軌的回覆（格式同 hooks/capture-review-reply.js 寫的檔）
fake_reply() {
  local repo="$1" track="$2" verdict="$3" text="$4" sd id
  sd="$(state "$repo")"
  id="$(sed -n 1p "$sd/ticket" | tr -d '\r')"; id="${id#*=}"
  printf 'ticket=%s\ntrack=%s\nverdict=%s\nagent_type=test\ncaptured_at=now\n---\n%s\n' "$id" "$track" "$verdict" "$text" > "$sd/reply-$id-$track"
}
last_log() { tail -n 1 "$REVIEW_LOG" | tr -d '\r'; }
col() { last_log | awk -F'\t' -v c="$1" '{ print $c }'; }

# ================= 1. review-log 多記 rounds／risk =================
new_repo l1
put l1 a.js "const a = 1;"
expect "L01 prepare 第 1 輪" 0 flow prepare l1 a.js
has "L01b 印出風險等級：一般（新增檔）" "風險等級：一般"
expect "L02 review-record 通過" 0 flow review-record l1 --codex "$PASS_REPLY" --reviewer "$PASS_REPLY"
[ "$(head -n 1 "$REVIEW_LOG" | tr -d '\r' | awk -F'\t' '{ print NF }')" = "11" ] && ok "L02b 表頭 11 欄" || bad "L02b 表頭 11 欄" "$(head -n 1 "$REVIEW_LOG")"
[ "$(col 10)" = "1" ] && ok "L02c rounds 欄＝1" || bad "L02c rounds 欄＝1" "$(last_log)"
[ "$(col 11)" = "normal" ] && ok "L02d risk 欄＝normal" || bad "L02d risk 欄＝normal" "$(last_log)"
flow ship l1 Feat "第一顆" >/dev/null 2>&1

# 舊版 9 欄表頭：就地升級，舊資料列原樣保留
{ printf 'recorded_at\trepo\tdiff_hash\tmode\tcodex\treviewer\texempt_reason\tqa\tallow_overrides\n'
  printf '2026-01-01 00:00:00\told\tabc\treview\tPASS\tPASS\t-\t-\t-\n'; } > "$REVIEW_LOG"
put l1 a.js "const b = 2;"
flow prepare l1 a.js >/dev/null 2>&1
expect "L03 舊表頭時 review-record 照常" 0 flow review-record l1 --codex "$PASS_REPLY" --reviewer "$PASS_REPLY"
[ "$(head -n 1 "$REVIEW_LOG" | tr -d '\r' | awk -F'\t' '{ print NF }')" = "11" ] && ok "L03b 舊表頭升級成 11 欄" || bad "L03b 舊表頭升級成 11 欄" "$(head -n 1 "$REVIEW_LOG")"
grep -q $'^2026-01-01 00:00:00\told\tabc' "$REVIEW_LOG" && ok "L03c 舊資料列保留" || bad "L03c 舊資料列保留"
flow ship l1 Feat "第二顆" >/dev/null 2>&1

# ================= 2. 前幾輪意見與增量 diff ＋ 3. 方案重想 =================
new_repo c1
put c1 a.js "const first = 1;"
flow prepare c1 a.js >/dev/null 2>&1
fake_reply c1 codex BLOCK "$BLOCK_REPLY"
fake_reply c1 reviewer PASS "$PASS_REPLY"
expect "C01 第 1 輪 BLOCK 記類別" 0 flow review-record c1 --codex "$BLOCK_REPLY" --reviewer "$PASS_REPLY" --block-classes "邊界漏判"
put c1 a.js "const second = 2;"
expect "C02 第 2 輪 prepare（未達重想門檻）" 0 flow prepare c1 a.js
has "C02b 印出第 2 輪重審段" "第 2 輪重審"
has "C02c 指出前幾輪意見檔" "staged-c1.prev-findings.md"
grep -qF "根因類別：邊界漏判" "$TMPD/staged-c1.prev-findings.md" 2>/dev/null && ok "C02d 前幾輪意見含根因類別" || bad "C02d 前幾輪意見含根因類別" "$(cat "$TMPD/staged-c1.prev-findings.md" 2>/dev/null)"
grep -qF "[一般] 邏輯錯" "$TMPD/staged-c1.prev-findings.md" 2>/dev/null && ok "C02e 前幾輪意見含 hook 抓到的 Codex 原文" || bad "C02e 前幾輪意見含 hook 抓到的 Codex 原文"
grep -qF "+const second = 2;" "$TMPD/staged-c1.incremental.diff" 2>/dev/null && ok "C02f 增量 diff 有這一輪新加的行" || bad "C02f 增量 diff 有這一輪新加的行" "$(cat "$TMPD/staged-c1.incremental.diff" 2>/dev/null)"
grep -qF "+const first" "$TMPD/staged-c1.incremental.diff" 2>/dev/null && bad "C02g 上一輪就加的行不算這一輪的新增" || ok "C02g 上一輪就加的行不算這一輪的新增"

fake_reply c1 codex BLOCK "$BLOCK_REPLY"
fake_reply c1 reviewer PASS "$PASS_REPLY"
flow review-record c1 --codex "$BLOCK_REPLY" --reviewer "$PASS_REPLY" --block-classes "訊息不清" >/dev/null 2>&1
put c1 a.js "const third = 3;"
expect "C03 第 3 輪沒帶 --rethink 被擋" 1 flow prepare c1 a.js
has "C03b 訊息說明要送第 3 輪" "要送第 3 輪審查了"
has "C03c 訊息列出前幾輪的根因類別" "第 1 輪：邊界漏判"
[ -z "$(git -C "$(R c1)" diff --cached --name-only -- a.js | xargs -r git -C "$(R c1)" diff --cached -- | grep -F 'third')" ] && ok "C03d 被擋時沒 git add" || bad "C03d 被擋時沒 git add"
expect "C04 --rethink 太短被擋" 1 flow prepare c1 a.js --rethink "無"
has "C04b 訊息說明太短" "收到的內容太短"
expect "C05 --rethink 寫清楚放行" 0 flow prepare c1 a.js --rethink "兩輪都在補邊界，做法本身是逐案列舉，改成放行清單一次涵蓋"
has "C05b 第 3 輪" "審查第 3 輪"
grep -qF "第 3 輪送審前的方案重想" "$TMPD/staged-c1.prev-findings.md" && ok "C05c 方案重想進前幾輪意見" || bad "C05c 方案重想進前幾輪意見"
grep -qF "第 2 輪" "$TMPD/staged-c1.prev-findings.md" && grep -qF "第 1 輪" "$TMPD/staged-c1.prev-findings.md" && ok "C05d 前幾輪意見累積兩輪" || bad "C05d 前幾輪意見累積兩輪"
[ "$(col 4)" = "rethink" ] && [ "$(col 10)" = "3" ] && ok "C05e review-log 記一列 rethink（第 3 輪）" || bad "C05e review-log 記一列 rethink（第 3 輪）" "$(last_log)"
expect "C06 同一輪 --redo 不必再寫重想" 0 flow prepare c1 a.js --redo
has "C06b 仍是第 3 輪" "審查第 3 輪"
rows_before="$(grep -c $'\trethink\t' "$REVIEW_LOG")"
expect "C06c 同一輪 --redo 又帶 --rethink" 0 flow prepare c1 a.js --redo --rethink "兩輪都在補邊界，做法本身是逐案列舉，改成放行清單一次涵蓋"
[ "$(grep -c '第 3 輪送審前的方案重想' "$TMPD/staged-c1.prev-findings.md")" = 1 ] && ok "C06d 方案重想不重複附加" || bad "C06d 方案重想不重複附加" "$(grep -c '第 3 輪送審前的方案重想' "$TMPD/staged-c1.prev-findings.md")"
[ "$(grep -c $'\trethink\t' "$REVIEW_LOG")" = "$rows_before" ] && ok "C06e review-log 不多記一列 rethink" || bad "C06e review-log 不多記一列 rethink"
# 上一輪的 tree 讀不到（被 gc）時 prepare 照常、只是沒有增量 diff
sd="$(state c1)"; awk -F'\t' -v OFS='\t' '$1 == 3 { $2 = "0123456789abcdef0123456789abcdef01234567" } { print }' "$sd/round-tree" > "$sd/round-tree.x" && mv "$sd/round-tree.x" "$sd/round-tree"
fake_reply c1 codex BLOCK "$BLOCK_REPLY"; fake_reply c1 reviewer PASS "$PASS_REPLY"
flow review-record c1 --codex "$BLOCK_REPLY" --reviewer "$PASS_REPLY" --block-classes "第三類" >/dev/null 2>&1
put c1 a.js "const fourth = 4;"
expect "C06f 上一輪 tree 讀不到時 prepare 照常" 0 flow prepare c1 a.js --rethink "前三輪是不同類別，做法本身沒問題，維持寫法逐類修完"
has "C06g 說明沒有增量 diff" "這一輪沒有增量 diff"
[ ! -e "$TMPD/staged-c1.incremental.diff" ] && ok "C06h 不留空的增量 diff" || bad "C06h 不留空的增量 diff"

# rethink_round=0 關閉
new_repo c2
printf 'rethink_round=0\n' > "$CLAUDE_PROJECT_DIR/.claude/git-commit.conf"
put c2 a.js "x1"; flow prepare c2 a.js >/dev/null 2>&1; flow review-record c2 --codex "$BLOCK_REPLY" --reviewer "$PASS_REPLY" --block-classes "類一" >/dev/null 2>&1
put c2 a.js "x2"; flow prepare c2 a.js >/dev/null 2>&1; flow review-record c2 --codex "$BLOCK_REPLY" --reviewer "$PASS_REPLY" --block-classes "類二" >/dev/null 2>&1
put c2 a.js "x3"
expect "C07 rethink_round=0 時第 3 輪不必重想" 0 flow prepare c2 a.js
printf 'rethink_round=1\n' > "$CLAUDE_PROJECT_DIR/.claude/git-commit.conf"
expect "C08 rethink_round=1 是設定錯誤" 1 flow prepare c2 a.js --redo
rm -f "$CLAUDE_PROJECT_DIR/.claude/git-commit.conf"

# ================= 4. 風險分級 =================
new_repo k1
setf k1 docs/readme.md "# title"; setf k1 src/i18n/zh.json $'{\n  "a": "一",\n  "b": "二"\n}'
setf k1 src/app.js $'// 說明\nconst v = 1;'; setf k1 src/App.cs $'#region x\nclass A {}\n#endregion'
setf k1 scripts/run.sh $'#!/bin/bash\n# 說明\necho hi'
setf k1 src/i18n/en.json $'{\n "s1": {\n  "title": "T",\n  "a": "x", "b": "y"\n },\n "s2": {\n  "k": "2"\n }\n}'
setf k1 conf/app.yml $'name: a\nurl: x'; setf k1 src/App.vue $'<template>\n<!-- 說明 -->\n<div/>\n</template>'
git -C "$(R k1)" add -A
# symlink 直接寫進 index（Windows 不一定能建 symlink），工作區放同內容的文字檔
setf k1 docs/link.md "readme.md"
LINK_SHA="$(printf %s readme.md | git -C "$(R k1)" hash-object -w --stdin)"
git -C "$(R k1)" update-index --add --cacheinfo "120000,$LINK_SHA,docs/link.md"
GIT_COMMIT_FLOW=1 git -C "$(R k1)" commit -q -m "Chore: base"

setf k1 docs/readme.md "# 新標題"
expect "K01 只改 .md" 0 flow prepare k1 docs/readme.md
has "K01b 低風險" "風險等級：低"
expect "K01c 低風險時 Codex 填 skipped: 低風險 收下" 0 flow review-record k1 --codex "skipped: 低風險" --reviewer "$PASS_REPLY"
[ "$(col 11)" = "low" ] && ok "K01d review-log risk 欄＝low" || bad "K01d review-log risk 欄＝low" "$(last_log)"
flow ship k1 Docs "改標題" >/dev/null 2>&1

setf k1 src/i18n/zh.json $'{\n  "a": "壹",\n  "b": "二"\n}'
expect "K02 i18n 只改值" 0 flow prepare k1 src/i18n/zh.json
has "K02b 低風險" "風險等級：低"
git -C "$(R k1)" restore --staged src/i18n/zh.json; git -C "$(R k1)" checkout -- src/i18n/zh.json
setf k1 src/i18n/zh.json $'{\n  "a": "一",\n  "b": "二",\n  "c": "三"\n}'
expect "K03 i18n 加鍵" 0 flow prepare k1 src/i18n/zh.json
has "K03b 一般風險" "風險等級：一般"
expect "K03c 一般風險時 skipped: 低風險 拒收" 1 flow review-record k1 --codex "skipped: 低風險" --reviewer "$PASS_REPLY"
has "K03d 訊息說明不是低風險" "不是低風險"
git -C "$(R k1)" restore --staged src/i18n/zh.json; git -C "$(R k1)" checkout -- src/i18n/zh.json

setf k1 src/app.js $'// 新的說明\nconst v = 1;'
expect "K04 .js 只改單行註解" 0 flow prepare k1 src/app.js
has "K04b 低風險" "風險等級：低"
git -C "$(R k1)" restore --staged src/app.js; git -C "$(R k1)" checkout -- src/app.js
setf k1 src/app.js $'// 說明\nconst v = 2;'
expect "K05 .js 改程式" 0 flow prepare k1 src/app.js
has "K05b 一般風險" "風險等級：一般"
git -C "$(R k1)" restore --staged src/app.js; git -C "$(R k1)" checkout -- src/app.js
setf k1 src/App.cs $'#region y\nclass A {}\n#endregion'
expect "K06 .cs 改 #region（# 在 C# 不算註解）" 0 flow prepare k1 src/App.cs
has "K06b 一般風險" "風險等級：一般"
git -C "$(R k1)" restore --staged src/App.cs; git -C "$(R k1)" checkout -- src/App.cs
setf k1 scripts/run.sh $'#!/bin/bash\n# 新說明\necho hi'
expect "K07 .sh 改 # 註解" 0 flow prepare k1 scripts/run.sh
has "K07b 低風險" "風險等級：低"
git -C "$(R k1)" restore --staged scripts/run.sh; git -C "$(R k1)" checkout -- scripts/run.sh
# 低風險判定的範圍：整行只能是一組「鍵: 單一值」、鍵在同一段改動內比對、註解寫法依副檔名認、只改權限不算
low_case() {  # low_case <名稱> <期望等級字樣> <檔> <新內容>
  setf k1 "$3" "$4"
  expect "$1" 0 flow prepare k1 "$3"
  has "$1b $2" "風險等級：$2"
  git -C "$(R k1)" restore --staged "$3"; git -C "$(R k1)" checkout -- "$3"
}
low_case "K11 i18n 同一行改第二個鍵名" 一般 src/i18n/en.json $'{\n "s1": {\n  "title": "T",\n  "a": "x", "c": "y"\n },\n "s2": {\n  "k": "2"\n }\n}'
low_case "K12 i18n 值後面接結構" 一般 src/i18n/zh.json $'{\n  "a": "一" }, "z": {\n  "b": "二"\n}'
low_case "K13 i18n 同名鍵搬到別的區段" 一般 src/i18n/en.json $'{\n "s1": {\n  "a": "x", "b": "y"\n },\n "s2": {\n  "title": "T",\n  "k": "2"\n }\n}'
low_case "K14 i18n 兩個區段各改一個值" 低 src/i18n/en.json $'{\n "s1": {\n  "title": "T2",\n  "a": "x", "b": "y"\n },\n "s2": {\n  "k": "3"\n }\n}'
low_case "K15 .yml 以 // 開頭的行是資料不是註解" 一般 conf/app.yml $'name: a\n// x'
low_case "K16 .vue 改 <!-- --> 註解" 低 src/App.vue $'<template>\n<!-- 新說明 -->\n<div/>\n</template>'
low_case "K17 .vue 註解後面接標籤" 一般 src/App.vue $'<template>\n<!-- 說明 --><span/>\n<div/>\n</template>'
git -C "$(R k1)" update-index --chmod=+x scripts/run.sh
expect "K18 只改檔案權限" 0 flow prepare k1 --staged
has "K18b 一般風險" "風險等級：一般"
git -C "$(R k1)" update-index --chmod=-x scripts/run.sh
# i18n 改用解析比對：壞掉的 JSON、葉節點換型別
low_case "K19 i18n 非法數字 1e" 一般 src/i18n/zh.json $'{\n  "a": 1e,\n  "b": "二"\n}'
low_case "K20 i18n 非法數字 1..2" 一般 src/i18n/zh.json $'{\n  "a": 1..2,\n  "b": "二"\n}'
low_case "K21 i18n 非法跳脫" 一般 src/i18n/zh.json $'{\n  "a": "x\\q",\n  "b": "二"\n}'
low_case "K22 i18n 拿掉中間的逗號" 一般 src/i18n/zh.json $'{\n  "a": "壹"\n  "b": "二"\n}'
low_case "K23 i18n 最後一個值後面多一個逗號" 一般 src/i18n/zh.json $'{\n  "a": "一",\n  "b": "貳",\n}'
low_case "K24 i18n 字串值改成數字" 低 src/i18n/zh.json $'{\n  "a": 1,\n  "b": "二"\n}'
low_case "K25 i18n 值改成物件" 一般 src/i18n/zh.json $'{\n  "a": {"x": "一"},\n  "b": "二"\n}'
# .md 也只認修改：新增、刪除算一般
setf k1 docs/new.md "# 新文件"
expect "K26 新增 .md" 0 flow prepare k1 docs/new.md
has "K26b 一般風險" "風險等級：一般"
git -C "$(R k1)" restore --staged docs/new.md; rm -f "$(R k1)/docs/new.md"
rm -f "$(R k1)/docs/readme.md"
expect "K27 刪除 .md" 0 flow prepare k1 docs/readme.md
has "K27b 一般風險" "風險等級：一般"
git -C "$(R k1)" restore --staged docs/readme.md; git -C "$(R k1)" checkout -- docs/readme.md
# symlink 改指向：內容是路徑文字，git 照樣算修改（M），不能當成 .md 內容修改
NEW_LINK_SHA="$(printf %s other.md | git -C "$(R k1)" hash-object -w --stdin)"
git -C "$(R k1)" update-index --cacheinfo "120000,$NEW_LINK_SHA,docs/link.md"
expect "K28 .md symlink 改指向" 0 flow prepare k1 --staged
has "K28b 一般風險" "風險等級：一般"
git -C "$(R k1)" update-index --cacheinfo "120000,$LINK_SHA,docs/link.md"

printf 'high_risk_paths=*Auth*Controller.cs *.sql\n' > "$CLAUDE_PROJECT_DIR/.claude/git-commit.conf"
# 樣式不能被 shell 展開成當下目錄的檔名：在工作目錄放一個會被 *.sql 命中的檔
touch "$CLAUDE_PROJECT_DIR/decoy.sql"
setf k1 src/Api/FooAuthController.cs "class FooAuthController {}"
expect "K08 命中高風險路徑" 0 flow prepare k1 src/Api/FooAuthController.cs
has "K08b 高風險並列出命中的檔" "命中 high_risk_paths：src/Api/FooAuthController.cs"
has "K08c 沒有高風險附加要求檔時提醒派工寫明" "C 軌派工時寫明這次碰到哪些高風險路徑"
printf '必讀 FLOWS.md，逐條對照架構鐵則\n' > "$CLAUDE_PROJECT_DIR/.claude/git-commit-reviewer-addendum-high.md"
expect "K09 有高風險附加要求檔" 0 flow prepare k1 src/Api/FooAuthController.cs --redo
has "K09b 印出高風險附加要求原文" "必讀 FLOWS.md，逐條對照架構鐵則"
git -C "$(R k1)" restore --staged src/Api/FooAuthController.cs; rm -f "$(R k1)/src/Api/FooAuthController.cs"
setf k1 src/app.js $'// 說明\nconst v = 3;'
expect "K10 沒命中高風險路徑（decoy.sql 不影響比對）" 0 flow prepare k1 src/app.js
has "K10b 一般風險" "風險等級：一般"
hasnt "K10c 沒有高風險段" "風險等級：高"
rm -f "$CLAUDE_PROJECT_DIR/.claude/git-commit.conf" "$CLAUDE_PROJECT_DIR/decoy.sql"

echo ""
echo "合計 PASS $pass / FAIL $fail"
[ "$fail" -eq 0 ] || { printf '  - %s\n' "${failed[@]}"; }
rm -rf "$ROOT"
exit "$fail"
