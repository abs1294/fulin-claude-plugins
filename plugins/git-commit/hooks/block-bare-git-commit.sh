#!/usr/bin/env bash
# ============================================================
# block-bare-git-commit.sh — PreToolUse hook
#
# 目的：攔截 AI 直接跑 `git commit`，強制走 git-commit skill 的 flow.sh。
#
# 為什麼需要這個：
#   SKILL.md frontmatter 明寫「AI 禁止直接執行 git commit」，flow.sh 也備妥六道真閘，
#   但那全是「自律」——AI 直接跑 git commit 就整套繞過，六道閘一道都不會觸發。
#   skill 的「必須」AI 會繞，只有 hook 是他律。
#
# 射程：只攔 `git commit`（使用者決定：rebase/amend 未必要先 commit，攔太寬會擋到正常操作）。
#
# 放行條件：GIT_COMMIT_FLOW=1（由 flow.sh 自己 export，代表已走完整流程）。
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

# 已在 flow.sh 流程內 → 放行
[ "${GIT_COMMIT_FLOW:-}" = "1" ] && exit 0

# 命令裡自己就帶了 flow.sh → 放行（使用者/AI 正在跑正規流程）
printf '%s' "$cmd" | grep -q 'flow\.sh' && exit 0

# 只攔 git commit：git 後面（允許 -C <path> 等全域旗標）接 commit
if printf '%s' "$cmd" | grep -Eq '(^|[;&|]|\s)git(\s+-[A-Za-z-]+(\s+\S+)?)*\s+commit(\s|$)'; then
  cat >&2 <<'MSG'
⛔ 已攔截裸 `git commit`。

本專案的 commit 一律走 git-commit skill，不直接下 git 指令。
理由：flow.sh 有六道機制閘（AI 署名／單行／diff hash TOCTOU／敏感字／
建置產物／message 痕跡與長度），裸 commit 會全部繞過。

正確做法：
  flow.sh analyze <repo>
  flow.sh prepare <repo> <files...>
  flow.sh ship    <repo> <Type> "<描述>"        # 加 --push 才推遠端

真的需要繞過（hook 環境故障等）：請先向使用者說明原因並取得同意。
MSG
  exit 2
fi

exit 0
