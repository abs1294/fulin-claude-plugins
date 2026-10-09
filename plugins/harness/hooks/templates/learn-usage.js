#!/usr/bin/env node
// PreToolUse（matcher "Read|Skill"）／Stop：學習迴路的用量計數（淘汰候選的依據）。
//
// 【範本】由 /harness:init 複製到目標專案 `.claude/hooks/`，之後歸該專案自治（可自改；plugin 更新不會自動同步）。
// 接線（目標專案 .claude/settings.json）：
//   "PreToolUse": [{ "matcher": "Read|Skill", "hooks": [{ "type": "command",
//     "command": "node \"<專案絕對路徑>/.claude/hooks/learn-usage.js\"", "timeout": 10, "statusMessage": "學習迴路：記一次知識檔讀取" }] }],
//   "Stop": [{ "hooks": [{ "type": "command",
//     "command": "node \"<專案絕對路徑>/.claude/hooks/learn-usage.js\"", "timeout": 10, "statusMessage": "學習迴路：記一次對話回合" }] }]
//
// 做什麼（計數存 `.claude/harness/learning/usage.json`，經 learn-lib 的鎖讀改寫）：
//   Read 的 file_path 落在 memory 目錄（.md，MEMORY.md 除外）、三份知識筆記、`.claude/harness/*.md`、`.claude/skills/<名>/` 底下 → 該項 view +1
//   Skill 的 skill 名稱對到 `.claude/skills/<名稱>/` → use +1（plugin skill，名稱帶 `:` 或專案裡沒有那個資料夾，不計）
//   Stop → requests +1（health-check-reminder 的 request 門檻與淘汰試用期都用它）
// memory 目錄執行時由專案根推算（learn-lib.memoryDir；測試可用 HARNESS_MEMORY_DIR 覆寫）。
//
// 遞迴防護：HARNESS_LEARN_CHILD 或 COMPACT_HANDOFF_CHILD 存在時直接 exit 0，不計、不印。
// 測試用：HARNESS_LEARN_DEBUG=1 時每次計數在 stderr 印一行（只供 cases 驗「真的計了」；正常執行不設）。
// fail-open：任何例外 exit 0，stderr 印 `[learn-usage] ERROR: …`；取不到鎖就本次不計（不擋工具）。
//
// 自行決定的細節：
// - 路徑比對在 Windows 上不分大小寫；相對路徑以 payload 的 cwd 解析。
// - 讀 MEMORY.md 本身不計（它是索引，每個 session 都會自動載入）。

'use strict';
const fs = require('fs');
const path = require('path');

// ── init 填空區 ──────────────────────────────────────────────────────────────
// 要計 view 的 harness 文件目錄（相對於專案根；只計這一層的 .md）。
const HARNESS_DOC_DIR = '.claude/harness';
// 專案 skill 目錄（相對於專案根）。
const SKILLS_DIR = '.claude/skills';
// ────────────────────────────────────────────────────────────────────────────

function log(msg) { process.stderr.write('[learn-usage] ' + msg + '\n'); }

try {
  if (process.env.HARNESS_LEARN_CHILD || process.env.COMPACT_HANDOFF_CHILD) process.exit(0);
  let raw = '';
  try { raw = fs.readFileSync(0, 'utf8'); } catch { process.exit(0); }
  const input = JSON.parse(raw || '{}');
  const event = String(input.hook_event_name || '');
  const lib = require('./learn-lib.js');
  const root = lib.rootOf(__dirname);
  const P = lib.paths(root);
  const debug = !!process.env.HARNESS_LEARN_DEBUG;

  const bump = (mut) => {
    try { return lib.bumpUsage(root, mut); } catch (e) { if (e && e.code === 'ELOCKED') return null; throw e; }
  };

  if (event === 'Stop') {
    const n = bump((u) => { u.requests = (u.requests || 0) + 1; return u.requests; });
    if (debug && n !== null) log('requests ' + n);
    process.exit(0);
  }
  if (event !== 'PreToolUse') process.exit(0);
  const tool = String(input.tool_name || '');
  const ti = input.tool_input || {};
  let key = null, kind = null, field = null;

  if (tool === 'Read') {
    const raw = String(ti.file_path || ti.path || '');
    if (!raw) process.exit(0);
    const abs = path.resolve(input.cwd || process.cwd(), raw);
    const n = lib.normPath(abs);
    const base = path.basename(abs);
    const skillsRoot = path.join(root, SKILLS_DIR);
    if (/\.md$/i.test(base) && base.toLowerCase() !== 'memory.md' && lib.normPath(path.dirname(abs)) === lib.normPath(P.memoryDir)) {
      key = 'memory:' + base; kind = 'memory';
    } else if (lib.isInside(abs, skillsRoot) && lib.normPath(abs) !== lib.normPath(skillsRoot)) {
      const name = path.relative(skillsRoot, abs).split(/[\\/]/)[0];
      key = 'skill:' + name; kind = 'skill';
    } else if (/\.md$/i.test(base) && lib.normPath(path.dirname(abs)) === lib.normPath(path.join(root, HARNESS_DOC_DIR))) {
      key = 'harness:' + base; kind = 'harness';
    } else {
      for (const k of ['glossary', 'flows', 'qa-knowledge']) {
        const rel = lib.knowledgeRel(P, k);
        if (n === lib.normPath(path.join(root, rel))) { key = 'knowledge:' + rel; kind = 'knowledge'; break; }
      }
    }
    field = 'view';
  } else if (tool === 'Skill') {
    const name = String(ti.skill || ti.command || '').trim();
    if (!name || name.includes(':') || /[\\/]/.test(name)) process.exit(0);
    try { if (!fs.statSync(path.join(root, SKILLS_DIR, name)).isDirectory()) process.exit(0); } catch { process.exit(0); }
    key = 'skill:' + name; kind = 'skill'; field = 'use';
  }
  if (!key) process.exit(0);
  const it = bump((u) => { const x = lib.touchItem(u, key, kind, field); return x[field]; });
  if (debug && it !== null) log(field + ' ' + key + ' = ' + it);
  process.exit(0);
} catch (e) {
  log('ERROR: ' + ((e && e.message) || e) + '（放行；學習迴路 hook 鏽蝕要修）');
  process.exit(0);
}
