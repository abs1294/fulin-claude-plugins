#!/usr/bin/env node
/**
 * runs-guard — PreToolUse(Bash|PowerShell) 共用 runs 目錄保護閘
 *
 * 為什麼存在：`~/.claude/goal2/runs/` 全機共用、跨 session。2026-09-12 同一天被整批刪兩次——
 * 主 session 用 rmSync 清「測試殘留」刪掉另一個 session 正在跑的 run；紅方 agent 跑 `--prune --keep-hours 0`
 * 刪掉剛跑完的兩個 run。SKILL 與 CLAUDE.md 寫「禁止」是自律，AI 會繞；只有 hook 是他律。
 *
 * 規則（只看 Bash／PowerShell 的 command 字串；寧可漏攔，不誤攔正常操作）：
 *   1. 指令含刪除動詞（Bash：rm/rmdir/rimraf/unlink/rmSync/fs.rm/rmtree/find -delete；PowerShell 另加
 *      Remove-Item/del/rd/ri/erase），且提到「真實家目錄下」的 goal2/runs（~、$HOME、%USERPROFILE%、實際 home 路徑、
 *      或只有 .claude/goal2/runs 這種看不出在哪的相對寫法）：
 *      → 每個 runs 路徑都指到完整 run id（<14位>-<skill>-<4位>）就放行（連帶的迴圈／萬用字元不管）；
 *        否則（整個目錄、部分 id、萬用字元、for/forEach/readdir/Get-ChildItem 列舉式）攔下。
 *      明確在別的絕對路徑下的 runs（測試沙盒 …/e12-home/.claude/goal2/runs）不管。
 *   2. `--prune` 帶 `--keep-hours` 小於 2 → 攔（0/1 小時等於整批清）。
 *   3. 其餘放行；stdin 解析失敗放行（fail-open）。
 * 攔下時 exit 2，stderr 說明改用 `goal.js --prune`（先 `--dry-run`）或指名單一 run id。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

function readStdin() { try { return fs.readFileSync(0, 'utf8'); } catch (_) { return ''; } }

// 整個路徑 token（含前綴），中間是 goal2/runs（任何斜線寫法，含 JSON 字串裡的 \\）
const TOKEN_RE = /[^\s"'`;&|()=,+]*goal2(?:[\\/]|\\\\)+runs(?:[^\s"'`;&|(),]*)/gi;
const RUN_ID_TAIL = /goal2(?:[\\/]|\\\\)+runs(?:[\\/]|\\\\)+\d{14}-[a-z]+-[0-9a-z]{4}(?:(?:[\\/]|\\\\)|$)/i;
const DELETE_BASH = /(^|[\s;&|(`])(rm|rmdir|rimraf|unlink)(\s|$)|\brmSync\b|\bfs\.rm\b|\bfs\.promises\.rm\b|\brmtree\b|\bfind\b[\s\S]*-delete\b|\bunlinkSync\b/i;
const DELETE_PS = /(^|[\s;&|(`{])(rm|rmdir|rimraf|Remove-Item|del|rd|ri|erase)(\s|$)|\brmSync\b|\bfs\.rm\b|\brmtree\b|\[System\.IO\.(Directory|File)\]::Delete/i;
const LOOP_RE = /\bfor\b|\bforeach\b|ForEach-Object|\.forEach\s*\(|\breaddir(Sync)?\b|Get-ChildItem|\bxargs\b/i;
const PRUNE_RE = /--prune\b[\s\S]*?--keep-hours\s+(\d+)|--keep-hours\s+(\d+)[\s\S]*?--prune\b/;

function deny(reason) {
  process.stderr.write(
    `[goal2 runs-guard] 已攔下：${reason}\n` +
    '`~/.claude/goal2/runs/` 全機共用、跨 session，別的 session 可能正有引擎在跑（2026-09-12 同一天被整批刪兩次，帳本／stream／結果全失）。\n' +
    '改用：node <goal2>/skills/goal/goal.js --prune --dry-run 看會刪什麼，再 --prune（只清已結束且程序不在、且超過保留時數的 run）；' +
    '真的要刪特定 run，指令裡寫完整 run id（例 runs/20260912012309-goal-d15a），一次一個。\n'
  );
  process.exit(2);
}

const norm = (p) => String(p).replace(/\\\\/g, '/').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const HOME = norm(os.homedir());

/** 這個 token 指的是不是「真實家目錄」下的 runs？看不出在哪（相對寫法、只有 / 開頭、變數）一律當真實（保守） */
function isRealRuns(token) {
  const t = norm(token);
  const i = t.indexOf('/.claude/goal2/runs');
  if (i < 0) return true;                                   // 沒有 .claude 前綴（goal2/runs 單獨出現）：看不出在哪 → 當真實
  let prefix = t.slice(0, i);
  if (prefix === '' || prefix === '~' || /\$home$|\$env:userprofile$|%userprofile%$|\$\{home\}$|homedir\(\)$|process\.env\.(home|userprofile)$/.test(prefix)) return true;
  if (!/^[a-z]:\/|^\//.test(prefix)) return true;           // 不是絕對路徑（變數、相對）→ 看不出在哪 → 當真實
  if (prefix === '/' ) return true;
  return path.resolve(prefix).replace(/\\/g, '/').toLowerCase() === HOME;   // 明確在別處（沙盒）→ 不管
}

function main() {
  let input;
  try { input = JSON.parse(readStdin()); } catch (_) { process.exit(0); }
  if (!input || (input.tool_name !== 'Bash' && input.tool_name !== 'PowerShell')) process.exit(0);
  const cmd = String((input.tool_input && input.tool_input.command) || '');
  if (!cmd) process.exit(0);

  // 規則 2：--prune 的保留時數太短
  const pm = cmd.match(PRUNE_RE);
  if (pm) { const h = parseInt(pm[1] || pm[2], 10); if (Number.isFinite(h) && h < 2) deny(`--prune --keep-hours ${h}（小於 2 小時等於整批清）`); }

  // 規則 1
  const DELETE_RE = input.tool_name === 'PowerShell' ? DELETE_PS : DELETE_BASH;
  if (!DELETE_RE.test(cmd)) process.exit(0);
  const tokens = (cmd.match(TOKEN_RE) || []).filter(isRealRuns);
  // path.join(os.homedir(), ".claude", "goal2", "runs") 這種拼接寫法沒有 goal2/runs 連在一起：分開的 "goal2" 與 "runs" 字串字面量同時出現也算提到
  if (/["']goal2["']/.test(cmd) && /["']runs["']/.test(cmd) && !/["']\d{14}-[a-z]+-[0-9a-z]{4}["']/.test(cmd)) tokens.push('.claude/goal2/runs');
  if (tokens.length === 0) process.exit(0);
  const explicit = tokens.filter((t) => RUN_ID_TAIL.test(t));
  if (explicit.length === tokens.length && !tokens.some((t) => /[*?]/.test(t))) process.exit(0);   // 全部指名完整 run id → 放行
  if (LOOP_RE.test(cmd)) deny('對 runs 目錄做迴圈式／列舉式刪除');
  if (tokens.some((t) => /[*?]/.test(t))) deny('runs 目錄路徑含萬用字元');
  deny('刪除目標不是單一完整的 run id（整個 runs 目錄或不完整路徑）');
}

try { main(); } catch (_) { process.exit(0); }
