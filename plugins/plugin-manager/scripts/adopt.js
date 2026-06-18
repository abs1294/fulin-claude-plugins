#!/usr/bin/env node
/**
 * adopt.js — 把當前專案的一個自製 skill 納管進 monorepo。
 *
 * 模型：Move + symlink（真身只有一份）
 *   1. 把 <project>/.claude/skills/<skill> 真身 MOVE 進 monorepo/plugins/<pluginName>/skills/<skill>
 *   2. 為新 plugin 建 .claude-plugin/plugin.json（version 0.1.0）
 *   3. 在 monorepo marketplace.json 的 plugins[] 加一筆
 *   4. 原專案位置改成 symlink 指回 monorepo 那份（在專案仍可見、可用）
 *   5. 更新 ~/.claude/plugin-manager/registry.json 的 selfMade
 *   6. 若專案是 git repo，提示把該 symlink 加進 .gitignore（避免污染專案 repo）
 *
 * 用法：node adopt.js <skillName> <pluginName> [projectDir]
 *   skillName   : 專案 .claude/skills/ 底下的 skill 目錄名
 *   pluginName  : 在 monorepo 裡的 plugin 名（預設同 skillName）
 *   projectDir  : 專案根目錄（預設 cwd）
 *
 * 設計：所有狀態從 ~/.claude/plugin-manager/config.json 讀（monorepo 路徑、owner）。
 *       純檔案 + git 操作，不呼叫 claude CLI（research 風險 A 對策）。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

function die(msg) { console.error('ERROR: ' + msg); process.exit(1); }

const PM_DIR = path.join(os.homedir(), '.claude', 'plugin-manager');
const configPath = path.join(PM_DIR, 'config.json');
const registryPath = path.join(PM_DIR, 'registry.json');

if (!fs.existsSync(configPath)) die('找不到 config.json，請先初始化 plugin-manager（~/.claude/plugin-manager/config.json）。');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const registry = fs.existsSync(registryPath)
  ? JSON.parse(fs.readFileSync(registryPath, 'utf8'))
  : { schemaVersion: 1, selfMade: {}, externalCandidates: {} };

const skillName = process.argv[2];
const pluginName = process.argv[3] || skillName;
const projectDir = process.argv[4] || process.cwd();

if (!skillName) die('用法：node adopt.js <skillName> <pluginName> [projectDir]');

const mono = config.monorepo;
if (!mono || !fs.existsSync(mono)) die('config.monorepo 無效：' + mono);

// 來源：專案的 skill 真身
const srcSkill = path.join(projectDir, '.claude', 'skills', skillName);
if (!fs.existsSync(srcSkill)) die('找不到專案 skill：' + srcSkill);
const stat = fs.lstatSync(srcSkill);
if (stat.isSymbolicLink()) die(srcSkill + ' 已經是 symlink（可能已被納管），中止以免重複。');

// 目標：monorepo plugin
const pluginDir = path.join(mono, 'plugins', pluginName);
if (fs.existsSync(pluginDir)) die('monorepo 已有同名 plugin：' + pluginDir + '（請換 pluginName）');

const destSkill = path.join(pluginDir, 'skills', skillName);

console.log('== adopt 計畫 ==');
console.log('  skill 真身 : ' + srcSkill);
console.log('  搬進       : ' + destSkill);
console.log('  原位改為   : symlink → ' + destSkill);
console.log('  plugin 名  : ' + pluginName + ' (version 0.1.0)');

// 1. 建 plugin 目錄 + move 真身
fs.mkdirSync(path.join(pluginDir, 'skills'), { recursive: true });
fs.renameSync(srcSkill, destSkill);
console.log('✓ 已 move skill 真身進 monorepo');

// 2. 建 plugin.json
const pluginJson = {
  name: pluginName,
  version: '0.1.0',
  description: '（adopt 自動建立，請用 /plugin-manager:update 補描述）skill ' + skillName,
  author: { name: config.owner || 'unknown' },
  keywords: [skillName]
};
fs.mkdirSync(path.join(pluginDir, '.claude-plugin'), { recursive: true });
fs.writeFileSync(path.join(pluginDir, '.claude-plugin', 'plugin.json'), JSON.stringify(pluginJson, null, 2) + '\n');
console.log('✓ 已建 plugin.json');

// 3. 更新 marketplace.json
const mpPath = path.join(mono, '.claude-plugin', 'marketplace.json');
const mp = JSON.parse(fs.readFileSync(mpPath, 'utf8'));
if (!mp.plugins.some(p => p.name === pluginName)) {
  mp.plugins.push({
    name: pluginName,
    source: './plugins/' + pluginName,
    description: pluginJson.description
  });
  fs.writeFileSync(mpPath, JSON.stringify(mp, null, 2) + '\n');
  console.log('✓ 已加入 marketplace.json');
}

// 4. 原位置改 symlink（Windows: 用 junction 對目錄較穩；先試 symlink，失敗 fallback）
try {
  fs.symlinkSync(destSkill, srcSkill, 'junction');
  console.log('✓ 已建 symlink（junction）回原專案');
} catch (e) {
  try {
    fs.symlinkSync(destSkill, srcSkill, 'dir');
    console.log('✓ 已建 symlink（dir）回原專案');
  } catch (e2) {
    console.error('⚠ symlink 建立失敗：' + e2.message + '\n  真身已在 monorepo，但原專案位置未連結。請手動處理。');
  }
}

// 5. 更新 registry
registry.selfMade = registry.selfMade || {};
registry.selfMade[pluginName] = {
  version: '0.1.0',
  path: 'plugins/' + pluginName,
  source: 'adopted',
  adoptedFrom: projectDir,
  dirty: true
};
fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2) + '\n');
console.log('✓ 已更新 registry');

// 6. 專案是 git repo → 提示 gitignore
const projGit = path.join(projectDir, '.git');
if (fs.existsSync(projGit)) {
  console.log('\n⚠ 此專案是 git repo。建議把該 symlink 排除，避免污染專案版控：');
  console.log('  在 ' + path.join(projectDir, '.gitignore') + ' 加入一行：');
  console.log('    .claude/skills/' + skillName);
}

console.log('\n✅ adopt 完成。下一步：/plugin-manager:publish 把整個 monorepo 推上 git。');
