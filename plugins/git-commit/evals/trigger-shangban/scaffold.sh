#!/usr/bin/env bash
# 在 eval 的拋棄式工作目錄（claude-eval-*/home/cwd）建一個有未提交改動的 git repo。
# 只動當前目錄；沒有 remote，push 必然失敗。
set -euo pipefail
# 呼叫端帶進來的 GIT_DIR 這類變數會讓下面的 git 指令寫進別的 repo，一律清掉
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR GIT_OBJECT_DIRECTORY GIT_CEILING_DIRECTORIES
# 三道都過才動手：路徑名稱碰巧含 claude-eval- 的真實 repo（或 repo 裡的空目錄）不能被寫入。
case "$PWD" in
  */claude-eval-*/home/cwd) ;;
  *) echo "refuse: not inside an eval sandbox ($PWD)" >&2; exit 1 ;;
esac
if [ -n "$(ls -A)" ]; then
  echo "refuse: directory not empty ($PWD)" >&2; exit 1
fi
# 自己逐層往上找 .git。eval 會在沙箱的 claude-eval-*/home 先建一個 repo（實測），只略過這一層。
sandbox_home="${PWD%/cwd}"
d="$PWD"
while [ "$d" != "/" ] && [ -n "$d" ]; do
  if [ -e "$d/.git" ] && [ "$d" != "$sandbox_home" ]; then
    echo "refuse: inside a git repo at $d" >&2; exit 1
  fi
  d=$(dirname "$d")
done
git init -q -b main .
git config user.name "Plugin Eval"
git config user.email "eval@example.invalid"
mkdir -p src
cat > src/price.js <<'JS'
function totalPrice(items) {
  let sum = 0;
  for (const it of items) sum += it.price;
  return sum;
}
module.exports = { totalPrice };
JS
echo "# demo" > README.md
git add -A
git commit -q -m "Chore: 初始化"
cat > src/price.js <<'JS'
function totalPrice(items) {
  let sum = 0;
  for (const it of items) sum += it.price * (it.qty ?? 1);
  return sum;
}
module.exports = { totalPrice };
JS
