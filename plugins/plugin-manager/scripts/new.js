#!/usr/bin/env node
/**
 * new.js — 在 monorepo 從零建立一個全新的自製 plugin 骨架。
 *
 * 與 adopt.js 相對：adopt 是「搬既有 skill 進來」，new 是「從零建空骨架」。
 * 不靠 `claude plugin init`，因為要直接長進 monorepo 的 plugins/ 結構。
 *
 * 做法（純檔案操作，不呼叫 claude CLI）：
 *   1. 檢查 monorepo/plugins/<name>/ 不存在（存在則要求改名）。
 *   2. 建 .claude-plugin/plugin.json（version 0.1.0, author=config.owner）。
 *   3. 依 --with 建元件骨架：
 *        skills   → skills/<name>/SKILL.md（含 frontmatter 範本）
 *        hooks    → hooks/hooks.json（空骨架）
 *        commands → commands/<name>.md（範本）
 *      預設（未給 --with）只建 skills。
 *   4. 更新 monorepo marketplace.json 的 plugins[]（加 name/source/description）。
 *   5. 更新 ~/.claude/plugin-manager/registry.json 的 selfMade（version 0.1.0, native, dirty:true）。
 *
 * 用法：node new.js <name> <description> [--with skills,hooks,commands]
 *   name        : 新 plugin 名（= monorepo plugins/<name>）
 *   description : 一句描述（會進 plugin.json 與 marketplace）
 *   --with      : 逗號分隔的元件清單，預設 skills
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

function die(msg) { console.error('ERROR: ' + msg); process.exit(1); }

const PM_DIR = path.join(os.homedir(), '.claude', 'plugin-manager');
const configPath = path.join(PM_DIR, 'config.json');
const registryPath = path.join(PM_DIR, 'registry.json');

if (!fs.existsSync(configPath)) die('找不到 config.json（~/.claude/plugin-manager/config.json）。');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const registry = fs.existsSync(registryPath)
  ? JSON.parse(fs.readFileSync(registryPath, 'utf8'))
  : { schemaVersion: 1, selfMade: {}, externalCandidates: {} };

// --- 解析參數（把 --with x,y 抽出，其餘為位置參數）---
const argv = process.argv.slice(2);
let withRaw = null;
const pos = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--with') { withRaw = argv[++i]; }
  else if (argv[i].startsWith('--with=')) { withRaw = argv[i].slice('--with='.length); }
  else pos.push(argv[i]);
}
const name = pos[0];
const description = pos[1];

if (!name || !description) die('用法：node new.js <name> <description> [--with skills,hooks,commands]');

const VALID = ['skills', 'hooks', 'commands'];
let components = (withRaw ? withRaw.split(',') : ['skills'])
  .map(s => s.trim()).filter(Boolean);
const bad = components.filter(c => !VALID.includes(c));
if (bad.length) die('--with 含未知元件：' + bad.join(', ') + '（可用：' + VALID.join(', ') + '）');
if (!components.length) components = ['skills'];

const mono = config.monorepo;
if (!mono || !fs.existsSync(mono)) die('config.monorepo 無效：' + mono);

const pluginDir = path.join(mono, 'plugins', name);
if (fs.existsSync(pluginDir)) die('monorepo 已有同名 plugin：' + pluginDir + '（請換名）');

const owner = config.owner || 'unknown';

console.log('== plugin-new 計畫 ==');
console.log('  plugin 名 : ' + name + ' (version 0.1.0)');
console.log('  描述      : ' + description);
console.log('  元件      : ' + components.join(', '));
console.log('  位置      : ' + pluginDir);

// 1. plugin.json
const pluginJson = {
  name: name,
  version: '0.1.0',
  description: description,
  author: { name: owner },
  keywords: [name]
};
fs.mkdirSync(path.join(pluginDir, '.claude-plugin'), { recursive: true });
fs.writeFileSync(path.join(pluginDir, '.claude-plugin', 'plugin.json'), JSON.stringify(pluginJson, null, 2) + '\n');
console.log('✓ 已建 .claude-plugin/plugin.json');

// 2. 元件骨架
if (components.includes('skills')) {
  const skillDir = path.join(pluginDir, 'skills', name);
  fs.mkdirSync(skillDir, { recursive: true });
  const skillMd = [
    '---',
    'name: ' + name,
    'description: ' + description + ' 當使用者說 /' + name + '、「（在此補中文觸發詞）」時觸發。',
    '---',
    '',
    '# ' + name,
    '',
    description,
    '',
    '## 何時用',
    '- （補使用情境）',
    '',
    '## 執行步驟',
    '1. （補步驟）',
    '',
    '## 重要限制（誠實告知）',
    '- （補限制，例如 Windows 權限、不能代執行互動指令等）',
    ''
  ].join('\n');
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), skillMd);
  console.log('✓ 已建 skills/' + name + '/SKILL.md');
}

if (components.includes('hooks')) {
  const hooksDir = path.join(pluginDir, 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  const hooksJson = { hooks: {} };
  fs.writeFileSync(path.join(hooksDir, 'hooks.json'), JSON.stringify(hooksJson, null, 2) + '\n');
  console.log('✓ 已建 hooks/hooks.json（空骨架，hook 指令用 ${CLAUDE_PLUGIN_ROOT} 引用）');
}

if (components.includes('commands')) {
  const cmdDir = path.join(pluginDir, 'commands');
  fs.mkdirSync(cmdDir, { recursive: true });
  const cmdMd = [
    '---',
    'description: ' + description,
    '---',
    '',
    '# /' + name,
    '',
    '（補 command 內容）',
    ''
  ].join('\n');
  fs.writeFileSync(path.join(cmdDir, name + '.md'), cmdMd);
  console.log('✓ 已建 commands/' + name + '.md');
}

// 3. 更新 marketplace.json
const mpPath = path.join(mono, '.claude-plugin', 'marketplace.json');
const mp = JSON.parse(fs.readFileSync(mpPath, 'utf8'));
if (!mp.plugins.some(p => p.name === name)) {
  mp.plugins.push({
    name: name,
    source: './plugins/' + name,
    description: description
  });
  fs.writeFileSync(mpPath, JSON.stringify(mp, null, 2) + '\n');
  console.log('✓ 已加入 marketplace.json');
}

// 4. 更新 registry
registry.selfMade = registry.selfMade || {};
registry.selfMade[name] = {
  version: '0.1.0',
  path: 'plugins/' + name,
  source: 'native',
  dirty: true
};
fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2) + '\n');
console.log('✓ 已更新 registry');

console.log('\n✅ plugin-new 完成。下一步：');
console.log('  - 補上 skill/hook/command 內容。');
console.log('  - /plugin-manager:publish 把 monorepo 推上 git。');
console.log('  - 要啟用需 /plugin install ' + name + '@fulin-plugins（互動指令，使用者自貼）。');
