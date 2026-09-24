#!/usr/bin/env bash
# ============================================================
# block-bare-git-commit.sh — PreToolUse hook
#
# 目的：攔截 AI 直接建立 commit 或改寫 HEAD，強制走 git-commit skill 的 flow.sh。
#
# 為什麼需要這個：
#   本 skill 明寫「AI 禁止直接執行 git commit」，flow.sh 也備妥六道真閘，
#   但那全是「自律」——AI 直接跑 git commit 就整套繞過，六道閘一道都不會觸發。
#   skill 的「必須」AI 會繞，只有 hook 是他律。
#
# 射程（2026-09-14 擴大，依實際事故）：
#   ① porcelain：git commit（含 --amend）
#   ② plumbing：git commit-tree（建 commit 物件）
#   ③ ref 改寫：git update-ref / symbolic-ref / branch -f（讓 commit 生效，或藏掉 commit）
#   ④ git merge --continue（2026-09-24）：收尾衝突 merge 時內部就是 git commit，
#      只擋 git commit 不擋它等於留一條旁路。git merge 本身維持放行（使用者決定）。
#
#   ②③ 是 2026-09-14 真實被踩到的路徑：一個 headless 引擎被 ① 擋下後，改用
#   `write-tree` + `commit-tree` + `update-ref` 完成了四個 worktree 的 merge commit，
#   hook 完全沒反應、靜默通過，事後靠該 session 自願記帳才被發現。
#   三件組等價於 git commit，但字面上完全不像 commit，翻 log 不會停留。
#
#   刻意不攔：
#     - git write-tree —— 單獨用只建 tree 物件、不動任何 ref，是無害的；
#       git stash 的內部實作與 diff-tree 比對都會用到，攔了會誤傷。
#       它要配 commit-tree 才有殺傷力，而 commit-tree 已被攔。
#     - git reset / rebase / filter-branch / cherry-pick —— 改寫既有歷史是使用者的
#       明確意圖，不是「偷繞 commit 閘」的路徑；
#       且 reset --hard 清工作區、rebase 日常開發都常用，攔了會頻繁誤擋。
#     - git push —— 超出本 hook 職責（它只管「建 commit」），另議。
#
# 放行條件：GIT_COMMIT_FLOW=1（由 flow.sh 自己 export，代表已走完整流程）。
#   ⚠ 這個變數必須由 flow.sh 這個 process 匯出，外部設不進來——
#     hook 是獨立 process，讀的是自己的環境。詳見下方攔截訊息。
#
# ⚠️ fail-open：本 hook 任何自身錯誤都必須放行並印警告，
#    絕不能把使用者鎖在「無法 commit」的狀態。
# ============================================================

# fail-open 總開關：任何非預期錯誤都放行
set +e

payload="$(cat 2>/dev/null)" || exit 0
[ -z "$payload" ] && exit 0

# 取出 Bash 工具的 command 參數。優先用 python 解 JSON（可靠），無 python 則 fallback grep。
extract_command() {
  local py
  py="$(command -v python3 2>/dev/null || command -v python 2>/dev/null)"
  if [ -n "$py" ]; then
    printf '%s' "$payload" | "$py" -c '
import sys, json
try:
    d = json.load(sys.stdin)
    print(d.get("tool_input", {}).get("command", "") or "")
except Exception:
    pass
' 2>/dev/null
  else
    printf '%s' "$payload" | grep -o '"command"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*:[[:space:]]*"//; s/"$//'
  fi
}

cmd="$(extract_command)"
[ -z "$cmd" ] && exit 0

# 已在 flow.sh 流程內 → 放行。
# 這是唯一可靠的放行條件：flow.sh 執行時自己 export 這個變數給子程序，
# 所以「真的經過 flow.sh」與「這個變數存在」是同一件事，偽造不了
# （hook 是獨立 process，外部 inline 前綴／export／env 都設不進來）。
[ "${GIT_COMMIT_FLOW:-}" = "1" ] && exit 0

# ---- 攔截判斷 ----
# 順序很重要：先判「這條指令有沒有在建 commit 或改 ref」，再談放行。
# 反過來寫（先找放行特徵、命中就 exit 0）會被「一條指令裡同時出現放行特徵與
# 違規操作」整個繞過——例如 `git commit -m x; flow.sh`、`bash flow.sh --help; git commit -m x`。
# 那種寫法在 2026-09-14 的雙軌審查中被實測繞過確認，故本版不再用字串特徵放行。

# ---- 偵測：這條指令有沒有在建 commit 或改寫 ref ----
# 判斷邏輯在同目錄的 detect-git-write.py（獨立檔，可單獨測試與審查）。
#
# 為什麼不用 regex：shell 指令的變形空間比 regex 能表達的大。五輪審查各抓到一批漏法——
# 指令替換 $(...)、含 = 的全域選項、值含空白的 -c user.name="A B"、旗標置於參數之後、
# 重導向被算成參數或插在子指令之前、bash -c/eval/xargs 包一層字串、變數展開、
# -c alias.x=commit——每補一個 regex 就冒出下一個。
# 偵測器改用 shlex 按 shell 規則斷詞後遞迴解析，判斷「第幾個 token 是什麼」。
#
# python 或偵測器不存在時退回不擋（fail-open）：本 hook 的底線是絕不把使用者鎖在
# 無法 commit 的狀態，寧可漏擋也不能誤鎖。
hit=""
PY_BIN="$(command -v python3 2>/dev/null || command -v python 2>/dev/null)"
DETECTOR="$(dirname "$0")/detect-git-write.py"
if [ -n "$PY_BIN" ] && [ -f "$DETECTOR" ]; then
  hit="$(printf '%s' "$cmd" | "$PY_BIN" "$DETECTOR" 2>/dev/null)"
fi

if [ -n "$hit" ]; then
  cat >&2 <<MSG
⛔ 已攔截：\`$hit\`

本專案的 commit 一律走 git-commit skill，不直接下 git 指令。
理由：flow.sh 有六道機制閘（AI 署名／單行／diff hash TOCTOU／敏感字／
建置產物／message 痕跡與長度），繞過去這六道一道都不會觸發。

正確做法：
  flow.sh analyze <repo>
  flow.sh prepare <repo> <files...>
  flow.sh ship    <repo> <Type> "<描述>"        # 加 --push 才推遠端
  flow.sh amend   <repo> --confirm-rewrite      # 改寫 HEAD（需使用者明示核可）

merge 停在衝突／--no-commit 要收尾（flow.sh 沒有 merge 子命令，用 ship）：
  flow.sh prepare <repo> <解完的檔案...>       # 或 --staged 沿用已 stage 的內容
  flow.sh review-record <repo> ...
  flow.sh ship    <repo> Chore "合併 <分支>"   # MERGE_HEAD 存在時建出的就是 merge commit

⚠️ 不要試圖自己設 GIT_COMMIT_FLOW=1 繞過。
   那個變數由 flow.sh 自己 export 給它的子程序，你從外部設不進來——
   inline 前綴（GIT_COMMIT_FLOW=1 git commit）、export、env 全部無效，
   因為本 hook 是獨立 process，讀的是自己的環境，看不到你那一行。
   唯一入口是呼叫 flow.sh。

⚠️ 也不要改用 plumbing 繞路。
   commit-tree / update-ref / symbolic-ref / branch -f / merge --continue 都已在射程內——
   它們合起來等價於 git commit，本 hook 一併攔截。

做不到就停下來，把情況回報給使用者，由使用者決定怎麼處理。
本 hook 沒有「說明原因就能繞」的旁路：無人值守時應該停下，而不是自行放行。
MSG
  exit 2
fi

exit 0
