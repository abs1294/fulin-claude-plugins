#!/usr/bin/env node
/**
 * PreToolUse hook — 改到某支 skill 宣告的 paths 之前，那支 skill 要已經載入。
 *
 * 【範本】由 /harness:init 複製到目標專案 `.claude/hooks/`，之後歸該專案自治（可自改；plugin 更新不會自動同步）。
 * 接線（目標專案 .claude/settings.json 或 settings.local.json）：
 *   "PreToolUse": [{ "matcher": "Edit|Write|MultiEdit|NotebookEdit", "hooks": [{ "type": "command",
 *     "command": "node \"<專案絕對路徑>/.claude/hooks/guard-required-skill.js\"", "timeout": 15, "statusMessage": "檢查改這個檔之前該讀的 skill 讀了沒" }] }]
 *
 * 為什麼：skill frontmatter 的 `paths:` 在 Claude 碰到相符檔案時，只把 skill 的名稱與描述列進可用清單，
 * 內文不會進 context（Claude Code 2.1.296 實測：transcript 只多一行 attachment.type "skill_listing"、isInitial false）。
 * 規範寫進 skill 卻沒被讀，等於沒寫。本 hook 把 paths 當成「改這些檔之前要先載入這支 skill」的宣告。
 * 設定的唯一來源是各 skill 自己的 frontmatter（`.claude/skills/<名稱>/SKILL.md` 的 name 與 paths），沒有另一份清單——
 * 沒有任何 skill 宣告 paths 時本 hook 什麼都不擋。
 *
 * 判「已載入」：讀這個 context 自己的 transcript。
 *   - 主對話：payload 的 transcript_path。
 *   - subagent（payload 帶 agent_id）：`<transcript_path 所在目錄>/<session_id>/subagents/agent-<agent_id>.jsonl`。
 *     subagent 裡觸發的 PreToolUse，transcript_path 與 session_id 是主 session 的；主對話載入的 skill 不會帶進 subagent，
 *     所以只看 subagent 自己的檔。
 *   載入的共同痕跡是一行 isMeta 的 user 訊息，文字以「Base directory for this skill: <skill 目錄>」開頭
 *   （Skill 工具、使用者手打 /名稱、agent 定義檔 `skills:` 預載三種都有）；取目錄名當 skill 名。
 *   另外接受 Skill 工具的 tool_use（input.skill，`plugin:名稱` 取冒號後）且它的 tool_result 不是錯誤。
 *   只認 isMeta user 行開頭與 Skill tool_use：rule 的 rawContent、檔案內容、對話文字裡出現同樣字樣都不算。
 * glob 語意照 Claude Code 2.1.296 對 rules／skill paths 的實測（gitignore 寫法，見 matchPath 註解）。
 * 帶 paths 的 skill 要等這個 session 讀過一個相符的檔，才會出現在可用清單；在那之前 Skill 工具回「Unknown skill」
 * （同版實測；被本 hook 擋下的 Edit 不算讀過；主對話讀過之後，subagent 裡也叫得到）。擋下訊息因此附上一個可以先 Read 的相符檔。
 * agent 定義檔 frontmatter 的 `skills:` 預載也受這個限制：這個 session 還沒讀過相符的檔時，帶 paths 的 skill 被靜默略過
 * （同版實測：預載 [ts-style, plain-x] 只載入 plain-x；主對話先 Read 過一個 src/*.ts 再派工，兩支都載入）。
 *
 * 已知極限（只寫在這裡，不寫進擋下訊息）：
 *   - 只管 Edit／Write／MultiEdit／NotebookEdit。用 Bash 寫檔（echo >、sed -i、tee）不經過本 hook。
 *   - 整份 transcript 都算：壓縮前載入過的 skill 照樣算已載入（壓縮後 skill 內文還在不在 context 未實測）。
 *   - `plugin:名稱` 與專案 skill 同名時，載入 plugin 版也算數。
 *   - frontmatter 只解析簡單 YAML（`key: 值`、`key: [a, b]`、`key:` 加 `- 項目` 清單）。
 * fail-open：讀不到 transcript、解析失敗、找不到專案根或 `.claude/skills/`、任何例外一律放行。
 *
 * 另匯出 matchPath／validatePattern／readSkills 等函式，init-verify.js 用同一份判準檢查 skill 與 rules 的 paths。
 */

'use strict';

const fs = require('fs');
const path = require('path');

const TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const BASE_DIR_PREFIX = 'Base directory for this skill:';
const MAX_BRACE_EXPANSION = 256;

// ── frontmatter ─────────────────────────────────────────────────────────────
function frontmatter(text) {
  const lines = String(text).replace(/^﻿/, '').replace(/\r\n/g, '\n').split('\n');
  if (lines[0].trim() !== '---') return null;
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (end < 0) return null;
  return lines.slice(1, end);
}
const unquote = (s) => { const t = String(s).trim(); return /^(['"]).*\1$/.test(t) ? t.slice(1, -1) : t; };
// 逗號切開，但大括號裡的逗號不切（`src/**/*.{ts,tsx}, docs/**` → 兩條）
function splitTopLevel(s) {
  const out = []; let depth = 0; let cur = '';
  for (const c of String(s)) {
    if (c === '{') depth++;
    else if (c === '}' && depth > 0) depth--;
    if (c === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out.map((x) => unquote(x)).filter((x) => x.trim() !== '');
}
// 回傳 frontmatter 裡 key 的值：沒有這個鍵＝undefined；純量＝字串；清單＝陣列
function fmValue(lines, key) {
  if (!lines) return undefined;
  const re = new RegExp('^' + key + '\\s*:(.*)$');
  const i = lines.findIndex((l) => re.test(l));
  if (i < 0) return undefined;
  const rest = lines[i].match(re)[1].trim();
  if (rest.startsWith('[')) return splitTopLevel(rest.replace(/^\[/, '').replace(/\]\s*$/, ''));
  if (rest !== '') return unquote(rest);
  const items = [];
  for (let k = i + 1; k < lines.length; k++) {
    const m = lines[k].match(/^\s*-\s+(.*)$/);
    if (m) { items.push(unquote(m[1])); continue; }
    if (lines[k].trim() === '') continue;
    break;
  }
  return items;
}
// paths 一律回傳陣列（純量字串照逗號切；沒有 paths 或空值＝空陣列）
function parsePaths(text) {
  const v = fmValue(frontmatter(text), 'paths');
  if (v === undefined) return [];
  return Array.isArray(v) ? v.filter((x) => String(x).trim() !== '') : splitTopLevel(v);
}

// ── glob ────────────────────────────────────────────────────────────────────
// 大括號展開：`src/{a,b}.ts` → `src/a.ts`、`src/b.ts`；沒有逗號的 `{a}` 照字面
function expandBraces(p, budget = { n: 0 }) {
  let depth = 0; let start = -1;
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '\\') { i++; continue; }
    if (c === '{') { if (depth === 0) start = i; depth++; }
    else if (c === '}' && depth > 0) {
      depth--;
      if (depth === 0) {
        const parts = splitTopLevelRaw(p.slice(start + 1, i));
        if (parts.length > 1) {
          const pre = p.slice(0, start); const post = p.slice(i + 1);
          const out = [];
          for (const x of parts) {
            for (const y of expandBraces(pre + x + post, budget)) { if (++budget.n > MAX_BRACE_EXPANSION) return out; out.push(y); }
          }
          return out;
        }
      }
    }
  }
  return [p];
}
function splitTopLevelRaw(s) {
  const out = []; let depth = 0; let cur = '';
  for (const c of s) {
    if (c === '{') depth++;
    else if (c === '}' && depth > 0) depth--;
    if (c === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out;
}
const escRe = (c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// 一個路徑段（不含 /）轉成正則：* 不跨 /、? 一個字元、[...] 字元集、\x 照字面
function segRe(seg) {
  let re = '';
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (c === '\\') { if (i + 1 < seg.length) re += escRe(seg[++i]); continue; }
    if (c === '*') { re += '[^/]*'; continue; }
    if (c === '?') { re += '[^/]'; continue; }
    if (c === '[') {
      const close = seg.indexOf(']', i + 2);
      if (close > i) {
        let body = seg.slice(i + 1, close);
        if (body[0] === '!') body = '^' + body.slice(1);
        re += '[' + body.replace(/\\/g, '\\\\').replace(/\//g, '') + ']';
        i = close; continue;
      }
    }
    re += escRe(c);
  }
  return re;
}
// 一條（已展開大括號的）樣式 → { re, dirOnly }；不會命中任何檔的寫法回傳 null
function compile(pat) {
  let p = String(pat).trim();
  if (!p || p.startsWith('#') || p.startsWith('!')) return null;
  let dirOnly = false;
  if (p.endsWith('/')) { dirOnly = true; p = p.replace(/\/+$/, ''); }
  if (!p) return null;
  // 錨定看的是去掉結尾 / 之後還有沒有斜線：結尾 / 只表示「目錄」，不算錨定（同 gitignore；2.1.296 實測 deep/ 命中 src/deep/d.ts）
  const anchored = p.includes('/');
  if (p.startsWith('/')) p = p.slice(1);
  const parts = p.split('/');
  if (parts.length === 1 && parts[0] === '**') return { re: /^.*$/i, dirOnly };
  let re = '';
  for (let i = 0; i < parts.length; i++) {
    const s = parts[i];
    const last = i === parts.length - 1;
    if (s === '**') {
      if (i === 0) re += '(?:[^/]+/)*';
      else if (last) re += '/.+';
      else re += '(?:/[^/]+)*';
      continue;
    }
    const lead = re === '' || (i === 1 && parts[0] === '**') ? '' : '/';
    re += lead + segRe(s);
  }
  return { re: new RegExp('^' + (anchored ? '' : '(?:[^/]+/)*') + re + '$', 'i'), dirOnly };
}
const compiled = new Map();
function compileAll(pattern) {
  if (!compiled.has(pattern)) compiled.set(pattern, expandBraces(String(pattern).trim()).map(compile).filter(Boolean));
  return compiled.get(pattern);
}
/**
 * 樣式是否命中專案內的相對路徑（`/` 分隔）。語意照 Claude Code 2.1.296 實測（rules 與 skill 的 paths 相同）：
 *   gitignore 寫法、不分大小寫、先展開大括號。沒有斜線的樣式（`*.ts`）任何深度都算；有斜線的（`src/*.ts`、`/src/a.ts`）
 *   錨在專案根；結尾 `/` 只比目錄；樣式命中某個上層目錄時底下所有檔都算（`src/*` 命中 `src/deep/d.ts`）；
 *   `**` 跨層；`./` 開頭與 `!` 開頭的樣式不命中任何檔。
 */
function matchPath(pattern, rel) {
  const r = String(rel).replace(/\\/g, '/').replace(/^\.\/+/, '');
  const segs = r.split('/');
  const ancestors = [];
  for (let i = 1; i < segs.length; i++) ancestors.push(segs.slice(0, i).join('/'));
  for (const { re, dirOnly } of compileAll(pattern)) {
    const cands = dirOnly ? ancestors : [r, ...ancestors];
    if (cands.some((c) => re.test(c))) return true;
  }
  return false;
}
// 寫法本身的問題（不看命中）：回傳問題說明，沒問題回傳空字串
function validatePattern(p) {
  const s = String(p);
  if (!s.trim()) return '空字串';
  if (/^\s|\s$/.test(s)) return '前後有空白';
  if (s.startsWith('!')) return '不支援 ! 否定（Claude Code 不會因此載入任何檔）';
  if (/^\.\.?\//.test(s)) return '以 ./ 或 ../ 開頭（Claude Code 不認，永遠不命中）；改寫成從專案根起算的路徑';
  if (/^[A-Za-z]:/.test(s) || s.startsWith('//')) return '是絕對路徑；paths 要寫相對專案根的路徑';
  if (s.includes('\\')) return '含反斜線；路徑分隔一律用 /';
  let depth = 0; let bad = false;
  for (const c of s) { if (c === '{') depth++; else if (c === '}') { depth--; if (depth < 0) bad = true; } }
  if (bad || depth !== 0) return '大括號沒有成對';
  if ((s.match(/\[/g) || []).length !== (s.match(/\]/g) || []).length) return '中括號沒有成對';
  if (/\{[^}]*,\s[^}]*\}/.test(s)) return '大括號裡逗號後有空白（展開後那一項會帶前導空白）';
  return '';
}

// ── skill 清單 ──────────────────────────────────────────────────────────────
// 回傳 [{ dir, name, paths, file }]；讀不到的 skill 略過
function readSkills(root) {
  const base = path.join(root, '.claude', 'skills');
  let dirs = [];
  try { dirs = fs.readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return []; }
  const out = [];
  for (const dir of dirs) {
    const file = path.join(base, dir, 'SKILL.md');
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const fm = frontmatter(text);
    const name = fm ? fmValue(fm, 'name') : undefined;
    out.push({ dir, name: typeof name === 'string' && name ? name : dir, paths: parsePaths(text), file });
  }
  return out;
}
// 專案內的檔（相對路徑，`/` 分隔）；略過 .git 與套件、建置產物目錄。init-verify 拿來算每條 glob 命中幾個檔
const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.harness-backup']);
function walkFiles(root, limit = 200000) {
  const out = [];
  const stack = [''];
  while (stack.length && out.length < limit) {
    const relDir = stack.pop();
    let ents = [];
    try { ents = fs.readdirSync(path.join(root, relDir), { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const rel = relDir ? relDir + '/' + e.name : e.name;
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) stack.push(rel); }
      else if (e.isFile()) out.push(rel);
      if (out.length >= limit) break;
    }
  }
  return out;
}
// 要新建的檔還不存在時，找一個可以先 Read 的相符既有檔（只看前 20000 個檔，找不到就不指名）
function findExisting(root, skills) {
  for (const f of walkFiles(root, 20000)) if (skills.some((s) => s.paths.some((p) => matchPath(p, f)))) return f;
  return '';
}
function requiredSkillsFor(root, rel) {
  return readSkills(root).filter((s) => s.paths.length && s.paths.some((p) => matchPath(p, rel)));
}

// ── transcript ──────────────────────────────────────────────────────────────
// 回傳這份 transcript 裡已載入的 skill 名稱集合
function loadedSkills(text) {
  const names = new Set();
  const skillUses = new Map();   // tool_use id → skill 名
  const okResults = new Set();
  const errResults = new Set();
  const add = (n) => { const t = String(n || '').trim(); if (!t) return; names.add(t); if (t.includes(':')) names.add(t.split(':').pop()); };
  for (const line of String(text).split('\n')) {
    if (!line.includes(BASE_DIR_PREFIX) && !line.includes('"Skill"') && !line.includes('tool_result')) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const msg = o && o.message;
    if (!msg) continue;
    const content = msg.content;
    if (o.type === 'user' && o.isMeta === true) {
      const texts = typeof content === 'string' ? [content]
        : Array.isArray(content) ? content.filter((b) => b && b.type === 'text').map((b) => String(b.text || '')) : [];
      for (const t of texts) {
        if (!t.startsWith(BASE_DIR_PREFIX)) continue;
        const dir = t.slice(BASE_DIR_PREFIX.length).split('\n')[0].trim().replace(/[\\/]+$/, '');
        add(dir.split(/[\\/]/).pop());
      }
    }
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (!b) continue;
      if (o.type === 'assistant' && b.type === 'tool_use' && b.name === 'Skill' && b.input && b.input.skill) skillUses.set(b.id, b.input.skill);
      if (b.type === 'tool_result' && b.tool_use_id) (b.is_error ? errResults : okResults).add(b.tool_use_id);
    }
  }
  for (const [id, n] of skillUses) if (okResults.has(id) && !errResults.has(id)) add(n);
  return names;
}
function isLoaded(skill, names) {
  return names.has(skill.dir) || names.has(skill.name);
}

// ── 專案根 ──────────────────────────────────────────────────────────────────
// 本檔在 <專案根>/.claude/hooks/ 時往上兩層優先；其次 CLAUDE_PROJECT_DIR（不保證有設）、payload 的 cwd。
// 取第一個有 `.claude/skills/` 的。
function projectRoot(input) {
  const cands = [];
  if (path.basename(__dirname) === 'hooks' && path.basename(path.dirname(__dirname)) === '.claude') cands.push(path.resolve(__dirname, '..', '..'));
  if (process.env.CLAUDE_PROJECT_DIR) cands.push(process.env.CLAUDE_PROJECT_DIR);
  if (input && input.cwd) cands.push(input.cwd);
  return cands.find((d) => { try { return fs.statSync(path.join(d, '.claude', 'skills')).isDirectory(); } catch { return false; } }) || null;
}

// fail-open 但 loud（harness 05 §6.4；2026-10-18 紅藍對抗 R2 R1-6）：stdin 壞或判讀丟例外時放行，但 stderr 與
// additionalContext 都要說（舊版壞 JSON 靜默放行、例外只有 stderr）。空 stdin＝手動執行不是故障，照舊安靜放行。
function failOpen(e) {
  const msg = '[guard-required-skill] hook 內部錯誤，本次放行：' + String((e && e.message) || e).split('\n')[0];
  try { process.stderr.write(msg + '\n'); } catch (_) { /* 連 stderr 都寫不了就只剩放行 */ }
  try {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse',
      additionalContext: msg + '。這次沒有檢查改檔前必要 skill 有沒有載入，請自行對照各 skill frontmatter 的 paths；hook 要修：.claude/hooks/guard-required-skill.js' } }));
  } catch (_) { /* 同上 */ }
}

function main() {
  const raw = fs.readFileSync(0, 'utf8');
  if (!raw.trim()) return;
  let input;
  try { input = JSON.parse(raw); } catch (e) { return failOpen(e); }
  if (!input || typeof input !== 'object') return;
  if (!TOOLS.has(input.tool_name)) return;
  const ti = input.tool_input || {};
  const fp = ti.file_path || ti.notebook_path || ti.path;
  if (!fp) return;
  const root = projectRoot(input);
  if (!root) return;
  const abs = path.resolve(input.cwd || root, String(fp));
  const relRaw = path.relative(root, abs);
  // 專案外＝'..' 本身、以 '..' 加分隔符開頭、或跨磁碟時回的絕對路徑；只比 '..' 開頭會把專案內的 ..cache/ 當成專案外放掉
  if (!relRaw || relRaw === '..' || relRaw.startsWith('..' + path.sep) || relRaw.startsWith('../') || path.isAbsolute(relRaw)) return;
  const rel = relRaw.split(path.sep).join('/');

  const required = requiredSkillsFor(root, rel);
  if (!required.length) return;

  const tp = input.transcript_path;
  if (!tp) return;
  const agentId = input.agent_id ? String(input.agent_id) : '';
  let file = tp;
  if (agentId) {
    if (!/^[A-Za-z0-9_-]+$/.test(agentId) || !/^[A-Za-z0-9_-]+$/.test(String(input.session_id || ''))) return;
    file = path.join(path.dirname(tp), String(input.session_id), 'subagents', `agent-${agentId}.jsonl`);
  }
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
  const names = loadedSkills(text);
  const missing = required.filter((s) => !isLoaded(s, names));
  if (!missing.length) return;

  // 帶 paths 的 skill 要等這個 session 讀過一個相符的檔才會出現在可用清單，在那之前 Skill 工具回「Unknown skill」
  // （2.1.296 實測；被本 hook 擋下的 Edit 不算讀過）。所以先指一個可以 Read 的相符檔。
  const readable = fs.existsSync(abs) ? rel : findExisting(root, missing);
  const lines = [
    `[必讀 skill] 要改的檔：${rel}`,
    '這個檔落在下列 skill 宣告的 paths 裡，改之前要先載入它們：',
    ...missing.map((s) => `- ${s.name}（paths：${s.paths.join('、')}；${path.relative(root, s.file).split(path.sep).join('/')}）`),
    `用 Skill 工具載入 ${missing.map((s) => '`' + s.name + '`').join('、')}，讀完照它的規範再改。` +
      `Skill 工具回「Unknown skill」時，先用 Read 讀一次${readable ? ` \`${readable}\`` : '任一個符合上面 paths 的檔'}（帶 paths 的 skill 要讀過相符的檔才會出現在可用清單），再載入。`,
  ];
  if (agentId) {
    const type = input.agent_type ? String(input.agent_type) : '';
    lines.push(`你在 subagent${type ? `（${type}）` : ''}裡：主對話載入過的 skill 不會帶進 subagent，照上面的步驟在這裡自己載入。` +
      `（給維護者：寫進 ${type ? `\`.claude/agents/${type}.md\`` : '該 agent 定義檔'} frontmatter 的 \`skills:\` 可以在啟動時預載，但帶 paths 的 skill 只有在這個 session 已經讀過相符的檔時才會被預載。）`);
  }
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: lines.join('\n') } }));
}

module.exports = { frontmatter, fmValue, parsePaths, splitTopLevel, expandBraces, matchPath, validatePattern, readSkills, requiredSkillsFor, walkFiles, loadedSkills, isLoaded, projectRoot };

if (require.main === module) {
  try { main(); } catch (e) { failOpen(e); }
  process.exit(0);
}
