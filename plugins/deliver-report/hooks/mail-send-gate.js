#!/usr/bin/env node
/**
 * mail-send-gate：信由使用者自己按傳送，Claude 不寄出（PreToolUse，硬擋）
 *
 * ── 為什麼會有這支（2026-11-13 實案）──────────────────────────
 * SKILL.md 第 21、506 行早就寫「建草稿仍然只到草稿為止，寄不寄由使用者按」，但只是自律。
 * 2026-11-13 使用者說「這份測試報告幫我寄給YCLIAO0」，Claude 建好草稿後在 Chrome 開 Gmail，
 * 用 find 找到 `ref_1858 button "傳送"` 再 computer left_click 點下去，不到一分鐘就寄出，
 * 信裡還寫錯情境數，已經收不回來。使用者原話：「誰準你寄的，不是我親自寄嗎」。
 * 既有的閘只檢查草稿格式，沒有任何一道看「寄出」這個動作。
 *
 * ── 擋什麼 ───────────────────────────────────────────────────
 *   1. Gmail 工具 send_message／reply／forward：這三支呼叫下去就直接寄出 → deny
 *   2. 瀏覽器點擊：
 *      - Chrome 擴充 computer（left_click 等）帶 ref，而本回合某個工具結果把這個 ref 標成
 *        「傳送／Send」按鈕（find、read_page 的輸出長這樣：ref_1858 button "傳送"）→ deny
 *      - Playwright browser_click：element 描述是傳送／Send，或 ref 在本回合快照裡是傳送按鈕 → deny
 *      - action_summary 寫的是寄出信件（Send…email、寄出、傳送信件）→ deny
 *   3. 網頁腳本（javascript_tool／browser_evaluate／browser_run_code_unsafe）：腳本同時有 click
 *      動作和傳送按鈕的選取（aria-label／data-tooltip／文字是「傳送」或 Send）→ deny
 *   4. 快捷鍵：本回合開過 mail.google.com，又要按 Ctrl/Cmd+Enter（Gmail 的送出快捷鍵）→ deny
 *
 * ── 唯一放行 ─────────────────────────────────────────────────
 *   使用者本回合的輸入明講要 Claude 按下傳送（例：「你按傳送」「直接送出」「幫我點寄出」）。
 *   「幫我寄給X」「寄給他」不算——那是叫你準備好信，按不按是使用者的事。
 *
 * ★ FAIL-OPEN：讀不到輸入或 transcript → 只依工具參數判斷，判不出來就放行。
 * ★ 範圍：防手滑，不是沙箱。用座標點擊（不帶 ref、不寫 action_summary）認不出來。
 */
'use strict';
const path = require('path');

let TIO = null;
try { TIO = require(path.join(__dirname, 'lib', 'transcript-io.js')); } catch (_) { TIO = null; }

const SEND_WORD = /^(?:傳送|送出|寄出|send)$/i;
const SEND_LABEL_IN_TEXT = /(ref_\d+)\s+button\s+"(?:傳送|送出|寄出|Send)"/gi;
const PW_SNAPSHOT_REF = /button\s+"(?:傳送|送出|寄出|Send)"[^\n]*?\[ref=([A-Za-z0-9_]+)\]/gi;
const SUMMARY_SEND = /(?:\bsend(?:s|ing)?\b[^\n]{0,60}\b(?:e-?mail|mail|message|draft)\b|寄出|送出信|傳送信|按下?傳送|點擊?傳送)/i;
const USER_ALLOW = /(?:你|幫我|直接|請)?\s*(?:按|點)(?:一?下)?\s*(?:傳送|送出|寄出)|直接(?:送出|寄出|傳送)/;
const MAIL_HOST = /mail\.google\.com/i;

function out(reason) {
  try {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
    }), () => process.exit(0));
  } catch (_) { process.exit(0); }
}

function s(x) { return typeof x === 'string' ? x : ''; }

function isUserPromptLine(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
  if (o.type !== 'user' || !o.promptId) return false;
  if ('toolUseResult' in o) return false;
  if (o.isSidechain === true) return false;
  if (o.isMeta === true) return false;
  return true;
}

function promptText(o) {
  const c = o && o.message && o.message.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter((b) => b && b.type === 'text').map((b) => s(b.text)).join('\n');
  return '';
}

// 本回合：使用者輸入文字（含回合中途插進來的訊息）、工具結果文字、本回合開過的網址
function readTurn(tp) {
  const res = { prompts: [], results: '', urls: '' };
  if (!tp || !TIO) return res;
  let lines;
  try { lines = TIO.readTurnLines(tp, isUserPromptLine); } catch (_) { return res; }
  if (!lines) return res;
  for (const l of lines) {
    if (!l) continue;
    let o;
    try { o = JSON.parse(l); } catch (_) { continue; }
    if (!o || typeof o !== 'object' || o.isSidechain === true) continue;
    if (isUserPromptLine(o)) { res.prompts.push(promptText(o)); continue; }
    const c = o.message && o.message.content;
    if (!Array.isArray(c)) continue;
    for (const b of c) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'tool_result') {
        const t = typeof b.content === 'string' ? b.content
          : Array.isArray(b.content) ? b.content.map((x) => s(x && x.text)).join('\n') : '';
        res.results += t + '\n';
      } else if (b.type === 'tool_use') {
        res.urls += JSON.stringify(b.input || {}) + '\n';
      }
    }
  }
  return res;
}

function collectStrings(v, acc) {
  if (typeof v === 'string') acc.push(v);
  else if (Array.isArray(v)) v.forEach((x) => collectStrings(x, acc));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => collectStrings(x, acc));
  return acc;
}

function scriptClicksSend(code) {
  if (!/\.click\s*\(|dispatchEvent\s*\(|\bclick\s*\(/i.test(code)) return false;
  return /(?:aria-label|data-tooltip|innerText|textContent|title)[^;\n]{0,80}(?:傳送|Send\b)/i.test(code)
    || /['"`](?:傳送|Send)['"`]/.test(code);
}

const REASON_TAIL =
  '\n信要由使用者自己檢查後按傳送，Claude 只做到草稿為止（SKILL.md 第三步之三；2026-11-13 實案：\n' +
  '使用者說「幫我寄給YCLIAO0」，Claude 在瀏覽器點了傳送，信裡有錯、收不回來，使用者原話\n' +
  '「誰準你寄的，不是我親自寄嗎」）。\n' +
  '改做：停在草稿，回報收件人／主旨／附件與草稿連結，說明「已建草稿、未寄出」，由使用者按傳送。\n' +
  '只有使用者本回合明講「你按傳送」「直接送出」這類話才放行；「幫我寄給X」不算。';

function main(raw) {
  let input;
  try { input = JSON.parse(raw); } catch (_) { return process.exit(0); }
  if (!input || typeof input !== 'object') return process.exit(0);
  const tool = s(input.tool_name);
  const ti = (input.tool_input && typeof input.tool_input === 'object') ? input.tool_input : {};
  const short = tool.split('__').pop();

  let reason = null;
  let turn = null;
  const getTurn = () => (turn || (turn = readTurn(input.transcript_path)));

  if (/Gmail__(?:send_message|reply|forward)$/.test(tool) || /^mcp__.*gmail.*__(?:send_message|reply|forward)$/i.test(tool)) {
    reason = `${short} 會直接把信寄出，已擋下。`;
  } else if (/claude-in-chrome__(?:computer|browser_batch)$/.test(tool)) {
    const acts = Array.isArray(ti.actions) ? ti.actions : [ti];
    for (const a of acts) {
      const x = (a && typeof a === 'object') ? (a.input && typeof a.input === 'object' ? a.input : a) : {};
      const action = s(x.action);
      if (SUMMARY_SEND.test(s(x.action_summary))) { reason = `這次點擊的說明是「${s(x.action_summary)}」，是在寄出信件，已擋下。`; break; }
      if (/click/i.test(action) && s(x.ref)) {
        const refs = new Set();
        let m; SEND_LABEL_IN_TEXT.lastIndex = 0;
        while ((m = SEND_LABEL_IN_TEXT.exec(getTurn().results))) refs.add(m[1]);
        if (refs.has(s(x.ref))) { reason = `要點的 ${s(x.ref)} 在本回合查到是「傳送」按鈕，已擋下。`; break; }
      }
      if (action === 'key' && /(?:ctrl|cmd|meta|control|command)\s*\+\s*(?:enter|return)/i.test(s(x.text)) && MAIL_HOST.test(getTurn().urls)) {
        reason = `本回合開過 Gmail，${s(x.text)} 是 Gmail 的送出快捷鍵，已擋下。`; break;
      }
    }
  } else if (/playwright__browser_click$/.test(tool)) {
    const el = s(ti.element).trim();
    if (SEND_WORD.test(el.replace(/\s*(?:button|按鈕)\s*$/i, '').replace(/["'「」]/g, '').trim()) || /(?:^|\s)(?:傳送|Send)\s*(?:button|按鈕)/i.test(el)) {
      reason = `要點的元素是「${el}」，是寄出按鈕，已擋下。`;
    } else if (s(ti.ref)) {
      const refs = new Set();
      let m; PW_SNAPSHOT_REF.lastIndex = 0;
      while ((m = PW_SNAPSHOT_REF.exec(getTurn().results))) refs.add(m[1]);
      if (refs.has(s(ti.ref))) reason = `要點的 ${s(ti.ref)} 在本回合快照裡是「傳送」按鈕，已擋下。`;
    }
  } else if (/playwright__browser_press_key$/.test(tool)) {
    if (/(?:Control|Meta|Ctrl|Cmd)\s*\+\s*Enter/i.test(s(ti.key)) && MAIL_HOST.test(getTurn().urls)) {
      reason = `本回合開過 Gmail，${s(ti.key)} 是 Gmail 的送出快捷鍵，已擋下。`;
    }
  } else if (/(?:claude-in-chrome__javascript_tool|playwright__browser_(?:evaluate|run_code_unsafe))$/.test(tool)) {
    if (collectStrings(ti, []).some(scriptClicksSend)) reason = '網頁腳本裡有點擊「傳送」按鈕的動作，已擋下。';
  }

  if (!reason) return process.exit(0);
  const prompts = getTurn().prompts;
  if (prompts.some((p) => USER_ALLOW.test(p))) return process.exit(0);
  return out(reason + REASON_TAIL);
}

let buf = '';
process.stdin.on('data', (c) => (buf += c));
process.stdin.on('end', () => { try { main(buf); } catch (_) { process.exit(0); } });
process.stdin.on('error', () => process.exit(0));
