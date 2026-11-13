#!/usr/bin/env node
/**
 * gmail-draft-stale-gate — 改既有草稿前必須先讀回（PreToolUse，只掛 update_draft）
 *
 * ── 為什麼會有這支（2026-10-20 實案）──────────────────────────
 * 使用者習慣在 Gmail 介面直接改草稿內文。同一輪對話裡草稿改了四次，
 * 第三次改信時模型照「自己上次送出的 htmlBody」重組再 update_draft，
 * 使用者剛在介面刪掉的 repo 表格、改掉的小標被原樣寫回。使用者原話：
 * 「我會習慣去改信件內文，但你常常都不看就直接覆蓋」。
 * SKILL.md 寫「先 get_draft 再改」是自律，模型會跳過；這支是他律。
 *
 * ── 行為 ─────────────────────────────────────────────────────
 *   update_draft 的 draftId 在共用狀態檔裡帶著 stale:<draftId> 記號
 *   （由 gmail-draft-posttool-gate 在上一次 create_draft／update_draft 成功時寫入，
 *     get_draft 讀回帶 htmlBody 時銷掉）→ deny，理由寫清楚做法。
 *   沒有記號（這個 session 之前沒寫過、或已讀回）→ 放行。
 *   create_draft：同一封信（同信串／同回覆對象／同主旨）還有「寫入後沒讀回」的舊草稿 → deny。
 *   delete_draft：要刪的草稿帶 stale 記號 → deny（刪除是永久的）。
 *   （2026-11-13 實案：原本 create_draft 不經過這支，模型用「開新草稿＋刪舊草稿」
 *     繞過，使用者在介面刪掉的稱謂被寫回、舊版永久消失。）
 *
 * ── 這支擋不到的 ─────────────────────────────────────────────
 *   讀回之後有沒有真的拿讀回的內容當底、有沒有保住使用者的修改——
 *   那要靠 SKILL.md 要點 6 的「改前改後切段比對」。這支只擋「連讀都沒讀就覆蓋」。
 *
 * ★ 最高原則：FAIL-OPEN。狀態檔讀不到、輸入解析不了 → 放行。
 *   擋錯的代價是流程卡死；放錯的代價是使用者再改一次。
 */

const path = require('path');

let C;
try {
  C = require(path.join(__dirname, 'lib', 'draft-checks.core.js'));
} catch (_) {
  process.exit(0);
}

let stdinData = '';
process.stdin.on('data', (c) => (stdinData += c));
process.stdin.on('end', () => {
  try { main(stdinData); } catch (_) { process.exit(0); }
});
process.stdin.on('error', () => process.exit(0));

function deny(reason) {
  try {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
    }), () => process.exit(0));
  } catch (_) { process.exit(0); }
}

function main(raw) {
  let input;
  try { input = JSON.parse(raw); } catch (_) { return process.exit(0); }
  if (!input || typeof input !== 'object') return process.exit(0);

  const toolName = C.safeStr(input.tool_name);
  const isUpdate = C.isGmailTool(toolName, 'update_draft');
  const isCreate = C.isGmailTool(toolName, 'create_draft');
  const isDelete = C.isGmailTool(toolName, 'delete_draft');
  if (!isUpdate && !isCreate && !isDelete) return process.exit(0);

  const toolInput = (input.tool_input && typeof input.tool_input === 'object') ? input.tool_input : {};
  const st = C.readState();

  // ── create_draft：同一封信（同信串／同回覆對象／同主旨）還有沒讀回的舊草稿 → 擋 ──
  if (isCreate) {
    const hits = C.staleConflicts(st, toolInput);
    if (!hits.length) return process.exit(0);
    return deny(
      `同一封信已經有草稿（${hits.join('、')}）在上次寫入後還沒有 get_draft 讀回，已先擋下這次 create_draft。\n` +
      '「開一封新草稿、再把舊的刪掉」和直接覆蓋是同一件事：使用者在 Gmail 介面改過的內容會被洗掉，\n' +
      '而且 delete_draft 是永久刪除，原本那一版救不回來\n' +
      '（2026-11-13 實案：使用者刪掉的開頭稱謂被新草稿寫回，舊草稿已刪無法還原）。\n' +
      '做法：\n' +
      '  1. 先 get_draft（messageFormat: FULL_CONTENT）讀回上面那封，以讀回的 htmlBody 當底稿；\n' +
      '  2. 讀回內容與上次送出的不同＝使用者手改過，先在對話裡列出他改了什麼再動手；\n' +
      '  3. 優先用 update_draft 改那一封；真的要重建，也以讀回內容為底，只改這次被要求的那幾處。\n' +
      '  確定是另一封不相干的信（只是主旨相同）：讀回那封草稿後就會放行。\n' +
      '（SKILL.md 第三步之三 要點 6）'
    );
  }

  const draftId = C.safeStr(toolInput.draftId);
  if (!draftId) return process.exit(0);
  if (st.warned.indexOf('stale:' + draftId) === -1) return process.exit(0);

  // ── delete_draft：沒讀回就刪 → 擋（刪了就沒有東西可以比對使用者改過什麼）──
  if (isDelete) {
    return deny(
      `這封草稿（${draftId}）上次由工具寫入後還沒有 get_draft 讀回，已先擋下這次 delete_draft。\n` +
      'delete_draft 是永久刪除、不進垃圾桶；使用者若在 Gmail 介面改過這封，刪掉就再也找不回來\n' +
      '（2026-11-13 實案）。\n' +
      '做法：先 get_draft（messageFormat: FULL_CONTENT）讀回，確認裡面沒有使用者的修改\n' +
      '（或修改已經搬進新草稿）再刪。（SKILL.md 第三步之三 要點 6）'
    );
  }

  return deny(
    `這封草稿（${draftId}）上次由工具寫入後還沒有 get_draft 讀回，已先擋下這次 update_draft。\n` +
    '使用者常在 Gmail 介面直接改內文；拿自己上次送出的文字當底覆蓋，會把他的修改洗掉\n' +
    '（2026-10-20 實案：使用者刪掉的表格、改過的小標被原樣寫回）。\n' +
    '做法：\n' +
    '  1. 先 get_draft（messageFormat: FULL_CONTENT），以讀回的 htmlBody 當底稿；\n' +
    '  2. 讀回的內容與上次送出的不同＝使用者手改過，先在對話裡列出他改了什麼再動手；\n' +
    '     他的修改與這次要改的地方衝突就停下來問，不要自己選一邊；\n' +
    '  3. 只改這次被要求的那幾處，其餘逐字保留；attachments 要全部重附（不帶會清空）；\n' +
    '  4. 改完再 get_draft 一次，改前改後切段比對，只能出現這次要改的那幾段差異。\n' +
    '（SKILL.md 第三步之三 要點 6）'
  );
}
