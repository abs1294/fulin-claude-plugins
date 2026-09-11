// goal2 共用模組：組裝 final_prompt 的「/goal 第一行」。
// 被 skills/goal/goal.js 與 skills/delaylocal/delaylocal.js 共用（兩支 skill 以
// path.join(__dirname, '..', '..', 'lib', 'goal-head.js') require；Node 對 symlink 預設取真身路徑，
// 所以 ~/.claude/skills/<name> symlink 與 plugin cache 安裝兩種情境都找得到）。
//
// ⚠️ Claude Code 的 /goal 完成條件有 4000 字元硬上限（超過會回
//    "Goal condition is limited to 4000 characters"、cron fire 進 REPL 時卡死）。
//    condition 由使用者傳入、長度不可控，故：
//    - 第一行（含 tail）≤ GOAL_MAX → 照舊整段放第一行（短任務行為不變）。
//    - 超過 → 第一行換成固定「指針句」（指向工作清單步驟 0），完整 condition
//      原封不動下放到工作清單步驟 0（goalFullBlock），避免機械截斷破壞語意。
'use strict';

const GOAL_MAX = 3900; // 4000 上限留邊際；含 "/goal " 前綴一起算
const DEFAULT_POINTER = '已逐項達成「工作清單步驟 0」列出的完整完成條件（每一項皆為真）';

/**
 * @param {object} o
 * @param {string} o.condition  可測量完成條件（必填）
 * @param {string} [o.tail]     要附在條件後、同樣納入完成條件的收尾句（例：delaylocal 的「已執行 notify-line.js」）；空字串則不附
 * @param {string} [o.pointer]  超長時第一行改放的指針句（不含 "/goal " 前綴、不含 tail）
 * @returns {{ goalLine: string, goalFullBlock: string, overflow: boolean, length: number }}
 *   goalLine      實際放第一行的 /goal 內容（含 "/goal " 前綴）
 *   goalFullBlock 超長時要放到工作清單最前面的「0. [完成條件全文]」區塊，結尾自帶兩個換行；不超長則為 ''
 *   overflow      是否走了指針句分支
 *   length        未截斷的完整第一行長度（供回報）
 */
function buildGoalHead({ condition, tail = '', pointer = DEFAULT_POINTER }) {
  if (typeof condition !== 'string' || !condition.trim()) {
    throw new Error('buildGoalHead: condition 必填且不可為空');
  }
  const suffix = tail ? `；${tail}` : '';
  const fullFirstLine = `/goal ${condition}${suffix}`;
  if (fullFirstLine.length <= GOAL_MAX) {
    return { goalLine: fullFirstLine, goalFullBlock: '', overflow: false, length: fullFirstLine.length };
  }
  // 指針句：本身簡短可驗證，把「完整條件」指向步驟 0；tail 照樣納入（例如 goal 引擎才會強迫發 LINE）。
  const goalLine = `/goal ${pointer}${suffix}`;
  const goalFullBlock = `0. [完成條件全文] 本目標達成的判定 = 下列每一項皆為真（第一行 /goal 因 4000 字元上限只放指針，完整條件在此，逐項核對）：
${condition}

`;
  return { goalLine, goalFullBlock, overflow: true, length: fullFirstLine.length };
}

module.exports = { buildGoalHead, GOAL_MAX, DEFAULT_POINTER };
