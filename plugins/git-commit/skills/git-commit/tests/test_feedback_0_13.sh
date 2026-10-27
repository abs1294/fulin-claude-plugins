#!/usr/bin/env bash
# 0.13.0 使用回饋（2026-10-16）各項的實跑測試。用法：bash test_feedback_0_13.sh <flow.sh 路徑>
# 涵蓋：新分支 push -u、check-msg、敏感字誤判、內容閘提前到 prepare（含 --allow-* 沿用）、
#       --body、專案設定檔（types／none／max_width）、審查輪數與極端情境預設豁免、狀態檔跟呼叫方式無關。
set -u
FLOW="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
ROOT="$(mktemp -d)"
export CLAUDE_PROJECT_DIR="$ROOT/ws"
mkdir -p "$CLAUDE_PROJECT_DIR"
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
subject() { git -C "$(R "$1")" log -1 --format=%s; }
state() { echo "$(git -C "$(R "$1")" rev-parse --absolute-git-dir)/git-commit-flow/$2"; }
PASS_REPLY=$'VERDICT: PASS\n- a.txt:1 觀察點'
BLOCK_REPLY=$'VERDICT: BLOCK\n- a.txt:1 動畫 0.1 秒內按 Esc 關不掉'
rec_pass() { flow review-record "$1" --codex "$PASS_REPLY" --reviewer "$PASS_REPLY" >/dev/null 2>&1; }
# 審查單與 hook（2026-10-19）：登記處放測試目錄；Windows 上 node 讀不懂 /tmp 開頭的路徑，一律轉成 C:/ 形式
winp() { cygpath -m "$1" 2>/dev/null || printf '%s' "$1"; }
export GIT_COMMIT_TICKET_DIR="$(winp "$ROOT/tickets")"
HOOK="$(cd "$(dirname "$FLOW")/../../hooks" && pwd)/capture-review-reply.js"
EDGE_RULING=$'- a.txt:1 [極端] 動畫 0.1 秒內按 Esc\n\nRULING: EDGE'
GENERAL_RULING=$'RULING: GENERAL\n- a.txt:1 [一般] 正常操作就會壞'
ticket() { sed -n 1p "$(state "$1" ticket)" 2>/dev/null | tr -d '\r' | sed 's/^id=//'; }
# capture_raw <派工內容> <回覆> <agent_type> [no-last]：模擬 SubagentStop 呼叫 hook（no-last＝payload 不帶 last_assistant_message）
capture_raw() {
  local tr; tr="$ROOT/tr-$RANDOM$RANDOM.jsonl"
  CAP_PROMPT="$1" CAP_REPLY="$2" CAP_AT="$3" CAP_TR="$(winp "$tr")" CAP_NOLAST="${4:-}" node -e '
const fs=require("fs"); const e=process.env;
fs.writeFileSync(e.CAP_TR, JSON.stringify({type:"user",message:{role:"user",content:e.CAP_PROMPT}})+"\n"
  +JSON.stringify({type:"assistant",message:{role:"assistant",content:[{type:"text",text:e.CAP_REPLY}]}})+"\n");
const p={hook_event_name:"SubagentStop",agent_type:e.CAP_AT,agent_transcript_path:e.CAP_TR};
if(!e.CAP_NOLAST) p.last_assistant_message=e.CAP_REPLY;
process.stdout.write(JSON.stringify(p));' | node "$HOOK"
}
# capture <repo> <軌> <回覆> [agent_type]：照 SKILL.md 範本，派工第一行是審查單
capture() {
  local at="${4:-}"
  [ -n "$at" ] || case "$2" in reviewer) at=general-purpose ;; *) at=codex:codex-rescue ;; esac
  capture_raw "[git-commit 審查單 $(ticket "$1") $2]（派工識別碼）"$'\n請審查 staged diff' "$3" "$at"
}
reply_of() { echo "$(state "$1" "reply-$(ticket "$1")-$2")"; }

# ================= 1. 新分支第一次 push =================
BARE="$ROOT/remote.git"; git init -q --bare "$BARE"
new_repo p1
git -C "$(R p1)" remote add origin "$BARE"
git -C "$(R p1)" push -q -u origin main
git -C "$(R p1)" checkout -q -b design/new-branch
put p1 a.txt one
flow prepare p1 a.txt >/dev/null; rec_pass p1
expect "P01 新分支沒有 upstream，ship --push 成功" 0 flow ship p1 Feat "新分支第一次推" --push
has "P01b 有說明改用 push -u" "改用 git push -u origin HEAD"
git -C "$BARE" rev-parse -q --verify refs/heads/design/new-branch >/dev/null && ok "P01c 遠端有這個分支" || bad "P01c 遠端有這個分支"
[ "$(git -C "$(R p1)" rev-parse --abbrev-ref '@{u}' 2>/dev/null)" = "origin/design/new-branch" ] && ok "P01d upstream 已設定" || bad "P01d upstream 已設定"

# 先 local commit、之後補推（push-only 分支）也要能推新分支
git -C "$(R p1)" checkout -q -b design/later
put p1 b.txt two
flow prepare p1 b.txt >/dev/null; rec_pass p1
flow ship p1 Feat "之後再推" >/dev/null 2>&1
expect "P02 補推新分支成功" 0 flow ship p1 Feat "之後再推" --push
git -C "$BARE" rev-parse -q --verify refs/heads/design/later >/dev/null && ok "P02b 遠端有補推的分支" || bad "P02b 遠端有補推的分支"

# 沒有任何 remote：commit 完成、push 失敗並講清楚
new_repo p2
put p2 a.txt one
flow prepare p2 a.txt >/dev/null; rec_pass p2
expect "P03 沒有 remote 時 push 失敗" 1 flow ship p2 Feat "沒有遠端" --push
has "P03b 錯誤訊息說明無法決定 remote" "無法決定推到哪個 remote"
[ "$(subject p2)" = "Feat: 沒有遠端" ] && ok "P03c commit 仍已完成" || bad "P03c commit 仍已完成" "$(subject p2)"

# 兩個 remote 都不叫 origin：不猜
new_repo p3
git -C "$(R p3)" remote add a "$BARE"; git -C "$(R p3)" remote add b "$BARE"
put p3 a.txt one
flow prepare p3 a.txt >/dev/null; rec_pass p3
expect "P04 多個 remote 且沒有 origin 不猜" 1 flow ship p3 Feat "兩個遠端" --push
git -C "$BARE" rev-parse -q --verify refs/heads/main >/dev/null; main_before=$?
# 只有一個 remote（不叫 origin）就用它
new_repo p4
B2="$ROOT/r2.git"; git init -q --bare "$B2"
git -C "$(R p4)" remote add upstream "$B2"
put p4 a.txt one
flow prepare p4 a.txt >/dev/null; rec_pass p4
expect "P05 唯一的 remote 不叫 origin 也推得上去" 0 flow ship p4 Feat "唯一遠端" --push
git -C "$B2" rev-parse -q --verify refs/heads/main >/dev/null && ok "P05b 推到那個 remote" || bad "P05b 推到那個 remote"

# ================= 2. check-msg =================
new_repo m1
expect "M01 正常訊息通過" 0 flow check-msg m1 Feat "新增匯出功能"
has "M01b 印出寬度" "描述寬度：12 / 72"
expect "M02 過長擋下" 1 flow check-msg m1 Feat "$(printf '一%.0s' {1..37})"
has "M02b 提示可用 max_width" "max_width="
expect "M03 痕跡擋下" 1 flow check-msg m1 Fix "經語法樹掃描確認全數在 try 內"
expect "M04 Type 不合法" 1 flow check-msg m1 minor "add x"
expect "M05 預設不允許 none" 1 flow check-msg m1 none "add x"
expect "M06 內文兩行通過" 0 flow check-msg m1 Feat "新增匯出" --body $'要等 ui-web 下一版才能建置。\n2.3.8 會建置失敗。'
expect "M07 內文署名擋下" 1 flow check-msg m1 Feat "新增匯出" --body "Co-Authored-By: Claude <noreply@anthropic.com>"
expect "M08 內文超過 3 行擋下" 1 flow check-msg m1 Feat "新增匯出" --body $'一\n二\n三\n四'
expect "M09 內文單行過寬擋下" 1 flow check-msg m1 Feat "新增匯出" --body "$(printf 'x%.0s' {1..73})"
expect "M10 內文痕跡擋下" 1 flow check-msg m1 Feat "新增匯出" --body "實測七則回應全部通過"
expect "M11 內文頭尾空行會剝掉" 0 flow check-msg m1 Feat "新增匯出" --body $'\n\n一句說明\n\n'
expect "M12 多給參數不收" 1 flow check-msg m1 Feat "新增" "多的"

# ================= 3. 敏感字誤判（React／JS 識別字）=================
new_repo s1
chk_sens() { # <名稱> <期望 exit> <內容>
  git -C "$(R s1)" reset -q --hard HEAD; rm -f "$(R s1)/c.jsx"
  printf '%s\n' "$3" > "$(R s1)/c.jsx"
  expect "$1" "$2" flow prepare s1 c.jsx
}
chk_sens "S01 JSX userId={id} 不擋" 0 '<Avatar userId={member.id} />'
chk_sens "S02 JSX accessToken={t} 不擋" 0 '<Chat accessToken={token} />'
chk_sens "S03 JSX newPwd={x} 不擋" 0 '<Field newPwd={value} />'
chk_sens "S04 JS 指定 const userId = 5; 不擋" 0 'const userId = 5;'
chk_sens "S05 JSX userId=\"abc\" 不擋" 0 '<Avatar userId="abc" />'
chk_sens "S06 URL 樣板 ?userId=\${id} 不擋" 0 'fetch(`/api?userId=${id}&x=1`)'
chk_sens "S07 連線字串 User Id=sa; 擋" 1 'const cs = "Server=.;User Id=sa;Database=x";'
chk_sens "S08 連線字串 UserId=sa; 擋" 1 'const cs = "Server=.;UserId=sa;Database=x";'
chk_sens "S09 連線字串 Pwd=abc 結尾 擋" 1 'const cs = "Server=.;Uid=sa;Pwd=abc";'
chk_sens "S10 ?token=abc 擋" 1 'fetch("/api?token=abc123")'
chk_sens "S11 password 照擋" 1 'const password = "x";'
chk_sens "S12 ini 寫法 Pwd=abc 擋" 1 'Pwd=abc'
git -C "$(R s1)" reset -q --hard HEAD

# ================= 4. 內容閘提前到 prepare =================
new_repo g1
put g1 tests/helper.test.ts '// spin up the test harness before each case'
expect "G01 test harness 不算 AI 痕跡" 0 flow prepare g1 tests/helper.test.ts
git -C "$(R g1)" reset -q --hard HEAD
put g1 src/a.ts '// see .claude/harness/D-判斷力矩陣.md'
expect "G02 .claude/harness 路徑擋在 prepare" 1 flow prepare g1 src/a.ts
[ ! -f "$(state g1 staged.sha)" ] && ok "G02b 沒過就沒有 diff hash" || bad "G02b 沒過就沒有 diff hash"
expect "G02c 沒有 hash 就不能記錄" 1 flow review-record g1 --codex "$PASS_REPLY" --reviewer "$PASS_REPLY"
git -C "$(R g1)" reset -q --hard HEAD; rm -f "$(R g1)/src/a.ts"
put g1 src/b.ts '// 依 harness 規則處理'
expect "G03「harness 規則」照擋" 1 flow prepare g1 src/b.ts
git -C "$(R g1)" reset -q --hard HEAD; rm -f "$(R g1)/src/b.ts"
put g1 src/c.ts '// 對齊空值語意（見規格 §3.6.8）'
put g1 src/d.ts 'const password = "x";'
expect "G04 兩道閘同時命中" 1 flow prepare g1 src/c.ts src/d.ts
has "G04b 一次列出 AI 痕跡" "引用了外部文件出處"
has "G04c 一次列出敏感字" "命中敏感字"
expect "G05 prepare 帶 --allow-* 放行" 0 flow prepare g1 src/c.ts src/d.ts --allow-ai-trace --allow-sensitive
[ -f "$(state g1 prepare-allow)" ] && ok "G05b 放行旗標已記下" || bad "G05b 放行旗標已記下"
rec_pass g1
expect "G06 ship 不帶旗標也沿用 prepare 的放行" 0 flow ship g1 Fix "空值語意對齊"
[ ! -f "$(state g1 prepare-allow)" ] && ok "G06b commit 後放行旗標已清" || bad "G06b commit 後放行旗標已清"
# 重跑 prepare 不帶旗標：舊的放行作廢
put g1 src/c.ts '// 第二處（見 §4.1）'
flow prepare g1 src/c.ts --allow-ai-trace >/dev/null 2>&1
expect "G07 重跑 prepare 沒帶旗標就擋" 1 flow prepare g1 src/c.ts --redo
[ ! -f "$(state g1 prepare-allow)" ] && ok "G07b 舊放行旗標已作廢" || bad "G07b 舊放行旗標已作廢"
git -C "$(R g1)" reset -q --hard HEAD
put g1 tsconfig.tsbuildinfo '{}'
expect "G08 tsbuildinfo 擋在 prepare" 1 flow prepare g1 tsconfig.tsbuildinfo
git -C "$(R g1)" reset -q --hard HEAD; rm -f "$(R g1)/tsconfig.tsbuildinfo"
put g1 test-results/run.json '{}'
expect "G09 test-results/ 擋在 prepare" 1 flow prepare g1 test-results/run.json
git -C "$(R g1)" reset -q --hard HEAD; rm -rf "$(R g1)/test-results"

# ================= 5. --body =================
new_repo b1
put b1 a.txt one
flow prepare b1 a.txt >/dev/null; rec_pass b1
expect "B01 ship 帶兩行內文" 0 flow ship b1 Feat "新增匯出" --body $'要等 ui-web 下一版才能建置。\n2.3.8 會建置失敗。'
[ "$(git -C "$(R b1)" log -1 --format=%b | sed '/^$/d')" = $'要等 ui-web 下一版才能建置。\n2.3.8 會建置失敗。' ] && ok "B01b 內文原樣寫進 commit" || bad "B01b 內文原樣寫進 commit" "$(git -C "$(R b1)" log -1 --format=%B)"
[ "$(subject b1)" = "Feat: 新增匯出" ] && ok "B01c subject 不受影響" || bad "B01c subject 不受影響"
expect "B02 audit 不再把 3 行內的內文當問題" 0 flow audit b1 -1
# audit 與 ship 同一算法：內文中間的空白行也算一行
new_repo b9
put b9 a.txt one
git -C "$(R b9)" add a.txt && GIT_COMMIT_FLOW=1 git -C "$(R b9)" commit -q -m $'Fix: 測試\n\n第一行\n\n第二行\n第三行'
LAST_OUT="$(flow audit b9 -1 2>&1)"; has "B02b audit 把內文中的空白行算進行數" "內文 4 行"
put b9 a.txt two
git -C "$(R b9)" add a.txt && GIT_COMMIT_FLOW=1 git -C "$(R b9)" commit -q -m $'Fix: 測試二\n\n見 claude.ai/code'
LAST_OUT="$(flow audit b9 -1 2>&1)"; has "B02c audit 用 ship 同一套署名判準" "含 AI 署名"
put b1 a.txt two
flow prepare b1 a.txt >/dev/null; rec_pass b1
expect "B03 ship 內文署名擋下" 1 flow ship b1 Feat "再改" --body "Generated with Claude Code"
expect "B04 amend --body 沒給 --type/--desc 不收" 1 flow amend b1 --confirm-rewrite --body "x"

# ================= 6. 專案設定檔 =================
new_repo c1
mkdir -p "$(R c1)/.claude"
printf 'types=major minor patch none\nmax_width=100   # 英文訊息\n' > "$(R c1)/.claude/git-commit.conf"
git -C "$(R c1)" add .claude/git-commit.conf; GIT_COMMIT_FLOW=1 git -C "$(R c1)" commit -q -m "Chore: conf"
put c1 a.txt one
flow prepare c1 a.txt >/dev/null; rec_pass c1
LONG_EN="add chat profile, portfolio chapters and chat heads for organisation portal"
expect "C01 none＋75 字元英文（max_width=100）可 ship" 0 flow ship c1 none "$LONG_EN"
[ "$(subject c1)" = "$LONG_EN" ] && ok "C01b none 的 subject 沒有前綴" || bad "C01b none 的 subject 沒有前綴" "$(subject c1)"
put c1 a.txt two
flow prepare c1 a.txt >/dev/null; rec_pass c1
expect "C02 minor 前綴" 0 flow ship c1 minor "add sender click"
[ "$(subject c1)" = "minor: add sender click" ] && ok "C02b subject 為 minor: …" || bad "C02b subject 為 minor: …"
expect "C03 設定檔沒列的 Feat 不收" 1 flow check-msg c1 Feat "x"
has "C03b 錯誤訊息指出設定檔" "git-commit.conf 的 types="
expect "C04 沒有設定檔的 repo 75 字元仍擋（預設 72）" 1 flow check-msg m1 Feat "$LONG_EN"
expect "C05 audit 認得 none（無前綴不算問題）" 0 flow audit c1 -2
# 沿用既有 message 的 amend：none 格式也要能沿用
expect "C06 amend 沿用 minor: 訊息" 0 flow amend c1 --confirm-rewrite
git -C "$(R c1)" reset -q --hard HEAD~1
expect "C07 amend 沿用無前綴訊息" 0 flow amend c1 --confirm-rewrite
# 設定檔寫錯要擋，不靜默套預設
new_repo c2; mkdir -p "$(R c2)/.claude"
printf 'max_width=abc\n' > "$(R c2)/.claude/git-commit.conf"
expect "C08 max_width 不是整數就擋" 1 flow check-msg c2 Feat "x"
printf 'types=\n' > "$(R c2)/.claude/git-commit.conf"
expect "C09 types 空的就擋" 1 flow check-msg c2 Feat "x"
printf '\xef\xbb\xbftypes=Feat none\r\n' > "$(R c2)/.claude/git-commit.conf"
expect "C10 BOM＋CRLF 的設定檔讀得懂" 0 flow check-msg c2 none "plain"
# 工作目錄層的設定檔也找得到（repo 自己沒有時）
mkdir -p "$CLAUDE_PROJECT_DIR/.claude"
printf 'max_width=100\n' > "$CLAUDE_PROJECT_DIR/.claude/git-commit.conf"
expect "C11 工作目錄層設定檔生效" 0 flow check-msg m1 Feat "$LONG_EN"
rm -f "$CLAUDE_PROJECT_DIR/.claude/git-commit.conf"

# ================= 7. 審查輪數與極端情境 =================
new_repo e1
put e1 a.txt r1
expect "E01 prepare 印第 1 輪" 0 flow prepare e1 a.txt
has "E01b 第 1 輪" "審查第 1 輪"
has "E01c 印出審查單" "[git-commit 審查單 gcf-"
expect "E02 沒有 Codex 仲裁結果不收 --edge" 1 flow review-record e1 --codex "$BLOCK_REPLY" --reviewer "$PASS_REPLY" --edge "動畫 0.1 秒內按 Esc"
has "E02b 說明要派仲裁" "沒有這一輪的 Codex 仲裁結果"
[ ! -f "$(state e1 review.rec)" ] && ok "E02c 沒寫審查紀錄" || bad "E02c 沒寫審查紀錄"
capture e1 arbiter "$GENERAL_RULING"
expect "E03 仲裁判 GENERAL 不收 --edge" 1 flow review-record e1 --codex "$BLOCK_REPLY" --reviewer "$PASS_REPLY" --edge "動畫 0.1 秒內按 Esc"
has "E03b 說明仲裁判一般問題" "RULING: GENERAL"
flow review-record e1 --codex "$BLOCK_REPLY" --reviewer "$PASS_REPLY" --block-classes "一般問題" >/dev/null
put e1 a.txt r2; flow prepare e1 a.txt >/dev/null
flow review-record e1 --codex "$BLOCK_REPLY" --reviewer "$PASS_REPLY" --block-classes "另一類" >/dev/null
put e1 a.txt r3
# 0.15.0 起第 3 輪要先寫方案重想（test_review_convergence_0_15.sh 測閘本身）
expect "E04 改碼後 prepare 第 3 輪並提示" 0 flow prepare e1 a.txt --rethink "兩輪是不同類別，做法本身沒問題，維持現在的寫法逐類修"
has "E04b 印出第 3 輪門檻提示" "已到第 3 輪"
has "E04c 預設不停下來問，修到只剩極端情境" "不要停下來問使用者"
capture e1 arbiter "$EDGE_RULING"
expect "E05 仲裁判 EDGE：這一輪就預設豁免（不再數連續輪數）" 0 flow review-record e1 --codex "$BLOCK_REPLY" --reviewer "$PASS_REPLY" --edge "只在開發模式發生"
has "E05b 提醒預覽要講明" "預設豁免"
grep -q $'\tedge-exempt\tBLOCK\tPASS\t只在開發模式發生' "$CLAUDE_PROJECT_DIR/.claude/.git-commit-tmp/review-log.tsv" && ok "E05c 流水帳記成 edge-exempt" || bad "E05c 流水帳記成 edge-exempt" "$(tail -1 "$CLAUDE_PROJECT_DIR/.claude/.git-commit-tmp/review-log.tsv")"
grep -q '^captured=codex:- reviewer:- arbiter:EDGE$' "$(state e1 review.rec)" && ok "E05d 紀錄寫明仲裁結果" || bad "E05d 紀錄寫明仲裁結果" "$(grep captured "$(state e1 review.rec)")"
expect "E06 預設豁免的紀錄可以 ship" 0 flow ship e1 Fix "Esc 判斷補上關閉中狀態"
[ ! -f "$(state e1 round)" ] && [ ! -f "$(state e1 edge-rounds)" ] && ok "E06b commit 後輪數歸零" || bad "E06b commit 後輪數歸零"
[ ! -f "$(state e1 ticket)" ] && [ -z "$(ls "$(state e1 '')" | grep '^reply-')" ] && ok "E06e commit 後審查單與抓到的回覆清掉" || bad "E06e commit 後審查單與抓到的回覆清掉" "$(ls "$(state e1 '')")"
put e1 a.txt next
flow prepare e1 a.txt >/dev/null 2>&1
LAST_OUT="$(flow prepare e1 a.txt --redo 2>&1)"; has "E06c --redo 重新準備不加輪數" "審查第 1 輪"
grep -q $'\tredo\t' "$CLAUDE_PROJECT_DIR/.claude/.git-commit-tmp/review-log.tsv" && ok "E06d --redo 寫進流水帳" || bad "E06d --redo 寫進流水帳"
# 上一張審查單的仲裁結果，重新 prepare 之後不算
new_repo e2
put e2 a.txt 1; flow prepare e2 a.txt >/dev/null
capture e2 arbiter "$EDGE_RULING"
flow review-record e2 --codex "$BLOCK_REPLY" --reviewer "$PASS_REPLY" --block-classes "一般問題" >/dev/null
put e2 a.txt 2; flow prepare e2 a.txt >/dev/null
expect "E07 上一輪的仲裁結果不能用在這一輪" 1 flow review-record e2 --codex "$BLOCK_REPLY" --reviewer "$PASS_REPLY" --edge "y"
has "E07b 說明要派這一輪的仲裁" "沒有這一輪的 Codex 仲裁結果"
# 輸入檢查
capture e2 arbiter "$EDGE_RULING"
expect "E08 兩軌都 BLOCK、仲裁判 EDGE 也收" 0 flow review-record e2 --codex "$BLOCK_REPLY" --reviewer "$BLOCK_REPLY" --edge "z"
expect "E09 兩軌都 PASS 不收 --edge" 1 flow review-record e2 --codex "$PASS_REPLY" --reviewer "$PASS_REPLY" --edge "z"
expect "E10 skipped＋BLOCK 不收 --edge" 1 flow review-record e2 --codex "$BLOCK_REPLY" --reviewer "skipped: code-reviewer 與 general-purpose 第三層皆失敗" --edge "z"
expect "E11 --edge 空理由不收" 1 flow review-record e2 --codex "$BLOCK_REPLY" --reviewer "$PASS_REPLY" --edge "  "
expect "E12 --edge 與 --exempt 不能並用" 1 flow review-record e2 --exempt "x" --edge "y"
expect "E13 C 軌 BLOCK、Codex PASS 也收" 0 flow review-record e2 --codex "$PASS_REPLY" --reviewer "$BLOCK_REPLY" --edge "C 軌的極端情境"
# 設定檔關閉預設豁免
new_repo e3; mkdir -p "$(R e3)/.claude"
printf 'edge_auto_exempt_rounds=0\nreview_ask_round=2\n' > "$(R e3)/.claude/git-commit.conf"
put e3 a.txt 1; flow prepare e3 a.txt >/dev/null
capture e3 arbiter "$EDGE_RULING"
expect "E15 edge_auto_exempt_rounds=0 時仲裁判 EDGE 也不放行" 1 flow review-record e3 --codex "$BLOCK_REPLY" --reviewer "$PASS_REPLY" --edge "y"
has "E15b 說明設定為 0" "edge_auto_exempt_rounds=0"
[ ! -f "$(state e3 review.rec)" ] && ok "E15c 沒寫審查紀錄" || bad "E15c 沒寫審查紀錄"
put e3 a.txt 2
expect "E14 review_ask_round=2 在第 2 輪提示（上一輪已記下、可開下一輪）" 0 flow prepare e3 a.txt
has "E14b 第 2 輪提示" "已到第 2 輪"
# 同類重複閘：上一輪沒記結果不能開下一輪；同類別在同一批第二次出現要附架構改法
new_repo e4
put e4 a.txt 1; flow prepare e4 a.txt >/dev/null
put e4 a.txt 2
expect "E16 上一輪沒記結果就重送：擋" 1 flow prepare e4 a.txt
has "E16b 說明要先 review-record" "還沒用 review-record 記下結果"
git -C "$(R e4)" diff --cached | grep -q '^+2$' && bad "E16c 被擋時不 git add" || ok "E16c 被擋時不 git add"
expect "E16d 還沒送審就重送用 --redo 放行" 0 flow prepare e4 a.txt --redo
expect "E17 記 BLOCK 類別" 0 flow review-record e4 --codex "$BLOCK_REPLY" --reviewer "$PASS_REPLY" --block-classes "敏感字漏抓-設定讀取;誤擋-色碼"
has "E17b 印出記下的類別" "誤擋-色碼"
[ ! -f "$(state e4 review.rec)" ] && ok "E17c 不寫審查紀錄（不放行 commit）" || bad "E17c 不寫審查紀錄（不放行 commit）"
put e4 a.txt 3
expect "E18 記過結果可開下一輪" 0 flow prepare e4 a.txt
expect "E19 同類別第二次出現：擋" 1 flow review-record e4 --codex "$BLOCK_REPLY" --reviewer "$PASS_REPLY" --block-classes "敏感字漏抓-設定讀取；新類別"
has "E19b 點名重複的類別與輪次" "「敏感字漏抓-設定讀取」（第 1 輪出現過）"
has "E19c 要求改架構或走 --edge" "--rearchitect"
expect "E19d 新類別、沒重複：收" 0 flow review-record e4 --codex "$BLOCK_REPLY" --reviewer "$BLOCK_REPLY" --block-classes "新類別"
put e4 a.txt 4
flow prepare e4 a.txt >/dev/null
expect "E20 附架構改法：收" 0 flow review-record e4 --codex "$BLOCK_REPLY" --reviewer "$PASS_REPLY" --block-classes "敏感字漏抓-設定讀取" --rearchitect "敏感字漏抓-設定讀取：改成涵蓋矩陣一次列完"
expect "E21 兩軌 PASS 不收 --block-classes" 1 flow review-record e4 --codex "$PASS_REPLY" --reviewer "$PASS_REPLY" --block-classes "x"
expect "E22 --block-classes 空白不收" 1 flow review-record e4 --codex "$BLOCK_REPLY" --reviewer "$PASS_REPLY" --block-classes " ; "
expect "E23 --rearchitect 單獨用不收" 1 flow review-record e4 --codex "$PASS_REPLY" --reviewer "$PASS_REPLY" --rearchitect "x"
expect "E24 --block-classes 與 --edge 不能並用" 1 flow review-record e4 --codex "$BLOCK_REPLY" --reviewer "$PASS_REPLY" --block-classes "x" --edge "y"
put e4 a.txt 5
flow prepare e4 a.txt >/dev/null
expect "E25 修完兩軌 PASS 照常記錄" 0 flow review-record e4 --codex "$PASS_REPLY" --reviewer "$PASS_REPLY"
expect "E25b ship 成功" 0 flow ship e4 Fix "同類閘測試"
[ ! -f "$(state e4 block-classes)" ] && [ ! -f "$(state e4 recorded-round)" ] && ok "E25c commit 後類別紀錄歸零" || bad "E25c commit 後類別紀錄歸零"
new_repo e6
put e6 a.txt 1; flow prepare e6 a.txt >/dev/null
git -C "$(R e6)" restore --staged a.txt; put e6 b.txt 1; git -C "$(R e6)" add b.txt
expect "E26 上一批放棄、改 stage 別的檔：--staged 不被擋" 0 flow prepare e6 --staged
has "E26b 換批從第 1 輪算" "審查第 1 輪"
expect "E27 新一批第 1 輪沒記結果：同一批再 prepare 照擋" 1 flow prepare e6 --staged
# 同一份 diff 先記 PASS、後記 BLOCK：舊 PASS 紀錄作廢，不能 ship
expect "E28 先記兩軌 PASS" 0 flow review-record e6 --codex "$PASS_REPLY" --reviewer "$PASS_REPLY"
expect "E28b 同一份 diff 再記 BLOCK 類別" 0 flow review-record e6 --codex "$BLOCK_REPLY" --reviewer "$PASS_REPLY" --block-classes "一般問題"
[ ! -f "$(state e6 review.rec)" ] && ok "E28c 舊 PASS 紀錄已作廢" || bad "E28c 舊 PASS 紀錄已作廢"
expect "E28d ship 被擋" 1 flow ship e6 Fix "不該放行"
expect "E29 再記 PASS 後改記未達門檻的 --edge" 0 flow review-record e6 --codex "$PASS_REPLY" --reviewer "$PASS_REPLY"
expect "E29b --edge 沒有仲裁結果拒收" 1 flow review-record e6 --codex "$BLOCK_REPLY" --reviewer "$PASS_REPLY" --edge "x"
[ ! -f "$(state e6 review.rec)" ] && ok "E29c 舊 PASS 紀錄已作廢" || bad "E29c 舊 PASS 紀錄已作廢"
# 收到 BLOCK 但 review-record 因錯誤離開：舊 PASS 一樣作廢（入口統一處理）
expect "E31 先記兩軌 PASS" 0 flow review-record e6 --codex "$PASS_REPLY" --reviewer "$PASS_REPLY"
expect "E31b 一般模式收到 BLOCK：拒收" 1 flow review-record e6 --codex "$PASS_REPLY" --reviewer "$BLOCK_REPLY"
[ ! -f "$(state e6 review.rec)" ] && ok "E31c 舊 PASS 紀錄已作廢" || bad "E31c 舊 PASS 紀錄已作廢"
expect "E31d ship 被擋" 1 flow ship e6 Fix "不該放行"
expect "E32 再記兩軌 PASS" 0 flow review-record e6 --codex "$PASS_REPLY" --reviewer "$PASS_REPLY"
expect "E32b --block-classes 類別空白拒收" 1 flow review-record e6 --codex "$BLOCK_REPLY" --reviewer "$PASS_REPLY" --block-classes " ; "
[ ! -f "$(state e6 review.rec)" ] && ok "E32c 舊 PASS 紀錄已作廢" || bad "E32c 舊 PASS 紀錄已作廢"
expect "E33 再記兩軌 PASS" 0 flow review-record e6 --codex "$PASS_REPLY" --reviewer "$PASS_REPLY"
mkdir -p "$(R e6)/.claude"; printf 'max_width=abc\n' > "$(R e6)/.claude/git-commit.conf"
expect "E33b 設定檔寫錯：review-record 報錯離開" 1 flow review-record e6 --codex "$BLOCK_REPLY" --reviewer "$PASS_REPLY" --block-classes "一般問題"
rm -f "$(R e6)/.claude/git-commit.conf"
[ ! -f "$(state e6 review.rec)" ] && ok "E33c 設定檔錯誤離開前也已作廢舊 PASS" || bad "E33c 設定檔錯誤離開前也已作廢舊 PASS"
expect "E34 再記兩軌 PASS" 0 flow review-record e6 --codex "$PASS_REPLY" --reviewer "$PASS_REPLY"
expect "E34b 旗標缺值報錯離開" 1 flow review-record e6 --codex "$PASS_REPLY" --reviewer "$BLOCK_REPLY" --block-classes
[ ! -f "$(state e6 review.rec)" ] && ok "E34c 旗標缺值離開前也已作廢舊 PASS" || bad "E34c 旗標缺值離開前也已作廢舊 PASS"
flow review-record e6 --codex "$PASS_REPLY" --reviewer "$PASS_REPLY" >/dev/null 2>&1
expect "E35 --allow-overrides 空字串報錯離開" 1 flow review-record e6 --codex "$PASS_REPLY" --reviewer "$BLOCK_REPLY" --block-classes "x" --allow-overrides ""
[ ! -f "$(state e6 review.rec)" ] && ok "E35b 已作廢舊 PASS" || bad "E35b 已作廢舊 PASS"
flow review-record e6 --codex "$PASS_REPLY" --reviewer "$PASS_REPLY" >/dev/null 2>&1
expect "E36 Markdown 包住的 **VERDICT: BLOCK** 拒收" 1 flow review-record e6 --codex "$PASS_REPLY" --reviewer $'**VERDICT: BLOCK**\n- x'
[ ! -f "$(state e6 review.rec)" ] && ok "E36b Markdown 包住的 BLOCK 也作廢舊 PASS" || bad "E36b Markdown 包住的 BLOCK 也作廢舊 PASS"
flow review-record e6 --codex "$PASS_REPLY" --reviewer "$PASS_REPLY" >/dev/null 2>&1
expect "E37 中間的旗標缺值（--edge 沒寫說明）報錯離開" 1 flow review-record e6 --edge --codex "$BLOCK_REPLY" --reviewer "$PASS_REPLY"
[ ! -f "$(state e6 review.rec)" ] && ok "E37b 旗標錯位時 BLOCK 照樣作廢舊 PASS" || bad "E37b 旗標錯位時 BLOCK 照樣作廢舊 PASS"
flow review-record e6 --codex "$PASS_REPLY" --reviewer "$PASS_REPLY" >/dev/null 2>&1
expect "E38 旗標名打錯（--reveiwer）報錯離開" 1 flow review-record e6 --codex "$PASS_REPLY" --reveiwer "$BLOCK_REPLY"
[ ! -f "$(state e6 review.rec)" ] && ok "E38b 旗標名打錯時 BLOCK 照樣作廢舊 PASS" || bad "E38b 旗標名打錯時 BLOCK 照樣作廢舊 PASS"
expect "E39 兩軌 PASS 照常記錄（沒有 BLOCK 不刪）" 0 flow review-record e6 --codex "$PASS_REPLY" --reviewer "$PASS_REPLY"
[ -f "$(state e6 review.rec)" ] && ok "E39b PASS 紀錄留著" || bad "E39b PASS 紀錄留著"
# 上一輪已記過結果：下一次 prepare 是新的一輪，帶 --redo 也加一（--redo 只在上一輪還沒記時不加輪數）
put e6 b.txt 2
LAST_OUT="$(flow prepare e6 --staged --redo 2>&1)"; has "E40 已記過結果後 --redo 仍進下一輪" "審查第 2 輪"
# 只 unstage 一部分再列回同一批：閘與歸零用同一個結論，照擋、輪數不加
new_repo e7
put e7 a.txt a1; put e7 b.txt b1; flow prepare e7 a.txt b.txt >/dev/null
put e7 a.txt a2
git -C "$(R e7)" restore --staged b.txt
expect "E30 unstage 一部分再列回同一批：上一輪沒記照擋" 1 flow prepare e7 a.txt b.txt
has "E30b 說明要先 review-record" "還沒用 review-record 記下結果"
[ "$(tr -dc '0-9' < "$(state e7 round)")" = 1 ] && ok "E30c 輪數仍是 1" || bad "E30c 輪數仍是 1"

# ================= 8. 狀態檔跟呼叫方式無關 =================
# 不設 CLAUDE_PROJECT_DIR：先在上層用子目錄名記豁免，再 cd 進去用 . ship
W="$ROOT/ws8"; mkdir -p "$W"
( export CLAUDE_PROJECT_DIR="$W"; new_repo sub )
put_w() { printf '%s\n' "$2" >> "$W/sub/$1"; }
put_w a.md "# doc"
out="$(cd "$W" && env -u CLAUDE_PROJECT_DIR bash "$FLOW" prepare sub a.md 2>&1)" || bad "X01 上層 prepare sub" "$out"
out="$(cd "$W" && env -u CLAUDE_PROJECT_DIR bash "$FLOW" review-record sub --exempt "Docs：純文件" 2>&1)" && ok "X01 上層用子目錄名記豁免" || bad "X01 上層用子目錄名記豁免" "$out"
LAST_OUT="$(cd "$W/sub" && env -u CLAUDE_PROJECT_DIR bash "$FLOW" ship . Docs "補文件" 2>&1)"; rc=$?
[ "$rc" -eq 0 ] && ok "X02 cd 進 repo 用 . 找得到同一份紀錄並 ship" || bad "X02 cd 進 repo 用 . 找得到同一份紀錄並 ship" "$(printf '%s' "$LAST_OUT" | tail -4 | tr '\n' '|')"
[ ! -d "$W/sub/.claude/.git-commit-tmp" ] || [ -z "$(ls "$W/sub/.claude/.git-commit-tmp" 2>/dev/null | grep -v '\.diff$\|review-log' )" ] && ok "X03 repo 內沒有殘留紀錄檔" || bad "X03 repo 內沒有殘留紀錄檔" "$(ls "$W/sub/.claude/.git-commit-tmp")"
[ -z "$(git -C "$W/sub" status --porcelain -- ':!.claude')" ] && ok "X04 狀態檔不會出現在 git status" || bad "X04 狀態檔不會出現在 git status" "$(git -C "$W/sub" status --porcelain)"

# ================= 9. 對抗審查補測（2026-10-16）=================
new_repo v1
expect "V01 內文 Claude-Session 尾行帶 --allow-message-trace 仍擋（署名不可豁免）" 1 flow check-msg v1 Feat "修正登入" --body "Claude-Session: https://claude.ai/code/session_01X" --allow-message-trace
expect "V02 內文小寫 claude.ai 網址擋" 1 flow check-msg v1 Feat "修正登入" --body "Session: https://claude.ai/code/session_01X"
expect "V03 描述含 claude.ai 網址擋" 1 flow check-msg v1 Feat "見 claude.ai/code/x" --allow-message-trace
put v1 a.txt one
flow prepare v1 a.txt >/dev/null; rec_pass v1
expect "V04 ship 內文署名帶旗標仍擋" 1 flow ship v1 Feat "修正登入" --body "Claude-Session: https://claude.ai/code/session_01X" --allow-message-trace
git -C "$(R v1)" reset -q --hard HEAD
# 放棄的改動 A 留下的極端情境輪次，不能算進不相干的改動 B
new_repo v2
put v2 a.txt A; flow prepare v2 a.txt >/dev/null
capture v2 arbiter "$EDGE_RULING"
git -C "$(R v2)" reset -q a.txt; rm -f "$(R v2)/a.txt"
put v2 b.txt B
expect "V05 新一批（index 原本是空的）prepare" 0 flow prepare v2 b.txt
has "V05b 輪數從 1 重算" "審查第 1 輪"
expect "V06 A 的仲裁結果不能用在新一批 B" 1 flow review-record v2 --codex "$BLOCK_REPLY" --reviewer "$PASS_REPLY" --edge "B 第一次審"
git -C "$(R v2)" reset -q --hard HEAD; rm -f "$(R v2)/b.txt"
# 連線字串放在單引號裡、後面還接參數
chk_sens "V07 單引號連線字串 Pwd=…' 擋" 1 "conn = connect('Server=x;UID=sa;Pwd=Secr3t', timeout=5)"
chk_sens "V08 JSX userId='abc' 不擋" 0 "<Avatar userId='abc' />"
git -C "$(R s1)" reset -q --hard HEAD
# 不帶 .claude/ 前綴的制度檔引用
new_repo v3
put v3 src/a.js '// 規則見 harness/D-判斷力矩陣.md'
expect "V09 harness/D-… 路徑擋" 1 flow prepare v3 src/a.js
git -C "$(R v3)" reset -q --hard HEAD; rm -f "$(R v3)/src/a.js"
put v3 src/b.js '// 照 A-漏水診斷書 的阻斷法'
expect "V10 只寫制度檔名也擋" 1 flow prepare v3 src/b.js
git -C "$(R v3)" reset -q --hard HEAD; rm -f "$(R v3)/src/b.js"
put v3 test/harness/setup.js '// boot the harness/server-a fixture'
expect "V11 test/harness/ 一般路徑不擋" 0 flow prepare v3 test/harness/setup.js
# 旗標缺值要報錯，不可無聲中止
for opt in --type --desc --body; do
  expect "V12 amend $opt 缺值有錯誤訊息" 1 flow amend v3 --confirm-rewrite $opt
  has "V12b amend $opt 缺值說明原因" "後面缺內容"
done

# ================= 10. 第二輪對抗審查補測 =================
# 「同一批」判斷：--staged 模式、留一個舊檔再加新檔，都要歸零
new_repo w1
put w1 a.txt A; flow prepare w1 a.txt >/dev/null
capture w1 arbiter "$EDGE_RULING"
git -C "$(R w1)" reset -q a.txt; rm -f "$(R w1)/a.txt"
put w1 b.txt B; git -C "$(R w1)" add b.txt
expect "W01 --staged 換一批" 0 flow prepare w1 --staged
has "W01b --staged 新一批從第 1 輪算" "審查第 1 輪"
expect "W01c --staged 新一批不帶上一批的仲裁結果" 1 flow review-record w1 --codex "$BLOCK_REPLY" --reviewer "$PASS_REPLY" --edge "B"
git -C "$(R w1)" reset -q --hard HEAD; rm -f "$(R w1)/b.txt"
new_repo w2
put w2 a.txt A; put w2 c.txt C; flow prepare w2 a.txt c.txt >/dev/null
capture w2 arbiter "$EDGE_RULING"
git -C "$(R w2)" reset -q c.txt; rm -f "$(R w2)/c.txt"
put w2 b.txt B
expect "W02 留一個舊檔再加新檔" 0 flow prepare w2 a.txt b.txt
has "W02b 從第 1 輪算" "審查第 1 輪"
expect "W02c 新一批不帶上一批的仲裁結果" 1 flow review-record w2 --codex "$BLOCK_REPLY" --reviewer "$PASS_REPLY" --edge "B"
git -C "$(R w2)" reset -q --hard HEAD; rm -f "$(R w2)/b.txt"
# 修 BLOCK 時多 stage 一個檔仍算同一批
new_repo w3
put w3 a.txt 1; flow prepare w3 a.txt >/dev/null
flow review-record w3 --codex "$BLOCK_REPLY" --reviewer "$PASS_REPLY" --block-classes "一般問題" >/dev/null 2>&1
put w3 a.txt 2; put w3 d.txt new
expect "W03 修 BLOCK 多加一個檔" 0 flow prepare w3 a.txt d.txt
has "W03b 仍算第 2 輪" "審查第 2 輪"
capture w3 arbiter "$EDGE_RULING"
expect "W03c 第 2 輪仲裁判 EDGE 豁免" 0 flow review-record w3 --codex "$BLOCK_REPLY" --reviewer "$PASS_REPLY" --edge "y"
# 敏感字：連線字串的各種包法要擋，程式碼寫法不擋
chk_sens "W04 反引號連線字串擋" 1 'connect(`Server=x;Pwd=Secr3t`, opts);'
chk_sens "W05 連線字串 ; Pwd = x 有空白擋" 1 'const cs = "Server=x; Pwd = Secr3t;";'
chk_sens "W06 \"Pwd=abc\" 單獨字串擋" 1 'const cs = "Pwd=abc";'
chk_sens "W07 this.userId=userId; 不擋" 0 'this.userId=userId;'
chk_sens "W08 getUserId=()=>id 不擋" 0 'const getUserId=()=>id'
chk_sens "W09 OLDPWD=/tmp 不擋" 0 'OLDPWD=/tmp'
chk_sens "W10 \"userId=\" + id 不擋" 0 'const q = "userId=" + id;'
git -C "$(R s1)" reset -q --hard HEAD
# AI 痕跡：harness 的各種寫法
new_repo w4
chk_trace() { # <名稱> <期望> <內容>
  git -C "$(R w4)" reset -q --hard HEAD; rm -rf "$(R w4)/src"
  put w4 src/x.js "$3"
  expect "$1" "$2" flow prepare w4 src/x.js
}
chk_trace "W11 Harness 規則（大寫）擋" 1 '// 依 Harness 規則停兩輪'
chk_trace "W12 .claude\\harness 反斜線路徑擋" 1 '// 見 .claude\harness\D-x.md'
chk_trace "W13 harness/_INDEX.md 擋" 1 '// 見 harness/_INDEX.md'
chk_trace "W14 harness 的規定 擋" 1 '// 依 harness 的規定處理'
chk_trace "W15 test/harness/A-fixture.js 不擋" 0 "import x from './test/harness/A-fixture.js'"
chk_trace "W16 線束 harness 檔號 不擋" 0 '// 線束 harness 檔號對照'
git -C "$(R w4)" reset -q --hard HEAD; rm -rf "$(R w4)/src"
# 署名變形（帶 --allow-message-trace 也要擋）
for sig in "ｃｌａｕｄｅ.ａｉ/code/x" $'claude\xe2\x80\x8b.ai/code/x' "Claude Session: abc" "Claude_Session: abc" "Co-Authored by: Claude" "Coauthored-by: someone"; do
  expect "W17 署名變形擋：$sig" 1 flow check-msg w4 Feat "加入登入功能" --body "$sig" --allow-message-trace
done
expect "W18 一般內文不受正規化影響" 0 flow check-msg w4 Feat "加入登入功能" --body "要等設計系統套件發下一版才能建置（全形括號）"

# ================= 11. 第三輪對抗審查補測 =================
chk_sens "Y01 ODBC Pwd={…} 擋" 1 'var cs = "Driver={ODBC Driver 17};Server=db01;Uid=sa;Pwd={Pr0d#2026};";'
has "Y01b 錯誤訊息指向 prepare 旗標" "prepare"
chk_sens "Y02 樣板字串 userId=\${…} 不擋" 0 'const qs = `userId=${userId}&page=${p}`;'
chk_sens "Y03 logger \"userId=%s\" 不擋" 0 'logger.info("userId=%s", uid)'
chk_sens "Y04 f\"userId={uid}\" 不擋" 0 'print(f"userId={uid}")'
git -C "$(R s1)" reset -q --hard HEAD
chk_trace "Y05 參考 harness 規範 擋" 1 '// 參考 harness 規範'
chk_trace "Y06 test harness 文件說明 不擋" 0 '// test harness 文件說明見下'
git -C "$(R w4)" reset -q --hard HEAD; rm -rf "$(R w4)/src"
for m in "修正 api.anthropic.com 逾時" "新增 coauthored by 欄位" "ClaudeSession 物件改名"; do
  expect "Y07 業務描述不算署名：$m" 0 flow check-msg w4 Fix "$m" --allow-message-trace
done
expect "Y08 Co-Authored-By 尾行仍擋" 1 flow check-msg w4 Fix "x" --body "Co-authored by: someone" --allow-message-trace
# 上一批在流程外 commit 掉（HEAD 變了）要歸零
new_repo y1
put y1 a.txt 1; flow prepare y1 a.txt >/dev/null
capture y1 arbiter "$EDGE_RULING"
GIT_COMMIT_FLOW=1 git -C "$(R y1)" commit -q -m "Chore: manual"
put y1 a.txt unrelated; git -C "$(R y1)" add a.txt
expect "Y09 HEAD 變了之後 prepare" 0 flow prepare y1 a.txt
has "Y09b 從第 1 輪算" "審查第 1 輪"
expect "Y09c HEAD 變了之後不帶上一批的仲裁結果" 1 flow review-record y1 --codex "$BLOCK_REPLY" --reviewer "$PASS_REPLY" --edge "y"
# python 是壞掉的佔位程式時，寬度與署名檢查不可無聲中止
FAKEPY="$ROOT/fakepy"; mkdir -p "$FAKEPY"
printf '#!/bin/sh\nexit 49\n' > "$FAKEPY/python3"; cp "$FAKEPY/python3" "$FAKEPY/python"; chmod +x "$FAKEPY/python3" "$FAKEPY/python"
LAST_OUT="$(PATH="$FAKEPY:$PATH" bash "$FLOW" check-msg w4 Feat "新增訂單查詢" 2>&1)"; rc=$?
[ "$rc" -eq 0 ] && ok "Y10 python 壞掉時 check-msg 仍可用" || bad "Y10 python 壞掉時 check-msg 仍可用" "rc=$rc $(printf '%s' "$LAST_OUT" | tail -3 | tr '\n' '|')"
LAST_OUT="$(PATH="$FAKEPY:$PATH" bash "$FLOW" check-msg w4 Feat "x" --body "Co-Authored-By: Claude" 2>&1)"; rc=$?
[ "$rc" -eq 1 ] && printf '%s' "$LAST_OUT" | grep -q 'Co-Authored-By' && ok "Y11 python 壞掉時署名仍擋且列出命中內容" || bad "Y11 python 壞掉時署名仍擋且列出命中內容" "rc=$rc $(printf '%s' "$LAST_OUT" | tail -3 | tr '\n' '|')"

# ================= 12. 第四輪對抗審查補測 =================
expect "Z01 C++ 的 ClaudeSession::Init 不算署名" 0 flow check-msg w4 Fix "修正 ClaudeSession::Init 例外" --allow-message-trace
expect "Z02 Claude-Session: 尾行仍擋" 1 flow check-msg w4 Fix "x" --body "Claude-Session: abc" --allow-message-trace
LAST_OUT="$(PATH="$FAKEPY:$PATH" bash "$FLOW" check-msg w4 Fix "中文描述測試寬度" 2>&1)"
has "Z03 沒有可用 python 時以字元數估算（不是位元組數）" "描述寬度：8 / 72"
new_repo z1
put z1 a.txt 'x'
LAST_OUT="$(flow analyze z1 2>&1)"; git -C "$(R z1)" add a.txt
LAST_OUT="$(flow analyze z1 2>&1)"
flow --help > "$ROOT/help.txt" 2>&1
grep -q 'ship 會擋下，除非顯式 --allow-sensitive' "$ROOT/help.txt" && bad "Z04 --help 不再說只有 ship 擋" || ok "Z04 --help 不再說只有 ship 擋"

# ================= 13. commit 前兩軌審查（Codex）補測 =================
chk_sens "K01 單引號外層、雙引號包住的 Pwd 值 擋" 1 "cs = 'Server=x;Pwd=\"p@ss;word\"'"
chk_sens "K02 \"Pwd=\" + pw 組連線字串 擋" 1 'const cs = "Server=x;Pwd=" + pw;'
chk_sens "K03 JSX 寫死密碼 <Field pwd=\"abc\" /> 擋" 1 '<Field pwd="abc" />'
chk_sens "K03b 程式碼寫死 pwd = \"Secr3t\" 擋" 1 'pwd = "Secr3t"'
chk_sens "K03c C# string Pwd = \"x\"; 擋" 1 'string Pwd = "Secr3t";'
chk_sens "K03d pwd = \"\" 空字串不擋" 0 'pwd = ""'
git -C "$(R s1)" reset -q --hard HEAD
new_repo k1
put k1 a.txt 1; git -C "$(R k1)" add a.txt
GIT_COMMIT_FLOW=1 git -C "$(R k1)" commit -q -m "Fix: 修正登入" -m "經語法樹掃描確認全數在 try 內"
expect "K04 沿用 message 的 amend：內文有痕跡就擋" 1 flow amend k1 --confirm-rewrite
has "K04b 說明是內文" "HEAD 的內文含 AI 痕跡"
expect "K05 帶 --allow-message-trace 放行" 0 flow amend k1 --confirm-rewrite --allow-message-trace
put k1 a.txt 2; git -C "$(R k1)" add a.txt
GIT_COMMIT_FLOW=1 git -C "$(R k1)" commit -q -m "Fix: 修正逾時" -m "Refs: https://example.com/issues/1234567890/very/long/path/that/exceeds/the/width/limit/for/sure"
expect "K06 內文 trailer 很長仍可沿用（不套寬度）" 0 flow amend k1 --confirm-rewrite

expect "K07 業務描述提到 claude.ai 不算署名" 0 flow check-msg w4 Feat "支援 claude.ai 連結預覽" --allow-message-trace
expect "K08 claude.com/claude-code 署名連結仍擋" 1 flow check-msg w4 Feat "x" --body "Generated by https://claude.com/claude-code" --allow-message-trace
# ================= 14. commit 前第 2 輪兩軌審查補測 =================
chk_sens "L01 JSX token={\"字串常數\"} 擋" 1 '<Chat token={"abc123"} />'
chk_sens "L02 JSX token={變數} 不擋" 0 '<Chat token={token} />'
chk_sens "L03 反引號寫死 Pwd 擋" 1 'const Pwd = `Secr3t`;'
chk_sens "L04 shell local pwd=\"\$1\" 不擋" 0 'local pwd="$1"'
chk_sens "L05 shell PWD=\"\$(pwd)\" 不擋" 0 'PWD="$(pwd)"'
chk_sens "L06 shell OLDPWD=\"\$PWD\" 不擋" 0 'OLDPWD="$PWD"'
chk_sens "L07 行首 userId={user.id} 不擋" 0 'userId={user.id}'
chk_sens "L08 行首 pwd=\$(pwd) 不擋" 0 'pwd=$(pwd)'
chk_sens "L09 行首 Pwd=\"Secr3t\" 擋" 1 'Pwd="Secr3t"'
git -C "$(R s1)" reset -q --hard HEAD
expect "L10 check-msg 痕跡提示指向同一條指令" 1 flow check-msg w4 Fix "經語法樹掃描確認全數在 try 內"
has "L10b 提示含 check-msg" "ship／check-msg／amend"
# ================= 15. commit 前第 3、4 輪兩軌審查補測（Pwd 規則重寫、設定檔另掃） =================
chk_cfg() { # <名稱> <期望 exit> <檔名> <內容>
  git -C "$(R s1)" reset -q --hard HEAD; rm -f "$(R s1)/c.jsx" "$(R s1)/$3"
  mkdir -p "$(dirname "$(R s1)/$3")"
  printf '%s\n' "$4" > "$(R s1)/$3"
  expect "$1" "$2" flow prepare s1 "$3"
}
chk_sens "PW01 .env 寫法 DB_PWD=Secr3t（程式碼檔）擋" 1 'DB_PWD=Secr3t'
chk_sens "PW02 export DB_PWD=Secr3t 擋" 1 'export DB_PWD=Secr3t'
chk_sens "PW03 縮排   Pwd=Secr3t 擋" 1 '  Pwd=Secr3t'
chk_sens "PW04 spring.datasource.pwd=x 擋" 1 'spring.datasource.pwd=Secr3t'
chk_sens "PW05 行首 Pwd = {含非英數} 擋" 1 'Pwd = {實際密碼}'
chk_sens "PW06 JSX pwd={\"字串常數\"} 擋" 1 'pwd={"Secr3t"}'
chk_sens "PW07 連線字串後面還有 ( 擋" 1 "connect('Server=x;Pwd=Secr3t', foo(1))"
chk_sens "PW08 值裡有括號 DB_PWD=Prod(2026) 擋" 1 'DB_PWD=Prod(2026)'
chk_sens "PW09 行尾註解有括號 擋" 1 'DB_PWD=Secr3t  # 正式機 (勿外流)'
chk_sens "PW10 引號值＋行尾註解有括號 擋" 1 'DB_PWD="Secr3t" # (x)'
chk_sens "PW11 引號裡有括號 pwd = \"Prod(2026)\" 擋" 1 'pwd = "Prod(2026)"'
chk_sens "PW12 帶前綴的大括號密碼 DB_PWD={…} 擋" 1 'DB_PWD={Pr0d#2026}'
chk_sens "PW13 mysql -p密碼 擋" 1 'mysql -uroot -pSecr3t db'
chk_sens "PW14 echo \"pwd=\$(pwd)\" 不擋" 0 'echo "pwd=$(pwd)"'
chk_sens "PW15 echo \"Pwd=\${pwd}\" 不擋" 0 'echo "Pwd=${pwd}"'
chk_sens "PW16 PWD=/tmp 不擋" 0 'PWD=/tmp'
chk_sens "PW17 JSX token={\`\${t}\`} 不擋" 0 '<Chat token={`${t}`} />'
chk_sens "PW18 JSX token={\`前綴 \${t}\`} 不擋" 0 '<Chat token={`Token ${accessToken}`} />'
chk_sens "PW19 JSX token={\`常數\`} 擋" 1 '<Chat token={`abc`} />'
chk_sens "PW20 f-string ;Pwd={pwd} 不擋" 0 'cs = f"Server=x;Pwd={pwd}"'
chk_sens "PW21 JSX user=\"a\" pwd={pwd} 不擋" 0 '<Login user="a" pwd={pwd} />'
chk_sens "PW22 比較 pwd == x 不擋" 0 'if (pwd == x) {'
chk_sens "PW23 pwd = getPwd() 不擋" 0 'pwd = getPwd()'
chk_sens "PW24 showPwd = !showPwd 不擋" 0 'const toggle = () => showPwd = !showPwd'
chk_sens "PW25 pwd = null; 不擋" 0 'pwd = null;'
chk_sens "PW26 this.pwd = pwd; 不擋" 0 'this.pwd = pwd;'
chk_sens "PW27 程式碼檔 Pwd = Secr3t（無引號運算式）不擋" 0 'Pwd = Secr3t'
chk_sens "PW28 shell userId=\"\$1\" 不擋" 0 'userId="$1"'
chk_sens "PW29 mysql -p\"\$VAR\" 不擋" 0 'mysql -uroot -p"$DB_PASS" db'
chk_sens "PW30 mysql -P3306 埠號不擋" 0 'mysql -P3306 -u root -p'
chk_sens "PW31 已知取捨：程式碼檔 Pwd = {純英數} 不擋" 0 'Pwd = {Secr3t}'
chk_cfg "PW32 .ini Pwd = Secr3t 擋" 1 conf/app.ini 'Pwd = Secr3t'
chk_cfg "PW33 .env 值有括號、有空白 擋" 1 .env 'DB_PWD = Prod(2026)'
chk_cfg "PW34 .ini Pwd = {純英數} 擋" 1 db.ini 'Pwd = {Secr3t}'
chk_cfg "PW35 yaml db_pwd: \"Secr3t\" 擋" 1 config/app.yml 'db_pwd: "Secr3t"'
chk_cfg "PW36 .properties 註解掉的舊密碼 擋" 1 app.properties '# db.pwd=OldSecr3t'
chk_cfg "PW37 Makefile DB_PWD := x 擋" 1 Makefile 'DB_PWD := Secr3t'
chk_cfg "PW38 .env.local 擋" 1 .env.local 'REDIS_PWD=Abc(123)!'
chk_cfg "PW39 .env 引用環境變數 不擋" 0 .env 'DB_PWD=${DB_PWD}'
chk_cfg "PW40 yaml 空值 null 不擋" 0 config/app.yaml 'db_pwd: null'
chk_cfg "PW41 yaml 空引號 不擋" 0 config/app.yaml 'db_pwd: ""'
chk_cfg "PW42 .env 空值 不擋" 0 .env 'DB_PWD='
chk_cfg "PW43 .env PWD=/路徑 不擋" 0 .env 'PWD=/srv/app'
chk_cfg "PW44 .env 值以 / 開頭但鍵不是 PWD 擋" 1 .env 'DB_PWD=/abs/Secr3t'
chk_cfg "PW45 env.js 不是設定檔，照程式碼判準" 0 src/env.js 'pwd = form.pwd'
# ---- commit 前第 5 輪兩軌審查補測 ----
chk_cfg "PW47 .env DB_PASS = x 擋" 1 .env 'DB_PASS = Prod2026!'
chk_cfg "PW48 .env SSL_BYPASS=true 不擋" 0 .env 'SSL_BYPASS=true'
chk_cfg "PW49 yaml 清單 - pwd: x 擋" 1 docker-compose.yml '  - pwd: Secr3t'
chk_cfg "PW50 檔名含空白的設定檔也掃" 1 'my file.env' 'DB_PWD = Secr3t'
chk_cfg "PW51 中文檔名的設定檔也掃" 1 '設定.env' 'DB_PWD = Secr3t'
chk_cfg "PW52 子目錄＋空白的 .properties 也掃" 1 'conf/app prod.properties' 'db.pwd = Secr3t'
chk_sens "PW53 程式碼 DB_PASS=Secr3t 擋" 1 'DB_PASS=Secr3t'
chk_sens "PW54 物件字面值 pwd: 'x' 擋" 1 "const c = { user: 'sa', pwd: 'Secr3t' }"
chk_sens "PW55 PHP 'Pwd' => 'x' 擋" 1 "\$c = ['Pwd' => 'Secr3t'];"
chk_sens "PW56 showPwd: false 不擋" 0 'const s = { showPwd: false }'
chk_sens "PW57 TS 型別 pwd: string 不擋" 0 '  pwd: string;'
chk_sens "PW58 accessToken=await refreshToken() 不擋" 0 'const accessToken=await refreshToken()'
chk_sens "PW59 ?token=abc 照擋" 1 'fetch("/api?token=abc123")'
chk_sens "PW60 行首 - DB_PWD={…} 擋" 1 '  - DB_PWD={Pr0d#2026}'
# ---- commit 前第 6 輪兩軌審查補測 ----
flow_in() { local d="$1"; shift; (cd "$d" && CLAUDE_PROJECT_DIR="$d" bash "$FLOW" "$@"); }
git -C "$(R s1)" reset -q --hard HEAD; mkdir -p "$(R s1)/sub"; printf 'DB_PWD = Secr3t\n' > "$(R s1)/sub/x.env"
expect "PW61 在 repo 子目錄執行 prepare，設定檔照掃" 1 flow_in "$(R s1)/sub" prepare . x.env
git -C "$(R s1)" reset -q --hard HEAD; rm -rf "$(R s1)/sub" "$(R s1)/.claude"
chk_cfg "PW62 副檔名大寫 UPPER.ENV 也掃" 1 UPPER.ENV 'DB_PWD = Secr3t'
chk_cfg "PW63 yaml token: \"含數字\" 擋" 1 config/auth.yaml 'token: "prod-token-abc123"'
chk_cfg "PW64 Ansible 樣板引用 {{ }} 不擋" 0 vars.yml 'ssh_pass: "{{ vault_x }}"'
chk_cfg "PW65 ansible-vault 加密值 不擋" 0 vars.yml 'db_pass: !vault |'
chk_cfg "PW66 布林 skip_pw: false 不擋" 0 vars.yml 'skip_pw: false'
chk_cfg "PW67 .env.example 空白範本 API_TOKEN= 不擋" 0 .env.example 'API_TOKEN='
chk_sens "PW68 const token = \"含數字\" 擋" 1 'const token = "prod-token-abc123";'
chk_sens "PW69 物件 { token: \"含數字\" } 擋" 1 'const options = { token: "prod-token-abc123" };'
chk_sens "PW70 const apiKey = \"含數字\" 擋" 1 'const apiKey = "prod-api-key-abc123";'
chk_sens "PW71 鍵名常數 ACCESS_TOKEN = \"access_token\" 不擋" 0 'const ACCESS_TOKEN = "access_token";'
chk_sens "PW72 token=\$T 引用變數 不擋" 0 'curl "https://x/api?token=$T"'
chk_sens "PW73 'X-Api-Key': \"含數字\" 擋" 1 "headers = { 'X-Api-Key': \"k1234\" }"
# ---- commit 前第 7 輪兩軌審查補測 ----
chk_sens "PW74 網址參數 ?apiKey=寫死 擋" 1 'fetch("https://svc.example/v1?apiKey=abcdefghijklmnopqrstuvwx")'
chk_sens "PW75 header X-Api-Key: 寫死 擋" 1 "curl -H 'X-Api-Key: abcdefghijklmnopqrstuvwx' https://svc.example/v1"
chk_sens "PW76 header X-Api-Key: \$變數 不擋" 0 'curl -H "X-Api-Key: $SVC_KEY" https://svc.example/v1'
chk_sens "PW77 apiKey=getKey() 不擋" 0 'const apiKey=getKey()'
chk_sens "PW78 純數字 nextPageToken = \"2\" 不擋" 0 'const nextPageToken = "2"'
chk_cfg "PW79 行尾註解含 {{ 不會放過真密碼" 1 vars.yml 'DB_PASS: Secr3t # ref: {{x}}'
chk_cfg "PW80 private_key: 檔案路徑 不擋" 0 vars.yml 'private_key: /etc/ssl/key.pem'
# ---- commit 前第 8 輪兩軌審查補測 ----
chk_sens "PW81 Authorization: \"Token 寫死\" 擋" 1 'headers: { Authorization: "Token a1b2c3d4e5f6g7h8i9j0k1l2" }'
chk_sens "PW82 Authorization: Basic 寫死 擋" 1 'curl -H "Authorization: Basic dXNlcjpwYXNz" https://x'
chk_sens "PW83 文件佔位 X-Api-Key: <your-key> 不擋" 0 'curl -H "X-Api-Key: <your-key>" https://x'
chk_sens "PW84 網址串接 \"?apiKey=\" + key 不擋" 0 'const u = "/x?apiKey=" + key'
chk_sens "PW85 .env 寫法 SSL_PRIVATE_KEY=./路徑 不擋" 0 'SSL_PRIVATE_KEY=./certs/key.pem'
chk_cfg "PW86 Windows 路徑 private_key: C:\\… 不擋" 0 vars.yml 'private_key: C:\Users\alice\.ssh\id_ed25519'
chk_cfg "PW87 .env SSL_PRIVATE_KEY=/路徑 不擋" 0 .env 'SSL_PRIVATE_KEY=/etc/ssl/private/key.pem'
chk_cfg "PW88 .env private key 內容寫死 擋" 1 .env 'SSL_PRIVATE_KEY=MIIEvQIBADANBg'
# ---- commit 前第 9 輪兩軌審查補測 ----
chk_sens "PW89 addHeader(\"Authorization\", \"Basic 寫死\") 擋" 1 'request.addHeader("Authorization", "Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ==");'
chk_sens "PW90 setRequestProperty(\"X-Api-Key\", \"寫死\") 擋" 1 'conn.setRequestProperty("X-Api-Key", "abc123def");'
chk_sens "PW91 headers.set(\"Authorization\", 變數) 不擋" 0 'headers.set("Authorization", token + x)'
chk_sens "PW92 \"?token=\"+token 無空白串接 不擋" 0 'const u = "?token="+token'
chk_sens "PW93 程式碼 privateKey: './路徑' 不擋" 0 "const c = { privateKey: './keys/private-key.pem' }"
chk_sens "PW94 程式碼 privateKey 寫死內容 擋" 1 "const c = { privateKey: 'MIIEvQIBADANBgkqhkiG9w0BAQ' }"
chk_cfg "PW95 .env.example 佔位 <your-token> 不擋" 0 .env.example 'GITHUB_TOKEN=<your-token>'
chk_cfg "PW96 .env.example 佔位 changeme 不擋" 0 .env.example 'API_TOKEN=changeme'
chk_cfg "PW97 yaml header 佔位 X-Api-Key: <your-key> 不擋" 0 vars.yml 'X-Api-Key: <your-key>'
# ---- commit 前第 10 輪兩軌審查補測 ----
chk_sens "PW98 同一行有 privateKey 路徑＋寫死 token 擋" 1 "const config = { privateKey: './keys/client.pem', token: 'prod-token-abc123' };"
chk_sens "PW99 同一行有 changeme＋寫死 token 擋" 1 'const token = "abcd1234"; const fallback = { apiKey: "changeme" };'
chk_sens "PW100 同一行有 ?token=abc 與 token=getX() 擋" 1 'u = "?token=abc123&x=1"; t.token=getX()'
has "PW100b 命中行照原樣印出（不是轉小寫後的）" 'u = "?token=abc123&x=1"; t.token=getX()'
chk_sens "PW101 privateKey 路徑＋token 取環境變數 不擋" 0 "const config = { privateKey: './keys/client.pem', token: process.env.T };"
chk_cfg "PW102 yaml X-Api-Key: changeme 不擋" 0 vars.yml 'X-Api-Key: changeme'
# ---- commit 前第 11 輪兩軌審查補測 ----
chk_sens "PW103 Authorization: \"ApiKey 寫死\" 擋" 1 'const headers = { Authorization: "ApiKey prod_7f3a91c2d8e4b6a0" };'
chk_sens "PW104 headers['X-Api-Key'] = '寫死' 擋" 1 "headers['X-Api-Key'] = 'sk-live-abc123def456'"
chk_sens "PW105 headers[\"Authorization\"] = \"Token 寫死\" 擋" 1 'headers["Authorization"] = "Token abc123def"'
chk_sens "PW106 Authorization 佔位 Token your-… 不擋" 0 "const h = {Authorization: 'Token your-token-here'}"
chk_sens "PW107 網址佔位後面接 &真值 擋" 1 "fetch('/x?apiKey=your_key&token=abc123def')"
chk_sens "PW108 Authorization: await getToken() 不擋" 0 'const h = { Authorization: await getToken() }'
# ---- commit 前第 12 輪兩軌審查補測 ----
chk_sens "PW109 中括號賦值佔位 Token changeme 不擋" 0 'headers["Authorization"] = "Token changeme";'
chk_sens "PW110 中括號賦值佔位 X-Api-Key changeme 不擋" 0 "headers['X-Api-Key'] = 'changeme'"
chk_sens "PW111 不帶 X- 的 Api-Key: 寫死 擋" 1 'curl -H "Api-Key: sk_live_abc123def456" https://api.example.test'
chk_sens "PW112 TS 型別 apiKey: string 不擋" 0 '  apiKey: string;'
# ---- commit 前第 13 輪兩軌審查補測 ----
chk_sens "PW113 中括號賦值 headers[\"Api-Key\"] = 寫死 擋" 1 'headers["Api-Key"] = "sk_live_7Gq2D8mK4pR9vX3c";'
chk_sens "PW114 逗號寫法 setRequestProperty(\"Api-Key\", 寫死) 擋" 1 'request.setRequestProperty("Api-Key", "sk_live_7Gq2D8mK4pR9vX3c");'
chk_cfg "PW115 yaml api-key: null 不擋" 0 application.yml 'api-key: null'
chk_cfg "PW116 yaml auth-token: false 不擋" 0 application.yml 'auth-token: false'
# token_assign_hits 用 # 當 sed 分隔字元：pattern 裡出現 # 會讓 sed 失敗，必須中止而不是無聲放過
if grep -E '^(TOKEN_(BENIGN|ASSIGN_PATTERN)|COND_COLON_PATTERN)=' "$FLOW" | grep -q '#'; then bad "PW117 TOKEN_BENIGN／TOKEN_ASSIGN_PATTERN／COND_COLON_PATTERN 不含 #"; else ok "PW117 TOKEN_BENIGN／TOKEN_ASSIGN_PATTERN／COND_COLON_PATTERN 不含 #"; fi
[ "$(grep -cE '^(TOKEN_(BENIGN|ASSIGN_PATTERN)|COND_COLON_PATTERN)=' "$FLOW")" = 3 ] && ok "PW117b 三個 pattern 都找得到" || bad "PW117b 三個 pattern 都找得到"
if [ "$(grep -cE '^COLOR_LITERAL_PATTERN=' "$FLOW")" = 1 ] && ! grep -E '^COLOR_LITERAL_PATTERN=' "$FLOW" | grep -q '@'; then ok "PW117c COLOR_LITERAL_PATTERN 存在且不含 @"; else bad "PW117c COLOR_LITERAL_PATTERN 存在且不含 @"; fi
BROKEN="$ROOT/flow-broken.sh"
sed -E "s/^(TOKEN_BENIGN=')/\1(#x)?|/" "$FLOW" > "$BROKEN"
git -C "$(R s1)" reset -q --hard HEAD; rm -f "$(R s1)/c.jsx"
printf '%s\n' 'const token = "prod-token-abc123";' > "$(R s1)/c.jsx"
expect "PW118 sed 失敗時 prepare 中止（不無聲放過）" 1 bash "$BROKEN" prepare s1 c.jsx
has "PW118b 錯誤訊息說明 token 檢查無法執行" "token 類敏感字檢查無法執行"
git -C "$(R s1)" reset -q --hard HEAD; rm -f "$(R s1)/c.jsx"
# grep 用的 pattern 寫壞（grep 回 2）也要中止：grep 都帶 || true，不先驗證會無聲放過（第 30 輪 C 軌）
BROKEN2="$ROOT/flow-broken2.sh"
sed -E "s/^(SENSITIVE_PATTERN=')/\1(|/" "$FLOW" > "$BROKEN2"
printf '%s\n' 'pw = "Secr3t1"' > "$(R s1)/c.jsx"
expect "PW118c grep pattern 語法錯時 prepare 中止" 1 bash "$BROKEN2" prepare s1 c.jsx
has "PW118d 錯誤訊息說明 pattern 有語法錯誤" "敏感字 pattern 有語法錯誤"
git -C "$(R s1)" reset -q --hard HEAD; rm -f "$(R s1)/c.jsx"
# ---- commit 前第 14 輪兩軌審查補測 ----
chk_cfg "PW119 GitHub Actions id-token: write 不擋" 0 .github/workflows/deploy.yml '  id-token: write'
chk_cfg "PW120 yaml 分頁游標 nextPageToken 不擋" 0 openapi/examples.yml 'nextPageToken: "cursor-abc123"'
chk_sens "PW121 程式碼分頁游標 nextPageToken 不擋" 0 'const nextPageToken = "cursor-abc123";'
chk_cfg "PW122 yaml github_token: 寫死 照擋" 1 .github/workflows/deploy.yml 'github_token: ghp_abc123'
# amend 的內容閘失敗時要清掉剛建的備份分支（還沒改寫任何東西）
new_repo am1; put am1 a.txt base; flow prepare am1 a.txt >/dev/null; rec_pass am1; flow ship am1 Feat "base" >/dev/null 2>&1
put am1 c.jsx 'const token = "prod-token-abc123";'
flow prepare am1 c.jsx --allow-sensitive >/dev/null 2>&1; rec_pass am1
before_head="$(git -C "$(R am1)" rev-parse HEAD)"
expect "PW123 amend 的敏感字閘失敗時中止" 1 bash "$BROKEN" amend am1 --confirm-rewrite
[ -z "$(git -C "$(R am1)" branch --list 'backup/pre-amend-*')" ] && ok "PW123b 沒留下 backup/pre-amend-* 分支" || bad "PW123b 沒留下 backup/pre-amend-* 分支" "$(git -C "$(R am1)" branch --list 'backup/*')"
[ "$(git -C "$(R am1)" rev-parse HEAD)" = "$before_head" ] && ok "PW123c HEAD 沒被改寫" || bad "PW123c HEAD 沒被改寫"
# ---- commit 前第 15 輪兩軌審查補測 ----
chk_sens "PW124 TS 型別註記 apiKey: string = 寫死 擋" 1 'const apiKey: string = "sk_live_7Gq2D8mK4pR9vX3c";'
chk_sens "PW125 TS 型別註記 pwd: string = 寫死 擋" 1 'private pwd: string = "Secr3t";'
chk_sens "PW126 TS 型別註記取環境變數 不擋" 0 'const apiKey: string = process.env.K;'
chk_cfg "PW127 yaml 翻譯檔 token: \"Token\" 不擋" 0 locales/en.yml 'token: "Token"'
chk_cfg "PW128 yaml 翻譯檔中文值 不擋" 0 locales/zh-TW.yml 'token: "存取權杖"'
chk_cfg "PW129 yaml api_token: 含數字 照擋" 1 config/app.yml 'api_token: abc123'
chk_cfg "PW130 HOMEPAGE_TOKEN 不算分頁游標 擋" 1 .env 'HOMEPAGE_TOKEN=s3cr3tvalue99'
chk_cfg "PW131 NEXT_PAGE_TOKEN 不擋" 0 .env 'NEXT_PAGE_TOKEN=abc123'
# ---- commit 前第 16 輪兩軌審查補測 ----
chk_sens "PW132 TS 聯集型別 apiKey: string | undefined = 寫死 擋" 1 'const apiKey: string | undefined = "a1b2c3d4e5f6g7h8i9j0";'
chk_sens "PW133 TS 聯集型別 pwd: string | null = 寫死 擋" 1 'const pwd: string | null = "Secr3t";'
chk_sens "PW134 TS 泛型 apiKey: Record<…> = {} 不擋" 0 'apiKey: Record<string, string> = {}'
chk_sens "PW135 程式碼中文長字串 不擋" 0 'const token = "請輸入您的存取權杖文字";'
chk_cfg "PW136 yaml 翻譯檔 8 個中文字 不擋" 0 locales/zh-TW.yml 'token: "此處輸入存取權杖"'
chk_cfg "PW137 yaml 翻譯檔英文句子 不擋" 0 locales/en.yml 'invalid_token: "Invalid authentication token."'
chk_cfg "PW138 yaml token 值含空白也含數字 照擋" 1 config/app.yml 'api_token: "abc def 123"'
# ---- commit 前第 17 輪兩軌審查補測 ----
chk_sens "PW139 token 參數後接有預設字串的參數 不擋" 0 'connect(token: string, baseUrl = "https://api.example.com/v1")'
chk_sens "PW140 Python def f(token: str, model = \"…\") 不擋" 0 'def call(token: str, model = "gpt-4o"):'
chk_sens "PW141 解構 { token: a, version = \"v2\" } 不擋" 0 'const { token: authToken, version = "v2" } = opts;'
chk_sens "PW142 pwd 參數後接有預設字串的參數 不擋" 0 'function login(pwd: string, host = "db01") {}'
chk_sens "PW143 Python 關鍵字參數 token=token 不擋" 0 'client.get(url, token=token)'
chk_sens "PW144 Go var token string = 寫死 擋" 1 'var token string = "ghp_abc123"'
chk_sens "PW145 JSX apiKey={\"常數\"} 擋" 1 '<SdkProvider apiKey={"a1b2c3d4e5f6g7h8i9j0"} />'
chk_sens "PW146 JSX apiKey={變數} 不擋" 0 '<SdkProvider apiKey={config.apiKey} />'
# ---- commit 前第 18 輪兩軌審查補測 ----
chk_sens "PW147 markdown 連結 ?token=寫死) 擋" 1 '[download](https://h.com/f.zip?token=abc123def)'
chk_sens "PW148 log 行 token=寫死, 擋" 1 'INFO login ok token=abc123def, user=bob'
chk_sens "PW149 x(token=含數字長值) 擋" 1 'x(token=a1b2c3d4e5f6g7h8i9j0k1l2)'
chk_sens "PW150 Python 關鍵字參數 token=self.token 不擋" 0 'f(token=self.token)'
chk_sens "PW151 Kotlin val apiKey: String? = 寫死 擋" 1 'val apiKey: String? = "sk_live_a1b2c3d4e5f6g7h8i9j0"'
chk_sens "PW152 Kotlin val token: String? = null 不擋" 0 'val token: String? = null'
# ---- commit 前第 19 輪兩軌審查補測 ----
chk_sens "PW153 三元運算寫死預設密碼 ? pwd : 'Secr3t' 擋（第 20 輪撤回放行）" 1 "const pwd = process.env.DB_PWD ? process.env.DB_PWD : 'Secr3t';"
chk_sens "PW154 三元運算寫死預設 token 擋" 1 "const token = process.env.GH_TOKEN ? process.env.GH_TOKEN : 'ghx_abc123def456';"
chk_sens "PW154b Ruby 不加括號 Client.new pwd: '寫死' 擋" 1 "Client.new pwd: 'Secr3t'"
chk_sens "PW155 物件欄位 { user: 'sa', pwd: '寫死' } 照擋" 1 "const c = { user: 'sa', pwd: 'Secr3t' }"
# types= 同時列了 none：像 Type 前綴卻不在清單的 subject，不能當無前綴描述放過
new_repo n1; mkdir -p "$(R n1)/.claude"
printf 'types=minor none\n' > "$(R n1)/.claude/git-commit.conf"
git -C "$(R n1)" add .claude/git-commit.conf; GIT_COMMIT_FLOW=1 git -C "$(R n1)" commit -q -m "Feat: 舊訊息"
expect "PW156 check-msg none 描述開頭像清單外 Type 不收" 1 flow check-msg n1 none "Feat: 舊訊息"
has "PW156b 說明開頭像 Type 前綴" "開頭像 Type 前綴"
expect "PW157 check-msg none 一般描述照收" 0 flow check-msg n1 none "add login page"
LAST_OUT="$(flow audit n1 -1 2>&1)"; has "PW158 audit 報 Type 不在允許清單" "Type 不在允許清單"
expect "PW159 amend 沿用清單外 Type 的 message 不收" 1 flow amend n1 --confirm-rewrite
# 字面寫成 `none: …` 的既有 subject：audit 要報、amend 不准沿用（第 20 輪 Codex）
GIT_COMMIT_FLOW=1 git -C "$(R n1)" commit -q --allow-empty -m "none: add login"
LAST_OUT="$(flow audit n1 -1 2>&1)"; has "PW160 audit 把 none: 報成 Type 不在允許清單" "Type 不在允許清單"
expect "PW161 amend 沿用 none: 開頭的 message 不收" 1 flow amend n1 --confirm-rewrite
has "PW161b 說明 none 不能當 Type 寫進 subject" "不能當 Type 寫進 subject"
# ---- commit 前第 21 輪兩軌審查補測 ----
chk_sens "PW162 shell pass=寫死 擋" 1 'pass=Prod2026!'
chk_sens "PW163 shell pw='寫死' 擋" 1 "pw='Prod2026!'"
chk_sens "PW164 compass=north 不擋" 0 'compass=north'
chk_sens "PW165 pw=\$(read_pw) 不擋" 0 'pw=$(read_pw)'
expect "PW166 check-msg none 描述以 none: 開頭 不收" 1 flow check-msg n1 none "none: 修正"
has "PW166b 說明 none 不會出現在 subject" "subject 裡不會出現「none:」"
# ---- commit 前第 22 輪兩軌審查補測 ----
chk_sens "PW167 shell 參數解析 --pass=*) 不擋" 0 '  --pass=*) PASS="${1#*=}" ;;'
chk_sens "PW168 Python 關鍵字參數 pw=pw 不擋" 0 'connect(host=h, user=u, pw=pw)'
chk_sens "PW169 log 格式 pw=%s 不擋" 0 'log("user=%s pw=%s" % (u, p))'
chk_sens "PW170 SQL 佔位 where pw=? 不擋" 0 'cur.execute("select * from t where pw=?")'
chk_sens "PW171 nodemailer { pass: '寫死' } 擋" 1 "auth: { user: 'a@b.c', pass: 'hunter2' }"
chk_sens "PW172 DB_PW = \"寫死\" 擋" 1 'DB_PW = "hunter2"'
# 第 23 輪：單獨 pass 的引號值要含數字或特殊符號（三元式、狀態對照不擋）；駝峰 dbPass／smtpPw 分大小寫另比
chk_sens "PW173 三元式 ? \"PASS\" : \"FAIL\" 不擋" 0 'const verdict = ok ? "PASS" : "FAIL";'
chk_sens "PW174 三元式 ? 'Pass' : 'Fail' 不擋" 0 "label = passed ? 'Pass' : 'Fail'"
chk_sens "PW175 審核狀態對照 pass: '已通过' 不擋" 0 "const m = { pass: '已通过', reject: '已驳回' };"
chk_sens "PW176 pass: \"PASS\" 不擋" 0 '  pass: "PASS",'
chk_sens "PW177 表情符號對照 pass: \"✅\" 不擋" 0 'emoji = { pass: "✅", fail: "❌" }'
chk_sens "PW178 nodemailer pass: 'hunter2xyz' 照擋" 1 "auth: { user: 'a', pass: 'hunter2xyz' }"
chk_sens "PW179 駝峰 const dbPass = \"Prod2026!\" 擋" 1 'const dbPass = "Prod2026!";'
chk_sens "PW180 駝峰 smtpPass: 'Pr0d!x' 擋" 1 "  smtpPass: 'Pr0d!x',"
chk_sens "PW181 駝峰 dbPw=Prod2026! 擋" 1 'dbPw=Prod2026!'
chk_sens "PW182 TS 型別 const dbPass: string = \"…\" 擋" 1 'const dbPass: string = "Prod2026!";'
chk_sens "PW183 compass／bypass 不擋" 0 'const compass = "N1"; bypass = "abc1";'
chk_sens "PW184 firstPass = \"abc\" 不擋" 0 'const firstPass = "abc";'
chk_sens "PW185 dbPass = process.env.DB_PASS 不擋" 0 'const dbPass = process.env.DB_PASS;'
chk_sens "PW186 testPassed = \"a1\" 不擋" 0 'const testPassed = "a1";'
chk_cfg "PW187 yaml 駝峰 dbPass: Prod2026! 擋" 1 config/app.yml 'dbPass: Prod2026!'
chk_cfg "PW188 yaml 駝峰 firstPass: true 不擋" 0 config/app.yml 'firstPass: true'
chk_cfg "PW189 yaml 駝峰 dbPass: \${DB_PASS} 不擋" 0 config/app.yml 'dbPass: ${DB_PASS}'
chk_cfg "PW190 yaml compass: north 不擋" 0 config/app.yml 'compass: north'
# 第 24 輪：Go 短宣告、大寫縮寫 DBPass、引號值只含符號的提示文字
chk_sens "PW191 Go dbPass := \"Prod2026!\" 擋" 1 '	dbPass := "Prod2026!"'
chk_sens "PW192 Go pw := \"s3cret1\" 擋" 1 '	pw := "s3cret1"'
chk_sens "PW193 Go struct DBPass: \"Prod2026\" 擋" 1 '	DBPass: "Prod2026",'
chk_sens "PW194 SMTPPass = \"Mail2026\" 擋" 1 'const SMTPPass = "Mail2026";'
chk_sens "PW195 提示文字 examPass: \"Congratulations!\" 不擋" 0 'const quiz = { examPass: "Congratulations!" };'
chk_sens "PW196 快捷鍵 togglePw: \"Ctrl+Shift+P\" 不擋" 0 '{ togglePw: "Ctrl+Shift+P" }'
chk_sens "PW197 BYPASS = \"x1\" 不擋" 0 'BYPASS = "x1"'
chk_cfg "PW198 yaml DBPass: Prod2026! 擋" 1 config/app.yml 'DBPass: Prod2026!'
# 第 25 輪：Go 帶型別宣告、C# 自動屬性初始值、全大寫服務名前綴
chk_sens "PW199 Go var dbPass string = \"…\" 擋" 1 'var dbPass string = "Secr3t1"'
chk_sens "PW200 Go var pass string = \"…\" 擋" 1 'var pass string = "Secr3t1"'
chk_sens "PW201 C# SmtpPass { get; set; } = \"…\" 擋" 1 'class C { public string SmtpPass { get; set; } = "Mail2026"; }'
chk_sens "PW202 C# DB_PASS { get; set; } = \"…\" 擋" 1 'public string DB_PASS { get; set; } = "Secr3t1";'
chk_sens "PW203 C# ApiKey { get; set; } = \"…\" 擋" 1 'public string ApiKey { get; set; } = "sk1234567890abcdef";'
chk_sens "PW204 const SMTPPASS = \"Mail2026\" 擋" 1 'const SMTPPASS = "Mail2026";'
chk_sens "PW205 C# IsPass { get; set; } = true 不擋" 0 'public bool IsPass { get; set; } = true;'
chk_sens "PW206 Go allPass := true／pass := fmt.Sprintf 不擋" 0 'allPass := true; pass := fmt.Sprintf("%d", n)'
chk_sens "PW207 trespass = \"a1\" 不擋" 0 'trespass = "a1"'
chk_cfg "PW208 .env DBPASS=Secr3t1 擋" 1 .env 'DBPASS=Secr3t1'
chk_cfg "PW209 .env BYPASS=yes 不擋" 0 .env 'BYPASS=yes'
# 第 26 輪：冒號型別、選填欄位、鍵當字串參數接寫死預設值
chk_sens "PW210 TS const pw: string = \"…\" 擋" 1 'const pw: string = "Prod2026!";'
chk_sens "PW211 Rust let pass: &str = \"…\" 擋" 1 'let pass: &str = "Prod2026!";'
chk_sens "PW212 TS 選填 pass?: string = \"…\" 擋" 1 '  pass?: string = "Prod2026!"'
chk_sens "PW213 PHP define('DB_PASS', '…') 擋" 1 "define('DB_PASS', 'Prod2026!');"
chk_sens "PW214 os.getenv(\"DB_PASS\", \"…\") 擋" 1 'db = os.getenv("DB_PASS", "Prod2026!")'
chk_sens "PW215 陣列 [\"pwd\", \"user\"] 不擋" 0 'fields = ["pwd", "user"]'
chk_sens "PW216 os.getenv(\"DB_PASS\", \"\") 不擋" 0 'db = os.getenv("DB_PASS", "")'
chk_sens "PW217 userpass=check_user(u1) 不擋" 0 'userpass=check_user(u1)'
chk_sens "PW218 三元 x = pass ? \"a1\" : b 不擋" 0 'x = pass ? "a1" : b'
# 第 27 輪：中括號下標、#define、一行式條件句冒號、參數支只認取設定值的呼叫
chk_sens "PW219 PHP \$cfg['db_pass'] = '…' 擋" 1 "\$cfg['db_pass'] = 'Secr3t1';"
chk_sens "PW220 os.environ[\"DB_PASS\"] = \"…\" 擋" 1 'os.environ["DB_PASS"] = "Secr3t1"'
chk_sens "PW221 headers[\"token\"] = \"…\" 擋" 1 'headers["token"] = "abc123def"'
chk_sens "PW222 Arduino #define WIFI_PASS \"…\" 擋" 1 '#define WIFI_PASS "abc12345"'
chk_sens "PW223 #define API_TOKEN \"…\" 擋" 1 '#define API_TOKEN "abc123def456"'
chk_sens "PW224 if x: pw = \"Secr3t1\" 照擋" 1 'if x: pw = "Secr3t1"'
chk_sens "PW225 case PASS: color = \"#0f0\" 不擋" 0 'case PASS: color = "#0f0"; break;'
chk_sens "PW226 if pw: msg = \"Step 1\" 不擋" 0 'if pw: msg = "Step 1"'
chk_sens "PW227 case Status.PASS: label = \"OK\" 不擋" 0 'case Status.PASS: label = "OK"; break;'
chk_sens "PW228 assert(…, \"pass\", \"case 1 …\") 不擋" 0 'assert.strictEqual(status, "pass", "case 1 should pass");'
chk_sens "PW229 旗標 getenv(\"SECOND_PASS\", \"1\") 不擋" 0 'os.getenv("SECOND_PASS", "1")'
chk_sens "PW230 setItem(\"token\", \"v1abc\") 擋（第 34 輪起通用呼叫形狀）" 1 'localStorage.setItem("token", "v1abc");'
chk_sens "PW231 #define BYPASS \"1\" 不擋" 0 '#define BYPASS "1"'
chk_sens "PW232 if password: 照擋（關鍵字不受條件句處理影響）" 1 'if password:'
# 第 28 輪：大括號語言的單行條件句、條件後的 TODO、Ruby symbol、預設值運算子、Spring、#define 值判準
chk_sens "PW233 if (x) { pw: \"Secr3t1\" } 擋" 1 'if (x) { pw: "Secr3t1" }'
chk_sens "PW234 Go if err != nil { return Config{Pass: \"…\"} } 擋" 1 'if err != nil { return Config{Pass: "Secr3t1"} }'
chk_sens "PW235 if (x) { cfg = { dbPass: \"…\" } } 擋" 1 'if (x) { cfg = { dbPass: "Secr3t1" } }'
chk_sens "PW236 if (x) { token: \"…\" } 擋" 1 'if (x) { token: "abcdef1234567890xyz" }'
chk_sens "PW237 if (debug) dump(x); // TODO: remove 擋" 1 'if (debug) dump(x); // TODO: remove'
chk_sens "PW238 Ruby cfg[:db_pass] = \"…\" 擋" 1 'cfg[:db_pass] = "Prod2026!"'
chk_sens "PW239 Ruby headers[:token] = \"…\" 擋" 1 'headers[:token] = "abc123def"'
chk_sens "PW240 Spring \${DB_PASS:Secr3t1} 擋" 1 '@Value("${DB_PASS:Secr3t1}")'
chk_sens "PW241 .NET GetEnvironmentVariable(\"DB_PASS\") ?? \"…\" 擋" 1 'var p = Environment.GetEnvironmentVariable("DB_PASS") ?? "Secr3t1";'
chk_sens "PW242 process.env.DB_PASS || \"…\" 擋" 1 'const p = process.env.DB_PASS || "Secr3t1";'
chk_sens "PW243 Spring \${DB_PASS} 不擋" 0 '@Value("${DB_PASS}")'
chk_sens "PW244 #define PASS 顏色跳脫碼 不擋" 0 '#define PASS "\033[32mPASS\033[0m"'
chk_sens "PW245 #define CSRF_TOKEN \"csrftoken\" 不擋" 0 '#define CSRF_TOKEN "csrftoken"'
# 第 30 輪：shell 參數展開不當 Spring 預設值、中括號取環境變數接預設值、getOrDefault
chk_sens "PW246 shell \${DB_PASS:-} 不擋" 0 'DB_PASS="${DB_PASS:-}"'
chk_sens "PW247 shell \${API_TOKEN:?missing} 不擋" 0 ': "${API_TOKEN:?missing}"'
chk_sens "PW248 shell \${DB_PASS:-Secr3t1} 擋" 1 'DB_PASS="${DB_PASS:-Secr3t1}"'
chk_sens "PW249 Ruby ENV[\"DB_PASS\"] || \"…\" 擋" 1 'pw = ENV["DB_PASS"] || "Secr3t1"'
chk_sens "PW250 PHP \$_ENV['DB_PASS'] ?? '…' 擋" 1 "\$pw = \$_ENV['DB_PASS'] ?? 'Secr3t1';"
chk_sens "PW251 os.environ[\"DB_PASS\"] or \"…\" 擋" 1 'db_pass = os.environ["DB_PASS"] or "Secr3t1"'
chk_sens "PW252 getOrDefault(\"DB_PASS\", \"…\") 擋" 1 'String pw = System.getenv().getOrDefault("DB_PASS", "Secr3t1");'
chk_sens "PW253 process.env[\"DB_PASS\"] || \"\" 不擋" 0 'const p = process.env["DB_PASS"] || "";'
chk_cfg "PW254 docker-compose \${GITHUB_TOKEN:-} 不擋" 0 docker-compose.yml '      GITHUB_TOKEN: ${GITHUB_TOKEN:-}'
# 第 31 輪：點號設定物件接預設值、getattr／config()、Spring #{null}、token 的 \${…:-dummy}
chk_sens "PW255 config.db_pass ?? \"…\" 擋" 1 'const p = config.db_pass ?? "Secr3t1";'
chk_sens "PW256 nodemailer pass: opts.pass || \"…\" 擋" 1 'auth: { user: "u", pass: opts.pass || "Secr3t1" },'
chk_sens "PW257 Django settings.DB_PASS or \"…\" 擋" 1 'p = settings.DB_PASS or "Secr3t1"'
chk_sens "PW258 process.env.DB_PASS || \"…\" 照擋" 1 'const p = process.env.DB_PASS || "Secr3t1";'
chk_sens "PW259 getattr(settings, \"DB_PASS\", \"…\") 擋" 1 'p = getattr(settings, "DB_PASS", "Secr3t1")'
chk_sens "PW260 Laravel config('database.pass', '…') 擋" 1 "\$p = config('database.pass', 'Secr3t1');"
chk_sens "PW261 Spring \${smtp.pass:#{null}} 不擋" 0 '@Value("${smtp.pass:#{null}}") private String smtpPass;'
chk_sens "PW262 \${HF_TOKEN:-dummy} 不擋" 0 'export HF_TOKEN="${HF_TOKEN:-dummy}"'
chk_sens "PW263 result.passed || \"none\" 不擋" 0 'const x = result.passed || "none";'
# 第 32 輪：?.／-> 取屬性、default=／fallback= 關鍵字參數、configparser 區段參數、色碼值、函式名字邊界
chk_sens "PW264 config?.smtp?.pass ?? \"…\" 擋" 1 'const p = config?.smtp?.pass ?? "Secr3t1";'
chk_sens "PW265 PHP \$this->config->db_pass ?? '…' 擋" 1 "\$pass = \$this->config->db_pass ?? 'Secr3t1';"
chk_sens "PW266 decouple config(\"DB_PASS\", default=\"…\") 擋" 1 'DB_PASS = config("DB_PASS", default="Secr3t1")'
chk_sens "PW267 django-environ env(\"…_PASS\", default=\"…\") 擋" 1 'EMAIL_HOST_PASS = env("EMAIL_HOST_PASS", default="Mail2026")'
chk_sens "PW268 configparser get(\"database\", \"DB_PASS\", fallback=\"…\") 擋" 1 'db_pass = parser.get("database", "DB_PASS", fallback="Prod2026!")'
chk_sens "PW269 auth?.token ?? \"…\" 擋" 1 'const t = auth?.token ?? "abc123def";'
chk_sens "PW270 PHP \$this->api_token ?? '…' 擋" 1 "\$t = \$this->api_token ?? 'abc123def';"
chk_sens "PW271 config(\"API_TOKEN\", default=\"…\") 擋" 1 'API_TOKEN = config("API_TOKEN", default="abc123def")'
chk_sens "PW272 configparser token fallback= 擋" 1 't = parser.get("github", "API_TOKEN", fallback="ghp1234abcd")'
chk_sens "PW273 (process.env.DB_PASS) || \"…\" 擋" 1 'const p = (process.env.DB_PASS) || "Secr3t1";'
chk_sens "PW274 狀態色 theme.pass || \"#00ff00\" 不擋" 0 'const color = theme.pass || "#00ff00";'
chk_sens "PW275 狀態色物件 { pass: \"#22c55e\" } 不擋" 0 'const colors = { pass: "#22c55e", fail: "#ef4444" };'
chk_sens "PW276 設計 token theme.token ?? \"#0f0\" 不擋" 0 'const c = theme.token ?? "#0f0";'
chk_sens "PW277 widget(\"pass\", \"Step1\") 擋（第 34 輪起通用呼叫形狀，已知取捨）" 1 'widget("pass", "Step1");'
chk_sens "PW278 os.getenv(\"DB_PW\", default=\"…\") 擋" 1 'p = os.getenv("DB_PW", default="Secr3t1")'
chk_sens "PW279 getattr(obj, \"token\", None) 不擋" 0 't = getattr(obj, "token", None)'
# 第 33 輪涵蓋矩陣新增的寫法，端到端抽樣（全表在 PW280）
chk_sens "PW281 URI 內嵌密碼擋" 1 'DATABASE_URL = "postgres://admin:Secr3t1@db:5432/app"'
chk_sens "PW282 URI 變數密碼不擋" 0 'DATABASE_URL = "postgres://admin:${DB_PASS}@db/app"'
chk_sens "PW283 curl -u 帳號:密碼 擋" 1 'curl -u admin:Secr3t1 https://api.example.com'
chk_sens "PW284 docker run -u 1000:1000 不擋" 0 'docker run -u 1000:1000 img'
chk_sens "PW285 setter setDbPass(\"…\") 擋" 1 'ds.setDbPass("Secr3t1");'
chk_sens "PW286 XML appSettings 擋" 1 '<add key="DbPass" value="Secr3t1" />'
chk_sens "PW287 Rust unwrap_or 預設值擋" 1 'let p = env::var("DB_PASS").unwrap_or("Secr3t1".to_string());'
chk_sens "PW288 SQL IDENTIFIED BY 擋" 1 "CREATE USER app IDENTIFIED BY 'Secr3t1';"
chk_sens "PW289 Dockerfile ENV K V 擋" 1 'ENV DB_PASS Secr3t1'
chk_sens "PW290 --api-token 值 擋" 1 'app --api-token abc123def'
chk_sens "PW291 os.Setenv(\"DB_PASS\", \"…\") 擋" 1 'os.Setenv("DB_PASS", "Secr3t1")'
chk_sens "PW292 C 陣列 char db_pass[] 擋" 1 'char db_pass[] = "Secr3t1";'
chk_sens "PW293 DB_PASS=<your-pass> 不擋" 0 'DB_PASS=<your-pass>'
# 第 34 輪：通用呼叫形狀、字面值正規化、builder、變數引用不擋（全表在 PW280）
chk_sens "PW294 Rust String::from(\"…\") 擋" 1 'let db_pass = String::from("Secr3t1");'
chk_sens "PW295 .NET GetValue<string>(\"Db:Pass\", \"…\") 擋" 1 'var p = config.GetValue<string>("Db:Pass", "Secr3t1");'
chk_sens "PW296 builder .apiKey(\"…\") 擋" 1 'OpenAIClient c = OpenAIOkHttpClient.builder().apiKey("abc123def").build();'
chk_sens "PW297 GitHub Actions \${{ secrets.X }} 不擋" 0 '      DB_PASS: ${{ secrets.DB_PASS }}'
chk_sens "PW298 sqlcmd -P \$變數 不擋" 0 'sqlcmd -S db -U sa -P $SA_PW -i init.sql'
# 涵蓋矩陣（第 33 輪起）：語言／框架 × 寫法的固定清單，每列「期望 分類 內容」。分類 cfg 開頭的另走設定檔判準。
# 這裡直接套 flow.sh 的 pattern 與管線（字面值正規化 → 色碼 → 條件句冒號 → 比對；token 先轉小寫、刪 TOKEN_BENIGN），
# 一次跑完整張表；端到端的 prepare 由上面的 chk_sens／chk_cfg 抽樣覆蓋。矩陣外的寫法屬已知取捨，見 flow.sh 註解。
mx_hit() {
  local l="$1" cfg="$2" s t M=$'\001'
  s="$(printf '%s\n' "$l" | LC_ALL=C sed -E "$LITERAL_NORMALIZE_SED" | LC_ALL=C sed -E "s@$COLOR_LITERAL_PATTERN@\\1color\\3@g" | LC_ALL=C sed -E "s#$COND_COLON_PATTERN#\\1\\2$M#g")"
  printf '%s\n' "$s" | LC_ALL=C grep -qEi -- "$SENSITIVE_PATTERN" && return 0
  printf '%s\n' "$s" | LC_ALL=C grep -qE -- "$CAMEL_PASS_PATTERN" && return 0
  t="$(printf '%s\n' "$l" | LC_ALL=C tr '[:upper:]' '[:lower:]' | LC_ALL=C sed -E "$LITERAL_NORMALIZE_SED" | LC_ALL=C sed -E "s@$COLOR_LITERAL_PATTERN@\\1color\\3@g" | LC_ALL=C sed -E "s#$TOKEN_BENIGN##g" | LC_ALL=C sed -E "s#$COND_COLON_PATTERN#\\1\\2$M#g")"
  printf '%s\n' "$t" | LC_ALL=C grep -qE -- "$TOKEN_ASSIGN_PATTERN" && return 0
  [ "$cfg" = 1 ] || return 1
  printf '%s\n' "$l" | LC_ALL=C grep -Ei "$CONFIG_PWD_PATTERN" | LC_ALL=C grep -qEiv "$CONFIG_PWD_BENIGN" && return 0
  printf '%s\n' "$l" | LC_ALL=C grep -E "$CONFIG_CAMEL_PASS_PATTERN" | LC_ALL=C grep -qEiv "$CONFIG_PWD_BENIGN" && return 0
  return 1
}
(
  eval "$(grep -E '^(SENSITIVE_PATTERN|CAMEL_PASS_PATTERN|TOKEN_ASSIGN_PATTERN|TOKEN_BENIGN|COND_COLON_PATTERN|COLOR_LITERAL_PATTERN|LITERAL_NORMALIZE_SED|CONFIG_PWD_PATTERN|CONFIG_CAMEL_PASS_PATTERN|CONFIG_PWD_BENIGN)=' "$FLOW")"
  mxn=0; mxbad=()
  while IFS=$'\t' read -r exp cat line; do
    mxn=$((mxn+1)); got=0; c=0
    [ "${cat#cfg}" != "$cat" ] && c=1
    mx_hit "$line" "$c" && got=1
    [ "$got" = "$exp" ] || mxbad+=("期望 $exp 實得 $got [$cat] $line")
  done <<'MXEOF'
1	A-js	const DB_PASS = "Secr3t1";
1	A-js	let smtpPass = 'Secr3t1';
1	A-js	const apiToken = "abc123def";
1	A-ts	const dbPass: string = "Secr3t1";
1	A-ts	private readonly smtpPw: string = 'Secr3t1';
1	A-py	DB_PASS = "Secr3t1"
1	A-py	db_pass: str = "Secr3t1"
1	A-py	API_TOKEN = "abc123def"
1	A-go	dbPass := "Secr3t1"
1	A-go	var DBPass = "Secr3t1"
1	A-go	const apiToken = "abc123def"
1	A-java	private static final String DB_PASS = "Secr3t1";
1	A-java	String dbPass = "Secr3t1";
1	A-cs	string dbPass = "Secr3t1";
1	A-cs	public string SmtpPass { get; set; } = "Secr3t1";
1	A-cs	const string ApiToken = "abc123def";
1	A-kt	val dbPass = "Secr3t1"
1	A-kt	const val DB_PASS: String = "Secr3t1"
1	A-swift	let dbPass = "Secr3t1"
1	A-rust	let db_pass = "Secr3t1";
1	A-rust	const DB_PASS: &str = "Secr3t1";
1	A-php	$db_pass = 'Secr3t1';
1	A-php	$dbPass = "Secr3t1";
1	A-php	define('DB_PASS', 'Secr3t1');
1	A-rb	DB_PASS = "Secr3t1"
1	A-rb	@smtp_pass = 'Secr3t1'
1	A-sh	DB_PASS=Secr3t1
1	A-sh	export DB_PASS="Secr3t1"
1	A-sh	export API_TOKEN=abc123def
1	A-c	#define WIFI_PASS "Secr3t1"
1	A-c	const char *wifi_pass = "Secr3t1";
1	A-c	char db_pass[] = "Secr3t1";
1	A-cpp	std::string dbPass = "Secr3t1";
1	A-cpp	static const char* API_TOKEN = "abc123def";
1	A-ps	$DbPass = "Secr3t1"
1	A-ps	$env:DB_PASS = "Secr3t1"
1	A-bat	set DB_PASS=Secr3t1
1	A-vb	Dim dbPass As String = "Secr3t1"
1	A-lua	local db_pass = "Secr3t1"
1	A-dart	final dbPass = 'Secr3t1';
1	A-scala	val dbPass = "Secr3t1"
1	B-js	const cfg = { pass: "Secr3t1" };
1	B-js	auth: { user: "u", pass: "Secr3t1" },
1	B-js	{ "db_pass": "Secr3t1" }
1	B-js	{ apiToken: "abc123def" }
1	B-py	cfg = {"db_pass": "Secr3t1"}
1	B-py	conn = connect(host="h", passwd="Secr3t1")
1	B-py	conn = pymysql.connect(user="u", pw="Secr3t1")
1	B-py	client = Client(api_token="abc123def")
1	B-php	$cfg = ['db_pass' => 'Secr3t1'];
1	B-rb	cfg = { db_pass: "Secr3t1" }
1	B-rb	cfg = { :db_pass => "Secr3t1" }
1	B-go	cfg := Config{Pass: "Secr3t1"}
1	B-go	cfg := Config{DBPass: "Secr3t1"}
1	B-cs	var c = new Cfg { DbPass = "Secr3t1" };
1	B-kt	connect(dbPass = "Secr3t1")
1	B-yamljs	smtp: { pass: 'Secr3t1' }
1	C-py	os.environ["DB_PASS"] = "Secr3t1"
1	C-py	cfg["db_pass"] = "Secr3t1"
1	C-php	$cfg['db_pass'] = 'Secr3t1';
1	C-rb	ENV["DB_PASS"] ||= "Secr3t1"
1	C-rb	cfg[:db_pass] = "Secr3t1"
1	C-js	process.env.DB_PASS = "Secr3t1";
1	C-js	process.env["DB_PASS"] = "Secr3t1";
1	C-js	headers["x-api-token"] = "abc123def";
1	C-cs	Environment.SetEnvironmentVariable("DB_PASS", "Secr3t1");
1	C-go	os.Setenv("DB_PASS", "Secr3t1")
1	C-py	os.environ.setdefault("DB_PASS", "Secr3t1")
1	C-java	props.setProperty("db.pass", "Secr3t1");
1	C-java	props.put("db.pass", "Secr3t1");
1	D-js	const p = process.env.DB_PASS || "Secr3t1";
1	D-js	const p = process.env.DB_PASS ?? "Secr3t1";
1	D-js	const p = process.env["DB_PASS"] || "Secr3t1";
1	D-js	const p = config?.smtp?.pass ?? "Secr3t1";
1	D-js	const { DB_PASS = "Secr3t1" } = process.env;
1	D-js	const t = import.meta.env.VITE_API_TOKEN ?? "abc123def";
1	D-py	p = os.getenv("DB_PASS", "Secr3t1")
1	D-py	p = os.environ.get("DB_PASS", "Secr3t1")
1	D-py	p = os.getenv("DB_PASS", default="Secr3t1")
1	D-py	p = os.getenv("DB_PASS") or "Secr3t1"
1	D-py	p = config("DB_PASS", default="Secr3t1")
1	D-py	p = env("DB_PASS", default="Secr3t1")
1	D-py	p = parser.get("database", "DB_PASS", fallback="Secr3t1")
1	D-py	p = getattr(settings, "DB_PASS", "Secr3t1")
1	D-py	p = settings.DB_PASS or "Secr3t1"
1	D-py	t = os.getenv("API_TOKEN", "abc123def")
1	D-php	$p = getenv('DB_PASS') ?: 'Secr3t1';
1	D-php	$p = $_ENV['DB_PASS'] ?? 'Secr3t1';
1	D-php	$p = env('DB_PASS', 'Secr3t1');
1	D-php	$p = config('database.pass', 'Secr3t1');
1	D-php	$p = $this->config->db_pass ?? 'Secr3t1';
1	D-rb	p = ENV.fetch("DB_PASS", "Secr3t1")
1	D-rb	p = ENV.fetch("DB_PASS") { "Secr3t1" }
1	D-rb	p = ENV["DB_PASS"] || "Secr3t1"
1	D-java	String p = System.getenv().getOrDefault("DB_PASS", "Secr3t1");
1	D-java	String p = System.getProperty("db.pass", "Secr3t1");
1	D-java	String p = Optional.ofNullable(System.getenv("DB_PASS")).orElse("Secr3t1");
1	D-java	@Value("${db.pass:Secr3t1}") private String p;
1	D-kt	val p = System.getenv("DB_PASS") ?: "Secr3t1"
1	D-cs	var p = Environment.GetEnvironmentVariable("DB_PASS") ?? "Secr3t1";
1	D-cs	var p = config["Db:Pass"] ?? "Secr3t1";
1	D-go	p := getEnv("DB_PASS", "Secr3t1")
1	D-go	p := cmp.Or(os.Getenv("DB_PASS"), "Secr3t1")
1	D-rust	let p = env::var("DB_PASS").unwrap_or("Secr3t1".to_string());
1	D-rust	let p = env::var("DB_PASS").unwrap_or_else(|_| "Secr3t1".into());
1	D-sh	DB_PASS="${DB_PASS:-Secr3t1}"
1	D-sh	: "${DB_PASS:=Secr3t1}"
1	D-js	const t = process.env.API_TOKEN || "abc123def";
1	D-rust	let t = env::var("API_TOKEN").unwrap_or("abc123def".into());
1	E-uri	DATABASE_URL = "postgres://admin:Secr3t1@db:5432/app"
1	E-uri	const uri = "mongodb+srv://admin:Secr3t1@cluster0.example.net/app";
1	E-uri	redis_url = "redis://:Secr3t1@cache:6379/0"
1	E-uri	amqp://guest:Secr3t1@rabbit:5672/
1	E-net	"Server=db;User Id=sa;Password=Secr3t1;"
1	E-net	"Server=db;Uid=sa;Pwd=Secr3t1;"
1	E-jdbc	jdbc:mysql://db/app?user=root&password=Secr3t1
1	F-cli	mysql -uroot -pSecr3t1 app
1	F-cli	sqlcmd -S db -U sa -P Secr3t1
1	F-cli	curl -u admin:Secr3t1 https://api.example.com
1	F-cli	sshpass -p 'Secr3t1' ssh u@h
1	F-cli	app --db-pass=Secr3t1
1	F-cli	app --api-token abc123def
1	F-cli	PGPASSWORD=Secr3t1 psql -h db
1	G-http	headers: { Authorization: "Bearer abc123def" }
1	G-http	-H "X-Api-Key: abc123def"
1	G-http	req.Header.Set("X-Api-Key", "abc123def")
1	G-http	headers = {"Authorization": "Token abc123def"}
1	cfg-env	DB_PASS=Secr3t1
1	cfg-env	DB_PASS="Secr3t1"
1	cfg-env	export DB_PASS=Secr3t1
1	cfg-env	API_TOKEN=abc123def
1	cfg-yaml	  password: Secr3t1
1	cfg-yaml	  pass: Secr3t1
1	cfg-yaml	  dbPass: Secr3t1
1	cfg-yaml	      - DB_PASS=Secr3t1
1	cfg-yaml	  api_token: abc123def
1	cfg-ini	pass = Secr3t1
1	cfg-ini	db_pass=Secr3t1
1	cfg-prop	db.pass=Secr3t1
1	cfg-prop	spring.datasource.password=Secr3t1
1	cfg-toml	db_pass = "Secr3t1"
1	I-json	"DbPass": "Secr3t1",
1	I-json	"db_pass": "Secr3t1",
1	I-json	"apiToken": "abc123def",
1	I-xml	<add key="DbPass" value="Secr3t1" />
1	I-xml	<add key="DB_PASS" value="Secr3t1" />
1	I-xml	<dbPass>Secr3t1</dbPass>
1	I-xml	<db.pass>Secr3t1</db.pass>
1	I-xml	<apiToken>abc123def</apiToken>
1	J-java	ds.setPass("Secr3t1");
1	J-java	ds.setDbPass("Secr3t1");
1	J-java	client.setApiToken("abc123def");
1	J-java	builder.pass("Secr3t1").build();
1	J-js	client.withToken("abc123def");
1	K-sql	CREATE USER app IDENTIFIED BY 'Secr3t1';
1	K-sql	ALTER USER app WITH PASSWORD 'Secr3t1';
1	L-docker	ENV DB_PASS=Secr3t1
1	L-docker	ENV DB_PASS Secr3t1
1	L-docker	ARG DB_PASS=Secr3t1
0	N-read	const p = process.env.DB_PASS;
0	N-read	p = os.getenv("DB_PASS")
0	N-read	p = os.environ["DB_PASS"]
0	N-read	$p = getenv('DB_PASS');
0	N-read	String p = System.getenv("DB_PASS");
0	N-read	p := os.Getenv("DB_PASS")
0	N-read	let p = env::var("DB_PASS")?;
0	N-read	@Value("${db.pass}") private String p;
0	N-read	p = parser.get("database", "DB_PASS")
0	N-var	const p = process.env.DB_PASS || defaultPass;
0	N-var	db_pass = args.db_pass
0	N-var	cfg.pass = input.value;
0	N-var	DB_PASS="${DB_PASS}"
0	N-var	export DB_PASS=$DB_PASS
0	N-var	DATABASE_URL = "postgres://admin:${DB_PASS}@db/app"
0	N-var	curl -u "$USER:$PASS" https://api.example.com
0	N-var	mysql -u root -p app
0	N-ph	DB_PASS=<your-pass>
0	N-ph	const uri = "postgres://user@localhost/app";
0	N-ph	const doc = "https://example.com/docs";
0	N-ph	API_TOKEN=changeme
0	N-ph	api_token: your_token_here
0	N-ph	const u = "http://localhost:3000/api";
0	N-ph	app --api-token <TOKEN>
0	N-word	const bypass = "skip1";
0	N-word	const compass = "N1";
0	N-word	passport = "P1234567"
0	N-word	const passage = "Chapter 1";
0	N-word	if result.pass: print("ok")
0	N-word	const label = "Pass";
0	N-word	expect(result.pass).toBe(true);
0	N-word	const color = theme.pass || "#00ff00";
0	N-word	const colors = { pass: "#22c55e", fail: "#ef4444" };
0	N-word	const STATUS = { pass: "PASS", fail: "FAIL" };
1	T-取捨	widget("pass", "Step1");
0	N-word	t = getattr(obj, "token", None)
0	N-word	const x = result.passed || "none";
0	N-word	pageToken = "abc123def"
0	N-word	next_page_token: "abc123def"
0	N-word	const csrfToken = req.csrfToken();
0	N-word	token = await getToken();
0	N-word	user.pass || "Step 1"
0	N-word	messages.pass ?? "OK"
0	N-word	ds.setPass(pw);
0	N-word	client.withToken(token);
0	N-word	ENV DB_PASS=""
0	N-word	ARG DB_PASS
0	N-word	CREATE USER app IDENTIFIED BY :pw;
0	cfg-yaml	  pass: ${DB_PASS}
0	cfg-yaml	  pass: true
0	cfg-env	DB_PASS=
0	cfg-ini	; pass =
0	cfg-yaml	  next_page_token: abc
0	I-xml	<add key="DbPass" value="" />
0	I-xml	<add key="DbPass" value="%DB_PASS%" />
0	I-xml	<dbPass>${DB_PASS}</dbPass>
0	E-uri	const u = "http://user:@host/";
0	E-uri	const re = /^(\w+):\/\/([^:]+):([^@]+)@/;
0	N-new	docker run -u 1000:1000 img
0	N-new	git push -u origin main
0	N-new	const u = "https://user@github.com/org/repo";
0	N-new	map.put("pass", "OK");
0	N-new	props.setProperty("db.pass", pw);
0	N-new	<pass>true</pass>
0	N-new	app --api-token "$TOKEN"
0	N-new	String p = Optional.ofNullable(System.getenv("DB_PASS")).orElse("");
0	N-new	t.pass("ok");
0	N-new	Dim pass As Boolean = True
0	N-new	sshpass -e ssh u@h
0	N-new	sshpass -p "$PW" ssh u@h
0	N-new	ENV DB_PASS_FILE /run/keys/db_file
0	N-new	curl -u "$USER:$PASS" https://x
0	N-new	curl -u admin https://x
0	N-new	const re = "^https?://[^:]+:[^@]+@";
0	N-new	let p = env::var("DB_PASS").unwrap_or_default();
0	N-new	os.Setenv("DB_PASS", pw)
0	N-new	localStorage.setItem("api_token", token);
0	N-new	CREATE USER app IDENTIFIED BY :pw;
0	N-new	config["Db:Pass"] ?? throw new Exception();
0	N-new	const link = "http://localhost:8080/login";
0	N-new	const ws = "ws://127.0.0.1:9229/abc";
1	N-new	const link = "https://admin:Secr3t1@example.com/";
1	A-rust	let db_pass = String::from("Secr3t1");
1	A-cpp	std::string dbPass("Secr3t1");
1	A-cs	string dbPass = @"Secr3t1";
1	A-cs	string dbPass = $"Secr3t1";
1	A-java	String dbPass = new String("Secr3t1");
1	A-swift	let dbPass = String("Secr3t1")
1	A-go	dbPass := []byte("Secr3t1")
1	A-py	db_pass = str("Secr3t1")
1	A-py	db_pass = b"Secr3t1"
1	A-py	db_pass = r"Secr3t1"
1	A-py	db_pass = f"Secr3t1"
1	A-rust	let db_pass = r#"Secr3t1"#;
1	A-kt	val dbPass = """Secr3t1"""
1	A-scala	val dbPass = s"Secr3t1"
1	C-rust	env::set_var("DB_PASS", "Secr3t1");
1	C-rust	std::env::set_var("API_TOKEN", "abc123def");
1	C-cs	dict.Add("DbPass", "Secr3t1");
1	C-py	os.putenv("DB_PASS", "Secr3t1")
1	D-py	p = env.str("DB_PASS", default="Secr3t1")
1	D-cs	var p = config.GetValue<string>("Db:Pass", "Secr3t1");
1	D-cs	var p = config.GetValue("Db:Pass", "Secr3t1");
1	D-scala	val p = sys.env.getOrElse("DB_PASS", "Secr3t1")
1	D-ps	$p = $env:DB_PASS ?? "Secr3t1"
1	D-cs	var p = Environment.GetEnvironmentVariable("DB_PASS") ?? @"Secr3t1";
1	J-java	OpenAIClient c = OpenAIOkHttpClient.builder().apiKey("abc123def").build();
1	J-java	builder.token("abc123def");
1	J-java	builder.accessToken("abc123def");
1	K-sql	CREATE USER app IDENTIFIED BY Secr3t1;
1	F-cli	docker login -u u -p Secr3t1 registry.example.com
1	F-cli	curl -uadmin:Secr3t1 https://api.example.com
1	I-xml	<add value="Secr3t1" key="DbPass" />
1	I-xml	<add key = "DbPass" value = "Secr3t1" />
1	I-xml	<property name="db.pass" value="Secr3t1"/>
1	I-xml	<env name="DB_PASS" value="Secr3t1"/>
1	I-xml	<add value="abc123def" key="ApiToken" />
0	N-r34	      DB_PASS: ${{ secrets.DB_PASS }}
0	N-r34	      API_TOKEN: ${{ secrets.API_TOKEN }}
0	N-r34	      token: ${{ secrets.GITHUB_TOKEN }}
0	N-r34	sqlcmd -S db -U sa -P $SA_PW -i init.sql
0	N-r34	sqlcmd -S db -U sa -P ${SA_PW}
0	N-r34	sqlcmd -S db -U sa -P "$env:SA_PW"
0	N-r34	sqlcmd -S db -U sa -P %SA_PW%
0	N-r34	docker login -u u -p "$REG_PW" registry.example.com
0	N-r34	CREATE USER app IDENTIFIED BY VALUES 'S:ABC';
0	N-r34	CREATE USER app IDENTIFIED EXTERNALLY;
0	N-r34	assert.equal(res.status, "pass", "case 1");
0	N-r34	t.deepEqual(r, ["pass", "fail"]);
0	N-r34	const label = i18n.t("auth.pass");
0	N-r34	logger.info("pass", count);
0	N-r34	const s = String(value);
0	N-r34	echo "$@"
0	N-r34	const t = jwt.verify(token, key);
0	N-r34	builder.token(token).build();
0	N-r34	<add key="DbPass" value="" />
0	N-r34	<property name="db.pass" value="${db.pass}"/>
0	N-r34	git commit -m "fix: login -p flag"
0	N-r34	ssh -p 2222 user@host
MXEOF
  echo "$mxn" > "$ROOT/mx.count"
  printf '%s\n' "${mxbad[@]+"${mxbad[@]}"}" > "$ROOT/mx.bad"
)
mxc="$(cat "$ROOT/mx.count" 2>/dev/null || echo 0)"
if [ "$mxc" -ge 298 ] && [ -z "$(tr -d '\n' < "$ROOT/mx.bad")" ]; then ok "PW280 涵蓋矩陣 $mxc 列全部符合"; else bad "PW280 涵蓋矩陣 $mxc 列全部符合" "$(cat "$ROOT/mx.bad")"; fi
# analyze 與 prepare 共用同一套判準
git -C "$(R s1)" reset -q --hard HEAD; printf 'DB_PWD = Prod(2026)\n' > "$(R s1)/.env"; git -C "$(R s1)" add .env
expect "PW46 analyze 跑得完" 0 flow analyze s1
has "PW46b analyze 也報設定檔的命中" "DB_PWD = Prod(2026)"
git -C "$(R s1)" reset -q --hard HEAD

# ================= 13. 審查單與 hook 抓回覆（2026-10-19）=================
# hook 本身：只在審查單有效、代理種類對、回覆有結論行時寫檔
new_repo h1
put h1 a.txt 1
flow prepare h1 a.txt >/dev/null
id1="$(ticket h1)"
[[ "$id1" =~ ^gcf-[0-9a-f]{16}$ ]] && ok "H01 prepare 發審查單" || bad "H01 prepare 發審查單" "$id1"
grep -qxF "state_dir=$(git -C "$(R h1)" rev-parse --absolute-git-dir)/git-commit-flow" "$GIT_COMMIT_TICKET_DIR/$id1" 2>/dev/null && ok "H01b 登記處指向這個 repo 的狀態目錄" || bad "H01b 登記處指向這個 repo 的狀態目錄" "$(cat "$GIT_COMMIT_TICKET_DIR/$id1" 2>&1)"
hout="$(capture h1 codex $'分析如下……\n\nVERDICT: BLOCK')"
[ "$(sed -n 3p "$(reply_of h1 codex)" 2>/dev/null)" = "verdict=BLOCK" ] && ok "H02 Codex 把 VERDICT 放最後一行也抓得到" || bad "H02 Codex 把 VERDICT 放最後一行也抓得到" "$(ls "$(state h1 '')")"
[ -z "$hout" ] && ok "H02b hook 不輸出任何 decision" || bad "H02b hook 不輸出任何 decision" "$hout"
grep -qF '分析如下……' "$(reply_of h1 codex)" && ok "H02c 存的是回覆原文" || bad "H02c 存的是回覆原文"
capture h1 reviewer $'**VERDICT: PASS**\n- a.txt:1 [Minor] x' >/dev/null
[ "$(sed -n 3p "$(reply_of h1 reviewer)" 2>/dev/null)" = "verdict=PASS" ] && ok "H03 Markdown 包住的 VERDICT 抓得到" || bad "H03 Markdown 包住的 VERDICT 抓得到"
nrep() { ls "$(state h1 '')" | grep -c '^reply-' || true; }
n0="$(nrep)"
capture_raw $'請審查 staged diff（沒帶審查單）' "VERDICT: BLOCK" codex:codex-rescue
capture_raw "[git-commit 審查單 gcf-0000000000000000 codex]" "VERDICT: BLOCK" codex:codex-rescue
capture_raw "[git-commit 審查單 $id1 arbiter]" "RULING: EDGE" general-purpose
capture_raw "[git-commit 審查單 $id1 codex]" "VERDICT: UNAVAILABLE exit 2" codex:codex-rescue
[ "$(nrep)" = "$n0" ] && ok "H04 沒審查單／不認得的審查單／仲裁不是 Codex／沒有結論行：都不寫" || bad "H04 沒審查單／不認得的審查單／仲裁不是 Codex／沒有結論行：都不寫" "$(ls "$(state h1 '')")"
capture_raw "[git-commit 審查單 $id1 reviewer]" "VERDICT: BLOCK" codex:codex-rescue
[ "$(sed -n 3p "$(reply_of h1 reviewer)")" = "verdict=PASS" ] && ok "H05 C 軌審查單由 codex 代理回的不收" || bad "H05 C 軌審查單由 codex 代理回的不收"
capture_raw "[git-commit 審查單 $id1 codex]" "VERDICT: BLOCK" general-purpose
[ "$(sed -n 6p "$(reply_of h1 codex)")" = "---" ] && [ "$(sed -n 4p "$(reply_of h1 codex)")" = "agent_type=codex:codex-rescue" ] && ok "H06 B 軌審查單由非 codex 代理回的不收" || bad "H06 B 軌審查單由非 codex 代理回的不收"
capture_raw "前言"$'\n'"[git-commit 審查單 $id1 arbiter]（派工識別碼）" $'- x [極端]\nRULING: EDGE' codex:codex-rescue no-last
[ "$(sed -n 3p "$(reply_of h1 arbiter)" 2>/dev/null)" = "verdict=EDGE" ] && ok "H07 payload 沒帶 last_assistant_message 時從 transcript 讀回覆" || bad "H07 payload 沒帶 last_assistant_message 時從 transcript 讀回覆"
capture h1 arbiter $'- x [一般]
RULING: GENERAL' >/dev/null
[ "$(sed -n 3p "$(reply_of h1 arbiter)" 2>/dev/null)" = "verdict=EDGE" ] && ok "H07b 同一張審查單再派仲裁不覆寫第一份判定" || bad "H07b 同一張審查單再派仲裁不覆寫第一份判定"
hout="$(printf 'not json' | node "$HOOK" 2>&1)"; hrc=$?
[ "$hrc" -eq 0 ] && [ -z "$hout" ] && ok "H08 輸入壞掉 fail-open（exit 0、不輸出）" || bad "H08 輸入壞掉 fail-open（exit 0、不輸出）" "rc=$hrc $hout"
# 登記處被指到不是 git-commit-flow 的目錄：不寫
mkdir -p "$ROOT/evil"; printf 'id=gcf-1111111111111111\n' > "$ROOT/evil/ticket"
printf 'state_dir=%s\n' "$(winp "$ROOT/evil")" > "$GIT_COMMIT_TICKET_DIR/gcf-1111111111111111"
capture_raw "[git-commit 審查單 gcf-1111111111111111 codex]" "VERDICT: BLOCK" codex:codex-rescue
[ -z "$(ls "$ROOT/evil" | grep '^reply-')" ] && ok "H09 登記處指向別的目錄不寫" || bad "H09 登記處指向別的目錄不寫"
node -e 'const h=require(process.argv[1]).hooks.SubagentStop; if(!JSON.stringify(h).includes("capture-review-reply.js")) process.exit(1)' "$(winp "$(dirname "$HOOK")/hooks.json")" && ok "H10 hooks.json 掛上 SubagentStop" || bad "H10 hooks.json 掛上 SubagentStop"

# prepare 的閘：這一輪抓到 BLOCK、還沒記類別 → --redo 也擋
put h1 a.txt 2
expect "T01 抓到 BLOCK 後 prepare --redo 擋" 1 flow prepare h1 a.txt --redo
has "T01b 說明 hook 抓到 BLOCK" "hook 抓到 BLOCK（codex）"
git -C "$(R h1)" diff --cached | grep -q '^+2$' && bad "T01c 被擋時不 git add" || ok "T01c 被擋時不 git add"
expect "T01d 不帶 --redo 一樣擋" 1 flow prepare h1 a.txt
# review-record：貼的結論跟抓到的不同就拒收
expect "T02 抓到 BLOCK 卻貼 PASS：拒收" 1 flow review-record h1 --codex "$PASS_REPLY" --reviewer "$PASS_REPLY"
has "T02b 說明跟 hook 抓到的不同" "hook 抓到 BLOCK，貼的是 PASS"
expect "T03 照抓到的結論記類別" 0 flow review-record h1 --codex "$BLOCK_REPLY" --reviewer "$PASS_REPLY" --block-classes "一般問題"
expect "T04 記過類別可開下一輪" 0 flow prepare h1 a.txt
has "T04b 第 2 輪" "審查第 2 輪"
[ "$(ticket h1)" != "$id1" ] && [ ! -f "$GIT_COMMIT_TICKET_DIR/$id1" ] && [ -z "$(ls "$(state h1 '')" | grep "^reply-$id1")" ] && ok "T04c 舊審查單、登記與抓到的回覆都作廢" || bad "T04c 舊審查單、登記與抓到的回覆都作廢"
old2="$(ticket h1)"
# 只抓到一軌 PASS（另一軌沒回）：當作沒審完，--redo 留在同一輪
capture h1 codex "VERDICT: PASS"
put h1 a.txt 3
expect "T05 只抓到 PASS、還沒記：--redo 放行" 0 flow prepare h1 a.txt --redo
has "T05b 留在第 2 輪" "審查第 2 輪"
# 舊審查單的回覆晚到：登記已刪，不寫
capture_raw "[git-commit 審查單 $old2 codex]" "VERDICT: BLOCK" codex:codex-rescue
[ ! -f "$(state h1 "reply-$old2-codex")" ] && ok "T06 舊審查單晚到的回覆不寫" || bad "T06 舊審查單晚到的回覆不寫"
# 內容閘擋下的 prepare 不換審查單：之後才抓到的 BLOCK 照樣擋
t3="$(ticket h1)"
put h1 a.txt 'const cs = "Pwd=abc";'
expect "T07 內容閘擋下（審查單不換）" 1 flow prepare h1 a.txt --redo
[ "$(ticket h1)" = "$t3" ] && ok "T07b 審查單沒換" || bad "T07b 審查單沒換"
capture h1 reviewer "VERDICT: BLOCK"
printf '%s\n' 1 2 3 4 > "$(R h1)/a.txt"
expect "T07c 晚到的 BLOCK 照樣擋 --redo" 1 flow prepare h1 a.txt --redo
has "T07d 點名 reviewer 軌" "hook 抓到 BLOCK（reviewer）"
# ship：記成通過之後又抓到 BLOCK（重派那一軌）→ 以抓到的為準
new_repo h2
put h2 a.txt 1; flow prepare h2 a.txt >/dev/null
capture h2 codex "VERDICT: PASS"; capture h2 reviewer "VERDICT: PASS"
expect "T08 兩軌 PASS（跟抓到的一致）照常記錄" 0 flow review-record h2 --codex "$PASS_REPLY" --reviewer "$PASS_REPLY"
has "T08b 輸出抓到的回覆" "hook 抓到的回覆：Codex PASS／code-reviewer PASS"
capture h2 reviewer "VERDICT: BLOCK"
expect "T09 記成通過後又抓到 BLOCK：ship 擋" 1 flow ship h2 Fix "不該放行"
has "T09b 說明以抓到的為準" "紀錄卻是通過"
expect "T10 使用者明示豁免不受影響" 0 flow review-record h2 --exempt "使用者：先 commit"
expect "T10b 豁免可 ship" 0 flow ship h2 Fix "使用者豁免"
[ ! -f "$(state h2 ticket)" ] && ! grep -rqF "$(git -C "$(R h2)" rev-parse --absolute-git-dir)/git-commit-flow" "$GIT_COMMIT_TICKET_DIR" && ok "T10c commit 後審查單與登記清掉" || bad "T10c commit 後審查單與登記清掉"
[ -f "$GIT_COMMIT_TICKET_DIR/$(ticket h1)" ] && ok "T10d 別的 repo 的登記不受影響" || bad "T10d 別的 repo 的登記不受影響"
# 沒抓到任何回覆：照舊收自陳，但講明
new_repo h3
put h3 a.txt 1; flow prepare h3 a.txt >/dev/null
expect "T11 沒抓到回覆照舊收" 0 flow review-record h3 --codex "$PASS_REPLY" --reviewer "$PASS_REPLY"
has "T11b 講明只有自陳" "hook 抓到的回覆：無"
# 換一批：上一批抓到的 BLOCK 不擋新的一批
new_repo h4
put h4 a.txt 1; flow prepare h4 a.txt >/dev/null
capture h4 codex "VERDICT: BLOCK"
git -C "$(R h4)" reset -q a.txt; rm -f "$(R h4)/a.txt"; put h4 b.txt 1
expect "T12 換一批不被上一批的 BLOCK 擋" 0 flow prepare h4 b.txt
has "T12b 從第 1 輪算" "審查第 1 輪"
# skipped 的那軌其實有抓到回覆：拒收
new_repo h5
put h5 a.txt 1; flow prepare h5 a.txt >/dev/null
capture h5 reviewer "VERDICT: PASS"
expect "T13 抓到回覆卻記 skipped：拒收" 1 flow review-record h5 --codex "$PASS_REPLY" --reviewer "skipped: general-purpose 第三層也失敗"
# 結論行規則跟 hook 一致：hook 收的原文 review-record 也要收，否則抓到的 BLOCK 記不進來、下一輪被擋住
new_repo h6
put h6 a.txt 1; flow prepare h6 a.txt >/dev/null
LAST_BLOCK=$'分析如下……\n- a.txt:1 [一般] x\n\nVERDICT: BLOCK'
LAST_PASS=$'看過了。\n\n**VERDICT: PASS**'
capture h6 codex "$LAST_BLOCK"; capture h6 reviewer "$LAST_PASS"
expect "T14 結論在最後一行的 BLOCK 原文可以記類別" 0 flow review-record h6 --codex "$LAST_BLOCK" --reviewer "$LAST_PASS" --block-classes "一般問題"
put h6 a.txt 2
expect "T14b 記過類別可開下一輪" 0 flow prepare h6 a.txt
capture h6 codex "$LAST_PASS"; capture h6 reviewer "$LAST_PASS"
expect "T14c 結論在最後一行（Markdown 包住）的 PASS 原文照收" 0 flow review-record h6 --codex "$LAST_PASS" --reviewer "$LAST_PASS"
expect "T14d 最後一行是 BLOCK 的原文不能記成通過" 1 flow review-record h6 --codex "$LAST_BLOCK" --reviewer "$LAST_PASS"
[ ! -f "$(state h6 review.rec)" ] && ok "T14e 最後一行是 BLOCK 也作廢既有紀錄" || bad "T14e 最後一行是 BLOCK 也作廢既有紀錄"
expect "T14f 第一行跟最後一行都不是結論行：拒收" 1 flow review-record h6 --codex $'前言\nVERDICT: PASS\n結語' --reviewer "$LAST_PASS"
capture_raw "[git-commit 審查單 $(ticket h6) codex]" $'x\nVERDICT: BLOCK.' codex:codex-rescue
capture_raw "[git-commit 審查單 $(ticket h6) codex]" $'VERDICT: PASSED' codex:codex-rescue
[ "$(sed -n 3p "$(reply_of h6 codex)")" = "verdict=PASS" ] && ok "H11 結論字後面接句點或別的字：hook 不收（跟 flow.sh 一致）" || bad "H11 結論字後面接句點或別的字：hook 不收（跟 flow.sh 一致）" "$(sed -n 3p "$(reply_of h6 codex)")"

echo ""
echo "=== 結果：PASS $pass / FAIL $fail ==="
[ "$fail" -gt 0 ] && printf '  - %s\n' "${failed[@]}"
rm -rf "$ROOT"
[ "$fail" -eq 0 ]
