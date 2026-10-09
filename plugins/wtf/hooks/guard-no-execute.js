#!/usr/bin/env node
'use strict';
/**
 * 只解釋閘 — /wtf 是「重講鈕」，不是「執行鈕」。
 *
 * 使用者按 /wtf 的意思永遠是「上一則我看不懂，講清楚一點」。
 * 他接下來說的每一句話——包含祈使句、單一動詞、罵人的話——都是
 * 「要被解釋的材料」，不是「要被執行的指令」。
 *
 * 為什麼要機械閘而不是只寫在 SKILL.md：
 * 使用者實際遭遇（2026-09-14）：按了 /wtf 之後，模型仍去改了檔案。
 * 純文字規則擋不住這件事——SKILL.md 自己甚至寫過「先照他原本的話做，再解釋」，
 * 模型讀到那條就會動手。skill 寫「必須」是自律、AI 會繞；只有 hook 是他律。
 *
 * 攔什麼：wtf 生效期間，所有會改變外部狀態的工具（Edit/Write/Bash/…）。
 * 放什麼：唯讀工具（Read/Grep/Glob…根本不進本 hook 的 matcher）、
 *         以及 wtf 為了「解釋得更好」而做的自身動作（見 WHITELIST）。
 *
 * fail-open：任何解析不了、讀不到、判斷不了的情況一律放行（exit 0）。
 * 閘壞掉不該卡住使用者——這是本 repo 所有 hook 的共同紀律。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// 寬度設定檔（0.18.0 起存使用者層，見 skills/wtf/width.js）
const WIDTH_CONFIG = (process.env.WTF_CONFIG && process.env.WTF_CONFIG.trim())
  ? path.resolve(process.env.WTF_CONFIG.trim())
  : path.join(os.homedir(), '.claude', 'wtf', 'config.json');

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch (e) { return ''; }
}

const raw = readStdin();
if (!raw.trim()) process.exit(0);

let input;
try {
  input = JSON.parse(raw);
} catch (e) {
  process.exit(0);
}
if (!input || typeof input !== 'object' || Array.isArray(input)) process.exit(0);

const sid = String(input.session_id || 'default').replace(/[^a-zA-Z0-9]/g, '').slice(0, 24);
const FLAG = path.join(os.tmpdir(), `wtf-active-${sid}.json`);

const toolName = typeof input.tool_name === 'string' ? input.tool_name : '';
const ti = (input.tool_input && typeof input.tool_input === 'object' && !Array.isArray(input.tool_input))
  ? input.tool_input : {};

function raiseFlag(skill) {
  try {
    fs.writeFileSync(FLAG, JSON.stringify({ at: Date.now(), skill }), 'utf8');
  } catch (e) { /* 立旗失敗就算了，fail-open */ }
}

// ── 分支零：使用者自己打 /wtf（UserPromptSubmit）→ 立旗 ──────────────
// 0.18.0 修正：斜線指令是直接展開成 skill 內容，**不經過 Skill 工具**，
// 所以只掛在 PreToolUse(Skill) 的話，使用者手打 /wtf 時本閘從來沒立過旗。
// 實際紀錄（2026-10-09，Redcap session）：手打 /wtf 之後模型用 python 改設定檔，沒被擋。
// 實測 UserPromptSubmit 收到的 prompt 就是原文（例如 "/wtf:wtf 測試"）。
if (input.hook_event_name === 'UserPromptSubmit') {
  const prompt = typeof input.prompt === 'string' ? input.prompt : '';
  if (/^\s*\/(wtf:)?wtf(\s|$)/.test(prompt)) {
    raiseFlag('prompt:/wtf');
  } else {
    // 使用者在 /wtf 之外送出新訊息＝重新交代工作，閘就該收掉。
    // 以前沒有這個時機點，只能等 30 分鐘過期，期間他的正常指令也會被擋。
    try { fs.unlinkSync(FLAG); } catch (e) {}
  }
  process.exit(0); // 永遠不擋使用者送出的訊息
}

// ── 分支一：Skill 呼叫 → 判斷是不是 wtf，是就立旗 ────────────────────
if (toolName === 'Skill') {
  const skill = typeof ti.skill === 'string' ? ti.skill : '';
  if (/(^|:)wtf$/.test(skill)) raiseFlag(skill);
  process.exit(0); // Skill 呼叫本身永遠放行，寬度閘那支才管擋不擋
}

// ── 分支二：其他工具 → 看旗還在不在 ──────────────────────────────────
let flag = null;
try {
  flag = JSON.parse(fs.readFileSync(FLAG, 'utf8'));
} catch (e) {
  process.exit(0); // 沒旗＝不在 wtf 期間，放行
}
if (!flag || typeof flag !== 'object') process.exit(0);

// 旗過期就自動失效，避免一次 /wtf 之後整個 session 都被鎖住。
// 30 分鐘足夠一輪重講，超過代表使用者早就換話題了。
const TTL_MS = 30 * 60 * 1000;
if (!(typeof flag.at === 'number') || Date.now() - flag.at > TTL_MS) {
  try { fs.unlinkSync(FLAG); } catch (e) {}
  process.exit(0);
}

// ── 白名單：wtf 為了「解釋」而做的自身動作，一律放行 ──────────────────
function isWithin(target, dir) {
  try {
    const rel = path.relative(path.resolve(dir), path.resolve(target));
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  } catch (e) { return false; }
}

const WRITE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);

if (WRITE_TOOLS.has(toolName)) {
  const fp = typeof ti.file_path === 'string' ? ti.file_path : '';
  // (1) wtf 自己的寬度設定檔（正常走 width.js；模型直接寫檔也放行）
  if (fp && path.resolve(fp).toLowerCase() === WIDTH_CONFIG.toLowerCase()) process.exit(0);
  // (2) 產給使用者看的 HTML 圖表，放在 OS 暫存目錄
  if (fp && isWithin(fp, os.tmpdir()) && /\.html?$/i.test(fp)) process.exit(0);
  block(toolName, fp);
}

if (toolName === 'Bash' || toolName === 'PowerShell') {
  const cmd = String(ti.command || '');
  // 開瀏覽器看圖、跑 archify 產圖、印標尺量寬度——都是「為了解釋」
  const ALLOWED = [
    /^\s*(cmd\s+\/\/?c\s+)?start\s+""/i,      // Windows 開檔
    /^\s*Start-Process\b/i,                    // PowerShell 開檔
    /^\s*(open|xdg-open)\s+/,                  // macOS / Linux 開檔
    /archify\.mjs\s+(doctor|guide|validate|deliver)\b/, // archify 產圖
    // 量終端機寬度的標尺腳本。寬度閘擋下調用後會叫模型跑它，
    // 不放行的話兩個閘會互鎖：寬度閘要它量寬度，本閘不准它跑量寬度的東西。
    /\bruler\.js["']?(\s|$)/,
    // 讀寫寬度設定。整行只能是這一個指令（不准串 ; && | 接別的東西）。
    /^\s*node\s+["']?[^"'\n;&|]*width\.js["']?\s+(get|decline|set\s+\d{1,3})\s*$/,
  ];
  if (ALLOWED.some((re) => re.test(cmd))) process.exit(0);
  block('Bash', cmd.slice(0, 120));
}

process.exit(0); // 其餘未列管工具放行

function block(what, detail) {
  process.stderr.write(
    '[wtf] 這次調用已擋下：/wtf 是重講鈕，不是執行鈕。\n' +
    '\n' +
    '被擋的動作：' + what + (detail ? '  →  ' + detail : '') + '\n' +
    '\n' +
    '⛔ 使用者按 /wtf 的意思是「上一則我看不懂，講清楚一點」。\n' +
    '   他接下來說的每一句話都是**要被解釋的材料**，不是要被執行的指令——\n' +
    '   包含祈使句（「把那個刪掉」）、單一動詞（「改」「跑」「裝」）、以及罵人的話。\n' +
    '\n' +
    '   他說「改 X」→ 你要講的是：X 是什麼、改它會發生什麼、你打算怎麼改。**不是動手改。**\n' +
    '   他說「跑那個腳本」→ 你要講的是：那個腳本在做什麼、跑了會怎樣。**不是去跑。**\n' +
    '\n' +
    '✅ 現在該做的：把上一則用更好懂的方式重講一次（ASCII 圖、白話、講到「所以呢」）。\n' +
    '   如果你判斷他真的要你動手做事，**先把事情解釋清楚，然後問他一句「要我現在動手嗎？」**\n' +
    '   等他在 /wtf 以外明確說要，才動手。\n' +
    '\n' +
    '（使用者送出下一則非 /wtf 的訊息時本閘就失效，最晚 30 分鐘後自動失效。）\n'
  );
  process.exit(2);
}
