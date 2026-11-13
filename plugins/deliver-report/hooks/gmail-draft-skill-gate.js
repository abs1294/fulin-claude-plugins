#!/usr/bin/env node
/**
 * gmail-draft-skill-gate — 沒載入 deliver-report 就不准建草稿（PreToolUse，掛 create_draft）
 *
 * ── 為什麼會有這支（2026-11-13 實案）──────────────────────────
 * 使用者要「回信說明」，模型直接 create_draft，整個過程沒載入 deliver-report：
 * 純文字 body 讓設定名稱被改寫成連結、<br> 手打列點、整封一大片文字、術語沒翻白話、
 * 「開新草稿再刪舊的」蓋掉使用者手改——這些規則 SKILL.md 全都寫了，只是沒讀。
 * 根因之一是 skill 的 description 寫「前提是已有一批產出檔案」，沒附檔的說明信照字面被排除。
 * description 已放寬（任何要寄給外部的信都適用）；這支閘是他律：description 靠模型自己判斷，會漏。
 *
 * ── 行為 ─────────────────────────────────────────────────────
 *   create_draft 前，在本 session 的 transcript 找「deliver-report plugin 的任一 skill 已載入」的痕跡：
 *     - Skill 工具呼叫 "skill":"deliver-report…"（含 deliver-report:daily-report 等同 plugin 的 skill）
 *     - 使用者輸入的 slash command <command-name>/deliver-report…
 *     - skill 載入時的 "Base directory for this skill: …deliver-report…"
 *   找到 → 放行，並在狀態檔記 skillok:<session_id>，同 session 之後不再讀 transcript。
 *   找不到 → deny，要求先載入 skill。
 *   只掛 create_draft：update_draft 改的是既有草稿，建它的那一刻就已經過這道閘。
 *
 * ★ 最高原則：FAIL-OPEN。沒有 transcript_path、讀不到檔、任何例外 → 放行。
 */

const fs = require('fs');
const path = require('path');

let C, T;
try {
  C = require(path.join(__dirname, 'lib', 'draft-checks.core.js'));
  T = require(path.join(__dirname, 'lib', 'transcript-io.js'));
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

// 只認「結構」，不認字串：transcript 裡模型自己的文字、Bash 指令、寫進檔案的註解都可能提到
// "Base directory for this skill: …deliver-report…"（2026-11-13 寫這支閘的測試時，自己的測試指令就命中過）。
//   ① assistant 的 tool_use，name === 'Skill'，input.skill 是 deliver-report 或 deliver-report:<skill>
//   ② user 角色、內容以「Base directory for this skill: <路徑>」開頭且路徑含 deliver-report（skill 實際載入）
//   ③ user 角色、內容含 <command-name>/deliver-report…</command-name>（使用者自己打 slash command）
const SKILL_NAME = /^deliver-report(?::[A-Za-z0-9_-]+)?$/;
const BASE_DIR = /^Base directory for this skill: \S*?[\\/]deliver-report[\\/]/;
const SLASH = /<command-name>\/?deliver-report(?::[A-Za-z0-9_-]+)?<\/command-name>/;

function lineLoaded(l) {
  let o;
  try { o = JSON.parse(l); } catch (_) { return false; }
  const msg = o && o.message;
  if (!msg || typeof msg !== 'object') return false;
  const role = msg.role;
  const items = Array.isArray(msg.content) ? msg.content
    : (typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : []);
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    if (role === 'assistant' && it.type === 'tool_use' && it.name === 'Skill' &&
        it.input && SKILL_NAME.test(C.safeStr(it.input.skill))) return true;
    if (role === 'user' && it.type === 'text' && typeof it.text === 'string') {
      if (BASE_DIR.test(it.text) || SLASH.test(it.text)) return true;
    }
  }
  return false;
}

function skillLoaded(file) {
  let found = false;
  const STOP = {};
  try {
    T.readLineBatches(file, (lines) => {
      for (const l of lines) {
        if (l.indexOf('deliver-report') === -1) continue;
        if (lineLoaded(l)) { found = true; throw STOP; }
      }
    });
  } catch (e) {
    if (e !== STOP) return null;   // 讀檔失敗 → 判不出
  }
  return found;
}

function main(raw) {
  let input;
  try { input = JSON.parse(raw); } catch (_) { return process.exit(0); }
  if (!input || typeof input !== 'object') return process.exit(0);
  if (!C.isGmailTool(C.safeStr(input.tool_name), 'create_draft')) return process.exit(0);

  const file = C.safeStr(input.transcript_path);
  if (!file) return process.exit(0);
  try { if (!fs.statSync(file).isFile()) return process.exit(0); } catch (_) { return process.exit(0); }

  const sid = C.safeStr(input.session_id) || file;
  const key = 'skillok:' + sid;
  const st = C.readState();
  if (st.warned.indexOf(key) !== -1) return process.exit(0);

  const ok = skillLoaded(file);
  if (ok === null) return process.exit(0);
  if (ok) {
    st.warned.push(key);
    C.writeState(st);
    return process.exit(0);
  }

  return deny(
    '這個 session 還沒有載入 deliver-report skill，已先擋下這次 create_draft。\n' +
    '任何要寄給外部的信（回信、說明信、澄清、催件，有沒有附檔都算）都要先照 deliver-report 寫：\n' +
    '格式（htmlBody、清單標籤、粗體小標、網址與設定名稱不被 Gmail 改寫）、白話、稱謂、\n' +
    '改草稿先讀回不覆蓋使用者的修改——這些規則都在 SKILL.md，不讀就會一條一條踩\n' +
    '（2026-11-13 實案：沒載入就建草稿，七次改版踩了五種坑）。\n' +
    '做法：先用 Skill 工具載入 deliver-report:deliver-report（日報用 deliver-report:daily-report），\n' +
    '讀完再建草稿；載入一次後，同一個 session 不會再擋。'
  );
}
