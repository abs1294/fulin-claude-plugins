// goal2 共用模組：組裝交給 `claude -p` 的「/goal 第一段」。
// 被 skills/goal/goal.js 與 skills/delaylocal/delaylocal.js 共用（以 path.join(__dirname,'..','..','lib','goal-head.js') require；
// Node 對 symlink 預設取真身路徑，所以 ~/.claude/skills/<name> symlink 與 plugin cache 安裝兩種情境都找得到）。
//
// ⚠️ Claude Code 的 /goal 完成條件有 4000 字元硬上限（超過回 "Goal condition is limited to 4000 characters (got N)"，
//    子程序 0 回合就退）。**在 claude -p 路徑下，/goal 後面的整段 prompt 都算進條件**——不只第一行。
//    2026-09-12 實測：第一行 156 字、整段 6368 字 → got 6361 被拒；同 prompt 砍到 2958 字 → Goal set。
//    （2.1.195 互動模式時只算第一行，所以舊版「下放到工作清單步驟 0」曾經有效；-p 路徑不行。）
//    所以：
//    - /goal prompt 只放「條件（或指針句）＋tail＋一句指向系統提示錨定區」，其餘（任務全文、工作清單、報告格式、
//      帳本規則）一律進 anchor.md，由 engine.js 以 --append-system-prompt-file 送進系統提示（不受 4000 限制）。
//    - 條件本身超過預算 → 第一行換指針句，完整條件放 anchor.md 的「完成條件全文」節，並要求引擎第一則回覆先把
//      條件全文貼進對話（讓檢查器在對話裡看得到，不依賴它能否讀系統提示）。
//    - engine.prepareRun 再對整段 prompt 做硬檢查（≤ GOAL_PROMPT_MAX），超過直接報錯不上車。
'use strict';

const GOAL_PROMPT_MAX = 3900;   // 整段 /goal prompt 的上限（4000 留邊際；Claude Code 量的是 "/goal " 之後的全部字元）
const DEFAULT_POINTER = '已逐項達成本 run 錨定區「完成條件全文」列出的每一項（每一項皆為真）';
const ANCHOR_HINT = '（任務全文、工作清單、進度帳本規則都在你的系統提示「goal2 錨定」區塊；先讀它再動手，做到條件達成才停。）';

/**
 * @param {object} o
 * @param {string} o.condition  可測量完成條件（必填）
 * @param {string} [o.tail]     要附在條件後、同樣納入完成條件的收尾句（例：delaylocal 的「已執行 notify-line.js」）；空字串則不附
 * @param {string} [o.pointer]  超長時第一行改放的指針句（不含 "/goal " 前綴、不含 tail）
 * @param {string} [o.hint]     第一段之後附的一句提示（指向系統提示錨定區）；預設 ANCHOR_HINT
 * @returns {{ goalPrompt: string, goalLine: string, conditionForAnchor: string, overflow: boolean, length: number }}
 *   goalPrompt          交給 claude -p 的整段文字（`/goal …` + 空行 + hint），保證 ≤ GOAL_PROMPT_MAX
 *   goalLine            第一行
 *   conditionForAnchor  要寫進 anchor.md「完成條件全文」節的內容：超長時是完整 condition，否則 ''
 *   overflow            是否走了指針句分支
 *   length              未截斷的完整第一行長度（供回報）
 */
function buildGoalHead({ condition, tail = '', pointer = DEFAULT_POINTER, hint = ANCHOR_HINT }) {
  if (typeof condition !== 'string' || !condition.trim()) throw new Error('buildGoalHead: condition 必填且不可為空');
  const suffix = tail ? `；${tail}` : '';
  const fullFirstLine = `/goal ${condition}${suffix}`;
  const wrap = (line) => `${line}\n\n${hint}`;
  const full = wrap(fullFirstLine);
  if (full.length <= GOAL_PROMPT_MAX) {
    return { goalPrompt: full, goalLine: fullFirstLine, conditionForAnchor: '', overflow: false, length: fullFirstLine.length };
  }
  const goalLine = `/goal ${pointer}${suffix}`;
  const prompt = wrap(goalLine);
  if (prompt.length > GOAL_PROMPT_MAX) {
    throw new Error(`/goal prompt 連指針句都超過 ${GOAL_PROMPT_MAX} 字（${prompt.length}）：tail 或 pointer 太長，請縮短`);
  }
  return { goalPrompt: prompt, goalLine, conditionForAnchor: condition, overflow: true, length: fullFirstLine.length };
}

module.exports = { buildGoalHead, GOAL_PROMPT_MAX, DEFAULT_POINTER, ANCHOR_HINT };
